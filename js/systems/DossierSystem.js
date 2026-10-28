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
import { salvageGasKg } from './ResourceSystem.js';
import { pieceValues } from './BigPieceValues.js';
import { TimeAuthority } from './TimeAuthority.js';

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
  if (salvage.xenon > 0) push(`Engine gas ${salvageGasKg(salvage.xenon).toFixed(1)} kg`, salvage.xenon * (V.XENON_PER_KG || 0));
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

/**
 * The TARGET INFO panel's step lines for a piece she does not catch (INSPECT, DECISIONS §49 row 3), in plain words, with each step's
 * credits on its own line (B3 2026-10-28) and short enough for the 280 px panel with its padding kept (at most 38 characters at 10 px mono, about 6.6 px each: 250 px of 280). Pure.
 *   1: `Too big to catch · found 386 cr done`
 *   2: `orbit 771 cr · within 200 m`  (`orbit 771 cr · 35 %`, `orbit 771 cr done`)
 *   3: `fly-around 1543 cr · within 10 m`  (`· 40 %`, `done`)
 *   4: `spin 1157 cr · within 50 m`  (`· 45 %`; a measured spin reads `Spins 1.0° a second · 1157 cr done`)
 * @param {ReturnType<DossierSystem['getInspectState']>} st
 * @returns {[string, string, string, string]|null} null when the piece is not one
 */
export function inspectStepLines(st) {
  if (!st) return null;
  const I = Constants.INSPECT;
  const pay = st.pay || {};
  const pct = (p) => `${Math.max(1, Math.min(99, Math.round(p * 100)))} %`;
  const MID = ' \u00B7 ';
  const tail = (step, range) => (step.done ? ' done' : step.pct > 0 ? `${MID}${pct(step.pct)}` : `${MID}within ${range} m`);
  const spin = st.spin.done
    ? `Spins ${st.spin.degS.toFixed(st.spin.degS < 10 ? 1 : 0)}\u00B0 a second${MID}${pay.spin} cr done`
    : `spin ${pay.spin} cr${tail(st.spin, I.SPIN_RANGE_M)}`;
  return [
    `Too big to catch${MID}found ${pay.find} cr${st.find.done ? ' done' : ''}`,
    `orbit ${pay.orbit} cr${tail(st.orbit, I.ORBIT_RANGE_M)}`,
    `fly-around ${pay.inspect} cr${tail(st.inspect, I.CLOSE_RANGE_M)}`,
    spin,
  ];
}

export class DossierSystem {
  constructor() {
    /** @type {Set<*>} debris ids with Full Profile unlocked (session). */
    this._profiled = new Set();
    /** @type {Set<*>} debris ids whose survey bounty was paid (once each). */
    this._bountyPaid = new Set();
    /** @type {{id:*, elapsed:number}|null} survey in progress on the active target. */
    this._survey = null;
    /** @type {Map<string, Set<string>>} `${fieldId}|${fieldRow}` -> the characterising steps already paid (INSPECT; persisted). */
    this._inspectPaid = new Map();
    /** @type {Map<string, object>} the same key -> progress of the steps in flight (session only: a reload starts them over). */
    this._inspectProg = new Map();

    // First-credit legibility (Workstream 1): during onboarding, defer the
    // survey-bounty payout so the player's first salient credit gain is the net
    // catch they were just taught — not an unexplained +75 ~3 s into the sim.
    /** @type {boolean} true between ONBOARDING_STARTED and ONBOARDING_COMPLETE. */
    this._onboardingActive = false;
    /** @type {boolean} true once the first capture released the deferred queue. */
    this._firstCaptureDone = false;
    /** @type {Map<*, number>} debrisId → deferred bounty amount (released later). */
    this._deferredBounties = new Map();
    /** @type {Map<string, {key:string, step:string}>} INSPECT steps earned during onboarding: their credits sit in `_deferredBounties` under the same
     *  `${key}|${step}` and the step counts as paid (saved) only when they are released, so a reload in between loses nothing (big-rules R6). */
    this._deferredInspect = new Map();

    // Store unsubscribe handles so instances (e.g. in tests) can detach from the
    // shared eventBus and avoid accumulating handlers / cross-instance bleed.
    /** @type {Array<Function>} */
    this._unsubs = [];
    this._unsubs.push(eventBus.on(Events.GAME_RESET, () => this.reset()));
    // INSPECT: the paid steps ride the save (PersistenceManager's whitelist key `inspectPaid`); GameFlowManager restores them on Continue.
    this._unsubs.push(eventBus.on(Events.PERSISTENCE_GATHER, (saveData) => {
      const list = this.serializeInspect();
      if (saveData && list.length) saveData.inspectPaid = list;
    }));

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
      this._flushDeferredBounties();   // no catch is released here: no withCatch (u3-payoff-calm)
    }));
    // First capture while onboarding is active releases the deferred queue so
    // the survey data lands in the same HUD credit flash as the catch reward.
    // tutorial-end-switch D3a: the mother's net / lasso catch counts too (only the daughter arm's dock
    // emitted DEBRIS_CAPTURED, so a mother-only first run never paid it). Paid when the net closes: the
    // survey data was earned by the scan itself. `_firstCaptureDone` keeps it to once per catch run.
    const onFirstCatch = () => {
      if (this._onboardingActive && !this._firstCaptureDone) {
        this._firstCaptureDone = true;
        this._flushDeferredBounties({ withCatch: true });   // u3-payoff-calm: released WITH the first catch
      }
    };
    this._unsubs.push(eventBus.on(Events.DEBRIS_CAPTURED, onFirstCatch));
    if (Events.NET_CATCH_SUCCESS) this._unsubs.push(eventBus.on(Events.NET_CATCH_SUCCESS, onFirstCatch));
    if (Events.LASSO_CAPTURED) this._unsubs.push(eventBus.on(Events.LASSO_CAPTURED, onFirstCatch));
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
    this._inspectPaid.clear();
    this._inspectProg.clear();
    this._survey = null;
    this._onboardingActive = false;
    this._firstCaptureDone = false;
    this._deferredBounties.clear();
    this._deferredInspect.clear();
  }

  /**
   * Release every deferred survey bounty as a single combined SCORING_AWARD +
   * one `_onboarding`-tagged comms line that bypasses tier-0 suppression.
   * No-op (and silent) when nothing is queued.
   * @param {{withCatch?: boolean}} [opts]  withCatch: the first capture releases it (the payoff line adds it to the catch);
   *   the ONBOARDING_COMPLETE flush releases no catch and leaves it off.
   * @private
   */
  _flushDeferredBounties({ withCatch = false } = {}) {
    if (this._deferredBounties.size === 0) return;
    let total = 0;
    for (const amount of this._deferredBounties.values()) total += amount;
    this._deferredBounties.clear();
    // the deferred characterising steps are paid now: they join the saved ones (R6)
    for (const { key, step } of this._deferredInspect.values()) {
      let set = this._inspectPaid.get(key);
      if (!set) { set = new Set(); this._inspectPaid.set(key, set); }
      set.add(step);
    }
    this._deferredInspect.clear();
    if (total <= 0) return;

    eventBus.emit(Events.SCORING_AWARD, {
      points: total,
      reason: 'Close-range survey data',
      ...(withCatch ? { withCatch: true } : {}),
    });
    // Combined narration — the capture's own SCORING_AWARD lands on the same
    // DEBRIS_CAPTURED event, so the wallet shows one combined jump.
    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'HOUSTON',
      // tutorial-end-switch D3b: a flush released by a catch adds to that catch's line; a flush with no
      // catch (the tutorial's end) must not claim one.
      text: withCatch
        ? `Survey data: ${total} credits earned.`
        : `Survey data sent to ground station. ${total} credits earned.`,
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
   * @param {boolean} [ctx.worldHeld] — the world clock is stopped (a workbench drawer is open): the INSPECT clocks wait
   * @param {number} [ctx.gameDt] — the game-time step for the INSPECT clocks (default: the time authority's base step, `TimeAuthority.baseGameDt(dt)`, the step
   *   the piece's tumble animation turns by; the survey keeps real seconds)
   */
  update(dt, { playerPos = null, armManager = null, target = null, worldHeld = false, gameDt = undefined } = {}) {
    const D = Constants.DOSSIER || {};
    if (!target || target.alive === false || target.discovered === false) {
      this._survey = null;
      return;
    }
    const tPos = target._scenePosition;
    if (!tPos) { this._survey = null; return; }

    // Closest platform (the mother or a deployed daughter): distance in metres, its position and which platform it is.
    let bestM = Infinity;
    let bestPos = null;
    let bestWho = null;
    const consider = (p, who) => {
      const dx = p.x - tPos.x, dy = p.y - tPos.y, dz = p.z - tPos.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) / M;
      if (d < bestM) { bestM = d; bestPos = p; bestWho = who; }
    };
    if (playerPos) consider(playerPos, 'mother');
    if (armManager && Array.isArray(armManager.arms)) {
      armManager.arms.forEach((arm, i) => {
        if (!arm || arm.state === 'DOCKED' || !arm.position) return;
        consider(arm.position, `arm${arm.id ?? i}`);
      });
    }

    // The characterising steps run BEFORE the profiled early return: a piece over her catch limit is profiled after 3 s, and
    // its close inspection and spin measurement go on afterwards.
    // One clock (R3): the timers run on the game-time step the tumble animation uses, and wait while the world is held still.
    const gdt = worldHeld ? 0 : (Number.isFinite(gameDt) ? gameDt : TimeAuthority.baseGameDt(dt));
    this._updateInspect(gdt, target, tPos, bestM, bestPos);

    if (this._profiled.has(target.id)) {
      this._survey = null;
      return;
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

  // ==========================================================================
  // CHARACTERISING A PIECE SHE DOES NOT CATCH (INSPECT, DECISIONS §49 row 3)
  // ==========================================================================

  /** The key a piece's paid steps are saved under: piece ids do not survive a reload, a field and its row do. */
  static inspectKey(target) {
    return `${target.fieldId ?? '-'}|${target.fieldRow ?? target.id}`;
  }

  /**
   * What this piece pays for being characterised: the total in credits, or 0 when it is not such a piece (she can catch it, it has no
   * owner to pay, or its owner has abandoned it). Whole credits: the fourth step takes the rounding rest.
   * @param {object|null} target
   * @returns {{total:number, pay:{find:number, orbit:number, inspect:number, spin:number}}|null} null = not an inspect piece
   */
  inspectPay(target) {
    const I = Constants.INSPECT;
    const limit = Constants.CAPTURE_NET && Constants.CAPTURE_NET.LARGE && Constants.CAPTURE_NET.LARGE.CATCH_LIMIT_KG;
    if (!I || !target || !(limit > 0) || !((target.mass || 0) > limit)) return null;
    const fee = pieceValues(target).removalFeeCr;
    if (!(fee > 0)) return null;
    const total = Math.round(fee * I.FEE_SHARE);
    if (!(total > 0)) return null;
    const find = Math.round(total * I.SPLIT.find);
    const orbit = Math.round(total * I.SPLIT.orbit);
    const inspect = Math.round(total * I.SPLIT.inspect);
    return { total, pay: { find, orbit, inspect, spin: total - find - orbit - inspect } };
  }

  /**
   * The panel's view of a piece's characterising steps, or null when it is not such a piece.
   * `pct` is 0-1 progress of a step in flight; a paid step is done.
   * @param {object|null} target
   * @returns {{total:number, pay:{find:number, orbit:number, inspect:number, spin:number}, find:{done:boolean}, orbit:{done:boolean, pct:number}, inspect:{done:boolean, pct:number},
   *   spin:{done:boolean, pct:number, degS:number}}|null}
   */
  getInspectState(target) {
    const ip = this.inspectPay(target);
    if (!ip) return null;
    const I = Constants.INSPECT;
    const key = DossierSystem.inspectKey(target);
    const paidSet = this._inspectPaid.get(key) || new Set();
    const paid = { has: (st) => paidSet.has(st) || this._deferredInspect.has(`${key}|${st}`) };   // earned but held back for the first catch counts as done on the panel
    const pr = this._inspectProg.get(key) || {};
    const clamp01 = (x) => Math.max(0, Math.min(1, x));
    const turnS = DossierSystem._spinTurnS(target);
    return {
      total: ip.total,
      pay: ip.pay,
      find: { done: paid.has('find') },
      orbit: { done: paid.has('orbit'), pct: paid.has('orbit') ? 1 : clamp01((pr.orbitS || 0) / I.ORBIT_TIME_S) },
      inspect: { done: paid.has('inspect'), pct: paid.has('inspect') ? 1 : clamp01((pr.spreadDeg || 0) / I.COVER_DEG) },
      spin: { done: paid.has('spin'), pct: paid.has('spin') ? 1 : clamp01((pr.spinS || 0) / turnS), degS: DossierSystem.drawnSpinRadS(target) * (180 / Math.PI) },
    };
  }

  /**
   * The spin AS DRAWN, in radians per game second at the shipped base rate (B2 2026-10-28). The 3D draw turns a piece by
   * `min(|tumbleRate| x BASE_SCALE, DEBRIS_MAX_VISUAL_TUMBLE_DEG_S)` per real second (DebrisField._advanceTumble: a cap chosen for smooth
   * motion, "jagged object rotating fast"), so the Meteor 2's 1.5 deg/s true spin is drawn at 1.0 deg per game second. The step's turn
   * and the plain-words rate both use this, so the label, the drawn turn and the step are one clock.
   */
  static drawnSpinRadS(target) {
    const base = TimeAuthority.BASE_SCALE;
    const cap = ((Constants.DEBRIS_MAX_VISUAL_TUMBLE_DEG_S ?? Infinity) * Math.PI) / 180;
    return Math.min(Math.abs(target.tumbleRate || 0) * base, cap) / base;
  }

  /** @private One full turn of the piece as drawn, in game seconds (SPIN_MIN_S for a piece that does not spin). */
  static _spinTurnS(target) {
    const w = DossierSystem.drawnSpinRadS(target);
    return w > 1e-9 ? (2 * Math.PI) / w : Constants.INSPECT.SPIN_MIN_S;
  }

  /** @returns {Array<{k:string, s:string[]}>} the paid steps, for the save (empty = nothing to write). */
  serializeInspect() {
    const out = [];
    for (const [k, set] of this._inspectPaid) if (set.size) out.push({ k, s: [...set] });
    return out;
  }

  /**
   * Put the paid steps back after a load (nothing pays). Anything malformed is ignored.
   * @param {Array<{k:string, s:string[]}>|null|undefined} list
   */
  restoreInspect(list) {
    this._inspectPaid.clear();
    if (!Array.isArray(list)) return;
    const STEPS = ['find', 'orbit', 'inspect', 'spin'];
    for (const e of list) {
      if (!e || typeof e.k !== 'string' || !Array.isArray(e.s)) continue;
      const set = new Set(e.s.filter((x) => STEPS.includes(x)));
      if (set.size) this._inspectPaid.set(e.k, set);
    }
  }

  /**
   * The four steps of a piece over her catch limit, for the selected target (`bestM` the closest platform's distance in m, `bestPos` its
   * position; `dt` game seconds). Each pays once per piece.
   * @private
   */
  _updateInspect(dt, target, tPos, bestM, bestPos) {
    const ip = this.inspectPay(target);
    if (!ip) return;
    const I = Constants.INSPECT;
    const key = DossierSystem.inspectKey(target);
    let paidSet = this._inspectPaid.get(key);
    if (!paidSet) { paidSet = new Set(); this._inspectPaid.set(key, paidSet); }
    const paid = { has: (st) => paidSet.has(st) || this._deferredInspect.has(`${key}|${st}`) };
    let pr = this._inspectProg.get(key);
    if (!pr) { pr = { orbitS: 0, spreadDeg: 0, dirs: [], spinS: 0 }; this._inspectProg.set(key, pr); }
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;

    // 1. Find: discovered and selected as her target.
    if (!paid.has('find')) this._payInspect(target, key, 'find', ip.pay.find);

    // 2. Pinpoint its orbit: within ORBIT_RANGE_M for ORBIT_TIME_S (accumulated).
    if (!paid.has('orbit') && bestM <= I.ORBIT_RANGE_M) {
      pr.orbitS += step;
      if (pr.orbitS >= I.ORBIT_TIME_S) this._payInspect(target, key, 'orbit', ip.pay.orbit);
    }

    // 3. Inspect up close: coverage. While within CLOSE_RANGE_M, keep the directions piece -> inspector (a new one only after it moved
    //    SAMPLE_DEG from every one kept); done when two are COVER_DEG apart: she has seen it from opposite sides. Leaving the range
    //    keeps them (the same inspection), and the mother and a daughter add to the same set. Straight fly-bys and a wobble never reach it.
    if (!paid.has('inspect') && bestM <= I.CLOSE_RANGE_M && bestPos) {
      const dx = bestPos.x - tPos.x, dy = bestPos.y - tPos.y, dz = bestPos.z - tPos.z;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len > 1e-12) {
        const dir = { x: dx / len, y: dy / len, z: dz / len };
        const angleTo = (o) => Math.acos(Math.max(-1, Math.min(1, dir.x * o.x + dir.y * o.y + dir.z * o.z))) * (180 / Math.PI);
        let widest = 0, fresh = true;
        for (const o of pr.dirs) {
          const a = angleTo(o);
          if (a < I.SAMPLE_DEG) { fresh = false; break; }
          if (a > widest) widest = a;
        }
        if (fresh) {
          pr.dirs.push(dir);
          if (widest > pr.spreadDeg) pr.spreadDeg = widest;
          if (pr.spreadDeg >= I.COVER_DEG) this._payInspect(target, key, 'inspect', ip.pay.inspect);
        }
      }
    }

    // 4. Measure its spin: within SPIN_RANGE_M for one full turn of the piece as drawn (one clock with the label).
    if (!paid.has('spin') && bestM <= I.SPIN_RANGE_M) {
      pr.spinS += step;
      if (pr.spinS >= DossierSystem._spinTurnS(target)) this._payInspect(target, key, 'spin', ip.pay.spin);
    }

    // Round 5 (C1/C2): tell the daughter on this piece which of the two steps she can earn at her hold are still open. She goes home when
    // both are done, not when her arc ends (ArmUnit._driveInspectSweep). `age` counts the arm's seconds since this stamp; a stamp that is not
    // renewed (the piece was deselected) goes stale and she falls back to her arc.
    target._inspectNeeds = { inspect: !paid.has('inspect'), spin: !paid.has('spin'), age: 0 };
  }

  /** @private Pay one step once: a SCORING_AWARD and one plain Houston line (held back during onboarding, like the survey bounty). */
  _payInspect(target, key, stepName, credits) {
    const paid = this._inspectPaid.get(key);
    const dkey = `${key}|${stepName}`;
    if (!paid || paid.has(stepName) || this._deferredInspect.has(dkey)) return;
    if (!(credits > 0)) { paid.add(stepName); return; }
    const words = {
      find: 'Target found',
      orbit: 'Orbit pinpointed',
      inspect: 'Close inspection done',
      spin: 'Spin measured',
    }[stepName];
    if (this._onboardingActive && !this._firstCaptureDone) {
      // held back for the first catch: NOT paid yet, so not saved as paid either (R6)
      this._deferredBounties.set(dkey, credits);
      this._deferredInspect.set(dkey, { key, step: stepName });
      return;
    }
    paid.add(stepName);
    eventBus.emit(Events.SCORING_AWARD, { points: credits, reason: words });
    const rate = stepName === 'spin'
      ? ` ${(DossierSystem.drawnSpinRadS(target) * (180 / Math.PI)).toFixed(1)}\u00B0 a second,` : '';
    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'HOUSTON',
      text: `${words}:${rate} ${credits} credits.`,
      priority: 'success',
    });
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
    // a piece over her catch limit pays its four characterising steps instead of the flat bounty (no double pay)
    const characterised = this.inspectPay(target) !== null;
    if (!characterised && !this._bountyPaid.has(target.id) && (D.SURVEY_BOUNTY || 0) > 0) {
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

    // The full salvage appraisal lives in the dossier pane; the comms line
    // just announces the data is in and names the credits earned for it.
    // nets-1b (DECISIONS §33, one line per fact): while the bounty is held back for the catch's release, this
    // line is NOT said: the release says "Survey data: N credits earned." when the catch lands (or, at the
    // tutorial's end, "Survey data sent to ground station. N credits earned."). Said now otherwise, one line.
    if (!bountyDeferred) {
      const bountyClause = bountyPaid ? ` ${D.SURVEY_BOUNTY} credits earned.` : '';
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'HOUSTON',
        text: `Survey data sent to ground station.${bountyClause}`,
        priority: 'success',
      });
    }
  }
}

/** Singleton (matches SensorSystem/KesslerSystem wiring pattern). */
export const dossierSystem = new DossierSystem();

export default DossierSystem;
