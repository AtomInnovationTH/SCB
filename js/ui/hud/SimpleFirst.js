/**
 * SimpleFirst.js — "simple first" (owner 2026-10-15, DECISIONS §23 row 5): in
 * mission 1 the targets list shows only what a new player has been taught —
 * name, distance, in reach or not — until the player pulls one more pane in.
 * ΔV, TPI, NET %, MOID and the key prompts appear one pane level up (the `+`
 * key shows a pane the room hides by default) and from mission 2 on; the target
 * info pane opens when the player analyses (Z, or a tap on the selected row),
 * not by itself after the scan.
 *
 * ONE helper decides it: `isSimpleTargets()`.
 *
 * Mission number: `getMissionProgress(gameState.debrisCleared).missionNum` —
 * the shared mission-arc math (core/missionProgress.js, the T8 SSOT) fed by the
 * game-state ledger that ArmUnit's mission-1 gates already read
 * (`floor(debrisCleared / DEBRIS_PER_MISSION) + 1`). Chosen over the other two
 * candidates because it is right on a bare CONTINUE: MISSION_START (the
 * `data.missionNumber` of main.js, DebrisField's `_currentMissionNumber`) does
 * not fire for mission 1 nor for a continue, so a continued mission-3 game
 * would read mission 1 until the next mission change.
 *
 * Pane level (h4b D1): `+`/`−` is the pane-density ladder ON the current floor,
 * not the floor. "One pane up" = any pane the floor's DEFAULT_ROOMS row marks
 * 'gone' is visible now (`FloorMask.extraPaneShown()`; the HUD passes the answer
 * in). Hiding that pane again returns to simple. No mask (the ladder is off, the
 * shipped cockpit) = nothing extra shown.
 *
 * Pure module: no DOM, no events, nothing per frame.
 *
 * @module ui/hud/SimpleFirst
 */

import { getMissionProgress } from '../../core/missionProgress.js';
import { gameState } from '../../core/GameState.js';

/** The numbers of the rule. */
export const SIMPLE_FIRST = Object.freeze({
  MISSION: 1,      // simple only in this mission
});

/** @returns {number} the current mission number (1-based) from the game-state ledger. */
export function currentMissionNumber() {
  return getMissionProgress(gameState.debrisCleared).missionNum;
}

/**
 * True when the targets list (and the target info pane) must stay simple:
 * mission 1 and no pane the room hides by default has been pulled in.
 * The mission defaults to the live one; pass both arguments to ask about
 * another state (tests).
 * @param {number} [missionNumber]    default: the current mission
 * @param {boolean} [extraPaneShown]  a 'gone'-by-default pane is visible now (the caller's to give; default false)
 * @returns {boolean}
 */
export function isSimpleTargets(missionNumber, extraPaneShown = false) {
  const mission = missionNumber === undefined ? currentMissionNumber() : missionNumber;
  if (mission !== SIMPLE_FIRST.MISSION) return false;
  return !extraPaneShown;
}

export default isSimpleTargets;
