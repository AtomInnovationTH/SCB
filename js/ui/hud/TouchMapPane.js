/**
 * TouchMapPane.js — the first-run TOUCH MAP (glass) / KEY MAP (desktop)
 * checklist card (Session N onboarding for glass + intro, 2026-09-06; Ipad.md
 * §5.5 / §5.8: "One verb per card; advance ONLY on the witnessed real input —
 * never on a timer; glow comes from the live signal").
 *
 * The workbench's first beat. A first-time player lands on floor 1 with the
 * flying lessons (the OnboardingDirector's beats) deferred to the ride up; this
 * card names the six inputs of the grammar and ticks each one the moment the
 * player performs it — open REFIT, open SPECS, ride up, zoom, select, net. Six
 * fixed rows (the frozen `ROWS` table) in that order; rows may complete out of
 * order (a witness ticks its own row whenever it fires); the CURRENT row is the
 * first not-done row and wears the SkillsPane attention pulse when it changes
 * (a finite CSS keyframe, 2 iterations, restarted by moving a data attribute —
 * never a perpetual loop). Marks: `✓` done in the law's PLAYER green, `→`
 * current, `○` upcoming (dim). A footer counts `n / 6` and carries the ONE
 * tappable element, the SKIP chip (44 pt on glass, the five touch rules).
 *
 * Glass labels REUSE GestureHints.TABLE's chips where a row maps 1:1 to a key
 * (KeyB / KeyI / Equal / Tab / KeyN); the ride row has its own words (the rail
 * drag has no key chip). Desktop labels name the key.
 *
 * WITNESSES. Bus: `Events.CAMERA_ZOOM_INPUT` → zoom, `Events.TARGET_SELECTED`
 * → select, `Events.LASSO_FIRED` or `Events.NET_FIRED` → net — exactly four
 * subscriptions through the injected `bus` (default: the eventBus singleton),
 * event-rate, no hot path. Polled, inside `update(nowMs)` at <= 1 Hz
 * (`TICK_MS`): `deps.refitOpen()` true → refit, `deps.libraryOpen()` true →
 * specs, `deps.floor()` differing from the floor observed on the pane's FIRST
 * tick → ride (any floor change). Every getter is read defensively (absent /
 * throwing → unknown, no tick).
 *
 * LIFECYCLE. The hub constructs the pane every boot (inside its LADDER gate);
 * the pane is INERT — builds nothing, subscribes nothing — when
 * `store.isFirstRun()` is false. Otherwise it appends itself as the LAST child
 * of `#hud-left-column` (deps.parent default) and shows on every floor (it is
 * NOT a pane-density rung and NOT in FloorMask). Each row completion is
 * written to the store at once (write-on-change is the store's job); SKIP
 * marks the record skipped and hides the card; all six done → the card lingers
 * `DONE_LINGER_MS` (measured on the `nowMs` passed to update, no timers) then
 * hides. Hiding = `data-touch-map-done` on the root + display none via the
 * injected style; the listeners are released at hide (the card is terminal);
 * `isActive()` reads false; no DOM is written while hidden.
 *
 * Laws: DOM fonts through var(--font-mono) only; tabular numerals; no
 * pictographic glyph (✓ → ○ are the allowed Dingbat / Arrows / Geometric
 * blocks, written as escapes); no floor NAME anywhere; no layout reads; no
 * innerHTML; no timers / rAF (timing from nowMs); no window / document
 * listeners (the chip's own click handler and the bus subscription are the
 * two allowed edges); never reads Constants; never touches the DOM at import
 * time; constructible headless (no document, no storage: every dep optional,
 * every method callable, nothing thrown).
 *
 * @module ui/hud/TouchMapPane
 */

import { eventBus } from '../../core/EventBus.js';
import { Events } from '../../core/Events.js';
import { VisualLaw } from '../../core/VisualLaw.js';
import { GestureHints } from './GestureHints.js';
import { TOUCH_MAP_ROW_IDS } from '../../systems/TouchMapStore.js';

/** The root element id. */
export const TOUCH_MAP_ID = 'hud-touch-map';

/** The injected stylesheet's id (one <style>, injected once per document). */
export const TOUCH_MAP_STYLE_ID = 'touch-map-style';

/** The column the card rides in (its LAST child). */
export const TOUCH_MAP_PARENT_ID = 'hud-left-column';

/** The poll floor: update(nowMs) accepts one tick per TICK_MS (<= 1 Hz). */
export const TICK_MS = 1000;

/** How long the completed card stays before it hides (by nowMs). */
export const DONE_LINGER_MS = 3000;

/** The chip's glass hit box (Apple HIG 44 pt) and the desktop chip height. */
export const CHIP_GLASS_PX = 44;
export const CHIP_DESKTOP_PX = 24;

/** The header word per surface. */
export const HEADER_GLASS = 'TOUCH MAP';
export const HEADER_DESKTOP = 'KEY MAP';

/** The SKIP chip's label. */
export const SKIP_LABEL = 'SKIP';

/** The three marks (escapes: U+2713 check, U+2192 arrow, U+25CB circle). */
export const MARK_DONE = '\u2713';
export const MARK_CURRENT = '\u2192';
export const MARK_UPCOMING = '\u25cb';

const ARROW = '\u2192';                          // → (Arrows, allowed)
const TABLE = GestureHints.TABLE;

/**
 * ROWS — the six fixed rows in the map's order. `glass` / `desktop` are the
 * labels per surface; `witness` says how the row completes: `poll` reads the
 * named dep getter on the 1 Hz tick (`refitOpen` / `libraryOpen` true;
 * `floor` changed since the first tick), `bus` completes on any of the named
 * Events keys. The ids ARE TouchMapStore.TOUCH_MAP_ROW_IDS (pinned).
 * @type {ReadonlyArray<Readonly<{id:string, glass:string, desktop:string, witness:Readonly<object>}>>}
 */
export const ROWS = Object.freeze([
  Object.freeze({ id: 'refit', glass: TABLE.KeyB.chip, desktop: `B ${ARROW} REFIT`,
    witness: Object.freeze({ kind: 'poll', dep: 'refitOpen' }) }),
  Object.freeze({ id: 'specs', glass: TABLE.KeyI.chip, desktop: `I ${ARROW} SPECS`,
    witness: Object.freeze({ kind: 'poll', dep: 'libraryOpen' }) }),
  Object.freeze({ id: 'ride', glass: `DRAG THE RAIL ${ARROW} RIDE UP`, desktop: `PAGE UP ${ARROW} RIDE UP`,
    witness: Object.freeze({ kind: 'poll', dep: 'floor' }) }),
  Object.freeze({ id: 'zoom', glass: TABLE.Equal.chip, desktop: `WHEEL ${ARROW} ZOOM`,
    witness: Object.freeze({ kind: 'bus', events: Object.freeze(['CAMERA_ZOOM_INPUT']) }) }),
  Object.freeze({ id: 'select', glass: TABLE.Tab.chip, desktop: `CLICK ${ARROW} SELECT`,
    witness: Object.freeze({ kind: 'bus', events: Object.freeze(['TARGET_SELECTED']) }) }),
  Object.freeze({ id: 'net', glass: TABLE.KeyN.chip, desktop: `N ${ARROW} NET`,
    witness: Object.freeze({ kind: 'bus', events: Object.freeze(['LASSO_FIRED', 'NET_FIRED']) }) }),
]);

/** The terminal hide bit on the root (skip or completion). */
const DONE_ATTR = 'data-touch-map-done';
/** glass | desktop on the root (drives the chip geometry). */
const SURFACE_ATTR = 'data-tm-surface';
/** done | current | upcoming on a row. */
const STATE_ATTR = 'data-tm-state';
/** The attention pulse: present on the row that just became current (moved on change). */
const PULSE_ATTR = 'data-tm-pulse';

export class TouchMapPane {
  /**
   * @param {object} [deps]
   * @param {Document|null} [deps.doc]  document (default: the global one; null = headless).
   * @param {Element}  [deps.parent]     root's parent (default: doc.getElementById('hud-left-column')); appended LAST.
   * @param {boolean}  [deps.glass]      true ⇒ TOUCH MAP with gesture labels and the 44 pt chip; default false (KEY MAP).
   * @param {function} [deps.now]        ms clock — used only when update() is called without nowMs.
   * @param {object}   [deps.store]      TouchMapStore (isFirstRun / done / markDone / markSkipped). Absent ⇒ first run, in-memory only.
   * @param {object|null} [deps.bus]     event bus with on(event, fn) → unsubscribe (default: eventBus; null ⇒ no bus witnesses).
   * @param {object}   [deps.events]     the Events name table (default: Events).
   * @param {function} [deps.floor]      () → the current floor (any comparable value); a change since the first tick ⇒ ride.
   * @param {function} [deps.refitOpen]  () → boolean, the REFIT drawer is open.
   * @param {function} [deps.libraryOpen] () → boolean, the SPECS drawer is open.
   */
  constructor(deps = {}) {
    this._doc = deps.doc !== undefined ? deps.doc
      : (typeof document !== 'undefined' ? document : null);
    this._glass = deps.glass === true;
    this._now = typeof deps.now === 'function' ? deps.now : null;
    this._store = (deps.store && typeof deps.store === 'object') ? deps.store : null;
    this._bus = deps.bus !== undefined ? deps.bus : eventBus;
    this._events = deps.events !== undefined ? deps.events : Events;
    this._getters = {
      floor: typeof deps.floor === 'function' ? deps.floor : null,
      refitOpen: typeof deps.refitOpen === 'function' ? deps.refitOpen : null,
      libraryOpen: typeof deps.libraryOpen === 'function' ? deps.libraryOpen : null,
    };

    this._root = null;
    this._el = null;                 // { header, rows: Map<id, {row, mark, label}>, count, chip }
    this._unsubs = [];
    this._disposed = false;
    this._hidden = false;

    // The model. The store is consulted once: first run? then the rows it
    // already holds (a previous session's ✓ marks seed the card).
    const firstRun = this._firstRun();
    this._done = new Set(this._storeDone());
    this._current = null;            // the id wearing the pulse (write-on-change against it)
    this._lastMs = null;             // last accepted tick
    this._floor0 = undefined;        // the floor seen on the first tick (undefined = not yet observed)
    this._completeAt = null;         // nowMs the sixth row landed (linger start)
    this._completePending = false;   // a bus witness completed the map: stamp on the next update()

    if (firstRun) {
      this._build(deps.parent);
      if (this._root) {
        this._subscribe();
        this._paint();
      }
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * The tick (the hub calls it per drawn frame; it accepts one poll per
   * TICK_MS). Stamps a pending completion, hides after the linger, then reads
   * the three polled witnesses and paints on change.
   * @param {number} [nowMs] the frame clock; falls back to deps.now(). No clock ⇒ no-op.
   */
  update(nowMs) {
    if (this._disposed || !this._root || this._hidden) return;
    let t = Number(nowMs);
    if (!Number.isFinite(t) && this._now) t = Number(this._now());
    if (!Number.isFinite(t)) return;

    // The linger rides every frame's clock (two compares, no DOM, no read).
    if (this._completePending) { this._completePending = false; this._completeAt = t; }
    if (this._completeAt !== null) {
      if (t - this._completeAt >= DONE_LINGER_MS) this._hide();
      return;
    }

    if (this._lastMs !== null && t - this._lastMs < TICK_MS) return;
    this._lastMs = t;

    const refit = this._read('refitOpen');
    if (refit === true) this._witness('refit', t);
    const library = this._read('libraryOpen');
    if (library === true) this._witness('specs', t);
    const floor = this._read('floor');
    if (floor !== null && typeof floor !== 'object' && typeof floor !== 'function') {
      // A primitive floor value (the hub passes ladderController.currentFloor(), a number).
      if (this._floor0 === undefined) this._floor0 = floor;
      else if (floor !== this._floor0) this._witness('ride', t);
    }
    this._paint();
  }

  /** Whether the card is showing (built, not hidden, not disposed). @returns {boolean} */
  isActive() {
    return !!this._root && !this._hidden && !this._disposed;
  }

  /**
   * The state per row, ROWS order: `{ id, done, current }` — `current` is true
   * on exactly the first not-done row while the card is active (none when all
   * six are done, hidden, or inert). Fresh objects every call.
   * @returns {Array<{id:string, done:boolean, current:boolean}>}
   */
  rows() {
    const cur = this.isActive() ? this._firstNotDone() : null;
    return ROWS.map((r) => ({ id: r.id, done: this._done.has(r.id), current: r.id === cur }));
  }

  /** The SKIP: record it (the store) and hide the card. Idempotent; a no-op when not showing. */
  skip() {
    if (!this.isActive()) return;
    const s = this._store;
    if (s && typeof s.markSkipped === 'function') {
      try { s.markSkipped(); } catch (_e) { /* private mode — the store swallows; a stub's bug is not the pane's */ }
    }
    this._hide();
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
    this._el = null;
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  /** @private Inject the style once, build the DOM as the LAST child of `parent` (headless: nothing). */
  _build(parentDep) {
    const doc = this._doc;
    if (!doc || typeof doc.createElement !== 'function') return;
    const parent = parentDep || (doc.getElementById ? doc.getElementById(TOUCH_MAP_PARENT_ID) : null);
    if (!parent || typeof parent.appendChild !== 'function') return;
    this._ensureStyle();

    const mk = (tag, cls, text) => {
      const el = doc.createElement(tag);
      if (cls) el.className = cls;
      if (text != null) el.textContent = text;
      return el;
    };

    const root = mk('div', 'hud-panel');
    root.id = TOUCH_MAP_ID;
    // The column's other panes override .hud-panel's absolute the same way.
    root.style.position = 'relative';
    root.style.boxSizing = 'border-box';
    root.style.pointerEvents = 'none';           // display-only but for the chip (pointer-events: auto)
    root.setAttribute(SURFACE_ATTR, this._glass ? 'glass' : 'desktop');

    const header = mk('div', 'tm-header', this._glass ? HEADER_GLASS : HEADER_DESKTOP);
    root.appendChild(header);

    const list = mk('div', 'tm-rows');
    const rows = new Map();
    for (const r of ROWS) {
      const row = mk('div', 'tm-row');
      row.setAttribute('data-tm-id', r.id);
      const mark = mk('span', 'tm-mark', MARK_UPCOMING);
      const label = mk('span', 'tm-label', this._glass ? r.glass : r.desktop);
      row.appendChild(mark); row.appendChild(label);
      list.appendChild(row);
      rows.set(r.id, { row, mark, label });
    }
    root.appendChild(list);

    const foot = mk('div', 'tm-foot');
    const count = mk('span', 'tm-count', '');
    const chip = mk('button', 'tm-chip', SKIP_LABEL);
    if (chip.setAttribute) { chip.setAttribute('type', 'button'); chip.setAttribute('tabindex', '-1'); }
    foot.appendChild(count); foot.appendChild(chip);
    root.appendChild(foot);

    parent.appendChild(root);
    if (chip.addEventListener) chip.addEventListener('click', () => this.skip());

    this._root = root;
    this._el = { header, rows, count, chip };
  }

  /** @private The one <style id="touch-map-style"> (per document). No backdrop-filter. */
  _ensureStyle() {
    const doc = this._doc;
    if (!doc || !doc.head || (doc.getElementById && doc.getElementById(TOUCH_MAP_STYLE_ID))) return;
    const style = doc.createElement('style');
    style.id = TOUCH_MAP_STYLE_ID;
    style.textContent = `
      /* The house HUD grammar rides in from .hud-panel (the mono token, the
       * dark 0.95 plate, the green hairline); the card sets its own size. The
       * column is 260 px wide; the longest glass label (DRAG THE RAIL → RIDE
       * UP, 25 characters) fits one row at 11 px B612 Mono (~6.6 px advance). */
      #${TOUCH_MAP_ID} {
        display: flex;
        flex-direction: column;
        flex: 0 0 auto;
        box-sizing: border-box;
        padding: 6px 8px;
        font: 11px/1.3 var(--font-mono);
        font-variant-numeric: tabular-nums;
        color: ${VisualLaw.COLORS.PLAYER};
        white-space: nowrap;
        overflow: hidden;
        pointer-events: none;
        user-select: none;
        -webkit-user-select: none;
      }
      /* The terminal bit: skipped or completed (after the linger). */
      #${TOUCH_MAP_ID}[${DONE_ATTR}] { display: none !important; }
      #${TOUCH_MAP_ID} .tm-header {
        font-size: 10px;
        font-variant-caps: small-caps;
        letter-spacing: 0.12em;
        opacity: 0.6;
        margin-bottom: 4px;
      }
      #${TOUCH_MAP_ID} .tm-rows { display: flex; flex-direction: column; gap: 2px; }
      #${TOUCH_MAP_ID} .tm-row {
        display: grid;
        grid-template-columns: 16px 1fr;
        gap: 6px;
        align-items: center;
        min-height: 20px;
        padding: 1px 4px;
        border-left: 2px solid transparent;
        border-radius: 2px;
      }
      #${TOUCH_MAP_ID}[${SURFACE_ATTR}="glass"] .tm-row { min-height: 24px; }
      #${TOUCH_MAP_ID} .tm-mark { text-align: center; font-weight: bold; }
      #${TOUCH_MAP_ID} .tm-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      /* Upcoming: dim. */
      #${TOUCH_MAP_ID} .tm-row[${STATE_ATTR}="upcoming"] { color: rgba(160, 160, 160, 0.55); }
      #${TOUCH_MAP_ID} .tm-row[${STATE_ATTR}="upcoming"] .tm-mark { color: rgba(120, 120, 120, 0.6); }
      /* Done: the law's positive colour on the check; the row settles dim after
       * a 3 s linger (a finite fill-mode animation — no timer, no loop). */
      #${TOUCH_MAP_ID} .tm-row[${STATE_ATTR}="done"] { color: rgba(140, 220, 160, 0.85); animation: tm-fade-done ${DONE_LINGER_MS}ms ease forwards; }
      #${TOUCH_MAP_ID} .tm-row[${STATE_ATTR}="done"] .tm-mark { color: ${VisualLaw.COLORS.PLAYER}; }
      @keyframes tm-fade-done {
        0%   { opacity: 1;    background: rgba(0, 255, 136, 0.15); }
        80%  { opacity: 1;    background: rgba(0, 255, 136, 0.05); }
        100% { opacity: 0.45; background: transparent; }
      }
      /* Current: the steady accent border + faint tint (the SkillsPane checklist affordance). */
      #${TOUCH_MAP_ID} .tm-row[${STATE_ATTR}="current"] {
        color: ${VisualLaw.COLORS.INFO};
        font-weight: 600;
        border-left-color: ${VisualLaw.COLORS.INFO};
        background: rgba(0, 204, 255, 0.08);
      }
      #${TOUCH_MAP_ID} .tm-row[${STATE_ATTR}="current"] .tm-mark { color: ${VisualLaw.COLORS.INFO}; }
      /* The attention pulse plays only on step CHANGE: the attribute moves to
       * the row that just became current, so the FINITE animation (2
       * iterations) starts fresh there and never loops. */
      #${TOUCH_MAP_ID} .tm-row[${PULSE_ATTR}] { animation: tm-pulse 1.4s ease-in-out 2; }
      @keyframes tm-pulse {
        0%, 100% { opacity: 0.78; }
        50%      { opacity: 1; }
      }
      @media (prefers-reduced-motion: reduce) {
        #${TOUCH_MAP_ID} .tm-row[${PULSE_ATTR}] { animation: none; opacity: 1; }
        #${TOUCH_MAP_ID} .tm-row[${STATE_ATTR}="done"] { animation: none; opacity: 0.45; }
      }
      #${TOUCH_MAP_ID} .tm-foot {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        margin-top: 6px; padding-top: 4px;
        border-top: 1px solid rgba(0, 255, 136, 0.2);
      }
      #${TOUCH_MAP_ID} .tm-count { font-size: 10px; opacity: 0.7; }
      /* The ONE tappable element: the CargoPane .cargo-btn shape; 24 px on the
       * desktop, 44 pt on glass with the five touch rules. */
      #${TOUCH_MAP_ID} .tm-chip {
        font: bold 10px/1.2 var(--font-mono);
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: ${VisualLaw.COLORS.PLAYER};
        background: rgba(0, 255, 136, 0.08);
        border: 1px solid rgba(0, 255, 136, 0.55);
        border-radius: 3px;
        padding: 0 10px;
        min-height: ${CHIP_DESKTOP_PX}px;
        cursor: pointer;
        pointer-events: auto;
        touch-action: manipulation;
        user-select: none;
        -webkit-user-select: none;
        -webkit-tap-highlight-color: transparent;
        -webkit-touch-callout: none;
        transition: background 0.15s ease, border-color 0.15s ease;
      }
      #${TOUCH_MAP_ID}[${SURFACE_ATTR}="glass"] .tm-chip { min-height: ${CHIP_GLASS_PX}px; min-width: ${CHIP_GLASS_PX}px; }
      #${TOUCH_MAP_ID} .tm-chip:hover { background: rgba(0, 255, 136, 0.18); border-color: ${VisualLaw.COLORS.PLAYER}; }
      #${TOUCH_MAP_ID} .tm-chip:active { background: rgba(0, 255, 136, 0.35); color: #ffffff; }
      #${TOUCH_MAP_ID} .tm-chip:focus { outline: none; }
    `;
    doc.head.appendChild(style);
  }

  /** @private Exactly the four bus witnesses (CAMERA_ZOOM_INPUT, TARGET_SELECTED, LASSO_FIRED, NET_FIRED). */
  _subscribe() {
    const bus = this._bus;
    const E = this._events;
    if (!bus || typeof bus.on !== 'function' || !E) return;
    for (const r of ROWS) {
      if (r.witness.kind !== 'bus') continue;
      for (const key of r.witness.events) {
        const name = E[key];
        if (!name) continue;
        const onEvent = () => this._witness(r.id, null);
        const off = bus.on(name, onEvent);
        if (typeof off === 'function') this._unsubs.push(off);
        else if (typeof bus.off === 'function') this._unsubs.push(() => bus.off(name, onEvent));
      }
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

  /** @private store.isFirstRun() guarded (no store ⇒ true; a throw ⇒ true: the map shows). */
  _firstRun() {
    const s = this._store;
    if (!s || typeof s.isFirstRun !== 'function') return true;
    try { return s.isFirstRun() !== false; } catch (_e) { return true; }
  }

  /** @private store.done() guarded: the known ids already witnessed (a previous session). */
  _storeDone() {
    const s = this._store;
    if (!s || typeof s.done !== 'function') return [];
    try {
      const list = s.done();
      return Array.isArray(list) ? list.filter((id) => TOUCH_MAP_ROW_IDS.includes(id)) : [];
    } catch (_e) {
      return [];
    }
  }

  /** @private A polled getter read: absent / throwing / undefined ⇒ null (unknown). */
  _read(name) {
    const fn = this._getters[name];
    if (!fn) return null;
    try {
      const v = fn();
      return v === undefined ? null : v;
    } catch (_e) {
      return null;
    }
  }

  // ── Model ──────────────────────────────────────────────────────────────────

  /** @private The first not-done row id in ROWS order, or null when all six are done. */
  _firstNotDone() {
    for (const r of ROWS) if (!this._done.has(r.id)) return r.id;
    return null;
  }

  /**
   * @private A witnessed row: record it (the store writes on change), paint,
   * and on the sixth start the linger (`t` = the tick clock; null from a bus
   * witness ⇒ stamped on the next update()).
   */
  _witness(id, t) {
    if (this._disposed || this._hidden || this._done.has(id)) return;
    this._done.add(id);
    const s = this._store;
    if (s && typeof s.markDone === 'function') {
      try { s.markDone(id); } catch (_e) { /* the store swallows its own storage faults; a stub's bug is not the pane's */ }
    }
    if (this._done.size >= ROWS.length && this._completeAt === null) {
      if (t !== null && Number.isFinite(t)) this._completeAt = t;
      else this._completePending = true;
    }
    if (t === null) this._paint();                 // a bus witness paints at event time; a poll paints at the tick's end
  }

  /** @private The terminal hide: the bit, the listeners, no further DOM writes. */
  _hide() {
    if (this._hidden) return;
    this._hidden = true;
    this._unsubscribe();
    this._setFlag(this._root, DONE_ATTR, true);
  }

  // ── Paint (write-on-change) ────────────────────────────────────────────────

  /** @private Marks, states, the pulse (moved on a current-row CHANGE), the count. */
  _paint() {
    const el = this._el;
    if (!el || !this._root || this._hidden || this._disposed) return;
    const cur = this._firstNotDone();
    for (const r of ROWS) {
      const cell = el.rows.get(r.id);
      if (!cell) continue;
      const done = this._done.has(r.id);
      const state = done ? 'done' : (r.id === cur ? 'current' : 'upcoming');
      this._setAttr(cell.row, STATE_ATTR, state);
      this._setText(cell.mark, done ? MARK_DONE : (state === 'current' ? MARK_CURRENT : MARK_UPCOMING));
    }
    if (cur !== this._current) {
      // The pulse moves: off the old current, onto the new one (a fresh start
      // of the finite keyframe on a different element — never a loop).
      const prev = this._current !== null ? el.rows.get(this._current) : null;
      if (prev) this._setFlag(prev.row, PULSE_ATTR, false);
      const next = cur !== null ? el.rows.get(cur) : null;
      if (next) this._setFlag(next.row, PULSE_ATTR, true);
      this._current = cur;
    }
    this._setText(el.count, `${this._done.size} / ${ROWS.length}`);
  }

  /** @private */
  _setText(el, text) {
    if (!el || el.textContent === text) return false;
    el.textContent = text;
    return true;
  }

  /** @private */
  _setAttr(el, name, value) {
    if (!el || !el.setAttribute) return false;
    const have = el.getAttribute ? el.getAttribute(name) : undefined;
    if (have === value) return false;
    el.setAttribute(name, value);
    return true;
  }

  /** @private A boolean attribute: present when `on`, absent otherwise. */
  _setFlag(el, name, on) {
    if (!el || !el.setAttribute || !el.hasAttribute) return false;
    const have = el.hasAttribute(name);
    if (have === !!on) return false;
    if (on) el.setAttribute(name, '');
    else el.removeAttribute(name);
    return true;
  }
}

export default TouchMapPane;
