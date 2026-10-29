/**
 * ScoringSystem.js — score and credit ledgers, capture payouts, market sale math
 * @module systems/ScoringSystem
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { gameState } from '../core/GameState.js';
import { missionProfileFor } from '../core/missionProgress.js';
import { radToDeg, clamp } from '../core/MathUtil.js';

export const CAPTURE_TIERS = {
  DATA: 1,       // Scan only
  DEORBIT: 2,    // Ion beam / laser deorbit
  CAPTURE: 3,    // Physical capture
};

/**
 * Method bonus multipliers. `arm` is the only method the shipped build emits (a no-op 1.0, kept to document it).
 * Manual-piloting reward lives only in the situational `manualCapture` ×2.0, under the soft caps; a method multiplier
 * would stack outside them.
 */
const METHOD_BONUS = {
  arm: 1.0,
};

export class ScoringSystem {
  constructor() {
    this.totalScore = 0;
    this.credits = 0;
    // Cumulative per-RUN credits paid through the capture path ONLY (not direct-points awards, sales, contracts or the
    // FIRST_DEPOT_FLOOR top-up). Drives CAPTURE_CREDITS_TAPER. Persisted; 0 for old saves (a late-game load briefly
    // escapes the taper: accepted).
    this.captureCreditsEarned = 0;
    /** One-shot per-run comms when the taper first activates. */
    this._taperCommsFired = false;
    this.debrisCleared = 0;
    this.debrisByTier = { data: 0, deorbit: 0, capture: 0 };
    this.totalMassRecovered = 0;
    this.currentStreak = 0;
    this.bestStreak = 0;
    this.startTime = Date.now();

    this._firstAutoArmMsg = false;
    this._firstManualArmMsg = false;

    this._lastMissionNumber = 1;
    this._gameState = gameState;

    this._toolStats = {
      lasso: { catches: 0, dvSpent: 0, dvBefore: 0, active: false },
      arm:   { catches: 0, dvSpent: 0, dvBefore: 0, active: false },
      trawl: { catches: 0, dvSpent: 0, dvBefore: 0, active: false },
    };
    this._playerRef = null;

    eventBus.on(Events.SCORING_AWARD, (data) => this.awardPoints(data));

    eventBus.on(Events.CARGO_SELL, (data) => this.processSale(data));
    eventBus.on(Events.CARGO_SELL_ALL, (data) => this.processSale(data));

    this._setupToolTracking();
  }

  /**
   * Score for a debris interaction.
   * @param {number} params.captureTier CAPTURE_TIERS enum
   * @param {number} [params.nearbyActiveSats=0] active sats within 10 km
   */
  calculateScore(params) {
    const { debris, method, captureTier, fragmentsCreated = 0, nearbyActiveSats = 0 } = params;

    const debrisTier = this._getDebrisTier(debris);
    let base;
    if (captureTier === CAPTURE_TIERS.DATA) {
      base = Constants.TIER1_BASE;
    } else if (captureTier === CAPTURE_TIERS.DEORBIT) {
      base = Constants.TIER2_BASE;
    } else {
      base = Constants.TIER3_BASE;
    }

    // Scale the base by DEBRIS tier so a tiny fragment doesn't pay a rocket body's flat base (keeps the first depot in
    // its 600–1,500 cr band): fragment ≈ 0.4× … rocket body ≈ 1.0×. The salvage value below adds the mass share.
    const tierWeights = Constants.DEBRIS_TIER_BASE_WEIGHT || { 1: 0.4, 2: 0.7, 3: 1.0 };
    base *= (tierWeights[debrisTier] || 1.0);

    const sizeFactor = 1.0 + Math.log10(Math.max(debris.mass || 1, 1)) / 4;

    // Tumble bonus is a DESPIN reward: paid only when the piece SPAWNED above spec (_initialTumbleRate > IN_SPEC_DEG)
    // and is in spec at capture. A still-tumbling lucky catch earns nothing; it scales with the original spin.
    const inSpecDeg = (Constants.NET_TUMBLE_PENALTY && Constants.NET_TUMBLE_PENALTY.IN_SPEC_DEG) || 10;
    const initialTumbleDeg = (radToDeg(debris._initialTumbleRate != null
      ? debris._initialTumbleRate
      : (debris.tumbleRate || 0)));
    const captureTumbleDeg = radToDeg(debris.tumbleRate || 0);
    let tumbleFactor = 1.0;
    if (initialTumbleDeg > inSpecDeg && captureTumbleDeg <= inSpecDeg) {
      // Proportional to the above-spec spin tamed; sloped and capped so a fast fragment despin can't dominate a run.
      const despinBonus = (initialTumbleDeg - inSpecDeg) / (Constants.TUMBLE_DESPIN_SLOPE_DEG || 340);
      tumbleFactor = 1.0 + Math.min(despinBonus, (Constants.TUMBLE_DESPIN_MAX_BONUS || 0.5));
    }

    const riskMultiplier = 1.0 + nearbyActiveSats * 0.5;

    const methodBonus = METHOD_BONUS[method] || 1.0;

    const fragmentPenalty = Math.max(1, fragmentsCreated);

    // Streak: consecutive captures without damage
    const streakBonus = 1.0 + Math.min(this.currentStreak * 0.1, 0.5);

    const raw = base * sizeFactor * tumbleFactor;
    const final = Math.floor(raw * riskMultiplier * methodBonus * streakBonus / fragmentPenalty);

    return Math.max(10, final); // Minimum 10 points
  }

  /** @returns {number} credits paid */
  awardPoints(data) {
    // Direct award (scan rewards, mission events): points with no debris skip streak, tier counts and mass tracking.
    if (data.points != null && !data.debris) {
      const pts = data.points;
      // Penalty awards carry negative points. Floor balance and score at 0: a negative balance soft-locks shop spend()
      // and would persist.
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
        // a bounty released with the catch is part of the catch's payoff
        ...(data.withCatch ? { kind: 'catch-bonus' } : {}),
      });
      return pts;
    }

    let points = this.calculateScore(data);

    const debrisType = data.debris ? data.debris.type : 'fragment';
    const bountyPremium = (Constants.MARKET && Constants.MARKET.BOUNTY_PREMIUMS)
      ? (Constants.MARKET.BOUNTY_PREMIUMS[debrisType] || 1.0)
      : 1.0;
    points = Math.round(points * bountyPremium);

    // Situational multipliers accumulate into ONE product, soft-capped (SITUATIONAL_MULT_SOFT_CAP) before a single apply
    // (stacked inline they reached ~×7.5). Comms still fire per bonus.
    let situationalMult = 1.0;

    // Tactical assessment bonus: ×1.3 if player assessed all zones before capture
    if (data.tacticalAssessment) {
      situationalMult *= 1.3;
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'HOUSTON',
        text: 'Good assessment, Cowboy.',
        priority: 1,
        _quiet: true,   // praise comms stay hidden
      });
    }

    if (data.manualCapture) {
      situationalMult *= 2.0;
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'HOUSTON',
        text: 'Clean approach. Manual piloting noted.',
        priority: 1,
        _quiet: true,
      });
    }

    // First-time arm capture comms (once per session). manualCapture !== undefined separates the arm path (always sets it)
    // from the lasso path (SCORING_AWARD with method:'arm' but no manualCapture).
    if ((data.method === 'arm' || data.method === 'armManual')
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

    if (data.fuelEfficient) {
      situationalMult *= 1.25;
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'HOUSTON',
        text: 'Efficient trajectory. Minimal fuel expenditure.',
        priority: 1,
        _quiet: true,
      });
    }

    if (data.salvageRecovered) {
      situationalMult *= Constants.SALVAGE_SCORE_MULTIPLIER;
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'HOUSTON',
        text: 'Salvage recovered. Good haul.',
        priority: 1,
        _quiet: true,
      });
    }

    if (data.detachedCapture) {
      situationalMult *= Constants.DETACH_SCORE_MULT;
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'HOUSTON',
        text: 'COWBOY! Free-flying capture! Textbook maneuver.',
        priority: 1,
        _quiet: true,
      });
    }

    // Soft-cap the situational product, apply once. The score and credits ledgers split here: score cap 2.5 (skill rating),
    // wallet cap SITUATIONAL_MULT_SOFT_CAP_CREDITS (1.5), so skilled manual play earns ~+50% credits over auto-capture
    // instead of ~6–7×. The shared `points` (base × bounty) feeds both.
    const scoreCap = Constants.SITUATIONAL_MULT_SOFT_CAP || 2.5;
    const creditsCap = Constants.SITUATIONAL_MULT_SOFT_CAP_CREDITS != null
      ? Constants.SITUATIONAL_MULT_SOFT_CAP_CREDITS
      : scoreCap;
    let scorePoints = Math.round(points * Math.min(situationalMult, scoreCap));
    let creditPoints = Math.round(points * Math.min(situationalMult, creditsCap));

    // owner 2026-08-21: no salvaged-metal bonus; a passed metalMassKg is ignored (tombstone pin in test-economy-invariants.js).

    // Per-RUN capture-credits taper on the FULL post-cap creditPoints, then a hard per-award clamp so one big award can't
    // overshoot CEILING_X×catalog. Score is NEVER tapered; only the wallet saturates late-run (pushes the endgame toward
    // refine-and-contribute).
    const taperCfg = Constants.CAPTURE_CREDITS_TAPER || { START_X: 1.5, CEILING_X: 2.5 };
    const catalogCr = (Constants.SHOP && Constants.SHOP.CATALOG_TOTAL_CR) || 42800;
    const ceilingCr = taperCfg.CEILING_X * catalogCr;
    const startCr = taperCfg.START_X * catalogCr;
    const taper = taperMultiplier(this.captureCreditsEarned, catalogCr, taperCfg);
    creditPoints = Math.round(creditPoints * taper);
    creditPoints = clamp(Math.round(ceilingCr - this.captureCreditsEarned), 0, creditPoints);
    // One-shot comms when the taper first bites, so shrinking payouts read as fiction, not a bug.
    if (!this._taperCommsFired && this.captureCreditsEarned >= startCr) {
      this._taperCommsFired = true;
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'HOUSTON',
        text: "Salvage market's saturating, Cowboy. Rates are dropping.",
        priority: 1,
      });
    }
    this.captureCreditsEarned += creditPoints;

    this.totalScore += scorePoints;
    this.credits += creditPoints;
    // Do NOT increment this.debrisCleared: gameState.debrisCleared (via GameFlowManager → clearDebris()) is the single source.
    this.currentStreak += 1;
    this.bestStreak = Math.max(this.bestStreak, this.currentStreak);

    const debrisMassKg = data.debris?.mass || 0;
    this.totalMassRecovered += debrisMassKg;

    if (data.captureTier === CAPTURE_TIERS.DATA) this.debrisByTier.data++;
    else if (data.captureTier === CAPTURE_TIERS.DEORBIT) this.debrisByTier.deorbit++;
    else this.debrisByTier.capture++;

    eventBus.emit(Events.SCORE_UPDATE, {
      total: this.totalScore,
      credits: this.credits,
      // The ledgers diverge: legacy `delta` aliases the CREDITS delta (wallet consumers read it); scoreDelta/creditsDelta
      // are explicit.
      delta: creditPoints,
      scoreDelta: scorePoints,
      creditsDelta: creditPoints,
      debrisCleared: gameState.debrisCleared,
      streak: this.currentStreak,
      massKg: debrisMassKg,
      totalMassKg: this.totalMassRecovered,
      // tells the payoff line a credited catch from other credit changes
      debrisType: data.debris?.type ?? null,
      kind: 'catch',
      // a scoop bag pays one award per member; each event carries its bag so the payoff line shows ONE line (members summed).
      // Absent for a solo catch.
      ...(data.bag ? { bagId: data.bag.id, bagCount: data.bag.count, bagMassKg: data.bag.massKg } : null),
    });

    // Mission transition is NOT checked here: GameFlowManager calls checkMissionTransition() after clearDebris(); here the
    // count isn't incremented yet, so MISSION_START would fire one catch late.
    // No win check: GameState.update() is the sole win-condition emitter.

    return creditPoints;
  }

  spendCredits(amount) {
    if (this.credits < amount) return false;
    this.credits -= amount;
    eventBus.emit(Events.SCORE_UPDATE, {
      total: this.totalScore,
      credits: this.credits,
      delta: 0,
      debrisCleared: gameState.debrisCleared,
    });
    return true;
  }

  /**
   * Add credits directly (cargo sales, contract contributions and WIN_BONUS, FIRST_DEPOT_FLOOR top-up). CREDITS-ONLY: never
   * touches totalScore (a payment, not an achievement). Capture/boss/bounty awards pay BOTH via awardPoints.
   * @param {number} amount
   */
  addCredits(amount) {
    if (amount <= 0) return;
    this.credits += amount;
    eventBus.emit(Events.SCORE_UPDATE, {
      total: this.totalScore,
      credits: this.credits,
      delta: amount,
      debrisCleared: gameState.debrisCleared,
    });
  }

  /**
   * A disposed big piece's pay lands in the wallet AND the score total, like a catch's credit; streak, capture taper and tier
   * counts are untouched (the piece was counted at the catch). Emits SCORE_UPDATE `kind: 'disposal'` (the payoff line shows
   * `kind: 'catch'` only; the disposal's own line is said by `GameFlowManager.disposeBigPiece`).
   * @param {number} amount credits, whole @returns {number} what was paid
   */
  awardDisposal(amount) {
    const cr = Math.max(0, Math.round(Number(amount)) || 0);
    if (cr <= 0) return 0;
    this.totalScore += cr;
    this.credits += cr;
    eventBus.emit(Events.SCORE_UPDATE, {
      total: this.totalScore,
      credits: this.credits,
      delta: cr,
      scoreDelta: cr,
      creditsDelta: cr,
      debrisCleared: gameState.debrisCleared,
      streak: this.currentStreak,
      massKg: 0,
      totalMassKg: this.totalMassRecovered,
      kind: 'disposal',
    });
    return cr;
  }

  /**
   * Cargo sale with the MARKET sell modifier and bulk bonus; wired to CARGO_SELL / CARGO_SELL_ALL.
   * @param {object} data { totalValue, totalMassKg } @returns {number} credited value
   */
  processSale(data) {
    if (!data || !data.totalValue || data.totalValue <= 0) return 0;

    const { saleValue, bulk } = computeSaleValue(data.totalValue, data.totalMassKg);

    if (bulk) {
      const bulkMult = (Constants.MARKET && Constants.MARKET.BULK_BONUS_MULTIPLIER) || 1.15;
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `BULK BONUS ×${bulkMult}. ${data.totalMassKg.toFixed(0)}kg sold at once!`,
        priority: 'success',
      });
    }

    this.addCredits(saleValue);
    return saleValue;
  }

  breakStreak() {
    this.currentStreak = 0;
  }

  getStats() {
    const elapsed = (Date.now() - this.startTime) / 1000;
    const minutes = Math.floor(elapsed / 60);
    const seconds = Math.floor(elapsed % 60);
    return {
      totalScore: this.totalScore,
      credits: this.credits,
      debrisCleared: gameState.debrisCleared,
      debrisByTier: { ...this.debrisByTier },
      bestStreak: this.bestStreak,
      timePlayed: `${minutes}:${seconds.toString().padStart(2, '0')}`,
      timePlayedSeconds: elapsed,
    };
  }

  serialize() {
    return {
      credits: this.credits,
      totalScore: this.totalScore,
      captureCreditsEarned: this.captureCreditsEarned,
      missionNumber: Math.floor(gameState.debrisCleared / Constants.MISSIONS.DEBRIS_PER_MISSION) + 1,
      debrisCleared: gameState.debrisCleared,
      totalCaptures: gameState.debrisCleared,
      manualCaptures: 0,  // not yet tracked individually
      missionsCompleted: Math.floor(gameState.debrisCleared / Constants.MISSIONS.DEBRIS_PER_MISSION),
      bestMissionScore: this.totalScore,
      bestStreak: this.bestStreak,
      currentStreak: this.currentStreak,
      debrisByTier: { ...this.debrisByTier },
    };
  }

  restore(data) {
    if (!data) return;
    // Clamp at 0: a corrupt or penalty-driven negative balance must never block shop purchases.
    this.totalScore = Math.max(0, data.totalScore || 0);
    this.credits = Math.max(0, data.credits || 0);
    this.captureCreditsEarned = Math.max(0, data.captureCreditsEarned || 0);
    this.debrisCleared = data.debrisCleared || 0;
    this.debrisByTier = data.debrisByTier || { data: 0, deorbit: 0, capture: 0 };
    this.currentStreak = data.currentStreak || 0;
    this.bestStreak = data.bestStreak || 0;
    this.startTime = Date.now();
  }

  reset() {
    this.totalScore = 0;
    this.credits = 0;
    this.captureCreditsEarned = 0;
    this._taperCommsFired = false;
    this.debrisCleared = 0;
    this.debrisByTier = { data: 0, deorbit: 0, capture: 0 };
    this.currentStreak = 0;
    this.bestStreak = 0;
    this.startTime = Date.now();
    this._lastMissionNumber = 1;
    this._toolStats = {
      lasso: { catches: 0, dvSpent: 0, dvBefore: 0, active: false },
      arm:   { catches: 0, dvSpent: 0, dvBefore: 0, active: false },
      trawl: { catches: 0, dvSpent: 0, dvBefore: 0, active: false },
    };
  }

  /**
   * The ONE public mission-boundary check. GameFlowManager calls it right AFTER `gameState.clearDebris()` on every credited
   * clear (the CATCH_PROCESSED path), so MISSION_START { missionNumber, profile } fires ON the boundary catch
   * (the 5th starts mission 2). Dedupes on `_lastMissionNumber` (reset() → 1). NOT called on restore: MENU_CONTINUE sets
   * `gameState.debrisCleared` directly and emits no start; the first credited clear after a continue re-asserts the
   * mission (HUD.js documents this).
   */
  checkMissionTransition() {
    this._checkMissionTransition();
  }

  _checkMissionTransition() {
    const newMission = this.getMissionNumber();
    if (newMission !== this._lastMissionNumber) {
      this._lastMissionNumber = newMission;
      const profile = this._getMissionProfile(newMission);
      eventBus.emit(Events.MISSION_START, { missionNumber: newMission, profile });
    }
  }

  getMissionNumber() {
    return Math.floor((this._gameState?.debrisCleared || 0) / Constants.MISSIONS.DEBRIS_PER_MISSION) + 1;
  }

  /**
   * Highest-matching minMission wins. Delegates to core/missionProgress.js `missionProfileFor` so readers without a
   * ScoringSystem (GameFlowManager's progress line, the guided-chapter predicate) resolve the SAME entry. Kept as the
   * entry point test-MissionProfiles pins.
   */
  _getMissionProfile(missionNumber) {
    return missionProfileFor(missionNumber);
  }

  _getDebrisTier(debris) {
    // owner 2026-08-21: tier-4 row (rocketBody > 4,000 kg) is deliberately absent: no production spawn emits it (tombstone pin in
    // test-economy-invariants.js).
    if (debris.type === 'rocketBody') return 3;
    if (debris.type === 'defunctSat') return debris.mass > 500 ? 3 : 2;
    if (debris.type === 'missionDebris') return debris.mass > 5 ? 2 : 1;
    return 1; // fragments
  }

  /** @param {object} player PlayerSatellite with getDeltaVSpent() */
  setPlayer(player) {
    this._playerRef = player;
  }

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
    // Most efficient (lowest dvPerCatch) first; the first is marked best.
    stats.sort((a, b) => a.dvPerCatch - b.dvPerCatch);
    if (stats.length > 0) stats[0].isBest = true;
    return stats;
  }

  _setupToolTracking() {
    // Lasso: start on LASSO_FIRED, end on LASSO_CAPTURED or LASSO_MISSED
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

    // Arm/Crossbow: start on CROSSBOW_FIRE, end on ARM_CAPTURED
    eventBus.on(Events.CROSSBOW_FIRE, () => {
      if (this._playerRef) {
        this._toolStats.arm.dvBefore = this._playerRef.getDeltaVSpent?.() || 0;
        this._toolStats.arm.active = true;
      }
    });
    eventBus.on(Events.ARM_CAPTURED, () => {
      this._finishToolTracking('arm', true);
    });

    // Trawl: start on TRAWL_START, end on TRAWL_CAPTURE
    eventBus.on(Events.TRAWL_START, () => {
      if (this._playerRef) {
        this._toolStats.trawl.dvBefore = this._playerRef.getDeltaVSpent?.() || 0;
        this._toolStats.trawl.active = true;
      }
    });
    eventBus.on(Events.TRAWL_CAPTURE, () => {
      this._finishToolTracking('trawl', true);
    });

    // Enrich SWEEP_REPORT with toolStats (mutates the same object)
    eventBus.on(Events.SWEEP_REPORT, (report) => {
      report.toolStats = this.getToolStats();
    });

    eventBus.on(Events.MISSION_START, (d) => {
      if (d.missionNumber >= 3) {
        this._sendEfficiencyComms();
      }
    });
  }

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
        text: `Analysis: ${best.name.toUpperCase()} averaged ${best.dvPerCatch.toFixed(1)} m/s per catch. ${ratio}× more efficient than ${worst.name.toUpperCase()}. Consider using ${best.name} for future operations.`,
        priority: 1,
      });
    }
  }
}

export const scoringSystem = new ScoringSystem();
export default scoringSystem;

// Pure economy helpers (exported for tests; shared by ShopScreen sell/contribute paths)

/**
 * Per-run capture-credits taper factor in [0..1] for a capture award's credit payout (pure): 1.0 while earned <=
 * START_X×catalog, then linear falloff `max(0, 1 - (earned - start)/(ceiling - start))`, so cumulative credits approach
 * CEILING_X×catalog. Non-increasing in `earnedCr`. Score is never tapered.
 * @param {number} catalogCr full catalog value (SHOP.CATALOG_TOTAL_CR)
 */
export function taperMultiplier(earnedCr, catalogCr, taperCfg) {
  const cfg = taperCfg || { START_X: 1.5, CEILING_X: 2.5 };
  const start = cfg.START_X * catalogCr;
  const ceiling = cfg.CEILING_X * catalogCr;
  const earned = Math.max(0, earnedCr || 0);
  if (earned <= start) return 1.0;
  if (ceiling <= start) return 0; // degenerate config guard
  return Math.max(0, 1 - (earned - start) / (ceiling - start));
}

/**
 * Market sale value (SSOT for cargo sales AND elevator contributions): sell-price modifier (spread), then the bulk bonus
 * above the mass threshold. Pure; callers credit and emit comms.
 * @param {number} totalValue listed cargo value (¢)
 */
export function computeSaleValue(totalValue, totalMassKg) {
  if (!(totalValue > 0)) return { saleValue: 0, bulk: false };
  const market = Constants.MARKET || {};
  const sellMod = market.SELL_PRICE_MODIFIER || 0.85;
  const bulkThreshold = market.BULK_THRESHOLD_KG || 50;
  const bulkMult = market.BULK_BONUS_MULTIPLIER || 1.15;
  let saleValue = Math.round(totalValue * sellMod);
  const bulk = !!(totalMassKg && totalMassKg >= bulkThreshold);
  if (bulk) saleValue = Math.round(saleValue * bulkMult);
  return { saleValue, bulk };
}

/**
 * Credits for contributing refined metal to the elevator contract: market SALE VALUE (spread + bulk) PLUS the contract's
 * per-kg bonus ("on top of selling price"), so contributing is at least as good as selling (SSOT).
 * @param {number} listedValue listed ¢ value of the contributed metal
 */
export function computeContributionPayout(listedValue, massKg) {
  const { saleValue } = computeSaleValue(listedValue, massKg);
  const bonusPerKg = (Constants.ELEVATOR_CONTRACT && Constants.ELEVATOR_CONTRACT.BONUS_CREDITS_PER_KG) || 5;
  const bonus = Math.round((massKg > 0 ? massKg : 0) * bonusPerKg);
  return { saleValue, bonus, payout: saleValue + bonus };
}
