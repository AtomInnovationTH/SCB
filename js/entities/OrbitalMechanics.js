/**
 * OrbitalMechanics.js — Orbital mechanics utility functions
 * All calculations in real units (km, km/s) unless noted.
 * Convert to scene units (× SCENE_SCALE) for Three.js rendering.
 * @module entities/OrbitalMechanics
 */

import { Constants } from '../core/Constants.js';

// ============================================================================
// KEPLER'S EQUATION
// ============================================================================

/**
 * Solve Kepler's equation  M = E − e sin E  via Newton-Raphson.
 * @param {number} M - Mean anomaly (radians)
 * @param {number} e - Eccentricity
 * @param {number} [tol=1e-10] - Convergence tolerance
 * @returns {number} Eccentric anomaly E (radians)
 */
export function solveKepler(M, e, tol = 1e-10) {
  // Initial guess
  let E = M + e * Math.sin(M);
  for (let i = 0; i < 30; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < tol) break;
  }
  return E;
}

/**
 * Convert mean anomaly to true anomaly.
 * @param {number} M - Mean anomaly (radians)
 * @param {number} e - Eccentricity
 * @returns {number} True anomaly ν (radians)
 */
export function meanToTrueAnomaly(M, e) {
  const E = solveKepler(M, e);
  // True anomaly from eccentric anomaly
  const sinV = (Math.sqrt(1 - e * e) * Math.sin(E)) / (1 - e * Math.cos(E));
  const cosV = (Math.cos(E) - e) / (1 - e * Math.cos(E));
  return Math.atan2(sinV, cosV);
}

/**
 * Convert true anomaly to mean anomaly.
 * @param {number} v - True anomaly (radians)
 * @param {number} e - Eccentricity
 * @returns {number} Mean anomaly M (radians)
 */
export function trueToMeanAnomaly(v, e) {
  const E = Math.atan2(
    Math.sqrt(1 - e * e) * Math.sin(v),
    e + Math.cos(v)
  );
  return E - e * Math.sin(E);
}

// ============================================================================
// KEPLERIAN ↔ CARTESIAN CONVERSIONS
// ============================================================================

/**
 * Convert Keplerian orbital elements to Cartesian position & velocity.
 * @param {object} orbit - Keplerian elements
 * @param {number} orbit.semiMajorAxis - Semi-major axis in km
 * @param {number} orbit.eccentricity - Eccentricity
 * @param {number} orbit.inclination - Inclination (rad)
 * @param {number} orbit.raan - Right ascension of ascending node (rad)
 * @param {number} orbit.argPerigee - Argument of perigee (rad)
 * @param {number} orbit.trueAnomaly - True anomaly (rad)
 * @param {number} [mu=Constants.MU_EARTH] - Gravitational parameter (km³/s²)
 * @returns {{ position: {x,y,z}, velocity: {x,y,z} }} in km and km/s
 */
export function keplerianToCartesian(orbit, mu = Constants.MU_EARTH) {
  const { semiMajorAxis: a, eccentricity: e, inclination: i,
          raan: Ω, argPerigee: ω, trueAnomaly: ν } = orbit;

  // Semi-latus rectum
  const p = a * (1 - e * e);

  // Radius
  const r = p / (1 + e * Math.cos(ν));

  // Position in orbital plane (perifocal frame)
  const xP = r * Math.cos(ν);
  const yP = r * Math.sin(ν);

  // Velocity in orbital plane
  const sqrtMuP = Math.sqrt(mu / p);
  const vxP = -sqrtMuP * Math.sin(ν);
  const vyP = sqrtMuP * (e + Math.cos(ν));

  // Rotation matrices: perifocal → ECI
  const cosΩ = Math.cos(Ω), sinΩ = Math.sin(Ω);
  const cosω = Math.cos(ω), sinω = Math.sin(ω);
  const cosI = Math.cos(i), sinI = Math.sin(i);

  // Combined rotation matrix elements
  const l1 = cosΩ * cosω - sinΩ * sinω * cosI;
  const l2 = -cosΩ * sinω - sinΩ * cosω * cosI;
  const m1 = sinΩ * cosω + cosΩ * sinω * cosI;
  const m2 = -sinΩ * sinω + cosΩ * cosω * cosI;
  const n1 = sinω * sinI;
  const n2 = cosω * sinI;

  return {
    position: {
      x: l1 * xP + l2 * yP,
      y: n1 * xP + n2 * yP,
      z: m1 * xP + m2 * yP,
    },
    velocity: {
      x: l1 * vxP + l2 * vyP,
      y: n1 * vxP + n2 * vyP,
      z: m1 * vxP + m2 * vyP,
    },
  };
}

/**
 * Convert Cartesian state to Keplerian elements.
 *
 * **Frame convention:** input (position, velocity) is in the same Y-up scene
 * frame produced by [`keplerianToCartesian`](js/entities/OrbitalMechanics.js:76)
 * — i.e. Three.js coordinates where the orbital angular-momentum axis is Y.
 * Internally we swap `y ↔ z` to operate in the textbook Z-up ECI frame before
 * extracting elements. This makes the round-trip
 * `keplerianToCartesian(cartesianToKeplerian(r, v)) == (r, v)` hold.
 *
 * Historically this function used Z-up formulas directly on Y-up inputs, which
 * caused a ~1500 km per-tick teleport when used as a state-update round-trip
 * (see [`PlayerSatellite.applyCartesianImpulse`](js/entities/PlayerSatellite.js:2145)).
 *
 * @param {{ x: number, y: number, z: number }} position - km (Y-up scene frame)
 * @param {{ x: number, y: number, z: number }} velocity - km/s (Y-up scene frame)
 * @param {number} [mu=Constants.MU_EARTH]
 * @returns {object} Keplerian elements
 */
export function cartesianToKeplerian(position, velocity, mu = Constants.MU_EARTH) {
  // --- Scene Y-up → standard Z-up (swap y and z) ---
  const px = position.x, py = position.z, pz = position.y;
  const vx = velocity.x, vy = velocity.z, vz = velocity.y;

  const r = Math.sqrt(px * px + py * py + pz * pz);
  const v = Math.sqrt(vx * vx + vy * vy + vz * vz);

  // Angular momentum  h = r × v  (standard frame)
  const hx = py * vz - pz * vy;
  const hy = pz * vx - px * vz;
  const hz = px * vy - py * vx;
  const h = Math.sqrt(hx * hx + hy * hy + hz * hz);

  // Node vector  n = ẑ × h  (standard frame)
  const nx = -hy;
  const ny = hx;
  const n = Math.sqrt(nx * nx + ny * ny);

  // Eccentricity vector
  const rdotv = px * vx + py * vy + pz * vz;
  const ex = ((v * v - mu / r) * px - rdotv * vx) / mu;
  const ey = ((v * v - mu / r) * py - rdotv * vy) / mu;
  const ez = ((v * v - mu / r) * pz - rdotv * vz) / mu;
  const e = Math.sqrt(ex * ex + ey * ey + ez * ez);

  // Semi-major axis
  const energy = v * v / 2 - mu / r;
  const a = -mu / (2 * energy);

  // Inclination
  const i = Math.acos(Math.max(-1, Math.min(1, hz / h)));

  // RAAN
  let raan = 0;
  if (n > 1e-10) {
    raan = Math.acos(Math.max(-1, Math.min(1, nx / n)));
    if (ny < 0) raan = 2 * Math.PI - raan;
  }

  // Argument of perigee (requires a defined line of nodes AND non-circular orbit)
  let argP = 0;
  if (n > 1e-10 && e > 1e-10) {
    argP = Math.acos(Math.max(-1, Math.min(1, (nx * ex + ny * ey) / (n * e))));
    if (ez < 0) argP = 2 * Math.PI - argP;
  }

  // True anomaly. For near-circular orbits the eccentricity vector is
  // numerically noisy, so fall back to the argument of latitude (angle from
  // ascending node in the orbital plane) and treat ω = 0. This keeps the
  // round-trip position-preserving for the player's default circular orbit.
  let trueAnomaly = 0;
  if (e > 1e-10) {
    trueAnomaly = Math.acos(Math.max(-1, Math.min(1,
      (ex * px + ey * py + ez * pz) / (e * r)
    )));
    if (rdotv < 0) trueAnomaly = 2 * Math.PI - trueAnomaly;
  } else if (n > 1e-10) {
    // Circular inclined orbit — use argument of latitude u = ν + ω, with ω=0.
    trueAnomaly = Math.acos(Math.max(-1, Math.min(1, (nx * px + ny * py) / (n * r))));
    if (pz < 0) trueAnomaly = 2 * Math.PI - trueAnomaly;
  }

  return {
    semiMajorAxis: a,
    eccentricity: e,
    inclination: i,
    raan,
    argPerigee: argP,
    trueAnomaly,
    meanMotion: Math.sqrt(mu / (a * a * a)),
  };
}

// ============================================================================
// ORBIT PROPAGATION
// ============================================================================

/**
 * Propagate orbit by a time step using mean anomaly advancement.
 * Mutates the orbit object's trueAnomaly (and meanAnomaly if present).
 * @param {object} orbit - Keplerian elements (semiMajorAxis in km)
 * @param {number} dt - Time step in seconds (game-time, already scaled)
 * @param {number} [mu=Constants.MU_EARTH]
 * @returns {object} The same orbit object, mutated
 */
export function propagateOrbit(orbit, dt, mu = Constants.MU_EARTH) {
  const a = orbit.semiMajorAxis;
  const e = orbit.eccentricity;
  const n = Math.sqrt(mu / (a * a * a)); // Mean motion (rad/s)

  // Current mean anomaly from true anomaly
  let M = trueToMeanAnomaly(orbit.trueAnomaly, e);

  // Advance mean anomaly
  M += n * dt;

  // Wrap to [0, 2π)
  M = ((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

  // Convert back to true anomaly
  orbit.trueAnomaly = meanToTrueAnomaly(M, e);
  orbit.meanMotion = n;

  return orbit;
}

// ============================================================================
// DELTA-V CALCULATIONS
// ============================================================================

/**
 * Calculate orbital velocity at a given radius for an orbit with semi-major axis a.
 * v = sqrt(μ (2/r − 1/a))  (vis-viva equation)
 * @param {number} a - Semi-major axis (km)
 * @param {number} r - Current radius (km)
 * @param {number} [mu=Constants.MU_EARTH]
 * @returns {number} Orbital velocity (km/s)
 */
export function orbitalVelocity(a, r, mu = Constants.MU_EARTH) {
  return Math.sqrt(mu * (2 / r - 1 / a));
}

/**
 * Hohmann transfer delta-v between two circular orbits.
 * @param {number} r1 - Radius of initial orbit (km)
 * @param {number} r2 - Radius of target orbit (km)
 * @param {number} [mu=Constants.MU_EARTH]
 * @returns {{ dv1: number, dv2: number, total: number, transferTime: number }}
 *          dv1/dv2 in km/s, transferTime in seconds
 */
export function hohmannDeltaV(r1, r2, mu = Constants.MU_EARTH) {
  const aT = (r1 + r2) / 2; // Transfer orbit semi-major axis

  // Departure burn
  const v1 = Math.sqrt(mu / r1);
  const vT1 = Math.sqrt(mu * (2 / r1 - 1 / aT));
  const dv1 = Math.abs(vT1 - v1);

  // Arrival burn
  const v2 = Math.sqrt(mu / r2);
  const vT2 = Math.sqrt(mu * (2 / r2 - 1 / aT));
  const dv2 = Math.abs(v2 - vT2);

  // Transfer time (half period of transfer ellipse)
  const transferTime = Math.PI * Math.sqrt(aT * aT * aT / mu);

  return { dv1, dv2, total: dv1 + dv2, transferTime };
}

/**
 * Plane change delta-v (simple single-burn approximation).
 * @param {number} velocity - Current orbital velocity (km/s)
 * @param {number} deltaInclination - Change in inclination (rad)
 * @returns {number} Delta-v required (km/s)
 */
export function planeChangeDeltaV(velocity, deltaInclination) {
  return 2 * velocity * Math.sin(Math.abs(deltaInclination) / 2);
}

/**
 * Estimate total delta-v to reach target orbit from current orbit.
 * Combines Hohmann altitude change + simple plane change.
 * @param {object} orbit1 - Current orbit (Keplerian, km)
 * @param {object} orbit2 - Target orbit (Keplerian, km)
 * @param {number} [mu=Constants.MU_EARTH]
 * @returns {number} Estimated total delta-v (km/s)
 */
export function totalDeltaV(orbit1, orbit2, mu = Constants.MU_EARTH) {
  const r1 = orbit1.semiMajorAxis;
  const r2 = orbit2.semiMajorAxis;

  // Altitude change
  const hohmann = hohmannDeltaV(r1, r2, mu);

  // Plane change (inclination difference)
  const v2 = Math.sqrt(mu / r2);
  const deltaI = Math.abs(orbit2.inclination - orbit1.inclination);
  const planeChange = planeChangeDeltaV(v2, deltaI);

  return hohmann.total + planeChange;
}

// ============================================================================
// METAL-ION PROPULSION — Salvage ΔV (Phase 2)
// ============================================================================

/**
 * Compute the ΔV obtainable by using salvaged metal as propellant
 * via metal-ion propulsion (Tsiolkovsky rocket equation).
 *
 * @param {number} metalMassKg - mass of metal available as propellant (kg)
 * @param {number} isp - specific impulse of the metal as propellant (seconds)
 * @param {number} dryMassKg - ship dry mass without propellant (kg)
 * @returns {number} deltaV in m/s
 */
export function computeSalvageDeltaV(metalMassKg, isp, dryMassKg) {
  if (metalMassKg <= 0 || isp <= 0 || dryMassKg <= 0) return 0;
  const g0 = 9.80665; // m/s²
  const exhaustVelocity = isp * g0;
  const massRatio = (dryMassKg + metalMassKg) / dryMassKg;
  return exhaustVelocity * Math.log(massRatio);
}

/**
 * Compute total salvageable ΔV from a mixed bag of metals.
 * Each metal type has its own Isp — compute per-type and sum.
 * (This is an approximation; real multi-propellant ΔV is more complex,
 * but suitable for gameplay.)
 *
 * @param {Array<{massKg: number, ispAsThrust: number}>} metals
 * @param {number} dryMassKg - ship dry mass (kg)
 * @returns {number} total deltaV in m/s
 */
export function computeTotalSalvageDeltaV(metals, dryMassKg) {
  let totalDV = 0;
  for (const metal of metals) {
    if (metal.ispAsThrust > 0 && metal.massKg > 0) {
      totalDV += computeSalvageDeltaV(metal.massKg, metal.ispAsThrust, dryMassKg);
    }
  }
  return totalDV;
}

// ============================================================================
// SHADOW / ECLIPSE CHECK
// ============================================================================

/**
 * Check if a position is in Earth's shadow (cylindrical model).
 * @param {{ x: number, y: number, z: number }} position - Position (km or scene units)
 * @param {{ x: number, y: number, z: number }} sunDirection - Normalized sun direction
 * @param {number} earthRadius - Earth's radius in same units as position
 * @returns {boolean} true if in shadow
 */
export function isInShadow(position, sunDirection, earthRadius) {
  // Project position onto sun direction
  const dot = position.x * sunDirection.x +
              position.y * sunDirection.y +
              position.z * sunDirection.z;

  // Must be on the dark side (away from sun)
  if (dot > 0) return false;

  // Distance from the Earth-Sun line
  const projX = position.x - dot * sunDirection.x;
  const projY = position.y - dot * sunDirection.y;
  const projZ = position.z - dot * sunDirection.z;
  const distFromLine = Math.sqrt(projX * projX + projY * projY + projZ * projZ);

  return distFromLine < earthRadius;
}

// ============================================================================
// ATMOSPHERIC DRAG
// ============================================================================

/**
 * Simple exponential atmospheric density model.
 * @param {number} altitudeKm - Altitude above Earth surface (km)
 * @returns {number} Atmospheric density (kg/m³)
 */
function atmosphericDensity(altitudeKm) {
  // Simplified exponential model with piecewise scale heights
  if (altitudeKm < 0) return 1.225;
  if (altitudeKm > 1000) return 0;

  // Reference values: altitude(km), density(kg/m³), scaleHeight(km)
  const layers = [
    { h: 0, rho: 1.225, H: 8.5 },
    { h: 100, rho: 5.297e-7, H: 5.9 },
    { h: 200, rho: 2.789e-10, H: 37.0 },
    { h: 300, rho: 7.248e-11, H: 53.6 },
    { h: 400, rho: 2.803e-11, H: 63.8 },
    { h: 500, rho: 1.184e-11, H: 76.8 },
    { h: 700, rho: 3.614e-12, H: 100.8 },
    { h: 900, rho: 1.170e-12, H: 134.9 },
  ];

  // Find correct layer
  let layer = layers[0];
  for (let j = layers.length - 1; j >= 0; j--) {
    if (altitudeKm >= layers[j].h) {
      layer = layers[j];
      break;
    }
  }

  return layer.rho * Math.exp(-(altitudeKm - layer.h) / layer.H);
}

/**
 * Calculate atmospheric drag deceleration.
 * @param {number} altitudeKm - Altitude above Earth surface (km)
 * @param {number} velocity - Velocity magnitude (km/s)
 * @param {number} area - Cross-sectional area (m²)
 * @param {number} mass - Object mass (kg)
 * @param {number} [cd=2.2] - Drag coefficient
 * @returns {number} Deceleration (km/s²)
 */
export function atmosphericDrag(altitudeKm, velocity, area, mass, cd = 2.2) {
  const rho = atmosphericDensity(altitudeKm);
  // velocity in km/s → m/s for drag equation
  const vMs = velocity * 1000;
  // F_drag = 0.5 × ρ × v² × Cd × A
  const dragForce = 0.5 * rho * vMs * vMs * cd * area;
  // Deceleration in m/s² → km/s²
  return (dragForce / mass) / 1000;
}

// ============================================================================
// SCENE-UNIT HELPERS
// ============================================================================

/**
 * Convert km to scene units.
 * @param {number} km
 * @returns {number}
 */
export function kmToScene(km) {
  return km * Constants.SCENE_SCALE;
}

/**
 * Convert scene units to km.
 * @param {number} sceneUnits
 * @returns {number}
 */
export function sceneToKm(sceneUnits) {
  return sceneUnits / Constants.SCENE_SCALE;
}

/**
 * Convert a Keplerian orbit (semiMajorAxis in scene units) to km for calculations.
 * @param {object} orbit - Orbit with semiMajorAxis in scene units
 * @returns {object} Orbit copy with semiMajorAxis in km
 */
export function orbitToKm(orbit) {
  return {
    ...orbit,
    semiMajorAxis: sceneToKm(orbit.semiMajorAxis),
  };
}

/**
 * Get Cartesian position in scene units from a scene-unit orbit.
 * @param {object} orbit - Orbit with semiMajorAxis in scene units
 * @returns {{ position: {x,y,z}, velocity: {x,y,z} }}
 */
export function orbitToSceneCartesian(orbit) {
  const kmOrbit = orbitToKm(orbit);
  const result = keplerianToCartesian(kmOrbit);
  return {
    position: {
      x: kmToScene(result.position.x),
      y: kmToScene(result.position.y),
      z: kmToScene(result.position.z),
    },
    velocity: result.velocity, // Keep km/s for physics
  };
}

// ============================================================================
// Sprint 2 / PR A — Scratch-output ("Into") variants
//
// Same math as [`keplerianToCartesian`](js/entities/OrbitalMechanics.js:76)
// and [`orbitToSceneCartesian`](js/entities/OrbitalMechanics.js:490) but write
// into caller-provided `{x,y,z}` objects so per-frame call sites can avoid
// allocating ~150–900 short-lived literals/frame (see
// [`PERF_FOLLOWUP_ANALYSIS.md`](PERF_FOLLOWUP_ANALYSIS.md:82) § 3.1).
//
// The allocating versions remain for back-compat and tests; they are now
// trivially expressible in terms of the `Into` variants.
// ============================================================================

/**
 * Compute Cartesian state from Keplerian elements, writing into caller-owned
 * scratch objects. Returns nothing (zero allocations).
 *
 * @param {object} orbit              Keplerian elements (km, rad) — same shape
 *                                    as [`keplerianToCartesian`](js/entities/OrbitalMechanics.js:76).
 * @param {{x:number,y:number,z:number}} outPos   Will be mutated to position in km.
 * @param {{x:number,y:number,z:number}} outVel   Will be mutated to velocity in km/s.
 * @param {number} [mu=Constants.MU_EARTH]
 */
export function keplerianToCartesianInto(orbit, outPos, outVel, mu = Constants.MU_EARTH) {
  const { semiMajorAxis: a, eccentricity: e, inclination: i,
          raan: Ω, argPerigee: ω, trueAnomaly: ν } = orbit;

  // Semi-latus rectum
  const p = a * (1 - e * e);

  // Radius
  const r = p / (1 + e * Math.cos(ν));

  // Position in orbital plane (perifocal frame)
  const xP = r * Math.cos(ν);
  const yP = r * Math.sin(ν);

  // Velocity in orbital plane
  const sqrtMuP = Math.sqrt(mu / p);
  const vxP = -sqrtMuP * Math.sin(ν);
  const vyP = sqrtMuP * (e + Math.cos(ν));

  // Rotation matrices: perifocal → ECI
  const cosΩ = Math.cos(Ω), sinΩ = Math.sin(Ω);
  const cosω = Math.cos(ω), sinω = Math.sin(ω);
  const cosI = Math.cos(i), sinI = Math.sin(i);

  // Combined rotation matrix elements (identical to allocating version)
  const l1 = cosΩ * cosω - sinΩ * sinω * cosI;
  const l2 = -cosΩ * sinω - sinΩ * cosω * cosI;
  const m1 = sinΩ * cosω + cosΩ * sinω * cosI;
  const m2 = -sinΩ * sinω + cosΩ * cosω * cosI;
  const n1 = sinω * sinI;
  const n2 = cosω * sinI;

  outPos.x = l1 * xP + l2 * yP;
  outPos.y = n1 * xP + n2 * yP;
  outPos.z = m1 * xP + m2 * yP;

  outVel.x = l1 * vxP + l2 * vyP;
  outVel.y = n1 * vxP + n2 * vyP;
  outVel.z = m1 * vxP + m2 * vyP;
}

/**
 * Compute scene-unit Cartesian state from a scene-unit Keplerian orbit, writing
 * into caller-owned scratch objects. Position is converted km → scene units;
 * velocity is left in km/s (the physics code that consumes it stays in km/s).
 *
 * Mirrors [`orbitToSceneCartesian()`](js/entities/OrbitalMechanics.js:490) but
 * is allocation-free for per-frame call sites such as
 * [`DebrisField._updateInstanceTransform()`](js/entities/DebrisField.js:1228).
 *
 * @param {object} orbit              Orbit with semiMajorAxis in **scene units**.
 * @param {{x:number,y:number,z:number}} outPos   Mutated to scene-unit position.
 * @param {{x:number,y:number,z:number}} outVel   Mutated to km/s velocity.
 */
// Module-private scratch — only safe because `orbitToSceneCartesianInto` is
// single-threaded (no Atomics/Workers touch this) and we never re-enter the
// function before it returns. Two of these are used because the kmOrbit
// copy must not alias outPos. The kmOrbit scratch carries semiMajorAxis only;
// the rest of the orbit fields are read directly from `orbit`.
const _kmOrbitScratch = {
  semiMajorAxis: 0,
  eccentricity: 0,
  inclination: 0,
  raan: 0,
  argPerigee: 0,
  trueAnomaly: 0,
};
export function orbitToSceneCartesianInto(orbit, outPos, outVel) {
  _kmOrbitScratch.semiMajorAxis = sceneToKm(orbit.semiMajorAxis);
  _kmOrbitScratch.eccentricity = orbit.eccentricity;
  _kmOrbitScratch.inclination = orbit.inclination;
  _kmOrbitScratch.raan = orbit.raan;
  _kmOrbitScratch.argPerigee = orbit.argPerigee;
  _kmOrbitScratch.trueAnomaly = orbit.trueAnomaly;
  keplerianToCartesianInto(_kmOrbitScratch, outPos, outVel);
  outPos.x = kmToScene(outPos.x);
  outPos.y = kmToScene(outPos.y);
  outPos.z = kmToScene(outPos.z);
}
