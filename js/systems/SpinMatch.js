/**
 * SpinMatch.js: the pure rules of spin matching (DECISIONS §70 row 4; plan debris-1 lane M, D8 and M-a..M-i). A daughter at a
 * piece in station-keep can circle it IN STEP with its spin: she holds her place in the piece's rotating frame, so its spin
 * relative to her is zero and every catch tool judges it as a still piece. Nothing here reads a mesh, a clock or a scene; ArmUnit
 * runs the motion, ToolOdds and CaptureNet read `relativeSpinRad`.
 *
 * THE PHYSICS (no tuning): turning with the piece at angular rate w on a circle of radius rho round its spin axis she needs the
 * centripetal push m·w²·rho from her cold-gas jet. So w_max = sqrt(F / (m·rho)) with her real jet F and mass m (the bottle's gas
 * counts), and the gas each world second is m·w²·rho / (Isp·g0) (the jet's own exhaust speed). Getting onto the circle costs the
 * one-off tangential spin-up m·w·rho / ve plus the move there; stopping costs the spin-down m·w·rho / ve again.
 *
 * HER LINE (M-b, Ruling 0: "tether tangles are catastrophic"): her line leaves toward the mother in direction u, nearly fixed (the
 * mother is far). Over a whole lap the line passes the piece's centre no closer than rho·|cos a| (a = angle between u and the spin
 * axis). Derivation: with her at p (|p| = rho, p perpendicular to the axis) the line's distance from the centre is sqrt(rho² - (p·u)²),
 * and p·u reaches at most rho·sin a over the lap, so the closest it comes is rho·sqrt(1 - sin²a) = rho·|cos a|. So the circle clears the piece when rho·|cos a| >= r + LINE_CLEAR_M, r = half its size. She uses
 * rho = max(r + RHO_CLEAR_M, (r + LINE_CLEAR_M) / |cos a|) and refuses a rho past RHO_MAX_M ("her line would wrap the piece").
 * A swivel at her line end takes the line's own twist, one turn per lap (coordinator's assumption).
 * @module systems/SpinMatch
 */
import { Constants } from '../core/Constants.js';

const D2R = Math.PI / 180;

/**
 * The spin a catch tool judges: the piece's spin RELATIVE to the daughter that is matching it (0 while `frameId` is the arm that
 * circles it in step), else its own spin. The ONE place the rule lives (M-d). The mother's net passes no frame: she does not circle it.
 * @param {{tumbleRate?: number, _spinMatchedBy?: *}|null|undefined} piece
 * @param {*} [frameId] the judging daughter's id (undefined = the inertial frame, the piece's true spin)
 * @returns {number|undefined} rad/s (whatever the piece carries, undefined when it carries none)
 */
export function relativeSpinRad(piece, frameId) {
  if (!piece) return undefined;
  if (frameId != null && piece._spinMatchedBy === frameId) return 0;
  return piece.tumbleRate;
}

/** The cold-gas jet's exhaust speed, m/s (the same figure the latch close-in and the seat spin-down use). */
export function exhaustSpeedMs() {
  const CG = Constants.DAUGHTER_COLD_GAS || {};
  return (CG.ISP_S ?? 60) * Constants.G0;
}

/**
 * The radius she circles at (M-b).
 * @param {number} sizeMeter the piece's size (m); r = half of it
 * @param {number|null} axisDotLine cos a: spin axis . unit line direction (null / undefined = her line is not a constraint: detached, no mother)
 * @returns {{rho: number, ok: boolean}} rho in metres; ok false when the line would wrap the piece (rho past RHO_MAX_M or no clearance at all)
 */
export function matchRadiusM(sizeMeter, axisDotLine) {
  const SM = Constants.SPIN_MATCH;
  const r = Math.max(0, sizeMeter || 0) / 2;
  const smallest = r + SM.RHO_CLEAR_M;
  if (axisDotLine == null || !Number.isFinite(axisDotLine)) return { rho: smallest, ok: smallest <= SM.RHO_MAX_M };
  const c = Math.abs(axisDotLine);
  const clear = c > 1e-9 ? (r + SM.LINE_CLEAR_M) / c : Infinity;
  const rho = Math.max(smallest, clear);
  return { rho, ok: rho <= SM.RHO_MAX_M };
}

/** @returns {number} the fastest spin she can hold in step on a circle of radius rho (rad/s): sqrt(F / (m·rho)) */
export function omegaMaxRadS(thrustN, massKg, rho) {
  if (!(thrustN > 0) || !(massKg > 0) || !(rho > 0)) return 0;
  return Math.sqrt(thrustN / (massKg * rho));
}

/** @returns {number} the cold gas the centripetal push burns per world second (kg/s): m·w²·rho / ve */
export function gasRateKgS(massKg, omega, rho) {
  return massKg * omega * omega * rho / exhaustSpeedMs();
}

/** @returns {number} the one-off gas of the tangential spin-up (and again of the spin-down), kg: m·w·rho / ve */
export function spinStepKg(massKg, omega, rho) {
  return massKg * omega * rho / exhaustSpeedMs();
}

/**
 * The move from where she stands onto the circle: bang-bang along a path of length `pathM` at her true acceleration a = F/m
 * (speed up half way, brake the other half): time 2·sqrt(L/a), delta-v 2·sqrt(a·L).
 * @returns {{timeS: number, dvMps: number}}
 */
export function moveProfile(pathM, accelMs2) {
  if (!(pathM > 0) || !(accelMs2 > 0)) return { timeS: 0, dvMps: 0 };
  return { timeS: 2 * Math.sqrt(pathM / accelMs2), dvMps: 2 * Math.sqrt(accelMs2 * pathM) };
}

/** How far along a bang-bang move (0..1 of its path) she is after `tS` seconds. */
export function moveFraction(tS, pathM, accelMs2) {
  if (!(pathM > 0) || !(accelMs2 > 0)) return 1;
  const T = 2 * Math.sqrt(pathM / accelMs2);
  if (tS >= T) return 1;
  if (tS <= 0) return 0;
  const s = tS <= T / 2 ? 0.5 * accelMs2 * tS * tS : pathM - 0.5 * accelMs2 * (T - tS) * (T - tS);
  return Math.min(1, Math.max(0, s / pathM));
}

/**
 * Her own flight under her real jet (Debris 4 M fix, N1 and N3): one step of a guided move to a goal that may itself be moving and turning.
 * She never gets more than `aMax` of push (her jet's true m/s², F / m), so a start 8 m out takes seconds and a leave from the circle takes
 * seconds; nothing is snapped. The law: close on the goal at the speed she can still brake from (`sqrt(0.8·a_avail·d)`, a_avail what her jet has left
 * after the goal's own acceleration), never above `vCap`, with a soft last stretch (`d / TAU_POS_S`); the push is the goal's own acceleration plus the
 * speed error over `TAU_VEL_S`, cut back to `aMax` if it asks for more. All in one unit system (the caller passes scene units: metres x M).
 * @param {{p:{x:number,y:number,z:number}, v:{x:number,y:number,z:number}}} st her place and velocity RELATIVE TO THE PIECE'S CENTRE (mutated)
 * @param {{p:{x:number,y:number,z:number}, v:{x:number,y:number,z:number}, a:{x:number,y:number,z:number}}} goal where, how fast and how hard it accelerates, at the START of the step
 * @param {number} aMax her real jet limit (length / s²)
 * @param {number} vCap the fastest she may close on the goal (length / s)
 * @param {number} h the step (s); callers keep it at or under `GUIDE.MAX_STEP_S`
 * @returns {{dv: number, err: number, errV: number}} the delta-v she used this step (length / s: the gas bills m·dv / ve), and the position and speed errors
 *   at the END of the step, against where the goal then is
 */
export function guidedStep(st, goal, aMax, vCap, h) {
  const ex = goal.p.x - st.p.x, ey = goal.p.y - st.p.y, ez = goal.p.z - st.p.z;
  const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
  const gaLen = Math.sqrt(goal.a.x * goal.a.x + goal.a.y * goal.a.y + goal.a.z * goal.a.z);
  const aAvail = Math.max(aMax - gaLen, 0.1 * aMax);
  const s = d > 0 ? Math.min(vCap, Math.sqrt(0.8 * aAvail * d), d / GUIDE.TAU_POS_S) : 0;
  const k = d > 0 ? s / d : 0;
  // the push is the goal's own acceleration (never traded away: she must turn with it) plus the correction, the correction cut back to the jet that is left
  let cx = (ex * k - (st.v.x - goal.v.x)) / GUIDE.TAU_VEL_S;
  let cy = (ey * k - (st.v.y - goal.v.y)) / GUIDE.TAU_VEL_S;
  let cz = (ez * k - (st.v.z - goal.v.z)) / GUIDE.TAU_VEL_S;
  const gx0 = goal.a.x, gy0 = goal.a.y, gz0 = goal.a.z;
  let ax = gx0 + cx, ay = gy0 + cy, az = gz0 + cz;
  let aLen = Math.sqrt(ax * ax + ay * ay + az * az);
  if (aLen > aMax) {
    const cc = cx * cx + cy * cy + cz * cz, gc = gx0 * cx + gy0 * cy + gz0 * cz, gg = gx0 * gx0 + gy0 * gy0 + gz0 * gz0 - aMax * aMax;
    if (gg >= 0 || cc < 1e-30) {   // the goal alone asks for all she has (or more)
      const f = gaLen > 0 ? aMax / gaLen : 0; ax = gx0 * f; ay = gy0 * f; az = gz0 * f;
    } else {
      const lam = Math.max(0, (-gc + Math.sqrt(gc * gc - cc * gg)) / cc);   // the largest share of the correction that still fits (gg < 0: a real root)
      ax = gx0 + cx * lam; ay = gy0 + cy * lam; az = gz0 + cz * lam;
    }
    aLen = Math.sqrt(ax * ax + ay * ay + az * az);
  }
  st.v.x += ax * h; st.v.y += ay * h; st.v.z += az * h;
  st.p.x += st.v.x * h; st.p.y += st.v.y * h; st.p.z += st.v.z * h;
  const fx = goal.p.x + goal.v.x * h + 0.5 * goal.a.x * h * h - st.p.x, fy = goal.p.y + goal.v.y * h + 0.5 * goal.a.y * h * h - st.p.y, fz = goal.p.z + goal.v.z * h + 0.5 * goal.a.z * h * h - st.p.z;
  const gx = st.v.x - goal.v.x - goal.a.x * h, gy = st.v.y - goal.v.y - goal.a.y * h, gz = st.v.z - goal.v.z - goal.a.z * h;
  return { dv: Math.min(aLen, aMax) * h, err: Math.sqrt(fx * fx + fy * fy + fz * fz), errV: Math.sqrt(gx * gx + gy * gy + gz * gz) };
}

/** The guidance law's constants: time constants of the position and speed loops, the longest step, and the arrival tolerances (a metre, a metre/second). */
export const GUIDE = Object.freeze({ TAU_POS_S: 2, TAU_VEL_S: 1, MAX_STEP_S: 0.05, ARRIVE_M: 0.01, ARRIVE_MS: 0.003, MOVE_MAX_S: 90 });

/**
 * Can she match this piece's spin right now? Pure numbers in, the answer and the numbers a line or a tool strip needs out.
 * @param {{omegaRad: number, sizeMeter: number, axisDotLine?: number|null, massKg: number, thrustN: number,
 *   gasKg?: number, gasMode?: boolean, pathM?: number}} p
 *   omegaRad the piece's spin (rad/s, sign ignored); massKg her mass with her gas; thrustN the jet she would push with (the ion thrust
 *   with the bottle empty); gasKg the bottle (gas mode only); pathM the move onto the circle (default 0: only the budget needs it)
 * @returns {{ok: boolean, reason: 'ok'|'no_spin'|'no_jet'|'wrap'|'fast'|'gas', rho: number, omegaRad: number, omegaMaxRad: number,
 *   gasKgS: number, spinStepKg: number, moveKg: number, holdMin: number}}
 */
export function spinMatchOffer(p) {
  const SM = Constants.SPIN_MATCH;
  const w = Math.abs(p.omegaRad || 0);
  const { rho, ok: lineOk } = matchRadiusM(p.sizeMeter, p.axisDotLine);
  const wMax = omegaMaxRadS(p.thrustN, p.massKg, rho);
  const gasKgS = gasRateKgS(p.massKg, w, rho);
  const step = spinStepKg(p.massKg, w, rho);
  const a = p.massKg > 0 ? (p.thrustN || 0) / p.massKg : 0;
  const mv = moveProfile(p.pathM || 0, a);
  // The way onto the circle (Debris 4 M fix, N3): she starts at rest and ends turning at w*rho, so the cost is the rest-to-rest move, 30 % over for the
  // guided approach (measured from 4, 8 and 12 m at 12-17 deg/s: 1.9-2.9 m/s against 1.3-2.6 rest-to-rest), plus getting up to speed and back.
  const moveKg = p.massKg * (1.3 * mv.dvMps + 2 * w * rho) / exhaustSpeedMs();
  const out = (reason) => ({
    ok: reason === 'ok', reason, rho, omegaRad: w, omegaMaxRad: wMax, gasKgS, spinStepKg: step, moveKg,
    holdMin: p.gasMode && gasKgS > 0 ? Math.max(0, (p.gasKg - step - moveKg) / gasKgS) / 60 : Infinity,
  });
  if (!(w >= SM.MIN_RATE_DEG_S * D2R)) return out('no_spin');
  if (!(p.thrustN > 0)) return out('no_jet');
  if (!lineOk) return out('wrap');
  if (w > wMax) return out('fast');
  if (p.gasMode && (step + moveKg + step + gasKgS * SM.RESERVE_S > (p.gasKg || 0))) return out('gas');
  return out('ok');
}

/** A rate in the plain way the lines say it: one decimal under 10°/s, whole above. */
export function fmtDegS(rad) {
  const deg = Math.abs(rad) / D2R;
  return deg < 10 ? deg.toFixed(1) : String(Math.round(deg));
}

export default { relativeSpinRad, matchRadiusM, omegaMaxRadS, gasRateKgS, spinStepKg, moveProfile, moveFraction, guidedStep, GUIDE, spinMatchOffer, fmtDegS, exhaustSpeedMs };
