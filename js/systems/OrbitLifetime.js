/**
 * @module systems/OrbitLifetime — how long a body stays up (DECISIONS §33 rows 16-17).
 *
 * Pure. A circular orbit decays under the game's own air (`atmosphericDrag` in OrbitalMechanics.js, Cd 2.2, no density
 * table of its own), stepped with RK2 down to LEO_STOP_KM (180 km, where it is gone). The area is the TUMBLING MEAN
 * (surface / 4 for a convex body; the row's `areaM2`, plus a drag sail's area when one is fitted), not the broadside.
 * Measured by probe: 1,400 kg, 12.3 m2: 38.6 / 95.6 years from 750 / 825 km with a 25 m2 sail added.
 *
 * `lifetimeYears(altKm, massKg, areaM2)`  years to fall from a circular orbit at altKm (Infinity if it never does)
 * `heightForYears(years, massKg, areaM2)` the circular height whose life is `years` (bisection, 200..1000 km)
 * `pushTargetKm(d)`                       where a push lets the piece go: its 24-year height, floored to 5 km
 * `sailLifeYears(d, altKm)`               its life with one drag sail fitted, let go at altKm
 * `dragAreaM2(d)`                         the piece's own drag area (a scoop bag: the sum over its members)
 */

import { Constants } from '../core/Constants.js';
import { atmosphericDrag } from '../entities/OrbitalMechanics.js';

const YEAR_S = 365.25 * 86400;
const LEO_STOP_KM = 180;        // below this the body is gone (the game's LEO_MIN_ALT)
const NEVER_YEARS = 1e4;        // longer than this counts as "never"

/**
 * Years a body takes to decay from a circular orbit at `altKm` to LEO_STOP_KM; `areaM2` is the drag area (tumbling mean,
 * plus any sail). Infinity when drag never brings it down (or inputs are not usable).
 */
export function lifetimeYears(altKm, massKg, areaM2) {
  if (!(massKg > 0) || !(areaM2 > 0) || !Number.isFinite(altKm)) return Infinity;
  const RE = Constants.EARTH_RADIUS_KM, mu = Constants.MU_EARTH;
  const rate = (a) => {            // da/dt, km/s
    const v = Math.sqrt(mu / a);
    return -2 * Math.sqrt(a * a * a / mu) * atmosphericDrag(a - RE, v, areaM2, massKg);
  };
  let a = RE + altKm, t = 0;
  while (a - RE > LEO_STOP_KM) {
    const r = rate(a);
    if (r > -1e-18) return Infinity;
    const dt = Math.min(5 * 86400, 0.2 * 20 / -r);
    const am = a + 0.5 * dt * r;
    a += dt * rate(am);
    t += dt;
    if (t > NEVER_YEARS * YEAR_S) return Infinity;
  }
  return t / YEAR_S;
}

/**
 * The piece's own drag area (tumbling mean, no sail). A scoop bag body has no `areaM2` of its own, so for a bag (`isBag`
 * with `bagMembers`) the area is the sum over its members: each member's `areaM2` (on the entry or on its `piece`), or,
 * when a member has none, a sphere's mean projected area, PI x size^2 / 4 (estimate). The bag's `mass` is already the
 * members' total. m2; 0 when nothing usable.
 */
export function dragAreaM2(d) {
  if (!d) return 0;
  if (d.isBag && Array.isArray(d.bagMembers) && d.bagMembers.length) {
    let sum = 0;
    for (const m of d.bagMembers) {
      const own = m.areaM2 > 0 ? m.areaM2 : (m.piece && m.piece.areaM2 > 0 ? m.piece.areaM2 : 0);
      const size = m.sizeMeter > 0 ? m.sizeMeter : (m.piece && m.piece.sizeMeter > 0 ? m.piece.sizeMeter : 0);
      sum += own > 0 ? own : Math.PI * size * size / 4;
    }
    return sum > 0 ? sum : 0;
  }
  return d.areaM2 > 0 ? d.areaM2 : 0;
}

/**
 * The circular height at which a body's life is `years`: km (200..1000); NaN when mass or area is not usable (the
 * bisection would otherwise return its 200 km floor, since an unusable body "never comes down": a silent wrong answer).
 */
export function heightForYears(years, massKg, areaM2) {
  if (!(massKg > 0) || !(areaM2 > 0)) return NaN;
  let lo = 200, hi = 1000;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (lifetimeYears(mid, massKg, areaM2) > years) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Where a push lets a big piece go: the height with 24 years of life (a year's margin on the 25-year rule), floored to
 * a whole 5 km step (the floor keeps the life under 24 years). `d` is the piece (or a scoop bag holding it: see
 * dragAreaM2). km; NaN when the piece has no usable mass or area (never the 200 km floor).
 */
export function pushTargetKm(d) {
  const B = Constants.BIG_PIECES;
  const h = heightForYears(B.PUSH_TARGET_YEARS, d.mass, dragAreaM2(d));
  if (!Number.isFinite(h)) return NaN;
  return Math.floor(h / B.PUSH_STEP_KM) * B.PUSH_STEP_KM;
}

/** The piece's life (years) when let go at `altKm` with one drag sail fitted (its own area plus the sail's). */
export function sailLifeYears(d, altKm) {
  return lifetimeYears(altKm, d.mass, dragAreaM2(d) + Constants.BIG_PIECES.SAIL.areaM2);
}
