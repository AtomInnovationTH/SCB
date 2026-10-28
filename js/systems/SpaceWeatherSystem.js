/**
 * SpaceWeatherSystem.js — periodic space weather (solar flares, geomagnetic storms, SAA passages, eclipses) with gameplay
 * effects. Emits events other systems may listen to; does not modify them directly.
 * @module systems/SpaceWeatherSystem
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { TimeAuthority } from './TimeAuthority.js';
import { persistenceManager } from './PersistenceManager.js';

// `icon` is a short text tag (<= 4 chars) the HUD weather badge shows beside `name` (no pictographs anywhere; the comms
// line carries the name alone).

const SW = Constants.SPACE_WEATHER;

const WEATHER_TYPES = {
  SOLAR_FLARE: {
    name: 'Solar Flare',
    icon: 'SUN',
    color: '#ff8800',
    effects: {
      sensorRange: 0.7,
      solarPower: 1.3,
      radiationRisk: true,
    },
    minDuration: SW.SOLAR_FLARE_MIN_DURATION,
    maxDuration: SW.SOLAR_FLARE_MAX_DURATION,
    minInterval: SW.SOLAR_FLARE_MIN_INTERVAL,
    maxInterval: SW.SOLAR_FLARE_MAX_INTERVAL,
    commsAlert: (cls) => `SPACE WEATHER: Solar flare detected. Class ${cls}. Sensor interference expected.`,
    codexTrigger: 'solar_storm',
  },

  GEOMAGNETIC_STORM: {
    name: 'Geomagnetic Storm',
    icon: 'GEO',
    color: '#9933ff',
    effects: {
      edtEfficiency: 1.5,
      commsBandwidth: 0.5,
      atmosphericDrag: 1.3,
    },
    minDuration: SW.GEOMAGNETIC_MIN_DURATION,
    maxDuration: SW.GEOMAGNETIC_MAX_DURATION,
    minInterval: SW.GEOMAGNETIC_MIN_INTERVAL,
    maxInterval: SW.GEOMAGNETIC_MAX_INTERVAL,
    commsAlert: (kp) => `SPACE WEATHER: Geomagnetic storm. Kp index ${kp}. EDT efficiency boosted.`,
    codexTrigger: 'van_allen_belts',
  },

  SAA_PASSAGE: {
    name: 'South Atlantic Anomaly',
    icon: 'SAA',
    color: '#ccaa00',
    effects: {
      sensorNoise: true,
      electronicsRisk: 0.01,
    },
    minDuration: SW.SAA_DURATION,
    maxDuration: SW.SAA_DURATION,
    minInterval: SW.SAA_INTERVAL,
    maxInterval: SW.SAA_INTERVAL,
    commsAlert: () => 'Entering South Atlantic Anomaly. Expect sensor noise.',
    codexTrigger: 'south_atlantic_anomaly',
  },

  ECLIPSE_ENTRY: {
    name: 'Eclipse',
    icon: 'ECL',
    color: '#334455',
    effects: {
      solarPower: 0,
      thermalStress: true,
    },
    minDuration: SW.ECLIPSE_DURATION,
    maxDuration: SW.ECLIPSE_DURATION,
    minInterval: SW.ECLIPSE_INTERVAL,
    maxInterval: SW.ECLIPSE_INTERVAL,
    commsAlert: () => 'Entering Earth shadow. Solar panels offline. Battery power only.',
    codexTrigger: 'eclipse_cycle',
  },
};

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

export class SpaceWeatherSystem {
  /**
   * @param {object} [opts]
   * @param {object} [opts.catalogLoader] optional seeded-replay source. When ready, replaces random-roll scheduling with a
   *        deterministic timeline from `/data/space-weather.json`; otherwise falls back to random intervals.
   */
  constructor(opts = {}) {
    /** @type {Map<string, { startTime: number, duration: number, effects: object, def: object }>} */
    this.activeEvents = new Map();

    /** @type {Object<string, number>} Countdown to next event of each type (random mode) */
    this.timers = {};

    this.totalTime = 0;

    this._mergedEffects = this._defaultEffects();

    this._catalogLoader = opts.catalogLoader || null;
    this._replayMode = !!(this._catalogLoader &&
                          typeof this._catalogLoader.isReady === 'function' &&
                          this._catalogLoader.isReady());
    this._firedReplayIdx = new Set();
    this._replayCursor = 0;

    // Timers stay initialized in BOTH modes so a mid-session fallback still works (randomized first occurrence).
    for (const [type, def] of Object.entries(WEATHER_TYPES)) {
      this.timers[type] = randRange(def.minInterval * 0.5, def.maxInterval);
    }

    // Skill gate: suppress weather until power management is discovered
    this._powerMgmtDiscovered = false;
    eventBus.on(Events.SKILL_DISCOVERED, (d) => {
        if (d?.skillId === 'manage_power') this._powerMgmtDiscovered = true;
    });

    // Mission profile gate (the skill gate must pass too)
    this._weatherAllowed = false;
    eventBus.on(Events.MISSION_START, (d) => {
        this._weatherAllowed = d.profile.weather;
    });

    eventBus.on(Events.GAME_RESET, () => {
        this._weatherAllowed = false;
        this._firedReplayIdx = new Set();
        this._replayCursor = 0;
    });

    eventBus.on(Events.CATALOG_LOADED, (d) => {
      if (d && d.ready && this._catalogLoader) this._replayMode = true;
    });

    // Persist the replay cursor + fired set (additive; legacy saves without `spaceWeatherReplay` start from hour 0).
    eventBus.on(Events.PERSISTENCE_GATHER, (saveData) => {
      if (!saveData || typeof saveData !== 'object') return;
      saveData.spaceWeatherReplay = {
        replayMode: this._replayMode,
        totalTime: this.totalTime,
        firedIdx: Array.from(this._firedReplayIdx),
      };
    });
    eventBus.on(Events.PERSISTENCE_LOADED, () => {
      // PersistenceManager.load() emits this; read via peek to avoid recursion.
      try {
        // Read through the exported singleton (nothing assigns `window.persistenceManager`); falsy or malformed is ignored.
        const save = persistenceManager.peek();
        if (!save || !save.spaceWeatherReplay) return;
        const s = save.spaceWeatherReplay;
        if (typeof s.totalTime === 'number') this.totalTime = s.totalTime;
        if (Array.isArray(s.firedIdx)) this._firedReplayIdx = new Set(s.firedIdx);
      } catch (_) { /* default-safe */ }
    });

    console.log(`[SpaceWeatherSystem] Initialized. ${this._replayMode ? 'SEEDED REPLAY' : 'random mode'} (${Object.keys(WEATHER_TYPES).length} weather types)`);
  }

  /** Inject or upgrade a catalogLoader after construction (CatalogLoader init() may resolve after this is built). */
  setCatalogLoader(catalogLoader) {
    this._catalogLoader = catalogLoader || null;
    this._replayMode = !!(catalogLoader &&
                          typeof catalogLoader.isReady === 'function' &&
                          catalogLoader.isReady());
  }

  /** Map a catalogue event `type` string onto a WEATHER_TYPES key; unknown → null (skipped). @private */
  _catalogTypeToKey(t) {
    switch (String(t || '').toLowerCase()) {
      case 'solar_flare':  return 'SOLAR_FLARE';
      case 'geomagnetic':
      case 'cme':
      case 'proton_event': return 'GEOMAGNETIC_STORM';
      case 'saa_passage':  return 'SAA_PASSAGE';
      case 'eclipse':      return 'ECLIPSE_ENTRY';
      case 'quiet':        return null;
      default:             return null;
    }
  }

  /** @returns {number} Current game-hour: totalTime (s) × TimeAuthority.BASE_SCALE / 3600, aligned with how debris/player
   *  orbits tick. */
  _currentGameHour() {
    const scale = TimeAuthority.BASE_SCALE || 1;
    return (this.totalTime * scale) / 3600;
  }

  update(dt, gameData) {
    this.totalTime += dt;

    let stateChanged = false;

    if (this._replayMode) {
      // Seeded replay: fire unfired catalogue events whose scheduled game_hour has passed. Gates still apply: the
      // `manage_power` skill gate (emission suppression in _startEvent) and the mission profile gate (filtered here).
      const nowH = this._currentGameHour();
      const events = (typeof this._catalogLoader.getWeatherEventsUpTo === 'function')
        ? this._catalogLoader.getWeatherEventsUpTo(nowH) : [];
      for (let i = 0; i < events.length; i++) {
        if (this._firedReplayIdx.has(i)) continue;
        const ev = events[i];
        this._firedReplayIdx.add(i);
        const key = this._catalogTypeToKey(ev.type);
        if (!key) continue;                        // 'quiet' or unknown → do nothing
        if (this.activeEvents.has(key)) continue;  // same type already active
        const def = WEATHER_TYPES[key];
        if (!def) continue;
        if (!this._weatherAllowed) continue;        // mission profile gate
        this._startEvent(key, def, { severity: ev.severity, duration_h: ev.duration_h });
        stateChanged = true;
      }
    } else {
      for (const [type, def] of Object.entries(WEATHER_TYPES)) {
        if (this.activeEvents.has(type)) continue;

        this.timers[type] -= dt;
        if (this.timers[type] <= 0) {
          // BOTH the skill gate AND the mission profile must pass
          if (!this._weatherAllowed) {
            this.timers[type] = randRange(def.minInterval * 0.3, def.minInterval);
            continue;
          }
          this._startEvent(type, def);
          stateChanged = true;
        }
      }
    }

    for (const [type, event] of this.activeEvents.entries()) {
      event.elapsed = (event.elapsed || 0) + dt;
      if (event.elapsed >= event.duration) {
        this._endEvent(type);
        stateChanged = true;
      }
    }

    if (stateChanged) {
      this._recomputeMergedEffects();
    }

    // Emit active effects every frame (systems can query)
    if (this.activeEvents.size > 0) {
      eventBus.emit(Events.WEATHER_ACTIVE, this._mergedEffects);
    }
  }

  _startEvent(type, def, replayOverride) {
    // Replay events pass `duration_h` in game-hours (catalogue schedule); divide by BASE_SCALE so the event lasts the right
    // game-time window on totalTime.
    let duration;
    if (replayOverride && typeof replayOverride.duration_h === 'number') {
      const scale = TimeAuthority.BASE_SCALE || 1;
      duration = (replayOverride.duration_h * 3600) / scale;
    } else {
      duration = randRange(def.minDuration, def.maxDuration);
    }

    const event = {
      startTime: this.totalTime,
      duration,
      elapsed: 0,
      effects: { ...def.effects },
      def,
    };
    this.activeEvents.set(type, event);

    let alertText;
    if (type === 'SOLAR_FLARE') {
      const classes = ['C4.2', 'M1.7', 'M3.5', 'X1.1'];
      alertText = def.commsAlert(classes[Math.floor(Math.random() * classes.length)]);
    } else if (type === 'GEOMAGNETIC_STORM') {
      const kp = 5 + Math.floor(Math.random() * 4); // Kp 5-8
      alertText = def.commsAlert(kp);
    } else {
      alertText = def.commsAlert();
    }

    // Suppress weather alerts until the power management skill is discovered
    if (!this._powerMgmtDiscovered) return;

    eventBus.emit(Events.COMMS_MESSAGE, {
      priority: type === 'SAA_PASSAGE' ? 'LOW' : 'MEDIUM',
      source: 'WEATHER',
      text: alertText,
    });

    eventBus.emit(Events.WEATHER_EFFECT_START, {
      type,
      effects: event.effects,
      duration,
      name: def.name,
      icon: def.icon,
      color: def.color,
    });

    console.log(`[SpaceWeather] ${def.icon} ${def.name} started (${Math.round(duration)}s)`);
  }

  _endEvent(type) {
    const event = this.activeEvents.get(type);
    if (!event) return;

    const def = WEATHER_TYPES[type];
    this.activeEvents.delete(type);

    this.timers[type] = randRange(def.minInterval, def.maxInterval);

    eventBus.emit(Events.WEATHER_EFFECT_END, { type });

    eventBus.emit(Events.COMMS_MESSAGE, {
      priority: 'LOW',
      source: 'WEATHER',
      text: `${def.name} has subsided. Normal operations resumed.`,
    });

    console.log(`[SpaceWeather] ${def.icon} ${def.name} ended`);
  }

  _defaultEffects() {
    return {
      sensorRange: 1.0,
      solarPower: 1.0,
      edtEfficiency: 1.0,
      commsBandwidth: 1.0,
      atmosphericDrag: 1.0,
      radiationRisk: false,
      sensorNoise: false,
      thermalStress: false,
      electronicsRisk: 0,
    };
  }

  /** Multipliers stack multiplicatively; booleans OR together. @private */
  _recomputeMergedEffects() {
    const merged = this._defaultEffects();

    for (const [, event] of this.activeEvents) {
      const fx = event.effects;
      if (fx.sensorRange != null) merged.sensorRange *= fx.sensorRange;
      if (fx.solarPower != null) merged.solarPower *= fx.solarPower;
      if (fx.edtEfficiency != null) merged.edtEfficiency *= fx.edtEfficiency;
      if (fx.commsBandwidth != null) merged.commsBandwidth *= fx.commsBandwidth;
      if (fx.atmosphericDrag != null) merged.atmosphericDrag *= fx.atmosphericDrag;
      if (fx.radiationRisk) merged.radiationRisk = true;
      if (fx.sensorNoise) merged.sensorNoise = true;
      if (fx.thermalStress) merged.thermalStress = true;
      if (fx.electronicsRisk) merged.electronicsRisk = Math.max(merged.electronicsRisk, fx.electronicsRisk);
    }

    this._mergedEffects = merged;
  }

  getActiveEffects() {
    return { ...this._mergedEffects };
  }

  getState() {
    const active = {};
    for (const [type, event] of this.activeEvents) {
      active[type] = {
        elapsed: event.elapsed,
        duration: event.duration,
      };
    }
    return {
      totalTime: this.totalTime,
      timers: { ...this.timers },
      active,
    };
  }

  restore(data) {
    if (!data) return;
    if (data.totalTime != null) this.totalTime = data.totalTime;
    if (data.timers) {
      for (const [type, val] of Object.entries(data.timers)) {
        if (this.timers[type] != null) this.timers[type] = val;
      }
    }
    if (data.active) {
      for (const [type, saved] of Object.entries(data.active)) {
        const def = WEATHER_TYPES[type];
        if (!def) continue;
        this.activeEvents.set(type, {
          startTime: this.totalTime - saved.elapsed,
          duration: saved.duration,
          elapsed: saved.elapsed,
          effects: { ...def.effects },
          def,
        });
      }
      this._recomputeMergedEffects();
    }
    console.log(`[SpaceWeatherSystem] Restored state (totalTime=${Math.round(this.totalTime)}s)`);
  }
}

export default SpaceWeatherSystem;
