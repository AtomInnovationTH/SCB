/**
 * MoidCalculator.js — Minimum Orbit Intersection Distance between two osculating Keplerian orbits, by N×N sampling plus an
 * optional refinement pass. Gameplay-grade (enough for HI/MD/LO badges), not astrodynamics-paper-grade.
 * Pure functions, no Three.js dependency, CJS-compatible for Node tests.
 * @module systems/MoidCalculator
 */

import { Constants } from '../core/Constants.js';
import { solveKepler } from '../entities/OrbitalMechanics.js';

const TWO_PI = 2 * Math.PI;


/**
 * Normalise an orbit to km-based elements. Accepts `{ semiMajorAxis_m }` (metres ÷1000) or `{ semiMajorAxis }` (scene
 * units ÷SCENE_SCALE); returns null for missing or non-positive axes.
 */
function _normaliseToKm(orbit) {
  if (!orbit) return null;

  let a_km;
  if (orbit.semiMajorAxis_m !== undefined && orbit.semiMajorAxis_m !== null) {
    a_km = orbit.semiMajorAxis_m / 1000;
  } else if (orbit.semiMajorAxis !== undefined && orbit.semiMajorAxis !== null) {
    a_km = orbit.semiMajorAxis / Constants.SCENE_SCALE;
  } else {
    return null;
  }

  if (!isFinite(a_km) || a_km <= 0) return null;

  return {
    a: a_km,
    e: orbit.eccentricity  || 0,
    i: orbit.inclination   || 0,
    W: orbit.raan          || 0,
    w: orbit.argPerigee    || 0,
  };
}

/**
 * ECI position (km) at mean anomaly `M` (rad); the position-only part of keplerianToCartesian. `o` = { a (km), e, i, W, w }.
 */
function _posAtM(o, M) {
  const { a, e, i, W, w } = o;

  const E = solveKepler(M, e);

  const sqrt1me2 = Math.sqrt(Math.max(0, 1 - e * e));
  const sinE = Math.sin(E);
  const cosE = Math.cos(E);
  const denom = 1 - e * cosE;
  if (Math.abs(denom) < 1e-15) return { x: 0, y: 0, z: 0 };

  const sinV = (sqrt1me2 * sinE) / denom;
  const cosV = (cosE - e) / denom;
  const nu = Math.atan2(sinV, cosV);

  const p = a * (1 - e * e);
  const r = p / (1 + e * Math.cos(nu));
  const xP = r * Math.cos(nu);
  const yP = r * Math.sin(nu);

  // Perifocal → ECI rotation (same matrix as keplerianToCartesian)
  const cW = Math.cos(W), sW = Math.sin(W);
  const cw = Math.cos(w), sw = Math.sin(w);
  const cI = Math.cos(i), sI = Math.sin(i);

  const l1 = cW * cw - sW * sw * cI;
  const l2 = -cW * sw - sW * cw * cI;
  const m1 = sW * cw + cW * sw * cI;
  const m2 = -sW * sw + cW * cw * cI;
  const n1 = sw * sI;
  const n2 = cw * sI;

  return {
    x: l1 * xP + l2 * yP,
    y: n1 * xP + n2 * yP,
    z: m1 * xP + m2 * yP,
  };
}


/**
 * MOID between two Keplerian orbits: coarse N×N sampling + optional refinement around the minimum pair.
 * @param {Object} orbitA - { semiMajorAxis_m | semiMajorAxis, eccentricity, inclination, raan, argPerigee }
 * @param {Object} orbitB - same shape
 * @param {Object} [opts] - { coarseSamples:8, refineSamples:8, refine:true }
 * @returns {number} MOID in metres (Infinity for degenerate inputs)
 */
export function computeMOID(orbitA, orbitB, opts = {}) {
  const nA = _normaliseToKm(orbitA);
  const nB = _normaliseToKm(orbitB);
  if (!nA || !nB) return Infinity;

  const nCoarse = opts.coarseSamples || 8;
  const nRefine = opts.refineSamples || 8;
  const doRefine = opts.refine !== false;

  const stepA = TWO_PI / nCoarse;
  const stepB = TWO_PI / nCoarse;

  let minDist = Infinity;
  let bestIA = 0, bestIB = 0;

  for (let ia = 0; ia < nCoarse; ia++) {
    const pA = _posAtM(nA, ia * stepA);
    for (let ib = 0; ib < nCoarse; ib++) {
      const pB = _posAtM(nB, ib * stepB);
      const dx = pA.x - pB.x, dy = pA.y - pB.y, dz = pA.z - pB.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < minDist) { minDist = d; bestIA = ia; bestIB = ib; }
    }
  }

  if (doRefine && nRefine > 0 && minDist < Infinity) {
    const hw = Math.PI / 4;
    const fStep = (2 * hw) / nRefine;
    const cA = bestIA * stepA;
    const cB = bestIB * stepB;

    for (let ia = 0; ia <= nRefine; ia++) {
      const pA = _posAtM(nA, cA - hw + ia * fStep);
      for (let ib = 0; ib <= nRefine; ib++) {
        const pB = _posAtM(nB, cB - hw + ib * fStep);
        const dx = pA.x - pB.x, dy = pA.y - pB.y, dz = pA.z - pB.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < minDist) minDist = d;
      }
    }
  }

  return minDist * 1000;
}

/** Classify MOID (metres) into HI / MD / LO / SAFE via Constants.CONJUNCTION.MOID_*. */
export function classifyMOID(moid_m) {
  const C = Constants.CONJUNCTION;
  if (moid_m < C.MOID_HI_M) return 'HI';
  if (moid_m < C.MOID_MD_M) return 'MD';
  if (moid_m < C.MOID_LO_M) return 'LO';
  return 'SAFE';
}

/** MOID of `primary` against `candidates` ({ orbit, id }): `{ id, moid }` sorted ascending, top N only. */
export function rankByMOID(primary, candidates, topN) {
  const results = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const moid = computeMOID(primary, c.orbit);
    results.push({ id: c.id, moid });
  }
  results.sort((a, b) => a.moid - b.moid);
  return results.slice(0, topN);
}

/** Format MOID for display: km (1 decimal; 0 from 100 km) when ≥1 km, metres below; '---' if not finite. */
export function formatMOID(moid_m) {
  if (!isFinite(moid_m)) return '---';
  const km = moid_m / 1000;
  if (km >= 100) return `${km.toFixed(0)} km`;
  if (km >= 1)   return `${km.toFixed(1)} km`;
  return `${moid_m.toFixed(0)} m`;
}


if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computeMOID, classifyMOID, rankByMOID, formatMOID };
}
