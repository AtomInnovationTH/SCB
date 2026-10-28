/**
 * LadderViewStore.js — the Zoom Ladder's PLAYER-owned view preferences (08-workbench D5 "rooms you can rearrange").
 *
 * ONE localStorage key, `sc_ladder_view_v3` (StorageKeys.LADDER_VIEW; floor keys mean new floors, so a renumber
 * abandons older blobs), holding the two things the player arranges on the workbench and expects to find as they
 * left them after the SHOP and after a reload:
 *   - `rooms` — FloorMask's D5 per-floor pane memory, exactly its exportMemory() shape
 *     `{ floors: { "<floorId>": { "<paneId>": boolean } } }`, stamped with `roomsGen` (ROOMS_GENERATION — the
 *     DEFAULT_ROOMS generation it was captured against; a stale stamp drops the rooms on load);
 *   - `panes` — the F3 workbench panes' open-state `{ refit, library }`.
 *
 * Stored in its OWN key, deliberately separate from the run save (`spacecowboy_save_v1`, wiped by
 * `persistenceManager.deleteSave()` on every New Game), per the SettingsManager header rule: a rearranged room
 * belongs to the player, not the run. The run-scoped half of D5 (the floor + z01 the player left) lives in the run
 * save instead (`save.ladder`, gathered by main.js on PERSISTENCE_GATHER; see LadderController.viewState).
 *
 * SettingsManager pattern: load + validate in the constructor, save on change, private-mode-safe (every storage
 * access is try/catch; a missing or corrupt key → the shipped defaults, never a throw). G1: write-on-change ONLY:
 * setRooms/setPanes compare against the last written state and skip identical writes; callers (LadderController)
 * invoke them on floor changes and pane open/close edges, never per frame.
 *
 * Validation (every import validated): `rooms` must be an object with a `floors` object; each row an object; only
 * boolean values are kept (the pane NAMES are FloorMask.importMemory's half: unknown / non-memory panes are dropped
 * there, and ALWAYS_ON can never ride in). `panes` keeps only boolean `refit` / `library`; anything else → the
 * default (both closed).
 *
 * Headless / flag-off: `storage` is injectable (tests); the default is the global localStorage when present, else
 * null → an in-memory store that remembers within the session and writes nothing. main.js constructs this ONLY
 * inside the `Constants.LADDER.ENABLED` gate, so a ?ladder=0 boot never touches the key.
 *
 * @module systems/LadderViewStore
 */

import { StorageKeys } from '../core/StorageKeys.js';

const VIEW_KEY = StorageKeys.LADDER_VIEW;

/** Envelope version — additive fields never bump it. */
export const LADDER_VIEW_VERSION = 1;

/**
 * The DEFAULT-ROOMS generation the stored `rooms` were captured against. FloorMask._captureMemory records EVERY
 * memory pane of a floor the moment any pane flips, so a player who ever touched a pane carries a full room row that
 * outranks DEFAULT_ROOMS forever: a defaults change would never reach them. Bump this when DEFAULT_ROOMS changes: a
 * stored envelope whose `roomsGen` differs (or is absent) drops its ROOMS only; the `panes` memory and the key itself
 * survive. Written on every save. Each bump drops remembered per-floor room edits once (the known cost).
 *   1 — F2 = everything shown
 *   2 — F2 nav orb + discoveries gone by default (owner 2026-09-06)
 *   3 — the CARGO pane joins MASK_PANES / DEFAULT_ROOMS (shown on the shop floor, gone elsewhere)
 *   4 — the ORBIT / COPILOT / NEXT instruments join (ORBIT + COPILOT shown on F2 + F3, COPILOT faint on F4, NEXT
 *       shown on F3 + F4)
 *   5 — first-contact rooms (owner 2026-09-07, "first make me care"): F1 is the SHIP alone (cargo + comms leave its
 *       defaults; the first WORKBENCH_STOP shows the till); F2 greets a new player with THREE panes (targets,
 *       reticles & alerts, mother) + comms + the hint ticker (debris, pin, arms, orbit, copilot behind MORE); comms
 *       leaves ALWAYS_ON for the rooms (shown F2-F5, gone on the F1 workbench).
 *   6 — F2's arms (the daughters rows, the fleet list) join the home floor: FOUR panes (with comms + the hint
 *       ticker) (owner 2026-09-07, "LEFT: mother, daughters").
 *   7 — F3 nav orb gone; composites experimental/decor.
 *   8 — F2 also shows TARGET INFO (`debris`) (owner 2026-10-13, "comms should be visible on F2 at start of game";
 *       "Targets and Target info visible after scan"): the scan gate in HUD holds both back until the first scan. A
 *       saved hide of COMMS on F2 (the − key) no longer outranks the defaults.
 *   9 — ORBIT (LAT, LON, ALT, MET) is 'gone' on F3 by default (owner 2026-10-18, "what is noise").
 */
export const ROOMS_GENERATION = 9;

export const DEFAULT_PANES = Object.freeze({ refit: false, library: false });

function _defaultStorage() {
  try {
    return (typeof localStorage !== 'undefined') ? localStorage : null;
  } catch (_e) {
    return null;                      // some embedders throw on the mere access
  }
}

/** @private Keys stored JSON may carry that must never be copied onto an object
 *  (`floors["__proto__"] = row` would run the accessor and swap the object's
 *  prototype — contained, but a sanitizer must not let data steer a prototype). */
const SPECIAL_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Validate a rooms snapshot into a fresh plain-JSON copy (FloorMask exportMemory envelope), or null; drops
 * non-object rows, non-boolean values and prototype-steering keys. Pane-name validation is FloorMask.importMemory's.
 */
function _sanitizeRooms(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const src = snapshot.floors;
  if (!src || typeof src !== 'object' || Array.isArray(src)) return null;
  const floors = {};
  for (const key of Object.keys(src)) {
    if (SPECIAL_KEYS.has(key)) continue;
    const row = src[key];
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const out = {};
    for (const pane of Object.keys(row)) {
      if (SPECIAL_KEYS.has(pane)) continue;
      if (typeof row[pane] === 'boolean') out[pane] = row[pane];
    }
    floors[key] = out;
  }
  return { floors };
}

/** Validate a panes object into `{ refit, library }` booleans. */
function _sanitizePanes(panes) {
  const out = { ...DEFAULT_PANES };
  if (!panes || typeof panes !== 'object') return out;
  if (typeof panes.refit === 'boolean') out.refit = panes.refit;
  if (typeof panes.library === 'boolean') out.library = panes.library;
  return out;
}

export class LadderViewStore {
  /** @param {object|null} [deps.storage] - localStorage-shaped (getItem/setItem); default the global, or null. */
  constructor(deps = {}) {
    this._storage = (deps.storage !== undefined) ? deps.storage : _defaultStorage();
    this._rooms = null;
    this._panes = { ...DEFAULT_PANES };
    /** The last serialized envelope written (or loaded): the write-on-change guard. */
    this._lastJson = null;
    this._writes = 0;
    this._load();
  }

  /** The remembered rooms (FloorMask.exportMemory shape) or null; a fresh copy, feed to FloorMask.importMemory. */
  rooms() {
    return this._rooms ? JSON.parse(JSON.stringify(this._rooms)) : null;
  }

  /**
   * The remembered drawer open-state (default both closed): `refit` = the workbench REFIT drawer (floor 1 only,
   * recorded while floor 1 is applied, carried otherwise), `library` = the SPECS drawer (rides along across floors,
   * recorded on every floor). A fresh copy.
   */
  panes() {
    return { ...this._panes };
  }

  /** Writes attempted (tests: G1 write-on-change pin). */
  writeCount() { return this._writes; }

  /** Remember a rooms snapshot (FloorMask.exportMemory()); invalid → ignored. Writes only on change. */
  setRooms(snapshot) {
    const rooms = _sanitizeRooms(snapshot);
    if (!rooms) return false;
    if (JSON.stringify(rooms) === JSON.stringify(this._rooms)) return false;
    this._rooms = rooms;
    this._save();
    return true;
  }

  /** Remember the drawer open-state; non-boolean fields fall back to closed. Writes only on change. */
  setPanes(panes) {
    const next = _sanitizePanes(panes);
    if (next.refit === this._panes.refit && next.library === this._panes.library) return false;
    this._panes = next;
    this._save();
    return true;
  }

  _load() {
    try {
      if (!this._storage || typeof this._storage.getItem !== 'function') return;
      const raw = this._storage.getItem(VIEW_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      // Rooms captured against an older DEFAULT_ROOMS generation are dropped
      // (the new defaults must land); panes memory is generation-free.
      this._rooms = (parsed.roomsGen === ROOMS_GENERATION) ? _sanitizeRooms(parsed.rooms) : null;
      this._panes = _sanitizePanes(parsed.panes);
      this._lastJson = this._serialize();
    } catch (_e) {
      // corrupt / blocked storage — keep the shipped defaults
      this._rooms = null;
      this._panes = { ...DEFAULT_PANES };
    }
  }

  _serialize() {
    return JSON.stringify({ v: LADDER_VIEW_VERSION, roomsGen: ROOMS_GENERATION, rooms: this._rooms, panes: this._panes });
  }

  _save() {
    const json = this._serialize();
    if (json === this._lastJson) return;
    this._lastJson = json;
    this._writes++;
    try {
      if (!this._storage || typeof this._storage.setItem !== 'function') return;
      this._storage.setItem(VIEW_KEY, json);
    } catch (_e) { /* private mode / quota — the in-memory copy still serves the session */ }
  }
}

export default LadderViewStore;
