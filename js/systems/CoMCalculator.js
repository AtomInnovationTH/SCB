/**
 * CoMCalculator.js — Center-of-Mass Tracking + Thruster Plume Interlock
 * ST-9.12 (C-9) — Config G Gaps #5 + #8
 *
 * Computes spacecraft CoM offset from barrel center considering:
 * - Core bus mass at origin (barrel center)
 * - Strut masses at alpha-dependent midpoint positions (cantilever CoM)
 * - Daughter masses at strut tip positions
 *
 * Plume interference checks:
 * - Thruster nozzle cones vs strut tip positions
 * - Binary block per-thruster when any strut tip falls inside cone
 *
 * All positions are in **mother-local body coordinates** (meters, origin at barrel center).
 * Scene-unit conversion uses M = 0.00001 (1 m in scene units).
 *
 * @module systems/CoMCalculator
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { BridleRing } from '../entities/BridleRing.js';

/** 1 meter in scene units — matches ArmManager/PlayerSatellite convention */
const M = 0.00001;

const V5 = Constants.OCTOPUS_V5;

// ═══════════════════════════════════════════════════════════════════════════
// §1  CoM Computation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute strut tip position in body-local meters.
 * Matches ArmManager.getStrutTipPosition() formula (C-2).
 *
 * tip = hinge + L × (sin(α)·dockOutward − cos(α)·ŷ)
 *
 * @param {{hingePosition:{x:number,y:number,z:number}, dockOutward:{x:number,y:number,z:number}}} dockPos
 * @param {number} alpha — strut sweep angle (rad), 0=stowed, π/2=equatorial, π=zenith
 * @returns {{x:number, y:number, z:number}} position in meters
 */
export function strutTipMeters(dockPos, alpha) {
  const L = V5.STRUT_LENGTH; // 1.60 m
  const hx = dockPos.hingePosition.x / M;
  const hy = dockPos.hingePosition.y / M;
  const hz = dockPos.hingePosition.z / M;
  const sinA = Math.sin(alpha);
  const cosA = Math.cos(alpha);
  const ox = dockPos.dockOutward.x;
  const oy = dockPos.dockOutward.y;
  const oz = dockPos.dockOutward.z;
  return {
    x: hx + L * sinA * ox,
    y: hy + L * (sinA * oy - cosA),
    z: hz + L * sinA * oz,
  };
}

/**
 * Compute strut midpoint position (approximate strut CoM for a uniform rod).
 * Used for the strut structural mass contribution to overall CoM.
 *
 * @param {{hingePosition:{x:number,y:number,z:number}, dockOutward:{x:number,y:number,z:number}}} dockPos
 * @param {number} alpha — strut sweep angle (rad)
 * @returns {{x:number, y:number, z:number}} midpoint position in meters
 */
export function strutMidpointMeters(dockPos, alpha) {
  const halfL = V5.STRUT_LENGTH / 2;
  const hx = dockPos.hingePosition.x / M;
  const hy = dockPos.hingePosition.y / M;
  const hz = dockPos.hingePosition.z / M;
  const sinA = Math.sin(alpha);
  const cosA = Math.cos(alpha);
  const ox = dockPos.dockOutward.x;
  const oy = dockPos.dockOutward.y;
  const oz = dockPos.dockOutward.z;
  return {
    x: hx + halfL * sinA * ox,
    y: hy + halfL * (sinA * oy - cosA),
    z: hz + halfL * sinA * oz,
  };
}

/**
 * Get the arm (daughter) mass for a given arm.
 * Returns 0 if the arm is detached or expended (mass no longer on spacecraft).
 *
 * @param {object} arm — ArmUnit instance (or mock with .config.type, .isDetached, .state)
 * @returns {number} daughter mass in kg
 */
function getDaughterMass(arm) {
  // Detached or expended daughters are no longer attached to the spacecraft
  if (arm.isDetached) return 0;
  const state = arm.state;
  if (state === Constants.ARM_STATES.EXPENDED) return 0;
  // Active states where the daughter is physically away from the strut tip
  // (TRANSIT, APPROACH, etc.) — the daughter is still tethered but for CoM
  // purposes it's at the strut tip or slightly beyond. Simplify: mass at tip.
  return arm.config.type === 'weaver'
    ? Constants.V5_WEAVER_MASS
    : Constants.V5_SPINNER_MASS;
}

/**
 * Compute composite center-of-mass of the entire spacecraft in body-local coordinates.
 *
 * Model:
 *   - Core bus:  mass = CORE_DRY_MASS, position = origin (0,0,0)
 *   - Per strut: mass = STRUT_MASS (4.5 kg), position = strut midpoint (α-dependent)
 *   - Per daughter: mass = WEAVER/SPINNER, position = strut tip (α-dependent)
 *
 * @param {object} armManager — ArmManager instance with .arms[], ._dockPositions[]
 * @param {object} [playerSatellite] — unused currently; reserved for propellant CoM offset
 * @returns {{ position: {x:number,y:number,z:number}, totalMass: number,
 *             breakdown: { core: number, struts: number[], arms: number[] } }}
 */
export function computeCoM(armManager, playerSatellite) {
  const coreMass = V5.CORE_DRY_MASS; // 161.0 kg at origin
  let totalMass = coreMass;
  let cx = 0, cy = 0, cz = 0; // weighted sum: Σ(m·r)

  // Core at origin → contributes (0,0,0) × coreMass — no change to cx/cy/cz

  const strutMasses = [];
  const armMasses = [];

  const arms = armManager.arms || [];
  const docks = armManager._dockPositions || [];

  for (let i = 0; i < arms.length; i++) {
    const arm = arms[i];
    const dp = docks[i];
    if (!dp) {
      strutMasses.push(0);
      armMasses.push(0);
      continue;
    }

    const alpha = arm.getAimAlpha ? arm.getAimAlpha() : (arm._aimAlpha || 0);

    // Strut structural mass at midpoint
    const strutMass = V5.STRUT_MASS; // 4.5 kg
    const mid = strutMidpointMeters(dp, alpha);
    cx += strutMass * mid.x;
    cy += strutMass * mid.y;
    cz += strutMass * mid.z;
    totalMass += strutMass;
    strutMasses.push(strutMass);

    // Daughter mass at tip
    const dMass = getDaughterMass(arm);
    if (dMass > 0) {
      const tip = strutTipMeters(dp, alpha);
      cx += dMass * tip.x;
      cy += dMass * tip.y;
      cz += dMass * tip.z;
      totalMass += dMass;
    }

    // ST-9.7 C-8: Bridle ring mass + attached loads at strut tip
    if (Constants.FEATURE_FLAGS.BRIDLE_RING && Constants.FEATURE_FLAGS.COM_TRACKING) {
      const bridleMass = BridleRing.getRingMassKg(i);
      if (bridleMass > 0) {
        const tip = strutTipMeters(dp, alpha);
        cx += bridleMass * tip.x;
        cy += bridleMass * tip.y;
        cz += bridleMass * tip.z;
        totalMass += bridleMass;
      }
    }

    armMasses.push(dMass);
  }

  const invTotal = totalMass > 0 ? 1 / totalMass : 0;
  return {
    position: {
      x: cx * invTotal,
      y: cy * invTotal,
      z: cz * invTotal,
    },
    totalMass,
    breakdown: {
      core: coreMass,
      struts: strutMasses,
      arms: armMasses,
    },
  };
}

/**
 * Compute scalar CoM drift — the *asymmetric* displacement of CoM from the
 * "balanced" reference position (all arms at mean alpha). This isolates the
 * player-correctable asymmetry from the permanent collar-height offset.
 *
 * When all arms are at the same alpha, drift = 0 (within floating-point tolerance).
 * When one arm is stowed while others are deployed, drift > 0.
 *
 * @param {object} armManager
 * @param {object} [playerSatellite]
 * @returns {number} drift distance in meters
 */
export function computeCoMDrift(armManager, playerSatellite) {
  const actual = computeCoM(armManager, playerSatellite);

  // Compute mean alpha across all active arms
  const arms = armManager.arms || [];
  const docks = armManager._dockPositions || [];
  let sumAlpha = 0, count = 0;
  for (let i = 0; i < arms.length; i++) {
    if (!docks[i]) continue;
    const a = arms[i].getAimAlpha ? arms[i].getAimAlpha() : (arms[i]._aimAlpha || 0);
    sumAlpha += a;
    count++;
  }
  const meanAlpha = count > 0 ? sumAlpha / count : 0;

  // Compute balanced reference CoM with all arms at meanAlpha
  let bcx = 0, bcy = 0, bcz = 0;
  let bTotal = V5.CORE_DRY_MASS; // core at origin contributes (0,0,0)

  for (let i = 0; i < arms.length; i++) {
    const arm = arms[i];
    const dp = docks[i];
    if (!dp) continue;

    const strutMass = V5.STRUT_MASS;
    const mid = strutMidpointMeters(dp, meanAlpha);
    bcx += strutMass * mid.x;
    bcy += strutMass * mid.y;
    bcz += strutMass * mid.z;
    bTotal += strutMass;

    const dMass = getDaughterMass(arm);
    if (dMass > 0) {
      const tip = strutTipMeters(dp, meanAlpha);
      bcx += dMass * tip.x;
      bcy += dMass * tip.y;
      bcz += dMass * tip.z;
      bTotal += dMass;
    }
  }

  const invB = bTotal > 0 ? 1 / bTotal : 0;
  const bx = bcx * invB, by = bcy * invB, bz = bcz * invB;

  // Drift = |actualCoM − balancedCoM|
  const dx = actual.position.x - bx;
  const dy = actual.position.y - by;
  const dz = actual.position.z - bz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Compute the CoM drift as a 3D vector (actual − balanced reference).
 * This vector represents the player-correctable asymmetry offset.
 * Used by torque-coupling code in _applyThrust (PlayerSatellite).
 *
 * @param {object} armManager
 * @param {object} [playerSatellite]
 * @returns {{x:number, y:number, z:number}} drift vector in meters
 */
export function computeCoMDriftVector(armManager, playerSatellite) {
  const actual = computeCoM(armManager, playerSatellite);

  const arms = armManager.arms || [];
  const docks = armManager._dockPositions || [];
  let sumAlpha = 0, count = 0;
  for (let i = 0; i < arms.length; i++) {
    if (!docks[i]) continue;
    const a = arms[i].getAimAlpha ? arms[i].getAimAlpha() : (arms[i]._aimAlpha || 0);
    sumAlpha += a;
    count++;
  }
  const meanAlpha = count > 0 ? sumAlpha / count : 0;

  let bcx = 0, bcy = 0, bcz = 0;
  let bTotal = V5.CORE_DRY_MASS;

  for (let i = 0; i < arms.length; i++) {
    const arm = arms[i];
    const dp = docks[i];
    if (!dp) continue;

    const strutMass = V5.STRUT_MASS;
    const mid = strutMidpointMeters(dp, meanAlpha);
    bcx += strutMass * mid.x;
    bcy += strutMass * mid.y;
    bcz += strutMass * mid.z;
    bTotal += strutMass;

    const dMass = getDaughterMass(arm);
    if (dMass > 0) {
      const tip = strutTipMeters(dp, meanAlpha);
      bcx += dMass * tip.x;
      bcy += dMass * tip.y;
      bcz += dMass * tip.z;
      bTotal += dMass;
    }
  }

  const invB = bTotal > 0 ? 1 / bTotal : 0;
  return {
    x: actual.position.x - bcx * invB,
    y: actual.position.y - bcy * invB,
    z: actual.position.z - bcz * invB,
  };
}

/**
 * Compute perpendicular offset of CoM from a thrust line.
 * This offset × thrust force = unwanted torque (τ = r × F).
 *
 * The thrust line passes through the origin along `thrustVector`.
 * The perpendicular distance from CoM to this line is:
 *   d = |comPos × thrustDir| / |thrustDir|
 *
 * @param {{x:number,y:number,z:number}} comPos — CoM position in meters
 * @param {{x:number,y:number,z:number}} thrustVector — thrust direction vector (not necessarily unit)
 * @returns {number} perpendicular offset in meters
 */
export function computeCoMOffsetFromThrustVector(comPos, thrustVector) {
  // Cross product: comPos × thrustVector
  const cx = comPos.y * thrustVector.z - comPos.z * thrustVector.y;
  const cy = comPos.z * thrustVector.x - comPos.x * thrustVector.z;
  const cz = comPos.x * thrustVector.y - comPos.y * thrustVector.x;
  const crossMag = Math.sqrt(cx * cx + cy * cy + cz * cz);
  const dirMag = Math.sqrt(
    thrustVector.x * thrustVector.x +
    thrustVector.y * thrustVector.y +
    thrustVector.z * thrustVector.z
  );
  return dirMag > 0 ? crossMag / dirMag : 0;
}

/**
 * Identify which arm contributes most to CoM drift (best candidate to stow).
 * "Most displaced" = arm whose mass-weighted position has the largest projection
 * onto the current CoM direction (stowing it reduces drift the most).
 *
 * @param {object} armManager
 * @param {object} [playerSatellite]
 * @returns {number|null} arm index of suggested stow, or null if no arms deployed
 */
export function suggestStowArm(armManager, playerSatellite) {
  const com = computeCoM(armManager, playerSatellite);
  const p = com.position;
  const driftSq = p.x * p.x + p.y * p.y + p.z * p.z;
  if (driftSq < 1e-12) return null; // CoM at origin, nothing to suggest

  const arms = armManager.arms || [];
  const docks = armManager._dockPositions || [];

  let bestIdx = null;
  let bestDot = -Infinity;

  for (let i = 0; i < arms.length; i++) {
    const arm = arms[i];
    const dp = docks[i];
    if (!dp) continue;

    // Only suggest stow for arms that are deployed and not detached/expended
    const deployState = arm.getDeployState ? arm.getDeployState() : 'DEPLOYED';
    if (deployState !== 'DEPLOYED' && deployState !== 'DEPLOYING') continue;
    if (arm.isDetached || arm.state === Constants.ARM_STATES.EXPENDED) continue;

    const alpha = arm.getAimAlpha ? arm.getAimAlpha() : (arm._aimAlpha || 0);
    const tip = strutTipMeters(dp, alpha);

    // Total mass contribution of this arm (strut + daughter)
    const dMass = getDaughterMass(arm);
    const totalArmMass = V5.STRUT_MASS + dMass;

    // Weighted contribution direction · CoM direction (projection)
    const dot = (tip.x * p.x + tip.y * p.y + tip.z * p.z) * totalArmMass;
    if (dot > bestDot) {
      bestDot = dot;
      bestIdx = i;
    }
  }

  return bestIdx;
}


// ═══════════════════════════════════════════════════════════════════════════
// §2  Plume Interference (Gap #8)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check whether any strut tip is inside the plume cone of a specific thruster.
 *
 * Cone test: A point P is inside the plume cone of thruster at nozzle N
 * firing along direction D (unit) with half-angle θ if:
 *   1. axial = (P − N) · D > 0            (downstream of nozzle)
 *   2. perpDist / axial < tan(θ)           (within cone angle)
 *
 * @param {object} armManager — with .arms[], ._dockPositions[]
 * @param {string} thrusterId — one of Constants.THRUSTERS[].id
 * @returns {{ blocked: boolean, conflictingArms: number[], reason: string }}
 */
export function checkPlumeInterference(armManager, thrusterId) {
  const thrusters = Constants.THRUSTERS;
  if (!thrusters) return { blocked: false, conflictingArms: [], reason: '' };

  const thruster = thrusters.find(t => t.id === thrusterId);
  if (!thruster) return { blocked: false, conflictingArms: [], reason: `Unknown thruster: ${thrusterId}` };

  const tanHalf = Math.tan(Constants.PLUME_HALF_ANGLE);
  const n = thruster.nozzlePos;
  const d = thruster.thrustDir;
  // Normalize thrust direction
  const dMag = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
  const dx = d.x / dMag, dy = d.y / dMag, dz = d.z / dMag;

  const arms = armManager.arms || [];
  const docks = armManager._dockPositions || [];
  const conflictingArms = [];

  for (let i = 0; i < arms.length; i++) {
    const arm = arms[i];
    const dp = docks[i];
    if (!dp) continue;

    // Skip arms that are stowed (effectively alongside barrel, not in plume path)
    // But still check DEPLOYING/STOWING since the strut is in motion
    if (arm.isDetached || arm.state === Constants.ARM_STATES.EXPENDED) continue;

    const alpha = arm.getAimAlpha ? arm.getAimAlpha() : (arm._aimAlpha || 0);
    const tip = strutTipMeters(dp, alpha);

    // Vector from nozzle to tip
    const vx = tip.x - n.x;
    const vy = tip.y - n.y;
    const vz = tip.z - n.z;

    // Axial projection: (tip − nozzle) · thrustDir
    const axial = vx * dx + vy * dy + vz * dz;
    if (axial <= 0) continue; // tip is upstream of nozzle — cannot be in plume

    // Perpendicular distance from cone axis
    // perpSq = |v|² − axial²
    const vLenSq = vx * vx + vy * vy + vz * vz;
    const perpSq = vLenSq - axial * axial;
    const perp = perpSq > 0 ? Math.sqrt(perpSq) : 0;

    // Cone test: perp / axial < tan(halfAngle)
    if (perp < axial * tanHalf) {
      conflictingArms.push(i);
    }
  }

  if (conflictingArms.length > 0) {
    return {
      blocked: true,
      conflictingArms,
      reason: `Arms [${conflictingArms.join(',')}] in plume cone of ${thrusterId}`,
    };
  }

  return { blocked: false, conflictingArms: [], reason: '' };
}

/**
 * Check all thrusters for plume conflicts and return a map of blocked thrusters.
 *
 * @param {object} armManager
 * @returns {Object<string, string>} Map: { thrusterId → blockedReason } (only blocked thrusters)
 */
export function getActiveBlocks(armManager) {
  const thrusters = Constants.THRUSTERS;
  if (!thrusters) return {};

  const blocks = {};
  for (const t of thrusters) {
    const result = checkPlumeInterference(armManager, t.id);
    if (result.blocked) {
      blocks[t.id] = result.reason;
    }
  }
  return blocks;
}


// ═══════════════════════════════════════════════════════════════════════════
// §3  CoM Drift Warning State Machine
// ═══════════════════════════════════════════════════════════════════════════

/** @type {boolean} Whether a drift warning is currently active (for debouncing) */
let _driftWarningActive = false;

/** @type {Object<string, boolean>} Per-thruster block state (for edge detection) */
const _thrusterBlockState = {};

/**
 * Update CoM drift warning state. Call once per frame (or at HUD rate).
 * Emits COM_DRIFT_WARNING on threshold crossing up, COM_DRIFT_CLEARED on crossing down.
 * Debounced: only emits on state transitions.
 *
 * @param {object} armManager
 * @param {object} [playerSatellite]
 * @returns {{ offsetM: number, isWarning: boolean, suggestedArm: number|null }}
 */
export function updateDriftWarning(armManager, playerSatellite) {
  if (!Constants.FEATURE_FLAGS.COM_TRACKING) {
    // Flag off: silently return zero drift, no events
    if (_driftWarningActive) {
      _driftWarningActive = false;
    }
    return { offsetM: 0, isWarning: false, suggestedArm: null };
  }

  const offsetM = computeCoMDrift(armManager, playerSatellite);
  const threshold = Constants.COM_DRIFT_WARN_THRESHOLD;
  const isOverThreshold = offsetM >= threshold;

  let suggestedArm = null;

  if (isOverThreshold && !_driftWarningActive) {
    // Threshold crossing UP → emit warning
    _driftWarningActive = true;
    suggestedArm = suggestStowArm(armManager, playerSatellite);
    eventBus.emit(Events.COM_DRIFT_WARNING, {
      offsetM,
      threshold,
      suggestedStowArm: suggestedArm,
    });
  } else if (!isOverThreshold && _driftWarningActive) {
    // Threshold crossing DOWN → emit cleared
    _driftWarningActive = false;
    eventBus.emit(Events.COM_DRIFT_CLEARED, { offsetM });
  } else if (isOverThreshold) {
    // Still over threshold — compute suggestion for HUD but don't re-emit
    suggestedArm = suggestStowArm(armManager, playerSatellite);
  }

  return { offsetM, isWarning: _driftWarningActive, suggestedArm };
}

/**
 * Update thruster block state and emit edge events.
 * Call once per frame/HUD-tick when THRUSTER_INTERLOCK flag is ON.
 *
 * @param {object} armManager
 * @returns {Object<string, string>} current blocks map { thrusterId → reason }
 */
export function updateThrusterBlocks(armManager) {
  if (!Constants.FEATURE_FLAGS.THRUSTER_INTERLOCK) {
    // Flag off: clear all block state, no events
    for (const id of Object.keys(_thrusterBlockState)) {
      if (_thrusterBlockState[id]) {
        _thrusterBlockState[id] = false;
      }
    }
    return {};
  }

  const thrusters = Constants.THRUSTERS;
  if (!thrusters) return {};

  const currentBlocks = {};

  for (const t of thrusters) {
    const result = checkPlumeInterference(armManager, t.id);
    const wasBlocked = !!_thrusterBlockState[t.id];

    if (result.blocked && !wasBlocked) {
      _thrusterBlockState[t.id] = true;
      eventBus.emit(Events.THRUSTER_BLOCKED_PLUME, {
        thrusterId: t.id,
        conflictingArms: result.conflictingArms,
        reason: result.reason,
      });
    } else if (!result.blocked && wasBlocked) {
      _thrusterBlockState[t.id] = false;
      eventBus.emit(Events.THRUSTER_UNBLOCKED, { thrusterId: t.id });
    }

    if (result.blocked) {
      currentBlocks[t.id] = result.reason;
    }
  }

  return currentBlocks;
}

/**
 * Reset internal state (for testing / new game).
 */
export function resetCoMState() {
  _driftWarningActive = false;
  for (const id of Object.keys(_thrusterBlockState)) {
    delete _thrusterBlockState[id];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// §4  CoM-Induced Torque Helper
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute the torque vector induced when thrust F acts through a CoM that is
 * offset from the thrust line.
 *
 *   τ = r × F
 *
 * where r is the CoM position (offset from origin which is the thrust-line anchor).
 * Returns the torque vector in body coordinates (N·m if F is in Newtons, r in meters).
 *
 * @param {{x:number,y:number,z:number}} comPos — CoM offset from origin (meters)
 * @param {{x:number,y:number,z:number}} thrustForce — thrust force vector (N)
 * @returns {{x:number, y:number, z:number}} torque vector (N·m)
 */
export function computeInducedTorque(comPos, thrustForce) {
  return {
    x: comPos.y * thrustForce.z - comPos.z * thrustForce.y,
    y: comPos.z * thrustForce.x - comPos.x * thrustForce.z,
    z: comPos.x * thrustForce.y - comPos.y * thrustForce.x,
  };
}

// Default export: namespace convenience
export default {
  computeCoM,
  computeCoMDrift,
  computeCoMDriftVector,
  computeCoMOffsetFromThrustVector,
  computeInducedTorque,
  suggestStowArm,
  strutTipMeters,
  strutMidpointMeters,
  checkPlumeInterference,
  getActiveBlocks,
  updateDriftWarning,
  updateThrusterBlocks,
  resetCoMState,
};
