/**
 * DevSequenceAdvancer.js — "do the next thing" resolver for the Space key.
 *
 * Space is a rapid-advance / one-press-per-step driver for the core gameplay
 * loop, so anyone (devs especially) can mash Space to rip through a full cycle:
 *
 *     Scan → Target → Autopilot → Daughter launch → Capture
 *
 * This module is a PURE decision function: given a snapshot of live game state
 * it returns the id of the single next action to perform (or null if nothing is
 * actionable). The InputManager builds the snapshot from its deps and dispatches
 * the corresponding helper. Keeping the decision logic pure makes it unit-
 * testable in Node without a DOM / Three.js scene.
 *
 * Design notes (see .kilo/plans/spacebar-rapid-advance.md):
 *   • Onboarding still owns Space FIRST — this resolver only runs when the
 *     OnboardingDirector's smart-default declines the press.
 *   • Daughter-first capture: the `deploy` step is ordered before the `net`
 *     step, so a launchable daughter is preferred and the Mother net is the
 *     fallback (e.g. no daughter docked / out of fuel).
 *   • Capture-while-piloting has the HIGHEST priority so that once a daughter is
 *     launched and being piloted, further Space presses drive it to the catch
 *     instead of re-deploying another daughter.
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

  // 1) Piloting a daughter → capture takes precedence over everything.
  if (s.armPilotMode && CAPTURE_READY_STATES.has(s.pilotedArmState)) {
    return DEV_ACTIONS.CAPTURE;
  }

  // 2) Nothing discovered yet → scan.
  if (!(Number(s.trackedContacts) > 0)) {
    return DEV_ACTIONS.SCAN;
  }

  // 3) Contacts exist but none selected → cycle a target.
  if (!s.hasTarget) {
    return DEV_ACTIONS.TARGET;
  }

  // 4) Target out of range → close on it with autopilot (unless already running).
  if (!s.inCaptureRange) {
    if (!s.autopilotActive) return DEV_ACTIONS.AUTOPILOT;
    // Autopilot already closing — nothing new to do this press.
    return null;
  }

  // 5) In range, daughter available → launch a daughter (daughter-first).
  if (s.canDeployDaughter) {
    return DEV_ACTIONS.DEPLOY;
  }

  // 6) In range, no daughter → fire the Mother net (fallback).
  return DEV_ACTIONS.NET;
}

export default { DEV_ACTIONS, resolveNextDevAction };

// CJS guard — exposes the data for Node-safe tests (mirrors OnboardingDirector).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DEV_ACTIONS, resolveNextDevAction };
}
