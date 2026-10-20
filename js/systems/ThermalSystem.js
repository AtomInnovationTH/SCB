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
 *   A_eff = A_hull + A_rad × (G_closed + (1 − G_closed) × openFrac) × flow
 *
 * L4 radiator-loop (owner 2026-10-20, "a radiator can be open without
 * transferring heat; on a running engine without cooling it"): the radiators
 * shed the ship's heat only while the coolant flows. `flow` (0…1) is the
 * ship's own thermostat valve (`loopFlow`): 0 at or below LOOP_OFF_C (20 °C),
 * 1 at or above LOOP_FULL_C (30 °C), linear between. With flow 0 the
 * radiators — folded or open — shed nothing; only the bare hull leaks. The
 * player has no control over the loop (no pump draw yet — a follow-up).
 *
 * Ticked by the game loop right after resourceSystem.update(dt), under the
 * same held-world guard, so heat stops whenever the world clock does; held
 * frames call skipHeld() so battery billed meanwhile never heats the ship.
 * Reset with the battery (ResourceSystem.reset()/restore() call reset()).
 *
 * w4-power D7 (2026-10-12): below HEATER.HOLD_C (0 °C) the battery heaters
 * draw what holds it (capped at HEATER.MAX_W), billed through the battery —
 * `_updateHeater`. Its one line is visible in mission 1 (`_critical`, though
 * priority 'info') because the heaters cost battery. Since L4 radiator-loop the
 * coolant stops well above HOLD_C (LOOP_OFF_C 20 °C), so an open radiator no
 * longer pulls the ship down to the heaters; they run only when the ship is
 * cold for another reason (a long eclipse with nothing drawn).
 *
 * Speaks only through Events.COMMS_MESSAGE (sender 'THERMAL'). The auto
 * radiator calls player.setFlowerPose() ONLY — it never emits
 * THERMAL_FLOWER_INPUT (that event means "the player commanded the radiator";
 * the codex unlocks on it). A player command always wins: one seen in the
 * last PLAYER_WINS_S blocks the auto-open, and the auto never folds a radiator
 * at all: it opens to the OPEN pose (146°) and leaves it there.
 * During a catch hand-off hold it does not call setFlowerPose at all (the
 * hold refuses every pose and the ship would speak the player's refusal line);
 * it opens after the hold ends.
 *
 * @module systems/ThermalSystem
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { GestureHints } from '../ui/hud/GestureHints.js';

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
    /** @private true from an auto-open until any player command (it never auto-closes) */
    this._autoOpened = false;
    /** @private clock time of the last player radiator command */
    this._lastPlayerCmdS = -Infinity;
    /** w4-power D7: the heater's draw this tick, W (0 when warm / disabled) */
    this.heaterW = 0;
    /** @private battery units the heater billed since the last tick (taken out of "other heat in") */
    this._heaterUnits = 0;
    /** @private play seconds (this._clockS — held and paused frames excluded) the heater has run since the last line */
    this._heaterRunGameS = 0;
    /** @private this._clockS at the last heater line */
    this._heaterLineAtS = -Infinity;

    this._onPlayerCmd = () => {
      this._lastPlayerCmdS = this._clockS;
      this._autoOpened = false;   // the player took the radiator — the auto lets go
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
   * L4 radiator-loop: how much of the radiator surface the coolant reaches
   * (0…1) — the ship's thermostat valve. 0 at or below LOOP_OFF_C, 1 at or
   * above LOOP_FULL_C, linear between. Pure; the heaters (HOLD_C) sit well
   * below LOOP_OFF_C, so the two never overlap.
   * @param {number} tempC - lump temperature, °C
   * @returns {number}
   */
  loopFlow(tempC) {
    const SH = Constants.SHIP_HEAT;
    const off = SH.LOOP_OFF_C;
    const full = SH.LOOP_FULL_C;
    if (!Number.isFinite(tempC)) return 0;
    if (!(full > off)) return tempC >= full ? 1 : 0;
    return Math.max(0, Math.min(1, (tempC - off) / (full - off)));
  }

  /**
   * Effective radiating area (ε-weighted m²) at an open fraction and a loop
   * flow. With flow 0 the radiators — folded or open — add nothing (no leak
   * term: a dry radiator is just a plate hanging off the ship).
   * @param {number} openFrac 0 folded … 1 full bloom
   * @param {number} [flow=1] coolant flow fraction 0…1 (`loopFlow`); 1 = loop fully open
   * @returns {number}
   */
  effectiveAreaM2(openFrac, flow = 1) {
    const SH = Constants.SHIP_HEAT;
    const f = Math.max(0, Math.min(1, openFrac || 0));
    const q = Number.isFinite(flow) ? Math.max(0, Math.min(1, flow)) : 1;
    return SH.HULL_AREA_M2 + SH.RAD_AREA_M2 * (SH.G_CLOSED + (1 - SH.G_CLOSED) * f) * q;
  }

  /**
   * Radiated power (W) at `tempC`, an open fraction and a loop flow.
   * @param {number} tempC
   * @param {number} openFrac
   * @param {number} [flow=this.loopFlow(tempC)] pass 1 to size the worst case (loop stuck open)
   * @returns {number}
   */
  radiatedW(tempC, openFrac, flow = this.loopFlow(tempC)) {
    const SH = Constants.SHIP_HEAT;
    const T = tempC + K0;
    const Ts = SH.SINK_K;
    return SIGMA * SH.EMISSIVITY * this.effectiveAreaM2(openFrac, flow) * (T ** 4 - Ts ** 4);
  }

  /**
   * Steady-state temperature (°C) for a constant heat input. With `flow`
   * omitted the thermostat rule applies: the answer depends on T, so it is
   * bisected (radiatedW rises with T, so there is exactly one root). With
   * `flow` given it is the closed form at that fixed flow.
   * @param {number} powerW - total heat in (electrical + sun), W
   * @param {number} [openFrac=0]
   * @param {number|null} [flow=null] a fixed loop flow 0…1, or null for the thermostat rule
   * @returns {number}
   */
  equilibriumC(powerW, openFrac = 0, flow = null) {
    const SH = Constants.SHIP_HEAT;
    const p = Math.max(0, powerW);
    if (flow !== null && flow !== undefined) {
      const t4 = p / (SIGMA * SH.EMISSIVITY * this.effectiveAreaM2(openFrac, flow)) + SH.SINK_K ** 4;
      return t4 ** 0.25 - K0;
    }
    // Radiated power is 0 at the sink temperature and only grows with T, so the root lies between
    // the sink and the hull-only answer (the smallest area there is).
    let lo = SH.SINK_K - K0;
    let hi = (p / (SIGMA * SH.EMISSIVITY * this.effectiveAreaM2(0, 0)) + SH.SINK_K ** 4) ** 0.25 - K0;
    for (let i = 0; i < 80; i++) {
      const mid = 0.5 * (lo + hi);
      if (this.radiatedW(mid, openFrac) < p) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
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
    // as heat — D3), plus the sun on the hull in daylight. The heater's own
    // draw (billed at the end of the last tick) is in `d` too — its heat is
    // what warms the ship — but it is NOT "other heat in" for its controller.
    let qInJ = 0;
    let otherJ = 0;
    const rs = this._rs;
    if (rs && typeof rs.getEnergyDrawnUnits === 'function') {
      const total = rs.getEnergyDrawnUnits();
      const d = total - this._lastDrawnUnits;
      this._lastDrawnUnits = total;
      if (d > 0) {
        qInJ += d * SH.UNIT_J;
        otherJ += Math.max(0, d - this._heaterUnits) * SH.UNIT_J;
      }
    }
    this._heaterUnits = 0;
    const clockS = dt * (SH.UNIT_J / SH.W_PER_UNIT_S);   // battery-clock seconds
    if (!this._inShadow()) {
      qInJ += SH.SUN_HULL_W * clockS;
      otherJ += SH.SUN_HULL_W * clockS;
    }

    // Integrate (explicit, sub-stepped: τ ≥ ~200 battery-clock s, steps ≤ 2 s). radiatedW reads the loop's
    // flow at each sub-step's own temperature (L4: the valve follows the ship, slope ≤ ~230 W/K → 2 s × 230 / C ≈ 0.03, stable).
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
    this._updateHeater(dt, openFrac, clockS > 0 ? otherJ / clockS : 0);
  }

  /**
   * w4-power D7 — the battery heaters (Constants.HEATER). Below HOLD_C they
   * draw what holds HOLD_C: the power the lump radiates now, minus every other
   * heat input (`otherW` — electrical draw + sun), plus a pull C/PULL_S W per K
   * toward HOLD_C. That is continuous through HOLD_C (it fades to 0 within
   * ~1 K above it), so there is no on/off flicker, and when uncapped the lump
   * settles at exactly HOLD_C. Capped at MAX_W; billed through the battery
   * (ResourceSystem.billWatts) so its heat arrives through the ledger next
   * tick. One comms line after LINE_AFTER_S of running, at most once per
   * LINE_EVERY_S. No auto-close (owner ruling 2026-10-09).
   * @param {number} dt - real seconds
   * @param {number} openFrac
   * @param {number} otherW - non-heater heat in this tick, W
   * @returns {number} the heater's watts this tick
   * @private
   */
  _updateHeater(dt, openFrac, otherW) {
    const H = Constants.HEATER;
    const SH = Constants.SHIP_HEAT;
    let w = 0;
    if (H && H.ENABLED && this.tempC < H.HOLD_C + 2) {
      const pullWPerK = SH.HEAT_CAPACITY_J_PER_K / Math.max(1e-3, H.PULL_S);
      w = this.radiatedW(this.tempC, openFrac) - otherW + pullWPerK * (H.HOLD_C - this.tempC);
      w = Math.max(0, Math.min(H.MAX_W, w));
    }
    this.heaterW = w;
    if (!(w > 0)) return 0;
    const rs = this._rs;
    if (rs && typeof rs.billWatts === 'function') this._heaterUnits += rs.billWatts(w, dt);
    else if (rs && typeof rs.drawUpTo === 'function') {
      this._heaterUnits += rs.drawUpTo('battery', (w / SH.W_PER_UNIT_S) * dt);
    }
    // The line: 10 s of running, at most once per 5 min of play.
    this._heaterRunGameS += dt;
    if (this._heaterRunGameS >= H.LINE_AFTER_S
        && this._clockS - this._heaterLineAtS >= H.LINE_EVERY_S) {
      this._heaterLineAtS = this._clockS;
      this._heaterRunGameS = 0;
      // L4 radiator-loop: folding the radiator no longer saves anything (the coolant is already off at this temperature).
      this._say(`Ship cold — battery heaters on, ${Math.round(w)} W, keeping the cells above freezing.`, 'info', { critical: true });
    }
    return w;
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
   * `flow` (L4): the coolant loop's flow fraction 0…1 (0 = the radiators shed nothing).
   * @returns {{tempC:number, band:'green'|'yellow'|'red', trend:-1|0|1, autoOpened:boolean, flow:number}}
   */
  getSnapshot() {
    const SH = Constants.SHIP_HEAT;
    const t = this.tempC;
    const band = t >= SH.RED_C ? 'red' : (t >= SH.YELLOW_C ? 'yellow' : 'green');
    const trend = this._rateCps > SH.TREND_C_PER_S ? 1 : (this._rateCps < -SH.TREND_C_PER_S ? -1 : 0);
    return { tempC: t, band, trend, autoOpened: this._autoOpened, flow: this.loopFlow(t) };
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
    this._clockS = 0;
    this.heaterW = 0;
    this._heaterUnits = 0;
    this._heaterRunGameS = 0;
    this._heaterLineAtS = -Infinity;
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
        // u5-info-ap-hold D5: no key and no floor-1 button named (the same words on touch): say what will happen.
        : this._autoOpenArmed(openFrac)
          ? `Ship warming up — ${SH.YELLOW_C} °C. The radiator opens itself at ${SH.AUTO_OPEN_C} °C.`
          : `Ship warming up — ${SH.YELLOW_C} °C. The radiator is folded.`, 'warning');
    }
    if (!this._yellowArmed && t <= SH.YELLOW_C - SH.REARM_C) this._yellowArmed = true;
    if (!this._redArmed && t <= SH.RED_C - SH.REARM_C) this._redArmed = true;
  }

  /**
   * @private u5 D5: would the radiator open itself once the ship reaches AUTO_OPEN_C? One answer for the
   * self-open code and for the 60 °C line: a radiator fitted, folded (at rest), not already auto-opened,
   * no player radiator command in the last PLAYER_WINS_S, no launch driving the ship, no catch hand-off hold.
   * @param {number} openFrac
   * @returns {boolean}
   */
  _autoOpenArmed(openFrac) {
    const SH = Constants.SHIP_HEAT;
    const p = this._player;
    if (!p || typeof p.setFlowerPose !== 'function') return false;
    if (typeof p.getFlowerStatus === 'function' && !p.getFlowerStatus()) return false;   // no radiator fitted
    const ls = p._launchSequence;
    if (ls && typeof ls.isActive === 'function' && ls.isActive()) return false;           // the launch owns the ship
    if (p.flowerHandoffHeld === true) return false;
    if (this._autoOpened) return false;
    if ((this._clockS - this._lastPlayerCmdS) < SH.PLAYER_WINS_S) return false;
    return openFrac <= SH.AT_REST_FRAC;
  }

  /**
   * @private D5 — open late by itself, to the OPEN pose (146°, DECISIONS §15
   * "Radiator angles"), and leave it there: once open it stays open — the
   * auto NEVER folds it back (owner 2026-10-09; it used to at ≤ 35 °C). Only
   * the player folds it, and the 30 s re-open at ≥ 70 °C after that is
   * unchanged (PLAYER_WINS_S).
   */
  _updateAutoRadiator(dt, openFrac) {
    const SH = Constants.SHIP_HEAT;
    const p = this._player;
    if (!p || typeof p.setFlowerPose !== 'function') return;
    const ls = p._launchSequence;
    if (ls && typeof ls.isActive === 'function' && ls.isActive()) return;   // the launch owns the ship
    // A catch hand-off hold refuses every pose and would make setFlowerPose speak the player's refusal line; wait it out (opens after the hold ends).
    if (p.flowerHandoffHeld === true) return;

    if (this._autoOpened) return;   // it opened once and stays open

    if (this.tempC >= SH.AUTO_OPEN_C && this._autoOpenArmed(openFrac)) {
      const open = (Constants.THERMAL && Constants.THERMAL.FLOWER
        && Constants.THERMAL.FLOWER.OPEN_POSE) || 'STOW';
      if (p.setFlowerPose(open) === null) return;   // no radiator fitted — nothing to open
      this._autoOpened = true;
      this._say('Too hot — opening the radiator.', 'warning');
    }
  }

  /**
   * @private One THERMAL comms line. Warnings carry `_critical` (the
   * low-battery/xenon pattern) so they pass the onboarding suppression tier —
   * mission 1 must hear them (§15 row 6), and a radiator that opens by itself
   * must say why. w4-power D3: the text goes through GestureHints.speak (it
   * rewrites key words for glass; u5 D5: no line here names a key any more).
   */
  _say(text, priority, opts) {
    const msg = { sender: 'THERMAL', text: GestureHints.speak(text), priority };
    if (priority === 'warning' || (opts && opts.critical)) msg._critical = true;
    eventBus.emit(Events.COMMS_MESSAGE, msg);
  }
}

export default ThermalSystem;
