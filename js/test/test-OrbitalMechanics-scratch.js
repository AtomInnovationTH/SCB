/**
 * test-OrbitalMechanics-scratch.js — Sprint 2 / PR A
 *
 * Verifies the [`keplerianToCartesianInto`](js/entities/OrbitalMechanics.js:1)
 * and [`orbitToSceneCartesianInto`](js/entities/OrbitalMechanics.js:1)
 * scratch-output variants produce numerically identical output to the
 * allocating reference implementations across a range of orbit shapes.
 *
 * Node-safe: no THREE imports, no DOM.
 */

import { describe, it, assert } from './TestRunner.js';
import {
  keplerianToCartesian,
  keplerianToCartesianInto,
  orbitToSceneCartesian,
  orbitToSceneCartesianInto,
} from '../entities/OrbitalMechanics.js';

const EPS = 1e-12;

/**
 * Numerically compare two `{x,y,z}` objects.
 * @param {object} a
 * @param {object} b
 * @returns {number} max-abs-component diff
 */
function maxDelta(a, b) {
  return Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.z - b.z),
  );
}

// A handful of orbits spanning typical gameplay shapes.
const ORBITS_KM = [
  // Circular equatorial LEO
  { semiMajorAxis: 6778, eccentricity: 0, inclination: 0, raan: 0, argPerigee: 0, trueAnomaly: 0 },
  // Inclined LEO (ISS-like)
  { semiMajorAxis: 6778, eccentricity: 0.0006, inclination: 0.9006, raan: 1.2, argPerigee: 0.3, trueAnomaly: 1.4 },
  // Sun-sync polar
  { semiMajorAxis: 7100, eccentricity: 0.001, inclination: 1.701, raan: 0.5, argPerigee: 2.1, trueAnomaly: 3.5 },
  // Eccentric Molniya-ish
  { semiMajorAxis: 26600, eccentricity: 0.74, inclination: 1.107, raan: 4.0, argPerigee: 4.71, trueAnomaly: 0.1 },
  // GEO
  { semiMajorAxis: 42164, eccentricity: 0, inclination: 0, raan: 0, argPerigee: 0, trueAnomaly: 2.0 },
  // Highly inclined
  { semiMajorAxis: 7500, eccentricity: 0.05, inclination: 2.3, raan: 5.7, argPerigee: 1.2, trueAnomaly: 4.4 },
];

describe('OrbitalMechanics.keplerianToCartesianInto — output equivalence', () => {
  it('produces identical position+velocity to the allocating variant across canonical orbits', () => {
    const outPos = { x: 0, y: 0, z: 0 };
    const outVel = { x: 0, y: 0, z: 0 };
    for (const orbit of ORBITS_KM) {
      const ref = keplerianToCartesian(orbit);
      keplerianToCartesianInto(orbit, outPos, outVel);
      assert.ok(maxDelta(ref.position, outPos) < EPS,
        `position mismatch for orbit a=${orbit.semiMajorAxis} (Δ=${maxDelta(ref.position, outPos)})`);
      assert.ok(maxDelta(ref.velocity, outVel) < EPS,
        `velocity mismatch for orbit a=${orbit.semiMajorAxis} (Δ=${maxDelta(ref.velocity, outVel)})`);
    }
  });

  it('mutates only the caller-provided outputs (no module-level state leak)', () => {
    const outPos1 = { x: 0, y: 0, z: 0 };
    const outVel1 = { x: 0, y: 0, z: 0 };
    const outPos2 = { x: 0, y: 0, z: 0 };
    const outVel2 = { x: 0, y: 0, z: 0 };
    keplerianToCartesianInto(ORBITS_KM[0], outPos1, outVel1);
    keplerianToCartesianInto(ORBITS_KM[3], outPos2, outVel2);
    // After two distinct calls, both outputs must still reflect their own orbit.
    const ref1 = keplerianToCartesian(ORBITS_KM[0]);
    const ref2 = keplerianToCartesian(ORBITS_KM[3]);
    assert.ok(maxDelta(ref1.position, outPos1) < EPS, 'first call output overwritten by second');
    assert.ok(maxDelta(ref2.position, outPos2) < EPS, 'second call output diverged from reference');
  });

  it('reuses the same scratch outputs across many calls without drift', () => {
    const outPos = { x: 0, y: 0, z: 0 };
    const outVel = { x: 0, y: 0, z: 0 };
    // Call thousands of times — if any internal state leaks, drift would show.
    for (let i = 0; i < 5000; i++) {
      keplerianToCartesianInto(ORBITS_KM[i % ORBITS_KM.length], outPos, outVel);
    }
    // Final call should match the reference for whichever orbit was last.
    const lastOrbit = ORBITS_KM[(5000 - 1) % ORBITS_KM.length];
    const ref = keplerianToCartesian(lastOrbit);
    assert.ok(maxDelta(ref.position, outPos) < EPS, 'position drifted after 5000 calls');
    assert.ok(maxDelta(ref.velocity, outVel) < EPS, 'velocity drifted after 5000 calls');
  });
});

describe('OrbitalMechanics.orbitToSceneCartesianInto — output equivalence', () => {
  // Scene-unit orbits: same shape but semiMajorAxis is in scene units.
  // We mirror what DebrisField does — pass a scene-unit semiMajorAxis.
  const SCENE_ORBITS = ORBITS_KM.map((o) => ({
    ...o,
    semiMajorAxis: o.semiMajorAxis * 0.00001, // SCENE_SCALE — see Constants.js
  }));

  it('produces identical scene-space position and km/s velocity vs. the allocating variant', () => {
    const outPos = { x: 0, y: 0, z: 0 };
    const outVel = { x: 0, y: 0, z: 0 };
    for (const orbit of SCENE_ORBITS) {
      const ref = orbitToSceneCartesian(orbit);
      orbitToSceneCartesianInto(orbit, outPos, outVel);
      const dp = maxDelta(ref.position, outPos);
      const dv = maxDelta(ref.velocity, outVel);
      // Floating-origin scale conversion + sceneToKm/kmToScene round-trip
      // introduces ≤ ~1e-15 relative error on a normalised inverse pair —
      // 1e-9 is a generous tolerance.
      assert.ok(dp < 1e-9, `scene position mismatch (Δ=${dp})`);
      assert.ok(dv < 1e-9, `velocity mismatch (Δ=${dv})`);
    }
  });

  it('writes only into the caller-supplied scratch (orbit input unmodified)', () => {
    const orbit = { ...SCENE_ORBITS[1] };
    const snapshot = { ...orbit };
    const outPos = { x: 0, y: 0, z: 0 };
    const outVel = { x: 0, y: 0, z: 0 };
    orbitToSceneCartesianInto(orbit, outPos, outVel);
    for (const k of Object.keys(snapshot)) {
      assert.equal(orbit[k], snapshot[k], `orbit.${k} mutated unexpectedly`);
    }
  });

  it('handles back-to-back calls with different scratch outputs independently', () => {
    const posA = { x: 0, y: 0, z: 0 };
    const velA = { x: 0, y: 0, z: 0 };
    const posB = { x: 0, y: 0, z: 0 };
    const velB = { x: 0, y: 0, z: 0 };
    orbitToSceneCartesianInto(SCENE_ORBITS[0], posA, velA);
    orbitToSceneCartesianInto(SCENE_ORBITS[4], posB, velB);
    const refA = orbitToSceneCartesian(SCENE_ORBITS[0]);
    const refB = orbitToSceneCartesian(SCENE_ORBITS[4]);
    assert.ok(maxDelta(refA.position, posA) < 1e-9, 'A was clobbered by B');
    assert.ok(maxDelta(refB.position, posB) < 1e-9, 'B diverged from reference');
  });
});
