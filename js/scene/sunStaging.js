/**
 * sunStaging.js — pure math for staging the Mission-1 opening in sunlight.
 *
 * PROBLEM: the sky is seeded from the real UTC clock
 * (SunLight._seedSkyFromClock) while the start orbit is placed by ground-track
 * over the player's home region (startOrbitMath.computeStartOrbit). A player
 * whose real-world local time puts the home region on the night side starts
 * their entire first session in eclipse — the authored welcome cluster reads
 * dim/flat and the first-capture cinematic loses its sun key light.
 *
 * MECHANISM: a STAGED YAW OFFSET applied ONCE, at fresh-game start, on top of
 * the real-clock seed. SunLight's stylized day/night cycle is a circle tilted
 * SUN_CYCLE_TILT from the equator whose phase advances with elapsed time and
 * which is yawed about +Y by a constant (_sunYaw0). Adding a delta to that
 * constant slides the whole cycle in longitude WITHOUT touching the phase
 * (declination/season), the cycle speed, or the moon's sun-relative elongation
 * (today's lunar phase rides along, _updateMoon keys off the live sun azimuth).
 * The sun is NOT frozen: day/night cycling continues normally from the offset.
 *
 * TARGETING: the yaw is chosen so dot(sunDir, spawnDir) — the sun's elevation
 * over the spawn point — lands on OPENING_SUN_TARGET_DOT (sun ~60° from the
 * spawn zenith ⇒ ~30° above the local horizon: warm modelling light, well off
 * the spawn zenith, never flat local-noon light). When the spawn latitude and
 * the seasonal declination make the target unreachable (high-latitude winter
 * starts, e.g. the en/New-York track near the December solstice), the yaw
 * clamps to the azimuth-aligned optimum — the highest sun that yaw-only
 * control can produce (worst case across the language table ≈ low warm dawn
 * light, dot ≈ 0.26, still clearly on the day side). The azimuth branch is
 * chosen so the stylized cycle's forward motion (sun azimuth INCREASES with
 * elapsed time — see the _sunYaw0 rotation in SunLight.update) carries the sun
 * TOWARD the spawn meridian: the sunlit window opens after spawn instead of
 * closing toward the terminator.
 *
 * Pure + Node-safe: no THREE, no DOM, no singletons (mirrors startOrbitMath).
 *
 * @module scene/sunStaging
 */

const TWO_PI = 2 * Math.PI;

/**
 * Target dot(sunDir, spawnDir) for the staged opening: cos(60°) — the sun 60°
 * from the spawn zenith (≈30° above the local horizon). High enough that the
 * welcome cluster is unmistakably sunlit, low enough that the key light stays
 * angled (side/three-quarter modelling light, not overhead flat light).
 */
export const OPENING_SUN_TARGET_DOT = 0.5;

/**
 * Rotate a vector about +Y by `yaw` — the exact rotation SunLight.update
 * applies for _sunYaw0 (x' = x·cos−z·sin, z' = x·sin+z·cos), extracted so the
 * staging math and the live sky can never disagree about the convention.
 * @param {{x:number,y:number,z:number}} v
 * @param {number} yaw — radians about +Y
 * @returns {{x:number,y:number,z:number}}
 */
export function rotateAboutY(v, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return { x: v.x * c - v.z * s, y: v.y, z: v.x * s + v.z * c };
}

/**
 * Compute the one-time staged yaw (about +Y) that places the sun over the
 * spawn point's day side at OPENING_SUN_TARGET_DOT elevation-dot, clamped to
 * the best yaw-only can achieve, with the sun trailing the spawn meridian so
 * the cycle's forward drift closes toward local noon after spawn.
 *
 * Yaw-only control cannot change either latitude term (sun declination is the
 * seasonal phase; spawn latitude is the start orbit), so the achieved dot is
 *   sin(declS)·sin(latP) + cos(declS)·cos(latP)·cos(Δaz)
 * with Δaz the only free variable. This solves Δaz for the target and clamps.
 *
 * @param {{x:number,y:number,z:number}} sunDir — CURRENT sun direction (unit-ish)
 * @param {{x:number,y:number,z:number}} spawnPos — spawn scene position (any length)
 * @param {number} [targetDot=OPENING_SUN_TARGET_DOT]
 * @returns {number} yaw delta in radians, wrapped to (−π, π]; 0 on degenerate
 *   input (zero vectors or polar geometry, where yaw cannot change the dot).
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
  // Polar degenerate: the dot is azimuth-independent — nothing to stage.
  if (hs < 1e-9 || hp < 1e-9) return 0;

  // Azimuth separation that lands the dot on target. Clamp handles both
  // unreachable cases: needed > 1 → Δaz = 0 (azimuth-aligned optimum, the
  // highest reachable sun); needed < −1 → Δaz = π (even the far side exceeds
  // the target — every yaw is above target, take the minimum).
  const needed = (targetDot - sy * py) / (hs * hp);
  const dAz = Math.acos(Math.max(-1, Math.min(1, needed)));

  const azSun = Math.atan2(sunDir.z, sunDir.x);
  const azSpawn = Math.atan2(spawnPos.z, spawnPos.x);
  // Sun azimuth increases with elapsed time (SunLight.update), so trail the
  // spawn meridian by Δaz: the post-spawn drift sweeps toward local noon.
  let yaw = (azSpawn - dAz) - azSun;
  yaw = ((yaw % TWO_PI) + TWO_PI) % TWO_PI;
  if (yaw > Math.PI) yaw -= TWO_PI;
  return yaw;
}

export default { OPENING_SUN_TARGET_DOT, rotateAboutY, stagedSunYaw };
