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
import { ArmUnit } from './ArmUnit.js';
import { engineGasKg, engineDeltaV, engineTankDryKg, engineGasLowFrac } from '../systems/ResourceSystem.js';

/** 1 meter in scene units */
const M = 0.00001;

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
]);
// Wave1 reel-drum feedback (2026-08-27): arm states where the daughter parks
// AT her strut tip → drum 'ready'. Mirrors ArmUnit._updateTether's hidden-line
// set (DOCKED/DOCKING/RELOADING/HOLDING_CATCH) minus EXPENDED, whose cartridge
// maps to 'empty'.
const _DRUM_HOME_STATES = new Set([
  ARM_STATES.DOCKED,
  ARM_STATES.DOCKING,
  ARM_STATES.RELOADING,
  ARM_STATES.HOLDING_CATCH,
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
]);

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
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'No daughters available for deployment (check spring charge)',
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
        text: 'Rotating to launch attitude — stand by.', priority: 'info',
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
   * Why the mother may NOT turn for a launch right now, in plain words, or null when she is free to turn.
   * Free = no daughter out on a line (rotation-lock tier 'none'), no launch in flight or waiting (another arm
   * LAUNCHING, an arm reserved, a pending launch, an aim running), no catch on the collar / nose (state + size:
   * `_heldCatchCorridorRadiusM`, whatever its mass), no hand-off, no scripted turn and no other system holding
   * the attitude (a mother-net reel-in). Catches latched on radiator tips and on daughters' racks do NOT block:
   * they are held rigidly and their inertia is already in the turn's gas bill (`getAttitudeInertia`).
   * @returns {string|null}
   * @private
   */
  _motherTurnBlock() {
    if (this.getRotationLockTier() !== 'none') return 'a daughter is out on her line';
    const ap = this._autopilot;
    if ((this._pendingLaunches && this._pendingLaunches.size > 0)
        || this.arms.some((a) => a && (a._aimReserved || a.state === ARM_STATES.LAUNCHING))
        || (ap && typeof ap.isAiming === 'function' && ap.isAiming())) {
      return 'a launch is in progress';
    }
    const ld = this.playerSatellite && this.playerSatellite.leashDriver;
    if (ld && typeof ld.isActive === 'function' && ld.isActive()) return 'a hand-off is running';
    if (this._heldCatchCorridorRadiusM() !== null) return 'a catch is on the collar';
    if (ap && typeof ap.isTurning === 'function' && ap.isTurning()) return 'a hand-off is running';   // a scripted turn takes an anonymous hold too
    if (ap && typeof ap.isReelInHeld === 'function' && ap.isReelInHeld()) return 'a catch is being reeled in';
    if (ap && typeof ap.isAttitudeHeld === 'function' && ap.isAttitudeHeld()) return 'a hand-off is running';
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
   * arms that are already resting / homing / spent (DOCKED, EXPENDED, RETURNING,
   * DOCKING) or parked with a catch (HOLDING_CATCH — recall refuses her, so
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
      if (arm.state === S.RETURNING) continue;
      if (arm.state === S.DOCKING) continue;
      if (arm.state === S.HOLDING_CATCH) continue; // parked with cargo — recall refuses her
      if (typeof arm.recall === 'function') {
        // Zero-fuel reel on the mothership tether motor: stuck / fuel-depleted
        // tethered daughters always come home (never abandoned as EXPENDED).
        arm.recall();
        count++;
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
   *     RETURNING, DOCKING, HOLDING_CATCH — those are already on their way
   *     home, unable to be recalled, or parked with a catch recall must not
   *     destroy).
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
      && a.state !== S.RETURNING
      && a.state !== S.DOCKING
      && a.state !== S.HOLDING_CATCH; // parked with cargo — recall refuses her

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
      const motherMass = 130; // kg
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
   * only, and decides from the live read (getAimAlpha, a pending latch winning
   * — never the latch alone, it clears to undefined on arrival).
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
   *   null when no DOCKED arm could take the write (nothing toggled — the
   *   caller should skip its emit).
   */
  toggleStruts(armIndex) {
    let docked = (this.arms || []).filter((a) => a && a.state === ARM_STATES.DOCKED);
    // A selected, docked daughter (the "." key passes her index): the same law, for her alone.
    // No index, or she is away → every docked arm, as before.
    if (Number.isInteger(armIndex) && armIndex >= 0) {
      const only = (this.arms || [])[armIndex];
      if (only && only.state === ARM_STATES.DOCKED) docked = [only];
    }
    if (!docked.length) return null;
    const V5 = Constants.OCTOPUS_V5;
    const anyOpen = docked.some((a) => _strutLiveAlpha(a) >= V5.STRUT_OPEN_THRESHOLD);
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
      return true;
    }

    this._lastStrutTap = now;
    const targetAlpha = anyOpen ? 0 : V5.STRUT_REST_ALPHA;
    for (const arm of docked) {
      arm._strutTargetAlpha = targetAlpha;
      if (autoOn) arm._strutManual = { quietS: 0 };
    }
    return !anyOpen;
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
   * Apply tether tier upgrade to all arms.
   * @param {number} tier - Tether tier index
   */
  applyTetherUpgrade(tier) {
    for (const arm of this.arms) {
      arm.setTetherTier(tier);
    }
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

    // Wave1: spin/amber the strut reel cartridges per live arm state.
    this._syncTetherDrums();

    // S9 strut posing (cargo-continuity plan §5, part 3; register item 32):
    // a loaded HOLDING_CATCH daughter whose cargo box sits in a plume cone at
    // her live booking re-poses to the measured safe band. Live, NOT
    // flag-gated — this changes how the arm MOVES, never what thrust refuses
    // (THRUSTER_INTERLOCK stays dormant and untouched). Runs AFTER arm.update
    // so aim writes land on fresh positions.
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
        const pieces = (arm.state === ARM_STATES.HOLDING_CATCH)
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
            arm.state === ARM_STATES.HOLDING_CATCH) {
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

  // ── S9: strut posing — held cargo stays out of the plumes (register 32) ───

  /**
   * S9 re-pose (cargo-continuity plan §5 part 3): on a bite — the arm's held
   * cargo box in any plume cone at its live booking while she is loaded
   * HOLDING_CATCH — her aim α eases to the measured safe band
   * (Constants.plumeCargoSafeAlphaMin for her largest piece; the band rows are
   * tmp/i32s9-box-probe.log's max-bite angles + a +10° margin, worst aspect).
   * Constraints, per the work order:
   *   • CAMERA: nearest feasible destination first — the pose family (a
   *     catch-relative hold beside the daughter; the lateral bias is untouched)
   *     survives because the swing takes the SHORTEST legal step, and the
   *     slew rate (STRUT_SLEW_RATE via setAimAlpha / _updateStruts) makes it
   *     a swing, never a snap. No comms line — the visible swing is the tell.
   *   • CORRIDOR: candidates cross no sister station's berth corridor —
   *     _repPoseCorridorClear, _corridorClear's strut-tip set as a
   *     destination-feasibility READ only. The live corridor gate stays
   *     strut-tips-only per S13(d). No feasible pose ⇒ hold course and retry
   *     next frame (the station clears when the transfer completes).
   * The aim coroutine already clamps α ∈ [0, π] so every destination here is
   * reachable. An arm parked at or above her floor can never present cargo to
   * a cone at ANY attitude (the attitude ring is the measured bound), so the
   * steady state is silent.
   * @param {number} dt — frame delta seconds
   * @private
   */
  _updateCargoPlumePoses(dt) {
    // Headless mocks lack the render-side strut driver — they slew HERE (the
    // S10 legacy-fallback idiom), including COMPLETING an already-vetted
    // swing whose bite cleared mid-way (never park half-swung); production
    // slews once, in _updateStruts, which owns the same latch.
    const headless = !(this.playerSatellite && this.playerSatellite.strutGroups);
    for (let i = 0; i < this.arms.length; i++) {
      const arm = this.arms[i];
      if (!arm || arm.state !== ARM_STATES.HOLDING_CATCH) continue;

      const conflict = heldCargoPlumeConflictAt(this, i);
      if (!conflict) {
        // No bite: keep finishing a latch the previous frames chose (the
        // _updateStruts contract), else stay silent.
        if (headless && arm._strutTargetAlpha !== undefined
          && typeof arm.setAimAlpha === 'function') {
          arm.setAimAlpha(arm._strutTargetAlpha, dt);
          if (Math.abs(arm.getAimAlpha() - arm._strutTargetAlpha) < 0.01) {
            arm._strutTargetAlpha = undefined; // arrived — the render driver's own rule
          }
        }
        continue;
      }

      // Destination floor from her LARGEST piece (band rows are size-keyed,
      // worst aspect — conservative for every type).
      let maxSiz = 0;
      if (arm.capturedDebris && arm.capturedDebris.mass) {
        maxSiz = Math.max(maxSiz, arm.capturedDebris.sizeMeter || 0);
      }
      if (Array.isArray(arm.heldCatches)) {
        for (const h of arm.heldCatches) {
          if (h && h.mass) maxSiz = Math.max(maxSiz, h.sizeMeter || 0);
        }
      }
      const floorRad = Constants.plumeCargoSafeAlphaMin(maxSiz);

      let destRad = null;
      const floorDeg = Math.ceil(floorRad * 180 / Math.PI);
      for (let aDeg = floorDeg; aDeg <= 180; aDeg += 5) {
        const cand = aDeg * Math.PI / 180;
        if (this._repPoseCorridorClear(i, cand)) { destRad = cand; break; }
      }
      if (destRad == null) continue; // no legal pose while the station holds — retry next frame

      arm._strutTargetAlpha = destRad;
      if (headless && typeof arm.setAimAlpha === 'function') {
        arm.setAimAlpha(destRad, dt);
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
      if (arm.state === ARM_STATES.DOCKED || arm.state === ARM_STATES.HOLDING_CATCH) {
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

    // Cold gas is CARRIED, not burned by the Hall engine (h3-argon-engine D4: it used to be counted as
    // burnable at Hall Isp, ~30 % too high): it sits in BOTH the loaded and the empty mass.
    const carriedDry = coreDry + coldGasCurrent + dockedArmMass + cargoMass;
    const wetMass = carriedDry + xenonCurrent;
    const dryMass = coreDry + dockedArmMass + cargoMass;   // reported, as before: without either gas

    // Tsiolkovsky for the engine: ΔV = Isp_eff x g0 x ln((dry + cold + gas) / (dry + cold)).
    // Isp_eff = the ACTIVE fuel's Isp / c (D5: shop upgrade x power split act as Isp gains).
    const fuel = this._resourceSystem ? this._resourceSystem.getCurrentFuel() : Constants.FUELS[gasRes.tankGasId];
    const c = (this.playerSatellite && typeof this.playerSatellite.getConsumptionMultiplier === 'function')
      ? this.playerSatellite.getConsumptionMultiplier() : 1;
    const ispActive = fuel && fuel.isp > 0 ? fuel.isp : Constants.OCTOPUS_CORE_HALL_ISP;
    const isp = ispActive / (c > 0 ? c : 1);   // effective Isp: the figure the ΔV and the flow share
    const deltaV = engineDeltaV({
      dryKg: coreDry + dockedArmMass + cargoMass, coldGasKg: coldGasCurrent, gasKg: xenonCurrent, isp: ispActive, c,
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
      text: `Selected ${arm.displayName} [${index + 1}]`,
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
  getRotationLockTier() {
    let tier = 'none';
    for (const arm of this.arms) {
      if (arm.isDetached) continue;             // free-flying — severed tether, no shear risk
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
    const eligible = this.arms
      .filter(a => a.type === type && a.state === ARM_STATES.DOCKED && a.springCharged && a.fuel > 5
        && !a._aimReserved);
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
  applyUpgrade(data) {
    // Store for re-application after reset
    this._storedUpgrades[data.effect] = data.value;

    // V5: Handle spring/tether tier upgrades
    if (data.type === 'springTier' || data.effect === 'springTier') {
      this.applySpringUpgrade(data.value || data.level);
      return;
    }
    if (data.type === 'tetherTier' || data.effect === 'tetherTier') {
      this.applyTetherUpgrade(data.value || data.level);
      return;
    }

    // Apply to all current arm units
    for (const arm of this.arms) {
      arm.applyUpgradeOverride(data.effect, data.value);
    }
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
    for (const arm of this.arms) delete arm._strutManual;

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
    }
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
        arm.heldSlotWorldInto(k, size, p.position, slot);
        push(slot, size / 2 + 0.05, `rack catch ${i}`);
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
