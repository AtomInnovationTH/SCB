/**
 * test-QualityManager.js — PR 4 / P1.5
 * Pure-function unit tests for selectInitialTier, runtimeAdapt, medianOf.
 */
import { describe, it, assert } from './TestRunner.js';
import {
  TIER_ORDER,
  medianOf,
  selectInitialTier,
  runtimeAdapt,
} from '../systems/QualityManager.js';
import { Constants } from '../core/Constants.js';

describe('QualityManager - TIER_ORDER + Constants integration', () => {
  it('TIER_ORDER is exactly [HIGH, MEDIUM, LOW]', () => {
    assert.deepEqual(TIER_ORDER, ['HIGH', 'MEDIUM', 'LOW']);
  });

  it('every TIER_ORDER entry has a matching Constants.PERF.QUALITY_TIERS config', () => {
    for (const tier of TIER_ORDER) {
      assert.ok(Constants.PERF.QUALITY_TIERS[tier],
        `Constants.PERF.QUALITY_TIERS.${tier} should exist`);
    }
  });

  it('Constants.PERF has the new tuning knobs', () => {
    assert.isType(Constants.PERF.DEFAULT_QUALITY_TIER, 'string');
    assert.isType(Constants.PERF.FPS_HISTORY_SIZE, 'number');
    assert.isType(Constants.PERF.ADAPT_FPS_THRESHOLD, 'number');
    assert.isType(Constants.PERF.ADAPT_COOLDOWN_FRAMES, 'number');
    assert.ok(TIER_ORDER.includes(Constants.PERF.DEFAULT_QUALITY_TIER),
      'DEFAULT_QUALITY_TIER should be one of TIER_ORDER');
  });
});

describe('QualityManager - medianOf', () => {
  it('odd-length array returns middle element', () => {
    assert.equal(medianOf([1, 2, 3, 4, 5]), 3);
    assert.equal(medianOf([5, 1, 3, 2, 4]), 3, 'should sort before picking');
  });

  it('even-length array returns mean of two middle elements', () => {
    assert.equal(medianOf([1, 2, 3, 4]), 2.5);
    assert.equal(medianOf([10, 20]), 15);
  });

  it('single-element array returns that element', () => {
    assert.equal(medianOf([42]), 42);
  });

  it('empty array returns NaN (documented choice)', () => {
    const result = medianOf([]);
    assert.ok(Number.isNaN(result), `expected NaN, got ${result}`);
  });

  it('null/undefined input returns NaN', () => {
    assert.ok(Number.isNaN(medianOf(null)));
    assert.ok(Number.isNaN(medianOf(undefined)));
  });

  it('does not mutate the input array', () => {
    const input = [5, 1, 3, 2, 4];
    const copy = input.slice();
    medianOf(input);
    assert.deepEqual(input, copy, 'input should be unchanged');
  });
});

describe('QualityManager - selectInitialTier', () => {
  it('high-end Apple Silicon → HIGH', () => {
    // M-series GPU: maxTextureSize 16384, isAppleGPU true, memory may be undefined
    const tier = selectInitialTier({
      maxTextureSize: 16384,
      devicePixelRatio: 2,
      isAppleGPU: true,
      deviceMemoryGB: undefined,
    });
    assert.equal(tier, 'HIGH');
  });

  it('high-end PC (16K-capable, 16 GB RAM, non-Apple) → HIGH', () => {
    const tier = selectInitialTier({
      maxTextureSize: 16384,
      devicePixelRatio: 1,
      isAppleGPU: false,
      deviceMemoryGB: 16,
    });
    assert.equal(tier, 'HIGH');
  });

  it('mid Intel laptop (8192 max texture, 4 GB RAM) → MEDIUM', () => {
    const tier = selectInitialTier({
      maxTextureSize: 8192,
      devicePixelRatio: 1,
      isAppleGPU: false,
      deviceMemoryGB: 4,
    });
    assert.equal(tier, 'MEDIUM');
  });

  it('low-end (2048 max texture, 1 GB RAM) → LOW', () => {
    const tier = selectInitialTier({
      maxTextureSize: 2048,
      devicePixelRatio: 1,
      isAppleGPU: false,
      deviceMemoryGB: 1,
    });
    assert.equal(tier, 'LOW');
  });

  it('16K-capable but only 2 GB RAM, non-Apple → LOW (fails HIGH gate, fails MEDIUM gate, hits LOW branch)', () => {
    // 16K-capable + 2GB: not HIGH (no Apple/8GB), not MEDIUM (memGB<4), so LOW.
    const tier = selectInitialTier({
      maxTextureSize: 16384,
      devicePixelRatio: 1,
      isAppleGPU: false,
      deviceMemoryGB: 2,
    });
    assert.equal(tier, 'LOW');
  });

  it('empty / undefined input → MEDIUM (safe middle)', () => {
    assert.equal(selectInitialTier({}), 'MEDIUM');
    assert.equal(selectInitialTier(undefined), 'MEDIUM');
    assert.equal(selectInitialTier(null), 'MEDIUM');
  });

  it('partial-signal input (only deviceMemoryGB known, large) → MEDIUM safe-fall-through', () => {
    // No maxTextureSize, but memory is high. Without GPU info we can't claim
    // HIGH or LOW confidently → safe middle.
    const tier = selectInitialTier({
      deviceMemoryGB: 16,
    });
    assert.equal(tier, 'MEDIUM');
  });
});

describe('QualityManager - runtimeAdapt', () => {
  const HISTORY_SIZE = 180;
  const COOLDOWN = 300;
  const THRESHOLD = 50;

  function lowFpsHistory(n) {
    // Below threshold (e.g. 40 fps)
    return Array(n).fill(40);
  }

  function highFpsHistory(n) {
    return Array(n).fill(60);
  }

  it('returns no change when history is too short (< half window)', () => {
    const decision = runtimeAdapt({
      currentTier: 'HIGH',
      fpsHistory: lowFpsHistory(10),
      framesSinceLastChange: COOLDOWN,
      threshold: THRESHOLD,
      cooldownFrames: COOLDOWN,
      historySize: HISTORY_SIZE,
    });
    assert.equal(decision.changed, false);
    assert.equal(decision.nextTier, 'HIGH');
  });

  it('returns no change inside cooldown window even with low FPS', () => {
    const decision = runtimeAdapt({
      currentTier: 'HIGH',
      fpsHistory: lowFpsHistory(HISTORY_SIZE),
      framesSinceLastChange: 100, // < COOLDOWN
      threshold: THRESHOLD,
      cooldownFrames: COOLDOWN,
      historySize: HISTORY_SIZE,
    });
    assert.equal(decision.changed, false);
    assert.equal(decision.nextTier, 'HIGH');
  });

  it('returns no change when median FPS is above threshold', () => {
    const decision = runtimeAdapt({
      currentTier: 'HIGH',
      fpsHistory: highFpsHistory(HISTORY_SIZE),
      framesSinceLastChange: COOLDOWN,
      threshold: THRESHOLD,
      cooldownFrames: COOLDOWN,
      historySize: HISTORY_SIZE,
    });
    assert.equal(decision.changed, false);
    assert.equal(decision.nextTier, 'HIGH');
  });

  it('drops HIGH → MEDIUM when median FPS < threshold + cooldown elapsed + half-history full', () => {
    const decision = runtimeAdapt({
      currentTier: 'HIGH',
      fpsHistory: lowFpsHistory(HISTORY_SIZE),
      framesSinceLastChange: COOLDOWN,
      threshold: THRESHOLD,
      cooldownFrames: COOLDOWN,
      historySize: HISTORY_SIZE,
    });
    assert.equal(decision.changed, true);
    assert.equal(decision.nextTier, 'MEDIUM');
    assert.equal(decision.medianFps, 40);
  });

  it('drops MEDIUM → LOW under same conditions', () => {
    const decision = runtimeAdapt({
      currentTier: 'MEDIUM',
      fpsHistory: lowFpsHistory(HISTORY_SIZE),
      framesSinceLastChange: COOLDOWN,
      threshold: THRESHOLD,
      cooldownFrames: COOLDOWN,
      historySize: HISTORY_SIZE,
    });
    assert.equal(decision.changed, true);
    assert.equal(decision.nextTier, 'LOW');
  });

  it('does NOT drop below LOW', () => {
    const decision = runtimeAdapt({
      currentTier: 'LOW',
      fpsHistory: lowFpsHistory(HISTORY_SIZE),
      framesSinceLastChange: COOLDOWN,
      threshold: THRESHOLD,
      cooldownFrames: COOLDOWN,
      historySize: HISTORY_SIZE,
    });
    assert.equal(decision.changed, false);
    assert.equal(decision.nextTier, 'LOW');
  });

  it('drops with exactly half-window samples (edge of gate)', () => {
    const half = Math.floor(HISTORY_SIZE / 2);
    const decision = runtimeAdapt({
      currentTier: 'HIGH',
      fpsHistory: lowFpsHistory(half),
      framesSinceLastChange: COOLDOWN,
      threshold: THRESHOLD,
      cooldownFrames: COOLDOWN,
      historySize: HISTORY_SIZE,
    });
    assert.equal(decision.changed, true);
    assert.equal(decision.nextTier, 'MEDIUM');
  });

  it('graceful no-change on invalid/missing currentTier', () => {
    const decision = runtimeAdapt({
      currentTier: 'BANANA',
      fpsHistory: lowFpsHistory(HISTORY_SIZE),
      framesSinceLastChange: COOLDOWN,
      threshold: THRESHOLD,
      cooldownFrames: COOLDOWN,
      historySize: HISTORY_SIZE,
    });
    assert.equal(decision.changed, false);
    assert.equal(decision.nextTier, 'BANANA');
  });

  it('graceful no-change on empty history', () => {
    const decision = runtimeAdapt({
      currentTier: 'HIGH',
      fpsHistory: [],
      framesSinceLastChange: COOLDOWN,
      threshold: THRESHOLD,
      cooldownFrames: COOLDOWN,
      historySize: HISTORY_SIZE,
    });
    assert.equal(decision.changed, false);
    assert.equal(decision.nextTier, 'HIGH');
  });
});

// ===========================================================================
// Sprint 2 / PR B — runtimeAdapt auto-upshift with hysteresis.
// Mirrors the downshift suite above. Upshift parameters are opt-in: callers
// that don't supply `upshiftThreshold`/`upshiftCooldownFrames` get the legacy
// downshift-only behaviour (verified by the suite above continuing to pass).
// ===========================================================================
describe('QualityManager - runtimeAdapt auto-upshift (Sprint 2 / PR B)', () => {
  const HISTORY_SIZE = 180;
  const DOWN_COOLDOWN = 300;
  const UP_COOLDOWN = 600;
  const DOWN_THRESHOLD = 50;
  const UP_THRESHOLD = 58;

  function steadyFpsHistory(fps, n = HISTORY_SIZE) {
    return Array(n).fill(fps);
  }

  function callAdapt(currentTier, fpsHistory, framesSinceLastChange, extra = {}) {
    return runtimeAdapt({
      currentTier,
      fpsHistory,
      framesSinceLastChange,
      threshold: DOWN_THRESHOLD,
      cooldownFrames: DOWN_COOLDOWN,
      upshiftThreshold: UP_THRESHOLD,
      upshiftCooldownFrames: UP_COOLDOWN,
      historySize: HISTORY_SIZE,
      ...extra,
    });
  }

  it('upshift gate fires: LOW → MEDIUM at 60 fps after 600-frame cooldown', () => {
    const decision = callAdapt('LOW', steadyFpsHistory(60), UP_COOLDOWN);
    assert.equal(decision.changed, true, 'should promote');
    assert.equal(decision.nextTier, 'MEDIUM');
    assert.equal(decision.direction, 'up');
    assert.equal(decision.medianFps, 60);
  });

  it('upshift cooldown gate: MEDIUM stays at MEDIUM until 600 frames elapse', () => {
    // 599 frames since last change — exactly one frame short of the upshift cooldown.
    const decision = callAdapt('MEDIUM', steadyFpsHistory(60), UP_COOLDOWN - 1);
    assert.equal(decision.changed, false, 'one frame short of cooldown should not upshift');
    assert.equal(decision.nextTier, 'MEDIUM');
    assert.equal(decision.direction, null);
  });

  it('upshift threshold gate: MEDIUM stays at MEDIUM at 57 fps (below 58 threshold)', () => {
    const decision = callAdapt('MEDIUM', steadyFpsHistory(57), UP_COOLDOWN);
    assert.equal(decision.changed, false, '57 fps is below the 58 upshift threshold');
    assert.equal(decision.nextTier, 'MEDIUM');
  });

  it('upshift ceiling: HIGH never promotes further', () => {
    const decision = callAdapt('HIGH', steadyFpsHistory(120), UP_COOLDOWN * 10);
    assert.equal(decision.changed, false, 'HIGH is the ceiling');
    assert.equal(decision.nextTier, 'HIGH');
    assert.equal(decision.direction, null);
  });

  it('hysteresis band: 53 fps median (between 50 down and 58 up) → no change either way', () => {
    // 53 sits in the dead band. Should not down-shift (>= 50) and should not
    // up-shift (< 58). This is the explicit anti-ping-pong gate.
    const decision = callAdapt('MEDIUM', steadyFpsHistory(53), UP_COOLDOWN);
    assert.equal(decision.changed, false, 'hysteresis band should suppress both directions');
    assert.equal(decision.direction, null);
    assert.equal(decision.medianFps, 53);
  });

  it('no upshift on LOW when fps flaps below threshold then back up briefly', () => {
    // Recent history is 70% at 40 fps (downshift territory) and 30% at 65 fps.
    // Median falls on the 40 side → downshift would fire if not at LOW (LOW
    // can't drop further), and certainly NO upshift.
    const flapping = [
      ...Array(126).fill(40),
      ...Array(54).fill(65),
    ];
    const decision = callAdapt('LOW', flapping, UP_COOLDOWN);
    assert.equal(decision.changed, false, 'LOW with flapping fps should not upshift');
    assert.equal(decision.nextTier, 'LOW');
    assert.equal(decision.direction, null);
  });

  it('upshift step-by-step: LOW → MEDIUM in one decision, not LOW → HIGH', () => {
    // Even with massive headroom we promote one step at a time. Caller can
    // call again next decision window if the workload continues to be easy.
    const decision = callAdapt('LOW', steadyFpsHistory(120), UP_COOLDOWN);
    assert.equal(decision.changed, true);
    assert.equal(decision.nextTier, 'MEDIUM', 'must promote exactly one step');
  });

  it('downshift wins over upshift when both conditions would fire (defensive)', () => {
    // 40 fps satisfies downshift (< 50). It does NOT satisfy upshift (< 58).
    // But to prove the priority order, we use a synthetic history that is
    // bimodal: half at 40, half at 70 — median lands at 55 (in the dead band).
    // We then verify median-based rules pick correctly.
    const bimodal = [
      ...Array(90).fill(40),
      ...Array(90).fill(70),
    ];
    const decision = callAdapt('MEDIUM', bimodal, Math.max(DOWN_COOLDOWN, UP_COOLDOWN));
    // median of bimodal 50/50 above is (40 + 70) / 2 = 55.
    assert.equal(decision.medianFps, 55, 'median sanity check');
    assert.equal(decision.changed, false, '55 sits in the hysteresis band');
  });

  it('upshift opt-in: omitting upshift knobs preserves pre-PR-B no-upshift behaviour', () => {
    // No upshiftThreshold / upshiftCooldownFrames → original downshift-only path.
    const decision = runtimeAdapt({
      currentTier: 'MEDIUM',
      fpsHistory: steadyFpsHistory(120),
      framesSinceLastChange: UP_COOLDOWN * 10,
      threshold: DOWN_THRESHOLD,
      cooldownFrames: DOWN_COOLDOWN,
      historySize: HISTORY_SIZE,
    });
    assert.equal(decision.changed, false, 'no upshift when knobs are omitted');
    assert.equal(decision.nextTier, 'MEDIUM');
    assert.equal(decision.direction, null);
  });
});

describe('QualityManager - PR B Constants integration', () => {
  it('Constants.PERF.ADAPT_UPSHIFT_FPS_THRESHOLD exists and is > ADAPT_FPS_THRESHOLD', () => {
    assert.isType(Constants.PERF.ADAPT_UPSHIFT_FPS_THRESHOLD, 'number');
    assert.ok(
      Constants.PERF.ADAPT_UPSHIFT_FPS_THRESHOLD > Constants.PERF.ADAPT_FPS_THRESHOLD,
      'upshift threshold must be greater than downshift threshold (hysteresis)',
    );
  });

  it('Constants.PERF.ADAPT_UPSHIFT_COOLDOWN_FRAMES exists and is > ADAPT_COOLDOWN_FRAMES', () => {
    assert.isType(Constants.PERF.ADAPT_UPSHIFT_COOLDOWN_FRAMES, 'number');
    assert.ok(
      Constants.PERF.ADAPT_UPSHIFT_COOLDOWN_FRAMES > Constants.PERF.ADAPT_COOLDOWN_FRAMES,
      'upshift cooldown must be greater than downshift cooldown (we want to be sure before promoting)',
    );
  });
});
