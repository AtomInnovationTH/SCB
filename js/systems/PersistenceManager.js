/**
 * PersistenceManager.js — localStorage save/load singleton for game persistence
 * Handles serialization, version checking, and graceful error handling.
 * @module systems/PersistenceManager
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { StorageKeys } from '../core/StorageKeys.js';

const SAVE_KEY = StorageKeys.SAVE;
// a New Game copies the existing save here before deleting it: an accidental Enter-on-menu maps to START
const SAVE_BACKUP_KEY = StorageKeys.SAVE_BACKUP;
const SAVE_VERSION = 1;

class PersistenceManager {
  constructor() {
    this._storageAvailable = this._checkStorage();
    /** Set by lockForReset(): a New player reset (IdleReset.js) has wiped the keys and the page is about to reload. */
    this._resetLocked = false;
  }

  /**
   * Shared-iPad reset guard (IdleReset.js, owner 2026-10-28): from now on this page writes no save and no backup, so a
   * save fired by a late timer cannot put the previous player's run back between the wipe and the reload. In memory
   * only: the reloaded page starts unlocked.
   */
  lockForReset() {
    this._resetLocked = true;
  }

  /** @returns {boolean} true once lockForReset() ran on this page. */
  isResetLocked() {
    return this._resetLocked === true;
  }

  /** localStorage can be blocked by the browser. */
  _checkStorage() {
    try {
      const test = '__sc_storage_test__';
      localStorage.setItem(test, test);
      localStorage.removeItem(test);
      return true;
    } catch (e) {
      console.warn('[PersistenceManager] localStorage not available:', e.message);
      return false;
    }
  }

  /**
   * Save game data to localStorage.
   * @param {object} data - Game state to persist
   * @param {string[]} data.upgrades        - purchased upgrade IDs
   * @param {object}  data.resourceMaxes    - { xenonMax, coldGasMax, batteryMax, currentFuelId, tankGasId, … } (ResourceSystem.serialize())
   * @returns {boolean} Whether save succeeded
   */
  save(data) {
    if (!this._storageAvailable || this._resetLocked) return false;

    try {
      const saveData = {
        version: SAVE_VERSION,
        timestamp: new Date().toISOString(),
        credits: data.credits ?? 0,
        totalScore: data.totalScore ?? 0,
        missionNumber: data.missionNumber ?? 1,
        debrisCleared: data.debrisCleared ?? 0,
        // Capture-credit taper total (ScoringSystem.captureCreditsEarned): without it a reload + CONTINUE re-opens full-price
        // capture income. Written only when above 0; an old save loads as 0.
        ...(Number.isFinite(data.captureCreditsEarned) && data.captureCreditsEarned > 0 ? { captureCreditsEarned: data.captureCreditsEarned } : {}),
        upgrades: data.upgrades ?? [],
        resourceMaxes: data.resourceMaxes ?? {},
        stats: {
          totalCaptures: data.stats?.totalCaptures ?? 0,
          manualCaptures: data.stats?.manualCaptures ?? 0,
          missionsCompleted: data.stats?.missionsCompleted ?? 0,
          bestMissionScore: data.stats?.bestMissionScore ?? 0,
          bestStreak: data.stats?.bestStreak ?? 0,
          debrisByTier: data.stats?.debrisByTier ?? { data: 0, deorbit: 0, capture: 0 },
        },
        subsystemEvents: data.subsystemEvents || null,
        // save() is a WHITELIST: a key that a read-modify-write setter writes (setCeremonyFlag) but that is missing here
        // is silently dropped on the next write. Keys marked "gather" arrive via PERSISTENCE_GATHER. Every key is additive
        // (no SAVE_VERSION bump): an old save lacks it and the restorer guards its absence.
        // Codex unlock/seen state (gather: CodexSystem).
        codex: data.codex ?? null,
        // Mission-coach chapter completion {version, completedByMission} (gather: MissionCoach): "coached once" holds across
        // reload+CONTINUE only if listed here. (Bosses' issBoss/starlinkBoss are intentionally NOT persisted — per-run.)
        missionCoach: data.missionCoach ?? null,
        // Glossary first-use seen-state (gather: GlossaryState).
        glossary: data.glossary ?? null,
        // Zoom Ladder view `{ floor, z01 }` the player left (gather: main.js, LadderController.viewState, ONLY while
        // Constants.LADDER.ENABLED); restored on PERSISTENCE_LOADED before the first engage of a continued run. Unlike the
        // others it is OMITTED when absent (not `null`): the flag-off save blob must stay byte-identical.
        ...(data.ladder != null ? { ladder: data.ladder } : {}),
        // Skill mastery/XP (gather: SkillsSystem).
        skills: data.skills ?? null,
        // Power-bus allocations (handed in by GameFlowManager.saveGame, powerDistribution.serialize()).
        power: data.power ?? null,
        // Fleet launch-speed dial (saveGame): restored AFTER the upgrade replay so the equipped spring tier clamps it.
        launchSpeed: data.launchSpeed ?? null,
        // Elevator-contract mass accumulated toward the WIN condition (saveGame, shopScreen.getContractMass()).
        // `?? 0` matches the restore's truthy guard and the getContractMass() default.
        contractMassKg: data.contractMassKg ?? 0,
        // Subsystem health + battery depth-of-discharge state (gather: EnvironmentSystem).
        environment: data.environment ?? null,
        // Seeded space-weather replay cursor + fired-event set (gather: SpaceWeatherSystem); without it the replay
        // starts from hour 0.
        spaceWeatherReplay: data.spaceWeatherReplay ?? null,
        // Active arm tier (Y0_QUAD / Y1_HEX / Y3_OCTO)
        armTier: data.armTier ?? 'Y0_QUAD',
        // Net-launch ceremony first-time flags (archive/CEREMONY_REDESIGN.md §5.6)
        ceremonyFlags: {
          FIRST_NET_DEPLOY: data.ceremonyFlags?.FIRST_NET_DEPLOY ?? false,
          // Gates the one-time affordability floor and the investment-framing shop header. Profile-permanent: survives
          // GAMEOVER_CONTINUE.
          FIRST_DEPOT_VISITED: data.ceremonyFlags?.FIRST_DEPOT_VISITED ?? false,
          // Mother whale-net first deploy: gates the full 7-beat first-ever cinematic vs the trimmed highlights cut.
          // MUST be listed here: a flag setCeremonyFlag() writes that is missing from this list is silently dropped on
          // the next save() (setCeremonyFlag still returns true) and getCeremonyFlag() reads false forever.
          FIRST_MOTHER_NET_DEPLOY: data.ceremonyFlags?.FIRST_MOTHER_NET_DEPLOY ?? false,
        },
        // true ONLY on the save written when the run enters GAME_OVER (GameFlowManager.saveGame({ gameOver: true })).
        // MENU_CONTINUE reads it and applies the game-over screen's CONTINUE rule (half the credits, fresh mission).
        gameOver: data.gameOver === true,
        // true when the save is written AT the resupply stop that has no boundary count to re-derive it from (the
        // game-over shop: 0 cleared). MENU_CONTINUE reopens the stop on it; without the key it uses the mission-boundary count.
        resupplyStop: data.resupplyStop === true,
        // FEATURE_FLAGS.FIELDS_BY_HEIGHT: the field she is at, which pieces of each field are left, and the days of ship
        // time the trips have added. Written only when the caller has them (flag on), so a flag-off save is byte-identical.
        // An old save loads as "fresh, at the start field".
        ...(data.fields != null ? { fields: data.fields } : {}),
        ...(Number.isFinite(data.shipDays) && data.shipDays > 0 ? { shipDays: data.shipDays } : {}),
        // DECISIONS §34 row 10: each daughter's ion fuel (%) and cold gas (kg), [{ id, fuel, coldGasKg }] (saveGame,
        // armManager.getSupplyState()). A game-over save passes none, so CONTINUE starts every tank full; written only when given.
        ...(Array.isArray(data.daughters) ? { daughters: data.daughters } : {}),
        // Reaction-wheel kit: the wheels' stored spin [x, y, z] in N·m·s, written only when the kit is aboard (saveGame);
        // without it the wheels stay empty.
        ...(Array.isArray(data.wheelH) ? { wheelH: data.wheelH } : {}),
        // The big pieces still aboard (counted at the catch, paid when disposed of): [{type, name, material, mass, size,
        // owner, areaM2, fieldId, fieldRow, fate, holder, caughtAtMs, members?}] (saveGame, BigPieces ledger); written only
        // when there are some, so a save with none (every old one, and a game-over save) is byte-identical.
        ...(Array.isArray(data.bigPieces) && data.bigPieces.length ? { bigPieces: data.bigPieces } : {}),
        // The jobs board's one posting `{v, fieldId, row, posted, done, doneShown}` (js/systems/JobsBoard.js, DECISIONS §42 row 5);
        // written only once it is posted, so every old save and a game-over save stay byte-identical. A missing or malformed key loads as "not posted yet".
        ...(data.jobs != null && typeof data.jobs === 'object' ? { jobs: data.jobs } : {}),
        // DECISIONS §49 row 3: the characterising steps already paid for pieces over her catch limit, `[{k: 'fieldId|fieldRow',
        // s: ['find','orbit',...]}]` (gather: DossierSystem; piece ids do not survive a reload, a field and its row do),
        // restored by GameFlowManager on Continue so a reload never pays a step twice. Written only when something was paid.
        ...(Array.isArray(data.inspectPaid) && data.inspectPaid.length ? { inspectPaid: data.inspectPaid } : {}),
        // The cargo hold's stacks `{entries: [{metalId, name, massKg, color, ispAsThrust, marketValue}]}` (CargoSystem.serialize):
        // the orbit metal the tip furnaces make, and every other metal the hold carries. Written only when the hold holds something.
        ...(data.cargoHold && Array.isArray(data.cargoHold.entries) && data.cargoHold.entries.length ? { cargoHold: data.cargoHold } : {}),
      };

      localStorage.setItem(SAVE_KEY, JSON.stringify(saveData));
      // Events.PERSISTENCE_SAVED is deliberately not emitted: no subscribers (the lifecycle is PERSISTENCE_GATHER /
      // PERSISTENCE_LOADED); the name is kept in Events.js as a reserved hook.
      return true;
    } catch (e) {
      console.error('[PersistenceManager] Save failed:', e.message);
      return false;
    }
  }

  /**
   * Read and parse save data from localStorage; emits PERSISTENCE_LOADED.
   * @returns {object|null} Parsed save data, or null if no valid save exists
   */
  load() {
    if (!this._storageAvailable) return null;

    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;

      const data = JSON.parse(raw);

      if (!data || data.version !== SAVE_VERSION) {
        console.warn('[PersistenceManager] Incompatible save version, ignoring');
        return null;
      }

      eventBus.emit(Events.PERSISTENCE_LOADED, { timestamp: data.timestamp });
      return data;
    } catch (e) {
      console.error('[PersistenceManager] Load failed:', e.message);
      return null;
    }
  }

  /**
   * Read save data without emitting events: for PERSISTENCE_LOADED handlers (load() emits it, so it would recurse).
   * @returns {object|null} Parsed save data, or null if no valid save exists
   */
  peek() {
    if (!this._storageAvailable) return null;

    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;

      const data = JSON.parse(raw);

      if (!data || data.version !== SAVE_VERSION) {
        return null;
      }

      return data;
    } catch (e) {
      return null;
    }
  }

  /**
   * @returns {string} One of 'Y0_QUAD' (default on a missing/legacy save), 'Y1_HEX', 'Y3_OCTO'
   */
  getArmTier() {
    const data = this.peek();
    return data?.armTier ?? 'Y0_QUAD';
  }

  /**
   * Read a ceremony first-time flag; false for missing/legacy saves.
   * @param {string} name — flag name (e.g., 'FIRST_NET_DEPLOY')
   * @returns {boolean}
   */
  getCeremonyFlag(name) {
    const data = this.peek();
    return data?.ceremonyFlags?.[name] ?? false;
  }

  /**
   * Persist a ceremony first-time flag. Read-modify-write: patches ceremonyFlags[name] in the existing save.
   * @param {string} name — flag name (e.g., 'FIRST_NET_DEPLOY')
   * @returns {boolean} Whether save succeeded
   */
  setCeremonyFlag(name, value) {
    if (!this._storageAvailable) return false;
    const data = this.peek() || {};
    data.ceremonyFlags = { ...(data.ceremonyFlags || {}), [name]: !!value };
    return this.save(data);
  }

  hasSave() {
    if (!this._storageAvailable) return false;

    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      return !!(data && data.version === SAVE_VERSION);
    } catch (e) {
      return false;
    }
  }

  deleteSave() {
    if (!this._storageAvailable) return;

    try {
      localStorage.removeItem(SAVE_KEY);
    } catch (e) {
      console.error('[PersistenceManager] Delete failed:', e.message);
    }
  }

  /**
   * Copy the current save to the backup slot before a New Game deletes it (Enter on the menu maps to START, which
   * calls deleteSave()). False when storage is unavailable or there is no save.
   * @returns {boolean} Whether a backup was written.
   */
  backupSave() {
    if (!this._storageAvailable || this._resetLocked) return false;

    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      localStorage.setItem(SAVE_BACKUP_KEY, raw);
      return true;
    } catch (e) {
      console.error('[PersistenceManager] Backup failed:', e.message);
      return false;
    }
  }

  /**
   * Parsed backup slot written by backupSave(), or null when absent/invalid. Version-checked like peek().
   * @returns {object|null}
   */
  peekBackup() {
    if (!this._storageAvailable) return null;

    try {
      const raw = localStorage.getItem(SAVE_BACKUP_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || data.version !== SAVE_VERSION) return null;
      return data;
    } catch (e) {
      return null;
    }
  }

  hasBackup() {
    return this.peekBackup() !== null;
  }

  getVersion() {
    return SAVE_VERSION;
  }
}

export const persistenceManager = new PersistenceManager();
export default persistenceManager;
