/**
 * ScoringSystem.js — Score tracking, calculations, and win/loss conditions
 * @module systems/ScoringSystem
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { gameState } from '../core/GameState.js';

/** Scoring tiers */
export const CAPTURE_TIERS = {
  DATA: 1,       // Scan only
  DEORBIT: 2,    // Ion beam / laser deorbit
  CAPTURE: 3,    // Physical capture
};

/** Base points per debris tier */
const TIER_BASE_POINTS = {
  1: 100,
  2: 300,
  3: 800,
  4: 2000,
};

/** Method bonus multipliers */
const METHOD_BONUS = {
  laser:      1.3,
  ionBeam:    1.4,
  magnetic:   1.2,
  tether:     1.25,
  climber:    1.3,
  arm:        1.0,    // Auto-capture (base — V3 arm system)
  armManual:  2.0,    // Manual arm piloting (future Phase 4)
  armFishing: 1.1,    // Passive fishing capture
};

export class ScoringSystem {
  constructor() {
    this.totalScore = 0;
    this.credits = 0;
    this.debrisCleared = 0;
    this.debrisByTier = { data: 0, deorbit: 0, capture: 0 };
    this.totalMassRecovered = 0;
    this.currentStreak = 0;
    this.bestStreak = 0;
    this.startTime = Date.now();

    // UX-3 N3: First-time arm capture comms messages (once per session)
    this._firstAutoArmMsg = false;
    this._firstManualArmMsg = false;

    // ST-4.C: Track mission number for MISSION_START emission
    this._lastMissionNumber = 1;
    /** @private Cached reference to gameState (set lazily on first SCORE_UPDATE) */
    this._gameState = gameState;

    // ST-4.E: Per-tool ΔV tracking for efficiency report
    this._toolStats = {
      lasso: { catches: 0, dvSpent: 0, dvBefore: 0, active: false },
      arm:   { catches: 0, dvSpent: 0, dvBefore: 0, active: false },
      trawl: { catches: 0, dvSpent: 0, dvBefore: 0, active: false },
    };
    /** @type {object|null} Player satellite ref for ΔV reads */
    this._playerRef = null;

    // Listen for events
    eventBus.on(Events.SCORING_AWARD, (data) => this.awardPoints(data));

    // Phase 5: Wire cargo-sell events to apply market modifiers
    eventBus.on(Events.CARGO_SELL, (data) => this.processSale(data));
    eventBus.on(Events.CARGO_SELL_ALL, (data) => this.processSale(data));

    // ST-4.E: Tool ΔV tracking listeners
    this._setupToolTracking();
  }

  /**
   * Calculate score for a debris interaction.
   * @param {object} params
   * @param {object} params.debris - Debris data object
   * @param {string} params.method - Tool used (laser, ionBeam, magnetic, tether, climber)
   * @param {number} params.captureTier - CAPTURE_TIERS enum
   * @param {number} [params.fragmentsCreated=0] - Fragments spawned
   * @param {number} [params.nearbyActiveSats=0] - Active sats within 10km
   * @returns {number} Final score value
   */
  calculateScore(params) {
    const { debris, method, captureTier, fragmentsCreated = 0, nearbyActiveSats = 0 } = params;

    // Determine base points from debris tier (guess tier from type + mass)
    const debrisTier = this._getDebrisTier(debris);
    let base;
    if (captureTier === CAPTURE_TIERS.DATA) {
      base = Constants.TIER1_BASE;
    } else if (captureTier === CAPTURE_TIERS.DEORBIT) {
      base = Constants.TIER2_BASE;
    } else {
      base = Constants.TIER3_BASE;
    }

    // Size factor: bigger = more points
    const sizeFactor = 1.0 + Math.log10(Math.max(debris.mass || 1, 1)) / 4;

    // Tumble factor: higher tumble = more impressive
    const tumbleRateDeg = (debris.tumbleRate || 0) * 180 / Math.PI;
    const tumbleFactor = 1.0 + tumbleRateDeg / 90.0;

    // Risk multiplier: nearby valuable assets increase stakes
    const riskMultiplier = 1.0 + nearbyActiveSats * 0.5;

    // Method bonus
    const methodBonus = METHOD_BONUS[method] || 1.0;

    // Fragment penalty
    const fragmentPenalty = Math.max(1, fragmentsCreated);

    // Streak bonus (consecutive captures without damage)
    const streakBonus = 1.0 + Math.min(this.currentStreak * 0.1, 0.5);

    const raw = base * sizeFactor * tumbleFactor;
    const final = Math.floor(raw * riskMultiplier * methodBonus * streakBonus / fragmentPenalty);

    return Math.max(10, final); // Minimum 10 points
  }

  /**
   * Award points for a successful interaction.
   * @param {object} data
   */
  awardPoints(data) {
    // Direct point award bypass (scan rewards, mission events, etc.)
    // When data.points is set and no debris object, award points directly
    // without touching streak, debris tier counts, or mass tracking.
    if (data.points != null && !data.debris) {
      const pts = data.points;
      // Penalty awards (e.g. Fragmentation penalty) carry negative points.
      // Floor the spendable balance and score at 0 so a penalty can never
      // drive credits negative — a negative balance soft-locks shop spend()
      // and would round-trip through persistence.
      this.totalScore = Math.max(0, this.totalScore + pts);
      this.credits = Math.max(0, this.credits + pts);
      eventBus.emit(Events.SCORE_UPDATE, {
        total: this.totalScore,
        credits: this.credits,
        delta: pts,
        debrisCleared: this._gameState.debrisCleared,
        streak: this.currentStreak,
        massKg: 0,
        totalMassKg: this.totalMassRecovered,
      });
      return pts;
    }

    let points = this.calculateScore(data);

    // Phase 5: Apply bounty premium based on debris type
    const debrisType = data.debris ? data.debris.type : 'fragment';
    const bountyPremium = (Constants.MARKET && Constants.MARKET.BOUNTY_PREMIUMS)
      ? (Constants.MARKET.BOUNTY_PREMIUMS[debrisType] || 1.0)
      : 1.0;
    points = Math.round(points * bountyPremium);

    // Phase 5: Material mass bonus — 2 credits per kg of metal captured
    if (data.metalMassKg && data.metalMassKg > 0) {
      const materialBonus = Math.round(data.metalMassKg * 2);
      points += materialBonus;
    }

    // Tactical assessment bonus: ×1.3 if player assessed all zones before capture
    if (data.tacticalAssessment) {
      points = Math.round(points * 1.3);
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'HOUSTON',
        text: 'Good assessment, Cowboy.',
        priority: 1,
      });
    }

    // Manual capture bonus: ×2.0 for manually piloting arm to target
    if (data.manualCapture) {
      points = Math.round(points * 2.0);
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'HOUSTON',
        text: 'Clean approach. Manual piloting noted.',
        priority: 1,
      });
    }

    // UX-3 N3: First-time arm capture comms hints (once per session)
    // Guard: manualCapture !== undefined distinguishes arm path (always sets it)
    // from lasso path (emits SCORING_AWARD with method:'arm' but no manualCapture)
    if ((data.method === 'arm' || data.method === 'armManual' || data.method === 'armFishing')
        && data.manualCapture !== undefined) {
      if (data.manualCapture && !this._firstManualArmMsg) {
        this._firstManualArmMsg = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: 'Manual daughter capture: 2× score bonus!',
          source: 'SYSTEM',
          channel: 'CMD',
          priority: 'info',
        });
      } else if (!data.manualCapture && !this._firstAutoArmMsg) {
        this._firstAutoArmMsg = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: 'Auto-capture complete. Pilot daughters with 1-4 for 2× score bonus.',
          source: 'SYSTEM',
          channel: 'CMD',
          priority: 'info',
        });
      }
    }

    // Fuel efficiency bonus: ×1.25 for fuel-efficient manual capture
    if (data.fuelEfficient) {
      points = Math.round(points * 1.25);
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'HOUSTON',
        text: 'Efficient trajectory. Minimal fuel expenditure.',
        priority: 1,
      });
    }

    // Salvage recovery bonus: ×1.15 when debris had salvageable resources (Session 10)
    if (data.salvageRecovered) {
      points = Math.round(points * Constants.SALVAGE_SCORE_MULTIPLIER);
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'HOUSTON',
        text: 'Salvage recovered. Good haul.',
        priority: 1,
      });
    }

    // Deorbit sacrifice bonus (Session 10): arm sacrificed with captured debris
    if (data.deorbitSacrifice) {
      const deorbitMult = data.deorbitMultiplier || Constants.DEORBIT_MULTIPLIER_BASE;
      points = Math.round(points * deorbitMult);
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'HOUSTON',
        text: 'She went down with the target. Worth it.',
        priority: 1,
      });
    }

    // Phase 6: Detached arm capture — ×2.0 for free-flying catch
    if (data.detachedCapture) {
      points = Math.round(points * Constants.DETACH_SCORE_MULT);
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'HOUSTON',
        text: 'COWBOY! Free-flying capture! Textbook maneuver.',
        priority: 1,
      });
    }

    // Phase 6: Detached arm deorbit sacrifice — ×2.5
    if (data.detachedSacrifice) {
      points = Math.round(points * Constants.DETACH_SACRIFICE_MULT);
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'HOUSTON',
        text: 'Godspeed. She took the debris with her. Sacrifice noted.',
        priority: 1,
      });
    }

    this.totalScore += points;
    this.credits += points;
    // S1 Fix M1: Do NOT increment this.debrisCleared here.
    // gameState.debrisCleared (incremented by GameFlowManager → gameState.clearDebris())
    // is the single source of truth for debris count.
    this.currentStreak += 1;
    this.bestStreak = Math.max(this.bestStreak, this.currentStreak);

    // S9-A: Track total mass recovered for display
    const debrisMassKg = data.debris?.mass || 0;
    this.totalMassRecovered += debrisMassKg;

    // Track by tier
    if (data.captureTier === CAPTURE_TIERS.DATA) this.debrisByTier.data++;
    else if (data.captureTier === CAPTURE_TIERS.DEORBIT) this.debrisByTier.deorbit++;
    else this.debrisByTier.capture++;

    eventBus.emit(Events.SCORE_UPDATE, {
      total: this.totalScore,
      credits: this.credits,
      delta: points,
      debrisCleared: gameState.debrisCleared,  // S1 Fix M1: single source of truth
      streak: this.currentStreak,
      massKg: debrisMassKg,
      totalMassKg: this.totalMassRecovered,
    });

    // ST-4.C: Check for mission transition after debris cleared count changes
    this._checkMissionTransition();

    // S1 Fix M1+L2: Win check REMOVED from ScoringSystem.
    // GameState.update() is the sole win-condition emitter.

    return points;
  }

  /**
   * Spend credits in the shop.
   * @param {number} amount
   * @returns {boolean} Whether purchase was successful
   */
  spendCredits(amount) {
    if (this.credits < amount) return false;
    this.credits -= amount;
    eventBus.emit(Events.SCORE_UPDATE, {
      total: this.totalScore,
      credits: this.credits,
      delta: 0,
      debrisCleared: gameState.debrisCleared,  // S1 Fix M1: single source of truth
    });
    return true;
  }

  /**
   * Add credits directly (e.g. from cargo sales, contract bonuses).
   * @param {number} amount
   */
  addCredits(amount) {
    if (amount <= 0) return;
    this.credits += amount;
    this.totalScore += amount;
    eventBus.emit(Events.SCORE_UPDATE, {
      total: this.totalScore,
      credits: this.credits,
      delta: amount,
      debrisCleared: gameState.debrisCleared,  // S1 Fix M1: single source of truth
    });
  }

  /**
   * Process a cargo sale, applying MARKET sell modifier and bulk bonus.
   * Wired to CARGO_SELL / CARGO_SELL_ALL events.
   * @param {object} data - { totalValue: number, totalMassKg: number }
   * @returns {number} Final sale value credited
   */
  processSale(data) {
    if (!data || !data.totalValue || data.totalValue <= 0) return 0;

    const market = Constants.MARKET || {};
    let saleValue = data.totalValue;

    // Apply sell price modifier (market spread — 85% of listed value)
    const sellMod = market.SELL_PRICE_MODIFIER || 0.85;
    saleValue = Math.round(saleValue * sellMod);

    // Apply bulk bonus if selling above mass threshold
    const bulkThreshold = market.BULK_THRESHOLD_KG || 50;
    const bulkMult = market.BULK_BONUS_MULTIPLIER || 1.15;
    if (data.totalMassKg && data.totalMassKg >= bulkThreshold) {
      saleValue = Math.round(saleValue * bulkMult);
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `BULK BONUS ×${bulkMult} — ${data.totalMassKg.toFixed(0)}kg sold at once!`,
        priority: 'success',
      });
    }

    this.addCredits(saleValue);
    return saleValue;
  }

  /**
   * Break streak on damage/failure.
   */
  breakStreak() {
    this.currentStreak = 0;
  }

  /**
   * Get stats summary.
   */
  getStats() {
    const elapsed = (Date.now() - this.startTime) / 1000;
    const minutes = Math.floor(elapsed / 60);
    const seconds = Math.floor(elapsed % 60);
    return {
      totalScore: this.totalScore,
      credits: this.credits,
      debrisCleared: gameState.debrisCleared,  // S1 Fix M1: read from single source
      debrisByTier: { ...this.debrisByTier },
      bestStreak: this.bestStreak,
      timePlayed: `${minutes}:${seconds.toString().padStart(2, '0')}`,
      timePlayedSeconds: elapsed,
    };
  }

  /**
   * Serialize scoring state for persistence.
   * @returns {object}
   */
  serialize() {
    return {
      credits: this.credits,
      totalScore: this.totalScore,
      missionNumber: Math.floor(gameState.debrisCleared / 5) + 1,  // S1 Fix M1
      debrisCleared: gameState.debrisCleared,  // S1 Fix M1
      totalCaptures: gameState.debrisCleared,  // S1 Fix M1
      manualCaptures: 0,  // not yet tracked individually
      missionsCompleted: Math.floor(gameState.debrisCleared / 5),  // S1 Fix M1
      bestMissionScore: this.totalScore,
      bestStreak: this.bestStreak,
      currentStreak: this.currentStreak,
      debrisByTier: { ...this.debrisByTier },
    };
  }

  /**
   * Restore scoring state from saved data.
   * Handles missing fields gracefully with defaults.
   * @param {object} data - Previously serialized scoring state
   */
  restore(data) {
    if (!data) return;
    // Clamp at 0: a corrupt or penalty-driven negative balance must never
    // restore into a state that blocks shop purchases.
    this.totalScore = Math.max(0, data.totalScore || 0);
    this.credits = Math.max(0, data.credits || 0);
    this.debrisCleared = data.debrisCleared || 0;
    this.debrisByTier = data.debrisByTier || { data: 0, deorbit: 0, capture: 0 };
    this.currentStreak = data.currentStreak || 0;
    this.bestStreak = data.bestStreak || 0;
    this.startTime = Date.now();
  }

  /**
   * Reset scoring for a new game.
   */
  reset() {
    this.totalScore = 0;
    this.credits = 0;
    this.debrisCleared = 0;
    this.debrisByTier = { data: 0, deorbit: 0, capture: 0 };
    this.currentStreak = 0;
    this.bestStreak = 0;
    this.startTime = Date.now();
    this._lastMissionNumber = 1;   // ST-4.C
    // ST-4.E: Reset per-tool ΔV tracking
    this._toolStats = {
      lasso: { catches: 0, dvSpent: 0, dvBefore: 0, active: false },
      arm:   { catches: 0, dvSpent: 0, dvBefore: 0, active: false },
      trawl: { catches: 0, dvSpent: 0, dvBefore: 0, active: false },
    };
  }

  // ==========================================================================
  // ST-4.C: Mission Profile Helpers
  // ==========================================================================

  /**
   * Check if mission number has changed and emit MISSION_START if so.
   * @private
   */
  _checkMissionTransition() {
    const newMission = this.getMissionNumber();
    if (newMission !== this._lastMissionNumber) {
      this._lastMissionNumber = newMission;
      const profile = this._getMissionProfile(newMission);
      eventBus.emit(Events.MISSION_START, { missionNumber: newMission, profile });
    }
  }

  /**
   * Get the current mission number based on debris cleared.
   * @returns {number}
   */
  getMissionNumber() {
    return Math.floor((this._gameState?.debrisCleared || 0) / Constants.MISSIONS.DEBRIS_PER_MISSION) + 1;
  }

  /**
   * Get the mission profile for a given mission number.
   * Highest-matching minMission wins.
   * @param {number} missionNumber
   * @returns {object} Mission profile from Constants.MISSIONS.PROFILES
   */
  _getMissionProfile(missionNumber) {
    const profiles = Constants.MISSIONS.PROFILES;
    let best = profiles[0];
    for (const p of profiles) {
      if (missionNumber >= p.minMission) best = p;
    }
    return best;
  }

  /**
   * Determine debris difficulty tier from properties.
   * @private
   */
  _getDebrisTier(debris) {
    if (debris.type === 'rocketBody' && debris.mass > 4000) return 4;
    if (debris.type === 'rocketBody') return 3;
    if (debris.type === 'defunctSat') return debris.mass > 500 ? 3 : 2;
    if (debris.type === 'missionDebris') return debris.mass > 5 ? 2 : 1;
    return 1; // fragments
  }

  // ==========================================================================
  // ST-4.E: Tool-Tier Efficiency Report
  // ==========================================================================

  /**
   * Set reference to player satellite for ΔV tracking.
   * @param {object} player — PlayerSatellite instance with getDeltaVSpent()
   */
  setPlayer(player) {
    this._playerRef = player;
  }

  /**
   * Get per-tool efficiency stats for the sweep report.
   * @returns {Array<{name:string, catches:number, dvSpent:number, dvPerCatch:number, isBest?:boolean}>}
   */
  getToolStats() {
    const stats = [];
    for (const [name, s] of Object.entries(this._toolStats)) {
      if (s.catches > 0) {
        stats.push({
          name,
          catches: s.catches,
          dvSpent: s.dvSpent,
          dvPerCatch: s.dvSpent / s.catches,
        });
      }
    }
    // Sort by dvPerCatch ascending (most efficient first)
    stats.sort((a, b) => a.dvPerCatch - b.dvPerCatch);
    // Mark the best (lowest dvPerCatch)
    if (stats.length > 0) stats[0].isBest = true;
    return stats;
  }

  /**
   * Set up EventBus listeners for per-tool ΔV attribution.
   * Snapshot getDeltaVSpent() before/after each tool operation.
   * @private
   */
  _setupToolTracking() {
    // --- Lasso: start on LASSO_FIRED, end on LASSO_CAPTURED or LASSO_MISSED ---
    eventBus.on(Events.LASSO_FIRED, () => {
      if (this._playerRef) {
        this._toolStats.lasso.dvBefore = this._playerRef.getDeltaVSpent?.() || 0;
        this._toolStats.lasso.active = true;
      }
    });
    eventBus.on(Events.LASSO_CAPTURED, () => {
      this._finishToolTracking('lasso', true);
    });
    eventBus.on(Events.LASSO_MISSED, () => {
      this._finishToolTracking('lasso', false);
    });

    // --- Arm/Crossbow: start on CROSSBOW_FIRE, end on ARM_CAPTURED ---
    eventBus.on(Events.CROSSBOW_FIRE, () => {
      if (this._playerRef) {
        this._toolStats.arm.dvBefore = this._playerRef.getDeltaVSpent?.() || 0;
        this._toolStats.arm.active = true;
      }
    });
    eventBus.on(Events.ARM_CAPTURED, () => {
      this._finishToolTracking('arm', true);
    });

    // --- Trawl: start on TRAWL_START, end on TRAWL_CAPTURE or TRAWL_END ---
    eventBus.on(Events.TRAWL_START, () => {
      if (this._playerRef) {
        this._toolStats.trawl.dvBefore = this._playerRef.getDeltaVSpent?.() || 0;
        this._toolStats.trawl.active = true;
      }
    });
    eventBus.on(Events.TRAWL_CAPTURE, () => {
      this._finishToolTracking('trawl', true);
    });

    // --- Enrich SWEEP_REPORT with toolStats (mutate same object ref) ---
    eventBus.on(Events.SWEEP_REPORT, (report) => {
      report.toolStats = this.getToolStats();
    });

    // --- Houston efficiency comms after M2 (missionNumber >= 3) ---
    eventBus.on(Events.MISSION_START, (d) => {
      if (d.missionNumber >= 3) {
        this._sendEfficiencyComms();
      }
    });
  }

  /**
   * Finish ΔV tracking for a tool operation.
   * @private
   * @param {string} toolName — 'lasso' | 'arm' | 'trawl'
   * @param {boolean} captured — whether the operation resulted in a capture
   */
  _finishToolTracking(toolName, captured) {
    const tool = this._toolStats[toolName];
    if (!tool || !tool.active) return;
    tool.active = false;

    const dvAfter = this._playerRef?.getDeltaVSpent?.() || 0;
    const dvUsed = Math.max(0, dvAfter - tool.dvBefore);
    tool.dvSpent += dvUsed;

    if (captured) {
      tool.catches++;
    }
  }

  /**
   * Send Houston comms about tool efficiency after mission 2.
   * @private
   */
  _sendEfficiencyComms() {
    const stats = this.getToolStats();
    if (stats.length < 2) return; // Need at least 2 tools for comparison

    const best = stats[0]; // Already sorted by dvPerCatch ascending
    const worst = stats[stats.length - 1];

    if (best.name !== worst.name) {
      const ratio = worst.dvPerCatch > 0
        ? (worst.dvPerCatch / best.dvPerCatch).toFixed(0)
        : '∞';
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'HOUSTON',
        text: `Analysis: ${best.name.toUpperCase()} averaged ${best.dvPerCatch.toFixed(1)} m/s per catch — ${ratio}× more efficient than ${worst.name.toUpperCase()}. Consider using ${best.name} for future operations.`,
        priority: 1,
      });
    }
  }
}

export const scoringSystem = new ScoringSystem();
export default scoringSystem;
