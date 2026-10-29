/**
 * RewardSystem.js — reward tracker: milestones, synergies, field clearing, sweep report compilation.
 * Listens to game events and awards bonuses via EventBus.
 * @module systems/RewardSystem
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

export class RewardSystem {
  constructor() {
    // Milestones fire once per session unless noted
    /** @type {Map<string,boolean>} */
    this.milestones = new Map();

    this._totalCatches = 0;
    this._totalLassoCatches = 0;
    this._totalArmCatches = 0;

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

    /** @type {number} Total targets that entered tether range this trawl */
    this._fieldTotal = 0;
    /** @type {number} Targets captured this trawl */
    this._fieldCaptured = 0;
    /** @type {Set<string>} Field-clear thresholds already announced */
    this._fieldThresholdsHit = new Set();
    /** @type {string|null} Cluster id currently engaged for field progress (defer-trawl) */
    this._activeClusterId = null;
    /** @type {string|null} Human-readable name of the engaged cluster */
    this._activeClusterName = null;

    /** @type {number} Timestamp of last catch (performance.now ms) */
    this._lastCatchTime = 0;
    /** @type {number} Current consecutive rapid-catch streak */
    this._rapidStreak = 0;

    this._allArmsDeployedNotified = false;

    this._totalDetaches = 0;
    this._detachedCaptures = 0;

    this._setupListeners();

    console.log('[RewardSystem] Initialized');
  }

  /** @private */
  _setupListeners() {
    // ARM_CAPTURED fires on grab (netting success) — the primary catch event; the lasso also emits it with armId='lasso'.
    // DEBRIS_CAPTURED fires on re-dock delivery — do NOT count (would double-count).
    eventBus.on(Events.ARM_CAPTURED, (data) => {
      const isLasso = data && (data.armId === 'lasso' || data.type === 'lasso');
      this._onCapture(data, isLasso ? 'lasso' : 'arm');
    });

    // Metals via CARGO_STORE (synergy detection): only raw metals count, so refined_* and prop_* are skipped.
    eventBus.on(Events.CARGO_STORE, (data) => {
      if (!data || !data.metalId) return;
      const id = data.metalId;
      if (id.startsWith('refined_') || id.startsWith('prop_')) return;
      this._registerMetals([id]);
    });

    // Trawl lifecycle (advanced "Dragnet" mission only)
    eventBus.on(Events.TRAWL_START, () => {
      this._resetTrawlStats();
    });

    eventBus.on(Events.TRAWL_TARGET_ENTERING, () => {
      this._fieldTotal++;
    });

    eventBus.on(Events.TRAWL_SWEEP_COMPLETE, (data) => {
      this._compileSweepReport(data);
    });

    // Active-capture loop: seed field progress from the engaged cluster's REAL size when the player picks a cluster on
    // the Debris Map. This decouples the 25/50/75/100 % comms + tiered bonuses from the (hidden) trawl auto-start.
    eventBus.on(Events.DEBRIS_MAP_CLUSTER_SELECTED, (data) => {
      this._beginCluster(data);
    });

    // Celebration anchor: DebrisField emits this when the last alive member of a cluster bucket is removed via capture/deorbit.
    eventBus.on(Events.CLUSTER_CLEARED, (data) => {
      this._onClusterCleared(data);
    });

    // "All 6 deployed" milestone
    eventBus.on(Events.ARM_DEPLOYED, (data) => {
      if (data && data.armId != null) {
        this._trawlArmsUsed.add(data.armId);
      }
    });

    eventBus.on(Events.ARM_DETACHED, (data) => {
      this._totalDetaches++;
      this._checkDetachMilestones('detach', data);
    });

    // A detached capture is ARM_CAPTURED with `data.detached` (see _checkMilestones).
  }

  /** @private @param {object} data — ARM_CAPTURED payload @param {string} method — 'arm' | 'lasso' | other */
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

    if (data && data.armId != null) {
      this._trawlArmsUsed.add(data.armId);
    }

    this._fieldCaptured++;
    this._checkFieldClearing();

    this._checkMilestones(data, method);

    this._checkRapidStreak();

    // Metals are not tracked here: capture events carry none; they flow GameFlowManager salvage → CARGO_STORE → _registerMetals.
  }

  /**
   * Record every milestone this catch reaches, say ONE line: the most specific one (nets-1b, DECISIONS §33:
   * one line per fact). Specific = about this very catch (a free-flying catch, a large daughter's first, the
   * first lasso catch) before the running counts (50 total, 25 / 10 / 5 this sweep), and the plain
   * "first capture ever" last. Every milestone is still recorded as reached.
   * @private
   */
  _checkMilestones(data, method) {
    // [rank (lower = more specific), line]
    const reached = [];
    const reach = (key, rank, line) => { this.milestones.set(key, true); reached.push([rank, line]); };

    if (this._totalCatches === 1 && !this.milestones.has('firstCatch')) {
      reach('firstCatch', 7, 'Houston: Confirmed first capture. Welcome to the cleanup crew, Cowboy.');
    }

    if (this._trawlCatches === 5 && !this.milestones.has('trawl5')) {
      reach('trawl5', 6, 'Houston: Five captures this sweep. Solid work out there.');
    }

    if (this._trawlCatches === 10 && !this.milestones.has('trawl10')) {
      reach('trawl10', 5, 'Houston: Ten confirmed. You\'re making a real dent in this cluster.');
    }

    if (this._trawlCatches === 25 && !this.milestones.has('trawl25')) {
      reach('trawl25', 4, 'Houston: Twenty-five. That\'s a record pace. Ground team is watching.');
    }

    if (this._totalCatches === 50 && !this.milestones.has('total50')) {
      reach('total50', 3, 'Houston: Fifty objects secured. Command is talking about naming a procedure after you.');
    }

    // Weaver = large arm
    if (method === 'arm' && data && data.type === 'weaver' && !this.milestones.has('firstWeaver')) {
      reach('firstWeaver', 1, 'Houston: First catch by a large daughter. The mother keeps her fuel for the heavy pieces.');
    }

    if (method === 'lasso' && !this.milestones.has('firstLasso')) {
      reach('firstLasso', 2, 'Houston: Lasso capture confirmed. Quick reflexes out there.');
    }

    // Arm was free-flying when it caught
    if (data && data.detached && !this.milestones.has('firstDetachedCapture')) {
      this._detachedCaptures++;
      reach('firstDetachedCapture', 0, 'Houston: Free-flying capture confirmed! That\'s one for the textbooks.');
    }

    if (reached.length > 0) {
      reached.sort((x, y) => x[0] - y[0]);
      this._sendComms(reached[0][1]);
    }
  }

  /** @private @param {string} eventType — 'detach' | 'capture' */
  _checkDetachMilestones(eventType, data) {
    if (eventType === 'detach' && !this.milestones.has('firstDetach')) {
      this.milestones.set('firstDetach', true);
      this._sendComms('Houston: Tether severed. Bold move, Cowboy. That arm is on its own now.', false);
    }
  }

  /** @private */
  _checkRapidStreak() {
    const now = performance.now();
    const elapsed = (now - this._lastCatchTime) / 1000; // seconds

    if (this._lastCatchTime > 0 && elapsed < 30) {
      this._rapidStreak++;
      // Every third rapid catch
      if (this._rapidStreak >= 3 && this._rapidStreak % 3 === 0) {
        this._sendComms('Houston: Rapid captures detected. You\'re in the zone.');
      }
    } else {
      this._rapidStreak = 1;
    }

    this._lastCatchTime = now;
  }

  /** Register metals from a captured piece and check for synergies. @private @param {Array<string>} metalKeys — uppercase, e.g. ['ALUMINUM','COPPER'] */
  _registerMetals(metalKeys) {
    if (!metalKeys || !Array.isArray(metalKeys)) return;

    // Unknown keys can't trigger synergies
    const KNOWN_METALS = new Set(Object.keys(Constants.METALS || {}));

    for (const key of metalKeys) {
      if (!key || typeof key !== 'string' || key.trim() === '') {
        console.warn('[RewardSystem] _registerMetals: skipping invalid metalId:', key);
        continue;
      }
      const upper = key.toUpperCase();
      if (!KNOWN_METALS.has(upper)) {
        console.warn(`[RewardSystem] Unknown metal key: "${upper}". Won't trigger synergies`);
      }
      this._trawlMetals.add(upper);
    }

    const synergies = Constants.SALVAGE_SYNERGIES;
    if (!synergies) return;

    for (const synergy of synergies) {
      const alreadyTriggered = this._trawlSynergies.some(s => s.name === synergy.name);
      if (alreadyTriggered) continue;

      const [metalA, metalB] = synergy.metals;
      if (this._trawlMetals.has(metalA) && this._trawlMetals.has(metalB)) {
        this._triggerSynergy(synergy);
      }
    }
  }

  /** @private @param {object} synergy — { metals, name, points } */
  _triggerSynergy(synergy) {
    this._trawlSynergies.push({ name: synergy.name, points: synergy.points });
    this._trawlBonusPoints += synergy.points;

    eventBus.emit(Events.SCORING_AWARD, {
      points: synergy.points,
      reason: `Synergistic Salvage: ${synergy.name}`,
      withCatch: true,   // part of the catch's payoff line
    });

    this._sendComms(`Houston: Synergistic salvage. ${synergy.name}. Bonus awarded.`);

    // HUD popup
    eventBus.emit(Events.SYNERGY_BONUS, {
      name: synergy.name,
      points: synergy.points,
      metals: synergy.metals,
    });

    console.log(`[RewardSystem] Synergy triggered: ${synergy.name} (+${synergy.points})`);
  }

  /** @private */
  _checkFieldClearing() {
    if (this._fieldTotal <= 0) return;

    const pct = this._fieldCaptured / this._fieldTotal;

    // Comms only, no bonus
    if (pct >= 0.25 && !this._fieldThresholdsHit.has('25')) {
      this._fieldThresholdsHit.add('25');
      this._sendComms('Houston: Quarter of this cluster secured.', false);
    }

    const tiers = Constants.FIELD_CLEAR_THRESHOLDS || [];
    for (const tier of tiers) {
      const key = String(Math.round(tier.pct * 100));
      if (pct >= tier.pct && !this._fieldThresholdsHit.has(key)) {
        this._fieldThresholdsHit.add(key);
        this._trawlBonusPoints += tier.bonus;
        eventBus.emit(Events.SCORING_AWARD, {
          points: tier.bonus,
          reason: tier.label,
          withCatch: true,   // part of the catch's payoff line
        });
        if (tier.pct >= 1.0) {
          this._sendComms('Houston: Field completely cleared! Perfect sweep. Bonus authorized.', false);
        } else if (tier.pct >= 0.75) {
          this._sendComms('Houston: Three-quarters clean. Almost there.', false);
        } else if (tier.pct >= 0.50) {
          this._sendComms('Houston: Half the cluster cleared. Keep it up.', false);
        }
      }
    }
  }

  /**
   * Begin tracking field progress for a newly-engaged cluster: seeds _fieldTotal from its real size so the
   * 25/50/75/100 % comms + tiered bonuses track active hand-clearing instead of trawl windows.
   * @private
   * @param {{clusterId?:string, name?:string, count?:number}} data
   */
  _beginCluster(data) {
    if (!data) return;
    const count = typeof data.count === 'number' ? data.count : 0;

    // Re-selecting the engaged cluster keeps progress; only the total refreshes (the cluster may have grown/shrunk).
    if (data.clusterId && data.clusterId === this._activeClusterId) {
      if (count > 0) this._fieldTotal = count;
      return;
    }

    this._activeClusterId = data.clusterId || null;
    this._activeClusterName = data.name || null;
    this._fieldTotal = count;
    this._fieldCaptured = 0;
    this._fieldThresholdsHit.clear();
  }

  /**
   * Ceremony anchor: DebrisField reports the last alive member of a cluster bucket was removed. Guarantees the
   * 100 % field-clear bonus + comms even if thresholds were never seeded (cluster cleared without opening the
   * Debris Map), then emits a compiled SWEEP_REPORT to drive the star ceremony.
   * @private
   * @param {{clusterId?:string, name?:string, count?:number}} data
   */
  _onClusterCleared(data) {
    data = data || {};

    // Only the actively worked cluster (or an unseeded session) drives the ceremony + bonus: a background clear of a
    // DIFFERENT cluster (a stray deorbit emptying bucket B while engaged on A) must not fire a ceremony with A's
    // counts nor wipe A's tracking.
    const matches = !this._activeClusterId
      || !data.clusterId
      || data.clusterId === this._activeClusterId;
    if (!matches) return;

    if (this._fieldTotal <= 0 && typeof data.count === 'number') {
      this._fieldTotal = data.count;
    }
    if (this._fieldTotal > 0 && this._fieldCaptured < this._fieldTotal) {
      // Some pieces may have been deorbited, not captured: count the bucket as cleared.
      this._fieldCaptured = this._fieldTotal;
    }
    this._checkFieldClearing();

    // Audio cue + star report (reuses SweepReportUI)
    eventBus.emit(Events.AUDIO_CUE, { cue: 'fieldCleared' });
    this._compileSweepReport(
      { duration: 0, targetsEntered: this._fieldTotal },
      { title: 'CLUSTER CLEARED', clusterName: data.name || this._activeClusterName || null }
    );

    // Reset per-cluster trackers. The capture counters must reset here too: the active-capture loop never emits
    // TRAWL_START, so _resetTrawlStats() never runs and _trawlCatches would accrue across clusters (>100 % from the
    // second cluster on).
    this._trawlCatches = 0;
    this._fieldCaptured = 0;
    this._fieldTotal = 0;
    this._activeClusterId = null;
    this._activeClusterName = null;
    this._fieldThresholdsHit.clear();
  }

  /** All 6 arms currently deployed? Called from update(). */
  _checkAllArmsDeployed(armManager) {
    if (!armManager || this._allArmsDeployedNotified) return;

    const deployed = armManager.getDeployedCount ? armManager.getDeployedCount() : 0;
    const total = Constants.OCTOPUS_ARM_COUNT || 6;

    if (deployed >= total) {
      this._allArmsDeployedNotified = true;
      if (!this.milestones.has('allArms')) {
        this.milestones.set('allArms', true);
        this._sendComms('Houston: All six daughters deployed. Full spread. Impressive coordination.');
      }
    }
  }

  /**
   * Compile and emit the full report (star ceremony), for both the advanced trawl sweep (TRAWL_SWEEP_COMPLETE) and the
   * active-capture loop (CLUSTER_CLEARED).
   * @private
   * @param {object} trawlData — { duration, targetsEntered }
   * @param {object} [opts] — { title?:string, clusterName?:string }
   */
  _compileSweepReport(trawlData, opts = {}) {
    // Debris can leave a cluster via deorbit as well as capture, so _fieldCaptured is the authoritative "cleared"
    // tally: use the larger of it and _trawlCatches.
    const totalCaptured = Math.max(this._trawlCatches, this._fieldCaptured);
    const totalTargets = this._fieldTotal;
    const clearPercentage = totalTargets > 0
      ? Math.round((totalCaptured / totalTargets) * 100) : 0;

    const armsUsed = this._trawlArmsUsed.size;
    const synergiesTriggered = [...this._trawlSynergies];
    const totalBonusPoints = this._trawlBonusPoints;
    const timeElapsed = trawlData.duration || 0;
    const lassoCatches = this._trawlLassoCatches;
    const armCatches = this._trawlArmCatches;

    // Weighted: captures, synergies, arms used
    const captureRatio = totalTargets > 0 ? totalCaptured / totalTargets : 0;
    const synergyRatio = Math.min(synergiesTriggered.length / 3, 1); // 3 synergies = max
    const efficiency = Math.min(1, captureRatio * 0.6 + synergyRatio * 0.3 + (armsUsed >= 3 ? 0.1 : 0));

    const stars = this._calculateStars(clearPercentage, synergiesTriggered.length, armsUsed);

    const report = {
      title: opts.title || 'SWEEP REPORT',
      clusterName: opts.clusterName || null,
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

  /** Star rating 1–5. @private @param {number} clearPct — 0–100 */
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
    this._activeClusterId = null;
    this._activeClusterName = null;
    this._allArmsDeployedNotified = false;

    // Per-trawl milestones fire again next trawl
    this.milestones.delete('trawl5');
    this.milestones.delete('trawl10');
    this.milestones.delete('trawl25');

    console.log('[RewardSystem] Trawl stats reset');
  }

  /** Per-frame: arm-deployment milestones. @param {number} dt — seconds @param {object} [armManager] */
  update(dt, armManager) {
    this._checkAllArmsDeployed(armManager);
  }

  /** Send a Houston comms message. @private */
  _sendComms(text, quiet = true) {
    // Houston's praise and milestone lines are `_quiet` (hidden at every tier); the few that say what happened
    // (cluster progress, tether severed, deorbit done) pass quiet=false.
    eventBus.emit(Events.COMMS_MESSAGE, {
      priority: 'MEDIUM',
      source: 'HOUSTON',
      text,
      ...(quiet ? { _quiet: true } : {}),
    });
  }
}

export default RewardSystem;
