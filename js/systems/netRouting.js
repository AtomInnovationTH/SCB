/**
 * netRouting.js — net-ladder mass routing (single source of truth).
 *
 * Pure helper shared by the Mother fire verb (InputManager.fireLasso), the
 * lasso's own too-heavy rejection (LassoSystem.fire), and any HUD that needs
 * the routing copy. Also the home of the two shared mother-net lines. Kept in its own lightweight module (Constants only, no
 * THREE / NetProjectile deps) so the input/lasso layers don't pull the heavy
 * CaptureNet module just for a mass comparison.
 *
 * @module systems/netRouting
 */

import { Constants } from '../core/Constants.js';

/**
 * The ONE line for N with no mother nets left (DECISIONS §33 row 3; owner 2026-10-20: "One line in Comms is better
 * than 2."). Every empty-magazine refusal says exactly this — the small-net path, the large-net path and the director.
 */
export const OUT_OF_MOTHER_NETS_LINE = 'Out of mother nets. Press D to send a daughter.';

/**
 * N on a piece beyond the reach of the net that would fire, but inside a docked daughter's reach (DECISIONS §33 row 8).
 * Not said while the mission-1 tutorial runs (its range beat teaches the autopilot instead).
 */
export const OUT_OF_NET_RANGE_LINE = 'Out of net range. Press D to send a daughter.';

/** A daughter with no nets: they refill only by buying at the resupply stop (DECISIONS §33 rows 5 and 8). The map-off words; read through
 *  `daughterOutOfNetsLine()` where the line is said (lane 3d: "resupply satellite" with the map on). */
export const DAUGHTER_OUT_OF_NETS_LINE = 'Out of nets. Restock at the resupply stop.';
export { daughterOutOfNetsLine } from './resupplyWords.js';

/** The ONE line when a shot leaves a single mother net (replaces the old "running low at 5" warning). */
export const ONE_MOTHER_NET_LEFT_LINE = 'One mother net left.';

/**
 * Mass routing for the Mother fire verb (N). One count of mother nets feeds both paths (DECISIONS §33 row 1);
 * the band only says which launcher carries the shot:
 *   ≤ LASSO_MAX_CAPTURE_MASS (10 kg)   → 'lasso'  — the small point-blank net (LassoSystem)
 *   ≤ WEAVER_MAX_CAPTURE_MASS (500 kg) → 'mother' — the mother's large net; a daughter could hold it too
 *   otherwise                          → 'whale'  — the mother's large net; no daughter can hold it
 * The old "daughter-sized, press D" refusal for 10–500 kg is gone: N fires at any piece in range while nets remain.
 * @param {number} mass — target mass (kg)
 * @returns {{ band: 'lasso'|'mother'|'whale', message: string|null }}
 *   `message` is the refusal line for the small net on a piece it cannot hold (null for 'lasso').
 */
export function classifyNetTarget(mass) {
  const lassoCap = Constants.LASSO_MAX_CAPTURE_MASS;
  const daughterCap = Constants.WEAVER_MAX_CAPTURE_MASS;
  const m = mass || 0;
  const tooHeavy = 'Too heavy for the lasso.';
  if (m > daughterCap) return { band: 'whale', message: tooHeavy };
  if (m > lassoCap) return { band: 'mother', message: tooHeavy };
  return { band: 'lasso', message: null };
}
