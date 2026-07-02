/**
 * netRouting.js — net-ladder mass routing (single source of truth).
 *
 * Pure helper shared by the Mother fire verb (InputManager.fireLasso), the
 * lasso's own too-heavy rejection (LassoSystem.fire), and any HUD that needs
 * the routing copy. Kept in its own lightweight module (Constants only, no
 * THREE / NetProjectile deps) so the input/lasso layers don't pull the heavy
 * CaptureNet module just for a mass comparison.
 *
 * @module systems/netRouting
 */

import { Constants } from '../core/Constants.js';

/**
 * Net-ladder mass routing for the Mother fire verb. Bands by selected-target
 * mass:
 *   ≤ LASSO_MAX_CAPTURE_MASS (10 kg)   → 'lasso'    — point-blank lasso
 *   ≤ WEAVER_MAX_CAPTURE_MASS (500 kg) → 'daughter' — refuse, deploy a Daughter
 *   otherwise                          → 'whale'    — Mother's Large Net pod
 * @param {number} mass — target mass (kg)
 * @returns {{ band: 'lasso'|'daughter'|'whale', message: string|null }}
 */
export function classifyNetTarget(mass) {
  const lassoCap = Constants.LASSO_MAX_CAPTURE_MASS;
  const daughterCap = Constants.WEAVER_MAX_CAPTURE_MASS;
  const m = mass || 0;
  if (m > daughterCap) {
    return {
      band: 'whale',
      message: 'Whale-class target. Only the Mother\'s Large Net holds that — lock it and fire [N]',
    };
  }
  if (m > lassoCap) {
    return {
      band: 'daughter',
      message: 'Daughter-sized target. Save the burn — deploy a Daughter [D]',
    };
  }
  return { band: 'lasso', message: null };
}
