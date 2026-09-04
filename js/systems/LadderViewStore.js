/**
 * LadderViewStore.js — the Zoom Ladder's PLAYER-owned view preferences
 * (08-workbench D5 "rooms you can rearrange"; Wave 5 Session G, 2026-09-04).
 *
 * ONE localStorage key, `sc_ladder_view_v1` (StorageKeys.LADDER_VIEW), holding
 * the two things the player arranges on the workbench and expects to find as
 * they left them after the SHOP and after a reload:
 *   - `rooms` — FloorMask's D5 per-floor pane memory, exactly its
 *     exportMemory() shape `{ floors: { "<floorId>": { "<paneId>": boolean } } }`;
 *   - `panes` — the F3 workbench panes' open-state `{ refit, library }`.
 *
 * Stored in its OWN key, deliberately separate from the run save
 * (`spacecowboy_save_v1`, wiped by `persistenceManager.deleteSave()` on every
 * New Game) — the SettingsManager header rule: a rearranged room belongs to
 * the player, not the run. The run-scoped half of D5 (the floor + z01 the
 * player left) lives in the run save instead (`save.ladder`, gathered by
 * main.js on PERSISTENCE_GATHER — see LadderController.viewState).
 *
 * The SettingsManager pattern: load + validate in the constructor, save on
 * change, private-mode-safe (every storage access is try/catch; a missing or
 * corrupt key → the shipped defaults, never a throw). G1: write-on-change
 * ONLY — setRooms/setPanes compare against the last written state and skip
 * identical writes; the callers (LadderController) invoke them on floor
 * changes and pane open/close edges, never per frame.
 *
 * Validation (every import validated): `rooms` must be an object with a
 * `floors` object; each row an object; only boolean values are kept (the pane
 * NAMES are FloorMask.importMemory's half — unknown / non-memory panes are
 * dropped there, and ALWAYS_ON can never ride in). `panes` keeps only boolean
 * `refit` / `library`; anything else → the default (both closed).
 *
 * Headless / flag-off: `storage` is injectable (tests); the default is the
 * global localStorage when present, else null → an in-memory store that
 * remembers within the session and writes nothing. main.js constructs this
 * ONLY inside the `Constants.LADDER.ENABLED` gate, so a ?ladder=0 boot never
 * touches the key (byte-identical).
 *
 * @module systems/LadderViewStore
 */

import { StorageKeys } from '../core/StorageKeys.js';

const VIEW_KEY = StorageKeys.LADDER_VIEW;

/** Envelope version — additive fields never bump it. */
export const LADDER_VIEW_VERSION = 1;

/** The shipped pane state: both workbench panes closed. */
export const DEFAULT_PANES = Object.freeze({ refit: false, library: false });

/** @private The default storage: the global localStorage when present. */
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
 * @private Validate a rooms snapshot into a fresh plain-JSON copy, or null.
 * Keeps the FloorMask exportMemory envelope; drops non-object rows,
 * non-boolean values and prototype-steering keys. Pane-name validation is
 * FloorMask.importMemory's.
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

/** @private Validate a panes object into `{ refit, library }` booleans. */
function _sanitizePanes(panes) {
  const out = { ...DEFAULT_PANES };
  if (!panes || typeof panes !== 'object') return out;
  if (typeof panes.refit === 'boolean') out.refit = panes.refit;
  if (typeof panes.library === 'boolean') out.library = panes.library;
  return out;
}

export class LadderViewStore {
  /**
   * @param {object} [deps]
   * @param {object|null} [deps.storage] - a localStorage-shaped object
   *   (getItem/setItem); default: the global localStorage, or null (in-memory
   *   only) when absent. Tests inject a stub or null.
   */
  constructor(deps = {}) {
    this._storage = (deps.storage !== undefined) ? deps.storage : _defaultStorage();
    /** @type {{floors: Object<string, Object<string, boolean>>}|null} */
    this._rooms = null;
    /** @type {{refit: boolean, library: boolean}} */
    this._panes = { ...DEFAULT_PANES };
    /** The last serialized envelope written (or loaded) — the write-on-change guard. */
    this._lastJson = null;
    /** Writes attempted (tests: G1 write-on-change pin). */
    this._writes = 0;
    this._load();
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  /**
   * The remembered rooms (FloorMask.exportMemory shape) or null when none —
   * feed straight to FloorMask.importMemory (which validates the pane names).
   * A fresh copy: callers cannot reach the store's state.
   * @returns {{floors: Object<string, Object<string, boolean>>}|null}
   */
  rooms() {
    return this._rooms ? JSON.parse(JSON.stringify(this._rooms)) : null;
  }

  /**
   * The remembered F3 pane open-state (booleans; the shipped default is both
   * closed). A fresh copy.
   * @returns {{refit: boolean, library: boolean}}
   */
  panes() {
    return { ...this._panes };
  }

  /** Writes attempted so far (tests). @returns {number} */
  writeCount() { return this._writes; }

  // ── Writes (on change only) ──────────────────────────────────────────────

  /**
   * Remember a rooms snapshot (FloorMask.exportMemory()). Invalid → ignored.
   * Writes only when the sanitized snapshot differs from what is stored.
   * @param {{floors?: object}} snapshot
   * @returns {boolean} true when the state changed (and a write was attempted)
   */
  setRooms(snapshot) {
    const rooms = _sanitizeRooms(snapshot);
    if (!rooms) return false;
    if (JSON.stringify(rooms) === JSON.stringify(this._rooms)) return false;
    this._rooms = rooms;
    this._save();
    return true;
  }

  /**
   * Remember the F3 pane open-state. Non-boolean fields fall back to the
   * default (closed). Writes only on change.
   * @param {{refit?: boolean, library?: boolean}} panes
   * @returns {boolean} true when the state changed (and a write was attempted)
   */
  setPanes(panes) {
    const next = _sanitizePanes(panes);
    if (next.refit === this._panes.refit && next.library === this._panes.library) return false;
    this._panes = next;
    this._save();
    return true;
  }

  // ── Storage (private-mode safe) ──────────────────────────────────────────

  /** @private Load + validate (a corrupt / missing key → the defaults, no throw). */
  _load() {
    try {
      if (!this._storage || typeof this._storage.getItem !== 'function') return;
      const raw = this._storage.getItem(VIEW_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      this._rooms = _sanitizeRooms(parsed.rooms);
      this._panes = _sanitizePanes(parsed.panes);
      this._lastJson = this._serialize();
    } catch (_e) {
      // corrupt / blocked storage — keep the shipped defaults
      this._rooms = null;
      this._panes = { ...DEFAULT_PANES };
    }
  }

  /** @private The envelope as written. */
  _serialize() {
    return JSON.stringify({ v: LADDER_VIEW_VERSION, rooms: this._rooms, panes: this._panes });
  }

  /** @private Persist (non-fatal on failure; skipped when nothing changed). */
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
