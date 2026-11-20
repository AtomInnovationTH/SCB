/**
 * PairCurveAim.js - a pair shot aims each strut at its piece's CURVE launch direction, not at the line of sight (plan sky-1116, lane
 * L-pairaim, Wave 1c).
 *
 * WHY. Past `CW_FLIGHT.MIN_RANGE_M` a daughter flies the Clohessy-Wiltshire intercept (`DaughterCW.planLaunch`), launched along a direction
 * that is 40-90 degrees off the line to the piece. The spring pushes along the strut and `ArmUnit._cwPlanAtLaunch` takes a plan only within
 * `AIM_TOL_DEG` (15) of the strut, so a pair whose struts sit on the lines of sight flew the OLD flight (measured L-500, `_cwRig`: 800 m +
 * 800 m cost 24.5 m/s each of 47.5, 600 m + 1.5 km ran one dry). The single-daughter ceremony already turns the strut to
 * `ArmUnit.cwAimDirection`; this module gives the pair the same thing at the places a pair is judged: the aim, the fire barrier, the
 * offer search, the standing offer and the pair-setup rule.
 *
 * The rule (one place, so every judge agrees): outside training, a piece at least `CW_FLIGHT.MIN_RANGE_M` away that has a plan is aimed
 * by the plan's launch direction (unit); every other piece by its line of sight, as before. Under 500 m and in training 1-3 nothing changes.
 *
 * Pure: no game objects. The live aim reads the plan through `ArmUnit.cwAimDirection` (the very plan the spring will solve); the pair-setup
 * rule judges PREDICTED end points, where only relative states exist, so `curveDirLvlh` plans from a relative state in her LVLH frame.
 * @module systems/PairCurveAim
 */
import { Constants } from '../core/Constants.js';
import { CW_FLIGHT, planLaunch } from '../entities/DaughterCW.js';
import { TimeAuthority } from './TimeAuthority.js';
import { isTrainingNow } from './TrainingHintGate.js';

const MU = Constants.MU_EARTH * 1e9;   // m^3/s^2

/** Seconds (the pair clock) a piece's plan is reused: the aim refines 4 times a second, the plan moves with the orbit at ~0.65 deg/s. */
export const CURVE_REUSE_S = 0.2;

/**
 * Is a pair shot's piece at `rangeM` aimed by its curve here (the switch on, outside training, at least `MIN_RANGE_M` away)?
 * `ArmUnit._cwEligibleInputs` asks the same three things of the arm itself.
 * @param {number} rangeM metres from the strut tip to the piece
 */
export function curveAimOn(rangeM) {
  return CW_FLIGHT.ENABLED && !isTrainingNow() && rangeM >= CW_FLIGHT.MIN_RANGE_M;
}

/**
 * The curve launch direction of a piece from a RELATIVE state in her LVLH frame (x radial out, y along the track, z orbit normal): what
 * `planLaunch` gives for a daughter leaving her centre at `speedGame` (game units, m/s). `vel` is the piece's rate as seen in the
 * rotating frame (`PairSetup.lvlhFrame().rel`, the planner's own states); the inertial rate `planLaunch` wants is that plus the frame's
 * rotation. The mother is put on the circular orbit of her mean motion (what Hill's equations assume).
 * @param {{n:number, pos:number[], vel:number[], speedGame:number, tetherMax:number}} o n rad/s, pos m, vel m/s, tetherMax m
 * @returns {{dir:number[], T:number}|null} dir unit, LVLH components; T world seconds; null: no plan (the old flight, aim at the piece)
 */
export function curveDirLvlh(o) {
  const n = o.n;
  if (!(n > 0)) return null;
  const r = Math.cbrt(MU / (n * n));
  const [px, py, pz] = o.pos, [vx, vy, vz] = o.vel;
  const plan = planLaunch({
    R: [r, 0, 0], V: [0, n * r, 0], dd: [0, 0, 0], dtgt: [px, py, pz],
    ut: [vx - n * py, vy + n * px, vz],
    speedPhys: o.speedGame / TimeAuthority.armScale(), maxRangeM: o.tetherMax * CW_FLIGHT.TETHER_FRACTION,   // the arm's own scale (1 under the ladder's real-speed clock, DECISIONS §70 row 6), so the pair rule plans what the spring will take
  });
  return plan ? { dir: plan.dir, T: plan.T } : null;
}

/**
 * The aim vector of a piece in LVLH: its curve direction scaled to its range when a plan exists and the rule is on, else its line of
 * sight (`pos`). Metres, so the solver's tip-to-piece bearing stays what it was for a line of sight.
 * @param {{n:number, pos:number[], vel:number[], speedGame:number, tetherMax:number}} o as `curveDirLvlh`
 * @returns {number[]}
 */
export function aimVecLvlh(o) {
  const l = Math.hypot(o.pos[0], o.pos[1], o.pos[2]);
  if (!curveAimOn(l)) return o.pos;
  const c = curveDirLvlh(o);
  return c ? [c.dir[0] * l, c.dir[1] * l, c.dir[2] * l] : o.pos;
}
