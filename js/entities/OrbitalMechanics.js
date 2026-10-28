/**
 * OrbitalMechanics.js - orbital mechanics utilities. Real units (km, km/s) unless noted; × SCENE_SCALE for Three.js rendering.
 * @module entities/OrbitalMechanics
 */

import { Constants } from '../core/Constants.js';
import { degToRad, radToDeg, clamp } from '../core/MathUtil.js';

/** Solve Kepler's equation M = E − e sin E by Newton-Raphson (M, E in rad; `tol` default 1e-10). */
export function solveKepler(M, e, tol = 1e-10) {
  let E = M + e * Math.sin(M);
  for (let i = 0; i < 30; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < tol) break;
  }
  return E;
}

/** Mean anomaly → true anomaly (rad). */
export function meanToTrueAnomaly(M, e) {
  const E = solveKepler(M, e);
  const sinV = (Math.sqrt(1 - e * e) * Math.sin(E)) / (1 - e * Math.cos(E));
  const cosV = (Math.cos(E) - e) / (1 - e * Math.cos(E));
  return Math.atan2(sinV, cosV);
}

/** True anomaly → mean anomaly (rad). */
export function trueToMeanAnomaly(v, e) {
  const E = Math.atan2(
    Math.sqrt(1 - e * e) * Math.sin(v),
    e + Math.cos(v)
  );
  return E - e * Math.sin(E);
}

/**
 * Keplerian elements (semiMajorAxis in km, angles in rad) → Cartesian position (km) and velocity (km/s); `mu` in km³/s².
 * @returns {{ position: {x,y,z}, velocity: {x,y,z} }}
 */
export function keplerianToCartesian(orbit, mu = Constants.MU_EARTH) {
  const { semiMajorAxis: a, eccentricity: e, inclination: i,
          raan: Ω, argPerigee: ω, trueAnomaly: ν } = orbit;

  const p = a * (1 - e * e);

  const r = p / (1 + e * Math.cos(ν));

  const xP = r * Math.cos(ν);
  const yP = r * Math.sin(ν);

  const sqrtMuP = Math.sqrt(mu / p);
  const vxP = -sqrtMuP * Math.sin(ν);
  const vyP = sqrtMuP * (e + Math.cos(ν));

  // Rotation matrices: perifocal → ECI
  const cosΩ = Math.cos(Ω), sinΩ = Math.sin(Ω);
  const cosω = Math.cos(ω), sinω = Math.sin(ω);
  const cosI = Math.cos(i), sinI = Math.sin(i);

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
 * Cartesian state → Keplerian elements.
 *
 * **Frame convention:** input (position km, velocity km/s) is in the same Y-up scene frame produced by `keplerianToCartesian`, i.e.
 * Three.js coordinates where the orbital angular-momentum axis is Y. Internally `y ↔ z` are swapped to work in the textbook Z-up ECI
 * frame, so the round-trip `keplerianToCartesian(cartesianToKeplerian(r, v)) == (r, v)` holds.
 */
export function cartesianToKeplerian(position, velocity, mu = Constants.MU_EARTH) {
  // --- Scene Y-up → standard Z-up (swap y and z) ---
  const px = position.x, py = position.z, pz = position.y;
  const vx = velocity.x, vy = velocity.z, vz = velocity.y;

  const r = Math.sqrt(px * px + py * py + pz * pz);
  const v = Math.sqrt(vx * vx + vy * vy + vz * vz);

  const hx = py * vz - pz * vy;
  const hy = pz * vx - px * vz;
  const hz = px * vy - py * vx;
  const h = Math.sqrt(hx * hx + hy * hy + hz * hz);

  const nx = -hy;
  const ny = hx;
  const n = Math.sqrt(nx * nx + ny * ny);

  const rdotv = px * vx + py * vy + pz * vz;
  const ex = ((v * v - mu / r) * px - rdotv * vx) / mu;
  const ey = ((v * v - mu / r) * py - rdotv * vy) / mu;
  const ez = ((v * v - mu / r) * pz - rdotv * vz) / mu;
  const e = Math.sqrt(ex * ex + ey * ey + ez * ez);

  const energy = v * v / 2 - mu / r;
  const a = -mu / (2 * energy);

  const i = Math.acos(clamp(hz / h, -1, 1));

  let raan = 0;
  if (n > 1e-10) {
    raan = Math.acos(clamp(nx / n, -1, 1));
    if (ny < 0) raan = 2 * Math.PI - raan;
  }

  // Argument of perigee (requires a defined line of nodes AND non-circular orbit)
  let argP = 0;
  if (n > 1e-10 && e > 1e-10) {
    argP = Math.acos(clamp((nx * ex + ny * ey) / (n * e), -1, 1));
    if (ez < 0) argP = 2 * Math.PI - argP;
  }

  // True anomaly. For near-circular orbits the eccentricity vector is
  // numerically noisy, so fall back to the argument of latitude (angle from
  // ascending node in the orbital plane) and treat ω = 0. This keeps the
  // round-trip position-preserving for the player's default circular orbit.
  let trueAnomaly = 0;
  if (e > 1e-10) {
    trueAnomaly = Math.acos(clamp((ex * px + ey * py + ez * pz) / (e * r), -1, 1));
    if (rdotv < 0) trueAnomaly = 2 * Math.PI - trueAnomaly;
  } else if (n > 1e-10) {
    // Circular inclined orbit — use argument of latitude u = ν + ω, with ω=0.
    trueAnomaly = Math.acos(clamp((nx * px + ny * py) / (n * r), -1, 1));
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

/**
 * Re-seat an orbit from a shown scene position + a release velocity: the ONE orbit-rebuild computation for every held-cargo release.
 * A pinned catch's own orbit is NOT frozen while `_armPinned` (DebrisField skips propagation only for `_onboardingPinned` /
 * `_motherParked`), so releasing to the stale orbit snaps the body to wherever the orbit drifted during the hold; rebuilding from the
 * shown position makes the released body continue from where the player last saw it. Shared by the mother [K] jettison
 * (CaptureNetSystem._reseatOrbitOnRelease) and the ArmManager.reset() cargo release.
 *
 * Frame/units follow applyCartesianImpulse: scene units ÷ Constants.SCENE_SCALE → km in the Y-up scene frame; velocity in km/s;
 * `orbit.semiMajorAxis` is stored back in SCENE UNITS (the DebrisField / PlayerSatellite convention). Eccentricity clamps to [0, 0.1]
 * (the co-orbital field band).
 *
 * @param {object} orbit  the orbit to rewrite (mutated on success only)
 * @param {{x:number,y:number,z:number}} scenePos  shown position (scene units, Y-up)
 * @param {{x:number,y:number,z:number}} velocityKmS  release velocity (km/s, Y-up scene frame)
 * @returns {boolean} true when re-seated; false on any degenerate input (missing refs, non-positive SCENE_SCALE, NaN/∞ element, or
 *          non-positive semi-major axis): the caller releases to the live orbit instead, and the orbit is left untouched.
 */
export function reseatOrbitFromScene(orbit, scenePos, velocityKmS) {
  const SCENE_SCALE = Constants.SCENE_SCALE;
  if (!orbit || !scenePos || !velocityKmS || !(SCENE_SCALE > 0)) return false;
  const rKm = {
    x: scenePos.x / SCENE_SCALE,
    y: scenePos.y / SCENE_SCALE,
    z: scenePos.z / SCENE_SCALE,
  };
  const newOrbit = cartesianToKeplerian(rKm, { x: velocityKmS.x, y: velocityKmS.y, z: velocityKmS.z });
  // Validate EVERY element before writing: inclination comes from acos(hz/h) and is NaN on the degenerate h=0 geometry (radial release
  // velocity), so an unchecked write could permanently corrupt the orbit with NaN.
  if (!newOrbit
      || !isFinite(newOrbit.semiMajorAxis) || newOrbit.semiMajorAxis <= 0
      || !isFinite(newOrbit.eccentricity)
      || !isFinite(newOrbit.inclination)
      || !isFinite(newOrbit.raan)
      || !isFinite(newOrbit.argPerigee)
      || !isFinite(newOrbit.trueAnomaly)) return false;
  orbit.semiMajorAxis = newOrbit.semiMajorAxis * SCENE_SCALE;
  orbit.eccentricity  = clamp(newOrbit.eccentricity, 0, 0.1);
  orbit.inclination   = newOrbit.inclination;
  orbit.raan          = newOrbit.raan;
  orbit.argPerigee    = newOrbit.argPerigee;
  orbit.trueAnomaly   = newOrbit.trueAnomaly;
  if (typeof newOrbit.meanMotion === 'number' && isFinite(newOrbit.meanMotion)) {
    orbit.meanMotion = newOrbit.meanMotion;
  }
  return true;
}

/**
 * RAAN + true anomaly that put a satellite's sub-satellite point (ground track) directly over a geographic point at t=0.
 *
 * **Frame assumptions:**
 *  - Orbit frame is Y-up (Y = polar axis), see `keplerianToCartesian`.
 *  - The visual Earth mesh does NOT rotate (no GMST applied to geometry), so the ECI longitude equals the *negative* of the geographic
 *    east-longitude because the equirectangular Earth texture is longitude-mirrored (`mirrorLon` in main.js / CityLabels).
 *  - Circular orbit with argPerigee = 0 (the player's default).
 *
 * Sub-point latitude is bounded by inclination; if `|lat| > inclination` it is clamped to the highest reachable parallel
 * (true anomaly = ±90°).
 *
 * @param {number} latDeg        degrees north (negative = south)
 * @param {number} lonEastDeg    degrees east (negative = west)
 * @param {number} inclinationRad
 * @param {boolean} [ascending=true] place on the northbound (ascending) pass
 * @returns {{ raan: number, trueAnomaly: number }} radians, both in [0, 2π)
 */
export function subPointToOrbit(latDeg, lonEastDeg, inclinationRad, ascending = true) {
  const TWO_PI = 2 * Math.PI;
  const norm = (a) => ((a % TWO_PI) + TWO_PI) % TWO_PI;

  const lat = degToRad(latDeg);
  const inc = inclinationRad;
  const sinInc = Math.sin(inc);

  // ν such that lat = asin(sinInc · sinν); clamp when |lat| > inc.
  let ratio = Math.abs(sinInc) < 1e-9 ? 0 : Math.sin(lat) / sinInc;
  ratio = clamp(ratio, -1, 1);
  let nu = Math.asin(ratio);
  if (!ascending) nu = Math.PI - nu;

  // Longitude of the sub-point relative to the ascending node, projected into
  // the equatorial plane: u_proj = atan2(cosI·sinν, cosν).
  const uProj = Math.atan2(Math.cos(inc) * Math.sin(nu), Math.cos(nu));

  // ECI longitude is the mirror of geographic east-longitude (fixed Earth mesh).
  const lonEci = degToRad(-lonEastDeg);

  return {
    raan: norm(lonEci - uProj),
    trueAnomaly: norm(nu),
  };
}

/**
 * The sub-satellite point (geographic latitude / east longitude) under a position: the inverse of `latLonToUnitVec` (js/scene/Ephemeris.js)
 * and the other half of `subPointToOrbit`'s frame law: Y is the polar axis, (0°, 0°) is +X, and geographic EAST longitude runs toward −Z
 * because the equirectangular Earth texture is longitude-mirrored (the visual Earth does not rotate). Direction only: the position may be in
 * km or scene units, any length > 0.
 *
 *   lat     = asin(y / r)
 *   lonEast = −atan2(z, x)            (in (−180, 180], degrees)
 *
 * @param {{x:number, y:number, z:number}} pos  any unit; the zero vector → (0, 0)
 * @returns {{ latDeg: number, lonEastDeg: number }}
 */
export function subSatellitePoint(pos) {
  const x = Number(pos && pos.x), y = Number(pos && pos.y), z = Number(pos && pos.z);
  const r = Math.sqrt(x * x + y * y + z * z);
  if (!(r > 0) || !Number.isFinite(r)) return { latDeg: 0, lonEastDeg: 0 };
  const latDeg = radToDeg(Math.asin(clamp(y / r, -1, 1)));
  let lonEastDeg = radToDeg(-Math.atan2(z, x));
  if (lonEastDeg <= -180) lonEastDeg += 360;      // atan2 = π exactly → keep the +180 branch
  return { latDeg, lonEastDeg };
}

/**
 * Advance the orbit by `dt` seconds (game time, already scaled) via mean anomaly. Mutates trueAnomaly (and meanAnomaly if present) and
 * returns the same object; semiMajorAxis in km.
 */
export function propagateOrbit(orbit, dt, mu = Constants.MU_EARTH) {
  const a = orbit.semiMajorAxis;
  const e = orbit.eccentricity;
  const n = Math.sqrt(mu / (a * a * a));

  let M = trueToMeanAnomaly(orbit.trueAnomaly, e);

  M += n * dt;

  M = ((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

  orbit.trueAnomaly = meanToTrueAnomaly(M, e);
  orbit.meanMotion = n;

  return orbit;
}

/** Vis-viva orbital speed (km/s) at radius r (km) on an orbit of semi-major axis a (km): v = sqrt(μ (2/r − 1/a)). */
export function orbitalVelocity(a, r, mu = Constants.MU_EARTH) {
  return Math.sqrt(mu * (2 / r - 1 / a));
}

/** Hohmann transfer between two circular orbits of radius r1, r2 (km): dv1/dv2 in km/s, transferTime (half the transfer ellipse's period) in s. */
export function hohmannDeltaV(r1, r2, mu = Constants.MU_EARTH) {
  const aT = (r1 + r2) / 2;

  const v1 = Math.sqrt(mu / r1);
  const vT1 = Math.sqrt(mu * (2 / r1 - 1 / aT));
  const dv1 = Math.abs(vT1 - v1);

  const v2 = Math.sqrt(mu / r2);
  const vT2 = Math.sqrt(mu * (2 / r2 - 1 / aT));
  const dv2 = Math.abs(v2 - vT2);

  const transferTime = Math.PI * Math.sqrt(aT * aT * aT / mu);

  return { dv1, dv2, total: dv1 + dv2, transferTime };
}

/** Single-burn plane-change Δv (km/s) for a velocity (km/s) and an inclination change (rad). */
export function planeChangeDeltaV(velocity, deltaInclination) {
  return 2 * velocity * Math.sin(Math.abs(deltaInclination) / 2);
}

/** Estimated total Δv (km/s) between two Keplerian orbits (km): Hohmann altitude change + simple plane change. */
export function totalDeltaV(orbit1, orbit2, mu = Constants.MU_EARTH) {
  const r1 = orbit1.semiMajorAxis;
  const r2 = orbit2.semiMajorAxis;

  const hohmann = hohmannDeltaV(r1, r2, mu);

  const v2 = Math.sqrt(mu / r2);
  const deltaI = Math.abs(orbit2.inclination - orbit1.inclination);
  const planeChange = planeChangeDeltaV(v2, deltaI);

  return hohmann.total + planeChange;
}

/** ΔV (m/s) from using salvaged metal as propellant (Tsiolkovsky); masses in kg, `isp` in s. */
export function computeSalvageDeltaV(metalMassKg, isp, dryMassKg) {
  if (metalMassKg <= 0 || isp <= 0 || dryMassKg <= 0) return 0;
  const g0 = Constants.G0; // m/s²
  const exhaustVelocity = isp * g0;
  const massRatio = (dryMassKg + metalMassKg) / dryMassKg;
  return exhaustVelocity * Math.log(massRatio);
}

/** Total salvageable ΔV (m/s) from a mixed bag of metals: per-type Isp, summed (an approximation, fine for gameplay). */
export function computeTotalSalvageDeltaV(metals, dryMassKg) {
  let totalDV = 0;
  for (const metal of metals) {
    if (metal.ispAsThrust > 0 && metal.massKg > 0) {
      totalDV += computeSalvageDeltaV(metal.massKg, metal.ispAsThrust, dryMassKg);
    }
  }
  return totalDV;
}

/** Is a position in Earth's shadow (cylindrical model)? `earthRadius` is in the position's units; `sunDirection` is normalised. */
export function isInShadow(position, sunDirection, earthRadius) {
  const dot = position.x * sunDirection.x +
              position.y * sunDirection.y +
              position.z * sunDirection.z;

  if (dot > 0) return false;

  const projX = position.x - dot * sunDirection.x;
  const projY = position.y - dot * sunDirection.y;
  const projZ = position.z - dot * sunDirection.z;
  const distFromLine = Math.sqrt(projX * projX + projY * projY + projZ * projZ);

  return distFromLine < earthRadius;
}

/** Module-private scratch for nextShadowTransition (single-threaded, never re-entered). */
const _nstOrbit = { semiMajorAxis: 0, eccentricity: 0, inclination: 0, raan: 0, argPerigee: 0, trueAnomaly: 0 };
const _nstPos = { x: 0, y: 0, z: 0 };
const _nstVel = { x: 0, y: 0, z: 0 };
const _nstSun = { x: 0, y: 0, z: 0 };

/**
 * When does the ship next cross the shadow terminator? Both bodies move: the orbit advances in WORLD time (dtWorld = t_real × rate ×
 * baseScale, the same law as the game loop) while the sun direction is a function of REAL time (SunLight.update(dt) is fed the real dt: the
 * sun never warps with the floor's time cap). At ~400 km with rate 1 the two turn at the same angular rate, so the shadow geometry is
 * nearly frozen there and the transitions come on the warped floors; a predictor that held the sun still would lie.
 *
 * Method: sample the coming orbital period (in real seconds) at `samples` steps; the first sample whose `isInShadow` differs from the
 * t = 0 state brackets the flip, refined by 6 bisection steps (precision = the sample spacing / 64). No sample differs → no flip within
 * one orbit.
 *
 * @param {object} orbit  Keplerian elements with semiMajorAxis in KM (use `orbitToKm` on a scene-unit orbit), angles in rad.
 * @param {(aheadRealS:number, out:{x:number,y:number,z:number}) => {x:number,y:number,z:number}} sunDirAt
 *   The (unit) sun direction `aheadRealS` REAL seconds from now (SunLight.directionAt); may write into `out` or return its own vector.
 * @param {object} [opts]
 * @param {number} [opts.rate=1]          TimeAuthority.rate (world seconds per BASE_SCALE real second)
 * @param {number} [opts.baseScale=1]     TimeAuthority.BASE_SCALE
 * @param {number} [opts.samples=96]      samples over one orbital period
 * @param {number} [opts.earthRadius=Constants.EARTH_RADIUS_KM]  km (the orbit's unit)
 * @returns {{ inShadow: boolean, secondsToFlipReal: number|null }}  inShadow = the t = 0 state; secondsToFlipReal in REAL seconds
 *   (× rate × baseScale for world seconds), null when no flip lies within one orbit, when the clock is stopped (rate ≤ 0) or when the
 *   inputs are unusable.
 */
export function nextShadowTransition(orbit, sunDirAt, opts = {}) {
  const rate = Number.isFinite(opts.rate) ? opts.rate : 1;
  const baseScale = Number.isFinite(opts.baseScale) ? opts.baseScale : 1;
  const samples = Math.max(2, (opts.samples | 0) || 96);
  const earthRadius = Number.isFinite(opts.earthRadius) ? opts.earthRadius : Constants.EARTH_RADIUS_KM;
  const mu = Number.isFinite(opts.mu) ? opts.mu : Constants.MU_EARTH;

  const a = orbit ? Number(orbit.semiMajorAxis) : NaN;
  if (typeof sunDirAt !== 'function' || !(a > 0) || !Number.isFinite(a)) {
    return { inShadow: false, secondsToFlipReal: null };
  }
  const o = _nstOrbit;
  o.semiMajorAxis = a;
  o.eccentricity = Number(orbit.eccentricity) || 0;
  o.inclination = Number(orbit.inclination) || 0;
  o.raan = Number(orbit.raan) || 0;
  o.argPerigee = Number(orbit.argPerigee) || 0;
  const nu0 = Number(orbit.trueAnomaly) || 0;

  /** The shadow state `tReal` real seconds ahead (orbit advanced in world seconds, sun in real). */
  const stateAt = (tReal) => {
    o.trueAnomaly = nu0;
    if (tReal > 0) propagateOrbit(o, tReal * rate * baseScale, mu);
    keplerianToCartesianInto(o, _nstPos, _nstVel, mu);
    const s = sunDirAt(tReal, _nstSun);
    // an unusable sun sample aborts the prediction (null), never the previous sample's scratch vector
    if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(s.z)) return null;
    return isInShadow(_nstPos, s, earthRadius);
  };

  const now = stateAt(0);
  if (now === null) return { inShadow: false, secondsToFlipReal: null };
  const scale = rate * baseScale;
  if (!(scale > 0) || !Number.isFinite(scale)) return { inShadow: now, secondsToFlipReal: null };

  const periodWorld = 2 * Math.PI * Math.sqrt(a * a * a / mu);
  const horizonReal = periodWorld / scale;
  if (!(horizonReal > 0) || !Number.isFinite(horizonReal)) return { inShadow: now, secondsToFlipReal: null };

  const step = horizonReal / samples;
  let lo = 0;
  for (let i = 1; i <= samples; i++) {
    let hi = i * step;
    const st = stateAt(hi);
    if (st === null) return { inShadow: now, secondsToFlipReal: null };
    if (st !== now) {
      for (let k = 0; k < 6; k++) {
        const mid = (lo + hi) / 2;
        const sm = stateAt(mid);
        if (sm === null) return { inShadow: now, secondsToFlipReal: null };
        if (sm === now) lo = mid; else hi = mid;
      }
      return { inShadow: now, secondsToFlipReal: hi };
    }
    lo = hi;
  }
  return { inShadow: now, secondsToFlipReal: null };
}

/**
 * Atmospheric density (kg/m^3), piecewise exponential. The table is Vallado's exponential model, every row 0-1000 km verbatim:
 * D. A. Vallado, "Fundamentals of Astrodynamics and Applications", 4th ed. (2013), exponential atmospheric model. Reproduction used:
 * https://raw.githubusercontent.com/JuliaSpace/SatelliteToolboxAtmosphericModels.jl/main/src/exponential/constants.jl
 * It is the MEAN-solar-activity air (rows 100-180 km equal the CIRA mean values). Above 1000 km the density is 0; below 0 km it is the
 * sea-level 1.225. See docs/research/2026-10-trips-by-height.md.
 *
 * @param {number} altitudeKm - Altitude above Earth surface (km)
 * @returns {number} Atmospheric density (kg/m^3)
 */
export function atmosphericDensity(altitudeKm) {
  if (altitudeKm < 0) return 1.225;
  if (altitudeKm > 1000) return 0;

  // Reference rows: base altitude h (km), base density rho (kg/m^3), scale height H (km)
  const layers = [
    { h: 0, rho: 1.225, H: 7.249 },
    { h: 25, rho: 3.899e-2, H: 6.349 },
    { h: 30, rho: 1.774e-2, H: 6.682 },
    { h: 40, rho: 3.972e-3, H: 7.554 },
    { h: 50, rho: 1.057e-3, H: 8.382 },
    { h: 60, rho: 3.206e-4, H: 7.714 },
    { h: 70, rho: 8.770e-5, H: 6.549 },
    { h: 80, rho: 1.905e-5, H: 5.799 },
    { h: 90, rho: 3.396e-6, H: 5.382 },
    { h: 100, rho: 5.297e-7, H: 5.877 },
    { h: 110, rho: 9.661e-8, H: 7.263 },
    { h: 120, rho: 2.438e-8, H: 9.473 },
    { h: 130, rho: 8.484e-9, H: 12.636 },
    { h: 140, rho: 3.845e-9, H: 16.149 },
    { h: 150, rho: 2.070e-9, H: 22.523 },
    { h: 180, rho: 5.464e-10, H: 29.740 },
    { h: 200, rho: 2.789e-10, H: 37.105 },
    { h: 250, rho: 7.248e-11, H: 45.546 },
    { h: 300, rho: 2.418e-11, H: 53.628 },
    { h: 350, rho: 9.518e-12, H: 53.298 },
    { h: 400, rho: 3.725e-12, H: 58.515 },
    { h: 450, rho: 1.585e-12, H: 60.828 },
    { h: 500, rho: 6.967e-13, H: 63.822 },
    { h: 600, rho: 1.454e-13, H: 71.835 },
    { h: 700, rho: 3.614e-14, H: 88.667 },
    { h: 800, rho: 1.170e-14, H: 124.64 },
    { h: 900, rho: 5.245e-15, H: 181.05 },
    { h: 1000, rho: 3.019e-15, H: 268.00 },
  ];

  let layer = layers[0];
  for (let j = layers.length - 1; j >= 0; j--) {
    if (altitudeKm >= layers[j].h) {
      layer = layers[j];
      break;
    }
  }

  return layer.rho * Math.exp(-(altitudeKm - layer.h) / layer.H);
}

/** Atmospheric drag deceleration (km/s²): `altitudeKm` km, `velocity` km/s, `area` m², `mass` kg, `cd` default 2.2. */
export function atmosphericDrag(altitudeKm, velocity, area, mass, cd = 2.2) {
  const rho = atmosphericDensity(altitudeKm);
  // velocity in km/s → m/s for drag equation
  const vMs = velocity * 1000;
  const dragForce = 0.5 * rho * vMs * vMs * cd * area;
  // Deceleration in m/s² → km/s²
  return (dragForce / mass) / 1000;
}

export function kmToScene(km) {
  return km * Constants.SCENE_SCALE;
}

export function sceneToKm(sceneUnits) {
  return sceneUnits / Constants.SCENE_SCALE;
}

/** Orbit copy with semiMajorAxis converted from scene units to km. */
export function orbitToKm(orbit) {
  return {
    ...orbit,
    semiMajorAxis: sceneToKm(orbit.semiMajorAxis),
  };
}

/** Cartesian position (scene units) and velocity (km/s) from a scene-unit orbit. */
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

// Scratch-output ("Into") variants: the same math as `keplerianToCartesian` and `orbitToSceneCartesian`, but written into caller-provided
// `{x,y,z}` objects so per-frame call sites avoid allocating. The allocating versions remain for back-compat and tests.

/** Cartesian state from Keplerian elements (km, rad) into caller-owned `outPos` (km) and `outVel` (km/s); returns nothing, no allocation. */
export function keplerianToCartesianInto(orbit, outPos, outVel, mu = Constants.MU_EARTH) {
  const { semiMajorAxis: a, eccentricity: e, inclination: i,
          raan: Ω, argPerigee: ω, trueAnomaly: ν } = orbit;

  const p = a * (1 - e * e);

  const r = p / (1 + e * Math.cos(ν));

  const xP = r * Math.cos(ν);
  const yP = r * Math.sin(ν);

  const sqrtMuP = Math.sqrt(mu / p);
  const vxP = -sqrtMuP * Math.sin(ν);
  const vyP = sqrtMuP * (e + Math.cos(ν));

  const cosΩ = Math.cos(Ω), sinΩ = Math.sin(Ω);
  const cosω = Math.cos(ω), sinω = Math.sin(ω);
  const cosI = Math.cos(i), sinI = Math.sin(i);

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
 * Scene-unit Cartesian state from a scene-unit Keplerian orbit, into caller-owned scratch: `outPos` in scene units (km converted),
 * `outVel` left in km/s (the physics that consumes it stays in km/s). Allocation-free for per-frame call sites such as
 * DebrisField._updateInstanceTransform.
 */
// Module-private scratch: single-threaded and never re-entered before the function returns. Two are used because the kmOrbit copy must
// not alias outPos. The kmOrbit scratch carries semiMajorAxis only; the rest is read directly from `orbit`.
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
