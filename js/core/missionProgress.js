/**
 * missionProgress.js — pure mission-arc progression math.
 *
 * Single source of truth for "which mission am I on" and "how many debris until
 * the depot", derived from total debris cleared. Shared by BriefingScreen (the
 * retry-path briefing card) and GameFlowManager (the continue-flow welcome-back
 * comms), which must agree — so the clamp logic lives here rather than being
 * copied. Depends only on Constants (no DOM / systems), so it is safe to import
 * anywhere and to unit-test in the Node harness.
 * @module core/missionProgress
 */

import { Constants } from './Constants.js';

/**
 * Compute mission-arc progression from the number of debris cleared.
 *
 * Mission number = floor(cleared / perMission) + 1, clamped to the 12-chapter
 * arc so a boundary at exactly WIN_DEBRIS_COUNT (continue-past-threshold) never
 * reads "MISSION 13" (F2/F3, mirrors the GameOverScreen clamp).
 *
 * debrisUntilShop = debris remaining until the next depot, clamped ≥ 0 so
 * continue-past-threshold never renders a negative count. The modulo keeps it
 * in [1, perMission].
 *
 * missionsCompleted = floor(cleared / perMission) (NO +1), clamped to the arc —
 * the "how many missions finished" count the victory report shows, distinct
 * from missionNum's "which mission am I on" (+1) value.
 *
 * @param {number} debrisCleared — total debris cleared so far
 * @returns {{ perMission: number, maxMission: number, missionNum: number, missionsCompleted: number, debrisUntilShop: number }}
 */
export function getMissionProgress(debrisCleared) {
  const cleared = Number(debrisCleared) || 0;
  const perMission = (Constants.MISSIONS && Constants.MISSIONS.DEBRIS_PER_MISSION) || 5;
  const maxMission = Math.max(1, Math.floor((Constants.WIN_DEBRIS_COUNT || 60) / perMission));
  const missionNum = Math.min(maxMission, Math.floor(cleared / perMission) + 1);
  const missionsCompleted = Math.min(maxMission, Math.floor(cleared / perMission));
  const debrisUntilShop = Math.max(0, perMission - (cleared % perMission));
  return { perMission, maxMission, missionNum, missionsCompleted, debrisUntilShop };
}
