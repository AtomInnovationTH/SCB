/**
 * MissionMilestones.js — mission-completion clarity (UX-11 #12).
 *
 * Tracks BOTH win conditions —
 *   • debris track: `gameState.debrisCleared` vs `Constants.WIN_DEBRIS_COUNT` (50)
 *   • contract track: elevator contract kg vs `ELEVATOR_CONTRACT.TARGET_MASS_KG` (10,000)
 * — and posts a HOUSTON milestone line the first time EITHER track crosses
 * 25 / 50 / 75 / 90 %. Lines carry `_postOnboarding` so the CP-4 suppression
 * arbiter (commsSuppression.js) lets them through after onboarding.
 *
 * Also posts a one-line "what next" recap on `SHOP_DEPLOY` (the moment the
 * player re-enters flight and most needs orientation).
 *
 * The threshold-crossing logic is a pure function (`crossedThresholds`) so it
 * is unit-testable in Node. Restore safety: PERSISTENCE_LOADED un-seeds both
 * tracks so the absolute post-load CONTRACT_UPDATE re-seeds silently; the
 * debris track always seeds from count-1 (clears arrive one at a time), so
 * genuinely-crossed thresholds announce even on the first post-restore clear.
 *
 * Wire in main.js: `missionMilestones.init()` (after EventBus is live).
 *
 * @module systems/MissionMilestones
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';

/** Milestone fractions, ascending. 100 % is excluded — the win flow owns it. */
export const MILESTONE_THRESHOLDS = [0.25, 0.5, 0.75, 0.9];

// ============================================================================
// PURE HELPERS (Node-safe)
// ============================================================================

/**
 * Which thresholds were newly crossed moving from prevFrac → newFrac?
 * A threshold t is crossed when prevFrac < t ≤ newFrac.
 * @param {number} prevFrac — previous progress fraction (0–1)
 * @param {number} newFrac — new progress fraction (0–1)
 * @param {number[]} [thresholds=MILESTONE_THRESHOLDS]
 * @returns {number[]} thresholds crossed, ascending
 */
export function crossedThresholds(prevFrac, newFrac, thresholds = MILESTONE_THRESHOLDS) {
  const out = [];
  for (const t of thresholds) {
    if (prevFrac < t && newFrac >= t) out.push(t);
  }
  return out;
}

/**
 * Human milestone line for a track.
 * @param {'debris'|'contract'} track
 * @param {number} threshold — 0.25 | 0.5 | 0.75 | 0.9
 * @param {number} current — current value (count or kg)
 * @param {number} target — win value (count or kg)
 * @returns {string}
 */
export function formatMilestoneLine(track, threshold, current, target) {
  const pct = Math.round(threshold * 100);
  if (track === 'debris') {
    const remaining = Math.max(0, target - current);
    if (threshold >= 0.9) return `${current} of ${target} cleared — ${remaining} to go. Bring it home.`;
    if (threshold === 0.5) return `Halfway — ${current} of ${target} debris cleared.`;
    return `Debris track at ${pct}% — ${current} of ${target} cleared.`;
  }
  // contract
  const cur = Math.round(current).toLocaleString();
  const tgt = Math.round(target).toLocaleString();
  if (threshold >= 0.9) return `Contract at ${cur} kg of ${tgt} — one good cluster to go.`;
  if (threshold === 0.5) return `Contract halfway — ${cur} kg of ${tgt} delivered.`;
  return `Elevator contract at ${pct}% — ${cur} of ${tgt} kg.`;
}

/**
 * Compact dual-objective recap (shop deploy / status calls).
 * @param {number} cleared @param {number} clearTarget
 * @param {number} contractKg @param {number} contractTargetKg
 * @returns {string}
 */
export function formatObjectiveRecap(cleared, clearTarget, contractKg, contractTargetKg) {
  return `Status: ${cleared}/${clearTarget} cleared · contract ` +
    `${Math.round(contractKg).toLocaleString()}/${Math.round(contractTargetKg).toLocaleString()} kg. ` +
    'Pick a cluster on the Debris Map (`), then press A.';
}

// ============================================================================
// TRACKER
// ============================================================================

export class MissionMilestones {
  constructor() {
    /** @type {number|null} last seen debris fraction (null = unseeded/restore) */
    this._debrisFrac = null;
    /** @type {number|null} last seen contract fraction. Fresh games start at a
     *  known 0 baseline so a large FIRST contribution still announces; a
     *  PERSISTENCE_LOADED resets it to null (silent re-seed, no replay). */
    this._contractFrac = 0;
    /** @type {Set<string>} fired milestone keys, e.g. 'debris:0.5' */
    this._fired = new Set();
    /** @type {number} latest cleared count (event-fed fallback for the recap) */
    this._cleared = 0;
    /** @type {number} latest contract kg (event-fed fallback for the recap) */
    this._contractKg = 0;
    /** @type {Function|null} live getters (review fix: event caches go stale
     *  across save restore — prefer reading authoritative state at recap time) */
    this._getCleared = null;
    this._getContractKg = null;
    this._inited = false;
  }

  /**
   * Subscribe to progress events. Call once.
   * @param {object} [deps]
   * @param {Function} [deps.getCleared] — () => current debrisCleared
   * @param {Function} [deps.getContractKg] — () => current contract mass (kg)
   */
  init({ getCleared = null, getContractKg = null } = {}) {
    if (this._inited) return;
    this._inited = true;
    this._getCleared = getCleared;
    this._getContractKg = getContractKg;

    eventBus.on(Events.DEBRIS_CLEARED, (d) => {
      const count = d && typeof d.count === 'number' ? d.count : null;
      if (count == null) return;
      this._cleared = count;
      const target = Constants.WIN_DEBRIS_COUNT || 50;
      // Debris clears arrive one at a time, so the TRUE previous state is
      // always count-1 — seed from it when unseeded (fresh boot or restore)
      // so a genuinely-crossed threshold still announces (review fix).
      if (this._debrisFrac === null) {
        this._debrisFrac = Math.min(1, Math.max(0, count - 1) / target);
        for (const t of MILESTONE_THRESHOLDS) {
          if (this._debrisFrac >= t) this._fired.add(`debris:${t}`);
        }
      }
      this._advance('debris', count, target);
    });

    eventBus.on(Events.CONTRACT_UPDATE, (d) => {
      if (!d || typeof d.contractMassKg !== 'number') return;
      this._contractKg = d.contractMassKg;
      const target = d.targetMassKg
        || (Constants.ELEVATOR_CONTRACT && Constants.ELEVATOR_CONTRACT.TARGET_MASS_KG) || 10000;
      this._advance('contract', d.contractMassKg, target);
    });

    // Save restore: GameFlowManager re-emits an ABSOLUTE CONTRACT_UPDATE and
    // sets debrisCleared without events. Un-seed both tracks so the next
    // observation re-seeds silently instead of replaying history.
    eventBus.on(Events.PERSISTENCE_LOADED, () => {
      this._debrisFrac = null;
      this._contractFrac = null;
    });

    // UX-11 #12.3: "what next" recap when leaving the shop.
    eventBus.on(Events.SHOP_DEPLOY, () => {
      const clearTarget = Constants.WIN_DEBRIS_COUNT || 50;
      const contractTarget =
        (Constants.ELEVATOR_CONTRACT && Constants.ELEVATOR_CONTRACT.TARGET_MASS_KG) || 10000;
      const cleared = this._getCleared ? this._getCleared() : this._cleared;
      const contractKg = this._getContractKg ? this._getContractKg() : this._contractKg;
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'HOUSTON',
        text: formatObjectiveRecap(cleared || 0, clearTarget, contractKg || 0, contractTarget),
        priority: 'info',
        _postOnboarding: true,
      });
    });

    eventBus.on(Events.GAME_RESET, () => this.reset());
  }

  reset() {
    this._debrisFrac = null;
    this._contractFrac = 0;   // fresh-game baseline (see constructor note)
    this._fired.clear();
    this._cleared = 0;
    this._contractKg = 0;
  }

  /**
   * Advance a track to a new value; fire any newly-crossed milestones.
   * First observation per track seeds without firing (restore safety).
   * @private
   */
  _advance(track, value, target) {
    if (!target || target <= 0) return;
    const frac = Math.min(1, value / target);
    const prevKey = track === 'debris' ? '_debrisFrac' : '_contractFrac';
    const prev = this[prevKey];
    this[prevKey] = frac;

    if (prev === null) {
      // Silent seed (post-restore only): GameFlowManager re-emits an absolute
      // CONTRACT_UPDATE after load — mark already-passed thresholds as fired
      // so history isn't replayed. Fresh games never hit this branch: the
      // contract track starts at 0 and debris seeds from count-1.
      for (const t of MILESTONE_THRESHOLDS) {
        if (frac >= t) this._fired.add(`${track}:${t}`);
      }
      return;
    }

    for (const t of crossedThresholds(prev, frac)) {
      const key = `${track}:${t}`;
      if (this._fired.has(key)) continue;
      this._fired.add(key);
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'HOUSTON',
        channel: 'MISSION',
        text: formatMilestoneLine(track, t, value, target),
        priority: 'info',
        _postOnboarding: true,
      });
    }
  }
}

export const missionMilestones = new MissionMilestones();
