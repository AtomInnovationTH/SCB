/**
 * @module systems/FloorWordsStore — "LEO / GEO explained once" (DECISIONS §30 row 1). The ladder rail keeps its orbit
 * words (`4 LEO`, `5 GEO`); the first time the player arrives on floor 4 (and, separately, floor 5) by their own
 * choice, one plain line says what the word means. Holds the two lines, the pure "show it now?" rule, and the
 * once-per-player record (like StrutAutoStore: one localStorage key, outside the run save so a New Game does not
 * repeat it, in-memory fallback when storage fails, write-on-change). Imports only StorageKeys. Node-safe.
 */

import { StorageKeys } from '../core/StorageKeys.js';

/** Envelope version of the stored record. */
export const FLOOR_WORDS_VERSION = 1;

/** The explaining line per floor. */
export const FLOOR_WORDS = Object.freeze({
  4: 'LEO means low Earth orbit: 200 to 2,000 km',
  5: 'GEO means geostationary orbit: 35,786 km',
});

/** How long the line stays up (ms). */
export const FLOOR_WORDS_MS = 5000;

/**
 * Should a floor-word line be shown this frame? Pure. `taught` is a (floor) => boolean, or a Set / array of floors.
 * @returns {string|null} the text, or null
 */
export function floorWordsToShow({ floor, riding, intro, quiet, taught }) {
  const text = FLOOR_WORDS[floor];
  if (!text) return null;
  if (riding || intro || quiet) return null;
  let done = false;
  if (typeof taught === 'function') done = !!taught(floor);
  else if (taught && typeof taught.has === 'function') done = taught.has(floor);
  else if (Array.isArray(taught)) done = taught.includes(floor);
  return done ? null : text;
}

/** @private default storage: the global localStorage when present. */
function _defaultStorage() {
  try {
    return (typeof localStorage !== 'undefined') ? localStorage : null;
  } catch (_e) {
    return null;
  }
}

export class FloorWordsStore {
  /** @param {object|null} [deps.storage] localStorage-shaped; default the global localStorage, or null (in-memory only). */
  constructor(deps = {}) {
    this._storage = (deps.storage !== undefined) ? deps.storage : _defaultStorage();
    this._taught = new Set();
    this._lastJson = null;
    this._load();
  }

  /** @returns {boolean} whether this floor's line has been shown to this player */
  isTaught(floor) { return this._taught.has(floor); }

  /** @returns {boolean} whether every floor that has a line has been taught (the per-frame rule can be skipped) */
  allTaught() {
    for (const f of Object.keys(FLOOR_WORDS)) if (!this._taught.has(Number(f))) return false;
    return true;
  }

  /** Record that the floor's line was shown. Writes once per floor; later calls are no-ops. */
  markTaught(floor) {
    if (!FLOOR_WORDS[floor] || this._taught.has(floor)) return;
    this._taught.add(floor);
    this._save();
  }

  /** @private */
  _load() {
    if (!this._storage) return;
    let raw = null;
    try { raw = this._storage.getItem(StorageKeys.FLOOR_WORDS); } catch (_e) { return; }
    if (typeof raw !== 'string' || !raw) return;
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object' && o.v === FLOOR_WORDS_VERSION && Array.isArray(o.taught)) {
        for (const f of o.taught) if (FLOOR_WORDS[f]) this._taught.add(f);
        this._lastJson = raw;
      }
    } catch (_e) { /* corrupt → nothing taught */ }
  }

  /** @private */
  _save() {
    const json = JSON.stringify({ v: FLOOR_WORDS_VERSION, taught: [...this._taught].sort((a, b) => a - b) });
    if (json === this._lastJson) return;
    this._lastJson = json;
    if (!this._storage) return;
    try {
      this._storage.setItem(StorageKeys.FLOOR_WORDS, json);
    } catch (_e) { /* private mode / quota: remembered for this session only */ }
  }
}
