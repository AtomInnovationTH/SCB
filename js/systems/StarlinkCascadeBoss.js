/**
 * StarlinkCascadeBoss.js — CH9 "race-the-cascade" boss (MISSION_ARC §6).
 *
 * On `SHOP_DEPLOY` into mission `Constants.STARLINK_BOSS.MISSION`, burst-spawn
 * FRAG_COUNT Starlink fragments and start a WINDOW_MIN game-time timer. The
 * Kessler-cascade tension is delivered as escalating comms — this boss does NOT
 * force a KesslerSystem game-over (failure is never a hard punishment, §9).
 * Outcome is emergent from play:
 *
 *   • CONTAINED — clear ALL frags before the window → +CONTAIN_BONUS_KG toward
 *     the elevator contract, +CONTAIN_BONUS_CREDITS, and the "contained" codex.
 *   • PARTIAL   — clear ≥ PARTIAL_FRACTION by the window → +PARTIAL_CREDITS, no codex.
 *   • CASCADE   — clear < PARTIAL_FRACTION by the window → "cascade" codex, no bonus.
 *
 * The two codex entries auto-unlock from `STARLINK_BOSS_RESOLVED { outcome }`.
 * Node-safe (no THREE / DOM); shares clear-tracking + the elevator award with
 * the ISS boss via `_bossLifecycle`.
 *
 * @module systems/StarlinkCascadeBoss
 */

import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { ThreatSet, awardElevatorMass } from './_bossLifecycle.js';

export class StarlinkCascadeBoss {
  /**
   * @param {object} deps
   * @param {object} deps.eventBus
   * @param {object} [deps.scoringSystem]
   * @param {object} [deps.debrisField]        — spawnStarlinkField({count}) => { ids }
   * @param {object} [deps.shopScreen]
   * @param {object} [deps.persistenceManager]
   */
  constructor({ eventBus, scoringSystem = null, debrisField = null, shopScreen = null, persistenceManager = null } = {}) {
    this._eventBus = eventBus;
    this._scoring = scoringSystem;
    this._debrisField = debrisField;
    this._shop = shopScreen;
    this._pm = persistenceManager;

    this._completed = false;
    this._active = false;
    this._threats = new ThreatSet();
    /** @type {number} game-seconds left in the containment window. */
    this._windowRemainingS = 0;
    this._imminentFired = false;

    this._runUnsubs = [];
    this._unsubs = [];
    this._disposed = false;
  }

  // --------------------------------------------------------------------------
  // PUBLIC API
  // --------------------------------------------------------------------------

  init() {
    if (this._disposed || !this._eventBus) return;
    const on = (evt, h) => { if (evt) this._unsubs.push(this._eventBus.on(evt, h)); };
    on(Events.SHOP_DEPLOY, (d) => this._onShopDeploy(d));
    on(Events.GAME_RESET, () => this.reset());
    on(Events.PERSISTENCE_GATHER, (save) => { if (save) save.starlinkBoss = this._serialize(); });
    on(Events.PERSISTENCE_LOADED, () => {
      const save = this._pm && typeof this._pm.peek === 'function' ? this._pm.peek() : null;
      if (save && save.starlinkBoss) this._restore(save.starlinkBoss);
    });
  }

  update(dt) {
    if (this._disposed || !this._active) return;
    this._windowRemainingS -= dt * (Constants.TIME_SCALE_GAMEPLAY || 1);

    const imminentS = (Constants.STARLINK_BOSS.IMMINENT_MIN || 1) * 60;
    if (!this._imminentFired && this._windowRemainingS <= imminentS && this._windowRemainingS > 0) {
      this._imminentFired = true;
      const remainingMin = Math.max(0, this._windowRemainingS / 60);
      this._eventBus.emit(Events.STARLINK_BOSS_IMMINENT, {
        remainingMin,
        cleared: this._threats.clearedCount,
        total: this._threats.total,
      });
      this._comms(`Cascade window closing — ${this._threats.clearedCount}/${this._threats.total} fragments swept. Move, Cowboy, this debris is breeding.`, 'warning');
    }

    if (this._windowRemainingS <= 0) {
      const cfg = Constants.STARLINK_BOSS;
      this._resolve(this._threats.fractionCleared >= (cfg.PARTIAL_FRACTION || 0.6) ? 'partial' : 'cascade');
    }
  }

  isActive() { return this._active; }
  hasCompleted() { return this._completed; }
  getWindowRemainingMin() { return this._active ? Math.max(0, this._windowRemainingS / 60) : 0; }
  getProgress() { return { cleared: this._threats.clearedCount, total: this._threats.total }; }

  reset() {
    this._endRun();
    this._completed = false;
  }

  dispose() {
    this._disposed = true;
    this._endRun();
    for (const u of this._unsubs) { if (typeof u === 'function') u(); }
    this._unsubs.length = 0;
  }

  // --------------------------------------------------------------------------
  // INTERNAL
  // --------------------------------------------------------------------------

  /** @private */
  _onShopDeploy(data) {
    if (this._active || this._completed) return;
    const cfg = Constants.STARLINK_BOSS;
    if (!cfg) return;
    const mission = (data && typeof data.mission === 'number')
      ? data.mission
      : (this._scoring && typeof this._scoring.getMissionNumber === 'function'
        ? this._scoring.getMissionNumber() : 1);
    if (mission !== cfg.MISSION) return;
    this._start();
  }

  /** @private */
  _start() {
    const cfg = Constants.STARLINK_BOSS;
    const count = cfg.FRAG_COUNT || 35;

    let ids = [];
    if (this._debrisField && typeof this._debrisField.spawnStarlinkField === 'function') {
      const res = this._debrisField.spawnStarlinkField({ count });
      ids = (res && Array.isArray(res.ids)) ? res.ids : [];
    }
    if (ids.length === 0) return; // nothing to repurpose → don't stage; can retry

    this._threats = new ThreatSet(ids);
    this._windowRemainingS = (cfg.WINDOW_MIN || 5) * 60;
    this._imminentFired = false;
    this._active = true;

    const onClear = (payload) => this._onThreatTouched(payload);
    const runOn = (evt, h) => { if (evt) this._runUnsubs.push(this._eventBus.on(evt, h)); };
    runOn(Events.DEBRIS_REMOVED, onClear);
    runOn(Events.CATCH_PROCESSED, onClear);
    runOn(Events.ARM_CAPTURED, onClear);
    runOn(Events.LASSO_CAPTURED, onClear);

    this._eventBus.emit(Events.STARLINK_BOSS_STARTED, {
      threatIds: [...this._threats.threats],
      windowMin: cfg.WINDOW_MIN || 5,
    });
    this._comms(`Starlink bird just fragmented — ${this._threats.total} pieces tumbling through the shell, and they'll seed a Kessler cascade if they spread. Sweep them inside ${cfg.WINDOW_MIN || 5} minutes.`, 'critical');
  }

  /** @private */
  _onThreatTouched(payload) {
    if (!this._active) return;
    if (this._threats.touch(payload) && this._threats.allCleared) {
      this._resolve('contained');
    }
  }

  /** @private */
  _resolve(outcome) {
    if (!this._active) return;
    const cfg = Constants.STARLINK_BOSS;
    const cleared = this._threats.clearedCount;
    const total = this._threats.total;

    if (outcome === 'contained') {
      this._eventBus.emit(Events.SCORING_AWARD, {
        points: cfg.CONTAIN_BONUS_CREDITS || 750,
        reason: 'Starlink cascade contained',
      });
      awardElevatorMass(this._eventBus, this._shop, this._scoring, cfg.CONTAIN_BONUS_KG || 300);
      this._comms('Cloud contained — cascade averted. That shell stays usable because of you, Cowboy.', 'info');
    } else if (outcome === 'partial') {
      this._eventBus.emit(Events.SCORING_AWARD, {
        points: cfg.PARTIAL_CREDITS || 250,
        reason: 'Starlink cloud thinned',
      });
      this._comms('Window\'s closed. You thinned the cloud but some pieces got away — tracking flags elevated conjunction risk in the shell.', 'warning');
    } else { // cascade
      this._comms('Too many got past us — the fragments are colliding and breeding. The shell is degrading. Log it; we learn and we keep flying.', 'warning');
    }

    this._eventBus.emit(Events.STARLINK_BOSS_RESOLVED, { outcome, cleared, total });
    this._completed = true;
    this._endRun();
  }

  /** @private */
  _comms(text, priority = 'info') {
    this._eventBus.emit(Events.COMMS_MESSAGE, {
      source: 'HOUSTON',
      text,
      channel: 'MISSION',
      priority,
      _critical: true,
    });
  }

  /** @private */
  _endRun() {
    for (const u of this._runUnsubs) { if (typeof u === 'function') u(); }
    this._runUnsubs.length = 0;
    this._active = false;
    this._threats.reset();
    this._windowRemainingS = 0;
    this._imminentFired = false;
  }

  /** @private */
  _serialize() { return { version: 1, completed: this._completed }; }

  /** @private */
  _restore(data) {
    if (data && typeof data.completed === 'boolean') this._completed = data.completed;
  }
}

export default StarlinkCascadeBoss;
