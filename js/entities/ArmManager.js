/**
 * ArmManager.js — Manages the V5 Crossbow arm fleet
 * Config G top-collar 3-plane layout (ST-9.2).
 * Tier-aware: Y0 Quad (4), Y1 Hex (6), Y3 Octo (6 ring + 2 end-face).
 * Arms hinge at top collar (Y = +1.00 m), sweep 0–180° in meridian planes.
 * Coordinates deployments, recalls, dual-fire, pulse scan, and provides status for HUD.
 * @module entities/ArmManager
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { powerDistribution } from '../systems/PowerDistribution.js';
import { checkActiveSatArming } from '../systems/ActiveSatGuard.js';
import { persistenceManager } from '../systems/PersistenceManager.js';
import { strutTipMeters, heldCargoPlumeConflictAt } from '../systems/CoMCalculator.js';
import { strutTipFoulsCorridor, strutLocalDirection, bestStrutAlpha } from './ArmDockBasis.js';
import { createShipKeepOut } from '../systems/ShipKeepOut.js';
import { StrutAutoController } from '../systems/StrutAuto.js';
import { reseatOrbitFromScene } from './OrbitalMechanics.js';
import { ArmUnit, planeTurnLeftRad } from './ArmUnit.js';
import { DebrisField } from './DebrisField.js';
import { clearRackCell } from './CaptureNet.js';
import { tripRefuses } from '../systems/TransferTrip.js';
import { engineGasKg, engineDeltaV, engineTankDryKg, engineGasLowFrac } from '../systems/ResourceSystem.js';

/** 1 meter in scene units */
const M = 0.00001;

// reel-home scratch
const _rhInvQ = new THREE.Quaternion();
const _rhGapA = new THREE.Vector3();
const _rhGapB = new THREE.Vector3();
const _rhAxisR = new THREE.Vector3();
const _rhTurnP = new THREE.Vector3();      // reel-turn: her place in the ship's frame, from the ship's centre
const _rhTurnQ = new THREE.Quaternion();

// Task 7 (opening-dance plan) — bounded safety-net release. LASSO_CAPTURED's
// own downstream adoption (CaptureNetSystem.adoptLassoCatch) deliberately
// does not emit NET_BERTHED (its doc comment: "none of the spectacle"), so a
// ducked arm on that path never sees the plan's own release event. This
// timeout (comfortably longer than the duck sweep AND the lasso's own
// ~3 s reel-in) guarantees a duck can never strand a strut ducked forever,
// regardless of which capture path resolved it. Not a plan requirement —
// see the lane's final report.
const LEAN_ASIDE_TIMEOUT_S = 8;

const _aimTmpWanted = new THREE.Vector3();
const _aimTmpAxis = new THREE.Vector3();
/** launch-aim: the aim stage counts a strut as "in place" within 1° of the best angle. */
const AIM_TOL_RAD = Math.PI / 180;
/** launch-aim: a new best angle replaces the one she is swinging to only if it points the strut this much closer (rad, 0.5°). */
const AIM_GAIN_RAD = 0.5 * Math.PI / 180;
/** launch-aim: how many times the aim stage may REVERSE its aim (follow a best angle that flipped back) before it commits. */
const AIM_MAX_REAIMS = 4;
/** launch-aim: catch states in which the mother holds (or is taking in) a catch whose berth corridor a strut must not enter. */
const AIM_CATCH_HELD_STATES = ['CINCH_CLOSING', 'SECURE_CHECK', 'CAPTURED', 'REELING', 'BERTHED', 'COLLARED', 'TRANSFERRING'];

/** The "." toggle's live sweep read (InputManager.js Period case, mirrored
 *  for toggleStruts / strutsDeployed): a pending `_strutTargetAlpha` latch
 *  wins, else the ACTUAL angle — never the latch alone, which clears to
 *  undefined once the slew finishes. @private */
const _strutLiveAlpha = (a) =>
  a._strutTargetAlpha ?? (a.getAimAlpha ? a.getAimAlpha() : 0);

/**
 * hold-catch (owner 2026-10-22): the strut angle a daughter holding a catch rests at. The lowest of 34° (STRUT_REST_ALPHA),
 * 39°, 44° ... 99°, then 100° (HOLD_POSE_MAX_DEG), at which her catch is clear of every thruster plume — the exact box check
 * (`heldCargoPlumeConflictAt`) at THAT angle, not the size-ladder floor (`PLUME_CARGO_ALPHA_LADDER` is the worst case over
 * every rack attitude plus 10°, sized for a re-pose from anywhere; a held catch's attitude in her frame is frozen at the stow,
 * so the exact read is the real answer, and it keeps a 1 m catch at 34° where the ladder said 41°). Never above 100°: the
 * mother net's berth corridor is clear of a strut tip for every inbound size up to there. If nothing clears (not seen for
 * catches up to 5 m), 100° with `tooBig`. Pure read; null when she holds nothing. A module function (not a method) so
 * `ArmManager.toggleStruts`, which runs on bare stub objects in tests, can call it without `this.method()`.
 * @param {object} mgr an ArmManager (arms[], _dockPositions[], playerSatellite)
 * @param {number} armIndex
 * @returns {{rad:number, tooBig:boolean}|null}
 */
function _holdPoseOf(mgr, armIndex) {
  const arm = mgr.arms[armIndex];
  if (!arm || arm.isDetached) return null;
  const holds = (arm.capturedDebris && arm.capturedDebris.mass)
    || (Array.isArray(arm.heldCatches) && arm.heldCatches.some((h) => h && h.mass));
  if (!holds) return null;
  const V5 = Constants.OCTOPUS_V5;
  const D2R = Math.PI / 180;
  const lo = Math.round(V5.STRUT_REST_ALPHA / D2R);
  const hi = V5.HOLD_POSE_MAX_DEG;
  for (let deg = lo; deg < hi; deg += V5.HOLD_POSE_STEP_DEG) {
    if (!heldCargoPlumeConflictAt(mgr, armIndex, deg * D2R)) return { rad: deg * D2R, tooBig: false };
  }
  if (!heldCargoPlumeConflictAt(mgr, armIndex, hi * D2R)) return { rad: hi * D2R, tooBig: false };
  return { rad: hi * D2R, tooBig: true };
}

/**
 * hold-catch: a "." press on daughters holding catches (called by ArmManager.toggleStruts). The wanted angle is clamped to the
 * hold pose from below (a press that would close her sends her to it) and to HOLD_POSE_MAX_DEG from above; an angle above the
 * pose is taken only when her catch is plume-clear there. Each gets the manual marker, as a docked strut does (StrutAuto keeps
 * it for them and ages it) - only when the press moves her: a press that moves nothing is no override. When it moves nothing and no
 * docked strut was commanded either, `mgr.lastStrutPressNote` says why, in one plain line (`toggleStruts` holds a single tap's line
 * back for the double-press window, see `_pendingStrutNote`).
 * @param {object} mgr
 * @param {object[]} holders
 * @param {number} wantRad
 * @param {boolean} autoOn the STRUT_AUTO flag: the manual marker is only written (and aged) when it is on
 * @param {boolean} onlyThese true: nothing else was commanded, so a press that moves nothing gets its line
 */
function _pressHolders(mgr, holders, wantRad, autoOn, onlyThese) {
  if (!holders.length) return;
  const V5 = Constants.OCTOPUS_V5;
  const dead = V5.HOLD_POSE_DEADBAND_DEG * Math.PI / 180;
  const cap = V5.HOLD_POSE_MAX_DEG * Math.PI / 180;
  let anyMoved = false;
  let stayed = null;
  for (const a of holders) {
    const i = mgr.arms.indexOf(a);
    const hp = _holdPoseOf(mgr, i);
    if (!hp) continue;
    let t = hp.rad;
    if (wantRad > hp.rad + 1e-6 && wantRad <= cap + 1e-6 && !heldCargoPlumeConflictAt(mgr, i, wantRad)) t = wantRad;
    // where she is heading (a pending latch wins, as for a docked strut): a press that asks for that again moves nothing, and a
    // press that moves nothing is not a manual override (FA4: it left `_strutManual` behind, which later said "back to automatic")
    if (Math.abs(t - _strutLiveAlpha(a)) > dead) {
      a._strutTargetAlpha = t;
      if (autoOn) a._strutManual = { quietS: 0 };
      anyMoved = true;
    } else if (!stayed && Math.abs(t - (a.getAimAlpha ? a.getAimAlpha() : t)) <= dead) {
      stayed = { a, hp };
    }
  }
  if (onlyThese && stayed && !anyMoved) {
    const n = stayed.a.index + 1;
    const deg = Math.round(stayed.hp.rad * 180 / Math.PI);
    mgr.lastStrutPressNote = deg <= Math.round(V5.STRUT_REST_ALPHA * 180 / Math.PI)
      ? `Daughter ${n} is holding a catch; her strut stays at ${deg}° to keep it clear of the hull.`
      : `Daughter ${n} is holding a big catch; her strut stays at ${deg}° to keep it clear of the thrusters.`;
  }
}

// V5 Constants (destructured for readability)
const {
  V5_ARM_COUNT, V5_FRONT_ARM_TYPE, V5_BACK_ARM_TYPE,
  V5_WEAVER_MASS, V5_SPINNER_MASS,
  DUALFIRE_SYNC_WINDOW, DUALFIRE_RECOIL_WEAVER, DUALFIRE_RECOIL_SPINNER, DUALFIRE_RCS_COMPENSATION_N2,
  PULSE_SCAN_DURATION, PULSE_SCAN_COOLDOWN, PULSE_SCAN_POWER, PULSE_SCAN_RANGE_MULT,
  CROSSBOW_LAUNCH_SPEED_MIN, CROSSBOW_LAUNCH_SPEED_DEFAULT,
  SPRING_TIERS, TETHER_TIERS,
  ARM_STATES,
} = Constants;

// FIX_PLAN §3: Module-local sets built once — avoids re-allocation per call to getRotationLockTier().
// Any arm in _HIGH_RISK_ROT_STATES with a live tether → tier 'block' (hard displacement limit).
// Any arm in _SOFT_ROT_STATES with a live tether   → tier 'soft' (generous displacement limit).
// DOCKED / RELOADING / EXPENDED / isDetached arms contribute tier 'none'.
const _HIGH_RISK_ROT_STATES = new Set([
  ARM_STATES.NETTING,
  ARM_STATES.GRAPPLED,
  ARM_STATES.STATION_KEEP,
  ARM_STATES.REELING,
  ARM_STATES.HAULING,
  ARM_STATES.RETURNING,
  ARM_STATES.DOCKING,
  ARM_STATES.DEORBITING,
  // trip-melt-2 (carry): she is out on her strut line, flying in her docked attitude — the mother holds still
  ARM_STATES.CARRY_OUT,
  ARM_STATES.CARRY_HANDOFF,
  ARM_STATES.CARRY_BACK,
]);
// Wave1 reel-drum feedback (2026-08-27): arm states where the daughter parks
// AT her strut tip → drum 'ready'. Mirrors ArmUnit._updateTether's hidden-line
// set (DOCKED/DOCKING/RELOADING/HOLDING_CATCH) minus EXPENDED, whose cartridge
// maps to 'empty'. CARRY_PREP is docked too (her line is wound, the strut and radiators are moving); the three
// states where she is out ('deployed') are not listed.
const _DRUM_HOME_STATES = new Set([
  ARM_STATES.DOCKED,
  ARM_STATES.DOCKING,
  ARM_STATES.RELOADING,
  ARM_STATES.HOLDING_CATCH,
  ARM_STATES.CARRY_PREP,
]);
const _SOFT_ROT_STATES = new Set([
  ARM_STATES.UNDOCKING,
  ARM_STATES.LAUNCHING,
  ARM_STATES.WEB_SHOT,
  ARM_STATES.TRANSIT,
  ARM_STATES.APPROACH,
  ARM_STATES.TRAWLING,
  ARM_STATES.SCANNING,
  ARM_STATES.ABLATING,
  ARM_STATES.CARRY_PREP,           // trip-melt-2: docked, but the strut and radiators are moving
]);
/** trip-melt-2 (carry): the four carry states. A carrying daughter is still part of the ship's books (her mass is aboard,
 *  recall refuses her, her rack catches are pinned to her), but not "home". */
const _CARRY_STATES = new Set([
  ARM_STATES.CARRY_PREP,
  ARM_STATES.CARRY_OUT,
  ARM_STATES.CARRY_HANDOFF,
  ARM_STATES.CARRY_BACK,
]);
/** @param {string} state @returns {boolean} one of CARRY_PREP / OUT / HANDOFF / BACK */
export function isCarryState(state) { return _CARRY_STATES.has(state); }

/**
 * Config G: Generate dock positions for the given arm tier (ST-9.2).
 *
 * Geometry convention (ARM_PIVOT_ANALYSIS.md §10.2 side-view):
 *   α = 0   → STOWED  (strut alongside barrel, daughter near −Y bottom)
 *   α = π/2 → EQUATORIAL (strut points radially outward in XZ plane)
 *   α = π   → ZENITH  (strut points +Y, above Mother)
 *
 * Strut tip formula (universal for ring AND end-face arms):
 *   tip = hinge + STRUT_LENGTH × ( sin(α)·dockOutward − cos(α)·ŷ )
 *
 * Ring arms hinge at the top collar (Y = COLLAR_Y = +1.00 m).
 * End-face arms (Y3 Octo only) hinge at the barrel end caps (±Z faces).
 *
 * This is the STORED convention (CameraSystem's aim bridge reads
 * `arm._dockOutward` in it: the XZ collar convention). The mass model does NOT consume it raw:
 * CoMCalculator converts these fields to the rendered ship frame (barrel = Z,
 * stowed aft at −Z) at its strutTipMeters/strutMidpointMeters boundary — the
 * Y/Z swap of register item 57 (S13(a)). Do not "fix" this convention; the
 * conversion is deliberate and single-sited.
 *
 * @param {string|number} [tierKeyOrCount='Y0_QUAD'] — tier key or arm count (4/6/8)
 * @returns {Array<{type: string, offset: THREE.Vector3, angle: number, azimuthDeg: number,
 *   dockOutward: THREE.Vector3, swingAxis: THREE.Vector3, hingePosition: THREE.Vector3,
 *   isEndFace: boolean}>}
 */
export function generateDockPositions(tierKeyOrCount) {
  // Resolve tier key
  let tierKey;
  if (typeof tierKeyOrCount === 'number') {
    const ladder = Constants.ARM_LADDER;
    tierKey = Object.keys(ladder).find(k => ladder[k].armCount === tierKeyOrCount) || 'Y0_QUAD';
  } else {
    tierKey = tierKeyOrCount || 'Y0_QUAD';
  }

  const tier = Constants.ARM_LADDER[tierKey] || Constants.ARM_LADDER.Y0_QUAD;
  const V5 = Constants.OCTOPUS_V5;
  const COLLAR_Y = V5.COLLAR_Y;           // 1.00 m
  const COLLAR_RADIUS = V5.COLLAR_RADIUS;  // 0.40 m
  const positions = [];

  // ── Ring arms (from tier azimuth table) ──
  const azimuths = tier.azimuths; // degrees

  for (let i = 0; i < azimuths.length; i++) {
    const azDeg = azimuths[i];
    const theta = azDeg * Math.PI / 180;

    // Hinge XZ on collar perimeter (scene units); Y kept at 0 so that
    // _worldDockDirection (which normalizes dockOffset) stays purely radial.
    const hx = COLLAR_RADIUS * Math.cos(theta) * M;
    const hz = COLLAR_RADIUS * Math.sin(theta) * M;

    // dockOutward: radial outward in XZ plane (deploy direction at α = π/2)
    const outward = new THREE.Vector3(Math.cos(theta), 0, Math.sin(theta)).normalize();

    // swingAxis: tangent to collar at this azimuth, perpendicular to radial in XZ
    const swingAxis = new THREE.Vector3(-Math.sin(theta), 0, Math.cos(theta)).normalize();

    // Type alternates weaver/spinner around ring
    const type = i % 2 === 0 ? 'weaver' : 'spinner';

    positions.push({
      type,
      offset: new THREE.Vector3(hx, 0, hz),          // XZ only for backward-compat deploy dir
      angle: theta,
      azimuthDeg: azDeg,
      dockOutward: outward,
      swingAxis,
      hingePosition: new THREE.Vector3(hx, COLLAR_Y * M, hz), // full 3-D hinge
      isEndFace: false,
    });
  }

  // ── End-face arms (Y3 Octo only: +Z and −Z along velocity vector) ──
  // Register item 61 (2026-08-22, owner-ruled "fix the blueprint"): the rows
  // ride the SAME stored convention as the ring — ship Z lives in the stored
  // Y slot (the S13(a) swap) — so hingePosition (0, ±CORE_LENGTH/2, 0)_stored
  // reads (0, 0, ±CORE_LENGTH/2)_ship: ON the barrel axis at the end faces,
  // exactly where the end-face mounts were once drawn (that visual was removed 2026-10-16).
  // dockOutward likewise carries ship-Z in its stored-Y slot, so a face's
  // arm deploys straight off its face at α=π/2. (The pre-fix rows parked
  // hinge AND outward in the stored-Z slots = side stations at
  // (0, ±ACROSS_FLATS/2, 0)_ship that matched nothing renderable.)
  if (tier.endFaceArms) {
    for (const face of tier.endFaceArms) {
      const isForward = (face === '+Z');
      const endOff = (isForward ? 1 : -1) * (V5.CORE_LENGTH / 2);
      const azDeg = isForward ? 0 : 180;
      const theta = azDeg * Math.PI / 180;

      // Stored outward carries ship-Z in its Y slot (deploy off the face).
      const outward = new THREE.Vector3(0, isForward ? 1 : -1, 0);
      // Swing axis for end-face arms: perpendicular to Z, lies in X direction
      const swingAxis = new THREE.Vector3(1, 0, 0);

      const type = isForward
        ? (V5_FRONT_ARM_TYPE || 'weaver')
        : (V5_BACK_ARM_TYPE || 'weaver');

      positions.push({
        type,
        offset: new THREE.Vector3(0, endOff * M, 0),
        angle: theta,
        azimuthDeg: azDeg,
        dockOutward: outward,
        swingAxis,
        hingePosition: new THREE.Vector3(0, endOff * M, 0), // end-cap hinge (not collar)
        isEndFace: true,
      });
    }
  }

  return positions;
}

/**
 * Can this daughter be sent right now? Docked, spring charged, fuel above the 5 dead-end line, not reserved by an
 * aim in progress. The one filter of `_findDockedArm` (minus the type) and `daughterLaunchReadiness`. Module scope, not a
 * method, so `_findDockedArm` still works when borrowed onto another object (main.js's chip helper test does that).
 * @param {object} a an ArmUnit
 * @returns {boolean}
 */
function armCanLaunchNow(a) {
  return !!a && a.state === ARM_STATES.DOCKED && !!a.springCharged && a.fuel > 5 && !a._aimReserved;
}

export class ArmManager {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./PlayerSatellite.js').PlayerSatellite} playerSatellite
   */
  constructor(scene, playerSatellite) {
    this.scene = scene;
    this.playerSatellite = playerSatellite;

    /** @type {import('../systems/AutopilotSystem.js').AutopilotSystem|null}
     *  Injected post-construction for the aim-before-launch daughter ceremony. */
    this._autopilot = null;

    /** @type {ArmUnit[]} */
    this.arms = [];

    // Wave1 reel-drum feedback: last state sent to PlayerSatellite.setTetherState
    // per strut index (edge-triggered — only transitions emit a call).
    this._drumStatesSent = [];

    /**
     * SceneManager ref for DYNAMIC near-field membership (z-layer fix). A
     * daughter's hull is added to the near-field depth pass only while it is
     * docked/close to the mother; set via setSceneManager(). Null in headless /
     * menu-backdrop contexts, where the toggling is a no-op.
     * @type {import('../scene/SceneManager.js').SceneManager|null}
     */
    this._sceneManager = null;

    // ST-9.2: Resolve active tier from persistence (default Y0_QUAD)
    this._activeTierKey = this._resolveActiveTierKey();
    const tierConfig = Constants.ARM_LADDER[this._activeTierKey] || Constants.ARM_LADDER.Y0_QUAD;

    /** Maximum simultaneous deployments (matches active tier arm count) */
    this.maxSimultaneous = tierConfig.armCount;

    /** Weaver/Spinner counts (from active tier) */
    this.weaverCount = tierConfig.weaverCount;
    this.spinnerCount = tierConfig.spinnerCount;

    /**
     * Stored upgrade overrides that survive reset().
     * Maps effect name → value (e.g., 'tetherRange' → 2.0)
     * @type {Object<string, number>}
     */
    this._storedUpgrades = {};

    /**
     * Currently selected arm index (0-7). -1 = no selection (mothership).
     * Set by number keys 1-8 via ARM_SELECT event.
     * @type {number}
     */
    this.selectedArmIndex = -1;

    // V5 Pulse scan state
    this._pulseScanCooldown = 0;
    this._pulseScanTimer = 0;
    this._pulseScanActive = false;

    // Task 7 (opening-dance plan) — arms lean aside for an inbound catch.
    // Arm indices this lane currently holds ducked at the 90° open angle (STRUT_DEPLOY_ALPHA);
    // this manager is the sole writer of _strutTargetAlpha for exactly these
    // arms while the set is non-empty.
    this._leanAsideArmIndices = new Set();
    this._leanAsideActive = false;
    this._leanAsideTimer = 0;

    // reel-home (2026-10-19): the mother turn a daughter on the reels owns (first come), and the transient exception
    // `getRotationLockTier` reads while that turn is being requested.
    this._rhTurn = null;          // { arm, attempt } while a turn for a daughter on the reels is running
    this._rhOwner = null;         // the daughter that owns the mother turn
    this._rhSeq = 0;              // arrival counter ("first come")
    this._lockExceptArm = null;

    // Daughter-arm automation (lane arms-auto): the controller, the once-per-player
    // store (main.js hands it in; no store → the full-range show never runs) and the
    // "." press counter the show uses to notice a player taking over.
    this._strutAuto = new StrutAutoController();
    this._strutAutoStore = null;
    this._strutAutoView = null;
    this._strutPress = 0;

    this._initArms();
    this._setupListeners();
  }

  // ==========================================================================
  // INITIALIZATION
  // ==========================================================================

  /**
   * Resolve the active arm tier key from persisted save data.
   * Falls back to Y0_QUAD on missing/legacy saves.
   * @private
   * @returns {string} One of 'Y0_QUAD', 'Y1_HEX', 'Y3_OCTO'
   */
  _resolveActiveTierKey() {
    try {
      return persistenceManager.getArmTier();
    } catch (_) {
      return 'Y0_QUAD';
    }
  }

  /** @private Create all arm units for the active tier configuration (ST-9.2) */
  _initArms() {
    this._dockPositions = generateDockPositions(this._activeTierKey);
    let wIdx = 1;
    let sIdx = 1;

    for (let i = 0; i < this._dockPositions.length; i++) {
      const dp = this._dockPositions[i];
      const { type, offset } = dp;
      const id = type === 'weaver' ? `weaver-${wIdx++}` : `spinner-${sIdx++}`;
      const arm = new ArmUnit(id, type, offset, this.scene);
      arm.index = i;
      // Register item 67(b): the rack feed-end's direct attitude-inertia
      // invalidation reaches the cache through this handle (same injection
      // idiom as _beaconSpeedScale / _digestSunScale).
      arm._playerSatellite = this.playerSatellite;
      // Config G geometry (ST-9.2): hinge, swing axis, azimuth — used by C-3 strut tip math
      arm._hingePosition = dp.hingePosition.clone();
      arm._dockOutward = dp.dockOutward.clone();
      arm._swingAxis = dp.swingAxis.clone();
      arm._azimuthDeg = dp.azimuthDeg;
      arm._isEndFace = dp.isEndFace;
      arm.initNetInventory(); // ST-9.4 C-6: fill net magazine (CAPTURE_NET flag gated)
      this.arms.push(arm);
    }
  }

  /** @private Wire up eventBus listeners */
  _setupListeners() {
    // Deploy arm to a target
    eventBus.on(Events.ARM_DEPLOY_TO, ({ target, preferType }) => {
      this.deployArm(target, preferType);
    });

    // Recall specific arm
    eventBus.on(Events.ARM_RECALL_ONE, ({ armId }) => {
      this.recallArm(armId);
    });

    // Recall all arms
    eventBus.on(Events.ARM_RECALL_ALL, () => {
      this.recallAll();
    });

    // The cast-all/fishing verb (ARM_FISH + deployFishing + the FISHING FSM
    // state) was orphaned when the RadialMenu/CommsPanel command was removed
    // (UX-11 #9); it had zero triggers, so the whole path was deleted in the
    // P1 integrity sweep. Re-introducing a passive-ambush verb is a fresh design.

    // V4 upgrade event (unlockable via tech tree)
    eventBus.on(Events.UPGRADE_V4_TECH, ({ upgrade }) => {
      this._applyV4Upgrade(upgrade);
    });

    // Sprint D5: V4 GSL upgrades purchased from shop
    eventBus.on(Events.UPGRADE_PURCHASED, ({ effect, value }) => {
      if (effect === 'v4TetherRange' || effect === 'v4NetArea' || effect === 'v4GripForce') {
        this.applyUpgrade({ effect, value });
      }
    });

    // Deorbit sacrifice command (Session 10)
    eventBus.on(Events.ARM_DEORBIT_CMD, () => {
      this.deorbitCapturingArm();
    });

    // Note: ARM_SELECT / ARM_DESELECT events are now EMITTED by selectArm/deselectArm
    // (Phase 1B). InputManager calls selectArm()/deselectArm() directly.
    // StatusPanel and other listeners still receive the events for HUD refresh.

    // Manual arm thrust from ARM PILOT mode
    eventBus.on(Events.ARM_MANUAL_THRUST, (data) => {
      const arm = this.arms.find(a => a.id === data.armId);
      if (arm && arm.isManual()) {
        arm.applyManualThrust(data.direction, data.fine, data.dt);
      }
    });

    // Task 7 (opening-dance plan, decision 6/7): arms lean aside for an
    // inbound catch. Trigger on LASSO_CAPTURED (a catch is inbound); release
    // on NET_BERTHED (the plan's own release event) or when the net clears
    // or fails. See _releaseLeanAside for why NET_BERTHED alone is not
    // sufficient on every path (a bounded timeout in _updateLeanAside covers
    // the gap).
    eventBus.on(Events.LASSO_CAPTURED, (payload) => this._onInboundCatchCaptured(payload));
    const releaseLeanAside = () => this._releaseLeanAside();
    eventBus.on(Events.NET_BERTHED, releaseLeanAside);
    eventBus.on(Events.LASSO_MISSED, releaseLeanAside);
    eventBus.on(Events.LASSO_SNAPPED, releaseLeanAside);
    eventBus.on(Events.NET_FAILED, releaseLeanAside);
    eventBus.on(Events.NET_RELEASED, releaseLeanAside);
    eventBus.on(Events.NET_TORN, releaseLeanAside);

    // reel-home (fix round F3): the mother's own net or lasso going out wins over a reel-home turn of the mother.
    eventBus.on(Events.NET_FIRED, (data) => {
      if (data && data.podIndex >= 0) this._rhOnMotherCatchFired('net');
    });
    eventBus.on(Events.LASSO_FIRED, () => this._rhOnMotherCatchFired('lasso'));
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  /**
   * Deploy the best available arm to capture a target.
   * @param {object} target - Debris object with .mesh, .id, .mass
   * @param {'weaver'|'spinner'|null} preferType - Preferred arm type (null = auto)
   * @returns {boolean} true if an arm was deployed
   */
  deployArm(target, preferType = null) {
    if (!target) return false;

    // ST-6.7: Safe-mode guard — refuse arm deployment when spacecraft is in safe mode
    if (this.playerSatellite && this.playerSatellite.safeMode) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Daughters locked. Safe mode active. Repair subsystems first.',
        priority: 'warning',
      });
      return false;
    }

    // ST-6.1: Active-satellite treaty guard — refuse arming if target's NORAD
    // is in the active-sat catalogue. Emits RED CONJUNCTION_ALERT + Houston
    // stand-down COMMS_MESSAGE, returns false.
    if (checkActiveSatArming(target, this._catalogLoader, eventBus)) return false;

    // Power distribution: block deployment if ARM bus is at 0%
    if (powerDistribution.armMultiplier <= 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'CAUTION: DAUGHTER BEACON OFFLINE. Increase DAUGHTER power to deploy',
        priority: 'warning',
      });
      return false;
    }

    // Auto-select type based on target mass
    const targetMass = target.mass || 1;
    let useType = preferType;
    if (!useType) {
      if (targetMass > Constants.SPINNER_MAX_CAPTURE_MASS) {
        useType = 'weaver';
      } else if (targetMass <= Constants.SPINNER_MAX_CAPTURE_MASS) {
        // Prefer spinners for small targets (saves weaver fuel)
        useType = 'spinner';
      }
    }

    // Compute direction from player to target in ship-local space for smart arm selection
    let targetDir = null;
    if (target._scenePosition && this.playerSatellite) {
      const playerPos = this.playerSatellite.position ||
        (this.playerSatellite.mesh && this.playerSatellite.mesh.position);
      if (playerPos) {
        targetDir = target._scenePosition.clone().sub(playerPos);
        // Transform to ship-local space using inverse of player quaternion
        const parentQuat = this.playerSatellite.quaternion;
        if (parentQuat) {
          targetDir.applyQuaternion(parentQuat.clone().invert());
        }
      }
    }

    // Find best available arm of preferred type (must be docked AND spring-charged)
    // Smart selection: prefer arm whose dock offset aligns with target direction
    let arm = this._findDockedArm(useType, targetDir);

    // Fallback to other type if preferred unavailable
    if (!arm) {
      arm = this._findDockedArm(useType === 'weaver' ? 'spinner' : 'weaver', targetDir);
    }

    if (!arm) {
      // no-melt: with no furnace a daughter that holds a catch stays holding it until the burn to the next field, where she
      // carries it to a furnace (trip-melt-2), so say that plainly instead of the bare "no daughters" line.
      const holding = Constants.isFeatureEnabled('FURNACE_COOK') ? 0
        : this.arms.filter((a) => a && a.state === ARM_STATES.HOLDING_CATCH).length;
      const usable = this.arms.filter((a) => a && a.state !== ARM_STATES.EXPENDED && !a.isDetached).length;
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: holding > 0 && holding >= usable
          ? 'All daughters are holding catches. They carry them to the furnaces on the burn to the next field.'
          : holding > 0
            ? `No daughter is free: ${holding} holding catches. They carry them to the furnaces on the burn to the next field.`
            : 'No daughters available for deployment (check spring charge)',
        priority: 'warning',
      });
      return false;
    }

    // Check mass compatibility
    if (targetMass > arm.config.maxCaptureMass) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${arm.displayName} cannot capture ${targetMass}kg (max ${arm.config.maxCaptureMass}kg)`,
        priority: 'warning',
      });
      return false;
    }

    // Aim-before-launch daughter ceremony: slew the chosen strut + rotate the
    // Mother so the physical strut fire direction points at the target, THEN
    // launch. Loose tolerance — TRANSIT FEEP corrects residual. Falls back to
    // an immediate launch when the autopilot/feature is unavailable.
    return this._deployWithCeremony(arm, target);
  }

  /**
   * Run the daughter launch ceremony for a selected+validated arm, then deploy.
   * Returns true when the ceremony starts (or the immediate fallback fires).
   * mother-aims: the ceremony turns the mother only when she is free to turn (`_motherTurnBlock`);
   * otherwise the strut alone aims the launch, with one comms line saying why.
   * @param {ArmUnit} arm
   * @param {object} target
   * @param {{announce?: boolean}} [opts] — see `deployArmByIndex`; handed on to the strut-only launch
   * @returns {boolean}
   * @private
   */
  _deployWithCeremony(arm, target, opts) {
    const ap = this._autopilot;
    const player = this.playerSatellite;
    const canCeremony = ap && typeof ap.requestAimRotation === 'function'
      && Constants.FEATURE_FLAGS.SEMI_AUTO_AIM
      && player && target && target._scenePosition;

    // Pre-ceremony max-deploy-range refusal (moved earlier so it stays instant;
    // ArmUnit.deploy still backstops it at fire time). Register item 100: same
    // tether-tier-aware expression as the backstop — tetherMax × fraction.
    if (target._scenePosition && arm.position) {
      const distM = target._scenePosition.clone().sub(arm.position).length() / M;
      const maxRange = arm.config.tetherMax * Constants.ARM_DEPLOY_RANGE_FRACTION;
      if (distM > maxRange) {
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${arm.displayName}: Target ${Math.round(distM)}m away (max ${Math.round(maxRange)}m). Press A to autopilot closer first.`,
          priority: 'warning',
        });
        return false;
      }
    }

    if (!canCeremony) {
      // L2: no aim ceremony → the daughter fires along the direct bearing; the
      // launch line is checked along that same bearing.
      return this._launchArm(arm, 'target', () => this._launchDirShip(arm, target),
        () => arm.deploy(target), opts);
    }

    // mother-aims: not free to turn (a daughter on her line, a catch on the collar, a hand-off or another
    // launch under way) → no turn; the strut alone aims the launch. `announce`: a launch the aim stage
    // holds back announces itself when it fires (the D key's auto-pick caller announces only a launch that
    // has already happened).
    const blocked = this._motherTurnBlock();
    if (blocked) {
      this._sayCantTurn(blocked);
      return this._launchArm(arm, 'target', () => this._launchDirShip(arm, target),
        () => arm.deploy(target), { ...(opts || {}), announce: true });
    }

    // Concurrency guard: don't supersede an in-flight aim sequence (e.g. a
    // Mother net aim already rotating). Defer, matching InputManager.fireMotherNet.
    // (mother-aims: `_motherTurnBlock` already refuses while an aim runs, so this is a backstop only.)
    if (typeof ap.isAiming === 'function' && ap.isAiming()) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Turning the ship to line up the launch — stand by.', priority: 'info',
      });
      return false;
    }

    // Reserve the arm so a second D-press doesn't grab it mid-ceremony.
    arm._aimReserved = true;

    // World-direction provider: strut-tip → target scene position (recomputed
    // per tick so it tracks the moving target). No lead — TRANSIT corrects.
    // Reuses one scratch output object (no per-frame allocation).
    const provOut = { x: 0, y: 0, z: 0 };
    const provider = () => {
      const tp = (target._scenePosition) ? target._scenePosition
        : (typeof target.getScenePosition === 'function' ? target.getScenePosition() : null);
      if (!tp || !arm.position) return null;
      const dx = tp.x - arm.position.x, dy = tp.y - arm.position.y, dz = tp.z - arm.position.z;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      provOut.x = dx / len; provOut.y = dy / len; provOut.z = dz / len;
      return provOut;
    };

    ap.requestAimRotation(provider, {
      mode: 'daughter', armManager: this, arm, pairIndex: arm.index,
    }).then(() => {
      arm._aimReserved = false;
      // L2: the launch goes through the keep-out gate. The line is checked along
      // the converged STRUT direction (re-derived each check — struts move); a
      // clear line fires this same frame, as before.
      this._launchArm(arm, 'ceremony', () => this._strutDirShip(arm), () => {
        // Tell deploy() the strut was physically aimed at the target, so it fires
        // along the strut basis (SSOT) rather than the direct-bearing fallback.
        arm._aimConverged = true;
        const ok = arm.deploy(target);
        // Camera ceremony must start when the arm ACTUALLY deploys (post-rotation),
        // not during the slew. The synchronous InputManager emit is skipped for
        // ceremony deploys (arm isn't deployed yet at that point), so emit here.
        if (ok) eventBus.emit(Events.LAUNCH_CEREMONY_START, { arm });
        return ok;
      });
    }).catch(() => {
      arm._aimReserved = false;
      // Abort comms already emitted by AutopilotSystem.
    });

    return true;
  }

  /** Inject the autopilot for the aim-before-launch daughter ceremony. */
  setAutopilot(autopilot) { this._autopilot = autopilot; }

  /**
   * Deploy a specific arm by ID.
   * @param {string} armId
   * @param {object} target
   * @returns {boolean}
   */
  deploySpecificArm(armId, target) {
    if (checkActiveSatArming(target, this._catalogLoader, eventBus)) return false;
    const arm = this.arms.find(a => a.id === armId);
    if (!arm) return false;
    return this._launchArm(arm, 'target', () => this._launchDirShip(arm, target),
      () => arm.deploy(target));
  }

  /**
   * Deploy a specific arm by index (0-based).
   * If target is provided, deploys toward target. If null, deploys in free-fly mode.
   * Used by number key deploy+select flow (Phase 1B).
   * mother-aims: with a target and the mother free to turn, the number key does what the D key does: the
   * mother turns (and the strut slews) until the strut points at the target, then the spring fires. Not
   * free (a daughter out on her line, a catch on the collar, a hand-off or another launch): the strut aims alone.
   * @param {number} index - 0-based arm index
   * @param {object|null} target - Optional target to aim toward
   * @param {{announce?: boolean}} [opts] - `announce`: the number-key launch (InputManager). A launch
   *   the aim stage holds back then announces itself (the cut-scene start) when it fires; an
   *   immediate launch is announced by the caller as before. The launch LINE is not announced
   *   here: ArmUnit says "Spring released. Separating" when the spring really fires.
   * @returns {boolean} true if deployment started
   */
  deployArmByIndex(index, target, opts) {
    // ST-6.7: Safe-mode guard — refuse arm deployment when spacecraft is in safe mode
    if (this.playerSatellite && this.playerSatellite.safeMode) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Daughters locked. Safe mode active. Repair subsystems first.',
        priority: 'warning',
      });
      return false;
    }

    // ST-6.1: Active-sat treaty guard (even if target was selected by player).
    if (checkActiveSatArming(target, this._catalogLoader, eventBus)) return false;
    const arm = this.arms[index];
    if (!arm || arm.state !== ARM_STATES.DOCKED) return false;

    // V5: Spring must be charged to deploy
    if (!arm.springCharged) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${arm.displayName}: Spring not charged. Reloading`,
        priority: 'warning',
      });
      return false;
    }

    // Power distribution: block deployment if ARM bus is at 0%
    if (powerDistribution.armMultiplier <= 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'CAUTION: DAUGHTER BEACON OFFLINE. Increase DAUGHTER power to deploy',
        priority: 'warning',
      });
      return false;
    }

    // mother-aims: with a target, the number key turns the mother too (the D key's ceremony) when she is
    // free to turn; otherwise only the arm's strut aims (today's launch aim). A launch of this arm that is
    // already waiting keeps its single entry (requestClearLaunch answers "accepted" for it).
    if (target && !(this._pendingLaunches && this._pendingLaunches.has(index))) {
      const blocked = this._motherTurnBlock();
      if (!blocked) return this._deployWithCeremony(arm, target, opts);
      // The D key with this daughter selected (`announce`) says why the mother does not turn, once; a launch
      // of hers that already waits keeps its single entry and says nothing again.
      if (opts && opts.announce) this._sayCantTurn(blocked);
    }

    // No target → free-fly mode (TRANSIT with manual control). L2: through the
    // keep-out gate, along the direction the arm will actually fire.
    return this._launchTargetOrFree(arm, target, opts);
  }

  // ==========================================================================
  // mother-aims — the launch turns the mother when she is free to turn
  // ==========================================================================

  /** The one comms line for a launch the mother may not turn for. @private */
  _sayCantTurn(reason) {
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `Mother can't turn now (${reason}): aiming the arm only.`, priority: 'info',
    });
  }

  /**
   * reel-home (Decision 6, fix round F1): does `a` NOT limit the mother's turn for `exceptArm`? True for `exceptArm`
   * herself (her own reservation and state), and for another daughter on the strut line (state REELING and home — her
   * line is being wound in). False without `exceptArm` (launch callers), and for a daughter still in GRAPPLED, her net
   * reel included: that daughter is working.
   * @private
   */
  _rhIgnoredForTurn(a, exceptArm) {
    return !!exceptArm && (a === exceptArm || (a.state === ARM_STATES.REELING && a.isReelingHome === true));
  }

  /**
   * Why the mother may NOT turn for a launch right now, in plain words, or null when she is free to turn.
   * Free = no daughter out on a line (rotation-lock tier 'none'), no launch in flight or waiting (another arm
   * LAUNCHING, an arm reserved, a pending launch, an aim running), no catch on the collar / nose (state + size:
   * `_heldCatchCorridorRadiusM`, whatever its mass), no hand-off, no scripted turn and no other system holding
   * the attitude (a mother-net reel-in). Catches latched on radiator tips and on daughters' racks do NOT block:
   * they are held rigidly and their inertia is already in the turn's gas bill (`getAttitudeInertia`).
   * @returns {string|null}
   * @private
   */
  _motherTurnBlock(exceptArm = null) {
    if (this.getRotationLockTier(exceptArm) !== 'none') return 'a daughter is out on her line';
    const ap = this._autopilot;
    // reel-home (fix round F5): the autopilot flying the ship keeps steering it back to its own heading the moment a
    // turn ends, so a daughter's turn would be undone: she lines herself up instead. Launch callers (no argument) keep
    // today's answer.
    if (exceptArm && ap && ap.engaged === true) return 'the autopilot is flying the ship';
    // reel-home (Decision 6): with `exceptArm` the daughter's own reservation does not count, nor the reservation of
    // another daughter on the strut line (REELING); the mother's own reel-home turn (below) is not "a hand-off" either.
    const mine = !!exceptArm && !!this._rhTurn;
    if ((this._pendingLaunches && this._pendingLaunches.size > 0)
        || this.arms.some((a) => a && ((a._aimReserved && !this._rhIgnoredForTurn(a, exceptArm))
          || a.state === ARM_STATES.LAUNCHING))
        || (ap && typeof ap.isAiming === 'function' && ap.isAiming())) {
      return 'a launch is in progress';
    }
    const ld = this.playerSatellite && this.playerSatellite.leashDriver;
    if (ld && typeof ld.isActive === 'function' && ld.isActive()) return 'a hand-off is running';
    if (this._heldCatchCorridorRadiusM() !== null) return 'a catch is on the collar';
    if (!mine && ap && typeof ap.isTurning === 'function' && ap.isTurning()) return 'a hand-off is running';   // a scripted turn takes an anonymous hold too
    if (ap && typeof ap.isReelInHeld === 'function' && ap.isReelInHeld()) return 'a catch is being reeled in';
    if (!mine && ap && typeof ap.isAttitudeHeld === 'function' && ap.isAttitudeHeld()) return 'a hand-off is running';
    return null;
  }

  /**
   * Pane-density pure-scenery rung: hide/show every daughter's scene group for
   * an empty-orbit view. Prior per-arm group visibility is remembered so a
   * restore never resurrects an EXPENDED/lost daughter (ArmUnit hides its group
   * on deorbit-complete, ArmUnit.js). A daughter deployed while hidden is not
   * retroactively hidden — an accepted edge of the pure-scenery mode.
   * @param {boolean} visible
   */
  setFleetVisible(visible) {
    if (!visible) {
      if (!this._fleetVisMemory) this._fleetVisMemory = new Map();
      for (const arm of this.arms) {
        if (!arm || !arm.group) continue;
        this._fleetVisMemory.set(arm, arm.group.visible);
        arm.group.visible = false;
      }
    } else {
      const mem = this._fleetVisMemory;
      for (const arm of this.arms) {
        if (!arm || !arm.group) continue;
        arm.group.visible = mem && mem.has(arm) ? mem.get(arm) : true;
      }
      this._fleetVisMemory = null;
    }
  }

  /**
   * Forward the live camera→craft distance (scene units) to each daughter so its
   * inert detail hardware can be culled at range (Phase 6 detail LOD). Cheap:
   * each daughter only does work when a hysteresis threshold is crossed.
   * @param {number} distSceneUnits
   */
  setCameraDistance(distSceneUnits) {
    for (const arm of this.arms) {
      if (arm && typeof arm.setCameraDistance === 'function') {
        arm.setCameraDistance(distSceneUnits);
      }
    }
  }

  /**
   * Deploy a docked arm in trawling mode — slow sweep for passive debris collection.
   * @param {{ x: number, y: number, z: number }|null} direction — trawl direction
   * @returns {boolean}
   */
  deployTrawl(direction = null) {    // Power distribution: block deployment if ARM bus is at 0%
    if (powerDistribution.armMultiplier <= 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'CAUTION: DAUGHTER BEACON OFFLINE. Increase DAUGHTER power to deploy',
        priority: 'warning',
      });
      return false;
    }

    const maxTrawl = (Constants.TRAWLING && Constants.TRAWLING.MAX_TRAWL_ARMS) || 3;
    const trawling = this.arms.filter(a => a.state === ARM_STATES.TRAWLING);

    if (trawling.length >= maxTrawl) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'DTR-MGR', text: `Max trawl daughters (${maxTrawl}) deployed`, priority: 'warning',
      });
      return false;
    }

    // Find a docked arm (prefer spinner type for trawling)
    let arm = this._findDockedArm('spinner');
    if (!arm) arm = this._findDockedArm('weaver');
    if (!arm) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'DTR-MGR', text: 'No docked daughters available', priority: 'warning',
      });
      return false;
    }

    // No direction given: she sweeps along her own dock direction (launch-aim: that one is frozen at the request).
    return this._launchArm(arm, 'trawl', () => this._trawlDirShip(arm, direction),
      () => arm.deployTrawl(direction), direction ? undefined : { frozenAim: true });
  }

  /**
   * Fire a GSL web shot from a docked arm at a target debris.
   * "Fire and forget" ranged shot that increases debris atmospheric drag.
   * @param {object} target - Debris object with .id and ._scenePosition
   * @param {'weaver'|'spinner'|null} [preferType] - Preferred arm type
   * @returns {boolean} true if web shot was fired
   */
  fireWebShot(target, preferType = null) {
    if (!target) return false;

    // Power distribution: block if ARM bus offline
    if (powerDistribution.armMultiplier <= 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'CAUTION: DAUGHTER BEACON OFFLINE. Increase DAUGHTER power for web shot',
        priority: 'warning',
      });
      return false;
    }

    // Sprint C2: Prefer selected arm if eligible
    if (this.selectedArmIndex >= 0 && this.selectedArmIndex < this.arms.length) {
      const selected = this.arms[this.selectedArmIndex];
      if (selected.state === ARM_STATES.DOCKED &&
          selected._webShotCooldown <= 0 && selected.fuel > Constants.WEB_SHOT_FUEL_COST) {
        if (selected.fireWebShot(target)) return true;
      }
    }

    // Find a docked arm (prefer type if given) with no cooldown
    const eligible = (a) =>
      a.state === ARM_STATES.DOCKED &&
      a._webShotCooldown <= 0;

    let arm = preferType
      ? this.arms.find(a => a.type === preferType && eligible(a) && a.fuel > Constants.WEB_SHOT_FUEL_COST)
      : null;
    if (!arm) {
      arm = this.arms.find(a => eligible(a) && a.fuel > Constants.WEB_SHOT_FUEL_COST);
    }
    if (!arm) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'No daughters available for web shot (cooldown or insufficient fuel)',
        priority: 'warning',
      });
      return false;
    }
    return arm.fireWebShot(target);
  }

  /**
   * Set reference to debris field for trawling proximity checks.
   * @param {import('../entities/DebrisField.js').DebrisField} debrisField
   */
  setDebrisField(debrisField) {
    this._debrisField = debrisField;
  }

  /**
   * ST-6.1: Inject the CatalogLoader so arm-arming code can look up active-sat
   * entries before committing. Null-safe: if not set, the treaty guard is a no-op.
   * @param {object} catalogLoader
   */
  setCatalogLoader(catalogLoader) {
    this._catalogLoader = catalogLoader || null;
  }

  /**
   * Set reference to ResourceSystem for reading upgraded resource maxes.
   * @param {ResourceSystem} rs
   */
  setResourceSystem(rs) {
    this._resourceSystem = rs;
  }

  /**
   * Wire the SceneManager so docked/close daughters can join the near-field
   * depth pass (z-layer fix). Without this, daughters render on layer 0 (far
   * pass) and get occluded by the depth-cleared near pass — and z-fight the
   * mother's strut-tip collars where they overlap. Null-safe.
   * @param {import('../scene/SceneManager.js').SceneManager} sceneManager
   */
  setSceneManager(sceneManager) {
    this._sceneManager = sceneManager || null;
  }

  /**
   * Issue deorbit sacrifice command to the first arm that has captured debris.
   * The arm burns all remaining FEEP fuel retrograde and is lost.
   * @returns {{ success: boolean, armId?: string, fuelAtStart?: number, totalMass?: number, debrisId?: number }}
   */
  deorbitCapturingArm() {
    // Sprint C2: Prefer selected arm if it's eligible for deorbit.
    // Only fuel-capable states are eligible for the general (auto-pick) path —
    // a deorbit burn needs real propellant. ADRIFT (reserve-only) is deliberately
    // NOT eligible here so an out-of-fuel daughter can't intercept and consume a
    // healthy daughter's deorbit via the find() fallback below.
    const isEligible = (a) =>
      (a.state === ARM_STATES.GRAPPLED ||
       a.state === ARM_STATES.HAULING ||
       a.state === ARM_STATES.RETURNING) &&
      (a.capturedDebris || a.target);

    let eligible = null;
    if (this.selectedArmIndex >= 0 && this.selectedArmIndex < this.arms.length) {
      const selected = this.arms[this.selectedArmIndex];
      if (isEligible(selected)) {
        eligible = selected;
      } else if (selected && selected.state === ARM_STATES.ADRIFT &&
                 (selected.capturedDebris || selected.target)) {
        // The player explicitly targeted an adrift daughter for deorbit — let
        // startDeorbit emit the "reel her in instead" hint for THAT daughter
        // (scoped to the selection so it can't shadow another's deorbit).
        selected.startDeorbit();
        return { success: false };
      }
    }
    // Fallback: find first eligible (fuel-capable) arm
    if (!eligible) {
      eligible = this.arms.find(isEligible);
    }

    if (!eligible) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'No daughter with captured debris available for deorbit sacrifice',
        priority: 'warning',
      });
      return { success: false };
    }

    const result = eligible.startDeorbit();
    if (result.success) {
      return {
        success: true,
        armId: eligible.id,
        fuelAtStart: result.fuelAtStart,
        totalMass: result.totalMass,
        debrisId: eligible.capturedDebris?.id || eligible.target?.id,
      };
    }
    return { success: false };
  }

  /**
   * Recall a specific arm by ID.
   * @param {string} armId
   */
  recallArm(armId) {
    const arm = this.arms.find(a => a.id === armId);
    if (arm) arm.recall();
  }

  /**
   * Get the best candidate arm for detach.
   * Priority: APPROACH > TRANSIT > NETTING > GRAPPLED > STATION_KEEP > ADRIFT.
   * If ARM PILOT is active, prefer the piloted arm (including a station-keeping
   * or adrift daughter, so X cuts HER tether).
   * @returns {ArmUnit|null}
   */
  getActiveDetachCandidate() {
    const S = ARM_STATES;
    const PRIORITY = [S.APPROACH, S.TRANSIT, S.NETTING, S.GRAPPLED, S.STATION_KEEP, S.ADRIFT];
    // If a specific arm is selected (arm pilot mode), prefer it
    const selected = this.getSelectedDeployedArm();
    if (selected && !selected.isDetached) {
      const detachable = new Set(PRIORITY);
      if (detachable.has(selected.state)) return selected;
    }
    // Otherwise find highest-priority candidate
    for (const state of PRIORITY) {
      const arm = this.arms.find(a => a.state === state && !a.isDetached);
      if (arm) return arm;
    }
    return null;
  }

  /**
   * Execute detach on a specific arm by index.
   * @param {number} armIndex
   * @returns {boolean}
   */
  detachArm(armIndex) {
    const arm = this.arms[armIndex];
    if (!arm) return false;
    return arm.detach();
  }

  /**
   * S2.2: Deploy all docked arms to the given target simultaneously.
   * Arms that can't deploy (no spring charge, wrong state) are silently skipped.
   * @param {object|null} target - Target debris. If null, deploys in free-fly.
   * @returns {number} Number of arms successfully deployed
   */
  deployAllToTarget(target) {
    // ST-6.7: Safe-mode guard
    if (this.playerSatellite && this.playerSatellite.safeMode) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'CAUTION: SAFE MODE. Daughter deployment locked', priority: 'warning',
      });
      return 0;
    }
    // Power distribution guard
    if (powerDistribution.armMultiplier <= 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'CAUTION: DAUGHTER BEACON OFFLINE. Increase DAUGHTER power to deploy', priority: 'warning',
      });
      return 0;
    }

    let deployed = 0;
    for (const arm of this.arms) {
      if (arm.state !== ARM_STATES.DOCKED) continue;
      if (!arm.springCharged) continue;
      const ok = this._launchTargetOrFree(arm, target);
      if (ok) deployed++;
    }

    if (deployed > 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${deployed} daughter${deployed > 1 ? 's' : ''} deployed${target ? ` → ${target.type || 'target'}` : ' (free-fly)'}`,
        priority: 'info',
      });
    } else {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'No daughters available. Check charge status.',
        priority: 'warning',
      });
    }
    return deployed;
  }

  /**
   * Shift+A fan-out (2026-06-14): deploy every docked daughter to a *distinct*
   * debris so the fleet spreads across the field for quick, high-risk salvage
   * (instead of all piling onto one target like deployAllToTarget). The i-th
   * deployable daughter is sent to the i-th entry of `targets`; when there are
   * more daughters than targets, the extras fall back to `fallbackTarget` (the
   * mother's active target) or free-fly. Returns the number deployed.
   *
   * @param {Array<object>} targets - distinct debris objects, best-first
   * @param {object|null} [fallbackTarget] - target for surplus daughters
   * @returns {number} number of daughters successfully deployed
   */
  deployAllToDistinctTargets(targets, fallbackTarget = null) {
    // ST-6.7: Safe-mode guard
    if (this.playerSatellite && this.playerSatellite.safeMode) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'CAUTION: SAFE MODE. Daughter deployment locked', priority: 'warning',
      });
      return 0;
    }
    // Power distribution guard
    if (powerDistribution.armMultiplier <= 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'CAUTION: DAUGHTER BEACON OFFLINE. Increase DAUGHTER power to deploy', priority: 'warning',
      });
      return 0;
    }

    const list = Array.isArray(targets) ? targets.filter(Boolean) : [];
    let deployed = 0;
    let assigned = 0;   // index into the distinct-target list
    for (const arm of this.arms) {
      if (arm.state !== ARM_STATES.DOCKED) continue;
      if (!arm.springCharged) continue;
      // Distinct target for this daughter; surplus daughters reuse the
      // fallback (mother's active target) or free-fly when none.
      const target = (assigned < list.length) ? list[assigned] : fallbackTarget;
      const ok = this._launchTargetOrFree(arm, target);
      if (ok) {
        deployed++;
        if (assigned < list.length) assigned++;
      }
    }

    if (deployed > 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${deployed} daughter${deployed > 1 ? 's' : ''} fanned out across ${Math.min(deployed, list.length) || 1} target${(Math.min(deployed, list.length) || 1) > 1 ? 's' : ''}`,
        priority: 'info',
      });
    } else {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'No daughters available. Check charge status.',
        priority: 'warning',
      });
    }
    return deployed;
  }

  /**
   * Recall all deployed arms.
   */
  recallAll() {
    for (const arm of this.arms) {
      arm.recall();
    }
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: 'All daughters recalled',
      priority: 'info',
    });
  }

  /**
   * Recall every *deployed* daughter (Shift+R). Unlike recallAll(), this skips
   * arms that are already resting / homing / spent (DOCKED, EXPENDED, DOCKING;
   * a detached RETURNING daughter has no line) or parked with a catch (HOLDING_CATCH — recall refuses her, so
   * commanding her would eat the hold; see ArmUnit.recall) and returns the
   * number actually commanded home, so the caller can
   * give honest feedback ("Reeling in all daughters (N)" vs "nothing to reel")
   * instead of the old always-positive "All daughters recalled" notice that read
   * as a no-op when nothing was out (2026-06-14 reel-in fix).
   * @returns {number} count of daughters commanded to reel home
   */
  recallAllDeployed() {
    const S = ARM_STATES;
    let count = 0;
    for (const arm of this.arms) {
      if (!arm) continue;
      if (arm.state === S.DOCKED) continue;
      if (arm.state === S.EXPENDED) continue;
      // fail-reel: a tethered RETURNING daughter (limping home on her FEEP) is on her line: R winds her in (recall() -> REELING)
      if (arm.state === S.RETURNING && arm.isDetached) continue;
      if (arm.state === S.DOCKING) continue;
      if (arm.state === S.HOLDING_CATCH) continue; // parked with cargo — recall refuses her
      if (_CARRY_STATES.has(arm.state)) continue;  // carrying a catch to a furnace — it ends at her dock
      if (typeof arm.recall === 'function') {
        // Zero-fuel reel on the mothership tether motor: stuck / fuel-depleted
        // tethered daughters always come home (never abandoned as EXPENDED).
        // fail-reel review F4: count only real recalls (recall() === true); 'already' (reeling) and refusals are not recalls
        if (arm.recall() === true) count++;
      }
    }
    return count;
  }

  /**
   * Phase 3a (capture-feedback overhaul): propagate the Shift-held boost-reel
   * intent to every arm. Called every frame from InputManager.processInput so
   * the boost always releases on keyup / overlay open.
   * @param {boolean} held
   */
  setReelBoost(held) {
    for (const arm of this.arms) {
      arm._boostReelHeld = !!held;
    }
  }

  /**
   * Recall a deployed daughter: the SELECTED one first, closest as fallback.
   *
   * Delegation 1 (2026-05-31) onboarding helper for the bare-R rebind;
   * selection-aware since the pick-then-launch fix:
   *   • If `selectedArmIndex` points at an eligible deployed daughter (in a
   *     recallable state and not detached), recall HER — this covers the
   *     pick-then-launch → skip-ceremony path that leaves a deployed daughter
   *     selected in mother mode. A DOCKED selection (picked but never
   *     launched) is NOT recallable, so it intentionally falls through to the
   *     closest scan; selection alone must never short-circuit eligibility.
   *   • Otherwise iterates this.arms.
   *   • Selects arms in any non-resting state (i.e. NOT DOCKED, EXPENDED,
   *     DOCKING, HOLDING_CATCH, a detached RETURNING one — those are already
   *     docking, unable to be recalled, or parked with a catch recall must not
   *     destroy). A tethered RETURNING daughter IS eligible (fail-reel: R winds
   *     her in on the strut reel).
   *   • Picks the candidate with the smallest world-space distance from
   *     the mother. When `motherPos`/`arm.position` is unresolvable the scan
   *     silently keeps `eligible[0]` — acceptable fallback.
   *   • Calls the existing recall path used by `recallArm()` / `recallAll()`
   *     (i.e. `arm.recall()`), which is the same flow `H` triggers.
   *
   * No new event constant is introduced — `arm.recall()` already emits the
   * arm-state-change events the rest of the system listens for.
   *
   * @returns {number|null} 0-based index of the recalled arm, or `null` if
   *   no eligible deployed daughter was found.
   */
  recallClosestDeployed() {
    const S = ARM_STATES;
    const isRecallable = (a) => a
      && a.state !== S.DOCKED
      && a.state !== S.EXPENDED
      && !(a.state === S.RETURNING && a.isDetached)   // fail-reel: tethered RETURNING is recallable (R winds her in)
      && a.state !== S.DOCKING
      && a.state !== S.HOLDING_CATCH // parked with cargo — recall refuses her
      && !_CARRY_STATES.has(a.state);  // carrying a catch to a furnace — it ends at her dock

    // (0) Selection-aware: recall the SELECTED deployed daughter first.
    if (this.selectedArmIndex >= 0) {
      const sel = this.arms[this.selectedArmIndex];
      if (sel && isRecallable(sel) && !sel.isDetached
          && typeof sel.recall === 'function') {
        sel.recall();
        return this.selectedArmIndex;
      }
      // Ineligible selection (e.g. DOCKED pick-then-launch) → fall through.
    }

    // Any non-resting state — exclude arms already homing or expended.
    const eligible = [];
    for (let i = 0; i < this.arms.length; i++) {
      const a = this.arms[i];
      if (!a) continue;
      if (!isRecallable(a)) continue;
      eligible.push({ idx: i, arm: a });
    }
    if (eligible.length === 0) return null;

    // Resolve mother world position once.
    const motherPos = (this.playerSatellite && (this.playerSatellite.position
      || (this.playerSatellite.mesh && this.playerSatellite.mesh.position))) || null;

    let bestIdx = eligible[0].idx;
    let bestDistSq = Infinity;
    for (const { idx, arm } of eligible) {
      if (motherPos && arm.position) {
        const dx = arm.position.x - motherPos.x;
        const dy = arm.position.y - motherPos.y;
        const dz = arm.position.z - motherPos.z;
        const dsq = dx * dx + dy * dy + dz * dz;
        if (dsq < bestDistSq) {
          bestDistSq = dsq;
          bestIdx = idx;
        }
      }
    }

    const target = this.arms[bestIdx];
    if (target && typeof target.recall === 'function') {
      // Pull the daughter home on the strut/tether reel motor (zero-fuel) so a
      // stuck or fuel-depleted daughter is still reeled in, never abandoned.
      target.recall();
      return bestIdx;
    }
    return null;
  }

  // ==========================================================================
  // V5 DUAL-FIRE
  // ==========================================================================

  /**
   * Fire two opposite arms simultaneously to cancel recoil.
   * Config G antipodal pairs: Y0 (0↔2, 1↔3), Y1 (0↔3, 1↔4, 2↔5), Y3 + end-face (6↔7).
   * Use getDualFirePair() to resolve the correct partner at any tier.
   * @param {number} armIndex1 - First arm index
   * @param {number} armIndex2 - Second arm index (opposite)
   * @param {Object} target1 - Target for arm 1 (optional)
   * @param {Object} target2 - Target for arm 2 (optional)
   * @returns {boolean} Success
   */
  dualFire(armIndex1, armIndex2, target1 = null, target2 = null) {
    const arm1 = this.arms[armIndex1];
    const arm2 = this.arms[armIndex2];

    if (!arm1 || !arm2) return false;

    // Both must be docked AND spring-charged
    if (arm1.state !== ARM_STATES.DOCKED || !arm1.springCharged) return false;
    if (arm2.state !== ARM_STATES.DOCKED || !arm2.springCharged) return false;

    // Deploy both within sync window. L2: each goes through the keep-out gate; a
    // pair only counts as a DUAL fire (recoil cancelled) when BOTH fired now —
    // a launch the gate deferred leaves a single-arm launch later.
    const deployed1 = this._launchTargetOrFree(arm1, target1);
    const deployed2 = this._launchTargetOrFree(arm2, target2);
    const pend = this._pendingLaunches;
    const firedTogether = deployed1 && deployed2
      && !(pend && (pend.has(armIndex1) || pend.has(armIndex2)));

    if (firedTogether) {
      // Calculate net recoil (should be ~zero for same-type pairs)
      const mass1 = arm1.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS;
      const mass2 = arm2.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS;
      const recoil1 = mass1 * arm1.launchSpeed;
      const recoil2 = mass2 * arm2.launchSpeed;
      const residualMomentum = Math.abs(recoil1 - recoil2);
      // Her LIVE mass (Nets step 3 slice 2a: the budget, the two daughters already out of it); MASS_KG, her start mass, when
      // there is no player or it answers nothing usable.
      const live = this.playerSatellite ? this.playerSatellite.mass : NaN;
      const motherMass = Number.isFinite(live) && live > 0 ? live : Constants.MOTHER_DRAG.MASS_KG; // kg
      const residualDv = residualMomentum / motherMass;

      eventBus.emit(Events.DUAL_FIRE, {
        armIndex1,
        armIndex2,
      });

      eventBus.emit(Events.DUAL_FIRE_RECOIL, {
        cancelled: residualDv < 0.01,
        residualDv: residualDv,
      });

      return true;
    }

    // Both accepted but one was deferred by the gate: no DUAL_FIRE yet (they will
    // not fire together). Otherwise at least one was refused.
    return !!(deployed1 && deployed2);
  }

  /**
   * Get the opposite arm index for dual-fire pairing (ST-9.2).
   * Delegates to getDualFirePair for azimuth-based antipodal lookup.
   * @param {number} index - Arm index
   * @returns {number} Opposite arm index, or -1 if invalid
   */
  getOppositeArm(index) {
    const result = this.getDualFirePair(index);
    return result !== null ? result : -1;
  }

  /**
   * Get the antipodal partner index for dual-fire (ST-9.2 Config G).
   * Looks up arm whose azimuth = (thisAzimuth + 180°) % 360°.
   * Works for all tiers: Y0 Quad (60↔240, 120↔300), Y1 Hex,
   * Y3 Octo ring arms + end-face pair (+Z ↔ −Z).
   * @param {number} armIndex — 0-based arm index
   * @returns {number|null} Antipodal partner index, or null if none
   */
  getDualFirePair(armIndex) {
    if (!this._dockPositions || armIndex < 0 || armIndex >= this._dockPositions.length) return null;
    const dp = this._dockPositions[armIndex];
    const targetAz = (dp.azimuthDeg + 180) % 360;

    for (let j = 0; j < this._dockPositions.length; j++) {
      if (j === armIndex) continue;
      if (Math.abs(this._dockPositions[j].azimuthDeg - targetAz) < 0.1) return j;
    }
    return null;
  }

  // ==========================================================================
  // ST-9.2 CONFIG G TIER MANAGEMENT
  // ==========================================================================

  /**
   * Get the active arm tier key (ST-9.2).
   * @returns {string} One of 'Y0_QUAD', 'Y1_HEX', 'Y3_OCTO'
   */
  getCurrentTier() {
    return this._activeTierKey;
  }

  // ==========================================================================
  // ST-9.2 CONFIG G STRUT TIP GEOMETRY
  // ==========================================================================

  /**
   * Compute strut tip position at sweep angle α (ST-9.2 Config G).
   *
   * Convention (ArmDockBasis.strutLocalDirection — the RENDERED ship frame):
   *   α = 0   → STOWED  (alongside barrel, daughter aft at −Z)
   *   α = π/2 → EQUATORIAL (radial outward in the collar XY plane)
   *   α = π   → ZENITH  (pointing +Z, forward of Mother)
   *
   * Formula: tip = hinge + STRUT_LENGTH × ( sin(α)·outward − cos(α)·ẑ )
   *
   * Returns position in METERS (not scene units). Caller scales by M if needed.
   * S13(a): delegates to CoMCalculator.strutTipMeters — ONE computation owns
   * the stored-dock → ship-frame map (register item 57); this twin must never
   * re-derive it.
   *
   * @param {number} armIndex — arm index
   * @param {number} alpha — sweep angle in radians [0, π]
   * @returns {{x: number, y: number, z: number}|null} Tip in meters, ship frame, or null
   */
  getStrutTipPosition(armIndex, alpha) {
    if (!this._dockPositions || armIndex < 0 || armIndex >= this._dockPositions.length) return null;
    return strutTipMeters(this._dockPositions[armIndex], alpha);
  }

  /**
   * Session L (plan item 4): the "." hotkey's strut toggle as a PUBLIC method
   * — the REFIT BERTHS card's STRUTS chip and the F1 bar's `struts` actuator
   * drive it through the hub; InputManager's Period case delegates here. It is
   * the ONE copy of the strut law. It writes `_strutTargetAlpha` on DOCKED arms
   * and on daughters HOLDING A CATCH (hold-catch, owner 2026-10-22: never below
   * her hold pose, never above 100°; see `_pressHolders`), and decides from the
   * live read (getAimAlpha, a pending latch winning — never the latch alone, it
   * clears to undefined on arrival).
   *
   * The law (owner 2026-10-14; angles measured from the tail):
   *   • a press while any docked strut is open (live or pending, past
   *     STRUT_OPEN_THRESHOLD, half the rest angle, 17°) → ALL to 0°;
   *   • otherwise → ALL to STRUT_REST_ALPHA, 34° (swept back);
   *   • with `armIndex` of a DOCKED daughter ("." with her selected, lane
   *     arms-default, owner 2026-10-16) "ALL" below means just her, and the
   *     open/closed test reads only her strut;
   *   • a press within STRUT_PUSH_WINDOW_MS (600 ms) of the previous press → ALL
   *     to STRUT_DEPLOY_ALPHA, 90°, whatever the first press did, and the window
   *     resets (a third quick press is a fresh single press). So a second press
   *     inside 600 ms ALWAYS means 90°; reversing a swing needs a press after 600 ms.
   *   • no tap sequence ever targets 180° (STRUT_SWEEP_MAX is the range, not a target).
   * Emitting Events.STRUT_DEPLOY_INPUT stays the CALLER's job (InputManager
   * emits its own; the hub emits for the pane), as does the click.
   * @returns {boolean|null} true = opening (34° or 90°), false = closing (0°);
   *   null when no DOCKED or holding arm could take the write (nothing toggled —
   *   the caller should skip its emit). A DOUBLE press that moves nothing leaves one
   *   plain sentence in `lastStrutPressNote` (else null) for the caller to say; a
   *   single press that moves nothing leaves it in `_pendingStrutNote`, which
   *   `_tickStrutPressNote` says once the double-press window has passed.
   */
  toggleStruts(armIndex) {
    this.lastStrutPressNote = null;
    this._pendingStrutNote = null;               // a new press supersedes a line still waiting out the double-press window
    let docked = (this.arms || []).filter((a) => a && a.state === ARM_STATES.DOCKED);
    // hold-catch (owner 2026-10-22: '"." keys doesn't move them'): a daughter aboard holding a catch takes the press too, but
    // her strut never goes below her hold pose (34° or the lowest plume-clear angle) or above HOLD_POSE_MAX_DEG.
    let holders = (this.arms || []).filter((a) => a && a.state === ARM_STATES.HOLDING_CATCH && !a.isDetached
      && Array.isArray(a.heldCatches) && a.heldCatches.some((h) => h));
    // A selected daughter, docked or holding (the "." key passes her index): the same law, for her alone.
    // No index, or she is away → every docked / holding arm, as before.
    if (Number.isInteger(armIndex) && armIndex >= 0) {
      const only = (this.arms || [])[armIndex];
      if (only && only.state === ARM_STATES.DOCKED) { docked = [only]; holders = []; }
      else if (only && holders.includes(only)) { docked = []; holders = [only]; }
    }
    if (!docked.length && !holders.length) return null;
    const V5 = Constants.OCTOPUS_V5;
    // the open/closed read comes from the docked struts; with only holders it reads whether they stand above their hold pose
    const holdRad = (a) => { const hp = _holdPoseOf(this, this.arms.indexOf(a)); return hp ? hp.rad : V5.STRUT_REST_ALPHA; };
    const anyOpen = docked.length
      ? docked.some((a) => _strutLiveAlpha(a) >= V5.STRUT_OPEN_THRESHOLD)
      : holders.some((a) => _strutLiveAlpha(a) > holdRad(a) + V5.HOLD_POSE_DEADBAND_DEG * Math.PI / 180);
    const now = (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
    const doubleTap = this._lastStrutTap !== undefined
      && now - this._lastStrutTap < V5.STRUT_PUSH_WINDOW_MS;

    // Daughter-arm automation (arms-auto, item 5): a press is a manual override — each
    // commanded arm gets a marker; StrutAuto leaves it alone until 10 s after it ARRIVES.
    // Plain data writes only (the Salvage tests run this body on bare stub objects).
    const autoOn = Constants.FEATURE_FLAGS.STRUT_AUTO === true;
    if (autoOn) this._strutPress = (this._strutPress | 0) + 1;

    if (doubleTap) {
      this._lastStrutTap = undefined;               // one 90° per double tap
      for (const a of docked) {
        a._strutTargetAlpha = V5.STRUT_DEPLOY_ALPHA;
        if (autoOn) a._strutManual = { quietS: 0 };
      }
      _pressHolders(this, holders, V5.STRUT_DEPLOY_ALPHA, autoOn, docked.length === 0);
      return true;
    }

    this._lastStrutTap = now;
    const targetAlpha = anyOpen ? 0 : V5.STRUT_REST_ALPHA;
    for (const arm of docked) {
      arm._strutTargetAlpha = targetAlpha;
      if (autoOn) arm._strutManual = { quietS: 0 };
    }
    _pressHolders(this, holders, targetAlpha, autoOn, docked.length === 0);
    // FA4: this tap may be the first of a double press that lifts her to 90°; "stays at 34°" is said only when the window
    // has passed with no second press (ArmManager._tickStrutPressNote), not at once
    if (this.lastStrutPressNote) {
      this._pendingStrutNote = { text: this.lastStrutPressNote, leftS: V5.STRUT_PUSH_WINDOW_MS / 1000 };
      this.lastStrutPressNote = null;
    }
    return !anyOpen;
  }

  /**
   * The opening's SET (StartOpening, owner 2026-10-20 "on the player's first
   * action"): every DOCKED strut that is still closed goes to STRUT_REST_ALPHA
   * (34°). Never a toggle: a strut already open (live or pending past
   * STRUT_OPEN_THRESHOLD, e.g. the player's own "." press, even its 90° double
   * press) is left where it is, so the opening can never close what the player
   * just opened. It is not a player press: no `_strutPress` count, no
   * `_strutManual` 10 s hold (StrutAuto marks the arm opened from the latch and
   * rests it at 34° on its own), no tap-timer, no emit.
   * @returns {boolean|null} true = every docked strut is now open or opening;
   *   null when no DOCKED arm could take the write
   */
  restStruts() {
    const docked = (this.arms || []).filter((a) => a && a.state === ARM_STATES.DOCKED);
    if (!docked.length) return null;
    const V5 = Constants.OCTOPUS_V5;
    for (const arm of docked) {
      if (_strutLiveAlpha(arm) >= V5.STRUT_OPEN_THRESHOLD) continue;
      arm._strutTargetAlpha = V5.STRUT_REST_ALPHA;
    }
    return true;
  }

  /**
   * Read-only: the SAME predicate toggleStruts() decides from — true while any
   * DOCKED strut is past STRUT_OPEN_THRESHOLD, half the 34° rest angle (17°; a
   * pending latch counts, so the read flips the instant the toggle writes; the
   * REFIT chip re-reads truth, no optimism). No docked arm → false.
   * @returns {boolean}
   */
  strutsDeployed() {
    return (this.arms || []).some((a) =>
      a && a.state === ARM_STATES.DOCKED
      && _strutLiveAlpha(a) >= Constants.OCTOPUS_V5.STRUT_OPEN_THRESHOLD);
  }

  // ==========================================================================
  // V5 PULSE SCAN
  // ==========================================================================

  /**
   * Initiate pulse scan — all docked arms fire simultaneously as sensor nodes.
   * "Jellyfish pulse" — the signature move.
   * @returns {boolean} Success
   */
  pulseScan() {
    // Check cooldown
    if (this._pulseScanCooldown > 0) return false;

    // Collect all docked, charged arms
    const scanArms = this.arms.filter(a =>
      a.state === ARM_STATES.DOCKED && a.springCharged
    );

    if (scanArms.length < 2) return false; // Need at least 2 for triangulation

    // Fire all scan arms
    for (const arm of scanArms) {
      arm.startScan();
    }

    // Set cooldown
    this._pulseScanCooldown = PULSE_SCAN_COOLDOWN;

    eventBus.emit(Events.PULSE_SCAN_START, {
      armCount: scanArms.length,
    });

    // Schedule completion event
    this._pulseScanTimer = PULSE_SCAN_DURATION;
    this._pulseScanActive = true;

    return true;
  }

  // ==========================================================================
  // V5 FLEET-WIDE LAUNCH SPEED CONTROL
  // ==========================================================================

  /**
   * Set launch speed for all arms (the item-100 speed dial: `;` down / `'` up).
   * Emits LAUNCH_SPEED_CHANGED with the clamped fleet value so the HUD arms
   * panel + persistence see the truth after per-arm tier clamps.
   * @param {number} speed - m/s, clamped to tier limits
   */
  setFleetLaunchSpeed(speed) {
    for (const arm of this.arms) {
      arm.setLaunchSpeed(speed);
    }
    eventBus.emit(Events.LAUNCH_SPEED_CHANGED, { speed: this.getFleetLaunchSpeed() });
  }

  /**
   * Set launch speed for a specific arm.
   * @param {number} index - Arm index
   * @param {number} speed - m/s, clamped to tier limits
   */
  setArmLaunchSpeed(index, speed) {
    if (this.arms[index]) {
      this.arms[index].setLaunchSpeed(speed);
      eventBus.emit(Events.LAUNCH_SPEED_CHANGED, { speed: this.getFleetLaunchSpeed() });
    }
  }

  /**
   * The fleet launch speed (m/s): max across arms — all arms share the fleet
   * spring tier, so this is the dial's single truth for HUD + save.
   * @returns {number}
   */
  getFleetLaunchSpeed() {
    if (!this.arms || this.arms.length === 0) return Constants.CROSSBOW_LAUNCH_SPEED_DEFAULT;
    return Math.max(...this.arms.map((a) => a.launchSpeed));
  }

  // ==========================================================================
  // V5 FLEET-WIDE UPGRADE METHODS
  // ==========================================================================

  /**
   * Apply spring tier upgrade to all arms.
   * @param {number} tier - Spring tier index
   */
  applySpringUpgrade(tier) {
    for (const arm of this.arms) {
      arm.setSpringTier(tier);
    }
  }

  /**
   * Apply tether tier upgrade to all arms. This is the one hub for the line-fibre upgrade (DECISIONS §33 row 5): the
   * purchase, the save-load replay and the reset replay all land here, and the tier raises the tether length AND the
   * net capacities (Constants.TETHER_TIERS[tier].nets: mother / large daughter / small daughter).
   * Loaded nets stay loaded (the new cartridges arrive empty and fill at the stop); `fill` (the save-load replay)
   * loads every launcher full instead. Capacity never drops. No second listener anywhere.
   * @param {number} tier - Tether tier index
   * @param {{fill?: boolean}} [opts] fill = load every launcher to the new capacity (save-load path)
   */
  applyTetherUpgrade(tier, opts = {}) {
    for (const arm of this.arms) {
      arm.setTetherTier(tier);
    }
    const idx = Math.max(0, Math.min(Number.isFinite(tier) ? Math.floor(tier) : 0, Constants.TETHER_TIERS.length - 1));
    const nets = Constants.TETHER_TIERS[idx].nets;
    if (!nets) return;
    const fill = !!opts.fill;
    for (const arm of this.arms) {
      if (typeof arm.setNetCapacity !== 'function') continue;
      arm.setNetCapacity(arm.type === 'weaver' ? nets.large : nets.small, { fill });
    }
    const cns = this.playerSatellite && this.playerSatellite._captureNetSystem;
    if (cns && typeof cns.setMotherNetCapacity === 'function') cns.setMotherNetCapacity(nets.mother, { tier: idx, fill });
    const ps = this.playerSatellite;
    if (ps && typeof ps.setNetCellCount === 'function') ps.setNetCellCount(nets.mother);
  }

  // ==========================================================================
  // UPDATE
  // ==========================================================================

  /**
   * z-layer fix (A.6): add/remove each daughter's HULL (`arm.mesh`, a child of
   * `arm.group`) to the near-field depth pass based on its distance to the
   * mother, with hysteresis to avoid flip-flop mid-deploy.
   *
   * WHY the hull, not the whole group: everything the daughter renders lives on
   * `arm.mesh`; only the mother-spanning `arm.tetherLine` hangs on `arm.group`.
   * Registering `arm.mesh` brings the hull into the ×S near pass (so it depth-
   * tests correctly against the mother's strut-tip collars and is not occluded
   * by the depth clear) while LEAVING the tether on layer 0 (far pass) — a
   * tether can span from a near daughter out to far debris and must not be
   * scaled into the near sub-render. Because the ×S transform preserves screen
   * projection, the far-pass tether still lines up with the near-pass hull.
   *
   * Only daughters that overlap the mother on screen (i.e. are close) need this;
   * a deployed daughter far away renders fine in the far pass, so it leaves the
   * near set. Distances are in scene units (1 unit = 100 km; M = 1e-5 /m).
   *
   * @param {THREE.Vector3} parentPos mother world position (scene units)
   * @private
   */
  _updateNearFieldMembership(parentPos) {
    const sm = this._sceneManager;
    if (!sm || typeof sm.registerNearFieldRoot !== 'function' || !parentPos) return;

    const M = 1e-5;                 // 1 metre in scene units
    const INCLUDE_D = 10 * M;       // ≤ 10 m from mother → join near pass
    const EXCLUDE_D = 15 * M;       // ≥ 15 m → leave (hysteresis band avoids flip-flop)

    for (const arm of this.arms) {
      const hull = arm && arm.mesh;
      if (!hull) continue;
      const pos = arm.position || arm.group?.position;
      if (!pos) continue;

      const d = pos.distanceTo(parentPos);
      const isMember = arm._nearFieldMember === true;

      if (!isMember && d <= INCLUDE_D) {
        sm.registerNearFieldRoot(hull);
        arm._nearFieldMember = true;
      } else if (isMember && d >= EXCLUDE_D) {
        sm.unregisterNearFieldRoot(hull);
        arm._nearFieldMember = false;
      }
    }
  }

  /**
   * Update all arms.
   * @param {number} dt - Real-time delta in seconds
   */
  update(dt, opts) {
    const parentPos = this.playerSatellite.position || this.playerSatellite.mesh?.position || new THREE.Vector3();
    const parentQuat = this.playerSatellite.quaternion || null;

    // V5: Pulse scan cooldown tracking
    if (this._pulseScanCooldown > 0) {
      this._pulseScanCooldown -= dt;
      if (this._pulseScanCooldown < 0) this._pulseScanCooldown = 0;
    }

    // V5: Pulse scan completion timer
    if (this._pulseScanActive && this._pulseScanTimer !== undefined) {
      this._pulseScanTimer -= dt;
      if (this._pulseScanTimer <= 0) {
        this._pulseScanActive = false;
        // Gather scan results from all scanning arms
        const detections = []; // Would be populated by SensorSystem
        eventBus.emit(Events.PULSE_SCAN_COMPLETE, { detections });
      }
    }

    // Inject nearby debris data into trawling arms for auto-capture
    const passiveArms = this.arms.filter(a =>
      a.state === ARM_STATES.TRAWLING
    );
    if (passiveArms.length > 0 && this._debrisField) {
      const nearbyDebris = this._debrisField.getUntrackedDebrisNear
        ? this._debrisField.getUntrackedDebrisNear(parentPos, 0.05)  // 5km radius
        : [];
      // Also include tracked debris
      const tracked = this._debrisField.getTargetList ? this._debrisField.getTargetList() : [];
      // Resolve to CANONICAL debris objects by id (getTargetList /
      // getUntrackedDebrisNear hand back sparse/snapshot wrappers). Fishing &
      // web-shot capture store the picked object as their target/capturedDebris,
      // so they must hold the real field object — never a wrapper — to pin,
      // flag, and remove it correctly.
      const seen = new Set();
      const allDebris = [];
      const getById = this._debrisField.getDebrisById?.bind(this._debrisField);
      for (const w of [...tracked, ...nearbyDebris]) {
        if (!w || w.id == null || seen.has(w.id)) continue;
        seen.add(w.id);
        const canonical = getById ? getById(w.id) : w;
        if (canonical && canonical.alive !== false) allDebris.push(canonical);
      }
      for (const arm of passiveArms) {
        arm._nearbyDebris = allDebris;
      }
    }

    // Power distribution: arm beacon multiplier affects return speed
    // If beacon is offline (0%), returning/hauling arms move at 10% speed
    const armMult = powerDistribution.armMultiplier;
    const speedScale = armMult > 0 ? armMult : 0.1;

    // S8: digestion sun scale — 1.0 in sunlight, ECLIPSE_RATE in eclipse. Reads
    // the resource system's weather solar multiplier (0 = eclipse, 1.0 nominal,
    // 1.3 flare); flare does not overcook (concentrator saturation). Legacy
    // mocks without the getter cook at full rate (byte-identical pre-S8).
    const FTD = Constants.FURNACE_TRANSFER;
    const solarMult = (this._resourceSystem && typeof this._resourceSystem.getSolarPowerMultiplier === 'function')
      ? this._resourceSystem.getSolarPowerMultiplier()
      : 1.0;
    const digestSunScale = solarMult > 0 ? 1.0 : (FTD.TRANSIT_DIGEST_ECLIPSE_RATE ?? 1.0);

    // S13(c): the collar's digestion clock is the SAME law's mother-side
    // consumer (register item 47) — one multiplier SSOT, one per-frame write.
    const cns = this.playerSatellite && this.playerSatellite._captureNetSystem;
    if (cns) cns._digestSunScale = digestSunScale;

    for (const arm of this.arms) {
      // Pass speed scale for returning/hauling arms affected by beacon power
      arm._beaconSpeedScale = speedScale;
      arm._digestSunScale = digestSunScale;
      arm.update(dt, parentPos, parentQuat);
    }

    // reel-home (Decisions 5-7): the strut follows a daughter on the reels; the mother turns for her when nothing limits.
    this._updateReelHome(dt, parentPos, parentQuat);
    this._updateCarry(dt);
    this._tickMissionCarry(dt);
    this._tickStrutPressNote(dt);

    // Wave1: spin/amber the strut reel cartridges per live arm state.
    this._syncTetherDrums();

    // hold-catch (owner 2026-10-22; rebases S9 strut posing, register item 32):
    // a daughter holding a catch keeps her strut at her hold pose (34°, or the
    // lowest plume-clear 5° step, never above 100°) — also a strut the reel left
    // high comes down. Live, NOT flag-gated — this changes how the arm MOVES,
    // never what thrust refuses (THRUSTER_INTERLOCK stays dormant and
    // untouched). Runs AFTER arm.update so aim writes land on fresh positions.
    this._updateCargoPlumePoses(dt);

    // Task 7 (opening-dance plan) — lean-aside safety-net timeout tick.
    this._updateLeanAside(dt);

    // L2: a launch held back by the keep-out gate re-checks its line here.
    this._updateLaunchGates(dt);

    // arms-auto: the daughter arms mostly move themselves (flat idle, 34° near, ...).
    this._updateStrutAuto(dt, !!(opts && opts.noStrutAuto));

    // z-layer fix: toggle each daughter's hull in/out of the near-field depth
    // pass by distance to the mother (runs AFTER arm.update so positions are
    // current for this frame).
    this._updateNearFieldMembership(parentPos);

    // AUTHORITATIVE CATCH PIN (runs AFTER arms move, and after DebrisField.update
    // which ran earlier this frame): force each reeling/docking arm's captured
    // debris — looked up CANONICALLY by id — onto the arm's position, including
    // its rendered instance. This is the definitive fix for the "net + debris
    // drift ~600 m away and vanish during reel-in" bug, which was caused by the
    // debris the arm pinned not being the same object DebrisField rendered.
    if (this._debrisField && this._debrisField.pinCapturedDebris) {
      for (const arm of this.arms) {
        // S6: HOLDING_CATCH reads the parked cargo RACK (heldCatches); the haul
        // states (REELING/DOCKING) read the in-hand scalar — unchanged.
        const pieces = (arm.state === ARM_STATES.HOLDING_CATCH || _CARRY_STATES.has(arm.state))
          ? (arm.heldCatches || [])
          : (arm.capturedDebris ? [arm.capturedDebris] : null);
        if (!pieces || pieces.length === 0) continue;
        // PARK-THE-CATCH (2026-06-06): the catch stays FULL SIZE from reel-in,
        // through docking, and while parked on the strut (HOLDING_CATCH) — no
        // stow-shrink/removal any more (furnace transfer is deferred). The old
        // 1.0 → 0.15 dock shrink-then-remove read to the player as "the catch
        // vanishes when it reaches the mother".
        if (arm.state === ARM_STATES.REELING ||
            arm.state === ARM_STATES.DOCKING ||
            arm.state === ARM_STATES.HOLDING_CATCH ||
            _CARRY_STATES.has(arm.state) ||     // trip-melt-2: the rack rides along on the carry
            (arm.state === ARM_STATES.GRAPPLED && arm._rhPinned === true) ||   // reel-home: the net reel winds the pinned catch in
            (arm.state === ARM_STATES.GRAPPLED && arm._toolCatchRidesWithHer?.())) {   // nets-1b review 3: a pad/magnet/gripper catch rides with her in the hold
          for (const d of pieces) {
            if (!d) continue;
            // Item 1: once the staged furnace breakdown begins (debris._breakdownActive,
            // set by ArmUnit at chop start), shrink the ORIGINAL instanced catch out
            // of view so the FurnaceBreakdownVisual's chunk meshes are the only thing
            // the player sees being fed to the furnace. Ramp over the chop phase so
            // the swap reads as the catch coming apart, not popping out. S6: per
            // piece — only the rack's oldest (the piece being chopped) ramps.
            // Round 3 (2026-08-26, V5) — REVIEWED and deliberately left as-is:
            // unlike the collar chop (small-catch W3, which had NO covering
            // visual until the bag deflation), the rack chop is already
            // staged honest — FurnaceBreakdownVisual's chunk stream IS the
            // read, synchronized on the same _digestPhaseT clock, and this
            // ramp is its crossfade by design. (W1 net-reach D2, 2026-10-06:
            // the owner DID name the rack — "net vanishes at the daughter's
            // re-dock" — so the premise "the net stowed at NET_REEL_COMPLETED;
            // the strut holds cargo bare" no longer holds: CaptureNetVisual now
            // CARRIES the real bag on the catch through this chop, deflating on
            // the same FT.chopScaleMul ramp, and fades it at chop end. This
            // ramp itself is unchanged.)
            let scaleMul = 1;
            if (d._breakdownActive) {
              // Phase boundaries from the single authoritative constant (same keys
              // ArmUnit._updateHoldingCatch drives the chop with — no local defaults
              // that could desync the scale-out ramp from the chop window).
              // S8: the ramp reads the progress-derived phase time ArmUnit writes
              // (_digestPhaseT), falling back to stateTimer for legacy mocks.
              // Small-catch plan W3 (2026-08-25): the ramp expression moved to
              // FT.chopScaleMul — the ONE home shared with the collar chop and
              // the collar bag's deflation. Values byte-identical.
              const FT = Constants.FURNACE_TRANSFER;
              const phaseT = arm._digestPhaseT ?? arm.stateTimer;
              scaleMul = FT.chopScaleMul(phaseT);   // 1 → ~0 across the chop window
            }
            // Issue 13 (2026-06-12): honor the arm's standoff pin (_armPinPos =
            // arm.position + holdDir × clearance, set by _pinCatchToSelf) so the
            // catch hangs outboard of the daughter instead of being re-snapped
            // exactly onto her position (daughter rendered INSIDE large catches).
            const pinPos = (d._armPinned && d._armPinPos) ? d._armPinPos : arm.position;
            this._debrisField.pinCapturedDebris(d, pinPos, scaleMul);
          }
        }
      }
    }
  }

  // ==========================================================================
  // trip-melt-2 "carry" — a daughter takes the catch on her rack to her radiator's tip furnace (ArmUnit.beginCarry)
  // ==========================================================================

  /** @returns {boolean} some daughter is on a carry (any CARRY state) */
  isCarrying() {
    for (const a of this.arms) if (a && a.isCarrying) return true;
    return false;
  }

  /** The gate's size row of a catch: the row of `PLUME_CARGO_ALPHA_LADDER` its `sizeMeter` falls in (unknown size: the deepest). */
  carryRowOf(debris) {
    const ladder = Constants.PLUME_CARGO_ALPHA_LADDER || [];
    const s = debris && debris.sizeMeter > 0 ? debris.sizeMeter : Infinity;
    for (let i = 0; i < ladder.length; i++) if (s <= ladder[i].maxSizM) return i;
    return Math.max(0, ladder.length - 1);
  }

  /**
   * The gate entry for a daughter's carry: `Constants.CARRY.GATE[pair]['<row>|<cell>']` = {strutDeg, thetaDeg} or
   * absent/null (no pose clears that row: it never carries). Generated offline (js/test/fixtures/carry-gate.json).
   * @param {ArmUnit} arm
   * @param {number} row size row (the larger of the pieces she holds)
   * @param {number} cell the delivered piece's rack cell
   * @returns {{strutDeg:number, thetaDeg:number}|null}
   */
  carryGateFor(arm, row, cell) {
    const G = Constants.CARRY && Constants.CARRY.GATE;
    const pair = G && G[arm.config.type];
    const e = pair && pair[`${row}|${cell}`];
    return e || null;
  }

  /** The carry is certified for the dock ring the quad has (4 daughters at its azimuths): any other layout never carries. @private */
  _carryLayoutOk() {
    const want = Constants.ARM_LADDER && Constants.ARM_LADDER.Y0_QUAD && Constants.ARM_LADDER.Y0_QUAD.azimuths;
    if (!want || this.arms.length !== want.length) return false;
    for (let i = 0; i < want.length; i++) {
      const a = this.arms[i];
      if (!a || Math.abs((a._azimuthDeg ?? NaN) - want[i]) > 1e-6) return false;
    }
    return true;
  }

  /**
   * petal-single (Decisions 4, 7d): the conditions the gate table was certified for that can change while a daughter waits
   * or carries - the other three petals standing in a certified shared-angle range and not on their way out of it, the
   * other three struts within `NEIGHBOUR_TOL_DEG` of their rest angle - or of their own HOLD POSE when they hold a catch (hold-catch FA3) -
   * and no neighbour holding a catch the carry path was not measured clear of (`NEIGHBOUR_CATCH_MAX_SIZE_M`, or any measured size when the
   * neighbour stands at `NEIGHBOUR_CATCH_HIGH_POSE_DEG` or higher), and her own recorded strut angle inside the swept range.
   * Read-only. `null` = all hold, else `{reason, text}` (every one of them clears by waiting) - except a 'neighbour-catch' whose
   * blocking catch fits no radiator tip: that one carries `never: true` (hold-catch FA6; it leaves her rack by no hand-off).
   * @param {ArmUnit} arm
   * @returns {null|{reason:string, text:string, never?:boolean}}
   */
  carryConditions(arm) {
    const V = Constants.CARRY;
    const ps = this.playerSatellite;
    const n = arm.index + 1;
    const R2D = 180 / Math.PI;
    const inRange = (deg) => V.OTHERS_RANGES_DEG.some(([lo, hi]) => deg >= lo - 1e-6 && deg <= hi + 1e-6);
    const sharedDeg = (ps._flowerThetaRad ?? 0) * R2D;
    const targetDeg = Number.isFinite(ps._flowerTargetTheta) ? ps._flowerTargetTheta * R2D : sharedDeg;
    if (!inRange(sharedDeg) || !inRange(targetDeg)) {
      return { reason: 'radiators-moving', text: `The radiators are not settled. Daughter ${n} waits.` };
    }
    for (const o of this.arms) {
      if (!o || o === arm || typeof o.getAimAlpha !== 'function') continue;
      const oDeg = o.getAimAlpha() * R2D;
      const held = Array.isArray(o.heldCatches) ? o.heldCatches.filter((h) => h && h.mass) : [];
      if (Math.abs(oDeg - V.NEIGHBOUR_REST_DEG) > V.NEIGHBOUR_TOL_DEG + 1e-6) {
        // hold-catch FA3: a neighbour holding a catch stands at her HOLD POSE (34..100 deg), which is where she belongs: accepted
        // (the carry was measured against it, see Constants.CARRY.NEIGHBOUR_CATCH_MAX_SIZE_M). Anywhere else (a "." press, a strut on its
        // way) is out of place, as before.
        const hp = held.length ? this._holdPoseCached(o, this.arms.indexOf(o), 0) : null;
        if (!hp || Math.abs(oDeg - hp.rad * R2D) > V.NEIGHBOUR_TOL_DEG + 1e-6) {
          return { reason: 'neighbour-strut', text: `Daughter ${o.index + 1}'s strut is out of place. Daughter ${n} waits.` };
        }
      }
      // ... and the catch on her nose is an obstacle the gate never saw: only catches the measurement cleared pass (Constants.CARRY)
      const high = oDeg >= V.NEIGHBOUR_CATCH_HIGH_POSE_DEG - V.NEIGHBOUR_TOL_DEG - 1e-6;
      const blocking = held.filter((h) => !(h.sizeMeter <= V.NEIGHBOUR_CATCH_MAX_SIZE_M + 1e-9
          || (high && h.sizeMeter <= V.NEIGHBOUR_CATCH_HIGH_MAX_SIZE_M + 1e-9)));
      if (blocking.length) {
        // hold-catch FA6: a blocking catch that does not fit a radiator tip never leaves her rack by a hand-off, so waiting does not help
        // (`never`: carryCheck answers retry:false; the trip's end rule stops waiting for it, and "Press C" says this plain reason)
        const tc = ps && ps.tipCargo;
        const never = !!(tc && typeof tc.fits === 'function' && blocking.some((h) => !tc.fits(DebrisField.trueReachM(h, 0))));
        return { reason: 'neighbour-catch', never, text: `Daughter ${o.index + 1}'s catch is too close to Daughter ${n}'s path. Daughter ${n} keeps hers.` };
      }
    }
    const recDeg = typeof arm.getAimAlpha === 'function' ? arm.getAimAlpha() * R2D : NaN;
    if (!(recDeg >= V.STRUT_REC_LO_DEG - 1e-6 && recDeg <= V.STRUT_REC_HI_DEG + 1e-6)) {
      return { reason: 'strut-range', text: '' };
    }
    return null;
  }

  /**
   * Can this daughter start a carry now? Reads, changes nothing. `retry` tells the trip whether waiting can help: a
   * catch that does not fit a tip, a row the gate does not allow and a daughter without the fuel never carry; a busy
   * tip, another carry, a hand-off under way, radiators or neighbour struts that are not where the gate was certified end by
   * themselves. `giveUp` (petal-single, Decision 7e): the answer cannot change by waiting at all (the dock layout, the catch
   * does not fit, the row is not allowed, no tip record): the scheduler marks her so it stops asking until something changes.
   * 'swing-back' (review R8) waits too: the catch is bigger than the gate certified for the radiators' present range (closed/open).
   * `mission`: outside a trip - the leash's mission conditions also apply (the ship is not turning or holding a heading, no
   * daughter is leaving, time is not held) and a launch request for her blocks it.
   * `motherNetOnly` (hold-catch FA1): refuse ('own-catch') unless the piece it would deliver was put on the rack by the mother's
   * net (`_rackFromMotherNet`, set where CaptureNet's cargo flight lands): the mission scheduler's rule.
   * @param {ArmUnit} arm
   * @param {{mission?:boolean, motherNetOnly?:boolean}} [opts]
   * @returns {{ok:boolean, reason:string, text:string, retry:boolean, giveUp:boolean, plan?:object}}
   */
  carryCheck(arm, opts = {}) {
    const S = ARM_STATES;
    const mission = opts.mission === true;
    const motherNetOnly = opts.motherNetOnly === true;
    const no = (reason, text = '', retry = true, giveUp = false, sayKey = '') => ({ ok: false, reason, text, retry, giveUp, sayKey });
    if (!arm || arm.isDetached || (arm.state !== S.HOLDING_CATCH && arm.state !== S.DOCKED)) return no('state', '', false);
    if (arm._carryGaveUp) return no('gave-up', '', false);          // her last carry failed on its own: not again until something changes
    const rack = Array.isArray(arm.heldCatches) ? arm.heldCatches.filter(Boolean) : [];
    if (rack.length === 0) return no('no-catch', '', false);
    const ps = this.playerSatellite;
    const tc = ps && ps.tipCargo;
    if (!tc || typeof ps.holdPetalForHandoff !== 'function' || typeof arm.beginCarry !== 'function') return no('no-tip', '', false, true);
    if (!this._carryLayoutOk()) return no('layout', '', false, true);
    const n = arm.index + 1;
    // the delivered piece is the outermost one (cell 1 leads when she holds two: cell 0's cannot pass it)
    let delivered = rack[0];
    const cellOf = (d, i) => (Number.isInteger(d._rackCell) ? d._rackCell : i);
    for (let i = 1; i < rack.length; i++) if (cellOf(rack[i], i) > cellOf(delivered, 0)) delivered = rack[i];
    // hold-catch FA1 (owner 2026-10-22 "Keep: radiator right away"): the mission scheduler asks only for catches the MOTHER's net
    // put on this rack (it could not reach a tip at once); a catch the daughter caught herself stays with her ('own-catch' is
    // not a refusal worth a line, and not a give-up: "Press C" asks without this option).
    if (motherNetOnly && !delivered._rackFromMotherNet) return no('own-catch', '', false);
    const cell = Math.max(0, Math.min(1, cellOf(delivered, rack.indexOf(delivered))));
    const reach = DebrisField.trueReachM(delivered, 0);
    if (!tc.fits(reach)) {
      return no('fit', `Daughter ${n}'s catch is too big for a radiator tip. It stays on her rack.`, false, true);
    }
    let row = 0;
    for (const d of rack) row = Math.max(row, this.carryRowOf(d));
    const gate = this.carryGateFor(arm, row, cell);
    if (!gate) {
      return no('gate', `Daughter ${n} cannot carry this catch to a furnace without touching the ship. It stays on her rack.`, false, true);
    }
    const tipIndex = arm.index;                               // her radiator: the tip on her line (DECISIONS §29 row 4)
    const fuelPct = typeof arm.carryFuelPct === 'function' ? arm.carryFuelPct() : 0;
    if (!(arm.fuel >= fuelPct)) {
      return no('fuel', `Daughter ${n} has too little fuel to carry her catch. It stays on her rack.`, false);
    }
    if (this.isCarrying()) return no('carry-busy');
    const drv = ps.leashDriver || (this.player && this.player.leashDriver) || null;
    // ANY petal on its own (a hand-off, or one still swinging back from one) or a launch fold blocks it
    if (ps.flowerPetalsBusy || ps.flowerLaunchLocked || (drv && drv.busy)) {
      return no('leash-busy', 'The radiators are busy with another catch. She waits.');
    }
    if (mission) {
      if (this._pendingLaunches && this._pendingLaunches.has(arm.index)) return no('launch-pending');
      const why = drv && typeof drv.refusal === 'function' ? drv.refusal(null) : null;
      if (why) return no(`mission-${why.key}`);
    }
    if (tc.debrisAt(tipIndex) || (typeof tc.isReserved === 'function' && tc.isReserved(tipIndex))) {
      return no('tip-busy', `Radiator ${tipIndex + 1}'s furnace is busy. Daughter ${n} waits.`);
    }
    const cond = this.carryConditions(arm);
    if (cond) return no(cond.reason, cond.text, !cond.never);
    // review R8: no carry starts whose swing BACK (her petal released, the catch in the tip bag, past her strut, her body, the hull
    // and the other petals) is not certified 0.15 m. The gate measured the largest catch reach each range of the radiators
    // allows (closed: the bag passes her own strut close; open: far); a bigger catch waits for the other range - it clears by itself.
    {
      const V = Constants.CARRY;
      const sharedDeg = (ps._flowerThetaRad ?? 0) * 180 / Math.PI;
      const closed = sharedDeg <= V.OTHERS_RANGES_DEG[0][1] + 1e-6;                      // [0, 1] deg = closed, [133, 146] = open (carryConditions)
      const limit = gate.swingBackReachM ? gate.swingBackReachM[closed ? 'closed' : 'open'] : 0;
      if (!(reach <= limit + 1e-9)) {
        return no('swing-back',
          closed
            ? `Daughter ${n}'s catch is too big to hand over while the radiators are closed. She waits for them to open.`
            : `Daughter ${n}'s catch is too big to hand over while the radiators are open. She waits for them to close.`,
          true, false, `${arm.index}|swing-back|${delivered.id ?? delivered.sizeMeter}`);
      }
    }
    return {
      ok: true, reason: '', text: '', retry: false, giveUp: false,
      plan: {
        tipIndex, cell, delivered, row, mission,
        strutRad: gate.strutDeg * Math.PI / 180, thetaRad: gate.thetaDeg * Math.PI / 180, dir: gate.dir,
        recordedStrutRad: typeof arm.getAimAlpha === 'function' ? arm.getAimAlpha() : gate.strutDeg * Math.PI / 180,
      },
    };
  }

  /**
   * Start a carry for `arm` if `carryCheck` allows it. A start the daughter itself refuses (no tip record) is a give-up.
   * @param {ArmUnit} arm
   * @param {{mission?:boolean}} [opts]
   * @returns {{ok:boolean, reason:string, text:string, retry:boolean, giveUp:boolean}} the check's answer (ok: she is in CARRY_PREP)
   */
  requestCarry(arm, opts = {}) {
    const c = this.carryCheck(arm, opts);
    if (!c.ok) return c;
    if (!arm.beginCarry(c.plan)) {
      arm._carryGaveUp = true;
      return { ok: false, reason: 'refused', text: '', retry: false, giveUp: true };
    }
    return c;
  }

  /**
   * One look of a carry scheduler: start the first daughter that can carry (first free tip first, ties by daughter index).
   * A refusal that cannot clear by waiting marks her (`_carryGaveUp`: the scheduler stops asking); the ones worth a line say it
   * once per `said` key. The trip calls it on its own cadence while it burns. (Outside a trip nothing calls it any more:
   * hold-catch, owner 2026-10-22 — a daughter keeps her catch; "Press C" -> `moveCatchToRadiator` starts one.)
   * @param {{mission?:boolean, motherNetOnly?:boolean, say?:function(string):void, said?:object}} [o]
   * @returns {ArmUnit|null} the daughter that started
   */
  scheduleCarry({ mission = false, motherNetOnly = false, say = null, said = null } = {}) {
    const tc = this.playerSatellite && this.playerSatellite.tipCargo;
    const tipTaken = (a) => (tc && typeof tc.debrisAt === 'function' && tc.debrisAt(a.index) ? 1 : 0);
    const arms = this.arms.filter((a) => a && !a.isDetached);
    arms.sort((a, b) => tipTaken(a) - tipTaken(b) || a.index - b.index);
    for (const arm of arms) {
      const r = this.carryCheck(arm, { mission, motherNetOnly });
      if (r.ok) {
        if (this.requestCarry(arm, { mission, motherNetOnly }).ok) return arm;
        continue;
      }
      if (r.giveUp) arm._carryGaveUp = true;
      // (FA6: a neighbour's catch that can never leave is said too - once - or the catch just stays on her rack in silence)
      const sayIt = say && r.text && (r.reason === 'fit' || r.reason === 'gate' || r.reason === 'fuel' || r.reason === 'swing-back'
        || (r.reason === 'neighbour-catch' && !r.retry));
      if (sayIt) {
        const key = r.sayKey || `${arm.index}|${r.reason}`;                  // swing-back: once per catch
        if (said && !said[key]) { said[key] = true; say(r.text); }
      }
    }
    return null;
  }

  /**
   * The trip phase the mission tick (_tickMissionCarry) stands aside for: 'wait' (the trip waits for the daughters: no new carry), 'burn'
   * (the trip's own scheduler) or null (a mission). Set by TransferTrip.
   * @param {string|null} phase
   */
  setTripPhase(phase) {
    this._tripPhase = phase || null;
    // hold-catch FA7: the lines already said (a hand-off refusal, "too big for a tip") start over after a trip, as on main
    if (!this._tripPhase) { this._missionCarryAgeS = 0; this._missionTipsTaken = null; this._missionCarrySaid = Object.create(null); this._allFullSaid = false; }
  }

  /**
   * hold-catch (owner 2026-10-22: "daughters that catch debris should hold it ... Transfer to radiator strut is risky,
   * should be an option when all daughters are full, not automatic"): outside a trip a daughter KEEPS the catch she made. The
   * petal-single scheduler that started a hand-off by itself every `MISSION_CHECK_S` now asks only for a catch the MOTHER's net
   * put on a rack because no radiator tip was free (`_rackFromMotherNet`, set where CaptureNet's cargo flight lands; owner
   * "Keep: radiator right away"): it goes to a tip as soon as one is, as before. The rest is bookkeeping (a give-up clears when
   * she leaves the dock or any tip frees, so a later "Press C" can try again) and the one line that tells the player the choice
   * is his: when every daughter is aboard holding a catch, say it once (`_sayAllFull`). The mother's OWN nose catches are not here:
   * CaptureNet._tryLeash -> LeashDriver send them to a free radiator tip right away, as before. On a trip
   * `TransferTrip._tickCarry` owns the hand-offs (`_tripPhase` set), automatic as before.
   * @private
   */
  _tickMissionCarry(dt) {
    if (this._tripPhase || !(dt > 0)) return;
    const V = Constants.CARRY;
    this._missionCarryAgeS = (this._missionCarryAgeS || 0) + dt;
    if (this._missionCarryAgeS < (V.MISSION_CHECK_S ?? 1)) return;
    this._missionCarryAgeS = 0;
    const said = this._missionCarrySaid || (this._missionCarrySaid = Object.create(null));
    const tc = this.playerSatellite && this.playerSatellite.tipCargo;
    // something changed that could let a refused carry through: a tip freed, or the daughter went out and came back
    let taken = 0;
    for (let i = 0; i < 4; i++) if (tc && typeof tc.debrisAt === 'function' && tc.debrisAt(i)) taken |= (1 << i);
    const freed = this._missionTipsTaken != null && (this._missionTipsTaken & ~taken) !== 0;
    this._missionTipsTaken = taken;
    for (const a of this.arms) {
      if (!a) continue;
      const home = a.state === ARM_STATES.DOCKED || a.state === ARM_STATES.HOLDING_CATCH;
      if (freed || !home) {
        if (a._carryGaveUp) a._carryGaveUp = false;
        for (const k of Object.keys(said)) if (k.startsWith(`${a.index}|`) && !k.includes('|swing-back|')) delete said[k];   // (swing-back: once per catch, its key names the catch)
      }
    }
    // FA1: a catch the mother's net racked goes to a free radiator tip by itself (a daughter's own never does)
    if (this.arms.some((a) => a && !a._carryGaveUp && Array.isArray(a.heldCatches) && a.heldCatches.some((h) => h && h._rackFromMotherNet)
        && (a.state === ARM_STATES.DOCKED || a.state === ARM_STATES.HOLDING_CATCH))) {
      this.scheduleCarry({
        mission: true, motherNetOnly: true, said,
        say: (text) => eventBus.emit(Events.COMMS_MESSAGE, { text, priority: 'info' }),
      });
    }
    this._sayAllFull();
  }

  /**
   * hold-catch FA2: all full -> ONE line, and "Press C" only when C can work. Every daughter's hand-off outlook is read through
   * `carryCheck` (a mission carry): 'now' = it would start now (fits a tip, its tip is free, the gate allows it); 'later' = waiting
   * can help (a busy tip, the radiators or the ship are moving); 'never' = it cannot go (too big for a tip, no gate row, no fuel).
   * Said once per time they become full; "Press C" is said once more if the first line had to leave it out and a hand-off then
   * becomes possible. No catch that fits -> the daughters are full and the line says nothing about C. Re-armed when one is not full.
   * @private
   */
  _sayAllFull() {
    if (!this.allDaughtersFull()) { this._allFullSaid = false; return; }
    let now = 0, later = 0;
    for (const a of this.arms) {
      if (!a || a.isDetached || a.state === ARM_STATES.EXPENDED) continue;
      const o = this._handoffOutlook(a);
      if (o === 'now') now++; else if (o === 'later') later++;
    }
    const key = now ? 'press' : (later ? 'full' : 'never');
    if (this._allFullSaid && !(key === 'press' && this._allFullSaid !== 'press')) return;
    this._allFullSaid = key;
    const text = key === 'press' ? 'All daughters are holding catches. Press C to move one to a radiator.'
      : key === 'full' ? 'All daughters are holding catches.'
      : 'All daughters are holding catches, and none of them can go to a radiator.';
    eventBus.emit(Events.COMMS_MESSAGE, { text, priority: 'info' });
  }

  /**
   * hold-catch FA2: can this daughter's catch go to a radiator tip - now, later, or never? Read-only (`carryCheck`, a mission carry).
   * 'gave-up' counts as 'later': "Press C" clears it and asks again.
   * @param {ArmUnit} arm
   * @returns {'now'|'later'|'never'}
   */
  _handoffOutlook(arm) {
    const r = this.carryCheck(arm, { mission: true });
    if (r.ok) return 'now';
    return (r.retry || r.reason === 'gave-up') ? 'later' : 'never';
  }

  /** hold-catch FA4: a "." line held back for the double-press window is said once the window has passed with no second press. @private */
  _tickStrutPressNote(dt) {
    const p = this._pendingStrutNote;
    if (!p || !(dt > 0)) return;
    p.leftS -= dt;
    if (p.leftS > 0) return;
    this._pendingStrutNote = null;
    eventBus.emit(Events.COMMS_MESSAGE, { source: 'SPACECRAFT', channel: 'CMD', text: p.text, priority: 'info' });
  }

  /**
   * hold-catch: true when every daughter that can still fly (not detached, not expended) is aboard holding a catch, and at
   * least one is: none can launch for a new catch. A daughter on a carry is not "holding" (she is busy moving one).
   * @returns {boolean}
   */
  allDaughtersFull() {
    let n = 0;
    for (const a of this.arms) {
      if (!a || a.isDetached || a.state === ARM_STATES.EXPENDED) continue;
      const holds = a.state === ARM_STATES.HOLDING_CATCH && Array.isArray(a.heldCatches) && a.heldCatches.some((h) => h);
      if (!holds) return false;
      n++;
    }
    return n > 0;
  }

  /**
   * hold-catch (owner 2026-10-22, "Press C"): the player's choice to move ONE daughter's catch to a radiator tip, only when
   * every daughter is full. Starts one hand-off through the same `carryCheck` / `requestCarry` / `beginCarry` path the trip
   * uses (a mission carry: the hand-off ends with "puts her catch on radiator N's tip; she is free again"). The selected
   * daughter if she holds a catch, else the first holding one that can go (lowest number first; if none can, the first one's
   * reason is the line). Never on a trip (the trip hands them off by itself), never while a hand-off runs, never while a
   * daughter is free. Every outcome that moves nothing says why, in one comms line.
   * @param {number} [selectedIndex] the selected daughter's index (-1 / undefined: none)
   * @returns {{ok:boolean, text:string, arm?:object}}
   */
  moveCatchToRadiator(selectedIndex) {
    const S = ARM_STATES;
    const finish = (r) => {
      if (r.text) eventBus.emit(Events.COMMS_MESSAGE, { text: r.text, priority: 'info' });
      return r;
    };
    if (this._tripPhase) {
      return finish({ ok: false, text: 'The daughters hand their catches to the radiators by themselves on the trip.' });
    }
    const arms = (this.arms || []).filter((a) => a && !a.isDetached && a.state !== S.EXPENDED);
    const holders = arms.filter((a) => a.state === S.HOLDING_CATCH && Array.isArray(a.heldCatches) && a.heldCatches.some((h) => h));
    if (this.isCarrying()) return finish({ ok: false, text: 'A hand-off is already running.' });
    if (holders.length === 0) return finish({ ok: false, text: 'No daughter is holding a catch.' });
    const free = arms.find((a) => !holders.includes(a));
    if (free) {
      const away = free.state !== S.DOCKED && free.state !== S.RELOADING;
      return finish({ ok: false, text: `Daughter ${free.index + 1} is ${away ? 'out' : 'free'}; catches stay with the daughters until all are full.` });
    }
    const sel = Number.isInteger(selectedIndex) && selectedIndex >= 0 ? holders.find((a) => a.index === selectedIndex) : null;
    const order = sel ? [sel] : holders.slice().sort((a, b) => a.index - b.index);
    // FA2: with nobody selected, the line names the first daughter whose hand-off can still happen (waiting helps), not a
    // catch that never fits a tip while another one only waits for her tip
    let first = null;
    for (const arm of order) {
      arm._carryGaveUp = false;                              // he asked: a give-up from an earlier try does not count
      const r = this.carryCheck(arm, { mission: true });
      if (r.ok) {
        const started = this.requestCarry(arm, { mission: true });
        if (started.ok) {
          const tip = (arm._carry && Number.isInteger(arm._carry.tipIndex)) ? arm._carry.tipIndex : arm.index;
          return finish({ ok: true, arm, text: `Daughter ${arm.index + 1} takes her catch to radiator ${tip + 1}.` });
        }
        if (!first || !first.r.retry) first = { arm, r: started };
        continue;
      }
      if (!first || (!first.r.retry && r.retry)) first = { arm, r };
    }
    return finish({ ok: false, text: this._carryRefusalText(first.arm, first.r) });
  }

  /** @private one plain sentence for a `carryCheck` refusal that has no text of its own */
  _carryRefusalText(arm, r) {
    if (r && r.reason === 'fit') return `Daughter ${arm.index + 1}'s catch is too big for a radiator tip; she keeps it.`;
    if (r && r.text) return r.text;
    const n = arm.index + 1;
    switch (r && r.reason) {
      case 'carry-busy': return 'A hand-off is already running.';
      case 'mission-turning': return `The ship is turning or holding a heading, so Daughter ${n} waits. Try again when it stops.`;
      case 'mission-daughter': return `A daughter is leaving the ship, so Daughter ${n} waits.`;
      case 'mission-radiators': return `The radiators are busy, so Daughter ${n} waits. Try again in a moment.`;
      case 'mission-world': return 'Time is held.';
      case 'mission-busy': return `One catch is already on its leash, so Daughter ${n} waits.`;
      case 'strut-range': return `Daughter ${n}'s strut is still moving. Try again in a moment.`;
      case 'no-tip': case 'layout': return 'This ship cannot move catches to a radiator.';
      default: return `Daughter ${n} cannot move her catch right now.`;
    }
  }

  /** A new trip: every daughter may try a carry again (`_carryGaveUp` cleared). */
  resetCarryGiveUps() {
    for (const a of this.arms) if (a) a._carryGaveUp = false;
  }

  /** Stop every carry now (game over, reset, load, the trip's hard cap). @returns {number} how many were running */
  abortAllCarries(why = 'abort') {
    let n = 0;
    for (const a of this.arms) if (a && a.isCarrying && a.abortCarry(why)) n++;
    return n;
  }

  /**
   * Can any rack catch still be carried - now, or once her tip frees / the hand-off ends / the bag in the way melts?
   * The trip's end rule waits for it. A catch that never carries (too big for a tip, a row the gate does not allow, no
   * fuel: fuel does not come back on the trip) does not count.
   * @returns {boolean}
   */
  rackCanCarry() {
    for (const a of this.arms) {
      if (!a || a.isDetached || !Array.isArray(a.heldCatches) || a.heldCatches.length === 0) continue;
      const r = this.carryCheck(a);
      if (r.ok || r.retry) return true;
    }
    return false;
  }

  /**
   * Per frame: a daughter in CARRY_PREP whose strut has nobody to slew it (a headless rig with no strut groups) is
   * slewed here, as reel-home does. In the game `PlayerSatellite._updateStruts` slews to `_strutTargetAlpha`.
   * @private
   */
  _updateCarry(dt) {
    const headless = !(this.playerSatellite && this.playerSatellite.strutGroups);
    if (!headless) return;
    for (const a of this.arms) {
      if (!a || !a._carry || a.state !== ARM_STATES.CARRY_PREP || typeof a.setAimAlpha !== 'function') continue;
      const t = a._carry.strutRad;
      a.setAimAlpha(t, dt);
      if (Math.abs(a.getAimAlpha() - t) < 0.01) a._strutTargetAlpha = undefined;
    }
  }

  // ==========================================================================
  // reel-home — the strut follows a daughter on the reels, the mother turns to meet her line
  // ==========================================================================

  /**
   * reel-home (Decisions 5, 6). For every daughter on the reels (her net winding the catch in, or on the strut line):
   *  - the strut's target angle follows her (the swing-plane angle nearest the direction hinge -> her, clamped to
   *    REEL_HOME.STRUT_MIN_DEG..STRUT_MAX_DEG, at the existing slew rate); the strut is `_aimReserved` so StrutAuto
   *    leaves it alone (the arm releases it when it leaves the reels);
   *  - the mother turns to bring her into the strut's swing plane when she is off it by more than PLANE_TOL_DEG and
   *    nothing limits the mother (`_motherTurnBlock(arm)`). One daughter owns the turn at a time, first come.
   * Off with the flag.
   * @private
   */
  _updateReelHome(dt, parentPos, parentQuat) {
    const on = Constants.isFeatureEnabled('REEL_HOME');
    const RH = Constants.REEL_HOME || {};
    const D2R = Math.PI / 180;
    const headless = !(this.playerSatellite && this.playerSatellite.strutGroups);
    const homers = [];
    for (const arm of this.arms) {
      if (!arm) continue;
      const home = on && arm.isReelingHome === true && !arm.isDetached;
      if (!home) {
        arm._rhSeq = 0;
        arm._rhMotherWorking = false;
        arm._rhGapFn = null;
        continue;
      }
      if (!arm._rhSeq) arm._rhSeq = ++this._rhSeq;
      homers.push(arm);
      // Decision 5: the strut points at her
      if (Number.isFinite(arm._rhBestAlpha)) {
        const a = Math.max((RH.STRUT_MIN_DEG ?? 34) * D2R, Math.min((RH.STRUT_MAX_DEG ?? 180) * D2R, arm._rhBestAlpha));
        if (!arm._aimReserved) { arm._aimReserved = true; arm._rhReserved = true; }
        arm._strutTargetAlpha = a;
        if (headless && typeof arm.setAimAlpha === 'function') {
          arm.setAimAlpha(a, dt);                                       // production slews once, in _updateStruts
          if (Math.abs(arm.getAimAlpha() - a) < 0.01) arm._strutTargetAlpha = undefined;
        }
      }
      if (!arm._rhGapFn) arm._rhGapFn = (pos, pp, pq) => this._rhGapAt(arm, pos, pp, pq);
    }
    this._tickReelHomeTurn(homers, parentQuat, dt);
  }

  /**
   * reel-home (Decision 6): who turns the mother, and when. The earliest daughter on the reels owns the turn until she
   * leaves them (docks, loses her catch, ...); the next in line takes it then. The owner asks for a turn when she is off
   * the strut's swing plane by more than PLANE_TOL_DEG, or (once in the plane) below the strut's STRUT_MIN_DEG..STRUT_MAX_DEG
   * range by more than that; the mother is free (`_motherTurnBlock(owner)`) and the turn is
   * not bigger than TURN_MAX_DEG; each request is one scripted attitude turn (the same one the leash hand-off uses), and
   * the geometry is re-read when it ends. A request is made at most once per TURN_RETRY_S (a refusal counts), so a mother
   * who was busy at the first look is asked again a second later, not never; the autopilot being engaged ends a running
   * turn (it steers the ship back to its own heading, so she lines herself up). The turn axis has no component along the
   * nose (the ship has almost no roll authority): for the plane error it is the strut's radial direction; for the range
   * error it is the plane's normal t, the angle that brings her to the nearer end of the range.
   * reel-turn (owner 2026-10-21, "strange oscillations ... not good"): the PLANE turn is closed loop. It is a tracked turn
   * (`requestAttitudeTurn` with `opts.track`): every frame `_rhTrackPlane` reads the angle left from her live place relative
   * to the ship's centre (`planeTurnLeftRad`: the turning axis runs through the centre, the strut hinge hangs ~1 m off it),
   * and the autopilot's rate law (√(2·α·left), α = the couples' own, at most the 5°/s peak) brakes to rest on it. It starts
   * beyond PLANE_TOL_DEG and ends inside half of it (hysteresis), or when her lever on the axis is gone (more than
   * TURN_MAX_DEG left). Before, the angle was fixed once while she was ~13 m out: she reeled in during the 8-11 s turn, the
   * same rotation moved her plane angle 1.3-1.4x as far near the strut, the turn overshot, the next request reversed it, and
   * the reel went hold -> pull -> hold -> pull (up to 7 toggles). The range turn is still one fixed profile.
   * `_rhMotherWorking` tells each daughter whether the mother is turning (or may still be asked to) for her.
   * @private
   */
  _tickReelHomeTurn(homers, parentQuat, dt = 0) {
    const RH = Constants.REEL_HOME || {};
    const D2R = Math.PI / 180;
    // the owner: the earliest arrival still on the reels
    let owner = null;
    for (const a of homers) if (!owner || a._rhSeq < owner._rhSeq) owner = a;
    this._rhOwner = owner;
    for (const a of homers) {
      a._rhMotherWorking = false;
      if (a._rhTurnWaitS > 0) a._rhTurnWaitS = Math.max(0, a._rhTurnWaitS - dt);
    }
    if (this._rhTurn && this._rhTurn.arm !== owner) this._rhAbortTurn();     // its daughter has left the reels
    const apNow = this._autopilot;
    // D11b: the autopilot engaged while the turn runs. It steers the ship back to its own heading, so the turn is cancelled
    // and she lines herself up (the check before a request, `_motherTurnBlock`, then keeps new ones away).
    if (this._rhTurn && apNow && apNow.engaged === true) this._rhAbortTurn();
    if (this._rhTurn && apNow && typeof apNow.isTurning === 'function' && !apNow.isTurning()) {
      this._rhEndTurn(apNow);                                                  // the turn is over: let the attitude go
    }
    if (!owner) return;
    if (this._rhTurn) { owner._rhMotherWorking = true; return; }             // her turn is running
    if (owner._rhTurnWaitS > 0) return;                                       // D11a: asked a moment ago; look again later
    const v = owner._rhRelShip;
    if (!v) return;
    const az = owner._rhAzRad();
    const tol = (RH.PLANE_TOL_DEG ?? 5) * D2R;
    // Which error does the turn correct? First the one across the strut's swing plane (a turn about the strut's radial
    // direction). Once she is in the plane, the one along it (fix round F2a): the strut can only point at [STRUT_MIN,
    // STRUT_MAX], so a daughter below the floor needs the mother turned about the plane's normal until she is inside.
    let theta;
    let axisL;
    let tracked = false;
    if (Math.abs(owner._rhPlaneErrRad) > tol) {
      // reel-turn (owner 2026-10-21, "strange oscillations ... not good"): the turn is CLOSED LOOP. The angle left is read from
      // her live place every frame (`_rhTrackPlane`), because she reels in during the turn and the strut hinge hangs ~1 m off
      // the turning axis: an angle fixed at the request overshot, the next request reversed it, and the reel held and pulled
      // by turns. Without the ship's place (a headless stub) the old open-loop angle from the hinge direction stays.
      const live = this._rhPlaneTurnLeft(owner, az);
      if (live !== null) {
        theta = live;
        tracked = true;
      } else {
        const vt = -v.x * Math.sin(az) + v.y * Math.cos(az);
        theta = Math.atan2(vt, -v.z);
        if (theta > Math.PI / 2) theta -= Math.PI; else if (theta <= -Math.PI / 2) theta += Math.PI;
      }
      axisL = _rhAxisR.set(Math.cos(az), Math.sin(az), 0);
    } else {
      const lo = (RH.STRUT_MIN_DEG ?? 34) * D2R;
      const hi = (RH.STRUT_MAX_DEG ?? 180) * D2R;
      const phi = Math.atan2(v.x * Math.cos(az) + v.y * Math.sin(az), -v.z);   // her angle in the strut's plane
      if (phi >= lo && phi <= hi) return;                                       // the strut can point at her
      const wrap = (x) => { while (x > Math.PI) x -= 2 * Math.PI; while (x <= -Math.PI) x += 2 * Math.PI; return x; };
      const toLo = wrap(lo - phi);
      const toHi = wrap(hi - phi);
      theta = Math.abs(toLo) <= Math.abs(toHi) ? toLo : toHi;                   // turning the ship by +t moves her angle by +t
      if (Math.abs(theta) <= tol) return;                                       // a few degrees short: the 2 m check decides
      axisL = _rhAxisR.set(-Math.sin(az), Math.cos(az), 0);                     // the plane's normal
    }
    if (Math.abs(theta) > (RH.TURN_MAX_DEG ?? 60) * D2R || Math.abs(theta) < 1e-3) return;
    const ap = this._autopilot;
    if (!ap || typeof ap.requestAttitudeTurn !== 'function') return;
    if (this._motherTurnBlock(owner)) return;                                 // limited: the line-up is hers to do
    const pq = parentQuat || (this.playerSatellite && this.playerSatellite.quaternion);
    if (!pq) return;
    const axisW = new THREE.Vector3().copy(axisL).applyQuaternion(pq);
    owner._rhTurnTries++;
    owner._rhTurnWaitS = RH.TURN_RETRY_S ?? 1;                                // the next request, if this one fails, in a second
    const turn = { arm: owner, tracked };
    const opts = { holdOwner: 'REEL_HOME', holdS: 30 };
    if (tracked) {
      opts.track = () => this._rhTrackPlane(turn, owner, az, tol);
      opts.timeoutS = 60;                                                     // a moving target: the planned-time default is too short
    }
    this._lockExceptArm = owner;                                              // the lock check inside the request
    let p;
    try {
      p = ap.requestAttitudeTurn(axisW, theta, opts);
    } catch (e) {
      p = null;
    } finally {
      this._lockExceptArm = null;
    }
    if (!p || typeof p.then !== 'function') return;
    if (typeof p.catch === 'function') p.catch(() => {});                     // a refusal / cancel is read below, not thrown
    const refusal = typeof ap.lastAttitudeTurnRefusal === 'function' ? ap.lastAttitudeTurnRefusal() : null;
    if (refusal) return;                                                      // refused at once: nothing moved
    this._rhTurn = turn;
    owner._rhMotherWorking = true;
  }

  /**
   * reel-turn: the angle (rad) the mother must still turn about the strut's radial axis to bring this daughter into the swing
   * plane, from her place NOW and the ship's centre (`planeTurnLeftRad`). Null without the ship's place (a headless stub).
   * @private
   */
  _rhPlaneTurnLeft(owner, az) {
    const ps = this.playerSatellite;
    if (!ps || !ps.position || !ps.quaternion || !owner.position) return null;
    _rhTurnQ.copy(ps.quaternion).invert();
    _rhTurnP.copy(owner.position).sub(ps.position).applyQuaternion(_rhTurnQ);
    return planeTurnLeftRad(_rhTurnP.x, _rhTurnP.y, _rhTurnP.z, az);
  }

  /**
   * reel-turn: the autopilot asks this EVERY frame of a tracked plane turn: how far is the mother still to turn (signed, rad)?
   * Null = stop where she is (the autopilot brakes at the couples' α): the turn is not ours any more (its daughter left the
   * reels, another turn replaced it), she is inside half the tolerance (the hysteresis: a turn starts beyond PLANE_TOL_DEG and
   * ends inside half of it, so it cannot restart on the edge), or her lever on this axis is gone (she is level with it, or the
   * turn left is bigger than TURN_MAX_DEG): turning on would only spin the mother, and the 2 m line-up deals with the rest.
   * @private
   */
  _rhTrackPlane(turn, owner, az, tol) {
    if (this._rhTurn !== turn || !owner._rhHome || owner.isDetached) return null;
    if (Math.abs(owner._rhPlaneErrRad) < 0.5 * tol) return null;
    const left = this._rhPlaneTurnLeft(owner, az);
    const RH = Constants.REEL_HOME || {};
    if (left === null || Math.abs(left) > (RH.TURN_MAX_DEG ?? 60) * Math.PI / 180) return null;
    return left;
  }

  /** reel-home: her turn is over (or its daughter left) — drop the attitude hold it took, if it is still ours. @private */
  _rhEndTurn(ap) {
    this._rhTurn = null;
    if (ap && ap._attitudeHoldOwner === 'REEL_HOME' && typeof ap.releaseAttitudeHold === 'function') ap.releaseAttitudeHold();
  }

  /**
   * reel-home (fix round F3): the mother's own net (podIndex >= 0) or lasso is fired while a reel-home turn owns her
   * attitude. The catch wins: the turn stops where it is at once and its REEL_HOME hold is let go; then the catch's own
   * reel-in hold is taken through AutopilotSystem's public calls (its own listener runs before or after this one;
   * when it ran first, `holdAttitudeForNet` / `holdAttitude` left our owned hold alone, so it is taken here). The
   * daughter then holds at 2 m (the mother is "limited": `isReelInHeld`) and lines herself up on her thrusters.
   * @param {'net'|'lasso'} kind
   * @private
   */
  _rhOnMotherCatchFired(kind) {
    if (!this._rhTurn) return;                       // none of ours holds the attitude
    const ap = this._autopilot;
    this._rhAbortTurn();
    if (!ap) return;
    if (kind === 'net' && typeof ap.holdAttitudeForNet === 'function') ap.holdAttitudeForNet();
    else if (kind === 'lasso' && typeof ap.holdAttitude === 'function') ap.holdAttitude();
  }

  /** reel-home: its daughter has left the reels mid-turn — stop the turn's hold from outliving her. @private */
  _rhAbortTurn() {
    const ap = this._autopilot;
    if (ap && typeof ap.cancelAttitudeTurn === 'function') ap.cancelAttitudeTurn();
    this._rhEndTurn(ap);
  }

  /**
   * reel-home (Decision 7): the gap, metres, between the ship and a daughter placed at `pos` (world) with her catch on her
   * nose — a capsule from her centre to the catch's centre, wide enough for the catch. Infinity without a keep-out model
   * (a headless rig). The line-up refuses a step nearer than ALIGN_CLEAR_M.
   * @private
   */
  _rhGapAt(arm, pos, parentPos, parentQuat) {
    const ko = this.getKeepOut();
    if (!ko || !parentPos || !parentQuat) return Infinity;
    const q = _rhInvQ.copy(parentQuat).invert();
    const toShipM = (w, out) => out.copy(w).sub(parentPos).applyQuaternion(q).multiplyScalar(1 / M);
    const a = toShipM(pos, _rhGapA);
    const d = arm.capturedDebris;
    let rM = 0.30;
    const b = _rhGapB.copy(a);
    if (d && arm.group && d._rackLocalM) {
      b.copy(d._rackLocalM).applyQuaternion(arm.group.quaternion).applyQuaternion(q).add(a);
      rM = Math.max(rM, (d.sizeMeter || 0) / 2);
    }
    const ignore = ['dau' + arm.index, 'strut' + arm.index, 'rack catch ' + arm.index];
    const hit = ko.segment([a.x, a.y, a.z], [b.x, b.y, b.z], rM, { ignore });
    return hit && Number.isFinite(hit.gap) ? hit.gap : Infinity;
  }

  /**
   * Wave1 reel-drum feedback (2026-08-27): ONE OWNER for the strut reel-
   * cartridge LED/drum states (PlayerSatellite.setTetherState). ArmManager's
   * per-frame arm poll already reads every arm's state, so the sync lives here
   * rather than inside ArmUnit — one place that knows the whole fleet, and the
   * entity stays free of a render-furniture concern.
   *
   * Mapping (mirrors ArmUnit._updateTether's tether-visible rules, so the drum
   * spins exactly while the cable it reels is drawn):
   *   'deployed' — arm out on tether work (REELING/RETURNING/HAULING and every
   *                other deployed-away state): amber LED + spool spin
   *   'ready'    — strut home states (DOCKED/DOCKING/RELOADING/HOLDING_CATCH)
   *   'empty'    — EXPENDED (tether snapped) or deliberately DETACHED (cable
   *                cut): she'll never fly this cable again, so the cartridge
   *                must not read "home" (green) — it reads red.
   *
   * Edge-triggered (send on change only) so calls trace a clean sequence.
   * Guarded for headless/legacy player mocks that lack setTetherState (they
   * simply carry no drum furniture).
   * @private
   */
  _syncTetherDrums() {
    const ps = this.playerSatellite;
    if (!ps || typeof ps.setTetherState !== 'function') return;
    for (const arm of this.arms) {
      const idx = arm.index;
      if (!(idx >= 0)) continue;
      let want;
      if (arm.isDetached || arm.state === ARM_STATES.EXPENDED) want = 'empty';
      else want = _DRUM_HOME_STATES.has(arm.state) ? 'ready' : 'deployed';
      if (this._drumStatesSent[idx] !== want) {
        this._drumStatesSent[idx] = want;
        ps.setTetherState(idx, want);
      }
    }
  }

  /**
   * Cargo-continuity S10 (register item 35): the ONE SSOT for *cargo aboard* —
   * the mother berth (BERTHED/COLLARED/TRANSFERRING, via getBerthedMassKg) PLUS
   * every daughter's heldCatches rack. Both range (getMassBudget) and handling
   * (PlayerSatellite._applyThrust) read this, so a catch's kilograms count the
   * same wherever it sits — that is the mechanism of the campaign loop
   * (range ↔ cargo ↔ processing during the journey). Guarded exactly like the
   * S2/S6 CoMCalculator sites: plain-object mocks may lack the fields.
   *
   * A detached or expended daughter's rack does NOT count: that mass left with
   * her, and CoMCalculator.getDaughterMass already returns 0 for those holders —
   * the two ledgers must agree on what "aboard" means (§6). Unreachable today
   * (HOLDING_CATCH is in neither detach()'s DETACHABLE set nor deorbit
   * eligibility), pinned by test so it stays true.
   *
   * The in-hand `capturedDebris` scalar is deliberately NOT counted: it is the
   * haul, and getMassBudget excludes a deployed daughter's own mass too, so
   * counting her cargo would be inconsistent. (Register item 45, CLOSED: a
   * HOLDING_CATCH daughter is home-and-occupied, and getMassBudget now counts
   * her own arm mass in dockedArmMass — the S7 arrival tick no longer dips
   * the ship mass as the rack gains the cargo.)
   * @returns {number} kg of captured mass currently aboard, wherever it sits
   */
  getCargoMassKg() {
    const berthed = (this.playerSatellite
        && this.playerSatellite._captureNetSystem
        && typeof this.playerSatellite._captureNetSystem.getBerthedMassKg === 'function')
      ? this.playerSatellite._captureNetSystem.getBerthedMassKg() : 0;
    let rack = 0;
    for (const arm of this.arms) {
      if (arm.isDetached || arm.state === ARM_STATES.EXPENDED) continue;
      if (Array.isArray(arm.heldCatches)) {
        for (const held of arm.heldCatches) rack += (held && held.mass) || 0;
      }
    }
    // Bags latched on the radiator tips (TipCargo) are cargo aboard too.
    const tip = (this.playerSatellite && this.playerSatellite.tipCargo
        && typeof this.playerSatellite.tipCargo.totalMassKg === 'function')
      ? this.playerSatellite.tipCargo.totalMassKg() : 0;
    return berthed + rack + tip;
  }

  // ── hold-catch: a daughter aboard with a catch keeps her strut at her hold pose ───

  /** hold-catch: the strut angle a daughter holding a catch rests at (see `_holdPoseOf` above). @returns {{rad:number, tooBig:boolean}|null} */
  holdPoseFor(armIndex) { return _holdPoseOf(this, armIndex); }

  /** hold pose with a short memory: re-read when her rack changes or every 0.5 s (the read is a few dozen cone tests). @private */
  _holdPoseCached(arm, armIndex, dt) {
    let key = '';
    if (Array.isArray(arm.heldCatches)) for (const h of arm.heldCatches) if (h) key += `${h.id}:${h.sizeMeter}:${h._rackCell};`;
    const c = arm._holdPose;
    if (c && c.key === key && c.ageS < 0.5) { c.ageS += dt; return c.pose; }
    const pose = this.holdPoseFor(armIndex);
    arm._holdPose = { key, pose, ageS: 0 };
    return pose;
  }

  /**
   * hold-catch (rebases S9's re-pose, cargo-continuity plan §5 part 3, register item 32): every daughter parked HOLDING_CATCH
   * with a catch gets her strut to her hold pose (`holdPoseFor`: 34° if her catch is plume-clear there, else the lowest
   * plume-clear angle, never above 100°). It starts from 34°, NOT from where the strut is — a strut the reel left at 180° comes
   * down — and it acts whether or not the catch bites at the present angle. Live, NOT flag-gated; THRUSTER_INTERLOCK stays dormant.
   *  • MANUAL: a "." press (`_strutManual`, aged by StrutAuto for holding arms too) stands for its quiet window as long as the
   *    angle it asked for is safe (not below the hold pose, not above 100°, catch plume-clear there); an unsafe one is dropped.
   *  • ONE writer of `_strutTargetAlpha` for a holding arm while no hand-off runs (CARRY_* arms are in another state).
   *  • She says one line when nothing clears even at 100° (a catch that big is for a radiator).
   * Headless mocks lack the render-side strut driver — they slew HERE (the S10 legacy-fallback idiom); production slews once, in
   * _updateStruts, which owns the same latch.
   * @param {number} dt — frame delta seconds
   * @private
   */
  _updateCargoPlumePoses(dt) {
    const headless = !(this.playerSatellite && this.playerSatellite.strutGroups);
    const V5 = Constants.OCTOPUS_V5;
    const D2R = Math.PI / 180;
    const dead = V5.HOLD_POSE_DEADBAND_DEG * D2R;
    const cap = V5.HOLD_POSE_MAX_DEG * D2R;
    for (let i = 0; i < this.arms.length; i++) {
      const arm = this.arms[i];
      if (!arm || arm.state !== ARM_STATES.HOLDING_CATCH) continue;
      const hp = this._holdPoseCached(arm, i, dt);
      if (hp) {
        const eff = arm._strutTargetAlpha !== undefined ? arm._strutTargetAlpha : arm.getAimAlpha();
        let go = true;
        if (arm._strutManual) {
          // the player's press stands while it is safe; an unsafe one (below the pose, over the cap, in a plume) is dropped
          const safe = eff >= hp.rad - dead && eff <= cap + dead && !heldCargoPlumeConflictAt(this, i, eff);
          if (safe) go = false; else delete arm._strutManual;
        }
        if (go && Math.abs(eff - hp.rad) > dead) arm._strutTargetAlpha = hp.rad;
        if (hp.tooBig) {
          const sig = arm._holdPose.key;
          if (arm._holdTooBigSaid !== sig) {
            arm._holdTooBigSaid = sig;
            // FA2: "Press C" only when C can work: the catch must be able to go to a tip at all, and C works only once every
            // daughter is full (otherwise the line says when). A catch that cannot go to a tip is parked and the line says so.
            const where = this._handoffOutlook(arm) === 'never'
              ? `, and it cannot go to a radiator; her strut parks at ${V5.HOLD_POSE_MAX_DEG}°.`
              : (this.allDaughtersFull() ? '; move it to a radiator (Press C).' : '; it can go to a radiator once every daughter is holding a catch.');
            eventBus.emit(Events.COMMS_MESSAGE, {
              text: `Daughter ${i + 1}'s catch is too big to keep clear of the thrusters${where}`,
              priority: 'warning',
            });
          }
        }
      }
      if (headless && arm._strutTargetAlpha !== undefined && typeof arm.setAimAlpha === 'function') {
        arm.setAimAlpha(arm._strutTargetAlpha, dt);
        if (Math.abs(arm.getAimAlpha() - arm._strutTargetAlpha) < 0.01) {
          arm._strutTargetAlpha = undefined; // arrived — the render driver's own rule
        }
      }
    }
  }

  /**
   * S9 destination-feasibility READ (NOT the live gate): would planting arm
   * `armIndex`'s strut tip at `alphaDest` put it inside an occupied mother-net
   * berth corridor? Same ship-local cylinder geometry as CaptureNet's
   * _corridorClear section 1 (fore of the berth anchor plane, radial < the
   * mated catch's radius + BERTH_CLEARANCE_M), scoped to the station holders
   * (BERTHED/COLLARED/TRANSFERRING — the getDockedCatch set). The live
   * corridor gate itself is untouched (S13(d): strut-tips-only there).
   * (hold-catch, 2026-10-22: the hold pose no longer reads this: its 100° cap is clear of every inbound size, measured
   * with `strutTipFoulsCorridor`. Kept as the destination read for any pose that is allowed above 100°.)
   * @param {number} armIndex
   * @param {number} alphaDest — destination sweep angle (rad)
   * @returns {boolean} true when the destination crosses no occupied corridor
   * @private
   */
  _repPoseCorridorClear(armIndex, alphaDest) {
    const player = this.playerSatellite;
    const cns = player && player._captureNetSystem;
    const nets = cns && Array.isArray(cns.activeNets) ? cns.activeNets : null;
    if (!nets || nets.length === 0) return true;
    const V5C = Constants.OCTOPUS_V5;
    const CN = Constants.CAPTURE_NET;
    if (!V5C || !CN || !CN.STATES) return true;
    const M_NET = 0.00001;

    // The ONE berth anchor (S13(e)): the collar object, else pod 0's muzzle,
    // else the documented collar constant — the same reads _corridorClear makes.
    const anchor = player._netBerthCollar
      ?? player._netPodMuzzles?.[0];
    const mx = anchor ? anchor.position.x / M_NET : 0;
    const my = anchor ? anchor.position.y / M_NET : 0;
    const mz = anchor ? anchor.position.z / M_NET : (V5C.BERTH_COLLAR_Z_M ?? 1.30);

    const dp = this._dockPositions[armIndex];
    const azRad = dp ? (dp.azimuthDeg * Math.PI / 180) : 0;
    const collarR = V5C.COLLAR_RADIUS ?? 0.40;
    const collarY = V5C.COLLAR_Y ?? 1.00;
    const strutLen = V5C.STRUT_LENGTH ?? 1.70;
    const anchorLocal = { x: mx, y: my, z: mz };

    // ONE geometry (ArmDockBasis.strutTipFoulsCorridor), per occupant radius.
    const S = CN.STATES;
    for (const net of nets) {
      if (!net || !net._isMother) continue;
      if (net.state !== S.BERTHED && net.state !== S.COLLARED && net.state !== S.TRANSFERRING) continue;
      const d = net.targetDebris;
      const radiusM = ((d && d.sizeMeter) || 2) / 2 + (CN.BERTH_CLEARANCE_M ?? 1.0);
      if (strutTipFoulsCorridor(alphaDest, azRad, collarR, collarY, strutLen, anchorLocal, radiusM)) {
        return false;
      }
    }
    return true;
  }

  // ── Task 7 (opening-dance plan) — lean aside for an inbound catch ────────
  // Decision 6 (LOCKED, governing law for this task): nothing crosses or
  // tangles — tethers, struts, debris. The daughters' open pose used to be
  // 146°, which sat inside an inbound catch's berth corridor for pieces over
  // ~0.7 m. The one-press rest is now 34° (STRUT_REST_ALPHA, tip z −0.41 m) and
  // a double tap is 90° (STRUT_DEPLOY_ALPHA, tip z ≈ −0.30 m): both tips are aft
  // of the muzzle plane, so no catch of any size fouls them and neither is ever
  // ducked. The duck still runs for a strut set to 180° directly (no button
  // reaches it), to 90° — STRUT_DEPLOY_ALPHA, never past it.

  /**
   * Does arm `armIndex`'s CURRENT (live, `getAimAlpha()`) strut tip sit
   * inside a berth corridor cylinder sized for an inbound catch of
   * `radiusM`? The geometry is `ArmDockBasis.strutTipFoulsCorridor` — the ONE
   * copy, shared with `CaptureNet._corridorClear` (the authoritative berth
   * gate) and `_repPoseCorridorClear` above, so this really is "the SAME
   * test" the plan asks for rather than a mirror that can drift. This method
   * supplies only the POLICY: which arm, which anchor, which radius.
   * `_corridorClear`'s own behaviour is untouched.
   * @param {number} armIndex
   * @param {number} radiusM — the inbound catch's corridor radius
   *   (`debris.sizeMeter / 2 + CAPTURE_NET.BERTH_CLEARANCE_M`)
   * @param {number} [alphaRad] — test this strut angle instead of her live one (launch-aim cap)
   * @returns {boolean} true when this arm's live tip (or the tip at `alphaRad`) fouls the corridor
   * @private
   */
  _strutFoulsInboundCorridor(armIndex, radiusM, alphaRad) {
    const arm = this.arms[armIndex];
    if (!arm || typeof arm.getAimAlpha !== 'function') return false;

    const player = this.playerSatellite;
    const V5 = Constants.OCTOPUS_V5;
    if (!player || !V5) return false;

    // The ONE berth anchor (S13(e)): the collar object, else pod 0's muzzle,
    // else the documented collar constant — the same reads _corridorClear
    // and _repPoseCorridorClear make.
    const anchor = player._netBerthCollar ?? player._netPodMuzzles?.[0];
    const mx = anchor ? anchor.position.x / M : 0;
    const my = anchor ? anchor.position.y / M : 0;
    const mz = anchor ? anchor.position.z / M : (V5.BERTH_COLLAR_Z_M ?? 1.30);

    const dp = this._dockPositions[armIndex];
    const azRad = dp ? (dp.azimuthDeg * Math.PI / 180) : 0;
    return strutTipFoulsCorridor(
      alphaRad === undefined ? arm.getAimAlpha() : alphaRad,
      azRad,
      V5.COLLAR_RADIUS ?? 0.40,
      V5.COLLAR_Y ?? 1.00,
      V5.STRUT_LENGTH ?? 1.70,
      { x: mx, y: my, z: mz },
      radiusM,
    );
  }

  /**
   * Trigger: `Events.LASSO_CAPTURED` — a catch is inbound. Tests every
   * DOCKED arm's live strut alpha against the SAME corridor cylinder
   * `_corridorClear` uses (mirrored above); only the arms that would
   * actually foul duck to `STRUT_DEPLOY_ALPHA` (90°, the open angle). A strut
   * at the 34° rest or 90° never fouls any catch (tip aft of the muzzle plane),
   * so only a strut past 90° (set directly, 180°) ducks; unresolved-size pieces never
   * trigger a duck. Sole writer of `_strutTargetAlpha` for the arms it ducks,
   * for the duration of the duck only (`_releaseLeanAside` restores them to
   * `STRUT_DEPLOY_ALPHA`, the same angle).
   * @param {{debrisId?: number|string}} payload — LASSO_CAPTURED's payload
   * @private
   */
  _onInboundCatchCaptured(payload) {
    const debrisId = payload && payload.debrisId;
    if (debrisId == null) return;
    if (!this._debrisField || typeof this._debrisField.getDebrisById !== 'function') return;
    // Rule H (CONVENTIONS §10): resolve the canonical object by id, never a
    // snapshot/wrapper.
    const debris = this._debrisField.getDebrisById(debrisId);
    // No resolvable size ⇒ never duck — "small pieces must never trigger it"
    // extends to a piece this lane cannot measure.
    if (!debris || !debris.sizeMeter) return;

    const CN = Constants.CAPTURE_NET;
    const radiusM = debris.sizeMeter / 2 + (CN?.BERTH_CLEARANCE_M ?? 1.0);

    this._duckFoulingStruts(radiusM);
  }

  /**
   * Duck every DOCKED strut whose live tip fouls a berth corridor of `radiusM` to
   * `STRUT_DEPLOY_ALPHA` (90°) and arm the lean-aside release timer. The ONE copy of the
   * duck loop: `_onInboundCatchCaptured` (LASSO_CAPTURED) and the arms-auto controller
   * (the mother net's own approach) both call it.
   * @param {number} radiusM
   * @returns {boolean} true when at least one strut was ducked
   * @private
   */
  _duckFoulingStruts(radiusM) {
    let ducked = false;
    for (let i = 0; i < this.arms.length; i++) {
      const arm = this.arms[i];
      if (!arm || arm.state !== ARM_STATES.DOCKED) continue;
      if (this._strutFoulsInboundCorridor(i, radiusM)) {
        arm._strutTargetAlpha = Constants.OCTOPUS_V5.STRUT_DEPLOY_ALPHA;
        this._leanAsideArmIndices.add(i);
        ducked = true;
      }
    }
    if (ducked) {
      this._leanAsideActive = true;
      this._leanAsideTimer = LEAN_ASIDE_TIMEOUT_S;
    }
    return ducked;
  }

  /**
   * Release: restore every arm this lane ducked back to the 90° duck angle
   * (`STRUT_DEPLOY_ALPHA`). Wired to `Events.NET_BERTHED` (the plan's own
   * release event) and the "net clears/fails" events (LASSO_MISSED,
   * LASSO_SNAPPED, NET_FAILED, NET_RELEASED, NET_TORN), plus a bounded
   * timeout (`_updateLeanAside`) — see this lane's final report: the lasso
   * adoption path (`CaptureNetSystem.adoptLassoCatch`) deliberately never
   * emits NET_BERTHED, so NET_BERTHED alone would strand a ducked arm
   * ducked forever on that path.
   * A duck is only ever restored while the arm is still DOCKED — if it left
   * DOCKED mid-duck (deployed, recalled, expended…) some other system now
   * owns its `_strutTargetAlpha` and this lane must not fight it.
   * @private
   */
  _releaseLeanAside() {
    if (this._leanAsideArmIndices.size === 0 && !this._leanAsideActive) return;
    for (const i of this._leanAsideArmIndices) {
      const arm = this.arms[i];
      if (arm && arm.state === ARM_STATES.DOCKED) {
        arm._strutTargetAlpha = Constants.OCTOPUS_V5.STRUT_DEPLOY_ALPHA;
      }
    }
    this._leanAsideArmIndices.clear();
    this._leanAsideActive = false;
    this._leanAsideTimer = 0;
  }

  /**
   * Per-frame tick for the lean-aside safety-net timeout. See
   * `_releaseLeanAside`'s doc for why a timeout exists at all.
   * @param {number} dt
   * @private
   */
  _updateLeanAside(dt) {
    if (!this._leanAsideActive) return;
    this._leanAsideTimer -= dt;
    if (this._leanAsideTimer <= 0) this._releaseLeanAside();
  }

  /**
   * Get mass budget data for HUD display.
   * Computes current system mass and Tsiolkovsky ΔV remaining.
   * Config G (ST-9.2): coreDry = V5 bus dry mass + strut mass (struts stay on mothership).
   * Daughter masses (weaver/spinner) are separate — they leave when deployed.
   * @returns {object}
   */
  getMassBudget() {
    const V5 = Constants.OCTOPUS_V5;
    // Config G: bus + ROSA + body-mount + struts (struts are permanent mothership structure)
    const strutMassTotal = V5.STRUT_MASS * this.arms.length;
    // P2 aft flower: purchased pairs are permanent structure too — the ONE
    // hardware-mass carrier is this coreDry term (V5.CORE_DRY_MASS + dynamic
    // hardware sums; the strut-mass precedent). The legacy top-level
    // OCTOPUS_CORE_DRY_MASS twin (170) is deliberately NOT grown — its one
    // reader is TargetReticle's local ΔV mirror, recorded as prior debt with
    // numbers in tmp/flower-mass-budget.mjs §3 (pre-existing +626.7 m/s
    // optimism at tier 0; the flower widens it by the untold pair tax).
    const flowerMass = (this.playerSatellite
        && typeof this.playerSatellite.getFlowerDryMassKg === 'function')
      ? this.playerSatellite.getFlowerDryMassKg() : 0;
    // h3-argon-engine D3: the 60 L engine tank is structure too (9.5 kg, research §2.2). CORE_DRY_MASS
    // (176 = bus + ROSA + body-mount + collar) carries no tank, so this is ADDED, not a replacement.
    // g1-gas-upgrades D6: the tank's dry mass follows its size (the Bigger Engine Tank carries more tank).
    const resources = this.playerSatellite.resources || {};
    const rsStatus = this._resourceSystem ? this._resourceSystem.getStatus() : null;
    const xenonPoolMax = rsStatus ? rsStatus.xenonMax : Constants.XENON_FUEL_MAX;
    const tankDry = engineTankDryKg({ xenonMax: xenonPoolMax });
    const coreDry = V5.CORE_DRY_MASS + tankDry + strutMassTotal + flowerMass;
    const coldGasMax = Constants.OCTOPUS_CORE_COLD_GAS;

    // Get current propellant from player resources
    const coldGasPoolMax = rsStatus ? rsStatus.coldGasMax : Constants.COLD_GAS_MAX;
    // h3-argon-engine D2: engine gas in kg = pool/100 x kgFull of the gas IN THE TANK (tankGasId), via the
    // ONE exported converter. `xenonCurrent` / `xenonMax` keep their names (HUD readers) but are now the
    // engine gas kg now / when the (possibly upgraded) tank is full.
    const gasRes = {
      xenon: resources.xenon || 0,
      tankGasId: resources.tankGasId || (rsStatus && rsStatus.tankGasId) || Constants.DEFAULT_FUEL,
    };
    const tankGas = Constants.FUELS[gasRes.tankGasId] || Constants.FUELS[Constants.DEFAULT_FUEL];
    const xenonCurrent = engineGasKg(gasRes);
    const xenonMax = (xenonPoolMax / 100) * tankGas.kgFull;
    const coldGasCurrent = coldGasMax * ((resources.coldGas || 0) / coldGasPoolMax);

    // Sum arm masses using V5 weights (reel on mothership = 40% lighter arms)
    let armMassTotal = 0;
    let dockedArmMass = 0;
    let deployedArmMass = 0;
    let detachedArmMass = 0;
    for (const arm of this.arms) {
      const m = arm.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS;
      armMassTotal += m;
      // HOLDING_CATCH is home-and-occupied (S1: docked at her strut tip, parked
      // with cargo) — she is NOT "out". Register item 45: keying on DOCKED only
      // dipped the ship mass by one arm at the S7 arrival tick, in the same
      // moment the rack gained the cargo; CoMCalculator counts her throughout
      // (only detached/expended are excluded) and the two ledgers must agree.
      if (arm.state === ARM_STATES.DOCKED || arm.state === ARM_STATES.HOLDING_CATCH || _CARRY_STATES.has(arm.state)) {
        dockedArmMass += m;
      } else if (arm.state !== ARM_STATES.EXPENDED) {
        deployedArmMass += m;
        if (arm.isDetached) detachedArmMass += m;
      }
    }

    // Mother-net-reel plan §4.16: a berthed whale is real mass the Tsiolkovsky
    // readout and the autopilot's pre-engage ΔV gate must both see. Add it to
    // wetMass AND dryMass (it rides along whether or not the tanks are full —
    // it is not propellant). Without this the HUD promises ΔV the laden ship
    // can no longer deliver and the AP happily engages.
    // S10: the fold is CARGO ABOARD (berthed + every daughter rack) via the
    // getCargoMassKg SSOT — a transferred catch's kilograms still ride the
    // ship. berthedMass stays as its own berth-only field; the HUD's "+N kg"
    // explanation line reads cargoMass (register item 45), so it survives the
    // S7 transfer off the nose.
    const berthedMass = (this.playerSatellite
        && this.playerSatellite._captureNetSystem
        && typeof this.playerSatellite._captureNetSystem.getBerthedMassKg === 'function')
      ? this.playerSatellite._captureNetSystem.getBerthedMassKg() : 0;
    const cargoMass = this.getCargoMassKg();

    // DECISIONS §33 row 4 (2026-10-20): the mother's nets aboard are real mass (count x CAPTURE_NET.LARGE.MASS 1.425 kg),
    // carried in the launcher like the cargo: in the loaded and the empty mass, and so in the engine's Tsiolkovsky dry
    // term. A fired net leaves the ship (the count is the one CaptureNetSystem owns), so a shot lightens her. The
    // daughters' own nets are taken to be inside V5_WEAVER_MASS / V5_SPINNER_MASS (no separate term). CoMCalculator
    // books the same mass on the launcher axis (motherNetBooking), so the two ledgers agree.
    // 2026-10-21 (nets-step2): every loaded net weighs the current line-fibre tier's packed mass
    // (CaptureNetSystem.getMotherNetMassKg: count x TETHER_TIERS[tier].netMassKg.mother; 1.425 kg at the start tier).
    const mCns = this.playerSatellite && this.playerSatellite._captureNetSystem;
    const motherNetCount = (mCns && typeof mCns.getMotherNetCount === 'function') ? mCns.getMotherNetCount() : 0;
    const motherNetMass = (mCns && typeof mCns.getMotherNetMassKg === 'function')
      ? mCns.getMotherNetMassKg()
      : motherNetCount * Constants.CAPTURE_NET.LARGE.MASS;

    // Cold gas is CARRIED, not burned by the Hall engine (h3-argon-engine D4: it used to be counted as
    // burnable at Hall Isp, ~30 % too high): it sits in BOTH the loaded and the empty mass.
    const carriedDry = coreDry + coldGasCurrent + dockedArmMass + cargoMass + motherNetMass;
    const wetMass = carriedDry + xenonCurrent;
    const dryMass = coreDry + dockedArmMass + cargoMass + motherNetMass;   // reported, as before: without either gas

    // Tsiolkovsky for the engine: ΔV = Isp_eff x g0 x ln((dry + cold + gas) / (dry + cold)).
    // Isp_eff = the ACTIVE fuel's Isp / c (D5: shop upgrade x power split act as Isp gains).
    const fuel = this._resourceSystem ? this._resourceSystem.getCurrentFuel() : Constants.FUELS[gasRes.tankGasId];
    const c = (this.playerSatellite && typeof this.playerSatellite.getConsumptionMultiplier === 'function')
      ? this.playerSatellite.getConsumptionMultiplier() : 1;
    const ispActive = fuel && fuel.isp > 0 ? fuel.isp : Constants.OCTOPUS_CORE_HALL_ISP;
    const isp = ispActive / (c > 0 ? c : 1);   // effective Isp: the figure the ΔV and the flow share
    const deltaV = engineDeltaV({
      dryKg: coreDry + dockedArmMass + cargoMass + motherNetMass, coldGasKg: coldGasCurrent, gasKg: xenonCurrent, isp: ispActive, c,
    });

    return {
      coreDry,
      flowerMass: Math.round(flowerMass * 10) / 10,
      xenonCurrent: Math.round(xenonCurrent * 10) / 10,
      xenonMax,
      // g1-gas-upgrades D7: "how full is the engine tank" by MASS, the same for every gas (bars and colours read this)
      gasFrac: engineGasLowFrac({ xenon: gasRes.xenon, xenonMax: xenonPoolMax, tankGasId: gasRes.tankGasId }),
      coldGasCurrent: Math.round(coldGasCurrent * 10) / 10,
      coldGasMax,
      dockedArmMass: Math.round(dockedArmMass * 10) / 10,
      deployedArmMass: Math.round(deployedArmMass * 10) / 10,
      detachedArmMass: Math.round(detachedArmMass * 10) / 10,
      armMassTotal: Math.round(armMassTotal * 10) / 10,
      wetMass: Math.round(wetMass),
      dryMass: Math.round(dryMass),
      berthedMass: Math.round(berthedMass * 10) / 10,
      cargoMass: Math.round(cargoMass * 10) / 10,
      motherNets: motherNetCount,                                   // the mother's nets aboard (count)
      motherNetMass: Math.round(motherNetMass * 1000) / 1000,       // kg, count x 1.425 (inside wet and dry mass)
      deltaV: Math.round(deltaV),
      isp,
      shipMassKg: wetMass,   // exact (unrounded) total mass now — the gas-flow law's m_ship (PlayerSatellite)
      tankGasId: gasRes.tankGasId,
    };
  }

  // ==========================================================================
  // QUERIES
  // ==========================================================================

  // ==========================================================================
  // ARM SELECTION (Sprint C2 — extended to 8 arms)
  // ==========================================================================

  /**
   * Select an arm by index (0-7).
   * @param {number} index — arm index in the arms array
   */
  selectArm(index) {
    if (index < 0 || index >= this.arms.length) return;
    // Toggle: re-selecting the same arm deselects
    if (this.selectedArmIndex === index) {
      this.deselectArm();
      return;
    }
    // Disable manual mode on previously selected arm (Phase 1A cleanup)
    if (this.selectedArmIndex >= 0 && this.selectedArmIndex < this.arms.length) {
      const prev = this.arms[this.selectedArmIndex];
      if (prev && prev.isManual()) prev.disableManual();
      // D4 (hotkey revamp 2026-06-14): clear the old plate's selection glow.
      if (prev && typeof prev.setSelectedHighlight === 'function') prev.setSelectedHighlight(false);
    }
    this.selectedArmIndex = index;
    const arm = this.arms[index];
    // D4: glow/flash the newly selected plate (visible feedback for docked arms
    // before launch; deployed arms also light while piloted).
    if (arm && typeof arm.setSelectedHighlight === 'function') arm.setSelectedHighlight(true);
    eventBus.emit(Events.ARM_SELECT, { armIndex: index });
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `${arm.displayName} selected.`,
      priority: 'info',
    });
  }

  /**
   * Deselect arm — return focus to mothership.
   */
  deselectArm() {
    // Disable manual mode on currently selected arm (Phase 1A cleanup)
    if (this.selectedArmIndex >= 0 && this.selectedArmIndex < this.arms.length) {
      const arm = this.arms[this.selectedArmIndex];
      if (arm && arm.isManual()) arm.disableManual();
      // D4 (hotkey revamp 2026-06-14): clear the selection glow.
      if (arm && typeof arm.setSelectedHighlight === 'function') arm.setSelectedHighlight(false);
    }
    this.selectedArmIndex = -1;
    eventBus.emit(Events.ARM_DESELECT);
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: 'Daughter deselected. Mothership focus',
      priority: 'info',
    });
  }

  /**
   * Get the currently selected arm (any state), or null.
   * @returns {ArmUnit|null}
   */
  getSelectedArm() {
    if (this.selectedArmIndex < 0 || this.selectedArmIndex >= this.arms.length) return null;
    return this.arms[this.selectedArmIndex];
  }

  /**
   * Get the selected arm IF it is deployed and pilotable, or null.
   * Pilotable states: TRANSIT, APPROACH, TRAWLING, STATION_KEEP.
   * @returns {ArmUnit|null}
   */
  getSelectedDeployedArm() {
    const arm = this.getSelectedArm();
    if (!arm) return null;
    const pilotable = [
      ARM_STATES.TRANSIT,
      ARM_STATES.APPROACH,
      ARM_STATES.TRAWLING,
      ARM_STATES.STATION_KEEP,
    ];
    return pilotable.includes(arm.state) ? arm : null;
  }

  /** Get count of docked arms */
  getDockedCount() {
    return this.arms.filter(a => a.state === ARM_STATES.DOCKED).length;
  }

  /** Get count of deployed (active) arms */
  getDeployedCount() {
    return this.arms.filter(a =>
      a.state !== ARM_STATES.DOCKED &&
      a.state !== ARM_STATES.EXPENDED
    ).length;
  }

  /**
   * FIX_PLAN §3: Returns true if ANY arm is deployed on a tether (not docked, not expended, not detached).
   * Canonical predicate — use this instead of inline state checks.
   */
  hasTetheredArm() {
    const S = Constants.ARM_STATES;
    return this.arms.some(a =>
      a.state !== S.DOCKED &&
      a.state !== S.RELOADING &&
      a.state !== S.HOLDING_CATCH &&   // parked at the strut holding a catch — home, no live tether
      a.state !== S.EXPENDED &&
      !a.isDetached
    );
  }

  /**
   * FIX_PLAN §3: Returns the rotation lock tier based on deployed arm states.
   * 'block' — hard-block rotation (high-risk: REELING, HAULING, GRAPPLED, STATION_KEEP, NETTING, DOCKING)
   * 'soft'  — soft-cap rotation to TETHER_ROTATION.SOFT_CAP_RATE (TRANSIT, APPROACH, TRAWLING, LAUNCHING, RETURNING, SCANNING, ABLATING)
   * 'none'  — no constraint (all arms DOCKED/EXPENDED/RELOADING or detached)
   *
   * launch-seq: a LAUNCHING daughter whose spring has NOT fired is still clamped to her strut — part of the
   * ship, no tether out — so she contributes 'none'. Her tier is 'soft' from the spring on (she is flying out
   * on the line). Before, the clamp hold counted as tethered and dragged the mother back from the aim.
   */
  getRotationLockTier(exceptArm = this._lockExceptArm) {
    let tier = 'none';
    for (const arm of this.arms) {
      if (arm.isDetached) continue;             // free-flying — severed tether, no shear risk
      // reel-home (Decision 6, fix round F1): the daughter the mother turns FOR, and every other daughter that is already
      // on the strut line (REELING home: her line is being wound in), do not hold the mother still. A daughter still in
      // GRAPPLED (her net reel included) does. Callers with no `exceptArm` get today's answer.
      if (this._rhIgnoredForTurn(arm, exceptArm)) continue;
      const s = arm.state;
      if (s === ARM_STATES.LAUNCHING && !arm._springFired) continue;  // clamped: part of the ship
      if (_HIGH_RISK_ROT_STATES.has(s)) return 'block'; // early exit — max severity
      if (_SOFT_ROT_STATES.has(s)) tier = 'soft';
      // DOCKED / RELOADING / HOLDING_CATCH / EXPENDED contribute 'none' — leave tier unchanged
    }
    return tier;
  }

  /** Get count of expended arms */
  getExpendedCount() {
    return this.arms.filter(a => a.state === ARM_STATES.EXPENDED).length;
  }

  /** Get total captures across all arms */
  getTotalCaptures() {
    return this.arms.reduce((sum, a) => sum + a.captures, 0);
  }

  /**
   * Get status of all arms for HUD display.
   * Returns array of per-arm status objects (backward compatible).
   * V5: Each status now includes springCharged, reloadProgress from ArmUnit.getStatus().
   * @returns {Array<object>}
   */
  getAllStatus() {
    return this.arms.map(a => a.getStatus());
  }

  /**
   * Get V5 fleet-wide status for enhanced HUD display.
   * Includes per-arm statuses plus fleet-level data (pulse scan, counts, etc.).
   * @returns {object}
   */
  getFleetStatus() {
    return {
      arms: this.arms.map(a => a.getStatus()),
      totalArms: this.arms.length,
      pulseScanCooldown: this._pulseScanCooldown,
      pulseScanActive: this._pulseScanActive,
      selectedArmIndex: this.selectedArmIndex,
      reloadingCount: this.arms.filter(a => a.state === ARM_STATES.RELOADING).length,
      chargedCount: this.arms.filter(a => a.state === ARM_STATES.DOCKED && a.springCharged).length,
    };
  }

  /**
   * Get arms by type.
   * @param {'weaver'|'spinner'} type
   * @returns {ArmUnit[]}
   */
  getArmsByType(type) {
    return this.arms.filter(a => a.type === type);
  }

  /**
   * Pure read (no comms, no state change): can a daughter go at `target` now, will one without the player doing
   * anything, or what stops them all? Mirrors the gates of `deployArm` (safe mode, ARM power, the arm `_findDockedArm`
   * picks by type, its capture mass), so `ready` is true exactly when `deployArm(target)` gets past them.
   * Daughter fuel never refills in play, so fuel <= 5 is a dead end (`noFuel`).
   * @param {object} target - needs `.mass` (default 1 kg, as deployArm)
   * @returns {{ready:boolean, wait:boolean, going:boolean, why:(string|null), counts:{noFuel:number, holding:number, heavy:number}}}
   *   `going`: a daughter already out for this very piece. `wait`: not ready, but one will be (spring reloading, or
   *   out on her line). `why`: 'safe' | 'power' | 'none' | 'fuel' | 'holding' | 'heavy' | 'mixed' when nothing will be ready.
   */
  daughterLaunchReadiness(target) {
    const S = ARM_STATES;
    const counts = { noFuel: 0, holding: 0, heavy: 0 };
    const out = { ready: false, wait: false, going: false, why: null, counts };
    const arms = this.arms || [];
    out.going = !!target && arms.some((a) => a && a.state !== S.DOCKED && a.target === target);
    if (this.playerSatellite && this.playerSatellite.safeMode) { out.why = 'safe'; return out; }
    if (powerDistribution.armMultiplier <= 0) { out.why = 'power'; return out; }

    const mass = (target && target.mass) || 1;
    // The arm deployArm would pick: the preferred type first, the other type if none of it can go.
    const first = mass > Constants.SPINNER_MAX_CAPTURE_MASS ? 'weaver' : 'spinner';
    const order = [first, first === 'weaver' ? 'spinner' : 'weaver'];
    for (const type of order) {
      const eligible = arms.filter((a) => a && a.type === type && armCanLaunchNow(a));
      if (eligible.length > 0) {
        out.ready = eligible.some((a) => mass <= a.config.maxCaptureMass);
        break;
      }
    }
    if (out.ready) return out;

    for (const a of arms) {
      if (!a || a.state === S.EXPENDED || a.state === S.ADRIFT || a.isDetached) continue;
      if (a.state === S.HOLDING_CATCH) { counts.holding++; continue; }
      if (!(a.fuel > 5)) { counts.noFuel++; continue; }
      if (mass > a.config.maxCaptureMass) { counts.heavy++; continue; }
      out.wait = true;    // docked with the spring reloading / aim-reserved, or out on her line: she will be ready
    }
    if (out.wait) return out;
    const kinds = (counts.noFuel > 0) + (counts.holding > 0) + (counts.heavy > 0);
    out.why = kinds === 0 ? 'none'
      : kinds > 1 ? 'mixed'
        : counts.noFuel > 0 ? 'fuel' : counts.holding > 0 ? 'holding' : 'heavy';
    return out;
  }

  /**
   * Find a docked arm matching the preferred type, with highest fuel.
   * V5: Also checks springCharged — can't deploy an uncharged arm.
   * If targetDir (ship-local) is provided, prefers the arm whose dockOffset
   * best aligns with the target direction to minimise camera swing on deploy.
   * Falls back to highest-fuel arm when no arm aligns within ~45°.
   * @private
   * @param {'weaver'|'spinner'} type
   * @param {THREE.Vector3|null} [targetDir=null] - Direction to target in ship-local space
   * @returns {ArmUnit|null}
   */
  _findDockedArm(type, targetDir = null) {
    const eligible = this.arms.filter(a => a.type === type && armCanLaunchNow(a));
    if (eligible.length === 0) return null;

    if (targetDir && targetDir.lengthSq() > 0) {
      const dir = targetDir.clone().normalize();
      const COS_45 = 0.707; // cos(45°) threshold for "well-aligned"

      // Score each arm by how well its dock offset aligns with the target
      const scored = eligible.map(arm => {
        const dockDir = arm.dockOffset.clone().normalize();
        return { arm, dot: dir.dot(dockDir) };
      });

      // Prefer arms within ~45° of target direction
      const aligned = scored.filter(s => s.dot > COS_45);
      if (aligned.length > 0) {
        aligned.sort((a, b) => b.dot - a.dot);
        return aligned[0].arm;
      }
      // No well-aligned arm → fall through to fuel-based selection
    }

    // Default: highest fuel first (original behaviour)
    eligible.sort((a, b) => b.fuel - a.fuel);
    return eligible[0];
  }

  // ==========================================================================
  // SHOP UPGRADES (Tier 4B — persisted across reset)
  // ==========================================================================

  /**
   * Apply a shop upgrade to all arms. Stores the override so it
   * survives reset() (which field-resets and reuses the existing arm
   * instances — no new ArmUnit construction outside _initArms).
   * @param {object} data - { effect: string, value: number }
   */
  applyUpgrade(data, opts = {}) {
    // Store for re-application after reset
    this._storedUpgrades[data.effect] = data.value;

    // V5: Handle spring/tether tier upgrades
    if (data.type === 'springTier' || data.effect === 'springTier') {
      this.applySpringUpgrade(data.value || data.level);
      return;
    }
    if (data.type === 'tetherTier' || data.effect === 'tetherTier') {
      // opts.restore = the save-load replay (GameFlowManager MENU_CONTINUE): every launcher comes up full.
      this.applyTetherUpgrade(data.value || data.level, { fill: !!(opts && opts.restore) });
      return;
    }

    // Apply to all current arm units
    for (const arm of this.arms) {
      arm.applyUpgradeOverride(data.effect, data.value);
    }
  }

  /**
   * The first DOCKED daughter of `type` whose net magazine has room (DECISIONS §33 rows 2 and 5: nets refill only by
   * buying at the resupply stop, one at a time).
   * @param {'weaver'|'spinner'} type — weaver = the large daughter, spinner = the small
   * @returns {object|null} the arm, or null when none is docked with room
   */
  findDaughterNeedingNet(type) {
    for (const arm of this.arms) {
      if (!arm || arm.state !== ARM_STATES.DOCKED) continue;
      const t = arm.config ? arm.config.type : arm.type;
      if (t !== type) continue;
      const max = typeof arm.getNetInventoryMax === 'function' ? arm.getNetInventoryMax() : 0;
      const have = typeof arm.getNetInventory === 'function' ? arm.getNetInventory() : 0;
      if (max > 0 && have < max) return arm;
    }
    return null;
  }

  /** True when some docked daughter of `type` has room for one more net (the shop's full check). */
  hasDaughterNetSpace(type) {
    return this.findDaughterNeedingNet(type) !== null;
  }

  /**
   * Shop consumable: load exactly ONE net into the first docked daughter of `type` with room. Not an upgrade (no
   * stored override, nothing replays after a reset): the magazine is the state.
   * @param {'weaver'|'spinner'} type
   * @returns {boolean} true if a net was loaded
   */
  addDaughterNet(type) {
    const arm = this.findDaughterNeedingNet(type);
    if (!arm) return false;
    arm.setNetInventory(arm.getNetInventory() + 1);
    return true;
  }

  /**
   * Re-apply all stored shop upgrades to current arms.
   * Called after reset() has field-reset the existing ArmUnit instances
   * (they are reused, not recreated).
   * @private
   */
  _reapplyStoredUpgrades() {
    for (const [effect, value] of Object.entries(this._storedUpgrades)) {
      // V5: Handle spring/tether tier upgrades
      if (effect === 'springTier') {
        this.applySpringUpgrade(value);
        continue;
      }
      if (effect === 'tetherTier') {
        this.applyTetherUpgrade(value);
        continue;
      }
      for (const arm of this.arms) {
        arm.applyUpgradeOverride(effect, value);
      }
    }
  }

  // ==========================================================================
  // V4 UPGRADES (Unlockable GSL technology)
  // ==========================================================================

  /**
   * Apply V4 "Opussy" GSL technology upgrade.
   * @private
   * @param {string} upgrade - One of: 'gslTether', 'gslNet', 'electrostaticNet'
   */
  _applyV4Upgrade(upgrade) {
    switch (upgrade) {
      case 'gslTether':
        // GSL tethers: 6× lighter → extend reach by TETHER_LENGTH_MULT
        for (const arm of this.arms) {
          arm.config.tetherMax = Math.round(arm.config.tetherMax * Constants.V4_TETHER_LENGTH_MULT);
        }
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: 'V4 GSL tethers installed. Reach extended to 12.5 km',
          priority: 'success',
        });
        break;

      case 'gslNet':
        // GSL nets: 10× larger at same mass
        for (const arm of this.arms) {
          arm.config.netSize = arm.config.netSize * Constants.V4_NET_SIZE_MULT;
        }
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: 'V4 GSL nets installed. 50×50m capture area',
          priority: 'success',
        });
        break;

      case 'electrostaticNet':
        // Electrostatic capture: increased capture success
        for (const arm of this.arms) {
          // Boost capture rate (was 85%, now ~95%)
          // This is handled in ArmUnit._updateNetting via a flag
          arm._v4Electrostatic = true;
        }
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: 'V4 HBN-coated electrostatic nets. Capture rate improved',
          priority: 'success',
        });
        break;
    }
  }

  // ==========================================================================
  // RESET / DISPOSE
  // ==========================================================================

  /**
   * Reset all arms to docked with full fuel, then re-apply stored upgrades.
   */
  reset() {
    // trip-melt-2 (carry): a carry in progress lets go of its tip reservation, the strut reservation and the radiator hold
    // first (this reset sets the fields below directly and never calls ArmUnit.reset, which would have done it).
    this.abortAllCarries('reset');
    // Register item 71: release the cargo this reset drops BEFORE the fields
    // clear. Every other unpin lives on a non-reset path (_releaseCapturedDebris
    // / the rack feed-end / _clearCatchPins / the lasso releases), so a dropped
    // piece kept _armPinned/_armPinPos/_capturedByArm set and DebrisField
    // rendered it glued at the stale slot forever — drawn, but in no ledger
    // (the continuity law's inverse violation). Release to a free,
    // re-targetable body re-seated at the pin the player last saw.
    const _player = this.playerSatellite;
    const _releaseVel = (_player && typeof _player.getVelocity === 'function')
      ? _player.getVelocity() : null;
    for (const arm of this.arms) {
      this._releaseDroppedCargo(arm.heldCatches, _releaseVel);
      if (arm.capturedDebris) this._releaseDroppedCargo([arm.capturedDebris], _releaseVel);
      // Register item 78: a tether-snapped catch stays pinned to the drifting
      // EXPENDED daughter (keepPinned keeps _capturedByArm; _updateExpended
      // re-pins it every frame until TETHER_SNAP_RELEASE_DELAY_S releases it).
      // The reset re-docks the arm inside that drift window unless the pin
      // releases first — else the piece ghosts at the stale drift pin, drawn,
      // in no ledger, with _capturedByArm on a now-DOCKED arm (the item-71
      // ghost through the captor back-reference). Same seam: flags + re-seat,
      // then drop the tracking fields.
      if (arm._severedCatch) {
        this._releaseDroppedCargo([arm._severedCatch], _releaseVel);
        arm._severedCatch = null;
        arm._severedDriftS = 0;
      }
      arm.state = ARM_STATES.DOCKED;
      arm.fuel = 100;
      arm.coldGasKg = arm._coldGasBottleKg();   // reel-gas: the bottle is reset wherever the FEEP fuel is
      // Register item 80: an SK target's LOD-protection flag must not survive
      // the reset. The SK session's own reference is _stationKeepTarget (set
      // together with the debris-side flag at SK entry, ArmUnit.js:3005/:3122)
      // and every live SK exit clears the flag on it (ArmUnit _exitStationKeep
      // and siblings). reset() drops the target assignment itself, so clear the
      // flag on the same reference before dropping both — otherwise the piece
      // keeps skipping LOD downscaling forever (DebrisField.js:2115), a free
      // body rendering at full detail past the 50 km cull.
      if (arm._stationKeepTarget) arm._stationKeepTarget._isStationKeepTarget = false;
      arm._stationKeepTarget = null;
      arm.target = null;
      arm.capturedDebris = null;
      arm.heldCatches = [];               // S6: the parked cargo rack resets too
      arm.captures = 0;
      arm.stateTimer = 0;
      arm.tetherLength = 0;
      arm.velocity.set(0, 0, 0);
      arm.mesh.visible = false;
      arm.tetherLine.visible = false;
      arm._webShotCooldown = 0;      // Sprint D1: clear web shot state
      arm._webShotTarget = null;
      arm.isDetached = false;         // Phase 6: reset detach state
      arm._detachFuelWarning25 = false;
      arm._detachFuelWarning10 = false;
      // V5: Reset crossbow state
      arm.springCharged = true;
      arm.reloadProgress = 0;
      arm.reloadDuration = 0;
      arm.tetherTension = 0;
      arm.reeling = false;
      arm.launchDirection = null;
    }

    // Register item 69: the loop above clears every rack — a cargo mass-exit —
    // but sets arm.state directly, so no ARM_STATE_CHANGE crosses it and the
    // cleared mass would ride the rotational model until the next arm/berth
    // event. Invalidate the attitude-inertia cache directly at the exit site,
    // the item-63/67 seam (reset-side). The berthed/collared side needs
    // nothing: those nets survive the reset with their mass (no reset path
    // touches captureNetSystem.activeNets), so the ledger never loses them.
    if (this.playerSatellite) this.playerSatellite._attitudeInertia = null;

    // V5: Reset pulse scan state
    this._pulseScanCooldown = 0;
    this._pulseScanTimer = 0;
    this._pulseScanActive = false;

    // arms-auto: forget the automatic-pose state and any manual-override markers.
    if (this._strutAuto) this._strutAuto.reset();
    this._strutPress = 0;
    this._allFullSaid = false;        // hold-catch: the "all daughters are holding catches" line may be said again
    this.lastStrutPressNote = null;
    this._pendingStrutNote = null;
    this._missionCarrySaid = null;
    for (const arm of this.arms) { delete arm._strutManual; delete arm._holdPose; }

    // Re-apply any purchased upgrades to the freshly reset arms
    this._reapplyStoredUpgrades();
  }

  /**
   * Register item 71 — release the pieces reset() drops (the rack + the in-hand
   * scalar) back to the field as free, re-targetable bodies. Mirrors the
   * release idiom of ArmUnit._releaseCapturedDebris (haul failure) and
   * CaptureNetSystem._clearCatchPins (mother exits): clears the authoritative
   * pin AND the captor back-reference — both must go, or DebrisField's
   * _pinToArm branch re-pins the piece to the freshly re-docked arm (the ghost
   * in a different costume) — and re-seats the orbit from the shown pin via
   * the ONE shared computation (reseatOrbitFromScene, the §8 A2
   * _reseatOrbitOnRelease seam). Without a player velocity the re-seat skips
   * and the piece resumes its live orbit (the orbit kept propagating under the
   * pin — DebrisField freezes only _onboardingPinned/_motherParked).
   * @param {Array<object>|null} pieces
   * @param {{x:number,y:number,z:number}|null} releaseVel km/s (Y-up scene frame)
   * @private
   */
  _releaseDroppedCargo(pieces, releaseVel) {
    if (!pieces) return;
    for (const d of pieces) {
      if (!d) continue;
      reseatOrbitFromScene(d.orbit, d._scenePosition, releaseVel);
      d._armPinned = false;
      d._armPinPos = null;
      d._capturedByArm = null;
      d._captured = false;             // re-targetable — a chase-able object again
      d._isStationKeepTarget = false;
      d._committedNetArmId = null;
      d._netted = true;                // drifting in its net (the haul-failure idiom)
      d._breakdownActive = false;      // a mid-chop reset owns no furnace timeline
      d._catchRenderMin = 0;           // the held-readability floor dies with the hold
      clearRackCell(d);                // rack-snug: and the cell it held on her
    }
  }

  /**
   * no-melt: the station takes the catches parked on the daughters' racks (the resupply stop; GameFlowManager).
   * Each paid piece leaves the rack and is returned for the caller to remove from the field; the rack is cleared, so
   * ArmUnit's empty-rack fallback sends her to reload next frame and she can launch again. A piece that is not yet
   * paid is left on the rack. Emits NET_CONSUMED per piece (the bag visual clears the way the cook's end does); no
   * CATCH_PROCESSED (nothing is credited or digested).
   * @param {(piece: object) => boolean} [isPaid] - true when the piece has been credited (default: `_credited`)
   * @returns {Array<object>} the pieces handed over
   */
  unloadHeldCatches(isPaid) {
    const paid = typeof isPaid === 'function' ? isPaid : (d) => !!(d && d._credited);
    const out = [];
    for (const arm of this.arms) {
      if (!arm || arm.state !== ARM_STATES.HOLDING_CATCH || !Array.isArray(arm.heldCatches)) continue;
      const keep = [];
      for (const d of arm.heldCatches) {
        if (!d) continue;
        if (!paid(d)) { keep.push(d); continue; }
        d._armPinned = false;
        d._armPinPos = null;
        d._capturedByArm = null;
        d._breakdownActive = false;
        clearRackCell(d);               // rack-snug: it leaves her rack
        out.push(d);
        eventBus.emit(Events.NET_CONSUMED, { armIndex: arm.index, armId: arm.id, debrisId: d.id });
      }
      if (keep.length !== arm.heldCatches.length) {
        arm.heldCatches = keep;
        arm.stateTimer = 0;
      }
    }
    if (out.length > 0) {
      const ps = this.playerSatellite;
      if (ps && '_attitudeInertia' in ps) ps._attitudeInertia = null;
    }
    return out;
  }

  // ========================================================================
  // arms-auto — the daughter arms mostly move themselves (DECISIONS §25 ruling 5)
  // ========================================================================

  /**
   * Hand the once-per-player record to the automation (main.js, next to setDebrisField).
   * No store (tests, a bare boot) → the full-range show never runs.
   * @param {import('../systems/StrutAuto.js').StrutAutoStore|null} store
   */
  setStrutAutoStore(store) { this._strutAutoStore = store || null; }

  /**
   * Per frame, after the launch gates: run the StrutAuto controller over this manager's
   * state. Inert unless FEATURE_FLAGS.STRUT_AUTO and a debris field is wired (production
   * wires it; the bare mocks of most tests never do).
   * @param {number} dt
   * @private
   */
  _updateStrutAuto(dt, paused = false) {
    if (!this._strutAuto) return;                  // bare Object.create(ArmManager.prototype) test objects
    if (paused) { this._strutAuto.suspend(); return; }   // menu / briefing / shop: no show, no auto moves
    if (!this._strutAutoView) this._strutAutoView = this._buildStrutAutoView();
    this._strutAuto.update(dt, this._strutAutoView);
  }

  /** The read-only snapshot + few actions StrutAutoController works through. @private */
  _buildStrutAutoView() {
    const self = this;
    const CN = Constants.CAPTURE_NET;
    const ST = CN.STATES;
    const INBOUND = new Set([ST.CINCH_CLOSING, ST.SECURE_CHECK, ST.CAPTURED, ST.REELING]);
    const OVER = new Set([ST.FOLDED, ST.STOWED, ST.MISSED, ST.RELEASED]);
    const motherNets = () => {
      const cns = self.playerSatellite && self.playerSatellite._captureNetSystem;
      const nets = cns && Array.isArray(cns.activeNets) ? cns.activeNets : null;
      return nets ? nets.filter((n) => n && n._isMother) : [];
    };
    return {
      get arms() { return self.arms; },
      get headless() { return !(self.playerSatellite && self.playerSatellite.strutGroups); },
      get store() { return self._strutAutoStore; },
      inert() {
        const p = self.playerSatellite;
        return Constants.FEATURE_FLAGS.STRUT_AUTO !== true
          || !self._debrisField
          || !!(p && p.safeMode)
          || !!(p && typeof p._danceDrivesMe === 'function' && p._danceDrivesMe());
      },
      busy() {
        if (self._pendingLaunches && self._pendingLaunches.size > 0) return true;
        if (self._leanAsideActive) return true;
        for (const a of self.arms) {
          if (!a) continue;
          if (a._aimReserved) return true;
          if (a.state === ARM_STATES.LAUNCHING || a.state === ARM_STATES.UNDOCKING) return true;
        }
        const ld = self.playerSatellite && self.playerSatellite.leashDriver;
        return !!(ld && typeof ld.isActive === 'function' && ld.isActive());
      },
      catchActive() {
        const ld = self.playerSatellite && self.playerSatellite.leashDriver;
        if (ld && typeof ld.isActive === 'function' && ld.isActive()) return true;
        return motherNets().some((n) => !OVER.has(n.state));
      },
      netInFlight() {
        const cns = self.playerSatellite && self.playerSatellite._captureNetSystem;
        const nets = cns && Array.isArray(cns.activeNets) ? cns.activeNets : [];
        return nets.some((n) => n && !OVER.has(n.state));
      },
      inboundNetRadiusM() {
        let r = null;
        for (const n of motherNets()) {
          if (!INBOUND.has(n.state)) continue;
          const d = n.targetDebris;
          if (!d || !d.sizeMeter) continue;       // unresolved size: never duck (the lean-aside rule)
          const rr = d.sizeMeter / 2 + (CN.BERTH_CLEARANCE_M ?? 1.0);
          if (r === null || rr > r) r = rr;
        }
        return r;
      },
      duck(radiusM) { self._duckFoulingStruts(radiusM); },
      pressCount() { return self._strutPress | 0; },
      nearestPieceM() { return self._nearestFreePieceM(); },
      gapAt(arm, alphaRad) { return self._strutGapAt(arm, alphaRad); },
      say(text) {
        eventBus.emit(Events.COMMS_MESSAGE, { text, priority: 'info' });
      },
    };
  }

  /**
   * Metres to the nearest discovered, free (not netted, not pinned) piece within the
   * "leave" ring (NET_LOCK_RANGE_M x STRUT_AUTO.LEAVE_FACTOR) of the ship; Infinity when none.
   * Always re-filtered by distance: a same-frame call can hand back a cached larger set.
   * @returns {number}
   * @private
   */
  _nearestFreePieceM() {
    const df = this._debrisField;
    const p = this.playerSatellite;
    if (!df || typeof df.getDebrisNear !== 'function' || !p) return Infinity;
    const pos = p.position || (p.mesh && p.mesh.position);
    if (!pos) return Infinity;
    const V = Constants.OCTOPUS_V5.STRUT_AUTO;
    const reachM = Constants.NET_LOCK_RANGE_M * V.LEAVE_FACTOR;
    const list = df.getDebrisNear(pos, reachM * M) || [];
    let best = Infinity;
    for (const d of list) {
      if (!d || d.alive === false) continue;
      // canonical flag: the frame cache can hold pre-reveal snapshots (main.js does the same)
      const live = typeof df.getDebrisById === 'function' ? df.getDebrisById(d.id) : null;
      const src = live || d;
      if (src.discovered === false) continue;
      if (src._captured || src._armPinned || src._capturedByArm) continue;
      const m = typeof d.distance === 'number' ? d.distance / M : Infinity;
      if (m <= reachM && m < best) best = m;
    }
    return best;
  }

  /**
   * Show safety net: clearance (m) of arm `arm`'s strut + daughter at sweep angle `alphaRad`
   * against the ship, from a thin strut capsule plus a daughter sphere. Infinity when there
   * is no keep-out (mock ship). Own strut/daughter/rack are ignored.
   * @private
   */
  _strutGapAt(arm, alphaRad) {
    const ko = this.getKeepOut();
    const i = this.arms.indexOf(arm);
    if (!ko || i < 0) return Infinity;
    const V5 = Constants.OCTOPUS_V5;
    const az = Math.atan2(arm.dockOffset.y, arm.dockOffset.x);
    const d = strutLocalDirection(alphaRad, az, new THREE.Vector3());
    const hinge = [Math.cos(az) * V5.COLLAR_RADIUS, Math.sin(az) * V5.COLLAR_RADIUS, V5.COLLAR_Y];
    const L = V5.STRUT_LENGTH;
    const start = [hinge[0] + d.x * 0.30, hinge[1] + d.y * 0.30, hinge[2] + d.z * 0.30];
    const tip = [hinge[0] + d.x * L, hinge[1] + d.y * L, hinge[2] + d.z * L];
    const ignore = ['dau' + i, 'strut' + i, 'rack catch ' + i];
    const rStrut = (V5.STRUT_TUBE_OD ?? 0.05) / 2 + 0.03;
    const a = ko.segment(start, tip, rStrut, { ignore });
    const b = ko.sphere(tip, 0.13, { ignore });
    return Math.min(a.gap, b.gap);
  }

  /**
   * Dispose all arms and remove from scene.
   */
  dispose() {
    for (const arm of this.arms) {
      arm.dispose();
    }
    this.arms = [];
  }

  // ==========================================================================
  // L2 — LAUNCH LINE: nothing is fired into a part of the ship
  // ==========================================================================
  // Every launch path (ceremony, key D by index, free-fly, trawl, fan-out, dual
  // fire) goes through `_launchArm` → `requestClearLaunch`. The line is the
  // daughter's body swept 15 m along the direction she will fire, checked
  // against the ship's REAL triangles (ShipKeepOut). Known limit: the line is
  // not re-checked during the 1.5 s magnetic-clamp hold before the spring fires
  // (CROSSBOW_UNDOCK_TIME) — a strut moved in that window is not caught.

  /**
   * One ShipKeepOut for this manager's ship (lazy). Null when there is no real
   * ship (bare-ArmUnit tests, mock ships): the launch gate is then a no-op.
   *
   * Held-catch obstacles are supplied through `setSphereProvider`:
   * the nose catch (CaptureNet BERTHED/COLLARED/TRANSFERRING) at its REAL radius
   * `sizeMeter / 2` + 0.05 m of net margin — NOT the 2 m readability floor
   * (`MOTHER_CATCH_MIN_RENDER_M` is a drawing floor, Ruling 0: physically real) —
   * and every daughter's parked rack (`heldSlotWorldInto`). Lane l5a feeds tip
   * bags in by extending `_heldCatchSpheres` (push `{ c: [x,y,z] ship metres,
   * r, name, cat: 'catch' }`) or by calling `getKeepOut().setSphereProvider(fn)`
   * with a wrapper that also returns `this._heldCatchSpheres()`.
   * @returns {ReturnType<typeof createShipKeepOut>|null}
   */
  getKeepOut() {
    const p = this.playerSatellite;
    if (!p || typeof p.updateWorldMatrix !== 'function' || typeof p.traverse !== 'function') return null;
    if (!this._keepOut || this._keepOutShip !== p) {
      this._keepOut = createShipKeepOut({ player: p, armManager: this });
      this._keepOutShip = p;
      this._keepOut.setSphereProvider(() => this._heldCatchSpheres());
    }
    return this._keepOut;
  }

  /**
   * Held catches as keep-out spheres in the SHIP frame, metres. Called by the
   * keep-out once per query, after it has brought the matrices up to date.
   * @returns {Array<{c:number[], r:number, name:string, cat:string}>}
   * @private
   */
  _heldCatchSpheres() {
    const out = this._catchSpheres || (this._catchSpheres = []);
    out.length = 0;
    const p = this.playerSatellite;
    if (!p || !p.matrixWorld) return out;
    const inv = this._koInv || (this._koInv = new THREE.Matrix4());
    const v = this._koVec || (this._koVec = new THREE.Vector3());
    inv.copy(p.matrixWorld).invert();
    const push = (worldScene, radiusM, name) => {
      v.copy(worldScene).applyMatrix4(inv).multiplyScalar(1 / M);
      out.push({ c: [v.x, v.y, v.z], r: radiusM, name, cat: 'catch' });
    };

    // The nose catch held by the mother net.
    const CN = Constants.CAPTURE_NET;
    const cns = p._captureNetSystem;
    const nets = cns && Array.isArray(cns.activeNets) ? cns.activeNets : null;
    if (nets && CN && CN.STATES) {
      const S = CN.STATES;
      for (const net of nets) {
        if (!net || !net._isMother) continue;
        if (net.state !== S.BERTHED && net.state !== S.COLLARED && net.state !== S.TRANSFERRING) continue;
        const d = net.targetDebris;
        if (!d || !d._scenePosition) continue;
        push(d._scenePosition, (d.sizeMeter || 2) / 2 + 0.05, 'nose catch');
      }
    }

    // Bags held on the radiator tips (lane l5b-wire). Raw bag radius, no net margin: the measured
    // hand-off clearances (tmp/probes/leash/multi2) are against the bag itself.
    const tc = p.tipCargo;
    if (tc && typeof tc.count === 'function' && tc.count() > 0) {
      for (const sp of tc.spheres()) {
        out.push({ c: [sp.c.x, sp.c.y, sp.c.z], r: sp.r, name: `tip bag ${sp.name.split('_')[1]}`, cat: 'catch' });
      }
    }

    // Pieces parked on a daughter's rack.
    const slot = this._koSlot || (this._koSlot = new THREE.Vector3());
    for (let i = 0; i < this.arms.length; i++) {
      const arm = this.arms[i];
      const held = arm && arm.heldCatches;
      if (!held || held.length === 0 || typeof arm.heldSlotWorldInto !== 'function') continue;
      for (let k = 0; k < held.length; k++) {
        const d = held[k];
        if (!d) continue;
        const size = d.sizeMeter || 1;
        // rack-snug (Decision 4): the sphere sits where the piece IS — its cell on her, not a slot in a hold axis.
        // Decision 7: its radius is the drawn reach from that point (true size), not sizeMeter / 2.
        // rack-centre fix round 1: during the 1 s cell-1 → cell-0 slide it is where the piece is drawn NOW, not the slide's end.
        if (!(d._rackSlide && typeof arm.heldDrawnWorldInto === 'function' && arm.heldDrawnWorldInto(d, slot, p.quaternion))) {
          arm.heldSlotWorldInto(k, size, p.position, slot, d, p.quaternion);
        }
        push(slot, DebrisField.trueReachM(d, size) + 0.05, `rack catch ${i}`);
      }
    }
    return out;
  }

  /** Ship-frame unit vector: origin → strut tip of `arm` (what free-fly / trawl fire along). @private */
  _dockDirShip(arm) {
    return arm.dockOffset.clone().normalize();
  }

  /** Ship-frame unit vector along the arm's CURRENT strut (what deploy() fires along after the aim ceremony). @private */
  _strutDirShip(arm) {
    const az = Math.atan2(arm.dockOffset.y, arm.dockOffset.x);
    return strutLocalDirection(arm.getAimAlpha(), az, new THREE.Vector3()).normalize();
  }

  /** World (scene) direction → ship frame. @private */
  _worldToShipDir(vec) {
    const q = this.playerSatellite && this.playerSatellite.quaternion;
    const out = new THREE.Vector3(vec.x, vec.y, vec.z);
    if (q) out.applyQuaternion(q.clone().invert());
    return out.normalize();
  }

  /**
   * The direction `ArmUnit.deploy(target)` will fire along, in the ship frame:
   * the converged strut after an aim ceremony, else the direct bearing to the
   * target, else (no target position) the dock direction.
   * @private
   */
  _launchDirShip(arm, target) {
    const tp = target && target._scenePosition;
    if (!tp) return this._dockDirShip(arm);
    if (arm._aimConverged) return this._strutDirShip(arm);
    return this._worldToShipDir(new THREE.Vector3(tp.x - arm.position.x, tp.y - arm.position.y, tp.z - arm.position.z));
  }

  /** Trawl direction (world, optional) in the ship frame. @private */
  _trawlDirShip(arm, direction) {
    return direction ? this._worldToShipDir(direction) : this._dockDirShip(arm);
  }

  /**
   * Launch `arm` at `target` (deploy) or free-fly (no target) through the gate.
   * @private
   */
  _launchTargetOrFree(arm, target, opts) {
    return target
      ? this._launchArm(arm, 'target', () => this._launchDirShip(arm, target), () => arm.deploy(target), opts)
      : this._launchArm(arm, 'freefly', () => this._dockDirShip(arm), () => arm.deployFreefly(), opts);
  }

  /**
   * The ONE seam every ArmManager launch call site goes through.
   * @param {ArmUnit} arm
   * @param {string} mode — 'ceremony' | 'target' | 'freefly' | 'trawl' (for diagnostics)
   * @param {() => THREE.Vector3} getDirShip — fire direction in the SHIP frame, re-derived each call
   * @param {() => boolean} fire — the real ArmUnit call
   * @param {{announce?: boolean}} [opts] — see `deployArmByIndex`
   * @returns {boolean} true when the launch fired or was accepted (deferred); false when refused
   * @private
   */
  _launchArm(arm, mode, getDirShip, fire, opts) {
    const i = this.arms.indexOf(arm);
    if (i < 0) return !!fire();
    return this.requestClearLaunch(i, getDirShip, fire, mode, opts);
  }

  /**
   * Capsule from the daughter's body centre along `dirShip` for 15 m, radius =
   * her own half-width across that direction (measured from her mesh), ignoring
   * herself, her strut and her own rack. Reports every part the capsule touches.
   * @param {number} armIndex
   * @param {{x:number,y:number,z:number}|number[]} dirShip — ship frame, need not be unit
   * @returns {{blocked:boolean, part:string, cat:string, name:string, hits:Array<{name:string,cat:string,gap:number}>}}
   */
  launchLineBlocked(armIndex, dirShip) {
    const none = { blocked: false, part: '', cat: '', name: '', hits: [] };
    const ko = this.getKeepOut();
    const arm = this.arms[armIndex];
    if (!ko || !arm || !dirShip) return none;
    const raw = Array.isArray(dirShip) ? dirShip : [dirShip.x, dirShip.y, dirShip.z];
    const len = Math.hypot(raw[0], raw[1], raw[2]);
    if (!(len > 1e-9)) return none;
    const d = [raw[0] / len, raw[1] / len, raw[2] / len];

    const body = ko.measureCat('dau' + armIndex, d);
    let c, r;
    if (body.n > 0) {
      c = body.centre; r = body.halfWidth;
    } else {                                   // no mesh to measure: tip + table size
      c = [arm.dockOffset.x / M, arm.dockOffset.y / M, arm.dockOffset.z / M];
      r = Math.max(...(arm.config.bodyDims || [0.4])) / 2;
    }
    const L = 15;
    const res = ko.segment(c, [c[0] + d[0] * L, c[1] + d[1] * L, c[2] + d[2] * L], r, {
      hits: true,
      ignore: ['dau' + armIndex, 'strut' + armIndex, 'rack catch ' + armIndex],
    });
    if (!res.hits || res.hits.length === 0) return none;
    const h = res.hits[0];
    return { blocked: true, part: this._plainPart(h), cat: h.cat, name: h.name, hits: res.hits };
  }

  /** Plain-words name of a blocking part, for the comms line. @private */
  _plainPart(h) {
    const cat = (h && h.cat) || '';
    if (cat === 'wing') return 'a solar wing';
    if (cat === 'rad') return 'a radiator';
    if (cat === 'catch') return /^nose catch/.test(h.name || '') ? 'the catch at the nose' : 'a held catch';
    if (/^(strut|dau)\d+$/.test(cat)) return 'another strut';
    return 'the hull';
  }

  /**
   * Can the blockers on arm `i`'s line be moved out of the way by opening
   * struts to the open angle (90°)? Two cures exist:
   *   - another strut/daughter in the line: that arm is DOCKED, not held by the
   *     lean-aside duck, and not already at the open angle → open IT;
   *   - anything else (hull, nose, radiator, wing, held catch): the launching
   *     strut itself is below the open angle (the 0° park) → open IT, since the
   *     line is re-derived from the open pose. If the part is STILL in the way
   *     once the strut has arrived (own strut no longer movable), the launch is
   *     refused with that part's line.
   * The plan's literal rule only opened the own strut for the hull; the owner's
   * wording ("open ... struts to 90 or as needed") and the measured park
   * geometry (a 0° strut's line crosses folded radiators too) made that
   * too strict — logged in tmp/plans/l2-keepout.md.
   * @private
   */
  _launchVerdict(i, dirShip, mode) {
    const res = this.launchLineBlocked(i, dirShip);
    if (!res.blocked) return { blocked: false, fixable: true, open: [], openOwn: false, part: '', cat: '', hits: [] };
    const arm = this.arms[i];
    const openAlpha = Constants.OCTOPUS_V5.STRUT_DEPLOY_ALPHA;
    const tol = Math.PI / 180;
    const lean = this._leanAsideArmIndices;
    const ownLive = typeof arm.getAimAlpha === 'function' ? arm.getAimAlpha() : openAlpha;
    // A ceremony launch fires along the strut she has just aimed: her own strut is never
    // moved for it (a wing, radiator, catch or the hull in that line refuses, with its line).
    // launch-aim: an aimed launch (strut already swung toward the target) may open her own strut
    // toward 90° from EITHER side (e.g. 170° → 90°); the old gate only ever opened from below.
    const ownOffOpen = this._aimsStrut(mode) ? Math.abs(ownLive - openAlpha) > tol : ownLive < openAlpha - tol;
    const ownMovable = mode !== 'ceremony' && ownOffOpen && !lean.has(i)
      && typeof arm.setAimAlpha === 'function';
    const open = new Set();
    let openOwn = false;
    let stuck = null;
    for (const h of res.hits) {
      const m = /^(strut|dau)(\d+)$/.exec(h.cat);
      const n = m ? +m[2] : -1;
      const o = n >= 0 ? this.arms[n] : null;
      if (o && n !== i && o.state === ARM_STATES.DOCKED && !lean.has(n)
          && typeof o.getAimAlpha === 'function' && Math.abs(o.getAimAlpha() - openAlpha) > tol) {
        open.add(n);
      } else if (ownMovable) {
        openOwn = true;
      } else if (!stuck) {
        stuck = h;
      }
    }
    const shown = stuck || res.hits[0];
    return {
      blocked: true, fixable: !stuck, open: [...open], openOwn,
      part: this._plainPart(shown), cat: shown.cat, name: shown.name, hits: res.hits,
    };
  }

  /** Command the struts a blocked line needs open to the open angle (90°). @private */
  _openForLaunch(i, verdict) {
    const openAlpha = Constants.OCTOPUS_V5.STRUT_DEPLOY_ALPHA;
    for (const n of verdict.open) {
      const o = this.arms[n];
      if (o && o.state === ARM_STATES.DOCKED && !this._leanAsideArmIndices.has(n)) o._strutTargetAlpha = openAlpha;
    }
    if (verdict.openOwn) {
      const a = this.arms[i];
      if (a && !this._leanAsideArmIndices.has(i)) {
        a._strutTargetAlpha = openAlpha;
        const p = this._pendingLaunches && this._pendingLaunches.get(i);
        if (p) p.openedOwn = true;
      }
    }
  }

  /** No fire: one comms line + one event. @private */
  _launchHeld(i, verdict, reason) {
    const arm = this.arms[i];
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `Launch held: ${verdict.part} is in the way.`, priority: 'warning',
    });
    eventBus.emit(Events.ARM_LAUNCH_HELD, {
      armIndex: i, armId: arm ? arm.id : null, part: verdict.part, cat: verdict.cat, reason,
    });
  }

  /**
   * Drop a launch the keep-out gate is holding (the player's arrow key: AutopilotSystem._launchHoldManualRotate).
   * @param {number} i — arm index
   * @returns {boolean} true if one was waiting
   */
  cancelPendingLaunch(i) {
    const had = !!(this._pendingLaunches && this._pendingLaunches.has(i));
    if (had) this._dropPendingLaunch(i);
    return had;
  }

  /** Forget a pending launch and give back the arm reservation we took. @private */
  _dropPendingLaunch(i) {
    const pend = this._pendingLaunches;
    const p = pend && pend.get(i);
    if (!p) return;
    pend.delete(i);
    const arm = this.arms[i];
    if (arm && p.reservedByUs) arm._aimReserved = false;
    // launch-aim: a launch cancelled mid-swing stops the strut where it is (the latch is ours if it still holds our angle).
    if (arm && p.stage === 'aim' && arm._strutTargetAlpha === p.aimAlpha) arm._strutTargetAlpha = undefined;
  }

  /**
   * Gate a launch on a clear line. Clear → `fire()` now (same frame as before
   * the gate existed). Blocked only by what opening struts can clear → open them,
   * keep ONE pending launch (arm reserved) that re-checks every update() and
   * fires when clear, giving up after 8 s. Any other blocker → no fire. With no
   * real ship the gate is a no-op. A checker error fails OPEN (the launch fires):
   * a broken check must not strand the fleet.
   * @param {number} armIndex
   * @param {() => THREE.Vector3} getDirShip — ship-frame fire direction, re-derived every check
   * @param {() => boolean} fire
   * @param {string} [mode] — launch mode ('ceremony' never moves her own strut)
   * @param {{announce?: boolean}} [opts] — `announce`: the number-key launch; if the aim stage holds
   *   it back, it announces itself (the cut-scene start) when it fires.
   * @returns {boolean} fired, or accepted and waiting (true); refused (false)
   */
  requestClearLaunch(armIndex, getDirShip, fire, mode, opts) {
    if (tripRefuses('daughter')) return false;      // trip-melt D7: no launch while the ship burns to the next field
    const arm = this.arms[armIndex];
    if (!arm || !this.getKeepOut()) return !!fire();
    const pend = this._pendingLaunches || (this._pendingLaunches = new Map());
    if (pend.has(armIndex)) return true;

    // launch-aim: one driver per strut. The D-key ceremony reserves her while it aims; a second launch
    // request would swing her strut under it (the ceremony fires along the strut it converged on).
    if (Constants.FEATURE_FLAGS.LAUNCH_AIMS_STRUT === true && mode !== 'ceremony' && arm._aimReserved) {
      eventBus.emit(Events.COMMS_MESSAGE, { text: `Daughter ${arm.displayName} is already aiming.`, priority: 'warning' });
      return false;
    }

    // launch-aim: swing the strut toward where she is going first, then check the line along it.
    if (this._aimsStrut(mode)) {
      const r = this._requestAimedLaunch(armIndex, getDirShip, fire, mode, opts);
      if (r !== undefined) return r;                    // undefined = could not aim: today's gate below
    }

    let v;
    try {
      const dir = getDirShip();
      v = dir ? this._launchVerdict(armIndex, dir, mode) : { blocked: false };
    } catch (err) {
      if (!this._keepOutWarned) { this._keepOutWarned = true; console.warn('[ArmManager] launch-line check failed; launching unchecked:', err); }
      v = { blocked: false };
    }
    if (!v.blocked) return !!fire();
    if (!v.fixable) { this._launchHeld(armIndex, v, 'blocked'); return false; }

    const reservedByUs = !arm._aimReserved;
    arm._aimReserved = true;
    pend.set(armIndex, { armIndex, getDirShip, fire, mode, t: 0, stateTimer: arm.stateTimer || 0, reservedByUs });
    this._openForLaunch(armIndex, v);
    return true;
  }

  /**
   * Per-update tick for launches the gate is holding: cancel when the arm has
   * left DOCKED (or was reset), safe mode started, or the arm bus is off; fire
   * when the line is clear; keep the needed struts opening; give up after 8 s or
   * as soon as the remaining blocker is one opening cannot clear.
   * @param {number} dt
   * @private
   */
  _updateLaunchGates(dt) {
    const pend = this._pendingLaunches;
    if (!pend || pend.size === 0) return;
    for (const [i, p] of [...pend]) {
      const arm = this.arms[i];
      // reset() zeroes stateTimer, which otherwise only grows while DOCKED.
      if (!arm || arm.state !== ARM_STATES.DOCKED || (arm.stateTimer || 0) < p.stateTimer - 1e-6) {
        this._dropPendingLaunch(i);
        continue;
      }
      if (this.playerSatellite && this.playerSatellite.safeMode) {
        this._dropPendingLaunch(i);
        eventBus.emit(Events.COMMS_MESSAGE, { text: 'Launch cancelled: safe mode.', priority: 'warning' });
        continue;
      }
      if (powerDistribution.armMultiplier <= 0) {
        this._dropPendingLaunch(i);
        eventBus.emit(Events.COMMS_MESSAGE, { text: 'Launch cancelled: daughter power is off.', priority: 'warning' });
        continue;
      }
      p.t += dt;
      p.stateTimer = arm.stateTimer || 0;
      if (p.stage) { this._tickAimedLaunch(i, p, arm, dt); continue; }
      let v;
      try {
        const dir = p.getDirShip();
        v = dir ? this._launchVerdict(i, dir, p.mode) : { blocked: false };
      } catch (err) { v = { blocked: false }; }
      if (!v.blocked) {
        this._dropPendingLaunch(i);
        // The gate opened her strut to clear her line: it stops where the line cleared, so she never
        // floats off a strut that keeps swinging towards the full-open angle (owner: "to 90 or as needed").
        if (p.openedOwn && typeof arm.getAimAlpha === 'function') arm._strutTargetAlpha = arm.getAimAlpha();
        p.fire();
        continue;
      }
      if (!v.fixable) { this._dropPendingLaunch(i); this._launchHeld(i, v, 'blocked'); continue; }
      if (p.t >= 8) { this._dropPendingLaunch(i); this._launchHeld(i, v, 'timeout'); continue; }
      this._openForLaunch(i, v);
    }
  }

  // ==========================================================================
  // launch-aim — the strut aims first, then the spring pushes along it
  // (FEATURE_FLAGS.LAUNCH_AIMS_STRUT; lane launch-aim, 2026-10-16)
  // ==========================================================================
  // Every 'target' / 'freefly' / 'trawl' launch through `requestClearLaunch` first swings the
  // daughter's own strut — at its real motor rate (STRUT_SLEW_RATE, 15°/s), never faster — to the
  // best angle toward where she is going (`bestStrutAlpha`, capped short of a held catch's berth
  // corridor), then checks the launch line ALONG THE STRUT and fires with the push along the strut.
  // Pending entries carry `stage`: 'aim' (swinging; no line verdict — the swing path is not
  // checked: the full 0–180° range is measured clear of the ship's own parts) then 'line' (the
  // gate's old open-the-blockers logic, on the strut-axis line). OFF = today's gate, untouched.

  /** Does a launch in `mode` aim the strut first? ('ceremony' already aimed; bare modes keep the old gate.) @private */
  _aimsStrut(mode) {
    return Constants.FEATURE_FLAGS.LAUNCH_AIMS_STRUT === true
      && (mode === 'target' || mode === 'freefly' || mode === 'trawl');
  }

  /**
   * Radius (m) of the berth corridor of the catch the mother is holding or taking in
   * (`sizeMeter / 2 + BERTH_CLEARANCE_M`, the same radius the lean-aside duck uses), or null.
   * @private
   */
  _heldCatchCorridorRadiusM() {
    const cns = this.playerSatellite && this.playerSatellite._captureNetSystem;
    const nets = cns && Array.isArray(cns.activeNets) ? cns.activeNets : null;
    if (!nets) return null;
    const CN = Constants.CAPTURE_NET;
    let r = null;
    for (const n of nets) {
      if (!n || !n._isMother || AIM_CATCH_HELD_STATES.indexOf(n.state) < 0) continue;
      const d = n.targetDebris;
      if (!d || !d.sizeMeter) continue;                 // unresolved size: never cap (the lean-aside rule)
      const rr = d.sizeMeter / 2 + (CN.BERTH_CLEARANCE_M ?? 1.0);
      if (r === null || rr > r) r = rr;
    }
    return r;
  }

  /**
   * The strut angle arm `i` should swing to for a launch toward `wantedShip` (ship frame):
   * `bestStrutAlpha`, capped below the first angle (1° steps from her live angle toward it) at
   * which her tip would foul a held catch's berth corridor. Fouling only happens at the high
   * angles, so only an upward swing is capped; if her live angle already fouls, she stays.
   * @private
   */
  _aimAlphaFor(i, wantedShip) {
    const arm = this.arms[i];
    // bestStrutAlpha(dir exactly along ±z) can return -π (atan2(-0, negative)); |.| is the same strut angle in [0, π].
    const best = Math.min(Math.PI, Math.abs(bestStrutAlpha(wantedShip, Math.atan2(arm.dockOffset.y, arm.dockOffset.x))));
    const radiusM = this._heldCatchCorridorRadiusM();
    const now = arm.getAimAlpha();
    if (radiusM === null || best <= now) return best;
    const step = Math.PI / 180;
    let prev = now;
    for (let a = now + step; ; a += step) {
      const at = Math.min(a, best);
      if (this._strutFoulsInboundCorridor(i, radiusM, at)) return prev;
      prev = at;
      if (at >= best) return best;
    }
  }

  /** How much closer (rad) the strut axis at `toAlpha` points to `wantedShip` than at `fromAlpha`. @private */
  _aimGainRad(arm, wantedShip, fromAlpha, toAlpha) {
    const az = Math.atan2(arm.dockOffset.y, arm.dockOffset.x);
    const w = _aimTmpWanted.copy(wantedShip).normalize();
    const angTo = (alpha) => Math.acos(Math.max(-1, Math.min(1, strutLocalDirection(alpha, az, _aimTmpAxis).dot(w))));
    return angTo(fromAlpha) - angTo(toAlpha);
  }

  /**
   * Fire a launch whose strut is in place: nothing may move her strut while LAUNCHING (clear the
   * latch), and `_aimConverged` tells `deploy()` / `deployFreefly()` / `deployTrawl()` to push along
   * the strut axis. The flag never outlives the call.
   * @private
   */
  _fireAimed(i, fire) {
    const arm = this.arms[i];
    arm._strutTargetAlpha = undefined;
    arm._aimConverged = true;
    try { return !!fire(); } finally { arm._aimConverged = false; }
  }

  /**
   * The number-key launch fired after waiting to aim: what InputManager emits for an immediate one.
   * launch-seq: the cut-scene start only. The "deployed. Tracking…" line is gone; the one launch line is
   * "Spring released. Separating", from ArmUnit when the spring fires.
   * @private
   */
  _announceLaunch(arm) {
    eventBus.emit(Events.LAUNCH_CEREMONY_START, { arm });
  }

  /** The strut never swung into place: one comms line + one event. @private */
  _launchHeldAim(i) {
    const arm = this.arms[i];
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `Launch held: ${arm ? arm.displayName : 'daughter'}'s strut could not swing into place.`, priority: 'warning',
    });
    eventBus.emit(Events.ARM_LAUNCH_HELD, {
      armIndex: i, armId: arm ? arm.id : null, part: '', cat: '', reason: 'aim',
    });
  }

  /**
   * `requestClearLaunch` for an aimed mode. Returns true (fired or waiting), false (refused), or
   * undefined when the wanted direction cannot be derived (the caller falls back to today's gate).
   * @private
   */
  _requestAimedLaunch(armIndex, getDirShip, fire, mode, opts) {
    if (tripRefuses('daughter')) return false;      // trip-melt D7 (see requestClearLaunch)
    const arm = this.arms[armIndex];
    const pend = this._pendingLaunches;
    if (typeof arm.getAimAlpha !== 'function') return undefined;
    let wanted;
    try {
      wanted = getDirShip();
    } catch (err) {
      if (!this._keepOutWarned) { this._keepOutWarned = true; console.warn('[ArmManager] launch-aim direction failed; using the plain gate:', err); }
      return undefined;
    }
    if (!wanted) return undefined;

    // The dock direction (free-fly; a trawl without a direction) is the ray from the ship's centre through HER
    // OWN strut tip, so it moves whenever her strut moves: following it would chase its own tail (measured: a
    // free-fly launch swung to 155° and took 4-10 s instead of 2-3 s). Freeze it at the request; it does not
    // change when the ship turns (it is a ship-frame direction), so there is nothing to follow.
    if (mode === 'freefly' || (opts && opts.frozenAim)) {
      const frozen = wanted.clone();
      getDirShip = () => frozen;
    }

    const now = arm.getAimAlpha();
    const ducked = this._leanAsideArmIndices.has(armIndex);   // the duck owns her latch: never aim a ducked arm
    const aim = ducked ? now : this._aimAlphaFor(armIndex, wanted);
    const needAim = !ducked && Math.abs(aim - now) > AIM_TOL_RAD;
    const swingS = needAim ? Math.abs(aim - now) / Constants.OCTOPUS_V5.STRUT_SLEW_RATE : 0;
    const entry = {
      armIndex, getDirShip, fire, mode, opts: opts || null, t: 0, stateTimer: arm.stateTimer || 0,
      reservedByUs: !arm._aimReserved, stage: needAim ? 'aim' : 'line', aimAlpha: aim,
      aimDir: aim > now ? 1 : -1, reaims: 0,                 // reaims = REVERSALS of the aim so far (see _tickAimedLaunch)
      giveUpAt: swingS + 8,                              // the swing is not part of the 8 s patience
    };

    if (!needAim) {
      let v;
      try {
        v = this._launchVerdict(armIndex, this._strutDirShip(arm), mode);
      } catch (err) {
        if (!this._keepOutWarned) { this._keepOutWarned = true; console.warn('[ArmManager] launch-line check failed; launching unchecked:', err); }
        v = { blocked: false };
      }
      if (!v.blocked) return this._fireAimed(armIndex, fire);
      if (!v.fixable) { this._launchHeld(armIndex, v, 'blocked'); return false; }
      arm._aimReserved = true;
      pend.set(armIndex, entry);
      this._openForLaunch(armIndex, v);
      return true;
    }

    arm._aimReserved = true;
    arm._strutTargetAlpha = aim;
    pend.set(armIndex, entry);
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `Daughter ${arm.displayName}: aiming, about ${Math.max(1, Math.ceil(swingS - 1e-9))} s.`, priority: 'info',
    });
    return true;
  }

  /**
   * One tick of a pending aimed launch (the arm is still DOCKED, not cancelled).
   * 'aim': keep the latch on the best angle (the ship may turn, her tip moves as she swings) until
   * she is within 1° of it with the latch cleared (or the duck takes her); 'line': the gate's line
   * logic on the strut-axis line. Gives up at (swing time + 8 s).
   * @private
   */
  _tickAimedLaunch(i, p, arm, dt) {
    // Headless mocks have no ship strut driver: slew the latch here (the _updateCargoPlumePoses idiom).
    // (dt > 0 only: a zero-step call must not snap the strut.)
    if (dt > 0 && !(this.playerSatellite && this.playerSatellite.strutGroups)
        && arm._strutTargetAlpha !== undefined && typeof arm.setAimAlpha === 'function') {
      arm.setAimAlpha(arm._strutTargetAlpha, dt);
      if (Math.abs(arm.getAimAlpha() - arm._strutTargetAlpha) < 0.01) arm._strutTargetAlpha = undefined;
    }

    if (p.stage === 'aim') {
      if (this._leanAsideArmIndices.has(i)) {
        p.stage = 'line';                               // mid-aim duck: the duck owns her latch; aim ends where she is
      } else {
        let wanted = null;
        try { wanted = p.getDirShip(); } catch (err) { wanted = null; }
        if (wanted) {
          // Her tip (the bearing's origin) and the ship's own turn move the wanted direction, so the best
          // angle drifts: follow it when it moved > 1° AND the move points the strut closer to the wanted
          // direction by at least 0.5° and a quarter of the move. That second test stops a flip-flop when
          // the wanted direction is nearly tangential to her swing plane (the best angle then jumps
          // 0 <-> 180° while both are about equally far off: measured, a 46 m target did this for 17 s).
          // A follow-up that keeps the direction of the previous move (a ship turning steadily) is free;
          // only a REVERSAL counts toward AIM_MAX_REAIMS, so a flip-flop still ends after 4 and a steady
          // drift is bounded by the 0-180° range. Each follow-up adds its swing time to the give-up clock.
          const aim = this._aimAlphaFor(i, wanted);
          const move = Math.abs(aim - p.aimAlpha);
          if (move > AIM_TOL_RAD) {
            const dir = aim > p.aimAlpha ? 1 : -1;
            const reverses = dir !== p.aimDir;
            if ((!reverses || p.reaims < AIM_MAX_REAIMS)
                && this._aimGainRad(arm, wanted, p.aimAlpha, aim) > Math.max(AIM_GAIN_RAD, 0.25 * move)) {
              if (reverses) p.reaims++;
              p.aimDir = dir;
              p.aimAlpha = aim;
              p.giveUpAt += move / Constants.OCTOPUS_V5.STRUT_SLEW_RATE;
            }
          }
        }
        if (Math.abs(arm.getAimAlpha() - p.aimAlpha) > AIM_TOL_RAD) {
          arm._strutTargetAlpha = p.aimAlpha;           // (re)assert: another writer may have replaced the latch
        }
        if (arm._strutTargetAlpha === undefined && Math.abs(arm.getAimAlpha() - p.aimAlpha) <= AIM_TOL_RAD) {
          p.stage = 'line';
        } else if (p.t >= p.giveUpAt) {
          arm._strutTargetAlpha = undefined;
          this._dropPendingLaunch(i);
          this._launchHeldAim(i);
          return;
        }
      }
      if (p.stage === 'aim') return;
    }

    // line stage: the launch line is the strut axis from her tip.
    let v;
    try {
      v = this._launchVerdict(i, this._strutDirShip(arm), p.mode);
    } catch (err) { v = { blocked: false }; }
    if (!v.blocked) {
      this._dropPendingLaunch(i);
      if (this._fireAimed(i, p.fire) && p.opts && p.opts.announce) this._announceLaunch(arm);
      return;
    }
    if (!v.fixable) { this._dropPendingLaunch(i); this._launchHeld(i, v, 'blocked'); return; }
    if (p.t >= p.giveUpAt) { this._dropPendingLaunch(i); this._launchHeld(i, v, 'timeout'); return; }
    this._openForLaunch(i, v);
  }
}
