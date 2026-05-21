/**
 * RewardSystem.js — Centralized reward tracker: milestones, synergies,
 * field clearing, and sweep report compilation.
 * Listens to game events and awards bonuses via EventBus.
 * @module systems/RewardSystem
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

export class RewardSystem {
  constructor() {
    // === Milestone tracking (fire-once per session unless noted) ===
    /** @type {Map<string,boolean>} */
    this.milestones = new Map();

    // === Session-level counters ===
    this._totalCatches = 0;
    this._totalLassoCatches = 0;
    this._totalArmCatches = 0;

    // === Per-trawl tracking ===
    this._trawlCatches = 0;
    this._trawlArmCatches = 0;
    this._trawlLassoCatches = 0;
    this._trawlStartTime = 0;

    /** @type {Set<string>} Metal keys collected this trawl (uppercase, e.g. 'ALUMINUM') */
    this._trawlMetals = new Set();

    /** @type {Array<{name:string,points:number}>} Synergies triggered this trawl */
    this._trawlSynergies = [];

    /** @type {number} Total bonus points awarded this trawl */
    this._trawlBonusPoints = 0;

    /** @type {Set<number>} Unique arm IDs used this trawl */
    this._trawlArmsUsed = new Set();

    // === Field clearing ===
    /** @type {number} Total targets that entered tether range this trawl */
    this._fieldTotal = 0;
    /** @type {number} Targets captured this trawl */
    this._fieldCaptured = 0;
    /** @type {Set<string>} Field-clear thresholds already announced */
    this._fieldThresholdsHit = new Set();

    // === Streak tracking ===
    /** @type {number} Timestamp of last catch (performance.now ms) */
    this._lastCatchTime = 0;
    /** @type {number} Current consecutive rapid-catch streak */
    this._rapidStreak = 0;

    // === All-arms-deployed tracking ===
    this._allArmsDeployedNotified = false;

    // === Detach tracking (Phase 6 — Risk-Reward) ===
    this._totalDetaches = 0;
    this._detachedCaptures = 0;
    this._detachedDeorbits = 0;

    this._setupListeners();

    console.log('[RewardSystem] Initialized');
  }

  // ==========================================================================
  // EVENT LISTENERS
  // ==========================================================================

  /** @private */
  _setupListeners() {
    // --- Arm capture (net/gecko/tether/lasso) ---
    // ARM_CAPTURED fires on grab (netting success) — primary catch event.
    // Lasso also emits ARM_CAPTURED with armId='lasso'.
    // DEBRIS_CAPTURED fires on re-dock delivery — do NOT count (would double-count).
    eventBus.on(Events.ARM_CAPTURED, (data) => {
      const isLasso = data && (data.armId === 'lasso' || data.type === 'lasso');
      this._onCapture(data, isLasso ? 'lasso' : 'arm');
    });

    // --- Metal tracking via cargo store (synergy detection) ---
    // CARGO_STORE fires when salvaged metals are stored.
    // Filter out refined_* and prop_* (only raw metals count for synergy).
    eventBus.on(Events.CARGO_STORE, (data) => {
      if (!data || !data.metalId) return;
      const id = data.metalId;
      // Skip refined and propellant variants
      if (id.startsWith('refined_') || id.startsWith('prop_')) return;
      this._registerMetals([id]);
    });

    // --- Trawl lifecycle ---
    eventBus.on(Events.TRAWL_START, () => {
      this._resetTrawlStats();
    });

    eventBus.on(Events.TRAWL_TARGET_ENTERING, () => {
      this._fieldTotal++;
    });

    eventBus.on(Events.TRAWL_SWEEP_COMPLETE, (data) => {
      this._compileSweepReport(data);
    });

    // --- Arm deploy tracking for "all 6 deployed" milestone ---
    eventBus.on(Events.ARM_DEPLOYED, (data) => {
      if (data && data.armId != null) {
        this._trawlArmsUsed.add(data.armId);
      }
    });

    // --- Phase 6: Tether detach milestones ---
    eventBus.on(Events.ARM_DETACHED, (data) => {
      this._totalDetaches++;
      this._checkDetachMilestones('detach', data);
    });

    // Detached arm capture: ARM_CAPTURED with isDetached context
    // We check isDetached on the arm in _checkMilestones below

    // Detached arm deorbit: ARM_DEORBIT from a detached arm
    eventBus.on(Events.ARM_DEORBIT, (data) => {
      // Check if this deorbit was from a detached arm
      // (we track by checking if detaches > detachedDeorbits)
      if (this._totalDetaches > this._detachedDeorbits) {
        this._detachedDeorbits++;
        this._checkDetachMilestones('deorbit', data);
      }
    });
  }

  // ==========================================================================
  // CAPTURE HANDLER
  // ==========================================================================

  /**
   * Unified handler for any debris capture event.
   * @private
   * @param {object} data — event payload (armId, targetId, type, metals, etc.)
   * @param {string} method — 'arm' | 'lasso' | other
   */
  _onCapture(data, method) {
    this._totalCatches++;
    this._trawlCatches++;

    if (method === 'arm') {
      this._totalArmCatches++;
      this._trawlArmCatches++;
    } else if (method === 'lasso') {
      this._totalLassoCatches++;
      this._trawlLassoCatches++;
    }

    // Track arm usage
    if (data && data.armId != null) {
      this._trawlArmsUsed.add(data.armId);
    }

    // Field clearing
    this._fieldCaptured++;
    this._checkFieldClearing();

    // Milestone checks
    this._checkMilestones(data, method);

    // Rapid-catch streak
    this._checkRapidStreak();

    // Note: Metals are tracked separately via CARGO_STORE listener.
    // Capture events don't carry metal data — metals flow through
    // GameFlowManager salvage → CARGO_STORE → _registerMetals.
  }

  // ==========================================================================
  // MILESTONES
  // ==========================================================================

  /** @private */
  _checkMilestones(data, method) {
    // First catch ever
    if (this._totalCatches === 1 && !this.milestones.has('firstCatch')) {
      this.milestones.set('firstCatch', true);
      this._sendComms('Houston: Confirmed first capture. Welcome to the cleanup crew, Cowboy.');
    }

    // 5 catches this trawl
    if (this._trawlCatches === 5 && !this.milestones.has('trawl5')) {
      this.milestones.set('trawl5', true);
      this._sendComms('Houston: Five captures this sweep. Solid work out there.');
    }

    // 10 catches this trawl
    if (this._trawlCatches === 10 && !this.milestones.has('trawl10')) {
      this.milestones.set('trawl10', true);
      this._sendComms('Houston: Ten confirmed. You\'re making a real dent in this cluster.');
    }

    // 25 catches this trawl
    if (this._trawlCatches === 25 && !this.milestones.has('trawl25')) {
      this.milestones.set('trawl25', true);
      this._sendComms('Houston: Twenty-five. That\'s a record pace. Ground team is watching.');
    }

    // 50 total catches
    if (this._totalCatches === 50 && !this.milestones.has('total50')) {
      this.milestones.set('total50', true);
      this._sendComms('Houston: Fifty objects secured. Command is talking about naming a procedure after you.');
    }

    // First Weaver catch (large arm, type 'weaver')
    if (method === 'arm' && data && data.type === 'weaver' && !this.milestones.has('firstWeaver')) {
      this.milestones.set('firstWeaver', true);
      this._sendComms('Houston: Large object secured via Weaver. That\'s the heavy lifting we need.');
    }

    // First lasso catch
    if (method === 'lasso' && !this.milestones.has('firstLasso')) {
      this.milestones.set('firstLasso', true);
      this._sendComms('Houston: Lasso capture confirmed. Quick reflexes out there.');
    }

    // First detached capture (Phase 6 — arm was free-flying when it caught)
    if (data && data.detached && !this.milestones.has('firstDetachedCapture')) {
      this._detachedCaptures++;
      this.milestones.set('firstDetachedCapture', true);
      this._sendComms('Houston: Free-flying capture confirmed! That\'s one for the textbooks.');
    }
  }

  /**
   * Check detach-specific milestones.
   * @private
   * @param {string} eventType — 'detach' | 'capture' | 'deorbit'
   * @param {object} data — event payload
   */
  _checkDetachMilestones(eventType, data) {
    // First detach ever
    if (eventType === 'detach' && !this.milestones.has('firstDetach')) {
      this.milestones.set('firstDetach', true);
      this._sendComms('Houston: Tether severed. Bold move, Cowboy. That arm is on its own now.');
    }

    // First detached deorbit
    if (eventType === 'deorbit' && !this.milestones.has('firstDetachedDeorbit')) {
      this.milestones.set('firstDetachedDeorbit', true);
      this._sendComms('Houston: Detached daughter completed deorbit. Sacrificial play — debris eliminated.');
    }
  }

  // ==========================================================================
  // RAPID STREAK
  // ==========================================================================

  /** @private */
  _checkRapidStreak() {
    const now = performance.now();
    const elapsed = (now - this._lastCatchTime) / 1000; // seconds

    if (this._lastCatchTime > 0 && elapsed < 30) {
      this._rapidStreak++;
      // Streak of 3 — can repeat
      if (this._rapidStreak >= 3 && this._rapidStreak % 3 === 0) {
        this._sendComms('Houston: Rapid captures detected. You\'re in the zone.');
      }
    } else {
      this._rapidStreak = 1;
    }

    this._lastCatchTime = now;
  }

  // ==========================================================================
  // SYNERGISTIC SALVAGE
  // ==========================================================================

  /**
   * Register metals from a captured debris piece and check for synergies.
   * @private
   * @param {Array<string>} metalKeys — uppercase metal keys e.g. ['ALUMINUM','COPPER']
   */
  _registerMetals(metalKeys) {
    if (!metalKeys || !Array.isArray(metalKeys)) return;

    // Known metals derived from Constants — unknown keys can't trigger synergies
    const KNOWN_METALS = new Set(Object.keys(Constants.METALS || {}));

    // Add each metal to the trawl set
    for (const key of metalKeys) {
      if (!key || typeof key !== 'string' || key.trim() === '') {
        console.warn('[RewardSystem] _registerMetals: skipping invalid metalId:', key);
        continue;
      }
      const upper = key.toUpperCase();
      if (!KNOWN_METALS.has(upper)) {
        console.warn(`[RewardSystem] Unknown metal key: "${upper}" — won't trigger synergies`);
      }
      this._trawlMetals.add(upper);
    }

    // Check all synergy pairs
    const synergies = Constants.SALVAGE_SYNERGIES;
    if (!synergies) return;

    for (const synergy of synergies) {
      // Already triggered this trawl?
      const alreadyTriggered = this._trawlSynergies.some(s => s.name === synergy.name);
      if (alreadyTriggered) continue;

      // Both metals present?
      const [metalA, metalB] = synergy.metals;
      if (this._trawlMetals.has(metalA) && this._trawlMetals.has(metalB)) {
        this._triggerSynergy(synergy);
      }
    }
  }

  /**
   * Fire synergy bonus events.
   * @private
   * @param {object} synergy — { metals, name, points }
   */
  _triggerSynergy(synergy) {
    this._trawlSynergies.push({ name: synergy.name, points: synergy.points });
    this._trawlBonusPoints += synergy.points;

    // Award points
    eventBus.emit(Events.SCORING_AWARD, {
      points: synergy.points,
      reason: `Synergistic Salvage: ${synergy.name}`,
    });

    // Comms
    this._sendComms(`Houston: Synergistic salvage — ${synergy.name}. Bonus awarded.`);

    // Synergy bonus event for HUD popup
    eventBus.emit(Events.SYNERGY_BONUS, {
      name: synergy.name,
      points: synergy.points,
      metals: synergy.metals,
    });

    console.log(`[RewardSystem] Synergy triggered: ${synergy.name} (+${synergy.points})`);
  }

  // ==========================================================================
  // FIELD CLEARING
  // ==========================================================================

  /** @private */
  _checkFieldClearing() {
    if (this._fieldTotal <= 0) return;

    const pct = this._fieldCaptured / this._fieldTotal;

    // Comms-only milestone (no bonus)
    if (pct >= 0.25 && !this._fieldThresholdsHit.has('25')) {
      this._fieldThresholdsHit.add('25');
      this._sendComms('Houston: Quarter of this cluster secured.');
    }

    // Tiered bonuses from Constants
    const tiers = Constants.FIELD_CLEAR_THRESHOLDS || [];
    for (const tier of tiers) {
      const key = String(Math.round(tier.pct * 100));
      if (pct >= tier.pct && !this._fieldThresholdsHit.has(key)) {
        this._fieldThresholdsHit.add(key);
        this._trawlBonusPoints += tier.bonus;
        eventBus.emit(Events.SCORING_AWARD, {
          points: tier.bonus,
          reason: tier.label,
        });
        if (tier.pct >= 1.0) {
          this._sendComms('Houston: Field completely cleared! Perfect sweep. Bonus authorized.');
        } else if (tier.pct >= 0.75) {
          this._sendComms('Houston: Three-quarters clean. Almost there.');
        } else if (tier.pct >= 0.50) {
          this._sendComms('Houston: Half the cluster cleared. Keep it up.');
        }
      }
    }
  }

  /**
   * Get field clearing progress for HUD display.
   * @returns {{ captured: number, total: number, percentage: number }}
   */
  getFieldProgress() {
    const total = this._fieldTotal;
    const captured = this._fieldCaptured;
    const percentage = total > 0 ? Math.round((captured / total) * 100) : 0;
    return { captured, total, percentage };
  }

  // ==========================================================================
  // ALL-ARMS-DEPLOYED CHECK
  // ==========================================================================

  /**
   * Check if all 6 arms are currently deployed. Called from update().
   * @param {object} armManager — ArmManager instance
   */
  _checkAllArmsDeployed(armManager) {
    if (!armManager || this._allArmsDeployedNotified) return;

    const deployed = armManager.getDeployedCount ? armManager.getDeployedCount() : 0;
    const total = Constants.OCTOPUS_ARM_COUNT || 6;

    if (deployed >= total) {
      this._allArmsDeployedNotified = true;
      if (!this.milestones.has('allArms')) {
        this.milestones.set('allArms', true);
        this._sendComms('Houston: All six daughters deployed. Full spread — impressive coordination.');
      }
    }
  }

  // ==========================================================================
  // SWEEP REPORT
  // ==========================================================================

  /**
   * Compile and emit the full sweep report when a trawl ends.
   * @private
   * @param {object} trawlData — { duration, targetsEntered }
   */
  _compileSweepReport(trawlData) {
    const totalCaptured = this._trawlCatches;
    const totalTargets = this._fieldTotal;
    const clearPercentage = totalTargets > 0
      ? Math.round((totalCaptured / totalTargets) * 100) : 0;

    const armsUsed = this._trawlArmsUsed.size;
    const synergiesTriggered = [...this._trawlSynergies];
    const totalBonusPoints = this._trawlBonusPoints;
    const timeElapsed = trawlData.duration || 0;
    const lassoCatches = this._trawlLassoCatches;
    const armCatches = this._trawlArmCatches;

    // Efficiency: weighted score (captures, synergies, speed)
    const captureRatio = totalTargets > 0 ? totalCaptured / totalTargets : 0;
    const synergyRatio = Math.min(synergiesTriggered.length / 3, 1); // 3 synergies = max
    const efficiency = Math.min(1, captureRatio * 0.6 + synergyRatio * 0.3 + (armsUsed >= 3 ? 0.1 : 0));

    // Star rating
    const stars = this._calculateStars(clearPercentage, synergiesTriggered.length, armsUsed);

    const report = {
      totalCaptured,
      totalTargets,
      clearPercentage,
      synergiesTriggered,
      totalBonusPoints,
      timeElapsed,
      armsUsed,
      lassoCatches,
      armCatches,
      efficiency,
      stars,
    };

    eventBus.emit(Events.SWEEP_REPORT, report);
    console.log('[RewardSystem] Sweep report emitted:', report);
  }

  /**
   * Calculate star rating (1–5).
   * @private
   * @param {number} clearPct — 0–100
   * @param {number} synergyCount
   * @param {number} armsUsed
   * @returns {number} 1–5
   */
  _calculateStars(clearPct, synergyCount, armsUsed) {
    // 5 stars: 100% cleared OR ≥90% with ≥3 synergies
    if (clearPct >= 100 || (clearPct >= 90 && synergyCount >= 3)) return 5;

    // 4 stars: ≥75% cleared + ≥2 synergies + ≥3 different arms
    if (clearPct >= 75 && synergyCount >= 2 && armsUsed >= 3) return 4;

    // 3 stars: ≥50% cleared + at least 1 synergy
    if (clearPct >= 50 && synergyCount >= 1) return 3;

    // 2 stars: ≥25% cleared
    if (clearPct >= 25) return 2;

    // 1 star: any trawl completed
    return 1;
  }

  // ==========================================================================
  // TRAWL RESET
  // ==========================================================================

  /** @private Reset per-trawl tracking. */
  _resetTrawlStats() {
    this._trawlCatches = 0;
    this._trawlArmCatches = 0;
    this._trawlLassoCatches = 0;
    this._trawlStartTime = performance.now();
    this._trawlMetals.clear();
    this._trawlSynergies = [];
    this._trawlBonusPoints = 0;
    this._trawlArmsUsed.clear();
    this._fieldTotal = 0;
    this._fieldCaptured = 0;
    this._fieldThresholdsHit.clear();
    this._allArmsDeployedNotified = false;

    // Reset per-trawl milestones so they can fire again next trawl
    this.milestones.delete('trawl5');
    this.milestones.delete('trawl10');
    this.milestones.delete('trawl25');

    console.log('[RewardSystem] Trawl stats reset');
  }

  // ==========================================================================
  // UPDATE (called each frame)
  // ==========================================================================

  /**
   * Per-frame update. Checks arm-deployment milestones.
   * @param {number} dt — delta time (seconds)
   * @param {object} [armManager] — ArmManager instance
   */
  update(dt, armManager) {
    this._checkAllArmsDeployed(armManager);
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  /**
   * Send a Houston comms message.
   * @private
   * @param {string} text
   */
  _sendComms(text) {
    eventBus.emit(Events.COMMS_MESSAGE, {
      priority: 'MEDIUM',
      source: 'HOUSTON',
      text,
    });
  }
}

export default RewardSystem;
