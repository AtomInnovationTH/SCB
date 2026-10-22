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
  // Left thumb — the turn pad (lower left); the rest of the glass looks (2026-10-20).
  ArrowUp:        Object.freeze({ chip: 'PAD → TURN',    phrase: 'use the turn pad' }),
  ArrowDown:      Object.freeze({ chip: 'PAD → TURN',    phrase: 'use the turn pad' }),
  ArrowLeft:      Object.freeze({ chip: 'PAD → TURN',    phrase: 'use the turn pad' }),
  ArrowRight:     Object.freeze({ chip: 'PAD → TURN',    phrase: 'use the turn pad' }),
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
let _chipLineListener = null;   // u11 R3: TouchActionChip hears which action keys a stored comms line named

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

/**
 * u11 D4: the four action keys whose touch chip is a floor-2/3 button (TouchActionChip / the step chips), by the
 * label that button carries. Comms lines on glass name the button instead of the key.
 * @type {Readonly<Record<string,string>>}
 */
const CHIP_LABELS = Object.freeze({ N: 'LAUNCH NET', D: 'SEND DAUGHTER', A: 'AUTOPILOT', S: 'SCAN', R: 'REEL' });
const LETGO_LABEL = 'LET GO';      // u14b B1: K - the one button that lets the catch at the collar go
const READ_LABEL = 'READ MORE';    // u14b B2: I - the full-screen library (the SPECS tab opens a different view)
const RE_PAD_CHIP = /\b([Pp])ress N to stick the pad on\b/g;   // the daughter's pad tool: its own button
const RE_NEXT_CHIP = /\b([Pp])ress T for next target\b/g;   // no chip: a tap on the piece itself selects it
// u14b R1: the reminder lines whose key / mouse gesture HAS a touch control, worded for it on glass (no chip: the control is the
// glass itself). "Press T to pick the next target." -> "Tap a piece to pick the next target."; "Scroll to zoom." -> "Pinch to zoom.";
// "Use the arrow keys to turn." -> "Use the turn pad to turn." ("Drag to look around." is true on glass as it stands).
const RE_PICK_CHIP = /\b([Pp])ress T to pick the next target\b/g;
const RE_ZOOM_WORDS = /\b([Ss])croll to zoom\b/g;
const RE_ARROW_WORDS = /\b([Uu])se the arrow keys to turn\b/g;
const RE_PRESS_CHIP = /\b([Pp])ress ([NDASR])\b( to [A-Za-z]+\b)?/g;
// u14b B1/B2: K lets the catch go, I reads more. Their tails say what the button already says, so they are dropped:
// "Press K to let it go." -> "Tap LET GO."; "or press K to let the catch go." -> "or tap LET GO.";
// "Press I to read more." / "Press I to read the specs." -> "Tap READ MORE.".
const RE_LETGO_CHIP = /\b([Pp])ress K\b( to let (?:it|the catch) go\b)?/g;
const RE_READ_CHIP = /\b([Pp])ress I\b( to (?:read more|read the specs|open Info)\b)?/g;

/**
 * u14b B3: the skill reminders (SKILLS.CATALOG, OnboardingDirector `remind_<skillId>`) whose key has a touch button, so the
 * line can name it on glass: S, N, the daughter's tool, D, A (action chips) and I (READ MORE). Must equal the keys of
 * TouchActionChip.REMINDER_KIND (a test ties them). Every other reminder that names a key or a mouse gesture (V, 7, 1-4, X,
 * Shift S / R / 1-3 / +/-, period, ; ', Scroll, Drag) has no touch control, so on glass it is not posted.
 */
export const GLASS_REMINDER_SKILLS = Object.freeze(['scan_quick', 'collect_lasso', 'arm_pilot_capture', 'collect_deploy', 'nav_autopilot', 'manage_codex']);

/**
 * u14b R1: the reminders whose key / mouse gesture has a touch control but no chip: they ARE posted on glass, in touch words
 * (`chipPhrase`: nav_target, nav_zoom, nav_arrows; nav_rotate's "Drag to look around." is already true on glass). Kept apart from
 * GLASS_REMINDER_SKILLS, which a test ties to TouchActionChip.REMINDER_KIND.
 */
export const GLASS_TOUCH_WORD_SKILLS = Object.freeze(['nav_target', 'nav_zoom', 'nav_rotate', 'nav_arrows']);

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
   * u11 D4: comms text on glass. "Press N / D / A / S" becomes "Tap LAUNCH NET / SEND DAUGHTER / AUTOPILOT / SCAN"
   * (case of the verb and the punctuation after it kept; a " to <verb>" that repeats the whole button name is
   * dropped: "Press S to scan" -> "Tap SCAN"). Other key names ("[K]", Esc, Tab) are left as they are. OFF glass or
   * for a non-string the SAME value comes back, so desktop text is byte-identical. This is NOT `speak`: its N/D/A rows
   * name the long-press radial, which is not what the chip does.
   * @param {string} text
   * @returns {string}
   */
  static chipPhrase(text) {
    if (!_glass || typeof text !== 'string') return text;
    return text.replace(RE_PAD_CHIP, (tok, p) => (p === 'P' ? 'Tap' : 'tap') + ' STICK PAD')
      .replace(RE_NEXT_CHIP, (tok, p) => (p === 'P' ? 'Tap' : 'tap') + ' a piece to pick the next target')
      .replace(RE_PICK_CHIP, (tok, p) => (p === 'P' ? 'Tap' : 'tap') + ' a piece to pick the next target')
      .replace(RE_ZOOM_WORDS, (tok, s) => (s === 'S' ? 'Pinch' : 'pinch') + ' to zoom')
      .replace(RE_ARROW_WORDS, (tok, u) => (u === 'U' ? 'Use' : 'use') + ' the turn pad to turn')
      .replace(RE_LETGO_CHIP, (tok, p) => (p === 'P' ? 'Tap ' : 'tap ') + LETGO_LABEL)
      .replace(RE_READ_CHIP, (tok, p) => (p === 'P' ? 'Tap ' : 'tap ') + READ_LABEL)
      .replace(RE_PRESS_CHIP, (tok, p, letter, toVerb) => {
      const label = CHIP_LABELS[letter];
      const lead = (p === 'P' ? 'Tap ' : 'tap ') + label;
      if (!toVerb) return lead;
      const verb = toVerb.slice(4).toLowerCase();
      // "Press R to reel her home" keeps its verb: "Tap REEL her home" would read like a command to the button.
      return (label.toLowerCase() === verb && letter !== 'R') ? lead : lead + toVerb;
    });
  }

  /**
   * u11 R3: which chips a line's "Press N/D/A/S/R/K/I" (and the pad line) asks for, in reading order, as chip kinds
   * ('net'|'pad'|'daughter'|'autopilot'|'scan'|'reel'|'letgo'|'read'). Pure (not glass-gated): the same tokens `chipPhrase` rewrites.
   * @param {string} text
   * @returns {string[]}
   */
  static chipKinds(text) {
    if (typeof text !== 'string') return [];
    const found = [];
    const KIND = { N: 'net', D: 'daughter', A: 'autopilot', S: 'scan', R: 'reel' };
    const rest = text.replace(RE_PAD_CHIP, (tok, p, off) => { found.push([off, 'pad']); return ' '.repeat(tok.length); });
    rest.replace(RE_PRESS_CHIP, (tok, p, letter, toVerb, off) => { found.push([off, KIND[letter]]); return tok; });
    rest.replace(RE_LETGO_CHIP, (tok, p, tail, off) => { found.push([off, 'letgo']); return tok; });
    rest.replace(RE_READ_CHIP, (tok, p, tail, off) => { found.push([off, 'read']); return tok; });
    return found.sort((a, b) => a[0] - b[0]).map(f => f[1]);
  }

  /**
   * u14b B3: may a stale-skill reminder for this skill be posted now? Desktop: always. Glass: only when the skill has no key
   * (label-only reminder) or its key has a touch button (GLASS_REMINDER_SKILLS); a reminder that tells a touch player to
   * press V, 7, X or Shift S would name a key they do not have.
   * @param {{id?:string, key?:(string|null)}} def  the SKILLS.CATALOG entry
   * @param {string} [skillId]  the reminder's skill id (when the entry carries none)
   * @returns {boolean}
   */
  static reminderFitsGlass(def, skillId) {
    if (!_glass) return true;
    if (!def || !def.key) return true;
    const id = def.id || skillId;
    return GLASS_REMINDER_SKILLS.includes(id) || GLASS_TOUCH_WORD_SKILLS.includes(id);
  }

  /**
   * u11 R3: the ONE place a stored comms line is reported to the touch chip. The comms store calls this with the
   * line it just stored; on glass, when the line named an action key, the registered listener gets the chip kinds.
   * Desktop: nothing happens. No listener: nothing happens.
   * @param {string} text  the line as emitted (before `chipPhrase`)
   */
  static noteChipLine(text) {
    if (!_glass || !_chipLineListener) return;
    const kinds = GestureHints.chipKinds(text);
    if (kinds.length) { try { _chipLineListener(kinds, text); } catch (_e) { /* a listener must not break comms */ } }
  }

  /** u11 R3: register (or clear with null) the one listener for `noteChipLine` (TouchActionChip). */
  static setChipLineListener(fn) { _chipLineListener = (typeof fn === 'function') ? fn : null; }

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
