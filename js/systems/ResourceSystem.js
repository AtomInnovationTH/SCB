/**
 * ResourceSystem.js — centralized resource/inventory management (CANONICAL OWNER): fuel (xenon propellant), cold gas
 * (RCS), battery charge, solar recharge, and resource upgrade effects.
 *
 * One-way push to PlayerSatellite.resources via _syncToPlayer() so the HUD and other readers can read player.resources.
 * All consumption flows through eventBus → ResourceSystem.consume().
 *
 * @module systems/ResourceSystem
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { ThermalSystem } from './ThermalSystem.js';
import { clamp01 } from '../core/MathUtil.js';

/**
 * Kilograms of ENGINE gas aboard: the ONE conversion from the pool (a fill percentage: 100 = one full 60 L base tank)
 * to mass. Reads the gas IN THE TANK (`tankGasId`), never the active fuel (a cargo fuel has no `kgFull`).
 * @param {{xenon?: number, tankGasId?: string}} res - ResourceSystem or player.resources
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
 * Price of `kg` kilograms of engine gas, credits: priced by what it costs to LAUNCH the mass (every kilo about the
 * same, research §3) plus the gas itself (research §2.4). Rounded to 10 cr. Used by the upgrade rows, the resupply and
 * the shop's price accessor.
 * @param {string} gasId - 'argon' | 'krypton' | 'xenon'
 */
export function gasPriceCr(gasId, kg) {
  const fuels = Constants.FUELS || {};
  const fuel = fuels[gasId] || fuels[Constants.DEFAULT_FUEL];
  const perKg = Constants.LAUNCH_USD_PER_KG + (fuel && Number.isFinite(fuel.usdPerKg) ? fuel.usdPerKg : 0);
  return Math.round(Math.max(0, kg) * perKg / Constants.USD_PER_CREDIT / 10) * 10;
}

/**
 * Price of `kg` kilograms of nitrogen cold gas, credits: the same launch-mass rule as gasPriceCr with the nitrogen
 * commodity price (`Constants.DAUGHTER_SUPPLY.N2_USD_PER_KG`, an estimate kept OUT of `Constants.FUELS`, which every
 * reader treats as the engine-gas list). Rounded to 10 cr.
 */
export function coldGasPriceCr(kg) {
  const S = Constants.DAUGHTER_SUPPLY;
  const perKg = Constants.LAUNCH_USD_PER_KG + S.N2_USD_PER_KG;
  return Math.round(Math.max(0, kg) * perKg / Constants.USD_PER_CREDIT / 10) * 10;
}

/**
 * Price of one ion-fuel cartridge (or `kg` of indium), credits: the launch-mass rule with the indium commodity price
 * (`Constants.DAUGHTER_SUPPLY.INDIUM_USD_PER_KG`, an estimate). Rounded to 1 cr (a 10 cr step would misprice a small cartridge).
 * @param {number} [kg] default: one cartridge
 */
export function indiumCartridgePriceCr(kg) {
  const S = Constants.DAUGHTER_SUPPLY;
  const k = Number.isFinite(kg) ? kg : S.INDIUM_CARTRIDGE_KG;
  return Math.round(Math.max(0, k) * (Constants.LAUNCH_USD_PER_KG + S.INDIUM_USD_PER_KG) / Constants.USD_PER_CREDIT);
}

/**
 * Kilograms of nitrogen -> steering-gas POOL units. The pool (`coldGas`, `COLD_GAS_MAX` = 20 units) is not kg: the full
 * tank is `OCTOPUS_CORE_COLD_GAS` = 6 kg, so one unit is 0.3 kg. Every bill that computes kg converts here before it
 * charges the pool.
 */
export function coldGasKgToPool(kg) {
  return kg * Constants.COLD_GAS_MAX / Constants.OCTOPUS_CORE_COLD_GAS;
}

/** Steering-gas POOL units -> kilograms of nitrogen (the inverse of `coldGasKgToPool`). */
export function coldGasPoolToKg(pool) {
  return pool * Constants.OCTOPUS_CORE_COLD_GAS / Constants.COLD_GAS_MAX;
}

/**
 * Free space in the cold-gas (nitrogen) tank, REAL kg (not pool units).
 * @param {{coldGas?: number, coldGasMax?: number}|null} res - ResourceSystem or player.resources
 */
export function coldGasFreeKg(res) {
  const max = res && Number.isFinite(res.coldGasMax) ? res.coldGasMax : Constants.COLD_GAS_MAX;
  const have = res && Number.isFinite(res.coldGas) ? res.coldGas : 0;
  return coldGasPoolToKg(Math.max(0, max - have));
}

/**
 * The kg a salvaged-gas amount is worth. Debris `salvage.xenon` is in pool units (100 = one full tank of the default
 * gas), so 10 units on argon = 2.08 kg. The one owner of this conversion: the award (x refinery multiplier), the
 * wireframe line and the dossier label all call it.
 * @param {number} units - salvage.xenon (pool units)
 */
export function salvageGasKg(units) {
  const kgFull = Constants.FUELS[Constants.DEFAULT_FUEL].kgFull || 0;
  return Math.max(0, Number.isFinite(units) ? units : 0) / 100 * kgFull;
}

/** The mass of engine gas every launch carries, whatever the gas or tank (12.48 kg: 60 % of the base argon tank). Derived, never typed. */
export const START_GAS_KG = Constants.PROPELLANT_START_FRACTION * Constants.FUELS[Constants.DEFAULT_FUEL].kgFull;
/** What a gas switch fills the tank with (the same launch mass). */
export const GAS_SWITCH_FILL_KG = START_GAS_KG;

/** argon < krypton < xenon: a gas switch only goes up. */
const GAS_RANK = { argon: 0, krypton: 1, xenon: 2 };

/**
 * The engine pool (a percentage of the base 60 L tank, as everywhere) that holds min(START_GAS_KG, capacity) kg of
 * `tankGasId`. On the base argon tank this is exactly 60.
 * @param {number} xenonMax - pool capacity
 */
export function startEnginePool(tankGasId, xenonMax) {
  const fuels = Constants.FUELS || {};
  const def = fuels[Constants.DEFAULT_FUEL];
  const fuel = fuels[tankGasId] || def;
  const frac = Constants.PROPELLANT_START_FRACTION;
  const f = Number.isFinite(frac) ? clamp01(frac) : 1;
  const pool = f * 100 * (def.kgFull / fuel.kgFull);   // START_GAS_KG / kgFull × 100, exact for the default gas
  return Math.min(pool, Number.isFinite(xenonMax) ? xenonMax : Constants.XENON_FUEL_MAX);
}

/** Free space in the engine tank, kg of the gas IN the tank. */
export function engineTankFreeKg(res) {
  const fuels = Constants.FUELS || {};
  const fuel = fuels[(res && res.tankGasId) || Constants.DEFAULT_FUEL] || fuels[Constants.DEFAULT_FUEL];
  const max = res && Number.isFinite(res.xenonMax) ? res.xenonMax : Constants.XENON_FUEL_MAX;
  const pool = res && Number.isFinite(res.xenon) ? res.xenon : 0;
  return Math.max(0, max - pool) / 100 * fuel.kgFull;
}

/** Dry mass of the engine tank itself, kg: it follows the tank's size (the Bigger Engine Tank). */
export function engineTankDryKg(res) {
  const max = res && Number.isFinite(res.xenonMax) ? res.xenonMax : Constants.XENON_FUEL_MAX;
  return Constants.ENGINE_TANK_DRY_MASS_KG * max / Constants.XENON_FUEL_MAX;
}

/**
 * "How full is the engine tank", 0..1, by MASS and the same for every gas: against the base argon tank scaled by the
 * tank's size. On argon it is exactly xenon / xenonMax; xenon's 12.48 kg reads 0.6 (12.48 / 20.8), not 9.7 % of its
 * own 129 kg tank. Every low warning / bar / alarm reads this.
 */
export function engineGasLowFrac(res) {
  const def = (Constants.FUELS || {})[Constants.DEFAULT_FUEL];
  const max = res && Number.isFinite(res.xenonMax) ? res.xenonMax : Constants.XENON_FUEL_MAX;
  const ref = def.kgFull * max / Constants.XENON_FUEL_MAX;
  return ref > 0 ? clamp01(engineGasKg(res) / ref) : 0;
}

/**
 * The ONE Tsiolkovsky formula for the Hall engine. Cold gas is CARRIED, not burned by this engine, so it sits in both
 * the loaded and the empty mass.   ΔV = (Isp / c) · g0 · ln((dry + coldGas + gas) / (dry + coldGas))
 * @param {number} a.dryKg - everything that is not a gas (core, tank, struts, arms, cargo)
 * @param {number} a.isp - the ACTIVE fuel's Isp, s
 * @param {number} [a.c=1] - consumption multiplier (shop upgrade x power split; an Isp gain)
 * @returns {number} m/s (0 when there is nothing to burn)
 */
export function engineDeltaV({ dryKg, coldGasKg = 0, gasKg, isp, c = 1 }) {
  const carried = (dryKg || 0) + (coldGasKg || 0);
  if (!(carried > 0) || !(gasKg > 0) || !(isp > 0)) return 0;
  return (isp / (c > 0 ? c : 1)) * Constants.G0 * Math.log((carried + gasKg) / carried);
}

export class ResourceSystem {
  /** getMotorLoads(): a motor source counts as running while its last bill is this young (own-clock seconds)... */
  static MOTOR_LOAD_LIVE_S = 0.2;
  /** ...and its watts are averaged over its bills in this window. */
  static MOTOR_LOAD_WINDOW_S = 0.5;

  constructor() {
    // `xenon` / `xenonMax` are POOL names kept for compatibility: the pool holds whichever gas is in the tank
    // (`tankGasId`), as a fill percentage (100 = one full 60 L base tank).
    this.xenon = 0;   // filled below, once xenonMax and tankGasId exist
    this.coldGas = ResourceSystem.startPropellant(Constants.COLD_GAS_MAX);
    // Mother-side indium store, kg of cast indium for the daughters' ion-fuel cartridges (DECISIONS §4). A new run starts EMPTY.
    this.indiumStoreKg = 0;
    // Drag sails aboard (a count; each is BIG_PIECES.SAIL.massKg of her live mass). A new run starts with none.
    this.dragSails = 0;
    // Two cumulative tallies in KILOGRAMS of engine gas for the range map's "this mission" line (MissionGasTally keeps its
    // own baseline and rebases if these drop): all drawn from the engine pool (every billed burn, trips included: the
    // tally decides what to count) and what SALVAGE loaded (a shop buy does not count). Zero on reset() and restore(); never saved.
    this.xenonDrawnKg = 0;
    this.salvageGasKg = 0;
    // every boot starts at BATTERY_START_FRACTION (half) of the max
    this.battery = ResourceSystem.startCharge(Constants.BATTERY_MAX);
    this.solarPanelHealth = 1.0;
    // Body-mount cells are backup power with their OWN health (DECISIONS §10, "power follows the panels"). The wing-only
    // paths (damageSolarPanel() collision/impact, passive radiation/MMOD degrade) stay on `solarPanelHealth`; nothing
    // degrades this today, so the body keeps working when the wings are damaged, furled or edge-on.
    this.bodyPanelHealth = 1.0;

    this.lithium = 0;                                // starts empty — must salvage
    this.lithiumMax = Constants.MPD_LITHIUM_CAPACITY; // 100 units

    // Fallback-only rate, used by update()'s rechargeRate when no live player is wired (menu hero, headless tests).
    // PlayerSatellite._updateSolarPower computes the REAL per-frame rate (per-wing/per-cell area × incidence × furl ×
    // shading × health) into player.resources.solarRate and update() prefers it. Constants.SOLAR_PANEL_AREA is the real
    // total built area, so this fallback is a believable ceiling, not a separate invented number.
    this.solarRate =
      Constants.SOLAR_PANEL_EFFICIENCY *
      Constants.SOLAR_FLUX *
      Constants.SOLAR_PANEL_AREA;
    // Shop solarEfficiency multiplier, read by the REAL per-frame calc too (synced to player.resources.solarEfficiencyMult).
    this.solarEfficiencyMult = 1.0;

    this.xenonMax = Constants.XENON_FUEL_MAX;
    this.coldGasMax = Constants.COLD_GAS_MAX;
    this.batteryMax = Constants.BATTERY_MAX;

    this.panelDegradationMultiplier = 1.0;

    this._hasSupercap = false;         // Graphene Supercap upgrade flag
    this._rtgRate = 0;                 // RTG constant generation (Wh/s)
    this._powerBeamRate = 0;           // Power beaming rate (Wh/s during ground station pass)
    this._groundStationInView = false; // True during ground station pass windows

    // `tankGasId` = the gas IN the engine tank (saved); `_currentFuelId` = the ACTIVE fuel, which may be a
    // cargo fuel (aluminum…) while the tank gas stays put. Cargo depletion falls back to the tank gas.
    this.tankGasId = Constants.DEFAULT_FUEL || 'argon';
    this._currentFuelId = this.tankGasId;
    this._availableFuels = [this.tankGasId]; // always have the tank gas; others added dynamically
    // every launch carries START_GAS_KG of the tank gas (60 % of argon)
    this.xenon = startEnginePool(this.tankGasId, this.xenonMax);
    this._cargoSystem = null;
    /** true once FUEL_CHANGED { initial: true } has named the loaded fuel to the readers. */
    this._fuelAnnounced = false;

    this._player = null;

    this._depletionEmitted = false;

    /** Weather-based solar power multiplier (0 = eclipse, 1.3 = flare boost) */
    this._weatherSolarMult = 1.0;

    /** Seconds since last WEATHER_ACTIVE event */
    this._weatherLastUpdate = 0;

    // Power ledger (DECISIONS §15 row 5: "battery … charging or draining, the cost of each action"). Cumulative totals in
    // battery units, monotonic for the life of the instance (never reset: ThermalSystem reads the drawn total as a
    // running counter and takes the delta each tick, so no draw is lost or counted twice whatever the frame order).
    // OUT = every battery draw: consume(), drainBattery(), drawUpTo(). IN = charging actually stored by update() (solar +
    // RTG + beaming; a full battery stores 0). replenish() (salvage / refinery battery) and upgrade top-ups are NOT
    // charging and are excluded.
    this._ledgerOutUnits = 0;
    this._ledgerInUnits = 0;
    // Part of OUT: battery units drawn by an ion engine (drawUpTo opts.beam), a share of which leaves the ship in the beam.
    this._ledgerBeamUnits = 0;
    /** @private units since the last update(), turned into watts there */
    this._frameOutUnits = 0;
    this._frameInUnits = 0;
    /** @private smoothed watts (HUD scale, same as the `SUN n W` readout) */
    this._inW = 0;
    this._outW = 0;
    /** @private motor bills by source for getMotorLoads(); never saved (see _clearMotorLoads) */
    this._motorClock = 0;
    this._motorBills = new Map();
    /** ThermalSystem (or any { getSnapshot, reset }), set by setThermalSource() */
    this._thermalSource = null;

    eventBus.on(Events.WEATHER_ACTIVE, (effects) => {
      this._weatherSolarMult = effects.solarPower ?? 1.0;
      this._weatherLastUpdate = 0;
    });

    this._setupListeners();
  }

  /** The charge every boot starts with: BATTERY_START_FRACTION of `max` Wh (owner 2026-10-12: "battery is 50% and dropping until wings open"). */
  static startCharge(max) {
    const f = Constants.BATTERY_START_FRACTION;
    const frac = Number.isFinite(f) ? clamp01(f) : 1;
    return max * frac;
  }

  /** The level a tank (engine propellant or cold gas) starts a boot at, kg: new game, retry, CONTINUE (owner 2026-10-14: "only 60% full"). */
  static startPropellant(max) {
    const f = Constants.PROPELLANT_START_FRACTION;
    const frac = Number.isFinite(f) ? clamp01(f) : 1;
    return max * frac;
  }

  setPlayer(player) {
    this._player = player;
    this._syncToPlayer();
  }

  setCargoSystem(cargoSystem) {
    this._cargoSystem = cargoSystem;
  }

  consume(resource, amount) {
    if (!this._isValid(resource)) return false;
    if (this[resource] < amount) return false;

    this[resource] -= amount;
    if (resource === 'battery') this._recordDraw(amount);
    else if (resource === 'xenon') this._countXenonDraw(amount);
    this._syncToPlayer();
    eventBus.emit(Events.RESOURCE_CHANGED, {
      resource,
      value: this[resource],
      delta: -amount,
    });
    return true;
  }

  /** @private Add `units` of engine pool (tank percent) to the cumulative kg drawn, in the gas now in the tank. */
  _countXenonDraw(units) {
    if (units > 0) this.xenonDrawnKg += engineGasKg({ xenon: units, tankGasId: this.tankGasId });
  }

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
   * Restore solar panel health by a fraction (salvaged GaAs cells), clamped to [0, 1]. This is the WING (ROSA) health:
   * `bodyPanelHealth` (backup power) has no damage/repair path by design (DECISIONS §10: it must keep working when the wings don't).
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
   * Impact damage to the solar panels (glancing-collision consequence). Floors at 0.1 so a hit degrades but never fully
   * destroys the array (some recharge always remains); passive degradation floors at 0.3. Hits the WING (ROSA) health
   * only (DECISIONS §10, "Rosa might get damaged by collision or player mistakes"): `bodyPanelHealth` is untouched, so a
   * collision can never zero out the body's own contribution. `fraction` = health lost, e.g. 0.12.
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

  /** Drain up to `amount` Wh (glancing-collision consequence). Unlike consume(), never fails: drains what is there, clamps at 0. */
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
   * Draw up to `amount` from a named resource ('xenon' | 'coldGas' | 'battery' | 'lithium'), clamped at what the pool
   * holds. consume()'s all-or-nothing refusal silently rejected an electric burn's draw once the battery parked below one
   * frame's need, so thrust was applied for free. Like drainBattery() this never fails; it returns the amount actually
   * drawn (0 .. amount) so the caller can scale honestly. `opts.beam === true` tags a battery draw as an ion engine's
   * (it still counts in the ledger's OUT total; getEnergyBeamUnits() counts the tagged part).
   */
  drawUpTo(resource, amount, opts = null) {
    if (!this._isValid(resource) || !(amount > 0)) return 0;
    const drawn = Math.min(amount, Math.max(0, this[resource]));
    if (drawn <= 0) return 0;
    this[resource] -= drawn;
    if (resource === 'battery') this._recordDraw(drawn, opts !== null && opts !== undefined && opts.beam === true);
    else if (resource === 'xenon') this._countXenonDraw(drawn);
    this._syncToPlayer();
    eventBus.emit(Events.RESOURCE_CHANGED, {
      resource,
      value: this[resource],
      delta: -drawn,
    });
    return drawn;
  }

  canAfford(resource, amount) {
    if (!this._isValid(resource)) return false;
    return this[resource] >= amount;
  }

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

  getCurrentFuel() {
    return Constants.FUELS[this._currentFuelId] || Constants.FUELS[this.tankGasId] || Constants.FUELS[Constants.DEFAULT_FUEL];
  }

  /**
   * Name the loaded fuel to every reader. FUEL_CHANGED was only sent on a change, so CommsSystem / StatusPanel named the
   * DEFAULT fuel until the first change (wrong after a load with krypton or xenon). Sends it with `initial: true` at the
   * first frame of play, after a load (restore) and after a new game / retry (reset). Listeners that treat FUEL_CHANGED
   * as a player action (the cycle tone, the codex entry) skip `initial`.
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

  getCurrentFuelId() {
    return this._currentFuelId;
  }

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

    if (!cs) return false;
    const manifest = cs.getManifest();
    const inCargo = manifest.find(m => m.metalId === fuel.cargoMetalId);

    if (!inCargo || inCargo.massKg < amount) {
      // Fuel depleted: auto-switch back to the gas in the tank
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

  /** Weather solar power multiplier: 0 in eclipse, 1.0 nominal, 1.3 flare (the digestion sun gate reads this). */
  getSolarPowerMultiplier() {
    return this._weatherSolarMult;
  }

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
      bodyPanelHealth: this.bodyPanelHealth,
      currentFuelId: this._currentFuelId,
      tankGasId: this.tankGasId,
      currentFuelName: fuel.name,
      currentFuelIsp: fuel.isp,
      currentFuelColor: fuel.color,
      lithium: this.lithium,
      lithiumMax: this.lithiumMax,
      hasSupercap: this._hasSupercap,
      rtgRate: this._rtgRate,
      powerBeamRate: this._powerBeamRate,
      groundStationInView: this._groundStationInView,
    };
  }

  /**
   * The battery meter's numbers. Watts are on the HUD's `SUN n W` scale (battery units per real second ×
   * SHIP_HEAT.W_PER_UNIT_S), smoothed over ~POWER_TAU_S (0.5 s). `inW` = charging actually stored (solar + RTG + beaming;
   * 0 surplus when full: replenish()/salvage and upgrade top-ups are not charging); `outW` = every battery draw;
   * `netW = inW − outW`; `genW` = this frame's generation, unsmoothed (getGenerationW). A fresh object per call.
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
   * What the ship generates THIS frame, unsmoothed, in meter watts (owner 2026-10-12: "rotating mother should show
   * immediate drop in power-in"): the live rate PlayerSatellite._updateSolarPower writes (× the weather multiplier,
   * exactly what update() charges with), plus RTG and beaming when fitted. Unlike `inW` it does not drop to 0 when the
   * battery is full: it is what the panels make, stored or not. Falls back to the static rate when no live player is wired.
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
   * Bill `watts` for `dt` real seconds (a motor or heater running this frame). Same conversion as the base load
   * (units = W ÷ SHIP_HEAT.W_PER_UNIT_S × dt, PlayerSatellite._updateResources), so a 15 W motor shows as +15 W in
   * `outW`; drawn through drawUpTo (never fails, clamps at empty), so it lands in the ledger and its heat follows
   * (ThermalSystem). Returns the battery units actually drawn.
   * `src` (optional string key, e.g. 'strut') also records the energy under that source for getMotorLoads(); the battery
   * drain, ledger and heat are identical with or without it. Untagged bills (the radiator heater) never show there.
   */
  billWatts(watts, dt, src) {
    if (!(watts > 0) || !(dt > 0)) return 0;
    if (typeof src === 'string' && src) this._noteMotorBill(src, watts, dt);
    return this.drawUpTo('battery', (watts / Constants.SHIP_HEAT.W_PER_UNIT_S) * dt);
  }

  /**
   * What the motors are drawing right now, for the battery meter: `[{ src, w }]`, biggest first, for every tagged source
   * (billWatts' `src`) that billed within the last MOTOR_LOAD_LIVE_S (0.2 s) of this ledger's own clock (real seconds, the
   * sum of the update() dts). `w` = energy ÷ billed time over that source's bills in the last MOTOR_LOAD_WINDOW_S (0.5 s),
   * so a steady 15 W motor reads 15 W from its first frame, two struts in one frame read 30 W, a reel reads its real
   * varying draw. Bills run before update() in a frame, so each is stamped with the clock as it stood before this frame's
   * update; bills with the same stamp and source merge (energy summed, time counted once). Never saved.
   * @returns {Array<{src:string, w:number}>}
   */
  getMotorLoads() {
    const now = this._motorClock;
    const out = [];
    for (const [src, list] of this._motorBills) {
      const last = list[list.length - 1];
      if (!last || now - (last.t + last.dt) > ResourceSystem.MOTOR_LOAD_LIVE_S) continue;
      let e = 0;
      let t = 0;
      for (const b of list) {
        if (now - (b.t + b.dt) > ResourceSystem.MOTOR_LOAD_WINDOW_S) continue;
        e += b.e;
        t += b.dt;
      }
      if (t > 0 && e > 0) out.push({ src, w: e / t });
    }
    out.sort((a, b) => b.w - a.w);
    return out;
  }

  /** @private record a tagged bill (energy in W·s) under its source, merged per frame stamp, older than the window dropped */
  _noteMotorBill(src, watts, dt) {
    let list = this._motorBills.get(src);
    if (!list) { list = []; this._motorBills.set(src, list); }
    const last = list[list.length - 1];
    if (last && last.t === this._motorClock) {
      last.e += watts * dt;
      if (dt > last.dt) last.dt = dt;
    } else {
      list.push({ t: this._motorClock, dt, e: watts * dt });
    }
    while (list.length > 1 && this._motorClock - (list[0].t + list[0].dt) > ResourceSystem.MOTOR_LOAD_WINDOW_S) list.shift();
  }

  /** @private forget every motor bill and restart the motor clock (reset()/restore()) */
  _clearMotorLoads() {
    this._motorClock = 0;
    this._motorBills.clear();
  }

  /** Cumulative battery units drawn since this instance was built (monotonic): ThermalSystem's heat input, it takes the delta each tick. */
  getEnergyDrawnUnits() { return this._ledgerOutUnits; }

  /** Cumulative part of getEnergyDrawnUnits() that an ion engine drew (tagged `beam`; monotonic like the total). */
  getEnergyBeamUnits() { return this._ledgerBeamUnits; }

  getEnergyChargedUnits() { return this._ledgerInUnits; }

  /** Register the heat source the meters read (ThermalSystem calls this on itself). reset()/restore() reset it too: heat restarts with the battery. */
  setThermalSource(source) { this._thermalSource = source || null; }

  getThermalSource() { return this._thermalSource; }

  /** @returns {{tempC:number, band:'green'|'yellow'|'red', trend:-1|0|1, autoOpened:boolean}|null} null when no source. */
  getThermalSnapshot() {
    const src = this._thermalSource;
    return (src && typeof src.getSnapshot === 'function') ? src.getSnapshot() : null;
  }

  /** Build the ship's ThermalSystem bound to this ledger and `player` and register it. Idempotent: a second call disposes the first source. */
  createThermalSystem(player) {
    if (this._thermalSource && typeof this._thermalSource.dispose === 'function') {
      this._thermalSource.dispose();
    }
    return new ThermalSystem({ resourceSystem: this, player });
  }

  _recordDraw(units, beam = false) {
    if (!(units > 0)) return;
    this._ledgerOutUnits += units;
    if (beam) this._ledgerBeamUnits += units;
    this._frameOutUnits += units;
  }

  /**
   * A held-world frame (a drawer is open, main.js `_worldHeld`): update() is not called, but player.update still bills
   * the base load. Drop this frame's units so they never land as one spike on release; the smoothed watts stay frozen.
   * (Cumulative totals keep counting; ThermalSystem.skipHeld re-syncs its counter past them.)
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
    this._motorClock += dt;
  }

  _resetLedgerRates() {
    this._clearMotorLoads();
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
   * Serialize upgraded max capacities and the two gas levels. The engine pool (`xenon`, pool units: pool/100 × kgFull of
   * the saved `tankGasId`) and `coldGas` are SAVED, so a reload is not a refuel (Ruling 0: tanks do not magically refill)
   * and keeps gas bought in the shop. The battery level is NOT saved: it starts at half.
   */
  serialize() {
    return {
      xenonMax: this.xenonMax,
      coldGasMax: this.coldGasMax,
      xenon: this.xenon,
      coldGas: this.coldGas,
      indiumStoreKg: this.indiumStoreKg,   // saved like coldGas (an old save has none and loads as 0)
      dragSails: this.dragSails,           // the sail stock (an old save has none and loads as 0)
      batteryMax: this.batteryMax,
      currentFuelId: this._currentFuelId,
      tankGasId: this.tankGasId,   // the gas in the tank survives reloads
      lithium: this.lithium,
      lithiumMax: this.lithiumMax,
      hasSupercap: this._hasSupercap,
      rtgRate: this._rtgRate,
      powerBeamRate: this._powerBeamRate,
    };
  }

  /**
   * Restore upgraded max capacities from saved data. A saved `xenon` / `coldGas` level is restored (clamped to
   * [0, max]): a reload must neither refill nor drain the tanks. An old save without the keys (or a non-finite value)
   * gets the start fill. The battery starts at BATTERY_START_FRACTION of its rebased max (saves carry no charge).
   */
  restore(data) {
    if (!data) return;
    if (data.xenonMax !== undefined) this.xenonMax = data.xenonMax;
    if (data.coldGasMax !== undefined) this.coldGasMax = data.coldGasMax;
    if (data.batteryMax !== undefined) {
      // The base battery grew 100 -> 600 Wh. Legacy saves carry 100 + bought upgrades: carry the upgrades across by
      // rebasing onto the new base; saves >= the new base pass through. Upgrade effects do not re-apply on load
      // (RESOURCE_RESTORED_EFFECTS), so this saved absolute is the only source.
      const BASE_OLD = 100, BASE_NEW = Constants.BATTERY_MAX;
      this.batteryMax = (data.batteryMax < BASE_NEW)
        ? BASE_NEW + (data.batteryMax - BASE_OLD)
        : data.batteryMax;
    }
    // An old save has no tankGasId (its tank held xenon-named gas at the same fill fraction): the tank and the active
    // fuel become the default (argon). A new save keeps both (the active fuel may be a cargo fuel). A saved gas this
    // build does not know falls back to the default.
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
    // lithium persists between missions (hard to get)
    if (data.lithium !== undefined) this.lithium = data.lithium;
    if (data.lithiumMax !== undefined) this.lithiumMax = data.lithiumMax;
    if (data.hasSupercap) this._hasSupercap = true;
    if (data.rtgRate !== undefined) this._rtgRate = data.rtgRate;
    if (data.powerBeamRate !== undefined) this._powerBeamRate = data.powerBeamRate;
    // Gas levels: the saved level when there is one, else the start fill (old save, or a game-over save, which strips
    // the levels so CONTINUE is a fresh attempt). Battery: half.
    const clampLevel = (v, max) => Math.min(Math.max(v, 0), max);
    this.xenon = Number.isFinite(data.xenon)
      ? clampLevel(data.xenon, this.xenonMax)
      : startEnginePool(this.tankGasId, this.xenonMax);   // the same kg, any gas
    this.coldGas = Number.isFinite(data.coldGas)
      ? clampLevel(data.coldGas, this.coldGasMax)
      : ResourceSystem.startPropellant(this.coldGasMax);
    // the indium store, clamped to its room; an old save, or a game-over save (which strips it), starts it empty
    this.indiumStoreKg = Number.isFinite(data.indiumStoreKg)
      ? clampLevel(data.indiumStoreKg, Constants.DAUGHTER_SUPPLY.INDIUM_STORE_MAX_KG)
      : 0;
    this.dragSails = Number.isFinite(data.dragSails) ? Math.max(0, Math.floor(data.dragSails)) : 0;
    this.xenonDrawnKg = 0;   // a load starts the gas tallies again (MissionGasTally rebases)
    this.salvageGasKg = 0;
    this.battery = ResourceSystem.startCharge(this.batteryMax);
    this.solarPanelHealth = 1.0;
    this.bodyPanelHealth = 1.0;
    this._depletionEmitted = false;
    this._resetLedgerRates();   // a fresh mission: meters and heat restart
    this._resetThermal();
    this._syncToPlayer();
    this.announceFuel();   // the loaded fuel, named from the first frame
  }

  /** Every gameplay frame: solar recharge, depletion check. */
  update(dt) {
    // boot: no restore()/reset() has named the fuel yet; the HUD listeners exist by now
    if (!this._fuelAnnounced) this.announceFuel();
    // staleness: reset the weather multiplier if no WEATHER_ACTIVE for 2 s
    this._weatherLastUpdate += dt;
    if (this._weatherLastUpdate > 2.0) {
      this._weatherSolarMult = 1.0;
    }

    // Solar recharge (simplified Wh model scaled for gameplay). DECISIONS §10, "power follows the panels, realistic
    // wins": prefer the REAL per-frame rate PlayerSatellite._updateSolarPower computes (per-wing/per-cell area ×
    // incidence × furl × shading, wing/body health applied separately). It already reflects eclipse, tilt, shading,
    // furl and BOTH health splits, so it is used as-is (no extra ×solarPanelHealth: that would double the wing-health
    // penalty and wrongly apply it to the body's share). Falls back to the static `this.solarRate` (still gated by wing
    // health) when no live player is wired (menu hero, a bare ResourceSystem in a unit test).
    const liveRate = this._player && this._player.resources && this._player.resources.solarRate;
    const rechargeRate = (typeof liveRate === 'number')
      ? liveRate * this._weatherSolarMult * dt * 0.001
      : this.solarRate * this.solarPanelHealth * this._weatherSolarMult * dt * 0.001;
    // charging actually stored this frame (solar + RTG + beaming below): a full battery stores nothing, so its surplus is never "in"
    const batteryBeforeCharge = this.battery;
    if (this.battery < this.batteryMax) {
      this.battery = Math.min(this.batteryMax, this.battery + rechargeRate);
      this._syncToPlayer();
    }

    if (this._rtgRate > 0 && this.battery < this.batteryMax) {
      this.battery = Math.min(this.batteryMax, this.battery + this._rtgRate * dt);
      this._syncToPlayer();
    }

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

    // Gradual panel degradation from radiation/micrometeorite damage. This is the WING (ROSA) health: the large, thin,
    // exposed blanket wears down first. `bodyPanelHealth` (compact, recessed body-mount cells, backup power) is
    // deliberately NOT degraded here or anywhere else. Base rate ~5 % loss per 10 min of gameplay (600 game-s at TIME_SCALE_GAMEPLAY=10).
    const baseDegradRate = 0.00008;
    const degradMultiplier = this.panelDegradationMultiplier || 1.0;
    const actualDegradRate = baseDegradRate * degradMultiplier;
    if (this.solarPanelHealth > 0.3) {
      this.solarPanelHealth = Math.max(0.3, this.solarPanelHealth - actualDegradRate * dt);
      this._syncToPlayer();
    }

    if (
      this.xenon <= 0 &&
      this.coldGas <= 0 &&
      this.battery <= 0 &&
      !this._depletionEmitted
    ) {
      this._depletionEmitted = true;
      eventBus.emit(Events.RESOURCE_DEPLETED, { reason: 'fuel' });
    }

    if (this.xenon > 0 || this.coldGas > 0 || this.battery > 0) {
      this._depletionEmitted = false;
    }
  }

  /**
   * Change the gas IN the tank to a better one (argon < krypton < xenon). What is left is vented; the tank is filled
   * with `kg` of the new gas (clamped to capacity). Refused for a gas ranked at or below the tank's, so a replay in any
   * order never downgrades. Returns true if the switch happened.
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
   * Load up to `kg` of the gas in the tank, limited by free tank space; also the path salvaged gas takes.
   * `opts.source: 'salvage'`: the kilos also add to `salvageGasKg`; the shop passes none.
   * @returns {number} kg actually loaded (0 when the tank is full: free < 0.1 kg)
   */
  resupplyEngineGas(kg, opts = {}) {
    const free = engineTankFreeKg(this);
    if (free < 0.1 || !(kg > 0)) return 0;
    const add = Math.min(kg, free);
    const fuel = Constants.FUELS[this.tankGasId] || Constants.FUELS[Constants.DEFAULT_FUEL];
    this.xenon = Math.min(this.xenonMax, this.xenon + add / fuel.kgFull * 100);
    if (opts && opts.source === 'salvage') this.salvageGasKg += add;     // only salvage counts as "caught", not a shop buy
    this._depletionEmitted = false;
    this._syncToPlayer();
    eventBus.emit(Events.RESOURCE_UPGRADED, { effect: 'engineGasResupply', value: add });
    return add;
  }

  /**
   * Load up to `kg` of nitrogen into the cold-gas tank, limited by free space (same rule as `resupplyEngineGas`). The
   * tank feeds the docked daughters' bottles (§34 row 5), so this IS the daughters' cold-gas buy.
   * @returns {number} kg actually loaded (0 when the tank is full: free < 0.1 kg)
   */
  resupplyColdGas(kg) {
    const free = coldGasFreeKg(this);
    if (free < 0.1 || !(kg > 0)) return 0;
    const add = Math.min(kg, free);
    this.coldGas = Math.min(this.coldGasMax, this.coldGas + coldGasKgToPool(add));   // a purchase gives the kg it says
    this._syncToPlayer();
    eventBus.emit(Events.RESOURCE_UPGRADED, { effect: 'coldGasResupply', value: add });
    return add;
  }


  indiumStoreFreeKg() {
    return Math.max(0, Constants.DAUGHTER_SUPPLY.INDIUM_STORE_MAX_KG - this.indiumStoreKg);
  }

  /** Put up to `kg` of indium into the store (salvage, or a bought cartridge). What does not fit is NOT stored. Returns kg stored. */
  addIndium(kg) {
    if (!(kg > 0)) return 0;
    const add = Math.min(kg, this.indiumStoreFreeKg());
    if (!(add > 0)) return 0;
    this.indiumStoreKg = Math.min(Constants.DAUGHTER_SUPPLY.INDIUM_STORE_MAX_KG, this.indiumStoreKg + add);
    this._syncToPlayer();
    return add;
  }

  /**
   * A bought ion-fuel cartridge goes into the indium store AT THE CLICK, whether or not the arm is there to show it
   * (the hand-over is only the look). A whole cartridge or none: a store with less room than one refuses it.
   * @returns {number} kg stored (0 when there is no room for the whole cartridge)
   */
  loadIndiumCartridge(kg) {
    if (!(kg > 0) || this.indiumStoreFreeKg() < kg - 1e-9) return 0;
    const add = this.addIndium(kg);
    if (add > 0) eventBus.emit(Events.RESOURCE_UPGRADED, { effect: 'indiumCartridge', value: add });
    return add;
  }

  /** Set the store's level directly, clamped to [0, max] (the docked swap writes the pool back with this). */
  setIndiumStore(kg) {
    const max = Constants.DAUGHTER_SUPPLY.INDIUM_STORE_MAX_KG;
    this.indiumStoreKg = Math.min(max, Math.max(0, Number.isFinite(kg) ? kg : 0));
    this._syncToPlayer();
  }

  // Drag sail stock: a bought sail is a count aboard and its mass is part of her live mass; each sail disposal spends one.

  /** Mass of the sails aboard, kg (ArmManager.getMassBudget adds it to her live mass). */
  dragSailMassKg() {
    return Math.max(0, this.dragSails) * Constants.BIG_PIECES.SAIL.massKg;
  }

  /** One bought drag sail goes into the stock AT THE CLICK (like a cartridge); returns the stock after the load. */
  loadDragSail() {
    this.dragSails = Math.max(0, Math.floor(this.dragSails) || 0) + 1;
    this._syncToPlayer();
    eventBus.emit(Events.RESOURCE_UPGRADED, { effect: 'dragSail', value: 1 });
    return this.dragSails;
  }

  applyUpgrade(data) {
    switch (data.effect) {
      case 'xenonMax':
        // Cumulative (buying twice gives base+50+50). A bigger tank is SPACE, not gas: it raises the max only (fill it with a resupply).
        this.xenonMax += data.value;
        break;
      case 'engineGasSwitch':
        if (!this.switchEngineGas(data.value, GAS_SWITCH_FILL_KG)) return false;
        return true;   // switchEngineGas synced, emitted FUEL_CHANGED and RESOURCE_UPGRADED itself
      case 'engineGasResupply':
        if (this.resupplyEngineGas(data.value) <= 0) return false;
        return true;
      case 'coldGasResupply':
        if (this.resupplyColdGas(data.value) <= 0) return false;
        return true;   // resupplyColdGas synced and emitted RESOURCE_UPGRADED itself
      case 'indiumCartridge':
        if (this.loadIndiumCartridge(data.value) <= 0) return false;
        return true;   // loadIndiumCartridge synced and emitted RESOURCE_UPGRADED itself
      case 'dragSail':
        this.loadDragSail();
        return true;   // loadDragSail synced and emitted RESOURCE_UPGRADED itself
      case 'coldGasMax':
        this.coldGasMax += data.value;
        this.coldGas = Math.min(this.coldGas + data.value, this.coldGasMax);
        break;
      case 'batteryMax':
        this.batteryMax += data.value;
        this.battery = Math.min(this.battery + data.value, this.batteryMax);
        break;
      case 'solarEfficiency':
        // Multiplies the solar recharge rate (1.3 = +30 %). Feeds the REAL per-frame calc via solarEfficiencyMult
        // (synced to player.resources); solarRate is kept in step as the fallback rate when no live player is wired.
        this.solarEfficiencyMult = data.value;
        this.solarRate = Constants.SOLAR_PANEL_EFFICIENCY * data.value
          * Constants.SOLAR_FLUX * Constants.SOLAR_PANEL_AREA;
        break;
      case 'supercapUpgrade':
        // burst storage on battery max AND the thermal flag
        this.batteryMax += data.value;  // +100 Wh
        this.battery = Math.min(this.battery + data.value, this.batteryMax);
        this._hasSupercap = true;
        break;
      case 'rtgPower':
        this._rtgRate = data.value;  // 2.0 Wh/s
        break;
      case 'powerBeaming':
        this._powerBeamRate = data.value;  // 5.0 Wh/s
        break;
      case 'panelDegradation':
        // multiplier used in update() for the degradation rate (0.5 = half speed)
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

  reset() {
    this.coldGas = ResourceSystem.startPropellant(Constants.COLD_GAS_MAX);
    this.indiumStoreKg = 0;   // a new run (retry, game-over continue) starts the indium store empty
    this.dragSails = 0;

    this.xenonDrawnKg = 0;    // the gas tallies start again (MissionGasTally rebases)
    this.salvageGasKg = 0;
    this.battery = ResourceSystem.startCharge(Constants.BATTERY_MAX);   // half
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
    this.xenon = startEnginePool(this.tankGasId, this.xenonMax);   // after xenonMax and tankGasId
    this._hasSupercap = false;
    this._rtgRate = 0;
    this._powerBeamRate = 0;
    this._groundStationInView = false;
    clearTimeout(this._gsPassTimer);
    this._resetLedgerRates();   // heat restarts with the battery (new game / retry)
    this._resetThermal();
    this._syncToPlayer();
    this.announceFuel();   // the default fuel, named from the first frame
  }

  _isValid(resource) {
    return resource === 'xenon' || resource === 'coldGas' || resource === 'battery' || resource === 'lithium';
  }

  _syncToPlayer() {
    if (!this._player) return;
    this._player.resources.xenon = this.xenon;
    this._player.resources.coldGas = this.coldGas;
    this._player.resources.indiumStoreKg = this.indiumStoreKg;
    this._player.resources.battery = this.battery;
    this._player.resources.solarPanelHealth = this.solarPanelHealth;
    this._player.resources.bodyPanelHealth = this.bodyPanelHealth;
    this._player.resources.solarEfficiencyMult = this.solarEfficiencyMult;
    this._player.resources.xenonMax = this.xenonMax;
    this._player.resources.tankGasId = this.tankGasId;   // which gas the pool holds
    this._player.resources.coldGasMax = this.coldGasMax;
    this._player.resources.batteryMax = this.batteryMax;
    this._player.resources.lithium = this.lithium;
    this._player.resources.lithiumMax = this.lithiumMax;
  }

  _setupListeners() {
    eventBus.on(Events.RESOURCE_CONSUME, (data) => {
      this.consume(data.resource, data.amount);
    });

    eventBus.on(Events.RESOURCE_REPLENISH, (data) => {
      this.replenish(data.resource, data.amount);
    });

    eventBus.on(Events.GROUND_STATION_PASS, () => {
      this._groundStationInView = true;
      // the pass window lasts ~60 s (per SubsystemEvents emission); reset after it expires
      clearTimeout(this._gsPassTimer);
      this._gsPassTimer = setTimeout(() => {
        this._groundStationInView = false;
      }, 60000);
    });
  }
}

export default ResourceSystem;
