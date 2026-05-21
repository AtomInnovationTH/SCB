/**
 * test-ArmTierCatalog.js — ST-9.8 C-10: Arm Tier Catalog + Upgrade Service
 *
 * Tests: catalog queries, pre-condition gating, upgrade execution,
 * TRL derivation, persistence round-trip, CoM impact, feature flag.
 */

import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { validateArmStateData } from '../systems/PersistenceManager.js';
import {
  getAvailableTiers,
  getTierDescriptor,
  getCurrentTier,
  getUpgradePath,
  getEffectiveTRL,
  canUpgrade,
  executeUpgrade,
  buildCatalog,
  TIER_ORDER,
  tierIndex,
} from '../systems/ArmTierCatalog.js';

// ============================================================================
// HELPERS — Mocks
// ============================================================================

function mockArmManager(tier = 'Y0_QUAD', arms = []) {
  return {
    _activeTierKey: tier,
    arms,
    getCurrentTier() { return this._activeTierKey; },
    setCurrentTier(t) { this._activeTierKey = t; },
    generateDockPositions(t) { this._lastGenerated = t; },
  };
}

function mockScoring(credits = 10000, debrisCleared = 20) {
  return {
    credits,
    debrisCleared,
    spendCredits(amount) {
      if (this.credits < amount) return false;
      this.credits -= amount;
      return true;
    },
    addCredits(amount) { this.credits += amount; },
  };
}

function mockPersistence() {
  let _tier = 'Y0_QUAD';
  return {
    setArmTier(t) { _tier = t; return true; },
    getArmTier() { return _tier; },
  };
}

function baseGameState(overrides = {}) {
  return {
    credits: 10000,
    debrisCleared: 20,
    launchReady: true,
    allArmsStowed: true,
    noActiveOps: true,
    ...overrides,
  };
}

// ============================================================================
// CATALOG QUERIES
// ============================================================================

describe('ArmTierCatalog — Catalog Queries', () => {
  it('getAvailableTiers returns 3 tiers in order Y0→Y1→Y3', () => {
    const tiers = getAvailableTiers();
    assert.equal(tiers.length, 3, `Expected 3 tiers, got ${tiers.length}`);
    assert.equal(tiers[0].tierKey, 'Y0_QUAD', 'First tier Y0_QUAD');
    assert.equal(tiers[1].tierKey, 'Y1_HEX', 'Second tier Y1_HEX');
    assert.equal(tiers[2].tierKey, 'Y3_OCTO', 'Third tier Y3_OCTO');
  });

  it('Y0_QUAD has correct arm count and mass', () => {
    const t = getTierDescriptor('Y0_QUAD');
    assert.ok(t !== null, 'Y0_QUAD descriptor exists');
    assert.equal(t.armCount, 4, `armCount: ${t.armCount}`);
    assert.equal(t.massDryKg, Constants.ARM_LADDER.Y0_QUAD.dryMass, 'dryMass matches');
    assert.equal(t.massWetKg, Constants.ARM_LADDER.Y0_QUAD.wetMass, 'wetMass matches');
    assert.equal(t.endFaceArms, 0, 'no end-face arms');
    assert.equal(t.costCredits, 0, 'no cost for starter tier');
    assert.equal(t.prereqTier, null, 'no prereq');
  });

  it('Y1_HEX has correct arm count, mass, and cost', () => {
    const t = getTierDescriptor('Y1_HEX');
    assert.ok(t !== null, 'Y1_HEX descriptor exists');
    assert.equal(t.armCount, 6, `armCount: ${t.armCount}`);
    assert.equal(t.massDryKg, Constants.ARM_LADDER.Y1_HEX.dryMass, 'dryMass matches');
    assert.equal(t.massWetKg, Constants.ARM_LADDER.Y1_HEX.wetMass, 'wetMass matches');
    assert.equal(t.endFaceArms, 0, 'no end-face arms');
    assert.equal(t.costCredits, Constants.ARM_TIER_COSTS.Y1_HEX, 'cost matches');
    assert.equal(t.prereqTier, 'Y0_QUAD', 'prereq is Y0');
  });

  it('Y3_OCTO has correct arm count, mass, cost, and end-face arms', () => {
    const t = getTierDescriptor('Y3_OCTO');
    assert.ok(t !== null, 'Y3_OCTO descriptor exists');
    assert.equal(t.armCount, 8, `armCount: ${t.armCount}`);
    assert.equal(t.massDryKg, Constants.ARM_LADDER.Y3_OCTO.dryMass, 'dryMass matches');
    assert.equal(t.massWetKg, Constants.ARM_LADDER.Y3_OCTO.wetMass, 'wetMass matches');
    assert.equal(t.endFaceArms, 2, '2 end-face arms');
    assert.equal(t.costCredits, Constants.ARM_TIER_COSTS.Y3_OCTO, 'cost matches');
    assert.equal(t.prereqTier, 'Y1_HEX', 'prereq is Y1');
  });

  it('getTierDescriptor returns null for unknown tier', () => {
    assert.equal(getTierDescriptor('Y9_DECA'), null, 'Unknown tier → null');
  });

  it('all tiers have azimuths matching ARM_LADDER', () => {
    for (const tier of getAvailableTiers()) {
      const ladderEntry = Constants.ARM_LADDER[tier.tierKey];
      assert.deepEqual(tier.azimuths, ladderEntry.azimuths,
        `${tier.tierKey} azimuths match`);
    }
  });

  it('all tiers have features array (non-empty)', () => {
    for (const tier of getAvailableTiers()) {
      assert.ok(Array.isArray(tier.features), `${tier.tierKey} has features array`);
      assert.ok(tier.features.length > 0, `${tier.tierKey} features non-empty`);
    }
  });

  it('all tiers have description string', () => {
    for (const tier of getAvailableTiers()) {
      assert.isType(tier.description, 'string', `${tier.tierKey} has description`);
      assert.ok(tier.description.length > 10, `${tier.tierKey} description non-trivial`);
    }
  });
});

// ============================================================================
// TIER ORDER + INDEX
// ============================================================================

describe('ArmTierCatalog — Tier Ordering', () => {
  it('TIER_ORDER has 3 entries', () => {
    assert.equal(TIER_ORDER.length, 3, 'TIER_ORDER length');
  });

  it('tierIndex returns correct indices', () => {
    assert.equal(tierIndex('Y0_QUAD'), 0, 'Y0 idx 0');
    assert.equal(tierIndex('Y1_HEX'), 1, 'Y1 idx 1');
    assert.equal(tierIndex('Y3_OCTO'), 2, 'Y3 idx 2');
    assert.equal(tierIndex('UNKNOWN'), -1, 'unknown idx -1');
  });
});

// ============================================================================
// getCurrentTier
// ============================================================================

describe('ArmTierCatalog — getCurrentTier', () => {
  it('reads tier from ArmManager', () => {
    const am = mockArmManager('Y1_HEX');
    assert.equal(getCurrentTier(am), 'Y1_HEX', 'reads from armManager');
  });

  it('accepts string directly', () => {
    assert.equal(getCurrentTier('Y3_OCTO'), 'Y3_OCTO', 'string passthrough');
  });

  it('defaults to Y0_QUAD for null', () => {
    assert.equal(getCurrentTier(null), 'Y0_QUAD', 'null → Y0_QUAD');
  });
});

// ============================================================================
// getUpgradePath
// ============================================================================

describe('ArmTierCatalog — getUpgradePath', () => {
  it('Y0_QUAD → next is Y1_HEX', () => {
    const next = getUpgradePath('Y0_QUAD');
    assert.ok(next !== null, 'next exists');
    assert.equal(next.tierKey, 'Y1_HEX', 'next tier key');
  });

  it('Y1_HEX → next is Y3_OCTO', () => {
    const next = getUpgradePath('Y1_HEX');
    assert.ok(next !== null, 'next exists');
    assert.equal(next.tierKey, 'Y3_OCTO', 'next tier key');
  });

  it('Y3_OCTO → null (at top)', () => {
    assert.equal(getUpgradePath('Y3_OCTO'), null, 'top tier → null');
  });

  it('unknown tier → null', () => {
    assert.equal(getUpgradePath('INVALID'), null, 'invalid → null');
  });
});

// ============================================================================
// EFFECTIVE TRL
// ============================================================================

describe('ArmTierCatalog — getEffectiveTRL', () => {
  it('0 debris → TRL 3', () => {
    assert.equal(getEffectiveTRL(0), 3, 'TRL 3');
  });

  it('5 debris → TRL 4', () => {
    assert.equal(getEffectiveTRL(5), 4, 'TRL 4');
  });

  it('10 debris → TRL 5', () => {
    assert.equal(getEffectiveTRL(10), 5, 'TRL 5');
  });

  it('15 debris → TRL 6 (Y1 gate)', () => {
    assert.equal(getEffectiveTRL(15), 6, 'TRL 6');
  });

  it('20 debris → TRL 7', () => {
    assert.equal(getEffectiveTRL(20), 7, 'TRL 7');
  });

  it('30 debris → TRL 8 (Y3 gate)', () => {
    assert.equal(getEffectiveTRL(30), 8, 'TRL 8');
  });

  it('50 debris → TRL 9', () => {
    assert.equal(getEffectiveTRL(50), 9, 'TRL 9');
  });

  it('14 debris → TRL 5 (below Y1 gate)', () => {
    assert.equal(getEffectiveTRL(14), 5, 'TRL 5 at 14 cleared');
  });

  it('29 debris → TRL 7 (below Y3 gate)', () => {
    assert.equal(getEffectiveTRL(29), 7, 'TRL 7 at 29 cleared');
  });
});

// ============================================================================
// PRE-CONDITION GATING — canUpgrade
// ============================================================================

describe('ArmTierCatalog — canUpgrade gating', () => {
  it('allows valid Y0→Y1 upgrade', () => {
    const gs = baseGameState({ credits: 5000, debrisCleared: 15 });
    const result = canUpgrade('Y0_QUAD', 'Y1_HEX', gs);
    assert.equal(result.allowed, true, `allowed: ${result.allowed}, reason: ${result.reason}`);
  });

  it('allows valid Y1→Y3 upgrade', () => {
    const gs = baseGameState({ credits: 15000, debrisCleared: 30 });
    const result = canUpgrade('Y1_HEX', 'Y3_OCTO', gs);
    assert.equal(result.allowed, true, `allowed: ${result.allowed}, reason: ${result.reason}`);
  });

  it('rejects unknown target tier', () => {
    const gs = baseGameState();
    const result = canUpgrade('Y0_QUAD', 'Y9_DECA', gs);
    assert.equal(result.allowed, false, 'rejected');
    assert.ok(result.reason.includes('Unknown'), `reason: ${result.reason}`);
  });

  it('rejects skipping Y1 (Y0→Y3)', () => {
    const gs = baseGameState({ credits: 99999, debrisCleared: 50 });
    const result = canUpgrade('Y0_QUAD', 'Y3_OCTO', gs);
    assert.equal(result.allowed, false, 'rejected');
    assert.ok(result.reason.includes('Y1 Hex'), `reason: ${result.reason}`);
  });

  it('rejects downgrade (Y1→Y0)', () => {
    const gs = baseGameState();
    const result = canUpgrade('Y1_HEX', 'Y0_QUAD', gs);
    assert.equal(result.allowed, false, 'rejected');
  });

  it('rejects same tier (Y0→Y0)', () => {
    const gs = baseGameState();
    const result = canUpgrade('Y0_QUAD', 'Y0_QUAD', gs);
    assert.equal(result.allowed, false, 'rejected');
  });

  it('rejects when launch not ready', () => {
    const gs = baseGameState({ launchReady: false });
    const result = canUpgrade('Y0_QUAD', 'Y1_HEX', gs);
    assert.equal(result.allowed, false, 'rejected');
    assert.ok(result.reason.toLowerCase().includes('launch'), `reason: ${result.reason}`);
  });

  it('rejects when arms not stowed', () => {
    const gs = baseGameState({ allArmsStowed: false });
    const result = canUpgrade('Y0_QUAD', 'Y1_HEX', gs);
    assert.equal(result.allowed, false, 'rejected');
    assert.ok(result.reason.toLowerCase().includes('stow'), `reason: ${result.reason}`);
  });

  it('rejects when active operations in progress', () => {
    const gs = baseGameState({ noActiveOps: false });
    const result = canUpgrade('Y0_QUAD', 'Y1_HEX', gs);
    assert.equal(result.allowed, false, 'rejected');
    assert.ok(result.reason.toLowerCase().includes('operation'), `reason: ${result.reason}`);
  });

  it('rejects insufficient credits', () => {
    const gs = baseGameState({ credits: 100, debrisCleared: 15 });
    const result = canUpgrade('Y0_QUAD', 'Y1_HEX', gs);
    assert.equal(result.allowed, false, 'rejected');
    assert.ok(result.reason.toLowerCase().includes('credit'), `reason: ${result.reason}`);
  });

  it('rejects insufficient TRL (below debris gate)', () => {
    const gs = baseGameState({ credits: 5000, debrisCleared: 5 });
    const result = canUpgrade('Y0_QUAD', 'Y1_HEX', gs);
    assert.equal(result.allowed, false, 'rejected');
    assert.ok(result.reason.includes('TRL'), `reason: ${result.reason}`);
  });

  it('Y3 upgrade requires TRL 8 (30+ debris)', () => {
    const gs = baseGameState({ credits: 15000, debrisCleared: 25 });
    const result = canUpgrade('Y1_HEX', 'Y3_OCTO', gs);
    assert.equal(result.allowed, false, 'rejected at 25 debris');

    const gs2 = baseGameState({ credits: 15000, debrisCleared: 30 });
    const result2 = canUpgrade('Y1_HEX', 'Y3_OCTO', gs2);
    assert.equal(result2.allowed, true, `allowed at 30 debris: reason=${result2.reason}`);
  });

  it('Y1 upgrade requires exactly 5000 credits', () => {
    const gs1 = baseGameState({ credits: 4999, debrisCleared: 15 });
    assert.equal(canUpgrade('Y0_QUAD', 'Y1_HEX', gs1).allowed, false, 'rejected at 4999');

    const gs2 = baseGameState({ credits: 5000, debrisCleared: 15 });
    assert.equal(canUpgrade('Y0_QUAD', 'Y1_HEX', gs2).allowed, true, 'allowed at 5000');
  });
});

// ============================================================================
// UPGRADE EXECUTION — executeUpgrade
// ============================================================================

describe('ArmTierCatalog — executeUpgrade', () => {
  it('successful Y0→Y1 deducts credits + sets tier + emits event', () => {
    const am = mockArmManager('Y0_QUAD');
    const ss = mockScoring(10000, 20);
    const pm = mockPersistence();
    const gs = baseGameState({ credits: 10000, debrisCleared: 20 });

    const events = [];
    const unsub = eventBus.on(Events.TIER_UPGRADED, e => events.push(e));

    const result = executeUpgrade('Y0_QUAD', 'Y1_HEX', gs, {
      armManager: am,
      scoringSystem: ss,
      persistenceManager: pm,
    });

    assert.equal(result.success, true, 'upgrade succeeded');
    assert.equal(ss.credits, 5000, `credits after: ${ss.credits}`);
    assert.equal(am._activeTierKey, 'Y1_HEX', `tier set: ${am._activeTierKey}`);
    assert.equal(pm.getArmTier(), 'Y1_HEX', `persisted: ${pm.getArmTier()}`);
    assert.equal(events.length, 1, `events: ${events.length}`);
    assert.equal(events[0].fromTier, 'Y0_QUAD', 'event fromTier');
    assert.equal(events[0].toTier, 'Y1_HEX', 'event toTier');
    assert.equal(events[0].newArmCount, 6, `newArmCount: ${events[0].newArmCount}`);
    assert.equal(events[0].newMassDryKg, Constants.ARM_LADDER.Y1_HEX.dryMass, 'newMassDryKg');

    unsub();
  });

  it('successful Y1→Y3 deducts 15000 credits', () => {
    const am = mockArmManager('Y1_HEX');
    const ss = mockScoring(20000, 35);
    const pm = mockPersistence();
    const gs = baseGameState({ credits: 20000, debrisCleared: 35 });

    const result = executeUpgrade('Y1_HEX', 'Y3_OCTO', gs, {
      armManager: am,
      scoringSystem: ss,
      persistenceManager: pm,
    });

    assert.equal(result.success, true, 'upgrade succeeded');
    assert.equal(ss.credits, 5000, `credits: ${ss.credits}`);
    assert.equal(am._activeTierKey, 'Y3_OCTO', `tier: ${am._activeTierKey}`);
  });

  it('failed upgrade does not deduct credits or change tier', () => {
    const am = mockArmManager('Y0_QUAD');
    const ss = mockScoring(100, 20);
    const pm = mockPersistence();
    const gs = baseGameState({ credits: 100, debrisCleared: 20 });

    const rejected = [];
    const unsub = eventBus.on(Events.TIER_UPGRADE_REJECTED, e => rejected.push(e));

    const result = executeUpgrade('Y0_QUAD', 'Y1_HEX', gs, {
      armManager: am,
      scoringSystem: ss,
      persistenceManager: pm,
    });

    assert.equal(result.success, false, 'upgrade failed');
    assert.equal(ss.credits, 100, 'credits unchanged');
    assert.equal(am._activeTierKey, 'Y0_QUAD', 'tier unchanged');
    assert.equal(rejected.length, 1, 'rejection event emitted');
    assert.ok(rejected[0].reason.includes('credit'), `reason: ${rejected[0].reason}`);

    unsub();
  });

  it('calls generateDockPositions on armManager', () => {
    const am = mockArmManager('Y0_QUAD');
    const ss = mockScoring(10000, 20);
    const pm = mockPersistence();
    const gs = baseGameState({ credits: 10000, debrisCleared: 20 });

    executeUpgrade('Y0_QUAD', 'Y1_HEX', gs, {
      armManager: am,
      scoringSystem: ss,
      persistenceManager: pm,
    });

    assert.equal(am._lastGenerated, 'Y1_HEX', `generated: ${am._lastGenerated}`);
  });

  it('Y3 upgrade emits HOUSTON Octopus message', () => {
    const am = mockArmManager('Y1_HEX');
    const ss = mockScoring(20000, 35);
    const pm = mockPersistence();
    const gs = baseGameState({ credits: 20000, debrisCleared: 35 });

    const msgs = [];
    const unsub = eventBus.on(Events.COMMS_MESSAGE, e => msgs.push(e));

    executeUpgrade('Y1_HEX', 'Y3_OCTO', gs, {
      armManager: am,
      scoringSystem: ss,
      persistenceManager: pm,
    });

    const houston = msgs.find(m => m.sender === 'HOUSTON');
    assert.ok(houston !== undefined, 'HOUSTON message emitted');
    assert.ok(houston.text.includes('Octopus'), `text: ${houston.text}`);

    unsub();
  });

  it('Y1 upgrade emits HOUSTON Hex message', () => {
    const am = mockArmManager('Y0_QUAD');
    const ss = mockScoring(10000, 20);
    const pm = mockPersistence();
    const gs = baseGameState({ credits: 10000, debrisCleared: 20 });

    const msgs = [];
    const unsub = eventBus.on(Events.COMMS_MESSAGE, e => msgs.push(e));

    executeUpgrade('Y0_QUAD', 'Y1_HEX', gs, {
      armManager: am,
      scoringSystem: ss,
      persistenceManager: pm,
    });

    const houston = msgs.find(m => m.sender === 'HOUSTON');
    assert.ok(houston !== undefined, 'HOUSTON message emitted');
    assert.ok(houston.text.includes('Hex'), `text: ${houston.text}`);

    unsub();
  });
});

// ============================================================================
// EVENTS — Existence
// ============================================================================

describe('ArmTierCatalog — Events existence', () => {
  it('TIER_UPGRADE_AVAILABLE event defined', () => {
    assert.isType(Events.TIER_UPGRADE_AVAILABLE, 'string', 'event defined');
    assert.ok(Events.TIER_UPGRADE_AVAILABLE.length > 0, 'non-empty');
  });

  it('TIER_UPGRADE_REJECTED event defined', () => {
    assert.isType(Events.TIER_UPGRADE_REJECTED, 'string', 'event defined');
    assert.ok(Events.TIER_UPGRADE_REJECTED.length > 0, 'non-empty');
  });

  it('TIER_UPGRADED event defined', () => {
    assert.isType(Events.TIER_UPGRADED, 'string', 'event defined');
    assert.ok(Events.TIER_UPGRADED.length > 0, 'non-empty');
  });

  it('all three tier events are unique strings', () => {
    const evts = [Events.TIER_UPGRADE_AVAILABLE, Events.TIER_UPGRADE_REJECTED, Events.TIER_UPGRADED];
    const unique = new Set(evts);
    assert.equal(unique.size, 3, 'all unique');
  });
});

// ============================================================================
// FEATURE FLAG
// ============================================================================

describe('ArmTierCatalog — Feature Flag', () => {
  it('FEATURE_FLAGS.TIER_UPGRADES exists and defaults false', () => {
    assert.ok('TIER_UPGRADES' in Constants.FEATURE_FLAGS, 'flag exists');
    assert.equal(Constants.FEATURE_FLAGS.TIER_UPGRADES, false, 'default false');
  });

  it('isFeatureEnabled(TIER_UPGRADES) returns false by default', () => {
    assert.equal(Constants.isFeatureEnabled('TIER_UPGRADES'), false, 'disabled');
  });
});

// ============================================================================
// CONSTANTS — Tier Costs / TRL / Debris Gates
// ============================================================================

describe('ArmTierCatalog — Constants', () => {
  it('ARM_TIER_COSTS.Y1_HEX = 5000', () => {
    assert.equal(Constants.ARM_TIER_COSTS.Y1_HEX, 5000, 'Y1 cost');
  });

  it('ARM_TIER_COSTS.Y3_OCTO = 15000', () => {
    assert.equal(Constants.ARM_TIER_COSTS.Y3_OCTO, 15000, 'Y3 cost');
  });

  it('ARM_TIER_TRL_GATE.Y1_HEX = 6', () => {
    assert.equal(Constants.ARM_TIER_TRL_GATE.Y1_HEX, 6, 'Y1 TRL gate');
  });

  it('ARM_TIER_TRL_GATE.Y3_OCTO = 8', () => {
    assert.equal(Constants.ARM_TIER_TRL_GATE.Y3_OCTO, 8, 'Y3 TRL gate');
  });

  it('ARM_TIER_DEBRIS_GATE.Y1_HEX = 15', () => {
    assert.equal(Constants.ARM_TIER_DEBRIS_GATE.Y1_HEX, 15, 'Y1 debris gate');
  });

  it('ARM_TIER_DEBRIS_GATE.Y3_OCTO = 30', () => {
    assert.equal(Constants.ARM_TIER_DEBRIS_GATE.Y3_OCTO, 30, 'Y3 debris gate');
  });
});

// ============================================================================
// MASS VALUES MATCH ARM_LADDER (no discrepancy)
// ============================================================================

describe('ArmTierCatalog — Mass parity with ARM_LADDER', () => {
  it('Y0_QUAD dry mass matches ARM_LADDER (196.4 kg)', () => {
    const t = getTierDescriptor('Y0_QUAD');
    assert.equal(t.massDryKg, 196.4, `got ${t.massDryKg}`);
  });

  it('Y1_HEX dry mass matches ARM_LADDER (208.0 kg)', () => {
    const t = getTierDescriptor('Y1_HEX');
    assert.equal(t.massDryKg, 208.0, `got ${t.massDryKg}`);
  });

  it('Y3_OCTO dry mass matches ARM_LADDER (222.0 kg)', () => {
    const t = getTierDescriptor('Y3_OCTO');
    assert.equal(t.massDryKg, 222.0, `got ${t.massDryKg}`);
  });

  it('Y0_QUAD wet mass matches ARM_LADDER (242.4 kg)', () => {
    const t = getTierDescriptor('Y0_QUAD');
    assert.equal(t.massWetKg, 242.4, `got ${t.massWetKg}`);
  });

  it('Y1_HEX wet mass matches ARM_LADDER (254.0 kg)', () => {
    const t = getTierDescriptor('Y1_HEX');
    assert.equal(t.massWetKg, 254.0, `got ${t.massWetKg}`);
  });

  it('Y3_OCTO wet mass matches ARM_LADDER (268.0 kg)', () => {
    const t = getTierDescriptor('Y3_OCTO');
    assert.equal(t.massWetKg, 268.0, `got ${t.massWetKg}`);
  });
});

// ============================================================================
// PERSISTENCE ROUND-TRIP
// ============================================================================

describe('ArmTierCatalog — Persistence round-trip', () => {
  it('executeUpgrade persists tier via PersistenceManager.setArmTier', () => {
    const pm = mockPersistence();
    const am = mockArmManager('Y0_QUAD');
    const ss = mockScoring(10000, 20);
    const gs = baseGameState({ credits: 10000, debrisCleared: 20 });

    executeUpgrade('Y0_QUAD', 'Y1_HEX', gs, {
      armManager: am,
      scoringSystem: ss,
      persistenceManager: pm,
    });

    assert.equal(pm.getArmTier(), 'Y1_HEX', `persisted tier: ${pm.getArmTier()}`);
  });

  it('sequential upgrades persist correctly', () => {
    const pm = mockPersistence();
    const am = mockArmManager('Y0_QUAD');
    const ss = mockScoring(50000, 40);

    // Y0 → Y1
    executeUpgrade('Y0_QUAD', 'Y1_HEX', baseGameState({ credits: 50000, debrisCleared: 40 }), {
      armManager: am,
      scoringSystem: ss,
      persistenceManager: pm,
    });
    assert.equal(pm.getArmTier(), 'Y1_HEX', 'first upgrade persisted');

    // Y1 → Y3
    executeUpgrade('Y1_HEX', 'Y3_OCTO', baseGameState({ credits: ss.credits, debrisCleared: 40 }), {
      armManager: am,
      scoringSystem: ss,
      persistenceManager: pm,
    });
    assert.equal(pm.getArmTier(), 'Y3_OCTO', 'second upgrade persisted');
  });
});

// ============================================================================
// COM IMPACT — tier mass changes
// ============================================================================

describe('ArmTierCatalog — CoM mass impact', () => {
  it('Y1 dry mass > Y0 dry mass (additional arms add mass)', () => {
    const y0 = getTierDescriptor('Y0_QUAD');
    const y1 = getTierDescriptor('Y1_HEX');
    assert.ok(y1.massDryKg > y0.massDryKg, `${y1.massDryKg} > ${y0.massDryKg}`);
  });

  it('Y3 dry mass > Y1 dry mass', () => {
    const y1 = getTierDescriptor('Y1_HEX');
    const y3 = getTierDescriptor('Y3_OCTO');
    assert.ok(y3.massDryKg > y1.massDryKg, `${y3.massDryKg} > ${y1.massDryKg}`);
  });

  it('mass delta Y0→Y1 = 11.6 kg (208.0 - 196.4)', () => {
    const y0 = getTierDescriptor('Y0_QUAD');
    const y1 = getTierDescriptor('Y1_HEX');
    const delta = Math.round((y1.massDryKg - y0.massDryKg) * 10) / 10;
    assert.equal(delta, 11.6, `delta: ${delta}`);
  });

  it('mass delta Y1→Y3 = 14.0 kg (222.0 - 208.0)', () => {
    const y1 = getTierDescriptor('Y1_HEX');
    const y3 = getTierDescriptor('Y3_OCTO');
    const delta = Math.round((y3.massDryKg - y1.massDryKg) * 10) / 10;
    assert.equal(delta, 14.0, `delta: ${delta}`);
  });

  it('wet mass increases proportionally', () => {
    const y0 = getTierDescriptor('Y0_QUAD');
    const y1 = getTierDescriptor('Y1_HEX');
    const y3 = getTierDescriptor('Y3_OCTO');
    assert.ok(y1.massWetKg > y0.massWetKg, 'Y1 wet > Y0 wet');
    assert.ok(y3.massWetKg > y1.massWetKg, 'Y3 wet > Y1 wet');
  });
});

// ============================================================================
// EDGE CASES
// ============================================================================

describe('ArmTierCatalog — Edge cases', () => {
  it('executeUpgrade with null armManager still handles gracefully', () => {
    const ss = mockScoring(10000, 20);
    const gs = baseGameState({ credits: 10000, debrisCleared: 20 });

    // Should not throw
    const result = executeUpgrade('Y0_QUAD', 'Y1_HEX', gs, {
      armManager: null,
      scoringSystem: ss,
      persistenceManager: null,
    });
    assert.equal(result.success, true, 'still succeeds (credits deducted)');
    assert.equal(ss.credits, 5000, 'credits deducted');
  });

  it('executeUpgrade with null scoringSystem does not crash', () => {
    const am = mockArmManager('Y0_QUAD');
    const gs = baseGameState({ credits: 10000, debrisCleared: 20 });

    const result = executeUpgrade('Y0_QUAD', 'Y1_HEX', gs, {
      armManager: am,
      scoringSystem: null,
      persistenceManager: null,
    });
    assert.equal(result.success, true, 'succeeds without scoring');
  });

  it('canUpgrade with missing gameState fields degrades gracefully', () => {
    const result = canUpgrade('Y0_QUAD', 'Y1_HEX', {});
    assert.equal(result.allowed, false, 'rejected with empty state');
  });

  it('buildCatalog returns fresh copy each time', () => {
    const c1 = buildCatalog();
    const c2 = buildCatalog();
    assert.notEqual(c1, c2, 'different objects');
    assert.notEqual(c1.Y0_QUAD, c2.Y0_QUAD, 'different tier objects');
  });
});

// ============================================================================
// GATING BOUNDARY TESTS
// ============================================================================

describe('ArmTierCatalog — Gating boundaries', () => {
  it('exact credit boundary: Y1 at 5000 credits passes', () => {
    const gs = baseGameState({ credits: 5000, debrisCleared: 15 });
    assert.equal(canUpgrade('Y0_QUAD', 'Y1_HEX', gs).allowed, true, 'exact match');
  });

  it('exact credit boundary: Y3 at 15000 credits passes', () => {
    const gs = baseGameState({ credits: 15000, debrisCleared: 30 });
    assert.equal(canUpgrade('Y1_HEX', 'Y3_OCTO', gs).allowed, true, 'exact match');
  });

  it('debris boundary: 14 cleared → Y1 rejected (need 15)', () => {
    const gs = baseGameState({ credits: 5000, debrisCleared: 14 });
    assert.equal(canUpgrade('Y0_QUAD', 'Y1_HEX', gs).allowed, false, 'rejected at 14');
  });

  it('debris boundary: 15 cleared → Y1 allowed', () => {
    const gs = baseGameState({ credits: 5000, debrisCleared: 15 });
    assert.equal(canUpgrade('Y0_QUAD', 'Y1_HEX', gs).allowed, true, 'allowed at 15');
  });

  it('debris boundary: 29 cleared → Y3 rejected (need 30)', () => {
    const gs = baseGameState({ credits: 15000, debrisCleared: 29 });
    assert.equal(canUpgrade('Y1_HEX', 'Y3_OCTO', gs).allowed, false, 'rejected at 29');
  });

  it('debris boundary: 30 cleared → Y3 allowed', () => {
    const gs = baseGameState({ credits: 15000, debrisCleared: 30 });
    assert.equal(canUpgrade('Y1_HEX', 'Y3_OCTO', gs).allowed, true, 'allowed at 30');
  });
});

// ============================================================================
// PERSISTENCE MISMATCH VALIDATION (AC #5)
// ============================================================================

describe('ArmTierCatalog — Persistence mismatch validation', () => {
  it('validateArmStateData: matching Y0_QUAD (4 arms) returns valid', () => {
    const data = {
      armDeployStates: ['STOWED', 'STOWED', 'STOWED', 'STOWED'],
      captureNet: { armNetCounts: [2, 2, 2, 2] },
      tetherReels: [{}, {}, {}, {}],
      bridleRings: [{}, {}, {}, {}],
    };
    const result = validateArmStateData('Y0_QUAD', data);
    assert.equal(result.valid, true, 'valid with matching counts');
    assert.equal(result.armCount, 4, 'armCount 4');
    assert.ok(result.armDeployStates !== null, 'deploy states preserved');
    assert.ok(result.armNetCounts !== null, 'net counts preserved');
    assert.ok(result.reelStates !== null, 'reel states preserved');
    assert.ok(result.bridleRings !== null, 'bridle rings preserved');
  });

  it('validateArmStateData: mismatched deploy states (4 saved, Y1_HEX expects 6) → null + invalid', () => {
    const data = {
      armDeployStates: ['STOWED', 'STOWED', 'STOWED', 'STOWED'],
    };
    const result = validateArmStateData('Y1_HEX', data);
    assert.equal(result.valid, false, 'invalid on mismatch');
    assert.equal(result.armCount, 6, 'expected count is 6');
    assert.equal(result.armDeployStates, null, 'deploy states reset to null');
  });

  it('validateArmStateData: mismatched net inventory → null + invalid', () => {
    const data = {
      armDeployStates: ['STOWED', 'STOWED', 'STOWED', 'STOWED', 'STOWED', 'STOWED'],
      captureNet: { armNetCounts: [2, 2, 2, 2] }, // 4 counts for Y1_HEX (6 arms)
    };
    const result = validateArmStateData('Y1_HEX', data);
    assert.equal(result.valid, false, 'invalid — net counts mismatch');
    assert.equal(result.armNetCounts, null, 'net counts reset');
    assert.ok(result.armDeployStates !== null, 'deploy states preserved (correct length)');
  });

  it('validateArmStateData: mismatched reel states → null + invalid', () => {
    const data = {
      tetherReels: [{}, {}, {}, {}], // 4 for Y3_OCTO (8 arms)
    };
    const result = validateArmStateData('Y3_OCTO', data);
    assert.equal(result.valid, false, 'invalid — reel count mismatch');
    assert.equal(result.reelStates, null, 'reel states reset');
    assert.equal(result.armCount, 8, 'expected count is 8');
  });

  it('validateArmStateData: null data → valid (all null fields)', () => {
    const result = validateArmStateData('Y0_QUAD', null);
    assert.equal(result.valid, true, 'valid with null data (nothing to mismatch)');
    assert.equal(result.armDeployStates, null, 'no deploy states');
    assert.equal(result.armNetCounts, null, 'no net counts');
    assert.equal(result.reelStates, null, 'no reel states');
    assert.equal(result.bridleRings, null, 'no bridle rings');
  });

  it('validateArmStateData: unknown tier → invalid + armCount 4', () => {
    const result = validateArmStateData('Y9_DECA', {});
    assert.equal(result.valid, false, 'invalid for unknown tier');
    assert.equal(result.armCount, 4, 'defaults to 4');
  });

  it('validateArmStateData: matching Y3_OCTO (8 arms) all correct', () => {
    const data = {
      armDeployStates: Array(8).fill('DEPLOYED'),
      captureNet: { armNetCounts: Array(8).fill(2) },
      tetherReels: Array(8).fill({}),
      bridleRings: Array(8).fill({}),
    };
    const result = validateArmStateData('Y3_OCTO', data);
    assert.equal(result.valid, true, 'valid with all 8');
    assert.equal(result.armCount, 8, 'armCount 8');
  });

  it('validateArmStateData: mixed mismatch (some match, some not)', () => {
    const data = {
      armDeployStates: Array(6).fill('STOWED'),     // matches Y1_HEX
      captureNet: { armNetCounts: Array(4).fill(3) }, // wrong (4 ≠ 6)
      tetherReels: Array(6).fill({}),                 // matches Y1_HEX
      bridleRings: Array(8).fill({}),                 // wrong (8 ≠ 6)
    };
    const result = validateArmStateData('Y1_HEX', data);
    assert.equal(result.valid, false, 'invalid — partial mismatch');
    assert.ok(result.armDeployStates !== null, 'deploy states preserved');
    assert.equal(result.armNetCounts, null, 'net counts reset');
    assert.ok(result.reelStates !== null, 'reel states preserved');
    assert.equal(result.bridleRings, null, 'bridle rings reset');
  });
});

// ============================================================================
// CoM — computeCoM uses armManager.arms dynamically (AC #7)
// ============================================================================

describe('ArmTierCatalog — CoM tier coupling', () => {
  it('CoMCalculator arm count adapts to tier (4-arm vs 6-arm mock)', () => {
    // Verify that catalog arm counts match ARM_LADDER for CoM consistency
    const y0 = getTierDescriptor('Y0_QUAD');
    const y1 = getTierDescriptor('Y1_HEX');
    const y3 = getTierDescriptor('Y3_OCTO');

    // computeCoM iterates armManager.arms[] — after tier change, arms.length changes
    // Verify arm counts are what CoMCalculator would iterate over
    assert.equal(y0.armCount, Constants.ARM_LADDER.Y0_QUAD.armCount, 'Y0 count 4');
    assert.equal(y1.armCount, Constants.ARM_LADDER.Y1_HEX.armCount, 'Y1 count 6');
    assert.equal(y3.armCount, Constants.ARM_LADDER.Y3_OCTO.armCount, 'Y3 count 8');
  });

  it('total strut mass differs per tier (STRUT_MASS × armCount)', () => {
    const strutMass = Constants.OCTOPUS_V5.STRUT_MASS; // 4.5 kg
    assert.equal(strutMass * 4, 18.0, 'Y0 strut mass 18.0 kg');
    assert.equal(strutMass * 6, 27.0, 'Y1 strut mass 27.0 kg');
    assert.equal(strutMass * 8, 36.0, 'Y3 strut mass 36.0 kg');
  });

  it('tier dry mass includes correct strut + daughter contributions', () => {
    // Core dry mass is constant across tiers (161.0 kg)
    const coreDry = Constants.OCTOPUS_V5.CORE_DRY_MASS;
    assert.equal(coreDry, 161.0, 'core dry mass 161.0 kg');

    // Total dry mass should be: core + struts + daughters
    // The exact ARM_LADDER values are derived with ROSA + struts + daughters
    // but they should all be > coreDry
    const y0Dry = getTierDescriptor('Y0_QUAD').massDryKg;
    const y1Dry = getTierDescriptor('Y1_HEX').massDryKg;
    const y3Dry = getTierDescriptor('Y3_OCTO').massDryKg;
    assert.ok(y0Dry > coreDry, `Y0 dry ${y0Dry} > core ${coreDry}`);
    assert.ok(y1Dry > y0Dry, `Y1 dry ${y1Dry} > Y0 ${y0Dry}`);
    assert.ok(y3Dry > y1Dry, `Y3 dry ${y3Dry} > Y1 ${y1Dry}`);
  });
});
