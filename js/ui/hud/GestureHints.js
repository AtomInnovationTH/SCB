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
  Equal:          Object.freeze({ chip: 'PINCH → ZOOM',  phrase: 'pinch to zoom' }),
  Minus:          Object.freeze({ chip: 'PINCH → ZOOM',  phrase: 'pinch to zoom' }),
  NumpadAdd:      Object.freeze({ chip: 'PINCH → ZOOM',  phrase: 'pinch to zoom' }),
  NumpadSubtract: Object.freeze({ chip: 'PINCH → ZOOM',  phrase: 'pinch to zoom' }),
  PageUp:         Object.freeze({ chip: 'PINCH → FLOOR', phrase: 'pinch to change floor' }),
  PageDown:       Object.freeze({ chip: 'PINCH → FLOOR', phrase: 'pinch to change floor' }),
  KeyM:           Object.freeze({ chip: 'PINCH OUT → MAP', phrase: 'pinch out to the map' }),
  // Drawers — edge-band swipes (SPECS right, REFIT left).
  KeyI:   Object.freeze({ chip: 'SWIPE ← SPECS',  phrase: 'swipe in from the right edge for SPECS' }),
  KeyB:   Object.freeze({ chip: 'SWIPE → REFIT',  phrase: 'swipe in from the left edge for REFIT' }),
  Space:  Object.freeze({ chip: 'HOLD → ACT',     phrase: 'hold to act' }),
  Escape: Object.freeze({ chip: 'SWIPE → CLOSE',  phrase: 'swipe the drawer closed' }),
});

/** The module switch. OFF by default — desktop never consults the table. */
let _glass = false;

// The three prose token shapes. Each captures the ONE capital letter; the
// replacer keeps the original token when `Key<letter>` has no table row.
const RE_BRACKET = /\[([A-Z])\]/g;
const RE_PAREN   = /\(([A-Z])\)/g;
const RE_PRESS   = /\b([Pp])ress ([A-Z])\b/g;

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
   *   'KeyN' → 'KeyN'   'N' / 'n' → 'KeyN'   '7' → 'Digit7'   anything else unchanged.
   * @param {*} k
   * @returns {string}
   */
  static normalizeKey(k) {
    const s = String(k);
    if (s.length === 1) {
      if (/[A-Za-z]/.test(s)) return 'Key' + s.toUpperCase();
      if (/[0-9]/.test(s)) return 'Digit' + s;
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
   * @param {string} text
   * @returns {string}
   */
  static speak(text) {
    if (!_glass || typeof text !== 'string') return text;
    return text
      .replace(RE_BRACKET, (tok, letter) => {
        const row = TABLE['Key' + letter];
        return row ? '[' + row.chip + ']' : tok;
      })
      .replace(RE_PAREN, (tok, letter) => {
        const row = TABLE['Key' + letter];
        return row ? '(' + row.chip + ')' : tok;
      })
      .replace(RE_PRESS, (tok, p, letter) => {
        const row = TABLE['Key' + letter];
        if (!row) return tok;
        // The phrase takes the verb's case: "Press N" opens a sentence.
        return p === 'P' ? row.phrase.charAt(0).toUpperCase() + row.phrase.slice(1) : row.phrase;
      });
  }
}

export default GestureHints;
