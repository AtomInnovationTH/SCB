/**
 * ArmManager.js — Manages the V5 Crossbow arm fleet
 * Config G top-collar 3-plane layout (ST-9.2).
 * Tier-aware: Y0 Quad (4), Y1 Hex (6), Y3 Octo (6 ring + 2 end-face).
 * Arms hinge at top collar (Y = +0.90 m), sweep 0–180° in meridian planes.
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
import { computeCoM, computeInducedTorque } from '../systems/CoMCalculator.js';
import { ArmUnit } from './ArmUnit.js';

/** 1 meter in scene units */
const M = 0.00001;

// V5 Constants (destructured for readability)
const {
  V5_ARM_COUNT, V5_FRONT_ARM_TYPE, V5_BACK_ARM_TYPE,
  V5_WEAVER_MASS, V5_SPINNER_MASS,
  DUALFIRE_SYNC_WINDOW, DUALFIRE_RECOIL_WEAVER, DUALFIRE_RECOIL_SPINNER, DUALFIRE_RCS_COMPENSATION_N2,
  PULSE_SCAN_DURATION, PULSE_SCAN_COOLDOWN, PULSE_SCAN_POWER, PULSE_SCAN_RANGE_MULT,
  CROSSBOW_LAUNCH_SPEED_MIN, CROSSBOW_LAUNCH_SPEED_MAX, CROSSBOW_LAUNCH_SPEED_DEFAULT,
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
  ARM_STATES.TANGLED,
  ARM_STATES.DEORBITING,
]);
const _SOFT_ROT_STATES = new Set([
  ARM_STATES.UNDOCKING,
  ARM_STATES.LAUNCHING,
  ARM_STATES.WEB_SHOT,
  ARM_STATES.TRANSIT,
  ARM_STATES.APPROACH,
  ARM_STATES.FISHING,
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
 * Ring arms hinge at the top collar (Y = COLLAR_Y = +0.90 m).
 * End-face arms (Y3 Octo only) hinge at the barrel end caps (±Z faces).
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
  const COLLAR_Y = V5.COLLAR_Y;           // 0.90 m
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
  if (tier.endFaceArms) {
    for (const face of tier.endFaceArms) {
      const isForward = (face === '+Z');
      const endZ = (isForward ? 1 : -1) * (V5.CORE_ACROSS_FLATS / 2);
      const azDeg = isForward ? 0 : 180;
      const theta = azDeg * Math.PI / 180;

      const outward = new THREE.Vector3(0, 0, isForward ? 1 : -1);
      // Swing axis for end-face arms: perpendicular to Z, lies in X direction
      const swingAxis = new THREE.Vector3(1, 0, 0);

      const type = isForward
        ? (V5_FRONT_ARM_TYPE || 'weaver')
        : (V5_BACK_ARM_TYPE || 'weaver');

      positions.push({
        type,
        offset: new THREE.Vector3(0, 0, endZ * M),
        angle: theta,
        azimuthDeg: azDeg,
        dockOutward: outward,
        swingAxis,
        hingePosition: new THREE.Vector3(0, 0, endZ * M), // end-cap hinge (not collar)
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

    /** @type {ArmUnit[]} */
    this.arms = [];

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

    // ST-9.11 C-5: Launch sequence lock — blocks strutDeploy/strutStow/fireDualPair
    this._launchLock = false;

    // V5 Pulse scan state
    this._pulseScanCooldown = 0;
    this._pulseScanTimer = 0;
    this._pulseScanActive = false;

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

    // Comms menu: deploy fishing/ambush mode (cast all)
    eventBus.on(Events.ARM_FISH, () => {
      this.deployFishing();
    });

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
        text: 'Arms locked — safe mode active. Repair subsystems first.',
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
        text: '⚠ ARM BEACON OFFLINE — increase ARM power to deploy',
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
        text: 'No arms available for deployment (check spring charge)',
        priority: 'warning',
      });
      return false;
    }

    // Check mass compatibility
    if (targetMass > arm.config.maxCaptureMass) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${arm.id} cannot capture ${targetMass}kg (max ${arm.config.maxCaptureMass}kg)`,
        priority: 'warning',
      });
      return false;
    }

    return arm.deploy(target);
  }

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
    return arm.deploy(target);
  }

  /**
   * Deploy a specific arm by index (0-based).
   * If target is provided, deploys toward target. If null, deploys in free-fly mode.
   * Used by number key deploy+select flow (Phase 1B).
   * @param {number} index - 0-based arm index
   * @param {object|null} target - Optional target to aim toward
   * @returns {boolean} true if deployment started
   */
  deployArmByIndex(index, target) {
    // ST-6.7: Safe-mode guard — refuse arm deployment when spacecraft is in safe mode
    if (this.playerSatellite && this.playerSatellite.safeMode) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Arms locked — safe mode active. Repair subsystems first.',
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
        text: `${arm.id}: Spring not charged — reloading`,
        priority: 'warning',
      });
      return false;
    }

    // Power distribution: block deployment if ARM bus is at 0%
    if (powerDistribution.armMultiplier <= 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: '⚠ ARM BEACON OFFLINE — increase ARM power to deploy',
        priority: 'warning',
      });
      return false;
    }

    if (target) {
      return arm.deploy(target);
    } else {
      // No target — deploy in free-fly mode (TRANSIT with manual control)
      return arm.deployFreefly();
    }
  }

  /**
   * Deploy an arm in passive fishing/ambush mode.
   * Arm extends on tether and hibernates, auto-capturing passing debris.
   * @param {THREE.Vector3} [direction] - Deploy direction (null = use dock offset)
   * @param {'weaver'|'spinner'|null} [preferType] - Preferred arm type
   * @returns {boolean}
   */
  deployFishing(direction = null, preferType = 'spinner') {
    // ST-6.7: Safe-mode guard — refuse arm deployment when spacecraft is in safe mode
    if (this.playerSatellite && this.playerSatellite.safeMode) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Arms locked — safe mode active. Repair subsystems first.',
        priority: 'warning',
      });
      return false;
    }

    // Power distribution: block deployment if ARM bus is at 0%
    if (powerDistribution.armMultiplier <= 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: '⚠ ARM BEACON OFFLINE — increase ARM power to deploy',
        priority: 'warning',
      });
      return false;
    }

    let arm = this._findDockedArm(preferType || 'spinner');
    if (!arm) arm = this._findDockedArm(preferType === 'spinner' ? 'weaver' : 'spinner');
    if (!arm) {
      eventBus.emit(Events.COMMS_MESSAGE, { text: 'No arms available for fishing', priority: 'warning' });
      return false;
    }
    return arm.deployFishing(direction);
  }

  /**
   * Deploy a docked arm in trawling mode — slow sweep for passive debris collection.
   * @param {{ x: number, y: number, z: number }|null} direction — trawl direction
   * @returns {boolean}
   */
  deployTrawl(direction = null) {
    // Power distribution: block deployment if ARM bus is at 0%
    if (powerDistribution.armMultiplier <= 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: '⚠ ARM BEACON OFFLINE — increase ARM power to deploy',
        priority: 'warning',
      });
      return false;
    }

    const maxTrawl = (Constants.TRAWLING && Constants.TRAWLING.MAX_TRAWL_ARMS) || 3;
    const trawling = this.arms.filter(a => a.state === ARM_STATES.TRAWLING);

    if (trawling.length >= maxTrawl) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'ARM-MGR', text: `Max trawl arms (${maxTrawl}) deployed`, priority: 'warning',
      });
      return false;
    }

    // Find a docked arm (prefer spinner type for trawling)
    let arm = this._findDockedArm('spinner');
    if (!arm) arm = this._findDockedArm('weaver');
    if (!arm) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'ARM-MGR', text: 'No docked arms available', priority: 'warning',
      });
      return false;
    }

    return arm.deployTrawl(direction);
  }

  /**
   * Fire a GSL web shot from a docked or fishing arm at a target debris.
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
        text: '⚠ ARM BEACON OFFLINE — increase ARM power for web shot',
        priority: 'warning',
      });
      return false;
    }

    // Sprint C2: Prefer selected arm if eligible
    if (this.selectedArmIndex >= 0 && this.selectedArmIndex < this.arms.length) {
      const selected = this.arms[this.selectedArmIndex];
      if ((selected.state === ARM_STATES.DOCKED || selected.state === ARM_STATES.FISHING) &&
          selected._webShotCooldown <= 0 && selected.fuel > Constants.WEB_SHOT_FUEL_COST) {
        if (selected.fireWebShot(target)) return true;
      }
    }

    // Find a docked/fishing arm (prefer type if given) with no cooldown
    const eligible = (a) =>
      (a.state === ARM_STATES.DOCKED || a.state === ARM_STATES.FISHING) &&
      a._webShotCooldown <= 0;

    let arm = preferType
      ? this.arms.find(a => a.type === preferType && eligible(a) && a.fuel > Constants.WEB_SHOT_FUEL_COST)
      : null;
    if (!arm) {
      arm = this.arms.find(a => eligible(a) && a.fuel > Constants.WEB_SHOT_FUEL_COST);
    }
    if (!arm) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'No arms available for web shot (cooldown or insufficient fuel)',
        priority: 'warning',
      });
      return false;
    }
    return arm.fireWebShot(target);
  }

  /**
   * Set reference to debris field for fishing proximity checks.
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
   * Issue deorbit sacrifice command to the first arm that has captured debris.
   * The arm burns all remaining FEEP fuel retrograde and is lost.
   * @returns {{ success: boolean, armId?: string, fuelAtStart?: number, totalMass?: number, debrisId?: number }}
   */
  deorbitCapturingArm() {
    // Sprint C2: Prefer selected arm if it's eligible for deorbit
    const isEligible = (a) =>
      (a.state === ARM_STATES.GRAPPLED ||
       a.state === ARM_STATES.HAULING ||
       a.state === ARM_STATES.RETURNING) &&
      (a.capturedDebris || a.target);

    let eligible = null;
    if (this.selectedArmIndex >= 0 && this.selectedArmIndex < this.arms.length) {
      const selected = this.arms[this.selectedArmIndex];
      if (isEligible(selected)) eligible = selected;
    }
    // Fallback: find first eligible arm
    if (!eligible) {
      eligible = this.arms.find(isEligible);
    }

    if (!eligible) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'No arm with captured debris available for deorbit sacrifice',
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
   * Priority: TANGLED > APPROACH > TRANSIT > FISHING > NETTING > GRAPPLED.
   * If ARM PILOT is active, prefer the piloted arm.
   * @returns {ArmUnit|null}
   */
  getActiveDetachCandidate() {
    const S = ARM_STATES;
    const PRIORITY = [S.TANGLED, S.APPROACH, S.TRANSIT, S.FISHING, S.NETTING, S.GRAPPLED];
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
        text: '⚠ SAFE MODE — arm deployment locked', priority: 'warning',
      });
      return 0;
    }
    // Power distribution guard
    if (powerDistribution.armMultiplier <= 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: '⚠ ARM BEACON OFFLINE — increase ARM power to deploy', priority: 'warning',
      });
      return 0;
    }

    let deployed = 0;
    for (const arm of this.arms) {
      if (arm.state !== ARM_STATES.DOCKED) continue;
      if (!arm.springCharged) continue;
      const ok = target ? arm.deploy(target) : arm.deployFreefly();
      if (ok) deployed++;
    }

    if (deployed > 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${deployed} arm${deployed > 1 ? 's' : ''} deployed${target ? ` → ${target.type || 'target'}` : ' (free-fly)'}`,
        priority: 'info',
      });
    } else {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'No arms available — check charge status',
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
      text: 'All arms recalled',
      priority: 'info',
    });
  }

  /**
   * Recall the single deployed daughter closest to the mother.
   *
   * Delegation 1 (2026-05-31) onboarding helper for the bare-R rebind:
   *   • Iterates this.arms.
   *   • Selects arms in any non-resting state (i.e. NOT DOCKED, EXPENDED,
   *     RETURNING, DOCKING — those are already on their way home or unable
   *     to be recalled).
   *   • Picks the candidate with the smallest world-space distance from
   *     the mother.
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
    // Any non-resting state — exclude arms already homing or expended.
    const eligible = [];
    for (let i = 0; i < this.arms.length; i++) {
      const a = this.arms[i];
      if (!a) continue;
      if (a.state === S.DOCKED) continue;
      if (a.state === S.EXPENDED) continue;
      if (a.state === S.RETURNING) continue;
      if (a.state === S.DOCKING) continue;
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

    // Deploy both within sync window
    const deployed1 = target1 ? arm1.deploy(target1) : arm1.deployFreefly();
    const deployed2 = target2 ? arm2.deploy(target2) : arm2.deployFreefly();

    if (deployed1 && deployed2) {
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

    return false;
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

  /**
   * Set the active arm tier (ST-9.2). Persists via PersistenceManager.
   * Used by C-10 shop refit when player upgrades to a new tier.
   * Does NOT rebuild arms — caller must dispose + reconstruct if live.
   * @param {string} tierName — 'Y0_QUAD', 'Y1_HEX', or 'Y3_OCTO'
   */
  setCurrentTier(tierName) {
    if (!Constants.ARM_LADDER[tierName]) return;
    this._activeTierKey = tierName;
    persistenceManager.setArmTier(tierName);
  }

  // ==========================================================================
  // ST-9.2 CONFIG G STRUT TIP GEOMETRY
  // ==========================================================================

  /**
   * Compute strut tip position at sweep angle α (ST-9.2 Config G).
   *
   * Convention (ARM_PIVOT_ANALYSIS.md §10.2):
   *   α = 0   → STOWED  (alongside barrel, daughter near −Y bottom)
   *   α = π/2 → EQUATORIAL (radial outward in XZ plane)
   *   α = π   → ZENITH  (pointing +Y, above Mother)
   *
   * Formula: tip = hinge + STRUT_LENGTH × ( sin(α)·outward − cos(α)·ŷ )
   *
   * Returns position in METERS (not scene units). Caller scales by M if needed.
   *
   * @param {number} armIndex — arm index
   * @param {number} alpha — sweep angle in radians [0, π]
   * @returns {{x: number, y: number, z: number}|null} Tip in meters, or null
   */
  getStrutTipPosition(armIndex, alpha) {
    if (!this._dockPositions || armIndex < 0 || armIndex >= this._dockPositions.length) return null;
    const dp = this._dockPositions[armIndex];
    const L = Constants.OCTOPUS_V5.STRUT_LENGTH; // 1.60 m

    // Hinge in meters (convert from scene units)
    const hx = dp.hingePosition.x / M;
    const hy = dp.hingePosition.y / M;
    const hz = dp.hingePosition.z / M;

    const sinA = Math.sin(alpha);
    const cosA = Math.cos(alpha);
    const ox = dp.dockOutward.x;
    const oy = dp.dockOutward.y; // 0 for ring arms; 0 for end-face Z-axis arms
    const oz = dp.dockOutward.z;

    return {
      x: hx + L * sinA * ox,
      y: hy + L * (sinA * oy - cosA), // −cos(α)·ŷ rotates through Y axis
      z: hz + L * sinA * oz,
    };
  }

  // ==========================================================================
  // ST-9.3 C-3: DUAL-FIRE + PAIRED-FIRE COORDINATION (Gap #14)
  // ==========================================================================

  /**
   * Fire an antipodal arm pair simultaneously for recoil cancellation.
   * Pre-fire gating: BOTH arms must be in an operational state that allows fire
   * (e.g., DOCKED) AND deployState === DEPLOYED AND hinge in ROTATE
   * (so we can auto-lock). If either arm fails gating, fire is rejected.
   *
   * @param {number} pairIndex — index of one arm in the pair (partner auto-resolved)
   * @param {number} [motherOmega=0] — |ω| of mother in rad/s (for safety interlock)
   * @returns {{ success: boolean, reason?: string }} Result with rejection reason if failed
   */
  fireDualPair(pairIndex, motherOmega = 0) {
    // ST-9.11 C-5: Block fire during launch sequence
    if (this._launchLock) {
      eventBus.emit(Events.ARM_DUAL_FIRE_REJECTED, { pairIndex, reason: 'launch_sequence_active' });
      return { success: false, reason: 'launch_sequence_active' };
    }

    const partnerIndex = this.getDualFirePair(pairIndex);
    if (partnerIndex === null) {
      const reason = `No antipodal partner for arm ${pairIndex}`;
      eventBus.emit(Events.ARM_DUAL_FIRE_REJECTED, { pairIndex, reason });
      return { success: false, reason };
    }

    const arm1 = this.arms[pairIndex];
    const arm2 = this.arms[partnerIndex];

    if (!arm1 || !arm2) {
      const reason = `Invalid arm index: ${pairIndex} or ${partnerIndex}`;
      eventBus.emit(Events.ARM_DUAL_FIRE_REJECTED, { pairIndex, reason });
      return { success: false, reason };
    }

    // Safety interlock: block fire if Mother angular rate too high
    if (!ArmUnit.isFireRateSafe(motherOmega)) {
      eventBus.emit(Events.ARM_FIRE_BLOCKED_HIGH_RATE, {
        omega: motherOmega,
        threshold: Constants.OCTOPUS_V5.FIRE_RATE_INTERLOCK,
      });
      return { success: false, reason: `Mother ω too high: ${(motherOmega * 180 / Math.PI).toFixed(1)}°/s` };
    }

    // C-4: Check deploy state — getDeployState() returns DEPLOYED when flag
    // OFF (backward-compat), or live state when STOW_DEPLOY_STATE_MACHINE ON.
    const DS = Constants.DEPLOY_STATES;
    const d1 = arm1.getDeployState();
    const d2 = arm2.getDeployState();

    if (d1 !== DS.DEPLOYED || d2 !== DS.DEPLOYED) {
      const reason = `Deploy state not ready: arm${pairIndex}=${d1}, arm${partnerIndex}=${d2}`;
      eventBus.emit(Events.ARM_DUAL_FIRE_REJECTED, { pairIndex, reason });
      return { success: false, reason };
    }

    // Check arm operational state (must be in a fireable state)
    const fireableStates = [ARM_STATES.DOCKED];
    if (!fireableStates.includes(arm1.state)) {
      const reason = `Arm ${pairIndex} in state ${arm1.state}, not fireable`;
      eventBus.emit(Events.ARM_DUAL_FIRE_REJECTED, { pairIndex, reason });
      return { success: false, reason };
    }
    if (!fireableStates.includes(arm2.state)) {
      const reason = `Arm ${partnerIndex} in state ${arm2.state}, not fireable`;
      eventBus.emit(Events.ARM_DUAL_FIRE_REJECTED, { pairIndex, reason });
      return { success: false, reason };
    }

    // Check spring charge
    if (!arm1.springCharged || !arm2.springCharged) {
      const reason = 'One or both arms not spring-charged';
      eventBus.emit(Events.ARM_DUAL_FIRE_REJECTED, { pairIndex, reason });
      return { success: false, reason };
    }

    // All gates passed — auto-lock both hinges, fire, then schedule auto-unlock
    arm1._autoLockForFire();
    arm2._autoLockForFire();

    // Compute residual recoil (§4.3: 2 × m × v × cos(α) along Y)
    const residualImpulse = arm1.computeRecoilResidual();

    // Emit dual-fire event
    eventBus.emit(Events.DUAL_FIRE, {
      armIndex1: pairIndex,
      armIndex2: partnerIndex,
    });

    // Emit recoil compensation event (for RCS handler)
    const motherMass = Constants.OCTOPUS_V5.TOTAL_WET_MASS;
    const residualDv = Math.abs(residualImpulse) / motherMass;
    // Approximate RCS N₂ cost: impulse / (Isp × g0)
    const rcsN2 = Math.abs(residualImpulse) / (60 * Constants.G0);

    eventBus.emit(Events.ARM_RECOIL_COMPENSATED, {
      residualImpulse,
      rcsN2Used: rcsN2,
    });

    eventBus.emit(Events.DUAL_FIRE_RECOIL, {
      cancelled: residualDv < 0.01,
      residualDv,
    });

    // C-11: Apply recoil angular impulse + CoM-induced torque to Mother
    if (Constants.FEATURE_FLAGS.RECOIL_PHYSICS && this.playerSatellite) {
      if (typeof this.playerSatellite.applyRecoilAngularImpulse === 'function') {
        this.playerSatellite.applyRecoilAngularImpulse(residualImpulse);
      }

      // C-11 + C-9: Compute induced torque from CoM offset (if COM_TRACKING on)
      if (Constants.FEATURE_FLAGS.COM_TRACKING) {
        const com = computeCoM(this, this.playerSatellite);
        if (com && com.position) {
          // Recoil force acts along Y (residual from cos(α)) at the collar offset
          const recoilForce = { x: 0, y: residualImpulse > 0 ? 1 : -1, z: 0 };
          const inducedTorque = computeInducedTorque(com.position, recoilForce);
          if (typeof this.playerSatellite.applyInducedTorque === 'function') {
            this.playerSatellite.applyInducedTorque(inducedTorque);
          }
        }
      }
    }

    return { success: true };
  }

  // ==========================================================================
  // ST-9.10 C-4: STRUT DEPLOY/STOW COORDINATION
  // ==========================================================================

  /**
   * Deploy a single arm's strut (STOWED → DEPLOYING → DEPLOYED).
   * Delegates to ArmUnit.strutDeploy(). Records deploy time for telemetry.
   *
   * No-op when STOW_DEPLOY_STATE_MACHINE flag is false.
   *
   * @param {number} armIndex — 0-based arm index
   * @param {number} [targetAlpha=Math.PI/2] — target sweep angle
   * @returns {Promise<void>} Resolves when arm reaches DEPLOYED
   */
  strutDeployArm(armIndex, targetAlpha) {
    if (!Constants.FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE) return Promise.resolve();
    // ST-9.11 C-5: Block deploy during launch sequence
    if (this._launchLock) return Promise.reject(new Error('Launch sequence active'));
    const arm = this.arms[armIndex];
    if (!arm) return Promise.reject(new Error(`Invalid arm index: ${armIndex}`));

    this._lastDeployTime = Date.now();
    return arm.strutDeploy(targetAlpha);
  }

  /**
   * Stow a single arm's strut (DEPLOYED → STOWING → STOWED).
   * Delegates to ArmUnit.strutStow().
   *
   * No-op when STOW_DEPLOY_STATE_MACHINE flag is false.
   *
   * @param {number} armIndex — 0-based arm index
   * @returns {Promise<void>} Resolves when arm reaches STOWED
   */
  strutStowArm(armIndex) {
    if (!Constants.FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE) return Promise.resolve();
    // ST-9.11 C-5: Block stow during launch sequence
    if (this._launchLock) return Promise.reject(new Error('Launch sequence active'));
    const arm = this.arms[armIndex];
    if (!arm) return Promise.reject(new Error(`Invalid arm index: ${armIndex}`));

    return arm.strutStow();
  }

  /**
   * Deploy all stowed arms in azimuthal order with a small stagger (~200 ms)
   * to avoid simultaneous center-of-mass spike.
   *
   * No-op when STOW_DEPLOY_STATE_MACHINE flag is false.
   *
   * @param {number} [targetAlpha=Math.PI/2] — target sweep angle for all arms
   * @param {number} [staggerMs=200] — delay between successive deploys
   * @returns {Promise<void[]>} Resolves when ALL arms reach DEPLOYED
   */
  strutDeployAll(targetAlpha, staggerMs = 200) {
    if (!Constants.FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE) return Promise.resolve([]);

    const DS = Constants.DEPLOY_STATES;
    const stowedArms = this.arms
      .map((arm, idx) => ({ arm, idx }))
      .filter(({ arm }) => arm.getDeployState() === DS.STOWED);

    // Sort by azimuth for predictable order
    stowedArms.sort((a, b) => (a.arm._azimuthDeg || 0) - (b.arm._azimuthDeg || 0));

    const promises = stowedArms.map(({ arm, idx }, order) => {
      return new Promise((resolve) => {
        setTimeout(() => {
          arm.strutDeploy(targetAlpha).then(resolve).catch(() => resolve());
        }, order * staggerMs);
      });
    });

    return Promise.all(promises);
  }

  /**
   * Stow all deployed arms in reverse azimuthal order with stagger.
   *
   * No-op when STOW_DEPLOY_STATE_MACHINE flag is false.
   *
   * @param {number} [staggerMs=200] — delay between successive stows
   * @returns {Promise<void[]>} Resolves when ALL arms reach STOWED
   */
  strutStowAll(staggerMs = 200) {
    if (!Constants.FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE) return Promise.resolve([]);

    const DS = Constants.DEPLOY_STATES;
    const deployedArms = this.arms
      .map((arm, idx) => ({ arm, idx }))
      .filter(({ arm }) => arm.getDeployState() === DS.DEPLOYED);

    // Sort by azimuth descending (reverse order)
    deployedArms.sort((a, b) => (b.arm._azimuthDeg || 0) - (a.arm._azimuthDeg || 0));

    const promises = deployedArms.map(({ arm, idx }, order) => {
      return new Promise((resolve) => {
        setTimeout(() => {
          arm.strutStow().then(resolve).catch(() => resolve());
        }, order * staggerMs);
      });
    });

    return Promise.all(promises);
  }

  /**
   * Get a snapshot of all arm deploy states for HUD/persistence.
   * @returns {Array<{ armIndex: number, deployState: string, alpha: number }>}
   */
  getDeploySnapshot() {
    return this.arms.map((arm, idx) => ({
      armIndex: idx,
      deployState: arm.getDeployState(),
      alpha: arm.getAimAlpha(),
    }));
  }

  /**
   * Recommend the next arm to deploy, based on antipodal pairing.
   * Suggests the partner of the last deployed arm to preserve dual-fire option.
   * @returns {{ armIndex: number, reason: string }|null} Recommendation or null
   */
  getNextDeployRecommendation() {
    // Find arms that are deployed (not DOCKED)
    const deployed = this.arms.filter(a => a.state !== ARM_STATES.DOCKED);
    if (deployed.length === 0) return null;

    // Find the most recently deployed arm
    const lastDeployed = deployed[deployed.length - 1];
    const partnerIdx = this.getDualFirePair(lastDeployed.index);
    if (partnerIdx === null) return null;

    const partner = this.arms[partnerIdx];
    // Only recommend if partner is still docked
    if (partner.state === ARM_STATES.DOCKED) {
      return {
        armIndex: partnerIdx,
        reason: 'Deploy opposing arm for balanced fire',
      };
    }
    return null;
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
   * Set launch speed for all arms.
   * @param {number} speed - m/s, clamped to tier limits
   */
  setFleetLaunchSpeed(speed) {
    for (const arm of this.arms) {
      arm.setLaunchSpeed(speed);
    }
  }

  /**
   * Set launch speed for a specific arm.
   * @param {number} index - Arm index
   * @param {number} speed - m/s, clamped to tier limits
   */
  setArmLaunchSpeed(index, speed) {
    if (this.arms[index]) {
      this.arms[index].setLaunchSpeed(speed);
    }
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
   * Update all arms.
   * @param {number} dt - Real-time delta in seconds
   */
  update(dt) {
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

    // Inject nearby debris data into fishing AND trawling arms for auto-capture
    const passiveArms = this.arms.filter(a =>
      a.state === ARM_STATES.FISHING ||
      a.state === ARM_STATES.TRAWLING
    );
    if (passiveArms.length > 0 && this._debrisField) {
      const nearbyDebris = this._debrisField.getUntrackedDebrisNear
        ? this._debrisField.getUntrackedDebrisNear(parentPos, 0.05)  // 5km radius
        : [];
      // Also include tracked debris
      const tracked = this._debrisField.getTargetList ? this._debrisField.getTargetList() : [];
      const allDebris = [...tracked, ...nearbyDebris];
      for (const arm of passiveArms) {
        arm._nearbyDebris = allDebris;
      }
    }

    // Power distribution: arm beacon multiplier affects return speed
    // If beacon is offline (0%), returning/hauling arms move at 10% speed
    const armMult = powerDistribution.armMultiplier;
    const speedScale = armMult > 0 ? armMult : 0.1;

    for (const arm of this.arms) {
      // Pass speed scale for returning/hauling arms affected by beacon power
      arm._beaconSpeedScale = speedScale;
      arm.update(dt, parentPos, parentQuat);
    }
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
    const coreDry = V5.CORE_DRY_MASS + strutMassTotal;
    const xenonMax = Constants.OCTOPUS_CORE_XENON;
    const coldGasMax = Constants.OCTOPUS_CORE_COLD_GAS;

    // Get current propellant from player resources
    const resources = this.playerSatellite.resources || {};
    const rsStatus = this._resourceSystem ? this._resourceSystem.getStatus() : null;
    const xenonPoolMax = rsStatus ? rsStatus.xenonMax : Constants.XENON_FUEL_MAX;
    const coldGasPoolMax = rsStatus ? rsStatus.coldGasMax : Constants.COLD_GAS_MAX;
    const xenonPct = (resources.xenon || 0) / xenonPoolMax;
    const xenonCurrent = xenonMax * xenonPct;
    const coldGasCurrent = coldGasMax * ((resources.coldGas || 0) / coldGasPoolMax);

    // Sum arm masses using V5 weights (reel on mothership = 40% lighter arms)
    let armMassTotal = 0;
    let dockedArmMass = 0;
    let deployedArmMass = 0;
    let detachedArmMass = 0;
    for (const arm of this.arms) {
      const m = arm.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS;
      armMassTotal += m;
      if (arm.state === ARM_STATES.DOCKED) {
        dockedArmMass += m;
      } else if (arm.state !== ARM_STATES.EXPENDED) {
        deployedArmMass += m;
        if (arm.isDetached) detachedArmMass += m;
      }
    }

    const wetMass = coreDry + xenonCurrent + coldGasCurrent + dockedArmMass;
    const dryMass = coreDry + dockedArmMass;

    // Tsiolkovsky: ΔV = Isp × g0 × ln(m_wet / m_dry)
    const isp = Constants.OCTOPUS_CORE_HALL_ISP;
    const g0 = Constants.G0;
    const deltaV = (dryMass > 0 && wetMass > dryMass)
      ? isp * g0 * Math.log(wetMass / dryMass)
      : 0;

    return {
      coreDry,
      xenonCurrent: Math.round(xenonCurrent * 10) / 10,
      xenonMax,
      coldGasCurrent: Math.round(coldGasCurrent * 10) / 10,
      coldGasMax,
      dockedArmMass: Math.round(dockedArmMass * 10) / 10,
      deployedArmMass: Math.round(deployedArmMass * 10) / 10,
      detachedArmMass: Math.round(detachedArmMass * 10) / 10,
      armMassTotal: Math.round(armMassTotal * 10) / 10,
      wetMass: Math.round(wetMass),
      dryMass: Math.round(dryMass),
      deltaV: Math.round(deltaV),
      isp,
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
    }
    this.selectedArmIndex = index;
    const arm = this.arms[index];
    eventBus.emit(Events.ARM_SELECT, { armIndex: index });
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `Selected ${arm.id} [${index + 1}]`,
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
    }
    this.selectedArmIndex = -1;
    eventBus.emit(Events.ARM_DESELECT);
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: 'Arm deselected — mothership focus',
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
   * Pilotable states: TRANSIT, APPROACH, FISHING, TRAWLING, STATION_KEEP.
   * @returns {ArmUnit|null}
   */
  getSelectedDeployedArm() {
    const arm = this.getSelectedArm();
    if (!arm) return null;
    const pilotable = [
      ARM_STATES.TRANSIT,
      ARM_STATES.APPROACH,
      ARM_STATES.FISHING,
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
      a.state !== S.EXPENDED &&
      !a.isDetached
    );
  }

  /**
   * FIX_PLAN §3: Returns the rotation lock tier based on deployed arm states.
   * 'block' — hard-block rotation (high-risk: REELING, HAULING, GRAPPLED, STATION_KEEP, NETTING, DOCKING)
   * 'soft'  — soft-cap rotation to TETHER_ROTATION.SOFT_CAP_RATE (TRANSIT, APPROACH, FISHING, TRAWLING, LAUNCHING, RETURNING, SCANNING, ABLATING)
   * 'none'  — no constraint (all arms DOCKED/EXPENDED/RELOADING or detached)
   */
  getRotationLockTier() {
    let tier = 'none';
    for (const arm of this.arms) {
      if (arm.isDetached) continue;             // free-flying — severed tether, no shear risk
      const s = arm.state;
      if (_HIGH_RISK_ROT_STATES.has(s)) return 'block'; // early exit — max severity
      if (_SOFT_ROT_STATES.has(s)) tier = 'soft';
      // DOCKED / RELOADING / EXPENDED contribute 'none' — leave tier unchanged
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
      .filter(a => a.type === type && a.state === ARM_STATES.DOCKED && a.springCharged && a.fuel > 5);
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
   * survives reset() (which recreates arm instances from scratch).
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
   * Called after reset() recreates fresh ArmUnit instances.
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
          text: 'V4 GSL tethers installed — reach extended to 12.5 km',
          priority: 'success',
        });
        break;

      case 'gslNet':
        // GSL nets: 10× larger at same mass
        for (const arm of this.arms) {
          arm.config.netSize = arm.config.netSize * Constants.V4_NET_SIZE_MULT;
        }
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: 'V4 GSL nets installed — 50×50m capture area',
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
          text: 'V4 HBN-coated electrostatic nets — capture rate improved',
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
    for (const arm of this.arms) {
      arm.state = ARM_STATES.DOCKED;
      arm.fuel = 100;
      arm.target = null;
      arm.capturedDebris = null;
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

    // V5: Reset pulse scan state
    this._pulseScanCooldown = 0;
    this._pulseScanTimer = 0;
    this._pulseScanActive = false;

    // ST-9.11 C-5: Clear launch lock on reset
    this._launchLock = false;

    // Re-apply any purchased upgrades to the freshly reset arms
    this._reapplyStoredUpgrades();
  }

  // ========================================================================
  // ST-9.11 C-5: Launch Sequence Lock
  // ========================================================================

  /**
   * Set the launch sequence lock.  When true, strutDeploy/strutStow/fireDualPair
   * are blocked.  Set by LaunchSequence.start(), cleared on LAUNCH_SEQUENCE_COMPLETE.
   * @param {boolean} locked
   */
  setLaunchLock(locked) { this._launchLock = !!locked; }

  /**
   * @returns {boolean} Whether the launch lock is currently engaged.
   */
  isLaunchLocked() { return this._launchLock; }

  /**
   * Dispose all arms and remove from scene.
   */
  dispose() {
    for (const arm of this.arms) {
      arm.dispose();
    }
    this.arms = [];
  }
}
