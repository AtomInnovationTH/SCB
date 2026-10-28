/**
 * @module core/DevShotGate — the ONE predicate for the dev net-shot surface (`?shot=1` / `?shotauto=1`).
 *
 * The contract: a parameter counts ONLY at the exact value `1`; bare `?shot`, `?shot=0`, `?shotauto=yes` are NOT
 * requests. Both the `__net*` install gate (main.js) and the `preserveDrawingBuffer` read (SceneManager.js) must use
 * this predicate: an install without a preserved buffer makes the read-back warn
 * `[netShot] canvas read-back looks empty`.
 *
 * Read **once** at module load so every consumer agrees (the ProfileFlags idiom): the main.js install gate and the
 * SceneManager `preserveDrawingBuffer` read consume `requested`, the auto-capture default consumes `shotautoRequested`.
 * Also the explicit opt-in seam gating the `__lasso*` hooks (the guard lives in LassoSystem.js, not here). Safe
 * off-browser (Node test runner): returns the all-defaults struct when `window` / `URLSearchParams` is unavailable.
 * Off a dev host (core/DevHost) the live read gives the defaults; `_parseForTest` stays pure.
 */
import { devSearch } from './DevHost.js';

/**
 * @typedef {object} DevShotGate
 * @property {boolean} shotRequested      — `?shot=1` exactly
 * @property {boolean} shotautoRequested  — `?shotauto=1` exactly
 * @property {boolean} requested          — either: install the surface AND preserve the buffer
 */

/**
 * Parse a query string (with leading `?`) into a frozen {@link DevShotGate}: the ONE parser; the live singleton and the
 * test seam both read it.
 */
function parse(search) {
  const params = new URLSearchParams(search || '');
  const shotRequested = params.get('shot') === '1';
  const shotautoRequested = params.get('shotauto') === '1';
  return Object.freeze({
    shotRequested,
    shotautoRequested,
    requested: shotRequested || shotautoRequested,
  });
}

/** @type {DevShotGate} */
const DEFAULTS = Object.freeze({ shotRequested: false, shotautoRequested: false, requested: false });

/** Parse the live URL query string; off-browser or on any parse failure, the all-defaults struct. */
function parseFromLocation() {
  if (typeof window === 'undefined' || typeof URLSearchParams === 'undefined') {
    return DEFAULTS;
  }
  try {
    return parse(devSearch(window.location));
  } catch (_e) {
    return DEFAULTS;
  }
}

/**
 * Singleton, parsed at module load: import this rather than re-parse the URL (ONE predicate, one parse, no drift).
 * @type {DevShotGate}
 */
export const devShotGate = parseFromLocation();

/** Test helper: drives query strings without mutating `window.location`. Not runtime API. */
export function _parseForTest(search) {
  return parse(search);
}

export default devShotGate;
