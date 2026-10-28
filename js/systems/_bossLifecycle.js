/**
 * @module systems/_bossLifecycle — shared, pure primitives for the protect-the-asset / race boss systems (CH5 ISS,
 * CH9 Starlink, …). No EventBus / DOM / THREE — fully Node-testable. Each boss keeps its own outcome + award logic;
 * this module owns what MUST behave identically across bosses: deciding when a tagged threat fragment has been
 * neutralised (so they can't drift), and WHEN a mission-keyed onset may start (`MissionOnset`, shared with the
 * MissionCoach chapters: one arm/hold/fire rule, three consumers).
 */

import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';

/**
 * The ONE onset rule for a mission-keyed event (a boss field, a coach chapter; docs/ladder/08-workbench.md §5 D4).
 * Onsets key on the MISSION BOUNDARY (`MISSION_START { missionNumber }`), not `SHOP_DEPLOY`: the depot is optional
 * from chapter 4 on, so a player who never pushed into the doorway would never meet the ISS / Starlink bosses or hear
 * chapters 5+ (owner decision 1, 2026-09-04):
 *
 *   • ARM at the boundary — `arm(mission)`; a later arm replaces one that never fired (a skipped chapter is not
 *     queued).
 *   • FIRE on the first gameplay frame after it that has NO depot stop pending — `poll(hold)` once per gameplay update
 *     returns the armed mission exactly once when it may start, else null. `hold` is the caller's composed condition:
 *     GameFlowManager.isDepotStopPending() (the forced stop's dwell timer or the workbench break is live — every
 *     chapter with ?ladder=0; with the ladder on only when MISSIONS.FORCED_DEPOT_STOP is turned back on, since after
 *     every mission the depot is an invitation — DECISIONS §14) plus any consumer-local reason (the coach's "never
 *     overlap chapters"). A boss therefore never starts under the depot overlay: with a stop pending it holds through
 *     the card dwell and the SHOP and fires on the first gameplay frame after the SHOP closes (DEPLOY or the Esc exit —
 *     both resume gameplay; the SHOP itself never ticks these systems). With no stop pending it fires at once.
 *   • It never fires in the update cycle that armed it. DebrisField's own MISSION_START handler re-seats the mission-N
 *     welcome cluster on ITS next update, and the threat spawner skips `welcomeSpawn` pieces — so the spawn must run
 *     after that re-seat or the cluster could repurpose the boss's frags a frame later (ordering, not timing).
 *   • `cancel()` — a terminal state (GAME_OVER / WIN) or a reset drops the arm.
 *
 * Pure / Node-safe; pinned by test-bossLifecycle.
 */
export class MissionOnset {
  constructor() {
    /** @type {number|null} the armed mission, or null. */
    this._mission = null;
    /** @type {boolean} armed during the current update cycle — skip one poll. */
    this._fresh = false;
  }

  get armed() { return this._mission != null; }
  get mission() { return this._mission; }

  arm(mission) {
    this._mission = mission;
    this._fresh = true;
  }

  /** Drop the arm (terminal state / reset). */
  cancel() {
    this._mission = null;
    this._fresh = false;
  }

  /**
   * One gameplay update. Returns the armed mission exactly once when it may fire — never in the arming cycle, never
   * while `hold` is true (a depot stop is pending / the consumer is busy).
   */
  poll(hold = false) {
    if (this._mission == null) return null;
    if (this._fresh) { this._fresh = false; return null; }
    if (hold) return null;
    const mission = this._mission;
    this._mission = null;
    return mission;
  }
}

/**
 * Pull a debris id out of the various capture/removal payloads (`DEBRIS_REMOVED`, `CATCH_PROCESSED`, `ARM_CAPTURED`,
 * `LASSO_CAPTURED`, …). Pure.
 */
export function extractDebrisId(p) {
  if (p == null) return null;
  if (typeof p === 'number') return p;
  if (typeof p.id === 'number') return p.id;
  if (typeof p.debrisId === 'number') return p.debrisId;
  if (typeof p.targetId === 'number') return p.targetId;
  if (p.debris && typeof p.debris.id === 'number') return p.debris.id;
  if (p.target && typeof p.target.id === 'number') return p.target.id;
  return null;
}

/**
 * Tracks a set of threat-fragment ids and which have been neutralised. Clearing is idempotent and de-duped by id, so
 * the same frag emitting capture→process→remove counts once, and non-threat ids are ignored. Pure / Node-safe.
 */
export class ThreatSet {
  constructor(ids = []) {
    this.threats = new Set(ids);
    this.cleared = new Set();
  }

  get total() { return this.threats.size; }
  get clearedCount() { return this.cleared.size; }
  /** all (≥1) threats neutralised. */
  get allCleared() { return this.threats.size > 0 && this.cleared.size >= this.threats.size; }
  /** 0..1 fraction neutralised. */
  get fractionCleared() { return this.threats.size === 0 ? 0 : this.cleared.size / this.threats.size; }

  /** Mark a threat cleared from a capture/removal payload; true iff it was a new, previously-uncleared threat. */
  touch(payload) {
    const id = extractDebrisId(payload);
    if (id == null || !this.threats.has(id) || this.cleared.has(id)) return false;
    this.cleared.add(id);
    return true;
  }

  reset() {
    this.threats = new Set();
    this.cleared = new Set();
  }
}

/**
 * Award `kg` toward the elevator contract (the only place that mass lives) and, if that crosses `TARGET_MASS_KG`, fire
 * the win bonus + `CONTRACT_COMPLETE` so the elevator win still arms (GameFlowManager listens for CONTRACT_COMPLETE).
 * Shared by every boss so the win-crossing logic can't drift. Node-safe.
 *
 * @param {object} shop    — ShopScreen with get/setContractMass()
 * @param {object} scoring — ScoringSystem with addCredits() (optional)
 */
export function awardElevatorMass(eventBus, shop, scoring, kg) {
  if (!shop || typeof shop.getContractMass !== 'function' || typeof shop.setContractMass !== 'function') return;
  const newMass = shop.getContractMass() + kg;
  shop.setContractMass(newMass);
  const target = (Constants.ELEVATOR_CONTRACT && Constants.ELEVATOR_CONTRACT.TARGET_MASS_KG) || 10000;
  eventBus.emit(Events.CONTRACT_UPDATE, { contractMassKg: newMass, targetMassKg: target });

  if (newMass >= target) {
    const winBonus = (Constants.ELEVATOR_CONTRACT && Constants.ELEVATOR_CONTRACT.WIN_BONUS) || 50000;
    if (scoring && typeof scoring.addCredits === 'function') scoring.addCredits(winBonus);
    eventBus.emit(Events.CONTRACT_COMPLETE, { totalMassKg: newMass, bonusCredits: winBonus });
  }
}
