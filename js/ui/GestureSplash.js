/**
 * GestureSplash.js — the first-run gesture MEMO: two lines, one gesture each,
 * a 3 s splash that names PINCH and HOLD on glass (WHEEL and N on the
 * desktop) after the intro lands on the flying floor, then gets out of
 * the way (Session O, plan D4, owner 2026-09-07: "holding an iPad
 * needs no teaching; pinch and hold do"). It replaces the six-row TOUCH MAP /
 * KEY MAP checklist card (js/ui/hud/TouchMapPane.js, deleted in the same
 * commit) in the hub's exact wiring slot — but it is a MEMO, not a
 * teaching card: no header, no counter, no SKIP chip, no rows ticking.
 *
 * The splash omits a player WHO ALREADY DID the grammar: it SHOWS on the
 * first tick where `deps.floor()` reads 2 (the getter returns null while
 * the intro flyby is in flight / a ride is riding — so the splash lands only
 * after the intro settled on F2), records `shownAt`, and hides 3 s later
 * OR on the FIRST player input — witnessed on the bus exactly like the retired
 * card did (CAMERA_ZOOM_INPUT, HUD_TARGET_CLICK, LASSO_FIRED, NET_FIRED);
 * a pre-show input suppresses the show outright (a player who already
 * pinched needs no teaching) — either way the store is marked skipped ONCE,
 * so `isFirstRun()` reads false from there on and a returning player never
 * sees it again. Hiding = a 300 ms CSS fade through the injected style
 * (instant under reduced motion), then `data-splash-done` + display none
 * on the NEXT update tick after the fade window — measured on the `nowMs`
 * passed to update, no timer; nobody removes the node.
 *
 * LIFECYCLE. The hub constructs the splash for a FIRST RUN only (inside its
 * LADDER gate; a veteran's boot builds nothing); the splash is INERT —
 * builds nothing, subscribes nothing — when `store.isFirstRun()` is false.
 *
 * Laws (the retired TouchMapPane header's, Session O amendment): DOM
 * fonts through var(--font-mono) only; tabular numerals; uppercase small
 * labels, 0.08 em letter-spacing; muted white/green from VisualLaw
 * (LABEL muted by opacity for the labels, PLAYER for the hairline); NO
 * pictographic glyph (the arrow is the allowed Arrows block, written as an
 * escape); no floor NAME anywhere; no layout reads; no innerHTML; no
 * timers / rAF (timing from the nowMs passed to update); no window /
 * document listeners (the four bus subscriptions are the only edges); never
 * reads Constants; never touches the DOM at import time; constructible
 * headless (no document, no storage: every dep optional, every method
 * callable, nothing thrown).
 *
 * @module ui/GestureSplash
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { VisualLaw } from '../core/VisualLaw.js';
import { GestureHints } from './hud/GestureHints.js';

/** The root element id (the attention probe counts it as a transient). */
export const GESTURE_SPLASH_ID = 'hud-gesture-splash';

/** The injected stylesheet's id (one <style>, injected once per document). */
export const GESTURE_SPLASH_STYLE_ID = 'gesture-splash-style';

/** The column the splash rides in (its LAST child, the retired card's slot). */
export const GESTURE_SPLASH_PARENT_ID = 'hud-left-column';

/** How long the memo stays once shown (by nowMs, no timer). */
export const SPLASH_MS = 3000;

/** The fade window (in + out) — the show fades in via a finite keyframe, the
 *  hide fades out via a transition; instant under reduced motion (CSS only). */
export const FADE_MS = 300;

/** The arrow literal, shared by the glass and desktop labels (one grammar). */
const ARROW = '\u2192';

/**
 * The two rows, one gesture each — the glass labels REUSE GestureHints
 * TABLE's chips (the retired card's 1:1 rows; the desktop labels name
 * the key). Frozen: read at build time, nothing may edit them.
 *
 * @type {ReadonlyArray<Readonly<{glass:string, desktop:string}>>}
 */
export const ROWS = Object.freeze([
  Object.freeze({ glass: GestureHints.TABLE.Equal.chip,  desktop: `WHEEL ${ARROW} ZOOM` }),
  Object.freeze({ glass: GestureHints.TABLE.KeyN.chip,   desktop: `N ${ARROW} NET` }),
]);

/** The four bus witnesses (the retired card's four; the FIRST one witnessed
 *  ends the memo (or suppresses it outright, before the show). */
const INPUT_EVENTS = Object.freeze([
  'CAMERA_ZOOM_INPUT', 'HUD_TARGET_CLICK', 'LASSO_FIRED', 'NET_FIRED',
]);

/** The fade-out toggle (set at hide; the done bit follows a fade window later). */
const HIDING_ATTR = 'data-splash-hiding';
/** The terminal bit (display none; written on the tick after the fade window). */
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
    this._parent = deps.parent;

    this._root = null;
    this._unsubs = [];
    this._disposed = false;
    this._hidden = false;
    this._done = false;
    this._inert = !this._firstRun();              // not a first run: builds nothing, subscribes nothing, never ticks
    this._shownAt = null;                 // the tick clock the reveal landed (null = not yet shown)
    this._hideAt = null;                  // a bus hide has no clock: stamped on the next update()

    if (!this._inert) this._subscribe();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * The per-frame tick (the hub calls it once per drawn frame). It shows on
   * the first tick where deps.floor() reads 2 (nothing before — the root is
   * built at reveal, so the intro's frames never pop it), records shownAt,
   * hides SPLASH_MS of nowMs later, and — after a hide — advances the fade
   * to its done bit (the tick after the window, measured on nowMs; nothing
   * further is written).
   * @param {number} [nowMs] the frame clock; falls back to deps.now(). No clock ⇒ no-op.
   */
  update(nowMs) {
    if (this._disposed || this._done || this._inert) return;
    let t = (nowMs == null || nowMs === '') ? NaN : Number(nowMs);   // null is unknown, never 0 (the retired card's rule)
    if (!Number.isFinite(t) && this._now) t = Number(this._now());
    if (!Number.isFinite(t)) return;

    // A hide in flight: after the fade window the node sleeps (done bit, display
    // none; no further DOM writes anywhere).
    if (this._hidden) {
      if (this._hideAt === null) { this._hideAt = t; return; }     // a bus hide: stamp at the next tick
      if (t - this._hideAt >= FADE_MS) this._finish();
      return;
    }

    if (this._shownAt === null) {
      const floor = this._readFloor();
      if (floor !== 2) return;
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

  // ── Show / hide ────────────────────────────────────────────────────────────

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
      const onEvent = () => this._hide();
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

  // ── Reads (every one guarded) ──────────────────────────────────────────────

  /** @private store.isFirstRun() guarded (no store ⇒ true; a throw ⇒ true:the splash may show). */
  _firstRun() {
    const s = this._store;
    if (!s || typeof s.isFirstRun !== 'function') return true;
    try { return s.isFirstRun() !== false; } catch (_e) { return true; }
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

  // ── Terminal ────────────────────────────────────────────────────────────────

  /**
   * @private End the memo: the FIRST player input (bus, no clock) or the
   * SPLASH_MS expiry (the tick clock). The store is marked skipped exactly
   * once (isFirstRun reads false from here on; the hub's gate closes — a
   * returning player never sees it again); the listeners are released; the
   * root fades out (hiding bit; the done bit follows a fade window later).
   * @param {number} [t] the tick clock, null from a bus witness (stamped on the next update).
   */
  _hide(t) {
    if (this._hidden) return;
    this._hidden = true;
    this._unsubscribe();
    const s = this._store;
    if (s && typeof s.markSkipped === 'function') {
      try { s.markSkipped(); } catch (_e) { /* the store swallows its own storage faults;a stub's bug is not the splash's */ }
    }
    this._hideAt = (t !== null && Number.isFinite(t)) ? t : null;
    if (this._root && this._root.setAttribute) {
      try { this._root.setAttribute(HIDING_ATTR, ''); } catch (_e) { /* stub element */ }
    }
  }

  /** @private The terminal bit: display none + stop (no further DOM writes anywhere). */
  _finish() {
    this._done = true;
    if (this._root && this._root.setAttribute) {
      try { this._root.setAttribute(DONE_ATTR, ''); } catch (_e) { /* stub element */ }
    }
  }
}

export default GestureSplash;