/**
 * ThermalSystem.js — the ship's heat (w2-heat, 2026-10-08).
 *
 * DECISIONS §15 rows 2/4/5/6 + §2 rows 5–7: the ship heats up from what the
 * player does (every watt drawn from the battery ends as heat), warns at
 * 60 °C (yellow) and 85 °C (red), and opens its radiator by itself at 70 °C —
 * a little late on purpose, the player could have opened it sooner (O).
 *
 * One lump, on the battery's own clock (Constants.SHIP_HEAT — every constant
 * carries its physical reading there):
 *
 *   C dT/dt = P_in − P_out
 *   P_in  = drawn battery energy (ResourceSystem ledger) + SUN_HULL_W in daylight
 *   P_out = σ ε A_eff (T⁴ − T_sink⁴),
 *   A_eff = A_hull + A_rad × (G_closed + (1 − G_closed) × openFrac)
 *
 * Ticked by the game loop right after resourceSystem.update(dt), under the
 * same held-world guard, so heat stops whenever the world clock does; held
 * frames call skipHeld() so battery billed meanwhile never heats the ship.
 * Reset with the battery (ResourceSystem.reset()/restore() call reset()).
 *
 * Speaks only through Events.COMMS_MESSAGE (sender 'THERMAL'). The auto
 * radiator calls player.setFlowerPose() ONLY — it never emits
 * THERMAL_FLOWER_INPUT (that event means "the player commanded the radiator";
 * the codex unlocks on it). A player command always wins: one seen in the
 * last PLAYER_WINS_S blocks the auto-open, and the auto never folds a radiator
 * the player opened.
 *
 * @module systems/ThermalSystem
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

/** Stefan–Boltzmann constant, W/(m²·K⁴). */
export const SIGMA = 5.670374419e-8;
const K0 = 273.15;

export class ThermalSystem {
  /**
   * @param {{ resourceSystem?: object|null, player?: object|null }} [deps]
   *   resourceSystem — the power ledger (getEnergyDrawnUnits); this registers
   *   itself there with setThermalSource(this). player — PlayerSatellite:
   *   getFlowerStatus().openFrac, setFlowerPose(name), _inShadow.
   */
  constructor({ resourceSystem = null, player = null } = {}) {
    this._rs = resourceSystem;
    this._player = player;

    /** @type {number} lump temperature, °C */
    this.tempC = 0;
    /** @private real seconds of ticked (un-held) play — the auto controller's clock */
    this._clockS = 0;
    /** @private last seen ledger total (units) */
    this._lastDrawnUnits = 0;
    /** @private smoothed dT/dt, °C per real second */
    this._rateCps = 0;
    /** @private */
    this._yellowArmed = true;
    /** @private */
    this._redArmed = true;
    /** @private true from an auto-open until the auto-close or any player command */
    this._autoOpened = false;
    /** @private clock time of the last player radiator command */
    this._lastPlayerCmdS = -Infinity;
    /** @private real seconds held at/below AUTO_CLOSE_C while auto-opened */
    this._coolHoldS = 0;

    this._onPlayerCmd = () => {
      this._lastPlayerCmdS = this._clockS;
      this._autoOpened = false;   // the player took the radiator — the auto lets go
      this._coolHoldS = 0;
    };
    eventBus.on(Events.THERMAL_FLOWER_INPUT, this._onPlayerCmd);

    if (resourceSystem && typeof resourceSystem.setThermalSource === 'function') {
      resourceSystem.setThermalSource(this);
    }
    this.reset();
  }

  // ======================================================================
  // PHYSICS
  // ======================================================================

  /**
   * Effective radiating area (ε-weighted m²) at an open fraction.
   * @param {number} openFrac 0 folded … 1 full bloom
   * @returns {number}
   */
  effectiveAreaM2(openFrac) {
    const SH = Constants.SHIP_HEAT;
    const f = Math.max(0, Math.min(1, openFrac || 0));
    return SH.HULL_AREA_M2 + SH.RAD_AREA_M2 * (SH.G_CLOSED + (1 - SH.G_CLOSED) * f);
  }

  /**
   * Radiated power (W) at `tempC` and an open fraction.
   * @param {number} tempC
   * @param {number} openFrac
   * @returns {number}
   */
  radiatedW(tempC, openFrac) {
    const SH = Constants.SHIP_HEAT;
    const T = tempC + K0;
    const Ts = SH.SINK_K;
    return SIGMA * SH.EMISSIVITY * this.effectiveAreaM2(openFrac) * (T ** 4 - Ts ** 4);
  }

  /**
   * Steady-state temperature (°C) for a constant heat input.
   * @param {number} powerW - total heat in (electrical + sun), W
   * @param {number} [openFrac=0]
   * @returns {number}
   */
  equilibriumC(powerW, openFrac = 0) {
    const SH = Constants.SHIP_HEAT;
    const t4 = Math.max(0, powerW) / (SIGMA * SH.EMISSIVITY * this.effectiveAreaM2(openFrac))
      + SH.SINK_K ** 4;
    return t4 ** 0.25 - K0;
  }

  // ======================================================================
  // PER-FRAME
  // ======================================================================

  /**
   * Advance the lump by `dt` real seconds (the battery's clock — SHIP_HEAT
   * UNIT_J / W_PER_UNIT_S = 3.6 J per watt per real second). Call only while
   * the world runs (main.js ticks it under the `_worldHeld` guard).
   * @param {number} dt - real seconds (slow-mo scaled, like resourceSystem.update)
   */
  update(dt) {
    if (!(dt > 0)) return;
    const SH = Constants.SHIP_HEAT;
    this._clockS += dt;
    const before = this.tempC;

    // Heat in: every battery unit drawn since the last tick (drawn watts end
    // as heat — D3), plus the sun on the hull in daylight.
    let qInJ = 0;
    const rs = this._rs;
    if (rs && typeof rs.getEnergyDrawnUnits === 'function') {
      const total = rs.getEnergyDrawnUnits();
      const d = total - this._lastDrawnUnits;
      this._lastDrawnUnits = total;
      if (d > 0) qInJ += d * SH.UNIT_J;
    }
    const clockS = dt * (SH.UNIT_J / SH.W_PER_UNIT_S);   // battery-clock seconds
    if (!this._inShadow()) qInJ += SH.SUN_HULL_W * clockS;

    // Integrate (explicit, sub-stepped: τ ≥ ~200 battery-clock s, steps ≤ 2 s).
    const openFrac = this._openFrac();
    const steps = Math.max(1, Math.ceil(clockS / 2));
    const hStep = clockS / steps;
    const qStep = qInJ / steps;
    for (let i = 0; i < steps; i++) {
      const qOut = this.radiatedW(this.tempC, openFrac) * hStep;
      this.tempC += (qStep - qOut) / SH.HEAT_CAPACITY_J_PER_K;
    }

    // Trend: smoothed dT/dt in °C per real second.
    const a = 1 - Math.exp(-dt / SH.TREND_TAU_S);
    this._rateCps += ((this.tempC - before) / dt - this._rateCps) * a;

    this._updateLines(openFrac);
    this._updateAutoRadiator(dt, openFrac);
  }

  /**
   * A held-world frame (main.js calls this instead of update while
   * `_worldHeld`): heat is paused, and whatever the battery bills meanwhile
   * (the base load keeps running in player.update) never heats the ship —
   * the ledger counter is moved past it, so release lands no spike.
   */
  skipHeld() {
    const rs = this._rs;
    if (rs && typeof rs.getEnergyDrawnUnits === 'function') {
      this._lastDrawnUnits = rs.getEnergyDrawnUnits();
    }
  }

  // ======================================================================
  // SNAPSHOT / RESET
  // ======================================================================

  /**
   * The heat meter's numbers (ResourceSystem.getThermalSnapshot forwards this).
   * @returns {{tempC:number, band:'green'|'yellow'|'red', trend:-1|0|1, autoOpened:boolean}}
   */
  getSnapshot() {
    const SH = Constants.SHIP_HEAT;
    const t = this.tempC;
    const band = t >= SH.RED_C ? 'red' : (t >= SH.YELLOW_C ? 'yellow' : 'green');
    const trend = this._rateCps > SH.TREND_C_PER_S ? 1 : (this._rateCps < -SH.TREND_C_PER_S ? -1 : 0);
    return { tempC: t, band, trend, autoOpened: this._autoOpened };
  }

  /**
   * New game / retry / fresh mission: back to the closed daylight equilibrium
   * for the base load (the needle sits still until the player acts), lines
   * re-armed, the auto controller cleared. Draws made before the reset do not
   * heat the new run (the ledger counter is re-synced).
   */
  reset() {
    const SH = Constants.SHIP_HEAT;
    this.tempC = this.equilibriumC(SH.START_LOAD_W + SH.SUN_HULL_W, 0);
    this._rateCps = 0;
    this._yellowArmed = true;
    this._redArmed = true;
    this._autoOpened = false;
    this._lastPlayerCmdS = -Infinity;
    this._coolHoldS = 0;
    this._clockS = 0;
    const rs = this._rs;
    this._lastDrawnUnits = (rs && typeof rs.getEnergyDrawnUnits === 'function')
      ? rs.getEnergyDrawnUnits() : 0;
  }

  /** Drop the bus listener and the registration (tests, re-wiring). */
  dispose() {
    eventBus.off(Events.THERMAL_FLOWER_INPUT, this._onPlayerCmd);
    if (this._rs && typeof this._rs.getThermalSource === 'function'
        && this._rs.getThermalSource() === this) {
      this._rs.setThermalSource(null);
    }
  }

  // ======================================================================
  // PRIVATE
  // ======================================================================

  /** @private openFrac per the w2-start-pose contract (0 folded … 1 bloom); no flower → 0 */
  _openFrac() {
    const p = this._player;
    const st = (p && typeof p.getFlowerStatus === 'function') ? p.getFlowerStatus() : null;
    const f = st ? st.openFrac : 0;
    return Number.isFinite(f) ? Math.max(0, Math.min(1, f)) : 0;
  }

  /** @private PlayerSatellite has no public getter; _updateSolarPower caches it */
  _inShadow() {
    return !!(this._player && this._player._inShadow);
  }

  /** @private once per crossing, re-armed REARM_C below (D4) */
  _updateLines(openFrac) {
    const SH = Constants.SHIP_HEAT;
    const t = this.tempC;
    const open = openFrac > SH.AT_REST_FRAC;
    if (t >= SH.RED_C && this._redArmed) {
      this._redArmed = false;
      this._yellowArmed = false;   // one line for one jump — never both in a frame
      this._say(open
        ? `Ship hot — ${SH.RED_C} °C. The radiator is open — ease off the load.`
        : `Ship hot — ${SH.RED_C} °C. Open the radiator now.`, 'warning');
    } else if (t >= SH.YELLOW_C && this._yellowArmed) {
      this._yellowArmed = false;
      this._say(open
        ? `Ship warming up — ${SH.YELLOW_C} °C. The radiator is already open.`
        : `Ship warming up — ${SH.YELLOW_C} °C. The radiator is folded. Press O to open it.`, 'warning');
    }
    if (!this._yellowArmed && t <= SH.YELLOW_C - SH.REARM_C) this._yellowArmed = true;
    if (!this._redArmed && t <= SH.RED_C - SH.REARM_C) this._redArmed = true;
  }

  /** @private D5 — open late by itself, fold back only what it opened */
  _updateAutoRadiator(dt, openFrac) {
    const SH = Constants.SHIP_HEAT;
    const p = this._player;
    if (!p || typeof p.setFlowerPose !== 'function') return;
    const ls = p._launchSequence;
    if (ls && typeof ls.isActive === 'function' && ls.isActive()) return;   // the launch owns the ship

    if (this._autoOpened) {
      if (this.tempC <= SH.AUTO_CLOSE_C) {
        this._coolHoldS += dt;
        if (this._coolHoldS >= SH.AUTO_CLOSE_HOLD_S) {
          const rest = (Constants.THERMAL && Constants.THERMAL.FLOWER
            && Constants.THERMAL.FLOWER.REST_POSE) || 'STOW';
          p.setFlowerPose(rest);
          this._autoOpened = false;
          this._coolHoldS = 0;
          this._say('Cool again — folding the radiator.', 'info');
        }
      } else {
        this._coolHoldS = 0;
      }
      return;
    }

    const playerRecent = (this._clockS - this._lastPlayerCmdS) < SH.PLAYER_WINS_S;
    if (this.tempC >= SH.AUTO_OPEN_C && openFrac <= SH.AT_REST_FRAC && !playerRecent) {
      if (p.setFlowerPose('CARGO') === null) return;   // no radiator fitted — nothing to open
      this._autoOpened = true;
      this._coolHoldS = 0;
      this._say('Too hot — opening the radiator.', 'warning');
    }
  }

  /**
   * @private One THERMAL comms line. Warnings carry `_critical` (the
   * low-battery/xenon pattern) so they pass the onboarding suppression tier —
   * mission 1 must hear them (§15 row 6), and a radiator that opens by itself
   * must say why. The 'info' fold-back line obeys the mute like any other.
   */
  _say(text, priority) {
    const msg = { sender: 'THERMAL', text, priority };
    if (priority === 'warning') msg._critical = true;
    eventBus.emit(Events.COMMS_MESSAGE, msg);
  }
}

export default ThermalSystem;
