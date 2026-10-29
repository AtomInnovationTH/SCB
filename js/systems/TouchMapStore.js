/**
 * TouchMapStore.js — the first-run TOUCH MAP's PLAYER-owned record (Ipad.md §5.5 / §5.8: "one verb per card;
 * advance ONLY on the witnessed real input — never on a timer").
 *
 * ONE localStorage key, `sc_touch_map_v1` (StorageKeys.TOUCH_MAP), holding which of the map's SIX rows the player
 * has witnessed and whether the map was skipped: the envelope `{ v: 1, done: string[], skipped: boolean }`. The splash
 * (js/ui/GestureSplash.js) shows until the record says done
 * or skipped — ONCE per player, so the key is deliberately separate from the
 * run save (`spacecowboy_save_v1`, wiped by every New Game): a player who has
 * already found the gestures is not re-taught them after a reset.
 *
 * LadderViewStore idiom: load + validate in the constructor, save on change, private-mode-safe (every storage
 * access is try/catch; a missing or corrupt key gives the empty record, never a throw). Write-on-change ONLY:
 * markDone / markSkipped skip identical writes; the pane calls them at event rate, never per frame.
 *
 * Sanitised on load: `done` keeps only KNOWN row ids (TOUCH_MAP_ROW_IDS), de-duplicated, in table order; `skipped`
 * only a boolean; prototype-steering keys (`__proto__` / `constructor` / `prototype`) are never copied; a wrong
 * envelope version / shape gives the empty record.
 *
 * DOM-free by design: the row-id list lives HERE (`TOUCH_MAP_ROW_IDS`) and the
 * pane imports it, so the two agree without the store knowing a pane exists.
 *
 * `storage` is injectable (tests); default is the global localStorage when present, else null = an in-memory
 * store that writes nothing. main.js constructs this ONLY inside the `Constants.LADDER.ENABLED` gate, so a
 * ?ladder=0 boot never touches the key. Nothing here reads the DOM, the window or Constants.
 *
 * @module systems/TouchMapStore
 */

import { StorageKeys } from '../core/StorageKeys.js';

const MAP_KEY = StorageKeys.TOUCH_MAP;

// Envelope version; additive fields never bump it.
export const TOUCH_MAP_VERSION = 1;

// The six row ids in the map's order: open REFIT drawer, open SPECS drawer, ride up a floor, zoom, select a
// target, fire the net. Frozen: the sanitiser and the pane both key on it.
export const TOUCH_MAP_ROW_IDS = Object.freeze(['refit', 'specs', 'ride', 'zoom', 'select', 'net']);

const KNOWN = new Set(TOUCH_MAP_ROW_IDS);

function _defaultStorage() {
  try {
    return (typeof localStorage !== 'undefined') ? localStorage : null;
  } catch (_e) {
    return null; // some embedders throw on the mere access
  }
}

const SPECIAL_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Validate a `done` list into a fresh array of KNOWN ids, de-duplicated, in TOUCH_MAP_ROW_IDS order; non-array gives [].
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
  /** @param {object|null} [deps.storage] localStorage-shaped (getItem/setItem/removeItem); null = in-memory only. */
  constructor(deps = {}) {
    this._storage = (deps.storage !== undefined) ? deps.storage : _defaultStorage();
    this._done = [];
    this._skipped = false;
    /** True when the key held a VALID envelope at load (isFirstRun's "no record" half). */
    this._loaded = false;
    /** Last serialized envelope written or loaded: the write-on-change guard. */
    this._lastJson = null;
    /** Writes attempted (tests pin write-on-change). */
    this._writes = 0;
    this._load();
  }


  /**
   * True when no valid record exists OR it is neither skipped nor complete (all six done). The pane asks ONCE, at
   * construction: a boot that finds it false builds nothing.
   */
  isFirstRun() {
    if (!this._loaded) return true;
    if (this._skipped) return false;
    return this._done.length < TOUCH_MAP_ROW_IDS.length;
  }

  done() { return this._done.slice(); }

  isDone(id) { return this._done.includes(id); }

  isSkipped() { return this._skipped; }

  isComplete() { return this._done.length >= TOUCH_MAP_ROW_IDS.length; }

  snapshot() {
    return { v: TOUCH_MAP_VERSION, done: this._done.slice(), skipped: this._skipped };
  }

  writeCount() { return this._writes; }


  /** Record a witnessed row; unknown ids ignored, an already-done id is a no-op (no write). True when changed. */
  markDone(id) {
    if (typeof id !== 'string' || !KNOWN.has(id)) return false;
    if (this._done.includes(id)) return false;
    const next = new Set(this._done);
    next.add(id);
    this._done = TOUCH_MAP_ROW_IDS.filter((rid) => next.has(rid));
    this._save();
    return true;
  }

  /** Record the SKIP. `done` is kept (it is the truth of what was witnessed); isFirstRun() reads false from here on. */
  markSkipped() {
    if (this._skipped) return false;
    this._skipped = true;
    this._save();
    return true;
  }

  /** Forget everything: drops the key, back to the empty record (isFirstRun() true again). Non-fatal on blocked storage. */
  reset() {
    this._done = [];
    this._skipped = false;
    this._loaded = false;
    this._lastJson = null;
    try {
      if (this._storage && typeof this._storage.removeItem === 'function') this._storage.removeItem(MAP_KEY);
    } catch (_e) { /* private mode — the in-memory record is already empty */ }
  }


  _load() {
    try {
      if (!this._storage || typeof this._storage.getItem !== 'function') return;
      const raw = this._storage.getItem(MAP_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      if (parsed.v !== TOUCH_MAP_VERSION) return;             // foreign envelope = no record
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

  _serialize() {
    return JSON.stringify({ v: TOUCH_MAP_VERSION, done: this._done, skipped: this._skipped });
  }

  _save() {
    const json = this._serialize();
    if (json === this._lastJson) return;
    this._lastJson = json;
    this._loaded = true;
    this._writes++;
    try {
      if (!this._storage || typeof this._storage.setItem !== 'function') return;
      this._storage.setItem(MAP_KEY, json);
    } catch (_e) { /* private mode / quota: the in-memory copy serves the session */ }
  }
}

export default TouchMapStore;
