/**
 * PairRecoil.js - what a PAIR launch pushes on the mother, and what it costs her (plan sky-1116, lane L-pairaim, task 3).
 *
 * Two daughters leave in one frame. Each spring pushes the mother opposite its own launch direction with m v. If the two pushes are exactly
 * opposite and equal they cancel and the gas each daughter's push billed is refunded; otherwise the mother keeps the difference, a VECTOR
 * (two equal pushes 90 degrees apart leave sqrt(2) times one push; the scalar |m1 v1 - m2 v2| said 0). With curved launches the two struts are
 * no longer on the lines of sight, so they are not exactly opposite unless the pieces' plans are (measured, `_cwRig` `flyPair` 'plan': equal
 * ranges 0.1 cm/s, 600 m + 1.5 km 11.3 cm/s).
 *
 * Pure: arrays and numbers in, numbers out. Units follow `PlayerSatellite._applyCrossbowRecoil`: a push is `m v / M_mother` with `v` the
 * launch speed in the game's units (m/s), so one weaver at 10 m/s on 130 kg is 0.51.
 * @module systems/PairRecoil
 */
import { Constants } from '../core/Constants.js';

/** The linear recoil nudge is this fraction of the theoretical push (PlayerSatellite `_applyCrossbowRecoil`: subtle, not disorienting). */
export const RECOIL_SCALE = 0.1;

/**
 * The mother's push from a pair launch: |m1 v1 u1 + m2 v2 u2| / M, the vector sum of the two springs (each along its own launch direction,
 * the push is opposite and the same size). Equal opposite: 0. Equal 90 degrees apart: sqrt(2) times one.
 * @param {ArrayLike<number>} u1 unit @param {ArrayLike<number>} u2 unit @param {number} m1 kg @param {number} v1 m/s (game units)
 * @param {number} m2 kg @param {number} v2 @param {number} motherKg
 * @returns {number} the residual push, the units of `m v / M` (what `DUAL_FIRE_RECOIL.residualDv` carries)
 */
export function pairPush(u1, u2, m1, v1, m2, v2, motherKg) {
  const x = m1 * v1 * u1[0] + m2 * v2 * u2[0], y = m1 * v1 * u1[1] + m2 * v2 * u2[1], z = m1 * v1 * u1[2] + m2 * v2 * u2[2];
  return Math.hypot(x, y, z) / motherKg;
}

/**
 * Kilograms of N2 the mother's auto-RCS bills to take a recoil of `push` (`m v / M`, game units): the per-shot formula of
 * `PlayerSatellite._autoRcsCompensation` (3.7 g per single weaver shot at the weaver baseline, in proportion to the push, with the
 * RECOIL_SCALE the shot's own nudge uses).
 * @param {number} push
 */
export function pushN2Kg(push) {
  return Math.max(0, Constants.DUALFIRE_RCS_COMPENSATION_N2 * (push * RECOIL_SCALE) / Constants.DUALFIRE_RECOIL_WEAVER) / 1000;
}
