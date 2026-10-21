/**
 * ArmUnit.js — Autonomous arm unit (V5 Crossbow ADR satellite)
 * Supports both Weaver (large, 6.6kg V5, reel on mothership)
 * and Spinner (small, 2.1kg V5, reel on mothership) types.
 * V5 State machine: DOCKED → LAUNCHING → TRANSIT → APPROACH →
 *   NETTING → GRAPPLED → REELING → DOCKING → RELOADING →
 *   TRAWLING → ABLATING → SCANNING → EXPENDED
 * Legacy states (UNDOCKING, HAULING, RETURNING) preserved for backward compat.
 * @module entities/ArmUnit
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { TimeAuthority } from '../systems/TimeAuthority.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { getSolarCellTexture } from '../scene/solarCellTexture.js';
import { makeLightHalo, getRadialGlowTexture } from '../scene/glowSpriteTexture.js';
import { makePlumeFrustum } from '../scene/plumeGeometry.js';
import { computeDaughterPlumeIntensity, DAUGHTER_PLUME } from './armPlumeModel.js';
import { applyDetailLod } from '../scene/detailLodCull.js';
import { AVIONICS_GUNMETAL, AVIONICS_DARK_OPTIC, AVIONICS_THERMAL_WHITE } from '../scene/avionicsMaterials.js';
import { strutLocalDirection, composeDockedArmQuat, bestStrutAlpha, carryDirInto, carryFinalQuatInto, carryRotFrac } from './ArmDockBasis.js';
import { captureNetSystem, getNetClassForType, computeLeadAim, computeFragRisk, effectiveFragility, presentedWidthForApproach, fitsMouth, strainBandT, seedHerFrameAttitude, applyHerFrameAttitude, clearShipRelativeAttitude, clearRackCell } from './CaptureNet.js';
import { audioSystem } from '../systems/AudioSystem.js';
import { recommendArmTool } from '../systems/ToolRecommender.js';
import { DAUGHTER_OUT_OF_NETS_LINE } from '../systems/netRouting.js';
import { computeToolOdds, makeNetOddsLockCache } from '../systems/ToolOdds.js';
import { gameState } from '../core/GameState.js';
import { daughterDisplayName } from '../core/daughterNames.js';
import { DebrisField } from './DebrisField.js';          // catch-snug: the drawn scale of a held catch
import { DebrisWireframe } from '../ui/DebrisWireframe.js'; // catch-snug: the drawn mesh vertices
import { netCellLayout } from './netCellLayout.js';
import { heldBagNeckInto, heldBagRadiusScene, DAUGHTER_STAND_M } from './heldBagShape.js'; // net-cinch: where the held net's neck is drawn

/** 1 meter in scene units (1 scene unit = 100 km) — CAPTURE_NET.md §11.7 hoist
 * (2026-08-27): reads the one authoritative scale (Constants.SCENE_UNITS_PER_METER,
 * derivation there). Value unchanged (1e-5); positions byte-identical, pinned in
 * test-CaptureNet-Bookkeeping.js. */
const M = Constants.SCENE_UNITS_PER_METER;
/** Dock-socket ring outer radius, metres (bore Ø51.5 mm + 3 mm wall; v7-daughters D4). */
const SOCKET_RO = 0.02875;

/** World up axis (reused for the HOLDING_CATCH lateral-bias cross product). */
const _WORLD_UP = new THREE.Vector3(0, 1, 0);

// P3 (2026-07-20): hot-path temps — update()/state handlers allocated ~10-15
// Vector3+Matrix4+Quaternion per frame PER ARM. Module-level is safe: JS is
// single-threaded, ArmManager updates arms sequentially, and every temp is
// written and fully consumed within one method call (nothing crosses calls).
const _orientRadial = new THREE.Vector3();
const _orientEye    = new THREE.Vector3();
const _orientMat    = new THREE.Matrix4();
const _orientQuat   = new THREE.Quaternion();
const _tetherDir    = new THREE.Vector3();
const _driftTDelta  = new THREE.Vector3();

// Wave1: reusable plume-signal scratch (hot path — one _updatePlumes call per
// arm per frame). Written and fully consumed inside a single call, like the
// vector temps above.
const _plumeSig = {
  state: null, fuel: 0, skManeuverGlowS: 0, approachBrake01: 0,
  arrestFeepActive: false, reelHome: false, recoilFlashS: 0, carryNozzle: null,
};
const _thrTip = new THREE.Vector3();     // reel-gas: carry-leg thread nozzle pick (strut tip, her -Z) scratch
const _thrDir = new THREE.Vector3();
const _thrZ = new THREE.Vector3();
const _driftPDelta  = new THREE.Vector3();
const _driftRaw     = new THREE.Vector3();

/**
 * launch-smooth: the rest-to-rest strut move of `d` rad (≥ 0): speed up at `a`, coast at a peak `v`, slow down at `a`.
 * `vMax` caps the peak (the strut motor's 15°/s). With `durationS` > the shortest time the move takes the peak is
 * lowered so it lasts exactly that long (a coast at the lower peak); with 0 / less, the move is as short as it can be.
 * @returns {{v:number, T:number}} the peak rate (rad/s) and the total time (s)
 */
function strutEaseProfile(d, a, vMax, durationS) {
  if (!(d > 1e-9)) return { v: 0, T: 0 };
  const tri = Math.sqrt(d * a);                              // peak of a move with no coast
  const tMin = vMax >= tri ? 2 * Math.sqrt(d / a) : d / vMax + vMax / a;
  if (!(durationS > tMin)) return { v: Math.min(vMax, tri), T: tMin };
  const v = 0.5 * a * (durationS - Math.sqrt(Math.max(0, durationS * durationS - 4 * d / a)));   // v/a + d/v = durationS
  return { v, T: durationS };
}

/** Distance covered `t` seconds into a `strutEaseProfile` move (`e` = { d, a, v, T }). */
function strutEaseDistance(e, t) {
  if (t <= 0) return 0;
  if (t >= e.T) return e.d;
  const ta = e.v / e.a;
  if (t < ta) return 0.5 * e.a * t * t;
  if (t < e.T - ta) return 0.5 * e.a * ta * ta + e.v * (t - ta);
  const r = e.T - t;
  return e.d - 0.5 * e.a * r * r;
}
const _relVel       = new THREE.Vector3();
const _goalDir      = new THREE.Vector3();
const _posCmd       = new THREE.Vector3();
const _dockOffTmp   = new THREE.Vector3();

// Wave1 tension feedback — tether tint temps (same module-temp idiom as above:
// written and fully consumed within one call, never retained across calls).
const _tintScratch  = new THREE.Color();
const _tintTarget   = new THREE.Color();

// ──────────────────────────────────────────────────────────────────────────
const S = Constants.ARM_STATES;

// V5 Crossbow constants (destructured for readability)
const {
  CROSSBOW_DRAW_DISTANCE, CROSSBOW_SPRING_K_WEAVER, CROSSBOW_SPRING_K_SPINNER,
  CROSSBOW_RELEASE_TIME, CROSSBOW_UNDOCK_TIME, CROSSBOW_LAUNCH_SPEED_DEFAULT,
  CROSSBOW_LAUNCH_SPEED_MIN,
  CROSSBOW_RELOAD_POWER, CROSSBOW_WORM_GEAR_EFFICIENCY,
  REEL_IN_SPEED_EMPTY, REEL_IN_SPEED_LOADED,
  REEL_BRAKE_FORCE_MAX, REEL_TENSION_WARNING, REEL_TENSION_CRITICAL,
  ABLATION_LASER_POWER, ABLATION_RANGE_MAX, ABLATION_DURATION_MAX, ABLATION_DESPIN_RATE,
  PULSE_SCAN_DURATION, PULSE_SCAN_RANGE_MULT,
  V5_WEAVER_MASS, V5_SPINNER_MASS,
  SPRING_TIERS, TETHER_TIERS,
} = Constants;

/**
 * Wave1 tension feedback — pure tension-fraction → tether tint mapping.
 *
 * Drives the DAUGHTER tether line color from the live reel tension
 * (`tetherTension / tetherBreakStrength`, the scalar _updateReeling computes
 * for snap physics) — NOT from distance. HISTORY: the original always-on
 * driver colored by distance strain; in the orbital frame that scalar jitters
 * frame-to-frame and the line strobed red/white, so it was switched off and
 * the channel went dead (see _updateTether). The tension fraction is stable
 * within a reel and zero outside one.
 *
 * Thresholds are the canonical tension-fraction pair REEL_TENSION_WARNING /
 * REEL_TENSION_CRITICAL — the SAME constants the DockingReticle tension bar
 * and StatusPanel stress readout key off (and the exact 0.7 / 0.9 steps the
 * retired flag-gated path used), so bar, status text, and line color speak one
 * vocabulary. NET_STRAIN_* is deliberately NOT used here: that pair rates
 * payload mass vs NET rating (recoverable net rip), a different failure mode
 * from tether snap (Constants.js "Two distinct post-capture failure modes").
 *
 * Piecewise, continuous:
 *   f ≤ WARNING            → NOMINAL
 *   WARNING < f ≤ CRITICAL → lerp NOMINAL → STRESSED
 *   CRITICAL < f < 1.0     → lerp STRESSED → CRITICAL (pure red AT the snap point)
 *   f ≥ 1.0                → CRITICAL (clamped; snap fires at f > 1)
 *
 * @param {number} tensionFraction — tetherTension / tetherBreakStrength
 * @param {THREE.Color} [out] — target to write (allocates when omitted)
 * @returns {THREE.Color} out
 */
export function tetherTensionTint(tensionFraction, out = new THREE.Color()) {
  const warn = Constants.REEL_TENSION_WARNING ?? 0.7;
  const crit = Constants.REEL_TENSION_CRITICAL ?? 0.9;
  const f = Number.isFinite(tensionFraction) ? tensionFraction : 0;
  if (f <= warn) return out.setHex(Constants.TETHER_COLOR_NOMINAL);
  if (f <= crit) {
    out.setHex(Constants.TETHER_COLOR_NOMINAL);
    return out.lerp(_tintScratch.setHex(Constants.TETHER_COLOR_STRESSED),
      (f - warn) / Math.max(1e-6, crit - warn));
  }
  out.setHex(Constants.TETHER_COLOR_STRESSED);
  return out.lerp(_tintScratch.setHex(Constants.TETHER_COLOR_CRITICAL),
    Math.min(1, (f - crit) / Math.max(1e-6, 1 - crit)));
}

// S3.6: Shared bridle geometries (created once, reused across all arms)
let _sharedBridleGeo = null;
function _ensureSharedBridleGeo() {
  if (_sharedBridleGeo) return _sharedBridleGeo;
  _sharedBridleGeo = {
    gimbalW: new THREE.TorusGeometry(0.015 * M, 0.003 * M, 6, 16),  // Weaver gimbal ring (r 15 mm, 16 around, 3 mm tube, 6 sides) — 192 tris
    gimbalS: new THREE.TorusGeometry(0.010 * M, 0.002 * M, 6, 16),  // Spinner gimbal ring (r 10 mm, 16 around, 2 mm tube, 6 sides) — 192 tris
    hpSphere: new THREE.SphereGeometry(0.005 * M, 12, 6),          // Hardpoint bracket
  };
  return _sharedBridleGeo;
}

// ── rack-snug (2026-10-18): a rack cell is a place on HER ────────────────────
// Owner, play report 8a: "debris seems to float .5 meter away from end of daughter, should be reeled in
// firmly to end of daughter." catch-snug tightened the in-hand hold and left the rack to this lane. A
// parked catch is now a rigid part of her (docs/DECISIONS Ruling 0, physically real): its centre and its
// attitude are fixed in HER body frame (+Z out along the strut, Y in the strut's swing plane, X out of it)
// from the moment its cell is assigned, so the ship turning or the strut swinging carries it with her and
// world up plays no part.
// rack-centre (2026-10-18, owner 23:18Z after playing: "check details, debris is off center from daughter"):
// the rack-snug layout put cell k BESIDE her end (x = ±(reach + gap/2)), which measured 0.19-0.54 m off her
// axis for the mission-1 pieces (her end is 0.078 m in radius). Now cell 0 is CENTRED on her axis and cell 1
// stacks on the same axis beyond it:
//   cell 0:  x = y = 0,  z = s_her + s_catch0 + ARM_HOLD_NET_GAP_M   (the in-hand rule along her +Z: no part
//                                                 of the catch nearer than the net gap)
//   cell 1:  x = y = 0,  z = z_cell0 + far_cell0 + ARM_HOLD_NET_GAP_M + s_catch1   (its nearest drawn point
//                                                 one net gap past cell 0's catch's farthest drawn point)
// s_her = max z over her bodyDims box and every solid mesh vertex of hers; s_catch = max of -z over the
// catch's drawn vertices at the drawn scale in its frozen attitude; far_cell0 = max of +z over cell 0's
// catch's drawn vertices in ITS frozen attitude. Cell 1's place therefore depends on what cell 0 holds, so
// when cell 0 empties the remaining catch slides down to cell 0 over ARM_HOLD_GLIDE_S (`_pinHeldCatches`).
// ONE computation (`rackCellOffsetInto`) runs when a cell is assigned and stores `d._rackCell`,
// `d._rackLocalM`, `d._qLocalHer` (+ `d._rackArm`, the owner, and `d._rackBelow`, the cell-0 catch cell 1 was
// stacked on); every reader — the pin, the cargo flight's end, the keep-out sphere, the CoM booking — goes
// through `heldSlotAnchorInto`: her position + her attitude · the stored offset.
const _rcQ = new THREE.Quaternion();
const _rcDir = new THREE.Vector3();
const _rcZ = new THREE.Vector3(0, 0, -1);      // the catch's near side (toward her / toward the cell below)
const _rcZp = new THREE.Vector3(0, 0, 1);      // the catch's far side (away from her)

/**
 * Where a rack cell is, frame-free: `anchor + herQuat · offset`. `anchor` (her centre) and `out` are scene
 * units in the frame `herQuat` maps into; `offsetM` is her-frame metres.
 * @param {THREE.Vector3} anchor
 * @param {THREE.Quaternion} herQuat her attitude in the anchor's frame
 * @param {THREE.Vector3} offsetM the cell's centre in her frame, metres
 * @param {THREE.Vector3} out
 * @returns {THREE.Vector3} out
 */
export function heldSlotAnchorInto(anchor, herQuat, offsetM, out) {
  return out.copy(offsetM).multiplyScalar(M).applyQuaternion(herQuat).add(anchor);
}

/**
 * The cell the next arrival takes: the smallest free one. A piece without a `_rackCell` (an old save, a rig that
 * pushed straight onto `heldCatches`) holds the cell of its array position.
 * @param {Array<object>|null} rack
 * @param {object|null} [except] a piece to ignore (the one being placed)
 * @returns {number}
 */
export function nextFreeRackCell(rack, except = null) {
  const cells = Constants.DAUGHTER_CARGO_CELLS ?? 2;
  let used = 0;
  if (Array.isArray(rack)) {
    for (let i = 0; i < rack.length; i++) {
      const h = rack[i];
      if (!h || h === except) continue;
      const c = Number.isInteger(h._rackCell) ? h._rackCell : i;
      if (c >= 0 && c < 30) used |= (1 << c);
    }
  }
  for (let k = 0; k < cells; k++) if (!(used & (1 << k))) return k;
  return Array.isArray(rack) ? rack.length : cells;
}

/**
 * The piece holding `cell` of `rack` (a piece without a `_rackCell` holds the cell of its array position, as
 * `nextFreeRackCell` reads it), or null. rack-centre: cell 1 stacks on what cell 0 holds, so every reader that needs
 * cell k's place asks for the piece in cell k-1.
 * @param {Array<object>|null|undefined} rack
 * @param {number} cell
 * @param {object|null} [except] a piece to ignore (the one being placed)
 * @returns {object|null}
 */
export function rackPieceInCell(rack, cell, except = null) {
  if (!Array.isArray(rack) || !(cell >= 0)) return null;
  for (let i = 0; i < rack.length; i++) {
    const h = rack[i];
    if (!h || h === except) continue;
    if ((Number.isInteger(h._rackCell) ? h._rackCell : i) === cell) return h;
  }
  return null;
}

/**
 * Her +Z support, metres: max z over her bodyDims box and every solid mesh vertex of hers (the set
 * `catchHoldStandoffM` measures against), in her frame.
 * @param {number[]|null} bodyDims [x, y, z] full box dimensions, metres
 * @param {Float32Array|null} [solidPointsM] her solid-mesh vertices, her frame, metres
 * @returns {number}
 */
export function herSupportZM(bodyDims, solidPointsM = null) {
  let s = bodyDims ? bodyDims[2] / 2 : 0;
  if (solidPointsM) {
    for (let i = 2; i < solidPointsM.length; i += 3) if (solidPointsM[i] > s) s = solidPointsM[i];
  }
  return s;
}

/**
 * The catch's support along `dirFrame` (a unit vector in the frame its attitude `qCatch` is expressed in), metres:
 * the farthest of its DRAWN vertices (cached mesh, at the scale the renderer uses) in that direction.
 * @param {object} d the catch (reads type, id, sizeMeter, sceneSize, _catchRenderMin)
 * @param {THREE.Quaternion} qCatch the catch's attitude in that frame
 * @param {THREE.Vector3} dirFrame
 * @returns {number|null} null when the catch has no drawn mesh
 */
function catchSupportAlongM(d, qCatch, dirFrame) {
  if (!d || !d.type) return null;
  const verts = _holdVertices(DebrisWireframe.getGeometry(d.type, d.id));
  if (verts.length < 3) return null;
  _rcDir.copy(dirFrame).applyQuaternion(_rcQ.copy(qCatch).invert());   // direction in the mesh's own frame
  const lx = _rcDir.x, ly = _rcDir.y, lz = _rcDir.z;
  let best = -Infinity;
  for (let i = 0; i < verts.length; i += 3) {
    const dot = verts[i] * lx + verts[i + 1] * ly + verts[i + 2] * lz;
    if (dot > best) best = dot;
  }
  return best * (DebrisField.effectiveRenderScale(d) / M);
}

const _rcBelowOff = new THREE.Vector3();

/**
 * ONE computation of a rack cell's offset on her, her frame, metres (rack-centre Decisions 1-2). Every cell is ON
 * her axis (x = y = 0). With a typed catch and its attitude in her frame (`qLocalHer`) the extents are measured from
 * the drawn mesh; otherwise (a prediction in `suggestCargoArm`, an old save, a typeless rig) the typeless form:
 * extent = sizeMeter/2.
 *   cell 0:   z = sHerM + (catch's support along -Z) + ARM_HOLD_NET_GAP_M
 *   cell k:   z = z(cell k-1's piece) + (that piece's support along +Z) + ARM_HOLD_NET_GAP_M + (catch's support
 *             along -Z)           — its nearest drawn point one net gap past the piece below's farthest one.
 * `below` is the piece in cell k-1 (`rackPieceInCell`); with none the cell is laid out as cell 0 (a prediction for a
 * rack the caller cannot see).
 * @param {THREE.Vector3} out receives (0, 0, z), metres
 * @param {number} sHerM her +Z support (`herSupportZM`)
 * @param {object|null} d the catch (may be null for a size-only prediction)
 * @param {number} cell 0 or 1
 * @param {THREE.Quaternion|null} qLocalHer the catch's attitude in her frame (null: typeless form)
 * @param {number} [sizeMeter=0] used when `d` carries no size
 * @param {object|null} [below=null] the piece in cell k-1 (its stored `_rackLocalM`, `_qLocalHer`, type)
 * @returns {THREE.Vector3} out
 */
export function rackCellOffsetInto(out, sHerM, d, cell, qLocalHer, sizeMeter = 0, below = null) {
  const gap = Constants.ARM_HOLD_NET_GAP_M ?? 0.03;
  const size = (d && Number.isFinite(d.sizeMeter) && d.sizeMeter !== 0) ? d.sizeMeter : (sizeMeter || 0);
  let sNear = size / 2;
  if (d && d.type && qLocalHer) {
    const s = catchSupportAlongM(d, qLocalHer, _rcZ);
    if (s !== null) sNear = s;
  }
  if (cell >= 1 && below && below !== d) {
    // where the piece below sits (stored, else laid out as its own cell) and how far it reaches along +Z
    let zBelow;
    if (below._rackLocalM) zBelow = below._rackLocalM.z;
    else {
      rackCellOffsetInto(_rcBelowOff, sHerM, below, cell - 1, below._qLocalHer || null, 0, null);
      zBelow = _rcBelowOff.z;
    }
    let farBelow = ((below.sizeMeter > 0 ? below.sizeMeter : 0)) / 2;
    if (below.type && below._qLocalHer) {
      const f = catchSupportAlongM(below, below._qLocalHer, _rcZp);
      if (f !== null) farBelow = f;
    }
    return out.set(0, 0, zBelow + farBelow + gap + sNear);
  }
  return out.set(0, 0, sHerM + sNear + gap);
}

/**
 * The catch's longest mesh axis (unit, in the mesh's own frame): the largest half-extent of its drawn bounding box.
 * The plume volume model (S9) lays its box along this axis. `+Z` for a catch with no drawn mesh.
 * @param {object} d the catch (reads type, id)
 * @param {THREE.Vector3} out
 * @returns {THREE.Vector3} out
 */
export function catchLongAxisInto(d, out) {
  out.set(0, 0, 1);
  if (!d || !d.type) return out;
  const bb = DebrisWireframe.getBoundingBoxExtents(d.type, d.id);
  if (!bb) return out;
  if (bb.hx >= bb.hy && bb.hx >= bb.hz) out.set(1, 0, 0);
  else if (bb.hy >= bb.hz) out.set(0, 1, 0);
  return out;
}

/**
 * A cell's offset for a reader that may not have one stored: the piece's stored offset when it has one, else the
 * prediction for `cell` on `arm` (a real ArmUnit, or a duck-typed mock with `config.bodyDims`/`config.type`).
 * rack-centre (Decision 2): cell 1 stacks on what cell 0 holds, so the prediction reads the piece in cell k-1 from
 * `arm.heldCatches` (a mock with no rack lays the cell out as cell 0).
 * @param {THREE.Vector3} out
 * @param {object} arm
 * @param {object|null} d
 * @param {number} cell
 * @param {number} [sizeMeter=0]
 * @returns {THREE.Vector3} out
 */
export function rackOffsetFor(out, arm, d, cell, sizeMeter = 0) {
  if (d && d._rackLocalM) return out.copy(d._rackLocalM);
  let sHer;
  if (arm && typeof arm.herSupportZM === 'function') sHer = arm.herSupportZM();
  else {
    const cfg = arm && arm.config;
    const dims = (cfg && cfg.bodyDims) || (cfg && cfg.type === 'spinner' ? Constants.SPINNER_BODY : Constants.WEAVER_BODY);
    sHer = herSupportZM(dims, null);
  }
  const below = cell >= 1 ? rackPieceInCell(arm && arm.heldCatches, cell - 1, d) : null;
  return rackCellOffsetInto(out, sHer, d, cell, null, sizeMeter, below);
}

// ── catch-snug (2026-10-18): a catch held IN HAND sits tight at her end ──────
// Owner, play report 2026-10-18: "debris seems to float .5 meter away from end of
// daughter, should be reeled in firmly to end of daughter." The old in-hand pin put
// the catch centre at sizeMeter/2 + ARM_HOLD_CLEARANCE_M (1.0 m) along the hold axis;
// the DRAWN mesh reaches 0.7-1.1 m off her end (measured 2026-10-18). Now, every
// frame, the centre distance is her support along the axis + the catch's support
// along -axis + ARM_HOLD_NET_GAP_M, so the nearest DRAWN point is one net gap from
// her end whatever either of them is doing. Measured from the real shapes: her
// bodyDims box plus every SOLID mesh of hers (nozzles, socket, net launcher,
// antenna ...; NOT plume/halo meshes, sprites or lines: `collectSolidPointsM`) and
// the catch's cached mesh vertices at the scale the renderer uses
// (`DebrisField.effectiveRenderScale`, the one shared reader), in the orientation
// it is drawn at (tumbleAxis/tumbleAngle). No size factor anywhere, so a change to
// the drawn scale or mesh follows by itself.
const _holdVertCache = new WeakMap();   // BufferGeometry -> Float32Array of UNIQUE vertices (xyz)
function _holdVertices(geo) {
  let verts = _holdVertCache.get(geo);
  if (verts) return verts;
  const pos = geo && geo.attributes && geo.attributes.position;
  const seen = new Set();
  const list = [];
  if (pos) {
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const key = `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(x, y, z);
    }
  }
  verts = new Float32Array(list);
  _holdVertCache.set(geo, verts);
  return verts;
}
const _snugQuat = new THREE.Quaternion();
const _snugDirLocal = new THREE.Vector3();

/**
 * Every vertex of the SOLID meshes under `root` (a daughter's `mesh` group), in `root`'s own
 * frame, in METRES (the daughter is modelled in scene units). Plume/halo meshes (named
 * `*plume*`, or drawn additively), sprites and line objects are not solid and are skipped.
 * Duplicates are merged (0.1 mm), so the list stays a few hundred points.
 * @param {THREE.Object3D} root
 * @returns {Float32Array} xyz triples, metres
 */
export function collectSolidPointsM(root) {
  const out = [];
  const seen = new Set();
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();
  root.traverse((o) => {
    if (o === root || !o.isMesh || !o.geometry) return;
    if (/plume/i.test(o.name || '')) return;
    if (o.material && o.material.blending === THREE.AdditiveBlending) return;
    const pos = o.geometry.attributes && o.geometry.attributes.position;
    if (!pos) return;
    // matrix of `o` relative to `root`
    m.identity();
    for (let p = o; p && p !== root; p = p.parent) { p.updateMatrix(); m.premultiply(p.matrix); }
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m).multiplyScalar(1 / M);
      const key = `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(v.x, v.y, v.z);
    }
  });
  return new Float32Array(out);
}

/**
 * Distance (metres) from a daughter's centre to the centre of the catch she holds,
 * such that the nearest drawn point of the catch is `gapM` off her real drawn end along
 * the unit hold axis `dir` (world frame): the end of her bodyDims box, or of any solid
 * mesh of hers (`solidPointsM`, from `collectSolidPointsM`) that sticks out further.
 * The catch's drawn scale is `DebrisField.effectiveRenderScale(d)` (the one shared
 * reader) — the caller marks the catch `_armPinned` first, as the renderer will see it.
 * @param {THREE.Quaternion} bodyQuat daughter's current world attitude (group.quaternion)
 * @param {number[]} bodyDims [x, y, z] full box dimensions, metres
 * @param {object} d the catch (reads type, id, sizeMeter, sceneSize, tumbleAxis/Angle, _catchRenderMin)
 * @param {THREE.Vector3} dir unit hold axis, world frame (daughter -> catch)
 * @param {number} gapM air gap, metres
 * @param {Float32Array|null} [solidPointsM] her solid-mesh vertices, her frame, metres
 * @returns {number|null} metres, or null when the catch has no drawn mesh (no type)
 */
export function catchHoldStandoffM(bodyQuat, bodyDims, d, dir, gapM, solidPointsM = null) {
  if (!d || !d.type || !bodyDims || !dir) return null;
  // Her support along dir: box half-extents, in her own frame ...
  _snugDirLocal.copy(dir).applyQuaternion(_snugQuat.copy(bodyQuat).invert());
  let daughterM = Math.abs(_snugDirLocal.x) * bodyDims[0] / 2
    + Math.abs(_snugDirLocal.y) * bodyDims[1] / 2
    + Math.abs(_snugDirLocal.z) * bodyDims[2] / 2;
  // ... or any solid part of her mesh that reaches further (aft nozzle 1.9 cm past the box,
  // the net launcher 5 cm past the fore face, the antenna ...).
  if (solidPointsM) {
    const sx = _snugDirLocal.x, sy = _snugDirLocal.y, sz = _snugDirLocal.z;
    for (let i = 0; i < solidPointsM.length; i += 3) {
      const dot = solidPointsM[i] * sx + solidPointsM[i + 1] * sy + solidPointsM[i + 2] * sz;
      if (dot > daughterM) daughterM = dot;
    }
  }
  // Her catch's support along -dir: its vertices, at the drawn scale and attitude.
  const geo = DebrisWireframe.getGeometry(d.type, d.id);
  const verts = _holdVertices(geo);
  if (verts.length < 3) return null;
  if (d.tumbleAxis) _snugQuat.setFromAxisAngle(d.tumbleAxis, d.tumbleAngle || 0);
  else _snugQuat.identity();
  _snugDirLocal.copy(dir).negate().applyQuaternion(_snugQuat.invert());
  const lx = _snugDirLocal.x, ly = _snugDirLocal.y, lz = _snugDirLocal.z;
  let best = -Infinity;
  for (let i = 0; i < verts.length; i += 3) {
    const dot = verts[i] * lx + verts[i + 1] * ly + verts[i + 2] * lz;
    if (dot > best) best = dot;
  }
  // The drawn scale, from the game's own reader (what pinCapturedDebris / _updateInstanceTransform
  // draw it at); published on the catch so a test can assert the two never disagree.
  const scaleScene = DebrisField.effectiveRenderScale(d);
  d._holdDrawnScale = scaleScene;
  const catchM = best * (scaleScene / M);
  const total = daughterM + catchM + gapM;
  return Number.isFinite(total) ? total : null;
}

// rack-snug scratch (the repo's no-per-frame-allocation idiom)
const _stowHerQ = new THREE.Quaternion();
const _stowInvQ = new THREE.Quaternion();
const _stowTmp = new THREE.Vector3();
const _asgHerQ = new THREE.Quaternion();
const _slotHerQ = new THREE.Quaternion();
const _pinHerQ = new THREE.Quaternion();
const _herDirTmp = new THREE.Vector3();
const _slotOffTmp = new THREE.Vector3();
const _pinLocal = new THREE.Vector3();
const _lrFrom = new THREE.Vector3();
const _gdDir = new THREE.Vector3();
const _gdAxis = new THREE.Vector3();
const _gdWorld = new THREE.Vector3();
// reel-home scratch
const _rhV1 = new THREE.Vector3();
const _rhV2 = new THREE.Vector3();
const _rhV3 = new THREE.Vector3();
const _failTip = new THREE.Vector3();   // fail-reel: her strut tip, world, for the 500 m rule
const _rhV4 = new THREE.Vector3();
const _rhV5 = new THREE.Vector3();
const _rhQ1 = new THREE.Quaternion();
const _rhQ2 = new THREE.Quaternion();
const _rhM1 = new THREE.Matrix4();
const _rhTailQuat = new THREE.Quaternion();
// trip-melt-2 (carry) scratch
const _carryLocal = new THREE.Vector3();
const _carryC = new THREE.Vector3();
const _carryF = new THREE.Vector3();
const _carryV = new THREE.Vector3();
const _carryDir = new THREE.Vector3();
const _carryQ = new THREE.Quaternion();
const _idQuat = new THREE.Quaternion();
const _carryCL = new THREE.Vector3();          // petal-single: the delivered catch's centre in her frame (scene units)
const _carryU0 = new THREE.Vector3();          // catch -> her centre, ship frame
const _carryD2 = new THREE.Vector3();          // the direction her body trails along at the seat
const _carryQi = new THREE.Quaternion();       // scratch inverse
const _carryHq = {};                           // the receiving tip's hinge frame (TipCargo.hingeQuatShipInto)

// ---------------------------------------------------------------------------
// §11.5 capture-torque settle — pure physics (exported for headless tests).
// See the Constants.CAPTURE_TORQUE_SETTLE block for the full derivation.
// ---------------------------------------------------------------------------

/** I = INERTIA_COEFF·m·d² — uniform solid sphere of diameter sizeMeter (kg·m²). */
export function captureMomentOfInertia(massKg, sizeMeter) {
  const CTS = Constants.CAPTURE_TORQUE_SETTLE;
  const m = massKg > 0 ? massKg : 0;
  const d = sizeMeter > 0 ? sizeMeter : 0;
  return CTS.INERTIA_COEFF * m * d * d;
}

/** L = I·|ω| — spin angular momentum arrested by the cinch (N·m·s). */
export function captureAngularMomentum(massKg, sizeMeter, tumbleRateRadS) {
  return captureMomentOfInertia(massKg, sizeMeter) * Math.abs(tumbleRateRadS || 0);
}

/**
 * t_settle = L / TETHER_DAMP_TORQUE_NM, clamped to [T_SETTLE_MIN_S,
 * T_SETTLE_MAX_S] — the audit's τ = L/t_settle solved for time under a fixed
 * tether torque budget (s).
 */
export function captureSettleDuration(L) {
  const CTS = Constants.CAPTURE_TORQUE_SETTLE;
  const t = (L || 0) / CTS.TETHER_DAMP_TORQUE_NM;
  return Math.min(CTS.T_SETTLE_MAX_S, Math.max(CTS.T_SETTLE_MIN_S, t));
}

/**
 * Rip band for the strain gate: 0 at/below STRAIN_GATE_DEG_S, 1 at/above
 * STRAIN_RATE_RATED_DEG_S, linear between. Anchored to ABSOLUTE rates (the
 * gate is a rate line), unlike strainBandT's rated-mass fractions.
 */
export function captureSettleRipBandT(rateDegS) {
  const CTS = Constants.CAPTURE_TORQUE_SETTLE;
  const gate = CTS.STRAIN_GATE_DEG_S;
  const rated = CTS.STRAIN_RATE_RATED_DEG_S;
  if (!(rated > gate)) return (rateDegS || 0) > gate ? 1 : 0;
  return Math.min(1, Math.max(0, ((rateDegS || 0) - gate) / (rated - gate)));
}

export class ArmUnit {
  /**
   * @param {string} id - e.g. 'weaver-1', 'spinner-2'
   * @param {'weaver'|'spinner'} type
   * @param {THREE.Vector3} dockOffset - LOCAL offset from core center when docked
   * @param {THREE.Scene} scene
   */
  constructor(id, type, dockOffset, scene) {
    this.id = id;
    this.index = null;                    // Set by ArmManager after construction
    this.type = type;
    this.state = S.DOCKED;
    this.scene = scene;

    /** @type {THREE.Vector3} Local dock position relative to core center */
    this.dockOffset = dockOffset.clone();

    // --- Type-specific configuration ---
    const isWeaver = type === 'weaver';
    this.config = {
      // Physical mass for ALL dynamics (manual-thrust accel, capture combined
      // mass, recoil residual, deorbit ΔV). Uses the V5 figures (6.6/2.1 kg) so
      // it matches crossbow launch, CoM, and recoil-cancel math — the legacy
      // Constants.WEAVER_MASS/SPINNER_MASS (11.0/3.7) are pre-V5 and would
      // mis-size recoil compensation by ~67%.
      mass: isWeaver ? V5_WEAVER_MASS : V5_SPINNER_MASS,
      type: type,
      tetherMax: isWeaver ? Constants.WEAVER_TETHER_LENGTH : Constants.SPINNER_TETHER_LENGTH,
      maxCaptureMass: isWeaver ? Constants.WEAVER_MAX_CAPTURE_MASS : Constants.SPINNER_MAX_CAPTURE_MASS,
      netSize: isWeaver ? Constants.WEAVER_NET_SIZE : Constants.SPINNER_NET_SIZE,
      bodyDims: isWeaver ? Constants.WEAVER_BODY : Constants.SPINNER_BODY,
      capturesPerFuel: isWeaver ? Constants.WEAVER_CAPTURES_PER_FUEL : Constants.SPINNER_CAPTURES_PER_FUEL,
      approachSpeed: Constants.ARM_APPROACH_SPEED,
      haulSpeed: Constants.ARM_HAUL_SPEED,
      thrust: isWeaver ? Constants.WEAVER_THRUST : Constants.SPINNER_THRUST,
      // Register item 100: the tank as total Δv — the SSOT for impulse-priced
      // TRANSIT/APPROACH fuel (was the inline `|| 50` fallback in getStatus).
      totalDeltaV: Constants.ARM_TOTAL_DELTAV,
    };

    // --- Runtime state ---
    this.fuel = 100;                        // 0–100 percentage
    this.coldGasKg = this._coldGasBottleKg(); // reel-gas: her cold-gas bottle, kg (starts full; refilled from the mother's coldGas while docked)
    this.tetherLength = 0;                  // current deployed length in meters
    this.target = null;                     // assigned debris object
    this.capturedDebris = null;             // debris hauled back (the in-hand scalar)
    this.heldCatches = [];                  // S6: the parked cargo rack (HOLDING_CATCH only)
    this.stateTimer = 0;                    // seconds in current state
    this.captures = 0;                      // total captures by this arm
    this._startingDistance = 0;             // distance to target at transit start (for approach beep fraction)
    this.position = new THREE.Vector3();    // world position
    this.velocity = new THREE.Vector3();    // world velocity

    // Tether detach state (Phase 6 — Risk-Reward)
    this.isDetached = false;                // true after tether severed
    this._detachFuelWarning25 = false;      // already warned at 25%
    this._detachFuelWarning10 = false;      // already warned at 10%

    // Pre-allocated temporary vectors for hot-loop methods
    this._tmpVec = new THREE.Vector3();

    // Cached parent-ship world quaternion — refreshed each frame by _updateDocked().
    // Needed so deploy*() methods (called externally while DOCKED) can compute a
    // world-space deploy direction from the LOCAL dockOffset (§4.6 180° bug).
    /** @type {THREE.Quaternion|null} */
    this._lastParentQuat = null;
    this._frameParentQuat = null;   // fail-reel: the mother's orientation of her last out-frame (set in _updateTether)

    /** @type {THREE.Vector3|null} Previous frame's parent position — for orbital frame correction */
    this._prevParentPos = null;

    /** @type {THREE.Vector3|null} THIS frame's parent position (set at the top of `update`; nets-1b R9) */
    this._frameParentPos = null;

    /** @type {THREE.Vector3|null} Previous frame's target scene position — for orbital drift correction */
    this._prevTargetScenePos = null;

    // Manual pilot mode (ARM PILOT)
    this._manualMode = false;
    this._manualCapture = false; // Flag for manual capture scoring (Delegate 3C)
    this._fuelAtDeploy = 100;    // Track fuel at deployment for efficiency scoring
    this._autoFailChance = 0;    // Set by external code to trigger tutorial auto-failure

    this._nearbyDebris = [];               // injected by ArmManager for proximity checks

    // Web shot state (Sprint D1)
    this._webShotCooldown = 0;             // seconds remaining before next shot
    this._webShotTarget = null;            // target debris during WEB_SHOT state
    this._webShotPrevState = S.DOCKED;     // state to return to after shot
    this._webShotOrigin = new THREE.Vector3(); // position when shot was fired

    // Trawling mode state (Phase 6)
    this._trawlingMode = false;
    this._trawlDirection = null;
    this._trawlTimer = 0;

    // ── V5 Crossbow state ──
    this.springTier = 0;                    // Index into SPRING_TIERS
    this.tetherTier = 0;                    // Index into TETHER_TIERS
    this.springCharged = true;              // Starts charged (ready to fire)
    this.reloadProgress = 0;               // 0..1 reload completion
    this.reloadDuration = 0;               // Calculated reload time for current speed
    // Register item 100: clamped at birth — selected must equal fired from the
    // first frame (min(10, T1 ceiling 7.1)). Kills the two record-only nits the
    // item-76(d) session measured: the T1 dual-fire residual over-bill (×1.408)
    // and the _updateReloading fallback's 27.5 s-for-a-13.9 s-shot bill.
    this.launchSpeed = Math.min(CROSSBOW_LAUNCH_SPEED_DEFAULT, SPRING_TIERS[0].maxSpeed);
    this.launchDirection = null;            // Direction set before launch
    this._impulseDvAccum = 0;              // Σ|dvCmd| (m/s) the autopilot applied this frame — item 100 impulse fuel

    // V5 Tether state
    this.tetherTension = 0;                // Current tension in Newtons
    // Register item 100: `tetherMaxLength` (TETHER_TIERS[].maxLength mirrored
    // here) was DEAD — written, never read; the live length is config.tetherMax
    // (deploy gate, tether-limit recall, position clamps), which setTetherTier
    // now writes. Deleted — the item-76(a) dead-data shape.
    this.tetherBreakStrength = TETHER_TIERS[0].breakStrength; // From current tier
    this.reeling = false;                  // True when actively reeling in
    this._tetherCreakCooldown = 0;         // s — rate-limit countdown for the daughter TETHER_TENSION creak (_updateReeling)
    this._tetherSevered = false;           // True after a tether SNAP (hides line, drifts)
    this._severedCatch = null;             // debris still pinned to this arm after a tether snap
    this._severedDriftS = 0;               // s drifting since the snap (bounds the pin)
    this._netRatedMass = 0;                // kg — net's rated capture mass (set in initNetInventory)
    this._netDiameter = 0;                 // m — net mouth diameter (set in initNetInventory)

    // ── Daughter multi-tool (CP-1 / P2 — DAUGHTER_MULTITOOL_SPEC) ──
    // Static-by-class toolset, read once on construction. selectedTool is the
    // verb F dispatches; it is (re)defaulted to the recommended tool whenever
    // the daughter enters STATION_KEEP. The live odds strip reads _toolOdds.
    this.toolset = (Constants.DAUGHTER_TOOLSETS && Constants.DAUGHTER_TOOLSETS[type])
      ? Constants.DAUGHTER_TOOLSETS[type].slice()
      : ['NET'];
    this.selectedTool = 'NET';
    this._captureToolKind = 'NET';         // which verb actually secured the live catch
    // ── Live tool odds (capture-feedback overhaul Phase 1b) ──
    // Refreshed at TOOL_ODDS.REFRESH_HZ during STATION_KEEP so de-spinning /
    // closing in reads as a live count-up on the reticle odds strip.
    this._toolOdds = null;                 // { NET: {p, blocker, hint}, ... }
    this._toolOddsFragRisk = 0;            // pre-fire FRAG % for the ⚠ chip
    this._toolOddsTimer = 0;               // refresh accumulator (s)
    // ── Reel boost (capture-feedback overhaul Phase 3a) ──
    this._boostReelHeld = false;           // Shift held (set by InputManager via ArmManager)
    this._boostReel = false;               // boost ACTIVE this frame (REELING + payload)
    // ── Eddy-current detumble (Phase 3c — MAGNET secondary) ──
    this._eddyActive = false;              // damping running this frame
    this._eddyTarget = null;               // debris being damped (for flag cleanup)
    // Magnetic-grapple sub-state machine (P2): null | 'ENERGIZING' | 'CLOSING' | 'GRIP'
    this._magPhase = null;
    this._magTimer = 0;
    // Tool-closing CA exemption: debris id held under AUTOPILOT_TARGET_LOCK while
    // the daughter deliberately closes to contact (magnet / gripper / pad). Released
    // centrally on ANY exit from the closing state (_transitionTo) so it can't leak.
    this._toolLockedDebrisId = null;
    // Gripper-grapple sub-FSM (P3): null | 'EXTEND' | 'SEEK' | 'CLOSE'
    this._gripPhase = null;
    this._gripTimer = 0;
    // Pad-contact sub-FSM (P4): null | 'APPROACH' | 'CONTACT'
    this._padPhase = null;
    this._padTimer = 0;
    this._padResolvedMode = null;
    this._padOffset = null;   // scene units — her offset from the piece while the pad closes (rides with it)
    // §13 Q3 — per-arm UV-cure magazine (finite; runtime-only at Y0, persistence deferred).
    this._padUvCureDosesRemaining = (Constants.PAD_CONTACT && Constants.PAD_CONTACT.UV_CURE_DOSES_Y0) || 10;

    // V5 Ablation state
    this.ablationTarget = null;            // Target being ablated
    this.ablationTimer = 0;                // Time spent ablating

    // ── Epic 8.3: FEEP Dual-Metal System ──
    this._currentMetal = 'indium';     // active FEEP propellant
    this._alternateMetal = null;       // second slot (unlocked via Forge)
    this._metalIsp = Constants.ION_THRUSTER.ISP_DEFAULT; // current operating ISP

    // ── Epic 8: STATION_KEEP state ──
    // _orbitTheta/_orbitPhi are now interpreted in a frozen *entry frame*
    // captured at SK entry (see _initSkFrame).  θ is yaw around the camera-up
    // axis (Earth-radial at debris) and φ is delta-pitch around the camera-
    // right axis.  Both are 0 at entry and clamped within THETA_LIMIT_DEG /
    // (MAX_LATITUDE − TETHER_SAFETY_MARGIN).
    this._orbitTheta = 0;                   // yaw delta in entry frame (rad)
    this._orbitPhi = 0;                     // pitch delta in entry frame (rad)
    /** @private Frozen entry frame axes (set on SK entry, cleared on exit). */
    this._skPolarAxis = null;               // THREE.Vector3 — Earth-radial at debris
    this._skEquator0 = null;                // THREE.Vector3 — initial debris→arm dir
    this._skRightVec = null;                // THREE.Vector3 — equator0 × polar (screen-right)
    this._skPitch0 = 0;                     // rad — entry pitch (so θ=φ=0 reproduces arrival pose)
    /** @private Pattern-C auto-return state (set during STATION_KEEP) */
    this._skIdleS = 0;                      // s — accumulated time since last arrow input
    this._standoffR = 5;                    // current standoff radius in metres
    this._standoffTargetR = 5;              // m — radius the settle-in eases toward
    this._standoffSettling = false;         // true while easing entry distance → nominal standoff
    this._thetaRate = 0;                    // current theta angular velocity
    this._phiRate = 0;                      // current phi angular velocity
    this._radiusRate = 0;                   // current radial velocity
    this._rMin = Constants.STATION_KEEP.MIN_STANDOFF;
    this._rMax = Constants.STATION_KEEP.MAX_STANDOFF;
    this._phiMax = Constants.STATION_KEEP.MAX_LATITUDE * Math.PI / 180;
    this._stationKeepTarget = null;         // reference to target debris

    // ── §11.4/§11.3 daughter net-fire recoil (FEATURE_FLAGS.DAUGHTER_NET_RECOIL) ──
    // Critically-damped controller transient the SK/NETTING hold loop fights:
    // the hold GOAL is displaced by _recoilOffsetM (metres, world axes) while
    // the RCS nulls it (see _updateRecoilKick). Vectors stay exactly zero and
    // untouched while the flag is OFF (byte-identical hold math).
    this._recoilOffsetM = new THREE.Vector3();  // m — current displacement off the hold sphere
    this._recoilVelMps = new THREE.Vector3();   // m/s — recoil velocity being nulled
    this._recoilActive = false;                 // fast-path gate for the hold loops
    this._recoilFuelBilled = 0;                 // % tank — cumulative RCS recovery surcharge (telemetry)
    // §11.3 reaction-wheel scalar — normalized launch-reaction momentum.
    // Increments per net fire, bleeds at WHEEL_DECAY_PER_S, saturation ⇒ paid
    // RCS desat per subsequent fire. Exposed via getStatus() for the HUD.
    this._wheelMomentum = 0;
    this._wheelSaturated = false;

    // ── §11.5 capture-torque settle (FEATURE_FLAGS.CAPTURE_TORQUE_SETTLE) ──
    // Live transient state or null. Seeded at the daughter net-FSM cinch
    // (_seedCaptureTorqueSettle), stepped every frame from update()
    // (_tickCaptureSettle) with the same critically-damped closed form as
    // _updateRecoilKick, one angular DOF about the catch's own tumbleAxis.
    // Stays exactly null while the flag is OFF (byte-identical legacy).
    this._settle = null;
    // Test hook mirroring _boostRipRollOverride: when non-null, replaces
    // Math.random() in the strain-gate rip roll for determinism.
    this._settleRipRollOverride = null;

    // ── reel-home (FEATURE_FLAGS.REEL_HOME, 2026-10-19) ──
    // Her net winds the catch in to her nose (a sub-phase of GRAPPLED), then the strut reel winds her home tail
    // first. All of this stays at its defaults while the flag is off.
    /** She is on the reels: winding the catch in (GRAPPLED net reel) or on the strut line (REELING). ArmManager reads it. */
    this._rhHome = false;
    /** The catch is held at its net-close separation from her (GRAPPLED, NET catch) instead of her jumping onto it. */
    this._rhPinned = false;
    /** catch − her, world, scene units. */
    this._rhSep = new THREE.Vector3();
    /** The net reel is over: the catch is in its rack cell on her and fixed in her frame. */
    this._rhArrived = false;
    /** The net reel (and its settle) is done: GRAPPLED hands over to REELING. */
    this._rhNetDone = false;
    /** Target cell offset, her frame, metres (scratch for the net reel). */
    this._rhCellM = new THREE.Vector3();
    /** She holds her `_aimReserved` for the reel-home strut drive (released with the reel). */
    this._rhReserved = false;
    /** Seconds the reel has held her at the line-up distance. */
    this._rhHoldS = 0;
    /** ArmManager's word: the mother is turning, or may still be asked to, for this daughter. */
    this._rhMotherWorking = false;
    /** Signed angle (rad) she is off the strut's plane, as seen from the strut root; ArmManager reads it. */
    this._rhPlaneErrRad = 0;
    /** Mother-turn requests made for this reel (ArmManager counts them). */
    this._rhTurnTries = 0;
    /** s until ArmManager may ask for another mother turn for this reel (REEL_HOME.TURN_RETRY_S after each request). */
    this._rhTurnWaitS = 0;
    /** The line-up on her own thrusters, or null. */
    this._rhLineUp = null;
    /** The line-up found the ship in the way (or no fuel): she waits, and tries again after a second (geometry changes). */
    this._rhNoPath = false;
    /** Seconds since `_rhNoPath` was set (it is re-evaluated every 1 s). */
    this._rhNoPathS = 0;
    /** The comms lines of this reel's line-up have been said (once each per reel). */
    this._rhLineUpSaid = false;
    this._rhWaitSaid = false;
    /** DOCKING came off the strut reel: the reel did the work, no thruster fuel is billed for it (fix round F6). */
    this._rhDockFree = false;
    /** Unclamped swing-plane angle nearest the direction hinge -> her (rad); ArmManager clamps it to [34°, 180°]. */
    this._rhBestAlpha = 0;
    /** Optional clearance hook (ArmManager): (worldPos, parentPos, parentQuat) -> gap to the ship, metres. */
    this._rhGapFn = null;
    /** Hinge -> her, ship-local, unit (set each frame she is on the reels). */
    this._rhRelShip = null;
    /** Arrival order on the reels (ArmManager: first come owns the mother turn). */
    this._rhSeq = 0;
    // ── reel-gas (owner 2026-10-21): the reel-home haul is a sim: pull-up, cruise, brake on her cold-gas jet ──
    /** Her current reel speed under REEL_HOME, game-scale m/s (per REAL s); 0 on entering REELING, held when dt is 0. */
    this._rhReelV = 0;
    /** The jet is firing this frame (she is slowing on gas): drives the gas bill, the look-puffs and the tension readout. */
    this._rhBraking = false;
    /** This reel's first look at the bottle has been made (the "no gas" line is said once per reel, at its start). */
    this._rhGasChecked = false;
    /** What the reel did this frame: 'pull' | 'cruise' | 'brake' | 'hold' (tests and the tension readout). */
    this._rhReelPhase = 'pull';
    /** The line readout of this frame, true N (Decision 8), and the mass the reel moved (dry + gas + net + catch), kg. */
    this._rhTensionN = 0;
    this._rhReelMassKg = 0;
    /** A carry leg's ion thread: 'aft' | 'fore' | null (which nozzle's exhaust points at her strut tip). */
    this._carryThread = null;
    /** Look-puffs of the jet: simulated seconds since the last one, and how many have been fired (visual only; tests read the count). */
    this._gasPuffAccum = 0;
    this._gasPuffCount = 0;
    /** The jet's port (mesh-local): the tail, firing -Z, toward the mother on the tail-first reel. Built with the puff pool. */
    this._gasPuffPort = null;

    // ── trip-melt-2 (carry): a rack catch carried to a radiator-tip furnace ──
    /** The carry in progress (CARRY_PREP … CARRY_BACK), or null. Plain data; see beginCarry. */
    this._carry = null;
    /** A carry of hers ended on its own failure (prep never arrived, hold lost, no fuel at the start): she is not asked again
     *  this trip (ArmManager.carryCheck reads it; the trip clears it at its start, `reset()` too). */
    this._carryGaveUp = false;

    // ── ST-9.3 C-3: Config G Aim + Hinge State ──
    /** Meridian sweep angle α ∈ [0, π]. 0=stowed(−Y), π/2=equatorial, π=zenith(+Y) */
    this._aimAlpha = 0;
    /** launch-smooth: the eased strut move in progress (see setAimAlpha's `ease`), else null. */
    this._aimEase = null;

    /**
     * Hinge state: 'ROTATE' (motor drives, brake off) or 'LOCKED' (brake on, motor off).
     * Gated by FEATURE_FLAGS.LOCKABLE_HINGE — when false, hinge behaves as always-ROTATE.
     * @type {string}
     */
    this._hingeState = Constants.HINGE_STATES.ROTATE;

    /**
     * Timer for auto-unlock after fire recoil settles.
     * When > 0, counts down; at 0 the hinge auto-unlocks.
     * @type {number}
     */
    this._hingeSettleTimer = 0;

    // Config G geometry — set by ArmManager._initArms() after construction
    /** @type {THREE.Vector3|null} */ this._hingePosition = null;
    /** @type {THREE.Vector3|null} */ this._dockOutward = null;
    /** @type {THREE.Vector3|null} */ this._swingAxis = null;
    /** @type {number} */ this._azimuthDeg = 0;
    /** @type {boolean} */ this._isEndFace = false;

    // ── ST-9.4 C-6: Capture Net Inventory ──
    // Per CAPTURE_NET.md §6.1: weaver carries Medium Net, spinner carries Small Net.
    // Gated by FEATURE_FLAGS.CAPTURE_NET — when false these stay at 0.
    /** @type {number} */ this._netInventory = 0;
    /** @type {number} */ this._netInventoryMax = 0;
    /** @type {object|null} */ this._firedNet = null;       // stored net reference for NETTING FSM
    /** @type {object|null} */ this._nettingOffset = null;  // standoff offset (arm - target) during NETTING

    // ST-8.2.2: Listen for orbital positioning commands
    eventBus.on(Events.ARM_ORBIT_ADJUST, (data) => {
      if (data.armId !== this.id) return;
      if (this.state !== Constants.ARM_STATES.STATION_KEEP) return;

      const SK = Constants.STATION_KEEP;
      const rate = data.fine ? SK.ORBIT_RATE_FINE : SK.ORBIT_RATE;
      const radRate = data.fine ? SK.RADIUS_RATE_FINE : SK.RADIUS_RATE;

      // Rate-based input (keys-held: ±/=, arrows). theta/phi/radius are
      // signed ±1 unit-rates; multiplied by SK.ORBIT_RATE / SK.RADIUS_RATE
      // (and dt at apply-time) inside _updateStationKeep. Rates reset
      // each frame at line ~2820 so missing-key frames decay to 0.
      this._thetaRate = (data.theta || 0) * rate;
      this._phiRate = (data.phi || 0) * rate;
      this._radiusRate = (data.radius || 0) * radRate;

      // Step-based input (one-shot: mouse-wheel). radiusStep is an
      // instantaneous delta in metres applied directly to _standoffR
      // (no dt, no rate). 0.5 m/tick × ~16 ticks spans the 4–12 m band.
      // Clamped to [_rMin, _rMax] by the existing clamp in
      // _updateStationKeep at line ~2763 on the next frame.
      if (typeof data.radiusStep === 'number' && data.radiusStep !== 0) {
        this._standoffR += data.radiusStep;
        // Immediate clamp so HUD readout reflects the bounded value
        // even if the next physics tick is delayed.
        this._standoffR = Math.max(this._rMin, Math.min(this._rMax, this._standoffR));
      }
    });

    // --- Visual ---
    this.group = new THREE.Group();
    this.group.name = this.id;
    this.mesh = null;
    this.tetherLine = null;
    this.tetherMaterial = null;
    this._thrusterPlumes = [];
    // Wave1 (daughter-plumes): fore FEEP pair + attitude cold-gas puffs.
    // All visual-only reads of existing physics fields — no fuel/attitude writes.
    this._forePlumes = [];        // fore core+halo (populated in _createMesh)
    this._forePlumeHalo = null;   // tagged so the halo dims to HALO_MULT × core
    this._skManeuverGlowS = 0;    // s left of SK maneuver-input brightening
    this._recoilFlashS = 0;       // s left of the fore counter-burn flash
    this._approachBrake01 = 0;    // smoothed APPROACH brake read (0..1)
    this._attPuffs = [];          // pooled cold-gas sprites (≤ PUFF_POOL_SIZE)
    this._attPuffIndex = 0;       // round-robin pool cursor
    this._attPuffLastFire = -Infinity; // global burst cooldown stamp (s)
    this._attPuffPorts = null;    // 4 fixed local ports {pos,dir} (built once)
    this._statusLightMat = null;
    this._netMesh = null;
    // Detail-LOD cull set (Phase 6): inert daughter hardware hidden when far.
    this._detailMeshes = [];
    this._detailHidden = false;

    // Selection highlight (hotkey revamp 2026-06-14, D4): when a DOCKED daughter
    // is selected with 1-4 it glows/flashes so the player can see which plate
    // they picked before launching with D. Driven by ArmManager via
    // setSelectedHighlight(); the pulse runs in _updateSelectGlow() each frame.
    /** @type {boolean} */
    this._selected = false;
    /** @type {Array<{mat:THREE.Material, baseEmissive:number, baseIntensity:number}>} */
    this._selectGlowMats = [];

    // S3.6: Bridle visual references (populated in _createMesh)
    this._gimbalRing = null;
    this._bridleLegA = null;
    this._bridleLegB = null;
    this._bridleLegMat = null;
    this._bridleHpA = null;
    this._bridleHpB = null;

    this._createMesh();
    this._createTether();

    // Wave1: 0.5 s fore-plume counter-burn flash on the recoil-kick emitter
    // (a PARALLEL task adds Events.ARM_RECOIL_KICK {armIndex}). Subscribe
    // DEFENSIVELY: only when the event name actually exists — until then this
    // is a clean no-op and every other plume behaviour still works. The flash
    // itself rides `_recoilFlashS`, which armPlumeModel decays to a fore flare.
    if (typeof Events.ARM_RECOIL_KICK === 'string' && Events.ARM_RECOIL_KICK) {
      this._onRecoilKick = (p) => {
        if (!p || p.armIndex !== this.index) return;
        this._recoilFlashS = DAUGHTER_PLUME.RECOIL_FLASH_S;
      };
      eventBus.on(Events.ARM_RECOIL_KICK, this._onRecoilKick);
    }

    // §2-followup (round 4): the daughter is a SEPARATE top-level scene object
    // from the mother, yet docks AT the mother's strut tip where their geometry
    // overlaps. Their meshes share the RENDER_ORDER scale, so equal bands (e.g.
    // both DETAIL) tie and resolve by ambiguous depth → z-fighting at the seam.
    // Lift the whole daughter BODY subtree by DAUGHTER_BIAS so it resolves
    // cleanly in front of the strut-tip collar while preserving the body's own
    // internal layering (every child keeps its relative renderOrder). The main
    // tether (a child of `this.group`, not `this.mesh`) bridges to the mother
    // and is intentionally left unbiased so it keeps lying on both craft; the
    // short bridle legs live on `this.mesh` and ride with the biased body.
    const dbias = Constants.RENDER_ORDER.DAUGHTER_BIAS;
    this.mesh.traverse((obj) => {
      if (obj.isMesh || obj.isLine || obj.isPoints || obj.isSprite) {
        obj.renderOrder += dbias;
      }
    });

    scene.add(this.group);
  }

  /**
   * Player-facing name for this daughter. Internal type stays 'weaver'/'spinner'
   * but the crew sees the size-based vocab: 'Large' / 'Small'. Delegates to the
   * shared {@link daughterDisplayName} so the HUD, reticle, and comms can never
   * disagree on the same daughter's name.
   * @returns {string}
   */
  get displayName() {
    return daughterDisplayName(this.id);
  }

  // ==========================================================================
  // 3D MODEL
  // ==========================================================================

  /** @private Build the arm unit Three.js model */
  _createMesh() {
    const [bx, by, bz] = this.config.bodyDims;
    const isWeaver = this.type === 'weaver';

    // --- S3.5: Hex prism body (Group replaces Mesh for child composition) ---
    this.mesh = new THREE.Group();
    this.mesh.name = `${this.id}-body`;
    this.group.add(this.mesh);

    const apothem = (bx / 2) * M;
    const hexR = apothem / Math.cos(Math.PI / 6);
    const halfLen = (bz * M) / 2;

    // §2-followup (round 12): the body side is built as 6 INDIVIDUAL flat facet
    // quads (instead of one textured hex shell) so we can control cell coverage
    // per facet: the solar-cell map goes on 5 facets, and the facet that carries
    // the round laser receiver (+Y) is left as bare metal. The end caps are also
    // plain metal (no cells). Separate, non-coincident faces → no z-fight.
    //
    // Facet k (k=0..5) outward azimuth = 30° + k·60° (matches the prior hex
    // thetaStart = π/6). +Y is 90° → facet k=1 carries the laser RX; leave bare.
    const LASER_FACET = 1;

    const baseColor = isWeaver ? 0x4488aa : 0x88aa44;
    // v7-daughters D2: bare facet + end caps are dark anodised grey (a real small
    // craft is not cartoon teal); the Weaver blue / Spinner green type colour moves
    // to the fore band ring below so each type still reads at a glance.
    const bareMetalMat = new THREE.MeshStandardMaterial({
      color: 0x3a3d44, metalness: 0.70, roughness: 0.45,
    });

    // Solar-cell facet material (GaAs map when available, else dark PV tint).
    const cellTex = getSolarCellTexture();
    let skinTex = null;
    if (cellTex) {
      skinTex = cellTex.clone();
      skinTex.needsUpdate = true;
      skinTex.repeat.set(isWeaver ? 1.0 : 0.7, 1.0); // ~one cell-tile per facet
    }
    const cellMat = skinTex
      ? new THREE.MeshStandardMaterial({
          color: 0xffffff, map: skinTex, emissiveMap: skinTex,
          emissive: 0x0b1030, emissiveIntensity: 0.18, metalness: 0.5, roughness: 0.5,
        })
      : new THREE.MeshStandardMaterial({
          color: baseColor, metalness: 0.5, roughness: 0.5,
          emissive: 0x060614, emissiveIntensity: 0.10,
        });

    // Width of one hex facet = side length = circumradius (hexagon property).
    const facetW = hexR;
    const facetGeo = new THREE.PlaneGeometry(facetW, bz * M);
    this._bodyShell = null; // (legacy ref no longer a single mesh)
    for (let k = 0; k < 6; k++) {
      const az = Math.PI / 6 + k * (Math.PI / 3);  // facet outward azimuth (XY)
      const mat = (k === LASER_FACET) ? bareMetalMat : cellMat;
      const facet = new THREE.Mesh(facetGeo, mat);
      // Plane default normal +Z; orient it to face outward at azimuth `az`,
      // with its height running along the body Z axis.
      const outward = new THREE.Vector3(Math.cos(az), Math.sin(az), 0);
      const bodyAxis = new THREE.Vector3(0, 0, 1);
      const tangent = new THREE.Vector3().crossVectors(bodyAxis, outward).normalize();
      facet.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(tangent, bodyAxis, outward)
      );
      facet.position.copy(outward).multiplyScalar(apothem);
      facet.name = `${this.id}-facet-${k}`;
      facet.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
      this.mesh.add(facet);
      if (k === 0) this._bodyShell = facet; // keep a representative ref
    }

    // D4 selection-glow: register the body facet materials (solar-cell skin +
    // the bare-metal laser facet) so _updateSelectGlow() can pulse their
    // emissive when this daughter is the selected plate. Both are per-arm
    // MeshStandardMaterials, so modulating their emissive is isolated to this
    // unit. Record each base emissive/intensity once for clean restore.
    for (const mat of [cellMat, bareMetalMat]) {
      if (mat && mat.emissive && !this._selectGlowMats.some(e => e.mat === mat)) {
        this._selectGlowMats.push({
          mat,
          baseEmissive: mat.emissive.getHex(),
          baseIntensity: mat.emissiveIntensity ?? 1.0,
        });
      }
    }

    // Plain metal end caps (fore +Z, aft −Z) — no solar cells on the ends.
    const capGeo = new THREE.CircleGeometry(hexR, 6);
    for (const s of [-1, 1]) {
      const cap = new THREE.Mesh(capGeo, bareMetalMat);
      cap.position.set(0, 0, s * halfLen);
      cap.rotation.y = s > 0 ? 0 : Math.PI;  // outward-facing
      // CircleGeometry(hexR, 6) default vertices sit at azimuth 0°+k·60°, which
      // are exactly the hull CORNERS between the side facets (facets are centered
      // at 30°+k·60°, L482). So the default cap already aligns — no z-rotation.
      // (Adding π/6 here rotated cap corners onto facet-normal azimuths, poking
      // ~13.4% past the facet planes. The aft cap's rotation.y=π mirror maps the
      // corrected vertex set onto itself, so this fixes both caps.)
      cap.name = `${this.id}-cap-${s > 0 ? 'fore' : 'aft'}`;
      cap.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
      this.mesh.add(cap);
    }

    // --- v7-daughters D2: corner rails + type-colour band ring --------------
    // Six thin gunmetal strips along the hull corners (ONE merged mesh, 72 tris)
    // give the prism an edge thickness; the 4 cm band near the fore cap carries
    // the type colour. Both ride DETAIL order above the facets (no coplanar tie:
    // rails are inset 2 mm from each cap, the band stands 2 % proud of the hull).
    {
      const railT = 0.006 * M;                       // radial thickness
      const railW = 0.006 * M;                       // tangential width
      const railL = (bz - 0.004) * M;                // 2 mm inset at each cap
      const parts = [];
      for (let k = 0; k < 6; k++) {
        const phi = k * (Math.PI / 3);
        const g = new THREE.BoxGeometry(railT, railW, railL);
        g.rotateZ(phi);
        g.translate(Math.cos(phi) * hexR, Math.sin(phi) * hexR, 0);
        parts.push(g);
      }
      const pos = []; const nrm = []; const idx = [];
      for (const g of parts) {
        const base = pos.length / 3;
        pos.push(...g.attributes.position.array);
        nrm.push(...g.attributes.normal.array);
        for (const i of g.index.array) idx.push(base + i);
        g.dispose();
      }
      const railGeo = new THREE.BufferGeometry();
      railGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      railGeo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      railGeo.setIndex(idx);
      const rails = new THREE.Mesh(railGeo, new THREE.MeshStandardMaterial({ ...AVIONICS_GUNMETAL }));
      rails.name = `${this.id}-rails`;
      rails.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      this.mesh.add(rails);

      const bandH = 0.04 * M;
      // Hex ring built as 6 flat quads (a merged buffer, not a round primitive: hexagonal by design, like the caps).
      const bandR = hexR * 1.02;
      const bp = [];
      for (let k = 0; k < 6; k++) {
        const a0 = k * (Math.PI / 3), a1 = (k + 1) * (Math.PI / 3);
        const x0 = Math.cos(a0) * bandR, y0 = Math.sin(a0) * bandR;
        const x1 = Math.cos(a1) * bandR, y1 = Math.sin(a1) * bandR;
        const zl = -bandH / 2, zh = bandH / 2;
        bp.push(x0, y0, zl, x1, y1, zl, x1, y1, zh,  x0, y0, zl, x1, y1, zh, x0, y0, zh);
      }
      const bandGeo = new THREE.BufferGeometry();
      bandGeo.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3));
      bandGeo.computeVertexNormals();
      const bandMat = new THREE.MeshStandardMaterial({
        color: baseColor, metalness: 0.35, roughness: 0.5, side: THREE.DoubleSide,
      });
      const band = new THREE.Mesh(bandGeo, bandMat);
      band.position.set(0, 0, halfLen - 0.032 * M);  // just behind the fore cap, 12 mm clear of it
      band.name = `${this.id}-band`;
      band.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      this.mesh.add(band);
    }

    // --- S3.5: Panel line edges (zero triangle cost) ---
    // §2-followup (round 8): the edges are built from a slightly LARGER hex
    // (1.5% proud) so the lines sit physically off the facets with a real,
    // zoom-independent gap (no coplanar z-fight with the facet quads).
    const edgeHexGeo = new THREE.CylinderGeometry(hexR * 1.015, hexR * 1.015, bz * M, 6, 1, false, Math.PI / 6);
    const edgeGeo = new THREE.EdgesGeometry(edgeHexGeo, 30);
    const edgeMat = new THREE.LineBasicMaterial({
      color: 0x667788, transparent: true, opacity: 0.5,
    });
    const edges = new THREE.LineSegments(edgeGeo, edgeMat);
    edges.rotation.x = Math.PI / 2;
    edges.name = `${this.id}-panel-lines`;
    edges.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_TRANSPARENT; // FIX_PLAN §2-followup
    this.mesh.add(edges);


    // --- v7-daughters D4: dock socket ring on the aft face. The Ø50 mm strut tube enters the hull through
    // this ring (bore Ø51.5 mm = 0.75 mm clear per side, wall 3 mm, 8 mm proud), so the tube no longer
    // vanishes into bare cap. A dark notch on the +Y side marks the D-flat of the print socket.
    const socketRi = 0.02575 * M;
    const socketRo = SOCKET_RO * M;
    const socketL = 0.008 * M;
    const socketGeo = new THREE.LatheGeometry([
      new THREE.Vector2(socketRi, 0), new THREE.Vector2(socketRi, socketL),
      new THREE.Vector2(socketRo, socketL), new THREE.Vector2(socketRo, 0),
    ], 48);
    const socket = new THREE.Mesh(socketGeo, new THREE.MeshStandardMaterial({
      ...AVIONICS_GUNMETAL, side: THREE.DoubleSide,
    }));
    socket.rotation.x = -Math.PI / 2;          // lathe +Y -> body -Z (outward from the aft cap)
    socket.position.set(0, 0, -halfLen);
    socket.name = `${this.id}-dock-socket`;
    socket.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.mesh.add(socket);
    // D10(c): the D-key mark sits on the +Y side (the print's flat is on the daughter's +Y facet), and reads
    // as a dark notch cut into the ring's rim: a small dark block set INTO the wall at the outer end (it is
    // only 0.2 mm proud of each wall face, so it is not a lug).
    const keyMat = new THREE.MeshStandardMaterial({ color: 0x08080c, metalness: 0.3, roughness: 0.6 });
    const keyW = socketRo - socketRi + 0.0004 * M;     // radial extent: the whole wall + 0.2 mm each side
    const keyL = 0.003 * M;                            // axial depth of the notch
    const key = new THREE.Mesh(new THREE.BoxGeometry(0.005 * M, keyW, keyL), keyMat);
    key.position.set(0, (socketRi + socketRo) / 2, -halfLen - socketL + keyL / 2);
    key.name = `${this.id}-dock-socket-key`;
    key.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.mesh.add(key);

    // --- S3.5 / v7 D7-D8: Aft FEEP nozzle. A real thruster on the dock axis would fire into the strut, so
    // the whole aft thruster (boss, nozzle box, plume pair) sits OFF-centre beside the socket, on the +X axis
    // toward the +X hull corner. Boss radius r_b = min(today's r, the room left between the socket ring and
    // the slanted hex edge, both with 2 mm of margin); centre x_c = R_O + 2 mm + r_b. The nozzle is a BOX
    // stub (real FEEP = box + aperture, no bell), side 0.6 x today's exit Ø, centred on the boss.
    const aftNozR = (isWeaver ? 0.015 : 0.010) * M;     // today's nozzle radius: sizes the plume + boss
    const aftNozL = (isWeaver ? 0.025 : 0.015) * M;
    const bossR0 = aftNozR * 2.0;
    const bossR = Math.min(bossR0,
      (apothem - Math.cos(Math.PI / 6) * (socketRo + 0.002 * M) - 0.002 * M) / (1 + Math.cos(Math.PI / 6)));
    const aftX = socketRo + 0.002 * M + bossR;          // thruster centre x (body frame)
    this._aftThrusterX = aftX;
    const aftSide = aftNozR * 2 * 0.6;
    const feepApMat = new THREE.MeshStandardMaterial({ color: 0x08080c, metalness: 0.3, roughness: 0.6, side: THREE.DoubleSide });   // dark aperture, per arm
    const aftNozGeo = new THREE.BoxGeometry(aftSide, aftNozL, aftSide);
    const feepMat = new THREE.MeshStandardMaterial({
      color: 0x444455, metalness: 0.85, roughness: 0.25,
    });
    const aftNozzle = new THREE.Mesh(aftNozGeo, feepMat);
    aftNozzle.position.set(aftX, 0, -bz * 0.52 * M);
    aftNozzle.rotation.x = Math.PI / 2;
    aftNozzle.name = `${this.id}-feep-aft`;
    this.mesh.add(aftNozzle);

    // Small mounting boss/recess ring at the nozzle base so it reads as attached
    // rather than a stub poking out of the cap. On a DISTINCT z-plane
    // (z=-bz*0.515) — between the aft cap (−0.5) and the pusher disc (−0.505,
    // L707) and the nozzle base (−0.52) — plus DETAIL order so it does not
    // re-introduce the L696/round-8 aft-nozzle-base z-fight.
    const bossGeo = new THREE.CylinderGeometry(bossR * (2.0 / 2.2), bossR, aftNozL * 0.4, 48, 1, false);
    const bossMat = new THREE.MeshStandardMaterial({
      color: 0x3a3a44, metalness: 0.7, roughness: 0.4,
    });
    const boss = new THREE.Mesh(bossGeo, bossMat);
    boss.position.set(aftX, 0, -bz * 0.515 * M);
    boss.rotation.x = Math.PI / 2;
    boss.name = `${this.id}-feep-aft-boss`;
    boss.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.mesh.add(boss);
    // Aperture: a dark disc on the nozzle's exit face (0.5 mm proud, faces -Z).
    const aftAp = new THREE.Mesh(new THREE.CircleGeometry(aftSide * 0.3, aftSide * 0.3 >= 0.005 * M ? 24 : 12), feepApMat);
    aftAp.position.set(aftX, 0, -bz * 0.52 * M - aftNozL / 2 - 0.0005 * M);
    aftAp.rotation.y = Math.PI;
    aftAp.name = `${this.id}-feep-aft-aperture`;
    aftAp.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.mesh.add(aftAp);

    // Aft thruster plume (additive, hidden by default) — HYBRID (Phase 3):
    // a physically-consistent silver-blue FEEP core (0x99bbdd, same propellant as
    // the Mother) inside a fainter TYPE-TINTED outer halo (Weaver blue / Spinner
    // green) so per-type identification survives at distance. Both are diverging
    // frustums (narrow at the exit, widening + alpha-fading aft) welded at the
    // nozzle exit; both are pushed to _thrusterPlumes so the single _updatePlumes
    // driver shows/flickers them together.
    const plumeLen = bz * 0.55 * M;
    const coreGeo = makePlumeFrustum(aftNozR * 1.0, aftNozR * 2.2, plumeLen, 10, 3);
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0x99bbdd, transparent: true, opacity: 0.0, vertexColors: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const plume = new THREE.Mesh(coreGeo, coreMat);
    // §2-followup (round 4): additive plume must draw AFTER solid geometry, like
    // the mother's plumes — without this the untagged plume sorted by raw depth
    // against the (separate) mother object and punched through inconsistently.
    plume.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;
    plume.position.set(aftX, 0, -bz * 0.5 * M);   // near end welded to aft nozzle exit (off-centre, D7)
    plume.rotation.x = -Math.PI / 2;           // beam local +Y → world -Z (aft)
    plume.visible = false;
    plume.name = `${this.id}-feep-plume-core`;
    this.mesh.add(plume);
    this._thrusterPlumes.push(plume);

    const haloGeo = makePlumeFrustum(aftNozR * 1.0, aftNozR * 3.0, plumeLen * 1.35, 10, 3);
    const haloMat = new THREE.MeshBasicMaterial({
      color: isWeaver ? 0x4488ff : 0x44ff88, transparent: true, opacity: 0.0, vertexColors: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const plumeHalo = new THREE.Mesh(haloGeo, haloMat);
    plumeHalo.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;
    plumeHalo.position.set(aftX, 0, -bz * 0.5 * M);
    plumeHalo.rotation.x = -Math.PI / 2;
    plumeHalo.visible = false;
    plumeHalo.name = `${this.id}-feep-plume-halo`;
    this.mesh.add(plumeHalo);
    this._thrusterPlumes.push(plumeHalo);
    this._plumeHalo = plumeHalo;   // tagged so _updatePlumes can dim it to ~0.4×

    // --- S3.5: Fore FEEP nozzle (braking/attitude, offset on +Z face) ---
    const foreNozR = (isWeaver ? 0.010 : 0.007) * M;
    const foreNozL = (isWeaver ? 0.015 : 0.010) * M;
    const foreSide = foreNozR * 2 * 0.6;
    // D10(a): the fore box sits OUTSIDE the net-launcher canister (r = canister radius, 55 / 35 mm), 2 mm
    // clear of it measured at the box's half-diagonal, on the +X axis. One shared x for nozzle, aperture, plumes.
    const foreCanR = (isWeaver ? 0.055 : 0.035) * M;
    const foreX = foreCanR + 0.002 * M + foreSide * Math.SQRT1_2;
    const foreNozGeo = new THREE.BoxGeometry(foreSide, foreNozL, foreSide);   // box stub (D8): height = axial length
    const foreNozzle = new THREE.Mesh(foreNozGeo, feepMat);
    // Protrude past the fore face (halfLen = bz·0.5·M) with the base embedded so
    // it reads as a real nozzle, not a stub buried inside the hull. The brake
    // plume axis test uses the daughter's world +Z direction (L4394), not this
    // mesh position, so moving it forward is safe.
    foreNozzle.position.set(foreX, 0, bz * 0.5 * M + foreNozL * 0.35);
    foreNozzle.rotation.x = -Math.PI / 2;
    foreNozzle.name = `${this.id}-feep-fore`;
    this.mesh.add(foreNozzle);
    const foreAp = new THREE.Mesh(new THREE.CircleGeometry(foreSide * 0.3, foreSide * 0.3 >= 0.005 * M ? 24 : 12), feepApMat);
    foreAp.position.set(foreX, 0, bz * 0.5 * M + foreNozL * 0.35 + foreNozL / 2 + 0.0005 * M);
    foreAp.name = `${this.id}-feep-fore-aperture`;
    foreAp.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.mesh.add(foreAp);

    // Fore thruster plume (Wave1 daughter-plumes) — same HYBRID idiom as the
    // aft pair above (silver-blue FEEP core + type-tinted halo, additive,
    // hidden by default), sized to the smaller fore nozzle and welded at its
    // exit plane. Fires when the daughter thrusts TOWARD travel: APPROACH
    // braking, the REDOCK_FEEP arrest window, and the recoil counter-burn —
    // driven by the same armPlumeModel mapping in _updatePlumes. LOD: gets the
    // aft plume's treatment exactly — NOT in the detail cull set (plumes are
    // communicative; the halo is the per-type ID at range).
    const forePlumeLen = bz * 0.40 * M;
    const foreExitZ = bz * 0.5 * M + foreNozL * 0.35 + foreNozL * 0.5;
    const foreCoreGeo = makePlumeFrustum(foreNozR * 1.0, foreNozR * 2.2, forePlumeLen, 10, 3);
    const foreCoreMat = new THREE.MeshBasicMaterial({
      color: 0x99bbdd, transparent: true, opacity: 0.0, vertexColors: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const forePlume = new THREE.Mesh(foreCoreGeo, foreCoreMat);
    forePlume.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;
    forePlume.position.set(foreX, 0, foreExitZ);  // welded to fore nozzle exit
    forePlume.rotation.x = Math.PI / 2;                   // beam local +Y → world +Z (fore)
    forePlume.visible = false;
    forePlume.name = `${this.id}-feep-plume-fore-core`;
    this.mesh.add(forePlume);
    this._forePlumes.push(forePlume);

    const foreHaloGeo = makePlumeFrustum(foreNozR * 1.0, foreNozR * 3.0, forePlumeLen * 1.35, 10, 3);
    const foreHaloMat = new THREE.MeshBasicMaterial({
      color: isWeaver ? 0x4488ff : 0x44ff88, transparent: true, opacity: 0.0, vertexColors: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const forePlumeHalo = new THREE.Mesh(foreHaloGeo, foreHaloMat);
    forePlumeHalo.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;
    forePlumeHalo.position.set(foreX, 0, foreExitZ);
    forePlumeHalo.rotation.x = Math.PI / 2;
    forePlumeHalo.visible = false;
    forePlumeHalo.name = `${this.id}-feep-plume-fore-halo`;
    this.mesh.add(forePlumeHalo);
    this._forePlumes.push(forePlumeHalo);
    this._forePlumeHalo = forePlumeHalo;

    // --- Mini net launcher (forward, cylindrical) — mirrors the mother's
    // launcher design language (2026-07-23, fore-end-hardware-labels-rework):
    // a single central gunmetal housing on the fore centreline (+Z, anti-spin
    // doctrine) whose front face is an inventory-driven magazine window: a pale
    // Dyneema cap per LOADED net over a dark bore. Replaces the old bare canister.
    const isWeaverLaunch = isWeaver;
    const netClass = Constants.CAPTURE_NET?.[isWeaverLaunch ? 'MEDIUM' : 'SMALL'];
    // Cell count = magazine size. Fall back to the drift-guarded ARM_NET_CAPACITY
    // constant (which a test enforces == CAPTURE_NET.*.MAGAZINE_SIZE) rather than
    // a third hardcoded literal, so the cap slots always match inventory capacity.
    const cellCount = (netClass && netClass.MAGAZINE_SIZE)
      ?? Constants.ARM_NET_CAPACITY?.[isWeaverLaunch ? 'weaver' : 'spinner'] ?? 0;
    const canR = isWeaverLaunch ? 0.055 : 0.035;
    // nets-step2 (DECISIONS §33 row 5): the can is DEEP enough to hold the cartridges of the strongest fibre (large 5, small
    // 10 nets; litres in test-NetPack): 0.24 m large, 0.16 m small. The FRONT FACE stays where it was (z 0.200 / 0.1075:
    // the old can was 0.07 / 0.05 m tall about the same face), so the extra length runs back inside her body (back ends
    // z -0.040 / -0.0525, body half-lengths 0.15 / 0.075), hidden behind the end cap. The radius cannot grow (the fore
    // thruster box is placed from it).
    const canH = isWeaverLaunch ? 0.24 : 0.16;
    const canHOld = isWeaverLaunch ? 0.07 : 0.05;
    const canGeo = new THREE.CylinderGeometry(canR * M, canR * M, canH * M, 48, 1, false);
    const canMat = new THREE.MeshStandardMaterial({ ...AVIONICS_GUNMETAL });   // matches mother (SSOT recipe)
    const canister = new THREE.Mesh(canGeo, canMat);
    const cellFaceZ = bz * 0.55 * M + (canHOld * M) / 2;   // the front face: unchanged by the deeper can
    const canCz = cellFaceZ - (canH * M) / 2;              // housing centre z (fore centreline)
    canister.position.set(0, 0, canCz);
    canister.rotation.x = Math.PI / 2;           // cylinder axis → +Z
    canister.name = `${this.id}-net-launcher`;
    this.mesh.add(canister);

    // Front-face magazine cells (front face = housing centre + half-length in +Z): drawn by _buildNetCells from
    // netCellLayout, one round bore per net (start tier: 2 large / 4 small; 3-5 and 6-10 after the fibre upgrade).

    // Net-launch MUZZLE (SSOT, net-canister continuity fix): the launcher
    // housing's front face on the fore centreline — the same plane the
    // magazine cells sit on, captured from the SAME variables that place the
    // `${id}-net-launcher` mesh above (canCz + canH·M/2), so the launch /
    // net-tether anchor can never drift from the visible hardware. Read back
    // in world space via getNetMuzzleWorldInto(). Scene units, mesh-local.
    this._netMuzzleLocal = new THREE.Vector3(0, 0, cellFaceZ);
    // v10-look-r5 D3: the mother launcher's white disc + gunmetal lip, scaled to the can. Disc = can R - 6 mm (weaver)
    // / - 3 mm (spinner), top 1 mm proud of the front face; the lip ring stands 2 mm / 1.5 mm above the disc top, so the
    // white reads inset. Bores and caps are lifted by the disc's 1 mm. The muzzle (_netMuzzleLocal) is unchanged.
    const discR = (canR - (isWeaverLaunch ? 0.006 : 0.003)) * M;
    const lipH = (isWeaverLaunch ? 0.002 : 0.0015) * M;
    const DISC_TOP = 0.001 * M;
    const discMat = new THREE.MeshStandardMaterial({ ...AVIONICS_THERMAL_WHITE, metalness: 0.0, roughness: 0.8 });   // cap white, matte, not emissive
    const disc = new THREE.Mesh(new THREE.LatheGeometry([                 // top + side only (underside buried, never seen)
      new THREE.Vector2(discR, -0.001 * M), new THREE.Vector2(discR, DISC_TOP), new THREE.Vector2(0, DISC_TOP),
    ], 48), discMat);   // r 35-55 mm -> 48 around (test-RoundParts radius rule)
    disc.position.set(0, 0, cellFaceZ);
    disc.rotation.x = Math.PI / 2;                                        // lathe axis +Y -> +Z (fore)
    disc.name = `${this.id}-DNetDisc`;
    disc.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.mesh.add(disc);
    const lip = new THREE.Mesh(new THREE.LatheGeometry([
      new THREE.Vector2(canR * M, -0.001 * M), new THREE.Vector2(canR * M, DISC_TOP + lipH),
      new THREE.Vector2(discR + 0.001 * M, DISC_TOP + lipH), new THREE.Vector2(discR + 0.001 * M, -0.001 * M),
    ], 48), canMat);
    lip.position.set(0, 0, cellFaceZ);
    lip.rotation.x = Math.PI / 2;
    lip.name = `${this.id}-DNetLip`;
    lip.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.mesh.add(lip);
    const boreMat = new THREE.MeshStandardMaterial({ ...AVIONICS_DARK_OPTIC });    // dark bore (matches mother)
    const capMat = new THREE.MeshStandardMaterial({ ...AVIONICS_THERMAL_WHITE });  // pale Dyneema cap (matches mother)
    this._netCan = { canR, cellFaceZ, DISC_TOP, boreMat, capMat };
    this._netCellMeshes = [];
    this._netCellGeos = [];
    this._netCellCaps = [];
    this._buildNetCells(cellCount);

    // Inventory wiring — the daughter net emits use TWO field shapes: CaptureNet
    // emits {remaining}, ArmUnit's own set/decrement/reload emit {nets}. Accept
    // BOTH (PAYLOAD SHAPE WART — unifying is a follow-up SSOT cleanup, not here).
    this._onNetInventoryChanged = (p) => {
      if (!p || p.source !== 'daughter' || p.armIndex !== this.index) return;
      const n = (p.remaining ?? p.nets) ?? 0;
      this._syncNetCells(n);
    };
    eventBus.on(Events.NET_INVENTORY_CHANGED, this._onNetInventoryChanged);


    // --- v7-daughters D3: one whip antenna on a base puck at the fore cap's -X corner,
    // beside the net launcher (puck edge >= 4 mm clear of the launcher housing wall).
    // Both are CULL-listed inert detail (suffixes '-antenna', '-antenna-puck').
    {
      const puckR = (isWeaver ? 0.012 : 0.007) * M;
      const puckH = 0.006 * M;
      const puckX = -(isWeaver ? 0.075 : 0.047) * M;     // centre: edge is 5-6 mm off the launcher wall (canR)
      const whipR = 0.003 * M;                           // Ø6 mm
      const whipL = (isWeaver ? 0.08 : 0.05) * M;
      const puckMat = new THREE.MeshStandardMaterial({ color: 0xccccdd, metalness: 0.9, roughness: 0.2 });
      const puck = new THREE.Mesh(new THREE.CylinderGeometry(puckR, puckR, puckH, 24), puckMat);
      puck.position.set(puckX, 0, halfLen + puckH / 2 - puckH * 0.2);   // base sunk 20 % into the cap
      puck.rotation.x = Math.PI / 2;
      puck.name = `${this.id}-antenna-puck`;
      puck.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      this.mesh.add(puck);
      const whip = new THREE.Mesh(new THREE.CylinderGeometry(whipR, whipR, whipL, 12),
        new THREE.MeshStandardMaterial({ color: 0xb4b8c2, metalness: 0.8, roughness: 0.3 }));
      whip.position.set(puckX, 0, halfLen + puckH * 0.8 + whipL / 2);
      whip.rotation.x = Math.PI / 2;
      whip.name = `${this.id}-antenna`;
      whip.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      this.mesh.add(whip);
    }

    // --- Laser power receiver (top face) — a small optical rectenna, NOT a
    // solar array. A round photodiode recessed inside a short metallic housing.
    const rxR = (isWeaver ? 0.045 : 0.030) * M;   // receiver disc radius (small)
    // §2-followup (round 18): earlier versions used a FLAT ring + disc that
    // either z-fought the facet (coplanar) or, when lifted clear, looked like
    // they FLOATED above the hull. Fix: the bezel is now a real 3-D ring HOUSING
    // (a short open cylinder wall) that RISES from the facet — its base sits on
    // the body, so nothing floats — and the diode is recessed at the bottom of
    // that well. Because the wall has real height (perpendicular to the facet),
    // no surface is coplanar with the body, so there is no z-fight at any zoom.
    const facetY = (bx / 2) * M;                  // +Y facet plane (apothem)
    const houseOR = rxR * 1.35;                   // housing outer radius
    const houseH  = rxR * 0.6;                    // housing wall height (proud of facet)

    // Bezel housing: open cylinder wall, base on the facet, rising +Y.
    const rxBezelGeo = new THREE.CylinderGeometry(houseOR, houseOR, houseH, 48, 1, true);
    const rxBezelMat = new THREE.MeshStandardMaterial({
      color: 0x777788, metalness: 0.9, roughness: 0.25, side: THREE.DoubleSide,
    });
    const rxBezel = new THREE.Mesh(rxBezelGeo, rxBezelMat);
    // Sink the base slightly into the facet so the wall reads as embedded in the
    // hull (grounded, not floating) and its bottom edge isn't exactly coplanar.
    rxBezel.position.set(0, facetY + houseH / 2 - houseH * 0.2, 0);
    rxBezel.name = `${this.id}-laser-rx-bezel`;
    rxBezel.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.mesh.add(rxBezel);

    // Dark optical receiver face (the diode) recessed at the base of the well.
    const rxGeo = new THREE.CircleGeometry(rxR, 48);
    const rxMat = new THREE.MeshStandardMaterial({
      color: 0x1a0e02, metalness: 0.35, roughness: 0.2,
      emissive: 0x140a00, emissiveIntensity: 0.18,  // warm 808nm-receiver tint
    });
    const pvPanel = new THREE.Mesh(rxGeo, rxMat);
    pvPanel.position.set(0, facetY + houseH * 0.4, 0);  // recessed inside the housing
    pvPanel.rotation.x = -Math.PI / 2;
    pvPanel.name = `${this.id}-laser-rx`;
    pvPanel.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.mesh.add(pvPanel);

    // --- S3.5: MRR patch antenna — a thin 3-D puck (has thickness, so it is
    // grounded to the facet and never coplanar with it). ---
    const mrrR = (isWeaver ? 0.015 : 0.010) * M;
    const mrrH = mrrR * 0.4;                       // puck thickness
    const mrrGeo = new THREE.CylinderGeometry(mrrR, mrrR, mrrH, 24);   // was 6-seg (w1-ship-polish D2)
    const mrrMat = new THREE.MeshStandardMaterial({
      color: 0xccccdd, metalness: 0.95, roughness: 0.15,
    });
    const mrr = new THREE.Mesh(mrrGeo, mrrMat);
    // §2-followup (round 18): base sunk slightly into the facet so the puck sits
    // ON the hull with real thickness — grounded, no float, no coplanar tie.
    mrr.position.set(bx * 0.25 * M, facetY + mrrH / 2 - mrrH * 0.25, -bz * 0.20 * M);
    mrr.name = `${this.id}-mrr-patch`;
    mrr.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.mesh.add(mrr);

    // --- Status light (blinks to show state) ---
    const lightGeo = new THREE.SphereGeometry(0.010 * M, 24, 12);  // was 0.015 (Batch 1 shrink); 8×6 → 16×12 (w1-ship-polish D2)
    this._statusLightMat = new THREE.MeshBasicMaterial({ color: 0x00ff44 });
    const statusLight = new THREE.Mesh(lightGeo, this._statusLightMat);
    statusLight.position.set(0, by * 0.55 * M, -bz * 0.3 * M);
    statusLight.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE; // FIX_PLAN §2-followup
    this.mesh.add(statusLight);
    // Additive glow halo so the state light reads as an alive lamp, not a painted
    // dot. Built via the shared makeLightHalo factory (same recipe as the Mother's
    // nav/dock halos). Colour + opacity track the core in _updateStatusLight (the
    // per-state hex already encodes the blink bright/dim phase, so it breathes).
    // Size/opacity from Constants.LIGHT_FX (Batch 1 light-shrink SSOT).
    this._statusLightHalo = makeLightHalo(
      0x00ff44, Constants.LIGHT_FX.STATUS_HALO * M, 1.8, Constants.LIGHT_FX.STATUS_HALO_OPACITY);
    statusLight.add(this._statusLightHalo);

    // v7-daughters D5: gunmetal housing (a short bezel wall) round the lens sphere so the lamp sits in a
    // fitting instead of floating on the hull. The lens, its material and the halo above are untouched.
    {
      const hr = 0.014 * M;
      const yBot = (bx / 2) * M - 0.002 * M;                 // sunk 2 mm into the +Y facet
      const yTop = statusLight.position.y + 0.002 * M;       // lens stands proud of the rim
      // Spinner: the lamp sits only 45 mm from the receiver axis, so a full Ø28 mm ring would cut ~9.5 mm into
      // the receiver bezel (outer r houseOR). There the housing is a hood: only the arc >= 1.2 mm outside the
      // bezel is kept (the side facing the receiver is open). Weaver clears it, so it keeps the full ring.
      const dC = Math.hypot(statusLight.position.x, statusLight.position.z);   // lamp -> receiver axis (plan)
      const need = houseOR + 0.0012 * M;
      let arcStart = 0, arcLen = Math.PI * 2;
      if (dC - hr < need) {
        // keep points where |c + hr u|^2 >= need^2 ; u makes angle phi with the direction away from the receiver
        const cosPhi = (need * need - dC * dC - hr * hr) / (2 * dC * hr);
        const phi = Math.acos(Math.min(1, Math.max(-1, cosPhi)));
        arcLen = 2 * phi;
        arcStart = (statusLight.position.z < 0 ? Math.PI : 0) - phi;   // arc centred on the -Z (aft) side
      }
      const housing = new THREE.Mesh(
        new THREE.CylinderGeometry(hr, hr, yTop - yBot, 24, 1, true, arcStart, arcLen),
        new THREE.MeshStandardMaterial({ ...AVIONICS_GUNMETAL, side: THREE.DoubleSide }));
      housing.position.set(statusLight.position.x, (yTop + yBot) / 2, statusLight.position.z);
      housing.name = `${this.id}-status-housing`;
      housing.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      this.mesh.add(housing);
    }

    // --- S3.4: EPM docking collar (replaces flat dock plate) ---
    const epmR = (isWeaver ? 0.025 : 0.020) * M;
    const epmH = (isWeaver ? 0.015 : 0.012) * M;
    const epmHousing = new THREE.Mesh(
      new THREE.CylinderGeometry(epmR, epmR, epmH, 48),   // was 8-seg; housing = pole ring (D3)
      new THREE.MeshStandardMaterial({ color: 0x606068, metalness: 0.85, roughness: 0.40 })
    );
    epmHousing.position.y = -by * 0.52 * M;
    epmHousing.name = `${this.id}-epm-housing`;
    this.mesh.add(epmHousing);

    // EPM pole face ring (AlNiCo — cloned mat per arm for independent emissive)
    const poleOR = (isWeaver ? 0.025 : 0.020) * M;
    const poleIR = (isWeaver ? 0.0125 : 0.010) * M;
    this._epmPoleMat = new THREE.MeshStandardMaterial({
      color: 0xbbaa55, metalness: 0.75, roughness: 0.25,
      emissive: 0x000000, emissiveIntensity: 0.0, side: THREE.DoubleSide,
    });
    const epmPole = new THREE.Mesh(
      new THREE.RingGeometry(poleIR, poleOR, 48, 1),   // was 8-seg; matches the EPM housing (D3)
      this._epmPoleMat
    );
    epmPole.position.y = -by * 0.52 * M - epmH * 0.51;
    epmPole.rotation.x = Math.PI / 2;
    epmPole.name = `${this.id}-epm-pole`;
    this.mesh.add(epmPole);

    // Aft pusher plate (17-4PH stainless — spring contact surface)
    const pushR = (isWeaver ? 0.025 : 0.018) * M;
    const pushH = M * 0.003;
    const pusher = new THREE.Mesh(
      new THREE.CylinderGeometry(pushR, pushR, pushH, 48),   // was 6-seg (w1-ship-polish D2)
      new THREE.MeshStandardMaterial({ color: 0x777788, metalness: 0.78, roughness: 0.32 })
    );
    // FIX_PLAN §2-followup: nudged forward to z=-bz*0.505 so pusher disc no
    // longer shares the aft-nozzle base plane at z=-bz*0.52 (was z-fight).
    pusher.position.set(0, 0, -bz * 0.505 * M);                          // FIX_PLAN §2-followup
    pusher.rotation.x = Math.PI / 2;
    pusher.name = `${this.id}-pusher-plate`;
    pusher.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;       // FIX_PLAN §2-followup
    this.mesh.add(pusher);

    // --- S3.6: Wishbone bridle (gimbal ring + Y-fork legs + hardpoints) ---
    // 2× wishbone hardpoints at ±X (supersedes §13.4.5 3× tripod)
    const bGeo = _ensureSharedBridleGeo();
    const gimbalMat = new THREE.MeshStandardMaterial({ color: 0x8899aa, metalness: 0.75, roughness: 0.30 });
    const gimbalRing = new THREE.Mesh(isWeaver ? bGeo.gimbalW : bGeo.gimbalS, gimbalMat);
    gimbalRing.position.set(0, by * 0.70 * M, 0);
    gimbalRing.rotation.x = Math.PI / 2;
    gimbalRing.name = `${this.id}-gimbal-ring`;
    this.mesh.add(gimbalRing);
    this._gimbalRing = gimbalRing;

    const hpMat = new THREE.MeshStandardMaterial({ color: 0x8899aa, metalness: 0.72, roughness: 0.28 });
    const hpA = new THREE.Mesh(bGeo.hpSphere, hpMat);
    hpA.position.set(bx * 0.45 * M, by * 0.30 * M, 0);
    hpA.name = `${this.id}-bridle-hp-A`;
    this.mesh.add(hpA);
    const hpB = new THREE.Mesh(bGeo.hpSphere, hpMat);
    hpB.position.set(-bx * 0.45 * M, by * 0.30 * M, 0);
    hpB.name = `${this.id}-bridle-hp-B`;
    this.mesh.add(hpB);
    this._bridleHpA = hpA;
    this._bridleHpB = hpB;

    const bridleLegMat = new THREE.LineBasicMaterial({ color: 0xccccdd, transparent: true, opacity: 0.85 });
    const legAGeo = new THREE.BufferGeometry();
    legAGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      0, by * 0.70 * M, 0,  bx * 0.45 * M, by * 0.30 * M, 0
    ]), 3));
    const legA = new THREE.Line(legAGeo, bridleLegMat);
    legA.name = `${this.id}-bridle-leg-A`;
    legA.visible = false;
    legA.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_CONNECTOR; // §2-followup (round 4)
    this.mesh.add(legA);

    const legBGeo = new THREE.BufferGeometry();
    legBGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      0, by * 0.70 * M, 0,  -bx * 0.45 * M, by * 0.30 * M, 0
    ]), 3));
    const legB = new THREE.Line(legBGeo, bridleLegMat);
    legB.name = `${this.id}-bridle-leg-B`;
    legB.visible = false;
    legB.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_CONNECTOR; // §2-followup (round 4)
    this.mesh.add(legB);

    this._bridleLegA = legA;
    this._bridleLegB = legB;
    this._bridleLegMat = bridleLegMat;

    // Wave1: pooled attitude cold-gas puffs (discrete-event only, ≤4 sprites).
    this._buildAttitudePuffPool(bx, bz);

    // Detail-LOD cull set (Phase 6): collect inert daughter hardware by name
    // suffix. Excludes body, status light + halo, plumes (aft AND fore — both
    // are communicative "she is alive" reads whose halos carry per-type ID at
    // range), attitude puffs (transient, invisible by default), tether, bridle
    // legs (communicative / connector). Only sub-pixel-at-distance detail is
    // listed.
    this._collectDetailMeshes();

    // Start hidden (docked = part of core visually)
    this.mesh.visible = false;
  }

  /**
   * @private — Gather inert daughter hardware into `_detailMeshes` for the
   * distance LOD cull. Selected by the `${id}-` name suffix so it's auditable.
   */
  _collectDetailMeshes() {
    const CULL_SUFFIXES = [
      '-panel-lines', '-mrr-patch', '-epm-housing', '-epm-pole', '-gimbal-ring',
      '-bridle-hp-A', '-bridle-hp-B', '-feep-aft-boss', '-antenna', '-antenna-puck',
    ];
    this._detailMeshes.length = 0;
    if (!this.mesh) return;
    this.mesh.traverse((o) => {
      if (!(o.isMesh || o.isLine) || !o.name) return;   // isLine covers panel-lines
      if (CULL_SUFFIXES.some((s) => o.name.endsWith(s))) this._detailMeshes.push(o);
    });
  }

  /**
   * Feed the live camera→craft distance (SCENE UNITS) so inert detail is hidden
   * when far. Flip applied only on hysteresis-threshold crossing (state change).
   * @param {number} distSceneUnits
   */
  setCameraDistance(distSceneUnits) {
    this._detailHidden = applyDetailLod(distSceneUnits, this._detailMeshes, this._detailHidden);
  }

  /**
   * @private Wave1 — Build the daughter's pooled cold-gas attitude puffs.
   *
   * Mirrors the mother's `_buildRcsPuffPool` pattern at daughter scale:
   * pooled sprites, round-robin reuse, additive soft-glow texture (headless-
   * safe null), depthTest ON so the hull occludes them. STRICT BUDGET:
   * exactly DAUGHTER_PLUME.PUFF_POOL_SIZE (4) sprites per daughter, bursts
   * fire PUFF_BURST_COUNT (2), and nothing here allocates per frame — ports,
   * pool entries, and their vectors are built once.
   *
   * Doctrine (BIG_PICTURE Part IV): cold gas = brief dim puffs, not flames.
   * Fired ONLY on discrete attitude events (deploy separation, SK entry,
   * tool-cycle re-aim, dock settle) — see _fireAttitudePuffs call sites.
   *
   * @param {number} bx body X dim (m) — facet apothem = bx/2
   * @param {number} bz body Z dim (m)
   */
  _buildAttitudePuffPool(bx, bz) {
    const tex = getRadialGlowTexture({ size: 32 });
    const apo = (bx / 2) * M;          // side-facet plane (same as the RX facetY)
    const portZ = bz * 0.25 * M;       // fore of centre — reads as an attitude couple

    // 4 fixed virtual RCS ports on the side facets (±X yaw pair, ±Y pitch pair).
    // Gas drifts OUTWARD along the facet normal. Positions/dirs are mesh-local
    // and frozen — visuals only, never a force on the arm.
    this._attPuffPorts = [
      { pos: new THREE.Vector3( apo, 0, portZ), dir: new THREE.Vector3( 1, 0, 0) },
      { pos: new THREE.Vector3(-apo, 0, portZ), dir: new THREE.Vector3(-1, 0, 0) },
      { pos: new THREE.Vector3(0,  apo, portZ), dir: new THREE.Vector3(0,  1, 0) },
      { pos: new THREE.Vector3(0, -apo, portZ), dir: new THREE.Vector3(0, -1, 0) },
    ];

    // reel-gas: the braking jet's port - the tail (-Z, which faces the mother on the tail-first reel), firing straight aft.
    this._gasPuffPort = { pos: new THREE.Vector3(0, 0, -(bz / 2) * M), dir: new THREE.Vector3(0, 0, -1) };

    for (let i = 0; i < DAUGHTER_PLUME.PUFF_POOL_SIZE; i++) {
      const mat = new THREE.SpriteMaterial({
        map: tex || null,
        color: 0xcfe0ff,   // cool cold-gas (N₂) white-blue — same read as the mother
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        depthTest: true,   // hull occludes puffs (mother's hard-won fix)
      });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(M * 0.015, M * 0.015, M * 0.015);
      sprite.visible = false;
      sprite.name = `${this.id}-att-puff-${i}`;
      sprite.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;
      this.mesh.add(sprite);
      this._attPuffs.push({
        sprite, active: false, startTime: 0,
        startPos: new THREE.Vector3(), dir: new THREE.Vector3(0, 1, 0),
        life: 0.24, maxScale: M * 0.08, baseOp: 0.32, drift: M * 0.16,
      });
    }
  }

  /**
   * @private Wave1 — Fire one discrete attitude burst (2 pooled sprites).
   *
   * Event kinds map to a port pair so the couple reads right:
   *   'deploy' separation trim → ±Y pair   'sk'   arrival null → ±X pair
   *   'tool'   re-aim yaw      → ±X pair   'dock' settle       → ±Y pair
   *
   * Round-robin overwrites the oldest sprite, so the live count can NEVER
   * exceed the pool size. A global cooldown keeps back-to-back transitions
   * (e.g. rapid tool cycling) from strobing.
   *
   * @param {('deploy'|'sk'|'tool'|'dock')} kind
   * @param {number} [now] seconds — injectable for tests
   */
  _fireAttitudePuffs(kind, now = performance.now() * 0.001) {
    if (!this._attPuffs.length || !this._attPuffPorts) return;
    if (now - this._attPuffLastFire < DAUGHTER_PLUME.PUFF_COOLDOWN_S) return;
    this._attPuffLastFire = now;

    const pair = (kind === 'sk' || kind === 'tool') ? [0, 1] : [2, 3];
    for (let k = 0; k < DAUGHTER_PLUME.PUFF_BURST_COUNT; k++) {
      const port = this._attPuffPorts[pair[k % pair.length]];
      const puff = this._attPuffs[this._attPuffIndex];
      this._attPuffIndex = (this._attPuffIndex + 1) % this._attPuffs.length;

      // Reuse pooled vectors — jitter of a few mm / ~8° so bursts differ.
      puff.startPos.set(
        port.pos.x + (Math.random() - 0.5) * M * 0.006,
        port.pos.y + (Math.random() - 0.5) * M * 0.006,
        port.pos.z + (Math.random() - 0.5) * M * 0.006,
      );
      puff.dir.set(
        port.dir.x + (Math.random() - 0.5) * 0.28,
        port.dir.y + (Math.random() - 0.5) * 0.28,
        port.dir.z + (Math.random() - 0.5) * 0.28,
      ).normalize();
      puff.life     = 0.18 + Math.random() * 0.10;         // 0.18–0.28 s — brief
      puff.maxScale = M * (0.06 + Math.random() * 0.04);   // expands to 6–10 cm
      puff.baseOp   = 0.28 + Math.random() * 0.12;         // dim, translucent
      puff.drift    = M * (0.12 + Math.random() * 0.08);   // 12–20 cm free jet
      puff.startTime = now - k * 0.012;                    // tiny stagger

      puff.sprite.position.copy(puff.startPos);
      puff.sprite.material.opacity = 0;
      puff.sprite.scale.set(M * 0.015, M * 0.015, M * 0.015);
      puff.sprite.visible = true;
      puff.active = true;
    }
  }

  /**
   * @private Wave1 — Animate active attitude puffs (free-jet drift, √t
   * expansion, rise-then-decay fade — the mother's cold-gas math at daughter
   * scale, minus the sun-scatter garnish). Early-outs on inactive entries:
   * steady-state cost is a 4-iteration flag check.
   * @param {number} [now] seconds — injectable for tests
   */
  _updateAttitudePuffs(now = performance.now() * 0.001) {
    for (const puff of this._attPuffs) {
      if (!puff.active) continue;
      const age = now - puff.startTime;
      const life = puff.life || 0.24;
      if (age >= life) {
        puff.sprite.visible = false;
        puff.sprite.material.opacity = 0;
        puff.active = false;
        continue;
      }
      const t = age / life;
      puff.sprite.position.copy(puff.startPos).addScaledVector(puff.dir, puff.drift * t);
      const startS = M * 0.015;
      const s = startS + (puff.maxScale - startS) * Math.sqrt(t);
      puff.sprite.scale.set(s, s, s);
      const rise = Math.min(1, t / 0.1);
      const fall = Math.pow(1 - t, 1.5);
      puff.sprite.material.opacity = Math.min(0.85, puff.baseOp * rise * fall);
    }
  }


  /** @private Create tether line geometry */
  _createTether() {
    const segments = Constants.TETHER_SEGMENTS;
    const positions = new Float32Array(segments * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    // Item 11 (2026-06-12): SOLID gradient line (was LineDashedMaterial).
    // Per-vertex colors make the cable read as a lit line — bright at the
    // strut anchor (vertex 0) fading toward the daughter — instead of a 1 px
    // dashed line that read as broken. The REELING motion cue is now a
    // brightness pulse traveling anchor-ward (see _updateTether), replacing
    // the old dash-phase scroll; computeLineDistances is no longer needed.
    const colors = new Float32Array(segments * 3);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.tetherMaterial = new THREE.LineBasicMaterial({
      color: Constants.TETHER_COLOR_NOMINAL,   // state tint (multiplies vertex colors)
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
    });
    // Static base gradient: anchor-bright (1.0) → daughter-dim (0.35).
    this.tetherLine = new THREE.Line(geometry, this.tetherMaterial);
    this.tetherLine.visible = false;
    this.tetherLine.frustumCulled = false;
    // §2-followup (round 4): the tether bridges the (separate) daughter and
    // mother objects. Untagged, its transparent line sorted by raw depth and
    // flickered in front of/behind the strut + reel point. CONNECTOR band draws
    // it just above solid hull geometry so it lies cleanly on the craft.
    this.tetherLine.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_CONNECTOR;
    this.group.add(this.tetherLine);
    this._tetherWriteGradient(-1);
  }

  /**
   * @private Item 11: write the per-vertex brightness gradient.
   * Base ramp: 1.0 at the anchor (vertex 0) → 0.35 at the daughter. During
   * REELING a gaussian brightness pulse travels toward the anchor (decreasing
   * t) as the motion cue; `pulsePhase` ∈ [0,1) is the pulse centre (1 = at
   * daughter, 0 = at anchor). Pass a negative phase for "no pulse".
   */
  _tetherWriteGradient(pulsePhase = -1) {
    if (!this.tetherLine) return;
    const colorAttr = this.tetherLine.geometry.attributes.color;
    if (!colorAttr) return;
    const arr = colorAttr.array;
    const segments = Constants.TETHER_SEGMENTS;
    for (let i = 0; i < segments; i++) {
      const t = i / (segments - 1);            // 0 = anchor, 1 = daughter
      let b = 1.0 - 0.65 * t;                  // base ramp 1.0 → 0.35
      if (pulsePhase >= 0) {
        const d = t - pulsePhase;
        b += 0.9 * Math.exp(-(d * d) / (2 * 0.06 * 0.06));   // traveling pulse
        if (b > 1.6) b = 1.6;
      }
      const idx = i * 3;
      arr[idx] = b; arr[idx + 1] = b; arr[idx + 2] = b;
    }
    colorAttr.needsUpdate = true;
  }

  // ==========================================================================
  // SHOP UPGRADES
  // ==========================================================================

  /**
   * Apply a shop upgrade override to this arm's config.
   * Called by ArmManager.applyUpgrade() and ArmManager._reapplyStoredUpgrades().
   * @param {string} effect - Upgrade effect key
   * @param {number} value - Upgrade value
   */
  applyUpgradeOverride(effect, value) {
    switch (effect) {
      case 'tetherRange':
        // Multiply tether max length (e.g., 2.0 = 2× range)
        // Use base constant to avoid compounding on re-apply
        // Register item 101 (2026-08-21): the `long_tether` shop card is
        // RETIRED — this handler stays as the replay shim so a pre-retirement
        // save keeps its purchased reach (the tier ladder owns the track now).
        this.config.tetherMax = (this.type === 'weaver'
          ? Constants.WEAVER_TETHER_LENGTH : Constants.SPINNER_TETHER_LENGTH) * value;
        break;
      case 'reelSpeed':
        // Multiply approach/haul speed (e.g., 1.5 = 50% faster)
        this.config.approachSpeed = Constants.ARM_APPROACH_SPEED * value;
        this.config.haulSpeed = Constants.ARM_HAUL_SPEED * value;
        break;
      case 'armFuelMax': {
        // Multiply max fuel (e.g., 1.5 = 50% more FEEP fuel)
        // Refill proportionally to the increase
        const baseFuelMax = 100;
        const newMax = baseFuelMax * value;
        if (this.fuel === baseFuelMax) {
          this.fuel = newMax; // full tank → fill to new max
        }
        // Note: fuel is a percentage 0-100, so we scale the captures-per-fuel instead
        this.config.capturesPerFuel = Math.round(
          (this.type === 'weaver' ? Constants.WEAVER_CAPTURES_PER_FUEL : Constants.SPINNER_CAPTURES_PER_FUEL) * value
        );
        break;
      }
      case 'captureRate':
        // Increase capture success rate (value is additive, e.g., 0.2 = +20%)
        this.config.captureSuccessRate = Math.min(1.0, 0.85 + value);
        break;
      case 'autoDock':
        // Reduce docking time multiplier (value=0.5 → half dock time)
        this.config.dockSpeedMultiplier = 1.0 / value; // 0.5 → 2× faster
        break;
      // --- V4 GSL upgrades (Sprint D5) ---
      case 'v4TetherRange':
        // V4 GSL tether: 6.25× reach (12.5km)
        // Register item 101 (2026-08-21): the `gsl_tether_v4` shop card is
        // RETIRED — 12.5 km out-reached the ladder top (T5 GSL-100 10 km) and
        // a later tier purchase silently lowered it. Handler stays as the
        // replay shim so an owned save keeps its reach.
        this.config.tetherMax = (this.type === 'weaver'
          ? Constants.WEAVER_TETHER_LENGTH : Constants.SPINNER_TETHER_LENGTH) * value;
        break;
      case 'v4NetArea': {
        // V4 GSL net: sqrt(10)× radius for 10× area
        const baseNet = this.type === 'weaver' ? Constants.WEAVER_NET_SIZE : Constants.SPINNER_NET_SIZE;
        this.config.netSize = baseNet * value;
        break;
      }
      case 'v4GripForce':
        // V4 electrostatic: 160N grip → can hold heavier debris
        this.config.maxCaptureMass = (this.type === 'weaver'
          ? Constants.WEAVER_MAX_CAPTURE_MASS : Constants.SPINNER_MAX_CAPTURE_MASS) * value;
        break;
    }
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  /**
   * @private Item 5a (2026-06-12): post a HintTicker entry for a deploy
   * refusal so the next action lands on the bottom strip, not just a
   * scrolling comms line. One id per cause — HintTicker coalesces repeats.
   */
  _postDeployRefusalHint(cause, text) {
    eventBus.emit(Events.HINT_POSTED, {
      id: `deploy_refused_${cause}`,
      text,
      glyph: '!',
      keys: [],
      skillId: null,
      duration: 10000,
      priority: 'normal',
    });
  }

  /**
   * Deploy this arm toward a target debris.
   * @param {object} target - Debris object with ._scenePosition and .id
   * @returns {boolean} true if deployment started
   */
  deploy(target) {
    if (this.state !== S.DOCKED) return false;
    // V5: Spring must be charged to deploy
    // Item 5a (2026-06-12): every refusal ALSO posts a HintTicker entry naming
    // the next verb — a scrolling comms line alone is easy to miss in the
    // learning missions ("every refusal names the next verb").
    if (!this.springCharged) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Spring not charged. Reloading`,
        priority: 'warning',
      });
      this._postDeployRefusalHint('spring', 'Spring reloading. Wait for charge, or deploy another daughter [1-4]');
      return false;
    }
    if (this.fuel <= 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: No fuel remaining`,
        priority: 'warning',
      });
      this._postDeployRefusalHint('fuel', 'Daughter out of fuel. Deploy another [1-4] or refuel');
      return false;
    }
    if (target.mass && target.mass > this.config.maxCaptureMass) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Target too massive (${target.mass}kg > ${this.config.maxCaptureMass}kg)`,
        priority: 'warning',
      });
      this._postDeployRefusalHint('mass', 'Target too massive for this daughter. Pick a lighter one [T]');
      return false;
    }
    this.target = target;
    this._fuelAtDeploy = this.fuel;         // Track for efficiency scoring
    this._startingDistance = 0;             // Phase 8: reset for approach beep fraction
    this._smoothDriftVel = null;            // Reset EMA-smoothed drift for fresh approach
    this._prevTargetScenePos = null;        // Reset stale target position from previous mission

    // V5: Compute launch direction toward target
    const tPos = this._getTargetScenePos();
    if (tPos) {
      const distToTarget = tPos.distanceTo(this.position) / M;
      // Guard: refuse deployment when target is beyond operational range.
      // Register item 100 (2026-08-21): the gate is tether-tier-aware —
      // tetherMax × ARM_DEPLOY_RANGE_FRACTION (0.8), replacing the pre-GSL
      // literal min(500, tetherMax × 0.5). The daughter autopilot is
      // range-scale-invariant (quadratic braking; braking distance 2v² —
      // 1.25 km at 25 m/s) and its fuel is impulse-priced, so range costs
      // transit time, not tank. The 0.8 keeps 0.15 of slack to the 0.95×
      // tether-limit recall guard. At T5 GSL-100 the weaver radius is 8 km —
      // the 16 km wide-sweep doctrine (item 76(d), owner-ruled).
      const maxDeployRange = this.config.tetherMax * Constants.ARM_DEPLOY_RANGE_FRACTION;
      if (distToTarget > maxDeployRange) {
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.displayName}: Target ${Math.round(distToTarget)}m away (max ${Math.round(maxDeployRange)}m). Press A to autopilot closer first.`,
          priority: 'warning',
        });
        this._postDeployRefusalHint('range', 'Target out of daughter range. Press [A] to autopilot closer first');
        this.target = null;
        return false;
      }
      // Aim-before-launch: when the aim ceremony rotated the Mother + slewed
      // this strut to the target, fire along the PHYSICAL strut-tip direction
      // (shared SSOT with the rendered strut pose). Any residual aim error is
      // intentional — the TRANSIT FEEP controller corrects it in flight.
      //
      // Non-ceremony deploy paths (deployArmByIndex / deployAllToTarget /
      // deploySpecificArm) never slew _aimAlpha toward the target, so firing
      // along the (stowed) strut would launch the wrong way. Fall back to the
      // direct target bearing for those, preserving pre-aim behavior.
      if (this._aimConverged) {
        const az = Math.atan2(this.dockOffset.y, this.dockOffset.x);
        const strutLocal = strutLocalDirection(this._aimAlpha, az, new THREE.Vector3());
        if (this._lastParentQuat) strutLocal.applyQuaternion(this._lastParentQuat);
        this.launchDirection = strutLocal.normalize();
      } else {
        this.launchDirection = tPos.clone().sub(this.position).normalize();
      }
      this._aimConverged = false;
    } else {
      // Fallback: deploy outward along world-space dock direction (§4.6 fix)
      this.launchDirection = this._worldDockDirection(this._lastParentQuat);
    }

    // V5: Use LAUNCHING state (crossbow spring release)
    this._transitionTo(S.LAUNCHING);
    this._undockTimer = 0;
    this._springFired = false;
    this._dockWorldPos = this.position.clone();

    // launch-seq: no launch line here — she is only clamped now; the one line is
    // "Spring released. Separating" at ARM_SPRING_FIRED (see _updateLaunching).
    eventBus.emit(Events.ARM_DEPLOYED, {
      armId: this.id, type: this.type, targetId: target.id,
    });
    return true;
  }

  /**
   * launch-aim: when the launch gate has aimed this strut (`_aimConverged`, set by
   * ArmManager right before `fire()` with FEATURE_FLAGS.LAUNCH_AIMS_STRUT on), the spring pushes
   * along the live strut axis (world frame) instead of the direction the caller derived.
   * Consumes the flag, as `deploy()` does. No-op with the switch off.
   * @private
   */
  _takeStrutAxisLaunchDirection() {
    if (!Constants.FEATURE_FLAGS.LAUNCH_AIMS_STRUT || !this._aimConverged) return;
    const az = Math.atan2(this.dockOffset.y, this.dockOffset.x);
    const axis = strutLocalDirection(this._aimAlpha, az, new THREE.Vector3());
    if (this._lastParentQuat) axis.applyQuaternion(this._lastParentQuat);
    this.launchDirection = axis.normalize();
    this._aimConverged = false;
  }

  /**
   * Deploy this arm in free-fly mode (no target).
   * Goes through LAUNCHING → TRANSIT with manual pilot control.
   * Used by number key deploy when no target is selected.
   * @returns {boolean}
   */
  deployFreefly() {
    if (this.state !== S.DOCKED) return false;
    // V5: Spring must be charged to deploy
    // Phase 0.5 (capture-feedback overhaul): refusal parity with deploy() —
    // every refusal also posts a HintTicker entry naming the next verb.
    // (No mass check here: free-fly has no target to weigh.)
    if (!this.springCharged) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Spring not charged. Reloading`,
        priority: 'warning',
      });
      this._postDeployRefusalHint('spring', 'Spring reloading. Wait for charge, or deploy another daughter [1-4]');
      return false;
    }
    if (this.fuel <= 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: No fuel remaining`,
        priority: 'warning',
      });
      this._postDeployRefusalHint('fuel', 'Daughter out of fuel. Deploy another [1-4] or refuel');
      return false;
    }
    this.target = null;
    this._trawlingMode = false;
    this._fuelAtDeploy = this.fuel;

    // V5: Launch direction = outward along world-space dock direction (§4.6 fix)
    this.launchDirection = this._worldDockDirection(this._lastParentQuat);
    // launch-aim: the launch gate aimed the strut first → the spring pushes along it.
    this._takeStrutAxisLaunchDirection();

    // V5: Use LAUNCHING state
    this._transitionTo(S.LAUNCHING);
    this._undockTimer = 0;
    this._springFired = false;
    this._dockWorldPos = this.position.clone();

    eventBus.emit(Events.ARM_DEPLOYED, {
      armId: this.id, type: this.type, mode: 'freefly',
    });
    return true;
  }

  /**
   * Deploy arm in trawling mode — slow sweep to passively collect debris.
   * @param {{ x: number, y: number, z: number }|null} direction — trawl direction
   * @returns {boolean}
   */
  deployTrawl(direction) {
    if (this.state !== S.DOCKED) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: this.displayName, text: 'Must be docked to trawl', priority: 'warning',
      });
      return false;
    }
    // V5: Spring must be charged to deploy
    if (!this.springCharged) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Spring not charged. Reloading`,
        priority: 'warning',
      });
      return false;
    }
    if (this.fuel <= 5) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: this.displayName, text: 'Insufficient fuel for trawling', priority: 'warning',
      });
      return false;
    }

    // Fallback uses world-space dock direction so trawl sweeps outward (§4.6 fix).
    this._trawlDirection = direction
      ? new THREE.Vector3(direction.x, direction.y, direction.z).normalize()
      : this._worldDockDirection(this._lastParentQuat);
    this._trawlTimer = 0;
    this._trawlingMode = true;
    this.target = null;

    // V5: Launch direction for trawling (the sweep heading `_trawlDirection` stays as passed)
    this.launchDirection = this._trawlDirection.clone();
    // launch-aim: the launch gate aimed the strut first → the spring pushes along it.
    this._takeStrutAxisLaunchDirection();

    // V5: Use LAUNCHING state
    this._transitionTo(S.LAUNCHING);
    this._undockTimer = 0;
    this._springFired = false;
    this._dockWorldPos = this.position.clone();

    eventBus.emit(Events.TRAWL_START, { armId: this.id });
    eventBus.emit(Events.ARM_DEPLOYED, { armId: this.id, type: this.type, mode: 'trawling' });

    return true;
  }

  /**
   * Fire a GSL web shot at targeted debris to increase atmospheric drag.
   * Ranged "fire and forget" — arm extends briefly toward target then returns.
   * @param {object} target - Debris object from TargetSelector with .id and ._scenePosition
   * @returns {boolean} true if web shot was initiated
   */
  fireWebShot(target) {
    // Must be IDLE (docked) to fire
    if (this.state !== S.DOCKED) return false;
    if (!target || target.id === undefined || target.id === null) return false;

    // Cooldown check
    if (this._webShotCooldown > 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Web shot cooldown. ${Math.ceil(this._webShotCooldown)}s remaining`,
        priority: 'warning',
      });
      return false;
    }

    // Fuel check
    if (this.fuel < Constants.WEB_SHOT_FUEL_COST) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Insufficient fuel for web shot`,
        priority: 'warning',
      });
      return false;
    }

    // Consume fuel for the shot
    this.fuel -= Constants.WEB_SHOT_FUEL_COST;

    // Store previous state and origin position for animation
    this._webShotPrevState = this.state;
    this._webShotTarget = target;
    this._webShotOrigin.copy(this.position);
    this._transitionTo(S.WEB_SHOT);

    // Make arm visible during shot animation
    this.mesh.visible = true;
    this.tetherLine.visible = true;

    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `${this.displayName}: 🕸 GSL web shot. Targeting ${target.id}`,
      priority: 'info',
    });

    return true;
  }

  /**
   * Recall this arm (abort mission, return to core).
   *
   * A TETHERED daughter is ALWAYS reeled home on the mothership's zero-fuel
   * strut/tether reel motor and is never abandoned as EXPENDED for low fuel —
   * her emergency FEEP reserve (if any) funds the soft-dock arrest. Only a
   * detached (severed-tether) daughter is beyond reel-in.
   *
   * fail-reel (owner 2026-10-21): a daughter flying home on her FEEP (RETURNING) is on her line too, so R winds her in
   * instead of being refused.
   * @returns {boolean|'already'} true = she is now being reeled home; 'already' = she already was (REELING);
   *   false = refused (a comms line says why: holding a catch, carrying, detached) or nothing to recall (DOCKED / EXPENDED)
   */
  recall() {
    if (this.state === S.DOCKED || this.state === S.EXPENDED) return false;

    // HOLDING_CATCH: she is already home at her strut tip and OCCUPIED with a
    // parked catch — recall is meaningless, so refuse it (player-facing, in the
    // mother-launcher's blocked-refusal idiom). The old fall-through silently
    // cleared capturedDebris with no CATCH_PROCESSED, no score, no salvage, and
    // left _armPinned/_capturedByArm/_armPinPos set on the debris: a ghost pin.
    if (this.state === S.HOLDING_CATCH) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Recall refused — holding a catch. Furnace transfer clears her.`,
        priority: 'warning',
      });
      return false;
    }
    // trip-melt-2: she is carrying a catch to a furnace — the carry ends at her dock on its own
    if (this._carry) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Recall refused — carrying a catch to a furnace. She comes home when it is done.`,
        priority: 'warning',
      });
      return false;
    }

    // Detached arms cannot be recalled — tether severed
    if (this.isDetached) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Cannot recall. Tether severed. Daughter is autonomous.`,
        priority: 'warning',
      });
      return false;
    }

    this._manualMode = false; // always exit manual on recall
    this._manualCapture = false;
    this._trawlTimer = 0; // reset trawl timer on recall
    this._trawlingMode = false;
    this._webShotTarget = null; // clear web shot state on recall

    // V5: already reeling -> nothing to do. RETURNING (FEEP flight home, e.g. after a failed catch with REEL_HOME off)
    // falls through: she is on her line, so the strut reel winds her in (fail-reel). Other states: REELING (zero-fuel return).
    if (this.state === S.REELING) return 'already';

    // STATION_KEEP has its own bookkeeping (the SK target flag, orbit rates,
    // polar-axis cache). Route through the dedicated zero-fuel strut reel so it
    // is torn down cleanly rather than left dangling on the captured debris.
    if (this.state === S.STATION_KEEP) {
      this.capturedDebris = null;
      this.target = null;
      this.reelFromStationKeep();
      eventBus.emit(Events.ARM_RECALLED, { armId: this.id });
      return true;
    }

    // The strut/tether reel motor lives on the mothership, so a TETHERED daughter
    // is ALWAYS reeled home on winch power — never abandoned as EXPENDED, even
    // when out of fuel, adrift, or stuck. Her emergency FEEP reserve (if any)
    // funds tether tension + the soft-dock arrest so she eases in rather than
    // slamming the strut.
    const lowFuel = this.fuel <= (Constants.ARM_RESERVE_FUEL ?? 2);
    this.capturedDebris = null;
    this.target = null;
    // V5: Use REELING for zero-fuel return instead of RETURNING
    this._transitionTo(S.REELING);
    if (lowFuel) {
      // Plain-language reassurance: the mother is hauling a low/empty daughter
      // home on the tether (winch power — no propellant needed).
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `Reeling ${this.displayName} home on the tether. Winch power, no FEEP needed.`,
        source: 'HOUSTON',
        channel: 'CMD',
        priority: 'info',
      });
    }
    eventBus.emit(Events.ARM_RECALLED, { armId: this.id });
    return true;
  }

  // ==========================================================================
  // TETHER DETACH (Phase 6 — Risk-Reward Redline Mechanic)
  // ==========================================================================

  /**
   * Sever the tether and enter free-flight mode.
   * Arm continues on current velocity + remaining FEEP fuel.
   * Cannot refuel, cannot recall. Must self-deorbit after capture.
   * @returns {boolean} true if detach succeeded
   */
  detach() {
    const DETACHABLE = new Set([
      S.TRANSIT, S.APPROACH, S.NETTING, S.GRAPPLED, S.ADRIFT, S.STATION_KEEP
    ]);
    if (!DETACHABLE.has(this.state)) return false;
    if (this.isDetached) return false;

    this.isDetached = true;
    this._detachFuelWarning25 = false;
    this._detachFuelWarning10 = false;

    // Sever tether — no reel-back possible
    this.tetherLength = 0;

    // Hide tether line immediately (also handled in _updateTether, but immediate is cleaner)
    if (this.tetherLine) {
      this.tetherLine.visible = false;
    }

    // Emit detach event
    eventBus.emit(Events.ARM_DETACHED, {
      armId: this.index,
      position: this.position.clone(),
      fuelRemaining: this.fuel,
      hasDebris: this.capturedDebris !== null,
    });

    // Comms callout
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `Houston: ${this.displayName}. Tether severed. COWBOY! Free-flight on own fuel.`,
      priority: 'HIGH',
    });

    console.log(`[ArmUnit] ${this.id} DETACHED (fuel: ${this.fuel.toFixed(1)}%)`);
    return true;
  }

  // ==========================================================================
  // MANUAL PILOT MODE (ARM PILOT)
  // ==========================================================================

  /** Enable manual pilot control (player takes over from autopilot) */
  enableManual() {
    if (this.state === S.DOCKED || this.state === S.EXPENDED) return;
    this._manualMode = true;
    eventBus.emit(Events.ARM_STATE_CHANGE, { armId: this.id, manual: true });
  }

  /** Disable manual control (return to autopilot) */
  disableManual() {
    this._manualMode = false;
    eventBus.emit(Events.ARM_STATE_CHANGE, { armId: this.id, manual: false });
  }

  /** @returns {boolean} Whether this arm is in manual pilot mode */
  isManual() {
    return this._manualMode;
  }

  /**
   * Apply manual thrust from ARM PILOT input.
   * Direction is in arm-local space: +Z = forward (toward target), +X = right, +Y = up.
   * @param {{ x: number, y: number, z: number }} direction - Normalized thrust direction
   * @param {boolean} fine - Fine control (Shift held) — reduced thrust
   * @param {number} dt - Delta time
   */
  applyManualThrust(direction, fine, dt) {
    if (!this._manualMode) return;
    // No usable propellant → thrusters are offline. Protect the emergency reserve
    // (held for a safe reel-home) from being burned on manual nudges. She can
    // still be reeled in on the tether — piloting just can't thrust her.
    if (this.state === S.ADRIFT || this.fuel <= (Constants.ARM_RESERVE_FUEL ?? 0)) return;

    // V5: No gamified multiplier — crossbow provides initial velocity, FEEP for corrections only
    // ST-8.3.4: Use metal-specific thrust calculation
    const thrustMag = this._computeMetalThrust();
    const thrust = fine ? thrustMag * 0.25 : thrustMag;
    const accel = thrust / this.config.mass;
    const dv = accel * dt;

    // Convert arm-local direction to world space
    // Forward: toward target (if available) or arm's current velocity direction
    let forward, up, right;
    const tPos = this._getTargetScenePos();
    if (tPos) {
      forward = tPos.clone().sub(this.position).normalize();
    } else if (this.velocity.lengthSq() > 1e-16) {
      forward = this.velocity.clone().normalize();
    } else {
      forward = new THREE.Vector3(0, 0, 1);
    }
    up = this.position.clone().normalize(); // radial up
    right = new THREE.Vector3().crossVectors(forward, up).normalize();
    up = new THREE.Vector3().crossVectors(right, forward).normalize(); // re-orthogonalize

    // Apply thrust in world space
    this.velocity.addScaledVector(right, direction.x * dv);
    this.velocity.addScaledVector(up, direction.y * dv);
    this.velocity.addScaledVector(forward, direction.z * dv);
  }

  // ══════════════════════════════════════════════════════════════════
  //  ST-8.3: FEEP Dual-Metal System
  // ══════════════════════════════════════════════════════════════════

  /**
   * Switch active FEEP propellant metal.
   * Can only switch between current and alternate slot.
   * @param {string} metalId
   * @returns {boolean} success
   */
  switchMetal(metalId) {
    const metals = Constants.ION_THRUSTER_METALS;
    if (!metals[metalId]) return false;

    // Can switch to current, alternate, or indium (default — always available)
    if (metalId !== this._currentMetal && metalId !== this._alternateMetal && metalId !== 'indium') return false;

    const oldMetal = this._currentMetal;
    this._currentMetal = metalId;

    // Update ISP based on new metal
    const metalData = metals[metalId];
    this._metalIsp = (metalData.ispMin + metalData.ispMax) / 2; // midpoint default

    // Emit event
    eventBus.emit(Events.FEEP_METAL_CHANGED, {
      armId: this.id,
      metal: metalId,
      ispRange: [metalData.ispMin, metalData.ispMax],
      thrustPerW: metalData.thrustPerW,
    });

    return true;
  }

  /**
   * Set the alternate FEEP metal slot (unlocked via Forge refining).
   * @param {string} metalId
   * @returns {boolean} success
   */
  setAlternateMetal(metalId) {
    const metals = Constants.ION_THRUSTER_METALS;
    if (!metals[metalId]) return false;
    this._alternateMetal = metalId;
    return true;
  }

  /**
   * Get the data object for the currently active FEEP metal.
   * @returns {object} metal data from ION_THRUSTER_METALS
   */
  getCurrentMetalData() {
    return Constants.ION_THRUSTER_METALS[this._currentMetal] || Constants.ION_THRUSTER_METALS.indium;
  }

  /**
   * Compute thrust from FEEP physics: thrust = P_beam / (isp × g0 × η)
   * Higher ISP = lower thrust (momentum vs efficiency tradeoff).
   * Falls back to config.thrust if ION_THRUSTER_METALS not available.
   * @returns {number} thrust in Newtons
   * @private
   */
  _computeMetalThrust() {
    const IT = Constants.ION_THRUSTER;
    if (!IT) return this.config.thrust;
    const beamPower = this.type === 'weaver' ? IT.BEAM_POWER_WEAVER : IT.BEAM_POWER_SPINNER;
    const g0 = 9.80665;
    return beamPower / (this._metalIsp * g0 * IT.EFFICIENCY);
  }

  /**
   * Manually deploy net from ARM PILOT mode.
   * Transitions directly to NETTING state, bypassing auto-approach.
   * Capture success probability depends on alignment and tumble.
   * @returns {boolean}
   */
  manualNetDeploy() {
    if (this.state !== S.TRANSIT && this.state !== S.APPROACH) return false;
    if (!this.target) return false;

    // 2026-05-28 (Item 8): mirror the inventory gate from captureFromStationKeep
    // so the ARM_PILOT manual-deploy path also fails loudly when the daughter
    // is out of nets, instead of silently transitioning to NETTING and getting
    // a console.warn fallback inside _updateNettingFSM with no UI cue.
    if (Constants.isFeatureEnabled('CAPTURE_NET') && this._netInventory <= 0) {
      eventBus.emit(Events.NET_EMPTY_CLICK, { armId: this.id });
      audioSystem.playDeny();
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: this.displayName,
        text: DAUGHTER_OUT_OF_NETS_LINE,   // DECISIONS §33 row 8: nets refill only at the resupply stop (not "return to mother")
        channel: 'CMD',
        priority: 'warning',
      });
      return false;
    }

    this._manualMode = false; // Exit manual control for capture sequence
    this._manualCapture = true; // Flag for scoring (Delegate 3C will use this)
    this._transitionTo(S.NETTING);
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `${this.displayName}: Net deployed. Attempting capture`,
      priority: 'info',
    });
    return true;
  }

  /**
   * Begin one-way deorbit sacrifice. Arm burns all remaining FEEP fuel
   * retrograde, lowering the captured debris' perigee. Both arm and debris
   * are removed when fuel is exhausted.
   * Only valid when arm has captured debris (GRAPPLED, HAULING, REELING, or RETURNING).
   * @returns {{ success: boolean, fuelAtStart: number, totalMass: number }}
   */
  startDeorbit() {
    // A deorbit burn needs real propellant to lower perigee. An ADRIFT /
    // reserve-only daughter can't fund it, so deorbit is disabled at the reserve
    // floor — guide the player to reel her home instead (design decision).
    if (this.state === S.ADRIFT || this.fuel <= (Constants.ARM_RESERVE_FUEL ?? 0)) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'HOUSTON', channel: 'CMD',
        text: `${this.displayName}: Insufficient FEEP for a deorbit burn. Reel her in (R) instead.`,
        priority: 'warning',
      });
      return { success: false, fuelAtStart: this.fuel, totalMass: 0 };
    }
    if (this.state !== S.GRAPPLED && this.state !== S.HAULING &&
        this.state !== S.REELING && this.state !== S.RETURNING) {
      return { success: false, fuelAtStart: 0, totalMass: 0 };
    }
    if (!this.capturedDebris && !this.target) {
      return { success: false, fuelAtStart: 0, totalMass: 0 };
    }

    const fuelAtStart = this.fuel;
    const debrisMass = this.capturedDebris
      ? (this.capturedDebris.mass || 1)
      : (this.target ? this.target.mass || 1 : 1);
    const totalMass = this.config.mass + debrisMass;

    this._manualMode = false;
    this._transitionTo(S.DEORBITING);

    eventBus.emit(Events.ARM_DEORBIT, {
      armId: this.id,
      fuelAtStart,
      totalMass,
      debrisId: this.capturedDebris?.id || this.target?.id,
    });

    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `${this.displayName}: DEORBIT BURN. All fuel committed retrograde`,
      priority: 'warning',
    });

    return { success: true, fuelAtStart, totalMass };
  }

  // ==========================================================================
  // V5 CROSSBOW API
  // ==========================================================================

  /**
   * Set the arm's launch speed for next crossbow fire.
   * Clamped to current spring tier's max speed.
   * @param {number} speed - Desired launch speed in m/s
   */
  setLaunchSpeed(speed) {
    const tier = SPRING_TIERS[this.springTier];
    this.launchSpeed = Math.max(
      CROSSBOW_LAUNCH_SPEED_MIN,
      Math.min(speed, tier.maxSpeed)
    );
  }

  /**
   * Start laser ablation on a target for de-spin/nudge.
   * Only valid in TRANSIT or APPROACH states.
   * @param {object} target - Target object with mesh and optional angularVelocity
   * @returns {boolean}
   */
  startAblation(target) {
    if (this.state !== S.TRANSIT && this.state !== S.APPROACH) return false;
    this.ablationTarget = target;
    this.ablationTimer = 0;
    this._transitionTo(S.ABLATING);
    eventBus.emit(Events.ABLATION_START, {
      armIndex: this.index,
      targetId: target.id || null,
    });
    return true;
  }

  /**
   * Start pulse scan — arm acts as distributed sensor node.
   * Only valid when DOCKED.
   * @returns {boolean}
   */
  startScan() {
    if (this.state !== S.DOCKED) return false;
    this._preScanState = this.state;
    this._scanTimer = 0;
    this._transitionTo(S.SCANNING);
    return true;
  }

  /**
   * Upgrade the spring tier (shop upgrade).
   * @param {number} tier - Spring tier index
   */
  setSpringTier(tier) {
    this.springTier = Math.max(0, Math.min(tier, SPRING_TIERS.length - 1));
    // Clamp current launch speed to new tier max
    this.launchSpeed = Math.min(this.launchSpeed, SPRING_TIERS[this.springTier].maxSpeed);
  }

  /**
   * Upgrade the tether tier (shop upgrade).
   * Register item 100: the tier ladder now drives the LIVE tether length
   * (config.tetherMax — the deploy gate, tether-limit recall and position
   * clamps all read it). The shipped per-type ratio (spinner 500 m / weaver
   * 2000 m at T1) is carried up the ladder, so T1 is byte-identical to the
   * pre-ladder bases. Break strength follows the tier as before.
   * @param {number} tier - Tether tier index
   */
  setTetherTier(tier) {
    this.tetherTier = Math.max(0, Math.min(tier, TETHER_TIERS.length - 1));
    const t = TETHER_TIERS[this.tetherTier];
    const typeRatio = (this.type === 'weaver')
      ? 1
      : Constants.SPINNER_TETHER_LENGTH / Constants.WEAVER_TETHER_LENGTH;
    this.config.tetherMax = Math.round(t.maxLength * typeRatio);
    this.tetherBreakStrength = t.breakStrength;
  }

  // ==========================================================================
  // ST-9.3 C-3: AIM ALPHA (MERIDIAN SWEEP) — replaces Rev 5 setAimYaw
  // ==========================================================================

  /**
   * Get the current meridian sweep angle.
   * α=0 → stowed (−Y), α=π/2 → equatorial (outward), α=π → zenith (+Y).
   * @returns {number} Current aim alpha in radians [0, π]
   */
  getAimAlpha() {
    return this._aimAlpha;
  }

  /**
   * Set the aim meridian sweep angle with slew-rate clamping.
   * Clamped to [STRUT_SWEEP_MIN, STRUT_SWEEP_MAX] (0 to π).
   * Per-frame delta clamped to STRUT_SLEW_RATE × dt.
   *
   * Rejected if hinge is LOCKED (when LOCKABLE_HINGE feature flag is on).
   *
   * launch-smooth: with an `ease` the strut does not start and stop at the full 15°/s: the move from the angle it is at
   * when the ease begins to `alpha` speeds up at STRUT_EASE_ACCEL, coasts at a peak (never above STRUT_SLEW_RATE) and
   * slows down at the same rate, lasting `ease.durationS` (or, when that is 0 / missing / shorter than the move can be
   * done, as short as it can be). The launch aim uses it so the strut and the mother's turn end together. The ease is
   * keyed by the `ease` object and the target angle: the same object and angle go on with the move (call it once a
   * frame with the same `ease`), a new object or angle starts a new move from where the strut is. A call without an
   * `ease`, or a snap (dt = 0), ends it. Every caller that passes none keeps the constant-rate slew above.
   *
   * @param {number} alpha — target angle in radians [0, π]
   * @param {number} [dt=0] — frame deltaTime for slew-rate clamping.
   *   If 0, snaps immediately (used for initialization).
   * @param {{durationS?:number}|null} [ease=null] — launch-smooth: ease the move (see above)
   * @returns {boolean} true if alpha was changed, false if rejected (hinge locked)
   */
  setAimAlpha(alpha, dt = 0, ease = null) {
    // Hinge lock gate (only enforced when feature flag is on)
    if (Constants.FEATURE_FLAGS.LOCKABLE_HINGE && this._hingeState === Constants.HINGE_STATES.LOCKED) {
      return false; // Rotation rejected — hinge is locked
    }

    const V5 = Constants.OCTOPUS_V5;
    const target = Math.max(V5.STRUT_SWEEP_MIN, Math.min(alpha, V5.STRUT_SWEEP_MAX));

    if (dt > 0) {
      let desired = target;
      if (ease && V5.STRUT_EASE_ACCEL > 0) {
        let e = this._aimEase;
        if (!e || e.src !== ease || e.to !== target) {
          const d = Math.abs(target - this._aimAlpha);
          const prof = strutEaseProfile(d, V5.STRUT_EASE_ACCEL, V5.STRUT_SLEW_RATE, ease.durationS || 0);
          e = this._aimEase = {
            src: ease, from: this._aimAlpha, to: target, sign: target >= this._aimAlpha ? 1 : -1,
            d, a: V5.STRUT_EASE_ACCEL, v: prof.v, T: prof.T, t: 0,
          };
        }
        e.t += dt;
        desired = e.t >= e.T ? e.to : e.from + e.sign * strutEaseDistance(e, e.t);
      } else {
        this._aimEase = null;
      }
      // Slew-rate clamp: max angular change per frame
      const maxDelta = V5.STRUT_SLEW_RATE * dt;
      const delta = desired - this._aimAlpha;
      const clampedDelta = Math.max(-maxDelta, Math.min(delta, maxDelta));
      this._aimAlpha += clampedDelta;
    } else {
      // Snap (initialization or test)
      this._aimEase = null;
      this._aimAlpha = target;
    }
    return true;
  }

  /**
   * launch-smooth: the shortest time (s) an eased `setAimAlpha` move from the strut's angle now to `alpha` takes.
   * 0 when she is already there (or the ease is not configured: the constant-rate time then).
   * @param {number} alpha — target angle in radians [0, π]
   * @returns {number}
   */
  aimEaseMinTime(alpha) {
    const V5 = Constants.OCTOPUS_V5;
    const target = Math.max(V5.STRUT_SWEEP_MIN, Math.min(alpha, V5.STRUT_SWEEP_MAX));
    const d = Math.abs(target - this._aimAlpha);
    if (!(V5.STRUT_EASE_ACCEL > 0)) return d / V5.STRUT_SLEW_RATE;
    return strutEaseProfile(d, V5.STRUT_EASE_ACCEL, V5.STRUT_SLEW_RATE, 0).T;
  }

  /**
   * Check if aim alpha is in the high-recoil zone.
   * High recoil occurs when strut points mostly axially (near stowed or zenith).
   * @returns {boolean} true if α < HIGH_RECOIL_ALPHA_LOW or α > HIGH_RECOIL_ALPHA_HIGH
   */
  isHighRecoilZone() {
    const V5 = Constants.OCTOPUS_V5;
    return this._aimAlpha < V5.HIGH_RECOIL_ALPHA_LOW ||
           this._aimAlpha > V5.HIGH_RECOIL_ALPHA_HIGH;
  }

  // ==========================================================================
  // ST-9.3 C-3: LOCKABLE HINGE STATE MACHINE (Gap #9)
  // ==========================================================================

  /**
   * Lock the hinge brake (ROTATE → LOCKED). No-op if already locked.
   * Gated behind FEATURE_FLAGS.LOCKABLE_HINGE — when false, this is a no-op.
   * Emits EVENTS.ARM_HINGE_LOCKED on successful transition.
   */
  lockHinge() {
    if (!Constants.FEATURE_FLAGS.LOCKABLE_HINGE) return;
    if (this._hingeState === Constants.HINGE_STATES.LOCKED) return;

    this._hingeState = Constants.HINGE_STATES.LOCKED;
    eventBus.emit(Events.ARM_HINGE_LOCKED, { armIndex: this.index });
  }

  /**
   * Unlock the hinge brake (LOCKED → ROTATE). No-op if already unlocked.
   * Gated behind FEATURE_FLAGS.LOCKABLE_HINGE — when false, this is a no-op.
   * Emits EVENTS.ARM_HINGE_UNLOCKED on successful transition.
   */
  unlockHinge() {
    if (!Constants.FEATURE_FLAGS.LOCKABLE_HINGE) return;
    if (this._hingeState === Constants.HINGE_STATES.ROTATE) return;

    this._hingeState = Constants.HINGE_STATES.ROTATE;
    eventBus.emit(Events.ARM_HINGE_UNLOCKED, { armIndex: this.index });
  }

  /**
   * Query hinge lock state.
   * @returns {boolean} true if hinge is locked AND LOCKABLE_HINGE flag is on.
   *   Returns false if the feature flag is off (hinge always rotatable).
   */
  isHingeLocked() {
    if (!Constants.FEATURE_FLAGS.LOCKABLE_HINGE) return false;
    return this._hingeState === Constants.HINGE_STATES.LOCKED;
  }

  /**
   * Get the raw hinge state string regardless of feature flag.
   * Used by HUD display and tests.
   * @returns {string} 'ROTATE' or 'LOCKED'
   */
  getHingeState() {
    return this._hingeState;
  }

  /**
   * Tick the hinge settle timer. Call each frame from the update loop.
   * When timer expires, the hinge auto-unlocks.
   * @param {number} dt — frame delta time
   * @private
   */
  _tickHingeSettle(dt) {
    if (this._hingeSettleTimer <= 0) return;
    this._hingeSettleTimer -= dt;
    if (this._hingeSettleTimer <= 0) {
      this._hingeSettleTimer = 0;
      this.unlockHinge();
    }
  }

  // ==========================================================================
  // ST-9.3 C-3: TETHER ANCHOR — strut tip (Gap #9)
  // ==========================================================================

  /**
   * Compute the world-space tether anchor point at the REEL position on the strut.
   *
   * The tether exits from the reel cartridge (at 85% of strut length from the pivot),
   * not from the strut tip (100%). Uses _reelOffset set by PlayerSatellite._updateStruts()
   * in the correct PlayerSatellite local frame. Falls back to dockOffset (strut tip)
   * if _reelOffset isn't available, then to arm.position as last resort.
   *
   * @param {THREE.Vector3} motherPos — mother world position (scene units)
   * @param {THREE.Quaternion} motherQuat — mother world orientation
   * @returns {THREE.Vector3} World-space reel position (scene units)
   */
  getTetherAnchorWorldPosition(motherPos, motherQuat) {
    // Prefer _reelOffset (85% of strut = reel cartridge position)
    const localOffset = this._reelOffset || this.dockOffset;
    if (localOffset) {
      const offset = localOffset.clone();
      if (motherQuat) offset.applyQuaternion(motherQuat);
      return offset.add(motherPos);
    }

    // Fallback: return arm world position (pre-C-3 / no strut geometry)
    return this.position.clone();
  }

  /**
   * World-space NET-LAUNCH MUZZLE — the front face of the fore net-launcher
   * canister (the `${this.id}-net-launcher` housing built in _createMesh; its
   * local offset is captured there as _netMuzzleLocal from the same variables
   * that place the mesh, so this can never drift from the visible hardware).
   * Mirrors PlayerSatellite.getNetPodPositionInto: the allocation-free launch
   * anchor for the daughter's net projectile, ceremony visual and in-flight
   * net tether — so the net materialises from the canister, not the body
   * centre.
   *
   * READ-ONLY on transforms (CONVENTIONS.md §10 Rule B): composes this.position with
   * the CURRENT group quaternion — whoever owns it (PlayerSatellite.
   * postArmUpdate for docked states, the ArmUnit attitude branch when
   * deployed) — and never writes either.
   *
   * NOTE: this is the NET tether/launch anchor only. The DAUGHTER-HAUL tether
   * anchor (strut reel cartridge, getTetherAnchorWorldPosition above) is a
   * DIFFERENT tether and intentionally stays strut-anchored.
   *
   * @param {THREE.Vector3} out — receives the world-space muzzle (scene units)
   * @returns {THREE.Vector3} out (for chaining)
   */
  getNetMuzzleWorldInto(out) {
    if (this._netMuzzleLocal && this.group) {
      return out.copy(this._netMuzzleLocal)
        .applyQuaternion(this.group.quaternion)
        .add(this.position);
    }
    // Defensive fallback (mesh not built): body centre.
    return out.copy(this.position);
  }

  /**
   * Reset arm to initial state (e.g. new game).
   * Does NOT reset springTier/tetherTier — those are persistent upgrades.
   */
  reset() {
    // trip-melt-2: a carry in progress lets go of its tip reservation, the strut reservation and the radiator hold first
    if (this._carry) this.abortCarry('reset', { quiet: true });
    this._carryGaveUp = false;
    this.state = S.DOCKED;
    this.fuel = 100;
    this.coldGasKg = this._coldGasBottleKg();   // reel-gas: the bottle is reset wherever the FEEP fuel is
    this.tetherLength = 0;
    this.target = null;
    this.capturedDebris = null;
    this.heldCatches = [];               // S6: the parked cargo rack resets too
    this.stateTimer = 0;
    this.captures = 0;
    this._startingDistance = 0;
    this.position.set(0, 0, 0);
    this.velocity.set(0, 0, 0);
    this.isDetached = false;
    this._tetherSevered = false;
    this._severedCatch = null;
    this._severedDriftS = 0;
    this._detachFuelWarning25 = false;
    this._detachFuelWarning10 = false;
    this._manualMode = false;
    this._manualCapture = false;
    this._fuelAtDeploy = 100;
    this._autoFailChance = 0;
    this._nearbyDebris = [];
    this._webShotCooldown = 0;
    this._webShotTarget = null;
    this._trawlingMode = false;
    this._trawlDirection = null;
    this._trawlTimer = 0;
    this._lastParentQuat = null;   // ST-1.1: clear cached parent quaternion
    this._frameParentQuat = null;  // fail-reel: same reset
    this._prevParentPos = null;    // Orbital frame correction: reset on arm reset
    this._frameParentPos = null;   // nets-1b R9: this frame's parent position, same reset

    // V5 Crossbow resets
    this.springCharged = true;
    this.reloadProgress = 0;
    this.reloadDuration = 0;
    this.tetherTension = 0;
    this.tetherLength = 0;
    this._tetherCreakCooldown = 0;   // re-arm the daughter creak rate-limit on reset
    this.ablationTarget = null;
    this.ablationTimer = 0;
    this.reeling = false;
    this.launchDirection = null;
    // Don't reset springTier/tetherTier — those are upgrades

    // C-3: Reset aim/hinge state
    this._aimAlpha = 0;
    this._hingeState = Constants.HINGE_STATES.ROTATE;
    this._hingeSettleTimer = 0;

    this.mesh.visible = false;
    this.tetherLine.visible = false;
  }

  /**
   * Update arm each frame.
   * @param {number} dt - Real-time delta in seconds
   * @param {THREE.Vector3} parentPos - Core satellite world position
   * @param {THREE.Quaternion} [parentQuat] - Core satellite quaternion
   */
  update(dt, parentPos, parentQuat) {
   this.stateTimer += dt;
   this._rackClockS = (this._rackClockS || 0) + dt;   // rack-centre: times a cell-down slide (stateTimer is reset by the unload)

   // C-3: Tick hinge auto-unlock settle timer
   this._tickHingeSettle(dt);

   // §11.3: reaction-wheel momentum bleed (magnetorquers) — every state.
   this._tickWheelDecay(dt);

   // §11.5: capture-torque settle — every state (the transient spans
   // GRAPPLED → REELING and must survive state changes and follow external
   // releases honestly; inert single null-check when no settle is live).
   this._tickCaptureSettle(dt);

   // --- Orbital frame correction (APPLY): keep deployed arms in ship's co-moving frame ---
   // MUST run BEFORE state machine so _updateTransit / _updateApproach see
   // this.position in the CURRENT frame's co-moving frame (matching the freshly-
   // propagated target._scenePosition from DebrisField). When this ran AFTER the
   // state machine, the arm's position was one orbital step behind the target,
   // creating a ~1900 m phantom gap that prevented convergence.
   //
   // NOTE: _prevParentPos is updated AFTER the state machine (below) so that the
   // drift calculation `(parentPos - _prevParentPos)` in _updateTransit still sees
   // the correct per-frame parent displacement, not zero.
   // launch-seq (Decision 6): DOCKING is corrected too. It was skipped here (initial commit) while
   // _updateDocking only lerps 5 %/frame to the dock point, so on an orbiting ship she fell behind by
   // ~19 frames of ship travel (measured 2.4 km at 60 fps over one DOCKING, then snapped home at DOCKED).
   if (parentPos) {
     // nets-1b R9: remember THIS frame's parent position. `position` is shifted to it just below, while
     // `_prevParentPos` is still last frame's until the end of `update`, so a range measured between `position`
     // and `_prevParentPos` (a capture mid-frame) reads one whole orbital step (~7.7 km live) too far.
     if (!this._frameParentPos) this._frameParentPos = new THREE.Vector3();
     this._frameParentPos.copy(parentPos);
     if (this.state !== S.DOCKED) {
       if (this._prevParentPos) {
         this.position.x += (parentPos.x - this._prevParentPos.x);
         this.position.y += (parentPos.y - this._prevParentPos.y);
         this.position.z += (parentPos.z - this._prevParentPos.z);
       }
     }
   }

   switch (this.state) {
     case S.DOCKED:     this._updateDocked(dt, parentPos, parentQuat); break;
     case S.UNDOCKING:  this._updateUndocking(dt, parentPos); break;
     case S.LAUNCHING:  this._updateLaunching(dt, parentPos, parentQuat); break;
     case S.TRANSIT:    this._updateTransit(dt, parentPos); break;
     case S.APPROACH:   this._updateApproach(dt, parentPos); break;
     case S.NETTING:    this._updateNetting(dt); break;
     case S.GRAPPLED:   this._updateGrappled(dt, parentPos, parentQuat); break;
     case S.HAULING:    this._updateHauling(dt, parentPos); break;
     case S.REELING:    this._updateReeling(dt, parentPos, parentQuat); break;
     case S.RETURNING:  this._updateReturning(dt, parentPos, parentQuat); break;
     case S.DOCKING:    this._updateDocking(dt, parentPos, parentQuat); break;
      case S.RELOADING:  this._updateReloading(dt); break;
      case S.HOLDING_CATCH: this._updateHoldingCatch(dt, parentPos, parentQuat); break;
      case S.CARRY_PREP:    this._updateCarryPrep(dt, parentPos, parentQuat); break;
      case S.CARRY_OUT:     this._updateCarryOut(dt, parentPos, parentQuat); break;
      case S.CARRY_HANDOFF: this._updateCarryHandoff(dt, parentPos, parentQuat); break;
      case S.CARRY_BACK:    this._updateCarryBack(dt, parentPos, parentQuat); break;
     case S.TRAWLING:   this._updateTrawling(dt, parentPos); break;
     case S.DEORBITING: this._updateDeorbiting(dt); break;
     case S.WEB_SHOT:   this._updateWebShot(dt, parentPos); break;
     case S.ABLATING:   this._updateAblating(dt); break;
      case S.SCANNING:   this._updateScanning(dt); break;
      case S.STATION_KEEP: this._updateStationKeep(dt); break;
     case S.MAGNETIC_GRAPPLE: this._updateMagneticGrapple(dt); break;
     case S.GRIPPER_GRAPPLE: this._updateGripperGrapple(dt); break;
     case S.PAD_CONTACT: this._updatePadContact(dt); break;
     case S.EXPENDED:   this._updateExpended(dt); break;
     case S.ADRIFT:     this._updateAdrift(dt); break;
   }
   this._updateColdGasRefill(dt);       // reel-gas: docked on her strut, the mother's gas tops her bottle up

   // --- Orbital frame correction (STORE): update _prevParentPos AFTER state machine ---
   // Must be separate from the APPLY step above so that _updateTransit's drift
   // calculation `(parentPos - _prevParentPos)` sees the correct per-frame delta
   // (last frame's parentPos → this frame's parentPos), not zero.
    if (parentPos) {
      if (!this._prevParentPos) {
        this._prevParentPos = new THREE.Vector3();
      }
      this._prevParentPos.copy(parentPos);
    }

    // --- Lead-aim: estimate the selected target's velocity RELATIVE TO THE ARM ---
    // Tracked every frame while a target exists (so by the time NETTING fires the
    // net on its first frame, STATION_KEEP has already built a velocity estimate).
    //
    // 2026-06-12 (Issue 2 fix): the net is propagated in the ARM's co-orbiting
    // frame — CaptureNet re-anchors `net.position = arm.position + launchDir ×
    // distanceTraveled` every flight frame — so the correct lead velocity is the
    // target velocity AS SEEN FROM THE ARM, not the raw scene-space delta. In a
    // settled STATION_KEEP both arm and target share the orbital drift, so the
    // relative velocity is ≈0 and the shot must fly dead straight; leading by
    // the shared drift (the old behavior) bent every SK shot off-axis. Both
    // deltas are sampled in this same block (identical frame timing) for
    // robustness. Units: scene units/s throughout (NOT metres/s — both
    // `_scenePosition` and `arm.position` are scene-space; `launchSpeedScene =
    // LAUNCH_SPEED × M` in computeLeadAim matches).
    {
      const tp = this.target && this.target._scenePosition;
      if (tp && dt > 1e-6) {
        if (this._leadTargetPrevPos && this._leadArmPrevPos) {
          if (!this._leadTargetVel) this._leadTargetVel = new THREE.Vector3();
          // Arm-relative velocity in scene units/s: (targetDelta − armDelta)/dt.
          this._leadTargetVel.set(
            ((tp.x - this._leadTargetPrevPos.x) - (this.position.x - this._leadArmPrevPos.x)) / dt,
            ((tp.y - this._leadTargetPrevPos.y) - (this.position.y - this._leadArmPrevPos.y)) / dt,
            ((tp.z - this._leadTargetPrevPos.z) - (this.position.z - this._leadArmPrevPos.z)) / dt,
          );
          this._leadTargetVelValid = true;
        } else {
          if (!this._leadTargetPrevPos) this._leadTargetPrevPos = new THREE.Vector3();
          if (!this._leadArmPrevPos) this._leadArmPrevPos = new THREE.Vector3();
        }
        this._leadTargetPrevPos.copy(tp);
        this._leadArmPrevPos.copy(this.position);
      } else {
        this._leadTargetPrevPos = null;
        this._leadArmPrevPos = null;
        this._leadTargetVelValid = false;
      }
    }

    // Web shot cooldown tick (Sprint D1)
    if (this._webShotCooldown > 0) {
      this._webShotCooldown -= dt;
      if (this._webShotCooldown < 0) this._webShotCooldown = 0;
    }

    // Fuel consumption (when active — trawling uses minimal power)
    // DEORBITING handles its own burn rate in _updateDeorbiting()
    // TRAWLING handles its own fuel consumption in _updateTrawling()
    // WEB_SHOT fuel is consumed upfront in fireWebShot()
    // V5: REELING, RELOADING, LAUNCHING, ABLATING, SCANNING exempt from legacy fuel
    if (this.state !== S.DOCKED && this.state !== S.EXPENDED &&
        this.state !== S.DEORBITING && this.state !== S.TRAWLING &&
        this.state !== S.WEB_SHOT && this.state !== S.REELING &&
        this.state !== S.RELOADING && this.state !== S.LAUNCHING &&
        this.state !== S.ABLATING && this.state !== S.SCANNING &&
        this.state !== S.ADRIFT &&
        !this._carry) {              // trip-melt-2: the carry bills its own push, once (beginCarry's fuel check, _carryBeginOut)
      this._consumeFuel(dt);
    }

    // Max-distance kill for detached arms — prevent orphaned arms drifting forever
    if (this.isDetached && this.state !== S.EXPENDED && parentPos) {
      const distMeters = this.position.distanceTo(parentPos) / M;
      if (distMeters > Constants.DETACH_MAX_DISTANCE) {
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `Daughter lost. ${this.displayName} exceeded max range (${Math.round(distMeters)}m). Signal lost.`,
          priority: 'critical',
        });
        eventBus.emit(Events.ARM_LOST, { armId: this.id, reason: 'max_distance' });
        eventBus.emit(Events.ARM_EXPENDED, { armId: this.id, type: this.type });
        this._transitionTo(S.EXPENDED);
      }
    }

    // Update tether visual — C-3: use strut tip as mother-side anchor when available
    this._updateTether(parentPos, parentQuat, dt);
    this._updateBridle();  // S3.6 — bridle visibility mirrors tether

    // Update mesh position
    this.group.position.copy(this.position);

    // --- Attitude control: orient the daughter along its heading ---
    // DOCKED/DOCKING/RELOADING/HOLDING_CATCH: mesh hidden or strut-aligned — skip.
    //   These are owned by PlayerSatellite.postArmUpdate, which has the live
    //   strut basis (sg.strutDir/azRad) and composes the mother's world quat.
    //   DOCKED snaps; DOCKING slerps onto the strut (no pop at dock); HOLDING_CATCH
    //   snaps to the strut basis (no wrong-basis drift toward raw parentQuat).
    //   Keeping a SINGLE owner avoids the override-fight class of bug (CONVENTIONS.md §10
    //   Rule B) that caused the parked daughter to rotate to the mother bus basis
    //   and render the tether in the wrong direction (Item 5).
    // LAUNCHING: maintain strut-aligned orientation set by postArmUpdate on the
    //   last DOCKED frame. The arm is either in clamp hold (velocity=0) or just
    //   launched (velocity along strut). Slerping toward parentQuat or a lookAt
    //   target here would cause a disorienting rotation because postArmUpdate uses
    //   setFromUnitVectors (no roll constraint) while lookAt uses Earth-radial up
    //   (different roll). Skip entire LAUNCHING state — attitude picks up in TRANSIT.
    // APPROACH/NETTING: nose (+Z) toward target for intercept.
    // All other deployed states: nose (+Z) along velocity (prograde).
    // Fallback: inherit mother's orientation (parentQuat) when no heading available.
    const skipAttitude = (this.state === S.DOCKED || this.state === S.DOCKING ||
                         this.state === S.RELOADING || this.state === S.LAUNCHING ||
                         this.state === S.HOLDING_CATCH ||
                         this._carry != null);      // trip-melt-2: the carry states seat her in her docked attitude themselves
    if (!skipAttitude) {
      let headingDir = null;
      let reelHeading = false;

      // Target-tracking states: point nose toward debris target
      // STATION_KEEP included so the arm faces the debris instead of
      // inheriting the mother's prograde orientation (which caused 180° flips).
      if ((this.state === S.APPROACH || this.state === S.NETTING || this.state === S.STATION_KEEP) &&
          (this.target || this._stationKeepTarget)) {
        const _attTarget = this._stationKeepTarget || this.target;
        const tPos = _attTarget._scenePosition || _attTarget.position || _attTarget;
        headingDir = this._tmpVec.subVectors(tPos, this.position);
        if (headingDir.lengthSq() < 1e-20) headingDir = null;
        else headingDir.normalize();
      }

      // Whole-haul reel attitude (REEL_PROFILE_V2, plan Rev-3): during REELING
      // point the nose (+Z) at the LIVE strut-tip dock so the +Y wishbone bridle
      // (and thus the tether) trails off-axis from the ±Z FEEP plume — the yoke
      // tether-plume clearance the FEEP-during-reel behaviours depend on. Held
      // for the entire haul (not just the arrest), and recomputed each frame so
      // it tracks a maneuvering mother. Replaces the prograde/inherited fallback
      // that REELING used before (REELING barely sets velocity).
      // Wave2 arrest-gate reconciliation: inside the arrest approach the aim is
      // offset ARREST_STEER_DEG away from the bridle side, distance-blended via
      // _applyArrestSteerToHeading (single owner: this branch — the offset is
      // part of the SAME aim this slerp has always tracked, so there is no
      // competing quaternion writer and no snap at the window boundary).
      // reel-home (Decision 3): while her net winds the catch in she turns her nose (+Z) to it, at the reel's rate.
      let rhQuat = null;
      if (!headingDir && this.state === S.GRAPPLED && this._rhPinned && this._rhOn()
          && this._rhSep.lengthSq() > 1e-20) {
        headingDir = this._tmpVec.copy(this._rhSep).normalize();
        reelHeading = true;
      }
      // reel-home (Decision 4): on the strut reel she goes home TAIL FIRST — her -Z at the strut tip, her +Z and the
      // catch leading away, roll set so DOCKING only trims residuals. Replaces the "+Z at the dock" aim below.
      if (!headingDir && this.state === S.REELING && this._rhHome && this._rhOn() && parentPos && this.dockOffset) {
        const dockWP = this._tmpDockTarget || (this._tmpDockTarget = new THREE.Vector3());
        this._resolveStrutDockWorld(parentPos, parentQuat, dockWP);
        const toTip = this._tmpVec.subVectors(dockWP, this.position);
        if (this._rhTailFirstQuatInto(toTip, toTip.length(), parentQuat, _rhTailQuat)) {
          rhQuat = _rhTailQuat;
          reelHeading = true;
        }
      }
      if (!headingDir && !rhQuat && this.state === S.REELING
          && Constants.isFeatureEnabled('REEL_PROFILE_V2') && parentPos && this.dockOffset) {
        const dockWP = this._tmpDockTarget || (this._tmpDockTarget = new THREE.Vector3());
        this._resolveStrutDockWorld(parentPos, parentQuat, dockWP);
        headingDir = this._tmpVec.subVectors(dockWP, this.position);
        if (headingDir.lengthSq() < 1e-20) headingDir = null;
        else {
          const distMeters = headingDir.length() / M;
          headingDir.normalize();
          this._applyArrestSteerToHeading(headingDir, distMeters);
          reelHeading = true;
        }
      }

      // Prograde fallback: align nose with velocity vector
      if (!headingDir && this.velocity.lengthSq() > 1e-20) {
        headingDir = this._tmpVec.copy(this.velocity).normalize();
      }

      if (rhQuat) {
        this.group.quaternion.slerp(rhQuat, (Constants.YOKE_CLEARANCE && Constants.YOKE_CLEARANCE.REEL_ATTITUDE_SLERP) ?? 0.1);
      } else if (headingDir) {
        // Use Earth-radial as "up" (same convention as mother satellite)
        const radial = _orientRadial.copy(this.position).normalize();
        const eye = _orientEye.copy(this.position).add(headingDir);
        _orientMat.lookAt(eye, this.position, radial);
        const targetQuat = _orientQuat.setFromRotationMatrix(_orientMat);
        // V-8 fix: faster slerp for target-tracking states so daughter visually
        // snaps to face debris promptly. 0.05 was ~1s to converge — too slow for
        // APPROACH/STATION_KEEP where the daughter should clearly face the debris.
        let sRate;
        if (reelHeading) {
          sRate = (Constants.YOKE_CLEARANCE && Constants.YOKE_CLEARANCE.REEL_ATTITUDE_SLERP) ?? 0.1;
        } else {
          sRate = (this.state === S.APPROACH || this.state === S.STATION_KEEP || this.state === S.NETTING)
            ? 0.15    // fast reorientation during close-range operations
            : 0.05;   // gentle for TRANSIT (cosmetic, less disorienting on long flights)
        }
        this.group.quaternion.slerp(targetQuat, sRate);
      } else if (parentQuat) {
        // No heading available (velocity ≈ 0 when stationary, etc.)
        // Inherit mother's orientation so daughters don't appear to counter-rotate
        // when the camera follows the mother's pitch.
        this.group.quaternion.slerp(parentQuat, 0.1);
      }

      // [DBG-ARM] ATTITUDE per-frame log removed (excessive noise — was firing every frame
      // for every arm in every state). If needed, re-enable with a much tighter throttle.
    }

    // launch-seq (Decision 5): _updateTether (above) baked the line's counter-rotation from the PREVIOUS
    // frame's group quaternion, and the slerp just now changed it. The line's vertices are group-local, so
    // the stale counter-rotation swung the whole line about her end by this frame's slerp delta: at
    // TRANSIT -> REELING the reel heading flips ~180°, the 10 % slerp turns her ~18° in one frame, and a
    // 30 m line's strut-side end jumped 9 m (then eased back as the deltas shrank, ~35 frames). Re-sync it.
    if (this.tetherLine.visible) this.tetherLine.quaternion.copy(this.group.quaternion).invert();

    // catch-snug: _updateReeling pinned the catch with her attitude from BEFORE the slerp above turned her
    // (up to ~18° on the first reel frame: the gap wobbled 0.00-0.05 m instead of 0.03). Pin once more so
    // the catch sits one net gap off her end in the frame that is drawn (ArmManager draws it from _armPinPos).
    if (this.state === S.REELING && this.capturedDebris && this.capturedDebris._armPinned) {
      if (!(this._rhArrived && this._rhOn() && this._rhPinInCell())) this._pinCatchToSelf(parentPos);
    } else if (this.state === S.GRAPPLED && this._rhPinned && this._rhArrived && this.capturedDebris) {
      this._rhPinInCell();
    }
    // reel-home: the strut/mother geometry ArmManager reads (the swing-plane angle nearest her, how far she is off it)
    if (this._rhHome && parentPos) this._rhStrutAim(parentPos, parentQuat);

    // Thruster plume animation
    this._updatePlumes(dt);

    // reel-gas: the steady look-puffs of her cold-gas jet while it brakes the reel (only while it fires)
    this._updateGasStream(dt);

    // Wave1: attitude cold-gas puff animation (pooled; 4-flag check when idle)
    this._updateAttitudePuffs();

    // Status light color based on state
    this._updateStatusLight(dt);

    // D4: selection glow/flash pulse on the body facets (when selected)
    this._updateSelectGlow(dt);
  }

  /**
   * Get arm status snapshot for HUD.
   * @returns {object}
   */
  getStatus() {
    return {
      id: this.id,
      type: this.type,
      state: this.state,
      fuel: Math.round(this.fuel),
      tetherLength: Math.round(this.tetherLength),
      targetId: this.target?.id || null,
      hasCaptured: !!this.capturedDebris || this.heldCatches.length > 0,
      captures: this.captures,
      position: this.position.clone(),
      remainingDeltaV: (this.fuel / 100) * (this.config?.totalDeltaV || 50),
      isDetached: this.isDetached,
      // §11.3 reaction-wheel scalar (FEATURE_FLAGS.DAUGHTER_NET_RECOIL):
      // normalized launch-reaction momentum + saturation flag for the HUD
      // (wired later). Neutral 0/false while the flag is OFF.
      wheelMomentum: this._wheelMomentum,
      wheelSaturated: this._wheelSaturated,
      // V5 Crossbow fields
      springCharged: this.springCharged,
      reloadProgress: this.reloadProgress,
      tetherTension: this.tetherTension,
      launchSpeed: this.launchSpeed,
      springTier: this.springTier,
      tetherTier: this.tetherTier,
      // Register item 48: the furnace cook is VISIBLE. Only the rack's HEAD
      // piece cooks (the queue is the anticipation — S6 sequential digestion),
      // so one fraction per arm. frac = _digestProgress / digestSpanS(mass)
      // read through the ONE span-law home; sunScale lets the HUD tell the
      // eclipse "embers until dawn" story. null unless actually cooking.
      digest: (this.state === S.HOLDING_CATCH && this.heldCatches.length > 0)
        ? {
          frac: Math.min(1, Math.max(0,
            (this.heldCatches[0]._digestProgress || 0)
            / Constants.FURNACE_TRANSFER.digestSpanS(this.heldCatches[0].mass))),
          sunScale: this._digestSunScale ?? 1.0,
          queued: this.heldCatches.length - 1,
          kg: this.heldCatches[0].mass || 0,
        }
        : null,
    };
  }

  /** @private Get target scene position (computed by DebrisField each frame) */
  _getTargetScenePos() {
    if (!this.target) return null;
    return this.target._scenePosition || null;
  }

  // ==========================================================================
  // STATE MACHINE
  // ==========================================================================

  /** @private Transition to a new state */
  _transitionTo(newState) {
    const old = this.state;
    if (old === S.NETTING) this._firedNet = null;  // clear net ref when leaving NETTING
    // §11.4: the recoil transient only integrates inside the SK/NETTING hold
    // loops — leaving that pair hands control to a different controller
    // (GRAPPLED reel, RETURNING burn, …) which owns its own residuals. Clear
    // so a stale kick can't replay on a later SK re-entry.
    if (this._recoilActive
        && (old === S.STATION_KEEP || old === S.NETTING)
        && newState !== S.STATION_KEEP && newState !== S.NETTING) {
      this._clearRecoilKick();
    }
    this.state = newState;
    this.stateTimer = 0;
    eventBus.emit(Events.ARM_STATE_CHANGE, {
      armId: this.id, from: old, to: newState,
    });
    if (newState === S.DOCKED || newState === S.RELOADING) {
      this._captureToolKind = 'NET';   // P2: reset capture-verb to default on a clean slate
    }
    // REEL_PROFILE_V2 bookkeeping reset on a fresh capture/dock cycle so the
    // SNUG window (Q3), catch-cleared guard, and re-dock arrest (Q4) re-arm.
    if (newState === S.GRAPPLED || newState === S.DOCKED || newState === S.RELOADING ||
        newState === S.HOLDING_CATCH) {
      this._catchSnugged = false;
      this._reelHadPayload = false;
      this._redockArrestStarted = false;
      this._redockFuelLowWarned = false;
      this._redockDebitApplied = false;
    }
    // reel-home: a fresh capture starts the net reel over; leaving the reels (anything but GRAPPLED / REELING /
    // DOCKING) lets go of the strut reservation and the line-up. REELING is "on the reels" only with the flag on.
    if (newState !== S.DOCKING) this._rhDockFree = false;
    if (newState === S.GRAPPLED) {
      this._rhPinned = false;
      this._rhNetDone = false;
      this._rhArrived = false;
      this._rhHome = false;
    }
    if (newState !== S.REELING) this._rhBraking = false;
    if (newState === S.REELING) {
      this._rhReelV = 0;                    // reel-gas: the reel pulls her up from rest (no jump to peak)
      this._rhBraking = false;
      this._rhGasChecked = false;
      this._rhReelPhase = 'pull';
      this._rhHome = !this.isDetached && Constants.isFeatureEnabled('REEL_HOME');
      this._rhHoldS = 0;
      this._rhTurnTries = 0;
      this._rhTurnWaitS = 0;
      this._rhNoPath = false;
      this._rhNoPathS = 0;
      this._rhLineUpSaid = false;
      this._rhWaitSaid = false;
    } else if (newState === S.DOCKING) {
      // home: the mother turn is hers no more (the strut stays reserved to HOLDING_CATCH). DOCKING that came off the
      // strut reel bills no thruster fuel (F6): the reel did the work.
      this._rhDockFree = old === S.REELING && this._rhHome && this._rhOn();
      this._rhHome = false;
    } else if (newState !== S.GRAPPLED) {
      this._rhEnd();
    }
    // CP-1 / P2: refresh the per-arm tool recommendation on STATION_KEEP entry
    // and default selectedTool to the recommended verb (player can re-cycle).
    if (newState === S.STATION_KEEP && Constants.isFeatureEnabled('DAUGHTER_MULTITOOL')) {
      this._refreshToolRecommendation();
    }
    // CP-1: release the tool-closing CA exemption on ANY exit from a closing
    // state (MAGNETIC_GRAPPLE / GRIPPER_GRAPPLE / PAD_CONTACT) — success,
    // failure, OR an external recall/deorbit — so the AUTOPILOT_TARGET_LOCK set
    // on entry can never leak and permanently exempt a debris from avoidance.
    if ((old === S.MAGNETIC_GRAPPLE || old === S.GRIPPER_GRAPPLE || old === S.PAD_CONTACT)
        && this._toolLockedDebrisId != null) {
      eventBus.emit(Events.AUTOPILOT_TARGET_UNLOCK, { debrisId: this._toolLockedDebrisId });
      this._toolLockedDebrisId = null;
    }
    // ST-8.3.4: Auto-adjust ISP based on flight phase for current metal
    this._updateMetalIspForPhase(newState);

    // Wave1: discrete attitude cold-gas puffs (visual-only, pooled). Fired on
    // the attitude EVENTS, not per-frame: deploy separation (clamp release
    // trim), SK entry (arrival null), dock settle (contact trim on arrival
    // from a haul/return). Tool-cycle re-aim puffs from cycleTool().
    if (newState === S.LAUNCHING || newState === S.UNDOCKING) {
      this._fireAttitudePuffs('deploy');
    } else if (newState === S.STATION_KEEP) {
      this._fireAttitudePuffs('sk');
    } else if (newState === S.DOCKING && (old === S.REELING || old === S.RETURNING)) {
      this._fireAttitudePuffs('dock');
    }
  }

  /**
   * Set _metalIsp based on flight phase and current metal's ISP range.
   * Phase-specific ISP values are clamped to the metal's [ispMin, ispMax].
   * @private
   */
  _updateMetalIspForPhase(phase) {
    const IT = Constants.ION_THRUSTER;
    if (!IT) return;
    const metalData = this.getCurrentMetalData();
    if (!metalData) return;

    // Map ARM_STATES → desired ISP
    const ispMap = {
      [S.TRANSIT]:       IT.ISP_TRANSIT,
      [S.APPROACH]:      IT.ISP_APPROACH,
      [S.STATION_KEEP]:  IT.ISP_STATIONKEEP,
      [S.RETURNING]:     IT.ISP_RETURN,
      [S.DEORBITING]:    IT.ISP_DEORBIT,
    };

    const desired = ispMap[phase];
    if (desired !== undefined) {
      // Clamp to metal's range
      this._metalIsp = Math.max(metalData.ispMin, Math.min(metalData.ispMax, desired));
    }
  }

  /**
   * V5 Crossbow: Apply spring-launched impulse.
   * E = ½kd², v = √(2E/m) = d√(k/m)
   * All velocities come from spring energy, not magic multipliers.
   * @private
   * @returns {number} Actual launch speed used (m/s)
   */
  _applyLaunchImpulse() {
    const tier = SPRING_TIERS[this.springTier];
    const isWeaver = this.config.type === 'weaver';
    const armMass = isWeaver ? V5_WEAVER_MASS : V5_SPINNER_MASS;
    const springK = isWeaver ? CROSSBOW_SPRING_K_WEAVER : CROSSBOW_SPRING_K_SPINNER;

    // Clamp launch speed to spring tier max
    const speed = Math.min(this.launchSpeed, tier.maxSpeed);

    // Spring energy: E = ½kd², effective k scales as v² for variable launch speed
    // (springK and CROSSBOW_DRAW_DISTANCE are used to validate energy budget;
    //  actual impulse is applied directly as velocity for numerical stability)

    // Apply impulse in launch direction (game scale)
    const launchVelocity = speed * M;  // Convert to game units

    if (this.launchDirection) {
      this.velocity.copy(this.launchDirection).multiplyScalar(launchVelocity);
    } else {
      // Fallback: use world-space dock direction so impulse pushes outward
      // even when the mothership is rotated (§4.6 fix).
      const dir = this._worldDockDirection(this._lastParentQuat);
      this.velocity.copy(dir).multiplyScalar(launchVelocity);
    }

    // Store actual launch speed for TRANSIT V_CAP (arm should coast, not accelerate)
    this._launchSpeedMps = speed;

    // Mark spring as discharged
    this.springCharged = false;

    // Emit fire event (includes launchDirection for station-keeping recoil compensation)
    eventBus.emit(Events.CROSSBOW_FIRE, {
      armIndex: this.index,
      speed: speed,
      springTier: this.springTier,
      armMass: armMass,
      launchDirection: this.velocity.clone().normalize(),
    });

    // Calculate reload duration based on energy stored
    // E = ½ × m × v², reload time = E / (P × η)
    const energy = 0.5 * armMass * speed * speed;
    this.reloadDuration = energy / (CROSSBOW_RELOAD_POWER * CROSSBOW_WORM_GEAR_EFFICIENCY);

    return speed; // Return actual launch speed for recoil calculation
  }

  /**
   * Compute world-space dock (deploy) direction from LOCAL dockOffset.
   * Rotates dockOffset by the parent ship's world quaternion so arms always
   * deploy OUTWARD regardless of mothership orientation (§4.6 180° bug fix).
   * @param {THREE.Quaternion|null} parentQuat - parent ship world quat (nullable)
   * @returns {THREE.Vector3} normalized world-space deploy direction
   * @private
   */
  _worldDockDirection(parentQuat) {
    const dir = this.dockOffset.clone();
    if (parentQuat) dir.applyQuaternion(parentQuat);
    return dir.normalize();
  }

  /** DOCKED: follow parent at dock offset */
  _updateDocked(dt, parentPos, parentQuat) {
    // Cache parent quat so externally-invoked deploy*() methods can derive
    // a world-space launch direction (§4.6 fix). P3: owned persistent quat —
    // consumers (_worldDockDirection) read it at deploy time, never store it.
    this._lastParentQuat = parentQuat
      ? (this._lastParentQuatV || (this._lastParentQuatV = new THREE.Quaternion())).copy(parentQuat)
      : null;
    const offset = _dockOffTmp.copy(this.dockOffset);
    if (parentQuat) offset.applyQuaternion(parentQuat);
    this.position.copy(parentPos).add(offset);
    // POLISH FIX: do NOT unconditionally hide the daughter mesh on DOCKED.
    // PlayerSatellite.postArmUpdate() (runs immediately after armManager.update)
    // owns visibility — a docked daughter is shown clamped at the strut tip.
    // Hiding here made the daughter "disappear" after
    // re-dock at the end of REELING, before the next undock.  Now she stays
    // visibly clamped to the strut after a successful retrieval.
    this.tetherLine.visible = false;
    this.velocity.set(0, 0, 0);
  }

  /**
   * UNDOCKING: slowly separate from core (2s animation).
   * Legacy state — preserved for backward compatibility.
   * V5 uses LAUNCHING instead for crossbow spring release.
   */
  _updateUndocking(dt, parentPos) {
    this.mesh.visible = true;
    this.tetherLine.visible = true;

    // Push outward along world-space dock direction (§4.6 fix).
    const pushDir = this._worldDockDirection(this._lastParentQuat);
    const speed = this.config.bodyDims[2] * M * 2;
    this.position.add(pushDir.multiplyScalar(speed * dt));

    this.tetherLength = this.position.distanceTo(parentPos) / M;  // in meters

    if (this.stateTimer > Constants.ARM_DETACH_DURATION) {
      if (this._trawlingMode) {
        this._transitionTo(S.TRAWLING);
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.displayName}: Trawling mode. Slow sweep for debris`,
          priority: 'info',
        });
      } else {
        this._transitionTo(S.TRANSIT);
        // Legacy: still uses old launch impulse for backward compat
        this._applyLaunchImpulse();
        // Issue 1 (2026-06-12): departure event for audio (legacy UNDOCKING path).
        eventBus.emit(Events.ARM_SPRING_FIRED, {
          armId: this.id, type: this.type, speed: this.launchSpeed, mode: 'normal',
        });
        this._emitSpringReleasedLine();
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.displayName}: Clear of core. In transit`,
          priority: 'info',
        });
        // Manual-pilot nudge moved to ArmIdleAdvisor (Constants.ARM_IDLE_HINTS
        // 'transit_pilot_nudge') so it is veteran-gated + deployment-scoped and
        // routed through the same hint pipeline. (Guidance cleanup, Phase 2/3.)
      }
    }
  }

  /**
   * LAUNCHING: V5 crossbow spring release sequence.
   * Phase 1: Magnetic clamp release (0..CROSSBOW_UNDOCK_TIME)
   * Phase 2: Spring release (CROSSBOW_UNDOCK_TIME..+ CROSSBOW_RELEASE_TIME)
   *
   * launch-seq (2026-10-17): until the spring fires she is still CLAMPED — physically part of the
   * ship — so every frame she rides her strut tip, from the same pose source as DOCKED, whatever
   * the mother does. (Before, she kept her old world position while the mother turned and her
   * strut tip walked away from her: 0.26 m in the measured run.) The spring then pushes from the tip.
   * @param {number} dt
   * @param {THREE.Vector3} parentPos
   * @param {THREE.Quaternion} [parentQuat] — the quaternion _updateDocked uses
   * @private
   */
  _updateLaunching(dt, parentPos, parentQuat) {
    this.mesh.visible = true;
    this.tetherLine.visible = true;

    this._undockTimer = (this._undockTimer || 0) + dt;

    if (!this._springFired && parentPos) {
      // Clamped: ride the strut tip (also on the frame the spring fires, so she departs from the tip).
      const offset = _dockOffTmp.copy(this.dockOffset);
      if (parentQuat) offset.applyQuaternion(parentQuat);
      this.position.copy(parentPos).add(offset);
    }

    if (this._undockTimer < CROSSBOW_UNDOCK_TIME) {
      // Phase 1: Magnetic clamp release — she holds on her strut tip (above)
    } else if (this._undockTimer >= CROSSBOW_UNDOCK_TIME && !this._springFired) {
      // Phase 2: Fire the spring!
      this._springFired = true;
      this._applyLaunchImpulse();
      // Issue 1 (2026-06-12): actual departure moment — audio (woosh) keys off
      // THIS event, not ARM_DEPLOYED (which fires 1.5 s earlier at LAUNCHING
      // entry, during the magnetic-clamp-release hold).
      eventBus.emit(Events.ARM_SPRING_FIRED, {
        armId: this.id, type: this.type, speed: this.launchSpeed,
        mode: this._trawlingMode ? 'trawl' : 'normal',
      });
      this._emitSpringReleasedLine();
    }

    if (this._springFired) {
      // Arm is flying — update position with velocity
      this.position.addScaledVector(this.velocity, dt);
      this.tetherLength = this.position.distanceTo(parentPos) / M;
    }

    // Transition after full launch sequence
    if (this._undockTimer >= CROSSBOW_UNDOCK_TIME + CROSSBOW_RELEASE_TIME + 0.2) {
      if (this._trawlingMode) {
        this._transitionTo(S.TRAWLING);
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.displayName}: Trawling mode. Slow sweep for debris`,
          priority: 'info',
        });
      } else {
        this._transitionTo(S.TRANSIT);
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.displayName}: Clear of core. Cradle transit`,
          priority: 'info',
        });
        // Manual-pilot nudge moved to ArmIdleAdvisor (Constants.ARM_IDLE_HINTS
        // 'transit_pilot_nudge') — veteran-gated + deployment-scoped. (Phase 2/3.)
      }
      this._undockTimer = 0;
      this._springFired = false;
    }
  }

  /**
   * launch-seq: the ONE launch line, at the real moment — the spring has fired and she departs.
   * Every launch path (target, free-fly, trawl, ceremony, number key) goes through ARM_SPRING_FIRED,
   * with or without the camera cut-scene, so this replaces the deploy-time "Cradle launch" /
   * "deployed. Tracking…" lines and the cut-scene's own copy.
   * @private
   */
  _emitSpringReleasedLine() {
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `${this.displayName}: Spring released. Separating`,
      priority: 'info',
    });
  }

  /** TRANSIT: fly toward target using FEEP thrust */
  _updateTransit(dt, parentPos) {
    if (this._manualMode) {
      // Manual mode: player controls velocity, we just update position.
      // Autopilot (proportional controller, pings, thruster audio) is
      // intentionally skipped to suppress approach beep + thruster hum
      // that were reported as annoying in ARM_PILOT mode.
      this.position.addScaledVector(this.velocity, dt);
      this.tetherLength = this.position.distanceTo(parentPos) / M;
      if (!this.isDetached && this.tetherLength > this.config.tetherMax) {
        const dir = _tetherDir.subVectors(this.position, parentPos).normalize();
        this.position.copy(parentPos).add(dir.multiplyScalar(this.config.tetherMax * M));
        const velAlongTether = this.velocity.dot(dir);
        if (velAlongTether > 0) {
          this.velocity.addScaledVector(dir, -velAlongTether);
        }
      }
      // ── STILL CHECK APPROACH THRESHOLD even in manual mode ──
      // enableManual() fires during LAUNCH_CEREMONY_COMPLETE while the arm
      // is still in TRANSIT. Without this gate the arm coasts forever and
      // never transitions to APPROACH → STATION_KEEP.
      if (this.target) {
        const _tPos = this._getTargetScenePos();
        if (_tPos) {
          const _dist = _tPos.distanceTo(this.position);
          const _dSz = (this.target.sizeMeter) || 1;
          const _so = Math.max(Constants.STATION_KEEP.DEFAULT_STANDOFF,
            Math.min(Constants.STATION_KEEP.MAX_STANDOFF,
              _dSz * Constants.STATION_KEEP.DEFAULT_STANDOFF_MULT));
          const _thresh = Math.max(_so * 2, this.config.bodyDims[2] * 15) * M;
          if (_dist < _thresh) {
            this._transitionTo(S.APPROACH);
            eventBus.emit(Events.COMMS_MESSAGE, {
              text: `${this.displayName}: Beginning final approach`,
              priority: 'info',
            });
          }
        }
      }
      return; // skip autopilot logic (pings, thruster audio, etc.)
    }

    const targetPos = this._getTargetScenePos();
    if (!targetPos) {
      this.recall();
      return;
    }
    const toTarget = this._tmpVec.subVectors(targetPos, this.position);
    const dist = toTarget.length();

    // Phase 8: Track starting distance for approach beep fraction
    if (this._startingDistance === 0 || dist > this._startingDistance) {
      this._startingDistance = dist;
    }
    // Phase 8: Emit approach ping with distance fraction
    if (this._startingDistance > 0) {
      const distFraction = Math.min(1, dist / this._startingDistance);
      eventBus.emit(Events.ARM_APPROACH_PING, { distanceFraction: distFraction, armId: this.id });
    }

    // Update tether length
    this.tetherLength = this.position.distanceTo(parentPos) / M;

    // Check tether limit (skip for detached arms — free-flying)
    if (!this.isDetached && this.tetherLength >= this.config.tetherMax * 0.95) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Tether limit (${Math.round(this.config.tetherMax)}m). Recalling`,
        priority: 'warning',
      });
      // Phase 6: Signal tutorial system that tether limit was hit (detach hint trigger)
      eventBus.emit(Events.TUTORIAL_TETHER_LIMIT, { armId: this.id });
      this.recall();
      return;
    }

    // ── Proportional controller with velocity matching ──
    // Mirrors mother AutopilotSystem.js control law (§D quadratic braking + relV).
    // arm.velocity is in the parent co-moving frame (orbital frame correction at
    // line 1831 adds parentDelta each frame). driftVel compensates for the
    // different orbit of the target vs parent.
    const DAP_T = Constants.DAUGHTER_AUTOPILOT;

    // Orbital drift velocity: how the target moves relative to parent frame
    // Raw finite-difference is noisy (catastrophic cancellation when tDelta ≈ pDelta
    // for co-orbiting objects). EMA smoothing eliminates frame-to-frame jitter.
    let rawDriftVel = _driftRaw.set(0, 0, 0);
    if (this._prevTargetScenePos && this._prevParentPos && parentPos && dt > 0) {
      const tDelta = _driftTDelta.subVectors(targetPos, this._prevTargetScenePos);
      const pDelta = _driftPDelta.subVectors(parentPos, this._prevParentPos);
      rawDriftVel = tDelta.sub(pDelta).divideScalar(dt);
    }
    if (!this._prevTargetScenePos) this._prevTargetScenePos = targetPos.clone();
    else this._prevTargetScenePos.copy(targetPos);

    // EMA-smooth the drift velocity (shared across TRANSIT/APPROACH via instance field)
    if (!this._smoothDriftVel) this._smoothDriftVel = new THREE.Vector3(0, 0, 0);
    const alpha = DAP_T.DRIFT_EMA_ALPHA || 0.1;
    this._smoothDriftVel.lerp(rawDriftVel, alpha);
    const driftVelT = this._smoothDriftVel;

    // Velocity error: when relV → 0, arm matches target orbital velocity
    const relVT = _relVel.subVectors(driftVelT, this.velocity);

    // Quadratic braking: v*(r) = min(V_CAP, √(2·A_BRAKE·posErr))
    // V_CAP = actual launch speed so the arm COASTS, never accelerates beyond spring speed
    const posErrM = dist / M;
    const effectiveVCap = this._launchSpeedMps || DAP_T.V_CAP;
    const aBrakeT = DAP_T.MAX_ACCEL * DAP_T.BRAKE_FRACTION;
    const vStarMT = Math.min(effectiveVCap, Math.sqrt(2 * aBrakeT * posErrM));
    const vStarT = vStarMT * M; // scene units/s

    // Velocity control error = goalDir × v* + relV
    const goalDirT = _goalDir.copy(toTarget).normalize();
    const velCtrlErrT = goalDirT.multiplyScalar(vStarT).add(relVT);

    // Commanded impulse = KP × velCtrlErr, clamped by MAX_ACCEL × gameDt
    const dvCmdT = velCtrlErrT.multiplyScalar(DAP_T.KP_VEL);
    const gameDtT = dt * TimeAuthority.BASE_SCALE;
    const maxDvT = DAP_T.MAX_ACCEL * M * gameDtT;
    const dvMagT = dvCmdT.length();
    if (dvMagT > maxDvT && dvMagT > 1e-18) dvCmdT.multiplyScalar(maxDvT / dvMagT);

    // Apply thrust impulse (NOT lerp — direct impulse like mother autopilot)
    this.velocity.add(dvCmdT);
    this.position.addScaledVector(this.velocity, dt);
    // Item 100: meter the APPLIED impulse (post-clamp) for impulse-priced fuel
    this._impulseDvAccum += Math.min(dvMagT, maxDvT) / M;

    // Close enough for fine approach — threshold must be >= standoff distance
    // so APPROACH controller has room to decelerate before reaching standoff.
    const debrisSizeT = (this.target && this.target.sizeMeter) || 1;
    const standoffT = Math.max(
      Constants.STATION_KEEP.DEFAULT_STANDOFF,
      Math.min(Constants.STATION_KEEP.MAX_STANDOFF, debrisSizeT * Constants.STATION_KEEP.DEFAULT_STANDOFF_MULT)
    );
    const approachThreshold = Math.max(standoffT * 2, this.config.bodyDims[2] * 15) * M;
    if (dist < approachThreshold) {
      this._transitionTo(S.APPROACH);
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Beginning final approach`,
        priority: 'info',
      });
    }
  }

  /** APPROACH: fine approach — slower, match velocity */
  _updateApproach(dt, parentPos) {
    if (this._manualMode) {
      // Manual mode: coast with current velocity. Autopilot (proportional
      // controller, approach pings, thruster audio) intentionally skipped
      // to suppress annoying beep/hum in ARM_PILOT mode.
      this.position.addScaledVector(this.velocity, dt);
      if (parentPos) {
        this.tetherLength = this.position.distanceTo(parentPos) / M;
        if (!this.isDetached && this.tetherLength > this.config.tetherMax) {
          const dir = _tetherDir.subVectors(this.position, parentPos).normalize();
          this.position.copy(parentPos).add(dir.multiplyScalar(this.config.tetherMax * M));
          const velAlongTether = this.velocity.dot(dir);
          if (velAlongTether > 0) {
            this.velocity.addScaledVector(dir, -velAlongTether);
          }
        }
      }
      // ── STILL CHECK SK GATE even in manual mode ──
      // enableManual() fires during LAUNCH_CEREMONY_COMPLETE while the arm
      // is still in APPROACH. Without this gate the arm coasts through the
      // debris and never enters STATION_KEEP.
      // Distance-only check (no velocity gate): manual mode skips the
      // proportional braking controller, so the arm arrives at high velocity.
      // The SK lerp (0.8/frame) converges in ~3 frames — imperceptible.
      if (this.target) {
        const _tPos = this._getTargetScenePos();
        if (_tPos) {
          const _distM = _tPos.distanceTo(this.position) / M;
          const _dSz = (this.target.sizeMeter) || 1;
          const _so = Math.max(Constants.STATION_KEEP.DEFAULT_STANDOFF,
            Math.min(Constants.STATION_KEEP.MAX_STANDOFF,
              _dSz * Constants.STATION_KEEP.DEFAULT_STANDOFF_MULT));
          const _gateDist = _so * (Constants.STATION_KEEP.ENTRY_DISTANCE_MULT || 2.0);
          if (_distM <= _gateDist) {
            this._transitionTo(S.STATION_KEEP);
            this._stationKeepTarget = this.target;
            if (this.target) this.target._isStationKeepTarget = true;
            // Enter at actual arrival distance, ease to nominal (same as autopilot
            // path) so the position lerp doesn't snap the camera. Manual mode skips
            // braking so _distM can be well outside the band — settling matters most here.
            this._standoffR = _distM;
            this._standoffTargetR = _so;
            this._standoffSettling = true;
            this._initSkFrame(_tPos);
            // Use accumulated drift if available (from TRANSIT before manual)
            const _drift = this._smoothDriftVel;
            if (_drift && _drift.lengthSq() > 0) {
              this.velocity.copy(_drift);
            } else {
              this.velocity.set(0, 0, 0);
            }
            eventBus.emit(Events.STATION_KEEP_ENTERED, {
              armId: this.id,
              armType: this.type,
              armIndex: this.index,
              targetId: this.target.id || this.target.catalogId,
              standoffR: _so,
              isPiloted: this.isManual(),
              tool: this.selectedTool,   // the recommended tool (refreshed on SK entry): the holding line names it
            });
            return;
          }
        }
      }
      return; // skip autopilot logic (pings, thruster audio, etc.)
    }

    const targetPos = this._getTargetScenePos();
    if (!targetPos) { this.recall(); return; }
    const toTarget = this._tmpVec.subVectors(targetPos, this.position);
    const dist = toTarget.length();

    // Phase 8: Emit approach ping (in APPROACH, distance fraction is always low)
    if (this._startingDistance > 0) {
      const distFraction = Math.min(1, dist / this._startingDistance);
      eventBus.emit(Events.ARM_APPROACH_PING, { distanceFraction: distFraction, armId: this.id });
    }

    // ── Proportional controller with standoff-aware braking ──
    // Same control law as TRANSIT but v* brakes to standoff distance (not zero).
    const DAP_A = Constants.DAUGHTER_AUTOPILOT;

    // Standoff distance
    const debrisSize = (this.target && this.target.sizeMeter) || 1;
    const standoff = Math.max(
      Constants.STATION_KEEP.DEFAULT_STANDOFF,
      Math.min(Constants.STATION_KEEP.MAX_STANDOFF, debrisSize * Constants.STATION_KEEP.DEFAULT_STANDOFF_MULT)
    );
    const distMetres = dist / M;

    // Orbital drift velocity — EMA-smoothed (shared with TRANSIT via _smoothDriftVel)
    let rawDriftVelA = _driftRaw.set(0, 0, 0);
    const targetScenePos = this._getTargetScenePos();
    if (targetScenePos && this._prevTargetScenePos && this._prevParentPos && parentPos && dt > 0) {
      const tDelta = _driftTDelta.subVectors(targetScenePos, this._prevTargetScenePos);
      const pDelta = _driftPDelta.subVectors(parentPos, this._prevParentPos);
      rawDriftVelA = tDelta.sub(pDelta).divideScalar(dt);
    }
    if (targetScenePos) {
      if (!this._prevTargetScenePos) this._prevTargetScenePos = targetScenePos.clone();
      else this._prevTargetScenePos.copy(targetScenePos);
    }

    // EMA-smooth the drift velocity (continues from TRANSIT's accumulation)
    if (!this._smoothDriftVel) this._smoothDriftVel = new THREE.Vector3(0, 0, 0);
    const alphaA = DAP_A.DRIFT_EMA_ALPHA || 0.1;
    this._smoothDriftVel.lerp(rawDriftVelA, alphaA);
    const driftVelA = this._smoothDriftVel;

    // Velocity error
    const relVA = _relVel.subVectors(driftVelA, this.velocity);

    // Signed excess distance: positive = outside standoff, negative = inside
    // Inside standoff → restoring spring pushes arm back OUT (fixes no-retreat bug)
    const signedExcess = distMetres - standoff;
    const absExcess = Math.abs(signedExcess);
    const aBrakeA = DAP_A.MAX_ACCEL * DAP_A.BRAKE_FRACTION;
    const vStarMA = Math.min(DAP_A.V_CAP * 0.3, Math.sqrt(2 * aBrakeA * absExcess));
    const vStarA = vStarMA * M;

    // Velocity control error + commanded impulse
    // goalDir toward target when outside standoff; AWAY from target when inside
    const goalDirA = _goalDir.copy(toTarget).normalize();
    // approach: drive toward target (+vStarA); retreat: drive away (−vStarA)
    const posCmd = _posCmd.copy(goalDirA).multiplyScalar(signedExcess >= 0 ? vStarA : -vStarA);
    const velCtrlErrA = posCmd.add(relVA);
    const dvCmdA = velCtrlErrA.multiplyScalar(DAP_A.KP_VEL);
    const gameDtA = dt * TimeAuthority.BASE_SCALE;
    const maxDvA = DAP_A.MAX_ACCEL * M * gameDtA;
    const dvMagA = dvCmdA.length();
    if (dvMagA > maxDvA && dvMagA > 1e-18) dvCmdA.multiplyScalar(maxDvA / dvMagA);

    // Wave1 (visual-only): brake read for the plume mapping — the commanded
    // impulse OPPOSING current travel means the FEEP exhaust points at the
    // target (nose/+Z tracks the target in APPROACH), i.e. the FORE nozzle
    // fires. Sampled BEFORE velocity.add so it reflects this frame's command
    // against this frame's travel; smoothed (~1/8 s) so controller dither
    // around standoff crossfades instead of strobing. Magnitude floor keeps
    // steady-state noise from flaring anything.
    const _brakingA = dvMagA > 1e-15 && dvCmdA.dot(this.velocity) < 0;
    this._approachBrake01 += ((_brakingA ? 1 : 0) - this._approachBrake01) * Math.min(1, dt * 8);

    this.velocity.add(dvCmdA);
    this.position.addScaledVector(this.velocity, dt);
    // Item 100: meter the APPLIED impulse (post-clamp) for impulse-priced fuel
    this._impulseDvAccum += Math.min(dvMagA, maxDvA) / M;

    // ── Epic 8: Check for STATION_KEEP entry before netting ──
    if (this.target && !this._manualMode) {
      // Relative velocity to TARGET using EMA-smoothed drift (not raw — avoids noise).
      // At steady state, arm.velocity ≈ smoothDriftVel, so relVelToTarget → 0.
      const relVel = this.velocity.distanceTo(driftVelA) / M;

      // SK entry gate — distance + velocity thresholds.  Both are constants
      // so they can be tuned without code changes (debug session 2026-05-09:
      // distance widened 1.3→2.0×, velocity 2.0→3.0 m/s after observing arms
      // parking at dist=17m / relV=1.9m/s, which were JUST outside the old
      // 13m / 2.0m/s gate so SK never triggered).
      const _SK_DIST_MULT = Constants.STATION_KEEP.ENTRY_DISTANCE_MULT;
      const _SK_GATE_DIST = standoff * _SK_DIST_MULT;
      const _SK_GATE_VEL  = Constants.STATION_KEEP.ENTRY_MAX_VELOCITY;

      if (distMetres <= _SK_GATE_DIST && relVel < _SK_GATE_VEL) {
        this._transitionTo(S.STATION_KEEP);
        this._stationKeepTarget = this.target;
        // Mark debris so DebrisField LOD won't scale it to 0 when mother orbits far away
        if (this.target) this.target._isStationKeepTarget = true;
        // Enter at the ACTUAL arrival distance and ease in to the nominal
        // standoff (see _updateStationKeep settle block + STANDOFF_SETTLE_TAU_S).
        // The gate fires at up to 2× standoff while still closing, so setting
        // _standoffR = standoff here would make the 0.8/frame position lerp snap
        // the whole gap in ~3 frames and jerk the welded pilot camera.
        this._standoffR = distMetres;
        this._standoffTargetR = standoff;
        this._standoffSettling = true;

        // Capture the frozen entry frame so arrow keys map cleanly to
        // screen-axes (left/right = pure horizontal screen motion, up/down =
        // pure vertical, no tilt or roll regardless of orbit inclination).
        // _initSkFrame establishes _skPolarAxis / _skEquator0 / _skRightVec /
        // _skPitch0 from current geometry; θ and φ start at 0 (= entry pose).
        const _skTargetPos = this._getTargetScenePos();
        this._initSkFrame(_skTargetPos);
        // Initialize velocity to the EMA-smoothed orbital drift (debris frame
        // velocity), NOT zero.  STATION_KEEP uses lerp positioning, but the
        // parent-frame correction in update() shifts the daughter by mother's
        // delta each frame.  If velocity were zeroed, the daughter would lag
        // the debris by mother's drift each frame and the lerp would have to
        // continuously chase.  Setting velocity = drift means the daughter is
        // already co-moving with the debris on entry — the lerp only has to
        // correct sub-frame position errors, not velocity errors.
        // (driftVelA is in scene units / second; this.velocity is too.)
        if (driftVelA && driftVelA.lengthSq() > 0) {
          this.velocity.copy(driftVelA);
        } else {
          this.velocity.set(0, 0, 0);
        }
        eventBus.emit(Events.STATION_KEEP_ENTERED, {
          armId: this.id,
          armType: this.type,
          armIndex: this.index,
          targetId: this.target.id || this.target.catalogId,
          standoffR: standoff,
          isPiloted: this.isManual(),
          tool: this.selectedTool,   // the recommended tool (refreshed on SK entry): the holding line names it
        });
        return;
      }
    }

    // Close enough for net deployment
    const netThreshold = this.config.bodyDims[2] * M * 5;
    if (dist < netThreshold) {
      this._transitionTo(S.NETTING);
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Deploying ${this.config.netSize}m net`,
        priority: 'info',
      });
    }
  }

  // =========================================================================
  // STATION_KEEP — orbital-crane hold position around debris (Epic 8)
  // =========================================================================

  /** STATION_KEEP: hold spherical orbit around target debris */
  _updateStationKeep(dt) {
    const SK = Constants.STATION_KEEP;
    const target = this._stationKeepTarget;

    // Ensure mesh stays visible during STATION_KEEP
    this.mesh.visible = true;

    // If target lost, exit — check _scenePosition (instanced debris have no .mesh)
    if (!target || (!target._scenePosition && !target.mesh)) {
      this._exitStationKeep('lost');
      return;
    }

    // Phase 1b (capture-feedback overhaul): live odds refresh at REFRESH_HZ.
    // The displayed value eases toward this truth in DockingReticle — this is
    // the "watch the odds climb while de-spinning" feedback loop.
    if (Constants.isFeatureEnabled('DAUGHTER_MULTITOOL')) {
      this._toolOddsTimer += dt;
      const interval = 1 / ((Constants.TOOL_ODDS && Constants.TOOL_ODDS.REFRESH_HZ) || 10);
      if (this._toolOddsTimer >= interval) {
        this._toolOddsTimer = 0;
        this._refreshToolOdds();
      }
      // Phase 3c: MAGNET secondary — eddy-current detumble on conductive targets.
      this._updateEddyDamp(dt, target);
    }

    // Update spherical coordinates from input rates
    this._orbitTheta += this._thetaRate * dt;
    this._orbitPhi += this._phiRate * dt;
    this._standoffR += this._radiusRate * dt;

    // ── Standoff settle-in (smooth SK entry) ──
    // On entry _standoffR is the ACTUAL arrival distance (often well outside the
    // nominal standoff because the SK gate fires at ENTRY_DISTANCE_MULT × standoff
    // while the daughter is still closing). Ease it down to the nominal target so
    // the goal recedes inward smoothly instead of letting the 0.8/frame position
    // lerp snap the whole gap in ~3 frames (which jerks the welded pilot camera).
    // Any pilot radius input cancels the settle and hands over manual control.
    if (this._standoffSettling) {
      if (Math.abs(this._radiusRate) > 1e-4) {
        // Pilot took manual radius control. Hand over, but if the daughter is
        // still outside the band keep easing inward (target = _rMax) so the
        // clamp below can't snap an out-of-band radius down in a single frame.
        this._standoffTargetR = Math.min(this._standoffR, this._rMax);
        this._standoffSettling = this._standoffR > this._rMax;
      } else {
        const tauR = SK.STANDOFF_SETTLE_TAU_S || 0.6;
        const kR = 1 - Math.exp(-dt / tauR);
        this._standoffR += (this._standoffTargetR - this._standoffR) * kR;
        if (Math.abs(this._standoffR - this._standoffTargetR) < 0.05) {
          this._standoffR = this._standoffTargetR;
          this._standoffSettling = false;
        }
      }
    }

    // ── Pattern-C auto-return (dwell-then-ease) ──
    // Pilot-friendly recovery: daughter holds her position for a quiet window
    // after the pilot releases the arrows, THEN gently eases back toward the
    // entry pose.  Any new arrow input cancels the ease and resets the dwell.
    const _hasInput = Math.abs(this._thetaRate) > 1e-4
                   || Math.abs(this._phiRate) > 1e-4
                   || Math.abs(this._radiusRate) > 1e-4;
    if (_hasInput) {
      // Any pilot input → cancel auto-return entirely, reset the dwell clock
      this._skIdleS = 0;
    } else {
      this._skIdleS = (this._skIdleS || 0) + dt;
      // Idle but inside dwell window: hold position. Idle past dwell: ease back.
      const dwell = SK.AUTO_RETURN_DWELL_S || 3.0;
      const tauSlow = SK.AUTO_RETURN_TIME_CONSTANT_S || 4.0;
      let tau = null;
      if (this._skIdleS >= dwell) {
        tau = tauSlow;
      }
      if (tau !== null) {
        const k = 1 - Math.exp(-dt / tau);
        this._orbitTheta += (0 - this._orbitTheta) * k;
        this._orbitPhi   += (0 - this._orbitPhi)   * k;
        // Dead-zone snap so we don't asymptote forever.
        const deadRad = (SK.AUTO_RETURN_DEADZONE_DEG || 2.0) * Math.PI / 180;
        if (Math.abs(this._orbitTheta) < deadRad && Math.abs(this._orbitPhi) < deadRad) {
          this._orbitTheta = 0;
          this._orbitPhi   = 0;
        }
      }
    }

    // Clamp phi delta to pitch swing limit (re-using MAX_LATITUDE -
    // TETHER_SAFETY_MARGIN as the half-angle).  Same physical meaning as
    // before: prevents the pilot from pitching so far the daughter goes
    // behind the debris or wraps the tether vertically.
    const phiLimit = this._phiMax - (SK.TETHER_SAFETY_MARGIN * Math.PI / 180);
    this._orbitPhi = Math.max(-phiLimit, Math.min(phiLimit, this._orbitPhi));

    // ── Clamp θ delta around entry (tether-tangle + disorientation safety) ──
    // In the frozen entry frame θ is always measured from 0, so the clamp is
    // a simple ±THETA_LIMIT_DEG.  Prevents the pilot from winding the
    // daughter all the way around the debris (tether wrap = critical failure)
    // and from rotating past the mother's peripheral view (disorientation).
    const thetaLimitRad = (SK.THETA_LIMIT_DEG || 120) * Math.PI / 180;
    this._orbitTheta = Math.max(-thetaLimitRad, Math.min(thetaLimitRad, this._orbitTheta));

    // Clamp radius. While settling-in from a wide SK entry the arrival distance
    // can exceed _rMax — only enforce the lower bound so the ease can bring it
    // down through the band; once settled the normal [_rMin,_rMax] clamp holds.
    if (this._standoffSettling) {
      this._standoffR = Math.max(this._rMin, this._standoffR);
    } else {
      this._standoffR = Math.max(this._rMin, Math.min(this._rMax, this._standoffR));
    }

    // Target position in scene coordinates — use _scenePosition (orbit-propagated)
    // not mesh.position which may be stale or floating-origin-adjusted for instanced debris
    const targetPos = target._scenePosition || (target.mesh && target.mesh.position);
    if (!targetPos) {
      this._exitStationKeep('lost');
      return;
    }

    // Lazy-init entry frame if missing (e.g. unit tests that set _orbitTheta
    // directly without going through the SK entry transition).
    if (!this._skPolarAxis) this._initSkFrame(targetPos);

    // ── Compute goal position in the frozen entry frame ──
    // yaw   = rotation around _skPolarAxis (screen-up at entry)
    // pitch = rotation around the rotated _skRightVec (screen-right at entry)
    // Effect for the pilot:
    //   ← / →  rotate purely horizontally in screen space, no tilt
    //   ↑ / ↓  rotate purely vertically   in screen space, no tilt
    const _yaw = this._orbitTheta;
    const _totalPitch = this._skPitch0 + this._orbitPhi;
    const _cosY = Math.cos(_yaw), _sinY = Math.sin(_yaw);
    const _cosP = Math.cos(_totalPitch), _sinP = Math.sin(_totalPitch);
    const _eqX = this._skEquator0.x * _cosY + this._skRightVec.x * _sinY;
    const _eqY = this._skEquator0.y * _cosY + this._skRightVec.y * _sinY;
    const _eqZ = this._skEquator0.z * _cosY + this._skRightVec.z * _sinY;
    const _ox  = _eqX * _cosP + this._skPolarAxis.x * _sinP;
    const _oy  = _eqY * _cosP + this._skPolarAxis.y * _sinP;
    const _oz  = _eqZ * _cosP + this._skPolarAxis.z * _sinP;
    const _Rscene = this._standoffR * M;
    let goalX = targetPos.x + _ox * _Rscene;
    let goalY = targetPos.y + _oy * _Rscene;
    let goalZ = targetPos.z + _oz * _Rscene;

    // §11.4 net-fire recoil: while the kick transient is live, the hold goal
    // is displaced by the recoil offset — the daughter is visibly shoved off
    // the hold sphere and eased back as the RCS nulls the kick (the step also
    // bills the FUEL_RATE_MANEUVER-style recovery surcharge). Inactive or
    // flag OFF ⇒ goal untouched, byte-identical hold math.
    if (this._updateRecoilKick(dt)) {
      goalX += this._recoilOffsetM.x * M;
      goalY += this._recoilOffsetM.y * M;
      goalZ += this._recoilOffsetM.z * M;
    }

    // Lerp world position to goal (group.position synced from this.position in update())
    const lerp = SK.STATIONKEEP_LERP_RATE;
    this.position.x += (goalX - this.position.x) * lerp;
    this.position.y += (goalY - this.position.y) * lerp;
    this.position.z += (goalZ - this.position.z) * lerp;

    // Consume fuel — more when maneuvering
    const isManeuver = Math.abs(this._thetaRate) > 0.01 ||
                       Math.abs(this._phiRate) > 0.01 ||
                       Math.abs(this._radiusRate) > 0.01;
    const fuelRate = isManeuver ? SK.FUEL_RATE_MANEUVER : SK.FUEL_RATE_STATIONKEEP;
    this.fuel -= fuelRate * dt;

    // Wave1 (visual-only): latch the plume maneuver-brightening window off the
    // SAME isManeuver read that selects FUEL_RATE_MANEUVER — the plume brightens
    // exactly when the higher burn rate applies. Latched here because the rates
    // are reset at the end of this method, BEFORE _updatePlumes runs.
    if (isManeuver) this._skManeuverGlowS = DAUGHTER_PLUME.MANEUVER_GLOW_S;

    // Fuel depleted → exit
    if (this.fuel <= 0) {
      this.fuel = 0;
      this._exitStationKeep('fuel');
      return;
    }

    // Reset rates each frame (they're set by input events)
    this._thetaRate = 0;
    this._phiRate = 0;
    this._radiusRate = 0;
  }

  // =========================================================================
  // §11.4/§11.3 — DAUGHTER NET-FIRE RECOIL + REACTION-WHEEL ACCOUNTING
  // (FEATURE_FLAGS.DAUGHTER_NET_RECOIL; tuning in Constants.DAUGHTER_NET_RECOIL)
  // =========================================================================

  /**
   * Apply the linear recoil impulse (and §11.3 wheel bookkeeping) for a
   * daughter net launch. Called from _updateNettingFSM at the ONE production
   * fire site, immediately after fireDaughterNet succeeds — the mother pod
   * path (PlayerSatellite._applyMotherNetRecoil) is untouched.
   *
   * Δv = m_net · LAUNCH_SPEED / m_daughter, derived LIVE from the fired net's
   * class object and this arm's config.mass (§11.4: ≈1.03 m/s MEDIUM/Weaver,
   * ≈0.57 m/s SMALL/Spinner) — never hardcoded. The impulse seeds the
   * critically-damped transient integrated by _updateRecoilKick; the net's
   * own flight/capture math is untouched (it re-anchors on the live muzzle,
   * so the kicked launcher frame is expected and shared).
   *
   * @param {object} netClass  — CAPTURE_NET class object ({ MASS, LAUNCH_SPEED, CODE })
   * @param {{x:number,y:number,z:number}} launchDir — fired direction (unit, world axes)
   * @returns {number} applied |Δv| in m/s (0 when gated off / degenerate input)
   */
  applyNetFireRecoil(netClass, launchDir) {
    if (!Constants.isFeatureEnabled('DAUGHTER_NET_RECOIL')) return 0;
    const mNet = netClass && netClass.MASS;
    const vNet = netClass && netClass.LAUNCH_SPEED;
    const mArm = this.config?.mass;
    if (!(mNet > 0) || !(vNet > 0) || !(mArm > 0)) return 0;
    const dx = launchDir?.x || 0, dy = launchDir?.y || 0, dz = launchDir?.z || 0;
    const dLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(dLen > 1e-9)) return 0;

    const dvMps = (mNet * vNet) / mArm;
    // Impulse opposes the launch direction. Accumulates into any live
    // transient (rapid double-fire kicks stack, honestly).
    const kx = -(dx / dLen) * dvMps;
    const ky = -(dy / dLen) * dvMps;
    const kz = -(dz / dLen) * dvMps;
    this._recoilVelMps.x += kx;
    this._recoilVelMps.y += ky;
    this._recoilVelMps.z += kz;
    this._recoilActive = true;

    // ── §11.3 wheel: firing on a saturated wheel forces a paid RCS desat
    // burn (dump first, then take the new fire's increment).
    const REC = Constants.DAUGHTER_NET_RECOIL;
    if (this._wheelMomentum >= REC.WHEEL_SATURATION_THRESHOLD) {
      this.fuel = Math.max(0, this.fuel - REC.WHEEL_DESAT_FUEL_COST);
      this._wheelMomentum = Math.max(0, this._wheelMomentum - REC.WHEEL_DESAT_DUMP);
    }
    this._wheelMomentum += REC.WHEEL_INCREMENT_PER_FIRE;
    this._refreshWheelSaturation();

    eventBus.emit(Events.ARM_RECOIL_KICK, {
      armIndex: this.index,
      armId: this.id,
      dv: { x: kx, y: ky, z: kz },
      dvMps,
      netClass: netClass.CODE || null,
    });
    return dvMps;
  }

  /**
   * @private Step the recoil transient one frame and bill the RCS recovery
   * surcharge. Called from the two kinematic hold loops (_updateStationKeep +
   * the NETTING hold in _updateNettingFSM) — the loops then displace their
   * hold goal by _recoilOffsetM while this returns true.
   *
   * Exact per-step closed form of the critically-damped system
   * ẍ = −2ωẋ − ω²x (unconditionally stable at any dt):
   *   B = v + ω·x;  x' = (x + B·dt)·e^(−ω·dt);  v' = (v − ω·B·dt)·e^(−ω·dt)
   * Recovery is billed at SK.FUEL_RATE_MANEUVER (the RCS is actively nulling
   * the kick) ON TOP of whatever the hold loop bills — NETTING bills no base
   * fuel, so there the surcharge is the whole (and only) debit.
   * @returns {boolean} true while the transient is live this frame
   */
  _updateRecoilKick(dt) {
    if (!this._recoilActive) return false;
    // Flag flipped OFF mid-transient (dev toggle / REALITY_MODE): drop the
    // kick immediately — OFF means zero displacement and zero billing
    // unconditionally, not "finish the current transient first". Checked
    // after the fast path so the common inactive frame pays nothing.
    if (!Constants.isFeatureEnabled('DAUGHTER_NET_RECOIL')) {
      this._clearRecoilKick();
      return false;
    }
    const REC = Constants.DAUGHTER_NET_RECOIL;
    const w = REC.CONTROLLER_OMEGA;
    const decay = Math.exp(-w * dt);
    const o = this._recoilOffsetM, v = this._recoilVelMps;
    const bx = v.x + w * o.x, by = v.y + w * o.y, bz = v.z + w * o.z;
    o.x = (o.x + bx * dt) * decay;
    o.y = (o.y + by * dt) * decay;
    o.z = (o.z + bz * dt) * decay;
    v.x = (v.x - w * bx * dt) * decay;
    v.y = (v.y - w * by * dt) * decay;
    v.z = (v.z - w * bz * dt) * decay;

    // RCS recovery surcharge (FUEL_RATE_MANEUVER-style accounting).
    const surcharge = Constants.STATION_KEEP.FUEL_RATE_MANEUVER * dt;
    this.fuel = Math.max(0, this.fuel - surcharge);
    this._recoilFuelBilled += surcharge;

    // Settled → snap exactly to zero so billing stops crisply and the hold
    // goal returns to the pure hold-sphere math (no asymptote, no residue).
    if (o.lengthSq() < REC.SETTLE_EPS_OFFSET_M * REC.SETTLE_EPS_OFFSET_M
        && v.lengthSq() < REC.SETTLE_EPS_VEL_MPS * REC.SETTLE_EPS_VEL_MPS) {
      this._clearRecoilKick();
    }
    return true;
  }

  /** @private Zero the recoil transient (settled, or hold loop exited). */
  _clearRecoilKick() {
    this._recoilOffsetM.set(0, 0, 0);
    this._recoilVelMps.set(0, 0, 0);
    this._recoilActive = false;
  }

  /** @private §11.3: bleed wheel momentum (magnetorquers), every state. */
  _tickWheelDecay(dt) {
    if (this._wheelMomentum <= 0) return;
    if (!Constants.isFeatureEnabled('DAUGHTER_NET_RECOIL')) {
      // Flag flipped OFF with residual momentum: neutralize instead of
      // freezing a stale (possibly saturated) reading into getStatus().
      this._wheelMomentum = 0;
      this._wheelSaturated = false;
      return;
    }
    const REC = Constants.DAUGHTER_NET_RECOIL;
    this._wheelMomentum = Math.max(0, this._wheelMomentum - REC.WHEEL_DECAY_PER_S * dt);
    if (this._wheelSaturated
        && this._wheelMomentum < REC.WHEEL_SATURATION_THRESHOLD) {
      this._refreshWheelSaturation();   // falling edge — re-arms the comms warning
    }
  }

  /** @private Recompute the saturation flag; comms only on the rising edge. */
  _refreshWheelSaturation() {
    const REC = Constants.DAUGHTER_NET_RECOIL;
    const sat = this._wheelMomentum >= REC.WHEEL_SATURATION_THRESHOLD;
    if (sat && !this._wheelSaturated) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Reaction wheel saturated — desat burns will cost fuel.`,
        priority: 'warning',
      });
    }
    this._wheelSaturated = sat;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // §11.5 CAPTURE-TORQUE SETTLE (FEATURE_FLAGS.CAPTURE_TORQUE_SETTLE)
  // Derivation + tuning: Constants.CAPTURE_TORQUE_SETTLE. Pure physics
  // helpers (captureAngularMomentum & co) are exported at module scope.
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * @private Seed the capture-torque settle at the daughter net-FSM cinch —
   * the exact moment legacy code freezes tumble for free (the two
   * `_capturedByArm = this` writes in _updateNettingFSM). The target's live
   * spin angular momentum L = Iω becomes a critically-damped wrench of the
   * caught bundle that the tether damps over t_settle = L/τ.
   *
   * Scope (deliberate): daughter NET catches only — mirrors
   * _checkNetIntegrityOnReel's "net-integrity applies to NET catches"
   * doctrine. The mother lasso/berth spine, the legacy CAPTURE_NET-OFF dice
   * path, and the magnet/gripper/pad tool paths keep instant arrest.
   * A zero/near-zero rate seeds nothing (MIN_SEED_RATE_DEG_S), which keeps
   * scenario-pinned attitudes (main.js register item 13) byte-frozen.
   * @param {object} debris — the freshly cinched catch
   */
  _seedCaptureTorqueSettle(debris) {
    if (!Constants.isFeatureEnabled('CAPTURE_TORQUE_SETTLE')) return;
    if (!debris) return;
    const CTS = Constants.CAPTURE_TORQUE_SETTLE;
    const w0 = debris.tumbleRate || 0;                       // rad/s, live (post-lase)
    if (w0 * 180 / Math.PI < CTS.MIN_SEED_RATE_DEG_S) return;
    const L = captureAngularMomentum(debris.mass, debris.sizeMeter, w0);
    const T = captureSettleDuration(L);
    this._settle = {
      debris,
      theta: 0,                        // rad — angular displacement off the cinched pose
      rate: w0,                        // rad/s — residual wrench rate (θ̇), decays to 0
      t: 0,                            // s — elapsed
      T,                               // s — t_settle = clamp(L/τ) for this catch
      lambda: CTS.SETTLE_U / T,        // 1/s — critically-damped decay rate
      seedAngle: debris.tumbleAngle || 0,
      seedRateRad: w0,
      L,                               // N·m·s — telemetry/tests
      I: captureMomentOfInertia(debris.mass, debris.sizeMeter),
    };
  }

  /**
   * @private Step the settle one frame — called from update() in EVERY state
   * (the transient spans GRAPPLED → REELING; external releases can happen in
   * more). Exact per-step closed form of the critically-damped system, the
   * _updateRecoilKick law with one angular DOF:
   *   B = θ̇ + λθ;  θ' = (θ + B·dt)·e^(−λ·dt);  θ̇' = (θ̇ − λ·B·dt)·e^(−λ·dt)
   * Seeded with θ=0, θ̇=ω₀ this is θ(t) = ω₀·t·e^(−λt): the catch wrenches
   * forward to ω₀/(λe) at t = 1/λ, then the tether hauls it back — rendered
   * through debris.tumbleAngle with the same ×TIME_SCALE_GAMEPLAY convention
   * DebrisField._advanceTumble uses for free tumble (visual rate is
   * continuous at the cinch instant). _advanceTumble itself early-returns on
   * _capturedByArm, so this is the sole tumbleAngle writer while held.
   *
   * Ends one of three ways:
   *  - SETTLED (t ≥ T and rendered residue below both snap eps): pose snaps
   *    exactly back to seedAngle and tumbleRate = 0 — L was fully
   *    transferred and dissipated; a later drop stays de-spun (honest).
   *  - RIPPED (strain gate): see _ripNetFromTorque.
   *  - EXTERNAL RELEASE (mass slip, boost rip, manual drop, handoff, snap):
   *    the un-transferred remainder resumes as real tumble.
   */
  _tickCaptureSettle(dt) {
    const st = this._settle;
    if (!st) return;
    // Flag flipped OFF mid-transient (dev toggle / REALITY_MODE): legacy
    // semantics unconditionally — attitude back to the frozen cinch pose,
    // tumbleRate untouched (still ω₀, so a later drop resumes the original
    // tumble exactly as legacy would). Mirrors _updateRecoilKick's OFF path.
    if (!Constants.isFeatureEnabled('CAPTURE_TORQUE_SETTLE')) {
      st.debris.tumbleAngle = st.seedAngle;
      this._settle = null;
      return;
    }
    const debris = st.debris;
    // External release mid-settle: the tether stopped damping — hand the
    // un-transferred remainder back as real tumble and stand down. (Covers
    // _releaseCapturedDebris in all its callers without touching them; on a
    // tether snap the catch keeps _capturedByArm while capturedDebris clears,
    // so the remainder is written now and _advanceTumble resumes it when the
    // delayed EXPENDED release clears the pin.)
    if (this.capturedDebris !== debris || !debris._capturedByArm) {
      this._resumeTumbleFromRemainder(st);
      return;
    }

    const CTS = Constants.CAPTURE_TORQUE_SETTLE;
    const lam = st.lambda;
    const decay = Math.exp(-lam * dt);
    const b = st.rate + lam * st.theta;
    st.theta = (st.theta + b * dt) * decay;
    st.rate = (st.rate - lam * b * dt) * decay;
    st.t += dt;

    const TS = TimeAuthority.BASE_SCALE;
    debris.tumbleAngle = st.seedAngle + st.theta * TS;

    // Strain gate — rolled only in the wrench window (GRAPPLED/REELING, the
    // same states that own the NET_STRAIN_* mass checks), only while the
    // residual REAL rate still exceeds the gate.
    const rateDegS = Math.abs(st.rate) * 180 / Math.PI;
    if ((this.state === S.GRAPPLED || this.state === S.REELING)
        && rateDegS > CTS.STRAIN_GATE_DEG_S) {
      const bandT = captureSettleRipBandT(rateDegS);
      if (bandT > 0) {
        const roll = (this._settleRipRollOverride != null)
          ? this._settleRipRollOverride : Math.random();
        if (roll < CTS.RIP_PROB_PER_S * bandT * dt) {
          this._ripNetFromTorque(st, rateDegS, bandT);
          return;
        }
      }
    }

    // Settled → snap crisply (no asymptote, no residue): T reached and the
    // RENDERED residue is sub-degree on both channels.
    if (st.t >= st.T
        && Math.abs(st.theta) * TS < CTS.SNAP_EPS_THETA_RAD
        && Math.abs(st.rate) * TS < CTS.SNAP_EPS_RATE_RAD_S) {
      debris.tumbleAngle = st.seedAngle;   // pose exactly back on the cinch
      debris.tumbleRate = 0;               // L fully transferred — catch is de-spun
      this._settle = null;
    }
  }

  /**
   * @private The wrench rips the net (strain gate) — recoverable, the
   * _ripNetDuringBoost idiom: debris drifts free and re-capturable with its
   * tumble RESUMED from the un-transferred remainder; the daughter keeps her
   * tether and returns to reload. This consequence is what makes the despin
   * laser mechanically necessary: lasing below STRAIN_GATE_DEG_S before
   * netting removes the roll entirely.
   * @param {object} st — live settle state
   * @param {number} rateDegS — residual wrench rate at the rip (°/s, real)
   * @param {number} bandT — rip band 0..1 at the rip (event telemetry)
   */
  _ripNetFromTorque(st, rateDegS, bandT) {
    const debris = this.capturedDebris;
    if (!debris) return;
    const CTS = Constants.CAPTURE_TORQUE_SETTLE;
    // Remainder first (writes tumbleRate/axis), then release (clears pins so
    // DebrisField._advanceTumble resumes advancing it next frame).
    this._resumeTumbleFromRemainder(st);
    this._releaseCapturedDebris({ keepPinned: false });
    eventBus.emit(Events.NET_FAILED, {
      armId: this.id, armIndex: this.index,
      debrisId: debris.id, strain: bandT, oversized: false, recoverable: true,
      cause: 'capture_settle', tumbleDegS: rateDegS,
    });
    // Same staging hook as the boost rip — CaptureNetVisual tears a wedge,
    // audio/comms/teaching hang off the event.
    eventBus.emit(Events.NET_TORN, {
      armId: this.id, armIndex: this.index,
      debrisId: debris.id, strain: bandT,
    });
    // fail-reel: the cause stays; REEL_HOME winds her home (or holds her near the piece beyond 500 m), else RETURNING
    this._finishFailedCatch({
      cause: `Net RIPPED: catch still tumbling at ${rateDegS.toFixed(0)}°/s and the wrench tore the weave. `
        + `Debris drifting free, spin resumed. Lase it below ${CTS.STRAIN_GATE_DEG_S.toFixed(0)}°/s before the next net.`,
      legacy: {
        text: `${this.displayName}: Net RIPPED — catch still tumbling at `
          + `${rateDegS.toFixed(0)}°/s and the wrench tore the weave. Debris drifting `
          + `free, spin resumed. Lase it below ${CTS.STRAIN_GATE_DEG_S.toFixed(0)}°/s `
          + 'before the next net.',
        priority: 'warning',
      },
      holdTarget: debris,
    });
  }

  /**
   * @private Hand the un-transferred remainder of the settle back to the
   * debris as real tumble and stand the transient down. θ̇ < 0 means the rip
   * happened mid counter-swing (the tether was hauling the catch back), so
   * the resumed tumble spins the other way: flip the axis, keep the rate
   * magnitude. tumbleAngle stays at the displaced pose — the body rips free
   * mid-wrench, continuously. _initialTumbleRate is deliberately untouched
   * (E1 despin doctrine: spawn history is frozen).
   * @param {object} st — live settle state
   */
  _resumeTumbleFromRemainder(st) {
    const debris = st.debris;
    const rem = Math.abs(st.rate);
    debris.tumbleRate = rem;
    if (st.rate < 0 && rem > 0 && debris.tumbleAxis) {
      const ax = debris.tumbleAxis;
      if (typeof ax.negate === 'function') ax.negate();
      else { ax.x = -ax.x; ax.y = -ax.y; ax.z = -ax.z; }
    }
    this._settle = null;
  }


  /**
   * @private Initialise the frozen SK entry frame so arrow keys map to
   * screen-aligned yaw/pitch.
   *
   * Establishes an orthonormal triad at the moment the daughter parks at
   * the debris:
   *   _skPolarAxis  — Earth-radial at the debris (camera-up).  Aligns the
   *                   game's "up" with the player's "up" regardless of
   *                   orbit inclination, so the screen never rolls during
   *                   sweep.
   *   _skEquator0   — direction from debris→arm projected perpendicular to
   *                   the polar axis (the entry "forward in the equator
   *                   plane").  θ=0 reproduces the arrival pose.
   *   _skRightVec   — equator0 × polarAxis = camera-right at entry.
   *                   +θ moves the daughter in this direction so → arrow
   *                   key produces pure screen-right motion.
   *   _skPitch0     — the entry pose's pitch angle from the equator plane;
   *                   added to φ when computing the final pose so the
   *                   daughter does not snap if she arrived above/below
   *                   the equator.
   * @param {THREE.Vector3} targetPos — debris _scenePosition (scene units)
   */
  _initSkFrame(targetPos) {
    if (!targetPos) {
      // Degenerate — leave defaults so SK can still run with world axes
      this._skPolarAxis = new THREE.Vector3(0, 1, 0);
      this._skEquator0  = new THREE.Vector3(1, 0, 0);
      this._skRightVec  = new THREE.Vector3(0, 0, 1);
      this._skPitch0    = 0;
      this._orbitTheta  = 0;
      this._orbitPhi    = 0;
      return;
    }

    const debrisToArm = new THREE.Vector3(
      this.position.x - targetPos.x,
      this.position.y - targetPos.y,
      this.position.z - targetPos.z,
    );
    if (debrisToArm.lengthSq() < 1e-20) {
      // Co-located — pick world axes as a degenerate fallback
      this._skPolarAxis = targetPos.clone().normalize();
      if (this._skPolarAxis.lengthSq() < 1e-12) this._skPolarAxis.set(0, 1, 0);
      this._skEquator0  = new THREE.Vector3(1, 0, 0);
    } else {
      debrisToArm.normalize();
      this._skPolarAxis = targetPos.clone();
      if (this._skPolarAxis.lengthSq() < 1e-12) this._skPolarAxis.set(0, 1, 0);
      this._skPolarAxis.normalize();
      const dotP = debrisToArm.dot(this._skPolarAxis);
      // equator0 = debrisToArm projected onto plane perpendicular to polar
      this._skEquator0 = debrisToArm.clone()
        .sub(this._skPolarAxis.clone().multiplyScalar(dotP));
      if (this._skEquator0.lengthSq() < 1e-8) {
        // Edge case: arm directly above/below the polar pole — fall back to
        // an arbitrary perpendicular vector
        const _alt = Math.abs(this._skPolarAxis.x) < 0.9
          ? new THREE.Vector3(1, 0, 0)
          : new THREE.Vector3(0, 1, 0);
        this._skEquator0 = _alt.sub(
          this._skPolarAxis.clone().multiplyScalar(_alt.dot(this._skPolarAxis))
        );
      }
      this._skEquator0.normalize();
      this._skPitch0 = Math.asin(Math.max(-1, Math.min(1, dotP)));
    }
    // right = equator0 × polar (camera-right at entry, so +yaw → screen-right)
    this._skRightVec = new THREE.Vector3()
      .crossVectors(this._skEquator0, this._skPolarAxis).normalize();
    this._orbitTheta = 0;
    this._orbitPhi   = 0;
  }

  /** @private Exit STATION_KEEP and transition to RETURNING */
  _exitStationKeep(reason) {
    eventBus.emit(Events.STATION_KEEP_EXITED, {
      armId: this.id,
      reason: reason,
    });
    // Clear LOD protection flag so normal LOD applies again
    if (this._stationKeepTarget) this._stationKeepTarget._isStationKeepTarget = false;
    this._stationKeepTarget = null;
    // Phase 3c: stop eddy damping + clear the target's HUD flags
    // (_despinning is safe to clear — DespinLaser re-asserts it each frame)
    if (this._eddyTarget) {
      this._eddyTarget._eddyDamping = false;
      this._eddyTarget._despinning = false;
    }
    this._eddyTarget = null;
    this._eddyActive = false;
    this._thetaRate = 0;
    this._phiRate = 0;
    this._radiusRate = 0;
    this._standoffSettling = false;
    // Release the frozen entry frame so the next SK entry captures fresh axes
    this._skPolarAxis = null;
    this._skEquator0  = null;
    this._skRightVec  = null;
    this._skPitch0    = 0;
    this._skIdleS     = 0;
    // Review F1 (fail-reel): on her strut line (REEL_HOME on, tethered) the piece being gone winds her home on the reel,
    // never the slow FEEP flight. 'fuel' and the player's explicit FEEP 'recall' keep their meaning (RETURNING).
    if (reason === 'lost' && this._rhOn()) {
      this._reelHomeAfterFailure();
      return;
    }
    this._transitionTo(S.RETURNING);
  }

  /** Public: Capture debris from STATION_KEEP → NETTING */
  captureFromStationKeep() {
    if (this.state !== S.STATION_KEEP) return false;

    // §13 Q5: Net inventory gate — when CAPTURE_NET is ON and nets exhausted,
    // emit NET_EMPTY_CLICK + click-fail audio + comms message instead of
    // transitioning.  2026-05-28 (Item 8): the prior implementation only
    // emitted NET_EMPTY_CLICK with no user-visible feedback beyond a click-
    // fail sfx — players couldn't tell why F did nothing.  Add a CMD-channel
    // comms message so the comms log explains the failure and points at the
    // remedy (return to mother for reload).
    if (Constants.isFeatureEnabled('CAPTURE_NET') && this._netInventory <= 0) {
      eventBus.emit(Events.NET_EMPTY_CLICK, { armId: this.id });
      audioSystem.playDeny();
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: this.displayName,
        text: DAUGHTER_OUT_OF_NETS_LINE,   // DECISIONS §33 row 8: nets refill only at the resupply stop (not "return to mother")
        channel: 'CMD',
        priority: 'warning',
      });
      return false;
    }

    eventBus.emit(Events.STATION_KEEP_EXITED, {
      armId: this.id,
      reason: 'capture',
    });

    // POLISH FIX: do NOT null _stationKeepTarget here — keeping the reference
    // live during NETTING means our miss-fallback (NETTING → STATION_KEEP) can
    // resume cleanly.  Previously this line was the cause of repeated capture
    // failures: net misses, we fell back to SK, but _stationKeepTarget was
    // already null → SK exited as "lost" → daughter returned home empty.
    // The LOD protection flag also stays on during NETTING (the debris is
    // still the focus of the active capture operation).  Both fields are
    // cleared on _exitStationKeep / recallFromStationKeep / reelFromStationKeep
    // / successful capture (GRAPPLED entry doesn't need them).
    //
    // Issue-B GUARD: snapshot the committed target so the NETTING-FSM
    // miss-fallback can detect "target removed mid-net-flight" and bail out
    // to RETURNING instead of looping back into SK with a stale reference.
    // We also mark the debris itself so DebrisField.removeDebris() can warn
    // when something nukes a debris that has a net committed to it.
    this._netCommittedTarget = this.target || null;
    if (this._netCommittedTarget) {
      this._netCommittedTarget._committedNetArmId = this.id;
    }
    this._captureToolKind = 'NET';
    this._transitionTo(S.NETTING);
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `${this.displayName}: Deploying net. Stand by for capture`,
      priority: 'info',
    });
    return true;
  }

  /** Public: Recall arm from STATION_KEEP → RETURNING (FEEP-powered) */
  recallFromStationKeep() {
    if (this.state !== S.STATION_KEEP) return false;
    this._exitStationKeep('recall');
    return true;
  }

  /** Public: Reel arm from STATION_KEEP → REELING (zero-fuel strut motor).
   *  Use when daughter is out of fuel/nets or player wants to abort without
   *  burning FEEP. The mothership's strut reel motor pulls the daughter back
   *  via tether — no propellant cost.
   */
  reelFromStationKeep() {
    if (this.state !== S.STATION_KEEP) return false;
    eventBus.emit(Events.STATION_KEEP_EXITED, {
      armId: this.id,
      reason: 'reel',
    });
    if (this._stationKeepTarget) this._stationKeepTarget._isStationKeepTarget = false;
    this._stationKeepTarget = null;
    this._thetaRate = 0;
    this._phiRate = 0;
    this._radiusRate = 0;
    this._skPolarAxis = null;
    this._skEquator0  = null;
    this._skRightVec  = null;
    this._skPitch0    = 0;
    this._skIdleS     = 0;
    this._transitionTo(S.REELING);
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `${this.displayName}: Reeling in. Strut motor engaged`,
      priority: 'info',
    });
    return true;
  }

  // ============================================================================
  // DAUGHTER MULTI-TOOL (CP-1 / P2 — DAUGHTER_MULTITOOL_SPEC §5 / §7 / §8)
  // ============================================================================

  /**
   * Recompute the per-arm tool recommendation for the current STATION_KEEP
   * target and default `selectedTool` to the top-scored verb. Stores ★ scores
   * and hint strings the SK tool-selection HUD reads directly off this arm.
   * @private
   */
  _refreshToolRecommendation() {
    const target = this._stationKeepTarget || this.target;
    const netDepleted = (typeof this.getNetInventory === 'function')
      ? this.getNetInventory() <= 0
      : (this._netInventory <= 0);
    const rec = recommendArmTool({
      armType: this.type,
      mass: target ? (target.mass || 0) : 0,
      sizeMeter: target ? (target.sizeMeter || 0) : 0,
      debrisType: target ? (target.type || null) : null,
      ferromagnetic: !!(target && target.ferromagnetic === true),
      hasFerrousFasteners: !!(target && target.hasFerrousFasteners === true),
      hasGrappleFixture: !!(target && target.hasGrappleFixture === true),
      netDepleted,
      // DECISIONS §33 row 7: the small daughter picks her pad by herself when it suits the piece — the rule reads the
      // surface (material -> gecko / hooks adhesion), so the piece's material and roughness must reach the recommender.
      material: target ? target.material : undefined,
      surfaceRoughness: target ? target.surfaceRoughness : undefined,
    });
    this.selectedTool = rec.recommended;
    // Wave-4 QA #3: SK entry is the lock/re-acquire seam — force the odds lock
    // cache to rebuild even if the (possibly pool-recycled) target reference
    // matches, per the invalidation contract (ToolOdds.makeNetOddsLockCache).
    if (this._toolOddsLockCache) this._toolOddsLockCache.valid = false;
    this._refreshToolOdds();               // Phase 1b: seed the odds strip immediately
    eventBus.emit(Events.TOOL_ARMSET_CHANGED, { armId: this.id, toolset: this.toolset.slice() });
    eventBus.emit(Events.TOOL_SELECTED, { armId: this.id, tool: this.selectedTool });
  }

  /**
   * @private Phase 1b (capture-feedback overhaul): recompute the live tool
   * odds for the odds strip. Called on SK entry and at TOOL_ODDS.REFRESH_HZ
   * from _updateStationKeep — the same pure model the resolve rolls use, so
   * de-spinning / closing in visibly moves the numbers ("honest numbers").
   */
  _refreshToolOdds() {
    const target = this._stationKeepTarget || this.target;
    const range = (typeof this._standoffR === 'number' && this._standoffR > 0)
      ? this._standoffR : 50;
    const netCount = (typeof this.getNetInventory === 'function')
      ? this.getNetInventory() : (this._netInventory ?? undefined);
    // Phase 2 (ASPECT_CAPTURE): live presented width along the current
    // approach bearing — the NET % dips/rises as θ sweeps or as the pilot
    // orbits toward end-on.
    let presentedWidthM;
    if (Constants.isFeatureEnabled('ASPECT_CAPTURE') && target
        && target._scenePosition && this.position) {
      const tp = target._scenePosition;
      presentedWidthM = presentedWidthForApproach(target, {
        x: tp.x - this.position.x,
        y: tp.y - this.position.y,
        z: tp.z - this.position.z,
      });
    }
    // Wave-4 QA #3 (CAPTURE_NET.md §10 concern 3): persistent per-arm lock
    // cache — lock-stable cling factors (mode/pBase, roughness, strain) are
    // computed once at target-lock and reused across the 10 Hz refreshes;
    // range/presented-width/projected-spin stay live. Allocated once per arm,
    // never per refresh. Invalidation contract: ToolOdds.makeNetOddsLockCache.
    if (!this._toolOddsLockCache) this._toolOddsLockCache = makeNetOddsLockCache();
    const odds = computeToolOdds({
      armType: this.type,
      toolset: this.toolset,
      target,
      range,
      netCount,
      padUvDoses: this._padUvCureDosesRemaining,
      presentedWidthM,
      lockCache: this._toolOddsLockCache,
    });
    this._toolOdds = odds;
    // Pre-fire FRAG risk for the ⚠FRAG chip (same computeFragRisk the resolve
    // computes at _resolveCatch; Phase 3b rolls it).
    if (target) {
      const netClass = getNetClassForType(this.type);
      this._toolOddsFragRisk = computeFragRisk({
        netMass: netClass.MASS,
        vRel: netClass.LAUNCH_SPEED,
        targetFragility: effectiveFragility(target),
        range,
      });
    } else {
      this._toolOddsFragRisk = 0;
    }
  }

  /**
   * @private Phase 3c (capture-feedback overhaul): eddy-current detumble —
   * the MAGNET's rotating field induces eddy currents in a CONDUCTIVE hull and
   * bleeds tumble at ~⅓ of the mother laser's rate, ≤ EDDY_DAMP.RANGE_M. Runs
   * passively while station-keeping with MAGNET selected (no new key). Counts
   * toward DESPIN_IN_SPEC so the "tumble in spec — net it" loop closes the
   * same way as the laser.
   * @param {number} dt
   * @param {object|null} target — the STATION_KEEP target
   */
  _updateEddyDamp(dt, target) {
    const ED = Constants.EDDY_DAMP;
    const conductive = !!(ED && target
      && Array.isArray(ED.CONDUCTIVE_MATERIALS)
      && ED.CONDUCTIVE_MATERIALS.includes(target.material));
    const active = conductive
      && this.selectedTool === 'MAGNET'
      && (target.tumbleRate || 0) > 0
      && (typeof this._standoffR === 'number' && this._standoffR <= (ED.RANGE_M || 30));

    if (!active) {
      if (this._eddyActive) {
        this._eddyActive = false;
        if (this._eddyTarget) {
          this._eddyTarget._eddyDamping = false;
          // Also clear the shared HUD hint — the laser re-asserts it every
          // frame while firing, so this never fights an active despin beam.
          this._eddyTarget._despinning = false;
        }
        this._eddyTarget = null;
      }
      return;
    }

    if (!this._eddyActive) {
      this._eddyActive = true;
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: this.displayName,
        text: `${this.displayName}: Eddy-current damping engaged. EPM field bleeding tumble (${target.material} hull).`,
        channel: 'CMD', priority: 'info',
      });
    }
    if (this._eddyTarget && this._eddyTarget !== target) this._eddyTarget._eddyDamping = false;
    this._eddyTarget = target;
    target._eddyDamping = true;
    target._despinning = true;   // shared HUD hint (live °/s readouts)

    const before = target.tumbleRate || 0;
    const after = Math.max(0, before - (ED.DESPIN_RATE_RAD_S2 || 0.1) * dt);
    target.tumbleRate = after;

    // Crossed below the net-safe spin → announce once (same loop as the laser).
    const inSpecRad = ((Constants.DESPIN_LASER && Constants.DESPIN_LASER.IN_SPEC_DEG) || 10) * Math.PI / 180;
    if (before > inSpecRad && after <= inSpecRad) {
      eventBus.emit(Events.DESPIN_IN_SPEC, { targetId: target.id ?? null, tumbleDeg: after * 180 / Math.PI });
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: this.displayName,
        text: `${this.displayName}: Tumble in spec. Net it.`,
        channel: 'CMD', priority: 'success',
      });
    }
  }

  /** Cycle `selectedTool` through this arm's toolset (` ` ` backtick in SK). */
  cycleTool() {
    if (!this.toolset || this.toolset.length <= 1) return this.selectedTool;
    const i = this.toolset.indexOf(this.selectedTool);
    const next = this.toolset[(i + 1) % this.toolset.length];
    this.selectedTool = next;
    audioSystem.playClick();
    // Wave1: tool-cycle re-aim — a deployed daughter swapping verbs trims her
    // attitude toward the new tool axis: one cold-gas couple (visual-only).
    if (this.state === S.STATION_KEEP) this._fireAttitudePuffs('tool');
    eventBus.emit(Events.TOOL_SELECTED, { armId: this.id, tool: next });
    return next;
  }

  /** Programmatically select a tool (must be in the arm's toolset). */
  setTool(kind) {
    if (this.toolset && this.toolset.includes(kind)) {
      this.selectedTool = kind;
      eventBus.emit(Events.TOOL_SELECTED, { armId: this.id, tool: kind });
      return true;
    }
    return false;
  }

  /**
   * Dispatch the currently-selected tool from STATION_KEEP (the F key, when
   * DAUGHTER_MULTITOOL is ON). NET → the P1 net path; MAGNET → the P2 EPM
   * grapple; GRIPPER/PAD → graceful "offline" until P3/P4 land.
   * @returns {boolean} true if a dispatch occurred
   */
  dispatchSelectedTool() {
    if (this.state !== S.STATION_KEEP) return false;
    switch (this.selectedTool) {
      case 'MAGNET':  return this.magneticGrapple();
      case 'GRIPPER': return Constants.isFeatureEnabled('WEAVER_GRIPPER') ? this.gripperGrapple() : this._toolOffline('GRIPPER');
      case 'PAD':     return Constants.isFeatureEnabled('SPINNER_PAD')    ? this.padContact()    : this._toolOffline('PAD');
      case 'NET':
      default:        return this.captureFromStationKeep();
    }
  }

  /** @private Graceful feedback for a not-yet-equipped verb (P3/P4). */
  _toolOffline(kind) {
    audioSystem.playDeny();
    eventBus.emit(Events.COMMS_MESSAGE, {
      source: this.displayName,
      text: `${this.displayName}: ${kind} tool offline. Not yet equipped. Cycle (\`) to NET or MAGNET.`,
      channel: 'CMD',
      priority: 'warning',
    });
    return false;
  }

  /** @private Base grip probability for the magnetic EPM against a target. */
  _magnetGripProbability(target) {
    const MAG = Constants.MAGNETIC_GRAPPLE;
    if (!target || (target.mass || 0) > MAG.MAX_DEBRIS_MASS_KG) return 0;
    if (target.ferromagnetic === true) return MAG.P_GRIP_FERROUS;
    if (target.hasFerrousFasteners === true) return MAG.P_GRIP_FASTENERS;
    return MAG.P_GRIP_NON_FERROUS;
  }

  /**
   * Begin a magnetic-grapple attempt from STATION_KEEP (P2). Drives a small
   * sub-FSM (ENERGIZING → CLOSING → GRIP) in `_updateMagneticGrapple`. Emits
   * AUTOPILOT_TARGET_LOCK so CollisionAvoidance exempts the target while the
   * daughter deliberately closes within contact range (§5.1 gotcha).
   * @returns {boolean}
   */
  magneticGrapple() {
    if (this.state !== S.STATION_KEEP) return false;
    const target = this._stationKeepTarget || this.target;
    if (!target) { audioSystem.playDeny(); return false; }

    eventBus.emit(Events.STATION_KEEP_EXITED, { armId: this.id, reason: 'magnet' });
    this._magPhase = 'ENERGIZING';
    this._magTimer = 0;
    this._captureToolKind = 'MAGNET';
    audioSystem.playMagnetic();
    // CA exemption during CLOSING (the arm intentionally drives < 0.5 m to the target).
    // The lock is released centrally on ANY exit from MAGNETIC_GRAPPLE (_transitionTo).
    this._toolLockedDebrisId = target.id;
    eventBus.emit(Events.AUTOPILOT_TARGET_LOCK, { debrisId: target.id });
    eventBus.emit(Events.MAGNETIC_GRIP_ATTEMPT, {
      armId: this.id, targetId: target.id, pBase: this._magnetGripProbability(target),
    });
    eventBus.emit(Events.COMMS_MESSAGE, {
      source: this.displayName, text: `${this.displayName}: Energizing EPM. Closing for magnetic grapple`,
      channel: 'CMD', priority: 'info',
    });
    this._transitionTo(S.MAGNETIC_GRAPPLE);
    return true;
  }

  /** @private MAGNETIC_GRAPPLE sub-FSM: ENERGIZING → CLOSING → GRIP roll. */
  _updateMagneticGrapple(dt) {
    this._magTimer += dt;
    const MAG = Constants.MAGNETIC_GRAPPLE;
    const target = this._stationKeepTarget || this.target;

    // Target gone (removed / captured by another arm) → abort home.
    if (!target || target._captured || target.alive === false) {
      this._failMagneticGrip('standoff');
      return;
    }

    if (this._magPhase === 'ENERGIZING') {
      if (this._magTimer >= MAG.ENERGIZE_PULSE_S) {
        this._magPhase = 'CLOSING';
        this._magTimer = 0;
      }
      return;
    }

    if (this._magPhase === 'CLOSING') {
      const tPos = target._scenePosition;
      if (tPos) {
        this.position.lerp(tPos, Math.min(1, dt * 2.0));
        const distM = this.position.distanceTo(tPos) / M;
        if (distM <= MAG.CONTACT_RANGE_M) {
          this._magPhase = 'GRIP';
          this._magTimer = 0;
          return;
        }
      }
      if (this._magTimer >= MAG.CLOSE_TIMEOUT_S) this._failMagneticGrip('standoff');
      return;
    }

    if (this._magPhase === 'GRIP') {
      if (this._magTimer >= MAG.GRIP_DWELL_S) this._resolveMagnetGrip(target);
    }
  }

  /** @private Resolve the contact P_GRIP roll → GRAPPLED (success) or RETURNING (fail). */
  _resolveMagnetGrip(target) {
    if ((target.mass || 0) > Constants.MAGNETIC_GRAPPLE.MAX_DEBRIS_MASS_KG) {
      this._failMagneticGrip('too_heavy');
      return;
    }
    const ferrous = target.ferromagnetic === true || target.hasFerrousFasteners === true;
    if (!ferrous) {
      // Non-ferrous: residual-flux probability only — but tag the failure clearly.
      const pNF = Constants.MAGNETIC_GRAPPLE.P_GRIP_NON_FERROUS;
      const rollNF = (this._magRollOverride != null) ? this._magRollOverride : Math.random();
      if (rollNF >= pNF) { this._failMagneticGrip('non_ferrous'); return; }
    } else {
      const p = this._magnetGripProbability(target);
      // Test seam: `_magRollOverride` (0..1) forces a deterministic roll.
      const roll = (this._magRollOverride != null) ? this._magRollOverride : Math.random();
      if (roll >= p) { this._failMagneticGrip('p_roll'); return; }
    }

    // ── Grip acquired ── reuse the GRAPPLED → REELING lifecycle (net-integrity
    // is skipped for non-NET catches via the _captureToolKind guard).
    this._magPhase = null;
    eventBus.emit(Events.MAGNETIC_GRIP_ACQUIRED, {
      armId: this.id, targetId: target.id, mass: target.mass || 0,
    });
    this._secureToolCatch(target, 'MAGNET',
      `${this.displayName}: EPM grip secured. Magnetic latch holding. Reeling in.`);
  }

  /** @private Magnetic grip failed/aborted → release lock, return to reload. */
  _failMagneticGrip(reason) {
    const target = this._stationKeepTarget || this.target;
    this._magPhase = null;
    audioSystem.playDeny();
    if (target) {
      eventBus.emit(Events.MAGNETIC_GRIP_FAILED, { armId: this.id, targetId: target.id, reason });
      eventBus.emit(Events.MAGNETIC_RELEASE, { armId: this.id, targetId: target.id });
    }
    // cause (kept under REEL_HOME, where the outcome is reeled home / held) + the old whole line (REEL_HOME off)
    const cause = reason === 'too_heavy'
      ? 'Magnetic grapple failed: target too massive for the EPM.'
      : reason === 'non_ferrous'
        ? 'No magnetic purchase: target is non-ferrous (try the net).'
        : reason === 'standoff'
          ? 'Lost contact on approach: magnetic grapple aborted.'
          : 'Magnetic grip slipped.';
    const msg = reason === 'too_heavy'
      ? `${this.displayName}: Magnetic grapple failed. Target too massive for the EPM. Returning to reload.`
      : reason === 'non_ferrous'
        ? `${this.displayName}: No magnetic purchase. Target is non-ferrous. Returning; try the net.`
        : reason === 'standoff'
          ? `${this.displayName}: Lost contact on approach. Magnetic grapple aborted. Returning.`
          : `${this.displayName}: Magnetic grip slipped. Returning to reload. Re-attempt or try the net.`;
    this._endToolFailure(cause,
      { source: this.displayName, text: msg, channel: 'CMD', priority: 'warning' });
  }

  // ── Shared non-net catch plumbing (magnet / gripper / pad) ──────────────

  /**
   * Distance from the mother at the capture instant (metres). Register item
   * 100: the wide-sweep mission beat filters ARM_CAPTURED on this — a catch
   * past 1 km is only possible past the tether-tier-aware deploy gate.
   * Measured against THIS frame's parent position (`_frameParentPos`, set at the
   * top of `update`, after which `position` has had this frame's orbital step), else
   * `_prevParentPos` (a caller with no `update` frame); null-safe → 0 before the first
   * parent frame. nets-1b R9: against `_prevParentPos` alone every live capture read one
   * orbital step (~7.7 km) and tripped the `rangeM >= 1000` wide-sweep trigger.
   * @private
   * @returns {number} range in metres
   */
  _captureRangeM() {
    const ref = this._frameParentPos || this._prevParentPos;
    if (!ref) return 0;
    return this.position.distanceTo(ref) / M;
  }

  /**
   * @private Secure a non-net catch and hand off to the shared GRAPPLED →
   * REELING → park-the-catch lifecycle. Emits ARM_CAPTURED (tagged with the
   * tool) so scoring/teaching fire exactly as for a net catch.
   */
  _secureToolCatch(target, toolKind, successMsg) {
    this.capturedDebris = target;
    target._captured = true;
    target._capturedByArm = this;
    this._captureToolKind = toolKind;
    this._pinCatchToSelf();
    eventBus.emit(Events.ARM_CAPTURED, {
      armId: this.id, targetId: target.id, type: this.type,
      detached: this.isDetached, mass: target.mass || 0,
      debrisType: target.type || 'unknown', tool: toolKind,
      manual: this._manualCapture, rangeM: this._captureRangeM(),
    });
    eventBus.emit(Events.COMMS_MESSAGE, {
      source: this.displayName, text: successMsg, channel: 'CMD', priority: 'success',
    });
    this._transitionTo(S.GRAPPLED);  // _transitionTo releases the CA lock on exit
  }

  /**
   * @private Shared tail for a failed/aborted non-net tool attempt (magnet / gripper / pad). Under REEL_HOME the failure
   * goes through `_finishFailedCatch` (reeled home within FAIL_REEL.AUTO_REEL_MAX_M of her strut, else held near the piece
   * for a retry); with the flag off (or no tether) it is the old FEEP flight home.
   * @param {string} [cause] the cause, one sentence ending in a full stop; with it, `_finishFailedCatch` says the line
   * @param {object|null} [legacy] the whole comms message (REEL_HOME off); null/undefined = say nothing
   */
  _endToolFailure(cause, legacy) {
    const piece = this._stationKeepTarget || this.target;
    this._finishFailedCatch({ cause: cause || '', legacy, holdTarget: piece });
  }

  // ============================================================================
  // FAILED CATCH (fail-reel, owner 2026-10-21): the reel winds her home
  // ============================================================================

  /**
   * @private How far she is from her strut tip (metres), or null when no mother position has been seen yet (a bare test
   * rig). Uses this frame's mother position (`_frameParentPos`) and the strut offset (`dockOffset`, kept live by the
   * mother) in the mother's orientation of her last out-frame (`_frameParentQuat`, set in `_updateTether`; before the
   * first one, the docked cache `_lastParentQuat`).
   */
  _strutTipDistM() {
    const pp = this._frameParentPos || this._prevParentPos;
    if (!pp) return null;
    const tip = this._resolveStrutDockWorld(pp, this._frameParentQuat || this._lastParentQuat, _failTip);
    return this.position.distanceTo(tip) / M;
  }

  /**
   * @private Seconds her strut reel needs to wind her home from `distM` metres out, empty-handed. Not a guess: the real speed
   * rule (`_rhReelStep` under the reel-gas profile, `_computeReelProfileSpeed` otherwise) stepped over the distance; the
   * state the rule keeps (speed, gas bottle, readouts) is saved and put back, so nothing of her changes. The tail-first
   * turn and the 2 m line-up hold are not in it (they depend on the mother), so it reads "about".
   * @param {number} distM
   * @returns {number} seconds (Infinity if the sim does not arrive within 10 000 s)
   */
  _reelHomeEtaS(distM) {
    if (!(distM > 0)) return 0;
    const armMass = this.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS;
    if (!Constants.isFeatureEnabled('REEL_PROFILE_V2')) {
      return distM / (REEL_IN_SPEED_EMPTY || 1);
    }
    const keep = [this._rhReelV, this.coldGasKg, this._rhBraking, this._rhReelPhase, this._rhTensionN,
      this._rhReelMassKg, this._rhGasChecked];
    this._rhReelV = 0;
    this._rhGasChecked = true;                    // the "no gas" line belongs to the real reel
    const dt = 0.05;
    let left = distM, t = 0;
    for (let i = 0; i < 200000 && left > 1e-6; i++) {
      const v = this._rhReelStep(dt, left, Infinity, armMass, false, 1);
      left -= Math.min(left, v * dt);
      t += dt;
    }
    [this._rhReelV, this.coldGasKg, this._rhBraking, this._rhReelPhase, this._rhTensionN,
      this._rhReelMassKg, this._rhGasChecked] = keep;
    return left > 1e-6 ? Infinity : t;
  }

  /** @private She leaves whatever she was doing and is wound home on her strut line (REELING), nothing held. */
  _reelHomeAfterFailure() {
    if (this._stationKeepTarget) this._stationKeepTarget._isStationKeepTarget = false;
    this._stationKeepTarget = null;
    this.target = null;
    this._captureToolKind = 'NET';
    this._thetaRate = 0;
    this._phiRate = 0;
    this._radiusRate = 0;
    this._skPolarAxis = null;
    this._skEquator0 = null;
    this._skRightVec = null;
    this._skPitch0 = 0;
    this._skIdleS = 0;
    if (this.state !== S.REELING) this._transitionTo(S.REELING);
  }

  /**
   * @private She holds near the piece for a retry (STATION_KEEP on `piece`). Eases from where she is now to the usual
   * standoff (as on arrival), with a fresh orbit frame, so nothing snaps.
   */
  _holdForRetry(piece) {
    const SKC = Constants.STATION_KEEP;
    if (this._stationKeepTarget && this._stationKeepTarget !== piece) this._stationKeepTarget._isStationKeepTarget = false;
    this._stationKeepTarget = piece;
    this.target = piece;
    piece._isStationKeepTarget = true;
    this._captureToolKind = 'NET';
    const standoff = Math.max(SKC.DEFAULT_STANDOFF,
      Math.min(SKC.MAX_STANDOFF, (piece.sizeMeter || 1) * SKC.DEFAULT_STANDOFF_MULT));
    const tp = piece._scenePosition;
    const nowM = tp ? this.position.distanceTo(tp) / M : standoff;
    this._standoffR = nowM;
    this._standoffTargetR = standoff;
    this._standoffSettling = true;
    this._thetaRate = 0;
    this._phiRate = 0;
    this._radiusRate = 0;
    this._orbitTheta = 0;
    this._orbitPhi = 0;
    this._skPolarAxis = null;      // re-framed from here by the SK update
    this._skEquator0 = null;
    this._skRightVec = null;
    this._skPitch0 = 0;
    this._skIdleS = 0;
    this._transitionTo(S.STATION_KEEP);
  }

  /**
   * @private The ONE end of a failed catch (pad bounce / timeout / no grip, magnet, gripper, a net miss, a net that slips
   * or rips, the target lost mid-net). Owner 2026-10-21: "reel her home"; "auto reel-in on failure for close debris. over
   * 500 meters, consider retry versus reel-in time".
   *   REEL_HOME off or no tether (detached): the old way, her line `legacy` and her FEEP flight home (RETURNING) or, with
   *     `legacyHold`, the hold she was already in (a net miss).
   *   Within FAIL_REEL.AUTO_REEL_MAX_M of her strut tip (or the distance unknown): she is wound home on her strut line.
   *   Farther out with a live piece to retry on: she holds near it, and the line gives the distance and the reel-in time.
   *   Farther out with no piece (lost): wound home, the time in the line.
   * @param {object} o
   * @param {string} o.cause one sentence ending in a full stop: "Pad bounced: contact too fast."
   * @param {object|null} [o.legacy] the whole old comms message; null = say nothing (REEL_HOME off)
   * @param {object|null} [o.holdTarget] the piece she may hold near; null/dead/captured = none
   * @param {boolean} [o.legacyHold] REEL_HOME off: she stays in STATION_KEEP (net miss) instead of RETURNING
   * @returns {'reel'|'hold'|'return'|'legacy-hold'}
   */
  _finishFailedCatch({ cause, legacy = null, holdTarget = null, legacyHold = false }) {
    const nc = this._netCommittedTarget;
    if (nc) nc._committedNetArmId = null;
    this._netCommittedTarget = null;
    const say = (text) => eventBus.emit(Events.COMMS_MESSAGE, {
      source: this.displayName, text: `${this.displayName}: ${text}`, channel: 'CMD', priority: 'warning',
    });
    if (!this._rhOn()) {
      if (legacy) eventBus.emit(Events.COMMS_MESSAGE, legacy);
      this._captureToolKind = 'NET';
      if (legacyHold) { this._transitionTo(S.STATION_KEEP); return 'legacy-hold'; }
      if (this._stationKeepTarget) this._stationKeepTarget._isStationKeepTarget = false;
      this._stationKeepTarget = null;
      this.target = null;
      this._transitionTo(S.RETURNING);  // _transitionTo releases the CA lock on exit
      return 'return';
    }
    const piece = (holdTarget && holdTarget.alive !== false && !holdTarget._captured) ? holdTarget : null;
    const distM = this._strutTipDistM();
    const far = distM != null && distM > ((Constants.FAIL_REEL && Constants.FAIL_REEL.AUTO_REEL_MAX_M) ?? 500);
    const etaS = far ? Math.round(this._reelHomeEtaS(distM)) : 0;
    const etaTxt = Number.isFinite(etaS) ? `about ${etaS} s` : 'a long haul';
    const lead = cause ? `${cause} ` : '';
    // Review F2: a hold is for a retry; with no net left in a net daughter's magazine there is none, so reel whatever the range.
    const noRetry = Constants.isFeatureEnabled('CAPTURE_NET') && (this._netInventory ?? 0) <= 0
      && (!this.selectedTool || this.selectedTool === 'NET');
    if (far && piece && !noRetry) {
      // Review F3: "Press X" is what GestureHints.chipPhrase turns into a touch button (DECISIONS §32).
      say(`${lead}${Math.round(distM)} m out: holding for a retry. Press N to retry, Press R to reel her home (${etaTxt}).`);
      this._holdForRetry(piece);
      return 'hold';
    }
    say(far
      ? `${lead}${Math.round(distM)} m out. Reeling her home, ${etaTxt}; Press D to relaunch.`
      : `${lead}Reeling her home; Press D to relaunch.`);
    this._reelHomeAfterFailure();
    return 'reel';
  }

  // ============================================================================
  // GRIPPER JAWS (P3 — WEAVER_GRIPPER)
  // ============================================================================

  /**
   * Begin a 3-jaw gripper grapple from STATION_KEEP (P3). Sub-FSM in
   * `_updateGripperGrapple`: EXTEND → SEEK (fixture raycast) → CLOSE → latch roll.
   * @returns {boolean}
   */
  gripperGrapple() {
    if (this.state !== S.STATION_KEEP) return false;
    if (!Constants.isFeatureEnabled('WEAVER_GRIPPER')) return this._toolOffline('GRIPPER');
    const target = this._stationKeepTarget || this.target;
    if (!target) { audioSystem.playDeny(); return false; }

    eventBus.emit(Events.STATION_KEEP_EXITED, { armId: this.id, reason: 'gripper' });
    this._gripPhase = 'EXTEND';
    this._gripTimer = 0;
    this._captureToolKind = 'GRIPPER';
    audioSystem.playClick();   // servo click
    this._toolLockedDebrisId = target.id;
    eventBus.emit(Events.AUTOPILOT_TARGET_LOCK, { debrisId: target.id });
    eventBus.emit(Events.COMMS_MESSAGE, {
      source: this.displayName, text: `${this.displayName}: Extending gripper jaws. Seeking a fixture`,
      channel: 'CMD', priority: 'info',
    });
    this._transitionTo(S.GRIPPER_GRAPPLE);
    return true;
  }

  /** @private GRIPPER_GRAPPLE sub-FSM: EXTEND → SEEK → CLOSE → latch roll. */
  _updateGripperGrapple(dt) {
    this._gripTimer += dt;
    const G = Constants.GRIPPER_GRAPPLE;
    const target = this._stationKeepTarget || this.target;
    if (!target || target._captured || target.alive === false) {
      this._failGripperGrip('no_fixture');
      return;
    }

    if (this._gripPhase === 'EXTEND') {
      if (this._gripTimer >= G.EXTEND_TIME_S) { this._gripPhase = 'SEEK'; this._gripTimer = 0; }
      return;
    }

    if (this._gripPhase === 'SEEK') {
      const tPos = target._scenePosition;
      if (tPos) this.position.lerp(tPos, Math.min(1, dt * 2.0));
      if (this._gripTimer >= G.SEEK_TIME_S) {
        const fixtured = target.hasGrappleFixture === true;
        eventBus.emit(Events.GRIPPER_LATCH_ATTEMPT, { armId: this.id, targetId: target.id, fixtured });
        this._gripPhase = 'CLOSE';
        this._gripTimer = 0;
      }
      return;
    }

    if (this._gripPhase === 'CLOSE') {
      if (this._gripTimer >= G.CLOSE_TIME_S) this._resolveGripperLatch(target);
    }
  }

  /** @private Resolve the gripper latch roll → GRAPPLED (success) or RETURNING (slip). */
  _resolveGripperLatch(target) {
    const G = Constants.GRIPPER_GRAPPLE;
    if ((target.mass || 0) > G.MAX_DEBRIS_MASS_KG) { this._failGripperGrip('oversize'); return; }
    const fixtured = target.hasGrappleFixture === true;
    const p = fixtured ? G.P_GRIP_FIXTURED : G.P_GRIP_UNFIXTURED;
    // Test seam: `_gripRollOverride` (0..1) forces a deterministic roll.
    const roll = (this._gripRollOverride != null) ? this._gripRollOverride : Math.random();
    if (roll >= p) { this._failGripperGrip(fixtured ? 'p_roll' : 'no_fixture'); return; }

    this._gripPhase = null;
    eventBus.emit(Events.GRIPPER_LATCHED, { armId: this.id, targetId: target.id });
    this._secureToolCatch(target, 'GRIPPER',
      `${this.displayName}: Gripper latched. Ratchet holding (zero-power). Reeling in.`);
  }

  /** @private Gripper slip/abort → release, return to reload. */
  _failGripperGrip(reason) {
    const target = this._stationKeepTarget || this.target;
    this._gripPhase = null;
    audioSystem.playDeny();
    if (target) {
      eventBus.emit(Events.GRIPPER_SLIPPED, { armId: this.id, targetId: target.id, reason });
      eventBus.emit(Events.GRIPPER_RELEASED, { armId: this.id, targetId: target.id });
    }
    const cause = reason === 'oversize'
      ? 'Gripper failed: target beyond the jaw mass limit.'
      : reason === 'no_fixture'
        ? 'Gripper found no fixture to grab (the net may suit this target).'
        : 'Gripper slipped off the fixture.';
    const msg = reason === 'oversize'
      ? `${this.displayName}: Gripper failed. Target beyond jaw mass limit. Returning to reload.`
      : reason === 'no_fixture'
        ? `${this.displayName}: Gripper found no fixture to grab. Returning; the net may suit this target.`
        : `${this.displayName}: Gripper slipped off the fixture. Returning to reload.`;
    this._endToolFailure(cause,
      { source: this.displayName, text: msg, channel: 'CMD', priority: 'warning' });
  }

  // ============================================================================
  // MULTI-MODAL PAD (P4 — SPINNER_PAD)
  // ============================================================================

  /**
   * Resolve the pad adhesion mode deterministically from target surface
   * metadata at contact (§5.3 priority). "The pad figures it out." Returns a
   * mode string or null (NO_MODE — e.g. exotic surface with UV doses spent).
   * @returns {string|null}
   */
  _resolvePadMode(target) {
    const material = target.material;
    const roughness = (typeof target.surfaceRoughness === 'number') ? target.surfaceRoughness : 0.5;
    if (material === 'steel' || material === 'iron_alloy') return 'magnet';
    if (material === 'mli_mylar' || roughness > 0.7) return 'hooks';
    if (material === 'aluminum' || material === 'kapton'
        || material === 'glass_ceramic' || material === 'solar_cell') return 'gecko';  // warm window assumed at Y0
    if (material === 'composite') return 'electrostatic';
    // Last resort — finite UV-cure magazine (§13 Q3): once spent, NO_MODE.
    if ((this._padUvCureDosesRemaining || 0) > 0) return 'uv_cure';
    return null;
  }

  /**
   * Begin a multi-modal pad contact from STATION_KEEP (P4). Sub-FSM in
   * `_updatePadContact`: APPROACH_SOFT → CONTACT (resolve mode) → grip roll.
   * @returns {boolean}
   */
  padContact() {
    if (this.state !== S.STATION_KEEP) return false;
    if (!Constants.isFeatureEnabled('SPINNER_PAD')) return this._toolOffline('PAD');
    const target = this._stationKeepTarget || this.target;
    if (!target) { audioSystem.playDeny(); return false; }

    eventBus.emit(Events.STATION_KEEP_EXITED, { armId: this.id, reason: 'pad' });
    this._padPhase = 'APPROACH';
    this._padTimer = 0;
    this._padResolvedMode = null;
    // Her real offset from the piece NOW (both last frame's scene positions), so the first approach frame already
    // rides with the piece; `_updatePadContact` falls back to taking it lazily if a caller drives that without this.
    this._padOffset = target._scenePosition ? this.position.clone().sub(target._scenePosition) : null;
    this._captureToolKind = 'PAD';
    audioSystem.playClick();
    this._toolLockedDebrisId = target.id;
    eventBus.emit(Events.AUTOPILOT_TARGET_LOCK, { debrisId: target.id });
    eventBus.emit(Events.COMMS_MESSAGE, {
      source: this.displayName, text: `${this.displayName}: Soft approach. Bringing pad to contact`,
      channel: 'CMD', priority: 'info',
    });
    this._transitionTo(S.PAD_CONTACT);
    return true;
  }

  /**
   * @private PAD_CONTACT sub-FSM: APPROACH_SOFT → CONTACT → grip roll.
   *
   * APPROACH is a station-keeping final approach, not a chase: she moves WITH the piece exactly (her offset from it is
   * kept and re-added to the piece's scene position every frame) and closes along the line to it at a speed
   * proportional to the gap, clamped (`APPROACH_GAIN_PER_S`, `APPROACH_V_MIN_M_S`, `APPROACH_V_MAX_M_S`). She closes to
   * the piece's SURFACE (its drawn reach, `DebrisField.trueReachM`, plus the pad radius), not its centre. The speed she
   * touches at is the commanded closing speed there (V_MIN floor), her speed RELATIVE to the piece, not her own stored
   * velocity or the shortened last step over dt. The old
   * `position.lerp(tPos, dt*1.5)` trailed a moving piece and slowed to zero, so a drifting piece timed the approach out.
   * `_padContactVelOverride` stays as the test seam for a deliberately fast contact.
   */
  _updatePadContact(dt) {
    this._padTimer += dt;
    const P = Constants.PAD_CONTACT;
    const target = this._stationKeepTarget || this.target;
    if (!target || target._captured || target.alive === false) {
      this._failPadContact('no_mode');
      return;
    }

    if (this._padPhase === 'APPROACH') {
      const tPos = target._scenePosition;
      if (tPos) {
        const off = this._padOffset || (this._padOffset = this.position.clone().sub(tPos));
        const prevX = this.position.x, prevY = this.position.y, prevZ = this.position.z;
        // R4 (nets-1b review): she closes to the piece's SURFACE, not its centre. The piece's reach is the same radius the
        // tip-fit and the seating use (`DebrisField.trueReachM`: the catch as drawn); contact is when her gap to that
        // surface is the pad radius. A piece with no size (a bare test rig) has reach 0: its centre, as before.
        const stopM = DebrisField.trueReachM(target, 0) + P.PAD_RADIUS_M;   // distance from the piece's centre at contact
        const dM = off.length() / M;
        const gapM = dM - stopM;
        // R3: the commanded closing speed (proportional to the gap, clamped); this is also the speed she touches at.
        const vClose = Math.min(P.APPROACH_V_MAX_M_S, Math.max(P.APPROACH_V_MIN_M_S, P.APPROACH_GAIN_PER_S * gapM));
        if (gapM > 0 && dM > 0) {
          const closeM = Math.min(vClose * dt, gapM);   // never past the pad radius off the surface
          off.multiplyScalar((dM - closeM) / dM);
        }
        this.position.copy(tPos).add(off);
        if (dt > 1e-6) {
          this.velocity.set((this.position.x - prevX) / dt, (this.position.y - prevY) / dt,
            (this.position.z - prevZ) / dt);
        }
        const distM = off.length() / M;
        if (distM - stopM <= 1e-6) {
          const contactVel = (this._padContactVelOverride != null) ? this._padContactVelOverride : vClose;
          eventBus.emit(Events.PAD_CONTACT_ATTEMPT, { armId: this.id, targetId: target.id, contactVel });
          if (contactVel > P.CONTACT_VEL_MAX_M_S) { this._failPadContact('too_fast'); return; }
          this._padResolvedMode = this._resolvePadMode(target);
          this._padPhase = 'CONTACT';
          this._padTimer = 0;
          return;
        }
      }
      if (this._padTimer >= P.APPROACH_TIMEOUT_S) this._failPadContact('timeout');
      return;
    }

    if (this._padPhase === 'CONTACT') {
      // Stuck to it: keep riding with the piece through the hold (it drifts, she does not stay behind).
      const tPos = target._scenePosition;
      if (tPos && this._padOffset) {
        const prevX = this.position.x, prevY = this.position.y, prevZ = this.position.z;
        this.position.copy(tPos).add(this._padOffset);
        if (dt > 1e-6) {
          this.velocity.set((this.position.x - prevX) / dt, (this.position.y - prevY) / dt,
            (this.position.z - prevZ) / dt);
        }
      }
      if (this._padTimer >= P.CONTACT_HOLD_S) this._resolvePadGrip(target);
    }
  }

  /** @private Resolve the pad grip roll → GRAPPLED (adhered) or RETURNING (bounced). */
  _resolvePadGrip(target) {
    const P = Constants.PAD_CONTACT;
    const mode = this._padResolvedMode;
    const p = mode ? (P.P_GRIP_BY_MODE[mode] ?? P.P_GRIP_NO_MODE) : P.P_GRIP_NO_MODE;
    // Test seam: `_padRollOverride` (0..1) forces a deterministic roll.
    const roll = (this._padRollOverride != null) ? this._padRollOverride : Math.random();
    if (roll >= p) { this._failPadContact(mode ? 'p_roll' : 'no_mode'); return; }

    // Success — decrement the UV-cure magazine IFF that mode actually adhered.
    if (mode === 'uv_cure') {
      this._padUvCureDosesRemaining = Math.max(0, (this._padUvCureDosesRemaining || 0) - 1);
      eventBus.emit(Events.PAD_UV_DOSE_USED, { armId: this.id, dosesRemaining: this._padUvCureDosesRemaining });
    }
    this._padPhase = null;
    eventBus.emit(Events.PAD_ADHERED, { armId: this.id, targetId: target.id, mode });
    this._secureToolCatch(target, 'PAD',
      `${this.displayName}: Pad adhered (${mode || 'no-mode'}). Holding. Reeling in.`);
  }

  /** @private Pad bounce/abort → release, return to reload. */
  _failPadContact(reason) {
    const target = this._stationKeepTarget || this.target;
    this._padPhase = null;
    audioSystem.playDeny();
    if (target) {
      eventBus.emit(Events.PAD_BOUNCED, { armId: this.id, targetId: target.id, reason });
      eventBus.emit(Events.PAD_RELEASED, { armId: this.id, targetId: target.id });
    }
    const cause = reason === 'too_fast'
      ? 'Pad bounced: contact too fast.'
      : reason === 'timeout'
        ? 'Pad could not reach it.'
        : reason === 'no_mode'
          ? 'Pad found no adhesion mode for this surface.'
          : 'Pad failed to adhere.';
    const msg = reason === 'too_fast'
      ? `${this.displayName}: Pad bounced: contact too fast. Returning.`
      : reason === 'timeout'
        ? `${this.displayName}: Pad could not reach it. Returning.`
      : reason === 'no_mode'
        ? `${this.displayName}: Pad found no adhesion mode for this surface. Returning to reload.`
        : `${this.displayName}: Pad failed to adhere. Returning to reload.`;
    this._endToolFailure(cause,
      { source: this.displayName, text: msg, channel: 'CMD', priority: 'warning' });
  }

  /** NETTING: net deployment + capture attempt (3s) */
  _updateNetting(dt) {
    // ── CAPTURE_NET ON: delegate to 14-state FSM in CaptureNet.js ──
    if (Constants.isFeatureEnabled('CAPTURE_NET')) {
      this._updateNettingFSM(dt);
      return;
    }

    // ── Legacy path (CAPTURE_NET OFF): 85% dice roll ──
    // --- Engineered auto-capture failure for tutorial discovery ---
    if (!this._manualCapture && this._autoFailChance > 0) {
      // Consume the failure chance immediately (single roll, not per-frame)
      const failChance = this._autoFailChance;
      this._autoFailChance = 0;

      // High-tumble targets have a failure chance when auto-captured
      const tumbleDeg = (this.target?.tumbleRate || 0) * (180 / Math.PI);
      const isHighTumble = tumbleDeg > 50; // 50°/s is very fast

      if (isHighTumble && Math.random() < failChance) {
        // Auto-capture FAILED
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.displayName}: AUTO-CAPTURE FAILED. Target tumble too high!`,
          priority: 'critical',
        });
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.displayName}: Tumble too high for auto-capture. Pilot her in manually (1-4) for a better grip.`,
          priority: 'warning',
        });

        // Return arm (failed capture)
        this.capturedDebris = null;
        this.target = null;
        this._transitionTo(S.RETURNING);
        return;
      }
    }

    // Station-keep near target
    const tPos = this._getTargetScenePos();
    if (tPos) {
      this.position.lerp(tPos, 0.02);
    }

    if (this.stateTimer > Constants.ARM_NET_DEPLOY_TIME) {
      const success = Math.random() < Constants.ARM_CAPTURE_SUCCESS_RATE;
      if (success) {
        this.capturedDebris = this.target;
        if (this.target) {
          this.target._captured = true;  // UX Fix E+: hide reticle immediately
          this.target._capturedByArm = this; // POLISH FIX issue #2: pin debris visual to arm during REELING
        }
        this._transitionTo(S.GRAPPLED);
        eventBus.emit(Events.ARM_CAPTURED, {
          armId: this.id, targetId: this.target.id, type: this.type,
          detached: this.isDetached,
          mass: this.target?.mass || 0, debrisType: this.target?.type || 'unknown',
          manual: this._manualCapture, rangeM: this._captureRangeM(),
        });
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.displayName}: Target secured! SMA cinch complete.`,
          priority: 'success',
        });
      } else {
        eventBus.emit(Events.ARM_CAPTURE_FAILED, {
          armId: this.id, targetId: this.target?.id,
        });
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.displayName}: Netting failed. Re-approaching`,
          priority: 'warning',
        });
        this._transitionTo(S.APPROACH);
      }
    }
  }

  /**
   * NETTING sub-handler for CAPTURE_NET ON: fire a daughter net via
   * CaptureNetSystem and poll the 14-state FSM each frame.
   * Decrement happens inside fireDaughterNet() (exactly once on launch).
   * @private
   */
  _updateNettingFSM(dt) {
  const CN_STATES = Constants.CAPTURE_NET.STATES;

  // Use stored reference first (robust: survives activeNets lookup issues),
  // then fall back to system query.
  let activeNet = this._firedNet || captureNetSystem.getActiveNetForArm(this.index);
   if (!activeNet) {
     const launchPos = {
       x: this.position.x / M,
       y: this.position.y / M,
       z: this.position.z / M,
     };
      // Launch direction: lead the target (Item 2). Aim at where the target will
      // be when the net arrives — targetPos + relVel × (dist / LAUNCH_SPEED).
      // Close-range SK shots barely change (short time-of-flight); long shots stop
      // missing for a non-obvious reason. All quantities are in SCENE UNITS; the
      // net's LAUNCH_SPEED is m/s, so convert to scene-units/s via × M.
      // UX-11 #1 (review fix): single source of truth — the SAME computeLeadAim
      // used by the HUD's OFF-AXIS advisory (DockingReticle), so the warning
      // can never disagree with where the shot actually goes.
      const tPos = this._getTargetScenePos();
      let launchDir = { x: 1, y: 0, z: 0 };
      if (tPos) {
        const relVel = this._leadTargetVelValid ? this._leadTargetVel : null;
        // Net class via the canonical selector (same class fireDaughterNet will
        // launch) so the lead's time-of-flight always matches the actual net.
        const _cnClass = getNetClassForType(this.type);
        const launchSpeedScene = (this._firedNet?.netClass?.LAUNCH_SPEED
          || _cnClass?.LAUNCH_SPEED || 10) * M;
        launchDir = computeLeadAim(this.position, tPos, relVel, launchSpeedScene).dir;
        // Issue 2 instrumentation (?debug=1): log the lead magnitude + off-axis
        // angle at fire time. From a settled SK both should read ≈0 now that
        // _leadTargetVel is arm-relative; a large value flags an alternate
        // drift source (e.g. the NETTING chase lerp below).
        if (Constants.DEBUG && Constants.DEBUG.LOG_RENDERER_DIAGNOSTICS) {
          const bx = tPos.x - this.position.x, by = tPos.y - this.position.y, bz = tPos.z - this.position.z;
          const bLen = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
          const dot = Math.min(1, Math.max(-1,
            (launchDir.x * bx + launchDir.y * by + launchDir.z * bz) / bLen));
          const offAxisDeg = Math.acos(dot) * 180 / Math.PI;
          const relSpeed = relVel ? Math.sqrt(relVel.x ** 2 + relVel.y ** 2 + relVel.z ** 2) : 0;
          console.info(`[LeadAim] ${this.id} fire: |relVel|=${(relSpeed / M).toFixed(3)} m/s ` +
            `offAxis=${offAxisDeg.toFixed(2)}° dist=${(bLen / M).toFixed(1)} m state=${this.state}`);
        }
      }

     activeNet = captureNetSystem.fireDaughterNet(
       this, this.index, launchPos, launchDir, this.target
     );

     if (!activeNet) {
       // fireDaughterNet returned null (cooldown/inventory/flag) — fall back to SK
       // (not APPROACH, which causes "screen-races-to-debris" at orbital speed).
       // Item 5b (2026-06-12): name the actual reason — a silent fallback left
       // the player wondering why nothing fired (learning-mission dead end).
       {
         const inv = (typeof this.getNetInventory === 'function')
           ? this.getNetInventory() : (this._netInventory || 0);
         const cdS = (typeof captureNetSystem.getCooldown === 'function')
           ? captureNetSystem.getCooldown('arm', this.index) : 0;
         const reason = cdS > 0
           ? `Net launcher cooling down. Ready in ${Math.ceil(cdS)}s.`
           : 'Net launcher unavailable. Holding station.';
         eventBus.emit(Events.COMMS_MESSAGE, {
           source: this.displayName,
           // Out of nets: the ONE line, exact (nets refill only at the resupply stop; nothing reloads on docking).
           text: inv <= 0 ? DAUGHTER_OUT_OF_NETS_LINE : `${this.displayName}: ${reason}`,
           channel: 'CMD', priority: 'warning',
         });
       }
       this._firedNet = null;
       this._transitionTo(S.STATION_KEEP);
       return;
     }
     this._firedNet = activeNet;  // store reference for subsequent frames

     // §11.4: the launch is real now — kick the launcher. Uses the FIRED
     // net's class object (the same MASS/LAUNCH_SPEED the projectile flies
     // with) and the exact fired direction. One production fire site ⇒ the
     // impulse is applied exactly once per launch.
     this.applyNetFireRecoil(activeNet.netClass, launchDir);
   }

    // NETTING: track the target at the same SK standoff offset so the camera
    // stays stable while the net is in flight.
    // Reuse SK frame vectors (frozen at SK entry: _skPolarAxis, _skRightVec,
    // _skEquator0, _skPitch0) + spherical coords (_orbitTheta, _orbitPhi,
    // _standoffR) for an exact goal, then lerp at the same SK rate (smooth,
    // jitter-free — direct overwrite causes ~1m/frame jumps from frame mismatch
    // with line 1886 parent-frame correction).
    {
      const tPos = this._getTargetScenePos();
      if (tPos && this._skPolarAxis && this._skEquator0 && this._skRightVec) {
        const SK = Constants.STATION_KEEP;
        const _yaw = this._orbitTheta || 0;
        const _totalPitch = (this._skPitch0 || 0) + (this._orbitPhi || 0);
        const _cosY = Math.cos(_yaw), _sinY = Math.sin(_yaw);
        const _cosP = Math.cos(_totalPitch), _sinP = Math.sin(_totalPitch);
        const _eqX = this._skEquator0.x * _cosY + this._skRightVec.x * _sinY;
        const _eqY = this._skEquator0.y * _cosY + this._skRightVec.y * _sinY;
        const _eqZ = this._skEquator0.z * _cosY + this._skRightVec.z * _sinY;
        const _ox = _eqX * _cosP + this._skPolarAxis.x * _sinP;
        const _oy = _eqY * _cosP + this._skPolarAxis.y * _sinP;
        const _oz = _eqZ * _cosP + this._skPolarAxis.z * _sinP;
        const _Rscene = (this._standoffR || SK.DEFAULT_STANDOFF) * M;
        let goalX = tPos.x + _ox * _Rscene;
        let goalY = tPos.y + _oy * _Rscene;
        let goalZ = tPos.z + _oz * _Rscene;
        // §11.4 net-fire recoil: same goal displacement as _updateStationKeep —
        // the kick lands DURING NETTING (the net just left), so this hold is
        // where the fight is mostly visible. The step also bills the recovery
        // surcharge (NETTING's only fuel debit; flag OFF ⇒ zero, byte-identical).
        if (this._updateRecoilKick(dt)) {
          goalX += this._recoilOffsetM.x * M;
          goalY += this._recoilOffsetM.y * M;
          goalZ += this._recoilOffsetM.z * M;
        }
        const lerp = SK.STATIONKEEP_LERP_RATE;
        this.position.x += (goalX - this.position.x) * lerp;
        this.position.y += (goalY - this.position.y) * lerp;
        this.position.z += (goalZ - this.position.z) * lerp;
      }
    }

    // Poll FSM state
    const netState = activeNet.state;
    // reel-home-look: the net system resolves a catch and auto-starts its reel in ONE update (CaptureNet.update's
    // needsAutoReel), so this poll runs after CAPTURED has already become REELING and never saw CAPTURED. It must take
    // that as the catch too: without `_capturedByArm` the held-net hold (CaptureNet._updateReeling) lets go next update,
    // the net stows and its bag is dropped as a lost catch ~1 s after the catch (found with a real net, 2026-10-19).
    const reelCaught = netState === CN_STATES.REELING && activeNet.catchResult === 'success'
      && activeNet._heldByArm === true && activeNet.targetDebris === this.target;
    if (netState === CN_STATES.CAPTURED || reelCaught) {
      this.capturedDebris = this.target;
      // The STOWED branch cleared these; a catch now arrives here instead (review 2026-10-19).
      if (this._netCommittedTarget) this._netCommittedTarget._committedNetArmId = null;
      this._netCommittedTarget = null;
      // Phase 2 (ASPECT_CAPTURE): freeze the presented width AT CATCH TIME —
      // the reel-start oversize check judges the geometry the net actually
      // wrapped, not whatever the body has rotated to by reel time.
      this._catchPresentedWidthM = (activeNet._presentedWidthM != null)
        ? activeNet._presentedWidthM : null;
      if (this.target) {
        this.target._captured = true;
        this.target._capturedByArm = this; // POLISH FIX issue #2: pin debris visual to arm during REELING
        this._seedCaptureTorqueSettle(this.target); // §11.5: transfer L, don't delete it
      }
      this._transitionTo(S.GRAPPLED);
      eventBus.emit(Events.ARM_CAPTURED, {
        armId: this.id, targetId: this.target?.id, type: this.type,
        detached: this.isDetached,
        mass: this.target?.mass || 0, debrisType: this.target?.type || 'unknown',
        manual: this._manualCapture, rangeM: this._captureRangeM(),
      });
      if (!reelCaught) {   // a real catch reached the STOWED branch before, which said nothing; keep it quiet
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.displayName}: Target secured! SMA cinch complete.`,
          priority: 'success',
        });
      }
    } else if (netState === CN_STATES.MISSED || netState === CN_STATES.RELEASED) {
      // Issue-B GUARD: if the target died mid-net-flight (deorbit, cull,
      // fragmentation, etc.), don't loop back into SK — there's nothing to
      // station-keep on. Go straight to RETURNING with a clear comms message.
      const committedAlive = this._netCommittedTarget && this._netCommittedTarget.alive !== false;
      eventBus.emit(Events.ARM_CAPTURE_FAILED, {
        armId: this.id, targetId: this.target?.id,
      });
      if (!committedAlive) {
        // fail-reel: under REEL_HOME she is wound home on her strut line (no piece left to hold near); else RETURNING.
        this._finishFailedCatch({
          cause: 'Target lost during net flight.',
          legacy: { text: `${this.displayName}: Target lost during net flight. Returning empty.`, priority: 'warning' },
        });
      } else {
        // fail-reel: REEL_HOME - within FAIL_REEL.AUTO_REEL_MAX_M she is wound home, farther out she holds for a retry
        // with the reel-in time in the line. Legacy: fall back to SK (not APPROACH) — arm stays at standoff; pilot
        // retries with N. APPROACH causes "screen-races-to-debris" effect at orbital speed.
        this._finishFailedCatch({
          cause: 'Netting failed.',
          legacy: { text: `${this.displayName}: Netting failed. Holding standoff. Press N to retry.`, priority: 'warning' },
          holdTarget: this._netCommittedTarget, legacyHold: true,
        });
      }
    } else if (netState === CN_STATES.STOWED) {
      // Net returned stowed (either success cargo-stored or miss-returned)
      if (activeNet.catchResult === 'success') {
        this.capturedDebris = this.target;
        if (this.target) {
          this.target._captured = true;
          this.target._capturedByArm = this; // POLISH FIX issue #2: pin debris visual to arm during REELING
          this._seedCaptureTorqueSettle(this.target); // §11.5: transfer L, don't delete it
        }
        if (this._netCommittedTarget) this._netCommittedTarget._committedNetArmId = null;
        this._netCommittedTarget = null;
        this._transitionTo(S.GRAPPLED);
        eventBus.emit(Events.ARM_CAPTURED, {
          armId: this.id, targetId: this.target?.id, type: this.type,
          detached: this.isDetached,
          mass: this.target?.mass || 0, debrisType: this.target?.type || 'unknown',
          manual: this._manualCapture, rangeM: this._captureRangeM(),
        });
      } else {
        // Issue-B GUARD (STOWED miss path): same target-alive check.
        const committedAliveStowed = this._netCommittedTarget && this._netCommittedTarget.alive !== false;
        if (!committedAliveStowed) {
          this._finishFailedCatch({
            cause: 'Target lost during net flight.',
            legacy: { text: `${this.displayName}: Target lost during net flight. Returning empty.`, priority: 'warning' },
          });
        } else {
          // Miss STOWED: legacy stays in SK so pilot can retry without re-approaching; REEL_HOME: reeled home within
          // FAIL_REEL.AUTO_REEL_MAX_M, held for a retry beyond it (fail-reel). It said nothing before: now one line.
          this._finishFailedCatch({
            cause: 'Netting failed.', holdTarget: this._netCommittedTarget, legacyHold: true,
          });
        }
      }
    }
    // Otherwise: net still in flight/reeling — keep polling
  }

  /**
   * nets-1b R8: a tool catch (pad, magnet, gripper) is pinned TO HER (`_secureToolCatch` -> `_pinCatchToSelf`), and
   * `DebrisField.pinCapturedDebris` copies that pin back into the piece's `_scenePosition` every frame. So the
   * piece's scene position is last frame's pin, i.e. where she was BEFORE this frame's orbital APPLY step: copying it
   * onto her (the net catch's snap) throws away the mother's orbital step each frame (~7.7 km live) and leaves her
   * ~150 km out when the reel starts. A tool catch already rides with her; a net catch is a free piece she goes to.
   * @private
   * @returns {boolean}
   */
  _toolCatchRidesWithHer() {
    // nets-1b review 3: also require the catch to be pinned to her (`_secureToolCatch` pins it), so a stale tool
    // kind left by a net entry that does not reset it can never skip a net catch's snap.
    return !!this._captureToolKind && this._captureToolKind !== 'NET'
      && !!this.capturedDebris && this.capturedDebris._armPinned === true;
  }

  /**
   * GRAPPLED: holding debris, stabilize before hauling/reeling.
   * reel-home (flag on, a NET catch): she does NOT jump onto the debris. She stays where the net closed and the
   * catch is held at its separation; after the settle her net line winds it in to her nose (`_rhNetReelStep`),
   * the pair's centre of mass staying put, and only then does the strut reel take over.
   */
  _updateGrappled(dt, parentPos = null, parentQuat = null) {
    const rh = this._rhOn() && this._rhNetCatch();
    const tPos = this._getTargetScenePos();
    if (rh) {
      this._rhHoldCatch(tPos);
    } else if (this._toolCatchRidesWithHer()) {
      // nets-1b review 3: the catch rides with her through the hold too (it was pinned once at the grip and left at
      // the capture point while she moved on with the mother; ArmManager draws it from this pin in GRAPPLED).
      this._pinCatchToSelf(parentPos);
    } else if (tPos) {
      this.position.copy(tPos);
    }
    if (this.stateTimer > Constants.ARM_GRAPPLE_STABILIZE) {
      // Detached arms cannot return — go straight to deorbit sacrifice
      if (this.isDetached) {
        this._transitionTo(S.DEORBITING);
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.displayName}: No tether. Committing to deorbit burn. Sacrificial play.`,
          priority: 'warning',
        });
        return;
      }
      // Net-integrity check at reel start: a heavy, near-rated catch can slip
      // the net. A failure is recoverable (debris drifts free, daughter returns
      // to reload) and is handled inside the check — bail out of REELING.
      // (reel-home: not again once the net reel runs — the check rolls dice, once per call, and the reel lasts a while)
      if (!(rh && this._rhHome) && this._checkNetIntegrityOnReel()) return;

      // SNUG sub-phase (REEL_PROFILE_V2, plan Q3): before the haul, cinch the
      // stage-1 net tight so daughter+net+debris is ONE rigid unit (one CoM,
      // m_unit). Implemented as a short settle window after the stabilize hold:
      // we ask the held net to pull to its snug-tension target, wait SETTLE_S so
      // the cinch transient damps, emit CATCH_SNUGGED once, then enter REELING.
      // Skipped when empty (reelFromStationKeep aborts have no catch) — only the
      // GRAPPLED→REELING capture path snugs. Over-strain already handled above.
      if (Constants.isFeatureEnabled('REEL_PROFILE_V2') && this.capturedDebris && !this._catchSnugged) {
        this._applySnugTension();
        const settle = (Constants.CATCH_SNUG && Constants.CATCH_SNUG.SETTLE_S) ?? 0.4;
        if (this.stateTimer <= Constants.ARM_GRAPPLE_STABILIZE + settle) {
          return;   // still settling — hold the GRAPPLED co-location one more frame
        }
        this._catchSnugged = true;
        const armMass = this.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS;
        eventBus.emit(Events.CATCH_SNUGGED, {
          armIndex: this.index,
          debrisId: this.capturedDebris.id,
          mUnit: this._computeReelMUnit(armMass, true),
        });
      }

      // reel-home: her net winds the catch in to her nose before the strut reel starts. GRAPPLED keeps the
      // sub-phase; REELING is entered once the catch sits in its rack cell on her.
      if (rh && !this._rhNetDone) {
        if (!this._rhHome) this._rhBeginNetReel();
        if (!this._rhNetReelStep(dt)) return;
        this._rhNetDone = true;
      }

      // V5: Zero-fuel motor reel-in instead of fuel-burning HAULING
      this._transitionTo(S.REELING);
      const _hasPayload = this.capturedDebris !== null;
      const _reelSpeed = _hasPayload ? REEL_IN_SPEED_LOADED : REEL_IN_SPEED_EMPTY;
      const _eta = (this.tetherLength / Math.max(_reelSpeed, 1)).toFixed(1);
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: this.displayName,
        text: `Reeling in. ETA ${_eta} s`,
        channel: 'CMD',
        priority: 'info',
      });
    }
  }

  /**
   * SNUG cinch (REEL_PROFILE_V2, plan Q3): tell the held stage-1 net to tighten
   * to CATCH_SNUG.TENSION_TARGET_N so the bag rigidizes onto the debris before
   * the haul. The net's _updateReeling honours `_snugTargetN` while `_heldByArm`
   * (otherwise its tension is the base mass formula). No-op for non-NET grips.
   * @private
   */
  _applySnugTension() {
    if (this._captureToolKind && this._captureToolKind !== 'NET') return;
    const net = this._firedNet || (captureNetSystem.getActiveNetForArm
      ? captureNetSystem.getActiveNetForArm(this.index) : null);
    if (!net) return;
    const target = (Constants.CATCH_SNUG && Constants.CATCH_SNUG.TENSION_TARGET_N) ?? 8;
    net._snugTargetN = target;
  }

  /**
   * Yoke tether-plume clearance test (REEL_PROFILE_V2, plan Rev-3 / §1.2;
   * Wave2 arrest-gate reconciliation).
   *
   * FEEP braking fires the fore nozzle (+Z exhaust) toward the mother — the same
   * side the tether runs to. Under the Rev-3 whole-haul reel attitude the nose
   * converges ONTO the dock line, so the original nose-referenced ≥30° test
   * (MIN_TETHER_PLUME_DEG = 20° plume half-angle + 10° UNCOMMANDED vector
   * wander) fouled every production dock: 0.00° measured at the arrest window,
   * the debit never billed, and every loaded dock took the winch fallback.
   *
   * Reconciliation (geometry derivation, weaver numbers at entry d = 8 m):
   *  1. REAL BRIDLE GEOMETRY — the tether anchors at the +Y wishbone bridle
   *     apex, local (0, +BRIDLE_APEX_Y_FRAC·by, 0) (hardware in _createMesh),
   *     NOT at the nose. Standoff atan(0.70·0.2/8) ≈ 1.0° at entry, growing as
   *     she closes — real, but the daughters are 0.1–0.3 m craft, so this term
   *     alone can never reach 30° (or even 20°) at arrest range.
   *  2. ARREST STEER ATTITUDE — the whole-haul attitude owner blends the nose
   *     ARREST_STEER_DEG (15°) AWAY from the bridle side inside the arrest
   *     approach (see the REELING branch in update()), fully converged at
   *     entry via ARREST_STEER_LEAD_M. With the beam steered away from the
   *     bridle, the anchor's +Y elevation keeps the ENTIRE cable on the
   *     opposite side of the exhaust cone (no near-field crossing) — steering
   *     toward the bridle side would sweep the beam through the cable at
   *     ~0.3 m range, which is why the sign matters.
   *  3. COMMANDED-STEER DECOMPOSITION — during the arrest the vector loop is
   *     closed, so the 10° open-loop wander budget collapses to
   *     STEER_JITTER_DEG (2°) and the requirement against the STEERED axis is
   *     PLUME_HALF_ANGLE_DEG + STEER_JITTER_DEG = 22°. The emitter contributes
   *     up to VECTOR_ENVELOPE_DEG (15°, electrostatic, free) of commanded
   *     steer on top of whatever the current nose geometry already provides.
   *     Production entry: 15° (attitude) + 1° (bridle) + 6° (steer) = 22° ⇒
   *     clear. Un-converged/seized attitude (nose on the dock line): 1° + 15°
   *     = 16° < 22° ⇒ genuinely fouled, winch fallback — the "dock dead-ahead
   *     of the plume with no steer margin available" case.
   *
   * Angles ≥ MIN_TETHER_PLUME_DEG (30°) clear unassisted with no commanded
   * steer (legacy fast path — dock-abeam geometry is byte-identical to the
   * old gate, and pays no steer surcharge). When `clear` is false FEEP is
   * withheld and the reel finishes on the motor alone (no §4.2 ablation is
   * simulated). Degenerate/test geometry (no parent frame) clears so minimal
   * mocks aren't blocked.
   *
   * @param {THREE.Vector3} [parentPos] mother world position
   * @param {THREE.Quaternion} [parentQuat] mother world orientation
   * @returns {{clear: boolean, steerNeededDeg: number}} `clear` = FEEP
   *   permitted; `steerNeededDeg` = commanded electrostatic steer engaged for
   *   the burn (0 when the geometry clears unassisted — drives the cos-loss
   *   debit surcharge at the call site)
   * @private
   */
  _tetherPlumeClearance(parentPos, parentQuat) {
    const YC = Constants.YOKE_CLEARANCE || {};
    const minDeg = YC.MIN_TETHER_PLUME_DEG ?? 30;
    if (!parentPos || !this.dockOffset) {
      return { clear: true, steerNeededDeg: 0 };   // test/degenerate geometry
    }

    // Strut dock world position (tether mother-side anchor) — shared resolver so
    // this gate uses exactly the same dock reference as the reel target.
    const dockWP = this._tmpPlumeDock || (this._tmpPlumeDock = new THREE.Vector3());
    this._resolveStrutDockWorld(parentPos, parentQuat, dockWP);

    // Tether line: +Y bridle apex (the REAL daughter-side anchor — hardware at
    // local (0, +BRIDLE_APEX_Y_FRAC·by, 0), see _createMesh) → strut dock.
    // Brake-plume axis: daughter world +Z (nose), the fore-nozzle exhaust
    // direction under the whole-haul reel attitude.
    const apexFrac = YC.BRIDLE_APEX_Y_FRAC ?? 0.70;
    const apexY = apexFrac * (this.config.bodyDims?.[1] ?? 0.2) * M;   // scene units
    const anchorWP = this._tmpPlumeAnchor || (this._tmpPlumeAnchor = new THREE.Vector3());
    anchorWP.set(0, apexY, 0).applyQuaternion(this.group.quaternion).add(this.position);

    const tetherDir = this._tmpPlumeTether || (this._tmpPlumeTether = new THREE.Vector3());
    tetherDir.subVectors(dockWP, anchorWP);
    if (tetherDir.lengthSq() < 1e-20) return { clear: true, steerNeededDeg: 0 };
    tetherDir.normalize();

    const noseDir = this._tmpPlumeNose || (this._tmpPlumeNose = new THREE.Vector3());
    noseDir.set(0, 0, 1).applyQuaternion(this.group.quaternion);
    if (noseDir.lengthSq() < 1e-12) return { clear: true, steerNeededDeg: 0 };
    noseDir.normalize();

    const cos = Math.max(-1, Math.min(1, tetherDir.dot(noseDir)));
    const angleDeg = Math.acos(cos) * 180 / Math.PI;

    // Legacy unassisted fast path: cable already rides ≥ 30° outside the
    // worst-case (wander-inclusive) cone — no steer engaged, no surcharge.
    if (angleDeg >= minDeg) return { clear: true, steerNeededDeg: 0 };

    // Commanded-steer decomposition: required clearance vs the STEERED axis.
    const required = (YC.PLUME_HALF_ANGLE_DEG ?? 20) + (YC.STEER_JITTER_DEG ?? 2);
    const steerNeededDeg = Math.max(0, required - angleDeg);
    const clear = steerNeededDeg <= (YC.VECTOR_ENVELOPE_DEG ?? 15);
    return { clear, steerNeededDeg };
  }

  /**
   * Boolean-compat wrapper over {@link _tetherPlumeClearance} (the historical
   * gate API — kept so any external probe/diagnostic keeps working).
   * @param {THREE.Vector3} [parentPos] mother world position
   * @param {THREE.Quaternion} [parentQuat] mother world orientation
   * @returns {boolean} true if the tether clears the plume (FEEP permitted)
   * @private
   */
  _tetherPlumeClearOK(parentPos, parentQuat) {
    return this._tetherPlumeClearance(parentPos, parentQuat).clear;
  }

  /**
   * Arrest-window beam-steer attitude offset (Wave2 arrest-gate
   * reconciliation; the geometry derivation lives on _tetherPlumeClearance).
   *
   * Rotates the whole-haul reel AIM (`headingDir`, unit, in place) by
   * w(d)·ARREST_STEER_DEG about the axis ⊥(bridle-up, heading), swinging the
   * nose AWAY from the bridle's world side so the +Y-anchored cable ends up
   * wholly on the far side of the fore-nozzle exhaust cone during the arrest
   * burn (steering TOWARD the bridle would sweep the beam through the cable
   * in the near field — the sign matters, see the gate docstring).
   *
   * Blend law: w(d) = clamp01(((ARREST_DISTANCE_M + ARREST_STEER_LEAD_M) − d)
   * / ARREST_STEER_LEAD_M) — zero at/outside the 14 m engage line, FULL at
   * the 8 m window entry. The LEAD band exists because the one-shot arrest
   * gate/debit fires on the FIRST frame inside ARREST_DISTANCE_M: a blend
   * confined strictly inside the window would guarantee that entry frame sees
   * the un-steered nose (w≈0), foul the gate, and re-create the audited
   * always-winches bug. w is continuous in d and the caller's
   * REEL_ATTITUDE_SLERP smooths the remainder, so the offset blends in AND
   * back out (window bounce, dock handoff) with no orientation snap at the
   * 8 m line. Called ONLY from the REELING whole-haul attitude branch in
   * update() — the single owner of the REELING quaternion (CONVENTIONS.md §9 Rule 8
   * / §10 Rule B); the gate reads the quaternion, never writes it.
   *
   * @param {THREE.Vector3} headingDir unit aim (nose target), rotated in place
   * @param {number} distMeters current daughter→strut-dock distance in metres
   * @returns {THREE.Vector3} headingDir (for chaining)
   * @private
   */
  _applyArrestSteerToHeading(headingDir, distMeters) {
    const YC = Constants.YOKE_CLEARANCE || {};
    const steerDeg = YC.ARREST_STEER_DEG ?? 15;
    if (!(steerDeg > 0)) return headingDir;
    const RF = Constants.REDOCK_FEEP || {};
    const arrestDist = RF.ARREST_DISTANCE_M ?? 8;
    const leadM = Math.max(YC.ARREST_STEER_LEAD_M ?? 6, 1e-6);
    const w = Math.min(1, Math.max(0, ((arrestDist + leadM) - distMeters) / leadM));
    if (w <= 0) return headingDir;

    // Bridle-up in world space (local +Y through the current attitude).
    const bridleUp = this._tmpSteerUp || (this._tmpSteerUp = new THREE.Vector3());
    bridleUp.set(0, 1, 0).applyQuaternion(this.group.quaternion);
    // Axis ⊥ both; rotating heading about cross(bridleUp, heading) tilts the
    // nose away from the bridle side. Degenerate (bridle ∥ heading — nose ⊥
    // dock line) geometries already clear the gate unassisted: skip.
    const axis = this._tmpSteerAxis || (this._tmpSteerAxis = new THREE.Vector3());
    axis.crossVectors(bridleUp, headingDir);
    if (axis.lengthSq() < 1e-12) return headingDir;
    axis.normalize();
    headingDir.applyAxisAngle(axis, w * steerDeg * Math.PI / 180).normalize();
    return headingDir;
  }

  /**
   * Release the currently captured debris back into the field as a free,
   * re-targetable body (shared by both capture-failure modes).
   *
   * The debris resumes its propagated orbit (its true trajectory — the capture
   * was only a visual pin) and is tagged `_netted` so it reads as "still wearing
   * the net" and is worth re-capturing. Crucially this means a lost catch never
   * silently vanishes; it becomes a chase-able object again.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.keepPinned=false] - keep `_capturedByArm` so the debris
   *        drifts WITH this arm (tether snap: the net stays intact between the
   *        daughter and debris). When false the debris detaches and floats free.
   * @returns {object|null} the released debris (or null if none)
   * @private
   */
  _releaseCapturedDebris({ keepPinned = false } = {}) {
    const debris = this.capturedDebris;
    if (!debris) return null;
    debris._netted = true;             // visual/gameplay tag: drifting in a net
    debris._captured = false;          // re-targetable by the next daughter
    debris._isStationKeepTarget = false;
    debris._committedNetArmId = null;
    if (!keepPinned) {
      // Detach: clear the pin so DebrisField resumes orbit-driven positioning
      // and restores LOD. The debris keeps its real orbital trajectory.
      debris._capturedByArm = null;
      debris._armPinned = false;       // release authoritative arm pin
      clearShipRelativeAttitude(debris);
      clearRackCell(debris);           // rack-snug: and any cell it was assigned
    }
    // This arm no longer owns the catch for docking/processing in either case.
    this.capturedDebris = null;
    this.reeling = false;
    this.tetherTension = 0;
    return debris;
  }

  /**
   * Authoritative catch pin: force the captured debris straight to this arm's
   * position for the renderer AND every consumer (net visual, camera, autopilot,
   * gap diagnostics). Belt-and-suspenders over DebrisField's `_capturedByArm`
   * pin, which proved fragile for station-keep / welcome-field debris and let
   * the catch drift hundreds of metres away on its own orbit during the haul.
   *
   * 2026-06-12 (Issue 13): the pin carries a STANDOFF along the hold axis —
   * `arm.position + holdDir × standoff` — so the daughter never renders inside a
   * catch larger than herself. catch-snug (2026-10-18): for a catch with a drawn
   * mesh the standoff is `d._holdStandoffM`, recomputed EVERY pin from the two
   * drawn shapes (`catchHoldStandoffM`: her support along the axis + the catch's
   * support along -axis + ARM_HOLD_NET_GAP_M), so the nearest drawn point sits one
   * net gap off her end. A catch with no type (old saves, rigs) has no
   * `_holdStandoffM` and keeps `sizeMeter/2 + ARM_HOLD_CLEARANCE_M`. holdDir is the
   * capture axis (net launchDirection while the fired-net ref lives), else the
   * outboard direction from the mother (so the catch hangs outboard of the
   * daughter in REELING and outboard of the strut in HOLDING_CATCH, tracking
   * parent rotation each re-pin).
   * @param {THREE.Vector3|null} [parentPos] freshest mother position (falls
   *   back to _prevParentPos when the call site has no parent frame in scope)
   * @param {number} [lateralBias=0] perpendicular offset (× catch radius) to
   *   slide the bag off the camera→daughter axis so the parked daughter stays
   *   visible beside her catch (used by HOLDING_CATCH). 0 = pure outboard.
   * @private
   */
  _pinCatchToSelf(parentPos = null, lateralBias = 0) {
    const d = this.capturedDebris;
    if (!d) return;
    const dir = this._tmpHoldDir || (this._tmpHoldDir = new THREE.Vector3());
    let hasDir = false;
    const ld = this._firedNet && this._firedNet.launchDirection;
    if (ld) {
      dir.set(ld.x, ld.y, ld.z);
      hasDir = dir.lengthSq() > 1e-12;
    }
    const pp = parentPos || this._frameParentPos || this._prevParentPos;   // nets-1b review 3: this frame's mother first
    if (!hasDir && pp) {
      dir.subVectors(this.position, pp);
      hasDir = dir.lengthSq() > 1e-12;
    }
    if (hasDir) dir.normalize(); else dir.set(0, 0, 0);
    const clearance = (Constants.ARM_HOLD_CLEARANCE_M ?? 1.0);
    // catch-snug: ONE number for the in-hand pin — the per-frame tight standoff when the
    // catch has a drawn mesh, else (no type / no axis) today's sizeMeter/2 + clearance.
    // The renderer draws a pinned catch at the net-held floor: mark it pinned BEFORE measuring so
    // the standoff reads the drawn scale through DebrisField.effectiveRenderScale.
    d._armPinned = true;
    const snugM = hasDir
      ? catchHoldStandoffM(this.group.quaternion, this.config.bodyDims, d, dir,
        Constants.ARM_HOLD_NET_GAP_M ?? 0.03, this._solidPointsM())
      : null;
    if (snugM !== null) d._holdStandoffM = snugM;
    else if (d._holdStandoffM !== undefined) d._holdStandoffM = undefined;
    const standoffM = Number.isFinite(d._holdStandoffM)
      ? d._holdStandoffM
      : (d.sizeMeter || 0) / 2 + clearance;
    const standoffScene = standoffM * M;
    if (!d._armPinPos) d._armPinPos = new THREE.Vector3();
    d._armPinPos.copy(this.position).addScaledVector(dir, standoffScene);

    // Issue (re-dock occlusion): in HOLDING_CATCH the catch parks full-size at
    // the strut tip directly OUTBOARD of the ~1 m daughter. From the usual
    // gameplay camera (looking from the mother outward) a 5 m bag placed on the
    // camera→daughter axis eclipses her — reading as "the daughter disappeared"
    // for the whole hold/chop window. A lateral bias slides the bag off that
    // axis (perpendicular to the outboard hold direction) so the daughter stays
    // visible beside her catch. Axis = holdDir × world-up, falling back to
    // world-X when holdDir is ~parallel to up. Scales with the catch radius so
    // bigger catches clear further.
    if (lateralBias !== 0 && hasDir) {
      const lat = this._tmpLatDir || (this._tmpLatDir = new THREE.Vector3());
      lat.crossVectors(dir, _WORLD_UP);
      if (lat.lengthSq() < 1e-8) lat.set(1, 0, 0); // holdDir ∥ up — pick world-X
      lat.normalize();
      const latScene = ((d.sizeMeter || 0) / 2 + clearance) * M * lateralBias;
      d._armPinPos.addScaledVector(lat, latScene);
    }
    d._armPinned = true;
  }

  /**
   * Cargo-continuity S6: free parked-hold cells on the cargo rack. The S7
   * transfer's candidate filter — a full rack refuses BEFORE anything moves.
   * @returns {number}
   */
  get holdCellsFree() {
    return Math.max(0, (Constants.DAUGHTER_CARGO_CELLS ?? 2) - this.heldCatches.length);
  }

  /**
   * Cargo-continuity S6: push a piece onto the parked cargo rack. The haul
   * path can never trip the capacity guard (a daughter parks with exactly one
   * piece into an empty rack) — it exists so a full rack REFUSES the push
   * instead of silently dropping cargo (the two laws, §1).
   *
   * rack-snug (Decisions 1, 4, 5): the stow ASSIGNS the cell — the smallest free one — unless a cargo flight to
   * this daughter already did (`d._rackArm === this`, its end was fixed at the flight's start). The piece's
   * attitude in HER frame is frozen from its attitude now, so it does not jump. The piece she carries IN HAND
   * (tight at her end, along the net's launch direction) then glides to the cell over ARM_HOLD_GLIDE_S.
   * @param {object} debris
   * @param {THREE.Quaternion|null} [parentQuat] mother world attitude (her attitude is computed fresh from it)
   * @returns {boolean} true if stowed
   * @private
   */
  _stowHeldCatch(debris, parentQuat = null) {
    if (this.holdCellsFree <= 0) return false;
    const inHand = debris === this.capturedDebris;
    const herQ = this._herQuatWorldInto(parentQuat, _stowHerQ);
    // reel-home: the net reel already put the catch in its cell, fixed in her frame — it neither takes a fresh cell nor glides
    const inCell = inHand && this._rhArrived && debris._rackArm === this && Number.isInteger(debris._rackCell);
    this._assignRackCellWith(debris, herQ, inHand && !inCell);   // the in-hand piece always takes a fresh cell
    // catch-snug: the piece she is carrying IN HAND (tight at her end) is moving to its rack
    // slot — remember where it sits relative to her so `_pinHeldCatches` glides it there
    // over ARM_HOLD_GLIDE_S instead of jumping in one frame. Only the in-hand piece glides
    // (a cargo hand-off arrives from the mother net on its own arc).
    if (inHand && !inCell && debris._armPinned && debris._armPinPos
        && (Constants.ARM_HOLD_GLIDE_S ?? 0) > 0 && this.heldCatches.length === 0) {
      const fromM = _stowTmp.subVectors(debris._armPinPos, this.position)
        .applyQuaternion(_stowInvQ.copy(herQ).invert()).multiplyScalar(1 / M);   // her frame, metres
      const len = fromM.length();
      debris._holdGlide = {
        arm: this,
        fromM: fromM.clone(),
        // a typed catch swings round her on the tight "support shell" (see `_glideHeldCatch`); a typeless one
        // (no drawn mesh to measure) goes straight
        dir0: (debris.type && len > 1e-9) ? fromM.clone().multiplyScalar(1 / len) : null,
      };
    }
    this.heldCatches.push(debris);
    return true;
  }

  /**
   * rack-snug (Decision 4a): her WORLD attitude while parked, computed fresh — never read from `group.quaternion`,
   * which PlayerSatellite writes AFTER `armManager.update` (one frame stale in the pin). The mother's quaternion
   * × the docked basis `composeDockedArmQuat(strutDir, azRad)`, with the inputs PlayerSatellite itself uses
   * (`strutGroups[i].strutDir` / `.azRad`; `_updateStruts` runs BEFORE `armManager.update`, so strutDir is current
   * when the pin runs). Without a player (a bare rig) the strut direction is rebuilt from this daughter's own aim
   * angle and dock azimuth, the same convention.
   * @param {THREE.Quaternion|null} [parentQuat] mother world attitude; falls back to the player's, then the last cached
   * @param {THREE.Quaternion} out
   * @returns {THREE.Quaternion} out
   */
  _herQuatWorldInto(parentQuat, out) {
    const ps = this._playerSatellite;
    const sg = ps && ps.strutGroups && this.index != null ? ps.strutGroups[this.index] : null;
    if (sg && sg.strutDir && sg.strutDir.lengthSq() > 1e-12) {
      composeDockedArmQuat(sg.strutDir, sg.azRad, out);
    } else {
      const az = Number.isFinite(this._azimuthDeg)
        ? (this._azimuthDeg * Math.PI) / 180
        : Math.atan2(this.dockOffset.y, this.dockOffset.x);
      strutLocalDirection(this._aimAlpha || 0, az, _herDirTmp);
      composeDockedArmQuat(_herDirTmp, az, out);
    }
    if (this._carryAtt) out.copy(this._carryAtt);                  // petal-single: a carry in flight turns her (ship frame); the rack pins follow
    const pq = parentQuat || (ps && ps.quaternion) || this._lastParentQuat;
    if (pq && typeof pq.x === 'number') out.premultiply(pq);
    return out;
  }

  /** rack-snug: her +Z support, metres (box ∪ every solid mesh vertex), cached once her mesh exists. */
  herSupportZM() {
    const solid = this._solidPointsM();
    if (solid) {
      if (this._herSupportZ === undefined) this._herSupportZ = herSupportZM(this.config.bodyDims, solid);
      return this._herSupportZ;
    }
    return herSupportZM(this.config.bodyDims, null);
  }

  /**
   * rack-snug (Decision 4): assign (or confirm) the rack cell of `d` on this daughter — the cell, its offset on her
   * and the piece's attitude in her frame. Idempotent while the assignment is valid (same daughter, cell not taken
   * by another piece): the cargo flight calls it every frame and only the first call computes. Overwrites otherwise.
   * @param {object} d the piece
   * @param {THREE.Quaternion|null} [parentQuat] mother world attitude
   * @returns {number} the cell
   */
  assignRackCell(d, parentQuat = null) {
    return this._assignRackCellWith(d, this._herQuatWorldInto(parentQuat, _asgHerQ), false);
  }

  /** @private — `assignRackCell` with her world attitude already in hand; `force` overwrites a valid assignment. */
  _assignRackCellWith(d, herQ, force) {
    const rack = this.heldCatches;
    if (!force && d._rackArm === this && Number.isInteger(d._rackCell) && d._rackLocalM && d._qLocalHer) {
      let taken = false;
      for (let i = 0; i < rack.length; i++) {
        const h = rack[i];
        if (h && h !== d && (Number.isInteger(h._rackCell) ? h._rackCell : i) === d._rackCell) { taken = true; break; }
      }
      // rack-centre (Decision 2): a cell above 0 was laid out on top of the piece then in the cell below; it stays
      // valid only while that same piece is still there (if cell 0 emptied under a flight to cell 1, or another
      // piece took it, the flight ends in the new place — it is re-read, not frozen).
      if (!taken && (d._rackCell < 1 || (d._rackBelow && rackPieceInCell(rack, d._rackCell - 1, d) === d._rackBelow))) {
        return d._rackCell;
      }
    }
    const cell = nextFreeRackCell(rack, d);
    d._armPinned = true;                       // the renderer draws a rack catch at the net-held floor: measure as it does
    seedHerFrameAttitude(d, herQ);             // d._qLocalHer = her⁻¹ × the attitude it is drawn at NOW
    if (!d._rackLocalM) d._rackLocalM = new THREE.Vector3();
    const below = cell >= 1 ? rackPieceInCell(rack, cell - 1, d) : null;
    rackCellOffsetInto(d._rackLocalM, this.herSupportZM(), d, cell, d._qLocalHer, 0, below);
    d._rackCell = cell;
    d._rackArm = this;
    d._rackBelow = below;
    d._rackSlide = null;
    return cell;
  }

  /**
   * Cargo-continuity S6/S7: world position of ONE cargo-rack slot.
   *
   * rack-snug (Decision 4): her position + her attitude · the cell's stored offset on her
   * (`heldSlotAnchorInto`) — the ONE computation the rack pin, the cargo flight's end, the keep-out sphere and the
   * CoM booking all read. A piece with no stored offset yet (a prediction by size, an old save) takes the
   * typeless form for `slotIndex`.
   *
   * @param {number} slotIndex — the cell (0-based) when no piece is given or stored
   * @param {number} sizeMeter — the piece's size, for a prediction
   * @param {THREE.Vector3|null} parentPos — unused (her position is `this.position`); kept for the callers
   * @param {THREE.Vector3} out — receives the position, scene units
   * @param {object|null} [d] — the piece; defaults to `heldCatches[slotIndex]`
   * @param {THREE.Quaternion|null} [parentQuat] — mother world attitude
   * @returns {THREE.Vector3} out
   */
  heldSlotWorldInto(slotIndex, sizeMeter, parentPos, out, d = null, parentQuat = null) {
    const piece = d || this.heldCatches[slotIndex] || null;
    const cell = (piece && Number.isInteger(piece._rackCell)) ? piece._rackCell : slotIndex;
    rackOffsetFor(_slotOffTmp, this, piece, cell, sizeMeter);
    return heldSlotAnchorInto(this.position, this._herQuatWorldInto(parentQuat, _slotHerQ), _slotOffTmp, out);
  }

  /**
   * rack-centre fix round 1: where a parked piece is DRAWN right now (scene units) — its stored cell, except during
   * the cell-1 → cell-0 slide, when it is the slide's current point (the stored offset is already the END place).
   * The keep-out spheres read this, so the sphere follows the piece for the second the slide takes.
   * @param {object} d the piece (in this daughter's rack)
   * @param {THREE.Vector3} out receives the position, scene units
   * @param {THREE.Quaternion|null} [parentQuat] mother world attitude
   * @returns {THREE.Vector3|null} out, or null when the piece has no stored offset
   */
  heldDrawnWorldInto(d, out, parentQuat = null) {
    if (!d || !d._rackLocalM) return null;
    const off = (d._rackSlide && this._slideHeldCatch(d, _slotOffTmp)) ? _slotOffTmp : d._rackLocalM;
    return heldSlotAnchorInto(this.position, this._herQuatWorldInto(parentQuat, _slotHerQ), off, out);
  }

  /**
   * catch-snug: her solid-mesh vertices (her frame, metres), collected once — the hold standoff
   * measures against these as well as the bodyDims box. Null before the mesh exists.
   * @returns {Float32Array|null}
   * @private
   */
  _solidPointsM() {
    if (!this.mesh) return null;
    if (!this._holdSolidPts) this._holdSolidPts = collectSolidPointsM(this.mesh);
    return this._holdSolidPts;
  }

  /**
   * catch-snug / rack-snug (Decision 5): ease a freshly stowed piece from where it sat IN HAND to its cell on her
   * over ARM_HOLD_GLIDE_S (smoothstep), in HER frame, writing the centre (her frame, metres) into `out`. Driven by
   * this daughter's own HOLDING_CATCH `stateTimer` (the stow frame itself is still DOCKING, so it lands exactly
   * where the in-hand pin put it — no jump). Her attitude on the piece is frozen from the stow, so only the centre
   * moves.
   *
   * The in-hand point is along the net's launch direction, which can be any side of her (even behind), so a straight
   * line could pass through her. The path therefore keeps the in-hand rule at every instant: the direction from her
   * to the piece swings from the in-hand direction to her +Z while the centre rides the "support shell"
   * `dir · catchHoldStandoffM(dir)` — no part of it ever nearer than the net gap along `dir`, so it cannot touch
   * her. rack-centre: the cell is ON her axis, so the swing's end IS the cell and it takes the whole glide (the
   * old beside-her layout swung for 60 % and then slid sideways along her X for the rest; a cell with a sideways
   * offset still does). A typeless piece (nothing drawn to measure) goes straight.
   * @param {object} d the stowed piece (carries `_holdGlide`)
   * @param {THREE.Quaternion} herQ her world attitude (the piece's attitude is already herQ × qLocalHer)
   * @param {THREE.Vector3} out receives the centre, her frame, metres
   * @returns {boolean} false when the glide is over (it is cleared) — `out` is untouched
   * @private
   */
  _glideHeldCatch(d, herQ, out) {
    const g = d._holdGlide;
    const dur = Constants.ARM_HOLD_GLIDE_S ?? 0;
    const f = this.state === S.HOLDING_CATCH ? this.stateTimer / dur : 0;
    if (!g || g.arm !== this || !(dur > 0) || !(f < 1) || !d._rackLocalM) { d._holdGlide = null; return false; }
    const s = f * f * (3 - 2 * f);
    const cell = d._rackLocalM;
    const SWING = (Math.abs(cell.x) < 1e-9 && Math.abs(cell.y) < 1e-9) ? 1 : 0.6;
    if (g.dir0 === null) { out.lerpVectors(g.fromM, cell, s); return true; }
    if (s < SWING) {
      const u = s / SWING;
      const c = Math.max(-1, Math.min(1, g.dir0.z));         // cos of the angle from her +Z
      if (c > 1 - 1e-9) _gdDir.set(0, 0, 1);
      else {
        _gdAxis.set(g.dir0.y, -g.dir0.x, 0);                  // dir0 × (0,0,1)
        if (_gdAxis.lengthSq() < 1e-12) _gdAxis.set(1, 0, 0); // dead behind her: round her X
        else _gdAxis.normalize();
        _gdDir.copy(g.dir0).applyAxisAngle(_gdAxis, Math.acos(c) * u);
      }
      _gdWorld.copy(_gdDir).applyQuaternion(herQ);
      const standoff = catchHoldStandoffM(herQ, this.config.bodyDims, d, _gdWorld,
        Constants.ARM_HOLD_NET_GAP_M ?? 0.03, this._solidPointsM());
      if (standoff === null) { out.lerpVectors(g.fromM, cell, s); return true; }
      out.copy(_gdDir).multiplyScalar(standoff);
      return true;
    }
    const w = (s - SWING) / (1 - SWING);
    out.set(cell.x * w, 0, cell.z);
    return true;
  }

  /**
   * Cargo-continuity S6: pin every piece on the parked cargo rack at its cell.
   *
   * rack-snug (Decisions 1-5): a cell is a place ON HER. Each piece is held at her position + her attitude · its
   * stored offset (`d._rackLocalM`, assigned when it arrived: `_stowHeldCatch`, or the start of a cargo flight),
   * and its drawn attitude is rewritten every frame from `herQ × d._qLocalHer` (the engine reads tumbleAxis /
   * tumbleAngle for the drawn instance; nobody else writes them once it is pinned). So turning the ship or swinging
   * the strut carries the whole rack with her, and the piece's place never depends on world up, a hold axis or the
   * other cell. A piece with no assignment yet (an old save, a rig that pushed straight onto `heldCatches`) is
   * assigned here, at its array position, keeping its current attitude.
   *
   * A freshly stowed in-hand piece glides in (`_glideHeldCatch`). rack-centre (Decision 3): a piece in a cell above
   * 0 whose lower cell has emptied (the piece below was digested, unloaded, dropped or released — every leave site
   * is covered because the test is made HERE, every pin) takes the lower cell: its offset is re-laid out with the
   * same rule, its attitude stays, and it slides there along her axis over ARM_HOLD_GLIDE_S (`_slideHeldCatch`, on
   * this daughter's own clock). Her attitude is computed fresh each call
   * (`_herQuatWorldInto`), from `parentQuat` or the player's; with neither it is the strut basis in the ship frame.
   * @param {THREE.Vector3|null} [parentPos] freshest mother position (unused; her position is `this.position`)
   * @param {THREE.Quaternion|null} [parentQuat] mother world attitude
   * @private
   */
  _pinHeldCatches(parentPos = null, parentQuat = null) {
    const rack = this.heldCatches;
    if (rack.length === 0) return;
    const herQ = this._herQuatWorldInto(parentQuat, _pinHerQ);
    for (let i = 0; i < rack.length; i++) {
      const d = rack[i];
      if (!d) continue;
      if (!d._armPinPos) d._armPinPos = new THREE.Vector3();
      d._armPinned = true;
      if (d._rackArm !== this || !d._rackLocalM || !d._qLocalHer || !Number.isInteger(d._rackCell)) {
        this._assignRackCellWith(d, herQ, true);
      }
      if (d._rackCell >= 1 && !rackPieceInCell(rack, d._rackCell - 1, d)) this._lowerRackCell(d);
      applyHerFrameAttitude(d, herQ);
      let shown = false;                       // _pinLocal written by a glide / slide in progress
      if (d._holdGlide) shown = this._glideHeldCatch(d, herQ, _pinLocal);
      if (!shown && d._rackSlide) shown = this._slideHeldCatch(d, _pinLocal);
      if (!shown) _pinLocal.copy(d._rackLocalM);
      heldSlotAnchorInto(this.position, herQ, _pinLocal, d._armPinPos);
    }
  }

  /**
   * rack-centre (Decision 3): the cell below `d`'s has emptied — move `d` down one cell. Its attitude is kept; its
   * offset is re-laid out by the one cell function (so every reader sees the new place at once); the glide of its
   * centre from where it is drawn NOW to the new place is started on this daughter's own clock (`_rackClockS`).
   * @param {object} d the piece (already assigned to this daughter, `_rackCell` >= 1)
   * @private
   */
  _lowerRackCell(d) {
    // where it is drawn now (a slide already under way continues from its current point; `d._rackLocalM` is still the old place)
    if (!(d._rackSlide && this._slideHeldCatch(d, _lrFrom))) _lrFrom.copy(d._rackLocalM);
    const cell = d._rackCell - 1;
    const below = cell >= 1 ? rackPieceInCell(this.heldCatches, cell - 1, d) : null;
    rackCellOffsetInto(d._rackLocalM, this.herSupportZM(), d, cell, d._qLocalHer, 0, below);
    d._rackCell = cell;
    d._rackBelow = below;
    d._holdGlide = null;
    d._rackSlide = (Constants.ARM_HOLD_GLIDE_S ?? 0) > 0
      ? { arm: this, fromM: _lrFrom.clone(), t0: this._rackClockS || 0 }
      : null;
  }

  /**
   * rack-centre (Decision 3): ease a piece that moved down a cell to its new place, straight along her axis (her
   * frame), smoothstep over ARM_HOLD_GLIDE_S, on `_rackClockS` (advanced by `update`; `stateTimer` is reset by the
   * unload and cannot time it). The target is the piece's stored offset, read now.
   * @param {object} d
   * @param {THREE.Vector3} out receives the centre, her frame, metres
   * @returns {boolean} false when the slide is over (it is cleared) — `out` is untouched
   * @private
   */
  _slideHeldCatch(d, out) {
    const sl = d._rackSlide;
    const dur = Constants.ARM_HOLD_GLIDE_S ?? 0;
    if (!sl || sl.arm !== this || !(dur > 0) || !d._rackLocalM) { d._rackSlide = null; return false; }
    const f = ((this._rackClockS || 0) - sl.t0) / dur;
    if (!(f < 1)) { d._rackSlide = null; return false; }
    const k = f <= 0 ? 0 : f * f * (3 - 2 * f);
    out.lerpVectors(sl.fromM, d._rackLocalM, k);
    return true;
  }

  // ==========================================================================
  // CARRY (trip-melt-2 "carry", owner 2026-10-19: catches "need to be melted down in the furnace during the long ion
  // burn"). While the trip burns, ArmManager.requestCarry sends a daughter with a catch on her rack to HER radiator's
  // tip furnace and home again:
  //   CARRY_PREP     docked; the strut and the radiators move to the carry pose (the gate table's angles)
  //   CARRY_OUT      the 1.5 s clamp release, then the straight flight to the tip in her docked attitude (ship-relative,
  //                  so the ship turning under the trip's hold does not move her relative to the ship)
  //   CARRY_HANDOFF  the catch leaves her rack for the tip (TipCargo.stow), a beat at the tip
  //   CARRY_BACK     the same line in reverse, wound by her strut reel (mother battery), no attitude change
  // then DOCKED / HOLDING_CATCH as her rack says. Her thrusters start and stop the outward leg (fuel, mass-scaled).
  // Nothing here knows where the poses come from: the manager hands a plan (js/test/fixtures/carry-gate.json).
  // ==========================================================================

  /** She is on a carry (CARRY_PREP … CARRY_BACK). ArmManager and the trip read it. */
  get isCarrying() {
    return this._carry != null;
  }

  /** kg she moves on a carry: her own mass, every piece on her rack and one net each (reel-home's line-up scaling). */
  carryMassKg() {
    const armMass = this.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS;
    const nc = getNetClassForType(this.type);
    const netKg = nc && typeof nc.MASS === 'number' ? nc.MASS : 0;
    let m = armMass;
    for (const d of this.heldCatches) if (d) m += (d.mass || 0) + netKg;
    return m;
  }

  /** The % of her fuel the push costs: her thrusters start and stop her, 2 × PAYOUT_MPS against the tank's Δv, mass-scaled. */
  carryFuelPct() {
    const armMass = this.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS;
    const massScale = Math.max(1, this.carryMassKg() / armMass);
    const v = (Constants.CARRY && Constants.CARRY.PAYOUT_MPS) || 0.2;
    return (2 * v / (this.config.totalDeltaV || Constants.ARM_TOTAL_DELTAV)) * 100 * massScale;
  }

  /** @private one comms line (the carry's own) */
  _carrySay(text, priority = 'info') {
    eventBus.emit(Events.COMMS_MESSAGE, { text, priority });
  }

  /**
   * Start a carry: take the tip slot (reserved) and the strut (reserved, target the carry angle), and go to CARRY_PREP.
   * ArmManager.requestCarry has already checked every precondition; this refuses (false, nothing taken) only what it
   * cannot do itself: not at home, a carry already, no tip store / petal hold. petal-single: the prep is SEQUENCED - her
   * strut swings first (the other petals standing still), then ONLY HER petal swings to the carry angle - because the gate
   * certifies those two swings one after the other, not together. The petal is taken (held) when the strut is there.
   * @param {{tipIndex:number, cell:number, delivered:object, strutRad:number, thetaRad:number, recordedStrutRad:number,
   *   mission?:boolean}} plan  the delivered piece is the outermost on her rack
   * @returns {boolean}
   */
  beginCarry(plan) {
    if (this._carry || !plan || !plan.delivered) return false;
    if (this.state !== S.HOLDING_CATCH && this.state !== S.DOCKED) return false;
    if (this.heldCatches.indexOf(plan.delivered) < 0) return false;
    const ps = this._playerSatellite;
    const tc = ps && ps.tipCargo;
    if (!ps || !tc || typeof tc.reserve !== 'function' || typeof ps.holdPetalForHandoff !== 'function') return false;
    if (!tc.reserve(plan.tipIndex)) return false;
    this._carry = {
      tipIndex: plan.tipIndex, cell: plan.cell, delivered: plan.delivered, mission: plan.mission === true,
      az: Constants.THERMAL.FLOWER.AZIMUTHS_DEG[plan.tipIndex],
      strutRad: plan.strutRad, thetaRad: plan.thetaRad, recordedStrutRad: plan.recordedStrutRad,
      dir: Number.isInteger(plan.dir) ? plan.dir : null, q0: new THREE.Quaternion(), q1: null,   // dir: how her body trails at the seat (gate); null = no turn
      home: this.state, phase: 'prep', stage: 'strut', endWhy: null,
      prepS: 0, clampS: 0, holdS: 0, u: 0, durationS: 1, flightM: 0, fuelPct: 0,
      handedOff: false, strutHeld: this._aimReserved === true,
      start: new THREE.Vector3(), flight: new THREE.Vector3(),
    };
    this._aimReserved = true;                       // StrutAuto leaves the strut alone until the carry is over
    this._strutTargetAlpha = plan.strutRad;
    this._transitionTo(S.CARRY_PREP);
    return true;
  }


  /** Seat her at the ship-relative point `start + flight · smoothstep(u)` in her docked attitude, the rack riding with her. @private */
  _carrySeat(parentPos, parentQuat, u) {
    const c = this._carry;
    const s = u * u * (3 - 2 * u);
    _carryLocal.copy(c.flight).multiplyScalar(s).add(c.start);
    if (c.q1) {                                                   // her turn (ArmDockBasis carry*): none while she leaves her strut, over at 55 % of the line
      const att = this._carryAtt || (this._carryAtt = new THREE.Quaternion());
      att.copy(c.q0);
      const rho = carryRotFrac(s, c.flightM, Constants.CARRY.OWN_STRUT_FREE_M);
      if (rho > 0) att.slerp(c.q1, rho);
    }
    if (parentQuat) _carryLocal.applyQuaternion(parentQuat);
    if (parentPos) this.position.copy(parentPos).add(_carryLocal);
    this.velocity.set(0, 0, 0);
    this._carrySeatAttitude(parentPos, parentQuat);
  }

  /** Her docked attitude (the strut is held, so it is the one she left the dock with); the rack follows. @private */
  _carrySeatAttitude(parentPos, parentQuat) {
    this._lastParentQuat = parentQuat
      ? (this._lastParentQuatV || (this._lastParentQuatV = new THREE.Quaternion())).copy(parentQuat)
      : null;
    this._herQuatWorldInto(parentQuat, _carryQ);
    this.group.quaternion.copy(_carryQ);
    this._pinHeldCatches(parentPos, parentQuat);
  }

  /**
   * @private CARRY_PREP: docked on the strut tip while the strut and HER petal reach the carry pose - one after the other
   * (stage 'strut', then 'petal') - and, after the flight, leave it in the reverse order (stage 'unpetal', then 'unstrut'). The
   * gate certifies each swing alone. Before the flight the certified conditions are looked at again at each step
   * (`ArmManager.carryConditions`): if they no longer hold she goes back the way she came and tries again later (no give-up).
   */
  _updateCarryPrep(dt, parentPos, parentQuat) {
    const c = this._carry;
    if (!c) { this._transitionTo(this.heldCatches.length ? S.HOLDING_CATCH : S.DOCKED); return; }
    if (parentPos) {
      const offset = _dockOffTmp.copy(this.dockOffset);
      if (parentQuat) offset.applyQuaternion(parentQuat);
      this.position.copy(parentPos).add(offset);
    }
    this.tetherLine.visible = false;
    this.velocity.set(0, 0, 0);
    this._carrySeatAttitude(parentPos, parentQuat);
    c.prepS += dt;
    const V = Constants.CARRY;
    const ps = this._playerSatellite;
    const D2R = Math.PI / 180;
    const sTol = V.STRUT_ARRIVE_DEG * D2R;
    // the strut: its driver clears the target within 0.57° of it; the carry keeps the target alive until the strut has landed
    // within the certified tolerance (each frame's step is exact once the remainder is under one step)
    const strutTo = (target) => {
      const err = Math.abs(this.getAimAlpha() - target);
      if (err >= sTol && this._strutTargetAlpha === undefined) this._strutTargetAlpha = target;
      return err < sTol;
    };
    const limit = () => {
      if (c.prepS <= V.PREP_MAX_S) return false;
      if (c.stage === 'strut' || c.stage === 'petal') {
        this._carrySay(`Daughter ${this.index + 1} could not reach the carry pose; her catch stays on her rack.`, 'warning');
        this.abortCarry('prep timeout');
      } else {
        this.abortCarry('unprep timeout');                  // the abort restores both at once; she snaps docked
      }
      return true;
    };
    if (c.stage === 'strut' || c.stage === 'petal') {
      const mgr = ps && ps.armManager;
      const cond = mgr && typeof mgr.carryConditions === 'function' ? mgr.carryConditions(this) : null;
      if (cond) { this._carryBeginUnprep('conditions'); return; }
    }
    if (c.stage === 'strut') {
      if (strutTo(c.strutRad)) {
        // her strut is there; now HER petal alone: it starts from the shared angle and lands exactly on the carry angle
        if (!ps || ps.holdPetalForHandoff(c.az, c.thetaRad) === null) { this.abortCarry('hold lost'); return; }
        c.stage = 'petal';
        c.prepS = 0;
      } else limit();
      return;
    }
    if (c.stage === 'petal') {
      // a hold that vanished (a snap-to-stow, a new game) ends the carry
      if (!ps || typeof ps.isPetalHolding !== 'function' || !ps.isPetalHolding(c.az)) { this.abortCarry('hold lost'); return; }
      strutTo(c.strutRad);                                 // the strut must stay on its angle while the petal swings
      const thErr = Math.abs(ps.petalThetaRad(c.az) - c.thetaRad);
      if (thErr < V.THETA_ARRIVE_DEG * D2R && Math.abs(this.getAimAlpha() - c.strutRad) < sTol) {
        this._carryBeginOut(parentPos, parentQuat);        // (the conditions were looked at above, this frame)
      } else limit();
      return;
    }
    if (c.stage === 'unpetal') {
      // the petal goes back to the shared angle first (released in `_carryBeginUnprep`); the record goes when it has landed
      if (!ps || typeof ps.isPetalHeld !== 'function' || !ps.isPetalHeld(c.az)) { c.stage = 'unstrut'; c.prepS = 0; this._strutTargetAlpha = c.recordedStrutRad; }
      else limit();
      return;
    }
    if (c.stage === 'unstrut') {
      if (strutTo(c.recordedStrutRad)) this._carryFinish(c.endWhy || 'home');
      else limit();
    }
  }

  /**
   * End the carry the way it began, in reverse: her petal first (released: it swings back to the shared angle), then her
   * strut back to the angle it was recorded at. She stays in CARRY_PREP until both are done. `why`: 'home' (the flight is
   * over) or 'conditions' (the certified conditions stopped holding before the flight: she tries again later).
   * @private
   */
  _carryBeginUnprep(why) {
    const c = this._carry;
    if (!c) return;
    const ps = this._playerSatellite;
    c.endWhy = why;
    c.prepS = 0;
    c.u = 0;
    this._carryAtt = null;                                         // she is docked now (the flight ended at u = 0)
    if (ps && typeof ps.isPetalHolding === 'function' && ps.isPetalHolding(c.az)) ps.releasePetalHandoff(c.az);
    if (ps && typeof ps.isPetalHeld === 'function' && ps.isPetalHeld(c.az)) {      // held (just released) or still swinging back
      c.stage = 'unpetal';
    } else {
      c.stage = 'unstrut';
      this._strutTargetAlpha = c.recordedStrutRad;
    }
    if (this.state !== S.CARRY_PREP) this._transitionTo(S.CARRY_PREP);
  }


  /**
   * The strut and radiators are there: plan the line from the dock to the tip's bag point for the delivered piece, pay
   * the push, go to CARRY_OUT (the clamp hold first). The piece's centre and the bag point are both ship-local, now.
   * @private
   */
  _carryBeginOut(parentPos, parentQuat) {
    const c = this._carry;
    const V = Constants.CARRY;
    const ps = this._playerSatellite;
    const tc = ps && ps.tipCargo;
    const d = c.delivered;
    c.start.copy(this.dockOffset);                                   // docked: the strut tip, ship-local scene units
    this._herQuatWorldInto(_idQuat, _carryQ);                        // her attitude in the ship's frame
    heldSlotAnchorInto(c.start, _carryQ, d._rackLocalM, _carryC);    // the delivered piece's centre, ship-local
    const reach = DebrisField.trueReachM(d, 0);                      // the bag the tip will hold: the catch as drawn
    if (!tc || !tc.bagPointShipInto(c.tipIndex, reach, _carryF)) {
      this.abortCarry('no tip');
      return;
    }
    // petal-single: she turns on the way so her body trails away from the radiator (the gate's final attitude, same functions)
    c.q0 = c.q0 || new THREE.Quaternion();
    c.q0.copy(_carryQ);
    c.q1 = null;
    if (Number.isInteger(c.dir) && tc.hingeQuatShipInto && tc.hingeQuatShipInto(c.tipIndex, _carryHq)) {
      _carryCL.copy(_carryC).sub(c.start).applyQuaternion(_carryQi.copy(c.q0).invert());      // the catch in her frame
      _carryU0.copy(c.start).sub(_carryC).normalize();                                        // catch -> her centre
      carryDirInto(_carryHq, c.dir, _carryD2);
      c.q1 = carryFinalQuatInto(c.q0, _carryU0, _carryD2, new THREE.Quaternion());
      _carryF.sub(_carryCL.applyQuaternion(c.q1));                                            // her centre when the catch is on the bag point
      c.flight.copy(_carryF).sub(c.start);
    } else {
      c.flight.copy(_carryF).sub(_carryC);                                                    // no turn: the catch's displacement is hers
    }
    c.flightM = c.flight.length() / M;
    c.durationS = Math.max(0.5, c.flightM / (V.PAYOUT_MPS || 0.2));
    const pct = this.carryFuelPct();
    if (!(this.fuel >= pct)) {
      this._carrySay(`Daughter ${this.index + 1} has too little fuel to carry her catch; it stays on her rack.`, 'warning');
      this.abortCarry('fuel');
      return;
    }
    this.fuel -= pct;                                                // her thrusters start and stop her
    c.fuelPct = pct;
    c.phase = 'clamp';
    c.clampS = 0;
    c.u = 0;
    this._transitionTo(S.CARRY_OUT);
    if (!c.mission) this._carrySay(`Daughter ${this.index + 1} carries her catch to radiator ${c.tipIndex + 1}'s furnace.`);   // a mission carry says its line at the end
    this._carrySeat(parentPos, parentQuat, 0);
  }

  /** @private CARRY_OUT: the clamp hold, then the flight to the tip. */
  _updateCarryOut(dt, parentPos, parentQuat) {
    const c = this._carry;
    if (!c) { this._transitionTo(this.heldCatches.length ? S.HOLDING_CATCH : S.DOCKED); return; }
    const V = Constants.CARRY;
    if (c.phase === 'clamp') {
      c.clampS += dt;
      this._carryThread = null;
      this._carrySeat(parentPos, parentQuat, 0);
      if (c.clampS >= V.CLAMP_S) c.phase = 'out';
      return;
    }
    c.u = Math.min(1, c.u + dt / c.durationS);
    this._carrySeat(parentPos, parentQuat, c.u);
    if (c.u < 1) this._carryThreadStep(dt, parentPos, parentQuat);       // reel-gas: the ion thread keeps the line tight on the way out
    if (c.u >= 1) {
      c.phase = 'handoff';
      c.holdS = 0;
      this._transitionTo(S.CARRY_HANDOFF);
      this._carryStow();
    }
  }

  /**
   * The delivered catch leaves her rack (unloadHeldCatches' clearing, no NET_CONSUMED) and the tip takes it, arriving
   * along the line latch → catch centre, then turning onto the boom. A rack catch has no mother-net record: none of
   * LeashDriver._latch's net steps. CARGO_TRANSFER_COMPLETE names no pod (podIndex -1: a real index would fade an
   * unrelated `pod_N` bag); `fromArmIndex` lets the net visual keep the catch's bag drawn at the tip.
   * @returns {boolean} stowed (false: the catch stays on her rack and rides home)
   * @private
   */
  _carryStow() {
    const c = this._carry;
    const d = c && c.delivered;
    const ps = this._playerSatellite;
    const tc = ps && ps.tipCargo;
    const idx = d ? this.heldCatches.indexOf(d) : -1;
    if (!tc || idx < 0) return false;
    const reach = DebrisField.trueReachM(d, 0);
    if (!tc.fits(reach) || tc.debrisAt(c.tipIndex) || !tc.latchWorldInto(c.tipIndex, _carryV)) {
      this._carrySay(`Daughter ${this.index + 1} could not seat her catch on radiator ${c.tipIndex + 1}; she brings it home.`, 'warning');
      return false;
    }
    // the line the bag arrives along: latch → the catch's centre now (world; the radiator frame turns with the ship)
    const pin = d._armPinPos || this.position;
    _carryDir.copy(pin).sub(_carryV);
    // rack release, as ArmManager.unloadHeldCatches does it (the piece is paid later, by the tip)
    this.heldCatches.splice(idx, 1);
    d._armPinned = false;
    d._capturedByArm = null;
    d._breakdownActive = false;
    clearRackCell(d);
    if (this.capturedDebris === d) this.capturedDebris = null;
    const ok = tc.stow(c.tipIndex, d, { massKg: d.mass || 0, radiusM: reach, fromDirWorld: _carryDir });
    if (!ok) {
      // cannot happen after the checks above; put the piece back on its rack rather than lose it
      this.heldCatches.splice(idx, 0, d);
      d._armPinned = true;
      return false;
    }
    tc.swingToBoom(c.tipIndex);
    c.handedOff = true;
    if (ps._attitudeInertia !== undefined) ps._attitudeInertia = null;
    eventBus.emit(Events.CARGO_TRANSFER_COMPLETE, {
      debrisId: d.id, massKg: d.mass || 0, podIndex: -1, armIndex: -1, armId: null,
      fromArmIndex: this.index, to: { kind: 'tip', tipIndex: c.tipIndex },
    });
    return true;
  }

  /** @private CARRY_HANDOFF: a beat at the tip, then back. */
  _updateCarryHandoff(dt, parentPos, parentQuat) {
    const c = this._carry;
    if (!c) { this._transitionTo(this.heldCatches.length ? S.HOLDING_CATCH : S.DOCKED); return; }
    c.holdS += dt;
    this._carrySeat(parentPos, parentQuat, 1);
    if (c.holdS >= (Constants.CARRY.HANDOFF_S ?? 1)) {
      c.phase = 'back';
      this._transitionTo(S.CARRY_BACK);
    }
  }

  /** @private CARRY_BACK: the line in reverse, wound by her strut reel (mother battery). Ends docked. */
  _updateCarryBack(dt, parentPos, parentQuat) {
    const c = this._carry;
    if (!c) { this._transitionTo(this.heldCatches.length ? S.HOLDING_CATCH : S.DOCKED); return; }
    const u0 = c.u;
    c.u = Math.max(0, c.u - dt / c.durationS);
    this._carrySeat(parentPos, parentQuat, c.u);
    if (c.u < u0) this._carryThreadStep(dt, parentPos, parentQuat);      // reel-gas: the same thread on the way back
    // the strut reel cartridge bills the mother's battery the real mechanical power: line tension × line speed ÷ efficiency,
    // floored at its own motor while turning (as REELING bills). dt 0 (a held world) bills nothing.
    if (dt > 0 && c.u < u0) {
      const MD = Constants.MOTOR_DRAW_W || {};
      const rs = this._playerSatellite && this._playerSatellite._resourceSystem;
      if (rs && typeof rs.billWatts === 'function') {
        const speed = (c.flightM / c.durationS) * 6 * c.u * (1 - c.u) + 1e-6;   // m/s, smoothstep derivative
        const tension = this.carryMassKg() * speed * (Constants.REEL_TENSION_COEFF ?? 0.04);
        const mechW = tension * speed / (MD.REEL_EFFICIENCY || 0.5);
        rs.billWatts(Math.min(MD.REEL_MAX ?? 2500, Math.max(MD.STRUT_REEL_MIN ?? 15, mechW)), dt);
      }
    }
    if (c.u <= 0) this._carryBeginUnprep('home');                  // petal first, then the strut (the reverse of the prep)
  }

  /**
   * End the carry: the tip reservation cleared, the strut target back to the recorded angle and its reservation released
   * (StrutAuto acts only on DOCKED daughters), her petal released if it is still held, and she is DOCKED / HOLDING_CATCH
   * as her rack says. The normal end comes here AFTER the sequenced unprep (petal landed, strut back), so the last two do
   * nothing; the abort path (`abortCarry`) arrives with both still out and restores them at once. Her position snaps to the
   * dock (the state's own update pins it from here). `why` 'home' on a mission with a catch left on a tip says so.
   * @private
   */
  _carryFinish(why) {
    const c = this._carry;
    if (!c) return;
    this._carry = null;
    this._carryThread = null;
    this._carryAtt = null;                                         // docked attitude again (derived from the strut)
    if (why === 'prep timeout' || why === 'hold lost' || why === 'no tip' || why === 'fuel') this._carryGaveUp = true;
    const ps = this._playerSatellite;
    const tc = ps && ps.tipCargo;
    if (tc && typeof tc.unreserve === 'function') tc.unreserve(c.tipIndex);
    this._strutTargetAlpha = c.recordedStrutRad;
    if (!c.strutHeld) this._aimReserved = false;
    if (ps && typeof ps.isPetalHolding === 'function' && ps.isPetalHolding(c.az)) ps.releasePetalHandoff(c.az);
    this.tetherLine.visible = false;
    this.tetherTension = 0;
    const held = this.heldCatches.length > 0;
    // an empty rack on a daughter that left HOLDING_CATCH reloads through HOLDING_CATCH's own empty-rack fallback
    this._transitionTo(held ? S.HOLDING_CATCH : (c.home === S.DOCKED ? S.DOCKED : S.HOLDING_CATCH));
    this.velocity.set(0, 0, 0);
    const pp = ps && ps.position;
    if (pp && this.dockOffset) {
      const off = _dockOffTmp.copy(this.dockOffset);
      if (ps.quaternion) off.applyQuaternion(ps.quaternion);
      this.position.copy(pp).add(off);
      this.group.position.copy(this.position);
      if (this.heldCatches.length) this._pinHeldCatches(pp, ps.quaternion || null);
    }
    this._lastCarryEnd = { why, tipIndex: c.tipIndex, handedOff: c.handedOff };   // for tests and the trip's log
    if (c.mission && c.handedOff && why === 'home') {
      this._carrySay(`Daughter ${this.index + 1} puts her catch on radiator ${c.tipIndex + 1}'s tip; she is free again.`);
    }
  }


  /**
   * Stop a carry now (game over, reset, load, the trip's hard cap, a lost radiator hold): she snaps docked, the catches
   * still on her rack stay there, the strut and radiators are restored, the tip reservation is cleared. A catch already
   * on the tip stays on the tip.
   * @param {string} why
   * @param {{quiet?:boolean}} [opts]
   * @returns {boolean} true when a carry was running
   */
  abortCarry(why, opts = {}) {
    if (!this._carry) return false;
    this._carryFinish(why || 'abort');
    return true;
  }

  // ==========================================================================
  // REEL-HOME (FEATURE_FLAGS.REEL_HOME, owner design 2026-10-19): her net winds the catch in to her nose, then the
  // strut line winds her home TAIL FIRST onto the strut tip, catch leading away; the strut swings and the mother
  // turns (ArmManager `_updateReelHome`) to meet her line.
  // ==========================================================================

  /** reel-home is on for this tethered daughter. @private */
  _rhOn() {
    return !this.isDetached && Constants.isFeatureEnabled('REEL_HOME');
  }

  /** The catch she holds is NET-held — only a net has a line to wind. @private */
  _rhNetCatch() {
    return !!this.capturedDebris && (!this._captureToolKind || this._captureToolKind === 'NET');
  }

  /** She is on the reels (net reel or strut reel). ArmManager gives the mother turn to a daughter that is. */
  get isReelingHome() {
    return this._rhHome === true;
  }

  /** Let go of everything reel-home holds: the strut reservation, the line-up. @private */
  _rhEnd() {
    this._rhHome = false;
    this._rhPinned = false;
    this._rhNetDone = false;
    this._rhArrived = false;
    this._rhHoldS = 0;
    this._rhLineUp = null;
    this._rhNoPath = false;
    this._rhNoPathS = 0;
    this._rhLineUpSaid = false;
    this._rhWaitSaid = false;
    this._rhMotherWorking = false;
    this._rhPlaneErrRad = 0;
    if (this._rhReserved) {
      this._aimReserved = false;
      this._rhReserved = false;
    }
  }

  /** Her net, while it holds the catch (else null). @private */
  _rhNet() {
    const net = this._firedNet
      || (captureNetSystem.getActiveNetForArm ? captureNetSystem.getActiveNetForArm(this.index) : null);
    return net && net._heldByArm ? net : null;
  }

  /**
   * Decision 2: she does not jump onto the catch. The first GRAPPLED frame records where the catch is relative to her
   * (the separation at net close); from then on the catch is pinned at her position + that separation, so the pair
   * is one rigid thing while the net settles and the orbit-driven catch cannot drift away from her.
   * @param {THREE.Vector3|null} tPos the catch's scene position now (first frame only)
   * @private
   */
  _rhHoldCatch(tPos) {
    const d = this.capturedDebris;
    if (!d) return;
    if (!this._rhPinned) {
      if (tPos) this._rhSep.subVectors(tPos, this.position); else this._rhSep.set(0, 0, 0);
      this._rhPinned = true;
    }
    if (!d._armPinPos) d._armPinPos = new THREE.Vector3();
    d._armPinned = true;
    if (this._rhArrived) this._rhPinInCell();
    else d._armPinPos.copy(this.position).add(this._rhSep);
  }

  /** The net reel starts: the strut follows her from here, and the mother may turn for her. @private */
  _rhBeginNetReel() {
    this._rhHome = true;
    this._rhArrived = false;
    this._rhTurnTries = 0;
    this._rhTurnWaitS = 0;
    this._rhHoldS = 0;
  }

  /**
   * Decision 3: one frame of the net reel. The line shortens at REEL_HOME.NET_REEL_MPS until the catch sits at the
   * rack cell it will take (`rackCellOffsetInto`, the one rack-centre rule: on her +Z axis, a net gap past her nose
   * end), the pair's centre of mass staying put — she and the catch close on each other in inverse ratio to their
   * masses (`_computeReelMUnit`: the catch side is the catch plus its net). She turns her nose to the catch (the
   * attitude block in `update`); the catch's own attitude stays frozen (it is pinned, not tumbling). The catch is
   * brought onto her axis only once her nose is within REEL_HOME.ARRIVE_TOL_DEG of the line, then assigned its
   * cell NOW (`_assignRackCellWith`) and fixed in her frame from there on.
   * @param {number} dt seconds
   * @returns {boolean} true when the catch is in its cell
   * @private
   */
  _rhNetReelStep(dt) {
    const d = this.capturedDebris;
    if (!d) return true;
    const RH = Constants.REEL_HOME || {};
    const sep = this._rhSep;
    const herQ = this.group.quaternion;
    d._armPinned = true;
    if (!d._armPinPos) d._armPinPos = new THREE.Vector3();

    // Where its cell is at her attitude now (the rule reads the catch's attitude in HER frame: seed it, don't store it)
    seedHerFrameAttitude(d, herQ);
    const cell = nextFreeRackCell(this.heldCatches, d);
    const below = cell >= 1 ? rackPieceInCell(this.heldCatches, cell - 1, d) : null;
    rackCellOffsetInto(this._rhCellM, this.herSupportZM(), d, cell, d._qLocalHer, 0, below);
    const cellW = _rhV1.copy(this._rhCellM).multiplyScalar(M).applyQuaternion(herQ);   // her centre -> cell, world
    const cLen = cellW.length();
    const r = sep.length();

    // Wind: r goes to the cell distance at the line speed (a catch nearer than its cell pays out the same way)
    const step = (RH.NET_REEL_MPS ?? 0.5) * M * dt;
    const dr = Math.max(-step, Math.min(step, cLen - r));
    const arrivedLen = Math.abs(cLen - r) <= step + 1e-12;
    let arrive = false;
    if (arrivedLen && r > 1e-12 && cLen > 1e-12) {
      // the line is at its length: only a catch on her axis comes in (her nose is turning to it, at the normal rate)
      const cosAng = sep.dot(cellW) / (r * cLen);
      const tol = Math.cos((RH.ARRIVE_TOL_DEG ?? 0.5) * Math.PI / 180);
      arrive = cosAng >= tol;
    }
    if (r <= 1e-12) arrive = true;

    // Centre of mass: she moves toward (or away from) the catch by the catch's share of the closing
    const armMass = this.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS;
    const mCatch = Math.max(0, this._computeReelMUnit(armMass, true) - armMass);
    const herShare = mCatch / Math.max(1e-9, armMass + mCatch);
    if (arrive) {
      const toCell = Math.max(-step, Math.min(step, cLen - r));
      if (r > 1e-12) this.position.addScaledVector(_rhV2.copy(sep).multiplyScalar(1 / r), -toCell * herShare);
      sep.copy(cellW);
      this._assignRackCellWith(d, herQ, true);          // its cell, offset and attitude in her frame: from here it is hers
      this._rhArrived = true;
      this._rhPinInCell();
      return true;
    }
    if (r > 1e-12 && dr !== 0) {
      _rhV2.copy(sep).multiplyScalar(1 / r);
      this.position.addScaledVector(_rhV2, -dr * herShare);
      sep.copy(_rhV2).multiplyScalar(r + dr);
    }
    d._armPinPos.copy(this.position).add(sep);
    this._rhSyncBag(d._armPinPos, sep);
    return false;
  }

  /**
   * The net's bag lines up with the line it is wound on (launch direction = her centre -> catch) and its tether is
   * drawn taut at the straight length muzzle -> the bag's NECK (net-cinch: the point the bag is drawn at, see below),
   * so the shortening line is seen and never bows slack.
   * @param {THREE.Vector3} catchPos the catch centre, scene units
   * @param {THREE.Vector3} [sepW] her centre -> catch, world (else catchPos - position)
   * @private
   */
  _rhSyncBag(catchPos, sepW = null) {
    const net = this._rhNet();
    if (!net) return;
    const v = sepW ? _rhV3.copy(sepW) : _rhV3.subVectors(catchPos, this.position);
    const len = v.length();
    if (len > 1e-12 && net.launchDirection) {
      net.launchDirection.x = v.x / len;
      net.launchDirection.y = v.y / len;
      net.launchDirection.z = v.z / len;
    }
    if (net.position && Number.isFinite(net.position.x)) {
      this.getNetMuzzleWorldInto(_rhV4);                              // scene units; the net's position is metres
      // Where the bag's neck will BE when it is drawn. Measuring to that, not to the net's position of the previous
      // tick, keeps the drawn line exactly taut while she turns (the one-frame lag was up to 0.12 m at the reel-heading
      // flip).
      const d = net.catchResult === 'success' ? net.targetDebris : null;
      // review R3: the catch as it will be drawn this frame is `catchPos`, the pin just written. ArmManager.update ends with the
      // authoritative pin (DebrisField.pinCapturedDebris: `_scenePosition` = the pin, before the net system and the visual run), so
      // `d._scenePosition` read HERE is last frame's: with the muzzle of this frame it left the line 0.078 m off the drawn neck at
      // the reel-heading flip (measured with the field wired as main.js wires it, test-ReelHomeLook).
      const sp = d ? catchPos : null;
      if (sp && net.launchDirection) {
        // net-cinch: the neck is where CaptureNetVisual draws it (entities/heldBagShape.js: on the tow line from her
        // muzzle, touching the catch's rear, the apex ball's radius clear of the muzzle), from the catch's pin of this
        // frame and the muzzle now, so the picture and the measure agree in the same frame
        heldBagNeckInto(_rhV5, sp, _rhV4, net.launchDirection, heldBagRadiusScene(d), DAUGHTER_STAND_M);
        net.tetherPaidOut = Math.hypot(_rhV4.x - _rhV5.x, _rhV4.y - _rhV5.y, _rhV4.z - _rhV5.z) / M;
      } else {
        net.tetherPaidOut = Math.hypot(_rhV4.x / M - net.position.x, _rhV4.y / M - net.position.y,
          _rhV4.z / M - net.position.z);
      }
    }
  }

  /**
   * Decision 8: the catch in its cell, fixed in HER frame — her actual attitude × the stored offset and attitude.
   * One pin for the net reel's end, REELING and DOCKING (HOLDING_CATCH's `_pinHeldCatches` reads the same offsets).
   * @returns {boolean} false when the catch holds no assignment on her
   * @private
   */
  _rhPinInCell() {
    const d = this.capturedDebris;
    if (!d || d._rackArm !== this || !d._rackLocalM || !d._qLocalHer) return false;
    const herQ = this.group.quaternion;
    if (!d._armPinPos) d._armPinPos = new THREE.Vector3();
    d._armPinned = true;
    applyHerFrameAttitude(d, herQ);
    heldSlotAnchorInto(this.position, herQ, d._rackLocalM, d._armPinPos);
    this._rhSyncBag(d._armPinPos);
    return true;
  }

  /** The mother-frame azimuth of her strut, rad (the same one PlayerSatellite and ArmManager use). @private */
  _rhAzRad() {
    const sg = this._playerSatellite && this._playerSatellite.strutGroups && this.index != null
      ? this._playerSatellite.strutGroups[this.index] : null;
    if (sg && Number.isFinite(sg.azRad)) return sg.azRad;
    if (Number.isFinite(this._azimuthDeg)) return (this._azimuthDeg * Math.PI) / 180;
    return Math.atan2(this.dockOffset.y, this.dockOffset.x);
  }

  /** Her strut's axis, world, unit, root -> tip — as PlayerSatellite has it now, else rebuilt from her aim angle. @private */
  _rhStrutDirWorldInto(parentQuat, out) {
    const ps = this._playerSatellite;
    const sg = ps && ps.strutGroups && this.index != null ? ps.strutGroups[this.index] : null;
    if (sg && sg.strutDir && sg.strutDir.lengthSq() > 1e-12) out.copy(sg.strutDir);
    else strutLocalDirection(this._aimAlpha || 0, this._rhAzRad(), out);
    const pq = parentQuat || (ps && ps.quaternion) || this._lastParentQuat;
    if (pq && typeof pq.x === 'number') out.applyQuaternion(pq);
    return out.normalize();
  }

  /**
   * The strut axis at the angle the strut is HEADING for (fix round F2b): the swing-plane angle nearest the direction
   * hinge -> her (`_rhBestAlpha`) clamped to REEL_HOME.STRUT_MIN_DEG..STRUT_MAX_DEG — the nearest direction the strut
   * can point to, in its plane, never below 34°. The line-up aims her at THIS axis, so it does not chase a strut that
   * is still slewing, and it cannot ask for a direction the strut can never take. Falls back to the live axis.
   * @private
   */
  _rhTargetDirWorldInto(parentQuat, out) {
    if (!Number.isFinite(this._rhBestAlpha)) return this._rhStrutDirWorldInto(parentQuat, out);
    const RH = Constants.REEL_HOME || {};
    const d2r = Math.PI / 180;
    const a = Math.max((RH.STRUT_MIN_DEG ?? 34) * d2r, Math.min((RH.STRUT_MAX_DEG ?? 180) * d2r, this._rhBestAlpha));
    strutLocalDirection(a, this._rhAzRad(), out);
    const ps = this._playerSatellite;
    const pq = parentQuat || (ps && ps.quaternion) || this._lastParentQuat;
    if (pq && typeof pq.x === 'number') out.applyQuaternion(pq);
    return out.normalize();
  }

  /**
   * Decision 5/6 geometry, from the strut hinge (the collar point PlayerSatellite hangs it on): the swing-plane angle
   * nearest the direction hinge -> her (`_rhBestAlpha`, the unclamped answer; ArmManager clamps it) and how far she is
   * off the strut's swing plane (`_rhPlaneErrRad`, signed). Runs every frame while she is on the reels.
   * @private
   */
  _rhStrutAim(parentPos, parentQuat) {
    const pq = parentQuat || this._lastParentQuat;
    if (!parentPos || !pq || !this.dockOffset) return false;
    const V5 = Constants.OCTOPUS_V5 || {};
    const az = this._rhAzRad();
    const hx = Math.cos(az) * (V5.COLLAR_RADIUS ?? 0.4) * M;
    const hy = Math.sin(az) * (V5.COLLAR_RADIUS ?? 0.4) * M;
    const hz = (V5.COLLAR_Y ?? 1.0) * M;
    _rhQ1.copy(pq).invert();
    const rel = _rhV5.subVectors(this.position, parentPos).applyQuaternion(_rhQ1);
    rel.x -= hx; rel.y -= hy; rel.z -= hz;                  // hinge -> her, ship-local
    const len = rel.length();
    if (len < 1e-12) return false;
    rel.multiplyScalar(1 / len);
    const tSide = -rel.x * Math.sin(az) + rel.y * Math.cos(az);
    this._rhPlaneErrRad = Math.asin(Math.max(-1, Math.min(1, tSide)));
    this._rhBestAlpha = bestStrutAlpha(rel, az);
    if (!this._rhRelShip) this._rhRelShip = new THREE.Vector3();
    this._rhRelShip.copy(rel);                 // hinge -> her, ship-local, unit (ArmManager's turn axis and angle)
    return true;
  }

  /**
   * Decision 4: her attitude on the strut reel — −Z toward the strut tip (her +Z and the catch lead away), roll so her
   * +Y is the docked basis's +Y for this strut (DOCKING then only trims residuals). Near the tip the line direction
   * is ill-conditioned, so the aim blends to the strut axis (the docked +Z) over the last 0.75 m.
   * @param {THREE.Vector3} toTip her -> strut tip, scene units (not normalised)
   * @param {number} dist its length
   * @param {THREE.Quaternion|null} parentQuat
   * @param {THREE.Quaternion} out
   * @returns {boolean} false when there is no aim yet
   * @private
   */
  _rhTailFirstQuatInto(toTip, dist, parentQuat, out) {
    const z = _rhV1;
    this._rhStrutDirWorldInto(parentQuat, _rhV2);                  // the strut axis (the docked +Z)
    if (dist > 1e-9) z.copy(toTip).multiplyScalar(-1 / dist); else z.copy(_rhV2);
    const distM = dist / M;
    const w = Math.max(0, Math.min(1, (distM - 0.25) / 0.5));
    const ws = w * w * (3 - 2 * w);
    z.multiplyScalar(ws).addScaledVector(_rhV2, 1 - ws);
    if (z.lengthSq() < 1e-12) return false;
    z.normalize();
    const dockedQ = this._herQuatWorldInto(parentQuat, _rhQ2);
    const y = _rhV3.set(0, 1, 0).applyQuaternion(dockedQ);
    y.addScaledVector(z, -y.dot(z));
    if (y.lengthSq() < 1e-8) {
      y.copy(_WORLD_UP);
      y.addScaledVector(z, -y.dot(z));
      if (y.lengthSq() < 1e-8) y.set(1, 0, 0).addScaledVector(z, -z.x);
    }
    y.normalize();
    const x = _rhV4.crossVectors(y, z);
    _rhM1.makeBasis(x, y, z);
    out.setFromRotationMatrix(_rhM1);
    return true;
  }

  /**
   * Decision 7: start the line-up on her own thrusters — along the circle round the strut tip, into line with the strut
   * axis the strut is heading for (`_rhTargetDirWorldInto`). Billed as her normal fuel: an impulse in and out at
   * ALIGN_SPEED_MPS against the tank's Δv, scaled by the mass she moves (her + the catch + its net, the scaling the old
   * arrest debit used: fix round F4). She may spend ARM_RESERVE_FUEL (F2c): that reserve is kept for a safe reel-home and
   * this is it (a docked daughter holding a catch does not go ADRIFT on it: `_consumeFuel`). Returns false, billing
   * nothing, when she cannot afford it (no fuel) or the whole arc is not clear of the ship; then she holds for the mother
   * and tries again a second later (the geometry changes), with one comms line per reel.
   * @private
   */
  _rhBeginLineUp(dockW, dist, parentPos, parentQuat) {
    const RH = Constants.REEL_HOME || {};
    const v = RH.ALIGN_SPEED_MPS ?? 0.5;
    const armMass = this.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS;
    const massScale = Math.max(1, this._computeReelMUnit(armMass, !!this.capturedDebris) / armMass);
    const dvPct = (2 * v / (this.config.totalDeltaV || Constants.ARM_TOTAL_DELTAV)) * 100 * massScale;
    if (!(this.fuel >= dvPct) || !this._rhArcClear(dockW, dist, parentPos, parentQuat)) {
      if (!this._rhWaitSaid) {
        this._rhWaitSaid = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          source: this.displayName,
          text: `${this.displayName} can't line herself up yet: holding for the mother.`,
          channel: 'CMD', priority: 'info',
        });
      }
      return false;
    }
    this.fuel -= dvPct;
    this._rhLineUp = { R: dist };
    if (!this._rhLineUpSaid) {
      this._rhLineUpSaid = true;
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: this.displayName,
        text: `${this.displayName} lines herself up.`,
        channel: 'CMD', priority: 'info',
      });
    }
    return true;
  }

  /**
   * The great-circle arc from her place to the target strut axis on the circle of radius R about the strut tip is
   * clear of the ship: every 4° of it keeps ALIGN_CLEAR_M (the clearance hook; no hook = clear). Checked before the
   * line-up bills anything, so a blocked arc costs no fuel.
   * @private
   */
  _rhArcClear(dockW, R, parentPos, parentQuat) {
    if (typeof this._rhGapFn !== 'function') return true;
    const RH = Constants.REEL_HOME || {};
    const s = this._rhTargetDirWorldInto(parentQuat, _rhV2);
    const u = _rhV3.subVectors(this.position, dockW);
    const len = u.length();
    if (len < 1e-12) return true;
    u.multiplyScalar(1 / len);
    const ang = Math.acos(Math.max(-1, Math.min(1, u.dot(s))));
    if (ang <= 1e-4) return true;
    const axis = _rhV4.crossVectors(u, s);
    if (axis.lengthSq() < 1e-12) axis.set(u.y, -u.x, 0);
    if (axis.lengthSq() < 1e-12) axis.set(1, 0, 0);
    axis.normalize();
    const n = Math.max(1, Math.ceil(ang / (4 * Math.PI / 180)));
    const clear = RH.ALIGN_CLEAR_M ?? 0.15;
    for (let k = 1; k <= n; k++) {
      _rhQ1.setFromAxisAngle(axis, ang * k / n);
      const p = _rhV1.copy(u).applyQuaternion(_rhQ1).multiplyScalar(R).add(dockW);
      const gap = this._rhGapFn(p, parentPos, parentQuat);
      if (Number.isFinite(gap) && gap < clear) return false;
    }
    return true;
  }

  /**
   * One frame of the line-up: she moves along the great circle of radius R about the strut tip toward the axis the
   * strut is heading for (the swing-plane direction nearest her, never below 34°: `_rhTargetDirWorldInto`), at
   * ALIGN_SPEED_MPS. Greedy from the live tip and the live target, so a swinging strut or a turning mother is followed.
   * A blocked step (the clearance hook says the ship is nearer than ALIGN_CLEAR_M) stops her: she holds, and tries
   * again after a second.
   * @returns {boolean} true while the line-up is still moving
   * @private
   */
  _rhLineUpStep(dt, dockW, parentPos, parentQuat) {
    const lu = this._rhLineUp;
    if (!lu) return false;
    const RH = Constants.REEL_HOME || {};
    const s = this._rhTargetDirWorldInto(parentQuat, _rhV2);
    const u = _rhV3.subVectors(this.position, dockW);
    const len = u.length();
    if (len < 1e-12) { this._rhLineUp = null; return false; }
    u.multiplyScalar(1 / len);
    let ang = Math.acos(Math.max(-1, Math.min(1, u.dot(s))));
    if (ang <= 1e-4 || ang <= 0.5 * (RH.ALIGN_TOL_DEG ?? 10) * Math.PI / 180 * 0.2) {
      this._rhLineUp = null;                      // in line
      return false;
    }
    const axis = _rhV4.crossVectors(u, s);
    if (axis.lengthSq() < 1e-12) axis.set(u.y, -u.x, 0);        // dead opposite: any way round
    if (axis.lengthSq() < 1e-12) axis.set(1, 0, 0);
    axis.normalize();
    const stepAng = Math.min(ang, ((RH.ALIGN_SPEED_MPS ?? 0.5) * dt) / Math.max(lu.R / M, 1e-6));
    _rhQ1.setFromAxisAngle(axis, stepAng);
    const next = _rhV1.copy(u).applyQuaternion(_rhQ1).multiplyScalar(lu.R).add(dockW);
    if (typeof this._rhGapFn === 'function') {
      const gap = this._rhGapFn(next, parentPos, parentQuat);
      if (Number.isFinite(gap) && gap < (RH.ALIGN_CLEAR_M ?? 0.15)) {
        this._rhLineUp = null;                    // the ship is in the way: she holds, and looks again in a second
        this._rhNoPath = true;
        this._rhNoPathS = 0;
        return false;
      }
    }
    this.position.copy(next);
    return true;
  }

  /**
   * Net-integrity check performed as reel-in begins (GRAPPLED → REELING).
   * Two failure modes, both RECOVERABLE (daughter keeps her tether and returns
   * to reload while the debris drifts free, re-capturable):
   *   • OVERSIZE (deterministic): debris is physically wider than the net mouth,
   *     so the net can't actually cinch around it.
   *   • STRAIN (probabilistic): a heavy catch near the net's rated mass slips
   *     the weave, scaling with how close the payload is to the rating.
   * @returns {boolean} true if the net failed (caller must NOT enter REELING)
   * @private
   */
  _checkNetIntegrityOnReel() {
    const debris = this.capturedDebris;
    if (!debris) return false;
    // CP-1 / P2: net-integrity (oversize / strain) only applies to NET catches.
    // A magnetic (or future gripper/pad) grip has no net mouth to overflow, so
    // skip the check entirely — otherwise a large ferrous body grabbed by the
    // EPM would false-fail against the net diameter.
    if (this._captureToolKind && this._captureToolKind !== 'NET') return false;
    const payloadMass = debris.mass || 0;
    const rated = this._netRatedMass || 0;
    // Phase 2 (ASPECT_CAPTURE): judge the width the net actually wrapped at
    // catch time (presented width at contact), not the scalar max extent —
    // an end-on catch of a long body is legitimate.
    const aspectOn = Constants.isFeatureEnabled('ASPECT_CAPTURE');
    const debrisSize = (aspectOn && this._catchPresentedWidthM != null)
      ? this._catchPresentedWidthM
      : (debris.sizeMeter || 0);
    const netDia = this._netDiameter || 0;

    // Hard fail: debris wider than the net mouth can't be enveloped/cinched.
    // The verdict routes through the ONE mouth-fit predicate (register item 21a;
    // the rule's fifth home — register item 87): the bare-number diameter rides
    // the netClass seam, the stored contact-time width the precomputed seam.
    // Byte-identical to the legacy inline form (the refusal form — NaN never refuses).
    const oversized = !fitsMouth(debris, { DIAMETER: this._netDiameter }, null, debrisSize);

    // Probabilistic fail: heavy catch near the net's rated mass slips the weave.
    // The band ramp routes through the ONE strain-band helper (register item
    // 88); the CAP stays here — a one-shot roll vs NET_STRAIN_FAIL_PROB_MAX.
    let strain = 0;
    let strainFail = false;
    if (!oversized && payloadMass > 0 && rated > 0) {
      strain = payloadMass / rated;
      const t = strainBandT(payloadMass, rated);
      if (t > 0) {
        const pMax = Constants.NET_STRAIN_FAIL_PROB_MAX ?? 0;
        strainFail = Math.random() < pMax * t;
      }
    }

    if (!oversized && !strainFail) return false;               // net holds

    // ── Net failed — release the catch; daughter returns to reload ──
    this._releaseCapturedDebris({ keepPinned: false });
    eventBus.emit(Events.NET_FAILED, {
      armId: this.id, armIndex: this.index,
      debrisId: debris.id, strain, oversized, recoverable: true,
    });
    const reason = oversized
      ? `Net failed. Debris too wide for the net (${debrisSize.toFixed(1)}m vs ${netDia.toFixed(1)}m mouth). Returning to reload; a larger net is needed.`
      // Phase 0.4 (capture-feedback overhaul): name the CAUSE so the slip is
      // legible — the catch was deep in the 80-100% strain band, not bad luck.
      : `Net failed. Debris slipped free and is drifting (catch was ${Math.round(strain * 100)}% of the net's rated mass. Slips become likely above ${Math.round((Constants.NET_STRAIN_SAFE_FRACTION ?? 0.8) * 100)}%). Returning to reload; re-net to retry.`;
    // fail-reel: REEL_HOME keeps the cause and says the outcome itself (reeled home / held for a retry)
    const cause = oversized
      ? `Net failed: debris too wide for the net (${debrisSize.toFixed(1)}m vs ${netDia.toFixed(1)}m mouth; a larger net is needed).`
      : `Net failed: debris slipped free and is drifting (catch was ${Math.round(strain * 100)}% of the net's rated mass; slips become likely above ${Math.round((Constants.NET_STRAIN_SAFE_FRACTION ?? 0.8) * 100)}%).`;
    this._finishFailedCatch({
      cause,
      legacy: { text: `${this.displayName}: ${reason}`, priority: 'warning' },
      holdTarget: debris,
    });
    return true;
  }

  /**
   * Phase 3a (capture-feedback overhaul): the net RIPS under boost-reel load —
   * recoverable (mirror of the reel-start strain slip): debris drifts free and
   * re-capturable, daughter keeps her tether and returns to reload.
   * @param {number} strain — payload / rated mass at the moment of the rip
   * @private
   */
  _ripNetDuringBoost(strain) {
    const debris = this.capturedDebris;
    if (!debris) return;
    this._boostReel = false;
    this._releaseCapturedDebris({ keepPinned: false });
    eventBus.emit(Events.NET_FAILED, {
      armId: this.id, armIndex: this.index,
      debrisId: debris.id, strain, oversized: false, recoverable: true,
      cause: 'boost_reel',
    });
    // Cargo-continuity S5: the tear's staging hook — CaptureNetVisual zeroes a
    // wedge of spokes in the bag's per-vertex colour buffer (a visible hole the
    // catch drifts out of); audio/comms/teaching can hang off the same event.
    eventBus.emit(Events.NET_TORN, {
      armId: this.id, armIndex: this.index,
      debrisId: debris.id, strain,
    });
    this._finishFailedCatch({
      cause: `Net RIPPED under boost reel (catch was ${Math.round(strain * 100)}% of rated mass). `
        + 'Debris drifting free. Nominal reel speed is safe; boost prices heavy catches.',
      legacy: {
        text: `${this.displayName}: Net RIPPED under boost reel (catch was ${Math.round(strain * 100)}% of rated mass). `
          + 'Debris drifting free. Nominal reel speed is safe; boost prices heavy catches.',
        priority: 'warning',
      },
      holdTarget: debris,
    });
  }

  /**
   * Catastrophic tether snap during reel-in: the mother↔daughter cable parts.
   * The net stays intact between daughter and debris, so they are cut loose and
   * drift off TOGETHER (debris stays pinned to the now-EXPENDED daughter — it
   * does NOT vanish). A recoil impulse springs the pair clear of the mother and
   * the severed line is hidden. The catch is lost (the daughter can't return),
   * though the runaway debris is left re-targetable so another daughter can give
   * chase. Upgrade the tether to haul heavier loads without snapping.
   * @private
   */
  _snapTether(parentPos) {
    // Recoil: shove the daughter (and her pinned catch) away from the mother
    // along the tether axis so the pair visibly springs free instead of freezing.
    const sep = (Constants.CAPTURE_RELEASE_SEPARATION_MPS || 1.2) * M;
    if (parentPos) {
      const away = this._tmpVec.subVectors(this.position, parentPos);
      if (away.lengthSq() > 1e-20) {
        away.normalize();
        this.velocity.addScaledVector(away, sep);
      }
    }
    // Keep the catch attached to the daughter (net intact) so it drifts with
    // her — coherent, still visible, never silently removed.
    const debris = this._releaseCapturedDebris({ keepPinned: true });
    this._tetherSevered = true;
    this._severedCatch = debris;       // bounded pin — released after a drift delay
    this._severedDriftS = 0;
    this.isDetached = true;            // cut from mother — can't reel/return
    if (this.tetherLine) this.tetherLine.visible = false;
    eventBus.emit(Events.TETHER_SNAP, {
      armIndex: this.index, armId: this.id, cause: 'overload',
      debrisId: debris && debris.id, recoverable: false,
    });
    this._transitionTo(S.EXPENDED);
  }


  /**
   * HAULING: tow debris back toward parent (slow).
   * Legacy state — preserved for backward compatibility.
   * V5 uses REELING instead for zero-fuel motor reel-in.
   */
  _updateHauling(dt, parentPos) {
    // Detached arms can't return — redirect to deorbit sacrifice
    if (this.isDetached) {
      this._transitionTo(S.DEORBITING);
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: No tether. Committing to deorbit burn. Sacrificial play.`,
        priority: 'warning',
      });
      return;
    }

    const toParent = this._tmpVec.subVectors(parentPos, this.position);
    const dist = toParent.length();

    toParent.normalize();
    const haulSpeed = this.config.haulSpeed * (this._beaconSpeedScale || 1);
    this.velocity.lerp(toParent.multiplyScalar(haulSpeed), 0.05);
    this.position.addScaledVector(this.velocity, dt);

    // Note: captured debris uses InstancedMesh — its visual is handled by
    // DebrisField (and marked not-alive after capture). No mesh to move.

    this.tetherLength = this.position.distanceTo(parentPos) / M;

    const dockThreshold = this.config.bodyDims[2] * M * 8;
    if (dist < dockThreshold) {
      this._transitionTo(S.DOCKING);
      eventBus.emit(Events.ARM_RETURNED, {
        armId: this.id, captured: true, debrisId: this.capturedDebris?.id,
      });
    }
  }

  /**
   * Resolve the strut-tip dock world position into `out` (single source of
   * truth so every distance / heading / plume-clearance computation agrees on
   * the dock reference). Strict fallback: only rotate+offset when BOTH a parent
   * quaternion and a dockOffset are present; otherwise the dock is the mother
   * centre (`parentPos`). Matches the long-standing _updateReeling convention so
   * the FEEP gate and reel heading can never diverge from the reel target.
   * @param {THREE.Vector3} parentPos mother world position
   * @param {THREE.Quaternion} [parentQuat] mother world orientation
   * @param {THREE.Vector3} out destination vector (written in place)
   * @returns {THREE.Vector3} `out`
   * @private
   */
  _resolveStrutDockWorld(parentPos, parentQuat, out) {
    if (parentQuat && this.dockOffset) {
      out.copy(this.dockOffset).applyQuaternion(parentQuat).add(parentPos);
    } else {
      out.copy(parentPos);
    }
    return out;
  }

  /**
   * Combined retrieval-unit mass m_unit = m_daughter + m_net + m_debris (kg).
   * The single source of truth for V2 reel tension/throttle (plan Q2). Net mass
   * is small but folded in so Q3/Q4 share one consistent mass.
   * @param {number} armMass daughter dry mass (kg)
   * @param {boolean} hasPayload whether a catch is held
   * @returns {number} kg
   * @private
   */
  _computeReelMUnit(armMass, hasPayload) {
    let m = armMass;
    if (hasPayload && this.capturedDebris) m += (this.capturedDebris.mass || 0);
    // Net mass: only NET catches carry a net; magnetic/gripper/pad grips don't.
    if (hasPayload && (!this._captureToolKind || this._captureToolKind === 'NET')) {
      const nc = getNetClassForType(this.type);
      if (nc && typeof nc.MASS === 'number') m += nc.MASS;
    }
    return m;
  }

  /**
   * Trapezoidal reel-in speed (m/s, game-scale) at a given remaining distance.
   * Power-bounded cruise → ramps DOWN to V_DOCK within DECEL_DISTANCE_M.
   *
   * Cruise solves the implicit power throttle v = P / T_reel with
   * T_reel = m_unit·v·coeff ⇒ v_cruise = √(P / (m_unit·coeff)), clamped to
   * [V_DOCK, V_CRUISE_MAX]. Because the cruise is power-bounded the resulting
   * tension T = m_unit·v·coeff = P/v ≥ P/V_CRUISE_MAX stays under the tether
   * break strength for any in-spec catch (the snap invariant) — only Boost,
   * which multiplies the speed AFTER the throttle, can push past it.
   *
   * Boost is locked out inside DECEL_DISTANCE_M (BOOST_LOCKOUT_IN_DECEL) so the
   * player can't slam the dock and defeat the Q4 arrest.
   * @param {number} distMeters remaining distance to the strut dock (m)
   * @param {number} armMass daughter dry mass (kg)
   * @param {boolean} hasPayload whether a catch is held
   * @param {number} boostMult REEL_BOOST speed multiplier (1 when not boosting)
   * @returns {number} reel speed in m/s
   * @private
   */
  _computeReelProfileSpeed(distMeters, armMass, hasPayload, boostMult) {
    const P = Constants.REEL_PROFILE || {};
    const vDock = P.V_DOCK ?? 1.0;
    const decelDist = P.DECEL_DISTANCE_M ?? 15;
    const vCruise = this._reelCruiseCap(armMass, hasPayload);

    // Ramp DOWN to V_DOCK under a constant-deceleration (ACCEL) kinematic bound:
    // v = √(V_DOCK² + 2·ACCEL·dist), clamped to the cruise cap. This is the
    // decel half of the trapezoid — far from the dock the bound exceeds vCruise
    // (so we cruise), and it tapers continuously to V_DOCK at contact (no band
    // edge discontinuity). DECEL_DISTANCE_M is retained as the boost-lockout
    // window. (Accel ramp-UP from launch is implicit — the daughter starts at
    // rest at the GRAPPLED co-location and the per-frame move clamps to the
    // remaining distance.)
    const accel = P.ACCEL ?? 3.4;
    const vDecel = Math.sqrt(vDock * vDock + 2 * accel * Math.max(0, distMeters));
    let speed = Math.min(vCruise, vDecel);

    // Boost multiplies cruise only, and is locked out inside the decel band so
    // the dock can't be slammed (keeps Q4 arrest meaningful).
    const lockBoost = (P.BOOST_LOCKOUT_IN_DECEL !== false) && distMeters <= decelDist;
    if (boostMult > 1 && !lockBoost) speed *= boostMult;

    return speed;
  }

  /**
   * The cruise cap of the reel (m/s, game-scale): the power-bounded, snap-safe speed a unit of this mass may haul at,
   * floored at V_DOCK. Stateless; the legacy profile (`_computeReelProfileSpeed`) and the REEL_HOME physics
   * (`_rhReelStep`) both start from it.
   * @private
   */
  _reelCruiseCap(armMass, hasPayload) {
    const P = Constants.REEL_PROFILE || {};
    const vCruiseMax = P.V_CRUISE_MAX ?? 60;
    const vDock = P.V_DOCK ?? 1.0;
    const power = P.HAUL_MOTOR_POWER ?? 2500;
    const tMin = P.T_MIN ?? 5;
    const coeff = Constants.REEL_TENSION_COEFF ?? 0.04;
    const mUnit = this._computeReelMUnit(armMass, hasPayload);

    // Power-bounded cruise (closed form of v = P/(m·v·coeff)). The T_MIN floor
    // caps how fast a near-massless unit may go (keeps it ≤ V_CRUISE_MAX) and
    // the V_DOCK floor prevents a 0-speed stall for a very heavy catch.
    const vFromMin = power / Math.max(tMin, 1e-6);            // light-catch ceiling
    const vFromPower = Math.sqrt(power / Math.max(mUnit * coeff, 1e-6));
    let vCruise = Math.min(vCruiseMax, vFromMin, vFromPower);

    // SNAP INVARIANT (plan §Q1): cap cruise so the steady-reel tension
    // T = m_unit·v·coeff never exceeds break×CRUISE_TENSION_FRACTION. A heavy
    // in-spec catch is therefore throttled to a slower-but-safe cruise; only
    // Boost (applied AFTER this throttle) may push tension past break.
    const tensionFrac = P.CRUISE_TENSION_FRACTION ?? 0.85;
    const breakN = this.tetherBreakStrength || 0;
    if (breakN > 0) {
      const vTension = (breakN * tensionFrac) / Math.max(mUnit * coeff, 1e-6);
      vCruise = Math.min(vCruise, vTension);
    }
    return Math.max(vDock, vCruise);
  }

  // ==========================================================================
  // REEL-GAS (owner 2026-10-21): the reel-home haul as a sim. Pull-up, cruise, and a braking phase on her own cold-gas
  // jet, with her ion thruster keeping the line tight the whole way. Game-scale units in code (m/s per REAL s); true
  // units (x 1/10 speed, x 1/100 acceleration) only where mass, thrust and gas are involved (T0 confirmed the time base).
  // ==========================================================================

  /** @private Her full cold-gas bottle, kg (by type). */
  _coldGasBottleKg() {
    const B = Constants.DAUGHTER_COLD_GAS && Constants.DAUGHTER_COLD_GAS.BOTTLE_KG;
    return (B && B[this.config.type]) || 0;
  }

  /** @private Her cold-gas jet thrust, N. */
  _coldGasThrustN() {
    const T = Constants.DAUGHTER_COLD_GAS && Constants.DAUGHTER_COLD_GAS.THRUST_N;
    return (T && T[this.config.type]) || 0;
  }

  /** @private Her FEEP ion thrust, N (the thread that keeps the line tight). */
  _ionThrustN() {
    const IT = Constants.ION_THRUSTER || {};
    return (this.config.type === 'weaver' ? IT.WEAVER_MAX_THRUST : IT.SPINNER_MAX_THRUST) || 0;
  }

  /**
   * @private The FEEP the ion thread burns this frame, billed at its real thrust: the Δv it gives her (thrust / mass x
   * game seconds) against the tank's total Δv, as a percentage. Tiny (about 0.00002 % a frame) but billed, so a long
   * haul is not free. dt 0 (a held world) bills nothing.
   */
  _billIonThread(dt, massKg) {
    if (!(dt > 0) || !(this.fuel > 0)) return;
    const aTrue = this._ionThrustN() / Math.max(massKg, 1e-6);                       // m/s^2
    const dvTrue = aTrue * dt * TimeAuthority.BASE_SCALE;                             // m/s per game time of this frame
    const pct = dvTrue / (this.config.totalDeltaV || Constants.ARM_TOTAL_DELTAV) * 100;
    this.fuel = Math.max(0, this.fuel - pct);
  }

  /**
   * @private The reel-home speed for this frame (game-scale m/s) - REEL_HOME only; the legacy path never comes here.
   *
   *  a. PULL-UP: the reel speeds her up at REEL_PROFILE.PULL_ACCEL from `_rhReelV` (0 on entering REELING). No jump.
   *  b. CRUISE: at the cruise cap (`_reelCruiseCap`, boost included) or the speed her bottle can still pay to brake from
   *     (v_gas), whichever is lower.
   *  c. BRAKING: when the distance left equals her stopping distance at a_brake = min(ACCEL, jet accel / MARGIN), she slows
   *     at that rate to V_DOCK at the dock (no fixed 15 m: a long recall starts braking where the stopping distance needs
   *     it). Her cold-gas jet fires toward the mother the whole time and the gas is billed MARGIN x (it pushes MARGIN x what
   *     braking needs, the reel line holds the rest). The distance used is the one left AFTER this frame's step, so the
   *     last frame arrives at V_DOCK, not above it.
   *  No gas (bottle empty): no jet; the only brake is her ion thruster, so v <= sqrt(V_DOCK^2 + 2 a_ion d), about V_DOCK
   *  the whole way, and one line says so once per reel.
   * Sets `_rhBraking`, `_rhReelPhase`, `_rhTensionN` (true N, the line readout) and `_rhReelMassKg`. dt 0 changes nothing.
   * @param {number} dt real seconds
   * @param {number} distM metres left to the strut tip
   * @param {number} gateM metres she may still close this frame (the line-up gate; Infinity = none)
   * @returns {number} the speed to reel at this frame
   */
  _rhReelStep(dt, distM, gateM, armMass, hasPayload, boostMult) {
    const P = Constants.REEL_PROFILE || {};
    const G = Constants.DAUGHTER_COLD_GAS;
    const vDock = P.V_DOCK ?? 1.0;
    const BS = TimeAuthority.BASE_SCALE;
    const v0 = this._rhReelV;
    this._rhBraking = false;
    const gas = this.coldGasKg;
    const mass = this._computeReelMUnit(armMass + gas, hasPayload);       // her dry mass + the gas in the bottle + net + catch
    this._rhReelMassKg = mass;
    if (!(dt > 0)) return v0;                                              // a held world: speed, gas and bottle stay put
    const hasGas = gas > G.EMPTY_KG;
    if (!this._rhGasChecked) {
      this._rhGasChecked = true;
      if (!hasGas) {
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `Daughter ${this.index + 1} has no gas to brake; the reel brings her in slowly.`, priority: 'warning',
        });
      }
    }
    if (!(gateM > 1e-9)) {                                                 // the line-up hold (or tail-first turn): the reel is stopped
      this._rhReelV = 0;
      this._rhReelPhase = 'hold';
      this._rhTensionN = this._ionThrustN();
      return 0;
    }

    let vCap = this._reelCruiseCap(armMass, hasPayload);
    const lockBoost = (P.BOOST_LOCKOUT_IN_DECEL !== false) && distM <= (P.DECEL_DISTANCE_M ?? 15);
    if (boostMult > 1 && !lockBoost) vCap *= boostMult;
    const dEff = Math.max(0, Math.min(distM, gateM));
    // the speed from which a constant decel `a` just reaches V_DOCK after this frame's step (exact for the Euler step)
    const brakeTo = (a) => -a * dt + Math.sqrt(a * a * dt * dt + vDock * vDock + 2 * a * dEff);

    const aJet = this._coldGasThrustN() / mass * 100;                      // game-scale m/s^2 (true accel x 100)
    const aBrake = Math.min(P.ACCEL ?? 3.4, aJet / G.MARGIN);
    // F1 (review 2026-10-21): a little gas must never be slower than none. The jet speed (what the bottle can pay to brake
    // from, at the jet's a_brake) is only used where it beats the ion limit; the jet fires (puffs + gas bill) only while
    // she must brake harder than her ion thruster can - otherwise the ion thread is the brake. Empty bottle = ion limit.
    const aIon = this._ionThrustN() / mass * 100;
    const vIon = brakeTo(aIon);
    let vDes, aSlow, jet = false;
    if (hasGas) {
      // the highest speed whose braking to V_DOCK the bottle can still pay for: MARGIN x mass x dv_true / (Isp g0)
      const vGas = vDock + gas * G.ISP_S * 9.80665 * BS / (G.MARGIN * mass);
      const vJet = Math.min(vGas, brakeTo(aBrake));
      jet = vJet > vIon && vCap > vIon;
      vDes = Math.min(vCap, Math.max(vJet, vIon));
      aSlow = jet ? aJet : aIon;
    } else {
      vDes = Math.min(vCap, vIon);
      aSlow = aIon;
    }

    let v;
    if (vDes >= v0) v = Math.min(vDes, v0 + (P.PULL_ACCEL ?? 10) * dt);
    else v = Math.max(vDes, v0 - aSlow * dt);
    const dv = v - v0;

    let phase = 'cruise';
    if (dv > 1e-9) phase = 'pull';
    else if (dv < -1e-9 && jet) {
      phase = 'brake';
      this._rhBraking = true;
      // MARGIN x the gas braking needs: mass x speed lost (true m/s) / (Isp g0)
      const kg = Math.min(gas, G.MARGIN * mass * (-dv / BS) / (G.ISP_S * 9.80665));
      this.coldGasKg = gas - kg;
    }
    this._rhReelPhase = phase;
    // the line readout (true N): pull-up = mass x pull accel; cruise = the ion thread; braking = the (MARGIN - 1) the reel holds
    if (phase === 'pull') this._rhTensionN = mass * (P.PULL_ACCEL ?? 10) / 100;
    else if (phase === 'brake') this._rhTensionN = (G.MARGIN - 1) * mass * aBrake / 100;
    else this._rhTensionN = this._ionThrustN();
    this._rhReelV = v;
    return v;
  }

  /**
   * @private Mother's cold gas -> her bottle while she sits on her strut (DOCKED, HOLDING_CATCH, RELOADING): at
   * REFILL_KG_PER_GAME_S, until full; the mother loses exactly what she gains (ResourceSystem.drawUpTo). The mother
   * empty = no refill and one line (re-armed when she has gas again; shared by the four daughters).
   */
  _updateColdGasRefill(dt) {
    const st = this.state;
    if (!(dt > 0) || (st !== S.DOCKED && st !== S.HOLDING_CATCH && st !== S.RELOADING)) return;
    const G = Constants.DAUGHTER_COLD_GAS;
    const full = this._coldGasBottleKg();
    const need = full - this.coldGasKg;
    if (!(need > 1e-9)) return;
    const ps = this._playerSatellite;
    const rs = ps && ps._resourceSystem;
    if (!rs || typeof rs.drawUpTo !== 'function') return;
    const want = Math.min(need, G.REFILL_KG_PER_GAME_S * dt * TimeAuthority.BASE_SCALE);
    const got = rs.drawUpTo('coldGas', want);
    if (got > 0) {
      const next = this.coldGasKg + got;
      this.coldGasKg = (full - next < 1e-12) ? full : next;           // full is full (no 1e-17 kg left over by the float sum)
      ps._daughterGasEmptySaid = false;
    } else if (!ps._daughterGasEmptySaid) {
      ps._daughterGasEmptySaid = true;
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'The mother is out of cold gas; daughters cannot refill their braking gas.', priority: 'warning',
      });
    }
  }

  /**
   * @private One look-puff of her cold-gas jet (visual only): from the tail port (-Z, which faces the mother on the
   * tail-first reel), pointing out of it, from the shared 4-sprite pool. Fired every GAS_STREAM_INTERVAL_S of simulated time
   * while the jet brakes, so it reads as a steady stream, never a cloud.
   */
  _updateGasStream(dt) {
    if (!this._rhBraking || this.state !== S.REELING) { this._gasPuffAccum = DAUGHTER_PLUME.GAS_STREAM_INTERVAL_S; return; }   // the first puff of a braking spell is at once
    if (!this._attPuffs.length || !this._gasPuffPort || !(dt > 0)) return;
    this._gasPuffAccum += dt;
    if (this._gasPuffAccum < DAUGHTER_PLUME.GAS_STREAM_INTERVAL_S) return;
    this._gasPuffAccum = 0;
    this._gasPuffCount = (this._gasPuffCount || 0) + 1;
    const now = performance.now() * 0.001;
    const port = this._gasPuffPort;
    const puff = this._attPuffs[this._attPuffIndex];
    this._attPuffIndex = (this._attPuffIndex + 1) % this._attPuffs.length;
    puff.startPos.set(
      port.pos.x + (Math.random() - 0.5) * M * 0.004,
      port.pos.y + (Math.random() - 0.5) * M * 0.004,
      port.pos.z,
    );
    puff.dir.set(
      port.dir.x + (Math.random() - 0.5) * 0.12,
      port.dir.y + (Math.random() - 0.5) * 0.12,
      port.dir.z,
    ).normalize();
    puff.life     = 0.22 + Math.random() * 0.10;
    puff.maxScale = M * (0.07 + Math.random() * 0.04);
    puff.baseOp   = 0.34 + Math.random() * 0.10;
    puff.drift    = M * (0.35 + Math.random() * 0.15);       // a steady 35-50 cm jet
    puff.startTime = now;
    puff.sprite.position.copy(puff.startPos);
    puff.sprite.material.opacity = 0;
    puff.sprite.scale.set(M * 0.015, M * 0.015, M * 0.015);
    puff.sprite.visible = true;
    puff.active = true;
  }

  /**
   * @private A carry leg's ion thread (CARRY_OUT 'out' phase, CARRY_BACK): pick the nozzle whose exhaust points at her
   * strut tip (her -Z . direction to the tip > 0 = aft, else fore; a +-0.1 dead band keeps the last choice so a turn does
   * not strobe; the choice is kept over the hand-off beat and cleared with the next carry's clamp) and bills the thread at
   * its real thrust. Her mass is the carry's (her catches ride with her).
   */
  _carryThreadStep(dt, parentPos, parentQuat) {
    if (!(dt > 0)) return;
    if (this.dockOffset) {
      this._resolveStrutDockWorld(parentPos || this.position, parentQuat, _thrTip);
      const toTip = _thrDir.subVectors(_thrTip, this.position);
      const d = toTip.length();
      if (d > 1e-6 * M) {                                   // a micrometre: the direction to the tip is then sound (float noise is ~1e-9 m)
        toTip.multiplyScalar(1 / d);
        const dot = -_thrZ.set(0, 0, 1).applyQuaternion(this.group.quaternion).dot(toTip);       // her -Z . to the tip
        if (dot > 0.1) this._carryThread = 'aft';
        else if (dot < -0.1) this._carryThread = 'fore';
        else if (!this._carryThread) this._carryThread = dot >= 0 ? 'aft' : 'fore';
      }
    }
    if (!this._carryThread) this._carryThread = 'aft';
    this._billIonThread(dt, this.carryMassKg());
  }

  /**
   * REELING: V5 strut-reel motor reel-in. The motor on the mothership pulls the arm back; the haul itself burns no
   * propellant (legacy path: no FEEP at all). Under REEL_HOME (reel-gas, owner 2026-10-21) it is a sim: `_rhReelStep` pulls
   * her up, cruises, and brakes her on her cold-gas jet, while her ion thread (a tiny, billed FEEP cost) keeps the line tight.
   *
   * 2026-05-26 (Issue 1 fix): daughter docks at the end of the strut she
   * launched from, NOT mother's bus centre. Before this fix, _updateReeling
   * pulled the daughter to `parentPos` (mother core), then _updateDocking
   * lerped the last few metres over to the strut tip. The user saw the
   * daughter slide INTO the mother core then slide back out to the strut.
   * Now the reel target is the strut-tip dock world position (matches
   * _updateDocking) so the daughter approaches the correct dock from the
   * outset.
   * @private
   */
  _updateReeling(dt, parentPos, parentQuat) {
    const hasPayload = this.capturedDebris !== null;
    // reel-gas F3: the jet only fires on frames the REEL_HOME sim runs and says so (`_rhReelStep` sets it again); a frame
    // that takes another path (detached, flag turned off mid-reel) must not leave the last braking flag, and its puffs, on.
    this._rhBraking = false;

    // Catch-cleared-mid-reel guard (plan §Q3 edge): if a captured debris was
    // destroyed/removed elsewhere during the haul, don't strand the FSM holding
    // a stale "loaded" profile — convert to an empty return (mirrors the
    // HOLDING_CATCH→RELOADING fallback). Only meaningful when we previously had
    // a catch; a genuinely empty reel (reelFromStationKeep) leaves this null
    // from the start and is unaffected.
    if (Constants.isFeatureEnabled('REEL_PROFILE_V2')
        && this._reelHadPayload === true && !hasPayload && this.state === S.REELING) {
      this._reelHadPayload = false;
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: this.displayName,
        text: `${this.displayName}: Catch lost mid-reel. Returning empty.`,
        channel: 'CMD', priority: 'warning',
      });
    }
    if (hasPayload) this._reelHadPayload = true;

    // Phase 3a (capture-feedback overhaul): hold Shift → BOOST reel ×2.
    // Tension scales ∝ reelSpeed² (mult applied to both speed and the tension
    // formula below), so boosting a heavy catch walks the bar toward RIP/SNAP.
    const boostOn = Constants.isFeatureEnabled('REEL_BOOST')
      && this._boostReelHeld === true && hasPayload;
    if (boostOn && !this._boostReel) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: this.displayName,
        text: `${this.displayName}: Boost reel engaged. Watch the tension bar.`,
        channel: 'CMD', priority: 'info',
      });
    }
    this._boostReel = boostOn;
    const boostMult = boostOn ? ((Constants.REEL_BOOST && Constants.REEL_BOOST.SPEED_MULT) || 2) : 1;

    // Compute strut-tip dock world position: parentPos + parentQuat × dockOffset.
    // Falls back to parentPos (mother centre) if quaternion or dockOffset absent
    // (pre-Config-G compat / test harness with minimal mocks).
    const dockWorldPos = this._tmpDockTarget || (this._tmpDockTarget = new THREE.Vector3());
    this._resolveStrutDockWorld(parentPos, parentQuat, dockWorldPos);

    // Direction toward strut-tip dock (reuse pre-allocated _tmpVec)
    const toMother = this._tmpVec.subVectors(dockWorldPos, this.position);
    const dist = toMother.length();

    // ── Reel speed selection ──────────────────────────────────────────────
    // V2 (FEATURE_FLAGS.REEL_PROFILE_V2): trapezoidal velocity profile — fast
    // power-bounded cruise that ramps DOWN to a gentle dock speed within
    // DECEL_DISTANCE_M. Legacy path: constant REEL_IN_SPEED_* × boost.
    const profileV2 = Constants.isFeatureEnabled('REEL_PROFILE_V2');
    const armMass = this.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS;
    let reelSpeed;
    if (profileV2) {
      const distMeters = dist / M;
      reelSpeed = this._computeReelProfileSpeed(distMeters, armMass, hasPayload, boostMult);
    } else {      reelSpeed = (hasPayload ? REEL_IN_SPEED_LOADED : REEL_IN_SPEED_EMPTY) * boostMult;
    }
    let reelSpeedScaled = reelSpeed * M;

    // ── reel-home (Decisions 4, 7): wind only tail first, and never dock crooked ───────────────────────────────
    // `rhGate` limits how far she may close this frame (scene units): 0 while she turns round to tail-first
    // (her -Z within TAIL_FIRST_TOL of the strut tip), or up to the line-up distance while the line is more than
    // ALIGN_TOL off the strut axis; there the reel holds her while strut and mother line it up.
    const rh = this._rhHome && this._rhOn();
    let rhGate = Infinity;
    let rhLineHeld = false;
    if (rh) {
      const RH = Constants.REEL_HOME || {};
      const distM = dist / M;
      if (distM > 0.25 && dist > 1e-12) {
        _rhV1.set(0, 0, 1).applyQuaternion(this.group.quaternion);                  // her +Z, world
        const cosTail = -_rhV1.dot(toMother) / dist;                                // her -Z . unit(her -> tip)
        if (cosTail < Math.cos((RH.TAIL_FIRST_TOL_DEG ?? 10) * Math.PI / 180)) rhGate = 0;
      }
      if (distM >= 0.5 && dist > 1e-12) {
        this._rhStrutDirWorldInto(parentQuat, _rhV2);
        const cosLine = -_rhV2.dot(toMother) / dist;                                // unit(tip -> her) . strut axis
        if (cosLine < Math.cos((RH.ALIGN_TOL_DEG ?? 10) * Math.PI / 180)) {
          const lim = Math.max(0, dist - (RH.ALIGN_DIST_M ?? 2.0) * M);
          if (lim <= 0.002 * M) rhLineHeld = true;                                    // held: within 2 mm of the line-up distance
          rhGate = Math.min(rhGate, lim);
        }
      }
      // the clock of the hold: the mother gets ALIGN_WAIT_S to line her up, then she uses her own thrusters
      this._rhHoldS = rhLineHeld ? this._rhHoldS + dt : 0;
      // fix round F2d: a blocked path or an empty tank is looked at again every second (the geometry changes), never for good
      if (this._rhNoPath) {
        this._rhNoPathS += dt;
        if (this._rhNoPathS >= 1) { this._rhNoPath = false; this._rhNoPathS = 0; }
      }
      if (rhLineHeld && !this._rhLineUp && !this._rhNoPath && !this._rhMotherWorking
          && this._rhHoldS >= (RH.ALIGN_WAIT_S ?? 5)) {
        // only if the line is also off the axis the strut is HEADING for: a strut still slewing will catch up on its own
        this._rhTargetDirWorldInto(parentQuat, _rhV2);
        const cosTarget = -_rhV2.dot(toMother) / dist;
        if (cosTarget < Math.cos((RH.ALIGN_TOL_DEG ?? 10) * Math.PI / 180)
            && !this._rhBeginLineUp(dockWorldPos, dist, parentPos, parentQuat)) {
          this._rhNoPath = true;                                                   // she holds for the mother, and asks again in a second
          this._rhNoPathS = 0;
        }
      }
      if (this._rhLineUp) {                                                        // runs on to well inside the tolerance (no flutter at its edge)
        rhGate = 0;
        this._rhLineUpStep(dt, dockWorldPos, parentPos, parentQuat);
      }
      // reel-gas (owner 2026-10-21): under REEL_HOME the haul is a sim - pull-up, cruise, a braking phase on her cold-gas
      // jet - not the stateless trapezoid above. `_rhReelStep` owns the speed (and the gas, and the line readout).
      if (profileV2) {
        reelSpeed = this._rhReelStep(dt, dist / M, rhGate / M, armMass, hasPayload, boostMult);
        reelSpeedScaled = reelSpeed * M;
        // her ion thread keeps the line tight the whole haul: billed at its real thrust (not while the line-up burn runs)
        if (!this._rhLineUp) this._billIonThread(dt, this._rhReelMassKg);
      }
      if (rhGate === 0 && dt > 0) { reelSpeed = 0; reelSpeedScaled = 0; }
    }

    // ── FEEP soft re-dock arrest (REEL_PROFILE_V2, plan Q4) ────────────────
    // Within ARREST_DISTANCE_M the daughter fires FEEP to null the residual
    // closing-rate for a soft contact. Implemented as a ONE-SHOT mass-scaled
    // fuel debit (fuel% = DEBIT_K · m_unit · v_arrest) the first frame inside
    // the window — the existing reel ramp already carries the closing-rate down
    // to ~V_DOCK, so the debit prices the FEEP burn rather than re-simulating
    // momentum. Gated on tether-plume clearance (yoke) and fuel; either failing
    // → FUEL_FALLBACK_SLOW (zero-fuel reel-only finish + warn, never a dead-end).
    // Mission-1 is free (the learning loop). DOCKING's per-state fuel rate is
    // suppressed for this cycle (see _consumeFuel) so the arrest is charged once.
    // reel-home: the old one-shot arrest burn is not used (her aft end leads; reel-gas 2026-10-21: the jet BRAKES her in
    // `_rhReelStep`, billed in gas as it fires, and her aft ion thread keeps the line tight): nothing to price here and no
    // plume to keep off the line, so no arrest steer either (Decision 4, reel-home).
    if (profileV2 && hasPayload && !this._redockArrestStarted && !this.isDetached && !rh) {
      const RF = Constants.REDOCK_FEEP || {};
      const arrestDist = RF.ARREST_DISTANCE_M ?? 8;
      const distMeters = dist / M;
      if (distMeters <= arrestDist) {
        this._redockArrestStarted = true;
        this._redockDebitApplied = false;   // suppress DOCKING fuel rate this cycle
        const vArrest = Math.max(reelSpeed, RF.SOFT_DOCK_VEL ?? 0.10);
        const mUnit = this._computeReelMUnit(armMass, true);
        eventBus.emit(Events.REDOCK_ARREST_START, {
          armIndex: this.index, mUnit, vArrest,
        });

        const perMission = Constants.MISSIONS?.DEBRIS_PER_MISSION || 5;
        const missionNumber = Math.floor((gameState.debrisCleared || 0) / perMission) + 1;
        const mission1Free = (RF.MISSION1_FREE !== false) && missionNumber === 1;
        // Wave2 arrest-gate reconciliation: decomposed clearance verdict (real
        // bridle anchor + commanded electrostatic steer against the 20°+2°
        // steered-axis requirement — full derivation on _tetherPlumeClearance).
        // The arrest-window attitude offset that makes production dock-ahead
        // geometry pass is owned by the REELING branch in update(); by entry
        // it is converged (ARREST_STEER_LEAD_M), so this gate reads the honest
        // burn-start nose.
        const plumeVerdict = this._tetherPlumeClearance(parentPos, parentQuat);
        const plumeClear = plumeVerdict.clear;

        if (mission1Free) {
          this._redockDebitApplied = true;   // free pass still suppresses the DOCKING rate
        } else {
          // Steer-assist pricing: when the clear verdict needed commanded steer
          // (steerNeededDeg > 0), the burn runs on the ARREST_STEER_DEG offset
          // plan — thrust component along travel scales as cos(offset), so the
          // same Δv costs 1/cos(15°) ≈ ×1.035 propellant (the audit's ~3.5%).
          // Unassisted geometry (≥ MIN_TETHER_PLUME_DEG, e.g. dock abeam) pays
          // exactly the legacy debit. Priced flat on the committed offset, not
          // per-degree — one constant, one plan.
          const YC = Constants.YOKE_CLEARANCE || {};
          const steerLoss = plumeVerdict.steerNeededDeg > 0
            ? 1 / Math.cos((YC.ARREST_STEER_DEG ?? 15) * Math.PI / 180)
            : 1;
          const debit = (RF.DEBIT_K ?? 0.0008) * mUnit * vArrest * steerLoss;
          if (plumeClear && this.fuel >= debit) {
            this.fuel -= debit;
            this._redockDebitApplied = true;
          } else if (RF.FUEL_FALLBACK_SLOW !== false) {
            // Can't fund the burn OR the tether crosses the FEEP plume cone:
            // finish on the reel motor alone (slower, zero-fuel) and warn.
            if (!this._redockFuelLowWarned) {
              this._redockFuelLowWarned = true;
              eventBus.emit(Events.REDOCK_FUEL_LOW, {
                armIndex: this.index, fuel: this.fuel, needed: debit,
              });
              eventBus.emit(Events.COMMS_MESSAGE, {
                source: this.displayName,
                text: plumeClear
                  ? `${this.displayName}: Low FEEP for arrest. Easing in on the winch.`
                  : `${this.displayName}: Tether fouls the FEEP plume. Easing in on the winch.`,
                channel: 'CMD', priority: 'warning',
              });
            }
          }
        }
      }
    }


    // value as metres, but `dist` is in SCENE UNITS (1 unit = 100 km).  0.001
    // scene units = 100 m — so the entire reel-step branch was silently skipped
    // whenever REELING started inside ~100 m of the mother (e.g. a clean 35 m
    // capture).  The daughter was glued at her starting gap by the parent-frame
    // correction in update() and never docked.
    // Correct guard: 1 mm in scene units (M = 1 m → 0.00001 scene units) — purely
    // to avoid normalize() on a zero-length vector.  Real docking is decided by
    // the `moveDistance >= dist` branch below.
    //
    // 2026-08-27 (REEL_PROFILE_V2 flip audit): the dock decision is hoisted
    // OUT of that normalize guard — exactly what the paragraph above already
    // promised. Nested inside `dist > 1e-7`, a frame that stepped from just
    // above the guard to just below it (dist_after ∈ (0, 1 cm), possible
    // whenever the per-frame step lands in that window) left the arm parked
    // <1 cm from the dock with the whole branch skipped forever — a phase-
    // dependent permanent REELING stall on BOTH reel paths (probe-verified:
    // legacy empty 206 m haul stalls at 4 mm; V2's gentle V_DOCK=1 m/s
    // approach steps 16.7 mm/frame past a 10 mm window, stalling most hauls).
    // The dock check needs no normalize (position.copy of the resolved dock),
    // so only the move branch keeps the zero-length guard. Speeds, tension,
    // and the legacy constant-speed model are untouched.
    let moveDistance = reelSpeedScaled * dt;
    if (rh && rhGate < moveDistance) {
      moveDistance = rhGate;
      // reel-gas: the line-up gate stopped her short of the step: her speed is what she really covered
      if (profileV2 && dt > 0) this._rhReelV = Math.min(this._rhReelV, moveDistance / (M * dt));
    }
    if (moveDistance >= dist) {
      // Close enough to dock — snap to the strut-tip dock (not mother core).
      this.position.copy(dockWorldPos);
      this._transitionTo(S.DOCKING);
      eventBus.emit(Events.ARM_RETURNED, {
        armId: this.id, captured: hasPayload, debrisId: this.capturedDebris?.id,
      });
    } else if (dist > 1e-7) {
      toMother.normalize();
      // Move toward mothership at reel speed
      this.position.addScaledVector(toMother, moveDistance);
    }

    // Authoritative: drag the captured debris with us every frame so it can
    // never be left behind on its orbit while we reel home.
    // reel-home: a catch the net reel brought in sits in its cell on her, fixed in her frame (Decision 8).
    if (!(rh && this._rhArrived && this._rhPinInCell())) this._pinCatchToSelf(parentPos);

    // Update tether length
    this.tetherLength = dist / M;

    // Calculate tension (simplified: F = m × a_reel).  Coefficient tuned
    // (Constants.REEL_TENSION_COEFF) so an in-spec catch reels home under the
    // default tether break strength — only genuine overload snaps the cable.
    // Phase 3a: the boosted reelSpeed doubles the tension target; while
    // boosting, tension EASES toward the target (TENSION_EASE_TAU_S) so the
    // bar visibly climbs into the red and the player can release Shift before
    // the snap. Nominal reel keeps the legacy direct assignment exactly —
    // cautious play is never punished.
    // V2 (Q2): tension keys off the combined unit mass m_unit = daughter + net +
    // debris (single source of truth). The cruise throttle (see
    // _computeReelProfileSpeed) is power-bounded so an in-spec catch stays under
    // break strength at full cruise — only Boost may push past it.
    const payloadMass = hasPayload && this.capturedDebris ? (this.capturedDebris.mass || 0) : 0;
    const tensionMass = profileV2 ? this._computeReelMUnit(armMass, hasPayload) : (armMass + payloadMass);
    const tensionCoeff = Constants.REEL_TENSION_COEFF ?? 0.04;
    let tensionTarget = tensionMass * reelSpeed * tensionCoeff;
    // reel-gas Decision 8: under REEL_HOME the line carries what the physics asks of it (true N): the pull-up, the ion
    // thread at cruise, the (MARGIN - 1) the reel holds while the jet brakes. Snap / rip thresholds are unchanged.
    if (rh && profileV2) tensionTarget = this._rhTensionN;
    if (boostOn) {
      const tau = (Constants.REEL_BOOST && Constants.REEL_BOOST.TENSION_EASE_TAU_S) || 0.4;
      this.tetherTension += (tensionTarget - this.tetherTension) * Math.min(1, dt / tau);
    } else {
      this.tetherTension = tensionTarget;
    }

    // w4-power D5 (owner 2026-10-12: "8 motors on strut cost energy and
    // thermals"): the strut reel cartridge — this daughter's tether reel, on
    // the mother's strut — bills the mother's battery the real mechanical
    // power, line tension × line speed ÷ REEL_EFFICIENCY, floored at its own
    // 15 W motor while turning and capped at HAUL_MOTOR_POWER. dt 0 (a held
    // world: ArmManager ticks arms with 0) bills nothing.
    if (dt > 0 && moveDistance > 0 && !this.isDetached) {
      const MD = Constants.MOTOR_DRAW_W || {};
      const rs = this._playerSatellite && this._playerSatellite._resourceSystem;
      if (rs && typeof rs.billWatts === 'function') {
        // reel-gas F2: under REEL_HOME the tension is true newtons, so the line speed must be TRUE m/s too (the reel speed
        // is game-scale: / TimeAuthority.BASE_SCALE). The legacy path keeps its game-scale pairing (old coefficient).
        const lineSpeed = (rh && profileV2) ? reelSpeed / TimeAuthority.BASE_SCALE : reelSpeed;
        const mechW = Math.max(0, this.tetherTension) * lineSpeed / (MD.REEL_EFFICIENCY || 0.5);
        rs.billWatts(Math.min(MD.REEL_MAX ?? 2500, Math.max(MD.STRUT_REEL_MIN ?? 15, mechW)), dt);
      }
    }

    // Phase 3a: boosting a catch deep in the strain band can RIP the net —
    // recoverable (debris drifts free, daughter returns), same consequence
    // path as the reel-start strain slip. Rolled per second while boosting.
    if (boostOn && this.state === S.REELING
        && (!this._captureToolKind || this._captureToolKind === 'NET')
        && payloadMass > 0 && (this._netRatedMass || 0) > 0) {
      const strain = payloadMass / this._netRatedMass;
      // The band ramp routes through the ONE strain-band helper (register item
      // 88); the CAP stays here — a PER-SECOND roll vs RIP_PROB_PER_S, dt-scaled.
      const t = strainBandT(payloadMass, this._netRatedMass);
      if (t > 0) {
        const pPerS = (Constants.REEL_BOOST && Constants.REEL_BOOST.RIP_PROB_PER_S) ?? 0.10;
        const roll = (this._boostRipRollOverride != null) ? this._boostRipRollOverride : Math.random();
        if (roll < pPerS * t * dt) {
          this._ripNetDuringBoost(strain);
          return;
        }
      }
    }

    // Emit tension update
    eventBus.emit(Events.TETHER_TENSION_UPDATE, {
      armIndex: this.index,
      tension: this.tetherTension,
      fraction: this.tetherTension / this.tetherBreakStrength,
    });

    // Check for tether snap — catastrophic cut from the mother (see _snapTether).
    // Guard on REELING: the reel-step above may have already docked the catch
    // this frame (transitioned to DOCKING), in which case it's delivered, not lost.
    // Item 5d (2026-06-12): during MISSION 1 (the learning mission) the snap is
    // clamped to a warning — a catastrophic EXPENDED daughter dead-ends the
    // beginner loop before the player has learned the recovery verbs.
    if (this.state === S.REELING && this.tetherTension > this.tetherBreakStrength) {
      const perMission = Constants.MISSIONS?.DEBRIS_PER_MISSION || 5;
      const missionNumber = Math.floor((gameState.debrisCleared || 0) / perMission) + 1;
      if (missionNumber === 1) {
        this.tetherTension = this.tetherBreakStrength;   // clamp at the limit
        if (!this._m1SnapWarned) {
          this._m1SnapWarned = true;
          eventBus.emit(Events.COMMS_MESSAGE, {
            source: this.displayName,
            text: `${this.displayName}: Tether at rated limit. Winch absorbing the overload. ` +
              `Heavier catches will SNAP the cable once you're past training.`,
            channel: 'CMD', priority: 'warning',
          });
        }
      } else {
        this._snapTether(parentPos);
        return;
      }
    }

    // Wave1 tension feedback — daughter reel creak.
    //
    // ONE OWNER DECISION: the creak is emitted HERE (ArmUnit, on the ONE event
    // the mother lasso already owns: Events.TETHER_TENSION, { tensionFraction,
    // armId }) rather than teaching AudioSystem to listen to
    // TETHER_TENSION_UPDATE. Reasons: (1) soundVocabulary.js pins ONE canonical
    // trigger per sound family — `playTetherTension ← TETHER_TENSION` — so a
    // daughter-side UPDATE listener would fork the creak's trigger vocabulary;
    // (2) TETHER_TENSION_UPDATE fires EVERY reel frame regardless of strain —
    // gating + rate-limiting it inside AudioSystem would duplicate per-arm
    // bookkeeping the emitter can do once at the source; (3) AudioSystem's
    // existing per-armId cooldown (_tetherTensionTimers) then covers both
    // speakers (lasso + daughter) through the ONE chokepoint, and the mother
    // lasso audio path stays untouched.
    //
    // Silent below the strain-safe fraction (REEL_TENSION_WARNING — the old
    // flag-gated path's 0.7 gate and the HUD bar's yellow tier), rate-limited
    // at the source to ≤1 emit per TETHER_CREAK_MIN_INTERVAL_S (hard floor
    // ~1.5 s; AudioSystem's 3 s per-armId cooldown may thin it further). The
    // payload's live fraction scales playTetherTension's creak volume. The
    // guard runs AFTER the snap check above so a snapping/docking frame can't
    // squeak.
    this._tetherCreakCooldown = Math.max(0, this._tetherCreakCooldown - dt);
    if (this.state === S.REELING
        && this.tetherTension > this.tetherBreakStrength * (REEL_TENSION_WARNING ?? 0.7)
        && this._tetherCreakCooldown <= 0) {
      this._tetherCreakCooldown = Constants.TETHER_CREAK_MIN_INTERVAL_S ?? 1.5;
      eventBus.emit(Events.TETHER_TENSION, {
        tensionFraction: this.tetherTension / this.tetherBreakStrength,
        armId: this.id,
      });
    }

    // NO fuel consumption! This is the key V5 benefit.
    // Power draw from reel motor only (handled by PowerDistribution)

    // Emit reel state
    this.reeling = true;
    // V2: tag the current reel phase + closing-rate so the HUD can render
    // HAUL / RAMP / ARREST and a closing-rate readout ("docking hot" legibility).
    // `speed` already carries the live closing-rate (= reel speed; REELING moves
    // position directly so the reel speed IS the closing-rate).
    let reelPhase = null;
    if (profileV2) {
      const arrestDist = (Constants.REDOCK_FEEP && Constants.REDOCK_FEEP.ARREST_DISTANCE_M) ?? 8;
      const decelDist = (Constants.REEL_PROFILE && Constants.REEL_PROFILE.DECEL_DISTANCE_M) ?? 15;
      const distM = dist / M;
      reelPhase = distM <= arrestDist ? 'ARREST' : (distM <= decelDist ? 'RAMP' : 'HAUL');
    }
    eventBus.emit(Events.TETHER_REEL_STATE, {
      armIndex: this.index,
      reeling: true,
      speed: reelSpeed,
      phase: reelPhase,
      closingRate: reelSpeed,
    });
  }

  /**
   * RETURNING: return to parent without debris.
   *
   * 2026-06-12 (re-dock fix, Issue 8): like REELING (Issue 1 fix 2026-05-26),
   * empty-handed returns target the STRUT-TIP dock world position, NOT the
   * mother bus centre. Targeting `parentPos` flew the daughter into/behind the
   * hull (she "vanished" occluded for ~2 s while DOCKING lerped her back out),
   * and the strut-tip-anchored tether drew inward through the ship — reading
   * as a tether pointing 180° the wrong way.
   */
  _updateReturning(dt, parentPos, parentQuat) {
    // Detached arms can't return — switch to free-flying transit
    if (this.isDetached) {
      this._transitionTo(S.TRANSIT);
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Cannot return. Tether severed. Free-flying.`,
        priority: 'warning',
      });
      return;
    }

    // Strut-tip dock world position: parentPos + parentQuat × dockOffset.
    // Falls back to parentPos if quaternion or dockOffset absent (test mocks).
    const dockWorldPos = this._tmpDockTarget || (this._tmpDockTarget = new THREE.Vector3());
    this._resolveStrutDockWorld(parentPos, parentQuat, dockWorldPos);

    const toParent = this._tmpVec.subVectors(dockWorldPos, this.position);
    const dist = toParent.length();

    toParent.normalize();
    const returnSpeed = this.config.approachSpeed * (this._beaconSpeedScale || 1);
    this.velocity.lerp(toParent.multiplyScalar(returnSpeed), 0.08);
    this.position.addScaledVector(this.velocity, dt);

    this.tetherLength = this.position.distanceTo(parentPos) / M;

    const dockThreshold = this.config.bodyDims[2] * M * 8;
    if (dist < dockThreshold) {
      this._transitionTo(S.DOCKING);
      eventBus.emit(Events.ARM_RETURNED, {
        armId: this.id, captured: false,
      });
    }
  }

  /** DOCKING: final alignment to dock offset (3s) */
  _updateDocking(dt, parentPos, parentQuat) {
    const dockWorldPos = _dockOffTmp.copy(this.dockOffset);
    if (parentQuat) dockWorldPos.applyQuaternion(parentQuat);
    dockWorldPos.add(parentPos);

    this.position.lerp(dockWorldPos, 0.05);

    // Keep the catch glued to us through the final dock approach too.
    if (!(this._rhArrived && this._rhPinInCell())) this._pinCatchToSelf(parentPos);

    if (this.stateTimer > Constants.ARM_DOCK_DURATION) {
      this.reeling = false;
      this.tetherTension = 0;

      // PARK-THE-CATCH (2026-06-06): a captured debris is NOT processed/removed
      // at the mother any more. The mother's furnace can't ingest a whole catch
      // yet (furnace-transfer + breakdown are unsolved/deferred), so the daughter
      // parks at her strut tip still holding the debris cinched in the net, full
      // size, indefinitely. She is now OCCUPIED — she does NOT reload her spring
      // and stays out of the deploy pool (HOLDING_CATCH is not DOCKED), leaving
      // the other daughters free to capture more. Keep `_capturedByArm` and
      // `_armPinned` set so the held net stays cinched (CaptureNet's held-net
      // release keys off `_capturedByArm`) and the debris stays pinned to the
      // strut. DEBRIS_CAPTURED is still emitted (capture-secured signal — drives
      // the first_capture teaching beat). Salvage/scoring and field removal now
      // fire on CATCH_PROCESSED (emitted by _updateHoldingCatch once the
      // furnace-transfer window elapses), NOT on dock arrival — see GameFlowManager.
      if (this.capturedDebris) {
        this.captures++;
        // S6: the parked hold is a cargo RACK (heldCatches). Read the debris
        // into a local BEFORE clearing the scalar — the DEBRIS_CAPTURED emit
        // below names its id (clearing first would break the first_capture
        // teaching signal). She hauled exactly one piece and a holding
        // daughter is not redeployable, so the rack is empty here and the
        // capacity guard cannot trip — it is the S7 transfer's refusal seam.
        const debris = this.capturedDebris;
        if (this._stowHeldCatch(debris, parentQuat)) {
          this.capturedDebris = null;
          // rack-snug (Decisions 1, 4, 5): the stow assigned the cell and froze the catch's attitude in HER frame
          // from its attitude NOW (no jump); the pin below starts the glide from the in-hand point (no
          // one-frame jump of the bag when the park state begins) and the piece turns with her from here on.
          this._pinHeldCatches(parentPos, parentQuat);
          this._breakdownStarted = false;     // reset staged-furnace bookkeeping (Item 1)
          this._breakdownChunksFired = 0;
          this._transitionTo(S.HOLDING_CATCH);
          eventBus.emit(Events.DEBRIS_CAPTURED, {
            debrisId: debris.id,
            armId: this.id,
            type: this.type,
            parked: true,                     // held at strut, not removed/processed
          });
          // no-melt: the daughter's own catch pays HERE, when it is parked on her rack, whatever the furnace flag
          // (mother catches pay at the collar mate). { parked: true } keeps the body; source 'rack' tells the
          // mission-start hold, the "at the nose" line and the net-park teaching beat that this is not a nose park.
          // GameFlowManager's per-body ledger (`_credited`) makes a later cook-end event pay nothing more.
          eventBus.emit(Events.CATCH_PROCESSED, {
            armId: this.id, debrisId: debris.id, type: this.type, parked: true, source: 'rack',
          });
          eventBus.emit(Events.COMMS_MESSAGE, {
            text: Constants.isFeatureEnabled('FURNACE_COOK')
              ? `${this.displayName}: Catch secured at the strut. Holding in net (awaiting processing). Capture #${this.captures}.`
              : `${this.displayName}: Catch secured at the strut. Holding it in the net until the burn to the next field, when she carries it to a furnace. Capture #${this.captures}.`,
            priority: 'success',
          });
          return;
        }
        // Full rack (unreachable on the haul path): the push REFUSED, the catch
        // stays in hand — cargo is never destroyed — and she falls through to
        // the legacy reload below.
      }

      // Empty return (e.g., a recoverable net failure sent her home without a
      // catch): the legacy reload path still applies.
      this.target = null;
      this._manualCapture = false;        // reset manual capture flag on re-dock
      this._nearbyDebris = [];

      // V5: After docking, reload the crossbow spring
      this._transitionTo(S.RELOADING);
      this.reloadProgress = 0;
      this.reloadDuration = 0; // Will be calculated in RELOADING state
      eventBus.emit(Events.CROSSBOW_RELOAD_START, {
        armIndex: this.index,
        duration: this.reloadDuration,
      });
    }
  }

  /**
   * HOLDING_CATCH: daughter is docked at her strut tip carrying a captured
   * debris cinched in the net, running the staged FURNACE_TRANSFER timeline
   * below (hold → chop → feed → `CATCH_PROCESSED` → RELOADING). She holds
   * position like DOCKED but is intentionally NOT charged and NOT in the DOCKED
   * state, so `ArmManager._findDockedArm()` skips her and the other daughters
   * remain available. The captured debris is re-pinned to the strut tip every
   * frame (full size) so it never drifts or vanishes. `recall()` REFUSES this
   * state (she is already home, and reeling would dump the cargo) — the timeline
   * here is the only thing that clears her.
   * @private
   */
  _updateHoldingCatch(dt, parentPos, parentQuat) {
    // Clamp the daughter to her strut-tip dock (mirrors _updateDocked).
    this._lastParentQuat = parentQuat
      ? (this._lastParentQuatV || (this._lastParentQuatV = new THREE.Quaternion())).copy(parentQuat)
      : null;
    if (parentPos) {
      const offset = _dockOffTmp.copy(this.dockOffset);
      if (parentQuat) offset.applyQuaternion(parentQuat);
      this.position.copy(parentPos).add(offset);
    }
    this.tetherLine.visible = false;
    this.velocity.set(0, 0, 0);

    // If the rack was cleared elsewhere, fall back to reload immediately.
    if (this.heldCatches.length === 0) {
      this._transitionTo(S.RELOADING);
      this.reloadProgress = 0;
      this.reloadDuration = 0;
      eventBus.emit(Events.CROSSBOW_RELOAD_START, {
        armIndex: this.index,
        duration: this.reloadDuration,
      });
      return;
    }

    // no-melt (owner 2026-10-18, "Stay full size, no melting"): with no furnace there is no cook clock. She keeps the
    // catch pinned to her rack, full size, until the station takes it at the resupply stop (ArmManager.unloadHeldCatches
    // clears the rack; the empty-rack fallback above then reloads her). The staged breakdown below is kept for the
    // day a real furnace exists (FEATURE_FLAGS.FURNACE_COOK).
    if (!Constants.isFeatureEnabled('FURNACE_COOK')) {
      this._pinHeldCatches(parentPos, parentQuat);
      return;
    }

    // ── Staged furnace breakdown (Item 1) ────────────────────────────────────
    // Three phases off stateTimer (cumulative seconds from HOLDING_CATCH entry):
    //   hold [0, HOLD_S)        — catch full-size, cinched in the net (_capturedByArm
    //                             set so CaptureNet keeps the held net wrapped).
    //   chop [HOLD_S, CHOP_S)   — emit CATCH_BREAKDOWN_START once; release the net's
    //                             hold (_capturedByArm = null) so the bag visual can
    //                             follow the chop; mark debris._breakdownActive so the
    //                             furnace visual owns its scale/disposal.
    //   feed [CHOP_S, FEED_S)   — emit CHUNK_COUNT evenly-spaced CATCH_BREAKDOWN_CHUNK
    //                             events as chunks stream to the mother's furnace.
    //   at FEED_S               — emit the single CATCH_PROCESSED (unchanged payload /
    //                             single-fire contract — GameFlowManager + bosses) and
    //                             reload. Gameplay timing only MOVES to feed-end.
    // Phase boundaries come straight from the single authoritative constant —
    // no per-site fallback literals (they drifted-by-design risk vs ArmManager's
    // chop-window scale ramp, which reads the same keys).
    const FT = Constants.FURNACE_TRANSFER;
    const HOLD_S = FT.HOLD_S;
    const CHOP_S = FT.CHOP_S;
    const FEED_S = FT.FEED_S;
    const CHUNK_COUNT = FT.CHUNK_COUNT;
    // S6: the timeline digests the OLDEST piece on the rack first; the rest
    // wait parked at their slots.
    const debris = this.heldCatches[0];
    // S8: the timeline is a pure function of this piece's digestion progress,
    // not the HOLDING_CATCH stateTimer. Progress accrues on the transit clock
    // (dt × TIME_SCALE_GAMEPLAY — full rate while flying, a 0.1× crawl in
    // menu/shop backgrounds because the world itself ticks at 0.1× there),
    // scaled by the sun gate ArmManager writes each frame (_digestSunScale:
    // 1.0 in sunlight, ECLIPSE_RATE in eclipse; ?? 1.0 keeps legacy mocks
    // byte-identical). The span is mass-scaled (register item 40, owner
    // ruling 2026-08-13): clamp(mass × S_PER_KG, MIN_S, MAX_S) — energy ∝
    // mass at fixed concentrator power. Mapping progress onto [0, FEED_S]
    // keeps the hold/chop/feed fractions and the chunk cadence identical;
    // only the wall-clock pace changes.
    const span = FT.digestSpanS(debris.mass);   // item 48: the ONE span-law home
    const sunScale = this._digestSunScale ?? 1.0;
    debris._digestProgress = (debris._digestProgress || 0) +
      dt * TimeAuthority.BASE_SCALE * sunScale;
    const t = Math.min(FEED_S, (debris._digestProgress / span) * FEED_S);
    // ArmManager's chop scale-ramp reads this derived phase time (it read
    // stateTimer pre-S8) — one computation, one home.
    this._digestPhaseT = t;

    // Lazy-init the per-park breakdown bookkeeping (also reset on entry in
    // _updateDocking). Safe if a test sets HOLDING_CATCH directly.
    if (this._breakdownStarted === undefined) this._breakdownStarted = false;
    if (this._breakdownChunksFired === undefined) this._breakdownChunksFired = 0;

    if (t < HOLD_S) {
      // hold: catch welded full-size, net still cinched. Lateral bias keeps the
      // bag off the camera→daughter axis so the parked daughter stays visible.
      this._pinHeldCatches(parentPos, parentQuat);
      return;
    }

    // Fire the chop-start exactly once when we cross into the chop phase.
    if (!this._breakdownStarted) {
      this._breakdownStarted = true;
      debris._breakdownActive = true;          // furnace visual owns scale/disposal
      debris._capturedByArm = null;            // release the held-net cinch
      eventBus.emit(Events.CATCH_BREAKDOWN_START, {
        armId: this.id, debrisId: debris.id, chunkCount: CHUNK_COUNT,
      });
      // Player-facing comms for the breakdown is owned by GameFlowManager's
      // CATCH_BREAKDOWN_START handler (single narrative owner) — no comms here.
    }

    // Keep the (now-breaking-down) catch pinned to the strut so it never drifts
    // while the furnace visual animates the chop. The visual owns the scale ramp.
    // Same lateral bias as the hold phase so the daughter stays clear of the bag.
    this._pinHeldCatches(parentPos, parentQuat);

    // feed: emit chunk events evenly across [CHOP_S, FEED_S).
    if (t >= CHOP_S && t < FEED_S) {
      const feedSpan = Math.max(1e-6, FEED_S - CHOP_S);
      const feedFrac = (t - CHOP_S) / feedSpan;             // 0 → 1 across feed
      const due = Math.min(CHUNK_COUNT, Math.floor(feedFrac * CHUNK_COUNT) + 1);
      while (this._breakdownChunksFired < due) {
        const index = this._breakdownChunksFired;            // 0-based
        eventBus.emit(Events.CATCH_BREAKDOWN_CHUNK, {
          armId: this.id, debrisId: debris.id, index, total: CHUNK_COUNT,
        });
        this._breakdownChunksFired++;
      }
      return;
    }

    if (t >= FEED_S) {
      // Flush any chunk events not yet emitted (e.g. a long frame skipped some).
      while (this._breakdownChunksFired < CHUNK_COUNT) {
        eventBus.emit(Events.CATCH_BREAKDOWN_CHUNK, {
          armId: this.id, debrisId: debris.id,
          index: this._breakdownChunksFired, total: CHUNK_COUNT,
        });
        this._breakdownChunksFired++;
      }

      // ── Furnace-transfer complete: hand the catch to the mother ──
      const debrisId = debris.id;
      // Release the daughter's pin so the furnace step owns the debris.
      debris._armPinned = false;
      debris._capturedByArm = null;
      debris._armPinPos = null;
      debris._breakdownActive = false;
      clearShipRelativeAttitude(debris);
      clearRackCell(debris);                // rack-snug: it leaves her rack
      // S6: pop the digested piece off the rack.
      this.heldCatches.shift();
      this.reeling = false;
      this.tetherTension = 0;
      this._breakdownStarted = false;
      this._breakdownChunksFired = 0;
      // The successful catch consumed the net — fed in with the debris. Tell the
      // bag visual to draw itself toward the mother (§3.5: success consumes net).
      eventBus.emit(Events.NET_CONSUMED, { armIndex: this.index, armId: this.id });
      eventBus.emit(Events.CATCH_PROCESSED, { armId: this.id, debrisId, type: this.type });
      // Completion comms is owned by GameFlowManager's CATCH_PROCESSED handler.
      if (this.heldCatches.length > 0) {
        // S6 sequential digestion: the next piece runs the SAME timeline from
        // t=0. stateTimer is only zeroed by _transitionTo, and we are NOT
        // leaving HOLDING_CATCH — zero it explicitly (no ARM_STATE_CHANGE: she
        // stays parked). S8: the timeline runs off the piece's _digestProgress
        // (a fresh piece starts at 0, so t=0 automatically); the stateTimer
        // reset is kept for any other per-state readers.
        this.stateTimer = 0;
        // Register item 67(b): the digested piece's mass just LEFT the rack
        // sum computeInertia reads, and staying parked fires no
        // ARM_STATE_CHANGE (the invalidating event the empty-rack RELOADING
        // below gets for free) — invalidate the cache directly, the item-63
        // seam for a mass-exit that crosses no arm-state change.
        const ps = this._playerSatellite;
        if (ps && '_attitudeInertia' in ps) ps._attitudeInertia = null;
        return;
      }
      this._transitionTo(S.RELOADING);
      this.reloadProgress = 0;
      this.reloadDuration = 0;
      eventBus.emit(Events.CROSSBOW_RELOAD_START, {
        armIndex: this.index,
        duration: this.reloadDuration,
      });
    }
  }

  /**
   * RELOADING: V5 worm gear motor compresses crossbow spring.
   * Duration depends on launch speed² (energy-based).
   * @private
   */
  _updateReloading(dt) {
    if (this.reloadDuration <= 0) {
      // Calculate reload duration if not set
      const speed = this.launchSpeed;
      const armMass = this.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS;
      const energy = 0.5 * armMass * speed * speed;
      this.reloadDuration = energy / (CROSSBOW_RELOAD_POWER * CROSSBOW_WORM_GEAR_EFFICIENCY);
    }

    this.reloadProgress += dt / this.reloadDuration;

    // w4-power D5: the reload worm-gear motor runs off the mother's battery at
    // CROSSBOW_RELOAD_POWER (MOTOR_DRAW_W.CROSSBOW_RELOAD) for the whole
    // reload — the energy E/η the duration above is computed from.
    if (dt > 0) {
      const rs = this._playerSatellite && this._playerSatellite._resourceSystem;
      if (rs && typeof rs.billWatts === 'function') {
        rs.billWatts(Constants.MOTOR_DRAW_W?.CROSSBOW_RELOAD ?? CROSSBOW_RELOAD_POWER, dt);
      }
    }

    if (this.reloadProgress >= 1.0) {
      this.reloadProgress = 1.0;
      this.springCharged = true;
      this._transitionTo(S.DOCKED);
      eventBus.emit(Events.CROSSBOW_RELOAD_COMPLETE, { armIndex: this.index, armId: this.id });
      eventBus.emit(Events.ARM_DOCKED, { armId: this.id });
    }
  }

  /** TRAWLING: slow sweep — passive debris collection along orbit path (Phase 6) */
  _updateTrawling(dt, parentPos) {
    this.mesh.visible = true;
    this.tetherLine.visible = true;

    // Track duration
    this._trawlTimer = (this._trawlTimer || 0) + dt;
    const maxDuration = (Constants.TRAWLING && Constants.TRAWLING.TRAWL_DURATION_MAX) || 120;

    if (this._trawlTimer >= maxDuration) {
      this._trawlingMode = false;
      eventBus.emit(Events.TRAWL_END, { armId: this.id });

      if (this.isDetached) {
        // Detached arms can't return — switch to free-flying transit
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: this.displayName, text: 'Trawl complete. Free-flying, no tether.', priority: 'info',
        });
        this._transitionTo(S.TRANSIT);
      } else {
        // V5: Use REELING for zero-fuel return
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: this.displayName, text: 'Trawl complete. Reeling in', priority: 'info',
        });
        this._transitionTo(S.REELING);
      }
      return;
    }

    // Consume fuel (very low rate)
    const fuelRate = (Constants.TRAWLING && Constants.TRAWLING.FUEL_RATE_TRAWL) || 0.002;
    this.fuel -= fuelRate * dt;

    // Detached trawling arms: fuel warnings (same thresholds as _consumeFuel)
    if (this.isDetached) {
      const fuelFrac = this.fuel / 100;
      if (fuelFrac <= Constants.DETACH_FUEL_WARNING_10 && !this._detachFuelWarning10) {
        this._detachFuelWarning10 = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `CRITICAL: ${this.displayName} fuel at 10%. Recommend immediate deorbit.`,
          priority: 'critical',
        });
      } else if (fuelFrac <= Constants.DETACH_FUEL_WARNING_25 && !this._detachFuelWarning25) {
        this._detachFuelWarning25 = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `WARNING: ${this.displayName} fuel at 25%. Limited maneuver capability.`,
          priority: 'warning',
        });
      }
    }

    // Tethered trawler that runs low holds her reserve and goes ADRIFT (the
    // mother can still reel her home) rather than being abandoned. Detached
    // trawlers have no winch — they are genuinely lost at zero.
    const trawlReserve = Constants.ARM_RESERVE_FUEL ?? 0;
    if (!this.isDetached && trawlReserve > 0 && this.fuel <= trawlReserve) {
      this.fuel = trawlReserve;
      this._trawlingMode = false;
      eventBus.emit(Events.TRAWL_END, { armId: this.id });
      this._enterAdrift();
      return;
    }

    if (this.fuel <= 0) {
      this.fuel = 0;
      this._trawlingMode = false;

      if (this.isDetached) {
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `Daughter lost. ${this.displayName} fuel depleted. No thrust available.`,
          priority: 'critical',
        });
        eventBus.emit(Events.ARM_LOST, { armId: this.id });
      } else {
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: this.displayName, text: 'Trawl aborted. Fuel depleted', priority: 'warning',
        });
      }
      eventBus.emit(Events.TRAWL_END, { armId: this.id });
      eventBus.emit(Events.ARM_EXPENDED, { armId: this.id, type: this.type });
      this._transitionTo(S.EXPENDED);
      return;
    }

    // Move slowly in trawl direction at 30% of normal speed
    const speed = (this.config.approachSpeed || 0.000005) *
      ((Constants.TRAWLING && Constants.TRAWLING.TRAWL_SPEED_SCALE) || 0.3);

    if (this._trawlDirection) {
      this.position.x += this._trawlDirection.x * speed * dt;
      this.position.y += this._trawlDirection.y * speed * dt;
      this.position.z += this._trawlDirection.z * speed * dt;
    }

    // Update tether length and enforce tether limit
    this.tetherLength = this.position.distanceTo(parentPos) / M;

    if (!this.isDetached && this.tetherLength >= this.config.tetherMax * 0.95) {
      // Clamp to tether max — prevent over-extension (skip for detached arms)
      const dir = this._tmpVec.subVectors(this.position, parentPos).normalize();
      this.position.copy(parentPos).add(dir.multiplyScalar(this.config.tetherMax * 0.94 * M));
      this.tetherLength = this.config.tetherMax * 0.94;
    }

    // Check for nearby debris (auto-capture)
    const captureRadius = ((Constants.TRAWLING && Constants.TRAWLING.TRAWL_RADIUS_KM) || 0.05) * Constants.SCENE_SCALE;
    const maxCaptureMass = (Constants.TRAWLING && Constants.TRAWLING.AUTO_CAPTURE_MASS_MAX) || 50;

    // Emit event for debris field to check
    eventBus.emit(Events.TRAWL_CAPTURE, {
      armId: this.id,
      position: this.position.clone(),
      radius: captureRadius,
      maxMass: maxCaptureMass,
    });

    // Also check _nearbyDebris (passive proximity capture)
    if (this._nearbyDebris && this._nearbyDebris.length > 0) {
      for (const debris of this._nearbyDebris) {
        if (!debris.alive || !debris._scenePosition) continue;
        if (debris.mass > maxCaptureMass) continue;
        const dist = this.position.distanceTo(debris._scenePosition);
        if (dist < captureRadius) {
          // Trawl auto-capture!
          this.target = debris;
          this.capturedDebris = debris;
          debris._captured = true;  // UX Fix E+: hide reticle immediately
          debris._capturedByArm = this; // POLISH FIX issue #2: pin debris visual to arm during REELING
          this._trawlTimer = 0;
          this._trawlingMode = false;
          this._transitionTo(S.GRAPPLED);
          eventBus.emit(Events.ARM_CAPTURED, {
            armId: this.id, targetId: debris.id, type: this.type, mode: 'trawling',
            detached: this.isDetached,
            mass: debris.mass || 0, debrisType: debris.type || 'unknown',
            manual: false, rangeM: this._captureRangeM(),
          });
          eventBus.emit(Events.COMMS_MESSAGE, {
            sender: this.displayName,
            text: `🎣 Trawl capture! ${debris.id} netted passively.`,
            priority: 'success',
          });
          eventBus.emit(Events.TRAWL_END, { armId: this.id });
          break;
        }
      }
    }
  }

  /** DEORBITING: burning all fuel retrograde until depleted, then removed (Session 10) */
  _updateDeorbiting(dt) {
    // Burn fuel at maximum rate (3× normal transit rate)
    const burnRate = 5.0; // %/sec — aggressive burn
    this.fuel -= burnRate * dt;

    // Move retrograde (opposite to orbital velocity direction = "slowing down")
    // F9: derive retrograde from the LIVE velocity vector, not `position × ŷ`.
    // The old cross-product assumed an equatorial orbit and pointed the wrong
    // way for inclined tracks (e.g. the 51.6° ISS-like orbits the sim uses).
    // (normalize() of a zero vector returns zero in THREE, so no NaN risk.)
    const retrograde = _goalDir.copy(this.velocity).normalize().negate();
    // ST-8.3.4: Use metal-specific thrust calculation
    const thrustDV = (this._computeMetalThrust() / (this.config.mass + (this.capturedDebris?.mass || 0))) * dt;
    this.velocity.add(retrograde.multiplyScalar(thrustDV));
    this.position.addScaledVector(this.velocity, dt);

    // Visual: mesh visible, thruster plume active
    this.mesh.visible = true;
    this.tetherLine.visible = false; // Tether detached for deorbit

    // Fuel depleted — sacrifice complete
    if (this.fuel <= 0) {
      this.fuel = 0;
      // Remove arm + debris from scene
      this.mesh.visible = false;
      this.group.visible = false;
      this._transitionTo(S.EXPENDED);

      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Fuel exhausted. Deorbit burn complete. Daughter lost.`,
        priority: 'warning',
      });
    }
  }

  /** WEB_SHOT: brief GSL web launch animation (~2s), then emit hit event (Sprint D1) */
  _updateWebShot(dt, parentPos) {
    this.mesh.visible = true;
    this.tetherLine.visible = true;

    // Extend arm briefly toward target direction from its origin position
    const tPos = this._webShotTarget?._scenePosition;
    const origin = this._webShotOrigin;
    if (tPos && origin) {
      const toTarget = this._tmpVec.subVectors(tPos, origin).normalize();
      const extendDist = this.config.bodyDims[2] * M * 10 * (this.stateTimer / Constants.WEB_SHOT_DURATION);
      this.position.copy(origin).add(toTarget.multiplyScalar(extendDist));
    }

    // Update tether length
    if (parentPos) {
      this.tetherLength = this.position.distanceTo(parentPos) / M;
    }

    // After duration: emit hit, start cooldown, return to previous state
    if (this.stateTimer >= Constants.WEB_SHOT_DURATION) {
      // Emit web shot hit event
      const debrisId = this._webShotTarget?.id;
      if (debrisId !== undefined && debrisId !== null) {
        eventBus.emit(Events.WEB_SHOT_HIT, {
          debrisId,
          dragMultiplier: Constants.WEB_SHOT_DRAG_MULT,
        });
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.displayName}: 🕸 Web hit! Debris ${debrisId} drag ×${Constants.WEB_SHOT_DRAG_MULT}`,
          priority: 'success',
        });
      }

      // Start cooldown
      this._webShotCooldown = Constants.WEB_SHOT_COOLDOWN;
      this._webShotTarget = null;

      // Return to previous state
      this._transitionTo(this._webShotPrevState);
    }
  }

  /**
   * ABLATING: V5 laser ablation for de-spin/nudge.
   * 10W laser applies torque to reduce target angular velocity.
   * @private
   */
  _updateAblating(dt) {
    this.ablationTimer += dt;

    // Check range to target
    if (this.ablationTarget) {
      const targetPos = this.ablationTarget.mesh ? this.ablationTarget.mesh.position : null;
      if (targetPos) {
        const range = this.position.distanceTo(targetPos) / M;
        if (range > ABLATION_RANGE_MAX) {
          // Out of range — stop ablation
          this._endAblation('outOfRange');
          return;
        }

        // Apply de-spin torque to target (if it has angular velocity)
        if (this.ablationTarget.angularVelocity !== undefined) {
          const despin = ABLATION_DESPIN_RATE * dt;
          const av = this.ablationTarget.angularVelocity;
          if (Math.abs(av) > despin) {
            this.ablationTarget.angularVelocity -= Math.sign(av) * despin;
          } else {
            this.ablationTarget.angularVelocity = 0;
          }
        }
      }
    }

    if (this.ablationTimer >= ABLATION_DURATION_MAX) {
      this._endAblation('timeout');
    }
  }

  /**
   * End ablation and return to transit.
   * @private
   * @param {string} reason - Why ablation ended
   */
  _endAblation(reason) {
    eventBus.emit(Events.ABLATION_END, {
      armIndex: this.index,
      despinAchieved: reason !== 'outOfRange',
    });
    this.ablationTimer = 0;
    this.ablationTarget = null;
    this._transitionTo(S.TRANSIT); // Return to transit to come back
  }

  /**
   * SCANNING: V5 pulse scan — arm acts as distributed sensor node.
   * Duration managed by ArmManager (orchestrates all arms together).
   * Individual arm just holds position and emits sensor data.
   * @private
   */
  _updateScanning(dt) {
    this._scanTimer = (this._scanTimer || 0) + dt;

    if (this._scanTimer >= PULSE_SCAN_DURATION) {
      this._scanTimer = 0;
      this._transitionTo(this._preScanState || S.DOCKED);
      this._preScanState = null;
    }
  }

  /**
   * ADRIFT: out of usable FEEP but STILL TETHERED and powered. Thrusters are
   * offline (the working tank is empty), yet avionics/beacon run on the reserve
   * and the mother's winch can pull her home, so she stays fully recoverable —
   * the player can reel her in (R), select/pilot her (1-4), or disconnect her.
   * She drifts gently at the end of the tether (no active thrust); the tether
   * line and tension are handled by _updateTether as for any deployed daughter.
   */
  _updateAdrift(dt) {
    this.position.addScaledVector(this.velocity, dt * 0.5);
    this.velocity.multiplyScalar(0.99); // slow residual drift; the tether holds her
    this.mesh.visible = true;
  }

  /**
   * Transition a tethered daughter into ADRIFT (out of usable propellant but
   * recoverable). Plain-language comms so the player understands WHAT happened
   * and WHAT they can do — never the bare, scary "expended". Guarded so the
   * message fires once per adrift episode.
   * @private
   */
  _enterAdrift() {
    if (this.state === S.ADRIFT || this.state === S.EXPENDED || this.isDetached) return;
    this._manualMode = false;
    this._trawlingMode = false;
    this._transitionTo(S.ADRIFT);
    eventBus.emit(Events.COMMS_MESSAGE, {
      source: 'HOUSTON',
      channel: 'CMD',
      text: `${this.displayName}: FEEP propellant spent. Thrusters offline, but she's still on the tether and powered. Press R to reel her home (winch, no fuel needed) or disconnect. Not lost.`,
      priority: 'warning',
    });
  }

  /** EXPENDED: no fuel, drifting */
  _updateExpended(dt) {
    this.position.addScaledVector(this.velocity, dt * 0.5);
    this.velocity.multiplyScalar(0.999);
    this.mesh.visible = true;
    // A severed tether shows no line back to the mother (the cable parted).
    this.tetherLine.visible = !this._tetherSevered;

    // Bounded cleanup of a tether-snapped catch: it tumbles off pinned to this
    // drifting daughter for a short while, then we release the pin so the
    // runaway debris resumes its own orbit + LOD (otherwise it would render at
    // full detail forever and never be reclaimed by the field).
    if (this._severedCatch) {
      // If another daughter re-captured the runaway, the pin has transferred —
      // stop tracking it here.
      if (this._severedCatch._capturedByArm !== this) {
        this._severedCatch = null;
      } else {
        // Keep the catch glued to this drifting daughter (authoritative pin).
        this._severedCatch._armPinPos = this._severedCatch._armPinPos
          ? this._severedCatch._armPinPos.copy(this.position)
          : this.position.clone();
        this._severedCatch._armPinned = true;
        this._severedDriftS += dt;
        if (this._severedDriftS >= (Constants.TETHER_SNAP_RELEASE_DELAY_S || 8.0)) {
          this._severedCatch._capturedByArm = null; // resume orbit-driven position + LOD
          this._severedCatch._armPinned = false;
          this._severedCatch = null;
        }
      }
    }
  }

  // ==========================================================================
  // UTILITIES
  // ==========================================================================

  /** @private Fuel consumption by state */
  _consumeFuel(dt) {
    // Rates in %/sec — tuned so a full deploy-capture-return cycle ≈30-60s gameplay
    // Register item 100: TRANSIT/APPROACH rates apply ONLY to manual-pilot
    // flight now; the autopilot path is impulse-priced (below).
    const rates = {
      [S.UNDOCKING]: 0.2,
      [S.LAUNCHING]: 0.0,         // V5: Spring provides energy, no fuel burn
      [S.TRANSIT]: 1.5,
      [S.APPROACH]: 1.0,
      [S.NETTING]: 0.3,
      [S.GRAPPLED]: 0.2,
      [S.HAULING]: 2.0,
      [S.REELING]: 0.0,           // V5: motor reel-in (REEL_HOME: the ion thread is billed in _updateReeling, not here)
      [S.RETURNING]: 1.2,
      [S.DOCKING]: 0.2,
      [S.RELOADING]: 0.0,         // V5: worm gear — zero FEEP fuel (no stored-energy model)
      [S.WEB_SHOT]: 0.0,          // Fuel consumed upfront in fireWebShot()
      [S.ABLATING]: 0.0,          // V5: laser de-spin — zero FEEP fuel (no stored-energy model)
      [S.SCANNING]: 0.0,          // V5: sensor mode — zero FEEP fuel (no stored-energy model)
    };
    let rate = rates[this.state] || 0;
    // reel-home: winding the net line in is a motor on her, not a thruster burn (the strut reel's only FEEP is the ion thread, billed in _updateReeling)
    if (this.state === S.GRAPPLED && this._rhHome) rate = 0;
    // REEL_PROFILE_V2 (plan Q4): the re-dock arrest is charged ONCE as a discrete
    // mass-scaled debit during REELING. Suppress the per-state DOCKING rate for
    // the cycle that fired it so the FEEP burn isn't double-charged. The flag is
    // cleared on the next clean dock/reload cycle (in _transitionTo).
    if (this.state === S.DOCKING && this._redockDebitApplied === true) rate = 0;
    // reel-home (fix round F6): DOCKING that came off the strut reel is the winch settling her onto the strut (REELING
    // fired no arrest burn under the flag), so the DOCKING thruster rate is not billed either.
    if (this.state === S.DOCKING && this._rhDockFree === true) rate = 0;
    // Register item 100 (the wide sweep): autopilot TRANSIT/APPROACH fuel is
    // IMPULSE-PRICED — the spring pays launch kinetic energy, so the FEEP pays
    // only the commanded corrective impulse (Σ|dvCmd| the controller applied
    // this frame) against the tank's total Δv (ARM_TOTAL_DELTAV 50 m/s →
    // 2 %/m/s). The time-based TRANSIT rate it replaces capped any powered
    // sortie at ~63 s to the reserve (630 m @10 m/s — the measured wall behind
    // the old 500 m deploy gate) and billed a slow shot MORE than a fast one
    // over the same ground. Coasting is free; the arrival kill is the bill.
    // Manual-pilot TRANSIT/APPROACH keeps the time-based rate (the pilot's
    // thrust path meters no impulse — recorded split, not an oversight).
    if ((this.state === S.TRANSIT || this.state === S.APPROACH) && !this._manualMode) {
      const dvMps = this._impulseDvAccum;
      this._impulseDvAccum = 0;
      this.fuel -= (dvMps / (this.config.totalDeltaV || Constants.ARM_TOTAL_DELTAV)) * 100;
    } else {
      this._impulseDvAccum = 0;
      this.fuel -= rate * dt;
    }

    // === Detached arm fuel warnings (Phase 6 — no refuel possible) ===
    if (this.isDetached) {
      const fuelFrac = this.fuel / 100;

      if (fuelFrac <= Constants.DETACH_FUEL_WARNING_25 && !this._detachFuelWarning25) {
        this._detachFuelWarning25 = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `WARNING: ${this.displayName} fuel at 25%. Limited maneuver capability.`,
          priority: 'warning',
        });
      }
      if (fuelFrac <= Constants.DETACH_FUEL_WARNING_10 && !this._detachFuelWarning10) {
        this._detachFuelWarning10 = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `CRITICAL: ${this.displayName} fuel at 10%. Recommend immediate deorbit.`,
          priority: 'critical',
        });
      }
    }

    // ── Emergency reserve: a TETHERED daughter never strands herself ──────────
    // She holds ARM_RESERVE_FUEL back so the mother can reel her home under
    // control (tether tension + soft-dock arrest, so neither she nor her catch
    // slams the strut). Hitting the reserve while working/flying means "no usable
    // propellant" — but she is NOT lost: avionics/beacon stay live and she goes
    // ADRIFT (recoverable, fully commandable on the tether). Detached daughters
    // have no winch, so the reserve can't save them — they fall through to the
    // genuine-loss path below.
    const reserve = Constants.ARM_RESERVE_FUEL ?? 0;
    // reel-home (F2c): the line-up may spend the reserve (it is kept for a safe reel-home), so a daughter that docked on
    // it and holds her catch is a docked daughter, not an adrift one: she keeps HOLDING_CATCH, like DOCKING does.
    const dockedOnReserve = this.state === S.HOLDING_CATCH && Constants.isFeatureEnabled('REEL_HOME');
    if (!this.isDetached && reserve > 0 && this.fuel <= reserve && this.state !== S.ADRIFT) {
      if (this.state === S.RETURNING) {
        // Can't fly home on the reserve. Hand off to the mother's zero-fuel winch
        // so the reserve survives for the soft-dock arrest.
        this._transitionTo(S.REELING);
        eventBus.emit(Events.COMMS_MESSAGE, {
          source: 'HOUSTON', channel: 'CMD',
          text: `${this.displayName}: FEEP reserve only. Finishing the return on the winch.`,
          priority: 'warning',
        });
        eventBus.emit(Events.ARM_RECALLED, { armId: this.id });
        return;
      }
      if (this.state !== S.DOCKING && !dockedOnReserve) {
        // Working daughter (transit / approach / netting / hauling / …) has spent
        // her usable propellant. Lock the reserve and go ADRIFT — tethered,
        // powered, recoverable. DOCKING is exempt: she is allowed to spend the
        // reserve on the final arrest.
        this.fuel = reserve;
        this._enterAdrift();
        return;
      }
    }

    if (this.fuel <= 0) {
      this.fuel = 0;

      // Detached arms that run out of fuel: no tether to winch home — genuinely lost.
      if (this.isDetached) {
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `Daughter lost. ${this.displayName} fuel depleted. No thrust available.`,
          priority: 'critical',
        });
        eventBus.emit(Events.ARM_LOST, { armId: this.id });
        eventBus.emit(Events.ARM_EXPENDED, { armId: this.id, type: this.type });
        this._transitionTo(S.EXPENDED);
        return;
      }

      // Non-detached daughter that drained the reserve during the dock itself:
      // the winch still eases her in (REDOCK_FEEP FUEL_FALLBACK_SLOW), so a
      // tethered daughter is never abandoned. Hold at empty and let the dock
      // finish on motor power.
      if (this.state === S.DOCKING || dockedOnReserve) return;

      // Any other state hitting true zero with no tether benefit is spent.
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: FUEL DEPLETED. Daughter expended`,
        priority: 'critical',
      });
      eventBus.emit(Events.ARM_EXPENDED, { armId: this.id, type: this.type });
      this._transitionTo(S.EXPENDED);
    }
  }

  /**
   * @private Update tether visual between parent and arm.
   * C-3: Uses strut tip as mother-side anchor when Config G geometry is available.
   * Falls back to parentPos (mother center) when geometry is absent (pre-C-3 compat).
   * @param {THREE.Vector3} parentPos — mother world position
   * @param {THREE.Quaternion} [parentQuat] — mother world orientation (for strut tip calc)
   * @param {number} [dt] — frame delta (seconds) for REELING dash-flow animation
   */
  _updateTether(parentPos, parentQuat, dt) {
    // fail-reel: remember the mother's orientation of the last frame she was out (the 500 m rule measures to the live
    // strut tip, `_strutTipDistM`); one persistent quaternion, no allocation after the first frame.
    if (parentQuat) {
      (this._frameParentQuat || (this._frameParentQuat = new THREE.Quaternion())).copy(parentQuat);
    }
    // States where the daughter is AT (or arriving at) her strut-tip dock —
    // no tether should render. REELING/RETURNING already snap her to the strut
    // tip before entering DOCKING (Issue 1/8 fixes), so by DOCKING the cable
    // spans ~0 and carries no information; rendering it only exposes the
    // one-frame-stale counter-rotation flash (Mechanism B — pose error nears
    // 180° at DOCKING entry), which read as a "wrong-way 180° tether". DOCKED /
    // RELOADING / HOLDING_CATCH likewise park at the strut. _updateTether runs
    // AFTER the per-state handler, so without this early-out it re-shows a
    // stray, wrong-direction tether for the whole window.
    if (this.state === S.DOCKED || this.state === S.DOCKING ||
        this.state === S.RELOADING || this.state === S.HOLDING_CATCH ||
        this.state === S.CARRY_PREP) {                 // trip-melt-2: docked while the strut and radiators move
      // Wave1: while the line is hidden, snap the tint home to NOMINAL — a
      // stressed reel-in tint would otherwise persist across the dock and
      // re-appear, stale, on the next deploy. (Tension is already 0 here; the
      // eased driver would fade out only over ~tau while hidden — resetting
      // avoids the flash entirely.)
      this.tetherMaterial.color.setHex(Constants.TETHER_COLOR_NOMINAL);
      this.tetherLine.visible = false;
      return;
    }
    // Detached arms have no tether to render
    if (this.isDetached) {
      this.tetherLine.visible = false;
      return;
    }

    if (this.state === S.EXPENDED) {
      // Tether still visible but dimmed
      this.tetherMaterial.opacity = 0.2;
    }
    this.tetherLine.visible = true;

    // Drive the tint from the LIVE REEL TENSION fraction via tetherTensionTint —
    // replacing the old always-on distance strain driver whose orbital-frame
    // jitter caused the red/white flashing artifact documented above. The
    // tension fraction is computed in _updateReeling for snap physics (stable
    // within a reel, zero outside one), so the line eases through amber toward
    // red exactly while the winch is straining, and eases home when the reel
    // ends.
    this._updateTetherTensionTint(dt);
    this.tetherMaterial.opacity = (this.state === S.EXPENDED) ? 0.2 : 0.9;

    // Compute mother-side anchor point — strut tip via dockOffset (PlayerSatellite frame),
    // or fallback to parentPos (bus center, pre-Config-G behavior).
    let anchorPos = parentPos;
    if (this.dockOffset && parentQuat) {
      anchorPos = this.getTetherAnchorWorldPosition(parentPos, parentQuat);
    }

    // Update geometry — catenary sag (perpendicular to tether direction)
    // Tether line is child of this.group (identity rotation, positioned at this.position),
    // so vertex positions are in GROUP-LOCAL coordinates (world offset by this.position).
    // Directions in group-local space equal directions in world space.
    const posArr = this.tetherLine.geometry.attributes.position.array;
    const segments = Constants.TETHER_SEGMENTS;

    // Compute tether vector in group-local space (anchor → arm origin)
    const dx = anchorPos.x - this.position.x;
    const dy = anchorPos.y - this.position.y;
    const dz = anchorPos.z - this.position.z;
    const separation = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // If separation is near-zero, draw all vertices at origin
    if (separation < Constants.TETHER_SAG_PARALLEL_THRESHOLD) {
      for (let i = 0; i < segments; i++) {
        const idx = i * 3;
        posArr[idx] = 0; posArr[idx + 1] = 0; posArr[idx + 2] = 0;
      }
      this.tetherLine.geometry.attributes.position.needsUpdate = true;
      return;
    }

    // Tether direction (unit vector)
    const tHatX = dx / separation;
    const tHatY = dy / separation;
    const tHatZ = dz / separation;

    // Project world-down (0, -1, 0) onto the plane perpendicular to tether direction
    // sagDir = worldDown - (worldDown · tHat) * tHat
    const dotDown = -tHatY; // (0,-1,0) · tHat
    let sagX = 0 - dotDown * tHatX;
    let sagY = -1 - dotDown * tHatY;
    let sagZ = 0 - dotDown * tHatZ;
    let sagMag = Math.sqrt(sagX * sagX + sagY * sagY + sagZ * sagZ);

    // Degenerate case: tether nearly aligned with gravity — fall back to world +Z
    if (sagMag < Constants.TETHER_SAG_PARALLEL_THRESHOLD) {
      const dotZ = tHatZ; // (0,0,1) · tHat
      sagX = 0 - dotZ * tHatX;
      sagY = 0 - dotZ * tHatY;
      sagZ = 1 - dotZ * tHatZ;
      sagMag = Math.sqrt(sagX * sagX + sagY * sagY + sagZ * sagZ);
    }

    // Normalize sag direction
    if (sagMag > Constants.TETHER_SAG_PARALLEL_THRESHOLD) {
      sagX /= sagMag; sagY /= sagMag; sagZ /= sagMag;
    } else {
      sagX = 0; sagY = 0; sagZ = 0; // Truly degenerate — no sag
    }

    // Sag amplitude: proportional to current separation (not max tether length)
    const sagAmp = separation * Constants.TETHER_SAG_FACTOR;

    for (let i = 0; i < segments; i++) {
      const t = i / (segments - 1);
      const invT = 1 - t;
      const bell = Math.sin(t * Math.PI);
      const idx = i * 3;
      posArr[idx]     = dx * invT + sagX * bell * sagAmp;
      posArr[idx + 1] = dy * invT + sagY * bell * sagAmp;
      posArr[idx + 2] = dz * invT + sagZ * bell * sagAmp;
    }
    this.tetherLine.geometry.attributes.position.needsUpdate = true;

    // Item 11 (2026-06-12): REELING motion cue — a brightness pulse travels
    // along the gradient toward the mother (anchor), replacing the old
    // LineDashedMaterial dash-phase scroll. Phase 1 → 0 maps daughter → anchor.
    if (this.state === S.REELING && typeof dt === 'number' && dt > 0) {
      const _rs = (this.capturedDebris !== null
        ? REEL_IN_SPEED_LOADED : REEL_IN_SPEED_EMPTY);
      // Pulse speed: one full traverse per (separation / reelSpeed) seconds,
      // i.e. the pulse moves at the reel speed along the cable; minimum rate
      // keeps it visible on very short tethers.
      const sepM = Math.max(1, separation / M);
      const rate = Math.max(0.25, _rs / sepM);          // traversals per second
      this._tetherPulsePhase = (this._tetherPulsePhase ?? 1) - rate * dt;
      if (this._tetherPulsePhase < 0) this._tetherPulsePhase += 1;
      this._tetherWriteGradient(this._tetherPulsePhase);
    } else if (this._tetherPulsePhase !== undefined) {
      // Leaving REELING: restore the static gradient once.
      this._tetherPulsePhase = undefined;
      this._tetherWriteGradient(-1);
    }

    // FIX: Tether vertices are computed as WORLD-SPACE offsets from arm.position,
    // but the tether line is a child of arm.group which has a non-identity quaternion
    // (set by attitude control to align the arm mesh with its heading). This rotation
    // was being applied to the tether vertices, causing the tether to "drift off
    // parallel to mother" instead of connecting reel to arm.
    // Counteract the group rotation so tether renders in world orientation.
    this.tetherLine.quaternion.copy(this.group.quaternion).invert();
  }

  /**
   * @private Wave1: ease the tether material color toward the tension-fraction
   * tint (tetherTensionTint). Called every frame from _updateTether.
   *
   * Per-frame exponential ease (1 − e^(−dt/tau)) toward the target — never a
   * step — so a single-frame tension sample can only nudge the line a few
   * percent of the way to red; the historical strobe required the tint to jump
   * whole bands per frame. Tension reads 0 outside REELING, so the target is
   * NOMINAL the moment the reel (or the mission-1 clamp) ends and the line
   * fades back to cream.
   * @param {number} [dt] — frame delta seconds (omitted ⇒ snap to target)
   */
  _updateTetherTensionTint(dt) {
    if (!this.tetherMaterial) return;
    const breakN = this.tetherBreakStrength || 0;
    const frac = breakN > 0 ? this.tetherTension / breakN : 0;
    tetherTensionTint(frac, _tintTarget);
    const tau = Constants.TETHER_COLOR_EASE_TAU_S ?? 0.25;
    const alpha = (typeof dt === 'number' && dt > 0 && tau > 0)
      ? 1 - Math.exp(-dt / tau) : 1;
    this.tetherMaterial.color.lerp(_tintTarget, Math.min(1, alpha));
  }

  /** @private S3.6: Update bridle visibility + color to mirror tether state */
  _updateBridle() {
    if (!this._bridleLegA) return;
    const show = this.tetherLine && this.tetherLine.visible;
    // Hide during slack phase (first 0.3m post-launch, per §13.4.1)
    const pastSlack = this.tetherLength > 0.3;
    const visible = show && pastSlack;
    this._bridleLegA.visible = visible;
    this._bridleLegB.visible = visible;
    // Gate the gimbal ring + hardpoints with the legs so the bridle hardware only
    // appears while the tether/bridle is deployed (they read as clutter floating
    // on the docked body otherwise). Refs stored at build time (L722, L733–734).
    if (this._gimbalRing) this._gimbalRing.visible = visible;
    if (this._bridleHpA) this._bridleHpA.visible = visible;
    if (this._bridleHpB) this._bridleHpB.visible = visible;
    // Color: mirror tether material (same strain logic drives both)
    if (visible && this._bridleLegMat && this.tetherMaterial) {
      this._bridleLegMat.color.copy(this.tetherMaterial.color);
      this._bridleLegMat.opacity = this.tetherMaterial.opacity;
    }
    // KNOWN: gimbal ring rotates with daughter body (physically should track
    // tether direction). Acceptable at gameplay distances. Future: §13.7.3.
  }

  /**
   * @private Thruster plume animation (Wave1 rewrite).
   *
   * The which-nozzle/how-bright decision lives in the PURE
   * `computeDaughterPlumeIntensity` (entities/armPlumeModel.js — Node-tested
   * mapping table); this method only collects the live signals, decays the
   * visual timers, and styles the two plume pairs. READ-ONLY on physics:
   * state, fuel, and the arrest flags are inputs, never outputs.
   */
  _updatePlumes(dt) {
    // Decay the visual-only timers (latched by SK input / the recoil event).
    if (this._recoilFlashS > 0) this._recoilFlashS = Math.max(0, this._recoilFlashS - dt);
    if (this._skManeuverGlowS > 0) this._skManeuverGlowS = Math.max(0, this._skManeuverGlowS - dt);
    // The smoothed APPROACH brake read only updates inside _updateApproach;
    // zero it in every other state so a stale value can't leak into the next
    // approach (or into manual-mode coasting, which computes no thrust).
    if (this.state !== S.APPROACH) this._approachBrake01 = 0;

    const sig = _plumeSig;
    sig.state = this.state;
    sig.fuel = this.fuel;
    sig.skManeuverGlowS = this._skManeuverGlowS;
    sig.approachBrake01 = this._approachBrake01;
    // Funded arrest burn only — the FUEL_FALLBACK_SLOW winch finish and the
    // tether-fouls-plume hold must NOT flare (honesty: no debit, no burn).
    sig.reelHome = this._rhOn();
    sig.arrestFeepActive = (this._redockArrestStarted === true && this._redockDebitApplied === true)
      || !!this._rhLineUp;                // reel-home: her own thrusters, lining herself up (shown fore; the code moves her sideways, no nozzle is axial to that)
    sig.recoilFlashS = this._recoilFlashS;
    // reel-gas: which nozzle carries the ion thread on a carry leg (the clamp hold and the other states: none)
    sig.carryNozzle = (this.state === S.CARRY_OUT || this.state === S.CARRY_BACK) ? this._carryThread : null;
    const vis = computeDaughterPlumeIntensity(sig);

    // Frame-rate-independent shimmer (two sines, ±~5%) — replaces per-frame
    // Math.random() fire flicker; ion emission is steady. Shared by both
    // nozzles (one emitter feed system).
    const t = Date.now() * 0.001;
    const shimmer = 1 + 0.035 * Math.sin(t * 6.7) + 0.02 * Math.sin(t * 12.1);
    this._stylePlumePair(this._thrusterPlumes, this._plumeHalo, vis.aft, shimmer);
    this._stylePlumePair(this._forePlumes, this._forePlumeHalo, vis.fore, shimmer);
  }

  /**
   * @private Apply one intensity to one core+halo plume pair.
   * At intensity 1 this reproduces the legacy transit look exactly
   * (core 0.6 / halo 0.24, length 0.85×shimmer); lower intensities read as a
   * shorter, fainter thread. Intensity ≤ 0 hides the pair (visible=false —
   * zero render cost when dark).
   * @param {THREE.Mesh[]} plumes  core+halo list
   * @param {THREE.Mesh|null} halo the halo member (dims to HALO_MULT × core)
   * @param {number} intensity 0..1
   * @param {number} shimmer  length shimmer factor (~±5%)
   */
  _stylePlumePair(plumes, halo, intensity, shimmer) {
    const P = DAUGHTER_PLUME;
    const on = intensity > 0.001;
    const lenS = P.BASE_LEN_SCALE * shimmer
      * (P.MIN_LEN_SCALE + (1 - P.MIN_LEN_SCALE) * intensity);
    for (const plume of plumes) {
      if (on) {
        plume.visible = true;
        plume.scale.set(1, lenS, 1);                 // grow along beam; width steady
        plume.material.opacity = P.CORE_OPACITY * intensity
          * (plume === halo ? P.HALO_MULT : 1);
      } else {
        plume.visible = false;
        plume.material.opacity = 0;
      }
    }
  }

  /** @private Status light color based on state */
  _updateStatusLight(dt) {
    if (!this._statusLightMat) return;
    const blink = Math.sin(this.stateTimer * 4) > 0;

    // Detached arms: fast pulsing red override (regardless of state)
    if (this.isDetached) {
      const fastPulse = Math.sin(this.stateTimer * 10) > 0; // 2.5× faster pulse
      this._statusLightMat.color.setHex(fastPulse ? 0xff0000 : 0x440000);
      this._syncStatusHalo();
      return;
    }

    switch (this.state) {
      case S.DOCKED:     this._statusLightMat.color.setHex(0x00ff44); break;
      case S.UNDOCKING:  this._statusLightMat.color.setHex(blink ? 0xffff00 : 0x444400); break;
      case S.LAUNCHING:  this._statusLightMat.color.setHex(blink ? 0xff8800 : 0x884400); break;
      case S.TRANSIT:    this._statusLightMat.color.setHex(0x4488ff); break;
      case S.APPROACH:   this._statusLightMat.color.setHex(blink ? 0xff8800 : 0x442200); break;
      case S.NETTING:    this._statusLightMat.color.setHex(blink ? 0xff00ff : 0x440044); break;
      case S.GRAPPLED:   this._statusLightMat.color.setHex(0x00ffff); break;
      case S.HAULING:    this._statusLightMat.color.setHex(0x00ff88); break;
      case S.REELING:    this._statusLightMat.color.setHex(blink ? 0x00ffaa : 0x004422); break;
      case S.RETURNING:  this._statusLightMat.color.setHex(0x4488ff); break;
      case S.DOCKING:    this._statusLightMat.color.setHex(blink ? 0xffff00 : 0x444400); break;
      case S.RELOADING:  this._statusLightMat.color.setHex(blink ? 0xaaaa00 : 0x333300); break;
      case S.TRAWLING:   this._statusLightMat.color.setHex(blink ? 0x44aaff : 0x002244); break;
      case S.DEORBITING: this._statusLightMat.color.setHex(blink ? 0xff4400 : 0x441100); break;
      case S.WEB_SHOT:   this._statusLightMat.color.setHex(blink ? 0xffffff : 0x448844); break;
      case S.ABLATING:   this._statusLightMat.color.setHex(blink ? 0xff4488 : 0x441122); break;
      case S.SCANNING:   this._statusLightMat.color.setHex(blink ? 0x88ffff : 0x224444); break;
      case S.STATION_KEEP: this._statusLightMat.color.setHex(blink ? 0x00ffaa : 0x004422); break;
      case S.ADRIFT:     this._statusLightMat.color.setHex(blink ? 0xffaa00 : 0x442200); break;
      case S.EXPENDED:   this._statusLightMat.color.setHex(0xff0000); break;
    }
    this._syncStatusHalo();
  }

  /**
   * @private Mirror the status-light core colour onto its additive halo (×HDR),
   * so the glow always matches the current state and breathes with the blink
   * (the bright/dim per-state hex carries the phase). Cheap, null-safe.
   */
  _syncStatusHalo() {
    const halo = this._statusLightHalo;
    if (!halo) return;
    halo.material.color.copy(this._statusLightMat.color).multiplyScalar(1.8);
  }

  /**
   * D4 (hotkey revamp 2026-06-14): mark this daughter as the selected plate so
   * its body glows/flashes. Called by ArmManager on ARM_SELECT/ARM_DESELECT.
   * The visual pulse itself runs every frame in _updateSelectGlow(); this just
   * flips the flag and immediately restores the base emissive on deselect so a
   * non-updating (e.g. paused) frame doesn't leave the arm stuck lit.
   * @param {boolean} on
   */
  setSelectedHighlight(on) {
    const next = !!on;
    if (next === this._selected) return;
    this._selected = next;
    if (!next) this._restoreSelectGlow();
  }

  /** @private Restore body facet emissive to its recorded base values. */
  _restoreSelectGlow() {
    for (const e of this._selectGlowMats) {
      e.mat.emissive.setHex(e.baseEmissive);
      e.mat.emissiveIntensity = e.baseIntensity;
    }
  }

  /**
   * @private Pulse the body facet emissive while selected (D4). A cyan flash
   * sinusoidally modulates emissiveIntensity above the base value so the
   * selected daughter "breathes" — clearly readable on a docked plate while
   * the mother stays in view. No-op (cheap early return) when not selected.
   */
  _updateSelectGlow(dt) {
    if (!this._selected || this._selectGlowMats.length === 0) return;
    // ~1.4 Hz breath; intensity rides from base → base + 0.9.
    const pulse = 0.5 + 0.5 * Math.sin(this.stateTimer * 9.0);
    const SELECT_EMISSIVE = 0x00d4ff;   // HUD cyan accent
    for (const e of this._selectGlowMats) {
      e.mat.emissive.setHex(SELECT_EMISSIVE);
      e.mat.emissiveIntensity = e.baseIntensity + 0.25 + 0.9 * pulse;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ST-9.4 C-6: CAPTURE NET INVENTORY
  // Per CAPTURE_NET.md §6.1 — weaver=Medium Net (Large Daughter, magazine 2),
  // spinner=Small Net (Small Daughter, magazine 4) at Y0.
  // Gated by FEATURE_FLAGS.CAPTURE_NET. When OFF: inventory stays 0.
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Initialise net inventory from CAPTURE_NET constants for this arm's type.
   * Called by CaptureNetSystem.init() or ArmManager after arm creation.
   */
  initNetInventory() {
    if (!Constants.isFeatureEnabled('CAPTURE_NET')) return;
    const type = this.config.type;
    // Net class — Weaver carries the Medium net (Large Daughter), Spinner the
    // Small net (Small Daughter) (CAPTURE_NET.md §6.1).
    const netClass = type === 'weaver' ? Constants.CAPTURE_NET.MEDIUM : Constants.CAPTURE_NET.SMALL;
    // Magazine capacity is sourced from the net class's MAGAZINE_SIZE. The
    // ARM_NET_CAPACITY constant mirrors these values (drift-guard test enforces
    // equality); we seed from MAGAZINE_SIZE so the net class stays authoritative.
    const capacity = (netClass && netClass.MAGAZINE_SIZE) ?? Constants.ARM_NET_CAPACITY[type] ?? 0;
    this._netInventoryMax = capacity;
    this._netInventory = capacity;
    this._netRatedMass = (netClass && netClass.MAX_CAPTURE_MASS) || 0;
    this._netDiameter = (netClass && netClass.DIAMETER) || 0;
    // initNetInventory() seeds the magazine WITHOUT emitting (and runs after
    // construction), so event-only caps would start stale. Sync directly.
    this._syncNetCells(this._netInventory);
  }

  /**
   * @private - draw the can's front-face cells (nets-step2): one dark bore and one pale cap per net, from
   * netCellLayout(n, can radius - 3 mm, 2 mm gap): bore r = cell outer - 2 mm, cap r = 0.9 x bore. Large can 2 / 3 / 4 / 5
   * bores (r 0.0225 .. 0.0159 m), small 4 / 6 / 8 / 10 (r 0.0098 .. 0.0049 m). The radius, face, disc and lip do not move.
   * Names: `<id>-DNetCellHole_i` / `<id>-DNetCellCap_i`.
   * @param {number} n
   */
  _buildNetCells(n) {
    const { canR, cellFaceZ, DISC_TOP, boreMat, capMat } = this._netCan;
    const cells = netCellLayout(n, canR - 0.003, 0.002);
    const boreR = (cells.length ? cells[0].r : 0.01) - 0.002;
    const around = (r) => (r >= 0.02 ? 48 : 24);   // test-RoundParts radius rule: 0.02 <= r < 0.10 -> 48, 0.005 <= r < 0.02 -> 24
    const boreGeo = new THREE.CircleGeometry(boreR * M, around(boreR));
    const capGeo = new THREE.CircleGeometry(boreR * 0.9 * M, around(boreR * 0.9));
    this._netCellGeos = [boreGeo, capGeo];
    this._netCellMeshes = [];
    this._netCellCaps = [];
    cells.forEach((cell, i) => {
      const cx = cell.x * M, cy = cell.y * M;
      // Dark bore disc - always visible (an empty cell shows the bore).
      const bore = new THREE.Mesh(boreGeo, boreMat);
      bore.position.set(cx, cy, cellFaceZ + DISC_TOP + 0.001 * M);   // 1 mm proud of the white disc (EO-lens pattern)
      bore.name = `${this.id}-DNetCellHole_${i}`;
      bore.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      this.mesh.add(bore);
      // Pale cap - visible only when the cell is LOADED (inventory-driven).
      const cap = new THREE.Mesh(capGeo, capMat.clone());
      cap.position.set(cx, cy, cellFaceZ + DISC_TOP + 0.0015 * M);   // 1.5 mm proud of the disc (over the bore)
      cap.name = `${this.id}-DNetCellCap_${i}`;
      cap.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      this.mesh.add(cap);
      this._netCellMeshes.push(bore, cap);
      this._netCellCaps.push(cap);
    });
  }

  /** @private - setNetCapacity's redraw: drop the old cells (geometry and the per-cap material freed), build `n`. */
  _rebuildNetCells(n) {
    for (const m of this._netCellMeshes || []) {
      this.mesh.remove(m);
      if (m.material && m.material !== this._netCan.boreMat) m.material.dispose();
    }
    for (const g of this._netCellGeos || []) g.dispose();
    this._buildNetCells(n);
  }

  /**
   * Show exactly `n` loaded Dyneema caps on the mini launcher's front face
   * (empty cells show only the dark bore). Direct (no-emit) helper called from
   * the inventory listener AND initNetInventory(). @private
   * @param {number} n loaded net count
   */
  _syncNetCells(n) {
    if (!this._netCellCaps) return;
    for (let i = 0; i < this._netCellCaps.length; i++) {
      this._netCellCaps[i].visible = i < n;
    }
  }

  /**
   * Line-fibre upgrade (ArmManager.applyTetherUpgrade, the one hub): raise this daughter's net capacity to `n`
   * (DECISIONS §33 row 5: large 2/3/4/5/5, small 4/6/8/10/10). Capacity never drops. The loaded count stays
   * (the new cartridges arrive empty and fill at the stop) unless `fill` is set (the save-load path: every launcher
   * full). Redraws the launcher face for `n` cartridges and emits NET_INVENTORY_CHANGED like any other count change.
   * @param {number} n
   * @param {{fill?: boolean}} [opts]
   */
  setNetCapacity(n, opts = {}) {
    const cap = Math.max(this._netInventoryMax || 0, Math.floor(n) || 0);
    this._netInventoryMax = cap;
    if (opts.fill) this._netInventory = cap;
    else this._netInventory = Math.min(this._netInventory ?? 0, cap);
    if (typeof this._rebuildNetCells === 'function') this._rebuildNetCells(cap);
    this._syncNetCells(this._netInventory);
    eventBus.emit(Events.NET_INVENTORY_CHANGED, {
      source: 'daughter',
      armIndex: this.index ?? null,
      nets: this._netInventory,
      max:  this._netInventoryMax,
    });
  }

  /** Current net count remaining in magazine. */
  getNetInventory() { return this._netInventory; }

  /** Maximum net magazine capacity. */
  getNetInventoryMax() { return this._netInventoryMax; }

  /**
   * Set net inventory directly (persistence restore / shop reload).
   * Delegation 4 (2026-05-31): emits NET_INVENTORY_CHANGED so
   * dependent HUD panels stay in sync when the count is adjusted
   * outside of CaptureNet's own fire/reload path.
   * @param {number} count
   */
  setNetInventory(count) {
    this._netInventory = Math.max(0, Math.min(count, this._netInventoryMax || count));
    eventBus.emit(Events.NET_INVENTORY_CHANGED, {
      source: 'daughter',
      armIndex: this.index ?? null,
      nets: this._netInventory,
      max:  this._netInventoryMax,
    });
  }

  /**
   * Consume one net from the magazine. Returns the remaining count.
   * Delegation 4 (2026-05-31): emits NET_INVENTORY_CHANGED so
   * NetInventoryPanel updates immediately on any decrement point,
   * even if CaptureNet also emits (NetInventoryPanel re-polls
   * idempotently — the second signal is a cheap no-op).
   * @returns {number} remaining inventory (0 if already empty)
   */
  decrementNetInventory() {
    if (this._netInventory > 0) this._netInventory--;
    eventBus.emit(Events.NET_INVENTORY_CHANGED, {
      source: 'daughter',
      armIndex: this.index ?? null,
      nets: this._netInventory,
      max:  this._netInventoryMax,
    });
    return this._netInventory;
  }

  /**
   * Reload magazine to full capacity (shop / between missions).
   * Delegation 4 (2026-05-31): emits NET_INVENTORY_CHANGED so the
   * HUD chip updates when the player purchases a net reload in shop.
   */
  reloadNetInventory() {
    this._netInventory = this._netInventoryMax;
    eventBus.emit(Events.NET_INVENTORY_CHANGED, {
      source: 'daughter',
      armIndex: this.index ?? null,
      nets: this._netInventory,
      max:  this._netInventoryMax,
    });
  }

  /**
   * Dispose of all Three.js resources.
   */
  dispose() {
    // Arms are NOT session singletons (unlike the mother) — unsubscribe the net
    // inventory listener so disposed arms don't leak / react to stale emits.
    if (this._onNetInventoryChanged) {
      eventBus.off(Events.NET_INVENTORY_CHANGED, this._onNetInventoryChanged);
      this._onNetInventoryChanged = null;
    }
    // Wave1: the recoil-kick flash listener is registered only when the event
    // name exists (defensive parallel-task wiring) — mirror that on teardown.
    if (this._onRecoilKick) {
      eventBus.off(Events.ARM_RECOIL_KICK, this._onRecoilKick);
      this._onRecoilKick = null;
    }
    const disposeMat = (m) => {
      if (!m) return;
      // Dispose per-instance textures (e.g. cloned solar-cell map/emissiveMap)
      // — material.dispose() does NOT free attached textures.
      if (m.map && m.map.dispose) m.map.dispose();
      if (m.emissiveMap && m.emissiveMap.dispose && m.emissiveMap !== m.map) m.emissiveMap.dispose();
      m.dispose();
    };
    this.group.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach(disposeMat);
        } else {
          disposeMat(child.material);
        }
      }
    });
    if (this.scene) this.scene.remove(this.group);
  }
}
