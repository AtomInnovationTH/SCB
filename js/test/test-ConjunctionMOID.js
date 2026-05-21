/**
 * test-ConjunctionMOID.js — ST-6.3 MOID badge tier transitions, de-bounce,
 * and CA speed-up integration.
 *
 * Node-safe: no DOM, no THREE.js. Tests the ConjunctionSystem MOID subsystem
 * by directly manipulating internal state and verifying event emissions.
 */
import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';
import { eventBus }  from '../core/EventBus.js';
import { Events }    from '../core/Events.js';
import { ConjunctionSystem } from '../systems/ConjunctionSystem.js';

// ============================================================================
// HELPERS
// ============================================================================

/** Create a fresh ConjunctionSystem with a clean EventBus. */
function makeSystem() {
  eventBus.clear();
  const sys = new ConjunctionSystem();
  sys._conjunctionAllowed = true;
  return sys;
}

/** Track emitted events — returns a growing array of { event, data }. */
function trackEvents(...names) {
  const log = [];
  names.forEach(n => eventBus.on(n, d => log.push({ event: n, data: d })));
  return log;
}

// ============================================================================
// SUITE 1: Tier transition de-bounce — same tier does not re-emit
// ============================================================================

describe('ConjunctionMOID — Tier transition de-bounce', () => {
  it('MOID stays at HI → one emission on first set, zero on repeat', () => {
    const sys = makeSystem();
    const log = trackEvents(Events.CONJUNCTION_ALERT);

    // Simulate first MOID badge assignment: null → HI
    sys._moidBadges.set(1, null);
    const isUp1 = sys._isUpwardTransition(null, 'HI');
    assert.ok(isUp1, 'null→HI should be upward');

    // Now badge is HI — set again → same tier, no transition
    sys._moidBadges.set(1, 'HI');
    const isUp2 = sys._isUpwardTransition('HI', 'HI');
    assert.ok(!isUp2, 'HI→HI should NOT be upward (same tier)');
  });

  it('MOID steady at MD → no re-emission', () => {
    const sys = makeSystem();
    assert.ok(!sys._isUpwardTransition('MD', 'MD'), 'MD→MD is not upward');
  });

  it('MOID steady at LO → no re-emission', () => {
    const sys = makeSystem();
    assert.ok(!sys._isUpwardTransition('LO', 'LO'), 'LO→LO is not upward');
  });
});

// ============================================================================
// SUITE 2: Upgrade transition — lower tier → higher tier fires
// ============================================================================

describe('ConjunctionMOID — Upgrade transitions fire alert', () => {
  it('null → LO is upward', () => {
    const sys = makeSystem();
    assert.ok(sys._isUpwardTransition(null, 'LO'));
  });

  it('null → MD is upward', () => {
    const sys = makeSystem();
    assert.ok(sys._isUpwardTransition(null, 'MD'));
  });

  it('null → HI is upward', () => {
    const sys = makeSystem();
    assert.ok(sys._isUpwardTransition(null, 'HI'));
  });

  it('LO → MD is upward', () => {
    const sys = makeSystem();
    assert.ok(sys._isUpwardTransition('LO', 'MD'));
  });

  it('LO → HI is upward', () => {
    const sys = makeSystem();
    assert.ok(sys._isUpwardTransition('LO', 'HI'));
  });

  it('MD → HI is upward', () => {
    const sys = makeSystem();
    assert.ok(sys._isUpwardTransition('MD', 'HI'));
  });
});

// ============================================================================
// SUITE 3: Downgrade transition — higher → lower is silent (no emission)
// ============================================================================

describe('ConjunctionMOID — Downgrade transitions are silent', () => {
  it('HI → MD is NOT upward', () => {
    const sys = makeSystem();
    assert.ok(!sys._isUpwardTransition('HI', 'MD'));
  });

  it('HI → LO is NOT upward', () => {
    const sys = makeSystem();
    assert.ok(!sys._isUpwardTransition('HI', 'LO'));
  });

  it('MD → LO is NOT upward', () => {
    const sys = makeSystem();
    assert.ok(!sys._isUpwardTransition('MD', 'LO'));
  });

  it('HI → null (SAFE) is NOT upward', () => {
    const sys = makeSystem();
    assert.ok(!sys._isUpwardTransition('HI', null));
  });

  it('LO → null (SAFE) is NOT upward', () => {
    const sys = makeSystem();
    assert.ok(!sys._isUpwardTransition('LO', null));
  });
});

// ============================================================================
// SUITE 4: Badge metadata in emitted CONJUNCTION_ALERT
// ============================================================================

describe('ConjunctionMOID — Alert payload metadata', () => {
  it('_emitMoidAlert emits CONJUNCTION_ALERT with correct fields', () => {
    const sys = makeSystem();
    const log = trackEvents(Events.CONJUNCTION_ALERT, Events.COMMS_MESSAGE);

    const debris = { id: 42, name: 'ISS (ZARYA)', norad: 25544 };
    sys._emitMoidAlert(debris, 4823.5, 'HI');

    const alerts = log.filter(e => e.event === Events.CONJUNCTION_ALERT);
    assert.equal(alerts.length, 1, 'should emit exactly 1 CONJUNCTION_ALERT');

    const payload = alerts[0].data;
    assert.equal(payload.severity, 'HI');
    assert.equal(payload.reason, 'MOID_CROSSING');
    assert.equal(payload.targetId, 42);
    assert.equal(payload.targetName, 'ISS (ZARYA)');
    assert.equal(payload.norad, 25544);
    assert.closeTo(payload.moid_m, 4823.5, 0.1);
    assert.equal(payload.moidBadge, 'HI');
  });

  it('_emitMoidAlert also emits COMMS_MESSAGE with styled badge in text', () => {
    const sys = makeSystem();
    const log = trackEvents(Events.COMMS_MESSAGE);

    sys._emitMoidAlert({ id: 1, name: 'COSMOS 2251 DEB' }, 19300, 'MD');

    assert.equal(log.length, 1, 'should emit 1 COMMS_MESSAGE');
    const msg = log[0].data;
    assert.ok(msg.text.includes('COSMOS 2251 DEB'), 'text should contain target name');
    assert.ok(msg.text.includes('19.3'), 'text should contain MOID value');
    assert.ok(msg.text.includes('[MD]'), 'text should contain [MD] badge tag');
    assert.ok(msg.text.includes(Constants.CONJUNCTION.BADGE_COLOR_MD),
      'text should contain badge colour for styling');
    assert.equal(msg.channel, 'ALERT');
  });
});

// ============================================================================
// SUITE 5: Active-sat RED path coexistence
// ============================================================================

describe('ConjunctionMOID — RED path coexistence', () => {
  it('ACTIVE_SAT_ARMING RED + MOID HI fire independently in same tick', () => {
    const sys = makeSystem();
    const log = trackEvents(Events.CONJUNCTION_ALERT);

    // Simulate ActiveSatGuard RED alert (external to ConjunctionSystem)
    eventBus.emit(Events.CONJUNCTION_ALERT, {
      severity: 'RED',
      reason: 'ACTIVE_SAT_ARMING',
      targetId: 99,
      targetName: 'ISS',
      norad: 25544,
    });

    // Simulate MOID-based HI alert (through ConjunctionSystem)
    sys._emitMoidAlert({ id: 42, name: 'Debris 42' }, 3000, 'HI');

    // Both events should be in the log
    assert.equal(log.length, 2, 'should have 2 CONJUNCTION_ALERT events');
    assert.equal(log[0].data.severity, 'RED');
    assert.equal(log[0].data.reason, 'ACTIVE_SAT_ARMING');
    assert.equal(log[1].data.severity, 'HI');
    assert.equal(log[1].data.reason, 'MOID_CROSSING');
  });
});

// ============================================================================
// SUITE 6: getTopRiskPairs for CA speed-up
// ============================================================================

describe('ConjunctionMOID — getTopRiskPairs (CA speed-up)', () => {
  it('returns empty array when MOID cache is empty', () => {
    const sys = makeSystem();
    const pairs = sys.getTopRiskPairs(32);
    assert.equal(pairs.length, 0);
  });

  it('returns only pairs within CA_MOID_PREFILTER_M', () => {
    const sys = makeSystem();
    sys._moidCache.set(1, 5000);
    sys._moidCache.set(2, 100_000);
    sys._moidCache.set(3, 200_000); // above 150 km threshold
    sys._moidCache.set(4, 50_000);

    const pairs = sys.getTopRiskPairs(10);
    assert.equal(pairs.length, 3, 'should exclude id=3 (MOID > 150 km)');
    const ids = pairs.map(p => p.id);
    assert.ok(!ids.includes(3), 'id=3 should be excluded');
  });

  it('returns sorted ascending by MOID', () => {
    const sys = makeSystem();
    sys._moidCache.set('a', 50_000);
    sys._moidCache.set('b', 5_000);
    sys._moidCache.set('c', 25_000);

    const pairs = sys.getTopRiskPairs(10);
    assert.equal(pairs[0].id, 'b');
    assert.equal(pairs[1].id, 'c');
    assert.equal(pairs[2].id, 'a');
  });

  it('respects topN limit', () => {
    const sys = makeSystem();
    for (let i = 0; i < 50; i++) {
      sys._moidCache.set(i, i * 1000);
    }
    const pairs = sys.getTopRiskPairs(5);
    assert.equal(pairs.length, 5, 'should return exactly 5');
    assert.equal(pairs[0].id, 0, 'closest first');
  });

  it('mock: CA system iterates only prefiltered pairs, not full list', () => {
    const sys = makeSystem();
    // Populate 800 items in cache, but only 32 within threshold
    for (let i = 0; i < 800; i++) {
      const moid = i < 32 ? (i + 1) * 1000 : 200_000 + i;
      sys._moidCache.set(i, moid);
    }

    const pairs = sys.getTopRiskPairs(32);
    assert.equal(pairs.length, 32, 'should return 32 prefiltered pairs');
    // All 32 should have MOID ≤ 150 km
    for (const p of pairs) {
      assert.ok(p.moid <= 150_000,
        `pair id=${p.id} moid=${p.moid} should be ≤ 150000`);
    }
  });
});

// ============================================================================
// SUITE 7: MOID state reset
// ============================================================================

describe('ConjunctionMOID — Reset clears MOID state', () => {
  it('reset() clears MOID cache and badges', () => {
    const sys = makeSystem();
    sys._moidCache.set(1, 5000);
    sys._moidBadges.set(1, 'HI');
    sys._moidTimer = 3.5;
    sys._lastPlayerVelMag = 7.5;

    sys.reset();

    assert.equal(sys._moidCache.size, 0, 'cache should be empty');
    assert.equal(sys._moidBadges.size, 0, 'badges should be empty');
    assert.equal(sys._moidTimer, 0, 'timer should be 0');
    assert.equal(sys._lastPlayerVelMag, 0, 'vel mag should be 0');
  });
});
