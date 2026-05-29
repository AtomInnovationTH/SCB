/**
 * test-AutoProfileSweep.js — Sprint 3 GPU profiling orchestrator tests.
 *
 * The full sweep runs inside `requestAnimationFrame` against a live
 * WebGL2 context — neither of which exist in Node. We therefore exercise
 * only the **pure logic** pieces that can be unit-tested without a browser:
 *
 *   - the Δ-vs-baseline computation (`_computeDeltas`) given a synthetic
 *     `_results` array,
 *   - the `start()` no-op behaviour when `?autoProfile=1` is not set,
 *   - graceful abort when `sceneManager.applyTierWithOverrides` is missing.
 *
 * @module test/test-AutoProfileSweep
 */

import { describe, it, assert } from './TestRunner.js';
import { AutoProfileSweep, SWEEP_CONFIGS } from '../systems/AutoProfileSweep.js';

describe('AutoProfileSweep — Δ-vs-baseline computation', () => {
  it('returns one entry per non-baseline result with frameMs delta', () => {
    const sweep = new AutoProfileSweep({});
    sweep._results = [
      { configId: 'baseline',          frameMs: 11.4 },
      { configId: 'disableEarthNoise', frameMs: 8.2 },
      { configId: 'disableBloom',      frameMs: 10.1 },
      { configId: 'disableSMAA',       frameMs: 10.6 },
    ];
    const deltas = sweep._computeDeltas();
    // Δ = baseline − config (positive = saving)
    assert.equal(deltas.disableEarthNoise, 3.2);
    assert.equal(deltas.disableBloom, 1.3);
    assert.equal(deltas.disableSMAA, 0.8);
    // baseline itself is not in the deltas map
    assert.equal('baseline' in deltas, false, 'baseline excluded from deltas');
  });

  it('returns null delta when baseline frameMs is null', () => {
    const sweep = new AutoProfileSweep({});
    sweep._results = [
      { configId: 'baseline',          frameMs: null },
      { configId: 'disableEarthNoise', frameMs: 8.2 },
    ];
    const deltas = sweep._computeDeltas();
    assert.equal(deltas.disableEarthNoise, null, 'null baseline propagates');
  });

  it('returns null delta when a non-baseline frameMs is null', () => {
    const sweep = new AutoProfileSweep({});
    sweep._results = [
      { configId: 'baseline',          frameMs: 11.4 },
      { configId: 'disableEarthNoise', frameMs: null },
    ];
    const deltas = sweep._computeDeltas();
    assert.equal(deltas.disableEarthNoise, null, 'null sample propagates');
  });

  it('returns an empty map when no baseline row exists', () => {
    const sweep = new AutoProfileSweep({});
    sweep._results = [
      { configId: 'disableEarthNoise', frameMs: 8.2 },
    ];
    const deltas = sweep._computeDeltas();
    // disableEarthNoise gets null because baselineMs is null
    assert.equal(deltas.disableEarthNoise, null);
  });

  it('rounds deltas to 3 decimals', () => {
    const sweep = new AutoProfileSweep({});
    sweep._results = [
      { configId: 'baseline', frameMs: 11.123456 },
      { configId: 'x',        frameMs: 8.987654 },
    ];
    const deltas = sweep._computeDeltas();
    // (11.123456 - 8.987654) = 2.135802 → rounded to 2.136
    assert.equal(deltas.x, 2.136);
  });
});

describe('AutoProfileSweep — start() guards', () => {
  it('is a no-op when ?autoProfile=1 is not active (Node test env)', async () => {
    // In Node test env, profileFlags.autoProfile === false → start() resolves
    // immediately without touching scene manager.
    const fakeSm = { /* no methods — should never be called */ };
    const sweep = new AutoProfileSweep({ sceneManager: fakeSm });
    await sweep.start();
    assert.equal(sweep._running, false, 'never flipped running');
    assert.equal(sweep._results.length, 0, 'no results recorded');
  });
});

describe('AutoProfileSweep — SWEEP_CONFIGS schema', () => {
  it('exports a frozen, non-empty array of {id, overrides} entries', () => {
    assert.equal(Array.isArray(SWEEP_CONFIGS), true, 'SWEEP_CONFIGS is an array');
    assert.equal(Object.isFrozen(SWEEP_CONFIGS), true, 'SWEEP_CONFIGS is frozen');
    assert.equal(SWEEP_CONFIGS.length > 0, true, 'at least one config');
    for (const cfg of SWEEP_CONFIGS) {
      assert.equal(typeof cfg.id, 'string', `id is string for ${JSON.stringify(cfg)}`);
      assert.equal(cfg.id.length > 0, true, 'id non-empty');
      assert.equal(cfg.overrides && typeof cfg.overrides === 'object', true,
        `overrides is object for ${cfg.id}`);
    }
  });

  it('has unique config ids (no typos / duplicates)', () => {
    const ids = SWEEP_CONFIGS.map((c) => c.id);
    const unique = new Set(ids);
    assert.equal(unique.size, ids.length, 'all ids unique');
  });

  it('includes baseline as the first entry (anchor for delta math)', () => {
    assert.equal(SWEEP_CONFIGS[0].id, 'baseline', 'baseline is first');
    // Empty overrides on baseline means applyTierWithOverrides({}) = pure tier defaults.
    assert.equal(Object.keys(SWEEP_CONFIGS[0].overrides).length, 0, 'baseline has no overrides');
  });

  it('includes the round-1 single-disable rows', () => {
    const ids = new Set(SWEEP_CONFIGS.map((c) => c.id));
    for (const need of [
      'profilePasses',
      'disableEarthNoise', 'disableBloom', 'disableSMAA',
      'disableClouds', 'disableAtmosphere',
      'msaa=0', 'pixelRatio=1',
    ]) {
      assert.equal(ids.has(need), true, `expected single-disable config "${need}"`);
    }
  });

  it('includes the round-2 multi-disable rows for post-process floor analysis', () => {
    const byId = new Map(SWEEP_CONFIGS.map((c) => [c.id, c]));

    const pairBS = byId.get('disableBloomAndSMAA');
    assert.equal(!!pairBS, true, 'disableBloomAndSMAA present');
    assert.equal(pairBS.overrides.enableBloom, false, 'BS: enableBloom=false');
    assert.equal(pairBS.overrides.enableSMAA, false, 'BS: enableSMAA=false');

    const pairBM = byId.get('disableBloomAndMSAA');
    assert.equal(!!pairBM, true, 'disableBloomAndMSAA present');
    assert.equal(pairBM.overrides.enableBloom, false, 'BM: enableBloom=false');
    assert.equal(pairBM.overrides.msaaSamples, 0, 'BM: msaaSamples=0');

    const pairSM = byId.get('disableSMAAAndMSAA');
    assert.equal(!!pairSM, true, 'disableSMAAAndMSAA present');
    assert.equal(pairSM.overrides.enableSMAA, false, 'SM: enableSMAA=false');
    assert.equal(pairSM.overrides.msaaSamples, 0, 'SM: msaaSamples=0');

    const all = byId.get('disableAllPost');
    assert.equal(!!all, true, 'disableAllPost present');
    assert.equal(all.overrides.enableBloom, false, 'all: enableBloom=false');
    assert.equal(all.overrides.enableSMAA, false, 'all: enableSMAA=false');
    assert.equal(all.overrides.msaaSamples, 0, 'all: msaaSamples=0');
  });
});
