/**
 * @module systems/ApproachCostLine — after every autopilot approach, in every mission, the coach says the gas it used
 * ("That approach used 0.7 kg of argon."; DECISIONS §38 row 10, owner 2026-11-01). One small listener on the bus, wired
 * in main.js beside the MissionCoach: the coach only runs chapters 2+ and holds no chapter 1, so it cannot see every mission.
 *
 * An approach runs from the FIRST AUTOPILOT_ENGAGE toward a piece (or a cluster) to the first AUTOPILOT_ARRIVED on it:
 *   • the engine gas aboard at that first engage is kept (AUTOPILOT_ENGAGE carries `gasKg`, `gasId`, `debrisId`);
 *   • a disengage (an arrow key, then A again) keeps it: the approach is counted from the first engage; one that ends the
 *     approach for good (the piece was caught or lost, an ion transfer began, the arrival's own disengage) clears it;
 *   • an engage toward another piece or cluster starts a new approach (the old one was left);
 *   • the arrival posts the line and clears the approach, so a HOLD excursion that re-arrives on the same lock
 *     (AUTOPILOT_ARRIVED repeats then) posts nothing more;
 *   • GAME_RESET clears it; an approach that used under 1 g (rounds to nothing) posts nothing.
 * The line is tagged `_onboarding` (the tier-0 pass the opening lines use), not the coach's `_postOnboarding`: training 1 runs at
 * suppression tier 0 (commsSuppression.js messagePassesSuppression), which drops every other tag, so a coach-style line never showed there.
 * The trip to the resupply satellite and the ion transfers between fields are not approaches: GameFlowManager._flyToField
 * (GameFlowManager.js:2146) sends both through TransferTrip.begin (a satellite trip is "a field trip", TransferTrip.js:39), whose burn
 * start turns the autopilot off (TransferTrip.js:637, reason 'TRANSFER'); the autopilot never flies to her and emits no arrival for it.
 *
 * Node-safe (no THREE / DOM).
 */

import { Events } from '../core/Events.js';

/** Disengage reasons that end an approach for good (AutopilotSystem.disengage payload `reason`); a key press or the like does not. */
const ENDS_APPROACH = new Set(['TARGET_CAUGHT', 'TARGET_LOST', 'TRANSFER', 'ARRIVED']);

/**
 * The gas an approach used, as the line says it: grams below 1 kg, else kg with one decimal.
 * @param {number} kg @returns {string}
 */
export function formatGasUsed(kg) {
  const g = Math.max(1, Math.round(kg * 1000));
  return g < 1000 ? `${g} g` : `${(kg).toFixed(1)} kg`;
}

/**
 * What an engage / arrival is "toward": the piece's id, else the cluster's id, else the mode for a trawl flight; null for nothing
 * to approach (PROGRADE: the autopilot only follows her orbit and never arrives).
 * @param {{debrisId?: (number|string|null), clusterId?: (number|string|null), mode?: string}} d @returns {(string|null)}
 */
function approachKey(d) {
  if (!d) return null;
  if (d.debrisId != null) return `d:${d.debrisId}`;
  if (d.clusterId != null) return `c:${d.clusterId}`;
  return d.mode && d.mode !== 'PROGRADE' ? `m:${d.mode}` : null;
}

export class ApproachCostLine {
  /** @param {{eventBus: object}} deps */
  constructor({ eventBus } = {}) {
    this._eventBus = eventBus;
    /** @type {{key: string, gasKg: number}|null} the approach in flight: where it is toward, the gas at its first engage. */
    this._pending = null;
    this._unsubs = [];
    this._disposed = false;
  }

  /** Subscribe. Call once after construction. */
  init() {
    if (this._disposed || !this._eventBus) return;
    const on = (evt, h) => { if (evt) this._unsubs.push(this._eventBus.on(evt, h)); };
    on(Events.AUTOPILOT_ENGAGE, (d) => this._onEngage(d));
    on(Events.AUTOPILOT_ARRIVED, (d) => this._onArrived(d));
    on(Events.AUTOPILOT_DISENGAGE, (d) => { if (d && ENDS_APPROACH.has(d.reason)) this._pending = null; });
    on(Events.GAME_RESET, () => { this._pending = null; });
  }

  /** @private */
  _onEngage(d) {
    const key = approachKey(d);
    if (key === null || !Number.isFinite(d.gasKg)) return;
    if (this._pending && this._pending.key === key) return;   // the same approach (a re-engage, or a heading-mode change): first gas stays
    this._pending = { key, gasKg: d.gasKg };
  }

  /** @private */
  _onArrived(d) {
    const p = this._pending;
    if (!p || p.key !== approachKey(d)) return;
    this._pending = null;                                      // once per approach: a HOLD re-arrival finds nothing
    if (!Number.isFinite(d.gasKg)) return;
    const usedKg = p.gasKg - d.gasKg;
    if (!(usedKg >= 0.0005)) return;                           // under 1 g: nothing to say
    this._eventBus.emit(Events.COMMS_MESSAGE, {
      source: 'HOUSTON',
      text: `That approach used ${formatGasUsed(usedKg)} of ${d.gasId || 'xenon'}.`,
      channel: 'MISSION',
      priority: 'info',
      _onboarding: true,
    });
  }

  /** Unsubscribe everything. */
  dispose() {
    this._disposed = true;
    for (const u of this._unsubs) { try { if (typeof u === 'function') u(); } catch (_) { /* ignore */ } }
    this._unsubs = [];
    this._pending = null;
  }
}
