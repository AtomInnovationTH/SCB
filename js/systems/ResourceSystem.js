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
import { ThermalSystem } from './ThermalSystem.js';

/**
 * h3-argon-engine D2: kilograms of ENGINE gas aboard — the ONE conversion from the
 * pool (a fill percentage: 100 = one full 60 L base tank) to mass. Reads the gas that
 * is IN THE TANK (`tankGasId`), never the active fuel (a cargo fuel has no `kgFull`).
 * @param {{xenon?: number, tankGasId?: string}} res - ResourceSystem or player.resources
 * @returns {number} kg
 */
export function engineGasKg(res) {
  const fuels = Constants.FUELS || {};
  const id = (res && res.tankGasId) || Constants.DEFAULT_FUEL;
  const fuel = fuels[id] || fuels[Constants.DEFAULT_FUEL];
  const kgFull = fuel && Number.isFinite(fuel.kgFull) ? fuel.kgFull : 0;
  const pool = res && Number.isFinite(res.xenon) ? res.xenon : 0;
  return Math.max(0, pool) / 100 * kgFull;
}

/**
 * g1-gas-upgrades D1: price of `kg` kilograms of engine gas, credits — priced by what it costs to
 * LAUNCH the mass (every kilo about the same, research §3) plus the gas itself (research §2.4).
 * Rounded to 10 cr. Used by the upgrade rows, the resupply and the shop's price accessor.
 * @param {string} gasId - 'argon' | 'krypton' | 'xenon'
 * @param {number} kg
 * @returns {number} credits
 */
export function gasPriceCr(gasId, kg) {
  const fuels = Constants.FUELS || {};
  const fuel = fuels[gasId] || fuels[Constants.DEFAULT_FUEL];
  const perKg = Constants.LAUNCH_USD_PER_KG + (fuel && Number.isFinite(fuel.usdPerKg) ? fuel.usdPerKg : 0);
  return Math.round(Math.max(0, kg) * perKg / Constants.USD_PER_CREDIT / 10) * 10;
}

/** g1-gas-upgrades D2: the mass of engine gas every launch carries, whatever the gas or tank — 12.48 kg
 *  (today's 60 % of the base argon tank). Derived, never typed. */
export const START_GAS_KG = Constants.PROPELLANT_START_FRACTION * Constants.FUELS[Constants.DEFAULT_FUEL].kgFull;
/** g1-gas-upgrades D3: what a gas switch fills the tank with (the same launch mass). */
export const GAS_SWITCH_FILL_KG = START_GAS_KG;

/** g1-gas-upgrades D3: argon < krypton < xenon — a gas switch only goes up. */
const GAS_RANK = { argon: 0, krypton: 1, xenon: 2 };

/**
 * g1-gas-upgrades D2: the engine pool (a percentage of the base 60 L tank, as everywhere) that holds
 * min(START_GAS_KG, capacity) kg of `tankGasId`. On the base argon tank this is exactly 60.
 * @param {string} tankGasId
 * @param {number} xenonMax - pool capacity
 * @returns {number} pool units
 */
export function startEnginePool(tankGasId, xenonMax) {
  const fuels = Constants.FUELS || {};
  const def = fuels[Constants.DEFAULT_FUEL];
  const fuel = fuels[tankGasId] || def;
  const frac = Constants.PROPELLANT_START_FRACTION;
  const f = Number.isFinite(frac) ? Math.max(0, Math.min(1, frac)) : 1;
  const pool = f * 100 * (def.kgFull / fuel.kgFull);   // START_GAS_KG / kgFull × 100, exact for the default gas
  return Math.min(pool, Number.isFinite(xenonMax) ? xenonMax : Constants.XENON_FUEL_MAX);
}

/**
 * g1-gas-upgrades D4: free space in the engine tank, kg of the gas IN the tank.
 * @param {{xenon?: number, xenonMax?: number, tankGasId?: string}} res
 * @returns {number} kg
 */
export function engineTankFreeKg(res) {
  const fuels = Constants.FUELS || {};
  const fuel = fuels[(res && res.tankGasId) || Constants.DEFAULT_FUEL] || fuels[Constants.DEFAULT_FUEL];
  const max = res && Number.isFinite(res.xenonMax) ? res.xenonMax : Constants.XENON_FUEL_MAX;
  const pool = res && Number.isFinite(res.xenon) ? res.xenon : 0;
  return Math.max(0, max - pool) / 100 * fuel.kgFull;
}

/**
 * g1-gas-upgrades D6: dry mass of the engine tank itself — it follows the tank's size (the Bigger Engine Tank).
 * @param {{xenonMax?: number}} res - ResourceSystem or player.resources
 * @returns {number} kg
 */
export function engineTankDryKg(res) {
  const max = res && Number.isFinite(res.xenonMax) ? res.xenonMax : Constants.XENON_FUEL_MAX;
  return Constants.ENGINE_TANK_DRY_MASS_KG * max / Constants.XENON_FUEL_MAX;
}

/**
 * g1-gas-upgrades D7: "how full is the engine tank", by MASS and the same for every gas — against the
 * base argon tank scaled by the tank's size. On argon it is exactly xenon / xenonMax; xenon's 12.48 kg
 * reads 0.6 (12.48 / 20.8), not 9.7 % of its own 129 kg tank. Every low warning / bar / alarm reads this.
 * @param {{xenon?: number, xenonMax?: number, tankGasId?: string}} res - ResourceSystem or player.resources
 * @returns {number} 0..1
 */
export function engineGasLowFrac(res) {
  const def = (Constants.FUELS || {})[Constants.DEFAULT_FUEL];
  const max = res && Number.isFinite(res.xenonMax) ? res.xenonMax : Constants.XENON_FUEL_MAX;
  const ref = def.kgFull * max / Constants.XENON_FUEL_MAX;
  return ref > 0 ? Math.max(0, Math.min(1, engineGasKg(res) / ref)) : 0;
}

/**
 * h3-argon-engine D4: the ONE Tsiolkovsky formula for the Hall engine. Cold gas is CARRIED, not
 * burned by this engine, so it sits in both the loaded and the empty mass.
 *   ΔV = (Isp / c) · g0 · ln((dry + coldGas + gas) / (dry + coldGas))
 * @param {object} a
 * @param {number} a.dryKg      - everything that is not a gas (core, tank, struts, arms, cargo), kg
 * @param {number} a.coldGasKg  - cold gas aboard (carried), kg
 * @param {number} a.gasKg      - engine gas aboard (burned), kg
 * @param {number} a.isp        - the ACTIVE fuel's Isp, s
 * @param {number} [a.c=1]      - consumption multiplier (shop upgrade x power split; an Isp gain)
 * @returns {number} m/s (0 when there is nothing to burn)
 */
export function engineDeltaV({ dryKg, coldGasKg = 0, gasKg, isp, c = 1 }) {
  const carried = (dryKg || 0) + (coldGasKg || 0);
  if (!(carried > 0) || !(gasKg > 0) || !(isp > 0)) return 0;
  return (isp / (c > 0 ? c : 1)) * Constants.G0 * Math.log((carried + gasKg) / carried);
}

export class ResourceSystem {
  constructor() {
    // ── Resource pools (canonical — synced to player.resources) ──────────
    // h3-argon-engine D2: `xenon` / `xenonMax` are POOL names kept for compatibility — the pool holds
    // whichever gas is in the tank (`tankGasId`), as a fill percentage (100 = one full 60 L base tank).
    this.xenon = 0;   // filled below, once xenonMax and tankGasId exist (g1-gas-upgrades D2)
    this.coldGas = ResourceSystem.startPropellant(Constants.COLD_GAS_MAX);
    // w4-power D1: every boot starts at BATTERY_START_FRACTION (half) of the max.
    this.battery = ResourceSystem.startCharge(Constants.BATTERY_MAX);
    this.solarPanelHealth = 1.0;
    // Mother-wings step 4 (DECISIONS §10, "power follows the panels"): the
    // body-mount cells are backup power and get their OWN health, independent
    // of the wings — damageSolarPanel() (collision/impact) and the passive
    // radiation/MMOD degrade below both stay wing-only (`solarPanelHealth`);
    // nothing degrades this today, so the body keeps working when the wings
    // are damaged, furled or edge-on.
    this.bodyPanelHealth = 1.0;

    // ── Lithium (F16: MPD thruster propellant) ──────────────────────────
    this.lithium = 0;                                // starts empty — must salvage
    this.lithiumMax = Constants.MPD_LITHIUM_CAPACITY; // 100 units

    // ── Derived rates ───────────────────────────────────────────────────
    // Fallback-only rate: used by update()'s rechargeRate when no live player
    // is wired (menu hero, headless tests) — PlayerSatellite._updateSolarPower
    // computes the REAL per-frame rate (real per-wing/per-cell area ×
    // incidence × furl × shading × health) into player.resources.solarRate,
    // and update() prefers that when it's available. Constants.SOLAR_PANEL_AREA
    // is now the real total built area (mother-wings step 4), not a generic
    // placeholder, so this fallback is a believable ceiling rather than a
    // separate invented number.
    this.solarRate =
      Constants.SOLAR_PANEL_EFFICIENCY *
      Constants.SOLAR_FLUX *
      Constants.SOLAR_PANEL_AREA;
    // Shop solarEfficiency upgrade multiplier — read by the REAL per-frame
    // calc too (synced to player.resources.solarEfficiencyMult below), so the
    // upgrade still works under the new area-based model.
    this.solarEfficiencyMult = 1.0;

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
    // `tankGasId` = the gas IN the engine tank (saved); `_currentFuelId` = the ACTIVE fuel, which may be a
    // cargo fuel (aluminum…) while the tank gas stays put. Cargo depletion falls back to the tank gas.
    this.tankGasId = Constants.DEFAULT_FUEL || 'argon';
    this._currentFuelId = this.tankGasId;
    this._availableFuels = [this.tankGasId]; // always have the tank gas; others added dynamically
    // g1-gas-upgrades D2: every launch carries START_GAS_KG of the tank gas (h1-mother-pane D5: 60 % of argon)
    this.xenon = startEnginePool(this.tankGasId, this.xenonMax);
    this._cargoSystem = null;
    /** h3b-argon-push D5: true once FUEL_CHANGED { initial: true } has named the loaded fuel to the readers. */
    this._fuelAnnounced = false;

    // ── Player entity reference (set via setPlayer) ─────────────────────
    /** @type {object|null} */
    this._player = null;

    // ── Depletion guard (emit only once per depletion) ──────────────────
    this._depletionEmitted = false;

    /** @type {number} Weather-based solar power multiplier (0 = eclipse, 1.3 = flare boost) */
    this._weatherSolarMult = 1.0;

    /** @type {number} Seconds since last WEATHER_ACTIVE event */
    this._weatherLastUpdate = 0;

    // ── Power ledger (w2-heat D1, DECISIONS §15 row 5: "battery … charging or
    // draining, the cost of each action") ─────────────────────────────────
    // Cumulative totals in battery units, monotonic for the life of the
    // instance (never reset — ThermalSystem reads the drawn total as a running
    // counter and takes the delta each tick, so no draw is lost or counted
    // twice whatever the frame order). OUT = every battery draw: consume(),
    // drainBattery(), drawUpTo(). IN = charging actually stored by update()
    // (solar + RTG + beaming; a full battery stores 0). replenish() (salvage /
    // refinery battery) and upgrade top-ups are NOT charging and are excluded.
    this._ledgerOutUnits = 0;
    this._ledgerInUnits = 0;
    /** @private units since the last update() — turned into watts there */
    this._frameOutUnits = 0;
    /** @private */
    this._frameInUnits = 0;
    /** @private smoothed watts (HUD scale — same as the `SUN n W` readout) */
    this._inW = 0;
    /** @private */
    this._outW = 0;
    /** @type {object|null} ThermalSystem (or any { getSnapshot, reset }) — setThermalSource() */
    this._thermalSource = null;

    // Listen for weather effects on solar power
    eventBus.on(Events.WEATHER_ACTIVE, (effects) => {
      this._weatherSolarMult = effects.solarPower ?? 1.0;
      this._weatherLastUpdate = 0;
    });

    this._setupListeners();
  }

  /**
   * w4-power D1 (owner 2026-10-12: "battery is 50% and dropping until wings
   * open"): the charge every boot starts with — BATTERY_START_FRACTION of `max`.
   * @param {number} max - the (rebased) battery max, Wh
   * @returns {number} Wh
   */
  static startCharge(max) {
    const f = Constants.BATTERY_START_FRACTION;
    const frac = Number.isFinite(f) ? Math.max(0, Math.min(1, f)) : 1;
    return max * frac;
  }

  /**
   * h1-mother-pane D5 (owner 2026-10-14: "only 60% full"): the level a tank
   * (engine propellant or cold gas) starts a boot at — new game, retry, CONTINUE.
   * @param {number} max - the tank's max, kg
   * @returns {number} kg
   */
  static startPropellant(max) {
    const f = Constants.PROPELLANT_START_FRACTION;
    const frac = Number.isFinite(f) ? Math.max(0, Math.min(1, f)) : 1;
    return max * frac;
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
    if (resource === 'battery') this._recordDraw(amount);
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
   * Health is clamped to [0, 1.0]. Mother-wings step 4: this is the WING
   * (ROSA) health — `bodyPanelHealth` (backup power) has no damage/repair path
   * today by design (DECISIONS §10: it must keep working when the wings don't).
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
   * Apply impact damage to the solar panels (D2 glancing-collision consequence).
   * Floors at 0.1 so a hit degrades but never fully destroys the array (some
   * recharge always remains). Distinct from passive degradation (floors at 0.3).
   * Mother-wings step 4 (DECISIONS §10 — "Rosa might get damaged by collision
   * or player mistakes"): this is the exact mechanism the owner meant. It hits
   * the WING (ROSA) health only — `bodyPanelHealth` (backup power) is
   * untouched, so a collision can never zero out the body's own contribution.
   * @param {number} fraction - health lost, e.g. 0.12
   */
  damageSolarPanel(fraction) {
    if (!(fraction > 0)) return;
    this.solarPanelHealth = Math.max(0.1, this.solarPanelHealth - fraction);
    this._syncToPlayer();
    eventBus.emit(Events.RESOURCE_CHANGED, {
      resource: 'solarPanelHealth',
      value: this.solarPanelHealth,
      delta: -fraction,
    });
  }

  /**
   * Drain battery by up to `amount` Wh (D2 glancing-collision consequence).
   * Unlike consume(), this never fails — it drains whatever is available and
   * clamps at 0 (a hit drains what it can).
   * @param {number} amount - Wh to drain
   */
  drainBattery(amount) {
    if (!(amount > 0)) return;
    const drained = Math.min(amount, this.battery);
    this.battery -= drained;
    this._recordDraw(drained);
    this._syncToPlayer();
    eventBus.emit(Events.RESOURCE_CHANGED, {
      resource: 'battery',
      value: this.battery,
      delta: -drained,
    });
  }

  /**
   * Draw up to `amount` from a named resource, clamped at what the pool
   * actually holds (engines on an empty battery, 2026-09-25: consume()'s
   * all-or-nothing refusal silently rejected an electric burn's draw once
   * the battery parked below one frame's need — thrust was applied for
   * free). Like drainBattery(), this never fails: it takes what is there
   * and reports how much that was, so the caller can scale honestly.
   * @param {string} resource - 'xenon' | 'coldGas' | 'battery' | 'lithium'
   * @param {number} amount - desired draw (> 0)
   * @returns {number} the amount actually drawn (0 .. amount)
   */
  drawUpTo(resource, amount) {
    if (!this._isValid(resource) || !(amount > 0)) return 0;
    const drawn = Math.min(amount, Math.max(0, this[resource]));
    if (drawn <= 0) return 0;
    this[resource] -= drawn;
    if (resource === 'battery') this._recordDraw(drawn);
    this._syncToPlayer();
    eventBus.emit(Events.RESOURCE_CHANGED, {
      resource,
      value: this[resource],
      delta: -drawn,
    });
    return drawn;
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
    return Constants.FUELS[this._currentFuelId] || Constants.FUELS[this.tankGasId] || Constants.FUELS[Constants.DEFAULT_FUEL];
  }

  /**
   * h3b-argon-push D5: name the loaded fuel to every reader. FUEL_CHANGED was only ever sent on a change,
   * so CommsSystem / StatusPanel named the DEFAULT fuel until the first change — wrong after a load that
   * brings krypton or xenon. This sends it with `initial: true` at the first frame of play, after a load
   * (restore) and after a new game / retry (reset). Listeners that treat FUEL_CHANGED as a player action
   * (the cycle tone, the codex entry) skip `initial`.
   */
  announceFuel() {
    const fuel = this.getCurrentFuel();
    this._fuelAnnounced = true;
    eventBus.emit(Events.FUEL_CHANGED, {
      fuelId: fuel.id,
      name: fuel.name,
      isp: fuel.isp,
      color: fuel.color,
      thrustScale: fuel.thrustScale,
      initial: true,
    });
  }

  /**
   * Get current fuel ID.
   * @returns {string}
   */
  getCurrentFuelId() {
    return this._currentFuelId;
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
      // Fuel depleted — auto-switch back to the gas in the tank (h3-argon-engine D6: was a hard-coded xenon)
      const tank = Constants.FUELS[this.tankGasId] || Constants.FUELS[Constants.DEFAULT_FUEL];
      eventBus.emit(Events.FUEL_DEPLETED, { fuelId: this._currentFuelId, name: fuel.name });
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'PROPULSION',
        text: `${fuel.name} depleted. Switching to ${tank.name}`,
        priority: 'warning',
      });
      this._currentFuelId = tank.id;
      eventBus.emit(Events.FUEL_CHANGED, {
        fuelId: tank.id,
        name: tank.name,
        isp: tank.isp,
        color: tank.color,
        thrustScale: tank.thrustScale,
      });
      return false;
    }

    cs.removeMetal(fuel.cargoMetalId, amount);
    return true;
  }

  /**
   * Weather-based solar power multiplier: 0 in eclipse, 1.0 nominal, 1.3 flare
   * (cargo-continuity S8 — the digestion sun gate reads this).
   * @returns {number}
   */
  getSolarPowerMultiplier() {
    return this._weatherSolarMult;
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
      bodyPanelHealth: this.bodyPanelHealth,   // mother-wings step 4
      currentFuelId: this._currentFuelId,
      tankGasId: this.tankGasId,
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

  // ======================================================================
  // POWER LEDGER + THERMAL SOURCE (w2-heat D1 / D3 — the meters' contract)
  // ======================================================================

  /**
   * The battery meter's numbers (w2-meters codes against this shape).
   * Watts are on the HUD's `SUN n W` scale (battery units per real second ×
   * SHIP_HEAT.W_PER_UNIT_S) and smoothed over ~POWER_TAU_S (0.5 s).
   * `inW` = charging actually stored (solar + RTG + beaming; 0 surplus when
   * full — replenish()/salvage and upgrade top-ups are not charging);
   * `outW` = every battery draw; `netW = inW − outW`; `genW` = this frame's
   * generation, unsmoothed (getGenerationW — w4-power D4). A fresh object per call.
   * @returns {{battery:number, batteryMax:number, inW:number, outW:number, netW:number, genW:number}}
   */
  getPowerSnapshot() {
    return {
      battery: this.battery,
      batteryMax: this.batteryMax,
      inW: this._inW,
      outW: this._outW,
      netW: this._inW - this._outW,
      genW: this.getGenerationW(),
    };
  }

  /**
   * w4-power D4 (owner 2026-10-12: "rotating mother should show immediate
   * drop in power-in"): what the ship generates THIS frame, unsmoothed, on the
   * meter's watt scale — the live per-frame rate PlayerSatellite._updateSolarPower
   * writes (× the weather multiplier, exactly what update() charges with), plus
   * RTG and beaming when fitted. Unlike `inW` it does not drop to 0 when the
   * battery is full: it is what the panels make, stored or not. Falls back to
   * the static rate when no live player is wired (as update() does).
   * @returns {number} watts
   */
  getGenerationW() {
    const wPerUnitS = Constants.SHIP_HEAT.W_PER_UNIT_S;
    const liveRate = this._player && this._player.resources && this._player.resources.solarRate;
    const solarW = (typeof liveRate === 'number')
      ? liveRate * this._weatherSolarMult
      : this.solarRate * this.solarPanelHealth * this._weatherSolarMult;
    let w = Number.isFinite(solarW) ? Math.max(0, solarW) : 0;
    if (this._rtgRate > 0) w += this._rtgRate * wPerUnitS;
    if (this._powerBeamRate > 0 && this._groundStationInView) w += this._powerBeamRate * wPerUnitS;
    return w;
  }

  /**
   * w4-power D5/D7: bill `watts` for `dt` real seconds — a motor or heater
   * that is running this frame. The base load's own conversion (units = W ÷
   * SHIP_HEAT.W_PER_UNIT_S × dt, PlayerSatellite._updateResources), so a 15 W
   * motor shows as +15 W in `outW`; drawn through drawUpTo (never fails, clamps
   * at empty), so it lands in the ledger and its heat follows (ThermalSystem).
   * @param {number} watts
   * @param {number} dt - real seconds
   * @returns {number} the battery units actually drawn
   */
  billWatts(watts, dt) {
    if (!(watts > 0) || !(dt > 0)) return 0;
    return this.drawUpTo('battery', (watts / Constants.SHIP_HEAT.W_PER_UNIT_S) * dt);
  }

  /**
   * Cumulative battery units drawn since this instance was built (monotonic —
   * every consume('battery') / drainBattery() / drawUpTo('battery')). The
   * ThermalSystem's heat input: it takes the delta each tick.
   * @returns {number}
   */
  getEnergyDrawnUnits() { return this._ledgerOutUnits; }

  /**
   * Cumulative battery units of charging actually stored (monotonic).
   * @returns {number}
   */
  getEnergyChargedUnits() { return this._ledgerInUnits; }

  /**
   * Register the heat source the meters read through getThermalSnapshot()
   * (ThermalSystem calls this on itself). reset()/restore() reset it too —
   * heat restarts with the battery on new game / retry / a fresh mission.
   * @param {{ getSnapshot: function(): object, reset?: function(): void }|null} source
   */
  setThermalSource(source) { this._thermalSource = source || null; }

  /** @returns {object|null} the registered thermal source (the loop ticks it). */
  getThermalSource() { return this._thermalSource; }

  /**
   * The heat meter's numbers, or null when no thermal source is registered.
   * @returns {{tempC:number, band:'green'|'yellow'|'red', trend:-1|0|1, autoOpened:boolean}|null}
   */
  getThermalSnapshot() {
    const src = this._thermalSource;
    return (src && typeof src.getSnapshot === 'function') ? src.getSnapshot() : null;
  }

  /**
   * Build the ship's ThermalSystem bound to this ledger and `player`, and
   * register it. A factory here so main.js wires it in its two assigned lines
   * without a new import (lane w2-heat file ownership). Idempotent: a second
   * call disposes the first source.
   * @param {object} player - PlayerSatellite (getFlowerStatus / setFlowerPose / _inShadow)
   * @returns {ThermalSystem}
   */
  createThermalSystem(player) {
    if (this._thermalSource && typeof this._thermalSource.dispose === 'function') {
      this._thermalSource.dispose();
    }
    return new ThermalSystem({ resourceSystem: this, player });
  }

  /** @private one battery draw → the ledger */
  _recordDraw(units) {
    if (!(units > 0)) return;
    this._ledgerOutUnits += units;
    this._frameOutUnits += units;
  }

  /**
   * A held-world frame (a drawer is open — main.js `_worldHeld`): update() is
   * not called, but player.update still bills the base load. Drop this
   * frame's units so they never land as one spike on release; the smoothed
   * watts stay frozen at their pre-hold values. (The cumulative totals keep
   * counting — ThermalSystem.skipHeld re-syncs its counter past them.)
   */
  discardHeldFrame() {
    this._frameOutUnits = 0;
    this._frameInUnits = 0;
  }

  /** @private this frame's units → smoothed watts (EMA, τ = POWER_TAU_S) */
  _smoothLedger(dt) {
    if (!(dt > 0)) return;
    const SH = Constants.SHIP_HEAT;
    const k = SH.W_PER_UNIT_S / dt;
    const a = 1 - Math.exp(-dt / SH.POWER_TAU_S);
    this._inW += (this._frameInUnits * k - this._inW) * a;
    this._outW += (this._frameOutUnits * k - this._outW) * a;
    this._frameInUnits = 0;
    this._frameOutUnits = 0;
  }

  /** @private zero the smoothed watts (cumulative totals stay monotonic) */
  _resetLedgerRates() {
    this._frameInUnits = 0;
    this._frameOutUnits = 0;
    this._inW = 0;
    this._outW = 0;
  }

  /** @private heat restarts with the battery */
  _resetThermal() {
    const src = this._thermalSource;
    if (src && typeof src.reset === 'function') src.reset();
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
      tankGasId: this.tankGasId,   // h3-argon-engine D6: the gas in the tank survives reloads
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
   * Refills xenon / cold gas to the restored max for a fresh mission; the
   * battery starts at BATTERY_START_FRACTION of its rebased max (w4-power D1 —
   * saves carry no charge, and every boot starts packed at half).
   * @param {object} data - Previously serialized resource maxes
   */
  restore(data) {
    if (!data) return;
    if (data.xenonMax !== undefined) this.xenonMax = data.xenonMax;
    if (data.coldGasMax !== undefined) this.coldGasMax = data.coldGasMax;
    if (data.batteryMax !== undefined) {
      // 2026-09-24: the base battery grew 100 -> 600 Wh (the ship's own spec).
      // Legacy saves carry 100 + bought upgrades; carry the upgrades across by
      // rebasing them onto the new base. New saves (>= the new base) pass
      // through unchanged. Upgrade effects do not re-apply on load
      // (RESOURCE_RESTORED_EFFECTS), so this saved absolute is the only source.
      const BASE_OLD = 100, BASE_NEW = Constants.BATTERY_MAX;
      this.batteryMax = (data.batteryMax < BASE_NEW)
        ? BASE_NEW + (data.batteryMax - BASE_OLD)
        : data.batteryMax;
    }
    // h3-argon-engine D6: an old save has no tankGasId (its tank held xenon-named gas at the same fill
    // fraction) -> the tank becomes the default (argon) and so does the active fuel. A new save keeps both
    // (the active fuel may be a cargo fuel). A saved gas this build does not know falls back to the default.
    const savedTank = Constants.FUELS[data.tankGasId];
    if (data.tankGasId !== undefined && savedTank && !savedTank.fromCargo) {
      this.tankGasId = data.tankGasId;
      if (data.currentFuelId && Constants.FUELS[data.currentFuelId]) this._currentFuelId = data.currentFuelId;
      else this._currentFuelId = this.tankGasId;
    } else {
      this.tankGasId = Constants.DEFAULT_FUEL;
      this._currentFuelId = this.tankGasId;
    }
    this._availableFuels = [this.tankGasId];
    // F16: Restore lithium (persists between missions — hard to get)
    if (data.lithium !== undefined) this.lithium = data.lithium;
    if (data.lithiumMax !== undefined) this.lithiumMax = data.lithiumMax;
    // S3b: Restore power infrastructure state
    if (data.hasSupercap) this._hasSupercap = true;
    if (data.rtgRate !== undefined) this._rtgRate = data.rtgRate;
    if (data.powerBeamRate !== undefined) this._powerBeamRate = data.powerBeamRate;
    // Refill to max for the new mission (the battery: half — w4-power D1)
    this.xenon = startEnginePool(this.tankGasId, this.xenonMax);   // g1-gas-upgrades D2: the same kg, any gas
    this.coldGas = ResourceSystem.startPropellant(this.coldGasMax);
    this.battery = ResourceSystem.startCharge(this.batteryMax);
    this.solarPanelHealth = 1.0;
    this.bodyPanelHealth = 1.0;
    this._depletionEmitted = false;
    this._resetLedgerRates();   // w2-heat: a fresh mission — meters and heat restart
    this._resetThermal();
    this._syncToPlayer();
    this.announceFuel();   // h3b-argon-push D5: the loaded fuel, named from the first frame
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
    // h3b-argon-push D5: boot — no restore()/reset() has named the fuel yet; the HUD listeners exist by now
    if (!this._fuelAnnounced) this.announceFuel();
    // Staleness timer: reset weather multiplier if no WEATHER_ACTIVE for 2s
    this._weatherLastUpdate += dt;
    if (this._weatherLastUpdate > 2.0) {
      this._weatherSolarMult = 1.0;
    }

    // Solar panel recharge (simplified Wh model scaled for gameplay).
    // Mother-wings step 4 (DECISIONS §10, "power follows the panels, realistic
    // wins"): prefer the REAL per-frame rate PlayerSatellite._updateSolarPower
    // computes (real per-wing/per-cell area × incidence × furl × shading, with
    // wing/body health already applied separately — see its docstring). That
    // rate already reflects eclipse, tilt, shading, furl and BOTH health
    // splits, so it is used as-is here (no extra ×solarPanelHealth — that
    // would double the wing-health penalty and wrongly apply it to the body's
    // share too). Falls back to the generic static `this.solarRate` (still
    // gated by wing health, the pre-existing behaviour) when no live player is
    // wired — menu hero, or a bare ResourceSystem in a unit test.
    const liveRate = this._player && this._player.resources && this._player.resources.solarRate;
    const rechargeRate = (typeof liveRate === 'number')
      ? liveRate * this._weatherSolarMult * dt * 0.001
      : this.solarRate * this.solarPanelHealth * this._weatherSolarMult * dt * 0.001;
    // w2-heat D1: charging actually stored this frame (solar + RTG + beaming
    // below) — a full battery stores nothing, so its surplus is never "in".
    const batteryBeforeCharge = this.battery;
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

    const charged = this.battery - batteryBeforeCharge;
    if (charged > 0) {
      this._ledgerInUnits += charged;
      this._frameInUnits += charged;
    }
    this._smoothLedger(dt);

    // Gradual solar panel degradation from radiation/micrometeorite damage.
    // Mother-wings step 4: this is the WING (ROSA) health specifically — the
    // large, thin, exposed blanket is what collision/MMOD/radiation realistically
    // wears down first. `bodyPanelHealth` (compact, recessed body-mount cells,
    // backup power) is deliberately NOT degraded here or anywhere else today.
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
  // ENGINE GAS (g1-gas-upgrades)
  // ======================================================================

  /**
   * g1-gas-upgrades D3: change the gas IN the tank to a better one (argon < krypton < xenon). What is left is
   * vented (gone); the tank is filled with `kg` of the new gas (clamped to capacity). Refused for a gas ranked
   * at or below the tank's, so a replay in any order never downgrades.
   * @param {string} gasId
   * @param {number} kg
   * @returns {boolean} true if the switch happened
   */
  switchEngineGas(gasId, kg) {
    const fuel = Constants.FUELS[gasId];
    if (!fuel || fuel.fromCargo || !(gasId in GAS_RANK)) return false;
    if (GAS_RANK[gasId] <= (GAS_RANK[this.tankGasId] ?? -1)) return false;
    const wasActive = this._currentFuelId === this.tankGasId;   // a cargo fuel stays active
    this.tankGasId = gasId;
    if (wasActive) this._currentFuelId = gasId;
    this._availableFuels = [this.tankGasId];
    this.xenon = Math.min(Math.max(0, kg) / fuel.kgFull * 100, this.xenonMax);
    this._depletionEmitted = false;
    this._syncToPlayer();
    const active = this.getCurrentFuel();
    eventBus.emit(Events.FUEL_CHANGED, {
      fuelId: active.id,
      name: active.name,
      isp: active.isp,
      color: active.color,
      thrustScale: active.thrustScale,
    });
    eventBus.emit(Events.RESOURCE_UPGRADED, { effect: 'engineGasSwitch', value: gasId });
    return true;
  }

  /**
   * g1-gas-upgrades D4: load up to `kg` of the gas in the tank, limited by free tank space.
   * Also the path salvaged gas takes (D8).
   * @param {number} kg
   * @returns {number} kg actually loaded (0 when the tank is full: free < 0.1 kg)
   */
  resupplyEngineGas(kg) {
    const free = engineTankFreeKg(this);
    if (free < 0.1 || !(kg > 0)) return 0;
    const add = Math.min(kg, free);
    const fuel = Constants.FUELS[this.tankGasId] || Constants.FUELS[Constants.DEFAULT_FUEL];
    this.xenon = Math.min(this.xenonMax, this.xenon + add / fuel.kgFull * 100);
    this._depletionEmitted = false;
    this._syncToPlayer();
    eventBus.emit(Events.RESOURCE_UPGRADED, { effect: 'engineGasResupply', value: add });
    return add;
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
        // g1-gas-upgrades D6: a bigger tank is SPACE, not gas — it raises the max only (fill it with a resupply)
        this.xenonMax += data.value;
        break;
      case 'engineGasSwitch':
        if (!this.switchEngineGas(data.value, GAS_SWITCH_FILL_KG)) return false;
        return true;   // switchEngineGas synced, emitted FUEL_CHANGED and RESOURCE_UPGRADED itself
      case 'engineGasResupply':
        if (this.resupplyEngineGas(data.value) <= 0) return false;
        return true;
      case 'coldGasMax':
        this.coldGasMax += data.value;
        this.coldGas = Math.min(this.coldGas + data.value, this.coldGasMax);
        break;
      case 'batteryMax':
        this.batteryMax += data.value;
        this.battery = Math.min(this.battery + data.value, this.batteryMax);
        break;
      case 'solarEfficiency':
        // Multiply solar recharge rate by upgrade value (e.g., 1.3 = +30%, 2.0 = +100%).
        // Mother-wings step 4: this now feeds the REAL per-frame calc via
        // solarEfficiencyMult (synced to player.resources); solarRate is kept
        // in step too, as the fallback rate for when no live player is wired.
        this.solarEfficiencyMult = data.value;
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
    this.coldGas = ResourceSystem.startPropellant(Constants.COLD_GAS_MAX);
    this.battery = ResourceSystem.startCharge(Constants.BATTERY_MAX);   // w4-power D1: half
    this.solarPanelHealth = 1.0;
    this.bodyPanelHealth = 1.0;
    this.solarEfficiencyMult = 1.0;
    this.xenonMax = Constants.XENON_FUEL_MAX;
    this.coldGasMax = Constants.COLD_GAS_MAX;
    this.batteryMax = Constants.BATTERY_MAX;
    this.lithium = 0;
    this.lithiumMax = Constants.MPD_LITHIUM_CAPACITY;
    this._depletionEmitted = false;
    this.tankGasId = Constants.DEFAULT_FUEL || 'argon';
    this._currentFuelId = this.tankGasId;
    this._availableFuels = [this.tankGasId];
    this.xenon = startEnginePool(this.tankGasId, this.xenonMax);   // g1-gas-upgrades D2: after xenonMax and tankGasId
    // S3b: Reset power infrastructure
    this._hasSupercap = false;
    this._rtgRate = 0;
    this._powerBeamRate = 0;
    this._groundStationInView = false;
    clearTimeout(this._gsPassTimer);
    this._resetLedgerRates();   // w2-heat: heat restarts with the battery (new game / retry)
    this._resetThermal();
    this._syncToPlayer();
    this.announceFuel();   // h3b-argon-push D5: the default fuel, named from the first frame
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
    this._player.resources.bodyPanelHealth = this.bodyPanelHealth;      // mother-wings step 4
    this._player.resources.solarEfficiencyMult = this.solarEfficiencyMult; // mother-wings step 4
    this._player.resources.xenonMax = this.xenonMax;
    this._player.resources.tankGasId = this.tankGasId;   // h3-argon-engine D2: which gas the pool holds
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
