/**
 * SensorSystem.js — Sensor/detection management with tiers and range filtering
 *
 * Manages:
 *   • sensor range tiers (basic → enhanced → advanced)
 *   • range-gated target detection via DebrisField.getDebrisNear()
 *   • data enrichment levels (what info is resolved at what distance)
 *   • sensor upgrade tracking
 *
 * @module systems/SensorSystem
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { powerDistribution } from './PowerDistribution.js';
import { Constants } from '../core/Constants.js';

// ============================================================================
// SENSOR TIER DEFINITIONS
// ============================================================================

/** @type {Object<string, {range:number, rangeKm:number, scanRate:number, dataFields:string[], description:string}>} */
export const SENSOR_TIERS = {
  basic: {
    range: 0.1,          // scene units (10 km)
    rangeKm: 10,
    scanRate: 1.0,
    dataFields: ['type', 'size'],
    description: 'Basic radar. Type and size classification',
  },
  enhanced: {
    range: 0.5,          // 50 km
    rangeKm: 50,
    scanRate: 2.0,
    dataFields: ['type', 'size', 'mass', 'material', 'tumbleRate'],
    description: 'Enhanced sensors. Mass, material, tumble data',
  },
  advanced: {
    range: 1.0,          // 100 km
    rangeKm: 100,
    scanRate: 4.0,
    dataFields: ['type', 'size', 'mass', 'material', 'tumbleRate', 'brittleness', 'orbit'],
    description: 'Advanced suite. Full orbital & structural analysis',
  },
};

// ============================================================================
// DATA ENRICHMENT LEVELS  (distance-gated)
// ============================================================================

const DATA_LEVELS = {
  FAR:    { level: 0, label: 'Unresolved',  fields: ['type'] },
  MEDIUM: { level: 1, label: 'Classified',  fields: ['type', 'size', 'mass'] },
  NEAR:   { level: 2, label: 'Analyzed',    fields: ['type', 'size', 'mass', 'material', 'tumbleRate'] },
  CLOSE:  { level: 3, label: 'Full Profile', fields: ['type', 'size', 'mass', 'material', 'tumbleRate', 'brittleness', 'orbit'] },
};

// ============================================================================
// CLASS
// ============================================================================

export class SensorSystem {
  constructor() {
    /** @type {string} */
    this.tier = 'basic';

    /** @type {number} Detection range in scene units */
    this.range = SENSOR_TIERS.basic.range;

    /** @type {number} Scan speed multiplier */
    this.scanRate = SENSOR_TIERS.basic.scanRate;

    /** @type {Array<object>} Last frame's detected targets */
    this.detectedTargets = [];

    /** @type {boolean} Whether salvage scanner upgrade is active */
    this.canScanSalvage = false;

    /** @type {number} Weather-based sensor range multiplier */
    this._weatherSensorMult = 1.0;

    /** @type {number} Seconds since last WEATHER_ACTIVE event */
    this._weatherLastUpdate = 0;

    // === Active Scan State ===
    /** @type {boolean} Whether a scan is currently in progress */
    this._scanActive = false;
    /** @type {string|null} Current scan type: 'quick' or 'wide' */
    this._scanType = null;
    /** @type {number} Seconds remaining on active scan */
    this._scanTimer = 0;
    /** @type {number} Quick scan cooldown remaining (seconds) */
    this._quickCooldown = 0;
    /** @type {number} Wide scan cooldown remaining (seconds) */
    this._wideCooldown = 0;

    // S2.4: Scan anti-spam — diminishing returns
    /** @type {number} Total scans completed this session */
    this._scanCount = 0;
    /** @type {number} Total credits earned from scans this session */
    this._scanCreditsTotal = 0;
    /**
     * Field-based scan economy (2026-06-04): ground stations pay for NEW survey
     * data about a debris field. The first scan of a given field is valuable;
     * re-scanning the same field yields no new data (no reward) but still works
     * functionally (reveals fresh arrivals, satisfies onboarding). Missions that
     * span multiple fields therefore pay out once per distinct field surveyed.
     * @type {Set<string>} field ids already paid out this session.
     */
    this._rewardedFields = new Set();

    // Sprint 3: Skill-based gate — suppress sensor weather effects until scan discovered
    this._scanDiscovered = false;
    eventBus.on(Events.SKILL_DISCOVERED, (d) => {
        if (d?.skillId === 'scan_quick') this._scanDiscovered = true;
    });

    // Listen for weather effects (suppressed until scan skill discovered)
    eventBus.on(Events.WEATHER_ACTIVE, (effects) => {
      if (!this._scanDiscovered) return;
      this._weatherSensorMult = effects.sensorRange ?? 1.0;
      this._weatherLastUpdate = 0;
    });

    // S2.4: Reset scan anti-spam counters on game restart
    eventBus.on(Events.GAME_RESET, () => {
      this._scanCount = 0;
      this._scanCreditsTotal = 0;
      this._rewardedFields.clear();
    });

    this._setupListeners();
  }

  // ======================================================================
  // DETECTION
  // ======================================================================

  /**
   * Return every debris piece within sensor range, enriched by data level.
   * @param {THREE.Vector3} playerPos
   * @param {object} debrisField – DebrisField instance (must have getDebrisNear)
   * @returns {Array<object>}
   */
  getDetectedTargets(playerPos, debrisField) {
    if (!debrisField || !playerPos) return [];

    // Power distribution: sensors disabled if multiplier is 0
    if (powerDistribution.sensorMultiplier <= 0) return [];

    // Apply power multiplier to effective range (stacks with upgrades + weather)
    const effectiveRange = this.range * powerDistribution.sensorMultiplier * this._weatherSensorMult;
    const nearby = debrisField.getDebrisNear(playerPos, effectiveRange);

    this.detectedTargets = nearby.map(entry => {
      const distance = entry.distance || 0;
      const dataLevel = this._getDataLevel(distance);
      return this._enrichData(entry, dataLevel);
    });

    return this.detectedTargets;
  }

  /**
   * Determine which data-tier a target falls under given its distance.
   * @param {object} target – must have .distance or .position
   * @param {THREE.Vector3} [playerPos]
   * @returns {object} One of DATA_LEVELS
   */
  getDataTier(target, playerPos) {
    let distance = target.distance || 0;
    if (playerPos && target.position) {
      distance = playerPos.distanceTo(target.position);
    }
    return this._getDataLevel(distance);
  }

  // ======================================================================
  // UPGRADES
  // ======================================================================

  /**
   * Apply a shop upgrade that affects sensor capabilities.
   * These are multiplicative on top of current tier values.
   * @param {object} data - { effect: string, value: number|boolean }
   * @returns {boolean} true if handled
   */
  applyUpgrade(data) {
    switch (data.effect) {
      case 'sensorRange':
        // Multiply detection range (e.g., basic 0.1 × 1.5 = 0.15 = 15km)
        this.range *= data.value;
        break;
      case 'detectUntracked':
        // Enable detection of untracked debris in sensor results
        this.canDetectUntracked = true;
        break;
      case 'scanRange':
        // Multiply scan rate (affects data enrichment speed)
        this.scanRate *= data.value;
        break;
      case 'salvageScan':
        // Enable salvage content scanning at range
        this.canScanSalvage = true;
        break;
      default:
        return false;
    }
    eventBus.emit(Events.SENSOR_UPGRADED, {
      effect: data.effect,
      value: data.value,
      range: this.range,
      scanRate: this.scanRate,
    });
    return true;
  }

  /**
   * Upgrade the sensor suite.
   * @param {string} newTier – 'enhanced' | 'advanced'
   * @returns {boolean} success
   */
  upgradeSensor(newTier) {
    const tierDef = SENSOR_TIERS[newTier];
    if (!tierDef) {
      console.warn(`[SensorSystem] Unknown tier: ${newTier}`);
      return false;
    }

    const order = ['basic', 'enhanced', 'advanced'];
    if (order.indexOf(newTier) <= order.indexOf(this.tier)) {
      console.warn(`[SensorSystem] Cannot downgrade from ${this.tier} to ${newTier}`);
      return false;
    }

    this.tier = newTier;
    this.range = tierDef.range;
    this.scanRate = tierDef.scanRate;

    eventBus.emit(Events.SENSOR_UPGRADED, {
      tier: newTier,
      rangeKm: tierDef.rangeKm,
      description: tierDef.description,
    });

    return true;
  }

  /**
   * Snapshot for HUD.
   * @returns {object}
   */
  getStatus() {
    const tierDef = SENSOR_TIERS[this.tier];
    return {
      tier: this.tier,
      rangeKm: tierDef.rangeKm,
      scanRate: this.scanRate,
      detectedCount: this.detectedTargets.length,
      description: tierDef.description,
    };
  }

  /**
   * Per-frame update.
   * @param {number} dt – delta seconds
   */
  update(dt, playerPos, debrisField) {
    // Cache player position & debris field for _revealNearbyDebris (UX-3 #9)
    if (playerPos) this._lastPlayerPos = playerPos;
    if (debrisField) this._lastDebrisField = debrisField;

    // Staleness timer: reset weather multiplier if no WEATHER_ACTIVE for 2s
    this._weatherLastUpdate += dt;
    if (this._weatherLastUpdate > 2.0) {
      this._weatherSensorMult = 1.0;
    }

    // Process active scan timer
    if (this._scanActive) {
      this._scanTimer -= dt;
      if (this._scanTimer <= 0) {
        this._completeScan();
      }
    }

    // Process scan cooldowns
    if (this._quickCooldown > 0) this._quickCooldown -= dt;
    if (this._wideCooldown > 0) this._wideCooldown -= dt;

    // Animate reveal progress for recently discovered debris
    const now = performance.now();
    if (this._lastDebrisField && this._lastDebrisField.debrisList) {
      for (const debris of this._lastDebrisField.debrisList) {
        if (debris._revealStartTime && debris._revealProgress < 1) {
          const elapsed = now - debris._revealStartTime;
          debris._revealProgress = Math.min(1, elapsed / 300); // 300ms fade-in
        }
      }
    }
  }

  // ======================================================================
  // PRIVATE
  // ======================================================================

  /**
   * Map a raw distance to a DATA_LEVELS entry.
   * @param {number} distance – scene units
   * @returns {object}
   * @private
   */
  _getDataLevel(distance) {
    if (distance <= 0.005) return DATA_LEVELS.CLOSE;   // ≤ 500 m
    if (distance <= 0.02)  return DATA_LEVELS.NEAR;    // ≤ 2 km
    const halfRange = SENSOR_TIERS[this.tier].range * 0.5;
    if (distance <= halfRange) return DATA_LEVELS.MEDIUM;
    return DATA_LEVELS.FAR;
  }

  /**
   * Filter a raw debris entry down to only the fields the sensor
   * can resolve at the current range + tier.
   * @param {object} entry – raw from getDebrisNear
   * @param {object} dataLevel – DATA_LEVELS entry
   * @returns {object}
   * @private
   */
  _enrichData(entry, dataLevel) {
    const tierDef = SENSOR_TIERS[this.tier];

    // Combine tier capability with range-based data level
    const available = new Set(dataLevel.fields);
    // Tier unlocks its fields only at or below data-level threshold
    for (const f of tierDef.dataFields) {
      if (available.has(f)) continue;
      if (tierDef.dataFields.indexOf(f) <= dataLevel.level) {
        available.add(f);
      }
    }

    const enriched = {
      id: entry.id,
      distance: entry.distance,
      dataLevel: dataLevel.label,
      dataLevelNum: dataLevel.level,
    };

    if (available.has('type'))        enriched.type = entry.type;
    if (available.has('size'))        enriched.size = entry.size || 'unknown';
    if (available.has('mass'))        enriched.mass = entry.mass;
    if (available.has('material'))    enriched.material = entry.material;
    if (available.has('tumbleRate'))  enriched.tumbleRate = entry.tumbleRate;
    if (available.has('brittleness')) enriched.brittleness = entry.brittleness;
    if (available.has('orbit'))       enriched.orbit = entry.orbit;

    return enriched;
  }

  // ======================================================================
  // ACTIVE SCAN
  // ======================================================================

  /**
   * Start an active scan (quick ping or wide aperture).
   * @param {'quick'|'wide'} type
   * @private
   */
  _startScan(type) {
    const cfg = type === 'quick' ? Constants.SCAN.QUICK : Constants.SCAN.WIDE;
    this._scanActive = true;
    this._scanType = type;
    this._scanTimer = cfg.DURATION;

    // Trigger scan audio/visual feedback
    eventBus.emit(Events.SCAN_INITIATED, { type });

    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'V5',
      text: type === 'quick'
        ? '📡 Quick scan initiated...'
        : '📡 Wide aperture scan. Stand by...',
      priority: 'info',
    });
  }

  /**
   * Complete the active scan — award credits, roll for discoveries.
   * @private
   */
  _completeScan() {
    const type = this._scanType;
    const cfg = type === 'quick' ? Constants.SCAN.QUICK : Constants.SCAN.WIDE;

    this._scanActive = false;
    this._scanType = null;

    // Set the appropriate cooldown
    if (type === 'quick') {
      this._quickCooldown = cfg.COOLDOWN;
    } else {
      this._wideCooldown = cfg.COOLDOWN;
    }

    // ── Field-based survey economy (2026-06-04) ──────────────────────────
    // Ground stations pay for NEW, high-resolution data about a debris field.
    // The first survey of a given field is valuable; re-scanning the SAME field
    // returns data they already have (no reward) — this kills scan-farming a
    // single spot. A mission spanning several fields still pays per field.
    this._scanCount++;
    const baseReward = cfg.REWARD;
    const sessionCap = Constants.SCAN.SESSION_SCAN_CAP || 5000;

    // Identify the field the player is surveying (dominant cluster within range).
    const revealRange = (Constants.SCAN.REVEAL_BASE_RANGE || 5.0) * (cfg.RANGE_MULTIPLIER || 1.0);
    const fieldId = (this._lastDebrisField && this._lastPlayerPos)
      ? this._lastDebrisField.getFieldIdNear(this._lastPlayerPos, revealRange)
      : null;

    let reward = 0;
    let rewardKind = 'none'; // 'fresh' | 'stale' | 'empty' | 'capped'

    if (!fieldId) {
      // Empty space — nothing of value to survey.
      rewardKind = 'empty';
    } else if (this._rewardedFields.has(fieldId)) {
      // Already surveyed this field — data is current, no new value.
      rewardKind = 'stale';
    } else {
      // Fresh field — full survey value. Mild diminishing across DISTINCT fields
      // surveyed (not per repeated scan) so later fields still pay, just slightly
      // less, keeping early exploration the most rewarding.
      const fieldsPaid = this._rewardedFields.size;
      const diminish = Math.max(0.5, 1 - fieldsPaid * 0.05); // -5% per distinct field, floor 50%
      reward = Math.round(baseReward * diminish);
      rewardKind = 'fresh';

      // Session cap is a final safety net against pathological field-hopping.
      if (this._scanCreditsTotal >= sessionCap) {
        reward = 0;
        rewardKind = 'capped';
      } else if (this._scanCreditsTotal + reward > sessionCap) {
        reward = sessionCap - this._scanCreditsTotal;
      }

      if (reward > 0) {
        this._rewardedFields.add(fieldId);
        this._scanCreditsTotal += reward;
      }
    }

    // Award credits for valuable survey data.
    if (reward > 0) {
      eventBus.emit(Events.SCORING_AWARD, {
        points: reward,
        reason: type === 'quick' ? 'Quick scan survey data' : 'Deep scan survey data',
      });
    }

    // Player feedback — explain WHY the yield is what it is.
    if (rewardKind === 'fresh') {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'HOUSTON',
        text: `Survey data received. Fresh field logged. +$${reward}`,
        priority: 'info',
      });
    } else if (rewardKind === 'stale') {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'HOUSTON',
        text: 'Survey data for this field is already current. No new value. Move to a new field for fresh data.',
        priority: 'info',
      });
    } else if (rewardKind === 'empty') {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'HOUSTON',
        text: 'Scan complete. No significant debris field in range. No survey data of value.',
        priority: 'info',
      });
    } else if (rewardKind === 'capped') {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `Scan budget reached (${sessionCap}cr cap). Focus on captures for credits.`,
        priority: 'warning',
      });
    }

    // Discovery chance — may reveal hidden debris
    const discoveries = [];
    const maxDisc = type === 'wide' ? (cfg.MAX_DISCOVERIES || 1) : 1;
    // Debris type distribution for scan discoveries (ST-4.D enrichment)
    const discTypes = ['fragment', 'fragment', 'fragment', 'missionDebris', 'defunctSat', 'rocketBody'];
    // All possible salvage metals (from SALVAGE_SYNERGIES)
    const allMetals = ['GALLIUM', 'COPPER', 'TITANIUM', 'KEVLAR', 'ALUMINUM', 'STEEL',
                       'IRIDIUM', 'CARBON_COMPOSITE', 'GLASS_CERAMIC'];
    for (let i = 0; i < maxDisc; i++) {
      if (Math.random() < cfg.DISCOVERY_CHANCE) {
        const dType = discTypes[Math.floor(Math.random() * discTypes.length)];
        const mass = dType === 'rocketBody' ? 500 + Math.random() * 4000
                   : dType === 'defunctSat' ? 50 + Math.random() * 500
                   : 1 + Math.random() * 9;
        // Probabilistic salvage — hydrazine mainly in rocket bodies
        const hasHydrazine = dType === 'rocketBody' ? Math.random() < 0.4 : Math.random() < 0.05;
        const metalCount = Math.random() < 0.6 ? 1 : (Math.random() < 0.5 ? 2 : 0);
        const metals = [];
        for (let m = 0; m < metalCount; m++) {
          const metal = allMetals[Math.floor(Math.random() * allMetals.length)];
          if (!metals.includes(metal)) metals.push(metal);
        }
        discoveries.push({
          type: dType,
          mass,
          debrisId: `scan-${Date.now()}-${i}`,
          salvage: {
            hydrazine: hasHydrazine ? 20 + Math.random() * 80 : 0,
            metals,
          },
        });
      }
    }

    // Emit scan complete results (rewardKind lets NavRecoveryAdvisor route
    // 'empty' scans into actionable bearing guidance — UX-11 #11)
    const results = {
      type,
      discoveries: discoveries.length,
      reward,
      rewardKind,
    };
    eventBus.emit(Events.SCAN_COMPLETE, results);

    // Emit per-discovery events + bonus rewards.
    // The wide-scan discovery bonus is gated to FRESH fields only — re-scanning
    // an already-surveyed field can't farm discovery credits (consistent with
    // the field-survey economy above). The SCAN_DISCOVERY event still fires so
    // hazard/synergy gameplay (MissionEventSystem) is unaffected.
    discoveries.forEach(d => {
      eventBus.emit(Events.SCAN_DISCOVERY, d);
      if (type === 'wide' && cfg.DISCOVERY_REWARD && rewardKind === 'fresh') {
        eventBus.emit(Events.SCORING_AWARD, {
          points: cfg.DISCOVERY_REWARD,
          reason: 'New contact discovered',
        });
      }
    });

    // Houston feedback — the credit yield was already reported by the
    // field-survey block above (with the ACTUAL amount). Here we only surface
    // newly-found contacts so the two messages don't conflict or double up.
    if (discoveries.length > 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'HOUSTON',
        text: `Scan complete. ${discoveries.length} new contact${discoveries.length > 1 ? 's' : ''} found!`,
        priority: 'success',
      });
    }

    // UX-3 #9: Staggered reveal — discover undiscovered debris near the player
    this._revealNearbyDebris(type);
  }

  /**
   * UX-3 #9: Discover undiscovered debris near the player with staggered timing.
   * Quick scan reveals fewer targets at shorter range; wide scan reveals more.
   * Uses getDebrisNear() which returns all debris (including undiscovered) with positions.
   * @param {string} scanType - 'quick' or 'wide'
   * @private
   */
  _revealNearbyDebris(scanType) {
    const debrisField = this._lastDebrisField;
    const playerPos = this._lastPlayerPos;
    if (!debrisField || !playerPos) return;

    // Determine scan range using REVEAL_BASE_RANGE (500 km base) × config multiplier
    // Sensor detection range (this.range) is too small for orbital-scale discovery
    const cfg = scanType === 'wide' ? Constants.SCAN.WIDE : Constants.SCAN.QUICK;
    const revealRange = (Constants.SCAN.REVEAL_BASE_RANGE || 5.0) * (cfg.RANGE_MULTIPLIER || 1.0);
    const maxReveals = cfg.MAX_REVEALS || (scanType === 'wide' ? 10 : 5);

    // getDebrisNear returns spread-copies; we need original refs via getDebrisById
    const nearby = debrisField.getDebrisNear(playerPos, revealRange);
    if (!nearby || nearby.length === 0) return;

    // Filter to undiscovered only, resolve original debris objects, already sorted by distance
    const toReveal = [];
    for (const copy of nearby) {
      if (copy.discovered) continue;
      const original = debrisField.getDebrisById(copy.id);
      if (original && !original.discovered) {
        toReveal.push(original);
        if (toReveal.length >= maxReveals) break;
      }
    }

    // Staggered reveal with smooth fade-in (120ms spacing, 300ms scale animation)
    const staggerMs = Constants.SCAN.REVEAL_STAGGER_MS || 120;
    toReveal.forEach((debris, i) => {
      setTimeout(() => {
        debris.discovered = true;
        debris._revealStartTime = performance.now();
        debris._revealProgress = 0;
        eventBus.emit(Events.TARGET_DISCOVERED, { target: debris });
      }, i * staggerMs);
    });
  }

  /**
   * Get active scan status for HUD display.
   * @returns {{ active: boolean, type: string|null, progress: number, quickCooldown: number, wideCooldown: number }}
   */
  getScanStatus() {
    let progress = 0;
    if (this._scanActive && this._scanType) {
      const cfg = this._scanType === 'quick' ? Constants.SCAN.QUICK : Constants.SCAN.WIDE;
      progress = 1 - (this._scanTimer / cfg.DURATION);
    }
    return {
      active: this._scanActive,
      type: this._scanType,
      progress,
      quickCooldown: Math.max(0, this._quickCooldown),
      wideCooldown: Math.max(0, this._wideCooldown),
    };
  }

  // ======================================================================
  // EVENT LISTENERS
  // ======================================================================

  /** @private */
  _setupListeners() {
    // Handles both tier upgrades ({ tier }) and shop upgrades ({ effect, value })
    // GFM.applyUpgradeEffect emits SENSOR_UPGRADE for both new purchases
    // and save-restore paths (decoupled — no direct ref needed)
    eventBus.on(Events.SENSOR_UPGRADE, (data) => {
      if (data.tier) this.upgradeSensor(data.tier);
      else if (data.effect) this.applyUpgrade(data);
    });

    eventBus.on(Events.SENSOR_QUERY_TARGETS, (data) => {
      if (data.playerPos && data.debrisField) {
        const targets = this.getDetectedTargets(data.playerPos, data.debrisField);
        eventBus.emit(Events.SENSOR_DETECTED_TARGETS, { targets });
      }
    });

    // === Active Scan Triggers ===
    eventBus.on(Events.SCAN_QUICK, () => {
      if (this._scanActive || this._quickCooldown > 0) {
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'V5',
          text: this._scanActive ? 'Scan in progress...' : 'Scanner cooling down.',
          priority: 'info',
        });
        return;
      }
      this._startScan('quick');
    });

    eventBus.on(Events.SCAN_WIDE, () => {
      if (this._scanActive || this._wideCooldown > 0) {
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'V5',
          text: this._scanActive ? 'Scan in progress...' : 'Wide scanner cooling down.',
          priority: 'info',
        });
        return;
      }
      this._startScan('wide');
    });
  }
}

export default SensorSystem;
