/**
 * @module systems/IssConjunctionBoss — CH5 "protect-the-asset" boss.
 *
 * At the MISSION BOUNDARY into mission `Constants.ISS_BOSS.MISSION` (the 20th credited catch → `MISSION_START
 * { missionNumber: 5 }`; not `SHOP_DEPLOY`, which the chapter-4+ depot INVITATION made optional) or later, once she is at the
 * station field lined up with the station (DECISIONS §62 row 2: her node gap within `LINED_UP_DEG`, asked at a mission start and
 * on `FIELD_ARRIVED`; `stationLinedUp` dep), ARM; on the first
 * gameplay frame with no depot stop pending (`_bossLifecycle.MissionOnset` — never under the depot overlay; at once
 * behind an invitation, after DEPLOY when a forced stop intervened), spawn FRAG_COUNT Cosmos-1408 threat fragments in
 * the ISS forward track and start a TCA_HOURS game-time countdown. The player's choice is emergent from play (no modal):
 *
 *   • INTERCEPT — clear ALL threat frags before TCA → +INTERCEPT_BONUS_KG toward the elevator contract,
 *     +INTERCEPT_BONUS_CREDITS, and the "ISS Saver" codex.
 *   • DECLINE   — clear NONE (or fire `ISS_BOSS_DECLINE`) → the station performs an autonomous PDAM reboost. No
 *     penalty; the "ISS PDAM" codex.
 *   • MISS      — engaged (cleared ≥1) but didn't finish before TCA → a late hydrazine reboost; bonus lost,
 *     "Hydrazine Reboost" codex. Frags the player DID clear still score normally through the regular capture flow.
 *
 * The three codex entries auto-unlock from `ISS_BOSS_RESOLVED { outcome }` (see CodexSystem); this system only emits
 * the resolution + awards. Node-safe (no THREE / DOM): `debrisField` and `shopScreen` are injected (mocked in tests);
 * game-time is accumulated locally via TIME_SCALE_GAMEPLAY.
 */

import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { GameStates } from '../core/GameState.js';
import { TimeAuthority } from './TimeAuthority.js';
import { ThreatSet, awardElevatorMass, MissionOnset } from './_bossLifecycle.js';

/**
 * The boss's five comms lines. New York (no `obj`): the ISS lines, byte for byte as they were. A start city (`obj` = its
 * `Constants.CITY_STATIONS` entry, route-1107-d2 D-A7): the same beats around its real object, with no crew and no reboost.
 * `canDodge`: true = its operators can fire thrusters, false = it has none, null = not known.
 * @param {object|null} obj @returns {{start: function, imminent: function, intercept: function, decline: function, miss: function}}
 */
export function bossLines(obj) {
  if (!obj) {
    return {
      start: (total, tcaH) => `Cosmos-1408 fragment cloud converging on the ISS. ${total} pieces, closest approach in ${tcaH} h. Clear them or we let the station reboost. Crew's counting on you.`,
      imminent: (h, cleared, total) => `ISS conjunction in ${h} h. ${cleared}/${total} fragments cleared. Close it out, Cowboy.`,
      intercept: () => 'Threat neutralised. ISS is clear, no reboost required. The crew sends their thanks, Cowboy.',
      decline: () => 'Understood. Handing it to the station. ISS performing an autonomous avoidance reboost. No harm done.',
      miss: () => 'Out of time. ISS executing a late reboost, ~3 kg of hydrazine burned. Threat cleared, but that one cost us.',
    };
  }
  const n = obj.short;
  const dodge = obj.canDodge;
  return {
    start: (total, tcaH) => `Fragment cloud converging on ${n} (${Math.round(obj.altKm)} km). ${total} pieces, closest approach in ${tcaH} h. `
      + (dodge === true ? 'Clear them or its operators burn fuel to dodge.' : dodge === false ? `${n} has no thrusters and cannot dodge.` : 'Clear them before the pass.'),
    imminent: (h, cleared, total) => `${n} conjunction in ${h} h. ${cleared}/${total} fragments cleared. Close it out, Cowboy.`,
    intercept: () => `Threat neutralised. ${n} is clear. Thanks from its operators, Cowboy.`,
    decline: () => (dodge === true ? `Understood. ${n}'s operators fire its thrusters to dodge. No harm done.`
      : dodge === false ? `Understood. ${n} cannot dodge and rides out the pass. The fragments missed this time.`
        : `Understood. ${n} rides out the pass. The fragments missed this time.`),
    miss: () => (dodge === true ? `Out of time. ${n} burned fuel on a late dodge. Threat cleared, but that one cost them.`
      : `Out of time. ${n} rode out the pass with fragments still near it. They missed, but the bonus is lost.`),
  };
}

export class IssConjunctionBoss {
  /**
   * @param {object} deps
   * @param {object} deps.eventBus
   * @param {object} [deps.scoringSystem]      — getMissionNumber() + SCORING_AWARD target
   * @param {object} [deps.debrisField]        — spawnIssThreatField({count}) => { ids }
   * @param {object} [deps.shopScreen]         — get/setContractMass() for the elevator award
   * @param {object} [deps.persistenceManager] — peek() for restore
   * @param {Function} [deps.depotStopPending] — () => boolean (GameFlowManager.isDepotStopPending(), wired by main.js);
   *   the armed onset holds while it returns true. Default: never.
   * @param {Function} [deps.stationLinedUp] — () => boolean (GameFlowManager.stationLinedUp(), wired by main.js): she is at the
   *   station field with her node gap to the station within `ISS_BOSS.LINED_UP_DEG`. The boss arms only while it returns true.
   *   Default (not given: headless rigs, the old tests): always lined up, i.e. it arms at the boss mission's start as before.
   * @param {Function} [deps.otherBossBusy] — () => boolean (main.js: the Starlink boss is armed or running). The boss does not arm
   *   while it returns true (it can arm after that boss resolves, if she is lined up then) and an armed onset holds. Default: never.
   * @param {Function} [deps.finishStationBurn] — () => boolean (GameFlowManager.finishStationBurn(), wired by main.js; route-1106 lane S4):
   *   bills the finish burn that closes the last gap to the station's plane. The boss does not arm while it returns false (too little
   *   gas). Default (headless rigs, the old tests): nothing to bill, true.
   * @param {Function} [deps.stationPlane] — () => ({inclination, raan}|null) (GameFlowManager.stationPlane(), wired by main.js): the
   *    station's own plane in her scene, for the start whose tilt is the station's; the pieces are built in it. Default: null (her plane).
   *    A city's start (`stationObject`) builds them in HER scene plane instead: the finish burn put her in the object's plane.
   * @param {Function} [deps.stationObject] — () => (Constants.CITY_STATIONS entry|null) (main.js: `NodeDrift.cityStation(her tilt)`; route-1107-d2):
   *    the real object a start city protects (name, height, canDodge). Null = New York, the ISS. Default: null.
   */
  constructor({ eventBus, scoringSystem = null, debrisField = null, shopScreen = null, persistenceManager = null, depotStopPending = null, stationLinedUp = null, otherBossBusy = null, finishStationBurn = null, stationPlane = null, stationObject = null } = {}) {
    this._eventBus = eventBus;
    this._scoring = scoringSystem;
    this._debrisField = debrisField;
    this._shop = shopScreen;
    this._pm = persistenceManager;
    this._depotStopPending = typeof depotStopPending === 'function' ? depotStopPending : () => false;
    this._stationLinedUp = typeof stationLinedUp === 'function' ? stationLinedUp : () => true;
    this._otherBossBusy = typeof otherBossBusy === 'function' ? otherBossBusy : () => false;
    this._finishStationBurn = typeof finishStationBurn === 'function' ? finishStationBurn : () => true;
    this._stationPlane = typeof stationPlane === 'function' ? stationPlane : () => null;
    this._stationObject = typeof stationObject === 'function' ? stationObject : () => null;

    /** @type {boolean} boss already run+resolved this game. */
    this._completed = false;
    /** @type {boolean} boss currently running. */
    this._active = false;
    /** @type {MissionOnset} armed at the boundary, fired on the first free gameplay frame. */
    this._onset = new MissionOnset();
    /** @type {ThreatSet} the spawned threat frags + which are neutralised. */
    this._threats = new ThreatSet();
    /** @type {number} game-seconds until closest approach. */
    this._tcaRemainingS = 0;
    /** @type {boolean} the imminent (final) warning has fired. */
    this._imminentFired = false;

    /** @type {Function[]} listeners that only live while the boss runs. */
    this._runUnsubs = [];
    this._unsubs = [];
    this._disposed = false;
  }

  /** Subscribe to triggers. Call once after construction. */
  init() {
    if (this._disposed || !this._eventBus) return;
    const on = (evt, h) => { if (evt) this._unsubs.push(this._eventBus.on(evt, h)); };

    on(Events.MISSION_START, (d) => this._onMissionStart(d));
    on(Events.FIELD_ARRIVED, () => this._onFieldArrived());
    // A terminal state before the armed onset fires cancels it.
    on(Events.GAME_STATE_CHANGE, (d) => {
      if (d && (d.to === GameStates.GAME_OVER || d.to === GameStates.WIN)) this._onset.cancel();
    });
    on(Events.GAME_RESET, () => this.reset());
    on(Events.PERSISTENCE_GATHER, (save) => { if (save) save.issBoss = this._serialize(); });
    on(Events.PERSISTENCE_LOADED, () => {
      const save = this._pm && typeof this._pm.peek === 'function' ? this._pm.peek() : null;
      if (save && save.issBoss) this._restore(save.issBoss);
    });
  }

  /** Per-frame tick (gameplay frames only): fires an armed onset, then advances the game-time TCA countdown. */
  update(dt) {
    if (this._disposed) return;
    if (this._onset.armed && this._onset.poll(this._depotStopPending() || this._otherBossBusy()) != null) this._fire();
    if (!this._active) return;
    this._tcaRemainingS -= dt * (TimeAuthority.BASE_SCALE || 1);

    const imminentS = (Constants.ISS_BOSS.IMMINENT_HOURS || 4) * 3600;
    if (!this._imminentFired && this._tcaRemainingS <= imminentS && this._tcaRemainingS > 0) {
      this._imminentFired = true;
      const remainingH = Math.max(0, this._tcaRemainingS / 3600);
      this._eventBus.emit(Events.ISS_BOSS_IMMINENT, {
        tcaRemainingHours: remainingH,
        cleared: this._threats.clearedCount,
        total: this._threats.total,
      });
      this._comms(bossLines(this._stationObject()).imminent(Math.round(remainingH), this._threats.clearedCount, this._threats.total), 'warning');
    }

    if (this._tcaRemainingS <= 0) {
      // Time's up. Cleared ≥1 but not all = late hydrazine dodge (miss); none = effectively declined (autonomous PDAM).
      this._resolve(this._threats.clearedCount > 0 ? 'miss' : 'decline');
    }
  }

  /** @returns {boolean} */
  isActive() { return this._active; }

  /** @returns {boolean} armed at the boundary, not yet started (holding for the depot / the next frame). */
  isArmed() { return this._onset.armed; }

  /** @param {number} [mission] @returns {boolean} */
  hasCompleted() { return this._completed; }

  /** Remaining game-time hours until TCA (0 when idle). */
  getTcaRemainingHours() { return this._active ? Math.max(0, this._tcaRemainingS / 3600) : 0; }

  /** @returns {{cleared:number, total:number}} */
  getProgress() { return { cleared: this._threats.clearedCount, total: this._threats.total }; }

  /** Clear all state (GAME_RESET / new game). */
  reset() {
    this._endRun();
    this._onset.cancel();
    this._completed = false;
  }

  /** Remove listeners. */
  dispose() {
    this._disposed = true;
    this._endRun();
    this._onset.cancel();
    for (const u of this._unsubs) { if (typeof u === 'function') u(); }
    this._unsubs.length = 0;
  }


  /** @private ARM from the boss mission on, once she is lined up with the station (the `_active || _completed` guard: once per game). */
  _onMissionStart(data) {
    const mission = (data && typeof data.missionNumber === 'number')
      ? data.missionNumber
      : (this._scoring && typeof this._scoring.getMissionNumber === 'function'
        ? this._scoring.getMissionNumber() : 1);
    this._tryArm(mission);
  }

  /** @private A trip arrived at a field (Events.FIELD_ARRIVED): arm there when she is lined up (the mission is the scorer's). */
  _onFieldArrived() {
    const mission = this._scoring && typeof this._scoring.getMissionNumber === 'function' ? this._scoring.getMissionNumber() : null;
    if (Number.isFinite(mission)) this._tryArm(mission);
  }

  /**
   * @private DECISIONS §62 row 2 (route-1101 lane S2): arm when the mission is the boss mission or later AND she is at the station field
   * with the node gap within `ISS_BOSS.LINED_UP_DEG` (`stationLinedUp`, GameFlowManager.stationLinedUp, wired by main.js); never at
   * mission 5 otherwise. Asked on arrival at a field and at a mission start there. The finish burn that closes the last <= 0.346 deg
   * (at most 57 m/s, station-drift doc §2) is billed here (route-1106 lane S4: `finishStationBurn`, for the start whose tilt is the
   * station's); with too little gas the boss does not arm.
   * @param {number} mission
   */
  _tryArm(mission) {
    if (this._active || this._completed) return;
    const cfg = Constants.ISS_BOSS;
    if (!cfg || !(mission >= cfg.MISSION)) return;
    if (!this._stationLinedUp()) return;
    if (this._otherBossBusy()) return;          // never two bosses at once: the Starlink boss (mission 9) arms with no such check
    if (!this._finishStationBurn()) return;     // the finish burn is paid before the boss arms (S4); a refusal bills nothing
    this._onset.arm(mission);
  }

  /** @private FIRE (first free gameplay frame); guard re-checked: a restore during the hold may have completed it. */
  _fire() {
    if (this._active || this._completed) return;
    this._start();
  }

  /** @private Spawn the threat field + arm the countdown. */
  _start() {
    const cfg = Constants.ISS_BOSS;
    const count = cfg.FRAG_COUNT || 6;

    let ids = [];
    const obj = this._stationObject();
    if (this._debrisField && typeof this._debrisField.spawnIssThreatField === 'function') {
      // New York: the ISS's 408 km, in the station's own plane (equal to hers after the finish). A city: its object's height, built in HER
      // scene plane (the finish put her in the object's plane, and the scene keeps her orbit as its frame; route-1107-d2 D-A6).
      const opts = obj ? { count, altKm: obj.altKm } : { count, plane: this._stationPlane() || undefined };
      const res = this._debrisField.spawnIssThreatField(opts);
      ids = (res && Array.isArray(res.ids)) ? res.ids : [];
    }
    // No candidates to repurpose → can't stage the boss; bail without marking complete so it can run on a later entry.
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
      city: this._cityKey(),     // route-1107-d2: the start language of the city object (null at New York); `station` is its entry, for the coach's words
      station: obj,
    });
    this._comms(bossLines(obj).start(this._threats.total, cfg.TCA_HOURS || 38), 'critical');
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

    const lines = bossLines(this._stationObject());
    if (outcome === 'intercept') {
      // Credits via scoring; elevator mass via the shop contract.
      this._eventBus.emit(Events.SCORING_AWARD, {
        points: cfg.INTERCEPT_BONUS_CREDITS || 500,
        reason: 'ISS conjunction cleared',
      });
      this._awardElevatorMass(cfg.INTERCEPT_BONUS_KG || 200);
      this._comms(lines.intercept(), 'info');
    } else if (outcome === 'decline') {
      this._comms(lines.decline(), 'info');
    } else { // miss
      this._comms(lines.miss(), 'warning');
    }

    // `city`: the start language of the object she protected (route-1107-d2), null for New York's ISS; the `iss_*` codex entries unlock only for null
    const cityKey = this._cityKey();
    this._eventBus.emit(Events.ISS_BOSS_RESOLVED, { outcome, cleared, total, city: cityKey });

    this._completed = true;
    this._endRun();
  }

  /** @private The start-language key of the city object she protects (`Constants.CITY_STATIONS`), or null for New York's ISS. */
  _cityKey() {
    const obj = this._stationObject();
    if (!obj) return null;
    const all = Constants.CITY_STATIONS || {};
    return Object.keys(all).find((k) => all[k] === obj || all[k].satcat === obj.satcat) || null;
  }

  /** @private Add mass to the elevator contract (fires the win path on threshold). */
  _awardElevatorMass(kg) {
    awardElevatorMass(this._eventBus, this._shop, this._scoring, kg);
  }

  /** @private Critical-tagged so the boss always reaches the player. */
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
