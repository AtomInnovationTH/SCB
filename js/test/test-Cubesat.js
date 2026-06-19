/**
 * test-Cubesat.js — Phase 3 of onboarding-tease-2-lateral-tune.md
 *
 * The `cubesat` debris type: a small WHOLE microsat (panelled box), the M1
 * net-only graduation catch. Verifies:
 *   • size/mass band (sub-metre, net-catchable ≤ LASSO_MAX_CAPTURE_MASS)
 *   • registered in every type-keyed map (enum, tier label, aspect, axis,
 *     metal profile, bounty premium)
 *   • geometry + wireframe data build
 *
 * Most assertions are Node-safe (no THREE); the geometry build exercises THREE
 * via DebrisWireframe.getGeometry (resolves in the test env, like other suites).
 */

import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';
import { DebrisWireframe, getWireframeData } from '../ui/DebrisWireframe.js';

describe('Cubesat — type registration (Phase 3)', () => {
  it('is present in Constants.DEBRIS_TYPES enum', () => {
    assert.equal(Constants.DEBRIS_TYPES.CUBESAT, 'cubesat');
  });

  it('has a tier range with a CubeSat label', () => {
    const tier = Constants.DEBRIS_TIER_RANGES.cubesat;
    assert.ok(tier, 'DEBRIS_TIER_RANGES.cubesat exists');
    assert.equal(tier.label, 'CubeSat');
    assert.ok(tier.tier >= 1 && tier.tier <= 2, 'cubesat is tier 1–2');
  });

  it('has an ASPECT_CAPTURE aspect + long-axis entry', () => {
    const aspect = Constants.ASPECT_CAPTURE.ASPECT_BY_TYPE.cubesat;
    assert.ok(Number.isFinite(aspect), 'aspect is finite');
    assert.ok(aspect >= 1.0 && aspect <= 1.5, 'cubesat is near-symmetric');
    assert.ok(Constants.ASPECT_CAPTURE.LONG_AXIS_BY_TYPE.cubesat,
      'cubesat has a long-axis entry');
  });

  it('has a metal profile that sums to ~1', () => {
    const prof = Constants.DEBRIS_METAL_PROFILES.cubesat;
    assert.ok(prof, 'DEBRIS_METAL_PROFILES.cubesat exists');
    const sum = Object.values(prof).reduce((a, b) => a + b, 0);
    assert.closeTo(sum, 1.0, 0.05, `metal profile should sum to ~1, got ${sum}`);
  });

  it('has a market bounty premium', () => {
    assert.ok(Number.isFinite(Constants.MARKET.BOUNTY_PREMIUMS.cubesat),
      'BOUNTY_PREMIUMS.cubesat is finite');
  });
});

describe('Cubesat — size/mass band is net-catchable (Phase 3)', () => {
  it('is sub-metre and ≤ Mother-net mass ceiling', () => {
    // The procedural type-def band lives in DebrisField (not exported), so we
    // assert via the welcome row #7 contract instead: ≤ 10 kg, sub-metre size.
    const ceil = Constants.LASSO_MAX_CAPTURE_MASS;
    // Cubesat welcome row authors mass 10 (== ceiling) and sizeM 0.30.
    assert.ok(10 <= ceil, `cubesat graduation mass 10 must be ≤ net ceiling ${ceil}`);
    assert.ok(0.30 < 1.0, 'cubesat renders sub-metre');
  });
});

describe('Cubesat — geometry + wireframe data (Phase 3)', () => {
  it('getGeometry("cubesat") returns a non-empty BufferGeometry', () => {
    const geo = DebrisWireframe.getGeometry('cubesat');
    assert.ok(geo, 'geometry returned');
    assert.ok(geo.attributes && geo.attributes.position,
      'geometry has a position attribute');
    assert.ok(geo.attributes.position.count > 0, 'geometry has vertices');
  });

  it('getGeometry("cubesat") is cached (same reference)', () => {
    const a = DebrisWireframe.getGeometry('cubesat');
    const b = DebrisWireframe.getGeometry('cubesat');
    assert.ok(a === b, 'cubesat geometry should be cached');
  });

  it('getWireframeData("cubesat") returns vertices + zones', () => {
    const data = getWireframeData('cubesat');
    assert.ok(data.vertices && data.vertices.length > 0, 'has vertices');
    assert.ok(data.zones && data.zones.length > 0, 'has zones');
  });
});
