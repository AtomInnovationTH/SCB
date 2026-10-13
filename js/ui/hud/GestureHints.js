/**
 * GestureHints.js — the ONE key→gesture table, consulted at RENDER time
 * (Five-Floor iPad plan, Session J item 5 "Hints speak gesture on glass";
 * D-I two-thumb grammar).
 *
 * Every verb hint in the game names a KEY: the ticker's `keys: ['KeyN']`
 * chip, TargetAcquisition's "[N] net · [D] daughter" verb line, the stall
 * card's "Press N to launch the net.", MissionMilestones' `keys: ['M']`. On
 * a touch device the player has no keys, so the same hint must render its
 * GESTURE instead ("HOLD → NET", "TAP → SELECT", "PINCH → ZOOM"). The DATA
 * stays key-based everywhere (OnboardingDirector / TargetAcquisition /
 * LassoSystem / CodexSystem emit exactly what they emitted before); only the
 * presenters (HintTicker, TeachingOverlay) consult this table when they
 * paint, so desktop is byte-identical: with the switch off `chipFor` is
 * always null and `speak` returns the very string instance it was handed.
 *
 * Pure statics — no DOM, no eventBus, no Constants. The module switch
 * (`setGlass`) defaults OFF; the hub (main.js) flips it exactly once under
 * its `TouchControls.detect()` gate. Tests that turn it on MUST turn it back
 * off in a `finally` — the switch is process-global.
 *
 * Grammar of `speak(text)` on glass (idempotent — a rewritten string passes
 * through unchanged because no chip or phrase contains a lone bracketed /
 * parenthesised capital or a "Press X" token):
 *   `[N]`      → `[HOLD → NET]`                (bracketed single capital)
 *   `(N)`      → `(HOLD → NET)`                (parenthesised single capital)
 *   `Press N`  → `Hold the target for NET`     (word-bounded, single capital;
 *   `press N`  → `hold the target for NET`      the phrase takes the verb's case)
 * Letters without a table row (`[Q]`, `[K]` jettison, `(F)` forge, `(L)`
 * despin, `[V]` view) and everything else — lower-case letters, multi-key
 * tokens like `[1-4]` / `[Shift+R]`, digits — are left untouched.
 *
 * @module ui/hud/GestureHints
 */

/** @typedef {{ chip: string, phrase: string }} GestureRow */

/**
 * Key code → { chip, phrase }. `chip` is the ticker's key-chip text (short,
 * caps, an arrow from gesture to verb); `phrase` is the prose replacement for
 * a "Press X" sentence fragment. Frozen: rows are read at render time by
 * whoever paints a hint; nothing may edit them.
 * @type {Readonly<Record<string, Readonly<GestureRow>>>}
 */
const TABLE = Object.freeze({
  // Left thumb — act (long-press the selected target → radial verbs; NET and
  // DAUGHTER are hold-to-fire).
  KeyN:  Object.freeze({ chip: 'HOLD → NET',        phrase: 'hold the target for NET' }),
  KeyD:  Object.freeze({ chip: 'HOLD → DAUGHTER',   phrase: 'hold the target for DAUGHTER' }),
  KeyA:  Object.freeze({ chip: 'HOLD → AUTOPILOT',  phrase: 'hold the target for AUTOPILOT' }),
  KeyR:  Object.freeze({ chip: 'HOLD → REEL',       phrase: 'hold the target for REEL' }),
  KeyS:  Object.freeze({ chip: 'TAP EMPTY → SCAN',  phrase: 'tap empty space to scan' }),
  // Selection — ONE selection universe (HUD_TARGET_CLICK).
  Tab:   Object.freeze({ chip: 'TAP → SELECT',      phrase: 'tap a target to select it' }),
  KeyT:  Object.freeze({ chip: 'TAP → SELECT',      phrase: 'tap a target to select it' }),
  Enter: Object.freeze({ chip: 'TAP → SELECT',      phrase: 'tap a target to select it' }),
  // Right thumb — where / look.
  ArrowUp:        Object.freeze({ chip: 'DRAG → TURN',   phrase: 'drag to turn' }),
  ArrowDown:      Object.freeze({ chip: 'DRAG → TURN',   phrase: 'drag to turn' }),
  ArrowLeft:      Object.freeze({ chip: 'DRAG → TURN',   phrase: 'drag to turn' }),
  ArrowRight:     Object.freeze({ chip: 'DRAG → TURN',   phrase: 'drag to turn' }),
  Equal:          Object.freeze({ chip: '− / + → HUD PANES', phrase: 'fewer / more HUD panes' }),
  Minus:          Object.freeze({ chip: '− / + → HUD PANES', phrase: 'fewer / more HUD panes' }),
  NumpadAdd:      Object.freeze({ chip: 'PINCH → ZOOM',  phrase: 'pinch to zoom' }),
  NumpadSubtract: Object.freeze({ chip: 'PINCH → ZOOM',  phrase: 'pinch to zoom' }),
  PageUp:         Object.freeze({ chip: 'PINCH → FLOOR', phrase: 'pinch to change floor' }),
  PageDown:       Object.freeze({ chip: 'PINCH → FLOOR', phrase: 'pinch to change floor' }),
  KeyM:           Object.freeze({ chip: 'PINCH OUT → MAP', phrase: 'pinch out to the map' }),
  // The drawer — the right edge-band swipe (Session U: ONE workbench pane,
  // SPECS + the F1 REFIT block, on the RIGHT; the left band no longer opens
  // anything, so B (the shop) and I (the library) teach the same swipe).
  KeyI:   Object.freeze({ chip: 'SWIPE ← SPECS',  phrase: 'swipe in from the right edge for SPECS' }),
  KeyB:   Object.freeze({ chip: 'SWIPE ← SPECS',  phrase: 'swipe in from the right edge for SPECS' }),
  Space:  Object.freeze({ chip: 'HOLD → ACT',     phrase: 'hold to act' }),
  Escape: Object.freeze({ chip: 'SWIPE → CLOSE',  phrase: 'swipe the drawer closed' }),
  // w4-power D3 (2026-10-12): the two floor-1 workbench buttons the comms lines
  // name — the wings (`,`) and the radiator (O). On glass they are the F1 bar's
  // WINGS and RADIATORS buttons (pinch down to floor 1).
  Comma:  Object.freeze({ chip: 'FLOOR 1 → WINGS',      phrase: 'tap WINGS on floor 1' }),
  KeyO:   Object.freeze({ chip: 'FLOOR 1 → RADIATORS',  phrase: 'tap RADIATORS on floor 1' }),
});

/** The module switch. OFF by default — desktop never consults the table. */
let _glass = false;

// The three prose token shapes. Each captures the ONE key — a capital letter
// or (w4-power D3) a comma; the replacer keeps the original token when the
// key has no table row. A Press token also captures a trailing " to <verb>"
// so a phrase that already ends with it does not say it twice (D3: "Press S
// to scan" → "Tap empty space to scan", not "… to scan to scan"; the verb may
// be capitalised: "Press S to Scan." → "Tap empty space to Scan.").
const RE_BRACKET = /\[([A-Z,])\]/g;
const RE_PAREN   = /\(([A-Z,])\)/g;
const RE_PRESS   = /\b([Pp])ress (?:([A-Z])\b|(,)(?: \(the comma key\))?(?=\s|$))( to [A-Za-z]+\b)?/g;

/** @private `S` → 'KeyS', `,` → 'Comma'. */
function rowFor(ch) { return TABLE[ch === ',' ? 'Comma' : 'Key' + ch]; }

/** @private escape a literal for a RegExp. */
function reEscape(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export class GestureHints {
  /** @returns {Readonly<Record<string, Readonly<GestureRow>>>} the frozen table */
  static get TABLE() { return TABLE; }

  /**
   * Flip the module switch. The hub calls `setGlass(true)` once under its
   * `TouchControls.detect()` gate; nothing else in production touches it.
   * @param {boolean} on
   */
  static setGlass(on) { _glass = on === true; }

  /** @returns {boolean} whether hints currently render as gestures */
  static isGlass() { return _glass; }

  /**
   * Bring a hint's `keys[]` entry to the table's key-code spelling.
   *   'KeyN' → 'KeyN'   'N' / 'n' → 'KeyN'   '7' → 'Digit7'   ',' → 'Comma'   anything else unchanged.
   * @param {*} k
   * @returns {string}
   */
  static normalizeKey(k) {
    const s = String(k);
    if (s.length === 1) {
      if (/[A-Za-z]/.test(s)) return 'Key' + s.toUpperCase();
      if (/[0-9]/.test(s)) return 'Digit' + s;
      if (s === ',') return 'Comma';
    }
    return s;
  }

  /**
   * The gesture chip for a keyed hint, or null. ON glass: the chip of the
   * FIRST key that has a table row (a hint listing several keys names one
   * gesture). OFF glass: ALWAYS null — the caller falls through to its key
   * glyph, byte-identical.
   * @param {Array<string>|*} keys  the hint payload's `keys`
   * @returns {string|null}
   */
  static chipFor(keys) {
    if (!_glass) return null;
    if (!Array.isArray(keys)) return null;
    for (const k of keys) {
      const row = TABLE[GestureHints.normalizeKey(k)];
      if (row) return row.chip;
    }
    return null;
  }

  /**
   * Rewrite key tokens in prose as gestures. OFF glass (or for a non-string)
   * the SAME instance comes back — the presenter's `decorateGlossary` sees the
   * identical string. ON glass see the module header for the grammar.
   * Idempotent: `speak(speak(t)) === speak(t)`.
   *
   * w4-power D3 — two doubles are dropped, as general rules: a " to <verb>"
   * right after a Press token that its phrase already ends with, and a
   * " or [word] <object>" right after a phrase that names the same button
   * (object = the phrase minus its verb: "Press , or WINGS on floor 1" →
   * "Tap WINGS on floor 1").
   * @param {string} text
   * @returns {string}
   */
  static speak(text) {
    if (!_glass || typeof text !== 'string') return text;
    const used = [];
    let out = text
      .replace(RE_BRACKET, (tok, key) => {
        const row = rowFor(key);
        return row ? '[' + row.chip + ']' : tok;
      })
      .replace(RE_PAREN, (tok, key) => {
        const row = rowFor(key);
        return row ? '(' + row.chip + ')' : tok;
      })
      .replace(RE_PRESS, (tok, p, letter, comma, toVerb) => {
        const row = rowFor(letter || comma);
        if (!row) return tok;
        used.push(row.phrase);
        // The phrase takes the verb's case: "Press N" opens a sentence.
        let phrase = p === 'P' ? row.phrase.charAt(0).toUpperCase() + row.phrase.slice(1) : row.phrase;
        // The phrase already ends with that verb (any case): keep the OLD
        // text's spelling of it — "Press S to Scan." → "Tap empty space to
        // Scan." (w7-panes D1), "Press S to scan." → "… to scan.".
        if (toVerb) {
          if (row.phrase.toLowerCase().endsWith(toVerb.toLowerCase())) phrase = phrase.slice(0, phrase.length - toVerb.length) + toVerb;
          else phrase += toVerb;
        }
        return phrase;
      });
    for (const ph of used) {
      const obj = ph.slice(ph.indexOf(' ') + 1);
      const re = new RegExp('(' + reEscape(ph) + ') or (?:[A-Za-z]+ )?' + reEscape(obj) + '(?!\\w)', 'gi');
      out = out.replace(re, '$1');
    }
    return out;
  }
}

export default GestureHints;
