/**
 * CaptureNet.js — Capture Net Projectile + System Manager
 * ST-9.4 C-6: Config G Capture Net (Sub-Tasks a–e)
 *
 * Implements the full net capture cycle per CAPTURE_NET.md:
 *   a) Net projectile + deploy mechanics (state machine, flight physics)
 *   b) Catch detection + tangle quality (cling probability, frag risk)
 *   c) Reel-in + tension (motor reel, abort/release)
 *   d) Stow + cargo hand-off (inventory depletion, debris transfer)
 *   e) HUD indicators (inventory tracking, reel progress, captured mass)
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
// Debris cutting step 5 (CUT_AT_NOSE): the pure planner — called ONCE when a
// collared catch is over the hand-off gate.
import { planCuts } from '../systems/cutPlanner.js';
import { OUT_OF_MOTHER_NETS_LINE, ONE_MOTHER_NET_LEFT_LINE, targetRangeM, netMaxReachM } from '../systems/netRouting.js';
export { netMaxReachM };   // net-reach-ticker: the function moved to netRouting.js (the reticle reads it without this module)
// Cargo-continuity S7: the carrier scorer lives with the rest of the CoM maths
// (ONE quantity, ONE computation — it reuses computeCoM/strutTipMeters).
import { suggestCargoArm, countEmptyDockedDaughters, heldCargoFoulsCorridorAt } from '../systems/CoMCalculator.js';
import { tripRefuses, tripLeashRefuses } from '../systems/TransferTrip.js';
import { heldBagNeckInto, heldBagRadiusScene, DAUGHTER_STAND_M } from './heldBagShape.js';
import { pickScoopMembers, scoopLine } from './scoopRule.js';
// Nets step 3 slice 5 (lane 5b): a pending BIG piece (counted at the catch, pays when disposed of) is never let go by K, never auto-cut,
// and says its own collar line. Looked up by id: a net may hold a snapshot of the field's body.
import { bigPieces, pieceName } from '../systems/BigPieces.js';
import * as THREE from 'three';

const _heldNeck = { x: 0, y: 0, z: 0 };   // net-cinch: scratch for a daughter's held-net neck (scene units)

const CN = Constants.CAPTURE_NET;
const STATES = CN.STATES;
const MODES = CN.MODES;
// Cargo hand-off tuning (cargo-continuity S7). Same aliasing discipline as CN:
// a live object reference, so a test that retunes a key is seen immediately.
const CT = CN.CARGO_TRANSFER || {};
const FEATURE_FLAGS = Constants.FEATURE_FLAGS;
// no-melt (owner 2026-10-18): the plain refusal for a new catch while the nose holds one that has nowhere to go.
// trip-melt G8 (owner 2026-10-19): nothing is unloaded by a station any more; a catch that fits a tip goes to a furnace
// on the trip to the next field.
const NOSE_FULL_LINE = 'Nose is full: this catch has nowhere to go yet. '
  + 'It stays at the collar and goes to a furnace on the trip to the next field if it fits one. Press K to let it go.';
// R1 (fix round 1): the same refusal while a cut is paused at the nose for want of an empty daughter.
// ("Press K to let it go." is the sentence the touch wording knows (GestureHints GLASS_LINES / chipPhrase): any other tail would
// name a key on glass.)
const NOSE_FULL_CUT_LINE = 'Nose is full: the cut catch has pieces that still need an empty daughter. Press K to let it go.';

// Module-level scratch objects for the mother reel/berth per-frame math —
// the reel/berth path must not allocate per frame (plan §13: use the Into
// accessors and scratch vectors).
const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _v3c = new THREE.Vector3();
const _v3d = new THREE.Vector3();
const _v3e = new THREE.Vector3();
const _v3g = new THREE.Vector3();
/** Berth anchor in ship-local metres, refilled per _corridorClear call. */
const _anchorLocal = { x: 0, y: 0, z: 0 };

/**
 * The ONE berth anchor (S13(e)) in ship-local metres: the collar object, ON the axis at (0, 0, BERTH_COLLAR_Z_M), read from the anchor
 * Object3D when the real ship is present, falling back to the launcher muzzle local (headless mocks without the collar anchor) and then to
 * the documented constant. `_corridorClear` and ArmManager's holder duck (net-duck) read it here, so they cannot disagree.
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
// Cargo hand-off scratch (cargo-continuity S7 — the transfer beat runs every
// frame of the flight, so it allocates nothing either).
const _v3f = new THREE.Vector3();
// Cut-at-nose scratch (CUT_AT_NOSE): the waiting-piece pin runs every COLLARED
// frame — same no-allocation rule.
const _v3cut = new THREE.Vector3();
// Tug scratch (Phase B §9) — catch/ship velocity sampling at CAPTURED.
const _tugScratchPos = { x: 0, y: 0, z: 0 };
const _tugScratchVel = { x: 0, y: 0, z: 0 };
// Held-catch attitude + ship pose scratch (c1-catch-pose) — the cargo flight and
// the rack pin run every frame, so they allocate nothing.
const _qCatchPose = new THREE.Quaternion();
const _qShip = new THREE.Quaternion();
const _qShipInv = new THREE.Quaternion();
const _vShipPos = new THREE.Vector3();

// ── Held-catch attitude in the SHIP's frame (c1-catch-pose, D3/D4) ────────
// A catch held rigidly by the ship (collar, cargo flight, a docked daughter's
// rack) turns WITH the ship — DECISIONS Ruling 0, physically real. The nose hold
// does it through `NetProjectile._qLocal`; the cargo flight now does too, and on
// arrival hands the ship-relative attitude to the daughter's rack as
// `d._qLocalShip` (a THREE.Quaternion = shipQuat⁻¹ × catchQuat). The rack pin
// (`ArmUnit._pinHeldCatches`) writes shipQuat × `_qLocalShip` back into the
// catch's `tumbleAxis`/`tumbleAngle`, which `DebrisField.pinCapturedDebris`
// reads for the drawn instance (a debris has no quaternion field). Research
// 2026-10 capture-repros, Repro B. Every helper is a quiet no-op when the catch
// has no `tumbleAxis` or the quaternion is absent (test stubs, early boot).

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
 * A lasso / net catch is a shallow SNAPSHOT of the field's debris (measured in
 * the browser, c1-catch-pose D7: `net.targetDebris !== debrisMap.get(id)`, it
 * shares only the `tumbleAxis` Vector3 and owns its own `tumbleAngle` number).
 * `pinCapturedDebris` reads `canonical.tumbleAxis` + `canonical.tumbleAngle`
 * for the drawn instance, so an attitude written only onto the snapshot reaches
 * the screen as (new axis, STALE angle) — the catch looks frozen in the world
 * while the ship turns. Mirror the pair onto the canonical object by id; a no-op
 * when the catch IS canonical or no field is reachable (tests, early boot).
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
 * Write a quaternion back into the catch's tumbleAxis/tumbleAngle (the same
 * decomposition `NetProjectile._applyCatchOrientation` uses) and mirror it onto
 * the drawn (canonical) object.
 * @param {object} d — debris with a tumbleAxis
 * @param {THREE.Quaternion} q
 * @param {object|null} [debrisField]
 */
export function writeCatchAttitude(d, q, debrisField = null) {
  const w = Math.max(-1, Math.min(1, q.w));
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
 * Record the catch's CURRENT attitude relative to the ship:
 * `d._qLocalShip = shipQuat⁻¹ × catchQuat`. Always overwrites (the caller
 * decides when a hand-off or a fresh stow is happening).
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

// ── A rack cell is a place on HER (rack-snug, 2026-10-18; Decisions 1, 4) ────
// A catch parked on a daughter's cargo rack is rigid in HER body frame from the moment its cell is assigned:
// `d._rackCell` (0|1), `d._rackLocalM` (centre, her frame, metres), `d._qLocalHer` (her⁻¹ × the catch's attitude)
// and `d._rackArm` (the daughter who owns the cell; a cargo flight assigns at its start, the stow keeps it).
// Turning the ship or swinging her strut carries the catch with her; world up plays no part. The tip bags and every
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
  d._rackBelow = null;     // rack-centre: the cell-0 piece cell 1 was placed on (ArmUnit._assignRackCellWith)
  d._rackSlide = null;     // rack-centre: a running cell-1 → cell-0 slide (ArmUnit._lowerRackCell)
  d._rackFromMotherNet = false;   // hold-catch FA1: and the mark that the mother's net put it there
  d._wingClear = null;            // hold-clear D1: its radiator-wing profile was for that cell and attitude
}

/**
 * The ship's live pose for the cargo arcs: position (scene units) into `outPos`,
 * orientation into `outQuat`. False when the player cannot supply both — the
 * caller then keeps today's frozen world-frame behaviour (never throws).
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

/** C1: base capture-tension readout (N) — one source for the three former
 *  identical `1.0 + capturedMass × 0.1` sites. HUD-facing garnish only. */
function baseCaptureTensionN(capturedMass) {
  return 1.0 + capturedMass * 0.1;
}

/**
 * Register item 81 — drop a tether-snapped runaway's stale claim at the moment
 * a mother-side capture path takes ownership. A tether snap leaves the runaway
 * re-targetable (`_captured = false`) but back-referenced by the EXPENDED
 * arm's `_severedCatch`, which re-pins it to the drifting daughter every frame
 * until TETHER_SNAP_RELEASE_DELAY_S releases it (ArmUnit._updateExpended) —
 * and would otherwise fire that release on the NEW owner's held catch. The
 * `_updateExpended` re-capture guard checks only `_capturedByArm !== this`,
 * which a DAUGHTER re-capture satisfies (pinned: test-ArmUnit-CaptureFailure)
 * but the mother/lasso paths never write `_capturedByArm`. So the capture-time
 * seams (`_enterMotherReel` / `adoptLassoCatch`) call this once ownership is
 * certain (past the entry/adoption refusal gates): the arm-side claim AND the
 * debris-side back-reference both clear — the latter so a later [K] jettison
 * can't re-pin the freed piece to the long-gone drifter (DebrisField's
 * `_pinToArm` branch passes EXPENDED in its state filter). Null-safe: a fresh
 * catch (`_capturedByArm` unset) is a byte-identical no-op.
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
 * Register item 74 — ONE fore-extent read for the collar queue, shared by both
 * consumers (the lasso pend's `getCollarQueueDepthM` and the corridor gate's
 * `_queueHoldLevelM`): how far a mother net's catch reaches fore of the berth
 * anchor, in metres — apex + seat + half, where the apex is the net's true
 * station level:
 *   - a corridor-held REELING net: its frozen `_corridorHoldLevelM` slot (the
 *     REELING guard keeps a stale hold flag from a MISSED net from counting);
 *   - a berthed/collared/transferring net: `max(base, _effectiveStandoffM)` —
 *     extended-standoff honest;
 *   - anything else (inbound, missed): the base standoff — an inbound net
 *     reserves its eventual berth footprint (conservative), byte-identical to
 *     the pre-74 base formula.
 * `atStation` is the corridor gate's queue membership (held or berthed — an
 * inbound net takes its slot when its own gate engages); the lasso pend
 * counts every member at its level. Pre-74 the pend read the base standoff
 * for every net, so a waiting lasso catch pinned INSIDE a corridor-held or
 * extended-standoff body (11.50 reported for an 18.50 far face).
 * Fills the module scratch (the reel/berth path must not allocate per frame,
 * plan §13); the returned primitives are copied by destructuring at the call
 * site, and the helper calls nothing that could re-enter it.
 * @param {object} net — a mother NetProjectile with a live targetDebris
 * @returns {{fore: number, atStation: boolean}} the shared scratch
 */
const _foreExtent74 = { fore: 0, atStation: false };
function motherNetForeExtentM(net) {
  const d = net.targetDebris;
  const half = (d.sizeMeter || 2) / 2;
  // l8-reel-collar: the berth footprint is HOME (bag mouth at the ring, catch seated on it), not the old
  // size/2 + 1.0 m standoff. `_homeApexM`/`_homeSeatM` are seeded at reel entry (null before: the old base).
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

// ═══════════════════════════════════════════════════════════════════════════
// §0b  l8-reel-collar — the catch's HOME on the collar axis
// ═══════════════════════════════════════════════════════════════════════════

const _homeScratchC = [0, 0, 0];
const _homeIgnore = ['BerthCollar', 'BerthFace', 'nose catch'];
const _homeOpts = { ignore: _homeIgnore };

// big-catch-home D2 — the corridor gate's keep-out read: the capsule's two ends (ship-local metres), the query options
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
 * The largest drawn reach (m) a catch is still seated by (home-seat): the same limit as TipCargo.MAX_BAG_R_M (a tip
 * takes a bag up to 0.75 m). Mirrored here, not imported: TipCargo imports CaptureNet (a cycle); test-HomeSeatTrueReach
 * pins the two equal.
 */
export const TIP_HOME_MAX_REACH_M = 0.75;

/**
 * What, besides a catch's radius and the collar's z, sets its home: the radiators' angle and the bags on the tips (`ArmManager.getKeepOut`
 * reads both; a bag moves with its radiator). A string that changes when either does (angle to 0.001 deg, each bag's index, radius and
 * centre to 1 mm), `''` for a ship with no radiators or a mock, and `null` while the radiators are SWINGING or ANY tip bag is turning onto
 * its boom (`tipCargo.isSwinging(i)`): a home read then is not trusted once the swing ends (`catchHomeDistM` recomputes on the first read
 * after), and a read during the swing reuses what is cached rather than paying a recompute (25-115 ms: 47-62 keep-out queries, measured
 * u22 2026-10-24) every frame the HUD polls. The daughters' strut poses are
 * left out on purpose: the nose route is flown, and certified, against the seat of the ship with its struts parked, and a strut that
 * swings during the flight must not move the seat she is flying to.
 * @param {object|null} player PlayerSatellite
 * @returns {string|null}
 */
export function homeShapeKey(player) {
  if (!player || typeof player._flowerThetaRad !== 'number') return '';
  const tgt = player._flowerTargetTheta;
  if ((typeof tgt === 'number' && Math.abs(tgt - player._flowerThetaRad) > 1e-4) || player.flowerPetalsBusy === true) return null;
  const tc = player.tipCargo;
  // a bag turning onto its boom (10 deg/s, up to ~9 s) moves every frame, so its centre would change the key every frame: 780 recomputes of
  // ~25 ms in 13 s of one swing (fix round 1 review, u22 2026-10-24). Same rule as a radiator swing: reuse the cache, recompute once it ends.
  if (tc && typeof tc.isSwinging === 'function') for (let i = 0; i < 4; i++) if (tc.isSwinging(i)) return null;
  let key = String(Math.round(player._flowerThetaRad * (180 / Math.PI) * 1000));
  if (tc && typeof tc.count === 'function' && typeof tc.spheres === 'function' && tc.count() > 0) {
    for (const sp of tc.spheres()) key += `|${sp.name}:${Math.round(sp.r * 1000)}:${Math.round(sp.c.x * 1000)},${Math.round(sp.c.y * 1000)},${Math.round(sp.c.z * 1000)}`;
  }
  return key;
}

/**
 * Home distance (metres) of a catch's CENTRE from the berth anchor (the collar plane) along the collar axis.
 * Cached on the debris per radius AND per ship shape (`_homeCache`, `homeShapeKey`): the home is read off the keep-out, which holds the
 * radiators and the bags on their tips, so a cache made for another radiator angle or another set of tip bags is not read
 * (u22-nose-tipbags, 2026-10-24: a bag seated at 140°, the radiators then closed over it, and the nose seat stayed at its open-angle
 * z 1.64 m while the closed bag sat at 1.74 m: the leash snagged it; a fresh seat is z 2.20 m).
 * On the 2.30 m radiators the answer is the same at every radiator angle for r <= 1.4 m with no bag on a tip (measured
 * 2026-10-17 at every whole degree 0-180°: `REEL_HOME.ALL_ANGLE_HOME.angleFreeMaxR`), so there it is the current-pose
 * home (`catchHomeZ`) exactly as before. A bigger catch's current-pose home moves with the angle (r 4.0: 5.349 at
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
 *   is <= TIP_HOME_MAX_REACH_M (a tip takes it; home-seat, 2026-10-18), else `sizeMeter / 2` (typeless pieces: the same number).
 * @returns {number} metres from the berth anchor
 */
export function catchHomeDistM(player, armManager, d) {
  // home-seat (2026-10-18): the radius the catch is SEATED by is its drawn reach (DebrisField.trueReachM, the same
  // number the tip hand-off uses as its bag radius) when that reach fits a tip (<= TIP_HOME_MAX_REACH_M); a bigger
  // catch keeps sizeMeter / 2, because its drawn reach would run past the measured ALL_ANGLE_HOME rows. A typeless
  // piece has trueReachM = sizeMeter / 2, so its home is unchanged.
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
  // big-catch-every-angle: above angleFreeMaxR the home must also clear every OTHER radiator angle (ALL_ANGLE_HOME).
  const T = CN.REEL_HOME.ALL_ANGLE_HOME;
  let z = home.z, allAngleLiftM = null, unchecked = !!home.unchecked, blocker = home.blocker, top = home.top;
  if (ko && typeof ko.sphere === 'function' && !home.unchecked && T && r > T.angleFreeMaxR + 1e-9) {
    const R = T.radiiM, L = T.liftM, n = R.length;
    if (r > R[n - 1] + 1e-9) {
      unchecked = true; blocker = 'radius above ALL_ANGLE_HOME'; top = null;      // no measurement: keep the current-pose home, say so
    } else {
      let i = 0;
      while (i + 1 < n - 1 && r > R[i + 1]) i++;                                  // R[i] < r <= R[i + 1] (i + 1 <= n - 1)
      const t = Math.min(1, Math.max(0, (r - R[i]) / (R[i + 1] - R[i])));
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

// ═══════════════════════════════════════════════════════════════════════════
// §1  Pure Functions — Cling Probability + Frag Risk
// ═══════════════════════════════════════════════════════════════════════════

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
  // Wave-4 QA #3 (CAPTURE_NET.md §10 concern 3): the factor stack is split into
  // a lock-stable phase and a live phase so the pre-fire HUD path can cache the
  // former at target-lock. This fresh path recomputes BOTH phases every call —
  // it is the composition of the two, so cached and fresh output are identical
  // by construction (same functions, same multiplication order).
  const lock = computeClingLockFactors(params, _clingLockScratch);
  return finishClingProbability(lock, {
    range,
    spinFraction,
    fTumble: computeTumbleModifier(targetTumbleRate),
  });
}

/** Module scratch for the fresh (uncached) path — reused per call, never
 *  allocated per frame (same discipline as the _v3a/_q0 scratch above). */
const _clingLockScratch = {
  fVelocity: 1, fContact: 1, fRoughness: 1, fTension: 1,
  prefix: 0, sureShotVelOK: false,
};

/**
 * Wave-4 QA #3 — lock-stable phase of the §3.3 factor stack. Everything here
 * depends only on inputs that hold still while a target stays locked (pBase
 * from the capture mode, launch/optimal speed, contact fraction, surface
 * roughness, tether tension nominal). `prefix` is the left-associated product
 * pBase × f_velocity × f_contact × f_roughness — exactly the first four steps
 * of the original chain, so finishing it with the live factors reproduces the
 * un-split arithmetic bit for bit.
 * Mutates and returns `out` (caller-owned slot; no per-frame allocation —
 * the computeLeadAim `out` idiom).
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
  out.fVelocity  = Math.max(0.3, Math.min(1.0, 1.0 - Math.abs(vRel - vOptimal) / vRange));
  out.fContact   = Math.min(contactFraction, 1.0);
  // 2026-06-11 tuning: floor the roughness multiplier — smooth surfaces are
  // harder to wrap, but the raw material scale (solar cell 0.2, aluminum 0.4)
  // multiplied a perfect shot down to "feels broken" odds.
  out.fRoughness = Math.max(CN.ROUGHNESS_FLOOR ?? 0, roughness);
  out.fTension   = Math.max(0.6, Math.min(1.0, tensionFraction));
  out.prefix     = pBase * out.fVelocity * out.fContact * out.fRoughness;
  // Sure-shot's velocity gate is lock-stable too (pre-fire always evaluates it
  // at vRel === vOptimal === launch speed ⇒ 1.0).
  out.sureShotVelOK = out.fVelocity >= 0.99;
  return out;
}

/**
 * Wave-4 QA #3 — live phase of the §3.3 factor stack: the genuinely per-frame
 * factors (f_spin from the projected arrival spin, f_distance from range) and
 * the slowly-varying tumble factor, applied to the cached lock-stable prefix
 * IN THE ORIGINAL ORDER:
 *   raw = (((prefix × f_spin) × f_tension) × f_distance) × f_tumble
 * which is the exact left-to-right association of the un-split §3.3 chain —
 * the cache-equality contract is arithmetic, not approximate.
 * @param {object} lock — result of computeClingLockFactors
 * @param {object} live — {range, spinFraction, fTumble (computeTumbleModifier output)}
 * @returns {number} P_cling ∈ [0, 1]
 */
export function finishClingProbability(lock, live) {
  const { range = 50, spinFraction = 1.0, fTumble = 1.0 } = live;
  const fSpin = Math.max(0.5, Math.min(1.2, spinFraction));
  // Distance modifier: f_distance = clamp(1.1 - 0.003 × range, 0.85, 1.1)
  const fDistance = Math.max(0.85, Math.min(1.1, 1.1 - 0.003 * range));
  const raw = lock.prefix * fSpin * lock.fTension * fDistance * fTumble;
  let p = Math.max(0, Math.min(1, raw)); // clamp to valid probability

  // 2026-06-11 tuning: SURE-SHOT floor. A well-executed shot — close range,
  // target de-tumbled to in-spec (or tumble untracked), nominal launch speed,
  // fresh net spin — succeeds reliably. This is the payoff the game teaches
  // ("close the distance, de-spin [L]"); distant/tumbling/sloppy shots keep
  // the full physics stack, so aim and setup still matter.
  const sureShot = range <= (CN.CLOSE_RANGE ?? 30)
    && fTumble >= 1.0
    && lock.sureShotVelOK
    && spinFraction >= 0.8;
  if (sureShot) {
    p = Math.max(p, Math.min(1, CN.SURE_SHOT_MIN_CLING ?? 0));
  }
  return p;
}

/**
 * CP-2 net-cling tumble modifier. 1.0 when tumble is unknown or at/below the
 * in-spec spin; ramps linearly down to NET_TUMBLE_PENALTY.FLOOR above it.
 * @param {number|null} tumbleRateRad — target tumble in rad/s (null ⇒ no penalty)
 * @returns {number} f_tumble ∈ [FLOOR, 1.0]
 */
export function computeTumbleModifier(tumbleRateRad) {
  if (tumbleRateRad == null) return 1.0;
  const P = Constants.NET_TUMBLE_PENALTY || { IN_SPEC_DEG: 10, PER_DEG: 0.012, FLOOR: 0.4 };
  const tumbleDeg = Math.abs(tumbleRateRad) * (180 / Math.PI);
  if (tumbleDeg <= P.IN_SPEC_DEG) return 1.0;
  return Math.max(P.FLOOR, 1.0 - (tumbleDeg - P.IN_SPEC_DEG) * P.PER_DEG);
}

/**
 * Compute the distance modifier alone (for HUD pre-fire display).
 * @param {number} range — metres
 * @returns {number} f_distance ∈ [0.85, 1.1]
 */
export function computeDistanceModifier(range) {
  return Math.max(0.85, Math.min(1.1, 1.1 - 0.003 * range));
}

/**
 * UX-11 #1: effective catch radius with close-range forgiveness.
 * Inside CLOSE_RANGE the net mouth wraps slightly beyond its disc, so the
 * intersection test widens by CATCH_RADIUS_FORGIVENESS. Outside CLOSE_RANGE
 * the geometric radius applies unchanged — aim still matters at distance.
 * @param {number} mouthRadius — net mouth radius (metres)
 * @param {number} range — distance travelled / range to target (metres)
 * @returns {number} effective radius (metres)
 */
export function effectiveCatchRadius(mouthRadius, range) {
  const forgive = (range < CN.CLOSE_RANGE) ? (CN.CATCH_RADIUS_FORGIVENESS || 1.0) : 1.0;
  return mouthRadius * forgive;
}

/**
 * §11.2 mouth-collapse floor: centripetal tension per rim weight at a given
 * spin — F/wt = m·ω²·r with ω = 2π·spinHz and r = DIAMETER/2. The SAME
 * quantity the §11.1 audit table and the test-Crossbow-Constants derivation
 * guard compute at the settled SPIN_HZ; here it runs LIVE on the decaying
 * in-flight spinRate (the same decayed spin f_spin already reads) so
 * NetProjectile can check the mouth-open condition
 * (F/wt ≥ CN.MOUTH_TENSION_FLOOR_N) per flight frame. Pure + Node-safe.
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
 * Local cone radius at an axial depth ahead of the apex.
 * The bag is a cone: apex at local origin, mouth ring at local z = −coneHeight
 * (js/ui/NetMeshKit.js:364-365). Depth `a` metres ahead of the apex therefore
 * sees a local radius mouthRadius × (a / coneHeight). Returns 0 outside
 * [0, coneHeight] — a target behind the apex or past the mouth plane sees no
 * cone at all. Pure + Node-safe.
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
 * Cone containment test for a target expressed in the kit's local frame.
 * localZ is NEGATIVE ahead of the apex (the mouth sits at local z = −coneHeight);
 * localR is the lateral off-axis distance (hypot(localX, localY)). Inclusive on
 * the wall: a target exactly at r == coneRadiusAtDepth(a) counts as inside.
 * Pure + Node-safe.
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
 * Largest lateral offset that still yields containment at the brake instant.
 * BRAKE fires when the apex-to-target distance equals the catch radius R, so
 * a² + r² = R² at that instant; containment requires r ≤ k·a with
 * k = mouthRadius / coneHeight. Solving gives R·mouthRadius / hypot(mouthRadius,
 * coneHeight). Valid only while R ≤ coneHeight — if the brake sphere exceeds the
 * bag depth the net brakes with the target still ahead of the mouth plane and
 * containment at the brake instant is geometrically impossible; returns NaN then.
 * Pure + Node-safe.
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
 * UX-11 #1: lead-aim direction + off-axis angle for the pre-fire readout.
 * Mirrors the lead computation in ArmUnit._updateNettingFSM: aim where the
 * target will be when the net arrives (targetPos + relVel × dist/launchSpeed).
 * All inputs share one unit system (scene units OR metres — consistent).
 *
 * @param {{x,y,z}} armPos — launcher position
 * @param {{x,y,z}} targetPos — target position now
 * @param {{x,y,z}|null} relVel — target velocity relative to launcher (units/s)
 * @param {number} launchSpeed — net speed in the same length units per second
 * @param {{dir:{x,y,z}, offAxisDeg:number}} [out] — optional preallocated result to
 *   write into (avoids per-frame allocation on hot aim paths). When omitted a
 *   fresh object is returned.
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

  // Angle between lead dir and direct bearing
  const dot = Math.max(-1, Math.min(1,
    (dir.x * bx + dir.y * by + dir.z * bz) / bLen));
  const offAxisDeg = Math.acos(dot) * (180 / Math.PI);
  if (out) { out.offAxisDeg = offAxisDeg; return out; }
  return { dir, offAxisDeg };
}

/**
 * Item 4 (2026-06-12): pre-fire net-fit assessment — the SINGLE source for
 * the reticle width/mass advisory, the TargetPanel capture-fit badge, and the
 * ToolRecommender width fork. Pure + Node-safe.
 *
 * Precedence: width (deterministic post-catch failure) > mass (refused at
 * deploy / strain risk) > tumble (recoverable — de-spin first).
 *
 * Phase 2 (capture-feedback overhaul): with ASPECT_CAPTURE on and aspect data
 * present, the width fork becomes orientation-aware:
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
        // Fits end-on only. With a live approach direction report the CURRENT
        // presentation; statically report the aspect opportunity.
        if (approachDir) {
          // The live presentation routes through the ONE mouth-fit predicate
          // (register item 21a); the widthM tier above stays a static test.
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
  if (mass > cap) return { fit: 'TOO_HEAVY', label: 'TOO HEAVY' };
  const P = Constants.NET_TUMBLE_PENALTY || { IN_SPEC_DEG: 10 };
  const tumbleDeg = (target.tumbleRate != null)
    ? Math.abs(target.tumbleRate) * (180 / Math.PI) : 0;
  if (tumbleDeg > (P.IN_SPEC_DEG ?? 10)) return { fit: 'DESPIN_FIRST', label: 'DE-SPIN FIRST' };
  return { fit: 'OK', label: 'NET \u2713' };
}

/**
 * Register item 17 (2026-08-19): the DRAWN worst-axis span of a target's
 * mesh in metres — the rendered truth the verdict deliberately never
 * consults (item 7b, owner-declined mesh-truthful verdicts: the logical
 * lengthM/widthM govern, the 0.66×–4.62× per-type stylization is accepted).
 * Exists for ONE consumer class: HUD advisories that qualify an OK verdict
 * (DockingReticle's advisory line, TargetPanel's fit badges). MUST NOT feed
 * a verdict — fitsMouth and the oversize_aspect bounces stay logical;
 * routing this into a refusal is exactly the declined option.
 *
 * span = 2 × baseRenderScale × boundingRadius ÷ (Constants.SCENE_SCALE/1000)
 * — the free-debris draw scale (DebrisField owns that SSOT; the same
 * derivation as its METRE_SCENE at DebrisField.js:61, no second hard-coded
 * 1e-5) × the mesh bounding-SPHERE radius (DebrisWireframe owns it; primed
 * via getGeometry first, the scaleForRenderRadiusM pattern, so the
 * uncached-returns-1 trap cannot fire), scene units → metres. Measured
 * headless (tmp/i17-span.mjs): defunctSat 5 → 18.22 m, rocketBody 5 →
 * 10.22 m — the worst-axis form deliberately exceeds the review's box-axis
 * spans (18.1 / 7.8 m); a box-axis rule would slip rocketBody 5 (7.8 < 8)
 * past the chip although the bag pierces it by 2.210 m.
 *
 * Lives here, not in DebrisField: it COMPOSES the two homes and both are
 * already imported — a DebrisField home would add a DebrisField→
 * DebrisWireframe import edge.
 *
 * Graceful + Node-safe: null target / no type / no size ⇒ 0 (no span claim);
 * getGeometry builds headless (test-Cubesat proves it).
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
 * Register item 17: the ONE overflow-advisory rule — does the DRAWN span
 * exceed this net class's mouth? The verdict-is-OK half stays with the
 * caller's own signal (assessNetFit at the reticle/fit segs, green NET odds
 * at the badges); this predicates only the rendered-overflow half so the
 * HUD surfaces cannot drift on the rule (the item-21 lesson: one home, not
 * sites that merely agree). Strictly-greater, and a mouthless class never
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

// ═══════════════════════════════════════════════════════════════════════════
// §1b  Orientation-based capture geometry (Phase 2 — ASPECT_CAPTURE)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Width an elongated body presents to a net approaching at angle θ from its
 * long axis: end-on (θ=0) → widthM; broadside (θ=90°) → lengthM.
 * Pure + Node-safe.
 *
 * @param {number} lengthM — long-axis extent (m)
 * @param {number} widthM — cross-section width (m)
 * @param {number} cosTheta — cos of the angle between long axis and approach dir
 * @returns {number} presented width (m)
 */
export function presentedWidth(lengthM, widthM, cosTheta) {
  const c = Math.max(-1, Math.min(1, cosTheta || 0));
  const sinTheta = Math.sqrt(Math.max(0, 1 - c * c));
  return Math.max(widthM || 0, (lengthM || 0) * sinTheta);
}

/**
 * World-space long axis of a debris: the type's LOCAL long axis rotated by the
 * live tumble orientation quat(tumbleAxis, tumbleAngle) — exactly the rotation
 * DebrisField applies to the mesh (setFromAxisAngle). Rodrigues form, no THREE.
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
 * Live presented width of a debris for a given approach direction.
 * Falls back to the scalar sizeMeter when aspect data is missing (graceful —
 * fragments / legacy saves / catalog rows pre-derivation).
 *
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
 * The ONE mouth-fit verdict (register item 21a): does the target's presented
 * width clear this net class's mouth? Pre-item-21 the comparison was written
 * at FOUR sites that merely agreed — `assessNetFit`'s live ASPECT tier, the
 * ToolOdds WIDE blocker, and both oversize_aspect bounces (contact + reel
 * entry) — while the one-quantity doctrine governed only the geometry
 * (`presentedWidthForApproach`). Now the verdict has one home too.
 *
 * The refusal is STRICTLY-greater and a mouthless class never refuses, so a
 * NaN presented width never refuses — byte-matching every pre-item-21 site.
 *
 * `assessNetFit`'s widthM tier (TOO_WIDE — the static end-on cross-section)
 * deliberately stays inline: it tests a DIFFERENT quantity (widthM, not the
 * live presentation), and routing it through here would compute worldLongAxis
 * only to throw it away.
 *
 * @param {object|null} target
 * @param {{DIAMETER?:number}|null} netClass
 * @param {{x:number,y:number,z:number}|null} [approachDir] — launcher→target
 *   (any length); ignored when `presentedM` is given
 * @param {number} [presentedM] — a PRECOMPUTED presented width: the contact-
 *   time store (reel entry re-judges the SAME presentation, not the live one
 *   the drifted tumble would now give) or the odds caller's override. Omit to
 *   compute the live presentation.
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
 * The ONE strain-band ramp (register item 88): where in the overload band does
 * this payload sit? Pre-item-88 the interpolation —
 * `strain = payloadMass / rated; safe = NET_STRAIN_SAFE_FRACTION ?? 0.8;
 * t = min(1, (strain − safe) / max(1e-6, 1 − safe))` — was written at FOUR
 * sites that merely agreed: the daughter reel-start slip
 * (`ArmUnit._checkNetIntegrityOnReel`), the boost rip (`ArmUnit._updateReeling`),
 * the mother reel entry (`_enterMotherReel`), and the declared odds mirror
 * (`ToolOdds.computeStrainFailProbability`). The two ArmUnit sites differ in
 * CAP semantics (one-shot `pMax × t` vs per-second `pPerS × t × dt`), so what
 * is shared is the BAND RAMP, not the roll: the ramp lives here (beside
 * `fitsMouth` — homing it in ToolOdds would force a CaptureNet→ToolOdds
 * 2-cycle; this adds zero import edges) and each site keeps its own cap.
 *
 * Returns 0 for a non-positive mass/rating and at/below the safe fraction —
 * byte-matching every pre-item-88 site, whose guards made the roll unreachable
 * there (and the mirror return 0).
 *
 * @param {number} payloadMass — kg
 * @param {number} ratedMass   — the net's rated mass (kg; MAX_CAPTURE_MASS)
 * @returns {number} band position t ∈ [0, 1]: 0 at/below the safe fraction,
 *   1 at/above 100 % rated
 */
export function strainBandT(payloadMass, ratedMass) {
  if (!(payloadMass > 0) || !(ratedMass > 0)) return 0;
  const strain = payloadMass / ratedMass;
  const safe = Constants.NET_STRAIN_SAFE_FRACTION ?? 0.8;
  if (strain <= safe) return 0;
  return Math.min(1, (strain - safe) / Math.max(1e-6, 1 - safe));
}

/**
 * Compute fragmentation risk based on target fragility and impact KE.
 * Per CAPTURE_NET.md §5.1–§5.4.
 *
 * @param {object} params
 * @param {number} params.netMass       — net mass in kg
 * @param {number} params.vRel          — relative velocity at contact (m/s)
 * @param {number} params.targetFragility — base frag risk for debris class (§5.4, 0–1)
 * @param {number} params.range         — distance (m)
 * @returns {number} frag risk ∈ [0, 1]
 */
export function computeFragRisk(params) {
  const { netMass, vRel, targetFragility = 0.05, range = 50 } = params;
  // Impact kinetic energy: ΔKE = ½ × m_net × v_rel²
  const ke = 0.5 * netMass * vRel * vRel;
  // Reference KE: Medium Net at 10 m/s = 34 J
  const keScale = Math.min(ke / 34, 2.0);
  let risk = targetFragility * keScale;

  // Distance modifier (§3.3 QA Q-4)
  if (range < CN.CLOSE_RANGE) {
    risk *= 0.5;  // halved at close range
  } else if (range > CN.BASELINE_RANGE_MAX) {
    risk *= 1.5;  // increased at edge of envelope
  }

  return Math.max(0, Math.min(1, risk));
}

/**
 * Phase 3b: base fragility for computeFragRisk. Brittleness (per-debris,
 * surfaced by the close-range survey) drives the FRAG chip when no explicit
 * fragility is set — "brittleness drives fragmentation risk".
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
 * Phase 3b (capture-feedback overhaul): fragmentation severity tier.
 * Severity = brittleness × KE factor (vRel excess over the optimal wrap
 * speed). Nominal-speed shots on tough targets crack at worst; a hot approach
 * on a brittle body shatters. Pure + deterministic given countRoll.
 *
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
  const severity = Math.max(0, Math.min(1, brittleness)) * (keFactor / 2);
  const tier = severity >= (FS.SHATTER_SEVERITY ?? 0.75) ? 'shatter'
    : severity >= (FS.BREAKUP_SEVERITY ?? 0.45) ? 'breakup'
    : 'crack';
  const band = tier === 'shatter' ? (FS.SHATTER_FRAGS || [8, 12])
    : tier === 'breakup' ? (FS.BREAKUP_FRAGS || [3, 6])
    : (FS.CRACK_FRAGS || [1, 2]);
  const r = Math.max(0, Math.min(1, countRoll));
  const fragmentCount = band[0] + Math.round(r * (band[1] - band[0]));
  return { tier, severity, fragmentCount, destroyTarget: tier !== 'crack' };
}

/**
 * UX-11 #1: map a NET_CATCH_MISS reason to an actionable player-facing line.
 * Returns null only for 'forced' (scripted/test resolves stay silent); unknown
 * reasons fall through to a generic re-line-the-shot message.
 * @param {string} reason — 'timeout'|'tether_limit'|'cling_failed'|'oversize_aspect'|'fragmented'|'mouth_collapsed'|'forced'|…
 * @returns {string|null}
 */
export function missReasonToText(reason) {
  switch (reason) {
    case 'timeout':
    case 'tether_limit':
      return 'Net overshot. Line up the reticle and re-fire. Net reeling back; inventory restored.';
    case 'out_of_range':
      // net-range: the piece drifted past the net's reach before contact.
      return 'Net missed: the piece drifted out of range. Close in and re-fire. Net reeling back.';
    case 'cling_failed':
      return 'Net grazed it. Wrap didn\'t hold. Close the distance or de-spin the target (hold L), then re-fire.';
    case 'oversize_aspect':
      // Phase 2: deterministic broadside bounce — teach the orientation fix.
      return 'Net bounced off broadside. Too wide this way. De-spin, then come around end-on so the net swallows it lengthwise.';
    case 'fragmented':
      // Phase 3b: the impact broke the target up — teach the gentle approach.
      return 'Impact broke the target apart. Fragments are now tracked. Approach slower on brittle debris (CINCH wraps gentler).';
    case 'mouth_collapsed':
      // §11.2 mouth-collapse floor: rim spin decayed below the tension floor
      // mid-flight — DISTINCT from the plain-miss default so the player learns
      // the shot was doomed by range, not by aim.
      return 'Net mouth collapsed mid-flight — shot too long. Rim spin bled below the tension floor. Close the distance, then re-fire.';
    case 'forced':
      return null;   // scripted/test resolves stay silent
    default:
      // Phase 2: generic line instead of silent null — a miss should never
      // leave the player guessing.
      return 'Net missed. Re-line the shot and fire again. Net reeling back.';
  }
}

/**
 * Cargo-continuity S5 (owner item 7): map a NET_CATCH_MISS reason to its staged
 * failure beat, or null when the miss gets no staging. ONE home — the logic
 * side (CaptureNetSystem's deferred auto-reel) and the visual side
 * (CaptureNetVisual's beat) must never diverge on which failures are staged.
 *   'bounce' — oversize_aspect: the bag slaps the broadside face and recoils,
 *              the mouth never closes (drape up, then down).
 *   'slip'   — strain_slip: the welded cinch releases and the catch slides out
 *              of the mouth (cinchFrac back toward 0).
 * cling_failed gets no staging (the wrap never closed — there is nothing to
 * release), fragmented is owned by the fragmentation machinery, and
 * timeout/tether_limit/target_lost have no target in frame. mouth_collapsed
 * (§11.2) is deliberately unstaged THIS wave — the windsock-flutter beat is a
 * later visual task keyed off NetProjectile.mouthCollapsed / the
 * NET_MOUTH_COLLAPSED event, not off this mapper.
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
 * Auto-recommend capture mode based on target data.
 * Per CAPTURE_NET.md §3.6.
 *
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


// ═══════════════════════════════════════════════════════════════════════════
// §2  NetProjectile — Per-Net State Machine
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Represents a single net in flight through its full capture cycle.
 *
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

    /** @type {function(THREE.Vector3):THREE.Vector3|null} Mother-pod launcher
     *  anchor provider — writes the pod muzzle's CURRENT world position (scene
     *  units) into the supplied scratch vector. This is the mother-path
     *  replacement for `_sourceArm.position`: the ship translates at ~0.7 scene
     *  units/s (70 km/s apparent), so any anchor read once at launch is ~45 km
     *  stale by the end of the first 0.65 s. The provider is polled every frame
     *  the net needs the launcher frame. Null on the headless test path. */
    this._anchorProvider = config.anchorProvider || null;
    /** @type {THREE.Vector3|null} Scratch for the anchor provider (allocated
     *  lazily on first use — headless tests never touch it). */
    this._anchorScratch  = null;

    /** @type {boolean} Daughter capture being hauled by the ArmUnit — hold the
     *  net's own reel (bag stays cinched on the debris) until the arm delivers. */
    this._heldByArm     = false;
    /** @type {{x:number,y:number,z:number}|null} u20-nets: the net's centre at contact minus the target's centre, metres
     *  (null until contact: the scoop then centres its mouth on the target). */
    this._mouthOffsetM  = null;
    /** @type {{x:number,y:number,z:number}|null} u22-scoop: the net's launch direction at contact (the drawn mouth's axis; null until contact: the scoop then uses a ball). */
    this._mouthAxis     = null;
    /** @type {boolean} u20-nets: this net already took a scoop (its targetDebris is the bag). */
    this._scooped       = false;
    /** @type {number} Register item 28: kg the held catch carried when the arm
     *  LOST it (integrity slip / boost rip / tether-snap drift-end / reset drop
     *  / severed-claim transfer) instead of delivering it to the furnace. 0 on
     *  every other path — a delivered catch keeps its mass in capturedMass. */
    this._releasedMassKg = 0;

    // ── Runtime state ──
    this.state         = STATES.LAUNCHING;
    this.stateTimer    = 0;
    this.flightTime    = 0;
    this.distanceTraveled = 0;
    this.position      = { ...this.launchPosition };
    this.speed         = this.netClass.LAUNCH_SPEED;
    this.spinRate      = 0;           // current Hz
    /** @type {number} §11.2: live per-rim-weight tension (N) from the decayed
     *  in-flight spin — rimTensionPerWeightN(netClass, spinRate). Updated each
     *  FLIGHT tick (0 before flight: the bag is still folded/blossoming, so a
     *  mouth-tension claim would be meaningless). Telemetry runs for EVERY
     *  class; since the §11.2 LARGE resolution (2026-08-27) the collapse
     *  latch does too — no class is skipped. */
    this.rimTensionN   = 0;
    /** @type {boolean} §11.2 mouth-collapse latch: true once rimTensionN fell
     *  below CN.MOUTH_TENSION_FLOOR_N during FLIGHT (one-way — in-flight decay
     *  is monotonic, nothing re-spins a net mid-flight). While true, contact
     *  resolves as a 'mouth_collapsed' MISS instead of a wrap. Queryable state
     *  for HUD/visuals; NET_MOUTH_COLLAPSED fires once at the latch. */
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
    this._presentedWidthM  = null;   // Phase 2: presented width at contact (m)

    // Flag for CaptureNetSystem to detect state changes from forceResolve()
    this._resultProcessed  = false;

    // ── Mother berth (mother-net-reel plan §8) — podIndex ≥ 0 && armIndex < 0 ──
    /** @type {object|null} Injected context { player, debrisField } — set by
     *  CaptureNetSystem.fireMotherNet from init(deps). Backs the ship-relative
     *  reel pin and the pinCapturedDebris API. */
    this._ctx            = null;
    /** @type {number|null} Ship-relative reel: remaining distance muzzle→bag
     *  APEX (the tether end the winch reels — the catch rides _catchSeatM
     *  metres deeper) in METRES. Seeded at REELING entry from the debris's
     *  live _scenePosition minus the seat depth, then monotonically eased to
     *  the berth standoff. Single source for reelProgress on the mother path. */
    this._remainingM     = null;
    /** @type {number|null} The seeded _remainingM at REELING entry — the
     *  reelProgress denominator (review fix: do NOT derive from tetherPaidOut,
     *  which disagrees with the live seed after contact→reel drift). */
    this._reelSeedM      = null;
    /** @type {number} Net-domain seconds since reel entry, accumulated in the
     *  reel/berth ticks — the ramp key for the readability floor's engagement
     *  (whale-in-cone item 15: the floor eases in over
     *  MOTHER_CATCH_MIN_RENDER_RAMP_S instead of popping on the first reel
     *  frame). Seeded 0 at _enterMotherReel, NEVER reset while held — keying
     *  on stateTimer would re-ramp at BERTHED entry (stateTimer resets on
     *  every _transitionTo), a second pop at the nose. */
    this._floorRampT     = 0;
    /** @type {number|null} Depth (metres) the catch rides INSIDE the bag past
     *  the apex, along the frozen bag axis (launchDirection). Seeded at
     *  REELING entry from the live capture geometry — the depth the cinch
     *  left the catch at (aM ≈ 4.5 m on a LARGE net). The reel/berth pin
     *  writes apex + launchDirection × _catchSeatM so the catch stays wrapped
     *  in the drawn bag (whale-in-cone follow-up 2: _updateMotherReel /
     *  updateBerthHold used to pin net.position and the debris to the SAME
     *  point — the catch rode the bag apex unwrapped, the metres gate's
     *  COLOCATION-DEFECT). */
    this._catchSeatM     = null;
    /** @type {THREE.Vector3|null} Lateral offset (scene units), decayed to 0. */
    this._lateral        = null;
    /** @type {THREE.Vector3|null} Lagged ship-forward (scene units) — a raw
     *  live fwd would whip a 5 t catch across the sky on a mid-reel slew. */
    this._fwdLagged      = null;
    /** @type {THREE.Quaternion|null} Catch attitude in the SHIP frame, captured
     *  at berth entry: qLocal = shipQuat⁻¹ × qCatch. Every frame the berth hold
     *  writes shipQuat × qLocal back into tumbleAxis/tumbleAngle so the catch
     *  rotates rigidly WITH the ship (plan §1.2 — otherwise it visibly swivels
     *  inside the net on every slew). */
    this._qLocal         = null;
    /** @type {number} BERTH_SECURE_S countdown once BERTHED; ≤ 0 → processed. */
    this._berthTimer     = -1;
    /** @type {boolean} True once CATCH_PROCESSED has been emitted for this net. */
    this._berthProcessed = false;
    /** @type {number|null} Deterministic strain-roll override for tests. */
    this._strainRollOverride = null;
    /** @type {number|null} Deterministic cling-roll override for tests / the
     *  shot harness (`__netScenario`). 0 ⇒ guaranteed catch; read at the
     *  `_clingRoll <= _clingProbability` compare in `_resolveCatch`. */
    this._clingRollOverride = null;
    /** @type {boolean} Set when the mother reel has no berth context (headless
     *  test path — no player/debrisField): the reel falls through to the
     *  daughter-style reel-back so the net still stows/prunes instead of
     *  looping MISSED→REELING on the re-armed auto-reel. */
    this._motherReelFallback = false;
    /** @type {'bounce'|'slip'|null} Cargo-continuity S5: the staged failure
     *  beat this net's miss earned (missFailureKind). While MISSED with a
     *  non-null kind, the system's auto-reel holds for FAILURE_STAGING_S so
     *  the beat plays at the contact point before the empty reel-back. */
    this._failureKind = null;
    // ── Reel corridor clearance (mother-net-reel plan §10 Phase C-lite) ──
    /** @type {boolean} True while the reel is holding at CORRIDOR_HOLD_M
     *  waiting for the recovery corridor to clear. */
    this._corridorHold = false;
    /** @type {number} Seconds spent in the corridor hold; at CORRIDOR_TIMEOUT_S
     *  the reel berths at CORRIDOR_EXTENDED_STANDOFF_M rather than clip through. */
    this._corridorTimer = 0;
    /** @type {boolean} True once the corridor gate has timed out — latches the
     *  gate OFF for the rest of the reel so it cannot re-arm against the same
     *  still-blocked corridor (the berth completes at the held range). */
    this._corridorTimedOut = false;
    /** @type {number} The _remainingM at corridor-hold engagement — the hold
     *  freezes the approach HERE (never pushes it back out). Register item 73:
     *  EXCEPT the queue level — the latch takes max(engagement range, queue
     *  level) and the hold glides OUT to it at reel speed (see the ease in
     *  _updateMotherReel). */
    this._corridorHoldLevelM = 0;
    /** @type {boolean} Register item 73 — true when the corridor-hold latch
     *  was queue-raised past the engagement range (the drain-race): the hold
     *  glides OUT to the latch, and a timeout mid-glide completes the glide
     *  to the raised standoff (never an outward pop). False with an empty
     *  queue ⇒ the single-catch case is byte-identical. */
    this._corridorGlide = false;
    /** @type {boolean} True once the corridor gate has emitted its Houston line
     *  (once per net — a corridor that clears and re-blocks does not re-announce). */
    this._corridorAnnounced = false;
    /** @type {number|null} The berth standoff actually in force — normally
     *  sizeMeter/2 + BERTH_CLEARANCE_M, raised to CORRIDOR_EXTENDED_STANDOFF_M
     *  after a corridor timeout. */
    this._effectiveStandoffM = null;
    /** @type {boolean} Phase B §9: the line-taut tug fires exactly once, at
     *  the CAPTURED transition (mother path only). */
    this._tugApplied = false;
    /** @type {THREE.Vector3|null} §9.8 windowed tug delivery: the feel vector
     *  (scene units/s) fed into _rcsVelocity over NET_TUG_WINDOW_S by
     *  CaptureNetSystem.update. Null when no window is active. Dies with the
     *  net, so a jettison mid-window correctly abandons the remainder. */
    this._tugFeelScene = null;
    /** @type {number} Seconds of the tug window already delivered. */
    this._tugElapsed = 0;
    // ── Phase D.7 garnish (mother-net-reel plan §11.7) ──
    /** @type {number} (a) Tumble carryover: residual spin (rad/s) the wrapped
     *  bundle keeps at ENVELOP, decaying over TUMBLE_CARRYOVER_DECAY_S. Fed
     *  into the berth-hold orientation as a small extra pitch term. */
    this._tumbleCarryover = 0;
    // V7: ACCUMULATED residual-spin angle (rad). The pre-V7 twin sites applied
    // one frame's increment to a freshly rebuilt quaternion each frame, so the
    // carryover never accumulated — a sub-degree offset decaying to nothing.
    this._tumbleCarryAngle = 0;
    /** @type {number} (b) Berthed pendulum: angular offset (rad) of the
     *  berthed bundle off the lagged-forward axis, driven by the same
     *  critically damped spring as the reel-direction lag, re-excited by RCS. */
    this._pendulumAngle = 0;
    /** @type {number} Pendulum angular velocity (rad/s). */
    this._pendulumVel = 0;

    // ── Q2 Ceremony event emission guards (CEREMONY_REDESIGN.md §5.2) ──
    this._ceremonyStartEmitted    = false;
    this._brakeImminentEmitted    = false;
    this._brakeFiredEmitted       = false;
    this._envelopPeakEmitted      = false;
    this._ceremonyCompleteEmitted = false;
    this._lastCinchBucket         = -1;
  }

  // ── Tick ────────────────────────────────────────────────────────────────

  /**
   * Launcher anchor in scene units, current frame. Daughter path reads the
   * source arm's live position; mother-pod path polls the anchor provider
   * (pod muzzle world position). Returns null on the headless test path —
   * callers fall back to the metres-based absolute-position logic.
   * @returns {THREE.Vector3|null}
   * @private
   */
  _anchorScene() {
    if (this._sourceArm) {
      // Daughter path (net-canister continuity fix): anchor at the arm's
      // net-launcher canister MUZZLE (mesh-derived, scene units) when the arm
      // exposes it, so the per-frame co-orbiting sync, the contact math and
      // the rendered net/tether all share the visible launch point instead of
      // the body centre. Mock arms without the method keep the old
      // arm-centre anchor (headless back-compat).
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

    // Q2 Ceremony: emit start event on first tick.
    // NOTE: emitted BEFORE the scale read below so that CameraSystem's
    // _onNetCeremonyStart handler (synchronous via EventBus) can publish the
    // first beat's timeScale to CeremonyTimeScale before we apply it.
    if (FEATURE_FLAGS.NET_CEREMONY && !this._ceremonyStartEmitted) {
      this._ceremonyStartEmitted = true;
      eventBus.emit(Events.NET_CEREMONY_START, {
        armIndex: this.armIndex,
        podIndex: this.podIndex,
        netClass: this.netClass.CODE,
      });
    }

    // Stage 4 (CEREMONY_REDESIGN.md §5, §6 R1): apply ceremony time-dilation to
    // THIS projectile's internal dt only. World dt (orbital propagation,
    // debris field, conjunctions, station-keep, etc.) is unaffected — the
    // scaling happens here, not at the caller (captureNetSystem.update). When
    // the flag is OFF or no ceremony is active, CeremonyTimeScale.get() === 1.0
    // (short-circuit) and this is a no-op multiply.
    const scale = FEATURE_FLAGS.NET_CEREMONY ? CeremonyTimeScale.get() : 1.0;
    dt = dt * scale;

    this.stateTimer += dt;

    // 2026-05-25 — Q2 visual-drift fix (THE "NET DISAPPEARS" BUG).
    //
    // Only `_updateFlight` updates `this.position` from the arm's current
    // scene position; `_updateBrake/Envelop/CinchClosing/SecureCheck` do NOT.
    // After contact, `net.position` therefore FREEZES at the arm's position
    // at the moment of contact, while the arm itself keeps orbiting at
    // ~7 km/s (LEO). [`CaptureNetVisual.update`](js/ui/CaptureNetVisual.js:484)
    // reads `net.position * M` every frame and places the visual group there,
    // so the visual is locked to a stale world point that drifts off-frame
    // within ~1 s of contact.
    //
    // CameraSystem._computeNetScenePos meanwhile uses `arm.position + launchDir
    // * distanceTraveled * M` (CURRENT arm position), so the camera tracks the
    // arm's co-orbiting frame. Result: camera and visual end up in different
    // reference frames, and the user sees the bag VANISH right when the
    // engulf/cinch should start playing — exactly the user-reported symptom.
    //
    // Fix: keep `this.position` synced to the arm's current scene position
    // during ALL post-FLIGHT states.  Each block below documents WHY:
    //
    //   CONTACT/BRAKE/ENVELOP/CINCH_CLOSING/SECURE_CHECK — visual stays
    //     anchored at the launch-distance point in the arm's co-orbiting
    //     frame (FLIGHT already does this work; running it twice is harmless).
    //
    //   REELING — 2026-05-28 (Item 2 fix): _updateReeling had a misleading
    //     comment claiming it "has its own position logic", but it only
    //     updates reelProgress (a 0→1 scalar), not position.  Result: net
    //     visual froze at the orbital-frame contact point while the arm
    //     co-orbited at 7 km/s, so the user saw the net VANISH the moment
    //     REELING started.  Now we track the arm AND slide the effective
    //     launch distance from `tetherPaidOut → 0` as reelProgress
    //     advances 0→1, so the net visually reels in toward the arm.
    // Mother-net-reel plan §7.3: the sync now ALSO covers LAUNCHING and
    // SPINNING_UP (the first 0.65 s). Previously the net sat at its absolute
    // launch point for those states while the launcher co-orbited at ~0.7
    // scene units/s — ~0.45 units (~45 km apparent) of drift before FLIGHT
    // even began. distanceTraveled is 0 during both states, so the sync seats
    // the net exactly on the moving muzzle. (Fixes the daughter's first
    // 0.65 s too — daughter regression pass required.)
    const anchor = this._anchorScene();
    if (anchor
        && (this.state === STATES.LAUNCHING
            || this.state === STATES.SPINNING_UP
            || this.state === STATES.CONTACT
            || this.state === STATES.BRAKE
            || this.state === STATES.ENVELOP
            || this.state === STATES.CINCH_CLOSING
            || this.state === STATES.SECURE_CHECK
            // S5 failure staging: MISSED used to be a ZERO-frame state (the
            // system auto-reeled in the same tick), so a frozen position never
            // rendered. A staged failure now HOLDS MISSED for
            // FAILURE_STAGING_S — without this the bag would sit at its
            // absolute contact point while the launcher co-orbits away at
            // ~0.7 scene units/s (~100 km over the beat), i.e. the beat would
            // play on a bag that vanishes (TRAP 1 / plan §2 C2 all over again).
            // Both staged reasons fire while distanceTraveled === tetherPaidOut
            // (oversize at the SECURE_CHECK resolve; strain slip on the FIRST
            // reel tick), so this holds the bag exactly where SECURE_CHECK left
            // it AND matches the empty reel-back's progress-0 value below —
            // continuous in, continuous out.
            || this.state === STATES.MISSED)) {
      const M_NET = Constants.SCENE_UNITS_PER_METER;
      this.position.x = anchor.x / M_NET + this.launchDirection.x * this.distanceTraveled;
      this.position.y = anchor.y / M_NET + this.launchDirection.y * this.distanceTraveled;
      this.position.z = anchor.z / M_NET + this.launchDirection.z * this.distanceTraveled;
    } else if (anchor && this.state === STATES.REELING) {
      const M_NET = Constants.SCENE_UNITS_PER_METER;
      // Mother physical-reel path: _updateMotherReel owns net.position (it
      // writes the bag apex from the ship-relative pin every tick), so this
      // sync is dead — and it must NOT run: it rewrites net.position to
      // whale − mouthR before _enterMotherReel reads it, which would pollute
      // the catch-seat measurement (whale-in-cone follow-up 2).
      const motherPhysical = this._isMother
        && this.catchResult === 'success' && !this._motherReelFallback;
      // 2026-06-05 (v2 — visual-only, no physics coupling): for a SUCCESSFUL
      // catch, keep the bag locked ONTO the captured debris so the cinched net
      // and its catch never separate while the daughter hauls it home (the
      // user-reported "net doesn't cinch around / bring back the debris" bug).
      // We follow the debris's live scene position — which DebrisField already
      // drives (its orbit until the daughter snaps onto it, then the daughter's
      // position) — and seat the bag apex one mouth-radius BEHIND the debris
      // along the launch axis, so the forward drawstring ring wraps the debris's
      // FAR side (opposite the daughter). This ONLY writes the net's visual
      // position; nothing reads net.position back into the arm/debris/autopilot,
      // so there is no feedback or station-keep coupling.
      const sp = (!motherPhysical && this.catchResult === 'success') ? this.targetDebris?._scenePosition : null;
      if (motherPhysical) {
        // _updateMotherReel writes net.position later this same tick.
      } else if (sp) {
        if (this._heldByArm && this._sourceArm) {
          // net-cinch: a daughter's held net sits where its bag is drawn — the neck on the tow line from her muzzle to
          // the catch, touching the catch's rear (entities/heldBagShape.js: the one rule CaptureNetVisual draws and
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
        // Empty net (miss) — reel the bag back to the launcher. Effective
        // launch distance shrinks from `tetherPaidOut` (contact distance)
        // toward 0 as `reelProgress` advances 0→1; at progress=1 the net
        // rendezvous with the launcher.
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

  // ── State transitions ──────────────────────────────────────────────────

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
    // Yo-yo despin, STYLIZED (Item 2; §11.6 doc fix 2026-08-27): the folded
    // canister starts fast and despins as the rim weights deploy and the bag
    // blossoms. The DIRECTION is the real yo-yo effect (I grows with r, so ω
    // must fall), but the SPIN_FOLDED_MULT = 3 ratio is a deliberate visual
    // simplification, NOT closed-form L = Iω conservation: 3× implies a
    // fictional folded radius of r_open/√3 (≈ 2.3 m on LARGE — not a
    // canister), while true conservation from a ~5 cm folded radius would
    // need (r_open/r_fold)² ≈ 6400× on LARGE — an invisible blur. The 3×
    // keeps the "unwinds fast, blossoms, settles" read animation-legible.
    // Same note at the constant (Constants.js CAPTURE_NET.SPIN_FOLDED_MULT).
    const foldedMult = CN.SPIN_FOLDED_MULT != null ? CN.SPIN_FOLDED_MULT : 1.0;
    const fraction = Math.min(this.stateTimer / CN.SPIN_UP_TIME, 1);
    const startHz = this.netClass.SPIN_HZ * foldedMult;
    // Lerp from the folded (fast) spin down to the settled design spin.
    this.spinRate = startHz + (this.netClass.SPIN_HZ - startHz) * fraction;
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

    // Slow in-flight spin decay (Item 2): mesh flexing + rim drag bleed angular
    // momentum, so long shots arrive with spinFraction < 1 → live f_spin penalty
    // in computeClingProbability ("fire inside the envelope or the wrap is weak").
    // Per-class override first (the MAX_FLIGHT_TIME idiom): LARGE bleeds at
    // 0.04/s — its rim carries ~8× the specific angular momentum of the
    // daughter nets, and the §11.2 LARGE resolution keys off it (derivation
    // at Constants.js CN.LARGE.SPIN_DECAY_PER_S). SMALL/MEDIUM have no
    // override and keep the shared CN.SPIN_DECAY_PER_S bit-identically.
    const decayPerS = this.netClass.SPIN_DECAY_PER_S ?? CN.SPIN_DECAY_PER_S ?? 0;
    if (decayPerS > 0 && this.spinRate > 0) {
      this.spinRate = Math.max(0, this.spinRate - this.netClass.SPIN_HZ * decayPerS * dt);
    }

    // Update position along launch direction (metres, for CaptureNetVisual + test path)
    this.position.x += this.launchDirection.x * dist;
    this.position.y += this.launchDirection.y * dist;
    this.position.z += this.launchDirection.z * dist;

    // PROD path: also update position from the launcher's current co-orbiting
    // frame so CaptureNetVisual renders the net near the ship, not 7 km behind.
    const M_NET = Constants.SCENE_UNITS_PER_METER;  // 1 m in scene units (matches ArmUnit.M)
    const anchor = this._anchorScene();
    if (anchor) {
      this.position.x = anchor.x / M_NET + this.launchDirection.x * this.distanceTraveled;
      this.position.y = anchor.y / M_NET + this.launchDirection.y * this.distanceTraveled;
      this.position.z = anchor.z / M_NET + this.launchDirection.z * this.distanceTraveled;
    }

    // Check max flight time (§2.4 phase 3). Per-class override (LARGE gets
    // 11 s so its reach reaches the 100 m tether limit); daughters keep the
    // shared CN.MAX_FLIGHT_TIME.
    const maxFlightTime = this.netClass.MAX_FLIGHT_TIME ?? CN.MAX_FLIGHT_TIME;
    if (this.flightTime >= maxFlightTime) {
      this._miss('timeout');
      return;
    }

    // Check tether limit
    if (this.tetherPaidOut >= this.netClass.TETHER_MAX) {
      this._miss('tether_limit');
      return;
    }

    // Mother-net-reel plan §7.7: dead-target guard. DebrisField.removeDebris
    // sets alive=false and FREEZES _scenePosition, so a stale truthy position
    // would keep passing the intersection check below against a body that no
    // longer exists. Route to the miss path instead.
    if (this.targetDebris && this.targetDebris.alive === false) {
      this._miss('target_lost');
      return;
    }

    // ── §11.2 mouth-collapse floor (2026-08-27) ──
    // Live rim tension from the SAME decayed spin f_spin reads:
    // F/wt = m·(2π·spinRate)²·r (rimTensionPerWeightN). Below
    // CN.MOUTH_TENSION_FLOOR_N the rim weights can no longer hold the bag
    // mouth open in 0g — the mouth is collapsed, and any contact resolves as
    // a distinct 'mouth_collapsed' MISS at the intersection check below (the
    // bag streams like a windsock; it cannot wrap). One-way latch: in-flight
    // decay is monotonic. Evaluated AFTER the timeout/tether/dead-target
    // guards so a net that dies of 'timeout' on the same tick keeps its
    // legacy reason at ANY dt (MEDIUM's floor crossing sits ~51 ms past its
    // 8 s timeout — unreachable by derivation, but the ordering makes it
    // structural, not arithmetic). The latch runs for EVERY class — the
    // wave-2 LARGE deferral (netClass.MOUTH_COLLAPSE_DEFERRED) is RESOLVED
    // (2026-08-27 owner rebalance): LARGE's per-class SPIN_DECAY_PER_S
    // override (0.04/s, read above) moves its crossing to t* ≈ 13.51 s
    // ≈ 135 m, outside every reachable contact (tether pay-out 10 s,
    // MAX_FLIGHT 11 s) with ≥ 2.5 s margin, so 68–100 m whale shots arrive
    // above the floor honestly (≥ 17.1 N at max reach) instead of being
    // skipped. Derivation at Constants.js CN.LARGE.SPIN_DECAY_PER_S; pins in
    // test-CaptureNet-MouthCollapse.js. Telemetry (rimTensionN) runs for
    // every class.
    //
    // Gameplay-legibility choice (§11.2 fix option "floor check ⇒ forced
    // MISS", over cutting SD-NET's RANGE/MAX_FLIGHT to ~25 m): the long shot
    // stays TAKEABLE and fails honestly with its own comms line
    // (missReasonToText 'mouth_collapsed' — "shot too long"), teaching the
    // envelope through consequence. The range-clamp alternative would touch
    // RANGE/MAX_FLIGHT constants mirrored by the reticle/odds/refusal
    // surfaces — outside this wave's flight/contact scope — and would
    // silently forbid the input instead of explaining the failure.
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

    // Check range to target (intersection = distance < net radius)
    // PROD: use launcher-relative scene position (co-orbiting reference frame).
    // TEST: use absolute metres (mock .position, no anchor).
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
        // UX-11 #1: close-range forgiveness — near-grazes inside CLOSE_RANGE count.
        const radiusScene = effectiveCatchRadius(
          this.netClass.DIAMETER / 2, this.distanceTraveled
        ) * M_NET;
        // Q2 Ceremony: brake-imminent lookahead (cinch path only)
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
          // net-range: the mother's net never catches a piece beyond its advertised reach (netMaxReachM, 100 m for the
          // large net), measured the way the HUD and the fire gate measure it: ship centre → piece (targetRangeM). The
          // 3 m mouth radius and a piece drifting away during the 10 s flight could otherwise close a catch past it.
          if (this._anchorProvider && !this._sourceArm) {
            const shipPos = (this._ctx && this._ctx.player && typeof this._ctx.player.getPosition === 'function')
              ? this._ctx.player.getPosition() : ap;
            if (targetRangeM(shipPos, sp) > netMaxReachM(this.netClass)) {
              this._miss('out_of_range');
              return;
            }
          }
          // §11.2: contact while the mouth is collapsed cannot wrap — resolve
          // as the distinct MISS so comms can teach the range limit.
          if (this.mouthCollapsed) {
            this._miss('mouth_collapsed');
            return;
          }
          // u20-nets: where the mouth is, relative to the target, at contact (metres; the scoop reads it when the net closes)
          this._mouthOffsetM = { x: -dx / M_NET, y: -dy / M_NET, z: -dz / M_NET };
          this._mouthAxis = { x: this.launchDirection.x, y: this.launchDirection.y, z: this.launchDirection.z };   // u22-scoop: the drawn net's axis
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
        // Q2 Ceremony: brake-imminent lookahead (cinch path only)
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
          this._mouthOffsetM = { x: -dx, y: -dy, z: -dz };   // u20-nets: the mouth relative to the target at contact (metres)
          this._mouthAxis = { x: this.launchDirection.x, y: this.launchDirection.y, z: this.launchDirection.z };   // u22-scoop: the drawn net's axis
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
    // Q2 Ceremony: emit brake-fired on state entry
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
    // Q2 Ceremony: emit envelop peak at 50% of ENVELOP_TIME
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
    // Q2 Ceremony: emit cinch progress at discrete 10% thresholds
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
    // ── MOTHER PHYSICAL REEL (mother-net-reel plan §8 A1) ─────────────────
    // Ship-relative, pinned through debrisField.pinCapturedDebris every frame.
    // TRAP 1 (plan §0): NEVER step the pin toward the pod in absolute
    // coordinates — the ship translates ~0.7 scene units/s while the reel
    // closes at 2e-5 units/s, so an absolute reel diverges ~35,000×.
    // TRAP 3: NEVER write _armPinPos raw and rely on DebrisField.update to
    // render it — that ran EARLIER this frame, so the catch lands one frame
    // (~1.17 km at 60 fps) behind the nose. pinCapturedDebris force-writes
    // the instance matrix in the same call, so frame order stops mattering.
    if (this._isMother && this.catchResult === 'success' && !this._motherReelFallback) {
      this._updateMotherReel(dt);
      // _updateMotherReel sets _motherReelFallback when no berth context
      // exists (headless path) — fall through to the daughter reel-back so
      // the net still stows and prunes instead of looping on a miss.
      if (!this._motherReelFallback) return;
    }

    // ── Held daughter catch: keep the bag cinched on the debris until the arm
    // delivers it. The net's own reel is short (tetherPaidOut/REEL_SPEED) and
    // would otherwise STOW — removing the bag visual — long before the daughter
    // finishes hauling, so the netted catch appeared to vanish mid-haul. The
    // position-follow above keeps the bag locked onto the debris while we hold;
    // we release the hold (and stow) once the catch is no longer pinned to a
    // captor: docked (debris removed/alive=false, pin cleared), net failure
    // (pin cleared), or tether snap's bounded drift (pin finally cleared).
    if (this._heldByArm) {
      const d = this.targetDebris;
      const stillHauling = !!(d && d.alive !== false && d._capturedByArm);
      if (stillHauling) {
        // REEL_PROFILE_V2 (plan Q3): during the SNUG sub-phase the arm sets
        // `_snugTargetN` — pull the bag tight to that explicit cinch tension so
        // daughter+net+debris rigidize into one unit before the haul. Otherwise
        // hold at the base mass formula (legacy behaviour).
        this.tensionN = (this._snugTargetN != null)
          ? this._snugTargetN
          : baseCaptureTensionN(this.capturedMass);
        return;                       // hold: no completion while the arm hauls
      }
      this._heldByArm = false;        // delivered / lost → stow promptly
      this._snugTargetN = null;
      this.reelProgress = 1.0;
      // Register item 28: the hold ends two ways — DELIVERED (the arm's furnace
      // hand-off: _updateHoldingCatch marks the piece _breakdownActive as it
      // releases the cinch, ArmUnit.js) or LOST (integrity slip / boost rip /
      // tether-snap drift-end / reset drop / severed-claim transfer — the catch
      // left the arm without reaching the furnace). Only a delivery may report
      // its mass at completion; a loss stows EMPTY and reports releasedMass
      // instead, so no listener reads a successful-looking capturedMass for a
      // body that drifted away.
      if (!(d && d._breakdownActive)) this._releasedMassKg = this.capturedMass;
    }

    if (this.tetherPaidOut <= 0) {
      // Edge case: net fired but didn't travel
      this.reelProgress = 1.0;
    } else {
      const reelRate = this.netClass.REEL_SPEED / Math.max(1, this.tetherPaidOut);
      this.reelProgress = Math.min(1.0, this.reelProgress + reelRate * dt);
    }

    // Tension: base + mass factor (simplified — real model in ST-9.5)
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

  // ── Mother physical reel + berth (mother-net-reel plan §8) ─────────────

  /**
   * @private Mother REELING entry: strain/oversize roll, then seed the
   * ship-relative reel state from the debris's LIVE _scenePosition (one frame
   * only — LassoSystem.js:1401-1409 documents why the seed must start from
   * where the debris actually is, not where the flight model left it).
   * @returns {boolean} false when the entry itself failed (strain slip → miss)
   */
  _enterMotherReel() {
    const d = this.targetDebris;
    const player = this._ctx?.player;
    if (!d || !player) return false;

    // §4.3 strain/oversize roll — the odds model already prices this
    // (ToolOdds.computeNetOdds multiplies by 1 − computeStrainFailProbability),
    // so the HUD would otherwise promise a slip that can never happen.
    const rated = this.netClass.MAX_CAPTURE_MASS || 0;
    const mass = d.mass || 0;
    // Re-judge the SAME presentation contact recorded (not the live one the
    // carried tumble has drifted to) through the ONE mouth-fit predicate
    // (register item 21a).
    const presented = this._presentedWidthM ?? d.sizeMeter ?? 0;
    if (!fitsMouth(d, this.netClass, null, presented)) {
      this._miss('oversize_aspect');
      return false;
    }
    if (rated > 0 && mass > 0) {
      const strain = mass / rated;
      // The band ramp routes through the ONE strain-band helper (register item
      // 88); the CAP stays here — a one-shot roll vs NET_STRAIN_FAIL_PROB_MAX.
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

    // Register item 81: past the gates, this entry IS the mother taking
    // ownership — drop a tether-snapped runaway's stale severed claim so the
    // EXPENDED arm's _updateExpended never fights the berth-line pin (and its
    // 8 s drift release never fires on this net's held catch). Placed AFTER
    // the refusal gates above: a refused entry leaves the bounded-drift
    // release armed (the runaway stays the drifting arm's business).
    dropSeveredCatchClaim(d);

    // Seed ship-relative reel state.
    const M_NET = Constants.SCENE_UNITS_PER_METER;
    // S13(e): the reel/berth homes on the COLLAR anchor (the berth-approach
    // corridor is the collar's), while the seat below keeps the launcher
    // muzzle (_anchorScene): the brake apex is on the launch line. The
    // muzzle→collar offset rides in the lateral seed and decays across the reel
    // (the existing _settleFwdLagged mechanism), so the hand-off never snaps.
    // Since 2026-10-13 the muzzle is ON the axis, 30 mm behind the collar, so
    // that offset is purely axial (it was 0.45 m sideways for the pod pair).
    const anchorWorld = (typeof player.getNetBerthCollarPositionInto === 'function')
      ? player.getNetBerthCollarPositionInto(new THREE.Vector3())
      : (typeof player.getNetPodPositionInto === 'function')
        ? player.getNetPodPositionInto(this.podIndex, new THREE.Vector3())
        : new THREE.Vector3();
    const sp = d._scenePosition;
    if (sp) {
      const dx = sp.x - anchorWorld.x, dy = sp.y - anchorWorld.y, dz = sp.z - anchorWorld.z;
      // Whale-in-cone follow-up 2 (reel/berth co-location): the catch rides
      // INSIDE the bag at the depth the capture left it — not AT the apex.
      // The seat is its depth past the brake apex along the frozen bag axis
      // (launchDirection — the same axis CaptureNetVisual orients the drawn
      // bag to every frame, so pin, mesh and probe can never drift). The
      // brake apex is anchor + launchDir × distanceTraveled (the formula the
      // post-FLIGHT anchor-sync writes every tick, :815). Read the LIVE
      // anchor — never net.position, which is FROZEN in the absolute frame
      // from the last SECURE_CHECK tick: one frame of orbital drift is
      // ~1.17 km at 60 fps (~8 km in the headless harness), which would pin
      // the catch kilometres from the bag (measured 2026-08-05:
      // _catchSeatM = 7612.69 m on a one-frame-stale anchor). anchor + sp
      // are both live, so the seat is drift-free.
      const L = this.launchDirection;
      const anchor = this._anchorScene();
      const seatM = (L && anchor) ? Math.max(0,
        ((sp.x - anchor.x) / M_NET) * L.x
        + ((sp.y - anchor.y) / M_NET) * L.y
        + ((sp.z - anchor.z) / M_NET) * L.z
        - this.distanceTraveled) : 0;
      this._catchSeatM = seatM;
      // _remainingM is the APEX (tether end) distance along the ship axis, and
      // `_lateral` the apex's offset off it: apex = catch − launchDirection ×
      // seat, split into its axial and perpendicular parts (l8-reel-collar: this
      // is exact, so the pin reproduces the live catch position to the last
      // bit at entry — the old |d| − seat form was off by lateral²/2R for an
      // off-axis catch, a snap at the CAPTURED→REELING hand-off).
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
    // Review fix: the reelProgress denominator must be the ACTUAL seeded
    // remaining distance, not tetherPaidOut — the two disagree whenever the
    // catch drifted between contact and reel entry (or a close target made
    // tetherPaidOut < berthStandoffM), which collapsed the denominator to
    // ~0 and snapped progress 0→1 instead of easing.
    this._reelSeedM = Math.max(this._remainingM, 1e-3);
    // Item 15: the readability floor's engagement ramp starts at reel entry
    // (see _catchFloorScale). Seeded HERE, once — never at BERTHED.
    this._floorRampT = 0;
    this._fwdLagged = new THREE.Vector3(0, 0, 1).applyQuaternion(player.quaternion).normalize();

    // Capture the catch's attitude in the SHIP frame so the berth hold can
    // rotate it rigidly with the ship (plan §1.2).
    if (d.tumbleAxis && player.quaternion) {
      const qCatch = new THREE.Quaternion().setFromAxisAngle(d.tumbleAxis, d.tumbleAngle || 0);
      this._qLocal = player.quaternion.clone().invert().multiply(qCatch);
    } else {
      this._qLocal = new THREE.Quaternion();
    }

    // Phase D.7 (a) — tumble carryover: seed the residual spin the wrapped
    // bundle keeps at ENVELOP (the plan's "decaying spin over ~4–6 s instead
    // of the hard stop"). Capped; decays in _updateMotherReel/updateBerthHold.
    const tumbleRate = Math.abs(d.tumbleRate || 0);
    this._tumbleCarryover = Math.min(tumbleRate, CN.TUMBLE_CARRYOVER_MAX_RAD_S ?? 0.6);
    this._tumbleCarryAngle = 0;   // V7: accumulation starts fresh each catch
    return true;
  }

  /**
   * @private The `_catchRenderMin` VALUE for the reel/berth write sites (and LeashDriver's `easeFull`).
   *
   * reel-visible (owner 2026-10-16, DECISIONS §25 row 2: "the reel-in must be seen"; Ruling 0, physically real
   * wins): a mother-net catch is drawn at its TRUE size from capture to latch. The CAPTURE_NET readability floor
   * (MOTHER_CATCH_MIN_RENDER_M, 2.0 m: whale-in-cone items 8/15, l8-reel-collar D3) drew a 0.3 m piece up to 3.3x
   * big at reel start and shrank it between 20 m and 3 m from the collar: the owner saw "debris and net magically
   * shrink". The value written is now the piece's BASE render scale, which DebrisField.catchRenderFloorScale (its
   * predicate only raises, `_catchRenderMin > base`) treats as no floor, so every reader (the probe, the bag's
   * contents spec, both matrix writers, LeashDriver's easeFull) sees the real size. The floor constants stay in
   * Constants.js (the lasso path and the non-ladder ceremony hold distance still read their own).
   * @param {object} d — the canonical catch debris
   * @param {number} _dt — unused (the old ramp clock)
   * @returns {number} scene-unit scale for `_catchRenderMin` (== the base render scale)
   */
  _catchFloorScale(d, _dt) {
    return DebrisField.baseRenderScale(d);   // item 19: ONE static for the base
  }

  /**
   * @private l8-reel-collar — seed the HOME state at reel entry (or lazily, for a net a test put into REELING /
   * BERTHED by hand): where the catch's centre ends on the collar axis, and the apex / seat that put it there.
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
   * @private l8-reel-collar — the reel's progress p (0 at the seed, 1 with the apex at home) for apex distance `A`.
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
   * @private l8-reel-collar — the seat law. As the apex comes in the catch slides toward the bag's mouth (seat
   * S0 → home seat, linear in p) and the bag axis turns from the captured launch direction onto the ship axis
   * (normalised lerp, weight p). Writes `_catchSeatM` and `launchDirection` in place (the visual orients the bag to
   * it, the pins read it), so pin, mesh and every reader stay one geometry. At p = 1 the axis IS the ship axis, the
   * seat IS the home seat: the catch is on the collar axis at home.
   * @param {number} A — apex distance, metres
   * @returns {number} p
   */
  _applySeatLaw(A) {
    const p = this._seatProgress(A);
    const S0 = this._seat0M ?? this._catchSeatM ?? 0;
    this._catchSeatM = S0 + (this._homeSeatM - S0) * p;
    const L0 = this._ldir0, f = this._fwdLagged, L = this.launchDirection;
    if (L0 && f && L) {
      const x = (1 - p) * L0.x + p * f.x, y = (1 - p) * L0.y + p * f.y, z = (1 - p) * L0.z + p * f.z;
      const n = Math.hypot(x, y, z);
      if (n > 1e-6) { L.x = x / n; L.y = y / n; L.z = z / n; } else { L.x = f.x; L.y = f.y; L.z = f.z; }
    }
    return p;
  }

  /**
   * @private l8-reel-collar — the catch centre's distance from the collar plane along the ship axis for apex
   * distance `A` (closed form of the seat law; monotone in A for any sane launch angle). Used to step the apex so the
   * CATCH moves at the commanded speed.
   * @param {number} A
   * @returns {number} metres
   */
  _catchAxialAt(A) {
    const p = this._seatProgress(A);
    const S0 = this._seat0M ?? 0;
    const S = S0 + (this._homeSeatM - S0) * p;
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
   * @private l8-reel-collar — the catch's commanded speed `crem` metres from its end: the class reel speed, then
   * a constant-deceleration slow-down (DECEL_MPS2) that reaches SLOW_MPS at SLOW_ZONE_M and holds it to arrival.
   * @param {number} crem — catch distance still to go, metres
   * @param {number} nominalMps
   * @returns {number} m/s
   */
  _reelCatchSpeed(crem, nominalMps) {
    const H = CN.REEL_HOME;
    const room = Math.max(0, crem - H.SLOW_ZONE_M - (H.DECEL_LEAD_M ?? 0));
    return Math.min(nominalMps, H.SLOW_MPS + Math.sqrt(2 * H.DECEL_MPS2 * room));
  }

  /**
   * l8-reel-collar — seconds the inward reel still needs at the commanded profile (cruise at the class reel speed,
   * the constant-deceleration slow-down, the creep over the last SLOW_ZONE_M). An estimate for callers that size a
   * wall-clock bound (CameraSystem's REEL_IN beat); null before the reel is seeded.
   * @returns {number|null} seconds
   */
  reelEtaS() {
    if (this._homeSeatM == null || this._remainingM == null || !this._fwdLagged) return null;
    const H = CN.REEL_HOME;
    const endA = Math.max(this._homeApexM, this._effectiveStandoffM ?? this._homeApexM);
    const crem = Math.max(0, this._catchAxialAt(this._remainingM) - this._catchAxialAt(endA));
    const v = this.netClass?.REEL_SPEED || 2.0;
    const creepM = H.SLOW_ZONE_M + (H.DECEL_LEAD_M ?? 0);
    // the profile is v = SLOW + sqrt(2 a x) (x = distance beyond the creep): the slow-down spans (v - SLOW)^2 / 2a
    const decelM = (v - H.SLOW_MPS) * (v - H.SLOW_MPS) / (2 * H.DECEL_MPS2);
    const cruiseM = Math.max(0, crem - creepM - decelM);
    const decelInM = Math.min(decelM, Math.max(0, crem - creepM));
    return cruiseM / v + decelInM / (0.5 * (v + H.SLOW_MPS)) + Math.min(crem, creepM) / H.SLOW_MPS;
  }

  /**
   * @private l8-reel-collar — one frame of the inward reel: the CATCH advances `_reelCatchSpeed × dt` toward its end
   * (the apex distance `endA`), and the apex is whatever puts it there (bisection on the monotone closed form).
   * Never overshoots: the step that would reach the end lands exactly on it.
   * @param {number} dt
   * @param {number} nominalMps
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
   * Small-catch plan W4 (2026-08-25) — the DRAWN bundle's radius in metres:
   * what the ceremony camera is actually holding on. `sizeMeter` is the
   * logical size; the renderer draws effectiveRenderScale × boundingRadius.
   * (Before reel-visible, 2026-10-17, the net-held readability floor raised
   * every sub-floor catch to ~MOTHER_CATCH_MIN_RENDER_M — measured
   * tmp/frag-before: a 0.5 m fragment drew at 2.0 m radius from REEL_IN on;
   * `_catchFloorScale` now returns the base scale, so this is the true size.)
   * The camera's hold-distance formula
   * reads THIS (through the one clamp-aware SSOT chain), so the shot frames
   * the bundle the player sees, never the invisible logical size. Returns 0
   * with no target (callers fall back to the sizeMeter-only term); headless
   * camera mocks simply omit the method — same fallback.
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
    // No berth context (headless test path, or a mother net fired without
    // init(deps)): fall through to the daughter-style reel-back below rather
    // than missing — a miss here would loop MISSED→REELING→MISSED via the
    // re-armed auto-reel and never prune.
    if (!d || !player || !debrisField) { this._motherReelFallback = true; return; }
    if (d.alive === false) { this._miss('target_lost'); return; }

    if (this._remainingM == null) {
      if (!this._enterMotherReel()) return;   // strain slip / oversize → missed
    }

    const M_NET = Constants.SCENE_UNITS_PER_METER;
    // The standoff in force: raised to CORRIDOR_EXTENDED_STANDOFF_M after a
    // corridor-timeout berth (Phase C-lite, plan §10).
    // l8-reel-collar: the APEX target at home is the bag's mouth at the ring
    // (CN.REEL_HOME.APEX_AT_RING_M), NOT the old size/2 + 1.0 m standoff. A
    // corridor-timeout berth still raises it (the extended standoff).
    if (this._homeSeatM == null) this._seedReelHome(d, player);
    const baseStandoffM = this._homeApexM;
    if (this._effectiveStandoffM == null) this._effectiveStandoffM = baseStandoffM;
    const berthStandoffM = Math.max(baseStandoffM, this._effectiveStandoffM);

    // ── Corridor gate (Phase C-lite, plan §10): pause the final approach
    // CORRIDOR_HOLD_M out until the recovery corridor (a cylinder along
    // ship-local +Z from the muzzle, radius = sizeMeter/2 + BERTH_CLEARANCE_M)
    // is clear of strut tips (a forward-swept strut blocks whether or not it
    // holds a daughter catch). S13(d): the lasso-cargo read is gone; S13(e): mated
    // cargo joined the obstacle set (see _corridorClear). On timeout, berth at the
    // extended standoff rather than clip through.
    // Register item 66: the mated-cargo hold STACKS — the gate's level is
    // raised past the queue's fore-extent so each queued catch holds clear of
    // the previous one's far face (two catches frozen at the same 10 m level
    // co-locate — co-located reads as one). 0 with an empty queue ⇒ the
    // CORRIDOR_HOLD_M floor stands byte-identical (the single-catch case —
    // the gated scenario — never sees the queue term).
    const queueHoldM = this._queueHoldLevelM(d);
    const holdM = Math.max(berthStandoffM, CN.CORRIDOR_HOLD_M ?? 10, queueHoldM);
    if (!this._corridorTimedOut && this._remainingM <= holdM && !this._corridorClear(d)) {
      if (!this._corridorHold) {
        this._corridorHold = true;
        this._corridorTimer = 0;
        // Freeze at the CURRENT range, never above it: a catch seeded inside
        // the gate range (a very close shot) must not pop outward to holdM.
        // Register item 73 — EXCEPT the queue level: when mated cargo raised
        // the hold past the current range (the drain-race — this catch sailed
        // through the gate range while the leader was REELING-not-held, then
        // the leader berthed and the queue term appeared beneath it), freezing
        // here pins this catch INSIDE the member's far face (two drawn bodies
        // interpenetrating — a continuity-law violation). The latch takes the
        // queue level and the hold glides OUT to it at reel speed (the ease
        // below) — the one bounded, documented exception to the monotonic-ease
        // invariant. Empty queue ⇒ queueHoldM 0 ⇒ the latch is the current
        // range, byte-identical (the single-catch case never glides).
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
        // Timeout — berth AT the held position (clamped into [base, extended]).
        // For strut tips and mated cargo the hold level is already outside every
        // intruder's reach — that is why the gate froze the approach there — so
        // completing at the held range neither slides inward past the intruder
        // nor pops outward. NOT so for the radiator read (big-catch-home): a
        // radiator or tip bag that folds in during the last metres can latch the
        // hold with the catch already touching it, and this timeout berths it
        // there anyway (plan D3 accepted it; open item, docs/research/2026-10-leash.md).
        const extended = Math.max(holdM, CN.CORRIDOR_EXTENDED_STANDOFF_M ?? 10);
        this._effectiveStandoffM = Math.min(Math.max(baseStandoffM, this._corridorHoldLevelM), extended);
        // Keep _corridorHold TRUE for the rest of this frame: berthStandoffM
        // was derived at the top of the tick from the OLD standoff, so letting
        // the ease run now would step remainingM below the new standoff and
        // the next frame would clamp it back OUT — a one-frame outward pop
        // violating the monotonic-ease invariant. The latch below makes the
        // gate condition false next frame, and the resume branch clears the
        // hold there, when the ease runs against the correct standoff.
        this._corridorTimedOut = true;   // latch: the gate must not re-arm
                                         // against the same blocked corridor
                                         // while the berth completes.
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `Deck not clear — berthing at extended standoff (${Math.round(this._effectiveStandoffM)} m).`,
          source: 'HOUSTON', priority: 'warning',
        });
      }
      // Hold: the approach stays at the latch (still pinned below) — nothing
      // moves remainingM while held except the item-73 queue-glide, which
      // runs in the ease below (bounded, at reel speed, never past the latch).
    } else if (this._corridorHold) {
      // Corridor cleared (or we were never blocked) — resume the approach.
      this._corridorHold = false;
      this._corridorTimer = 0;
      // A timeout mid-glide keeps the glide flag: the berth completes the
      // glide OUT to the raised standoff (the ease below) — never a pop.
      if (!this._corridorTimedOut) this._corridorGlide = false;
    }

    // Monotonic ease-in (never decelerate mid-reel so the tether cannot
    // re-slack and re-snap). Mild long-tether speed-up lands the duration in
    // the ~5–25 s window (REEL_SPEED 2.0 on a 100 m shot would else be ~50 s).
    const reelSpeed = (this._remainingM >= (CN.REEL_LONG_TETHER_M ?? 40))
      ? this.netClass.REEL_SPEED * (CN.REEL_LONG_TETHER_MULT ?? 3.0)
      : this.netClass.REEL_SPEED;
    const remBeforeM = this._remainingM;   // w4-power D5: the reel's travel this frame
    if (!this._corridorHold) {
      if (this._corridorGlide && this._remainingM < berthStandoffM) {
        // Item 73: a hold that timed out mid-glide completes the glide OUT to
        // the raised standoff at reel speed — the berth is AT the latch, and
        // an outward pop to it would violate the continuity law.
        this._remainingM = Math.min(berthStandoffM, this._remainingM + reelSpeed * dt);
      } else {
        // l8-reel-collar: the speed (and the arrival taper) is the CATCH's, so the
        // last 0.30 m runs at <= 0.10 m/s whatever the seat; the apex follows.
        this._reelStepCatch(dt, reelSpeed, berthStandoffM);
      }
    } else if (this._remainingM < this._corridorHoldLevelM) {
      // Item 73: the queue-glide — the one bounded OUTWARD move the reel
      // makes (the documented exception to the monotonic-ease invariant named
      // above): the drain-race follower backs out to the queue-cleared latch
      // at reel speed, never past it, so it never freezes inside the leader's
      // far face. reelProgress reads backward during the glide — the honest
      // read (the catch IS backing out to the gate).
      this._remainingM = Math.min(this._corridorHoldLevelM, this._remainingM + reelSpeed * dt);
    }

    // reelProgress: remainingM is the single source (no external consumer, so
    // free to redefine). 0 at the seeded range (_reelSeedM), 1 at the standoff.
    // During a corridor hold remainingM freezes, so progress freezes with it —
    // the honest read (the catch IS parked at the gate).
    const seedM = Math.max(berthStandoffM + 1e-3, this._reelSeedM ?? this.tetherPaidOut ?? berthStandoffM + 1e-3);
    this.reelProgress = Math.min(1, Math.max(0,
      1 - (this._remainingM - berthStandoffM) / (seedM - berthStandoffM)));

    // Rotation lag: run the ship forward through a critically damped spring so
    // a mid-reel slew lags and settles instead of whipping the catch.
    this._settleFwdLagged(player, dt);

    // Pin anchor: berth anchor (the collar — S13(e)) + lagged-fwd · remainingM
    // + lateral (scene units) — the bag's APEX, i.e. the tether end the winch
    // actually reels.
    const anchorWorld = (typeof player.getNetBerthCollarPositionInto === 'function')
      ? player.getNetBerthCollarPositionInto(_v3c)
      : (typeof player.getNetPodPositionInto === 'function')
        ? player.getNetPodPositionInto(this.podIndex, _v3c) : _v3c.set(0, 0, 0);
    // l8-reel-collar: the seat shrinks and the bag axis turns onto the ship
    // axis as the apex nears the ring (progress p 0 → 1), and the apex's lateral
    // offset dies with it, so at home the catch is exactly on the collar axis.
    const seatP = this._applySeatLaw(this._remainingM);
    _v3d.copy(anchorWorld)
      .addScaledVector(this._fwdLagged, this._remainingM * M_NET)
      .addScaledVector(this._lateral, 1 - seatP);

    // net.position is the bag's apex anchor (CaptureNetVisual seats the kit
    // there × M every frame; the tether draws to it) — written BEFORE the
    // seat offset goes into the catch pin below.
    this.position.x = _v3d.x / M_NET;
    this.position.y = _v3d.y / M_NET;
    this.position.z = _v3d.z / M_NET;

    // The catch rides _catchSeatM metres INSIDE the bag along the bag axis
    // (launchDirection — the axis the visual orients to), not AT the apex
    // (whale-in-cone follow-up 2: co-locating the two left the catch on the
    // bag apex unwrapped — the metres gate's COLOCATION-DEFECT).
    if (this._catchSeatM) _v3d.addScaledVector(this.launchDirection, this._catchSeatM * M_NET);
    this._reelDistM = Math.hypot(_v3d.x - anchorWorld.x, _v3d.y - anchorWorld.y, _v3d.z - anchorWorld.z) / M_NET;

    // Orientation follows the ship (plan §1.2), PLUS the Phase D.7 (a)
    // tumble-carryover offset — shared helper (V7: the twin sites are one
    // implementation now, so the accumulation fix cannot drift apart again).
    this._applyCatchOrientation(d, player, dt);

    d._armPinned = true;
    d._captured = true;
    d._catchRenderMin = this._catchFloorScale(d, dt);   // item 15: ramped at reel entry
    debrisField.pinCapturedDebris(d, _v3d);

    // Tension readout (HUD): base + mass factor, same shape as the daughter.
    this.tensionN = baseCaptureTensionN(this.capturedMass);

    // w4-power D5 (owner 2026-10-12: "Reel on mother costs"): the mother's net
    // reel bills her battery while it turns — line tension × line speed ÷
    // REEL_EFFICIENCY, floored at its 15 W motor, capped at HAUL_MOTOR_POWER.
    // A corridor hold (no travel) bills nothing; neither does a held-world
    // frame (the ship's `_motorBillHeld`, set from dtWorld in its update()).
    const reelTravelM = Math.abs(this._remainingM - remBeforeM);
    if (dt > 0 && reelTravelM > 0 && player._motorBillHeld !== true) {
      const rs = player._resourceSystem;
      if (rs && typeof rs.billWatts === 'function') {
        const MD = Constants.MOTOR_DRAW_W || {};
        const mechW = Math.max(0, this.tensionN) * (reelTravelM / dt) / (MD.REEL_EFFICIENCY || 0.5);
        rs.billWatts(Math.min(MD.REEL_MAX ?? 2500, Math.max(MD.MOTHER_REEL_MIN ?? 15, mechW)), dt);
      }
    }

    // Completion → BERTHED. Item 73: a queue-glide still travelling OUT to a
    // timeout-raised standoff has NOT completed — the check below reads
    // remainingM ≤ standoff as arrival, true from the WRONG side mid-glide
    // (the berth hold would then snap the pin to the standoff — an outward
    // pop). Wait for the glide to arrive. glideIncomplete is false on every
    // pre-73 path (the flag is never set with an empty queue).
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
   * @private Recovery-corridor test (mother-net-reel plan §10 Phase C-lite).
   * Analytic — no mesh collision exists anywhere in this codebase. The
   * corridor is a cylinder along ship-local +Z from the berth anchor (S13(e):
   * the COLLAR — the berth-approach corridor is the collar's, S12 M2 reading
   * 8; the launch corridor is a separate matter, owned by the fire-time foul
   * read getCollarShotFoul), radius =
   * debris.sizeMeter/2 + BERTH_CLEARANCE_M. It must contain:
   *   1. NO strut tip (strutLocalDirection(α, az) × STRUT_LENGTH from the
   *      collar pivot — at α≈π a 1.70 m strut tip reaches ~2.5 m fore, past
   *      the muzzle plane at z ≈ 1.30 m; a forward-swept strut blocks whether
   *      or not it holds a catch);
   *   2. NO mated cargo (S13(e): every OTHER mother net's docked catch —
   *      BERTHED/COLLARED/TRANSFERRING — is an obstacle to THIS approach, so
   *      a second catch holds at the gate instead of seating inside the
   *      occupant; a berthing net's own catch exempts itself, as today).
   *   3. NO radiator part and NO bag held on a radiator tip (big-catch-home
   *      D2): a READ of the ship keep-out (`armManager.getKeepOut()`, exact
   *      triangles / spheres), ONLY categories 'rad' and spheres named 'tip
   *      bag N'. The catch is a capsule of radius sizeMeter/2 on the collar
   *      axis, from its CURRENT distance from the anchor (never nearer than
   *      home) down to its home distance; a part closer than
   *      REEL_HOME.CLEARANCE_M holds the reel. The cylinder above is NOT
   *      applied to the radiators (it would hold every catch while they are
   *      closed — their tips sit inside it at 2-13° though the real gap is
   *      >= 0.085 m). The home is not refreshed when the radiators move after
   *      reel entry (D3): this read holds the reel and the timeout berths it.
   *      No keep-out (a mock armManager with only `arms`) -> this read passes.
   * The lasso cargo-cell read is GONE (S13(d)) — a lassoed piece rides this
   * same mother berth path (adoptLassoCatch), so it is never an obstacle to
   * itself.
   * Everything is evaluated in the SHIP-LOCAL frame with the origin at the
   * berth anchor, so the test is attitude- and position-free and needs no
   * world-space round-trip.
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

    // Everything is evaluated SHIP-LOCAL with the origin at the berth anchor
    // (S13(e): the collar, ON the axis at (0, 0, BERTH_COLLAR_Z_M) — read from
    // the anchor Object3D when the real ship is present, falling back to the
    // launcher muzzle local (headless mocks without the collar anchor) and then to
    // the documented constant), so the test is attitude- and position-free.
    berthAnchorLocalInto(player, this.podIndex, _anchorLocal);
    const mx = _anchorLocal.x, my = _anchorLocal.y, mz = _anchorLocal.z;

    // Cylinder axis = ship-local +Z. A point is INSIDE when its axial
    // coordinate z > 0 (fore of the muzzle plane) — intruders aft of the
    // muzzle can't be clipped by an incoming catch — AND its radial
    // (x,y) distance from the axis < radiusM.
    const testLocal = (lx, ly, lz) => {
      if (lz <= 0) return false;                       // aft of the muzzle plane
      return (lx * lx + ly * ly) < radiusSq;
    };

    // ── 1. Strut tips, and the catches the daughters HOLD ──
    // (net-duck 2026-10-23: the tip read below still says nothing about a held catch's BODY, which sits well off the tip — a 5 m
    // catch above ~44° can stand in the corridor with its tip clear — so each daughter's held catch is read as well, further down.)
    // Strut geometry is ship-local by construction: pivot at
    // (cos az·collarR, sin az·collarR, collarY), tip at pivot +
    // strutLocalDirection(α, az) × STRUT_LENGTH. A forward-swept strut is the
    // blocker whether or not it holds a catch: whenever a tip is fore of the
    // muzzle plane (tipZ > 0) its radial is
    // ≤ 2.10 m (DECISIONS §11: collarR 0.40 + STRUT_LENGTH 1.70, was 2.01 m
    // at 1.60), while the smallest whale-class corridor radius in the catalog
    // is 2.40 m (FENGYUN-1C, 2.8 m), so the tip test always fires first. (And
    // capturedDebris is set at CAPTURED/GRAPPLED — long before the daughter is
    // back at the tip — so a held-catch check keyed on it would test the wrong
    // position anyway.) Revisit if strut length, collar radius or the minimum
    // whale size changes enough to close that 0.30 m margin (was 0.39 m).
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
        const azRad = (arm._azimuthDeg || 0) * Math.PI / 180;
        // ONE geometry (ArmDockBasis.strutTipFoulsCorridor) — shared with
        // ArmManager's lean-aside duck and its re-pose pre-check, so the duck
        // can never disagree with this, the authoritative gate.
        if (strutTipFoulsCorridor(alpha, azRad, collarR, collarY, strutLen, _anchorLocal, radiusM)) {
          return false;
        }
        // net-duck D1 (owner 2026-10-22: "out of the way of mother net"): a daughter's HELD catch is a body on her strut, and above
        // ~44 deg a big one sits across this corridor although her tip does not (measured: tmp/plans/net-duck.md Log, T0a). The
        // drawn mesh of every rack piece at her LIVE angle is read against the same cylinder; a mock arm manager with no dock
        // positions, or a held piece with no mass, is skipped. (The comment above was written when a held catch was keyed on
        // `capturedDebris`, which is the in-hand haul; the rack pieces are what stand at the tip.)
        if (heldCargoFoulsCorridorAt(armManager, i, alpha, _anchorLocal, radiusM)) {
          return false;
        }
      }
    }

    // ── 2. Mated cargo (S13(e)) ──
    // Every OTHER mother net's docked catch (BERTHED/COLLARED/TRANSFERRING) is
    // an obstacle to THIS approach: with the occupancy refusal retired, a
    // second catch can come home while the collar is occupied, and without
    // this read it would seat INSIDE the occupant (two drawn bodies
    // interpenetrating — a continuity-law violation). The gate holds the
    // approach at CORRIDOR_HOLD_M (10 m — 9 m clear of the occupant's near
    // face, which sits exactly BERTH_CLEARANCE_M fore of the collar plane at
    // every class by the seat rule) and the existing timeout berths it at the
    // extended standoff — a tandem hold on the axis, honestly announced.
    // Exemption (as today): a berthing net's OWN catch is never its own
    // obstacle — it is the thing coming in.
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
        // Cargo centre in the corridor frame: q⁻¹·(pin − collarWorld), in
        // metres, origin at the berth anchor.
        _v3d.copy(sp).sub(collarWorld).applyQuaternion(_q0);
        if (testLocal(_v3d.x / M_NET, _v3d.y / M_NET, _v3d.z / M_NET)) return false;
      }
    }

    // ── 3. Radiators and tip bags (big-catch-home D2) — a READ of the ship keep-out ──
    // The analytic r + BERTH_CLEARANCE_M cylinder would hold EVERY catch whenever the radiators are closed (their tips
    // sit inside it at 2-13°, yet the real catch clears them by 0.085 m or more), so the radiators and the bags on the
    // tips are read as exact triangles / spheres instead: the catch is a capsule of radius sizeMeter/2 on the collar
    // axis, from its CURRENT distance from the anchor down to its home distance, and any radiator part or tip bag
    // closer than CLEARANCE_M holds the reel (the existing hold/timeout then handles it; no radiator command, §3.1).
    // A home found earlier is not refreshed (D3): radiators that moved since reel entry foul it and are caught HERE.
    // No keep-out (mock armManagers with only `arms`) -> this read passes, byte-identical to before.
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
   * @private Register item 66 — the level (metres from the berth anchor) at
   * which THIS net's corridor gate must hold so its catch clears the queue
   * already at the station; 0 when no other mother net holds a position
   * there. Reads the shared `motherNetForeExtentM` (register item 74 — ONE
   * fore-extent computation for both queue consumers: the two refinements
   * the queue stack needs, now shared with the lasso pend):
   *   - members are nets HOLDING a station position: a corridor-held REELING
   *     net (its frozen `_corridorHoldLevelM` slot — the REELING guard keeps
   *     a stale hold flag from a MISSED net from counting) or a berthed/
   *     collared/transferring net (its berth standoff, extended-standoff
   *     honest via `_effectiveStandoffM`). An inbound net not yet at its gate
   *     is not a member — it takes its slot when its own gate engages (the
   *     hold latch makes the order first-come, inner-most), and a timed-out
   *     member reads the same level on both branches, so a held→berthed
   *     transition never moves the queue.
   *   - the returned level seats THIS catch's near face one
   *     BERTH_CLEARANCE_M past the deepest member's far face
   *     (near = level + _catchSeatM − sizeMeter/2), so two queued catches
   *     can never freeze at the same level and co-locate (co-located reads
   *     as one — a continuity-law cosmetic violation).
   * The timeout's `extended` derives from this holdM, so a queue-raised
   * hold berths at its queue-cleared level. 0 with an empty queue ⇒ the
   * gate's CORRIDOR_HOLD_M floor is byte-identical to the pre-66 code.
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
    // near face = level + seat − half ≥ ext + clearance.
    // l8-reel-collar: the seat at the hold is between the captured depth and the home seat; the HOME seat is the
    // smallest, so the level it gives is the conservative (largest) one.
    const seat = this._homeSeatM ?? this._catchSeatM ?? 0;
    const halfSelf = (d.sizeMeter || 2) / 2;
    return ext + (CN.BERTH_CLEARANCE_M ?? 1.0) + halfSelf - seat;
  }

  /**
   * Mother BERTHED per-frame hold (driven by CaptureNetSystem.update — the
   * projectile's own switch no-ops on BERTHED). Freezes the reel formula at
   * the standoff: same code path, same pin API, same ship-relative frame.
   * @param {number} dt
   * @returns {boolean} false when the berth should tear down (dead target)
   */
  updateBerthHold(dt) {
    const d = this.targetDebris;
    const player = this._ctx?.player;
    const debrisField = this._ctx?.debrisField;
    if (!d || !player || !debrisField) return false;
    // §4.19: the berth-hold alive guard is what cleans up a mission transition
    // (a BERTHED net survives getState holding a debris ref that no longer
    // exists). NOT optional polish.
    if (d.alive === false) return false;

    const M_NET = Constants.SCENE_UNITS_PER_METER;
    // Respect the corridor-timeout extended standoff (Phase C-lite): a berth
    // forced out to CORRIDOR_EXTENDED_STANDOFF_M must HOLD there — recomputing
    // the base standoff here would slide the catch inward at the berth.
    // S13(c): this IS the collar seat. S13(e): the seat is referenced to the
    // COLLAR anchor (the ring plane z = 1.30, ON the axis; the launcher muzzle
    // is 30 mm behind it since 2026-10-13) — cargo centre at collar + fwd ×
    // (sizeMeter/2 + BERTH_CLEARANCE_M 1.0) is exactly "cargo surface at the
    // ring, centre at ring-z + size/2 + clearance" — the seat the rigid
    // complete-berth mate holds (no pendulum from COLLARED on, see below).
    // l8-reel-collar: HOME — the bag's mouth at the ring, the catch seated on the collar axis
    // (CN.REEL_HOME). A corridor-timeout berth still holds at its extended standoff.
    if (this._homeSeatM == null) this._seedReelHome(d, player);
    const baseStandoffM = this._homeApexM;
    const berthStandoffM = Math.max(baseStandoffM, this._effectiveStandoffM ?? baseStandoffM);
    this._remainingM = berthStandoffM;

    this._settleFwdLagged(player, dt);

    // Phase D.7 (b) — berthed pendulum: the bundle swings on a critically
    // damped spring (~0.5 Hz, decays ~5 s), re-excited by RCS translation.
    // The swing is an angular offset off the lagged-forward axis, applied as a
    // small lateral displacement at the standoff distance. Semi-implicit
    // (dt-robust at 30/120 fps). Phase D.8 (§11.8): garnish — dropped at LOW
    // tier (the berth hold itself is structure and stays).
    // S13(c): the pendulum applies through BERTHED only — a tethered berth
    // swings; a collar mate is RIGID and does not (the BERTHED→COLLARED
    // transition zeroes _pendulumAngle/_pendulumVel). In COLLARED the residual
    // _lateral simply decays to the boresight (the guide cone re-centres the
    // body over ~½ s — no snap, no pop).
    const collared = this.state === STATES.COLLARED;
    if (CN.BERTH_PENDULUM_ENABLED !== false && !collared) {
      const pOmega = 2 * Math.PI * (CN.BERTH_PENDULUM_FREQ_HZ ?? 0.5);
      const pZeta = 1.0;
      const pK = pOmega * pOmega, pC = 2 * pZeta * pOmega;
      // RCS re-excite: translation velocity kicks the pendulum. _rcsVelocity is
      // in scene-units/s; convert to m/s (÷ M_NET) so the coefficient reads in
      // rad-per-metre and matches how the rest of this file reasons in metres.
      // Scaled by dt like every other term in this integrator: the excitation is
      // applied EVERY frame the RCS velocity is non-zero (thrust plus its
      // RCS_DAMPING tail), so an unscaled kick made the swing framerate-dependent
      // (~2.1× at 120 fps vs 60 fps) AND saturated BERTH_PENDULUM_MAX_RAD after
      // ~0.3 s of held thrust, turning the damped swing into a hard clamp.
      // With dt, the total kick over a burst is ∫v·dt = the RCS displacement in
      // metres, so the coefficient is rad/s of swing per metre of drift.
      if (player._rcsVelocity) {
        const rcsMps = player._rcsVelocity.length() / M_NET;
        this._pendulumVel += rcsMps * dt * (CN.BERTH_PENDULUM_RCS_EXCITE ?? 0.6);
      }
      // Spring toward 0 (the boresight), capped.
      const pAccel = -pK * this._pendulumAngle - pC * this._pendulumVel;
      this._pendulumVel += pAccel * dt;
      this._pendulumAngle += this._pendulumVel * dt;
      const pMax = CN.BERTH_PENDULUM_MAX_RAD ?? 0.06;
      if (Math.abs(this._pendulumAngle) > pMax) {
        this._pendulumAngle = Math.sign(this._pendulumAngle) * pMax;
        this._pendulumVel = 0;
      }
      // Apply the swing as a lateral offset at the standoff distance.
      if (Math.abs(this._pendulumAngle) > 1e-9) {
        // Swing direction: perpendicular to fwd, in the ship's local XZ plane
        // (a yaw swing — reads as the bundle swaying side-to-side on the line).
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
    // The seat and the bag axis were fixed by the last reel tick (`_applySeatLaw`); the hold only reads them — the
    // seat is NOT re-derived here, so the nose reel (a fallback for a catch parked deeper than the line reaches)
    // can still shrink `_catchSeatM`. At HOME the bag axis follows the ship axis (the mouth is on the ring).
    const seatP = this._seatProgress(berthStandoffM);
    if (seatP >= 1 && this.launchDirection && this._fwdLagged) {
      this.launchDirection.x = this._fwdLagged.x; this.launchDirection.y = this._fwdLagged.y; this.launchDirection.z = this._fwdLagged.z;
    }
    _v3d.copy(anchorWorld)
      .addScaledVector(this._fwdLagged, berthStandoffM * M_NET)
      .addScaledVector(this._lateral, 1 - seatP);

    // net.position = the bag's apex anchor (the tether end), written BEFORE
    // the seat offset — same split as _updateMotherReel, so the catch stays
    // seated INSIDE the bag through the berth hold instead of riding the apex.
    this.position.x = _v3d.x / M_NET;
    this.position.y = _v3d.y / M_NET;
    this.position.z = _v3d.z / M_NET;
    if (this._catchSeatM) _v3d.addScaledVector(this.launchDirection, this._catchSeatM * M_NET);
    this._reelDistM = Math.hypot(_v3d.x - anchorWorld.x, _v3d.y - anchorWorld.y, _v3d.z - anchorWorld.z) / M_NET;

    // Phase D.7 (a) — tumble carryover (shared helper — V7, same as the reel path).
    this._applyCatchOrientation(d, player, dt);

    d._armPinned = true;
    d._captured = true;
    // S3 orbit continuity: the mother hold owns this position from berth entry
    // on — freeze the catch's own orbit propagation (DebrisField skips only
    // _onboardingPinned otherwise) so a later jettison re-seats from the pin
    // instead of snapping to an orbit that kept drifting during the hold.
    d._motherParked = true;
    d._catchRenderMin = this._catchFloorScale(d, dt);   // item 15: ramp continues; never restarts at berth
    debrisField.pinCapturedDebris(d, _v3d);
    if (this._noseAdopted) {
      // u20-nose fix 2: the ship pose this pin was made against. The pin is written at the END of a frame (captureNetSystem.update runs after
      // armManager.update, js/main.js ~:7302 / ~:7323) and the daughter's tug check reads it at the START of the next, after player.update has
      // moved the ship (about 2.6 km a frame at the game clock): read against the live pose the catch was always "2.6 km off its seat".
      (this._holdShipPos ||= new THREE.Vector3()).copy(player.position);
      (this._holdShipQuat ||= new THREE.Quaternion()).copy(player.quaternion);
      this._holdSeq = this._ctx?.captureNetSystem?._frameSeq ?? 0;
    }
    return true;
  }

  /**
   * u20-nose fix 2: the ship pose (position, attitude) the catch's last pin was made against, for a daughter's tug check to read
   * `target._scenePosition` in the frame it was pinned in. null when this net did not pin in the system's latest update (its hold
   * stopped running): the check then counts the hand-over as not held, as it would for a catch that is left behind.
   * @returns {{pos:THREE.Vector3, quat:THREE.Quaternion}|null}
   */
  lastPinFrame() {
    if (!this._holdShipPos || !this._holdShipQuat) return null;
    const sys = this._ctx?.captureNetSystem;
    if (sys && this._holdSeq !== sys._frameSeq) return null;
    return { pos: this._holdShipPos, quat: this._holdShipQuat };
  }

  /**
   * @private C1: the reel/berth rotation-lag spring, hoisted from two identical
   * inline sites (_updateMotherReel + updateBerthHold). Runs the ship forward
   * through a critically damped spring (~0.8 Hz settle) so a mid-reel slew lags
   * and settles instead of whipping the catch, and decays the lateral offset
   * toward the boresight as the bundle reels in. Writes _fwdLagged + _lateral.
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
    // Lateral decay (catch swings onto the boresight as it reels in).
    this._lateral.multiplyScalar(Math.max(0, 1 - 2.0 * dt));
  }

  /**
   * @private Shared reel/berth orientation: ship-rigid attitude (plan §1.2)
   * PLUS the Phase D.7 (a) tumble carryover — a small extra pitch term on top
   * of the ship-rigid attitude, decaying over TUMBLE_CARRYOVER_DECAY_S. The
   * two share the orientation channel (tumbleAxis/tumbleAngle), so the
   * carryover is composed as an additional rotation about the ship-local X
   * (pitch) axis — the same axis the tug's angular kick uses.
   *
   * V7: the residual spin is now ACCUMULATED — `_tumbleCarryAngle` integrates
   * `_tumbleCarryover × dt` (mod 2π), mirroring how `_pendulumAngle` /
   * `_pendulumVel` already integrate, so the catch visibly spins down in the
   * bag. The pre-V7 twin sites applied one frame's increment to a freshly
   * rebuilt quaternion each frame, so it never accumulated: a sub-degree
   * offset that decayed to nothing. Hoisted into one helper so the two call
   * sites cannot drift apart again. The accumulated angle outlives the rate on
   * purpose — see the in-body note.
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
      // …but KEEP APPLYING the accumulated angle after it dies. The rate and the
      // angle are separate quantities: the rate decaying to zero means the catch
      // has finished spinning down, not that it teleports back to its
      // pre-tumble attitude. Both used to sit behind the same `> 1e-6` gate,
      // which was harmless pre-V7 (the angle was one frame's sub-degree
      // increment) but became a one-frame snap of up to ∫0.6·e^(−t/5)dt = 3 rad
      // ≈ 172° once V7 made the accumulation real. Reachable on any catch held
      // past ~66 s (corridor timeout / a long berth hold).
      if (this._tumbleCarryAngle !== 0) {
        _q1.setFromAxisAngle(_v3e.set(1, 0, 0), this._tumbleCarryAngle);
        _q0.multiply(_q1);
      }
    }
    const w = Math.max(-1, Math.min(1, _q0.w));
    const angle = 2 * Math.acos(w);
    const s = Math.sqrt(Math.max(0, 1 - w * w));
    if (s > 1e-6) d.tumbleAxis.set(_q0.x / s, _q0.y / s, _q0.z / s);
    else d.tumbleAxis.set(0, 1, 0);
    d.tumbleAngle = angle;
    // c1-catch-pose (D7 finding): `d` is a snapshot in the real game; the drawn
    // object is the field's canonical one. Put the pair there too, or the nose
    // hold's attitude never reaches the screen (measured: 78° of an 86° ship
    // turn went unfollowed in BERTHED on the shipped build).
    mirrorCatchAttitude(d, this._ctx?.debrisField);
  }

  // ── Catch resolution ───────────────────────────────────────────────────

  /** @private Roll cling probability and resolve capture */
  _resolveCatch() {
    // Dead-target guard (mother-net-reel plan §7.7): the body may have been
    // removed (fragmented by another interaction, deorbited) while the net
    // was wrapping. Never award a catch against a dead reference.
    if (this.targetDebris && this.targetDebris.alive === false) {
      this._miss('target_lost');
      return;
    }

    // Phase 2 (ASPECT_CAPTURE): presented width at CONTACT — the moment the
    // mouth meets the body decides whether it can swallow it. Broadside on an
    // oversize presentation is a deterministic bounce, not a bad roll. The
    // verdict routes through the ONE mouth-fit predicate (register item 21a).
    if (Constants.isFeatureEnabled('ASPECT_CAPTURE') && this.targetDebris) {
      this._presentedWidthM = presentedWidthForApproach(this.targetDebris, this.launchDirection);
      if (!fitsMouth(this.targetDebris, this.netClass, this.launchDirection, this._presentedWidthM)) {
        this._miss('oversize_aspect');
        return;
      }
    }

    // Determine P_base from capture mode
    const pBase = this.captureMode === MODES.CINCH
      ? CN.CINCH_P_BASE.RIGHT_HARDER   // 0.93 — default for cinch
      : CN.SLAM_P_BASE.RIGHT_HARDER;   // 0.80 — default for slam

    const params = {
      pBase,
      vRel:            this.speed,
      vOptimal:        this.netClass.LAUNCH_SPEED,
      range:           this.distanceTraveled,
      // §11.7 decision (2026-08-27): NEUTRALIZED — resolve-time spin never
      // reads above design. Derivation: raw spinRate/SPIN_HZ exceeds 1 only
      // inside the launch transient (CAST_WINDUP 0.15 s + SPIN_UP_TIME 0.5 s
      // = the first 0.65 s), where the folded canister despins from
      // SPIN_HZ × SPIN_FOLDED_MULT (3×) down to 1×; an unclamped fraction up
      // to 3.0 would ride computeClingProbability's f_spin ceiling
      // (min(1.2, ·)) into a hidden +20% cling bonus for point-blank shots.
      // That window is UNREACHABLE in the live FSM — contact checks exist
      // only in FLIGHT and _updateSpinningUp exits with spinRate === SPIN_HZ
      // exactly — so this clamp changes no reachable path; it pins the
      // boundary against future FSM edits (e.g. letting point-blank contact
      // interrupt SPINNING_UP). Neutralized rather than kept-as-reward
      // because (a) §12.2 already prices ≤ 25 m as sure-shot ≥ 0.80 — the
      // close-range reward exists and is documented; (b) the 3× transient is
      // an animation-legibility artifact (§11.6), not a catch-quality claim;
      // (c) ToolOdds.estimateSpinFractionAtContact is ∈ [0, 1] by contract,
      // so the HUD could never show the bonus — an "honest numbers" breach.
      // Sub-1 in-flight decay penalties are untouched. Pinned in
      // test-CaptureNet-Bookkeeping.js so retunes re-derive consciously.
      spinFraction:    Math.min(this.spinRate / this.netClass.SPIN_HZ, 1.0),
      tensionFraction: 1.0,
      contactFraction: 1.0,
      roughness:       this.targetDebris?.surfaceRoughness || 1.0,
      // CP-2: a high-tumble target sheds the net — detumble it first (mother laser).
      targetTumbleRate: Constants.isFeatureEnabled('LASER_DESPIN')
        ? (this.targetDebris?.tumbleRate ?? null)
        : null,
    };

    this._clingProbability = computeClingProbability(params);
    this._clingRoll = Math.random();

    // Phase 3b (capture-feedback overhaul): the frag risk is now ROLLED, not
    // just computed. The consequence chain was already built — handleFragmentation
    // (mercy rule) → NET_FRAGMENTATION; INTERACTION_FRAGMENTATION → KesslerSystem
    // counts it and DebrisField sheds/replaces the body.
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
   * Phase B §9.8–9.10 — the line-taut tug (mother path only).
   *
   * At CAPTURED the tether snaps straight: the whale's residual momentum
   * relative to the Mother transfers through the net. Honest ratio up to
   * 177:1 (23 t vs 130 kg), so the NET_TUG_MAX_DV_MS cap does nearly all the
   * work. Three coupled effects:
   *
   *   1. Spring soft-capture (the shock absorber, §9.8): the feel component is
   *      spread over NET_TUG_WINDOW_S into _rcsVelocity by the windowed
   *      delivery in CaptureNetSystem.update — Σ(step/window) === 1 exactly at
   *      any frame rate, so the delivered impulse is dt-robust. The residual
   *      decay is RCS_DAMPING's inherited per-frame behaviour (shared with
   *      manual RCS, deliberately out of scope). Feel-only; never mutates the
   *      orbit. NET_TUG_FEEL_MULT scales the share so the ~2× transient (same
   *      magnitude drives orbit + _rcsVelocity) is deliberate, not accidental.
   *   2. Kept orbit impulse (one-shot, NOT spread): the capped Δv goes through
   *      applyCartesianImpulse with { noBill: true } — passive momentum
   *      transfer bills no fuel/battery and ignores the power gates. The kept
   *      Δv is a genuine ΔV-economy event (comms'd, cancellable with RCS, NOT
   *      auto-nulled — keep-or-cancel by design). A false return means the
   *      altitude-envelope guard refused it: comms must say so honestly
   *      ("tug damped — envelope limit") rather than claiming kept Δv.
   *   3. Angular kick: τ_x = r_y·F_z — the ROW_DZ muzzle lever (±6 cm in ship
   *      Y) × the AXIAL tug, the single term _applyMotherNetRecoil models.
   *      Signed so a forward pull pitches opposite to an aft recoil at the
   *      same muzzle. RCS springs it back (~2 s, ζ=1); attitude hold survives.
   *
   * relVel derivation: the catch's orbital velocity (orbitToSceneCartesianInto
   * on its own elements — it keeps propagating while pinned) minus the
   * Mother's getVelocity(). This is the same quantity the pre-fire drift
   * refusal measures via its EMA, but sampled exactly once at the taut moment.
   *
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

    // A tease-pinned catch rides the mother's frame: orbit propagation is
    // SKIPPED while _onboardingPinned (DebrisField update loop), so the
    // elements below carry a velocity stale by the whole pin duration —
    // measured ~1.2 km/s phantom relative velocity after a ~95 s pin
    // (2026-08-02 P1 probe), which capped dvMag and armed a full-scale camera
    // shake for a catch that was, physically, co-moving with the ship. The
    // honest relative velocity of a piece held in the mother's frame is ~0,
    // and a zero-relative-velocity catch yanks nothing (same early return as
    // the matched-velocity case below).
    if (d._onboardingPinned) return;

    // Catch orbital velocity (km/s) at its current elements.
    orbitToSceneCartesianInto(d.orbit, _tugScratchPos, _tugScratchVel);
    const shipV = player.getVelocity();
    // Relative velocity catch − ship, converted km/s → m/s.
    const rvx = (_tugScratchVel.x - shipV.x) * 1000;
    const rvy = (_tugScratchVel.y - shipV.y) * 1000;
    const rvz = (_tugScratchVel.z - shipV.z) * 1000;
    const relSpeed = Math.sqrt(rvx * rvx + rvy * rvy + rvz * rvz);
    if (relSpeed < 1e-3) return;   // matched velocity → no tug (zero-relVel case)

    // Momentum the catch carries relative to the ship, shared by mass ratio,
    // capped. m_catch·v_rel is the full momentum; the ship's share of the
    // velocity change is m_catch/(m_catch + m_ship) of v_rel.
    const mCatch = d.mass || this.capturedMass || 1;
    const mShip = player.mass || 130;
    const share = mCatch / (mCatch + mShip);
    const cap = CN.NET_TUG_MAX_DV_MS ?? 0.5;
    const dvMag = Math.min(relSpeed * share, cap);

    // Direction the ship gets PULLED: toward the catch's relative motion
    // (the tether drags the Mother after the whale).
    const inv = 1 / relSpeed;
    const dvWorld = _v3e.set(rvx * inv, rvy * inv, rvz * inv).multiplyScalar(dvMag);

    // Minor 5 (review): snapshot everything needed AFTER the impulse call into
    // plain locals BEFORE it. applyCartesianImpulse synchronously emits
    // COMMS_MESSAGE / THRUST_VISUAL / RESOURCE_CONSUME, and a future listener
    // re-entering CaptureNet would clobber the module scratch (_v3e/_v3b/_q0)
    // the comms dirTag and the angular kick are computed from.
    let localTugX = 0, localTugY = 0, localTugZ = 0;
    if (player.quaternion) {
      _q0.copy(player.quaternion).invert();
      _v3b.copy(dvWorld).applyQuaternion(_q0);   // tug dir in ship frame (m/s)
      localTugX = _v3b.x; localTugY = _v3b.y; localTugZ = _v3b.z;
    }

    // (2) Kept orbit impulse — one-shot, no billing, envelope guard surfaced.
    const applied = player.applyCartesianImpulse(dvWorld, 0, { noBill: true });

    // (1) Spring soft-capture (§9.8): seed the windowed delivery. The feel
    // vector is stored on the net and fed into _rcsVelocity over
    // NET_TUG_WINDOW_S by CaptureNetSystem.update — Σ(step/window) === 1
    // exactly at any frame rate. M = 1e-5 scene-units-per-metre.
    const windowS = CN.NET_TUG_WINDOW_S ?? 0.65;
    const feelMult = CN.NET_TUG_FEEL_MULT ?? 1.0;
    if (player._rcsVelocity && feelMult > 0 && windowS > 0) {
      if (!this._tugFeelScene) this._tugFeelScene = new THREE.Vector3();
      this._tugFeelScene.copy(dvWorld).multiplyScalar(1e-5 * feelMult);
      this._tugElapsed = 0;
    }

    // (3) Angular kick: τ_x = r_y·F_z — the ROW_DZ lever × the AXIAL tug
    // (review item 1: the previous |F_y| term zeroed the pitch for a
    // boresight tug — the dominant case — and mis-levered the lateral one).
    if (player.quaternion && typeof player.mass === 'number') {
      const muzzles = player._netPodMuzzles;
      const muzzle = muzzles && muzzles[this.podIndex];
      const muzzleLocalY = muzzle ? muzzle.position.y : 0;
      if (Math.abs(muzzleLocalY) > 1e-9) {
        // Angular impulse ∝ linear momentum transferred × lever / I. Reuse
        // the recoil shape: I = m·0.25; momentum = m_ship·dv (N·s).
        const I = mShip * 0.25;
        const leverM = Math.abs(muzzleLocalY) / 1e-5;   // scene units → metres
        const j = mShip * dvMag;                        // N·s (kg·m/s)
        const pitchSign = muzzleLocalY >= 0 ? -1 : 1;
        // Signed axial component: −Z (aft, the recoil case) → +1 so the
        // expression reduces exactly to _applyMotherNetRecoil; +Z (forward
        // pull) → −1. Clamped to ±1.
        const axial = Math.max(-1, Math.min(1, -localTugZ / Math.max(1e-9, dvMag)));
        player._recoilPitchVel += pitchSign * (j * leverM / I) * axial;
      }
    }

    // Comms — magnitude + direction, or the honest envelope refusal.
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

    // Camera micro-shake payload (CameraSystem listens, whale-only, scaled by
    // imparted Δv, skipped under prefers-reduced-motion — §9.11).
    eventBus.emit(Events.NET_MOTHER_TUG, {
      podIndex: this.podIndex,
      dvMs: applied ? dvMag : 0,
      windowS,
    });
  }

  /** @private Transition to CAPTURED + emit event */
  /**
   * u20-nets (2026-10-23, DECISIONS §38 row 5): a DAUGHTER's net that closed on its target keeps every other catchable piece
   * inside its mouth too, in ONE bag (`DebrisField.mergeIntoBag`). Members, mouth volume, fit and bag size: `scoopRule.js`.
   * One piece in the mouth: nothing changes (the same piece stays held). The mother's net never scoops. Called once, as the
   * catch is confirmed, before the mass and the events read `targetDebris`: from here on the net, the daughter and every
   * system downstream hold the bag.
   * @private
   * @returns {object|null} the bag, or null when nothing was scooped
   */
  _scoopIntoBag() {
    if (this._scooped || this._isMother || !(this.armIndex >= 0)) return null;
    const target = this.targetDebris;
    // a daughter's net carries no `_ctx` (only the mother's do): the system's own field handle, as `canonicalOf` reads it
    const field = (this._ctx && this._ctx.debrisField) || (captureNetSystem && captureNetSystem._debrisField) || null;
    if (!target || target.isBag === true || !field || typeof field.mergeIntoBag !== 'function'
        || !Array.isArray(field.debrisList)) return null;
    const arm = this._sourceArm || null;
    const rated = (arm && arm._netRatedMass > 0) ? arm._netRatedMass : (this.netClass.MAX_CAPTURE_MASS || Infinity);
    // The net may hold a snapshot of its target (`canonicalOf`): the members must be the field's own objects.
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

  _captureSuccess() {
    this._scoopIntoBag();
    this.catchResult = 'success';
    this.capturedMass = this.targetDebris?.mass || 1.0;
    this.tangleQuality = this._clingProbability;
    this._transitionTo(STATES.CAPTURED);

    // Phase B §9 — the line-taut tug. The tether just snapped straight on a
    // whale with residual relative velocity: the catch yanks the Mother.
    // Runs BEFORE the event emits so the tug's comms/camera payloads read as
    // part of the capture beat. Mother path only (the daughter's arm absorbs
    // its own catch momentum).
    if (this._isMother) this._applyCaptureTug();

    eventBus.emit(Events.NET_CATCH_SUCCESS, {
      armIndex:      this.armIndex,
      podIndex:      this.podIndex,
      debrisId:      this.targetDebris?.id,
      tangleQuality: this.tangleQuality,
      capturedMass:  this.capturedMass,
      mode:          this.captureMode,
    });

    // Q2 Ceremony: emit ceremony complete
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
    // S5 failure staging: a staged reason (bounce/slip) holds MISSED for
    // FAILURE_STAGING_S in the system's auto-reel below, so the visual beat
    // plays at the contact point before the empty reel-back. Unstaged
    // reasons keep the same-tick auto-reel.
    this._failureKind = missFailureKind(reason);
    // Review fix (strain-slip lifecycle): a miss can fire AFTER the net already
    // passed CAPTURED→REELING (the mother strain roll at reel entry), which
    // set _resultProcessed in CaptureNetSystem.update(). Without resetting it,
    // needsAutoReel never re-arms and the net strands in MISSED forever —
    // never pruned, inventory never restored, pins never cleared.
    this._resultProcessed = false;

    eventBus.emit(Events.NET_CATCH_MISS, {
      armIndex:    this.armIndex,
      podIndex:    this.podIndex,
      debrisId:    this.targetDebris?.id,
      probability: this._clingProbability,
      reason,
    });

    // Q2 Ceremony: emit ceremony complete
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

  // ── Player Commands ────────────────────────────────────────────────────

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
   * Release / abort: let debris and net go. Net inventory is consumed.
   * BERTHED/COLLARED is the manual jettison ([K]) — clears pins, re-seats the
   * orbit, frees the launcher. The securing timer (if still running) is
   * cancelled; a COLLARED catch was already credited (that score is not revoked).
   * @returns {boolean} Whether release occurred
   */
  release() {
    if (this.state !== STATES.CAPTURED &&
        this.state !== STATES.REELING &&
        this.state !== STATES.FLIGHT &&
        this.state !== STATES.BERTHED &&
        this.state !== STATES.COLLARED) return false;

    const wasBerthed = this.state === STATES.BERTHED || this.state === STATES.COLLARED;
    // S13(c): a mid-cook jettison — the collar's chop was running when the body
    // left. Stop the breakdown beat honestly: the unflown chunks + the ghost
    // bag dispose WITHOUT the draw-in (the body left the furnace, not into it);
    // chunks already committed keep flying to the bus. The half-cooked piece
    // keeps its _digestProgress — the invested cook is conserved.
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
      // The jettisoned mass just LEFT the berthed ledger (capturedMass zeroed
      // above; RELEASED drops out of getBerthedMassKg). NET_RELEASED's
      // listeners (autopilot hold, visual, audio) never invalidate the
      // attitude inertia, so invalidate the cache directly — the item-63 seam
      // for a mass-exit that crosses no arm-state change (register item 67(a)).
      const player = this._ctx?.player;
      if (player && '_attitudeInertia' in player) player._attitudeInertia = null;
      // §4.9: jettison consumes the net — say so.
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Catch released — net expended, launcher clear.',
        source: 'HOUSTON', priority: 'info',
      });
    }
    return true;
  }

  /**
   * Force the net into a deterministic result (for testing / scripted events).
   * Bypasses the random roll.
   *
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

    // Mother Large Net launcher inventory: one entry per launcher
    // (MOTHER_POD_COUNT = 1 since 2026-10-13, so a one-element array [count];
    // it was [podA_count, podB_count] for the two ±0.45 m pods).
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

    /** @type {object|null} Injected deps (player, debrisField) — stored by
     *  init(deps) BEFORE the feature-flag check so a flag-off init still
     *  leaves the references usable when the flag flips on later. */
    this._player = null;
    this._debrisField = null;
    /** @type {object|null} Optional AudioSystem ref for the winch pitch
     *  (Phase B §9.3). Injected via init(deps.audioSystem); optional-chained
     *  so headless tests and the no-audio path stay silent. */
    this._audioSystem = null;
    /** @type {object|null} Optional ArmManager + LassoSystem refs for the
     *  Phase C-lite recovery-corridor test (strut tips, held daughter
     *  catches, lasso cargo cells). Absent ⇒ corridor vacuously clear. */
    this._armManager = null;
    this._lassoSystem = null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Initialise inventory to Dyneema Y0 defaults.
   * Called once at game start / after load.
   * @param {object} [deps] — { player, debrisField, audioSystem, armManager,
   *   lassoSystem } context references. `player` backs the mother-pod anchor
   *   provider; `debrisField` backs the Phase-A pin API (pinCapturedDebris);
   *   `audioSystem` backs the Phase-B winch pitch; `armManager`/`lassoSystem`
   *   back the Phase C-lite recovery-corridor test. Optional — the no-arg
   *   call stays valid for headless tests and test-main-wiring.
   */
  init(deps = {}) {
    this._player = deps.player || this._player || null;
    this._debrisField = deps.debrisField || this._debrisField || null;
    this._audioSystem = deps.audioSystem || this._audioSystem || null;
    this._armManager = deps.armManager || this._armManager || null;
    this._lassoSystem = deps.lassoSystem || this._lassoSystem || null;
    // followups-1018 D3: room appearing (a tip slot or a rack cell freeing, both emit NET_CONSUMED synchronously)
    // re-arms a declined collar catch in the same tick. Re-subscribed on every init so a cleared bus cannot orphan it.
    if (this._unsubNetConsumed) this._unsubNetConsumed();
    this._unsubNetConsumed = eventBus.on(Events.NET_CONSUMED, (p) => this._onRoomFreed(p));
    // DECISIONS §33 (2026-10-20): a new game, or a restart after game over, gives the mother her 4 nets back.
    // GameFlowManager.resetGame emits GAME_RESET; reset() is NOT used here (it zeroes the count and has no caller).
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

    // Tick active nets
    // Daughter-net audio fix (2026-08-27): the flight-whistle state poll
    // (review item 3) is hoisted OUT of the mother-only block — the whistle
    // means "a net projectile is in flight" for EITHER launcher family now
    // that daughter fires start it too (at daughter gain). AudioSystem keeps
    // ONE whistle instance, so the stop must be "no active net is in a
    // flight state", not "this net left flight": a berthed mother net
    // parked at the collar would otherwise kill a flying daughter's whistle
    // every frame (and pod A's berthed cargo would kill pod B's whistle).
    let anyNetInFlight = false;
    for (let i = this.activeNets.length - 1; i >= 0; i--) {
      const net = this.activeNets[i];
      const prevState = net.state;

      net.update(dt);

      // Auto-start reel on capture/miss — detects both in-loop transitions
      // AND external state changes (e.g. forceResolve called between updates)
      const needsAutoReel = (net.state === STATES.CAPTURED || net.state === STATES.MISSED)
        && !net._resultProcessed
        // S5 failure staging: a staged miss holds at the contact point for
        // FAILURE_STAGING_S so the bounce/slip beat plays before the empty
        // reel-back (the visual runs on the same wall-clock dt). The player
        // can still startReel() manually to cut the beat short.
        && !(net.state === STATES.MISSED && net._failureKind
             && net.stateTimer < (CN.FAILURE_STAGING_S ?? 0));
      if (needsAutoReel) {
        net._resultProcessed = true;
        const cooldown = net.catchResult === 'success'
          ? CN.COOLDOWN_CATCH
          : CN.COOLDOWN_MISS;
        const key = net.armIndex >= 0 ? `arm_${net.armIndex}` : `pod_${net.podIndex}`;
        this._cooldownTimers.set(key, cooldown);

        // Daughter captures are hauled home by the ArmUnit, not reeled by the
        // net itself. Hold the net's reel (bag stays cinched on the debris) so
        // the netted catch doesn't visually vanish mid-haul; _updateReeling
        // auto-releases the hold once the daughter delivers (debris unpinned).
        // Mother-pod captures (podIndex≥0) and misses reel/stow normally.
        if (net.armIndex >= 0 && net.catchResult === 'success') {
          net._heldByArm = true;
        }

        // Auto-start reel (player can still release / override)
        net.startReel();
      }

      // Review item 3 (both families): the flight whistle means "projectile
      // in flight" — record whether THIS net still is; the shared stop runs
      // after the loop when no net is. A state poll, NOT the NET_BRAKE_FIRED
      // hook: that event is gated on FEATURE_FLAGS.NET_CEREMONY, and plan §6
      // forbids routing anything load-bearing through a flag REALITY_MODE
      // forces false. Placed BEFORE any `continue` below so every net is
      // counted every frame.
      if (net.state === STATES.LAUNCHING
          || net.state === STATES.SPINNING_UP
          || net.state === STATES.FLIGHT) {
        anyNetInFlight = true;
      }

      // ── Mother per-frame housekeeping (Phase B) ─────────────────────────
      if (net._isMother) {
        // §9.8 — dt-robust tug delivery. The feel vector seeded at CAPTURED is
        // fed into _rcsVelocity over NET_TUG_WINDOW_S; step is clamped to the
        // remaining window, so Σ(step/window) === 1 exactly at any frame rate.
        // The residual decay is RCS_DAMPING's inherited per-frame behaviour
        // (shared with manual RCS — deliberately out of scope).
        if (net._tugFeelScene && net._tugElapsed < (CN.NET_TUG_WINDOW_S ?? 0.65)) {
          const player = this._player;
          if (player && player._rcsVelocity) {
            const windowS = CN.NET_TUG_WINDOW_S ?? 0.65;
            const step = Math.min(dt, windowS - net._tugElapsed);
            net._tugElapsed += step;
            player._rcsVelocity.addScaledVector(net._tugFeelScene, step / windowS);
            // Minor 6 (review): mirror the manual-RCS clamp
            // (PlayerSatellite.js:5193) — the tug must not stack past
            // RCS_MAX_SPEED on top of existing drift.
            const maxV = Constants.RCS_MAX_SPEED;
            if (maxV > 0 && player._rcsVelocity.length() > maxV) {
              player._rcsVelocity.normalize().multiplyScalar(maxV);
            }
          } else {
            net._tugElapsed = CN.NET_TUG_WINDOW_S ?? 0.65;   // no player: close the window
          }
        }

        // (Review item 3's whistle stop moved to the shared any-net-in-flight
        // poll above/below — the whistle is one instance serving BOTH
        // launcher families now, so a per-net mother stop would clip a
        // flying daughter's whistle and vice versa.)

        // §9.3: drive the winch pitch from the live reel distance.
        // Cheap — one setTargetAtTime on a running loop, no-op otherwise.
        if (net.state === STATES.REELING && net._remainingM != null) {
          this._audioSystem?.updateNetReelPitch?.(net._remainingM, net._reelSeedM);
        }
      }

      // ── Mother BERTHED/COLLARED hold + securing timer (§8 A2 + cargo-continuity S3) ──
      // The projectile's own switch no-ops on both states; the per-frame hold
      // runs here because the system owns the player/debrisField refs. The hold
      // survives pruning (isActive stays true, state never STOWED/RELEASED).
      // S3: the hold keeps running in the terminal state — if the pin ever stops,
      // the catch falls back to the orbit branch and reads as released.
      if (net.state === STATES.BERTHED || net.state === STATES.COLLARED) {
        const holding = net.updateBerthHold(dt);
        if (!holding) {
          // Dead target while docked (§4.19 mission-transition guard): clear
          // the dock, pins and visual, free the launcher. Do NOT stow as if
          // the catch succeeded (the daughter's death-in-hand behaviour).
          this._teardownBerth(net);
          this.activeNets.splice(i, 1);
          continue;
        }
        if (net.state === STATES.BERTHED && !net._berthProcessed && net._berthTimer > 0) {
          net._berthTimer -= dt;
          if (net._berthTimer <= 0) {
            // §19 terminal credit + S13(c) mating: the existing GameFlowManager
            // CATCH_PROCESSED path awards score + salvage + clearDebris() +
            // autosave. { parked: true } skips ONLY the field removal — the
            // body is KEPT, now MATED at the nose berthing collar inside its
            // net (the net IS the container). No teardown, no splice: the hold
            // above keeps pinning the catch every frame.
            net._berthProcessed = true;
            eventBus.emit(Events.CATCH_PROCESSED, {
              debrisId: net.targetDebris?.id,
              armId:    null,
              source:   'mother',
              podIndex: net.podIndex,
              method:   'mother',
              parked:   true,
            });
            // A rigid mate does not swing: the berth pendulum applies through
            // BERTHED only (updateBerthHold) and must not carry energy across
            // the mate. The residual _lateral decays to the boresight inside
            // the hold (the guide cone re-centres the body — no snap).
            net._pendulumAngle = 0;
            net._pendulumVel = 0;
            net._transitionTo(STATES.COLLARED);
            continue;
          }
        }

        // l5c-reach E1: the leash driver is pulling this catch in to the nose (the berth seat shrinks, the hold
        // above keeps pinning it). The hand-off decision, the furnace clock and the retry all wait for it.
        if (net.state === STATES.COLLARED && net._leashNoseReel) continue;

        // ── Cargo hand-off decision (cargo-continuity S7 + the T2 race fix) ──
        // AUTOMATIC by owner ruling: the player holds no information the ship
        // lacks, so there is no keypress. The hand-off is decided on the FIRST
        // COLLARED tick — BEFORE the digestion clock below, because the crane
        // must win the race with the collar furnace: the chop commits at
        // span/(45·sunScale) real seconds after the mate (+1.33 s at 3 kg,
        // +4.43 s at 10 kg in sunlight), so the old DELAY_S 5.0 dwell cooked
        // every 3–11 kg piece at the collar. While the ship cannot stow (every
        // daughter out, every rack full, or the body over the mass gate) the
        // catch stays collared and the refusal comms says so (once — S13(e):
        // it no longer claims the launcher is blocked; firing is only ever
        // refused per-shot by the foul read). Retry is silent.
        // S13(c) routing (the ruling made concrete): the ≤ 2000 kg gate decides
        // collar-vs-tip — a piece under the gate may leave for a strut tip;
        // above it, collar-only until digested or dumped.
        if (net.state === STATES.COLLARED && !net._cargoDeclined) {
          // `continue` on a successful start, mirroring the BERTHED→COLLARED
          // transition above: one state change per tick, so the flight always
          // begins at t=0 on its own frame instead of consuming the trigger
          // frame's (possibly huge) dt in one jump — and the digestion clock
          // below never ticks on an accepted piece (it leaves whole, with
          // _digestProgress 0).
          if (this._tryCargoTransfer(net)) continue;
          // Declined for ANY reason (no armManager, no qualifying carrier,
          // refusal, the furnace guard): record it and fall through — the
          // digest ticks in THIS frame, so a declined path's cook timeline is
          // unchanged.
          net._cargoDeclined = true;
        }

        // ── S13(c): the collar's digestion clock (register item 47) ──────
        // The collared piece cooks on the SAME sun-scaled transit clock the
        // daughter rack runs (the concentrator doesn't care where the crucible
        // is). At completion the beat fires NET_CONSUMED + CATCH_PROCESSED
        // (digested — the mate already paid the credit, GameFlowManager skips
        // it) and the collar frees. A completed digest splices the net in-tick
        // (the same one-state-change-per-tick idiom as the mate above).
        // CUT_AT_NOSE (plan L4): while pieces remain to cut (or one is
        // waiting/flying) the clock is FROZEN — `_breakdownStarted` would
        // close the transfer window and the boss would cook mid-cut. Flag OFF
        // → `_cutActive` is always false → byte-identical.
        if (net.state === STATES.COLLARED
            && !this._cutActive(net) && this._tickCollarDigestion(net, dt)) {
          this.activeNets.splice(i, 1);
          continue;
        }

        // ── Cargo hand-off retry (cargo-continuity S7) ────────────────────
        // After a decline, silently re-offer on the RETRY_S cadence: the
        // scorer allocates (computeCoM), and an unstowable catch can sit
        // collared for minutes — the net path must not allocate per frame
        // (plan §13). The transfer fires by itself the moment a daughter
        // docks or a cell frees.
        if (net.state === STATES.COLLARED && net._cargoDeclined) {
          net._cargoRetryS = (net._cargoRetryS || 0) + dt;
          if (net._cargoRetryS >= (CT.RETRY_S ?? 0.5)) {
            net._cargoRetryS = 0;
            if (this._tryCargoTransfer(net)) continue;
          }
        }

        // ── CUT_AT_NOSE: the cut driver (plan L1/L5/L7) ───────────────────
        // One piece at a time: CUT_S game-seconds per cut (machine time, not
        // sun-scaled), the piece departs only when the crane is free and a
        // daughter qualifies, and the held part is never cut off — the
        // ordinary retry above takes it once the plan is done. No state
        // change here: the boss stays COLLARED; the detached piece rides its
        // own synthetic net (L7).
        if (net.state === STATES.COLLARED && net._cutPlan && FEATURE_FLAGS.CUT_AT_NOSE) {
          this._driveCutAtNose(net, dt);
        }
      }

      // ── Cargo hand-off beat (cargo-continuity S7) ───────────────────────
      // The catch + its bag fly the FurnaceBreakdownVisual chunk arc backwards:
      // nose → strut tip, whole catch, no chunk pool, no scale ramp. The pin is
      // rewritten EVERY frame (a gap reads as a release — S3's lesson) and the
      // net's own position rides the same curve so the bag stays the container.
      // Leash hand-off (lane l5b-wire): a net on its leash is driven by LeashDriver.update
      // (main.js, right after this system) — it pins the catch and moves the net itself.
      if (net.state === STATES.TRANSFERRING && !net._leash) {
        if (this._updateCargoTransfer(net, dt)) {
          this.activeNets.splice(i, 1);      // handed over: the net's job is done
          continue;
        }
      }

      // Remove terminal nets + handle inventory / cargo consequences.
      // BERTHED and COLLARED are deliberately absent — a held net must hit
      // neither the prune predicate nor the STOWED cargo hand-off (§8 A2, S3).
      if (!net.isActive || net.state === STATES.STOWED || net.state === STATES.RELEASED) {
        // Mother exits (miss / release / forceResolve) — clear any pins the
        // reel/berth wrote. Idempotent; most exits fire before any pin exists.
        if (net._isMother) {
          this._clearCatchPins(net.targetDebris);
          // CUT_AT_NOSE: the [K] jettison path never calls _teardownBerth —
          // release a still-waiting cut piece here (same law: cargo is never
          // destroyed; the piece becomes free salvage at its last pin).
          if (net._cutPiece && !net._cutPieceFlying) this._releaseCutPiece(net._cutPiece);
        }

        // DECISIONS §33 row 1 (2026-10-20): a fired net is used up, hit or miss. A missed net cannot be refolded
        // in space, so nothing is restored here (the §3.5 refund of the old reusable-net rule is gone).

        // ST-9.4d: Cargo hand-off — successful capture reeled to platform.
        // Gated OFF for mother catches (§8 A2): the berth + securing timer
        // replaces the daughter's cargo-store path (a mother catch berths, it
        // is never stuffed into a cargo cell it cannot fit).
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

        // Manual jettison from BERTHED ([K]) — re-seat the orbit so the whale
        // resumes from where it was released, not wherever its own orbit
        // propagated to while pinned (§8 A2). Net is expended (no restore).
        if (net.state === STATES.RELEASED && net._isMother) {
          this._reseatOrbitOnRelease(net);
        }

        this.activeNets.splice(i, 1);
      }
    }

    // Review item 3 chokepoint (extended to daughters, 2026-08-27): the
    // whistle survives only while SOME active net is in a flight state.
    // Covers every path with no per-launcher stop event — expiry misses are
    // event-stopped, but this poll is the backstop that makes a leaked
    // daughter (or mother) whistle structurally impossible. No-op when no
    // whistle is running; optional-chained for headless tests without audio.
    if (!anyNetInFlight) this._audioSystem?.stopNetFlightWhistle?.();
  }

  /**
   * Cargo-continuity S7 — try to hand a COLLARED catch to a daughter's cargo rack.
   *
   * Automatic by owner ruling (2026-08-12): no hotkey. `suggestCargoArm` is the
   * single gatekeeper for "may this piece go to a daughter, and which one" — it
   * owns the mass gate, the free-cell rule, the home rule and the
   * last-capture-capable-daughter guard. When it declines, the catch stays at
   * the collar (S3's launcher block is then real information) and the refusal
   * comms fires exactly ONCE per mate; the retry is silent, so the transfer
   * happens by itself the moment a daughter docks or a cell frees. S13(c): the
   * start anchor is the collar seat ({kind:'collar'}).
   *
   * @param {NetProjectile} net — a COLLARED mother net
   * @returns {boolean} true when the beat started
   * @private
   */
  _tryCargoTransfer(net) {
    const M_NET = Constants.SCENE_UNITS_PER_METER;  // 1 m in scene units (file convention: a local per method)
    const d = net.targetDebris;
    const player = this._player;
    const armManager = this._armManager;
    if (!d || !armManager || !Array.isArray(armManager.arms)) return false;

    // CUT_AT_NOSE (plan L3/L5): while a cut plan is under way the boss is
    // MID-CUT — the pieces leave one at a time below, and the boss itself may
    // only take this ordinary path once the plan is done and only the held
    // part remains (it is then ≤ the gate by construction). Silent decline:
    // the plan's own comms already spoke; the cut driver owns the timeline.
    if (this._cutActive(net)) return false;

    // S13(c) pre-commit review: once the collar's furnace has COMMITTED to the
    // piece (the chop START fired), the transfer window is closed — you cannot
    // crane a half-eaten body. Without this guard a late acceptance (racks were
    // full past the hold fraction, or a light piece's short span) would fly a
    // mid-chop/mid-feed body — already shrinking, chunks committed — to the
    // rack: the collar-anchored ghost bag + unflown pool chunks leak forever
    // (NET_CONSUMED for that anchor never comes), the rack fires a SECOND
    // BREAKDOWN_START, and the drawn body rides the crane invisible. Silent
    // decline (not a refusal — no comms): the furnace owns it now; the cook
    // completes at the collar and the mass leaves the ledger exactly once.
    if (net._breakdownStarted) return false;

    // Leash hand-off (lane l5b-wire, DECISIONS §1): a small catch goes to a radiator tip on its
    // own leash. A leash that failed (snag, rejected turn) brought the catch back to the nose:
    // no second try. With FURNACE_COOK on, never the rack either — the nose furnace takes it
    // (coordinator ruling 2026-10-14). With it off (no-melt, DECISIONS §12) nothing at the nose
    // takes it, so a failed hand-off skips the leash block and goes to the daughter rack below —
    // no ship turn, no gas (lane leash-fail-rack). The 0.5 s retry above re-offers it; with no
    // free cell the usual refusal line is said once. It waits (silently) until the hand-off has
    // finished: the net is relatched when the catch is home, but the radiators are still unfolding
    // for ~9 s and the failure line comes at the end (measured: rack flight at 35.0-38.1 s with the
    // radiators folded, "did not work" at 43.9 s). The rack beat starts after the radiators are home.
    let gasShort = false;
    if (net._leashFailed) {
      if (Constants.isFeatureEnabled('FURNACE_COOK')) return false;
      const leashDrv = player && player.leashDriver;
      if (leashDrv && typeof leashDrv.isActive === 'function' && leashDrv.isActive()) return false;
    } else if (FEATURE_FLAGS.LEASH_HANDOFF) {
      const verdict = this._tryLeash(net, d);
      if (verdict === 'started') return true;
      if (verdict === 'declined') return false;
      // gas-low-fail-fast D1/D2: 'rack' because the tank cannot pay for the swing (not because the catch is too big or
      // no tip is free). The line is chosen below, once we know whether a cell is free.
      gasShort = net._gasShort === true;
    }

    const massKg = net.capturedMass || d.mass || 0;
    // CUT_AT_NOSE dust guard: the planner guarantees every piece ≤
    // maxPieceKg×(1+1e-9); a float-dust overhang on the held part (≤1e-6 kg)
    // must not strand it at the gate forever — clamp it to the gate. The
    // ledger effect is below every conservation tolerance.
    const _gate = CT.MAX_KG ?? 2000;
    let gateMassKg = massKg;
    if (net._cutPlan && net._cutNext >= net._cutPlan.pieces.length - 1
        && massKg > _gate && massKg - _gate <= 1e-6) {
      gateMassKg = _gate;
    }
    const booked = this._armsWithCargoOnTheWay();
    const armIndex = suggestCargoArm(armManager, player, gateMassKg, 0, booked, DebrisField.trueReachM(d, d.sizeMeter || 0));   // hold-clear D7: + her reach
    if (armIndex == null) {
      if (!net._cargoRefused) {
        net._cargoRefused = true;
        const overGate = gateMassKg > _gate;
        // CUT_AT_NOSE (plan L1/L2): the over-gate refusal is where the cut
        // planner is called — exactly once, at the receiver's own limit (no
        // new number). Requires a spawn-capable field (a DebrisField without
        // spawnCutPiece — a mock, or a legacy build — keeps today's refusal
        // and the collar ride; a cut plan whose pieces cannot be drawn is
        // worse than no cut plan).
        // Nets step 3 slice 5 (lane 5b, C5): a pending BIG piece is never cut automatically: it stays whole at the collar (only the melt,
        // lane 5e, cuts one), and says so in its own words (no K: K does not let it go).
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
          // gas-low-fail-fast D2: the catch could not go by radiator for want of gas AND no daughter can take it:
          // ONE line that names both and the way out, instead of the usual refusal line. Once per catch (the latch
          // outlives `_cargoRefused`, which a rack flight that is called off re-arms).
          // nets-1b R5: the catch really stays at the nose; this line is the only one (it says no daughter has a cell, and
          // how to let it go), so there is no separate "parked at the nose" line.
          this._sayGasShort(net, 'full');
        } else {
          // nets-1b R5: stays at the nose (no cell, or over the gate with no cut). The reason line below already says
          // where it stays, so it is the only line: no separate "parked at the nose" line, and plain words for the key.
          // no-melt: the furnaces run only on the trip to the next field (trip-melt) - do not promise one now.
          const furnace = Constants.isFeatureEnabled('FURNACE_COOK');
          const fate = furnace
            ? 'It rides the collar until the furnace takes it. Press K to let it go.'
            : 'It stays at the collar and goes to a furnace on the trip to the next field if it fits one. Press K to let it go.';
          // one-catch (owner 2026-10-22): a daughter holds one catch, so "no daughter can take it" has two true reasons: each
          // one is away or already holds a catch, or exactly one is home and empty and stays ready for the next capture.
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

    // gas-low-fail-fast D2: the swing to a radiator was skipped for want of steering gas and a cell is free — say why
    // the catch goes to the rack (it never left the nose, so there is no "did not work" line). Once per catch.
    if (gasShort) this._sayGasShort(net, 'rack');

    // Endpoints, both exact so neither end snaps. START is the catch's LIVE
    // drawn position — `_scenePosition`, what `pinCapturedDebris` wrote last
    // frame (plan correction: NOT the bus centre; the collared catch lives at
    // the berth-hold pin, and the bag apex sits `_catchSeatM` short of it). END
    // is the rack SLOT the piece will occupy, so the arc lands exactly where
    // `_pinHeldCatches` takes over.
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

    // The three control points are born in the world, then also stored in the
    // SHIP's frame: the flight re-derives them from the live ship pose every
    // frame, so the arc rides with the ship instead of staying where the ship
    // WAS when the beat began (research 2026-10 capture-repros A2: drawn up to
    // ~232 km away, then snapping back to the strut).
    this._seedCargoArc(net, start, end);
    // The catch turns with the ship for the whole flight (D3): make sure the
    // net knows its ship-relative attitude before the first flight frame.
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
   * R2 (fix round 1): the arm indices that already have a cargo flight on the way - a whole catch or a cut piece in
   * TRANSFERRING with a daughter as its carrier (a leash flight to a radiator tip carries no `_cargoArmIndex`). Such a
   * daughter is still DOCKED with an empty rack until the piece lands, so `heldCatches` alone cannot tell the next
   * booking to leave her out; `suggestCargoArm` counts each one as holding a catch.
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
   * gas-low-fail-fast D2 — tell the player the tank is too low to swing this catch to a radiator, once per catch.
   * `'rack'` = a cell is free, the catch goes to the daughter rack now; `'full'` = no daughter can take it, so it waits
   * at the nose (the player can let it go with [K]). The latch (`net._gasShortSaid`) is on the net, so a new catch
   * starts clear, and the 0.5 s retry cannot repeat a line. One exception, so no line is left untrue: a 'rack' line
   * followed by a rack flight that was called off (the daughter left her strut) with no cell free after all says the
   * 'full' line; and a 'full' line followed by a cell that frees needs no second line (the rack's own "Catch stowed"
   * line follows).
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
      _critical: true, // review 2026-10-19: past the onboarding tier filter, so the screen always says why (owner 23:26Z)
    });
  }

  /**
   * Leash hand-off (lane l5b-wire) — D1. Decide whether this COLLARED catch goes by leash.
   * @param {NetProjectile} net
   * @param {object} d — the catch
   * @returns {'started'|'declined'|'rack'} 'rack' = not a leash catch (too big for a tip, no
   *   free tip, no driver): the caller takes today's path unchanged. 'declined' = it fits but
   *   cannot start now (refusal said once per reason): retried on the usual 0.5 s cadence,
   *   never sent to the rack.
   * @private
   */
  _tryLeash(net, d) {
    net._gasShort = false;         // gas-low-fail-fast: set below only when THIS call finds the tank short for the swing
    const player = this._player;
    const drv = player && player.leashDriver;
    const tc = player && player.tipCargo;
    if (!drv || !tc || typeof drv.start !== 'function') return 'rack';
    const radiusM = DebrisField.trueReachM(d, 2);       // tip-fit: the catch as drawn, not half its nominal size
    if (!tc.fits(radiusM)) return 'rack';
    const tip = tc.pickTip();
    if (tip == null) return 'rack';
    // Out of the line's reach at the berth seat (a mother-net catch rides 3.3-5.0 m deep in the bag, 5.9-7.5 m
    // from the ship centre, measured l5c-reach Step 0): the net's winch first pulls it in to the nose
    // (l5c-reach E1) if the line can reach it from there; if it cannot even then, folding the radiators would be
    // for nothing and today's rack path takes it.
    let noseReel = false;
    if (typeof drv.canReach === 'function' && !drv.canReach(d, tip)) {
      if (typeof drv.canReachAtNose !== 'function' || !drv.canReachAtNose(net, d, tip)) return 'rack';
      noseReel = true;
    }
    // gas-low-fail-fast D1: a hand-off pays for one steering-gas turn. If the tank cannot pay for it, do not fold the
    // radiators for nothing — the old path ran ~41 s, said nothing, and ended in the same refusal at the turn. The catch
    // takes the rack path now; `_tryCargoTransfer` says why (once) when it knows whether a cell is free. D3: with the
    // furnace on, the nose furnace takes a failed catch, so the old path stays exactly as it was.
    if (!Constants.isFeatureEnabled('FURNACE_COOK') && typeof drv.gasShort === 'function'
        && drv.gasShort(net, d, tip, { noseReel })) {
      net._gasShort = true;
      return 'rack';
    }
    // u23: a profile trip shows ONE flown pass. Once it has begun the leash starts for no other catch (the retry would beat the trip's own look);
    // the trip hands this one to a tip unflown. Silent: nothing is wrong, and no line is owed. The pass's own leash is let through.
    if (tripLeashRefuses(net)) return 'declined';
    const why = drv.refusal(net);
    if (why) {
      // A 'busy' refusal (the previous catch still holds the leash driver) is never spoken: this catch simply starts
      // when the retry finds the driver free ("Handing the catch to radiator N" is then the one line).
      drv.announceRefusal(net, why);
      return 'declined';
    }
    return drv.start(net, d, tip, { noseReel }) ? 'started' : 'declined';
  }

  /**
   * Take a net out of play in this very tick (lane l5b-wire): the leash driver calls it right
   * after it stows the catch on a radiator tip, so the nose ledger and the tip ledger never
   * both hold the mass, and the next tick's prune never clears the pins of the stowed body.
   * Safe to call outside the update loop only (it splices `activeNets`).
   * @param {NetProjectile} net
   * @returns {boolean} true when the net was in the list
   */
  removeNetNow(net) {
    net.isActive = false;
    net._leashNoseReel = false;      // l5c-reach: a net taken out of play is no longer being reeled in to the nose
    const i = this.activeNets.indexOf(net);
    if (i < 0) return false;
    this.activeNets.splice(i, 1);
    return true;
  }

  /**
   * Cargo-continuity S7 — the transfer beat, one frame.
   *
   * Drives ONE curve: the bag's apex anchor (`net.position`) and the catch's pin
   * both come from the same Bézier evaluation, with the same seat offset the
   * berth hold uses, so the catch stays seated INSIDE its bag in transit ("cargo
   * stored in nets"). The pin is rewritten every frame — if it ever stops, the
   * catch falls back to the orbit branch and reads as released.
   *
   * On arrival the piece is stowed on the rack and the daughter is put into
   * HOLDING_CATCH (the pin loop in ArmManager only services REELING/DOCKING/
   * HOLDING_CATCH, so a DOCKED carrier must transition or the piece would go
   * unpinned for a frame). Mother-side fields are cleared to exactly what a
   * daughter-caught rack piece carries.
   *
   * @param {NetProjectile} net — a TRANSFERRING mother net
   * @param {number} dt — seconds
   * @returns {boolean} true when the hand-off completed (caller splices the net)
   * @private
   */
  _updateCargoTransfer(net, dt) {
    const M_NET = Constants.SCENE_UNITS_PER_METER;  // 1 m in scene units (file convention: a local per method)
    const d = net.targetDebris;
    const debrisField = this._debrisField;
    const armManager = this._armManager;
    const arm = armManager?.arms?.[net._cargoArmIndex];

    // Target or carrier lost mid-beat (mission transition / detach): put the
    // catch back at the collar rather than dropping it — cargo is never destroyed.
    if (!d || d.alive === false || !arm || !net._cargoFrom || !net._cargoTo) {
      clearRackCell(d);                 // rack-snug: an aborted flight forgets the cell it was heading for
      // CUT_AT_NOSE: a cut piece never "goes back to the collar" — the boss
      // owns the collar. The piece returns to the nose as a waiting piece
      // (the driver re-pins it and retries), or is simply dropped from the
      // cut bookkeeping if it died with the transition. The piece net is
      // spliced either way; the boss net's COLLARED hold is untouched.
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

    // The carrier LEFT her strut mid-flight (the player can still deploy her —
    // she is DOCKED, not HOLDING_CATCH, until arrival). Abort: her rack pin only
    // runs in REELING/DOCKING/HOLDING_CATCH, so delivering to a departing arm
    // would orphan the piece and it would read as released. The catch goes back
    // to the collar and the retry re-picks a carrier.
    const SA = Constants.ARM_STATES;
    if (arm.state !== SA.DOCKED && arm.state !== SA.HOLDING_CATCH) {
      clearRackCell(d);                 // rack-snug: the retry computes a fresh cell (the carrier may differ)
      // CUT_AT_NOSE: same abort, cut-piece routing — back to the nose as a
      // waiting piece; the piece net splices (never COLLARED: the collar's
      // occupant is the boss). The comms line below is still true: the cargo
      // stays at the collar station.
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

    // The arc rides with the ship: rebuild its control points from the LIVE ship
    // pose, and take the landing point live from the rack slot, so the beat
    // lands on the strut that is actually there. The catch also turns with the
    // ship (the nose hold's rigid attitude, run on through the flight).
    this._refreshCargoArc(net, arm, d);
    this._seedCatchLocal(net, d);
    if (this._player && this._player.quaternion) {
      net._applyCatchOrientation(d, this._player, dt);
    }

    net._cargoS = Math.min(net._cargoDur, (net._cargoS || 0) + dt);
    const t = net._cargoDur > 0 ? net._cargoS / net._cargoDur : 1;
    // Ease in-out so the catch leaves and arrives gently (an instant start reads
    // as a kick, which the momentum model does not fund).
    const te = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);

    // Quadratic Bézier B(te) = (1−te)²·P0 + 2(1−te)·te·C + te²·P1.
    // This curve carries the CATCH (both endpoints are catch positions), and the
    // bag apex is derived from it — the same apex/seat split as updateBerthHold,
    // just in the other direction, so the catch stays seated inside its bag.
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

    // ── Arrival: the rack takes ownership ──
    const stowed = (typeof arm._stowHeldCatch === 'function')
      ? arm._stowHeldCatch(d, this._player?.quaternion || null)
      : false;
    if (!stowed) {
      clearRackCell(d);                 // rack-snug: the cell it was heading for is gone; the retry assigns a fresh one
      // Rack filled during the beat (should be unreachable — the scorer reserved
      // a cell). Keep the cargo: put it back on the collar and let the retry pick
      // another carrier.
      // CUT_AT_NOSE: a refused cut piece returns to the waiting pool on its
      // boss net (never COLLARED) and the piece net splices.
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

    // Mother-side fields → exactly what a daughter-caught rack piece carries.
    // _captured stays true (the rack holds it), _armPinned/_armPinPos are
    // rewritten by the rack pin below, _motherParked clears so the piece behaves
    // like every other held piece, and _catchRenderMin is DELIBERATELY kept: the
    // readability floor is what the player has been looking at for the whole
    // ceremony, and clearing it would pop the drawn size at the strut.
    d._motherParked = false;
    d._capturedByArm = arm;
    // hold-catch FA1 (owner 2026-10-22 "Keep: radiator right away"): this catch is the MOTHER's - it only waited on a rack because no
    // radiator tip was free. ArmManager._tickMissionCarry moves a marked catch to a tip as soon as one is; a catch the daughter
    // caught herself carries no mark and stays with her. Cleared with the cell (clearRackCell).
    d._rackFromMotherNet = true;

    const S = Constants.ARM_STATES;
    if (arm.state !== S.HOLDING_CATCH) {
      arm._breakdownStarted = false;       // fresh furnace bookkeeping for the piece
      arm._breakdownChunksFired = 0;
      // NOTE: `capturedDebris` is deliberately NOT cleared. A DOCKED arm should
      // have none, but nulling it would destroy cargo if she somehow did — that
      // is bug B1's exact shape, and the two laws (§1) forbid it.
      if (typeof arm._transitionTo === 'function') arm._transitionTo(S.HOLDING_CATCH);
      else arm.state = S.HOLDING_CATCH;
    }
    // rack-snug (Decisions 1, 4): the rack takes the catch as a place on HER. Its cell, offset and her-frame attitude
    // were assigned when the flight began (`_cargoSlotWorld`) and `_stowHeldCatch` kept them, so the arc's end
    // is exactly where the pin below holds it — no jump at the strut — and from here on it turns with her
    // (`_pinHeldCatches`, every frame). A carrier with no rack seam of her own (a duck-typed stub) keeps the old
    // ship-relative attitude.
    if (!d._qLocalHer) seedShipRelativeAttitude(d, this._player?.quaternion, this._debrisField);
    if (typeof arm._pinHeldCatches === 'function') {
      arm._pinHeldCatches(
        this._player?.getPosition ? this._player.getPosition() : null,
        this._player?.quaternion || null);
    }

    net.isActive = false;
    net._berthTimer = -1;
    // The caller splices this net in the SAME tick, so the update loop never
    // sees it again — which is why the prune's STOWED/RELEASED consequences (pin
    // clearing, orbit re-seat, inventory restore) cannot fire on a delivered net
    // and undo the rack's pin. This marker is for any reader holding a stale
    // reference: the flight is over and the cargo belongs to the arm now.
    net._cargoDelivered = true;
    // CUT_AT_NOSE: the boss net learns the piece is off its books — the next
    // cut may begin. (Harmless if the boss net was itself torn down meanwhile:
    // this only writes a field on a dead object.)
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
      // CUT_AT_NOSE (plan L6): the documented payload, plus ONE extra field
      // on the cut-piece path only. Ordinary transfers carry no `cut` key —
      // byte-identical to the pre-flag payload.
      ...(net._cutMeta ? { cut: net._cutMeta } : {}),
    });

    // ONE player-facing line for the whole beat (the arc is its own feedback):
    // who took the cargo. That is how the automatic CG-first choice teaches
    // itself without an arm-picker UI.
    eventBus.emit(Events.COMMS_MESSAGE, {
      source: 'HOUSTON', channel: 'CMD',
      text: `Catch stowed on ${arm.displayName || arm.id}. Launcher clear.`,
      priority: 'success',
      _keep: true, // comms-after-tutorial D6: where a catch went is never folded into "× N queued"
    });
    return true;
  }

  /**
   * Born-in-the-world control points for a cargo arc (whole catch or cut
   * piece), plus the same three points in the SHIP's frame
   * (`_cargoFromLocal/_cargoCtrlLocal/_cargoToLocal` = q⁻¹ × (world − shipPos)).
   * `_cargoFrom/_cargoCtrl/_cargoTo` stay the live WORLD points (rewritten each
   * frame by `_refreshCargoArc`). With no ship pose to read (a stub without a
   * quaternion), no local points exist and the world points stay frozen — today's
   * behaviour.
   * @param {NetProjectile} net — the TRANSFERRING net (or about to be)
   * @param {THREE.Vector3} start — catch position, scene units (scratch ok)
   * @param {THREE.Vector3} end — rack slot, scene units (scratch ok)
   * @private
   */
  _seedCargoArc(net, start, end) {
    const M_NET = Constants.SCENE_UNITS_PER_METER;
    net._cargoFrom = start.clone();
    net._cargoTo = end.clone();
    // Quadratic Bézier control point: bulge outward (away from the strut tip)
    // so the catch arcs around the hull instead of shearing through it — the
    // same shape as the furnace chunk arc, run backwards.
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
   * One frame of the ship-riding arc: rebuild `_cargoFrom/_cargoCtrl` from the
   * ship-frame points and the live ship pose, and take `_cargoTo` live from the
   * rack slot (the strut that is actually there — the same computation the rack
   * pin will use on arrival, so the beat ends exactly on it). No-op when the
   * arc was born without a ship pose or the player can no longer supply one.
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
   * Make sure a flying net knows the catch's attitude in the ship's frame
   * (`net._qLocal`, shipQuat⁻¹ × catchQuat). The berth and `adoptLassoCatch`
   * already set it; a path that never berthed (a cut piece) gets it here, once,
   * from the catch's current attitude. No-op when it exists, or when the catch
   * has no tumbleAxis / the player no quaternion.
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
   * Cargo-continuity S7 — where a piece will sit once it is on the rack, so the
   * transfer arc ends exactly where `_pinHeldCatches` will hold it (no arrival
   * snap). Delegates to `ArmUnit.heldSlotWorldInto` — ONE computation for the
   * rack's geometry, shared by the pin and the arc, so the two cannot drift.
   *
   * rack-snug (Decision 4): the first call for this carrier (the start of the flight) ASSIGNS the cell — its
   * offset on her, and the piece's attitude in her frame — so the flight's end is known; later calls (the arc is
   * rebuilt every frame) find the assignment valid and only read it. `_stowHeldCatch` keeps it on arrival.
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

  // ── CUT_AT_NOSE: the cut machinery (plan L1–L9) ────────────────────────
  // Board on the BOSS net (the COLLARED mother net whose target is over the
  // hand-off gate):
  //   _cutPlan            the planCuts result (pieces in chop order; the LAST
  //                       piece is the held part — never cut off, L3)
  //   _cutOriginalMassKg  the boss's mass at plan time (size reference)
  //   _cutNext            index of the next piece to DETACH
  //   _cutProgressS       game-seconds accumulated toward that detach
  //   _cutPiece           the detached piece (waiting at the nose or flying)
  //   _cutPieceFlying     true while that piece's flight is under way
  //   _cutRetryS          launch-retry accumulator (CT.RETRY_S cadence)
  //   _cutWaitingSaid     the waiting comms line, once per pause (L9; re-armed when a piece leaves)
  //   _cutWaiting         true while the cut is PAUSED: the piece at the nose has no empty daughter to go to (R1)

  /**
   * True while a cut plan exists and is not finished — i.e. the boss must
   * not take the ordinary hand-off (`_tryCargoTransfer` guard) and the
   * collar digestion must not tick (plan L4: `_breakdownStarted` would close
   * the transfer window and cook the boss mid-cut). Flag OFF ⇒ no net ever
   * carries `_cutPlan` ⇒ always false ⇒ both call sites byte-identical.
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
   * The cut driver — one COLLARED frame of the chop (plan L5). Serialised:
   * exactly one piece is detached-and-not-delivered at a time. No state
   * change on the boss net (it stays COLLARED, mated, pin held); the detached
   * piece rides its own synthetic net (L7).
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
      // The waiting piece: held at the nose, just fore of the boss (a clamp
      // seat, DECISIONS §12 ruling 4 — the piece exists, drawn, until the
      // crane can take it). Pinned EVERY frame: a gap reads as a release.
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

    // Nothing outstanding: is there another piece to cut off? The LAST piece
    // of the plan is the held part — never detached (L3).
    if (net._cutNext >= plan.pieces.length - 1) return;

    // CUT_S GAME-seconds per cut: dt × BASE_SCALE, deliberately NOT
    // sun-scaled — the cutter is a machine, not a plant.
    net._cutProgressS = (net._cutProgressS || 0) + dt * TimeAuthority.BASE_SCALE;
    if (net._cutProgressS >= (CN.CUT_S ?? 60)) {
      net._cutProgressS = 0;
      this._detachCutPiece(net);
    }
  }

  /**
   * Detach the next planned piece: spawn it (a real, drawn debris object —
   * L7) and move its mass and salvage off the boss's books (L3: the ledger
   * conserves at every step).
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
      // Unreachable from a validated plan with a spawn-capable field (the
      // plan is only created after that capability check). Abandon quietly:
      // legacy behaviour resumes (the boss rides the collar; the cook wins).
      console.warn('[CaptureNet] CUT_AT_NOSE: spawn unavailable — cutting abandoned');
      net._cutPlan = null;
      net._cutPiece = null;
      net._cutPieceFlying = false;
      return;
    }

    // Seat the piece just fore of the boss's live pin (the same spot the
    // waiting-piece hold above keeps it at).
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

    // The boss loses EXACTLY the piece's amounts (plan L3 — the planner
    // conserves, so sequential subtraction leaves the held part at its
    // planned value within float dust).
    d.mass -= spec.massKg;
    net.capturedMass = Math.max(0, (net.capturedMass || 0) - spec.massKg);
    if (d.salvage && spec.salvage) {
      // The six scalar names mirror cutPlanner's SALVAGE_SCALARS (kept in
      // sync by test-CutAtNose's conservation pin, which fails on drift).
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
    // First launch attempt right away (a piece may leave the moment it is
    // off); the RETRY_S cadence takes over if no daughter qualifies.
    this._launchCutPiece(net, piece);
  }

  /**
   * Launch one cut piece to a rack (plan L5/L6/L7): the piece rides a
   * synthetic mother net born directly in TRANSFERRING — the same
   * `_updateCargoTransfer` Bézier / pin-every-frame / stow beat a whole
   * catch flies, with `_ceremonyStartEmitted` set (no launch ceremony) and
   * NO bag: no net is spent on a cut piece, the piece is its own container
   * (the `adoptLassoCatch` quiet-hand-off idiom). Departs only when the
   * crane is free (no mother transfer in flight) and `suggestCargoArm`
   * qualifies a carrier at the PIECE's mass.
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
      this._armsWithCargoOnTheWay(), DebrisField.trueReachM(piece, piece.sizeMeter || 0));   // hold-clear D7: + its reach
    if (armIndex == null) {
      // R1 (fix round 1): no empty daughter may take the piece, so the cut is PAUSED at the nose. It resumes by itself when a
      // daughter is home and empty (this retry, every RETRY_S); [K] lets the rest go. L9: plain words, once per pause.
      net._cutWaiting = true;
      if (!net._cutWaitingSaid) {
        net._cutWaitingSaid = true;
        // Pieces still to be placed: the one waiting at the nose plus every piece after it (the held part counts). "it" in the
        // tail is the catch: K releases the waiting piece and the uncut remainder together.
        // `_cutNext` has already moved past the waiting piece, and each earlier piece has been delivered (one at a time).
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
    net._cutWaitingSaid = false;          // a later pause (another piece with no empty daughter) speaks again
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
    // Quiet by construction: no NET_FIRED (no bag ever attaches — the piece
    // is its own container), no ceremony beats (adoptLassoCatch's suppression
    // idiom — `update()` would otherwise fire NET_CEREMONY_START on the
    // first tick of a fresh net).
    pieceNet._ceremonyStartEmitted = true;
    // Net-less seat: the pin IS the piece position; there is no bag apex to
    // offset from.
    pieceNet._catchSeatM = 0;
    // Same arc shape as the whole-catch beat (bulge away from the strut tip),
    // and the same ship-riding control points + ship-relative attitude.
    this._seedCargoArc(pieceNet, start, end);
    this._seedCatchLocal(pieceNet, piece);
    pieceNet._cargoArmIndex = armIndex;
    pieceNet._cargoS = 0;
    pieceNet._cargoDur = Math.max(1e-3, CT.FLIGHT_S ?? 3.0);
    // L6: the one extra field both transfer events carry on this path.
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

    // L9: when the LAST cut piece leaves the nose, the plan is done cutting
    // — only the held part remains, and it fits a daughter's rack.
    if (net._cutNext >= net._cutPlan.pieces.length - 1 && !net._cutLastSaid) {
      net._cutLastSaid = true;
      // R1: the held part goes by the ordinary hand-off once the last piece has landed. The over-gate refusal spoke at the
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
   * CUT_AT_NOSE — release an orphaned waiting piece to the field (boss
   * jettisoned or died mid-cut). Cargo is never destroyed: the piece is its
   * own body now — un-pinned, orbit re-seated from its last position, free
   * (still `_credited`: the mate paid for the whole body, a re-capture must
   * not pay again).
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
    clearRackCell(piece);                 // rack-snug: a cut piece that was heading for a cell forgets it
    if (piece._scenePosition && piece.orbit) {
      reseatOrbitFromScene(piece.orbit, piece._scenePosition,
        player?.getVelocity ? player.getVelocity() : null);
    }
  }

  /**
   * Cargo-continuity S13(c) (register item 47) — the collar's digestion clock.
   * One frame of the mother-side furnace: the collared piece cooks on the SAME
   * law the daughter rack runs (ArmUnit._updateHoldingCatch) — span
   * `FT.digestSpanS(massKg)` (register item 48: the ONE home), progress
   * dt × TIME_SCALE_GAMEPLAY × sunScale (ArmManager writes _digestSunScale on
   * this system from the one ResourceSystem multiplier SSOT; ?? 1.0 keeps
   * legacy mocks byte-identical), phase mapped onto [0, FEED_S] so the
   * hold/chop/feed fractions and the chunk cadence are identical. The
   * staged beat reuses the breakdown machinery with the {kind:'collar'}
   * anchor: chunks arc collar → bus, NET_CONSUMED carries the pod, and the
   * completion CATCH_PROCESSED carries { digested: true } — the mate already
   * paid the credit ({ parked: true }), so GameFlowManager runs removal +
   * comms but pays NOTHING twice (single-fire contract).
   *
   * @param {NetProjectile} net — a COLLARED mother net
   * @param {number} dt — seconds
   * @returns {boolean} true when digestion completed (caller splices the net)
   * @private
   */
  _tickCollarDigestion(net, dt) {
    const d = net.targetDebris;
    if (!d) return false;
    if (bigPieces.isPending(d)) return false;   // slice 5 (5b): a pending big piece is never cooked at the collar: it pays when disposed of
    // no-melt (owner 2026-10-18, "Stay full size, no melting"): no furnace, no cook clock. The catch stays welded
    // full size at the collar (the berth hold pins it) until a tip furnace takes it on the trip or [K] jettisons it.
    if (!Constants.isFeatureEnabled('FURNACE_COOK')) return false;
    const FT = Constants.FURNACE_TRANSFER;
    const HOLD_S = FT.HOLD_S, CHOP_S = FT.CHOP_S, FEED_S = FT.FEED_S;
    const CHUNK_COUNT = FT.CHUNK_COUNT;
    const span = FT.digestSpanS(d.mass);   // item 48: the ONE span-law home
    const sunScale = this._digestSunScale ?? 1.0;
    d._digestProgress = (d._digestProgress || 0) + dt * TimeAuthority.BASE_SCALE * sunScale;
    const t = Math.min(FEED_S, (d._digestProgress / span) * FEED_S);
    // The chop ramp reads this derived phase time (ArmManager's rack ramp reads
    // arm._digestPhaseT — one convention, one home per hold).
    net._digestPhaseT = t;

    // Lazy-init the per-collar breakdown bookkeeping (safe if a test sets
    // COLLARED directly — same idiom as ArmUnit's HOLDING_CATCH).
    if (net._breakdownStarted === undefined) net._breakdownStarted = false;
    if (net._breakdownChunksFired === undefined) net._breakdownChunksFired = 0;

    if (t < HOLD_S) return false;   // hold: welded full-size — the berth hold pins it

    // Fire the chop-start exactly once when we cross into the chop phase.
    if (!net._breakdownStarted) {
      net._breakdownStarted = true;
      d._breakdownActive = true;   // the furnace visual owns scale/disposal
      eventBus.emit(Events.CATCH_BREAKDOWN_START, {
        armId: 'mother', debrisId: d.id, chunkCount: CHUNK_COUNT,
        anchor: { kind: 'collar', podIndex: net.podIndex },
      });
    }

    // The staged chop: shrink the original out of view across the chop window
    // (the same ramp ArmManager's pin loop runs at the rack) so the chunks are
    // what the player sees being fed — the catch comes apart, never pops.
    // updateBerthHold pinned at scaleMul 1 earlier this tick; this re-pin is
    // the last write this frame.
    // Small-catch plan W3 (2026-08-25): the ramp now reads the ONE law home
    // (FT.chopScaleMul — byte-identical values) so the collar bag's deflation
    // (CaptureNetVisual reads the same helper off the same _digestPhaseT) can
    // never drift from the instance scale it is wrapping.
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

    if (t < FEED_S) return false;   // mid-chop: the hold phase pins above; nothing more

    // ── Digestion complete: the furnace ate the body; the collar frees ──
    // Mirrors the rack feed-end: flush any chunks a long frame skipped, release
    // the hold first (the body is consumed — the furnace owns it), then
    // NET_CONSUMED (the bag draws in — the net IS the container, fed in with
    // the debris), then the ONE CATCH_PROCESSED (digested: true — removal +
    // the processed comms line run; the mate's credit does not re-fire).
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
    // Marker for any reader holding a stale reference (the transfer beat's
    // _cargoDelivered idiom): the cargo was digested; the net's job is done.
    net._digestedOut = true;
    // The catch's mass just LEFT the berthed ledger (the caller splices the net
    // this same tick). A mother berth invalidates the attitude inertia via
    // NET_BERTHED and a rack arrival via ARM_STATE_CHANGE; this completion emits
    // only NET_CONSUMED + CATCH_PROCESSED — neither invalidates — so invalidate
    // the cache directly: the mirror of adoptLassoCatch's entry-side
    // invalidation, and the seam for any mass-exit that doesn't cross an
    // arm-state change (register item 63).
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
   * §8 A2 — the pin-clearing chokepoint that did not exist. Mother nets have
   * no ArmUnit, so nothing else ever clears the debris pin flags the
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
    clearRackCell(debris);               // rack-snug: and forgets any cell a cargo flight had assigned
  }

  /**
   * §8 A2 — tear down a berthed catch: clear pins, drop the docked slot, free
   * the launcher. The bag visual is removed by CaptureNetVisual's own
   * STOWED/RELEASED handling via the fade path; here we emit nothing visual —
   * the net is spliced out of activeNets by the caller, and _getNet then
   * returns null so the visual removes itself next frame.
   * @param {NetProjectile} net
   * @private
   */
  _teardownBerth(net) {
    this._clearCatchPins(net.targetDebris);
    // CUT_AT_NOSE: a boss torn down mid-cut (mission transition, [K] jettison
    // upstream of the prune block) must not leave a waiting piece orphaned at
    // a stale nose pin. Cargo is never destroyed: the piece is its own body
    // now — release it to the field as free, still-paid salvage.
    if (net._cutPiece && !net._cutPieceFlying) this._releaseCutPiece(net._cutPiece);
    net.isActive = false;
    net._berthTimer = -1;
  }

  /**
   * §8 A2 — re-seat the released catch's orbit from the release position +
   * the mother's velocity. DebrisField.update skips orbit propagation only
   * for _onboardingPinned / _motherParked, NOT _armPinned, so a pinned catch's
   * trueAnomaly kept advancing and a jettisoned whale would snap to wherever
   * its own orbit went. The rebuild itself is the ONE shared computation
   * (reseatOrbitFromScene — applyCartesianImpulse's recipe, all-element
   * validation, the [0, 0.1] eccentricity clamp), also read by the
   * ArmManager.reset() cargo release (register item 71). The arm path
   * deliberately accepts the snap (ArmUnit.js:4494-4497) — do not copy that
   * 2 m in front of the camera.
   * @param {NetProjectile} net
   * @private
   */
  _reseatOrbitOnRelease(net) {
    this.reseatBodyOrbit(net.targetDebris);
  }

  /**
   * Nets step 3 slice 5 (lane 5d): `_reseatOrbitOnRelease` for a body that no net holds any more (a big piece let go by a push-down or a
   * drag sail: `GameFlowManager.detachHeldPiece` has already taken the net away). The same ONE computation, so the piece flies on from
   * where it was pinned with her velocity, never along the stale orbit it carried while it was held. No behaviour change for K.
   * @param {object|null} d the field's own body @returns {boolean} the orbit was re-seated
   */
  reseatBodyOrbit(d) {
    const player = this._player;
    if (!d || !player || !d._scenePosition || !d.orbit) return false;
    const v = (typeof player.getVelocity === 'function') ? player.getVelocity() : null;
    return !!reseatOrbitFromScene(d.orbit, d._scenePosition, v);
  }

  /**
   * §8 A2 — berthed mass for the translational thrust scaling (plan §4.4).
   * Structured as a sum over attachments so a future CoM upgrade is
   * non-breaking. Replaces the dead getCapturedNetMass for the mother path.
   *
   * Cargo-continuity S7: TRANSFERRING counts too. The piece is in flight between
   * the nose and a strut tip, still aboard, and the daughter's rack does not own
   * it until arrival — so counting it here for the whole beat is what makes the
   * cargo ledger continuous at the hand-off. S13(c): COLLARED is the nose-side
   * station — the collar holds the mass until the furnace eats it or the rack
   * takes it.
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
   * §8 A2 — the docked catch accessor. S13(e): the occupancy FIRE gate is
   * retired (a shot refuses only when its own corridor fouls the mated
   * cargo — getCollarShotFoul). This survives as the
   * read for HUD/status (StatusPanel), the lasso's single-station soft-block
   * (the collar holds ONE body), the adoption guard, releaseDockedCatch, and
   * the foul read.
   *
   * Cargo-continuity S7: TRANSFERRING counts. The catch is crossing from the
   * collar for the length of the beat — the station frees when the piece lands
   * on the rack, not when it leaves the nose.
   * @returns {NetProjectile|null}
   */
  getDockedCatch() {
    return this.activeNets.find(n => n._isMother
      && (n.state === STATES.BERTHED || n.state === STATES.COLLARED
          || n.state === STATES.TRANSFERRING)) || null;
  }

  /**
   * Register item 48 — the collar cook, readable. The HUD's mother digest
   * segment polls this at 10 Hz (the `getDockedCatch` precedent): while a
   * collared piece digests, report its progress through the ONE span-law home
   * (`FURNACE_TRANSFER.digestSpanS`) so the player sees the cook the S8
   * transit clock runs. BERTHED is the pre-cook securing window (the berth
   * tag shows there); TRANSFERRING pauses the cook for the flight and the
   * daughter's rack reports the piece on arrival — only COLLARED cooks at the
   * collar. Field-only reads + `|| 0` / `?? 1.0` guards keep legacy mocks
   * byte-identical.
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
      frac: Math.min(1, Math.max(0, (d._digestProgress || 0) / span)),
      sunScale: this._digestSunScale ?? 1.0,
      kg: d.mass || 0,
    };
  }

  /**
   * followups-1018 D3: something just left a tip slot or a rack cell (NET_CONSUMED: `TipCargo.releaseSlot` for the
   * station unload and a tip jettison, `ArmManager.unloadHeldCatches` for the racks), so room may exist now. Clear the
   * sticky `_cargoDeclined` on every COLLARED mother net other than the one consumed, in this same tick: the nose-full
   * line, the camera reader and the mission-start reader stop saying "nowhere to go" at once, and the first-tick
   * decision runs again on the next net update (a retry that still finds no room declines again, silently: the refusal
   * comms is once per catch, `_cargoRefused`).
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
   * no-melt: the plain refusal for a new catch while the nose collar is holding one that has nowhere to go, or null.
   * With no furnace the nose never empties by itself; once the hand-off has been tried and declined (every tip full or
   * too small, every daughter cell taken, a catch too heavy) the catch stays at the collar - a tip furnace takes it on
   * the trip to the next field if it fits one - or [K] jettisons it. While a hand-off is still pending (securing, a leash under way, a piece in
   * flight, a cut under way) this returns null and today's refusals speak. Shared by the mother net (N), the lasso and
   * the InputManager pre-flight, so the words live in one place. Pure read: it emits nothing.
   * @returns {string|null}
   */
  getNoseFullLine() {
    // R1 (fix round 1): a cut that ran out of empty daughters is paused at the nose - the rest of the catch and the piece
    // wait there, so a new net is refused in plain words (furnace or not: the cut never cooks the boss, L4).
    for (const n of this.activeNets) {
      if (n._isMother && n.state === STATES.COLLARED && n._cutWaiting && n._cutPiece && !n._cutPieceFlying
          && this._cutActive(n)) return NOSE_FULL_CUT_LINE;
    }
    if (Constants.isFeatureEnabled('FURNACE_COOK')) return null;
    for (const n of this.activeNets) {
      if (!n._isMother || n.state !== STATES.COLLARED) continue;
      if (!n._cargoDeclined || n._leash || n._leashNoseReel || this._cutActive(n)) continue;
      // Nets step 3 slice 5 (lane 5b): K does not let a pending big piece go, so this refusal does not offer it.
      if (bigPieces.isPending(n.targetDebris)) {
        return `Nose is full: the ${pieceName(n.targetDebris)} stays at your nose and no daughter can take it. It pays when you dispose of it.`;
      }
      return NOSE_FULL_LINE;
    }
    return null;
  }

  /**
   * no-melt: the station takes the catch parked at the nose collar (the resupply stop; GameFlowManager). The catch is
   * already paid (the mate credited it), so nothing is credited or digested here: the pins clear, the net leaves the
   * system and the collar is free again. The caller removes the body from the field. A catch still being reeled,
   * flown, leashed or cut is left alone.
   * Slice 5 (lane 5b): with `onlyId` it frees the collar of THAT piece only (`GameFlowManager.detachHeldPiece`: a big piece being
   * disposed of; the caller clears the field body's own pins, a net may hold a snapshot of it).
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
   * Cargo-continuity S13(e) — the per-shot foul read that REPLACED the
   * occupancy block. Firing is never refused because cargo exists as such; but
   * a collared body sits on-axis fore of the nose, and a shot at a dead-ahead
   * target sweeps a cone no launcher site clears (probe tmp/s13e-podsite.log:
   * the cone reaches cargo radius only fore of the cargo — with whale cargo
   * mated, EVERY forward shot fouls, foul cone ≥ 90° at every class). So a
   * specific shot whose corridor intersects the mated cargo refuses per-shot.
   * Owner 2026-10-13 (one launcher, centred): the muzzle is now ON the
   * cargo's axis, but the answer for a nose-direction shot is the same as it
   * was from ±0.45 m — it fouled then and fouls now, at every catch size the
   * Large Net takes (measured, see the w7 plan Log): a held catch at the
   * collar blocks the shot; fire again once it has left.
   *
   * Geometry: closest approach of the shot ray (launchPos + t·launchDir, t>0)
   * to the docked catch's live pin (the drawn truth — _scenePosition is what
   * pinCapturedDebris wrote this frame, so BERTHED swing, the TRANSFERRING
   * arc and the collar seat are all read exactly as drawn). Foul when the
   * approach is closer than the cargo radius + BERTH_CLEARANCE_M (the berth's
   * own keep-out — ONE clearance constant).
   *
   * @param {number} podIndex — the firing launcher (always 0; unused today, the
   *   cargo read is launcher-independent, but the signature keeps the call sites honest)
   * @param {{x:number,y:number,z:number}} launchPos — shot origin, METRES
   *   (the NetProjectile/fireMotherNet convention)
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
   * §8 A2 — manual jettison ([K]). Releases the berthed/parked catch: pins
   * cleared, orbit re-seated, net expended, launcher freed. The securing timer
   * (if still running) is cancelled — jettison before expiry means NO score;
   * a parked catch was already credited.
   *
   * Cargo-continuity S7: a hand-off in flight is IRREVOCABLE — the beat is ~3 s,
   * and releasing mid-arc would drop a body that is neither on the tether nor on
   * the rack (there is no honest position for it). The refusal speaks so [K] is
   * never silently ignored.
   * @returns {boolean} whether a docked catch was released
   */
  releaseDockedCatch() {
    const net = this.getDockedCatch();
    if (!net) return false;
    if (net.state === STATES.TRANSFERRING) {
      // l5c-reach E10: the leash hand-off (net._leash) is not a flight to a daughter
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
    // Nets step 3 slice 5 (lane 5b, C5): a pending BIG piece pays when it is disposed of; letting it go would throw the pay away, so K
    // (and the LET GO chip, the same call) refuses in plain words and changes nothing. A piece not yet mated (the securing timer still
    // running) is not pending: K works there as it always did.
    if (bigPieces.isPending(net.targetDebris)) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'HOUSTON', channel: 'CMD',
        text: `K doesn't let go of the ${pieceName(net.targetDebris)}: it pays when you dispose of it. Press U to choose.`,
        priority: 'warning', _reactive: true,
      });
      return false;
    }
    // l5c-reach E10: [K] during the nose reel-in stops the reel cleanly before the release.
    if (net._leashNoseReel) {
      const drv = this._player && this._player.leashDriver;
      if (drv && typeof drv.cancelNoseReel === 'function') drv.cancelNoseReel(net);
      net._leashNoseReel = false;
    }
    return net.release();
  }

  /**
   * Cargo-continuity S13(d) — adopt a lassoed piece onto the ONE holding model.
   *
   * The lasso's reel delivers the catch to the collar seat; this builds a mother
   * net ALREADY BERTHED there, so the piece rides the exact machinery an S3
   * mother catch does: the berth hold pins it at the collar, the securing timer
   * mates it (CATCH_PROCESSED { parked: true } — credit lands exactly once), it
   * joins the berthed ledger (getBerthedMassKg), then the S7 auto-transfer or the
   * S8 collar-digestion clock finishes it (CATCH_PROCESSED { digested: true } →
   * removal). This repairs the gap that lasso cargo mass joined NO ledger under
   * the deleted cell model (the cells were not nets).
   *
   * Deliberately emits NEITHER NET_FIRED NOR NET_BERTHED: those chain the mother
   * launch recoil, the autopilot attitude-hold, the berth clunk/chime and the
   * PARK_HOLD camera beat — all mother-launch ceremony the lasso's capture UX must
   * not inherit. The lasso fires its own LASSO_STOWED/CAPTURED beats at reel
   * completion; this is pure storage machinery.
   *
   * @param {object} target — the lassoed debris (alive, pinned by the lasso reel)
   * @returns {NetProjectile|null} the berthed net, or null when the dock is busy
   *   (the caller holds the piece off and retries — cargo is never destroyed) or
   *   the system has no player/debrisField context.
   */
  adoptLassoCatch(target) {
    const player = this._player;
    const debrisField = this._debrisField;
    if (!target || target.alive === false || !player || !debrisField) return null;
    // Single-station guard: the collar holds ONE body. The caller pends while the
    // dock is busy; refuse here defensively rather than double-berth.
    if (this.getDockedCatch() || this.hasMotherNetInFlight()) return null;

    // Register item 81 (lasso path): adoption is the ownership transfer onto
    // the one holding model — drop a severed runaway's stale claim HERE, past
    // the busy guard (a refused adoption pends, and the pend keeps the
    // EXPENDED arm's bounded-drift release armed; the claim also deliberately
    // survives the lasso's reel, whose failure paths return the runaway to
    // that same release — item-78 semantics).
    dropSeveredCatchClaim(target);

    const M_NET = Constants.SCENE_UNITS_PER_METER;
    // l8-reel-collar: the adopted piece is born at HOME (the same place the mother reel ends: bag mouth at the
    // ring, catch seated on the collar axis) — no 1.0 m standoff, no 2.856 m bag seat. LassoSystem's reel
    // delivers to the same point (catchHomeDistM), so the hand-off does not snap.
    // S13(e): the adoption seats on the COLLAR anchor (on-axis), not the
    // launcher muzzle (30 mm behind it since 2026-10-13).
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

    // Berth seeds — the state the mother reel would hand off at the standoff, for
    // a piece delivered already seated at the collar. The ctx mirrors
    // fireMotherNet's shape (the corridor gate reads armManager/lassoSystem on
    // REELING; harmless here — the net is already BERTHED).
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
    // 2026-08-26 round 2 (ENGULF) — the piece rides INSIDE the bag, not at the
    // apex tip. Seat depth 0 pinned the catch AT the bag apex: the drawn bag
    // extended fore of it, so the piece read "alongside the net" at the nose
    // (owner: "net/Bag is supposed to be AROUND the debris, engulfing"). The
    // pod path already seats catches inside the bag at their capture depth
    // (whale-in-cone follow-up 2, _updateMotherReel); adoption now uses the
    // fixed ADOPT_CATCH_SEAT_M (byte-equal to WRAP_SEAT_FRAC × the CN.LARGE
    // bag cone height — the one-home law pinned in test-Constants), and the
    // lasso reel delivers the piece to collar-seat + fwd × the SAME constant
    // (LassoSystem._reelDeliveryWorld), so the hand-off stays pin-exact — the
    // no-snap contract holds with the piece engulfed instead of alongside.
    // l8-reel-collar: the seat is the HOME seat now (was ADOPT_CATCH_SEAT_M 2.856); the apex is at the ring.
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
    // Seed the old item-15 ramp clock DONE (re-ramping from 0 would have popped the drawn size at adoption). Since
    // reel-visible _catchFloorScale ignores the clock and returns the true base scale, so this is bookkeeping only.
    net._floorRampT = CN.MOTHER_CATCH_MIN_RENDER_RAMP_S ?? 0.6;
    net._berthTimer = CN.BERTH_SECURE_S ?? 4.0;
    net._berthProcessed = false;
    // The adopted catch never LAUNCHES — it is born BERTHED at the collar.
    // NetProjectile.update() emits NET_CEREMONY_START on the first tick of a
    // fresh net, which replayed the ENTIRE launch beat list (pod prefire →
    // glamour → approach → envelop → cinch) over a net that never flies: the
    // letterboxed camera dollied around the nose, then chased beat anchors
    // hundreds of km into empty space while the catch digested underneath
    // (tmp/lasso-take frames 010–024: camToShipM 141 810 → 502 981 m during
    // BRAKE_ENVELOP/CINCH — the owner's "what is the camera doing after the
    // debris shrinks" report). Same rationale as the NET_BERTHED suppression
    // below: adoption is the QUIET hand-off — none of the spectacle.
    net._ceremonyStartEmitted = true;
    net._tumbleCarryover = Math.min(Math.abs(target.tumbleRate || 0), CN.TUMBLE_CARRYOVER_MAX_RAD_S ?? 0.6);
    net._tumbleCarryAngle = 0;
    net._transitionTo(STATES.BERTHED);

    this.activeNets.push(net);

    // 2026-08-26 — attach the standard berthed-bag VISUAL. NET_FIRED /
    // NET_BERTHED / NET_CEREMONY_START stay suppressed on this path (launch
    // recoil, autopilot attitude-hold, berth clunk, camera beats — the
    // spectacle adoption must not inherit), but the visual-only gap they left
    // was real: CaptureNetVisual creates bags on NET_FIRED alone, so every
    // adopted lasso catch sat at the collar as a BARE floored icosahedron
    // through berth + digestion and then chop-shrank in the open
    // (tmp/lasso2-day-before f005–f010 — the owner's "debris shrinks wrapped
    // in a geodesic bubble" on the REAL catch path). NET_ADOPTED has exactly
    // one consumer by design: the visual attaches the same cinched bag +
    // welded film + W3 chop deflation an S3 mother berth gets.
    eventBus.emit(Events.NET_ADOPTED, { podIndex: 0, armIndex: -1 });

    // The catch's mass just entered the berthed ledger. A mother berth invalidates
    // the attitude inertia via NET_BERTHED; this path must not emit that event (it
    // chains the launch/berth ceremony), so invalidate the cache directly — same
    // effect, none of the spectacle.
    if ('_attitudeInertia' in player) player._attitudeInertia = null;

    return net;
  }

  /**
   * u20-nose — a daughter hands the catch she holds to the nose (docs/research/2026-10-nose-handoff.md). Modelled on
   * `adoptLassoCatch`: the catch is already seated on the collar axis (she flew it to the seat the mother's own catches use,
   * `catchHomeDistM`), so the net is born AT HOME, no reel, no snap, and goes straight to COLLARED: the mate already
   * happened (her rack paid the catch when it was parked there, `ArmUnit` rack park, `CATCH_PROCESSED` source 'rack'), so there is
   * no berth timer and no second credit. The adopted net behaves like a mother catch at the collar everywhere (the leash,
   * trip melting, K lets go, cut rules, the net-shot foul). The first-tick hand-off decision stays OFF (`_cargoDeclined`, retry
   * parked) until the daughter is home: the leash cannot turn the ship under her. `ArmUnit` calls `releaseNoseRetry(net)` then.
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
    // MATED already: paid on her rack, no berth timer (BERTHED -> COLLARED is the mate), no CATCH_PROCESSED here.
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
    // No gap: the net's own hold writes the catch's pin NOW, so the one frame between this call and the next net tick is not unpinned.
    net.updateBerthHold(0);
    return net;
  }

  /** u20-nose: the daughter is home - let the adopted net try its leash hand-off on the very next tick. */
  releaseNoseRetry(net) {
    if (net && net._noseAdopted) net._cargoRetryS = 1e9;
  }

  /**
   * u20-nose: take back a daughter's hand-over before she lets go (the tug test failed, or her carry was aborted): the net leaves the list (the
   * visual follows the list) and stops holding. Unlike `_teardownBerth` it does NOT clear the catch's pins and rack record: the catch goes back to
   * the daughter's rack as it was (`ArmUnit._noseRollback` restores what the net's hold wrote). Returns true when the net was in play.
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
   * l8-reel-collar — metres from the berth anchor (the collar plane) to where a catch's centre ends on the collar
   * axis (HOME, see `catchHomeDistM`). The lasso's reel and adoption read this so they agree with the mother reel.
   * @param {object} d — the catch (sizeMeter)
   * @returns {number} metres
   */
  getCatchHomeDistM(d) {
    return catchHomeDistM(this._player, this._armManager, d);
  }

  /**
   * Cargo-continuity S13(d) — fore extent (metres from the collar plane —
   * the berth anchor, S13(e)) of the
   * busiest active mother-net berth, 0 when the collar station is clear. A lassoed
   * piece waiting for the collar holds this far ahead of the seat so it never
   * overlaps the occupant (docked or inbound). Conservative: an inbound net
   * reserves its eventual berth footprint. Register item 74: the read is the
   * shared `motherNetForeExtentM` — a corridor-held or extended-standoff
   * member reports its TRUE far face (its frozen slot / honest apex), so the
   * pend can no longer pin inside the tandem body; with no held/extended
   * member the base formula stands byte-identical.
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

  /**
   * Reset to clean state (game reset / new session).
   */
  reset() {
    this.activeNets = [];
    this._cooldownTimers.clear();
    this._motherPodInventory = new Array(this._motherPodCount()).fill(0);
    this._motherPodMax       = new Array(this._motherPodCount()).fill(0);
    this._initialized = false;
    this._playerHasFragmented = false;
    // Phase B §9.5: kill any running net loops — a reset drops every net with
    // no terminal events, so the whistle/winch would otherwise stick (the
    // classic bug). Optional-chained: headless tests inject no audioSystem.
    this._audioSystem?._stopNetLoops?.();
  }

  // ── Fire Commands ──────────────────────────────────────────────────────

  /**
   * Number of Mother Large Net launchers (CAPTURE_NET.MOTHER_POD_COUNT: 1 since
   * 2026-10-13 — owner: one launcher, centred). Never below 1.
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
   * @param {number} podIndex   — the launcher index; always 0 (one launcher
   *   since 2026-10-13, the podIndex API is kept)
   * @param {object} launchPos  — world position {x, y, z} in metres
   * @param {object} launchDir  — normalised direction {x, y, z}
   * @param {object} target     — debris object (with .position, .mass, .id)
   * @param {string} [mode]     — 'SLAM_WRAP' or 'CINCH' (auto-recommend if omitted)
   * @returns {NetProjectile|null} The created projectile, or null on failure
   */
  fireMotherNet(podIndex, launchPos, launchDir, target, mode) {
    if (tripRefuses('net')) return null;            // trip-melt D7: no net while the ship burns to the next field
    if (!Constants.FEATURE_FLAGS.CAPTURE_NET) return null;
    if (target && target._disposed === true) return null;       // slice 5 (5d, D4): a piece that was disposed of is no catch
    if (!(podIndex >= 0) || podIndex >= this._motherPodCount()) return null;
    // Phase 0.3 (capture-feedback overhaul): refusals speak — mirror the
    // LassoSystem denial-comms style so the player knows WHY nothing fired
    // and what fixes it (wait N s / send a daughter).
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
    // S13(e): the §8 A2 occupancy refusal is RETIRED — cargo occupancy is not
    // a fire refusal as such. What remains is per-shot and geometric: a shot
    // whose corridor intersects the mated cargo refuses with aim information
    // (not a blocked launcher). Since 2026-10-13 the launcher is back on the
    // axis, where the catch seat is, so a catch held at the collar fouls every
    // shot (owner-approved physics: the catch is in the way).
    // no-melt: a catch at the collar with nowhere to go refuses every new net, in plain words (once per press).
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

    // Deplete inventory (a launched net is used up, hit or miss: DECISIONS §33 row 1)
    this._motherPodInventory[podIndex]--;

    // CEREMONY_REDESIGN §4 / NET_CEREMONY alignment (2026-05-25):
    // When NET_CEREMONY is on, the ceremony's beats 5–6 (BRAKE_ENVELOP, CINCH)
    // assume the CINCH FSM path. SLAM_WRAP physics skips ENVELOP and CINCH_CLOSING
    // entirely (CONTACT → SECURE_CHECK → CAPTURED in <1 s game-time), so the
    // visual renders no engulf or cinch animation during those beats — confirmed
    // by browser log ([NET_CINEMATIC] CEREMONY_START captureMode=SLAM_WRAP) and
    // by inspecting [`CaptureNet._updateContact`](js/entities/CaptureNet.js:387).
    // Force CINCH when the auto-recommender would otherwise pick SLAM_WRAP, so
    // the FSM traverses BRAKE→ENVELOP→CINCH_CLOSING and the ceremony visual
    // matches the camera beats. Explicit `mode` argument is still honoured
    // (preserves test paths and future explicit-mode UI). CINCH_P_BASE is
    // ≥ SLAM_P_BASE in all pairings, so no score regression.
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
      // Mother-pod launcher anchor: polled every frame for the pod muzzle's
      // CURRENT world position (scene units). Without it every
      // `_sourceArm?.position` block is skipped and the net renders at a
      // stale absolute point that drifts ~45 km apparent in the first 0.65 s
      // (mother-net-reel plan §7.2). Falls back to the metres-based test
      // path when no player ref was injected (headless mocks).
      anchorProvider: this._player
        ? (out) => (typeof this._player.getNetPodPositionInto === 'function'
            ? this._player.getNetPodPositionInto(podIndex, out)
            : out)
        : null,
    });
    // Phase-A berth context (player for the ship-relative reel frame,
    // debrisField for the pinCapturedDebris API — plan §1.1). Phase C-lite
    // adds armManager + lassoSystem for the recovery-corridor test (§10).
    // S13(e): the system back-reference lets the corridor gate read the OTHER
    // docked nets' cargo (the mated-cargo obstacle class).
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

    // Net-canister continuity fix: the net leaves the arm's fore net-launcher
    // canister, not the body centre. When the arm exposes the mesh-derived
    // muzzle (real ArmUnit), override the caller-supplied launch position with
    // it — the SAME source _anchorScene() polls every frame, so net.position
    // and the co-orbiting anchor agree from tick 0 and the flight/contact
    // math shifts by exactly the canister offset (~0.11–0.20 m along the
    // nose). Mock arms without the method keep the explicit launchPos
    // (headless test path). Muzzle is scene units → convert to metres.
    let spawnPos = launchPos;
    if (typeof arm.getNetMuzzleWorldInto === 'function') {
      const M_NET = Constants.SCENE_UNITS_PER_METER;   // 1 m in scene units (matches ArmUnit.M)
      if (!this._muzzleScratch) this._muzzleScratch = new THREE.Vector3();
      const mz = arm.getNetMuzzleWorldInto(this._muzzleScratch);
      spawnPos = { x: mz.x / M_NET, y: mz.y / M_NET, z: mz.z / M_NET };
    }

    // CEREMONY_REDESIGN §4 / NET_CEREMONY alignment (2026-05-25): see fireMotherNet
    // above for full rationale. Force CINCH so beats 5–6 visuals (ENVELOP, CINCH_CLOSING)
    // actually render during the ceremony — SLAM_WRAP path skips those states.
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
      sourceArm:      arm,           // §3.5: retained for inventory restoration on miss
    });

    this.activeNets.push(net);

    const remaining = (typeof arm.getNetInventory === 'function') ? arm.getNetInventory() : 0;

    eventBus.emit(Events.NET_FIRED, {
      source:   'daughter',
      armIndex,
      // Daughter-net audio fix (2026-08-27): podIndex is EXPLICIT, not absent.
      // AudioSystem's mother gate used to read `data.podIndex < 0` — with the
      // field missing, `undefined < 0 === false`, so a DAUGHTER fire started
      // the mother canister thump + flight-whistle loop, and every pod-gated
      // stop hook then ignored the daughter's terminal events: a leaked
      // whistle until session reset. Gating must be deliberate, never an
      // accident of a missing field.
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

  // ── Queries (ST-9.4e — HUD) ───────────────────────────────────────────

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
   * (Constants.TETHER_TIERS[tier].netMassKg.mother; 1.425 kg at the start tier). Every loaded net weighs the current
   * tier's mass (nets bought before an upgrade count as re-packed: a simplification). The net's flight physics keep
   * CAPTURE_NET.LARGE.MASS.
   */
  getMotherNetMassKg() {
    const row = Constants.TETHER_TIERS[this._motherNetTier];
    const each = (row && row.netMassKg && row.netMassKg.mother) || CN.LARGE.MASS;
    return this.getMotherNetCount() * each;
  }

  /**
   * Line-fibre upgrade (ArmManager.applyTetherUpgrade, the one hub): raise the mother's magazine to `n` nets.
   * Capacity never drops. The loaded count stays as it is (the new cartridges arrive empty and fill at the stop at
   * today's price) unless `fill` is set, which is the save-load path: every launcher full. Emits
   * NET_INVENTORY_CHANGED (mother, with the new podMax) so the launcher face, the HUD and the autopilot follow.
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
   * Spend one mother net for a shot that has really launched (the small-net path in LassoSystem calls this at the point
   * of launch, after every refusal check; fireMotherNet spends its own). One count for both paths, DECISIONS §33 row 1.
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
   * One line when a shot leaves exactly one mother net ("One mother net left." replaces the old "running low at 5"
   * warning). Emitted from here so a lasso shot and a heavy-piece shot both say it, once.
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
   * Set the Mother launcher inventory (persistence restore). Accepts a number
   * or any array (a legacy two-pod save [a, b] is summed), and is capped at
   * the magazine size.
   */
  setMotherPodInventory(counts) {
    const total = this._sumLegacyPodCounts(counts);
    if (total === null) return;
    this._motherPodInventory = [Math.max(0, Math.min(total, this._motherPodMax[0] || 0))];
  }

  /**
   * Sum a saved launcher count: a number, or an array of per-launcher counts
   * (the pre-2026-10-13 save carried [podA, podB]). Non-finite / negative
   * entries count as 0. Returns null when `counts` is neither.
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
   * Load exactly one Large Net into the Mother launcher if it has space (shop
   * restock — one net per 250 cr purchase, matching REPLACEMENT_COST; net
   * ladder Phase B, mirrors the daughters' per-net reload economy).
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
   * Whether the Mother launcher is in its post-fire cooldown. InputManager's
   * pre-slew gate calls this (it was wired behind a `typeof` guard against a
   * method that never existed — mother-net-reel plan §2 C4 — so a cooldown
   * fire used to run the entire aim slew before being refused).
   * @param {number} podIndex
   * @returns {boolean}
   */
  isMotherPodOnCooldown(podIndex) {
    return this.getCooldown('pod', podIndex) > 0;
  }

  /**
   * Net class fired by a mother pod. The lead-aim provider in InputManager
   * calls this for the launch speed (previously hardcoded `10.0 * M` behind
   * another typeof guard — §2 C4 — which silently desynced from any retune).
   * @param {number} podIndex — the one launcher fires LARGE
   * @returns {object} CN.LARGE
   */
  getMotherNetClass(podIndex) { // eslint-disable-line no-unused-vars
    return CN.LARGE;
  }

  /**
   * True when any mother-pod net (podIndex ≥ 0) is in a non-terminal,
   * non-berthed state. Firing a second net from the same launcher frame
   * breaks the VISUAL (the visual map is keyed `pod_${podIndex}` and
   * early-returns when the key exists — mother-net-reel plan §4.5) as well
   * as the physics, so the InputManager refusal gates on this. BERTHED is
   * excluded — a berthed catch has its own per-shot read (S13(e):
   * getCollarShotFoul — firing is never occupancy-refused).
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

  // ── Mercy Rule (§5.7) ─────────────────────────────────────────────────

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

    // Phase 3b: apply the §5.5 credit penalty (waived on the first-time mercy).
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

  // ── Persistence (ST-9.4d — inventory round-trip) ──────────────────────

  /**
   * Get serialisable state for PersistenceManager. `motherPodInventory` is a
   * one-element array [n] since 2026-10-13 (it was [podA, podB]; restoreState
   * still reads the old shape).
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
      // Ensure the magazine max is seeded (init() normally does this before
      // restore, but guard for out-of-order load paths) so the clamp below has
      // a real ceiling. Then clamp the restored total to it — a save written
      // before the net-ladder MAGAZINE_SIZE downsize can carry counts above
      // the cap and must not load an over-max magazine.
      // Owner 2026-10-13: ONE launcher. A legacy two-pod save ([a, b], one
      // count per ±0.45 m pod) is summed and capped: [2, 1] -> [3], [3, 4] -> [4].
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

    // Emit so listeners (launcher caps, HUD NetInventoryPanel) sync to the restored
    // magazine — restore previously mutated inventory silently, leaving any
    // listener showing stale state after a load. Mirrors init()'s emit.
    this._emitMotherInventory(true);
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// §4  Singleton Export
// ═══════════════════════════════════════════════════════════════════════════

/** Singleton CaptureNetSystem instance. */
export const captureNetSystem = new CaptureNetSystem();
export default captureNetSystem;
