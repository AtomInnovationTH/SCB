/**
 * TouchMapStore.js — the first-run TOUCH MAP's PLAYER-owned record (Session N
 * onboarding for glass + intro, 2026-09-06; Ipad.md §5.5 / §5.8 "one verb per
 * card; advance ONLY on the witnessed real input — never on a timer").
 *
 * ONE localStorage key, `sc_touch_map_v1` (StorageKeys.TOUCH_MAP), holding
 * which of the map's SIX rows the player has witnessed and whether the map was
 * skipped: the envelope `{ v: 1, done: string[], skipped: boolean }`. The pane
 * (js/ui/hud/TouchMapPane.js) shows on every floor until the record says done
 * or skipped — ONCE per player, so the key is deliberately separate from the
 * run save (`spacecowboy_save_v1`, wiped by every New Game): a player who has
 * already found the gestures is not re-taught them after a reset.
 *
 * The LadderViewStore idiom: load + validate in the constructor, save on
 * change, private-mode-safe (every storage access is try/catch; a missing or
 * corrupt key → the empty record, never a throw). Write-on-change ONLY —
 * markDone / markSkipped compare against the loaded record and skip identical
 * writes; the pane calls them at event rate (a row completion, the SKIP chip),
 * never per frame.
 *
 * Sanitised on load: `done` keeps only KNOWN row ids (TOUCH_MAP_ROW_IDS),
 * de-duplicated, in the table's order; `skipped` keeps only a boolean;
 * prototype-steering keys (`__proto__` / `constructor` / `prototype`) are never
 * copied; a wrong envelope version / shape → the empty record.
 *
 * DOM-free by design: the row-id list lives HERE (`TOUCH_MAP_ROW_IDS`) and the
 * pane imports it, so the two agree without the store knowing a pane exists.
 *
 * Headless / flag-off: `storage` is injectable (tests); the default is the
 * global localStorage when present, else null → an in-memory store that
 * remembers within the session and writes nothing. main.js constructs this
 * ONLY inside the `Constants.LADDER.ENABLED` gate, so a ?ladder=0 boot never
 * touches the key (byte-identical). Nothing here reads the DOM, the window or
 * Constants.
 *
 * @module systems/TouchMapStore
 */

import { StorageKeys } from '../core/StorageKeys.js';

const MAP_KEY = StorageKeys.TOUCH_MAP;

/** Envelope version — additive fields never bump it. */
export const TOUCH_MAP_VERSION = 1;

/**
 * The six row ids, in the map's order (the pane's ROWS table rides on these):
 * open the REFIT drawer, open the SPECS drawer, ride up a floor, zoom, select
 * a target, fire the net. Frozen: the sanitiser and the pane both key on it.
 */
export const TOUCH_MAP_ROW_IDS = Object.freeze(['refit', 'specs', 'ride', 'zoom', 'select', 'net']);

/** @private A Set of the known ids (the sanitiser's membership test). */
const KNOWN = new Set(TOUCH_MAP_ROW_IDS);

/** @private The default storage: the global localStorage when present. */
function _defaultStorage() {
  try {
    return (typeof localStorage !== 'undefined') ? localStorage : null;
  } catch (_e) {
    return null;                      // some embedders throw on the mere access
  }
}

/** @private Keys stored JSON may carry that must never steer an object's prototype. */
const SPECIAL_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * @private Validate a `done` list into a fresh array of KNOWN ids, de-duplicated,
 * in TOUCH_MAP_ROW_IDS order. Anything that is not an array → [].
 * @param {*} list
 * @returns {string[]}
 */
function _sanitizeDone(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  for (const id of list) {
    if (typeof id !== 'string' || SPECIAL_KEYS.has(id) || !KNOWN.has(id)) continue;
    seen.add(id);
  }
  return TOUCH_MAP_ROW_IDS.filter((id) => seen.has(id));
}

export class TouchMapStore {
  /**
   * @param {object} [deps]
   * @param {object|null} [deps.storage] - a localStorage-shaped object
   *   (getItem/setItem/removeItem); default: the global localStorage, or null
   *   (in-memory only) when absent. Tests inject a stub or null.
   */
  constructor(deps = {}) {
    this._storage = (deps.storage !== undefined) ? deps.storage : _defaultStorage();
    /** @type {string[]} known ids, TOUCH_MAP_ROW_IDS order */
    this._done = [];
    /** @type {boolean} */
    this._skipped = false;
    /** True when the key held a VALID envelope at load (isFirstRun's "no record" half). */
    this._loaded = false;
    /** The last serialized envelope written (or loaded) — the write-on-change guard. */
    this._lastJson = null;
    /** Writes attempted (tests: the write-on-change pin). */
    this._writes = 0;
    this._load();
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  /**
   * Whether the map should show: true when no valid record exists OR the
   * record is neither skipped nor complete (all six done). The pane consults
   * this ONCE, at construction — a boot that finds it false builds nothing.
   * @returns {boolean}
   */
  isFirstRun() {
    if (!this._loaded) return true;
    if (this._skipped) return false;
    return this._done.length < TOUCH_MAP_ROW_IDS.length;
  }

  /** The witnessed row ids (a fresh copy, TOUCH_MAP_ROW_IDS order). @returns {string[]} */
  done() { return this._done.slice(); }

  /**
   * @param {string} id
   * @returns {boolean} whether this row has been witnessed
   */
  isDone(id) { return this._done.includes(id); }

  /** @returns {boolean} whether the player skipped the map */
  isSkipped() { return this._skipped; }

  /** @returns {boolean} all six rows witnessed */
  isComplete() { return this._done.length >= TOUCH_MAP_ROW_IDS.length; }

  /**
   * The record as stored (a fresh copy of the envelope's fields).
   * @returns {{ v: number, done: string[], skipped: boolean }}
   */
  snapshot() {
    return { v: TOUCH_MAP_VERSION, done: this._done.slice(), skipped: this._skipped };
  }

  /** Writes attempted so far (tests). @returns {number} */
  writeCount() { return this._writes; }

  // ── Writes (on change only) ──────────────────────────────────────────────

  /**
   * Record a witnessed row. Unknown ids are ignored; an already-done id is a
   * no-op (no write).
   * @param {string} id one of TOUCH_MAP_ROW_IDS
   * @returns {boolean} true when the record changed (and a write was attempted)
   */
  markDone(id) {
    if (typeof id !== 'string' || !KNOWN.has(id)) return false;
    if (this._done.includes(id)) return false;
    const next = new Set(this._done);
    next.add(id);
    this._done = TOUCH_MAP_ROW_IDS.filter((rid) => next.has(rid));
    this._save();
    return true;
  }

  /**
   * Record the SKIP. The done list is kept (it is the truth of what was
   * witnessed); isFirstRun() reads false from here on.
   * @returns {boolean} true when the record changed
   */
  markSkipped() {
    if (this._skipped) return false;
    this._skipped = true;
    this._save();
    return true;
  }

  /**
   * Forget everything: drops the key (removeItem) and returns to the empty
   * record — isFirstRun() reads true again. Non-fatal on a blocked storage.
   */
  reset() {
    this._done = [];
    this._skipped = false;
    this._loaded = false;
    this._lastJson = null;
    try {
      if (this._storage && typeof this._storage.removeItem === 'function') this._storage.removeItem(MAP_KEY);
    } catch (_e) { /* private mode — the in-memory record is already empty */ }
  }

  // ── Storage (private-mode safe) ──────────────────────────────────────────

  /** @private Load + validate (a corrupt / missing key → the empty record, no throw). */
  _load() {
    try {
      if (!this._storage || typeof this._storage.getItem !== 'function') return;
      const raw = this._storage.getItem(MAP_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      if (parsed.v !== TOUCH_MAP_VERSION) return;             // a foreign envelope is no record
      this._done = _sanitizeDone(parsed.done);
      this._skipped = parsed.skipped === true;
      this._loaded = true;
      this._lastJson = this._serialize();
    } catch (_e) {
      // corrupt / blocked storage — the empty record (the map shows)
      this._done = [];
      this._skipped = false;
      this._loaded = false;
    }
  }

  /** @private The envelope as written. */
  _serialize() {
    return JSON.stringify({ v: TOUCH_MAP_VERSION, done: this._done, skipped: this._skipped });
  }

  /** @private Persist (non-fatal on failure; skipped when nothing changed). */
  _save() {
    const json = this._serialize();
    if (json === this._lastJson) return;
    this._lastJson = json;
    this._loaded = true;                                     // the session now holds a record
    this._writes++;
    try {
      if (!this._storage || typeof this._storage.setItem !== 'function') return;
      this._storage.setItem(MAP_KEY, json);
    } catch (_e) { /* private mode / quota — the in-memory copy still serves the session */ }
  }
}

export default TouchMapStore;
