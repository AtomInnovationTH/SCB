/**
 * ArmTierCatalog.js — Arm tier catalog + upgrade service (ST-9.8 C-10)
 *
 * Three tiers: Y0_QUAD (4 arms) → Y1_HEX (6 arms) → Y3_OCTO (8 arms).
 * Upgrading replaces the entire arm array — it is NOT additive.
 * Gated by FEATURE_FLAGS.TIER_UPGRADES (default false).
 *
 * @module systems/ArmTierCatalog
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

// ============================================================================
// TIER DESCRIPTORS
// ============================================================================

/**
 * Build per-tier descriptor from Constants.ARM_LADDER + ARM_TIER_COSTS/GATE.
 * Values are read at call time so tests can patch Constants beforehand.
 * @returns {Object<string, TierDescriptor>}
 */
function buildCatalog() {
  const L = Constants.ARM_LADDER;
  const COSTS = Constants.ARM_TIER_COSTS || {};
  const TRL_GATE = Constants.ARM_TIER_TRL_GATE || {};
  const DEBRIS_GATE = Constants.ARM_TIER_DEBRIS_GATE || {};

  return {
    Y0_QUAD: {
      tierKey: 'Y0_QUAD',
      displayName: 'Y0 Quad',
      armCount: L.Y0_QUAD.armCount,
      azimuths: [...L.Y0_QUAD.azimuths],
      endFaceArms: 0,
      massDryKg: L.Y0_QUAD.dryMass,
      massWetKg: L.Y0_QUAD.wetMass,
      costCredits: 0,           // starting tier — no cost
      prereqTier: null,
      description: 'Standard quad-arm configuration. Two Large Daughter (weaver) + two Small Daughter (spinner) arms on opposing azimuth planes.',
      unlockTRL: 1,
      debrisGate: 0,
      features: ['4-arm quad', '2 weaver + 2 spinner', 'dual-fire pairs ×2'],
    },
    Y1_HEX: {
      tierKey: 'Y1_HEX',
      displayName: 'Y1 Hex',
      armCount: L.Y1_HEX.armCount,
      azimuths: [...L.Y1_HEX.azimuths],
      endFaceArms: 0,
      massDryKg: L.Y1_HEX.dryMass,
      massWetKg: L.Y1_HEX.wetMass,
      costCredits: COSTS.Y1_HEX || 5000,
      prereqTier: 'Y0_QUAD',
      description: 'Hex Configuration Refit — adds 1 Large Daughter + 1 Small Daughter. Requires shipyard docking.',
      unlockTRL: TRL_GATE.Y1_HEX || 6,
      debrisGate: DEBRIS_GATE.Y1_HEX || 15,
      features: ['6-arm hex', '3 weaver + 3 spinner', 'dual-fire pairs ×3', '60° arm spacing'],
    },
    Y3_OCTO: {
      tierKey: 'Y3_OCTO',
      displayName: 'Y3 Octo',
      armCount: L.Y3_OCTO.armCount,
      azimuths: [...L.Y3_OCTO.azimuths],
      endFaceArms: 2,
      massDryKg: L.Y3_OCTO.dryMass,
      massWetKg: L.Y3_OCTO.wetMass,
      costCredits: COSTS.Y3_OCTO || 15000,
      prereqTier: 'Y1_HEX',
      description: 'Octo Configuration Refit — adds Front + Back arms, completes the Octopus. Requires Hex refit.',
      unlockTRL: TRL_GATE.Y3_OCTO || 8,
      debrisGate: DEBRIS_GATE.Y3_OCTO || 30,
      features: ['8 arms = 6 ring + 2 end-face', '3 weaver + 3 spinner + F/B', 'barrel-axial sweep', 'full Octopus configuration'],
    },
  };
}

// ============================================================================
// TIER ORDERING (for upgrade path)
// ============================================================================

const TIER_ORDER = ['Y0_QUAD', 'Y1_HEX', 'Y3_OCTO'];

/**
 * Index of a tier in the upgrade progression.
 * @param {string} tierKey
 * @returns {number} 0-based index, or -1 if unknown
 */
function tierIndex(tierKey) {
  return TIER_ORDER.indexOf(tierKey);
}

// ============================================================================
// PUBLIC API — CATALOG QUERIES
// ============================================================================

/**
 * Get all tier descriptors.
 * @returns {TierDescriptor[]} Ordered Y0 → Y1 → Y3
 */
export function getAvailableTiers() {
  const catalog = buildCatalog();
  return TIER_ORDER.map(k => catalog[k]);
}

/**
 * Get a single tier descriptor.
 * @param {string} tierKey — 'Y0_QUAD', 'Y1_HEX', 'Y3_OCTO'
 * @returns {TierDescriptor|null}
 */
export function getTierDescriptor(tierKey) {
  const catalog = buildCatalog();
  return catalog[tierKey] || null;
}

/**
 * Get the current tier from an armManager (or a tier key string).
 * @param {Object|string} armManagerOrKey — ArmManager instance or tier key string
 * @returns {string} Tier key
 */
export function getCurrentTier(armManagerOrKey) {
  if (typeof armManagerOrKey === 'string') return armManagerOrKey;
  if (armManagerOrKey && typeof armManagerOrKey.getCurrentTier === 'function') {
    return armManagerOrKey.getCurrentTier();
  }
  return 'Y0_QUAD';
}

/**
 * Get the next tier in the upgrade path, or null if at top.
 * @param {string} currentTier — current tier key
 * @returns {TierDescriptor|null} Next tier descriptor, or null
 */
export function getUpgradePath(currentTier) {
  const idx = tierIndex(currentTier);
  if (idx < 0 || idx >= TIER_ORDER.length - 1) return null;
  const catalog = buildCatalog();
  return catalog[TIER_ORDER[idx + 1]];
}

// ============================================================================
// PRE-CONDITION GATING
// ============================================================================

/**
 * Derive the player's effective TRL from debrisCleared count.
 * Mapping (approximate NASA TRL analogy):
 *   0-4 cleared → TRL 3   |   5-9 → TRL 4   |   10-14 → TRL 5
 *   15-19 → TRL 6          |   20-29 → TRL 7  |   30-39 → TRL 8
 *   40+ → TRL 9
 * @param {number} debrisCleared
 * @returns {number} Effective TRL (1–9)
 */
export function getEffectiveTRL(debrisCleared) {
  if (debrisCleared >= 40) return 9;
  if (debrisCleared >= 30) return 8;
  if (debrisCleared >= 20) return 7;
  if (debrisCleared >= 15) return 6;
  if (debrisCleared >= 10) return 5;
  if (debrisCleared >= 5)  return 4;
  return 3;
}

/**
 * Check whether an upgrade is permitted.
 *
 * @param {string} currentTier — current tier key
 * @param {string} targetTier — desired tier key
 * @param {Object} gameState — { credits, debrisCleared, launchReady, allArmsStowed, noActiveOps }
 * @returns {{ allowed: boolean, reason: string|null }}
 */
export function canUpgrade(currentTier, targetTier, gameState) {
  const catalog = buildCatalog();
  const target = catalog[targetTier];
  if (!target) return { allowed: false, reason: 'Unknown target tier' };

  // Must be the correct prerequisite chain
  if (target.prereqTier !== currentTier) {
    return { allowed: false, reason: `Requires ${catalog[target.prereqTier]?.displayName || target.prereqTier} first` };
  }

  // Must be a valid upgrade step (target > current in ordering)
  const curIdx = tierIndex(currentTier);
  const tgtIdx = tierIndex(targetTier);
  if (tgtIdx <= curIdx) {
    return { allowed: false, reason: 'Already at or past this tier' };
  }

  // Launch sequence must be complete
  if (gameState.launchReady === false) {
    return { allowed: false, reason: 'Complete launch sequence first' };
  }

  // All arms must be in STOWED state
  if (gameState.allArmsStowed === false) {
    return { allowed: false, reason: 'Stow all arms before upgrading' };
  }

  // No active capture/reel/net/bridle operations
  if (gameState.noActiveOps === false) {
    return { allowed: false, reason: 'Complete all active operations first' };
  }

  // Credits check
  const credits = gameState.credits || 0;
  if (credits < target.costCredits) {
    return { allowed: false, reason: `Need ${target.costCredits.toLocaleString()} credits (have ${credits.toLocaleString()})` };
  }

  // TRL / debris gate (player-facing vocabulary: "Tech Level" — UX-11 #10)
  const debrisCleared = gameState.debrisCleared || 0;
  const effectiveTRL = getEffectiveTRL(debrisCleared);
  if (effectiveTRL < target.unlockTRL) {
    return {
      allowed: false,
      reason: `Requires Tech Lvl ${target.unlockTRL} (clear ${target.debrisGate}+ debris — have ${debrisCleared})`,
    };
  }

  return { allowed: true, reason: null };
}

// ============================================================================
// UPGRADE EXECUTION
// ============================================================================

/**
 * Execute an arm tier upgrade.
 *
 * @param {string} currentTier — current tier key
 * @param {string} targetTier — desired tier key
 * @param {Object} gameState — { credits, debrisCleared, launchReady, allArmsStowed, noActiveOps }
 * @param {Object} deps — { armManager, scoringSystem, persistenceManager }
 * @returns {{ success: boolean, reason?: string }}
 */
export function executeUpgrade(currentTier, targetTier, gameState, deps) {
  const check = canUpgrade(currentTier, targetTier, gameState);
  if (!check.allowed) {
    eventBus.emit(Events.TIER_UPGRADE_REJECTED, {
      fromTier: currentTier,
      toTier: targetTier,
      reason: check.reason,
    });
    return { success: false, reason: check.reason };
  }

  const catalog = buildCatalog();
  const target = catalog[targetTier];
  const { armManager, scoringSystem, persistenceManager } = deps;

  // 1. Deduct credits
  if (scoringSystem && typeof scoringSystem.spendCredits === 'function') {
    if (!scoringSystem.spendCredits(target.costCredits)) {
      const reason = 'Insufficient credits (spend failed)';
      eventBus.emit(Events.TIER_UPGRADE_REJECTED, {
        fromTier: currentTier,
        toTier: targetTier,
        reason,
      });
      return { success: false, reason };
    }
  }

  // 2. Set new tier on ArmManager (triggers persistence via setCurrentTier)
  if (armManager && typeof armManager.setCurrentTier === 'function') {
    armManager.setCurrentTier(targetTier);
  }

  // 3. Regenerate dock positions for the new tier
  if (armManager && typeof armManager.generateDockPositions === 'function') {
    armManager.generateDockPositions(targetTier);
  }

  // 4. Reset per-arm state to defaults for the new arms
  //    New arms start STOWED (if launched) or LOCKED (if pre-launch).
  //    Net inventory, reel state, bridle state: reset by the ArmUnit constructors
  //    when arms are rebuilt. If armManager.rebuild() or similar exists, call it.
  //    Otherwise, we trust setCurrentTier + generateDockPositions handles it.

  // 5. Additional persistence of the new tier
  if (persistenceManager && typeof persistenceManager.setArmTier === 'function') {
    persistenceManager.setArmTier(targetTier);
  }

  // 6. Emit upgrade event
  eventBus.emit(Events.TIER_UPGRADED, {
    fromTier: currentTier,
    toTier: targetTier,
    newArmCount: target.armCount,
    newMassDryKg: target.massDryKg,
  });

  // 7. HOUSTON comms announcement
  if (targetTier === 'Y3_OCTO') {
    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'HOUSTON',
      text: 'Octopus-class is fully operational.',
      priority: 'critical',
    });
  } else if (targetTier === 'Y1_HEX') {
    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'HOUSTON',
      text: `Hex Configuration Refit complete — ${target.armCount} daughters online.`,
      priority: 'info',
    });
  }

  return { success: true };
}

// ============================================================================
// CONVENIENCE: Build gameState from live systems
// ============================================================================

/**
 * Build a gameState snapshot from live system references (browser runtime).
 * For use by ShopScreen when calling canUpgrade/executeUpgrade.
 *
 * @param {Object} deps — { scoringSystem, armManager, launchSequence }
 * @returns {Object} gameState compatible with canUpgrade/executeUpgrade
 */
export function buildGameState(deps) {
  const { scoringSystem, armManager, launchSequence } = deps;

  const credits = scoringSystem ? scoringSystem.credits : 0;
  const debrisCleared = scoringSystem ? (scoringSystem.debrisCleared || 0) : 0;
  const launchReady = launchSequence ? launchSequence.isReady() : true;

  // Check all arms are in STOWED deploy state
  let allArmsStowed = true;
  let noActiveOps = true;

  if (armManager && armManager.arms) {
    const DS = Constants.DEPLOY_STATES;
    const AS = Constants.ARM_STATES;
    const activeStates = new Set([
      AS.TRANSIT, AS.APPROACH, AS.NETTING, AS.GRAPPLED,
      AS.HAULING, AS.REELING, AS.LAUNCHING, AS.ABLATING,
      AS.SCANNING, AS.TANGLED, AS.WEB_SHOT,
    ]);

    for (const arm of armManager.arms) {
      // Deploy state check (must be STOWED or LOCKED)
      if (arm._deployState && arm._deployState !== DS.STOWED && arm._deployState !== DS.LOCKED) {
        allArmsStowed = false;
      }
      // ARM_STATES check (must be DOCKED to be stowed)
      if (arm.state && arm.state !== AS.DOCKED && arm.state !== AS.EXPENDED) {
        allArmsStowed = false;
      }
      // Active operations check
      if (arm.state && activeStates.has(arm.state)) {
        noActiveOps = false;
      }
    }
  }

  return { credits, debrisCleared, launchReady, allArmsStowed, noActiveOps };
}

// ============================================================================
// TIER ORDER export (for tests)
// ============================================================================
export { TIER_ORDER, tierIndex, buildCatalog };
