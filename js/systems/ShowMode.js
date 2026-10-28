/**
 * @module systems/ShowMode — "show mode": this device is a shared iPad (DECISIONS §52). While on, IdleReset's clock runs
 * and asks "Still playing?" after 60 s without a touch; off (the default) there is no clock and no card.
 *
 * On: `?show=1` once (remembered on that device, StorageKeys.SHOW_MODE) or the menu toggle (a Home Screen web app keeps
 * its own storage and always opens `./`, so the toggle is the way in there). Off: `?show=0` or the same toggle.
 *
 * THIS MODULE'S BODY RUNS AT IMPORT, and main.js imports it FIRST: (1) finish a New player reset that was cut short
 * (`bootWipeIfPending`), before SettingsManager, OnboardingDirector and the rest read storage; (2) apply `?show=`.
 * Everything else here is a pure function with injectable storage.
 */

import { StorageKeys } from '../core/StorageKeys.js';
import { bootWipeIfPending } from './IdleReset.js';

/** The page's localStorage; null when there is none or touching it throws. */
function defaultLocal() {
  try { return globalThis.localStorage || null; } catch (_) { return null; }
}

/**
 * `?show=1` → true, `?show=0` → false, anything else → null.
 * @param {string} search  location.search
 * @returns {boolean|null}
 */
export function parseShowParam(search) {
  if (typeof search !== 'string') return null;
  const m = /[?&]show=([^&#]*)/.exec(search);
  if (!m) return null;
  if (m[1] === '1') return true;
  if (m[1] === '0') return false;
  return null;
}

/** @returns {boolean} true when the stored switch is on. */
export function readShowMode(storage) {
  const ls = storage !== undefined ? storage : defaultLocal();
  if (!ls) return false;
  try { return ls.getItem(StorageKeys.SHOW_MODE) === '1'; } catch (_) { return false; }
}

/**
 * Off removes the key.
 * @returns {boolean} true when storage took the write
 */
export function writeShowMode(on, storage) {
  const ls = storage !== undefined ? storage : defaultLocal();
  if (!ls) return false;
  try {
    if (on) ls.setItem(StorageKeys.SHOW_MODE, '1');
    else ls.removeItem(StorageKeys.SHOW_MODE);
    return true;
  } catch (_) { return false; }
}

/** @returns {boolean|null} the new state, or null when the URL carried no (valid) switch */
export function applyShowParam(search, storage) {
  const v = parseShowParam(search);
  if (v === null) return null;
  writeShowMode(v, storage);
  return v;
}

/** Live state for this page (the menu toggle, the "Show mode" mark and the idle clock read it). */
export class ShowModeState {
  /** @param {object} [storage] localStorage-like; omitted = the page's */
  constructor(storage) {
    this._storage = storage;
    this._on = readShowMode(storage);
    this._subs = new Set();
  }

  /** @returns {boolean} */
  isOn() { return this._on; }

  /**
   * Persists, and tells the subscribers when it changed.
   * @param {boolean} on
   * @returns {boolean} the state now
   */
  set(on) {
    const next = !!on;
    writeShowMode(next, this._storage);
    if (next !== this._on) {
      this._on = next;
      for (const fn of this._subs) { try { fn(next); } catch (_) { /* a listener must not break the switch */ } }
    }
    return this._on;
  }

  /** Re-read storage (after the URL switch ran). */
  refresh() { this._on = readShowMode(this._storage); return this._on; }

  /** @param {(on:boolean)=>void} fn @returns {()=>void} unsubscribe */
  onChange(fn) { this._subs.add(fn); return () => this._subs.delete(fn); }
}

// import-time work (see the header)
try { bootWipeIfPending(); } catch (_) { /* never block the boot */ }
try {
  if (typeof location !== 'undefined') applyShowParam(location.search);
} catch (_) { /* never block the boot */ }

/** Built after the URL switch has been applied. */
export const showMode = new ShowModeState();

export default showMode;
