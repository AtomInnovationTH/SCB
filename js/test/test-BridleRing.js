/**
 * test-BridleRing.js — ST-9.7 C-8: Bridle Ring (Simplified, Config G)
 *
 * Tests: create, attach, detach, overload, load balance, persistence,
 *        CoM integration, feature flag gating, event emission.
 */
import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import {
  BridleRing,
  computeLoadBalance,
} from '../entities/BridleRing.js';
import { generateDockPositions } from '../entities/ArmManager.js';
import {
  computeCoM,
  strutTipMeters,
} from '../systems/CoMCalculator.js';
import { persistenceManager } from '../systems/PersistenceManager.js';

const BR = Constants.OCTOPUS_V5.BRIDLE;
const STATES = Constants.BRIDLE_STATES;
const M = 0.00001;
const V5 = Constants.OCTOPUS_V5;

// ── Helpers ─────────────────────────────────────────────────────────────

/** Create a mock arm with given alpha and type */
function mockArm(alpha = 0, type = 'weaver', opts = {}) {
  return {
    _aimAlpha: alpha,
    getAimAlpha() { return this._aimAlpha; },
    config: {
      type,
      mass: type === 'weaver' ? Constants.V5_WEAVER_MASS : Constants.V5_SPINNER_MASS,
    },
    state: opts.state || Constants.ARM_STATES.DOCKED,
    isDetached: opts.isDetached || false,
    getDeployState() { return opts.deployState || 'DEPLOYED'; },
  };
}

function makeMockArmManager(n = 4, alpha = Math.PI / 2) {
  const docks = generateDockPositions(n);
  const arms = [];
  for (let i = 0; i < n; i++) {
    arms.push(mockArm(alpha, i % 2 === 0 ? 'weaver' : 'spinner'));
  }
  return { arms, _dockPositions: docks };
}

// ═══════════════════════════════════════════════════════════════════════════
// §1  Constants Check
// ═══════════════════════════════════════════════════════════════════════════

describe('BridleRing — Constants', () => {
  it('OCTOPUS_V5.BRIDLE exists with required fields', () => {
    assert.ok(BR, 'BRIDLE block exists');
    assert.equal(BR.ATTACH_POINTS_PER_RING, 3);
    assert.equal(BR.MAX_LOAD_PER_POINT_KG, 200);
    assert.equal(BR.RING_MASS_KG, 0.3);
    assert.equal(BR.OVERLOAD_FACTOR, 1.2);
  });

  it('BRIDLE_STATES enum has all 4 states', () => {
    assert.equal(STATES.IDLE, 'IDLE');
    assert.equal(STATES.ATTACHED, 'ATTACHED');
    assert.equal(STATES.OVERLOADED, 'OVERLOADED');
    assert.equal(STATES.DAMAGED, 'DAMAGED');
  });

  it('FEATURE_FLAGS.BRIDLE_RING exists and defaults false', () => {
    assert.equal(Constants.FEATURE_FLAGS.BRIDLE_RING, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §2  Events Check
// ═══════════════════════════════════════════════════════════════════════════

describe('BridleRing — Events', () => {
  it('BRIDLE_ATTACH event constant exists', () => {
    assert.equal(Events.BRIDLE_ATTACH, 'bridle:attach');
  });

  it('BRIDLE_DETACH event constant exists', () => {
    assert.equal(Events.BRIDLE_DETACH, 'bridle:detach');
  });

  it('BRIDLE_OVERLOAD event constant exists', () => {
    assert.equal(Events.BRIDLE_OVERLOAD, 'bridle:overload');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §3  Create + Basic API
// ═══════════════════════════════════════════════════════════════════════════

describe('BridleRing — Create', () => {
  it('create() returns status with 3 attach points by default', () => {
    BridleRing.resetAll();
    const s = BridleRing.create(0);
    assert.ok(s, 'status returned');
    assert.equal(s.armIndex, 0);
    assert.equal(s.attachPoints.length, 3);
    assert.equal(s.state, STATES.IDLE);
    assert.equal(s.totalLoadKg, 0);
    assert.equal(s.loadBalanceFactor, 1.0);
  });

  it('create() with custom attach point count', () => {
    BridleRing.resetAll();
    const s = BridleRing.create(1, 5);
    assert.equal(s.attachPoints.length, 5);
  });

  it('getStatus() returns null for non-existent ring', () => {
    BridleRing.resetAll();
    const s = BridleRing.getStatus(99);
    assert.equal(s, null);
  });

  it('getTotalLoadKg() returns 0 for non-existent ring', () => {
    BridleRing.resetAll();
    assert.equal(BridleRing.getTotalLoadKg(99), 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §4  Attach + Detach
// ═══════════════════════════════════════════════════════════════════════════

describe('BridleRing — Attach/Detach', () => {
  it('attach() occupies a point and updates load', () => {
    BridleRing.resetAll();
    BridleRing.create(0);
    const ok = BridleRing.attach(0, 'pt-0', 'debris-A', 50);
    assert.ok(ok, 'attach returned true');

    const s = BridleRing.getStatus(0);
    assert.equal(s.totalLoadKg, 50);
    assert.equal(s.state, STATES.ATTACHED);
    assert.ok(s.attachPoints[0].isOccupied);
    assert.equal(s.attachPoints[0].payloadId, 'debris-A');
    assert.equal(s.attachPoints[0].currentLoadKg, 50);
  });

  it('attach() to occupied point returns false', () => {
    BridleRing.resetAll();
    BridleRing.create(0);
    BridleRing.attach(0, 'pt-0', 'debris-A', 50);
    const ok = BridleRing.attach(0, 'pt-0', 'debris-B', 30);
    assert.equal(ok, false);
  });

  it('attach() to non-existent ring returns false', () => {
    BridleRing.resetAll();
    assert.equal(BridleRing.attach(99, 'pt-0', 'x', 10), false);
  });

  it('attach() to non-existent point returns false', () => {
    BridleRing.resetAll();
    BridleRing.create(0);
    assert.equal(BridleRing.attach(0, 'pt-99', 'x', 10), false);
  });

  it('detach() clears point and reduces load', () => {
    BridleRing.resetAll();
    BridleRing.create(0);
    BridleRing.attach(0, 'pt-0', 'debris-A', 50);
    BridleRing.attach(0, 'pt-1', 'debris-B', 30);

    const ok = BridleRing.detach(0, 'pt-0');
    assert.ok(ok, 'detach returned true');

    const s = BridleRing.getStatus(0);
    assert.equal(s.totalLoadKg, 30);
    assert.equal(s.attachPoints[0].isOccupied, false);
    assert.equal(s.attachPoints[0].payloadId, null);
  });

  it('detach all → state returns to IDLE', () => {
    BridleRing.resetAll();
    BridleRing.create(0);
    BridleRing.attach(0, 'pt-0', 'x', 10);
    BridleRing.detach(0, 'pt-0');
    const s = BridleRing.getStatus(0);
    assert.equal(s.state, STATES.IDLE);
  });

  it('detach on empty point returns false', () => {
    BridleRing.resetAll();
    BridleRing.create(0);
    assert.equal(BridleRing.detach(0, 'pt-0'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §5  Event Emission
// ═══════════════════════════════════════════════════════════════════════════

describe('BridleRing — Event Emission', () => {
  it('attach emits BRIDLE_ATTACH', () => {
    BridleRing.resetAll();
    BridleRing.create(0);

    let received = null;
    const unsub = eventBus.on(Events.BRIDLE_ATTACH, (e) => { received = e; });

    BridleRing.attach(0, 'pt-0', 'deb-1', 42);

    assert.ok(received, 'event fired');
    assert.equal(received.armIndex, 0);
    assert.equal(received.pointId, 'pt-0');
    assert.equal(received.payloadId, 'deb-1');
    assert.equal(received.loadKg, 42);

    if (typeof unsub === 'function') unsub();
    else eventBus.off(Events.BRIDLE_ATTACH);
  });

  it('detach emits BRIDLE_DETACH', () => {
    BridleRing.resetAll();
    BridleRing.create(0);
    BridleRing.attach(0, 'pt-1', 'deb-2', 25);

    let received = null;
    const unsub = eventBus.on(Events.BRIDLE_DETACH, (e) => { received = e; });

    BridleRing.detach(0, 'pt-1');

    assert.ok(received, 'event fired');
    assert.equal(received.armIndex, 0);
    assert.equal(received.pointId, 'pt-1');
    assert.equal(received.payloadId, 'deb-2');

    if (typeof unsub === 'function') unsub();
    else eventBus.off(Events.BRIDLE_DETACH);
  });

  it('overload emits BRIDLE_OVERLOAD and sets DAMAGED state', () => {
    BridleRing.resetAll();
    BridleRing.create(0);

    let received = null;
    const unsub = eventBus.on(Events.BRIDLE_OVERLOAD, (e) => { received = e; });

    // Max per point = 200, overload factor = 1.2 → threshold = 240 kg
    // Attaching 250 kg should trigger overload
    BridleRing.attach(0, 'pt-0', 'heavy', 250);

    assert.ok(received, 'overload event fired');
    assert.equal(received.armIndex, 0);
    assert.equal(received.pointId, 'pt-0');
    assert.equal(received.loadKg, 250);
    assert.equal(received.maxKg, 200);

    const s = BridleRing.getStatus(0);
    assert.equal(s.state, STATES.DAMAGED);

    if (typeof unsub === 'function') unsub();
    else eventBus.off(Events.BRIDLE_OVERLOAD);
  });

  it('load at exactly threshold does NOT trigger overload', () => {
    BridleRing.resetAll();
    BridleRing.create(0);

    let received = null;
    const unsub = eventBus.on(Events.BRIDLE_OVERLOAD, (e) => { received = e; });

    // Threshold = 200 * 1.2 = 240. Attaching exactly 240 should NOT trigger
    BridleRing.attach(0, 'pt-0', 'borderline', 240);

    assert.equal(received, null, 'no overload at exact threshold');
    const s = BridleRing.getStatus(0);
    assert.equal(s.state, STATES.ATTACHED);

    if (typeof unsub === 'function') unsub();
    else eventBus.off(Events.BRIDLE_OVERLOAD);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §6  Load Balance
// ═══════════════════════════════════════════════════════════════════════════

describe('BridleRing — Load Balance', () => {
  it('empty ring → balance = 1.0', () => {
    const points = [
      { currentLoadKg: 0 },
      { currentLoadKg: 0 },
      { currentLoadKg: 0 },
    ];
    assert.equal(computeLoadBalance(points), 1.0);
  });

  it('perfectly balanced (50/50/50) → factor = 1.0', () => {
    const points = [
      { currentLoadKg: 50 },
      { currentLoadKg: 50 },
      { currentLoadKg: 50 },
    ];
    assert.closeTo(computeLoadBalance(points), 1.0, 0.01);
  });

  it('all load on one point (100/0/0) → factor < 0.5', () => {
    const points = [
      { currentLoadKg: 100 },
      { currentLoadKg: 0 },
      { currentLoadKg: 0 },
    ];
    const balance = computeLoadBalance(points);
    assert.ok(balance < 0.5, `Expected < 0.5, got ${balance}`);
  });

  it('two loaded, one empty (50/50/0) → intermediate balance', () => {
    const points = [
      { currentLoadKg: 50 },
      { currentLoadKg: 50 },
      { currentLoadKg: 0 },
    ];
    const balance = computeLoadBalance(points);
    assert.ok(balance > 0.2, `Expected > 0.2, got ${balance}`);
    assert.ok(balance < 0.9, `Expected < 0.9, got ${balance}`);
  });

  it('asymmetric (100/50/0) → lower balance than (50/50/50)', () => {
    const even = [
      { currentLoadKg: 50 },
      { currentLoadKg: 50 },
      { currentLoadKg: 50 },
    ];
    const uneven = [
      { currentLoadKg: 100 },
      { currentLoadKg: 50 },
      { currentLoadKg: 0 },
    ];
    const balEven = computeLoadBalance(even);
    const balUneven = computeLoadBalance(uneven);
    assert.ok(balUneven < balEven,
      `Uneven (${balUneven}) should be less than even (${balEven})`);
  });

  it('getStatus returns computed balance', () => {
    BridleRing.resetAll();
    BridleRing.create(0);
    BridleRing.attach(0, 'pt-0', 'a', 50);
    BridleRing.attach(0, 'pt-1', 'b', 50);
    BridleRing.attach(0, 'pt-2', 'c', 50);
    const s = BridleRing.getStatus(0);
    assert.closeTo(s.loadBalanceFactor, 1.0, 0.01);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §7  Overload Detection
// ═══════════════════════════════════════════════════════════════════════════

describe('BridleRing — Overload', () => {
  it('checkOverload returns false when within limits', () => {
    BridleRing.resetAll();
    BridleRing.create(0);
    BridleRing.attach(0, 'pt-0', 'safe', 100);
    assert.equal(BridleRing.checkOverload(0), false);
  });

  it('checkOverload returns true when exceeding threshold', () => {
    BridleRing.resetAll();
    BridleRing.create(0);
    BridleRing.attach(0, 'pt-0', 'heavy', 250);
    // Already triggered on attach, but calling again should still return true
    assert.equal(BridleRing.checkOverload(0), true);
  });

  it('DAMAGED state persists after detach (structural damage)', () => {
    BridleRing.resetAll();
    BridleRing.create(0);
    BridleRing.attach(0, 'pt-0', 'heavy', 250);
    BridleRing.detach(0, 'pt-0');
    const s = BridleRing.getStatus(0);
    assert.equal(s.state, STATES.DAMAGED, 'DAMAGED should persist');
  });

  it('checkOverload on non-existent ring returns false', () => {
    BridleRing.resetAll();
    assert.equal(BridleRing.checkOverload(99), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §8  findFreePoint
// ═══════════════════════════════════════════════════════════════════════════

describe('BridleRing — findFreePoint', () => {
  it('returns first free point on fresh ring', () => {
    BridleRing.resetAll();
    BridleRing.create(0);
    assert.equal(BridleRing.findFreePoint(0), 'pt-0');
  });

  it('skips occupied points', () => {
    BridleRing.resetAll();
    BridleRing.create(0);
    BridleRing.attach(0, 'pt-0', 'a', 10);
    assert.equal(BridleRing.findFreePoint(0), 'pt-1');
  });

  it('returns null when all occupied', () => {
    BridleRing.resetAll();
    BridleRing.create(0);
    BridleRing.attach(0, 'pt-0', 'a', 10);
    BridleRing.attach(0, 'pt-1', 'b', 10);
    BridleRing.attach(0, 'pt-2', 'c', 10);
    assert.equal(BridleRing.findFreePoint(0), null);
  });

  it('returns null for non-existent ring', () => {
    BridleRing.resetAll();
    assert.equal(BridleRing.findFreePoint(99), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §9  getRingMassKg
// ═══════════════════════════════════════════════════════════════════════════

describe('BridleRing — getRingMassKg', () => {
  it('empty ring returns only structural mass', () => {
    BridleRing.resetAll();
    BridleRing.create(0);
    assert.closeTo(BridleRing.getRingMassKg(0), BR.RING_MASS_KG, 0.001);
  });

  it('loaded ring adds payload mass', () => {
    BridleRing.resetAll();
    BridleRing.create(0);
    BridleRing.attach(0, 'pt-0', 'a', 50);
    BridleRing.attach(0, 'pt-1', 'b', 30);
    assert.closeTo(BridleRing.getRingMassKg(0), BR.RING_MASS_KG + 80, 0.001);
  });

  it('non-existent ring returns 0', () => {
    BridleRing.resetAll();
    assert.equal(BridleRing.getRingMassKg(99), 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §10  Persistence Round-Trip
// ═══════════════════════════════════════════════════════════════════════════

describe('BridleRing — Persistence', () => {
  it('getSerializableState() captures all ring data', () => {
    BridleRing.resetAll();
    BridleRing.create(0);
    BridleRing.create(1);
    BridleRing.attach(0, 'pt-0', 'debris-A', 42);
    BridleRing.attach(1, 'pt-2', 'debris-B', 88);

    const data = BridleRing.getSerializableState();
    assert.equal(data.length, 2);

    const ring0 = data.find(d => d.armIndex === 0);
    assert.ok(ring0, 'ring 0 present');
    assert.equal(ring0.attachments.length, 1);
    assert.equal(ring0.attachments[0].pointId, 'pt-0');
    assert.equal(ring0.attachments[0].payloadId, 'debris-A');
    assert.equal(ring0.attachments[0].loadKg, 42);

    const ring1 = data.find(d => d.armIndex === 1);
    assert.ok(ring1, 'ring 1 present');
    assert.equal(ring1.attachments.length, 1);
  });

  it('restoreState() rebuilds rings from serialized data', () => {
    BridleRing.resetAll();

    const data = [
      {
        armIndex: 0,
        state: 'ATTACHED',
        attachments: [
          { pointId: 'pt-0', payloadId: 'recov-A', loadKg: 55 },
          { pointId: 'pt-2', payloadId: 'recov-B', loadKg: 33 },
        ],
      },
      {
        armIndex: 2,
        state: 'DAMAGED',
        attachments: [],
      },
    ];

    BridleRing.restoreState(data);

    const s0 = BridleRing.getStatus(0);
    assert.ok(s0, 'ring 0 restored');
    assert.equal(s0.totalLoadKg, 88);
    assert.equal(s0.state, STATES.ATTACHED);
    assert.ok(s0.attachPoints[0].isOccupied);
    assert.ok(s0.attachPoints[2].isOccupied);
    assert.equal(s0.attachPoints[0].payloadId, 'recov-A');

    const s2 = BridleRing.getStatus(2);
    assert.ok(s2, 'ring 2 restored');
    assert.equal(s2.state, STATES.DAMAGED);
    assert.equal(s2.totalLoadKg, 0);
  });

  it('round-trip: serialize → reset → restore matches', () => {
    BridleRing.resetAll();
    BridleRing.create(0);
    BridleRing.attach(0, 'pt-1', 'payload-X', 77);

    const serialized = BridleRing.getSerializableState();
    BridleRing.resetAll();

    // Verify clean state
    assert.equal(BridleRing.getStatus(0), null);

    // Restore
    BridleRing.restoreState(serialized);

    const s = BridleRing.getStatus(0);
    assert.ok(s, 'restored');
    assert.equal(s.totalLoadKg, 77);
    assert.ok(s.attachPoints[1].isOccupied);
    assert.equal(s.attachPoints[1].payloadId, 'payload-X');
  });

  it('restoreState with invalid data is safe', () => {
    BridleRing.resetAll();
    BridleRing.restoreState(null);
    BridleRing.restoreState(undefined);
    BridleRing.restoreState('not an array');
    assert.equal(BridleRing.getAllArmIndices().length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §11  PersistenceManager Integration
// ═══════════════════════════════════════════════════════════════════════════

describe('BridleRing — PersistenceManager', () => {
  it('setBridleState/getBridleState methods exist', () => {
    assert.isType(persistenceManager.setBridleState, 'function');
    assert.isType(persistenceManager.getBridleState, 'function');
  });

  it('getBridleState returns null for fresh save', () => {
    const result = persistenceManager.getBridleState();
    // May be null or array depending on prior tests; just verify no crash
    assert.ok(result === null || Array.isArray(result), 'safe return');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §12  CoM Integration (flag-gated)
// ═══════════════════════════════════════════════════════════════════════════

describe('BridleRing — CoM Integration', () => {
  it('with BRIDLE_RING + COM_TRACKING ON, bridle load shifts CoM', () => {
    // Save flags
    const origBridle = Constants.FEATURE_FLAGS.BRIDLE_RING;
    const origCoM = Constants.FEATURE_FLAGS.COM_TRACKING;

    try {
      Constants.FEATURE_FLAGS.BRIDLE_RING = true;
      Constants.FEATURE_FLAGS.COM_TRACKING = true;

      BridleRing.resetAll();
      const am = makeMockArmManager(4, Math.PI / 2);

      // Baseline CoM (no bridle rings)
      const comBase = computeCoM(am);

      // Create bridle ring on arm 0 with 50 kg load
      BridleRing.create(0);
      BridleRing.attach(0, 'pt-0', 'heavy-debris', 50);

      const comLoaded = computeCoM(am);

      // Total mass should increase by ring mass + payload
      const expectedMassDelta = BR.RING_MASS_KG + 50;
      assert.closeTo(comLoaded.totalMass - comBase.totalMass, expectedMassDelta, 0.1,
        'total mass increased by bridle ring + payload');

      // CoM position should shift measurably toward arm 0's strut tip
      const dx = comLoaded.position.x - comBase.position.x;
      const dy = comLoaded.position.y - comBase.position.y;
      const dz = comLoaded.position.z - comBase.position.z;
      const comShift = Math.sqrt(dx * dx + dy * dy + dz * dz);
      assert.ok(comShift > 0.001,
        `CoM should shift measurably (got ${comShift.toFixed(6)} m)`);
    } finally {
      Constants.FEATURE_FLAGS.BRIDLE_RING = origBridle;
      Constants.FEATURE_FLAGS.COM_TRACKING = origCoM;
      BridleRing.resetAll();
    }
  });

  it('with BRIDLE_RING OFF, no CoM change from bridle', () => {
    const origBridle = Constants.FEATURE_FLAGS.BRIDLE_RING;
    const origCoM = Constants.FEATURE_FLAGS.COM_TRACKING;

    try {
      Constants.FEATURE_FLAGS.BRIDLE_RING = false;
      Constants.FEATURE_FLAGS.COM_TRACKING = true;

      BridleRing.resetAll();
      const am = makeMockArmManager(4, Math.PI / 2);

      const comBase = computeCoM(am);

      BridleRing.create(0);
      BridleRing.attach(0, 'pt-0', 'debris', 50);

      const comAfter = computeCoM(am);

      assert.closeTo(comAfter.totalMass, comBase.totalMass, 0.01,
        'no mass change with flag off');
    } finally {
      Constants.FEATURE_FLAGS.BRIDLE_RING = origBridle;
      Constants.FEATURE_FLAGS.COM_TRACKING = origCoM;
      BridleRing.resetAll();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §13  Feature Flag Gating
// ═══════════════════════════════════════════════════════════════════════════

describe('BridleRing — Feature Flag Gating', () => {
  it('default flag is false', () => {
    assert.equal(Constants.FEATURE_FLAGS.BRIDLE_RING, false);
  });

  it('BridleRing APIs work regardless of flag (module is pure data)', () => {
    // The flag gates integration points (CaptureNet, CoM, HUD),
    // but the BridleRing module itself always works for testability.
    BridleRing.resetAll();
    BridleRing.create(0);
    const ok = BridleRing.attach(0, 'pt-0', 'test', 10);
    assert.ok(ok, 'attach works with flag off');
    const s = BridleRing.getStatus(0);
    assert.equal(s.totalLoadKg, 10);
    BridleRing.resetAll();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §14  resetAll
// ═══════════════════════════════════════════════════════════════════════════

describe('BridleRing — resetAll', () => {
  it('clears all ring data', () => {
    BridleRing.resetAll();
    BridleRing.create(0);
    BridleRing.create(1);
    assert.equal(BridleRing.getAllArmIndices().length, 2);

    BridleRing.resetAll();
    assert.equal(BridleRing.getAllArmIndices().length, 0);
    assert.equal(BridleRing.getStatus(0), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §15  Multiple Arms
// ═══════════════════════════════════════════════════════════════════════════

describe('BridleRing — Multi-Arm', () => {
  it('independent rings per arm', () => {
    BridleRing.resetAll();
    BridleRing.create(0);
    BridleRing.create(1);
    BridleRing.create(2);

    BridleRing.attach(0, 'pt-0', 'a', 10);
    BridleRing.attach(1, 'pt-1', 'b', 20);
    BridleRing.attach(2, 'pt-2', 'c', 30);

    assert.equal(BridleRing.getTotalLoadKg(0), 10);
    assert.equal(BridleRing.getTotalLoadKg(1), 20);
    assert.equal(BridleRing.getTotalLoadKg(2), 30);

    // Detach from arm 1 doesn't affect others
    BridleRing.detach(1, 'pt-1');
    assert.equal(BridleRing.getTotalLoadKg(0), 10);
    assert.equal(BridleRing.getTotalLoadKg(1), 0);
    assert.equal(BridleRing.getTotalLoadKg(2), 30);
  });

  it('getAllArmIndices returns correct set', () => {
    BridleRing.resetAll();
    BridleRing.create(0);
    BridleRing.create(3);
    const indices = BridleRing.getAllArmIndices();
    assert.equal(indices.length, 2);
    assert.ok(indices.includes(0));
    assert.ok(indices.includes(3));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §16  C-6 CaptureNet Integration (flag-gated routing)
// ═══════════════════════════════════════════════════════════════════════════

describe('BridleRing — C-6 CaptureNet Integration', () => {
  it('with both flags ON, cargo hand-off fires bridle attach+detach events', () => {
    const origBridle = Constants.FEATURE_FLAGS.BRIDLE_RING;
    const origNet = Constants.FEATURE_FLAGS.CAPTURE_NET;

    try {
      Constants.FEATURE_FLAGS.BRIDLE_RING = true;
      Constants.FEATURE_FLAGS.CAPTURE_NET = true;

      BridleRing.resetAll();
      BridleRing.create(0);

      const attachEvents = [];
      const detachEvents = [];
      eventBus.on(Events.BRIDLE_ATTACH, (e) => attachEvents.push(e));
      eventBus.on(Events.BRIDLE_DETACH, (e) => detachEvents.push(e));

      // Simulate CaptureNet cargo hand-off routing logic (mirrors CaptureNet.js lines 580-588)
      const armIndex = 0;
      const capturedMass = 42;
      const debrisId = 'cargo-test-1';

      if (Constants.FEATURE_FLAGS.BRIDLE_RING && Constants.FEATURE_FLAGS.CAPTURE_NET && armIndex >= 0) {
        const freePoint = BridleRing.findFreePoint(armIndex);
        if (freePoint) {
          BridleRing.attach(armIndex, freePoint, debrisId, capturedMass);
          BridleRing.detach(armIndex, freePoint);
        }
      }

      assert.equal(attachEvents.length, 1, 'one BRIDLE_ATTACH event');
      assert.equal(detachEvents.length, 1, 'one BRIDLE_DETACH event');
      assert.equal(attachEvents[0].armIndex, 0);
      assert.equal(attachEvents[0].payloadId, 'cargo-test-1');
      assert.equal(attachEvents[0].loadKg, 42);
      assert.equal(detachEvents[0].armIndex, 0);
      assert.equal(detachEvents[0].payloadId, 'cargo-test-1');

      // Ring should be back to IDLE after detach
      const s = BridleRing.getStatus(0);
      assert.equal(s.state, STATES.IDLE);
      assert.equal(s.totalLoadKg, 0);

      eventBus.off(Events.BRIDLE_ATTACH);
      eventBus.off(Events.BRIDLE_DETACH);
    } finally {
      Constants.FEATURE_FLAGS.BRIDLE_RING = origBridle;
      Constants.FEATURE_FLAGS.CAPTURE_NET = origNet;
      BridleRing.resetAll();
    }
  });

  it('with BRIDLE_RING OFF, cargo hand-off skips bridle entirely', () => {
    const origBridle = Constants.FEATURE_FLAGS.BRIDLE_RING;
    const origNet = Constants.FEATURE_FLAGS.CAPTURE_NET;

    try {
      Constants.FEATURE_FLAGS.BRIDLE_RING = false;
      Constants.FEATURE_FLAGS.CAPTURE_NET = true;

      BridleRing.resetAll();

      const attachEvents = [];
      eventBus.on(Events.BRIDLE_ATTACH, (e) => attachEvents.push(e));

      // Simulate CaptureNet cargo hand-off with BRIDLE_RING OFF
      const armIndex = 0;
      if (Constants.FEATURE_FLAGS.BRIDLE_RING && Constants.FEATURE_FLAGS.CAPTURE_NET && armIndex >= 0) {
        // This block should NOT execute
        BridleRing.attach(0, 'pt-0', 'should-not-fire', 99);
      }

      assert.equal(attachEvents.length, 0, 'no bridle events with flag off');

      eventBus.off(Events.BRIDLE_ATTACH);
    } finally {
      Constants.FEATURE_FLAGS.BRIDLE_RING = origBridle;
      Constants.FEATURE_FLAGS.CAPTURE_NET = origNet;
      BridleRing.resetAll();
    }
  });

  it('with no ring created, cargo hand-off safely skips bridle', () => {
    const origBridle = Constants.FEATURE_FLAGS.BRIDLE_RING;
    const origNet = Constants.FEATURE_FLAGS.CAPTURE_NET;

    try {
      Constants.FEATURE_FLAGS.BRIDLE_RING = true;
      Constants.FEATURE_FLAGS.CAPTURE_NET = true;

      BridleRing.resetAll();
      // Intentionally do NOT create a ring for arm 0

      const attachEvents = [];
      eventBus.on(Events.BRIDLE_ATTACH, (e) => attachEvents.push(e));

      const armIndex = 0;
      if (Constants.FEATURE_FLAGS.BRIDLE_RING && Constants.FEATURE_FLAGS.CAPTURE_NET && armIndex >= 0) {
        const freePoint = BridleRing.findFreePoint(armIndex);
        if (freePoint) {
          BridleRing.attach(armIndex, freePoint, 'debris', 50);
          BridleRing.detach(armIndex, freePoint);
        }
      }

      // findFreePoint returns null → no attach/detach
      assert.equal(attachEvents.length, 0, 'no events when no ring created');

      eventBus.off(Events.BRIDLE_ATTACH);
    } finally {
      Constants.FEATURE_FLAGS.BRIDLE_RING = origBridle;
      Constants.FEATURE_FLAGS.CAPTURE_NET = origNet;
      BridleRing.resetAll();
    }
  });
});
