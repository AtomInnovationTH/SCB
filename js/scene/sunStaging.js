/**
 * Pure math for staging the Mission-1 opening in sunlight. The sky is seeded
 * from the real UTC clock (SunLight._seedSkyFromClock), so a night-side home
 * region would start the first session in eclipse. Fix: a staged yaw offset
 * about +Y, applied ONCE at fresh-game start on top of the seed. It slides the
 * stylized cycle in longitude without touching phase (declination/season),
 * cycle speed or the moon's sun-relative elongation; the sun is not frozen.
 *
 * Target: dot(sunDir, spawnDir) = OPENING_SUN_TARGET_DOT. If unreachable
 * (high-latitude winter starts) the yaw clamps to the azimuth-aligned optimum
 * (worst case across the language table: dot ≈ 0.26, low warm dawn light).
 * The azimuth branch is chosen so the cycle's forward motion (azimuth
 * INCREASES with elapsed time, see _sunYaw0 in SunLight.update) carries the
 * sun toward the spawn meridian: the sunlit window opens after spawn.
 *
 * Pure + Node-safe: no THREE, no DOM, no singletons.
 *
 * @module scene/sunStaging
 */

import { clamp } from '../core/MathUtil.js';

const TWO_PI = 2 * Math.PI;

/** Target dot(sunDir, spawnDir): cos(60°), sun ≈30° above the local horizon (lit but angled, never flat noon light). */
export const OPENING_SUN_TARGET_DOT = 0.5;

/**
 * Rotate a vector about +Y by `yaw` (radians) — the exact rotation SunLight.update
 * applies for _sunYaw0 (x' = x·cos−z·sin, z' = x·sin+z·cos), shared so staging
 * and the live sky cannot disagree.
 */
export function rotateAboutY(v, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return { x: v.x * c - v.z * s, y: v.y, z: v.x * s + v.z * c };
}

/**
 * One-time staged yaw (about +Y) putting the sun at `targetDot` over the spawn
 * point, clamped to the best yaw-only can do, trailing the spawn meridian.
 * Yaw cannot change either latitude term, so the achieved dot is
 *   sin(declS)·sin(latP) + cos(declS)·cos(latP)·cos(Δaz)
 * and this solves Δaz for the target.
 *
 * @param {{x:number,y:number,z:number}} sunDir — CURRENT sun direction (unit-ish)
 * @param {{x:number,y:number,z:number}} spawnPos — spawn scene position (any length)
 * @returns {number} yaw delta in radians, wrapped to (−π, π]; 0 on degenerate
 *   input (zero vectors or polar geometry).
 */
export function stagedSunYaw(sunDir, spawnPos, targetDot = OPENING_SUN_TARGET_DOT) {
  if (!sunDir || !spawnPos) return 0;
  const sl = Math.hypot(sunDir.x, sunDir.y, sunDir.z);
  const pl = Math.hypot(spawnPos.x, spawnPos.y, spawnPos.z);
  if (!(sl > 0) || !(pl > 0)) return 0;

  const sy = sunDir.y / sl;
  const py = spawnPos.y / pl;
  const hs = Math.sqrt(Math.max(0, 1 - sy * sy)); // cos(sun "latitude")
  const hp = Math.sqrt(Math.max(0, 1 - py * py)); // cos(spawn latitude)
  // Polar: the dot is azimuth-independent.
  if (hs < 1e-9 || hp < 1e-9) return 0;

  // Clamp covers both unreachable cases: needed > 1 → Δaz = 0 (highest reachable
  // sun); needed < −1 → Δaz = π (every yaw is above target, take the minimum).
  const needed = (targetDot - sy * py) / (hs * hp);
  const dAz = Math.acos(clamp(needed, -1, 1));

  const azSun = Math.atan2(sunDir.z, sunDir.x);
  const azSpawn = Math.atan2(spawnPos.z, spawnPos.x);
  // Azimuth increases with time, so trail the spawn meridian by Δaz.
  let yaw = (azSpawn - dAz) - azSun;
  yaw = ((yaw % TWO_PI) + TWO_PI) % TWO_PI;
  if (yaw > Math.PI) yaw -= TWO_PI;
  return yaw;
}

export default { OPENING_SUN_TARGET_DOT, rotateAboutY, stagedSunYaw };
