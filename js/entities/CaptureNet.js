/**
 * CaptureNet.js — Capture Net Projectile + System Manager (net capture cycle per CAPTURE_NET.md):
 * deploy and flight, catch and tangle quality, reel-in and tension, stow and cargo hand-off, HUD indicators.
 *
 * All behavior gated behind FEATURE_FLAGS.CAPTURE_NET (default false).
 *
 * @module entities/CaptureNet
 */

import { Constants } from '../core/Constants.js';
import { TimeAuthority } from '../systems/TimeAuthority.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { DebrisField } from './DebrisField.js';
import { DebrisWireframe } from '../ui/DebrisWireframe.js';
import { CeremonyTimeScale } from '../systems/CeremonyTimeScale.js';
import { reseatOrbitFromScene, orbitToSceneCartesianInto } from './OrbitalMechanics.js';
import { strutTipFoulsCorridor } from './ArmDockBasis.js';
// CUT_AT_NOSE: the pure planner, called ONCE when a collared catch is over the hand-off gate.
import { planCuts } from '../systems/cutPlanner.js';
import { OUT_OF_MOTHER_NETS_LINE, ONE_MOTHER_NET_LEFT_LINE, targetRangeM, netMaxReachM } from '../systems/netRouting.js';
export { netMaxReachM };   // lives in netRouting.js: the reticle reads it without this module
// The carrier scorer lives with the CoM maths (ONE computation: it reuses computeCoM/strutTipMeters).
import { suggestCargoArm, countEmptyDockedDaughters, heldCargoFoulsCorridorAt } from '../systems/CoMCalculator.js';
import { tripRefuses, tripLeashRefuses } from '../systems/TransferTrip.js';
import { heldBagNeckInto, heldBagRadiusScene, DAUGHTER_STAND_M } from './heldBagShape.js';
import { pickScoopMembers, scoopLine } from './scoopRule.js';
// A pending BIG piece (counted at the catch, pays when disposed of) is never let go by K, never auto-cut,
// and says its own collar line. Looked up by id: a net may hold a snapshot of the field's body.
import { bigPieces, pieceName } from '../systems/BigPieces.js';
import * as THREE from 'three';
import { RAD2DEG, degToRad, clamp01, clamp, lerp } from '../core/MathUtil.js';

const _heldNeck = { x: 0, y: 0, z: 0 };   // scratch: a daughter's held-net neck (scene units)

const CN = Constants.CAPTURE_NET;
const STATES = CN.STATES;
const MODES = CN.MODES;
// Cargo hand-off tuning. A live object reference like CN, so a test that retunes a key is seen immediately.
const CT = CN.CARGO_TRANSFER || {};
const FEATURE_FLAGS = Constants.FEATURE_FLAGS;
// owner 2026-10-18: a new catch is refused while the nose holds one that has nowhere to go. Nothing is unloaded by a
// station (owner 2026-10-19): a catch that fits a tip goes to a furnace on the trip to the next field.
const NOSE_FULL_LINE = 'Nose is full: this catch has nowhere to go yet. '
  + 'It stays at the collar and goes to a furnace on the trip to the next field if it fits one. Press K to let it go.';
// The same refusal while a cut is paused at the nose for want of an empty daughter.
// "Press K to let it go." is the sentence the touch wording knows (GestureHints GLASS_LINES / chipPhrase): any other tail
// would name a key on glass.
const NOSE_FULL_CUT_LINE = 'Nose is full: the cut catch has pieces that still need an empty daughter. Press K to let it go.';

// Scratch for the mother reel/berth per-frame math: that path must not allocate per frame (use the Into accessors).
const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _v3c = new THREE.Vector3();
const _v3d = new THREE.Vector3();
const _v3e = new THREE.Vector3();
const _v3g = new THREE.Vector3();
/** Berth anchor in ship-local metres, refilled per _corridorClear call. */
const _anchorLocal = { x: 0, y: 0, z: 0 };

/**
 * The ONE berth anchor in ship-local metres: the collar object, ON the axis at (0, 0, BERTH_COLLAR_Z_M), read from the anchor
 * Object3D when the real ship is present, falling back to the launcher muzzle local (headless mocks without the collar anchor) and then to
 * the documented constant. `_corridorClear` and ArmManager's holder duck read it here, so they cannot disagree.
 * @param {object|null} player
 * @param {number} podIndex
 * @param {{x:number,y:number,z:number}} out
 * @returns {{x:number,y:number,z:number}} out
 */
export function berthAnchorLocalInto(player, podIndex, out) {
  const M_NET = Constants.SCENE_UNITS_PER_METER;
  const a = player && (player._netBerthCollar ?? player._netPodMuzzles?.[podIndex] ?? player._netPodMuzzles?.[0]);
  out.x = a ? a.position.x / M_NET : 0;
  out.y = a ? a.position.y / M_NET : 0;
  out.z = a ? a.position.z / M_NET : (Constants.OCTOPUS_V5?.BERTH_COLLAR_Z_M ?? 1.30);
  return out;
}
const _q0  = new THREE.Quaternion();
const _q1  = new THREE.Quaternion();
// Per-frame scratch (no allocation): cargo hand-off transfer beat; CUT_AT_NOSE waiting-piece pin (every COLLARED frame);
// catch/ship velocity sampling at CAPTURED (tug); held-catch attitude + ship pose (cargo flight, rack pin).
const _v3f = new THREE.Vector3();
const _v3cut = new THREE.Vector3();
const _tugScratchPos = { x: 0, y: 0, z: 0 };
const _tugScratchVel = { x: 0, y: 0, z: 0 };
const _qCatchPose = new THREE.Quaternion();
const _qShip = new THREE.Quaternion();
const _qShipInv = new THREE.Quaternion();
const _vShipPos = new THREE.Vector3();

// Held-catch attitude in the SHIP's frame. A catch held rigidly by the ship (collar, cargo flight, a docked daughter's
// rack) turns WITH the ship — DECISIONS Ruling 0, physically real. The nose hold does it through `NetProjectile._qLocal`;
// the cargo flight hands the ship-relative attitude to the daughter's rack on arrival as
// `d._qLocalShip` (a THREE.Quaternion = shipQuat⁻¹ × catchQuat). The rack pin (`ArmUnit._pinHeldCatches`) writes
// shipQuat × `_qLocalShip` back into the catch's `tumbleAxis`/`tumbleAngle`, which `DebrisField.pinCapturedDebris` reads
// for the drawn instance (a debris has no quaternion field). Every helper is a quiet no-op when the catch has no
// `tumbleAxis` or the quaternion is absent (test stubs, early boot).

/**
 * The catch's attitude (tumbleAxis/tumbleAngle) as a quaternion.
 * @param {object} d — debris
 * @param {THREE.Quaternion} out
 * @returns {boolean} false when the catch carries no tumbleAxis
 */
export function catchQuaternionInto(d, out) {
  const ax = d && d.tumbleAxis;
  if (!ax) return false;
  out.setFromAxisAngle(ax, d.tumbleAngle || 0);
  return true;
}

/**
 * The field's canonical debris for `d` when it is a different object (a
 * snapshot), else null. Defaults to the capture system's own field.
 * @param {object} d
 * @param {object|null} [debrisField]
 * @returns {object|null}
 */
function canonicalOf(d, debrisField = null) {
  const f = debrisField || (captureNetSystem && captureNetSystem._debrisField);
  if (!f || !d || d.id == null || typeof f.getDebrisById !== 'function') return null;
  const c = f.getDebrisById(d.id);
  return (c && c !== d && c.tumbleAxis) ? c : null;
}

/**
 * Copy the catch's attitude onto the object DebrisField actually DRAWS.
 *
 * A lasso / net catch is a shallow SNAPSHOT of the field's debris (`net.targetDebris !== debrisMap.get(id)`; it
 * shares only the `tumbleAxis` Vector3 and owns its own `tumbleAngle` number). `pinCapturedDebris` reads
 * `canonical.tumbleAxis` + `canonical.tumbleAngle`, so an attitude written only onto the snapshot reaches the screen as
 * (new axis, STALE angle) and the catch looks frozen while the ship turns. Mirror the pair onto the canonical object
 * by id; a no-op when the catch IS canonical or no field is reachable (tests, early boot).
 * @param {object} d — the catch whose tumbleAxis/tumbleAngle were just written
 * @param {object|null} [debrisField] — defaults to the capture system's field
 */
export function mirrorCatchAttitude(d, debrisField = null) {
  const c = canonicalOf(d, debrisField);
  if (!c) return;
  const a = d.tumbleAxis;
  if (c.tumbleAxis !== a) {
    if (typeof c.tumbleAxis.set === 'function') c.tumbleAxis.set(a.x, a.y, a.z);
    else { c.tumbleAxis.x = a.x; c.tumbleAxis.y = a.y; c.tumbleAxis.z = a.z; }
  }
  c.tumbleAngle = d.tumbleAngle;
}

/**
 * Write a quaternion back into the catch's tumbleAxis/tumbleAngle (the decomposition
 * `NetProjectile._applyCatchOrientation` uses) and mirror it onto the drawn (canonical) object.
 * @param {object} d — debris with a tumbleAxis
 * @param {THREE.Quaternion} q
 * @param {object|null} [debrisField]
 */
export function writeCatchAttitude(d, q, debrisField = null) {
  const w = clamp(q.w, -1, 1);
  const angle = 2 * Math.acos(w);
  const s = Math.sqrt(Math.max(0, 1 - w * w));
  const ax = d.tumbleAxis;
  let x = 0, y = 1, z = 0;
  if (s > 1e-6) { x = q.x / s; y = q.y / s; z = q.z / s; }
  if (typeof ax.set === 'function') ax.set(x, y, z);
  else { ax.x = x; ax.y = y; ax.z = z; }
  d.tumbleAngle = angle;
  mirrorCatchAttitude(d, debrisField);
}

/**
 * Record the catch's CURRENT attitude relative to the ship: `d._qLocalShip = shipQuat⁻¹ × catchQuat`.
 * Always overwrites (the caller decides when a hand-off or a fresh stow is happening).
 * @param {object} d — debris
 * @param {{x:number,y:number,z:number,w:number}|null} shipQuat
 * @param {object|null} [debrisField] — resolves the canonical (drawn) object
 * @returns {boolean} true when seeded
 */
export function seedShipRelativeAttitude(d, shipQuat, debrisField = null) {
  if (!d || !shipQuat || !d.tumbleAxis) return false;
  // Seed from what is DRAWN (the canonical object when `d` is a snapshot).
  catchQuaternionInto(canonicalOf(d, debrisField) || d, _qCatchPose);
  const q = d._qLocalShip || (d._qLocalShip = new THREE.Quaternion());
  q.copy(shipQuat).invert().multiply(_qCatchPose);
  return true;
}

/**
 * Turn the catch with the ship: write `shipQuat × d._qLocalShip` into
 * tumbleAxis/tumbleAngle. Does nothing when the catch has no `_qLocalShip`,
 * no tumbleAxis, or the quaternion is absent.
 * @param {object} d — debris
 * @param {{x:number,y:number,z:number,w:number}|null} shipQuat
 * @param {object|null} [debrisField]
 * @returns {boolean} true when written
 */
export function applyShipRelativeAttitude(d, shipQuat, debrisField = null) {
  if (!d || !shipQuat || !d._qLocalShip || !d.tumbleAxis) return false;
  _qCatchPose.copy(shipQuat).multiply(d._qLocalShip);
  writeCatchAttitude(d, _qCatchPose, debrisField);
  return true;
}

/** Forget the ship-relative attitude (release / jettison / digestion). */
export function clearShipRelativeAttitude(d) {
  if (d) d._qLocalShip = null;
}

// A rack cell is a place on HER body. A catch parked on a daughter's cargo rack is rigid in HER body frame from the moment
// its cell is assigned: `d._rackCell` (0|1), `d._rackLocalM` (centre, her frame, metres), `d._qLocalHer` (her⁻¹ × the
// catch's attitude) and `d._rackArm` (the daughter who owns the cell; a cargo flight assigns at its start, the stow keeps
// it). Turning the ship or swinging her strut carries the catch with her; world up plays no part. The tip bags and every
// other user of `applyShipRelativeAttitude` keep the ship-relative form above.

/**
 * Record the catch's CURRENT drawn attitude relative to the daughter: `d._qLocalHer = herQuat⁻¹ × catchQuat`
 * (identity for a catch with no tumbleAxis). Always overwrites.
 * @param {object} d — debris
 * @param {{x:number,y:number,z:number,w:number}|null} herQuat — her WORLD attitude (mother quaternion × docked basis)
 * @param {object|null} [debrisField] — resolves the canonical (drawn) object
 * @returns {boolean} true when seeded from a real attitude
 */
export function seedHerFrameAttitude(d, herQuat, debrisField = null) {
  if (!d) return false;
  const q = d._qLocalHer || (d._qLocalHer = new THREE.Quaternion());
  if (!herQuat || !d.tumbleAxis) { q.identity(); return false; }
  catchQuaternionInto(canonicalOf(d, debrisField) || d, _qCatchPose);
  q.copy(herQuat).invert().multiply(_qCatchPose);
  return true;
}

/**
 * Turn the catch with her: write `herQuat × d._qLocalHer` into tumbleAxis/tumbleAngle (and mirror it onto the drawn
 * object). Does nothing without a stored `_qLocalHer`, a tumbleAxis or a quaternion.
 * @param {object} d — debris
 * @param {{x:number,y:number,z:number,w:number}|null} herQuat — her WORLD attitude
 * @param {object|null} [debrisField]
 * @returns {boolean} true when written
 */
export function applyHerFrameAttitude(d, herQuat, debrisField = null) {
  if (!d || !herQuat || !d._qLocalHer || !d.tumbleAxis) return false;
  _qCatchPose.copy(herQuat).multiply(d._qLocalHer);
  writeCatchAttitude(d, _qCatchPose, debrisField);
  return true;
}

/** The catch leaves her rack (release / jettison / drop / unload / digestion): forget its cell. */
export function clearRackCell(d) {
  if (!d) return;
  d._rackCell = null;
  d._rackLocalM = null;
  d._qLocalHer = null;
  d._rackArm = null;
  d._rackBelow = null;     // the cell-0 piece cell 1 was placed on (ArmUnit._assignRackCellWith)
  d._rackSlide = null;     // a running cell-1 → cell-0 slide (ArmUnit._lowerRackCell)
  d._rackFromMotherNet = false;   // and the mark that the mother's net put it there
  d._wingClear = null;            // its radiator-wing profile was for that cell and attitude
}

/**
 * The ship's live pose for the cargo arcs: position (scene units) into `outPos`, orientation into `outQuat`.
 * False when the player cannot supply both (the caller keeps the frozen world-frame behaviour; never throws).
 * @param {object|null} player
 * @param {THREE.Vector3} outPos
 * @param {THREE.Quaternion} outQuat
 * @returns {boolean}
 */
function readShipPose(player, outPos, outQuat) {
  if (!player || !player.quaternion) return false;
  const p = typeof player.getPosition === 'function' ? player.getPosition() : player.position;
  if (!p || !Number.isFinite(p.x)) return false;
  outPos.set(p.x, p.y, p.z);
  outQuat.copy(player.quaternion);
  return true;
}

/** Base capture-tension readout (N); HUD-facing garnish only. */
function baseCaptureTensionN(capturedMass) {
  return 1.0 + capturedMass * 0.1;
}

/**
 * Drop a tether-snapped runaway's stale claim when a mother-side capture path takes ownership. A tether snap leaves the
 * runaway re-targetable (`_captured = false`) but back-referenced by the EXPENDED arm's `_severedCatch`, which re-pins
 * it to the drifting daughter every frame until TETHER_SNAP_RELEASE_DELAY_S releases it (ArmUnit._updateExpended) and
 * would otherwise fire that release on the NEW owner's held catch. The `_updateExpended` re-capture guard checks only
 * `_capturedByArm !== this`, which a DAUGHTER re-capture satisfies (pinned: test-ArmUnit-CaptureFailure) but the
 * mother/lasso paths never write `_capturedByArm`. So `_enterMotherReel` / `adoptLassoCatch` call this once ownership is
 * certain (past the entry/adoption refusal gates): the arm-side claim AND the debris-side back-reference both clear,
 * the latter so a later [K] jettison can't re-pin the freed piece to the long-gone drifter (DebrisField's `_pinToArm`
 * branch passes EXPENDED in its state filter). Null-safe: a fresh catch (`_capturedByArm` unset) is a no-op.
 * @param {object|null} d — the debris being captured
 */
function dropSeveredCatchClaim(d) {
  const severedOwner = d && d._capturedByArm;
  if (severedOwner && severedOwner._severedCatch === d) {
    severedOwner._severedCatch = null;
    d._capturedByArm = null;
  }
}

/**
 * ONE fore-extent read for the collar queue, shared by both consumers (the lasso pend's `getCollarQueueDepthM` and the
 * corridor gate's `_queueHoldLevelM`): how far a mother net's catch reaches fore of the berth anchor, in metres —
 * apex + seat + half, where the apex is the net's true station level:
 *   - a corridor-held REELING net: its frozen `_corridorHoldLevelM` slot (the REELING guard keeps a stale hold flag from
 *     a MISSED net from counting);
 *   - a berthed/collared/transferring net: `max(base, _effectiveStandoffM)` — extended-standoff honest;
 *   - anything else (inbound, missed): the base standoff — an inbound net reserves its eventual berth footprint
 *     (conservative).
 * `atStation` is the corridor gate's queue membership (held or berthed — an inbound net takes its slot when its own
 * gate engages); the lasso pend counts every member at its level.
 * Fills the module scratch (the reel/berth path must not allocate per frame); the returned primitives are copied by
 * destructuring at the call site, and the helper calls nothing that could re-enter it.
 * @param {object} net — a mother NetProjectile with a live targetDebris
 * @returns {{fore: number, atStation: boolean}} the shared scratch
 */
const _foreExtent74 = { fore: 0, atStation: false };
function motherNetForeExtentM(net) {
  const d = net.targetDebris;
  const half = (d.sizeMeter || 2) / 2;
  // The berth footprint is HOME (bag mouth at the ring, catch seated on it). `_homeApexM`/`_homeSeatM` are seeded at reel
  // entry (null before: the size/2 + 1.0 m standoff).
  const base = net._homeApexM ?? (half + (CN.BERTH_CLEARANCE_M ?? 1.0));
  const held = net.state === STATES.REELING
    && net._corridorHold && net._corridorHoldLevelM != null;
  const berthed = net.state === STATES.BERTHED || net.state === STATES.COLLARED
    || net.state === STATES.TRANSFERRING;
  const apex = held
    ? net._corridorHoldLevelM
    : berthed ? Math.max(base, net._effectiveStandoffM ?? base) : base;
  // held/berthed read the live seat; an inbound net reserves its eventual footprint (the home seat)
  const seat = (held || berthed) ? (net._catchSeatM || 0) : (net._homeSeatM ?? net._catchSeatM ?? 0);
  _foreExtent74.fore = apex + seat + half;
  _foreExtent74.atStation = held || berthed;
  return _foreExtent74;
}

// The catch's HOME on the collar axis.

const _homeScratchC = [0, 0, 0];
const _homeIgnore = ['BerthCollar', 'BerthFace', 'nose catch'];
const _homeOpts = { ignore: _homeIgnore };

// The corridor gate's keep-out read: the capsule's two ends (ship-local metres), the query options
// and the ignore list (every keep-out category EXCEPT the radiators 'rad'; tip bags are catch spheres, never ignored).
const _corrA = [0, 0, 0];
const _corrB = [0, 0, 0];
const _corrOpts = { ignore: null, hits: true, margin: 0 };
let _corrIgnore = null;
let _corrIgnoreN = -1;
let _corrKeepOutWarned = false;
function corridorIgnoreList(armCount) {
  if (_corrIgnoreN !== armCount) {
    const l = ['hull', 'wing', 'nose', 'nose catch'];
    for (let i = 0; i < armCount; i++) l.push('strut' + i, 'dau' + i);
    _corrIgnore = l; _corrIgnoreN = armCount;
  }
  return _corrIgnore;
}

/**
 * The catch's home z (ship-local metres, on the collar axis) for a bag of radius `r`:
 * `max(RING_TOUCH_Z_M + r, clearZ(r))`, clearZ = the smallest bag-centre z that clears every ship part by
 * CLEARANCE_M, walking DOWN the axis from `top = max(SEARCH_TOP_Z_M, touchZ + MAX_ABOVE_TOUCH_M)` (so a part higher
 * up the axis is seen, and a big bag whose ring-touch z is above SEARCH_TOP_Z_M still gets its walk: r <= 1.18 m
 * keeps top = SEARCH_TOP_Z_M), bisected to BISECT_M. BerthCollar*, BerthFace* and the held-catch obstacle 'nose
 * catch' are ignored (the ring is what the catch seats on; the catch must not block itself). With no keep-out (mock
 * ships) the answer is ring-touch. If the sphere at `top` is itself blocked there is no clear z to walk from: the
 * answer stays ring-touch but is marked `unchecked` (with the blocking part's name in `blocker`) — never a silent
 * skip; `catchHomeDistM` reports it.
 * @param {object|null} keepOut — ShipKeepOut (`sphere(c, r, opts)`), or null
 * @param {number} r — bag radius, metres
 * @returns {{z:number, touchZ:number, clearZ:number|null, queryMs:number, queries:number, unchecked?:boolean, top?:number, blocker?:string}}
 */
export function catchHomeZ(keepOut, r) {
  const H = CN.REEL_HOME;
  const touchZ = H.RING_TOUCH_Z_M + r;
  const out = { z: touchZ, touchZ, clearZ: null, queryMs: 0, queries: 0 };
  if (!keepOut || typeof keepOut.sphere !== 'function') return out;
  const top = Math.max(H.SEARCH_TOP_Z_M, touchZ + H.MAX_ABOVE_TOUCH_M);
  let topPart = '';
  const clearAt = (z) => {
    _homeScratchC[2] = z;
    out.queries++;
    const g = keepOut.sphere(_homeScratchC, r, _homeOpts);
    if (z === top) topPart = g.name || '';
    return g.gap >= H.CLEARANCE_M - 1e-9;
  };
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  try {
    let lastClear = null, firstBlocked = null;
    if (clearAt(top)) {
      lastClear = top;
      for (let z = top - H.SEARCH_STEP_M; z >= touchZ - 1e-9; z -= H.SEARCH_STEP_M) {
        if (clearAt(z)) lastClear = z; else { firstBlocked = z; break; }
      }
      if (firstBlocked === null) {
        // clear all the way to ring-touch: nothing above it limits the home
        if (!clearAt(touchZ)) firstBlocked = touchZ; else lastClear = touchZ;
      }
      if (firstBlocked !== null) {
        let lo = firstBlocked, hi = lastClear;       // lo blocked, hi clear
        while (hi - lo > H.BISECT_M) {
          const mid = 0.5 * (hi + lo);
          if (clearAt(mid)) hi = mid; else lo = mid;
        }
        out.clearZ = hi;
      } else {
        out.clearZ = lastClear;
      }
    } else {
      // The top of the window is itself blocked: nothing above it to walk down from. Keep the ring-touch z, but say so.
      out.unchecked = true; out.top = top; out.blocker = topPart;
    }
  } catch (_e) { out.clearZ = null; out.unchecked = true; out.top = top; out.blocker = 'keep-out query failed'; }
  out.queryMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  if (out.clearZ !== null && out.clearZ - touchZ <= H.MAX_ABOVE_TOUCH_M + 1e-9) out.z = Math.max(touchZ, out.clearZ);
  else if (out.clearZ !== null) {
    // Only reachable for r < 1.18 (top = SEARCH_TOP_Z_M > touchZ + MAX_ABOVE_TOUCH_M): a clear z this far above
    // ring-touch is a bad query, so the ring-touch z is kept — flagged, like every other unchecked home.
    out.unchecked = true; out.top = top; out.blocker = 'clear z more than MAX_ABOVE_TOUCH_M above ring-touch';
  }
  return out;
}

/**
 * The largest drawn reach (m) a catch is still seated by: the same limit as TipCargo.MAX_BAG_R_M (a tip takes a bag up
 * to 0.75 m). Mirrored here, not imported: TipCargo imports CaptureNet (a cycle); test-HomeSeatTrueReach pins the two equal.
 */
export const TIP_HOME_MAX_REACH_M = 0.75;

/**
 * What, besides a catch's radius and the collar's z, sets its home: the radiators' angle and the bags on the tips
 * (`ArmManager.getKeepOut` reads both; a bag moves with its radiator). A string that changes when either does (angle to
 * 0.001 deg, each bag's index, radius and centre to 1 mm), `''` for a ship with no radiators or a mock, and `null` while the
 * radiators are SWINGING or ANY tip bag is turning onto its boom (`tipCargo.isSwinging(i)`): a home read then is not
 * trusted once the swing ends (`catchHomeDistM` recomputes on the first read after), and a read during the swing reuses
 * what is cached rather than paying a recompute (25-115 ms: 47-62 keep-out queries, measured) every frame the HUD polls.
 * The daughters' strut poses are left out on purpose: the nose route is flown, and certified, against the seat of the
 * ship with its struts parked, and a strut that swings during the flight must not move the seat she is flying to.
 * @param {object|null} player PlayerSatellite
 * @returns {string|null}
 */
export function homeShapeKey(player) {
  if (!player || typeof player._flowerThetaRad !== 'number') return '';
  const tgt = player._flowerTargetTheta;
  if ((typeof tgt === 'number' && Math.abs(tgt - player._flowerThetaRad) > 1e-4) || player.flowerPetalsBusy === true) return null;
  const tc = player.tipCargo;
  // a bag turning onto its boom (SWING_RATE_DEG_S = 20 deg/s, at most 9 s) moves every frame, so its centre would change the key every frame
  // (780 recomputes of ~25 ms in 13 s of one swing). Same rule as a radiator swing: reuse the cache, recompute once it ends.
  if (tc && typeof tc.isSwinging === 'function') for (let i = 0; i < 4; i++) if (tc.isSwinging(i)) return null;
  let key = String(Math.round(player._flowerThetaRad * RAD2DEG * 1000));
  if (tc && typeof tc.count === 'function' && typeof tc.spheres === 'function' && tc.count() > 0) {
    for (const sp of tc.spheres()) key += `|${sp.name}:${Math.round(sp.r * 1000)}:${Math.round(sp.c.x * 1000)},${Math.round(sp.c.y * 1000)},${Math.round(sp.c.z * 1000)}`;
  }
  return key;
}

/**
 * Home distance (metres) of a catch's CENTRE from the berth anchor (the collar plane) along the collar axis.
 * Cached on the debris per radius AND per ship shape (`_homeCache`, `homeShapeKey`): the home is read off the keep-out,
 * which holds the radiators and the bags on their tips, so a cache made for another radiator angle or another set of tip
 * bags is not read (a bag seated at 140°, the radiators then closed over it, and the nose seat stayed at its open-angle
 * z 1.64 m while the closed bag sat at 1.74 m: the leash snagged it; a fresh seat is z 2.20 m).
 * On the 2.30 m radiators the answer is the same at every radiator angle for r <= 1.4 m with no bag on a tip (measured
 * at every whole degree 0-180°: `REEL_HOME.ALL_ANGLE_HOME.angleFreeMaxR`), so there it is the current-pose
 * home (`catchHomeZ`). A bigger catch's current-pose home moves with the angle (r 4.0: 5.349 at
 * 146°, 5.402 at 3°) and a catch parked at the 146° one fouls the tip cone when the radiators then close (-32.4 mm
 * at 3°), so above `angleFreeMaxR` the home is the HIGHER of the current-pose home and the measured every-angle one:
 * `RING_TOUCH_Z_M + r + lift(r)`, lift linear between the two bracketing `ALL_ANGLE_HOME` rows. The table term applies
 * only when there is a keep-out and the current-pose home was checked (a mock armManager keeps ring-touch, no
 * warning); `_homeCache.allAngleLiftM` is the lift used (null when no term). A radius above the last row has no
 * measurement: the current-pose home is kept, marked `unchecked` (`blocker: 'radius above ALL_ANGLE_HOME'`, `top:
 * null`) and warned once. The reel's corridor gate (`_corridorClear`, the keep-out read) still catches radiators
 * moved onto a home with tip bags or held catches the bare-ship table does not know. A home that could not be
 * checked (`source: 'unchecked'`, see `catchHomeZ`) is logged once per catch with console.warn.
 * @param {object} player — PlayerSatellite (collar anchor z)
 * @param {object|null} armManager — for `getKeepOut()`
 * @param {object} d — the catch (sizeMeter, type, id). The seating radius is its drawn reach (`DebrisField.trueReachM`) when that
 *   is <= TIP_HOME_MAX_REACH_M (a tip takes it), else `sizeMeter / 2` (typeless pieces: the same number).
 * @returns {number} metres from the berth anchor
 */
export function catchHomeDistM(player, armManager, d) {
  // The seating radius is the drawn reach (DebrisField.trueReachM, the tip hand-off's bag radius) when it fits a tip
  // (<= TIP_HOME_MAX_REACH_M); a bigger catch keeps sizeMeter / 2, because its drawn reach would run past the measured
  // ALL_ANGLE_HOME rows. A typeless piece has trueReachM = sizeMeter / 2.
  const nominalR = (d && d.sizeMeter ? d.sizeMeter : 2) / 2;
  const reachR = DebrisField.trueReachM(d, 2);
  const r = reachR <= TIP_HOME_MAX_REACH_M + 1e-9 ? reachR : nominalR;
  const M = Constants.SCENE_UNITS_PER_METER;
  const V5 = Constants.OCTOPUS_V5;
  const anchorZ = (player && player._netBerthCollar && player._netBerthCollar.position)
    ? player._netBerthCollar.position.z / M
    : (V5 && V5.BERTH_COLLAR_Z_M != null ? V5.BERTH_COLLAR_Z_M : 1.30);
  const hc = d && d._homeCache;
  const shape = homeShapeKey(player);
  if (hc && hc.r === r && hc.anchorZ === anchorZ && (shape === null || hc.shape === shape)) return hc.distM;
  let ko = null;
  try { ko = armManager && typeof armManager.getKeepOut === 'function' ? armManager.getKeepOut() : null; } catch (_e) { ko = null; }
  const home = catchHomeZ(ko, r);
  // above angleFreeMaxR the home must also clear every OTHER radiator angle (ALL_ANGLE_HOME).
  const T = CN.REEL_HOME.ALL_ANGLE_HOME;
  let z = home.z, allAngleLiftM = null, unchecked = !!home.unchecked, blocker = home.blocker, top = home.top;
  if (ko && typeof ko.sphere === 'function' && !home.unchecked && T && r > T.angleFreeMaxR + 1e-9) {
    const R = T.radiiM, L = T.liftM, n = R.length;
    if (r > R[n - 1] + 1e-9) {
      unchecked = true; blocker = 'radius above ALL_ANGLE_HOME'; top = null;      // no measurement: keep the current-pose home, say so
    } else {
      let i = 0;
      while (i + 1 < n - 1 && r > R[i + 1]) i++;                                  // R[i] < r <= R[i + 1] (i + 1 <= n - 1)
      const t = clamp01((r - R[i]) / (R[i + 1] - R[i]));
      allAngleLiftM = L[i] + t * (L[i + 1] - L[i]);
      z = Math.max(home.z, home.touchZ + allAngleLiftM);
    }
  }
  const distM = Math.max(CN.REEL_HOME.APEX_AT_RING_M + r, z - anchorZ);
  if (unchecked) {
    if (top != null) {
      console.warn(`[CaptureNet] reel home UNCHECKED for r ${r} m: the keep-out sphere at the top of the search window (z ${top.toFixed(2)} m) is blocked by "${blocker}"; using the ring-touch z ${z.toFixed(3)} m`);
    } else {
      console.warn(`[CaptureNet] reel home UNCHECKED for r ${r} m: ${blocker} (measured up to r ${T ? T.radiiM[T.radiiM.length - 1] : '?'} m); using the current-pose home z ${z.toFixed(3)} m, which may foul the radiators at other angles`);
    }
  }
  if (d) d._homeCache = { r, anchorZ, shape, distM, z, clearZ: home.clearZ, queryMs: home.queryMs, queries: home.queries, allAngleLiftM, source: unchecked ? 'unchecked' : (ko ? 'keepout' : 'ring-touch'), blocker: unchecked ? blocker : undefined, top: unchecked ? top : undefined };
  return distM;
}

// Pure functions: cling probability + frag risk

/**
 * Get the net class spec for a given platform type.
 * @param {'mother'|'weaver'|'spinner'} type
 * @returns {object} Net class constants (LARGE, MEDIUM, or SMALL)
 */
export function getNetClassForType(type) {
  if (type === 'mother')  return CN.LARGE;
  if (type === 'weaver')  return CN.MEDIUM;
  if (type === 'spinner') return CN.SMALL;
  return CN.MEDIUM; // fallback
}

/**
 * Compute cling probability P_cling for a capture attempt.
 * Per CAPTURE_NET.md §3.3:
 *   P_cling = P_base × f_velocity × f_contact × f_roughness × f_spin × f_tension × f_distance
 *
 * @param {object} params
 * @param {number} params.pBase     — base probability for net class + target match (§3.4)
 * @param {number} params.vRel      — relative velocity at contact (m/s)
 * @param {number} params.vOptimal  — optimal wrap velocity (≈ launch speed)
 * @param {number} params.range     — distance from launcher to target (m)
 * @param {number} [params.contactFraction=1]  — mesh contact area / target area
 * @param {number} [params.roughness=1]        — surface roughness (0.4=smooth, 0.7=painted, 1.0=MLI)
 * @param {number} [params.spinFraction=1]     — ω_impact / ω_design
 * @param {number} [params.tensionFraction=1]  — T_tether / T_nominal
 * @param {number} [params.targetTumbleRate]   — target's tumble (rad/s); high tumble penalises cling (CP-2)
 * @returns {number} P_cling ∈ [0, 1]
 */
export function computeClingProbability(params) {
  const {
    range = 50,
    spinFraction = 1.0,
    targetTumbleRate = null,
  } = params;
  // The factor stack is split into a lock-stable phase and a live phase so the pre-fire HUD path can cache the former at
  // target-lock. This fresh path recomputes BOTH every call: cached and fresh output are identical by construction
  // (same functions, same multiplication order).
  const lock = computeClingLockFactors(params, _clingLockScratch);
  return finishClingProbability(lock, {
    range,
    spinFraction,
    fTumble: computeTumbleModifier(targetTumbleRate),
  });
}

/** Scratch for the fresh (uncached) path: reused per call, never allocated per frame. */
const _clingLockScratch = {
  fVelocity: 1, fContact: 1, fRoughness: 1, fTension: 1,
  prefix: 0, sureShotVelOK: false,
};

/**
 * Lock-stable phase of the §3.3 factor stack. Everything here depends only on inputs that hold still while a target
 * stays locked (pBase from the capture mode, launch/optimal speed, contact fraction, surface roughness, tether tension
 * nominal). `prefix` is the left-associated product pBase × f_velocity × f_contact × f_roughness, so finishing it with
 * the live factors reproduces the un-split arithmetic bit for bit.
 * Mutates and returns `out` (caller-owned slot; no per-frame allocation).
 * @param {object} params — same shape as computeClingProbability
 * @param {object} out — {fVelocity, fContact, fRoughness, fTension, prefix, sureShotVelOK}
 * @returns {object} out
 */
export function computeClingLockFactors(params, out) {
  const {
    pBase,
    vRel,
    vOptimal = 10,
    contactFraction = 1.0,
    roughness = 1.0,
    tensionFraction = 1.0,
  } = params;
  const vRange = 10; // m/s velocity range for clamp
  out.fVelocity  = clamp(1.0 - Math.abs(vRel - vOptimal) / vRange, 0.3, 1.0);
  out.fContact   = Math.min(contactFraction, 1.0);
  // floor the roughness multiplier: smooth surfaces are harder to wrap, but the raw material scale (solar cell 0.2,
  // aluminum 0.4) multiplied a perfect shot down to "feels broken" odds.
  out.fRoughness = Math.max(CN.ROUGHNESS_FLOOR ?? 0, roughness);
  out.fTension   = clamp(tensionFraction, 0.6, 1.0);
  out.prefix     = pBase * out.fVelocity * out.fContact * out.fRoughness;
  // Sure-shot's velocity gate is lock-stable too (pre-fire evaluates it at vRel === vOptimal === launch speed ⇒ 1.0).
  out.sureShotVelOK = out.fVelocity >= 0.99;
  return out;
}

/**
 * Live phase of the §3.3 factor stack: the per-frame factors (f_spin from the projected arrival spin, f_distance from
 * range) and the slowly-varying tumble factor, applied to the cached lock-stable prefix IN THE ORIGINAL ORDER:
 *   raw = (((prefix × f_spin) × f_tension) × f_distance) × f_tumble
 * the exact left-to-right association of the un-split chain: cache equality is arithmetic, not approximate.
 * @param {object} lock — result of computeClingLockFactors
 * @param {object} live — {range, spinFraction, fTumble (computeTumbleModifier output)}
 * @returns {number} P_cling ∈ [0, 1]
 */
export function finishClingProbability(lock, live) {
  const { range = 50, spinFraction = 1.0, fTumble = 1.0 } = live;
  const fSpin = clamp(spinFraction, 0.5, 1.2);
  // Distance modifier: f_distance = clamp(1.1 - 0.003 × range, 0.85, 1.1)
  const fDistance = clamp(1.1 - 0.003 * range, 0.85, 1.1);
  const raw = lock.prefix * fSpin * lock.fTension * fDistance * fTumble;
  let p = clamp01(raw); // clamp to valid probability

  // SURE-SHOT floor. A well-executed shot (close range, target de-tumbled to in-spec or tumble untracked, nominal launch
  // speed, fresh net spin) succeeds reliably: the payoff the game teaches ("close the distance, de-spin [L]");
  // distant/tumbling/sloppy shots keep the full physics stack, so aim and setup still matter.
  const sureShot = range <= (CN.CLOSE_RANGE ?? 30)
    && fTumble >= 1.0
    && lock.sureShotVelOK
    && spinFraction >= 0.8;
  if (sureShot) {
    p = clamp(CN.SURE_SHOT_MIN_CLING ?? 0, p, 1);
  }
  return p;
}

/**
 * CP-2 net-cling tumble modifier. 1.0 when tumble is unknown or at/below the in-spec spin; ramps linearly down to
 * NET_TUMBLE_PENALTY.FLOOR above it.
 * @param {number|null} tumbleRateRad — target tumble in rad/s (null ⇒ no penalty)
 * @returns {number} f_tumble ∈ [FLOOR, 1.0]
 */
export function computeTumbleModifier(tumbleRateRad) {
  if (tumbleRateRad == null) return 1.0;
  const P = Constants.NET_TUMBLE_PENALTY || { IN_SPEC_DEG: 10, PER_DEG: 0.012, FLOOR: 0.4 };
  const tumbleDeg = Math.abs(tumbleRateRad) * RAD2DEG;
  if (tumbleDeg <= P.IN_SPEC_DEG) return 1.0;
  return Math.max(P.FLOOR, 1.0 - (tumbleDeg - P.IN_SPEC_DEG) * P.PER_DEG);
}

/**
 * Compute the distance modifier alone (for HUD pre-fire display).
 * @param {number} range — metres
 * @returns {number} f_distance ∈ [0.85, 1.1]
 */
export function computeDistanceModifier(range) {
  return clamp(1.1 - 0.003 * range, 0.85, 1.1);
}

/**
 * Effective catch radius with close-range forgiveness: inside CLOSE_RANGE the net mouth wraps slightly beyond its disc,
 * so the intersection test widens by CATCH_RADIUS_FORGIVENESS. Outside it the geometric radius applies unchanged.
 * @param {number} mouthRadius — net mouth radius (metres)
 * @param {number} range — distance travelled / range to target (metres)
 * @returns {number} effective radius (metres)
 */
export function effectiveCatchRadius(mouthRadius, range) {
  const forgive = (range < CN.CLOSE_RANGE) ? (CN.CATCH_RADIUS_FORGIVENESS || 1.0) : 1.0;
  return mouthRadius * forgive;
}

/**
 * §11.2 mouth-collapse floor: centripetal tension per rim weight at a given spin — F/wt = m·ω²·r with ω = 2π·spinHz and
 * r = DIAMETER/2. The SAME quantity the §11.1 audit table and the test-Crossbow-Constants derivation guard compute at
 * the settled SPIN_HZ; here it runs LIVE on the decaying in-flight spinRate (the one f_spin reads) so NetProjectile can
 * check the mouth-open condition (F/wt ≥ CN.MOUTH_TENSION_FLOOR_N) per flight frame. Pure + Node-safe.
 * @param {{RIM_WEIGHT_MASS?:number, DIAMETER?:number}|null} netClass
 * @param {number} spinHz — live spin (Hz)
 * @returns {number} tension per rim weight (N); 0 when class data is missing
 */
export function rimTensionPerWeightN(netClass, spinHz) {
  const m = (netClass && netClass.RIM_WEIGHT_MASS) || 0;
  const r = ((netClass && netClass.DIAMETER) || 0) / 2;
  const omega = 2 * Math.PI * (spinHz || 0);
  return m * omega * omega * r;
}

/**
 * Local cone radius at an axial depth ahead of the apex. The bag is a cone: apex at local origin, mouth ring at local
 * z = −coneHeight (NetMeshKit.js `buildWebPositions`). Depth `a` metres ahead of the apex sees a local radius
 * mouthRadius × (a / coneHeight). Returns 0 outside [0, coneHeight]. Pure + Node-safe.
 * @param {number} mouthRadius — net mouth radius (metres)
 * @param {number} coneHeight — apex-to-mouth axial length (metres)
 * @param {number} axialDepth — metres ahead of the apex along the cone axis
 * @returns {number} local cone radius (metres)
 */
export function coneRadiusAtDepth(mouthRadius, coneHeight, axialDepth) {
  if (!(coneHeight > 0) || axialDepth < 0 || axialDepth > coneHeight) return 0;
  return mouthRadius * (axialDepth / coneHeight);
}

/**
 * Cone containment test for a target expressed in the kit's local frame. localZ is NEGATIVE ahead of the apex (the mouth
 * sits at local z = −coneHeight); localR is the lateral off-axis distance (hypot(localX, localY)). Inclusive on the
 * wall: a target exactly at r == coneRadiusAtDepth(a) counts as inside. Pure + Node-safe.
 * @param {number} localZ — kit-local z of the target (negative ahead of apex)
 * @param {number} localR — lateral off-axis distance (metres)
 * @param {number} mouthRadius — net mouth radius (metres)
 * @param {number} coneHeight — apex-to-mouth axial length (metres)
 * @returns {boolean} true when the target is inside the bag cone
 */
export function isInsideCone(localZ, localR, mouthRadius, coneHeight) {
  const a = -localZ;
  if (a < 0 || a > coneHeight) return false;
  return localR <= coneRadiusAtDepth(mouthRadius, coneHeight, a);
}

/**
 * Largest lateral offset that still yields containment at the brake instant. BRAKE fires when the apex-to-target
 * distance equals the catch radius R, so a² + r² = R² at that instant; containment requires r ≤ k·a with
 * k = mouthRadius / coneHeight. Solving gives R·mouthRadius / hypot(mouthRadius, coneHeight). Valid only while
 * R ≤ coneHeight — if the brake sphere exceeds the bag depth the net brakes with the target still ahead of the mouth
 * plane and containment at the brake instant is geometrically impossible; returns NaN then. Pure + Node-safe.
 * @param {number} catchRadius — the BRAKE-trigger sphere radius (metres)
 * @param {number} mouthRadius — net mouth radius (metres)
 * @param {number} coneHeight — apex-to-mouth axial length (metres)
 * @returns {number} max lateral offset (metres), or NaN when undefined
 */
export function maxImpactParameter(catchRadius, mouthRadius, coneHeight) {
  if (!(catchRadius <= coneHeight)) return NaN;
  return catchRadius * mouthRadius / Math.hypot(mouthRadius, coneHeight);
}

/**
 * Lead-aim direction + off-axis angle for the pre-fire readout. Mirrors the lead computation in
 * ArmUnit._updateNettingFSM: aim where the target will be when the net arrives (targetPos + relVel × dist/launchSpeed).
 * All inputs share one unit system (scene units OR metres — consistent).
 *
 * @param {{x,y,z}} armPos — launcher position
 * @param {{x,y,z}} targetPos — target position now
 * @param {{x,y,z}|null} relVel — target velocity relative to launcher (units/s)
 * @param {number} launchSpeed — net speed in the same length units per second
 * @param {{dir:{x,y,z}, offAxisDeg:number}} [out] — optional preallocated result (avoids per-frame allocation on hot aim
 *   paths); when omitted a fresh object is returned.
 * @returns {{ dir: {x,y,z}, offAxisDeg: number }} lead direction + angle between
 *   the lead direction and the direct bearing (0 when no lead is needed)
 */
export function computeLeadAim(armPos, targetPos, relVel, launchSpeed, out = null) {
  const bx = targetPos.x - armPos.x;
  const by = targetPos.y - armPos.y;
  const bz = targetPos.z - armPos.z;
  const bLen = Math.sqrt(bx * bx + by * by + bz * bz) || 1;

  let ax = targetPos.x, ay = targetPos.y, az = targetPos.z;
  if (relVel && launchSpeed > 1e-12) {
    const tof = bLen / launchSpeed;
    ax += relVel.x * tof;
    ay += relVel.y * tof;
    az += relVel.z * tof;
  }
  const dx = ax - armPos.x, dy = ay - armPos.y, dz = az - armPos.z;
  const dLen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  const dir = out ? out.dir : { x: 0, y: 0, z: 0 };
  dir.x = dx / dLen; dir.y = dy / dLen; dir.z = dz / dLen;

  const dot = clamp((dir.x * bx + dir.y * by + dir.z * bz) / bLen, -1, 1);
  const offAxisDeg = Math.acos(dot) * RAD2DEG;
  if (out) { out.offAxisDeg = offAxisDeg; return out; }
  return { dir, offAxisDeg };
}

/**
 * The mother's catch limit (DECISIONS §49 row 1; `CAPTURE_NET.LARGE.CATCH_LIMIT_KG`, 1,500 kg): a piece OVER it is refused
 * (exactly the limit stays catchable). It is the ship's practical limit, not the net's strength (`MAX_CAPTURE_MASS`, which
 * the strain/slip band reads), so it is its own check. A net class with no limit never refuses here.
 * @param {number} mass kg
 * @param {{CATCH_LIMIT_KG?:number}|null} netClass
 * @returns {boolean}
 */
export function overCatchLimit(mass, netClass) {
  const limit = netClass && netClass.CATCH_LIMIT_KG;
  return limit > 0 && (mass || 0) > limit;
}

/**
 * The one plain line for a piece over the mother's catch limit ("Too heavy for us: 2.7 t (we take up to 1.5 t). Inspect it instead.").
 * @param {number} mass kg
 * @param {{CATCH_LIMIT_KG?:number}} netClass
 * @returns {string}
 */
export function catchLimitLine(mass, netClass) {
  const t = (kg) => `${(kg / 1000).toFixed(1)} t`;
  return `Too heavy for us: ${t(mass)} (we take up to ${t(netClass.CATCH_LIMIT_KG)}). Inspect it instead.`;
}

/**
 * A piece over the mother's catch limit is not caught but inspected (DECISIONS §49 row 3): a daughter sent at it flies her usual approach to
 * her hold, sweeps it and comes home, and fires no net. The same limit as the mother's (`overCatchLimit`, the LARGE net class).
 * @param {number} mass kg
 * @returns {boolean}
 */
export function isInspectOnlyMass(mass) {
  return overCatchLimit(mass, Constants.CAPTURE_NET && Constants.CAPTURE_NET.LARGE);
}

/**
 * Pre-fire net-fit assessment — the SINGLE source for the reticle width/mass advisory, the TargetPanel capture-fit
 * badge, and the ToolRecommender width fork. Pure + Node-safe.
 *
 * Precedence: width (deterministic post-catch failure) > mass (refused at deploy / strain risk) > tumble (recoverable —
 * de-spin first).
 *
 * With ASPECT_CAPTURE on and aspect data present, the width fork is orientation-aware:
 *   • TOO_WIDE — even end-on the cross-section (widthM) exceeds the mouth.
 *   • ASPECT   — fits END-ON ONLY (widthM ≤ mouth < presented/length); pass
 *     `approachDir` for the live verdict, omit it for the static one.
 *
 * @param {{sizeMeter?:number, lengthM?:number, widthM?:number, mass?:number,
 *   tumbleRate?:number, type?:string, tumbleAxis?:object, tumbleAngle?:number}|null} target
 * @param {{DIAMETER?:number, MAX_CAPTURE_MASS?:number}|null} netClass
 * @param {{x:number,y:number,z:number}|null} [approachDir] — launcher→target direction
 * @returns {{ fit: 'OK'|'TOO_WIDE'|'TOO_HEAVY'|'DESPIN_FIRST'|'ASPECT', label: string }}
 */
export function assessNetFit(target, netClass, approachDir = null) {
  if (!target || !netClass) return { fit: 'OK', label: 'NET \u2713' };
  const size = target.sizeMeter || 0;
  const mass = target.mass || 0;
  const dia = netClass.DIAMETER || 0;
  const cap = netClass.MAX_CAPTURE_MASS || Infinity;

  const aspectOn = Constants.isFeatureEnabled && Constants.isFeatureEnabled('ASPECT_CAPTURE');
  const lengthM = (target.lengthM != null) ? target.lengthM : size;
  const widthM = (target.widthM != null) ? target.widthM : size;

  if (dia > 0) {
    if (aspectOn && lengthM > widthM) {
      if (widthM > dia) return { fit: 'TOO_WIDE', label: 'TOO WIDE' };  // even end-on
      if (lengthM > dia) {
        // Fits end-on only. With a live approach direction report the CURRENT presentation; statically report the aspect
        // opportunity.
        if (approachDir) {
          // The live presentation routes through the ONE mouth-fit predicate; the widthM tier above stays a static test.
          if (!fitsMouth(target, netClass, approachDir)) return { fit: 'ASPECT', label: 'END-ON ONLY' };
          // currently presented end-on → fits; fall through to mass/tumble
        } else {
          return { fit: 'ASPECT', label: 'END-ON ONLY' };
        }
      }
    } else if (size > dia) {
      return { fit: 'TOO_WIDE', label: 'TOO WIDE' };
    }
  }
  if (overCatchLimit(mass, netClass)) return { fit: 'TOO_HEAVY', label: 'TOO BIG TO CATCH' };
  if (mass > cap) return { fit: 'TOO_HEAVY', label: 'TOO HEAVY' };
  const P = Constants.NET_TUMBLE_PENALTY || { IN_SPEC_DEG: 10 };
  const tumbleDeg = (target.tumbleRate != null)
    ? Math.abs(target.tumbleRate) * RAD2DEG : 0;
  if (tumbleDeg > (P.IN_SPEC_DEG ?? 10)) return { fit: 'DESPIN_FIRST', label: 'DE-SPIN FIRST' };
  return { fit: 'OK', label: 'NET \u2713' };
}

/**
 * The DRAWN worst-axis span of a target's mesh in metres — the rendered truth the verdict deliberately never consults
 * (owner-declined: mesh-truthful verdicts; the logical lengthM/widthM govern, the 0.66×–4.62× per-type stylization is
 * accepted). Exists for ONE consumer class: HUD advisories that qualify an OK verdict (DockingReticle's advisory line,
 * TargetPanel's fit badges). MUST NOT feed a verdict — fitsMouth and the oversize_aspect bounces stay logical;
 * routing this into a refusal is exactly the declined option.
 *
 * span = 2 × baseRenderScale × boundingRadius ÷ (Constants.SCENE_SCALE/1000)
 * — the free-debris draw scale (DebrisField owns that SSOT; the same derivation as its METRE_SCENE, no second
 * hard-coded 1e-5) × the mesh bounding-SPHERE radius (DebrisWireframe owns it; primed via getGeometry first, so the
 * uncached-returns-1 trap cannot fire), scene units → metres. Measured headless: defunctSat 5 → 18.22 m, rocketBody 5 →
 * 10.22 m — the worst-axis form deliberately exceeds box-axis spans (18.1 / 7.8 m); a box-axis rule would slip
 * rocketBody 5 (7.8 < 8) past the chip although the bag pierces it by 2.210 m.
 *
 * Lives here, not in DebrisField: it COMPOSES the two homes and both are already imported — a DebrisField home would
 * add a DebrisField→DebrisWireframe import edge.
 *
 * Graceful + Node-safe: null target / no type / no size ⇒ 0 (no span claim); getGeometry builds headless
 * (test-Cubesat proves it).
 * @param {object|null} target
 * @returns {number} drawn worst-axis span in metres (0 when unknown)
 */
export function renderedSpanM(target) {
  if (!target || !target.type) return 0;
  const scale = DebrisField.baseRenderScale(target);
  if (!(scale > 0)) return 0;
  DebrisWireframe.getGeometry(target.type, target.id);   // prime the br cache
  const br = DebrisWireframe.getBoundingRadius(target.type, target.id) || 1;
  return 2 * scale * br / (Constants.SCENE_SCALE / 1000);
}

/**
 * The ONE overflow-advisory rule — does the DRAWN span exceed this net class's mouth? The verdict-is-OK half stays with
 * the caller's own signal (assessNetFit at the reticle/fit segs, green NET odds at the badges); this predicates only the
 * rendered-overflow half so the HUD surfaces cannot drift on the rule. Strictly-greater, and a mouthless class never
 * claims overflow — the same form as fitsMouth. Advisory only.
 * @param {object|null} target
 * @param {{DIAMETER?:number}|null} netClass
 * @returns {boolean}
 */
export function renderedSpanOverflows(target, netClass) {
  const dia = (netClass && netClass.DIAMETER) || 0;
  if (!(dia > 0)) return false;
  return renderedSpanM(target) > dia;
}

// Orientation-based capture geometry (ASPECT_CAPTURE)

/**
 * Width an elongated body presents to a net approaching at angle θ from its long axis: end-on (θ=0) → widthM;
 * broadside (θ=90°) → lengthM. Pure + Node-safe.
 *
 * @param {number} lengthM — long-axis extent (m)
 * @param {number} widthM — cross-section width (m)
 * @param {number} cosTheta — cos of the angle between long axis and approach dir
 * @returns {number} presented width (m)
 */
export function presentedWidth(lengthM, widthM, cosTheta) {
  const c = clamp(cosTheta || 0, -1, 1);
  const sinTheta = Math.sqrt(Math.max(0, 1 - c * c));
  return Math.max(widthM || 0, (lengthM || 0) * sinTheta);
}

/**
 * World-space long axis of a debris: the type's LOCAL long axis rotated by the live tumble orientation
 * quat(tumbleAxis, tumbleAngle) — exactly the rotation DebrisField applies to the mesh (setFromAxisAngle).
 * Rodrigues form, no THREE.
 *
 * @param {{type?:string, tumbleAxis?:{x,y,z}, tumbleAngle?:number}} debris
 * @returns {{x:number,y:number,z:number}} unit long axis (world space)
 */
export function worldLongAxis(debris) {
  const AC = Constants.ASPECT_CAPTURE || {};
  const locals = AC.LONG_AXIS_BY_TYPE || {};
  const v = (debris && locals[debris.type]) || { x: 0, y: 1, z: 0 };
  const k = debris && debris.tumbleAxis;
  const ang = (debris && debris.tumbleAngle) || 0;
  if (!k || ang === 0) return { x: v.x, y: v.y, z: v.z };
  // Rodrigues: v' = v cosθ + (k×v) sinθ + k (k·v)(1−cosθ)
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const dot = k.x * v.x + k.y * v.y + k.z * v.z;
  const cx = k.y * v.z - k.z * v.y;
  const cy = k.z * v.x - k.x * v.z;
  const cz = k.x * v.y - k.y * v.x;
  return {
    x: v.x * c + cx * s + k.x * dot * (1 - c),
    y: v.y * c + cy * s + k.y * dot * (1 - c),
    z: v.z * c + cz * s + k.z * dot * (1 - c),
  };
}

/**
 * Live presented width of a debris for an approach direction. Falls back to scalar sizeMeter when aspect data is
 * missing (fragments, legacy saves).
 * @param {object} debris — with lengthM/widthM (else sizeMeter), tumbleAxis/Angle
 * @param {{x:number,y:number,z:number}} approachDir — launcher→target (any length)
 * @returns {number} presented width (m)
 */
export function presentedWidthForApproach(debris, approachDir) {
  if (!debris) return 0;
  const size = debris.sizeMeter || 0;
  const lengthM = (debris.lengthM != null) ? debris.lengthM : size;
  const widthM = (debris.widthM != null) ? debris.widthM : size;
  if (!(lengthM > widthM) || !approachDir) return lengthM;   // symmetric / no data
  const len = Math.sqrt(approachDir.x * approachDir.x
    + approachDir.y * approachDir.y + approachDir.z * approachDir.z);
  if (len < 1e-12) return lengthM;
  const axis = worldLongAxis(debris);
  const cosTheta = Math.abs((axis.x * approachDir.x + axis.y * approachDir.y
    + axis.z * approachDir.z) / len);
  return presentedWidth(lengthM, widthM, cosTheta);
}

/**
 * The ONE mouth-fit verdict: does the target's presented width clear this net class's mouth? Shared by
 * `assessNetFit`'s live ASPECT tier, the ToolOdds WIDE blocker and both oversize_aspect bounces (contact + reel entry).
 * Refusal is STRICTLY-greater; a mouthless class, or a NaN presented width, never refuses.
 * `assessNetFit`'s widthM tier (TOO_WIDE, static end-on cross-section) deliberately stays inline: it tests a different
 * quantity, and routing it here would compute worldLongAxis only to discard it.
 * @param {object|null} target
 * @param {{DIAMETER?:number}|null} netClass
 * @param {{x:number,y:number,z:number}|null} [approachDir] — launcher→target
 *   (any length); ignored when `presentedM` is given
 * @param {number} [presentedM] — a PRECOMPUTED presented width: the contact-time store (reel entry re-judges the SAME
 *   presentation, not the live one the drifted tumble would give) or the odds caller's override
 * @returns {boolean} true when the mouth fits the presentation
 */
export function fitsMouth(target, netClass, approachDir = null, presentedM = undefined) {
  const dia = (netClass && netClass.DIAMETER) || 0;
  if (!(dia > 0)) return true;
  const p = (typeof presentedM === 'number') ? presentedM
    : presentedWidthForApproach(target, approachDir);
  return !(p > dia);
}

/**
 * The ONE strain-band ramp: where in the overload band does this payload sit? Shared by the daughter reel-start slip
 * (`ArmUnit._checkNetIntegrityOnReel`), the boost rip (`ArmUnit._updateReeling`), the mother reel entry
 * (`_enterMotherReel`) and the odds mirror (`ToolOdds.computeStrainFailProbability`). Only the ramp is shared; each
 * site keeps its own cap (ArmUnit: one-shot `pMax × t` vs per-second `pPerS × t × dt`). Lives here, not in ToolOdds,
 * to avoid a CaptureNet→ToolOdds import cycle. Returns 0 for non-positive mass/rating and at/below the safe fraction.
 * @param {number} payloadMass — kg
 * @param {number} ratedMass   — the net's rated mass (kg; MAX_CAPTURE_MASS)
 * @returns {number} band position t ∈ [0, 1]: 0 at/below the safe fraction, 1 at/above 100 % rated
 */
export function strainBandT(payloadMass, ratedMass) {
  if (!(payloadMass > 0) || !(ratedMass > 0)) return 0;
  const strain = payloadMass / ratedMass;
  const safe = Constants.NET_STRAIN_SAFE_FRACTION ?? 0.8;
  if (strain <= safe) return 0;
  return Math.min(1, (strain - safe) / Math.max(1e-6, 1 - safe));
}

/**
 * Fragmentation risk from target fragility and impact KE (CAPTURE_NET.md §5.1–§5.4).
 * @param {object} params
 * @param {number} params.netMass       — net mass in kg
 * @param {number} params.vRel          — relative velocity at contact (m/s)
 * @param {number} params.targetFragility — base frag risk for debris class (§5.4, 0–1)
 * @param {number} params.range         — distance (m)
 * @returns {number} frag risk ∈ [0, 1]
 */
export function computeFragRisk(params) {
  const { netMass, vRel, targetFragility = 0.05, range = 50 } = params;
  const ke = 0.5 * netMass * vRel * vRel;   // J
  // Reference KE: Medium Net at 10 m/s = 34 J
  const keScale = Math.min(ke / 34, 2.0);
  let risk = targetFragility * keScale;

  // Distance modifier (§3.3 QA Q-4)
  if (range < CN.CLOSE_RANGE) {
    risk *= 0.5;  // halved at close range
  } else if (range > CN.BASELINE_RANGE_MAX) {
    risk *= 1.5;  // increased at edge of envelope
  }

  return clamp01(risk);
}

/**
 * Base fragility for computeFragRisk. Per-debris brittleness (close-range survey) drives the FRAG chip when no
 * explicit fragility is set.
 * @param {object|null} target
 * @returns {number} base frag risk 0..1
 */
export function effectiveFragility(target) {
  if (!target) return 0.05;
  if (typeof target.fragility === 'number') return target.fragility;
  if (typeof target.brittleness === 'number') return Math.max(0.05, target.brittleness * 0.3);
  return 0.05;
}

/**
 * Fragmentation severity tier. Severity = brittleness × KE factor (vRel excess over the optimal wrap speed).
 * Deterministic given countRoll.
 * @param {object} params
 * @param {number} [params.brittleness=0.5] — per-debris 0..1 (DebrisField)
 * @param {number} [params.vRel=10] — contact speed (m/s)
 * @param {number} [params.vOptimal=10] — optimal wrap speed (launch speed)
 * @param {number} [params.countRoll=0.5] — 0..1 → fragment count within tier band
 * @returns {{ tier: 'crack'|'breakup'|'shatter', severity: number,
 *             fragmentCount: number, destroyTarget: boolean }}
 */
export function resolveFragSeverity({ brittleness = 0.5, vRel = 10, vOptimal = 10, countRoll = 0.5 } = {}) {
  const FS = Constants.FRAG_SEVERITY || {};
  const keFactor = Math.min(2, Math.max(0.5, vRel / Math.max(1e-6, vOptimal)));
  const severity = clamp01(brittleness) * (keFactor / 2);
  const tier = severity >= (FS.SHATTER_SEVERITY ?? 0.75) ? 'shatter'
    : severity >= (FS.BREAKUP_SEVERITY ?? 0.45) ? 'breakup'
    : 'crack';
  const band = tier === 'shatter' ? (FS.SHATTER_FRAGS || [8, 12])
    : tier === 'breakup' ? (FS.BREAKUP_FRAGS || [3, 6])
    : (FS.CRACK_FRAGS || [1, 2]);
  const r = clamp01(countRoll);
  const fragmentCount = band[0] + Math.round(r * (band[1] - band[0]));
  return { tier, severity, fragmentCount, destroyTarget: tier !== 'crack' };
}

/**
 * Map a NET_CATCH_MISS reason to a player-facing line. null only for 'forced' (scripted/test resolves stay silent);
 * unknown reasons get a generic re-line-the-shot message.
 * @param {string} reason — 'timeout'|'tether_limit'|'cling_failed'|'oversize_aspect'|'fragmented'|'mouth_collapsed'|'forced'|…
 * @returns {string|null}
 */
export function missReasonToText(reason) {
  switch (reason) {
    case 'timeout':
    case 'tether_limit':
      return 'Net overshot. Line up the reticle and re-fire. Net reeling back; inventory restored.';
    case 'out_of_range':
      return 'Net missed: the piece drifted out of range. Close in and re-fire. Net reeling back.';
    case 'cling_failed':
      return 'Net grazed it. Wrap didn\'t hold. Close the distance or de-spin the target (hold L), then re-fire.';
    case 'oversize_aspect':
      return 'Net bounced off broadside. Too wide this way. De-spin, then come around end-on so the net swallows it lengthwise.';
    case 'fragmented':
      return 'Impact broke the target apart. Fragments are now tracked. Approach slower on brittle debris (CINCH wraps gentler).';
    case 'mouth_collapsed':
      // §11.2: rim spin decayed below the tension floor mid-flight. Distinct from the plain miss so the player learns
      // the shot was doomed by range, not aim.
      return 'Net mouth collapsed mid-flight — shot too long. Rim spin bled below the tension floor. Close the distance, then re-fire.';
    case 'forced':
      return null;   // scripted/test resolves stay silent
    default:
      return 'Net missed. Re-line the shot and fire again. Net reeling back.';
  }
}

/**
 * Map a NET_CATCH_MISS reason to its staged failure beat, or null when the miss gets no staging. ONE home: the logic
 * side (CaptureNetSystem's deferred auto-reel) and the visual side (CaptureNetVisual) must agree on which failures
 * are staged.
 *   'bounce' — oversize_aspect: the bag slaps the broadside face and recoils, the mouth never closes.
 *   'slip'   — strain_slip: the welded cinch releases and the catch slides out of the mouth (cinchFrac toward 0).
 * Unstaged: cling_failed (wrap never closed), fragmented (owned by the fragmentation machinery),
 * timeout/tether_limit/target_lost (no target in frame). mouth_collapsed (§11.2) is deliberately unstaged: a later
 * visual beat keys off NetProjectile.mouthCollapsed / the NET_MOUTH_COLLAPSED event, not off this mapper.
 * @param {string} reason
 * @returns {'bounce'|'slip'|null}
 */
export function missFailureKind(reason) {
  switch (reason) {
    case 'oversize_aspect': return 'bounce';
    case 'strain_slip':     return 'slip';
    default:                return null;
  }
}

/**
 * Auto-recommend capture mode (CAPTURE_NET.md §3.6).
 * @param {object} target — debris with optional .hasSolarPanels, .surfaceRoughness, .vRel
 * @returns {'SLAM_WRAP'|'CINCH'}
 */
export function recommendCaptureMode(target) {
  if (!target) return MODES.SLAM_WRAP;
  if (target.hasSolarPanels)  return MODES.CINCH;
  if ((target.vRel || 0) > 5) return MODES.CINCH;
  if ((target.surfaceRoughness || 1.0) < 0.5) return MODES.CINCH;
  return MODES.SLAM_WRAP;
}

/**
 * A single net in flight through its full capture cycle.
 * State machine (CAPTURE_NET.md §2.4):
 *   FOLDED → LAUNCHING → SPINNING_UP → FLIGHT →
 *     (slam) CONTACT → SECURE_CHECK → CAPTURED/MISSED → REELING → STOWED
 *     (cinch) BRAKE → ENVELOP → CINCH_CLOSING → SECURE_CHECK → CAPTURED/MISSED → REELING → STOWED
 *     (abort at any active state) → RELEASED
 */
export class NetProjectile {
  /**
   * @param {object} config
   * @param {object} config.netClass       — one of CN.LARGE / CN.MEDIUM / CN.SMALL
   * @param {number} config.armIndex       — daughter arm index (-1 for the mother launcher)
   * @param {number} [config.podIndex=-1]  — mother launcher index (always 0 — one launcher; -1 for daughter)
   * @param {object} config.launchPosition — {x, y, z} in metres
   * @param {object} config.launchDirection — normalised {x, y, z}
   * @param {object} [config.targetDebris] — target with .position, .mass, .id
   * @param {string} [config.captureMode]  — 'SLAM_WRAP' or 'CINCH'
   */
  constructor(config) {
    this.netClass       = config.netClass;
    this.armIndex       = config.armIndex;
    this.podIndex       = config.podIndex ?? -1;
    this.launchPosition = { ...config.launchPosition };
    this.launchDirection = { ...config.launchDirection };
    this.targetDebris   = config.targetDebris || null;
    this.captureMode    = config.captureMode || MODES.SLAM_WRAP;

    /** @type {object|null} Reference to source arm for inventory restoration (§3.5) */
    this._sourceArm     = config.sourceArm || null;

    /** @type {function(THREE.Vector3):THREE.Vector3|null} Mother-pod launcher anchor provider: writes the pod muzzle's
     *  CURRENT world position (scene units) into the supplied scratch vector. Polled every frame (the ship moves ~0.7
     *  scene units/s, so an anchor read once at launch is ~45 km stale after 0.65 s). Null on the headless test path. */
    this._anchorProvider = config.anchorProvider || null;
    /** @type {THREE.Vector3|null} Scratch for the anchor provider (lazy: headless tests never touch it). */
    this._anchorScratch  = null;

    /** @type {boolean} Daughter capture hauled by the ArmUnit: hold the net's own reel (bag stays cinched) until delivery. */
    this._heldByArm     = false;
    /** @type {{x:number,y:number,z:number}|null} Net centre at contact minus target centre, metres
     *  (null until contact: the scoop then centres its mouth on the target). */
    this._mouthOffsetM  = null;
    /** @type {{x:number,y:number,z:number}|null} Net launch direction at contact (the drawn mouth's axis;
     *  null until contact: the scoop then uses a ball). */
    this._mouthAxis     = null;
    /** @type {boolean} This net already took a scoop (its targetDebris is the bag). */
    this._scooped       = false;
    /** @type {number} kg the held catch carried when the arm LOST it (integrity slip / boost rip / tether-snap
     *  drift-end / reset drop / severed-claim transfer) instead of delivering it to the furnace. 0 on every other
     *  path: a delivered catch keeps its mass in capturedMass. */
    this._releasedMassKg = 0;

    // ── Runtime state ──
    this.state         = STATES.LAUNCHING;
    this.stateTimer    = 0;
    this.flightTime    = 0;
    this.distanceTraveled = 0;
    this.position      = { ...this.launchPosition };
    this.speed         = this.netClass.LAUNCH_SPEED;
    this.spinRate      = 0;           // current Hz
    /** @type {number} §11.2: live per-rim-weight tension (N) from the decayed in-flight spin,
     *  rimTensionPerWeightN(netClass, spinRate). Updated each FLIGHT tick; 0 before flight (bag still folded).
     *  Telemetry and the collapse latch run for every class. */
    this.rimTensionN   = 0;
    /** @type {boolean} §11.2 mouth-collapse latch: true once rimTensionN fell below CN.MOUTH_TENSION_FLOOR_N during
     *  FLIGHT (one-way: in-flight decay is monotonic). While true, contact resolves as a 'mouth_collapsed' MISS
     *  instead of a wrap. NET_MOUTH_COLLAPSED fires once at the latch. */
    this.mouthCollapsed = false;
    this.tetherPaidOut = 0;           // metres
    this.reelProgress  = 0;           // 0..1
    this.capturedMass  = 0;           // kg of captured debris
    this.tangleQuality = 0;           // 0..1: higher is better wrap
    this.tensionN      = 0;           // current tension in Newtons
    this.isActive      = true;
    this.catchResult   = null;        // 'success' | 'miss' | null

    // Diagnostics (for tests / HUD)
    this._clingRoll        = 0;
    this._clingProbability = 0;
    this._fragRisk         = 0;
    this._presentedWidthM  = null;   // presented width at contact (m)

    // Flag for CaptureNetSystem to detect state changes from forceResolve()
    this._resultProcessed  = false;

    // Mother berth state (podIndex ≥ 0 && armIndex < 0)
    /** @type {object|null} Injected context { player, debrisField } (CaptureNetSystem.fireMotherNet, from init(deps)).
     *  Backs the ship-relative reel pin and the pinCapturedDebris API. */
    this._ctx            = null;
    /** @type {number|null} Ship-relative reel: remaining distance muzzle→bag APEX (the tether end the winch reels; the
     *  catch rides _catchSeatM metres deeper), METRES. Seeded at REELING entry from the debris's live _scenePosition
     *  minus the seat depth, then monotonically eased to the berth standoff. Single source for reelProgress. */
    this._remainingM     = null;
    /** @type {number|null} The seeded _remainingM at REELING entry: the reelProgress denominator. Do NOT derive it
     *  from tetherPaidOut (disagrees with the live seed after contact→reel drift). */
    this._reelSeedM      = null;
    /** @type {number} Net-domain seconds since reel entry (reel/berth ticks): the ramp key for the readability
     *  floor, which eases in over MOTHER_CATCH_MIN_RENDER_RAMP_S. Seeded 0 at _enterMotherReel, NEVER reset while
     *  held: keying on stateTimer would re-ramp at BERTHED entry (stateTimer resets on every _transitionTo). */
    this._floorRampT     = 0;
    /** @type {number|null} Depth (metres) the catch rides INSIDE the bag past the apex, along the frozen bag axis
     *  (launchDirection). Seeded at REELING entry from the live capture geometry (aM ≈ 4.5 m on a LARGE net). The
     *  reel/berth pin writes apex + launchDirection × _catchSeatM so the catch stays wrapped in the drawn bag, not
     *  colocated with the apex. */
    this._catchSeatM     = null;
    /** @type {THREE.Vector3|null} Lateral offset (scene units), decayed to 0. */
    this._lateral        = null;
    /** @type {THREE.Vector3|null} Lagged ship-forward (scene units): a raw live fwd would whip a 5 t catch across
     *  the sky on a mid-reel slew. */
    this._fwdLagged      = null;
    /** @type {THREE.Quaternion|null} Catch attitude in the SHIP frame, captured at berth entry:
     *  qLocal = shipQuat⁻¹ × qCatch. The berth hold writes shipQuat × qLocal back into tumbleAxis/tumbleAngle every
     *  frame so the catch rotates rigidly WITH the ship. */
    this._qLocal         = null;
    /** @type {number} BERTH_SECURE_S countdown once BERTHED; ≤ 0 → processed. */
    this._berthTimer     = -1;
    /** @type {boolean} True once CATCH_PROCESSED has been emitted for this net. */
    this._berthProcessed = false;
    /** @type {number|null} Deterministic strain-roll override for tests. */
    this._strainRollOverride = null;
    /** @type {number|null} Deterministic cling-roll override for tests / the shot harness (`__netScenario`).
     *  0 ⇒ guaranteed catch; read at the `_clingRoll <= _clingProbability` compare in `_resolveCatch`. */
    this._clingRollOverride = null;
    /** @type {boolean} Set when the mother reel has no berth context (headless test path): the reel falls through to
     *  the daughter-style reel-back so the net still stows/prunes instead of looping MISSED→REELING. */
    this._motherReelFallback = false;
    /** @type {'bounce'|'slip'|null} The staged failure beat this net's miss earned (missFailureKind). While MISSED
     *  with a non-null kind, the system's auto-reel holds for FAILURE_STAGING_S so the beat plays at the contact
     *  point before the empty reel-back. */
    this._failureKind = null;
    // Reel corridor clearance
    /** @type {boolean} True while the reel holds at CORRIDOR_HOLD_M waiting for the recovery corridor to clear. */
    this._corridorHold = false;
    /** @type {number} Seconds in the corridor hold; at CORRIDOR_TIMEOUT_S the reel berths at
     *  CORRIDOR_EXTENDED_STANDOFF_M rather than clip through. */
    this._corridorTimer = 0;
    /** @type {boolean} True once the corridor gate has timed out: latches the gate OFF for the rest of the reel so it
     *  cannot re-arm against the same blocked corridor (the berth completes at the held range). */
    this._corridorTimedOut = false;
    /** @type {number} The _remainingM at corridor-hold engagement: the hold freezes the approach HERE (never pushes it
     *  back out), EXCEPT the queue level: the latch takes max(engagement range, queue level) and the hold glides OUT
     *  to it at reel speed (see the ease in _updateMotherReel). */
    this._corridorHoldLevelM = 0;
    /** @type {boolean} True when the corridor-hold latch was queue-raised past the engagement range (the drain-race):
     *  the hold glides OUT to the latch, and a timeout mid-glide completes the glide to the raised standoff (never an
     *  outward pop). False with an empty queue. */
    this._corridorGlide = false;
    /** @type {boolean} True once the corridor gate has emitted its Houston line (once per net, even if the corridor
     *  clears and re-blocks). */
    this._corridorAnnounced = false;
    /** @type {number|null} The berth standoff actually in force — normally
     *  sizeMeter/2 + BERTH_CLEARANCE_M, raised to CORRIDOR_EXTENDED_STANDOFF_M
     *  after a corridor timeout. */
    this._effectiveStandoffM = null;
    /** @type {boolean} The line-taut tug fires exactly once, at the CAPTURED transition (mother path only). */
    this._tugApplied = false;
    /** @type {THREE.Vector3|null} Windowed tug delivery: the feel vector (scene units/s) fed into _rcsVelocity over
     *  NET_TUG_WINDOW_S by CaptureNetSystem.update. Null when no window is active. Dies with the net, so a jettison
     *  mid-window abandons the remainder. */
    this._tugFeelScene = null;
    /** @type {number} Seconds of the tug window already delivered. */
    this._tugElapsed = 0;
    // Berth garnish
    /** @type {number} Tumble carryover: residual spin (rad/s) the wrapped bundle keeps at ENVELOP, decaying over
     *  TUMBLE_CARRYOVER_DECAY_S. Fed into the berth-hold orientation as a small extra pitch term. */
    this._tumbleCarryover = 0;
    // ACCUMULATED residual-spin angle (rad): the increment must accumulate across frames, not be applied to a freshly
    // rebuilt quaternion each frame (that decays to a sub-degree offset).
    this._tumbleCarryAngle = 0;
    /** @type {number} Berthed pendulum: angular offset (rad) of the berthed bundle off the lagged-forward axis, driven
     *  by the same critically damped spring as the reel-direction lag, re-excited by RCS. */
    this._pendulumAngle = 0;
    /** @type {number} Pendulum angular velocity (rad/s). */
    this._pendulumVel = 0;

    // Ceremony event emission guards (archive/CEREMONY_REDESIGN.md §5.2)
    this._ceremonyStartEmitted    = false;
    this._brakeImminentEmitted    = false;
    this._brakeFiredEmitted       = false;
    this._envelopPeakEmitted      = false;
    this._ceremonyCompleteEmitted = false;
    this._lastCinchBucket         = -1;
  }

  /**
   * Launcher anchor in scene units, current frame. Daughter path: the source arm's live position; mother-pod path:
   * the anchor provider (pod muzzle world position). Null on the headless test path (callers fall back to the
   * metres-based absolute-position logic).
   * @returns {THREE.Vector3|null}
   * @private
   */
  _anchorScene() {
    if (this._sourceArm) {
      // Anchor at the arm's net-launcher canister MUZZLE (mesh-derived, scene units) when the arm exposes it, so the
      // per-frame co-orbiting sync, contact math and rendered net/tether share the visible launch point. Mock arms
      // without the method keep the arm-centre anchor (headless).
      if (typeof this._sourceArm.getNetMuzzleWorldInto === 'function') {
        if (!this._anchorScratch) this._anchorScratch = new THREE.Vector3();
        return this._sourceArm.getNetMuzzleWorldInto(this._anchorScratch);
      }
      if (this._sourceArm.position) return this._sourceArm.position;
    }
    if (this._anchorProvider) {
      if (!this._anchorScratch) this._anchorScratch = new THREE.Vector3();
      return this._anchorProvider(this._anchorScratch);
    }
    return null;
  }

  /**
   * Advance the state machine by dt seconds.
   * @param {number} dt — delta time (seconds)
   */
  update(dt) {
    if (!this.isActive) return;

    // Emit BEFORE the scale read below: CameraSystem's _onNetCeremonyStart handler (synchronous via EventBus) must
    // publish the first beat's timeScale to CeremonyTimeScale before we apply it.
    if (FEATURE_FLAGS.NET_CEREMONY && !this._ceremonyStartEmitted) {
      this._ceremonyStartEmitted = true;
      eventBus.emit(Events.NET_CEREMONY_START, {
        armIndex: this.armIndex,
        podIndex: this.podIndex,
        netClass: this.netClass.CODE,
      });
    }

    // Ceremony time-dilation (archive/CEREMONY_REDESIGN.md §5, §6 R1): scales THIS projectile's internal dt only;
    // world dt is unaffected. CeremonyTimeScale.get() === 1.0 when the flag is off or no ceremony is active.
    const scale = FEATURE_FLAGS.NET_CEREMONY ? CeremonyTimeScale.get() : 1.0;
    dt = dt * scale;

    this.stateTimer += dt;

    // Only `_updateFlight` updates `this.position` from the arm's scene position; after contact it would freeze while
    // the arm co-orbits at ~7 km/s (the visual drifts off-frame and the camera, which tracks the arm's current
    // position, ends up in a different frame: the "net disappears" bug). So sync it to the arm's current scene
    // position in ALL states after launch:
    //   LAUNCHING/SPINNING_UP — distanceTraveled is 0, so this seats the net on the moving muzzle (the launcher moves
    //     ~0.7 scene units/s: ~45 km apparent drift over the first 0.65 s otherwise).
    //   CONTACT..SECURE_CHECK — visual stays at the launch-distance point in the arm's co-orbiting frame.
    //   REELING — also slides the effective launch distance tetherPaidOut → 0 as reelProgress goes 0→1
    //     (_updateReeling updates only that scalar, not position).
    const anchor = this._anchorScene();
    if (anchor
        && (this.state === STATES.LAUNCHING
            || this.state === STATES.SPINNING_UP
            || this.state === STATES.CONTACT
            || this.state === STATES.BRAKE
            || this.state === STATES.ENVELOP
            || this.state === STATES.CINCH_CLOSING
            || this.state === STATES.SECURE_CHECK
            // MISSED holds for FAILURE_STAGING_S on a staged failure. Without the sync the bag would sit at its absolute
            // contact point while the launcher co-orbits away (~0.7 scene units/s), so the beat would play on a vanished
            // bag. Both staged reasons fire while distanceTraveled === tetherPaidOut, so this holds the bag where
            // SECURE_CHECK left it and matches the empty reel-back's progress-0 value (continuous in and out).
            || this.state === STATES.MISSED)) {
      const M_NET = Constants.SCENE_UNITS_PER_METER;
      this.position.x = anchor.x / M_NET + this.launchDirection.x * this.distanceTraveled;
      this.position.y = anchor.y / M_NET + this.launchDirection.y * this.distanceTraveled;
      this.position.z = anchor.z / M_NET + this.launchDirection.z * this.distanceTraveled;
    } else if (anchor && this.state === STATES.REELING) {
      const M_NET = Constants.SCENE_UNITS_PER_METER;
      // Mother physical-reel path: _updateMotherReel owns net.position (writes the bag apex from the ship-relative pin
      // every tick). This sync must NOT run there: it rewrites net.position to whale − mouthR before _enterMotherReel
      // reads it, polluting the catch-seat measurement.
      const motherPhysical = this._isMother
        && this.catchResult === 'success' && !this._motherReelFallback;
      // Successful catch: lock the bag ONTO the captured debris (its live scene position, driven by DebrisField) so net
      // and catch never separate during the haul. Apex sits one mouth-radius BEHIND the debris along the launch axis,
      // so the drawstring ring wraps the FAR side. Visual only: nothing reads net.position back into arm/debris/autopilot.
      const sp = (!motherPhysical && this.catchResult === 'success') ? this.targetDebris?._scenePosition : null;
      if (motherPhysical) {
        // _updateMotherReel writes net.position later this same tick.
      } else if (sp) {
        if (this._heldByArm && this._sourceArm) {
          // A daughter's held net sits where its bag is drawn: the neck on the tow line from her muzzle to the catch,
          // touching the catch's rear (entities/heldBagShape.js: the one rule CaptureNetVisual draws and
          // ArmUnit._rhSyncBag winds the line to), not one flight-mouth radius behind it
          heldBagNeckInto(_heldNeck, sp, anchor, this.launchDirection, heldBagRadiusScene(this.targetDebris), DAUGHTER_STAND_M);
          this.position.x = _heldNeck.x / M_NET;
          this.position.y = _heldNeck.y / M_NET;
          this.position.z = _heldNeck.z / M_NET;
        } else {
          const back = this.netClass.DIAMETER / 2;   // mouth radius (m), apex standoff
          this.position.x = sp.x / M_NET - this.launchDirection.x * back;
          this.position.y = sp.y / M_NET - this.launchDirection.y * back;
          this.position.z = sp.z / M_NET - this.launchDirection.z * back;
        }
      } else {
        // Empty net (miss): reel the bag back; effective launch distance shrinks from tetherPaidOut to 0 as
        // reelProgress goes 0→1.
        const eff = this.tetherPaidOut * Math.max(0, 1 - this.reelProgress);
        this.position.x = anchor.x / M_NET + this.launchDirection.x * eff;
        this.position.y = anchor.y / M_NET + this.launchDirection.y * eff;
        this.position.z = anchor.z / M_NET + this.launchDirection.z * eff;
      }
    }

    switch (this.state) {
      case STATES.LAUNCHING:     this._updateLaunching(dt);   break;
      case STATES.SPINNING_UP:   this._updateSpinningUp(dt);  break;
      case STATES.FLIGHT:        this._updateFlight(dt);      break;
      case STATES.CONTACT:       this._updateContact(dt);     break;
      case STATES.BRAKE:         this._updateBrake(dt);       break;
      case STATES.ENVELOP:       this._updateEnvelop(dt);     break;
      case STATES.CINCH_CLOSING: this._updateCinchClosing(dt); break;
      case STATES.SECURE_CHECK:  this._updateSecureCheck(dt); break;
      case STATES.REELING:       this._updateReeling(dt);     break;
      // Terminal states — no tick
      case STATES.CAPTURED:
      case STATES.MISSED:
      case STATES.STOWED:
      case STATES.RELEASED:
      case STATES.FOLDED:
        break;
      // Mother berth/collar: the per-frame hold is driven by CaptureNetSystem
      // (which owns the player/debrisField refs), not by the projectile's switch.
      case STATES.BERTHED:
      case STATES.COLLARED:
        break;
    }
  }

  /** True for a mother-pod net (the only path the berth machinery runs on). */
  get _isMother() {
    return this.podIndex >= 0 && this.armIndex < 0;
  }

  /** @private */
  _transitionTo(newState) {
    this.state = newState;
    this.stateTimer = 0;
  }

  /** Phase 1: Crossbow release (0.15 s) */
  _updateLaunching(dt) {
    if (this.stateTimer >= CN.CAST_WINDUP) {
      this._transitionTo(STATES.SPINNING_UP);
    }
  }

  /** Phase 2: Yo-yo despin spin-up (0.5 s) */
  _updateSpinningUp(dt) {
    // Yo-yo despin, STYLIZED (§11.6): the direction is the real effect (I grows with r, so ω falls), but
    // SPIN_FOLDED_MULT = 3 is a deliberate visual simplification, NOT L = Iω conservation (3× implies a fictional
    // folded radius r_open/√3 ≈ 2.3 m on LARGE; true conservation from a ~5 cm radius would need ≈ 6400×, an
    // invisible blur). Same note at Constants.js CAPTURE_NET.SPIN_FOLDED_MULT.
    const foldedMult = CN.SPIN_FOLDED_MULT != null ? CN.SPIN_FOLDED_MULT : 1.0;
    const fraction = Math.min(this.stateTimer / CN.SPIN_UP_TIME, 1);
    const startHz = this.netClass.SPIN_HZ * foldedMult;
    this.spinRate = lerp(startHz, this.netClass.SPIN_HZ, fraction);
    if (this.stateTimer >= CN.SPIN_UP_TIME) {
      this.spinRate = this.netClass.SPIN_HZ;
      this._transitionTo(STATES.FLIGHT);
    }
  }

  /** Phase 3: Tether pay-out + target intersection check */
  _updateFlight(dt) {
    this.flightTime += dt;
    const dist = this.speed * dt;
    this.distanceTraveled += dist;
    this.tetherPaidOut += dist;

    // Slow in-flight spin decay (mesh flexing + rim drag): long shots arrive with spinFraction < 1, a live f_spin
    // penalty in computeClingProbability. Per-class override first (LARGE 0.04/s; derivation at Constants.js
    // CN.LARGE.SPIN_DECAY_PER_S, §11.2); SMALL/MEDIUM use the shared CN.SPIN_DECAY_PER_S.
    const decayPerS = this.netClass.SPIN_DECAY_PER_S ?? CN.SPIN_DECAY_PER_S ?? 0;
    if (decayPerS > 0 && this.spinRate > 0) {
      this.spinRate = Math.max(0, this.spinRate - this.netClass.SPIN_HZ * decayPerS * dt);
    }

    // Update position along launch direction (metres, for CaptureNetVisual + test path)
    this.position.x += this.launchDirection.x * dist;
    this.position.y += this.launchDirection.y * dist;
    this.position.z += this.launchDirection.z * dist;

    // PROD path: sync from the launcher's co-orbiting frame so CaptureNetVisual renders the net near the ship.
    const M_NET = Constants.SCENE_UNITS_PER_METER;  // 1 m in scene units (matches ArmUnit.M)
    const anchor = this._anchorScene();
    if (anchor) {
      this.position.x = anchor.x / M_NET + this.launchDirection.x * this.distanceTraveled;
      this.position.y = anchor.y / M_NET + this.launchDirection.y * this.distanceTraveled;
      this.position.z = anchor.z / M_NET + this.launchDirection.z * this.distanceTraveled;
    }

    // Max flight time (§2.4 phase 3); per-class override (LARGE 11 s reaches the 100 m tether limit).
    const maxFlightTime = this.netClass.MAX_FLIGHT_TIME ?? CN.MAX_FLIGHT_TIME;
    if (this.flightTime >= maxFlightTime) {
      this._miss('timeout');
      return;
    }

    if (this.tetherPaidOut >= this.netClass.TETHER_MAX) {
      this._miss('tether_limit');
      return;
    }

    // Dead-target guard: DebrisField.removeDebris sets alive=false and FREEZES _scenePosition, so a stale position
    // would keep passing the intersection check below.
    if (this.targetDebris && this.targetDebris.alive === false) {
      this._miss('target_lost');
      return;
    }

    // §11.2 mouth-collapse floor. Live rim tension from the SAME decayed spin f_spin reads (rimTensionPerWeightN,
    // F/wt = m·(2π·spinRate)²·r). Below CN.MOUTH_TENSION_FLOOR_N the rim weights cannot hold the mouth open in 0g:
    // any contact resolves as a distinct 'mouth_collapsed' MISS at the intersection check below. One-way latch
    // (in-flight decay is monotonic), evaluated AFTER the timeout/tether/dead-target guards so a net that times out on
    // the same tick keeps that reason at any dt. Runs for EVERY class: LARGE's SPIN_DECAY_PER_S override (0.04/s, owner rebalance 2026-08-27) puts
    // its crossing at t* ≈ 13.51 s ≈ 135 m, outside every reachable contact (≥ 2.5 s margin); derivation at
    // Constants.js CN.LARGE.SPIN_DECAY_PER_S, pins in test-CaptureNet-MouthCollapse.js.
    // The long shot stays TAKEABLE and fails with its own comms line (missReasonToText 'mouth_collapsed') instead of a
    // range clamp, which would touch RANGE/MAX_FLIGHT constants mirrored by the reticle/odds/refusal surfaces and
    // silently forbid the input.
    this.rimTensionN = rimTensionPerWeightN(this.netClass, this.spinRate);
    const mouthFloorN = CN.MOUTH_TENSION_FLOOR_N;
    if (!this.mouthCollapsed && mouthFloorN > 0
        && this.rimTensionN < mouthFloorN) {
      this.mouthCollapsed = true;
      eventBus.emit(Events.NET_MOUTH_COLLAPSED, {
        armIndex:    this.armIndex,
        podIndex:    this.podIndex,
        netClass:    this.netClass.CODE,
        flightTime:  this.flightTime,
        rimTensionN: this.rimTensionN,
      });
    }

    // Intersection = distance < net radius. PROD: launcher-relative scene position (co-orbiting frame);
    // TEST: absolute metres (mock .position, no anchor).
    if (this.targetDebris) {
      const sp = this.targetDebris._scenePosition;
      const ap = anchor;
      if (sp && ap) {
        // Net scene pos = arm scene pos + flight displacement (scene units)
        const netX = ap.x + this.launchDirection.x * this.distanceTraveled * M_NET;
        const netY = ap.y + this.launchDirection.y * this.distanceTraveled * M_NET;
        const netZ = ap.z + this.launchDirection.z * this.distanceTraveled * M_NET;
        const dx = sp.x - netX;
        const dy = sp.y - netY;
        const dz = sp.z - netZ;
        const distScene = Math.sqrt(dx * dx + dy * dy + dz * dz);
        // close-range forgiveness: near-grazes inside CLOSE_RANGE count
        const radiusScene = effectiveCatchRadius(
          this.netClass.DIAMETER / 2, this.distanceTraveled
        ) * M_NET;
        // brake-imminent lookahead (cinch path only)
        if (FEATURE_FLAGS.NET_CEREMONY && !this._brakeImminentEmitted
            && this.captureMode === MODES.CINCH) {
          const brakeThreshScene = (this.speed * 0.3 + this.netClass.DIAMETER / 2) * M_NET;
          if (distScene <= brakeThreshScene) {
            this._brakeImminentEmitted = true;
            eventBus.emit(Events.NET_BRAKE_IMMINENT, {
              armIndex: this.armIndex,
              podIndex: this.podIndex,
              tMinus: 0.3,
            });
          }
        }
        if (distScene <= radiusScene) {
          // The mother's net never catches a piece beyond its advertised reach (netMaxReachM, 100 m for the large net),
          // measured as the HUD and fire gate do: ship centre → piece (targetRangeM). The 3 m mouth radius plus a
          // piece drifting away over the 10 s flight could otherwise close a catch past it.
          if (this._anchorProvider && !this._sourceArm) {
            const shipPos = (this._ctx && this._ctx.player && typeof this._ctx.player.getPosition === 'function')
              ? this._ctx.player.getPosition() : ap;
            if (targetRangeM(shipPos, sp) > netMaxReachM(this.netClass)) {
              this._miss('out_of_range');
              return;
            }
          }
          // §11.2: a collapsed mouth cannot wrap: distinct MISS so comms teach the range limit.
          if (this.mouthCollapsed) {
            this._miss('mouth_collapsed');
            return;
          }
          // where the mouth is relative to the target at contact (metres; the scoop reads it when the net closes)
          this._mouthOffsetM = { x: -dx / M_NET, y: -dy / M_NET, z: -dz / M_NET };
          this._mouthAxis = { x: this.launchDirection.x, y: this.launchDirection.y, z: this.launchDirection.z };   // the drawn net's axis
          if (this.captureMode === MODES.CINCH) {
            this._transitionTo(STATES.BRAKE);
          } else {
            this._transitionTo(STATES.CONTACT);
          }
        }
      } else {
        // Test fallback: .position in metres, no orbital motion
        const tp = this.targetDebris.position || this.targetDebris;
        const dx = (tp.x || 0) - this.position.x;
        const dy = (tp.y || 0) - this.position.y;
        const dz = (tp.z || 0) - this.position.z;
        const distToTarget = Math.sqrt(dx * dx + dy * dy + dz * dz);
        // brake-imminent lookahead (cinch path only)
        if (FEATURE_FLAGS.NET_CEREMONY && !this._brakeImminentEmitted
            && this.captureMode === MODES.CINCH) {
          const brakeThresh = this.speed * 0.3 + this.netClass.DIAMETER / 2;
          if (distToTarget <= brakeThresh) {
            this._brakeImminentEmitted = true;
            eventBus.emit(Events.NET_BRAKE_IMMINENT, {
              armIndex: this.armIndex,
              podIndex: this.podIndex,
              tMinus: 0.3,
            });
          }
        }
        if (distToTarget <= effectiveCatchRadius(this.netClass.DIAMETER / 2, this.distanceTraveled)) {
          // §11.2: same collapsed-mouth gate as the scene-frame branch above.
          if (this.mouthCollapsed) {
            this._miss('mouth_collapsed');
            return;
          }
          this._mouthOffsetM = { x: -dx, y: -dy, z: -dz };   // mouth relative to the target at contact (metres)
          this._mouthAxis = { x: this.launchDirection.x, y: this.launchDirection.y, z: this.launchDirection.z };   // the drawn net's axis
          if (this.captureMode === MODES.CINCH) {
            this._transitionTo(STATES.BRAKE);
          } else {
            this._transitionTo(STATES.CONTACT);
          }
        }
      }
    }
  }

  /** Phase 5a: Slam-wrap contact */
  _updateContact(dt) {
    if (this.stateTimer >= CN.SLAM_CONTACT_TIME) {
      this._transitionTo(STATES.SECURE_CHECK);
    }
  }

  /** Phase 5b-A: Tether brake (cinch path) */
  _updateBrake(dt) {
    if (FEATURE_FLAGS.NET_CEREMONY && !this._brakeFiredEmitted) {
      this._brakeFiredEmitted = true;
      eventBus.emit(Events.NET_BRAKE_FIRED, {
        armIndex: this.armIndex,
        podIndex: this.podIndex,
        tetherTensionN: this.tensionN,
      });
    }
    if (this.stateTimer >= CN.BRAKE_TIME) {
      this._transitionTo(STATES.ENVELOP);
    }
  }

  /** Phase 5b-B: Rim weights sweep past target */
  _updateEnvelop(dt) {
    if (FEATURE_FLAGS.NET_CEREMONY && !this._envelopPeakEmitted
        && this.stateTimer >= CN.ENVELOP_TIME * 0.5) {
      this._envelopPeakEmitted = true;
      eventBus.emit(Events.NET_ENVELOP_PEAK, {
        armIndex: this.armIndex,
        podIndex: this.podIndex,
      });
    }
    if (this.stateTimer >= CN.ENVELOP_TIME) {
      this._transitionTo(STATES.CINCH_CLOSING);
    }
  }

  /** Phase 5b-C: Drawstring cinch closing */
  _updateCinchClosing(dt) {
    if (FEATURE_FLAGS.NET_CEREMONY) {
      const fraction = Math.min(this.stateTimer / CN.CINCH_CLOSE_TIME, 1);
      const bucket = Math.floor(fraction * 10);
      if (bucket !== this._lastCinchBucket) {
        this._lastCinchBucket = bucket;
        eventBus.emit(Events.NET_CINCH_PROGRESS, {
          armIndex: this.armIndex,
          podIndex: this.podIndex,
          fraction,
        });
      }
    }
    if (this.stateTimer >= CN.CINCH_CLOSE_TIME) {
      this._transitionTo(STATES.SECURE_CHECK);
    }
  }

  /** Phase 6: Secure check — resolve capture probability */
  _updateSecureCheck(dt) {
    if (this.stateTimer >= CN.SECURE_CHECK_TIME) {
      this._resolveCatch();
    }
  }

  /** Phase 7: Reel-in — motor pulls net+debris back */
  _updateReeling(dt) {
    // MOTHER PHYSICAL REEL: ship-relative, pinned through debrisField.pinCapturedDebris every frame.
    // NEVER step the pin toward the pod in absolute coordinates: the ship translates ~0.7 scene units/s while the reel
    // closes at 2e-5 units/s, so an absolute reel diverges ~35,000×.
    // NEVER write _armPinPos raw and rely on DebrisField.update to render it: that ran EARLIER this frame, so the
    // catch lands one frame (~1.17 km at 60 fps) behind the nose. pinCapturedDebris force-writes the instance matrix
    // in the same call, so frame order stops mattering.
    if (this._isMother && this.catchResult === 'success' && !this._motherReelFallback) {
      this._updateMotherReel(dt);
      // _updateMotherReel sets _motherReelFallback when there is no berth context (headless): fall through to the
      // daughter reel-back so the net still stows and prunes instead of looping on a miss.
      if (!this._motherReelFallback) return;
    }

    // Held daughter catch: keep the bag cinched on the debris until the arm delivers it (the net's own short reel
    // would STOW and remove the bag visual mid-haul). Released (and stowed) once the catch is no longer pinned to a
    // captor: docked (alive=false, pin cleared), net failure (pin cleared), or the tether-snap bounded drift's end.
    if (this._heldByArm) {
      const d = this.targetDebris;
      const stillHauling = !!(d && d.alive !== false && d._capturedByArm);
      if (stillHauling) {
        // SNUG sub-phase: the arm sets `_snugTargetN`; pull the bag to that cinch tension so daughter+net+debris
        // rigidize into one unit before the haul. Otherwise hold at the base mass formula.
        this.tensionN = (this._snugTargetN != null)
          ? this._snugTargetN
          : baseCaptureTensionN(this.capturedMass);
        return;                       // hold: no completion while the arm hauls
      }
      this._heldByArm = false;        // delivered / lost → stow promptly
      this._snugTargetN = null;
      this.reelProgress = 1.0;
      // The hold ends DELIVERED (furnace hand-off: _updateHoldingCatch marks the piece _breakdownActive as it releases
      // the cinch, ArmUnit.js) or LOST (integrity slip / boost rip / tether-snap drift-end / reset drop /
      // severed-claim transfer). Only a delivery reports its mass at completion; a loss stows EMPTY and reports
      // releasedMass, so no listener reads a successful-looking capturedMass for a body that drifted away.
      if (!(d && d._breakdownActive)) this._releasedMassKg = this.capturedMass;
    }

    if (this.tetherPaidOut <= 0) {
      // Edge case: net fired but didn't travel
      this.reelProgress = 1.0;
    } else {
      const reelRate = this.netClass.REEL_SPEED / Math.max(1, this.tetherPaidOut);
      this.reelProgress = Math.min(1.0, this.reelProgress + reelRate * dt);
    }

    // Tension: base + mass factor (simplified)
    this.tensionN = baseCaptureTensionN(this.capturedMass);

    if (this.reelProgress >= 1.0) {
      this._transitionTo(STATES.STOWED);
      this.isActive = false;
      const releasedKg = this._releasedMassKg || 0;
      eventBus.emit(Events.NET_REEL_COMPLETED, {
        armIndex:     this.armIndex,
        podIndex:     this.podIndex,
        capturedMass: releasedKg > 0 ? 0 : this.capturedMass,
        releasedMass: releasedKg,
        debrisId:     this.targetDebris?.id,
      });
    }
  }

  /**
   * @private Mother REELING entry: strain/oversize roll, then seed the
   * ship-relative reel state from the debris's LIVE _scenePosition (one frame
   * only — LassoSystem._canonicalDebris documents why the seed must start from
   * where the debris actually is, not where the flight model left it).
   * @returns {boolean} false when the entry itself failed (strain slip → miss)
   */
  _enterMotherReel() {
    const d = this.targetDebris;
    const player = this._ctx?.player;
    if (!d || !player) return false;

    // Strain/oversize roll: ToolOdds.computeNetOdds already prices it (× 1 − computeStrainFailProbability),
    // so the HUD would otherwise promise a slip that can never happen.
    const rated = this.netClass.MAX_CAPTURE_MASS || 0;
    const mass = d.mass || 0;
    // Re-judge the presentation width recorded at contact (not the live tumble) through the one mouth-fit predicate.
    const presented = this._presentedWidthM ?? d.sizeMeter ?? 0;
    if (!fitsMouth(d, this.netClass, null, presented)) {
      this._miss('oversize_aspect');
      return false;
    }
    if (rated > 0 && mass > 0) {
      const strain = mass / rated;
      // Band ramp: the one strain-band helper; the cap stays here (one-shot roll vs NET_STRAIN_FAIL_PROB_MAX).
      const t = strainBandT(mass, rated);
      if (t > 0) {
        const pMax = Constants.NET_STRAIN_FAIL_PROB_MAX ?? 0;
        const roll = (this._strainRollOverride != null) ? this._strainRollOverride : Math.random();
        if (roll < pMax * t) {
          eventBus.emit(Events.COMMS_MESSAGE, {
            text: `Net strain slip — catch was ${Math.round(strain * 100)}% of the net's rated mass. `
              + `Slips become likely above ${Math.round((Constants.NET_STRAIN_SAFE_FRACTION ?? 0.8) * 100)}%.`,
            source: 'SYSTEM', channel: 'CMD', priority: 'warning',
          });
          this._miss('strain_slip');
          return false;
        }
      }
    }

    // Past the gates the mother takes ownership: drop a tether-snapped runaway's stale severed claim so the EXPENDED
    // arm's _updateExpended never fights the berth-line pin (its 8 s drift release must not fire on this held catch).
    // MUST stay AFTER the refusal gates: a refused entry leaves the bounded-drift release armed.
    dropSeveredCatchClaim(d);

    const M_NET = Constants.SCENE_UNITS_PER_METER;
    // The reel/berth homes on the COLLAR anchor (the berth-approach corridor is the collar's); the seat below keeps the
    // launcher muzzle (_anchorScene) because the brake apex is on the launch line. The muzzle→collar offset (axial,
    // muzzle 30 mm behind the collar) rides in the lateral seed and decays across the reel (_settleFwdLagged).
    const anchorWorld = (typeof player.getNetBerthCollarPositionInto === 'function')
      ? player.getNetBerthCollarPositionInto(new THREE.Vector3())
      : (typeof player.getNetPodPositionInto === 'function')
        ? player.getNetPodPositionInto(this.podIndex, new THREE.Vector3())
        : new THREE.Vector3();
    const sp = d._scenePosition;
    if (sp) {
      const dx = sp.x - anchorWorld.x, dy = sp.y - anchorWorld.y, dz = sp.z - anchorWorld.z;
      // The catch rides INSIDE the bag at the depth the capture left it, not AT the apex. Seat = its depth past the
      // brake apex (anchor + launchDir × distanceTraveled) along the frozen bag axis (launchDirection, the axis
      // CaptureNetVisual draws the bag on, so pin, mesh and probe never drift). Read the LIVE anchor, NEVER
      // net.position: it is frozen in the absolute frame from the last SECURE_CHECK tick, and one frame of orbital
      // drift (~1.17 km at 60 fps) would pin the catch kilometres from the bag.
      const L = this.launchDirection;
      const anchor = this._anchorScene();
      const seatM = (L && anchor) ? Math.max(0,
        ((sp.x - anchor.x) / M_NET) * L.x
        + ((sp.y - anchor.y) / M_NET) * L.y
        + ((sp.z - anchor.z) / M_NET) * L.z
        - this.distanceTraveled) : 0;
      this._catchSeatM = seatM;
      // _remainingM = APEX (tether end) distance along the ship axis; `_lateral` = the apex's offset off it.
      // apex = catch − launchDirection × seat, split into axial and perpendicular parts. Exact, so the pin reproduces
      // the live catch position at entry (no snap at the CAPTURED→REELING hand-off).
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(player.quaternion).normalize();
      const ax = dx - (L ? L.x * seatM * M_NET : 0);
      const ay = dy - (L ? L.y * seatM * M_NET : 0);
      const az = dz - (L ? L.z * seatM * M_NET : 0);
      const apexAlong = ax * fwd.x + ay * fwd.y + az * fwd.z;
      this._remainingM = Math.max(1e-3, apexAlong / M_NET);
      this._lateral = new THREE.Vector3(ax - fwd.x * apexAlong, ay - fwd.y * apexAlong, az - fwd.z * apexAlong);
    } else {
      this._remainingM = this.tetherPaidOut;
      this._catchSeatM = 0;
      this._lateral = new THREE.Vector3();
    }
    this._seedReelHome(d, player);
    // The reelProgress denominator is the ACTUAL seeded remaining distance, not tetherPaidOut (they disagree after
    // drift between contact and reel entry, or a close target; a ~0 denominator snaps progress 0→1).
    this._reelSeedM = Math.max(this._remainingM, 1e-3);
    // Seeded HERE, once (reel entry), never at BERTHED.
    this._floorRampT = 0;
    this._fwdLagged = new THREE.Vector3(0, 0, 1).applyQuaternion(player.quaternion).normalize();

    // Catch attitude in the SHIP frame, so the berth hold rotates it rigidly with the ship.
    if (d.tumbleAxis && player.quaternion) {
      const qCatch = new THREE.Quaternion().setFromAxisAngle(d.tumbleAxis, d.tumbleAngle || 0);
      this._qLocal = player.quaternion.clone().invert().multiply(qCatch);
    } else {
      this._qLocal = new THREE.Quaternion();
    }

    // Tumble carryover: residual spin (rad/s, capped) the wrapped bundle keeps at ENVELOP; decays in
    // _updateMotherReel/updateBerthHold.
    const tumbleRate = Math.abs(d.tumbleRate || 0);
    this._tumbleCarryover = Math.min(tumbleRate, CN.TUMBLE_CARRYOVER_MAX_RAD_S ?? 0.6);
    this._tumbleCarryAngle = 0;   // accumulation starts fresh each catch
    return true;
  }

  /**
   * @private The `_catchRenderMin` VALUE for the reel/berth write sites (and LeashDriver's `easeFull`).
   * DECISIONS §25 row 2 ("the reel-in must be seen"; Ruling 0): a mother-net catch is drawn at its TRUE size from
   * capture to latch. The value is the piece's BASE render scale, which DebrisField.catchRenderFloorScale (it only
   * raises, `_catchRenderMin > base`) treats as no floor, so every reader sees the real size. The floor constants
   * (MOTHER_CATCH_MIN_RENDER_M) stay in Constants.js: the lasso path and the non-ladder ceremony hold distance read them.
   * @param {object} d — the canonical catch debris
   * @param {number} _dt — unused
   * @returns {number} scene-unit scale for `_catchRenderMin` (== the base render scale)
   */
  _catchFloorScale(d, _dt) {
    return DebrisField.baseRenderScale(d);
  }

  /**
   * @private Seed the HOME state at reel entry (or lazily, for a net a test put into REELING / BERTHED by hand):
   * where the catch's centre ends on the collar axis, and the apex / seat that put it there.
   * Home seat = the catch centre's distance from the ring's fore face; the bag's mouth (apex) sits at the ring.
   * @param {object} d — the caught debris
   * @param {object} player — mother ship (collar z, keep-out)
   */
  _seedReelHome(d, player) {
    const H = CN.REEL_HOME;
    const homeDistM = catchHomeDistM(player, this._ctx?.armManager, d);
    this._homeCatchM = homeDistM;
    this._homeApexM = H.APEX_AT_RING_M;
    this._homeSeatM = Math.max(0, homeDistM - H.APEX_AT_RING_M);
    this._apex0M = this._remainingM ?? this._homeApexM;
    this._seat0M = this._catchSeatM || 0;
    const L = this.launchDirection || { x: 0, y: 0, z: 1 };
    this._ldir0 = { x: L.x, y: L.y, z: L.z };
    this._reelDistM = null;
  }

  /**
   * @private Reel progress p (0 at the seed, 1 with the apex at home) for apex distance `A`.
   * @param {number} A — apex distance along the ship axis from the collar, metres
   * @returns {number} 0..1
   */
  _seatProgress(A) {
    const Ah = this._homeApexM;
    const A0 = Math.max(this._apex0M ?? A, Ah + 1e-3);
    const p = 1 - (A - Ah) / (A0 - Ah);
    return p < 0 ? 0 : p > 1 ? 1 : p;
  }

  /**
   * @private The seat law. As the apex comes in, the catch slides toward the bag's mouth (seat S0 → home seat, linear
   * in p) and the bag axis turns from the captured launch direction onto the ship axis (normalised lerp, weight p).
   * Writes `_catchSeatM` and `launchDirection` in place (visual and pins read them: one geometry). At p = 1 the catch
   * is on the collar axis at home.
   * @param {number} A — apex distance, metres
   * @returns {number} p
   */
  _applySeatLaw(A) {
    const p = this._seatProgress(A);
    const S0 = this._seat0M ?? this._catchSeatM ?? 0;
    this._catchSeatM = lerp(S0, this._homeSeatM, p);
    const L0 = this._ldir0, f = this._fwdLagged, L = this.launchDirection;
    if (L0 && f && L) {
      const x = (1 - p) * L0.x + p * f.x, y = (1 - p) * L0.y + p * f.y, z = (1 - p) * L0.z + p * f.z;
      const n = Math.hypot(x, y, z);
      if (n > 1e-6) { L.x = x / n; L.y = y / n; L.z = z / n; } else { L.x = f.x; L.y = f.y; L.z = f.z; }
    }
    return p;
  }

  /**
   * @private The catch centre's distance from the collar plane along the ship axis for apex distance `A` (closed form
   * of the seat law; monotone in A for any sane launch angle), so the CATCH moves at the commanded speed.
   * @param {number} A — apex distance, metres
   * @returns {number} metres
   */
  _catchAxialAt(A) {
    const p = this._seatProgress(A);
    const S0 = this._seat0M ?? 0;
    const S = lerp(S0, this._homeSeatM, p);
    const L0 = this._ldir0, f = this._fwdLagged;
    let dot = 1;
    if (L0 && f) {
      const c0 = L0.x * f.x + L0.y * f.y + L0.z * f.z;
      const n = Math.sqrt(Math.max(1e-12, (1 - p) * (1 - p) + p * p + 2 * p * (1 - p) * c0));
      dot = ((1 - p) * c0 + p) / n;
    }
    return A + S * dot;
  }

  /**
   * @private The catch's commanded speed `crem` metres from its end: the class reel speed, then a constant
   * deceleration (DECEL_MPS2) that reaches SLOW_MPS at SLOW_ZONE_M and holds it to arrival.
   * @param {number} crem — catch distance still to go, metres
   * @param {number} nominalMps — class reel speed, m/s
   * @returns {number} m/s
   */
  _reelCatchSpeed(crem, nominalMps) {
    const H = CN.REEL_HOME;
    const room = Math.max(0, crem - H.SLOW_ZONE_M - (H.DECEL_LEAD_M ?? 0));
    return Math.min(nominalMps, H.SLOW_MPS + Math.sqrt(2 * H.DECEL_MPS2 * room));
  }

  /**
   * Seconds the inward reel still needs at the commanded profile (cruise, deceleration, creep over the last
   * SLOW_ZONE_M); an estimate for CameraSystem's REEL_IN wall-clock bound. null before the reel is seeded.
   * @returns {number|null} seconds
   */
  reelEtaS() {
    if (this._homeSeatM == null || this._remainingM == null || !this._fwdLagged) return null;
    const H = CN.REEL_HOME;
    const endA = Math.max(this._homeApexM, this._effectiveStandoffM ?? this._homeApexM);
    const crem = Math.max(0, this._catchAxialAt(this._remainingM) - this._catchAxialAt(endA));
    const v = this.netClass?.REEL_SPEED || 2.0;
    const creepM = H.SLOW_ZONE_M + (H.DECEL_LEAD_M ?? 0);
    // profile v = SLOW + sqrt(2 a x), x = distance beyond the creep: the slow-down spans (v - SLOW)^2 / 2a
    const decelM = (v - H.SLOW_MPS) * (v - H.SLOW_MPS) / (2 * H.DECEL_MPS2);
    const cruiseM = Math.max(0, crem - creepM - decelM);
    const decelInM = Math.min(decelM, Math.max(0, crem - creepM));
    return cruiseM / v + decelInM / (0.5 * (v + H.SLOW_MPS)) + Math.min(crem, creepM) / H.SLOW_MPS;
  }

  /**
   * @private One frame of the inward reel: the CATCH advances `_reelCatchSpeed × dt` toward its end, and the apex is
   * whatever puts it there (bisection on the monotone closed form). Never overshoots: the final step lands on the end.
   * @param {number} dt — seconds
   * @param {number} nominalMps — class reel speed, m/s
   * @param {number} endA — apex distance at the end of the reel (home, or the extended standoff)
   */
  _reelStepCatch(dt, nominalMps, endA) {
    const A = this._remainingM;
    if (A <= endA) { this._remainingM = endA; return; }
    const cEnd = this._catchAxialAt(endA);
    const cOld = this._catchAxialAt(A);
    const target = cOld - this._reelCatchSpeed(cOld - cEnd, nominalMps) * dt;
    if (target <= cEnd) { this._remainingM = endA; return; }
    let lo = endA, hi = A;
    for (let i = 0; i < 28; i++) {
      const mid = 0.5 * (lo + hi);
      if (this._catchAxialAt(mid) < target) lo = mid; else hi = mid;
    }
    this._remainingM = 0.5 * (lo + hi);
  }

  /**
   * The DRAWN bundle's radius in metres (effectiveRenderScale × boundingRadius; `sizeMeter` is the logical size).
   * The camera's hold-distance formula reads THIS, so the shot frames the bundle the player sees. 0 with no target
   * (callers fall back to the sizeMeter-only term; headless camera mocks omit the method, same fallback).
   * @returns {number} drawn bundle radius in metres (0 = no target)
   */
  heldBundleRadiusM() {
    const d = this.targetDebris;
    if (!d) return 0;
    try {
      DebrisWireframe.getGeometry(d.type, d.id);   // br cache (uncached ⇒ 1 trap)
      const br = DebrisWireframe.getBoundingRadius(d.type, d.id) || 1;
      return DebrisField.effectiveRenderScale(d) * br / 0.00001;
    } catch (_e) { return 0; }
  }

  /**
   * @private Mother REELING per-frame tick: monotonically ease remainingM to
   * the berth standoff and pin the catch through debrisField.pinCapturedDebris.
   */
  _updateMotherReel(dt) {
    const d = this.targetDebris;
    const player = this._ctx?.player;
    const debrisField = this._ctx?.debrisField;
    // No berth context (headless test, or a mother net fired without init(deps)): fall through to the daughter-style
    // reel-back rather than missing: a miss here would loop MISSED→REELING→MISSED via the re-armed auto-reel.
    if (!d || !player || !debrisField) { this._motherReelFallback = true; return; }
    if (d.alive === false) { this._miss('target_lost'); return; }

    if (this._remainingM == null) {
      if (!this._enterMotherReel()) return;   // strain slip / oversize → missed
    }

    const M_NET = Constants.SCENE_UNITS_PER_METER;
    // Standoff in force: the APEX target at home is the bag's mouth at the ring (CN.REEL_HOME.APEX_AT_RING_M);
    // a corridor-timeout berth raises it to CORRIDOR_EXTENDED_STANDOFF_M.
    if (this._homeSeatM == null) this._seedReelHome(d, player);
    const baseStandoffM = this._homeApexM;
    if (this._effectiveStandoffM == null) this._effectiveStandoffM = baseStandoffM;
    const berthStandoffM = Math.max(baseStandoffM, this._effectiveStandoffM);

    // Corridor gate: pause the final approach CORRIDOR_HOLD_M out until the recovery corridor (see _corridorClear) is
    // clear. On timeout, berth at the extended standoff rather than clip through.
    // The mated-cargo hold STACKS: the gate level is raised past the queue's fore-extent so each queued catch holds
    // clear of the previous one's far face (catches frozen at the same level would co-locate). Empty queue → 0, so
    // the CORRIDOR_HOLD_M floor stands.
    const queueHoldM = this._queueHoldLevelM(d);
    const holdM = Math.max(berthStandoffM, CN.CORRIDOR_HOLD_M ?? 10, queueHoldM);
    if (!this._corridorTimedOut && this._remainingM <= holdM && !this._corridorClear(d)) {
      if (!this._corridorHold) {
        this._corridorHold = true;
        this._corridorTimer = 0;
        // Freeze at the CURRENT range, never above it: a catch seeded inside the gate range must not pop outward to
        // holdM. EXCEPT the queue level: when mated cargo raised the hold past the current range (drain-race: this
        // catch passed the gate while the leader was still reeling, then the leader berthed), freezing here would pin
        // it INSIDE the member's far face (interpenetrating bodies, a continuity-law violation). The latch takes the
        // queue level and the hold glides OUT to it at reel speed (ease below): the one bounded exception to the
        // monotonic-ease invariant. Empty queue → the latch is the current range, no glide.
        this._corridorHoldLevelM = Math.max(this._remainingM, queueHoldM);
        this._corridorGlide = this._corridorHoldLevelM > this._remainingM;
      }
      this._corridorTimer += dt;
      if (!this._corridorAnnounced) {
        this._corridorAnnounced = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: 'Clearing deck for recovery…',
          source: 'HOUSTON', priority: 'info',
        });
      }
      if (this._corridorTimer >= (CN.CORRIDOR_TIMEOUT_S ?? 8)) {
        // Timeout: berth AT the held position (clamped into [base, extended]). For strut tips and mated cargo the
        // hold level is already outside every intruder's reach, so berthing there neither slides in past the
        // intruder nor pops outward. NOT so for the radiator read: a radiator or tip bag that folds in during the
        // last metres can latch the hold with the catch already touching it, and the timeout berths it there anyway
        // (accepted; open item, archive/research/2026-10-leash.md).
        const extended = Math.max(holdM, CN.CORRIDOR_EXTENDED_STANDOFF_M ?? 10);
        this._effectiveStandoffM = Math.min(Math.max(baseStandoffM, this._corridorHoldLevelM), extended);
        // Keep _corridorHold TRUE for the rest of this frame: berthStandoffM came from the OLD standoff, so easing now
        // would step remainingM below the new one and the next frame would clamp it back OUT (a one-frame outward
        // pop). The latch below makes the gate false next frame; the resume branch then clears the hold.
        this._corridorTimedOut = true;   // latch: the gate must not re-arm while the berth completes
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `Deck not clear — berthing at extended standoff (${Math.round(this._effectiveStandoffM)} m).`,
          source: 'HOUSTON', priority: 'warning',
        });
      }
      // Hold: only the queue-glide (ease below) moves remainingM while held.
    } else if (this._corridorHold) {
      // Corridor cleared (or we were never blocked) — resume the approach.
      this._corridorHold = false;
      this._corridorTimer = 0;
      // A timeout mid-glide keeps the glide flag: the berth completes the glide OUT to the raised standoff.
      if (!this._corridorTimedOut) this._corridorGlide = false;
    }

    // Monotonic ease-in (never decelerate mid-reel: the tether must not re-slack and re-snap). The long-tether
    // speed-up keeps the duration in ~5–25 s (REEL_SPEED 2.0 on a 100 m shot would be ~50 s).
    const reelSpeed = (this._remainingM >= (CN.REEL_LONG_TETHER_M ?? 40))
      ? this.netClass.REEL_SPEED * (CN.REEL_LONG_TETHER_MULT ?? 3.0)
      : this.netClass.REEL_SPEED;
    const remBeforeM = this._remainingM;   // reel travel this frame (motor bill below)
    if (!this._corridorHold) {
      if (this._corridorGlide && this._remainingM < berthStandoffM) {
        // A hold that timed out mid-glide completes the glide OUT to the raised standoff at reel speed (no outward pop).
        this._remainingM = Math.min(berthStandoffM, this._remainingM + reelSpeed * dt);
      } else {
        // The speed (and arrival taper) is the CATCH's: the last 0.30 m runs at <= 0.10 m/s whatever the seat.
        this._reelStepCatch(dt, reelSpeed, berthStandoffM);
      }
    } else if (this._remainingM < this._corridorHoldLevelM) {
      // Queue-glide: the one bounded OUTWARD move (the exception to the monotonic ease): the drain-race follower
      // backs out to the queue-cleared latch at reel speed, never past it. reelProgress reads backward meanwhile.
      this._remainingM = Math.min(this._corridorHoldLevelM, this._remainingM + reelSpeed * dt);
    }

    // reelProgress from remainingM: 0 at the seeded range (_reelSeedM), 1 at the standoff; frozen during a corridor hold.
    const seedM = Math.max(berthStandoffM + 1e-3, this._reelSeedM ?? this.tetherPaidOut ?? berthStandoffM + 1e-3);
    this.reelProgress = clamp01(1 - (this._remainingM - berthStandoffM) / (seedM - berthStandoffM));

    // Rotation lag: critically damped spring on ship-forward, so a mid-reel slew doesn't whip the catch.
    this._settleFwdLagged(player, dt);

    // Pin anchor (scene units): collar berth anchor + lagged-fwd · remainingM + lateral = the bag's APEX (tether end).
    const anchorWorld = (typeof player.getNetBerthCollarPositionInto === 'function')
      ? player.getNetBerthCollarPositionInto(_v3c)
      : (typeof player.getNetPodPositionInto === 'function')
        ? player.getNetPodPositionInto(this.podIndex, _v3c) : _v3c.set(0, 0, 0);
    // As the apex nears the ring (p 0 → 1) the seat shrinks, the bag axis turns onto the ship axis and the lateral
    // offset dies, so at home the catch is exactly on the collar axis.
    const seatP = this._applySeatLaw(this._remainingM);
    _v3d.copy(anchorWorld)
      .addScaledVector(this._fwdLagged, this._remainingM * M_NET)
      .addScaledVector(this._lateral, 1 - seatP);

    // net.position = the bag's apex anchor (CaptureNetVisual seats the kit there × M; the tether draws to it);
    // written BEFORE the seat offset goes into the catch pin below.
    this.position.x = _v3d.x / M_NET;
    this.position.y = _v3d.y / M_NET;
    this.position.z = _v3d.z / M_NET;

    // The catch rides _catchSeatM metres INSIDE the bag along launchDirection, not AT the apex (else it sits on the
    // apex unwrapped: the metres gate's COLOCATION-DEFECT).
    if (this._catchSeatM) _v3d.addScaledVector(this.launchDirection, this._catchSeatM * M_NET);
    this._reelDistM = Math.hypot(_v3d.x - anchorWorld.x, _v3d.y - anchorWorld.y, _v3d.z - anchorWorld.z) / M_NET;

    // Orientation follows the ship plus the tumble-carryover offset (shared helper).
    this._applyCatchOrientation(d, player, dt);

    d._armPinned = true;
    d._captured = true;
    d._catchRenderMin = this._catchFloorScale(d, dt);
    debrisField.pinCapturedDebris(d, _v3d);

    // Tension readout (HUD), same shape as the daughter.
    this.tensionN = baseCaptureTensionN(this.capturedMass);

    // owner 2026-10-12: "Reel on mother costs": the net reel bills the battery while it turns: line tension × line
    // speed ÷ REEL_EFFICIENCY, floored at its 15 W motor, capped at HAUL_MOTOR_POWER. A corridor hold (no travel) and a
    // held-world frame (the ship's `_motorBillHeld`) bill nothing.
    const reelTravelM = Math.abs(this._remainingM - remBeforeM);
    if (dt > 0 && reelTravelM > 0 && player._motorBillHeld !== true) {
      const rs = player._resourceSystem;
      if (rs && typeof rs.billWatts === 'function') {
        const MD = Constants.MOTOR_DRAW_W || {};
        const mechW = Math.max(0, this.tensionN) * (reelTravelM / dt) / (MD.REEL_EFFICIENCY || 0.5);
        rs.billWatts(Math.min(MD.REEL_MAX ?? 2500, Math.max(MD.MOTHER_REEL_MIN ?? 15, mechW)), dt);
      }
    }

    // Completion → BERTHED. A queue-glide still travelling OUT to a timeout-raised standoff has NOT completed:
    // remainingM ≤ standoff is true from the WRONG side mid-glide (the berth hold would snap the pin outward).
    const glideIncomplete = this._corridorGlide && this._remainingM < berthStandoffM - 1e-9;
    if (!glideIncomplete && this._remainingM <= berthStandoffM + 1e-6) {
      this._transitionTo(STATES.BERTHED);
      this._berthTimer = CN.BERTH_SECURE_S ?? 4.0;
      eventBus.emit(Events.NET_REEL_COMPLETED, {
        armIndex:     this.armIndex,
        podIndex:     this.podIndex,
        capturedMass: this.capturedMass,
        debrisId:     d.id,
      });
      eventBus.emit(Events.NET_BERTHED, {
        debrisId: d.id,
        mass:     this.capturedMass,
        podIndex: this.podIndex,
      });
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `Catch secured at the collar. Securing ${Math.round(this.capturedMass)} kg…`,
        source: 'HOUSTON', priority: 'info',
      });
    }
  }

  /**
   * @private Recovery-corridor test, analytic (no mesh collision exists). The corridor is a cylinder along ship-local
   * +Z from the berth anchor (the COLLAR; the launch corridor is separate, owned by the fire-time foul read
   * getCollarShotFoul), radius = debris.sizeMeter/2 + BERTH_CLEARANCE_M. It must contain:
   *   1. NO strut tip (strutLocalDirection(α, az) × STRUT_LENGTH from the collar pivot; at α≈π a 1.70 m strut tip
   *      reaches ~2.5 m fore, past the muzzle plane at z ≈ 1.30 m; a forward-swept strut blocks whether or not it
   *      holds a catch);
   *   2. NO mated cargo (every OTHER mother net's docked catch, BERTHED/COLLARED/TRANSFERRING, is an obstacle, so a
   *      second catch holds at the gate instead of seating inside the occupant; a net's own catch exempts itself);
   *   3. NO radiator part and NO bag held on a radiator tip: a READ of the ship keep-out (`armManager.getKeepOut()`,
   *      exact triangles / spheres), ONLY categories 'rad' and spheres named 'tip bag N'. The catch is a capsule of
   *      radius sizeMeter/2 on the collar axis, from its CURRENT distance from the anchor (never nearer than home)
   *      down to its home distance; a part closer than REEL_HOME.CLEARANCE_M holds the reel. The cylinder is NOT
   *      applied to the radiators (it would hold every catch while they are closed: their tips sit inside it at
   *      2-13° though the real gap is >= 0.085 m). The home is not refreshed when the radiators move after reel
   *      entry: this read holds the reel and the timeout berths it. No keep-out (a mock armManager with only
   *      `arms`) -> this read passes.
   * A lassoed piece rides the same mother berth path (adoptLassoCatch), so it is never an obstacle to itself.
   * Evaluated SHIP-LOCAL with the origin at the berth anchor: attitude- and position-free.
   * @param {object} d — the caught debris (for the corridor radius)
   * @returns {boolean} true when the corridor is clear
   */
  _corridorClear(d) {
    const player = this._ctx?.player;
    if (!player || typeof player.getNetPodPositionInto !== 'function') return true;
    const V5 = Constants.OCTOPUS_V5;
    if (!V5) return true;

    const radiusM = (d.sizeMeter || 2) / 2 + (CN.BERTH_CLEARANCE_M ?? 1.0);
    const radiusSq = radiusM * radiusM;
    const M_NET = Constants.SCENE_UNITS_PER_METER;

    // Origin = the berth anchor: the collar, ON the axis at (0, 0, BERTH_COLLAR_Z_M), read from the anchor Object3D;
    // falls back to the launcher muzzle local (headless mocks), then to the documented constant.
    berthAnchorLocalInto(player, this.podIndex, _anchorLocal);
    const mx = _anchorLocal.x, my = _anchorLocal.y, mz = _anchorLocal.z;

    // Cylinder axis = ship-local +Z. INSIDE = z > 0 (fore of the muzzle plane; intruders aft can't be clipped by an
    // incoming catch) AND radial (x,y) distance from the axis < radiusM.
    const testLocal = (lx, ly, lz) => {
      if (lz <= 0) return false;                       // aft of the muzzle plane
      return (lx * lx + ly * ly) < radiusSq;
    };

    // 1. Strut tips, and the catches the daughters HOLD. The tip alone says nothing about a held catch's BODY, which
    // sits well off the tip (a 5 m catch above ~44° can stand in the corridor with its tip clear): read below.
    // Strut geometry is ship-local: pivot (cos az·collarR, sin az·collarR, collarY), tip = pivot +
    // strutLocalDirection(α, az) × STRUT_LENGTH. A tip fore of the muzzle plane (tipZ > 0) has radial
    // ≤ 2.10 m (DECISIONS §11: collarR 0.40 + STRUT_LENGTH 1.70), while the smallest whale-class corridor radius in
    // the catalog is 2.40 m (FENGYUN-1C, 2.8 m), so the tip test always fires first. Revisit if strut length, collar
    // radius or the minimum whale size closes that 0.30 m margin.
    const armManager = this._ctx?.armManager;
    const arms = armManager?.arms;
    if (arms && arms.length) {
      const strutLen = V5.STRUT_LENGTH ?? 1.70;
      const collarR  = V5.COLLAR_RADIUS ?? 0.40;
      const collarY  = V5.COLLAR_Y ?? 1.00;
      for (let i = 0; i < arms.length; i++) {
        const arm = arms[i];
        if (!arm) continue;
        const alpha = (typeof arm.getAimAlpha === 'function') ? arm.getAimAlpha() : Math.PI / 2;
        const azRad = degToRad(arm._azimuthDeg || 0);
        // ONE geometry (ArmDockBasis.strutTipFoulsCorridor), shared with ArmManager's lean-aside duck and re-pose
        // pre-check, so the duck never disagrees with this authoritative gate.
        if (strutTipFoulsCorridor(alpha, azRad, collarR, collarY, strutLen, _anchorLocal, radiusM)) {
          return false;
        }
        // owner 2026-10-22: "out of the way of mother net": a daughter's HELD catch is a body on her strut; above ~44°
        // a big one sits across this corridor although her tip does not. The drawn mesh of every rack piece at her LIVE
        // angle is read against the same cylinder (not `capturedDebris`, the in-hand haul, set long before the daughter
        // is back at the tip); a mock arm manager with no dock positions, or a held piece with no mass, is skipped.
        if (heldCargoFoulsCorridorAt(armManager, i, alpha, _anchorLocal, radiusM)) {
          return false;
        }
      }
    }

    // 2. Mated cargo: every OTHER mother net's docked catch is an obstacle to THIS approach (a second catch can come
    // home while the collar is occupied and would seat INSIDE the occupant: a continuity-law violation). The gate
    // holds at CORRIDOR_HOLD_M (10 m, 9 m clear of the occupant's near face, which sits exactly BERTH_CLEARANCE_M
    // fore of the collar plane at every class) and the timeout berths it at the extended standoff (a tandem hold).
    // A berthing net's OWN catch is exempt.
    const cns = this._ctx?.captureNetSystem;
    if (cns && Array.isArray(cns.activeNets) && player.quaternion) {
      const collarWorld = (typeof player.getNetBerthCollarPositionInto === 'function')
        ? player.getNetBerthCollarPositionInto(_v3c)
        : player.getNetPodPositionInto(this.podIndex, _v3c);
      _q0.copy(player.quaternion).invert();
      for (const other of cns.activeNets) {
        if (other === this || !other._isMother) continue;
        if (other.state !== STATES.BERTHED && other.state !== STATES.COLLARED
            && other.state !== STATES.TRANSFERRING) continue;
        const od = other.targetDebris;
        const sp = od && od.alive !== false ? od._scenePosition : null;
        if (!sp) continue;
        // Cargo centre in the corridor frame: q⁻¹·(pin − collarWorld), metres.
        _v3d.copy(sp).sub(collarWorld).applyQuaternion(_q0);
        if (testLocal(_v3d.x / M_NET, _v3d.y / M_NET, _v3d.z / M_NET)) return false;
      }
    }

    // 3. Radiators and tip bags: exact keep-out read (see the JSDoc); no radiator command is issued. A home found
    // earlier is not refreshed: radiators that moved since reel entry foul it and are caught HERE.
    let ko = null;
    try { ko = armManager && typeof armManager.getKeepOut === 'function' ? armManager.getKeepOut() : null; } catch (_e) { ko = null; }
    if (ko && typeof ko.segment === 'function') {
      try {
        const clearanceM = CN.REEL_HOME.CLEARANCE_M;
        const homeM = this._homeCatchM != null ? this._homeCatchM : catchHomeDistM(player, armManager, d);
        let farM = homeM;
        if (this._remainingM != null && this._homeSeatM != null) farM = Math.max(homeM, this._catchAxialAt(this._remainingM));
        _corrA[0] = mx; _corrA[1] = my; _corrA[2] = mz + farM;
        _corrB[0] = mx; _corrB[1] = my; _corrB[2] = mz + homeM;
        const azN = Constants.THERMAL?.FLOWER?.AZIMUTHS_DEG?.length ?? 4;
        _corrOpts.ignore = corridorIgnoreList(Math.max(arms ? arms.length : 0, azN));
        _corrOpts.margin = clearanceM;
        const res = ko.segment(_corrA, _corrB, (d.sizeMeter || 2) / 2, _corrOpts);
        const hits = res && res.hits;
        if (hits) {
          for (let i = 0; i < hits.length; i++) {
            const h = hits[i];
            if (h.cat !== 'rad' && !(typeof h.name === 'string' && h.name.startsWith('tip bag'))) continue;
            if (h.gap < clearanceM - 1e-6) return false;
          }
        }
      } catch (err) {
        if (!_corrKeepOutWarned) { _corrKeepOutWarned = true; console.warn('[CaptureNet] corridor keep-out read failed; the radiator/tip-bag read is skipped:', err); }
      }
    }

    return true;
  }

  /**
   * @private The level (metres from the berth anchor) at which THIS net's corridor gate must hold so its catch clears
   * the queue already at the station; 0 when no other mother net holds a position there. Reads the shared
   * `motherNetForeExtentM` (one fore-extent computation for both queue consumers, shared with the lasso pend):
   *   - members are nets HOLDING a station position: a corridor-held REELING net (its frozen `_corridorHoldLevelM`
   *     slot; the REELING guard keeps a stale hold flag from a MISSED net from counting) or a berthed / collared /
   *     transferring net (its berth standoff, via `_effectiveStandoffM`). An inbound net not yet at its gate is not a
   *     member: it takes its slot when its own gate engages (first-come, inner-most).
   *   - the level seats THIS catch's near face one BERTH_CLEARANCE_M past the deepest member's far face
   *     (near = level + _catchSeatM − sizeMeter/2), so two queued catches never freeze at the same level and co-locate.
   * The timeout's `extended` derives from this holdM, so a queue-raised hold berths at its queue-cleared level.
   * @param {object} d — this net's caught debris
   * @returns {number} metres
   */
  _queueHoldLevelM(d) {
    const cns = this._ctx?.captureNetSystem;
    if (!cns || !Array.isArray(cns.activeNets)) return 0;
    let ext = 0;
    for (const net of cns.activeNets) {
      if (net === this || !net._isMother || !net.isActive) continue;
      if (net.state === STATES.STOWED || net.state === STATES.RELEASED) continue;
      const od = net.targetDebris;
      if (!od || od.alive === false) continue;
      const { fore, atStation } = motherNetForeExtentM(net);
      if (!atStation) continue;                      // not at the station yet
      if (fore > ext) ext = fore;
    }
    if (ext <= 0) return 0;
    // near face = level + seat − half ≥ ext + clearance. The HOME seat is the smallest the hold can have, so the level
    // it gives is the conservative (largest) one.
    const seat = this._homeSeatM ?? this._catchSeatM ?? 0;
    const halfSelf = (d.sizeMeter || 2) / 2;
    return ext + (CN.BERTH_CLEARANCE_M ?? 1.0) + halfSelf - seat;
  }

  /**
   * Mother BERTHED per-frame hold (driven by CaptureNetSystem.update; the projectile's own switch no-ops on BERTHED).
   * Freezes the reel formula at the standoff: same pin API, same ship-relative frame.
   * @param {number} dt
   * @returns {boolean} false when the berth should tear down (dead target)
   */
  updateBerthHold(dt) {
    const d = this.targetDebris;
    const player = this._ctx?.player;
    const debrisField = this._ctx?.debrisField;
    if (!d || !player || !debrisField) return false;
    // NOT optional: this alive guard cleans up a mission transition (a BERTHED net survives getState holding a
    // debris ref that no longer exists).
    if (d.alive === false) return false;

    const M_NET = Constants.SCENE_UNITS_PER_METER;
    // HOME = the bag's mouth at the ring, the catch seated on the collar axis (CN.REEL_HOME; collar anchor = ring
    // plane z = 1.30, ON the axis, launcher muzzle 30 mm behind it): the seat the rigid complete-berth mate holds.
    // A corridor-timeout berth MUST hold at its extended standoff: recomputing the base one would slide the catch inward.
    if (this._homeSeatM == null) this._seedReelHome(d, player);
    const baseStandoffM = this._homeApexM;
    const berthStandoffM = Math.max(baseStandoffM, this._effectiveStandoffM ?? baseStandoffM);
    this._remainingM = berthStandoffM;

    this._settleFwdLagged(player, dt);

    // Berthed pendulum: the bundle swings on a critically damped spring (~0.5 Hz, decays ~5 s), re-excited by RCS
    // translation; an angular offset off the lagged-forward axis, applied as a lateral displacement at the standoff
    // distance. Semi-implicit (dt-robust at 30/120 fps). Garnish: dropped at LOW tier (the berth hold stays).
    // BERTHED only: a tethered berth swings, a collar mate is RIGID (BERTHED→COLLARED zeroes _pendulumAngle/Vel;
    // the residual _lateral then decays to the boresight as the guide cone re-centres the body over ~½ s).
    const collared = this.state === STATES.COLLARED;
    if (CN.BERTH_PENDULUM_ENABLED !== false && !collared) {
      const pOmega = 2 * Math.PI * (CN.BERTH_PENDULUM_FREQ_HZ ?? 0.5);
      const pZeta = 1.0;
      const pK = pOmega * pOmega, pC = 2 * pZeta * pOmega;
      // RCS re-excite: _rcsVelocity (scene-units/s) ÷ M_NET = m/s. MUST scale by dt: the kick is applied every frame
      // the RCS velocity is non-zero, so an unscaled kick was framerate-dependent (~2.1× at 120 vs 60 fps) and
      // saturated BERTH_PENDULUM_MAX_RAD in ~0.3 s. With dt the total kick is ∫v·dt = the RCS displacement in
      // metres, so the coefficient is rad/s of swing per metre of drift.
      if (player._rcsVelocity) {
        const rcsMps = player._rcsVelocity.length() / M_NET;
        this._pendulumVel += rcsMps * dt * (CN.BERTH_PENDULUM_RCS_EXCITE ?? 0.6);
      }
      // Spring toward the boresight, capped.
      const pAccel = -pK * this._pendulumAngle - pC * this._pendulumVel;
      this._pendulumVel += pAccel * dt;
      this._pendulumAngle += this._pendulumVel * dt;
      const pMax = CN.BERTH_PENDULUM_MAX_RAD ?? 0.06;
      if (Math.abs(this._pendulumAngle) > pMax) {
        this._pendulumAngle = Math.sign(this._pendulumAngle) * pMax;
        this._pendulumVel = 0;
      }
      if (Math.abs(this._pendulumAngle) > 1e-9) {
        // Swing direction: perpendicular to fwd, ship-local XZ plane (a yaw swing).
        _v3e.crossVectors(this._fwdLagged, _v3a.set(0, 1, 0).applyQuaternion(player.quaternion)).normalize();
        if (_v3e.lengthSq() > 1e-9) {
          const swingM = Math.tan(this._pendulumAngle) * berthStandoffM;
          this._lateral.addScaledVector(_v3e, swingM * M_NET);
        }
      }
    }

    const anchorWorld = (typeof player.getNetBerthCollarPositionInto === 'function')
      ? player.getNetBerthCollarPositionInto(_v3c)
      : (typeof player.getNetPodPositionInto === 'function')
        ? player.getNetPodPositionInto(this.podIndex, _v3c) : _v3c.set(0, 0, 0);
    // Seat and bag axis come from the last reel tick (`_applySeatLaw`); NOT re-derived here, so the nose reel
    // (fallback for a catch parked deeper than the line reaches) can still shrink `_catchSeatM`. At HOME the bag axis
    // follows the ship axis.
    const seatP = this._seatProgress(berthStandoffM);
    if (seatP >= 1 && this.launchDirection && this._fwdLagged) {
      this.launchDirection.x = this._fwdLagged.x; this.launchDirection.y = this._fwdLagged.y; this.launchDirection.z = this._fwdLagged.z;
    }
    _v3d.copy(anchorWorld)
      .addScaledVector(this._fwdLagged, berthStandoffM * M_NET)
      .addScaledVector(this._lateral, 1 - seatP);

    // net.position = the bag's apex anchor, written BEFORE the seat offset (as in _updateMotherReel), so the catch
    // stays seated INSIDE the bag.
    this.position.x = _v3d.x / M_NET;
    this.position.y = _v3d.y / M_NET;
    this.position.z = _v3d.z / M_NET;
    if (this._catchSeatM) _v3d.addScaledVector(this.launchDirection, this._catchSeatM * M_NET);
    this._reelDistM = Math.hypot(_v3d.x - anchorWorld.x, _v3d.y - anchorWorld.y, _v3d.z - anchorWorld.z) / M_NET;

    this._applyCatchOrientation(d, player, dt);

    d._armPinned = true;
    d._captured = true;
    // The mother hold owns this position from berth entry: freeze the catch's own orbit propagation (DebrisField
    // skips only _onboardingPinned otherwise) so a later jettison re-seats from the pin, not a drifted orbit.
    d._motherParked = true;
    d._catchRenderMin = this._catchFloorScale(d, dt);
    debrisField.pinCapturedDebris(d, _v3d);
    if (this._noseAdopted) {
      // The ship pose this pin was made against. The pin is written at the END of a frame (captureNetSystem.update runs
      // after armManager.update) and the daughter's tug check reads it at the START of the next, after player.update
      // has moved the ship (~2.6 km a frame at the game clock): against the live pose the catch is always "2.6 km off".
      (this._holdShipPos ||= new THREE.Vector3()).copy(player.position);
      (this._holdShipQuat ||= new THREE.Quaternion()).copy(player.quaternion);
      this._holdSeq = this._ctx?.captureNetSystem?._frameSeq ?? 0;
    }
    return true;
  }

  /**
   * The ship pose (position, attitude) the catch's last pin was made against, for a daughter's tug check to read
   * `target._scenePosition` in the frame it was pinned in. null when this net did not pin in the system's latest
   * update (its hold stopped): the check then counts the hand-over as not held.
   * @returns {{pos:THREE.Vector3, quat:THREE.Quaternion}|null}
   */
  lastPinFrame() {
    if (!this._holdShipPos || !this._holdShipQuat) return null;
    const sys = this._ctx?.captureNetSystem;
    if (sys && this._holdSeq !== sys._frameSeq) return null;
    return { pos: this._holdShipPos, quat: this._holdShipQuat };
  }

  /**
   * @private The reel/berth rotation-lag spring: runs the ship forward through a critically damped spring (~0.8 Hz
   * settle) so a mid-reel slew doesn't whip the catch, and decays the lateral offset toward the boresight.
   * Writes _fwdLagged + _lateral.
   * @param {object} player — mother ship (quaternion read)
   * @param {number} dt — seconds
   */
  _settleFwdLagged(player, dt) {
    const fwdTarget = _v3a.set(0, 0, 1).applyQuaternion(player.quaternion).normalize();
    const omega = 2 * Math.PI * 0.8;                    // ~0.8 Hz settle
    const zeta = 1.0;                                   // critically damped
    const k = omega * omega, c = 2 * zeta * omega;
    _v3b.copy(fwdTarget).sub(this._fwdLagged);          // displacement
    this._fwdLagged.addScaledVector(_v3b, Math.min(1, k * dt * dt + c * dt));
    this._fwdLagged.normalize();
    this._lateral.multiplyScalar(Math.max(0, 1 - 2.0 * dt));
  }

  /**
   * @private Shared reel/berth orientation: ship-rigid attitude plus the tumble carryover, an extra rotation about
   * the ship-local X (pitch) axis (the tug's angular kick axis), decaying over TUMBLE_CARRYOVER_DECAY_S. The residual
   * spin is ACCUMULATED: `_tumbleCarryAngle` integrates `_tumbleCarryover × dt` (mod 2π), so the catch visibly spins
   * down in the bag. The accumulated angle outlives the rate on purpose (see the in-body note).
   * @param {object} d — the caught debris (tumbleAxis/tumbleAngle written)
   * @param {object} player — mother ship (quaternion read)
   * @param {number} dt — seconds
   */
  _applyCatchOrientation(d, player, dt) {
    if (!this._qLocal || !d.tumbleAxis) return;
    _q0.copy(player.quaternion).multiply(this._qLocal);
    if (CN.TUMBLE_CARRYOVER_ENABLED !== false) {
      // Integrate while the RATE is alive…
      if (this._tumbleCarryover > 1e-6) {
        this._tumbleCarryAngle = (this._tumbleCarryAngle + this._tumbleCarryover * dt) % (2 * Math.PI);
        // Decay the residual (exponential, dt-robust).
        this._tumbleCarryover *= Math.exp(-dt / (CN.TUMBLE_CARRYOVER_DECAY_S ?? 5.0));
      }
      // …but KEEP APPLYING the accumulated angle after the rate dies: a spun-down catch must not teleport back to its
      // pre-tumble attitude. Gating both behind `> 1e-6` snaps up to ∫0.6·e^(−t/5)dt = 3 rad ≈ 172° on any catch held
      // past ~66 s (corridor timeout / long berth hold).
      if (this._tumbleCarryAngle !== 0) {
        _q1.setFromAxisAngle(_v3e.set(1, 0, 0), this._tumbleCarryAngle);
        _q0.multiply(_q1);
      }
    }
    const w = clamp(_q0.w, -1, 1);
    const angle = 2 * Math.acos(w);
    const s = Math.sqrt(Math.max(0, 1 - w * w));
    if (s > 1e-6) d.tumbleAxis.set(_q0.x / s, _q0.y / s, _q0.z / s);
    else d.tumbleAxis.set(0, 1, 0);
    d.tumbleAngle = angle;
    // `d` is a snapshot in the real game; the drawn object is the field's canonical one. Mirror the pair there, or the
    // nose hold's attitude never reaches the screen.
    mirrorCatchAttitude(d, this._ctx?.debrisField);
  }

  /** @private Roll cling probability and resolve capture */
  _resolveCatch() {
    // Dead-target guard: the body may have been removed (fragmented, deorbited) while the net was wrapping.
    if (this.targetDebris && this.targetDebris.alive === false) {
      this._miss('target_lost');
      return;
    }

    // ASPECT_CAPTURE: the presented width at CONTACT decides whether the mouth can swallow the body; broadside on an
    // oversize presentation is a deterministic bounce, not a bad roll (the one mouth-fit predicate).
    if (Constants.isFeatureEnabled('ASPECT_CAPTURE') && this.targetDebris) {
      this._presentedWidthM = presentedWidthForApproach(this.targetDebris, this.launchDirection);
      if (!fitsMouth(this.targetDebris, this.netClass, this.launchDirection, this._presentedWidthM)) {
        this._miss('oversize_aspect');
        return;
      }
    }

    const pBase = this.captureMode === MODES.CINCH
      ? CN.CINCH_P_BASE.RIGHT_HARDER   // 0.93
      : CN.SLAM_P_BASE.RIGHT_HARDER;   // 0.80

    const params = {
      pBase,
      vRel:            this.speed,
      vOptimal:        this.netClass.LAUNCH_SPEED,
      range:           this.distanceTraveled,
      // NEUTRALIZED: resolve-time spin never reads above design. Raw spinRate/SPIN_HZ exceeds 1 only in the launch
      // transient (CAST_WINDUP 0.15 s + SPIN_UP_TIME 0.5 s, folded canister despinning from 3× to 1×), which is
      // unreachable in the live FSM (contact checks exist only in FLIGHT; _updateSpinningUp exits at exactly SPIN_HZ).
      // The clamp pins that boundary against FSM edits: unclamped, up to 3.0 would ride computeClingProbability's
      // f_spin ceiling (min(1.2, ·)) into a hidden +20% point-blank cling bonus. Not kept as a reward because the
      // close-range reward is already priced (§12.2: ≤ 25 m is sure-shot ≥ 0.80), the 3× transient is an
      // animation-legibility artifact (§11.6), and ToolOdds.estimateSpinFractionAtContact is in [0, 1], so the HUD
      // could never show it ("honest numbers"). Pinned in test-CaptureNet-Bookkeeping.js.
      spinFraction:    Math.min(this.spinRate / this.netClass.SPIN_HZ, 1.0),
      tensionFraction: 1.0,
      contactFraction: 1.0,
      roughness:       this.targetDebris?.surfaceRoughness || 1.0,
      // A high-tumble target sheds the net: detumble it first (mother laser).
      targetTumbleRate: Constants.isFeatureEnabled('LASER_DESPIN')
        ? (this.targetDebris?.tumbleRate ?? null)
        : null,
    };

    this._clingProbability = computeClingProbability(params);
    this._clingRoll = Math.random();

    // The frag risk is ROLLED: handleFragmentation (mercy rule) → NET_FRAGMENTATION; INTERACTION_FRAGMENTATION →
    // KesslerSystem counts it and DebrisField sheds/replaces the body.
    this._fragRisk = computeFragRisk({
      netMass:         this.netClass.MASS,
      vRel:            this.speed,
      targetFragility: effectiveFragility(this.targetDebris),
      range:           this.distanceTraveled,
    });
    const fragRoll = (this._fragRollOverride != null) ? this._fragRollOverride : Math.random();
    if (this.targetDebris && fragRoll <= this._fragRisk) {
      const sev = resolveFragSeverity({
        brittleness: this.targetDebris.brittleness ?? 0.5,
        vRel: this.speed,
        vOptimal: this.netClass.LAUNCH_SPEED,
        countRoll: (this._fragCountRollOverride != null) ? this._fragCountRollOverride : Math.random(),
      });
      this._fragSeverity = sev.tier;
      captureNetSystem.handleFragmentation(this.targetDebris.id, sev.fragmentCount);
      eventBus.emit(Events.INTERACTION_FRAGMENTATION, {
        debrisId:     this.targetDebris.id,
        fragments:    sev.fragmentCount,
        severity:     sev.tier,
        destroyTarget: sev.destroyTarget,
        mass:         this.targetDebris.mass || 1,
        source:       'net_contact',
      });
      if (sev.destroyTarget) {
        // Breakup / shatter: the body the net wrapped no longer exists.
        this._miss('fragmented');
        return;
      }
      // Crack: 1-2 frags shed, the capture itself continues to the cling roll.
    }

    const clingRoll = (this._clingRollOverride != null) ? this._clingRollOverride : this._clingRoll;
    if (clingRoll <= this._clingProbability) {
      this._captureSuccess();
    } else {
      this._miss('cling_failed');
    }
  }

  /**
   * Line-taut tug (mother path only, Phase B §9.8–9.10). At CAPTURED the whale's residual momentum relative to the
   * Mother transfers through the net (about 5:1 mass ratio at her start mass: her 1,500 kg catch limit vs 294 kg;
   * NET_TUG_MAX_DV_MS caps it):
   *   1. Feel: spread over NET_TUG_WINDOW_S into _rcsVelocity by the windowed delivery in CaptureNetSystem.update
   *      (Σ(step/window) === 1 at any frame rate). Never mutates the orbit. NET_TUG_FEEL_MULT scales it; the ~2×
   *      transient (the same magnitude drives orbit + _rcsVelocity) is deliberate. RCS_DAMPING decay is shared with
   *      manual RCS, deliberately out of scope.
   *   2. Orbit: the capped Δv goes once through applyCartesianImpulse with { noBill: true } (no fuel/battery, ignores
   *      power gates). Keep-or-cancel by design: cancellable with RCS, NOT auto-nulled. A false return means the
   *      altitude-envelope guard refused it: comms must say "tug damped — envelope limit", not claim kept Δv.
   *   3. Angular kick: τ_x = r_y·F_z, the ROW_DZ muzzle lever (±6 cm in ship Y) × the AXIAL tug (the one term
   *      _applyMotherNetRecoil models). Signed so a forward pull pitches opposite to an aft recoil. RCS springs it
   *      back (~2 s, ζ=1); attitude hold survives.
   * relVel = the catch's orbital velocity (orbitToSceneCartesianInto on its own elements; it keeps propagating while
   * pinned) minus the Mother's getVelocity(), sampled once at the taut moment.
   * @private
   */
  _applyCaptureTug() {
    if (this._tugApplied) return;
    this._tugApplied = true;
    const d = this.targetDebris;
    const player = this._ctx?.player;
    if (!d || !player || !d.orbit) return;
    if (typeof player.applyCartesianImpulse !== 'function') return;
    if (typeof player.getVelocity !== 'function') return;

    // A tease-pinned catch rides the mother's frame (~0 relative velocity), but orbit propagation is skipped while
    // _onboardingPinned, so its elements carry a stale velocity (measured ~1.2 km/s phantom after a ~95 s pin).
    if (d._onboardingPinned) return;

    orbitToSceneCartesianInto(d.orbit, _tugScratchPos, _tugScratchVel);   // km/s
    const shipV = player.getVelocity();
    // catch − ship, km/s → m/s
    const rvx = (_tugScratchVel.x - shipV.x) * 1000;
    const rvy = (_tugScratchVel.y - shipV.y) * 1000;
    const rvz = (_tugScratchVel.z - shipV.z) * 1000;
    const relSpeed = Math.sqrt(rvx * rvx + rvy * rvy + rvz * rvz);
    if (relSpeed < 1e-3) return;   // matched velocity → no tug

    // The ship's share of the velocity change is m_catch/(m_catch + m_ship) of v_rel, capped.
    const mCatch = d.mass || this.capturedMass || 1;
    const mShip = player.mass || 130;
    const share = mCatch / (mCatch + mShip);
    const cap = CN.NET_TUG_MAX_DV_MS ?? 0.5;
    const dvMag = Math.min(relSpeed * share, cap);

    // The tether drags the Mother after the whale.
    const inv = 1 / relSpeed;
    const dvWorld = _v3e.set(rvx * inv, rvy * inv, rvz * inv).multiplyScalar(dvMag);

    // Snapshot into plain locals BEFORE the impulse call: it synchronously emits COMMS_MESSAGE / THRUST_VISUAL /
    // RESOURCE_CONSUME, and a listener re-entering CaptureNet would clobber the module scratch (_v3e/_v3b/_q0).
    let localTugX = 0, localTugY = 0, localTugZ = 0;
    if (player.quaternion) {
      _q0.copy(player.quaternion).invert();
      _v3b.copy(dvWorld).applyQuaternion(_q0);   // tug dir in ship frame (m/s)
      localTugX = _v3b.x; localTugY = _v3b.y; localTugZ = _v3b.z;
    }

    // (2) orbit impulse
    const applied = player.applyCartesianImpulse(dvWorld, 0, { noBill: true });

    // (1) feel: seed the windowed delivery (CaptureNetSystem.update). 1e-5 scene units per metre.
    const windowS = CN.NET_TUG_WINDOW_S ?? 0.65;
    const feelMult = CN.NET_TUG_FEEL_MULT ?? 1.0;
    if (player._rcsVelocity && feelMult > 0 && windowS > 0) {
      if (!this._tugFeelScene) this._tugFeelScene = new THREE.Vector3();
      this._tugFeelScene.copy(dvWorld).multiplyScalar(1e-5 * feelMult);
      this._tugElapsed = 0;
    }

    // (3) angular kick
    if (player.quaternion && typeof player.mass === 'number') {
      const muzzles = player._netPodMuzzles;
      const muzzle = muzzles && muzzles[this.podIndex];
      const muzzleLocalY = muzzle ? muzzle.position.y : 0;
      if (Math.abs(muzzleLocalY) > 1e-9) {
        // Angular impulse ∝ momentum × lever / I, the recoil shape: I = m·0.25.
        const I = mShip * 0.25;
        const leverM = Math.abs(muzzleLocalY) / 1e-5;   // scene units → metres
        const j = mShip * dvMag;                        // N·s (kg·m/s)
        const pitchSign = muzzleLocalY >= 0 ? -1 : 1;
        // Signed axial: −Z (aft, the recoil case) → +1 (reduces exactly to _applyMotherNetRecoil); +Z → −1.
        const axial = clamp(-localTugZ / Math.max(1e-9, dvMag), -1, 1);
        player._recoilPitchVel += pitchSign * (j * leverM / I) * axial;
      }
    }

    if (applied) {
      const dirTag = Math.abs(localTugZ) > Math.max(Math.abs(localTugX), Math.abs(localTugY))
        ? (localTugZ > 0 ? 'prograde' : 'retrograde') : 'lateral';
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `Tug absorbed: ${dvMag.toFixed(2)} m/s ${dirTag}.`,
        source: 'HOUSTON', priority: 'info',
      });
    } else {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Tug damped — envelope limit.',
        source: 'HOUSTON', priority: 'info',
      });
    }

    // CameraSystem listens: whale-only shake scaled by imparted Δv, skipped under prefers-reduced-motion (§9.11).
    eventBus.emit(Events.NET_MOTHER_TUG, {
      podIndex: this.podIndex,
      dvMs: applied ? dvMag : 0,
      windowS,
    });
  }

  /**
   * DECISIONS §38 row 5: a DAUGHTER's net that closed on its target keeps every other catchable piece in its mouth too,
   * in ONE bag (`DebrisField.mergeIntoBag`; members, mouth volume, fit and bag size: `scoopRule.js`). One piece in the
   * mouth: nothing changes. The mother's net never scoops. Called once, before the mass and the events read
   * `targetDebris`: from here on everything downstream holds the bag.
   * @private
   * @returns {object|null} the bag, or null when nothing was scooped
   */
  _scoopIntoBag() {
    if (this._scooped || this._isMother || !(this.armIndex >= 0)) return null;
    const target = this.targetDebris;
    // a daughter's net carries no `_ctx`: use the system's field handle, as `canonicalOf` does
    const field = (this._ctx && this._ctx.debrisField) || (captureNetSystem && captureNetSystem._debrisField) || null;
    if (!target || target.isBag === true || !field || typeof field.mergeIntoBag !== 'function'
        || !Array.isArray(field.debrisList)) return null;
    const arm = this._sourceArm || null;
    const rated = (arm && arm._netRatedMass > 0) ? arm._netRatedMass : (this.netClass.MAX_CAPTURE_MASS || Infinity);
    // the net may hold a snapshot of its target (`canonicalOf`): members must be the field's own objects
    const canon = (typeof field.getDebrisById === 'function' && target.id != null && field.getDebrisById(target.id)) || target;
    if (canon.alive === false) return null;
    const { members } = pickScoopMembers(canon, field.debrisList, this.netClass, {
      mouthOffsetM: this._mouthOffsetM,
      mouthAxis: this._mouthAxis,
      armId: arm && arm.id != null ? arm.id : null,
      ratedMassKg: rated,
    });
    if (members.length < 2) return null;
    const bag = field.mergeIntoBag(members, this);
    if (!bag) return null;
    this._scooped = true;
    this.targetDebris = bag;
    if (arm) arm.target = bag;            // ArmUnit's net poll adopts it too (its `reelCaught` test compares the two)
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: scoopLine((arm && arm.displayName) || 'Daughter', members.length),
      source: 'SYSTEM', channel: 'CMD', priority: 'info',
    });
    return bag;
  }

  /** @private Transition to CAPTURED + emit event */
  _captureSuccess() {
    this._scoopIntoBag();
    this.catchResult = 'success';
    this.capturedMass = this.targetDebris?.mass || 1.0;
    this.tangleQuality = this._clingProbability;
    this._transitionTo(STATES.CAPTURED);

    // Line-taut tug (Phase B §9). ORDER: before the event emits, so its comms/camera payloads read as part of the
    // capture beat. Mother path only (the daughter's arm absorbs its own momentum).
    if (this._isMother) this._applyCaptureTug();

    eventBus.emit(Events.NET_CATCH_SUCCESS, {
      armIndex:      this.armIndex,
      podIndex:      this.podIndex,
      debrisId:      this.targetDebris?.id,
      tangleQuality: this.tangleQuality,
      capturedMass:  this.capturedMass,
      mode:          this.captureMode,
    });

    if (FEATURE_FLAGS.NET_CEREMONY && !this._ceremonyCompleteEmitted) {
      this._ceremonyCompleteEmitted = true;
      eventBus.emit(Events.NET_CEREMONY_COMPLETE, {
        armIndex: this.armIndex,
        podIndex: this.podIndex,
        mode:     this.captureMode,
        success:  true,
      });
    }
  }

  /** @private Transition to MISSED + emit event */
  _miss(reason) {
    this.catchResult = 'miss';
    this._transitionTo(STATES.MISSED);
    // a staged reason (bounce/slip) holds MISSED for FAILURE_STAGING_S in the system's auto-reel; unstaged reasons
    // auto-reel the same tick
    this._failureKind = missFailureKind(reason);
    // A miss can fire AFTER CAPTURED→REELING (the mother strain roll at reel entry), which set _resultProcessed in
    // CaptureNetSystem.update(). Reset it, or needsAutoReel never re-arms and the net strands in MISSED forever
    // (never pruned, inventory never restored, pins never cleared).
    this._resultProcessed = false;

    eventBus.emit(Events.NET_CATCH_MISS, {
      armIndex:    this.armIndex,
      podIndex:    this.podIndex,
      debrisId:    this.targetDebris?.id,
      probability: this._clingProbability,
      reason,
    });

    if (FEATURE_FLAGS.NET_CEREMONY && !this._ceremonyCompleteEmitted) {
      this._ceremonyCompleteEmitted = true;
      eventBus.emit(Events.NET_CEREMONY_COMPLETE, {
        armIndex: this.armIndex,
        podIndex: this.podIndex,
        mode:     this.captureMode,
        success:  false,
      });
    }
  }

  /**
   * Start reel-in (player command after catch or miss).
   * @returns {boolean} Whether reel started
   */
  startReel() {
    if (this.state !== STATES.CAPTURED && this.state !== STATES.MISSED) return false;
    this._transitionTo(STATES.REELING);
    this.reelProgress = 0;

    eventBus.emit(Events.NET_REEL_STARTED, {
      armIndex: this.armIndex,
      podIndex: this.podIndex,
      hasCatch: this.catchResult === 'success',
    });
    return true;
  }

  /**
   * Release / abort: let debris and net go; the net is consumed. From BERTHED/COLLARED this is the manual jettison
   * ([K]): clears pins, re-seats the orbit, frees the launcher, cancels a running securing timer. A COLLARED catch
   * was already credited (not revoked).
   * @returns {boolean} Whether release occurred
   */
  release() {
    if (this.state !== STATES.CAPTURED &&
        this.state !== STATES.REELING &&
        this.state !== STATES.FLIGHT &&
        this.state !== STATES.BERTHED &&
        this.state !== STATES.COLLARED) return false;

    const wasBerthed = this.state === STATES.BERTHED || this.state === STATES.COLLARED;
    // Mid-cook jettison: stop the breakdown beat. Unflown chunks + the ghost bag dispose WITHOUT the draw-in; chunks
    // already committed keep flying to the bus. The half-cooked piece keeps its _digestProgress.
    const dPre = this.targetDebris;
    if (dPre && dPre._breakdownActive) {
      dPre._breakdownActive = false;
      eventBus.emit(Events.CATCH_BREAKDOWN_CANCEL, {
        armId: 'mother', debrisId: dPre.id,
        anchor: { kind: 'collar', podIndex: this.podIndex },
      });
    }
    this._transitionTo(STATES.RELEASED);
    this.capturedMass = 0;
    this.isActive = false;
    this._berthTimer = -1;

    eventBus.emit(Events.NET_RELEASED, {
      armIndex: this.armIndex,
      podIndex: this.podIndex,
      debrisId: this.targetDebris?.id,
    });
    if (wasBerthed) {
      // The mass left the berthed ledger (RELEASED drops out of getBerthedMassKg), but no NET_RELEASED listener
      // invalidates the attitude inertia: do it here (a mass-exit that crosses no arm-state change).
      const player = this._ctx?.player;
      if (player && '_attitudeInertia' in player) player._attitudeInertia = null;
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Catch released — net expended, launcher clear.',
        source: 'HOUSTON', priority: 'info',
      });
    }
    return true;
  }

  /**
   * Force a deterministic result (tests / scripted events); bypasses the random roll.
   * @param {boolean} success — true for catch, false for miss
   * @param {number} [probability=1.0] — cling probability to report
   */
  forceResolve(success, probability = 1.0) {
    this._clingProbability = probability;
    this._clingRoll = success ? 0 : 1;
    if (success) {
      this._captureSuccess();
    } else {
      this._miss('forced');
    }
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// §3  CaptureNetSystem — Fleet-Wide Net Manager
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Manages all active net projectiles, mother pod inventory, cooldowns,
 * and provides query APIs for HUD (§ST-9.4e).
 *
 * Singleton, gated behind FEATURE_FLAGS.CAPTURE_NET.
 */
export class CaptureNetSystem {
  constructor() {
    /** @type {NetProjectile[]} Active nets in flight / capture / reel */
    this.activeNets = [];

    // Mother Large Net launcher inventory: one entry per launcher (one-element [count] at MOTHER_POD_COUNT = 1).
    this._motherPodInventory = new Array(this._motherPodCount()).fill(0);
    this._motherPodMax       = new Array(this._motherPodCount()).fill(0);

    // Line-fibre tier (Constants.TETHER_TIERS index) and the mother's net capacity at that tier (DECISIONS §33 row 5:
    // 4 / 6 / 8 / 10 / 10). Set by ArmManager.applyTetherUpgrade through setMotherNetCapacity; survives GAME_RESET
    // and reset() (a bought upgrade, like the tether tier itself).
    this._motherNetTier = 0;
    this._motherNetCapacity = CN.LARGE.MAGAZINE_SIZE;

    /** @type {Map<string, number>} Cooldown timers keyed by 'pod_0', 'arm_3', etc. */
    this._cooldownTimers = new Map();

    /** u20-nose fix 2: counts `update()` calls; an adopted net stamps it when it pins the catch (`lastPinFrame`). */
    this._frameSeq = 0;

    this._initialized = false;

    // First-fragmentation mercy rule (§5.7)
    this._playerHasFragmented = false;

    /** @type {object|null} Injected deps: stored by init(deps) BEFORE the feature-flag check, so a flag-off init
     *  still leaves them usable if the flag flips on later. */
    this._player = null;
    this._debrisField = null;
    /** @type {object|null} Optional (winch pitch, Phase B §9.3); optional-chained so headless tests stay silent. */
    this._audioSystem = null;
    /** @type {object|null} Optional: the recovery-corridor test (strut tips, held daughter catches, lasso cargo
     *  cells). Absent ⇒ corridor vacuously clear. */
    this._armManager = null;
    this._lassoSystem = null;
  }

  /**
   * Initialise inventory to Dyneema Y0 defaults (game start / after load).
   * @param {object} [deps] — { player, debrisField, audioSystem, armManager, lassoSystem } context references.
   *   `player` backs the mother-pod anchor provider; `debrisField` the pin API (pinCapturedDebris); `audioSystem`
   *   the winch pitch; `armManager`/`lassoSystem` the recovery-corridor test. Optional: no-arg stays valid for
   *   headless tests and test-main-wiring.
   */
  init(deps = {}) {
    this._player = deps.player || this._player || null;
    this._debrisField = deps.debrisField || this._debrisField || null;
    this._audioSystem = deps.audioSystem || this._audioSystem || null;
    this._armManager = deps.armManager || this._armManager || null;
    this._lassoSystem = deps.lassoSystem || this._lassoSystem || null;
    // Room appearing (a tip slot or a rack cell freeing, both emit NET_CONSUMED synchronously) re-arms a declined
    // collar catch in the same tick. Re-subscribed on every init so a cleared bus cannot orphan it.
    if (this._unsubNetConsumed) this._unsubNetConsumed();
    this._unsubNetConsumed = eventBus.on(Events.NET_CONSUMED, (p) => this._onRoomFreed(p));
    // DECISIONS §33: a new game, or a restart after game over, gives the mother her 4 nets back (GameFlowManager.resetGame
    // emits GAME_RESET). reset() is NOT used here: it zeroes the count.
    if (this._unsubGameReset) this._unsubGameReset();
    this._unsubGameReset = eventBus.on(Events.GAME_RESET, () => this._reseedMotherNets());
    if (!Constants.FEATURE_FLAGS.CAPTURE_NET) return;

    this._motherPodInventory = new Array(this._motherPodCount()).fill(this._motherNetCapacity);
    this._motherPodMax       = new Array(this._motherPodCount()).fill(this._motherNetCapacity);
    this._initialized = true;

    this._emitMotherInventory(true);
  }

  /**
   * NET_INVENTORY_CHANGED for the mother's one count. Every mother emit carries `motherNets` (the total): the HUD, the
   * autopilot arrival line and the onboarding director read that one number. `withMax` adds the capacity array.
   * @private
   * @param {boolean} [withMax=false]
   */
  _emitMotherInventory(withMax = false) {
    const payload = {
      source: 'mother',
      podInventory: [...this._motherPodInventory],
      motherNets: this.getMotherNetCount(),
    };
    if (withMax) payload.podMax = [...this._motherPodMax];
    eventBus.emit(Events.NET_INVENTORY_CHANGED, payload);
  }

  /**
   * GAME_RESET: reseed the magazine to full at the current line-fibre capacity (4 at the start tier; the tier
   * survives a reset). Flag-gated like init(); a bus reset before init() still leaves a full magazine for the game
   * that follows.
   * @private
   */
  _reseedMotherNets() {
    if (!Constants.FEATURE_FLAGS.CAPTURE_NET) return;
    this._motherPodInventory = new Array(this._motherPodCount()).fill(this._motherNetCapacity);
    this._motherPodMax       = new Array(this._motherPodCount()).fill(this._motherNetCapacity);
    this._emitMotherInventory(true);
  }

  /**
   * Per-frame update: advance all active net projectiles + cooldowns.
   * @param {number} dt — delta time (seconds)
   */
  update(dt) {
    if (!Constants.FEATURE_FLAGS.CAPTURE_NET) return;
    this._frameSeq++;

    // Tick cooldowns
    for (const [key, remaining] of this._cooldownTimers.entries()) {
      const next = remaining - dt;
      if (next <= 0) {
        this._cooldownTimers.delete(key);
      } else {
        this._cooldownTimers.set(key, next);
      }
    }

    // The flight whistle means "a net projectile is in flight" for EITHER launcher family. AudioSystem keeps ONE
    // whistle instance, so the stop must be "no active net is in a flight state", not "this net left flight": a
    // berthed mother net at the collar would otherwise kill a flying daughter's whistle every frame.
    let anyNetInFlight = false;
    for (let i = this.activeNets.length - 1; i >= 0; i--) {
      const net = this.activeNets[i];
      const prevState = net.state;

      net.update(dt);

      // Catches in-loop transitions AND external state changes (e.g. forceResolve between updates)
      const needsAutoReel = (net.state === STATES.CAPTURED || net.state === STATES.MISSED)
        && !net._resultProcessed
        // a staged miss holds at the contact point for FAILURE_STAGING_S (wall-clock dt); startReel() cuts it short
        && !(net.state === STATES.MISSED && net._failureKind
             && net.stateTimer < (CN.FAILURE_STAGING_S ?? 0));
      if (needsAutoReel) {
        net._resultProcessed = true;
        const cooldown = net.catchResult === 'success'
          ? CN.COOLDOWN_CATCH
          : CN.COOLDOWN_MISS;
        const key = net.armIndex >= 0 ? `arm_${net.armIndex}` : `pod_${net.podIndex}`;
        this._cooldownTimers.set(key, cooldown);

        // Daughter captures are hauled home by the ArmUnit: hold the net's reel (bag stays cinched) so the catch
        // doesn't vanish mid-haul; _updateReeling releases the hold once the debris is unpinned. Mother captures
        // (podIndex≥0) and misses reel/stow normally.
        if (net.armIndex >= 0 && net.catchResult === 'success') {
          net._heldByArm = true;
        }

        net.startReel();
      }

      // Whistle poll: a state poll, NOT the NET_BRAKE_FIRED hook (gated on FEATURE_FLAGS.NET_CEREMONY, and nothing
      // load-bearing may route through a flag REALITY_MODE forces false). BEFORE any `continue` below, so every net is
      // counted every frame.
      if (net.state === STATES.LAUNCHING
          || net.state === STATES.SPINNING_UP
          || net.state === STATES.FLIGHT) {
        anyNetInFlight = true;
      }

      if (net._isMother) {
        // §9.8 dt-robust tug delivery: the feel vector seeded at CAPTURED goes into _rcsVelocity over
        // NET_TUG_WINDOW_S; step is clamped to the remaining window, so Σ(step/window) === 1 at any frame rate.
        if (net._tugFeelScene && net._tugElapsed < (CN.NET_TUG_WINDOW_S ?? 0.65)) {
          const player = this._player;
          if (player && player._rcsVelocity) {
            const windowS = CN.NET_TUG_WINDOW_S ?? 0.65;
            const step = Math.min(dt, windowS - net._tugElapsed);
            net._tugElapsed += step;
            player._rcsVelocity.addScaledVector(net._tugFeelScene, step / windowS);
            // mirror LassoSystem._applyReelPhysics: the tug must not stack past RCS_MAX_SPEED on drift
            const maxV = Constants.RCS_MAX_SPEED;
            if (maxV > 0 && player._rcsVelocity.length() > maxV) {
              player._rcsVelocity.normalize().multiplyScalar(maxV);
            }
          } else {
            net._tugElapsed = CN.NET_TUG_WINDOW_S ?? 0.65;   // no player: close the window
          }
        }

        // §9.3: winch pitch from the live reel distance
        if (net.state === STATES.REELING && net._remainingM != null) {
          this._audioSystem?.updateNetReelPitch?.(net._remainingM, net._reelSeedM);
        }
      }

      // Mother BERTHED/COLLARED hold + securing timer (§8 A2). The projectile's own switch no-ops on both states;
      // the hold runs here because the system owns the player/debrisField refs. It survives pruning (isActive stays
      // true, state never STOWED/RELEASED) and keeps running in the terminal state: if the pin ever stops, the catch
      // falls back to the orbit branch and reads as released.
      if (net.state === STATES.BERTHED || net.state === STATES.COLLARED) {
        const holding = net.updateBerthHold(dt);
        if (!holding) {
          // Dead target while docked (§4.19 mission-transition guard): clear dock, pins and visual, free the
          // launcher. Do NOT stow as if the catch succeeded.
          this._teardownBerth(net);
          this.activeNets.splice(i, 1);
          continue;
        }
        if (net.state === STATES.BERTHED && !net._berthProcessed && net._berthTimer > 0) {
          net._berthTimer -= dt;
          if (net._berthTimer <= 0) {
            // §19 terminal credit: GameFlowManager's CATCH_PROCESSED path awards score + salvage + autosave.
            // { parked: true } skips ONLY the field removal: the body is KEPT, MATED at the nose berthing collar
            // inside its net. No teardown, no splice: the hold above keeps pinning the catch every frame.
            net._berthProcessed = true;
            eventBus.emit(Events.CATCH_PROCESSED, {
              debrisId: net.targetDebris?.id,
              armId:    null,
              source:   'mother',
              podIndex: net.podIndex,
              method:   'mother',
              parked:   true,
            });
            // A rigid mate does not swing: the berth pendulum (BERTHED only, updateBerthHold) must not carry energy
            // across the mate. The residual _lateral decays to the boresight inside the hold (no snap).
            net._pendulumAngle = 0;
            net._pendulumVel = 0;
            net._transitionTo(STATES.COLLARED);
            continue;
          }
        }

        // The leash driver is pulling this catch in to the nose (the hold above keeps pinning it): the hand-off
        // decision, the furnace clock and the retry all wait for it.
        if (net.state === STATES.COLLARED && net._leashNoseReel) continue;

        // Cargo hand-off decision. AUTOMATIC by owner ruling (the player holds no information the ship lacks): no
        // keypress. Decided on the FIRST COLLARED tick, BEFORE the digestion clock below: the crane must win the
        // race with the collar furnace, whose chop commits span/(45·sunScale) real seconds after the mate (+1.33 s
        // at 3 kg, +4.43 s at 10 kg in sunlight). While the ship cannot stow (every daughter out, every rack full,
        // or the body over the mass gate) the catch stays collared and the refusal comms says so once; the retry
        // is silent. The ≤ 2000 kg gate decides collar-vs-tip: under it a piece may leave for a strut tip; above
        // it, collar-only until digested or dumped.
        if (net.state === STATES.COLLARED && !net._cargoDeclined) {
          // `continue` on success: one state change per tick, so the flight begins at t=0 on its own frame (not
          // consuming the trigger frame's possibly huge dt), and the digestion clock never ticks on an accepted piece.
          if (this._tryCargoTransfer(net)) continue;
          // Declined for ANY reason: record it and fall through, so the digest ticks in THIS frame.
          net._cargoDeclined = true;
        }

        // Collar digestion clock: the piece cooks on the SAME sun-scaled transit clock as the daughter rack. At
        // completion the beat fires NET_CONSUMED + CATCH_PROCESSED (digested; the mate already paid the credit,
        // GameFlowManager skips it) and the collar frees. A completed digest splices the net in-tick.
        // CUT_AT_NOSE: while pieces remain to cut (or one is waiting/flying) the clock is FROZEN, else
        // `_breakdownStarted` would close the transfer window and the boss would cook mid-cut.
        if (net.state === STATES.COLLARED
            && !this._cutActive(net) && this._tickCollarDigestion(net, dt)) {
          this.activeNets.splice(i, 1);
          continue;
        }

        // After a decline, silently re-offer on the RETRY_S cadence: the scorer allocates (computeCoM) and an
        // unstowable catch can sit collared for minutes, so the net path must not allocate per frame.
        if (net.state === STATES.COLLARED && net._cargoDeclined) {
          net._cargoRetryS = (net._cargoRetryS || 0) + dt;
          if (net._cargoRetryS >= (CT.RETRY_S ?? 0.5)) {
            net._cargoRetryS = 0;
            if (this._tryCargoTransfer(net)) continue;
          }
        }

        // CUT_AT_NOSE cut driver: one piece at a time, CUT_S game-seconds per cut (machine time, not sun-scaled);
        // a piece departs only when the crane is free and a daughter qualifies; the held part is never cut off (the
        // retry above takes it once the plan is done). The boss stays COLLARED; the detached piece rides its own
        // synthetic net.
        if (net.state === STATES.COLLARED && net._cutPlan && FEATURE_FLAGS.CUT_AT_NOSE) {
          this._driveCutAtNose(net, dt);
        }
      }

      // Cargo hand-off beat: the catch + its bag fly the FurnaceBreakdownVisual chunk arc backwards (nose → strut
      // tip, whole catch, no chunk pool, no scale ramp). The pin is rewritten EVERY frame (a gap reads as a release)
      // and the net rides the same curve so the bag stays the container. A net on its leash is driven by
      // LeashDriver.update (main.js, right after this system), which pins the catch and moves the net itself.
      if (net.state === STATES.TRANSFERRING && !net._leash) {
        if (this._updateCargoTransfer(net, dt)) {
          this.activeNets.splice(i, 1);      // handed over: the net's job is done
          continue;
        }
      }

      // Remove terminal nets. BERTHED and COLLARED are deliberately absent: a held net must hit neither the prune
      // predicate nor the STOWED cargo hand-off (§8 A2).
      if (!net.isActive || net.state === STATES.STOWED || net.state === STATES.RELEASED) {
        // Mother exits (miss / release / forceResolve): clear any pins the reel/berth wrote (idempotent).
        if (net._isMother) {
          this._clearCatchPins(net.targetDebris);
          // CUT_AT_NOSE: the [K] jettison path never calls _teardownBerth: release a still-waiting cut piece here
          // (cargo is never destroyed; it becomes free salvage at its last pin).
          if (net._cutPiece && !net._cutPieceFlying) this._releaseCutPiece(net._cutPiece);
        }

        // DECISIONS §33 row 1: a fired net is used up, hit or miss (a missed net cannot be refolded in space), so
        // nothing is restored here.

        // Cargo hand-off of a successful capture. Gated OFF for mother catches (§8 A2): they berth instead of being
        // stuffed into a cargo cell they cannot fit.
        if (net.state === STATES.STOWED && net.catchResult === 'success' && net.capturedMass > 0
            && !(net.podIndex >= 0 && net.armIndex < 0)) {
          eventBus.emit(Events.CARGO_STORE, {
            debrisId:     net.targetDebris?.id,
            mass:         net.capturedMass,
            source:       net.armIndex >= 0 ? 'daughter' : 'mother',
            armIndex:     net.armIndex,
            podIndex:     net.podIndex,
            netCapture:   true,
          });
        }

        // Manual jettison from BERTHED ([K]): re-seat the orbit so the whale resumes where it was released, not
        // where its own orbit propagated to while pinned (§8 A2).
        if (net.state === STATES.RELEASED && net._isMother) {
          this._reseatOrbitOnRelease(net);
        }

        this.activeNets.splice(i, 1);
      }
    }

    // Backstop: the whistle survives only while SOME active net is in a flight state (expiry misses are
    // event-stopped; this makes a leaked whistle structurally impossible).
    if (!anyNetInFlight) this._audioSystem?.stopNetFlightWhistle?.();
  }

  /**
   * Try to hand a COLLARED catch to a daughter's cargo rack. Automatic by owner ruling 2026-08-12 (no hotkey).
   * `suggestCargoArm` is the single gatekeeper for "may this piece go to a daughter, and which one": it owns the mass
   * gate, the free-cell rule, the home rule and the last-capture-capable-daughter guard. When it declines, the catch
   * stays at the collar and the refusal comms fires exactly ONCE per mate; the retry is silent. The start anchor is
   * the collar seat ({kind:'collar'}).
   * @param {NetProjectile} net — a COLLARED mother net
   * @returns {boolean} true when the beat started
   * @private
   */
  _tryCargoTransfer(net) {
    const M_NET = Constants.SCENE_UNITS_PER_METER;  // 1 m in scene units
    const d = net.targetDebris;
    const player = this._player;
    const armManager = this._armManager;
    if (!d || !armManager || !Array.isArray(armManager.arms)) return false;

    // CUT_AT_NOSE: mid-cut the boss may take this path only once the plan is done and only the held part remains
    // (then ≤ the gate by construction). Silent decline: the cut driver owns the timeline and its comms.
    if (this._cutActive(net)) return false;

    // Once the collar's furnace has COMMITTED (the chop START fired) the transfer window is closed: a late
    // acceptance would fly a half-eaten body to the rack, leak the collar-anchored ghost bag + unflown chunks
    // (NET_CONSUMED for that anchor never comes) and fire a SECOND BREAKDOWN_START. Silent decline: the cook
    // completes at the collar and the mass leaves the ledger exactly once.
    if (net._breakdownStarted) return false;

    // Leash hand-off (DECISIONS §1): a small catch goes to a radiator tip on its own leash. A leash that failed
    // (snag, rejected turn) brought the catch back to the nose: no second try. With FURNACE_COOK on, never the rack
    // either: the nose furnace takes it (coordinator ruling 2026-10-14). With it off (no-melt, DECISIONS §12) nothing at the nose
    // takes it, so a failed hand-off skips the leash block and goes to the daughter rack below (no ship turn, no
    // gas); with no free cell the usual refusal line is said once. It waits silently until the hand-off has finished:
    // the net is relatched when the catch is home, but the radiators are still unfolding (~9 s) and the failure line
    // comes at the end, so the rack beat starts only after the radiators are home.
    let gasShort = false;
    if (net._leashFailed) {
      if (Constants.isFeatureEnabled('FURNACE_COOK')) return false;
      const leashDrv = player && player.leashDriver;
      if (leashDrv && typeof leashDrv.isActive === 'function' && leashDrv.isActive()) return false;
    } else if (FEATURE_FLAGS.LEASH_HANDOFF) {
      const verdict = this._tryLeash(net, d);
      if (verdict === 'started') return true;
      if (verdict === 'declined') return false;
      // 'rack' because the tank cannot pay for the swing (not because the catch is too big or no tip is free); the
      // line is chosen below, once we know whether a cell is free.
      gasShort = net._gasShort === true;
    }

    const massKg = net.capturedMass || d.mass || 0;
    // CUT_AT_NOSE dust guard: the planner guarantees every piece ≤ maxPieceKg×(1+1e-9); clamp a float-dust overhang
    // on the held part (≤1e-6 kg, below every conservation tolerance) so it is not stranded at the gate forever.
    const _gate = CT.MAX_KG ?? 2000;
    let gateMassKg = massKg;
    if (net._cutPlan && net._cutNext >= net._cutPlan.pieces.length - 1
        && massKg > _gate && massKg - _gate <= 1e-6) {
      gateMassKg = _gate;
    }
    const booked = this._armsWithCargoOnTheWay();
    const armIndex = suggestCargoArm(armManager, player, gateMassKg, 0, booked, DebrisField.trueReachM(d, d.sizeMeter || 0));   // + her reach
    if (armIndex == null) {
      if (!net._cargoRefused) {
        net._cargoRefused = true;
        const overGate = gateMassKg > _gate;
        // CUT_AT_NOSE: the over-gate refusal is where the cut planner is called, exactly once, at the receiver's own
        // limit. Requires a spawn-capable field (without spawnCutPiece, e.g. a mock, the refusal and collar ride
        // stand: a cut plan whose pieces cannot be drawn is worse than none).
        // A pending BIG piece is never cut automatically: it stays whole at the collar (only the melt cuts one) and
        // says so in its own words (no K: K does not let it go).
        const bigPending = bigPieces.isPending(d);
        if (overGate && !bigPending && FEATURE_FLAGS.CUT_AT_NOSE
            && this._debrisField
            && typeof this._debrisField.spawnCutPiece === 'function'
            && !net._cutPlan) {
          const plan = planCuts(d, { maxPieceKg: _gate });
          net._cutPlan = plan;
          net._cutOriginalMassKg = massKg;
          net._cutNext = 0;
          net._cutProgressS = 0;
          eventBus.emit(Events.COMMS_MESSAGE, {
            source: 'HOUSTON', channel: 'CMD',
            text: `Catch is ${Math.round(massKg)} kg — too heavy for one daughter. Cutting it into ${plan.pieces.length} pieces at the nose.`,
            priority: 'warning',
          });
        } else if (bigPending) {
          eventBus.emit(Events.COMMS_MESSAGE, {
            source: 'HOUSTON', channel: 'CMD',
            text: `The ${pieceName(d)} stays at your nose: no daughter can take it. It pays when you dispose of it.`,
            priority: 'warning',
          });
        } else if (gasShort && !overGate) {
          // No gas for the radiator AND no daughter can take it: ONE line naming both and the way out, instead of the
          // usual refusal line. Once per catch (the latch outlives `_cargoRefused`, which a called-off rack flight
          // re-arms). It is the only line: no separate "parked at the nose" line.
          this._sayGasShort(net, 'full');
        } else {
          // Stays at the nose (no cell, or over the gate with no cut); the reason line below says so and is the only
          // line. No-melt: the furnaces run only on the trip to the next field, so do not promise one now.
          const furnace = Constants.isFeatureEnabled('FURNACE_COOK');
          const fate = furnace
            ? 'It rides the collar until the furnace takes it. Press K to let it go.'
            : 'It stays at the collar and goes to a furnace on the trip to the next field if it fits one. Press K to let it go.';
          // A daughter holds one catch (owner 2026-10-22), so "no daughter can take it" has two true reasons: each is
          // away or already holds a catch, or exactly one is home and empty and stays ready for the next capture.
          const keptReady = countEmptyDockedDaughters(armManager, booked) > 0;
          eventBus.emit(Events.COMMS_MESSAGE, {
            source: 'HOUSTON', channel: 'CMD',
            text: overGate
              ? `Catch is ${Math.round(gateMassKg)} kg — too heavy for a daughter's cargo rack. ${fate}`
              : (keptReady
                ? `No daughter can take the catch: the last free one stays ready for the next capture. ${fate}`
                : `No daughter can take the catch (each one is away or already holding a catch). ${fate}`),
            priority: 'warning',
          });
        }
      }
      return false;
    }

    const arm = armManager.arms[armIndex];
    if (!arm) return false;

    // The swing to a radiator was skipped for want of steering gas and a cell is free: say why the catch goes to the
    // rack (it never left the nose, so no "did not work" line). Once per catch.
    if (gasShort) this._sayGasShort(net, 'rack');

    // Endpoints, both exact so neither end snaps. START is the catch's LIVE drawn position (`_scenePosition`, what
    // `pinCapturedDebris` wrote last frame), NOT the bus centre: the bag apex sits `_catchSeatM` short of the berth-hold
    // pin. END is the rack SLOT the piece will occupy, so the arc lands where `_pinHeldCatches` takes over.
    const seatM = (net._catchSeatM || 0) * M_NET;
    let start;
    if (d._scenePosition && d._scenePosition.lengthSq() > 0) {
      start = _v3f.copy(d._scenePosition);
    } else {
      start = _v3f.set(
        (net.position?.x || 0) * M_NET,
        (net.position?.y || 0) * M_NET,
        (net.position?.z || 0) * M_NET,
      );
      if (seatM && net.launchDirection) start.addScaledVector(net.launchDirection, seatM);
    }
    const end = _v3g.copy(this._cargoSlotWorld(arm, d, _v3g));

    // The three control points are born in the world and also stored in the SHIP's frame: the flight re-derives them
    // from the live ship pose every frame, so the arc rides with the ship (else drawn up to ~232 km away).
    this._seedCargoArc(net, start, end);
    // The catch turns with the ship for the whole flight: seed its ship-relative attitude before the first frame.
    this._seedCatchLocal(net, d);
    net._cargoArmIndex = armIndex;
    net._cargoS = 0;
    net._cargoDur = Math.max(1e-3, CT.FLIGHT_S ?? 3.0);
    net._transitionTo(STATES.TRANSFERRING);

    eventBus.emit(Events.CARGO_TRANSFER_START, {
      debrisId:  d.id,
      massKg,
      podIndex:  net.podIndex,
      armIndex,
      armId:     arm.id,
      durationS: net._cargoDur,
      from: { kind: 'collar', podIndex: net.podIndex },
      to:   { kind: 'strutTip', armIndex },
    });
    return true;
  }

  /**
   * The arm indices that already have a cargo flight on the way: a whole catch or a cut piece in TRANSFERRING with a
   * daughter as its carrier (a leash flight carries no `_cargoArmIndex`). Such a daughter is still DOCKED with an empty
   * rack until the piece lands, so `heldCatches` alone cannot exclude her; `suggestCargoArm` counts each as holding a catch.
   * @returns {Set<number>}
   * @private
   */
  _armsWithCargoOnTheWay() {
    const out = new Set();
    for (const n of this.activeNets) {
      if (n.state !== STATES.TRANSFERRING || n._leash) continue;
      if (Number.isInteger(n._cargoArmIndex) && n._cargoArmIndex >= 0) out.add(n._cargoArmIndex);
    }
    return out;
  }

  /**
   * Tell the player the tank is too low to swing this catch to a radiator, once per catch (latch `net._gasShortSaid`
   * on the net, so the 0.5 s retry cannot repeat a line). `'rack'` = a cell is free, the catch goes to the daughter
   * rack now; `'full'` = no daughter can take it, so it waits at the nose ([K] lets it go). One exception, so no line is
   * left untrue: a 'rack' line followed by a called-off rack flight with no cell free after all says the 'full' line;
   * a 'full' line followed by a cell that frees needs no second line (the rack's own "Catch stowed" line follows).
   * @param {NetProjectile} net
   * @param {'rack'|'full'} kind
   * @private
   */
  _sayGasShort(net, kind) {
    const said = net._gasShortSaid || (net._gasShortSaid = { rack: false, full: false });
    if (kind === 'rack' ? (said.rack || said.full) : said.full) return;
    said[kind] = true;
    eventBus.emit(Events.COMMS_MESSAGE, {
      source: 'HOUSTON', channel: 'CMD',
      text: kind === 'rack'
        ? 'Not enough steering gas to swing the catch to a radiator. Stowing it on the rack.'
        : 'Not enough steering gas to swing the catch to a radiator, and no daughter can take it. Press K to let it go.',
      priority: 'warning',
      _critical: true, // past the onboarding tier filter, so the screen always says why (owner 2026-10-18 23:26Z)
    });
  }

  /**
   * Decide whether this COLLARED catch goes by leash.
   * @param {NetProjectile} net
   * @param {object} d — the catch
   * @returns {'started'|'declined'|'rack'} 'rack' = not a leash catch (too big for a tip, no free tip, no driver):
   *   the caller takes the rack path. 'declined' = fits but cannot start now (refusal said once per reason):
   *   retried on the usual 0.5 s cadence, never sent to the rack.
   * @private
   */
  _tryLeash(net, d) {
    net._gasShort = false;         // set below only when THIS call finds the tank short for the swing
    const player = this._player;
    const drv = player && player.leashDriver;
    const tc = player && player.tipCargo;
    if (!drv || !tc || typeof drv.start !== 'function') return 'rack';
    const radiusM = DebrisField.trueReachM(d, 2);       // tip-fit: the catch as drawn, not half its nominal size
    if (!tc.fits(radiusM)) return 'rack';
    const tip = tc.pickTip();
    if (tip == null) return 'rack';
    // Out of the line's reach at the berth seat (a mother-net catch rides 3.3-5.0 m deep in the bag, 5.9-7.5 m from the
    // ship centre, measured): the net's winch first pulls it in to the nose if the line can reach it from there;
    // if not even then, the rack path takes it (folding the radiators would be for nothing).
    let noseReel = false;
    if (typeof drv.canReach === 'function' && !drv.canReach(d, tip)) {
      if (typeof drv.canReachAtNose !== 'function' || !drv.canReachAtNose(net, d, tip)) return 'rack';
      noseReel = true;
    }
    // A hand-off pays for one steering-gas turn. If the tank cannot pay, take the rack path now instead of folding the
    // radiators for nothing; `_tryCargoTransfer` says why (once) when it knows whether a cell is free. With the
    // furnace on, the nose furnace takes a failed catch, so this check is skipped.
    if (!Constants.isFeatureEnabled('FURNACE_COOK') && typeof drv.gasShort === 'function'
        && drv.gasShort(net, d, tip, { noseReel })) {
      net._gasShort = true;
      return 'rack';
    }
    // A profile trip shows ONE flown pass: once begun, the leash starts for no other catch (the trip hands this one to
    // a tip unflown). Silent; the pass's own leash is let through.
    if (tripLeashRefuses(net)) return 'declined';
    const why = drv.refusal(net);
    if (why) {
      // A 'busy' refusal (previous catch still holds the driver) is never spoken: this catch starts when the retry finds it free.
      drv.announceRefusal(net, why);
      return 'declined';
    }
    return drv.start(net, d, tip, { noseReel }) ? 'started' : 'declined';
  }

  /**
   * Take a net out of play in this very tick: the leash driver calls it right after it stows the catch on a radiator
   * tip, so the nose ledger and the tip ledger never both hold the mass, and the next tick's prune never clears the
   * pins of the stowed body. Safe to call outside the update loop only (it splices `activeNets`).
   * @param {NetProjectile} net
   * @returns {boolean} true when the net was in the list
   */
  removeNetNow(net) {
    net.isActive = false;
    net._leashNoseReel = false;
    const i = this.activeNets.indexOf(net);
    if (i < 0) return false;
    this.activeNets.splice(i, 1);
    return true;
  }

  /**
   * The transfer beat, one frame. ONE Bézier curve drives both the bag's apex anchor (`net.position`) and the catch's
   * pin, with the berth hold's seat offset, so the catch stays seated INSIDE its bag. The pin is rewritten every frame:
   * if it stops, the catch falls back to the orbit branch and reads as released. On arrival the piece is stowed on the
   * rack and the daughter goes into HOLDING_CATCH (ArmManager's pin loop only services REELING/DOCKING/HOLDING_CATCH,
   * so a DOCKED carrier must transition or the piece goes unpinned for a frame).
   *
   * @param {NetProjectile} net — a TRANSFERRING mother net
   * @param {number} dt — seconds
   * @returns {boolean} true when the hand-off completed (caller splices the net)
   * @private
   */
  _updateCargoTransfer(net, dt) {
    const M_NET = Constants.SCENE_UNITS_PER_METER;  // 1 m in scene units
    const d = net.targetDebris;
    const debrisField = this._debrisField;
    const armManager = this._armManager;
    const arm = armManager?.arms?.[net._cargoArmIndex];

    // Target or carrier lost mid-beat (mission transition / detach): put the catch back at the collar; cargo is never destroyed.
    if (!d || d.alive === false || !arm || !net._cargoFrom || !net._cargoTo) {
      clearRackCell(d);                 // an aborted flight forgets the cell it was heading for
      // CUT_AT_NOSE: a cut piece never "goes back to the collar" (the boss owns it). It returns to the nose as a
      // waiting piece (the driver re-pins and retries), or is dropped from the cut bookkeeping if it died. The piece
      // net is spliced either way; the boss net's COLLARED hold is untouched.
      if (net._cutBossNet) {
        const bossNet = net._cutBossNet;
        net._cutBossNet = null;
        bossNet._cutPieceFlying = false;
        if (!d || d.alive === false) bossNet._cutPiece = null;
        this._teardownBerth(net);
        return true;
      }
      if (d && d.alive !== false) {
        net._cargoRefused = false;
        net._cargoDeclined = false;   // re-arm the first-tick decision
        net._transitionTo(STATES.COLLARED);
        return false;
      }
      this._teardownBerth(net);
      return true;
    }

    // The carrier LEFT her strut mid-flight (DOCKED, not HOLDING_CATCH, until arrival). Abort: her rack pin only runs
    // in REELING/DOCKING/HOLDING_CATCH, so delivering to a departing arm would orphan the piece. Back to the collar;
    // the retry re-picks a carrier.
    const SA = Constants.ARM_STATES;
    if (arm.state !== SA.DOCKED && arm.state !== SA.HOLDING_CATCH) {
      clearRackCell(d);                 // the retry computes a fresh cell (the carrier may differ)
      // CUT_AT_NOSE: same cut-piece routing as above. The comms line below is still true.
      if (net._cutBossNet) {
        const bossNet = net._cutBossNet;
        net._cutBossNet = null;
        bossNet._cutPieceFlying = false;
        eventBus.emit(Events.COMMS_MESSAGE, {
          source: 'HOUSTON', channel: 'CMD',
          text: `${arm.displayName || arm.id} left the strut — the cut piece waits at the nose.`,
          priority: 'info',
        });
        return true;
      }
      net._cargoRefused = false;
      net._cargoDeclined = false;   // re-arm the first-tick decision
      net._transitionTo(STATES.COLLARED);
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'HOUSTON', channel: 'CMD',
        text: `${arm.displayName || arm.id} left the strut — cargo stays at the collar.`,
        priority: 'info',
      });
      return false;
    }

    // The arc rides with the ship: control points from the LIVE ship pose, landing point from the rack slot. The
    // catch also turns with the ship.
    this._refreshCargoArc(net, arm, d);
    this._seedCatchLocal(net, d);
    if (this._player && this._player.quaternion) {
      net._applyCatchOrientation(d, this._player, dt);
    }

    net._cargoS = Math.min(net._cargoDur, (net._cargoS || 0) + dt);
    const t = net._cargoDur > 0 ? net._cargoS / net._cargoDur : 1;
    // Ease in-out: an instant start reads as a kick, which the momentum model does not fund.
    const te = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);

    // Quadratic Bézier B(te) = (1−te)²·P0 + 2(1−te)·te·C + te²·P1; it carries the CATCH, the bag apex is derived.
    const u = 1 - te;
    _v3d.copy(net._cargoFrom).multiplyScalar(u * u)
      .addScaledVector(net._cargoCtrl, 2 * u * te)
      .addScaledVector(net._cargoTo, te * te);

    const seatM = (net._catchSeatM || 0) * M_NET;
    _v3e.copy(_v3d);
    if (seatM && net.launchDirection) _v3e.addScaledVector(net.launchDirection, -seatM);
    net.position.x = _v3e.x / M_NET;
    net.position.y = _v3e.y / M_NET;
    net.position.z = _v3e.z / M_NET;

    if (debrisField && typeof debrisField.pinCapturedDebris === 'function') {
      d._armPinned = true;
      d._captured = true;
      d._motherParked = true;              // orbit stays frozen for the whole beat
      if (!d._armPinPos) d._armPinPos = new THREE.Vector3();
      d._armPinPos.copy(_v3d);
      debrisField.pinCapturedDebris(d, _v3d);
    }

    if (net._cargoS < net._cargoDur) return false;

    // Arrival: the rack takes ownership
    const stowed = (typeof arm._stowHeldCatch === 'function')
      ? arm._stowHeldCatch(d, this._player?.quaternion || null)
      : false;
    if (!stowed) {
      clearRackCell(d);                 // the retry assigns a fresh cell
      // Rack filled during the beat (should be unreachable: the scorer reserved a cell). Keep the cargo: back on the
      // collar, the retry picks another carrier.
      // CUT_AT_NOSE: a refused cut piece returns to the waiting pool on its boss net; the piece net splices.
      if (net._cutBossNet) {
        const bossNet = net._cutBossNet;
        net._cutBossNet = null;
        bossNet._cutPieceFlying = false;
        return true;
      }
      net._cargoRefused = false;
      net._cargoDeclined = false;   // re-arm the first-tick decision
      net._transitionTo(STATES.COLLARED);
      return false;
    }

    // Mother-side fields → what a daughter-caught rack piece carries. _captured stays true (the rack holds it),
    // _armPinned/_armPinPos are rewritten by the rack pin below, _motherParked clears, and _catchRenderMin is
    // DELIBERATELY kept: clearing it would pop the drawn size at the strut.
    d._motherParked = false;
    d._capturedByArm = arm;
    // owner 2026-10-22 "Keep: radiator right away": this catch is the MOTHER's; it only waited on a rack because no
    // radiator tip was free. ArmManager._tickMissionCarry moves a marked catch to a tip as soon as one is; a catch the
    // daughter caught herself carries no mark. Cleared with the cell (clearRackCell).
    d._rackFromMotherNet = true;

    const S = Constants.ARM_STATES;
    if (arm.state !== S.HOLDING_CATCH) {
      arm._breakdownStarted = false;       // fresh furnace bookkeeping for the piece
      arm._breakdownChunksFired = 0;
      // NOTE: `capturedDebris` is deliberately NOT cleared. A DOCKED arm should have none, but nulling it would
      // destroy cargo if she somehow did, which the two laws (§1) forbid.
      if (typeof arm._transitionTo === 'function') arm._transitionTo(S.HOLDING_CATCH);
      else arm.state = S.HOLDING_CATCH;
    }
    // The rack takes the catch as a place on HER. Its cell, offset and her-frame attitude were assigned when the
    // flight began (`_cargoSlotWorld`) and `_stowHeldCatch` kept them, so the arc's end is exactly where the pin below
    // holds it (no jump at the strut) and from here on it turns with her (`_pinHeldCatches`, every frame). A carrier
    // with no rack seam (a duck-typed stub) keeps the ship-relative attitude.
    if (!d._qLocalHer) seedShipRelativeAttitude(d, this._player?.quaternion, this._debrisField);
    if (typeof arm._pinHeldCatches === 'function') {
      arm._pinHeldCatches(
        this._player?.getPosition ? this._player.getPosition() : null,
        this._player?.quaternion || null);
    }

    net.isActive = false;
    net._berthTimer = -1;
    // The caller splices this net in the SAME tick, so the prune's STOWED/RELEASED consequences (pin clearing, orbit
    // re-seat, inventory restore) cannot fire on a delivered net and undo the rack's pin. The marker is for a reader
    // holding a stale reference: the cargo belongs to the arm now.
    net._cargoDelivered = true;
    // CUT_AT_NOSE: the boss net learns the piece is off its books, so the next cut may begin.
    if (net._cutBossNet) {
      net._cutBossNet._cutPiece = null;
      net._cutBossNet._cutPieceFlying = false;
      net._cutBossNet = null;
    }
    eventBus.emit(Events.CARGO_TRANSFER_COMPLETE, {
      debrisId:  d.id,
      massKg:    net.capturedMass || d.mass || 0,
      podIndex:  net.podIndex,
      armIndex:  net._cargoArmIndex,
      armId:     arm.id,
      cellIndex: Number.isInteger(d._rackCell) ? d._rackCell : Math.max(0, (arm.heldCatches?.length || 1) - 1),
      // CUT_AT_NOSE: one extra field on the cut-piece path only; ordinary transfers carry no `cut` key.
      ...(net._cutMeta ? { cut: net._cutMeta } : {}),
    });

    // ONE player-facing line for the whole beat (the arc is its own feedback): who took the cargo.
    eventBus.emit(Events.COMMS_MESSAGE, {
      source: 'HOUSTON', channel: 'CMD',
      text: `Catch stowed on ${arm.displayName || arm.id}. Launcher clear.`,
      priority: 'success',
      _keep: true, // where a catch went is never folded into "× N queued"
    });
    return true;
  }

  /**
   * Control points for a cargo arc (whole catch or cut piece), plus the same three points in the SHIP's frame
   * (`_cargoFromLocal/_cargoCtrlLocal/_cargoToLocal` = q⁻¹ × (world − shipPos)). `_cargoFrom/_cargoCtrl/_cargoTo` stay
   * the live WORLD points (rewritten each frame by `_refreshCargoArc`). With no ship pose to read, no local points
   * exist and the world points stay frozen.
   * @param {NetProjectile} net — the TRANSFERRING net (or about to be)
   * @param {THREE.Vector3} start — catch position, scene units (scratch ok)
   * @param {THREE.Vector3} end — rack slot, scene units (scratch ok)
   * @private
   */
  _seedCargoArc(net, start, end) {
    const M_NET = Constants.SCENE_UNITS_PER_METER;
    net._cargoFrom = start.clone();
    net._cargoTo = end.clone();
    // Bézier control point: bulge outward (away from the strut tip) so the catch arcs around the hull instead of
    // shearing through it; the furnace chunk arc's shape, run backwards.
    net._cargoCtrl = start.clone().lerp(end, 0.5);
    _v3a.copy(start).sub(end);
    if (_v3a.lengthSq() > 1e-12) {
      _v3a.normalize().multiplyScalar((CT.ARC_BULGE_M ?? 2.0) * M_NET);
      net._cargoCtrl.add(_v3a);
    }
    net._cargoShipFrame = false;
    if (readShipPose(this._player, _vShipPos, _qShip)) {
      _qShipInv.copy(_qShip).invert();
      net._cargoFromLocal = net._cargoFrom.clone().sub(_vShipPos).applyQuaternion(_qShipInv);
      net._cargoCtrlLocal = net._cargoCtrl.clone().sub(_vShipPos).applyQuaternion(_qShipInv);
      net._cargoToLocal = net._cargoTo.clone().sub(_vShipPos).applyQuaternion(_qShipInv);
      net._cargoShipFrame = true;
    }
  }

  /**
   * One frame of the ship-riding arc: rebuild `_cargoFrom/_cargoCtrl` from the ship-frame points and the live ship
   * pose, and take `_cargoTo` live from the rack slot. No-op when the arc was born without a ship pose.
   * @private
   */
  _refreshCargoArc(net, arm, d) {
    if (!net._cargoShipFrame) return;
    if (!readShipPose(this._player, _vShipPos, _qShip)) return;
    net._cargoFrom.copy(net._cargoFromLocal).applyQuaternion(_qShip).add(_vShipPos);
    net._cargoCtrl.copy(net._cargoCtrlLocal).applyQuaternion(_qShip).add(_vShipPos);
    this._cargoSlotWorld(arm, d, net._cargoTo);
  }

  /**
   * Ensure a flying net knows the catch's attitude in the ship's frame (`net._qLocal`, shipQuat⁻¹ × catchQuat); a
   * path that never berthed (a cut piece) gets it here, once. No-op when it exists, or when the catch has no
   * tumbleAxis / the player no quaternion.
   * @private
   */
  _seedCatchLocal(net, d) {
    if (net._qLocal || !d || !d.tumbleAxis) return;
    const sq = this._player && this._player.quaternion;
    if (!sq) return;
    catchQuaternionInto(d, _qCatchPose);
    net._qLocal = new THREE.Quaternion().copy(sq).invert().multiply(_qCatchPose);
  }

  /**
   * Where a piece will sit once it is on the rack, so the transfer arc ends exactly where `_pinHeldCatches` will hold
   * it (no arrival snap). Delegates to `ArmUnit.heldSlotWorldInto`, the ONE computation of the rack's geometry.
   * The first call for this carrier ASSIGNS the cell (offset on her, attitude in her frame); later calls (the arc is
   * rebuilt every frame) only read it. `_stowHeldCatch` keeps it on arrival.
   * @param {object} arm — the carrier
   * @param {object} d — the piece being handed over
   * @param {THREE.Vector3} out
   * @returns {THREE.Vector3} out, in scene units
   * @private
   */
  _cargoSlotWorld(arm, d, out) {
    const parentPos = this._player?.getPosition ? this._player.getPosition() : null;
    const parentQuat = this._player?.quaternion || null;
    if (typeof arm.heldSlotWorldInto === 'function') {
      if (typeof arm.assignRackCell === 'function') arm.assignRackCell(d, parentQuat);
      const slot = Number.isInteger(d._rackCell)
        ? d._rackCell
        : (Array.isArray(arm.heldCatches) ? arm.heldCatches.length : 0);
      return arm.heldSlotWorldInto(slot, d.sizeMeter, parentPos, out, d, parentQuat);
    }
    return out.copy(arm.position || _v3a.set(0, 0, 0));
  }

  // CUT_AT_NOSE: the cut machinery.
  // Board on the BOSS net (the COLLARED mother net whose target is over the hand-off gate):
  //   _cutPlan            the planCuts result (pieces in chop order; the LAST piece is the held part, never cut off)
  //   _cutOriginalMassKg  the boss's mass at plan time (size reference)
  //   _cutNext            index of the next piece to DETACH
  //   _cutProgressS       game-seconds accumulated toward that detach
  //   _cutPiece           the detached piece (waiting at the nose or flying)
  //   _cutPieceFlying     true while that piece's flight is under way
  //   _cutRetryS          launch-retry accumulator (CT.RETRY_S cadence)
  //   _cutWaitingSaid     the waiting comms line, once per pause (re-armed when a piece leaves)
  //   _cutWaiting         true while the cut is PAUSED: the piece at the nose has no empty daughter to go to

  /**
   * True while a cut plan exists and is not finished: the boss must not take the ordinary hand-off
   * (`_tryCargoTransfer` guard) and the collar digestion must not tick (`_breakdownStarted` would close the transfer
   * window and cook the boss mid-cut). Flag OFF ⇒ no net carries `_cutPlan` ⇒ always false.
   * @param {NetProjectile} net
   * @returns {boolean}
   * @private
   */
  _cutActive(net) {
    return !!(net && net._cutPlan
      && (net._cutPiece
        || (net._cutNext ?? 0) < net._cutPlan.pieces.length - 1));
  }

  /**
   * The cut driver: one COLLARED frame of the chop. Serialised: exactly one piece is detached-and-not-delivered at a
   * time. No state change on the boss net (it stays COLLARED, mated, pin held); the detached piece rides its own
   * synthetic net.
   * @param {NetProjectile} net — a COLLARED mother net with `_cutPlan`
   * @param {number} dt — real seconds
   * @private
   */
  _driveCutAtNose(net, dt) {
    const plan = net._cutPlan;
    const d = net.targetDebris;
    const debrisField = this._debrisField;
    if (!d || d.alive === false || !debrisField) return;

    if (net._cutPiece) {
      if (net._cutPieceFlying) return;   // the piece net drives the flight
      // The waiting piece: held at the nose, just fore of the boss (a clamp seat, DECISIONS §12 ruling 4: the piece
      // exists, drawn, until the crane can take it). Pinned EVERY frame: a gap reads as a release.
      const piece = net._cutPiece;
      piece._captured = true;
      piece._motherParked = true;
      if (d._scenePosition && d._scenePosition.lengthSq() > 0) {
        const M_NET = Constants.SCENE_UNITS_PER_METER;
        const offM = ((d.sizeMeter || 2) / 2) + ((piece.sizeMeter || 1) / 2) + 0.5;
        _v3cut.copy(d._scenePosition);
        _v3cut.x += (net.launchDirection?.x || 0) * offM * M_NET;
        _v3cut.y += (net.launchDirection?.y || 0) * offM * M_NET;
        _v3cut.z += (net.launchDirection?.z || 0) * offM * M_NET;
        if (typeof debrisField.pinCapturedDebris === 'function') {
          debrisField.pinCapturedDebris(piece, _v3cut);
        }
      }
      net._cutRetryS = (net._cutRetryS || 0) + dt;
      if (net._cutRetryS >= (CT.RETRY_S ?? 0.5)) {
        net._cutRetryS = 0;
        this._launchCutPiece(net, piece);
      }
      return;
    }

    // Nothing outstanding: is there another piece to cut off? The LAST piece of the plan is the held part, never detached.
    if (net._cutNext >= plan.pieces.length - 1) return;

    // CUT_S GAME-seconds per cut: dt × BASE_SCALE, deliberately NOT sun-scaled (the cutter is a machine, not a plant).
    net._cutProgressS = (net._cutProgressS || 0) + dt * TimeAuthority.BASE_SCALE;
    if (net._cutProgressS >= (CN.CUT_S ?? 60)) {
      net._cutProgressS = 0;
      this._detachCutPiece(net);
    }
  }

  /**
   * Detach the next planned piece: spawn it (a real, drawn debris object) and move its mass and salvage off the
   * boss's books (the ledger conserves at every step).
   * @param {NetProjectile} net
   * @private
   */
  _detachCutPiece(net) {
    const plan = net._cutPlan;
    const spec = plan.pieces[net._cutNext];
    const d = net.targetDebris;
    const debrisField = this._debrisField;
    if (!d || d.alive === false || !spec || !(spec.massKg > 0)
        || typeof debrisField.spawnCutPiece !== 'function') {
      // Unreachable from a validated plan with a spawn-capable field (the plan is only created after that check).
      // Abandon quietly: the boss rides the collar; the cook wins.
      console.warn('[CaptureNet] CUT_AT_NOSE: spawn unavailable — cutting abandoned');
      net._cutPlan = null;
      net._cutPiece = null;
      net._cutPieceFlying = false;
      return;
    }

    // Seat the piece just fore of the boss's live pin (the spot the waiting-piece hold keeps it at).
    const M_NET = Constants.SCENE_UNITS_PER_METER;
    const offM = ((d.sizeMeter || 2) / 2) + 1.0;
    _v3cut.copy(d._scenePosition || _v3a.set(0, 0, 0));
    _v3cut.x += (net.launchDirection?.x || 0) * offM * M_NET;
    _v3cut.y += (net.launchDirection?.y || 0) * offM * M_NET;
    _v3cut.z += (net.launchDirection?.z || 0) * offM * M_NET;

    const piece = debrisField.spawnCutPiece(
      d, spec, plan, net._cutOriginalMassKg, _v3cut);
    if (!piece) {
      console.warn('[CaptureNet] CUT_AT_NOSE: spawn refused — cutting abandoned');
      net._cutPlan = null;
      net._cutPiece = null;
      net._cutPieceFlying = false;
      return;
    }

    // The boss loses EXACTLY the piece's amounts (the planner conserves, so sequential subtraction leaves the held
    // part at its planned value within float dust).
    d.mass -= spec.massKg;
    net.capturedMass = Math.max(0, (net.capturedMass || 0) - spec.massKg);
    if (d.salvage && spec.salvage) {
      // The six scalar names mirror cutPlanner's SALVAGE_SCALARS (test-CutAtNose's conservation pin fails on drift).
      for (const f of ['xenon', 'indium', 'gaAs', 'battery', 'hydrazine', 'lithium']) {
        if (typeof d.salvage[f] === 'number' && typeof spec.salvage[f] === 'number') {
          d.salvage[f] -= spec.salvage[f];
        }
      }
      const dm = d.salvage.metals;
      const pm = spec.salvage.metals;
      if (Array.isArray(dm) && Array.isArray(pm)) {
        for (let k = 0; k < dm.length && k < pm.length; k++) {
          if (typeof dm[k].amount === 'number' && typeof pm[k].amount === 'number') {
            dm[k].amount -= pm[k].amount;
          }
          if (typeof dm[k].value === 'number' && typeof pm[k].value === 'number') {
            dm[k].value -= pm[k].value;
          }
        }
      }
    }
    if (typeof d.metalMassKg === 'number' && typeof piece.metalMassKg === 'number') {
      d.metalMassKg = Math.max(0, d.metalMassKg - piece.metalMassKg);
    }

    net._cutNext++;
    net._cutPiece = piece;
    net._cutRetryS = 0;
    // First launch attempt right away; the RETRY_S cadence takes over if no daughter qualifies.
    this._launchCutPiece(net, piece);
  }

  /**
   * Launch one cut piece to a rack: the piece rides a synthetic mother net born directly in TRANSFERRING (the same
   * `_updateCargoTransfer` Bézier / pin-every-frame / stow beat a whole catch flies), with `_ceremonyStartEmitted` set
   * (no launch ceremony) and NO bag: no net is spent on a cut piece (the `adoptLassoCatch` quiet-hand-off idiom).
   * Departs only when the crane is free (no mother transfer in flight) and `suggestCargoArm` qualifies a carrier at
   * the PIECE's mass.
   * @param {NetProjectile} net — the boss net
   * @param {object} piece — the waiting cut piece
   * @private
   */
  _launchCutPiece(net, piece) {
    const player = this._player;
    const armManager = this._armManager;
    const debrisField = this._debrisField;
    if (!player || !armManager || !Array.isArray(armManager.arms)) return;

    // The crane is free only when NOTHING is in transfer (any mother net).
    if (this.activeNets.some(
      (n) => n._isMother && n.state === STATES.TRANSFERRING)) return;

    const armIndex = suggestCargoArm(armManager, player, piece.mass, piece.sizeMeter,
      this._armsWithCargoOnTheWay(), DebrisField.trueReachM(piece, piece.sizeMeter || 0));   // + the piece's reach
    if (armIndex == null) {
      // No empty daughter may take the piece, so the cut is PAUSED at the nose. It resumes by itself when a daughter
      // is home and empty (this retry, every RETRY_S); [K] lets the rest go. Plain words, once per pause.
      net._cutWaiting = true;
      if (!net._cutWaitingSaid) {
        net._cutWaitingSaid = true;
        // Pieces still to be placed: the one waiting at the nose plus every piece after it (the held part counts).
        // `_cutNext` has already moved past the waiting piece. "it" in the text is the catch: K releases the waiting
        // piece and the uncut remainder together.
        const left = Math.max(1, net._cutPlan.pieces.length - net._cutNext + 1);
        eventBus.emit(Events.COMMS_MESSAGE, {
          source: 'HOUSTON', channel: 'CMD',
          text: `The catch waits at the nose: ${left} ${left === 1 ? 'piece still needs' : 'pieces still need'} an empty daughter. Press K to let it go.`,
          priority: 'info',
        });
      }
      return;
    }
    net._cutWaiting = false;
    net._cutWaitingSaid = false;          // a later pause speaks again
    const arm = armManager.arms[armIndex];
    if (!arm || !piece._scenePosition) return;

    const M_NET = Constants.SCENE_UNITS_PER_METER;
    const start = _v3cut.copy(piece._scenePosition);
    const end = _v3g.copy(this._cargoSlotWorld(arm, piece, _v3g));

    const pieceNet = new NetProjectile({
      netClass: CN.LARGE,
      armIndex: -1,
      podIndex: net.podIndex,
      launchPosition: {
        x: start.x / M_NET, y: start.y / M_NET, z: start.z / M_NET,
      },
      launchDirection: { ...(net.launchDirection || { x: 0, y: 0, z: 1 }) },
      targetDebris: piece,
      captureMode: CN.MODES.CINCH,
      anchorProvider: net._anchorProvider || null,
    });
    pieceNet._ctx = {
      player,
      debrisField,
      armManager: this._armManager,
      lassoSystem: this._lassoSystem,
      captureNetSystem: this,
    };
    pieceNet.catchResult = 'success';
    pieceNet.capturedMass = piece.mass;
    // Quiet by construction: no NET_FIRED (no bag ever attaches), no ceremony beats (`update()` would otherwise fire
    // NET_CEREMONY_START on the first tick of a fresh net).
    pieceNet._ceremonyStartEmitted = true;
    // Net-less seat: the pin IS the piece position; there is no bag apex to offset from.
    pieceNet._catchSeatM = 0;
    // Same arc shape and ship-riding control points / attitude as the whole-catch beat.
    this._seedCargoArc(pieceNet, start, end);
    this._seedCatchLocal(pieceNet, piece);
    pieceNet._cargoArmIndex = armIndex;
    pieceNet._cargoS = 0;
    pieceNet._cargoDur = Math.max(1e-3, CT.FLIGHT_S ?? 3.0);
    // The one extra field both transfer events carry on this path.
    pieceNet._cutMeta = {
      parentId: net.targetDebris?.id,
      index: piece.cutIndex,
      of: piece.cutOf,
    };
    pieceNet._cutBossNet = net;
    pieceNet._transitionTo(STATES.TRANSFERRING);
    net._cutPieceFlying = true;

    this.activeNets.push(pieceNet);
    eventBus.emit(Events.CARGO_TRANSFER_START, {
      debrisId:  piece.id,
      massKg:    piece.mass,
      podIndex:  net.podIndex,
      armIndex,
      armId:     arm.id,
      durationS: pieceNet._cargoDur,
      from: { kind: 'collar', podIndex: net.podIndex },
      to:   { kind: 'strutTip', armIndex },
      cut:  { ...pieceNet._cutMeta },
    });

    // When the LAST cut piece leaves the nose, only the held part remains, and it fits a daughter's rack.
    if (net._cutNext >= net._cutPlan.pieces.length - 1 && !net._cutLastSaid) {
      net._cutLastSaid = true;
      // The held part goes by the ordinary hand-off once the last piece has landed. The over-gate refusal spoke at the
      // start of the cut; if no daughter can take the held part either, its own line must speak (Press K), not silence.
      net._cargoRefused = false;
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'HOUSTON', channel: 'CMD',
        text: 'Cutting done — the last piece has left the nose.',
        priority: 'info',
      });
    }
  }

  /**
   * CUT_AT_NOSE: release an orphaned waiting piece to the field (boss jettisoned or died mid-cut). Cargo is never
   * destroyed: the piece is its own body now, un-pinned, orbit re-seated from its last position, free (still
   * `_credited`: the mate paid for the whole body, a re-capture must not pay again).
   * @param {object} piece
   * @private
   */
  _releaseCutPiece(piece) {
    if (!piece) return;
    const player = this._player;
    piece._captured = false;
    piece._armPinned = false;
    piece._armPinPos = null;
    piece._motherParked = false;
    piece._catchRenderMin = 0;
    clearShipRelativeAttitude(piece);
    clearRackCell(piece);                 // a cut piece that was heading for a cell forgets it
    if (piece._scenePosition && piece.orbit) {
      reseatOrbitFromScene(piece.orbit, piece._scenePosition,
        player?.getVelocity ? player.getVelocity() : null);
    }
  }

  /**
   * The collar's digestion clock: one frame of the mother-side furnace, on the SAME law the daughter rack runs
   * (ArmUnit._updateHoldingCatch): span `FT.digestSpanS(massKg)`, progress dt × TIME_SCALE_GAMEPLAY × sunScale
   * (ArmManager writes _digestSunScale from the ResourceSystem multiplier; ?? 1.0 for mocks), phase mapped onto
   * [0, FEED_S]. The staged beat reuses the breakdown machinery with the {kind:'collar'} anchor; the completion
   * CATCH_PROCESSED carries { digested: true }: the mate already paid ({ parked: true }), so GameFlowManager runs
   * removal + comms but pays NOTHING twice.
   *
   * @param {NetProjectile} net — a COLLARED mother net
   * @param {number} dt — seconds
   * @returns {boolean} true when digestion completed (caller splices the net)
   * @private
   */
  _tickCollarDigestion(net, dt) {
    const d = net.targetDebris;
    if (!d) return false;
    if (bigPieces.isPending(d)) return false;   // a pending big piece is never cooked at the collar: it pays when disposed of
    // owner 2026-10-18, "Stay full size, no melting": no furnace, no cook clock. The catch stays
    // welded full size at the collar (the berth hold pins it) until a tip furnace takes it on the trip or [K] jettisons it.
    if (!Constants.isFeatureEnabled('FURNACE_COOK')) return false;
    const FT = Constants.FURNACE_TRANSFER;
    const HOLD_S = FT.HOLD_S, CHOP_S = FT.CHOP_S, FEED_S = FT.FEED_S;
    const CHUNK_COUNT = FT.CHUNK_COUNT;
    const span = FT.digestSpanS(d.mass);
    const sunScale = this._digestSunScale ?? 1.0;
    d._digestProgress = (d._digestProgress || 0) + dt * TimeAuthority.BASE_SCALE * sunScale;
    const t = Math.min(FEED_S, (d._digestProgress / span) * FEED_S);
    // The chop ramp reads this derived phase time (ArmManager's rack ramp reads arm._digestPhaseT: one convention).
    net._digestPhaseT = t;

    // Lazy-init the per-collar breakdown bookkeeping (safe if a test sets COLLARED directly).
    if (net._breakdownStarted === undefined) net._breakdownStarted = false;
    if (net._breakdownChunksFired === undefined) net._breakdownChunksFired = 0;

    if (t < HOLD_S) return false;   // hold: welded full-size, the berth hold pins it

    // Fire the chop-start exactly once when we cross into the chop phase.
    if (!net._breakdownStarted) {
      net._breakdownStarted = true;
      d._breakdownActive = true;   // the furnace visual owns scale/disposal
      eventBus.emit(Events.CATCH_BREAKDOWN_START, {
        armId: 'mother', debrisId: d.id, chunkCount: CHUNK_COUNT,
        anchor: { kind: 'collar', podIndex: net.podIndex },
      });
    }

    // The staged chop: shrink the original out of view across the chop window (the ramp ArmManager's pin loop runs at
    // the rack) so the chunks are what the player sees being fed. updateBerthHold pinned at scaleMul 1 earlier this
    // tick; this re-pin is the last write this frame. The ramp is FT.chopScaleMul, which CaptureNetVisual also reads
    // off the same _digestPhaseT, so the collar bag's deflation cannot drift from the instance scale.
    if (d._breakdownActive) {
      const scaleMul = FT.chopScaleMul(t);
      if (this._debrisField && typeof this._debrisField.pinCapturedDebris === 'function' && d._armPinPos) {
        this._debrisField.pinCapturedDebris(d, d._armPinPos, scaleMul);
      }
    }

    // feed: emit chunk events evenly across [CHOP_S, FEED_S).
    if (t >= CHOP_S && t < FEED_S) {
      const feedSpan = Math.max(1e-6, FEED_S - CHOP_S);
      const feedFrac = (t - CHOP_S) / feedSpan;             // 0 → 1 across feed
      const due = Math.min(CHUNK_COUNT, Math.floor(feedFrac * CHUNK_COUNT) + 1);
      while (net._breakdownChunksFired < due) {
        const index = net._breakdownChunksFired;            // 0-based
        eventBus.emit(Events.CATCH_BREAKDOWN_CHUNK, {
          armId: 'mother', debrisId: d.id, index, total: CHUNK_COUNT,
          anchor: { kind: 'collar', podIndex: net.podIndex },
        });
        net._breakdownChunksFired++;
      }
      return false;
    }

    if (t < FEED_S) return false;   // mid-chop: the hold phase pins above

    // Digestion complete: the furnace ate the body; the collar frees. Mirrors the rack feed-end: flush any chunks a
    // long frame skipped, release the hold first (the furnace owns the body), then NET_CONSUMED (the bag draws in: the
    // net IS the container), then the ONE CATCH_PROCESSED (digested: true; the mate's credit does not re-fire).
    while (net._breakdownChunksFired < CHUNK_COUNT) {
      const index = net._breakdownChunksFired;
      eventBus.emit(Events.CATCH_BREAKDOWN_CHUNK, {
        armId: 'mother', debrisId: d.id, index, total: CHUNK_COUNT,
        anchor: { kind: 'collar', podIndex: net.podIndex },
      });
      net._breakdownChunksFired++;
    }
    d._breakdownActive = false;
    this._clearCatchPins(d);
    net.isActive = false;
    net._berthTimer = -1;
    // Marker for a reader holding a stale reference (as `_cargoDelivered`): the cargo was digested.
    net._digestedOut = true;
    // The catch's mass just LEFT the berthed ledger (the caller splices the net this tick). NET_CONSUMED +
    // CATCH_PROCESSED do not invalidate the attitude-inertia cache (NET_BERTHED / ARM_STATE_CHANGE do), so invalidate
    // it directly (the mirror of adoptLassoCatch's entry side).
    const player = this._player;
    if (player && '_attitudeInertia' in player) player._attitudeInertia = null;
    eventBus.emit(Events.NET_CONSUMED, {
      podIndex: net.podIndex, armId: 'mother', debrisId: d.id,
      anchor: { kind: 'collar', podIndex: net.podIndex },
    });
    eventBus.emit(Events.CATCH_PROCESSED, {
      debrisId: d.id, armId: null, source: 'mother', podIndex: net.podIndex,
      method: 'mother', digested: true,
    });
    return true;
  }

  /**
   * The pin-clearing chokepoint: mother nets have no ArmUnit, so nothing else clears the debris pin flags the
   * reel/berth writes. Idempotent by design; call from EVERY mother exit.
   * @param {object|null} debris
   * @private
   */
  _clearCatchPins(debris) {
    if (!debris) return;
    debris._captured = false;
    debris._armPinned = false;
    debris._armPinPos = null;
    debris._motherParked = false;
    debris._catchRenderMin = 0;
    clearShipRelativeAttitude(debris);   // a released catch tumbles on its own again
    clearRackCell(debris);               // and forgets any cell a cargo flight had assigned
  }

  /**
   * Tear down a berthed catch: clear pins, drop the docked slot, free the launcher. The bag visual removes itself
   * (CaptureNetVisual's STOWED/RELEASED fade path) once the caller splices the net and _getNet returns null.
   * @param {NetProjectile} net
   * @private
   */
  _teardownBerth(net) {
    this._clearCatchPins(net.targetDebris);
    // CUT_AT_NOSE: a boss torn down mid-cut (mission transition, [K] jettison upstream of the prune block) must not
    // leave a waiting piece orphaned at a stale nose pin: release it to the field as free, still-paid salvage.
    if (net._cutPiece && !net._cutPieceFlying) this._releaseCutPiece(net._cutPiece);
    net.isActive = false;
    net._berthTimer = -1;
  }

  /**
   * Re-seat the released catch's orbit from the release position + the mother's velocity. DebrisField.update skips
   * orbit propagation only for _onboardingPinned / _motherParked, NOT _armPinned, so a pinned catch's trueAnomaly
   * kept advancing and a jettisoned whale would snap to wherever its own orbit went. The rebuild is the ONE shared
   * computation (reseatOrbitFromScene), also read by the ArmManager.reset() cargo release. The arm path deliberately
   * accepts the snap (ArmUnit._releaseCapturedDebris resumes the propagated orbit) — do not copy that.
   * @param {NetProjectile} net
   * @private
   */
  _reseatOrbitOnRelease(net) {
    this.reseatBodyOrbit(net.targetDebris);
  }

  /**
   * `_reseatOrbitOnRelease` for a body that no net holds any more (a big piece let go by a push-down or a drag sail:
   * `GameFlowManager.detachHeldPiece` has already taken the net away), so the piece flies on from where it was pinned
   * with her velocity, never along its stale held-time orbit.
   * @param {object|null} d the field's own body @returns {boolean} the orbit was re-seated
   */
  reseatBodyOrbit(d) {
    const player = this._player;
    if (!d || !player || !d._scenePosition || !d.orbit) return false;
    const v = (typeof player.getVelocity === 'function') ? player.getVelocity() : null;
    return !!reseatOrbitFromScene(d.orbit, d._scenePosition, v);
  }

  /**
   * Berthed mass for the translational thrust scaling, summed over attachments. TRANSFERRING counts (in flight, still
   * aboard; the rack does not own it until arrival) so the cargo ledger stays continuous. COLLARED is the nose-side
   * station: the collar holds the mass until the furnace eats it or the rack takes it.
   * @returns {number} kg currently held at the mother launcher (incl. in transit)
   */
  getBerthedMassKg() {
    let sum = 0;
    for (const net of this.activeNets) {
      if (net._isMother && (net.state === STATES.BERTHED || net.state === STATES.COLLARED
                            || net.state === STATES.TRANSFERRING)) {
        sum += net.capturedMass || 0;
      }
    }
    return sum;
  }

  /**
   * The docked catch accessor, read by HUD/status (StatusPanel), the lasso's single-station soft-block (the collar
   * holds ONE body), the adoption guard, releaseDockedCatch, and the foul read. A shot refuses only when its own
   * corridor fouls the mated cargo (getCollarShotFoul), not on occupancy.
   *
   * TRANSFERRING counts: the station frees when the piece lands on the rack, not when it leaves the nose.
   * @returns {NetProjectile|null}
   */
  getDockedCatch() {
    return this.activeNets.find(n => n._isMother
      && (n.state === STATES.BERTHED || n.state === STATES.COLLARED
          || n.state === STATES.TRANSFERRING)) || null;
  }

  /**
   * The collar cook, readable (HUD polls at 10 Hz): progress through the ONE span-law home
   * (`FURNACE_TRANSFER.digestSpanS`). BERTHED is the pre-cook securing window; TRANSFERRING pauses the cook and the
   * daughter's rack reports the piece on arrival, so only COLLARED cooks at the collar. `|| 0` / `?? 1.0` guards keep
   * legacy mocks working.
   *
   * @returns {{frac: number, sunScale: number, kg: number}|null} the cook, or
   *   null when no mother net is COLLARED with a target
   */
  getCollarDigestion() {
    const net = this.activeNets.find(n => n._isMother && n.state === STATES.COLLARED);
    const d = net && net.targetDebris;
    if (!d) return null;
    const span = Constants.FURNACE_TRANSFER.digestSpanS(d.mass);
    return {
      frac: clamp01((d._digestProgress || 0) / span),
      sunScale: this._digestSunScale ?? 1.0,
      kg: d.mass || 0,
    };
  }

  /**
   * Something just left a tip slot or a rack cell (NET_CONSUMED: `TipCargo.releaseSlot`, `ArmManager.unloadHeldCatches`),
   * so room may exist now. Clear the sticky `_cargoDeclined` on every COLLARED mother net other than the one
   * consumed, in this same tick: the nose-full line, the camera reader and the mission-start reader stop saying
   * "nowhere to go" at once, and the first-tick decision runs again (a retry that still finds no room declines again,
   * silently: the refusal comms is once per catch, `_cargoRefused`).
   * @param {{debrisId?: (number|string)}} [p] - the NET_CONSUMED payload
   * @private
   */
  _onRoomFreed(p) {
    const gone = p && p.debrisId;
    for (const n of this.activeNets) {
      if (!n._isMother || n.state !== STATES.COLLARED || !n._cargoDeclined) continue;
      if (gone != null && n.targetDebris && n.targetDebris.id === gone) continue;
      n._cargoDeclined = false;
      n._cargoRetryS = 0;
    }
  }

  /**
   * no-melt: the plain refusal for a new catch while the nose collar holds one that has nowhere to go, or null.
   * Without a furnace the nose never empties by itself: once the hand-off was tried and declined, the catch stays at
   * the collar (a tip furnace takes it on the trip to the next field if it fits) or [K] jettisons it. While a hand-off
   * is still pending (securing, leash, piece in flight, cut under way) it returns null. Shared by the mother net (N),
   * the lasso and the InputManager pre-flight. Pure read: it emits nothing.
   * @returns {string|null}
   */
  getNoseFullLine() {
    // a cut that ran out of empty daughters is paused at the nose: a new net is refused (furnace or not: the cut never
    // cooks the boss)
    for (const n of this.activeNets) {
      if (n._isMother && n.state === STATES.COLLARED && n._cutWaiting && n._cutPiece && !n._cutPieceFlying
          && this._cutActive(n)) return NOSE_FULL_CUT_LINE;
    }
    if (Constants.isFeatureEnabled('FURNACE_COOK')) return null;
    for (const n of this.activeNets) {
      if (!n._isMother || n.state !== STATES.COLLARED) continue;
      if (!n._cargoDeclined || n._leash || n._leashNoseReel || this._cutActive(n)) continue;
      // K does not let a pending big piece go, so this refusal does not offer it.
      if (bigPieces.isPending(n.targetDebris)) {
        return `Nose is full: the ${pieceName(n.targetDebris)} stays at your nose and no daughter can take it. It pays when you dispose of it.`;
      }
      return NOSE_FULL_LINE;
    }
    return null;
  }

  /**
   * no-melt: the station takes the catch parked at the nose collar (the resupply stop; GameFlowManager). Already paid
   * (the mate credited it): nothing is credited or digested, the pins clear and the net leaves the system. The caller
   * removes the body from the field. A catch still being reeled, flown, leashed or cut is left alone.
   * With `onlyId` it frees the collar of THAT piece only (`GameFlowManager.detachHeldPiece`: a big piece being disposed
   * of; the caller clears the field body's own pins, a net may hold a snapshot of it).
   * @param {number|string|null} [onlyId] - hand over only the net around this debris id
   * @returns {number|string|null} the debris id handed over, or null when nothing was handed over
   */
  handOverCollarCatch(onlyId = null) {
    const idx = this.activeNets.findIndex((n) => n._isMother && n.state === STATES.COLLARED && n._berthProcessed
      && !n._leash && !n._leashNoseReel && !this._cutActive(n)
      && (onlyId == null || (n.targetDebris && n.targetDebris.id === onlyId)));
    if (idx < 0) return null;
    const net = this.activeNets[idx];
    const d = net.targetDebris;
    if (!d) return null;
    d._breakdownActive = false;
    this._clearCatchPins(d);
    net.isActive = false;
    net._berthTimer = -1;
    net._digestedOut = true;
    this.activeNets.splice(idx, 1);
    const player = this._player;
    if (player && '_attitudeInertia' in player) player._attitudeInertia = null;
    eventBus.emit(Events.NET_CONSUMED, {
      podIndex: net.podIndex, armId: 'mother', debrisId: d.id,
      anchor: { kind: 'collar', podIndex: net.podIndex },
    });
    return d.id;
  }

  /**
   * Per-shot foul read (firing is never refused because cargo exists as such). A collared body sits on-axis fore of
   * the nose, and a dead-ahead shot sweeps a cone no launcher site clears (foul cone >= 90 deg at every class, whale
   * cargo mated: every forward shot fouls). So a shot whose corridor intersects the mated cargo refuses per-shot:
   * the muzzle is on the cargo's axis (one launcher, centred), a held catch at the collar blocks the shot, fire again
   * once it has left.
   *
   * Geometry: closest approach of the shot ray (launchPos + t*launchDir, t>0) to the docked catch's live pin
   * (`_scenePosition`, as `pinCapturedDebris` wrote it this frame: BERTHED swing, TRANSFERRING arc and collar seat all
   * read as drawn). Foul when closer than the cargo radius + BERTH_CLEARANCE_M (the berth's own keep-out).
   *
   * @param {number} podIndex — the firing launcher (always 0; unused, the read is launcher-independent)
   * @param {{x:number,y:number,z:number}} launchPos — shot origin, METRES (the NetProjectile/fireMotherNet convention)
   * @param {{x:number,y:number,z:number}} launchDir — unit shot direction
   * @returns {NetProjectile|null} the fouled docked net, or null when clear
   */
  getCollarShotFoul(podIndex, launchPos, launchDir) {
    if (!launchPos || !launchDir) return null;
    const M_NET = Constants.SCENE_UNITS_PER_METER;
    const dl = Math.hypot(launchDir.x, launchDir.y, launchDir.z) || 1;
    const nx = launchDir.x / dl, ny = launchDir.y / dl, nz = launchDir.z / dl;
    for (const net of this.activeNets) {
      if (!net._isMother) continue;
      if (net.state !== STATES.BERTHED && net.state !== STATES.COLLARED
          && net.state !== STATES.TRANSFERRING) continue;
      const d = net.targetDebris;
      const sp = d && d.alive !== false ? d._scenePosition : null;
      if (!sp) continue;
      const cx = sp.x / M_NET, cy = sp.y / M_NET, cz = sp.z / M_NET;
      const wx = cx - launchPos.x, wy = cy - launchPos.y, wz = cz - launchPos.z;
      const t = wx * nx + wy * ny + wz * nz;         // metres along the shot
      if (t <= 0) continue;   // closest point aft of the muzzle — not this shot
      const ca = Math.hypot(cx - (launchPos.x + nx * t),
                            cy - (launchPos.y + ny * t),
                            cz - (launchPos.z + nz * t));
      const foulM = (d.sizeMeter || 2) / 2 + (CN.BERTH_CLEARANCE_M ?? 1.0);
      if (ca < foulM) return net;
    }
    return null;
  }

  /**
   * Manual jettison ([K]). Releases the berthed/parked catch: pins cleared, orbit re-seated, net expended, launcher
   * freed. A still-running securing timer is cancelled: jettison before expiry means NO score; a parked catch was
   * already credited.
   *
   * A hand-off in flight is IRREVOCABLE (~3 s beat; releasing mid-arc would drop a body that is neither on the tether
   * nor on the rack). The refusal speaks so [K] is never silently ignored.
   * @returns {boolean} whether a docked catch was released
   */
  releaseDockedCatch() {
    const net = this.getDockedCatch();
    if (!net) return false;
    if (net.state === STATES.TRANSFERRING) {
      // the leash hand-off (net._leash) is not a flight to a daughter
      const onLeash = net._leash === true;
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'HOUSTON', channel: 'CMD',
        text: onLeash
          ? `The catch is on its leash to radiator ${(net._leashTipIndex ?? 0) + 1}. Too late to jettison.`
          : 'Cargo is already in transit to the daughter — too late to jettison.',
        priority: 'warning',
      });
      return false;
    }
    // A pending BIG piece pays when it is disposed of; letting it go would throw the pay away, so K (and the LET GO
    // chip, the same call) refuses in plain words and changes nothing. A piece not yet mated (securing timer still
    // running) is not pending: K works there.
    if (bigPieces.isPending(net.targetDebris)) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'HOUSTON', channel: 'CMD',
        text: `K doesn't let go of the ${pieceName(net.targetDebris)}: it pays when you dispose of it. Press U to choose.`,
        priority: 'warning', _reactive: true,
      });
      return false;
    }
    // [K] during the nose reel-in stops the reel cleanly before the release.
    if (net._leashNoseReel) {
      const drv = this._player && this._player.leashDriver;
      if (drv && typeof drv.cancelNoseReel === 'function') drv.cancelNoseReel(net);
      net._leashNoseReel = false;
    }
    return net.release();
  }

  /**
   * Adopt a lassoed piece onto the ONE holding model.
   *
   * The lasso's reel delivers the catch to the collar seat; this builds a mother net ALREADY BERTHED there, so the
   * piece rides the mother catch machinery: the berth hold pins it at the collar, the securing timer mates it
   * (CATCH_PROCESSED { parked: true }: credit lands exactly once), it joins the berthed ledger (getBerthedMassKg),
   * then the auto-transfer or the collar-digestion clock finishes it (CATCH_PROCESSED { digested: true }, removal).
   *
   * Deliberately emits NEITHER NET_FIRED NOR NET_BERTHED: those chain the mother launch recoil, the autopilot
   * attitude-hold, the berth clunk/chime and the PARK_HOLD camera beat, which the lasso's capture UX must not
   * inherit. The lasso fires its own LASSO_STOWED/CAPTURED beats at reel completion; this is pure storage machinery.
   *
   * @param {object} target — the lassoed debris (alive, pinned by the lasso reel)
   * @returns {NetProjectile|null} the berthed net, or null when the dock is busy (the caller holds the piece off and
   *   retries: cargo is never destroyed) or the system has no player/debrisField context.
   */
  adoptLassoCatch(target) {
    const player = this._player;
    const debrisField = this._debrisField;
    if (!target || target.alive === false || !player || !debrisField) return null;
    // the collar holds ONE body; the caller pends while the dock is busy
    if (this.getDockedCatch() || this.hasMotherNetInFlight()) return null;

    // Adoption is the ownership transfer onto the one holding model: drop a severed runaway's stale claim HERE, past
    // the busy guard (a refused adoption pends, and the pend keeps the EXPENDED arm's bounded-drift release armed; the
    // claim also deliberately survives the lasso's reel, whose failure paths return the runaway to that same release).
    dropSeveredCatchClaim(target);

    const M_NET = Constants.SCENE_UNITS_PER_METER;
    // The collar anchor (on-axis), not the launcher muzzle (30 mm behind it).
    const berthAnchor = (typeof player.getNetBerthCollarPositionInto === 'function')
      ? player.getNetBerthCollarPositionInto(new THREE.Vector3())
      : (typeof player.getNetPodPositionInto === 'function')
        ? player.getNetPodPositionInto(0, new THREE.Vector3()) : new THREE.Vector3();
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(player.quaternion).normalize();

    const net = new NetProjectile({
      netClass: CN.LARGE,
      armIndex: -1,
      podIndex: 0,
      launchPosition: { x: berthAnchor.x / M_NET, y: berthAnchor.y / M_NET, z: berthAnchor.z / M_NET },
      launchDirection: { x: fwd.x, y: fwd.y, z: fwd.z },
      targetDebris: target,
      captureMode: MODES.CINCH,
      anchorProvider: (out) => player.getNetPodPositionInto(0, out),
    });

    // Berth seeds: the state the mother reel hands off at, for a piece delivered already seated at the collar. The ctx
    // mirrors fireMotherNet's shape (the corridor gate reads armManager/lassoSystem on REELING; harmless here).
    net._ctx = {
      player,
      debrisField,
      armManager: this._armManager,
      lassoSystem: this._lassoSystem,
      captureNetSystem: this,
    };
    net.catchResult = 'success';
    net.capturedMass = target.mass || 0;
    const apexM = CN.REEL_HOME.APEX_AT_RING_M;
    net.tetherPaidOut = apexM;
    net._remainingM = apexM;
    net._reelSeedM = apexM;
    net._effectiveStandoffM = apexM;
    net._seedReelHome(target, player);
    // Born at HOME (where the mother reel ends: bag mouth at the ring, catch seated on the collar axis, INSIDE the bag).
    // LassoSystem's reel delivers to the same point (catchHomeDistM), so the hand-off does not snap.
    // owner 2026-08-26: the net/bag is AROUND the debris, engulfing it.
    net._catchSeatM = net._homeSeatM;
    net._seat0M = net._homeSeatM;
    net._reelDistM = net._homeCatchM;
    net._lateral = new THREE.Vector3();
    net._fwdLagged = fwd.clone();
    if (target.tumbleAxis && player.quaternion) {
      const qCatch = new THREE.Quaternion().setFromAxisAngle(target.tumbleAxis, target.tumbleAngle || 0);
      net._qLocal = player.quaternion.clone().invert().multiply(qCatch);
    } else {
      net._qLocal = new THREE.Quaternion();
    }
    // ramp clock seeded DONE (re-ramping from 0 would pop the drawn size); `_catchFloorScale` ignores the clock, so
    // this is bookkeeping only
    net._floorRampT = CN.MOTHER_CATCH_MIN_RENDER_RAMP_S ?? 0.6;
    net._berthTimer = CN.BERTH_SECURE_S ?? 4.0;
    net._berthProcessed = false;
    // Born BERTHED, never LAUNCHED: NetProjectile.update() emits NET_CEREMONY_START on a fresh net's first tick, which
    // would replay the whole launch beat list over a net that never flies (the camera chased beat anchors hundreds of
    // km into empty space while the catch digested). Adoption is the QUIET hand-off.
    net._ceremonyStartEmitted = true;
    net._tumbleCarryover = Math.min(Math.abs(target.tumbleRate || 0), CN.TUMBLE_CARRYOVER_MAX_RAD_S ?? 0.6);
    net._tumbleCarryAngle = 0;
    net._transitionTo(STATES.BERTHED);

    this.activeNets.push(net);

    // Attach the standard berthed-bag VISUAL: NET_FIRED / NET_BERTHED / NET_CEREMONY_START stay suppressed here, but
    // CaptureNetVisual creates bags on NET_FIRED alone, so an adopted catch would sit at the collar as a BARE
    // icosahedron through berth + digestion. NET_ADOPTED has exactly one consumer by design: the visual attaches the
    // same cinched bag + welded film + chop deflation a mother berth gets.
    eventBus.emit(Events.NET_ADOPTED, { podIndex: 0, armIndex: -1 });

    // The catch's mass just entered the berthed ledger. A mother berth invalidates the attitude inertia via
    // NET_BERTHED, which this path must not emit: invalidate the cache directly.
    if ('_attitudeInertia' in player) player._attitudeInertia = null;

    return net;
  }

  /**
   * A daughter hands the catch she holds to the nose (archive/research/2026-10-nose-handoff.md). Modelled on
   * `adoptLassoCatch`: the catch is already seated on the collar axis (she flew it to the seat the mother's own catches
   * use, `catchHomeDistM`), so the net is born AT HOME, no reel, no snap, and goes straight to COLLARED: the mate
   * already happened (her rack paid it, `ArmUnit` rack park, `CATCH_PROCESSED` source 'rack'), so no berth timer and
   * no second credit. It behaves like a mother catch at the collar everywhere (leash, trip melting, K, cut rules,
   * net-shot foul). The first-tick hand-off decision stays OFF (`_cargoDeclined`, retry parked) until the daughter is
   * home: the leash cannot turn the ship under her. `ArmUnit` calls `releaseNoseRetry(net)` then.
   *
   * @param {object} target — the catch (alive, pinned to the daughter's rack until this call)
   * @returns {NetProjectile|null} the collared net, or null when the nose is busy / the system has no player or debris field
   *   (the daughter keeps the catch and retries)
   */
  adoptDaughterCatch(target) {
    const player = this._player;
    const debrisField = this._debrisField;
    if (!target || target.alive === false || !player || !debrisField) return null;
    if (this.getDockedCatch() || this.hasMotherNetInFlight()) return null;
    const M_NET = Constants.SCENE_UNITS_PER_METER;
    const berthAnchor = (typeof player.getNetBerthCollarPositionInto === 'function')
      ? player.getNetBerthCollarPositionInto(new THREE.Vector3())
      : (typeof player.getNetPodPositionInto === 'function')
        ? player.getNetPodPositionInto(0, new THREE.Vector3()) : new THREE.Vector3();
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(player.quaternion).normalize();
    const net = new NetProjectile({
      netClass: CN.LARGE,
      armIndex: -1,
      podIndex: 0,
      launchPosition: { x: berthAnchor.x / M_NET, y: berthAnchor.y / M_NET, z: berthAnchor.z / M_NET },
      launchDirection: { x: fwd.x, y: fwd.y, z: fwd.z },
      targetDebris: target,
      captureMode: MODES.CINCH,
      anchorProvider: (out) => player.getNetPodPositionInto(0, out),
    });
    net._ctx = { player, debrisField, armManager: this._armManager, lassoSystem: this._lassoSystem, captureNetSystem: this };
    net.catchResult = 'success';
    net.capturedMass = target.mass || 0;
    const apexM = CN.REEL_HOME.APEX_AT_RING_M;
    net.tetherPaidOut = apexM;
    net._remainingM = apexM;
    net._reelSeedM = apexM;
    net._effectiveStandoffM = apexM;
    net._seedReelHome(target, player);
    net._catchSeatM = net._homeSeatM;
    net._seat0M = net._homeSeatM;
    net._reelDistM = net._homeCatchM;
    net._lateral = new THREE.Vector3();
    net._fwdLagged = fwd.clone();
    if (target.tumbleAxis && player.quaternion) {
      const qCatch = new THREE.Quaternion().setFromAxisAngle(target.tumbleAxis, target.tumbleAngle || 0);
      net._qLocal = player.quaternion.clone().invert().multiply(qCatch);
    } else {
      net._qLocal = new THREE.Quaternion();
    }
    net._floorRampT = CN.MOTHER_CATCH_MIN_RENDER_RAMP_S ?? 0.6;
    net._ceremonyStartEmitted = true;
    net._tumbleCarryover = 0;
    net._tumbleCarryAngle = 0;
    net._pendulumAngle = 0;
    net._pendulumVel = 0;
    // MATED already (paid on her rack): no berth timer (BERTHED -> COLLARED is the mate), no CATCH_PROCESSED here.
    net._berthTimer = 0;
    net._berthProcessed = true;
    net._noseAdopted = true;
    net._transitionTo(STATES.COLLARED);
    // the leash may not start until the daughter is home (it turns the whole ship): parked until `releaseNoseRetry`
    net._cargoDeclined = true;
    net._cargoRetryS = -1e9;
    this.activeNets.push(net);
    eventBus.emit(Events.NET_ADOPTED, { podIndex: 0, armIndex: -1 });
    if ('_attitudeInertia' in player) player._attitudeInertia = null;
    // No gap: the net's own hold writes the catch's pin NOW, so the frame before the next net tick is not unpinned.
    net.updateBerthHold(0);
    return net;
  }

  /** The daughter is home: let the adopted net try its leash hand-off on the very next tick. */
  releaseNoseRetry(net) {
    if (net && net._noseAdopted) net._cargoRetryS = 1e9;
  }

  /**
   * Take back a daughter's hand-over before she lets go (tug test failed, or her carry aborted): the net leaves the
   * list (the visual follows the list) and stops holding. Unlike `_teardownBerth` it does NOT clear the catch's pins
   * and rack record: the catch goes back to the daughter's rack as it was (`ArmUnit._noseRollback`).
   * Returns true when the net was in play.
   */
  cancelDaughterAdoption(net) {
    if (!net) return false;
    net.isActive = false;
    net._berthTimer = -1;
    const i = this.activeNets.indexOf(net);
    if (i >= 0) this.activeNets.splice(i, 1);
    return i >= 0;
  }

  /**
   * Metres from the berth anchor (the collar plane) to where a catch's centre ends on the collar axis (HOME, see
   * `catchHomeDistM`). The lasso's reel and adoption read this so they agree with the mother reel.
   * @param {object} d — the catch (sizeMeter)
   * @returns {number} metres
   */
  getCatchHomeDistM(d) {
    return catchHomeDistM(this._player, this._armManager, d);
  }

  /**
   * Fore extent (metres from the collar plane, the berth anchor) of the busiest active mother-net berth, 0 when the
   * collar station is clear. A lassoed piece waiting for the collar holds this far ahead of the seat so it never
   * overlaps the occupant (docked or inbound). Conservative: an inbound net reserves its eventual berth footprint.
   * Reads the shared `motherNetForeExtentM`: a corridor-held or extended-standoff member reports its TRUE far face
   * (frozen slot / honest apex), so the pend cannot pin inside the tandem body.
   * @returns {number} metres
   */
  getCollarQueueDepthM() {
    let ext = 0;
    for (const net of this.activeNets) {
      if (!net._isMother || !net.isActive) continue;
      if (net.state === STATES.STOWED || net.state === STATES.RELEASED) continue;
      const d = net.targetDebris;
      if (!d || d.alive === false) continue;
      const { fore } = motherNetForeExtentM(net);
      if (fore > ext) ext = fore;
    }
    return ext;
  }

  /** Reset to clean state (game reset / new session). */
  reset() {
    this.activeNets = [];
    this._cooldownTimers.clear();
    this._motherPodInventory = new Array(this._motherPodCount()).fill(0);
    this._motherPodMax       = new Array(this._motherPodCount()).fill(0);
    this._initialized = false;
    this._playerHasFragmented = false;
    // a reset drops every net with no terminal events, so the whistle/winch loops would stick; optional-chained:
    // headless tests inject no audioSystem
    this._audioSystem?._stopNetLoops?.();
  }

  /**
   * Number of Mother Large Net launchers (CAPTURE_NET.MOTHER_POD_COUNT: one, centred). Never below 1.
   * @private
   * @returns {number}
   */
  _motherPodCount() {
    const n = Constants.CAPTURE_NET && Constants.CAPTURE_NET.MOTHER_POD_COUNT;
    return Math.max(1, Math.floor(n) || 1);
  }

  /**
   * Fire a Large Net from the Mother's launcher.
   *
   * @param {number} podIndex   — the launcher index; always 0 (the podIndex API is kept)
   * @param {object} launchPos  — world position {x, y, z} in metres
   * @param {object} launchDir  — normalised direction {x, y, z}
   * @param {object} target     — debris object (with .position, .mass, .id)
   * @param {string} [mode]     — 'SLAM_WRAP' or 'CINCH' (auto-recommend if omitted)
   * @returns {NetProjectile|null} The created projectile, or null on failure
   */
  fireMotherNet(podIndex, launchPos, launchDir, target, mode) {
    if (tripRefuses('net')) return null;            // no net while the ship burns to the next field
    if (!Constants.FEATURE_FLAGS.CAPTURE_NET) return null;
    if (target && target._disposed === true) return null;       // a piece that was disposed of is no catch
    // the catch limit at the source (§49 row 1), so every caller (N key, autopilot, dev scenario) is refused the same way
    if (target && overCatchLimit(target.mass, Constants.CAPTURE_NET && Constants.CAPTURE_NET.LARGE)) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: catchLimitLine(target.mass, Constants.CAPTURE_NET.LARGE), source: 'SYSTEM', channel: 'CMD', priority: 'warning',
      });
      return null;
    }
    if (!(podIndex >= 0) || podIndex >= this._motherPodCount()) return null;
    // Refusals speak (as in LassoSystem) so the player knows WHY nothing fired and what fixes it.
    // DECISIONS §33 row 3: at 0 nets there is ONE line, the same one the small-net path says.
    if (this._motherPodInventory[podIndex] <= 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: OUT_OF_MOTHER_NETS_LINE,
        source: 'SYSTEM',
        channel: 'CMD',
        priority: 'warning',
      });
      return null;
    }
    if (this._cooldownTimers.has(`pod_${podIndex}`)) {
      const secs = this._cooldownTimers.get(`pod_${podIndex}`) || 0;
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `Mother net reloading. ${Math.ceil(secs)}s`,
        source: 'SYSTEM',
        channel: 'CMD',
        priority: 'info',
      });
      return null;
    }
    // No fire refusal for cargo occupancy as such; only the per-shot foul below. The launcher is on the axis, where
    // the catch seat is, so a catch held at the collar fouls every shot (owner-approved physics: the catch is in the way).
    // A catch at the collar with nowhere to go refuses every new net, in plain words (once per press).
    const full = this.getNoseFullLine();
    if (full) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: full, source: 'SYSTEM', channel: 'CMD', priority: 'warning',
      });
      return null;
    }
    const foulNet = this.getCollarShotFoul(podIndex, launchPos, launchDir);
    if (foulNet) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'This shot fouls the cargo at the collar — pull off the nose, or press K to let the catch go.',
        source: 'SYSTEM',
        channel: 'CMD',
        priority: 'warning',
      });
      return null;
    }

    // A launched net is used up, hit or miss (DECISIONS §33 row 1)
    this._motherPodInventory[podIndex]--;

    // NET_CEREMONY beats 5-6 (BRAKE_ENVELOP, CINCH) assume the CINCH FSM path: SLAM_WRAP skips ENVELOP and
    // CINCH_CLOSING (CONTACT -> SECURE_CHECK -> CAPTURED in <1 s), so the visual would show no engulf or cinch.
    // Force CINCH when the auto-recommender would pick SLAM_WRAP; an explicit `mode` is still honoured. CINCH_P_BASE
    // is >= SLAM_P_BASE in all pairings, so no score regression.
    let resolvedMode = mode || recommendCaptureMode(target);
    if (!mode && Constants.FEATURE_FLAGS.NET_CEREMONY) {
      resolvedMode = MODES.CINCH;
    }

    const net = new NetProjectile({
      netClass:       CN.LARGE,
      armIndex:       -1,
      podIndex,
      launchPosition: launchPos,
      launchDirection: launchDir,
      targetDebris:   target,
      captureMode:    resolvedMode,
      // Polled every frame for the pod muzzle's CURRENT world position (scene units). Without it the net renders at a
      // stale absolute point that drifts ~45 km apparent in the first 0.65 s. Null falls back to the metres-based test
      // path (headless mocks, no player ref).
      anchorProvider: this._player
        ? (out) => (typeof this._player.getNetPodPositionInto === 'function'
            ? this._player.getNetPodPositionInto(podIndex, out)
            : out)
        : null,
    });
    // Berth context: player (ship-relative reel frame), debrisField (pinCapturedDebris API), armManager + lassoSystem
    // (recovery-corridor test), and the system itself (the corridor gate reads the OTHER docked nets' cargo).
    net._ctx = {
      player: this._player,
      debrisField: this._debrisField,
      armManager: this._armManager,
      lassoSystem: this._lassoSystem,
      captureNetSystem: this,
    };

    this.activeNets.push(net);

    eventBus.emit(Events.NET_FIRED, {
      source:   'mother',
      podIndex,
      netClass: 'LARGE',
      remaining: this._motherPodInventory[podIndex],
    });

    this._emitMotherInventory();
    this._announceLastMotherNet();

    return net;
  }

  /**
   * Fire a net from a daughter arm (Medium for weaver, Small for spinner).
   *
   * @param {object} arm        — ArmUnit instance (must have getNetInventory, decrementNetInventory)
   * @param {number} armIndex   — arm array index
   * @param {object} launchPos  — world position {x, y, z} in metres
   * @param {object} launchDir  — normalised direction {x, y, z}
   * @param {object} target     — debris object
   * @param {string} [mode]     — 'SLAM_WRAP' or 'CINCH'
   * @returns {NetProjectile|null}
   */
  fireDaughterNet(arm, armIndex, launchPos, launchDir, target, mode) {
    if (!Constants.FEATURE_FLAGS.CAPTURE_NET) return null;

    // Net inventory gate
    const inventory = (typeof arm.getNetInventory === 'function') ? arm.getNetInventory() : 0;
    if (inventory <= 0) return null;

    // Cooldown gate
    if (this._cooldownTimers.has(`arm_${armIndex}`)) return null;

    // Decrement inventory
    if (typeof arm.decrementNetInventory === 'function') {
      arm.decrementNetInventory();
    }

    const netClass = (arm.config?.type === 'weaver') ? CN.MEDIUM : CN.SMALL;

    // The net leaves the arm's fore net-launcher canister, not the body centre: when the arm exposes the mesh-derived
    // muzzle (real ArmUnit), it overrides the caller's launch position (the SAME source `_anchorScene()` polls, so
    // net.position and the co-orbiting anchor agree from tick 0; ~0.11-0.20 m along the nose). Mock arms keep the
    // explicit launchPos. Muzzle is scene units -> metres.
    let spawnPos = launchPos;
    if (typeof arm.getNetMuzzleWorldInto === 'function') {
      const M_NET = Constants.SCENE_UNITS_PER_METER;   // 1 m in scene units (matches ArmUnit.M)
      if (!this._muzzleScratch) this._muzzleScratch = new THREE.Vector3();
      const mz = arm.getNetMuzzleWorldInto(this._muzzleScratch);
      spawnPos = { x: mz.x / M_NET, y: mz.y / M_NET, z: mz.z / M_NET };
    }

    // Force CINCH so the ENVELOP / CINCH_CLOSING visuals render during the ceremony (rationale: see fireMotherNet).
    let resolvedMode = mode || recommendCaptureMode(target);
    if (!mode && Constants.FEATURE_FLAGS.NET_CEREMONY) {
      resolvedMode = MODES.CINCH;
    }

    const net = new NetProjectile({
      netClass,
      armIndex,
      podIndex: -1,
      launchPosition: spawnPos,
      launchDirection: launchDir,
      targetDebris:   target,
      captureMode:    resolvedMode,
      sourceArm:      arm,           // retained for inventory restoration on miss
    });

    this.activeNets.push(net);

    const remaining = (typeof arm.getNetInventory === 'function') ? arm.getNetInventory() : 0;

    eventBus.emit(Events.NET_FIRED, {
      source:   'daughter',
      armIndex,
      // EXPLICIT, not absent: AudioSystem's mother gate reads `data.podIndex < 0`, and `undefined < 0` is false, so a
      // daughter fire started the mother canister thump + whistle loop and leaked it until session reset.
      podIndex: -1,
      netClass: netClass === CN.MEDIUM ? 'MEDIUM' : 'SMALL',
      remaining,
    });

    eventBus.emit(Events.NET_INVENTORY_CHANGED, {
      source: 'daughter',
      armIndex,
      remaining,
    });

    return net;
  }

  /** Total Mother Large Net count (the launcher magazine; sums the array). */
  getMotherNetCount() {
    let n = 0;
    for (let i = 0; i < this._motherPodInventory.length; i++) n += (this._motherPodInventory[i] || 0);
    return n;
  }

  /** Mother net capacity at the current line-fibre tier (4 at the start tier). */
  getMotherNetCapacity() { return this._motherNetCapacity; }

  /**
   * Mass of the mother's nets aboard, kg: count x the current line-fibre tier's packed-net mass
   * (Constants.TETHER_TIERS[tier].netMassKg.mother; 1.425 kg at the start tier). Nets bought before an upgrade count
   * as re-packed (a simplification). The net's flight physics keep CAPTURE_NET.LARGE.MASS.
   */
  getMotherNetMassKg() {
    const row = Constants.TETHER_TIERS[this._motherNetTier];
    const each = (row && row.netMassKg && row.netMassKg.mother) || CN.LARGE.MASS;
    return this.getMotherNetCount() * each;
  }

  /**
   * Line-fibre upgrade (ArmManager.applyTetherUpgrade, the one hub): raise the mother's magazine to `n` nets.
   * Capacity never drops. The loaded count stays (new cartridges arrive empty and fill at the stop) unless `fill` is
   * set (the save-load path: every launcher full). Emits NET_INVENTORY_CHANGED (mother, with the new podMax).
   * @param {number} n nets the launcher holds at this tier
   * @param {{tier?: number, fill?: boolean}} [opts] `tier` = the TETHER_TIERS index (for the net mass; derived from `n`
   *   when absent), `fill` = load every cartridge
   */
  setMotherNetCapacity(n, opts = {}) {
    const cap = Math.max(this._motherNetCapacity, Math.floor(n) || 0);
    this._motherNetCapacity = cap;
    let tier = opts.tier;
    if (!Number.isInteger(tier)) tier = Constants.TETHER_TIERS.findIndex((t) => t.nets && t.nets.mother === cap);
    if (tier >= 0 && tier < Constants.TETHER_TIERS.length) this._motherNetTier = Math.max(this._motherNetTier, tier);
    // Before init() (or with the flag off) only the capacity is recorded: init() / the GAME_RESET reseed fill to it.
    if (!Constants.FEATURE_FLAGS.CAPTURE_NET || !this._initialized) return;
    this._motherPodMax = new Array(this._motherPodCount()).fill(cap);
    if (opts.fill) this._motherPodInventory = new Array(this._motherPodCount()).fill(cap);
    this._emitMotherInventory(true);
  }

  /**
   * Spend one mother net for a shot that has really launched (the small-net path in LassoSystem calls this at launch,
   * after every refusal check; fireMotherNet spends its own). One count for both paths, DECISIONS §33 row 1.
   * @returns {boolean} true if a net was spent, false at 0 (or flag off)
   */
  spendMotherNet() {
    if (!Constants.FEATURE_FLAGS.CAPTURE_NET) return false;
    for (let i = 0; i < this._motherPodInventory.length; i++) {
      if ((this._motherPodInventory[i] || 0) > 0) {
        this._motherPodInventory[i]--;
        this._emitMotherInventory();
        this._announceLastMotherNet();
        return true;
      }
    }
    return false;
  }

  /**
   * One line when a shot leaves exactly one mother net. Emitted from here so a lasso shot and a heavy-piece shot both
   * say it, once.
   * @private
   */
  _announceLastMotherNet() {
    if (this.getMotherNetCount() !== 1) return;
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: ONE_MOTHER_NET_LEFT_LINE,
      source: 'SYSTEM',
      channel: 'CMD',
      priority: 'warning',
    });
  }

  /** Inventory of the Mother launcher (podIndex is always 0 — one launcher). */
  getMotherPodInventory(podIndex) {
    return this._motherPodInventory[podIndex] || 0;
  }

  /** Magazine capacity of the Mother launcher (podIndex is always 0). */
  getMotherPodMax(podIndex) {
    return this._motherPodMax[podIndex] || 0;
  }

  /**
   * Set the Mother launcher inventory (persistence restore). Accepts a number or any array (a legacy two-pod save
   * [a, b] is summed), capped at the magazine size.
   */
  setMotherPodInventory(counts) {
    const total = this._sumLegacyPodCounts(counts);
    if (total === null) return;
    this._motherPodInventory = [clamp(this._motherPodMax[0] || 0, 0, total)];
  }

  /**
   * Sum a saved launcher count: a number, or an array of per-launcher counts (the old two-pod save [podA, podB]).
   * Non-finite / negative entries count as 0. Returns null when `counts` is neither.
   * @private
   * @param {number|number[]} counts
   * @returns {number|null}
   */
  _sumLegacyPodCounts(counts) {
    const one = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
    if (Array.isArray(counts)) return counts.reduce((a, v) => a + one(v), 0);
    if (typeof counts === 'number') return one(counts);
    return null;
  }

  /** True when the Mother launcher has space for another net. */
  hasMotherPodSpace() {
    if (!Constants.FEATURE_FLAGS.CAPTURE_NET) return false;
    for (let i = 0; i < this._motherPodInventory.length; i++) {
      if ((this._motherPodInventory[i] || 0) < (this._motherPodMax[i] || 0)) return true;
    }
    return false;
  }

  /**
   * True when a docked daughter of `type` ('weaver' large / 'spinner' small) has room for one more net: the shop's
   * full check for the daughter-net items (the arm manager is the one this system was initialised with).
   * @param {'weaver'|'spinner'} type
   */
  hasDaughterNetSpace(type) {
    if (!Constants.FEATURE_FLAGS.CAPTURE_NET) return false;
    const am = this._armManager;
    return !!(am && typeof am.hasDaughterNetSpace === 'function' && am.hasDaughterNetSpace(type));
  }

  /**
   * Load exactly one Large Net into the Mother launcher if it has space (shop restock: one net per purchase,
   * REPLACEMENT_COST, mirroring the daughters' per-net reload economy).
   * @returns {boolean} true if a net was loaded
   */
  loadOneMotherNet() {
    if (!Constants.FEATURE_FLAGS.CAPTURE_NET) return false;
    // One launcher: the entry with the most free space (largest max−current).
    let bestPod = -1;
    let bestFree = 0;
    for (let i = 0; i < this._motherPodInventory.length; i++) {
      const free = (this._motherPodMax[i] || 0) - (this._motherPodInventory[i] || 0);
      if (free > bestFree) { bestFree = free; bestPod = i; }
    }
    if (bestPod < 0) return false;
    this._motherPodInventory[bestPod]++;
    this._emitMotherInventory(true);
    return true;
  }

  /** Get the active net projectile for a given arm index (if any). */
  getActiveNetForArm(armIndex) {
    return this.activeNets.find(n => n.armIndex === armIndex) || null;
  }

  /** Get the active net projectile for the Mother launcher (podIndex 0) (if any). */
  getActiveNetForPod(podIndex) {
    return this.activeNets.find(n => n.podIndex === podIndex) || null;
  }

  /**
   * Whether the Mother launcher is in its post-fire cooldown (InputManager's pre-slew gate, so a cooldown fire is
   * refused before the aim slew runs).
   * @param {number} podIndex
   * @returns {boolean}
   */
  isMotherPodOnCooldown(podIndex) {
    return this.getCooldown('pod', podIndex) > 0;
  }

  /**
   * Net class fired by a mother pod (InputManager's lead-aim provider reads the launch speed from it).
   * @param {number} podIndex — the one launcher fires LARGE
   * @returns {object} CN.LARGE
   */
  getMotherNetClass(podIndex) { // eslint-disable-line no-unused-vars
    return CN.LARGE;
  }

  /**
   * True when any mother-pod net (podIndex >= 0) is in a non-terminal, non-berthed state. A second net from the same
   * launcher frame breaks the VISUAL (the visual map is keyed `pod_${podIndex}` and early-returns when the key
   * exists) as well as the physics, so the InputManager refusal gates on this. BERTHED is excluded: a berthed catch
   * has its own per-shot read (`getCollarShotFoul`).
   * @returns {boolean}
   */
  hasMotherNetInFlight() {
    return this.activeNets.some(n =>
      n.podIndex >= 0 && n.isActive
      && n.state !== STATES.STOWED && n.state !== STATES.RELEASED
      && n.state !== STATES.BERTHED && n.state !== STATES.COLLARED);
  }

  /**
   * Get captured mass currently on an arm's net (for CoM integration).
   * Returns netClass mass + debris mass when a net is captured/reeling.
   * @param {number} armIndex
   * @returns {number} mass in kg
   */
  getCapturedNetMass(armIndex) {
    const net = this.getActiveNetForArm(armIndex);
    if (!net) return 0;
    if (net.state === STATES.CAPTURED || net.state === STATES.REELING) {
      return net.capturedMass + (net.netClass.MASS || 0);
    }
    return 0;
  }

  /**
   * Check if an arm/pod is in cooldown.
   * @param {'arm'|'pod'} type
   * @param {number} index
   * @returns {number} remaining cooldown seconds (0 = ready)
   */
  getCooldown(type, index) {
    return this._cooldownTimers.get(`${type}_${index}`) || 0;
  }

  /** Whether the player has ever caused fragmentation. */
  get playerHasFragmented() { return this._playerHasFragmented; }
  set playerHasFragmented(v) { this._playerHasFragmented = !!v; }

  /**
   * Process a fragmentation event and apply (or waive) consequences.
   * Returns true if mercy rule was applied (first-time waiver).
   *
   * @param {string} debrisId
   * @param {number} fragmentCount
   * @returns {boolean} mercyApplied
   */
  handleFragmentation(debrisId, fragmentCount) {
    const mercyApplied = CN.FRAG_MERCY_FIRST_FREE && !this._playerHasFragmented;
    this._playerHasFragmented = true;

    // the credit penalty (waived on the first-time mercy)
    if (!mercyApplied && (CN.FRAG_CREDIT_PENALTY || 0) > 0 && fragmentCount > 0) {
      eventBus.emit(Events.SCORING_AWARD, {
        points: -(CN.FRAG_CREDIT_PENALTY * fragmentCount),
        reason: 'Fragmentation penalty',
      });
    }

    eventBus.emit(Events.NET_FRAGMENTATION, {
      debrisId,
      fragmentCount,
      mercyApplied,
    });

    return mercyApplied;
  }

  /**
   * Get serialisable state for PersistenceManager. `motherPodInventory` is a one-element array [n]
   * (`restoreState` still reads the old two-pod shape).
   * @returns {object}
   */
  getState() {
    return {
      motherPodInventory: [...this._motherPodInventory],
      playerHasFragmented: this._playerHasFragmented,
    };
  }

  /**
   * Restore state from PersistenceManager.
   * @param {object} state
   */
  restoreState(state) {
    if (!state) return;
    const saved = this._sumLegacyPodCounts(state.motherPodInventory);
    if (saved !== null) {
      // Seed the magazine max if init() has not (out-of-order load paths) so the clamp has a real ceiling: a save from
      // before the MAGAZINE_SIZE downsize can carry counts above the cap and must not load an over-max magazine.
      // One launcher: a legacy two-pod save ([a, b]) is summed and capped: [2, 1] -> [3], [3, 4] -> [4].
      // No save-version bump; the writer (getState) emits [n].
      if (!this._motherPodMax.some((m) => m > 0)) {
        this._motherPodMax = new Array(this._motherPodCount()).fill(this._motherNetCapacity);
      }
      this._motherPodInventory = [Math.min(saved, this._motherPodMax[0] || 0)];
    }
    if (typeof state.playerHasFragmented === 'boolean') {
      this._playerHasFragmented = state.playerHasFragmented;
    }
    this._initialized = true;

    // Emit so listeners (launcher caps, HUD NetInventoryPanel) sync to the restored magazine. Mirrors init()'s emit.
    this._emitMotherInventory(true);
  }
}


/** Singleton CaptureNetSystem instance. */
export const captureNetSystem = new CaptureNetSystem();
export default captureNetSystem;
