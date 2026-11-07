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
 * How many of the first missions are training (owner 2026-10-31: "there will be several training missions" and
 * "focus on training mission 1 2 3 for now"; DECISIONS §38 row 9). They are the guided chapters (`guidedCluster`,
 * FORCED_DEPOT_CHAPTERS), but this count only names them: the game's internal mission numbers do not change.
 */
export const TRAINING_MISSIONS = 3;

/**
 * The training mass limit (DECISIONS §64 row 1, owner 2026-11-06: "Nothing over 500 kg"): `TOOL_RECOMMENDATION.MOTHER_MIN_MASS`,
 * the mass above which only the mother's big net works. The one place the number is read (DebrisField, FieldRegistry, RoutePlanner).
 * @returns {number} kg
 */
export function trainingMassLimitKg() {
  const v = Constants.TOOL_RECOMMENDATION && Constants.TOOL_RECOMMENDATION.MOTHER_MIN_MASS;
  return Number.isFinite(v) ? v : 500;
}

/**
 * Does the training rule hold this high-field row back from the mission about to be flown (DECISIONS §64 row 1)? True when that
 * mission is a training one (1..TRAINING_MISSIONS) and the row (`Constants.HIGH_FIELD[row]`) starts over the limit: the row stays
 * owed and is laid out from mission 4 (`DebrisField._spawnWelcomeField` keeps it out). A row with no table entry is not held.
 * @param {number} row index into `Constants.HIGH_FIELD`
 * @param {number} missionNumber the internal number of the mission she will fly next
 * @returns {boolean}
 */
export function trainingHoldsHighRow(row, missionNumber) {
  if (!((missionNumber || 1) <= TRAINING_MISSIONS)) return false;
  const def = Array.isArray(Constants.HIGH_FIELD) ? Constants.HIGH_FIELD[row] : null;
  return !!def && def.massMin > trainingMassLimitKg();
}

/**
 * How many of a field's owed pieces she can catch now: `reg.layableCount` (the training rule holds a high field's pieces over 500 kg
 * back, DECISIONS §64 row 1), or `remainingCount` for a registry without it. What every count on screen shows.
 * @param {object} reg a FieldRegistry (or anything with `remainingCount`)
 * @param {string} id the field's id
 * @returns {number}
 */
export function catchableCount(reg, id) {
  const total = reg.remainingCount(id);
  if (typeof reg.layableCount !== 'function') return total;
  const n = reg.layableCount(id);
  return Number.isFinite(n) ? Math.min(total, n) : total;
}

/**
 * How many of a field's owed pieces the training rule holds back until Mission 1 (owed, but not catchable now).
 * @param {object} reg a FieldRegistry @param {string} id the field's id
 * @returns {number}
 */
export function heldBackCount(reg, id) {
  return Math.max(0, reg.remainingCount(id) - catchableCount(reg, id));
}

/**
 * The words for pieces held back: "+2 big pieces from Mission 1" (short: "+2 big from Mission 1"). '' for none.
 * @param {number} k how many are held back @param {boolean} [short=false]
 * @returns {string}
 */
export function heldBackNote(k, short = false) {
  if (!(k > 0)) return '';
  return `+${k} big ${short ? '' : (k === 1 ? 'piece ' : 'pieces ')}from ${missionName(TRAINING_MISSIONS + 1)}`;
}

/**
 * A mission's name as the player reads it, from the internal mission number. Missions 1..TRAINING_MISSIONS are
 * "Training mission 1".."Training mission 3"; the real missions after them count from 1 again (internal 4 is
 * "Mission 1", internal 12 "Mission 9"). Forms: 'start' (a line or heading starts with it), 'mid' (inside a
 * sentence: "Resuming training mission 2.") and 'upper' (the cards: "TRAINING MISSION 1 BRIEFING", "MISSION 1
 * COMPLETE"). Every place that shows a mission number by name goes through here: BriefingScreen, the HUD complete
 * card, GameFlowManager's card and comms, GameOverScreen.
 * @param {number} n internal mission number (1-based)
 * @param {'start'|'mid'|'upper'} [form='start']
 * @returns {string}
 */
export function missionName(n, form = 'start') {
  const k = Number(n);
  const training = k <= TRAINING_MISSIONS;
  const name = training ? `Training mission ${k}` : `Mission ${k - TRAINING_MISSIONS}`;
  if (form === 'upper') return name.toUpperCase();
  if (form === 'mid' && training) return `training mission ${k}`;
  return name;
}

/**
 * How many real (not training) missions a count of completed missions holds: the victory screen's "Missions" line.
 * @param {number} missionsCompleted completed missions, training included (`getMissionProgress().missionsCompleted`)
 * @returns {number}
 */
export function realMissionsDone(missionsCompleted) {
  return Math.max(0, (Number(missionsCompleted) || 0) - TRAINING_MISSIONS);
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
