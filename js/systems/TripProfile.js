/**
 * TripProfile - what a climb or a descent between two debris fields costs her, flown with the real thruster
 * (Nets step 3 slice 2b, DECISIONS §33 rows 6 and 10, FEATURE_FLAGS.FIELDS_BY_HEIGHT; plan decision I).
 *
 * PURE: numbers in, numbers out, no scene and no state. TransferTrip plays the result, FieldRegistry and (lane 2b-2)
 * the "where next" list read days and gas from it.
 *
 * The model is a continuous push along (or against) her motion on a circular spiral, the standard low-thrust result:
 *
 *     da/dt = 2 * sqrt(a^3 / mu) * (dir * cos * T / m  -  d)        (a: semi-major axis, d: the drag slowing her)
 *     dm/dt = -T / (Isp * g0)                                       (Tsiolkovsky's differential)
 *
 * `dir` is +1 for a climb, -1 for a descent (her nose then points against her motion: the drag helps). `cos` is how much
 * of the push really goes the way she wants (1 when she can turn to the burn attitude; less when a daughter out on her
 * line keeps her where she points: the engine still burns T, only cos x T pushes along the way). `d` comes from
 * `atmosphericDrag` (Vallado's published air, Cd 2.2; it returns a DECELERATION in km/s2, not a force) with her drag area:
 * nose-first, radiators at their angle (capped at the burn band's edge, 146 deg: `tripDragAreaM2`), wings tracking the sun
 * (MotherDragArea, slice 2a). Called without an area it takes the 146 deg reference.
 * Stepped by explicit midpoint (RK2) at TRIP.PROFILE_STEP_S game seconds; the last step is cut to land on the target.
 *
 * Checked in test-TripProfile.js against 2a's separate integrator (the research doc's 17.17 days / 1.602 kg for 350 -> 500
 * km at 18 mN) and against a step-by-step position-and-velocity simulation.
 *
 * Not here: the gas multiplier c (PlayerSatellite's consumptionMultiplier: the power share given to the thrust bus, 1.18 =
 * 1 / 0.85 at the default 40 % share, times the paid Efficient Ion Drive upgrade, 0.8) is folded into the Isp the caller
 * passes in (FieldRegistry.planTo: isp / c), so the profile's kg is what the tank is billed.
 *
 * Owed (the plan's list): the thruster's 600 W and Earth's shadow (the profile assumes a steady push); air that turns with
 * the Earth; node drift between heights (J2).
 */
import { Constants } from '../core/Constants.js';
import { atmosphericDrag } from '../entities/OrbitalMechanics.js';
import { motherDragAreaM2, referenceDragAreaM2, wingNormalAt } from '../entities/MotherDragArea.js';
import { DEG2RAD, clamp01, clamp } from '../core/MathUtil.js';

const SECONDS_PER_DAY = 86400;
/** `tripDragAreaM2` answers by radiator angle (radians, exact): a handful of angles are asked for, again and again. */
const _areaByTheta = new Map();
/** The most samples a profile keeps (the integrator may take 70 000 steps for a long climb). */
const MAX_SAMPLES = 1200;

/**
 * The real thrust of the loaded gas, N: the BHT-600's 39 mN on xenon times the gas's `thrustScale` (argon 0.46 = 18 mN).
 * @param {{thrustScale?: number}|null} fuel a FUELS entry
 * @returns {number}
 */
export function realThrustN(fuel) {
  const s = fuel && fuel.thrustScale > 0 ? fuel.thrustScale : 1;
  return Constants.TRIP.XENON_THRUST_N * s;
}

/**
 * The drag area a trip is flown with (review F3, plan decision I): nose-first, her radiators at THEIR angle capped at the burn
 * band's edge (TRIP.BURN_POSE_MAX_DEG, 146 deg: above it she gets no push and waits for them, so no trip flies higher), both
 * wings out and tracking the sun (the mean over the wing's turn, as `referenceDragAreaM2` takes it). At 146 deg it IS the
 * reference area; at another angle the radiators show another area across her nose (measured: 7.41 m2 at 90 deg, 4.72 m2 at 30 deg,
 * against 5.79 m2 at 146 deg, wings included).
 * @param {number} [thetaRad] her radiators' angle; missing or not a number = the burn band's edge
 * @returns {number} m2
 */
export function tripDragAreaM2(thetaRad) {
  const cap = Constants.TRIP.BURN_POSE_MAX_DEG * DEG2RAD;
  const th = Number.isFinite(thetaRad) ? clamp(thetaRad, 0, cap) : cap;
  const hit = _areaByTheta.get(th);
  if (hit !== undefined) return hit;
  const N = 180;                                       // midpoints of 1-degree bins over the wing's turn 0..180 deg
  const wings = [{ scale: 1, nx: 0, ny: 0, nz: 0 }, { scale: 1, nx: 0, ny: 0, nz: 0 }];
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const n = wingNormalAt((i + 0.5) * DEG2RAD);
    for (const w of wings) { w.nx = n.nx; w.ny = n.ny; w.nz = n.nz; }
    sum += motherDragAreaM2(0, 0, 1, th, wings);
  }
  const area = sum / N;
  if (_areaByTheta.size > 64) _areaByTheta.clear();
  _areaByTheta.set(th, area);
  return area;
}

/**
 * A trip wait's bound in real seconds: `baseS` as it is, or at most Constants.TRIP.SKIP_S with the dev `?skipTrip=1`.
 * @param {number} baseS
 * @returns {number}
 */
export function tripWaitCap(baseS) {
  const k = Constants.TRIP.SKIP_S;
  return k > 0 ? Math.min(baseS, k) : baseS;
}

/**
 * Real seconds a trip of `days` plays in (row 10: "sped up to 1-2 minutes"): clamp(PLAY_BASE_S + PLAY_PER_DAY_S x days,
 * PLAY_MIN_S, PLAY_MAX_S).
 * @param {number} days
 * @returns {number}
 */
export function playSeconds(days) {
  const T = Constants.TRIP;
  if (T.SKIP_S > 0) return T.SKIP_S;                // dev `?skipTrip=1`: the trip plays in a few seconds (days, gas and credits follow the share played)
  const d = Number.isFinite(days) && days > 0 ? days : 0;
  return clamp(T.PLAY_BASE_S + T.PLAY_PER_DAY_S * d, T.PLAY_MIN_S, T.PLAY_MAX_S);
}

/**
 * Nets step 3 slice 4 (S2): the days a trip takes on the ship's clock when its push waits `waitS` real seconds for her nose first. The
 * trip counts a wait as flown time (`TransferTrip._flownDays`: the profile's days x the real seconds flown / the seconds it plays in), so the
 * wait adds `days x waitS / playSeconds(days)`. PURE.
 * @param {number} days the profile's days @param {number} waitS real seconds the push waits for her nose (>= 0)
 * @returns {number} days
 */
export function daysWithTurnWait(days, waitS) {
  if (!(days > 0) || !(waitS > 0)) return days;
  const play = playSeconds(days);
  return play > 0 ? days * (1 + waitS / play) : days;
}

/**
 * Fly a climb or descent between two circular orbits.
 * @param {object} p
 * @param {number} p.fromKm        altitude she leaves (km above the surface)
 * @param {number} p.toKm          altitude she wants (km)
 * @param {number} p.massKg        her mass at departure (live)
 * @param {number} p.thrustN       the engine's thrust (N): `realThrustN(fuel)`
 * @param {number} p.ispS          the gas's Isp (s)
 * @param {number} [p.areaM2]      her drag area (m2); default `referenceDragAreaM2()` (radiators at 146 deg; FieldRegistry.planTo
 *                                 passes `tripDragAreaM2(her radiator angle)`)
 * @param {number} [p.cos=1]       the share of the push that goes the way she wants, 0..1 (the cos of her angle to it)
 * @param {boolean} [p.drag=true]  false = the air is off (checks and the "drag off" case of the research doc)
 * @param {number} [p.stepS]       game seconds per step (default `Constants.TRIP.PROFILE_STEP_S`)
 * @returns {{ok: boolean, reason: (string|null), dir: number, fromKm: number, toKm: number, days: number, tEndS: number,
 *   m0: number, m1: number, gasKg: number, dvMps: number,
 *   samples: Array<{t: number, a: number, m: number}>}}
 *   `samples`: t game seconds from departure, a semi-major axis in km, m mass in kg (at most ~1200, first and last included).
 *   `ok` false: `reason` 'drag' (the air beats the push and she never gets there), 'push' (no push the way she wants),
 *   'days' (not arrived by TRIP.PROFILE_MAX_DAYS), 'input' (a number was not usable).
 */
export function tripProfile(p) {
  const C = Constants;
  const RE = C.EARTH_RADIUS_KM;
  const mu = C.MU_EARTH;
  const fromKm = Number(p && p.fromKm);
  const toKm = Number(p && p.toKm);
  const m0 = Number(p && p.massKg);
  const T = Number(p && p.thrustN);
  const isp = Number(p && p.ispS);
  const cosIn = p && p.cos !== undefined ? Number(p.cos) : 1;
  const area = p && p.areaM2 !== undefined ? Number(p.areaM2) : referenceDragAreaM2();
  const dragOn = !(p && p.drag === false);
  const stepS = p && p.stepS > 0 ? p.stepS : C.TRIP.PROFILE_STEP_S;
  const bad = (reason) => ({
    ok: false, reason, dir: 0, fromKm, toKm, days: 0, tEndS: 0, m0, m1: m0, gasKg: 0, dvMps: 0, samples: [],
  });
  if (![fromKm, toKm, m0, T, isp, cosIn, area].every(Number.isFinite) || !(m0 > 0) || !(T > 0) || !(isp > 0)
      || !(fromKm > 0) || !(toKm > 0)) return bad('input');

  const dir = toKm > fromKm ? 1 : (toKm < fromKm ? -1 : 0);
  if (dir === 0) {
    const s = [{ t: 0, a: RE + fromKm, m: m0 }];
    return { ok: true, reason: null, dir: 0, fromKm, toKm, days: 0, tEndS: 0, m0, m1: m0, gasKg: 0, dvMps: 0, samples: s };
  }
  const cos = clamp01(cosIn);
  if (!(cos > 1e-9)) return bad('push');

  const ve = isp * C.G0;                          // exhaust speed, m/s
  const mdot = T / ve;                            // kg/s: the engine burns T whatever way it points
  const push = dir * cos * T;                     // N along her motion (signed)
  const aTarget = RE + toKm;
  const tMax = C.TRIP.PROFILE_MAX_DAYS * SECONDS_PER_DAY;

  // da/dt (km/s) at (a km, m kg)
  const rate = (a, m) => {
    const v = Math.sqrt(mu / a);                  // circular speed, km/s
    const d = dragOn ? atmosphericDrag(a - RE, v, area, m) : 0;   // km/s2, positive slows her
    return 2 * Math.sqrt(a * a * a / mu) * (push / m / 1000 - d);
  };

  let a = RE + fromKm;
  let m = m0;
  let t = 0;
  const ts = [0];
  const as = [a];
  const ms = [m];
  let ok = true;
  let reason = null;
  while (true) {
    const r0 = rate(a, m);
    if (!(dir * r0 > 0)) { ok = false; reason = dir > 0 ? 'drag' : 'push'; break; }   // she is not getting there
    const aMid = a + 0.5 * stepS * r0;
    const mMid = m - 0.5 * stepS * mdot;
    const rMid = rate(aMid, mMid);
    const a1 = a + stepS * rMid;
    const m1 = m - stepS * mdot;
    const done = dir > 0 ? a1 >= aTarget : a1 <= aTarget;
    if (done) {
      const frac = clamp01((aTarget - a) / (a1 - a));
      t += frac * stepS;
      m -= frac * stepS * mdot;
      a = aTarget;
      ts.push(t); as.push(a); ms.push(m);
      break;
    }
    a = a1; m = m1; t += stepS;
    ts.push(t); as.push(a); ms.push(m);
    if (t >= tMax) { ok = false; reason = 'days'; break; }
  }

  // keep at most MAX_SAMPLES, evenly by index, the last one always
  const n = ts.length;
  const samples = [];
  if (n <= MAX_SAMPLES) {
    for (let i = 0; i < n; i++) samples.push({ t: ts[i], a: as[i], m: ms[i] });
  } else {
    for (let k = 0; k < MAX_SAMPLES - 1; k++) {
      const i = Math.round(k * (n - 1) / (MAX_SAMPLES - 1));
      samples.push({ t: ts[i], a: as[i], m: ms[i] });
    }
    samples.push({ t: ts[n - 1], a: as[n - 1], m: ms[n - 1] });
  }
  const gasKg = m0 - m;
  return {
    ok, reason, dir, fromKm, toKm,
    days: t / SECONDS_PER_DAY, tEndS: t,
    m0, m1: m, gasKg, dvMps: ve * Math.log(m0 / m),
    samples,
  };
}

/**
 * Where the profile has her at `fraction` of its length in time (0..1): t, semi-major axis a (km), altitude (km) and mass m.
 * Linear between the kept samples; fractions outside 0..1 clamp. A profile with no samples answers its departure numbers.
 * @param {{samples: Array<{t: number, a: number, m: number}>, tEndS: number, fromKm: number, m0: number}} profile
 * @param {number} fraction
 * @returns {{t: number, a: number, altKm: number, m: number, fraction: number}}
 */
export function profileAt(profile, fraction) {
  const RE = Constants.EARTH_RADIUS_KM;
  const s = profile && profile.samples;
  const f = Number.isFinite(fraction) ? clamp01(fraction) : 0;
  if (!s || s.length === 0) {
    return { t: 0, a: RE + (profile ? profile.fromKm : 0), altKm: profile ? profile.fromKm : 0, m: profile ? profile.m0 : 0, fraction: f };
  }
  const t = f * profile.tEndS;
  let lo = 0;
  let hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid].t <= t) lo = mid; else hi = mid;
  }
  const A = s[lo];
  const B = s[hi];
  const w = B.t > A.t ? clamp01((t - A.t) / (B.t - A.t)) : 0;
  const a = A.a + w * (B.a - A.a);
  return { t, a, altKm: a - RE, m: A.m + w * (B.m - A.m), fraction: f };
}
