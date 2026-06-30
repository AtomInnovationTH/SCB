/**
 * PersistenceManager.js — localStorage save/load singleton for game persistence
 * Handles serialization, version checking, and graceful error handling.
 * @module systems/PersistenceManager
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

const SAVE_KEY = 'spacecowboy_save_v1';
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
   * @param {object}  data.resourceMaxes    - { xenonMax, coldGasMax, batteryMax }
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
        // Glossary first-use seen-state — contributed via PERSISTENCE_GATHER by
        // GlossaryState (§11.8). Additive (no SAVE_VERSION bump): old saves lack
        // this key and GlossaryState's restore guard handles its absence.
        glossary: data.glossary ?? null,
        // ST-9.2: Active arm tier (Y0_QUAD / Y1_HEX / Y3_OCTO)
        armTier: data.armTier ?? 'Y0_QUAD',
        // Q2 Net-Launch Ceremony first-time flags (CEREMONY_REDESIGN.md §5.6)
        ceremonyFlags: {
          FIRST_NET_DEPLOY: data.ceremonyFlags?.FIRST_NET_DEPLOY ?? false,
          // First-depot settlement + framing (first-credit legibility plan):
          // gates the one-time affordability floor and the investment-framing
          // shop header. Profile-permanent — survives GAMEOVER_CONTINUE.
          FIRST_DEPOT_VISITED: data.ceremonyFlags?.FIRST_DEPOT_VISITED ?? false,
        },
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

  /**
   * Persist the active arm tier (ST-9.2).
   * Read-modify-write: loads existing save, patches armTier, writes back.
   * @param {string} tierName — 'Y0_QUAD', 'Y1_HEX', or 'Y3_OCTO'
   * @returns {boolean} Whether save succeeded
   */
  setArmTier(tierName) {
    if (!this._storageAvailable) return false;
    const data = this.peek() || {};
    data.armTier = tierName;
    return this.save(data);
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

  // =========================================================================
  // ST-9.11 C-5: LAUNCH PHASE PERSISTENCE
  // =========================================================================

  /**
   * Persist the current launch phase (ST-9.11 C-5).
   * Defaults to 'READY' so existing saves don't get retroactively unlaunched.
   * @param {string} phase — one of LAUNCH_PHASES
   * @returns {boolean} Whether save succeeded
   */
  setLaunchPhase(phase) {
    if (!this._storageAvailable) return false;
    const data = this.peek() || {};
    data.launchPhase = phase;
    return this.save(data);
  }

  /**
   * Read persisted launch phase (ST-9.11 C-5).
   * Returns 'READY' for missing/legacy saves (backward-compat).
   * @returns {string}
   */
  getLaunchPhase() {
    const data = this.peek();
    return data?.launchPhase ?? 'READY';
  }

  // =========================================================================
  // ST-9.10 C-4: ARM DEPLOY STATE PERSISTENCE
  // =========================================================================

  /**
   * Persist per-arm deploy states (ST-9.10 C-4).
   * Array indexed by armIndex: ['LOCKED', 'STOWED', 'DEPLOYED', ...].
   *
   * Mid-transition snapping rule: DEPLOYING is persisted as its destination
   * (DEPLOYED), STOWING is persisted as its destination (STOWED).
   * On restore, we do NOT resume animation mid-frame — we snap to the
   * completed state. This avoids visual artifacts on load.
   *
   * @param {string[]} states — array of deploy state strings indexed by armIndex
   * @returns {boolean} Whether save succeeded
   */
  setArmDeployStates(states) {
    if (!this._storageAvailable) return false;

    // Apply mid-transition snap before persisting
    const snapped = states.map(s => {
      if (s === 'DEPLOYING') return 'DEPLOYED';
      if (s === 'STOWING') return 'STOWED';
      return s;
    });

    const data = this.peek() || {};
    data.armDeployStates = snapped;
    return this.save(data);
  }

  /**
   * Read persisted per-arm deploy states (ST-9.10 C-4).
   * Returns null if no deploy states are saved (new game / legacy save).
   *
   * Default for new game: all 'LOCKED' (pre-launch).
   * Mid-transition states are already snapped by setArmDeployStates().
   *
   * @returns {string[]|null} Array of deploy state strings, or null
   */
  getArmDeployStates() {
    const data = this.peek();
    return data?.armDeployStates ?? null;
  }

  // =========================================================================
  // ST-9.4 C-6: CAPTURE NET INVENTORY PERSISTENCE
  // =========================================================================

  /**
   * Persist capture net system state (ST-9.4 C-6).
   * Includes mother pod inventory + per-arm net counts + mercy rule flag.
   *
   * @param {object} netState — from CaptureNetSystem.getState()
   * @param {number[]} [armNetCounts] — per-arm net inventory indexed by armIndex
   * @returns {boolean} Whether save succeeded
   */
  setNetInventory(netState, armNetCounts) {
    if (!this._storageAvailable) return false;
    const data = this.peek() || {};
    data.captureNet = {
      motherPodInventory: netState?.motherPodInventory || [0, 0],
      playerHasFragmented: netState?.playerHasFragmented || false,
      armNetCounts: armNetCounts || [],
    };
    return this.save(data);
  }

  /**
   * Read persisted capture net state (ST-9.4 C-6).
   * Returns null if no capture net data saved (new game / legacy save).
   *
   * @returns {{ motherPodInventory: number[], playerHasFragmented: boolean, armNetCounts: number[] }|null}
   */
  getNetInventory() {
    const data = this.peek();
    return data?.captureNet ?? null;
  }

  // =========================================================================
  // ST-9.5 C-7: TETHER REEL STATE PERSISTENCE
  // =========================================================================

  /**
   * Persist per-arm tether reel states (ST-9.5 C-7).
   * Array of objects: { armIndex, state, cableLengthM, attachedEndpointId }.
   *
   * Mid-transition snapping rule: PAYING_OUT is persisted as STATIC,
   * REELING_IN is persisted as STOWED. On restore, we do NOT resume
   * animation mid-frame — we snap to the completed state.
   * JAMMED and CUT are preserved as-is.
   *
   * @param {Array<{armIndex: number, state: string, cableLengthM: number, attachedEndpointId: string|null}>} reelStates
   * @returns {boolean} Whether save succeeded
   */
  setReelStates(reelStates) {
    if (!this._storageAvailable) return false;

    // Apply mid-transition snap before persisting
    const snapped = (reelStates || []).map(r => ({
      armIndex: r.armIndex,
      state: r.state === 'PAYING_OUT' ? 'STATIC'
           : r.state === 'REELING_IN' ? 'STOWED'
           : r.state,
      cableLengthM: r.state === 'REELING_IN' ? 0 : (r.cableLengthM || 0),
      attachedEndpointId: r.attachedEndpointId || null,
    }));

    const data = this.peek() || {};
    data.tetherReels = snapped;
    return this.save(data);
  }

  /**
   * Read persisted tether reel states (ST-9.5 C-7).
   * Returns null if no reel data saved (new game / legacy save).
   *
   * @returns {Array<{armIndex: number, state: string, cableLengthM: number, attachedEndpointId: string|null}>|null}
   */
  getReelStates() {
    const data = this.peek();
    return data?.tetherReels ?? null;
  }

  // =========================================================================
  // ST-9.7 C-8: BRIDLE RING STATE PERSISTENCE
  // =========================================================================

  /**
   * Persist bridle ring state per arm (ST-9.7 C-8).
   * Array of { armIndex, state, attachments: [{ pointId, payloadId, loadKg }] }.
   *
   * @param {Array<{armIndex: number, state: string, attachments: Array}>} bridleData
   * @returns {boolean} Whether save succeeded
   */
  setBridleState(bridleData) {
    if (!this._storageAvailable) return false;
    const data = this.peek() || {};
    data.bridleRings = bridleData || [];
    return this.save(data);
  }

  /**
   * Read persisted bridle ring state (ST-9.7 C-8).
   * Returns null if no bridle data saved (new game / legacy save).
   *
   * @returns {Array<{armIndex: number, state: string, attachments: Array}>|null}
   */
  getBridleState() {
    const data = this.peek();
    return data?.bridleRings ?? null;
  }

  // =========================================================================
  // ST-9.8 C-10: ARM TIER MISMATCH VALIDATION
  // =========================================================================

  /**
   * Validate that persisted per-arm state arrays match the saved tier's arm count.
   * If mismatched (e.g., save corruption or tier change without state reset),
   * returns validated/defaulted arrays with a warning flag.
   *
   * @param {string} tierKey — saved tier key (e.g., 'Y1_HEX')
   * @returns {{ valid: boolean, armCount: number,
   *             armDeployStates: string[]|null,
   *             armNetCounts: number[]|null,
   *             reelStates: Array|null,
   *             bridleRings: Array|null }}
   */
  validateArmStateForTier(tierKey) {
    const ladder = Constants.ARM_LADDER[tierKey];
    if (!ladder) {
      console.warn(`[PersistenceManager] Unknown tier "${tierKey}", defaulting to Y0_QUAD`);
      return { valid: false, armCount: 4, armDeployStates: null, armNetCounts: null, reelStates: null, bridleRings: null };
    }

    const expectedCount = ladder.armCount;
    const data = this.peek();
    let valid = true;

    // Deploy states
    let armDeployStates = data?.armDeployStates ?? null;
    if (armDeployStates && armDeployStates.length !== expectedCount) {
      console.warn(`[PersistenceManager] Arm deploy state count mismatch: saved ${armDeployStates.length}, tier ${tierKey} expects ${expectedCount}. Resetting to defaults.`);
      armDeployStates = null;
      valid = false;
    }

    // Net inventory
    let armNetCounts = data?.captureNet?.armNetCounts ?? null;
    if (armNetCounts && armNetCounts.length !== expectedCount) {
      console.warn(`[PersistenceManager] Net inventory count mismatch: saved ${armNetCounts.length}, tier ${tierKey} expects ${expectedCount}. Resetting to defaults.`);
      armNetCounts = null;
      valid = false;
    }

    // Reel states
    let reelStates = data?.tetherReels ?? null;
    if (reelStates && reelStates.length !== expectedCount) {
      console.warn(`[PersistenceManager] Reel state count mismatch: saved ${reelStates.length}, tier ${tierKey} expects ${expectedCount}. Resetting to defaults.`);
      reelStates = null;
      valid = false;
    }

    // Bridle rings
    let bridleRings = data?.bridleRings ?? null;
    if (bridleRings && bridleRings.length !== expectedCount) {
      console.warn(`[PersistenceManager] Bridle ring count mismatch: saved ${bridleRings.length}, tier ${tierKey} expects ${expectedCount}. Resetting to defaults.`);
      bridleRings = null;
      valid = false;
    }

    return { valid, armCount: expectedCount, armDeployStates, armNetCounts, reelStates, bridleRings };
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

// ============================================================================
// EXPORTED PURE FUNCTION — Arm state tier validation (testable without localStorage)
// ============================================================================

/**
 * Validate persisted per-arm state data against a tier's expected arm count.
 * Pure function — no side effects. Used by PersistenceManager.validateArmStateForTier()
 * and directly by tests.
 *
 * @param {string} tierKey — tier key (e.g., 'Y1_HEX')
 * @param {object} data — raw save data (or null)
 * @returns {{ valid: boolean, armCount: number,
 *             armDeployStates: string[]|null,
 *             armNetCounts: number[]|null,
 *             reelStates: Array|null,
 *             bridleRings: Array|null }}
 */
export function validateArmStateData(tierKey, data) {
  const ladder = Constants.ARM_LADDER[tierKey];
  if (!ladder) {
    return { valid: false, armCount: 4, armDeployStates: null, armNetCounts: null, reelStates: null, bridleRings: null };
  }

  const expectedCount = ladder.armCount;
  let valid = true;

  // Deploy states
  let armDeployStates = data?.armDeployStates ?? null;
  if (armDeployStates && armDeployStates.length !== expectedCount) {
    armDeployStates = null;
    valid = false;
  }

  // Net inventory
  let armNetCounts = data?.captureNet?.armNetCounts ?? null;
  if (armNetCounts && armNetCounts.length !== expectedCount) {
    armNetCounts = null;
    valid = false;
  }

  // Reel states
  let reelStates = data?.tetherReels ?? null;
  if (reelStates && reelStates.length !== expectedCount) {
    reelStates = null;
    valid = false;
  }

  // Bridle rings
  let bridleRings = data?.bridleRings ?? null;
  if (bridleRings && bridleRings.length !== expectedCount) {
    bridleRings = null;
    valid = false;
  }

  return { valid, armCount: expectedCount, armDeployStates, armNetCounts, reelStates, bridleRings };
}
