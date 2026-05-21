/**
 * SpaceWeatherSystem.js — Dynamic space weather events that affect gameplay
 * and teach concepts. Generates periodic weather phenomena (solar flares,
 * geomagnetic storms, SAA passages, eclipses) with actual gameplay effects.
 *
 * Emits events that other systems can optionally listen to — does not
 * directly modify other systems.
 *
 * @module systems/SpaceWeatherSystem
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';

// ============================================================================
// WEATHER TYPE DEFINITIONS
// ============================================================================

const SW = Constants.SPACE_WEATHER;

const WEATHER_TYPES = {
  SOLAR_FLARE: {
    name: 'Solar Flare',
    icon: '☀️',
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
    icon: '🟣',
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
    commsAlert: (kp) => `SPACE WEATHER: Geomagnetic storm — Kp index ${kp}. EDT efficiency boosted.`,
    codexTrigger: 'van_allen_belts',
  },

  SAA_PASSAGE: {
    name: 'South Atlantic Anomaly',
    icon: '⚠️',
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
    icon: '🌑',
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

// ============================================================================
// HELPER: random in range
// ============================================================================

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

// ============================================================================
// SPACE WEATHER SYSTEM
// ============================================================================

export class SpaceWeatherSystem {
  /**
   * @param {object} [opts]
   * @param {object} [opts.catalogLoader] - ST-6.1 optional seeded-replay source.
   *        When ready, replaces random-roll scheduling with a deterministic
   *        timeline driven by `/data/space-weather.json`. When absent or not
   *        ready, falls back to the legacy random-interval behaviour.
   */
  constructor(opts = {}) {
    /** @type {Map<string, { startTime: number, duration: number, effects: object, def: object }>} */
    this.activeEvents = new Map();

    /** @type {Object<string, number>} Countdown to next event of each type (random mode) */
    this.timers = {};

    /** @type {number} Total elapsed time */
    this.totalTime = 0;

    /** @type {object} Cached merged effects */
    this._mergedEffects = this._defaultEffects();

    // --- ST-6.1: seeded-replay state ---
    this._catalogLoader = opts.catalogLoader || null;
    this._replayMode = !!(this._catalogLoader &&
                          typeof this._catalogLoader.isReady === 'function' &&
                          this._catalogLoader.isReady());
    /** @type {Set<number>} indices of events already fired (by index in the events array) */
    this._firedReplayIdx = new Set();
    /** @type {number} which slot of the events[] array we've advanced past */
    this._replayCursor = 0;

    // Initialize timers for each weather type (randomized first occurrence).
    // Kept initialized in BOTH modes so a mid-session fallback still works.
    for (const [type, def] of Object.entries(WEATHER_TYPES)) {
      this.timers[type] = randRange(def.minInterval * 0.5, def.maxInterval);
    }

    // Sprint 3: Skill-based gate — suppress weather until power management discovered
    this._powerMgmtDiscovered = false;
    eventBus.on(Events.SKILL_DISCOVERED, (d) => {
        if (d?.skillId === 'manage_power') this._powerMgmtDiscovered = true;
    });

    // ST-4.C: Mission profile gate — additional suppression from mission profiles
    this._weatherAllowed = false;
    eventBus.on(Events.MISSION_START, (d) => {
        this._weatherAllowed = d.profile.weather;
    });

    // ST-4.C: Reset weather gate on game reset — also reset replay cursor.
    eventBus.on(Events.GAME_RESET, () => {
        this._weatherAllowed = false;
        this._firedReplayIdx = new Set();
        this._replayCursor = 0;
    });

    // ST-6.1: if catalogue finishes loading mid-session, upgrade to replay mode.
    eventBus.on(Events.CATALOG_LOADED, (d) => {
      if (d && d.ready && this._catalogLoader) this._replayMode = true;
    });

    // ST-6.1: additive persistence — save/restore replay cursor + fired set.
    // Legacy saves without `spaceWeatherReplay` simply start from hour 0 (safe).
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
        // Lazy-require avoids boot-order coupling with PersistenceManager.
        // Anything falsy or malformed is ignored — default-safe.
        const pm = (typeof window !== 'undefined' && window.persistenceManager) ? window.persistenceManager : null;
        const save = pm && typeof pm.peek === 'function' ? pm.peek() : null;
        if (!save || !save.spaceWeatherReplay) return;
        const s = save.spaceWeatherReplay;
        if (typeof s.totalTime === 'number') this.totalTime = s.totalTime;
        if (Array.isArray(s.firedIdx)) this._firedReplayIdx = new Set(s.firedIdx);
      } catch (_) { /* default-safe */ }
    });

    console.log(`[SpaceWeatherSystem] Initialized — ${this._replayMode ? 'SEEDED REPLAY' : 'random mode'} (${Object.keys(WEATHER_TYPES).length} weather types)`);
  }

  /**
   * Inject or upgrade a catalogLoader reference post-construction.
   * Mainly useful when CatalogLoader init() resolves after SpaceWeatherSystem
   * has been built — wiring code can flip the switch.
   * @param {object} catalogLoader
   */
  setCatalogLoader(catalogLoader) {
    this._catalogLoader = catalogLoader || null;
    this._replayMode = !!(catalogLoader &&
                          typeof catalogLoader.isReady === 'function' &&
                          catalogLoader.isReady());
  }

  /** Map a catalogue event `type` string onto one of WEATHER_TYPES keys.
   *  Unknown types → null (skipped). @private */
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

  /** @returns {number} Current game-hour, derived from totalTime (seconds) × TIME_SCALE_GAMEPLAY.
   *  Using TIME_SCALE_GAMEPLAY keeps the timeline aligned with how debris/player orbits tick. */
  _currentGameHour() {
    const scale = Constants.TIME_SCALE_GAMEPLAY || 1;
    return (this.totalTime * scale) / 3600;
  }

  // ==========================================================================
  // UPDATE
  // ==========================================================================

  /**
   * Update weather system. Called every frame from game loop.
   * @param {number} dt - Delta time in seconds
   * @param {object} [gameData] - Optional context { playerOrbit, sunDirection }
   */
  update(dt, gameData) {
    this.totalTime += dt;

    let stateChanged = false;

    if (this._replayMode) {
      // --- ST-6.1: Seeded replay path — fire unfired catalogue events whose
      //     scheduled game_hour has passed. Existing gates still apply:
      //     `manage_power` skill gate → emission-suppression in _startEvent,
      //     mission profile gate → filtered here before dispatch.
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
      // --- Legacy random-roll path (unchanged) ---
      for (const [type, def] of Object.entries(WEATHER_TYPES)) {
        // Skip if this type is already active
        if (this.activeEvents.has(type)) continue;

        this.timers[type] -= dt;
        if (this.timers[type] <= 0) {
          // ST-4.C: Mission profile gate — BOTH skill gate AND profile must pass
          if (!this._weatherAllowed) {
            // Re-schedule without firing — check again later
            this.timers[type] = randRange(def.minInterval * 0.3, def.minInterval);
            continue;
          }
          this._startEvent(type, def);
          stateChanged = true;
        }
      }
    }

    // --- Update active event timers, remove expired ---
    for (const [type, event] of this.activeEvents.entries()) {
      event.elapsed = (event.elapsed || 0) + dt;
      if (event.elapsed >= event.duration) {
        this._endEvent(type);
        stateChanged = true;
      }
    }

    // --- Recompute merged effects if state changed ---
    if (stateChanged) {
      this._recomputeMergedEffects();
    }

    // --- Emit active effects every frame (systems can query) ---
    if (this.activeEvents.size > 0) {
      eventBus.emit(Events.WEATHER_ACTIVE, this._mergedEffects);
    }
  }

  // ==========================================================================
  // EVENT START / END
  // ==========================================================================

  /**
   * Start a weather event.
   * @private
   * @param {string} type - Weather type key
   * @param {object} def - Weather definition
   */
  _startEvent(type, def, replayOverride) {
    // ST-6.1: replay events pass `duration_h` in game-hours (catalogue schedule).
    // Convert back to seconds of totalTime (elapsed) — divide by TIME_SCALE_GAMEPLAY
    // so the event lasts the right *game-time* window on the existing totalTime++.
    let duration;
    if (replayOverride && typeof replayOverride.duration_h === 'number') {
      const scale = Constants.TIME_SCALE_GAMEPLAY || 1;
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

    // Build comms alert text with flavor
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

    // Sprint 3: Suppress weather alerts until power management skill discovered
    if (!this._powerMgmtDiscovered) return;

    // Emit comms alert
    eventBus.emit(Events.COMMS_MESSAGE, {
      priority: type === 'SAA_PASSAGE' ? 'LOW' : 'MEDIUM',
      source: 'WEATHER',
      text: alertText,
    });

    // Emit weather effect start event
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

  /**
   * End a weather event and reset its timer.
   * @private
   * @param {string} type
   */
  _endEvent(type) {
    const event = this.activeEvents.get(type);
    if (!event) return;

    const def = WEATHER_TYPES[type];
    this.activeEvents.delete(type);

    // Reset timer for next occurrence
    this.timers[type] = randRange(def.minInterval, def.maxInterval);

    // Emit end event
    eventBus.emit(Events.WEATHER_EFFECT_END, { type });

    // End comms message
    eventBus.emit(Events.COMMS_MESSAGE, {
      priority: 'LOW',
      source: 'WEATHER',
      text: `${def.name} has subsided. Normal operations resumed.`,
    });

    console.log(`[SpaceWeather] ${def.icon} ${def.name} ended`);
  }

  // ==========================================================================
  // MERGED EFFECTS
  // ==========================================================================

  /**
   * @private Get default (neutral) effect multipliers.
   * @returns {object}
   */
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

  /**
   * Recompute merged effect multipliers for all active events.
   * Multipliers stack multiplicatively; booleans OR together.
   * @private
   */
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

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  /**
   * Get merged effect multipliers for all active events.
   * Other systems query this for their multipliers.
   * @returns {{ sensorRange: number, solarPower: number, edtEfficiency: number,
   *             commsBandwidth: number, atmosphericDrag: number,
   *             radiationRisk: boolean, sensorNoise: boolean,
   *             thermalStress: boolean, electronicsRisk: number }}
   */
  getActiveEffects() {
    return { ...this._mergedEffects };
  }

  /**
   * Get list of currently active weather events for HUD display.
   * @returns {Array<{ type: string, name: string, icon: string, color: string,
   *                    elapsed: number, duration: number }>}
   */
  getActiveWeather() {
    const result = [];
    for (const [type, event] of this.activeEvents) {
      result.push({
        type,
        name: event.def.name,
        icon: event.def.icon,
        color: event.def.color,
        elapsed: event.elapsed || 0,
        duration: event.duration,
      });
    }
    return result;
  }

  /**
   * Check if we're currently in any weather event.
   * @returns {boolean}
   */
  hasActiveWeather() {
    return this.activeEvents.size > 0;
  }

  /**
   * Check if SAA passage is active.
   * @returns {boolean}
   */
  isInSAA() {
    return this.activeEvents.has('SAA_PASSAGE');
  }

  /**
   * Check if eclipse is active.
   * @returns {boolean}
   */
  isInEclipse() {
    return this.activeEvents.has('ECLIPSE_ENTRY');
  }

  // ==========================================================================
  // PERSISTENCE
  // ==========================================================================

  /**
   * Get serializable state for save game.
   * @returns {object}
   */
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

  /**
   * Restore state from save game data.
   * @param {object} data
   */
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
