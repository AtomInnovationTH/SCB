/**
 * IssConjunctionBoss.js — CH5 "protect-the-asset" boss (MISSION_ARC_IMPLEMENTATION §6).
 *
 * On `SHOP_DEPLOY` into mission `Constants.ISS_BOSS.MISSION`, spawn FRAG_COUNT
 * Cosmos-1408 threat fragments in the ISS forward track and start a TCA_HOURS
 * game-time countdown. The player's choice is emergent from play (no modal):
 *
 *   • INTERCEPT — clear ALL threat frags before TCA → +INTERCEPT_BONUS_KG toward
 *     the elevator contract, +INTERCEPT_BONUS_CREDITS, and the "ISS Saver" codex.
 *   • DECLINE   — clear NONE (or fire `ISS_BOSS_DECLINE`) → the station performs an
 *     autonomous PDAM reboost. No penalty; the "ISS PDAM" codex.
 *   • MISS      — engaged (cleared ≥1) but didn't finish before TCA → a late
 *     hydrazine reboost; bonus lost, "Hydrazine Reboost" codex. The frags the
 *     player DID clear still score normally through the regular capture flow.
 *
 * The three codex entries auto-unlock from the `ISS_BOSS_RESOLVED { outcome }`
 * event (see CodexSystem), so this system only emits the resolution + awards.
 *
 * Node-safe (no THREE / DOM): `debrisField` and `shopScreen` are injected and
 * mocked in tests; game-time is accumulated locally via TIME_SCALE_GAMEPLAY.
 *
 * @module systems/IssConjunctionBoss
 */

import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { ThreatSet, awardElevatorMass } from './_bossLifecycle.js';

export class IssConjunctionBoss {
  /**
   * @param {object} deps
   * @param {object} deps.eventBus
   * @param {object} [deps.scoringSystem]      — getMissionNumber() + SCORING_AWARD target
   * @param {object} [deps.debrisField]        — spawnIssThreatField({count}) => { ids }
   * @param {object} [deps.shopScreen]         — get/setContractMass() for the elevator award
   * @param {object} [deps.persistenceManager] — peek() for restore
   */
  constructor({ eventBus, scoringSystem = null, debrisField = null, shopScreen = null, persistenceManager = null } = {}) {
    this._eventBus = eventBus;
    this._scoring = scoringSystem;
    this._debrisField = debrisField;
    this._shop = shopScreen;
    this._pm = persistenceManager;

    /** @type {boolean} boss already run+resolved this game. */
    this._completed = false;
    /** @type {boolean} boss currently running. */
    this._active = false;
    /** @type {ThreatSet} the spawned threat frags + which are neutralised. */
    this._threats = new ThreatSet();
    /** @type {number} game-seconds until closest approach. */
    this._tcaRemainingS = 0;
    /** @type {boolean} the imminent (final) warning has fired. */
    this._imminentFired = false;

    /** @type {Function[]} listeners only live while the boss runs. */
    this._runUnsubs = [];
    this._unsubs = [];
    this._disposed = false;
  }

  // --------------------------------------------------------------------------
  // PUBLIC API
  // --------------------------------------------------------------------------

  /** Subscribe to triggers. Call once after construction. */
  init() {
    if (this._disposed || !this._eventBus) return;
    const on = (evt, h) => { if (evt) this._unsubs.push(this._eventBus.on(evt, h)); };

    on(Events.SHOP_DEPLOY, (d) => this._onShopDeploy(d));
    on(Events.GAME_RESET, () => this.reset());
    on(Events.PERSISTENCE_GATHER, (save) => { if (save) save.issBoss = this._serialize(); });
    on(Events.PERSISTENCE_LOADED, () => {
      const save = this._pm && typeof this._pm.peek === 'function' ? this._pm.peek() : null;
      if (save && save.issBoss) this._restore(save.issBoss);
    });
  }

  /** Per-frame tick — advances the game-time TCA countdown. */
  update(dt) {
    if (this._disposed || !this._active) return;
    this._tcaRemainingS -= dt * (Constants.TIME_SCALE_GAMEPLAY || 1);

    const imminentS = (Constants.ISS_BOSS.IMMINENT_HOURS || 4) * 3600;
    if (!this._imminentFired && this._tcaRemainingS <= imminentS && this._tcaRemainingS > 0) {
      this._imminentFired = true;
      const remainingH = Math.max(0, this._tcaRemainingS / 3600);
      this._eventBus.emit(Events.ISS_BOSS_IMMINENT, {
        tcaRemainingHours: remainingH,
        cleared: this._threats.clearedCount,
        total: this._threats.total,
      });
      this._comms(`ISS conjunction in ${Math.round(remainingH)} h. ${this._threats.clearedCount}/${this._threats.total} fragments cleared. Close it out, Cowboy.`, 'warning');
    }

    if (this._tcaRemainingS <= 0) {
      // Time's up. Cleared ≥1 but not all = a late hydrazine dodge (miss);
      // cleared none = the player effectively declined (autonomous PDAM).
      this._resolve(this._threats.clearedCount > 0 ? 'miss' : 'decline');
    }
  }

  /** @returns {boolean} */
  isActive() { return this._active; }

  /** @param {number} [mission] @returns {boolean} */
  hasCompleted() { return this._completed; }

  /** Remaining game-time hours until TCA (0 when idle). */
  getTcaRemainingHours() { return this._active ? Math.max(0, this._tcaRemainingS / 3600) : 0; }

  /** @returns {{cleared:number, total:number}} */
  getProgress() { return { cleared: this._threats.clearedCount, total: this._threats.total }; }

  /** Clear all state (GAME_RESET / new game). */
  reset() {
    this._endRun();
    this._completed = false;
  }

  /** Remove listeners. */
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
    const cfg = Constants.ISS_BOSS;
    if (!cfg) return;

    const mission = (data && typeof data.mission === 'number')
      ? data.mission
      : (this._scoring && typeof this._scoring.getMissionNumber === 'function'
        ? this._scoring.getMissionNumber() : 1);
    if (mission !== cfg.MISSION) return;

    this._start();
  }

  /** @private Spawn the threat field + arm the countdown. */
  _start() {
    const cfg = Constants.ISS_BOSS;
    const count = cfg.FRAG_COUNT || 6;

    let ids = [];
    if (this._debrisField && typeof this._debrisField.spawnIssThreatField === 'function') {
      const res = this._debrisField.spawnIssThreatField({ count });
      ids = (res && Array.isArray(res.ids)) ? res.ids : [];
    }
    // No candidates to repurpose → can't stage the boss; bail without marking
    // complete so it can run on a later entry into the mission.
    if (ids.length === 0) return;

    this._threats = new ThreatSet(ids);
    this._tcaRemainingS = (cfg.TCA_HOURS || 38) * 3600;
    this._imminentFired = false;
    this._active = true;

    // Per-run listeners: any capture/removal of a tagged threat counts as a clear.
    const onClear = (payload) => this._onThreatTouched(payload);
    const runOn = (evt, h) => { if (evt) this._runUnsubs.push(this._eventBus.on(evt, h)); };
    runOn(Events.DEBRIS_REMOVED, onClear);
    runOn(Events.CATCH_PROCESSED, onClear);
    runOn(Events.ARM_CAPTURED, onClear);
    runOn(Events.LASSO_CAPTURED, onClear);
    runOn(Events.ISS_BOSS_DECLINE, () => { if (this._active) this._resolve('decline'); });

    this._eventBus.emit(Events.ISS_BOSS_STARTED, {
      threatIds: [...this._threats.threats],
      tcaHours: cfg.TCA_HOURS || 38,
    });
    this._comms(`Cosmos-1408 fragment cloud converging on the ISS. ${this._threats.total} pieces, closest approach in ${cfg.TCA_HOURS || 38} h. Clear them or we let the station reboost. Crew's counting on you.`, 'critical');
  }

  /** @private Mark a threat cleared (idempotent); finish on a full sweep. */
  _onThreatTouched(payload) {
    if (!this._active) return;
    if (this._threats.touch(payload) && this._threats.allCleared) {
      this._resolve('intercept');
    }
  }

  /** @private Resolve the boss, award/announce, and persist completion. */
  _resolve(outcome) {
    if (!this._active) return;
    const cfg = Constants.ISS_BOSS;
    const cleared = this._threats.clearedCount;
    const total = this._threats.total;

    if (outcome === 'intercept') {
      // Credits via scoring; elevator mass via the shop contract.
      this._eventBus.emit(Events.SCORING_AWARD, {
        points: cfg.INTERCEPT_BONUS_CREDITS || 500,
        reason: 'ISS conjunction cleared',
      });
      this._awardElevatorMass(cfg.INTERCEPT_BONUS_KG || 200);
      this._comms('Threat neutralised. ISS is clear, no reboost required. The crew sends their thanks, Cowboy.', 'info');
    } else if (outcome === 'decline') {
      this._comms('Understood. Handing it to the station. ISS performing an autonomous avoidance reboost. No harm done.', 'info');
    } else { // miss
      this._comms('Out of time. ISS executing a late reboost, ~3 kg of hydrazine burned. Threat cleared, but that one cost us.', 'warning');
    }

    this._eventBus.emit(Events.ISS_BOSS_RESOLVED, { outcome, cleared, total });

    this._completed = true;
    this._endRun();
  }

  /** @private Add mass to the elevator contract (fires the win path on threshold). */
  _awardElevatorMass(kg) {
    awardElevatorMass(this._eventBus, this._shop, this._scoring, kg);
  }

  /** @private Critical-tagged comms so the boss always reaches the player. */
  _comms(text, priority = 'info') {
    this._eventBus.emit(Events.COMMS_MESSAGE, {
      source: 'HOUSTON',
      text,
      channel: 'MISSION',
      priority,
      _critical: true,
    });
  }

  /** @private Tear down the active run (keep `_completed`). */
  _endRun() {
    for (const u of this._runUnsubs) { if (typeof u === 'function') u(); }
    this._runUnsubs.length = 0;
    this._active = false;
    this._threats.reset();
    this._tcaRemainingS = 0;
    this._imminentFired = false;
  }

  /** @private */
  _serialize() {
    return { version: 1, completed: this._completed };
  }

  /** @private */
  _restore(data) {
    if (data && typeof data.completed === 'boolean') this._completed = data.completed;
  }
}

export default IssConjunctionBoss;
