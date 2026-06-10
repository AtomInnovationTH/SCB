/**
 * _bossLifecycle.js — shared, pure primitives for the protect-the-asset / race
 * boss systems (CH5 ISS, CH9 Starlink, …). No EventBus / DOM / THREE — fully
 * Node-testable. Each boss keeps its own outcome + award logic; this module owns
 * the one piece that MUST behave identically across bosses: deciding when a
 * tagged threat fragment has been neutralised (so they can't drift).
 *
 * @module systems/_bossLifecycle
 */

import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';

/**
 * Pull a debris id out of the various capture/removal payloads
 * (`DEBRIS_REMOVED`, `CATCH_PROCESSED`, `ARM_CAPTURED`, `LASSO_CAPTURED`, …).
 * Pure.
 * @param {*} p
 * @returns {number|null}
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
 * Tracks a set of threat-fragment ids and which have been neutralised. Clearing
 * is idempotent and de-duped by id, so the same frag emitting capture→process→
 * remove counts once, and non-threat ids are ignored. Pure / Node-safe.
 */
export class ThreatSet {
  /** @param {number[]} [ids] */
  constructor(ids = []) {
    this.threats = new Set(ids);
    this.cleared = new Set();
  }

  /** @returns {number} */
  get total() { return this.threats.size; }
  /** @returns {number} */
  get clearedCount() { return this.cleared.size; }
  /** @returns {boolean} all (≥1) threats neutralised. */
  get allCleared() { return this.threats.size > 0 && this.cleared.size >= this.threats.size; }
  /** @returns {number} 0..1 fraction neutralised. */
  get fractionCleared() { return this.threats.size === 0 ? 0 : this.cleared.size / this.threats.size; }

  /**
   * Mark a threat cleared from a capture/removal payload.
   * @param {*} payload
   * @returns {boolean} true iff this was a new, previously-uncleared threat.
   */
  touch(payload) {
    const id = extractDebrisId(payload);
    if (id == null || !this.threats.has(id) || this.cleared.has(id)) return false;
    this.cleared.add(id);
    return true;
  }

  /** Clear all tracking. */
  reset() {
    this.threats = new Set();
    this.cleared = new Set();
  }
}

/**
 * Award `kg` toward the elevator contract (the only place that mass lives) and,
 * if that crosses `TARGET_MASS_KG`, fire the win bonus + `CONTRACT_COMPLETE` so
 * the elevator win still arms (GameFlowManager listens for CONTRACT_COMPLETE).
 * Shared by every boss so the win-crossing logic can't drift. Node-safe.
 *
 * @param {object} eventBus
 * @param {object} shop    — ShopScreen with get/setContractMass()
 * @param {object} scoring — ScoringSystem with addCredits() (optional)
 * @param {number} kg
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
