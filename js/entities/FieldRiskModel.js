/**
 * FieldRiskModel.js — Zoom Ladder F5 (PROX NET) local-field risk math (S4).
 *
 * PURE MODULE (no THREE, no DOM, no EventBus, no clocks): turns a debris-field
 * proximity query into a tactical read of a POINT in space —
 *   - LOCAL DENSITY via concentric shell counts around the point
 *     (the caller passes a `getDebrisNear(pos, radiusU)` query — production
 *     wiring hands in DebrisField.getDebrisNear, js/entities/DebrisField.js:3174);
 *   - a PER-DEBRIS collision risk that mirrors the shipped
 *     DebrisField._calculateCollisionRisk formula (DebrisField.js:3311 —
 *     distance e-fold × approach dot × size saturation), measured against the
 *     evaluated point instead of the player;
 *   - the BLENDED riskScore(pos) ∈ [0,1] the F5 overlay color-codes, plus the
 *     zone classification (core/mid/edge) and the expected scavenge-rate
 *     estimate.
 *
 * SCAVENGE RATE IS DISPLAY-ONLY: rate ∝ local density (a linear read of the
 * density term, capped at SCAVENGE_RATE_MAX_PER_MIN). The actual gameplay
 * rule (what a trawl/arm pass really yields per minute inside a field) lands
 * in a later milestone; nothing may consume this number mechanically.
 *
 * All tunables are EXPORTED here (house rule: not in FloorContract or
 * Constants — those are owned by parallel sessions).
 *
 * @module entities/FieldRiskModel
 */

import { Constants } from '../core/Constants.js';
import { orbitToSceneCartesian } from './OrbitalMechanics.js';

/** Concentric sampling shells around the evaluated point (km). Cumulative
 *  counts inside each radius feed the density term; the F5 overlay draws one
 *  wireframe ring per shell. */
export const SHELL_RADII_KM = [10, 50, 150];

/** Cumulative debris count that SATURATES each shell's density contribution
 *  (same length/order as SHELL_RADII_KM): `count(≤ r_i) / SAT_i`, clamped to
 *  1. Inner shells saturate on fewer objects — 8 pieces within 10 km read as
 *  "dense" while 8 within 150 km barely register. */
export const SHELL_SAT_COUNTS = [8, 20, 40];

/** riskScore blend weights: local density vs. aggregated collision risk. */
export const DENSITY_WEIGHT = 0.6;
export const COLLISION_WEIGHT = 0.4;

/** How many nearest debris contribute to the collision-risk aggregate. */
export const RISK_TOP_K = 5;

/** Per-debris collision-risk constants — EXACT mirror of the shipped
 *  DebrisField._calculateCollisionRisk (DebrisField.js:3311). Do not retune
 *  one without the other; the F5 read must agree with the sensor read. */
export const RISK_DIST_EFOLD_KM = 2;   // distFactor = exp(-distKm / 2)
export const RISK_SIZE_REF_M = 0.1;    // sizeFactor = min(1, sizeMeter / 0.1)
export const RISK_W_DIST = 0.5;
export const RISK_W_APPROACH = 0.35;
export const RISK_W_SIZE = 0.15;

/** Zone classification thresholds on riskScore (score ≥ CORE ⇒ 'core',
 *  ≥ MID ⇒ 'mid', else 'edge'). */
export const ZONE_CORE_MIN = 0.6;
export const ZONE_MID_MIN = 0.25;

/** DISPLAY-ONLY scavenge-rate ceiling (est. targets/min at density 1.0).
 *  rate = SCAVENGE_RATE_MAX_PER_MIN × density01 — see the header note: the
 *  real gameplay yield rule lands later; this is a planning hint only. */
export const SCAVENGE_RATE_MAX_PER_MIN = 6;

/** @private clamp to [0,1] */
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Resolve a debris snapshot's scene position ({x,y,z} in scene units).
 * getDebrisNear results carry `_scenePosition` (a clone); catalog pieces that
 * never entered the instance pool fall back to their orbit.
 * @param {object} debris - a DebrisField.getDebrisNear() result (or canonical)
 * @returns {{x:number,y:number,z:number}|null}
 */
export function debrisPosU(debris) {
  if (!debris) return null;
  if (debris._scenePosition) return debris._scenePosition;
  if (debris._cartesian && debris._cartesian.position) return debris._cartesian.position;
  if (debris.orbit) return orbitToSceneCartesian(debris.orbit).position;
  return null;
}

/**
 * Resolve a debris snapshot's scene velocity (direction is all the risk
 * formula needs). null when unknowable (no orbit).
 * @param {object} debris
 * @returns {{x:number,y:number,z:number}|null}
 */
export function debrisVelU(debris) {
  if (!debris) return null;
  if (debris._cartesian && debris._cartesian.velocity) return debris._cartesian.velocity;
  if (debris.orbit) return orbitToSceneCartesian(debris.orbit).velocity;
  return null;
}

/**
 * Per-debris collision risk against a reference point — the pure mirror of
 * DebrisField._calculateCollisionRisk (DebrisField.js:3311):
 *   min(1, 0.5·e^(−distKm/2) + 0.35·max(0, v̂·(ref−pos)^) + 0.15·min(1, size/0.1))
 * @param {object} args
 * @param {{x,y,z}} args.posU  - debris position (scene units)
 * @param {{x,y,z}|null} args.velU - debris velocity (any scale; direction only)
 * @param {number} args.sizeMeter - debris size (m)
 * @param {{x,y,z}} args.refPos - the evaluated point (scene units)
 * @param {number} [args.distKm] - precomputed distance (km); derived if absent
 * @returns {number} risk ∈ [0,1]
 */
export function collisionRisk({ posU, velU, sizeMeter, refPos, distKm } = {}) {
  if (!posU || !refPos) return 0;
  const dx = refPos.x - posU.x;
  const dy = refPos.y - posU.y;
  const dz = refPos.z - posU.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const d = Number.isFinite(distKm) ? distKm : len / Constants.SCENE_SCALE;
  const distFactor = Math.exp(-d / RISK_DIST_EFOLD_KM);
  if (len < 1e-10) return 1.0;                       // co-located ⇒ certain
  const dirX = dx / len, dirY = dy / len, dirZ = dz / len;
  const v = velU || null;
  const vLen = v ? Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) : 0;
  if (!(vLen > 1e-10)) return distFactor * 0.1;      // shipped stationary rule
  const dot = (v.x * dirX + v.y * dirY + v.z * dirZ) / vLen;
  const approachFactor = Math.max(0, dot);
  const sizeFactor = Math.min(1, (sizeMeter || 0) / RISK_SIZE_REF_M);
  return Math.min(1.0,
    distFactor * RISK_W_DIST + approachFactor * RISK_W_APPROACH + sizeFactor * RISK_W_SIZE);
}

/**
 * Concentric shell counts around a point. ONE debris query at the outermost
 * radius; cumulative counts per shell derive from the sorted distances
 * (getDebrisNear results are distance-sorted and carry `distanceKm`).
 * @param {(pos:{x,y,z}, radiusU:number) => Array} getDebrisNear - proximity
 *                 query (DebrisField.getDebrisNear-shaped)
 * @param {{x,y,z}} pos - evaluated point (scene units)
 * @param {number[]} [radiiKm=SHELL_RADII_KM]
 * @returns {{
 *   shells: Array<{radiusKm:number, radiusU:number, cumCount:number, count:number, sat01:number}>,
 *   nearby: Array,        // the outermost query result (distance-sorted)
 * }}
 */
export function shellCounts(getDebrisNear, pos, radiiKm = SHELL_RADII_KM) {
  const radii = (radiiKm && radiiKm.length) ? radiiKm : SHELL_RADII_KM;
  const outerU = radii[radii.length - 1] * Constants.SCENE_SCALE;
  const nearby = (typeof getDebrisNear === 'function' && pos)
    ? (getDebrisNear(pos, outerU) || [])
    : [];
  const shells = [];
  let prevCum = 0;
  for (let i = 0; i < radii.length; i++) {
    const rKm = radii[i];
    let cum = 0;
    for (const d of nearby) {
      const dk = Number.isFinite(d.distanceKm)
        ? d.distanceKm
        : (Number.isFinite(d.distance) ? d.distance / Constants.SCENE_SCALE : Infinity);
      if (dk <= rKm) cum++;
    }
    const sat = SHELL_SAT_COUNTS[Math.min(i, SHELL_SAT_COUNTS.length - 1)] || 1;
    shells.push({
      radiusKm: rKm,
      radiusU: rKm * Constants.SCENE_SCALE,
      cumCount: cum,
      count: cum - prevCum,
      sat01: clamp01(cum / sat),
    });
    prevCum = cum;
  }
  return { shells, nearby };
}

/**
 * Normalized local density ∈ [0,1]: the MAX of the shells' saturation terms,
 * so a point reads dense when ANY scale is crowded (8 within 10 km is as
 * "dense" as 40 within 150 km).
 * @param {Array<{sat01:number}>} shells - from shellCounts()
 * @returns {number} 0..1
 */
export function localDensity(shells) {
  let max = 0;
  for (const s of (shells || [])) if (s.sat01 > max) max = s.sat01;
  return clamp01(max);
}

/**
 * Zone classification of a risk score (thresholds exported above).
 * @param {number} score01
 * @returns {'core'|'mid'|'edge'}
 */
export function classifyZone(score01) {
  if (score01 >= ZONE_CORE_MIN) return 'core';
  if (score01 >= ZONE_MID_MIN) return 'mid';
  return 'edge';
}

/**
 * DISPLAY-ONLY expected scavenge rate (est. targets/min): rate ∝ density.
 * The gameplay yield rule lands in a later milestone (header note).
 * @param {number} density01
 * @returns {number} targets/min estimate
 */
export function estScavengeRate(density01) {
  return SCAVENGE_RATE_MAX_PER_MIN * clamp01(density01);
}

/**
 * The full point assessment: shell counts → density, top-K collision risks →
 * aggregate, blended riskScore ∈ [0,1], zone, scavenge estimate.
 *
 * @param {object} args
 * @param {(pos, radiusU) => Array} args.getDebrisNear - proximity query
 * @param {{x,y,z}} args.pos - evaluated point (scene units)
 * @param {number[]} [args.radiiKm=SHELL_RADII_KM]
 * @returns {{
 *   riskScore: number,      // ∈ [0,1] — DENSITY_WEIGHT·density + COLLISION_WEIGHT·collision
 *   zone: 'core'|'mid'|'edge',
 *   density01: number,
 *   collision01: number,    // mean of the top-K nearest debris' collisionRisk
 *   estScavengeRatePerMin: number,   // DISPLAY-ONLY (∝ density)
 *   shells: Array,          // shellCounts().shells (overlay rings)
 *   count: number,          // debris inside the outermost shell
 * }}
 */
export function riskScore({ getDebrisNear, pos, radiiKm } = {}) {
  const { shells, nearby } = shellCounts(getDebrisNear, pos, radiiKm);
  const density01 = localDensity(shells);
  let collision01 = 0;
  if (nearby.length > 0) {
    const k = Math.min(RISK_TOP_K, nearby.length);
    let sum = 0;
    for (let i = 0; i < k; i++) {
      const d = nearby[i];
      sum += collisionRisk({
        posU: debrisPosU(d),
        velU: debrisVelU(d),
        sizeMeter: d.sizeMeter,
        refPos: pos,
        distKm: d.distanceKm,
      });
    }
    collision01 = sum / k;
  }
  const score = clamp01(DENSITY_WEIGHT * density01 + COLLISION_WEIGHT * collision01);
  return {
    riskScore: score,
    zone: classifyZone(score),
    density01,
    collision01,
    estScavengeRatePerMin: estScavengeRate(density01),
    shells,
    count: nearby.length,
  };
}
