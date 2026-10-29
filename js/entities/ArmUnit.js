/**
 * ArmUnit.js — autonomous arm unit (V5 Crossbow ADR satellite): Weaver (large, 6.6 kg) and Spinner (small, 2.1 kg),
 * reels on the mothership.
 * States: DOCKED → LAUNCHING → TRANSIT → APPROACH → NETTING → GRAPPLED → REELING → DOCKING → RELOADING →
 *   TRAWLING → ABLATING → SCANNING → EXPENDED
 * Legacy states (UNDOCKING, HAULING, RETURNING) kept for backward compat.
 * @module entities/ArmUnit
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { TimeAuthority } from '../systems/TimeAuthority.js';
import { DaughterPower, batteryFlatLine } from '../systems/DaughterPower.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { getSolarCellTexture } from '../scene/solarCellTexture.js';
import { makeLightHalo, getRadialGlowTexture } from '../scene/glowSpriteTexture.js';
import { makePlumeFrustum } from '../scene/plumeGeometry.js';
import { computeDaughterPlumeIntensity, DAUGHTER_PLUME } from './armPlumeModel.js';
import { applyDetailLod } from '../scene/detailLodCull.js';
import { AVIONICS_GUNMETAL, AVIONICS_DARK_OPTIC, AVIONICS_THERMAL_WHITE } from '../scene/avionicsMaterials.js';
import { strutLocalDirection, composeDockedArmQuat, bestStrutAlpha, carryDirInto, carryFinalQuatInto, carryRotFrac } from './ArmDockBasis.js';
import { buildNoseRoute, virtualCentreInto } from './NoseRoute.js';
import { isInspectOnlyMass, captureNetSystem, getNetClassForType, computeLeadAim, computeFragRisk, effectiveFragility, presentedWidthForApproach, fitsMouth, strainBandT, seedHerFrameAttitude, applyHerFrameAttitude, clearShipRelativeAttitude, clearRackCell } from './CaptureNet.js';
import { audioSystem } from '../systems/AudioSystem.js';
import { recommendArmTool } from '../systems/ToolRecommender.js';
import { daughterOutOfNetsLine, pressNToLine } from '../systems/netRouting.js';
import { coldGasKgToPool, coldGasPoolToKg } from '../systems/ResourceSystem.js';   // the mother's tank is pool units, the bottle is kg
import { placeName } from '../systems/resupplyWords.js';   // "resupply satellite" with the map on, "resupply stop" without
import { computeToolOdds, makeNetOddsLockCache } from '../systems/ToolOdds.js';
import { gameState } from '../core/GameState.js';
import { daughterDisplayName } from '../core/daughterNames.js';
import { pieceLostLine } from '../systems/PieceClaim.js';
import { bigPieces } from '../systems/BigPieces.js';   // a pending big piece is never digested on the rack
import { DebrisField } from './DebrisField.js';
import { DebrisWireframe } from '../ui/DebrisWireframe.js';
import { netCellLayout } from './netCellLayout.js';
import { heldBagNeckInto, heldBagRadiusScene, DAUGHTER_STAND_M } from './heldBagShape.js';
import { DEG2RAD, RAD2DEG, degToRad, radToDeg, clamp01, clamp, lerp, smoothstep01 } from '../core/MathUtil.js';

/** 1 meter in scene units (1 scene unit = 100 km); the one authoritative scale, pinned in test-CaptureNet-Bookkeeping.js. */
const M = Constants.SCENE_UNITS_PER_METER;
/** Dock-socket ring outer radius, metres (bore Ø51.5 mm + 3 mm wall). */
const SOCKET_RO = 0.02875;

/** World up axis (reused for the HOLDING_CATCH lateral-bias cross product). */
const _WORLD_UP = new THREE.Vector3(0, 1, 0);

// Hot-path temps. Module-level is safe: JS is single-threaded, ArmManager updates arms sequentially, and every temp
// is written and fully consumed within one method call (nothing crosses calls).
const _orientRadial = new THREE.Vector3();
const _orientEye    = new THREE.Vector3();
const _orientMat    = new THREE.Matrix4();
const _orientQuat   = new THREE.Quaternion();
const _tetherDir    = new THREE.Vector3();
const _driftTDelta  = new THREE.Vector3();

// Plume-signal scratch (one _updatePlumes call per arm per frame); same single-call rule as the temps above.
const _plumeSig = {
  state: null, fuel: 0, skManeuverGlowS: 0, approachBrake01: 0,
  arrestFeepActive: false, reelHome: false, recoilFlashS: 0, carryNozzle: null,
};
const _thrTip = new THREE.Vector3();     // carry-leg thread nozzle pick (strut tip, her -Z) scratch
const _thrDir = new THREE.Vector3();
const _thrZ = new THREE.Vector3();
const _driftPDelta  = new THREE.Vector3();
const _driftRaw     = new THREE.Vector3();

/**
 * The rest-to-rest strut move of `d` rad (≥ 0): speed up at `a`, coast at a peak `v`, slow down at `a`.
 * `vMax` caps the peak (the mother's turn pace, AIM_TURN_STRUT_PACE, 15°/s). With `durationS` > the shortest time the
 * move takes, the peak is lowered so it lasts exactly that long; with 0 / less, the move is as short as it can be.
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
const _seatTip      = new THREE.Vector3();
const _seatRes      = new THREE.Vector3();
const _seatQInv     = new THREE.Quaternion();

// Tether tint temps (same single-call rule).
const _tintScratch  = new THREE.Color();
const _tintTarget   = new THREE.Color();

const S = Constants.ARM_STATES;

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
 * Pure tension-fraction → DAUGHTER tether tint mapping, driven by the live reel tension
 * (`tetherTension / tetherBreakStrength`, the scalar _updateReeling computes for snap physics), NOT by distance:
 * distance strain jitters frame-to-frame in the orbital frame and the line strobed red/white (see _updateTether).
 * The tension fraction is stable within a reel and zero outside one.
 *
 * Thresholds are REEL_TENSION_WARNING / REEL_TENSION_CRITICAL, the SAME pair the DockingReticle tension bar and
 * StatusPanel stress readout key off, so bar, status text and line color speak one vocabulary. NET_STRAIN_* is
 * deliberately NOT used: that pair rates payload mass vs NET rating (recoverable net rip), a different failure mode
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

// Shared bridle geometries (created once, reused across all arms)
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

// A rack cell is a place on HER (DECISIONS §28 row 5; Ruling 0, physically real): a parked catch's centre and attitude
// are fixed in HER body frame (+Z out along the strut, Y in the strut's swing plane, X out of it) from the moment its
// cell is assigned, so the ship turning or the strut swinging carries it with her and world up plays no part.
// Cell 0 is CENTRED on her axis and cell 1 stacks on the same axis beyond it (formulas: `rackCellOffsetInto`), so
// cell 1's place depends on what cell 0 holds: when cell 0 empties the remaining catch slides down to cell 0 over
// ARM_HOLD_GLIDE_S (`_pinHeldCatches`).
// ONE computation (`rackCellOffsetInto`) runs when a cell is assigned and stores `d._rackCell`, `d._rackLocalM`,
// `d._qLocalHer` (+ `d._rackArm`, the owner, and `d._rackBelow`, the cell-0 catch cell 1 was stacked on); every
// reader — the pin, the cargo flight's end, the keep-out sphere, the CoM booking — goes through
// `heldSlotAnchorInto`: her position + her attitude · the stored offset.
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
  const cells = Constants.DAUGHTER_CARGO_CELLS ?? 1;
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
 * `nextFreeRackCell` reads it), or null. Cell 1 stacks on what cell 0 holds, so every reader that needs
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
  // A scoop bag is a ball of radius sizeMeter / 2 (heldBagShape.drawnCatchRadiusScene; its `type` is the heaviest member's,
  // whose mesh is not the bag's shape): the support is the radius in every direction, so its nearest point is
  // sizeMeter / 2 off her end plus the net gap - the layout the nose route was certified with (probe --bagitem).
  if (d.isBag === true && d.sizeMeter > 0) return d.sizeMeter / 2;
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
 * ONE computation of a rack cell's offset on her, her frame, metres. Every cell is ON her axis (x = y = 0). With a
 * typed catch and its attitude in her frame (`qLocalHer`) the extents are measured from the drawn mesh; otherwise
 * (a prediction in `suggestCargoArm`, an old save, a typeless rig) the typeless form: extent = sizeMeter/2.
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
export function rackCellOffsetInto(out, sHerM, d, cell, qLocalHer, sizeMeter = 0, below = null, seat = null) {
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
  let z0 = sHerM + sNear + gap;
  // With her real shape (`seat`, from `buildSeatGeo`) and the piece's attitude in her frame, the cell is where a sweep
  // along her +Z first brings the piece within the net gap (minus the margin) of her drawn surface, ring included; the
  // support rule above stays as the upper bound (a plane touching the far corner can only be farther out than the real
  // surfaces).
  if (seat && d && (d.isBag === true || (d.type && qLocalHer))) {
    const zs = seatStandoffM(seat, d, qLocalHer, _rcZp, gap - (Constants.ARM_SEAT_GAP_MARGIN_M ?? 0));
    // A piece over 1 m is also measured against the mother at every hold angle (SeatHullClear, set up by ArmManager);
    // where it would touch, it keeps the support rule above. One verdict per solve, kept on the seat memo.
    if (zs !== null && zs > 0 && (d.isBag === true || zs < z0) && !_seatFoulsMother(seat, d)) z0 = zs;
  }
  return out.set(0, 0, z0);
}

/**
 * Does the seat of `d` (the memo the last solve left) touch the mother at some hold angle? The verdict is made once per
 * solve and kept on the memo (`c.hull`: 1 clear, 0 touches). False (clear) for a bag, a piece up to `SEAT_HULL.OVER_M`,
 * and an arm the manager did not set up.
 */
function _seatFoulsMother(seat, d) {
  const arm = seat && seat.owner;
  const gate = arm && arm._seatHullGate;
  if (!gate || d.isBag === true || !(d.sizeMeter > (Constants.SEAT_HULL?.OVER_M ?? 1.0))) return false;
  const c = d._seatMemo;
  if (!c || c.her !== seat) return false;
  if (c.hull === undefined) c.hull = gate(arm, d, { x: c.qx, y: c.qy, z: c.qz, w: c.qw }, c.s) ? 1 : 0;
  return c.hull === 0;
}

/**
 * The catch's longest mesh axis (unit, in the mesh's own frame): the largest half-extent of its drawn bounding box.
 * The plume volume model lays its box along this axis. `+Z` for a catch with no drawn mesh.
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
 * Cell 1 stacks on what cell 0 holds, so the prediction reads the piece in cell k-1 from `arm.heldCatches`
 * (a mock with no rack lays the cell out as cell 0).
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

// A catch held IN HAND sits tight at her end (DECISIONS §28 row 5). Every frame, the centre distance is her support
// along the axis + the catch's support along -axis + ARM_HOLD_NET_GAP_M, so the nearest DRAWN point is one net gap
// from her end whatever either of them is doing. Measured from the real shapes: her bodyDims box plus every SOLID mesh
// of hers (nozzles, socket, net launcher, antenna ...; NOT plume/halo meshes, sprites or lines: `collectSolidPointsM`)
// and the catch's cached mesh vertices at the scale the renderer uses (`DebrisField.effectiveRenderScale`, the one
// shared reader), in the orientation it is drawn at (tumbleAxis/tumbleAngle). No size factor anywhere, so a change to
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
const _seatQrel = new THREE.Quaternion();
const _seatU = new THREE.Vector3();
const _seatInvQ = new THREE.Quaternion();
const _seatAxisW = new THREE.Vector3();
const _seatSpinQ = new THREE.Quaternion();

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
export function catchHoldStandoffM(bodyQuat, bodyDims, d, dir, gapM, solidPointsM = null, seat = null) {
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
  // The drawn scale, from the game's own reader (what pinCapturedDebris / _updateInstanceTransform draw it at);
  // published on the catch so a test can assert the two never disagree.
  const scaleScene = DebrisField.effectiveRenderScale(d);
  d._holdDrawnScale = scaleScene;
  const catchM = best * (scaleScene / M);
  let total = daughterM + catchM + gapM;
  // Her real shape + the piece's attitude in her frame -> the sweep seat (`seatStandoffM`); the support rule is its
  // upper bound (a bag is a ball: the sweep is the answer).
  if (seat && Number.isFinite(total)) {
    _seatQrel.copy(bodyQuat).invert();
    _seatU.copy(dir).applyQuaternion(_seatQrel);
    if (d.tumbleAxis) _snugQuat.setFromAxisAngle(d.tumbleAxis, d.tumbleAngle || 0); else _snugQuat.identity();
    _seatQrel.multiply(_snugQuat);                       // her frame^-1 x the piece's world attitude
    const zs = seatStandoffM(seat, d, _seatQrel, _seatU, gapM - (Constants.ARM_SEAT_GAP_MARGIN_M ?? 0));
    if (zs !== null && zs > 0 && (d.isBag === true || zs < total)) total = zs;
  }
  return Number.isFinite(total) ? total : null;
}

// The SEAT sweep (DECISIONS §48 row 5): a caught piece sits in her launcher ring, only the net between. Not a
// support-plane rule (a plane touches the far corner; the real surfaces are far apart sideways). Slide the piece along
// the hold axis until its drawn surface first comes within `R` (the net gap minus a margin) of her drawn surface - ring,
// lip, launcher, antenna and all - and stop there. Exact for every contact where a vertex of one side meets a face, edge
// or vertex of the other (the point is swept against each triangle grown by R: two offset planes, three edge cylinders,
// three vertex spheres). It cannot see two long edges crossing with no vertex near; her edges near the seat are
// millimetres long, so the miss is a millimetre or two (measured, test-DaughterSeatRing.js: the gap lands in 2.0-3.2 cm).
// A scoop bag is a ball (heldBagShape): one point swept against the grown triangles, radius r + R.
const _seatGeoCache = new WeakMap();   // root Object3D -> her seat geometry (her shape is built once)

/**
 * Her solid triangles (her frame, METRES; every solid mesh under `root` incl. the seat ring; not plumes/halos), with a
 * bounding sphere per triangle and the unique vertices. Built once per daughter.
 * @param {THREE.Object3D} root
 * @returns {{tris:Float32Array,nTri:number,cen:Float32Array,rad:Float32Array,verts:Float32Array,nVert:number}}
 */
export function buildSeatGeo(root) {
  const cached = _seatGeoCache.get(root);
  if (cached) return cached;
  const out = [];
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();
  root.traverse((o) => {
    if (o === root || !o.isMesh || !o.geometry) return;
    if (/plume/i.test(o.name || '')) return;
    if (o.material && o.material.blending === THREE.AdditiveBlending) return;
    const pos = o.geometry.attributes && o.geometry.attributes.position;
    if (!pos) return;
    const idx = o.geometry.index;
    m.identity();
    for (let p = o; p && p !== root; p = p.parent) { p.updateMatrix(); m.premultiply(p.matrix); }
    const n = Math.floor((idx ? idx.count : pos.count) / 3) * 3;
    for (let i = 0; i < n; i++) {
      const k = idx ? idx.getX(i) : i;
      v.set(pos.getX(k), pos.getY(k), pos.getZ(k)).applyMatrix4(m).multiplyScalar(1 / M);
      out.push(v.x, v.y, v.z);
    }
  });
  const tris = new Float32Array(out);
  const nTri = tris.length / 9;
  const cen = new Float32Array(nTri * 3), rad = new Float32Array(nTri);
  const seen = new Set(), vl = [];
  for (let t = 0; t < nTri; t++) {
    const o = t * 9;
    const cx = (tris[o] + tris[o + 3] + tris[o + 6]) / 3, cy = (tris[o + 1] + tris[o + 4] + tris[o + 7]) / 3, cz = (tris[o + 2] + tris[o + 5] + tris[o + 8]) / 3;
    cen[t * 3] = cx; cen[t * 3 + 1] = cy; cen[t * 3 + 2] = cz;
    let r2 = 0;
    for (let k = 0; k < 3; k++) {
      const dx = tris[o + k * 3] - cx, dy = tris[o + k * 3 + 1] - cy, dz = tris[o + k * 3 + 2] - cz;
      r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
      const key = `${Math.round(tris[o + k * 3] * 1e4)},${Math.round(tris[o + k * 3 + 1] * 1e4)},${Math.round(tris[o + k * 3 + 2] * 1e4)}`;
      if (!seen.has(key)) { seen.add(key); vl.push(tris[o + k * 3], tris[o + k * 3 + 1], tris[o + k * 3 + 2]); }
    }
    rad[t] = Math.sqrt(r2);
  }
  const verts = new Float32Array(vl);
  const geo = { tris, nTri, cen, rad, verts, nVert: verts.length / 3 };
  _seatGeoCache.set(root, geo);
  return geo;
}

const _pieceMeshCache = new WeakMap();   // BufferGeometry -> { tris (9 per tri, mesh units), nTri, verts (unique) }
function _pieceMesh(geo) {
  let pm = _pieceMeshCache.get(geo);
  if (pm) return pm;
  const pos = geo && geo.attributes && geo.attributes.position;
  const idx = geo && geo.index;
  const n = pos ? Math.floor((idx ? idx.count : pos.count) / 3) * 3 : 0;
  const tris = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const k = idx ? idx.getX(i) : i;
    tris[i * 3] = pos.getX(k); tris[i * 3 + 1] = pos.getY(k); tris[i * 3 + 2] = pos.getZ(k);
  }
  let rad2 = 0;                                   // the mesh's farthest point from its own origin (the piece turns about that origin)
  for (let i = 0; i < n; i++) rad2 = Math.max(rad2, tris[i * 3] ** 2 + tris[i * 3 + 1] ** 2 + tris[i * 3 + 2] ** 2);
  pm = { tris, nTri: n / 3, verts: _holdVertices(geo), rad: Math.sqrt(rad2) };
  _pieceMeshCache.set(geo, pm);
  return pm;
}

// Largest s at which the point P + s*w first comes within R of triangle (v0 v1 v2), or -Infinity: P enters the triangle grown by R.
function _sweepGrown(px, py, pz, wx, wy, wz, R, T, o) {
  const ax = T[o], ay = T[o + 1], az = T[o + 2];
  const bx = T[o + 3], by = T[o + 4], bz = T[o + 5];
  const cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];
  let best = -Infinity;
  const e0x = bx - ax, e0y = by - ay, e0z = bz - az;
  const e1x = cx - ax, e1y = cy - ay, e1z = cz - az;
  // faces: the two planes offset by +-R, hit point must project into the triangle
  let nx = e0y * e1z - e0z * e1y, ny = e0z * e1x - e0x * e1z, nz = e0x * e1y - e0y * e1x;
  const nl = Math.hypot(nx, ny, nz);
  if (nl > 1e-12) {
    nx /= nl; ny /= nl; nz /= nl;
    const nw = nx * wx + ny * wy + nz * wz;
    if (Math.abs(nw) > 1e-9) {
      const d00 = e0x * e0x + e0y * e0y + e0z * e0z, d01 = e0x * e1x + e0y * e1y + e0z * e1z, d11 = e1x * e1x + e1y * e1y + e1z * e1z;
      const den = d00 * d11 - d01 * d01;
      const base = nx * (ax - px) + ny * (ay - py) + nz * (az - pz);
      for (let k = -1; k <= 1; k += 2) {
        const s = (base + k * R) / nw;
        if (s <= best) continue;
        const qx = px + s * wx - k * R * nx - ax, qy = py + s * wy - k * R * ny - ay, qz = pz + s * wz - k * R * nz - az;
        const d20 = qx * e0x + qy * e0y + qz * e0z, d21 = qx * e1x + qy * e1y + qz * e1z;
        const bv = (d11 * d20 - d01 * d21) / den, bw = (d00 * d21 - d01 * d20) / den;
        if (bv >= -1e-9 && bw >= -1e-9 && bv + bw <= 1 + 1e-9) best = s;
      }
    }
  }
  // edges: cylinders of radius R about each edge, valid between its ends
  for (let k = 0; k < 3; k++) {
    const sx = k === 0 ? ax : k === 1 ? bx : cx, sy = k === 0 ? ay : k === 1 ? by : cy, sz = k === 0 ? az : k === 1 ? bz : cz;
    const tx = k === 0 ? bx : k === 1 ? cx : ax, ty = k === 0 ? by : k === 1 ? cy : ay, tz = k === 0 ? bz : k === 1 ? cz : az;
    let ex = tx - sx, ey = ty - sy, ez = tz - sz;
    const len = Math.hypot(ex, ey, ez);
    if (len < 1e-12) continue;
    ex /= len; ey /= len; ez /= len;
    const dx = px - sx, dy = py - sy, dz = pz - sz;
    const dpe = dx * ex + dy * ey + dz * ez, wpe = wx * ex + wy * ey + wz * ez;
    const dpx = dx - dpe * ex, dpy = dy - dpe * ey, dpz = dz - dpe * ez;
    const wpx = wx - wpe * ex, wpy = wy - wpe * ey, wpz = wz - wpe * ez;
    const qa = wpx * wpx + wpy * wpy + wpz * wpz;
    if (qa < 1e-12) continue;
    const qb = 2 * (dpx * wpx + dpy * wpy + dpz * wpz), qc = dpx * dpx + dpy * dpy + dpz * dpz - R * R;
    const disc = qb * qb - 4 * qa * qc;
    if (disc < 0) continue;
    const s = (-qb + Math.sqrt(disc)) / (2 * qa);
    if (s <= best) continue;
    const tau = dpe + s * wpe;
    if (tau >= 0 && tau <= len) best = s;
  }
  // vertices: spheres of radius R
  for (let k = 0; k < 3; k++) {
    const dx = px - (k === 0 ? ax : k === 1 ? bx : cx), dy = py - (k === 0 ? ay : k === 1 ? by : cy), dz = pz - (k === 0 ? az : k === 1 ? bz : cz);
    const sb = dx * wx + dy * wy + dz * wz;
    const disc = sb * sb - (dx * dx + dy * dy + dz * dz - R * R);
    if (disc < 0) continue;
    const s = -sb + Math.sqrt(disc);
    if (s > best) best = s;
  }
  return best;
}

// Largest s over the triangles of `T` (bounding spheres `cen`/`rad` pre-filter) for the point P moving along w.
function _sweepPointVsTris(px, py, pz, wx, wy, wz, R, T, nTri, cen, rad, best) {
  for (let t = 0; t < nTri; t++) {
    const cx = cen[t * 3] - px, cy = cen[t * 3 + 1] - py, cz = cen[t * 3 + 2] - pz;
    const al = cx * wx + cy * wy + cz * wz;
    const perp2 = cx * cx + cy * cy + cz * cz - al * al;
    const lim = R + rad[t];
    if (perp2 > lim * lim) continue;
    if (al + lim <= best) continue;                       // the whole triangle's reach is no better than what we have
    const s = _sweepGrown(px, py, pz, wx, wy, wz, R, T, t * 9);
    if (s > best) best = s;
  }
  return best;
}


// A 2-D bucket grid of triangles in the plane perpendicular to the sweep axis (cell 1 cm), each triangle in every cell its
// bounding box grown by R touches: a point on the axis line then needs only the one cell it stands in.
// `clip` (a grid built for the same axis): cover only its cells. The piece's grid is only ever asked for HER vertices,
// which all lie inside her own grid, so a 5 m piece needs the few thousand cells under her end, not a quarter of a million.
function _buildPerpGrid(T, nTri, ux, uy, uz, R, clip = null) {
  // perpendicular basis
  let ax = 1, ay = 0, az = 0;
  if (Math.abs(ux) > 0.8) { ax = 0; ay = 1; }
  let e1x = uy * az - uz * ay, e1y = uz * ax - ux * az, e1z = ux * ay - uy * ax;
  const l1 = Math.hypot(e1x, e1y, e1z); e1x /= l1; e1y /= l1; e1z /= l1;
  const e2x = uy * e1z - uz * e1y, e2y = uz * e1x - ux * e1z, e2z = ux * e1y - uy * e1x;
  const cell = 0.01;
  let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
  const n3 = nTri * 3;
  const A = new Float64Array(n3), B = new Float64Array(n3), H = new Float64Array(n3);
  for (let i = 0; i < n3; i++) {
    const x = T[i * 3], y = T[i * 3 + 1], z = T[i * 3 + 2];
    const a = x * e1x + y * e1y + z * e1z, b = x * e2x + y * e2y + z * e2z;
    A[i] = a; B[i] = b; H[i] = x * ux + y * uy + z * uz;
    if (a < amin) amin = a; if (a > amax) amax = a; if (b < bmin) bmin = b; if (b > bmax) bmax = b;
  }
  const a0 = clip ? clip.a0 : amin - R - 1e-6, b0 = clip ? clip.b0 : bmin - R - 1e-6;
  const nA = clip ? clip.nA : Math.max(1, Math.ceil((amax + R + 1e-6 - a0) / cell)), nB = clip ? clip.nB : Math.max(1, Math.ceil((bmax + R + 1e-6 - b0) / cell));
  const counts = new Int32Array(nA * nB + 1);
  const lo = new Int32Array(nTri * 4);
  for (let t = 0; t < nTri; t++) {
    const i0 = t * 3;
    const ta = Math.min(A[i0], A[i0 + 1], A[i0 + 2]) - R, tb = Math.min(B[i0], B[i0 + 1], B[i0 + 2]) - R;
    const ua = Math.max(A[i0], A[i0 + 1], A[i0 + 2]) + R, ub = Math.max(B[i0], B[i0 + 1], B[i0 + 2]) + R;
    const ca0 = Math.max(0, Math.floor((ta - a0) / cell)), ca1 = Math.min(nA - 1, Math.floor((ua - a0) / cell));
    const cb0 = Math.max(0, Math.floor((tb - b0) / cell)), cb1 = Math.min(nB - 1, Math.floor((ub - b0) / cell));
    lo[t * 4] = ca0; lo[t * 4 + 1] = ca1; lo[t * 4 + 2] = cb0; lo[t * 4 + 3] = cb1;
    for (let ca = ca0; ca <= ca1; ca++) for (let cb = cb0; cb <= cb1; cb++) counts[ca * nB + cb + 1]++;
  }
  for (let i = 0; i < nA * nB; i++) counts[i + 1] += counts[i];
  const list = new Int32Array(counts[nA * nB]);
  const fill = counts.slice(0, nA * nB);
  for (let t = 0; t < nTri; t++) {
    for (let ca = lo[t * 4]; ca <= lo[t * 4 + 1]; ca++) for (let cb = lo[t * 4 + 2]; cb <= lo[t * 4 + 3]; cb++) list[fill[ca * nB + cb]++] = t;
  }
  const hmax = new Float64Array(nTri);                                  // each triangle's highest point along the axis (bounds a pair's reach)
  for (let t = 0; t < nTri; t++) {
    let h = -Infinity;
    for (let k = 0; k < 3; k++) h = Math.max(h, T[(t * 3 + k) * 3] * ux + T[(t * 3 + k) * 3 + 1] * uy + T[(t * 3 + k) * 3 + 2] * uz);
    hmax[t] = h;
  }
  return { e1x, e1y, e1z, e2x, e2y, e2z, a0, b0, cell, nA, nB, start: counts, list, ux, uy, uz, R, A, B, H, hmax, stamp: new Int32Array(nTri), stampN: 0 };
}

// Largest s for the point P moving along w (= +-u of `g`) against the triangles in P's cell of grid `g`.
function _sweepPointGrid(g, px, py, pz, wx, wy, wz, R, T, best) {
  const a = px * g.e1x + py * g.e1y + pz * g.e1z, b = px * g.e2x + py * g.e2y + pz * g.e2z;
  const ca = Math.floor((a - g.a0) / g.cell), cb = Math.floor((b - g.b0) / g.cell);
  if (ca < 0 || cb < 0 || ca >= g.nA || cb >= g.nB) return best;
  const c = ca * g.nB + cb;
  for (let k = g.start[c]; k < g.start[c + 1]; k++) {
    const s = _sweepGrown(px, py, pz, wx, wy, wz, R, T, g.list[k] * 9);
    if (s > best) best = s;
  }
  return best;
}

// The seat-solve budget. `_seatFrame` advances when a daughter updates twice before every other one has (so, one pass of
// the daughters' updates = one frame), `_seatClockS` is the sum of their frame times; both only move inside `ArmUnit.update`.
let _seatMetered = false;
let _seatFrame = 0;
let _seatSolvedFrame = -1;
let _seatClockS = 0;
const _seatSeen = new Set();
/** Counters for probes and tests: exact solves run, worst single solve (ms), solves that were a second in the same frame. */
export const seatSolveStats = { solves: 0, worstMs: 0, frameRepeat: 0, deferred: 0 };
// A caller that asks again every frame (the net reel) sets this so a catch's FIRST solve waits for a frame with no other solve in it.
let _seatDeferFirst = false;
/** Marks one daughter's update frame for the budget (`ArmUnit.update` does it); exported for tests that pin a piece without an update. */
export function seatFrameBegin(arm, dt) { _seatFrameBegin(arm, dt); }
function _seatFrameBegin(arm, dt) {
  if (_seatSeen.has(arm)) { _seatSeen.clear(); _seatFrame++; _seatClockS += dt > 0 ? dt : 0; }
  _seatSeen.add(arm);
  _seatMetered = true;
}
const _seatPar = new Float64Array(9);
let _sv = { cap: 0, pv: null, hp: null, ord: null, pt: null, pcen: null, prad: null, pA: null, pB: null, pH: null };
function _seatScratch(nVert, nTri) {
  if (_sv.cap < nVert || !_sv.pt || _sv.pt.length < nTri * 9) {
    const cv = Math.max(nVert, _sv.cap, 64), ct = Math.max(nTri, 64, _sv.pt ? _sv.pt.length / 9 : 0);
    _sv = { cap: cv, pv: new Float64Array(cv * 3), hp: new Float64Array(cv), ord: new Uint32Array(cv),
      pt: new Float64Array(ct * 9), pcen: new Float64Array(ct * 3), prad: new Float64Array(ct),
      pA: new Float64Array(ct * 3), pB: new Float64Array(ct * 3), pH: new Float64Array(ct * 3) };
  }
  return _sv;
}

/**
 * The distance from her centre to a catch's centre along the unit hold axis `u` (her frame) at which the catch's
 * DRAWN surface is first within `R` of her drawn surface. Pure geometry, metres.
 * @param {object} her `buildSeatGeo` result
 * @param {object} d the catch (type, id, sizeMeter, isBag, ...; drawn scale via `DebrisField.effectiveRenderScale`)
 * @param {THREE.Quaternion|null} qRel the catch's attitude in HER frame (ignored for a bag: a ball)
 * @param {THREE.Vector3} u unit hold axis, her frame
 * @param {number} R surface-to-surface target, metres
 * @returns {number|null} metres, or null when there is nothing to sweep (no mesh) or no contact was found
 */
export function seatStandoffM(her, d, qRel, u, R) {
  if (!her || !d || !(her.nTri > 0)) return null;
  const ux = u.x, uy = u.y, uz = u.z;
  const bag = d.isBag === true && d.sizeMeter > 0;
  if (!bag && (!d.type || !qRel)) return null;
  // a piece bigger than ARM_SEAT_MAX_SIZE_M keeps the support rule (the cap is Infinity: every piece seats)
  if (!bag && d.sizeMeter > (Constants.ARM_SEAT_MAX_SIZE_M ?? Infinity)) return null;
  // the same inputs again (a piece at rest on her) answer from the last solve: a solve is a few ms, the pin asks every frame
  const sc = bag ? d.sizeMeter / 2 : DebrisField.effectiveRenderScale(d) / M;
  const c = d._seatMemo;
  const qx0 = bag ? 0 : qRel.x, qy0 = bag ? 0 : qRel.y, qz0 = bag ? 0 : qRel.z, qw0 = bag ? 1 : qRel.w;
  if (c && c.her === her && c.type === d.type && c.id === d.id && c.bag === bag && Math.abs(c.sc - sc) < 1e-9 && Math.abs(c.R - R) < 1e-12
      && Math.abs(c.ux - ux) < 1e-7 && Math.abs(c.uy - uy) < 1e-7 && Math.abs(c.uz - uz) < 1e-7
      && Math.abs(c.qx - qx0) < 1e-7 && Math.abs(c.qy - qy0) < 1e-7 && Math.abs(c.qz - qz0) < 1e-7 && Math.abs(c.qw - qw0) < 1e-7) return c.s;
  // A piece slowly turning on her (the carried spin, the spin-down at the seat) asks every frame, and a solve is 2-80 ms
  // (measured, 4,164 triangles of hers, one core). Budget, while a daughter's update is running (`_seatMetered`): the
  // last answer stands while the piece has turned under SEAT_RESOLVE_DEG (5) in her frame and the axis moved under 0.02
  // - no age expiry; a bigger turn is re-solved at most once per SEAT_RESOLVE_MIN_S (0.5 s) per catch, and never twice
  // in one frame across all daughters (a solve refused by the budget answers with the last one, which is renewed the
  // moment the budget allows). The FIRST solve of a catch, and a changed axis (the glide swings it) are not held back by
  // the 0.5 s, only by the frame cap. Outside an update (tests, tools) only an identical question is answered from memory.
  const same = !!c && c.her === her && c.type === d.type && c.id === d.id && c.bag === bag && Math.abs(c.sc - sc) < 1e-9 && Math.abs(c.R - R) < 1e-12;
  if (_seatMetered && same && !bag && d.sizeMeter > (Constants.SEAT_TURN_GUARD_OVER_M ?? 1.0)) {
    // A piece over 1 m turned 5 degrees about a lever of 2-2.5 m has moved 20 cm, and where it first touches her is not
    // a smooth function of the turn (a flat side swings round: measured 0.2-4.7 times the lever), so for these the last
    // answer is not held through a turn. The piece is answered `null` (the callers' support rule, which cannot overlap)
    // while it is turning, and is solved exactly once it is still again (the spin payoff's end drops the memo: that is
    // its solve).
    const g = _seatTurnGuard(c, ux, uy, uz, qx0, qy0, qz0, qw0);
    if (g.lever <= (Constants.SEAT_TURN_FREE_M ?? 0.002)) return c.s;
    const slow = g.step <= (Constants.SEAT_TURN_FAST_M ?? 0.001);
    if (!slow) return null;                                                          // turning: the support rule, no solve
    const blocked = _seatSolvedFrame === _seatFrame || _seatClockS - c.t < (Constants.SEAT_RESOLVE_MIN_S ?? 0.5);
    if (blocked) return g.lever <= (Constants.SEAT_TURN_SLOW_MAX_M ?? 0.04) ? c.s + g.lever : null;   // creeping: out by what it has moved
  } else if (_seatMetered && same) {
    const axisMoved = Math.hypot(c.ux - ux, c.uy - uy, c.uz - uz) >= 0.02;
    const cosHalf = Math.cos(degToRad(0.5 * (Constants.SEAT_RESOLVE_DEG ?? 5)));
    const turned = Math.abs(c.qx * qx0 + c.qy * qy0 + c.qz * qz0 + c.qw * qw0) < cosHalf;
    if (!axisMoved && !turned) return c.s;
    if (_seatSolvedFrame === _seatFrame) return c.s;                                  // one solve a frame, all daughters
    if (!axisMoved && _seatClockS - c.t < (Constants.SEAT_RESOLVE_MIN_S ?? 0.5)) return c.s;
  }
  // The first solve of a catch obeys the one-per-frame cap too, for a caller that asks again next frame (null = support rule now)
  if (_seatMetered && _seatDeferFirst && !same && _seatSolvedFrame === _seatFrame) { seatSolveStats.deferred++; return null; }
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const s = _seatSolve(her, d, bag, qRel, ux, uy, uz, R, sc);
  const rad = bag ? 0 : sc * (_pieceMesh(DebrisWireframe.getGeometry(d.type, d.id)).rad || 0);
  d._seatMemo = { her, type: d.type, id: d.id, bag, sc, R, ux, uy, uz, qx: qx0, qy: qy0, qz: qz0, qw: qw0, s, t: _seatClockS, rad,
    lqx: qx0, lqy: qy0, lqz: qz0, lqw: qw0, lux: ux, luy: uy, luz: uz,
    mqx: qx0, mqy: qy0, mqz: qz0, mqw: qw0, mux: ux, muy: uy, muz: uz, lf: _seatFrame };
  const ms = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
  seatSolveStats.solves++;
  if (_seatSolvedFrame === _seatFrame) seatSolveStats.frameRepeat++;   // a second solve in one frame (the glide's two asks, tests)
  _seatSolvedFrame = _seatFrame;
  if (ms > seatSolveStats.worstMs) seatSolveStats.worstMs = ms;
  return s;
}

const _seatGuardOut = { lever: 0, step: 0 };
/**
 * How far a piece's points can have moved since the last solve (`lever`) and in the last frame (`step`), metres: its
 * radius times the chord of the turn, plus the axis swing times the distance. `step` is per FRAME, not per call: the
 * reference (`lq*`, `lu*`) is the attitude the piece had when the previous frame ended, and stays put while the frame
 * lasts, so a second ask in the same frame (the glide's two asks, a pin that runs twice) measures the same frame's
 * movement again and cannot read as "creeping". The newest attitude is kept in `mq*`, `mu*` and becomes the reference
 * when the frame counter moves on.
 */
function _seatTurnGuard(c, ux, uy, uz, qx, qy, qz, qw) {
  const chordOf = (dot) => 2 * Math.sqrt(Math.max(0, 1 - Math.min(1, dot) ** 2));
  if (c.lf !== _seatFrame) {                 // a new frame: where the piece stood at the end of the last one is the reference
    c.lqx = c.mqx; c.lqy = c.mqy; c.lqz = c.mqz; c.lqw = c.mqw; c.lux = c.mux; c.luy = c.muy; c.luz = c.muz;
    c.lf = _seatFrame;
  }
  const far = Math.abs(c.s);
  const lever = c.rad * chordOf(Math.abs(c.qx * qx + c.qy * qy + c.qz * qz + c.qw * qw)) + far * Math.hypot(c.ux - ux, c.uy - uy, c.uz - uz);
  const step = c.rad * chordOf(Math.abs(c.lqx * qx + c.lqy * qy + c.lqz * qz + c.lqw * qw)) + far * Math.hypot(c.lux - ux, c.luy - uy, c.luz - uz);
  c.mqx = qx; c.mqy = qy; c.mqz = qz; c.mqw = qw; c.mux = ux; c.muy = uy; c.muz = uz;
  _seatGuardOut.lever = lever; _seatGuardOut.step = step;
  return _seatGuardOut;
}

function _seatSolve(her, d, bag, qRel, ux, uy, uz, R, sc) {
  if (bag) {
    const s = _sweepPointVsTris(0, 0, 0, ux, uy, uz, sc + R, her.tris, her.nTri, her.cen, her.rad, -Infinity);
    return Number.isFinite(s) ? s : null;
  }
  const pm = _pieceMesh(DebrisWireframe.getGeometry(d.type, d.id));
  if (!(pm.nTri > 0)) return null;
  const nV = pm.verts.length / 3, nT = pm.nTri;
  const S = _seatScratch(nV, nT);
  const qx = qRel.x, qy = qRel.y, qz = qRel.z, qw = qRel.w;
  const r00 = 1 - 2 * (qy * qy + qz * qz), r01 = 2 * (qx * qy - qz * qw), r02 = 2 * (qx * qz + qy * qw);
  const r10 = 2 * (qx * qy + qz * qw), r11 = 1 - 2 * (qx * qx + qz * qz), r12 = 2 * (qy * qz - qx * qw);
  const r20 = 2 * (qx * qz - qy * qw), r21 = 2 * (qy * qz + qx * qw), r22 = 1 - 2 * (qx * qx + qy * qy);
  const pv = S.pv, hp = S.hp, ord = S.ord, pt = S.pt;
  let pmin = Infinity;
  for (let i = 0; i < nV; i++) {
    const x = pm.verts[i * 3] * sc, y = pm.verts[i * 3 + 1] * sc, z = pm.verts[i * 3 + 2] * sc;
    const X = r00 * x + r01 * y + r02 * z, Y = r10 * x + r11 * y + r12 * z, Z = r20 * x + r21 * y + r22 * z;
    pv[i * 3] = X; pv[i * 3 + 1] = Y; pv[i * 3 + 2] = Z;
    const h = X * ux + Y * uy + Z * uz;
    hp[i] = h; ord[i] = i;
    if (h < pmin) pmin = h;
  }
  for (let i = 0; i < nT * 3; i++) {
    const x = pm.tris[i * 3] * sc, y = pm.tris[i * 3 + 1] * sc, z = pm.tris[i * 3 + 2] * sc;
    pt[i * 3] = r00 * x + r01 * y + r02 * z; pt[i * 3 + 1] = r10 * x + r11 * y + r12 * z; pt[i * 3 + 2] = r20 * x + r21 * y + r22 * z;
  }
  const pcen = S.pcen, prad = S.prad;
  for (let t = 0; t < nT; t++) {
    const o = t * 9;
    const cx = (pt[o] + pt[o + 3] + pt[o + 6]) / 3, cy = (pt[o + 1] + pt[o + 4] + pt[o + 7]) / 3, cz = (pt[o + 2] + pt[o + 5] + pt[o + 8]) / 3;
    pcen[t * 3] = cx; pcen[t * 3 + 1] = cy; pcen[t * 3 + 2] = cz;
    let r2 = 0;
    for (let k = 0; k < 3; k++) {
      const dx = pt[o + k * 3] - cx, dy = pt[o + k * 3 + 1] - cy, dz = pt[o + k * 3 + 2] - cz;
      r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
    }
    prad[t] = Math.sqrt(r2);
  }
  // her top along u
  let htop = -Infinity;
  const hv = her.verts;
  for (let i = 0; i < her.nVert; i++) {
    const h = hv[i * 3] * ux + hv[i * 3 + 1] * uy + hv[i * 3 + 2] * uz;
    if (h > htop) htop = h;
  }
  // (a) the catch's lowest vertices (nearest her) against her triangles, lowest first so the bound bites early
  const ordV = ord.subarray(0, nV);
  ordV.sort((a, b) => hp[a] - hp[b]);
  let best = -Infinity;
  let hg = her._grid;                                       // her triangles bucketed for this axis (cached: the axis is usually her +Z)
  if (!hg || Math.abs(hg.ux - ux) > 1e-9 || Math.abs(hg.uy - uy) > 1e-9 || Math.abs(hg.uz - uz) > 1e-9 || hg.R !== R) hg = her._grid = _buildPerpGrid(her.tris, her.nTri, ux, uy, uz, R);
  for (let k = 0; k < nV; k++) {
    const i = ordV[k];
    if (htop + R - hp[i] <= best) break;
    best = _sweepPointGrid(hg, pv[i * 3], pv[i * 3 + 1], pv[i * 3 + 2], ux, uy, uz, R, her.tris, best);
  }
  // (b) her vertices against the catch's triangles (those that could still beat `best`)
  let pg = null;
  for (let i = 0; i < her.nVert; i++) {
    const hx = hv[i * 3], hy = hv[i * 3 + 1], hz = hv[i * 3 + 2];
    if (hx * ux + hy * uy + hz * uz - pmin + R <= best) continue;
    if (!pg) pg = _buildPerpGrid(pt, nT, ux, uy, uz, R, hg);
    best = _sweepPointGrid(pg, hx, hy, hz, -ux, -uy, -uz, R, pt, best);
  }
  // (c) edge against edge: two segments, one sliding along the axis, first come within R. The set of offsets between a point of one
  // edge and a point of the other is a parallelogram; the sliding edge pair touches when the axis point (the origin, moving along u)
  // first comes within R of it, which is two triangles through the same routine. Only the pairs of triangles that overlap when seen
  // along the axis AND could still reach farther than `best` are tried (hers are bucketed in `hg`).
  const g = hg, par = _seatPar, pA = S.pA, pB = S.pB, pH = S.pH, hA = g.A, hB = g.B, hH = g.H;       // pA/pB, hA/hB: each vertex's place in the grid's plane
  for (let t = 0; t < nT; t++) {
    const o = t * 9;
    let hmin = Infinity, a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const x = pt[o + k * 3], y = pt[o + k * 3 + 1], z = pt[o + k * 3 + 2];
      const h = x * ux + y * uy + z * uz; if (h < hmin) hmin = h;
      const a = x * g.e1x + y * g.e1y + z * g.e1z, b = x * g.e2x + y * g.e2y + z * g.e2z;
      pA[t * 3 + k] = a; pB[t * 3 + k] = b; pH[t * 3 + k] = h;
      if (a < a0) a0 = a; if (a > a1) a1 = a; if (b < b0) b0 = b; if (b > b1) b1 = b;
    }
    if (htop + R - hmin <= best) continue;
    const ca0 = Math.max(0, Math.floor((a0 - g.a0) / g.cell)), ca1 = Math.min(g.nA - 1, Math.floor((a1 - g.a0) / g.cell));
    const cb0 = Math.max(0, Math.floor((b0 - g.b0) / g.cell)), cb1 = Math.min(g.nB - 1, Math.floor((b1 - g.b0) / g.cell));
    const stamp = ++g.stampN;
    for (let ca = ca0; ca <= ca1; ca++) for (let cb = cb0; cb <= cb1; cb++) {
      const c = ca * g.nB + cb;
      for (let k = g.start[c]; k < g.start[c + 1]; k++) {
        const ht = g.list[k];
        if (g.stamp[ht] === stamp) continue;
        g.stamp[ht] = stamp;
        if (g.hmax[ht] + R - hmin <= best) continue;
        const ho = ht * 9;
        for (let i = 0; i < 3; i++) {
          const i2 = (i + 1) % 3;
          const hax = her.tris[ho + i * 3], hay = her.tris[ho + i * 3 + 1], haz = her.tris[ho + i * 3 + 2];
          const ehx = her.tris[ho + i2 * 3] - hax, ehy = her.tris[ho + i2 * 3 + 1] - hay, ehz = her.tris[ho + i2 * 3 + 2] - haz;
          // The pair's parallelogram can only touch the axis line if its shadow along the axis comes within R of the
          // origin, so two cheap tests on the shadow's box (her edge's and the piece edge's ends in the grid's plane)
          // drop most of the 9 edge pairs of a triangle pair before any sweep; same answer, a fraction of the sweeps (measured, tmp/seat-time.mjs).
          const ha1 = hA[ht * 3 + i], hb1 = hB[ht * 3 + i], ha2 = hA[ht * 3 + i2], hb2 = hB[ht * 3 + i2];
          const hhTop = Math.max(hH[ht * 3 + i], hH[ht * 3 + i2]) + R;             // her edge's highest point: no pair of this edge reaches past (top - the piece edge's lowest)
          if (hhTop - hmin <= best) continue;
          for (let j = 0; j < 3; j++) {
            const j2 = (j + 1) % 3;
            if (hhTop - Math.min(pH[t * 3 + j], pH[t * 3 + j2]) <= best) continue;
            {
              const pa1 = pA[t * 3 + j], pb1 = pB[t * 3 + j], pa2 = pA[t * 3 + j2], pb2 = pB[t * 3 + j2];
              // offsets her end - piece end: the box of the four corners, per axis
              const d1 = ha1 - pa1, d2 = ha1 - pa2, d3 = ha2 - pa1, d4 = ha2 - pa2;
              if (Math.min(d1, d2, d3, d4) > R || Math.max(d1, d2, d3, d4) < -R) continue;
              const f1 = hb1 - pb1, f2 = hb1 - pb2, f3 = hb2 - pb1, f4 = hb2 - pb2;
              if (Math.min(f1, f2, f3, f4) > R || Math.max(f1, f2, f3, f4) < -R) continue;
            }
            const pax = pt[o + j * 3], pay = pt[o + j * 3 + 1], paz = pt[o + j * 3 + 2];
            const epx = pt[o + j2 * 3] - pax, epy = pt[o + j2 * 3 + 1] - pay, epz = pt[o + j2 * 3 + 2] - paz;
            const Ax = hax - pax, Ay = hay - pay, Az = haz - paz;          // parallelogram: A, A+eh, A+eh-ep, A-ep
            par[0] = Ax; par[1] = Ay; par[2] = Az;
            par[3] = Ax + ehx; par[4] = Ay + ehy; par[5] = Az + ehz;
            par[6] = Ax + ehx - epx; par[7] = Ay + ehy - epy; par[8] = Az + ehz - epz;
            let s = _sweepGrown(0, 0, 0, ux, uy, uz, R, par, 0);
            if (s > best) best = s;
            par[3] = par[6]; par[4] = par[7]; par[5] = par[8];
            par[6] = Ax - epx; par[7] = Ay - epy; par[8] = Az - epz;
            s = _sweepGrown(0, 0, 0, ux, uy, uz, R, par, 0);
            if (s > best) best = s;
          }
        }
      }
    }
  }
  return Number.isFinite(best) ? best : null;
}

let _ringSeed = 0x1B873593;               // the ring's private uuid stream (see its build)
// rack scratch (the repo's no-per-frame-allocation idiom)
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
const _gdEnd = new THREE.Vector3();
// reel-home scratch
const _rhV1 = new THREE.Vector3();
const _rhV2 = new THREE.Vector3();
const _rhV3 = new THREE.Vector3();
let _reelSeqCounter = 0;                 // the order reels began in, across all daughters
const _failTip = new THREE.Vector3();   // her strut tip, world, for the 200 m rule
const _inspTip = new THREE.Vector3();   // her strut tip, world, for the inspection arc's tether clearance
const _rhV4 = new THREE.Vector3();
const _rhV5 = new THREE.Vector3();
const _rhQ1 = new THREE.Quaternion();
const _rhQ2 = new THREE.Quaternion();
const _rhM1 = new THREE.Matrix4();
const _rhTailQuat = new THREE.Quaternion();
// carry scratch
const _carryLocal = new THREE.Vector3();
const _carryC = new THREE.Vector3();
const _carryF = new THREE.Vector3();
const _carryV = new THREE.Vector3();
const _carryDir = new THREE.Vector3();
const _carryQ = new THREE.Quaternion();
const _idQuat = new THREE.Quaternion();
const _carryCL = new THREE.Vector3();          // the delivered catch's centre in her frame (scene units)
const _carryU0 = new THREE.Vector3();          // catch -> her centre, ship frame
const _carryD2 = new THREE.Vector3();          // the direction her body trails along at the seat
const _carryQi = new THREE.Quaternion();       // scratch inverse
const _carryHq = {};                           // the receiving tip's hinge frame (TipCargo.hingeQuatShipInto)
const _noseP = new THREE.Vector3();            // nose scratch: her centre on the route, ship frame, metres
const _noseQ = new THREE.Quaternion();
const _noseC = new THREE.Vector3();            // the catch's centre, ship frame, metres

/**
 * The angle the mother must still turn about her strut's RADIAL axis to bring a point into the strut's swing plane.
 * The point is in the ship's frame, measured from the ship's CENTRE (px, py, pz; any one unit): the turn's axis runs
 * through the centre, not through the strut hinge (which hangs ~1 m off it), so the direction hinge -> her is not her
 * lever on it and goes wrong near the strut. Turning the ship by θ about the radial axis moves her tangential
 * coordinate (across the plane) to pt·cosθ + pz·sinθ, which is zero at tanθ = −pt/pz. The smaller of the two such turns
 * (the other flips her to the far side of the axis). pz near 0 (she is level with the axis) means no turn about this
 * axis can help: ±90°, which the caller reads as "out of reach".
 * @param {number} px @param {number} py @param {number} pz
 * @param {number} az — the strut's azimuth, rad
 * @returns {number} rad in (−π/2, π/2]; positive = right-handed about the radial axis (cos az, sin az, 0)
 */
export function planeTurnLeftRad(px, py, pz, az) {
  const pt = -px * Math.sin(az) + py * Math.cos(az);
  let th = Math.atan2(-pt, pz);
  if (th > Math.PI / 2) th -= Math.PI; else if (th <= -Math.PI / 2) th += Math.PI;
  return th;
}

// Capture-torque settle: pure physics (exported for headless tests); derivation in Constants.CAPTURE_TORQUE_SETTLE.

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
  return clamp01(((rateDegS || 0) - gate) / (rated - gate));
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
      // Physical mass for ALL dynamics (manual-thrust accel, capture combined mass, recoil residual, deorbit ΔV): the V5
      // figures (6.6/2.1 kg), matching crossbow launch, CoM and recoil-cancel math. NOT the legacy
      // Constants.WEAVER_MASS/SPINNER_MASS (pre-V5): they mis-size recoil compensation by ~67%.
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
      // The tank as total Δv — the SSOT for impulse-priced TRANSIT/APPROACH fuel.
      totalDeltaV: Constants.ARM_TOTAL_DELTAV,
    };

    // --- Runtime state ---
    this.fuel = 100;                        // 0–100 percentage
    this.coldGasKg = this._coldGasBottleKg(); // her cold-gas bottle, kg (starts full; refilled from the mother's coldGas while docked)
    this.power = new DaughterPower({ type });   // her battery and heat (DECISIONS §53 row 3); billed by markEngine()/markGas()/shot() + _updateDaughterPower
    this._adriftCause = null;                 // why she is ADRIFT: 'fuel' (spent ion fuel, today's) or 'battery' (flat pack)
    this._indiumSwapT = -1;                   // game seconds into a docked ion-fuel cartridge swap; < 0 = none running
    this.tetherLength = 0;                  // current deployed length in meters
    this.target = null;
    this.capturedDebris = null;             // debris hauled back (the in-hand scalar)
    this.heldCatches = [];                  // the parked cargo rack (HOLDING_CATCH only)
    this.stateTimer = 0;
    this.captures = 0;
    this._startingDistance = 0;             // distance to target at transit start (for approach beep fraction)
    this.position = new THREE.Vector3();    // world position
    this.velocity = new THREE.Vector3();    // world velocity

    // Tether detach state
    this.isDetached = false;
    this._detachFuelWarning25 = false;
    this._detachFuelWarning10 = false;

    // Pre-allocated temporary vectors for hot-loop methods
    this._tmpVec = new THREE.Vector3();

    // Cached parent-ship world quaternion — refreshed each frame by _updateDocked(). deploy*() methods (called
    // externally while DOCKED) need it to compute a world-space deploy direction from the LOCAL dockOffset.
    /** @type {THREE.Quaternion|null} */
    this._lastParentQuat = null;
    this._frameParentQuat = null;   // the mother's orientation of her last out-frame (set in _updateTether)

    /** @type {THREE.Vector3|null} Previous frame's parent position — for orbital frame correction */
    this._prevParentPos = null;

    /** @type {THREE.Vector3|null} THIS frame's parent position (set at the top of `update`) */
    this._frameParentPos = null;

    /** @type {THREE.Vector3|null} Previous frame's target scene position — for orbital drift correction */
    this._prevTargetScenePos = null;

    // Manual pilot mode (ARM PILOT)
    this._manualMode = false;
    this._manualCapture = false;
    this._fuelAtDeploy = 100;    // Track fuel at deployment for efficiency scoring
    this._autoFailChance = 0;    // Set by external code to trigger tutorial auto-failure

    this._nearbyDebris = [];               // injected by ArmManager for proximity checks

    // Web shot state
    this._webShotCooldown = 0;             // seconds remaining before next shot
    this._webShotTarget = null;
    this._webShotPrevState = S.DOCKED;     // state to return to after shot
    this._webShotOrigin = new THREE.Vector3();

    // Trawling mode state
    this._trawlingMode = false;
    this._trawlDirection = null;
    this._trawlTimer = 0;

    // ── V5 Crossbow state ──
    this.springTier = 0;                    // Index into SPRING_TIERS
    this.tetherTier = 0;                    // Index into TETHER_TIERS
    this.springCharged = true;
    this.reloadProgress = 0;               // 0..1 reload completion
    this.reloadDuration = 0;               // Calculated reload time for current speed
    // Clamped at birth: selected must equal fired from the first frame (min(10, T1 ceiling 7.1)).
    this.launchSpeed = Math.min(CROSSBOW_LAUNCH_SPEED_DEFAULT, SPRING_TIERS[0].maxSpeed);
    this.launchDirection = null;
    this._impulseDvAccum = 0;              // Σ|dvCmd| (m/s) the autopilot applied this frame — impulse fuel

    // V5 Tether state
    this.tetherTension = 0;                // Current tension in Newtons
    // The live tether length is config.tetherMax (deploy gate, tether-limit recall, position clamps), which
    // setTetherTier writes; TETHER_TIERS[].maxLength is not mirrored here.
    this.tetherBreakStrength = TETHER_TIERS[0].breakStrength;
    this.reeling = false;
    this._tetherCreakCooldown = 0;         // s — rate-limit countdown for the daughter TETHER_TENSION creak (_updateReeling)
    this._tetherSevered = false;           // True after a tether SNAP (hides line, drifts)
    this._severedCatch = null;             // debris still pinned to this arm after a tether snap
    this._severedDriftS = 0;               // s drifting since the snap (bounds the pin)
    this._netRatedMass = 0;                // kg — net's rated capture mass (set in initNetInventory)
    this._netDiameter = 0;                 // m — net mouth diameter (set in initNetInventory)

    // Daughter multi-tool. Static-by-class toolset, read once on construction. selectedTool is the verb F
    // dispatches; it is (re)defaulted to the recommended tool whenever the daughter enters STATION_KEEP.
    // The live odds strip reads _toolOdds.
    this.toolset = (Constants.DAUGHTER_TOOLSETS && Constants.DAUGHTER_TOOLSETS[type])
      ? Constants.DAUGHTER_TOOLSETS[type].slice()
      : ['NET'];
    this.selectedTool = 'NET';
    this._captureToolKind = 'NET';         // which verb actually secured the live catch
    // Live tool odds: refreshed at TOOL_ODDS.REFRESH_HZ during STATION_KEEP so de-spinning / closing in reads as a
    // live count-up on the reticle odds strip.
    this._toolOdds = null;                 // { NET: {p, blocker, hint}, ... }
    this._toolOddsFragRisk = 0;            // pre-fire FRAG % for the ⚠ chip
    this._toolOddsTimer = 0;
    // Reel boost
    this._boostReelHeld = false;
    this._boostReel = false;               // boost ACTIVE this frame (REELING + payload)
    // Eddy-current detumble (MAGNET secondary)
    this._eddyActive = false;
    this._eddyTarget = null;               // debris being damped (for flag cleanup)
    // Magnetic-grapple sub-state machine: null | 'ENERGIZING' | 'CLOSING' | 'GRIP'
    this._magPhase = null;
    this._magTimer = 0;
    // Tool-closing CA exemption: debris id held under AUTOPILOT_TARGET_LOCK while
    // the daughter deliberately closes to contact (magnet / gripper / pad). Released
    // centrally on ANY exit from the closing state (_transitionTo) so it can't leak.
    this._toolLockedDebrisId = null;
    // Gripper-grapple sub-FSM: null | 'EXTEND' | 'SEEK' | 'CLOSE'
    this._gripPhase = null;
    this._gripTimer = 0;
    // Pad-contact sub-FSM: null | 'APPROACH' | 'CONTACT'
    this._padPhase = null;
    this._padTimer = 0;
    this._padResolvedMode = null;
    this._padOffset = null;   // scene units — her offset from the piece while the pad closes (rides with it)
    // Per-arm UV-cure magazine (finite; runtime-only, not persisted).
    this._padUvCureDosesRemaining = (Constants.PAD_CONTACT && Constants.PAD_CONTACT.UV_CURE_DOSES_Y0) || 10;

    // V5 Ablation state
    this.ablationTarget = null;
    this.ablationTimer = 0;

    // FEEP dual-metal system
    this._currentMetal = 'indium';
    this._alternateMetal = null;       // second slot (unlocked via Forge)
    this._metalIsp = Constants.ION_THRUSTER.ISP_DEFAULT;

    // STATION_KEEP state. _orbitTheta/_orbitPhi are interpreted in a frozen *entry frame* captured at SK entry
    // (see _initSkFrame): θ is yaw around the camera-up axis (Earth-radial at debris), φ is delta-pitch around the
    // camera-right axis. Both are 0 at entry and clamped within THETA_LIMIT_DEG / (MAX_LATITUDE − TETHER_SAFETY_MARGIN).
    this._orbitTheta = 0;                   // yaw delta in entry frame (rad)
    this._orbitPhi = 0;                     // pitch delta in entry frame (rad)
    /** @private Frozen entry frame axes (set on SK entry, cleared on exit). */
    this._skPolarAxis = null;               // THREE.Vector3 — Earth-radial at debris
    this._skEquator0 = null;                // THREE.Vector3 — initial debris→arm dir
    this._skRightVec = null;                // THREE.Vector3 — equator0 × polar (screen-right)
    this._skPitch0 = 0;                     // rad — entry pitch (so θ=φ=0 reproduces arrival pose)
    /** @private Auto-return state (set during STATION_KEEP) */
    this._skIdleS = 0;                      // s — accumulated time since last arrow input
    this._standoffR = 5;                    // current standoff radius in metres
    this._standoffTargetR = 5;              // m — radius the settle-in eases toward
    this._standoffSettling = false;         // true while easing entry distance → nominal standoff
    this._thetaRate = 0;
    this._phiRate = 0;
    this._radiusRate = 0;
    this._rMin = Constants.STATION_KEEP.MIN_STANDOFF;
    this._rMax = Constants.STATION_KEEP.MAX_STANDOFF;
    this._phiMax = degToRad(Constants.STATION_KEEP.MAX_LATITUDE);
    this._stationKeepTarget = null;

    // Daughter net-fire recoil (FEATURE_FLAGS.DAUGHTER_NET_RECOIL): a critically-damped controller transient the
    // SK/NETTING hold loop fights: the hold GOAL is displaced by _recoilOffsetM (metres, world axes) while the RCS
    // nulls it (see _updateRecoilKick). Vectors stay exactly zero while the flag is OFF (byte-identical hold math).
    this._recoilOffsetM = new THREE.Vector3();  // m — current displacement off the hold sphere
    this._recoilVelMps = new THREE.Vector3();   // m/s — recoil velocity being nulled
    this._recoilActive = false;                 // fast-path gate for the hold loops
    this._recoilFuelBilled = 0;                 // % tank — cumulative RCS recovery surcharge (telemetry)
    // Reaction-wheel scalar: normalized launch-reaction momentum. Increments per net fire, bleeds at
    // WHEEL_DECAY_PER_S, saturation ⇒ paid RCS desat per subsequent fire. Exposed via getStatus() for the HUD.
    this._wheelMomentum = 0;
    this._wheelSaturated = false;

    // Capture-torque settle (FEATURE_FLAGS.CAPTURE_TORQUE_SETTLE): live transient state or null. Seeded at the
    // daughter net-FSM cinch (_seedCaptureTorqueSettle), stepped every frame from update() (_tickCaptureSettle) with
    // the same critically-damped closed form as _updateRecoilKick, one angular DOF about the catch's own tumbleAxis.
    // Stays exactly null while the flag is OFF (byte-identical legacy).
    this._settle = null;
    // The live spin-down at the seat (null when none) - see _seatSpinBegin / _tickSeatSpin.
    this._seatSpin = null;
    this._seatEaseD = null;                  // the piece whose cell is easing toward a fresh seat answer
    this._seatHullGate = null;               // set by ArmManager (SeatHullClear.seatHullClear): is a big piece's seat clear of the mother?
    this._dockPos = null;                    // ... and the dock position it measures from (ArmManager._initArms)
    // Test hook mirroring _boostRipRollOverride: when non-null, replaces
    // Math.random() in the strain-gate rip roll for determinism.
    this._settleRipRollOverride = null;

    // reel-home (FEATURE_FLAGS.REEL_HOME): her net winds the catch in to her nose (a sub-phase of GRAPPLED), then
    // the strut reel winds her home tail first. All of this stays at its defaults while the flag is off.
    /** She is on the reels: winding the catch in (GRAPPLED net reel) or on the strut line (REELING). ArmManager reads it. */
    this._rhHome = false;
    // Pair-home: the partner of a pair launch (`ArmManager._dualFireFixed` sets it, `_tickPairHome` clears it).
    /** The other daughter of the pair launch she left with, while the link stands (else null). */
    this._pairPartner = null;
    /** Her catch is in its cell and she waits at the barrier for her partner's (GRAPPLED). */
    this._pairWaiting = false;
    /** Mission-clock seconds she has waited at the barrier. */
    this._pairWaitS = 0;
    /** The barrier let her go: 'both' (the partner too, this very frame) or 'alone' (a timeout or a broken link). Read once by `_updateGrappled`. */
    this._pairGo = null;
    /** She left the barrier together with her partner: the two reel with one tension (`_rhReelStep`) until one of them docks. */
    this._pairTogether = false;
    /** ArmManager said the one comms line of the pair's wait (both carry it). */
    this._pairSaid = false;
    /** Her catch failed (net miss or a lost piece): ArmManager breaks the link. */
    this._pairCatchFailed = false;
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
    /** The hold that stops her HOLD_M out ({reason, on, refused, capped, heldS, said}) or null; her floor turn was refused (ArmManager). */
    this._rhHold = null;
    this._rhFloorRefused = false;
    /** Her floor hold ended (capped, or she could not stop in time) and her floor reason still stands: it is not asked
     *  again, so the radiator reason can hold her. */
    this._rhFloorSpent = false;
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
    /** DOCKING came off the strut reel: the reel did the work, no thruster fuel is billed for it. */
    this._rhDockFree = false;
    /** Unclamped swing-plane angle nearest the direction hinge -> her (rad); ArmManager clamps it to [34°, 180°]. */
    this._rhBestAlpha = 0;
    /** Optional clearance hook (ArmManager): (worldPos, parentPos, parentQuat) -> gap to the ship, metres. */
    this._rhGapFn = null;
    /** Hinge -> her, ship-local, unit (set each frame she is on the reels). */
    this._rhRelShip = null;
    /** Arrival order on the reels (ArmManager: first come owns the mother turn). */
    this._rhSeq = 0;
    // Reel gas (DECISIONS §34): the reel-home haul is a sim: pull-up, cruise, brake on her cold-gas jet.
    /** Her current reel speed under REEL_HOME, game-scale m/s (per REAL s); 0 on entering REELING, held when dt is 0. */
    this._rhReelV = 0;
    /** The jet is firing this frame (she is slowing on gas): drives the gas bill, the look-puffs and the tension readout. */
    this._rhBraking = false;
    /** This reel's first look at the bottle has been made (the "no gas" line is said once per reel, at its start). */
    this._rhGasChecked = false;
    /** What the reel did this frame: 'pull' | 'cruise' | 'brake' | 'hold' (tests and the tension readout). */
    this._rhReelPhase = 'pull';
    /** The line readout of this frame, true N, and the mass the reel moved (dry + gas + net + catch), kg. */
    this._rhTensionN = 0;
    this._rhReelMassKg = 0;
    /** A carry leg's ion thread: 'aft' | 'fore' | null (which nozzle's exhaust points at her strut tip). */
    this._carryThread = null;
    /** Look-puffs of the jet: simulated seconds since the last one, and how many have been fired (visual only; tests read the count). */
    this._gasPuffAccum = 0;
    this._gasPuffCount = 0;
    /** The jet's port (mesh-local): the tail, firing -Z, toward the mother on the tail-first reel. Built with the puff pool. */
    this._gasPuffPort = null;

    // Carry: a rack catch carried to a radiator-tip furnace.
    /** The carry in progress (CARRY_PREP … CARRY_BACK), or null. Plain data; see beginCarry. */
    this._carry = null;
    /** A carry of hers ended on its own failure (prep never arrived, hold lost, no fuel at the start): she is not asked again
     *  this trip (ArmManager.carryCheck reads it; the trip clears it at its start, `reset()` too). */
    this._carryGaveUp = false;

    // Config G aim
    /** Meridian sweep angle α ∈ [0, π]. 0=stowed(−Y), π/2=equatorial, π=zenith(+Y) */
    this._aimAlpha = 0;
    /** The eased strut move in progress (see setAimAlpha's `ease`), else null. */
    this._aimEase = null;

    // Config G geometry — set by ArmManager._initArms() after construction
    /** @type {THREE.Vector3|null} */ this._hingePosition = null;
    /** @type {THREE.Vector3|null} */ this._dockOutward = null;
    /** @type {THREE.Vector3|null} */ this._swingAxis = null;
    /** @type {number} */ this._azimuthDeg = 0;
    /** @type {boolean} */ this._isEndFace = false;

    // Capture net inventory (CAPTURE_NET.md §6.1: weaver carries Medium Net, spinner carries Small Net).
    // Gated by FEATURE_FLAGS.CAPTURE_NET — when false these stay at 0.
    /** @type {number} */ this._netInventory = 0;
    /** @type {number} */ this._netInventoryMax = 0;
    /** @type {object|null} */ this._firedNet = null;
    /** @type {object|null} */ this._nettingOffset = null;

    eventBus.on(Events.ARM_ORBIT_ADJUST, (data) => {
      if (data.armId !== this.id) return;
      if (this.state !== Constants.ARM_STATES.STATION_KEEP) return;

      const SK = Constants.STATION_KEEP;
      const rate = data.fine ? SK.ORBIT_RATE_FINE : SK.ORBIT_RATE;
      const radRate = data.fine ? SK.RADIUS_RATE_FINE : SK.RADIUS_RATE;

      // Rate-based input (keys-held: ±/=, arrows). theta/phi/radius are signed ±1 unit-rates; multiplied by
      // SK.ORBIT_RATE / SK.RADIUS_RATE (and dt at apply-time) inside _updateStationKeep. Rates reset each frame in
      // _updateStationKeep, so missing-key frames decay to 0.
      this._thetaRate = (data.theta || 0) * rate;
      this._phiRate = (data.phi || 0) * rate;
      this._radiusRate = (data.radius || 0) * radRate;

      // Step-based input (one-shot: mouse-wheel). radiusStep is an instantaneous delta in metres applied directly to
      // _standoffR (no dt, no rate). 0.5 m/tick × ~16 ticks spans the 4–12 m band. Clamped to [_rMin, _rMax] by the
      // existing clamp in _updateStationKeep on the next frame.
      if (typeof data.radiusStep === 'number' && data.radiusStep !== 0) {
        this._standoffR += data.radiusStep;
        // Immediate clamp so HUD readout reflects the bounded value even if the next physics tick is delayed.
        this._standoffR = clamp(this._standoffR, this._minHoldM(), this._rMax);
      }
    });

    // --- Visual ---
    this.group = new THREE.Group();
    this.group.name = this.id;
    this.mesh = null;
    this.tetherLine = null;
    this.tetherMaterial = null;
    this._thrusterPlumes = [];
    // Fore FEEP pair + attitude cold-gas puffs: visual-only reads of existing physics fields, no fuel/attitude writes.
    this._forePlumes = [];        // fore core+halo (populated in _createMesh)
    this._forePlumeHalo = null;   // tagged so the halo dims to HALO_MULT × core
    this._skManeuverGlowS = 0;    // s left of SK maneuver-input brightening
    this._recoilFlashS = 0;       // s left of the fore counter-burn flash
    this._approachBrake01 = 0;    // smoothed APPROACH brake read (0..1)
    this._attPuffs = [];          // pooled cold-gas sprites (≤ PUFF_POOL_SIZE)
    this._attPuffIndex = 0;
    this._attPuffLastFire = -Infinity; // global burst cooldown stamp (s)
    this._attPuffPorts = null;    // 4 fixed local ports {pos,dir} (built once)
    this._statusLightMat = null;
    this._netMesh = null;
    // Detail-LOD cull set: inert daughter hardware hidden when far.
    this._detailMeshes = [];
    this._detailHidden = false;

    // Selection highlight: when a DOCKED daughter is selected with 1-4 it glows/flashes so the player can see which
    // plate they picked before launching with D. Driven by ArmManager via setSelectedHighlight(); the pulse runs in
    // _updateSelectGlow() each frame.
    /** @type {boolean} */
    this._selected = false;
    /** @type {Array<{mat:THREE.Material, baseEmissive:number, baseIntensity:number}>} */
    this._selectGlowMats = [];

    // Bridle visual references (populated in _createMesh)
    this._gimbalRing = null;
    this._bridleLegA = null;
    this._bridleLegB = null;
    this._bridleLegMat = null;
    this._bridleHpA = null;
    this._bridleHpB = null;

    this._createMesh();
    this._createTether();

    // 0.5 s fore-plume counter-burn flash on the recoil-kick emitter (Events.ARM_RECOIL_KICK {armIndex}). Subscribe
    // DEFENSIVELY: only when the event name exists, else a clean no-op. The flash itself rides `_recoilFlashS`, which
    // armPlumeModel decays to a fore flare.
    if (typeof Events.ARM_RECOIL_KICK === 'string' && Events.ARM_RECOIL_KICK) {
      this._onRecoilKick = (p) => {
        if (!p || p.armIndex !== this.index) return;
        this._recoilFlashS = DAUGHTER_PLUME.RECOIL_FLASH_S;
      };
      eventBus.on(Events.ARM_RECOIL_KICK, this._onRecoilKick);
    }

    // The daughter is a SEPARATE top-level scene object from the mother, yet docks AT the mother's strut tip where
    // their geometry overlaps. Their meshes share the RENDER_ORDER scale, so equal bands (e.g. both DETAIL) tie and
    // resolve by ambiguous depth → z-fighting at the seam. Lift the whole daughter BODY subtree by DAUGHTER_BIAS so it
    // resolves cleanly in front of the strut-tip collar while preserving the body's own internal layering (every child
    // keeps its relative renderOrder). The main tether (a child of `this.group`, not `this.mesh`) bridges to the mother
    // and is intentionally left unbiased so it keeps lying on both craft; the short bridle legs live on `this.mesh`
    // and ride with the biased body.
    const dbias = Constants.RENDER_ORDER.DAUGHTER_BIAS;
    this.mesh.traverse((obj) => {
      if (obj.isMesh || obj.isLine || obj.isPoints || obj.isSprite) {
        obj.renderOrder += dbias;
      }
    });

    scene.add(this.group);
  }

  /**
   * Player-facing name: internal type stays 'weaver'/'spinner' but the crew sees 'Large' / 'Small'. Delegates to the
   * shared {@link daughterDisplayName} so the HUD, reticle, and comms can never disagree.
   * @returns {string}
   */
  get displayName() {
    return daughterDisplayName(this.id);
  }

  /** @private Build the arm unit Three.js model */
  _createMesh() {
    const [bx, by, bz] = this.config.bodyDims;
    const isWeaver = this.type === 'weaver';

    // Hex prism body (a Group, for child composition)
    this.mesh = new THREE.Group();
    this.mesh.name = `${this.id}-body`;
    this.group.add(this.mesh);

    const apothem = (bx / 2) * M;
    const hexR = apothem / Math.cos(Math.PI / 6);
    const halfLen = (bz * M) / 2;

    // The body side is built as 6 INDIVIDUAL flat facet quads (not one textured hex shell) to control cell coverage per
    // facet: the solar-cell map goes on 5 facets, and the facet that carries the round laser receiver (+Y) is left as
    // bare metal. The end caps are also plain metal (no cells). Separate, non-coincident faces → no z-fight.
    //
    // Facet k (k=0..5) outward azimuth = 30° + k·60°. +Y is 90° → facet k=1 carries the laser RX; leave bare.
    const LASER_FACET = 1;

    const baseColor = isWeaver ? 0x4488aa : 0x88aa44;
    // Bare facet + end caps are dark anodised grey (a real small craft is not cartoon teal); the Weaver blue /
    // Spinner green type colour is on the fore band ring below so each type still reads at a glance.
    const bareMetalMat = new THREE.MeshStandardMaterial({
      color: 0x3a3d44, metalness: 0.70, roughness: 0.45,
    });

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

    const facetW = hexR;   // hexagon: facet width = side length = circumradius
    const facetGeo = new THREE.PlaneGeometry(facetW, bz * M);
    this._bodyShell = null;
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
      if (k === 0) this._bodyShell = facet;
    }

    // Selection glow: register the body facet materials (solar-cell skin + the bare-metal laser facet) so
    // _updateSelectGlow() can pulse their emissive. Both are per-arm materials, so modulating their emissive is
    // isolated to this unit. Record each base emissive/intensity once for clean restore.
    for (const mat of [cellMat, bareMetalMat]) {
      if (mat && mat.emissive && !this._selectGlowMats.some(e => e.mat === mat)) {
        this._selectGlowMats.push({
          mat,
          baseEmissive: mat.emissive.getHex(),
          baseIntensity: mat.emissiveIntensity ?? 1.0,
        });
      }
    }

    const capGeo = new THREE.CircleGeometry(hexR, 6);
    for (const s of [-1, 1]) {
      const cap = new THREE.Mesh(capGeo, bareMetalMat);
      cap.position.set(0, 0, s * halfLen);
      cap.rotation.y = s > 0 ? 0 : Math.PI;
      // CircleGeometry(hexR, 6) default vertices sit at azimuth 0°+k·60°, which are exactly the hull CORNERS between
      // the side facets (centred at 30°+k·60°), so the default cap already aligns: NO z-rotation (adding π/6 would
      // rotate cap corners onto facet-normal azimuths, poking ~13.4% past the facet planes; the aft cap's
      // rotation.y=π mirror maps the vertex set onto itself).
      cap.name = `${this.id}-cap-${s > 0 ? 'fore' : 'aft'}`;
      cap.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
      this.mesh.add(cap);
    }

    // Corner rails + type-colour band ring. Six thin gunmetal strips along the hull corners (ONE merged mesh, 72 tris)
    // give the prism an edge thickness; the 4 cm band near the fore cap carries the type colour. Both ride DETAIL order
    // above the facets (no coplanar tie: rails are inset 2 mm from each cap, the band stands 2 % proud of the hull).
    {
      const railT = 0.006 * M;
      const railW = 0.006 * M;
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

    // Panel line edges (zero triangle cost), built from a slightly LARGER hex (1.5% proud) so the lines sit physically
    // off the facets with a real, zoom-independent gap (no coplanar z-fight with the facet quads).
    const edgeHexGeo = new THREE.CylinderGeometry(hexR * 1.015, hexR * 1.015, bz * M, 6, 1, false, Math.PI / 6);
    const edgeGeo = new THREE.EdgesGeometry(edgeHexGeo, 30);
    const edgeMat = new THREE.LineBasicMaterial({
      color: 0x667788, transparent: true, opacity: 0.5,
    });
    const edges = new THREE.LineSegments(edgeGeo, edgeMat);
    edges.rotation.x = Math.PI / 2;
    edges.name = `${this.id}-panel-lines`;
    edges.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_TRANSPARENT;
    this.mesh.add(edges);

    // Dock socket ring on the aft face. The Ø50 mm strut tube enters the hull through this ring (bore Ø51.5 mm =
    // 0.75 mm clear per side, wall 3 mm, 8 mm proud), so the tube does not vanish into bare cap. A dark notch on the
    // +Y side marks the D-flat of the print socket.
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
    // The D-key mark sits on the +Y side (the print's flat is on the daughter's +Y facet), and reads as a dark notch
    // cut into the ring's rim: a small dark block set INTO the wall at the outer end (only 0.2 mm proud of each wall
    // face, so it is not a lug).
    const keyMat = new THREE.MeshStandardMaterial({ color: 0x08080c, metalness: 0.3, roughness: 0.6 });
    const keyW = socketRo - socketRi + 0.0004 * M;     // radial extent: the whole wall + 0.2 mm each side
    const keyL = 0.003 * M;                            // axial depth of the notch
    const key = new THREE.Mesh(new THREE.BoxGeometry(0.005 * M, keyW, keyL), keyMat);
    key.position.set(0, (socketRi + socketRo) / 2, -halfLen - socketL + keyL / 2);
    key.name = `${this.id}-dock-socket-key`;
    key.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.mesh.add(key);

    // Aft FEEP nozzle. A real thruster on the dock axis would fire into the strut, so the whole aft thruster (boss,
    // nozzle box, plume pair) sits OFF-centre beside the socket, on the +X axis toward the +X hull corner. Boss radius
    // r_b = min(nozzle r, the room left between the socket ring and the slanted hex edge, both with 2 mm of margin);
    // centre x_c = R_O + 2 mm + r_b. The nozzle is a BOX stub (real FEEP = box + aperture, no bell), side 0.6 x the
    // exit Ø, centred on the boss.
    const aftNozR = (isWeaver ? 0.015 : 0.010) * M;     // nozzle radius: sizes the plume + boss
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

    // Small mounting boss/recess ring at the nozzle base so it reads as attached rather than a stub poking out of the
    // cap. On a DISTINCT z-plane (z=-bz*0.515) — between the aft cap (−0.5), the pusher disc (−0.505) and the nozzle
    // base (−0.52) — plus DETAIL order, so it does not re-introduce the aft-nozzle-base z-fight.
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

    // Aft thruster plume (additive, hidden by default), HYBRID: a physically-consistent silver-blue FEEP core
    // (0x99bbdd, same propellant as the Mother) inside a fainter TYPE-TINTED outer halo (Weaver blue / Spinner green)
    // so per-type identification survives at distance. Both are diverging frustums (narrow at the exit, widening +
    // alpha-fading aft) welded at the nozzle exit; both are pushed to _thrusterPlumes so the single _updatePlumes
    // driver shows/flickers them together.
    const plumeLen = bz * 0.55 * M;
    const coreGeo = makePlumeFrustum(aftNozR * 1.0, aftNozR * 2.2, plumeLen, 10, 3);
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0x99bbdd, transparent: true, opacity: 0.0, vertexColors: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const plume = new THREE.Mesh(coreGeo, coreMat);
    // Additive plume must draw AFTER solid geometry, like the mother's plumes — untagged, it sorts by raw depth
    // against the (separate) mother object and punches through inconsistently.
    plume.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;
    plume.position.set(aftX, 0, -bz * 0.5 * M);   // near end welded to aft nozzle exit (off-centre)
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

    // Fore FEEP nozzle (braking/attitude, offset on +Z face)
    const foreNozR = (isWeaver ? 0.010 : 0.007) * M;
    const foreNozL = (isWeaver ? 0.015 : 0.010) * M;
    const foreSide = foreNozR * 2 * 0.6;
    // The fore box sits OUTSIDE the net-launcher canister (r = canister radius, 55 / 35 mm), 2 mm clear of it measured
    // at the box's half-diagonal, on the +X axis. One shared x for nozzle, aperture, plumes.
    const foreCanR = (isWeaver ? 0.055 : 0.035) * M;
    const foreX = foreCanR + 0.002 * M + foreSide * Math.SQRT1_2;
    const foreNozGeo = new THREE.BoxGeometry(foreSide, foreNozL, foreSide);   // box stub: height = axial length
    const foreNozzle = new THREE.Mesh(foreNozGeo, feepMat);
    // Protrude past the fore face (halfLen = bz·0.5·M) with the base embedded so it reads as a real nozzle, not a stub
    // buried inside the hull. The brake plume axis test uses the daughter's world +Z direction, not this mesh
    // position, so moving it forward is safe.
    foreNozzle.position.set(foreX, 0, bz * 0.5 * M + foreNozL * 0.35);
    foreNozzle.rotation.x = -Math.PI / 2;
    foreNozzle.name = `${this.id}-feep-fore`;
    this.mesh.add(foreNozzle);
    const foreAp = new THREE.Mesh(new THREE.CircleGeometry(foreSide * 0.3, foreSide * 0.3 >= 0.005 * M ? 24 : 12), feepApMat);
    foreAp.position.set(foreX, 0, bz * 0.5 * M + foreNozL * 0.35 + foreNozL / 2 + 0.0005 * M);
    foreAp.name = `${this.id}-feep-fore-aperture`;
    foreAp.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.mesh.add(foreAp);

    // Fore thruster plume: same HYBRID idiom as the aft pair above (silver-blue FEEP core + type-tinted halo,
    // additive, hidden by default), sized to the smaller fore nozzle and welded at its exit plane. Fires when the
    // daughter thrusts TOWARD travel: APPROACH braking, the REDOCK_FEEP arrest window, and the recoil counter-burn —
    // driven by the same armPlumeModel mapping in _updatePlumes. LOD: gets the aft plume's treatment exactly — NOT in
    // the detail cull set (plumes are communicative; the halo is the per-type ID at range).
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

    // Mini net launcher (forward, cylindrical), mirroring the mother's launcher design language: a single central
    // gunmetal housing on the fore centreline (+Z, anti-spin doctrine) whose front face is an inventory-driven magazine
    // window: a pale Dyneema cap per LOADED net over a dark bore.
    const isWeaverLaunch = isWeaver;
    const netClass = Constants.CAPTURE_NET?.[isWeaverLaunch ? 'MEDIUM' : 'SMALL'];
    // Cell count = magazine size. Fall back to the drift-guarded ARM_NET_CAPACITY constant (a test enforces it ==
    // CAPTURE_NET.*.MAGAZINE_SIZE), so the cap slots always match inventory capacity.
    const cellCount = (netClass && netClass.MAGAZINE_SIZE)
      ?? Constants.ARM_NET_CAPACITY?.[isWeaverLaunch ? 'weaver' : 'spinner'] ?? 0;
    const canR = isWeaverLaunch ? 0.055 : 0.035;
    // DECISIONS §33 row 5: the can is DEEP enough to hold the cartridges of the strongest fibre (large 5, small 10 nets;
    // litres in test-NetPack): 0.24 m large, 0.16 m small. The FRONT FACE stays at z 0.200 / 0.1075, so the extra length
    // runs back inside her body (back ends z -0.040 / -0.0525, body half-lengths 0.15 / 0.075), hidden behind the end
    // cap. The radius cannot grow (the fore thruster box is placed from it).
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
    // netCellLayout, one round bore per net (start tier: 4 large / 4 small; 6, 8 and 10 after the fibre upgrade).

    // Net-launch MUZZLE (SSOT): the launcher housing's front face on the fore centreline — the same plane the magazine
    // cells sit on, captured from the SAME variables that place the `${id}-net-launcher` mesh above (canCz + canH·M/2),
    // so the launch / net-tether anchor can never drift from the visible hardware. Read back in world space via
    // getNetMuzzleWorldInto(). Scene units, mesh-local.
    this._netMuzzleLocal = new THREE.Vector3(0, 0, cellFaceZ);
    // The mother launcher's white disc + gunmetal lip, scaled to the can. Disc = can R - 6 mm (weaver) / - 3 mm
    // (spinner), top 1 mm proud of the front face; the lip ring stands 2 mm / 1.5 mm above the disc top, so the white
    // reads inset. Bores and caps are lifted by the disc's 1 mm. The muzzle (_netMuzzleLocal) is unaffected.
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
    // Her seat ring (DECISIONS §48 row 5): a thin capture ring of the mother's kind (no petals, hooks or latches),
    // coaxial with the lip and OUTSIDE it, standing on the launcher face; a caught piece seats against it, only the net
    // between. Outer edge inside her body outline. Mass (aluminium, from the tube's volume) is logged, not booked.
    {
      const SR = Constants.DAUGHTER_SEAT_RING || {};
      const tubeR = SR.TUBE_R_M ?? 0.00125;
      const ringR = canR + (SR.GAP_TO_LIP_M ?? 0.0015) + tubeR;          // tube centre radius: inner edge = lip outer + gap
      // three's Mesh / geometry constructors draw their uuids from Math.random. The seeded scenario tests (the
      // satellite's handover seeds, the haul planners) replace Math.random with a fixed stream and every draw here would
      // shift all that follow (building the ring moved 9 seeded outcomes). Her ring takes its uuids from a stream of
      // its own and leaves the game's alone.
      const gameRandom = Math.random;
      let h = (_ringSeed = (_ringSeed + 0x9E3779B9) >>> 0);
      Math.random = () => { h = (Math.imul(h ^ (h >>> 15), 0x2C1B3C6D) + 0x297A2D39) >>> 0; return h / 4294967296; };
      let ring;
      try {
        ring = new THREE.Mesh(new THREE.TorusGeometry(ringR * M, tubeR * M, 8, 48), canMat);
      } finally { Math.random = gameRandom; }
      ring.position.set(0, 0, cellFaceZ + tubeR * M);                    // the tube rests on the face (torus axis is +Z already)
      ring.name = `${this.id}-DNetSeatRing`;
      ring.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      this.mesh.add(ring);
      this._seatRing = {
        innerRM: ringR - tubeR, outerRM: ringR + tubeR, tubeRM: tubeR, faceZM: cellFaceZ / M,
        massKg: (SR.DENSITY_KG_M3 ?? 2700) * 2 * Math.PI * Math.PI * ringR * tubeR * tubeR,   // torus volume x density (logged only)
      };
    }
    const boreMat = new THREE.MeshStandardMaterial({ ...AVIONICS_DARK_OPTIC });    // dark bore (matches mother)
    const capMat = new THREE.MeshStandardMaterial({ ...AVIONICS_THERMAL_WHITE });  // pale Dyneema cap (matches mother)
    this._netCan = { canR, cellFaceZ, DISC_TOP, boreMat, capMat };
    this._netCellMeshes = [];
    this._netCellGeos = [];
    this._netCellCaps = [];
    this._buildNetCells(cellCount);

    // The daughter net emits use TWO payload shapes: CaptureNet emits {remaining}, ArmUnit's own set/decrement/reload
    // emit {nets}. Accept BOTH.
    this._onNetInventoryChanged = (p) => {
      if (!p || p.source !== 'daughter' || p.armIndex !== this.index) return;
      const n = (p.remaining ?? p.nets) ?? 0;
      this._syncNetCells(n);
    };
    eventBus.on(Events.NET_INVENTORY_CHANGED, this._onNetInventoryChanged);

    // One whip antenna on a base puck at the fore cap's -X corner, beside the net launcher (puck edge >= 4 mm clear of
    // the launcher housing wall). Both are CULL-listed inert detail (suffixes '-antenna', '-antenna-puck').
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

    // Laser power receiver (top face) — a small optical rectenna, NOT a solar array. A round photodiode recessed
    // inside a short metallic housing.
    const rxR = (isWeaver ? 0.045 : 0.030) * M;   // receiver disc radius (small)
    // The bezel is a real 3-D ring HOUSING (a short open cylinder wall) that RISES from the facet — its base sits on
    // the body, so nothing floats — and the diode is recessed at the bottom of that well. A FLAT ring + disc either
    // z-fights the facet (coplanar) or, lifted clear, floats above the hull. Because the wall has real height
    // (perpendicular to the facet), no surface is coplanar with the body, so there is no z-fight at any zoom.
    const facetY = (bx / 2) * M;                  // +Y facet plane (apothem)
    const houseOR = rxR * 1.35;                   // housing outer radius
    const houseH  = rxR * 0.6;                    // housing wall height (proud of facet)

    const rxBezelGeo = new THREE.CylinderGeometry(houseOR, houseOR, houseH, 48, 1, true);
    const rxBezelMat = new THREE.MeshStandardMaterial({
      color: 0x777788, metalness: 0.9, roughness: 0.25, side: THREE.DoubleSide,
    });
    const rxBezel = new THREE.Mesh(rxBezelGeo, rxBezelMat);
    // Sink the base slightly into the facet so the wall reads as embedded in the hull (grounded, not floating) and its
    // bottom edge isn't exactly coplanar.
    rxBezel.position.set(0, facetY + houseH / 2 - houseH * 0.2, 0);
    rxBezel.name = `${this.id}-laser-rx-bezel`;
    rxBezel.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.mesh.add(rxBezel);

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

    // MRR patch antenna — a thin 3-D puck (has thickness, so it is grounded to the facet and never coplanar with it).
    const mrrR = (isWeaver ? 0.015 : 0.010) * M;
    const mrrH = mrrR * 0.4;                       // puck thickness
    const mrrGeo = new THREE.CylinderGeometry(mrrR, mrrR, mrrH, 24);
    const mrrMat = new THREE.MeshStandardMaterial({
      color: 0xccccdd, metalness: 0.95, roughness: 0.15,
    });
    const mrr = new THREE.Mesh(mrrGeo, mrrMat);
    // Base sunk slightly into the facet so the puck sits ON the hull with real thickness — grounded, no float, no
    // coplanar tie.
    mrr.position.set(bx * 0.25 * M, facetY + mrrH / 2 - mrrH * 0.25, -bz * 0.20 * M);
    mrr.name = `${this.id}-mrr-patch`;
    mrr.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.mesh.add(mrr);

    // Status light (blinks to show state)
    const lightGeo = new THREE.SphereGeometry(0.010 * M, 24, 12);
    this._statusLightMat = new THREE.MeshBasicMaterial({ color: 0x00ff44 });
    const statusLight = new THREE.Mesh(lightGeo, this._statusLightMat);
    statusLight.position.set(0, by * 0.55 * M, -bz * 0.3 * M);
    statusLight.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;
    this.mesh.add(statusLight);
    // Additive glow halo so the state light reads as an alive lamp, not a painted dot (shared makeLightHalo factory,
    // same recipe as the Mother's nav/dock halos). Colour + opacity track the core in _updateStatusLight (the per-state
    // hex already encodes the blink bright/dim phase, so it breathes). Size/opacity from Constants.LIGHT_FX.
    this._statusLightHalo = makeLightHalo(
      0x00ff44, Constants.LIGHT_FX.STATUS_HALO * M, 1.8, Constants.LIGHT_FX.STATUS_HALO_OPACITY);
    statusLight.add(this._statusLightHalo);

    // Gunmetal housing (a short bezel wall) round the lens sphere so the lamp sits in a fitting instead of floating on
    // the hull.
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

    // EPM docking collar
    const epmR = (isWeaver ? 0.025 : 0.020) * M;
    const epmH = (isWeaver ? 0.015 : 0.012) * M;
    const epmHousing = new THREE.Mesh(
      new THREE.CylinderGeometry(epmR, epmR, epmH, 48),   // housing = pole ring
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
      new THREE.RingGeometry(poleIR, poleOR, 48, 1),   // matches the EPM housing
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
      new THREE.CylinderGeometry(pushR, pushR, pushH, 48),
      new THREE.MeshStandardMaterial({ color: 0x777788, metalness: 0.78, roughness: 0.32 })
    );
    // z=-bz*0.505, forward of the aft-nozzle base plane at z=-bz*0.52 (z-fight otherwise).
    pusher.position.set(0, 0, -bz * 0.505 * M);
    pusher.rotation.x = Math.PI / 2;
    pusher.name = `${this.id}-pusher-plate`;
    pusher.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.mesh.add(pusher);

    // Wishbone bridle (gimbal ring + Y-fork legs + hardpoints): 2× hardpoints at ±X
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
    legA.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_CONNECTOR;
    this.mesh.add(legA);

    const legBGeo = new THREE.BufferGeometry();
    legBGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      0, by * 0.70 * M, 0,  -bx * 0.45 * M, by * 0.30 * M, 0
    ]), 3));
    const legB = new THREE.Line(legBGeo, bridleLegMat);
    legB.name = `${this.id}-bridle-leg-B`;
    legB.visible = false;
    legB.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_CONNECTOR;
    this.mesh.add(legB);

    this._bridleLegA = legA;
    this._bridleLegB = legB;
    this._bridleLegMat = bridleLegMat;

    // Pooled attitude cold-gas puffs (discrete-event only, ≤4 sprites).
    this._buildAttitudePuffPool(bx, bz);

    // Detail-LOD cull set: collect inert daughter hardware by name suffix. Excludes body, status light + halo, plumes
    // (aft AND fore — both are communicative "she is alive" reads whose halos carry per-type ID at range), attitude
    // puffs (transient, invisible by default), tether, bridle legs (communicative / connector). Only
    // sub-pixel-at-distance detail is listed.
    this._collectDetailMeshes();

    // Start hidden (docked = part of core visually)
    this.mesh.visible = false;
  }

  /** @private Gather inert daughter hardware (by `${id}-` name suffix) into `_detailMeshes` for the distance LOD cull. */
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
   * Live camera→craft distance (SCENE UNITS); inert detail flips only on hysteresis-threshold crossing.
   * @param {number} distSceneUnits
   */
  setCameraDistance(distSceneUnits) {
    this._detailHidden = applyDetailLod(distSceneUnits, this._detailMeshes, this._detailHidden);
  }

  /**
   * @private Pooled cold-gas attitude puffs at daughter scale (mirrors the mother's `_buildRcsPuffPool`).
   * STRICT BUDGET: exactly DAUGHTER_PLUME.PUFF_POOL_SIZE (4) sprites per daughter, bursts fire PUFF_BURST_COUNT (2),
   * nothing allocates per frame. Texture may be null (headless). depthTest ON so the hull occludes them.
   * Doctrine (archive/BIG_PICTURE.md Part IV): cold gas = brief dim puffs, not flames, fired ONLY on discrete
   * attitude events (see _fireAttitudePuffs call sites).
   * @param {number} bx body X dim (m) — facet apothem = bx/2
   * @param {number} bz body Z dim (m)
   */
  _buildAttitudePuffPool(bx, bz) {
    const tex = getRadialGlowTexture({ size: 32 });
    const apo = (bx / 2) * M;          // side-facet plane (same as the RX facetY)
    const portZ = bz * 0.25 * M;       // fore of centre — reads as an attitude couple

    // 4 virtual RCS ports on the side facets (±X yaw pair, ±Y pitch pair); gas drifts OUTWARD along the facet
    // normal. Mesh-local and frozen: visuals only, never a force on the arm.
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
        color: 0xcfe0ff,   // cold-gas (N₂) white-blue, as the mother
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        depthTest: true,   // hull occludes puffs
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
   * @private Fire one discrete attitude burst (2 pooled sprites). Event kind → port pair so the couple reads right:
   *   'deploy' separation trim → ±Y pair   'sk'   arrival null → ±X pair
   *   'tool'   re-aim yaw      → ±X pair   'dock' settle       → ±Y pair
   * Round-robin overwrites the oldest sprite, so the live count can NEVER exceed the pool size; a global cooldown
   * stops back-to-back transitions strobing.
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

      // pooled vectors; jitter of a few mm / ~8° so bursts differ
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
      puff.life     = 0.18 + Math.random() * 0.10;         // 0.18–0.28 s
      puff.maxScale = M * (0.06 + Math.random() * 0.04);   // expands to 6–10 cm
      puff.baseOp   = 0.28 + Math.random() * 0.12;
      puff.drift    = M * (0.12 + Math.random() * 0.08);   // 12–20 cm free jet
      puff.startTime = now - k * 0.012;

      puff.sprite.position.copy(puff.startPos);
      puff.sprite.material.opacity = 0;
      puff.sprite.scale.set(M * 0.015, M * 0.015, M * 0.015);
      puff.sprite.visible = true;
      puff.active = true;
    }
  }

  /**
   * @private Animate active puffs: free-jet drift, √t expansion, rise-then-decay fade (the mother's cold-gas math
   * minus sun-scatter); inactive entries early-out.
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
      const s = lerp(startS, puff.maxScale, Math.sqrt(t));
      puff.sprite.scale.set(s, s, s);
      const rise = Math.min(1, t / 0.1);
      const fall = Math.pow(1 - t, 1.5);
      puff.sprite.material.opacity = Math.min(0.85, puff.baseOp * rise * fall);
    }
  }

  _createTether() {
    const segments = Constants.TETHER_SEGMENTS;
    const positions = new Float32Array(segments * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    // Solid per-vertex-colour gradient line (a 1 px dashed line read as broken): bright at the strut anchor
    // (vertex 0) fading toward the daughter. REELING motion cue = brightness pulse travelling anchor-ward (see
    // _updateTether).
    const colors = new Float32Array(segments * 3);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.tetherMaterial = new THREE.LineBasicMaterial({
      color: Constants.TETHER_COLOR_NOMINAL,   // state tint (multiplies vertex colors)
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
    });
    this.tetherLine = new THREE.Line(geometry, this.tetherMaterial);
    this.tetherLine.visible = false;
    this.tetherLine.frustumCulled = false;
    // CONNECTOR band: the tether bridges the separate daughter and mother objects; untagged, its transparent line
    // depth-sorted and flickered in front of/behind the strut + reel point.
    this.tetherLine.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_CONNECTOR;
    this.group.add(this.tetherLine);
    this._tetherWriteGradient(-1);
  }

  /**
   * @private Per-vertex brightness: base ramp 1.0 at the anchor (vertex 0) → 0.35 at the daughter; during REELING a
   * gaussian pulse travels toward the anchor (decreasing t). `pulsePhase` ∈ [0,1) is its centre (1 = at daughter,
   * 0 = at anchor); negative = no pulse.
   */
  _tetherWriteGradient(pulsePhase = -1) {
    if (!this.tetherLine) return;
    const colorAttr = this.tetherLine.geometry.attributes.color;
    if (!colorAttr) return;
    const arr = colorAttr.array;
    const segments = Constants.TETHER_SEGMENTS;
    for (let i = 0; i < segments; i++) {
      const t = i / (segments - 1);            // 0 = anchor, 1 = daughter
      let b = 1.0 - 0.65 * t;
      if (pulsePhase >= 0) {
        const d = t - pulsePhase;
        b += 0.9 * Math.exp(-(d * d) / (2 * 0.06 * 0.06));
        if (b > 1.6) b = 1.6;
      }
      const idx = i * 3;
      arr[idx] = b; arr[idx + 1] = b; arr[idx + 2] = b;
    }
    colorAttr.needsUpdate = true;
  }

  /**
   * Apply a shop upgrade override to this arm's config (ArmManager.applyUpgrade / _reapplyStoredUpgrades).
   * @param {string} effect - Upgrade effect key
   * @param {number} value - Upgrade value
   */
  applyUpgradeOverride(effect, value) {
    switch (effect) {
      case 'tetherRange':
        // Multiplies the BASE tether length (no compounding on re-apply), 2.0 = 2× range. The `long_tether` shop card
        // is retired; this stays as the replay shim so a pre-retirement save keeps its reach.
        this.config.tetherMax = (this.type === 'weaver'
          ? Constants.WEAVER_TETHER_LENGTH : Constants.SPINNER_TETHER_LENGTH) * value;
        break;
      case 'reelSpeed':
        // Multiply approach/haul speed (e.g., 1.5 = 50% faster)
        this.config.approachSpeed = Constants.ARM_APPROACH_SPEED * value;
        this.config.haulSpeed = Constants.ARM_HAUL_SPEED * value;
        break;
      case 'armFuelMax': {
        // 1.5 = 50% more FEEP fuel
        const baseFuelMax = 100;
        const newMax = baseFuelMax * value;
        if (this.fuel === baseFuelMax) {
          this.fuel = newMax;
        }
        // fuel is a 0-100 percentage, so scale captures-per-fuel instead
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
        this.config.dockSpeedMultiplier = 1.0 / value;
        break;
      // --- V4 GSL ---
      case 'v4TetherRange':
        // V4 GSL tether: 6.25× reach (12.5km). The `gsl_tether_v4` shop card is retired: 12.5 km out-reached the
        // ladder top (T5 GSL-100 10 km) and a later tier purchase silently lowered it. Replay shim for owned saves.
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

  /** @private Post a HintTicker entry (bottom strip) for a deploy refusal; one id per cause, repeats coalesce. */
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
   * @param {object} target - Debris object with ._scenePosition and .id
   * @returns {boolean} true if deployment started
   */
  deploy(target) {
    if (this.state !== S.DOCKED) return false;
    // Spring must be charged. Every refusal ALSO posts a HintTicker entry naming the next verb (a comms line alone
    // is easy to miss in the learning missions).
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
    // R2: over the mother's catch limit a daughter goes to INSPECT (usual approach and hold, her arc, home; no net),
    // not a mass refusal.
    const inspecting = isInspectOnlyMass(target.mass);
    if (target.mass && target.mass > this.config.maxCaptureMass && !inspecting) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Target too massive (${target.mass}kg > ${this.config.maxCaptureMass}kg)`,
        priority: 'warning',
      });
      this._postDeployRefusalHint('mass', 'Target too massive for this daughter. Pick a lighter one [T]');
      return false;
    }
    this.target = target;
    this._inspectSweep = null;              // R2: a fresh inspection arc for this trip
    this._fuelAtDeploy = this.fuel;         // Track for efficiency scoring
    this._startingDistance = 0;             // reset for approach beep fraction
    this._smoothDriftVel = null;            // reset EMA-smoothed drift for fresh approach
    this._prevTargetScenePos = null;        // reset stale target position from previous mission

    const tPos = this._getTargetScenePos();
    if (tPos) {
      const distToTarget = tPos.distanceTo(this.position) / M;
      // Refuse beyond operational range: tetherMax × ARM_DEPLOY_RANGE_FRACTION (0.8, tether-tier-aware). The daughter
      // autopilot is range-scale-invariant (quadratic braking; braking distance 2v² = 1.25 km at 25 m/s) and its fuel
      // is impulse-priced, so range costs transit time, not tank. 0.8 keeps 0.15 of slack to the 0.95× tether-limit
      // recall guard. At T5 GSL-100 the weaver radius is 8 km: the 16 km wide-sweep doctrine (item 76(d), owner-ruled).
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
      // Aim-before-launch: after the aim ceremony slewed this strut to the target, fire along the PHYSICAL strut-tip
      // direction (SSOT with the rendered strut pose); residual aim error is intentional, the TRANSIT FEEP controller
      // corrects it. Non-ceremony paths (deployArmByIndex / deployAllToTarget / deploySpecificArm) never slew
      // _aimAlpha, so firing along the stowed strut would go the wrong way: use the direct target bearing.
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
      // Fallback: outward along world-space dock direction
      this.launchDirection = this._worldDockDirection(this._lastParentQuat);
    }

    this._transitionTo(S.LAUNCHING);
    this._undockTimer = 0;
    this._springFired = false;
    this._dockWorldPos = this.position.clone();

    // No launch line here (she is only clamped): the one line is "Spring released. Separating" at ARM_SPRING_FIRED
    // (see _updateLaunching).
    eventBus.emit(Events.ARM_DEPLOYED, {
      armId: this.id, type: this.type, targetId: target.id,
    });
    if (inspecting) eventBus.emit(Events.COMMS_MESSAGE, { text: `${this.displayName} going to inspect it, no net.`, priority: 'info' });
    return true;
  }

  /**
   * @private When the launch gate has aimed this strut (`_aimConverged`, set by ArmManager right before `fire()`
   * with FEATURE_FLAGS.LAUNCH_AIMS_STRUT on), the spring pushes along the live strut axis (world frame) instead of
   * the caller's direction. Consumes the flag, as `deploy()` does; no-op with the switch off.
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
   * Free-fly deploy (no target; number-key deploy): LAUNCHING → TRANSIT with manual pilot control.
   * @returns {boolean}
   */
  deployFreefly() {
    if (this.state !== S.DOCKED) return false;
    // Refusal parity with deploy() (no mass check: free-fly has no target to weigh).
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

    // outward along world-space dock direction
    this.launchDirection = this._worldDockDirection(this._lastParentQuat);
    this._takeStrutAxisLaunchDirection();

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

    // Fallback: world-space dock direction, so the trawl sweeps outward.
    this._trawlDirection = direction
      ? new THREE.Vector3(direction.x, direction.y, direction.z).normalize()
      : this._worldDockDirection(this._lastParentQuat);
    this._trawlTimer = 0;
    this._trawlingMode = true;
    this.target = null;

    // launch heading (the sweep heading `_trawlDirection` stays as passed)
    this.launchDirection = this._trawlDirection.clone();
    this._takeStrutAxisLaunchDirection();

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
    if (this.state !== S.DOCKED) return false;
    if (!target || target.id === undefined || target.id === null) return false;

    if (this.power && this.power.flat) {            // her engine runs the shot: nothing to fire it with (same line as a launch)
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `Daughter ${(this.index ?? 0) + 1}: Battery flat: charging`,
        priority: 'warning',
      });
      return false;
    }

    if (this._webShotCooldown > 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Web shot cooldown. ${Math.ceil(this._webShotCooldown)}s remaining`,
        priority: 'warning',
      });
      return false;
    }

    if (this.fuel < Constants.WEB_SHOT_FUEL_COST) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Insufficient fuel for web shot`,
        priority: 'warning',
      });
      return false;
    }

    this.fuel -= Constants.WEB_SHOT_FUEL_COST;
    this.power.markEngine();            // an ion debit: her engine bills its rating this frame (DaughterPower)

    this._webShotPrevState = this.state;
    this._webShotTarget = target;
    this._webShotOrigin.copy(this.position);
    this._transitionTo(S.WEB_SHOT);

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
   * A TETHERED daughter is ALWAYS reeled home on the mothership's zero-fuel strut/tether reel motor and is never
   * abandoned as EXPENDED for low fuel; her emergency FEEP reserve (if any) funds the soft-dock arrest. Only a
   * detached (severed-tether) daughter is beyond reel-in.
   * owner 2026-10-21: a daughter flying home on her FEEP (RETURNING) is on her line too, so R winds her in instead
   * of being refused.
   * @returns {boolean|'already'} true = she is now being reeled home; 'already' = she already was (REELING);
   *   false = refused (a comms line says why: holding a catch, carrying, detached) or nothing to recall (DOCKED / EXPENDED)
   */
  recall() {
    if (this.state === S.DOCKED || this.state === S.EXPENDED) return false;

    // HOLDING_CATCH: home at her strut tip with a parked catch, so recall is meaningless: refuse it. Falling through
    // would clear capturedDebris with no CATCH_PROCESSED/score/salvage and leave _armPinned/_capturedByArm/
    // _armPinPos set on the debris (ghost pin).
    if (this.state === S.HOLDING_CATCH) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Recall refused — holding a catch. Furnace transfer clears her.`,
        priority: 'warning',
      });
      return false;
    }
    // carrying a catch to a furnace: the carry ends at her dock on its own
    if (this._carry) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Recall refused — carrying a catch to a furnace. She comes home when it is done.`,
        priority: 'warning',
      });
      return false;
    }

    if (this.isDetached) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Cannot recall. Tether severed. Daughter is autonomous.`,
        priority: 'warning',
      });
      return false;
    }

    this._manualMode = false;
    this._manualCapture = false;
    this._trawlTimer = 0;
    this._trawlingMode = false;
    this._webShotTarget = null;

    // Already reeling: nothing to do. RETURNING (FEEP flight home, e.g. after a failed catch with REEL_HOME off)
    // falls through: she is on her line, so the strut reel winds her in. Other states: REELING (zero-fuel return).
    if (this.state === S.REELING) return 'already';

    // STATION_KEEP has its own bookkeeping (SK target flag, orbit rates, polar-axis cache): route through the
    // dedicated zero-fuel strut reel so it is torn down cleanly, not left dangling on the captured debris.
    if (this.state === S.STATION_KEEP) {
      this.capturedDebris = null;
      this.target = null;
      this.reelFromStationKeep();
      eventBus.emit(Events.ARM_RECALLED, { armId: this.id });
      return true;
    }

    // Tethered ⇒ ALWAYS reeled home on winch power (reel motor is on the mothership), even out of fuel, adrift or
    // stuck; the FEEP reserve funds tether tension + the soft-dock arrest so she eases in rather than slamming the strut.
    const lowFuel = this.fuel <= (Constants.ARM_RESERVE_FUEL ?? 2);
    this.capturedDebris = null;
    this.target = null;
    // ONE comms line per recall: under REEL_HOME `_transitionTo` says "Reeling <name> home: <m> m, about <s> s."
    // itself, so the low-fuel reassurance rides on that line instead of being a second one.
    this._rhReelNote = (lowFuel && this._rhOn()) ? ' Winch power, no FEEP needed.' : '';
    this._transitionTo(S.REELING);
    const noteSaid = this._rhReelNoteSaid === true;
    this._rhReelNote = ''; this._rhReelNoteSaid = false;
    if (lowFuel && !noteSaid) {
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

  /**
   * Sever the tether and enter free-flight on current velocity + remaining FEEP fuel. Cannot refuel or recall;
   * must self-deorbit after capture.
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

    this.tetherLength = 0;

    // hide immediately (_updateTether also does)
    if (this.tetherLine) {
      this.tetherLine.visible = false;
    }

    eventBus.emit(Events.ARM_DETACHED, {
      armId: this.index,
      position: this.position.clone(),
      fuelRemaining: this.fuel,
      hasDebris: this.capturedDebris !== null,
    });

    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `Houston: ${this.displayName}. Tether severed. COWBOY! Free-flight on own fuel.`,
      priority: 'HIGH',
    });

    console.log(`[ArmUnit] ${this.id} DETACHED (fuel: ${this.fuel.toFixed(1)}%)`);
    return true;
  }

  enableManual() {
    if (this.state === S.DOCKED || this.state === S.EXPENDED) return;
    this._manualMode = true;
    eventBus.emit(Events.ARM_STATE_CHANGE, { armId: this.id, manual: true });
  }

  disableManual() {
    this._manualMode = false;
    eventBus.emit(Events.ARM_STATE_CHANGE, { armId: this.id, manual: false });
  }

  /** @returns {boolean} Whether this arm is in manual pilot mode */
  isManual() {
    return this._manualMode;
  }

  /**
   * Manual thrust from ARM PILOT input. Direction is arm-local: +Z = forward (toward target), +X = right, +Y = up.
   * @param {{ x: number, y: number, z: number }} direction - Normalized thrust direction
   * @param {boolean} fine - Shift held: reduced thrust
   * @param {number} dt - Delta time
   */
  applyManualThrust(direction, fine, dt) {
    if (!this._manualMode) return;
    // No usable propellant → thrusters offline: protect the emergency reserve (held for a safe reel-home).
    if (this.state === S.ADRIFT || this.fuel <= (Constants.ARM_RESERVE_FUEL ?? 0)) return;
    if (this._powerOff()) return;   // flat battery: the thrusters are off (a tethered daughter is ADRIFT before this)

    // No gamified multiplier: the crossbow gives the initial velocity, FEEP only corrects.
    const thrustMag = this._computeMetalThrust();
    const thrust = fine ? thrustMag * 0.25 : thrustMag;
    const accel = thrust / this.config.mass;
    const dv = accel * dt;

    // arm-local → world; forward = toward target, else current velocity direction
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

    this.velocity.addScaledVector(right, direction.x * dv);
    this.velocity.addScaledVector(up, direction.y * dv);
    this.velocity.addScaledVector(forward, direction.z * dv);
    this.power.markEngine();   // thrusting: her engine bills its rating this frame
  }

  /**
   * Switch active FEEP metal; only the current, alternate or default (indium) slot is allowed.
   * @param {string} metalId
   * @returns {boolean} success
   */
  switchMetal(metalId) {
    const metals = Constants.ION_THRUSTER_METALS;
    if (!metals[metalId]) return false;

    if (metalId !== this._currentMetal && metalId !== this._alternateMetal && metalId !== 'indium') return false;

    const oldMetal = this._currentMetal;
    this._currentMetal = metalId;

    const metalData = metals[metalId];
    this._metalIsp = (metalData.ispMin + metalData.ispMax) / 2; // midpoint default

    eventBus.emit(Events.FEEP_METAL_CHANGED, {
      armId: this.id,
      metal: metalId,
      ispRange: [metalData.ispMin, metalData.ispMax],
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

  /** @returns {object} the active metal's ION_THRUSTER_METALS entry (indium fallback) */
  getCurrentMetalData() {
    return Constants.ION_THRUSTER_METALS[this._currentMetal] || Constants.ION_THRUSTER_METALS.indium;
  }

  /**
   * @private FEEP thrust F = 2 * eta * P / (g0 * Isp) (ion-beam power = eta * P = F * v_e / 2, v_e = g0 * Isp), see
   * docs/research/2026-10-ion-real.md. P is the thruster's electrical INPUT power (IT.BEAM_POWER_* holds the input
   * watts; the name is old). Higher ISP = lower thrust.
   * (Real FEEP systems run lower than eta 0.6: Enpulsion IFM Nano, 0.35 mN at 40 W; information only.)
   * Falls back to config.thrust if ION_THRUSTER_METALS not available.
   * @returns {number} thrust in Newtons
   */
  _computeMetalThrust() {
    const IT = Constants.ION_THRUSTER;
    if (!IT) return this.config.thrust;
    const inputPower = this.type === 'weaver' ? IT.BEAM_POWER_WEAVER : IT.BEAM_POWER_SPINNER;
    const g0 = Constants.G0;
    return 2 * IT.EFFICIENCY * inputPower / (g0 * this._metalIsp);
  }

  /**
   * Manual net deploy from ARM PILOT: straight to NETTING, bypassing auto-approach.
   * @returns {boolean}
   */
  manualNetDeploy() {
    if (this.state !== S.TRANSIT && this.state !== S.APPROACH) return false;
    if (!this.target) return false;
    if (this._inspectOnlyRefuses()) return false;     // big-rules R2

    // Inventory gate mirrors captureFromStationKeep: fail loudly when out of nets, not a silent NETTING with a
    // console.warn fallback inside _updateNettingFSM and no UI cue.
    if (Constants.isFeatureEnabled('CAPTURE_NET') && this._netInventory <= 0) {
      eventBus.emit(Events.NET_EMPTY_CLICK, { armId: this.id });
      audioSystem.playDeny();
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: this.displayName,
        text: daughterOutOfNetsLine(),   // DECISIONS §33 row 8: nets refill only at the resupply stop (not "return to mother")
        channel: 'CMD',
        priority: 'warning',
      });
      return false;
    }

    this._manualMode = false;
    this._manualCapture = true; // flag for scoring
    this._transitionTo(S.NETTING);
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `${this.displayName}: Net deployed. Attempting capture`,
      priority: 'info',
    });
    return true;
  }

  /**
   * Launch speed for the next crossbow fire, clamped to the spring tier's max.
   * @param {number} speed - Desired launch speed in m/s
   */
  setLaunchSpeed(speed) {
    const tier = SPRING_TIERS[this.springTier];
    this.launchSpeed = clamp(tier.maxSpeed, CROSSBOW_LAUNCH_SPEED_MIN, speed);
  }

  /**
   * Laser ablation (de-spin/nudge); only in TRANSIT or APPROACH.
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
   * Pulse scan (arm as distributed sensor node); only when DOCKED.
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
   * @param {number} tier - Spring tier index (shop upgrade)
   */
  setSpringTier(tier) {
    this.springTier = clamp(SPRING_TIERS.length - 1, 0, tier);
    this.launchSpeed = Math.min(this.launchSpeed, SPRING_TIERS[this.springTier].maxSpeed);
  }

  /**
   * The tier ladder drives the LIVE tether length (config.tetherMax: the deploy gate, tether-limit recall and
   * position clamps read it). The per-type ratio (spinner 500 m / weaver 2000 m at T1) is carried up the ladder.
   * Break strength follows the tier.
   * @param {number} tier - Tether tier index (shop upgrade)
   */
  setTetherTier(tier) {
    this.tetherTier = clamp(TETHER_TIERS.length - 1, 0, tier);
    const t = TETHER_TIERS[this.tetherTier];
    const typeRatio = (this.type === 'weaver')
      ? 1
      : Constants.SPINNER_TETHER_LENGTH / Constants.WEAVER_TETHER_LENGTH;
    this.config.tetherMax = Math.round(t.maxLength * typeRatio);
    this.tetherBreakStrength = t.breakStrength;
  }

  /**
   * Meridian sweep angle: α=0 → stowed (−Y), α=π/2 → equatorial (outward), α=π → zenith (+Y).
   * @returns {number} Current aim alpha in radians [0, π]
   */
  getAimAlpha() {
    return this._aimAlpha;
  }

  /**
   * Set the aim meridian sweep angle, clamped to [STRUT_SWEEP_MIN, STRUT_SWEEP_MAX] (0 to π); per-frame delta
   * clamped to STRUT_SLEW_RATE × dt.
   *
   * With an `ease` the strut does not start and stop dead: the move from the angle it is at when the ease begins to
   * `alpha` speeds up at STRUT_EASE_ACCEL, coasts at a peak (never above AIM_TURN_STRUT_PACE, 15°/s: the mother's
   * turn keeps its pace) and slows down at the same rate, lasting `ease.durationS` (or, when that is 0 / missing /
   * shorter than the move can be done, as short as it can be). The launch aim uses it so the strut and the mother's
   * turn end together. The ease is keyed by the `ease` object and the target angle: the same object and angle go on
   * with the move (call it once a frame with the same `ease`), a new object or angle starts a new move from where
   * the strut is. A call without an `ease`, or a snap (dt = 0), ends it. Callers that pass none keep the
   * constant-rate slew.
   *
   * @param {number} alpha — target angle in radians [0, π]
   * @param {number} [dt=0] — frame deltaTime for slew-rate clamping; 0 snaps immediately (initialization).
   * `ease.topRadS` / `ease.accelRadS2` (both optional) replace that peak and ramp: the opening eases its strut move at the
   * strut's own top speed (STRUT_SLEW_RATE) over OPENING_EASE_S. The clamp to STRUT_SLEW_RATE below still applies.
   * @param {{durationS?:number, topRadS?:number, accelRadS2?:number}|null} [ease=null] — ease the move (see above)
   * @returns {boolean} always true
   */
  setAimAlpha(alpha, dt = 0, ease = null) {
    const V5 = Constants.OCTOPUS_V5;
    const target = clamp(V5.STRUT_SWEEP_MAX, V5.STRUT_SWEEP_MIN, alpha);

    if (dt > 0) {
      let desired = target;
      // The opening's own moves pass their own top speed and ramp (`topRadS`, `accelRadS2`); no one else does.
      const accel = (ease && ease.accelRadS2 > 0) ? ease.accelRadS2 : V5.STRUT_EASE_ACCEL;
      if (ease && accel > 0) {
        let e = this._aimEase;
        if (!e || e.src !== ease || e.to !== target) {
          const d = Math.abs(target - this._aimAlpha);
          const top = (ease.topRadS > 0) ? ease.topRadS : V5.AIM_TURN_STRUT_PACE;
          const prof = strutEaseProfile(d, accel, top, ease.durationS || 0);
          e = this._aimEase = {
            src: ease, from: this._aimAlpha, to: target, sign: target >= this._aimAlpha ? 1 : -1,
            d, a: accel, v: prof.v, T: prof.T, t: 0,
          };
        }
        e.t += dt;
        desired = e.t >= e.T ? e.to : e.from + e.sign * strutEaseDistance(e, e.t);
      } else {
        this._aimEase = null;
      }
      const maxDelta = V5.STRUT_SLEW_RATE * dt;
      const delta = desired - this._aimAlpha;
      const clampedDelta = clamp(maxDelta, -maxDelta, delta);
      this._aimAlpha += clampedDelta;
    } else {
      this._aimEase = null;
      this._aimAlpha = target;
    }
    return true;
  }

  /**
   * The shortest time (s) an eased `setAimAlpha` move from the strut's angle now to `alpha` takes, at the mother's
   * turn pace (AIM_TURN_STRUT_PACE, 15°/s), not the faster free swing: the aim turn is timed by this.
   * 0 when she is already there (or the ease is not configured: the constant-rate time then).
   * @param {number} alpha — target angle in radians [0, π]
   * @returns {number}
   */
  aimEaseMinTime(alpha) {
    const V5 = Constants.OCTOPUS_V5;
    const target = clamp(V5.STRUT_SWEEP_MAX, V5.STRUT_SWEEP_MIN, alpha);
    const d = Math.abs(target - this._aimAlpha);
    if (!(V5.STRUT_EASE_ACCEL > 0)) return d / V5.AIM_TURN_STRUT_PACE;
    return strutEaseProfile(d, V5.STRUT_EASE_ACCEL, V5.AIM_TURN_STRUT_PACE, 0).T;
  }

  /**
   * High-recoil zone: the strut points mostly axially (near stowed or zenith).
   * @returns {boolean} true if α < HIGH_RECOIL_ALPHA_LOW or α > HIGH_RECOIL_ALPHA_HIGH
   */
  isHighRecoilZone() {
    const V5 = Constants.OCTOPUS_V5;
    return this._aimAlpha < V5.HIGH_RECOIL_ALPHA_LOW ||
           this._aimAlpha > V5.HIGH_RECOIL_ALPHA_HIGH;
  }

  /**
   * World-space tether anchor at the REEL position on the strut: the reel cartridge (85% of strut length from the
   * pivot), not the strut tip. Uses _reelOffset set by PlayerSatellite._updateStruts() (PlayerSatellite local
   * frame); falls back to dockOffset (strut tip), then to arm.position.
   * @param {THREE.Vector3} motherPos — mother world position (scene units)
   * @param {THREE.Quaternion} motherQuat — mother world orientation
   * @returns {THREE.Vector3} World-space reel position (scene units)
   */
  getTetherAnchorWorldPosition(motherPos, motherQuat) {
    const localOffset = this._reelOffset || this.dockOffset;
    if (localOffset) {
      const offset = localOffset.clone();
      if (motherQuat) offset.applyQuaternion(motherQuat);
      return offset.add(motherPos);
    }

    // no strut geometry: arm world position
    return this.position.clone();
  }

  /**
   * World-space NET-LAUNCH MUZZLE: the front face of the fore net-launcher canister (the `${this.id}-net-launcher`
   * housing built in _createMesh; `_netMuzzleLocal` is captured there from the same variables that place the mesh,
   * so it cannot drift from the visible hardware). Mirrors PlayerSatellite.getNetPodPositionInto: the
   * allocation-free launch anchor for the net projectile, ceremony visual and in-flight net tether.
   *
   * READ-ONLY on transforms (CONVENTIONS.md §10 Rule B): composes this.position with the CURRENT group quaternion
   * (owned by PlayerSatellite.postArmUpdate when docked, the ArmUnit attitude branch when deployed); never writes either.
   *
   * NOTE: NET tether/launch anchor only. The DAUGHTER-HAUL tether anchor (strut reel cartridge,
   * getTetherAnchorWorldPosition) is a DIFFERENT tether and intentionally stays strut-anchored.
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

  /** Does NOT reset springTier/tetherTier (persistent upgrades). */
  reset() {
    // a carry in progress lets go of its tip reservation, the strut reservation and the radiator hold first
    if (this._carry) this.abortCarry('reset', { quiet: true });
    this._carryGaveUp = false;
    this.state = S.DOCKED;
    this.fuel = 100;
    this.coldGasKg = this._coldGasBottleKg();   // the bottle resets wherever the FEEP fuel does
    this.power.reset();                         // the pack too: full, 20 °C
    this._adriftCause = null;
    this._indiumSwapT = -1;                     // no swap survives a reset
    this.tetherLength = 0;
    this.target = null;
    this.capturedDebris = null;
    this.heldCatches = [];               // the parked cargo rack resets too
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
    this._lastParentQuat = null;   // clear cached parent quaternion
    this._frameParentQuat = null;
    this._prevParentPos = null;
    this._frameParentPos = null;   // this frame's parent position

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

    this._aimAlpha = 0;

    this.mesh.visible = false;
    this.tetherLine.visible = false;
  }

  /**
   * @param {number} dt - Real-time delta in seconds
   * @param {THREE.Vector3} parentPos - Core satellite world position
   * @param {THREE.Quaternion} [parentQuat] - Core satellite quaternion
   */
  update(dt, parentPos, parentQuat) {
    _seatFrameBegin(this, dt);                 // the seat-solve budget runs while a daughter is updating
    try { return this._updateBody(dt, parentPos, parentQuat); } finally { _seatMetered = false; }
  }

  /** @private The body of `update` (wrapped so the seat-solve budget is switched off again on every exit). */
  _updateBody(dt, parentPos, parentQuat) {
   this.stateTimer += dt;
   this._lastDt = dt;   // PlayerSatellite.postArmUpdate eases her attitude by this frame's time
   this._rackClockS = (this._rackClockS || 0) + dt;   // times a cell-down slide (stateTimer is reset by the unload)

   // §11.3: reaction-wheel momentum bleed (magnetorquers), every state.
   this._tickWheelDecay(dt);

   // §11.5: capture-torque settle, every state (the transient spans GRAPPLED → REELING, must survive state changes
   // and follow external releases; inert single null-check when no settle is live).
   this._tickCaptureSettle(dt);
   // the catch keeps turning until it is seated, then her gas cancels the spin (both inert without a carried spin)
   this._tickHeldSpin(dt);
   this._tickSeatSpin(dt);

   // --- Orbital frame correction (APPLY): keep deployed arms in the ship's co-moving frame ---
   // MUST run BEFORE the state machine so _updateTransit / _updateApproach see this.position in the CURRENT co-moving
   // frame (matching the freshly-propagated target._scenePosition from DebrisField); after it, the arm sat one
   // orbital step behind the target (~1900 m phantom gap, no convergence).
   // DOCKING is corrected too: _updateDocking only lerps 5 %/frame to the dock point, so on an orbiting ship she
   // fell behind by ~19 frames of ship travel (measured 2.4 km at 60 fps over one DOCKING, then snapped home at DOCKED).
   if (parentPos) {
     // Remember THIS frame's parent position: `position` is shifted to it just below while `_prevParentPos` stays
     // last frame's until the end of `update`, so a range measured between them (a capture mid-frame) reads one
     // whole orbital step (~7.7 km live) too far.
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
     case S.HAULING:    this._updateHauling(dt, parentPos, parentQuat); break;
     case S.REELING:    this._updateReeling(dt, parentPos, parentQuat); break;
     case S.RETURNING:  this._updateReturning(dt, parentPos, parentQuat); break;
     case S.DOCKING:    this._updateDocking(dt, parentPos, parentQuat); break;
      case S.RELOADING:  this._updateReloading(dt, parentPos, parentQuat); break;
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
   this._updateColdGasRefill(dt);       // docked on her strut, the mother's gas tops her bottle up
   this._updateIndiumSwap(dt);          // docked on her strut, the mother's indium store swaps a fresh ion-fuel cartridge in

   // --- Orbital frame correction (STORE): update _prevParentPos AFTER the state machine, separate from the APPLY
   // step above, so _updateTransit's drift `(parentPos - _prevParentPos)` sees the per-frame delta (last frame's
   // parentPos → this frame's), not zero.
    if (parentPos) {
      if (!this._prevParentPos) {
        this._prevParentPos = new THREE.Vector3();
      }
      this._prevParentPos.copy(parentPos);
    }

    // --- Lead-aim: the selected target's velocity RELATIVE TO THE ARM, tracked every frame while a target exists
    // (so STATION_KEEP has an estimate by the time NETTING fires). The net is propagated in the ARM's co-orbiting
    // frame (CaptureNet re-anchors `net.position = arm.position + launchDir × distanceTraveled` each flight frame),
    // so the lead velocity is the target velocity AS SEEN FROM THE ARM, not the raw scene-space delta: in a settled
    // STATION_KEEP both share the orbital drift, the relative velocity is ≈0 and the shot must fly dead straight
    // (leading by the shared drift bent every SK shot off-axis). Both deltas are sampled in this same block
    // (identical frame timing). Units: scene units/s (NOT m/s); `launchSpeedScene = LAUNCH_SPEED × M` in
    // computeLeadAim matches.
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

    if (this._webShotCooldown > 0) {
      this._webShotCooldown -= dt;
      if (this._webShotCooldown < 0) this._webShotCooldown = 0;
    }

    // Legacy fuel burn. Exempt: DEORBITING (_updateDeorbiting) and TRAWLING (_updateTrawling) burn their own rates,
    // WEB_SHOT is paid upfront in fireWebShot(), plus REELING, RELOADING, LAUNCHING, ABLATING, SCANNING.
    if (this.state !== S.DOCKED && this.state !== S.EXPENDED &&
        this.state !== S.DEORBITING && this.state !== S.TRAWLING &&
        this.state !== S.WEB_SHOT && this.state !== S.REELING &&
        this.state !== S.RELOADING && this.state !== S.LAUNCHING &&
        this.state !== S.ABLATING && this.state !== S.SCANNING &&
        this.state !== S.ADRIFT &&
        !this._carry) {              // the carry bills its own push, once (beginCarry's fuel check, _carryBeginOut)
      this._consumeFuel(dt);
    }

    // Her battery and heat, AFTER every ion and gas debit of this frame (the state machine, `_consumeFuel`) so the engine bills
    // the frame it fired in: loads, solar, the mother's charge while docked, flat → ADRIFT (DECISIONS §53 row 3).
    this._updateDaughterPower(dt);

    // max-distance kill so detached arms don't drift forever
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

    // tether visual; mother-side anchor = strut tip when available
    this._updateTether(parentPos, parentQuat, dt);
    this._updateBridle();  // bridle visibility mirrors tether

    this.group.position.copy(this.position);

    // --- Attitude control: orient the daughter along its heading ---
    // DOCKED/DOCKING/RELOADING/HOLDING_CATCH: skipped (mesh hidden or strut-aligned). PlayerSatellite.postArmUpdate
    //   owns them (live strut basis sg.strutDir/azRad, composes the mother's world quat): DOCKED snaps; DOCKING
    //   slerps onto the strut (no pop at dock); HOLDING_CATCH snaps to the strut basis. A SINGLE owner avoids the
    //   override-fight class of bug (CONVENTIONS.md §10 Rule B) that rotated the parked daughter to the mother bus
    //   basis and rendered the tether the wrong way.
    // LAUNCHING: skipped, keeping the strut-aligned orientation postArmUpdate set on the last DOCKED frame (clamp hold
    //   or just launched along the strut). postArmUpdate uses setFromUnitVectors (no roll constraint) while lookAt
    //   uses Earth-radial up (different roll), so slerping toward parentQuat or a lookAt target would rotate her
    //   disorientingly. Attitude picks up in TRANSIT.
    // APPROACH/NETTING: nose (+Z) toward target. All other deployed states: nose (+Z) along velocity (prograde).
    // Fallback: inherit the mother's orientation (parentQuat) when no heading is available.
    const skipAttitude = (this.state === S.DOCKED || this.state === S.DOCKING ||
                         this.state === S.RELOADING || this.state === S.LAUNCHING ||
                         this.state === S.HOLDING_CATCH ||
                         this._carry != null);      // the carry states seat her in her docked attitude themselves
    if (!skipAttitude) {
      let headingDir = null;
      let reelHeading = false;

      // Target-tracking states face the debris (STATION_KEEP included: inheriting the mother's prograde caused
      // 180° flips).
      if ((this.state === S.APPROACH || this.state === S.NETTING || this.state === S.STATION_KEEP) &&
          (this.target || this._stationKeepTarget)) {
        const _attTarget = this._stationKeepTarget || this.target;
        const tPos = _attTarget._scenePosition || _attTarget.position || _attTarget;
        headingDir = this._tmpVec.subVectors(tPos, this.position);
        if (headingDir.lengthSq() < 1e-20) headingDir = null;
        else headingDir.normalize();
      }

      // Whole-haul reel attitude (REEL_PROFILE_V2): during REELING point the nose (+Z) at the LIVE strut-tip dock so
      // the +Y wishbone bridle (and the tether) trails off-axis from the ±Z FEEP plume (the yoke tether-plume
      // clearance the FEEP-during-reel behaviours depend on). Held for the entire haul, recomputed each frame to track
      // a maneuvering mother.
      // Inside the arrest approach the aim is offset ARREST_STEER_DEG away from the bridle side, distance-blended via
      // _applyArrestSteerToHeading (single owner: this branch; the offset is part of the SAME aim this slerp tracks,
      // so no competing quaternion writer and no snap at the window boundary).
      // reel-home: while her net winds the catch in she turns her nose (+Z) to it, at the reel's rate.
      let rhQuat = null;
      if (!headingDir && this.state === S.GRAPPLED && this._rhPinned && this._rhOn()
          && this._rhSep.lengthSq() > 1e-20) {
        headingDir = this._tmpVec.copy(this._rhSep).normalize();
        reelHeading = true;
      }
      // reel-home: on the strut reel she goes home TAIL FIRST: her -Z at the strut tip, her +Z and the catch leading
      // away, roll set so DOCKING only trims residuals. Takes the place of the "+Z at the dock" aim below.
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
        // Faster slerp for target-tracking states so the daughter snaps to face debris promptly (0.05 took ~1 s to
        // converge: too slow for APPROACH/STATION_KEEP).
        let sRate;
        if (reelHeading) {
          sRate = (Constants.YOKE_CLEARANCE && Constants.YOKE_CLEARANCE.REEL_ATTITUDE_SLERP) ?? 0.1;
        } else {
          sRate = (this.state === S.APPROACH || this.state === S.STATION_KEEP || this.state === S.NETTING)
            ? 0.15    // close-range operations
            : 0.05;   // gentle for TRANSIT (cosmetic, less disorienting on long flights)
        }
        this.group.quaternion.slerp(targetQuat, sRate);
      } else if (parentQuat) {
        // No heading (velocity ≈ 0 etc.): inherit the mother's orientation so daughters don't appear to
        // counter-rotate when the camera follows the mother's pitch.
        this.group.quaternion.slerp(parentQuat, 0.1);
      }
    }

    // Re-sync the tether line: _updateTether baked its counter-rotation from the PREVIOUS frame's group quaternion
    // and the slerp just now changed it. The vertices are group-local, so the stale counter-rotation swung the whole
    // line about her end by this frame's slerp delta (at TRANSIT -> REELING the heading flips ~180°, the 10 % slerp
    // turns her ~18° in one frame, and a 30 m line's strut-side end jumped 9 m).
    if (this.tetherLine.visible) this.tetherLine.quaternion.copy(this.group.quaternion).invert();

    // _updateReeling pinned the catch with her attitude from BEFORE the slerp above (up to ~18° on the first reel
    // frame: the gap wobbled 0.00-0.05 m instead of 0.03). Pin once more so the catch sits one net gap off her end
    // in the drawn frame (ArmManager draws it from _armPinPos).
    if (this.state === S.REELING && this.capturedDebris && this.capturedDebris._armPinned) {
      if (!(this._rhArrived && this._rhOn() && this._rhPinInCell())) this._pinCatchToSelf(parentPos);
    } else if (this.state === S.GRAPPLED && this._rhPinned && this._rhArrived && this.capturedDebris) {
      this._rhPinInCell();
    }
    // reel-home: the strut/mother geometry ArmManager reads (the swing-plane angle nearest her, how far she is off it)
    if (this._rhHome && parentPos) this._rhStrutAim(parentPos, parentQuat);

    this._updatePlumes(dt);

    // steady look-puffs of her cold-gas jet while it brakes the reel (only while it fires)
    this._updateGasStream(dt);

    this._updateAttitudePuffs();

    this._updateStatusLight(dt);

    this._updateSelectGlow(dt);   // pulse on the body facets while selected
  }

  /**
   * Arm status snapshot for the HUD.
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
      // §11.3 reaction-wheel scalar (DAUGHTER_NET_RECOIL): normalized launch-reaction momentum + saturation flag; 0/false when OFF.
      wheelMomentum: this._wheelMomentum,
      wheelSaturated: this._wheelSaturated,
      springCharged: this.springCharged,
      reloadProgress: this.reloadProgress,
      tetherTension: this.tetherTension,
      launchSpeed: this.launchSpeed,
      springTier: this.springTier,
      tetherTier: this.tetherTier,
      // The furnace cook is visible: only the rack's HEAD piece cooks (the queue is the anticipation), one fraction per arm.
      // frac = _digestProgress / digestSpanS(mass) (the ONE span-law home); sunScale drives the eclipse "embers until dawn"
      // look. null unless cooking.
      digest: (this.state === S.HOLDING_CATCH && this.heldCatches.length > 0)
        ? {
          frac: clamp01((this.heldCatches[0]._digestProgress || 0)
            / Constants.FURNACE_TRANSFER.digestSpanS(this.heldCatches[0].mass)),
          sunScale: this._digestSunScale ?? 1.0,
          queued: this.heldCatches.length - 1,
          kg: this.heldCatches[0].mass || 0,
        }
        : null,
    };
  }

  /**
   * The piece she is flying at was caught by something else (a net, the lasso, another daughter) or is gone: turn round
   * and reel home at once, with one line. A catch of her OWN (`_capturedByArm === this`) is not a loss. The line is said
   * once per piece (when `recall()` refuses she keeps her course and the line is not repeated every frame). A detached
   * daughter has no line to reel on and is left alone (her own landing rules apply).
   * @returns {boolean} true when she turned home
   * @private
   */
  _homeIfPieceLost() {
    const t = this.target;
    if (!t || this.isDetached) return false;
    const by = t._capturedByArm;
    const takenByOther = (t._captured === true || t._armPinned === true || !!by) && by !== this;
    const why = t.alive === false ? 'gone' : (takenByOther ? 'caught' : null);
    if (!why) { this._pieceLostSaidFor = null; return false; }
    if (this._pieceLostSaidFor !== t) {
      this._pieceLostSaidFor = t;
      eventBus.emit(Events.COMMS_MESSAGE, { text: pieceLostLine(this.displayName, why), priority: 'warning' });
    }
    return this.recall() === true;
  }

  /** @private Get target scene position (computed by DebrisField each frame) */
  _getTargetScenePos() {
    if (!this.target) return null;
    return this.target._scenePosition || null;
  }

  _transitionTo(newState) {
    const old = this.state;
    if (old === S.NETTING) this._firedNet = null;  // clear net ref when leaving NETTING
    // §11.4: the recoil transient only integrates inside the SK/NETTING hold loops; leaving that pair hands control to a
    // controller with its own residuals (GRAPPLED reel, RETURNING burn, ...). Clear so a stale kick can't replay on re-entry.
    if (this._recoilActive
        && (old === S.STATION_KEEP || old === S.NETTING)
        && newState !== S.STATION_KEEP && newState !== S.NETTING) {
      this._clearRecoilKick();
    }
    this.state = newState;
    this.stateTimer = 0;
    this._rhNoteTransition(old, newState);       // the reel-start / "is home" lines and the reel's starting distance
    eventBus.emit(Events.ARM_STATE_CHANGE, {
      armId: this.id, from: old, to: newState,
    });
    if (newState === S.DOCKED || newState === S.RELOADING) {
      this._captureToolKind = 'NET';   // reset capture-verb to default
    }
    // fresh capture/dock cycle: re-arm the SNUG window, catch-cleared guard and re-dock arrest (REEL_PROFILE_V2)
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
    // the residual belongs to one DOCKING -> RELOADING run; any other state forgets it (re-seeded from where she is on re-entry)
    if (newState !== S.DOCKING && newState !== S.RELOADING) this._seatReady = false;
    if (newState === S.GRAPPLED) {
      this._rhPinned = false;
      this._rhNetDone = false;
      this._rhArrived = false;
      this._rhHome = false;
    }
    if (newState !== S.REELING) this._rhBraking = false;
    if (newState !== S.GRAPPLED && newState !== S.REELING) {   // the barrier and the shared pull belong to GRAPPLED -> REELING only
      this._pairWaiting = false; this._pairWaitS = 0; this._pairGo = null; this._pairTogether = false;
    }
    if (newState === S.REELING && this._pairWaiting) {          // into REELING while still held at the barrier = a recall, not the barrier's release (that clears `_pairWaiting` first)
      this._pairWaiting = false; this._pairWaitS = 0; this._pairGo = null; this._pairTogether = false;
    }
    if (newState === S.REELING) {
      this._rhReelV = 0;                    // the reel pulls her up from rest (no jump to peak)
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
      this._rhHold = null;                  // a new reel starts with no hold and no floor refusal
      this._rhFloorRefused = false;
      this._rhFloorSpent = false;
    } else if (newState === S.DOCKING) {
      // home: the mother turn is hers no more (the strut stays reserved to HOLDING_CATCH). DOCKING that came off the
      // strut reel bills no thruster fuel: the reel did the work.
      this._rhDockFree = old === S.REELING && this._rhHome && this._rhOn();
      this._rhHome = false;
    } else if (newState !== S.GRAPPLED) {
      this._rhEnd();
    }
    // STATION_KEEP entry: refresh the tool recommendation; selectedTool defaults to it (player can re-cycle)
    if (newState === S.STATION_KEEP && Constants.isFeatureEnabled('DAUGHTER_MULTITOOL')) {
      this._refreshToolRecommendation();
    }
    // Release the tool-closing CA exemption on ANY exit from a closing state (MAGNETIC_GRAPPLE / GRIPPER_GRAPPLE /
    // PAD_CONTACT: success, failure or external recall/deorbit) so the AUTOPILOT_TARGET_LOCK set on entry can never leak.
    if ((old === S.MAGNETIC_GRAPPLE || old === S.GRIPPER_GRAPPLE || old === S.PAD_CONTACT)
        && this._toolLockedDebrisId != null) {
      eventBus.emit(Events.AUTOPILOT_TARGET_UNLOCK, { debrisId: this._toolLockedDebrisId });
      this._toolLockedDebrisId = null;
    }
    this._updateMetalIspForPhase(newState);

    // Discrete attitude cold-gas puffs (visual-only, pooled), fired on attitude EVENTS, not per frame: deploy separation,
    // SK entry, dock settle. Tool-cycle re-aim puffs come from cycleTool().
    if (newState === S.LAUNCHING || newState === S.UNDOCKING) {
      this._fireAttitudePuffs('deploy');
    } else if (newState === S.STATION_KEEP) {
      this._fireAttitudePuffs('sk');
    } else if (newState === S.DOCKING && (old === S.REELING || old === S.RETURNING)) {
      this._fireAttitudePuffs('dock');
    }
  }

  /** Set _metalIsp from the flight phase, clamped to the metal's [ispMin, ispMax]. @private */
  _updateMetalIspForPhase(phase) {
    const IT = Constants.ION_THRUSTER;
    if (!IT) return;
    const metalData = this.getCurrentMetalData();
    if (!metalData) return;

    const ispMap = {
      [S.TRANSIT]:       IT.ISP_TRANSIT,
      [S.APPROACH]:      IT.ISP_APPROACH,
      [S.STATION_KEEP]:  IT.ISP_STATIONKEEP,
      [S.RETURNING]:     IT.ISP_RETURN,
      [S.DEORBITING]:    IT.ISP_DEORBIT,
    };

    const desired = ispMap[phase];
    if (desired !== undefined) {
      this._metalIsp = clamp(desired, metalData.ispMin, metalData.ispMax);
    }
  }

  /**
   * V5 Crossbow spring impulse: E = ½kd², v = d√(k/m). All velocity comes from spring energy.
   * @private
   * @returns {number} Actual launch speed used (m/s)
   */
  _applyLaunchImpulse() {
    const tier = SPRING_TIERS[this.springTier];
    const isWeaver = this.config.type === 'weaver';
    const armMass = isWeaver ? V5_WEAVER_MASS : V5_SPINNER_MASS;
    const springK = isWeaver ? CROSSBOW_SPRING_K_WEAVER : CROSSBOW_SPRING_K_SPINNER;

    const speed = Math.min(this.launchSpeed, tier.maxSpeed);

    // E = ½kd²; effective k scales as v² for variable launch speed (springK and CROSSBOW_DRAW_DISTANCE validate the
    // energy budget; the impulse itself is applied directly as velocity for numerical stability)
    const launchVelocity = speed * M;  // Convert to game units

    if (this.launchDirection) {
      this.velocity.copy(this.launchDirection).multiplyScalar(launchVelocity);
    } else {
      // Fallback: world-space dock direction so the impulse pushes outward even when the mothership is rotated.
      const dir = this._worldDockDirection(this._lastParentQuat);
      this.velocity.copy(dir).multiplyScalar(launchVelocity);
    }

    // Store actual launch speed for TRANSIT V_CAP (arm should coast, not accelerate)
    this._launchSpeedMps = speed;

    this.springCharged = false;

    // includes launchDirection for station-keeping recoil compensation
    eventBus.emit(Events.CROSSBOW_FIRE, {
      armIndex: this.index,
      speed: speed,
      springTier: this.springTier,
      armMass: armMass,
      launchDirection: this.velocity.clone().normalize(),
      // launch-kick (owner 10-24 "1 a"): where she lets go (world, scene units: her strut tip) and what leaves with her (dry mass
      // plus any cargo she carries); the mother's turn from the push is r x J about her centre of mass (`_applyCrossbowRecoil`).
      launchPosition: this.position.clone(),
      launchMassKg: armMass + ((this.capturedDebris && this.capturedDebris.mass) || 0)
        + (Array.isArray(this.heldCatches) ? this.heldCatches.reduce((a, h) => a + ((h && h.mass) || 0), 0) : 0),
    });

    // Calculate reload duration based on energy stored
    // E = ½ × m × v², reload time = E / (P × η)
    const energy = 0.5 * armMass * speed * speed;
    this.reloadDuration = energy / (CROSSBOW_RELOAD_POWER * CROSSBOW_WORM_GEAR_EFFICIENCY);

    return speed;
  }

  /**
   * World-space dock (deploy) direction: LOCAL dockOffset rotated by the parent's world quaternion, so arms always
   * deploy OUTWARD whatever the mothership's orientation.
   * @param {THREE.Quaternion|null} parentQuat - parent ship world quat (nullable)
   * @returns {THREE.Vector3} normalized world-space deploy direction
   * @private
   */
  _worldDockDirection(parentQuat) {
    const dir = this.dockOffset.clone();
    if (parentQuat) dir.applyQuaternion(parentQuat);
    return dir.normalize();
  }

  _updateDocked(dt, parentPos, parentQuat) {
    // Cache parent quat so externally-invoked deploy*() methods can derive a world-space launch direction. Owned
    // persistent quat: consumers (_worldDockDirection) read it at deploy time, never store it.
    this._lastParentQuat = parentQuat
      ? (this._lastParentQuatV || (this._lastParentQuatV = new THREE.Quaternion())).copy(parentQuat)
      : null;
    this._seatReady = false;   // clamped to the tip: no residual survives (covers a direct `.state =` set that skips _transitionTo)
    const offset = _dockOffTmp.copy(this.dockOffset);
    if (parentQuat) offset.applyQuaternion(parentQuat);
    this.position.copy(parentPos).add(offset);
    // Do NOT hide the daughter mesh here: PlayerSatellite.postArmUpdate() (right after armManager.update) owns
    // visibility; a docked daughter stays visibly clamped at the strut tip.
    this.tetherLine.visible = false;
    this.velocity.set(0, 0, 0);
  }

  /** UNDOCKING: legacy 2 s separation from the core; V5 uses LAUNCHING (crossbow spring release). */
  _updateUndocking(dt, parentPos) {
    this.mesh.visible = true;
    this.tetherLine.visible = true;

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
        this._applyLaunchImpulse();
        // departure event for audio (legacy UNDOCKING path)
        eventBus.emit(Events.ARM_SPRING_FIRED, {
          armId: this.id, type: this.type, speed: this.launchSpeed, mode: 'normal',
        });
        this._emitSpringReleasedLine();
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.displayName}: Clear of core. In transit`,
          priority: 'info',
        });
      }
    }
  }

  /**
   * LAUNCHING: V5 crossbow spring release sequence.
   * Phase 1: Magnetic clamp release (0..CROSSBOW_UNDOCK_TIME)
   * Phase 2: Spring release (CROSSBOW_UNDOCK_TIME..+ CROSSBOW_RELEASE_TIME)
   *
   * Until the spring fires she is still CLAMPED (part of the ship): every frame she rides her strut tip, from the same
   * pose source as DOCKED, whatever the mother does. The spring then pushes from the tip.
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
      this._springFired = true;
      this._applyLaunchImpulse();
      // actual departure moment: audio (woosh) keys off THIS event, not ARM_DEPLOYED (fires 1.5 s earlier at LAUNCHING
      // entry, during the clamp-release hold)
      eventBus.emit(Events.ARM_SPRING_FIRED, {
        armId: this.id, type: this.type, speed: this.launchSpeed,
        mode: this._trawlingMode ? 'trawl' : 'normal',
      });
      this._emitSpringReleasedLine();
    }

    if (this._springFired) {
      this.position.addScaledVector(this.velocity, dt);
      this.tetherLength = this.position.distanceTo(parentPos) / M;
    }

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
      }
      this._undockTimer = 0;
      this._springFired = false;
    }
  }

  /**
   * The ONE launch line, at the real moment (spring fired, she departs). Every launch path (target, free-fly, trawl,
   * ceremony, number key) goes through ARM_SPRING_FIRED, with or without the camera cut-scene.
   * @private
   */
  _emitSpringReleasedLine() {
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `${this.displayName}: Spring released. Separating`,
      priority: 'info',
    });
  }

  _updateTransit(dt, parentPos) {
    if (this._homeIfPieceLost()) return;
    if (this._manualMode) {
      // Manual mode: player controls velocity. Autopilot (controller, pings, thruster audio) is skipped: the approach beep
      // and thruster hum annoyed in ARM_PILOT mode.
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
      // Still check the approach threshold in manual mode: enableManual() fires during LAUNCH_CEREMONY_COMPLETE while still in
      // TRANSIT; without this gate she coasts forever and never reaches APPROACH.
      if (this.target) {
        const _tPos = this._getTargetScenePos();
        if (_tPos) {
          const _dist = _tPos.distanceTo(this.position);
          const _dSz = (this.target.sizeMeter) || 1;
          const _so = clamp(_dSz * Constants.STATION_KEEP.DEFAULT_STANDOFF_MULT, Constants.STATION_KEEP.DEFAULT_STANDOFF, Constants.STATION_KEEP.MAX_STANDOFF);
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
      return;
    }

    const targetPos = this._getTargetScenePos();
    if (!targetPos) {
      this.recall();
      return;
    }
    const toTarget = this._tmpVec.subVectors(targetPos, this.position);
    const dist = toTarget.length();

    // starting distance for the approach beep fraction
    if (this._startingDistance === 0 || dist > this._startingDistance) {
      this._startingDistance = dist;
    }
    if (this._startingDistance > 0) {
      const distFraction = Math.min(1, dist / this._startingDistance);
      eventBus.emit(Events.ARM_APPROACH_PING, { distanceFraction: distFraction, armId: this.id });
    }

    this.tetherLength = this.position.distanceTo(parentPos) / M;

    // tether limit (detached arms are free-flying: skipped)
    if (!this.isDetached && this.tetherLength >= this.config.tetherMax * 0.95) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Tether limit (${Math.round(this.config.tetherMax)}m). Recalling`,
        priority: 'warning',
      });
      // tutorial: detach hint trigger
      eventBus.emit(Events.TUTORIAL_TETHER_LIMIT, { armId: this.id });
      this.recall();
      return;
    }

    // ── Proportional controller with velocity matching ──
    // Mirrors the mother AutopilotSystem.js control law (§D quadratic braking + relV). arm.velocity is in the parent
    // co-moving frame (the orbital frame correction adds parentDelta each frame); driftVel compensates for the target's
    // different orbit.
    const DAP_T = Constants.DAUGHTER_AUTOPILOT;

    // Orbital drift velocity (target vs parent frame). Raw finite difference is noisy (cancellation when tDelta ≈ pDelta
    // for co-orbiting objects), so it is EMA-smoothed.
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

    const relVT = _relVel.subVectors(driftVelT, this.velocity);

    // Quadratic braking: v*(r) = min(V_CAP, √(2·A_BRAKE·posErr))
    // V_CAP = actual launch speed so the arm COASTS, never accelerates beyond spring speed
    const posErrM = dist / M;
    const effectiveVCap = this._launchSpeedMps || DAP_T.V_CAP;
    const aBrakeT = DAP_T.MAX_ACCEL * DAP_T.BRAKE_FRACTION;
    const vStarMT = Math.min(effectiveVCap, Math.sqrt(2 * aBrakeT * posErrM));
    const vStarT = vStarMT * M; // scene units/s

    const goalDirT = _goalDir.copy(toTarget).normalize();
    const velCtrlErrT = goalDirT.multiplyScalar(vStarT).add(relVT);

    // Commanded impulse = KP × velCtrlErr, clamped by MAX_ACCEL × gameDt
    const dvCmdT = velCtrlErrT.multiplyScalar(DAP_T.KP_VEL);
    const gameDtT = dt * TimeAuthority.BASE_SCALE;
    const maxDvT = DAP_T.MAX_ACCEL * M * gameDtT;
    const dvMagT = dvCmdT.length();
    if (dvMagT > maxDvT && dvMagT > 1e-18) dvCmdT.multiplyScalar(maxDvT / dvMagT);

    // Apply thrust impulse (NOT lerp — direct impulse like mother autopilot). A flat pack gives no impulse: she coasts.
    if (!this._powerOff()) {
      this.velocity.add(dvCmdT);
      // meter the APPLIED (post-clamp) impulse for impulse-priced fuel
      this._impulseDvAccum += Math.min(dvMagT, maxDvT) / M;
    }
    this.position.addScaledVector(this.velocity, dt);

    // Fine-approach threshold must be >= standoff so APPROACH has room to decelerate.
    const debrisSizeT = (this.target && this.target.sizeMeter) || 1;
    const standoffT = clamp(debrisSizeT * Constants.STATION_KEEP.DEFAULT_STANDOFF_MULT, Constants.STATION_KEEP.DEFAULT_STANDOFF, Constants.STATION_KEEP.MAX_STANDOFF);
    const approachThreshold = Math.max(standoffT * 2, this.config.bodyDims[2] * 15) * M;
    if (dist < approachThreshold) {
      this._transitionTo(S.APPROACH);
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Beginning final approach`,
        priority: 'info',
      });
    }
  }

  _updateApproach(dt, parentPos) {
    if (this._homeIfPieceLost()) return;
    if (this._manualMode) {
      // Manual mode: coast with current velocity; autopilot (controller, pings, thruster audio) is skipped (beep/hum
      // annoyed in ARM_PILOT mode).
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
      // Still check the SK gate in manual mode: enableManual() fires during LAUNCH_CEREMONY_COMPLETE while still in
      // APPROACH; without it she coasts through the debris. Distance-only (no velocity gate): manual mode skips the braking
      // controller, so she arrives fast; the SK lerp (0.8/frame) converges in ~3 frames.
      if (this.target) {
        const _tPos = this._getTargetScenePos();
        if (_tPos) {
          const _distM = _tPos.distanceTo(this.position) / M;
          const _dSz = (this.target.sizeMeter) || 1;
          const _so = clamp(_dSz * Constants.STATION_KEEP.DEFAULT_STANDOFF_MULT, Constants.STATION_KEEP.DEFAULT_STANDOFF, Constants.STATION_KEEP.MAX_STANDOFF);
          const _gateDist = _so * (Constants.STATION_KEEP.ENTRY_DISTANCE_MULT || 2.0);
          if (_distM <= _gateDist) {
            this._transitionTo(S.STATION_KEEP);
            this._stationKeepTarget = this.target;
            if (this.target) this.target._isStationKeepTarget = true;
            // Enter at the actual arrival distance and ease to nominal (as the autopilot path); manual mode skips
            // braking, so _distM can be well outside the band.
            this._standoffR = _distM;
            this._standoffTargetR = _so;
            this._standoffSettling = true;
            this._initSkFrame(_tPos);
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
              inspect: isInspectOnlyMass(this.target.mass),   // over the catch limit she only inspects: no net line, no net chip
            });
            return;
          }
        }
      }
      return;
    }

    const targetPos = this._getTargetScenePos();
    if (!targetPos) { this.recall(); return; }
    const toTarget = this._tmpVec.subVectors(targetPos, this.position);
    const dist = toTarget.length();

    // approach ping (distance fraction is always low here)
    if (this._startingDistance > 0) {
      const distFraction = Math.min(1, dist / this._startingDistance);
      eventBus.emit(Events.ARM_APPROACH_PING, { distanceFraction: distFraction, armId: this.id });
    }

    // ── Proportional controller as TRANSIT, but v* brakes to the standoff distance (not zero) ──
    const DAP_A = Constants.DAUGHTER_AUTOPILOT;

    const debrisSize = (this.target && this.target.sizeMeter) || 1;
    const standoff = clamp(debrisSize * Constants.STATION_KEEP.DEFAULT_STANDOFF_MULT, Constants.STATION_KEEP.DEFAULT_STANDOFF, Constants.STATION_KEEP.MAX_STANDOFF);
    const distMetres = dist / M;

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

    if (!this._smoothDriftVel) this._smoothDriftVel = new THREE.Vector3(0, 0, 0);
    const alphaA = DAP_A.DRIFT_EMA_ALPHA || 0.1;
    this._smoothDriftVel.lerp(rawDriftVelA, alphaA);
    const driftVelA = this._smoothDriftVel;

    const relVA = _relVel.subVectors(driftVelA, this.velocity);

    // Signed excess distance: + outside standoff, − inside (a restoring spring pushes her back OUT)
    const signedExcess = distMetres - standoff;
    const absExcess = Math.abs(signedExcess);
    const aBrakeA = DAP_A.MAX_ACCEL * DAP_A.BRAKE_FRACTION;
    const vStarMA = Math.min(DAP_A.V_CAP * 0.3, Math.sqrt(2 * aBrakeA * absExcess));
    const vStarA = vStarMA * M;

    // goalDir toward the target outside standoff, AWAY from it inside
    const goalDirA = _goalDir.copy(toTarget).normalize();
    const posCmd = _posCmd.copy(goalDirA).multiplyScalar(signedExcess >= 0 ? vStarA : -vStarA);
    const velCtrlErrA = posCmd.add(relVA);
    const dvCmdA = velCtrlErrA.multiplyScalar(DAP_A.KP_VEL);
    const gameDtA = dt * TimeAuthority.BASE_SCALE;
    const maxDvA = DAP_A.MAX_ACCEL * M * gameDtA;
    const dvMagA = dvCmdA.length();
    if (dvMagA > maxDvA && dvMagA > 1e-18) dvCmdA.multiplyScalar(maxDvA / dvMagA);

    // Visual-only: brake read for the plume mapping. A commanded impulse OPPOSING travel means the FEEP exhaust points at
    // the target (nose/+Z tracks it in APPROACH), i.e. the FORE nozzle fires. Sampled BEFORE velocity.add; smoothed (~1/8 s)
    // so dither around standoff crossfades instead of strobing; the magnitude floor keeps noise from flaring anything.
    const _brakingA = dvMagA > 1e-15 && dvCmdA.dot(this.velocity) < 0;
    this._approachBrake01 += ((_brakingA ? 1 : 0) - this._approachBrake01) * Math.min(1, dt * 8);

    if (!this._powerOff()) {   // a flat pack gives no impulse: she coasts
      this.velocity.add(dvCmdA);
      this._impulseDvAccum += Math.min(dvMagA, maxDvA) / M;
    }
    this.position.addScaledVector(this.velocity, dt);

    // STATION_KEEP entry check, before netting
    if (this.target && !this._manualMode) {
      // Relative velocity to TARGET from the EMA-smoothed drift (not raw: noise); at steady state velocity ≈ smoothDriftVel.
      const relVel = this.velocity.distanceTo(driftVelA) / M;

      // SK entry gate: distance + velocity thresholds, both constants (tunable without code changes).
      const _SK_DIST_MULT = Constants.STATION_KEEP.ENTRY_DISTANCE_MULT;
      const _SK_GATE_DIST = standoff * _SK_DIST_MULT;
      const _SK_GATE_VEL  = Constants.STATION_KEEP.ENTRY_MAX_VELOCITY;

      if (distMetres <= _SK_GATE_DIST && relVel < _SK_GATE_VEL) {
        this._transitionTo(S.STATION_KEEP);
        this._stationKeepTarget = this.target;
        // Mark debris so DebrisField LOD won't scale it to 0 when mother orbits far away
        if (this.target) this.target._isStationKeepTarget = true;
        // Enter at the ACTUAL arrival distance and ease to the nominal standoff (see _updateStationKeep settle block,
        // STANDOFF_SETTLE_TAU_S): the gate fires at up to 2× standoff while still closing, so setting standoff here would
        // snap the gap via the 0.8/frame lerp and jerk the welded pilot camera.
        this._standoffR = distMetres;
        this._standoffTargetR = standoff;
        this._standoffSettling = true;

        // Frozen entry frame so arrow keys map to screen axes (no tilt or roll whatever the orbit inclination):
        // _initSkFrame sets _skPolarAxis / _skEquator0 / _skRightVec / _skPitch0 from current geometry; θ and φ start at 0.
        const _skTargetPos = this._getTargetScenePos();
        this._initSkFrame(_skTargetPos);
        // Velocity = EMA-smoothed orbital drift (debris frame, scene units/s), NOT zero: SK positions by lerp, but the
        // parent-frame correction in update() shifts her by the mother's delta each frame, so zero velocity would make the
        // lerp chase continuously.
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
          inspect: isInspectOnlyMass(this.target.mass),
        });
        return;
      }
    }

    const netThreshold = this.config.bodyDims[2] * M * 5;
    if (dist < netThreshold && !isInspectOnlyMass(this.target.mass)) {   // an inspection never throws a net
      this._transitionTo(S.NETTING);
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Deploying ${this.config.netSize}m net`,
        priority: 'info',
      });
    }
  }

  /** STATION_KEEP: hold spherical orbit around target debris */
  _updateStationKeep(dt) {
    const SK = Constants.STATION_KEEP;
    const target = this._stationKeepTarget;

    this.mesh.visible = true;

    // target lost: exit (check _scenePosition; instanced debris have no .mesh)
    if (!target || (!target._scenePosition && !target.mesh)) {
      this._exitStationKeep('lost');
      return;
    }

    // Live odds refresh at REFRESH_HZ; DockingReticle eases the displayed value toward it (odds climb while de-spinning).
    if (Constants.isFeatureEnabled('DAUGHTER_MULTITOOL')) {
      this._toolOddsTimer += dt;
      const interval = 1 / ((Constants.TOOL_ODDS && Constants.TOOL_ODDS.REFRESH_HZ) || 10);
      if (this._toolOddsTimer >= interval) {
        this._toolOddsTimer = 0;
        this._refreshToolOdds();
      }
      // MAGNET secondary: eddy-current detumble on conductive targets
      this._updateEddyDamp(dt, target);
    }

    // over the mother's catch limit she is here to INSPECT: the hold at most CLOSE_RANGE_M out, then her arc, then home
    const inspecting = isInspectOnlyMass(target.mass);
    if (inspecting && this._driveInspectSweep(dt)) return;

    this._orbitTheta += this._thetaRate * dt;
    this._orbitPhi += this._phiRate * dt;
    this._standoffR += this._radiusRate * dt;

    // ── Standoff settle-in ──
    // On entry _standoffR is the ACTUAL arrival distance (the SK gate fires at ENTRY_DISTANCE_MULT × standoff while still
    // closing); ease it to nominal so the 0.8/frame lerp doesn't snap the gap and jerk the welded pilot camera. Any pilot
    // radius input cancels the settle.
    if (this._standoffSettling) {
      if (Math.abs(this._radiusRate) > 1e-4) {
        // Pilot took radius control: hand over, but if still outside the band keep easing in (target = _rMax) so the clamp
        // below can't snap it down in one frame.
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

    // ── Pattern-C auto-return ── after a quiet dwell with no arrow input she eases back toward the entry pose; any new
    // input cancels the ease and resets the dwell.
    const _hasInput = Math.abs(this._thetaRate) > 1e-4
                   || Math.abs(this._phiRate) > 1e-4
                   || Math.abs(this._radiusRate) > 1e-4;
    if (_hasInput) {
      this._skIdleS = 0;
    } else {
      this._skIdleS = (this._skIdleS || 0) + dt;
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
        const deadRad = degToRad(SK.AUTO_RETURN_DEADZONE_DEG || 2.0);
        if (Math.abs(this._orbitTheta) < deadRad && Math.abs(this._orbitPhi) < deadRad) {
          this._orbitTheta = 0;
          this._orbitPhi   = 0;
        }
      }
    }

    // Clamp phi to the pitch swing limit (MAX_LATITUDE − TETHER_SAFETY_MARGIN as half-angle): keeps her from going behind
    // the debris or wrapping the tether vertically. An inspecting daughter may level a full 90 degrees (a pole arrival,
    // straight along the mother's line, otherwise stops 20 degrees short of the equator, a cap of 70 degrees round the pole
    // where no two directions are 160 apart); her tether is kept clear by the arc's own limit.
    let phiLimit = this._phiMax - (degToRad(SK.TETHER_SAFETY_MARGIN));
    if (inspecting) phiLimit = Math.max(phiLimit, degToRad(90));
    this._orbitPhi = clamp(this._orbitPhi, -phiLimit, phiLimit);

    // Clamp θ around entry (frozen frame: θ measured from 0, so ±THETA_LIMIT_DEG): prevents tether wrap and rotating past
    // the mother's peripheral view.
    const thetaLimitRad = degToRad(SK.THETA_LIMIT_DEG || 120);
    this._orbitTheta = clamp(this._orbitTheta, -thetaLimitRad, thetaLimitRad);

    // Clamp radius. While settling in from a wide SK entry the arrival distance can exceed _rMax: only the lower bound is
    // enforced until settled.
    if (this._standoffSettling) {
      this._standoffR = Math.max(this._minHoldM(), this._standoffR);
    } else {
      this._standoffR = clamp(this._standoffR, this._minHoldM(), this._rMax);
    }

    // _scenePosition (orbit-propagated), not mesh.position (stale or floating-origin-adjusted for instanced debris)
    const targetPos = target._scenePosition || (target.mesh && target.mesh.position);
    if (!targetPos) {
      this._exitStationKeep('lost');
      return;
    }

    // Lazy-init entry frame (unit tests set _orbitTheta directly, skipping the SK entry transition).
    if (!this._skPolarAxis) this._initSkFrame(targetPos);

    // ── Goal position in the frozen entry frame ──
    // yaw = rotation about _skPolarAxis (screen-up at entry); pitch = rotation about the rotated _skRightVec (screen-right).
    // ← / → rotate purely horizontally in screen space, ↑ / ↓ purely vertically, no tilt.
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

    // §11.4 net-fire recoil: while the kick transient is live the hold goal is displaced by the recoil offset (the daughter
    // is shoved off the hold sphere and eased back as the RCS nulls it; the step also bills the recovery surcharge).
    // Inactive or flag OFF: goal untouched, byte-identical hold math.
    if (this._updateRecoilKick(dt)) {
      goalX += this._recoilOffsetM.x * M;
      goalY += this._recoilOffsetM.y * M;
      goalZ += this._recoilOffsetM.z * M;
    }

    // A flat pack holds nothing: no thrusters, so no hold, no fuel and no engine billed. She coasts on her velocity (a tethered
    // daughter is ADRIFT by the end of the frame; a detached one just drifts).
    if (this._powerOff()) {
      this.position.addScaledVector(this.velocity, dt);
      this._thetaRate = 0;
      this._phiRate = 0;
      this._radiusRate = 0;
      return;
    }

    // Lerp world position to goal (group.position synced from this.position in update())
    const lerp = SK.STATIONKEEP_LERP_RATE;
    this.position.x += (goalX - this.position.x) * lerp;
    this.position.y += (goalY - this.position.y) * lerp;
    this.position.z += (goalZ - this.position.z) * lerp;

    const isManeuver = Math.abs(this._thetaRate) > 0.01 ||
                       Math.abs(this._phiRate) > 0.01 ||
                       Math.abs(this._radiusRate) > 0.01;
    const fuelRate = isManeuver ? SK.FUEL_RATE_MANEUVER : SK.FUEL_RATE_STATIONKEEP;
    this.fuel -= fuelRate * dt;
    this.power.markEngine();

    // Visual-only: latch the plume brightening window off the SAME isManeuver read that selects FUEL_RATE_MANEUVER.
    // Latched here because the rates are reset at the end of this method, BEFORE _updatePlumes runs.
    if (isManeuver) this._skManeuverGlowS = DAUGHTER_PLUME.MANEUVER_GLOW_S;

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

  /**
   * Linear recoil impulse (and §11.3 wheel bookkeeping) for a daughter net launch. Called from _updateNettingFSM at the
   * ONE production fire site, right after fireDaughterNet succeeds (the mother pod path,
   * PlayerSatellite._applyMotherNetRecoil, is untouched).
   *
   * Δv = m_net · LAUNCH_SPEED / m_daughter, derived LIVE from the fired net's class object and this arm's config.mass
   * (§11.4: ≈1.03 m/s MEDIUM/Weaver, ≈0.57 m/s SMALL/Spinner), never hardcoded. The impulse seeds the critically-damped
   * transient integrated by _updateRecoilKick; the net's own flight/capture math is untouched.
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
    // Impulse opposes the launch direction; accumulates into any live transient (rapid double-fire kicks stack).
    const kx = -(dx / dLen) * dvMps;
    const ky = -(dy / dLen) * dvMps;
    const kz = -(dz / dLen) * dvMps;
    this._recoilVelMps.x += kx;
    this._recoilVelMps.y += ky;
    this._recoilVelMps.z += kz;
    this._recoilActive = true;

    // §11.3 wheel: firing on a saturated wheel forces a paid RCS desat burn (dump first, then take the new increment).
    const REC = Constants.DAUGHTER_NET_RECOIL;
    if (this._wheelMomentum >= REC.WHEEL_SATURATION_THRESHOLD && !this._powerOff()) {   // a flat pack cannot fire the desat burn
      this.fuel = Math.max(0, this.fuel - REC.WHEEL_DESAT_FUEL_COST);
      this.power.markEngine();      // the desat burn is ion fuel
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
   * @private Step the recoil transient one frame and bill the RCS recovery surcharge. Called from the two kinematic hold
   * loops (_updateStationKeep + the NETTING hold in _updateNettingFSM); they displace their hold goal by _recoilOffsetM
   * while this returns true.
   *
   * Exact per-step closed form of the critically-damped system
   * ẍ = −2ωẋ − ω²x (stable at any dt):
   *   B = v + ω·x;  x' = (x + B·dt)·e^(−ω·dt);  v' = (v − ω·B·dt)·e^(−ω·dt)
   * Recovery is billed at SK.FUEL_RATE_MANEUVER ON TOP of whatever the hold loop bills; NETTING bills no base fuel, so
   * there the surcharge is the only debit.
   * @returns {boolean} true while the transient is live this frame
   */
  _updateRecoilKick(dt) {
    if (!this._recoilActive) return false;
    if (this._powerOff()) { this._clearRecoilKick(); return false; }   // no power: no RCS to null the kick, so no surcharge and no hold goal
    // Flag flipped OFF mid-transient (dev toggle / REALITY_MODE): drop the kick at once (zero displacement and billing).
    // Checked after the fast path so the common inactive frame pays nothing.
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

    const surcharge = Constants.STATION_KEEP.FUEL_RATE_MANEUVER * dt;
    this.fuel = Math.max(0, this.fuel - surcharge);
    this.power.markEngine();
    this._recoilFuelBilled += surcharge;

    // Settled: snap exactly to zero so billing stops and the hold goal returns to the pure hold-sphere math.
    if (o.lengthSq() < REC.SETTLE_EPS_OFFSET_M * REC.SETTLE_EPS_OFFSET_M
        && v.lengthSq() < REC.SETTLE_EPS_VEL_MPS * REC.SETTLE_EPS_VEL_MPS) {
      this._clearRecoilKick();
    }
    return true;
  }

  _clearRecoilKick() {
    this._recoilOffsetM.set(0, 0, 0);
    this._recoilVelMps.set(0, 0, 0);
    this._recoilActive = false;
  }

  /** @private §11.3: bleed wheel momentum (magnetorquers), every state. */
  _tickWheelDecay(dt) {
    if (this._wheelMomentum <= 0) return;
    if (!Constants.isFeatureEnabled('DAUGHTER_NET_RECOIL')) {
      // Flag flipped OFF with residual momentum: neutralize rather than freeze a stale (possibly saturated) reading into
      // getStatus().
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

  // §11.5 capture-torque settle (FEATURE_FLAGS.CAPTURE_TORQUE_SETTLE): derivation + tuning in Constants.CAPTURE_TORQUE_SETTLE;
  // the pure physics helpers (captureAngularMomentum & co) are exported at module scope.

  /**
   * @private Seed the capture-torque settle at the daughter net-FSM cinch (where legacy code froze tumble for free: the two
   * `_capturedByArm = this` writes in _updateNettingFSM). The target's spin angular momentum L = Iω becomes a
   * critically-damped wrench of the caught bundle that the tether damps over t_settle = L/τ.
   *
   * Scope (deliberate): daughter NET catches only, as _checkNetIntegrityOnReel's net-integrity doctrine. The mother
   * lasso/berth spine, the legacy CAPTURE_NET-OFF dice path and the magnet/gripper/pad tool paths keep instant arrest.
   * A zero/near-zero rate seeds nothing (MIN_SEED_RATE_DEG_S), which keeps scenario-pinned attitudes (main.js register
   * item 13) byte-frozen.
   * @param {object} debris — the freshly cinched catch
   */
  _seedCaptureTorqueSettle(debris) {
    if (!Constants.isFeatureEnabled('CAPTURE_TORQUE_SETTLE')) return;
    if (!debris) return;
    const CTS = Constants.CAPTURE_TORQUE_SETTLE;
    const w0 = debris.tumbleRate || 0;                       // rad/s, live (post-lase)
    if (radToDeg(w0) < CTS.MIN_SEED_RATE_DEG_S) return;
    const L = captureAngularMomentum(debris.mass, debris.sizeMeter, w0);
    const T = captureSettleDuration(L);
    debris._carrySpin = true;          // the spin is carried to the seat (_tickHeldSpin), not deleted at the cinch
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
   * forward to ω₀/(λe) at t = 1/λ, then the tether hauls it back — the strain
   * model only (it feeds the rip roll, it does not draw the catch).
   * _advanceTumble early-returns on _capturedByArm, so _tickHeldSpin advances
   * tumbleAngle while held.
   *
   * Ends one of three ways:
   *  - SETTLED (t ≥ T and rendered residue below both snap eps): the strain
   *    model stands down; the catch is not de-spun, its spin goes on until
   *    the seat (_seatSpinBegin).
   *  - RIPPED (strain gate): see _ripNetFromTorque.
   *  - EXTERNAL RELEASE (mass slip, boost rip, manual drop, handoff, snap):
   *    the settle stands down; the catch keeps its real spin.
   */
  _tickCaptureSettle(dt) {
    const st = this._settle;
    if (!st) return;
    // Flag flipped OFF mid-transient (dev toggle / REALITY_MODE): legacy semantics: attitude back to the frozen cinch pose,
    // tumbleRate untouched (a later drop resumes the original tumble). Mirrors _updateRecoilKick's OFF path.
    if (!Constants.isFeatureEnabled('CAPTURE_TORQUE_SETTLE')) {
      st.debris.tumbleAngle = st.seedAngle;
      st.debris._carrySpin = false;      // legacy again: frozen at the cinch, rate untouched
      this._settle = null;
      return;
    }
    const debris = st.debris;
    // External release mid-settle: the tether stopped damping, so stand the settle down; the catch keeps its real spin
    // (covers _releaseCapturedDebris in all callers; on a tether snap the catch keeps _capturedByArm while
    // capturedDebris clears, so the settle stands down now and _advanceTumble resumes the real spin when the delayed EXPENDED
    // release clears the pin).
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
    // The wrench below (theta / rate) is the STRAIN model only (it feeds the rip roll); it does not draw the catch: the spin
    // itself is real and carried (`_tickHeldSpin` advances the angle).

    // Strain gate: rolled only in the wrench window (GRAPPLED/REELING, the states that own the NET_STRAIN_* mass checks)
    // and only while the residual REAL rate still exceeds the gate.
    const rateDegS = radToDeg(Math.abs(st.rate));
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

    // Settled: the wrench has died away (T reached, residue below both eps); the strain model stands down. The catch is NOT
    // de-spun here: its spin goes on until the seat (`_seatSpinBegin`).
    if (st.t >= st.T
        && Math.abs(st.theta) * TS < CTS.SNAP_EPS_THETA_RAD
        && Math.abs(st.rate) * TS < CTS.SNAP_EPS_RATE_RAD_S) {
      this._settle = null;
    }
  }

  /**
   * @private The wrench rips the net (strain gate): recoverable (the _ripNetDuringBoost idiom). Debris drifts free and
   * re-capturable with the real spin it has; the daughter keeps her tether and returns to
   * reload. This is what makes the despin laser necessary: lasing below STRAIN_GATE_DEG_S before netting removes the roll.
   * @param {object} st — live settle state
   * @param {number} rateDegS — residual wrench rate at the rip (°/s, real)
   * @param {number} bandT — rip band 0..1 at the rip (event telemetry)
   */
  _ripNetFromTorque(st, rateDegS, bandT) {
    const debris = this.capturedDebris;
    if (!debris) return;
    const CTS = Constants.CAPTURE_TORQUE_SETTLE;
    // Stand the settle down first (ends the spin carry), then release (clears pins so
    // DebrisField._advanceTumble resumes advancing it next frame).
    this._resumeTumbleFromRemainder(st);
    this._releaseCapturedDebris({ keepPinned: false });
    eventBus.emit(Events.NET_FAILED, {
      armId: this.id, armIndex: this.index,
      debrisId: debris.id, strain: bandT, oversized: false, recoverable: true,
      cause: 'capture_settle', tumbleDegS: rateDegS,
    });
    // Same staging hook as the boost rip: CaptureNetVisual tears a wedge; audio/comms/teaching hang off the event.
    eventBus.emit(Events.NET_TORN, {
      armId: this.id, armIndex: this.index,
      debrisId: debris.id, strain: bandT,
    });
    // the cause stays; REEL_HOME winds her home (or holds her near the piece beyond FAIL_REEL.AUTO_REEL_MAX_M), else RETURNING
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
   * @private Stand the settle transient down on a release. The catch keeps the
   * real spin it has (carried to the seat), so nothing is rewritten: it only
   * ends the carry (_carrySpin = false) and clears the settle. tumbleRate, the
   * axis and tumbleAngle are left as they are. _initialTumbleRate is deliberately untouched
   * (E1 despin doctrine: spawn history is frozen).
   * @param {object} st — live settle state
   */
  _resumeTumbleFromRemainder(st) {
    // The catch's own spin was never taken away (it is carried to the seat), so a release hands back the REAL spin it has
    // now: nothing to rebuild from the wrench. The carry ends with the grip.
    st.debris._carrySpin = false;
    this._settle = null;
  }

  /**
   * @private A caught piece's spin goes on while it is reeled in (before the seat): the angle advances at the rate the
   * renderer would draw it free (`DebrisField._advanceTumble`'s law, which skips a pinned piece). Only a piece the net
   * settle seeded (a daughter NET catch spinning above MIN_SEED_RATE_DEG_S) carries.
   */
  _tickHeldSpin(dt) {
    const d = this.capturedDebris;
    if (!d || d._carrySpin !== true || this._seatSpin || d._capturedByArm !== this) return;
    if (!Constants.isFeatureEnabled('CAPTURE_TORQUE_SETTLE')) return;
    if (!(d.tumbleRate > 0) || !(dt > 0)) return;
    const maxVisualRad = degToRad(Constants.DEBRIS_MAX_VISUAL_TUMBLE_DEG_S ?? Infinity);
    d.tumbleAngle = (d.tumbleAngle || 0) + Math.min(d.tumbleRate * TimeAuthority.BASE_SCALE, maxVisualRad) * dt;
  }

  /**
   * @private The seat: the piece is in its cell on her. Its angular momentum L = I*omega goes into HER and she cancels it with her
   * cold-gas jet (DAUGHTER_COLD_GAS): torque = jet thrust x SEAT_LEVER_M, exhaust speed = ISP_S x g0, so cancelling L spends
   * L / (lever x v_e) kg and takes L / torque seconds. At most SEAT_CAP_BOTTLE_FRAC of her FULL bottle (and no more than she has)
   * is spent on one seat; any L left is bled by her eddy damper at its existing rate (EDDY_DAMP.DESPIN_RATE_RAD_S2 on the rate:
   * extra time, no gas), never deleted. The piece keeps turning in her frame while it goes, its cell re-laid each frame so it never
   * touches her. A piece that is not carrying a spin (under 0.1 deg/s, or not a net catch) costs nothing.
   * @param {object} d the piece, in its cell on her (`_rackCell` assigned)
   * @param {THREE.Quaternion} herQ her world attitude as the piece was seeded in her frame
   * @param {THREE.Vector3|null} axisWorld the spin axis in the world frame (read BEFORE the cell's attitude overwrote it)
   * @returns {object|null} the plan (telemetry/tests): { gasKg, gasS, dampS, totalS, L, Lpaid, Lleft }
   */
  _seatSpinBegin(d, herQ, axisWorld) {
    if (!d || d._carrySpin !== true) return null;
    d._carrySpin = false;
    const CTS = Constants.CAPTURE_TORQUE_SETTLE;
    const w0 = d.tumbleRate || 0;
    if (radToDeg(w0) < CTS.MIN_SEED_RATE_DEG_S) { d.tumbleRate = 0; return null; }
    const I = captureMomentOfInertia(d.mass, d.sizeMeter);
    const L = I * w0;
    const lever = CTS.SEAT_LEVER_M ?? 0.10;
    const CG = Constants.DAUGHTER_COLD_GAS || {};
    const ve = (CG.ISP_S ?? 60) * (CTS.SEAT_G0 ?? Constants.G0);
    const torque = this._coldGasThrustN() * lever;                      // N*m while the jet fires
    const full = this._coldGasBottleKg();
    const gasAvail = clamp(this.coldGasKg, 0, (CTS.SEAT_CAP_BOTTLE_FRAC ?? 0.10) * full);
    const Lcap = gasAvail * lever * ve;                                  // the L the gas she may spend can cancel
    const Lpaid = torque > 0 ? Math.min(L, Lcap) : 0;
    const Lleft = L - Lpaid;
    const gasKg = Lpaid / (lever * ve);
    const gasS = torque > 0 ? Lpaid / torque : 0;
    const wLeft = I > 0 ? Lleft / I : 0;
    const dampS = wLeft / Math.max(1e-9, Constants.EDDY_DAMP?.DESPIN_RATE_RAD_S2 ?? 0.10);
    const ax = new THREE.Vector3();
    if (axisWorld && axisWorld.lengthSq() > 1e-12) ax.copy(axisWorld).normalize().applyQuaternion(_seatInvQ.copy(herQ).invert());
    else ax.set(0, 0, 1);
    this._seatSpin = {
      debris: d, axisHer: ax, I, L, Lpaid, Lleft, gasKg, gasS, dampS, totalS: gasS + dampS,
      t: 0, gasBilled: 0, w: w0, done: false,
    };
    return { gasKg, gasS, dampS, totalS: gasS + dampS, L, Lpaid, Lleft };
  }

  /** @private Step the seat spin-down one frame (see `_seatSpinBegin`). Inert single null-check when none is live. */
  _tickSeatSpin(dt) {
    const st = this._seatSpin;
    if (!st) { if (this._seatEaseD) this._seatEaseStep(); return; }   // the last re-solve's ease runs on after the spin is paid
    const d = st.debris;
    // the piece left her (dropped, released, digested, handed on): what it has now stays its real spin; stand down
    if (d._rackArm !== this || !d._qLocalHer || !d._rackLocalM
        || (this.capturedDebris !== d && !this.heldCatches.includes(d))) { this._seatSpin = null; d._carrySpin = false; return; }
    if (!(dt > 0)) return;
    const TS = TimeAuthority.BASE_SCALE;
    let left = dt;
    const I = Math.max(1e-12, st.I);
    const torque = this._coldGasThrustN() * (Constants.CAPTURE_TORQUE_SETTLE.SEAT_LEVER_M ?? 0.10);
    // phase 1: the gas jet (L falls at `torque`), billed as it fires; phase 2: the eddy damper (the rate falls at its rate)
    if (st.t < st.gasS && torque > 0) {
      const step = Math.min(left, st.gasS - st.t);
      const dL = torque * step;
      st.w = Math.max(0, st.w - dL / I);
      const kg = st.gasS > 0 ? st.gasKg * step / st.gasS : 0;
      this.coldGasKg = Math.max(0, this.coldGasKg - kg);
      if (kg > 0) this.power.markGas();   // the valves open while the jet fires (DaughterPower bills them once per frame)
      st.gasBilled += kg;
      st.t += step; left -= step;
      if (st.t >= st.gasS - 1e-12) { st.t = st.gasS; this.coldGasKg = Math.max(0, this.coldGasKg - Math.max(0, st.gasKg - st.gasBilled)); st.gasBilled = st.gasKg; }
    }
    if (left > 0 && st.t >= st.gasS) {
      const rate = Constants.EDDY_DAMP?.DESPIN_RATE_RAD_S2 ?? 0.10;
      const step = Math.min(left, st.dampS - (st.t - st.gasS));
      st.w = Math.max(0, st.w - rate * Math.max(0, step));
      st.t += Math.max(0, step);
    }
    const finished = st.t >= st.totalS - 1e-12;
    if (finished) st.w = 0;
    // the piece turns in HER frame about its spin axis (same visual convention as free tumble); its cell is re-laid for the new
    // attitude so the gap stays the net gap while it goes round
    const dAng = Math.min(Math.max(0, st.w) * TS, degToRad(Constants.DEBRIS_MAX_VISUAL_TUMBLE_DEG_S ?? Infinity)) * dt;
    if (dAng > 0 || (finished && d._seatMemo)) {
      if (dAng > 0) d._qLocalHer.premultiply(_seatSpinQ.setFromAxisAngle(st.axisHer, dAng));
      // the spin is paid off with the 5 degree / 0.5 s rule in `seatStandoffM`; its end is one exact solve (memo dropped)
      if (finished) d._seatMemo = null;
      const below = d._rackCell >= 1 ? rackPieceInCell(this.heldCatches, d._rackCell - 1, d) : null;
      const shownZ = d._rackLocalM.z;
      rackCellOffsetInto(d._rackLocalM, this.herSupportZM(), d, d._rackCell, d._qLocalHer, 0, below, this._seatGeo());
      this._seatEaseBegin(d, shownZ);
    }
    this._seatEaseStep();
    d.tumbleRate = st.w;
    if (finished) { st.done = true; this._seatSpin = null; d.tumbleRate = 0; }
  }

  /**
   * @private A re-solve of the seat (the piece has turned) answers a cell up to 2-3 cm away from the last one. The piece is not
   * moved there in one frame: the answer is kept as the target (`d._seatEaseZ`) and the cell moves toward it by at most
   * SEAT_EASE_STEP_M a frame. A target nearer her is approached gently; one farther out is too, except that the piece is never left
   * more than SEAT_EASE_LAG_M short of it (that would be the net gap eaten, so it would touch her).
   * @param {object} d the piece (its `_rackLocalM` holds the fresh answer)
   * @param {number} shownZ where the piece was drawn along her axis before the fresh answer
   */
  _seatEaseBegin(d, shownZ) {
    const target = d._rackLocalM.z;
    d._rackLocalM.z = shownZ;
    d._seatEaseZ = target;
    this._seatEaseD = d;
  }

  /** @private one frame of the ease begun by `_seatEaseBegin` (a no-op, and cleared, when it has arrived or the piece left her). */
  _seatEaseStep() {
    const d = this._seatEaseD;
    if (!d) return;
    if (d._rackArm !== this || !d._rackLocalM || !Number.isFinite(d._seatEaseZ) || d._rackLocalM.z === d._seatEaseZ) { this._seatEaseClear(); return; }
    const step = Constants.SEAT_EASE_STEP_M ?? 0.0045, lag = Constants.SEAT_EASE_LAG_M ?? 0.02;
    const z = d._rackLocalM.z, target = d._seatEaseZ;
    let nz;
    if (Math.abs(target - z) <= step) nz = target;
    else if (target > z) nz = Math.max(z + step, target - lag);   // farther out: gently, but never nearer than `lag` short of the answer
    else nz = z - step;                                           // nearer her: gently
    d._rackLocalM.z = nz;
    if (nz === target) this._seatEaseClear();
  }

  /** @private drop the ease (arrived, or the cell was laid out afresh by something else). */
  _seatEaseClear() {
    const d = this._seatEaseD;
    if (d) d._seatEaseZ = undefined;
    this._seatEaseD = null;
  }

  /** The spin-down at the seat is still running: she holds where she is until it ends (then she starts home). */
  get seatSpinActive() {
    return !!this._seatSpin;
  }

  /**
   * @private Initialise the frozen SK entry frame so arrow keys map to screen-aligned yaw/pitch: an orthonormal triad at
   * the moment the daughter parks at the debris:
   *   _skPolarAxis  — Earth-radial at the debris (camera-up): "up" matches the player's "up" whatever the orbit
   *                   inclination, so the screen never rolls during sweep.
   *   _skEquator0   — debris→arm projected perpendicular to the polar axis (entry "forward in the equator plane");
   *                   θ=0 reproduces the arrival pose.
   *   _skRightVec   — equator0 × polarAxis = camera-right at entry; +θ moves the daughter this way (→ key = screen-right).
   *   _skPitch0     — the entry pose's pitch from the equator plane, added to φ so she doesn't snap if she arrived
   *                   above/below it.
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
      this._skPitch0 = Math.asin(clamp(dotP, -1, 1));
    }
    // right = equator0 × polar (camera-right at entry, so +yaw → screen-right)
    this._skRightVec = new THREE.Vector3()
      .crossVectors(this._skEquator0, this._skPolarAxis).normalize();
    this._orbitTheta = 0;
    this._orbitPhi   = 0;
  }

  /**
   * @private A daughter holding station at a piece over the mother's catch limit (no net; DECISIONS §49 row 3). She keeps the
   * hold inside `INSPECT.CLOSE_RANGE_M` (the full inspection is within 10 m), levels her orbit onto the equator of her hold
   * frame (so the arc covers the piece from opposite sides whatever way she arrived), sweeps +THETA_LIMIT then -THETA_LIMIT
   * at ORBIT_RATE, and recalls herself (the same recall as the pilot's: RETURNING). The arrow keys move nothing meanwhile.
   * @returns {boolean} true when she has left STATION_KEEP this frame (the caller stops)
   */
  _driveInspectSweep(dt) {
    const SK = Constants.STATION_KEEP;
    const target = this._stationKeepTarget;
    const hold = 0.9 * Constants.INSPECT.CLOSE_RANGE_M;
    if (this._standoffTargetR > hold) this._standoffTargetR = hold;
    if (!this._standoffSettling && this._standoffR > hold) this._standoffR = hold;
    if (this._standoffSettling) { this._thetaRate = 0; return false; }       // arrive first
    const sw = this._inspectSweep || (this._inspectSweep = { dir: 1, hit: 0, armed: true, prevClr: Infinity, edges: 0 });
    const lim = degToRad(SK.THETA_LIMIT_DEG || 120);
    // The dossier stamps what is still open on her piece (fly-around, spin). Fresh stamp -> she goes by it; none or stale -> by her arc.
    const I = Constants.INSPECT;
    const needs = target._inspectNeeds;
    let fresh = false;
    if (needs && Number.isFinite(needs.age)) { needs.age += dt; fresh = needs.age <= I.STALE_S; }
    if (fresh && !needs.inspect) {
      // the fly-around is paid: she stays at her hold (within the spin range) until the spin is measured, then goes home
      if (!needs.spin) {
        this._inspectSweep = null;
        eventBus.emit(Events.COMMS_MESSAGE, { text: `${this.displayName}: Inspection done, coming home.`, priority: 'info' });
        this.recallFromStationKeep();
        return true;
      }
      this._thetaRate = 0;
      this._phiRate = 0;
      this._radiusRate = 0;
      return false;
    }
    // The tether is a straight line mother -> her, and the piece (a sphere of radius sizeMeter / 2) must stay clear of it. Behind the
    // piece (seen from the mother) the line runs through it, so the arc turns round before: at the first frame the line is within
    // (radius + TETHER_CLEAR_M + TETHER_TURN_M) of the centre and still closing. It re-arms once the line has opened out again.
    // Once both ends of her arc are seen and the fly-around is still open, the turn margin drops to 0 (she widens the sweep to the clearance limit).
    const turn = fresh && sw.hit === 3 ? 0 : I.TETHER_TURN_M;
    const need = (target.sizeMeter || 0) / 2 + I.TETHER_CLEAR_M;
    const clr = this._inspectTetherClearM(target);
    let edge = 0;                                   // +1: the limit of the +direction was reached, -1: of the - direction
    if (this._orbitTheta >= lim - 1e-6 && sw.dir > 0) edge = 1;
    else if (this._orbitTheta <= -lim + 1e-6 && sw.dir < 0) edge = -1;
    if (clr != null) {
      if (!sw.armed && clr > need + 2 * I.TETHER_TURN_M) sw.armed = true;
      if (sw.armed && !edge && clr < need + turn && clr <= sw.prevClr) { edge = sw.dir; sw.armed = false; }
      sw.prevClr = clr;
    }
    if (edge) {
      sw.hit |= edge > 0 ? 1 : 2;
      sw.edges++;
      if (sw.hit === 3 && !fresh) {                 // no dossier stamp: both ends of her arc seen is the inspection
        this._inspectSweep = null;
        eventBus.emit(Events.COMMS_MESSAGE, { text: `${this.displayName}: Inspection done, coming home.`, priority: 'info' });
        this.recallFromStationKeep();
        return true;
      }
      if (sw.hit === 3 && sw.edges >= I.GIVE_UP_EDGES) {   // she has swept as wide as the line allows and the fly-around is still open
        this._inspectSweep = null;
        eventBus.emit(Events.COMMS_MESSAGE, { text: `${this.displayName}: Can't see it from all sides from here, the line is in the way. Coming home.`, priority: 'info' });
        this.recallFromStationKeep();
        return true;
      }
      sw.dir = -edge;
    }
    this._thetaRate = sw.dir * SK.ORBIT_RATE;
    this._phiRate = -(this._skPitch0 + this._orbitPhi);                      // 1 per second toward the equator of the hold frame
    this._radiusRate = 0;
    return false;
  }

  /**
   * @private The distance (metres) from the centre of her piece to the whole tether line (her strut tip -> her), or null before a mother
   * position has been seen (a bare test rig). The segment, not the points: the line can cross a piece that both ends are clear of.
   */
  _inspectTetherClearM(target) {
    const c = target && target._scenePosition;
    if (!c || !this.strutTipWorldInto(_inspTip)) return null;
    const ax = _inspTip.x, ay = _inspTip.y, az = _inspTip.z;
    const bx = this.position.x - ax, by = this.position.y - ay, bz = this.position.z - az;
    const len2 = bx * bx + by * by + bz * bz;
    let u = len2 > 0 ? ((c.x - ax) * bx + (c.y - ay) * by + (c.z - az) * bz) / len2 : 0;
    u = clamp01(u);
    const dx = ax + u * bx - c.x, dy = ay + u * by - c.y, dz = az + u * bz - c.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) / M;
  }

  _exitStationKeep(reason) {
    this._inspectSweep = null;
    eventBus.emit(Events.STATION_KEEP_EXITED, {
      armId: this.id,
      reason: reason,
    });
    // Clear LOD protection flag so normal LOD applies again
    if (this._stationKeepTarget) this._stationKeepTarget._isStationKeepTarget = false;
    this._stationKeepTarget = null;
    // stop eddy damping + clear the target's HUD flags (_despinning is safe to clear: DespinLaser re-asserts it each frame)
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
    this._skPolarAxis = null;
    this._skEquator0  = null;
    this._skRightVec  = null;
    this._skPitch0    = 0;
    this._skIdleS     = 0;
    // On her strut line (REEL_HOME on, tethered) the piece being gone winds her home on the reel, never the slow FEEP
    // flight. 'fuel' and the player's explicit FEEP 'recall' keep their meaning (RETURNING).
    if (reason === 'lost' && this._rhOn()) {
      this._reelHomeAfterFailure();
      return;
    }
    this._transitionTo(S.RETURNING);
  }

  /**
   * Is she on an inspection (her piece is over the mother's catch limit: no net, no tool)?
   * @returns {boolean}
   */
  isInspecting() {
    const t = this._stationKeepTarget || this.target;
    return !!t && isInspectOnlyMass(t.mass);
  }

  /**
   * @private The closest she holds. Her normal band floor (4 m) except on an inspection, where it is
   * `INSPECT.MIN_HOLD_M` (the Meteor 2 is 4.4-5 m across, so 4 m leaves ~1.5 m to its surface: an estimate).
   */
  _minHoldM() {
    return this.isInspecting() ? Math.max(this._rMin, Constants.INSPECT.MIN_HOLD_M) : this._rMin;
  }

  /**
   * @private A daughter at a piece over the mother's catch limit launches no net and works no tool (she only inspects it).
   * @returns {boolean} true when she refuses (and said so)
   */
  _inspectOnlyRefuses() {
    const t = this._stationKeepTarget || this.target;
    if (!t || !isInspectOnlyMass(t.mass)) return false;
    audioSystem.playDeny();
    eventBus.emit(Events.COMMS_MESSAGE, { text: `${this.displayName}: only inspecting it, no net.`, priority: 'warning' });
    return true;
  }

  captureFromStationKeep() {
    if (this.state !== S.STATION_KEEP) return false;
    if (this._inspectOnlyRefuses()) return false;

    // §13 Q5: net inventory gate: when CAPTURE_NET is ON and nets are exhausted, emit NET_EMPTY_CLICK + click-fail audio +
    // a CMD-channel comms message (so the log explains why F did nothing) instead of transitioning.
    if (Constants.isFeatureEnabled('CAPTURE_NET') && this._netInventory <= 0) {
      eventBus.emit(Events.NET_EMPTY_CLICK, { armId: this.id });
      audioSystem.playDeny();
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: this.displayName,
        text: daughterOutOfNetsLine(),   // DECISIONS §33 row 8: nets refill only at the resupply stop (not "return to mother")
        channel: 'CMD',
        priority: 'warning',
      });
      return false;
    }

    eventBus.emit(Events.STATION_KEEP_EXITED, {
      armId: this.id,
      reason: 'capture',
    });

    // Do NOT null _stationKeepTarget here: keeping the reference live during NETTING lets the miss-fallback (NETTING →
    // STATION_KEEP) resume cleanly (nulling it made SK exit as "lost" and the daughter return home empty). The LOD
    // protection flag also stays on during NETTING. Both are cleared on _exitStationKeep / recallFromStationKeep /
    // reelFromStationKeep / successful capture (GRAPPLED entry doesn't need them).
    //
    // GUARD: snapshot the committed target so the NETTING-FSM miss-fallback can detect "target removed mid-net-flight" and
    // bail out to RETURNING instead of looping into SK with a stale reference. The debris is also marked so
    // DebrisField.removeDebris() can warn when something removes a debris with a net committed to it.
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

  /** Public: Reel arm from STATION_KEEP → REELING (zero-fuel strut motor): out of fuel/nets, or the player aborts without burning FEEP. */
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
    if (!this._rhOn()) {                      // under REEL_HOME `_transitionTo` said how far and how long
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Reeling in. Strut motor engaged`,
        priority: 'info',
      });
    }
    return true;
  }

  /** @private Default `selectedTool` to the top-scored verb for the SK target; stores the ★ scores and hints the HUD reads. */
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
      // DECISIONS §33 row 7: the rule reads the surface (material -> gecko / hooks adhesion), so the piece's material and
      // roughness must reach the recommender.
      material: target ? target.material : undefined,
      surfaceRoughness: target ? target.surfaceRoughness : undefined,
    });
    this.selectedTool = rec.recommended;
    // SK entry is the lock/re-acquire seam: force the odds lock cache to rebuild even if a (pool-recycled) target
    // reference matches (ToolOdds.makeNetOddsLockCache).
    if (this._toolOddsLockCache) this._toolOddsLockCache.valid = false;
    this._refreshToolOdds();           
    eventBus.emit(Events.TOOL_ARMSET_CHANGED, { armId: this.id, toolset: this.toolset.slice() });
    eventBus.emit(Events.TOOL_SELECTED, { armId: this.id, tool: this.selectedTool });
  }

  /** @private Live tool odds for the odds strip (SK entry and TOOL_ODDS.REFRESH_HZ from _updateStationKeep); same pure model as the rolls. */
  _refreshToolOdds() {
    const target = this._stationKeepTarget || this.target;
    const range = (typeof this._standoffR === 'number' && this._standoffR > 0)
      ? this._standoffR : 50;
    const netCount = (typeof this.getNetInventory === 'function')
      ? this.getNetInventory() : (this._netInventory ?? undefined);
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
    // Per-arm lock cache: lock-stable cling factors (mode/pBase, roughness, strain) are computed once at target-lock;
    // range/presented-width/projected-spin stay live. Allocated once per arm, never per refresh (ToolOdds.makeNetOddsLockCache).
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
   * @private Eddy-current detumble: a MAGNET's rotating field bleeds the tumble of a CONDUCTIVE hull at ~⅓ of the mother
   * laser's rate, within EDDY_DAMP.RANGE_M. Passive while station-keeping with MAGNET selected; counts toward DESPIN_IN_SPEC.
   * @param {number} dt
   * @param {object|null} target the STATION_KEEP target
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
          // Also clear the shared HUD hint (the laser re-asserts it every frame while firing, so this never fights a beam).
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
    const inSpecRad = degToRad((Constants.DESPIN_LASER && Constants.DESPIN_LASER.IN_SPEC_DEG) || 10);
    if (before > inSpecRad && after <= inSpecRad) {
      eventBus.emit(Events.DESPIN_IN_SPEC, { targetId: target.id ?? null, tumbleDeg: radToDeg(after) });
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
    // Re-aim: a deployed daughter swapping verbs trims attitude toward the new tool axis (one cold-gas couple, visual-only).
    if (this.state === S.STATION_KEEP) this._fireAttitudePuffs('tool');
    // byPlayer: the backquote key or her CHANGE TOOL button. CommsSystem says the new tool's in-position line for this and
    // never for _refreshToolRecommendation's own emit on SK entry; only while she holds station.
    eventBus.emit(Events.TOOL_SELECTED, { armId: this.id, tool: next, byPlayer: this.state === S.STATION_KEEP, inspect: isInspectOnlyMass(((this._stationKeepTarget || this.target) || {}).mass) });
    return next;
  }

  /**
   * Dispatch the selected tool from STATION_KEEP (F key, DAUGHTER_MULTITOOL ON).
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

  _magnetGripProbability(target) {
    const MAG = Constants.MAGNETIC_GRAPPLE;
    if (!target || (target.mass || 0) > MAG.MAX_DEBRIS_MASS_KG) return 0;
    if (target.ferromagnetic === true) return MAG.P_GRIP_FERROUS;
    if (target.hasFerrousFasteners === true) return MAG.P_GRIP_FASTENERS;
    return MAG.P_GRIP_NON_FERROUS;
  }

  /**
   * Begin a magnetic grapple from STATION_KEEP: sub-FSM ENERGIZING → CLOSING → GRIP in `_updateMagneticGrapple`. Emits
   * AUTOPILOT_TARGET_LOCK so CollisionAvoidance exempts the target while she closes within contact range (§5.1 gotcha).
   * @returns {boolean}
   */
  magneticGrapple() {
    if (this.state !== S.STATION_KEEP) return false;
    if (this._inspectOnlyRefuses()) return false;
    const target = this._stationKeepTarget || this.target;
    if (!target) { audioSystem.playDeny(); return false; }

    eventBus.emit(Events.STATION_KEEP_EXITED, { armId: this.id, reason: 'magnet' });
    this._magPhase = 'ENERGIZING';
    this._magTimer = 0;
    this._captureToolKind = 'MAGNET';
    audioSystem.playMagnetic();
    // CA exemption during CLOSING (she drives < 0.5 m to the target); released centrally on any exit from MAGNETIC_GRAPPLE.
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

  _resolveMagnetGrip(target) {
    if ((target.mass || 0) > Constants.MAGNETIC_GRAPPLE.MAX_DEBRIS_MASS_KG) {
      this._failMagneticGrip('too_heavy');
      return;
    }
    const ferrous = target.ferromagnetic === true || target.hasFerrousFasteners === true;
    if (!ferrous) {
      const pNF = Constants.MAGNETIC_GRAPPLE.P_GRIP_NON_FERROUS;
      const rollNF = (this._magRollOverride != null) ? this._magRollOverride : Math.random();
      if (rollNF >= pNF) { this._failMagneticGrip('non_ferrous'); return; }
    } else {
      const p = this._magnetGripProbability(target);
      // Test seam: `_magRollOverride` (0..1) forces a deterministic roll.
      const roll = (this._magRollOverride != null) ? this._magRollOverride : Math.random();
      if (roll >= p) { this._failMagneticGrip('p_roll'); return; }
    }

    // Grip acquired: reuse the GRAPPLED → REELING lifecycle (net-integrity is skipped for non-NET catches via _captureToolKind).
    this._magPhase = null;
    eventBus.emit(Events.MAGNETIC_GRIP_ACQUIRED, {
      armId: this.id, targetId: target.id, mass: target.mass || 0,
    });
    this._secureToolCatch(target, 'MAGNET',
      `${this.displayName}: EPM grip secured. Magnetic latch holding. Reeling in.`);
  }

  _failMagneticGrip(reason) {
    const target = this._stationKeepTarget || this.target;
    this._magPhase = null;
    audioSystem.playDeny();
    if (target) {
      eventBus.emit(Events.MAGNETIC_GRIP_FAILED, { armId: this.id, targetId: target.id, reason });
      eventBus.emit(Events.MAGNETIC_RELEASE, { armId: this.id, targetId: target.id });
    }
    // cause: used under REEL_HOME (outcome reeled home / held); msg: the whole line when REEL_HOME is off
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

  /**
   * Distance from the mother at the capture instant (metres); the wide-sweep mission beat filters ARM_CAPTURED on it.
   * Measured against THIS frame's parent position (`_frameParentPos`, set at the top of `update`, after which `position`
   * has had this frame's orbital step), else `_prevParentPos`; 0 before the first parent frame. Against `_prevParentPos`
   * alone every live capture read one orbital step (~7.7 km) and tripped the `rangeM >= 1000` wide-sweep trigger.
   * @returns {number} range in metres
   */
  _captureRangeM() {
    const ref = this._frameParentPos || this._prevParentPos;
    if (!ref) return 0;
    return this.position.distanceTo(ref) / M;
  }

  /** @private Secure a non-net catch and hand off to GRAPPLED → REELING → park-the-catch; ARM_CAPTURED is tagged with the tool. */
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
    this._transitionTo(S.GRAPPLED);
  }

  /**
   * @private Tail of a failed non-net tool attempt (magnet / gripper / pad): `_finishFailedCatch` says `cause` and reels her
   * home or holds her for a retry; with REEL_HOME off or no tether, `legacy` (the whole comms message; null = say nothing)
   * and the old FEEP flight home.
   * @param {string} [cause] the cause, one sentence ending in a full stop; with it, `_finishFailedCatch` says the line
   * @param {object|null} [legacy] the whole comms message (REEL_HOME off); null/undefined = say nothing
   */
  _endToolFailure(cause, legacy) {
    const piece = this._stationKeepTarget || this.target;
    this._finishFailedCatch({ cause: cause || '', legacy, holdTarget: piece });
  }

  /**
   * @private Metres from her strut tip, or null before any mother position was seen (a bare test rig). Uses `_frameParentPos`,
   * `dockOffset` and the mother's orientation (`_frameParentQuat`, set in `_updateTether`; else the docked `_lastParentQuat`).
   */
  _strutTipDistM() {
    const pp = this._frameParentPos || this._prevParentPos;
    if (!pp) return null;
    const tip = this._resolveStrutDockWorld(pp, this._frameParentQuat || this._lastParentQuat, _failTip);
    return this.position.distanceTo(tip) / M;
  }

  /**
   * @private Seconds her strut reel needs to wind her home from `distM` metres out: the real speed rule (`_rhReelStep`
   * under the reel-gas profile, `_computeReelProfileSpeed` otherwise) stepped over the distance, with the state it keeps
   * (speed, gas bottle, readouts) saved and restored. The tail-first turn and the 2 m line-up hold depend on the mother and
   * are not in it, so it reads "about".
   * @param {number} distM
   * @param {boolean} [fromNow=false] seed the sim with her current reel speed (a reel already running) instead of rest
   * @param {boolean} [withCatch=false] the reel carries the net and a catch in her mass
   * @returns {number} seconds (Infinity if the sim does not arrive within 10 000 s)
   */
  _reelHomeEtaS(distM, fromNow = false, withCatch = false) {
    if (!(distM > 0)) return 0;
    const armMass = this.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS;
    if (!Constants.isFeatureEnabled('REEL_PROFILE_V2')) {
      return distM / (REEL_IN_SPEED_EMPTY || 1);
    }
    const keep = [this._rhReelV, this.coldGasKg, this._rhBraking, this._rhReelPhase, this._rhTensionN,
      this._rhReelMassKg, this._rhGasChecked];
    if (!fromNow) this._rhReelV = 0;
    this._rhGasChecked = true;                    // the "no gas" line belongs to the real reel
    const boost = (fromNow && this._boostReel) ? ((Constants.REEL_BOOST && Constants.REEL_BOOST.SPEED_MULT) || 2) : 1;
    const dt = 0.05;
    let left = distM, t = 0;
    for (let i = 0; i < 200000 && left > 1e-6; i++) {
      const v = this._rhReelStep(dt, left, Infinity, armMass, withCatch, boost);
      left -= Math.min(left, v * dt);
      t += dt;
    }
    [this._rhReelV, this.coldGasKg, this._rhBraking, this._rhReelPhase, this._rhTensionN,
      this._rhReelMassKg, this._rhGasChecked] = keep;
    return left > 1e-6 ? Infinity : t;
  }

  /**
   * Where she is on a reel home. 'reel' = wound in on her strut line (REELING, REEL_HOME), 'latch' = the dock
   * after such a reel (DOCKING), null otherwise. Cheap (no sim): the camera polls it every frame.
   * @returns {'reel'|'latch'|null}
   */
  reelHomeStage() {
    if (this.state === S.REELING && this._rhHome && this._rhOn()) return 'reel';
    if (this.state === S.DOCKING && this._rhDockFree && this._rhOn()) return 'latch';
    return null;
  }

  /**
   * Her strut tip in the world, written into `out` (scene units); null until a mother position has been seen.
   * @param {THREE.Vector3} out
   * @returns {THREE.Vector3|null}
   */
  strutTipWorldInto(out) {
    const pp = this._frameParentPos || this._prevParentPos;
    if (!pp) return null;
    return this._resolveStrutDockWorld(pp, this._frameParentQuat || this._lastParentQuat, out);
  }

  /**
   * What the reel is doing now, for her panel and the camera (DECISIONS §35). Read-only: nothing of her changes. Null unless
   * she is on a reel home (REEL_HOME, tethered) or latching onto her strut after one.
   * @param {boolean} [fresh=false] recompute the time left now (otherwise at most every 0.25 s, counted down between)
   * @returns {{phase:string, distM:number, speedMs:number, etaS:(number|null), startM:number, frac:number, catching:boolean}|null}
   *   phase: Pulling in | Reeling in | Braking | Lining up | Latching; speedMs: true m/s; etaS: real s left (null = unknown)
   */
  reelProgress(fresh = false) {
    const st = this.state;
    if (!this._rhOn() || !Constants.isFeatureEnabled('REEL_PROFILE_V2')) return null;
    if (st !== S.REELING && !(st === S.DOCKING && this._rhDockFree)) return null;
    const distM = this._strutTipDistM();
    if (distM == null) return null;
    const BS = TimeAuthority.BASE_SCALE || 10;
    if (this._rhReelStartM == null || !(this._rhReelStartM > 0)) this._rhReelStartM = distM;
    const startM = this._rhReelStartM;
    const catching = this.capturedDebris !== null;
    if (st === S.DOCKING) {
      const P = Constants.REEL_PROFILE || {};
      return { phase: 'Latching', distM, speedMs: (P.V_DOCK ?? 1.0) / BS,
        etaS: Math.max(0, (Constants.ARM_DOCK_DURATION ?? 3) - this.stateTimer), startM, frac: 1, catching };
    }
    const word = { pull: 'Pulling in', cruise: 'Reeling in', brake: 'Braking', hold: 'Lining up' }[this._rhReelPhase] || 'Reeling in';
    let etaS;
    const c = this._rpEtaCache;
    if (!fresh && c && c.timer <= this.stateTimer && this.stateTimer - c.timer < 0.25) {
      etaS = Math.max(0, c.etaS - (this.stateTimer - c.timer));
    } else {
      const e = this._reelHomeEtaS(distM, true, catching);
      etaS = Number.isFinite(e) ? e : null;
      this._rpEtaCache = { timer: this.stateTimer, etaS: etaS == null ? 0 : etaS };
      if (etaS == null) this._rpEtaCache.etaS = 0;
    }
    return { phase: word, distM, speedMs: this._rhReelV / BS, etaS, startM,
      frac: clamp01(1 - distM / startM), catching };
  }

  /**
   * @private Called from `_transitionTo`. A reel home starting says how far and how long ("Reeling Large 1 home: 48 m,
   * about 21 s."), unless the failed-catch or hold line just gave the time; the latch after a reel says she is home. Also
   * keeps the reel's starting distance for the panel bar.
   */
  _rhNoteTransition(old, newState) {
    if (newState === S.REELING) {
      this._rpEtaCache = null;
      this._rhReelStartM = null;
      this._rhReelSeq = ++_reelSeqCounter;       // which reel this is (the camera follows the newest)
      const quiet = this._rhReelLineQuiet === true || this._rhReelEtaSaid === true;
      this._rhReelLineQuiet = false;
      this._rhReelEtaSaid = false;
      if (!this._rhOn() || old === S.REELING) return;
      const distM = this._strutTipDistM();
      if (distM == null) return;
      this._rhReelStartM = distM;
      if (quiet) return;
      const e = Constants.isFeatureEnabled('REEL_PROFILE_V2') ? this._reelHomeEtaS(distM, false, this.capturedDebris !== null) : Infinity;
      const tail = Number.isFinite(e) ? `${Math.round(distM)} m, about ${Math.max(1, Math.round(e))} s` : `${Math.round(distM)} m`;
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'HOUSTON', channel: 'CMD', priority: 'info',
        text: `Reeling ${this.displayName} home: ${tail}.${this._rhReelNote || ''}`,
      });
      if (this._rhReelNote) this._rhReelNoteSaid = true;
      return;
    }
    // One line at the latch: with a catch, the dock code says "<name>: Catch secured at the strut ..." right after this
    // transition (HOLDING_CATCH), so that one is the line and this one stays quiet (owner: one line per event).
    if (old === S.DOCKING && this._rhDockFree && (newState === S.RELOADING || newState === S.DOCKED)) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'HOUSTON', channel: 'CMD', priority: 'success',
        text: `${this.displayName} is home.`,
      });
    }
    if (newState !== S.STATION_KEEP) this._rhReelEtaSaid = false;
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

  /** @private She holds near the piece for a retry (STATION_KEEP on `piece`), eased to the usual standoff with a fresh orbit frame. */
  _holdForRetry(piece) {
    const SKC = Constants.STATION_KEEP;
    if (this._stationKeepTarget && this._stationKeepTarget !== piece) this._stationKeepTarget._isStationKeepTarget = false;
    this._stationKeepTarget = piece;
    this.target = piece;
    piece._isStationKeepTarget = true;
    this._captureToolKind = 'NET';
    const standoff = clamp((piece.sizeMeter || 1) * SKC.DEFAULT_STANDOFF_MULT, SKC.DEFAULT_STANDOFF, SKC.MAX_STANDOFF);
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
    this._skPolarAxis = null;
    this._skEquator0 = null;
    this._skRightVec = null;
    this._skPitch0 = 0;
    this._skIdleS = 0;
    this._transitionTo(S.STATION_KEEP);
  }

  /**
   * @private The ONE end of a failed catch (pad bounce / timeout / no grip, magnet, gripper, a net miss, a net that slips
   * or rips, the target lost mid-net); DECISIONS §34 row 11.
   *   REEL_HOME off or no tether (detached): her line `legacy` and her FEEP flight home (RETURNING) or, with
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
    this._pairCatchFailed = true;            // the partner does not wait for a catch that is not coming (`ArmManager._tickPairHome`)
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
      this._transitionTo(S.RETURNING);
      return 'return';
    }
    const piece = (holdTarget && holdTarget.alive !== false && !holdTarget._captured) ? holdTarget : null;
    const distM = this._strutTipDistM();
    const far = distM != null && distM > ((Constants.FAIL_REEL && Constants.FAIL_REEL.AUTO_REEL_MAX_M) ?? 200);
    // owner 2026-10-22: every reel line gives the distance and the real reel time (`_reelHomeEtaS`).
    const etaS = distM != null ? Math.round(this._reelHomeEtaS(distM, false, false)) : NaN;
    const etaTxt = Number.isFinite(etaS) ? `about ${etaS} s` : 'a long haul';
    const lead = cause ? `${cause} ` : '';
    // A hold is for a retry; with no net left in a net daughter's magazine there is none, so reel whatever the range.
    const noRetry = Constants.isFeatureEnabled('CAPTURE_NET') && (this._netInventory ?? 0) <= 0
      && (!this.selectedTool || this.selectedTool === 'NET');
    if (far && piece && !noRetry) {
      // "Press X" is what GestureHints.chipPhrase turns into a touch button (DECISIONS §32).
      say(`${lead}${Math.round(distM)} m out: holding for a retry. ${pressNToLine(this, 'retry', piece)}, Press R to reel her home (${etaTxt}).`);
      this._holdForRetry(piece);
      this._rhReelEtaSaid = true;                 // R from this hold: the line above gave the time
      return 'hold';
    }
    say(distM != null
      ? `${lead}Reeling her home: ${Math.round(distM)} m, ${etaTxt}. Press D to relaunch.`
      : `${lead}Reeling her home; Press D to relaunch.`);   // no mother position seen yet (a bare unit)
    this._rhReelLineQuiet = true;
    this._reelHomeAfterFailure();
    this._rhReelLineQuiet = false;
    return 'reel';
  }

  /**
   * Begin a 3-jaw gripper grapple from STATION_KEEP: sub-FSM in `_updateGripperGrapple`, EXTEND → SEEK (fixture raycast) → CLOSE → latch roll.
   * @returns {boolean}
   */
  gripperGrapple() {
    if (this.state !== S.STATION_KEEP) return false;
    if (this._inspectOnlyRefuses()) return false;
    if (!Constants.isFeatureEnabled('WEAVER_GRIPPER')) return this._toolOffline('GRIPPER');
    const target = this._stationKeepTarget || this.target;
    if (!target) { audioSystem.playDeny(); return false; }

    eventBus.emit(Events.STATION_KEEP_EXITED, { armId: this.id, reason: 'gripper' });
    this._gripPhase = 'EXTEND';
    this._gripTimer = 0;
    this._captureToolKind = 'GRIPPER';
    audioSystem.playClick();
    this._toolLockedDebrisId = target.id;
    eventBus.emit(Events.AUTOPILOT_TARGET_LOCK, { debrisId: target.id });
    eventBus.emit(Events.COMMS_MESSAGE, {
      source: this.displayName, text: `${this.displayName}: Extending gripper jaws. Seeking a fixture`,
      channel: 'CMD', priority: 'info',
    });
    this._transitionTo(S.GRIPPER_GRAPPLE);
    return true;
  }

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

  /**
   * Pad adhesion mode from target surface metadata at contact: a mode string, or null (NO_MODE: exotic surface, UV doses spent).
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
    // Last resort: finite UV-cure magazine; once spent, NO_MODE.
    if ((this._padUvCureDosesRemaining || 0) > 0) return 'uv_cure';
    return null;
  }

  /**
   * Begin a multi-modal pad contact from STATION_KEEP: sub-FSM in `_updatePadContact`, APPROACH_SOFT → CONTACT → grip roll.
   * @returns {boolean}
   */
  padContact() {
    if (this.state !== S.STATION_KEEP) return false;
    if (this._inspectOnlyRefuses()) return false;
    if (!Constants.isFeatureEnabled('SPINNER_PAD')) return this._toolOffline('PAD');
    const target = this._stationKeepTarget || this.target;
    if (!target) { audioSystem.playDeny(); return false; }

    eventBus.emit(Events.STATION_KEEP_EXITED, { armId: this.id, reason: 'pad' });
    this._padPhase = 'APPROACH';
    this._padTimer = 0;
    this._padResolvedMode = null;
    // Her real offset from the piece NOW (both last frame's scene positions), so the first approach frame already rides
    // with it; `_updatePadContact` takes it lazily if a caller drives that without this.
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
   * APPROACH is a station-keeping final approach, not a chase: she moves WITH the piece (her offset from it is kept and
   * re-added to its scene position every frame) and closes at a speed proportional to the gap, clamped
   * (`APPROACH_GAIN_PER_S`, `APPROACH_V_MIN_M_S`, `APPROACH_V_MAX_M_S`), to the piece's SURFACE (`DebrisField.trueReachM`
   * plus the pad radius). The touch speed is the commanded closing speed (V_MIN floor), RELATIVE to the piece, not her
   * stored velocity. A plain lerp trailed a moving piece and timed out. `_padContactVelOverride` is the test seam.
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
        // Reach = the radius the tip-fit and the seating use (`DebrisField.trueReachM`); a piece with no size has reach 0.
        const stopM = DebrisField.trueReachM(target, 0) + P.PAD_RADIUS_M;   // distance from the piece's centre at contact
        const dM = off.length() / M;
        const gapM = dM - stopM;
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
    if (Constants.isFeatureEnabled('CAPTURE_NET')) {
      this._updateNettingFSM(dt);
      return;
    }

    // Legacy path (CAPTURE_NET OFF): 85% dice roll
    if (!this._manualCapture && this._autoFailChance > 0) {
      // Consume the failure chance immediately (single roll, not per-frame)
      const failChance = this._autoFailChance;
      this._autoFailChance = 0;

      const tumbleDeg = (this.target?.tumbleRate || 0) * RAD2DEG;
      const isHighTumble = tumbleDeg > 50;

      if (isHighTumble && Math.random() < failChance) {
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.displayName}: AUTO-CAPTURE FAILED. Target tumble too high!`,
          priority: 'critical',
        });
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.displayName}: Tumble too high for auto-capture. Pilot her in manually (1-4) for a better grip.`,
          priority: 'warning',
        });

        this.capturedDebris = null;
        this.target = null;
        this._transitionTo(S.RETURNING);
        return;
      }
    }

    const tPos = this._getTargetScenePos();
    if (tPos) {
      this.position.lerp(tPos, 0.02);
    }

    if (this.stateTimer > Constants.ARM_NET_DEPLOY_TIME) {
      const success = Math.random() < Constants.ARM_CAPTURE_SUCCESS_RATE;
      if (success) {
        this.capturedDebris = this.target;
        if (this.target) {
          this.target._captured = true;  // hides the reticle immediately
          this.target._capturedByArm = this;
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
   * @private NETTING for CAPTURE_NET ON: fire a daughter net via CaptureNetSystem (count decremented once, inside
   * fireDaughterNet) and poll the 14-state FSM each frame.
   */
  _updateNettingFSM(dt) {
  const CN_STATES = Constants.CAPTURE_NET.STATES;

  // Stored reference first (survives activeNets lookup issues), then the system query.
  let activeNet = this._firedNet || captureNetSystem.getActiveNetForArm(this.index);
   if (!activeNet) {
     const launchPos = {
       x: this.position.x / M,
       y: this.position.y / M,
       z: this.position.z / M,
     };
      // Launch direction leads the target: aim at targetPos + relVel × (dist / LAUNCH_SPEED). Close-range SK shots barely
      // change; long shots stop missing. SCENE UNITS throughout: LAUNCH_SPEED is m/s, so × M. Same computeLeadAim as the
      // HUD's OFF-AXIS advisory (DockingReticle), so the warning never disagrees with where the shot goes.
      const tPos = this._getTargetScenePos();
      let launchDir = { x: 1, y: 0, z: 0 };
      if (tPos) {
        const relVel = this._leadTargetVelValid ? this._leadTargetVel : null;
        // Net class via the canonical selector (same class fireDaughterNet launches) so the lead's time-of-flight matches.
        const _cnClass = getNetClassForType(this.type);
        const launchSpeedScene = (this._firedNet?.netClass?.LAUNCH_SPEED
          || _cnClass?.LAUNCH_SPEED || 10) * M;
        launchDir = computeLeadAim(this.position, tPos, relVel, launchSpeedScene).dir;
        // ?debug=1: log lead magnitude + off-axis angle at fire time (≈0 from a settled SK; a large value flags another drift source).
        if (Constants.DEBUG && Constants.DEBUG.LOG_RENDERER_DIAGNOSTICS) {
          const bx = tPos.x - this.position.x, by = tPos.y - this.position.y, bz = tPos.z - this.position.z;
          const bLen = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
          const dot = Math.min(1, Math.max(-1,
            (launchDir.x * bx + launchDir.y * by + launchDir.z * bz) / bLen));
          const offAxisDeg = radToDeg(Math.acos(dot));
          const relSpeed = relVel ? Math.sqrt(relVel.x ** 2 + relVel.y ** 2 + relVel.z ** 2) : 0;
          console.info(`[LeadAim] ${this.id} fire: |relVel|=${(relSpeed / M).toFixed(3)} m/s ` +
            `offAxis=${offAxisDeg.toFixed(2)}° dist=${(bLen / M).toFixed(1)} m state=${this.state}`);
        }
      }

     // A flat pack: the launcher's release device has no power (a started shot finishes its frame; this is the next one).
     activeNet = this._powerOff() ? null : captureNetSystem.fireDaughterNet(
       this, this.index, launchPos, launchDir, this.target
     );

     if (!activeNet) {
       // fireDaughterNet returned null (cooldown/inventory/flag): fall back to SK (not APPROACH, which causes
       // "screen-races-to-debris" at orbital speed), and name the reason: a silent fallback left the player guessing.
       {
         const inv = (typeof this.getNetInventory === 'function')
           ? this.getNetInventory() : (this._netInventory || 0);
         const cdS = (typeof captureNetSystem.getCooldown === 'function')
           ? captureNetSystem.getCooldown('arm', this.index) : 0;
         const reason = this._powerOff()
           ? `${batteryFlatLine()} Net launcher off. Holding station.`
           : cdS > 0
             ? `Net launcher cooling down. Ready in ${Math.ceil(cdS)}s.`
             : 'Net launcher unavailable. Holding station.';
         eventBus.emit(Events.COMMS_MESSAGE, {
           source: this.displayName,
           // Out of nets: the ONE line, exact (nets refill only at the resupply stop; nothing reloads on docking).
           text: inv <= 0 ? daughterOutOfNetsLine() : `${this.displayName}: ${reason}`,
           channel: 'CMD', priority: 'warning',
         });
       }
       this._firedNet = null;
       this._transitionTo(S.STATION_KEEP);
       return;
     }
     this._firedNet = activeNet;
     this.power.shot(this._powerDocked());       // the release device: LAUNCHER_W for LAUNCHER_S (2.5 J), her pack's out, the mother's docked

     // §11.4: the launch is real now: kick the launcher with the FIRED net's class and exact direction (one fire site: once per launch).
     this.applyNetFireRecoil(activeNet.netClass, launchDir);
   }

    // NETTING: track the target at the same SK standoff offset so the camera stays stable while the net flies: reuse the SK
    // frame vectors (frozen at SK entry: _skPolarAxis, _skRightVec, _skEquator0, _skPitch0) + spherical coords (_orbitTheta,
    // _orbitPhi, _standoffR) for an exact goal, then lerp at the SK rate (overwriting jumps ~1 m/frame against the parent frame).
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
        // §11.4 net-fire recoil: same goal displacement as _updateStationKeep; the kick lands DURING NETTING. The step also
        // bills the recovery surcharge (NETTING's only fuel debit; flag OFF ⇒ zero, byte-identical).
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

    const netState = activeNet.state;
    // A scoop net that closed on several pieces holds ONE bag (CaptureNet._scoopIntoBag, which also sets `arm.target`): adopt
    // it here too, so `reelCaught` and later reads see the bag whichever update ran first. A net swaps its target only for a bag.
    if (activeNet.catchResult === 'success' && activeNet.targetDebris && activeNet.targetDebris.isBag === true
        && activeNet.targetDebris !== this.target) {
      this.target = activeNet.targetDebris;
    }
    // The net system resolves a catch and auto-starts its reel in ONE update (CaptureNet.update's needsAutoReel), so this poll
    // never saw CAPTURED: take that as the catch too, or the held-net hold (CaptureNet._updateReeling) lets go and the bag drops ~1 s later.
    const reelCaught = netState === CN_STATES.REELING && activeNet.catchResult === 'success'
      && activeNet._heldByArm === true && activeNet.targetDebris === this.target;
    if (netState === CN_STATES.CAPTURED || reelCaught) {
      this.capturedDebris = this.target;
      // The STOWED branch cleared these; a catch now arrives here instead.
      if (this._netCommittedTarget) this._netCommittedTarget._committedNetArmId = null;
      this._netCommittedTarget = null;
      // ASPECT_CAPTURE: freeze the presented width AT CATCH TIME (the reel-start oversize check judges what the net wrapped).
      this._catchPresentedWidthM = (activeNet._presentedWidthM != null)
        ? activeNet._presentedWidthM : null;
      if (this.target) {
        this.target._captured = true;
        this.target._capturedByArm = this;
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
      // GUARD: target died mid-net-flight (deorbit, cull, fragmentation): go straight to RETURNING, not SK (nothing to hold on).
      const committedAlive = this._netCommittedTarget && this._netCommittedTarget.alive !== false;
      eventBus.emit(Events.ARM_CAPTURE_FAILED, {
        armId: this.id, targetId: this.target?.id,
      });
      if (!committedAlive) {
        // REEL_HOME: wound home on her strut line (no piece left to hold near); else RETURNING.
        this._finishFailedCatch({
          cause: 'Target lost during net flight.',
          legacy: { text: `${this.displayName}: Target lost during net flight. Returning empty.`, priority: 'warning' },
        });
      } else {
        // REEL_HOME: within FAIL_REEL.AUTO_REEL_MAX_M she is wound home, farther out she holds for a retry with the reel-in
        // time in the line. Legacy: fall back to SK (not APPROACH, which causes "screen-races-to-debris" at orbital speed);
        // the arm stays at standoff and the pilot retries with N.
        this._finishFailedCatch({
          cause: 'Netting failed.',
          legacy: { text: `${this.displayName}: Netting failed. Holding standoff. ${pressNToLine(this, 'retry', this._netCommittedTarget || this.target)}.`, priority: 'warning' },
          holdTarget: this._netCommittedTarget, legacyHold: true,
        });
      }
    } else if (netState === CN_STATES.STOWED) {
      if (activeNet.catchResult === 'success') {
        this.capturedDebris = this.target;
        if (this.target) {
          this.target._captured = true;
          this.target._capturedByArm = this;
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
        const committedAliveStowed = this._netCommittedTarget && this._netCommittedTarget.alive !== false;
        if (!committedAliveStowed) {
          this._finishFailedCatch({
            cause: 'Target lost during net flight.',
            legacy: { text: `${this.displayName}: Target lost during net flight. Returning empty.`, priority: 'warning' },
          });
        } else {
          // Miss STOWED: legacy stays in SK so the pilot can retry without re-approaching; REEL_HOME: reeled home within
          // FAIL_REEL.AUTO_REEL_MAX_M, held for a retry beyond it.
          this._finishFailedCatch({
            cause: 'Netting failed.', holdTarget: this._netCommittedTarget, legacyHold: true,
          });
        }
      }
    }
  }

  /**
   * A tool catch (pad, magnet, gripper) is pinned TO HER (`_secureToolCatch` -> `_pinCatchToSelf`), and
   * `DebrisField.pinCapturedDebris` copies that pin back into the piece's `_scenePosition` every frame. So that position
   * is last frame's pin, i.e. where she was BEFORE this frame's orbital APPLY step: copying it onto her (the net catch's
   * snap) throws away the mother's orbital step each frame (~7.7 km live) and leaves her ~150 km out when the reel starts.
   * A tool catch already rides with her; a net catch is a free piece she goes to.
   * @returns {boolean}
   */
  _toolCatchRidesWithHer() {
    // Also require the catch to be pinned to her (`_secureToolCatch` pins it), so a stale tool kind left by a net entry
    // that does not reset it can never skip a net catch's snap.
    return !!this._captureToolKind && this._captureToolKind !== 'NET'
      && !!this.capturedDebris && this.capturedDebris._armPinned === true;
  }

  /**
   * GRAPPLED: holding debris, stabilize before hauling/reeling. reel-home (flag on, a NET catch): she does NOT jump onto the
   * debris; she stays where the net closed and the catch is held at its separation; after the settle her net line winds it
   * in to her nose (`_rhNetReelStep`), the pair's centre of mass staying put, and only then does the strut reel take over.
   */
  _updateGrappled(dt, parentPos = null, parentQuat = null) {
    const rh = this._rhOn() && this._rhNetCatch();
    const tPos = this._getTargetScenePos();
    if (rh) {
      this._rhHoldCatch(tPos);
    } else if (this._toolCatchRidesWithHer()) {
      // The catch rides with her through the hold too (ArmManager draws it from this pin in GRAPPLED).
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
      // Net-integrity check at reel start (a heavy, near-rated catch can slip the net; recoverable, handled inside the check).
      // Not again once the net reel runs: it rolls dice once per call, and the reel lasts a while.
      if (!(rh && this._rhHome) && this._checkNetIntegrityOnReel()) return;

      // SNUG sub-phase (REEL_PROFILE_V2): cinch the stage-1 net tight so daughter+net+debris is ONE rigid unit (one CoM, m_unit):
      // ask the held net for its snug tension, wait SETTLE_S for the transient to damp, emit CATCH_SNUGGED once, then enter REELING.
      // Only the GRAPPLED→REELING capture path snugs (reelFromStationKeep aborts have no catch).
      if (Constants.isFeatureEnabled('REEL_PROFILE_V2') && this.capturedDebris && !this._catchSnugged) {
        this._applySnugTension();
        const settle = (Constants.CATCH_SNUG && Constants.CATCH_SNUG.SETTLE_S) ?? 0.4;
        if (this.stateTimer <= Constants.ARM_GRAPPLE_STABILIZE + settle) {
          return;
        }
        this._catchSnugged = true;
        const armMass = this.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS;
        eventBus.emit(Events.CATCH_SNUGGED, {
          armIndex: this.index,
          debrisId: this.capturedDebris.id,
          mUnit: this._computeReelMUnit(armMass, true),
        });
      }

      // reel-home: her net winds the catch in to her nose before the strut reel starts; REELING is entered once the catch
      // sits in its rack cell on her.
      if (rh && !this._rhNetDone) {
        if (!this._rhHome) this._rhBeginNetReel();
        if (!this._rhNetReelStep(dt)) return;
        this._rhNetDone = true;
      }
      // Seated: the catch's spin is cancelled with her gas (and her damper); she holds here until it is done, then goes home.
      if (rh && this._seatSpin) return;
      // pair-home: a daughter of a pair launch waits here until her partner's catch is in its cell too; `ArmManager._tickPairHome`
      // lets both go in ONE call, so both enter REELING in the same frame. A single never waits.
      if (rh && this._pairBarrierHolds(dt)) return;

      // Zero-fuel motor reel-in instead of fuel-burning HAULING
      this._transitionTo(S.REELING);
      // Under REEL_HOME `_transitionTo` already said "Reeling <name> home: <m> m, about <s> s." from the real profile
      // (`_reelHomeEtaS`); the tetherLength / speed guess below is the legacy line only.
      if (!this._rhOn()) {
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
  }

  /**
   * Does the pair barrier hold her now? The catch is in its cell (`_rhNetDone`). With no partner link she goes on at once.
   * With one she waits (counting `dt`, mission-clock seconds); `ArmManager._tickPairHome` sets `_pairGo` on both when both
   * wait, on one alone after `PAIR_SHOT.HOME_WAIT_S` or when the link breaks. `_pairGo` is read once, here.
   * @param {number} dt @returns {boolean} true while she holds @private
   */
  _pairBarrierHolds(dt) {
    const go = this._pairGo;
    if (go) {
      this._pairGo = null; this._pairWaiting = false; this._pairWaitS = 0;
      this._pairTogether = go === 'both';
      return false;
    }
    if (!this._pairPartner) { this._pairWaiting = false; this._pairWaitS = 0; return false; }
    if (!this._pairWaiting) { this._pairWaiting = true; this._pairWaitS = 0; }
    this._pairWaitS += dt;
    return true;
  }

  /**
   * @private SNUG cinch (REEL_PROFILE_V2): tell the held stage-1 net to tighten to CATCH_SNUG.TENSION_TARGET_N so the bag
   * rigidizes onto the debris before the haul. The net's _updateReeling honours `_snugTargetN` while `_heldByArm` (otherwise
   * its tension is the base mass formula). No-op for non-NET grips.
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
   * Yoke tether-plume clearance test (REEL_PROFILE_V2).
   *
   * FEEP braking fires the fore nozzle (+Z exhaust) toward the mother, the side the tether runs to. In the whole-haul reel
   * attitude the nose converges ONTO the dock line, so a nose-referenced ≥30° test (MIN_TETHER_PLUME_DEG = 20° plume
   * half-angle + 10° UNCOMMANDED vector wander) fouls every production dock (0.00° measured at the arrest window).
   * Geometry (weaver numbers at entry d = 8 m):
   *  1. REAL BRIDLE GEOMETRY: the tether anchors at the +Y wishbone bridle apex, local (0, +BRIDLE_APEX_Y_FRAC·by, 0)
   *     (hardware in _createMesh), NOT at the nose. Standoff atan(0.70·0.2/8) ≈ 1.0° at entry; the daughters are 0.1–0.3 m
   *     craft, so this term alone never reaches 30° (or 20°) at arrest range.
   *  2. ARREST STEER ATTITUDE: the whole-haul attitude owner blends the nose ARREST_STEER_DEG (15°) AWAY from the bridle
   *     side inside the arrest approach (REELING branch in update()), fully converged at entry via ARREST_STEER_LEAD_M. That
   *     keeps the ENTIRE cable on the opposite side of the exhaust cone; steering TOWARD the bridle side would sweep the
   *     beam through the cable at ~0.3 m range, which is why the sign matters.
   *  3. COMMANDED-STEER DECOMPOSITION: during the arrest the vector loop is closed, so the 10° wander budget collapses to
   *     STEER_JITTER_DEG (2°) and the requirement against the STEERED axis is PLUME_HALF_ANGLE_DEG + STEER_JITTER_DEG = 22°.
   *     The emitter adds up to VECTOR_ENVELOPE_DEG (15°, electrostatic, free) of commanded steer. Production entry: 15°
   *     (attitude) + 1° (bridle) + 6° (steer) = 22° ⇒ clear. Un-converged/seized attitude (nose on the dock line):
   *     1° + 15° = 16° < 22° ⇒ fouled, winch fallback.
   *
   * Angles ≥ MIN_TETHER_PLUME_DEG (30°) clear unassisted, no steer surcharge. When `clear` is false FEEP is withheld and the
   * reel finishes on the motor alone (no §4.2 ablation is simulated). Degenerate/test geometry (no parent frame) clears so
   * minimal mocks aren't blocked.
   *
   * @param {THREE.Vector3} [parentPos] mother world position
   * @param {THREE.Quaternion} [parentQuat] mother world orientation
   * @returns {{clear: boolean, steerNeededDeg: number}} `clear` = FEEP permitted; `steerNeededDeg` = commanded electrostatic
   *   steer for the burn (0 when it clears unassisted; drives the cos-loss debit surcharge at the call site)
   * @private
   */
  _tetherPlumeClearance(parentPos, parentQuat) {
    const YC = Constants.YOKE_CLEARANCE || {};
    const minDeg = YC.MIN_TETHER_PLUME_DEG ?? 30;
    if (!parentPos || !this.dockOffset) {
      return { clear: true, steerNeededDeg: 0 };   // test/degenerate geometry
    }

    // Strut dock world position (tether mother-side anchor), via the shared resolver the reel target uses.
    const dockWP = this._tmpPlumeDock || (this._tmpPlumeDock = new THREE.Vector3());
    this._resolveStrutDockWorld(parentPos, parentQuat, dockWP);

    // Tether line: +Y bridle apex (the REAL daughter-side anchor, see _createMesh) → strut dock. Brake-plume axis:
    // daughter world +Z (nose), the fore-nozzle exhaust direction under the whole-haul reel attitude.
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
    const angleDeg = radToDeg(Math.acos(cos));

    // Unassisted fast path: cable already rides ≥ 30° outside the worst-case (wander-inclusive) cone; no steer, no surcharge.
    if (angleDeg >= minDeg) return { clear: true, steerNeededDeg: 0 };

    const required = (YC.PLUME_HALF_ANGLE_DEG ?? 20) + (YC.STEER_JITTER_DEG ?? 2);
    const steerNeededDeg = Math.max(0, required - angleDeg);
    const clear = steerNeededDeg <= (YC.VECTOR_ENVELOPE_DEG ?? 15);
    return { clear, steerNeededDeg };
  }

  /**
   * Boolean wrapper over {@link _tetherPlumeClearance} (true = FEEP permitted), kept for external probes/diagnostics.
   * @param {THREE.Vector3} [parentPos] mother world position
   * @param {THREE.Quaternion} [parentQuat] mother world orientation
   * @returns {boolean} true if the tether clears the plume (FEEP permitted)
   */
  _tetherPlumeClearOK(parentPos, parentQuat) {
    return this._tetherPlumeClearance(parentPos, parentQuat).clear;
  }

  /**
   * Arrest-window beam-steer attitude offset (geometry: `_tetherPlumeClearance`).
   *
   * Rotates the whole-haul reel AIM (`headingDir`, unit, in place) by w(d)·ARREST_STEER_DEG about the axis ⊥(bridle-up,
   * heading), swinging the nose AWAY from the bridle's world side.
   *
   * Blend law: w(d) = clamp01(((ARREST_DISTANCE_M + ARREST_STEER_LEAD_M) − d) / ARREST_STEER_LEAD_M): zero at/outside the
   * 14 m engage line, FULL at the 8 m window entry. The LEAD band exists because the one-shot arrest gate/debit fires on the
   * FIRST frame inside ARREST_DISTANCE_M: a blend confined inside the window would give that frame the un-steered nose
   * (w≈0), foul the gate, and always take the winch. w is continuous in d and the caller's REEL_ATTITUDE_SLERP smooths the
   * remainder, so the offset blends in AND back out (window bounce, dock handoff) with no orientation snap at the 8 m line.
   * Called ONLY from the REELING whole-haul attitude branch in update(), the single owner of the REELING quaternion
   * (CONVENTIONS.md §9 Rule 8 / §10 Rule B); the gate reads the quaternion, never writes it.
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
    const w = clamp01(((arrestDist + leadM) - distMeters) / leadM);
    if (w <= 0) return headingDir;

    // Bridle-up in world space (local +Y through the current attitude).
    const bridleUp = this._tmpSteerUp || (this._tmpSteerUp = new THREE.Vector3());
    bridleUp.set(0, 1, 0).applyQuaternion(this.group.quaternion);
    // Rotating heading about cross(bridleUp, heading) tilts the nose away from the bridle side. Degenerate (bridle ∥ heading:
    // nose ⊥ dock line) geometries already clear the gate unassisted: skip.
    const axis = this._tmpSteerAxis || (this._tmpSteerAxis = new THREE.Vector3());
    axis.crossVectors(bridleUp, headingDir);
    if (axis.lengthSq() < 1e-12) return headingDir;
    axis.normalize();
    headingDir.applyAxisAngle(axis, degToRad(w * steerDeg)).normalize();
    return headingDir;
  }

  /**
   * Release the captured debris back into the field as a free, re-targetable body (both capture-failure modes). It resumes
   * its propagated orbit (the capture was only a visual pin) and is tagged `_netted`, so a lost catch never silently vanishes.
   * @param {object} [opts]
   * @param {boolean} [opts.keepPinned=false] keep `_capturedByArm` so the debris drifts WITH this arm (tether snap: the net
   *        stays intact between the daughter and debris); when false it detaches and floats free
   * @returns {object|null} the released debris (or null if none)
   * @private
   */
  _releaseCapturedDebris({ keepPinned = false } = {}) {
    const debris = this.capturedDebris;
    if (!debris) return null;
    debris._netted = true;
    debris._captured = false;          // re-targetable by the next daughter
    debris._isStationKeepTarget = false;
    debris._committedNetArmId = null;
    if (!keepPinned) {
      // Detach: clear the pin so DebrisField resumes orbit-driven positioning and restores LOD.
      debris._capturedByArm = null;
      debris._armPinned = false;
      clearShipRelativeAttitude(debris);
      clearRackCell(debris);           // and any cell it was assigned
    }
    this.capturedDebris = null;
    this.reeling = false;
    this.tetherTension = 0;
    return debris;
  }

  /**
   * Authoritative catch pin: force the captured debris to this arm's position for the renderer AND every consumer (net
   * visual, camera, autopilot, gap diagnostics). Belt-and-suspenders over DebrisField's `_capturedByArm` pin, which proved
   * fragile for station-keep / welcome-field debris (the catch drifted hundreds of metres on its own orbit).
   *
   * The pin carries a STANDOFF along the hold axis, `arm.position + holdDir × standoff`, so the daughter never renders
   * inside a catch larger than herself. For a catch with a drawn mesh the standoff is `d._holdStandoffM`, recomputed EVERY
   * pin from the two drawn shapes (`catchHoldStandoffM`: her support along the axis + the catch's support along -axis +
   * ARM_HOLD_NET_GAP_M), so the nearest drawn point sits one net gap off her end; a catch with no type (old saves, rigs)
   * keeps `sizeMeter/2 + ARM_HOLD_CLEARANCE_M`. holdDir is the capture axis (net launchDirection while the fired-net ref
   * lives), else the outboard direction from the mother (the catch hangs outboard of the daughter in REELING and of the
   * strut in HOLDING_CATCH, tracking parent rotation each re-pin).
   * @param {THREE.Vector3|null} [parentPos] freshest mother position (falls back to _prevParentPos)
   * @param {number} [lateralBias=0] perpendicular offset (× catch radius) sliding the bag off the camera→daughter axis so the
   *   parked daughter stays visible beside her catch (HOLDING_CATCH). 0 = pure outboard.
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
    const pp = parentPos || this._frameParentPos || this._prevParentPos;   // this frame's mother first
    if (!hasDir && pp) {
      dir.subVectors(this.position, pp);
      hasDir = dir.lengthSq() > 1e-12;
    }
    if (hasDir) dir.normalize(); else dir.set(0, 0, 0);
    const clearance = (Constants.ARM_HOLD_CLEARANCE_M ?? 1.0);
    // ONE number for the in-hand pin: the per-frame tight standoff for a catch with a drawn mesh, else sizeMeter/2 + clearance.
    // Mark it pinned BEFORE measuring: the renderer draws a pinned catch at the net-held floor, so the standoff reads that
    // drawn scale (DebrisField.effectiveRenderScale).
    d._armPinned = true;
    const snugM = hasDir
      ? catchHoldStandoffM(this.group.quaternion, this.config.bodyDims, d, dir,
        Constants.ARM_HOLD_NET_GAP_M ?? 0.03, this._solidPointsM(),
        // The exact seat wherever she is parked or holding. While she is being turned (the reel's and the DOCKING slerp,
        // PlayerSatellite.postArmUpdate, AFTER this pin, up to ~20 degrees in the first frame) the pin runs twice a frame with
        // a new attitude each time: a 3 cm seat would clip (measured: gap 0.000 m in test-CatchHoldTight T8) and cost 2 x 13 ms
        // a frame (test-ReelView 174 s CPU). The support rule's slack stands in until she is parked; then cell, stow and glide seat it exactly.
        (this.state === S.DOCKING || this.state === S.RELOADING || this.state === S.REELING) ? null : this._seatGeo())
      : null;
    if (snugM !== null) {
      // A piece over 1 m is answered with the support rule while it turns (`seatStandoffM`), with the exact seat once it is
      // still; that step is up to a metre nearer her, so it eases in (inward only: farther out is always clear; a new turn answers outward at once).
      const prev = d._holdStandoffM;
      const step = Constants.SEAT_EASE_STEP_M ?? 0.0045;
      d._holdStandoffM = (d.sizeMeter > (Constants.SEAT_TURN_GUARD_OVER_M ?? 1.0) && Number.isFinite(prev) && snugM < prev - step) ? prev - step : snugM;
    }
    else if (d._holdStandoffM !== undefined) d._holdStandoffM = undefined;
    const standoffM = Number.isFinite(d._holdStandoffM)
      ? d._holdStandoffM
      : (d.sizeMeter || 0) / 2 + clearance;
    const standoffScene = standoffM * M;
    if (!d._armPinPos) d._armPinPos = new THREE.Vector3();
    d._armPinPos.copy(this.position).addScaledVector(dir, standoffScene);

    // HOLDING_CATCH: the catch parks full-size at the strut tip OUTBOARD of the ~1 m daughter; from the usual camera a 5 m bag
    // on the camera→daughter axis eclipses her. Slide it off that axis (perpendicular to the hold direction): holdDir × world-up,
    // or world-X when holdDir ∥ up. Scales with the catch radius so bigger catches clear further.
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
   * Free parked-hold cells on the cargo rack: the cargo transfer's candidate filter (a full rack refuses BEFORE anything
   * moves). One cell (DECISIONS §35 row 1), so a daughter holding a catch has none free.
   * @returns {number}
   */
  get holdCellsFree() {
    return Math.max(0, (Constants.DAUGHTER_CARGO_CELLS ?? 1) - this.heldCatches.length);
  }

  /**
   * Push a piece onto the parked cargo rack. The haul path can never trip the capacity guard (a daughter parks with exactly
   * one piece into an empty rack); it exists so a full rack REFUSES the push instead of silently dropping cargo. The rack
   * holds ONE piece (DECISIONS §35 row 1): a daughter that already holds a catch refuses a second (returns false; the
   * caller keeps the piece).
   *
   * The stow ASSIGNS the cell (the smallest free one) unless a cargo flight to this daughter already did (`d._rackArm ===
   * this`, its end was fixed at the flight's start). The piece's attitude in HER frame is frozen from its attitude now, so
   * it does not jump. The piece she carries IN HAND (tight at her end, along the net's launch direction) then glides to the
   * cell over ARM_HOLD_GLIDE_S.
   * @param {object} debris
   * @param {THREE.Quaternion|null} [parentQuat] mother world attitude (her attitude is computed fresh from it)
   * @returns {boolean} true if stowed
   */
  _stowHeldCatch(debris, parentQuat = null) {
    if (this.holdCellsFree <= 0) return false;
    const inHand = debris === this.capturedDebris;
    const herQ = this._herQuatWorldInto(parentQuat, _stowHerQ);
    // reel-home: the net reel already put the catch in its cell, fixed in her frame — it neither takes a fresh cell nor glides
    const inCell = inHand && this._rhArrived && debris._rackArm === this && Number.isInteger(debris._rackCell);
    const spinAxisW = debris.tumbleAxis ? _seatAxisW.copy(debris.tumbleAxis) : null;   // read before the cell rewrites it
    this._assignRackCellWith(debris, herQ, inHand && !inCell);   // the in-hand piece always takes a fresh cell
    if (inHand && !inCell) this._seatSpinBegin(debris, herQ, spinAxisW);   // the legacy reel's seat is the stow
    // The in-hand piece glides to its slot (`_pinHeldCatches`, over ARM_HOLD_GLIDE_S) instead of jumping; a cargo hand-off arrives on its own arc.
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
   * A saved BIG piece comes back onto THIS daughter's rack after a reload, as a mother catch does when the cargo hand-off
   * lands (`CaptureNet._updateCargoTransfer`): a cell on her, the piece held in her frame, state HOLDING_CATCH, the pin
   * written once. Refuses (false) unless she is docked with an empty rack and nothing in hand. Nothing is credited: the
   * piece is `_credited` already.
   * @param {object} debris the restored field body
   * @param {THREE.Vector3|null} [parentPos] the mother's world position @param {THREE.Quaternion|null} [parentQuat] her attitude
   * @returns {boolean} true if it is on the rack
   */
  restoreHeldCatch(debris, parentPos = null, parentQuat = null) {
    if (!debris || this.state !== S.DOCKED || this.capturedDebris || this.heldCatches.length > 0) return false;
    if (!this._stowHeldCatch(debris, parentQuat)) return false;
    debris._captured = true;
    debris._motherParked = false;
    debris._capturedByArm = this;
    this._breakdownStarted = false;
    this._breakdownChunksFired = 0;
    if (typeof this._transitionTo === 'function') this._transitionTo(S.HOLDING_CATCH);
    else this.state = S.HOLDING_CATCH;
    this._pinHeldCatches(parentPos, parentQuat);
    return true;
  }

  /**
   * Her WORLD attitude while parked, computed fresh: never read from `group.quaternion`, which PlayerSatellite writes AFTER
   * `armManager.update` (one frame stale in the pin). The mother's quaternion × the docked basis
   * `composeDockedArmQuat(strutDir, azRad)`, with the inputs PlayerSatellite itself uses (`strutGroups[i].strutDir` /
   * `.azRad`; `_updateStruts` runs BEFORE `armManager.update`, so strutDir is current when the pin runs). Without a player
   * (a bare rig) the strut direction is rebuilt from this daughter's own aim angle and dock azimuth, the same convention.
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
        ? degToRad(this._azimuthDeg)
        : Math.atan2(this.dockOffset.y, this.dockOffset.x);
      strutLocalDirection(this._aimAlpha || 0, az, _herDirTmp);
      composeDockedArmQuat(_herDirTmp, az, out);
    }
    if (this._carryAtt) out.copy(this._carryAtt);                  // a carry in flight turns her (ship frame); the rack pins follow
    const pq = parentQuat || (ps && ps.quaternion) || this._lastParentQuat;
    if (pq && typeof pq.x === 'number') out.premultiply(pq);
    return out;
  }

  /** Her +Z support, metres (box ∪ every solid mesh vertex), cached once her mesh exists. */
  herSupportZM() {
    const solid = this._solidPointsM();
    if (solid) {
      if (this._herSupportZ === undefined) this._herSupportZ = herSupportZM(this.config.bodyDims, solid);
      return this._herSupportZ;
    }
    return herSupportZM(this.config.bodyDims, null);
  }

  /**
   * Assign (or confirm) the rack cell of `d` on this daughter: the cell, its offset on her and the piece's attitude in her
   * frame. Idempotent while the assignment is valid (same daughter, cell not taken by another piece): the cargo flight calls
   * it every frame and only the first call computes. Overwrites otherwise.
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
      // A cell above 0 was laid out on top of the piece then in the cell below; valid only while that piece is still there
      // (if cell 0 emptied or another piece took it, the flight ends in the new place: re-read, not frozen).
      if (!taken && (d._rackCell < 1 || (d._rackBelow && rackPieceInCell(rack, d._rackCell - 1, d) === d._rackBelow))) {
        return d._rackCell;
      }
    }
    const cell = nextFreeRackCell(rack, d);
    d._armPinned = true;                       // the renderer draws a rack catch at the net-held floor: measure as it does
    seedHerFrameAttitude(d, herQ);             // d._qLocalHer = her⁻¹ × the attitude it is drawn at NOW
    if (!d._rackLocalM) d._rackLocalM = new THREE.Vector3();
    const below = cell >= 1 ? rackPieceInCell(rack, cell - 1, d) : null;
    if (this._seatEaseD === d) this._seatEaseClear();
    rackCellOffsetInto(d._rackLocalM, this.herSupportZM(), d, cell, d._qLocalHer, 0, below, this._seatGeo());
    d._rackCell = cell;
    d._rackArm = this;
    d._rackBelow = below;
    d._rackSlide = null;
    return cell;
  }

  /**
   * World position of ONE cargo-rack slot: her position + her attitude · the cell's stored offset (`heldSlotAnchorInto`),
   * the ONE computation the rack pin, the cargo flight's end, the keep-out sphere and the CoM booking all read. A piece with
   * no stored offset yet (a prediction by size, an old save) takes the typeless form for `slotIndex`.
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
   * Where a parked piece is DRAWN right now (scene units): its stored cell, except during the cell-1 → cell-0 slide, when it
   * is the slide's current point (the stored offset is already the END place). The keep-out spheres read this.
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
   * Her solid-mesh vertices (her frame, metres), collected once; the hold standoff measures against these and the bodyDims box.
   * @returns {Float32Array|null} null before the mesh exists
   */
  _solidPointsM() {
    if (!this.mesh) return null;
    if (!this._holdSolidPts) this._holdSolidPts = collectSolidPointsM(this.mesh);
    return this._holdSolidPts;
  }

  /**
   * Her solid triangles (ring included), her frame, metres: what the seat sweep measures against. Built once.
   * @returns {object|null} `buildSeatGeo` result, or null before the mesh exists
   */
  _seatGeo() {
    const g = this.mesh ? buildSeatGeo(this.mesh) : null;
    // The seat's mother check needs the arm (her ship, dock and index); not enumerable, so a piece that holds the seat in its memo still serialises
    if (g && g.owner !== this) Object.defineProperty(g, 'owner', { value: this, writable: true, configurable: true, enumerable: false });
    return g;
  }

  /** The seat ring's mass (aluminium, from its volume), kg. Logged only: NOT part of her live mass (`V5_WEAVER_MASS`). */
  get seatRingMassKg() {
    return this._seatRing ? this._seatRing.massKg : 0;
  }

  /**
   * Ease a freshly stowed piece from where it sat IN HAND to its cell over ARM_HOLD_GLIDE_S (smoothstep), in HER frame,
   * writing the centre (metres) into `out`. Timed by this daughter's own HOLDING_CATCH `stateTimer`. Her attitude on
   * the piece is frozen from the stow, so only the centre moves.
   *
   * The in-hand point can be on any side of her (even behind), so the direction from her to the piece swings from the
   * in-hand direction to her +Z while the centre rides the "support shell" `dir · catchHoldStandoffM(dir)` (never
   * nearer than the net gap along `dir`). On-axis cell: the swing takes the whole glide; off-axis: 60 %, then a slide.
   * @param {object} d the stowed piece (carries `_holdGlide`)
   * @param {THREE.Quaternion} herQ her world attitude (the piece's attitude is already herQ × qLocalHer)
   * @param {THREE.Vector3} out receives the centre, her frame, metres
   * @returns {boolean} false when the glide is over (it is cleared) — `out` is untouched
   */
  _glideHeldCatch(d, herQ, out) {
    const g = d._holdGlide;
    const dur = Constants.ARM_HOLD_GLIDE_S ?? 0;
    const f = this.state === S.HOLDING_CATCH ? this.stateTimer / dur : 0;
    if (!g || g.arm !== this || !(dur > 0) || !(f < 1) || !d._rackLocalM) { d._holdGlide = null; return false; }
    const s = smoothstep01(f);
    const cell = d._rackLocalM;
    // the swing ends on her +Z at the support rule's standoff `endStand`; a cell the exact seat put nearer than that is
    // reached by a slide in along +Z (end of this method), so the swing takes 70 % instead of all of it
    const endStand = catchHoldStandoffM(herQ, this.config.bodyDims, d, _gdEnd.set(0, 0, 1).applyQuaternion(herQ),
      Constants.ARM_HOLD_NET_GAP_M ?? 0.03, this._solidPointsM(), null);
    const onAxis = Math.abs(cell.x) < 1e-9 && Math.abs(cell.y) < 1e-9;
    const SWING = onAxis ? (endStand !== null && cell.z < endStand - 1e-4 ? 0.7 : 1) : 0.6;
    if (g.dir0 === null) { out.lerpVectors(g.fromM, cell, s); return true; }
    if (s < SWING) {
      const u = s / SWING;
      const c = clamp(g.dir0.z, -1, 1);
      if (c > 1 - 1e-9) _gdDir.set(0, 0, 1);
      else {
        _gdAxis.set(g.dir0.y, -g.dir0.x, 0);
        if (_gdAxis.lengthSq() < 1e-12) _gdAxis.set(1, 0, 0); // dead behind her: round her X
        else _gdAxis.normalize();
        _gdDir.copy(g.dir0).applyAxisAngle(_gdAxis, Math.acos(c) * u);
      }
      _gdWorld.copy(_gdDir).applyQuaternion(herQ);
      // support rule (a plain sum, no solve): the net gap holds at every instant by construction
      const standoff = catchHoldStandoffM(herQ, this.config.bodyDims, d, _gdWorld,
        Constants.ARM_HOLD_NET_GAP_M ?? 0.03, this._solidPointsM(), null);
      if (standoff === null) { out.lerpVectors(g.fromM, cell, s); return true; }
      out.copy(_gdDir).multiplyScalar(standoff);
      return true;
    }
    // The swing ended on her +Z at the support standoff; the piece now slides in along +Z to the cell, which
    // `rackCellOffsetInto` put at the exact seat (first contact of a +Z sweep, so every point farther out keeps the net
    // gap). No exact solve in the glide: blending the two answers along the swing cut a corner through her.
    const w = (s - SWING) / (1 - SWING);
    out.set(cell.x * w, 0, endStand !== null ? lerp(endStand, cell.z, w) : cell.z);
    return true;
  }

  /**
   * Pin every piece on the parked cargo rack at its cell: her position + her attitude · its stored offset
   * (`d._rackLocalM`, set on arrival). The drawn attitude is rewritten every frame from `herQ × d._qLocalHer` (nobody
   * else writes tumbleAxis / tumbleAngle once pinned), so turning the ship or swinging the strut carries the rack. An
   * unassigned piece (an old save, a rig that pushed onto `heldCatches`) is assigned here, keeping its attitude.
   * A freshly stowed piece glides in (`_glideHeldCatch`); a piece whose lower cell has emptied takes it and slides
   * there (`_slideHeldCatch`; the test is made HERE, every pin, so every leave site is covered). Her attitude is
   * `parentQuat`, else the player's, else the strut basis in the ship frame (`_herQuatWorldInto`).
   * @param {THREE.Vector3|null} [parentPos] unused (her position is `this.position`)
   * @param {THREE.Quaternion|null} [parentQuat] mother world attitude
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
   * The cell below `d`'s has emptied: move `d` down one cell and start its glide on her own clock (`_rackClockS`).
   * @param {object} d the piece (already assigned to this daughter, `_rackCell` >= 1)
   */
  _lowerRackCell(d) {
    // where it is drawn now (a slide under way continues from its current point; `d._rackLocalM` is still the old place)
    if (!(d._rackSlide && this._slideHeldCatch(d, _lrFrom))) _lrFrom.copy(d._rackLocalM);
    if (this._seatEaseD === d) this._seatEaseClear();
    const cell = d._rackCell - 1;
    const below = cell >= 1 ? rackPieceInCell(this.heldCatches, cell - 1, d) : null;
    rackCellOffsetInto(d._rackLocalM, this.herSupportZM(), d, cell, d._qLocalHer, 0, below, this._seatGeo());
    d._rackCell = cell;
    d._rackBelow = below;
    d._holdGlide = null;
    d._rackSlide = (Constants.ARM_HOLD_GLIDE_S ?? 0) > 0
      ? { arm: this, fromM: _lrFrom.clone(), t0: this._rackClockS || 0 }
      : null;
  }

  /**
   * Ease a piece that moved down a cell along her axis (her frame), smoothstep over ARM_HOLD_GLIDE_S, on `_rackClockS`
   * (`stateTimer` is reset by the unload and cannot time it). Target: the stored offset, read now.
   * @param {object} d
   * @param {THREE.Vector3} out receives the centre, her frame, metres
   * @returns {boolean} false when the slide is over (it is cleared) — `out` is untouched
   */
  _slideHeldCatch(d, out) {
    const sl = d._rackSlide;
    const dur = Constants.ARM_HOLD_GLIDE_S ?? 0;
    if (!sl || sl.arm !== this || !(dur > 0) || !d._rackLocalM) { d._rackSlide = null; return false; }
    const f = ((this._rackClockS || 0) - sl.t0) / dur;
    if (!(f < 1)) { d._rackSlide = null; return false; }
    const k = f <= 0 ? 0 : smoothstep01(f);
    out.lerpVectors(sl.fromM, d._rackLocalM, k);
    return true;
  }

  // CARRY (DECISIONS §29 row 1): while the trip burns, ArmManager.requestCarry sends a daughter with a catch to HER
  // radiator's tip furnace and home:
  //   CARRY_PREP     docked; the strut and the radiators move to the carry pose (the gate table's angles)
  //   CARRY_OUT      the 1.5 s clamp release, then the straight flight to the tip in her docked attitude (ship-relative)
  //   CARRY_HANDOFF  the catch leaves her rack for the tip (TipCargo.stow), a beat at the tip
  //   CARRY_BACK     the same line in reverse, wound by her strut reel (mother battery), no attitude change
  // then DOCKED / HOLDING_CATCH as her rack says. The manager hands a plan (js/test/fixtures/carry-gate.json).

  get isCarrying() {
    return this._carry != null;
  }

  /** 'nose' on the nose route (the mother's leash takes the catch on), 'radial' on any other carry, null when not carrying. */
  get carryKind() {
    return this._carry ? (this._carry.kind === 'nose' ? 'nose' : 'radial') : null;
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

  /** The % of her fuel the push costs: 2 × PAYOUT_MPS against the tank's Δv, mass-scaled. */
  carryFuelPct() {
    const armMass = this.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS;
    const massScale = Math.max(1, this.carryMassKg() / armMass);
    const v = (Constants.CARRY && Constants.CARRY.PAYOUT_MPS) || 0.2;
    return (2 * v / (this.config.totalDeltaV || Constants.ARM_TOTAL_DELTAV)) * 100 * massScale;
  }

  _carrySay(text, priority = 'info') {
    eventBus.emit(Events.COMMS_MESSAGE, { text, priority });
  }

  /**
   * Start a carry: take the tip slot and the strut (both reserved; the strut targets the carry angle), go to CARRY_PREP.
   * ArmManager.requestCarry has checked every precondition; this refuses (false, nothing taken) only what it cannot do
   * itself: not at home, a carry already, no tip store / petal hold. The prep is SEQUENCED (strut first, then ONLY HER
   * petal) because the gate certifies those two swings one after the other, not together.
   * @param {{tipIndex:number, cell:number, delivered:object, strutRad:number, thetaRad:number, recordedStrutRad:number,
   *   mission?:boolean}} plan  the delivered piece is the outermost on her rack
   * @returns {boolean}
   */
  beginCarry(plan) {
    if (this._carry || !plan || !plan.delivered) return false;
    if (this.state !== S.HOLDING_CATCH && this.state !== S.DOCKED) return false;
    if (this.heldCatches.indexOf(plan.delivered) < 0) return false;
    if (plan.kind === 'nose') return this._noseBegin(plan);
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


  /** Seat her at the ship-relative point `start + flight · smoothstep(u)` in her docked attitude, the rack riding with her. */
  _carrySeat(parentPos, parentQuat, u) {
    const c = this._carry;
    const s = smoothstep01(u);
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

  _carrySeatAttitude(parentPos, parentQuat) {
    this._lastParentQuat = parentQuat
      ? (this._lastParentQuatV || (this._lastParentQuatV = new THREE.Quaternion())).copy(parentQuat)
      : null;
    this._herQuatWorldInto(parentQuat, _carryQ);
    this.group.quaternion.copy(_carryQ);
    this._pinHeldCatches(parentPos, parentQuat);
  }

  /**
   * CARRY_PREP: docked while the strut and HER petal reach the carry pose one after the other (stages 'strut', 'petal');
   * after the flight they leave it in reverse ('unpetal', 'unstrut'). Before the flight the certified conditions are
   * rechecked each step (`ArmManager.carryConditions`): if they no longer hold she goes back and tries again later.
   */
  _updateCarryPrep(dt, parentPos, parentQuat) {
    const c = this._carry;
    if (!c) { this._transitionTo(this.heldCatches.length ? S.HOLDING_CATCH : S.DOCKED); return; }
    if (parentPos) {
      this._seatReady = false;
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
    const sTol = V.STRUT_ARRIVE_DEG * DEG2RAD;
    // the strut: its driver clears the target within 0.57° of it; the carry keeps the target alive until the strut has
    // landed within the certified tolerance (each frame's step is exact once the remainder is under one step)
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
      const cond = mgr && typeof mgr.carryConditions === 'function' ? mgr.carryConditions(this, c.kind === 'nose' ? c.nose : null) : null;
      if (cond) { this._carryBeginUnprep('conditions'); return; }
      if (c.kind === 'nose') {                              // the nose is still free and the leash still able (what the offer read), each step
        const why = mgr && typeof mgr.noseRecheck === 'function' ? mgr.noseRecheck(this) : null;
        if (why) { this._carryBeginUnprep('conditions'); return; }
      }
    }
    if (c.stage === 'strut' && c.kind === 'nose') {
      if (strutTo(c.strutRad)) this._noseBeginOut(parentPos, parentQuat); else limit();
      return;
    }
    if (c.stage === 'strut') {
      if (strutTo(c.strutRad)) {
        if (!ps || ps.holdPetalForHandoff(c.az, c.thetaRad) === null) { this.abortCarry('hold lost'); return; }
        c.stage = 'petal';
        c.prepS = 0;
      } else limit();
      return;
    }
    if (c.stage === 'petal') {
      if (!ps || typeof ps.isPetalHolding !== 'function' || !ps.isPetalHolding(c.az)) { this.abortCarry('hold lost'); return; }
      strutTo(c.strutRad);                                 // the strut must stay on its angle while the petal swings
      const thErr = Math.abs(ps.petalThetaRad(c.az) - c.thetaRad);
      if (thErr < V.THETA_ARRIVE_DEG * DEG2RAD && Math.abs(this.getAimAlpha() - c.strutRad) < sTol) {
        this._carryBeginOut(parentPos, parentQuat);
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
   * End the carry in reverse: her petal first (released: it swings back), then her strut back to the recorded angle.
   * `why`: 'home' (flight over) or 'conditions' (they stopped holding before the flight: she tries again later).
   */
  _carryBeginUnprep(why) {
    const c = this._carry;
    if (!c) return;
    const ps = this._playerSatellite;
    c.endWhy = why;
    c.prepS = 0;
    c.u = 0;
    this._carryAtt = null;
    if (c.kind === 'nose') {
      c.stage = 'unstrut';
      this._strutTargetAlpha = c.recordedStrutRad;
      if (this.state !== S.CARRY_PREP) this._transitionTo(S.CARRY_PREP);
      return;
    }
    if (ps && typeof ps.isPetalHolding === 'function' && ps.isPetalHolding(c.az)) ps.releasePetalHandoff(c.az);
    if (ps && typeof ps.isPetalHeld === 'function' && ps.isPetalHeld(c.az)) {
      c.stage = 'unpetal';
    } else {
      c.stage = 'unstrut';
      this._strutTargetAlpha = c.recordedStrutRad;
    }
    if (this.state !== S.CARRY_PREP) this._transitionTo(S.CARRY_PREP);
  }


  /** Plan the line from the dock to the tip's bag point (both ship-local, now), pay the push, go to CARRY_OUT. */
  _carryBeginOut(parentPos, parentQuat) {
    const c = this._carry;
    const V = Constants.CARRY;
    const ps = this._playerSatellite;
    const tc = ps && ps.tipCargo;
    const d = c.delivered;
    c.start.copy(this.dockOffset);                                   // docked: the strut tip, ship-local scene units
    this._herQuatWorldInto(_idQuat, _carryQ);
    heldSlotAnchorInto(c.start, _carryQ, d._rackLocalM, _carryC);    // the delivered piece's centre, ship-local
    const reach = DebrisField.trueReachM(d, 0);                      // the bag the tip will hold: the catch as drawn
    if (!tc || !tc.bagPointShipInto(c.tipIndex, reach, _carryF)) {
      this.abortCarry('no tip');
      return;
    }
    // she turns on the way so her body trails away from the radiator (the gate's final attitude, same functions)
    c.q0 = c.q0 || new THREE.Quaternion();
    c.q0.copy(_carryQ);
    c.q1 = null;
    if (Number.isInteger(c.dir) && tc.hingeQuatShipInto && tc.hingeQuatShipInto(c.tipIndex, _carryHq)) {
      _carryCL.copy(_carryC).sub(c.start).applyQuaternion(_carryQi.copy(c.q0).invert());
      _carryU0.copy(c.start).sub(_carryC).normalize();
      carryDirInto(_carryHq, c.dir, _carryD2);
      c.q1 = carryFinalQuatInto(c.q0, _carryU0, _carryD2, new THREE.Quaternion());
      _carryF.sub(_carryCL.applyQuaternion(c.q1));                                            // her centre when the catch is on the bag point
      c.flight.copy(_carryF).sub(c.start);
    } else {
      c.flight.copy(_carryF).sub(_carryC);
    }
    c.flightM = c.flight.length() / M;
    c.durationS = Math.max(0.5, c.flightM / (V.PAYOUT_MPS || 0.2));
    const pct = this.carryFuelPct();
    if (this.power.flat) {   // no power, no push: the thrusters that carry her are off
      this._carrySay(`Daughter ${this.index + 1}: ${batteryFlatLine()} Charging; her catch stays on her rack.`, 'warning');
      this.abortCarry('battery');
      return;
    }
    if (!(this.fuel >= pct)) {
      this._carrySay(`Daughter ${this.index + 1} has too little fuel to carry her catch; it stays on her rack.`, 'warning');
      this.abortCarry('fuel');
      return;
    }
    this.fuel -= pct;
    this.power.markEngine();
    c.fuelPct = pct;
    c.phase = 'clamp';
    c.clampS = 0;
    c.u = 0;
    this._transitionTo(S.CARRY_OUT);
    if (!c.mission) this._carrySay(`Daughter ${this.index + 1} carries her catch to radiator ${c.tipIndex + 1}'s furnace.`);   // a mission carry says its line at the end
    this._carrySeat(parentPos, parentQuat, 0);
  }

  _updateCarryOut(dt, parentPos, parentQuat) {
    const c = this._carry;
    if (!c) { this._transitionTo(this.heldCatches.length ? S.HOLDING_CATCH : S.DOCKED); return; }
    if (c.kind === 'nose') { this._noseUpdate(dt, parentPos, parentQuat); return; }
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
    if (c.u < 1) this._carryThreadStep(dt, parentPos, parentQuat);
    if (c.u >= 1) {
      c.phase = 'handoff';
      c.holdS = 0;
      this._transitionTo(S.CARRY_HANDOFF);
      this._carryStow();
    }
  }

  /**
   * The delivered catch leaves her rack (unloadHeldCatches' clearing, no NET_CONSUMED) and the tip takes it, arriving
   * along the line latch → catch centre, then turning onto the boom. A rack catch has no mother-net record, so none of
   * LeashDriver._latch's net steps. CARGO_TRANSFER_COMPLETE names no pod (podIndex -1: a real index would fade an
   * unrelated `pod_N` bag); `fromArmIndex` lets the net visual keep the bag drawn at the tip.
   * @returns {boolean} stowed (false: the catch stays on her rack and rides home)
   */
  _carryStow() {
    const c = this._carry;
    const d = c && c.delivered;
    if (!d) return false;
    return this._stowOnTip(d, c.tipIndex, { flown: true, carry: c });
  }

  /**
   * The trip hands the catch to the tip WITHOUT flying her (DECISIONS §38 row 6): the same end state as a flown radial
   * stow (`_stowOnTip`), bag seated on the boom at once, no carry record. Called by `ArmManager.deliverUnflown`, which
   * also bills her fuel.
   * @param {object} d the piece on her rack
   * @param {number} tipIndex a free, unreserved tip (the caller checked: `stow` itself does not look at reservations)
   * @returns {boolean} the tip took it (false: nothing changed)
   */
  stowUnflown(d, tipIndex) {
    if (this._carry || !d || this.heldCatches.indexOf(d) < 0) return false;
    return this._stowOnTip(d, tipIndex, { flown: false });
  }

  /**
   * The ONE rack-to-tip stow (flown radial carry and unflown hand-over both end here); a stow that refuses puts back
   * everything it touched. `flown`: the bag arrives along the line latch → the catch's centre, the carry's own words on
   * a refusal, no `unflown` mark on the event; unflown: no line, no words.
   * @param {object} d
   * @param {number} tipIndex
   * @param {{flown:boolean, carry?:object}} o `carry`: the flown carry's record, marked `handedOff` once the tip has the piece
   * @returns {boolean}
   */
  _stowOnTip(d, tipIndex, { flown, carry = null }) {
    const ps = this._playerSatellite;
    const tc = ps && ps.tipCargo;
    const idx = d ? this.heldCatches.indexOf(d) : -1;
    if (!tc || idx < 0) return false;
    const reach = DebrisField.trueReachM(d, 0);
    const free = !tc.debrisAt(tipIndex) && (flown || typeof tc.isReserved !== 'function' || !tc.isReserved(tipIndex));
    if (!tc.fits(reach) || !free || !tc.latchWorldInto(tipIndex, _carryV)) {
      if (flown) this._carrySay(`Daughter ${this.index + 1} could not seat her catch on radiator ${tipIndex + 1}; she brings it home.`, 'warning');
      return false;
    }
    // the line the bag arrives along: latch → the catch's centre now (world; the radiator frame turns with the ship)
    if (flown) {
      const pin = d._armPinPos || this.position;
      _carryDir.copy(pin).sub(_carryV);
    }
    // rack release, as ArmManager.unloadHeldCatches (the tip pays later). Cell and mother-net mark (`clearRackCell`) go
    // only once the tip has the piece; a refused stow restores them (cell, mark, owner) so it still gets its hand-off.
    const was = { by: d._capturedByArm, breakdown: d._breakdownActive, captured: this.capturedDebris === d };
    this.heldCatches.splice(idx, 1);
    d._armPinned = false;
    d._capturedByArm = null;
    d._breakdownActive = false;
    if (this.capturedDebris === d) this.capturedDebris = null;
    const ok = tc.stow(tipIndex, d, flown ? { massKg: d.mass || 0, radiusM: reach, fromDirWorld: _carryDir } : { massKg: d.mass || 0, radiusM: reach });
    if (!ok) {
      // cannot happen after the checks above; put the piece back on its rack rather than lose it
      this.heldCatches.splice(idx, 0, d);
      d._armPinned = true;
      d._capturedByArm = was.by;
      d._breakdownActive = was.breakdown;
      if (was.captured) this.capturedDebris = d;
      return false;
    }
    clearRackCell(d);
    tc.swingToBoom(tipIndex);
    if (carry) carry.handedOff = true;
    if (ps._attitudeInertia !== undefined) ps._attitudeInertia = null;
    eventBus.emit(Events.CARGO_TRANSFER_COMPLETE, {
      debrisId: d.id, massKg: d.mass || 0, podIndex: -1, armIndex: -1, armId: null,
      fromArmIndex: this.index, to: { kind: 'tip', tipIndex },
      ...(flown ? {} : { unflown: true }),
    });
    return true;
  }

  _updateCarryHandoff(dt, parentPos, parentQuat) {
    const c = this._carry;
    if (!c) { this._transitionTo(this.heldCatches.length ? S.HOLDING_CATCH : S.DOCKED); return; }
    if (c.kind === 'nose') { this._noseUpdate(dt, parentPos, parentQuat); return; }
    c.holdS += dt;
    this._carrySeat(parentPos, parentQuat, 1);
    if (c.holdS >= (Constants.CARRY.HANDOFF_S ?? 1)) {
      c.phase = 'back';
      this._transitionTo(S.CARRY_BACK);
    }
  }

  _updateCarryBack(dt, parentPos, parentQuat) {
    const c = this._carry;
    if (!c) { this._transitionTo(this.heldCatches.length ? S.HOLDING_CATCH : S.DOCKED); return; }
    if (c.kind === 'nose') { this._noseUpdate(dt, parentPos, parentQuat); return; }
    const u0 = c.u;
    c.u = Math.max(0, c.u - dt / c.durationS);
    this._carrySeat(parentPos, parentQuat, c.u);
    if (c.u < u0) this._carryThreadStep(dt, parentPos, parentQuat);
    // the strut reel cartridge bills the mother's battery the real mechanical power: line tension × line speed ÷ efficiency,
    // floored at its own motor while turning (as REELING bills). dt 0 (a held world) bills nothing.
    if (dt > 0 && c.u < u0) {
      const MD = Constants.MOTOR_DRAW_W || {};
      const rs = this._playerSatellite && this._playerSatellite._resourceSystem;
      if (rs && typeof rs.billWatts === 'function') {
        const speed = (c.flightM / c.durationS) * 6 * c.u * (1 - c.u) + 1e-6;   // m/s, smoothstep derivative
        const tension = this.carryMassKg() * speed * (Constants.REEL_TENSION_COEFF ?? 0.04);
        const mechW = tension * speed / (MD.REEL_EFFICIENCY || 0.5);
        rs.billWatts(Math.min(MD.REEL_MAX ?? 2500, Math.max(MD.STRUT_REEL_MIN ?? 15, mechW)), dt, 'strutReel');
      }
    }
    if (c.u <= 0) this._carryBeginUnprep('home');
  }

  // NOSE route: a catch longer than 0.5 m goes from her strut tip to the mother's nose collar, the nose adopts it, she
  // flies home body only and the leash takes it on to a free tip (archive/research/2026-10-nose-handoff.md;
  // Constants.CARRY.NOSE; js/entities/NoseRoute.js is the ONE route function, game and probe). Same states as the
  // direct carry: CARRY_PREP (strut 34° -> 145°; no petal), CARRY_OUT (clamp, legs in), CARRY_HANDOFF (beat at the seat,
  // checks, adopt, tug; a refused seat backs out and retries), CARRY_BACK (legs in reverse). `c.nose` holds the route.

  _noseCns() {
    const ps = this._playerSatellite;
    return (ps && ps._captureNetSystem) || captureNetSystem;
  }

  /** The % of her fuel the nose route costs: each leg starts and stops her; out with the catch (mass-scaled), back bare. */
  noseFuelPct() {
    const v = (Constants.CARRY && Constants.CARRY.PAYOUT_MPS) || 0.2;
    const body = (2 * v / (this.config.totalDeltaV || Constants.ARM_TOTAL_DELTAV)) * 100;
    const legs = 5;                                                  // dock, back-off, up, in, down (+ the extension for a smaller catch): the worst case
    return legs * (this.carryFuelPct() + body);
  }

  _noseBegin(plan) {
    const ps = this._playerSatellite;
    if (!ps || !plan.nose || !plan.nose.bucket) return false;
    this._carry = {
      kind: 'nose', nose: { bucket: plan.nose.bucket, reachM: plan.nose.reachM, route: null, mv: null, phase: 'clamp', tries: 0, waitS: 0, holdS: 0, s: 0, net: null, limbo: null, tugDone: false, refused: '' },
      tipIndex: -1, cell: plan.cell, delivered: plan.delivered, mission: plan.mission === true,
      az: null, strutRad: plan.strutRad, thetaRad: 0, recordedStrutRad: plan.recordedStrutRad,
      dir: null, q0: new THREE.Quaternion(), q1: null,
      home: this.state, phase: 'prep', stage: 'strut', endWhy: null,
      prepS: 0, clampS: 0, holdS: 0, u: 0, durationS: 1, flightM: 0, fuelPct: 0,
      handedOff: false, strutHeld: this._aimReserved === true,
      start: new THREE.Vector3(), flight: new THREE.Vector3(),
    };
    this._aimReserved = true;
    this._strutTargetAlpha = plan.strutRad;
    this._transitionTo(S.CARRY_PREP);
    return true;
  }

  /** her strut is at the carry angle: build the route from the live geometry (NoseRoute.js), pay the push, go to CARRY_OUT. */
  _noseBeginOut(parentPos, parentQuat) {
    const c = this._carry, n = c.nose, N = Constants.CARRY.NOSE;
    const ps = this._playerSatellite;
    const mgr = ps && ps.armManager;
    const d = c.delivered;
    if (!mgr || typeof mgr.noseSeatZ !== 'function' || typeof mgr.noseSeatZForReach !== 'function' || !d._rackLocalM) { this.abortCarry('no nose'); return; }
    this._herQuatWorldInto(_idQuat, _carryQ);
    const reach = mgr.carryReachOf(d), R = n.bucket.topM;
    const ext = Math.abs(R - reach) > 1e-6;
    const cReal = new THREE.Vector3().copy(d._rackLocalM);
    // plane the catch's nearest point stands a net gap off, read back from the cell actually laid out (her end can be
    // nearer than her support: ring and launcher face), so the virtual top-reach catch scales from where the real one sits
    const sNearM = catchSupportAlongM(d, d._qLocalHer || null, _rcZ);
    const h = Number.isFinite(sNearM) && d._qLocalHer
      ? cReal.z - sNearM
      : this.herSupportZM() + (Constants.ARM_HOLD_NET_GAP_M ?? 0.03);
    const cVirt = ext ? virtualCentreInto(cReal, h, reach, R, new THREE.Vector3()) : cReal;
    n.route = buildNoseRoute({
      q0: _carryQ.clone(), dockPos: new THREE.Vector3().copy(this.dockOffset).multiplyScalar(1 / M),
      cVirt, zSeatVirt: ext ? mgr.noseSeatZForReach(R) : mgr.noseSeatZ(d),
      cReal: ext ? cReal : null, zSeatReal: mgr.noseSeatZ(d),
      azDeg: Constants.THERMAL.FLOWER.AZIMUTHS_DEG[this.index],
      spec: { backoffM: N.BACKOFF_M, standoffM: N.STANDOFF_M, standoffMinZ: N.STANDOFF_MIN_Z_M, trailDeg: N.TRAIL_DEG },
    });
    c.flightM = n.route.len;
    const pct = this.noseFuelPct();
    if (this.power.flat) {   // no power, no push
      this._carrySay(`Daughter ${this.index + 1}: ${batteryFlatLine()} Charging; her catch stays on her rack.`, 'warning');
      this.abortCarry('battery');
      return;
    }
    if (!(this.fuel >= pct)) {
      this._carrySay(`Daughter ${this.index + 1} has too little fuel to carry her catch to the nose; it stays on her rack.`, 'warning');
      this.abortCarry('fuel');
      return;
    }
    this.fuel -= pct;
    this.power.markEngine();
    c.fuelPct = pct;
    c.phase = 'clamp';
    c.clampS = 0;
    n.phase = 'clamp';
    n.s = 0;
    n.leg = 0;
    this._transitionTo(S.CARRY_OUT);
    this._noseSeat(parentPos, parentQuat, 0);
  }

  /** Her pose on the route at arc length `s` (m): centre lerped, attitude slerped between the two waypoints (as the probe certified). */
  _noseSeat(parentPos, parentQuat, s) {
    const c = this._carry, r = c.nose.route;
    const L = r.len;
    s = clamp(s, 0, L);
    c.nose.s = s;
    let k = 0;
    while (k + 1 < r.seg.length && s > r.cum[k + 1] + 1e-12) k++;
    const f = r.seg[k] > 1e-12 ? clamp01((s - r.cum[k]) / r.seg[k]) : 1;
    c.nose.leg = k;
    _noseP.lerpVectors(r.pos[k], r.pos[k + 1], f);
    const att = this._carryAtt || (this._carryAtt = new THREE.Quaternion());
    att.copy(r.quat[k]).slerp(r.quat[k + 1], f);
    _carryLocal.copy(_noseP).multiplyScalar(M);
    if (parentQuat) _carryLocal.applyQuaternion(parentQuat);
    if (parentPos) this.position.copy(parentPos).add(_carryLocal);
    this.velocity.set(0, 0, 0);
    this._carrySeatAttitude(parentPos, parentQuat);
  }

  /** start a move along the route to arc length `toS`: smooth start and stop over |distance| / PAYOUT_MPS (at least 0.5 s). */
  _noseMoveTo(toS) {
    const n = this._carry.nose;
    const v = (Constants.CARRY && Constants.CARRY.PAYOUT_MPS) || 0.2;
    n.mv = { from: n.s, to: toS, t: 0, dur: Math.max(0.5, Math.abs(toS - n.s) / v) };
  }

  _noseStep(dt, parentPos, parentQuat, thread = true) {
    const c = this._carry, n = c.nose, m = n.mv;
    if (!m) return true;
    const t0 = m.t;
    m.t = Math.min(m.dur, m.t + dt);
    const u = m.t / m.dur, e = smoothstep01(u);
    this._noseSeat(parentPos, parentQuat, lerp(m.from, m.to, e));
    if (thread && m.t > t0) this._carryThreadStep(dt, parentPos, parentQuat);
    if (m.t >= m.dur) { n.mv = null; return true; }
    return false;
  }

  _noseBillReel(dt) {
    const c = this._carry, m = c.nose.mv;
    if (!(dt > 0) || !m) return;
    const MD = Constants.MOTOR_DRAW_W || {};
    const rs = this._playerSatellite && this._playerSatellite._resourceSystem;
    if (!rs || typeof rs.billWatts !== 'function') return;
    const u = m.t / m.dur;
    const speed = (Math.abs(m.to - m.from) / m.dur) * 6 * u * (1 - u) + 1e-6;
    const tension = this.carryMassKg() * speed * (Constants.REEL_TENSION_COEFF ?? 0.04);
    const mechW = tension * speed / (MD.REEL_EFFICIENCY || 0.5);
    rs.billWatts(Math.min(MD.REEL_MAX ?? 2500, Math.max(MD.STRUT_REEL_MIN ?? 15, mechW)), dt, 'strutReel');
  }

  /** the delivered catch's centre in the SHIP frame (metres), from her pose now: her centre + the rack centre turned by her attitude. */
  _noseCatchShipInto(out) {
    const c = this._carry, d = c.delivered;
    const r = c.nose.route, k = c.nose.leg;
    const s = c.nose.s, f = r.seg[k] > 1e-12 ? clamp01((s - r.cum[k]) / r.seg[k]) : 1;
    _noseP.lerpVectors(r.pos[k], r.pos[k + 1], f);
    _noseQ.copy(r.quat[k]).slerp(r.quat[k + 1], f);
    return out.copy(d._rackLocalM).applyQuaternion(_noseQ).add(_noseP);
  }

  /**
   * Nose route phases (CARRY_OUT / CARRY_HANDOFF / CARRY_BACK): clamp, out (leg by leg), seat (beat, checks, adopt),
   * tug, back. A refused seat: retreat 0.4 m, wait, again (3 tries, then home holding it).
   */
  _noseUpdate(dt, parentPos, parentQuat) {
    const c = this._carry, n = c.nose, N = Constants.CARRY.NOSE, V = Constants.CARRY;
    const r = n.route;
    if (!r) { this.abortCarry('no route'); return; }
    const L = r.len;
    if (n.phase === 'clamp') {
      c.clampS += dt;
      this._carryThread = null;
      this._noseSeat(parentPos, parentQuat, 0);
      if (c.clampS >= V.CLAMP_S) { n.phase = 'out'; n.leg = 0; this._noseMoveTo(r.cum[1]); }
      return;
    }
    if (n.phase === 'out') {
      if (this._noseStep(dt, parentPos, parentQuat)) {
        const k = r.cum.findIndex((x) => Math.abs(x - n.s) < 1e-9);
        if (k >= 0 && k + 1 < r.pos.length) this._noseMoveTo(r.cum[k + 1]);
        else this._noseArrive();
      }
      return;
    }
    if (n.phase === 'again') {
      if (this._noseStep(dt, parentPos, parentQuat)) this._noseArrive();
      return;
    }
    if (n.phase === 'seat') {
      n.holdS += dt;
      this._noseSeat(parentPos, parentQuat, L);
      if (n.holdS < (N.SEAT_BEAT_S ?? 1)) return;
      const refused = this._noseSeatChecks();
      if (refused) { this._noseRefused(refused); return; }
      const d = c.delivered;
      const pre = { motherParked: d._motherParked, renderMin: d._catchRenderMin };      // what the net's hold writes on the catch: a rollback puts it back
      const net = this._noseCns().adoptDaughterCatch(d);
      if (!net) { this._noseRefused('The nose could not take the catch'); return; }
      // the nose has it; the rack record goes only when the tug has passed: the piece leaves `heldCatches` now (one
      // writer of its pin), `limbo` keeps what a rollback needs
      const idx = this.heldCatches.indexOf(d);
      n.limbo = {
        idx, by: d._capturedByArm, breakdown: d._breakdownActive, captured: this.capturedDebris === d,
        motherParked: pre.motherParked, renderMin: pre.renderMin,
      };
      if (idx >= 0) this.heldCatches.splice(idx, 1);
      d._capturedByArm = null;
      d._breakdownActive = false;
      if (this.capturedDebris === d) this.capturedDebris = null;
      n.net = net;
      n.phase = 'tug';
      this._noseMoveTo(Math.max(0, L - N.TUG_M));
      return;
    }
    if (n.phase === 'tug') {
      const arrived = this._noseStep(dt, parentPos, parentQuat, false);
      const d = c.delivered, net = n.net;
      const ps = this._playerSatellite;
      let held = !!net && net.isActive && (net.state === 'COLLARED' || net.state === 'BERTHED');
      if (held && d._scenePosition && ps && ps.position && ps.quaternion) {
        // the net pinned the catch at the end of last frame against last frame's ship pose (player.update has moved the
        // ship since: km a frame at the game clock): read it against that pose (CaptureNet.lastPinFrame; null = not held).
        // It must stay within TUG_HOLD_M of its seat while she backs.
        const fr = typeof net.lastPinFrame === 'function' ? net.lastPinFrame() : { pos: ps.position, quat: ps.quaternion };
        if (!fr) held = false;
        else {
          _noseC.copy(d._scenePosition).sub(fr.pos).applyQuaternion(_noseQ.copy(fr.quat).invert()).multiplyScalar(1 / M);
          held = Math.hypot(_noseC.x, _noseC.y, _noseC.z - this._noseSeatZ) <= N.TUG_HOLD_M;
        }
      }
      if (!held) { this._noseRollback(); this._noseRefused('The nose did not hold the catch'); return; }
      if (arrived) {
        n.tugDone = true;
        clearRackCell(d);
        n.limbo = null;
        c.handedOff = true;
        const ps2 = this._playerSatellite;
        if (ps2 && ps2._attitudeInertia !== undefined) ps2._attitudeInertia = null;
        n.phase = 'back';
        c.phase = 'back';
        this._transitionTo(S.CARRY_BACK);
        this._noseBackNext();
      }
      return;
    }
    if (n.phase === 'retreat') {
      if (this._noseStep(dt, parentPos, parentQuat)) { n.phase = 'wait'; n.waitS = 0; }
      return;
    }
    if (n.phase === 'wait') {
      n.waitS += dt;
      this._noseSeat(parentPos, parentQuat, n.s);
      if (n.waitS >= (N.RETRY_WAIT_S ?? 2)) { n.phase = 'again'; this._transitionTo(S.CARRY_OUT); this._noseMoveTo(L); }
      return;
    }
    if (n.phase === 'back') {
      const moving = n.mv;
      if (this._noseStep(dt, parentPos, parentQuat)) {
        if (n.s <= 1e-9) { c.u = 0; this._carryBeginUnprep(c.endWhy || 'home'); return; }
        this._noseBackNext();
      } else if (moving) this._noseBillReel(dt);
      return;
    }
  }

  _noseArrive() {
    const c = this._carry, n = c.nose;
    n.phase = 'seat';
    n.holdS = 0;
    c.phase = 'handoff';
    this._transitionTo(S.CARRY_HANDOFF);
    this._noseSeatZ = this._playerSatellite.armManager.noseSeatZ(c.delivered);
  }

  _noseBackNext() {
    const c = this._carry, r = c.nose.route, s = c.nose.s;
    let k = r.cum.length - 1;
    while (k > 0 && r.cum[k] >= s - 1e-9) k--;
    this._noseMoveTo(r.cum[k]);
  }

  /** Checks before the nose adopts: nose free, catch at the seat (inside the leash latch funnel) and at rest; '' = fine, else the reason. */
  _noseSeatChecks() {
    const c = this._carry, N = Constants.CARRY.NOSE, d = c.delivered;
    const cns = this._noseCns();
    if (cns && ((typeof cns.getDockedCatch === 'function' && cns.getDockedCatch()) || (typeof cns.hasMotherNetInFlight === 'function' && cns.hasMotherNetInFlight()))) return 'The nose is busy';
    this._noseCatchShipInto(_noseC);
    const err = Math.hypot(_noseC.x, _noseC.y, _noseC.z - this._noseSeatZ);
    if (!(err <= N.SEAT_TOL_M)) return `The catch is ${(err * 100).toFixed(1)} cm off the seat`;
    if (this.velocity.length() / M > N.SEAT_SPEED_MPS) return 'She is not at rest';
    if (!d || d.alive === false) return 'The catch is gone';
    return '';
  }

  _noseRefused(why) {
    const c = this._carry, n = c.nose, N = Constants.CARRY.NOSE;
    n.tries++;
    n.refused = why;
    if (n.tries >= N.TRIES) {
      this._carrySay(`Daughter ${this.index + 1} could not seat her catch at the nose after ${N.TRIES} tries (${why.toLowerCase()}); she brings it home.`, 'warning');
      c.endWhy = 'no seat';
      n.phase = 'back';
      c.phase = 'back';
      this._transitionTo(S.CARRY_BACK);
      this._noseBackNext();
      return;
    }
    n.phase = 'retreat';
    this._transitionTo(S.CARRY_OUT);
    this._noseMoveTo(Math.max(0, n.route.len - N.RETRY_BACKOFF_M));
  }

  /** Take the hand-over back (nose did not hold, or the carry aborted mid-tug): the net goes, the catch is on her rack as it was. */
  _noseRollback() {
    const c = this._carry, n = c && c.nose;
    if (!n || !n.limbo) return;
    const d = c.delivered, lb = n.limbo;
    if (n.net) this._noseCns().cancelDaughterAdoption(n.net);
    n.net = null;
    if (this.heldCatches.indexOf(d) < 0) this.heldCatches.splice(Math.min(Math.max(lb.idx, 0), this.heldCatches.length), 0, d);
    d._armPinned = true;
    d._captured = true;
    d._motherParked = lb.motherParked;
    d._catchRenderMin = lb.renderMin;
    d._capturedByArm = lb.by;
    d._breakdownActive = lb.breakdown;
    if (lb.captured) this.capturedDebris = d;
    n.limbo = null;
    // the net's last pin (end of last frame, last frame's ship pose) is still in `_armPinPos`, and ArmManager pins the
    // rack from it right after the arms: re-pin now, or the restored catch sits at that stale spot (km off at game clock).
    const ps = this._playerSatellite;
    if (ps && ps.position) this._pinHeldCatches(ps.position, ps.quaternion || null);
  }

  /** The nose carry is ending (home or abort): a hand-over still in the tug is taken back; a finished one lets the leash retry at once. */
  _noseFinish(c, why) {
    const n = c.nose;
    if (!n) return;
    if (n.limbo) { this._carry = c; this._noseRollback(); this._carry = null; }
    if (c.handedOff && n.net) this._noseCns().releaseNoseRetry(n.net);
  }

  /**
   * End the carry: clear the tip reservation, send the strut target back to the recorded angle (reservation released;
   * StrutAuto acts only on DOCKED daughters), release her petal if still held, then DOCKED / HOLDING_CATCH as her rack
   * says. The normal end comes here AFTER the sequenced unprep, so those steps do nothing; `abortCarry` arrives with
   * both still out and restores them at once. `why` 'home' on a mission with a catch left on a tip says so.
   */
  _carryFinish(why) {
    const c = this._carry;
    if (!c) return;
    this._carry = null;
    this._carryThread = null;
    this._carryAtt = null;
    if (why === 'prep timeout' || why === 'hold lost' || why === 'no tip' || why === 'fuel' || why === 'no seat') this._carryGaveUp = true;
    if (c.kind === 'nose') this._noseFinish(c, why);
    const ps = this._playerSatellite;
    const tc = ps && ps.tipCargo;
    if (tc && typeof tc.unreserve === 'function') tc.unreserve(c.tipIndex);
    this._strutTargetAlpha = c.recordedStrutRad;
    if (!c.strutHeld) this._aimReserved = false;
    if (c.kind !== 'nose' && ps && typeof ps.isPetalHolding === 'function' && ps.isPetalHolding(c.az)) ps.releasePetalHandoff(c.az);
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
      this._carrySay(c.kind === 'nose'
        ? `Daughter ${this.index + 1} has put her catch on the nose; she is free again.`
        : `Daughter ${this.index + 1} puts her catch on radiator ${c.tipIndex + 1}'s tip; she is free again.`);
    }
  }


  /**
   * Stop a carry now (game over, reset, load, the trip's hard cap, a lost radiator hold): she snaps docked, catches on
   * her rack stay there, strut and radiators are restored, the tip reservation is cleared. A catch already on the tip stays.
   * @param {string} why
   * @param {{quiet?:boolean}} [opts]
   * @returns {boolean} true when a carry was running
   */
  abortCarry(why, opts = {}) {
    if (!this._carry) return false;
    this._carryFinish(why || 'abort');
    return true;
  }

  // REEL-HOME (FEATURE_FLAGS.REEL_HOME; DECISIONS §29 rows 2-3): her net winds the catch in to her nose, then the strut
  // line winds her home TAIL FIRST onto the strut tip, catch leading away; the strut swings and the mother turns
  // (ArmManager `_updateReelHome`) to meet her line.

  _rhOn() {
    return !this.isDetached && Constants.isFeatureEnabled('REEL_HOME');
  }

  /** The catch she holds is NET-held: only a net has a line to wind. */
  _rhNetCatch() {
    return !!this.capturedDebris && (!this._captureToolKind || this._captureToolKind === 'NET');
  }

  /** She is on the reels (net reel or strut reel). ArmManager gives the mother turn to a daughter that is. */
  get isReelingHome() {
    return this._rhHome === true;
  }

  _rhEnd() {
    this._rhHome = false;
    this._rhPinned = false;
    this._rhNetDone = false;
    this._rhArrived = false;
    this._rhSeatNear = false;
    this._rhHoldS = 0;
    this._rhLineUp = null;
    this._rhNoPath = false;
    this._rhNoPathS = 0;
    this._rhLineUpSaid = false;
    this._rhWaitSaid = false;
    this._rhMotherWorking = false;
    this._rhPlaneErrRad = 0;
    this._rhHold = null;
    this._rhFloorRefused = false;
    this._rhFloorSpent = false;
    if (this._rhReserved) {
      this._aimReserved = false;
      this._rhReserved = false;
    }
  }

  _rhNet() {
    const net = this._firedNet
      || (captureNetSystem.getActiveNetForArm ? captureNetSystem.getActiveNetForArm(this.index) : null);
    return net && net._heldByArm ? net : null;
  }

  /**
   * She does not jump onto the catch: the first GRAPPLED frame records the separation at net close; from then on the
   * catch is pinned at her position + that separation (one rigid pair while the net settles).
   * @param {THREE.Vector3|null} tPos the catch's scene position now (first frame only)
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

  _rhBeginNetReel() {
    this._rhHome = true;
    this._rhArrived = false;
    this._rhSeatNear = false;
    this._rhTurnTries = 0;
    this._rhTurnWaitS = 0;
    this._rhHoldS = 0;
  }

  /**
   * One frame of the net reel. The line shortens at REEL_HOME.NET_REEL_MPS until the catch sits at the rack cell it
   * will take (`rackCellOffsetInto`: on her +Z axis, a net gap past her nose end), the pair's centre of mass staying
   * put (they close in inverse ratio to their masses, `_computeReelMUnit`). She turns her nose to the catch (attitude
   * block in `update`); the catch's attitude stays frozen. The catch comes onto her axis only once her nose is within
   * REEL_HOME.ARRIVE_TOL_DEG of the line, then is assigned its cell (`_assignRackCellWith`) and fixed in her frame.
   * @param {number} dt seconds
   * @returns {boolean} true when the catch is in its cell
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
    // far from the cell the support rule sets it (a plain sum, no solve); once the line is within SEAT_REEL_NEAR_M of
    // that cell the exact seat takes over (sticky for this reel: the cell then only ever moves in, so it cannot flip
    // back). The first exact solve is at arrival time; `seatStandoffM` re-solves only for a turn of more than 5 degrees.
    rackCellOffsetInto(this._rhCellM, this.herSupportZM(), d, cell, d._qLocalHer, 0, below, null);
    if (!this._rhSeatNear && sep.length() - this._rhCellM.length() * M <= (Constants.SEAT_REEL_NEAR_M ?? 0.2) * M) this._rhSeatNear = true;
    const deferred0 = seatSolveStats.deferred;
    if (this._rhSeatNear) {
      _seatDeferFirst = true;                  // the first solve waits for a frame with no other solve (asked again next frame)
      try { rackCellOffsetInto(this._rhCellM, this.herSupportZM(), d, cell, d._qLocalHer, 0, below, this._seatGeo()); }
      finally { _seatDeferFirst = false; }
    }
    const seatDeferred = seatSolveStats.deferred !== deferred0;
    const cellW = _rhV1.copy(this._rhCellM).multiplyScalar(M).applyQuaternion(herQ);   // her centre -> cell, world
    const cLen = cellW.length();
    const r = sep.length();

    // Wind: r goes to the cell distance at the line speed (a catch nearer than its cell pays out the same way)
    const step = (RH.NET_REEL_MPS ?? 0.5) * M * dt;
    const dr = clamp(cLen - r, -step, step);
    const arrivedLen = Math.abs(cLen - r) <= step + 1e-12;
    let arrive = false;
    if (arrivedLen && r > 1e-12 && cLen > 1e-12 && !seatDeferred) {   // (a deferred first solve: she is not seated until the exact cell is known)
      // the line is at its length: only a catch on her axis comes in (her nose is turning to it, at the normal rate)
      const cosAng = sep.dot(cellW) / (r * cLen);
      const tol = Math.cos(degToRad(RH.ARRIVE_TOL_DEG ?? 0.5));
      arrive = cosAng >= tol;
    }
    if (r <= 1e-12) arrive = true;

    const armMass = this.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS;
    const mCatch = Math.max(0, this._computeReelMUnit(armMass, true) - armMass);
    const herShare = mCatch / Math.max(1e-9, armMass + mCatch);
    if (arrive) {
      const toCell = clamp(cLen - r, -step, step);
      if (r > 1e-12) this.position.addScaledVector(_rhV2.copy(sep).multiplyScalar(1 / r), -toCell * herShare);
      sep.copy(cellW);
      const spinAxisW = d.tumbleAxis ? _seatAxisW.copy(d.tumbleAxis) : null;   // before the cell's attitude rewrites it
      this._assignRackCellWith(d, herQ, true);
      this._rhArrived = true;
      this._rhPinInCell();
      this._seatSpinBegin(d, herQ, spinAxisW);          // seated: her gas cancels the spin it carried
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
   * drawn taut, straight, muzzle -> the bag's NECK, so the shortening line never bows slack.
   * @param {THREE.Vector3} catchPos the catch centre, scene units
   * @param {THREE.Vector3} [sepW] her centre -> catch, world (else catchPos - position)
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
      // the bag's neck as it will be DRAWN (not the net's previous-tick position): keeps the line exactly taut as she turns
      const d = net.catchResult === 'success' ? net.targetDebris : null;
      // the catch as it will be drawn this frame is `catchPos`, the pin just written. ArmManager.update ends with the
      // authoritative pin (DebrisField.pinCapturedDebris, before the net system and the visual run), so `d._scenePosition`
      // read HERE is last frame's: 0.078 m off the drawn neck at the reel-heading flip (measured, test-ReelHomeLook).
      const sp = d ? catchPos : null;
      if (sp && net.launchDirection) {
        // the neck is where CaptureNetVisual draws it (heldBagShape.js: on the tow line from her muzzle, touching the
        // catch's rear, the apex ball's radius clear), from this frame's pin and muzzle
        heldBagNeckInto(_rhV5, sp, _rhV4, net.launchDirection, heldBagRadiusScene(d), DAUGHTER_STAND_M);
        net.tetherPaidOut = Math.hypot(_rhV4.x - _rhV5.x, _rhV4.y - _rhV5.y, _rhV4.z - _rhV5.z) / M;
      } else {
        net.tetherPaidOut = Math.hypot(_rhV4.x / M - net.position.x, _rhV4.y / M - net.position.y,
          _rhV4.z / M - net.position.z);
      }
    }
  }

  /**
   * The catch in its cell, fixed in HER frame: her actual attitude × the stored offset and attitude. One pin for the
   * net reel's end, REELING and DOCKING (HOLDING_CATCH's `_pinHeldCatches` reads the same offsets).
   * @returns {boolean} false when the catch holds no assignment on her
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

  /** The mother-frame azimuth of her strut, rad (the same one PlayerSatellite and ArmManager use). */
  _rhAzRad() {
    const sg = this._playerSatellite && this._playerSatellite.strutGroups && this.index != null
      ? this._playerSatellite.strutGroups[this.index] : null;
    if (sg && Number.isFinite(sg.azRad)) return sg.azRad;
    if (Number.isFinite(this._azimuthDeg)) return degToRad(this._azimuthDeg);
    return Math.atan2(this.dockOffset.y, this.dockOffset.x);
  }

  /** Her strut's axis, world, unit, root -> tip — as PlayerSatellite has it now, else rebuilt from her aim angle. */
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
   * The strut axis at the angle the strut is HEADING for: the swing-plane angle nearest the direction hinge -> her
   * (`_rhBestAlpha`) clamped to REEL_HOME.STRUT_MIN_DEG..STRUT_MAX_DEG (never below 34°). The line-up aims at THIS axis,
   * so it does not chase a strut still slewing nor ask for a direction it can never take. Falls back to the live axis.
   */
  _rhTargetDirWorldInto(parentQuat, out) {
    if (!Number.isFinite(this._rhBestAlpha)) return this._rhStrutDirWorldInto(parentQuat, out);
    const RH = Constants.REEL_HOME || {};
    const a = clamp(this._rhBestAlpha, (RH.STRUT_MIN_DEG ?? 34) * DEG2RAD, (RH.STRUT_MAX_DEG ?? 180) * DEG2RAD);
    strutLocalDirection(a, this._rhAzRad(), out);
    const ps = this._playerSatellite;
    const pq = parentQuat || (ps && ps.quaternion) || this._lastParentQuat;
    if (pq && typeof pq.x === 'number') out.applyQuaternion(pq);
    return out.normalize();
  }

  /**
   * From the strut hinge (the collar point PlayerSatellite hangs it on): the swing-plane angle nearest the direction
   * hinge -> her (`_rhBestAlpha`, unclamped; ArmManager clamps it) and her signed offset from the strut's swing plane
   * (`_rhPlaneErrRad`). Runs every frame while she is on the reels.
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
    this._rhPlaneErrRad = Math.asin(clamp(tSide, -1, 1));
    this._rhBestAlpha = bestStrutAlpha(rel, az);
    if (!this._rhRelShip) this._rhRelShip = new THREE.Vector3();
    this._rhRelShip.copy(rel);                 // hinge -> her, ship-local, unit (ArmManager's turn axis and angle)
    return true;
  }

  /**
   * Her attitude on the strut reel: −Z toward the strut tip (her +Z and the catch lead away), roll so her +Y is the
   * docked basis's +Y for this strut. Near the tip the line direction is ill-conditioned, so the aim blends to the
   * strut axis (the docked +Z) over the last 0.75 m.
   * @param {THREE.Vector3} toTip her -> strut tip, scene units (not normalised)
   * @param {number} dist its length
   * @param {THREE.Quaternion|null} parentQuat
   * @param {THREE.Quaternion} out
   * @returns {boolean} false when there is no aim yet
   */
  _rhTailFirstQuatInto(toTip, dist, parentQuat, out) {
    const z = _rhV1;
    this._rhStrutDirWorldInto(parentQuat, _rhV2);
    if (dist > 1e-9) z.copy(toTip).multiplyScalar(-1 / dist); else z.copy(_rhV2);
    const distM = dist / M;
    const w = clamp01((distM - 0.25) / 0.5);
    const ws = smoothstep01(w);
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
   * Start the line-up on her own thrusters: along the circle round the strut tip, into line with the strut axis the
   * strut is heading for (`_rhTargetDirWorldInto`). Billed as normal fuel: an impulse in and out at ALIGN_SPEED_MPS
   * against the tank's Δv, scaled by the mass she moves (her + catch + net). She may spend ARM_RESERVE_FUEL (kept for a
   * safe reel-home; a docked daughter holding a catch does not go ADRIFT on it: `_consumeFuel`). Returns false, billing
   * nothing, when she cannot afford it or the arc is not clear of the ship; she then holds for the mother and retries a
   * second later, with one comms line per reel.
   */
  _rhBeginLineUp(dockW, dist, parentPos, parentQuat) {
    const RH = Constants.REEL_HOME || {};
    const v = RH.ALIGN_SPEED_MPS ?? 0.5;
    const armMass = this.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS;
    const massScale = Math.max(1, this._computeReelMUnit(armMass, !!this.capturedDebris) / armMass);
    const dvPct = (2 * v / (this.config.totalDeltaV || Constants.ARM_TOTAL_DELTAV)) * 100 * massScale;
    if (!(this.fuel >= dvPct) || this._powerOff() || !this._rhArcClear(dockW, dist, parentPos, parentQuat)) {
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
    this.power.markEngine();
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
   * The great-circle arc from her place to the target strut axis (circle of radius R about the strut tip) is clear of
   * the ship: every 4° keeps ALIGN_CLEAR_M (no clearance hook = clear). Checked before the line-up bills anything.
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
    const n = Math.max(1, Math.ceil(ang / (degToRad(4))));
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
   * strut is heading for (`_rhTargetDirWorldInto`), at ALIGN_SPEED_MPS. Greedy from the live tip and target, so a
   * swinging strut or turning mother is followed. A blocked step (ship nearer than ALIGN_CLEAR_M) stops her: she holds
   * and retries after a second.
   * @returns {boolean} true while the line-up is still moving
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
    if (ang <= 1e-4 || ang <= degToRad(0.5 * (RH.ALIGN_TOL_DEG ?? 10)) * 0.2) {
      this._rhLineUp = null;
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
   * Net-integrity check as reel-in begins (GRAPPLED → REELING). Both failures are RECOVERABLE (she keeps her tether and
   * returns to reload while the debris drifts free, re-capturable):
   *   • OVERSIZE (deterministic): debris wider than the net mouth.
   *   • STRAIN (probabilistic): a heavy catch near the net's rated mass slips the weave, scaling with payload / rating.
   * @returns {boolean} true if the net failed (caller must NOT enter REELING)
   */
  _checkNetIntegrityOnReel() {
    const debris = this.capturedDebris;
    if (!debris) return false;
    // NET catches only: a magnetic/gripper/pad grip has no net mouth (an EPM grab of a large ferrous body would
    // false-fail).
    if (this._captureToolKind && this._captureToolKind !== 'NET') return false;
    const payloadMass = debris.mass || 0;
    const rated = this._netRatedMass || 0;
    // ASPECT_CAPTURE: judge the width the net wrapped at contact (presented width), not the max extent: an end-on
    // catch of a long body is legitimate.
    const aspectOn = Constants.isFeatureEnabled('ASPECT_CAPTURE');
    const debrisSize = (aspectOn && this._catchPresentedWidthM != null)
      ? this._catchPresentedWidthM
      : (debris.sizeMeter || 0);
    const netDia = this._netDiameter || 0;

    // Hard fail: debris wider than the net mouth can't be cinched. The ONE mouth-fit predicate (`fitsMouth`) decides: the
    // bare-number diameter rides the netClass seam, the contact-time width the precomputed seam (NaN never refuses).
    const oversized = !fitsMouth(debris, { DIAMETER: this._netDiameter }, null, debrisSize);

    // Probabilistic fail: the ONE strain-band helper ramps it; the CAP stays here (a one-shot roll vs NET_STRAIN_FAIL_PROB_MAX).
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

    if (!oversized && !strainFail) return false;

    this._releaseCapturedDebris({ keepPinned: false });
    eventBus.emit(Events.NET_FAILED, {
      armId: this.id, armIndex: this.index,
      debrisId: debris.id, strain, oversized, recoverable: true,
    });
    const reason = oversized
      ? `Net failed. Debris too wide for the net (${debrisSize.toFixed(1)}m vs ${netDia.toFixed(1)}m mouth). Returning to reload; a larger net is needed.`
      // name the CAUSE so the slip is legible: the catch was deep in the 80-100% strain band, not bad luck.
      : `Net failed. Debris slipped free and is drifting (catch was ${Math.round(strain * 100)}% of the net's rated mass. Slips become likely above ${Math.round((Constants.NET_STRAIN_SAFE_FRACTION ?? 0.8) * 100)}%). Returning to reload; re-net to retry.`;
    // REEL_HOME keeps the cause and says the outcome itself (reeled home / held for a retry)
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
   * The net RIPS under boost-reel load: recoverable (mirror of the reel-start strain slip); debris drifts free.
   * @param {number} strain payload / rated mass at the moment of the rip
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
    // the tear's staging hook: CaptureNetVisual zeroes a wedge of spokes in the bag's colour buffer (a hole the catch drifts out of)
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
   * Catastrophic tether snap during reel-in: the cable parts. The net stays intact between daughter and debris, so they
   * drift off TOGETHER (debris stays pinned to the now-EXPENDED daughter; it does NOT vanish) and a recoil impulse
   * springs the pair clear. The catch is lost (she can't return), but the debris stays re-targetable for another daughter.
   */
  _snapTether(parentPos) {
    const sep = (Constants.CAPTURE_RELEASE_SEPARATION_MPS || 1.2) * M;
    if (parentPos) {
      const away = this._tmpVec.subVectors(this.position, parentPos);
      if (away.lengthSq() > 1e-20) {
        away.normalize();
        this.velocity.addScaledVector(away, sep);
      }
    }
    // the catch stays attached (net intact) so it drifts with her: coherent, visible, never silently removed
    const debris = this._releaseCapturedDebris({ keepPinned: true });
    this._tetherSevered = true;
    this._severedCatch = debris;       // bounded pin — released after a drift delay
    this._severedDriftS = 0;
    this.isDetached = true;
    if (this.tetherLine) this.tetherLine.visible = false;
    eventBus.emit(Events.TETHER_SNAP, {
      armIndex: this.index, armId: this.id, cause: 'overload',
      debrisId: debris && debris.id, recoverable: false,
    });
    this._transitionTo(S.EXPENDED);
  }


  /** HAULING: tow debris back toward parent (slow). Legacy state; V5 uses REELING (zero-fuel motor reel-in). */
  _updateHauling(dt, parentPos, parentQuat) {
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

    // captured debris is an InstancedMesh handled by DebrisField (marked not-alive after capture): no mesh to move

    this.tetherLength = this.position.distanceTo(parentPos) / M;

    const dockThreshold = this.config.bodyDims[2] * M * 8;
    if (dist < dockThreshold) {
      this._transitionTo(S.DOCKING);
      this._seatBegin(parentPos, parentQuat);
      eventBus.emit(Events.ARM_RETURNED, {
        armId: this.id, captured: true, debrisId: this.capturedDebris?.id,
      });
    }
  }

  /**
   * Resolve the strut-tip dock world position into `out` (single source of truth for every distance / heading /
   * plume-clearance computation). Rotates+offsets only when BOTH a parent quaternion and a dockOffset are present;
   * otherwise the dock is the mother centre (`parentPos`), as `_updateReeling` does.
   * @param {THREE.Vector3} parentPos mother world position
   * @param {THREE.Quaternion} [parentQuat] mother world orientation
   * @param {THREE.Vector3} out destination vector (written in place)
   * @returns {THREE.Vector3} `out`
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
   * Combined retrieval-unit mass m_unit = m_daughter + m_net + m_debris (kg): the one source for reel tension/throttle.
   * @param {number} armMass daughter dry mass (kg)
   * @param {boolean} hasPayload whether a catch is held
   * @returns {number} kg
   */
  _computeReelMUnit(armMass, hasPayload) {
    let m = armMass;
    if (hasPayload && this.capturedDebris) m += (this.capturedDebris.mass || 0);
    // only NET catches carry a net; magnetic/gripper/pad grips don't
    if (hasPayload && (!this._captureToolKind || this._captureToolKind === 'NET')) {
      const nc = getNetClassForType(this.type);
      if (nc && typeof nc.MASS === 'number') m += nc.MASS;
    }
    return m;
  }

  /**
   * Trapezoidal reel-in speed (m/s, game-scale) at a given remaining distance: power-bounded cruise, ramping DOWN to
   * V_DOCK within DECEL_DISTANCE_M.
   *
   * Cruise solves the implicit power throttle v = P / T_reel with T_reel = m_unit·v·coeff ⇒ v_cruise = √(P / (m_unit·coeff)),
   * clamped to [V_DOCK, V_CRUISE_MAX]. Being power-bounded, the tension T = P/v ≥ P/V_CRUISE_MAX stays under the tether
   * break strength for any in-spec catch (the snap invariant); only Boost, which multiplies the speed AFTER the throttle,
   * can push past it. Boost is locked out inside DECEL_DISTANCE_M (BOOST_LOCKOUT_IN_DECEL) so the player can't slam the dock.
   * @param {number} distMeters remaining distance to the strut dock (m)
   * @param {number} armMass daughter dry mass (kg)
   * @param {boolean} hasPayload whether a catch is held
   * @param {number} boostMult REEL_BOOST speed multiplier (1 when not boosting)
   * @returns {number} reel speed in m/s
   */
  _computeReelProfileSpeed(distMeters, armMass, hasPayload, boostMult) {
    const P = Constants.REEL_PROFILE || {};
    const vDock = P.V_DOCK ?? 1.0;
    const decelDist = P.DECEL_DISTANCE_M ?? 15;
    const vCruise = this._reelCruiseCap(armMass, hasPayload);

    // Ramp DOWN to V_DOCK under a constant-deceleration (ACCEL) bound: v = √(V_DOCK² + 2·ACCEL·dist), clamped to the
    // cruise cap: far from the dock it exceeds vCruise (so we cruise) and tapers continuously to V_DOCK at contact.
    // DECEL_DISTANCE_M is kept as the boost-lockout window. The ramp-UP from launch is implicit (she starts at rest).
    const accel = P.ACCEL ?? 3.4;
    const vDecel = Math.sqrt(vDock * vDock + 2 * accel * Math.max(0, distMeters));
    let speed = Math.min(vCruise, vDecel);

    const lockBoost = (P.BOOST_LOCKOUT_IN_DECEL !== false) && distMeters <= decelDist;
    if (boostMult > 1 && !lockBoost) speed *= boostMult;

    return speed;
  }

  /**
   * The cruise cap of the reel (m/s, game-scale): the power-bounded, snap-safe speed a unit of this mass may haul at,
   * floored at V_DOCK. Stateless; the legacy profile and `_rhReelStep` both start from it.
   */
  _reelCruiseCap(armMass, hasPayload) {
    const P = Constants.REEL_PROFILE || {};
    const vCruiseMax = P.V_CRUISE_MAX ?? 60;
    const vDock = P.V_DOCK ?? 1.0;
    const power = P.HAUL_MOTOR_POWER ?? 2500;
    const tMin = P.T_MIN ?? 5;
    const coeff = Constants.REEL_TENSION_COEFF ?? 0.04;
    const mUnit = this._computeReelMUnit(armMass, hasPayload);

    // Power-bounded cruise (closed form of v = P/(m·v·coeff)). The T_MIN floor caps a near-massless unit (≤ V_CRUISE_MAX);
    // the V_DOCK floor prevents a 0-speed stall for a very heavy catch.
    const vFromMin = power / Math.max(tMin, 1e-6);
    const vFromPower = Math.sqrt(power / Math.max(mUnit * coeff, 1e-6));
    let vCruise = Math.min(vCruiseMax, vFromMin, vFromPower);

    // SNAP INVARIANT: cruise tension T = m_unit·v·coeff never exceeds break×CRUISE_TENSION_FRACTION (a heavy in-spec
    // catch is throttled to a slower, safe cruise); only Boost, applied AFTER this throttle, may push past break.
    const tensionFrac = P.CRUISE_TENSION_FRACTION ?? 0.85;
    const breakN = this.tetherBreakStrength || 0;
    if (breakN > 0) {
      const vTension = (breakN * tensionFrac) / Math.max(mUnit * coeff, 1e-6);
      vCruise = Math.min(vCruise, vTension);
    }
    return Math.max(vDock, vCruise);
  }

  // REEL-GAS (DECISIONS §34): the reel-home haul as a sim: pull-up, cruise, and a braking phase on her own cold-gas
  // jet, with her ion thruster keeping the line tight the whole way. Game-scale units in code (m/s per REAL s); true
  // units (x 1/10 speed, x 1/100 acceleration) only where mass, thrust and gas are involved.

  _coldGasBottleKg() {
    const B = Constants.DAUGHTER_COLD_GAS && Constants.DAUGHTER_COLD_GAS.BOTTLE_KG;
    return (B && B[this.config.type]) || 0;
  }

  _coldGasThrustN() {
    const T = Constants.DAUGHTER_COLD_GAS && Constants.DAUGHTER_COLD_GAS.THRUST_N;
    return (T && T[this.config.type]) || 0;
  }

  _ionThrustN() {
    const IT = Constants.ION_THRUSTER || {};
    return (this.config.type === 'weaver' ? IT.WEAVER_MAX_THRUST : IT.SPINNER_MAX_THRUST) || 0;
  }

  /**
   * The FEEP the ion thread burns this frame, billed at its real thrust: the Δv it gives her (thrust / mass x game
   * seconds) against the tank's total Δv, as a percentage. Tiny (about 0.00002 % a frame) but billed, so a long haul is
   * not free. dt 0 (a held world) bills nothing.
   */
  _billIonThread(dt, massKg) {
    if (!(dt > 0) || !(this.fuel > 0) || this._powerOff()) return;   // a flat pack: no thread, the winch alone pulls her
    const aTrue = this._ionThrustN() / Math.max(massKg, 1e-6);                       // m/s^2
    const dvTrue = aTrue * dt * TimeAuthority.BASE_SCALE;                             // m/s per game time of this frame
    const pct = dvTrue / (this.config.totalDeltaV || Constants.ARM_TOTAL_DELTAV) * 100;
    this.fuel = Math.max(0, this.fuel - pct);
    this.power.markEngine();
  }

  /**
   * Where the reel must stop her (DECISIONS §35 row 8): the metres she may still close before the hold point (HOLD_M
   * out from her strut tip) while `armManager.reelHoldReason(her)` gives a reason, else Infinity. A hold STARTS only when
   * she is farther out than HOLD_M and can stop there (decided in `_rhReelStep` on its braking law, else
   * `_rhHold.refused`); it ends the frame the reason does, or after FLOOR_CAP_S for a floor hold (`capped`, one line).
   * One comms line per hold. State: `_rhHold`, cleared with the reel (`_transitionTo(REELING)`, `_rhEnd`, ArmManager reset).
   * @param {number} dt
   * @param {number} distM metres to her strut tip
   * @returns {number} metres she may still close (>= 0), or Infinity
   */
  _rhHoldStep(dt, distM) {
    const R = Constants.REEL_HOLD || {};
    const holdM = R.HOLD_M ?? 5;
    const ps = this._playerSatellite;
    const am = ps && ps.armManager;
    let h = this._rhHold;
    if (!(dt > 0)) return h && h.on ? Math.max(0, distM - holdM) : Infinity;      // a held world changes nothing
    // a floor hold that ended (capped / she could not stop) stays spent while her floor reason lasts, so the radiator
    // reason can take over; it is cleared the frame the floor reason itself is gone (the next one starts clean)
    if (this._rhFloorSpent && !(am && typeof am._rhFloorWanted === 'function' && am._rhFloorWanted(this))) this._rhFloorSpent = false;
    const reason = (am && typeof am.reelHoldReason === 'function') ? am.reelHoldReason(this) : null;
    if (reason === null) { this._rhHold = null; return Infinity; }
    if (!h || h.reason !== reason) h = this._rhHold = { reason, on: false, refused: false, capped: false, heldS: 0, said: false };
    if (h.capped || h.refused) { if (reason === 'floor') this._rhFloorSpent = true; return Infinity; }
    const gateM = distM - holdM;
    if (!h.on && gateM <= 0) { h.refused = true; return Infinity; }              // the reason began inside HOLD_M: she comes on
    if (h.on) {
      // the timer, the cap and the lines run only while she RESTS at the hold point (she brakes in from 20-100 m out for
      // several seconds first: counting those would say "waits 5 m out" at 21 m and could spend the cap before she arrives)
      const rested = gateM <= (R.SLACK_M ?? 0.25) + (R.REST_TOL_M ?? 0.1) && !(this._rhReelV >= 0.01);
      if (rested) {
        h.heldS += dt;
        if (reason === 'floor' && h.heldS > (R.FLOOR_CAP_S ?? 30)) {
          h.capped = true;
          h.on = false;
          this._rhFloorSpent = true;
          eventBus.emit(Events.COMMS_MESSAGE, { text: `Daughter ${this.index + 1} stops waiting for the mother's turn and comes in.`, priority: 'info' });
          return Infinity;
        }
        if (!h.said && (reason === 'radiators' || h.heldS >= (R.FLOOR_LINE_S ?? 3))) {
          h.said = true;
          eventBus.emit(Events.COMMS_MESSAGE, {
            text: reason === 'floor' ? `Daughter ${this.index + 1} waits ${holdM} m out until the mother has turned.`
              : `Daughter ${this.index + 1} waits ${holdM} m out while the radiators move.`,
            priority: 'info',
          });
        }
      }
    }
    return Math.max(0, gateM);
  }

  /**
   * The reel-home speed for this frame (game-scale m/s); REEL_HOME only (DECISIONS §34 rows 2-4).
   *
   *  a. PULL-UP: the reel speeds her up at REEL_PROFILE.PULL_ACCEL from `_rhReelV` (0 on entering REELING). No jump.
   *  b. CRUISE: at the cruise cap (`_reelCruiseCap`, boost included) or the speed her bottle can still pay to brake from
   *     (v_gas), whichever is lower.
   *  c. BRAKING: from her stopping distance at a_brake = min(ACCEL, jet accel / MARGIN) down to V_DOCK at the dock. The
   *     cold-gas jet fires toward the mother and the gas is billed MARGIN x (the reel line holds the rest). The distance
   *     used is the one left AFTER this frame's step, so the last frame arrives at V_DOCK, not above it.
   *  No gas: no jet; the only brake is her ion thruster (v <= sqrt(V_DOCK^2 + 2 a_ion d), about V_DOCK all the way) and
   *  one line says so once per reel.
   * Sets `_rhBraking`, `_rhReelPhase`, `_rhTensionN` (true N, the line readout) and `_rhReelMassKg`. dt 0 changes nothing.
   * @param {number} dt real seconds
   * @param {number} distM metres left to the strut tip
   * @param {number} gateM metres she may still close this frame (the line-up gate; Infinity = none)
   * @param {number} [holdGateM] metres to the hold point (`_rhHoldStep`); Infinity = none. Unlike the line-up gate it
   *   brakes her to REST there on the same braking law (no free stops, DECISIONS §37 row 8): the hold STARTS only if
   *   she can stop in time at the law's own deceleration, else `_rhHold.refused`.
   * @returns {number} the speed to reel at this frame
   */
  _rhReelStep(dt, distM, gateM, armMass, hasPayload, boostMult, holdGateM = Infinity) {
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
    const hasGas = gas > G.EMPTY_KG && !this._powerOff();   // a flat pack: the valves have no power, so the ion limit alone brakes her
    if (!this._rhGasChecked) {
      this._rhGasChecked = true;
      if (!(gas > G.EMPTY_KG)) {
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
    const dEff = clamp(gateM, 0, distM);
    const aJet = this._coldGasThrustN() / mass * 100;                      // game-scale m/s^2 (true accel x 100)
    const aBrake = Math.min(P.ACCEL ?? 3.4, aJet / G.MARGIN);
    // the hold point, if one holds her. It starts only where she can stop at the law's own deceleration (her speed is not
    // above the braking curve to it); once on, every braking speed below also brakes to REST at it (`brakeTo`).
    let dHold = Infinity;
    const hs = holdGateM < Infinity ? this._rhHold : null;
    if (hs && !hs.refused) {
      // she brakes to rest SLACK_M short of the hold point: the tip can move toward her while she stops (the mother is turning),
      // and a stop that would land past the point is a free stop (forbidden); the move clamp in `_updateReeling` guards the point itself
      const dBrake = Math.max(0, holdGateM - ((Constants.REEL_HOLD || {}).SLACK_M ?? 0.25));
      if (!hs.on) {
        const aNom = hasGas ? aBrake : this._ionThrustN() / mass * 100;
        // already AT the point (within slack + tolerance: a hold that was capped or ended as another began, and she crept
        // on a frame): all of the distance is hers to stop in, else any crawl would refuse her
        const R = Constants.REEL_HOLD || {};
        const dStart = holdGateM <= (R.SLACK_M ?? 0.25) + (R.REST_TOL_M ?? 0.1) ? holdGateM : dBrake;
        const vIn = -aNom * dt + Math.sqrt(aNom * aNom * dt * dt + 2 * aNom * dStart);
        if (v0 <= vIn + 1e-6) hs.on = true; else hs.refused = true;
      }
      if (hs.on) dHold = dBrake;
    }
    // the speed from which a constant decel `a` just reaches V_DOCK after this frame's step (exact for the Euler step); with a
    // hold, also the one that just reaches REST at the hold point: the lower of the two
    const brakeTo = (a) => {
      const toDock = -a * dt + Math.sqrt(a * a * dt * dt + vDock * vDock + 2 * a * dEff);
      if (dHold === Infinity) return toDock;
      return Math.min(toDock, Math.max(0, -a * dt + Math.sqrt(a * a * dt * dt + 2 * a * dHold)));
    };

    // a little gas must never be slower than none. The jet speed (what the bottle can pay to brake from, at the jet's
    // a_brake) is only used where it beats the ion limit; the jet fires (puffs + gas bill) only while she must brake
    // harder than her ion thruster can, otherwise the ion thread is the brake. Empty bottle = ion limit.
    const aIon = this._ionThrustN() / mass * 100;
    const vIon = brakeTo(aIon);
    let vDes, aSlow, jet = false;
    if (hasGas) {
      // the highest speed whose braking to V_DOCK the bottle can still pay for: MARGIN x mass x dv_true / (Isp g0)
      const vGas = vDock + gas * G.ISP_S * Constants.G0 * BS / (G.MARGIN * mass);
      const vJet = Math.min(vGas, brakeTo(aBrake));
      jet = (vJet > vIon || dHold !== Infinity) && vCap > vIon;   // the last crawl to rest at the hold point is the jet's too (the ion thread alone would coast on)
      vDes = Math.min(vCap, Math.max(vJet, vIon));
      aSlow = jet ? aJet : aIon;
    } else {
      vDes = Math.min(vCap, vIon);
      aSlow = aIon;
    }

    // two daughters leaving the barrier together pull with ONE tension, the lighter catch's (T = m_light x PULL_ACCEL /
    // 100): the heavier one accelerates by m_light / m_heavy of PULL_ACCEL, so unequal catches' pull-up kicks still cancel.
    // Once the lighter one is at cruise the heavier keeps its lower acceleration until it too is (an accepted residual).
    let pullAccel = P.PULL_ACCEL ?? 10;
    const pp = this._pairPartner;
    if (pp && this._pairTogether && pp._pairTogether && pp.state === S.REELING && (Constants.PAIR_SHOT || {}).HOME_EQUAL_PULL === true) {
      const mp = pp._computeReelMUnit((pp.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS) + pp.coldGasKg, !!pp.capturedDebris);
      if (mp > 0 && mass > mp) pullAccel *= mp / mass;
    }
    let v;
    if (vDes >= v0) v = Math.min(vDes, v0 + pullAccel * dt);
    else v = Math.max(vDes, v0 - aSlow * dt);
    const dv = v - v0;

    let phase = 'cruise';
    if (dv > 1e-9) phase = 'pull';
    else if (dv < -1e-9 && jet) {
      phase = 'brake';
      this._rhBraking = true;
      // MARGIN x the gas braking needs: mass x speed lost (true m/s) / (Isp g0)
      const kg = Math.min(gas, G.MARGIN * mass * (-dv / BS) / (G.ISP_S * Constants.G0));
      this.coldGasKg = gas - kg;
      if (kg > 0) this.power.markGas();
    }
    this._rhReelPhase = phase;
    // the line readout (true N): pull-up = mass x pull accel; cruise = the ion thread; braking = the (MARGIN - 1) the reel holds
    if (phase === 'pull') this._rhTensionN = mass * pullAccel / 100;
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
    // the mother's tank is POOL units (20 = 6 kg): she gives coldGasKgToPool(want), the bottle gains that many kg.
    // While a cold-gas turn of hers spins, the gas to stop it is not for the bottles (no line: she is not out of gas).
    let wantPool = coldGasKgToPool(want);
    if (typeof ps._nonTurnPoolBudget === 'function') {
      const budget = ps._nonTurnPoolBudget(wantPool);
      if (budget <= 0 && wantPool > 0 && (rs.coldGas || 0) > 0) return;
      wantPool = budget;
    }
    const got = coldGasPoolToKg(rs.drawUpTo('coldGas', wantPool));
    if (got > 0) {
      const next = this.coldGasKg + got;
      this.coldGasKg = (full - next < 1e-12) ? full : next;           // full is full (no float residue)
      ps._daughterGasEmptySaid = false;
    } else if (!ps._daughterGasEmptySaid) {
      ps._daughterGasEmptySaid = true;
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'The mother is out of cold gas; daughters cannot refill their braking gas.', priority: 'warning',
      });
    }
  }

  /**
   * @private DECISIONS §4 "Docked servicing": the mother's indium store -> her ion-fuel tank while she sits on her strut
   * (DOCKED, HOLDING_CATCH, RELOADING), as a cast-cartridge SWAP of SWAP_GAME_S game seconds (the cold-gas refill's time
   * base). Runs while her fuel is below 100 % and the store holds indium; at its end the old cartridge's leftover joins
   * the store and a fresh cartridge of min(tank, store + leftover) goes in, so a swap never ends with less fuel.
   * Leaving the docked states first interrupts it: nothing moved. One daughter swaps at a time (`ps._indiumSwapArm`; a
   * stale holder is ignored). Store empty with a daughter below 100 %: one line, said once, re-armed when the store has
   * indium again. Fuel above 100 % (armFuelMax upgrade) is not below 100: no swap, nothing taken.
   */
  _updateIndiumSwap(dt) {
    if (!(dt > 0)) return;
    const st = this.state;
    if (st !== S.DOCKED && st !== S.HOLDING_CATCH && st !== S.RELOADING) { this._indiumSwapT = -1; return; }
    const ps = this._playerSatellite;
    const rs = ps && ps._resourceSystem;
    if (!rs || !Number.isFinite(rs.indiumStoreKg)) { this._indiumSwapT = -1; return; }
    if (!(this.fuel < 100 - 1e-6)) { this._indiumSwapT = -1; return; }
    if (!(rs.indiumStoreKg > 1e-9)) {
      this._indiumSwapT = -1;
      if (!ps._daughterIndiumEmptySaid) {
        ps._daughterIndiumEmptySaid = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `The ion-fuel store is empty; daughters cannot refill their ion fuel. Buy a cartridge at the ${placeName()}.`, priority: 'info',
        });
      }
      return;
    }
    ps._daughterIndiumEmptySaid = false;
    const holder = ps._indiumSwapArm;
    if (holder && holder !== this && holder._indiumSwapT >= 0) { this._indiumSwapT = -1; return; }   // another daughter has the mechanism
    ps._indiumSwapArm = this;
    if (this._indiumSwapT < 0) this._indiumSwapT = 0;
    this._indiumSwapT += dt * TimeAuthority.BASE_SCALE;
    if (this._indiumSwapT < Constants.DAUGHTER_SUPPLY.SWAP_GAME_S) return;

    // the swap ends: the leftover and the store make one pool; a cartridge of min(tank, pool) goes in, the rest stays in the store
    const tankKg = this.type === 'weaver' ? Constants.INDIUM_FULL_TANK_WEAVER : Constants.INDIUM_FULL_TANK_SPINNER;
    const leftoverKg = Math.max(0, this.fuel) / 100 * tankKg;
    const poolKg = rs.indiumStoreKg + leftoverKg;
    const cartKg = Math.min(tankKg, poolKg);
    const before = this.fuel;
    rs.setIndiumStore(poolKg - cartKg);                     // never more than the store held, so never past its max
    this.fuel = cartKg >= tankKg - 1e-12 ? 100 : (cartKg / tankKg) * 100;
    this._indiumSwapT = -1;
    ps._indiumSwapArm = null;
    eventBus.emit(Events.ARM_REFUELED, { armId: this.id, amount: this.fuel - before });
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `${this.displayName}: new ion-fuel cartridge in. Fuel ${Math.round(this.fuel)}%.`, priority: 'good',
    });
  }

  /**
   * @private One look-puff of her cold-gas jet (visual only): from the tail port (-Z, facing the mother on the tail-first
   * reel), outward, from the shared 4-sprite pool, every GAS_STREAM_INTERVAL_S of simulated time while the jet brakes (a
   * steady stream, never a cloud).
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
        const dot = -_thrZ.set(0, 0, 1).applyQuaternion(this.group.quaternion).dot(toTip);
        if (dot > 0.1) this._carryThread = 'aft';
        else if (dot < -0.1) this._carryThread = 'fore';
        else if (!this._carryThread) this._carryThread = dot >= 0 ? 'aft' : 'fore';
      }
    }
    if (!this._carryThread) this._carryThread = 'aft';
    this._billIonThread(dt, this.carryMassKg());
  }

  /**
   * reel-push (DECISIONS §35 row 6): the line tension (`_rhTensionN`, true N) pulls the mother toward the daughter at her
   * strut tip, equal and opposite to the daughter's pull (Newton's third law): Δv in her real orbit, a torque about her
   * centre of mass. The gas jet pushes only the daughter (its plume on the mother's hull is not modelled), so while she
   * brakes the mother feels just the line's share.
   * Called from the REAL reel update (`_updateReeling`), never from `_rhReelStep`: `_reelHomeEtaS` steps that to estimate
   * the time left, and an estimate must not move the real mother.
   * Units: the reel runs on REAL dt with game-scale speeds; the game clock runs TIME_SCALE_GAMEPLAY x faster, so the line
   * acts for dt x BASE_SCALE game seconds: J = T x dt_game (true N·s), Δv = J / her live mass (as the mother-net tug).
   * @param {number} dt real seconds
   * @param {THREE.Vector3} tipWorld the strut-tip dock, world (scene units)
   * @private
   */
  _reelPushLine(dt, tipWorld) {
    const ps = this._playerSatellite;
    if (!(dt > 0) || this.isDetached || !ps || typeof ps.applyForceAtPoint !== 'function') return;
    const T = this._rhTensionN;
    if (!(T > 0)) return;
    const f = (this._pushForce || (this._pushForce = new THREE.Vector3())).subVectors(this.position, tipWorld);   // tip -> her
    const dist = f.length();
    if (!(dist > 1e-7)) return;
    f.multiplyScalar(T / dist);
    const res = ps.applyForceAtPoint(f, tipWorld, dt * TimeAuthority.BASE_SCALE, this._pushOpts || (this._pushOpts = { source: this }));
    if (res === false) this._reelPushRefused();
  }

  /**
   * reel-push: the daughter arrives at the strut tip with `reelSpeedGame` (game-scale m/s) and stops: her momentum goes into the
   * mother, J = m x v (true N·s; v = reelSpeed / BASE_SCALE, 0.10 m/s true at V_DOCK), along her approach, at the tip. The strut
   * is rigid here (its give is not modelled). Flushes whatever the line left gathered.
   * @private
   */
  _reelPushLatch(tipWorld, reelSpeedGame) {
    const ps = this._playerSatellite;
    if (this.isDetached || !ps || typeof ps.applyImpulseAtPoint !== 'function') return;
    const m = this._rhReelMassKg;
    const v = reelSpeedGame / TimeAuthority.BASE_SCALE;
    const j = (this._pushJ || (this._pushJ = new THREE.Vector3())).subVectors(tipWorld, this.position);   // her -> the tip: her approach
    const d = j.length();
    if ((m > 0) && (v > 0) && (d > 1e-9)) j.multiplyScalar(m * v / d);
    else j.set(0, 0, 0);                                           // nothing arrives; the call still flushes the gathered Δv
    const res = ps.applyImpulseAtPoint(j, tipWorld, this._pushOptsLatch || (this._pushOptsLatch = { source: this, flushLinear: true }));
    if (res === false) this._reelPushRefused();
  }

  /**
   * @private reel-push: the first real frame of a reel (`_rhGasChecked` still false): no refusal line said yet, and
   * whatever an earlier reel of HERS left gathered goes into the orbit first (not another daughter's: it keeps her own).
   */
  _reelPushBegin() {
    this._rhPushWarned = false;
    const ps = this._playerSatellite;
    if (ps && typeof ps.flushReelPush === 'function') ps.flushReelPush(this);
  }

  /** @private reel-push: the mother's Δv was refused (the altitude envelope guard): said once per reel, like the net tug. */
  _reelPushRefused() {
    if (this._rhPushWarned) return;
    this._rhPushWarned = true;
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: 'Reel pull damped: it would take the mother out of the safe altitude band.', priority: 'info',
    });
  }

  /**
   * REELING: strut-reel motor reel-in; the haul itself burns no propellant (legacy path: no FEEP at all). Under REEL_HOME
   * (DECISIONS §34) it is a sim: `_rhReelStep` pulls her up, cruises and brakes her on her cold-gas jet, while her ion
   * thread (a tiny, billed FEEP cost) keeps the line tight. The reel target is the strut-tip dock world position she
   * launched from (matches _updateDocking), NOT the mother's bus centre.
   * @private
   */
  _updateReeling(dt, parentPos, parentQuat) {
    const hasPayload = this.capturedDebris !== null;
    // The jet only fires on frames the REEL_HOME sim runs and says so (`_rhReelStep` sets it again); a frame that takes
    // another path (detached, flag turned off mid-reel) must not leave the last braking flag, and its puffs, on.
    this._rhBraking = false;

    // A catch destroyed/removed mid-haul must not strand the FSM on a stale "loaded" profile: convert to an empty
    // return (mirrors the HOLDING_CATCH→RELOADING fallback). A genuinely empty reel (reelFromStationKeep) is unaffected.
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

    // Hold Shift → BOOST reel ×2. Tension ∝ reelSpeed² (mult applies to speed and the tension formula), so boosting a
    // heavy catch walks the bar toward RIP/SNAP.
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

    // Strut-tip dock world position: parentPos + parentQuat × dockOffset; falls back to parentPos (mother centre) if
    // quaternion or dockOffset is absent (test harness with minimal mocks).
    const dockWorldPos = this._tmpDockTarget || (this._tmpDockTarget = new THREE.Vector3());
    this._resolveStrutDockWorld(parentPos, parentQuat, dockWorldPos);

    const toMother = this._tmpVec.subVectors(dockWorldPos, this.position);
    const dist = toMother.length();

    // Reel speed: REEL_PROFILE_V2 = trapezoidal velocity profile (power-bounded cruise ramping DOWN to a gentle dock
    // speed within DECEL_DISTANCE_M); legacy = constant REEL_IN_SPEED_* × boost.
    const profileV2 = Constants.isFeatureEnabled('REEL_PROFILE_V2');
    const armMass = this.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS;
    let reelSpeed;
    if (profileV2) {
      const distMeters = dist / M;
      reelSpeed = this._computeReelProfileSpeed(distMeters, armMass, hasPayload, boostMult);
    } else {      reelSpeed = (hasPayload ? REEL_IN_SPEED_LOADED : REEL_IN_SPEED_EMPTY) * boostMult;
    }
    let reelSpeedScaled = reelSpeed * M;

    // reel-home: wind only tail first, and never dock crooked.
    // `rhGate` limits how far she may close this frame (scene units): 0 while she turns round to tail-first
    // (her -Z within TAIL_FIRST_TOL of the strut tip), or up to the line-up distance while the line is more than
    // ALIGN_TOL off the strut axis; there the reel holds her while strut and mother line it up.
    const rh = this._rhHome && this._rhOn();
    let rhGate = Infinity;
    let rhLineHeld = false;
    let holdGateM = Infinity;      // metres to the hold point while a reason holds her (brakes to REST there; not rhGate: no free stop)
    if (rh) {
      const RH = Constants.REEL_HOME || {};
      const distM = dist / M;
      if (distM > 0.25 && dist > 1e-12) {
        _rhV1.set(0, 0, 1).applyQuaternion(this.group.quaternion);                  // her +Z, world
        const cosTail = -_rhV1.dot(toMother) / dist;                                // her -Z . unit(her -> tip)
        if (cosTail < Math.cos(degToRad(RH.TAIL_FIRST_TOL_DEG ?? 10))) rhGate = 0;
      }
      if (distM >= 0.5 && dist > 1e-12) {
        this._rhStrutDirWorldInto(parentQuat, _rhV2);
        const cosLine = -_rhV2.dot(toMother) / dist;                                // unit(tip -> her) . strut axis
        if (cosLine < Math.cos(degToRad(RH.ALIGN_TOL_DEG ?? 10))) {
          const lim = Math.max(0, dist - (RH.ALIGN_DIST_M ?? 2.0) * M);
          if (lim <= 0.002 * M) rhLineHeld = true;                                    // held: within 2 mm of the line-up distance
          rhGate = Math.min(rhGate, lim);
        }
      }
      // the clock of the hold: the mother gets ALIGN_WAIT_S to line her up, then she uses her own thrusters
      this._rhHoldS = rhLineHeld ? this._rhHoldS + dt : 0;
      // a blocked path or an empty tank is looked at again every second (the geometry changes), never for good
      if (this._rhNoPath) {
        this._rhNoPathS += dt;
        if (this._rhNoPathS >= 1) { this._rhNoPath = false; this._rhNoPathS = 0; }
      }
      if (rhLineHeld && !this._rhLineUp && !this._rhNoPath && !this._rhMotherWorking
          && this._rhHoldS >= (RH.ALIGN_WAIT_S ?? 5)) {
        // only if the line is also off the axis the strut is HEADING for: a strut still slewing will catch up on its own
        this._rhTargetDirWorldInto(parentQuat, _rhV2);
        const cosTarget = -_rhV2.dot(toMother) / dist;
        if (cosTarget < Math.cos(degToRad(RH.ALIGN_TOL_DEG ?? 10))
            && !this._rhBeginLineUp(dockWorldPos, dist, parentPos, parentQuat)) {
          this._rhNoPath = true;                                                   // she holds for the mother, and asks again in a second
          this._rhNoPathS = 0;
        }
      }
      if (this._rhLineUp) {                                                        // runs on to well inside the tolerance (no flutter at its edge)
        rhGate = 0;
        this._rhLineUpStep(dt, dockWorldPos, parentPos, parentQuat);
      }
      // reel-gas (DECISIONS §34): under REEL_HOME the haul is a sim - pull-up, cruise, a braking phase on her cold-gas
      // jet - not the stateless trapezoid above. `_rhReelStep` owns the speed (and the gas, and the line readout).
      if (profileV2) {
        if (!this._rhGasChecked) this._reelPushBegin();            // the reel's first real frame (the step below sets the sentinel)
        holdGateM = this._rhHoldStep(dt, dist / M);
        reelSpeed = this._rhReelStep(dt, dist / M, rhGate / M, armMass, hasPayload, boostMult, holdGateM);
        reelSpeedScaled = reelSpeed * M;
        // her ion thread keeps the line tight the whole haul: billed at its real thrust (not while the line-up burn runs)
        if (!this._rhLineUp) this._billIonThread(dt, this._rhReelMassKg);
        this._reelPushLine(dt, dockWorldPos);
      }
      if (rhGate === 0 && dt > 0) { reelSpeed = 0; reelSpeedScaled = 0; }
    }

    // FEEP soft re-dock arrest (REEL_PROFILE_V2): within ARREST_DISTANCE_M the daughter fires FEEP to null the residual
    // closing-rate: a ONE-SHOT mass-scaled fuel debit (fuel% = DEBIT_K · m_unit · v_arrest) the first frame inside the
    // window (the reel ramp already carries the closing-rate down to ~V_DOCK, so the debit prices the burn). Gated on
    // tether-plume clearance (yoke) and fuel; failing either → FUEL_FALLBACK_SLOW (zero-fuel reel-only finish + warn, never
    // a dead-end). Mission 1 is free. DOCKING's per-state fuel rate is suppressed for this cycle (see _consumeFuel).
    // Under reel-home none of it applies (DECISIONS §34): the jet BRAKES her in `_rhReelStep` (billed as it fires), so
    // there is nothing to price, no plume to keep off the line, no arrest steer.
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
        // Decomposed clearance verdict (real bridle anchor + commanded electrostatic steer against the 20°+2°
        // steered-axis requirement; derivation on _tetherPlumeClearance). The arrest-window attitude offset that makes
        // production dock-ahead geometry pass is owned by the REELING branch in update(); by entry it is converged
        // (ARREST_STEER_LEAD_M), so this gate reads the honest burn-start nose.
        const plumeVerdict = this._tetherPlumeClearance(parentPos, parentQuat);
        const plumeClear = plumeVerdict.clear;

        if (mission1Free) {
          this._redockDebitApplied = true;   // free pass still suppresses the DOCKING rate
        } else {
          // Steer-assist pricing: when the clear verdict needed commanded steer (steerNeededDeg > 0), the burn runs on
          // the ARREST_STEER_DEG offset plan: thrust along travel scales as cos(offset), so the same Δv costs
          // 1/cos(15°) ≈ ×1.035 propellant. Unassisted geometry (≥ MIN_TETHER_PLUME_DEG, e.g. dock abeam) pays the
          // plain debit. Priced flat on the committed offset, not per-degree.
          const YC = Constants.YOKE_CLEARANCE || {};
          const steerLoss = plumeVerdict.steerNeededDeg > 0
            ? 1 / Math.cos(degToRad(YC.ARREST_STEER_DEG ?? 15))
            : 1;
          const debit = (RF.DEBIT_K ?? 0.0008) * mUnit * vArrest * steerLoss;
          if (plumeClear && this.fuel >= debit && !this._powerOff()) {
            this.fuel -= debit;
            this.power.markEngine();
            this._redockDebitApplied = true;
          } else if (RF.FUEL_FALLBACK_SLOW !== false) {
            // Can't fund the burn OR the tether crosses the FEEP plume cone: finish on the reel motor alone (slower,
            // zero-fuel) and warn.
            if (!this._redockFuelLowWarned) {
              this._redockFuelLowWarned = true;
              eventBus.emit(Events.REDOCK_FUEL_LOW, {
                armIndex: this.index, fuel: this.fuel, needed: debit,
              });
              eventBus.emit(Events.COMMS_MESSAGE, {
                source: this.displayName,
                text: this._powerOff()
                  ? `${this.displayName}: ${batteryFlatLine()} Easing in on the winch.`
                  : plumeClear
                  ? `${this.displayName}: Low FEEP for arrest. Easing in on the winch.`
                  : `${this.displayName}: Tether fouls the FEEP plume. Easing in on the winch.`,
                channel: 'CMD', priority: 'warning',
              });
            }
          }
        }
      }
    }

    // `dist` is in SCENE UNITS (1 unit = 100 km): the guard below is 1 mm (M = 1 m → 0.00001 scene units), purely to avoid
    // normalize() on a zero-length vector. Real docking is decided by `moveDistance >= dist`.
    // The dock decision is hoisted OUT of that guard: nested inside `dist > 1e-7`, a frame that stepped from just above it
    // to just below (dist_after ∈ (0, 1 cm)) left the arm parked <1 cm from the dock with the whole branch skipped forever
    // (a phase-dependent permanent REELING stall on both reel paths; V2's V_DOCK=1 m/s approach steps 16.7 mm/frame past a
    // 10 mm window). The dock check needs no normalize, so only the move branch keeps the guard.
    let moveDistance = reelSpeedScaled * dt;
    if (rh && rhGate < moveDistance) {
      moveDistance = rhGate;
      // her speed is what she really covered when the line-up gate stopped her short of the step
      if (profileV2 && dt > 0) this._rhReelV = Math.min(this._rhReelV, moveDistance / (M * dt));
    }
    // never past the hold point (the braking law stops her there; this is the rounding backstop)
    if (rh && holdGateM !== Infinity && this._rhHold && this._rhHold.on && holdGateM * M < moveDistance) {
      moveDistance = Math.max(0, holdGateM * M);
      if (profileV2 && dt > 0) this._rhReelV = Math.min(this._rhReelV, moveDistance / (M * dt));
    }
    if (moveDistance >= dist) {
      // her arrival momentum goes into the mother (before she is snapped onto the tip)
      if (rh && profileV2 && dt > 0) this._reelPushLatch(dockWorldPos, reelSpeed);
      this.position.copy(dockWorldPos);
      this._transitionTo(S.DOCKING);
      this._seatBegin(parentPos, parentQuat);
      eventBus.emit(Events.ARM_RETURNED, {
        armId: this.id, captured: hasPayload, debrisId: this.capturedDebris?.id,
      });
    } else if (dist > 1e-7) {
      toMother.normalize();
      this.position.addScaledVector(toMother, moveDistance);
    }

    // Drag the captured debris with us every frame so it is never left behind on its orbit while we reel home.
    // Under reel-home a catch the net reel brought in sits in its cell on her, fixed in her frame (DECISIONS §34).
    if (!(rh && this._rhArrived && this._rhPinInCell())) this._pinCatchToSelf(parentPos);

    this.tetherLength = dist / M;

    // Tension (simplified: F = m × a_reel); coefficient tuned (Constants.REEL_TENSION_COEFF) so an in-spec catch reels home
    // under the default tether break strength: only genuine overload snaps the cable. Boosting doubles the target and
    // tension EASES toward it (TENSION_EASE_TAU_S) so the bar visibly climbs into the red and the player can release Shift
    // before the snap; nominal reel assigns directly (cautious play is never punished).
    // V2: tension keys off the combined unit mass m_unit = daughter + net + debris (single source of truth). The cruise
    // throttle (_computeReelProfileSpeed) is power-bounded, so an in-spec catch stays under break strength at full cruise:
    // only Boost may push past it.
    const payloadMass = hasPayload && this.capturedDebris ? (this.capturedDebris.mass || 0) : 0;
    const tensionMass = profileV2 ? this._computeReelMUnit(armMass, hasPayload) : (armMass + payloadMass);
    const tensionCoeff = Constants.REEL_TENSION_COEFF ?? 0.04;
    let tensionTarget = tensionMass * reelSpeed * tensionCoeff;
    // Under REEL_HOME the line carries what the physics asks of it (true N): the pull-up, the ion thread at cruise, the
    // (MARGIN - 1) the reel holds while the jet brakes. Snap / rip thresholds are unchanged.
    if (rh && profileV2) tensionTarget = this._rhTensionN;
    if (boostOn) {
      const tau = (Constants.REEL_BOOST && Constants.REEL_BOOST.TENSION_EASE_TAU_S) || 0.4;
      this.tetherTension += (tensionTarget - this.tetherTension) * Math.min(1, dt / tau);
    } else {
      this.tetherTension = tensionTarget;
    }

    // DECISIONS §17 row 2: the strut reel cartridge (this daughter's tether reel, on the mother's strut) bills the
    // mother's battery the real mechanical power, line tension × line speed ÷ REEL_EFFICIENCY, floored at its own 15 W
    // motor while turning and capped at HAUL_MOTOR_POWER. dt 0 (a held world: ArmManager ticks arms with 0) bills nothing.
    if (dt > 0 && moveDistance > 0 && !this.isDetached) {
      const MD = Constants.MOTOR_DRAW_W || {};
      const rs = this._playerSatellite && this._playerSatellite._resourceSystem;
      if (rs && typeof rs.billWatts === 'function') {
        // Under REEL_HOME the tension is true newtons, so the line speed must be TRUE m/s too (reel speed is game-scale:
        // / TimeAuthority.BASE_SCALE). The legacy path keeps its game-scale pairing (old coefficient).
        const lineSpeed = (rh && profileV2) ? reelSpeed / TimeAuthority.BASE_SCALE : reelSpeed;
        const mechW = Math.max(0, this.tetherTension) * lineSpeed / (MD.REEL_EFFICIENCY || 0.5);
        rs.billWatts(Math.min(MD.REEL_MAX ?? 2500, Math.max(MD.STRUT_REEL_MIN ?? 15, mechW)), dt, 'strutReel');
      }
    }

    // Boosting a catch deep in the strain band can RIP the net: recoverable (debris drifts free, daughter returns), same
    // consequence path as the reel-start strain slip. Rolled per second while boosting.
    if (boostOn && this.state === S.REELING
        && (!this._captureToolKind || this._captureToolKind === 'NET')
        && payloadMass > 0 && (this._netRatedMass || 0) > 0) {
      const strain = payloadMass / this._netRatedMass;
      // The band ramp routes through the ONE strain-band helper; the CAP stays here: a PER-SECOND roll vs
      // RIP_PROB_PER_S, dt-scaled.
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

    eventBus.emit(Events.TETHER_TENSION_UPDATE, {
      armIndex: this.index,
      tension: this.tetherTension,
      fraction: this.tetherTension / this.tetherBreakStrength,
    });

    // Check for tether snap: catastrophic cut from the mother (see _snapTether). Guard on REELING: the reel-step above
    // may have already docked the catch this frame (transitioned to DOCKING): then it is delivered, not lost.
    // During MISSION 1 (the learning mission) the snap is clamped to a warning: a catastrophic EXPENDED daughter
    // dead-ends the beginner loop before the player has learned the recovery verbs.
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

    // Daughter reel creak, emitted HERE on the ONE event the mother lasso already owns (Events.TETHER_TENSION,
    // { tensionFraction, armId }) rather than teaching AudioSystem to listen to TETHER_TENSION_UPDATE: soundVocabulary.js
    // pins ONE canonical trigger per sound family (`playTetherTension ← TETHER_TENSION`); TETHER_TENSION_UPDATE fires EVERY
    // reel frame regardless of strain (gating it in AudioSystem would duplicate per-arm bookkeeping); AudioSystem's
    // per-armId cooldown (_tetherTensionTimers) then covers lasso and daughter through the ONE chokepoint.
    // Silent below the strain-safe fraction (REEL_TENSION_WARNING, also the HUD bar's yellow tier), rate-limited at the
    // source to ≤1 emit per TETHER_CREAK_MIN_INTERVAL_S (AudioSystem's 3 s per-armId cooldown may thin it further). The
    // payload's live fraction scales the creak volume. Runs AFTER the snap check so a snapping/docking frame can't squeak.
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

    // No fuel consumption (power from the reel motor only, via PowerDistribution).

    this.reeling = true;
    // Tag the current reel phase + closing-rate so the HUD can render HAUL / RAMP / ARREST and a closing-rate readout.
    // `speed` is the live closing-rate (REELING moves position directly, so the reel speed IS the closing-rate).
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
   * RETURNING: return to parent without debris. Like REELING, it targets the STRUT-TIP dock world position, NOT the
   * mother bus centre (targeting `parentPos` flew her into/behind the hull and drew the tether inward through the ship).
   */
  _updateReturning(dt, parentPos, parentQuat) {
    if (this.isDetached) {
      this._transitionTo(S.TRANSIT);
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Cannot return. Tether severed. Free-flying.`,
        priority: 'warning',
      });
      return;
    }

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
      this._seatBegin(parentPos, parentQuat);
      eventBus.emit(Events.ARM_RETURNED, {
        armId: this.id, captured: false,
      });
    }
  }

  /**
   * dock-seat (DECISIONS §35 row 10): the seat of a daughter that has come home. Her place is the strut tip PLUS a small
   * residual (`_seatLocal`, ship frame, scene units) that dies away by a 5 %/frame (60 Hz) law. She rides the tip
   * rigidly the whole time, so a strut that keeps swinging (15 deg/s) or a ship that keeps turning does not leave her
   * behind (a lerp lagged 0.14 m, then snapped 13 cm when HOLDING_CATCH clamped her). Called once per DOCKING /
   * RELOADING frame; `_seatBegin` starts the residual from where she is.
   * @private
   */
  _seatBegin(parentPos, parentQuat) {
    if (!this._seatLocal) this._seatLocal = new THREE.Vector3();
    this._seatReady = true;
    if (!parentPos || !this.dockOffset) { this._seatLocal.set(0, 0, 0); return; }
    const tip = _seatTip.copy(this.dockOffset);
    if (parentQuat) tip.applyQuaternion(parentQuat);
    tip.add(parentPos);
    this._seatLocal.copy(this.position).sub(tip);
    if (parentQuat) this._seatLocal.applyQuaternion(_seatQInv.copy(parentQuat).invert());
  }

  _seatOnTip(dt, parentPos, parentQuat) {
    if (!parentPos || !this.dockOffset) return;
    if (!this._seatReady || !this._seatLocal) this._seatBegin(parentPos, parentQuat);
    const k = dt > 0 ? Math.pow(0.95, dt * 60) : 1;
    this._seatLocal.multiplyScalar(k);
    const tip = _seatTip.copy(this.dockOffset);
    if (parentQuat) tip.applyQuaternion(parentQuat);
    tip.add(parentPos);
    const res = _seatRes.copy(this._seatLocal);
    if (parentQuat) res.applyQuaternion(parentQuat);
    this.position.copy(tip).add(res);
  }

  /** DOCKING: final alignment to dock offset (3s) */
  _updateDocking(dt, parentPos, parentQuat) {
    this._seatOnTip(dt, parentPos, parentQuat);

    if (!(this._rhArrived && this._rhPinInCell())) this._pinCatchToSelf(parentPos);

    if (this.stateTimer > Constants.ARM_DOCK_DURATION) {
      this.reeling = false;
      this.tetherTension = 0;

      // A captured debris is NOT processed/removed at the mother: she parks at her strut tip still holding it cinched in
      // the net, full size. She is OCCUPIED (does not reload, stays out of the deploy pool: HOLDING_CATCH is not DOCKED),
      // leaving the other daughters free. Keep `_capturedByArm` and `_armPinned` set so the held net stays cinched
      // (CaptureNet's held-net release keys off `_capturedByArm`) and the debris stays pinned to the strut.
      // DEBRIS_CAPTURED is still emitted (capture-secured signal; drives the first_capture teaching beat). Salvage/scoring
      // and field removal fire on CATCH_PROCESSED, NOT on dock arrival (see GameFlowManager).
      if (this.capturedDebris) {
        this.captures++;
        // The parked hold is a cargo RACK (heldCatches). Read the debris into a local BEFORE clearing the scalar: the
        // DEBRIS_CAPTURED emit below names its id. The rack is empty here, so the capacity guard cannot trip.
        const debris = this.capturedDebris;
        if (this._stowHeldCatch(debris, parentQuat)) {
          this.capturedDebris = null;
          debris._rackFromMotherNet = false;  // her OWN catch: she keeps it (the mission hand-off is for the mother's)
          // The stow assigned the cell and froze the catch's attitude in HER frame from its attitude NOW (no jump); the pin
          // below starts the glide from the in-hand point and the piece turns with her from here on.
          this._pinHeldCatches(parentPos, parentQuat);
          this._breakdownStarted = false;     // reset staged-furnace bookkeeping
          this._breakdownChunksFired = 0;
          this._transitionTo(S.HOLDING_CATCH);
          eventBus.emit(Events.DEBRIS_CAPTURED, {
            debrisId: debris.id,
            armId: this.id,
            type: this.type,
            parked: true,                     // held at strut, not removed/processed
          });
          // The daughter's own catch pays HERE, when parked on her rack, whatever the furnace flag (mother catches pay at the
          // collar mate). { parked: true } keeps the body; source 'rack' tells the mission-start hold, the "at the nose" line
          // and the net-park teaching beat this is not a nose park. GameFlowManager's `_credited` ledger stops a later pay.
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
        // Full rack (unreachable on the haul path): the push REFUSED, the catch stays in hand (cargo is never destroyed)
        // and she falls through to the legacy reload below.
      }

      // Empty return (e.g. a recoverable net failure sent her home without a catch): the legacy reload path applies.
      this.target = null;
      this._manualCapture = false;
      this._nearbyDebris = [];

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
   * HOLDING_CATCH: daughter docked at her strut tip carrying a captured debris cinched in the net, running the staged
   * FURNACE_TRANSFER timeline (hold → chop → feed → `CATCH_PROCESSED` → RELOADING). Like DOCKED she holds position but is
   * intentionally NOT charged and NOT in the DOCKED state, so `ArmManager._findDockedArm()` skips her. The debris is
   * re-pinned to the strut tip every frame (full size). `recall()` REFUSES this state (reeling would dump the cargo): the
   * timeline is the only thing that clears her.
   * @private
   */
  _updateHoldingCatch(dt, parentPos, parentQuat) {
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

    // DECISIONS §28 row 1: with no furnace there is no cook clock. She keeps the catch pinned to her rack, full size, until
    // the station takes it at the resupply stop (ArmManager.unloadHeldCatches clears the rack; the empty-rack fallback
    // above then reloads her). The staged breakdown below is for a real furnace (FEATURE_FLAGS.FURNACE_COOK).
    if (!Constants.isFeatureEnabled('FURNACE_COOK')) {
      this._pinHeldCatches(parentPos, parentQuat);
      return;
    }
    // A pending big piece is never cooked on the rack either (as at the collar): it pays when disposed of, so it stays
    // pinned full size and the rack waits (oldest-first digestion would otherwise lose its pay).
    if (bigPieces.isPending(this.heldCatches[0])) {
      this._pinHeldCatches(parentPos, parentQuat);
      return;
    }

    // Staged furnace breakdown: three phases off the piece's digest time `t` (below):
    //   hold [0, HOLD_S)      - catch full-size, cinched in the net (_capturedByArm set so CaptureNet keeps it wrapped).
    //   chop [HOLD_S, CHOP_S) - emit CATCH_BREAKDOWN_START once; release the net's hold (_capturedByArm = null) so the bag
    //                           visual can follow the chop; mark debris._breakdownActive so the furnace visual owns its
    //                           scale/disposal.
    //   feed [CHOP_S, FEED_S) - emit CHUNK_COUNT evenly-spaced CATCH_BREAKDOWN_CHUNK events as chunks stream in.
    //   at FEED_S             - emit the single CATCH_PROCESSED (single-fire contract: GameFlowManager + bosses), reload.
    // Phase boundaries come from the single constant FURNACE_TRANSFER (no per-site fallback literals: ArmManager's
    // chop-window scale ramp reads the same keys).
    const FT = Constants.FURNACE_TRANSFER;
    const HOLD_S = FT.HOLD_S;
    const CHOP_S = FT.CHOP_S;
    const FEED_S = FT.FEED_S;
    const CHUNK_COUNT = FT.CHUNK_COUNT;
    // The timeline digests the OLDEST piece on the rack first; the rest wait parked at their slots.
    const debris = this.heldCatches[0];
    // The timeline is a pure function of this piece's digestion progress, not the HOLDING_CATCH stateTimer. Progress
    // accrues on the transit clock (dt × TIME_SCALE_GAMEPLAY: full rate while flying, 0.1× in menu/shop backgrounds),
    // scaled by the sun gate ArmManager writes each frame (_digestSunScale: 1.0 in sunlight, ECLIPSE_RATE in eclipse;
    // ?? 1.0 keeps legacy mocks identical).
    // owner 2026-08-13: the span is mass-scaled, clamp(mass × S_PER_KG, MIN_S, MAX_S): energy ∝ mass at fixed concentrator
    // power. Progress maps onto [0, FEED_S], so the hold/chop/feed fractions and chunk cadence are unchanged.
    const span = FT.digestSpanS(debris.mass);   // the ONE span-law home
    const sunScale = this._digestSunScale ?? 1.0;
    debris._digestProgress = (debris._digestProgress || 0) +
      dt * TimeAuthority.BASE_SCALE * sunScale;
    const t = Math.min(FEED_S, (debris._digestProgress / span) * FEED_S);
    // ArmManager's chop scale-ramp reads this derived phase time.
    this._digestPhaseT = t;

    // Lazy-init the per-park breakdown bookkeeping (also reset on entry in _updateDocking); safe if a test sets
    // HOLDING_CATCH directly.
    if (this._breakdownStarted === undefined) this._breakdownStarted = false;
    if (this._breakdownChunksFired === undefined) this._breakdownChunksFired = 0;

    if (t < HOLD_S) {
      // hold: catch welded full-size, net still cinched. Lateral bias keeps the
      // bag off the camera→daughter axis so the parked daughter stays visible.
      this._pinHeldCatches(parentPos, parentQuat);
      return;
    }

    if (!this._breakdownStarted) {
      this._breakdownStarted = true;
      debris._breakdownActive = true;          // furnace visual owns scale/disposal
      debris._capturedByArm = null;            // release the held-net cinch
      eventBus.emit(Events.CATCH_BREAKDOWN_START, {
        armId: this.id, debrisId: debris.id, chunkCount: CHUNK_COUNT,
      });
      // Player-facing comms for the breakdown belong to GameFlowManager's CATCH_BREAKDOWN_START handler: none here.
    }

    // Keep the breaking-down catch pinned to the strut (same lateral bias as the hold); the furnace visual owns the scale ramp.
    this._pinHeldCatches(parentPos, parentQuat);

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

      // Furnace-transfer complete: hand the catch to the mother.
      const debrisId = debris.id;
      // Release the daughter's pin so the furnace step owns the debris.
      debris._armPinned = false;
      debris._capturedByArm = null;
      debris._armPinPos = null;
      debris._breakdownActive = false;
      clearShipRelativeAttitude(debris);
      clearRackCell(debris);                // it leaves her rack
      this.heldCatches.shift();
      this.reeling = false;
      this.tetherTension = 0;
      this._breakdownStarted = false;
      this._breakdownChunksFired = 0;
      // The successful catch consumed the net: tell the bag visual to draw itself toward the mother (§3.5).
      eventBus.emit(Events.NET_CONSUMED, { armIndex: this.index, armId: this.id });
      eventBus.emit(Events.CATCH_PROCESSED, { armId: this.id, debrisId, type: this.type });
      // Completion comms is owned by GameFlowManager's CATCH_PROCESSED handler.
      if (this.heldCatches.length > 0) {
        // Sequential digestion: the next piece runs the SAME timeline from t=0 (it runs off the piece's _digestProgress,
        // which starts at 0). stateTimer is only zeroed by _transitionTo and we are NOT leaving HOLDING_CATCH: zero it
        // explicitly (no ARM_STATE_CHANGE: she stays parked) for any other per-state readers.
        this.stateTimer = 0;
        // The digested piece's mass just LEFT the rack sum computeInertia reads, and staying parked fires no
        // ARM_STATE_CHANGE (which the empty-rack RELOADING below gets for free): invalidate the cache directly.
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

  /** RELOADING: V5 worm gear motor compresses the crossbow spring; duration ∝ launch speed² (energy-based). @private */
  _updateReloading(dt, parentPos, parentQuat) {
    this._seatOnTip(dt, parentPos, parentQuat);   // she rides the strut tip while the spring reloads
    if (this.reloadDuration <= 0) {
      const speed = this.launchSpeed;
      const armMass = this.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS;
      const energy = 0.5 * armMass * speed * speed;
      this.reloadDuration = energy / (CROSSBOW_RELOAD_POWER * CROSSBOW_WORM_GEAR_EFFICIENCY);
    }

    this.reloadProgress += dt / this.reloadDuration;

    // The reload worm-gear motor runs off the mother's battery at CROSSBOW_RELOAD_POWER (MOTOR_DRAW_W.CROSSBOW_RELOAD)
    // for the whole reload: the energy E/η the duration above is computed from.
    if (dt > 0) {
      const rs = this._playerSatellite && this._playerSatellite._resourceSystem;
      if (rs && typeof rs.billWatts === 'function') {
        rs.billWatts(Constants.MOTOR_DRAW_W?.CROSSBOW_RELOAD ?? CROSSBOW_RELOAD_POWER, dt, 'reload');
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

  /** TRAWLING: slow sweep — passive debris collection along orbit path */
  _updateTrawling(dt, parentPos) {
    this.mesh.visible = true;
    this.tetherLine.visible = true;

    this._trawlTimer = (this._trawlTimer || 0) + dt;
    const maxDuration = (Constants.TRAWLING && Constants.TRAWLING.TRAWL_DURATION_MAX) || 120;

    if (this._trawlTimer >= maxDuration) {
      this._trawlingMode = false;
      eventBus.emit(Events.TRAWL_END, { armId: this.id });

      if (this.isDetached) {
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: this.displayName, text: 'Trawl complete. Free-flying, no tether.', priority: 'info',
        });
        this._transitionTo(S.TRANSIT);
      } else {
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: this.displayName, text: 'Trawl complete. Reeling in', priority: 'info',
        });
        this._transitionTo(S.REELING);
      }
      return;
    }

    if (this._powerOff()) {   // a flat pack: no sweep thrust, no fuel; she coasts (a tethered trawler is ADRIFT by the frame's end)
      this.position.addScaledVector(this.velocity, dt);
      return;
    }
    const fuelRate = (Constants.TRAWLING && Constants.TRAWLING.FUEL_RATE_TRAWL) || 0.002;
    this.fuel -= fuelRate * dt;
    this.power.markEngine();

    // Detached trawling arms: fuel warnings (same thresholds as _consumeFuel)
    if (this.isDetached) {
      const fuelFrac = this.fuel / 100;
      if (fuelFrac <= Constants.DETACH_FUEL_WARNING_10 && !this._detachFuelWarning10) {
        this._detachFuelWarning10 = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `CRITICAL: ${this.displayName} fuel at 10%.`,
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

    // A tethered trawler that runs low holds her reserve and goes ADRIFT (the mother can still reel her home); detached
    // trawlers have no winch and are lost at zero.
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

    const speed = (this.config.approachSpeed || 0.000005) *
      ((Constants.TRAWLING && Constants.TRAWLING.TRAWL_SPEED_SCALE) || 0.3);

    if (this._trawlDirection) {
      this.position.x += this._trawlDirection.x * speed * dt;
      this.position.y += this._trawlDirection.y * speed * dt;
      this.position.z += this._trawlDirection.z * speed * dt;
    }

    this.tetherLength = this.position.distanceTo(parentPos) / M;

    if (!this.isDetached && this.tetherLength >= this.config.tetherMax * 0.95) {
      const dir = this._tmpVec.subVectors(this.position, parentPos).normalize();
      this.position.copy(parentPos).add(dir.multiplyScalar(this.config.tetherMax * 0.94 * M));
      this.tetherLength = this.config.tetherMax * 0.94;
    }

    const captureRadius = ((Constants.TRAWLING && Constants.TRAWLING.TRAWL_RADIUS_KM) || 0.05) * Constants.SCENE_SCALE;
    const maxCaptureMass = (Constants.TRAWLING && Constants.TRAWLING.AUTO_CAPTURE_MASS_MAX) || 50;

    eventBus.emit(Events.TRAWL_CAPTURE, {
      armId: this.id,
      position: this.position.clone(),
      radius: captureRadius,
      maxMass: maxCaptureMass,
    });

    if (this._nearbyDebris && this._nearbyDebris.length > 0) {
      for (const debris of this._nearbyDebris) {
        if (!debris.alive || !debris._scenePosition) continue;
        if (debris.mass > maxCaptureMass) continue;
        const dist = this.position.distanceTo(debris._scenePosition);
        if (dist < captureRadius) {
          this.target = debris;
          this.capturedDebris = debris;
          debris._captured = true;  // hide reticle immediately
          debris._capturedByArm = this; // pin debris visual to arm during REELING
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

  _updateDeorbiting(dt) {
    if (this._powerOff()) {   // a burn already under way loses power: the thruster stops, no fuel is spent, she coasts
      this.position.addScaledVector(this.velocity, dt);
      this.mesh.visible = true;
      this.tetherLine.visible = false;
      return;
    }
    const burnRate = 5.0; // %/sec
    this.fuel -= burnRate * dt;
    this.power.markEngine();

    // Retrograde from the LIVE velocity vector, not `position × ŷ` (that assumed an equatorial orbit and was wrong for
    // inclined tracks, e.g. 51.6°). normalize() of a zero vector returns zero in THREE, so no NaN risk.
    const retrograde = _goalDir.copy(this.velocity).normalize().negate();
    const thrustDV = (this._computeMetalThrust() / (this.config.mass + (this.capturedDebris?.mass || 0))) * dt;
    this.velocity.add(retrograde.multiplyScalar(thrustDV));
    this.position.addScaledVector(this.velocity, dt);

    this.mesh.visible = true;
    this.tetherLine.visible = false; // Tether detached for deorbit

    if (this.fuel <= 0) {
      this.fuel = 0;
      this.mesh.visible = false;
      this.group.visible = false;
      this._transitionTo(S.EXPENDED);

      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Fuel exhausted. Deorbit burn complete. Daughter lost.`,
        priority: 'warning',
      });
    }
  }

  _updateWebShot(dt, parentPos) {
    this.mesh.visible = true;
    this.tetherLine.visible = true;

    const tPos = this._webShotTarget?._scenePosition;
    const origin = this._webShotOrigin;
    if (tPos && origin) {
      const toTarget = this._tmpVec.subVectors(tPos, origin).normalize();
      const extendDist = this.config.bodyDims[2] * M * 10 * (this.stateTimer / Constants.WEB_SHOT_DURATION);
      this.position.copy(origin).add(toTarget.multiplyScalar(extendDist));
    }

    if (parentPos) {
      this.tetherLength = this.position.distanceTo(parentPos) / M;
    }

    if (this.stateTimer >= Constants.WEB_SHOT_DURATION) {
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

      this._webShotCooldown = Constants.WEB_SHOT_COOLDOWN;
      this._webShotTarget = null;

      this._transitionTo(this._webShotPrevState);
    }
  }

  /** @private ABLATING: V5 10 W laser applies torque to reduce the target's angular velocity (de-spin/nudge). */
  _updateAblating(dt) {
    this.ablationTimer += dt;

    if (this.ablationTarget) {
      const targetPos = this.ablationTarget.mesh ? this.ablationTarget.mesh.position : null;
      if (targetPos) {
        const range = this.position.distanceTo(targetPos) / M;
        if (range > ABLATION_RANGE_MAX) {
          this._endAblation('outOfRange');
          return;
        }

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

  /** @private End ablation and return to transit. @param {string} reason */
  _endAblation(reason) {
    eventBus.emit(Events.ABLATION_END, {
      armIndex: this.index,
      despinAchieved: reason !== 'outOfRange',
    });
    this.ablationTimer = 0;
    this.ablationTarget = null;
    this._transitionTo(S.TRANSIT);
  }

  /**
   * @private SCANNING: V5 pulse scan, the arm is a distributed sensor node that holds position and emits sensor data;
   * ArmManager manages the duration (all arms together).
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
   * ADRIFT: out of usable FEEP but STILL TETHERED and powered. Thrusters are offline (working tank empty), yet
   * avionics/beacon run on the reserve and the winch can pull her home: the player can reel her in (R), select/pilot
   * her (1-4), or disconnect her. She drifts at the end of the tether; line and tension are handled by _updateTether.
   */
  _updateAdrift(dt) {
    this.position.addScaledVector(this.velocity, dt * 0.5);
    this.velocity.multiplyScalar(0.99); // slow residual drift; the tether holds her
    this.mesh.visible = true;
  }

  /**
   * @private Transition a tethered daughter into ADRIFT (out of usable propellant but recoverable). Plain-language comms
   * say WHAT happened and WHAT the player can do, never the bare "expended"; fires once per adrift episode.
   */
  _enterAdrift(cause = 'fuel') {
    if (this.state === S.ADRIFT || this.state === S.EXPENDED || this.isDetached) return;
    this._manualMode = false;
    this._trawlingMode = false;
    this._adriftCause = cause;      // 'fuel' (today's) or 'battery' (flat pack: DECISIONS §53 row 3); InputManager's adrift line reads it
    this._transitionTo(S.ADRIFT);
    eventBus.emit(Events.COMMS_MESSAGE, {
      source: 'HOUSTON',
      channel: 'CMD',
      text: cause === 'battery'
        ? `${this.displayName}: ${batteryFlatLine()} Thrusters offline, but she's still on the tether. Press R to reel her home (winch, no fuel needed) or disconnect. Not lost.`
        : `${this.displayName}: FEEP propellant spent. Thrusters offline, but she's still on the tether and powered. Press R to reel her home (winch, no fuel needed) or disconnect. Not lost.`,
      priority: 'warning',
    });
  }

  /** @returns {boolean} her pack is flat and she is out (not docked): thrusters, valves and the net launcher are off. */
  _powerOff() {
    return this.power.flat && !this._powerDocked();
  }

  /**
   * @returns {boolean} she sits on her strut: the mother pays her loads and charges her pack. DOCKED, HOLDING_CATCH, RELOADING
   * (where the cold-gas refill runs) and CARRY_PREP (docked while the strut and radiators move).
   */
  _powerDocked() {
    const st = this.state;
    return st === S.DOCKED || st === S.HOLDING_CATCH || st === S.RELOADING || st === S.CARRY_PREP;
  }

  /**
   * @private Her battery and heat for this frame (DaughterPower; DECISIONS §53 row 3). Docked (DOCKED, HOLDING_CATCH,
   * RELOADING: where the cold-gas refill runs) the mother pays her loads and charges her pack through
   * `billWatts` (untagged: not a motor), the pack gaining CHARGE_EFF of what the mother gave. Out, the pack pays: the
   * marks the debit sites made this frame (`markEngine`, `markGas`) plus standby, avionics and aiming; sunlight fills it
   * (the mother's `_inShadow`). A flat pack takes a tethered daughter to ADRIFT; a detached one just has her thrusters,
   * valves and launcher off (`_powerOff`), she is already beyond the tether's help.
   */
  _updateDaughterPower(dt) {
    if (!(dt > 0)) return;
    const st = this.state;
    const q = this.group.quaternion;
    if (!this._pwQuat) this._pwQuat = q.clone();
    const dot = Math.min(1, Math.abs(q.x * this._pwQuat.x + q.y * this._pwQuat.y + q.z * this._pwQuat.z + q.w * this._pwQuat.w));
    const turnDegS = 2 * Math.acos(dot) * RAD2DEG / dt;
    this._pwQuat.copy(q);
    if (st === S.EXPENDED) { this.power.update(dt, { docked: true }); return; }
    const docked = this._powerDocked();
    const ps = this._playerSatellite;
    const rs = ps && ps._resourceSystem;
    const canBill = !!rs && typeof rs.billWatts === 'function';
    if (docked && canBill) {
      const askW = this.power.chargeRequestW(dt);
      if (askW > 0) this.power.store(rs.billWatts(askW, dt));
    }
    // docked, her attitude changes are the strut's and the mother's, not her wheels: no aiming load
    this.power.update(dt, { inSun: !(ps && ps._inShadow), docked, turnDegS: docked ? 0 : turnDegS });
    // docked, every mark of this frame (engine, valves, aiming, launcher) is the mother's to pay, untagged (not a motor)
    if (docked && canBill && this.power.motherLoadW > 0) rs.billWatts(this.power.motherLoadW, dt);
    if (docked || !this.power.flat || this.isDetached) return;
    // Flat while out. Not while the winch is already bringing her in or she is on her strut's last approach, nor mid-carry:
    // those run on the reels. A daughter flying home on her thrusters hands over to the winch (as an empty tank does).
    if (st === S.ADRIFT || st === S.DOCKING || st === S.REELING || st === S.LAUNCHING || this._carry != null) return;
    if (st === S.RETURNING) {
      this._transitionTo(S.REELING);
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'HOUSTON', channel: 'CMD',
        text: `${this.displayName}: ${batteryFlatLine()} Finishing the return on the winch.`,
        priority: 'warning',
      });
      eventBus.emit(Events.ARM_RECALLED, { armId: this.id });
      return;
    }
    this._enterAdrift('battery');
  }

  _updateExpended(dt) {
    this.position.addScaledVector(this.velocity, dt * 0.5);
    this.velocity.multiplyScalar(0.999);
    this.mesh.visible = true;
    this.tetherLine.visible = !this._tetherSevered;

    // Bounded cleanup of a tether-snapped catch: it tumbles off pinned to this drifting daughter for a short while, then
    // the pin is released so the runaway debris resumes its own orbit + LOD (else it renders at full detail forever and
    // is never reclaimed by the field).
    if (this._severedCatch) {
      // If another daughter re-captured the runaway, the pin has transferred: stop tracking it here.
      if (this._severedCatch._capturedByArm !== this) {
        this._severedCatch = null;
      } else {
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

  _consumeFuel(dt) {
    // Rates in %/sec, tuned so a full deploy-capture-return cycle ≈30-60 s gameplay. TRANSIT/APPROACH rates apply ONLY to
    // manual-pilot flight; the autopilot path is impulse-priced (below).
    const rates = {
      [S.UNDOCKING]: 0.2,
      [S.LAUNCHING]: 0.0,         // spring provides the energy
      [S.TRANSIT]: 1.5,
      [S.APPROACH]: 1.0,
      [S.NETTING]: 0.3,
      [S.GRAPPLED]: 0.2,
      [S.HAULING]: 2.0,
      [S.REELING]: 0.0,           // V5: motor reel-in (REEL_HOME: the ion thread is billed in _updateReeling, not here)
      [S.RETURNING]: 1.2,
      [S.DOCKING]: 0.2,
      [S.RELOADING]: 0.0,         // worm gear: zero FEEP fuel
      [S.WEB_SHOT]: 0.0,          // Fuel consumed upfront in fireWebShot()
      [S.ABLATING]: 0.0,          // laser de-spin: zero FEEP fuel
      [S.SCANNING]: 0.0,          // sensor mode: zero FEEP fuel
    };
    let rate = rates[this.state] || 0;
    // reel-home: winding the net line in is a motor on her, not a thruster burn (the strut reel's only FEEP is the ion
    // thread, billed in _updateReeling)
    if (this.state === S.GRAPPLED && this._rhHome) rate = 0;
    // The re-dock arrest is charged ONCE as a discrete mass-scaled debit during REELING: suppress the per-state DOCKING
    // rate for the cycle that fired it (no double charge). The flag is cleared on the next clean dock/reload cycle (in
    // _transitionTo).
    if (this.state === S.DOCKING && this._redockDebitApplied === true) rate = 0;
    // reel-home: DOCKING that came off the strut reel is the winch settling her onto the strut (REELING fired no arrest
    // burn under the flag), so the DOCKING thruster rate is not billed either.
    if (this.state === S.DOCKING && this._rhDockFree === true) rate = 0;
    // Autopilot TRANSIT/APPROACH fuel is IMPULSE-PRICED: the spring pays launch kinetic energy, so the FEEP pays only the
    // commanded corrective impulse (Σ|dvCmd| the controller applied this frame) against the tank's total Δv
    // (ARM_TOTAL_DELTAV 50 m/s → 2 %/m/s). A time-based rate capped any powered sortie at ~63 s to the reserve (630 m
    // @10 m/s) and billed a slow shot MORE than a fast one over the same ground. Coasting is free; the arrival kill is
    // the bill. Manual-pilot TRANSIT/APPROACH keeps the time-based rate (its thrust path meters no impulse: a recorded
    // split, not an oversight).
    if (this._powerOff()) {
      // a flat pack: no push, so no fuel spent and no engine billed (DECISIONS §53 row 3: no power, no thrust)
      this._impulseDvAccum = 0;
    } else if ((this.state === S.TRANSIT || this.state === S.APPROACH) && !this._manualMode) {
      const dvMps = this._impulseDvAccum;
      this._impulseDvAccum = 0;
      this.fuel -= (dvMps / (this.config.totalDeltaV || Constants.ARM_TOTAL_DELTAV)) * 100;
      if (dvMps > 0) this.power.markEngine();   // impulse-priced: a frame with a commanded impulse bills her engine's rating
    } else {
      this._impulseDvAccum = 0;
      this.fuel -= rate * dt;
      if (rate > 0) this.power.markEngine();
    }

    // Detached arm fuel warnings (no refuel possible)
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
          text: `CRITICAL: ${this.displayName} fuel at 10%.`,
          priority: 'critical',
        });
      }
    }

    // Emergency reserve: a TETHERED daughter never strands herself. She holds ARM_RESERVE_FUEL back so the mother can reel
    // her home under control (tether tension + soft-dock arrest). Hitting the reserve while working/flying means "no
    // usable propellant", but she is NOT lost: avionics/beacon stay live and she goes ADRIFT (recoverable, commandable on
    // the tether). Detached daughters have no winch: they fall through to the genuine-loss path below.
    const reserve = Constants.ARM_RESERVE_FUEL ?? 0;
    // reel-home: the line-up may spend the reserve (it is kept for a safe reel-home), so a daughter that docked on it and
    // holds her catch is a docked daughter, not an adrift one: she keeps HOLDING_CATCH, like DOCKING does.
    const dockedOnReserve = this.state === S.HOLDING_CATCH && Constants.isFeatureEnabled('REEL_HOME');
    if (!this.isDetached && reserve > 0 && this.fuel <= reserve && this.state !== S.ADRIFT) {
      if (this.state === S.RETURNING) {
        // Can't fly home on the reserve: hand off to the winch so the reserve survives for the soft-dock arrest.
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
        // Working daughter has spent her usable propellant: lock the reserve and go ADRIFT (tethered, powered,
        // recoverable). DOCKING is exempt: she may spend the reserve on the final arrest.
        this.fuel = reserve;
        this._enterAdrift();
        return;
      }
    }

    if (this.fuel <= 0) {
      this.fuel = 0;

      // Detached: no tether to winch home, genuinely lost.
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

      // Non-detached daughter that drained the reserve during the dock itself: the winch still eases her in (REDOCK_FEEP
      // FUEL_FALLBACK_SLOW). Hold at empty and let the dock finish on motor power.
      if (this.state === S.DOCKING || dockedOnReserve) return;

      // Any other state at true zero is spent.
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: FUEL DEPLETED. Daughter expended`,
        priority: 'critical',
      });
      eventBus.emit(Events.ARM_EXPENDED, { armId: this.id, type: this.type });
      this._transitionTo(S.EXPENDED);
    }
  }

  /**
   * @private Update tether visual between parent and arm. The mother-side anchor is the strut tip when Config G geometry
   * is available, else parentPos (mother center).
   * @param {THREE.Vector3} parentPos — mother world position
   * @param {THREE.Quaternion} [parentQuat] — mother world orientation (for strut tip calc)
   * @param {number} [dt] — frame delta (seconds) for REELING dash-flow animation
   */
  _updateTether(parentPos, parentQuat, dt) {
    // Remember the mother's orientation of the last frame she was out (the FAIL_REEL.AUTO_REEL_MAX_M rule measures to the live strut tip,
    // `_strutTipDistM`); one persistent quaternion, no allocation after the first frame.
    if (parentQuat) {
      (this._frameParentQuat || (this._frameParentQuat = new THREE.Quaternion())).copy(parentQuat);
    }
    // States where she is AT (or arriving at) her strut-tip dock: no tether renders (the cable spans ~0, and the
    // one-frame-stale counter-rotation flash, pose error near 180° at DOCKING entry, would read as a wrong-way tether).
    // _updateTether runs AFTER the per-state handler, so without this early-out it re-shows a stray tether for the whole
    // window.
    if (this.state === S.DOCKED || this.state === S.DOCKING ||
        this.state === S.RELOADING || this.state === S.HOLDING_CATCH ||
        this.state === S.CARRY_PREP) {                 // docked while the strut and radiators move
      // While the line is hidden, snap the tint home to NOMINAL, so a stressed reel-in tint does not persist across the
      // dock and re-appear, stale, on the next deploy.
      this.tetherMaterial.color.setHex(Constants.TETHER_COLOR_NOMINAL);
      this.tetherLine.visible = false;
      return;
    }
    if (this.isDetached) {
      this.tetherLine.visible = false;
      return;
    }

    if (this.state === S.EXPENDED) {
      this.tetherMaterial.opacity = 0.2;
    }
    this.tetherLine.visible = true;

    // Tint from the LIVE REEL TENSION fraction (tetherTensionTint): stable within a reel, zero outside one, so the line
    // eases through amber toward red exactly while the winch strains (an orbital-frame-jittery distance driver caused
    // red/white flashing).
    this._updateTetherTensionTint(dt);
    this.tetherMaterial.opacity = (this.state === S.EXPENDED) ? 0.2 : 0.9;

    // Mother-side anchor: strut tip via dockOffset (PlayerSatellite frame), else parentPos (bus center).
    let anchorPos = parentPos;
    if (this.dockOffset && parentQuat) {
      anchorPos = this.getTetherAnchorWorldPosition(parentPos, parentQuat);
    }

    // Catenary sag perpendicular to the tether. The line is a child of this.group (identity rotation, at this.position),
    // so vertex positions are GROUP-LOCAL (world offset by this.position); directions equal world directions.
    const posArr = this.tetherLine.geometry.attributes.position.array;
    const segments = Constants.TETHER_SEGMENTS;

    const dx = anchorPos.x - this.position.x;
    const dy = anchorPos.y - this.position.y;
    const dz = anchorPos.z - this.position.z;
    const separation = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (separation < Constants.TETHER_SAG_PARALLEL_THRESHOLD) {
      for (let i = 0; i < segments; i++) {
        const idx = i * 3;
        posArr[idx] = 0; posArr[idx + 1] = 0; posArr[idx + 2] = 0;
      }
      this.tetherLine.geometry.attributes.position.needsUpdate = true;
      return;
    }

    const tHatX = dx / separation;
    const tHatY = dy / separation;
    const tHatZ = dz / separation;

    // sag direction = world-down projected perpendicular to the tether: worldDown - (worldDown · tHat) * tHat
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

    if (sagMag > Constants.TETHER_SAG_PARALLEL_THRESHOLD) {
      sagX /= sagMag; sagY /= sagMag; sagZ /= sagMag;
    } else {
      sagX = 0; sagY = 0; sagZ = 0; // Truly degenerate — no sag
    }

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

    // REELING motion cue: a brightness pulse travels along the gradient toward the mother (anchor). Phase 1 → 0 maps
    // daughter → anchor.
    if (this.state === S.REELING && typeof dt === 'number' && dt > 0) {
      const _rs = (this.capturedDebris !== null
        ? REEL_IN_SPEED_LOADED : REEL_IN_SPEED_EMPTY);
      // Pulse speed: one traversal per (separation / reelSpeed) s, i.e. the pulse moves at the reel speed along the cable;
      // the minimum rate keeps it visible on very short tethers.
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

    // Tether vertices are offsets from arm.position, but the line is a child of arm.group, whose non-identity quaternion
    // (attitude control) would rotate them and make the tether "drift off parallel to mother". Counteract it so the tether
    // renders in world orientation.
    this.tetherLine.quaternion.copy(this.group.quaternion).invert();
  }

  /**
   * @private Ease the tether material color toward the tension-fraction tint (tetherTensionTint), called every frame
   * from _updateTether. Per-frame exponential ease (1 − e^(−dt/tau)), never a step, so a single-frame tension sample
   * only nudges the line a few percent toward red (the old strobe jumped whole bands per frame). Tension reads 0 outside
   * REELING, so the target is NOMINAL the moment the reel (or the mission-1 clamp) ends.
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

  /** @private Bridle visibility + color mirror the tether state. */
  _updateBridle() {
    if (!this._bridleLegA) return;
    const show = this.tetherLine && this.tetherLine.visible;
    // Hidden during the slack phase (first 0.3 m post-launch)
    const pastSlack = this.tetherLength > 0.3;
    const visible = show && pastSlack;
    this._bridleLegA.visible = visible;
    this._bridleLegB.visible = visible;
    // Gate the gimbal ring + hardpoints with the legs so the bridle hardware only appears while the tether/bridle is
    // deployed (they read as clutter floating on the docked body otherwise).
    if (this._gimbalRing) this._gimbalRing.visible = visible;
    if (this._bridleHpA) this._bridleHpA.visible = visible;
    if (this._bridleHpB) this._bridleHpB.visible = visible;
    if (visible && this._bridleLegMat && this.tetherMaterial) {
      this._bridleLegMat.color.copy(this.tetherMaterial.color);
      this._bridleLegMat.opacity = this.tetherMaterial.opacity;
    }
    // KNOWN: gimbal ring rotates with the daughter body (physically it should track the tether direction); acceptable at
    // gameplay distances.
  }

  /**
   * @private Thruster plume animation. The which-nozzle/how-bright decision lives in the PURE
   * `computeDaughterPlumeIntensity` (entities/armPlumeModel.js, Node-tested); this method only collects the live signals,
   * decays the visual timers and styles the two plume pairs. READ-ONLY on physics: state, fuel and the arrest flags are
   * inputs, never outputs.
   */
  _updatePlumes(dt) {
    // Decay the visual-only timers (latched by SK input / the recoil event).
    if (this._recoilFlashS > 0) this._recoilFlashS = Math.max(0, this._recoilFlashS - dt);
    if (this._skManeuverGlowS > 0) this._skManeuverGlowS = Math.max(0, this._skManeuverGlowS - dt);
    // The smoothed APPROACH brake read updates only inside _updateApproach: zero it in every other state so a stale value
    // can't leak into the next approach (or manual-mode coasting, which computes no thrust).
    if (this.state !== S.APPROACH) this._approachBrake01 = 0;

    const sig = _plumeSig;
    sig.state = this.state;
    sig.fuel = this.fuel;
    sig.skManeuverGlowS = this._skManeuverGlowS;
    sig.approachBrake01 = this._approachBrake01;
    // Funded arrest burn only: the FUEL_FALLBACK_SLOW winch finish and the tether-fouls-plume hold must NOT flare (no
    // debit, no burn).
    sig.reelHome = this._rhOn();
    sig.arrestFeepActive = (this._redockArrestStarted === true && this._redockDebitApplied === true)
      || !!this._rhLineUp;                // reel-home line-up: her own thrusters (shown fore; she moves sideways, no nozzle is axial to that)
    sig.recoilFlashS = this._recoilFlashS;
    // which nozzle carries the ion thread on a carry leg (the clamp hold and the other states: none)
    sig.carryNozzle = (this.state === S.CARRY_OUT || this.state === S.CARRY_BACK) ? this._carryThread : null;
    const vis = computeDaughterPlumeIntensity(sig);

    // Frame-rate-independent shimmer (two sines, ±~5%), shared by both nozzles; ion emission is steady (no random flicker).
    const t = Date.now() * 0.001;
    const shimmer = 1 + 0.035 * Math.sin(t * 6.7) + 0.02 * Math.sin(t * 12.1);
    this._stylePlumePair(this._thrusterPlumes, this._plumeHalo, vis.aft, shimmer);
    this._stylePlumePair(this._forePlumes, this._forePlumeHalo, vis.fore, shimmer);
  }

  /**
   * @private Apply one intensity to one core+halo plume pair. At intensity 1 this reproduces the legacy transit look
   * (core 0.6 / halo 0.24, length 0.85×shimmer); lower intensities read as a shorter, fainter thread. Intensity ≤ 0
   * hides the pair (visible=false: zero render cost when dark).
   * @param {THREE.Mesh[]} plumes  core+halo list
   * @param {THREE.Mesh|null} halo the halo member (dims to HALO_MULT × core)
   * @param {number} intensity 0..1
   * @param {number} shimmer  length shimmer factor (~±5%)
   */
  _stylePlumePair(plumes, halo, intensity, shimmer) {
    const P = DAUGHTER_PLUME;
    const on = intensity > 0.001;
    const lenS = P.BASE_LEN_SCALE * shimmer
      * (lerp(P.MIN_LEN_SCALE, 1, intensity));
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

  /** @private Mirror the status-light core colour onto its additive halo (×HDR) so the glow follows the blink. */
  _syncStatusHalo() {
    const halo = this._statusLightHalo;
    if (!halo) return;
    halo.material.color.copy(this._statusLightMat.color).multiplyScalar(1.8);
  }

  /**
   * Mark this daughter as the selected plate so its body glows/flashes (called by ArmManager on ARM_SELECT/ARM_DESELECT).
   * The pulse itself runs every frame in _updateSelectGlow(); this flips the flag and restores the base emissive on
   * deselect at once, so a non-updating (e.g. paused) frame doesn't leave the arm stuck lit.
   * @param {boolean} on
   */
  setSelectedHighlight(on) {
    const next = !!on;
    if (next === this._selected) return;
    this._selected = next;
    if (!next) this._restoreSelectGlow();
  }

  _restoreSelectGlow() {
    for (const e of this._selectGlowMats) {
      e.mat.emissive.setHex(e.baseEmissive);
      e.mat.emissiveIntensity = e.baseIntensity;
    }
  }

  /**
   * @private Pulse the body facet emissive while selected: a cyan flash modulates emissiveIntensity above the base so the
   * selected daughter "breathes", readable on a docked plate while the mother stays in view.
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

  // CAPTURE NET INVENTORY (CAPTURE_NET.md §6.1): weaver = Medium Net (Large Daughter, magazine 4: four 3 m nets),
  // spinner = Small Net (Small Daughter, magazine 4). Gated by FEATURE_FLAGS.CAPTURE_NET; when OFF inventory stays 0.

  /** Initialise net inventory from CAPTURE_NET constants for this arm's type (called by CaptureNetSystem.init() or ArmManager). */
  initNetInventory() {
    if (!Constants.isFeatureEnabled('CAPTURE_NET')) return;
    const type = this.config.type;
    const netClass = type === 'weaver' ? Constants.CAPTURE_NET.MEDIUM : Constants.CAPTURE_NET.SMALL;
    // Capacity comes from the net class's MAGAZINE_SIZE; ARM_NET_CAPACITY mirrors it (drift-guard test), so MAGAZINE_SIZE
    // stays authoritative.
    const capacity = (netClass && netClass.MAGAZINE_SIZE) ?? Constants.ARM_NET_CAPACITY[type] ?? 0;
    this._netInventoryMax = capacity;
    this._netInventory = capacity;
    this._netRatedMass = (netClass && netClass.MAX_CAPTURE_MASS) || 0;
    this._netDiameter = (netClass && netClass.DIAMETER) || 0;
    // Seeds the magazine WITHOUT emitting (and runs after construction), so event-only caps would start stale: sync directly.
    this._syncNetCells(this._netInventory);
  }

  /**
   * @private Draw the can's front-face cells: one dark bore and one pale cap per net, from netCellLayout(n, can radius -
   * 3 mm, 2 mm gap): bore r = cell outer - 2 mm, cap r = 0.9 x bore. Large can 4 / 6 / 8 / 10 bores (r 0.0181 .. 0.0100 m),
   * small 4 / 6 / 8 / 10 (r 0.0098 .. 0.0049 m). The radius, face, disc and lip do not move.
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
   * Show exactly `n` loaded Dyneema caps on the launcher's front face (empty cells show only the dark bore). Direct
   * (no-emit) helper called from the inventory listener AND initNetInventory(). @private
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

  getNetInventory() { return this._netInventory; }

  getNetInventoryMax() { return this._netInventoryMax; }

  /**
   * Set net inventory directly (persistence restore / shop reload). Emits NET_INVENTORY_CHANGED so dependent HUD panels
   * stay in sync when the count is adjusted outside CaptureNet's own fire/reload path.
   * @param {number} count
   */
  setNetInventory(count) {
    this._netInventory = clamp(this._netInventoryMax || count, 0, count);
    eventBus.emit(Events.NET_INVENTORY_CHANGED, {
      source: 'daughter',
      armIndex: this.index ?? null,
      nets: this._netInventory,
      max:  this._netInventoryMax,
    });
  }

  /**
   * Consume one net from the magazine. Emits NET_INVENTORY_CHANGED so NetInventoryPanel updates at any decrement point,
   * even if CaptureNet also emits (the panel re-polls idempotently: the second signal is a cheap no-op).
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

  /** Reload magazine to full capacity (shop / between missions); emits NET_INVENTORY_CHANGED so the HUD chip updates. */
  reloadNetInventory() {
    this._netInventory = this._netInventoryMax;
    eventBus.emit(Events.NET_INVENTORY_CHANGED, {
      source: 'daughter',
      armIndex: this.index ?? null,
      nets: this._netInventory,
      max:  this._netInventoryMax,
    });
  }

  dispose() {
    // Arms are NOT session singletons (unlike the mother): unsubscribe the net inventory listener so disposed arms don't
    // leak / react to stale emits.
    if (this._onNetInventoryChanged) {
      eventBus.off(Events.NET_INVENTORY_CHANGED, this._onNetInventoryChanged);
      this._onNetInventoryChanged = null;
    }
    // The recoil-kick flash listener is registered only when the event name exists (defensive wiring): mirror that on teardown.
    if (this._onRecoilKick) {
      eventBus.off(Events.ARM_RECOIL_KICK, this._onRecoilKick);
      this._onRecoilKick = null;
    }
    const disposeMat = (m) => {
      if (!m) return;
      // Dispose per-instance textures (e.g. cloned solar-cell map/emissiveMap): material.dispose() does NOT free attached textures.
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
