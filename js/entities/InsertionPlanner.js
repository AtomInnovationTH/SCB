/**
 * InsertionPlanner.js — Zoom Ladder F5 (PROX NET) approach-corridor planner (S4).
 *
 * PURE MODULE (no THREE, no DOM, no EventBus, no clocks): given a debris
 * cluster (center + member spread from `targets[]`) and the player state,
 * produce the three candidate ARRIVAL POINTS the F5 floor offers — edge, mid,
 * and core — laid along the APPROACH AXIS (cluster center → player), each
 * carrying:
 *   - `pos`               scene-unit arrival position;
 *   - `riskScore`/`zone`  FieldRiskModel read AT that point (needs the
 *                         injected getDebrisNear query; null without it);
 *   - `estScavengeRate`   DISPLAY-ONLY density-proportional estimate
 *                         (FieldRiskModel note: the gameplay rule lands later);
 *   - `dvEstimate`        m/s — OrbitalMechanics.totalDeltaV from the player
 *                         orbit to a circular orbit at the point's geocentric
 *                         radius in the CLUSTER's plane (deeper points sit at
 *                         slightly different radii, so the three estimates
 *                         honestly differ);
 *   - `waypoints`         a polyline for trajectory rendering: a polar-
 *                         interpolated arc (angle slerped, radius lerped) so
 *                         the drawn path bows with the orbit instead of
 *                         chording through lower altitudes.
 *
 * The trade this surfaces: EDGE arrives safe but sparse, CORE arrives rich but
 * hot — riskScore and estScavengeRate move together by construction (both are
 * density reads), which IS the tactical decision, not an accident.
 *
 * All tunables are EXPORTED here (house rule: not FloorContract/Constants).
 *
 * @module entities/InsertionPlanner
 */

import { Constants } from '../core/Constants.js';
import { totalDeltaV, orbitToKm, orbitToSceneCartesian } from './OrbitalMechanics.js';
import { clusterToOrbitKm } from './LaunchWindow.js';
import { riskScore as fieldRiskAt } from './FieldRiskModel.js';

/** The three insertion zones, ordered OUTSIDE-IN (selection cycles this
 *  order). `frac` = distance from the cluster center along the approach axis,
 *  as a fraction of the cluster radius. Core sits slightly off exact center
 *  so its risk read is not a divide-by-zero co-location artifact. */
export const INSERTION_ZONES = [
  { id: 'edge', frac: 1.0 },
  { id: 'mid',  frac: 0.5 },
  { id: 'core', frac: 0.1 },
];

/** Cluster-radius floor (km): a degenerate/empty spread still yields a usable
 *  corridor (the F5 range spans 100 m – 120 km; a zero-radius cluster would
 *  collapse the three candidates onto one point). */
export const MIN_CLUSTER_RADIUS_KM = 25;

/** Spread percentile that defines the cluster radius (0.9 ⇒ the ring holding
 *  90% of members — outliers don't balloon the corridor). */
export const RADIUS_PERCENTILE = 0.9;

/** Waypoint count per trajectory polyline (endpoints included ⇒ +1 points). */
export const WAYPOINT_COUNT = 24;

/**
 * Member positions of a cluster (scene units). Prefers each member's live
 * `_scenePosition`; falls back to its orbit. Dead members are skipped.
 * @param {object} cluster - DebrisField.getDebrisClusters() shape ({targets})
 * @returns {Array<{x:number,y:number,z:number}>}
 */
export function memberPositions(cluster) {
  const targets = (cluster && Array.isArray(cluster.targets)) ? cluster.targets : [];
  const out = [];
  for (const t of targets) {
    if (!t || t.alive === false) continue;
    if (t._scenePosition) out.push(t._scenePosition);
    else if (t.orbit) out.push(orbitToSceneCartesian(t.orbit).position);
  }
  return out;
}

/**
 * Cluster radius (scene units) from the member spread: the RADIUS_PERCENTILE
 * distance from the center, floored at MIN_CLUSTER_RADIUS_KM.
 * @param {object} cluster - ({center, targets})
 * @returns {number} radius in scene units
 */
export function clusterRadiusU(cluster) {
  const floorU = MIN_CLUSTER_RADIUS_KM * Constants.SCENE_SCALE;
  const c = cluster && cluster.center;
  if (!c) return floorU;
  const dists = memberPositions(cluster).map((p) => {
    const dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  });
  if (dists.length === 0) return floorU;
  dists.sort((a, b) => a - b);
  const idx = Math.min(dists.length - 1, Math.floor(dists.length * RADIUS_PERCENTILE));
  return Math.max(floorU, dists[idx]);
}

/**
 * The approach axis: unit vector from the cluster center TOWARD the player
 * (arrival points sit on the player's side of the cluster). Degenerate
 * (player at center / missing) falls back to +x so the plan stays usable.
 * @param {{x,y,z}} center
 * @param {{x,y,z}|null} playerPos
 * @returns {{x:number,y:number,z:number}}
 */
export function approachAxis(center, playerPos) {
  if (!center || !playerPos) return { x: 1, y: 0, z: 0 };
  const dx = playerPos.x - center.x;
  const dy = playerPos.y - center.y;
  const dz = playerPos.z - center.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(len > 1e-12)) return { x: 1, y: 0, z: 0 };
  return { x: dx / len, y: dy / len, z: dz / len };
}

/**
 * The three geometric candidate points (edge/mid/core) along the approach
 * axis. Pure geometry — no risk/ΔV annotation.
 * @param {object} args
 * @param {{x,y,z}} args.center - cluster center (scene units)
 * @param {number} args.radiusU - cluster radius (scene units)
 * @param {{x,y,z}|null} args.playerPos
 * @param {Array} [args.zones=INSERTION_ZONES]
 * @returns {Array<{zone:string, frac:number, pos:{x,y,z}}>}
 */
export function candidatePoints({ center, radiusU, playerPos, zones = INSERTION_ZONES } = {}) {
  if (!center || !(radiusU > 0)) return [];
  const axis = approachAxis(center, playerPos);
  return zones.map((z) => ({
    zone: z.id,
    frac: z.frac,
    pos: {
      x: center.x + axis.x * radiusU * z.frac,
      y: center.y + axis.y * radiusU * z.frac,
      z: center.z + axis.z * radiusU * z.frac,
    },
  }));
}

/**
 * ΔV estimate (m/s) from the player orbit to a circular orbit at the arrival
 * point's geocentric radius, in the CLUSTER's plane (clusterToOrbitKm carries
 * the representative inclination/raan, so the plane change is priced).
 * @param {object} args
 * @param {object} args.playerOrbit - scene-unit orbital elements
 * @param {{x,y,z}} args.pointU - arrival point (scene units)
 * @param {object} args.cluster - the target cluster (plane source)
 * @returns {number|null} m/s, or null without a player orbit
 */
export function dvEstimate({ playerOrbit, pointU, cluster } = {}) {
  if (!playerOrbit || !(playerOrbit.semiMajorAxis > 0) || !pointU) return null;
  const rU = Math.sqrt(pointU.x * pointU.x + pointU.y * pointU.y + pointU.z * pointU.z);
  if (!(rU > 0)) return null;
  const chaserKm = orbitToKm(playerOrbit);
  const targetKm = { ...clusterToOrbitKm(cluster || {}), semiMajorAxis: rU / Constants.SCENE_SCALE };
  return totalDeltaV(chaserKm, targetKm) * 1000; // km/s → m/s
}

/**
 * Trajectory polyline from `fromU` to `toU`: a polar-interpolated arc — the
 * direction slerps through the great-circle angle between the two geocentric
 * position vectors while the radius lerps, so the path follows the orbital
 * shell instead of chording under it. Degenerate (colinear / at origin)
 * inputs fall back to a straight lerp.
 * @param {{x,y,z}} fromU - start (scene units; Earth at origin)
 * @param {{x,y,z}} toU - end (scene units)
 * @param {number} [n=WAYPOINT_COUNT] - segment count (returns n+1 points)
 * @returns {Array<{x:number,y:number,z:number}>}
 */
export function waypoints(fromU, toU, n = WAYPOINT_COUNT) {
  const pts = [];
  if (!fromU || !toU) return pts;
  const segs = Math.max(1, n | 0);
  const r0 = Math.hypot(fromU.x, fromU.y, fromU.z);
  const r1 = Math.hypot(toU.x, toU.y, toU.z);
  const lerp = () => {
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      pts.push({
        x: fromU.x + (toU.x - fromU.x) * t,
        y: fromU.y + (toU.y - fromU.y) * t,
        z: fromU.z + (toU.z - fromU.z) * t,
      });
    }
    return pts;
  };
  if (!(r0 > 1e-9) || !(r1 > 1e-9)) return lerp();
  const u0 = { x: fromU.x / r0, y: fromU.y / r0, z: fromU.z / r0 };
  const u1 = { x: toU.x / r1, y: toU.y / r1, z: toU.z / r1 };
  // Rotation axis = u0 × u1; colinear endpoints degrade to the straight lerp.
  const ax = u0.y * u1.z - u0.z * u1.y;
  const ay = u0.z * u1.x - u0.x * u1.z;
  const az = u0.x * u1.y - u0.y * u1.x;
  const aLen = Math.hypot(ax, ay, az);
  if (!(aLen > 1e-9)) return lerp();
  const kx = ax / aLen, ky = ay / aLen, kz = az / aLen;
  const dot = Math.max(-1, Math.min(1, u0.x * u1.x + u0.y * u1.y + u0.z * u1.z));
  const angle = Math.acos(dot);
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const th = angle * t;
    const c = Math.cos(th), s = Math.sin(th);
    // Rodrigues rotation of u0 around k by th (k ⊥ u0 by construction).
    const kdotu = kx * u0.x + ky * u0.y + kz * u0.z; // ≈ 0
    const rx = u0.x * c + (ky * u0.z - kz * u0.y) * s + kx * kdotu * (1 - c);
    const ry = u0.y * c + (kz * u0.x - kx * u0.z) * s + ky * kdotu * (1 - c);
    const rz = u0.z * c + (kx * u0.y - ky * u0.x) * s + kz * kdotu * (1 - c);
    const r = r0 + (r1 - r0) * t;
    pts.push({ x: rx * r, y: ry * r, z: rz * r });
  }
  return pts;
}

/**
 * The full insertion plan for one cluster.
 *
 * @param {object} args
 * @param {object} args.cluster - DebrisField.getDebrisClusters() shape
 *                 ({center, targets, avgAltKm, incCenter, ...})
 * @param {{x,y,z}|null} args.playerPos - player position (scene units)
 * @param {object} [args.playerOrbit] - scene-unit elements (ΔV estimates;
 *                 absent ⇒ dvEstimate null)
 * @param {(pos, radiusU) => Array} [args.getDebrisNear] - proximity query
 *                 (risk/scavenge reads; absent ⇒ riskScore/zone/rate null)
 * @returns {{
 *   clusterId: *, center: {x,y,z}, radiusU: number, axis: {x,y,z},
 *   candidates: Array<{
 *     zone: 'edge'|'mid'|'core', frac: number, pos: {x,y,z},
 *     riskScore: number|null, riskZone: string|null,
 *     estScavengeRate: number|null, dvEstimate: number|null,
 *     waypoints: Array<{x,y,z}>,
 *   }>,
 * }|null} null without a cluster center
 */
export function plan({ cluster, playerPos, playerOrbit, getDebrisNear } = {}) {
  if (!cluster || !cluster.center) return null;
  const center = cluster.center;
  const radiusU = clusterRadiusU(cluster);
  const axis = approachAxis(center, playerPos);
  const geo = candidatePoints({ center, radiusU, playerPos });
  const candidates = geo.map((g) => {
    let risk = null;
    if (typeof getDebrisNear === 'function') {
      risk = fieldRiskAt({ getDebrisNear, pos: g.pos });
    }
    return {
      zone: g.zone,
      frac: g.frac,
      pos: g.pos,
      riskScore: risk ? risk.riskScore : null,
      riskZone: risk ? risk.zone : null,
      estScavengeRate: risk ? risk.estScavengeRatePerMin : null,
      dvEstimate: dvEstimate({ playerOrbit, pointU: g.pos, cluster }),
      waypoints: playerPos ? waypoints(playerPos, g.pos) : [],
    };
  });
  return { clusterId: cluster.id, center, radiusU, axis, candidates };
}
