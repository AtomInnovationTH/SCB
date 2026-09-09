/**
 * missionProgress.js — pure mission-arc progression math.
 *
 * Single source of truth for "which mission am I on" and "how many debris until
 * the depot", derived from total debris cleared. Shared by BriefingScreen (the
 * retry-path briefing card) and GameFlowManager (the continue-flow welcome-back
 * comms), which must agree — so the clamp logic lives here rather than being
 * copied. Also the home of the mission → profile lookup (`missionProfileFor`,
 * which ScoringSystem._getMissionProfile delegates to) and the guided-chapter
 * predicate (`isGuidedChapterNumber`) the M1 guidance work keys on. Depends
 * only on Constants (no DOM / systems), so it is safe to import anywhere and
 * to unit-test in the Node harness.
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

/**
 * The spawn-difficulty profile for a mission number: the highest
 * `Constants.MISSIONS.PROFILES` entry whose `minMission` is <= n ("highest
 * matching wins" — the ST-4.C rule). PROFILES is authored in ascending
 * `minMission` order (pinned in test-MissionProfiles), so the last hit is the
 * best hit. Anything below the first entry's `minMission` (0, NaN, undefined)
 * falls back to PROFILES[0], the same null fallback DebrisField uses.
 *
 * Lifted here from ScoringSystem._getMissionProfile (which now delegates) so
 * DebrisField-less readers — GameFlowManager's per-catch progress line, the
 * guided-chapter predicate below — resolve the SAME profile ScoringSystem
 * broadcasts on MISSION_START, without owning a ScoringSystem.
 *
 * @param {number} n — mission number (1-based)
 * @returns {object} a PROFILES entry (never null while PROFILES is non-empty)
 */
export function missionProfileFor(n) {
  const profiles = (Constants.MISSIONS && Constants.MISSIONS.PROFILES) || [];
  let best = profiles[0];
  for (const p of profiles) {
    if (n >= p.minMission) best = p;
  }
  return best;
}

/**
 * Is mission `n` a GUIDED chapter — one where the welcome cluster is kept
 * findable for the player (AutoLock's nearest-any fallback when the forward
 * arc is empty, GameFlowManager's per-catch progress line, and the re-seat
 * safety net that follows in T6)?
 *
 * Read from the profile's `guidedCluster` flag, so the boundary lives in ONE
 * place (Constants.MISSIONS.PROFILES): true on the 'Orientation' and 'First
 * Operations' profiles (missions 1–3 — the FORCED_DEPOT_CHAPTERS boundary),
 * false from mission 4 on. Strict `=== true`: a profile without the flag is
 * NOT guided, so an older profile shape degrades to the un-guided behaviour
 * rather than throwing or guiding by accident.
 *
 * Pure (Constants only) and correct on a bare Continue too — it takes the
 * mission NUMBER, which callers derive from `getMissionProgress(debrisCleared)`
 * (restored by MENU_CONTINUE), not from a MISSION_START that never fired.
 *
 * @param {number} n — mission number (1-based)
 * @returns {boolean}
 */
export function isGuidedChapterNumber(n) {
  const profile = missionProfileFor(n);
  return !!profile && profile.guidedCluster === true;
}
