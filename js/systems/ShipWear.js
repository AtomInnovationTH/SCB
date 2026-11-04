/**
 * ShipWear — her parts wear out with SHIP DAYS, and the engine with the push it has given (DECISIONS §57 row 3, DECISIONS §62;
 * route-1101 lane W2; rates: docs/research/2026-10-scav-wear.md, cited per constant in `Constants.SHIP_WEAR`).
 *
 * ONE CLOCK. `gameState.shipDays` grows only when a trip lands (three arrival paths in GameFlowManager) and, with lane S2, when
 * she waits. `poll(res, altKm)` runs once a frame (ResourceSystem.update): if `shipDays` is past the saved `wearShipDays` it ages
 * her by the difference and sets `wearShipDays = shipDays`. Every path that adds ship days therefore ages her with no edit there.
 * 600 s of play with no trip ages nothing. The trip's days are aged at the MEAN of the rate over the heights she flew from (her
 * height at the last ship-day step) to where she is now (16 steps, linear in height: a simplification, the real spiral is not
 * linear); a wait or a satellite call is the same height twice, so exact.
 *
 *   - Battery: half her energy leaves it every orbit, one cycle an orbit (wear doc §3): cycles a day = 86,400 s / the orbit's
 *     period. Her capacity (`batteryMax`) falls with the share of the rated life used (battery deep cycles counted in play, the
 *     EnvironmentSystem DOD rule, are events and stay as they are).
 *   - Wings: the existing wing health (`solarPanelHealth`, which scales the solar output) falls by a yearly compound rate, faster
 *     below 600 km (atomic oxygen). `Rad-Hard Panels` (panelDegradationMultiplier) still scales it.
 *   - Engine: push given = gas spent x effective exhaust speed (g0 x Isp / c, the Isp the trip profile is flown with:
 *     FieldRegistry.planTo), taken from the DROP in the tank between two polls. A rise (a refill, the shop) never counts, and a
 *     change of the gas in the tank re-anchors (the vent on a gas switch is not push). At 100 % of the rated 1.0 MNs
 *     `FieldRegistry.planTo` answers `profile.ok = false` for every trip: the rows say "the thruster cannot take her there", and
 *     the call row (the satellite comes to her) stays. The reason is on the MOTHER pane line and, once when the list opens, as
 *     a comms line (this module listens for `Events.WHERE_NEXT {open: true}`).
 *
 * Replacements are shop items at the resupply satellite (ShopScreen UPGRADES `replace_engine/battery/wings`); `replace(part)`
 * resets that part.
 *
 * Save: `gameState.wearShipDays/wearEngineNs/wearBatteryCycles/wearWingAge`; a save without `wearShipDays` loads it equal to
 * `shipDays` (no back-dated wear). The wings' impact damage is not saved (a reload heals it, as before): only the age is.
 * @module systems/ShipWear
 */
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { gameState } from '../core/GameState.js';
import { engineGasKg } from './ResourceSystem.js';

const DAY_S = 86400;
const SAMPLES = 16;
/** her height when nothing tells us (a bare ResourceSystem with no ship): the start field */
const FALLBACK_ALT_KM = 350;

export const ENGINE_WORN_OUT_TEXT = 'Engine worn out: replace it at the resupply satellite';

/** @returns {object} the SHIP_WEAR constants */
const W = () => Constants.SHIP_WEAR;

/** Period of a circular orbit at `altKm`, seconds. */
export function orbitPeriodS(altKm) {
  const a = Constants.EARTH_RADIUS_KM + altKm;
  return 2 * Math.PI * Math.sqrt(a * a * a / Constants.MU_EARTH);
}

/** Half-depth battery cycles a ship day uses at `altKm` (one an orbit, wear doc §3: 15.75 at 350 km, 14.0 at 900 km). */
export function batteryCyclesPerDay(altKm) {
  return DAY_S / orbitPeriodS(altKm);
}

/** Compound yearly fade of the wings at `altKm`: radiation base, plus atomic oxygen below the threshold (`Constants.SHIP_WEAR`). */
export function wingFadePerYear(altKm) {
  const w = W();
  const top = Constants.ENVIRONMENT.AO_THRESHOLD_KM;
  const full = w.WING_AO_FULL_KM;
  let ao = 0;
  if (altKm <= full) ao = w.WING_AO_FADE_PER_YEAR;
  else if (altKm < top) ao = w.WING_AO_FADE_PER_YEAR * (top - altKm) / (top - full);
  return w.WING_FADE_PER_YEAR + ao;
}

/** Share of her new battery capacity left after `cycles` half-depth cycles (1 = new). */
export function batteryCapacityFactor(cycles) {
  const w = W();
  const used = Math.max(0, cycles) / w.BATTERY_RATED_CYCLES;
  return Math.max(w.BATTERY_FADE_FLOOR, 1 - w.BATTERY_FADE_AT_LIFE * used);
}

/** Wh the ship-day fade has taken off the BASE pack (`Constants.BATTERY_MAX`) after `cycles` half-depth cycles. */
export function shipDayLossWh(cycles) {
  return Constants.BATTERY_MAX * (1 - batteryCapacityFactor(cycles));
}

/** Replacement price of a part, credits: its mass x the launch price per kg, rounded to 10 cr (as `gasPriceCr`). */
export function partPriceCr(part) {
  const kg = W().PART_KG[part];
  if (!(kg > 0)) return 0;
  return Math.round(kg * Constants.LAUNCH_USD_PER_KG / Constants.USD_PER_CREDIT / 10) * 10;
}

/** Shop effect -> the part it replaces. */
export const REPLACE_EFFECT_PART = Object.freeze({ replaceEngine: 'engine', replaceBattery: 'battery', replaceWings: 'wings' });

export class ShipWear {
  /**
   * @param {object} [state] the game state holding the wear fields (default: the singleton)
   * @param {object} [bus] the event bus (default: the singleton)
   */
  constructor(state = gameState, bus = eventBus) {
    this._s = state;
    this._bus = bus;
    this._attached = false;
    /** @type {object|null} the ResourceSystem last polled (the pane line reads the wings from it) */
    this._res = null;
  }

  /** Listen once for the where-next list opening (the engine reason is said as a comms line then). */
  attach() {
    if (this._attached || !this._bus) return;
    this._attached = true;
    this._bus.on(Events.WHERE_NEXT, (d) => {
      if (!d || d.open !== true || d.again === true) return;
      if (this.isEngineWornOut()) {
        this._bus.emit(Events.COMMS_MESSAGE, { text: `${ENGINE_WORN_OUT_TEXT}.`, priority: 'warning', source: 'MOTHER' });
      }
    });
  }

  /** Share of the engine's rated push used (1 = worn out). */
  engineWear() { return Math.max(0, this._s.wearEngineNs) / W().ENGINE_RATED_NS; }

  isEngineWornOut() { return this.engineWear() >= 1; }

  /** Share of the battery's rated cycles used. */
  batteryWear() { return Math.max(0, this._s.wearBatteryCycles) / W().BATTERY_RATED_CYCLES; }

  /** Wings worn: 1 - health. With a ResourceSystem it is the live health (age and impact damage), else the age alone. */
  wingsWear(res = this._res) {
    const h = res && Number.isFinite(res.solarPanelHealth) ? res.solarPanelHealth : this._s.wearWingAge;
    return Math.min(1, Math.max(0, 1 - h));
  }

  /** @param {'engine'|'battery'|'wings'} part */
  wornFraction(part, res = this._res) {
    if (part === 'engine') return this.engineWear();
    if (part === 'battery') return this.batteryWear();
    if (part === 'wings') return this.wingsWear(res);
    return 0;
  }

  /**
   * Once a frame: age her by the ship days added since the last poll, and wear the engine by the push given since it.
   * @param {object} res the ResourceSystem (batteryMax, battery, solarPanelHealth, panelDegradationMultiplier, xenon, tankGasId, _player)
   * @param {number|null} altKm her height now, km (null: the height of the last step)
   */
  poll(res, altKm) {
    if (!res) return;
    this._res = res;
    this.attach();
    const s = this._s;
    this._pollEngine(res);
    if (!Number.isFinite(s.wearAltKm)) s.wearAltKm = Number.isFinite(altKm) ? altKm : FALLBACK_ALT_KM;
    const days = s.shipDays - s.wearShipDays;
    if (days > 0) {
      const to = Number.isFinite(altKm) ? altKm : s.wearAltKm;
      this._ageDays(res, days, s.wearAltKm, to);
      s.wearShipDays = s.shipDays;
      s.wearAltKm = to;
    } else if (days < 0) {
      s.wearShipDays = s.shipDays;   // the clock went back (a reset path): never negative wear
    }
  }

  /** @private push given since the last poll, from the drop in the engine tank */
  _pollEngine(res) {
    const s = this._s;
    const id = res.tankGasId || Constants.DEFAULT_FUEL;
    const kg = engineGasKg(res);
    if (s.wearGasKg === null || s.wearGasKg === undefined || s.wearGasId !== id) {
      s.wearGasKg = kg;
      s.wearGasId = id;
      return;
    }
    const spent = s.wearGasKg - kg;
    s.wearGasKg = kg;
    if (spent <= 0) return;   // a refill (or nothing): never wear
    s.wearEngineNs += spent * this.exhaustSpeedMps(res);
  }

  /** The effective exhaust speed the trip profile is flown with: g0 x Isp / c (c = the gas multiplier, `planTo`). */
  exhaustSpeedMps(res) {
    const fuels = Constants.FUELS || {};
    const fuel = fuels[res.tankGasId] || fuels[Constants.DEFAULT_FUEL];
    const isp = fuel && Number.isFinite(fuel.isp) ? fuel.isp : 0;
    const p = res._player;
    const c = p && typeof p.getConsumptionMultiplier === 'function' ? p.getConsumptionMultiplier() : 1;
    return Constants.G0 * isp / (c > 0 ? c : 1);
  }

  /** @private age the battery and the wings by `days` flown from `fromKm` to `toKm` */
  _ageDays(res, days, fromKm, toKm) {
    const s = this._s;
    let cycles = 0;
    let fadeK = 0;   // per year, as -ln(1 - rate): compound rates add as logs
    for (let i = 0; i < SAMPLES; i++) {
      const h = fromKm + (toKm - fromKm) * (i + 0.5) / SAMPLES;
      cycles += batteryCyclesPerDay(h);
      fadeK += -Math.log(1 - wingFadePerYear(h));
    }
    cycles /= SAMPLES;
    fadeK /= SAMPLES;
    // battery: the cycles, then her capacity follows the new life used. The fade acts on the BASE pack only
    // (`shipDayLossWh`: a Wh amount off `Constants.BATTERY_MAX`), never as a share of the whole `batteryMax`: Wh added later (the
    // battery upgrades) and the deep-cycle losses (EnvironmentSystem) are neither faded here nor given back by a new battery.
    const lossOld = shipDayLossWh(s.wearBatteryCycles);
    s.wearBatteryCycles += cycles * days;
    const lossNew = shipDayLossWh(s.wearBatteryCycles);
    if (typeof res.batteryMax === 'number') {
      res.batteryMax = Math.max(0, res.batteryMax - (lossNew - lossOld));
      if (typeof res.battery === 'number') res.battery = Math.min(res.battery, res.batteryMax);
    }
    // wings: the age factor, and the live health follows it
    const mult = res.panelDegradationMultiplier > 0 ? res.panelDegradationMultiplier : 1;
    const oldAge = s.wearWingAge > 0 ? s.wearWingAge : 1;
    const newAge = Math.max(W().WING_FLOOR, oldAge * Math.exp(-fadeK * mult * days / 365));
    s.wearWingAge = newAge;
    if (Number.isFinite(res.solarPanelHealth)) res.solarPanelHealth *= newAge / oldAge;
    if (typeof res._syncToPlayer === 'function') res._syncToPlayer();
  }

  /**
   * Buying a part resets it.
   * @param {'engine'|'battery'|'wings'} part
   * @param {object} [res] the ResourceSystem
   * @returns {boolean} true when a part was reset
   */
  replace(part, res = this._res) {
    const s = this._s;
    if (part === 'engine') {
      s.wearEngineNs = 0;
    } else if (part === 'battery') {
      // give back only the ship-day fade (a Wh amount of the base pack): upgrades added since and deep-cycle losses stay as they are
      const loss = shipDayLossWh(s.wearBatteryCycles);
      s.wearBatteryCycles = 0;
      if (res && typeof res.batteryMax === 'number') res.batteryMax += loss;
    } else if (part === 'wings') {
      s.wearWingAge = 1;
      if (res) res.solarPanelHealth = 1;
    } else {
      return false;
    }
    if (res && typeof res._syncToPlayer === 'function') res._syncToPlayer();
    return true;
  }

  /**
   * The short warning the MOTHER pane shows OUTSIDE its hover-opened detail (an iPad has no hover): names each part that is worn
   * out (the engine at 100 % of its rated push; the battery and the wings at their floor), or '' when none is.
   * @returns {string}
   */
  wornOutWarning() {
    const s = this._s;
    const out = [];
    if (this.isEngineWornOut()) out.push('Engine');
    if (batteryCapacityFactor(s.wearBatteryCycles) <= W().BATTERY_FADE_FLOOR) out.push('Battery');
    if (s.wearWingAge <= W().WING_FLOOR + 1e-9) out.push('Wings');
    if (!out.length) return '';
    const names = out.map((n, i) => (i ? n.toLowerCase() : n));
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
    return `${list} worn out: replace at the satellite`;
  }

  /** The MOTHER pane's line: "Day N · engine x% · battery y% · wings z%" (all three are shares worn), the engine's reason when it is spent. */
  summaryLine(res = this._res) {
    const pct = (f) => `${Math.round(Math.min(1, Math.max(0, f)) * 100)}%`;
    const day = Math.floor(Math.max(0, this._s.shipDays));
    const engine = this.isEngineWornOut() ? ENGINE_WORN_OUT_TEXT : `engine ${pct(this.engineWear())}`;
    return `Day ${day} \u00b7 ${engine} \u00b7 battery ${pct(this.batteryWear())} \u00b7 wings ${pct(this.wingsWear(res))}`;
  }

  /** The save blob (a plain object), or null while nothing is worn. */
  serialize() {
    const s = this._s;
    if (!(s.wearEngineNs > 0) && !(s.wearBatteryCycles > 0) && !(s.wearWingAge < 1) && !(s.wearShipDays > 0)) return null;
    return { d: s.wearShipDays, e: s.wearEngineNs, b: s.wearBatteryCycles, w: s.wearWingAge };
  }

  /**
   * Load the wear. A save without it (an old one) sets `wearShipDays = shipDays`: no back-dated wear. The gas and height anchors
   * are dropped (the next poll takes them from the ship as loaded).
   * @param {object|null|undefined} saved the `serialize()` blob
   * @param {number} shipDays the ship days just loaded
   */
  restore(saved, shipDays) {
    const s = this._s;
    const n = (v, lo, hi, dflt) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
    const days = Number.isFinite(shipDays) && shipDays > 0 ? shipDays : 0;
    s.wearShipDays = saved && Number.isFinite(saved.d) ? n(saved.d, 0, days, days) : days;
    s.wearEngineNs = saved ? n(saved.e, 0, Infinity, 0) : 0;
    s.wearBatteryCycles = saved ? n(saved.b, 0, Infinity, 0) : 0;
    s.wearWingAge = saved ? n(saved.w, W().WING_FLOOR, 1, 1) : 1;
    s.wearAltKm = null;
    s.wearGasKg = null;
    s.wearGasId = null;
  }

  /** After a load: the wings' health starts at their age (ResourceSystem.restore set it to 1: impact damage is healed by a reload). */
  applyToResources(res) {
    if (!res) return;
    res.solarPanelHealth = this._s.wearWingAge;
    if (typeof res._syncToPlayer === 'function') res._syncToPlayer();
  }

  /** A new game / retry: every part new. */
  reset() {
    const s = this._s;
    s.wearShipDays = 0;
    s.wearEngineNs = 0;
    s.wearBatteryCycles = 0;
    s.wearWingAge = 1;
    s.wearAltKm = null;
    s.wearGasKg = null;
    s.wearGasId = null;
  }
}

export const shipWear = new ShipWear(gameState, eventBus);
export default shipWear;
