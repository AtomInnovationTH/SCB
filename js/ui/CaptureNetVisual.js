/**
 * CaptureNetVisual.js — 3-D renderer for active capture nets.
 * V-8: Epic 10 Capture Net Visual
 *
 * Manages one mesh group per active net, updates geometry / appearance
 * every frame based on the 14-state NetProjectile FSM in CaptureNet.js.
 *
 * Renders:  canister (folded/launching) → spinning disc (flight→capture)
 *           + tether line from strut tip to net position.
 *
 * When FEATURE_FLAGS.NET_CEREMONY is ON (Stage 2+), replaces the flat disc
 * with a cone mesh, rim weight spheres, drawstring line, and apex hub.
 *
 * Gated behind FEATURE_FLAGS.CAPTURE_NET.
 *
 * @module ui/CaptureNetVisual
 */

import * as THREE from 'three';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { CeremonyTimeScale } from '../systems/CeremonyTimeScale.js';
import { NetMeshKit } from './NetMeshKit.js';
// Whale-in-cone phase 3 (Task 5): the ceremony driver reads the catch's REAL
// rendered size to floor the drawn bag on its contents. ui → entities edge;
// no cycle (DebrisField does not import CaptureNetVisual).
import { DebrisWireframe } from './DebrisWireframe.js';
import { DebrisField } from '../entities/DebrisField.js';
// S5 failure staging: the reason→beat mapper lives with missReasonToText in
// the entity (one home for "which failures are staged" — logic and visual must
// never diverge). ui → entities edge; no cycle (CaptureNet does not import ui).
import { missFailureKind } from '../entities/CaptureNet.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';

/** 1 metre in scene units (1 scene unit = 100 km). Same as PlayerSatellite.js */
const M = 1e-5;

const STATES = Constants.CAPTURE_NET.STATES;
const NET_CER = Constants.CAPTURE_NET.NET_CEREMONY;
// Animation needs access to state-duration constants (ENVELOP_TIME etc.) to
// drive ceremony-state visuals from net.stateTimer instead of the broken
// `net.tangleQuality` proxy (which is 0 throughout ENVELOP / CINCH_CLOSING
// and only set on CAPTURED transition).
const CN = Constants.CAPTURE_NET;

// ── Re-usable colour constants ──────────────────────────────────────────
// 2026-06-30 realism pass: the net fabric renders as ONE ivory Dyneema colour
// (COL_DISC) through the ENTIRE capture FSM. A real recovery net has no
// mechanism to change colour when it catches something, so the old
// state-coded hue progression (ivory → yellow → orange → red → magenta →
// green) was pure arcade signalling painted onto a physical object. Capture
// STATE (CONTACT → BRAKE → ENVELOP → CINCH → SECURE → CAPTURED / MISS) now
// lives on the docking reticle / HUD (DockingReticle._drawOddsStripInFlight +
// _netPhaseReadout) and the comms log. Only PHYSICAL motion — spin, cinch
// contraction, opacity, and the slack drift-out fade on a miss — still plays
// on the net itself. (Rim-weight edge-node emissive is left intact: it is a
// glint on the tungsten weights, not a recolour of the fabric.)
const COL_CANISTER  = 0x556677;
const COL_DISC      = 0xcfeaff;   // ivory Dyneema — the net's ONLY fabric colour, every state
// NOTE: the tether's colour is NOT defined here — it is Constants.NET_WEB
// .WEB_COLOR, aliased below as TETHER_BASE_COLOR (C0/V5: cable and net share
// one colour SSOT — the old NET_TETHER.BASE_COLOR 0xddddee had drifted from
// the web's ivory). The material's base colour and the emissive-pulse reset
// must share one source, or the two drift apart.

// Scratch vectors (avoid per-frame allocation)
const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _v3c = new THREE.Vector3();
const _v3d = new THREE.Vector3();
// Balloon→fabric (F1): scratch rotation state for the per-frame contents-BOX
// spec, plus the scratch spec itself. The kit COPIES the numbers into a
// per-handle object, so this single scratch can serve every live net.
const _qA = new THREE.Quaternion();
const _qB = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();
const _vBox = new THREE.Vector3();
const _contentsBoxScratch = { ox: 0, oy: 0, oz: 0,
  r00: 1, r01: 0, r02: 0, r10: 0, r11: 1, r12: 0, r20: 0, r21: 0, r22: 1,
  hx: 0, hy: 0, hz: 0 };

// ── Tether catenary (mother-net-reel plan §11.4 Phase D.4) ───────────────
// The 2-point THREE.Line is replaced by a Line2/LineMaterial fat-line strand
// (the LassoSystem idiom) sampled along a quadratic slack curve. Sag is
// quadratic in the slack ratio: a paying-out tether bows, a taut one snaps
// straight. At CAPTURED the strand goes taut with a 0.2 s decaying lateral
// twang, and pulses briefly emissive above the 2.5 bloom threshold.
// Phase D hardening (F5): the tunables now live in Constants.CAPTURE_NET.NET_TETHER
// (one tuning surface, §11.8). These thin module-local aliases keep the hot
// tether/drape loops readable.
const _NT = Constants.CAPTURE_NET.NET_TETHER;
const TETHER_SEGMENTS = _NT.SEGMENTS;
const TETHER_TWANG_S = _NT.TWANG_S;
const TETHER_TWANG_AMP_M = _NT.TWANG_AMP_M;
const TETHER_SAG_FRAC = _NT.SAG_FRAC;
const TETHER_TAUT_SLACK = _NT.TAUT_SLACK;
const TETHER_EMISSIVE_S = _NT.EMISSIVE_S;
const TETHER_EMISSIVE_HDR = _NT.EMISSIVE_HDR;
const TETHER_BASE_COLOR = Constants.NET_WEB.WEB_COLOR;   // C0/V5: one colour SSOT

// ── Kit-frame attitude helper (register item 13, 2026-08-06) ─────────────
// Plan: .kilo/plans/1786017377440-pin-scenario-catch-tumble.md (D2).
//
// The floor/chord maths and the pixel gate both see the catch's attitude in KIT
// space: the driver composes `qB2K = qKit⁻¹ ⊗ axisAngle(tumbleAxis, tumbleAngle)`
// (see the contents-box block below), where `qKit` is the kit group's WORLD
// quaternion — set by `group.lookAt(position − launchDirection × ε)` in
// `_updateCeremonyState` (the convention block near the end of this file: local
// −Z = launchDirection, up = +Y). A dev harness that wants a REPEATABLE attitude
// must therefore pin the tumble in the kit frame, not the world frame, or every
// staging bearing yields a different measured attitude.
//
// This is that one conversion, in the module that owns the convention, using the
// IDENTICAL `Object3D.lookAt` call the drawing path uses (never a hand-rolled
// basis — three's degenerate-up handling is part of the convention). Pure and
// allocation-light: one scratch Object3D, no scene graph, no side effects.
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
  // NaN cannot reach here, so a plain magnitude test is now sound (a
  // `lengthSq() < eps` guard alone would MISS NaN — `NaN < eps` is false — and
  // would hand a NaN pin to the harness, which its 10° attitude check cannot
  // see either: `NaN > 10` is false. Reject at the door instead).
  return out.lengthSq() < 1e-24 ? null : out.normalize();
}

/**
 * World-frame axis/angle that seats a body at a chosen KIT-frame attitude.
 *
 * @param {{x:number,y:number,z:number}} launchDirection — the net's frozen launch
 *        bearing (any non-zero length; normalised internally).
 * @param {{x:number,y:number,z:number}} kitAxis — desired rotation axis, KIT frame
 *        (kit −Z is the launch bearing, so kit X/Y lie across the bag mouth).
 * @param {number} kitAngleRad — desired rotation angle about `kitAxis`.
 * @returns {{axis:{x:number,y:number,z:number}, angle:number,
 *            worldQuat:{x:number,y:number,z:number,w:number}}|null}
 *          `axis` (unit) + `angle` to write into `tumbleAxis`/`tumbleAngle`, plus
 *          the composed world quaternion (`axisAngle(axis, angle)` — the
 *          decomposition is lossless; asserted in test-CaptureNetVisual.js).
 *          `null` on ANY degenerate or non-finite input — never a silently wrong
 *          pin, because a wrong-but-plausible attitude reads as a valid gate
 *          measurement of the wrong thing.
 *          Guarantees `qKit⁻¹ ⊗ axisAngle(axis, angle) === axisAngle(kitAxis, kitAngleRad)`,
 *          i.e. the box-in-kit rotation the metrics read IS the requested attitude.
 */
export function worldTumbleForKitAttitude(launchDirection, kitAxis, kitAngleRad) {
  if (!Number.isFinite(kitAngleRad)) return null;
  if (!_readFiniteVec3(launchDirection, _vKitDir)) return null;
  if (!_readFiniteVec3(kitAxis, _vKitAxis)) return null;

  // Same call, same ε-target formula, same default up as the drawing path.
  _kitFrameProbe.position.set(0, 0, 0);
  _kitFrameProbe.quaternion.identity();
  _kitFrameProbe.lookAt(-_vKitDir.x * 0.001, -_vKitDir.y * 0.001, -_vKitDir.z * 0.001);
  _qKit.copy(_kitFrameProbe.quaternion);

  _qDesired.setFromAxisAngle(_vKitAxis, kitAngleRad);
  _qKit.multiply(_qDesired);            // qTumble(world) = qKit ⊗ R_desired(kit)

  // Axis/angle decomposition (same shape as CaptureNet._applyCatchOrientation).
  const w = Math.max(-1, Math.min(1, _qKit.w));
  const angle = 2 * Math.acos(w);
  const s = Math.sqrt(Math.max(0, 1 - w * w));
  const axis = (s > 1e-6)
    ? { x: _qKit.x / s, y: _qKit.y / s, z: _qKit.z / s }
    : { x: 0, y: 1, z: 0 };
  return { axis, angle, worldQuat: { x: _qKit.x, y: _qKit.y, z: _qKit.z, w: _qKit.w } };
}

/**
 * The contents-box spec ROWS a given KIT-frame attitude produces — i.e. the
 * matrix of `qB2K⁻¹` in the row order the box spec carries (`v_box = R · v_kit`).
 *
 * ONE home for the row/transpose convention: the driver's per-frame composition
 * below writes these same nine numbers from the LIVE tumble, and the harness
 * compares that live spec against this function's output to prove the pinned
 * attitude reached the metric. Two independent copies of this convention would
 * let the check silently validate against a stale one.
 *
 * @param {{x:number,y:number,z:number}} kitAxis — rotation axis, KIT frame.
 * @param {number} kitAngleRad — rotation angle about `kitAxis`.
 * @returns {number[]|null} `[r00, r01, r02, r10, r11, r12, r20, r21, r22]`, or
 *          `null` on a degenerate/non-finite input.
 */
export function boxRowsForKitAttitude(kitAxis, kitAngleRad) {
  if (!Number.isFinite(kitAngleRad)) return null;
  if (!_readFiniteVec3(kitAxis, _vKitAxis)) return null;
  _qDesired.setFromAxisAngle(_vKitAxis, kitAngleRad).invert();
  const e = _mKitRows.makeRotationFromQuaternion(_qDesired).elements;   // column-major
  return [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]];
}

// ════════════════════════════════════════════════════════════════════════
// CaptureNetVisual
// ════════════════════════════════════════════════════════════════════════

/**
 * Derive a unique visual key + lookup metadata from an event payload.
 * Daughter-arm nets carry armIndex ≥ 0; mother-pod nets carry podIndex ≥ 0
 * with armIndex absent or -1.
 *
 * @param {object} payload — event payload with armIndex? / podIndex?
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
     * Active visual entries keyed by composite string ('arm_0', 'pod_1', etc.)
     * @type {Map<string, {group:THREE.Group, canisterMesh:THREE.Mesh, discMesh:THREE.Mesh, tetherLine:THREE.Line, tetherPositions:Float32Array, armIndex:number, podIndex:number}>}
     */
    this._activeVisuals = new Map();
    /** @type {boolean} */
    this._disposed = false;
    /** @type {Array<{key:string, timer:number, duration:number}>} */
    this._fadeTimers = [];
    /** @type {string} Current quality tier (LOW drops the garnish, §11.8). */
    this._tier = 'HIGH';

    /** @type {boolean} Cached ceremony flag — frozen at construct time (§2.4.1) */
    this._useCeremony = !!Constants.FEATURE_FLAGS.NET_CEREMONY;

    // Bound handler refs for EventBus unsubscription
    this._boundNetFired = null;
    this._boundNetCaught = null;
    this._boundNetMiss = null;
    this._boundReelCompleted = null;
    this._boundNetReleased = null;
    this._boundNetTorn = null;
    this._boundNetFailed = null;
    this._boundTierChanged = null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Initialise the visual system.  No-ops if CAPTURE_NET flag is false.
   * @param {THREE.Scene} scene
   * @param {object} player   — PlayerSatellite instance
   * @param {object} captureNetSystem — CaptureNetSystem singleton
   * @param {object} [sceneManager] — optional; backs the Phase D.8 LOW-tier
   *   garnish gate (twang, drape jiggle, tether pulse, pendulum, micro-shake
   *   drop at LOW; structure stays). Live changes arrive via PERF_TIER_CHANGED.
   */
  init(scene, player, captureNetSystem, sceneManager = null) {
    if (!Constants.FEATURE_FLAGS.CAPTURE_NET) return;

    this._scene = scene;
    this._player = player;
    this._captureNetSystem = captureNetSystem;
    this._sceneManager = sceneManager;   // V4: camera source for depth shading
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
    this._boundTierChanged   = (p) => { this._tier = p?.to ?? this._tier; };

    eventBus.on(Events.NET_FIRED,          this._boundNetFired);
    eventBus.on(Events.NET_CATCH_SUCCESS,  this._boundNetCaught);
    eventBus.on(Events.NET_CATCH_MISS,     this._boundNetMiss);
    eventBus.on(Events.NET_REEL_COMPLETED, this._boundReelCompleted);
    eventBus.on(Events.NET_RELEASED,       this._boundNetReleased);
    eventBus.on(Events.NET_TORN,           this._boundNetTorn);
    eventBus.on(Events.NET_FAILED,         this._boundNetFailed);
    eventBus.on(Events.CARGO_TRANSFER_COMPLETE, this._boundCargoDone);
    eventBus.on(Events.PERF_TIER_CHANGED,  this._boundTierChanged);
    this._tier = sceneManager?.currentTier ?? 'HIGH';
  }

  /**
   * Phase D.8 (mother-net-reel plan §11.8) — true when the current quality
   * tier keeps a garnish item. LOW keeps structure (the net web, tether,
   * cinch) and drops the garnish: tether twang, drape jiggle, tether emissive
   * pulse, berthed pendulum, camera micro-shake. Every garnish item reads this
   * gate (its own constant lives in Constants.CAPTURE_NET).
   * @returns {boolean}
   * @private
   */
  _garnishOn() {
    return this._tier !== 'LOW';
  }

  // ── Net lookup helper ──────────────────────────────────────────────────

  /**
   * Look up the active NetProjectile for a visual entry.
   * Uses getActiveNetForArm for daughter arms, getActiveNetForPod for mother pods.
   * @param {number} armIndex
   * @param {number} podIndex
   * @returns {object|null} NetProjectile or null
   * @private
   */
  _getNet(armIndex, podIndex) {
    if (armIndex >= 0) return this._captureNetSystem.getActiveNetForArm(armIndex);
    if (podIndex >= 0) return this._captureNetSystem.getActiveNetForPod(podIndex);
    return null;
  }

  // ── Event handlers ─────────────────────────────────────────────────────

  /** @private */
  _onNetFired(payload) {
    const { key, armIndex, podIndex } = resolveNetId(payload);
    const existing = this._activeVisuals.get(key);
    if (existing) {
      // S5: a DYING bag must not block the next net's visual. A staged failure
      // holds the key for the beat + fade (~2.4 s) where the legacy miss held
      // it for 1.0 s, and COOLDOWN_MISS is 1 s — so a re-fire would have found
      // the key taken and rendered NO bag at all. A new net for the same
      // launcher supersedes a bag that is only fading/detached; a live one
      // still wins (the duplicate-NET_FIRED guard this replaces).
      if (!existing.detached && !existing.failure && !existing.fadingOut) return;
      this._removeNetVisual(key);
    }
    const net = this._getNet(armIndex, podIndex);
    if (!net) return;
    this._createNetVisual(key, armIndex, podIndex, net);
  }

  /** @private
   * A successful catch no longer repaints the net. Real Dyneema does not flash
   * green on grip — the CAPTURED signal lives on the reticle/HUD
   * (DockingReticle) and the comms log now. Kept as a documented no-op so the
   * NET_CATCH_SUCCESS subscription + dispose() symmetry stay intact.
   */
  _onNetCaught(_payload) { /* capture state shown on the reticle/HUD, not the mesh */ }

  /** @private Miss: the net goes slack and drifts off, fading out. No red
   * recolour — the mesh stays ivory and simply fades; the MISS reason is
   * spoken on the comms log / reticle.
   * S5 failure staging: a STAGED reason (bounce/slip — missFailureKind) arms a
   * per-visual beat instead of fading immediately. The bag holds at the
   * contact point (the system's auto-reel is deferred for the same window),
   * the drape driver plays the beat, and the fade is pushed only when the
   * beat completes — so the failure plays at full opacity. Unstaged reasons
   * keep the legacy immediate fade. Ceremony visuals only: the flag-off disc
   * path has no kit drives to stage. */
  _onNetMiss(payload) {
    const { key } = resolveNetId(payload);
    const vis = this._activeVisuals.get(key);
    const kind = missFailureKind(payload?.reason);
    if (vis && kind && vis.kitHandle) {
      vis.failure = {
        kind,
        t: 0,
        dur: Constants.CAPTURE_NET.FAILURE_STAGING_S ?? 1.4,
        // The drape/cinch the failure found the bag in — a cinch-path bounce
        // starts welded and releases; a slam-path bounce starts at the cone
        // and slaps. cinch is the beat's last-driven value for the furniture.
        drape0: vis.kitHandle._drape || 0,
        cinch0: vis.kitHandle._cinchFrac || 0,
        cinch: vis.kitHandle._cinchFrac || 0,
      };
      return;   // the fade is pushed when the beat completes (see update)
    }
    this._fadeTimers.push({ key, timer: 1.0, duration: 1.0 });
  }

  /** @private
   * UX-11 #2: a successful daughter catch reaches NET_REEL_COMPLETED at the
   * HOLDING_CATCH *chop* boundary (the held net stows once the arm clears
   * `debris._capturedByArm` — see ArmUnit._updateHoldingCatch). Removing the
   * bag instantly made it POP right as the furnace breakdown starts. Instead,
   * hand off: freeze the bag at the strut tip and fade it out while
   * FurnaceBreakdownVisual takes over the chop. Empty (miss) reels still
   * remove immediately — the miss fade timer owns that path.
   */
  _onReelCompleted(payload) {
    const { key, podIndex } = resolveNetId(payload);
    // Mother-net-reel plan §8 A2: a MOTHER catch transitions to BERTHED on
    // reel completion — the cinched bag must PERSIST at the launcher (with a
    // short taut tether stub), not fade. The daughter hand-off fade below is
    // for the furnace chop; the mother berth has no chop in Phase A. Removal
    // happens on NET_RELEASED (jettison) or when the securing timer splices
    // the net out of activeNets (the update loop's _getNet → null path).
    if (podIndex >= 0) return;
    if (payload && payload.capturedMass > 0) {
      const vis = this._activeVisuals.get(key);
      // S5: a failure beat owns the bag — the daughter's net stows (and this
      // event fires) when the arm releases the catch on a slip/rip, but the
      // staged failure must play out, not be cut short by the success
      // hand-off fade.
      if (vis && !vis.failure) {
        vis.detached = true;   // state-driven updates stop; fade timer owns removal
        this._fadeTimers.push({ key, timer: 0.8, duration: 0.8 });
        return;
      }
      if (vis) return;         // failure beat in flight — it owns the fade
    }
    this._removeNetVisual(key);
  }

  /**
   * Cargo-continuity S7 — the hand-off landed: the piece is now on a daughter's
   * cargo rack and the mother's net has been spliced out of `activeNets`.
   *
   * Without this the bag would POP: the update loop's `_getNet → null` path
   * removes a vanished net's visual immediately. Reuse the established beat
   * instead — freeze the bag where it arrived and fade it over 0.8 s (the same
   * idiom as the daughter's furnace hand-off at NET_REEL_COMPLETED above), so the
   * equipment leaves on camera while the CARGO it carried stays pinned at the
   * strut tip by the rack. Continuity law: the catch never stops being drawn.
   */
  _onCargoTransferred(payload) {
    const pi = payload?.podIndex;
    if (pi == null || pi < 0) return;
    const key = `pod_${pi}`;
    const vis = this._activeVisuals.get(key);
    if (!vis) return;
    vis.detached = true;      // state-driven updates stop; the fade owns removal
    this._fadeTimers.push({ key, timer: 0.8, duration: 0.8 });
  }

  /** @private
   * S5 rip staging (owner item 7): the daughter's net TORE under boost reel.
   * The NetProjectile stows + prunes on its next tick, so take the bag over
   * NOW via the detach idiom (the same one the furnace hand-off uses) and cut
   * the hole into it: zero a wedge of spokes in the kit's per-vertex colour
   * buffer. The catch, already released by the arm, drifts out of the torn
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
   * S5 slip staging for the daughter's reel-start integrity failure
   * (_checkNetIntegrityOnReel — oversize or strain): the cinched bag releases
   * its catch and opens back toward the flight cone. Same detach idiom as the
   * rip — the boost-reel rip also emits NET_FAILED (cause 'boost_reel') but is
   * owned by _onNetTorn, so it is skipped here.
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

  // ── Visual creation / removal ──────────────────────────────────────────

  /**
   * Create a visual group for one net projectile.
   * @param {string} key            — composite map key ('arm_0', 'pod_1')
   * @param {number} armIndex       — daughter arm index (≥0) or -1
   * @param {number} podIndex       — mother pod index (≥0) or -1
   * @param {object} netProjectile  — NetProjectile instance
   * @private
   */
  _createNetVisual(key, armIndex, podIndex, netProjectile) {
    if (Constants.FEATURE_FLAGS.NET_CEREMONY) {
      this._createCeremonyVisual(key, armIndex, podIndex, netProjectile);
      return;
    }

    const group = new THREE.Group();
    group.name = `CaptureNetVis_${key}`;

    // ── Canister (FOLDED / LAUNCHING) ──
    const canGeo = new THREE.CylinderGeometry(M * 0.08, M * 0.08, M * 0.25, 8);
    const canMat = new THREE.MeshStandardMaterial({
      color: COL_CANISTER,
      metalness: 0.6,
      roughness: 0.4,
    });
    const canisterMesh = new THREE.Mesh(canGeo, canMat);
    canisterMesh.name = 'canister';
    group.add(canisterMesh);

    // ── Disc (SPINNING_UP → CAPTURED) ──
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

    // ── Tether line — Line2 catenary (Phase D.4, plan §11.4) ──
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
    group.add(tetherLine);

    this._scene.add(group);
    this._activeVisuals.set(key, {
      group,
      canisterMesh,
      discMesh,
      tetherLine,
      tetherPositions,
      // P1: the tether's instanced-interleaved buffer (pairs format). Captured
      // once so _updateTetherCatenary writes it in place instead of calling
      // LineGeometry.setPositions (double allocation per frame — polyline→pairs
      // Float32Array + a fresh InstancedInterleavedBuffer/attrs/bounds).
      tetherSegBuffer: tetherGeo.attributes.instanceStart.data,
      armIndex,
      podIndex,
      // Phase D.4 catenary state
      _tetherTwangT: -1,        // seconds since line-taut; <0 = no twang
      _tetherEmissiveT: -1,     // seconds since taut pulse; <0 = no pulse
      _tetherWasTaut: false,    // edge detect for the taut snap
    });
  }

  /**
   * Create the ceremony visual group: cone mesh, rim weights, drawstring, apex hub.
   * Only called when FEATURE_FLAGS.NET_CEREMONY is true.
   * @param {string} key
   * @param {number} armIndex
   * @param {number} podIndex
   * @param {object} netProjectile
   * @private
   */
  _createCeremonyVisual(key, armIndex, podIndex, netProjectile) {
    const group = new THREE.Group();
    group.name = `CaptureNetVis_${key}`;

    // ── Canister (FOLDED / LAUNCHING) — same as flag-OFF ──
    const canGeo = new THREE.CylinderGeometry(M * 0.08, M * 0.08, M * 0.25, 8);
    const canMat = new THREE.MeshStandardMaterial({
      color: COL_CANISTER,
      metalness: 0.6,
      roughness: 0.4,
    });
    const canisterMesh = new THREE.Mesh(canGeo, canMat);
    canisterMesh.name = 'canister';
    group.add(canisterMesh);

    // ── Cone mesh + rim weights + drawstring + apex hub — shared NetMeshKit ──
    // Stage A: the kit reproduces the daughter's ceremony web 1:1 (cone rotateX/
    // translate, closedRadius, spoke pattern). The FSM below (_updateCeremonyState)
    // keeps positioning the kit-owned `rimWeights` with its existing, tested math
    // (F4 lookAt / F5 envZ + cinch-plane / F6 detached-bag); only the mesh SOURCE
    // moved into the kit. Defaults match the old inline construction exactly
    // (16×4 cone, opacity 0.55, COL_DISC, 0.08 m nodes, 0.05 m apex hub).
    const diameter = netProjectile.netClass.DIAMETER || 8;
    const weightCount = netProjectile.netClass.RIM_WEIGHT_COUNT || 4;
    const kitHandle = NetMeshKit.build({
      diameter,
      weightCount,
      // childrenVisible defaults false — the FSM toggles per-state visibility.
    });
    const coneMesh = kitHandle.coneMesh;
    const rimWeights = kitHandle.rimWeights;
    const rimWeightMats = kitHandle.rimWeightMats;
    const drawstringLine = kitHandle.drawstringLine;
    const drawstringPositions = kitHandle.drawstringPositions;
    const apexHub = kitHandle.apexHub;
    group.add(kitHandle.group);

    // ── Tether line (same Line2 catenary as the flag-OFF path) ──
    const tetherPositions = new Float32Array((TETHER_SEGMENTS + 1) * 3);
    const tetherGeo = new LineGeometry();
    tetherGeo.setPositions(tetherPositions);
    const tetherMat = new LineMaterial({
      color: TETHER_BASE_COLOR,
      transparent: true,
      opacity: 0.7,
      linewidth: Constants.NET_WEB.TETHER_WIDTH_M, // V3: world units (m) — the
      // strand thickens on approach, AA-smooth at distance (was fixed 2.0 px)
      worldUnits: true,             // width is metres, not screen px
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
    group.add(tetherLine);

    this._scene.add(group);
    this._activeVisuals.set(key, {
      group,
      canisterMesh,
      discMesh: coneMesh,          // alias for flash-timer compat
      coneMesh,
      kitHandle,                   // owns cone/weights/drawstring/apex geometry+materials
      tetherLine,
      tetherPositions,
      tetherSegBuffer: tetherGeo.attributes.instanceStart.data,   // P1 (see flag-OFF path)
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
      armIndex,
      podIndex,
      useCeremony: true,
      // Phase D.4 catenary state
      _tetherTwangT: -1,
      _tetherEmissiveT: -1,
      _tetherWasTaut: false,
    });
  }

  /**
   * Remove and dispose a visual by its composite key.
   * @param {string} key
   * @private
   */
  _removeNetVisual(key) {
    const vis = this._activeVisuals.get(key);
    if (!vis) return;

    this._scene.remove(vis.group);

    // Dispose geometries + materials
    vis.canisterMesh.geometry.dispose();
    vis.canisterMesh.material.dispose();

    if (vis.useCeremony) {
      // Ceremony path — cone, weights, drawstring, apex hub are kit-owned.
      NetMeshKit.dispose(vis.kitHandle);
    } else {
      // Original path — flat disc
      vis.discMesh.geometry.dispose();
      vis.discMesh.material.dispose();
    }

    vis.tetherLine.geometry.dispose();
    NetMeshKit.unregisterLineMaterial(vis.tetherLine.material);
    vis.tetherLine.material.dispose();

    this._activeVisuals.delete(key);

    // Purge associated timers
    this._fadeTimers  = this._fadeTimers.filter(f => f.key !== key);
  }

  // ── Per-frame update ───────────────────────────────────────────────────

  /**
   * Tick all active net visuals.  Called from the game loop.
   * @param {number} dt — seconds
   */
  update(dt) {
    if (!this._enabled) return;

    // Stage 4 (CEREMONY_REDESIGN.md §5, §6 R1): apply ceremony time-dilation to
    // visual dt only. World dt at the caller (main.js → captureNetVisual.update)
    // is unaffected. When the flag is OFF or no ceremony is active,
    // CeremonyTimeScale.get() === 1.0 (short-circuit, no-op multiply).
    const scale = Constants.FEATURE_FLAGS.NET_CEREMONY ? CeremonyTimeScale.get() : 1.0;
    dt = dt * scale;

    // ── Tick fade timers ──
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
        vis.discMesh.material.opacity = Math.max(0, f.timer / f.duration) * 0.6;
      }
    }

    // ── Update each active visual ──
    for (const [key, vis] of this._activeVisuals) {
      // UX-11 #2: detached bag (post-chop hand-off) — the NetProjectile is
      // gone; keep the fading bag seated at the strut tip (mother's
      // co-orbiting frame) so it doesn't streak away at orbital speed while
      // the fade timer plays out.
      if (vis.detached) {
        if (vis.failure && vis.failure.debris && vis.failure.debris._scenePosition) {
          // S5: a torn/slipped daughter bag stays on the drifting catch it
          // released (the failure happened out at the daughter, not at the
          // dock) — never teleported to the strut tip. The bag opens/fades in
          // place around the catch; the catch visibly drifts on (continuity).
          vis.group.position.copy(vis.failure.debris._scenePosition);
        } else if (vis.armIndex >= 0 && this._player?.strutTipNodes?.[vis.armIndex]) {
          this._player.strutTipNodes[vis.armIndex].getWorldPosition(vis.group.position);
        } else if (vis.podIndex >= 0 && typeof this._player?.getNetPodPositionInto === 'function') {
          // Mother-pod catch — seat the fading bag on the pod muzzle (the
          // dead `player.group` branch seated NOTHING — PlayerSatellite
          // extends THREE.Group, so `player.group` is undefined and a
          // detached mother bag streaked away at 70 km/s; plan §2 C2).
          this._player.getNetPodPositionInto(vis.podIndex, vis.group.position);
        }
        // S5: tick a detached failure beat — the slip's un-cinch drives the
        // kit directly (no state machine remains to drive it); the rip's hole
        // is already cut (one write at the event). The fade starts at beat end.
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
            // The furniture must open WITH the fabric — the state switch never
            // runs for a detached bag, so drive the rim ring/strands here or
            // the weights stay bunched around a bag that has already let go.
            this._stageFailureFurniture(vis);
          }
          if (f >= 1) this._endFailureBeat(key, vis);
        }
        continue;
      }

      const net = this._getNet(vis.armIndex, vis.podIndex);
      if (!net) {
        // S5: a net pruned mid-beat (a very short reel-back under ceremony
        // time-dilation) detaches instead of popping — the beat/fade finish.
        if (vis.failure) { vis.detached = true; continue; }
        this._removeNetVisual(key);
        continue;
      }

      const { group, canisterMesh, discMesh, tetherLine, tetherPositions } = vis;
      const state = net.state;

      // ── Position: net.position is in metres → multiply by M ──
      group.position.set(
        net.position.x * M,
        net.position.y * M,
        net.position.z * M,
      );

      // ── State-driven visibility + appearance ──
      // ── Ceremony path: separate state handler ──
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
          // Scale from 0→1 as spin ramps up
          const spinFrac = net.netClass.SPIN_HZ > 0
            ? Math.min(1, net.spinRate / net.netClass.SPIN_HZ)
            : 1;
          discMesh.scale.setScalar(Math.max(0.05, spinFrac));
          discMesh.material.color.setHex(COL_DISC);
          discMesh.material.opacity = 0.6;
          break;
        }

        case STATES.FLIGHT:
          canisterMesh.visible = false;
          discMesh.visible = true;
          tetherLine.visible = true;
          discMesh.scale.setScalar(1);
          discMesh.rotation.z += net.spinRate * Math.PI * 2 * dt;
          discMesh.material.color.setHex(COL_DISC);
          discMesh.material.opacity = 0.6;
          break;

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
          // Pulse opacity
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

        case STATES.PARKED:
        case STATES.BERTHED:
        case STATES.TRANSFERRING:
          // Mother berth/park (§8 A2 + cargo-continuity S3): cinched bag
          // persists at the launcher with a short taut tether stub. The bag
          // follows net.position — the bag's APEX anchor, which the berth hold
          // keeps at the standoff while the pinned catch rides _catchSeatM
          // metres inside (CaptureNet.js co-location fix). PARKED renders
          // identically — the bag is the container and is never faded.
          // S7: TRANSFERRING renders the same bag, still carrying the catch, but
          // with NO tether — the hand-off leaves the launcher's line and the bag
          // is the container in transit. net.position rides the Bézier, so the
          // bag flies with the catch for free.
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

      // ── Tether update: launcher anchor (strut tip / pod muzzle) → net ──
      if (tetherLine.visible && this._player) {
        // Daughter arms use strutTipNodes; mother pods anchor at the pod
        // muzzle via getNetPodPositionInto (allocation-free). The old
        // `player.group` fallback was dead — PlayerSatellite extends
        // THREE.Group so `player.group` is undefined and the tether fell
        // through to getPosition(), cloning a Vector3 every frame (§2 C2).
        if (vis.armIndex >= 0 && this._player.strutTipNodes && this._player.strutTipNodes[vis.armIndex]) {
          this._player.strutTipNodes[vis.armIndex].getWorldPosition(_v3a);
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
  }

  /**
   * Phase D.4 (mother-net-reel plan §11.4) — sample the tether as a quadratic
   * slack curve into the Line2 strand. Sag is quadratic in the slack ratio
   * (pay-out vs straight-line distance): a paying-out tether bows, a taut one
   * snaps straight. At the slack→taut transition (CAPTURED) a 0.2 s decaying
   * lateral twang fires and the strand pulses briefly emissive above the 2.5
   * bloom threshold. Anchor-relative vertices (the LassoSystem DEFECT-1 fix):
   * the line object is parked at the launcher anchor and every vertex is
   * stored relative to it, so the ~64-unit orbital magnitude never snaps the
   * strand onto the float32 grid.
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
    // Park the strand at the anchor; vertices are anchor-relative.
    tetherLine.position.copy(anchor);

    const dx = netPos.x - anchor.x;
    const dy = netPos.y - anchor.y;
    const dz = netPos.z - anchor.z;
    const straight = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // Slack ratio: how much paid-out tether exceeds the straight distance.
    // tetherPaidOut is metres; straight is scene units → convert.
    const paidScene = (net.tetherPaidOut ?? straight / M) * M;
    const slack = Math.max(0, paidScene - straight);
    const slackRatio = straight > 1e-12 ? slack / straight : 0;
    const taut = slackRatio < TETHER_TAUT_SLACK;

    // Taut-snap edge: twang + emissive pulse (line goes straight under load).
    // Phase D.8 (§11.8): both are garnish — dropped at LOW tier.
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
        // Damped sine: a few visible cycles decaying to zero over the window.
        twangAmp = TETHER_TWANG_AMP_M * M * Math.sin(t * Math.PI * 4) * (1 - t) * (1 - t);
      }
    }

    // Emissive pulse: brief HDR flash above the bloom threshold at line-taut.
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
    // P1: write the pairs-format interleaved buffer in place (segment j = point
    // j → point j+1), mirroring LineGeometry.setPositions' polyline→pairs
    // conversion, then flag it dirty. No per-frame allocation, no bounds
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

  // ── Ceremony state handler (flag-ON only) ──────────────────────────────

  /**
   * Update ceremony-path visual for one net.
   * @param {string} key — visual map key
   * @param {object} vis — entry from _activeVisuals
   * @param {object} net — NetProjectile
   * @param {number} dt  — seconds
   * @returns {boolean} true if visual was removed (caller should `continue`)
   * @private
   */
  _updateCeremonyState(key, vis, net, dt) {
    const { coneMesh, rimWeights, drawstringLine,
            apexHub, mouthRadius, coneHeight, closedRadius,
            weightCount, rimWeightMats, canisterMesh } = vis;
    const state = net.state;

    // ── Phase D.5 drape driver (mother-net-reel plan §11.5) ──
    // Map the net FSM onto the kit's per-frame drape state. The web drapes
    // onto the catch through ENVELOP, settle-jiggles at ~2.5 Hz with a decaying
    // envelope, then shrink-wraps through CINCH_CLOSING to the bunched point
    // that persists through REELING, BERTHED and PARKED. FLIGHT keeps a slight cone
    // bow (drape 0). Driven every frame so the jiggle phase advances and the
    // envelope decays; allocation-free (the kit reuses its webPositions buffer).
    if (vis.kitHandle) {
      // Phase D.8 (§11.8): the settle-jiggle is garnish — dropped at LOW tier
      // (the drape/cinch deformation itself is structure and stays).
      const garnish = this._garnishOn();
      let drape = 0, cinchFrac = 0, jiggleAmp = 0;
      if (vis.failure) {
        // ── S5 failure staging (owner item 7) ──
        // The beat owns drape/cinch until it completes — in MISSED, and in
        // the miss REELING when ceremony time-dilation lets the logic's
        // reel-back begin first (the two clocks differ under the ceremony
        // scale; keying on the beat, not the state, means no mid-beat cut).
        // Both beats end at drape 0 / cinch 0 = the flight cone the state map
        // drives afterwards, so the hand-off to the fade is shape-continuous.
        const beat = vis.failure;
        const f = Math.min(1, beat.t / beat.dur);
        if (beat.kind === 'bounce') {
          // Broadside bounce: the bag holds the wrap attempt against the face
          // (or slaps up to it when the catch found the cone open), then
          // SPRINGS off — the release is deliberately fast (down²) next to
          // the slip's slow let-go. The cinch never re-closes.
          const up = Math.min(1, f / 0.3);
          const down = f < 0.3 ? 0 : (f - 0.3) / 0.7;
          drape = Math.max(beat.drape0, up) * (1 - down * down);
          cinchFrac = beat.cinch0 * (1 - down * down);
        } else {
          // Strain slip: the welded wrap lets go — cinch and drape release
          // linearly toward the open cone while the catch slides out of the
          // mouth (it was never pinned on this path; its orbit owns it).
          drape = beat.drape0 * (1 - f);
          cinchFrac = beat.cinch0 * (1 - f);
        }
        beat.cinch = cinchFrac;
        beat.t += dt;
        if (f >= 1) this._endFailureBeat(key, vis);
      } else if (state === STATES.ENVELOP) {
        drape = Math.min(1, Math.max(0, net.stateTimer / CN.ENVELOP_TIME));
        // Settle-jiggle: strongest mid-drape, decaying as the bag seats.
        if (garnish) jiggleAmp = mouthRadius * _NT.DRAPE_JIGGLE_ENVELOP_FRAC * Math.sin(Math.PI * drape);
      } else if (state === STATES.CINCH_CLOSING) {
        drape = 1;
        cinchFrac = Math.min(1, Math.max(0, net.stateTimer / CN.CINCH_CLOSE_TIME));
        if (garnish) jiggleAmp = mouthRadius * _NT.DRAPE_JIGGLE_CINCH_FRAC * (1 - cinchFrac);
      } else if (state === STATES.CAPTURED || state === STATES.REELING
                 || state === STATES.BERTHED || state === STATES.PARKED
                 || state === STATES.TRANSFERRING
                 || state === STATES.SECURE_CHECK) {
        drape = 1; cinchFrac = 1;   // welded shrink-wrap, no jiggle
      }
      if (drape > 0 || cinchFrac > 0 || vis.kitHandle._drape > 0 || vis.kitHandle._cinchFrac > 0) {
        vis.kitHandle._jigglePhase = (vis.kitHandle._jigglePhase || 0) + dt * Math.PI * 2 * _NT.DRAPE_JIGGLE_HZ;
        // Whale-in-cone phase 3 (D2): tell the kit what is INSIDE the bag so
        // the drape/cinch floors on a spherical envelope around the catch
        // instead of closing to 0.27 m regardless. Scene units throughout.
        // The miss / no-target case stays 0 — an empty net SHOULD bunch to a
        // point; that contrast is what sells a real catch. effectiveRenderScale
        // is the clamp-aware SSOT (W5), so the envelope tracks the size the
        // renderer actually draws, including the CAPTURED readability floor.
        // Balloon→fabric (F1): also pass the catch's oriented-BOX spec — the
        // film then wraps the real extents (kill the balloon), keyed to the
        // tumble orientation, which is FROZEN while pinned (B3) so the wrap
        // cannot spin or drift.
        let contentsRadius = 0, contentsZ = 0, contentsBox = null;
        const d = net.targetDebris;
        if (d && d._scenePosition && (drape > 0 || cinchFrac > 0)) {
          DebrisWireframe.getGeometry(d.type, d.id);           // br cache (uncached ⇒ 1)
          const br = DebrisWireframe.getBoundingRadius(d.type, d.id) || 1;
          const renderScale = DebrisField.effectiveRenderScale(d);
          contentsRadius = renderScale * br;
          vis.kitHandle.group.updateMatrixWorld(true);          // same guard the probe uses
          const lp = vis.kitHandle.group.worldToLocal(_v3c.copy(d._scenePosition));
          contentsZ = lp.z;
          const bb = DebrisWireframe.getBoundingBoxExtents(d.type, d.id);
          if (bb) {
            // Catch orientation in kit space: qB2K = qKit⁻¹ ⊗ tumble. The
            // tumble is the whole instance rotation (DebrisField:1985) and is
            // frozen while _armPinned (B3).
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
            contentsBox = _contentsBoxScratch;
          }
        }
        NetMeshKit.updateWebDrape(vis.kitHandle, {
          drape,
          cinchFrac,
          jigglePhase: vis.kitHandle._jigglePhase,
          jiggleAmp,
          contentsRadius,
          contentsZ,
          contentsBox,
          // V4: camera in the kit's LOCAL frame for per-thread depth shading
          // (the kit stays pure-local-space; worldToLocal writes in place).
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

        const spinFrac = net.netClass.SPIN_HZ > 0
          ? Math.min(1, net.spinRate / net.netClass.SPIN_HZ)
          : 1;

        // Scale cone with spin fraction
        coneMesh.scale.setScalar(Math.max(0.05, spinFrac));
        coneMesh.material.color.setHex(COL_DISC);
        coneMesh.material.opacity = 0.55;

        // Place weights at expanding radius
        vis.spinAngle += net.spinRate * Math.PI * 2 * dt;
        const curR = mouthRadius * spinFrac;
        const curZ = -coneHeight * spinFrac;
        for (let i = 0; i < weightCount; i++) {
          const w = rimWeights[i];
          w.visible = true;
          const angle = (2 * Math.PI * i / weightCount) + vis.spinAngle;
          w.position.set(curR * Math.cos(angle), curR * Math.sin(angle), curZ);
        }

        this._updateDrawstring(vis);
        break;
      }

      case STATES.FLIGHT:
        canisterMesh.visible = false;
        coneMesh.visible = true;
        vis.tetherLine.visible = true;
        apexHub.visible = true;
        drawstringLine.visible = true;

        coneMesh.scale.setScalar(1);
        vis.spinAngle += net.spinRate * Math.PI * 2 * dt;
        coneMesh.material.color.setHex(COL_DISC);
        coneMesh.material.opacity = 0.55;

        // Place weights at full mouth radius
        for (let i = 0; i < weightCount; i++) {
          const angle = (2 * Math.PI * i / weightCount) + vis.spinAngle;
          rimWeights[i].position.set(
            mouthRadius * Math.cos(angle),
            mouthRadius * Math.sin(angle),
            -coneHeight,
          );
          rimWeights[i].visible = true;
        }

        this._updateDrawstring(vis);
        break;

      case STATES.CONTACT:
      case STATES.BRAKE:
        canisterMesh.visible = false;
        coneMesh.visible = true;
        vis.tetherLine.visible = true;
        apexHub.visible = true;
        drawstringLine.visible = true;

        // Fabric stays ivory through CONTACT + BRAKE — the phase is read on the
        // HUD, not the mesh. The BRAKE-fired event still drives the rim-weight
        // emissive glint below (a physical tungsten-node cue, not a recolour).
        coneMesh.material.color.setHex(COL_DISC);
        coneMesh.material.opacity = 0.55;

        // Maintain weight positions at mouth radius
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

        // On BRAKE: set weight emissive to brake colour (immediate set — animated flash deferred to Stage 3/5)
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
        // Cone scale UNCHANGED — no shrink (replaces old discMesh.scale.setScalar)

        // 2026-05-26 GEOMETRY FIX (Option A — "cinch over debris"):
        // Previously envZ went -coneHeight → 0 (mouth plane → apex plane),
        // i.e. weights RETRACTED toward the daughter, away from the target.
        // The target world-position at contact ≈ net.position + launchDir
        // × (DIAMETER/2) (= -mouthR = -0.5 × D in local z, sitting ~0.4 m
        // SHORT of the mouth plane at -coneH = -0.55 × D). For the bag to
        // physically engulf the target, weights must OVERSHOOT the mouth —
        // Newton's first law during deceleration. New envZ ranges
        // -coneHeight → -2 × coneHeight, sweeping the weights forward past
        // the target and wrapping it inside the closing bag. Drawstring
        // strands (apex → weight) automatically lengthen, reading as
        // bag-cone fabric draping around the target.
        const envProgress = Math.min(1, Math.max(0, net.stateTimer / CN.ENVELOP_TIME));
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

        // Keep weight emissive from brake
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

        // 2026-05-25 CRITICAL FIX: was `net.tangleQuality` (=0 throughout this
        // state — see ENVELOP comment). Result: drawstring radius stayed at
        // mouthRadius the entire 2 g of CINCH_CLOSE_TIME, then snapped to the
        // closed radius in a SINGLE FRAME at the CAPTURED transition (when
        // tangleQuality finally got set). That snap is the "cinch happens
        // suddenly" symptom the user reported. Now driven by stateTimer /
        // CINCH_CLOSE_TIME so the ring contracts smoothly from mouthRadius
        // to closedRadius across the camera's CINCH beat.
        // 2026-05-26 GEOMETRY FIX (Option A — "cinch over debris"):
        // Cinch ring center was at z=0 (apex plane), but the target sits at
        // z ≈ -mouthRadius (= -0.5 × D). The drawstring was therefore
        // closing ~coneHeight (4.4 m for LARGE D=8) BEHIND the target, on
        // the daughter side — the "between daughter and debris" symptom
        // the user reported. Cinch ring now contracts at z=-coneHeight
        // (mouth plane), which sits 0.4 m past the target along the launch
        // direction. The closing ring is centered on the debris within the
        // half-thickness of the cone mouth. Drawstring strands from apex
        // (z=0) to the ring at z=-coneHeight render as the long bag-cone
        // strands cinching closed at the debris.
        const cinchProgress = Math.min(1, Math.max(0, net.stateTimer / CN.CINCH_CLOSE_TIME));
        // Item 10: the sweep closes ONTO the catch and stops — floored at the
        // mouth-plane contents floor (the kit's mouthFloorRadius), matching
        // the film's rim ring, instead of sweeping through a catch that
        // reaches the mouth plane. The floor is 0 whenever the contents stop
        // short of the mouth (the mother scenario included), so the gated
        // draw is bit-identical; at cinchProgress 1 this equals
        // _setCinchedRim's radius exactly.
        const curR = Math.max(
          mouthRadius + (closedRadius - mouthRadius) * cinchProgress,
          NetMeshKit.mouthFloorRadius(vis.kitHandle),
        );
        vis.spinAngle += net.spinRate * Math.PI * 2 * dt;
        for (let i = 0; i < weightCount; i++) {
          const angle = (2 * Math.PI * i / weightCount) + vis.spinAngle;
          rimWeights[i].position.set(
            curR * Math.cos(angle),
            curR * Math.sin(angle),
            -coneHeight, // at mouth plane (target sits at z ≈ -mouthRadius, ~0.4 m short of here)
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
        // Fabric stays ivory; the "checking grip" beat is read on the HUD. The
        // opacity pulse below remains as a subtle physical shimmer.
        coneMesh.material.color.setHex(COL_DISC);
        coneMesh.material.opacity = 0.35 + 0.25 * Math.sin(Date.now() * 0.01);
        break;

      case STATES.CAPTURED:
        canisterMesh.visible = false;
        coneMesh.visible = true;
        vis.tetherLine.visible = true;
        coneMesh.material.color.setHex(COL_DISC);
        coneMesh.material.opacity = 0.55;   // steady — no pulse once captured (#3)
        // UX-11 #3: static cinched bag — rim ring frozen at the closed radius
        // on the mouth plane, spinAngle NOT advanced. The captured bag must
        // read as a welded, settled catch, not a live animation.
        this._setCinchedRim(vis);
        break;

      case STATES.MISSED:
        canisterMesh.visible = false;
        coneMesh.visible = true;
        vis.tetherLine.visible = true;
        coneMesh.material.color.setHex(COL_DISC);
        if (vis.failure) {
          // S5 failure staging: the beat owns the furniture — the cinch ring
          // follows the beat's cinchFrac (opening on a slip, springing off on
          // a bounce) and the strands stay on for the release read.
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
        // S5: a failure beat (or its fade tail) keeps the cone drawn through
        // the miss reel-back — hiding it the frame REELING starts would cut
        // the staged bounce/slip (or pop the fading bag).
        coneMesh.visible = net.catchResult === 'success' || !!vis.failure || !!vis.fadingOut;
        vis.tetherLine.visible = true;
        if (net.catchResult === 'success') {
          coneMesh.material.color.setHex(COL_DISC);
          // UX-11 #3: the haul/park can last many seconds (REELING is held
          // through HOLDING_CATCH for daughter catches) — render a steady,
          // fully-cinched bag: fixed opacity, frozen spin, rim ring pinned
          // at the closed radius. No expand/contract pulse.
          coneMesh.material.opacity = 0.55;
          this._setCinchedRim(vis);
        } else if (vis.failure) {
          this._stageFailureFurniture(vis);
        } else {
          for (const w of rimWeights) w.visible = false;
          drawstringLine.visible = false;
          apexHub.visible = false;
        }
        break;

      case STATES.PARKED:
      case STATES.BERTHED:
      case STATES.TRANSFERRING:
        // Mother berth/park (mother-net-reel plan §8 A2 + cargo-continuity S3):
        // the cinched bag PERSISTS at the launcher with a short taut tether
        // stub — identical rendering to the successful REELING case above, and
        // identical across BERTHED→PARKED (the net IS the container; the bag is
        // never faded). Explicit case so persistence is by design, not by the
        // default: break accident (the plain-switch case below is dead code
        // under NET_CEREMONY).
        // S7: TRANSFERRING is the same welded bag in flight to a daughter's rack,
        // minus the tether — it has left the launcher's line.
        canisterMesh.visible = false;
        coneMesh.visible = true;
        vis.tetherLine.visible = (net.state !== STATES.TRANSFERRING);
        coneMesh.material.color.setHex(COL_DISC);
        coneMesh.material.opacity = 0.55;
        this._setCinchedRim(vis);
        break;

      case STATES.STOWED:
      case STATES.RELEASED:
        this._removeNetVisual(key);
        return true; // signal caller to continue (skip tether update)

      default:
        break;
    }

    // Orient group so local -Z points along the launch direction (i.e. the
    // mouth/forward end of the cone is at local z = -coneH, the apex is at
    // local z = 0, and rim weights placed at z = -coneH render past the target
    // along launchDir).
    // CRITICAL: THREE.js [`Object3D.lookAt`](https://github.com/mrdoob/three.js/blob/master/src/core/Object3D.js)
    // uses the OPPOSITE convention from [`Camera.lookAt`](https://github.com/mrdoob/three.js/blob/master/src/cameras/Camera.js):
    //   - For Camera / Light:  internal _m1.lookAt(position, target, up)   → local -Z points TOWARD target.
    //   - For Object3D:        internal _m1.lookAt(target, position, up)   → local +Z points TOWARD target.
    // (See three.js Object3D.js, isCamera/isLight branch.)
    //
    // Net group is a plain Group (not Camera). To make local -Z point along
    // launchDir (so existing z = -coneH placements render on the target-far
    // side, as the cone-build comments at line 295 assume), we must pass a
    // lookAt point on the OPPOSITE side of the group — group.position - launchDir × ε.
    // Object3D.lookAt then sets local +Z = -launchDir, hence local -Z = +launchDir,
    // which matches the camera-style convention all the cone/rim/drawstring
    // geometry was written to assume.
    //
    // The historical bug: previous code did `.add(_v3a)` (camera convention),
    // which made local +Z = launchDir and rendered the rim weights, mouth, and
    // cinch ring on the DAUGHTER side of the net center — exactly the
    // "cinch happens between daughter and debris" symptom diagnosed via
    // NET_CINEMATIC_DEBUG instrumentation (see HANDOFF / CAPTURE_NET_QA).
    if (net.launchDirection) {
      _v3a.set(
        net.launchDirection.x * 0.001,
        net.launchDirection.y * 0.001,
        net.launchDirection.z * 0.001,
      );
      _v3b.copy(vis.group.position).sub(_v3a);
      vis.group.lookAt(_v3b);
    }

    // net-fabric-look Task 3: the V2 membrane film was built by NetMeshKit but
    // NO ceremony state ever set its .visible, so the kit's build default
    // (childrenVisible=false) left it permanently hidden — measured filmShare 0
    // (the film never contributed a pixel) while the threads read as cool line
    // art. Mirror the cone's visibility so the lit film renders under the
    // threads whenever the bag does. The film's material/deformation are driven
    // separately (Kit.updateWebDrape writes membranePositions + normals), so
    // this one line is the entire wiring fix.
    if (vis.kitHandle && vis.kitHandle.membraneMesh) {
      vis.kitHandle.membraneMesh.visible = coneMesh.visible;
    }

    return false;
  }

  /**
   * UX-11 #3: render the rim weights + drawstring as a STATIC fully-cinched
   * ring at the closed radius on the mouth plane. Uses the frozen spinAngle
   * (not advanced) so consecutive frames are identical — no pulse, no spin.
   * @param {object} vis — entry from _activeVisuals
   * @private
   */
  _setCinchedRim(vis) {
    const { rimWeights, drawstringLine, apexHub, closedRadius, coneHeight, weightCount } = vis;
    apexHub.visible = true;
    drawstringLine.visible = true;
    // Item 10: the rim furniture honours the same mouth-plane contents floor
    // the film already draws (the kit's mouthFloorRadius — ONE home, clamped
    // to mouthRadius). A catch whose silhouette reaches the mouth plane holds
    // the film's rim ring open; the weights/drawstring now ride that radius
    // instead of closing to closedRadius THROUGH the catch (measured: every
    // SMALL-net held catch, 0.75 m film rim vs 0.11 m weights). 0 whenever
    // the contents stop short of the mouth — the mother scenario included —
    // so the gated draw is bit-identical. Angles keep the visual's frozen
    // vis.spinAngle basis (never the kit's _rimAngles/_spinAngle — that swap
    // would rotate the mother drawstring and move the fabric baseline).
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
   * Update drawstring line vertex positions from current rim weight positions.
   * Spoke pattern: apex→w0→apex→w1→…→apex→wN-1→apex→w0.
   * Delegates to the shared NetMeshKit so the Mother + Daughter render the same
   * web topology (single source of truth — no drift). The kit handle's
   * rimWeights / drawstringPositions / drawstringLine are reference-identical to
   * the vis entry's, so output is unchanged. No allocations.
   * @param {object} vis — entry from _activeVisuals
   * @private
   */
  _updateDrawstring(vis) {
    NetMeshKit.updateDrawstring(vis.kitHandle);
  }

  /**
   * S5 failure staging: drive the cinch furniture from the beat's cinchFrac
   * (vis.failure.cinch, freshly written by the drape driver this frame) —
   * the ring opens toward the mouth on a slip and springs off on a bounce,
   * floored at the same mouth-plane contents floor CINCH_CLOSING honours so
   * the ring never sweeps through the catch it is releasing. Weights ride the
   * frozen spinAngle basis (same as _setCinchedRim — never the kit's).
   * @param {object} vis — entry from _activeVisuals
   * @private
   */
  _stageFailureFurniture(vis) {
    const { rimWeights, drawstringLine, apexHub, mouthRadius, closedRadius,
            coneHeight, weightCount } = vis;
    apexHub.visible = true;
    drawstringLine.visible = true;
    const cinch = vis.failure ? vis.failure.cinch : 0;
    const r = Math.max(
      mouthRadius + (closedRadius - mouthRadius) * cinch,
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
   * S5 failure staging: end a beat — hand the bag to the ordinary fade timer
   * (which then owns opacity + removal). Idempotent; safe to call from either
   * clock (the state-machine beat branch or the detached-bag branch).
   * @param {string} key — visual map key
   * @param {object} vis — entry from _activeVisuals
   * @private
   */
  _endFailureBeat(key, vis) {
    if (!vis.failure) return;
    vis.failure = null;
    vis.fadingOut = true;
    this._fadeTimers.push({ key, timer: 1.0, duration: 1.0 });
  }

  // ── Public getters ─────────────────────────────────────────────────────

  /**
   * Get the apex hub world position for a given net visual key.
   * Returns the group position as fallback when flag is OFF or key not found.
   * Stage 3 camera can use this for tether-attach-point framing.
   * @param {string} key — visual key ('arm_0', 'pod_1', etc.)
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

  // ── Disposal ───────────────────────────────────────────────────────────

  /** Clean up all visuals and unsubscribe from events. */
  dispose() {
    // Remove all visuals
    for (const key of [...this._activeVisuals.keys()]) {
      this._removeNetVisual(key);
    }

    // Unsubscribe events
    if (this._boundNetFired)      eventBus.off(Events.NET_FIRED,          this._boundNetFired);
    if (this._boundNetCaught)     eventBus.off(Events.NET_CATCH_SUCCESS,  this._boundNetCaught);
    if (this._boundNetMiss)       eventBus.off(Events.NET_CATCH_MISS,     this._boundNetMiss);
    if (this._boundReelCompleted) eventBus.off(Events.NET_REEL_COMPLETED, this._boundReelCompleted);
    if (this._boundNetReleased)   eventBus.off(Events.NET_RELEASED,       this._boundNetReleased);
    if (this._boundNetTorn)       eventBus.off(Events.NET_TORN,           this._boundNetTorn);
    if (this._boundNetFailed)     eventBus.off(Events.NET_FAILED,         this._boundNetFailed);
    if (this._boundCargoDone)     eventBus.off(Events.CARGO_TRANSFER_COMPLETE, this._boundCargoDone);
    if (this._boundTierChanged)   eventBus.off(Events.PERF_TIER_CHANGED,  this._boundTierChanged);

    this._boundNetFired = null;
    this._boundNetCaught = null;
    this._boundNetMiss = null;
    this._boundReelCompleted = null;
    this._boundNetReleased = null;
    this._boundNetTorn = null;
    this._boundNetFailed = null;
    this._boundTierChanged = null;

    this._fadeTimers = [];
    this._enabled = false;
    this._disposed = true;
  }
}

/** Singleton CaptureNetVisual instance. */
export const captureNetVisual = new CaptureNetVisual();
export default captureNetVisual;
