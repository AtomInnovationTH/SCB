/**
 * startOrbitMath.js — pure per-language starting orbit; the one source for where the opening orbit sits, shared by
 * GameFlowManager._applyStartLocation() and MenuOrbitPreview so the two cannot drift. Node-safe: no DOM, no THREE.
 *
 * Three tweaks (the last two are documented in GameFlowManager): inclination from the language's launch latitude (incDeg);
 * ABEAM (START_ABEAM_DEG) re-aims the track so the home city slides ~200 km off starboard; LEAD
 * (START_TRACK_LEAD_DEG) backs the spawn off along-track so the city first appears ahead.
 *
 * @module systems/startOrbitMath
 */

import { subPointToOrbit, keplerianToCartesian } from '../entities/OrbitalMechanics.js';
import { latLonToUnitVec } from '../scene/Ephemeris.js';
import { degToRad, radToDeg, clamp } from '../core/MathUtil.js';

/** Cross-track offset: the home city passes ~200 km abeam (starboard). */
export const START_ABEAM_DEG = 1.8;
/** Along-track backoff so the city starts ahead and drifts abeam. */
export const START_TRACK_LEAD_DEG = 10;
/** Default inclination when a language omits incDeg (ISS band). */
export const DEFAULT_INC_DEG = 51.6;

const TWO_PI = 2 * Math.PI;

/**
 * Starting orbit for a language entry; null when it has no usable start anchor.
 * Inclination: the language's incDeg (Languages.js START-ORBIT MODEL), DEFAULT_INC_DEG when omitted.
 */
export function computeStartOrbit(lang) {
  const start = lang && lang.start;
  if (!start || !Number.isFinite(start.lat) || !Number.isFinite(start.lon)) return null;

  const incDeg = Number.isFinite(lang.incDeg) ? lang.incDeg : DEFAULT_INC_DEG;
  const inclination = degToRad(incDeg);
  const ascending = !(lang.descending === true);
  let { raan, trueAnomaly } = subPointToOrbit(start.lat, start.lon, inclination, ascending);

  // Abeam: take the orbit normal ĥ = r̂×v̂ of the direct-overhead aim, rotate the city direction toward +ĥ and
  // re-aim there; the city then sits along −ĥ = v̂×r̂ = starboard. If the aim latitude would pass the inclination,
  // subPointToOrbit clamps to the highest reachable parallel (still within ~1° of intent).
  const beta = degToRad(START_ABEAM_DEG);
  const probe = keplerianToCartesian({
    semiMajorAxis: 6771, eccentricity: 0.0001, inclination,
    raan, argPerigee: 0, trueAnomaly,
  });
  const r = probe.position, v = probe.velocity;
  const hx = r.y * v.z - r.z * v.y;
  const hy = r.z * v.x - r.x * v.z;
  const hz = r.x * v.y - r.y * v.x;
  const hl = Math.hypot(hx, hy, hz) || 1;
  const c = latLonToUnitVec(start.lat, start.lon);
  const cb = Math.cos(beta), sb = Math.sin(beta);
  const ax = c.x * cb + (hx / hl) * sb;
  const ay = c.y * cb + (hy / hl) * sb;
  const az = c.z * cb + (hz / hl) * sb;
  const aimLatDeg = radToDeg(Math.asin(clamp(ay, -1, 1)));
  const aimLonEastDeg = radToDeg(-Math.atan2(az, ax)); // inverse of latLonToUnitVec
  ({ raan, trueAnomaly } = subPointToOrbit(aimLatDeg, aimLonEastDeg, inclination, ascending));

  // Lead: spawn behind the abeam point (ν decreases against motion); inc/RAAN, so the ground track, are untouched.
  const lead = degToRad(START_TRACK_LEAD_DEG);
  trueAnomaly = (((trueAnomaly - lead) % TWO_PI) + TWO_PI) % TWO_PI;

  return { inclination, raan, trueAnomaly };
}

export default { computeStartOrbit, START_ABEAM_DEG, START_TRACK_LEAD_DEG, DEFAULT_INC_DEG };
