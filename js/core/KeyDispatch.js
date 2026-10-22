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
 * Split a press string into the KeyboardEvent `code` and its modifier. A ticker step chip (and any other caller that
 * passes one string) can say 'Shift+KeyS' for a wide scan: u15a A-T2, the lesson's WIDE SCAN button presses Shift+S
 * exactly as the keyboard does. A plain code ('KeyS') comes back unchanged.
 * @param {string} press - 'KeyS' or 'Shift+KeyS'
 * @returns {{ code: string, shiftKey: boolean }}
 */
export function parseKeyPress(press) {
  const s = String(press ?? '');
  const i = s.lastIndexOf('+');
  // A bare '+' is not a combo (nothing sends one); 'Shift+Equal' is. Only the Shift modifier is spoken.
  if (i <= 0 || i === s.length - 1) return { code: s, shiftKey: false };
  const mods = s.slice(0, i).split('+').map((m) => m.trim().toLowerCase());
  return { code: s.slice(i + 1).trim(), shiftKey: mods.includes('shift') };
}

function _target(target) {
  const tgt = target !== undefined
    ? target
    : (typeof window !== 'undefined' ? window : undefined);
  if (!tgt || typeof tgt.dispatchEvent !== 'function') return null;
  if (typeof KeyboardEvent !== 'function') return null;
  return tgt;
}

/**
 * Press one key: dispatch a synthetic `keydown` then the matching `keyup` on
 * `target` (default `window`). Both events bubble and are cancelable so the
 * receiving handlers' `preventDefault()` calls behave as they do for real
 * keystrokes.
 *
 * @param {string} code - KeyboardEvent.code, e.g. 'KeyD', 'KeyR', 'Digit1'. 'Shift+KeyS' presses S with Shift held
 *   (u15a: the WIDE SCAN button); an explicit `opts.shiftKey: true` does the same for a plain code.
 * @param {{ shiftKey?: boolean, target?: EventTarget }} [opts]
 * @returns {boolean} true when both events were dispatched; false when there
 *   is no target or no KeyboardEvent constructor (Node / headless).
 */
export function pressKey(code, { shiftKey = false, target } = {}) {
  if (!code) return false;
  const parsed = parseKeyPress(code);
  const tgt = _target(target);
  if (!tgt) return false;

  const init = { code: parsed.code, key: keyForCode(parsed.code), bubbles: true, cancelable: true, shiftKey: !!shiftKey || parsed.shiftKey };
  tgt.dispatchEvent(new KeyboardEvent('keydown', init));
  tgt.dispatchEvent(new KeyboardEvent('keyup', init));
  return true;
}

/**
 * Hold a key down: dispatch ONLY the `keydown`. InputManager sets `keys[code] = true` on it and keeps it set until the
 * matching `keyup` (`releaseKey`), so a held-key reader (the de-spin laser reads `keys['KeyL']` every frame) sees the key
 * down for the whole hold. u15a A-T3: the DE-SPIN button holds KeyL for as long as a finger is down. The caller owns
 * the release: every path that ends the hold must call `releaseKey` with the same code.
 * @param {string} code - KeyboardEvent.code
 * @param {{ shiftKey?: boolean, target?: EventTarget }} [opts]
 * @returns {boolean} true when the keydown was dispatched
 */
export function holdKey(code, { shiftKey = false, target } = {}) {
  if (!code) return false;
  const tgt = _target(target);
  if (!tgt) return false;
  tgt.dispatchEvent(new KeyboardEvent('keydown', { code, key: keyForCode(code), bubbles: true, cancelable: true, shiftKey: !!shiftKey }));
  return true;
}

/**
 * Let a held key go: dispatch the `keyup` that matches `holdKey`. Safe to call when the key is not down (InputManager
 * just sets `keys[code] = false` again).
 * @param {string} code - KeyboardEvent.code
 * @param {{ shiftKey?: boolean, target?: EventTarget }} [opts]
 * @returns {boolean} true when the keyup was dispatched
 */
export function releaseKey(code, { shiftKey = false, target } = {}) {
  if (!code) return false;
  const tgt = _target(target);
  if (!tgt) return false;
  tgt.dispatchEvent(new KeyboardEvent('keyup', { code, key: keyForCode(code), bubbles: true, cancelable: true, shiftKey: !!shiftKey }));
  return true;
}
