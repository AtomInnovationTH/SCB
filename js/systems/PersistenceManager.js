/**
 * PersistenceManager.js — localStorage save/load singleton for game persistence
 * Handles serialization, version checking, and graceful error handling.
 * @module systems/PersistenceManager
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { StorageKeys } from '../core/StorageKeys.js';

const SAVE_KEY = StorageKeys.SAVE;
// F1 save-guard: a New Game copies the existing save here before deleting it,
// so an accidental Enter-on-menu (which maps to START) is recoverable instead
// of an instant, silent data loss.
const SAVE_BACKUP_KEY = StorageKeys.SAVE_BACKUP;
const SAVE_VERSION = 1;

class PersistenceManager {
  constructor() {
    this._storageAvailable = this._checkStorage();
  }

  /**
   * Check if localStorage is available (some browsers block it).
   * @private
   * @returns {boolean}
   */
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
   * @param {number}  data.credits
   * @param {number}  data.totalScore
   * @param {number}  data.missionNumber
   * @param {number}  data.debrisCleared
   * @param {string[]} data.upgrades        - Array of purchased upgrade IDs
   * @param {object}  data.resourceMaxes    - { xenonMax, coldGasMax, batteryMax, currentFuelId, tankGasId, … } (ResourceSystem.serialize())
   * @param {object}  data.stats            - Aggregate statistics
   * @returns {boolean} Whether save succeeded
   */
  save(data) {
    if (!this._storageAvailable) return false;

    try {
      const saveData = {
        version: SAVE_VERSION,
        timestamp: new Date().toISOString(),
        credits: data.credits ?? 0,
        totalScore: data.totalScore ?? 0,
        missionNumber: data.missionNumber ?? 1,
        debrisCleared: data.debrisCleared ?? 0,
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
        // Codex unlock/seen state — contributed via PERSISTENCE_GATHER by
        // CodexSystem. Purely additive (no SAVE_VERSION bump): old saves lack
        // this key and CodexSystem's load guard handles its absence.
        codex: data.codex ?? null,
        // Mission-coach chapter completion — contributed via PERSISTENCE_GATHER by
        // MissionCoach (save.missionCoach = {version, completedByMission}). This
        // whitelist previously dropped it, so coached chapters re-fired on every
        // reload+CONTINUE despite MissionCoach's "coached once" contract. Additive
        // (no SAVE_VERSION bump): MissionCoach._restore guards its own absence.
        // (Bosses' issBoss/starlinkBoss are intentionally NOT persisted — per-run.)
        missionCoach: data.missionCoach ?? null,
        // Glossary first-use seen-state — contributed via PERSISTENCE_GATHER by
        // GlossaryState (§11.8). Additive (no SAVE_VERSION bump): old saves lack
        // this key and GlossaryState's restore guard handles its absence.
        glossary: data.glossary ?? null,
        // Zoom Ladder view (D5, Wave 5 Session G): the floor + z01 the player
        // left, `{ floor, z01 }` — contributed via PERSISTENCE_GATHER by
        // main.js (LadderController.viewState) ONLY while Constants.LADDER.
        // ENABLED, restored on PERSISTENCE_LOADED before the first engage of a
        // continued run. Additive (no SAVE_VERSION bump): old saves lack it
        // and the restore validates + defaults. Unlike the other contributors
        // it is OMITTED when absent (not `null`): with the ladder off nothing
        // gathers it, and the flag-off save blob must stay byte-identical.
        ...(data.ladder != null ? { ladder: data.ladder } : {}),
        // Skill mastery/XP — contributed via PERSISTENCE_GATHER by SkillsSystem
        // (saveData.skills = _serialize()). Additive (no SAVE_VERSION bump):
        // SkillsSystem's restore guards `save.skills` absence on old saves.
        skills: data.skills ?? null,
        // Power-bus allocations — handed in directly by GameFlowManager.saveGame
        // (powerDistribution.serialize()) and restored by powerDistribution
        // .restore(save.power). Additive; restore takes `|| null`.
        power: data.power ?? null,
        // Fleet launch-speed dial (Item 100) — handed in by saveGame, restored
        // AFTER the upgrade replay so the equipped spring tier clamps it.
        // Additive; the restore is `typeof save.launchSpeed === 'number'`-guarded.
        launchSpeed: data.launchSpeed ?? null,
        // Elevator-contract mass accumulated toward the WIN condition (Phase 5)
        // — handed in by saveGame (shopScreen.getContractMass()). Dropping this
        // reset a win-condition track to 0 on every reload+CONTINUE. `?? 0`
        // matches the restore's truthy guard and the getContractMass() default.
        contractMassKg: data.contractMassKg ?? 0,
        // Subsystem health + battery depth-of-discharge state (ST-6.7) —
        // contributed via PERSISTENCE_GATHER by EnvironmentSystem. Additive:
        // its restore returns early on `!save.environment`.
        environment: data.environment ?? null,
        // Seeded space-weather replay cursor + fired-event set (ST-6.1) —
        // contributed via PERSISTENCE_GATHER by SpaceWeatherSystem. Additive:
        // legacy saves without it simply start the replay from hour 0.
        spaceWeatherReplay: data.spaceWeatherReplay ?? null,
        // ST-9.2: Active arm tier (Y0_QUAD / Y1_HEX / Y3_OCTO)
        armTier: data.armTier ?? 'Y0_QUAD',
        // Q2 Net-Launch Ceremony first-time flags (CEREMONY_REDESIGN.md §5.6)
        ceremonyFlags: {
          FIRST_NET_DEPLOY: data.ceremonyFlags?.FIRST_NET_DEPLOY ?? false,
          // First-depot settlement + framing (first-credit legibility plan):
          // gates the one-time affordability floor and the investment-framing
          // shop header. Profile-permanent — survives GAMEOVER_CONTINUE.
          FIRST_DEPOT_VISITED: data.ceremonyFlags?.FIRST_DEPOT_VISITED ?? false,
          // Mother whale-net first deploy (mother-net-reel plan §11.3): gates
          // the full 7-beat first-ever cinematic vs the trimmed highlights cut.
          // MUST be listed here — this block is a WHITELIST, so any flag that
          // setCeremonyFlag() writes but that is missing from this list is
          // silently dropped on the next save() (setCeremonyFlag still returns
          // true), and getCeremonyFlag() then reads false forever.
          FIRST_MOTHER_NET_DEPLOY: data.ceremonyFlags?.FIRST_MOTHER_NET_DEPLOY ?? false,
        },
        // t1-stranded D4: true ONLY on the save written when the run enters GAME_OVER
        // (GameFlowManager.saveGame({ gameOver: true })). MENU_CONTINUE reads it and
        // applies the game-over screen's CONTINUE rule (half the credits, fresh mission).
        // Additive (no SAVE_VERSION bump): old saves lack it and load as a normal save.
        gameOver: data.gameOver === true,
        // u1-resupply-stop F2: true when the save is written AT the resupply stop that has no boundary count to
        // re-derive it from (the game-over shop: 0 cleared). MENU_CONTINUE reopens the stop on it; a save without
        // the key falls back to the mission-boundary count. Additive (no SAVE_VERSION bump).
        resupplyStop: data.resupplyStop === true,
        // Nets step 3 slice 2b (FEATURE_FLAGS.FIELDS_BY_HEIGHT): the field she is at, which pieces of each field are left,
        // and the days of ship time the trips have added. Written only when the caller has them (the flag is on), so a flag-off
        // save is byte-for-byte what it was. Additive (no SAVE_VERSION bump): an old save loads as "fresh, at the start field".
        ...(data.fields != null ? { fields: data.fields } : {}),
        ...(Number.isFinite(data.shipDays) && data.shipDays > 0 ? { shipDays: data.shipDays } : {}),
        // Nets step 3 lane 3f (DECISIONS §34 row 10): each daughter's ion fuel (%) and cold gas (kg), [{ id, fuel, coldGasKg }]. Handed in
        // by saveGame (armManager.getSupplyState()); a game-over save passes none, so CONTINUE starts every tank full. Written only
        // when given: an old save, and a game-over save, load with full tanks as before. Additive (no SAVE_VERSION bump).
        ...(Array.isArray(data.daughters) ? { daughters: data.daughters } : {}),
        // Nets step 3 slice 5 (lane 5b, P5): the big pieces still aboard (counted at the catch, paid when disposed of): [{type, name, material,
        // mass, size, owner, areaM2, fieldId, fieldRow, fate, holder, caughtAtMs, members?}]. Handed in by saveGame (BigPieces ledger); written
        // only when there are some, so a save with none (every old one, and a game-over save) is byte-for-byte what it was. Additive.
        ...(Array.isArray(data.bigPieces) && data.bigPieces.length ? { bigPieces: data.bigPieces } : {}),
        // save() is a WHITELIST: a key that a read-modify-write setter writes
        // (as setCeremonyFlag does with ceremonyFlags above) but that is
        // missing from this list is silently dropped on the next write. (The
        // launch-phase, deploy-state, tether-reel, bridle-ring and capture-net
        // inventory slices were removed 2026-10-16/17; an old save that still
        // carries their keys loads fine and they are dropped on the next
        // write.) Additive (no SAVE_VERSION bump).
      };

      localStorage.setItem(SAVE_KEY, JSON.stringify(saveData));
      // (Events.PERSISTENCE_SAVED is intentionally not emitted: it has no
      // subscribers. The save lifecycle is covered by PERSISTENCE_GATHER, and
      // self-managing systems restore via PERSISTENCE_LOADED. The event name is
      // kept in Events.js as a reserved hook for future external consumers.)
      return true;
    } catch (e) {
      console.error('[PersistenceManager] Save failed:', e.message);
      return false;
    }
  }

  /**
   * Read and parse save data from localStorage.
   * @returns {object|null} Parsed save data, or null if no valid save exists
   */
  load() {
    if (!this._storageAvailable) return null;

    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;

      const data = JSON.parse(raw);

      // Version compatibility check
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
   * Read save data without emitting events.
   * For use by self-managing systems in PERSISTENCE_LOADED handlers
   * (avoids infinite recursion since load() emits PERSISTENCE_LOADED).
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
   * Get the persisted arm tier key (ST-9.2).
   * Falls back to 'Y0_QUAD' on missing/legacy saves (backward-compat).
   * @returns {string} One of 'Y0_QUAD', 'Y1_HEX', 'Y3_OCTO'
   */
  getArmTier() {
    const data = this.peek();
    return data?.armTier ?? 'Y0_QUAD';
  }

  // =========================================================================
  // Q2 NET-LAUNCH CEREMONY FIRST-TIME FLAGS — CEREMONY_REDESIGN.md §5.6
  // =========================================================================

  /**
   * Read a ceremony first-time flag (Q2 net-launch ceremony).
   * Returns false for missing/legacy saves (backward-compat).
   * @param {string} name — flag name (e.g., 'FIRST_NET_DEPLOY')
   * @returns {boolean}
   */
  getCeremonyFlag(name) {
    const data = this.peek();
    return data?.ceremonyFlags?.[name] ?? false;
  }

  /**
   * Persist a ceremony first-time flag (Q2 net-launch ceremony).
   * Read-modify-write: loads existing save, patches ceremonyFlags[name], writes back.
   * @param {string} name — flag name (e.g., 'FIRST_NET_DEPLOY')
   * @param {boolean} value
   * @returns {boolean} Whether save succeeded
   */
  setCeremonyFlag(name, value) {
    if (!this._storageAvailable) return false;
    const data = this.peek() || {};
    data.ceremonyFlags = { ...(data.ceremonyFlags || {}), [name]: !!value };
    return this.save(data);
  }

  /**
   * Quick check whether a valid save exists.
   * @returns {boolean}
   */
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

  /**
   * Delete all save data from localStorage.
   */
  deleteSave() {
    if (!this._storageAvailable) return;

    try {
      localStorage.removeItem(SAVE_KEY);
    } catch (e) {
      console.error('[PersistenceManager] Delete failed:', e.message);
    }
  }

  /**
   * F1 save-guard: copy the current save to a backup slot before it is deleted
   * by a New Game. Enter on the menu maps to START, which calls deleteSave();
   * backing up first makes that accidental loss recoverable. No-op (returns
   * false) when storage is unavailable or there is no save to back up.
   * @returns {boolean} Whether a backup was written.
   */
  backupSave() {
    if (!this._storageAvailable) return false;

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
   * Read the raw backup slot written by backupSave(). Returns the parsed save
   * object, or null when absent/invalid. Version-checked like peek().
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

  /**
   * Whether a recoverable backup save exists (written by backupSave()).
   * @returns {boolean}
   */
  hasBackup() {
    return this.peekBackup() !== null;
  }

  /**
   * Return the current save format version.
   * @returns {number}
   */
  getVersion() {
    return SAVE_VERSION;
  }
}

/** Singleton instance */
export const persistenceManager = new PersistenceManager();
export default persistenceManager;
