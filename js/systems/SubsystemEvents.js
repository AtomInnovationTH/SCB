/**
 * SubsystemEvents.js — spacecraft subsystem event generators for ambient learning. Six lightweight subsystems (Comms,
 * Navigation, Attitude, Power, Avionics, Degradation; archive/LEARNING_THROUGH_PLAY.md §12–17) emit periodic comms
 * messages that teach real aerospace concepts and trigger codex unlocks, with randomized timing, cooldowns and
 * anti-spam. Ambiance with educational payoff, not major game systems.
 *
 * @module systems/SubsystemEvents
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { persistenceManager } from './PersistenceManager.js';

/** Random float in [min, max] */
function rand(min, max) { return min + Math.random() * (max - min); }

/** Inclusive. */
function randInt(min, max) { return Math.floor(rand(min, max + 1)); }

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function formatUptime(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * `quiet` tags the line `_quiet`: the owner's "stay hidden" kinds (radio-pass chatter and routine readouts that say
 * nothing is being done, needed or broken). CommsSystem drops a `_quiet` line at every tier; the SUBSYSTEM_EVENT still fires.
 */
function sendComms(text, source = 'SYSTEM', priority = 'LOW', quiet = false) {
  eventBus.emit(Events.COMMS_MESSAGE, quiet ? { priority, source, text, _quiet: true } : { priority, source, text });
  eventBus.emit(Events.SUBSYSTEM_EVENT, { source, text });
  return true;
}

// BASE SUBSYSTEM — shared timer/cooldown logic
class BaseSubsystem {
  constructor(name) {
    this.name = name;
    /** @type {Object<string, number>} named timers counting down */
    this._timers = {};
    /** @type {number} don't fire if another subsystem just did */
    this._cooldown = 0;
  }

  _setTimer(name, baseInterval, varianceFraction = 0.2) {
    const variance = baseInterval * varianceFraction;
    this._timers[name] = baseInterval + rand(-variance, variance);
  }

  _setTimerRange(name, min, max) {
    this._timers[name] = rand(min, max);
  }

  /** True when the timer fires (reaches 0). */
  _tickTimer(name, dt) {
    if (this._timers[name] === undefined) return false;
    this._timers[name] -= dt;
    if (this._timers[name] <= 0) {
      delete this._timers[name];
      return true;
    }
    return false;
  }

  _tickCooldown(dt) {
    if (this._cooldown > 0) {
      this._cooldown -= dt;
    }
  }

  _onCooldown() {
    return this._cooldown > 0;
  }

  _startCooldown(seconds = 15) {
    this._cooldown = seconds;
  }
}

// A. COMMS SUBSYSTEM — Communications Events (§12)

const GROUND_STATIONS = ['Houston', 'Canberra', 'Madrid', 'Svalbard', 'Malindi', 'Kourou'];

class CommsSubsystem extends BaseSubsystem {
  constructor() {
    super('comms');
    this._inSAA = false;
    this._laserCommsHintSent = false;
    this._groundStationActive = false;
    this._groundStationTimer = 0;
    this._currentStation = null;

    const sub = Constants.SUBSYSTEMS;
    this._setTimerRange('groundStation', sub.GROUND_STATION_INTERVAL[0], sub.GROUND_STATION_INTERVAL[1]);

    eventBus.on(Events.WEATHER_EFFECT_START, (data) => {
      if (data && data.type === 'SAA_PASSAGE') {
        this._inSAA = true;
      }
    });
    eventBus.on(Events.WEATHER_EFFECT_END, (data) => {
      if (data && data.type === 'SAA_PASSAGE') {
        this._inSAA = false;
        sendComms('Signal restored. SAA passage complete.', 'SYSTEM', 'LOW', true);
      }
    });
  }

  update(dt, gameData, totalTime) {
    this._tickCooldown(dt);
    const sub = Constants.SUBSYSTEMS;

    if (this._groundStationActive) {
      this._groundStationTimer -= dt;
      if (this._groundStationTimer <= 0) {
        this._groundStationActive = false;
        const nextMin = Math.floor(sub.GROUND_STATION_INTERVAL[0] / 60);
        const nextMax = Math.floor(sub.GROUND_STATION_INTERVAL[1] / 60);
        sendComms(
          `Ground station pass complete. Next window in ~${randInt(nextMin, nextMax)} minutes.`,
          'SYSTEM', 'LOW', true
        );
        this._startCooldown(12);
        this._setTimerRange('groundStation', sub.GROUND_STATION_INTERVAL[0], sub.GROUND_STATION_INTERVAL[1]);
      }
    } else if (this._tickTimer('groundStation', dt)) {
      if (!this._onCooldown()) {
        this._currentStation = pick(GROUND_STATIONS);
        const windowDuration = randInt(sub.GROUND_STATION_WINDOW[0], sub.GROUND_STATION_WINDOW[1]);
        this._groundStationActive = true;
        this._groundStationTimer = windowDuration;
        sendComms(
          `Ground station ${this._currentStation} in range. Uplink window: ${windowDuration}s.`,
          'SYSTEM', 'MEDIUM', true
        );
        eventBus.emit(Events.GROUND_STATION_PASS, { station: this._currentStation, duration: windowDuration });
        this._startCooldown(12);
      } else {
        this._setTimerRange('groundStation', 20, 40);
      }
    }

    // --- Communications Blackout (during SAA) ---
    if (this._inSAA && !this._onCooldown() && Math.random() < 0.02 * dt) {
      const garbled = pick([
        'COMMS DEGRADED. S#gn@l fr*gm. Signal lost',
        'COMMS DEGRADED. Telemetry ██████. Partial restore',
        'COMMS DEGRADED. [garbled]. Attempting re-lock',
        'COMMS DEGRADED. HF blackout in progress',
      ]);
      sendComms(garbled, 'SYSTEM', 'MEDIUM', true);
      this._startCooldown(20);
    }

    if (gameData.deployedArms >= 3 && !this._onCooldown() && Math.random() < 0.003 * dt) {
      const armNum = randInt(1, gameData.deployedArms);
      sendComms(
        `Telemetry bandwidth saturated. Prioritizing arm ${armNum} data stream.`,
        'SYSTEM', 'LOW', true
      );
      this._startCooldown(30);
    }

    // --- Laser Comms Hint (one-time) ---
    if (!this._laserCommsHintSent && gameData.codexProgress >= 10 && !this._onCooldown()) {
      this._laserCommsHintSent = true;
      sendComms(
        'NOTICE: Optical ground link available at Svalbard. Laser comms offer 10× bandwidth. Consider upgrade.',
        'SYSTEM', 'MEDIUM', true
      );
      this._startCooldown(30);
    }
  }

  getState() {
    return {
      laserCommsHintSent: this._laserCommsHintSent,
      groundStationActive: this._groundStationActive,
      groundStationTimer: this._groundStationTimer,
    };
  }

  restore(data) {
    if (!data) return;
    this._laserCommsHintSent = !!data.laserCommsHintSent;
  }
}

// B. NAVIGATION SUBSYSTEM — Navigation & Precision (§13)

class NavigationSubsystem extends BaseSubsystem {
  constructor() {
    super('navigation');
    const sub = Constants.SUBSYSTEMS;
    this._setTimer('starTracker', sub.STAR_TRACKER_INTERVAL);
    this._setTimer('imuDrift', sub.IMU_DRIFT_INTERVAL);
    this._setTimer('gpsDenied', sub.GPS_DENIED_INTERVAL);
    this._starTrackerPhase2Timer = 0;

    eventBus.on(Events.ARM_STATE_CHANGE, (data) => {
      if (data && data.to === 'NETTING' && data.from === 'APPROACH') {
        const speed = (Math.random() * 0.4 + 0.05).toFixed(2);
        const align = (Math.random() * 4 + 0.5).toFixed(1);
        sendComms(
          `Relative navigation active. Closing at ${speed} m/s. Alignment: ${align}°.`,
          'NAV', 'MEDIUM', true
        );
      }
    });
  }

  update(dt, gameData, totalTime) {
    this._tickCooldown(dt);
    const sub = Constants.SUBSYSTEMS;

    if (this._starTrackerPhase2Timer > 0) {
      this._starTrackerPhase2Timer -= dt;
      if (this._starTrackerPhase2Timer <= 0) {
        sendComms('...lock acquired. Attitude accuracy: ±0.001°.', 'NAV', 'LOW', true);
        this._startCooldown(10);
      }
    }

    if (this._tickTimer('starTracker', dt)) {
      if (!this._onCooldown()) {
        sendComms('Star tracker recalibrating...', 'NAV', 'LOW', true);
        this._starTrackerPhase2Timer = 2.0;
        this._startCooldown(5);
      }
      this._setTimer('starTracker', sub.STAR_TRACKER_INTERVAL);
    }

    if (this._tickTimer('imuDrift', dt)) {
      if (!this._onCooldown()) {
        const drift = (Math.random() * 0.04 + 0.01).toFixed(3);
        sendComms(
          `IMU drift detected: ${drift}°. Star tracker correction applied.`,
          'NAV', 'LOW', true
        );
        this._startCooldown(15);
      }
      this._setTimer('imuDrift', sub.IMU_DRIFT_INTERVAL);
    }

    if (this._tickTimer('gpsDenied', dt)) {
      if (!this._onCooldown()) {
        sendComms(
          'GPS constellation partially occluded. Switching to star tracker primary.',
          'NAV', 'LOW', true
        );
        this._startCooldown(15);
      }
      this._setTimer('gpsDenied', sub.GPS_DENIED_INTERVAL);
    }
  }

  getState() { return {}; }
  restore() {}
}

// C. ATTITUDE SUBSYSTEM — Stabilization & Attitude Control (§14)

class AttitudeSubsystem extends BaseSubsystem {
  constructor() {
    super('attitude');
    const sub = Constants.SUBSYSTEMS;
    this._setTimer('reactionWheel', sub.REACTION_WHEEL_INTERVAL);
    this._setTimer('gyroCheck', sub.GYRO_CHECK_INTERVAL);
    this._desatTimer = 0;
    this._detumbleTimer = 0;
    this._detumbleTarget = 0;

    eventBus.on(Events.ARM_STATE_CHANGE, (data) => {
      if (data && data.to === 'GRAPPLED') {
        const tumbleRate = randInt(5, 50);
        sendComms(
          `Target tumble rate: ${tumbleRate}°/s. Despinning via reaction torque...`,
          'NAV', 'MEDIUM'
        );
        this._detumbleTimer = rand(3, 6);
        this._detumbleTarget = (Math.random() * 0.4 + 0.1).toFixed(1);
      }
    });
  }

  update(dt, gameData, totalTime) {
    this._tickCooldown(dt);
    const sub = Constants.SUBSYSTEMS;

    if (this._detumbleTimer > 0) {
      this._detumbleTimer -= dt;
      if (this._detumbleTimer <= 0) {
        sendComms(
          `Target stabilized at ${this._detumbleTarget}°/s. Safe for haul.`,
          'NAV', 'LOW'
        );
        this._startCooldown(10);
      }
    }

    if (this._desatTimer > 0) {
      this._desatTimer -= dt;
      if (this._desatTimer <= 0) {
        sendComms('Desaturation complete. Wheels nominal.', 'NAV', 'LOW', true);
        this._startCooldown(10);
      }
    }

    if (this._tickTimer('reactionWheel', dt)) {
      if (!this._onCooldown()) {
        const wheelId = pick(['X', 'Y', 'Z']);
        const satPct = randInt(85, 95);
        sendComms(
          `Reaction wheel ${wheelId} approaching saturation at ${satPct}%. Magnetorquer desaturation scheduled.`,
          'NAV', 'LOW', true
        );
        this._desatTimer = 10.0;
        this._startCooldown(12);
      }
      this._setTimer('reactionWheel', sub.REACTION_WHEEL_INTERVAL);
    }

    if (this._tickTimer('gyroCheck', dt)) {
      if (!this._onCooldown()) {
        sendComms(
          'Fiber optic gyro health check: 3/3 nominal. Ring laser backup: standby.',
          'NAV', 'LOW', true
        );
        this._startCooldown(15);
      }
      this._setTimer('gyroCheck', sub.GYRO_CHECK_INTERVAL);
    }
  }

  getState() { return {}; }
  restore() {}
}

// D. POWER SUBSYSTEM — Battery & Thermal (§15)

class PowerSubsystem extends BaseSubsystem {
  constructor() {
    super('power');
    const sub = Constants.SUBSYSTEMS;
    this._setTimer('batteryCycle', sub.BATTERY_CYCLE_INTERVAL);
    this._batteryCycleCount = randInt(1200, 3000);
    this._laserPowerBeamSent = false;
    this._inEclipse = false;

    eventBus.on(Events.WEATHER_EFFECT_START, (data) => {
      if (data && data.type === 'ECLIPSE_ENTRY') {
        this._inEclipse = true;
        sendComms(
          `Thermal gradient: sun-side +${randInt(110, 130)}°C, shadow-side -${randInt(140, 160)}°C. MLI maintaining bus at +${randInt(18, 22)}°C.`,
          'THERMAL', 'LOW', true
        );
      }
    });
    eventBus.on(Events.WEATHER_EFFECT_END, (data) => {
      if (data && data.type === 'ECLIPSE_ENTRY') {
        this._inEclipse = false;
      }
    });

    eventBus.on(Events.ARM_DEPLOYED, () => {
      if (Math.random() < 0.20) {
        const rechargeTime = randInt(3, 5);
        sendComms(
          `Supercapacitor bank discharged for arm deployment. Recharge in ${rechargeTime}s.`,
          'POWER', 'LOW', true
        );
      }
    });
  }

  update(dt, gameData, totalTime) {
    this._tickCooldown(dt);
    const sub = Constants.SUBSYSTEMS;

    if (this._tickTimer('batteryCycle', dt)) {
      if (!this._onCooldown()) {
        this._batteryCycleCount += randInt(1, 3);
        const remaining = 50000 - this._batteryCycleCount;
        sendComms(
          `Battery cycle count: ${this._batteryCycleCount}. DoD maintained at 25% for longevity. Estimated ${remaining} cycles remaining.`,
          'POWER', 'LOW', true
        );
        this._startCooldown(15);
      }
      this._setTimer('batteryCycle', sub.BATTERY_CYCLE_INTERVAL);
    }

    // --- Laser Power Beaming (one-time, when daughter arm at > 80% tether range) ---
    // Simplified check: actual tether extension is not read.
    if (!this._laserPowerBeamSent && gameData.deployedArms >= 1 && totalTime > 600 && !this._onCooldown()) {
      if (Math.random() < 0.001 * dt) {
        this._laserPowerBeamSent = true;
        const armNum = randInt(1, Math.max(1, gameData.deployedArms));
        sendComms(
          `Daughter ${armNum} at tether limit. Activating laser power beam to extend operational time.`,
          'POWER', 'MEDIUM', true
        );
        this._startCooldown(30);
      }
    }
  }

  getState() {
    return {
      batteryCycleCount: this._batteryCycleCount,
      laserPowerBeamSent: this._laserPowerBeamSent,
    };
  }

  restore(data) {
    if (!data) return;
    if (data.batteryCycleCount) this._batteryCycleCount = data.batteryCycleCount;
    if (data.laserPowerBeamSent) this._laserPowerBeamSent = true;
  }
}

// E. AVIONICS SUBSYSTEM — Redundancy & Telemetry (§16)

class AvionicsSubsystem extends BaseSubsystem {
  constructor() {
    super('avionics');
    const sub = Constants.SUBSYSTEMS;
    this._setTimer('watchdog', sub.WATCHDOG_INTERVAL);
    this._setTimer('telemetry', sub.TELEMETRY_INTERVAL);
    this._setTimer('ecc', sub.ECC_INTERVAL);
    this._setTimer('tmr', sub.TMR_INTERVAL);
    this._eccEventCount = 0;
  }

  update(dt, gameData, totalTime) {
    this._tickCooldown(dt);
    const sub = Constants.SUBSYSTEMS;

    if (this._tickTimer('watchdog', dt)) {
      if (!this._onCooldown()) {
        const uptimeStr = formatUptime(totalTime);
        if (Math.random() < 0.05) {
          const failProc = pick(['B', 'C']);
          const recoverProc = failProc === 'B' ? 'C' : 'B';
          sendComms(
            `Watchdog timer triggered. Processor ${failProc} hung. Auto-failover to processor ${recoverProc}. No data loss.`,
            'AVIONICS', 'MEDIUM', true
          );
        } else {
          sendComms(
            `Watchdog timer reset. All processors nominal. Uptime: ${uptimeStr}.`,
            'AVIONICS', 'LOW', true
          );
        }
        this._startCooldown(15);
      }
      this._setTimer('watchdog', sub.WATCHDOG_INTERVAL);
    }

    if (this._tickTimer('telemetry', dt)) {
      if (!this._onCooldown()) {
        const nominalPct = randInt(96, 100);
        sendComms(
          `Telemetry frame: 2,847 parameters logged. ${nominalPct}% channels nominal.`,
          'AVIONICS', 'LOW', true
        );
        this._startCooldown(10);
      }
      this._setTimer('telemetry', sub.TELEMETRY_INTERVAL);
    }

    if (this._tickTimer('ecc', dt)) {
      if (!this._onCooldown()) {
        this._eccEventCount++;
        const bank = pick(['A', 'B', 'C', 'D']);
        sendComms(
          `Single-bit error corrected in DRAM bank ${bank}. SEU rate normal for current altitude.`,
          'AVIONICS', 'LOW', true
        );
        this._startCooldown(15);
      }
      // ECC events thin out over time (the first few are educational).
      const baseInterval = sub.ECC_INTERVAL;
      const scaledInterval = baseInterval + (this._eccEventCount * 500);
      this._setTimer('ecc', Math.min(scaledInterval, 6000));
    }

    if (this._tickTimer('tmr', dt)) {
      if (!this._onCooldown()) {
        sendComms(
          'Voting check: A/B/C processors agree. TMR integrity confirmed.',
          'AVIONICS', 'LOW', true
        );
        this._startCooldown(15);
      }
      this._setTimer('tmr', sub.TMR_INTERVAL);
    }
  }

  getState() {
    return { eccEventCount: this._eccEventCount };
  }

  restore(data) {
    if (!data) return;
    if (data.eccEventCount) this._eccEventCount = data.eccEventCount;
  }
}

// F. DEGRADATION SUBSYSTEM — Environmental Wear (§17)

class DegradationSubsystem extends BaseSubsystem {
  constructor() {
    super('degradation');
    const sub = Constants.SUBSYSTEMS;
    this._setTimer('atomicOxygen', sub.ATOMIC_OXYGEN_INTERVAL);
    this._setTimer('uvDegradation', sub.UV_DEGRADATION_INTERVAL);
    this._setTimer('mmod', sub.MMOD_INTERVAL);
    this._setTimer('radiationDose', sub.RADIATION_DOSE_INTERVAL);

    this._kaptonIntegrity = 98;   // starts near 100%, decreases slowly
    this._uvDose = 0.5;           // krad, accumulates
    this._radiationDose = 0.02;   // Sv, accumulates
    this._inSAA = false;
    this._inGeoStorm = false;

    eventBus.on(Events.WEATHER_EFFECT_START, (data) => {
      if (data && data.type === 'SAA_PASSAGE') this._inSAA = true;
      if (data && data.type === 'GEOMAGNETIC_STORM') this._inGeoStorm = true;
    });
    eventBus.on(Events.WEATHER_EFFECT_END, (data) => {
      if (data && data.type === 'SAA_PASSAGE') this._inSAA = false;
      if (data && data.type === 'GEOMAGNETIC_STORM') this._inGeoStorm = false;
    });
  }

  update(dt, gameData, totalTime) {
    this._tickCooldown(dt);
    const sub = Constants.SUBSYSTEMS;

    this._kaptonIntegrity = Math.max(60, this._kaptonIntegrity - 0.0005 * dt);
    this._uvDose += 0.0002 * dt;
    if (this._inSAA || this._inGeoStorm) {
      this._radiationDose += 0.0005 * dt;
    } else {
      this._radiationDose += 0.00005 * dt;
    }

    if (this._tickTimer('atomicOxygen', dt)) {
      if (!this._onCooldown()) {
        const flux = (Math.random() * 5e14 + 1e14).toExponential(1);
        const integrity = Math.round(this._kaptonIntegrity);
        sendComms(
          `Atomic oxygen flux: ${flux} atoms/cm²/s. Kapton blankets at ${integrity}% integrity.`,
          'STRUCTURE', 'LOW', true
        );
        this._startCooldown(15);
      }
      this._setTimer('atomicOxygen', sub.ATOMIC_OXYGEN_INTERVAL);
    }

    if (this._tickTimer('uvDegradation', dt)) {
      if (!this._onCooldown()) {
        const dose = this._uvDose.toFixed(1);
        const severity = this._uvDose < 5 ? 'minimal' : this._uvDose < 15 ? 'moderate' : 'significant';
        sendComms(
          `Solar UV cumulative dose: ${dose} krad. Polymer surfaces showing ${severity} yellowing.`,
          'STRUCTURE', 'LOW', true
        );
        this._startCooldown(15);
      }
      this._setTimer('uvDegradation', sub.UV_DEGRADATION_INTERVAL);
    }

    if (this._tickTimer('mmod', dt)) {
      if (!this._onCooldown()) {
        const panel = pick(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
        if (Math.random() < 0.05) {
          sendComms(
            `A tiny piece of space debris hit panel ${panel} and made a small puncture. The self-sealing foam closed it.`,
            'STRUCTURE', 'MEDIUM'
          );
        } else {
          sendComms(
            `A tiny piece of space debris hit panel ${panel}. The shield stopped it; no damage.`,
            'STRUCTURE', 'LOW'
          );
        }
        this._startCooldown(20);
      }
      this._setTimer('mmod', sub.MMOD_INTERVAL);
    }

    // --- Radiation Dose Tracker (during SAA or geomagnetic storm) ---
    if ((this._inSAA || this._inGeoStorm) && this._tickTimer('radiationDose', dt)) {
      if (!this._onCooldown()) {
        const dose = this._radiationDose.toFixed(3);
        sendComms(
          `Cumulative radiation dose: ${dose} Sv. Within acceptable limits.`,
          'STRUCTURE', 'LOW', true
        );
        this._startCooldown(15);
      }
      this._setTimer('radiationDose', sub.RADIATION_DOSE_INTERVAL);
    } else if (!this._inSAA && !this._inGeoStorm) {
      // Not in a radiation zone: keep refreshing the timer.
      if (this._timers['radiationDose'] === undefined) {
        this._setTimer('radiationDose', sub.RADIATION_DOSE_INTERVAL);
      }
    }
  }

  getState() {
    return {
      kaptonIntegrity: this._kaptonIntegrity,
      uvDose: this._uvDose,
      radiationDose: this._radiationDose,
    };
  }

  restore(data) {
    if (!data) return;
    if (data.kaptonIntegrity !== undefined) this._kaptonIntegrity = data.kaptonIntegrity;
    if (data.uvDose !== undefined) this._uvDose = data.uvDose;
    if (data.radiationDose !== undefined) this._radiationDose = data.radiationDose;
  }
}

// SUBSYSTEM EVENTS — Main controller

export class SubsystemEvents {
  constructor() {
    this.totalTime = 0;
    this.subsystems = {
      comms: new CommsSubsystem(),
      navigation: new NavigationSubsystem(),
      attitude: new AttitudeSubsystem(),
      powerSub: new PowerSubsystem(),
      avionics: new AvionicsSubsystem(),
      degradation: new DegradationSubsystem(),
    };

    // Capture-count gate: no subsystem chatter until the first capture.
    this._totalCatches = 0;
    eventBus.on(Events.LASSO_CAPTURED, () => { this._totalCatches++; });
    eventBus.on(Events.ARM_CAPTURED, () => { this._totalCatches++; });

    // Self-managed persistence (decoupled from GameFlowManager). peek(), not load(): load() emits PERSISTENCE_LOADED
    // (infinite recursion).
    eventBus.on(Events.PERSISTENCE_LOADED, () => {
      const save = persistenceManager.peek();
      if (save && save.subsystemEvents) {
        this.restore(save.subsystemEvents);
      }
    });
    eventBus.on(Events.PERSISTENCE_GATHER, (saveData) => {
      saveData.subsystemEvents = this.getState();
    });

    console.log(`[SubsystemEvents] Initialized 6 subsystem event generators`);
  }

  /**
   * @param {number} dt - seconds
   * @param {object} gameData - Current game state data
   * @param {object} [gameData.playerOrbit] - Player orbital elements
   * @param {object} [gameData.armManager] - ArmManager reference
   * @param {number} [gameData.deployedArms] - Count of deployed arms
   * @param {number} [gameData.codexProgress] - Number of unlocked codex entries
   */
  update(dt, gameData = {}) {
    this.totalTime += dt;

    if (this._totalCatches < Constants.SKILL_GATES.SUBSYSTEM_MIN_CATCHES) return;

    const data = {
      playerOrbit: gameData.playerOrbit || null,
      armManager: gameData.armManager || null,
      deployedArms: gameData.deployedArms || 0,
      codexProgress: gameData.codexProgress || 0,
    };

    for (const sub of Object.values(this.subsystems)) {
      try {
        sub.update(dt, data, this.totalTime);
      } catch (e) {
        console.error(`[SubsystemEvents] ${sub.name} error:`, e);
      }
    }
  }

  getState() {
    const state = { totalTime: this.totalTime };
    for (const [key, sub] of Object.entries(this.subsystems)) {
      state[key] = sub.getState();
    }
    return state;
  }

  restore(data) {
    if (!data) return;
    if (data.totalTime !== undefined) this.totalTime = data.totalTime;
    for (const [key, sub] of Object.entries(this.subsystems)) {
      if (data[key]) {
        sub.restore(data[key]);
      }
    }
    console.log('[SubsystemEvents] State restored from save');
  }
}

export default SubsystemEvents;
