/**
 * HudReboot.js — the "systems reboot" choreography after the FURNACE gag's
 * blackout (owner brief 2026-09-09: "flickers back to life at view 0 and
 * panels flicker in prioritized top to bottom with some random, the classic
 * 'took a hit, systems off line'"; plan
 * .kilo/plans/1788957399035-furnace-gag-v2.md §1.C, decisions 15–18).
 *
 * What it is: the veil lifts onto the BARE world — every visible HUD element
 * is dark — and the instruments return one by one, top → bottom with a little
 * jitter, each with a 320 ms relay flicker and a clack, the comms panel with
 * its own crackle, the SAFETY OVERRIDE button LAST. Then `onDone` fires and
 * the caller (OverridePane `_enterRecover`, Lane A) finishes the gag. The
 * camera, the game state and every pane's own visibility bit are untouched:
 * this module changes NOTHING but two class names on elements it found
 * on screen, and it strips them again on the way out.
 *
 * The contract (§1.14 / §1.17, duck-typed on both sides): `play({ onDone })
 * -> boolean` (false = nothing to do, the caller falls back to today's path),
 * `cancel()` (abort: classes stripped, no `onDone`), `isPlaying()`,
 * `dispose()`.
 *
 * The density law (the pane-density ladder, HUD.js): a pane's visibility is
 * ONE attribute the ladder owns, and the ladder's rule is `display: none
 * !important`. This module never writes `display`, never reads or writes the
 * ladder's attributes, and never names the two side columns — the overlay's
 * children are found generically (the columns are simply among them; darkening
 * a column darkens its panes). Opacity via CLASSES only:
 * `.hud-reboot-dark` (opacity 0, no pointer events, no transition) and
 * `.hud-reboot-in` (the keyframe flicker). A ladder-hidden pane has no client
 * rects, so it is never collected and never touched.
 *
 * The fake-DOM probe: SHOWN = `el.getClientRects().length > 0` — the same
 * probe the OverridePane rung uses, which a stub document can answer without
 * layout. Order = `getBoundingClientRect().top` (NaN / a throw reads as 0;
 * ties keep DOM order), then the LAST ids move to the end.
 *
 * The detached-timer law (OverridePane, the 2026-09-07 browser witness): the
 * injected `setTimeout` / `clearTimeout` are always CALLED DETACHED (`const f
 * = this._setTimeoutFn; f(cb, ms)`), never as a method of this object —
 * window.setTimeout throws "Illegal invocation" when its `this` is anything
 * but the window, and Node (which ignores `this`) would stay green.
 *
 * No colours: opacity only, so there is no palette here and NO import at all
 * (if a colour is ever wanted, VisualLaw is the one import allowed). Every dep
 * is optional and injected (doc / timers / random / reduced motion / audio) so
 * the whole choreography runs in Node on fake time. `doc: null` ⇒ inert.
 *
 * @module ui/hud/HudReboot
 */

export const HUD_REBOOT = Object.freeze({
  HOLD_MS: 600,       // the dark hold after the veil lifts: the world, no instruments
  STEP_MS: 140,       // the stagger between consecutive returns (top → bottom)
  JITTER_MS: 160,     // + random() * JITTER on every return ("some random")
  FLICKER_MS: 320,    // the relay flicker keyframe; the `in` class lives exactly this long
  LAST_GAP_MS: 400,   // the extra beat before each LAST id (the SAFETY OVERRIDE button)
});

export const REBOOT_STYLE_ID = 'hud-reboot-style';
export const REBOOT_DARK_CLASS = 'hud-reboot-dark';
export const REBOOT_IN_CLASS = 'hud-reboot-in';

/**
 * Chrome that lives OUTSIDE `#hud-overlay` (body-level strips, the ladder's
 * edge chrome, the corner stamp) and still has to go dark and come back.
 */
export const REBOOT_CHROME_IDS = Object.freeze([
  'hud-score-panel',
  'hud-hint-ticker',
  'notification-zone',
  'ladder-rail',
  'ladder-detail-slider',
  'ladder-library-tab',
  'build-stamp',
  'hud-discoveries',
  'hud-chip-orb',
  'arm-pilot-controls',
]);

/** These return LAST, in this order, `LAST_GAP_MS` after their slot. */
export const REBOOT_LAST_IDS = Object.freeze(['hud-override-pane']);

/** Never touched: the pause overlay and the gag's own DOM (the veil, the numerals, the vignette). */
export const REBOOT_SKIP_IDS = Object.freeze([
  'hud-pause-overlay',
  'hud-override-veil',
  'hud-override-countdown',
  'hud-override-vignette',
]);

// ── Private constants ──────────────────────────────────────────────────────────

const DEFAULT_OVERLAY_ID = 'hud-overlay';
const REDUCED_ATTR = 'data-hud-reboot-reduced';   // on the body while a reduced-motion run plays
const COMMS_ID = 'hud-comms-panel';               // the one return that also crackles
const KEYFRAMES = 'hud-reboot-in';

// ── Private helpers ────────────────────────────────────────────────────────────

/** @private The house matchMedia probe (OverridePane / RefitPane / FloorMask). */
function _prefersReducedMotion() {
  try {
    return !!(typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (_e) {
    return false;
  }
}

/** @private classList when present, else the className string (stub documents). */
function _addClass(el, c) {
  if (!el) return;
  if (el.classList && typeof el.classList.add === 'function') { el.classList.add(c); return; }
  const parts = String(el.className || '').split(/\s+/).filter(Boolean);
  if (!parts.includes(c)) parts.push(c);
  el.className = parts.join(' ');
}

/** @private */
function _removeClass(el, c) {
  if (!el) return;
  if (el.classList && typeof el.classList.remove === 'function') { el.classList.remove(c); return; }
  const parts = String(el.className || '').split(/\s+/).filter(Boolean).filter((p) => p !== c);
  el.className = parts.join(' ');
}

/** @private SHOWN: the element has at least one client rect (a hidden pane has none). Never throws. */
function _isShown(el) {
  if (!el || typeof el.getClientRects !== 'function') return false;
  try {
    const rects = el.getClientRects();
    return !!(rects && rects.length > 0);
  } catch (_e) {
    return false;
  }
}

/** @private The sort key: the element's top edge; NaN / a throw / no method ⇒ 0. */
function _topOf(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return 0;
  try {
    const r = el.getBoundingClientRect();
    const t = r ? Number(r.top) : NaN;
    return Number.isFinite(t) ? t : 0;
  } catch (_e) {
    return 0;
  }
}

/** @private The element's id as a string ('' when absent). */
function _idOf(el) {
  return (el && typeof el.id === 'string') ? el.id : '';
}

export class HudReboot {
  /**
   * @param {object} [deps] every dep optional, duck-typed, never trusted not to throw
   * @param {Document|null} [deps.doc] document (default: the global one; null = headless inert)
   * @param {function} [deps.setTimeout] injected timer (default: the global)
   * @param {function} [deps.clearTimeout] injected timer (default: the global)
   * @param {function} [deps.random] `() => [0, 1)` (default: Math.random)
   * @param {boolean|function} [deps.reducedMotion] override for the matchMedia probe
   * @param {object}   [deps.audio] `{ playRelayClack?(), playCommsCrackle?() }` (the AudioSystem singleton)
   * @param {string}   [deps.overlayId='hud-overlay'] the HUD overlay whose children are the panes
   * @param {string[]} [deps.chromeIds=REBOOT_CHROME_IDS] body-level chrome ids that also go dark
   */
  constructor(deps = {}) {
    this._doc = deps.doc !== undefined ? deps.doc
      : (typeof document !== 'undefined' ? document : null);
    // Timers: injected or the globals. Always CALLED DETACHED (see the header).
    this._setTimeoutFn = typeof deps.setTimeout === 'function' ? deps.setTimeout
      : (typeof setTimeout === 'function' ? (fn, ms) => setTimeout(fn, ms) : null);
    this._clearTimeoutFn = typeof deps.clearTimeout === 'function' ? deps.clearTimeout
      : (typeof clearTimeout === 'function' ? (id) => clearTimeout(id) : null);
    this._random = typeof deps.random === 'function' ? deps.random : Math.random;
    this._reducedDep = deps.reducedMotion;
    this._audio = deps.audio || null;
    this._overlayId = (typeof deps.overlayId === 'string' && deps.overlayId) ? deps.overlayId : DEFAULT_OVERLAY_ID;
    this._chromeIds = Array.isArray(deps.chromeIds) ? deps.chromeIds.slice() : REBOOT_CHROME_IDS.slice();

    this._timers = new Set();        // every pending timer id (cancel clears them all)
    this._touched = [];              // every element that got a class this run
    this._playing = false;
    this._remaining = 0;             // returns still to finish before onDone
    this._onDone = null;
    this._disposed = false;

    this._ensureStyle();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Start the choreography: darken every shown HUD element NOW, then return
   * them top → bottom on the stagger. A run already playing is cancelled
   * first (classes stripped, its `onDone` dropped).
   * @param {{onDone?: function}} [opts]
   * @returns {boolean} false when there is nothing to darken (headless, no
   *   overlay, everything hidden) — the caller falls back to its own path.
   */
  play(opts = {}) {
    if (this._disposed) return false;
    if (this._playing) this.cancel();
    const targets = this._collect();
    if (targets.length === 0) return false;
    this._ensureStyle();

    const reduced = this._reducedMotion();
    this._setReducedAttr(reduced);

    // Phase 1 — NOW: every target dark at once (the veil lifts onto the bare world).
    for (const el of targets) _addClass(el, REBOOT_DARK_CLASS);
    this._touched = targets.slice();
    this._playing = true;
    this._remaining = targets.length;
    this._onDone = (opts && typeof opts.onDone === 'function') ? opts.onDone : null;

    // Phase 2 — the return schedule, computed up front (one random() per target).
    const K = HUD_REBOOT;
    const lastSet = new Set(REBOOT_LAST_IDS);
    for (let i = 0; i < targets.length; i++) {
      const el = targets[i];
      let r = 0;
      try { r = Number(this._random()); } catch (_e) { r = 0; }
      if (!Number.isFinite(r)) r = 0;
      let at = K.HOLD_MS + i * K.STEP_MS + r * K.JITTER_MS;
      if (lastSet.has(_idOf(el))) at += K.LAST_GAP_MS;
      const scheduled = this._schedule(() => this._returnOne(el, reduced), at);
      if (scheduled == null) {
        // No timer seam (headless without a setTimeout): nothing can return —
        // undo the darkening rather than leave the HUD black.
        this.cancel();
        return false;
      }
    }
    return true;
  }

  /**
   * Abort: clear every timer, strip BOTH classes from every touched element,
   * forget `onDone` (it is NOT called). Idempotent; never throws.
   */
  cancel() {
    for (const id of this._timers) this._clearTimer(id);
    this._timers.clear();
    for (const el of this._touched) {
      _removeClass(el, REBOOT_DARK_CLASS);
      _removeClass(el, REBOOT_IN_CLASS);
    }
    this._touched = [];
    this._playing = false;
    this._remaining = 0;
    this._onDone = null;
  }

  /** @returns {boolean} a run is in flight (dark hold, returns, or the last flicker) */
  isPlaying() { return this._playing; }

  /** cancel() + forget the document; further `play()` calls return false. */
  dispose() {
    if (this._disposed) return;
    this.cancel();
    this._disposed = true;
    this._doc = null;
    this._audio = null;
  }

  // ── Collection ─────────────────────────────────────────────────────────────

  /**
   * @private The targets: the overlay's children + the chrome ids, de-duplicated
   * (first-seen order), minus the skip ids, SHOWN only, sorted by top (stable),
   * then the LAST ids moved to the end in `REBOOT_LAST_IDS` order.
   * @returns {object[]}
   */
  _collect() {
    const doc = this._doc;
    if (!doc || typeof doc.getElementById !== 'function') return [];
    const seen = new Set();
    const raw = [];
    const push = (el) => {
      if (!el || typeof el !== 'object' || seen.has(el)) return;
      seen.add(el);
      raw.push(el);
    };
    let overlay = null;
    try { overlay = doc.getElementById(this._overlayId); } catch (_e) { overlay = null; }
    const kids = overlay && overlay.children;
    if (kids && typeof kids.length === 'number') {
      for (let i = 0; i < kids.length; i++) push(kids[i]);
    }
    for (const id of this._chromeIds) {
      let el = null;
      try { el = doc.getElementById(id); } catch (_e) { el = null; }
      push(el);
    }
    const skip = new Set(REBOOT_SKIP_IDS);
    const shown = raw.filter((el) => !skip.has(_idOf(el)) && _isShown(el));
    // Stable sort by top: decorate with the DOM index so ties keep their order.
    const keyed = shown.map((el, i) => ({ el, i, top: _topOf(el) }));
    keyed.sort((a, b) => (a.top - b.top) || (a.i - b.i));
    const ordered = keyed.map((k) => k.el);
    const lastIds = REBOOT_LAST_IDS;
    const lasts = [];
    for (const id of lastIds) {
      for (const el of ordered) if (_idOf(el) === id) lasts.push(el);
    }
    const rest = ordered.filter((el) => !lasts.includes(el));
    return rest.concat(lasts);
  }

  // ── The return ─────────────────────────────────────────────────────────────

  /** @private One element comes back: dark off, `in` on, the clack (and the comms crackle), `in` off after FLICKER_MS. */
  _returnOne(el, reduced) {
    if (!this._playing) return;
    _removeClass(el, REBOOT_DARK_CLASS);
    _addClass(el, REBOOT_IN_CLASS);
    if (!reduced) this._audioCall('playRelayClack');
    if (_idOf(el) === COMMS_ID) this._audioCall('playCommsCrackle');
    const id = this._schedule(() => this._settleOne(el), HUD_REBOOT.FLICKER_MS);
    if (id == null) this._settleOne(el);
  }

  /** @private The flicker is over for this element; the last one ends the run. */
  _settleOne(el) {
    if (!this._playing) return;
    _removeClass(el, REBOOT_IN_CLASS);
    this._remaining -= 1;
    if (this._remaining <= 0) this._finish();
  }

  /** @private The run is over: forget the touched set, then `onDone` exactly once. */
  _finish() {
    const done = this._onDone;
    this._onDone = null;
    this._playing = false;
    this._remaining = 0;
    this._touched = [];
    for (const id of this._timers) this._clearTimer(id);
    this._timers.clear();
    if (typeof done === 'function') {
      try { done(); } catch (_e) { /* the caller's problem, never ours */ }
    }
  }

  // ── Sheet ──────────────────────────────────────────────────────────────────

  /**
   * @private One <style> per document, idempotent by id. `.hud-reboot-dark`
   * wins over inline opacity writes (!important) and freezes transitions so
   * the darkening is a snap; the pointer-events rule also covers descendants
   * that opt back in (the SAFETY OVERRIDE button is `auto` inside a `none`
   * root). `.hud-reboot-in` is the relay flicker; reduced motion (the media
   * query, or the body attribute this module writes when its dep says so)
   * turns the keyframe off and leaves a plain snap-on.
   */
  _ensureStyle() {
    const doc = this._doc;
    if (!doc || !doc.head || typeof doc.head.appendChild !== 'function' || typeof doc.createElement !== 'function') return;
    if (typeof doc.getElementById === 'function' && doc.getElementById(REBOOT_STYLE_ID)) return;
    const F = HUD_REBOOT.FLICKER_MS;
    const style = doc.createElement('style');
    style.id = REBOOT_STYLE_ID;
    style.textContent = `
      .${REBOOT_DARK_CLASS} { opacity: 0 !important; pointer-events: none !important; transition: none !important; }
      .${REBOOT_DARK_CLASS} * { pointer-events: none !important; }
      .${REBOOT_IN_CLASS} { animation: ${KEYFRAMES} ${F}ms linear both; }
      @keyframes ${KEYFRAMES} {
        0% { opacity: 0; }
        18% { opacity: 1; }
        30% { opacity: 0.1; }
        46% { opacity: 0.9; }
        58% { opacity: 0.25; }
        72% { opacity: 1; }
        84% { opacity: 0.7; }
        100% { opacity: 1; }
      }
      [${REDUCED_ATTR}] .${REBOOT_IN_CLASS} { animation: none; }
      @media (prefers-reduced-motion: reduce) { .${REBOOT_IN_CLASS} { animation: none; } }
    `;
    doc.head.appendChild(style);
  }

  /** @private `body[data-hud-reboot-reduced]` follows the reduced-motion answer at play() time (write-on-change). */
  _setReducedAttr(reduced) {
    const d = this._doc;
    const body = d && d.body;
    if (!body || typeof body.setAttribute !== 'function') return;
    const has = typeof body.hasAttribute === 'function' ? body.hasAttribute(REDUCED_ATTR) : null;
    if (reduced) {
      if (has !== true) body.setAttribute(REDUCED_ATTR, '');
    } else if (has !== false && typeof body.removeAttribute === 'function') {
      body.removeAttribute(REDUCED_ATTR);
    }
  }

  // ── Small seams ────────────────────────────────────────────────────────────

  /** @private A tracked timer (cancel clears it). Returns the id (null when there is no timer seam). */
  _schedule(fn, ms) {
    if (!this._setTimeoutFn) return null;
    let id = null;
    const wrapped = () => {
      if (id != null) this._timers.delete(id);
      if (this._disposed) return;
      try { fn(); } catch (_e) { /* choreography */ }
    };
    const setTimer = this._setTimeoutFn;                  // detached call (see the header)
    try {
      id = setTimer(wrapped, ms);
    } catch (_e) {
      return null;
    }
    if (id != null) this._timers.add(id);
    return id;
  }

  /** @private */
  _clearTimer(id) {
    if (id == null || !this._clearTimeoutFn) return;
    const clearTimer = this._clearTimeoutFn;              // detached call (see the header)
    try { clearTimer(id); } catch (_e) { /* timer */ }
  }

  /** @private A guarded, duck-typed audio call. */
  _audioCall(method) {
    const a = this._audio;
    try {
      if (a && typeof a[method] === 'function') a[method]();
    } catch (_e) { /* audio */ }
  }

  /** @private */
  _reducedMotion() {
    const d = this._reducedDep;
    if (typeof d === 'function') {
      try { return !!d(); } catch (_e) { return false; }
    }
    if (typeof d === 'boolean') return d;
    return _prefersReducedMotion();
  }
}
