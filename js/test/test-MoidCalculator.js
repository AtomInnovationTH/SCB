/**
 * test-MoidCalculator.js — ST-6.3 MOID calculator tests
 *
 * Validates computeMOID, classifyMOID, rankByMOID, and formatMOID.
 * Node-safe: no DOM, no THREE.js.
 */
import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';
import { computeMOID, classifyMOID, rankByMOID, formatMOID } from '../systems/MoidCalculator.js';

// ============================================================================
// HELPERS — orbit builders
// ============================================================================

const SCENE_SCALE = Constants.SCENE_SCALE; // 0.01

/** Build a circular orbit in scene units from altitude (km above Earth surface). */
function circularOrbit(altKm, incDeg = 0, raanDeg = 0, argPerDeg = 0) {
  const a_km = Constants.EARTH_RADIUS_KM + altKm;
  return {
    semiMajorAxis: a_km * SCENE_SCALE,      // scene units
    eccentricity:  0.001,                    // near-circular (avoid exact 0)
    inclination:   incDeg * Math.PI / 180,
    raan:          raanDeg * Math.PI / 180,
    argPerigee:    argPerDeg * Math.PI / 180,
  };
}

/** Build a circular orbit in metres from altitude (km above surface). */
function circularOrbitMetres(altKm, incDeg = 0, raanDeg = 0) {
  const a_km = Constants.EARTH_RADIUS_KM + altKm;
  return {
    semiMajorAxis_m: a_km * 1000,
    eccentricity:    0.001,
    inclination:     incDeg * Math.PI / 180,
    raan:            raanDeg * Math.PI / 180,
    argPerigee:      0,
  };
}

// ============================================================================
// SUITE 1: Coplanar circular orbits, different altitudes
// ============================================================================

describe('MoidCalculator — Coplanar circular, different altitudes', () => {
  it('MOID ≈ |r_A − r_B| for 400 km vs 600 km (200 km gap)', () => {
    const A = circularOrbit(400, 51.6);
    const B = circularOrbit(600, 51.6);
    const moid = computeMOID(A, B);
    const expected_m = 200 * 1000; // 200 km = 200 000 m
    // Within 1% tolerance (sampled approximation)
    assert.ok(Math.abs(moid - expected_m) / expected_m < 0.01,
      `MOID ${moid.toFixed(0)} m should be ≈ ${expected_m} m (±1%)`);
  });

  it('MOID ≈ |r_A − r_B| for 350 km vs 500 km (150 km gap)', () => {
    const A = circularOrbit(350, 51.6);
    const B = circularOrbit(500, 51.6);
    const moid = computeMOID(A, B);
    const expected_m = 150 * 1000;
    assert.ok(Math.abs(moid - expected_m) / expected_m < 0.01,
      `MOID ${moid.toFixed(0)} m should be ≈ ${expected_m} m (±1%)`);
  });
});

// ============================================================================
// SUITE 2: Coplanar circular orbits, same altitude → MOID ≈ 0
// ============================================================================

describe('MoidCalculator — Coplanar circular, same altitude', () => {
  it('MOID ≈ 0 for two 400 km orbits at same inclination/RAAN', () => {
    const A = circularOrbit(400, 51.6, 0);
    const B = circularOrbit(400, 51.6, 0);
    const moid = computeMOID(A, B);
    // Should be very small (< 1 km = 1000 m) due to sampling + near-circular e=0.001
    assert.ok(moid < 1000,
      `MOID ${moid.toFixed(0)} m should be near 0 for identical orbits`);
  });
});

// ============================================================================
// SUITE 3: Different inclinations, same altitude
// ============================================================================

describe('MoidCalculator — Different inclinations', () => {
  it('same altitude + different inclination → MOID ≈ 0 (orbits intersect at nodes)', () => {
    // Two circular orbits at the same radius but different inclinations
    // share the same RAAN → they cross at the ascending/descending nodes
    const A = circularOrbit(400, 28.0);
    const B = circularOrbit(400, 51.6);
    const moid = computeMOID(A, B);
    // MOID should be very small because orbits intersect near the nodes
    assert.ok(moid < 5000,
      `MOID ${moid.toFixed(0)} m should be small — orbits intersect at nodes`);
  });

  it('different altitude + different inclination → MOID bounded by altitude gap', () => {
    const A = circularOrbit(400, 28.0);
    const B = circularOrbit(600, 51.6);
    const moid = computeMOID(A, B);
    const altGap_m = 200 * 1000;
    const r_m = (Constants.EARTH_RADIUS_KM + 500) * 1000;
    assert.ok(moid > 0, 'MOID must be positive');
    assert.ok(moid < altGap_m,
      `MOID ${moid.toFixed(0)} m should be ≤ altitude gap ${altGap_m} m (orbits can get closer at nodes)`);
    assert.ok(moid < 2 * r_m,
      `MOID ${moid.toFixed(0)} m should be < 2×r (${(2 * r_m).toFixed(0)} m)`);
  });
});

// ============================================================================
// SUITE 4: Classification thresholds
// ============================================================================

describe('MoidCalculator — classifyMOID thresholds', () => {
  it('classifyMOID(4999) → HI', () => {
    assert.equal(classifyMOID(4999), 'HI');
  });

  it('classifyMOID(5000) → MD (boundary: ≥ MOID_HI_M)', () => {
    assert.equal(classifyMOID(5000), 'MD');
  });

  it('classifyMOID(24999) → MD', () => {
    assert.equal(classifyMOID(24999), 'MD');
  });

  it('classifyMOID(25000) → LO (boundary: ≥ MOID_MD_M)', () => {
    assert.equal(classifyMOID(25000), 'LO');
  });

  it('classifyMOID(99999) → LO', () => {
    assert.equal(classifyMOID(99999), 'LO');
  });

  it('classifyMOID(100000) → SAFE (boundary: ≥ MOID_LO_M)', () => {
    assert.equal(classifyMOID(100000), 'SAFE');
  });

  it('classifyMOID(Infinity) → SAFE', () => {
    assert.equal(classifyMOID(Infinity), 'SAFE');
  });

  it('classifyMOID(0) → HI', () => {
    assert.equal(classifyMOID(0), 'HI');
  });
});

// ============================================================================
// SUITE 5: Scene-unit vs. metre input equivalence
// ============================================================================

describe('MoidCalculator — Scene-unit vs metre input', () => {
  it('same orbit in scene units and metres yields same MOID', () => {
    const altA = 500, altB = 700;
    // Scene-unit orbit
    const sceneA = circularOrbit(altA, 51.6);
    const sceneB = circularOrbit(altB, 51.6);
    // Metre orbit
    const metreA = circularOrbitMetres(altA, 51.6);
    const metreB = circularOrbitMetres(altB, 51.6);

    const moidScene = computeMOID(sceneA, sceneB);
    const moidMetre = computeMOID(metreA, metreB);

    // Should be identical (or very close — both normalise to same km)
    assert.closeTo(moidScene, moidMetre, 1,
      `Scene (${moidScene.toFixed(1)}) vs Metre (${moidMetre.toFixed(1)}) should match`);
  });

  it('mixed input: scene-unit A, metre B → valid MOID', () => {
    const A = circularOrbit(400, 51.6);
    const B = circularOrbitMetres(600, 51.6);
    const moid = computeMOID(A, B);
    assert.ok(isFinite(moid) && moid > 0, `MOID ${moid} should be finite positive`);
    const expected = 200 * 1000;
    assert.ok(Math.abs(moid - expected) / expected < 0.01,
      `Mixed-input MOID ${moid.toFixed(0)} m ≈ ${expected} m`);
  });
});

// ============================================================================
// SUITE 6: rankByMOID — top N selection
// ============================================================================

describe('MoidCalculator — rankByMOID', () => {
  it('returns topN=3 from 10 candidates, sorted ascending', () => {
    const primary = circularOrbit(400, 51.6);
    const candidates = [];
    for (let i = 0; i < 10; i++) {
      candidates.push({
        id: i,
        orbit: circularOrbit(400 + (i + 1) * 50, 51.6),
      });
    }
    const ranked = rankByMOID(primary, candidates, 3);
    assert.equal(ranked.length, 3, 'should return exactly 3');
    assert.ok(ranked[0].moid <= ranked[1].moid, 'sorted ascending [0] ≤ [1]');
    assert.ok(ranked[1].moid <= ranked[2].moid, 'sorted ascending [1] ≤ [2]');
    // Closest should be the 50 km gap candidate
    assert.equal(ranked[0].id, 0, 'closest candidate should be id=0 (50 km gap)');
  });

  it('returns fewer than topN if candidates list is short', () => {
    const primary = circularOrbit(400);
    const candidates = [{ id: 'a', orbit: circularOrbit(500) }];
    const ranked = rankByMOID(primary, candidates, 5);
    assert.equal(ranked.length, 1, 'should return 1 when only 1 candidate');
  });
});

// ============================================================================
// SUITE 7: Degenerate inputs
// ============================================================================

describe('MoidCalculator — Degenerate inputs', () => {
  it('identical orbit pair → finite small result', () => {
    const A = circularOrbit(400, 51.6);
    const moid = computeMOID(A, A);
    // Identical orbits at same phase: MOID should be very small or 0
    assert.ok(isFinite(moid), `MOID should be finite, got ${moid}`);
    assert.ok(moid >= 0, `MOID should be non-negative, got ${moid}`);
  });

  it('null orbit → Infinity', () => {
    assert.equal(computeMOID(null, circularOrbit(400)), Infinity);
    assert.equal(computeMOID(circularOrbit(400), null), Infinity);
  });

  it('zero semiMajorAxis → Infinity', () => {
    const bad = { semiMajorAxis: 0, eccentricity: 0 };
    assert.equal(computeMOID(bad, circularOrbit(400)), Infinity);
  });

  it('missing semiMajorAxis fields → Infinity', () => {
    const bad = { eccentricity: 0 };
    assert.equal(computeMOID(bad, circularOrbit(400)), Infinity);
  });
});

// ============================================================================
// SUITE 8: Consistency — MOID falls within expected gameplay range
// ============================================================================

describe('MoidCalculator — Gameplay range consistency', () => {
  it('nearby LEO orbits (400 vs 420 km, same plane) → MOID < 500 km', () => {
    const A = circularOrbit(400, 51.6);
    const B = circularOrbit(420, 51.6);
    const moid = computeMOID(A, B);
    assert.ok(moid < 500_000,
      `MOID ${moid.toFixed(0)} m should be < 500 km for nearby orbits`);
    assert.ok(moid > 10_000,
      `MOID ${moid.toFixed(0)} m should be > 10 km for 20 km altitude gap`);
  });

  it('widely separated orbits (LEO 400 km vs MEO 20000 km) → MOID > 15000 km', () => {
    const A = circularOrbit(400, 51.6);
    const B = circularOrbit(20000, 55);
    const moid = computeMOID(A, B);
    assert.ok(moid > 15_000_000,
      `MOID ${moid.toFixed(0)} m should be > 15000 km for LEO vs MEO`);
  });

  it('refine pass improves accuracy', () => {
    const A = circularOrbit(400, 51.6);
    const B = circularOrbit(420, 45.0);
    const coarseOnly = computeMOID(A, B, { refine: false });
    const refined = computeMOID(A, B, { refine: true });
    assert.ok(refined <= coarseOnly,
      `Refined (${refined.toFixed(0)}) should be ≤ coarse-only (${coarseOnly.toFixed(0)})`);
  });
});

// ============================================================================
// SUITE 9: formatMOID display helper
// ============================================================================

describe('MoidCalculator — formatMOID', () => {
  it('formats km with 1 decimal for values ≥ 1 km', () => {
    assert.equal(formatMOID(4800), '4.8 km');
    assert.equal(formatMOID(19300), '19.3 km');
  });

  it('formats metres for values < 1 km', () => {
    assert.equal(formatMOID(823), '823 m');
    assert.equal(formatMOID(50), '50 m');
  });

  it('formats large values with 0 decimals', () => {
    assert.equal(formatMOID(150_000), '150 km');
  });

  it('Infinity → "---"', () => {
    assert.equal(formatMOID(Infinity), '---');
  });
});
