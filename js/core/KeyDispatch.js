/**
 * KeyDispatch.js — the ONE way a UI button acts: it presses the key.
 *
 * Session J (iPad grammar, D-I): touch / click affordances never call game
 * systems directly. They synthesise the SAME keydown → keyup pair the physical
 * keyboard produces and dispatch it on `window`, where InputManager binds its
 * listeners (InputManager.start(): window.addEventListener('keydown'|'keyup'))
 * and never filters `isTrusted`. One key path per verb: the FLEET pane's
 * DEPLOY button and the D key are indistinguishable downstream — the same
 * refusal comms, the same tutorial events, the same audio click, the same
 * toggle-off semantics (`_handleArmKey`). Nothing to keep in sync.
 *
 * Node-safe: without a KeyboardEvent constructor or a target (test runner,
 * headless), `pressKey` returns false and dispatches nothing.
 *
 * @module core/KeyDispatch
 */

/**
 * Derive the `key` value InputManager-adjacent listeners may read from a
 * `code`: 'KeyD' → 'd', 'Digit1' → '1', anything else → the code itself
 * (InputManager switches on `e.code`, so `key` is a courtesy, not a contract).
 * @param {string} code - KeyboardEvent.code ('KeyD', 'Digit1', 'Space', …)
 * @returns {string}
 */
export function keyForCode(code) {
  const c = String(code ?? '');
  if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(c)) return c.slice(5);
  return c;
}

/**
 * Press one key: dispatch a synthetic `keydown` then the matching `keyup` on
 * `target` (default `window`). Both events bubble and are cancelable so the
 * receiving handlers' `preventDefault()` calls behave as they do for real
 * keystrokes.
 *
 * @param {string} code - KeyboardEvent.code, e.g. 'KeyD', 'KeyR', 'Digit1'.
 * @param {{ shiftKey?: boolean, target?: EventTarget }} [opts]
 * @returns {boolean} true when both events were dispatched; false when there
 *   is no target or no KeyboardEvent constructor (Node / headless).
 */
export function pressKey(code, { shiftKey = false, target } = {}) {
  if (!code) return false;
  const tgt = target !== undefined
    ? target
    : (typeof window !== 'undefined' ? window : undefined);
  if (!tgt || typeof tgt.dispatchEvent !== 'function') return false;
  if (typeof KeyboardEvent !== 'function') return false;

  const init = { code, key: keyForCode(code), bubbles: true, cancelable: true, shiftKey: !!shiftKey };
  tgt.dispatchEvent(new KeyboardEvent('keydown', init));
  tgt.dispatchEvent(new KeyboardEvent('keyup', init));
  return true;
}
