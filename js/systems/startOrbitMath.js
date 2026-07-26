/**
 * startOrbitMath.js — pure computation of the per-language starting orbit.
 *
 * Single source of truth for WHERE the player's opening orbit sits, shared by
 * GameFlowManager._applyStartLocation() (writes it to the player on every game
 * start path) and MenuOrbitPreview (eases the live menu backdrop to it when the
 * language changes). Extracted so the two can never drift.
 *
 * The staging has three tweaks (documented in GameFlowManager):
 *  • INCLINATION from the language's real launch latitude (Languages.incDeg).
 *  • ABEAM (START_ABEAM_DEG): the track is re-aimed at a point offset
 *    perpendicular to the pass, so the home city slides ~200 km off STARBOARD
 *    instead of vanishing under the nose.
 *  • LEAD (START_TRACK_LEAD_DEG): the spawn is backed off along-track so the
 *    city first appears AHEAD, then drifts abeam.
 *
 * Pure + Node-safe: no DOM, no THREE, no singletons.
 *
 * @module systems/startOrbitMath
 */

import { subPointToOrbit, keplerianToCartesian } from '../entities/OrbitalMechanics.js';
import { latLonToUnitVec } from '../scene/Ephemeris.js';

/** Cross-track offset so the home city passes ~200 km abeam (starboard). */
export const START_ABEAM_DEG = 1.8;
/** Along-track backoff so the city starts ahead and drifts abeam. */
export const START_TRACK_LEAD_DEG = 10;
/** Default inclination when a language omits incDeg (ISS band). */
export const DEFAULT_INC_DEG = 51.6;

const TWO_PI = 2 * Math.PI;

/**
 * Compute the starting orbit for a language entry.
 * @param {{start?:{lat:number,lon:number}, incDeg?:number, descending?:boolean}} lang
 * @returns {{inclination:number, raan:number, trueAnomaly:number}|null}
 *   null when the language has no usable start anchor.
 */
export function computeStartOrbit(lang) {
  const start = lang && lang.start;
  if (!start || !Number.isFinite(start.lat) || !Number.isFinite(start.lon)) return null;

  const incDeg = Number.isFinite(lang.incDeg) ? lang.incDeg : DEFAULT_INC_DEG;
  const inclination = incDeg * Math.PI / 180;
  const ascending = !(lang.descending === true);
  let { raan, trueAnomaly } = subPointToOrbit(start.lat, start.lon, inclination, ascending);

  // ── Cross-track offset: pass the city abeam, not underneath ──
  // Offset PERPENDICULAR to the pass: take the orbit normal ĥ = r̂×v̂ of the
  // direct-overhead aim, rotate the city direction START_ABEAM_DEG toward +ĥ,
  // and re-aim at that point. City then sits along −ĥ = v̂×r̂ = starboard of
  // the track, a uniform ~200 km for every language. If the offset nudges the
  // aim latitude past the inclination, subPointToOrbit clamps to the highest
  // reachable parallel — still within ~1° of the intent.
  const beta = START_ABEAM_DEG * Math.PI / 180;
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
  const aimLatDeg = Math.asin(Math.max(-1, Math.min(1, ay))) * 180 / Math.PI;
  const aimLonEastDeg = -Math.atan2(az, ax) * 180 / Math.PI; // inverse of latLonToUnitVec
  ({ raan, trueAnomaly } = subPointToOrbit(aimLatDeg, aimLonEastDeg, inclination, ascending));

  // ── Along-track lead: spawn behind the abeam point so the city appears
  // ahead first. ν decreases against the direction of motion; inc/RAAN — and
  // therefore the ground track — are untouched.
  const lead = START_TRACK_LEAD_DEG * Math.PI / 180;
  trueAnomaly = (((trueAnomaly - lead) % TWO_PI) + TWO_PI) % TWO_PI;

  return { inclination, raan, trueAnomaly };
}

export default { computeStartOrbit, START_ABEAM_DEG, START_TRACK_LEAD_DEG, DEFAULT_INC_DEG };
