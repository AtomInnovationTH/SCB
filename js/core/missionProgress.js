/**
 * @module core/missionProgress — pure mission-arc progression math, depending only on Constants
 * (safe to import anywhere, unit-testable in Node). SSOT for "which mission am I on" and "how many debris
 * until the depot", derived from total debris cleared; shared by BriefingScreen (retry-path card) and GameFlowManager
 * (continue-flow welcome-back comms), which must agree. Also the home of the mission → profile lookup
 * (`missionProfileFor`, which ScoringSystem._getMissionProfile delegates to) and the guided-chapter predicate
 * (`isGuidedChapterNumber`).
 */

import { Constants } from './Constants.js';

/**
 * Mission-arc progression from the number of debris cleared. missionNum = floor(cleared / perMission) + 1, clamped to
 * the 12-chapter arc so a boundary at exactly WIN_DEBRIS_COUNT (continue-past-threshold) never reads "MISSION 13"
 * (mirrors the GameOverScreen clamp). debrisUntilShop = debris remaining until the next depot, in [1, perMission]
 * (never negative past the threshold). missionsCompleted = floor(cleared / perMission) (NO +1), clamped to the arc: the
 * "how many finished" count the victory report shows.
 * @param {number} debrisCleared total debris cleared so far
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
 * A mission's name as the player reads it. Mission 1 is the training mission (owner 2026-10-31: "Change mission 1 to
 * training mission 1."), so it reads "Training mission 1"; missions 2 on keep "Mission N" (not renumbered). Forms:
 * 'start' (a line or heading starts with it), 'mid' (inside a sentence: "Resuming training mission 1.") and 'upper'
 * (the cards: "TRAINING MISSION 1 BRIEFING", "MISSION 2 COMPLETE"). Every place that shows a mission number by name
 * goes through here: BriefingScreen, the HUD complete card, GameFlowManager's card and comms, GameOverScreen.
 * @param {number} n mission number (1-based)
 * @param {'start'|'mid'|'upper'} [form='start']
 * @returns {string}
 */
export function missionName(n, form = 'start') {
  const training = Number(n) === 1;
  const name = training ? 'Training mission 1' : `Mission ${n}`;
  if (form === 'upper') return name.toUpperCase();
  if (form === 'mid' && training) return 'training mission 1';
  return name;
}

/**
 * The spawn-difficulty profile for a mission number: the highest `Constants.MISSIONS.PROFILES` entry whose `minMission`
 * is <= n. PROFILES is authored in ascending `minMission` order (pinned in test-MissionProfiles), so the last hit is
 * the best. Anything below the first entry's `minMission` (0, NaN, undefined) falls back to PROFILES[0], like
 * DebrisField. Lifted from ScoringSystem._getMissionProfile (which delegates) so DebrisField-less readers
 * (GameFlowManager's per-catch progress line, the guided-chapter predicate) resolve the SAME profile ScoringSystem
 * broadcasts on MISSION_START.
 * @param {number} n mission number (1-based)
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
 * Is mission `n` a GUIDED chapter, i.e. the welcome cluster is kept findable
 * (AutoLock's nearest-any fallback when the forward arc is empty, GameFlowManager's per-catch progress line, the
 * re-seat safety net in DebrisField._reseatDriftedWelcome)? Read from the profile's `guidedCluster` flag, so the
 * boundary lives in ONE place (Constants.MISSIONS.PROFILES): true on missions 1–3 (the FORCED_DEPOT_CHAPTERS boundary),
 * false from 4 on. Strict `=== true`: a profile without the flag is NOT guided, so an older shape degrades to un-guided
 * rather than throwing. Takes the mission NUMBER (from `getMissionProgress(debrisCleared)`), so it is correct on a bare
 * Continue where no MISSION_START fired.
 * @param {number} n mission number (1-based)
 * @returns {boolean}
 */
export function isGuidedChapterNumber(n) {
  const profile = missionProfileFor(n);
  return !!profile && profile.guidedCluster === true;
}
