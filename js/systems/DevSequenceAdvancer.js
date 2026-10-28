/**
 * DevSequenceAdvancer.js — "do the next thing" resolver for the Space key: mashing Space rips through
 * Scan → Target → Autopilot → Daughter launch → Capture.
 *
 * A PURE decision function: given a snapshot of live game state it returns the id of the single next action (or null if
 * nothing is actionable). InputManager builds the snapshot and dispatches the helper; pure so it is testable in Node.
 *   • Onboarding still owns Space FIRST: this resolver only runs when OnboardingDirector's smart-default declines the press.
 *   • Daughter-first capture: `deploy` is ordered before `net`, so a launchable daughter is preferred and the Mother net is
 *     the fallback (no daughter docked / out of fuel).
 *   • Capture-while-piloting has the HIGHEST priority, so further Space presses drive a launched daughter to the catch
 *     instead of re-deploying another.
 *
 * @module systems/DevSequenceAdvancer
 */

/** Stable action ids returned by {@link resolveNextDevAction}. */
export const DEV_ACTIONS = Object.freeze({
  SCAN:      'scan',
  TARGET:    'target',
  AUTOPILOT: 'autopilot',
  DEPLOY:    'deploy',
  NET:       'net',
  CAPTURE:   'capture',
});

/** Arm states (of the piloted daughter) from which N performs a capture. */
const CAPTURE_READY_STATES = new Set(['STATION_KEEP', 'TRANSIT', 'APPROACH']);

/**
 * @typedef {object} DevSnapshot
 * @property {boolean} armPilotMode        — true while piloting a launched daughter
 * @property {string|null} pilotedArmState — current piloted arm state, or null
 * @property {boolean} hasTarget           — an active debris target is selected
 * @property {number} trackedContacts      — count of discovered/tracked contacts
 * @property {boolean} inCaptureRange      — active target is within act range
 * @property {boolean} canDeployDaughter   — a docked daughter is launchable
 * @property {boolean} autopilotActive     — mother autopilot is engaged
 */

/**
 * Resolve the single next action for a Space press, given live game state.
 *
 * Priority order (one step per press):
 *   1. capture   — piloting a daughter in a capture-ready state
 *   2. scan      — no contacts discovered yet
 *   3. target    — contacts exist but none selected
 *   4. autopilot — target selected, out of range, autopilot not already running
 *   5. deploy    — target in range and a daughter is launchable (daughter-first)
 *   6. net       — target in range, no daughter available (Mother-net fallback)
 *   —. null      — nothing actionable
 *
 * @param {DevSnapshot} snapshot
 * @returns {string|null} a {@link DEV_ACTIONS} id, or null
 */
export function resolveNextDevAction(snapshot) {
  const s = snapshot || {};

  if (s.armPilotMode && CAPTURE_READY_STATES.has(s.pilotedArmState)) {
    return DEV_ACTIONS.CAPTURE;
  }

  if (!(Number(s.trackedContacts) > 0)) {
    return DEV_ACTIONS.SCAN;
  }

  if (!s.hasTarget) {
    return DEV_ACTIONS.TARGET;
  }

  if (!s.inCaptureRange) {
    if (!s.autopilotActive) return DEV_ACTIONS.AUTOPILOT;
    return null;
  }

  if (s.canDeployDaughter) {
    return DEV_ACTIONS.DEPLOY;
  }

  return DEV_ACTIONS.NET;
}

export default { DEV_ACTIONS, resolveNextDevAction };

// CJS guard: exposes the data for Node-safe tests (mirrors OnboardingDirector).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DEV_ACTIONS, resolveNextDevAction };
}
