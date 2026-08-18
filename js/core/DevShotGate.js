/**
 * DevShotGate.js — the ONE predicate for the dev net-shot surface
 * (`?shot=1` / `?shotauto=1`).
 *
 * Register item 20. Before this module the gate was written twice and
 * disagreed with itself:
 *
 *   - `main.js` installed the `__net*` surface on the *presence* of `shot`
 *     or `shotauto` (`get(…) === '1' || has(…)` — the `=== '1'` disjuncts
 *     dead code beside `has()`), so `?shot=0` installed all 42 dev globals
 *     while the comment said "gated by `?shot=1`".
 *   - `SceneManager.js` computed `preserveDrawingBuffer` WITHOUT the
 *     `shotauto` disjunct, so `?shotauto=1` alone installed the hooks with
 *     an unpreserved buffer — the state whose read-back warns
 *     `[netShot] canvas read-back looks empty`.
 *
 * The contract is the one the comments always stated: a parameter counts
 * ONLY at the exact value `1`. Bare `?shot`, `?shot=0`, `?shotauto=yes` —
 * presence of any other value — is NOT a request.
 *
 * Read **once** at module load so every consumer agrees (the ProfileFlags
 * idiom): the `main.js` install gate and the `SceneManager`
 * `preserveDrawingBuffer` read both consume `requested`, and the
 * auto-capture default consumes `shotautoRequested`. This singleton is also
 * the explicit opt-in seam register item 18 gates the `__lasso*` hooks
 * behind (item 18 CLOSED 2026-08-18 — the guard lives in LassoSystem.js,
 * not here).
 *
 * Safe off-browser (Node test runner): returns the all-defaults struct when
 * `window` / `URLSearchParams` is unavailable.
 *
 * @module core/DevShotGate
 */

/**
 * @typedef {object} DevShotGate
 * @property {boolean} shotRequested      — `?shot=1` exactly
 * @property {boolean} shotautoRequested  — `?shotauto=1` exactly
 * @property {boolean} requested          — either: install the surface AND preserve the buffer
 */

/**
 * Parse a query string into a frozen {@link DevShotGate}. The ONE parser —
 * the live singleton and the test seam both read it, so they cannot drift.
 * @param {string} search — query string including leading `?`
 * @returns {DevShotGate}
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

/**
 * Parse the live URL query string. Off-browser (Node test runner) or on any
 * parse failure, returns the all-defaults struct (the ProfileFlags idiom).
 * @returns {DevShotGate}
 */
function parseFromLocation() {
  if (typeof window === 'undefined' || typeof URLSearchParams === 'undefined') {
    return DEFAULTS;
  }
  try {
    return parse(window.location.search);
  } catch (_e) {
    return DEFAULTS;
  }
}

/**
 * Singleton, parsed at module load. All consumers import this constant
 * rather than re-parse the URL — ONE predicate, one parse, no drift.
 *
 * @type {DevShotGate}
 */
export const devShotGate = parseFromLocation();

/**
 * Test helper — drives deterministic query strings without mutating
 * `window.location`. Not part of the runtime API.
 *
 * @param {string} search — query string including leading `?`
 * @returns {DevShotGate}
 */
export function _parseForTest(search) {
  return parse(search);
}

export default devShotGate;
