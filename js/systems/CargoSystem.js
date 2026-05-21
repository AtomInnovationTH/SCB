/**
 * CargoSystem — manages the player's cargo hold for salvaged materials.
 * Tracks metal inventory by type, total mass, market value, and
 * potential ΔV if used as propellant.
 * @module systems/CargoSystem
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { computeSalvageDeltaV } from '../entities/OrbitalMechanics.js';

export class CargoSystem {
  constructor() {
    this._cargo = new Map();  // metalId → { name, massKg, color, ispAsThrust, marketValue }
    this._totalMassKg = 0;
    this._capacityKg = Constants.CARGO_CAPACITY_KG || 500;
    this._setupListeners();
  }

  _setupListeners() {
    // Listen for salvage recovered events to auto-store metals
    eventBus.on(Events.CARGO_STORE, (data) => this.storeMetal(data));
  }

  /**
   * Store recovered metal in cargo.
   * @param {object} data - { metalId, name, massKg, color, ispAsThrust, marketValue }
   * @returns {{ stored: boolean, overflow: number }}
   */
  storeMetal(data) {
    const available = this._capacityKg - this._totalMassKg;
    const toStore = Math.min(data.massKg, available);
    const overflow = data.massKg - toStore;

    if (toStore <= 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'CARGO', text: `Hold full — cannot store ${data.name}`, priority: 'warning'
      });
      return { stored: false, overflow: data.massKg };
    }

    if (this._cargo.has(data.metalId)) {
      const existing = this._cargo.get(data.metalId);
      existing.massKg += toStore;
    } else {
      if (this._cargo.size >= (Constants.CARGO_CAPACITY_SLOTS || 20)) {
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'CARGO', text: `No empty slots for ${data.name}`, priority: 'warning'
        });
        return { stored: false, overflow: data.massKg };
      }
      this._cargo.set(data.metalId, {
        name: data.name,
        massKg: toStore,
        color: data.color || '#CCCCCC',
        ispAsThrust: data.ispAsThrust || 0,
        marketValue: data.marketValue || 0,
      });
    }

    this._totalMassKg += toStore;

    eventBus.emit(Events.CARGO_UPDATED, this.getStatus());

    if (overflow > 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'CARGO',
        text: `Stored ${toStore.toFixed(1)}kg ${data.name} (${overflow.toFixed(1)}kg overflow lost)`,
        priority: 'info'
      });
    } else {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'CARGO',
        text: `+${toStore.toFixed(1)}kg ${data.name}`,
        priority: 'info'
      });
    }

    return { stored: true, overflow };
  }

  /**
   * Remove metal from cargo (for selling or using as fuel).
   * @param {string} metalId
   * @param {number} massKg - amount to remove
   * @returns {number} actual mass removed
   */
  removeMetal(metalId, massKg) {
    if (!this._cargo.has(metalId)) return 0;
    const entry = this._cargo.get(metalId);
    const removed = Math.min(entry.massKg, massKg);
    entry.massKg -= removed;
    this._totalMassKg -= removed;

    if (entry.massKg <= 0.01) {
      this._cargo.delete(metalId);
    }

    // Only emit update for significant changes (avoid per-frame spam during thrust)
    if (removed > 0.1) {
      eventBus.emit(Events.CARGO_UPDATED, this.getStatus());
    }
    return removed;
  }

  /**
   * Get total market value of all cargo.
   * @returns {number}
   */
  getTotalValue() {
    let total = 0;
    for (const [, entry] of this._cargo) {
      total += entry.massKg * entry.marketValue;
    }
    return Math.round(total);
  }

  /**
   * Get total potential ΔV if all usable metals were burned as propellant.
   * @param {number} dryMassKg - ship dry mass
   * @returns {number} ΔV in m/s
   */
  getPotentialDeltaV(dryMassKg) {
    let totalDV = 0;
    for (const [, entry] of this._cargo) {
      if (entry.ispAsThrust > 0) {
        totalDV += computeSalvageDeltaV(entry.massKg, entry.ispAsThrust, dryMassKg);
      }
    }
    return totalDV;
  }

  /**
   * Get cargo manifest for UI display.
   * @returns {Array<{metalId: string, name: string, massKg: number, value: number, color: string, canBurnAsFuel: boolean, ispAsThrust: number}>}
   */
  getManifest() {
    const items = [];
    for (const [metalId, entry] of this._cargo) {
      items.push({
        metalId,
        name: entry.name,
        massKg: Math.round(entry.massKg * 10) / 10,
        value: Math.round(entry.massKg * entry.marketValue),
        color: entry.color,
        canBurnAsFuel: entry.ispAsThrust > 0,
        ispAsThrust: entry.ispAsThrust,
      });
    }
    // Sort by value descending
    items.sort((a, b) => b.value - a.value);
    return items;
  }

  /**
   * Get full cargo status summary.
   * @returns {object}
   */
  getStatus() {
    return {
      totalMassKg: Math.round(this._totalMassKg * 10) / 10,
      capacityKg: this._capacityKg,
      utilizationPct: this._capacityKg > 0 ? this._totalMassKg / this._capacityKg : 0,
      totalValue: this.getTotalValue(),
      itemCount: this._cargo.size,
      manifest: this.getManifest(),
    };
  }

  /**
   * Serialize cargo state for persistence.
   * @returns {object}
   */
  serialize() {
    const entries = [];
    for (const [metalId, entry] of this._cargo) {
      entries.push({ metalId, ...entry });
    }
    return { entries, totalMassKg: this._totalMassKg, capacityKg: this._capacityKg };
  }

  /**
   * Restore cargo state from persistence data.
   * @param {object} data
   */
  restore(data) {
    this._cargo.clear();
    this._totalMassKg = 0;
    if (data && data.entries) {
      for (const entry of data.entries) {
        this._cargo.set(entry.metalId, {
          name: entry.name,
          massKg: entry.massKg,
          color: entry.color,
          ispAsThrust: entry.ispAsThrust,
          marketValue: entry.marketValue,
        });
        this._totalMassKg += entry.massKg;
      }
    }
    if (data && data.capacityKg) this._capacityKg = data.capacityKg;
  }

  /** Reset cargo to empty. */
  reset() {
    this._cargo.clear();
    this._totalMassKg = 0;
    this._capacityKg = Constants.CARGO_CAPACITY_KG || 500;
  }

  /** Cleanup. */
  dispose() {
    // Could remove event listeners here if needed
  }
}
