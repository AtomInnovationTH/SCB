/**
 * collisionModel.js — Pure debris-contact classifier (D2 collision model).
 *
 * Node-testable, side-effect-free. Given the geometry + kinematics of the
 * closest approach between the player and a single debris object over one scan
 * window, classify the contact severity. The CollisionAvoidanceSystem emitter
 * calls this once per candidate and routes the result to graduated consequences:
 *
 *   'none'     → nothing (out of envelope, receding, or a gentle sub-threshold touch)
 *   'warning'  → COLLISION_WARNING (HUD proximity heads-up; no damage). Needs a closing
 *                speed at or above the harmless-touch floor (GLANCING_MIN_SPEED_MS): a piece
 *                too slow to hurt on contact draws no red warning (r3-slow-warning, 2026-10-17).
 *   'glancing' → subsystem damage (solar-panel health hit + battery drain) + comms
 *   'hard'     → GAME_COLLISION (routed to the Whipple-shield absorb / game-over path)
 *
 * Severity boundary uses kinetic energy (0.5·m·v²), so a fast light fragment and
 * a moderate heavy body can both read 'hard' while a slow drift-in (docking a
 * captured target) reads 'none'. Thresholds live in Constants.COLLISION_MODEL;
 * tests inject their own `model` so the classification is verified independently
 * of the shipped tuning.
 *
 * @module systems/collisionModel
 */

import { Constants } from '../core/Constants.js';

/**
 * Classify a single debris contact.
 * 2026-10-17 (r3-slow-warning): the 'warning' band (inside WARN_RADIUS_M, outside the
 * touch envelope) needs a closing speed at or above model.GLANCING_MIN_SPEED_MS — the
 * speed below which a touch is already harmless — so a slow drifter raises no red strip.
 * @param {object} contact
 * @param {number} contact.distanceM      — effective closest distance this scan window (m, ≥0)
 * @param {number} contact.hullRadiusM    — player hull contact radius (m); falls back to model default
 * @param {number} contact.closingSpeedMs — radial closing speed (m/s); ≤0 means receding
 * @param {number} contact.massKg         — debris mass (kg)
 * @param {object} [model]                — thresholds; defaults to Constants.COLLISION_MODEL
 * @returns {'none'|'warning'|'glancing'|'hard'}
 */
export function classifyContact({ distanceM, hullRadiusM, closingSpeedMs, massKg }, model) {
  const m = model || Constants.COLLISION_MODEL || {};
  const hull = (typeof hullRadiusM === 'number' && hullRadiusM > 0)
    ? hullRadiusM
    : (m.HULL_RADIUS_M || 12);
  const contactRadius = hull + (m.CONTACT_MARGIN_M || 0);
  const warnRadius = m.WARN_RADIUS_M || 0;

  const d = Math.max(0, distanceM || 0);
  const closing = closingSpeedMs || 0;

  // Out of the warning envelope entirely.
  if (d > warnRadius) return 'none';

  // Inside the warning envelope but not touching: a heads-up only while closing
  // fast enough to hurt (at or above the harmless-touch floor; r3-slow-warning).
  if (d > contactRadius) {
    return (closing > 0 && closing >= (m.GLANCING_MIN_SPEED_MS || 0)) ? 'warning' : 'none';
  }

  // --- Physical contact envelope ---
  // A gentle drift-in (below the glancing floor) is inert — this is what keeps
  // docking / reeling a captured target from registering as a collision.
  if (closing < (m.GLANCING_MIN_SPEED_MS || 0)) return 'none';

  // Kinetic energy of the impact (kJ). Fast-light and moderate-heavy both escalate.
  const keKJ = 0.5 * (massKg || 0) * closing * closing / 1000;
  return keKJ >= (m.HARD_IMPACT_KJ || Infinity) ? 'hard' : 'glancing';
}

/**
 * Swept closest distance over one scan interval: the nearest the debris gets
 * before the next scan, so a fast fly-through between 4 Hz samples is still
 * caught at the contact envelope rather than skipping over it. Never negative.
 * @param {number} currentDistM
 * @param {number} closingSpeedMs — ≤0 (receding) leaves the distance unchanged
 * @param {number} scanIntervalS
 * @returns {number}
 */
export function sweptClosestDistM(currentDistM, closingSpeedMs, scanIntervalS) {
  if (!(closingSpeedMs > 0)) return Math.max(0, currentDistM);
  return Math.max(0, currentDistM - closingSpeedMs * scanIntervalS);
}

export default classifyContact;
