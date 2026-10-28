/**
 * @module ui/GestureSplash — the first-run gesture MEMO: a 3 s splash naming ZOOM (pinch on glass, WHEEL on desktop)
 * once the intro lands on the flying floor. A memo, not a teaching card: no header, counter, SKIP chip or rows.
 * owner 2026-09-07: holding an iPad needs no teaching; pinch and hold do.
 *
 * Flow: shows on the first tick where `deps.floor()` reads 2 (null while the intro flyby / a ride is in flight) and
 * `deps.quiet()` is false (mission 1 waits for the 3rd catch so the arrival stays about the wings); records
 * `shownAt`; hides 3 s later or on the first player input (CAMERA_ZOOM_INPUT, HUD_TARGET_CLICK, LASSO_FIRED,
 * NET_FIRED). Before the show only a ZOOM input suppresses it. Either way the store is marked skipped ONCE, so
 * `isFirstRun()` reads false from then on. Hiding = 300 ms CSS fade (instant under reduced motion), then
 * `data-splash-done` + display none on the next update tick after the fade window (measured on `nowMs`).
 *
 * LIFECYCLE. The hub builds it for a FIRST RUN only (inside its LADDER gate); INERT (builds and subscribes
 * nothing) when `store.isFirstRun()` is false. Constructible headless: every dep optional, nothing thrown.
 *
 * Laws: DOM fonts through var(--font-mono) only; uppercase labels, 0.08 em letter-spacing; muted white/green from
 * VisualLaw; NO pictographic glyph (the arrow is written as an escape); no floor NAME; no layout reads; no
 * innerHTML; no timers / rAF; no window / document listeners; never reads Constants; no DOM at import time.
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { VisualLaw } from '../core/VisualLaw.js';
import { GestureHints } from './hud/GestureHints.js';

/** The root element id (the attention probe counts it as a transient). */
export const GESTURE_SPLASH_ID = 'hud-gesture-splash';

/** The injected stylesheet's id (one <style> per document). */
export const GESTURE_SPLASH_STYLE_ID = 'gesture-splash-style';

/** The column the splash rides in (as its LAST child). */
export const GESTURE_SPLASH_PARENT_ID = 'hud-left-column';

/** How long the memo stays once shown (by nowMs, no timer), ms. */
export const SPLASH_MS = 3000;

/** The fade window (in + out), ms; instant under reduced motion (CSS only). */
export const FADE_MS = 300;

/** The arrow literal, shared by the glass and desktop labels (one grammar). */
const ARROW = '\u2192';

/**
 * The row: ZOOM only (an N -> NET row would repeat the net chip). The glass label REUSES the GestureHints TABLE
 * chip; the desktop label names the key.
 *
 * @type {ReadonlyArray<Readonly<{glass:string, desktop:string}>>}
 */
export const ROWS = Object.freeze([
  // Equal / Minus name the HUD-pane ladder, so the pinch-zoom chip is the numpad zoom keys' row.
  Object.freeze({ glass: GestureHints.TABLE.NumpadAdd.chip, desktop: `WHEEL ${ARROW} ZOOM` }),
]);

/** The four bus witnesses; the FIRST one ends the memo (or suppresses it, before the show). */
const INPUT_EVENTS = Object.freeze([
  'CAMERA_ZOOM_INPUT', 'HUD_TARGET_CLICK', 'LASSO_FIRED', 'NET_FIRED',
]);

/** The fade-out toggle (set at hide; the done bit follows a fade window later). */
const HIDING_ATTR = 'data-splash-hiding';
/** The terminal bit (display none). */
const DONE_ATTR = 'data-splash-done';

export class GestureSplash {
  /**
   * @param {object} [deps]
   * @param {Document|null} [deps.doc]  document (default: the global one; null = headless).
   * @param {Element}  [deps.parent]     root's parent (default: doc.getElementById('hud-left-column')); appended LAST.
   * @param {boolean}  [deps.glass]      true ⇒ gesture labels (PINCH / HOLD); default false (WHEEL / N).
   * @param {function} [deps.now]        ms clock — used only when update() is called without nowMs.
   * @param {object}   [deps.store]      TouchMapStore (isFirstRun / markSkipped). Absent ⇒ first run, in-memory only.
   * @param {object|null} [deps.bus]     event bus with on(event, fn) → unsubscribe (default: eventBus; null ⇒ no bus witnesses).
   * @param {object}   [deps.events]     the Events name table (default: Events).
   * @param {function} [deps.floor]      () → the current floor (2 is the show floor; null while the intro / a ride is in flight).
   * @param {function} [deps.quiet]      () → true while the memo should wait (mission 1 before the 3rd catch). Absent ⇒ never quiet.
   */
  constructor(deps = {}) {
    this._doc = deps.doc !== undefined ? deps.doc
      : (typeof document !== 'undefined' ? document : null);
    this._glass = deps.glass === true;
    this._now = typeof deps.now === 'function' ? deps.now : null;
    this._store = (deps.store && typeof deps.store === 'object') ? deps.store : null;
    this._bus = deps.bus !== undefined ? deps.bus : eventBus;
    this._events = deps.events !== undefined ? deps.events : Events;
    this._floor = typeof deps.floor === 'function' ? deps.floor : null;
    this._quiet = typeof deps.quiet === 'function' ? deps.quiet : null;
    this._parent = deps.parent;

    this._root = null;
    this._unsubs = [];
    this._disposed = false;
    this._hidden = false;
    this._done = false;
    this._inert = !this._firstRun();              // not a first run: builds nothing, subscribes nothing, never ticks
    this._shownAt = null;                 // tick clock at reveal (null = not yet shown)
    this._hideAt = null;                  // a bus hide has no clock: stamped on the next update()

    if (!this._inert) this._subscribe();
  }

  /**
   * The per-frame tick: shows on the first tick where deps.floor() reads 2 (the root is built at reveal, so the
   * intro's frames never pop it), hides SPLASH_MS of nowMs later, then advances the fade to the done bit.
   * @param {number} [nowMs] the frame clock; falls back to deps.now(). No clock ⇒ no-op.
   */
  update(nowMs) {
    if (this._disposed || this._done || this._inert) return;
    let t = (nowMs == null || nowMs === '') ? NaN : Number(nowMs);   // null is unknown, never 0
    if (!Number.isFinite(t) && this._now) t = Number(this._now());
    if (!Number.isFinite(t)) return;

    // A hide in flight: after the fade window the node sleeps (done bit; no further DOM writes).
    if (this._hidden) {
      if (this._hideAt === null) { this._hideAt = t; return; }     // a bus hide: stamp at the next tick
      if (t - this._hideAt >= FADE_MS) this._finish();
      return;
    }

    if (this._shownAt === null) {
      const floor = this._readFloor();
      if (floor !== 2) return;
      if (this._readQuiet()) return;      // the wings are the job at the arrival: wait for a calm moment
      this._shownAt = t;
      this._build();
      return;
    }

    if (t - this._shownAt >= SPLASH_MS) this._hide(t);
  }

  /** Whether the memo is showing (revealed, not hiding, not disposed, not terminal). @returns {boolean} */
  isActive() {
    return !!this._root && !this._hidden && !this._disposed && !this._done;
  }

  /** Release every listener, remove the root; further calls no-op. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._unsubscribe();
    if (this._root && this._root.remove) {
      try { this._root.remove(); } catch (_e) { /* stub */ }
    }
    this._root = null;
  }

  /** @private Append the root as the LAST child of `parent` (headless: nothing). */
  _build() {
    const doc = this._doc;
    if (!doc || typeof doc.createElement !== 'function') return;
    const parent = this._parent || (doc.getElementById ? doc.getElementById(GESTURE_SPLASH_PARENT_ID) : null);
    if (!parent || typeof parent.appendChild !== 'function') return;
    this._ensureStyle();

    const mk = (tag, cls, text) => {
      const el = doc.createElement(tag);
      if (cls) el.className = cls;
      if (text != null) el.textContent = text;
      return el;
    };

    const root = mk('div', 'gs-splash');
    root.id = GESTURE_SPLASH_ID;
    for (const r of ROWS) {
      const row = mk('div', 'gs-row');
      const label = mk('span', 'gs-label', this._glass ? r.glass : r.desktop);
      row.appendChild(label);
      root.appendChild(row);
    }
    parent.appendChild(root);
    this._root = root;
  }

  /** @private The one <style id="gesture-splash-style"> (per document). No backdrop-filter. */
  _ensureStyle() {
    const doc = this._doc;
    if (!doc || !doc.head || (doc.getElementById && doc.getElementById(GESTURE_SPLASH_STYLE_ID))) return;
    const style = doc.createElement('style');
    style.id = GESTURE_SPLASH_STYLE_ID;
    style.textContent = `
      /* A faint plate in the house dark-cockpit grammar (no .hud-panel class:
       * the splash is a transient memo, not a pane — the attention budget's
       * "4 panels" counter never sees it). Muted white labels wash over the
       * world; the green hairline is the law's PLAYER at a low alpha. The
       * fade-in is a FINITE keyframe (plays on insertion — no rAF needed);
       * the fade-out is a transition driven by the hiding bit (300 ms, IR —
       * instant, both pure CSS). */
      #${GESTURE_SPLASH_ID} {
        display: flex;
        flex-direction: column;
        gap: 2px;
        box-sizing: border-box;
        padding: 8px 10px;
        background: rgba(5, 10, 20, 0.45);
        border: 1px solid rgba(0, 255, 136, 0.25);
        border-radius: 4px;
        font: 11px/1.4 var(--font-mono);
        font-variant-numeric: tabular-nums;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: ${VisualLaw.COLORS.LABEL};
        opacity: 1;
        user-select: none;
        -webkit-user-select: none;
        pointer-events: none;
        transition: opacity ${FADE_MS}ms ease;
        animation: gs-splash-in ${FADE_MS}ms ease-out;
      }
      @keyframes gs-splash-in {
        from { opacity: 0; }
        to   { opacity: 1; }
      }
      /* The fade-out: the hiding bit opens a 300 ms transition; the done bit
       * (a fade window later) is terminal: display none, no further writes. */
      #${GESTURE_SPLASH_ID}[${HIDING_ATTR}] { opacity: 0; }
      #${GESTURE_SPLASH_ID}[${DONE_ATTR}] { display: none !important; }
      #${GESTURE_SPLASH_ID} .gs-row {
        display: flex;
        align-items: center;
      }
      #${GESTURE_SPLASH_ID} .gs-label {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        opacity: 0.8;   /* "muted white": LABEL muted by opacity — never the law's full white */
      }
      /* The hairline wears the law's PLAYER; the text stays the muted white (no
       * other colour: a MEMO has no state to colour). */
      @media (prefers-reduced-motion: reduce) {
        #${GESTURE_SPLASH_ID} { animation: none; transition: none; }
      }
    `;
    doc.head.appendChild(style);
  }

  /** @private Exactly the four bus witnesses; the FIRST one ends the memo. */
  _subscribe() {
    const bus = this._bus;
    const E = this._events;
    if (!bus || typeof bus.on !== 'function' || !E) return;
    for (const name of INPUT_EVENTS) {
      const key = E[name];
      if (!key) continue;
      // Before the show only a ZOOM input suppresses (a player who already zoomed needs no zoom lesson);
      // after the show any input hides it.
      const onEvent = () => {
        if (this._shownAt === null && name !== 'CAMERA_ZOOM_INPUT') return;
        this._hide();
      };
      const off = bus.on(key, onEvent);
      if (typeof off === 'function') this._unsubs.push(off);
      else if (typeof bus.off === 'function') this._unsubs.push(() => bus.off(key, onEvent));
    }
  }

  /** @private Release every bus listener (at hide and at dispose). */
  _unsubscribe() {
    for (const off of this._unsubs) {
      try { off(); } catch (_e) { /* stub bus */ }
    }
    this._unsubs = [];
  }

  /** @private store.isFirstRun() guarded (no store ⇒ true; a throw ⇒ true:the splash may show). */
  _firstRun() {
    const s = this._store;
    if (!s || typeof s.isFirstRun !== 'function') return true;
    try { return s.isFirstRun() !== false; } catch (_e) { return true; }
  }

  /** @private The quiet getter guarded (absent / throwing ⇒ false - never blocks the show). */
  _readQuiet() {
    if (!this._quiet) return false;
    try { return this._quiet() === true; } catch (_e) { return false; }
  }

  /** @private The floor getter guarded (absent / throwing ⇒ null — never shows). */
  _readFloor() {
    if (!this._floor) return null;
    try {
      const v = this._floor();
      return v === undefined ? null : v;
    } catch (_e) {
      return null;
    }
  }

  /**
   * @private End the memo: the FIRST player input (bus, no clock) or the SPLASH_MS expiry (tick clock).
   * Marks the store skipped exactly once, releases the listeners, fades the root out (hiding bit).
   * @param {number} [t] the tick clock, null from a bus witness (stamped on the next update).
   */
  _hide(t) {
    if (this._hidden) return;
    this._hidden = true;
    this._unsubscribe();
    const s = this._store;
    if (s && typeof s.markSkipped === 'function') {
      try { s.markSkipped(); } catch (_e) { /* the store swallows its own storage faults */ }
    }
    this._hideAt = (t !== null && Number.isFinite(t)) ? t : null;
    if (this._root && this._root.setAttribute) {
      try { this._root.setAttribute(HIDING_ATTR, ''); } catch (_e) { /* stub element */ }
    }
  }

  /** @private The terminal bit: display none + stop (no further DOM writes). */
  _finish() {
    this._done = true;
    if (this._root && this._root.setAttribute) {
      try { this._root.setAttribute(DONE_ATTR, ''); } catch (_e) { /* stub element */ }
    }
  }
}

export default GestureSplash;