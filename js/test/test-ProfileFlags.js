/**
 * test-ProfileFlags.js — Sprint 3 GPU profiling URL flag parser tests.
 *
 * Verifies [`_parseForTest`](js/core/ProfileFlags.js:1) produces the right
 * boolean / numeric / null values for every documented flag, and that the
 * `anyEnabled` aggregate flips correctly. The live `profileFlags` singleton
 * is parsed from `window.location.search` at module-load time and therefore
 * not exercised here — only the pure parser entry point is.
 *
 * @module test/test-ProfileFlags
 */

import { describe, it, assert } from './TestRunner.js';
import { _parseForTest, profileFlags } from '../core/ProfileFlags.js';

describe('ProfileFlags — defaults (empty query string)', () => {
  it('every flag defaults to off / null in the absence of params', () => {
    const f = _parseForTest('');
    assert.equal(f.profilePasses, false, 'profilePasses default');
    assert.equal(f.autoProfile, false, 'autoProfile default');
    assert.equal(f.disableEarthNoise, false, 'disableEarthNoise default');
    assert.equal(f.disableBloom, false, 'disableBloom default');
    assert.equal(f.disableSMAA, false, 'disableSMAA default');
    assert.equal(f.disableClouds, false, 'disableClouds default');
    assert.equal(f.disableAtmosphere, false, 'disableAtmosphere default');
    assert.equal(f.msaaOverride, null, 'msaaOverride default');
    assert.equal(f.pixelRatioOverride, null, 'pixelRatioOverride default');
    assert.equal(f.anyEnabled, false, 'anyEnabled stays false');
  });

  it('the singleton in a non-browser env mirrors the empty parse', () => {
    // Node test environment has no `window`, so the singleton is parsed
    // against an empty location — every field must be the default.
    assert.equal(profileFlags.profilePasses, false);
    assert.equal(profileFlags.disableEarthNoise, false);
    assert.equal(profileFlags.anyEnabled, false);
  });
});

describe('ProfileFlags — individual disable toggles', () => {
  const cases = [
    'profilePasses',
    'autoProfile',
    'disableEarthNoise',
    'disableBloom',
    'disableSMAA',
    'disableClouds',
    'disableAtmosphere',
  ];
  for (const key of cases) {
    it(`?${key}=1 flips ${key} on and bumps anyEnabled`, () => {
      const f = _parseForTest(`?${key}=1`);
      assert.equal(f[key], true, `${key} should be true`);
      assert.equal(f.anyEnabled, true, 'anyEnabled should reflect the active flag');
    });
    it(`?${key}=0 leaves ${key} off (only "1" activates)`, () => {
      const f = _parseForTest(`?${key}=0`);
      assert.equal(f[key], false, `${key} should remain false for value "0"`);
    });
    it(`?${key}=true is NOT recognised (strict "1" check)`, () => {
      const f = _parseForTest(`?${key}=true`);
      assert.equal(f[key], false, `${key} should ignore value "true"`);
    });
  }
});

describe('ProfileFlags — numeric overrides', () => {
  it('?msaa=0 → msaaOverride === 0', () => {
    const f = _parseForTest('?msaa=0');
    assert.equal(f.msaaOverride, 0);
    assert.equal(f.anyEnabled, true);
  });

  it('?msaa=4 → msaaOverride === 4', () => {
    const f = _parseForTest('?msaa=4');
    assert.equal(f.msaaOverride, 4);
  });

  it('?msaa=999 → null (out of range)', () => {
    const f = _parseForTest('?msaa=999');
    assert.equal(f.msaaOverride, null);
  });

  it('?msaa=abc → null (non-finite)', () => {
    const f = _parseForTest('?msaa=abc');
    assert.equal(f.msaaOverride, null);
  });

  it('?pixelRatio=1 → 1', () => {
    const f = _parseForTest('?pixelRatio=1');
    assert.equal(f.pixelRatioOverride, 1);
  });

  it('?pixelRatio=1.5 (fractional) → 1.5', () => {
    const f = _parseForTest('?pixelRatio=1.5');
    assert.equal(f.pixelRatioOverride, 1.5);
  });

  it('?pixelRatio=10 → null (out of range)', () => {
    const f = _parseForTest('?pixelRatio=10');
    assert.equal(f.pixelRatioOverride, null);
  });

  it('?pixelRatio=0 → null (below min 0.5)', () => {
    const f = _parseForTest('?pixelRatio=0');
    assert.equal(f.pixelRatioOverride, null);
  });
});

describe('ProfileFlags — multi-flag combination', () => {
  it('combines disableBloom + msaa=0 + pixelRatio=1', () => {
    const f = _parseForTest('?disableBloom=1&msaa=0&pixelRatio=1');
    assert.equal(f.disableBloom, true);
    assert.equal(f.msaaOverride, 0);
    assert.equal(f.pixelRatioOverride, 1);
    assert.equal(f.disableSMAA, false, 'unrelated flags remain off');
    assert.equal(f.anyEnabled, true);
  });

  it('frozen result is immutable', () => {
    const f = _parseForTest('?profilePasses=1');
    assert.ok(Object.isFrozen(f), 'parsed flag object should be frozen');
  });
});
