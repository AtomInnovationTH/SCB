/**
 * Typeface.js — the TYPEFACE LAW's JS mirror (Session R, plan D17 / §14.2, owner
 * 2026-09-08 — "Courier is generic. Sweep and polish."). Airbus A9 borrowed as a
 * practice: ONE aviation face on every surface, the same numbers in the same
 * width.
 *
 * This module is the PURE CORE — strings and one integer out, nothing in. No
 * DOM at import, no timers, no Constants, no imports (the VisualLaw class of
 * module). It exists because the house has TWO token surfaces:
 *
 *   DOM     — `font-family: var(--font-mono)` / `fontFamily: 'var(--font-mono)'`
 *             / `font: 11px var(--font-mono)`: the CSS token, resolved where CSS
 *             lives. DOM code never names a family and never imports this file.
 *   CANVAS  — a 2D context cannot resolve `var(--…)`, so every `ctx.font =`
 *             under js/ui + js/scene calls `mono(px, weight)` / `ui(px, weight)`
 *             (or a template over FONT_MONO / FONT_UI). Canvas code never writes
 *             a family string.
 *
 * FONT_MONO / FONT_UI equal the `index.html` `:root` tokens string-for-string
 * (test-Typeface reads the HTML), so the two surfaces cannot drift.
 *
 * THE EPOCH. Canvas text never triggers an `@font-face` fetch, and the Bold
 * faces are not preloaded, so a texture rasterised early (a MotherCallouts card,
 * the SDA chart) can keep the fallback face for the session. `loadFaces()` is
 * called ONCE by the hub as the first line of the boot; when every face has
 * settled — loaded OR failed — it bumps `fontEpoch` exactly once. A consumer
 * that KEEPS a rasterised texture stamps the epoch when it draws and compares
 * at its existing refresh point: a difference means "redraw once". Write-on-
 * change, no listener, no timer, no Event. The epoch means "the face question
 * is settled", not "B612 arrived" — a failed face means the fallback IS the
 * face, and a redraw is idempotent.
 *
 * Exceptions (owner calls 2026-09-08, each pinned by file:line in test-Fonts):
 * the sky text (planet captions `labelTexture.js` Helvetica, constellation names
 * `Starfield.js` Arial — system faces, present synchronously), the flag atlas
 * glyphs (`FlagDecalSystem.js`, artwork) and the menu's endonym stack
 * (`MenuScreen.js` `#menu-lang`).
 *
 * @module core/Typeface
 */

/** The mono token — equals `index.html` `:root { --font-mono }` string-for-string. */
export const FONT_MONO = "'B612 Mono', 'Courier New', monospace";

/** The UI token — equals `index.html` `:root { --font-ui }` string-for-string. */
export const FONT_UI = "'B612', 'Helvetica Neue', Arial, sans-serif";

/**
 * B612 Mono's advance width in em — the ONE metric for width ESTIMATES
 * (CityLabels' declutter boxes). Courier New was 0.60; every other canvas
 * width is measured live.
 */
export const MONO_ADVANCE_EM = 0.65;

/**
 * The four `@font-face` rules as `FontFaceSet.load()` descriptors — B612 Mono
 * 400 / 700 and B612 400 / 700 (the family ships those two weights only; a 600
 * or 500 request synthesises from the nearest, so the sweep writes 700 / 400).
 */
export const FACES = Object.freeze([
  "400 12px 'B612 Mono'",
  "700 12px 'B612 Mono'",
  "400 12px 'B612'",
  "700 12px 'B612'",
]);

// Two-level memo (weight → px → string) per family: `mono(11, 'bold')` returns
// the SAME string instance on every call, so per-frame `ctx.font = mono(…)`
// allocates nothing after warm-up (G1). The weight key is the literal the
// caller wrote ('bold' | 700 | 400 | undefined) — the shipped canvas strings
// carry `bold` or nothing and keep that literally.
const _memoMono = new Map();
const _memoUi = new Map();

function _font(memo, family, px, weight) {
  const wKey = (weight === undefined || weight === null || weight === '') ? '' : weight;
  let byPx = memo.get(wKey);
  if (!byPx) { byPx = new Map(); memo.set(wKey, byPx); }
  let s = byPx.get(px);
  if (s === undefined) {
    s = wKey === '' ? `${px}px ${family}` : `${wKey} ${px}px ${family}`;
    byPx.set(px, s);
  }
  return s;
}

/**
 * A canvas font string over the mono token.
 * @param {number} px font size in CSS px (the shipped instrument sizes, 7–22)
 * @param {'bold'|700|400|string|number} [weight] omitted → no weight (400)
 * @returns {string} e.g. `bold 14px 'B612 Mono', 'Courier New', monospace`
 */
export function mono(px, weight) {
  return _font(_memoMono, FONT_MONO, px, weight);
}

/**
 * A canvas font string over the UI token.
 * @param {number} px
 * @param {'bold'|700|400|string|number} [weight]
 * @returns {string} e.g. `700 40px 'B612', 'Helvetica Neue', Arial, sans-serif`
 */
export function ui(px, weight) {
  return _font(_memoUi, FONT_UI, px, weight);
}

/**
 * A monotonic integer: 0 at birth, +1 per `bump()`. Consumers that keep a
 * rasterised texture stamp `value()` when they draw and redraw once when it
 * differs. Tests construct their own so the document's is never bumped.
 */
export class FontEpoch {
  constructor() { this._v = 0; }
  /** @returns {number} the current epoch (0 until the faces settle) */
  value() { return this._v; }
  /** @returns {number} the new epoch */
  bump() { this._v += 1; return this._v; }
}

/** The document's epoch — the default every consumer reads. */
export const fontEpoch = new FontEpoch();

/**
 * Request the four faces explicitly so the canvas path no longer depends on a
 * DOM element happening to use each weight. Resolves when every face has
 * SETTLED (loaded or failed); bumps `epoch` EXACTLY ONCE in either outcome
 * (the consumers redraw with whatever face is now the truth). Headless (`fonts`
 * null / absent) → resolves `false` with NO bump: nothing was asked, nothing
 * settled, no redraw is owed.
 *
 * @param {{ load: function(string): Promise<Array> }|null} fonts the document's
 *   FontFaceSet (the hub passes `document.fonts`), or null off-DOM
 * @param {FontEpoch} [epoch=fontEpoch]
 * @returns {Promise<boolean>} true when every `load()` resolved a non-empty
 *   array (the face is usable), false otherwise
 */
export function loadFaces(fonts, epoch = fontEpoch) {
  if (!fonts || typeof fonts.load !== 'function') return Promise.resolve(false);
  // Each request is started inside its own promise chain so a synchronous
  // throw on the Nth face becomes that face's rejection — every face is
  // observed by the Promise.all below and none is orphaned (review pass 2).
  const all = Promise.all(FACES.map((d) => Promise.resolve().then(() => fonts.load(d))));
  return all
    .then((results) => results.every((r) => Array.isArray(r) && r.length > 0))
    .catch(() => false)
    .then((ok) => { epoch.bump(); return ok; });
}
