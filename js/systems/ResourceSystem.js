/**
 * ResourceSystem.js — Centralized resource/inventory management (CANONICAL OWNER)
 * Manages fuel (xenon propellant), cold gas (RCS), battery charge,
 * solar recharge, and resource upgrade effects.
 *
 * One-way push to PlayerSatellite.resources via _syncToPlayer() so that
 * HUD and other readers can access values from player.resources.
 * All consumption flows through eventBus → ResourceSystem.consume().
 *
 * @module systems/ResourceSystem
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

export class ResourceSystem {
  constructor() {
    // ── Resource pools (canonical — synced to player.resources) ──────────
    this.xenon = Constants.XENON_FUEL_MAX;
    this.coldGas = Constants.COLD_GAS_MAX;
    this.battery = Constants.BATTERY_MAX;
    this.solarPanelHealth = 1.0;

    // ── Lithium (F16: MPD thruster propellant) ──────────────────────────
    this.lithium = 0;                                // starts empty — must salvage
    this.lithiumMax = Constants.MPD_LITHIUM_CAPACITY; // 100 units

    // ── Derived rates ───────────────────────────────────────────────────
    this.solarRate =
      Constants.SOLAR_PANEL_EFFICIENCY *
      Constants.SOLAR_FLUX *
      Constants.SOLAR_PANEL_AREA;

    // ── Max capacities (upgradeable) ────────────────────────────────────
    this.xenonMax = Constants.XENON_FUEL_MAX;
    this.coldGasMax = Constants.COLD_GAS_MAX;
    this.batteryMax = Constants.BATTERY_MAX;

    // ── Panel degradation (upgrade-affected) ────────────────────────────
    this.panelDegradationMultiplier = 1.0;

    // ── S3b: MPD power infrastructure ────────────────────────────────────
    this._hasSupercap = false;         // Graphene Supercap upgrade flag
    this._rtgRate = 0;                 // RTG constant generation (Wh/s)
    this._powerBeamRate = 0;           // Power beaming rate (Wh/s during ground station pass)
    this._groundStationInView = false; // True during ground station pass windows

    // ── Dual-mode fuel tracking (Phase 4) ───────────────────────────────
    this._currentFuelId = Constants.DEFAULT_FUEL || 'xenon';
    this._availableFuels = ['xenon']; // always have xenon; others added dynamically
    this._cargoSystem = null;

    // ── Player entity reference (set via setPlayer) ─────────────────────
    /** @type {object|null} */
    this._player = null;

    // ── Depletion guard (emit only once per depletion) ──────────────────
    this._depletionEmitted = false;

    /** @type {number} Weather-based solar power multiplier (0 = eclipse, 1.3 = flare boost) */
    this._weatherSolarMult = 1.0;

    /** @type {number} Seconds since last WEATHER_ACTIVE event */
    this._weatherLastUpdate = 0;

    // Listen for weather effects on solar power
    eventBus.on(Events.WEATHER_ACTIVE, (effects) => {
      this._weatherSolarMult = effects.solarPower ?? 1.0;
      this._weatherLastUpdate = 0;
    });

    this._setupListeners();
  }

  /**
   * Bind to the player entity so we can sync resource values.
   * @param {object} player - PlayerSatellite instance
   */
  setPlayer(player) {
    this._player = player;
    this._syncToPlayer(); // Push OUR initial values to the player
  }

  /**
   * Set reference to CargoSystem for cargo-based fuel consumption.
   * @param {import('./CargoSystem.js').CargoSystem} cargoSystem
   */
  setCargoSystem(cargoSystem) {
    this._cargoSystem = cargoSystem;
  }

  // ======================================================================
  // RESOURCE OPERATIONS
  // ======================================================================

  /**
   * Consume a named resource.
   * @param {string} resource - 'xenon' | 'coldGas' | 'battery'
   * @param {number} amount
   * @returns {boolean} true if the player had enough
   */
  consume(resource, amount) {
    if (!this._isValid(resource)) return false;
    if (this[resource] < amount) return false;

    this[resource] -= amount;
    this._syncToPlayer();
    eventBus.emit(Events.RESOURCE_CHANGED, {
      resource,
      value: this[resource],
      delta: -amount,
    });
    return true;
  }

  /**
   * Add to a named resource (capped at max).
   * @param {string} resource - 'xenon' | 'coldGas' | 'battery'
   * @param {number} amount
   */
  replenish(resource, amount) {
    if (!this._isValid(resource)) return;
    const max = this[resource + 'Max'] || Infinity;
    this[resource] = Math.min(this[resource] + amount, max);
    this._syncToPlayer();
    eventBus.emit(Events.RESOURCE_CHANGED, {
      resource,
      value: this[resource],
      delta: amount,
    });
  }

  /**
   * Restore solar panel health by a fraction (from salvaged GaAs cells).
   * Health is clamped to [0, 1.0].
   * @param {number} fraction - e.g. 0.02 for 2% restoration
   */
  replenishPanelHealth(fraction) {
    this.solarPanelHealth = Math.min(1.0, this.solarPanelHealth + fraction);
    this._syncToPlayer();
    eventBus.emit(Events.RESOURCE_CHANGED, {
      resource: 'solarPanelHealth',
      value: this.solarPanelHealth,
      delta: fraction,
    });
  }

  /**
   * Check whether the player can afford a cost.
   * @param {string} resource
   * @param {number} amount
   * @returns {boolean}
   */
  canAfford(resource, amount) {
    if (!this._isValid(resource)) return false;
    return this[resource] >= amount;
  }

  // ======================================================================
  // LITHIUM OPERATIONS (F16: MPD Thruster)
  // ======================================================================

  /**
   * Consume lithium propellant for MPD thruster.
   * @param {number} amount
   * @returns {boolean} true if enough lithium was available
   */
  consumeLithium(amount) {
    if (this.lithium < amount) return false;
    this.lithium -= amount;
    this._syncToPlayer();
    eventBus.emit(Events.LITHIUM_CHANGE, {
      lithium: this.lithium,
      lithiumMax: this.lithiumMax,
      delta: -amount,
    });
    return true;
  }

  /**
   * Add lithium from salvage (capped at max capacity).
   * @param {number} amount
   */
  addLithium(amount) {
    const prev = this.lithium;
    this.lithium = Math.min(this.lithiumMax, this.lithium + amount);
    const actual = this.lithium - prev;
    this._syncToPlayer();
    eventBus.emit(Events.LITHIUM_CHANGE, {
      lithium: this.lithium,
      lithiumMax: this.lithiumMax,
      delta: actual,
    });
  }

  // ======================================================================
  // DUAL-MODE FUEL SYSTEM (Phase 4)
  // ======================================================================

  /**
   * Get current fuel definition.
   * @returns {object}
   */
  getCurrentFuel() {
    return Constants.FUELS[this._currentFuelId] || Constants.FUELS.xenon;
  }

  /**
   * Get current fuel ID.
   * @returns {string}
   */
  getCurrentFuelId() {
    return this._currentFuelId;
  }

  /**
   * Cycle to next available fuel. Called when T is pressed.
   * @param {import('./CargoSystem.js').CargoSystem} [cargoSystem] - to check available propellant slugs
   */
  cycleFuel(cargoSystem) {
    const cs = cargoSystem || this._cargoSystem;

    // Build list of available fuels
    const available = ['xenon']; // always available (even if tank is empty)

    if (cs) {
      const manifest = cs.getManifest();
      for (const [fuelId, fuelDef] of Object.entries(Constants.FUELS)) {
        if (fuelDef.fromCargo && fuelDef.cargoMetalId) {
          const inCargo = manifest.find(m => m.metalId === fuelDef.cargoMetalId);
          if (inCargo && inCargo.massKg > 0.1) {
            available.push(fuelId);
          }
        }
      }
    }

    this._availableFuels = available;

    // Find current index and cycle
    const currentIdx = available.indexOf(this._currentFuelId);
    const nextIdx = (currentIdx + 1) % available.length;
    this._currentFuelId = available[nextIdx];

    const fuel = this.getCurrentFuel();

    eventBus.emit(Events.FUEL_CHANGED, {
      fuelId: this._currentFuelId,
      name: fuel.name,
      isp: fuel.isp,
      color: fuel.color,
      thrustScale: fuel.thrustScale,
      index: nextIdx,
    });

    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'PROPULSION',
      text: `Fuel: ${fuel.name} (Isp ${fuel.isp}s)`,
      priority: 'info',
    });
  }

  /**
   * Consume ion fuel based on current fuel type.
   * @param {number} amount - base consumption amount
   * @param {import('./CargoSystem.js').CargoSystem} [cargoSystem] - for cargo-based fuels
   * @returns {boolean} true if fuel was available
   */
  consumeIonFuel(amount, cargoSystem) {
    const fuel = this.getCurrentFuel();
    const cs = cargoSystem || this._cargoSystem;

    if (!fuel.fromCargo) {
      // Standard xenon from ship tank
      if (!this.canAfford('xenon', amount)) {
        return false;
      }
      this.consume('xenon', amount);
      return true;
    }

    // Cargo-based fuel
    if (!cs) return false;
    const manifest = cs.getManifest();
    const inCargo = manifest.find(m => m.metalId === fuel.cargoMetalId);

    if (!inCargo || inCargo.massKg < amount) {
      // Fuel depleted — auto-switch to xenon
      eventBus.emit(Events.FUEL_DEPLETED, { fuelId: this._currentFuelId, name: fuel.name });
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'PROPULSION',
        text: `${fuel.name} depleted — switching to Xenon`,
        priority: 'warning',
      });
      this._currentFuelId = 'xenon';
      eventBus.emit(Events.FUEL_CHANGED, {
        fuelId: 'xenon',
        name: 'Xenon',
        isp: Constants.FUELS.xenon.isp,
        color: Constants.FUELS.xenon.color,
        thrustScale: Constants.FUELS.xenon.thrustScale,
      });
      return false;
    }

    cs.removeMetal(fuel.cargoMetalId, amount);
    return true;
  }

  /**
   * Snapshot for HUD rendering.
   * @returns {object}
   */
  getStatus() {
    const fuel = this.getCurrentFuel();
    return {
      xenon: this.xenon,
      xenonMax: this.xenonMax,
      coldGas: this.coldGas,
      coldGasMax: this.coldGasMax,
      battery: this.battery,
      batteryMax: this.batteryMax,
      solarRate: this.solarRate,
      solarPanelHealth: this.solarPanelHealth,
      currentFuelId: this._currentFuelId,
      currentFuelName: fuel.name,
      currentFuelIsp: fuel.isp,
      currentFuelColor: fuel.color,
      lithium: this.lithium,
      lithiumMax: this.lithiumMax,
      // S3b: power infrastructure status
      hasSupercap: this._hasSupercap,
      rtgRate: this._rtgRate,
      powerBeamRate: this._powerBeamRate,
      groundStationInView: this._groundStationInView,
    };
  }

  /**
   * Serialize upgraded max capacities for persistence.
   * Current resource levels are NOT saved — they reset each mission.
   * @returns {object}
   */
  serialize() {
    return {
      xenonMax: this.xenonMax,
      coldGasMax: this.coldGasMax,
      batteryMax: this.batteryMax,
      currentFuelId: this._currentFuelId,
      lithium: this.lithium,
      lithiumMax: this.lithiumMax,
      // S3b: power infrastructure state
      hasSupercap: this._hasSupercap,
      rtgRate: this._rtgRate,
      powerBeamRate: this._powerBeamRate,
    };
  }

  /**
   * Restore upgraded max capacities from saved data.
   * Refills current levels to the restored max values for a fresh mission.
   * @param {object} data - Previously serialized resource maxes
   */
  restore(data) {
    if (!data) return;
    if (data.xenonMax !== undefined) this.xenonMax = data.xenonMax;
    if (data.coldGasMax !== undefined) this.coldGasMax = data.coldGasMax;
    if (data.batteryMax !== undefined) this.batteryMax = data.batteryMax;
    if (data.currentFuelId) this._currentFuelId = data.currentFuelId;
    // F16: Restore lithium (persists between missions — hard to get)
    if (data.lithium !== undefined) this.lithium = data.lithium;
    if (data.lithiumMax !== undefined) this.lithiumMax = data.lithiumMax;
    // S3b: Restore power infrastructure state
    if (data.hasSupercap) this._hasSupercap = true;
    if (data.rtgRate !== undefined) this._rtgRate = data.rtgRate;
    if (data.powerBeamRate !== undefined) this._powerBeamRate = data.powerBeamRate;
    // Refill to max for the new mission
    this.xenon = this.xenonMax;
    this.coldGas = this.coldGasMax;
    this.battery = this.batteryMax;
    this.solarPanelHealth = 1.0;
    this._depletionEmitted = false;
    this._syncToPlayer();
  }

  // ======================================================================
  // PER-FRAME UPDATE
  // ======================================================================

  /**
   * Called every gameplay frame.
   * • Solar recharge
   * • Depletion check
   * @param {number} dt - seconds
   */
  update(dt) {
    // Staleness timer: reset weather multiplier if no WEATHER_ACTIVE for 2s
    this._weatherLastUpdate += dt;
    if (this._weatherLastUpdate > 2.0) {
      this._weatherSolarMult = 1.0;
    }

    // Solar panel recharge (simplified Wh model scaled for gameplay)
    const rechargeRate = this.solarRate * this.solarPanelHealth * this._weatherSolarMult * dt * 0.001;
    if (this.battery < this.batteryMax) {
      this.battery = Math.min(this.batteryMax, this.battery + rechargeRate);
      this._syncToPlayer();
    }

    // S3b: RTG constant recharge (independent of solar / weather)
    if (this._rtgRate > 0 && this.battery < this.batteryMax) {
      this.battery = Math.min(this.batteryMax, this.battery + this._rtgRate * dt);
      this._syncToPlayer();
    }

    // S3b: Power beaming recharge (only during ground station pass)
    if (this._powerBeamRate > 0 && this._groundStationInView && this.battery < this.batteryMax) {
      this.battery = Math.min(this.batteryMax, this.battery + this._powerBeamRate * dt);
      this._syncToPlayer();
    }

    // Gradual solar panel degradation from radiation/micrometeorite damage
    // Base rate: ~5% loss per 10 minutes of real gameplay (600 game-seconds at TIME_SCALE_GAMEPLAY=10)
    const baseDegradRate = 0.00008;
    const degradMultiplier = this.panelDegradationMultiplier || 1.0;
    const actualDegradRate = baseDegradRate * degradMultiplier;
    if (this.solarPanelHealth > 0.3) {
      this.solarPanelHealth = Math.max(0.3, this.solarPanelHealth - actualDegradRate * dt);
      this._syncToPlayer();
    }

    // Depletion → game-over signal (emit once)
    if (
      this.xenon <= 0 &&
      this.coldGas <= 0 &&
      this.battery <= 0 &&
      !this._depletionEmitted
    ) {
      this._depletionEmitted = true;
      eventBus.emit(Events.RESOURCE_DEPLETED, { reason: 'fuel' });
    }

    // Re-arm depletion flag when any resource recovers
    if (this.xenon > 0 || this.coldGas > 0 || this.battery > 0) {
      this._depletionEmitted = false;
    }
  }

  // ======================================================================
  // UPGRADES
  // ======================================================================

  /**
   * Apply a shop upgrade that affects resource pools.
   * @param {object} data - { effect: string, value: number }
   * @returns {boolean} true if the effect was handled
   */
  applyUpgrade(data) {
    switch (data.effect) {
      case 'xenonMax':
        // BUG FIX: was `= Constants.XENON_FUEL_MAX + data.value` (non-cumulative).
        // Now cumulative: buying twice gives base+50+50, not base+50 both times.
        this.xenonMax += data.value;
        this.xenon = Math.min(this.xenon + data.value, this.xenonMax);
        break;
      case 'coldGasMax':
        this.coldGasMax += data.value;
        this.coldGas = Math.min(this.coldGas + data.value, this.coldGasMax);
        break;
      case 'batteryMax':
        this.batteryMax += data.value;
        this.battery = Math.min(this.battery + data.value, this.batteryMax);
        break;
      case 'solarEfficiency':
        // Multiply solar recharge rate by upgrade value (e.g., 1.3 = +30%, 2.0 = +100%)
        this.solarRate = Constants.SOLAR_PANEL_EFFICIENCY * data.value
          * Constants.SOLAR_FLUX * Constants.SOLAR_PANEL_AREA;
        break;
      case 'supercapUpgrade':
        // S3b: Adds burst storage to battery max AND sets thermal flag
        this.batteryMax += data.value;  // +100 Wh
        this.battery = Math.min(this.battery + data.value, this.batteryMax);
        this._hasSupercap = true;
        break;
      case 'rtgPower':
        // S3b: RTG constant generation rate (Wh/s)
        this._rtgRate = data.value;  // 2.0 Wh/s
        break;
      case 'powerBeaming':
        // S3b: Power beaming rate (active during ground station passes)
        this._powerBeamRate = data.value;  // 5.0 Wh/s
        break;
      case 'panelDegradation':
        // Store multiplier used in update() for panel degradation rate
        // value=0.5 → half degradation speed
        this.panelDegradationMultiplier = data.value;
        break;
      default:
        return false; // not a resource upgrade
    }
    this._syncToPlayer();
    eventBus.emit(Events.RESOURCE_UPGRADED, {
      effect: data.effect,
      value: data.value,
    });
    return true;
  }

  // ======================================================================
  // RESET
  // ======================================================================

  /**
   * Reset all resources to starting values (new game / retry).
   */
  reset() {
    this.xenon = Constants.XENON_FUEL_MAX;
    this.coldGas = Constants.COLD_GAS_MAX;
    this.battery = Constants.BATTERY_MAX;
    this.solarPanelHealth = 1.0;
    this.xenonMax = Constants.XENON_FUEL_MAX;
    this.coldGasMax = Constants.COLD_GAS_MAX;
    this.batteryMax = Constants.BATTERY_MAX;
    this.lithium = 0;
    this.lithiumMax = Constants.MPD_LITHIUM_CAPACITY;
    this._depletionEmitted = false;
    this._currentFuelId = Constants.DEFAULT_FUEL || 'xenon';
    this._availableFuels = ['xenon'];
    // S3b: Reset power infrastructure
    this._hasSupercap = false;
    this._rtgRate = 0;
    this._powerBeamRate = 0;
    this._groundStationInView = false;
    clearTimeout(this._gsPassTimer);
    this._syncToPlayer();
  }

  // ======================================================================
  // PRIVATE
  // ======================================================================

  /** @private */
  _isValid(resource) {
    return resource === 'xenon' || resource === 'coldGas' || resource === 'battery' || resource === 'lithium';
  }

  /** @private Push this → player.resources (one-way) */
  _syncToPlayer() {
    if (!this._player) return;
    this._player.resources.xenon = this.xenon;
    this._player.resources.coldGas = this.coldGas;
    this._player.resources.battery = this.battery;
    this._player.resources.solarPanelHealth = this.solarPanelHealth;
    this._player.resources.xenonMax = this.xenonMax;
    this._player.resources.coldGasMax = this.coldGasMax;
    this._player.resources.batteryMax = this.batteryMax;
    this._player.resources.lithium = this.lithium;
    this._player.resources.lithiumMax = this.lithiumMax;
  }

  /** @private Wire EventBus listeners */
  _setupListeners() {
    eventBus.on(Events.RESOURCE_CONSUME, (data) => {
      this.consume(data.resource, data.amount);
    });

    eventBus.on(Events.RESOURCE_REPLENISH, (data) => {
      this.replenish(data.resource, data.amount);
    });

    // Phase 4: Fuel cycling
    eventBus.on(Events.FUEL_CYCLE, () => this.cycleFuel(this._cargoSystem));

    // S3b: Ground station pass tracking for power beaming
    eventBus.on(Events.GROUND_STATION_PASS, () => {
      this._groundStationInView = true;
      // Ground station pass window lasts ~60s (per SubsystemEvents emission)
      // Reset after window expires
      clearTimeout(this._gsPassTimer);
      this._gsPassTimer = setTimeout(() => {
        this._groundStationInView = false;
      }, 60000);
    });
  }
}

export default ResourceSystem;
