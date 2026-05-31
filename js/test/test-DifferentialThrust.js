/**
 * test-DifferentialThrust.js — Differential FEEP plume firing
 *
 * Tests: DIFFERENTIAL_THRUST constants, setThrusterFire nozzle mapping,
 * per-axis isolation, combined inputs, magnitude scaling, frame-reset decay.
 *
 * Node-safe: uses mock reproducing setThrusterFire logic (no THREE.js needed).
 */
import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';

// ══════════════════════════════════════════════════════════════════════════
// Suite: DIFFERENTIAL_THRUST constants integrity
// ══════════════════════════════════════════════════════════════════════════
describe('DifferentialThrust — Constants', () => {
  const DT = Constants.DIFFERENTIAL_THRUST;

  it('DIFFERENTIAL_THRUST block exists in Constants', () => {
    assert.ok(DT, 'DIFFERENTIAL_THRUST exists');
    assert.ok(DT.NOZZLE_MAP, 'NOZZLE_MAP exists');
    assert.ok(typeof DT.LERP_RATE === 'number', 'LERP_RATE is a number');
  });

  it('NOZZLE_MAP has pitch and yaw axes', () => {
    assert.ok(DT.NOZZLE_MAP.pitch, 'pitch mapping exists');
    assert.ok(DT.NOZZLE_MAP.yaw, 'yaw mapping exists');
  });

  it('pitch +1 maps to HT_BOTTOM (index 1)', () => {
    assert.equal(DT.NOZZLE_MAP.pitch['1'], 1);
  });

  it('pitch -1 maps to HT_TOP (index 0)', () => {
    assert.equal(DT.NOZZLE_MAP.pitch['-1'], 0);
  });

  it('yaw +1 maps to HT_RIGHT (index 2)', () => {
    assert.equal(DT.NOZZLE_MAP.yaw['1'], 2);
  });

  it('yaw -1 maps to HT_LEFT (index 3)', () => {
    assert.equal(DT.NOZZLE_MAP.yaw['-1'], 3);
  });

  it('LERP_RATE matches legacy glow animation rate (8)', () => {
    assert.equal(DT.LERP_RATE, 8);
  });

  it('INNER_EMISSIVE_BASE is a positive number', () => {
    assert.ok(typeof DT.INNER_EMISSIVE_BASE === 'number' && DT.INNER_EMISSIVE_BASE > 0,
      `INNER_EMISSIVE_BASE should be > 0, got ${DT.INNER_EMISSIVE_BASE}`);
  });

  it('INNER_EMISSIVE_FIRE_SCALE is a positive number', () => {
    assert.ok(typeof DT.INNER_EMISSIVE_FIRE_SCALE === 'number' && DT.INNER_EMISSIVE_FIRE_SCALE > 0,
      `INNER_EMISSIVE_FIRE_SCALE should be > 0, got ${DT.INNER_EMISSIVE_FIRE_SCALE}`);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: setThrusterFire behaviour (mock-based)
// ══════════════════════════════════════════════════════════════════════════

/**
 * Minimal mock matching the setThrusterFire logic from PlayerSatellite.
 * This avoids THREE.js dependency while testing the exact same algorithm.
 */
function createMock() {
  return {
    _differentialFireTargets: [0, 0, 0, 0],
    setThrusterFire(axis, sign, magnitude) {
      const map = Constants.DIFFERENTIAL_THRUST.NOZZLE_MAP[axis];
      if (!map) return;
      const key = sign >= 0 ? '1' : '-1';
      const idx = map[key];
      if (idx === undefined) return;
      this._differentialFireTargets[idx] = Math.max(
        this._differentialFireTargets[idx],
        Math.min(1, magnitude)
      );
    },
  };
}

describe('DifferentialThrust — setThrusterFire single-axis', () => {

  it('pitch +1 fires ONLY HT_BOTTOM (index 1)', () => {
    const m = createMock();
    m.setThrusterFire('pitch', 1, 1);
    assert.equal(m._differentialFireTargets[0], 0, 'HT_TOP off');
    assert.equal(m._differentialFireTargets[1], 1, 'HT_BOTTOM on');
    assert.equal(m._differentialFireTargets[2], 0, 'HT_RIGHT off');
    assert.equal(m._differentialFireTargets[3], 0, 'HT_LEFT off');
  });

  it('pitch -1 fires ONLY HT_TOP (index 0)', () => {
    const m = createMock();
    m.setThrusterFire('pitch', -1, 1);
    assert.equal(m._differentialFireTargets[0], 1, 'HT_TOP on');
    assert.equal(m._differentialFireTargets[1], 0, 'HT_BOTTOM off');
    assert.equal(m._differentialFireTargets[2], 0, 'HT_RIGHT off');
    assert.equal(m._differentialFireTargets[3], 0, 'HT_LEFT off');
  });

  it('yaw +1 fires ONLY HT_RIGHT (index 2)', () => {
    const m = createMock();
    m.setThrusterFire('yaw', 1, 1);
    assert.equal(m._differentialFireTargets[0], 0, 'HT_TOP off');
    assert.equal(m._differentialFireTargets[1], 0, 'HT_BOTTOM off');
    assert.equal(m._differentialFireTargets[2], 1, 'HT_RIGHT on');
    assert.equal(m._differentialFireTargets[3], 0, 'HT_LEFT off');
  });

  it('yaw -1 fires ONLY HT_LEFT (index 3)', () => {
    const m = createMock();
    m.setThrusterFire('yaw', -1, 1);
    assert.equal(m._differentialFireTargets[0], 0, 'HT_TOP off');
    assert.equal(m._differentialFireTargets[1], 0, 'HT_BOTTOM off');
    assert.equal(m._differentialFireTargets[2], 0, 'HT_RIGHT off');
    assert.equal(m._differentialFireTargets[3], 1, 'HT_LEFT on');
  });
});

describe('DifferentialThrust — combined inputs', () => {

  it('pitch+ AND yaw- fires HT_BOTTOM + HT_LEFT (indices 1, 3)', () => {
    const m = createMock();
    m.setThrusterFire('pitch', 1, 1);   // HT_BOTTOM
    m.setThrusterFire('yaw', -1, 1);    // HT_LEFT
    assert.equal(m._differentialFireTargets[0], 0, 'HT_TOP off');
    assert.equal(m._differentialFireTargets[1], 1, 'HT_BOTTOM on');
    assert.equal(m._differentialFireTargets[2], 0, 'HT_RIGHT off');
    assert.equal(m._differentialFireTargets[3], 1, 'HT_LEFT on');
  });

  it('pitch- AND yaw+ fires HT_TOP + HT_RIGHT (indices 0, 2)', () => {
    const m = createMock();
    m.setThrusterFire('pitch', -1, 1);  // HT_TOP
    m.setThrusterFire('yaw', 1, 1);     // HT_RIGHT
    assert.equal(m._differentialFireTargets[0], 1, 'HT_TOP on');
    assert.equal(m._differentialFireTargets[1], 0, 'HT_BOTTOM off');
    assert.equal(m._differentialFireTargets[2], 1, 'HT_RIGHT on');
    assert.equal(m._differentialFireTargets[3], 0, 'HT_LEFT off');
  });

  it('all four directions fire all four nozzles', () => {
    const m = createMock();
    m.setThrusterFire('pitch', 1, 0.8);
    m.setThrusterFire('pitch', -1, 0.6);
    m.setThrusterFire('yaw', 1, 0.7);
    m.setThrusterFire('yaw', -1, 0.9);
    assert.closeTo(m._differentialFireTargets[0], 0.6, 1e-9, 'HT_TOP');
    assert.closeTo(m._differentialFireTargets[1], 0.8, 1e-9, 'HT_BOTTOM');
    assert.closeTo(m._differentialFireTargets[2], 0.7, 1e-9, 'HT_RIGHT');
    assert.closeTo(m._differentialFireTargets[3], 0.9, 1e-9, 'HT_LEFT');
  });
});

describe('DifferentialThrust — magnitude scaling', () => {

  it('magnitude 0.5 sets half-intensity on mapped nozzle', () => {
    const m = createMock();
    m.setThrusterFire('pitch', 1, 0.5);
    assert.closeTo(m._differentialFireTargets[1], 0.5, 1e-9, 'half intensity');
  });

  it('magnitude 0 leaves nozzle at 0', () => {
    const m = createMock();
    m.setThrusterFire('yaw', -1, 0);
    assert.equal(m._differentialFireTargets[3], 0, 'zero magnitude');
  });

  it('magnitude > 1 is clamped to 1', () => {
    const m = createMock();
    m.setThrusterFire('pitch', 1, 2.5);
    assert.equal(m._differentialFireTargets[1], 1, 'clamped to 1');
  });

  it('max-wins semantics: two calls, larger magnitude wins', () => {
    const m = createMock();
    m.setThrusterFire('pitch', 1, 0.3);
    m.setThrusterFire('pitch', 1, 0.7);
    assert.closeTo(m._differentialFireTargets[1], 0.7, 1e-9, 'max wins');
  });

  it('max-wins: first call with higher magnitude is preserved', () => {
    const m = createMock();
    m.setThrusterFire('yaw', 1, 0.9);
    m.setThrusterFire('yaw', 1, 0.4);
    assert.closeTo(m._differentialFireTargets[2], 0.9, 1e-9, 'first call preserved');
  });
});

describe('DifferentialThrust — edge cases', () => {

  it('unknown axis "roll" is a no-op', () => {
    const m = createMock();
    m.setThrusterFire('roll', 1, 1);
    assert.equal(m._differentialFireTargets[0], 0);
    assert.equal(m._differentialFireTargets[1], 0);
    assert.equal(m._differentialFireTargets[2], 0);
    assert.equal(m._differentialFireTargets[3], 0);
  });

  it('sign = 0 maps to +1 key (non-negative)', () => {
    const m = createMock();
    m.setThrusterFire('pitch', 0, 0.5);
    // sign >= 0 → key '1' → HT_BOTTOM (index 1)
    assert.closeTo(m._differentialFireTargets[1], 0.5, 1e-9);
  });

  it('negative magnitude is clamped to 0 via Math.min(1, mag) but Math.max keeps existing', () => {
    const m = createMock();
    m.setThrusterFire('pitch', 1, -0.5);
    // Math.min(1, -0.5) = -0.5, Math.max(0, -0.5) = 0 (array starts at 0)
    assert.equal(m._differentialFireTargets[1], 0, 'negative clamped by max with 0');
  });
});

describe('DifferentialThrust — frame-reset decay', () => {

  it('targets reset to 0 after fill(0) simulating frame end', () => {
    const m = createMock();
    m.setThrusterFire('pitch', 1, 0.8);
    m.setThrusterFire('yaw', -1, 0.6);
    assert.equal(m._differentialFireTargets[1], 0.8, 'set before reset');
    assert.equal(m._differentialFireTargets[3], 0.6, 'set before reset');

    // Simulate _animateThrusterGlow frame-end reset
    m._differentialFireTargets[0] = 0;
    m._differentialFireTargets[1] = 0;
    m._differentialFireTargets[2] = 0;
    m._differentialFireTargets[3] = 0;

    assert.equal(m._differentialFireTargets[1], 0, 'cleared after reset');
    assert.equal(m._differentialFireTargets[3], 0, 'cleared after reset');
  });

  it('re-setting after reset works normally', () => {
    const m = createMock();
    m.setThrusterFire('yaw', 1, 1.0);
    assert.equal(m._differentialFireTargets[2], 1.0);

    // Reset
    m._differentialFireTargets[0] = 0;
    m._differentialFireTargets[1] = 0;
    m._differentialFireTargets[2] = 0;
    m._differentialFireTargets[3] = 0;

    // New frame
    m.setThrusterFire('pitch', -1, 0.4);
    assert.equal(m._differentialFireTargets[0], 0.4, 'new frame sets correctly');
    assert.equal(m._differentialFireTargets[2], 0, 'previous axis stays 0');
  });
});
