/**
 * DaughterCW.js - a daughter's long fetch on the real curved path (plan sky-1116, lane L-flight, Done C).
 *
 * WHY. In the game the world clock runs `TIME_SCALE_GAMEPLAY` (10) world seconds per real second, but a daughter's kinematics run on
 * REAL seconds (`position += velocity * dt`, ArmUnit.js `_updateTransit`). So her "10 m/s" is 1 m/s of true relative speed, and the
 * frame she flies in is the mother's TRANSLATING frame with the stars' axes: the piece, on its own Kepler orbit, circles in that
 * frame at the orbital rate. Today (read first, measured 2026-11-16 in the real rig, `tmp/sky1116/flight/probe1.mjs`) she feels no
 * gravity gradient at all and the controller (`_updateTransit`: velocity matching with an EMA drift term plus quadratic braking)
 * spends her tank following a target that moves 11 m/s per km in her units: 1 km ahead costs 33 of her 50 m/s and 150 s, 2 km runs
 * her dry. The flight below is the fix beyond `CW_FLIGHT.MIN_RANGE_M`: she is launched on the Clohessy-Wiltshire intercept (aimed
 * off the straight line), feels the real gravity gradient on the way (so the curve is the real one and costs no gas), makes small
 * mid-course corrections, and hands over to the old controller for the last `HANDOFF_M`, where the same arrival kill (her launch
 * speed, as `RouteCost.daughterLeg` has always billed) is paid.
 *
 * FRAMES AND UNITS. Everything here is SI (metres, seconds of WORLD time, m/s of TRUE relative speed) in the scene's own axes. The
 * caller converts: a daughter's speed in game units is the true speed times `TIME_SCALE_GAMEPLAY`. The LVLH triple is x = radial out,
 * y = along the track (the velocity), z = x cross y (the orbit normal); the scene's axes are a reflection of the usual ones, which
 * changes nothing here (gravity is central and the triple is built from cross products inside the scene). Rotation rate is that of
 * the mother's circular orbit.
 *
 * Pure: this file imports only `Constants`.
 * @module entities/DaughterCW
 */
import { Constants } from '../core/Constants.js';

const MU = Constants.MU_EARTH * 1e9;   // m^3/s^2

/**
 * The tunables, in one object so a test can switch the long fetch off for one call and put it back.
 * `MIN_RANGE_M` is 500 m (plan sky-1116: first 2 km, lowered to 500 m by the owner 2026-11-16 "Start at 500 m" after the old straight flight measured
 * 12 m/s of her 50 at 300 m, 16 at 500 m, 31 at 1 km and dry at 1.5 km): a fetch shorter than this keeps the old controller exactly.
 */
export const CW_FLIGHT = {
  ENABLED: true,
  /** metres: the piece must be at least this far at the spring for the curved flight to be used */
  MIN_RANGE_M: 500,
  /** metres: inside this range of the piece the old controller flies the arrival (at least 3x its approach threshold). Kept at 400 m for the
   *  500 m-2 km fetches (L-500, 2026-11-16, `_cwRig` `flyFetch`, 10 m/s, 400 km): a 500 m fetch flies only 100 m of curve yet costs 9.3 m/s of
   *  her 50, the same as 1 km (9.2) and 2 km (9.6), and she is caught within 17 m at every range; a smaller handover would save 1-2 m/s
   *  (200 m: 7.8 at 500 m) but leaves the last stretch open-loop and moves every `RouteCost.DAUGHTER_CURVE` row. */
  HANDOFF_M: 400,
  /** real seconds between mid-course corrections */
  REPLAN_REAL_S: 8,
  /** no correction when fewer world seconds than this fraction of an orbit remain (the solve is ill-conditioned near the end) */
  NO_REPLAN_ORBITS: 0.06,
  /** the transfer is looked for up to this many orbits */
  T_MAX_ORBITS: 3,
  /** the path may bulge out to this fraction of the tether (the daughter is recalled at 0.95) */
  TETHER_FRACTION: 0.9,
  /** a correction bigger than this many times her launch speed means the plan broke: the old controller takes over */
  MAX_CORRECTION_X_SPEED: 1.5,
  /** the drawn path has this many points */
  PATH_POINTS: 48,
  /** degrees: the spring pushes along the strut, so the plan's launch direction may be this far off the strut. The ceremony turns the ship
   *  so the strut is on it (about 1 degree); with the ship holding still the strut reaches only its meridian plane and the plan taken is
   *  one within this of it. The first mid-course correction pays the rest: measured in `_cwRig` about +0.18 m/s per degree of a 47.5 m/s
   *  tank (10.1 m/s at 0 degrees, 12.4 at 15) at 2, 5 and 10 km, the catch still within 30 m */
  AIM_TOL_DEG: 15,
  /** ms: how long an aim-time plan (the direction the strut is turned to) is kept before it is solved again */
  AIM_REFRESH_MS: 1000,
};

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.sqrt(dot(a, a));

/**
 * The LVLH triple of an orbit state and its mean motion.
 * @param {number[]} R metres @param {number[]} V m/s @returns {{x:number[], y:number[], z:number[], n:number}}
 */
export function lvlhBasis(R, V) {
  const rn = norm(R);
  const x = [R[0] / rn, R[1] / rn, R[2] / rn];
  const h = cross(R, V);
  const hn = norm(h);
  const z = [h[0] / hn, h[1] / hn, h[2] / hn];
  const y = cross(z, x);
  return { x, y, z, n: Math.sqrt(MU / (rn * rn * rn)) };
}

/** Components of a scene-axes vector in the triple. */
const toL = (b, v) => [dot(v, b.x), dot(v, b.y), dot(v, b.z)];
/** A triple's components back to scene axes. */
const fromL = (b, c) => [
  b.x[0] * c[0] + b.y[0] * c[1] + b.z[0] * c[2],
  b.x[1] * c[0] + b.y[1] * c[1] + b.z[1] * c[2],
  b.x[2] * c[0] + b.y[2] * c[1] + b.z[2] * c[2],
];

/**
 * Hill's equations in closed form: the relative state `t` seconds on, from `r0`, `v0` in the rotating triple.
 * @param {number} n rad/s @param {number} t s @param {number[]} r0 @param {number[]} v0 (rate seen in the rotating triple)
 * @returns {{r:number[], v:number[]}}
 */
export function cwPropagate(n, t, r0, v0) {
  const s = Math.sin(n * t), c = Math.cos(n * t), nt = n * t;
  const [x0, y0, z0] = r0, [vx0, vy0, vz0] = v0;
  return {
    r: [
      (4 - 3 * c) * x0 + (s / n) * vx0 + (2 / n) * (1 - c) * vy0,
      6 * (s - nt) * x0 + y0 + (2 / n) * (c - 1) * vx0 + ((4 * s - 3 * nt) / n) * vy0,
      c * z0 + (s / n) * vz0,
    ],
    v: [
      3 * n * s * x0 + c * vx0 + 2 * s * vy0,
      6 * n * (c - 1) * x0 - 2 * s * vx0 + (4 * c - 3) * vy0,
      -n * s * z0 + c * vz0,
    ],
  };
}

/**
 * The rate (in the rotating triple) that carries a body from `r0` to `rT` in `t` seconds; null where the transfer is singular.
 * @param {number} n @param {number} t @param {number[]} r0 @param {number[]} rT @returns {number[]|null}
 */
export function cwVelocityTo(n, t, r0, rT) {
  const s = Math.sin(n * t), c = Math.cos(n * t), nt = n * t;
  if (Math.abs(s) < 0.02) return null;
  const bx = rT[0] - (4 - 3 * c) * r0[0];
  const by = rT[1] - (6 * (s - nt) * r0[0] + r0[1]);
  const a = s / n, b = 2 * (1 - c) / n, cc = 2 * (c - 1) / n, d = (4 * s - 3 * nt) / n;
  const det = a * d - b * cc;
  if (Math.abs(det) * n * n < 1e-3) return null;
  return [(bx * d - b * by) / det, (a * by - cc * bx) / det, (rT[2] - c * r0[2]) * n / s];
}

/**
 * The inputs every solve shares, put in the triple.
 * @param {{R:number[], V:number[], dd:number[], dtgt:number[], ut:number[]}} a  R, V: the mother's state (m, m/s); dd: the daughter's
 *   offset from the mother (m); dtgt: the piece's offset from the mother (m); ut: the piece's velocity minus the mother's (m/s, scene axes)
 */
function inTriple(a) {
  const b = lvlhBasis(a.R, a.V);
  const n = b.n;
  const rd0 = toL(b, a.dd), rt0 = toL(b, a.dtgt);
  const u = toL(b, a.ut);
  // a rate seen from the rotating triple is the inertial rate minus omega x r, omega = n z: (ux + n y, uy - n x, uz)
  const vt0 = [u[0] + n * rt0[1], u[1] - n * rt0[0], u[2]];
  return { b, n, rd0, rt0, vt0 };
}

// ── The exact flight: three bodies on two-body orbits, integrated (RK4) ────────────────────────────────────────────────────────
// The closed form above assumes a circular mother and linear gradient: good to a fraction of a percent at 10 km, but a mother on a
// slightly eccentric orbit (a few km of radial breathing) throws it off. The solves below start from the closed form and then
// correct the launch velocity by Newton shooting on the exact motion (the mother, the piece and the daughter each on Earth's pull).
// Cancellation is not a problem: 7e6 m in doubles keeps 1e-9 m, and offsets are kilometres.

const _s = new Float64Array(18), _k1 = new Float64Array(18), _k2 = new Float64Array(18), _k3 = new Float64Array(18), _k4 = new Float64Array(18), _t = new Float64Array(18);

function deriv(s, ds) {
  for (let b = 0; b < 3; b++) {
    const o = b * 6;
    const x = s[o], y = s[o + 1], z = s[o + 2];
    const r2 = x * x + y * y + z * z, f = -MU / (r2 * Math.sqrt(r2));
    ds[o] = s[o + 3]; ds[o + 1] = s[o + 4]; ds[o + 2] = s[o + 5];
    ds[o + 3] = f * x; ds[o + 4] = f * y; ds[o + 5] = f * z;
  }
}

function rk4(s, h) {
  deriv(s, _k1);
  for (let i = 0; i < 18; i++) _t[i] = s[i] + 0.5 * h * _k1[i];
  deriv(_t, _k2);
  for (let i = 0; i < 18; i++) _t[i] = s[i] + 0.5 * h * _k2[i];
  deriv(_t, _k3);
  for (let i = 0; i < 18; i++) _t[i] = s[i] + h * _k3[i];
  deriv(_t, _k4);
  for (let i = 0; i < 18; i++) s[i] += h / 6 * (_k1[i] + 2 * _k2[i] + 2 * _k3[i] + _k4[i]);
}

/**
 * Fly the mother, the piece and the daughter (launched with relative velocity `u`) for `T` world seconds.
 * @param {{R:number[], V:number[], dd:number[], dtgt:number[], ut:number[]}} a  now: mother's state, daughter's and piece's offsets, piece's relative velocity
 * @param {number[]} u the daughter's velocity relative to the mother now (m/s, scene axes)
 * @param {number} T world seconds @param {(t:number, s:Float64Array)=>void} [onStep] called after every step (t: seconds so far)
 * @returns {{miss:number[], arrival:number}} miss: daughter minus piece at T (m); arrival: |their velocity difference| at T (m/s)
 */
function fly(a, u, T, onStep) {
  const s = _s;
  for (let i = 0; i < 3; i++) {
    s[i] = a.R[i]; s[3 + i] = a.V[i];
    s[6 + i] = a.R[i] + a.dtgt[i]; s[9 + i] = a.V[i] + a.ut[i];
    s[12 + i] = a.R[i] + a.dd[i]; s[15 + i] = a.V[i] + u[i];
  }
  const N = Math.max(1, Math.ceil(T / 15)), h = T / N;
  for (let k = 1; k <= N; k++) { rk4(s, h); if (onStep) onStep(k * h, s); }
  return {
    miss: [s[12] - s[6], s[13] - s[7], s[14] - s[8]],
    arrival: Math.hypot(s[15] - s[9], s[16] - s[10], s[17] - s[11]),
  };
}

/**
 * The exact flight, for tests and probes: see `fly`.
 * @param {object} a mother's state, offsets and the piece's relative velocity (as `planLaunch`) @param {number[]} u launch velocity (m/s, relative to the mother) @param {number} T world seconds
 * @returns {{miss:number[], arrival:number}} daughter minus piece at T (m), and their speed difference (m/s)
 */
export function exactFlight(a, u, T) { return fly(a, u, T); }

/** Solve the 3x3 system M x = b (Cramer); null when singular. */
function solve3(m, b) {
  const det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  if (!(Math.abs(det) > 1e-12)) return null;
  const c = (col) => {
    const t = [m[0].slice(), m[1].slice(), m[2].slice()];
    for (let r = 0; r < 3; r++) t[r][col] = b[r];
    return (t[0][0] * (t[1][1] * t[2][2] - t[1][2] * t[2][1]) - t[0][1] * (t[1][0] * t[2][2] - t[1][2] * t[2][0]) + t[0][2] * (t[1][0] * t[2][1] - t[1][1] * t[2][0])) / det;
  };
  return [c(0), c(1), c(2)];
}

/**
 * Correct a launch velocity so the exact flight meets the piece after `T` seconds (Newton shooting, finite-difference Jacobian).
 * @param {object} a see `fly` @param {number} T @param {number[]} uGuess @returns {{u:number[], missM:number}|null} null: did not converge
 */
function shootVelocity(a, T, uGuess) {
  let u = uGuess.slice();
  let miss = fly(a, u, T).miss;
  for (let it = 0; it < 10; it++) {
    const m0 = norm(miss);
    if (m0 < 0.05) return { u, missM: m0 };
    const eps = 1e-3, J = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let j = 0; j < 3; j++) {
      const up = u.slice(); up[j] += eps;
      const mj = fly(a, up, T).miss;
      for (let r = 0; r < 3; r++) J[r][j] = (mj[r] - miss[r]) / eps;
    }
    const du = solve3(J, [-miss[0], -miss[1], -miss[2]]);
    if (!du || !(norm(du) < 5)) return null;
    u = [u[0] + du[0], u[1] + du[1], u[2] + du[2]];
    miss = fly(a, u, T).miss;
  }
  return norm(miss) < 1 ? { u, missM: norm(miss) } : null;
}

/** Largest distance from the mother along the exact flight of `u` over `T`. */
function pathMaxOf(a, u, T) {
  let m = 0;
  fly(a, u, T, (t, s) => { m = Math.max(m, Math.hypot(s[12] - s[0], s[13] - s[1], s[14] - s[2])); });
  return m;
}

/**
 * Plan the launch: the direction (in the scene's axes) and the transfer time that put a daughter leaving at `speedPhys` onto the piece.
 * The closed form finds the first transfer, fastest first, whose launch speed is `speedPhys` and whose path stays inside `maxRangeM`;
 * with `exact` (the default) Newton shooting on the exact flight then corrects the velocity and the time (the speed is held).
 * @param {{R:number[], V:number[], dd:number[], dtgt:number[], ut:number[], speedPhys:number, maxRangeM:number}} a see `inTriple`;
 *   speedPhys: true m/s; maxRangeM: how far from the mother the path may go
 * @param {{exact?: boolean, accept?: (dir:number[], T:number)=>boolean}} [opts] accept: the crossbow pushes along its strut, so the caller may
 *   refuse a transfer whose launch direction (unit, scene axes) the strut cannot take; the search goes on to the next speed-matching transfer
 * @returns {{T:number, u:number[], dir:number[], arrivalRelMps:number, pathMaxM:number, missM:number}|null} T world seconds; u the launch velocity
 *   (scene axes, m/s, relative to the mother); arrivalRelMps the true speed relative to the piece on arrival; missM the exact flight's miss
 *   (0 for the closed form); null: no such transfer
 */
export function planLaunch(a, opts = {}) {
  const exact = opts.exact !== false;
  const { b, n, rd0, rt0, vt0 } = inTriple(a);
  const period = 2 * Math.PI / n;
  const speed = a.speedPhys;
  const solve = (T) => {
    const tgt = cwPropagate(n, T, rt0, vt0);
    const vd = cwVelocityTo(n, T, rd0, tgt.r);
    if (!vd) return null;
    const u = [vd[0] - n * rd0[1], vd[1] + n * rd0[0], vd[2]];
    return { vd, tgt, u, mag: norm(u) };
  };
  const pathMax = (vd, T) => {
    let m = 0;
    for (let i = 1; i <= 64; i++) m = Math.max(m, norm(cwPropagate(n, T * i / 64, rd0, vd).r));
    return m;
  };
  const step = period * 0.004, tMax = period * CW_FLIGHT.T_MAX_ORBITS;
  let prev = null;
  for (let T = period * 0.01; T <= tMax; T += step) {
    const r = solve(T);
    const g = r ? r.mag - speed : null;
    if (prev && g !== null && prev.g > 0 && g <= 0) {
      let lo = prev.T, hi = T;
      for (let k = 0; k < 50; k++) {
        const mid = 0.5 * (lo + hi), rm = solve(mid);
        if (!rm) break;
        if (rm.mag - speed > 0) lo = mid; else hi = mid;
      }
      const Tr = 0.5 * (lo + hi), res = solve(Tr);
      if (res) {
        let uS = fromL(b, res.u), Tuse = Tr, pm = pathMax(res.vd, Tr), missM = 0;
        if (exact) {
          // Newton shooting on the exact flight; the time moves (secant on the closed form's slope) until the speed is the spring's
          let u = uS, ok = true;
          for (let k = 0; k < 8 && ok; k++) {
            const sh = shootVelocity(a, Tuse, u);
            if (!sh) { ok = false; break; }
            u = sh.u; missM = sh.missM;
            const g2 = norm(u) - speed;
            if (Math.abs(g2) < 2e-4 * speed) break;
            const dT = Math.max(1, Tuse * 1e-3);
            const m1 = solve(Tuse - dT), m2 = solve(Tuse + dT);
            const slope = m1 && m2 ? (m2.mag - m1.mag) / (2 * dT) : 0;
            if (!(slope < 0)) { ok = false; break; }
            Tuse = Math.min(tMax, Math.max(period * 0.01, Tuse - Math.max(-0.1 * Tuse, Math.min(0.1 * Tuse, g2 / slope))));
          }
          if (!ok || Math.abs(norm(u) - speed) > 2e-3 * speed) { prev = g === null ? null : { T, g }; continue; }
          uS = u; pm = pathMaxOf(a, u, Tuse);
        }
        const un0 = norm(uS);
        if (pm <= a.maxRangeM && (!opts.accept || opts.accept([uS[0] / un0, uS[1] / un0, uS[2] / un0], Tuse))) {
          const un = norm(uS);
          const arrive = exact ? fly(a, uS, Tuse).arrival
            : (() => { const e = cwPropagate(n, Tuse, rd0, res.vd); return norm([e.v[0] - res.tgt.v[0], e.v[1] - res.tgt.v[1], e.v[2] - res.tgt.v[2]]); })();
          return { T: Tuse, u: uS, dir: [uS[0] / un, uS[1] / un, uS[2] / un], arrivalRelMps: arrive, pathMaxM: pm, missM };
        }
      }
    }
    prev = g === null ? null : { T, g };
  }
  return null;
}

/**
 * Mid-course: the velocity (scene axes, m/s, relative to the mother) she needs now to meet the piece `Trem` world seconds on: the
 * closed form corrected by Newton shooting on the exact flight (the closed form alone if that does not converge).
 * @param {{R:number[], V:number[], dd:number[], dtgt:number[], ut:number[], Trem:number}} a see `inTriple`; dd, dtgt: now
 * @returns {number[]|null} null where the closed form is singular
 */
export function replanVelocity(a) {
  const { b, n, rd0, rt0, vt0 } = inTriple(a);
  const tgt = cwPropagate(n, a.Trem, rt0, vt0);
  const vd = cwVelocityTo(n, a.Trem, rd0, tgt.r);
  if (!vd) return null;
  const guess = fromL(b, [vd[0] - n * rd0[1], vd[1] + n * rd0[0], vd[2]]);
  const sh = shootVelocity(a, a.Trem, guess);
  return sh ? sh.u : guess;
}

/**
 * Where she goes if she coasts: `count` offsets from the mother (scene axes, metres) over `T` world seconds, from her state now, on the
 * exact flight.
 * @param {{R:number[], V:number[], dd:number[], dtgt:number[], ut:number[], ud:number[], T:number, count?:number}} a  ud: her velocity relative to the mother (m/s, scene axes)
 * @returns {number[][]}
 */
export function coastPath(a) {
  const count = a.count || CW_FLIGHT.PATH_POINTS;
  const out = [a.dd.slice()];
  const dtS = a.T / (count - 1);
  // sample the exact flight at the nearest step; the flight's own step is ~15 s so the offset error is a few metres, only drawn
  const N = Math.max(1, Math.ceil(a.T / 15)), h = a.T / N;
  let next = 1;
  fly(a, a.ud, a.T, (t, s) => {
    while (next < count && t + 1e-9 >= next * dtS) { out.push([s[12] - s[0], s[13] - s[1], s[14] - s[2]]); next++; }
  });
  while (out.length < count) out.push(out[out.length - 1].slice());
  return out;
}

/**
 * The gravity-gradient acceleration of a body `d` metres from the mother (who is at `Rm` from Earth's centre): the difference of
 * Earth's pull there and at her, m/s^2, scene axes. This is what the daughter feels and the old flight left out.
 * @param {number[]} Rm @param {number[]} d @param {number[]} [out] @returns {number[]}
 */
export function tideAccel(Rm, d, out = [0, 0, 0]) {
  const r2 = dot(Rm, Rm), rn3 = r2 * Math.sqrt(r2);
  const q = [Rm[0] + d[0], Rm[1] + d[1], Rm[2] + d[2]];
  const q2 = dot(q, q), qn3 = q2 * Math.sqrt(q2);
  out[0] = MU * (Rm[0] / rn3 - q[0] / qn3);
  out[1] = MU * (Rm[1] / rn3 - q[1] / qn3);
  out[2] = MU * (Rm[2] / rn3 - q[2] / qn3);
  return out;
}

/**
 * The route model's version of a long fetch: a piece standing still in her frame (the same orbit) `distanceM` ahead along the track at
 * height `altKm`, fetched at `speedPhys`. What the game bills a daughter for it is the arrival kill (the arrival speed relative to the
 * piece, equal to the launch speed for a piece standing still in her frame) and the time is the transfer's. Closed form only (the route
 * planner prices many legs; the exact shooting is for the flight itself).
 * @param {{distanceM:number, altKm:number, speedPhys:number, maxRangeM:number}} a
 * @returns {{ok:boolean, T:number, arrivalRelMps:number, pathMaxM:number}|null} null: no transfer (the caller prices the old way)
 */
export function fetchModel(a) {
  const r = (Constants.EARTH_RADIUS_KM + a.altKm) * 1000;
  const vc = Math.sqrt(MU / r);
  const n = vc / r;
  const p = planLaunch({
    R: [r, 0, 0], V: [0, vc, 0], dd: [0, 0, 0], dtgt: [0, a.distanceM, 0],
    // standing still in the triple: inertial rate = omega x r = n z x (0, D, 0) = (-n D, 0, 0)
    ut: [-n * a.distanceM, 0, 0], speedPhys: a.speedPhys, maxRangeM: a.maxRangeM,
  }, { exact: false });
  return p ? { ok: true, T: p.T, arrivalRelMps: p.arrivalRelMps, pathMaxM: p.pathMaxM } : null;
}
