/**
 * DossierSystem.js — progressive debris-data reveal + close-range survey
 * (capture-feedback overhaul Phase 1.5).
 *
 * Principle: the reticle is for ACTING, the dossier pane is for KNOWING.
 * This system owns the per-debris knowledge state behind both:
 *
 *   UNSCANNED — radar blip only (debris.discovered === false).
 *   SCANNED   — wide/quick scan revealed the silhouette + type/size/est-mass;
 *               salvage manifest shows redacted rows (you know THAT there's
 *               treasure, not WHAT).
 *   PROFILED  — "the chest opens": a platform (mother or daughter) held within
 *               DETAIL_SCAN_RANGE_M for SURVEY_TIME_S → automatic close-range
 *               survey → Full Profile (exact mass, material, brittleness,
 *               decrypted salvage manifest with credit values). Emits
 *               DEBRIS_PROFILED and pays a one-time-per-debris survey bounty
 *               (reuses the once-per-field scan-economy pattern,
 *               SensorSystem._rewardedFields).
 *
 * Knowledge gates the odds strip: before Full Profile the FRAG chip shows
 * `FRAG ?` and NET % renders with `~` (DockingReticle reads isProfiled()).
 * Survey first = informed shot; shoot blind = gamble — both valid, both legible.
 *
 * Node-safe core: no THREE, no DOM. Positions are read as plain {x,y,z}.
 *
 * @module systems/DossierSystem
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

/** 1 metre in scene units (matches ArmUnit / DockingReticle M). */
const M = 0.00001;

/** Reveal tiers. */
export const DOSSIER_TIERS = {
  UNSCANNED: 'UNSCANNED',
  SCANNED: 'SCANNED',
  PROFILED: 'PROFILED',
};

/**
 * Appraise a debris salvage manifest into line items + total credits.
 * Pure — used by the dossier pane for the decrypted manifest and by tests.
 * @param {object|null} salvage — debris.salvage ({xenon, indium, gaAs, battery,
 *   hydrazine, lithium, metals[]})
 * @returns {{ rows: Array<{label:string, value:number}>, total: number }}
 */
export function appraiseSalvage(salvage) {
  const V = (Constants.DOSSIER && Constants.DOSSIER.SALVAGE_VALUES) || {};
  const rows = [];
  if (!salvage) return { rows, total: 0 };
  const push = (label, value) => {
    value = Math.round(value);
    if (value > 0) rows.push({ label, value });
  };
  if (salvage.xenon > 0) push(`Xenon ${salvage.xenon.toFixed(1)}kg`, salvage.xenon * (V.XENON_PER_KG || 0));
  if (salvage.indium > 0) push(`Indium ${(salvage.indium * 1000).toFixed(0)}g`, salvage.indium * (V.INDIUM_PER_KG || 0));
  if (salvage.gaAs > 0) push(`GaAs panel ${(salvage.gaAs * 100).toFixed(0)}%`, salvage.gaAs * (V.GAAS_PER_FRAC || 0));
  if (salvage.battery > 0) push(`Battery ${salvage.battery.toFixed(0)}Wh`, salvage.battery * (V.BATTERY_PER_WH || 0));
  if (salvage.hydrazine > 0) push(`N\u2082H\u2084 ${salvage.hydrazine.toFixed(1)}kg \u26A0`, salvage.hydrazine * (V.HYDRAZINE_PER_KG || 0));
  if (salvage.lithium > 0) push(`Lithium ${salvage.lithium.toFixed(1)}u`, salvage.lithium * (V.LITHIUM_PER_UNIT || 0));
  if (Array.isArray(salvage.metals)) {
    for (const m of salvage.metals) {
      const name = typeof m === 'string' ? m : (m && (m.metal || m.name)) || 'Metal';
      push(String(name).toLowerCase(), V.METAL_BASE || 0);
    }
  }
  const total = rows.reduce((s, r) => s + r.value, 0);
  return { rows, total };
}

export class DossierSystem {
  constructor() {
    /** @type {Set<*>} debris ids with Full Profile unlocked (session). */
    this._profiled = new Set();
    /** @type {Set<*>} debris ids whose survey bounty was paid (once each). */
    this._bountyPaid = new Set();
    /** @type {{id:*, elapsed:number}|null} survey in progress on the active target. */
    this._survey = null;

    // First-credit legibility (Workstream 1): during onboarding, defer the
    // survey-bounty payout so the player's first salient credit gain is the net
    // catch they were just taught — not an unexplained +75 ~3 s into the sim.
    /** @type {boolean} true between ONBOARDING_STARTED and ONBOARDING_COMPLETE. */
    this._onboardingActive = false;
    /** @type {boolean} true once the first capture released the deferred queue. */
    this._firstCaptureDone = false;
    /** @type {Map<*, number>} debrisId → deferred bounty amount (released later). */
    this._deferredBounties = new Map();

    // Store unsubscribe handles so instances (e.g. in tests) can detach from the
    // shared eventBus and avoid accumulating handlers / cross-instance bleed.
    /** @type {Array<Function>} */
    this._unsubs = [];
    this._unsubs.push(eventBus.on(Events.GAME_RESET, () => this.reset()));

    // Gate deferral on ONBOARDING_STARTED actually firing (veteran-skip emits
    // ONBOARDING_COMPLETE without STARTED → never defers; pays immediately).
    this._unsubs.push(eventBus.on(Events.ONBOARDING_STARTED, () => {
      this._onboardingActive = true;
      this._firstCaptureDone = false;
    }));
    // Flush any still-deferred bounty so a player who finishes onboarding
    // without capturing is never stranded.
    this._unsubs.push(eventBus.on(Events.ONBOARDING_COMPLETE, () => {
      this._onboardingActive = false;
      this._flushDeferredBounties();
    }));
    // First capture while onboarding is active releases the deferred queue so
    // the survey data lands in the same HUD credit flash as the catch reward.
    this._unsubs.push(eventBus.on(Events.DEBRIS_CAPTURED, () => {
      if (this._onboardingActive && !this._firstCaptureDone) {
        this._firstCaptureDone = true;
        this._flushDeferredBounties();
      }
    }));
  }

  /**
   * Detach all eventBus subscriptions. The production singleton lives for the
   * page lifetime and never needs this, but short-lived instances (tests) call
   * it to avoid leaking handlers onto the shared bus.
   */
  destroy() {
    if (this._unsubs) {
      for (const off of this._unsubs) { if (typeof off === 'function') off(); }
      this._unsubs = [];
    }
  }

  /** Clear all knowledge state (new session). */
  reset() {
    this._profiled.clear();
    this._bountyPaid.clear();
    this._survey = null;
    this._onboardingActive = false;
    this._firstCaptureDone = false;
    this._deferredBounties.clear();
  }

  /**
   * Release every deferred survey bounty as a single combined SCORING_AWARD +
   * one `_onboarding`-tagged comms line that bypasses tier-0 suppression.
   * No-op (and silent) when nothing is queued.
   * @private
   */
  _flushDeferredBounties() {
    if (this._deferredBounties.size === 0) return;
    let total = 0;
    for (const amount of this._deferredBounties.values()) total += amount;
    this._deferredBounties.clear();
    if (total <= 0) return;

    eventBus.emit(Events.SCORING_AWARD, {
      points: total,
      reason: 'Close-range survey data',
    });
    // Combined narration — the capture's own SCORING_AWARD lands on the same
    // DEBRIS_CAPTURED event, so the wallet shows one combined jump.
    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'HOUSTON',
      text: `Capture confirmed \u2014 salvage refines into fuel and credits, plus survey data. +$${total} cr.`,
      priority: 'success',
      _onboarding: true,
    });
  }

  /** Whether a debris has its Full Profile unlocked. */
  isProfiled(id) {
    return this._profiled.has(id);
  }

  /**
   * Reveal tier for a debris object.
   * @param {object|null} debris
   * @returns {string} DOSSIER_TIERS value
   */
  getTier(debris) {
    if (!debris) return DOSSIER_TIERS.UNSCANNED;
    if (this._profiled.has(debris.id)) return DOSSIER_TIERS.PROFILED;
    if (debris.discovered === false) return DOSSIER_TIERS.UNSCANNED;
    return DOSSIER_TIERS.SCANNED;
  }

  /**
   * Survey progress for the dossier ring.
   * @param {*} id
   * @returns {number} 0..1 (0 when no survey is running on this debris)
   */
  getSurveyProgress(id) {
    const D = Constants.DOSSIER || {};
    if (!this._survey || this._survey.id !== id) return 0;
    return Math.min(1, this._survey.elapsed / (D.SURVEY_TIME_S || 3));
  }

  /**
   * Per-frame update: drive the automatic close-range survey on the active
   * target. A survey runs while ANY platform (mother or a deployed daughter)
   * holds within DETAIL_SCAN_RANGE_M of the target.
   *
   * NOTE (intentional scope): only the SELECTED target is ever surveyed — a
   * daughter station-keeping a non-selected debris does not open its dossier.
   * The dossier pane shows one target at a time, so surveying off-screen
   * debris would pay bounties for reveals the player never sees. Deliberate
   * narrowing of the plan's "any platform near any target".
   *
   * @param {number} dt — seconds
   * @param {object} ctx
   * @param {{x,y,z}|null} ctx.playerPos — mother position (scene units)
   * @param {object|null} ctx.armManager — for daughter positions
   * @param {object|null} ctx.target — active/selected debris
   */
  update(dt, { playerPos = null, armManager = null, target = null } = {}) {
    const D = Constants.DOSSIER || {};
    if (!target || target.alive === false || target.discovered === false
        || this._profiled.has(target.id)) {
      this._survey = null;
      return;
    }
    const tPos = target._scenePosition;
    if (!tPos) { this._survey = null; return; }

    // Closest platform distance (metres).
    let bestM = Infinity;
    const distM = (p) => {
      const dx = p.x - tPos.x, dy = p.y - tPos.y, dz = p.z - tPos.z;
      return Math.sqrt(dx * dx + dy * dy + dz * dz) / M;
    };
    if (playerPos) bestM = Math.min(bestM, distM(playerPos));
    if (armManager && Array.isArray(armManager.arms)) {
      for (const arm of armManager.arms) {
        if (!arm || arm.state === 'DOCKED' || !arm.position) continue;
        bestM = Math.min(bestM, distM(arm.position));
      }
    }

    if (bestM <= (D.DETAIL_SCAN_RANGE_M || 50)) {
      if (!this._survey || this._survey.id !== target.id) {
        this._survey = { id: target.id, elapsed: 0 };
      }
      this._survey.elapsed += dt;
      if (this._survey.elapsed >= (D.SURVEY_TIME_S || 3)) {
        this._completeProfile(target);
      }
    } else {
      // Out of range — the ring drains; re-enter range to restart.
      this._survey = null;
    }
  }

  /**
   * Unlock the Full Profile: emit DEBRIS_PROFILED, pay the one-time survey
   * bounty (data IS income; capturing the appraised debris is the jackpot).
   * @param {object} target
   * @private
   */
  _completeProfile(target) {
    const D = Constants.DOSSIER || {};
    this._survey = null;
    this._profiled.add(target.id);

    let bountyPaid = false;
    let bountyDeferred = false;
    if (!this._bountyPaid.has(target.id) && (D.SURVEY_BOUNTY || 0) > 0) {
      this._bountyPaid.add(target.id);
      if (this._onboardingActive && !this._firstCaptureDone) {
        // Defer the payout: keep the visual profile reveal ("chest opens"), but
        // release the credits together with the first net-catch reward so the
        // player's first salient credit gain is legibly the catch they learned.
        bountyDeferred = true;
        this._deferredBounties.set(target.id, D.SURVEY_BOUNTY);
      } else {
        bountyPaid = true;
        eventBus.emit(Events.SCORING_AWARD, {
          points: D.SURVEY_BOUNTY,
          reason: 'Close-range survey data',
        });
      }
    }

    eventBus.emit(Events.DEBRIS_PROFILED, {
      debrisId: target.id,
      target,
      bountyPaid,
    });

    const { total } = appraiseSalvage(target.salvage);
    // While deferring, suppress the bounty clause — the combined release line
    // (tagged _onboarding) narrates the credits on first capture instead.
    const bountyClause = bountyPaid ? ` +$${D.SURVEY_BOUNTY} survey data.` : '';
    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'HOUSTON',
      text: total > 0
        ? `Survey complete. Full profile decrypted. Salvage appraisal \u20B9${total}.${bountyClause}`
        : `Survey complete. Full structural profile on file.${bountyClause}`,
      priority: 'success',
      // During onboarding the neutral reveal line must bypass tier-0 suppression
      // too, so the "chest opens" beat is still legible. The bounty itself is
      // held back for the combined capture release above.
      ...(bountyDeferred ? { _onboarding: true } : {}),
    });
  }
}

/** Singleton (matches SensorSystem/KesslerSystem wiring pattern). */
export const dossierSystem = new DossierSystem();

export default DossierSystem;
