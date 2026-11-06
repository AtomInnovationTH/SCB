/**
 * @module systems/ChaseCost — what an autopilot chase will cost in engine gas, and whether she can get there at all
 * (DECISIONS §64 row 2, owner 2026-11-06: "warn, press A again to go"; refuse what she can't afford or reach).
 *
 * Pure numbers, no THREE / DOM. AutopilotSystem.engage() gathers the inputs and decides what to say.
 *
 * COST. The guidance (AutopilotSystem.update, "Predictive quadratic-braking profile") commands the target's velocity plus
 * v*·goalDir with v* = min(V_CAP, √(2·A_BRAKE·r)); the bill is consMult · mass · Δv / (Isp · g0) (PlayerSatellite ionGasUnits).
 * A forward integration of that law was not needed: three terms fitted on 58 measured chases (tmp/t11/ap/fit.mjs, headless
 * autopilot on a real ship, ranges 0.1-200 km, orbits 350/800 km; held out 450/900 km):
 *   Δv = relV0                                   (cancel the target's relative velocity at the start)
 *      + 2·0.78·min(V_CAP, √(2·A_BRAKE·(d − Dtrail)))   (accelerate to cruise, brake from it)
 *      + 0.65·g·d²/(R·V_CAP)                     (the straight-line chase fights gravity's curvature over d)
 * Worst error 24 % on the 58 fitted rows, 15 % on 18 held-out rows (docs: tmp/t11/ap/summary.md). Measured on a ship at
 * time rate 1 and 10; the autopilot bills the same at 4x, 20x and 100x within 10 % (test-ApRateBill.js), so the quote holds at any clock.
 *
 * CAN SHE ARRIVE. A chase at a piece AHEAD of her on her own orbit sheds orbital energy: her semi-major axis falls about
 * 2 km per km of range beyond ~68 km (measured, 350/450/800/900 km orbits, tmp/t11/ap). PlayerSatellite.applyCartesianImpulse
 * refuses any burn that leaves the semi-major axis under VLEO_MIN (200 km), so the chase stalls with the piece still far away
 * (350 km orbit: 140 km arrived with the axis down to 208 km, 148 km stalled at 199.9; 800 km orbit: 300 km arrives, 600 stalls).
 * A piece BEHIND her swings the axis up instead (about 2.2 km per km beyond ~45 km) after a first dip of at most ~85 km.
 * Both are checked against the ship's height (VLEO_MIN / LEO_MAX); unmeasured: targets off the orbit plane or on much
 * eccentric orbits are judged by range and ahead/behind only.
  */

import { formatGasUsed } from './ApproachCostLine.js';

/** Fitted cost terms (see header). */
export const CHASE_FIT = Object.freeze({ K_CRUISE: 0.78, K_CURVE: 0.65 });
/** Measured orbit-energy loss of an ahead chase: dropKm = AHEAD_DROP_KM_PER_KM · (rangeKm − AHEAD_DROP_FROM_KM). */
export const CHASE_ORBIT = Object.freeze({
  AHEAD_DROP_KM_PER_KM: 2.0, AHEAD_DROP_FROM_KM: 68,
  BEHIND_RISE_KM_PER_KM: 2.2, BEHIND_RISE_FROM_KM: 45,
  BEHIND_DROP_MAX_KM: 150, BEHIND_DROP_PER_KM: 0.5,
});

const MU_KM3_S2 = 398600.4418;
const EARTH_KM = 6371;

/**
 * @param {object} a
 * @param {number} a.rangeM          ship-to-piece distance now, m
 * @param {number} a.relSpeedMps     |piece velocity − ship velocity| now, m/s
 * @param {boolean} a.ahead          the piece is ahead of her along her velocity (else behind)
 * @param {number} a.shipAltKm       her height now, km
 * @param {number} [a.targetAltKm]   the piece's mean height (semi-major axis − Earth radius), km; omitted = hers
 * @param {number} a.trailM          the hold distance (AutopilotSystem._getTrailDistance), m
 * @param {number} a.maxAccel        AP.MAX_ACCEL, m/s²
 * @param {number} a.brakeFraction   AP.BRAKE_FRACTION
 * @param {number} a.vCap            AP.V_CAP, m/s
 * @param {number} a.thrustScale     the fuel's thrust scale
 * @param {number} a.consMult        PlayerSatellite.getConsumptionMultiplier()
 * @param {number} a.massKg          ArmManager.getMassBudget().shipMassKg
 * @param {number} a.isp             the fuel's Isp, s
 * @param {number} a.g0              standard gravity, m/s²
 * @param {number} a.vleoMinKm       the lowest semi-major axis a burn may leave (Constants.VLEO_MIN, km)
 * @param {number} a.leoMaxKm        the highest (Constants.LEO_MAX, km)
 * @returns {{argonKg: number, dvMps: number, canArrive: boolean, reason: (string|null)}}
 *   reason: null | 'LOW_ORBIT' (the chase would pull her under VLEO_MIN) | 'HIGH_ORBIT' (over LEO_MAX) | 'BAD_INPUT'
 */
export function estimateChase(a) {
  const num = (x) => Number.isFinite(x);
  if (![a.rangeM, a.relSpeedMps, a.shipAltKm, a.trailM, a.maxAccel, a.brakeFraction, a.vCap, a.thrustScale, a.consMult, a.massKg, a.isp, a.g0].every(num)
      || !(a.isp > 0) || !(a.g0 > 0) || !(a.vCap > 0)) {
    return { argonKg: NaN, dvMps: NaN, canArrive: true, reason: 'BAD_INPUT' };   // can't say: the caller lets the chase go as before
  }
  const d = Math.max(0, a.rangeM);
  const rKm = EARTH_KM + a.shipAltKm;
  const g = MU_KM3_S2 / (rKm * rKm) * 1000;                                  // m/s²
  const aBrake = a.maxAccel * a.brakeFraction * a.thrustScale;
  const cruise = 2 * CHASE_FIT.K_CRUISE * Math.min(a.vCap, Math.sqrt(2 * aBrake * Math.max(d - a.trailM, 0)));
  const curve = CHASE_FIT.K_CURVE * g * d * d / (rKm * 1000 * a.vCap);
  const dvMps = Math.max(0, a.relSpeedMps) + cruise + curve;
  const argonKg = a.consMult * a.massKg * dvMps / (a.isp * a.g0);

  const dKm = d / 1000, O = CHASE_ORBIT;
  // She ends up on the piece's orbit: its own height bounds hers (a piece at 200 km can't be reached). Every real-piece
  // stall in tmp/t11/ap/real-f350-r1.json (7 of 7) ended with her axis at the 6,571 km floor. Unknown piece height: her own.
  const pieceKm = num(a.targetAltKm) ? a.targetAltKm : a.shipAltKm;
  const baseLow = Math.min(a.shipAltKm, pieceKm), baseHigh = Math.max(a.shipAltKm, pieceKm);
  let lowestKm, highestKm;
  if (a.ahead) {
    lowestKm = baseLow - O.AHEAD_DROP_KM_PER_KM * Math.max(0, dKm - O.AHEAD_DROP_FROM_KM);
    highestKm = baseHigh;
  } else {
    lowestKm = baseLow - Math.min(O.BEHIND_DROP_MAX_KM, O.BEHIND_DROP_PER_KM * dKm);
    highestKm = baseHigh + O.BEHIND_RISE_KM_PER_KM * Math.max(0, dKm - O.BEHIND_RISE_FROM_KM);
  }
  let reason = null;
  if (lowestKm < a.vleoMinKm) reason = 'LOW_ORBIT';
  else if (highestKm > a.leoMaxKm) reason = 'HIGH_ORBIT';
  return { argonKg, dvMps, canArrive: reason === null, reason };
}

// ── What A says (DECISIONS §64 row 2). Plain words; the key name goes through GestureHints (GLASS_LINES row 'Press A again to go.').

/** A chase that costs more than this share of the gas aboard waits for a second A press. */
export const CHASE_WARN_FRACTION = 0.25;
/** The second A press must come within this long (wall-clock ms, so a paused or time-warped game doesn't stretch it). */
export const CHASE_CONFIRM_WINDOW_MS = 10000;

/** @param {number} argonKg @param {number} gasKg @param {string} gasId @returns {string} the warning that arms the second press */
export function chaseWarnLine(argonKg, gasKg, gasId) {
  const pct = Math.round(100 * argonKg / gasKg);
  return `This chase costs about ${formatGasUsed(argonKg)} of ${gasId}, ${pct}% of the ${formatGasUsed(gasKg)} you have. Press A again to go.`;
}

/** @returns {string} the refusal when the chase needs more than she has */
export function chaseNoGasLine(argonKg, gasKg, gasId) {
  return `Not enough ${gasId} for this chase: about ${formatGasUsed(argonKg)} needed, you have ${formatGasUsed(gasKg)}.`;
}

/** @param {number} rangeKm @returns {string} the refusal when the chase can never arrive */
export function chaseTooFarLine(rangeKm) {
  return `Too far for the autopilot: from this orbit it can't reach that piece (${Math.round(rangeKm)} km).`;
}
