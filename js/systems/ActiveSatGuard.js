/**
 * ActiveSatGuard.js — ST-6.1 treaty-violation guard
 *
 * Pure helper (Node-safe, no THREE.js, no DOM) invoked by arm-arming code
 * paths. If a target's NORAD id is present in the active-satellite catalogue,
 * the guard:
 *   1. Emits EVT.CONJUNCTION_ALERT with severity:'RED' + reason:'ACTIVE_SAT_ARMING'.
 *   2. Emits a Houston COMMS_MESSAGE ("Negative, Cowboy — … is active. Stand down.").
 *   3. Returns true — caller MUST treat this as "arm refused" and return false.
 *
 * The guard is a no-op (returns false) when:
 *   - catalogLoader is null/undefined or not ready
 *   - target has no `norad` field
 *   - norad lookup returns null (target is not in the active-sat table)
 *
 * @module systems/ActiveSatGuard
 */

import { Events } from '../core/Events.js';

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * @param {object} target - The debris-like object the arm is about to lock onto.
 *                          Must have `.norad` (string|number) to trigger the guard.
 * @param {object} catalogLoader - CatalogLoader instance (or null/undefined).
 * @param {{ emit: Function }} eventBusRef - EventBus-compatible emitter.
 * @returns {boolean} true → arming refused (caller should return false).
 */
export function checkActiveSatArming(target, catalogLoader, eventBusRef) {
  if (!target || target.norad == null) return false;
  if (!catalogLoader || typeof catalogLoader.isReady !== 'function' || !catalogLoader.isReady()) return false;
  if (typeof catalogLoader.getActiveSat !== 'function') return false;

  const entry = catalogLoader.getActiveSat(target.norad);
  if (!entry) return false;

  const name = entry.name || `NORAD ${target.norad}`;

  // 1) RED alert on the conjunction channel — metadata only (no shape mutation)
  try {
    eventBusRef.emit(Events.CONJUNCTION_ALERT, {
      severity: 'RED',
      reason: 'ACTIVE_SAT_ARMING',
      norad: String(target.norad),
      targetId: target.id != null ? target.id : null,
      targetName: name,
    });
  } catch (_) { /* best-effort */ }

  // 2) Houston comms — human-readable stand-down
  try {
    eventBusRef.emit(Events.COMMS_MESSAGE, {
      source: 'HOUSTON',
      channel: 'HOUSTON',
      priority: 'HIGH',
      text: `Negative, Cowboy. ${name} is active. Stand down.`,
    });
  } catch (_) { /* best-effort */ }

  return true;
}

// ============================================================================
// CJS GUARD
// ============================================================================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { checkActiveSatArming };
}
