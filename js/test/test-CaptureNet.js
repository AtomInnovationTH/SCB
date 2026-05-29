/**
 * test-CaptureNet.js — ST-9.4 C-6: Capture Net System Tests
 *
 * Covers all 5 sub-tasks:
 *   a) Net projectile + deploy mechanics (state machine, flight physics)
 *   b) Catch detection + tangle quality (cling probability, frag risk)
 *   c) Reel-in + tension (motor reel, abort/release)
 *   d) Stow + cargo hand-off (inventory, persistence)
 *   e) HUD indicators (inventory queries, captured mass, cooldowns)
 *
 * Plus: feature flag gating, constants validation, event emission verification.
 */

import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import {
  NetProjectile,
  CaptureNetSystem,
  captureNetSystem,
  computeClingProbability,
  computeDistanceModifier,
  computeFragRisk,
  recommendCaptureMode,
  getNetClassForType,
} from '../entities/CaptureNet.js';

const CN = Constants.CAPTURE_NET;
const STATES = CN.STATES;
const MODES = CN.MODES;

// ── Helpers ─────────────────────────────────────────────────────────────

/** Create a default net config for testing */
function makeNetConfig(overrides = {}) {
  return {
    netClass: CN.MEDIUM,
    armIndex: 0,
    podIndex: -1,
    launchPosition: { x: 0, y: 0, z: 0 },
    launchDirection: { x: 1, y: 0, z: 0 },
    targetDebris: null,
    captureMode: MODES.SLAM_WRAP,
    ...overrides,
  };
}

/** Create a target debris object at a given position */
function makeTarget(x = 50, y = 0, z = 0, mass = 100, opts = {}) {
  return {
    position: { x, y, z },
    mass,
    id: opts.id || 'debris-1',
    surfaceRoughness: opts.roughness ?? 1.0,
    fragility: opts.fragility ?? 0.05,
    hasSolarPanels: opts.hasSolarPanels ?? false,
    vRel: opts.vRel ?? 0,
  };
}

/** Advance a net's state machine by simulating ticks */
function advanceNet(net, totalTime, dt = 0.05) {
  let elapsed = 0;
  while (elapsed < totalTime) {
    const step = Math.min(dt, totalTime - elapsed);
    net.update(step);
    elapsed += step;
  }
}

/**
 * Create a mock arm for CaptureNetSystem testing.
 * Default inventory mirrors the real ArmUnit via Constants.ARM_NET_CAPACITY
 * (Phase 1 §13 Q5: per-arm magazine = 2 for both Weaver and Spinner).
 */
function mockArm(type = 'weaver', opts = {}) {
  const defaultInv = Constants.ARM_NET_CAPACITY[type] ?? 0;
  let inv = opts.inventory ?? defaultInv;
  return {
    config: { type },
    getNetInventory() { return inv; },
    decrementNetInventory() { if (inv > 0) inv--; return inv; },
    setNetInventory(c) { inv = c; },
    getDeployState() { return opts.deployState || 'DEPLOYED'; },
  };
}

/** Collect events emitted during a function call */
function collectEvents(eventName, fn) {
  const events = [];
  const handler = (data) => events.push(data);
  eventBus.on(eventName, handler);
  fn();
  eventBus.off(eventName, handler);
  return events;
}


// ══════════════════════════════════════════════════════════════════════════
// CONSTANTS VALIDATION
// ══════════════════════════════════════════════════════════════════════════

describe('CaptureNet — Constants', () => {
  it('FEATURE_FLAGS.CAPTURE_NET exists and is true (P1 ON)', () => {
    assert.equal(typeof Constants.FEATURE_FLAGS.CAPTURE_NET, 'boolean');
    assert.equal(Constants.FEATURE_FLAGS.CAPTURE_NET, true);
  });

  it('CAPTURE_NET block exists on Constants', () => {
    assert.ok(Constants.CAPTURE_NET, 'CAPTURE_NET block missing');
    assert.ok(Constants.CAPTURE_NET.STATES, 'STATES missing');
    assert.ok(Constants.CAPTURE_NET.MODES, 'MODES missing');
  });

  it('CAPTURE_NET.STATES has all required states', () => {
    const required = [
      'FOLDED', 'LAUNCHING', 'SPINNING_UP', 'FLIGHT',
      'CONTACT', 'BRAKE', 'ENVELOP', 'CINCH_CLOSING',
      'SECURE_CHECK', 'CAPTURED', 'MISSED', 'REELING',
      'STOWED', 'RELEASED',
    ];
    for (const s of required) {
      assert.ok(STATES[s], `Missing state: ${s}`);
    }
  });

  it('CAPTURE_NET.MODES has SLAM_WRAP and CINCH', () => {
    assert.equal(MODES.SLAM_WRAP, 'SLAM_WRAP');
    assert.equal(MODES.CINCH, 'CINCH');
  });

  it('Large Net spec matches CAPTURE_NET.md §6.1', () => {
    const L = CN.LARGE;
    assert.equal(L.CODE, 'M-NET');
    assert.equal(L.DIAMETER, 8.0);
    assert.equal(L.MASS, 1.95);
    assert.equal(L.MAX_CAPTURE_MASS, 5000);
    assert.equal(L.MAGAZINE_SIZE, 4);
    assert.equal(L.LAUNCH_SPEED, 10.0);
    assert.equal(L.REEL_SPEED, 2.0);
    assert.equal(L.TETHER_MAX, 100);
    assert.equal(L.SPIN_HZ, 2);
    assert.equal(L.RIM_WEIGHT_COUNT, 8);
  });

  it('Medium Net spec matches CAPTURE_NET.md §6.1', () => {
    const M = CN.MEDIUM;
    assert.equal(M.CODE, 'LD-NET');
    assert.equal(M.DIAMETER, 5.0);
    assert.equal(M.MASS, 0.68);
    assert.equal(M.MAX_CAPTURE_MASS, 500);
    assert.equal(M.MAGAZINE_SIZE, 2);
    assert.equal(M.SPIN_HZ, 4);
    assert.equal(M.REEL_SPEED, 2.0);
  });

  it('Small Net spec matches CAPTURE_NET.md §6.1', () => {
    const S = CN.SMALL;
    assert.equal(S.CODE, 'SD-NET');
    assert.equal(S.DIAMETER, 1.5);
    assert.equal(S.MASS, 0.12);
    assert.equal(S.MAX_CAPTURE_MASS, 50);
    assert.equal(S.MAGAZINE_SIZE, 4);
    assert.equal(S.SPIN_HZ, 6);
    assert.equal(S.REEL_SPEED, 3.0);
  });

  it('Phase timings match CAPTURE_NET.md §2.4', () => {
    assert.equal(CN.CAST_WINDUP, 0.15);
    assert.equal(CN.SPIN_UP_TIME, 0.5);
    assert.equal(CN.MAX_FLIGHT_TIME, 8);
    assert.equal(CN.SECURE_CHECK_TIME, 0.2);
    assert.equal(CN.MAGAZINE_ADVANCE_TIME, 0.5);
  });

  it('Distance zones match CAPTURE_NET.md §3.3 / QA Q-4', () => {
    assert.equal(CN.CLOSE_RANGE, 30);
    assert.equal(CN.BASELINE_RANGE_MAX, 75);
    assert.equal(CN.ENVELOPE_RANGE, 100);
  });

  it('Cling base probabilities match CAPTURE_NET.md §3.4', () => {
    assert.equal(CN.SLAM_P_BASE.RIGHT_RIGHT, 0.90);
    assert.equal(CN.SLAM_P_BASE.RIGHT_HARDER, 0.80);
    assert.equal(CN.SLAM_P_BASE.RIGHT_FRAGILE, 0.70);
    assert.equal(CN.SLAM_P_BASE.WRONG_NET, 0.50);
    assert.equal(CN.CINCH_P_BASE.RIGHT_RIGHT, 0.95);
    assert.equal(CN.CINCH_P_BASE.RIGHT_HARDER, 0.93);
  });

  it('Tangle probabilities match CAPTURE_NET.md §4.6', () => {
    assert.equal(CN.TANGLE_SELF_P, 0.015);
    assert.equal(CN.TANGLE_MOTHER_P, 0.02);
    assert.equal(CN.TANGLE_DAUGHTER_P, 0.05);
    assert.equal(CN.TANGLE_CROSS_DEBRIS_P, 0.008);
    assert.equal(CN.TANGLE_REEL_IN_P, 0.04);
  });

  it('Mother pod config matches CAPTURE_NET.md §2.9', () => {
    assert.equal(CN.MOTHER_POD_COUNT, 2);
    assert.equal(CN.MOTHER_POD_SPRING_E, 100);
  });

  it('Fragmentation mercy rule defaults to true (§5.7)', () => {
    assert.equal(CN.FRAG_MERCY_FIRST_FREE, true);
  });
});


// ══════════════════════════════════════════════════════════════════════════
// EVENTS VALIDATION
// ══════════════════════════════════════════════════════════════════════════

describe('CaptureNet — Events', () => {
  it('All required net events are defined', () => {
    const required = [
      'NET_FIRED', 'NET_CATCH_SUCCESS', 'NET_CATCH_MISS',
      'NET_REEL_STARTED', 'NET_REEL_COMPLETED', 'NET_RELEASED',
      'NET_INVENTORY_CHANGED', 'NET_CROSS_DEBRIS_WARNING',
      'NET_FRAGMENTATION', 'CINCH_FIRST_SUCCESS',
    ];
    for (const name of required) {
      assert.ok(Events[name], `Missing event: ${name}`);
      assert.equal(typeof Events[name], 'string');
    }
  });

  it('Event strings use net: namespace', () => {
    assert.ok(Events.NET_FIRED.startsWith('net:'), 'NET_FIRED namespace');
    assert.ok(Events.NET_CATCH_SUCCESS.startsWith('net:'), 'NET_CATCH_SUCCESS namespace');
    assert.ok(Events.NET_REEL_COMPLETED.startsWith('net:'), 'NET_REEL_COMPLETED namespace');
  });
});


// ══════════════════════════════════════════════════════════════════════════
// PURE FUNCTIONS — getNetClassForType
// ══════════════════════════════════════════════════════════════════════════

describe('CaptureNet — getNetClassForType', () => {
  it('mother → LARGE', () => {
    assert.equal(getNetClassForType('mother'), CN.LARGE);
  });

  it('weaver → MEDIUM', () => {
    assert.equal(getNetClassForType('weaver'), CN.MEDIUM);
  });

  it('spinner → SMALL', () => {
    assert.equal(getNetClassForType('spinner'), CN.SMALL);
  });

  it('unknown → MEDIUM (fallback)', () => {
    assert.equal(getNetClassForType('unknown'), CN.MEDIUM);
  });
});


// ══════════════════════════════════════════════════════════════════════════
// PURE FUNCTIONS — computeClingProbability
// ══════════════════════════════════════════════════════════════════════════

describe('CaptureNet — computeClingProbability', () => {
  it('baseline case: design range, matched net, optimal velocity', () => {
    const p = computeClingProbability({
      pBase: 0.90,
      vRel: 10,
      vOptimal: 10,
      range: 50,
    });
    // f_velocity=1, f_distance = 1.1 - 0.003*50 = 0.95 → P = 0.90 * 1 * 1 * 1 * 1 * 1 * 0.95 = 0.855
    assert.ok(Math.abs(p - 0.855) < 0.001, `Expected ~0.855, got ${p}`);
  });

  it('close range (<30m) gives distance bonus (f_distance ≈ 1.1)', () => {
    const p = computeClingProbability({
      pBase: 0.80,
      vRel: 10,
      vOptimal: 10,
      range: 20,
    });
    // f_distance = max(0.85, min(1.1, 1.1 - 0.003*20)) = max(0.85, 1.04) = 1.04
    // P = 0.80 * 1 * 1 * 1 * 1 * 1 * 1.04 = 0.832
    assert.ok(Math.abs(p - 0.832) < 0.001, `Expected ~0.832, got ${p}`);
  });

  it('far range (>75m) reduces probability', () => {
    const pClose = computeClingProbability({ pBase: 0.80, vRel: 10, vOptimal: 10, range: 20 });
    const pFar   = computeClingProbability({ pBase: 0.80, vRel: 10, vOptimal: 10, range: 90 });
    assert.ok(pFar < pClose, `Far (${pFar}) should be < close (${pClose})`);
  });

  it('velocity mismatch reduces probability', () => {
    const pOptimal = computeClingProbability({ pBase: 0.80, vRel: 10, vOptimal: 10, range: 50 });
    const pFast    = computeClingProbability({ pBase: 0.80, vRel: 18, vOptimal: 10, range: 50 });
    assert.ok(pFast < pOptimal, `Fast (${pFast}) should be < optimal (${pOptimal})`);
  });

  it('rough surface gives better cling than smooth', () => {
    const pMli    = computeClingProbability({ pBase: 0.80, vRel: 10, vOptimal: 10, range: 50, roughness: 1.0 });
    const pSmooth = computeClingProbability({ pBase: 0.80, vRel: 10, vOptimal: 10, range: 50, roughness: 0.4 });
    assert.ok(pSmooth < pMli, `Smooth (${pSmooth}) should be < rough (${pMli})`);
  });

  it('low spin fraction reduces probability', () => {
    const pFull = computeClingProbability({ pBase: 0.80, vRel: 10, vOptimal: 10, range: 50, spinFraction: 1.0 });
    const pHalf = computeClingProbability({ pBase: 0.80, vRel: 10, vOptimal: 10, range: 50, spinFraction: 0.5 });
    assert.ok(pHalf < pFull, `Half spin (${pHalf}) should be < full (${pFull})`);
  });

  it('all factors clamped — result always in [0, 1]', () => {
    const pMax = computeClingProbability({
      pBase: 1.0, vRel: 10, vOptimal: 10, range: 0,
      roughness: 1.0, spinFraction: 1.2, tensionFraction: 1.0, contactFraction: 1.0,
    });
    assert.ok(pMax <= 1.0, `Max P (${pMax}) should be ≤ 1.0`);
    assert.ok(pMax > 0, 'Max P should be positive');
  });
});


// ══════════════════════════════════════════════════════════════════════════
// PURE FUNCTIONS — computeDistanceModifier
// ══════════════════════════════════════════════════════════════════════════

describe('CaptureNet — computeDistanceModifier', () => {
  it('0m → clamped to 1.1', () => {
    assert.equal(computeDistanceModifier(0), 1.1);
  });

  it('30m → 1.0', () => {
    const f = computeDistanceModifier(30);
    assert.ok(Math.abs(f - 1.01) < 0.01, `Expected ~1.01, got ${f}`);
  });

  it('50m → middle of baseline zone', () => {
    const f = computeDistanceModifier(50);
    // 1.1 - 0.003*50 = 0.95
    assert.ok(Math.abs(f - 0.95) < 0.001, `Expected 0.95, got ${f}`);
  });

  it('100m → clamped at 0.85', () => {
    // 1.1 - 0.003*100 = 0.80 → clamped to 0.85
    assert.equal(computeDistanceModifier(100), 0.85);
  });

  it('200m → still clamped at 0.85', () => {
    assert.equal(computeDistanceModifier(200), 0.85);
  });
});


// ══════════════════════════════════════════════════════════════════════════
// PURE FUNCTIONS — computeFragRisk
// ══════════════════════════════════════════════════════════════════════════

describe('CaptureNet — computeFragRisk', () => {
  it('metal fragment at slow velocity — negligible risk', () => {
    const r = computeFragRisk({ netMass: 0.68, vRel: 2, targetFragility: 0.05, range: 50 });
    assert.ok(r < 0.05, `Expected low risk, got ${r}`);
  });

  it('higher velocity increases frag risk', () => {
    const rSlow = computeFragRisk({ netMass: 0.68, vRel: 2, targetFragility: 0.10, range: 50 });
    const rFast = computeFragRisk({ netMass: 0.68, vRel: 10, targetFragility: 0.10, range: 50 });
    assert.ok(rFast > rSlow, `Fast (${rFast}) should > slow (${rSlow})`);
  });

  it('close range halves frag risk', () => {
    const rClose = computeFragRisk({ netMass: 0.68, vRel: 5, targetFragility: 0.25, range: 20 });
    const rBase  = computeFragRisk({ netMass: 0.68, vRel: 5, targetFragility: 0.25, range: 50 });
    assert.ok(rClose < rBase, `Close (${rClose}) should < baseline (${rBase})`);
  });

  it('far range increases frag risk (×1.5)', () => {
    const rBase = computeFragRisk({ netMass: 0.68, vRel: 5, targetFragility: 0.25, range: 50 });
    const rFar  = computeFragRisk({ netMass: 0.68, vRel: 5, targetFragility: 0.25, range: 80 });
    assert.ok(rFar > rBase, `Far (${rFar}) should > baseline (${rBase})`);
  });

  it('result clamped to [0, 1]', () => {
    const r = computeFragRisk({ netMass: 2.0, vRel: 20, targetFragility: 1.0, range: 90 });
    assert.ok(r <= 1.0, `Risk ${r} should be ≤ 1`);
    assert.ok(r >= 0, `Risk ${r} should be ≥ 0`);
  });
});


// ══════════════════════════════════════════════════════════════════════════
// PURE FUNCTIONS — recommendCaptureMode
// ══════════════════════════════════════════════════════════════════════════

describe('CaptureNet — recommendCaptureMode', () => {
  it('null target → SLAM_WRAP', () => {
    assert.equal(recommendCaptureMode(null), MODES.SLAM_WRAP);
  });

  it('target with solar panels → CINCH', () => {
    assert.equal(recommendCaptureMode({ hasSolarPanels: true }), MODES.CINCH);
  });

  it('high relative velocity → CINCH', () => {
    assert.equal(recommendCaptureMode({ vRel: 8 }), MODES.CINCH);
  });

  it('smooth surface → CINCH', () => {
    assert.equal(recommendCaptureMode({ surfaceRoughness: 0.3 }), MODES.CINCH);
  });

  it('durable metal fragment → SLAM_WRAP', () => {
    assert.equal(recommendCaptureMode({ surfaceRoughness: 1.0, vRel: 2 }), MODES.SLAM_WRAP);
  });
});


// ══════════════════════════════════════════════════════════════════════════
// ST-9.4a — NET PROJECTILE STATE MACHINE
// ══════════════════════════════════════════════════════════════════════════

describe('CaptureNet — ST-9.4a: NetProjectile creation', () => {
  it('starts in LAUNCHING state', () => {
    const net = new NetProjectile(makeNetConfig());
    assert.equal(net.state, STATES.LAUNCHING);
  });

  it('stores net class from config', () => {
    const net = new NetProjectile(makeNetConfig({ netClass: CN.LARGE }));
    assert.equal(net.netClass, CN.LARGE);
  });

  it('initial position matches launch position', () => {
    const net = new NetProjectile(makeNetConfig({ launchPosition: { x: 5, y: 10, z: 15 } }));
    assert.equal(net.position.x, 5);
    assert.equal(net.position.y, 10);
    assert.equal(net.position.z, 15);
  });

  it('initial spin rate is 0', () => {
    const net = new NetProjectile(makeNetConfig());
    assert.equal(net.spinRate, 0);
  });

  it('isActive starts true', () => {
    const net = new NetProjectile(makeNetConfig());
    assert.equal(net.isActive, true);
  });
});


describe('CaptureNet — ST-9.4a: Launch → Spin-up → Flight transitions', () => {
  it('LAUNCHING → SPINNING_UP after CAST_WINDUP (0.15s)', () => {
    const net = new NetProjectile(makeNetConfig());
    advanceNet(net, 0.14);
    assert.equal(net.state, STATES.LAUNCHING, 'Should still be LAUNCHING');
    advanceNet(net, 0.02);
    assert.equal(net.state, STATES.SPINNING_UP, 'Should be SPINNING_UP');
  });

  it('Spin rate ramps during SPINNING_UP', () => {
    const net = new NetProjectile(makeNetConfig());
    advanceNet(net, CN.CAST_WINDUP + 0.01); // enter SPINNING_UP
    const rate1 = net.spinRate;
    advanceNet(net, 0.2);
    const rate2 = net.spinRate;
    assert.ok(rate2 > rate1, `Spin should increase: ${rate1} → ${rate2}`);
  });

  it('SPINNING_UP → FLIGHT after SPIN_UP_TIME (0.5s)', () => {
    const net = new NetProjectile(makeNetConfig());
    advanceNet(net, CN.CAST_WINDUP + CN.SPIN_UP_TIME + 0.01);
    assert.equal(net.state, STATES.FLIGHT);
    assert.equal(net.spinRate, CN.MEDIUM.SPIN_HZ);
  });

  it('Position advances during FLIGHT', () => {
    const net = new NetProjectile(makeNetConfig({
      launchDirection: { x: 1, y: 0, z: 0 },
    }));
    // Get to FLIGHT
    advanceNet(net, CN.CAST_WINDUP + CN.SPIN_UP_TIME + 0.01);
    const x0 = net.position.x;
    advanceNet(net, 1.0);
    assert.ok(net.position.x > x0, `Position should advance: ${x0} → ${net.position.x}`);
    // Expect ~10 m/s * 1s = 10m
    assert.ok(Math.abs(net.position.x - x0 - 10) < 1, 'Should travel ~10m in 1s');
  });

  it('Tether pays out proportional to distance', () => {
    const net = new NetProjectile(makeNetConfig());
    advanceNet(net, CN.CAST_WINDUP + CN.SPIN_UP_TIME + 0.01);
    advanceNet(net, 2.0);
    // ~20m of tether paid out
    assert.ok(net.tetherPaidOut > 15 && net.tetherPaidOut < 25,
      `Tether pay-out: ${net.tetherPaidOut}`);
  });
});


describe('CaptureNet — ST-9.4a: Flight timeout + tether limit', () => {
  it('MISSED after MAX_FLIGHT_TIME (8s) with no target', () => {
    const net = new NetProjectile(makeNetConfig());
    advanceNet(net, CN.CAST_WINDUP + CN.SPIN_UP_TIME + CN.MAX_FLIGHT_TIME + 0.1);
    assert.equal(net.state, STATES.MISSED);
    assert.equal(net.catchResult, 'miss');
  });

  it('Emits NET_CATCH_MISS on timeout', () => {
    const net = new NetProjectile(makeNetConfig());
    const events = [];
    const handler = (d) => events.push(d);
    eventBus.on(Events.NET_CATCH_MISS, handler);
    advanceNet(net, CN.CAST_WINDUP + CN.SPIN_UP_TIME + CN.MAX_FLIGHT_TIME + 0.1);
    eventBus.off(Events.NET_CATCH_MISS, handler);
    assert.ok(events.length > 0, 'Should emit NET_CATCH_MISS');
    assert.equal(events[0].reason, 'timeout');
  });

  it('MISSED when tether limit reached', () => {
    // Small net has 100m tether, 10 m/s → 10s to reach limit (but max flight is 8s)
    // Use a custom config to test tether limit before timeout
    const customClass = { ...CN.MEDIUM, TETHER_MAX: 20, LAUNCH_SPEED: 10, SPIN_HZ: 4 };
    const net = new NetProjectile(makeNetConfig({ netClass: customClass }));
    advanceNet(net, CN.CAST_WINDUP + CN.SPIN_UP_TIME + 3.0);
    assert.equal(net.state, STATES.MISSED);
    assert.equal(net.catchResult, 'miss');
  });
});


describe('CaptureNet — ST-9.4a: Target intersection triggers contact', () => {
  it('Slam-wrap: FLIGHT → CONTACT when net reaches target', () => {
    // Target at distance 15m along x-axis, net diameter 5m (radius 2.5m)
    const target = makeTarget(15, 0, 0);
    const net = new NetProjectile(makeNetConfig({
      targetDebris: target,
      captureMode: MODES.SLAM_WRAP,
    }));
    // LAUNCHING(0.15) + SPINNING_UP(0.5) + FLIGHT: 15m @ 10m/s = 1.5s → ~2.15s total
    advanceNet(net, 2.5);
    assert.equal(net.state, STATES.SECURE_CHECK,
      `After contact + slam time should be SECURE_CHECK, got ${net.state}`);
  });

  it('Cinch mode: FLIGHT → BRAKE → ENVELOP → CINCH_CLOSING → SECURE_CHECK', () => {
    const target = makeTarget(15, 0, 0);
    const net = new NetProjectile(makeNetConfig({
      targetDebris: target,
      captureMode: MODES.CINCH,
    }));
    // Need to track state sequence
    const stateSequence = [net.state];
    const originalUpdate = net.update.bind(net);
    const prevState = { s: net.state };
    const updater = (dt) => {
      originalUpdate(dt);
      if (net.state !== prevState.s) {
        stateSequence.push(net.state);
        prevState.s = net.state;
      }
    };

    // Advance until we're past SECURE_CHECK
    for (let t = 0; t < 10; t += 0.05) {
      updater(0.05);
      if (net.state === STATES.SECURE_CHECK ||
          net.state === STATES.CAPTURED ||
          net.state === STATES.MISSED) break;
    }

    assert.ok(stateSequence.includes(STATES.BRAKE), 'Should pass through BRAKE');
    assert.ok(stateSequence.includes(STATES.ENVELOP), 'Should pass through ENVELOP');
    assert.ok(stateSequence.includes(STATES.CINCH_CLOSING), 'Should pass through CINCH_CLOSING');
  });
});


// ══════════════════════════════════════════════════════════════════════════
// ST-9.4b — CATCH DETECTION + TANGLE QUALITY
// ══════════════════════════════════════════════════════════════════════════

describe('CaptureNet — ST-9.4b: Catch resolution', () => {
  it('forceResolve(true) → CAPTURED with correct mass', () => {
    const target = makeTarget(10, 0, 0, 250);
    const net = new NetProjectile(makeNetConfig({ targetDebris: target }));
    net.forceResolve(true, 0.85);
    assert.equal(net.state, STATES.CAPTURED);
    assert.equal(net.catchResult, 'success');
    assert.equal(net.capturedMass, 250);
    assert.equal(net.tangleQuality, 0.85);
  });

  it('forceResolve(false) → MISSED', () => {
    const net = new NetProjectile(makeNetConfig({ targetDebris: makeTarget() }));
    net.forceResolve(false, 0.5);
    assert.equal(net.state, STATES.MISSED);
    assert.equal(net.catchResult, 'miss');
    assert.equal(net.capturedMass, 0);
  });

  it('NET_CATCH_SUCCESS emitted on successful catch', () => {
    const target = makeTarget(10, 0, 0, 100, { id: 'test-debris' });
    const net = new NetProjectile(makeNetConfig({ targetDebris: target }));
    const events = collectEvents(Events.NET_CATCH_SUCCESS, () => {
      net.forceResolve(true, 0.9);
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].debrisId, 'test-debris');
    assert.equal(events[0].capturedMass, 100);
    assert.equal(events[0].tangleQuality, 0.9);
  });

  it('NET_CATCH_MISS emitted on failed catch', () => {
    const target = makeTarget(10, 0, 0, 100, { id: 'miss-target' });
    const net = new NetProjectile(makeNetConfig({ targetDebris: target }));
    const events = collectEvents(Events.NET_CATCH_MISS, () => {
      net.forceResolve(false, 0.4);
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].debrisId, 'miss-target');
  });

  it('Tangle quality equals cling probability on success', () => {
    const net = new NetProjectile(makeNetConfig({ targetDebris: makeTarget() }));
    net.forceResolve(true, 0.77);
    assert.equal(net.tangleQuality, 0.77);
  });
});


// ══════════════════════════════════════════════════════════════════════════
// ST-9.4c — REEL-IN + TENSION
// ══════════════════════════════════════════════════════════════════════════

describe('CaptureNet — ST-9.4c: Reel-in mechanics', () => {
  it('startReel() from CAPTURED → REELING', () => {
    const net = new NetProjectile(makeNetConfig({ targetDebris: makeTarget() }));
    net.forceResolve(true);
    assert.equal(net.startReel(), true);
    assert.equal(net.state, STATES.REELING);
    assert.equal(net.reelProgress, 0);
  });

  it('startReel() from MISSED → REELING (empty net)', () => {
    const net = new NetProjectile(makeNetConfig({ targetDebris: makeTarget() }));
    net.forceResolve(false);
    assert.equal(net.startReel(), true);
    assert.equal(net.state, STATES.REELING);
  });

  it('startReel() from FLIGHT → returns false (invalid state)', () => {
    const net = new NetProjectile(makeNetConfig());
    advanceNet(net, CN.CAST_WINDUP + CN.SPIN_UP_TIME + 0.1);
    assert.equal(net.state, STATES.FLIGHT);
    assert.equal(net.startReel(), false);
  });

  it('Reel progress advances over time', () => {
    const net = new NetProjectile(makeNetConfig({ targetDebris: makeTarget() }));
    // Simulate some flight distance
    net.tetherPaidOut = 20; // 20m of tether out
    net.forceResolve(true);
    net.startReel();
    advanceNet(net, 2.0);
    assert.ok(net.reelProgress > 0, `Reel progress should advance: ${net.reelProgress}`);
    assert.ok(net.reelProgress < 1, 'Should not be done yet at 2s for 20m');
  });

  it('Reel completes and transitions to STOWED', () => {
    const net = new NetProjectile(makeNetConfig({ targetDebris: makeTarget() }));
    net.tetherPaidOut = 5; // short tether for fast reel
    net.forceResolve(true);
    net.startReel();
    advanceNet(net, 10.0); // plenty of time
    assert.equal(net.state, STATES.STOWED);
    assert.equal(net.reelProgress, 1.0);
  });

  it('NET_REEL_STARTED emitted on startReel', () => {
    const net = new NetProjectile(makeNetConfig({ targetDebris: makeTarget() }));
    net.forceResolve(true);
    const events = collectEvents(Events.NET_REEL_STARTED, () => {
      net.startReel();
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].hasCatch, true);
  });

  it('NET_REEL_COMPLETED emitted when reel finishes', () => {
    const net = new NetProjectile(makeNetConfig({ targetDebris: makeTarget(10, 0, 0, 75) }));
    net.tetherPaidOut = 3;
    net.forceResolve(true);
    net.startReel();
    const events = collectEvents(Events.NET_REEL_COMPLETED, () => {
      advanceNet(net, 10.0);
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].capturedMass, 75);
  });

  it('Tension increases with captured mass', () => {
    const net = new NetProjectile(makeNetConfig({ targetDebris: makeTarget(10, 0, 0, 500) }));
    net.tetherPaidOut = 50;
    net.forceResolve(true);
    net.startReel();
    advanceNet(net, 0.5);
    assert.ok(net.tensionN > 1.0, `Tension should be >1 for 500kg debris: ${net.tensionN}`);
  });
});


describe('CaptureNet — ST-9.4c: Release/abort', () => {
  it('release() from CAPTURED → RELEASED', () => {
    const net = new NetProjectile(makeNetConfig({ targetDebris: makeTarget() }));
    net.forceResolve(true);
    assert.equal(net.release(), true);
    assert.equal(net.state, STATES.RELEASED);
    assert.equal(net.capturedMass, 0);
    assert.equal(net.isActive, false);
  });

  it('release() from REELING → RELEASED', () => {
    const net = new NetProjectile(makeNetConfig({ targetDebris: makeTarget() }));
    net.tetherPaidOut = 20;
    net.forceResolve(true);
    net.startReel();
    assert.equal(net.release(), true);
    assert.equal(net.state, STATES.RELEASED);
  });

  it('release() from FLIGHT → RELEASED (abort in-flight)', () => {
    const net = new NetProjectile(makeNetConfig());
    advanceNet(net, CN.CAST_WINDUP + CN.SPIN_UP_TIME + 0.1);
    assert.equal(net.state, STATES.FLIGHT);
    assert.equal(net.release(), true);
    assert.equal(net.state, STATES.RELEASED);
  });

  it('release() from MISSED → returns false (already terminal)', () => {
    const net = new NetProjectile(makeNetConfig({ targetDebris: makeTarget() }));
    net.forceResolve(false);
    assert.equal(net.release(), false);
  });

  it('NET_RELEASED emitted on release', () => {
    const net = new NetProjectile(makeNetConfig({ targetDebris: makeTarget(10, 0, 0, 50, { id: 'rel-1' }) }));
    net.forceResolve(true);
    const events = collectEvents(Events.NET_RELEASED, () => {
      net.release();
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].debrisId, 'rel-1');
  });
});


// ══════════════════════════════════════════════════════════════════════════
// ST-9.4d — CAPTURE NET SYSTEM (inventory + fire + stow)
// ══════════════════════════════════════════════════════════════════════════

describe('CaptureNet — ST-9.4d: CaptureNetSystem lifecycle', () => {
  // Save and restore feature flag state
  let savedFlag;
  const setup = () => {
    savedFlag = Constants.FEATURE_FLAGS.CAPTURE_NET;
    Constants.FEATURE_FLAGS.CAPTURE_NET = true;
  };
  const teardown = () => {
    Constants.FEATURE_FLAGS.CAPTURE_NET = savedFlag;
    captureNetSystem.reset();
  };

  it('init() sets mother pod inventory to 4+4 at Y0', () => {
    setup();
    captureNetSystem.init();
    assert.equal(captureNetSystem.getMotherNetCount(), 8);
    assert.equal(captureNetSystem.getMotherPodInventory(0), 4);
    assert.equal(captureNetSystem.getMotherPodInventory(1), 4);
    teardown();
  });

  it('init() no-ops when flag is false', () => {
    Constants.FEATURE_FLAGS.CAPTURE_NET = false;
    captureNetSystem.reset();
    captureNetSystem.init();
    assert.equal(captureNetSystem.getMotherNetCount(), 0);
    Constants.FEATURE_FLAGS.CAPTURE_NET = savedFlag;
  });

  it('reset() clears all state', () => {
    setup();
    captureNetSystem.init();
    captureNetSystem.reset();
    assert.equal(captureNetSystem.getMotherNetCount(), 0);
    assert.equal(captureNetSystem.activeNets.length, 0);
    teardown();
  });
});


describe('CaptureNet — ST-9.4d: fireMotherNet', () => {
  let savedFlag;
  const setup = () => {
    savedFlag = Constants.FEATURE_FLAGS.CAPTURE_NET;
    Constants.FEATURE_FLAGS.CAPTURE_NET = true;
    captureNetSystem.reset();
    captureNetSystem.init();
  };
  const teardown = () => {
    Constants.FEATURE_FLAGS.CAPTURE_NET = savedFlag;
    captureNetSystem.reset();
  };

  it('fires from pod 0 and depletes inventory', () => {
    setup();
    const net = captureNetSystem.fireMotherNet(
      0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, makeTarget(), MODES.SLAM_WRAP
    );
    assert.ok(net, 'Should return a NetProjectile');
    assert.equal(net.netClass, CN.LARGE);
    assert.equal(captureNetSystem.getMotherPodInventory(0), 3);
    assert.equal(captureNetSystem.activeNets.length, 1);
    teardown();
  });

  it('returns null when pod is empty', () => {
    setup();
    // Fire all 4 from pod 0
    for (let i = 0; i < 4; i++) {
      captureNetSystem.fireMotherNet(0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, makeTarget());
    }
    const net = captureNetSystem.fireMotherNet(0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, makeTarget());
    assert.equal(net, null, 'Should be null when pod empty');
    assert.equal(captureNetSystem.getMotherPodInventory(0), 0);
    // Pod 1 should still have 4
    assert.equal(captureNetSystem.getMotherPodInventory(1), 4);
    teardown();
  });

  it('returns null when flag is off', () => {
    setup();
    Constants.FEATURE_FLAGS.CAPTURE_NET = false;
    const net = captureNetSystem.fireMotherNet(0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, makeTarget());
    assert.equal(net, null);
    Constants.FEATURE_FLAGS.CAPTURE_NET = true;
    teardown();
  });

  it('emits NET_FIRED event with correct payload', () => {
    setup();
    const events = collectEvents(Events.NET_FIRED, () => {
      captureNetSystem.fireMotherNet(1, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, makeTarget());
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].source, 'mother');
    assert.equal(events[0].podIndex, 1);
    assert.equal(events[0].netClass, 'LARGE');
    assert.equal(events[0].remaining, 3);
    teardown();
  });

  it('emits NET_INVENTORY_CHANGED event', () => {
    setup();
    const events = collectEvents(Events.NET_INVENTORY_CHANGED, () => {
      captureNetSystem.fireMotherNet(0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, makeTarget());
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].source, 'mother');
    assert.deepEqual(events[0].podInventory, [3, 4]);
    teardown();
  });
});


describe('CaptureNet — ST-9.4d: fireDaughterNet', () => {
  let savedFlag;
  const setup = () => {
    savedFlag = Constants.FEATURE_FLAGS.CAPTURE_NET;
    Constants.FEATURE_FLAGS.CAPTURE_NET = true;
    captureNetSystem.reset();
    captureNetSystem.init();
  };
  const teardown = () => {
    Constants.FEATURE_FLAGS.CAPTURE_NET = savedFlag;
    captureNetSystem.reset();
  };

  it('fires from weaver arm and depletes inventory', () => {
    setup();
    const arm = mockArm('weaver');
    const net = captureNetSystem.fireDaughterNet(
      arm, 0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, makeTarget()
    );
    assert.ok(net, 'Should return NetProjectile');
    assert.equal(net.netClass, CN.MEDIUM);
    assert.equal(arm.getNetInventory(), 1); // was 2, now 1
    teardown();
  });

  it('fires from spinner arm → Small Net', () => {
    setup();
    const arm = mockArm('spinner');
    const net = captureNetSystem.fireDaughterNet(
      arm, 1, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, makeTarget()
    );
    assert.ok(net);
    assert.equal(net.netClass, CN.SMALL);
    assert.equal(arm.getNetInventory(), 1); // was 2 (ARM_NET_CAPACITY.spinner), now 1
    teardown();
  });

  it('returns null when arm inventory is 0', () => {
    setup();
    const arm = mockArm('weaver', { inventory: 0 });
    const net = captureNetSystem.fireDaughterNet(
      arm, 0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, makeTarget()
    );
    assert.equal(net, null);
    teardown();
  });

  it('returns null when deploy state is not DEPLOYED (flag on)', () => {
    setup();
    Constants.FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE = true;
    const arm = mockArm('weaver', { deployState: 'STOWED' });
    const net = captureNetSystem.fireDaughterNet(
      arm, 0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, makeTarget()
    );
    assert.equal(net, null, 'Should block fire from non-DEPLOYED arm');
    Constants.FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE = false;
    teardown();
  });

  it('emits NET_FIRED with daughter source', () => {
    setup();
    const arm = mockArm('spinner');
    const events = collectEvents(Events.NET_FIRED, () => {
      captureNetSystem.fireDaughterNet(arm, 2, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, makeTarget());
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].source, 'daughter');
    assert.equal(events[0].armIndex, 2);
    assert.equal(events[0].netClass, 'SMALL');
    teardown();
  });
});


describe('CaptureNet — ST-9.4d: System update + auto-reel', () => {
  let savedFlag;
  const setup = () => {
    savedFlag = Constants.FEATURE_FLAGS.CAPTURE_NET;
    Constants.FEATURE_FLAGS.CAPTURE_NET = true;
    captureNetSystem.reset();
    captureNetSystem.init();
  };
  const teardown = () => {
    Constants.FEATURE_FLAGS.CAPTURE_NET = savedFlag;
    captureNetSystem.reset();
  };

  it('update() advances active nets', () => {
    setup();
    const net = captureNetSystem.fireMotherNet(
      0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, null
    );
    assert.equal(net.state, STATES.LAUNCHING);
    captureNetSystem.update(0.2);
    assert.equal(net.state, STATES.SPINNING_UP);
    teardown();
  });

  it('Completed nets are removed from activeNets', () => {
    setup();
    const net = captureNetSystem.fireMotherNet(
      0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, makeTarget(10, 0, 0)
    );
    // Force resolve and reel
    net.forceResolve(true);
    net.startReel();
    net.tetherPaidOut = 1; // short tether
    // Update until stowed
    for (let i = 0; i < 100; i++) {
      captureNetSystem.update(0.1);
      if (captureNetSystem.activeNets.length === 0) break;
    }
    assert.equal(captureNetSystem.activeNets.length, 0, 'Stowed net should be removed');
    teardown();
  });

  it('Cooldown prevents immediate re-fire', () => {
    setup();
    const net1 = captureNetSystem.fireMotherNet(
      0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, makeTarget()
    );
    // Force-resolve to trigger cooldown
    net1.forceResolve(true);
    captureNetSystem.update(0.01); // trigger auto-reel + cooldown set

    // Try to fire again immediately
    const net2 = captureNetSystem.fireMotherNet(
      0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, makeTarget()
    );
    // This should still work since cooldown is key-based, and pod_0 is in cooldown
    // But there's still inventory. The cooldown check should block.
    assert.equal(net2, null, 'Should be blocked by cooldown');
    teardown();
  });

  it('Cooldown expires after COOLDOWN_CATCH seconds', () => {
    setup();
    const net1 = captureNetSystem.fireMotherNet(
      0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, makeTarget()
    );
    net1.forceResolve(true);
    captureNetSystem.update(0.01);

    // Wait out the cooldown + a bit
    for (let i = 0; i < 30; i++) captureNetSystem.update(0.1);

    const net2 = captureNetSystem.fireMotherNet(
      0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, makeTarget()
    );
    assert.ok(net2, 'Should be able to fire after cooldown expires');
    teardown();
  });

  it('update() no-ops when flag is false', () => {
    setup();
    Constants.FEATURE_FLAGS.CAPTURE_NET = false;
    captureNetSystem.update(1.0); // should not throw
    Constants.FEATURE_FLAGS.CAPTURE_NET = true;
    teardown();
  });
});


// ══════════════════════════════════════════════════════════════════════════
// ST-9.4e — HUD QUERIES + INVENTORY
// ══════════════════════════════════════════════════════════════════════════

describe('CaptureNet — ST-9.4e: HUD inventory queries', () => {
  let savedFlag;
  const setup = () => {
    savedFlag = Constants.FEATURE_FLAGS.CAPTURE_NET;
    Constants.FEATURE_FLAGS.CAPTURE_NET = true;
    captureNetSystem.reset();
    captureNetSystem.init();
  };
  const teardown = () => {
    Constants.FEATURE_FLAGS.CAPTURE_NET = savedFlag;
    captureNetSystem.reset();
  };

  it('getMotherPodMax returns magazine size', () => {
    setup();
    assert.equal(captureNetSystem.getMotherPodMax(0), CN.LARGE.MAGAZINE_SIZE);
    assert.equal(captureNetSystem.getMotherPodMax(1), CN.LARGE.MAGAZINE_SIZE);
    teardown();
  });

  it('getActiveNetForArm returns active net or null', () => {
    setup();
    assert.equal(captureNetSystem.getActiveNetForArm(0), null);
    const arm = mockArm('weaver');
    captureNetSystem.fireDaughterNet(arm, 0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, makeTarget());
    assert.ok(captureNetSystem.getActiveNetForArm(0), 'Should find active net for arm 0');
    assert.equal(captureNetSystem.getActiveNetForArm(1), null, 'No net on arm 1');
    teardown();
  });

  it('getActiveNetForPod returns active net or null', () => {
    setup();
    captureNetSystem.fireMotherNet(0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, makeTarget());
    assert.ok(captureNetSystem.getActiveNetForPod(0));
    assert.equal(captureNetSystem.getActiveNetForPod(1), null);
    teardown();
  });

  it('getCapturedNetMass returns 0 when no active net', () => {
    setup();
    assert.equal(captureNetSystem.getCapturedNetMass(0), 0);
    teardown();
  });

  it('getCapturedNetMass returns net+debris mass when captured', () => {
    setup();
    const arm = mockArm('weaver');
    const target = makeTarget(10, 0, 0, 200);
    const net = captureNetSystem.fireDaughterNet(
      arm, 0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, target
    );
    net.forceResolve(true);
    // Net class mass (MEDIUM=0.68) + debris mass (200)
    const expected = CN.MEDIUM.MASS + 200;
    assert.ok(Math.abs(captureNetSystem.getCapturedNetMass(0) - expected) < 0.01,
      `Expected ${expected}, got ${captureNetSystem.getCapturedNetMass(0)}`);
    teardown();
  });

  it('getCooldown returns remaining time', () => {
    setup();
    const net = captureNetSystem.fireMotherNet(
      0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, makeTarget()
    );
    net.forceResolve(true);
    captureNetSystem.update(0.01);
    const cd = captureNetSystem.getCooldown('pod', 0);
    assert.ok(cd > 0, `Cooldown should be positive: ${cd}`);
    teardown();
  });
});


// ══════════════════════════════════════════════════════════════════════════
// PERSISTENCE ROUND-TRIP
// ══════════════════════════════════════════════════════════════════════════

describe('CaptureNet — Persistence', () => {
  let savedFlag;
  const setup = () => {
    savedFlag = Constants.FEATURE_FLAGS.CAPTURE_NET;
    Constants.FEATURE_FLAGS.CAPTURE_NET = true;
    captureNetSystem.reset();
    captureNetSystem.init();
  };
  const teardown = () => {
    Constants.FEATURE_FLAGS.CAPTURE_NET = savedFlag;
    captureNetSystem.reset();
  };

  it('getState() returns serialisable object', () => {
    setup();
    captureNetSystem.fireMotherNet(0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, makeTarget());
    const state = captureNetSystem.getState();
    assert.ok(Array.isArray(state.motherPodInventory));
    assert.equal(state.motherPodInventory[0], 3);
    assert.equal(state.motherPodInventory[1], 4);
    assert.equal(state.playerHasFragmented, false);
    teardown();
  });

  it('restoreState() round-trips mother inventory', () => {
    setup();
    captureNetSystem.fireMotherNet(0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, makeTarget());
    const state = captureNetSystem.getState();

    captureNetSystem.reset();
    captureNetSystem.restoreState(state);
    assert.equal(captureNetSystem.getMotherPodInventory(0), 3);
    assert.equal(captureNetSystem.getMotherPodInventory(1), 4);
    teardown();
  });

  it('restoreState() round-trips playerHasFragmented', () => {
    setup();
    captureNetSystem.handleFragmentation('d1', 3);
    assert.equal(captureNetSystem.playerHasFragmented, true);
    const state = captureNetSystem.getState();

    captureNetSystem.reset();
    assert.equal(captureNetSystem.playerHasFragmented, false);
    captureNetSystem.restoreState(state);
    assert.equal(captureNetSystem.playerHasFragmented, true);
    teardown();
  });

  it('restoreState(null) is a no-op', () => {
    setup();
    captureNetSystem.restoreState(null);
    assert.equal(captureNetSystem.getMotherNetCount(), 8); // unchanged
    teardown();
  });

  it('setMotherPodInventory updates counts directly', () => {
    setup();
    captureNetSystem.setMotherPodInventory([1, 2]);
    assert.equal(captureNetSystem.getMotherPodInventory(0), 1);
    assert.equal(captureNetSystem.getMotherPodInventory(1), 2);
    teardown();
  });
});


// ══════════════════════════════════════════════════════════════════════════
// MERCY RULE (§5.7)
// ══════════════════════════════════════════════════════════════════════════

describe('CaptureNet — Mercy Rule', () => {
  let savedFlag;
  const setup = () => {
    savedFlag = Constants.FEATURE_FLAGS.CAPTURE_NET;
    Constants.FEATURE_FLAGS.CAPTURE_NET = true;
    captureNetSystem.reset();
    captureNetSystem.init();
  };
  const teardown = () => {
    Constants.FEATURE_FLAGS.CAPTURE_NET = savedFlag;
    captureNetSystem.reset();
  };

  it('First fragmentation applies mercy rule', () => {
    setup();
    assert.equal(captureNetSystem.playerHasFragmented, false);
    const mercy = captureNetSystem.handleFragmentation('d1', 3);
    assert.equal(mercy, true, 'First frag should get mercy');
    assert.equal(captureNetSystem.playerHasFragmented, true);
    teardown();
  });

  it('Second fragmentation does NOT apply mercy', () => {
    setup();
    captureNetSystem.handleFragmentation('d1', 2);
    const mercy = captureNetSystem.handleFragmentation('d2', 4);
    assert.equal(mercy, false, 'Second frag should NOT get mercy');
    teardown();
  });

  it('NET_FRAGMENTATION event emitted with mercyApplied flag', () => {
    setup();
    const events = collectEvents(Events.NET_FRAGMENTATION, () => {
      captureNetSystem.handleFragmentation('d1', 3);
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].mercyApplied, true);
    assert.equal(events[0].fragmentCount, 3);

    const events2 = collectEvents(Events.NET_FRAGMENTATION, () => {
      captureNetSystem.handleFragmentation('d2', 1);
    });
    assert.equal(events2[0].mercyApplied, false);
    teardown();
  });
});


// ══════════════════════════════════════════════════════════════════════════
// COM INTEGRATION — captured mass tracking
// ══════════════════════════════════════════════════════════════════════════

describe('CaptureNet — CoM captured mass tracking', () => {
  let savedFlag;
  const setup = () => {
    savedFlag = Constants.FEATURE_FLAGS.CAPTURE_NET;
    Constants.FEATURE_FLAGS.CAPTURE_NET = true;
    captureNetSystem.reset();
    captureNetSystem.init();
  };
  const teardown = () => {
    Constants.FEATURE_FLAGS.CAPTURE_NET = savedFlag;
    captureNetSystem.reset();
  };

  it('No captured mass before fire', () => {
    setup();
    assert.equal(captureNetSystem.getCapturedNetMass(0), 0);
    teardown();
  });

  it('Net mass added during flight (no captured debris yet)', () => {
    setup();
    const arm = mockArm('weaver');
    captureNetSystem.fireDaughterNet(arm, 0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, makeTarget());
    // During LAUNCHING state, no captured mass
    assert.equal(captureNetSystem.getCapturedNetMass(0), 0);
    teardown();
  });

  it('Net + debris mass after capture', () => {
    setup();
    const arm = mockArm('spinner');
    const target = makeTarget(5, 0, 0, 30);
    const net = captureNetSystem.fireDaughterNet(
      arm, 1, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, target
    );
    net.forceResolve(true);
    const expected = CN.SMALL.MASS + 30;
    assert.ok(Math.abs(captureNetSystem.getCapturedNetMass(1) - expected) < 0.01,
      `Expected ${expected}, got ${captureNetSystem.getCapturedNetMass(1)}`);
    teardown();
  });

  it('Mass returns to 0 after release', () => {
    setup();
    const arm = mockArm('weaver');
    const target = makeTarget(5, 0, 0, 100);
    const net = captureNetSystem.fireDaughterNet(
      arm, 0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, target
    );
    net.forceResolve(true);
    assert.ok(captureNetSystem.getCapturedNetMass(0) > 0);
    net.release();
    // After release, net is removed from activeNets on next update
    captureNetSystem.update(0.01);
    assert.equal(captureNetSystem.getCapturedNetMass(0), 0);
    teardown();
  });
});


// ══════════════════════════════════════════════════════════════════════════
// ARM NET INVENTORY (ArmUnit integration)
// ══════════════════════════════════════════════════════════════════════════

describe('CaptureNet — ArmUnit net inventory methods', () => {
  // Test the mock arm pattern (mirrors what ArmUnit now provides via
  // Constants.ARM_NET_CAPACITY — Phase 1 §13 Q5).
  it('mockArm initialises with ARM_NET_CAPACITY (matches real ArmUnit)', () => {
    const w = mockArm('weaver');
    assert.equal(w.getNetInventory(), Constants.ARM_NET_CAPACITY.weaver);
    assert.equal(w.getNetInventory(), 2, 'Weaver = 2 nets per §13 Q5');
    const s = mockArm('spinner');
    assert.equal(s.getNetInventory(), Constants.ARM_NET_CAPACITY.spinner);
    assert.equal(s.getNetInventory(), 2, 'Spinner = 2 nets per §13 Q5');
  });

  it('decrementNetInventory reduces by 1', () => {
    const arm = mockArm('weaver');
    const before = arm.getNetInventory();
    arm.decrementNetInventory();
    assert.equal(arm.getNetInventory(), before - 1);
  });

  it('decrementNetInventory stops at 0', () => {
    const arm = mockArm('weaver', { inventory: 1 });
    arm.decrementNetInventory();
    assert.equal(arm.getNetInventory(), 0);
    arm.decrementNetInventory();
    assert.equal(arm.getNetInventory(), 0);
  });
});


// ══════════════════════════════════════════════════════════════════════════
// FEATURE FLAG GATING
// ══════════════════════════════════════════════════════════════════════════

describe('CaptureNet — Feature flag gating', () => {
  it('All CaptureNetSystem fire methods return null when flag is off', () => {
    Constants.FEATURE_FLAGS.CAPTURE_NET = false;
    captureNetSystem.reset();
    const n1 = captureNetSystem.fireMotherNet(0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, makeTarget());
    const n2 = captureNetSystem.fireDaughterNet(
      mockArm('weaver'), 0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, makeTarget()
    );
    assert.equal(n1, null);
    assert.equal(n2, null);
    assert.equal(captureNetSystem.activeNets.length, 0);
  });

  it('update() silently no-ops when flag is off', () => {
    Constants.FEATURE_FLAGS.CAPTURE_NET = false;
    captureNetSystem.update(1.0); // should not throw
    assert.ok(true, 'No error thrown');
  });

  it('Pure functions work regardless of flag (they are stateless)', () => {
    Constants.FEATURE_FLAGS.CAPTURE_NET = false;
    const p = computeClingProbability({ pBase: 0.9, vRel: 10, vOptimal: 10, range: 50 });
    assert.ok(p > 0, 'computeClingProbability works without flag');
    const f = computeFragRisk({ netMass: 0.5, vRel: 5, targetFragility: 0.1, range: 50 });
    assert.ok(f >= 0, 'computeFragRisk works without flag');
  });
});


// ══════════════════════════════════════════════════════════════════════════
// §3.5 — NET NOT CONSUMED ON MISS (inventory restoration)
// ══════════════════════════════════════════════════════════════════════════

describe('CaptureNet — §3.5: Miss reel-back restores inventory', () => {
  let savedFlag;
  const setup = () => {
    savedFlag = Constants.FEATURE_FLAGS.CAPTURE_NET;
    Constants.FEATURE_FLAGS.CAPTURE_NET = true;
    captureNetSystem.reset();
    captureNetSystem.init();
  };
  const teardown = () => {
    Constants.FEATURE_FLAGS.CAPTURE_NET = savedFlag;
    captureNetSystem.reset();
  };

  it('Mother pod inventory restores after miss + reel-back', () => {
    setup();
    assert.equal(captureNetSystem.getMotherPodInventory(0), 4);
    const net = captureNetSystem.fireMotherNet(
      0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, makeTarget()
    );
    assert.equal(captureNetSystem.getMotherPodInventory(0), 3, 'Depleted on fire');
    // Force a miss + reel back
    net.forceResolve(false);
    net.tetherPaidOut = 1;
    // Update until net is removed (stowed)
    for (let i = 0; i < 200; i++) captureNetSystem.update(0.1);
    assert.equal(captureNetSystem.getMotherPodInventory(0), 4, 'Restored after miss reel-back');
    teardown();
  });

  it('Daughter arm inventory restores after miss + reel-back', () => {
    setup();
    const arm = mockArm('weaver');
    assert.equal(arm.getNetInventory(), 2);
    const net = captureNetSystem.fireDaughterNet(
      arm, 0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, makeTarget()
    );
    assert.equal(arm.getNetInventory(), 1, 'Depleted on fire');
    // Force a miss + reel back
    net.forceResolve(false);
    net.tetherPaidOut = 1;
    for (let i = 0; i < 200; i++) captureNetSystem.update(0.1);
    assert.equal(arm.getNetInventory(), 2, 'Restored after miss reel-back');
    teardown();
  });

  it('Inventory NOT restored on successful capture', () => {
    setup();
    assert.equal(captureNetSystem.getMotherPodInventory(0), 4);
    const net = captureNetSystem.fireMotherNet(
      0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, makeTarget()
    );
    net.forceResolve(true);
    net.tetherPaidOut = 1;
    for (let i = 0; i < 200; i++) captureNetSystem.update(0.1);
    assert.equal(captureNetSystem.getMotherPodInventory(0), 3, 'NOT restored on success');
    teardown();
  });

  it('Inventory NOT restored on release (net is lost)', () => {
    setup();
    const net = captureNetSystem.fireMotherNet(
      0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, makeTarget()
    );
    assert.equal(captureNetSystem.getMotherPodInventory(0), 3);
    net.forceResolve(true);
    net.release(); // abort → net lost
    captureNetSystem.update(0.1);
    assert.equal(captureNetSystem.getMotherPodInventory(0), 3, 'NOT restored on release');
    teardown();
  });
});


// ══════════════════════════════════════════════════════════════════════════
// ST-9.4d — CARGO HAND-OFF EVENT
// ══════════════════════════════════════════════════════════════════════════

describe('CaptureNet — ST-9.4d: Cargo hand-off', () => {
  let savedFlag;
  const setup = () => {
    savedFlag = Constants.FEATURE_FLAGS.CAPTURE_NET;
    Constants.FEATURE_FLAGS.CAPTURE_NET = true;
    captureNetSystem.reset();
    captureNetSystem.init();
  };
  const teardown = () => {
    Constants.FEATURE_FLAGS.CAPTURE_NET = savedFlag;
    captureNetSystem.reset();
  };

  it('CARGO_STORE emitted when captured net reels to STOWED', () => {
    setup();
    const target = makeTarget(10, 0, 0, 150, { id: 'cargo-target' });
    const net = captureNetSystem.fireMotherNet(
      0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, target
    );
    net.forceResolve(true);
    net.tetherPaidOut = 1;

    const events = [];
    const handler = (d) => events.push(d);
    eventBus.on(Events.CARGO_STORE, handler);
    for (let i = 0; i < 200; i++) captureNetSystem.update(0.1);
    eventBus.off(Events.CARGO_STORE, handler);

    assert.equal(events.length, 1, 'Should emit exactly 1 CARGO_STORE');
    assert.equal(events[0].debrisId, 'cargo-target');
    assert.equal(events[0].mass, 150);
    assert.equal(events[0].netCapture, true);
    teardown();
  });

  it('CARGO_STORE NOT emitted on miss reel', () => {
    setup();
    const net = captureNetSystem.fireMotherNet(
      0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, makeTarget()
    );
    net.forceResolve(false);
    net.tetherPaidOut = 1;

    const events = [];
    const handler = (d) => events.push(d);
    eventBus.on(Events.CARGO_STORE, handler);
    for (let i = 0; i < 200; i++) captureNetSystem.update(0.1);
    eventBus.off(Events.CARGO_STORE, handler);

    assert.equal(events.length, 0, 'No CARGO_STORE on miss');
    teardown();
  });
});


// ══════════════════════════════════════════════════════════════════════════
// NET INVENTORY QUERY EDGE CASES
// ══════════════════════════════════════════════════════════════════════════

describe('CaptureNet — Inventory edge cases', () => {
  let savedFlag;
  const setup = () => {
    savedFlag = Constants.FEATURE_FLAGS.CAPTURE_NET;
    Constants.FEATURE_FLAGS.CAPTURE_NET = true;
    captureNetSystem.reset();
    captureNetSystem.init();
  };
  const teardown = () => {
    Constants.FEATURE_FLAGS.CAPTURE_NET = savedFlag;
    captureNetSystem.reset();
  };

  it('Invalid pod index returns 0 for inventory', () => {
    setup();
    assert.equal(captureNetSystem.getMotherPodInventory(5), 0);
    assert.equal(captureNetSystem.getMotherPodInventory(-1), 0);
    teardown();
  });

  it('Invalid pod index rejects fire', () => {
    setup();
    const net = captureNetSystem.fireMotherNet(
      3, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, makeTarget()
    );
    assert.equal(net, null);
    teardown();
  });

  it('Both pods can fire independently', () => {
    setup();
    const n0 = captureNetSystem.fireMotherNet(0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, null);
    const n1 = captureNetSystem.fireMotherNet(1, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, null);
    assert.ok(n0, 'Pod 0 should fire');
    assert.ok(n1, 'Pod 1 should fire');
    assert.equal(captureNetSystem.getMotherPodInventory(0), 3);
    assert.equal(captureNetSystem.getMotherPodInventory(1), 3);
    teardown();
  });

  it('Auto-recommend: cinch mode for solar panel target', () => {
    setup();
    const target = makeTarget(10, 0, 0, 100, { hasSolarPanels: true });
    const net = captureNetSystem.fireMotherNet(
      0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, target
    );
    assert.equal(net.captureMode, 'CINCH', 'Should auto-select CINCH for solar panel target');
    teardown();
  });

  it('Explicit mode overrides auto-recommend', () => {
    setup();
    const target = makeTarget(10, 0, 0, 100, { hasSolarPanels: true });
    const net = captureNetSystem.fireMotherNet(
      0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, target, 'SLAM_WRAP'
    );
    assert.equal(net.captureMode, 'SLAM_WRAP', 'Explicit mode should win');
    teardown();
  });
});


// ══════════════════════════════════════════════════════════════════════════
// 2026-05-25 — Q2 NET CEREMONY: FSM-vs-beat alignment regression
// ══════════════════════════════════════════════════════════════════════════
// Problem captured from a live browser ceremony (CEREMONY_REDESIGN.md §4):
//   - User fires net at a durable target → recommendCaptureMode picks SLAM_WRAP
//   - SLAM_WRAP physics path is CONTACT(0.5s) → SECURE_CHECK(0.2s) → CAPTURED,
//     skipping ENVELOP and CINCH_CLOSING states entirely.
//   - Camera beats BRAKE_ENVELOP and CINCH (see BEAT_DURATIONS_S) frame those
//     FSM states, but in SLAM_WRAP they never occur — so the user watches a static cone
//     in CAPTURED/REELING state, with no engulf or cinch animation rendered.
// Fix: when FEATURE_FLAGS.NET_CEREMONY is on AND caller did not pass an
//   explicit `mode`, force CINCH so the FSM traverses BRAKE→ENVELOP→
//   CINCH_CLOSING and the ceremony has the animations to show. Caller-supplied
//   `mode` is still honoured (explicit > ceremony override > auto-recommend).
describe('CaptureNet — Q2 ceremony alignment: captureMode forced to CINCH', () => {
  let savedCaptureFlag, savedCeremonyFlag;
  const setup = (ceremonyOn) => {
    savedCaptureFlag  = Constants.FEATURE_FLAGS.CAPTURE_NET;
    savedCeremonyFlag = Constants.FEATURE_FLAGS.NET_CEREMONY;
    Constants.FEATURE_FLAGS.CAPTURE_NET  = true;
    Constants.FEATURE_FLAGS.NET_CEREMONY = !!ceremonyOn;
    captureNetSystem.reset();
    captureNetSystem.init();
  };
  const teardown = () => {
    Constants.FEATURE_FLAGS.CAPTURE_NET  = savedCaptureFlag;
    Constants.FEATURE_FLAGS.NET_CEREMONY = savedCeremonyFlag;
    captureNetSystem.reset();
  };

  // Durable metal target — recommendCaptureMode (CaptureNet.js:130) returns
  // SLAM_WRAP for (no solar panels, vRel<5, surfaceRoughness>=0.5).
  const durableTarget = () => makeTarget(10, 0, 0, 100, {
    hasSolarPanels: false,
    vRel: 2,
    surfaceRoughness: 1.0,
  });

  it('CEREMONY OFF: durable target still resolves to SLAM_WRAP (no override)', () => {
    setup(false);
    // Sanity: recommendCaptureMode picks SLAM_WRAP for this target.
    assert.equal(recommendCaptureMode({ hasSolarPanels: false, vRel: 2, surfaceRoughness: 1.0 }),
      MODES.SLAM_WRAP, 'pre-check: durable target should recommend SLAM_WRAP');

    const motherNet = captureNetSystem.fireMotherNet(
      0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, durableTarget()
    );
    assert.equal(motherNet.captureMode, MODES.SLAM_WRAP,
      'mother pod: with ceremony OFF, durable target keeps SLAM_WRAP recommendation');

    const arm = mockArm('weaver');
    const daughterNet = captureNetSystem.fireDaughterNet(
      arm, 0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, durableTarget()
    );
    assert.equal(daughterNet.captureMode, MODES.SLAM_WRAP,
      'daughter arm: with ceremony OFF, durable target keeps SLAM_WRAP recommendation');
    teardown();
  });

  it('CEREMONY ON: durable target is FORCED to CINCH (mother pod)', () => {
    setup(true);
    const net = captureNetSystem.fireMotherNet(
      0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, durableTarget()
    );
    assert.equal(net.captureMode, MODES.CINCH,
      'mother pod: with ceremony ON, SLAM_WRAP recommendation must be overridden to CINCH ' +
      'so beats 5–6 (BRAKE_ENVELOP, CINCH) have FSM states to render');
    teardown();
  });

  it('CEREMONY ON: durable target is FORCED to CINCH (daughter arms — weaver + spinner)', () => {
    setup(true);
    const armW = mockArm('weaver');
    const netW = captureNetSystem.fireDaughterNet(
      armW, 0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, durableTarget()
    );
    assert.equal(netW.captureMode, MODES.CINCH,
      'weaver arm: with ceremony ON, durable target must be forced to CINCH');

    const armS = mockArm('spinner');
    const netS = captureNetSystem.fireDaughterNet(
      armS, 1, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, durableTarget()
    );
    assert.equal(netS.captureMode, MODES.CINCH,
      'spinner arm: with ceremony ON, durable target must be forced to CINCH');
    teardown();
  });

  it('CEREMONY ON: explicit caller-supplied mode still wins over the ceremony override', () => {
    setup(true);
    // If a caller (test, future explicit-mode UI) passes SLAM_WRAP explicitly,
    // we must NOT silently rewrite it. Ceremony override applies only to the
    // auto-recommend path.
    const netM = captureNetSystem.fireMotherNet(
      0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, durableTarget(), MODES.SLAM_WRAP
    );
    assert.equal(netM.captureMode, MODES.SLAM_WRAP,
      'mother pod: explicit SLAM_WRAP must be honoured even when ceremony is on');

    const armW = mockArm('weaver');
    const netW = captureNetSystem.fireDaughterNet(
      armW, 0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, durableTarget(), MODES.SLAM_WRAP
    );
    assert.equal(netW.captureMode, MODES.SLAM_WRAP,
      'daughter arm: explicit SLAM_WRAP must be honoured even when ceremony is on');
    teardown();
  });

  it('CEREMONY ON: CINCH-recommended target stays CINCH (no double-flip)', () => {
    setup(true);
    // Solar-panel target → recommendCaptureMode returns CINCH anyway.
    const target = makeTarget(10, 0, 0, 100, { hasSolarPanels: true });
    const net = captureNetSystem.fireMotherNet(
      0, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, target
    );
    assert.equal(net.captureMode, MODES.CINCH,
      'CINCH recommendation passes through unchanged when ceremony is on');
    teardown();
  });
});


// ══════════════════════════════════════════════════════════════════════════
// 2026-05-25 — Q2 NET CEREMONY: "net DISAPPEARS" visual-drift regression
// ══════════════════════════════════════════════════════════════════════════
// Bug (browser-reported):
//   Camera tracks `arm.position + launchDir × distance × M` every frame
//   (CameraSystem._computeNetScenePos). The visual reads `net.position × M`
//   and places the cone group there every frame (CaptureNetVisual.update,
//   line 484). `_updateFlight` updates `net.position` from the arm — but
//   `_updateContact/Brake/Envelop/CinchClosing/SecureCheck` do NOT. After
//   contact, the visual freezes at the arm's position-at-contact while the
//   arm keeps orbiting at ~7 km/s. Camera and visual diverge → cone VANISHES
//   off-frame within ~1 s.
// Fix (CaptureNet.js, NetProjectile.update):
//   Continuously sync `this.position` to arm's current scene position during
//   CONTACT/BRAKE/ENVELOP/CINCH_CLOSING/SECURE_CHECK. FLIGHT already does
//   this; REELING has its own logic.
describe('CaptureNet — Q2 ceremony: net.position tracks arm during post-contact states', () => {
  // Construct a minimal NetProjectile attached to a mock arm. We then write
  // the state directly and call update() so we don't have to drive the FSM
  // through real timings (which mutate stateTimer and trigger transitions).
  const M_NET = 0.00001;
  function makeArmedNet(state, opts = {}) {
    const arm = {
      // Scene-units position (THREE.Vector3-like). LEO arm is ~6.4e6 m
      // from Earth centre → scene position ≈ 64 scene units.
      position: { x: 64, y: 0, z: 0 },
    };
    const net = new NetProjectile({
      netClass: CN.MEDIUM,
      armIndex: 0,
      podIndex: -1,
      launchPosition: { x: 6400000, y: 0, z: 0 },  // 6.4e6 m = 64 / M_NET
      launchDirection: { x: 1, y: 0, z: 0 },
      targetDebris: null,
      captureMode: MODES.CINCH,
      sourceArm: arm,
    });
    net.state = state;
    net.stateTimer = 0.0;
    net.distanceTraveled = opts.distanceTraveled ?? 8;  // 8 m flight, typical SK contact
    // Force initial sync (mimics what _updateFlight would have done on entry).
    net.position.x = arm.position.x / M_NET + net.launchDirection.x * net.distanceTraveled;
    net.position.y = arm.position.y / M_NET + net.launchDirection.y * net.distanceTraveled;
    net.position.z = arm.position.z / M_NET + net.launchDirection.z * net.distanceTraveled;
    return { net, arm };
  }

  // The 5 post-FLIGHT pre-REELING states that must keep position synced.
  const POST_FLIGHT_STATES = [
    STATES.CONTACT,
    STATES.BRAKE,
    STATES.ENVELOP,
    STATES.CINCH_CLOSING,
    STATES.SECURE_CHECK,
  ];

  for (const state of POST_FLIGHT_STATES) {
    it(`tracks arm during ${state} (no visual drift while orbital frame moves)`, () => {
      const { net, arm } = makeArmedNet(state);

      // Initial position before drift.
      const x0 = net.position.x;
      const y0 = net.position.y;
      const z0 = net.position.z;

      // Simulate the arm orbiting forward by ~70 km (≈ 1 s at LEO 7 km/s) — same
      // ballpark as the wall-clock window of a single ceremony beat. In scene
      // units (1 unit = 100 km), that's 0.7 scene units.
      arm.position.x += 0.7;   // scene units
      arm.position.y += 0.1;
      arm.position.z -= 0.2;

      // Tick the net once with a small dt. We deliberately keep dt tiny so the
      // state doesn't transition (e.g. BRAKE_TIME = 0.5 s); we just need the
      // position update path to fire.
      net.update(0.001);

      // Net position (metres) must reflect the new arm position. Tolerance
      // 1e-6 m to absorb floating-point round-trip through M_NET.
      const expectedX = arm.position.x / M_NET + net.launchDirection.x * net.distanceTraveled;
      const expectedY = arm.position.y / M_NET + net.launchDirection.y * net.distanceTraveled;
      const expectedZ = arm.position.z / M_NET + net.launchDirection.z * net.distanceTraveled;

      const dx = net.position.x - expectedX;
      const dy = net.position.y - expectedY;
      const dz = net.position.z - expectedZ;
      assert.ok(Math.abs(dx) < 1e-3 && Math.abs(dy) < 1e-3 && Math.abs(dz) < 1e-3,
        `${state}: net.position must equal arm.position/M + launchDir × dist; ` +
        `got drift (${dx.toExponential(2)}, ${dy.toExponential(2)}, ${dz.toExponential(2)}) metres`);

      // Sanity: position MUST have moved from the initial value (would have
      // stayed put under the old buggy code).
      const moved = Math.hypot(net.position.x - x0, net.position.y - y0, net.position.z - z0);
      assert.ok(moved > 1000,
        `${state}: net.position must move with the arm (≥ 1000 m for a 70 km arm shift); ` +
        `moved only ${moved.toFixed(1)} m — the old buggy code would have moved 0 m here`);
    });
  }

  // 2026-05-28 (Item 2 fix): REELING used to skip the position-sync block
  // entirely, so net.position froze at the orbital-frame contact location
  // while the arm orbited away at 7 km/s.  The visual disappeared the moment
  // REELING began.  Now REELING tracks the arm AND blends the effective
  // launch distance from `tetherPaidOut → 0` as `reelProgress` advances 0→1.
  it('REELING at progress=0 tracks arm with full tether distance', () => {
    const { net, arm } = makeArmedNet(STATES.REELING);
    net.tetherPaidOut = 8;        // contact distance (matches distanceTraveled)
    net.reelProgress = 0;

    arm.position.x += 0.7;        // shift arm one beat of orbital travel
    net.update(0.001);

    const expectedX = arm.position.x / M_NET + net.launchDirection.x * 8;
    assert.ok(Math.abs(net.position.x - expectedX) < 1e-3,
      `REELING progress=0: position must equal arm.position/M + launchDir × tetherPaidOut; ` +
      `got ${net.position.x.toExponential(3)} vs expected ${expectedX.toExponential(3)}`);
  });

  it('REELING at progress=0.5 places net halfway between arm and contact', () => {
    const { net, arm } = makeArmedNet(STATES.REELING);
    net.tetherPaidOut = 8;
    net.reelProgress = 0.5;       // halfway reeled

    arm.position.x += 0.7;
    net.update(0.001);

    const expectedEff = 8 * 0.5;
    const expectedX = arm.position.x / M_NET + net.launchDirection.x * expectedEff;
    assert.ok(Math.abs(net.position.x - expectedX) < 1e-3,
      `REELING progress=0.5: effective distance must be tetherPaidOut × 0.5 = 4 m; ` +
      `got x=${net.position.x.toExponential(3)} vs expected ${expectedX.toExponential(3)}`);
  });

  it('REELING at progress=1.0 places net at arm (rendezvous)', () => {
    const { net, arm } = makeArmedNet(STATES.REELING);
    net.tetherPaidOut = 8;
    net.reelProgress = 1.0;       // fully reeled

    arm.position.x += 0.7;
    net.update(0.001);

    const expectedX = arm.position.x / M_NET;
    assert.ok(Math.abs(net.position.x - expectedX) < 1e-3,
      `REELING progress=1: net must rendezvous with the arm (eff=0); ` +
      `got x=${net.position.x.toExponential(3)} vs expected ${expectedX.toExponential(3)}`);
  });

  it('REELING tracks arm orbital motion (no orbital-frame freeze)', () => {
    // Regression guard for the original Item 2 bug: net.position froze at
    // the original contact location while the arm continued co-orbiting at
    // ~7 km/s.  This test asserts that a non-trivial arm shift propagates
    // into the net position so the visual stays in-frame.
    const { net, arm } = makeArmedNet(STATES.REELING);
    net.tetherPaidOut = 8;
    net.reelProgress = 0.3;
    const x0 = net.position.x;

    arm.position.x += 0.7;        // 70 km arm shift in scene units
    net.update(0.001);

    const moved = Math.abs(net.position.x - x0);
    assert.ok(moved > 1000,
      `REELING net must move with the arm (≥ 1000 m for a 70 km arm shift); ` +
      `moved only ${moved.toFixed(1)} m — the pre-fix code would have moved 0 m here`);
  });

  it('LAUNCHING and SPINNING_UP are NOT affected (pre-FLIGHT, position at launchPosition)', () => {
    // These states should preserve the launchPosition until FLIGHT begins.
    for (const s of [STATES.LAUNCHING, STATES.SPINNING_UP]) {
      const { net, arm } = makeArmedNet(s, { distanceTraveled: 0 });
      const x0 = net.position.x;
      arm.position.x += 0.7;
      net.update(0.001);
      // distanceTraveled is 0, so even the buggy code's "missing sync" wouldn't
      // matter here. Just confirm no spurious huge changes.
      assert.ok(Math.abs(net.position.x - x0) < 1e3,  // < 1 km drift
        `${s}: should not be impacted by post-FLIGHT sync (small drift only); got ${(net.position.x - x0).toFixed(2)} m`);
    }
  });
});
