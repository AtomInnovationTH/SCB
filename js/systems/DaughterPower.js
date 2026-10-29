/**
 * DaughterPower — one daughter's battery and heat (owner 2026-10-28 23:20Z, DECISIONS §53 row 3: "Daughters get a battery
 * and heat (engine, gas valves, net launcher, aiming)"). A pure model: no DOM, no THREE. One instance per `ArmUnit`.
 *
 * Same clock and units as the mother's ledger (`ResourceSystem.billWatts`, `ThermalSystem`): `dt` is real seconds, and a
 * watt for a second is `1 / SHIP_HEAT.W_PER_UNIT_S` Wh (a watt moves 3.6 J per real second), so a 15 W load reads +15 W
 * and the mother's drop while she charges is exactly her gain ÷ CHARGE_EFF.
 *
 * What bills her pack (all only while she is out; docked, the mother pays every one of these marks with `billWatts` and she
 * charges instead: `motherLoadW`, DECISIONS §53 row 3):
 *   - her engine at its rated watts (ION_THRUSTER.BEAM_POWER_*), P × dt once per frame with any ion-fuel debit
 *     (`markEngine()`; DECISIONS-level pricing set by the coordinator 2026-10-29: the game's fast moves are impulse-priced,
 *     so every debit bills the engine at its rating for that frame, never more than P per frame),
 *   - engine hot standby, avionics and attitude (every undocked frame), aiming (turning faster than AIM_MIN_DEG_S),
 *     the cold-gas valves (`markGas()`, once per frame however many debits), the net launcher (`shot()`).
 * What fills it: sunlight on one long face (0 in Earth's shadow) and the mother's charge while docked.
 * Heat: one lump. In: sun on the lit face, Earth infrared, every watt she draws except 75 % of the engine's
 * (`ENGINE_HEAT_SHARE`, the rest leaves in the beam). Out: ε σ A T⁴. No heater, and nothing hangs on her temperature.
 *
 * @module systems/DaughterPower
 */

import { Constants } from '../core/Constants.js';
import { ENGINE_HEAT_SHARE, SIGMA } from './ThermalSystem.js';

const K0 = 273.15;
const EPS = 1e-9;

/** Body areas from the dimensions the daughters are built to: total surface, and the largest single face. */
function bodyAreas(dims) {
  const [a, b, c] = dims;
  const s = [a, b, c].sort((x, y) => y - x);
  return { totalM2: 2 * (a * b + a * c + b * c), faceM2: s[0] * s[1] };
}

/** The comms wording for a flat pack (the fuel wording stays where it is: test-DeployTap and test-TouchActionChip pin it). */
export function batteryFlatLine() { return 'Battery flat.'; }

export class DaughterPower {
  /** @param {{ type: 'weaver'|'spinner' }} o */
  constructor({ type = 'weaver' } = {}) {
    const DP = Constants.DAUGHTER_POWER;
    const IT = Constants.ION_THRUSTER;
    const weaver = type === 'weaver';
    this.type = weaver ? 'weaver' : 'spinner';
    const k = this.type;
    this.maxWh = DP.PACK_WH[k];
    this.engineW = weaver ? IT.BEAM_POWER_WEAVER : IT.BEAM_POWER_SPINNER;
    this.standbyW = DP.ENGINE_STANDBY_W[k];
    this.avionicsW = DP.AVIONICS_W[k];
    this.aimW = DP.AIM_W[k];
    this.valveW = DP.VALVE_W[k];
    this.solarW = DP.SOLAR_W[k];
    this.chargeW = DP.CHARGE_W[k];
    const mass = weaver ? Constants.V5_WEAVER_MASS : Constants.V5_SPINNER_MASS;
    const areas = bodyAreas(weaver ? Constants.WEAVER_BODY : Constants.SPINNER_BODY);
    /** @type {number} heat capacity of the lump, J/K */
    this.heatCapacityJPerK = mass * DP.HEAT.SPECIFIC_J_PER_KG_K;
    this.areaM2 = areas.totalM2;
    this.faceM2 = areas.faceM2;

    this.wh = this.maxWh;
    this.tempC = DP.HEAT.START_C;
    /** Wh drawn since built, by load kind (tests, telemetry). */
    this.drawnWh = { engine: 0, standby: 0, avionics: 0, aim: 0, valves: 0, launcher: 0 };
    this._flat = false;
    this._engineFlag = false;
    this._gasFlag = false;
    this._frameOutWh = 0;
    this._frameEngineWh = 0;
    this._frameInWh = 0;
    this._frameMotherWh = 0;
    this._outW = 0;
    this._inW = 0;
    /** @type {number} watts the mother pays this frame for the marks made while she sat docked (read by ArmUnit after `update`) */
    this.motherLoadW = 0;
    /** Wh the mother has paid for her docked marks since built, by load kind (tests). */
    this.motherWh = { engine: 0, aim: 0, valves: 0, launcher: 0 };
    this._pendingShots = 0;
  }

  /**
   * @returns {boolean} no energy left: thrusters, valves and the launcher are off (a tethered arm goes ADRIFT). Latched:
   * once flat she stays flat until the pack holds FLAT_RELEASE_FRAC again, so sunlight against her standby load does not
   * flicker her thrusters on and off.
   */
  get flat() { return this._flat || this.wh <= EPS; }

  /** Her engine fired this frame (any ion-fuel debit). Billed once, at the end of the frame, in `update`. */
  markEngine() { this._engineFlag = true; }

  /** Cold gas flowed this frame (any bottle debit). Billed once, at the end of the frame, in `update`. */
  markGas() { this._gasFlag = true; }

  /**
   * Draw `watts` for `dt` real seconds from the pack (clamped at empty). Returns the Wh actually drawn. With `fromMother` the
   * pack is untouched: the Wh are the mother's to pay (summed in `motherLoadW`), but they still heat her and show in her watts.
   * @param {number} watts
   * @param {number} dt
   * @param {'engine'|'standby'|'avionics'|'aim'|'valves'|'launcher'} kind
   * @param {boolean} [fromMother]
   */
  bill(watts, dt, kind, fromMother = false) {
    if (!(watts > 0) || !(dt > 0)) return 0;
    const want = watts * dt / Constants.SHIP_HEAT.W_PER_UNIT_S;
    if (fromMother) {
      this._frameOutWh += want;
      if (kind === 'engine') this._frameEngineWh += want;
      this._frameMotherWh += want;
      this.motherWh[kind] = (this.motherWh[kind] || 0) + want;
      return want;
    }
    const got = Math.min(want, Math.max(0, this.wh));
    this.wh -= got;
    this._frameOutWh += got;
    if (kind === 'engine') this._frameEngineWh += got;
    this.drawnWh[kind] = (this.drawnWh[kind] || 0) + got;
    return got;
  }

  /**
   * One net shot: LAUNCHER_W for LAUNCHER_S (2.5 J). Returns the Wh drawn. `docked`: she sits on her strut, so the mother pays it
   * (with this frame's other docked marks, `motherLoadW`).
   */
  shot(docked = false) {
    const DP = Constants.DAUGHTER_POWER;
    if (docked) {
      this._pendingShots++;
      return 0;
    }
    return this.bill(DP.LAUNCHER_W, DP.LAUNCHER_S, 'launcher');
  }

  /**
   * Watts she asks of the mother this frame to charge: CHARGE_W, less when the pack has less room than a full frame's
   * worth. 0 when full.
   */
  chargeRequestW(dt) {
    if (!(dt > 0)) return 0;
    const room = Math.max(0, this.maxWh - this.wh);
    if (room <= EPS) return 0;
    const eff = Constants.DAUGHTER_POWER.CHARGE_EFF;
    return Math.min(this.chargeW, room * Constants.SHIP_HEAT.W_PER_UNIT_S / (dt * eff));
  }

  /**
   * Store what the mother actually supplied this frame (`drawnWh` out of her battery): the pack gains CHARGE_EFF of it.
   * Returns the Wh stored.
   */
  store(drawnWh) {
    if (!(drawnWh > 0)) return 0;
    const gain = Math.min(drawnWh * Constants.DAUGHTER_POWER.CHARGE_EFF, Math.max(0, this.maxWh - this.wh));
    this.wh += gain;
    this._frameInWh += gain;
    return gain;
  }

  /** `W` watts supplied by the mother for `dt` s (units = W ÷ W_PER_UNIT_S × dt). Returns the Wh stored. */
  charge(watts, dt) {
    if (!(watts > 0) || !(dt > 0)) return 0;
    return this.store(watts * dt / Constants.SHIP_HEAT.W_PER_UNIT_S);
  }

  /**
   * One frame: bills the loads, adds solar, advances the heat lump, smooths the watts.
   * @param {number} dt real seconds
   * @param {{inSun?: boolean, docked?: boolean, turnDegS?: number}} [o]
   *   `docked`: on her strut (the mother pays, nothing is billed to the pack); `turnDegS`: how fast she turned this frame
   */
  update(dt, { inSun = false, docked = false, turnDegS = 0 } = {}) {
    if (!(dt > 0)) return;
    const DP = Constants.DAUGHTER_POWER;
    if (this.wh <= EPS) this._flat = true;   // flat when the frame starts (a pack set or loaded empty latches too)
    if (!docked) {
      this.bill(this.standbyW, dt, 'standby');
      this.bill(this.avionicsW, dt, 'avionics');
    }
    // the marks (aiming, valves, engine): her pack pays out, the mother pays docked (never nobody, never her pack)
    if (turnDegS > DP.AIM_MIN_DEG_S) this.bill(this.aimW, dt, 'aim', docked);
    if (this._gasFlag) this.bill(this.valveW, dt, 'valves', docked);
    if (this._engineFlag) this.bill(this.engineW, dt, 'engine', docked);
    for (; this._pendingShots > 0; this._pendingShots--) {           // shots fired on the strut: the mother's, or hers if she has left since
      this.bill(DP.LAUNCHER_W, DP.LAUNCHER_S, 'launcher', docked);
    }
    this.motherLoadW = this._frameMotherWh * Constants.SHIP_HEAT.W_PER_UNIT_S / dt;
    this._frameMotherWh = 0;
    this._engineFlag = false;
    this._gasFlag = false;

    if (inSun && this.solarW > 0) this.store0(this.solarW * dt / Constants.SHIP_HEAT.W_PER_UNIT_S);
    this._heat(dt, inSun);
    if (this.wh <= EPS) this._flat = true;
    else if (this._flat && this.wh >= DP.FLAT_RELEASE_FRAC * this.maxWh) this._flat = false;

    const SH = Constants.SHIP_HEAT;
    const k = SH.W_PER_UNIT_S / dt;
    const a = 1 - Math.exp(-dt / SH.POWER_TAU_S);
    this._outW += (this._frameOutWh * k - this._outW) * a;
    this._inW += (this._frameInWh * k - this._inW) * a;
    this._frameOutWh = 0;
    this._frameEngineWh = 0;
    this._frameInWh = 0;
  }

  /** Solar into the pack, no efficiency loss (the 13 / 3 W are what reaches the cells' output). @private */
  store0(wh) {
    const gain = Math.min(wh, Math.max(0, this.maxWh - this.wh));
    this.wh += gain;
    this._frameInWh += gain;
  }

  /**
   * Closed-form equilibrium temperature (°C) for a constant electrical draw `elecW` (already net of the engine's beam
   * share) in sun or shadow (tests).
   */
  equilibriumC(elecW, inSun) {
    const H = Constants.DAUGHTER_POWER.HEAT;
    const inW = this._envInW(inSun) + elecW;
    return Math.pow(inW / (H.EMISSIVITY * SIGMA * this.areaM2), 0.25) - K0;
  }

  /** @private environment heat in, W: sun on the lit face + Earth infrared on a quarter of the area. */
  _envInW(inSun) {
    const H = Constants.DAUGHTER_POWER.HEAT;
    let w = H.EARTH_IR_W_M2 * this.areaM2 / 4 * H.EMISSIVITY;
    if (inSun) w += H.SUN_ABSORPTIVITY * this.faceM2 * H.SOLAR_FLUX_W_M2;
    return w;
  }

  /**
   * The lump, on the battery's clock (like ThermalSystem: dt × UNIT_J / W_PER_UNIT_S clock seconds), sub-stepped ≤ 2 s.
   * @private
   */
  _heat(dt, inSun) {
    const SH = Constants.SHIP_HEAT;
    const H = Constants.DAUGHTER_POWER.HEAT;
    const clockS = dt * (SH.UNIT_J / SH.W_PER_UNIT_S);
    const elecWh = Math.max(0, this._frameOutWh - (1 - ENGINE_HEAT_SHARE) * this._frameEngineWh);
    const qElecJ = elecWh * SH.UNIT_J;
    const envW = this._envInW(inSun);
    const steps = Math.max(1, Math.ceil(clockS / 2));
    const h = clockS / steps;
    for (let i = 0; i < steps; i++) {
      const tK = this.tempC + K0;
      const outW = H.EMISSIVITY * SIGMA * this.areaM2 * tK * tK * tK * tK;
      this.tempC += ((envW - outW) * h + qElecJ / steps) / this.heatCapacityJPerK;
    }
  }

  /** @returns {{wh:number, maxWh:number, frac:number, outW:number, inW:number, tempC:number, flat:boolean}} */
  snapshot() {
    return {
      wh: this.wh,
      maxWh: this.maxWh,
      frac: this.maxWh > 0 ? this.wh / this.maxWh : 0,
      outW: this._outW,
      inW: this._inW,
      tempC: this.tempC,
      flat: this.flat,
    };
  }

  /** Full and 20 °C (a new game, a refit, a respawned daughter). */
  reset() {
    this.wh = this.maxWh;
    this.tempC = Constants.DAUGHTER_POWER.HEAT.START_C;
    this._flat = false;
    this._engineFlag = false;
    this._gasFlag = false;
    this._frameOutWh = this._frameEngineWh = this._frameInWh = this._frameMotherWh = 0;
    this._pendingShots = 0;
    this.motherLoadW = 0;
    this._outW = this._inW = 0;
  }

  /** @returns {{wh:number, tempC:number}} what is saved. */
  save() { return { wh: this.wh, tempC: this.tempC }; }

  /**
   * Restore a saved pack. A missing or malformed field → full / 20 °C (never NaN, never over the pack).
   * @param {{wh?: any, tempC?: any}|null|undefined} s
   */
  restore(s) {
    const H = Constants.DAUGHTER_POWER.HEAT;
    const wh = s && typeof s.wh === 'number' && Number.isFinite(s.wh) ? s.wh : this.maxWh;
    const t = s && typeof s.tempC === 'number' && Number.isFinite(s.tempC) ? s.tempC : H.START_C;
    this.wh = Math.min(this.maxWh, Math.max(0, wh));
    this.tempC = Math.min(300, Math.max(-270, t));
    this._flat = this.wh <= EPS;
    this._engineFlag = false;
    this._gasFlag = false;
    this._frameOutWh = this._frameEngineWh = this._frameInWh = this._frameMotherWh = 0;
    this._pendingShots = 0;
    this.motherLoadW = 0;
    this._outW = this._inW = 0;
  }
}
