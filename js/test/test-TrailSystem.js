/**
 * test-TrailSystem.js — ST-5.2 TrailSystem pure-function tests
 * Tests ring buffer math, colour classification by prograde dot,
 * fade alpha curve, arm lifecycle state processing, sample-rate gating,
 * and reel-trim advancement.
 *
 * Functions are copied from TrailSystem.js since that module imports THREE.js
 * (unavailable in Node). Tests validate the algorithms, not the import path.
 * @module test/test-TrailSystem
 */

import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';
import { Events } from '../core/Events.js';

// ============================================================================
// ALGORITHM COPIES (mirror TrailSystem.js module-level helpers exactly)
// ============================================================================

function classifyColorByProgradeDot(dot, threshold) {
  if (dot > threshold) return 'prograde';
  if (dot < -threshold) return 'retrograde';
  return 'normal';
}

function computeFadeAlpha(indexFromOldest, totalCount, minAlpha) {
  if (totalCount <= 1) return 1.0;
  const t = indexFromOldest / (totalCount - 1);
  return minAlpha + t * (1.0 - minAlpha);
}

function advanceRingBuffer(head, count, capacity) {
  const newHead = (head + 1) % capacity;
  const newCount = Math.min(count + 1, capacity);
  return { head: newHead, count: newCount };
}

function sampleRateGate(accum, dt, hz) {
  accum += dt;
  const interval = 1 / hz;
  const shouldSample = accum >= interval;
  if (shouldSample) accum -= interval;
  return { accum, shouldSample };
}

function processArmStateChange(newState, trimOffset, count) {
  if (newState === 'REELING') {
    return { isReeling: true, trimOffset, count, cleared: false };
  } else if (newState === 'DOCKED' || newState === 'RELOADING') {
    return { isReeling: false, trimOffset: 0, count: 0, cleared: true };
  }
  return { isReeling: false, trimOffset: 0, count, cleared: false };
}

function updateReelTrim(trimOffset, count, dt, trimRate) {
  if (count <= 0) return trimOffset;
  return Math.min(trimOffset + trimRate * dt, count);
}

// ============================================================================
// TESTS
// ============================================================================

// --------------------------------------------------------------------------
// Ring Buffer
// --------------------------------------------------------------------------

describe('TrailSystem — advanceRingBuffer', () => {
  it('increments head and count from empty', () => {
    const r = advanceRingBuffer(0, 0, 10);
    assert.equal(r.head, 1);
    assert.equal(r.count, 1);
  });

  it('increments head and count mid-fill', () => {
    const r = advanceRingBuffer(4, 4, 10);
    assert.equal(r.head, 5);
    assert.equal(r.count, 5);
  });

  it('wraps head at capacity', () => {
    const r = advanceRingBuffer(9, 10, 10);
    assert.equal(r.head, 0);
    assert.equal(r.count, 10); // stays at capacity
  });

  it('count clamps at capacity', () => {
    const r = advanceRingBuffer(3, 10, 10);
    assert.equal(r.count, 10); // already full, stays at 10
  });

  it('wrapping overwrites oldest sample', () => {
    // Simulate filling a capacity-5 buffer with 7 pushes
    let head = 0, count = 0;
    const cap = 5;
    const buf = new Array(cap);
    for (let i = 0; i < 7; i++) {
      buf[head] = i;
      const adv = advanceRingBuffer(head, count, cap);
      head = adv.head;
      count = adv.count;
    }
    assert.equal(count, 5);
    assert.equal(head, 2); // wrapped: 7 % 5 = 2
    // Oldest value should be at index 2 (head), which is 2
    // Buffer should contain [5, 6, 2, 3, 4] — wait, let me trace:
    // i=0: buf[0]=0, head→1, count→1
    // i=1: buf[1]=1, head→2, count→2
    // i=2: buf[2]=2, head→3, count→3
    // i=3: buf[3]=3, head→4, count→4
    // i=4: buf[4]=4, head→0, count→5
    // i=5: buf[0]=5, head→1, count→5
    // i=6: buf[1]=6, head→2, count→5
    // So buf = [5, 6, 2, 3, 4], head=2, oldest at index 2 = value 2
    assert.equal(buf[0], 5);
    assert.equal(buf[1], 6);
    assert.equal(buf[2], 2); // oldest surviving sample
    assert.equal(buf[3], 3);
    assert.equal(buf[4], 4);
  });

  it('capacity-1 buffer works (minimal)', () => {
    const r1 = advanceRingBuffer(0, 0, 1);
    assert.equal(r1.head, 0); // wraps immediately
    assert.equal(r1.count, 1);
    const r2 = advanceRingBuffer(0, 1, 1);
    assert.equal(r2.head, 0);
    assert.equal(r2.count, 1);
  });
});

// --------------------------------------------------------------------------
// Colour Classification
// --------------------------------------------------------------------------

describe('TrailSystem — classifyColorByProgradeDot', () => {
  it('returns prograde when dot > threshold', () => {
    assert.equal(classifyColorByProgradeDot(0.8, 0.7), 'prograde');
  });

  it('returns retrograde when dot < -threshold', () => {
    assert.equal(classifyColorByProgradeDot(-0.8, 0.7), 'retrograde');
  });

  it('returns normal when dot is near zero', () => {
    assert.equal(classifyColorByProgradeDot(0.0, 0.7), 'normal');
  });

  it('returns normal at exact positive threshold', () => {
    assert.equal(classifyColorByProgradeDot(0.7, 0.7), 'normal');
  });

  it('returns normal at exact negative threshold', () => {
    assert.equal(classifyColorByProgradeDot(-0.7, 0.7), 'normal');
  });

  it('returns prograde just above threshold', () => {
    assert.equal(classifyColorByProgradeDot(0.701, 0.7), 'prograde');
  });

  it('returns retrograde just below negative threshold', () => {
    assert.equal(classifyColorByProgradeDot(-0.701, 0.7), 'retrograde');
  });

  it('returns normal for values between thresholds', () => {
    assert.equal(classifyColorByProgradeDot(0.5, 0.7), 'normal');
    assert.equal(classifyColorByProgradeDot(-0.3, 0.7), 'normal');
    assert.equal(classifyColorByProgradeDot(0.69, 0.7), 'normal');
  });

  it('works with threshold = 0 (everything is prograde or retrograde)', () => {
    assert.equal(classifyColorByProgradeDot(0.1, 0), 'prograde');
    assert.equal(classifyColorByProgradeDot(-0.1, 0), 'retrograde');
    assert.equal(classifyColorByProgradeDot(0.0, 0), 'normal');
  });
});

// --------------------------------------------------------------------------
// Fade Alpha Curve
// --------------------------------------------------------------------------

describe('TrailSystem — computeFadeAlpha', () => {
  it('returns minAlpha for oldest point (index 0)', () => {
    const a = computeFadeAlpha(0, 900, 0.05);
    assert.ok(Math.abs(a - 0.05) < 1e-6, `expected 0.05, got ${a}`);
  });

  it('returns 1.0 for newest point (index = count - 1)', () => {
    const a = computeFadeAlpha(899, 900, 0.05);
    assert.ok(Math.abs(a - 1.0) < 1e-6, `expected 1.0, got ${a}`);
  });

  it('returns 1.0 for single-sample buffer', () => {
    assert.ok(Math.abs(computeFadeAlpha(0, 1, 0.05) - 1.0) < 1e-6);
  });

  it('is monotonically increasing', () => {
    let prev = 0;
    for (let i = 0; i < 100; i++) {
      const a = computeFadeAlpha(i, 100, 0.05);
      assert.ok(a >= prev, `alpha at ${i} (${a}) should be >= alpha at ${i - 1} (${prev})`);
      prev = a;
    }
  });

  it('midpoint is approximately halfway between min and 1.0', () => {
    const a = computeFadeAlpha(50, 101, 0.0);
    assert.ok(Math.abs(a - 0.5) < 0.01, `expected ~0.5, got ${a}`);
  });

  it('minAlpha = 0 gives range [0, 1]', () => {
    assert.ok(Math.abs(computeFadeAlpha(0, 10, 0.0)) < 1e-6);
    assert.ok(Math.abs(computeFadeAlpha(9, 10, 0.0) - 1.0) < 1e-6);
  });

  it('minAlpha = 1 gives constant 1.0', () => {
    assert.ok(Math.abs(computeFadeAlpha(0, 10, 1.0) - 1.0) < 1e-6);
    assert.ok(Math.abs(computeFadeAlpha(5, 10, 1.0) - 1.0) < 1e-6);
  });
});

// --------------------------------------------------------------------------
// Sample-Rate Gating
// --------------------------------------------------------------------------

describe('TrailSystem — sampleRateGate', () => {
  it('does not sample when accumulator < interval', () => {
    const r = sampleRateGate(0, 0.05, 10); // need 0.1, only 0.05
    assert.equal(r.shouldSample, false);
    assert.ok(Math.abs(r.accum - 0.05) < 1e-9);
  });

  it('samples when accumulator reaches interval', () => {
    const r = sampleRateGate(0.05, 0.05, 10); // 0.05 + 0.05 = 0.10
    assert.equal(r.shouldSample, true);
    assert.ok(Math.abs(r.accum) < 1e-9, `expected ~0, got ${r.accum}`);
  });

  it('samples when accumulator exceeds interval', () => {
    const r = sampleRateGate(0, 0.15, 10); // 0.15 > 0.10
    assert.equal(r.shouldSample, true);
    assert.ok(Math.abs(r.accum - 0.05) < 1e-9);
  });

  it('at dt=0.05, hz=10, expects sample every 2 ticks', () => {
    let accum = 0;
    let samples = 0;
    for (let tick = 0; tick < 10; tick++) {
      const r = sampleRateGate(accum, 0.05, 10);
      accum = r.accum;
      if (r.shouldSample) samples++;
    }
    // 10 ticks × 0.05 = 0.5s. At 10 Hz, expect 5 samples
    assert.equal(samples, 5);
  });

  it('at dt=1/60, hz=10, produces ~10 samples per second (±1 float drift)', () => {
    let accum = 0;
    let samples = 0;
    const dt = 1 / 60; // 60 fps
    for (let tick = 0; tick < 60; tick++) {
      const r = sampleRateGate(accum, dt, 10);
      accum = r.accum;
      if (r.shouldSample) samples++;
    }
    // 60 frames × (1/60)s = 1.0s. At 10 Hz, expect ~10 samples.
    // Floating-point accumulation of 1/60 may lose an LSB, yielding 9.
    assert.ok(samples >= 9 && samples <= 10,
      `expected 9-10 samples, got ${samples}`);
  });
});

// --------------------------------------------------------------------------
// Arm Lifecycle (state transitions)
// --------------------------------------------------------------------------

describe('TrailSystem — processArmStateChange', () => {
  it('REELING sets isReeling=true, preserves count', () => {
    const r = processArmStateChange('REELING', 0, 200);
    assert.equal(r.isReeling, true);
    assert.equal(r.count, 200);
    assert.equal(r.cleared, false);
  });

  it('DOCKED clears buffer', () => {
    const r = processArmStateChange('DOCKED', 50, 200);
    assert.equal(r.isReeling, false);
    assert.equal(r.count, 0);
    assert.equal(r.trimOffset, 0);
    assert.equal(r.cleared, true);
  });

  it('RELOADING clears buffer', () => {
    const r = processArmStateChange('RELOADING', 10, 150);
    assert.equal(r.isReeling, false);
    assert.equal(r.count, 0);
    assert.equal(r.cleared, true);
  });

  it('TRANSIT preserves count and resets reeling', () => {
    const r = processArmStateChange('TRANSIT', 0, 100);
    assert.equal(r.isReeling, false);
    assert.equal(r.count, 100);
    assert.equal(r.cleared, false);
  });

  it('APPROACH preserves count and resets reeling', () => {
    const r = processArmStateChange('APPROACH', 5, 80);
    assert.equal(r.isReeling, false);
    assert.equal(r.count, 80);
    assert.equal(r.cleared, false);
  });

  it('full lifecycle: DEPLOYED → sampling → REELING → shortens → DOCKED → clears', () => {
    // 1. TRANSIT (arm is deployed and moving)
    let state = processArmStateChange('TRANSIT', 0, 0);
    assert.equal(state.isReeling, false);
    assert.equal(state.count, 0);

    // Simulate adding 100 samples
    let count = 100;

    // 2. REELING begins
    state = processArmStateChange('REELING', 0, count);
    assert.equal(state.isReeling, true);
    assert.equal(state.count, 100);

    // 3. Simulate trim advancing
    let trimOffset = 0;
    for (let i = 0; i < 5; i++) {
      trimOffset = updateReelTrim(trimOffset, count, 0.1, 20); // 20 pts/s × 0.1s = 2 pts/tick
    }
    assert.ok(trimOffset > 0, 'trimOffset should increase');
    assert.ok(trimOffset <= count, 'trimOffset should not exceed count');
    const expectedTrim = 20 * 0.5; // 5 × 0.1s × 20/s = 10
    assert.ok(Math.abs(trimOffset - expectedTrim) < 0.01, `expected ~${expectedTrim}, got ${trimOffset}`);

    // 4. DOCKED clears everything
    state = processArmStateChange('DOCKED', trimOffset, count);
    assert.equal(state.count, 0);
    assert.equal(state.trimOffset, 0);
    assert.equal(state.isReeling, false);
    assert.equal(state.cleared, true);
  });
});

// --------------------------------------------------------------------------
// Reel Trim
// --------------------------------------------------------------------------

describe('TrailSystem — updateReelTrim', () => {
  it('advances trim by trimRate × dt', () => {
    const t = updateReelTrim(0, 100, 0.5, 20);
    assert.ok(Math.abs(t - 10) < 1e-6); // 20 * 0.5 = 10
  });

  it('clamps trim at count', () => {
    const t = updateReelTrim(95, 100, 1.0, 20);
    assert.equal(t, 100); // 95 + 20 = 115, clamped to 100
  });

  it('returns existing offset when count is 0', () => {
    const t = updateReelTrim(5, 0, 1.0, 20);
    assert.equal(t, 5); // no change when empty
  });

  it('accumulates over multiple calls', () => {
    let trim = 0;
    for (let i = 0; i < 10; i++) {
      trim = updateReelTrim(trim, 200, 0.1, 10); // +1 per call
    }
    assert.ok(Math.abs(trim - 10) < 1e-6); // 10 × (10 × 0.1) = 10
  });
});

// --------------------------------------------------------------------------
// Constants.TRAILS ST-5.2 entries
// --------------------------------------------------------------------------

describe('TrailSystem — Constants.TRAILS ST-5.2 entries', () => {
  const T = Constants.TRAILS;

  it('TRAILS namespace exists', () => {
    assert.ok(T, 'Constants.TRAILS must exist');
  });

  it('SAMPLE_RATE_HZ is 10', () => {
    assert.equal(T.SAMPLE_RATE_HZ, 10);
  });

  it('MOTHER_BUFFER_SECONDS is 90', () => {
    assert.equal(T.MOTHER_BUFFER_SECONDS, 90);
  });

  it('ARM_BUFFER_SECONDS is 30', () => {
    assert.equal(T.ARM_BUFFER_SECONDS, 30);
  });

  it('PROGRADE_DOT_THRESHOLD is 0.7', () => {
    assert.equal(T.PROGRADE_DOT_THRESHOLD, 0.7);
  });

  it('RETROGRADE_DOT_THRESHOLD is -0.7', () => {
    assert.equal(T.RETROGRADE_DOT_THRESHOLD, -0.7);
  });

  it('FADE_ALPHA_MIN is 0.05', () => {
    assert.equal(T.FADE_ALPHA_MIN, 0.05);
  });

  it('BASE_WIDTH_METRES is 5', () => {
    assert.equal(T.BASE_WIDTH_METRES, 5);
  });

  it('ENABLED is a boolean', () => {
    assert.equal(typeof T.ENABLED, 'boolean');
  });

  it('color constants are valid hex numbers', () => {
    assert.equal(typeof T.COLOR_PROGRADE, 'number');
    assert.equal(typeof T.COLOR_RETROGRADE, 'number');
    assert.equal(typeof T.COLOR_NORMAL, 'number');
    assert.equal(typeof T.COLOR_ARM, 'number');
  });

  it('width multipliers are positive', () => {
    assert.ok(T.MOTHER_WIDTH_SCALE > 0, 'MOTHER_WIDTH_SCALE > 0');
    assert.ok(T.ARM_TRAIL_WIDTH > 0, 'ARM_TRAIL_WIDTH > 0');
  });

  it('buffer capacities: player=900, arm=300', () => {
    assert.equal(T.MOTHER_BUFFER_SECONDS * T.SAMPLE_RATE_HZ, 900);
    assert.equal(T.ARM_BUFFER_SECONDS * T.SAMPLE_RATE_HZ, 300);
  });

  it('STALE_HIDE_SECONDS is a positive number', () => {
    assert.equal(typeof T.STALE_HIDE_SECONDS, 'number');
    assert.ok(T.STALE_HIDE_SECONDS > 0, 'STALE_HIDE_SECONDS > 0');
  });

  it('MIN_SAMPLE_DIST_M is a positive number', () => {
    assert.equal(typeof T.MIN_SAMPLE_DIST_M, 'number');
    assert.ok(T.MIN_SAMPLE_DIST_M > 0, 'MIN_SAMPLE_DIST_M > 0');
  });
});

// --------------------------------------------------------------------------
// Events ST-5.2 entries
// --------------------------------------------------------------------------

describe('TrailSystem — Events ST-5.2 entries', () => {
  it('PLAYER_TRAIL_SAMPLE exists', () => {
    assert.equal(Events.PLAYER_TRAIL_SAMPLE, 'player:trailSample');
  });

  it('ARM_TRAIL_SAMPLE exists', () => {
    assert.equal(Events.ARM_TRAIL_SAMPLE, 'arm:trailSample');
  });

  it('ARM_TRAIL_CLEAR exists', () => {
    assert.equal(Events.ARM_TRAIL_CLEAR, 'arm:trailClear');
  });
});
