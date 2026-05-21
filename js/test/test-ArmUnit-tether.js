/**
 * test-ArmUnit-tether.js — ST-1.4 Tether catenary sag direction regression tests
 *
 * Verifies that the catenary sag in _updateTether() is always perpendicular
 * to the tether direction, specifically handling the degenerate case when the
 * arm is displaced purely along +Y from the mother (tether aligned with gravity).
 */
import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { ArmUnit } from '../entities/ArmUnit.js';
import { eventBus } from '../core/EventBus.js';

const { ARM_STATES, TETHER_SEGMENTS, TETHER_SAG_FACTOR } = Constants;
const M = 0.00001; // Scene-scale factor consistent with existing ArmUnit tests
const S = ARM_STATES;

/**
 * Create an ArmUnit ready for tether testing.
 * Sets state to TRANSIT so _updateTether() renders the catenary.
 */
function makeTetherArm(posX = 0, posY = 0, posZ = 0) {
  const scene = { add: () => {}, remove: () => {} };
  const offset = new THREE.Vector3(M, 0, 0);
  const arm = new ArmUnit('tether-test', 'weaver', offset, scene);
  arm.index = 0;
  // Put arm in TRANSIT state so tether is rendered (not DOCKED/RELOADING/EXPENDED)
  arm.state = S.TRANSIT;
  arm.isDetached = false;
  // Set arm world position
  arm.position.set(posX, posY, posZ);
  // Set a nonzero tether length for strain calculation (half of max → nominal color)
  arm.tetherLength = arm.config.tetherMax * 0.5;
  eventBus.clear();
  return arm;
}

/**
 * Read the midpoint vertex from the tether position array.
 * Returns { x, y, z } in group-local coords.
 */
function readMidpoint(arm) {
  const pa = arm.tetherLine.geometry.attributes.position.array;
  const midIdx = Math.floor(TETHER_SEGMENTS / 2) * 3;
  return { x: pa[midIdx], y: pa[midIdx + 1], z: pa[midIdx + 2] };
}

/**
 * Compute the linear interpolation at the midpoint index.
 * In group-local coords, parent is at (parentPos - arm.position), arm is at origin.
 * At segment index i, invT = 1 - i/(segments-1).
 */
function linearMidpoint(arm, parentPos) {
  const midI = Math.floor(TETHER_SEGMENTS / 2);
  const t = midI / (TETHER_SEGMENTS - 1);
  const invT = 1 - t;
  return {
    x: (parentPos.x - arm.position.x) * invT,
    y: (parentPos.y - arm.position.y) * invT,
    z: (parentPos.z - arm.position.z) * invT,
  };
}

/**
 * Extract the sag vector (midpoint - linear midpoint) and normalize it.
 * Returns { sagVec: {x,y,z}, sagMag: number, sagDir: {x,y,z} }.
 */
function extractSag(arm, parentPos) {
  const mid = readMidpoint(arm);
  const lin = linearMidpoint(arm, parentPos);
  const sx = mid.x - lin.x;
  const sy = mid.y - lin.y;
  const sz = mid.z - lin.z;
  const mag = Math.sqrt(sx * sx + sy * sy + sz * sz);
  return {
    sagVec: { x: sx, y: sy, z: sz },
    sagMag: mag,
    sagDir: mag > 1e-12
      ? { x: sx / mag, y: sy / mag, z: sz / mag }
      : { x: 0, y: 0, z: 0 },
  };
}

/** Dot product of two {x,y,z} objects */
function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }

// ── Suite 24: Tether Catenary — Sag Direction (ST-1.4) ─────────────────
describe('Tether Catenary — Sag Direction (ST-1.4)', () => {

  it('arm displaced purely +Y: sag has zero Y component (perpendicular to tether)', () => {
    // Historical failure case: arm directly above mother along +Y
    const arm = makeTetherArm(0, 1000 * M, 0);
    const motherPos = new THREE.Vector3(0, 0, 0);
    arm._updateTether(motherPos);

    const mid = readMidpoint(arm);
    const lin = linearMidpoint(arm, motherPos);

    // The sag should NOT contribute to Y — midpoint Y should equal linear Y
    // (tolerance accounts for Float32Array precision in geometry buffer)
    assert.closeTo(mid.y, lin.y, 1e-8,
      'midpoint Y must equal linear interpolation Y (sag perpendicular to vertical tether)');

    // Sag should be nonzero (in +Z due to fallback)
    const { sagMag } = extractSag(arm, motherPos);
    assert.ok(sagMag > 1e-12, 'sag magnitude should be nonzero (fallback to +Z axis)');
  });

  it('arm displaced purely +Y: sag direction is +Z (fallback axis)', () => {
    const arm = makeTetherArm(0, 1000 * M, 0);
    const motherPos = new THREE.Vector3(0, 0, 0);
    arm._updateTether(motherPos);

    const { sagDir } = extractSag(arm, motherPos);
    // When tether is along Y, world-down projection degenerates → fallback to +Z
    // (tolerance 1e-5 accounts for Float32Array round-trip in geometry buffer)
    assert.closeTo(sagDir.z, 1.0, 1e-5, 'sag should be in +Z direction');
    assert.closeTo(sagDir.x, 0.0, 1e-5, 'sag X component should be zero');
    assert.closeTo(sagDir.y, 0.0, 1e-5, 'sag Y component should be zero');
  });

  it('arm displaced purely +X: sag direction is -Y (world down)', () => {
    const arm = makeTetherArm(1000 * M, 0, 0);
    const motherPos = new THREE.Vector3(0, 0, 0);
    arm._updateTether(motherPos);

    const { sagDir, sagMag } = extractSag(arm, motherPos);
    assert.ok(sagMag > 1e-12, 'sag should be nonzero');
    assert.closeTo(sagDir.y, -1.0, 1e-5, 'sag should be in -Y (downward)');
    assert.closeTo(sagDir.x, 0.0, 1e-5, 'sag X component should be zero');
    assert.closeTo(sagDir.z, 0.0, 1e-5, 'sag Z component should be zero');
  });

  it('arm displaced purely +Z: sag direction is -Y (world down)', () => {
    const arm = makeTetherArm(0, 0, 1000 * M);
    const motherPos = new THREE.Vector3(0, 0, 0);
    arm._updateTether(motherPos);

    const { sagDir, sagMag } = extractSag(arm, motherPos);
    assert.ok(sagMag > 1e-12, 'sag should be nonzero');
    assert.closeTo(sagDir.y, -1.0, 1e-5, 'sag should be in -Y (downward)');
    assert.closeTo(sagDir.x, 0.0, 1e-5, 'sag X component should be zero');
    assert.closeTo(sagDir.z, 0.0, 1e-5, 'sag Z component should be zero');
  });

  it('arm at 45° (X+Y): sag direction has -Y component and is perpendicular to tether', () => {
    const arm = makeTetherArm(1000 * M, 1000 * M, 0);
    const motherPos = new THREE.Vector3(0, 0, 0);
    arm._updateTether(motherPos);

    const { sagDir, sagMag } = extractSag(arm, motherPos);
    assert.ok(sagMag > 1e-12, 'sag should be nonzero');
    // Sag direction should have a -Y component (downward bias)
    assert.ok(sagDir.y < -0.1, 'sag should have negative Y component (downward)');

    // Compute tether direction (arm → parent in group-local)
    const dx = motherPos.x - arm.position.x;
    const dy = motherPos.y - arm.position.y;
    const dz = motherPos.z - arm.position.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const tDir = { x: dx / len, y: dy / len, z: dz / len };

    // sagDir must be perpendicular to tether direction
    const d = dot(sagDir, tDir);
    assert.closeTo(d, 0.0, 1e-5, 'sag direction must be perpendicular to tether direction');
  });
});

// ── Suite 25: Tether Catenary — Perpendicularity Invariant ─────────────
describe('Tether Catenary — Perpendicularity Invariant', () => {

  const testCases = [
    { label: '+X displacement',        pos: [1000, 0, 0] },
    { label: '+Y displacement',        pos: [0, 1000, 0] },
    { label: '+Z displacement',        pos: [0, 0, 1000] },
    { label: '-Y displacement',        pos: [0, -1000, 0] },
    { label: '45° X+Y',               pos: [1000, 1000, 0] },
    { label: '45° X+Z',               pos: [1000, 0, 1000] },
    { label: '45° Y+Z',               pos: [0, 1000, 1000] },
    { label: 'arbitrary diagonal',     pos: [500, 800, 300] },
  ];

  for (const tc of testCases) {
    it(`sagDir ⊥ tetherDir for ${tc.label}`, () => {
      const arm = makeTetherArm(tc.pos[0] * M, tc.pos[1] * M, tc.pos[2] * M);
      const motherPos = new THREE.Vector3(0, 0, 0);
      arm._updateTether(motherPos);

      const { sagDir, sagMag } = extractSag(arm, motherPos);
      // Sag should be nonzero
      assert.ok(sagMag > 1e-12, 'sag magnitude should be nonzero');

      // Compute tether direction
      const dx = motherPos.x - arm.position.x;
      const dy = motherPos.y - arm.position.y;
      const dz = motherPos.z - arm.position.z;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const tDir = { x: dx / len, y: dy / len, z: dz / len };

      // Perpendicularity: sagDir · tetherDir ≈ 0
      // (tolerance 1e-5 accounts for Float32Array precision in geometry buffer)
      const d = dot(sagDir, tDir);
      assert.closeTo(d, 0.0, 1e-5,
        `sag direction dot tether direction should be ~0, got ${d}`);
    });
  }
});

// ── Suite 26: Tether Catenary — Sag Amplitude Scales with Separation ───
describe('Tether Catenary — Sag Amplitude Scales with Separation', () => {

  it('sag amplitude is proportional to separation, not max tether length', () => {
    const arm1 = makeTetherArm(500 * M, 0, 0);
    const arm2 = makeTetherArm(1000 * M, 0, 0);
    const motherPos = new THREE.Vector3(0, 0, 0);

    arm1._updateTether(motherPos);
    arm2._updateTether(motherPos);

    const sag1 = extractSag(arm1, motherPos).sagMag;
    const sag2 = extractSag(arm2, motherPos).sagMag;

    // arm2 is 2× the separation of arm1, so sag should be ~2× as large
    // (both use same TETHER_SAG_FACTOR, bell curve value is the same at same t)
    const ratio = sag2 / sag1;
    assert.closeTo(ratio, 2.0, 0.01,
      `sag ratio should be ~2.0 for 2× separation, got ${ratio}`);
  });

  it('sag amplitude matches expected value from TETHER_SAG_FACTOR', () => {
    const separation = 1000 * M; // 0.01 scene units
    const arm = makeTetherArm(separation, 0, 0);
    const motherPos = new THREE.Vector3(0, 0, 0);
    arm._updateTether(motherPos);

    const { sagMag } = extractSag(arm, motherPos);

    // Expected sag at midpoint: separation * TETHER_SAG_FACTOR * sin(midT * π)
    const midI = Math.floor(TETHER_SEGMENTS / 2);
    const t = midI / (TETHER_SEGMENTS - 1);
    const bell = Math.sin(t * Math.PI);
    const expected = separation * TETHER_SAG_FACTOR * bell;

    // Float32Array truncation introduces ~|value| * 2^-24 error
    assert.closeTo(sagMag, expected, 1e-6,
      `sag magnitude should be ${expected}, got ${sagMag}`);
  });
});

// ── Suite 27: Tether Catenary — Constants Hoisted ──────────────────────
describe('Tether Catenary — Constants Hoisted (ST-1.4)', () => {

  it('TETHER_SAG_FACTOR exists and equals 0.015', () => {
    assert.equal(Constants.TETHER_SAG_FACTOR, 0.015);
  });

  it('TETHER_SAG_PARALLEL_THRESHOLD exists and is a small positive number', () => {
    assert.ok(Constants.TETHER_SAG_PARALLEL_THRESHOLD > 0,
      'threshold must be positive');
    assert.ok(Constants.TETHER_SAG_PARALLEL_THRESHOLD < 1e-3,
      'threshold must be small');
  });

  it('TETHER_SEGMENTS exists and is 24', () => {
    assert.equal(Constants.TETHER_SEGMENTS, 24);
  });
});
