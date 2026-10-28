/**
 * CaptureNetVisual.js — 3-D renderer for active capture nets: one mesh group per net, updated every frame from the
 * 14-state NetProjectile FSM in CaptureNet.js.
 * Canister (folded/launching) → spinning disc (flight→capture) + tether line from strut tip to net position.
 * With FEATURE_FLAGS.NET_CEREMONY ON the disc is replaced by a cone mesh, rim weight spheres, drawstring line and
 * apex hub. Gated behind FEATURE_FLAGS.CAPTURE_NET.
 *
 * @module ui/CaptureNetVisual
 */

import * as THREE from 'three';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants, isArmAttachedToMother } from '../core/Constants.js';
import { CeremonyTimeScale } from '../systems/CeremonyTimeScale.js';
import { NetMeshKit } from './NetMeshKit.js';
// The ceremony driver reads the catch's REAL rendered size to floor the drawn bag on its contents.
// ui → entities edge; no cycle (DebrisField does not import CaptureNetVisual).
import { DebrisWireframe } from './DebrisWireframe.js';
import { DebrisField } from '../entities/DebrisField.js';
import { wireBagRadiusM } from './LeashVisual.js';
// Where a held bag's neck sits round its catch: one pure home shared with the simulation (CaptureNet seats a
// daughter's held net there, ArmUnit winds the net line to it).
import { HELD_BAG, DAUGHTER_STAND_M, heldBagRadiusScene, heldBagAxisInto, heldBagBack } from '../entities/heldBagShape.js';
// The reason→beat mapper lives with missReasonToText in the entity (one home for "which failures are staged";
// logic and visual must never diverge). ui → entities edge; no cycle (CaptureNet does not import ui).
import { missFailureKind } from '../entities/CaptureNet.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { clamp01, clamp, lerp, smoothstep01 } from '../core/MathUtil.js';

/** 1 metre in scene units (1 scene unit = 100 km). Same as PlayerSatellite.js */
const M = 1e-5;

const STATES = Constants.CAPTURE_NET.STATES;
const NET_CER = Constants.CAPTURE_NET.NET_CEREMONY;
// ENVELOP_TIME etc.: ceremony-state visuals are driven from net.stateTimer, not the broken `net.tangleQuality`
// proxy (0 throughout ENVELOP / CINCH_CLOSING, set only on the CAPTURED transition).
const CN = Constants.CAPTURE_NET;

// The net fabric is ONE ivory Dyneema colour (COL_DISC) through the whole FSM: a real net cannot change colour on a
// catch. Capture STATE (CONTACT → BRAKE → ENVELOP → CINCH → SECURE → CAPTURED / MISS) lives on the docking reticle /
// HUD (DockingReticle._drawOddsStripInFlight + _netPhaseReadout) and the comms log; only PHYSICAL motion (spin, cinch
// contraction, opacity, slack drift-out fade on a miss) plays on the net. Rim-weight edge-node emissive stays: a
// glint on the tungsten weights, not a recolour of the fabric.
const COL_CANISTER  = 0x556677;
// Mother launcher (DECISIONS §19: ONE launcher, centred, INSIDE the collar bore, firing through it): the folded
// canister is drawn AT the muzzle for the first 0.15 s (LAUNCHING, CAST_WINDUP) while the net has not moved. At the
// shared 0.08 m radius x 0.25 m length (axis ⟂ the flight line: the ceremony group is lookAt-ed so local Y is up and
// −Z is the launch direction) its worst corner reaches hypot(0.125, 0.08) = 0.1484 m from the axis, over the 0.145 m
// the launch corridor allows by 3.4 mm (corridor 0.155 m, set by the fore sun pucks; ring inner edge 0.1597 m).
// Drawn at 0.65: worst corner 0.0965 m (≤ 0.10), so the bundle never overlaps the ring or the pucks. Picture only;
// the net's physics and the daughters' canister are untouched.
export const MOTHER_CANISTER_SCALE = 0.65;
const COL_DISC      = 0xcfeaff;   // ivory Dyneema — the net's ONLY fabric colour, every state
// The tether's colour is Constants.NET_WEB.WEB_COLOR, aliased below as TETHER_BASE_COLOR (cable and net share one
// colour SSOT). The material's base colour and the emissive-pulse reset must share that one source.

// Scratch vectors (no per-frame allocation)
const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _v3c = new THREE.Vector3();
const _v3d = new THREE.Vector3();
// Scratch rotation state and spec for the per-frame contents-BOX spec; the kit COPIES the numbers into a per-handle
// object, so one scratch serves every live net.
const _qA = new THREE.Quaternion();
const _qB = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();
const _vBox = new THREE.Vector3();
const _contentsBoxScratch = { ox: 0, oy: 0, oz: 0,
  r00: 1, r01: 0, r02: 0, r10: 0, r11: 1, r12: 0, r20: 0, r21: 0, r22: 1,
  hx: 0, hy: 0, hz: 0 };
// Result record of _catchContentsSpec (allocation-free).
const _contentsSpecOut = { radius: 0, z: 0, box: null, sizeM: 0 };
// The ship's world attitude, read per frame for a carried bag.
const _qCarry = new THREE.Quaternion();

// Tether catenary: a Line2/LineMaterial fat-line strand (LassoSystem idiom) sampled along a quadratic slack curve.
// Sag is quadratic in the slack ratio: a paying-out tether bows, a taut one snaps straight. At CAPTURED the strand
// goes taut with a 0.2 s decaying lateral twang and pulses emissive above the 2.5 bloom threshold.
// Tunables live in Constants.CAPTURE_NET.NET_TETHER (one tuning surface, §11.8); these aliases keep the hot
// tether/drape loops readable.
const _NT = Constants.CAPTURE_NET.NET_TETHER;
const TETHER_SEGMENTS = _NT.SEGMENTS;
const TETHER_TWANG_S = _NT.TWANG_S;
const TETHER_TWANG_AMP_M = _NT.TWANG_AMP_M;
const TETHER_SAG_FRAC = _NT.SAG_FRAC;
const TETHER_TAUT_SLACK = _NT.TAUT_SLACK;
const TETHER_EMISSIVE_S = _NT.EMISSIVE_S;
const TETHER_EMISSIVE_HDR = _NT.EMISSIVE_HDR;
const TETHER_BASE_COLOR = Constants.NET_WEB.WEB_COLOR;   // one colour SSOT
// §11.2 mouth-collapse (windsock) look constants (thin alias, like _NT).
const _NW = Constants.NET_WEB;

// The held bag + the tether in the near pass. A mother net that closes on a catch is drawn as a compact bag around
// it from the moment the cinch is closed until the hand-off ends. The kit is built as the 6.8 m flight cone (apex at
// the tether end, rim ring at its mouth plane); the reel drew the piece home while that cone stayed full size, so the
// rim ring and strands ran metres past the piece. Sizes are in catch radii (the DRAWN radius: readability floor and
// digestion chop deflation included), so the bag always wraps what is drawn: the apex ball touches the rear of the
// catch, the rim ring sits RIM_AHEAD_FRAC radii past its centre, the open-mouth radius is MOUTH_FRAC radii (the kit
// closes it to DRAWSTRING_RADIUS_FRAC_CLOSED of that, floored onto the catch by its contents floor). The flight cone
// gathers into that shape with the drawstring (CINCH_CLOSING: closed = compact); a bag that lets go un-gathers over
// GATHER_S.
const BAG = {
  GATHER_S: 1.2,
  APEX_BACK_FRAC: HELD_BAG.APEX_BACK_FRAC,   // the apex rule lives in entities/heldBagShape.js
  RIM_AHEAD_FRAC: 1.35,
  MOUTH_FRAC: 3.0,
  MIN_RADIUS_M: HELD_BAG.MIN_RADIUS_M,
  // the rim weights are drawn 0.08 m (8x their ~1 cm tungsten, for the flight read); on a compact bag at a few metres
  // that is a clump of glowing balls bigger than a 0.3 m catch, so a held bag draws them at this radius
  // (estimate: near true size, still a visible bead)
  WEIGHT_RADIUS_M: 0.02,
  // During the leash hand-off the net cinches tight round the catch, so that at the latch the net bag is the size of
  // the wire bag that takes over (LeashVisual: catch radius + its margin): every part of the bag lies on a sphere of
  // that radius round the catch (apex at the rear, rim ring at CINCH_RIM_AHEAD_OF_SPHERE of the radius ahead of the
  // centre, the weights' own radius inside it). The bag eases from the reel's shape to that one as the catch nears
  // the latch point (see _handOffCinch).
  CINCH_RIM_AHEAD_OF_SPHERE: 0.5,
  CINCH_ARRIVED_FRAC: 0.1,             // the cinch is complete when the catch is this close (of its starting distance) to the latch point
  HUB_RADIUS_M: 0.05,                   // the apex hub's drawn radius (measured 0.048 m)
};
// The net tether is drawn like the leash line (LeashVisual): in the near-field pass, where a world-unit width is in
// metres (2 x LEASH.LINE_RADIUS_M = 1 cm). That pass brackets only ±10 m (SceneManager NEAR_FIELD_RADIUS) around the
// ship, so a line with an end farther than that stays in the far pass, at the same true width (x M in the 1e5 m/unit
// scene). The test is the FARTHEST END of the line from the ship, not its length: a daughter net's short line hangs
// from a muzzle far from the mother, and a mother line from the collar reaches 1+ m beyond its own length. In when
// both ends are within 8.5 m, out beyond 9.5 m (the gap stops a line near the limit hopping between the two passes).
const TETHER_NEAR_ON_M = 8.5;
const TETHER_NEAR_OFF_M = 9.5;

// owner 2026-10-16: net and debris must not disappear after capture. The net bag stays drawn round the catch (true
// size, see CaptureNet._catchFloorScale) until the latch removes the net, so the reel and hand-off are seen.

// Kit-frame attitude helper. The floor/chord maths and the pixel gate see the catch's attitude in KIT space:
// `qB2K = qKit⁻¹ ⊗ axisAngle(tumbleAxis, tumbleAngle)`, where `qKit` is the kit group's WORLD quaternion, set by
// `group.lookAt(position − launchDirection × ε)` in `_updateCeremonyState` (local −Z = launchDirection, up = +Y).
// A dev harness wanting a REPEATABLE attitude must pin the tumble in the kit frame, not the world frame, or every
// staging bearing yields a different measured attitude.
// This is that one conversion, using the IDENTICAL `Object3D.lookAt` call as the drawing path (never a hand-rolled
// basis: three's degenerate-up handling is part of the convention). Pure, allocation-light: one scratch Object3D.
const _kitFrameProbe = new THREE.Object3D();
const _qKit = new THREE.Quaternion();
const _qDesired = new THREE.Quaternion();
const _vKitAxis = new THREE.Vector3();
const _vKitDir = new THREE.Vector3();
const _mKitRows = new THREE.Matrix4();

/** Finite 3-vector read that accepts {x,y,z} or [x,y,z]; null on any non-finite. */
function _readFiniteVec3(v, out) {
  if (!v) return null;
  const x = v.x ?? v[0], y = v.y ?? v[1], z = v.z ?? v[2];
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  out.set(x, y, z);
  // NaN cannot reach here, so a plain magnitude test is sound (`lengthSq() < eps` alone would MISS NaN, and a NaN
  // pin would pass the harness's 10° attitude check too: `NaN > 10` is false).
  return out.lengthSq() < 1e-24 ? null : out.normalize();
}

/**
 * World-frame axis/angle that seats a body at a chosen KIT-frame attitude.
 *
 * @param {{x:number,y:number,z:number}} launchDirection — the net's frozen launch bearing (any non-zero length).
 * @param {{x:number,y:number,z:number}} kitAxis — desired rotation axis, KIT frame (kit −Z is the launch bearing,
 *        so kit X/Y lie across the bag mouth).
 * @param {number} kitAngleRad — desired rotation angle about `kitAxis`.
 * @returns {{axis:{x:number,y:number,z:number}, angle:number,
 *            worldQuat:{x:number,y:number,z:number,w:number}}|null}
 *          `axis` (unit) + `angle` to write into `tumbleAxis`/`tumbleAngle`, plus the composed world quaternion
 *          (lossless decomposition; asserted in test-CaptureNetVisual.js). `null` on ANY degenerate or non-finite
 *          input — never a silently wrong pin (a wrong-but-plausible attitude reads as a valid gate measurement).
 *          Guarantees `qKit⁻¹ ⊗ axisAngle(axis, angle) === axisAngle(kitAxis, kitAngleRad)`.
 */
export function worldTumbleForKitAttitude(launchDirection, kitAxis, kitAngleRad) {
  if (!Number.isFinite(kitAngleRad)) return null;
  if (!_readFiniteVec3(launchDirection, _vKitDir)) return null;
  if (!_readFiniteVec3(kitAxis, _vKitAxis)) return null;

  _kitFrameProbe.position.set(0, 0, 0);
  _kitFrameProbe.quaternion.identity();
  _kitFrameProbe.lookAt(-_vKitDir.x * 0.001, -_vKitDir.y * 0.001, -_vKitDir.z * 0.001);
  _qKit.copy(_kitFrameProbe.quaternion);

  _qDesired.setFromAxisAngle(_vKitAxis, kitAngleRad);
  _qKit.multiply(_qDesired);            // qTumble(world) = qKit ⊗ R_desired(kit)

  // Axis/angle decomposition (same shape as CaptureNet._applyCatchOrientation).
  const w = clamp(_qKit.w, -1, 1);
  const angle = 2 * Math.acos(w);
  const s = Math.sqrt(Math.max(0, 1 - w * w));
  const axis = (s > 1e-6)
    ? { x: _qKit.x / s, y: _qKit.y / s, z: _qKit.z / s }
    : { x: 0, y: 1, z: 0 };
  return { axis, angle, worldQuat: { x: _qKit.x, y: _qKit.y, z: _qKit.z, w: _qKit.w } };
}

/**
 * The contents-box spec ROWS for a KIT-frame attitude: the matrix of `qB2K⁻¹` in the box spec's row order
 * (`v_box = R · v_kit`).
 *
 * ONE home for the row/transpose convention: the driver's per-frame composition writes these same nine numbers from
 * the LIVE tumble, and the harness compares that live spec against this output; two copies would let the check
 * validate against a stale one.
 *
 * @param {{x:number,y:number,z:number}} kitAxis — rotation axis, KIT frame.
 * @param {number} kitAngleRad — rotation angle about `kitAxis`.
 * @returns {number[]|null} `[r00, r01, r02, r10, r11, r12, r20, r21, r22]`, or `null` on degenerate/non-finite input.
 */
export function boxRowsForKitAttitude(kitAxis, kitAngleRad) {
  if (!Number.isFinite(kitAngleRad)) return null;
  if (!_readFiniteVec3(kitAxis, _vKitAxis)) return null;
  _qDesired.setFromAxisAngle(_vKitAxis, kitAngleRad).invert();
  const e = _mKitRows.makeRotationFromQuaternion(_qDesired).elements;   // column-major
  return [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]];
}

/**
 * Unique visual key + lookup metadata from an event payload. Daughter-arm nets carry armIndex ≥ 0; mother-pod nets
 * carry podIndex ≥ 0 with armIndex absent or -1.
 * @returns {{ key: string, armIndex: number, podIndex: number }}
 */
function resolveNetId(payload) {
  const ai = payload.armIndex;
  const pi = payload.podIndex;
  if (ai != null && ai >= 0) return { key: `arm_${ai}`, armIndex: ai, podIndex: -1 };
  if (pi != null && pi >= 0) return { key: `pod_${pi}`, armIndex: -1, podIndex: pi };
  // Fallback — treat as arm 0
  return { key: 'arm_0', armIndex: 0, podIndex: -1 };
}

export class CaptureNetVisual {
  constructor() {
    /** @type {THREE.Scene|null} */
    this._scene = null;
    /** @type {import('../entities/PlayerSatellite.js').PlayerSatellite|null} */
    this._player = null;
    /** @type {import('../entities/CaptureNet.js').CaptureNetSystem|null} */
    this._captureNetSystem = null;
    /** @type {boolean} */
    this._enabled = false;
    /**
     * Active visual entries keyed by composite string ('arm_0', 'pod_0', etc.)
     * @type {Map<string, {group:THREE.Group, canisterMesh:THREE.Mesh, discMesh:THREE.Mesh, tetherLine:THREE.Line, tetherPositions:Float32Array, armIndex:number, podIndex:number}>}
     */
    this._activeVisuals = new Map();
    /** @type {boolean} */
    this._disposed = false;
    /** @type {Array<{key:string, timer:number, duration:number}>} */
    this._fadeTimers = [];
    /** @type {Set<*>} ids of catches whose net rides with them (a carried bag): see `wearsNet` */
    this._nettedIds = new Set();
    /** @type {string} Current quality tier (LOW drops the garnish, §11.8). */
    this._tier = 'HIGH';

    /** @type {boolean} Cached ceremony flag — frozen at construct time (§2.4.1) */
    this._useCeremony = !!Constants.FEATURE_FLAGS.NET_CEREMONY;

    this._boundNetFired = null;
    this._boundNetAdopted = null;
    this._boundNetCaught = null;
    this._boundNetMiss = null;
    this._boundReelCompleted = null;
    this._boundNetReleased = null;
    this._boundNetTorn = null;
    this._boundNetFailed = null;
    this._boundTierChanged = null;
    this._boundArmDocked = null;
    this._boundCarryCancel = null;
    this._boundCarryReset = null;
  }

  /**
   * Initialise the visual system. No-ops if CAPTURE_NET flag is false.
   * @param {object} player   — PlayerSatellite instance
   * @param {object} captureNetSystem — CaptureNetSystem singleton
   * @param {object} [sceneManager] — optional; backs the LOW-tier garnish gate (twang, drape jiggle, tether pulse,
   *   pendulum, micro-shake drop at LOW; structure stays). Live changes arrive via PERF_TIER_CHANGED.
   * @param {THREE.Object3D} [freeScene] — optional real scene; with it, a visual carried by a daughter follows HER
   *   drawing (see `_seatUnderCarrier`), while `scene` (the mother's carried root) holds everything the mother carries.
   */
  init(scene, player, captureNetSystem, sceneManager = null, freeScene = null) {
    if (!Constants.FEATURE_FLAGS.CAPTURE_NET) return;

    this._scene = scene;
    this._freeScene = freeScene || null;   // the real scene: a net / bag a FREE daughter carries hangs here, not under the mother's (hideable) root
    this._player = player;
    this._captureNetSystem = captureNetSystem;
    this._sceneManager = sceneManager;   // camera source for depth shading
    this._enabled = true;
    this._disposed = false;

    this._boundNetFired      = this._onNetFired.bind(this);
    this._boundNetCaught     = this._onNetCaught.bind(this);
    this._boundNetMiss       = this._onNetMiss.bind(this);
    this._boundReelCompleted = this._onReelCompleted.bind(this);
    this._boundNetReleased   = this._onNetReleased.bind(this);
    this._boundNetTorn       = this._onNetTorn.bind(this);
    this._boundNetFailed     = this._onNetFailed.bind(this);
    this._boundCargoDone     = this._onCargoTransferred.bind(this);
    this._boundNetConsumed   = this._onNetConsumed.bind(this);
    this._boundTierChanged   = (p) => { this._tier = p?.to ?? this._tier; };

    eventBus.on(Events.NET_FIRED,          this._boundNetFired);
    // An ADOPTED lasso catch (fresh net born BERTHED at the collar; adoptLassoCatch suppresses NET_FIRED and the
    // launch spectacle) still needs its BAG: same creation path, duplicate/supersede guard and update-loop staging;
    // otherwise it renders as a bare floored icosahedron through berth + digestion.
    this._boundNetAdopted = this._onNetFired.bind(this);
    eventBus.on(Events.NET_ADOPTED,        this._boundNetAdopted);
    eventBus.on(Events.NET_CATCH_SUCCESS,  this._boundNetCaught);
    eventBus.on(Events.NET_CATCH_MISS,     this._boundNetMiss);
    eventBus.on(Events.NET_REEL_COMPLETED, this._boundReelCompleted);
    eventBus.on(Events.NET_RELEASED,       this._boundNetReleased);
    eventBus.on(Events.NET_TORN,           this._boundNetTorn);
    eventBus.on(Events.NET_FAILED,         this._boundNetFailed);
    eventBus.on(Events.CARGO_TRANSFER_COMPLETE, this._boundCargoDone);
    eventBus.on(Events.NET_CONSUMED,       this._boundNetConsumed);
    eventBus.on(Events.PERF_TIER_CHANGED,  this._boundTierChanged);
    // The daughter's carried bag (see _beginCarry) ends on the daughter's own signals, never on a timer.
    this._boundArmDocked   = this._onArmDocked.bind(this);
    this._boundCarryCancel = this._onBreakdownCancel.bind(this);
    this._boundCarryReset  = this._onCarryReset.bind(this);
    eventBus.on(Events.ARM_DOCKED,              this._boundArmDocked);
    eventBus.on(Events.CATCH_BREAKDOWN_CANCEL,  this._boundCarryCancel);
    eventBus.on(Events.GAME_RESET,              this._boundCarryReset);
    eventBus.on(Events.GAMEOVER_CONTINUE,       this._boundCarryReset);
    this._tier = sceneManager?.currentTier ?? 'HIGH';
  }

  /**
   * True when the current quality tier keeps a garnish item (§11.8). LOW keeps structure (net web, tether, cinch) and
   * drops tether twang, drape jiggle, tether emissive pulse, berthed pendulum, camera micro-shake. Every garnish
   * item reads this gate (its own constant lives in Constants.CAPTURE_NET).
   * @returns {boolean}
   * @private
   */
  _garnishOn() {
    return this._tier !== 'LOW';
  }

  /**
   * Active NetProjectile for a visual entry (getActiveNetForArm for daughter arms, getActiveNetForPod for mother pods).
   * @returns {object|null}
   * @private
   */
  _getNet(armIndex, podIndex) {
    if (armIndex >= 0) return this._captureNetSystem.getActiveNetForArm(armIndex);
    if (podIndex >= 0) return this._captureNetSystem.getActiveNetForPod(podIndex);
    return null;
  }

  /** @private */
  _onNetFired(payload) {
    const { key, armIndex, podIndex } = resolveNetId(payload);
    const existing = this._activeVisuals.get(key);
    if (existing) {
      // A DYING bag must not block the next net's visual: a staged failure holds the key for the beat + fade (~2.4 s),
      // the legacy miss for 1.0 s, and COOLDOWN_MISS is 1 s, so a re-fire would find the key taken and render NO bag.
      // A new net for the same launcher supersedes a bag that is only fading/detached; a live one still wins (the
      // duplicate-NET_FIRED guard).
      if (!existing.detached && !existing.failure && !existing.fadingOut) return;
      this._removeNetVisual(key);
    }
    const net = this._getNet(armIndex, podIndex);
    if (!net) return;
    this._createNetVisual(key, armIndex, podIndex, net);
  }

  /** @private
   * A successful catch no longer repaints the net (real Dyneema does not flash green on grip): CAPTURED lives on the
   * reticle/HUD (DockingReticle) and the comms log. A documented no-op so the NET_CATCH_SUCCESS subscription +
   * dispose() symmetry stay intact.
   */
  _onNetCaught(_payload) { /* capture state shown on the reticle/HUD, not the mesh */ }

  /** @private Miss: the net goes slack and drifts off, fading out (no recolour; the MISS reason is spoken on the
   * comms log / reticle).
   * A STAGED reason (bounce/slip — missFailureKind) arms a per-visual beat instead of fading at once: the bag holds
   * at the contact point (the system's auto-reel is deferred for the same window), the drape driver plays the beat,
   * and the fade is pushed only when the beat completes, so the failure plays at full opacity. Unstaged reasons fade
   * immediately. Ceremony visuals only: the flag-off disc path has no kit drives to stage. */
  _onNetMiss(payload) {
    const { key } = resolveNetId(payload);
    const vis = this._activeVisuals.get(key);
    const kind = missFailureKind(payload?.reason);
    if (vis && kind && vis.kitHandle) {
      vis.failure = {
        kind,
        t: 0,
        dur: Constants.CAPTURE_NET.FAILURE_STAGING_S ?? 1.4,
        // The drape/cinch the failure found the bag in: a cinch-path bounce starts welded (the sweep's endpoint held
        // through SECURE_CHECK) and releases; a slam-path bounce starts at the cone (SECURE_CHECK does not pre-weld the
        // slam path) and slaps. cinch is the beat's last-driven value for the furniture.
        drape0: vis.kitHandle._drape || 0,
        cinch0: vis.kitHandle._cinchFrac || 0,
        cinch: vis.kitHandle._cinchFrac || 0,
      };
      return;   // the fade is pushed when the beat completes (see update)
    }
    this._fadeTimers.push({ key, timer: 1.0, duration: 1.0 });
  }

  /** @private
   * A successful daughter catch reaches NET_REEL_COMPLETED at the HOLDING_CATCH *chop* boundary (the held net stows
   * once the arm clears `debris._capturedByArm` — see ArmUnit._updateHoldingCatch): the daughter is ALREADY home,
   * parked at her strut tip, with the catch still full-size in the bag.
   *
   * owner notes 2026-09-30: the net must not vanish at the daughter's re-dock. A DELIVERED catch (capturedMass > 0)
   * puts the bag into CARRY (_beginCarry): it keeps following the catch, deflating with the chop like the collar's
   * bag, and only then fades — see _endCarry. A LOST catch (releasedMass > 0: slip, rip, tether-snap drift-end,
   * reset drop) keeps the freeze-fade. Empty (miss) reels remove immediately — the miss fade timer owns that path.
   */
  _onReelCompleted(payload) {
    const { key, armIndex, podIndex } = resolveNetId(payload);
    // A MOTHER catch transitions to BERTHED on reel completion: the cinched bag must PERSIST at the launcher (with a
    // short taut tether stub), not fade. Removal happens on NET_RELEASED (jettison) or when the securing timer
    // splices the net out of activeNets (the update loop's _getNet → null path).
    if (podIndex >= 0) return;
    const vis = this._activeVisuals.get(key);
    // A failure beat owns the bag: the daughter's net stows (and this event fires) when the arm releases the catch on
    // a slip/rip, but the staged failure must play out, not be cut short by the success hand-off fade. Checked
    // BEFORE the payload's mass: a failure stow zeroes capturedMass, so the guard cannot depend on the mass branch.
    if (vis && vis.failure) return;  // failure beat in flight — it owns the fade
    // delivered → the bag stays with the catch.
    if (vis && payload && payload.capturedMass > 0) {
      if (vis.carry) return;                   // duplicate event — already carrying
      this._beginCarry(key, vis, armIndex);
      return;
    }
    // A failure stow reports capturedMass 0 + releasedMass kg. The one UNSTAGED loss (tether-snap drift-end, no
    // failure beat) must still hand the runaway's bag to the fade, not pop it on the spot.
    const massHome = payload && payload.releasedMass > 0;
    if (vis && massHome) {
      vis.detached = true;   // state-driven updates stop; fade timer owns removal
      this._fadeTimers.push({ key, timer: 0.8, duration: 0.8 });
      return;
    }
    this._removeNetVisual(key);
  }

  /**
   * Enter CARRY: the daughter's net has stowed (its NetProjectile is gone) but the catch it holds is still on her
   * rack, so the bag stays and follows the catch instead of fading under it.
   *
   * Release rule (owner: "keep it until stowed"): the bag fades once BOTH hold — the daughter is docked AND the
   * catch has left the bag. `docked` starts TRUE: a delivered stow (capturedMass > 0) is only ever emitted from
   * HOLDING_CATCH, i.e. after the daughter reached her strut tip. ARM_DOCKED (emitted only after her reload, when
   * the rack is empty) is the backstop for both flags. The catch has left when its chop is over (the body is
   * consumed), the feed-end NET_CONSUMED lands, a cancel/reset drops the rack, or the debris is gone.
   * @private
   */
  _beginCarry(key, vis, armIndex) {
    const net = this._getNet(armIndex, -1);
    vis.detached = true;              // the NetProjectile is gone — state-driven updates stop
    vis.carry = {
      debris: vis._catchDebris || (net && net.targetDebris) || null,
      docked: true,                   // see above: delivered ⇒ already home
      left: false,                    // the catch is still in the bag
      ended: false,
    };
    // Seat the bag ship-fixed where it is NOW: the catch is pinned ship-fixed at the strut tip, and re-seating at the
    // tip node would jump the bag by the rack's lateral bias.
    this._captureDetachSeat(vis);
    // …and ship-fixed in ATTITUDE: the bag turns with the ship it rides (ship⁻¹ × bag now, ship × local later).
    vis._carryQuatLocal = null;
    if (vis.group && this._shipWorldQuat(_qCarry)) {
      vis._carryQuatLocal = _qCarry.invert().multiply(vis.group.quaternion).clone();
    }
    // The stowed net's tether is spooled — nothing runs strut tip → bag any more.
    if (vis.tetherLine) vis.tetherLine.visible = false;
  }

  /**
   * @private The ship's world attitude into `out`, or null when the player exposes none (bare test mocks).
   * PlayerSatellite is a THREE.Group.
   */
  _shipWorldQuat(out) {
    const p = this._player;
    if (p && typeof p.getWorldQuaternion === 'function') return p.getWorldQuaternion(out);
    if (p && p.quaternion) return out.copy(p.quaternion);
    return null;
  }

  /**
   * One of the release conditions came true: starts the normal 0.8 s fade once docked AND left.
   * @private
   */
  _endCarry(key, vis, flags) {
    const c = vis && vis.carry;
    if (!c || c.ended) return;
    if (flags.docked) c.docked = true;
    if (flags.left) c.left = true;
    if (!(c.docked && c.left)) return;
    c.ended = true;
    this._fadeTimers.push({ key, timer: 0.8, duration: 0.8 });
  }

  /** @private Resolve the arm key for an ARM_DOCKED / CANCEL payload ({armId} or {armIndex}). */
  _armKeyFor(payload) {
    const idx = this._armIndexFor(payload);
    return idx >= 0 ? `arm_${idx}` : null;
  }

  /** @private The arm index an ARM_DOCKED / CANCEL payload names ({armIndex} or {armId}), else -1. */
  _armIndexFor(payload) {
    if (payload && payload.armIndex != null && payload.armIndex >= 0) return payload.armIndex;
    const id = payload && payload.armId;
    const arms = this._player && this._player.armManager && this._player.armManager.arms;
    if (id && arms) {
      const idx = arms.findIndex((a) => a && a.id === id);
      if (idx >= 0) return idx;
    }
    return -1;
  }

  /** @private End EVERY rack carry of one daughter (rack empty / dropped / reset: events that name the arm, not a piece). */
  _endRackCarries(armIndex, flags) {
    if (armIndex == null || armIndex < 0) return;
    for (const [key, vis] of this._activeVisuals) {
      if (vis.carry && vis.carry.rack && vis.carry.armIndex === armIndex) this._endCarry(key, vis, flags);
    }
  }

  /** @private The daughter reports docked (reload done: her rack is empty). */
  _onArmDocked(payload) {
    const key = this._armKeyFor(payload);
    const vis = key && this._activeVisuals.get(key);
    if (vis && vis.carry) this._endCarry(key, vis, { docked: true, left: true });
    this._endRackCarries(this._armIndexFor(payload), { docked: true, left: true });
  }

  /** @private A mid-cook cancel dropped the rack: nothing left to carry. Today only the COLLAR emits
   * CATCH_BREAKDOWN_CANCEL (armId 'mother', which resolves to no arm ⇒ no-op here); kept as a harmless guard. */
  _onBreakdownCancel(payload) {
    const key = this._armKeyFor(payload);
    const vis = key && this._activeVisuals.get(key);
    if (vis && vis.carry) this._endCarry(key, vis, { docked: true, left: true });
    this._endRackCarries(this._armIndexFor(payload), { docked: true, left: true });
  }

  /** @private Mission reset: every rack is dropped, no completion event will come. */
  _onCarryReset() {
    this._nettedIds.clear();   // a reused debris id after a reset is a new catch
    for (const [key, vis] of this._activeVisuals) {
      if (vis.carry) this._endCarry(key, vis, { docked: true, left: true });
    }
  }

  /**
   * Per-frame drive of a carried bag (the NetProjectile is gone, so no FSM does this). Deflates the bag WITH the chop
   * (the collar's rule: the SAME `_catchContentsSpec` + FT.chopScaleMul ramp, phase from the catch's own
   * `_digestProgress`, the clock ArmUnit's HOLDING_CATCH writes), and hands the spent bag to the fade at chop end.
   * @private
   */
  _driveCarriedBag(key, vis, dt) {
    const c = vis.carry;
    if (!c || c.ended) return;
    const d = c.debris;
    if (d) {
      // The rack let go without an event this visual hears (reset drop, a salvage path): ArmUnit/ArmManager write
      // `_armPinned = false` on every release, and `alive = false` when the piece is gone.
      if (d.alive === false || d._armPinned === false) {
        this._endCarry(key, vis, { docked: true, left: true });
        return;
      }
    }
    const FT = Constants.FURNACE_TRANSFER;
    let phaseT = null;
    if (d && d._breakdownActive && d._digestProgress != null && d.mass > 0) {
      phaseT = Math.min(FT.FEED_S, (d._digestProgress / FT.digestSpanS(d.mass)) * FT.FEED_S);
    }
    if (phaseT != null && phaseT >= FT.CHOP_S) {
      // Chop end: the body is consumed and the bag has deflated with it — hand the spent bag to the fade, do not
      // hold an invisible spike through the whole feed phase.
      this._endCarry(key, vis, { left: true });
      return;
    }
    if (vis.kitHandle && d && d._scenePosition) {
      // The seat/attitude were just written to vis.group; the kit's updateMatrixWorld inside _catchContentsSpec does
      // not refresh its PARENT, so refresh from the bag group down first.
      if (vis.group) vis.group.updateMatrixWorld(true);
      const chopMul = (phaseT != null) ? FT.chopScaleMul(phaseT) : null;
      const cs = this._catchContentsSpec(vis, d, chopMul);
      vis.kitHandle._jigglePhase = vis.kitHandle._jigglePhase || 0;
      NetMeshKit.updateWebDrape(vis.kitHandle, {
        drape: 1,
        cinchFrac: 1,                 // welded shrink-wrap, no jiggle (the held bag's rest)
        jigglePhase: vis.kitHandle._jigglePhase,
        jiggleAmp: 0,
        contentsRadius: cs.radius,
        contentsZ: cs.z,
        contentsBox: cs.box,
        catchSizeM: cs.sizeM,
        localCamPos: this._sceneManager?.camera
          ? vis.kitHandle.group.worldToLocal(_v3c.copy(this._sceneManager.camera.position))
          : undefined,
      });
      // a small catch shows through the threads on a carried bag as on the collar's and the reel's (the film is hidden
      // for it; `updateWebDrape` rewrites the film's opacity, never its visibility)
      if (vis.kitHandle.membraneMesh && this._smallCatchFilm(d)) vis.kitHandle.membraneMesh.visible = false;
    }
  }

  /**
   * The hand-off landed: the piece is now on a daughter's cargo rack and the mother's net has been spliced out of
   * `activeNets`. Without this the bag would POP (the update loop's `_getNet → null` path removes a vanished net's
   * visual at once): freeze the bag where it arrived and fade it over 0.8 s (like the daughter's furnace hand-off at
   * NET_REEL_COMPLETED), so the equipment leaves on camera while the CARGO stays pinned at the strut tip by the rack.
   * Continuity law: the catch never stops being drawn.
   */
  _onCargoTransferred(payload) {
    // A daughter's RACK catch went to a radiator tip. Its bag (`rack_<arm>_<id>`) now belongs to the tip: the
    // daughter's ARM_DOCKED / breakdown cancel / reset-by-arm must no longer end it (they end "every carry of that
    // arm", which would also be the OTHER cell's net). It ends as a tip catch's does: chop end (the tip's own clock),
    // release (`_armPinned === false`) or removal. A real `podIndex` is never involved: nothing to fade below.
    if (payload && payload.to && payload.to.kind === 'tip' && payload.fromArmIndex >= 0 && payload.debrisId != null) {
      const rkey = `rack_${payload.fromArmIndex}_${payload.debrisId}`;
      let rv = this._activeVisuals.get(rkey);
      if (!rv) {
        // A catch the daughter netted HERSELF still has her own live net (`arm_N`: held in REELING through
        // HOLDING_CATCH). This event is her releasing it to the tip, mid-update, one step before that net stows (and,
        // with nothing delivered, would freeze-fade the bag on the spot). Hand the bag to the catch exactly as a
        // mother's bag arriving on her rack is: re-keyed `rack_<arm>_<id>`, wrapped as it is now, seated from the catch
        // each frame. Only her own live bag of THIS piece.
        const akey = `arm_${payload.fromArmIndex}`;
        const av = this._activeVisuals.get(akey);
        const anet = av && !av.detached && !av.failure ? this._getNet(av.armIndex, av.podIndex) : null;
        const ad = anet && anet.targetDebris;
        if (ad && ad.id === payload.debrisId && this._carryOnRack(akey, av, payload.fromArmIndex, payload.debrisId, -1)) {
          rv = this._activeVisuals.get(rkey);
        }
      }
      if (rv && rv.carry && rv.carry.rack) { rv.carry.armIndex = -1; rv.carry.tipIndex = payload.to.tipIndex; }
    }
    // CUT_AT_NOSE: a cut piece's completion carries `cut` — it rode NET-LESS (no bag was ever made for it), and
    // podIndex names the collar it came FROM, whose boss bag must keep rendering. Nothing to fade here.
    if (payload?.cut) return;
    const pi = payload?.podIndex;
    if (pi == null || pi < 0) return;
    const key = `pod_${pi}`;
    const vis = this._activeVisuals.get(key);
    if (!vis) return;
    // owner 2026-10-24: no "net bubble" round the debris after the reel-in to the collar. A mother catch the leash
    // latches on a radiator tip keeps ITS OWN NET as the bag, as a catch on a daughter's rack does; it does not fade
    // and LeashVisual draws no wire sphere round it (`wearsNet`). It rides the catch on the tip (re-keyed
    // `rack_-1_<id>`; `armIndex -1`, so no daughter's ARM_DOCKED ends it) and ends as a tip catch's bag does: chop
    // end, release (`_armPinned === false`) or removal. Net-less: a cut piece returned above.
    if (payload.to && payload.to.kind === 'tip' && payload.debrisId != null
        && this._carryOnRack(key, vis, -1, payload.debrisId, pi)) {
      const tv = this._activeVisuals.get(`rack_-1_${payload.debrisId}`);
      if (tv && tv.carry) tv.carry.tipIndex = payload.to.tipIndex;
      return;
    }
    // DECISIONS §28 row 6 (owner 2026-10-18 "net is not visible after reel-in"): onto a DAUGHTER's rack
    // (`armIndex >= 0`) the bag does not fade — the net IS the container (CAPTURE_NET.md) and the catch stays in it
    // until it is processed. A leash to a tip (`armIndex -1`) is handled above; this is the net-less fallthrough (no
    // kit / no catch found) that fades.
    if (payload.armIndex != null && payload.armIndex >= 0 && payload.debrisId != null
        && this._carryOnRack(key, vis, payload.armIndex, payload.debrisId, pi)) return;
    this._captureDetachSeat(vis);
    vis.detached = true;      // state-driven updates stop; the fade owns removal
    this._fadeTimers.push({ key, timer: 0.8, duration: 0.8 });
  }

  /**
   * The mother's bag arrives on a daughter's rack with its catch and STAYS: re-keyed to the catch
   * (`rack_<armIndex>_<debrisId>`, not `arm_N`: a rack has two cells and `pod_N` must be free for the next net) and
   * enters CARRY, so the carried-bag drive deflates it with the chop and fades it at chop end. Each frame it is seated
   * from the catch's own `_scenePosition` (see the detached branch of update), so a strut swing or a rack slide
   * carries it along. It ends per piece: chop end, release (`_armPinned === false`), removal (`alive === false`),
   * or a NET_CONSUMED that names the piece; ARM_DOCKED / the breakdown cancel end every carry of that arm.
   * @param {string} key  the bag's current key (`pod_N`)
   * @param {number} armIndex  the rack's daughter
   * @param {number} podIndex  the collar the bag came from (-1: the daughter's own net)
   * @returns {boolean} true when the bag now stays with the catch (false: no kit / no catch found → caller fades it)
   * @private
   */
  _carryOnRack(key, vis, armIndex, debrisId, podIndex) {
    if (!vis.kitHandle || !vis.group) return false;
    // `podIndex` -1: her OWN net, looked up by her arm
    const net = podIndex >= 0 ? this._getNet(-1, podIndex) : this._getNet(armIndex, -1);
    // The FIELD's piece, by id (CONVENTIONS Rule H): `net.targetDebris` may be a shallow copy that the rack's pins never
    // reach, which would leave the bag seated on a frozen position and blind to `_nearProxy`.
    const hint = (net && net.targetDebris) || vis._catchDebris || null;
    const d = this._fieldPiece(hint && hint.id === debrisId ? hint : { id: debrisId });
    if (!d || d.id !== debrisId || !d._scenePosition) return false;
    const rkey = `rack_${armIndex}_${debrisId}`;
    if (this._activeVisuals.has(rkey)) return false;   // a duplicate event: the first one already carries it
    this._nettedIds.add(debrisId);
    this._activeVisuals.delete(key);
    this._activeVisuals.set(rkey, vis);
    this._fadeTimers = this._fadeTimers.filter((f) => f.key !== key);
    vis.detached = true;
    vis.carry = { debris: d, docked: true, left: false, ended: false, rack: true, armIndex };
    vis._catchDebris = d;
    // Seat the bag on the catch in the CATCH's own frame: the offset bag − catch and the bag's attitude, both turned by
    // the piece's world attitude, so the bag keeps its place round the piece wherever the rack carries and turns it (a
    // rack catch is fixed in the daughter's frame, not the ship's). The numbers are the ones the LAST update recorded
    // (`_noteCatchSeat`): this handler runs inside the capture system's tick, after the catch was pinned for the new
    // frame but before this visual moved the bag, so `group.position − catch` here would carry one frame of the ship's
    // orbital travel (km at warp). Both ends of the recorded offset are from the same frame.
    this._captureDetachSeat(vis);
    vis._rackOffC = null;
    vis._rackQuatC = null;
    if (vis._catchSeatOffC && vis._catchSeatQuatC) {
      vis._rackOffC = vis._catchSeatOffC.clone();
      vis._rackQuatC = vis._catchSeatQuatC.clone();
    } else {
      this._catchFrame(d, _qB);
      vis._rackOffC = new THREE.Vector3().copy(vis.group.position).sub(d._scenePosition)
        .applyQuaternion(_qA.copy(_qB).invert());
      vis._rackQuatC = _qA.copy(_qB).invert().multiply(vis.group.quaternion).clone();
    }
    if (vis.tetherLine) vis.tetherLine.visible = false;   // the line left the collar with the hand-off
    return true;
  }

  /**
   * Does this catch wear its own net bag right now (a live net on it at the collar, a carried net on a rack or a tip)?
   * LeashVisual draws its wire sphere only for a catch that does not: the net IS the bag. A catch that was carried in
   * its net stays "netted" for good, so the wire sphere does not pop in when the carried net ends at chop end. A catch
   * with no net bag (a cut piece that rode net-less, a lassoed catch) is not, and keeps the sphere.
   * @param {{id?:*}|null} d the catch
   * @returns {boolean}
   */
  wearsNet(d) {
    if (!d || d.id == null) return false;
    for (const vis of this._activeVisuals.values()) {
      if (vis.failure) continue;
      const c = this._bagCatch(vis);
      if (c && c.id === d.id) return true;
    }
    return this._nettedIds.has(d.id);
  }

  /**
   * The piece's world attitude (its tumble quaternion, the one DebrisField draws it with; a held piece's tumble is
   * frozen).
   * @returns {THREE.Quaternion} out
   * @private
   */
  _catchFrame(d, out) {
    if (d && d.tumbleAxis) return out.setFromAxisAngle(d.tumbleAxis, d.tumbleAngle || 0);
    return out.identity();
  }

  /**
   * Resolve a piece BY ID through the field (CONVENTIONS Rule H). A net's `targetDebris` or a carry's reference may be a
   * shallow copy / snapshot that gets neither the field's pin writes nor its `_nearProxy` flag; the field's own object
   * does. Falls back to `d` itself when there is no field or it does not know the id.
   * @private
   */
  _fieldPiece(d) {
    if (!d || d.id == null) return d || null;
    const df = this._captureNetSystem && this._captureNetSystem._debrisField;
    let live = null;
    if (df) {
      if (typeof df.getDebrisById === 'function') live = df.getDebrisById(d.id);
      else if (df.debrisMap && typeof df.debrisMap.get === 'function') live = df.debrisMap.get(d.id);
    }
    return live || d;
  }

  /**
   * The collar's digestion consumed the net with the body (NET_CONSUMED carries the pod on the mother path, mirroring
   * the daughter's feed-end consume). Send the bag off with the freeze-fade, seated where the catch was mated.
   * Arm-keyed payloads (the daughter rack's consume) end a carry instead (the bag was carried past
   * NET_REEL_COMPLETED); with no carry in flight they are a no-op.
   * @param {object} payload — { podIndex, ... } for the collar path
   * @private
   */
  _onNetConsumed(payload) {
    const pi = payload?.podIndex;
    if (pi == null || pi < 0) {
      // The daughter rack's feed-end consume: the catch has left the bag. (Normally the chop-end rule in
      // _driveCarriedBag has already handed the bag to the fade; _endCarry is idempotent.)
      const ai = payload?.armIndex;
      if (ai != null && ai >= 0) {
        const akey = `arm_${ai}`;
        const avis = this._activeVisuals.get(akey);
        if (avis && avis.carry) this._endCarry(akey, avis, { left: true });
        // A rack carry ends only on an event that NAMES its piece. The digest's NET_CONSUMED carries just
        // { armIndex, armId } — it must not end a bag whose piece is another cell's; `_driveCarriedBag` ends those per
        // piece (chop end, release, removal).
        if (payload.debrisId != null) {
          const rkey = `rack_${ai}_${payload.debrisId}`;
          const rvis = this._activeVisuals.get(rkey);
          if (rvis && rvis.carry) this._endCarry(rkey, rvis, { left: true });
        }
      }
      return;
    }
    const key = `pod_${pi}`;
    const vis = this._activeVisuals.get(key);
    if (!vis) return;
    // The chop-end handler (ceremony COLLARED case) may have already detached this bag — the fade owns it; a second
    // timer here would re-seat and re-fade a bag that is mid-fade (or gone next frame).
    if (vis.detached) return;
    this._captureDetachSeat(vis);
    vis.detached = true;      // state-driven updates stop; the fade owns removal
    this._fadeTimers.push({ key, timer: 0.8, duration: 0.8 });
  }

  /**
   * @private Remember where the bag is, SHIP-LOCALLY, at the moment it detaches. The detached fade needs a ship-fixed
   * seat: re-seating at the pod muzzle every frame jumped the bag back to the launcher (metres for a transferred
   * piece, up to ~17 m for a collared monster); freezing the world position would streak the bag at orbital speed
   * (the camera co-moves with the ship). Ship-local storage + per-frame localToWorld re-application holds the fade
   * exactly where the net left it.
   */
  _captureDetachSeat(vis) {
    try {
      if (this._player && typeof this._player.worldToLocal === 'function'
          && vis.group && vis.group.position) {
        vis._detachSeatLocal = this._player.worldToLocal(vis.group.position.clone());
        return;
      }
    } catch (_e) { /* fall through to the muzzle seat */ }
    vis._detachSeatLocal = null;
  }

  /** @private
   * Rip staging (owner item 7): the daughter's net TORE under boost reel. The NetProjectile stows + prunes on its next tick, so take
   * the bag over NOW via the detach idiom (the one the furnace hand-off uses) and cut the hole into it: zero a wedge
   * of spokes in the kit's per-vertex colour buffer. The catch, already released by the arm, drifts out of the torn
   * bag; the beat clock hands the bag to the fade when done.
   */
  _onNetTorn(payload) {
    const { key, armIndex, podIndex } = resolveNetId(payload);
    const vis = this._activeVisuals.get(key);
    if (!vis || !vis.kitHandle) return;   // flag-off disc path: no kit to tear, legacy removal
    vis.detached = true;       // we own the bag from here (the projectile is leaving)
    vis.failure = {
      kind: 'rip',
      t: 0,
      dur: Constants.CAPTURE_NET.FAILURE_STAGING_S ?? 1.4,
      cinch: 1,
      // The bag seats on the catch it released (still live this tick — the
      // projectile prunes on its NEXT update), never on the docked strut tip.
      debris: this._getNet(armIndex, podIndex)?.targetDebris || null,
    };
    if (vis.kitHandle) {
      NetMeshKit.tearWedge(vis.kitHandle,
        Constants.CAPTURE_NET.NET_TEAR_SPOKE_START ?? 2,
        Constants.CAPTURE_NET.NET_TEAR_SPOKE_COUNT ?? 5);
    }
  }

  /** @private
   * Slip staging for the daughter's reel-start integrity failure (_checkNetIntegrityOnReel — oversize or strain): the
   * cinched bag releases its catch and opens back toward the flight cone. Same detach idiom as the rip; the
   * boost-reel rip also emits NET_FAILED (cause 'boost_reel') but is owned by _onNetTorn, so it is skipped here.
   */
  _onNetFailed(payload) {
    if (payload?.cause === 'boost_reel') return;   // NET_TORN owns the rip
    const { key, armIndex, podIndex } = resolveNetId(payload);
    const vis = this._activeVisuals.get(key);
    if (!vis || !vis.kitHandle) return;            // flag-off path: legacy fade
    vis.detached = true;
    vis.failure = {
      kind: 'slip',
      t: 0,
      dur: Constants.CAPTURE_NET.FAILURE_STAGING_S ?? 1.4,
      cinch: 1,
      debris: this._getNet(armIndex, podIndex)?.targetDebris || null,
    };
  }

  /** @private */
  _onNetReleased(payload) {
    const { key } = resolveNetId(payload);
    this._removeNetVisual(key);
  }

  /**
   * Create a visual group for one net projectile.
   * @param {string} key            — composite map key ('arm_0', 'pod_0')
   * @param {number} armIndex       — daughter arm index (≥0) or -1
   * @param {number} podIndex       — mother pod index (≥0) or -1
   * @private
   */
  _createNetVisual(key, armIndex, podIndex, netProjectile) {
    if (Constants.FEATURE_FLAGS.NET_CEREMONY) {
      this._createCeremonyVisual(key, armIndex, podIndex, netProjectile);
      return;
    }

    const group = new THREE.Group();
    group.name = `CaptureNetVis_${key}`;
    // Seed the group AT the net on creation: it otherwise sits at the scene origin until the first update tick, and a
    // NET_ADOPTED visual is born AFTER this system's update ran for the frame (adoptLassoCatch fires from
    // lassoSystem.update), so its creation frame would render from the origin. One copy; the per-frame track
    // overwrites it.
    if (netProjectile.position) group.position.copy(netProjectile.position);

    const canGeo = new THREE.CylinderGeometry(M * 0.08, M * 0.08, M * 0.25, 8);
    const canMat = new THREE.MeshStandardMaterial({
      color: COL_CANISTER,
      metalness: 0.6,
      roughness: 0.4,
    });
    const canisterMesh = new THREE.Mesh(canGeo, canMat);
    canisterMesh.name = 'canister';
    if (podIndex >= 0) canisterMesh.scale.setScalar(MOTHER_CANISTER_SCALE);   // mother: folded bundle ≤ 0.10 m radial (see the const)
    group.add(canisterMesh);

    const diameter = netProjectile.netClass.DIAMETER || 8;
    const discGeo = new THREE.CircleGeometry(M * diameter / 2, 16);
    const discMat = new THREE.MeshStandardMaterial({
      color: COL_DISC,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
      wireframe: true,
    });
    const discMesh = new THREE.Mesh(discGeo, discMat);
    discMesh.name = 'disc';
    discMesh.visible = false;
    group.add(discMesh);

    const tetherPositions = new Float32Array((TETHER_SEGMENTS + 1) * 3);
    const tetherGeo = new LineGeometry();
    tetherGeo.setPositions(tetherPositions);
    const tetherMat = new LineMaterial({
      color: TETHER_BASE_COLOR,
      transparent: true,
      opacity: 0.7,
      linewidth: 2.0,          // screen-space px — slim but AA-legible
      worldUnits: false,
      dashed: false,
      blending: THREE.NormalBlending,
      depthWrite: false,
    });
    NetMeshKit.registerLineMaterial(tetherMat);
    const tetherLine = new Line2(tetherGeo, tetherMat);
    tetherLine.name = 'tether';
    tetherLine.visible = false;
    tetherLine.frustumCulled = false;
    tetherLine.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_CONNECTOR;
    // The strand lives in the SCENE, not under `group`: `group` sits at net.position and is turned by lookAt, so a
    // child at `anchor` was drawn at group + anchor (twice the ship's distance from the origin: never on screen) and
    // its world-aligned vertices were rotated with the bag.
    this._scene.add(tetherLine);

    this._scene.add(group);
    this._activeVisuals.set(key, {
      group,
      canisterMesh,
      discMesh,
      tetherLine,
      tetherPositions,
      // The tether's instanced-interleaved buffer (pairs format), captured once so _updateTetherCatenary writes it in
      // place instead of calling LineGeometry.setPositions (double allocation per frame).
      tetherSegBuffer: tetherGeo.attributes.instanceStart.data,
      armIndex,
      podIndex,
      // §11.2 windsock beat clock (flag-OFF disc variant): the disc path derives its scale from it.
      collapseT: 0,
      // catenary state
      _tetherTwangT: -1,        // seconds since line-taut; <0 = no twang
      _tetherEmissiveT: -1,     // seconds since taut pulse; <0 = no pulse
      _tetherWasTaut: false,    // edge detect for the taut snap
    });
  }

  /**
   * Create the ceremony visual group (cone mesh, rim weights, drawstring, apex hub); only when NET_CEREMONY is true.
   * @private
   */
  _createCeremonyVisual(key, armIndex, podIndex, netProjectile) {
    const group = new THREE.Group();
    group.name = `CaptureNetVis_${key}`;
    // Same creation-frame seed as the flag-OFF path (see _createNetVisual): an adopted bag must never spend its birth
    // frame at the scene origin.
    if (netProjectile.position) group.position.copy(netProjectile.position);

    const canGeo = new THREE.CylinderGeometry(M * 0.08, M * 0.08, M * 0.25, 8);
    const canMat = new THREE.MeshStandardMaterial({
      color: COL_CANISTER,
      metalness: 0.6,
      roughness: 0.4,
    });
    const canisterMesh = new THREE.Mesh(canGeo, canMat);
    canisterMesh.name = 'canister';
    if (podIndex >= 0) canisterMesh.scale.setScalar(MOTHER_CANISTER_SCALE);   // mother: folded bundle ≤ 0.10 m radial (see the const)
    group.add(canisterMesh);

    // Cone mesh + rim weights + drawstring + apex hub come from the shared NetMeshKit, which reproduces the
    // daughter's ceremony web 1:1 (cone rotateX/translate, closedRadius, spoke pattern). _updateCeremonyState keeps
    // positioning the kit-owned `rimWeights` with its own tested math. Defaults match the old inline build (16×4 cone,
    // opacity 0.55, COL_DISC, 0.08 m nodes, 0.05 m apex hub).
    const diameter = netProjectile.netClass.DIAMETER || 8;
    const weightCount = netProjectile.netClass.RIM_WEIGHT_COUNT || 4;
    const kitHandle = NetMeshKit.build({
      diameter,
      weightCount,
      // childrenVisible defaults false — the FSM toggles per-state visibility.
      // Fade-able rim-weight glints, so the seeded fade dims them with the rest of the bag instead of popping them at
      // _removeNetVisual (the lasso's mother net is built this way too — LassoSystem). The glints are AdditiveBlending
      // either way, so the transparent flag only moves them between render lists; the drawn frame is identical except
      // where a glint overlaps the catch's silhouette (the additive contribution now lands OVER the catch instead of
      // being overwritten by it).
      weightTransparent: true,
      // The apex hub is fade-able too, so it rides the seeded fade instead of popping (the lasso's mother net is built
      // apexTransparent too). It rests at opacity 1.0, NOT the shared 0.8: NormalBlending + transparent at 1.0 renders
      // identically to the opaque build (src×1 + dst×0, depthWrite unchanged), while 0.8 would turn the hub 20 %
      // see-through in every gated beat.
      apexTransparent: true,
      apexOpacity: 1.0,
    });
    const coneMesh = kitHandle.coneMesh;
    const rimWeights = kitHandle.rimWeights;
    const rimWeightMats = kitHandle.rimWeightMats;
    const drawstringLine = kitHandle.drawstringLine;
    const drawstringPositions = kitHandle.drawstringPositions;
    const apexHub = kitHandle.apexHub;
    group.add(kitHandle.group);

    const tetherPositions = new Float32Array((TETHER_SEGMENTS + 1) * 3);
    const tetherGeo = new LineGeometry();
    tetherGeo.setPositions(tetherPositions);
    const tetherMat = new LineMaterial({
      color: TETHER_BASE_COLOR,
      transparent: true,
      opacity: 0.7,
      // World units: the strand thickens on approach, AA-smooth at distance. This scene is 1 unit = 1e5 m (M = 1e-5),
      // so a true width is metres * M. The true width is the leash line's, 2 x LEASH.LINE_RADIUS_M = 1 cm. This is the
      // FAR-pass width; _tetherPass switches the material to the near-pass width (1 unit = 1 m) while the line is short
      // enough to be drawn there.
      linewidth: 2 * Constants.LEASH.LINE_RADIUS_M * M,
      worldUnits: true,
      dashed: false,
      blending: THREE.NormalBlending,
      depthWrite: false,
    });
    NetMeshKit.registerLineMaterial(tetherMat);
    const tetherLine = new Line2(tetherGeo, tetherMat);
    tetherLine.name = 'tether';
    tetherLine.visible = false;
    tetherLine.frustumCulled = false;
    tetherLine.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_CONNECTOR;
    // Scene child (see the flag-OFF twin above): world-aligned, anchor-relative vertices.
    this._scene.add(tetherLine);

    this._scene.add(group);
    this._activeVisuals.set(key, {
      group,
      canisterMesh,
      discMesh: coneMesh,          // alias for flash-timer compat
      coneMesh,
      kitHandle,                   // owns cone/weights/drawstring/apex geometry+materials
      tetherLine,
      tetherPositions,
      tetherSegBuffer: tetherGeo.attributes.instanceStart.data,   // see the flag-OFF path
      rimWeights,
      rimWeightMats,
      weightGeo: kitHandle.weightGeo,
      drawstringLine,
      drawstringPositions,
      apexHub,
      mouthRadius: kitHandle.mouthRadius,
      coneHeight: kitHandle.coneHeight,
      closedRadius: kitHandle.closedRadius,
      weightCount,
      spinAngle: 0,
      // §11.2 windsock beat state — fresh per fire (_onNetFired supersedes a
      // dying bag, never reuses): seconds since the physics latch, and the
      // cinch fraction the drape driver last derived from it (the FLIGHT
      // weight ring reads it so beads and fabric pinch together).
      collapseT: 0,
      collapseCinch: 0,
      armIndex,
      podIndex,
      useCeremony: true,
      // catenary state
      _tetherTwangT: -1,
      _tetherEmissiveT: -1,
      _tetherWasTaut: false,
    });
  }

  /** Remove and dispose a visual by its composite key. @private */
  _removeNetVisual(key) {
    const vis = this._activeVisuals.get(key);
    if (!vis) return;

    // a bag in the near pass leaves it with its group (never a dead root left in the pass).
    if (vis._bagNear) {
      const sm = this._sceneManager;
      if (sm && typeof sm.unregisterNearFieldRoot === 'function') sm.unregisterNearFieldRoot(vis.group);
      vis._bagNear = false;
    }

    if (vis.group.parent && vis.group.parent !== this._scene) vis.group.parent.remove(vis.group);   // a free daughter's bag hangs on `_freeScene`
    this._scene.remove(vis.group);
    this._scene.remove(vis.tetherLine);       // a scene child, not under the group
    if (this._tetherRoot) this._tetherRoot.remove(vis.tetherLine);   // ... or a child of the near-pass tether root

    vis.canisterMesh.geometry.dispose();
    vis.canisterMesh.material.dispose();

    if (vis.useCeremony) {
      // Ceremony path — cone, weights, drawstring, apex hub are kit-owned.
      NetMeshKit.dispose(vis.kitHandle);
    } else {
      vis.discMesh.geometry.dispose();
      vis.discMesh.material.dispose();
    }

    vis.tetherLine.geometry.dispose();
    NetMeshKit.unregisterLineMaterial(vis.tetherLine.material);
    vis.tetherLine.material.dispose();

    this._activeVisuals.delete(key);

    this._fadeTimers  = this._fadeTimers.filter(f => f.key !== key);
  }

  /**
   * A net / carry bag follows whoever carries it: a daughter's (her net in flight, the bag on her rack, including the
   * carry trip where she flies on her own) hangs on the real scene while SHE is drawn, and on the mother's carried
   * root otherwise, so it is hidden exactly when its carrier is. Mother-carried visuals (pod nets, a bag at a tip)
   * always stay on the root. Moves only when the answer changes.
   * @private
   */
  _seatUnderCarrier(vis) {
    const idx = vis.carry && vis.carry.rack ? vis.carry.armIndex : vis.armIndex;
    let want = this._scene;
    if (idx >= 0) {
      const arms = this._player && this._player.armManager && this._player.armManager.arms;
      const arm = arms && arms[idx];
      if (arm && arm.group && arm.group.visible !== false && !isArmAttachedToMother(arm.state)) want = this._freeScene;
    }
    if (vis.group.parent !== want) want.add(vis.group);
  }

  /**
   * Tick all active net visuals; called from the game loop.
   * @param {number} dt — seconds
   */
  update(dt) {
    if (!this._enabled) return;

    // Ceremony time-dilation (archive/CEREMONY_REDESIGN.md §5, §6 R1) applies to visual dt only; the caller's world dt
    // (main.js → captureNetVisual.update) is unaffected. CeremonyTimeScale.get() === 1.0 when the flag is OFF or no
    // ceremony is active.
    const scale = Constants.FEATURE_FLAGS.NET_CEREMONY ? CeremonyTimeScale.get() : 1.0;
    dt = dt * scale;

    if (this._freeScene) for (const vis of this._activeVisuals.values()) this._seatUnderCarrier(vis);

    for (let i = this._fadeTimers.length - 1; i >= 0; i--) {
      const f = this._fadeTimers[i];
      f.timer -= dt;
      const vis = this._activeVisuals.get(f.key);
      if (f.timer <= 0) {
        this._fadeTimers.splice(i, 1);
        this._removeNetVisual(f.key);
        continue;
      }
      if (vis) {
        const s = Math.max(0, f.timer / f.duration);
        if (vis.kitHandle) {
          // Ride the kit's opacity SSOT so the whole fade-able family (web, membrane, drawstring, rim-weight glints,
          // apex hub) fades together instead of popping at _removeNetVisual, and SEED the fade from each surface's
          // LIVE opacity so the first frame equals the last state-driven frame (the continuity law's "never a pop").
          // The seed is captured lazily on the first tick: the system fires the pushing event synchronously ahead of
          // this tick in the same frame (captureNetSystem.update, then this, in main.js), and no opacity writer runs in
          // between, so the first tick reads exactly the push-time live values. Non-transparent mats are skipped by
          // setOpacityScaled as setOpacity skips them.
          if (f.kitSeed === undefined) f.kitSeed = NetMeshKit.captureOpacity(vis.kitHandle);
          NetMeshKit.setOpacityScaled(vis.kitHandle, f.kitSeed, s);
        } else {
          // Legacy flag-off flat disc: same live-seed contract (0.6 at rest).
          if (f.discSeed === undefined) f.discSeed = vis.discMesh.material.opacity;
          vis.discMesh.material.opacity = s * f.discSeed;
        }
      }
    }

    for (const [key, vis] of this._activeVisuals) {
      // Detached bag (post-chop hand-off): the NetProjectile is gone; keep the fading bag seated at the strut tip
      // (mother's co-orbiting frame) so it doesn't streak away at orbital speed while the fade plays out.
      if (vis.detached) {
        if (vis.failure && vis.failure.debris && vis.failure.debris._scenePosition) {
          // A torn/slipped daughter bag stays on the drifting catch it released (the failure happened out at the
          // daughter, not at the dock), never teleported to the strut tip: it opens/fades in place around the catch.
          vis.group.position.copy(vis.failure.debris._scenePosition);
        } else if (vis.carry && vis.carry.rack && vis._rackOffC && vis._rackQuatC && vis.carry.debris
                   && vis.carry.debris._scenePosition) {
          // A bag carried on a daughter's rack is seated from the CATCH each frame, in the CATCH's own frame (the
          // once-captured ship-fixed seat below would leave it behind when the rack swings or slides, and a ship-frame
          // offset drifts off a catch the strut turns relative to the ship): the offset and attitude taken at the
          // hand-off, turned with the piece's attitude, from the piece's own pinned position.
          const cd = vis.carry.debris;
          this._catchFrame(cd, _qCarry);
          vis.group.position.copy(vis._rackOffC).applyQuaternion(_qCarry).add(cd._scenePosition);
          vis.group.quaternion.copy(_qCarry).multiply(vis._rackQuatC);
        } else if (vis.carry && vis._detachSeatLocal
                   && typeof this._player?.localToWorld === 'function') {
          // The carried bag rides the catch's ship-fixed seat (captured at the hand-off) through the chop AND its
          // fade, so it never jumps to the bare strut tip, and turns with the ship.
          this._player.localToWorld(vis.group.position.copy(vis._detachSeatLocal));
          if (vis._carryQuatLocal && this._shipWorldQuat(_qCarry)) {
            vis.group.quaternion.copy(_qCarry).multiply(vis._carryQuatLocal);
          }
        } else if (vis.armIndex >= 0 && this._player?.strutTipNodes?.[vis.armIndex]) {
          this._player.strutTipNodes[vis.armIndex].getWorldPosition(vis.group.position);
        } else if (vis.podIndex >= 0 && vis._detachSeatLocal
                   && typeof this._player?.localToWorld === 'function') {
          // The fade plays where the net actually left the bag — the collar seat (digestion) or the strut tip
          // (transfer-complete), held ship-fixed. Re-seating at the bare muzzle teleported the bag back to the launcher
          // on the very frame it was meant to leave on.
          this._player.localToWorld(vis.group.position.copy(vis._detachSeatLocal));
        } else if (vis.podIndex >= 0 && typeof this._player?.getNetPodPositionInto === 'function') {
          // Mother-pod catch: seat the fading bag on the pod muzzle (`player.group` is undefined — PlayerSatellite
          // extends THREE.Group — so seating from it would leave a detached mother bag streaking away at 70 km/s).
          this._player.getNetPodPositionInto(vis.podIndex, vis.group.position);
        }
        // Drive the carried bag AFTER this frame's seat + attitude are written, so the contents spec reads the catch
        // against the bag's CURRENT frame. _driveCarriedBag never removes — a carry that ends here is removed by its
        // fade timer, so `vis` stays live below.
        if (vis.carry) this._driveCarriedBag(key, vis, dt);
        // Tick a detached failure beat: the slip's un-cinch drives the kit directly (no state machine remains); the
        // rip's hole is already cut. The fade starts at beat end.
        if (vis.failure) {
          const beat = vis.failure;
          beat.t += dt;
          const f = Math.min(1, beat.t / beat.dur);
          if (beat.kind === 'slip' && vis.kitHandle) {
            const open = Math.max(0, 1 - f);
            NetMeshKit.updateWebDrape(vis.kitHandle, {
              drape: open,
              cinchFrac: open,
              contentsRadius: 0,   // the catch is released — the bag opens empty
              contentsZ: 0,
            });
            beat.cinch = open;
            // The furniture must open WITH the fabric: the state switch never runs for a detached bag, so drive the
            // rim ring/strands here or the weights stay bunched around a bag that has already let go.
            this._stageFailureFurniture(vis);
          }
          if (f >= 1) this._endFailureBeat(key, vis);
        }
        continue;
      }

      const net = this._getNet(vis.armIndex, vis.podIndex);
      if (!net) {
        // A net pruned mid-beat (a very short reel-back under ceremony time-dilation) detaches instead of popping.
        if (vis.failure) { vis.detached = true; continue; }
        this._removeNetVisual(key);
        continue;
      }

      const { group, canisterMesh, discMesh, tetherLine, tetherPositions } = vis;
      const state = net.state;

      // net.position is in metres → × M
      group.position.set(
        net.position.x * M,
        net.position.y * M,
        net.position.z * M,
      );

      if (vis.useCeremony) {
        if (this._updateCeremonyState(key, vis, net, dt)) continue;
      } else {

      switch (state) {
        case STATES.FOLDED:
          canisterMesh.visible = true;
          discMesh.visible = false;
          tetherLine.visible = false;
          break;

        case STATES.LAUNCHING:
          canisterMesh.visible = true;
          discMesh.visible = false;
          tetherLine.visible = true;
          break;

        case STATES.SPINNING_UP: {
          canisterMesh.visible = false;
          discMesh.visible = true;
          tetherLine.visible = true;
          // Open over the spin-up TIME (0→1 across CN.SPIN_UP_TIME), not the spin RATE: it starts at 3× SPIN_HZ and
          // falls to 1× (yo-yo despin), so rate/SPIN_HZ clamped at 1 all along.
          const openFrac = clamp01((net.stateTimer ?? 0) / CN.SPIN_UP_TIME);
          discMesh.scale.setScalar(Math.max(0.05, openFrac));
          discMesh.material.color.setHex(COL_DISC);
          discMesh.material.opacity = 0.6;
          break;
        }

        case STATES.FLIGHT: {
          canisterMesh.visible = false;
          discMesh.visible = true;
          tetherLine.visible = true;
          // §11.2 windsock (flag-OFF flat disc): the mouth IS the disc here — ease its scale down to the slack radius
          // fraction the ceremony rim collapses to (MOUTH_COLLAPSE_CINCH_FRAC of the full drawstring close). Keyed off
          // the one-way physics latch only; collapseT stays 0 for a healthy net.
          if (net.mouthCollapsed) {
            vis.collapseT = Math.min(_NW.MOUTH_COLLAPSE_EASE_S, vis.collapseT + dt);
          }
          const discSlack = (vis.collapseT / _NW.MOUTH_COLLAPSE_EASE_S)
            * _NW.MOUTH_COLLAPSE_CINCH_FRAC * (1 - NET_CER.DRAWSTRING_RADIUS_FRAC_CLOSED);
          discMesh.scale.setScalar(1 - discSlack);
          discMesh.rotation.z += net.spinRate * Math.PI * 2 * dt;
          discMesh.material.color.setHex(COL_DISC);
          discMesh.material.opacity = 0.6;
          break;
        }

        case STATES.CONTACT:
        case STATES.BRAKE:
          canisterMesh.visible = false;
          discMesh.visible = true;
          tetherLine.visible = true;
          discMesh.material.color.setHex(COL_DISC);
          discMesh.material.opacity = 0.6;
          break;

        case STATES.ENVELOP:
          canisterMesh.visible = false;
          discMesh.visible = true;
          tetherLine.visible = true;
          discMesh.scale.setScalar(Math.max(0.3, 1.0 - net.tangleQuality * 0.5));
          discMesh.material.color.setHex(COL_DISC);
          discMesh.material.opacity = 0.6;
          break;

        case STATES.CINCH_CLOSING:
          canisterMesh.visible = false;
          discMesh.visible = true;
          tetherLine.visible = true;
          discMesh.scale.setScalar(Math.max(0.2, 1.0 - net.tangleQuality * 0.7));
          discMesh.material.color.setHex(COL_DISC);
          discMesh.material.opacity = 0.6;
          break;

        case STATES.SECURE_CHECK:
          canisterMesh.visible = false;
          discMesh.visible = true;
          tetherLine.visible = true;
          discMesh.material.opacity = 0.4 + 0.3 * Math.sin(Date.now() * 0.01);
          break;

        case STATES.CAPTURED:
          canisterMesh.visible = false;
          discMesh.visible = true;
          tetherLine.visible = true;
          discMesh.material.color.setHex(COL_DISC);
          discMesh.material.opacity = 0.6;
          break;

        case STATES.MISSED:
          canisterMesh.visible = false;
          discMesh.visible = true;
          tetherLine.visible = true;
          discMesh.material.color.setHex(COL_DISC);
          // Opacity handled by fade timer
          break;

        case STATES.REELING:
          canisterMesh.visible = false;
          discMesh.visible = net.catchResult === 'success';
          tetherLine.visible = true;
          if (discMesh.visible) {
            discMesh.material.color.setHex(COL_DISC);
          }
          break;

        case STATES.COLLARED:
        case STATES.BERTHED:
        case STATES.TRANSFERRING:
          // Mother berth/collar: the cinched bag persists at the launcher with a short taut tether stub. The bag follows
          // net.position — its APEX anchor, which the berth hold keeps at the standoff while the pinned catch rides
          // _catchSeatM metres inside (CaptureNet co-location). COLLARED renders identically: the bag is the container
          // and is never faded while mated (the digestion NET_CONSUMED hands it the freeze-fade idiom). TRANSFERRING
          // renders the same bag, still carrying the catch, but with NO tether: the hand-off leaves the launcher's
          // line, and net.position rides the Bézier, so the bag flies with the catch for free.
          // (Flag-off path — the ceremony switch above has its own case.)
          canisterMesh.visible = false;
          discMesh.visible = true;
          tetherLine.visible = (state !== STATES.TRANSFERRING);
          discMesh.material.color.setHex(COL_DISC);
          discMesh.material.opacity = 0.6;
          break;

        case STATES.STOWED:
        case STATES.RELEASED:
          this._removeNetVisual(key);
          continue; // skip tether update

        default:
          break;
      }

      } // end else (non-ceremony)

      // Tether update: launcher anchor (canister muzzle / pod muzzle) → net
      if (tetherLine.visible && this._player) {
        // Daughter arms anchor at the source arm's net-launcher canister muzzle: the in-flight NET tether runs
        // canister→net. The DAUGHTER-HAUL tether (strut reel cartridge, ArmUnit.getTetherAnchorWorldPosition) is a
        // DIFFERENT tether and stays strut-anchored. Fallback chain: strut tip node (pre-muzzle mocks), mother pod
        // muzzle via getNetPodPositionInto (allocation-free), then getPosition(). `player.group` is undefined
        // (PlayerSatellite extends THREE.Group), so a fallback through it would clone a Vector3 every frame.
        const srcArm = net._sourceArm;
        if (vis.armIndex >= 0 && srcArm
            && typeof srcArm.getNetMuzzleWorldInto === 'function') {
          srcArm.getNetMuzzleWorldInto(_v3a);
        } else if (vis.armIndex >= 0 && this._player.strutTipNodes && this._player.strutTipNodes[vis.armIndex]) {
          this._player.strutTipNodes[vis.armIndex].getWorldPosition(_v3a);
        } else if (vis.podIndex >= 0 && (state === STATES.REELING || state === STATES.BERTHED || state === STATES.COLLARED)
            && typeof this._player.getNetBerthCollarPositionInto === 'function') {
          // the reel winds in on the capture RING (the collar plane, the same anchor the reel pins on), not the launcher
          // muzzle 30 mm behind it
          this._player.getNetBerthCollarPositionInto(_v3a);
        } else if (vis.podIndex >= 0 && typeof this._player.getNetPodPositionInto === 'function') {
          this._player.getNetPodPositionInto(vis.podIndex, _v3a);
        } else if (this._player.getPosition) {
          const pp = this._player.getPosition();
          _v3a.set(pp.x, pp.y, pp.z);
        } else {
          _v3a.set(0, 0, 0);
        }
        _v3b.copy(group.position);

        this._updateTetherCatenary(vis, net, _v3a, _v3b, dt);
      }
    }

    // a bag round a HELD piece is drawn in the pass the piece is drawn in.
    for (const vis of this._activeVisuals.values()) this._bagPass(vis);
  }

  /**
   * The piece a bag wraps, whichever state the bag is in (a carried bag names it, a failure beat names it, a live net
   * has it as its target, a bag whose net is gone remembers it from the reel). Always the FIELD's own object for that
   * id (`_fieldPiece`): the reference a net holds may be a copy without the pin writes or the `_nearProxy` flag.
   * @returns {object|null}
   * @private
   */
  _bagCatch(vis) {
    if (vis.carry && vis.carry.debris) return this._fieldPiece(vis.carry.debris);
    if (vis.failure && vis.failure.debris) return this._fieldPiece(vis.failure.debris);
    const net = vis.detached ? null : this._getNet(vis.armIndex, vis.podIndex);
    return this._fieldPiece((net && net.targetDebris) || vis._catchDebris || null);
  }

  /**
   * Put the bag's group in the near-field pass exactly while the piece it wraps is drawn there (the piece's
   * `_nearProxy`, set by DebrisField under the 8.5 m / 9.5 m rule). The group is a scene child with a world position,
   * which is what a near-field root is — the pass moves it to (world − camera)·S and scales it ×S, then puts it back —
   * so none of the bag's world-position writes change. Its lines are screen-space pixels (the kit's worldUnits
   * false), which the pass leaves alone; the tether is its own line with its own rule (`_tetherPass`).
   * A bag whose piece is still far pass stays far pass with it: in the near pass it would paint over the piece.
   * @private
   */
  _bagPass(vis) {
    const sm = this._sceneManager;
    if (!vis.group) return;
    const d = this._bagCatch(vis);
    this._noteCatchSeat(vis, d);
    if (!sm || typeof sm.registerNearFieldRoot !== 'function') return;
    const want = !!(d && d._nearProxy === true && vis.group.visible !== false);
    if (want === !!vis._bagNear) return;
    vis._bagNear = want;
    if (want) sm.registerNearFieldRoot(vis.group);
    else if (typeof sm.unregisterNearFieldRoot === 'function') sm.unregisterNearFieldRoot(vis.group);
  }

  /**
   * Once a frame, after the bag was moved, remember where it sits relative to its catch, in the CATCH's own frame
   * (offset bag − catch and the bag's attitude, both turned into the piece's attitude, all of THIS frame).
   * `_carryOnRack` seats a rack bag from it, so a rack that turns the catch relative to the ship carries the bag
   * round with it.
   * @param {object|null} d  the piece the bag wraps
   * @private
   */
  _noteCatchSeat(vis, d) {
    if (!d || !d._scenePosition || (vis.carry && vis.carry.rack)) return;
    if (!vis._catchSeatOffC) {
      vis._catchSeatOffC = new THREE.Vector3();
      vis._catchSeatQuatC = new THREE.Quaternion();
    }
    this._catchFrame(d, _qA).invert();
    vis._catchSeatOffC.copy(vis.group.position).sub(d._scenePosition).applyQuaternion(_qA);
    vis._catchSeatQuatC.copy(_qA).multiply(vis.group.quaternion);
  }

  /**
   * Sample the tether as a quadratic slack curve into the Line2 strand (sag quadratic in the slack ratio: pay-out vs
   * straight-line distance). At the slack→taut transition (CAPTURED) a 0.2 s decaying lateral twang fires and the
   * strand pulses emissive above the 2.5 bloom threshold. Anchor-relative vertices (the LassoSystem DEFECT-1 fix):
   * the line object is parked at the launcher anchor and every vertex is stored relative to it, so the ~64-unit
   * orbital magnitude never snaps the strand onto the float32 grid.
   *
   * @param {object} vis — entry from _activeVisuals
   * @param {object} net — NetProjectile (tetherPaidOut, state)
   * @param {THREE.Vector3} anchor — launcher anchor, scene units (muzzle/strut tip)
   * @param {THREE.Vector3} netPos — net position, scene units
   * @param {number} dt — seconds
   * @private
   */
  _updateTetherCatenary(vis, net, anchor, netPos, dt) {
    const { tetherLine, tetherPositions } = vis;
    const dx = netPos.x - anchor.x;
    const dy = netPos.y - anchor.y;
    const dz = netPos.z - anchor.z;
    const straight = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // Park the strand at the anchor; vertices are anchor-relative. In the near pass the parent is the tether root
    // (at the ship), so the strand's position is root-relative there.
    this._tetherPass(vis, anchor, netPos);
    if (vis._tetherNear) tetherLine.position.copy(anchor).sub(this._tetherRoot.position);
    else tetherLine.position.copy(anchor);

    // Slack ratio: how much paid-out tether exceeds the straight distance (tetherPaidOut is metres; straight is scene
    // units → convert). While the mother reels / holds the catch the line is wound in as fast as it is hauled: taut,
    // ring -> bag mouth, never the flight-time bow (tetherPaidOut keeps the shot length through the reel). A daughter's
    // held net is wound in just the same (the arm holds it in REELING through the dock and HOLDING_CATCH): her line
    // runs taut from her muzzle to the bag's neck.
    const reeled = (net._isMother && (net.state === STATES.REELING || net.state === STATES.BERTHED || net.state === STATES.COLLARED))
      || (net._heldByArm === true && (net.state === STATES.CAPTURED || net.state === STATES.REELING));
    const paidScene = reeled ? straight : (net.tetherPaidOut ?? straight / M) * M;
    const slack = Math.max(0, paidScene - straight);
    const slackRatio = straight > 1e-12 ? slack / straight : 0;
    const taut = slackRatio < TETHER_TAUT_SLACK;

    // Taut-snap edge: twang + emissive pulse (line goes straight under load); both are garnish, dropped at LOW tier
    // (§11.8).
    const garnish = this._garnishOn();
    if (taut && !vis._tetherWasTaut && garnish) {
      vis._tetherTwangT = 0;
      vis._tetherEmissiveT = 0;
    }
    vis._tetherWasTaut = taut;

    // Twang: decaying lateral oscillation perpendicular to the tether axis.
    let twangAmp = 0;
    if (vis._tetherTwangT >= 0) {
      vis._tetherTwangT += dt;
      const t = vis._tetherTwangT / TETHER_TWANG_S;
      if (t >= 1) { vis._tetherTwangT = -1; }
      else {
        twangAmp = TETHER_TWANG_AMP_M * M * Math.sin(t * Math.PI * 4) * (1 - t) * (1 - t);
      }
    }

    if (vis._tetherEmissiveT >= 0) {
      vis._tetherEmissiveT += dt;
      const t = vis._tetherEmissiveT / TETHER_EMISSIVE_S;
      if (t >= 1) {
        vis._tetherEmissiveT = -1;
        tetherLine.material.color.setHex(TETHER_BASE_COLOR);
      } else {
        const k = (1 - t) * TETHER_EMISSIVE_HDR;
        tetherLine.material.color.setHex(TETHER_BASE_COLOR);
        tetherLine.material.color.multiplyScalar(1 + k);
      }
    }

    // Sag direction: perpendicular to the tether axis, biased "down" the
    // lateral component so the bow reads as slack, not as a rigid arc.
    // Perp = normalize(cross(axis, up-ish)); degenerate axis → any perp.
    _v3c.set(dx, dy, dz).normalize();
    _v3d.set(0, 1, 0);
    if (Math.abs(_v3c.y) > 0.95) _v3d.set(1, 0, 0);
    _v3d.cross(_v3c).normalize();      // lateral perpendicular (twang dir)
    const sagDirX = _v3d.x, sagDirY = _v3d.y, sagDirZ = _v3d.z;

    const sag = slack * TETHER_SAG_FRAC;
    for (let i = 0; i <= TETHER_SEGMENTS; i++) {
      const t = i / TETHER_SEGMENTS;
      // Quadratic slack profile: 4·t·(1−t) peaks 1 at the midpoint, 0 at ends.
      const bow = 4 * t * (1 - t);
      const px = dx * t + sagDirX * (sag * bow) + sagDirX * twangAmp * Math.sin(t * Math.PI);
      const py = dy * t + sagDirY * (sag * bow) + sagDirY * twangAmp * Math.sin(t * Math.PI);
      const pz = dz * t + sagDirZ * (sag * bow) + sagDirZ * twangAmp * Math.sin(t * Math.PI);
      tetherPositions[i * 3]     = px;
      tetherPositions[i * 3 + 1] = py;
      tetherPositions[i * 3 + 2] = pz;
    }
    // Write the pairs-format interleaved buffer in place (segment j = point j → point j+1), mirroring
    // LineGeometry.setPositions' polyline→pairs conversion, then flag it dirty. No per-frame allocation, no bounds
    // recompute (tetherLine.frustumCulled = false covers culling).
    const seg = vis.tetherSegBuffer;
    if (seg) {
      const arr = seg.array;
      for (let j = 0; j < TETHER_SEGMENTS; j++) {
        const a = j * 3, b = (j + 1) * 3, o = j * 6;
        arr[o]     = tetherPositions[a];
        arr[o + 1] = tetherPositions[a + 1];
        arr[o + 2] = tetherPositions[a + 2];
        arr[o + 3] = tetherPositions[b];
        arr[o + 4] = tetherPositions[b + 1];
        arr[o + 5] = tetherPositions[b + 2];
      }
      seg.needsUpdate = true;
    } else {
      // Fallback (buffer not captured, e.g. an externally-built vis): safe path.
      tetherLine.geometry.setPositions(tetherPositions);
    }
  }

  /**
   * The near-field root the short net tethers hang from (made on first use). It rides the ship (children are
   * root-relative, as LeashVisual does) and is registered with the scene manager like the ship and the leash root, so
   * the line is drawn in the depth-cleared near pass: the hull cannot paint over it and a world-unit width is in
   * metres there.
   * @returns {THREE.Group}
   * @private
   */
  _ensureTetherRoot() {
    if (!this._tetherRoot) {
      const root = new THREE.Group();
      root.name = 'NetTetherRoot';
      this._scene.add(root);
      this._tetherRoot = root;
      const sm = this._sceneManager;
      if (sm && typeof sm.registerNearFieldRoot === 'function') sm.registerNearFieldRoot(root);
    }
    const pp = this._player && this._player.position;
    if (pp && Number.isFinite(pp.x) && Number.isFinite(pp.y) && Number.isFinite(pp.z)) this._tetherRoot.position.copy(pp);
    else this._tetherRoot.position.set(0, 0, 0);
    return this._tetherRoot;
  }

  /**
   * Pick the pass a net's tether is drawn in. A world-unit Line2 has the leash line's true width (2 x
   * LEASH.LINE_RADIUS_M = 1 cm): in the near-field pass (the line a child of the tether root, which rides the ship)
   * while BOTH its ends are within the pass's +-10 m depth bracket of the ship (minus a margin), else in the far
   * pass (scene child, the same width x M). Not by the line's length: a daughter net hangs from a muzzle that can
   * be tens of metres from the mother, and a mother line starts at the collar, off the ship's centre. Legacy
   * screen-space lines (flag-off path) are left alone.
   * @param {THREE.Vector3} anchor — the line's launcher end, scene units
   * @param {THREE.Vector3} end — the line's net end, scene units
   * @private
   */
  _tetherPass(vis, anchor, end) {
    const line = vis.tetherLine;
    if (!vis.useCeremony || !line.material.worldUnits) return;
    const pp = this._player && this._player.position;
    const ok = !!pp && Number.isFinite(pp.x) && Number.isFinite(pp.y) && Number.isFinite(pp.z);
    const cx = ok ? pp.x : 0, cy = ok ? pp.y : 0, cz = ok ? pp.z : 0;    // where _ensureTetherRoot parks the root
    const reachM = Math.max(
      Math.hypot(anchor.x - cx, anchor.y - cy, anchor.z - cz),
      Math.hypot(end.x - cx, end.y - cy, end.z - cz)) / M;
    const wantNear = vis._tetherNear ? reachM <= TETHER_NEAR_OFF_M : reachM <= TETHER_NEAR_ON_M;
    const root = (wantNear || vis._tetherNear) ? this._ensureTetherRoot() : null;   // also parks the root on the ship
    if (wantNear === !!vis._tetherNear) return;
    vis._tetherNear = wantNear;
    const width = 2 * Constants.LEASH.LINE_RADIUS_M;
    if (wantNear) {
      this._scene.remove(line);
      root.add(line);
      line.material.linewidth = width;          // near pass: 1 unit = 1 m
      const sm = this._sceneManager;
      if (sm && typeof sm.refreshNearFieldLayers === 'function') sm.refreshNearFieldLayers(root);
    } else {
      this._tetherRoot.remove(line);
      this._scene.add(line);
      line.layers.set(0);                       // back to the far camera's layer
      line.material.linewidth = width * M;      // far pass: 1 unit = 1e5 m
    }
  }

  /**
   * The ONE home of the bag's contents spec (radius / Z / oriented box) — what the kit's drape/cinch floors on. Shared
   * by the state-driven drape driver (_updateCeremonyState) and the carried bag (_driveCarriedBag), so the two can
   * never disagree about where the catch is or how big it is.
   *
   * Tells the kit what is INSIDE the bag so the drape/cinch floors on a spherical envelope around the catch instead
   * of closing to 0.27 m regardless. Scene units throughout. effectiveRenderScale is the clamp-aware SSOT, so the
   * envelope tracks the size the renderer actually draws, including the CAPTURED readability floor. Also the catch's
   * oriented-BOX spec — the film wraps the real extents, keyed to the tumble orientation, which is FROZEN while
   * pinned so the wrap cannot spin or drift. The LOGICAL size (sizeM) drives the size-aware welded film rest —
   * stable through the whole ceremony.
   *
   * Allocation-free: writes and returns a module-level scratch — read it before the next call.
   * @param {object} vis      — entry from _activeVisuals (needs kitHandle)
   * @param {object} d        — the catch (needs _scenePosition)
   * @param {number|null} chopMul — FT.chopScaleMul deflation, or null for none
   * @returns {{radius:number, z:number, box:object|null, sizeM:number}}
   * @private
   */
  _catchContentsSpec(vis, d, chopMul) {
    const out = _contentsSpecOut;
    out.sizeM = d.sizeMeter || 0;
    DebrisWireframe.getGeometry(d.type, d.id);           // br cache (uncached ⇒ 1)
    const br = DebrisWireframe.getBoundingRadius(d.type, d.id) || 1;
    let renderScale = DebrisField.effectiveRenderScale(d);
    // Deflate the whole contents spec (radius, box extents, box centre) by the one-home chop ramp so the film visibly
    // collapses WITH the body it wraps — probe/mesh parity by construction (the handle stores the deflated spec the
    // mesh deformed to; _netDrawnRimPierce reads the handle).
    if (chopMul != null) renderScale *= chopMul;
    out.radius = renderScale * br;
    vis.kitHandle.group.updateMatrixWorld(true);          // same guard the probe uses
    const lp = vis.kitHandle.group.worldToLocal(_v3c.copy(d._scenePosition));
    out.z = lp.z;
    out.box = null;
    const bb = DebrisWireframe.getBoundingBoxExtents(d.type, d.id);
    if (bb) {
      // Catch orientation in kit space: qB2K = qKit⁻¹ ⊗ tumble. The tumble is the whole instance rotation
      // (DebrisField) and is frozen while _armPinned.
      vis.kitHandle.group.getWorldQuaternion(_qA);
      if (d.tumbleAxis) _qB.setFromAxisAngle(d.tumbleAxis, d.tumbleAngle || 0);
      else _qB.identity();
      _qA.invert().multiply(_qB);                          // box-local → kit-space
      // Box centre in kit space: instance origin + qB2K·(local centre × scale).
      _vBox.set(bb.cx * renderScale, bb.cy * renderScale, bb.cz * renderScale).applyQuaternion(_qA);
      _contentsBoxScratch.ox = lp.x + _vBox.x;
      _contentsBoxScratch.oy = lp.y + _vBox.y;
      _contentsBoxScratch.oz = lp.z + _vBox.z;
      // kit→box rotation rows (v_box = R·v_kit): the matrix of qB2K⁻¹.
      // Matrix4.elements is column-major: e[0]=m11, e[1]=m21, e[4]=m12 …
      _m4.makeRotationFromQuaternion(_qA.invert());
      const e = _m4.elements;
      _contentsBoxScratch.r00 = e[0]; _contentsBoxScratch.r01 = e[4]; _contentsBoxScratch.r02 = e[8];
      _contentsBoxScratch.r10 = e[1]; _contentsBoxScratch.r11 = e[5]; _contentsBoxScratch.r12 = e[9];
      _contentsBoxScratch.r20 = e[2]; _contentsBoxScratch.r21 = e[6]; _contentsBoxScratch.r22 = e[10];
      _contentsBoxScratch.hx = bb.hx * renderScale;
      _contentsBoxScratch.hy = bb.hy * renderScale;
      _contentsBoxScratch.hz = bb.hz * renderScale;
      out.box = _contentsBoxScratch;
    }
    return out;
  }

  /**
   * Update the ceremony-path visual for one net.
   * @returns {boolean} true if the visual was removed (caller should `continue`)
   * @private
   */
  _updateCeremonyState(key, vis, net, dt) {
    const { coneMesh, rimWeights, drawstringLine,
            apexHub, weightCount, rimWeightMats, canisterMesh } = vis;
    const state = net.state;

    // A mother net closing on / holding its catch is drawn as a compact bag around it, placed and sized BEFORE the
    // drape driver reads the group's frame (the contents spec is taken in the group's own space). Every placement
    // below reads the LIVE size; for any other net it is the build-time size, unchanged.
    if (vis.kitHandle) this._shapeHeldBag(vis, net, dt);
    const kitLive = vis.kitHandle || vis;
    const mouthRadius = kitLive.mouthRadius;
    const coneHeight = kitLive.coneHeight;
    const closedRadius = kitLive.closedRadius;

    // Drape driver: map the net FSM onto the kit's per-frame drape state. The web drapes onto the catch through
    // ENVELOP, settle-jiggles at ~2.5 Hz with a decaying envelope, then shrink-wraps through CINCH_CLOSING to the
    // bunched point that persists through REELING, BERTHED and PARKED. FLIGHT keeps a slight cone bow (drape 0).
    // Driven every frame so the jiggle phase advances and the envelope decays; allocation-free (the kit reuses its
    // webPositions buffer).
    if (vis.kitHandle) {
      // The settle-jiggle is garnish — dropped at LOW tier (§11.8); the drape/cinch deformation itself is structure
      // and stays.
      const garnish = this._garnishOn();
      let drape = 0, cinchFrac = 0, jiggleAmp = 0;
      if (vis.failure) {
        // Failure staging: the beat owns drape/cinch until it completes — in MISSED, and in the miss REELING when
        // ceremony time-dilation lets the logic's reel-back begin first (the two clocks differ under the ceremony
        // scale; keying on the beat, not the state, means no mid-beat cut). Both beats end at drape 0 / cinch 0 = the
        // flight cone the state map drives afterwards, so the hand-off to the fade is shape-continuous.
        const beat = vis.failure;
        const f = Math.min(1, beat.t / beat.dur);
        if (beat.kind === 'bounce') {
          // Broadside bounce: the bag holds the wrap attempt against the face (or slaps up to it when the catch found
          // the cone open), then SPRINGS off — deliberately fast (down²) next to the slip's slow let-go. The cinch
          // never re-closes.
          const up = Math.min(1, f / 0.3);
          const down = f < 0.3 ? 0 : (f - 0.3) / 0.7;
          drape = Math.max(beat.drape0, up) * (1 - down * down);
          cinchFrac = beat.cinch0 * (1 - down * down);
        } else {
          // Strain slip: the welded wrap lets go — cinch and drape release linearly toward the open cone while the
          // catch slides out of the mouth (never pinned on this path; its orbit owns it).
          drape = beat.drape0 * (1 - f);
          cinchFrac = beat.cinch0 * (1 - f);
        }
        beat.cinch = cinchFrac;
        beat.t += dt;
        if (f >= 1) this._endFailureBeat(key, vis);
      } else if (net.mouthCollapsed) {
        // §11.2 windsock-flutter beat (the one missFailureKind deliberately left unstaged). Keyed off the ONE-WAY
        // NetProjectile.mouthCollapsed latch (set when rimTensionN fell through the tension floor), never recomputed
        // tension physics. The mouth eases toward the drawstring-closed radius (a PARTIAL cinch: a dead slack sock,
        // never the welded 1.0 only a real catch earns) with a garnish flutter ripple. The ease clock lives on the vis
        // (fresh per fire), completes in MOUTH_COLLAPSE_EASE_S, then HOLDS: a collapsed net only reaches MISSED /
        // RELEASED / REELING from here (contact resolves as the 'mouth_collapsed' MISS before any wrap state), and this
        // branch outranks those rows below, so the sock neither snaps open at the miss nor welds shut on the empty
        // reel-back.
        vis.collapseT = Math.min(_NW.MOUTH_COLLAPSE_EASE_S, vis.collapseT + dt);
        const colFrac = vis.collapseT / _NW.MOUTH_COLLAPSE_EASE_S;
        cinchFrac = _NW.MOUTH_COLLAPSE_CINCH_FRAC * colFrac;
        vis.collapseCinch = cinchFrac;
        if (garnish) jiggleAmp = mouthRadius * _NW.MOUTH_COLLAPSE_FLUTTER_FRAC * colFrac;
      } else if (state === STATES.ENVELOP) {
        drape = clamp01(net.stateTimer / CN.ENVELOP_TIME);
        // Settle-jiggle: strongest mid-drape, decaying as the bag seats.
        if (garnish) jiggleAmp = mouthRadius * _NT.DRAPE_JIGGLE_ENVELOP_FRAC * Math.sin(Math.PI * drape);
      } else if (state === STATES.CINCH_CLOSING) {
        drape = 1;
        cinchFrac = clamp01(net.stateTimer / CN.CINCH_CLOSE_TIME);
        if (garnish) jiggleAmp = mouthRadius * _NT.DRAPE_JIGGLE_CINCH_FRAC * (1 - cinchFrac);
      } else if (state === STATES.CAPTURED || state === STATES.REELING
                 || state === STATES.BERTHED || state === STATES.COLLARED
                 || state === STATES.TRANSFERRING
                 || state === STATES.SECURE_CHECK) {
        if (state === STATES.SECURE_CHECK && net.captureMode === CN.MODES.SLAM_WRAP) {
          // owner 2026-08-21: no pre-resolve weld on the slam path — the resolve rolls AT window end (CaptureNet), so
          // a welded draw would lie for the ~0.2 g-s check window. SLAM_WRAP never cinched (no sweep): hold the arrived
          // open cone through the check. The success weld lands AT the resolve (the CAPTURED row above); a slam bounce
          // then seeds the beat's slap from the cone. The cinch branch below writes the same (1, 1) the CINCH_CLOSING
          // sweep converges to. Production forces CINCH (both fire sites in CaptureNet; all callers mode-less), so the
          // gated SECURE_CHECK family and every mode-less mock ride the cinch branch.
          drape = 0; cinchFrac = 0;   // hold what the slam path arrived with
        } else {
          drape = 1; cinchFrac = 1;   // welded shrink-wrap, no jiggle
        }
      }
      if (drape > 0 || cinchFrac > 0 || vis.kitHandle._drape > 0 || vis.kitHandle._cinchFrac > 0) {
        vis.kitHandle._jigglePhase = (vis.kitHandle._jigglePhase || 0) + dt * Math.PI * 2 * _NT.DRAPE_JIGGLE_HZ;
        // What is INSIDE the bag (spherical envelope + oriented box): see _catchContentsSpec. The miss / no-target
        // case stays 0 — an empty net SHOULD bunch to a point; that contrast is what sells a real catch.
        let contentsRadius = 0, contentsZ = 0, contentsBox = null;
        let catchSizeM = 0;
        const d = net.targetDebris;
        if (d && d._scenePosition && (drape > 0 || cinchFrac > 0)) {
          // The spec's rationale lives on _catchContentsSpec (the ONE home, shared with the carried bag): logical
          // size, the chop deflation (COLLARED + _breakdownActive only), and the oriented box in kit space. During the
          // collar digestion's chop the instance shrinks out of view (CaptureNet re-pins with FT.chopScaleMul every
          // tick); deflate the whole contents spec by the SAME ramp off the SAME phase clock.
          const chopMul = (state === STATES.COLLARED && d._breakdownActive && net._digestPhaseT != null)
            ? Constants.FURNACE_TRANSFER.chopScaleMul(net._digestPhaseT)
            : null;
          const cs = this._catchContentsSpec(vis, d, chopMul);
          catchSizeM = cs.sizeM;
          contentsRadius = cs.radius;
          contentsZ = cs.z;
          contentsBox = cs.box;
        }
        NetMeshKit.updateWebDrape(vis.kitHandle, {
          drape,
          cinchFrac,
          jigglePhase: vis.kitHandle._jigglePhase,
          jiggleAmp,
          contentsRadius,
          contentsZ,
          contentsBox,
          catchSizeM,
          // camera in the kit's LOCAL frame for per-thread depth shading (the kit stays pure-local-space;
          // worldToLocal writes in place).
          localCamPos: this._sceneManager?.camera
            ? vis.kitHandle.group.worldToLocal(_v3c.copy(this._sceneManager.camera.position))
            : undefined,
        });
      }
    }

    switch (state) {
      case STATES.FOLDED:
        canisterMesh.visible = true;
        coneMesh.visible = false;
        for (const w of rimWeights) w.visible = false;
        drawstringLine.visible = false;
        apexHub.visible = false;
        vis.tetherLine.visible = false;
        break;

      case STATES.LAUNCHING:
        canisterMesh.visible = true;
        coneMesh.visible = false;
        for (const w of rimWeights) w.visible = false;
        drawstringLine.visible = false;
        apexHub.visible = false;
        vis.tetherLine.visible = true;
        break;

      case STATES.SPINNING_UP: {
        canisterMesh.visible = false;
        coneMesh.visible = true;
        vis.tetherLine.visible = true;
        apexHub.visible = true;
        drawstringLine.visible = true;

        // The net opens over the spin-up TIME (blossom), not the spin rate (it unwinds 3× → 1× SPIN_HZ, so a
        // rate-based fraction was already 1 on the first frame). The film is a separate mesh, scaled the same way
        // (uniformly, like the cone) so it keeps the cone's depth. Physics and the net's position are untouched.
        const openFrac = clamp01((net.stateTimer ?? 0) / CN.SPIN_UP_TIME);
        const openScale = Math.max(0.05, openFrac);
        coneMesh.scale.setScalar(openScale);
        if (vis.kitHandle && vis.kitHandle.membraneMesh) {
          vis.kitHandle.membraneMesh.scale.setScalar(openScale);
        }
        coneMesh.material.color.setHex(COL_DISC);
        coneMesh.material.opacity = 0.55;

        vis.spinAngle += net.spinRate * Math.PI * 2 * dt;
        const curR = mouthRadius * openFrac;
        const curZ = -coneHeight * openFrac;
        for (let i = 0; i < weightCount; i++) {
          const w = rimWeights[i];
          w.visible = true;
          const angle = (2 * Math.PI * i / weightCount) + vis.spinAngle;
          w.position.set(curR * Math.cos(angle), curR * Math.sin(angle), curZ);
        }

        this._updateDrawstring(vis);
        break;
      }

      case STATES.FLIGHT: {
        canisterMesh.visible = false;
        coneMesh.visible = true;
        vis.tetherLine.visible = true;
        apexHub.visible = true;
        drawstringLine.visible = true;

        coneMesh.scale.setScalar(1);
        if (vis.kitHandle && vis.kitHandle.membraneMesh) {
          vis.kitHandle.membraneMesh.scale.setScalar(1);
        }
        vis.spinAngle += net.spinRate * Math.PI * 2 * dt;
        coneMesh.material.color.setHex(COL_DISC);
        coneMesh.material.opacity = 0.55;

        // Place weights at full mouth radius — or, §11.2 windsock: on the SAME collapsed rim the web's cinch channel
        // draws (the CINCH_CLOSING radius lerp at t=1), so beads and fabric pinch together. collapseCinch is 0 until
        // the physics latch, so mouthRadius + 0 × (…) is bit-identical to the design placement.
        const wrFlight = lerp(mouthRadius, closedRadius, vis.collapseCinch);
        for (let i = 0; i < weightCount; i++) {
          const angle = (2 * Math.PI * i / weightCount) + vis.spinAngle;
          rimWeights[i].position.set(
            wrFlight * Math.cos(angle),
            wrFlight * Math.sin(angle),
            -coneHeight,
          );
          rimWeights[i].visible = true;
        }

        this._updateDrawstring(vis);
        break;
      }

      case STATES.CONTACT:
      case STATES.BRAKE:
        canisterMesh.visible = false;
        coneMesh.visible = true;
        vis.tetherLine.visible = true;
        apexHub.visible = true;
        drawstringLine.visible = true;

        // Fabric stays ivory through CONTACT + BRAKE — the phase is read on the HUD, not the mesh. BRAKE still drives
        // the rim-weight emissive glint below (a physical tungsten-node cue, not a recolour).
        coneMesh.material.color.setHex(COL_DISC);
        coneMesh.material.opacity = 0.55;

        vis.spinAngle += net.spinRate * Math.PI * 2 * dt;
        for (let i = 0; i < weightCount; i++) {
          const angle = (2 * Math.PI * i / weightCount) + vis.spinAngle;
          rimWeights[i].position.set(
            mouthRadius * Math.cos(angle),
            mouthRadius * Math.sin(angle),
            -coneHeight,
          );
          rimWeights[i].visible = true;
        }

        // On BRAKE: immediate weight-emissive set to the brake colour (no animated flash)
        if (state === STATES.BRAKE) {
          for (const mat of rimWeightMats) {
            mat.emissive.setHex(NET_CER.RIM_WEIGHT_EMISSIVE_BRAKE);
          }
        }

        this._updateDrawstring(vis);
        break;

      case STATES.ENVELOP: {
        canisterMesh.visible = false;
        coneMesh.visible = true;
        vis.tetherLine.visible = true;
        apexHub.visible = true;
        drawstringLine.visible = true;

        coneMesh.material.color.setHex(COL_DISC);
        coneMesh.material.opacity = 0.55;
        // Cone scale UNCHANGED — no shrink

        // Weights sweep -coneHeight → -2 × coneHeight, i.e. PAST the mouth plane: the target sits at z ≈ -mouthR
        // (= -0.5 × D local, ~0.4 m SHORT of the mouth plane at -0.55 × D), so for the bag to engulf it the weights
        // must OVERSHOOT the mouth (Newton's first law during deceleration) and wrap it inside the closing bag;
        // retracting toward the daughter would pull them away from the target. Drawstring strands (apex → weight)
        // lengthen automatically, reading as bag-cone fabric draping around the target.
        const envProgress = clamp01(net.stateTimer / CN.ENVELOP_TIME);
        vis.spinAngle += net.spinRate * Math.PI * 2 * dt;
        const envZ = -coneHeight * (1 + envProgress);
        for (let i = 0; i < weightCount; i++) {
          const angle = (2 * Math.PI * i / weightCount) + vis.spinAngle;
          rimWeights[i].position.set(
            mouthRadius * Math.cos(angle),
            mouthRadius * Math.sin(angle),
            envZ,
          );
          rimWeights[i].visible = true;
        }

        for (const mat of rimWeightMats) {
          mat.emissive.setHex(NET_CER.RIM_WEIGHT_EMISSIVE_BRAKE);
        }

        this._updateDrawstring(vis);
        break;
      }

      case STATES.CINCH_CLOSING: {
        canisterMesh.visible = false;
        coneMesh.visible = true;
        vis.tetherLine.visible = true;
        apexHub.visible = true;
        drawstringLine.visible = true;

        coneMesh.material.color.setHex(COL_DISC);
        coneMesh.material.opacity = 0.55;

        // Driven by stateTimer / CINCH_CLOSE_TIME, NOT `net.tangleQuality` (0 throughout this state, only set at
        // CAPTURED: the ring stayed at mouthRadius for the whole cinch, then snapped closed in a SINGLE FRAME), so it
        // contracts smoothly from mouthRadius to closedRadius across the camera's CINCH beat. The ring contracts at
        // z=-coneHeight (the mouth plane, 0.4 m past the target along the launch direction), centred on the debris
        // within the cone mouth's half-thickness; a ring at z=0 (apex plane) would close ~coneHeight (4.4 m for LARGE
        // D=8) BEHIND the target, on the daughter side. Drawstring strands from apex (z=0) to the ring render as the
        // long bag-cone strands cinching closed at the debris.
        const cinchProgress = clamp01(net.stateTimer / CN.CINCH_CLOSE_TIME);
        // The sweep closes ONTO the catch and stops: floored at the mouth-plane contents floor (the kit's
        // mouthFloorRadius), matching the film's rim ring, instead of sweeping through a catch that reaches the mouth
        // plane. The floor is 0 whenever the contents stop short of the mouth (the mother scenario included), so the
        // gated draw is bit-identical; at cinchProgress 1 this equals _setCinchedRim's radius exactly.
        const curR = Math.max(
          lerp(mouthRadius, closedRadius, cinchProgress),
          NetMeshKit.mouthFloorRadius(vis.kitHandle),
        );
        vis.spinAngle += net.spinRate * Math.PI * 2 * dt;
        for (let i = 0; i < weightCount; i++) {
          const angle = (2 * Math.PI * i / weightCount) + vis.spinAngle;
          rimWeights[i].position.set(
            curR * Math.cos(angle),
            curR * Math.sin(angle),
            // Starts where ENVELOP ended (-2·coneHeight) and settles onto the mouth plane (-coneHeight) at the end of
            // the cinch (a flat -coneHeight jumped a cone height in one frame). Target sits at z ≈ -mouthRadius,
            // ~0.4 m short of the mouth plane.
            -coneHeight * (2 - cinchProgress),
          );
          rimWeights[i].visible = true;
        }

        // Drawstring brightens during cinch
        for (const mat of rimWeightMats) {
          mat.emissive.setHex(NET_CER.RIM_WEIGHT_EMISSIVE_BRAKE);
        }

        this._updateDrawstring(vis);
        break;
      }

      case STATES.SECURE_CHECK:
        canisterMesh.visible = false;
        coneMesh.visible = true;
        vis.tetherLine.visible = true;
        apexHub.visible = true;
        // Fabric stays ivory; the "checking grip" beat is read on the HUD. The opacity pulse below stays as a subtle
        // physical shimmer.
        coneMesh.material.color.setHex(COL_DISC);
        coneMesh.material.opacity = 0.35 + 0.25 * Math.sin(Date.now() * 0.01);
        break;

      case STATES.CAPTURED:
        canisterMesh.visible = false;
        coneMesh.visible = true;
        vis.tetherLine.visible = true;
        coneMesh.material.color.setHex(COL_DISC);
        coneMesh.material.opacity = 0.55;   // steady — no pulse once captured (#3)
        // Static cinched bag — rim ring frozen at the closed radius on the mouth plane, spinAngle NOT advanced: a
        // captured bag must read as a welded, settled catch, not a live animation.
        this._setCinchedRim(vis);
        break;

      case STATES.MISSED:
        canisterMesh.visible = false;
        coneMesh.visible = true;
        vis.tetherLine.visible = true;
        coneMesh.material.color.setHex(COL_DISC);
        if (vis.failure) {
          // The beat owns the furniture — the cinch ring follows the beat's cinchFrac (opening on a slip, springing
          // off on a bounce) and the strands stay on for the release read.
          this._stageFailureFurniture(vis);
        } else {
          // Opacity handled by fade timer; hide the cinch furniture so no
          // weights/strands linger at full opacity through the fade.
          for (const w of rimWeights) w.visible = false;
          drawstringLine.visible = false;
        }
        break;

      case STATES.REELING:
        canisterMesh.visible = false;
        // Remember the catch — the net is pruned the tick after NET_REEL_COMPLETED, and the carried bag still has to
        // follow the piece.
        if (net.targetDebris) vis._catchDebris = net.targetDebris;
        // A failure beat (or its fade tail) keeps the cone drawn through the miss reel-back — hiding it the frame
        // REELING starts would cut the staged bounce/slip (or pop the fading bag).
        coneMesh.visible = net.catchResult === 'success' || !!vis.failure || !!vis.fadingOut;
        vis.tetherLine.visible = true;
        if (net.catchResult === 'success') {
          coneMesh.material.color.setHex(COL_DISC);
          // The haul/park can last many seconds (REELING is held through HOLDING_CATCH for daughter catches) — render
          // a steady, fully-cinched bag: fixed opacity, frozen spin, rim ring pinned at the closed radius, no pulse.
          // Same size-aware rest as the berthed bag, so a small catch reads through the threads while hauled in.
          coneMesh.material.opacity = this._heldThreadOpacity(net);
          this._setCinchedRim(vis);
        } else if (vis.failure) {
          this._stageFailureFurniture(vis);
        } else {
          for (const w of rimWeights) w.visible = false;
          drawstringLine.visible = false;
          apexHub.visible = false;
        }
        break;

      case STATES.COLLARED:
      case STATES.BERTHED:
      case STATES.TRANSFERRING:
        // Mother berth/collar: the cinched bag PERSISTS at the launcher with a short taut tether stub — identical to
        // the successful REELING case above, and across BERTHED→COLLARED (the net IS the container; never faded while
        // mated — the collar digestion's NET_CONSUMED hands it the freeze-fade idiom at the very end). Explicit case so
        // persistence is by design, not by default: break (the plain-switch case below is dead code under
        // NET_CEREMONY). TRANSFERRING is the same welded bag in flight to a daughter's rack, minus the tether.
        // One amendment to "never faded while mated": at CHOP END the body is consumed (instance at the 0.001 floor;
        // the chunks are the read) and the bag has deflated with it (drape driver above). Hand the spent bag to the
        // freeze-fade HERE instead of holding an invisible near-axis spike through the whole feed phase (NET_CONSUMED
        // lands at FEED_S — up to 2.7 s of dead spike on a min-mass catch). Same detach idiom as _onNetConsumed, which
        // is a no-op for an already-detached bag.
        if (state === STATES.COLLARED && net._digestPhaseT != null
            && net._digestPhaseT >= Constants.FURNACE_TRANSFER.CHOP_S && !vis.detached) {
          this._captureDetachSeat(vis);
          vis.detached = true;      // state-driven updates stop; the fade owns removal
          this._fadeTimers.push({ key, timer: 0.8, duration: 0.8 });
          break;
        }
        canisterMesh.visible = false;
        coneMesh.visible = true;
        vis.tetherLine.visible = (net.state !== STATES.TRANSFERRING);
        coneMesh.material.color.setHex(COL_DISC);
        // A held bag over a SUB-METRE catch floors its lattice on the readability-floored box — at 0.55 the threads
        // read as a bare wireframe dome parked on the nose ("geodesic globe"). The thread rest lerps toward
        // THREAD_OPACITY_HELD_SMALL across the SAME size band as the welded film, so fabric (film + rosette + weights)
        // carries the small-bag read and the lattice recedes. Whale class (≥ LARGE_SIZE_M) and size-less mocks keep
        // 0.55.
        coneMesh.material.opacity = this._heldThreadOpacity(net);
        this._setCinchedRim(vis);
        break;

      case STATES.STOWED:
      case STATES.RELEASED:
        this._removeNetVisual(key);
        return true; // signal caller to continue (skip tether update)

      default:
        break;
    }

    // Orient the group so local -Z points along the launch direction (mouth/forward end of the cone at local
    // z = -coneH, apex at z = 0; rim weights at z = -coneH render past the target along launchDir).
    // CRITICAL: THREE.js Object3D.lookAt uses the OPPOSITE convention from Camera.lookAt:
    //   - For Camera / Light:  internal _m1.lookAt(position, target, up)   → local -Z points TOWARD target.
    //   - For Object3D:        internal _m1.lookAt(target, position, up)   → local +Z points TOWARD target.
    // (three.js Object3D.js, isCamera/isLight branch.)
    // The net group is a plain Group, so to make local -Z point along launchDir (what every z = -coneH placement
    // assumes) pass a lookAt point on the OPPOSITE side: group.position - launchDir × ε (local +Z = -launchDir, local
    // -Z = +launchDir). `.add(_v3a)` (camera convention) put the rim weights, mouth and cinch ring on the DAUGHTER side
    // of the net centre: the "cinch happens between daughter and debris" symptom.
    this._aimBag(vis, net);

    // Mirror the cone's visibility onto the V2 membrane film: NetMeshKit builds it hidden (childrenVisible=false) and
    // no ceremony state sets its .visible, so without this the film never contributes a pixel (measured filmShare 0)
    // and the threads read as cool line art. Its material/deformation are driven separately (Kit.updateWebDrape writes
    // membranePositions + normals).
    // A SMALL catch held by the mother (reel, berth, collar) must show through the net — the lit film (opacity 0.24,
    // two-sided, transmission, emissive floor) covers a true-size 0.3 m piece to 0-10 px (measured). Hide it with
    // `visible = false`, not an opacity write: updateWebDrape rewrites the film's opacity every frame.
    if (vis.kitHandle && vis.kitHandle.membraneMesh) {
      vis.kitHandle.membraneMesh.visible = coneMesh.visible && !this._filmHiddenForSmallCatch(net);
    }

    return false;
  }

  /**
   * Orient the bag group so local -Z points along the launch direction (see the convention block in
   * _updateCeremonyState). No-op without a launch direction. Allocation-free.
   * @param {object} vis
   * @param {object} net
   * @private
   */
  _aimBag(vis, net) {
    const L = vis._bagAxisOn ? vis._bagAxis : net.launchDirection;   // a held bag lines up with its tether
    if (!L) return;
    _v3a.set(L.x * 0.001, L.y * 0.001, L.z * 0.001);
    _v3b.copy(vis.group.position).sub(_v3a);
    vis.group.lookAt(_v3b);
  }

  /**
   * The arm that fired a DAUGHTER's net, when its net-launcher muzzle can be read (the ring her net line winds on);
   * null for a mother net, a mock, or an arm without the hardware. Only such a net is drawn as a held bag.
   * @returns {object|null}
   * @private
   */
  _daughterMuzzleArm(net) {
    const arm = net && !net._isMother && net.armIndex >= 0 ? net._sourceArm : null;
    return arm && typeof arm.getNetMuzzleWorldInto === 'function' ? arm : null;
  }

  /**
   * From the closed cinch to the end of the hand-off, draw a net as a compact bag around its catch (see BAG): the apex
   * ball (where the tether ends) touching the rear of the catch (never behind the capture ring), the rim ring just
   * past it, the web wrapping it, the bag lined up with its tow line. The simulation's apex (net.position) trails the
   * catch by the reel's seat law (up to ~4.6 m) and the kit was built as the 6.8 m flight cone; neither is a bag
   * around a 0.3 m piece. The flight shape gathers into the compact one while the drawstring closes (CINCH_CLOSING),
   * so the closed bag is compact; a net born held (an adopted lasso catch) starts compact; a bag that lets go
   * (failed resolve, slip) un-gathers over BAG.GATHER_S, then is put back exactly as built. Runs before the drape
   * driver and the tether: it moves vis.group (the tether's end) and re-sizes the kit. Nothing in the simulation is
   * touched (the reel's momentum, seat law and timings are unchanged).
   * A daughter's net is shaped the same way, on her own muzzle as the ring, through CINCH_CLOSING, CAPTURED and
   * REELING (the arm holds the net in REELING through the dock and HOLDING_CATCH), so her catch is wrapped all the way
   * home and the bag does not pop from the 5 m flight cone when the reel starts.
   * @param {number} dt — seconds
   * @private
   */
  _shapeHeldBag(vis, net, dt) {
    const kit = vis.kitHandle;
    const d = net.targetDebris;
    const st = net.state;
    // A DAUGHTER's net is shaped the same way (DECISIONS §28 row 6: the net is wrapped round the catch all the way
    // home): its ring is her net-launcher muzzle, not the mother's berth collar
    const muzzleArm = this._daughterMuzzleArm(net);
    const can = !vis.detached && (net._isMother || !!muzzleArm) && !!d && !!d._scenePosition && !!net.launchDirection;
    const closing = can && !vis.failure && st === STATES.CINCH_CLOSING;
    const held = can && !vis.failure && net.catchResult === 'success'
      && (st === STATES.CAPTURED || st === STATES.REELING || st === STATES.BERTHED
        || st === STATES.COLLARED || st === STATES.TRANSFERRING);
    const keep = can && !vis.failure && st === STATES.SECURE_CHECK;
    let g = vis._bagG || 0;
    if (closing) {
      // the drawstring closing draws the bag in with it: closed bag = compact bag
      const p = clamp01((net.stateTimer || 0) / CN.CINCH_CLOSE_TIME);
      g = Math.max(g, smoothstep01(p));
    } else if (held) {
      // a net born held (an adopted lasso catch) starts compact; otherwise finish any gather left
      g = vis._bagG === undefined ? 1 : Math.min(1, g + dt / BAG.GATHER_S);
    } else if (!keep) {
      // let go (a failed resolve, a slip, any other net): un-gather back to the built cone, then forget
      g = can ? Math.max(0, g - dt / BAG.GATHER_S) : 0;
    }
    if (!(g > 0)) {
      if (kit._bagBase) {
        NetMeshKit.resetBagShape(kit);
        for (const w of vis.rimWeights) w.scale.setScalar(1);
      }
      vis._bagG = (closing || held) ? 0 : undefined;
      vis._bagAxisOn = false;
      return;
    }
    vis._bagG = g;
    const ws = lerp(1, BAG.WEIGHT_RADIUS_M / NET_CER.RIM_WEIGHT_RENDER_RADIUS_M, g);
    for (const w of vis.rimWeights) w.scale.setScalar(ws);

    const chopMul = (st === STATES.COLLARED && d._breakdownActive && net._digestPhaseT != null)
      ? Constants.FURNACE_TRANSFER.chopScaleMul(net._digestPhaseT)
      : null;
    const rS = heldBagRadiusScene(d, chopMul);          // drawn radius with the floor, scene units (the sim's own function)
    const c = d._scenePosition;
    // the ring the line winds on: the mother's capture ring (berth collar), or the daughter's muzzle
    let ringOk = false;
    if (muzzleArm) {
      muzzleArm.getNetMuzzleWorldInto(_v3d);
      ringOk = Number.isFinite(_v3d.x) && Number.isFinite(_v3d.y) && Number.isFinite(_v3d.z);
    } else if (this._player && typeof this._player.getNetBerthCollarPositionInto === 'function') {
      this._player.getNetBerthCollarPositionInto(_v3d);
      ringOk = Number.isFinite(_v3d.x) && Number.isFinite(_v3d.y) && Number.isFinite(_v3d.z);
    }
    const ring = ringOk ? _v3d : null;
    // the bag's axis: from the launch direction to the tow line (ring -> catch), so a bag hauled in from
    // off-centre lines up with its tether
    const L = vis._bagAxis || (vis._bagAxis = new THREE.Vector3());
    heldBagAxisInto(L, c, ring, net.launchDirection, g);
    vis._bagAxisOn = true;
    // the drawn apex: from the simulation's (update() wrote net.position into vis.group) to "touching the rear of
    // the catch", but never behind the ring the tether winds onto (a catch drawn larger than its seat would put it
    // inside the ship). A daughter's neck also keeps the apex ball's radius off her muzzle (not sunk into her launcher).
    let back = heldBagBack(rS, c, ring, L, muzzleArm ? DAUGHTER_STAND_M : 0);
    // the hand-off cinch: from the reel's bag to the one that is the wire bag's size (a sphere of its radius)
    const cinch = this._handOffCinch(vis, net, d);
    let ahead = BAG.RIM_AHEAD_FRAC * rS;
    let mouthR = BAG.MOUTH_FRAC * rS;
    if (cinch > 0) {
      const rho = Math.max(0.01, wireBagRadiusM(d) - BAG.WEIGHT_RADIUS_M) * M;
      const f = BAG.CINCH_RIM_AHEAD_OF_SPHERE;
      // the apex hub is the bag's farthest point from the catch (the closed rim and weights sit inside it), so its far
      // edge lands ON the wire bag's surface: the swap at the latch changes nothing
      back += (Math.max(0, wireBagRadiusM(d) * M - BAG.HUB_RADIUS_M * M) - back) * cinch;
      ahead += (f * rho - ahead) * cinch;
      mouthR += (Math.sqrt(1 - f * f) * rho - mouthR) * cinch;
    }
    const apex = vis.group.position;
    apex.x += (c.x - L.x * back - apex.x) * g;
    apex.y += (c.y - L.y * back - apex.y) * g;
    apex.z += (c.z - L.z * back - apex.z) * g;
    // the size: from the built cone to apex -> rim plane = back + RIM_AHEAD_FRAC radii, mouth MOUTH_FRAC radii
    const coneH = lerp(vis.coneHeight, back + ahead, g);
    const mouth = lerp(vis.mouthRadius, mouthR, g);
    NetMeshKit.setBagShape(kit, coneH, mouth);
    this._aimBag(vis, net);
  }

  /**
   * How far the net has cinched round its catch during the leash hand-off, 0 (the bag as the reel left it) to 1
   * (tight: the same size as the wire bag that takes over at the latch). It follows the catch's real approach to the
   * radiator tip's latch point (distance now against distance when the hand-off was first seen), only ever grows,
   * and is smoothed, so the bag shrinks as the catch comes in, never in a step. 0 when no hand-off of this net runs
   * (the daughter-rack transfer and every other state keep the old bag).
   * @param {object} d the catch (debris)
   * @returns {number} 0..1
   * @private
   */
  _handOffCinch(vis, net, d) {
    const drv = this._player && this._player.leashDriver;
    const view = drv && typeof drv.view === 'function' ? drv.view() : null;
    if (!view || view.net !== net || !view.tipWorld || !d || !d._scenePosition) return vis._handCinch || 0;
    const dist = view.tipWorld.distanceTo(d._scenePosition);
    if (!(vis._handD0 > 0)) vis._handD0 = Math.max(dist, 1e-6);
    // "arrived" = within CINCH_ARRIVED_FRAC of the starting distance (the catch is seated on the tip's bag, not at a point)
    const x = clamp01((1 - dist / vis._handD0) / (1 - BAG.CINCH_ARRIVED_FRAC));
    const c = smoothstep01(x);
    vis._handCinch = Math.max(vis._handCinch || 0, c);
    return vis._handCinch;
  }

  /**
   * True while the mother hauls or holds a catch smaller than MEMBRANE_WELDED_SMALL_SIZE_M — the film is then not
   * drawn so the catch stays visible through the thread lattice. A DAUGHTER's net the same way (she holds it in
   * REELING through the net reel, the haul, the dock and HOLDING_CATCH; CAPTURED is its one-tick lead-in), and a
   * carried bag (`_smallCatchFilm`, the rack and the tip). Mocks (no launcher arm) keep the old draw.
   * @returns {boolean}
   * @private
   */
  _filmHiddenForSmallCatch(net) {
    if (net.catchResult !== 'success') return false;
    const daughter = !net._isMother && !!this._daughterMuzzleArm(net);
    if (!net._isMother && !daughter) return false;
    const st = net.state;
    if (st !== STATES.REELING && st !== STATES.BERTHED && st !== STATES.COLLARED
        && !(daughter && st === STATES.CAPTURED)) return false;
    return this._smallCatchFilm(net.targetDebris);
  }

  /**
   * Is this catch smaller than the size below which the welded film hides (see `_filmHiddenForSmallCatch`)?
   * @returns {boolean}
   * @private
   */
  _smallCatchFilm(d) {
    const dSize = d?.sizeMeter || 0;
    const szLo = Constants.NET_WEB.MEMBRANE_WELDED_SMALL_SIZE_M ?? 0.8;
    return dSize > 0 && dSize < szLo;
  }

  /**
   * Thread-lattice opacity of a held (cinched) bag: 0.55, lerped toward THREAD_OPACITY_HELD_SMALL across the same
   * size band as the welded film. Whale class (>= LARGE_SIZE_M) and size-less mocks keep 0.55.
   * @returns {number}
   * @private
   */
  _heldThreadOpacity(net) {
    const NW = Constants.NET_WEB;
    const dSize = net.targetDebris?.sizeMeter || 0;
    let threadO = 0.55;
    const oSmall = NW.THREAD_OPACITY_HELD_SMALL;
    const szHi = NW.MEMBRANE_WELDED_LARGE_SIZE_M ?? 2.0;
    const szLo = NW.MEMBRANE_WELDED_SMALL_SIZE_M ?? 0.8;
    if (oSmall != null && dSize > 0 && szHi > szLo) {
      const st = clamp01((szHi - dSize) / (szHi - szLo));
      threadO += (oSmall - threadO) * st;
    }
    return threadO;
  }

  /**
   * Render the rim weights + drawstring as a STATIC fully-cinched ring at the closed radius on the mouth plane. Uses
   * the frozen spinAngle (not advanced) so consecutive frames are identical — no pulse, no spin.
   * @private
   */
  _setCinchedRim(vis) {
    const { rimWeights, drawstringLine, apexHub, weightCount } = vis;
    // The LIVE bag size (a held mother bag is shrunk onto its catch by _shapeHeldBag; otherwise these are the
    // build-time numbers vis carries).
    const closedRadius = vis.kitHandle.closedRadius;
    const coneHeight = vis.kitHandle.coneHeight;
    apexHub.visible = true;
    drawstringLine.visible = true;
    // The rim furniture honours the same mouth-plane contents floor the film draws (the kit's mouthFloorRadius — ONE
    // home, clamped to mouthRadius). A catch whose silhouette reaches the mouth plane holds the film's rim ring open;
    // the weights/drawstring ride that radius instead of closing to closedRadius THROUGH the catch. 0 whenever the
    // contents stop short of the mouth — the mother scenario included — so the gated draw is bit-identical. Angles
    // keep the visual's frozen vis.spinAngle basis (never the kit's _rimAngles/_spinAngle — that swap would rotate the
    // mother drawstring and move the fabric baseline).
    const r = Math.max(closedRadius, NetMeshKit.mouthFloorRadius(vis.kitHandle));
    for (let i = 0; i < weightCount; i++) {
      const angle = (2 * Math.PI * i / weightCount) + vis.spinAngle;
      rimWeights[i].position.set(
        r * Math.cos(angle),
        r * Math.sin(angle),
        -coneHeight,
      );
      rimWeights[i].visible = true;
    }
    this._updateDrawstring(vis);
  }

  /**
   * Update drawstring line vertex positions from current rim weight positions (spoke pattern
   * apex→w0→apex→w1→…→apex→wN-1→apex→w0). Delegates to the shared NetMeshKit so Mother + Daughter render the same web
   * topology (single source of truth); the kit handle's rimWeights / drawstringPositions / drawstringLine are
   * reference-identical to the vis entry's. No allocations.
   * @private
   */
  _updateDrawstring(vis) {
    NetMeshKit.updateDrawstring(vis.kitHandle);
  }

  /**
   * Failure staging: drive the cinch furniture from the beat's cinchFrac (vis.failure.cinch, freshly written by the
   * drape driver this frame) — the ring opens toward the mouth on a slip and springs off on a bounce, floored at the
   * same mouth-plane contents floor CINCH_CLOSING honours so the ring never sweeps through the catch it is releasing.
   * Weights ride the frozen spinAngle basis (same as _setCinchedRim — never the kit's).
   * @private
   */
  _stageFailureFurniture(vis) {
    const { rimWeights, drawstringLine, apexHub, weightCount } = vis;
    // The live bag size (a bag that let go of its catch un-gathers from the compact held shape)
    const kitLive = vis.kitHandle || vis;
    const { mouthRadius, closedRadius, coneHeight } = kitLive;
    apexHub.visible = true;
    drawstringLine.visible = true;
    const cinch = vis.failure ? vis.failure.cinch : 0;
    const r = Math.max(
      lerp(mouthRadius, closedRadius, cinch),
      NetMeshKit.mouthFloorRadius(vis.kitHandle),
    );
    for (let i = 0; i < weightCount; i++) {
      const angle = (2 * Math.PI * i / weightCount) + vis.spinAngle;
      rimWeights[i].position.set(
        r * Math.cos(angle),
        r * Math.sin(angle),
        -coneHeight,
      );
      rimWeights[i].visible = true;
    }
    this._updateDrawstring(vis);
  }

  /**
   * Failure staging: end a beat — hand the bag to the ordinary fade timer (which then owns opacity + removal).
   * Idempotent; safe to call from either clock (the state-machine beat branch or the detached-bag branch).
   * @private
   */
  _endFailureBeat(key, vis) {
    if (!vis.failure) return;
    vis.failure = null;
    vis.fadingOut = true;
    this._fadeTimers.push({ key, timer: 1.0, duration: 1.0 });
  }

  /**
   * The apex hub world position for a net visual key; the group position when the flag is OFF or the key is not found.
   * The camera can use it for tether-attach-point framing.
   * @returns {THREE.Vector3} scratch vector — caller must copy if persisting
   */
  getTetherAttachPoint(key) {
    const vis = this._activeVisuals.get(key);
    if (!vis) {
      _v3a.set(0, 0, 0);
      return _v3a;
    }
    if (vis.useCeremony && vis.apexHub) {
      vis.apexHub.getWorldPosition(_v3a);
      return _v3a;
    }
    // Flag-OFF: return group position (centre of flat disc)
    _v3a.copy(vis.group.position);
    return _v3a;
  }

  /** Clean up all visuals and unsubscribe from events. */
  dispose() {
    for (const key of [...this._activeVisuals.keys()]) {
      this._removeNetVisual(key);
    }
    // the near-pass tether root goes with them
    if (this._tetherRoot) {
      const sm = this._sceneManager;
      if (sm && typeof sm.unregisterNearFieldRoot === 'function') sm.unregisterNearFieldRoot(this._tetherRoot);
      if (this._scene) this._scene.remove(this._tetherRoot);
      this._tetherRoot = null;
    }

    if (this._boundNetFired)      eventBus.off(Events.NET_FIRED,          this._boundNetFired);
    if (this._boundNetAdopted)    eventBus.off(Events.NET_ADOPTED,        this._boundNetAdopted);
    if (this._boundNetCaught)     eventBus.off(Events.NET_CATCH_SUCCESS,  this._boundNetCaught);
    if (this._boundNetMiss)       eventBus.off(Events.NET_CATCH_MISS,     this._boundNetMiss);
    if (this._boundReelCompleted) eventBus.off(Events.NET_REEL_COMPLETED, this._boundReelCompleted);
    if (this._boundNetReleased)   eventBus.off(Events.NET_RELEASED,       this._boundNetReleased);
    if (this._boundNetTorn)       eventBus.off(Events.NET_TORN,           this._boundNetTorn);
    if (this._boundNetFailed)     eventBus.off(Events.NET_FAILED,         this._boundNetFailed);
    if (this._boundCargoDone)     eventBus.off(Events.CARGO_TRANSFER_COMPLETE, this._boundCargoDone);
    if (this._boundNetConsumed)   eventBus.off(Events.NET_CONSUMED,       this._boundNetConsumed);
    if (this._boundTierChanged)   eventBus.off(Events.PERF_TIER_CHANGED,  this._boundTierChanged);
    if (this._boundArmDocked)     eventBus.off(Events.ARM_DOCKED,             this._boundArmDocked);
    if (this._boundCarryCancel)   eventBus.off(Events.CATCH_BREAKDOWN_CANCEL, this._boundCarryCancel);
    if (this._boundCarryReset) {
      eventBus.off(Events.GAME_RESET,        this._boundCarryReset);
      eventBus.off(Events.GAMEOVER_CONTINUE, this._boundCarryReset);
    }

    this._boundNetFired = null;
    this._boundNetAdopted = null;
    this._boundNetCaught = null;
    this._boundNetMiss = null;
    this._boundReelCompleted = null;
    this._boundNetReleased = null;
    this._boundNetTorn = null;
    this._boundNetFailed = null;
    this._boundCargoDone = null;
    this._boundNetConsumed = null;
    this._boundTierChanged = null;
    this._boundArmDocked = null;
    this._boundCarryCancel = null;
    this._boundCarryReset = null;

    this._fadeTimers = [];
    this._nettedIds.clear();
    this._enabled = false;
    this._disposed = true;
  }
}

export const captureNetVisual = new CaptureNetVisual();
export default captureNetVisual;
