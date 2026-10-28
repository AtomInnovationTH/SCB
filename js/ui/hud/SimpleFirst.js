/**
 * "Simple first" (DECISIONS §23 row 5): in mission 1 the targets list shows only name, distance, in reach or not,
 * until the player pulls one more pane in (the `+` key). ΔV, TPI, NET %, MOID and the key prompts appear one pane
 * level up and from mission 2 on; the target info pane opens when the player analyses (Z, or a tap on the
 * selected row), not by itself after the scan. ONE helper decides it: `isSimpleTargets()`.
 *
 * Mission number: `getMissionProgress(gameState.debrisCleared).missionNum` (core/missionProgress.js), the ledger
 * ArmUnit's mission-1 gates read. Chosen because it is right on a bare CONTINUE: MISSION_START (main.js
 * `data.missionNumber`, DebrisField `_currentMissionNumber`) does not fire for mission 1 nor a continue.
 *
 * Pane level: `+`/`−` is the pane-density ladder ON the current floor. "One pane up" = any pane the floor's
 * DEFAULT_ROOMS row marks 'gone' is visible now (`FloorMask.extraPaneShown()`; the HUD passes the answer in).
 * No mask (ladder off, the shipped cockpit) = nothing extra shown.
 *
 * Pure module: no DOM, no events, nothing per frame.
 *
 * @module ui/hud/SimpleFirst
 */

import { getMissionProgress } from '../../core/missionProgress.js';
import { gameState } from '../../core/GameState.js';

export const SIMPLE_FIRST = Object.freeze({
  MISSION: 1,      // simple only in this mission
});

/** @returns {number} current mission number (1-based). */
export function currentMissionNumber() {
  return getMissionProgress(gameState.debrisCleared).missionNum;
}

/**
 * True when the targets list (and target info pane) must stay simple: mission 1 and no hidden-by-default pane
 * pulled in. Pass both arguments to ask about another state (tests).
 * @param {number} [missionNumber]    default: the current mission
 * @param {boolean} [extraPaneShown]  a 'gone'-by-default pane is visible now
 */
export function isSimpleTargets(missionNumber, extraPaneShown = false) {
  const mission = missionNumber === undefined ? currentMissionNumber() : missionNumber;
  if (mission !== SIMPLE_FIRST.MISSION) return false;
  return !extraPaneShown;
}

export default isSimpleTargets;
