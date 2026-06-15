/**
 * EnvironmentSystem.js — ST-6.7: Five environmental hazard effects
 *
 * Central coordinator for altitude-dependent and periodic hazards that create
 * strategic pressure on the player:
 *   B1. Atomic Oxygen Erosion (AO)    — below 600 km altitude
 *   B2. MMOD Impacts                   — random micro-impacts scaled by debris density
 *   B3. Safe-Mode Trigger              — 2+ subsystems below 25% health
 *   B4. Radiation Belt Effects          — 2000–12000 km altitude (Van Allen)
 *   B5. Battery Depth-of-Discharge      — cumulative deep-cycle degradation
 *
 * All intervals are in **game-seconds**. The caller passes dt from the main
 * game loop (already time-scaled).
 *
 * @module systems/EnvironmentSystem
 */

import { Constants } from '../core/Constants.js';
import { Events }    from '../core/Events.js';

// ============================================================================
// SEEDED RNG — same multiplicative congruential pattern as DebrisTextureAtlas
// ============================================================================

/** @private */
function _seededRandom(seed) {
  let s = (seed >>> 0) || 1;
  return function () {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// ============================================================================
// ENVIRONMENT SYSTEM
// ============================================================================

const ENV = () => Constants.ENVIRONMENT || {};
const DEB = () => Constants.DEBRIS || {};

export class EnvironmentSystem {
  /**
   * @param {object|null} eventBus          — EventBus instance (on/emit)
   * @param {object|null} playerSatellite   — PlayerSatellite (getAltitudeKm, safeMode)
   * @param {object|null} powerDistribution — PowerDistribution
   * @param {object|null} resourceSystem    — ResourceSystem (battery, solarPanelHealth)
   * @param {object|null} skillsSystem      — SkillsSystem (isDiscovered)
   */
  constructor(eventBus, playerSatellite, powerDistribution, resourceSystem, skillsSystem) {
    this._eventBus = eventBus || null;
    this._player   = playerSatellite  || null;
    this._power    = powerDistribution || null;
    this._resource = resourceSystem    || null;
    this._skills   = skillsSystem      || null;

    // ── Subsystem health model (0.0–1.0) ──────────────────────────────────
    this._subsystemHealth = { arms: 1.0, sensors: 1.0, comms: 1.0, power: 1.0 };

    // ── AO accumulators ───────────────────────────────────────────────────
    this._aoTimer = 0;
    this._aoFirstWarned = false;

    // ── MMOD accumulators ─────────────────────────────────────────────────
    this._mmodTimer = 0;
    this._mmodRng = _seededRandom(42);
    this._cmeActive = false;    // amplified MMOD during CME

    // ── Safe Mode state ───────────────────────────────────────────────────
    this._safeModeTimer = 0;
    this._safeMode = false;

    // ── Radiation Belt state ──────────────────────────────────────────────
    this._radiationNoiseTimer = 0;
    this._radiationFirstWarned = false;
    this._wasInRadBelt = false;

    // ── Battery DOD state ─────────────────────────────────────────────────
    this._dodCycleCount = 0;
    this._dodBelowThreshold = false;  // currently below deep-discharge threshold
    this._dodFirstWarned = false;
    this._dodPenaltiesApplied = 0;    // how many penalty intervals applied

    // ── Unsub functions ───────────────────────────────────────────────────
    this._unsubs = [];

    // ── Disposed flag ─────────────────────────────────────────────────────
    this._disposed = false;
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  /**
   * Start monitoring — subscribe to weather events and persistence.
   */
  init() {
    if (this._disposed) return;
    const eb = this._eventBus;
    if (!eb) return;

    // Listen for CME / weather events to amplify MMOD
    const onWeatherStart = (data) => {
      if (data && (data.type === 'GEOMAGNETIC_STORM' || data.type === 'Geomagnetic Storm')) {
        this._cmeActive = true;
      }
    };
    const onWeatherEnd = (data) => {
      if (data && (data.type === 'GEOMAGNETIC_STORM' || data.type === 'Geomagnetic Storm')) {
        this._cmeActive = false;
      }
    };

    if (Events.WEATHER_EFFECT_START) {
      this._unsubs.push(eb.on(Events.WEATHER_EFFECT_START, onWeatherStart));
    }
    if (Events.WEATHER_EFFECT_END) {
      this._unsubs.push(eb.on(Events.WEATHER_EFFECT_END, onWeatherEnd));
    }

    // Persistence: save environment state
    if (Events.PERSISTENCE_GATHER) {
      this._unsubs.push(eb.on(Events.PERSISTENCE_GATHER, (saveData) => {
        if (!saveData || typeof saveData !== 'object') return;
        saveData.environment = {
          subsystemHealth: { ...this._subsystemHealth },
          dodCycleCount: this._dodCycleCount,
          dodBelowThreshold: this._dodBelowThreshold,
          dodPenaltiesApplied: this._dodPenaltiesApplied,
          safeMode: this._safeMode,
        };
      }));
    }

    // Persistence: restore environment state
    if (Events.PERSISTENCE_LOADED) {
      this._unsubs.push(eb.on(Events.PERSISTENCE_LOADED, () => {
        try {
          const pm = (typeof window !== 'undefined' && window.persistenceManager)
            ? window.persistenceManager : null;
          const save = pm && typeof pm.peek === 'function' ? pm.peek() : null;
          if (!save || !save.environment) return;
          const s = save.environment;
          if (s.subsystemHealth) {
            for (const k of Object.keys(this._subsystemHealth)) {
              if (typeof s.subsystemHealth[k] === 'number') {
                this._subsystemHealth[k] = s.subsystemHealth[k];
              }
            }
          }
          if (typeof s.dodCycleCount === 'number') this._dodCycleCount = s.dodCycleCount;
          if (typeof s.dodBelowThreshold === 'boolean') this._dodBelowThreshold = s.dodBelowThreshold;
          if (typeof s.dodPenaltiesApplied === 'number') this._dodPenaltiesApplied = s.dodPenaltiesApplied;
          if (typeof s.safeMode === 'boolean') {
            this._safeMode = s.safeMode;
            if (this._player) this._player.safeMode = s.safeMode;
          }
        } catch (_) { /* default-safe */ }
      }));
    }

    // Reset on game reset
    if (Events.GAME_RESET) {
      this._unsubs.push(eb.on(Events.GAME_RESET, () => this._reset()));
    }

    console.log('[EnvironmentSystem] Initialized. 5 hazard effects active');
  }

  /**
   * Per-frame tick — runs all five sub-effects.
   * @param {number} dt — delta time in seconds (already time-scaled)
   */
  update(dt) {
    if (this._disposed) return;
    if (!this._player) return;

    const altKm = this._getAltitudeKm();
    if (altKm === null) return;

    this._updateAtomicOxygen(dt, altKm);
    this._updateMMOD(dt, altKm);
    this._updateSafeMode(dt);
    this._updateRadiationBelt(dt, altKm);
    this._updateBatteryDOD(dt);
  }

  /**
   * @returns {Array<{type: string, severity: number, remainingS: number}>}
   */
  getActiveEffects() {
    const effects = [];
    const E = ENV();
    const altKm = this._getAltitudeKm();

    if (altKm !== null && altKm < (E.AO_THRESHOLD_KM || 600)) {
      effects.push({ type: 'atomic_oxygen', severity: this.getAtomicOxygenRate(), remainingS: Infinity });
    }
    if (this._safeMode) {
      effects.push({ type: 'safe_mode', severity: 1, remainingS: Infinity });
    }
    if (this.isInRadiationBelt()) {
      effects.push({ type: 'radiation_belt', severity: E.RADIATION_SENSOR_PENALTY || 0.3, remainingS: Infinity });
    }
    return effects;
  }

  /**
   * @returns {boolean} true if player altitude is within Van Allen belt range
   */
  isInRadiationBelt() {
    const altKm = this._getAltitudeKm();
    if (altKm === null) return false;
    const E = ENV();
    return altKm >= (E.RADIATION_BELT_LOW_KM || 2000) &&
           altKm <= (E.RADIATION_BELT_HIGH_KM || 12000);
  }

  /**
   * @returns {number} Current AO erosion rate (0 if above threshold)
   */
  getAtomicOxygenRate() {
    const altKm = this._getAltitudeKm();
    if (altKm === null) return 0;
    const E = ENV();
    if (altKm >= (E.AO_THRESHOLD_KM || 600)) return 0;
    let rate = E.AO_ARM_DEGRADATION || 0.002;
    if (this._skills && typeof this._skills.isDiscovered === 'function' &&
        this._skills.isDiscovered('manage_power')) {
      rate *= (E.AO_SKILL_MITIGATION || 0.5);
    }
    return rate;
  }

  /**
   * @returns {number} Depth-of-discharge fraction 0–1
   */
  getBatteryDOD() {
    const E = ENV();
    const interval = E.DOD_CYCLE_PENALTY_INTERVAL || 10;
    const loss = E.DOD_CAPACITY_LOSS || 0.02;
    return Math.min(1, (Math.floor(this._dodCycleCount / interval) * loss));
  }

  /**
   * Get current subsystem health values.
   * @returns {{ arms: number, sensors: number, comms: number, power: number }}
   */
  getSubsystemHealth() {
    return { ...this._subsystemHealth };
  }

  /**
   * Set subsystem health (for testing or external repair).
   * @param {string} subsystem
   * @param {number} health — 0.0–1.0
   */
  setSubsystemHealth(subsystem, health) {
    if (subsystem in this._subsystemHealth) {
      this._subsystemHealth[subsystem] = Math.max(0, Math.min(1, health));
    }
  }

  /**
   * @returns {boolean} Whether safe mode is currently active
   */
  isSafeMode() {
    return this._safeMode;
  }

  /**
   * Unsubscribe all listeners and stop updates.
   */
  dispose() {
    this._disposed = true;
    for (const unsub of this._unsubs) {
      if (typeof unsub === 'function') unsub();
    }
    this._unsubs.length = 0;
  }

  // ==========================================================================
  // INTERNAL — Altitude helper
  // ==========================================================================

  /** @private @returns {number|null} */
  _getAltitudeKm() {
    if (!this._player) return null;
    if (typeof this._player.getAltitudeKm === 'function') {
      return this._player.getAltitudeKm();
    }
    // Fallback: compute from orbit if available
    if (this._player.orbit && this._player.orbit.semiMajorAxis) {
      const scale = Constants.SCENE_SCALE || 1e-5;
      const earthR = Constants.EARTH_RADIUS_KM || 6371;
      return (this._player.orbit.semiMajorAxis / scale) - earthR;
    }
    return null;
  }

  /** @private Get debris density factor for current altitude band */
  _getDensityFactor(altKm) {
    const bands = (DEB().ALT_BANDS) || [];
    for (const band of bands) {
      if (altKm >= band.min && altKm <= band.max) {
        // Normalize weight: average weight is ~0.14, so density factor = weight / 0.14
        return band.weight / 0.14;
      }
    }
    return 0.5; // default low if outside any band
  }

  /** @private Emit via EventBus if available */
  _emit(event, data) {
    if (this._eventBus && typeof this._eventBus.emit === 'function') {
      this._eventBus.emit(event, data);
    }
  }

  /** @private Houston comms shorthand */
  _houston(text, priority = 'info') {
    if (Events.COMMS_MESSAGE) {
      this._emit(Events.COMMS_MESSAGE, { text, priority, source: 'houston' });
    }
  }

  // ==========================================================================
  // B1: ATOMIC OXYGEN EROSION
  // ==========================================================================

  /** @private */
  _updateAtomicOxygen(dt, altKm) {
    const E = ENV();
    const threshold = E.AO_THRESHOLD_KM || 600;
    if (altKm >= threshold) {
      this._aoTimer = 0;
      return;
    }

    // First entry warning
    if (!this._aoFirstWarned) {
      this._aoFirstWarned = true;
      this._houston('Caution. Atomic oxygen concentration increasing at this altitude. Equipment degradation possible.', 'warning');
    }

    this._aoTimer += dt;
    const interval = E.AO_TICK_INTERVAL_S || 10;
    while (this._aoTimer >= interval) {
      this._aoTimer -= interval;

      let armDeg   = E.AO_ARM_DEGRADATION   || 0.002;
      let panelDeg = E.AO_PANEL_DEGRADATION  || 0.001;

      // Skill mitigation
      if (this._skills && typeof this._skills.isDiscovered === 'function' &&
          this._skills.isDiscovered('manage_power')) {
        const mit = E.AO_SKILL_MITIGATION || 0.5;
        armDeg   *= mit;
        panelDeg *= mit;
      }

      // Apply degradation
      this._subsystemHealth.arms = Math.max(0, this._subsystemHealth.arms - armDeg);

      if (this._resource && typeof this._resource.solarPanelHealth === 'number') {
        this._resource.solarPanelHealth = Math.max(0, this._resource.solarPanelHealth - panelDeg);
      }

      this._emit(Events.ENVIRONMENT_EFFECT, {
        type: 'atomic_oxygen',
        severity: armDeg,
        altitude_km: altKm,
      });
    }
  }

  // ==========================================================================
  // B2: MMOD IMPACTS
  // ==========================================================================

  /** @private */
  _updateMMOD(dt, altKm) {
    const E = ENV();
    this._mmodTimer += dt;
    const interval = E.MMOD_CHECK_INTERVAL_S || 30;
    if (this._mmodTimer < interval) return;
    this._mmodTimer -= interval;

    // Probability = base × density factor × CME amplifier
    let prob = (E.MMOD_BASE_PROBABILITY || 0.02) * this._getDensityFactor(altKm);
    if (this._cmeActive) {
      prob *= (E.MMOD_WEATHER_AMPLIFIER || 1.5);
    }

    // Roll (seeded)
    const roll = this._mmodRng();
    if (roll > prob) return;

    // Impact! — determine which subsystem is hit
    const weights = E.MMOD_SUBSYSTEM_WEIGHTS || { arms: 0.4, sensors: 0.25, comms: 0.2, power: 0.15 };
    const subsystem = this._rollSubsystem(weights);

    let damage = E.MMOD_DAMAGE_FRACTION || 0.05;
    let mitigated = false;

    // Skill mitigation
    if (this._skills && typeof this._skills.isDiscovered === 'function' &&
        this._skills.isDiscovered('advanced_sensors')) {
      damage *= (E.MMOD_SKILL_MITIGATION || 0.5);
      mitigated = true;
    }

    // Apply damage
    this._subsystemHealth[subsystem] = Math.max(0, this._subsystemHealth[subsystem] - damage);

    // Houston comms
    const subsystemLabel = subsystem.charAt(0).toUpperCase() + subsystem.slice(1);
    this._houston(`MMOD impact detected on ${subsystemLabel}. Running diagnostics.`, 'warning');

    // Audio cue
    this._emit(Events.AUDIO_CUE, { cue: 'mmod_impact' });

    // Environment effect event
    this._emit(Events.ENVIRONMENT_EFFECT, {
      type: 'mmod_impact',
      subsystem,
      damage,
      mitigated,
    });
  }

  /** @private Weighted random subsystem selection using seeded RNG */
  _rollSubsystem(weights) {
    const roll = this._mmodRng();
    let cumulative = 0;
    for (const [key, w] of Object.entries(weights)) {
      cumulative += w;
      if (roll <= cumulative) return key;
    }
    // Fallback (float precision)
    return Object.keys(weights).pop();
  }

  // ==========================================================================
  // B3: SAFE MODE
  // ==========================================================================

  /** @private */
  _updateSafeMode(dt) {
    const E = ENV();
    this._safeModeTimer += dt;
    const interval = E.SAFE_MODE_CHECK_INTERVAL_S || 10;
    if (this._safeModeTimer < interval) return;
    this._safeModeTimer -= interval;

    const healthThreshold  = E.SAFE_MODE_HEALTH_THRESHOLD  || 0.25;
    const recoveryThreshold = E.SAFE_MODE_RECOVERY_THRESHOLD || 0.40;

    // Count subsystems below critical threshold
    const belowCritical = [];
    for (const [name, health] of Object.entries(this._subsystemHealth)) {
      if (health < healthThreshold) belowCritical.push(name);
    }

    if (!this._safeMode) {
      // Entry condition: 2+ subsystems below threshold
      if (belowCritical.length >= 2) {
        this._safeMode = true;
        if (this._player) this._player.safeMode = true;

        this._houston('WARNING. Multiple subsystem failures. Entering safe mode. Repair critical systems.', 'critical');
        this._emit(Events.SAFE_MODE_ENTERED, { subsystemsBelowThreshold: belowCritical });
        this._emit(Events.ENVIRONMENT_EFFECT, { type: 'safe_mode', entering: true, subsystems: belowCritical });
      }
    } else {
      // Recovery condition: ALL subsystems above recovery threshold
      const allAbove = Object.values(this._subsystemHealth).every(h => h >= recoveryThreshold);
      if (allAbove) {
        this._safeMode = false;
        if (this._player) this._player.safeMode = false;

        this._houston('All subsystems recovered. Exiting safe mode. Operations nominal.', 'info');
        this._emit(Events.SAFE_MODE_EXITED, {});
        this._emit(Events.ENVIRONMENT_EFFECT, { type: 'safe_mode', entering: false });
      }
    }
  }

  // ==========================================================================
  // B4: RADIATION BELT
  // ==========================================================================

  /** @private */
  _updateRadiationBelt(dt, altKm) {
    const E = ENV();
    const inBelt = altKm >= (E.RADIATION_BELT_LOW_KM || 2000) &&
                   altKm <= (E.RADIATION_BELT_HIGH_KM || 12000);

    // Entry/exit transitions
    if (inBelt && !this._wasInRadBelt) {
      this._wasInRadBelt = true;
      if (!this._radiationFirstWarned) {
        this._radiationFirstWarned = true;
        this._houston('Entering radiation belt. Expect sensor interference and comms latency.', 'warning');
      }
      this._emit(Events.ENVIRONMENT_EFFECT, { type: 'radiation_belt', inBelt: true });
    } else if (!inBelt && this._wasInRadBelt) {
      this._wasInRadBelt = false;
      this._emit(Events.ENVIRONMENT_EFFECT, { type: 'radiation_belt', inBelt: false });
      this._radiationNoiseTimer = 0;
      return;
    }

    if (!inBelt) return;

    // Periodic garbled comms
    this._radiationNoiseTimer += dt;
    const noiseInterval = E.RADIATION_NOISE_INTERVAL_S || 15;
    if (this._radiationNoiseTimer >= noiseInterval) {
      this._radiationNoiseTimer -= noiseInterval;

      // Garbled text
      const garbled = '▓▒░ s█gn█l ░▒▓ …interference… ▓▒░';
      this._emit(Events.COMMS_MESSAGE, {
        text: garbled,
        priority: 'low',
        source: 'interference',
      });
    }
  }

  /**
   * Get radiation sensor penalty (accounts for skill mitigation).
   * @returns {number} 0–1 penalty factor (0 = no penalty, 0.3 = 30% reduction)
   */
  getRadiationSensorPenalty() {
    if (!this.isInRadiationBelt()) return 0;
    const E = ENV();
    let penalty = E.RADIATION_SENSOR_PENALTY || 0.3;
    if (this._skills && typeof this._skills.isDiscovered === 'function' &&
        this._skills.isDiscovered('radiation_hardening')) {
      penalty *= (1 - (E.RADIATION_SKILL_MITIGATION || 0.6));
    }
    return penalty;
  }

  /**
   * Get radiation comms delay (accounts for skill mitigation).
   * @returns {number} delay in seconds
   */
  getRadiationCommsDelay() {
    if (!this.isInRadiationBelt()) return 0;
    const E = ENV();
    let delay = E.RADIATION_COMMS_DELAY_S || 2;
    if (this._skills && typeof this._skills.isDiscovered === 'function' &&
        this._skills.isDiscovered('radiation_hardening')) {
      delay *= (1 - (E.RADIATION_SKILL_MITIGATION || 0.6));
    }
    return delay;
  }

  // ==========================================================================
  // B5: BATTERY DEPTH-OF-DISCHARGE
  // ==========================================================================

  /** @private */
  _updateBatteryDOD(dt) {
    if (!this._resource) return;
    const E = ENV();

    const battery    = this._resource.battery    || 0;
    const batteryMax = this._resource.batteryMax  || 1;
    const fraction   = battery / batteryMax;

    const deepThreshold    = E.DOD_DEEP_DISCHARGE_THRESHOLD || 0.2;
    const rechargeThreshold = E.DOD_RECHARGE_THRESHOLD       || 0.8;
    const penaltyInterval  = E.DOD_CYCLE_PENALTY_INTERVAL   || 10;
    const capacityLoss     = E.DOD_CAPACITY_LOSS             || 0.02;

    // Track deep-discharge cycle
    if (!this._dodBelowThreshold && fraction <= deepThreshold) {
      this._dodBelowThreshold = true;
    }
    if (this._dodBelowThreshold && fraction >= rechargeThreshold) {
      this._dodBelowThreshold = false;

      // Completed one deep cycle
      let increment = 1;
      if (this._skills && typeof this._skills.isDiscovered === 'function' &&
          this._skills.isDiscovered('manage_power')) {
        increment *= (E.DOD_SKILL_MITIGATION || 0.5);
      }
      this._dodCycleCount += increment;

      // Check if a new penalty interval has been reached
      const newPenalties = Math.floor(this._dodCycleCount / penaltyInterval);
      if (newPenalties > this._dodPenaltiesApplied) {
        const deltaP = newPenalties - this._dodPenaltiesApplied;
        this._dodPenaltiesApplied = newPenalties;

        // Reduce max battery capacity
        if (this._resource && typeof this._resource.batteryMax === 'number') {
          this._resource.batteryMax *= Math.pow(1 - capacityLoss, deltaP);
        }

        // First penalty warning
        if (!this._dodFirstWarned) {
          this._dodFirstWarned = true;
          this._houston('Battery degradation noted. Consider managing power draw to extend service life.', 'warning');
        }
      }

      // Emit DOD event
      const maxCapFrac = this._resource.batteryMax / (Constants.BATTERY_MAX || 1);
      this._emit(Events.ENVIRONMENT_EFFECT, {
        type: 'battery_dod',
        dodFraction: this.getBatteryDOD(),
        cycleCount: this._dodCycleCount,
        maxCapacityFraction: maxCapFrac,
      });
    }
  }

  // ==========================================================================
  // MMOD PROBABILITY GETTER (for testing)
  // ==========================================================================

  /**
   * Compute MMOD probability for a given altitude (for testing/display).
   * @param {number} altKm
   * @returns {number}
   */
  getMMODProbability(altKm) {
    const E = ENV();
    let prob = (E.MMOD_BASE_PROBABILITY || 0.02) * this._getDensityFactor(altKm);
    if (this._cmeActive) {
      prob *= (E.MMOD_WEATHER_AMPLIFIER || 1.5);
    }
    return prob;
  }

  // ==========================================================================
  // RESET
  // ==========================================================================

  /** @private Reset all state to pristine */
  _reset() {
    this._subsystemHealth = { arms: 1.0, sensors: 1.0, comms: 1.0, power: 1.0 };
    this._aoTimer = 0;
    this._aoFirstWarned = false;
    this._mmodTimer = 0;
    this._mmodRng = _seededRandom(42);
    this._cmeActive = false;
    this._safeModeTimer = 0;
    this._safeMode = false;
    this._radiationNoiseTimer = 0;
    this._radiationFirstWarned = false;
    this._wasInRadBelt = false;
    this._dodCycleCount = 0;
    this._dodBelowThreshold = false;
    this._dodFirstWarned = false;
    this._dodPenaltiesApplied = 0;

    if (this._player) this._player.safeMode = false;
  }
}

// CJS guard — expose for Node.js tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { EnvironmentSystem, _seededRandom };
}

export default EnvironmentSystem;
