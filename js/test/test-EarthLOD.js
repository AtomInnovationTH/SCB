/**
 * test-EarthLOD.js — Earth texture LOD selector pure-function tests (ST-5.3)
 *
 * Tests selectLOD(maxTextureSize, deviceMemory, isAppleGPU) without DOM/WebGL.
 * Verifies renderer.capabilities.maxTextureSize is the primary signal,
 * with deviceMemory + Apple-GPU heuristics as secondary guards.
 */
import { describe, it, assert } from './TestRunner.js';
import { selectLOD } from '../scene/Earth.js';
import { Constants } from '../core/Constants.js';

describe('Earth LOD - selectLOD() pure function', () => {

  it('maxTextureSize 16384 + 8 GB → 16k', () => {
    assert.equal(selectLOD(16384, 8, false), '16k');
  });

  it('maxTextureSize 16384 + undefined deviceMemory (Safari) → 16k (defaults to 8 GB)', () => {
    assert.equal(selectLOD(16384, undefined, false), '16k',
      'Safari undefined deviceMemory should default to 8 GB and select 16k');
  });

  it('maxTextureSize 16384 + Apple GPU + undefined memory → 16k', () => {
    assert.equal(selectLOD(16384, undefined, true), '16k',
      'Apple GPU should qualify for 16k even without deviceMemory');
  });

  it('maxTextureSize 16384 + low memory (2 GB) → 8k (GPU says 16k but RAM too low)', () => {
    assert.equal(selectLOD(16384, 2, false), '8k',
      'GPU supports 16k but only 2 GB RAM — fall to 8k');
  });

  it('maxTextureSize 16384 + low memory + Apple GPU → 16k (Apple override)', () => {
    assert.equal(selectLOD(16384, 2, true), '16k',
      'Apple GPU overrides low memory for 16k tier');
  });

  it('maxTextureSize 8192 + 4 GB → 8k', () => {
    assert.equal(selectLOD(8192, 4, false), '8k');
  });

  it('maxTextureSize 8192 + 8 GB → 8k (not 16k, GPU caps at 8k)', () => {
    assert.equal(selectLOD(8192, 8, false), '8k',
      'GPU maxTextureSize is primary — cannot exceed 8k even with high RAM');
  });

  it('maxTextureSize 8192 + low memory (2 GB) → base', () => {
    assert.equal(selectLOD(8192, 2, false), '',
      'Low memory with 8k GPU → base resolution');
  });

  it('maxTextureSize 4096 → base (4k default)', () => {
    assert.equal(selectLOD(4096, 8, false), '',
      'GPU maxTextureSize 4096 → base resolution regardless of RAM');
  });

  it('maxTextureSize 4096 + undefined memory → base', () => {
    assert.equal(selectLOD(4096, undefined, false), '',
      'GPU 4096 + Safari undefined memory → base resolution');
  });

  it('maxTextureSize 2048 → base', () => {
    assert.equal(selectLOD(2048, 16, true), '',
      'Very low GPU cap → base even with Apple GPU + huge RAM');
  });
});

describe('Earth LOD - Constants.EARTH thresholds', () => {

  it('LOD_16K_THRESHOLD is 16384', () => {
    assert.equal(Constants.EARTH.LOD_16K_THRESHOLD, 16384);
  });

  it('LOD_8K_THRESHOLD is 8192', () => {
    assert.equal(Constants.EARTH.LOD_8K_THRESHOLD, 8192);
  });

  it('CLOUD_ROTATION_RATE is positive and small', () => {
    assert.ok(Constants.EARTH.CLOUD_ROTATION_RATE > 0, 'Must be positive');
    assert.ok(Constants.EARTH.CLOUD_ROTATION_RATE < 0.001, 'Must be subtle');
  });

  it('VLEO_HOLD_SECONDS is 4', () => {
    assert.equal(Constants.EARTH.VLEO_HOLD_SECONDS, 4);
  });
});
