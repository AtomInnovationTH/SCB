/**
 * @module systems/OrbitPlanners — the two whole-field planning helpers (route planner + altitude sweep planner). PURE
 * functions only: no DOM, no canvas, no eventBus, no THREE. Plain Keplerian orbit-element objects in (semiMajorAxis in
 * SCENE units, matching entities/OrbitalMechanics.js), plain data out. Formatting/painting belongs to the consumer
 * (js/ui/TransferWindows.js). Fed by js/systems/NavcomFloor.js on the floor's refresh cadence (never per frame).
 */

import { Constants } from '../core/Constants.js';
import { sceneToKm, hohmannDeltaV, totalDeltaV } from '../entities/OrbitalMechanics.js';

/** @private Km-unit copy of a scene-unit orbit (semiMajorAxis only converted), for totalDeltaV / hohmannDeltaV which expect km. */
function _orbitToKm(orbit) {
  return {
    semiMajorAxis: sceneToKm(orbit.semiMajorAxis),
    eccentricity: orbit.eccentricity,
    inclination: orbit.inclination,
    raan: orbit.raan,
    argPerigee: orbit.argPerigee,
    trueAnomaly: orbit.trueAnomaly,
    meanMotion: orbit.meanMotion,
  };
}

/**
 * ΔV-optimal visit order over `targets`: greedy nearest-neighbour from the player's current orbit (true TSP is NP-hard;
 * greedy is enough for MAX_WAYPOINTS stops).
 * @param {Array<{orbit:object}>} targets — candidates with `.orbit` Keplerian elements (scene units); entries without
 *        `orbit.semiMajorAxis` are filtered out
 * @param {object} playerOrbit — player's current orbital elements (scene units)
 * @returns {{ plan: Array<{target:object, orbit:object, dvToReach:number, cumulativeDV:number}>, totalDv: number }}
 *          `plan` is the visit order (ΔV in km/s per leg + running total); `totalDv` the summed ΔV (km/s).
 *          Empty input (or no valid candidates) → `{ plan: [], totalDv: 0 }`.
 */
export function computeRoutePlan(targets, playerOrbit) {
  if (!targets || targets.length === 0 || !playerOrbit) {
    return { plan: [], totalDv: 0 };
  }

  const maxWP = (Constants.ROUTE_PLANNER && Constants.ROUTE_PLANNER.MAX_WAYPOINTS) || 6;
  const candidates = targets
    .filter(t => t && t.orbit && t.orbit.semiMajorAxis)
    .slice(0, maxWP * 2); // take more than needed for selection

  if (candidates.length === 0) {
    return { plan: [], totalDv: 0 };
  }

  const playerKm = _orbitToKm(playerOrbit);

  const visited = [];
  const remaining = [...candidates];
  let currentOrbitKm = playerKm;
  let totalDV = 0;

  while (visited.length < maxWP && remaining.length > 0) {
    let bestIdx = 0;
    let bestDV = Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const targetKm = _orbitToKm(remaining[i].orbit);
      const dv = totalDeltaV(currentOrbitKm, targetKm);
      if (dv < bestDV) {
        bestDV = dv;
        bestIdx = i;
      }
    }

    const chosen = remaining.splice(bestIdx, 1)[0];
    totalDV += bestDV;

    visited.push({
      target: chosen,
      orbit: chosen.orbit,
      dvToReach: bestDV,
      cumulativeDV: totalDV,
    });

    currentOrbitKm = _orbitToKm(chosen.orbit);
  }

  return { plan: visited, totalDv: totalDV };
}

/**
 * Debris-density altitude bands (200–800 km, 50 km wide) and the best sweep target: the densest reachable band,
 * discounting (×0.5) the band the player is already inside.
 * @param {Array<{orbit:object}>} candidates — objects with `.orbit` Keplerian elements (scene units); entries without
 *        `orbit.semiMajorAxis` are filtered out
 * @param {number} playerAltKm — player altitude above Earth's surface (km)
 * @returns {{
 *   bands: Array<{altMin:number, altMax:number, midAlt:number, count:number, density:number}>,
 *   densest: {altMinKm:number, altMaxKm:number, count:number, dv:number}|null
 * }} `bands` covers the whole sweep range (always populated, even when empty); `densest` is null when no band has candidates.
 */
export function computeSweepBands(candidates, playerAltKm) {
  const list = (candidates || []).filter(t => t && t.orbit && t.orbit.semiMajorAxis);

  const BAND_W = 50;    // km per band
  const ALT_MIN = 200;  // km — lower LEO bound
  const ALT_MAX = 800;  // km — upper sweep bound
  const nBands = Math.ceil((ALT_MAX - ALT_MIN) / BAND_W);

  const bands = [];
  for (let i = 0; i < nBands; i++) {
    bands.push({
      altMin: ALT_MIN + i * BAND_W,
      altMax: ALT_MIN + (i + 1) * BAND_W,
      midAlt: ALT_MIN + (i + 0.5) * BAND_W,
      count: 0,
      density: 0,
    });
  }

  let maxCount = 0;
  for (const t of list) {
    const alt = sceneToKm(t.orbit.semiMajorAxis) - Constants.EARTH_RADIUS_KM;
    const idx = Math.floor((alt - ALT_MIN) / BAND_W);
    if (idx >= 0 && idx < nBands) {
      bands[idx].count++;
      if (bands[idx].count > maxCount) maxCount = bands[idx].count;
    }
  }

  for (const b of bands) {
    b.density = maxCount > 0 ? b.count / maxCount : 0;
  }

  let bestIdx = -1;
  let bestScore = -1;
  for (let i = 0; i < nBands; i++) {
    if (bands[i].count === 0) continue;
    const inBand = playerAltKm >= bands[i].altMin && playerAltKm < bands[i].altMax;
    const score = inBand ? bands[i].count * 0.5 : bands[i].count;
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }

  let densest = null;
  if (bestIdx >= 0) {
    const b = bands[bestIdx];
    const r1 = Constants.EARTH_RADIUS_KM + playerAltKm;
    const r2 = Constants.EARTH_RADIUS_KM + b.midAlt;
    const hoh = hohmannDeltaV(r1, r2);
    densest = { altMinKm: b.altMin, altMaxKm: b.altMax, count: b.count, dv: hoh.total };
  }

  return { bands, densest };
}
