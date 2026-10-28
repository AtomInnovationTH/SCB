/**
 * @module systems/MissionMilestones — mission-completion clarity (UX-11 #12). Tracks BOTH win conditions — debris
 * (`gameState.debrisCleared` vs `Constants.WIN_DEBRIS_COUNT`, 60) and contract (elevator kg vs
 * `ELEVATOR_CONTRACT.TARGET_MASS_KG`, 10,000) — and posts a HOUSTON line the first time EITHER crosses 25 / 50 / 75 /
 * 90 %. Lines carry `_postOnboarding` so the suppression arbiter (commsSuppression.js) lets them through after
 * onboarding. Also posts a one-line "what next" recap on `SHOP_DEPLOY` (the player re-enters flight).
 *
 * `crossedThresholds` is pure (Node-testable). Restore safety: PERSISTENCE_LOADED un-seeds both tracks so the absolute
 * post-load CONTRACT_UPDATE re-seeds silently; the debris track always seeds from count-1 (clears arrive one at a
 * time), so genuinely-crossed thresholds announce even on the first post-restore clear.
 *
 * Wire in main.js: `missionMilestones.init()` (after EventBus is live).
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';

/** Milestone fractions, ascending. 100 % is excluded — the win flow owns it. */
export const MILESTONE_THRESHOLDS = [0.25, 0.5, 0.75, 0.9];

/** Thresholds newly crossed moving from prevFrac → newFrac (0–1): t is crossed when prevFrac < t ≤ newFrac. Ascending. */
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
 * @param {number} current — count or kg
 * @param {number} target — win value (count or kg)
 */
export function formatMilestoneLine(track, threshold, current, target) {
  const pct = Math.round(threshold * 100);
  if (track === 'debris') {
    const remaining = Math.max(0, target - current);
    if (threshold >= 0.9) return `${current} of ${target} cleared. ${remaining} to go. Bring it home.`;
    if (threshold === 0.5) return `Halfway. ${current} of ${target} debris cleared.`;
    return `Debris track at ${pct}%. ${current} of ${target} cleared.`;
  }
  // contract
  const cur = Math.round(current).toLocaleString();
  const tgt = Math.round(target).toLocaleString();
  if (threshold >= 0.9) return `Contract at ${cur} kg of ${tgt}. One good cluster to go.`;
  if (threshold === 0.5) return `Contract halfway. ${cur} kg of ${tgt} delivered.`;
  return `Elevator contract at ${pct}%. ${cur} of ${tgt} kg.`;
}

/** Compact dual-objective recap (shop deploy / status calls). */
export function formatObjectiveRecap(cleared, clearTarget, contractKg, contractTargetKg) {
  return `Status: ${cleared}/${clearTarget} cleared · contract ` +
    `${Math.round(contractKg).toLocaleString()}/${Math.round(contractTargetKg).toLocaleString()} kg. ` +
    'Scroll out to LEO and press Space to fly to the next cluster.';
}


export class MissionMilestones {
  constructor() {
    /** @type {number|null} last seen debris fraction (null = unseeded/restore) */
    this._debrisFrac = null;
    /** @type {number|null} last seen contract fraction. Fresh games start at a known 0 baseline so a large FIRST
     *  contribution still announces; PERSISTENCE_LOADED resets it to null (silent re-seed, no replay). */
    this._contractFrac = 0;
    /** @type {Set<string>} fired milestone keys, e.g. 'debris:0.5' */
    this._fired = new Set();
    /** @type {number} latest cleared count / contract kg (event-fed fallbacks for the recap) */
    this._cleared = 0;
    this._contractKg = 0;
    /** @type {Function|null} live getters: event caches go stale across save restore, so the recap reads authoritative state */
    this._getCleared = null;
    this._getContractKg = null;
    this._inited = false;
  }

  /**
   * Subscribe to progress events. Call once.
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
      const target = Constants.WIN_DEBRIS_COUNT || 60;
      // Clears arrive one at a time, so the TRUE previous state is count-1: seed from it when unseeded (fresh boot or
      // restore) so a genuinely-crossed threshold still announces.
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

    // Save restore: GameFlowManager re-emits an ABSOLUTE CONTRACT_UPDATE and sets debrisCleared without events.
    // Un-seed both tracks so the next observation re-seeds silently instead of replaying history.
    eventBus.on(Events.PERSISTENCE_LOADED, () => {
      this._debrisFrac = null;
      this._contractFrac = null;
    });

    // "What next" recap when leaving the shop.
    eventBus.on(Events.SHOP_DEPLOY, () => {
      this._postRecap();
    });
    // The depot stop is the WORKBENCH BREAK, not the SHOP GameState, and SHOP_DEPLOY never fires in gameplay: the
    // break's end (both drawers closed) is the same "leaving the shop" moment. Never emitted with the ladder off.
    if (Events.WORKBENCH_RESUME) {
      eventBus.on(Events.WORKBENCH_RESUME, () => {
        this._postRecap();
      });
    }

    // Clearing a cluster is a natural "chunk of work finished" beat: restate progress + next step. The compact
    // card / ceremony is owned by RewardSystem; this is the textual carryover (HINT_POSTED ticker + status recap).
    eventBus.on(Events.CLUSTER_CLEARED, () => {
      eventBus.emit(Events.HINT_POSTED, {
        id: 'cluster-cleared-next',
        text: 'Cluster clear. Scroll out to LEO and press Space to fly to the next cluster.',
        keys: ['PageUp'],
        duration: 9000,
        priority: 'normal',
      });
      // Tie ΔV to the orbital ladder + seed the "be more efficient" replay hook on the FIRST cluster clear
      // (one-shot). The per-cluster ΔV numbers live in the Debris Map.
      if (!this._firstClusterClearComms) {
        this._firstClusterClearComms = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'HOUSTON',
          text: 'Nice sweep, Cowboy. Moving between clusters costs ΔV. Gather metals and pick efficient lines, and you climb higher for less.',
          priority: 'info',
          _postOnboarding: true,
        });
      }
      this._postRecap();
    });

    eventBus.on(Events.GAME_RESET, () => this.reset());
  }

  /** @private Dual-objective "what next" recap (HOUSTON), shared by SHOP_DEPLOY and CLUSTER_CLEARED. */
  _postRecap() {
    const clearTarget = Constants.WIN_DEBRIS_COUNT || 60;
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
  }

  reset() {
    this._debrisFrac = null;
    this._contractFrac = 0;   // fresh-game baseline
    this._fired.clear();
    this._cleared = 0;
    this._contractKg = 0;
    this._firstClusterClearComms = false;
  }

  /** @private Advance a track to a new value; fire newly-crossed milestones. The first observation per track seeds without firing. */
  _advance(track, value, target) {
    if (!target || target <= 0) return;
    const frac = Math.min(1, value / target);
    const prevKey = track === 'debris' ? '_debrisFrac' : '_contractFrac';
    const prev = this[prevKey];
    this[prevKey] = frac;

    if (prev === null) {
      // Silent seed (post-restore only): mark already-passed thresholds as fired so history isn't replayed. Fresh
      // games never get here: contract starts at 0 and debris seeds from count-1.
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
