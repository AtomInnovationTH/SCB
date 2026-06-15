/**
 * PowerDistribution.js — FS2-heritage Energy Transfer System (ETS)
 * Player distributes total ship power across 3 buses:
 *   THRUST  — Ion drive efficiency (Isp scaling)
 *   SENSORS — Detection range scaling
 *   ARMS    — Arm beacon power + recharge rate
 * 
 * Total always sums to 100%. Default: 40/30/30.
 * Keys: 1/2/3 select bus, [ decrease 10%, ] increase 10%.
 * 
 * @module systems/PowerDistribution
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

export const PowerBuses = {
  THRUST: 'thrust',
  SENSORS: 'sensors',
  ARMS: 'arms',
};

const STEP = 10;      // % per keypress
const MIN_ALLOC = 0;  // Minimum per bus (can go to 0)

class PowerDistribution {
  constructor() {
    // Allocation percentages (always sum to 100)
    this.thrust = 40;
    this.sensors = 30;
    this.arms = 30;

    // Currently selected bus (for [ ] adjustment)
    this.selectedBus = PowerBuses.THRUST;

    // Computed effective multipliers (0.0 - 1.0+)
    // These are what other systems read
    this.thrustMultiplier = 1.0;
    this.sensorMultiplier = 1.0;
    this.armMultiplier = 1.0;

    // Total available power (watts) — set by ResourceSystem each frame
    this.totalPower = 8000;

    // Solar input (watts) — set by LaunchSequence during ROSA deploy (ST-9.11 C-5)
    this._solarInputW = 0;

    // Warning state
    this._lastArmWarning = 0;

    // Sprint 3: Skill-based gate — suppress low-power alerts until power management discovered
    this._powerMgmtDiscovered = false;
    eventBus.on(Events.SKILL_DISCOVERED, (d) => {
        if (d?.skillId === 'manage_power') this._powerMgmtDiscovered = true;
    });

    // Initialize multipliers from default allocations
    this._updateMultipliers();
  }

  /**
   * Select a bus for [ ] adjustment
   * @param {string} bus - PowerBuses.THRUST | SENSORS | ARMS
   */
  selectBus(bus) {
    if (Object.values(PowerBuses).includes(bus)) {
      this.selectedBus = bus;
      eventBus.emit(Events.POWER_BUS_SELECTED, { bus });
    }
  }

  /**
   * Increase selected bus by STEP%, decrease others proportionally
   */
  increaseSelected() {
    this._adjustBus(this.selectedBus, STEP);
  }

  /**
   * Decrease selected bus by STEP%, increase others proportionally
   */
  decreaseSelected() {
    this._adjustBus(this.selectedBus, -STEP);
  }

  /**
   * Adjust a bus by delta%, redistributing to/from others proportionally
   */
  _adjustBus(bus, delta) {
    const current = this[bus];
    const newVal = Math.max(MIN_ALLOC, Math.min(100, current + delta));
    const actualDelta = newVal - current;

    if (actualDelta === 0) return;

    // Get the other two buses
    const allBuses = [PowerBuses.THRUST, PowerBuses.SENSORS, PowerBuses.ARMS];
    const others = allBuses.filter(b => b !== bus);

    // Distribute the inverse delta proportionally among the others
    const otherTotal = others.reduce((sum, b) => sum + this[b], 0);

    if (otherTotal === 0 && actualDelta > 0) {
      // Can't increase if others are at 0 — would need to take from somewhere
      return;
    }

    this[bus] = newVal;

    if (otherTotal > 0) {
      // Distribute proportionally
      for (const other of others) {
        const proportion = this[other] / otherTotal;
        this[other] = Math.max(MIN_ALLOC, Math.round(this[other] - actualDelta * proportion));
      }
    } else {
      // Others are 0, split delta equally
      const split = Math.round(-actualDelta / others.length);
      for (const other of others) {
        this[other] = Math.max(MIN_ALLOC, split);
      }
    }

    // Fix rounding — ensure sum is exactly 100
    const sum = this.thrust + this.sensors + this.arms;
    if (sum !== 100) {
      const diff = 100 - sum;
      const largest = others.sort((a, b) => this[b] - this[a])[0];
      this[largest] = Math.max(MIN_ALLOC, this[largest] + diff);
    }

    this._updateMultipliers();
    eventBus.emit(Events.POWER_CHANGED, this.getState());
  }

  /**
   * Update effective multipliers from allocations.
   * Multiplier curve: below 30% → steep dropoff. Above 50% → diminishing returns.
   */
  _updateMultipliers() {
    this.thrustMultiplier = this._allocationToMultiplier(this.thrust);
    this.sensorMultiplier = this._allocationToMultiplier(this.sensors);
    this.armMultiplier = this._allocationToMultiplier(this.arms);
  }

  /**
   * Convert allocation % to effective multiplier.
   * 0% → 0.0 (disabled)
   * 10% → 0.3
   * 30% → 0.7 (minimum useful)
   * 50% → 1.0 (nominal)
   * 80% → 1.2
   * 100% → 1.3 (diminishing returns cap)
   */
  _allocationToMultiplier(pct) {
    if (pct <= 0) return 0.0;
    if (pct <= 10) return (pct / 10) * 0.3;                  // 0.0 to 0.3
    if (pct <= 30) return 0.3 + ((pct - 10) / 20) * 0.4;    // 0.3 to 0.7
    if (pct <= 50) return 0.7 + ((pct - 30) / 20) * 0.3;    // 0.7 to 1.0
    return 1.0 + ((pct - 50) / 50) * 0.3;                    // 1.0 to 1.3
  }

  /**
   * Called each frame to check for dangerous configurations
   * @param {number} dt - Delta time
   * @param {object} context - { armsDeployed: number }
   */
  update(dt, context) {
    // Warn if arms are deployed but ARMS bus is at 0
    // Phase 8: Suppress low-power alerts during early tutorial (§6)
    if (!this._powerMgmtDiscovered) return;
    if (context && context.armsDeployed > 0 && this.arms === 0) {
      const now = performance.now();
      if (now - this._lastArmWarning > 5000) {
        this._lastArmWarning = now;
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: '⚠ DAUGHTER BEACON OFFLINE. Deployed daughters cannot navigate!',
          priority: 'critical',
        });
      }
    }
  }

  /**
   * Get current state for HUD display
   */
  getState() {
    return {
      thrust: this.thrust,
      sensors: this.sensors,
      arms: this.arms,
      selectedBus: this.selectedBus,
      thrustMultiplier: this.thrustMultiplier,
      sensorMultiplier: this.sensorMultiplier,
      armMultiplier: this.armMultiplier,
    };
  }

  /**
   * Set solar power input from ROSA deployment (ST-9.11 C-5).
   * Called by LaunchSequence during ROSA phases and on skipToReady().
   * Does NOT override totalPower (which ResourceSystem sets each frame);
   * stores separately for readout / downstream integration.
   * @param {number} watts — current solar output (0–2240 typical)
   */
  setSolarInput(watts) {
    this._solarInputW = watts;
  }

  /**
   * Get current solar power input (watts).
   * @returns {number}
   */
  getSolarInput() {
    return this._solarInputW || 0;
  }

  /**
   * Serialize for persistence
   */
  serialize() {
    return { thrust: this.thrust, sensors: this.sensors, arms: this.arms };
  }

  /**
   * Reset to defaults (new game / retry)
   */
  reset() {
    this.thrust = 40;
    this.sensors = 30;
    this.arms = 30;
    this.selectedBus = PowerBuses.THRUST;
    this._lastArmWarning = 0;
    this._solarInputW = 0;
    this._updateMultipliers();
  }

  /**
   * Restore from save
   */
  restore(data) {
    if (data) {
      this.thrust = data.thrust ?? 40;
      this.sensors = data.sensors ?? 30;
      this.arms = data.arms ?? 30;
      this._updateMultipliers();
    }
  }
}

export const powerDistribution = new PowerDistribution();
