/**
 * WorkbenchPane.js — Session U: the ONE workbench drawer — SPECS + the F1
 * REFIT block in one right-side pane (plan
 * .kilo/plans/1788954873769-one-workbench-pane.md, owner 2026-09-09; docs/
 * ladder/08-workbench.md §2 "Session U — ONE workbench pane (layout)";
 * 01-numbers.md "Workbench panes").
 *
 * LINEAGE. Every line of chrome here is lifted verbatim-with-rename from the
 * two drawers it replaces, so the numbers and the laws are the shipped ones:
 *   - Wave 5 Session B (LibraryPane): the self-contained lazily-built pane,
 *     the slide (PANE_SLIDE_MS), the idle fade to 70 % (IDLE_FADE_*), the tab
 *     count + the ONCE-per-rise pulse (TAB_PULSE_MS), the reduced-motion
 *     probe (the FloorMask.js house matchMedia shape);
 *   - Session C / Session D (owner decision 3): the root is the positioning +
 *     TRANSFORM shell (width, z, the slide; paints nothing, takes no pointer
 *     events); the BODY inside it carries border / background / padding / the
 *     scroll; the TAB is a child of the root at the pane's INNER edge and
 *     rides the slide (closed = the screen edge, open = the inner edge, never
 *     over the content). `openEntry(id, { via, anchor })` keeps the click
 *     anchor — the shell never turns a deep link into an entry-less open;
 *   - Session P (plan D2/D6/D7): the FOOTER TAB — a horizontal plate in the
 *     footer band's RIGHT slot (`bottom` = footerBottomPx − ROOT_BOTTOM_PX,
 *     height RAIL_GEOMETRY.FOOTER_BAND_PX), and the edge-chrome truth table
 *     (pinned OR open → awake, else the hub's per-frame `setTabPhase`);
 *   - Session T: the framed part portrait rides the same openEntry anchor
 *     (`partId` with or without a screen point — `showPart` builds it);
 *   - RefitPane Session H (plan D-H): the depot INVITATION on the tab edge
 *     (`setInvitation` / `isInvited`, VALUE gold + the steady INVITE_HALO —
 *     imported from RailIndicator, the ONE definition; Session L review).
 *
 * ARCHITECTURE (plan D5): ONE shell, TWO hosted section engines. This module
 * owns the root `#ladder-workbench`, the tab `#ladder-workbench-tab`, the
 * slide, the idle fade, the edge-chrome tab phase, reduced motion, the RTL
 * variable (`--workbench-dir`), the anchor SIDE (C3, plan 1789561832042:
 * LEFT on the workbench floor, RIGHT on F2–F5), the invitation glow, ONE open
 * state and ONE `onOpenChange` edge. `LibraryPane` (the SPECS dossier: HEAD +
 * TAIL) and `RefitPane` (the REFIT block, F1 only) are hosted section
 * engines: they render into the three slots the shell mounts them in —
 *
 *   #ladder-workbench                    the transform shell (side-anchored: left on F1,
 *    └ .workbench-body                   right elsewhere; top 56, bottom 96, width
 *                                       clamp(380px, 28vw, 440px), z 35, pointer-events none)
 *       ├ .workbench-head   ← library.mount({ head, tail, onRefresh })   identity (D1: Identity …)
 *       ├ .workbench-refit  ← refit.mount(slot, { onRefresh })            … Upgrade (display:none off F1) …
 *       └ .workbench-tail   ← (the library's second container)           … Learn
 *    └ #ladder-workbench-tab             'SPECS ' + <span.workbench-tab-count>
 *
 * The BODY shrink-wraps its content (`height:auto; max-height:100%`, plan D4 /
 * Q3) so no drawer ever shows an empty bottom half; it scrolls when the
 * dossier + the REFIT block outgrow the column. Every engine call is
 * duck-typed and no-op-safe (`_call`): a missing method is a no-op and a
 * throwing engine never breaks the shell's own edge — the shell's state
 * machine (open bit, slide, tab, the onOpenChange edge) always completes.
 *
 * THE TAB (plan D3, owner: "SPECS on every floor"). The word is `SPECS`
 * everywhere; the count is ONE number at a time: on F1 the GOLD affordable-
 * refit count when > 0 (`refit.affordableCount()`), else the unread count
 * (`library.unreadCount()`); off F1 the unread count. VALUE gold, `''` at 0.
 * It pulses ONCE when the displayed number RISES from a non-null baseline
 * (the boot paint never pulses; reduced motion never pulses — the count change
 * is the whole signal). The engines' `onRefresh` hook repaints it on the same
 * edge a BUY / chip tap / related click repaints the engine (plan §7: without
 * it a BUY would leave a stale gold count until the next shell edge).
 * `setFloor(floor)` pins the tab awake on F1 (the workbench affordance never
 * sleeps there), hands it to the edge-chrome phase elsewhere, and writes the
 * anchor SIDE — LEFT on F1 (C3, plan 1789561832042: the zoom rail sits
 * mid-height on the right edge, so a left drawer stops it painting over the
 * open pane) and RIGHT on F2–F5 (the left column carries Mother and Daughters
 * on F2 — a left-anchored drawer would bury them). A side change on an OPEN
 * pane re-fires the ONE open edge so the camera bias and the callout insets
 * follow the anchor (still one edge — `_settle`/`close` own the open/close
 * halves).
 * An OPEN pane's tab is its handle and is awake on any floor. `display:block`
 * while enabled on every floor; `body[data-pure-scenery]` (index.html) hides
 * it under level 0.
 *
 * ORDERS THAT MATTER (plan §3 / §7):
 *   open(opts)        refit.open(opts) when the REFIT section is enabled (F1) →
 *                     library.open() → _settle(). First-visit: `{ firstVisit:
 *                     true }` focuses the RECOMMENDED card BEFORE the library
 *                     adopts its subject (the hub's `_specsSubject` reads
 *                     `refit.focusedCodexId()`), or the subject resolves to
 *                     the pre-focus card.
 *   openEntry(id, o)  library.openEntry(id, o) — NEVER library.open() (that
 *                     drops the click anchor) → refit.open() if enabled and the
 *                     shell is closed → _settle() if closed.
 *   showPart(part)    the F1 click verb (D6): refit.focusPart(part) → the
 *                     dossier on part.codexId with { via: part.name, anchor }
 *                     (else library.open()) → the shell opens if closed →
 *                     library.scanPart(part) (the unlock request, as today).
 *   close()           `_open = false` FIRST (the Session I re-entrancy law: the
 *                     hub re-reads isOpen() inside the edge) → library.close()
 *                     → refit.close() → slide out → tab → onOpenChange(false).
 *   dispose()         timers, DOM; onOpenChange(false) only if it was open,
 *                     after `_open = false`. The engines are the hub's: the
 *                     shell closes them and drops their containers, it does
 *                     not dispose them.
 *
 * TIMINGS (module constants — VisualLaw has no pane-timing entry yet; the
 * 01-numbers "Workbench panes" table is the canonical source until the
 * VisualLaw entries land with a later consumer per 08-workbench §9; do NOT add
 * one here): PANE_SLIDE_MS = 270 (inside the 240–300 ms law, equal to
 * CameraSystem.LADDER_PANE_REFRAME_MS by design — the subject and the pane
 * arrive together), IDLE_FADE_OPACITY = 0.7 / IDLE_FADE_MS = 6000 ("idle panes
 * fade to 70 %, never vanish" — pointer wakes it), TAB_PULSE_MS = 900.
 * Reduced motion: the root never moves; the BODY fades in place; the tab flips
 * between the screen edge (closed) and the inner edge (open) through
 * `--workbench-open` and stays visible + clickable while the pane is closed.
 * ONE CSS variable (`--workbench-dir`, 1 right-anchored / -1 left-anchored)
 * mirrors the slide direction, the anchor and the tab's side: `setFloor(1)`
 * flips it to -1 with the LEFT anchor (C3), and an RTL boot may set -1 the
 * same way — every transform, the anchor and the tab follow it.
 *
 * NO eventBus/Events import and NO live singletons — the shell touches the
 * world through the two engines and the injected `onOpenChange` only, so the
 * module is headless-safe (no DOM at import, inert without a usable `doc`) and
 * the `?ladder=0` boot never constructs it.
 *
 * @module ui/WorkbenchPane
 */

import { VisualLaw } from '../core/VisualLaw.js';
import { RAIL_GEOMETRY } from './RailGeometry.js';
import { INVITE_HALO } from './RailIndicator.js';

/** Pane slide duration (ms) — inside the 240–300 ms house window
 *  (01-numbers "Workbench panes"; equals CameraSystem.LADDER_PANE_REFRAME_MS). */
export const PANE_SLIDE_MS = 270;
/** Idle panes fade to 70 %, never vanish (08-workbench §2 Motion). */
export const IDLE_FADE_OPACITY = 0.7;
/** Idle threshold before the fade applies (ms). */
export const IDLE_FADE_MS = 6000;
/** Pane root stacking (the shipped workbench-pane layer). The edge tab is a
 *  CHILD of the root at the pane's inner edge (Session D, owner decision 3) —
 *  it rides the pane's transform and needs no z step of its own. */
export const PANE_Z_INDEX = 35;
/** The pane root's CSS `bottom` (px) — the footer tab's `bottom` is the band's
 *  bottom minus this (Session P, plan D7). */
export const ROOT_BOTTOM_PX = 96;
/** Tab pulse length (ms) — the ONE pulse a rising count earns (§2 Grammar). */
export const TAB_PULSE_MS = 900;
/** The drawer chrome's edge border (body + tab); `_applySide` re-writes the
 *  mirrored longhand sides when the anchor flips. */
const EDGE_BORDER = '1px solid rgba(0,204,255,0.4)';

/** Monotonic ms clock (DOM-guarded module — Date.now fallback headless). */
const _nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Write a CSS custom property (the real DOM needs setProperty; a fake-DOM
 *  style object takes the key directly — tests read it back). */
function _setVar(el, name, value) {
  const st = el && el.style;
  if (!st) return;
  if (typeof st.setProperty === 'function') st.setProperty(name, value);
  else st[name] = value;
}

/** House reduced-motion probe (the FloorMask.js:188-196 shape). */
function _prefersReducedMotion() {
  try {
    return !!(typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (_e) {
    return false;
  }
}

export class WorkbenchPane {
  /**
   * Every dep optional; the shell is inert headless (no DOM at import, no DOM
   * without a usable doc) and never throws on a missing dep or engine method.
   * @param {object} [deps]
   * @param {Document} [deps.doc] - document to build into (default: global)
   * @param {function} [deps.now] - monotonic ms clock (tests)
   * @param {boolean|function} [deps.reducedMotion] - override for the matchMedia probe
   * @param {boolean} [deps.glass] - the boot's glass answer (the house idiom;
   *   main.js passes `_glassBoot`). Recorded on the shell for parity with the
   *   hub's construction line; the footer plate is FOOTER_BAND_PX tall on both
   *   surfaces (RailGeometry.footerBand) and the D10 44-pt targets are the
   *   engines' (each takes its own `glass` dep), so the shell consumes it for
   *   no DOM law today.
   * @param {number} [deps.footerBottomPx] - the FOOTER BAND's bottom offset
   *   from the viewport bottom (the hub passes RailGeometry.footerBand().bottom
   *   = 132); the tab's own `bottom` is that minus the root's 96. Default: the
   *   thumb rest + gap.
   * @param {object} [deps.library] - the hosted SPECS section engine
   *   (LibraryPane): mount({ head, tail, onRefresh }), setEnabled, open,
   *   openEntry, close, forgetEntry, scanPart, refresh, unreadCount
   * @param {object} [deps.refit] - the hosted REFIT section engine (RefitPane):
   *   mount(el, { onRefresh }), setEnabled, open({ firstVisit }), close,
   *   focusPart, refresh, affordableCount
   * @param {function} [deps.onOpenChange] - (isOpen) => void: the ONE open edge
   *   (main.js fans it into _syncWorkbenchPanes — the camera inset, the callout
   *   insets, the calm cap, WORKBENCH_RESUME on close). Fires on open and on
   *   close, and — since C3 — once more when an OPEN pane changes anchor side
   *   (setFloor F1↔F2+), so the side-signed feeds re-run. Still the one edge:
   *   the argument is true on open and on the side change, false on close.
   */
  constructor(deps = {}) {
    this._doc = deps.doc !== undefined ? deps.doc
      : (typeof document !== 'undefined' ? document : null);
    this._now = deps.now || _nowMs;
    this._reducedMotionDep = deps.reducedMotion;
    this._glass = deps.glass === true;
    this._library = deps.library || null;
    this._refit = deps.refit || null;
    this._onOpenChange = deps.onOpenChange || null;
    // Session P (plan D7): the FOOTER BAND's bottom offset from the viewport
    // bottom (the hub passes RailGeometry.footerBand().bottom = 132); the tab's
    // own `bottom` is that minus the root's 96. Default: the thumb rest + gap.
    const fb = Number(deps.footerBottomPx);
    this._footerBottomPx = Number.isFinite(fb) ? fb : (RAIL_GEOMETRY.THUMB_REST_PX + RAIL_GEOMETRY.FOOTER_GAP_PX);

    this._enabled = false;
    /** @private the floor the controller last applied (null until told); the REFIT section is enabled iff 1 */
    this._floor = null;
    /** @private the anchor side (C3, plan 1789561832042): true = LEFT (the
     * workbench floor), false = RIGHT (F2–F5 — the default; also the
     * pre-floor state). setFloor writes it; `_applySide` mirrors the DOM. */
    this._left = false;
    this._open = false;
    this._built = false;
    this._disposed = false;
    this._root = null;            // the transform shell (#ladder-workbench)
    this._body = null;            // the panel inside it (.workbench-body — shrink-wraps, scrolls)
    this._head = null;            // .workbench-head  (LibraryPane HEAD)
    this._refitSlot = null;       // .workbench-refit (RefitPane section)
    this._tail = null;            // .workbench-tail  (LibraryPane TAIL)
    this._tab = null;             // the edge tab, a child of the root at its inner edge
    this._tabCount = null;
    // Session P (plan D2/D6): whether the tab is PINNED awake on THIS floor
    // (F1 — the workbench affordance; setFloor writes it at every floor apply).
    // Off the workbench the tab is EDGE CHROME: it follows the hub's
    // setTabPhase while closed, and an open pane is always awake (its handle).
    // Default true so every behaviour outside the controller (tests, an
    // unwired boot) holds — the LibraryPane default.
    this._tabPinned = true;
    /** @private the last EdgeChrome phase the hub wrote ('awake'|'fading'|'hidden'); hidden until told */
    this._chromePhase = 'hidden';
    /** @private the effective phase last WRITTEN to the tab (write-on-change) */
    this._tabPhaseWritten = null;
    this._lastTabText = null;
    // Count/pulse state: baseline null so the FIRST paint (boot state) never
    // pulses; only a RISE afterwards (a new unlock, a newly affordable fit) does.
    this._lastCount = null;
    this._pulseTimer = null;
    this._pulseCount = 0;         // total pulses fired (tests/witness probe)
    // Idle fade state (open panes fade to 70 % after IDLE_FADE_MS, pointer wakes).
    this._lastActivityMs = this._now();
    this._idle = false;
    this._idleTimer = null;
    // The depot invitation (RefitPane Session H): a pure flag until the tab exists.
    this._invited = false;
  }

  // ── Engine plumbing (duck-typed, no-op-safe) ───────────────────────────────

  /**
   * @private Call one engine method when it exists; a missing engine / method
   * is a no-op (undefined), a throwing engine is swallowed like every other
   * injected dep (the shell's own edge must always complete).
   */
  _call(engine, method, ...args) {
    if (!engine || typeof engine[method] !== 'function') return undefined;
    try { return engine[method](...args); } catch (_e) { return undefined; }
  }

  /** @private A guarded numeric read (a count): finite and > 0, else 0. */
  _count(engine, method) {
    const v = this._call(engine, method);
    return (Number.isFinite(v) && v > 0) ? v : 0;
  }

  /** @private The REFIT section is live only while the shell is enabled on F1 (D7). */
  _refitOn() {
    return this._enabled && this._floor === 1;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** @returns {boolean} */
  isOpen() { return this._open; }

  /**
   * The drawer's anchor side (C3, plan 1789561832042): true = LEFT (the
   * workbench floor — the zoom rail owns the right edge), false = RIGHT
   * (F2–F5 — the left column carries Mother and Daughters on F2). The hub's
   * `_syncWorkbenchPanes` reads it on the open edge to sign the camera bias
   * and place the callout insets.
   * @returns {boolean}
   */
  isLeft() { return this._left; }

  /**
   * The pane's laid-out width in CSS px (its box, border-box: the
   * clamp(380px, 28vw, 440px) of 01-numbers) — 0 headless or before the root
   * is built, never NaN. The number main.js hands to
   * `CameraSystem.setLadderPaneInset` (signed by `isLeft()`: +w left, -w
   * right) and `motherCallouts.setPaneInsets` (the side's slot gets w, the
   * other 0) on the onOpenChange edge. A layout read: call it on edges
   * only, never per frame.
   * @returns {number}
   */
  widthPx() {
    const w = this._root ? this._root.offsetWidth : 0;
    return (Number.isFinite(w) && w > 0) ? w : 0;
  }

  /**
   * Controller engage / disengage (every floor). On: build lazily, enable the
   * SPECS engine, enable the REFIT engine iff the floor is 1, tab
   * display:block, refresh. Off: close(), both engines disabled, tab
   * display:none. Idempotent; headless no-op beyond state.
   * @param {boolean} on
   */
  setEnabled(on) {
    on = !!on;
    if (on === this._enabled) return;
    this._enabled = on;
    if (on) {
      this._build();
      this._call(this._library, 'setEnabled', true);
      this._call(this._refit, 'setEnabled', this._floor === 1);
      this._applyTabShown();
      this.refresh();
    } else {
      this.close();
      this._call(this._library, 'setEnabled', false);
      this._call(this._refit, 'setEnabled', false);
      this._applyTabShown();
    }
  }

  /**
   * The controller's floor write — at EVERY floor apply, before any open.
   * The REFIT section is enabled iff floor === 1 (hides its slot + clears
   * ghosting off F1 — the engine's setEnabled); the tab is PINNED awake iff
   * floor === 1 (else the edge-chrome phase rules); the count repaints (the
   * F1 gold count vs the unread count); and the anchor SIDE follows the floor
   * (C3: left on the workbench, right on F2–F5). A side change on an OPEN
   * pane re-fires the ONE onOpenChange edge — the hub's sync is edge-only
   * (open/close), and without the re-fire the camera bias and callout insets
   * would keep the old side's sign while the pane moves (the ride-2→1 defect).
   * The flip itself is instant: `left`/`right` do not tween, and the floor
   * apply runs at ride start, mid-flight, where the camera already masks it.
   * @param {number} floor
   */
  setFloor(floor) {
    const f = Number(floor);
    this._floor = Number.isFinite(f) ? f : null;
    if (this._enabled) this._call(this._refit, 'setEnabled', this._floor === 1);
    this._setTabPinned(this._floor === 1);
    const left = this._floor === 1;
    if (left !== this._left) {
      this._left = left;
      this._applySide();
      // Closed → nothing: the insets are 0 and the next open fires the edge.
      if (this._open && this._onOpenChange) { try { this._onOpenChange(true); } catch (_e) { /* dep */ } }
    }
    this._paintTab();
  }

  /**
   * Session P (plan D2): the hub's per-frame EDGE-CHROME write —
   * `edgeChrome.phase('tab', now)`. Effective phase = pinned OR open → 'awake',
   * else this phase: 'awake' → opacity 1 + visible; 'fading' → opacity
   * RAIL_GEOMETRY.IDLE_FADE (the CSS `transition: opacity EDGE_FADE_MS` ramps);
   * 'hidden' (or unknown) → visibility hidden. Write-on-change (G1).
   * @param {'awake'|'fading'|'hidden'} phase
   */
  setTabPhase(phase) {
    const ph = (phase === 'awake' || phase === 'fading') ? phase : 'hidden';
    if (ph === this._chromePhase) { this._applyTabPhase(); return; }
    this._chromePhase = ph;
    this._applyTabPhase();
  }

  /**
   * ENTRY-LESS open (tab / Space / swipe / flick / restore). No-op while
   * disabled. ORDER MATTERS (plan §3 / §7): the REFIT engine opens FIRST
   * (`{ firstVisit: true }` focuses the RECOMMENDED card) so the SPECS engine's
   * subject adopt sees the focused card; then the shell settles.
   * @param {{ firstVisit?: boolean }} [opts] - forwarded to refit.open
   */
  open(opts) {
    if (!this._enabled || this._disposed) return;
    if (this._refitOn()) this._call(this._refit, 'open', opts);
    this._call(this._library, 'open');
    this._settle();
  }

  /**
   * Deep link (REFIT title, RELATED chip, ticker chip, the hub's follow): the
   * SPECS engine shows the entry — `library.openEntry(id, opts)` keeps the
   * click anchor; the shell NEVER calls `library.open()` on this path. A
   * closed shell opens (the REFIT engine too, when enabled); an open one
   * retargets in place (ONE open edge). While disabled the engine stores the
   * entry for the next open (its own contract) and the shell stays shut.
   * @param {string} id - codex entry id
   * @param {{ via?: string, anchor?: object|null }} [opts]
   * @returns {boolean} true when the engine resolved the entry
   */
  openEntry(id, opts) {
    const res = this._call(this._library, 'openEntry', id, opts);
    if (!this._open) {
      if (this._refitOn()) this._call(this._refit, 'open');
      this._settle();
    }
    return res === true;
  }

  /**
   * The F1 click verb (plan D6): a hull part / callout-card click shows the
   * part's dossier — the REFIT engine focuses its subsystem, the SPECS engine
   * opens the part's entry with `via` = the clicked callout name and the click
   * anchor (portrait: `part.screen` + `part.bounds` + `partId`; an off-screen
   * part still carries `{ partId }`), the shell opens if closed, and the
   * Subnautica unlock request rides `library.scanPart(part)` as today. A part
   * without an entry lands the dossier on the subject (`library.open()`).
   * Null part → no-op.
   * @param {{ id?:string, name?:string, codexId?:string|null, screen?:{x:number,y:number}|null, bounds?:object|null }|null} part
   */
  showPart(part) {
    if (!part) return;
    this._call(this._refit, 'focusPart', part);
    if (part.codexId) {
      const anchor = part.screen
        ? { x: part.screen.x, y: part.screen.y, bounds: part.bounds, partId: part.id }
        : { partId: part.id };
      this._call(this._library, 'openEntry', part.codexId, { via: part.name, anchor });
    } else {
      this._call(this._library, 'open');
    }
    if (!this._open) {
      if (this._refitOn()) this._call(this._refit, 'open');
      this._settle();
    }
    this._call(this._library, 'scanPart', part);
  }

  /** @private The shell's own open edge: `_open` flips, slide in, wake, tab, ONE onOpenChange(true). */
  _settle() {
    if (this._open || !this._enabled || this._disposed) return;
    this._open = true;
    this._applyOpenState();
    this._applyTabPhase();       // an open pane's tab is awake on ANY floor
    this._wake();
    this._paintTab();
    if (this._onOpenChange) { try { this._onOpenChange(true); } catch (_e) { /* dep */ } }
  }

  /**
   * Close the pane. `_open = false` FIRST (the Session I re-entrancy law —
   * the hub re-reads isOpen() inside the edge), then both engines close,
   * the root slides out, the tab follows the phase rules, ONE
   * onOpenChange(false). Idempotent.
   */
  close() {
    if (!this._open) return;
    this._open = false;
    this._call(this._library, 'close');
    this._call(this._refit, 'close');
    this._applyOpenState();
    this._applyTabPhase();       // closed off-F1 → the tab follows the edge chrome again
    this._clearIdleTimer();
    this._paintTab();
    if (this._onOpenChange) { try { this._onOpenChange(false); } catch (_e) { /* dep */ } }
  }

  /** Edge-tab click / Space: toggle. */
  toggle() { if (this._open) this.close(); else this.open(); }

  /**
   * Forget the remembered entry while CLOSED (Session J, plan D-C): the hub
   * calls it on a floor arrival / selection change while the pane is shut so
   * the next entry-less open adopts the subject. The SPECS engine's verb.
   * @returns {boolean} true when an entry was forgotten
   */
  forgetEntry() {
    return this._call(this._library, 'forgetEntry') === true;
  }

  /**
   * The Subnautica rule (08-workbench §2): a LOCKED part's entry gets an unlock
   * request over the ONE existing path — the SPECS engine's verb. Never opens.
   * @param {{ codexId?: string|null }|null} part
   * @returns {boolean} true when an unlock was requested
   */
  scanPart(part) {
    return this._call(this._library, 'scanPart', part) === true;
  }

  /**
   * Recompute + repaint: both engines, then the tab count (write-on-change;
   * the pulse fires on a rise). Called on interaction edges + the hub's
   * CODEX_UNLOCKED / CODEX_VIEWED listeners — never per frame.
   */
  refresh() {
    this._call(this._library, 'refresh');
    this._call(this._refit, 'refresh');
    this._paintTab();
  }

  /**
   * The depot INVITATION on the tab (Wave 5 Session H, plan D-H; moved here
   * from RefitPane with the tab): main.js's ONE DEPOT_INVITATION listener feeds
   * the rail's notch-1 glow (WHERE) AND this tab glow (WHAT: the workbench is
   * the shop). `open` true → the tab edge wears VALUE gold with the steady
   * halo (VisualLaw: gold never pulses); false (entered / lapsed / reset) →
   * the resting INFO frame. Write-on-change; state survives enable/disable
   * cycles (the tab keeps its dress while hidden); headless = pure flag.
   * @param {boolean} open
   */
  setInvitation(open) {
    const want = !!open;
    if (want === this._invited) return;
    this._invited = want;
    this._applyInvitation();
  }

  /** @returns {boolean} true while the invitation window is open (the tab glows). */
  isInvited() { return this._invited; }

  /** @private Dress/undress the tab edge for the invitation (steady, G1: edges only). */
  _applyInvitation() {
    if (!this._tab) return;
    if (this._invited) {
      this._tab.style.borderColor = VisualLaw.COLORS.VALUE;
      this._tab.style.boxShadow = INVITE_HALO;                          // the rail's INVITE_HALO law — ONE definition (Session L review)
    } else {
      this._tab.style.borderColor = 'rgba(0,204,255,0.4)';             // the resting INFO frame
      this._tab.style.boxShadow = 'none';
    }
  }

  /**
   * Remove every node + timer; the instance stays inert afterwards. The close
   * edge fires only if the pane was open, and observes isOpen() === false
   * (the Session I follow-up (h) order). The engines are the hub's: an open
   * shell closes them; their containers go with the root.
   */
  dispose() {
    this._disposed = true;
    this._clearIdleTimer();
    this._clearPulseTimer();
    const wasOpen = this._open;
    this._open = false;
    if (wasOpen) {
      this._call(this._library, 'close');
      this._call(this._refit, 'close');
      if (this._onOpenChange) { try { this._onOpenChange(false); } catch (_e) { /* dep */ } }
    }
    if (this._root && this._root.remove) this._root.remove();   // takes the body, the slots + the tab with it
    if (this._tab && this._tab.remove) this._tab.remove();
    this._root = null;
    this._body = null;
    this._head = null;
    this._refitSlot = null;
    this._tail = null;
    this._tab = null;
    this._tabCount = null;
    this._built = false;
    this._lastTabText = null;
    this._tabPhaseWritten = null;
  }

  // ── DOM (guarded; nothing at import) ───────────────────────────────────────

  /** @private Effective reduced-motion read (dep overrides the house probe). */
  _reducedMotion() {
    const dep = this._reducedMotionDep;
    if (typeof dep === 'function') { try { return !!dep(); } catch (_e) { return false; } }
    if (typeof dep === 'boolean') return dep;
    return _prefersReducedMotion();
  }

  /**
   * @private Session P (plan D6/D7): the tab's CSS `bottom` inside the pane
   * root — the footer band's bottom (viewport offset) minus the root's own
   * bottom (96), never negative. 132 → 36 on both surfaces.
   * @returns {number}
   */
  _tabBottomCss() {
    return Math.max(0, Math.round(this._footerBottomPx - ROOT_BOTTOM_PX));
  }

  /** @private Build the shell once, then mount the two engines into its slots. */
  _build() {
    if (this._built || this._disposed) return;
    const doc = this._doc;
    if (!doc || typeof doc.createElement !== 'function' || !doc.body) return;
    this._built = true;
    const reduced = this._reducedMotion();

    // The pane ROOT — 380–440 px wide, anchored to the SIDE the floor picks
    // (C3: LEFT on the workbench floor, RIGHT on F2–F5) — is the positioning +
    // TRANSFORM shell (Session D): it carries the slide, the width clamp and
    // the z layer, paints nothing itself and takes no pointer events; the
    // BODY (the panel: border, background, padding, the scrolling content)
    // and the edge TAB are its children, so the tab RIDES the pane's
    // transform. --workbench-dir is the ONE mirror variable (1 right-anchored,
    // -1 left-anchored — setFloor(1) flips it; an RTL boot may too): every
    // transform, the anchor and the tab's side follow it. --workbench-open
    // (0|1) is the reduced-motion tab position (the root never moves there;
    // see _applyOpenState).
    const root = doc.createElement('div');
    root.id = 'ladder-workbench';
    root.className = reduced ? 'workbench-reduced' : '';
    root.style.cssText = [
      'position:absolute', this._left ? 'left:0' : 'right:0', 'top:56px', `bottom:${ROOT_BOTTOM_PX}px`, `z-index:${PANE_Z_INDEX}`,
      'width:clamp(380px, 28vw, 440px)', 'box-sizing:border-box',
      'pointer-events:none', `--workbench-dir:${this._left ? -1 : 1}`, '--workbench-open:1',
      // Slide (transform) in the normal path; the reduced-motion class swaps
      // the slide for a fade of the BODY at the same duration (08-workbench §2
      // Motion) — the root then never moves, so the tab stays visible.
      reduced
        ? ''
        : `transition:transform ${PANE_SLIDE_MS}ms cubic-bezier(0.65,0,0.35,1), opacity 400ms ease`,
    ].join(';');

    // The body — the panel the player reads. Anchored to the root's top; it
    // SHRINK-WRAPS its content (plan D4 / Q3: `height:auto; max-height:100%`
    // — no empty column below the last block) and scrolls past the fold.
    // Border / background / padding / font = the shipped .library-body. The
    // border's dead side mirrors the anchor (C3): the side against the
    // screen edge carries no border, the corners round away from it.
    const body = doc.createElement('div');
    body.className = 'workbench-body';
    body.style.cssText = [
      'position:absolute', 'top:0', 'right:0', 'left:0', 'height:auto', 'max-height:100%', 'box-sizing:border-box',
      'padding:10px 12px', 'overflow-y:auto',
      `border:${EDGE_BORDER}`, this._left ? 'border-left:none' : 'border-right:none',
      this._left ? 'border-radius:0 6px 6px 0' : 'border-radius:6px 0 0 6px',
      'background:rgba(0,16,32,0.82)', 'color:' + VisualLaw.COLORS.INFO,
      'font-family: var(--font-mono)', 'font-size:0.68rem', 'letter-spacing:0.05em',
      'pointer-events:auto',
      reduced ? `transition:opacity ${PANE_SLIDE_MS}ms ease` : '',
    ].join(';');
    root.appendChild(body);

    // The three section slots in the D1 order — Identity (the SPECS head),
    // Upgrade (the REFIT block; the engine hides it off F1), Learn (the SPECS
    // tail). Real children (never innerHTML) so the engines' containers
    // survive every repaint of their neighbours.
    const head = doc.createElement('div');
    head.className = 'workbench-head';
    const refitSlot = doc.createElement('div');
    refitSlot.className = 'workbench-refit';
    const tail = doc.createElement('div');
    tail.className = 'workbench-tail';
    body.appendChild(head);
    body.appendChild(refitSlot);
    body.appendChild(tail);

    // The edge tab (08-workbench §2 Grammar). A CHILD of the root at the
    // pane's INNER edge (Session D, owner decision 3): closed, the root's
    // slide parks it exactly at the screen edge; open, it sits on the pane's
    // inner edge — never over the content. The side follows the ONE mirror
    // variable: left = 50% − dir·50% (dir 1 → the root's left edge) and the
    // −100 % self-translate puts the tab outside the box; under reduced motion
    // --workbench-open flips it between the screen edge (closed) and the inner
    // edge (open) because the root never moves. Session P (plan D6/D7): a
    // HORIZONTAL plate in the FOOTER BAND — the right slot for a right-anchored
    // pane, the LEFT slot on the workbench floor (C3) — `bottom` = the band's
    // bottom minus the root's 96, height FOOTER_BAND_PX; its opacity /
    // visibility are the edge-chrome truth table's (the hub's setTabPhase +
    // setFloor's pin), the ramp `opacity EDGE_FADE_MS` (none under reduced
    // motion — instant, like every other reduced-motion step). The border's
    // dead side mirrors the anchor like the body's.
    const tab = doc.createElement('div');
    tab.id = 'ladder-workbench-tab';
    tab.style.cssText = [
      'position:absolute', `bottom:${this._tabBottomCss()}px`, 'z-index:1',
      'left:calc(50% - var(--workbench-dir, 1) * (2 * var(--workbench-open, 1) - 1) * 50%)',
      'transform:translateX(calc((-1 - var(--workbench-dir, 1)) * 50%))',
      `height:${RAIL_GEOMETRY.FOOTER_BAND_PX}px`, `line-height:${RAIL_GEOMETRY.FOOTER_BAND_PX - 2}px`,
      'box-sizing:border-box', 'padding:0 10px 0 12px', 'white-space:nowrap',
      `border:${EDGE_BORDER}`, this._left ? 'border-left:none' : 'border-right:none',
      this._left ? 'border-radius:0 3px 3px 0' : 'border-radius:3px 0 0 3px', 'background:rgba(0,16,32,0.85)',
      'color:' + VisualLaw.COLORS.INFO, 'cursor:pointer',
      'font-family: var(--font-mono)', 'font-size:0.62rem', 'letter-spacing:0.08em',
      'user-select:none', 'display:none', 'pointer-events:auto',
      // The pulse animates through transition (reduced motion never sets it);
      // the edge-chrome fade rides the same property list.
      reduced ? '' : `transition:box-shadow ${TAB_PULSE_MS / 3}ms ease, opacity ${RAIL_GEOMETRY.EDGE_FADE_MS}ms ease`,
    ].join(';');
    // Built as real children (never innerHTML) so the count node survives
    // every repaint and fake-DOM test docs need no querySelector.
    const tabLabel = doc.createElement('span');
    tabLabel.textContent = 'SPECS ';
    const tabCount = doc.createElement('span');
    tabCount.className = 'workbench-tab-count';
    tabCount.style.cssText = `color:${VisualLaw.COLORS.VALUE};font-weight:bold`;
    tab.appendChild(tabLabel);
    tab.appendChild(tabCount);
    tab.addEventListener('click', () => { this._wake(); this.toggle(); });
    root.appendChild(tab);

    doc.body.appendChild(root);
    this._root = root;
    this._body = body;
    this._head = head;
    this._refitSlot = refitSlot;
    this._tail = tail;
    this._tab = tab;
    this._tabCount = tabCount;
    this._tabPhaseWritten = null;   // the phase truth table writes the fresh tab
    this._applyTabPhase();
    this._applyOpenState();
    this._applySide();              // a side picked before the build lands now (C3)
    this._applyInvitation();        // a pre-build setInvitation lands once built (Session H)

    // Delegated wake (one listener set — G1, the PaneHelp pattern): on the
    // root, so the engines' content and the tab share it (the tab's own click
    // above toggles; here it only wakes). The engines' own delegated clicks
    // ([data-max], [data-rel], [data-buy], chips) live on their containers.
    root.addEventListener('click', () => this._wake());
    root.addEventListener('pointermove', () => this._wake());
    root.addEventListener('pointerdown', () => this._wake());

    // Mount the two hosted section engines into their slots. `onRefresh` is
    // the tab's stale-count guard (plan §7): a BUY / chip tap / related click
    // repaints the engine, and the shell's count follows on the same edge.
    const onRefresh = () => this._paintTab();
    this._call(this._library, 'mount', { head, tail, onRefresh });
    this._call(this._refit, 'mount', refitSlot, { onRefresh });
  }

  /** @private The tab's actual display: enabled → block (every floor); the phase decides the rest. */
  _applyTabShown() {
    if (this._tab) {
      const css = this._enabled ? 'block' : 'none';
      if (this._tab.style.display !== css) this._tab.style.display = css;
    }
    this._applyTabPhase();
  }

  /** @private setFloor's pin: F1 → the tab is always awake; elsewhere the edge-chrome phase rules. */
  _setTabPinned(on) {
    on = !!on;
    if (on === this._tabPinned) return;
    this._tabPinned = on;
    this._applyTabPhase();
  }

  /** @private the pinned / open / chrome truth table → opacity + visibility, on change */
  _applyTabPhase() {
    const want = (this._tabPinned || this._open) ? 'awake' : this._chromePhase;
    if (want === this._tabPhaseWritten) return;
    this._tabPhaseWritten = want;
    const tab = this._tab;
    if (!tab) return;
    if (want === 'awake') {
      tab.style.opacity = '1';
      tab.style.visibility = 'visible';
    } else if (want === 'fading') {
      tab.style.opacity = String(RAIL_GEOMETRY.IDLE_FADE);
    } else {
      tab.style.visibility = 'hidden';
      tab.style.opacity = String(RAIL_GEOMETRY.IDLE_FADE);
    }
  }

  /**
   * @private Mirror the anchor side onto the DOM (C3, plan 1789561832042):
   * the root's `left`/`right` anchor, the ONE mirror variable
   * `--workbench-dir` (1 right / -1 left — the slide transform, the anchor
   * and the tab's side all read it), and the body's and tab's dead border
   * side + corner rounding (the side against the screen edge carries no
   * border; the corners round away from it). Called from `_build` (a side
   * picked before the build) and from `setFloor` on a real side change —
   * the flip is instant by design (the floor apply runs at ride start,
   * mid-flight; `left`/`right` do not tween anyway).
   */
  _applySide() {
    const root = this._root;
    if (!root) return;
    root.style.left = this._left ? '0' : '';
    root.style.right = this._left ? '' : '0';
    _setVar(root, '--workbench-dir', this._left ? '-1' : '1');
    const body = this._body;
    if (body) {
      body.style.borderRight = this._left ? EDGE_BORDER : 'none';
      body.style.borderLeft = this._left ? 'none' : EDGE_BORDER;
      body.style.borderRadius = this._left ? '0 6px 6px 0' : '6px 0 0 6px';
    }
    const tab = this._tab;
    if (tab) {
      tab.style.borderRight = this._left ? EDGE_BORDER : 'none';
      tab.style.borderLeft = this._left ? 'none' : EDGE_BORDER;
      tab.style.borderRadius = this._left ? '0 3px 3px 0' : '3px 0 0 3px';
    }
  }

  /** @private Slide (root) / fade (body) to the current open state; the tab
   *  rides the root in the slide path and flips edges in the fade path. */
  _applyOpenState() {
    const root = this._root;
    if (!root) return;
    const body = this._body;
    const reduced = this._reducedMotion();
    if (reduced) {
      root.className = 'workbench-reduced';
      root.style.transform = 'none';              // the root never moves: the fade is the body's
      root.style.visibility = 'visible';
      if (body) {
        body.style.opacity = this._open ? '1' : '0';
        body.style.visibility = this._open ? 'visible' : 'hidden';
      }
      // The tab stays visible + clickable while the body is hidden: closed it
      // sits at the screen edge, open at the pane's inner edge (a snap —
      // reduced motion permits it).
      _setVar(root, '--workbench-open', this._open ? '1' : '0');
    } else {
      root.className = '';
      // One CSS variable mirrors the slide for the anchor side
      // (--workbench-dir: -1 = the left anchor flips it); the pane slides out
      // toward its anchored screen edge by exactly its width, so the
      // tab riding at its inner edge parks at the screen edge when closed.
      root.style.transform = this._open
        ? 'translateX(0)'
        : 'translateX(calc(var(--workbench-dir, 1) * 100%))';
      root.style.opacity = this._open ? '1' : '0.999'; // keep painted for the slide
      root.style.visibility = 'visible';
      if (body) { body.style.opacity = '1'; body.style.visibility = 'visible'; }
      _setVar(root, '--workbench-open', '1');
    }
  }

  // ── The tab count (plan D3) ────────────────────────────────────────────────

  /**
   * @private The ONE displayed number: on F1 the gold affordable-refit count
   * when > 0, else the unread count; off F1 the unread count. Guarded reads.
   * @returns {number}
   */
  _tabCountValue() {
    const affordable = (this._floor === 1) ? this._count(this._refit, 'affordableCount') : 0;
    return affordable > 0 ? affordable : this._count(this._library, 'unreadCount');
  }

  /** @private Tab count paint (write-on-change) + the ONE pulse on a rise. */
  _paintTab() {
    const n = this._tabCountValue();
    if (this._tabCount) {
      const text = n > 0 ? String(n) : '';
      if (text !== this._lastTabText) {
        this._tabCount.textContent = text;
        this._lastTabText = text;
      }
    }
    // Pulse ONCE when the displayed number RISES (a new unlock landed, a fit
    // became affordable). The boot baseline (null) never pulses; a drop never
    // pulses.
    if (this._lastCount != null && n > this._lastCount) this._pulse();
    this._lastCount = n;
  }

  /** @private One tab pulse (§2: "pulses once on a new unlock"). Reduced
   *  motion: no animation — the count change is the whole signal. */
  _pulse() {
    this._pulseCount++;
    if (!this._tab || this._reducedMotion()) return;
    this._tab.style.boxShadow = `0 0 12px 2px ${VisualLaw.COLORS.VALUE}`;
    if (this._tab.classList && this._tab.classList.add) this._tab.classList.add('workbench-tab-pulse');
    this._clearPulseTimer();
    this._pulseTimer = setTimeout(() => this._pulseTick(), TAB_PULSE_MS);
  }

  /** @private Pulse end (timer-fired; tests drive it directly). The invitation
   *  dress, when worn, returns under the pulse (the steady halo is the rest state). */
  _pulseTick() {
    this._pulseTimer = null;
    if (!this._tab) return;
    this._tab.style.boxShadow = this._invited ? INVITE_HALO : 'none';
    if (this._tab.classList && this._tab.classList.remove) this._tab.classList.remove('workbench-tab-pulse');
  }

  /** @private */
  _clearPulseTimer() {
    if (this._pulseTimer != null) {
      clearTimeout(this._pulseTimer);
      this._pulseTimer = null;
    }
  }

  // ── Idle fade (open panes dim to 70 %, pointer wakes — §2 Motion) ─────────

  /** @private */
  _clearIdleTimer() {
    if (this._idleTimer != null) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  /** @private Activity: restore full opacity + re-arm the idle window. */
  _wake() {
    this._lastActivityMs = this._now();
    if (this._idle) {
      this._idle = false;
      if (this._root) {
        this._root.style.opacity = this._open ? '1' : this._root.style.opacity;
        if (this._root.classList && this._root.classList.remove) this._root.classList.remove('workbench-idle');
      }
    }
    this._armIdleTimer();
  }

  /** @private */
  _armIdleTimer() {
    this._clearIdleTimer();
    if (!this._open || !this._root || this._disposed) return;
    this._idleTimer = setTimeout(() => this._idleTick(), IDLE_FADE_MS + 20);
  }

  /**
   * @private The idle beat (timer-fired; tests drive it directly with an
   * injected clock): past IDLE_FADE_MS of no activity while open → fade to
   * IDLE_FADE_OPACITY — never display:none, never visibility loss (the pane
   * "never vanishes"); otherwise re-arm for the remainder.
   */
  _idleTick() {
    this._idleTimer = null;
    if (!this._open || !this._root || this._disposed) return;
    const since = this._now() - this._lastActivityMs;
    if (since >= IDLE_FADE_MS) {
      this._idle = true;
      this._root.style.opacity = String(IDLE_FADE_OPACITY);
      if (this._root.classList && this._root.classList.add) this._root.classList.add('workbench-idle');
    } else {
      this._idleTimer = setTimeout(() => this._idleTick(), (IDLE_FADE_MS - since) + 20);
    }
  }
}

export default WorkbenchPane;
