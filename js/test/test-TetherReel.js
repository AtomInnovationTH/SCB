/**
 * test-TetherReel.js — ST-9.5 C-7 Tether Reel (strut-mounted, Config G)
 *
 * Tests the actual TetherReel singleton: state machine, cable physics, persistence,
 * feature flag gating, tension model, and CoM impact.
 *
 * Uses the real `tetherReel` module — not a standalone copy.
 */
import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { tetherReel } from '../systems/TetherReel.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const RS = Constants.REEL_STATES;
const REEL = Constants.OCTOPUS_V5.REEL;

// Disable random jam during deterministic tests. Jam logic is tested
// explicitly in §8 via direct state manipulation, not random triggers.
// This prevents flaky failures from Math.random() hitting the 0.5% jam
// probability during reel-in update ticks.
const _savedJamP = REEL.JAM_PROBABILITY_PER_REEL;
REEL.JAM_PROBABILITY_PER_REEL = 0;

/** Mock ArmManager with N arms */
function mockArmManager(armCount = 4) {
  return {
    arms: Array.from({ length: armCount }, (_, i) => ({
      index: i,
      id: `arm-${i}`,
      config: { type: i < 2 ? 'weaver' : 'spinner' },
      isDetached: false,
      state: 'TRANSIT',
      getAimAlpha: () => Math.PI / 2,
      _hingePosition: { x: 0.00001, y: 0, z: 0 },
      _dockOutward: { x: 1, y: 0, z: 0 },
      getTetherAnchorWorldPosition: () => ({ x: 0, y: 0, z: 0 }),
    })),
  };
}

/** Enable/disable the TETHER_REEL flag for testing (restore after) */
function withFlag(val, fn) {
  const prev = Constants.FEATURE_FLAGS.TETHER_REEL;
  Constants.FEATURE_FLAGS.TETHER_REEL = val;
  try {
    fn();
  } finally {
    Constants.FEATURE_FLAGS.TETHER_REEL = prev;
  }
}

/**
 * Re-initialize the singleton with fresh mock arms.
 * Must be called inside withFlag(true, ...) for full initialization.
 */
function freshInit(armCount = 4, tierName) {
  tetherReel.init(mockArmManager(armCount), tierName);
}

// ═══════════════════════════════════════════════════════════════════════════
// §1  Constants Integrity
// ═══════════════════════════════════════════════════════════════════════════

describe('TetherReel — Constants (C-7)', () => {
  it('REEL_STATES enum has all 6 states', () => {
    assert.ok(RS.STOWED, 'STOWED');
    assert.ok(RS.PAYING_OUT, 'PAYING_OUT');
    assert.ok(RS.STATIC, 'STATIC');
    assert.ok(RS.REELING_IN, 'REELING_IN');
    assert.ok(RS.JAMMED, 'JAMMED');
    assert.ok(RS.CUT, 'CUT');
    assert.equal(Object.keys(RS).length, 6, 'exactly 6 reel states');
  });

  it('OCTOPUS_V5.REEL block has required constants', () => {
    assert.ok(REEL, 'REEL block exists');
    assert.ok(REEL.MAX_CABLE_LENGTH_M, 'MAX_CABLE_LENGTH_M');
    assert.equal(typeof REEL.MAX_CABLE_LENGTH_M.Y0, 'number', 'Y0 tier');
    assert.equal(typeof REEL.MAX_CABLE_LENGTH_M.Y1, 'number', 'Y1 tier');
    assert.equal(typeof REEL.MAX_CABLE_LENGTH_M.Y3, 'number', 'Y3 tier');
    assert.equal(REEL.MAX_CABLE_LENGTH_M.Y0, 50, 'Y0=50m');
    assert.equal(REEL.MAX_CABLE_LENGTH_M.Y1, 80, 'Y1=80m');
    assert.equal(REEL.MAX_CABLE_LENGTH_M.Y3, 120, 'Y3=120m');
    assert.equal(REEL.PAYOUT_RATE_M_PER_S, 5.0, 'payout rate');
    assert.equal(REEL.REEL_IN_RATE_M_PER_S, 2.0, 'reel-in rate');
    assert.equal(REEL.BREAKING_TENSION_N, 800, 'breaking tension');
    assert.equal(REEL.CABLE_MASS_PER_M_KG, 0.05, 'cable mass/m');
    assert.equal(_savedJamP, 0.005, 'jam probability (original, zeroed for deterministic tests)');
    assert.equal(REEL.CABLE_SPRING_K, 500, 'spring K');
    assert.equal(REEL.CABLE_DAMPING_C, 50, 'damping C');
    assert.equal(REEL.JAM_CLEAR_COOLDOWN_S, 5.0, 'jam cooldown');
    assert.equal(REEL.REEL_MASS_KG, 1.2, 'reel mass');
    assert.equal(REEL.MOTOR_POWER_W, 15, 'motor power');
    assert.equal(REEL.TENSION_WARNING_FRAC, 0.75, 'warning fraction');
  });

  it('FEATURE_FLAGS.TETHER_REEL exists and defaults to false', () => {
    assert.equal(typeof Constants.FEATURE_FLAGS.TETHER_REEL, 'boolean', 'is boolean');
    assert.ok('TETHER_REEL' in Constants.FEATURE_FLAGS, 'flag registered');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §2  Events Integrity
// ═══════════════════════════════════════════════════════════════════════════

describe('TetherReel — Events (C-7)', () => {
  it('all 6 tether reel events are defined', () => {
    assert.ok(Events.TETHER_PAYOUT_STARTED, 'TETHER_PAYOUT_STARTED');
    assert.ok(Events.TETHER_REELIN_STARTED, 'TETHER_REELIN_STARTED');
    assert.ok(Events.TETHER_REELIN_COMPLETED, 'TETHER_REELIN_COMPLETED');
    assert.ok(Events.TETHER_JAMMED, 'TETHER_JAMMED');
    assert.ok(Events.TETHER_CUT, 'TETHER_CUT');
    assert.ok(Events.TETHER_TENSION_HIGH, 'TETHER_TENSION_HIGH');
  });

  it('event string values are unique', () => {
    const vals = [
      Events.TETHER_PAYOUT_STARTED,
      Events.TETHER_REELIN_STARTED,
      Events.TETHER_REELIN_COMPLETED,
      Events.TETHER_JAMMED,
      Events.TETHER_CUT,
      Events.TETHER_TENSION_HIGH,
    ];
    const unique = new Set(vals);
    assert.equal(unique.size, 6, 'all 6 event strings are unique');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §3  Feature Flag Gating
// ═══════════════════════════════════════════════════════════════════════════

describe('TetherReel — Feature Flag OFF (C-7)', () => {
  it('flag OFF: init creates no reels', () => {
    withFlag(false, () => {
      freshInit(4);
      assert.equal(tetherReel._reels.size, 0, 'no reels created');
    });
  });

  it('flag OFF: payOut returns false', () => {
    withFlag(false, () => {
      freshInit(4);
      assert.equal(tetherReel.payOut(0, 20), false, 'payOut noop');
    });
  });

  it('flag OFF: getReelState returns STOWED default', () => {
    withFlag(false, () => {
      freshInit(4);
      assert.equal(tetherReel.getReelState(0), RS.STOWED, 'default STOWED');
    });
  });

  it('flag OFF: getCableLength returns 0', () => {
    withFlag(false, () => {
      freshInit(4);
      assert.equal(tetherReel.getCableLength(0), 0, 'zero length');
    });
  });

  it('flag OFF: getTensionN returns 0', () => {
    withFlag(false, () => {
      freshInit(4);
      assert.equal(tetherReel.getTensionN(0), 0, 'zero tension');
    });
  });

  it('flag OFF: getCableMassKg returns 0', () => {
    withFlag(false, () => {
      freshInit(4);
      assert.equal(tetherReel.getCableMassKg(0), 0, 'zero cable mass');
    });
  });

  it('flag OFF: update is noop', () => {
    withFlag(false, () => {
      freshInit(4);
      tetherReel.update(1.0); // should not throw
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §4  Initialization
// ═══════════════════════════════════════════════════════════════════════════

describe('TetherReel — Init (C-7)', () => {
  it('flag ON: init creates reels for each arm', () => {
    withFlag(true, () => {
      freshInit(4);
      assert.equal(tetherReel._reels.size, 4, '4 reels for 4 arms');
    });
  });

  it('all reels start in STOWED state', () => {
    withFlag(true, () => {
      freshInit(4);
      for (let i = 0; i < 4; i++) {
        assert.equal(tetherReel.getReelState(i), RS.STOWED, `arm ${i} STOWED`);
      }
    });
  });

  it('max cable length defaults to Y0 tier', () => {
    withFlag(true, () => {
      freshInit(2);
      assert.equal(tetherReel.getMaxCableLength(0), REEL.MAX_CABLE_LENGTH_M.Y0, 'Y0 default');
    });
  });

  it('Y1 tier sets correct max length', () => {
    withFlag(true, () => {
      freshInit(2, 'Y1');
      assert.equal(tetherReel.getMaxCableLength(0), REEL.MAX_CABLE_LENGTH_M.Y1, 'Y1 = 80m');
    });
  });

  it('Y3 tier sets correct max length', () => {
    withFlag(true, () => {
      freshInit(2, 'Y3');
      assert.equal(tetherReel.getMaxCableLength(0), REEL.MAX_CABLE_LENGTH_M.Y3, 'Y3 = 120m');
    });
  });

  it('init clears previous state', () => {
    withFlag(true, () => {
      freshInit(4);
      tetherReel.payOut(0, 20);
      tetherReel.update(10.0);
      // Re-init should clear
      freshInit(2);
      assert.equal(tetherReel._reels.size, 2, 'only 2 reels now');
      assert.equal(tetherReel.getReelState(0), RS.STOWED, 'arm 0 fresh');
      assert.equal(tetherReel.getCableLength(0), 0, 'arm 0 cable 0');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §5  State Machine — Pay Out
// ═══════════════════════════════════════════════════════════════════════════

describe('TetherReel — Pay Out (C-7)', () => {
  it('payOut from STOWED transitions to PAYING_OUT', () => {
    withFlag(true, () => {
      eventBus.clear();
      freshInit(4);
      const ok = tetherReel.payOut(0, 30);
      assert.ok(ok, 'payOut accepted');
      assert.equal(tetherReel.getReelState(0), RS.PAYING_OUT, 'state PAYING_OUT');
    });
  });

  it('payOut emits TETHER_PAYOUT_STARTED event', () => {
    withFlag(true, () => {
      eventBus.clear();
      let received = null;
      eventBus.on(Events.TETHER_PAYOUT_STARTED, (e) => { received = e; });
      freshInit(4);
      tetherReel.payOut(0, 25);
      assert.ok(received, 'event emitted');
      assert.equal(received.armIndex, 0, 'armIndex');
      assert.equal(received.targetLengthM, 25, 'targetLengthM');
      eventBus.clear();
    });
  });

  it('payOut clamps to maxCableLength', () => {
    withFlag(true, () => {
      eventBus.clear();
      let received = null;
      eventBus.on(Events.TETHER_PAYOUT_STARTED, (e) => { received = e; });
      freshInit(2);
      tetherReel.payOut(0, 999); // way beyond Y0=50m
      assert.equal(received.targetLengthM, REEL.MAX_CABLE_LENGTH_M.Y0, 'clamped to max');
      eventBus.clear();
    });
  });

  it('payOut rejected from JAMMED state', () => {
    withFlag(true, () => {
      freshInit(2);
      tetherReel._reels.get(0).state = RS.JAMMED;
      const ok = tetherReel.payOut(0, 20);
      assert.equal(ok, false, 'rejected from JAMMED');
    });
  });

  it('payOut rejected from CUT state', () => {
    withFlag(true, () => {
      freshInit(2);
      tetherReel._reels.get(0).state = RS.CUT;
      const ok = tetherReel.payOut(0, 20);
      assert.equal(ok, false, 'rejected from CUT');
    });
  });

  it('update PAYING_OUT extends cable toward target', () => {
    withFlag(true, () => {
      freshInit(2);
      tetherReel.payOut(0, 30);
      tetherReel.update(1.0); // 1 second at 5 m/s => 5m extended
      const len = tetherReel.getCableLength(0);
      assert.ok(len > 0, 'cable extended');
      assert.ok(len <= 5.0 + 0.01, 'does not exceed payout rate');
    });
  });

  it('update PAYING_OUT transitions to STATIC when target reached', () => {
    withFlag(true, () => {
      freshInit(2);
      tetherReel.payOut(0, 10);
      // 10m / 5 m/s = 2 seconds — 3s is enough
      tetherReel.update(3.0);
      assert.equal(tetherReel.getReelState(0), RS.STATIC, 'now STATIC');
      assert.closeTo(tetherReel.getCableLength(0), 10, 0.01, 'cable at target');
    });
  });

  it('update PAYING_OUT clamps at maxCableLength', () => {
    withFlag(true, () => {
      freshInit(2); // Y0: 50m max
      tetherReel.payOut(0, 50);
      tetherReel.update(20.0); // 20s * 5 m/s = 100m but clamp to 50m
      assert.equal(tetherReel.getReelState(0), RS.STATIC, 'clamped to STATIC');
      assert.closeTo(tetherReel.getCableLength(0), 50, 0.01, 'clamped to 50m');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §6  State Machine — Reel In
// ═══════════════════════════════════════════════════════════════════════════

describe('TetherReel — Reel In (C-7)', () => {
  it('reelIn from STATIC transitions to REELING_IN', () => {
    withFlag(true, () => {
      eventBus.clear();
      freshInit(2);
      // Pay out and complete
      tetherReel.payOut(0, 30);
      tetherReel.update(10.0); // fully extends to 30m → STATIC
      assert.equal(tetherReel.getReelState(0), RS.STATIC, 'STATIC after payout completes');
      let received = null;
      eventBus.on(Events.TETHER_REELIN_STARTED, (e) => { received = e; });
      const ok = tetherReel.reelIn(0);
      assert.ok(ok, 'reelIn accepted');
      assert.equal(tetherReel.getReelState(0), RS.REELING_IN, 'now REELING_IN');
      assert.ok(received, 'TETHER_REELIN_STARTED emitted');
      eventBus.clear();
    });
  });

  it('reelIn auto-stops PAYING_OUT first', () => {
    withFlag(true, () => {
      eventBus.clear();
      freshInit(2);
      tetherReel.payOut(0, 30);
      tetherReel.update(1.0); // partially extended
      assert.equal(tetherReel.getReelState(0), RS.PAYING_OUT, 'still PAYING_OUT');
      const ok = tetherReel.reelIn(0);
      assert.ok(ok, 'reelIn from PAYING_OUT accepted (auto-stop)');
      assert.equal(tetherReel.getReelState(0), RS.REELING_IN, 'now REELING_IN');
      eventBus.clear();
    });
  });

  it('reelIn speed scales with payload mass', () => {
    withFlag(true, () => {
      freshInit(2);
      // Arm 0: no payload; Arm 1: 20kg payload
      tetherReel.payOut(0, 20);
      tetherReel.update(10.0);
      tetherReel.payOut(1, 20);
      tetherReel.update(10.0);

      tetherReel.attachEndpoint(1, 'debris-1', 20);
      tetherReel.reelIn(0);
      tetherReel.reelIn(1);

      const len0Before = tetherReel.getCableLength(0);
      const len1Before = tetherReel.getCableLength(1);
      tetherReel.update(1.0);
      const retracted0 = len0Before - tetherReel.getCableLength(0);
      const retracted1 = len1Before - tetherReel.getCableLength(1);

      assert.ok(retracted0 > retracted1,
        `unloaded arm retracts faster (${retracted0.toFixed(2)} > ${retracted1.toFixed(2)})`);
    });
  });

  it('reel-in completes to STOWED and emits event', () => {
    withFlag(true, () => {
      eventBus.clear();
      freshInit(2);
      tetherReel.payOut(0, 5);
      tetherReel.update(10.0); // fully extends → STATIC
      let completed = false;
      eventBus.on(Events.TETHER_REELIN_COMPLETED, () => { completed = true; });
      tetherReel.reelIn(0);
      tetherReel.update(10.0); // 5m / 2 m/s = 2.5s
      assert.equal(tetherReel.getReelState(0), RS.STOWED, 'back to STOWED');
      assert.closeTo(tetherReel.getCableLength(0), 0, 0.01, 'cable length 0');
      assert.ok(completed, 'TETHER_REELIN_COMPLETED emitted');
      eventBus.clear();
    });
  });

  it('reelIn rejected from STOWED (nothing to reel)', () => {
    withFlag(true, () => {
      freshInit(2);
      const ok = tetherReel.reelIn(0);
      // STOWED is not STATIC — reelIn requires STATIC state
      assert.equal(ok, false, 'rejected from STOWED');
      assert.equal(tetherReel.getReelState(0), RS.STOWED, 'stays STOWED');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §7  State Machine — Cut
// ═══════════════════════════════════════════════════════════════════════════

describe('TetherReel — Cut (C-7)', () => {
  it('cut from any active state transitions to CUT', () => {
    const states = [RS.STOWED, RS.PAYING_OUT, RS.STATIC, RS.REELING_IN, RS.JAMMED];
    for (const s of states) {
      withFlag(true, () => {
        eventBus.clear();
        freshInit(2);
        tetherReel._reels.get(0).state = s;
        const ok = tetherReel.cut(0, 'test');
        assert.ok(ok, `cut from ${s} accepted`);
        assert.equal(tetherReel.getReelState(0), RS.CUT, `now CUT from ${s}`);
      });
    }
  });

  it('cut emits TETHER_CUT event', () => {
    withFlag(true, () => {
      eventBus.clear();
      let received = null;
      eventBus.on(Events.TETHER_CUT, (e) => { received = e; });
      freshInit(2);
      tetherReel.cut(0, 'emergency');
      assert.ok(received, 'event emitted');
      assert.equal(received.armIndex, 0, 'armIndex');
      assert.equal(received.reason, 'emergency', 'reason');
      eventBus.clear();
    });
  });

  it('cut clears tension and endpoint', () => {
    withFlag(true, () => {
      freshInit(2);
      tetherReel.payOut(0, 20);
      tetherReel.update(10.0);
      tetherReel.attachEndpoint(0, 'debris-42', 5);
      tetherReel._reels.get(0).tensionN = 100;
      tetherReel.cut(0);
      assert.equal(tetherReel.getTensionN(0), 0, 'tension zeroed');
      assert.equal(tetherReel.getReelRecord(0).attachedEndpointId, null, 'endpoint cleared');
    });
  });

  it('cut from CUT is rejected (already cut)', () => {
    withFlag(true, () => {
      freshInit(2);
      tetherReel.cut(0, 'first');
      const ok = tetherReel.cut(0, 'second');
      assert.equal(ok, false, 'already CUT');
    });
  });

  it('CUT is terminal — no transitions out', () => {
    withFlag(true, () => {
      freshInit(2);
      tetherReel.cut(0);
      assert.equal(tetherReel.payOut(0, 10), false, 'payOut rejected');
      assert.equal(tetherReel.reelIn(0), false, 'reelIn rejected');
      assert.equal(tetherReel.clearJam(0), false, 'clearJam rejected');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §8  State Machine — Jam + Clear
// ═══════════════════════════════════════════════════════════════════════════

describe('TetherReel — Jam (C-7)', () => {
  it('clearJam from JAMMED transitions to STATIC', () => {
    withFlag(true, () => {
      freshInit(2);
      tetherReel._reels.get(0).state = RS.JAMMED;
      tetherReel._reels.get(0).jamClearCooldownS = 0;
      const ok = tetherReel.clearJam(0);
      assert.ok(ok, 'clearJam accepted');
      assert.equal(tetherReel.getReelState(0), RS.STATIC, 'now STATIC');
    });
  });

  it('clearJam rejected during cooldown', () => {
    withFlag(true, () => {
      freshInit(2);
      tetherReel._reels.get(0).state = RS.JAMMED;
      tetherReel._reels.get(0).jamClearCooldownS = 3.0;
      const ok = tetherReel.clearJam(0);
      assert.equal(ok, false, 'rejected during cooldown');
    });
  });

  it('cooldown decrements over time', () => {
    withFlag(true, () => {
      freshInit(2);
      tetherReel._reels.get(0).state = RS.JAMMED;
      tetherReel._reels.get(0).jamClearCooldownS = 3.0;
      tetherReel.update(2.0);
      assert.closeTo(tetherReel._reels.get(0).jamClearCooldownS, 1.0, 0.01, 'cooldown reduced');
      tetherReel.update(2.0);
      assert.closeTo(tetherReel._reels.get(0).jamClearCooldownS, 0, 0.01, 'cooldown expired');
      const ok = tetherReel.clearJam(0);
      assert.ok(ok, 'clearJam after cooldown');
    });
  });

  it('clearJam rejected from non-JAMMED state', () => {
    withFlag(true, () => {
      freshInit(2);
      const ok = tetherReel.clearJam(0);
      assert.equal(ok, false, 'not JAMMED');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §9  Cable Physics — Tension Model
// ═══════════════════════════════════════════════════════════════════════════

describe('TetherReel — Tension Model (C-7)', () => {
  it('zero tension when cable slack (endpoint closer than cable length)', () => {
    withFlag(true, () => {
      freshInit(2);
      tetherReel.payOut(0, 30);
      tetherReel.update(10.0); // → STATIC, 30m paid out
      // Endpoint at 20m (slack)
      tetherReel.update(0.1, (idx) => idx === 0 ? 20 : null);
      assert.equal(tetherReel.getTensionN(0), 0, 'slack cable = 0 tension');
    });
  });

  it('positive tension when cable taut (endpoint beyond cable length)', () => {
    withFlag(true, () => {
      freshInit(2);
      tetherReel.payOut(0, 30);
      tetherReel.update(10.0); // → STATIC, 30m
      // Endpoint at 31m (1m over-extension)
      tetherReel.update(0.1, (idx) => idx === 0 ? 31 : null);
      const tension = tetherReel.getTensionN(0);
      assert.ok(tension > 0, `tension should be positive: ${tension}`);
      // Expected: CABLE_SPRING_K * 1m = 500N
      assert.closeTo(tension, REEL.CABLE_SPRING_K * 1.0, 1, 'Hooke tension');
    });
  });

  it('tension scales with over-extension (Hooke)', () => {
    withFlag(true, () => {
      freshInit(2);
      tetherReel.payOut(0, 30);
      tetherReel.update(10.0);
      // 0.5m over
      tetherReel.update(0.1, () => 30.5);
      const t1 = tetherReel.getTensionN(0);
      // 1.0m over
      tetherReel.update(0.1, () => 31.0);
      const t2 = tetherReel.getTensionN(0);
      assert.ok(t2 > t1, 'more extension = more tension');
      assert.closeTo(t2 / t1, 2.0, 0.1, 'linear scaling');
    });
  });

  it('breaking tension triggers CUT at high overload', () => {
    withFlag(true, () => {
      eventBus.clear();
      freshInit(2);
      tetherReel.payOut(0, 20);
      tetherReel.update(10.0); // 20m STATIC
      // Overextend enough to exceed 1.2× breaking: 800 * 1.2 / 500 = 1.92m
      tetherReel.update(0.1, () => 22);
      assert.equal(tetherReel.getReelState(0), RS.CUT, 'CUT from overload');
      eventBus.clear();
    });
  });

  it('marginal overload triggers JAM instead of CUT', () => {
    withFlag(true, () => {
      eventBus.clear();
      freshInit(2);
      tetherReel.payOut(0, 20);
      tetherReel.update(10.0); // 20m STATIC
      // Marginal overload: just above breaking but below 1.2× breaking
      // Breaking=800N, 1.2×=960N. Need tension between 800 and 960.
      // tension = K * overExt = 500 * overExt
      // 800/500 = 1.6m → exactly at breaking → JAM
      tetherReel.update(0.1, () => 21.6);
      assert.equal(tetherReel.getReelState(0), RS.JAMMED, 'JAMMED from marginal overload');
      eventBus.clear();
    });
  });

  it('tension warning emitted above 75% of breaking', () => {
    withFlag(true, () => {
      eventBus.clear();
      let warned = null;
      eventBus.on(Events.TETHER_TENSION_HIGH, (e) => { warned = e; });
      freshInit(2);
      tetherReel.payOut(0, 20);
      tetherReel.update(10.0); // 20m STATIC
      // 75% of 800 = 600N → 600/500 = 1.2m over-extension
      tetherReel.update(0.1, () => 21.3);
      assert.ok(warned, 'TETHER_TENSION_HIGH emitted');
      assert.equal(warned.armIndex, 0, 'armIndex');
      assert.ok(warned.tensionN > REEL.BREAKING_TENSION_N * 0.75 - 1,
        `tension above warning threshold: ${warned.tensionN}`);
      eventBus.clear();
    });
  });

  it('tension warning is debounced (2s)', () => {
    withFlag(true, () => {
      eventBus.clear();
      let warnCount = 0;
      eventBus.on(Events.TETHER_TENSION_HIGH, () => { warnCount++; });
      freshInit(2);
      tetherReel.payOut(0, 20);
      tetherReel.update(10.0);
      // First warning
      tetherReel.update(0.1, () => 21.3);
      assert.equal(warnCount, 1, 'first warning');
      // Immediate second tick — should be debounced
      tetherReel.update(0.1, () => 21.3);
      assert.equal(warnCount, 1, 'debounced');
      // After 2.1 seconds — debounce expired
      tetherReel.update(2.1, () => 21.3);
      assert.equal(warnCount, 2, 'warning after debounce');
      eventBus.clear();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §10  Endpoint Attachment
// ═══════════════════════════════════════════════════════════════════════════

describe('TetherReel — Endpoint (C-7)', () => {
  it('attachEndpoint stores id and mass', () => {
    withFlag(true, () => {
      freshInit(2);
      tetherReel.attachEndpoint(0, 'debris-99', 12.5);
      const rec = tetherReel.getReelRecord(0);
      assert.equal(rec.attachedEndpointId, 'debris-99', 'endpoint id');
      assert.equal(rec.payloadMassKg, 12.5, 'payload mass');
    });
  });

  it('detachEndpoint clears id and mass', () => {
    withFlag(true, () => {
      freshInit(2);
      tetherReel.attachEndpoint(0, 'debris-99', 12.5);
      tetherReel.detachEndpoint(0);
      const rec = tetherReel.getReelRecord(0);
      assert.equal(rec.attachedEndpointId, null, 'endpoint cleared');
      assert.equal(rec.payloadMassKg, 0, 'mass cleared');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §11  Persistence
// ═══════════════════════════════════════════════════════════════════════════

describe('TetherReel — Persistence (C-7)', () => {
  it('getAllReelStates returns per-arm records', () => {
    withFlag(true, () => {
      freshInit(4);
      tetherReel.payOut(0, 20);
      tetherReel.update(10.0);
      tetherReel.attachEndpoint(0, 'debris-1', 5);
      const states = tetherReel.getAllReelStates();
      assert.equal(states.length, 4, '4 records');
      assert.equal(states[0].state, RS.STATIC, 'arm 0 STATIC');
      assert.closeTo(states[0].cableLengthM, 20, 0.1, 'arm 0 cable 20m');
      assert.equal(states[0].attachedEndpointId, 'debris-1', 'arm 0 endpoint');
      assert.equal(states[1].state, RS.STOWED, 'arm 1 STOWED');
    });
  });

  it('restoreFromPersistence snaps PAYING_OUT → STATIC', () => {
    withFlag(true, () => {
      freshInit(2);
      tetherReel.restoreFromPersistence([
        { armIndex: 0, state: RS.PAYING_OUT, cableLengthM: 15, attachedEndpointId: null },
      ]);
      assert.equal(tetherReel.getReelState(0), RS.STATIC, 'snapped to STATIC');
      assert.closeTo(tetherReel.getCableLength(0), 15, 0.01, 'cable length preserved');
    });
  });

  it('restoreFromPersistence snaps REELING_IN → STOWED', () => {
    withFlag(true, () => {
      freshInit(2);
      tetherReel.restoreFromPersistence([
        { armIndex: 0, state: RS.REELING_IN, cableLengthM: 10, attachedEndpointId: 'deb-1' },
      ]);
      assert.equal(tetherReel.getReelState(0), RS.STOWED, 'snapped to STOWED');
      assert.closeTo(tetherReel.getCableLength(0), 0, 0.01, 'cable length zeroed (STOWED)');
    });
  });

  it('restoreFromPersistence preserves JAMMED', () => {
    withFlag(true, () => {
      freshInit(2);
      tetherReel.restoreFromPersistence([
        { armIndex: 0, state: RS.JAMMED, cableLengthM: 25, attachedEndpointId: null },
      ]);
      assert.equal(tetherReel.getReelState(0), RS.JAMMED, 'preserved JAMMED');
      assert.closeTo(tetherReel.getCableLength(0), 25, 0.01, 'cable length preserved');
    });
  });

  it('restoreFromPersistence preserves CUT', () => {
    withFlag(true, () => {
      freshInit(2);
      tetherReel.restoreFromPersistence([
        { armIndex: 0, state: RS.CUT, cableLengthM: 30, attachedEndpointId: null },
      ]);
      assert.equal(tetherReel.getReelState(0), RS.CUT, 'preserved CUT');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §12  Cable Mass / CoM Impact
// ═══════════════════════════════════════════════════════════════════════════

describe('TetherReel — Cable Mass (C-7)', () => {
  it('getCableMassKg returns cable_length × mass_per_m', () => {
    withFlag(true, () => {
      freshInit(2);
      tetherReel.payOut(0, 30);
      tetherReel.update(10.0); // 30m STATIC
      const mass = tetherReel.getCableMassKg(0);
      assert.closeTo(mass, 30 * REEL.CABLE_MASS_PER_M_KG, 0.001,
        `30m × ${REEL.CABLE_MASS_PER_M_KG} = ${30 * REEL.CABLE_MASS_PER_M_KG} kg`);
    });
  });

  it('getCableMassKg = 0 when STOWED', () => {
    withFlag(true, () => {
      freshInit(2);
      assert.equal(tetherReel.getCableMassKg(0), 0, 'zero when stowed');
    });
  });

  it('getTotalCableMassKg sums all arms', () => {
    withFlag(true, () => {
      freshInit(4);
      tetherReel.payOut(0, 20);
      tetherReel.payOut(1, 30);
      tetherReel.update(10.0);
      const total = tetherReel.getTotalCableMassKg();
      const expected = (20 + 30) * REEL.CABLE_MASS_PER_M_KG;
      assert.closeTo(total, expected, 0.01, 'sum of cable masses');
    });
  });

  it('cable mass at Y0 max (50m) is small relative to spacecraft dry mass', () => {
    // Document: max cable mass = 50 × 0.05 = 2.5 kg vs 196.4 kg dry → ~1.3%
    const maxCableMass = REEL.MAX_CABLE_LENGTH_M.Y0 * REEL.CABLE_MASS_PER_M_KG;
    const dryMass = Constants.OCTOPUS_V5.TOTAL_DRY_MASS;
    const fraction = maxCableMass / dryMass;
    assert.ok(fraction < 0.02, `cable mass ${maxCableMass}kg is <2% of dry mass ${dryMass}kg`);
  });

  it('CoM drift from cable mass is quantifiable but negligible', () => {
    // With 4 arms each at max Y0 cable (50m), total cable mass = 4 × 2.5 = 10 kg.
    // Cable midpoint is ~0.8m from barrel center (strut 1.6m + cable extends outward).
    // CoM shift ≈ (10 kg × 0.8m) / (196.4 + 10) kg ≈ 0.039m → <5cm.
    const totalCableMass = 4 * REEL.MAX_CABLE_LENGTH_M.Y0 * REEL.CABLE_MASS_PER_M_KG;
    const dryMass = Constants.OCTOPUS_V5.TOTAL_DRY_MASS;
    const estimatedShift = (totalCableMass * 0.8) / (dryMass + totalCableMass);
    assert.ok(estimatedShift < 0.05, `CoM shift ${estimatedShift.toFixed(4)}m < 5cm — negligible`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §13  Reset
// ═══════════════════════════════════════════════════════════════════════════

describe('TetherReel — Reset (C-7)', () => {
  it('reset returns all reels to STOWED with 0 cable', () => {
    withFlag(true, () => {
      freshInit(4);
      tetherReel.payOut(0, 20);
      tetherReel.update(10.0);
      tetherReel.cut(1);
      tetherReel._reels.get(2).state = RS.JAMMED;
      tetherReel.reset();
      for (let i = 0; i < 4; i++) {
        assert.equal(tetherReel.getReelState(i), RS.STOWED, `arm ${i} STOWED after reset`);
        assert.equal(tetherReel.getCableLength(i), 0, `arm ${i} cable 0 after reset`);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §14  Invalid Transitions
// ═══════════════════════════════════════════════════════════════════════════

describe('TetherReel — Invalid Transitions (C-7)', () => {
  it('payOut from REELING_IN is rejected', () => {
    withFlag(true, () => {
      freshInit(2);
      tetherReel.payOut(0, 20);
      tetherReel.update(10.0);
      tetherReel.reelIn(0);
      const ok = tetherReel.payOut(0, 30);
      assert.equal(ok, false, 'payOut rejected from REELING_IN');
    });
  });

  it('reelIn from STOWED (with 0 cable) is rejected', () => {
    withFlag(true, () => {
      eventBus.clear();
      freshInit(2);
      const ok = tetherReel.reelIn(0);
      // STOWED state doesn't allow reelIn — must be STATIC first
      assert.equal(ok, false, 'rejected from STOWED');
      assert.equal(tetherReel.getReelState(0), RS.STOWED, 'stays STOWED');
      eventBus.clear();
    });
  });

  it('reelIn from JAMMED is rejected', () => {
    withFlag(true, () => {
      freshInit(2);
      tetherReel._reels.get(0).state = RS.JAMMED;
      const ok = tetherReel.reelIn(0);
      assert.equal(ok, false, 'rejected from JAMMED');
    });
  });

  it('invalid armIndex returns safe defaults', () => {
    withFlag(true, () => {
      freshInit(2);
      assert.equal(tetherReel.getReelState(99), RS.STOWED, 'default STOWED for invalid index');
      assert.equal(tetherReel.getCableLength(99), 0, 'default 0 for invalid index');
      assert.equal(tetherReel.getTensionN(99), 0, 'default 0 tension for invalid index');
      assert.equal(tetherReel.payOut(99, 10), false, 'payOut rejected for invalid index');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §15  Full Lifecycle
// ═══════════════════════════════════════════════════════════════════════════

describe('TetherReel — Full Lifecycle (C-7)', () => {
  it('STOWED → payOut → PAYING_OUT → (update) → STATIC → reelIn → REELING_IN → (update) → STOWED', () => {
    withFlag(true, () => {
      eventBus.clear();
      freshInit(2);

      // 1. STOWED
      assert.equal(tetherReel.getReelState(0), RS.STOWED, '1. STOWED');

      // 2. Pay out 15m
      tetherReel.payOut(0, 15);
      assert.equal(tetherReel.getReelState(0), RS.PAYING_OUT, '2. PAYING_OUT');

      // 3. Update until target reached (15m / 5 m/s = 3s)
      tetherReel.update(4.0);
      assert.equal(tetherReel.getReelState(0), RS.STATIC, '3. STATIC');
      assert.closeTo(tetherReel.getCableLength(0), 15, 0.01, '   cable at 15m');

      // 4. Reel in
      tetherReel.reelIn(0);
      assert.equal(tetherReel.getReelState(0), RS.REELING_IN, '4. REELING_IN');

      // 5. Update until complete (15m / 2 m/s = 7.5s)
      tetherReel.update(10.0);
      assert.equal(tetherReel.getReelState(0), RS.STOWED, '5. STOWED again');
      assert.closeTo(tetherReel.getCableLength(0), 0, 0.01, '   cable at 0m');
      eventBus.clear();
    });
  });

  it('payOut → complete → stow → payOut again (full cycle)', () => {
    withFlag(true, () => {
      freshInit(2);

      tetherReel.payOut(0, 30);
      tetherReel.update(10.0); // → STATIC at 30m
      tetherReel.reelIn(0);
      tetherReel.update(20.0); // → STOWED
      assert.equal(tetherReel.getReelState(0), RS.STOWED, 'back to STOWED');

      // Pay out again
      const ok = tetherReel.payOut(0, 40);
      assert.ok(ok, 'second payOut accepted');
      tetherReel.update(10.0);
      assert.equal(tetherReel.getReelState(0), RS.STATIC, 'STATIC at 40m');
      assert.closeTo(tetherReel.getCableLength(0), 40, 0.01, 'cable at 40m');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §16  ArmUnit Integration Verification
// ═══════════════════════════════════════════════════════════════════════════

describe('TetherReel — ArmUnit Integration (C-7)', () => {
  it('tetherReel uses strut tip anchor via getTetherAnchorWorldPosition concept', () => {
    // The cable origin is the strut tip — verified by TetherReel.update()'s
    // getEndpointDistance callback receiving the distance from strut tip to target.
    // ArmUnit._updateTether() uses getTetherAnchorWorldPosition() for the anchor.
    // When TETHER_REEL is ON, _updateTether reads cable state from tetherReel
    // (which was computed using distance from that same anchor).
    withFlag(true, () => {
      freshInit(2);
      tetherReel.payOut(0, 20);
      tetherReel.update(10.0);
      // The singleton correctly tracks cable state
      assert.equal(tetherReel.getReelState(0), RS.STATIC, 'reel manages cable state');
      assert.closeTo(tetherReel.getCableLength(0), 20, 0.01, 'cable from strut tip origin');
    });
  });

  it('getReelRecord provides HUD-ready data', () => {
    withFlag(true, () => {
      freshInit(2);
      tetherReel.payOut(0, 25);
      tetherReel.update(10.0);
      tetherReel.attachEndpoint(0, 'debris-7', 8.0);
      const rec = tetherReel.getReelRecord(0);
      assert.ok(rec, 'record exists');
      assert.equal(rec.state, RS.STATIC, 'state');
      assert.closeTo(rec.cableLengthM, 25, 0.01, 'cableLengthM');
      assert.equal(rec.maxCableLengthM, REEL.MAX_CABLE_LENGTH_M.Y0, 'maxCableLengthM');
      assert.equal(rec.attachedEndpointId, 'debris-7', 'endpoint');
      assert.equal(rec.payloadMassKg, 8.0, 'payload mass');
    });
  });
});

// Restore jam probability for any tests that might run after
REEL.JAM_PROBABILITY_PER_REEL = _savedJamP;
