/**
 * SensorSystem.js — sensor range tiers, range-gated detection, distance-gated data enrichment, active scans
 * @module systems/SensorSystem
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { powerDistribution } from './PowerDistribution.js';
import { Constants } from '../core/Constants.js';
import { wingsHint } from './WingsHint.js';
import { clamp01 } from '../core/MathUtil.js';

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

const DATA_LEVELS = {
  FAR:    { level: 0, label: 'Unresolved',  fields: ['type'] },
  MEDIUM: { level: 1, label: 'Classified',  fields: ['type', 'size', 'mass'] },
  NEAR:   { level: 2, label: 'Analyzed',    fields: ['type', 'size', 'mass', 'material', 'tumbleRate'] },
  CLOSE:  { level: 3, label: 'Full Profile', fields: ['type', 'size', 'mass', 'material', 'tumbleRate', 'brittleness', 'orbit'] },
};

export class SensorSystem {
  constructor() {
    this.tier = 'basic';

    /** @type {number} Detection range in scene units */
    this.range = SENSOR_TIERS.basic.range;

    this.scanRate = SENSOR_TIERS.basic.scanRate;

    this.detectedTargets = [];

    this.canScanSalvage = false;

    this._weatherSensorMult = 1.0;

    /** @type {number} Seconds since last WEATHER_ACTIVE event */
    this._weatherLastUpdate = 0;

    this._scanActive = false;
    /** @type {string|null} Current scan type: 'quick' or 'wide' */
    this._scanType = null;
    /** @type {number} Seconds remaining on active scan */
    this._scanTimer = 0;
    /** @type {number} Quick scan cooldown remaining (seconds) */
    this._quickCooldown = 0;
    /** @type {number} Wide scan cooldown remaining (seconds) */
    this._wideCooldown = 0;

    this._scanCount = 0;
    this._scanCreditsTotal = 0;
    /**
     * Field ids already paid out this session. Ground stations pay for NEW survey data: the first scan of a field pays;
     * re-scanning it yields no reward but still works (reveals fresh arrivals, satisfies onboarding).
     * @type {Set<string>}
     */
    this._rewardedFields = new Set();

    // Skill gate: suppress sensor weather effects until the scan skill is discovered
    this._scanDiscovered = false;
    eventBus.on(Events.SKILL_DISCOVERED, (d) => {
        if (d?.skillId === 'scan_quick') this._scanDiscovered = true;
    });

    // DECISIONS §15 row 2 ("scanning costs battery and heat, like mana"): the ledger the scans pay into.
    // null (menu hero, unit tests that never wire it) → scans stay free.
    /** @type {object|null} ResourceSystem — setResourceSystem() */
    this._resourceSystem = null;
    /** @type {Array<{remaining:number, rate:number}>} the computer's analysis loads still running */
    this._analysisJobs = [];
    /** True once this boot's first (cold, whole-sky) search has been paid. Not persisted. */
    this._coldSearchDone = false;

    eventBus.on(Events.WEATHER_ACTIVE, (effects) => {
      if (!this._scanDiscovered) return;
      this._weatherSensorMult = effects.sensorRange ?? 1.0;
      this._weatherLastUpdate = 0;
    });

    eventBus.on(Events.GAME_RESET, () => {
      this._scanCount = 0;
      this._scanCreditsTotal = 0;
      this._rewardedFields.clear();
      this._analysisJobs.length = 0;   // a retry does not inherit a running analysis
      this._coldSearchDone = false;    // every start has no tracks yet
    });

    this._setupListeners();
  }

  /**
   * Every debris piece within sensor range, enriched by data level.
   * @param {THREE.Vector3} playerPos
   * @param {object} debrisField DebrisField instance (needs getDebrisNear)
   */
  getDetectedTargets(playerPos, debrisField) {
    if (!debrisField || !playerPos) return [];

    if (powerDistribution.sensorMultiplier <= 0) return [];

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
   * Apply a shop upgrade (multiplicative on current tier values).
   * @param {object} data { effect: string, value: number|boolean } @returns {boolean} true if handled
   */
  applyUpgrade(data) {
    switch (data.effect) {
      case 'sensorRange':
        // basic 0.1 × 1.5 = 0.15 = 15 km
        this.range *= data.value;
        break;
      case 'detectUntracked':
        this.canDetectUntracked = true;
        break;
      case 'scanRange':
        this.scanRate *= data.value;
        break;
      case 'salvageScan':
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
   * Wire the battery the scans pay from (main.js, beside armManager.setResourceSystem). Unwired → scans are free.
   * @param {object|null} rs ResourceSystem (canAfford / consume / drawUpTo)
   */
  setResourceSystem(rs) {
    this._resourceSystem = rs || null;
  }

  /**
   * Cost of one scan in battery units (Wh): POWER_COST × the 600 Wh base battery (Constants.BATTERY_MAX, an absolute
   * energy, so a bigger bought battery makes a scan relatively cheaper) × SCAN.COST_MULT. SWEEP_SHARE of it is the sweep,
   * paid the instant the scan starts; the rest is the computer's analysis, a steady load over ANALYSIS_S real s.
   * `opts.cold` prices the first scan of a boot, a whole-sky search with no tracks yet: at least SCAN.COLD_SEARCH_WH ×
   * COST_MULT (the wide scan's energy), same sweep share, analysis over the longer of the pressed scan's and the wide
   * scan's ANALYSIS_S.
   * @param {'quick'|'wide'} type
   * @returns {{ total:number, sweep:number, analysis:number, analysisS:number, analysisW:number }}
   */
  getScanCost(type, opts) {
    const S = Constants.SCAN;
    const cfg = type === 'quick' ? S.QUICK : S.WIDE;
    const mult = Number.isFinite(S.COST_MULT) ? Math.max(0, S.COST_MULT) : 1;
    let total = (cfg.POWER_COST || 0) * Constants.BATTERY_MAX * mult;
    let analysisS = Math.max(0.1, cfg.ANALYSIS_S || 1);
    if (opts && opts.cold) {
      total = Math.max(total, (S.COLD_SEARCH_WH || 0) * mult);
      analysisS = Math.max(analysisS, (S.WIDE && S.WIDE.ANALYSIS_S) || 0);
    }
    const share = Number.isFinite(S.SWEEP_SHARE) ? clamp01(S.SWEEP_SHARE) : 1 / 3;
    const sweep = total * share;
    const analysis = total - sweep;
    const wPerUnitS = (Constants.SHIP_HEAT && Constants.SHIP_HEAT.W_PER_UNIT_S) || 1000;
    return { total, sweep, analysis, analysisS, analysisW: (analysis / analysisS) * wPerUnitS };
  }

  /**
   * Pay a scan's sweep now and queue its analysis load. Refuses (reactive comms line) when the battery can't pay the
   * sweep. The first paid scan of a boot is the cold search (getScanCost cold). @returns {boolean} true when the scan may start
   * @private
   */
  _payScan(type) {
    const rs = this._resourceSystem;
    if (!rs) return true;   // unwired (menu hero, unit tests): free
    const cold = !this._coldSearchDone;
    const cost = this.getScanCost(type, { cold });
    if (cost.total <= 0) return true;
    if (!rs.canAfford('battery', cost.sweep)) {
      // With the wings rolled up the true way out is the wings, not "wait for sunlight": say so and re-post the wings
      // row. Wings already commanded out (rolling, or out) or no ship seen yet (null: unit tests) keep the old line. The
      // line doesn't name the key or the floor-1 button; the re-posted wings chip carries the how.
      const wingsUp = wingsHint.needsOpening() === true;
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'V5',
        text: wingsUp
          ? 'Battery too low to scan. The wings are rolled up.'
          : 'Battery too low to scan — it recharges in sunlight.',
        priority: 'warning',
        _reactive: true,   // answers the S press — never muted (commsSuppression)
      });
      if (wingsUp) wingsHint.post();
      return false;
    }
    rs.consume('battery', cost.sweep);
    this._coldSearchDone = true;
    if (cost.analysis > 0) {
      this._analysisJobs.push({ remaining: cost.analysis, rate: cost.analysis / cost.analysisS });
    }
    return true;
  }

  /**
   * Draw the running analysis loads for `dt` real seconds. The battery pays what it holds (drawUpTo); an empty battery
   * starves the computer, it does not refund the scan. Called by the game loop beside resourceSystem.update under the
   * SAME held-world guard (main.js), NOT from update(), which runs while a drawer holds the world: a held analysis
   * pauses, it is not lost.
   */
  drawAnalysis(dt) {
    const jobs = this._analysisJobs;
    if (jobs.length === 0 || !(dt > 0)) return;
    const rs = this._resourceSystem;
    for (let i = jobs.length - 1; i >= 0; i--) {
      const job = jobs[i];
      const want = Math.min(job.remaining, job.rate * dt);
      if (rs && want > 0) rs.drawUpTo('battery', want);
      job.remaining -= want;
      if (job.remaining <= 1e-9) jobs.splice(i, 1);
    }
  }

  update(dt, playerPos, debrisField) {
    // Cache player position & debris field for _revealNearbyDebris
    if (playerPos) this._lastPlayerPos = playerPos;
    if (debrisField) this._lastDebrisField = debrisField;

    // Staleness: reset the weather multiplier if no WEATHER_ACTIVE for 2 s
    this._weatherLastUpdate += dt;
    if (this._weatherLastUpdate > 2.0) {
      this._weatherSensorMult = 1.0;
    }

    if (this._scanActive) {
      this._scanTimer -= dt;
      if (this._scanTimer <= 0) {
        this._completeScan();
      }
    }

    if (this._quickCooldown > 0) this._quickCooldown -= dt;
    if (this._wideCooldown > 0) this._wideCooldown -= dt;

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

  // PRIVATE

  /** @param {number} distance scene units */
  _getDataLevel(distance) {
    if (distance <= 0.005) return DATA_LEVELS.CLOSE;   // ≤ 500 m
    if (distance <= 0.02)  return DATA_LEVELS.NEAR;    // ≤ 2 km
    const halfRange = SENSOR_TIERS[this.tier].range * 0.5;
    if (distance <= halfRange) return DATA_LEVELS.MEDIUM;
    return DATA_LEVELS.FAR;
  }

  _enrichData(entry, dataLevel) {
    const tierDef = SENSOR_TIERS[this.tier];

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

  _startScan(type) {
    const cfg = type === 'quick' ? Constants.SCAN.QUICK : Constants.SCAN.WIDE;
    this._scanActive = true;
    this._scanType = type;
    this._scanTimer = cfg.DURATION;

    eventBus.emit(Events.SCAN_INITIATED, { type });

    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'V5',
      text: type === 'quick'
        ? 'Quick scan initiated...'
        : 'Wide aperture scan. Stand by...',
      priority: 'info',
    });
  }

  _completeScan() {
    const type = this._scanType;
    const cfg = type === 'quick' ? Constants.SCAN.QUICK : Constants.SCAN.WIDE;

    this._scanActive = false;
    this._scanType = null;

    if (type === 'quick') {
      this._quickCooldown = cfg.COOLDOWN;
    } else {
      this._wideCooldown = cfg.COOLDOWN;
    }

    // Field-based survey economy: ground stations pay for NEW data about a debris field. Re-scanning the SAME field returns
    // data they already have (no reward), which kills scan-farming one spot. A mission spanning several fields pays per field.
    this._scanCount++;
    const baseReward = cfg.REWARD;
    const sessionCap = Constants.SCAN.SESSION_SCAN_CAP || 5000;

    const revealRange = (Constants.SCAN.REVEAL_BASE_RANGE || 5.0) * (cfg.RANGE_MULTIPLIER || 1.0);
    const fieldId = (this._lastDebrisField && this._lastPlayerPos)
      ? this._lastDebrisField.getFieldIdNear(this._lastPlayerPos, revealRange)
      : null;

    // `getFieldIdNear` is a 500 km FIELD test: on M1 it still finds the welcome cluster after it drifted out of the
    // forward arc, so the reward reads 'stale' and the recovery advisor (keys on 'empty') stays silent. So SCAN_COMPLETE
    // also carries `contactsInRange` (non-hazard pieces inside the reveal range; the same query the reveal below consumes,
    // run ONCE and handed down) and `missionNumber`, letting NavRecoveryAdvisor post a bearing when nothing is in reach and,
    // on M1, the cluster count + bearing. `(x || 1)` mirrors DebrisField's own "M1 until told otherwise" reading of
    // `_currentMissionNumber`.
    const nearby = (this._lastDebrisField && this._lastPlayerPos)
      ? this._lastDebrisField.getDebrisNear(this._lastPlayerPos, revealRange)
      : null;
    let contactsInRange = 0;
    if (nearby) {
      for (const copy of nearby) {
        if (copy && !copy.hazard) contactsInRange++;
      }
    }
    const missionNumber = this._lastDebrisField
      ? (this._lastDebrisField._currentMissionNumber || 1)
      : null;

    let reward = 0;
    let rewardKind = 'none'; // 'fresh' | 'stale' | 'empty' | 'capped'

    if (!fieldId) {
      rewardKind = 'empty';
    } else if (this._rewardedFields.has(fieldId)) {
      rewardKind = 'stale';
    } else {
      // Fresh field: full survey value, mildly diminishing across DISTINCT fields surveyed (not per repeated scan).
      const fieldsPaid = this._rewardedFields.size;
      const diminish = Math.max(0.5, 1 - fieldsPaid * 0.05); // -5% per distinct field, floor 50%
      reward = Math.round(baseReward * diminish);
      rewardKind = 'fresh';

      // Session cap: final safety net against pathological field-hopping.
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

    if (reward > 0) {
      eventBus.emit(Events.SCORING_AWARD, {
        points: reward,
        reason: type === 'quick' ? 'Quick scan survey data' : 'Deep scan survey data',
      });
    }

    // Feedback explains WHY the yield is what it is. These lines use `sender:` with no bypass tag, so at suppression tier 0
    // (onboarding Director) they are muted anyway; the M1 skip below matters once onboarding has ended.
    if (rewardKind === 'fresh') {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'HOUSTON',
        text: `Survey data received. Fresh field logged. +$${reward}`,
        priority: 'info',
      });
    } else if (rewardKind === 'stale') {
      // On mission 1 the ONLY field is the welcome cluster: "Move to a new field" would send a new player away from what
      // they must clear, and the re-scan is usually a "where did it go?" request, which NavRecoveryAdvisor answers with
      // count + bearing. Credit logic is unchanged (a stale field pays nothing); only the line is skipped.
      if (missionNumber !== 1) {
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'HOUSTON',
          text: 'Survey data for this field is already current. No new value. Move to a new field for fresh data.',
          priority: 'info',
        });
      }
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

    const discoveries = [];
    const maxDisc = type === 'wide' ? (cfg.MAX_DISCOVERIES || 1) : 1;
    const discTypes = ['fragment', 'fragment', 'fragment', 'missionDebris', 'defunctSat', 'rocketBody'];
    // All salvage metals (from SALVAGE_SYNERGIES)
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

    // rewardKind lets NavRecoveryAdvisor route 'empty' scans into bearing guidance; contactsInRange / missionNumber extend
    // that to "field found but nothing in reach" and the M1 count + bearing line.
    const results = {
      type,
      discoveries: discoveries.length,
      reward,
      rewardKind,
      contactsInRange,
      missionNumber,
    };
    eventBus.emit(Events.SCAN_COMPLETE, results);

    // Per-discovery events + bonus. The wide-scan bonus is gated to FRESH fields only (no farming discovery credits by
    // re-scanning); SCAN_DISCOVERY still fires so hazard/synergy gameplay (MissionEventSystem) is unaffected.
    discoveries.forEach(d => {
      eventBus.emit(Events.SCAN_DISCOVERY, d);
      if (type === 'wide' && cfg.DISCOVERY_REWARD && rewardKind === 'fresh') {
        eventBus.emit(Events.SCORING_AWARD, {
          points: cfg.DISCOVERY_REWARD,
          reason: 'New contact discovered',
        });
      }
    });

    // Houston reports only newly-found contacts; the credit yield was already reported above with the actual amount.
    if (discoveries.length > 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'HOUSTON',
        text: `Scan complete. ${discoveries.length} new contact${discoveries.length > 1 ? 's' : ''} found!`,
        priority: 'success',
      });
    }

    // Staggered reveal of undiscovered debris near the player. Hands down the query already run for `contactsInRange` (same
    // range) so the field is walked once; the call stays HERE to keep the synchronous SCAN_REVEALS_SETTLED ordering after
    // SCAN_COMPLETE.
    this._revealNearbyDebris(type, nearby);
  }

  /**
   * Discover undiscovered debris near the player with staggered timing; quick scan reveals fewer targets at shorter range.
   * @param {Array<object>} [nearbyArg] the getDebrisNear result for this scan's reveal range when the caller has it
   *   (_completeScan); omitted → runs its own query, so direct callers (tests) keep working.
   * @private
   */
  _revealNearbyDebris(scanType, nearbyArg) {
    const debrisField = this._lastDebrisField;
    const playerPos = this._lastPlayerPos;
    if (!debrisField || !playerPos) return;

    // REVEAL_BASE_RANGE (500 km base) × config multiplier; the sensor range (this.range) is too small for orbital-scale discovery
    const cfg = scanType === 'wide' ? Constants.SCAN.WIDE : Constants.SCAN.QUICK;
    const revealRange = (Constants.SCAN.REVEAL_BASE_RANGE || 5.0) * (cfg.RANGE_MULTIPLIER || 1.0);
    const maxReveals = cfg.MAX_REVEALS || (scanType === 'wide' ? 10 : 5);

    // getDebrisNear returns spread-copies; originals come via getDebrisById. Truly empty space → no reveal-settled event
    // (NavRecoveryAdvisor's empty-scan guidance owns it, rewardKind:'empty'): no double messaging.
    const nearby = Array.isArray(nearbyArg)
      ? nearbyArg
      : debrisField.getDebrisNear(playerPos, revealRange);
    if (!nearby || nearby.length === 0) return;

    // Undiscovered only, resolved to the original objects (already sorted by distance). hasDiscovered: a re-scan of a known
    // field still fills the selection even when nothing new is revealed. Hazard shards (the power-law background cloud) are
    // never revealed: uncapturable furniture, and the reveal budget belongs to the authored foreground cast.
    const toReveal = [];
    let hasDiscovered = false;
    for (const copy of nearby) {
      if (copy.hazard) continue;
      if (copy.discovered) { hasDiscovered = true; continue; }
      const original = debrisField.getDebrisById(copy.id);
      if (original && !original.discovered) {
        toReveal.push(original);
        if (toReveal.length >= maxReveals) break;
      }
    }

    const staggerMs = Constants.SCAN.REVEAL_STAGGER_MS || 120;
    toReveal.forEach((debris, i) => {
      setTimeout(() => {
        debris.discovered = true;
        debris._revealStartTime = performance.now();
        debris._revealProgress = 0;
        eventBus.emit(Events.TARGET_DISCOVERED, { target: debris });
      }, i * staggerMs);
    });

    // Signal that reveals have settled so scan auto-select can fill the Tracked Targets pane: after the last staggered reveal
    // (+50 ms margin) when there are new contacts; immediately when nothing new but the field holds discovered contacts;
    // never when the field is genuinely empty (NavRecoveryAdvisor's territory).
    if (toReveal.length > 0) {
      setTimeout(() => {
        eventBus.emit(Events.SCAN_REVEALS_SETTLED, {
          revealed: toReveal.length,
          scanType,
        });
      }, toReveal.length * staggerMs + 50);
    } else if (hasDiscovered) {
      eventBus.emit(Events.SCAN_REVEALS_SETTLED, {
        revealed: 0,
        scanType,
      });
    }
  }

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

  _setupListeners() {
    // Handles tier upgrades ({ tier }) and shop upgrades ({ effect, value }); GFM.applyUpgradeEffect emits SENSOR_UPGRADE for
    // both new purchases and save-restore (decoupled, no direct ref).
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

    eventBus.on(Events.SCAN_QUICK, () => {
      if (this._scanActive || this._quickCooldown > 0) {
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'V5',
          text: this._scanActive ? 'Scan in progress...' : 'Scanner cooling down.',
          priority: 'info',
        });
        return;
      }
      if (!this._payScan('quick')) return;   // the sweep is paid up front
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
      if (!this._payScan('wide')) return;
      this._startScan('wide');
    });
  }
}

export default SensorSystem;
