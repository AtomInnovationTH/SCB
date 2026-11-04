/**
 * pieceDeltaV.js - add a real velocity change (Δv) to a debris piece's Keplerian orbit (laser round 2, E6).
 *
 * Debris pieces carry no velocity of their own: each is a set of orbital elements that `DebrisField.update` steps along. A push
 * therefore goes: elements -> position and velocity -> add the Δv -> elements again. This is the same closed-form route the mother's
 * own burns take (`PlayerSatellite.applyCartesianImpulse`), but for a piece, and with the checks a per-frame push needs:
 *
 *   - Frame: the elements' Cartesian output (`orbitToSceneCartesian`) IS the scene frame (Y-up, orbital angular momentum about Y
 *     for the mother's plane), and `cartesianToKeplerian` takes that same frame back. So a scene-axes direction adds straight onto
 *     the scene-frame velocity; the only conversions are units: scene units -> km for the position (÷ SCENE_SCALE) and m/s -> km/s
 *     for the Δv (× 0.001).
 *   - Eccentricity: `reseatOrbitFromScene` clamps e to [0, 0.1] silently. That is harmless for a small push (e moves by about Δv / v,
 *     1e-5 for 0.1 m/s) but would rewrite the orbit of a piece pushed past 0.1, so here a result above 0.1 is refused instead and the
 *     piece is left as it was.
 *   - Round trip: the shared `cartesianToKeplerian` takes Ω, ω and ν with `acos`, which cannot resolve an angle near 0 or π below
 *     ~1e-8 rad. A 1e-6 m/s sideways step moves ω only ~1e-10 rad, so at ω = 0 or 180° (the mother's own ω = 0, copied by welcome and
 *     training pieces) a per-frame cross-track push was mostly rounded away (D1 review, measured: 119 % error over 6000 steps of
 *     1e-6 m/s). So the state goes back to elements through {@link stateToElementsAtan2} (own, atan2 for every angle); the push
 *     now adds up at any ω and any step size (test-DebrisField-DeltaV (f): within 2 % at 1e-6 m/s, ω = 0 and 180°). The one case it
 *     cannot hold is an equatorial orbit, where the node is undefined: an along-track or radial push there is refused up front
 *     (sin i < 1e-9; a cross-track push is fine, it tilts the plane and so defines the node), and a position check after the
 *     conversion (more than 1 m off: nothing is written) stays as a second guard.
 *
 * @module entities/pieceDeltaV
 */
import { Constants } from '../core/Constants.js';
import { orbitToSceneCartesian, keplerianToCartesian } from './OrbitalMechanics.js';

/** A pushed piece may not leave this eccentricity (the co-orbital field band `reseatOrbitFromScene` clamps to). */
export const MAX_PUSHED_ECCENTRICITY = 0.1;
/** The new elements must put the piece back within this many metres of where it was (guards the undefined-node case). */
const POSITION_TOL_M = 1;

/** Below this eccentricity the line of apsides is noise: ω = 0 and ν is the argument of latitude (matches the sum ω + ν). */
const E_CIRCULAR = 1e-13;
/** Below this |n|/|h| (= sin i) the line of nodes is undefined: refused (an equatorial orbit; see the header). */
const SIN_I_MIN = 1e-9;

/** Angle in [0, 2π) from its sine and cosine parts. */
function angle(sin, cos) {
  const t = Math.atan2(sin, cos);
  return t < 0 ? t + 2 * Math.PI : t;
}

/**
 * Cartesian state (scene frame, km and km/s) -> Keplerian elements, with every angle from `atan2` (sine and cosine parts).
 * `cartesianToKeplerian` (OrbitalMechanics.js, shared, left alone) recovers Ω, ω and ν with `acos`, which near 0 and π cannot
 * resolve below about 1e-8 rad (the slope of acos there is infinite); a per-frame push of 1e-6 m/s moves an angle only ~1e-10
 * rad, so at ω = 0 (the mother's own value, copied by welcome and training pieces) it was mostly rounded away. `atan2` keeps
 * full resolution at every angle. Same frame as `cartesianToKeplerian`: scene Y-up, y and z swapped to the textbook Z-up ECI inside.
 *
 * @returns {object|null} elements in the shape `cartesianToKeplerian` returns (a in km), or null for a degenerate state or an
 *   undefined node (sin i below {@link SIN_I_MIN})
 */
export function stateToElementsAtan2(position, velocity, mu = Constants.MU_EARTH) {
  const px = position.x, py = position.z, pz = position.y;
  const vx = velocity.x, vy = velocity.z, vz = velocity.y;
  const r = Math.hypot(px, py, pz), v2 = vx * vx + vy * vy + vz * vz;
  const hx = py * vz - pz * vy, hy = pz * vx - px * vz, hz = px * vy - py * vx;
  const h = Math.hypot(hx, hy, hz);
  if (!(r > 0) || !(h > 0) || !isFinite(h) || !isFinite(v2)) return null;
  const nx = -hy, ny = hx, n = Math.hypot(nx, ny);               // line of nodes = ẑ × h
  if (!(n > SIN_I_MIN * h)) return null;

  const rdotv = px * vx + py * vy + pz * vz;
  const k = v2 - mu / r;
  const ex = (k * px - rdotv * vx) / mu, ey = (k * py - rdotv * vy) / mu, ez = (k * pz - rdotv * vz) / mu;
  const e = Math.hypot(ex, ey, ez);
  const a = -mu / (v2 - 2 * mu / r);                             // -mu / (2·energy)

  // sine part of angle(from u to w about h) = (u × w)·h / (|u||w||h|); cosine part = u·w / (|u||w|)
  const nCrossX = (ux, uy, uz) => ({ x: ny * uz, y: -nx * uz, z: nx * uy - ny * ux });  // n × u, n has no z part
  let argP = 0, nu;
  if (e > E_CIRCULAR) {
    const nxe = nCrossX(ex, ey, ez);
    argP = angle((nxe.x * hx + nxe.y * hy + nxe.z * hz) / (h * n * e), (nx * ex + ny * ey) / (n * e));
    const ecx = ey * pz - ez * py, ecy = ez * px - ex * pz, ecz = ex * py - ey * px;   // e × r
    nu = angle((ecx * hx + ecy * hy + ecz * hz) / (h * e * r), (ex * px + ey * py + ez * pz) / (e * r));
  } else {
    const ncr = nCrossX(px, py, pz);
    nu = angle((ncr.x * hx + ncr.y * hy + ncr.z * hz) / (h * n * r), (nx * px + ny * py) / (n * r));
  }
  return {
    semiMajorAxis: a,
    eccentricity: e,
    inclination: Math.atan2(n, hz),
    raan: angle(ny, nx),
    argPerigee: argP,
    trueAnomaly: nu,
    meanMotion: Math.sqrt(mu / (a * a * a)),
  };
}

/**
 * Add `dvMps` metres per second along `dir` (scene axes) to `orbit` (scene-unit semiMajorAxis), in place.
 *
 * @param {object} orbit   the piece's elements; mutated only on success
 * @param {{x:number,y:number,z:number}} dir  direction in scene axes (normalised here; need not be exactly unit)
 * @param {number} dvMps   speed change in m/s, finite and > 0 (the sign is in `dir`)
 * @returns {boolean} true when applied; false (orbit untouched) on bad input, a non-finite or non-positive-axis result, e above
 *   {@link MAX_PUSHED_ECCENTRICITY}, or a round trip that moved the piece
 */
export function addDeltaVToOrbit(orbit, dir, dvMps) {
  const S = Constants.SCENE_SCALE;
  if (!orbit || !dir || !(S > 0)) return false;
  if (!(typeof dvMps === 'number' && isFinite(dvMps) && dvMps > 0)) return false;
  const len = Math.hypot(dir.x, dir.y, dir.z);
  if (!(len > 1e-9) || !isFinite(len)) return false;

  const cart = orbitToSceneCartesian(orbit);
  const k = dvMps * 0.001 / len;
  const posKm = { x: cart.position.x / S, y: cart.position.y / S, z: cart.position.z / S };
  const vel = {
    x: cart.velocity.x + dir.x * k,
    y: cart.velocity.y + dir.y * k,
    z: cart.velocity.z + dir.z * k,
  };
  const el = stateToElementsAtan2(posKm, vel);
  if (!el
      || !isFinite(el.semiMajorAxis) || el.semiMajorAxis <= 0
      || !isFinite(el.eccentricity) || el.eccentricity > MAX_PUSHED_ECCENTRICITY
      || !isFinite(el.inclination) || !isFinite(el.raan)
      || !isFinite(el.argPerigee) || !isFinite(el.trueAnomaly)) return false;

  // The new elements must hold the same place (the node-less equatorial case returns ν = 0 whatever the position was).
  const back = keplerianToCartesian(el).position;
  const off = Math.hypot(back.x - posKm.x, back.y - posKm.y, back.z - posKm.z) * 1000;
  if (!(off <= POSITION_TOL_M)) return false;

  orbit.semiMajorAxis = el.semiMajorAxis * S;
  orbit.eccentricity = el.eccentricity;
  orbit.inclination = el.inclination;
  orbit.raan = el.raan;
  orbit.argPerigee = el.argPerigee;
  orbit.trueAnomaly = el.trueAnomaly;
  if (isFinite(el.meanMotion)) orbit.meanMotion = el.meanMotion;
  return true;
}
