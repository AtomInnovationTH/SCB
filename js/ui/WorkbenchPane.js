/**
 * The ONE workbench drawer (owner 2026-09-09): SPECS + the F1 REFIT block in one side-anchored pane (LEFT on every
 * floor, DECISIONS §13 r5; docs/ladder/08-workbench.md §2; docs/ladder/01-numbers.md "Workbench panes").
 *
 * Chrome lineage (the numbers and laws are the shipped ones from the two drawers it replaces):
 *   - LibraryPane: the lazily-built pane, the slide (PANE_SLIDE_MS), the idle fade to 70 % (IDLE_FADE_*), the tab
 *     count + the ONCE-per-rise pulse (TAB_PULSE_MS), the reduced-motion probe (FloorMask.js house matchMedia shape);
 *   - the root is the positioning + TRANSFORM shell (width, z, the slide; paints nothing, takes no pointer events);
 *     the BODY carries border / background / padding / the scroll; the TAB is a child of the root at the pane's INNER
 *     edge (owner decision) and rides the slide (closed = the screen edge, open = the inner edge, never over the content).
 *     `openEntry(id, { via, anchor })` keeps the click anchor — the shell never turns a deep link into an entry-less open;
 *   - the FOOTER TAB: a horizontal plate in the footer band's LEFT slot (`bottom` = footerBottomPx − the root bottom
 *     in force, height RAIL_GEOMETRY.FOOTER_BAND_PX) and the edge-chrome truth table (pinned OR open → awake, else
 *     the hub's per-frame `setTabPhase`);
 *   - the framed part portrait rides the same openEntry anchor (`partId` with or without a screen point; `showPart`);
 *   - the depot INVITATION on the tab edge (`setInvitation` / `isInvited`, VALUE gold + the steady INVITE_HALO from
 *     RailIndicator, the ONE definition).
 *
 * ARCHITECTURE: ONE shell, TWO hosted section engines. This module owns the root `#ladder-workbench`, the tab
 * `#ladder-workbench-tab`, the slide, the idle fade, the edge-chrome tab phase, reduced motion, the variable
 * (`--workbench-dir`), the anchor SIDE (LEFT on EVERY floor), the invitation glow, ONE open state and ONE
 * `onOpenChange` edge. `LibraryPane` (the SPECS dossier: HEAD + TAIL) and `RefitPane` (the REFIT block, F1 only) are
 * hosted engines that render into the three slots the shell mounts them in:
 *
 *   #ladder-workbench                    the transform shell (left-anchored on every
 *    └ .workbench-body                   floor; top 56, bottom 96 on F2–F5 / 16 on F1
 *                                       (§13 r1 — full height), width
 *                                       clamp(380px, 28vw, 440px), z 35, pointer-events none)
 *       ├ .workbench-head   ← library.mount({ head, tail, onRefresh })   identity (D1: Identity …)
 *       ├ .workbench-refit  ← refit.mount(slot, { onRefresh })            … Upgrade (display:none off F1) …
 *       └ .workbench-tail   ← (the library's second container)           … Learn
 *    └ #ladder-workbench-tab             'SPECS ' + <span.workbench-tab-count>
 *
 * The BODY shrink-wraps its content (`height:auto; max-height:100%`) so no drawer ever shows an empty bottom half;
 * it scrolls when the dossier + the REFIT block outgrow the column. **F1 exception (§13 r1): the drawer uses the
 * height** — the body FILLS the root (`height:100%`, still `overflow-y:auto`) and the root's bottom drops to
 * `ROOT_BOTTOM_PX_F1` (16 px). Every engine call is duck-typed and no-op-safe (`_call`): a missing method is a no-op
 * and a throwing engine never breaks the shell's own edge (open bit, slide, tab, onOpenChange always complete).
 *
 * THE TAB (owner: "SPECS on every floor"). The word is `SPECS` everywhere; the count is ONE number at a time: on F1
 * the GOLD affordable-refit count when > 0 (`refit.affordableCount()`), else the unread count
 * (`library.unreadCount()`); off F1 the unread count. VALUE gold, `''` at 0. It pulses ONCE when the displayed number
 * RISES from a non-null baseline (the boot paint never pulses; reduced motion never pulses). The engines'
 * `onRefresh` hook repaints it on the same edge a BUY / chip tap / related click repaints the engine (else a BUY
 * leaves a stale gold count). `setFloor(floor)` pins the tab awake on F1, hands it to the edge-chrome phase
 * elsewhere, and applies the FLOOR LAYOUT write-on-change. An OPEN pane's tab is its handle and is awake on any
 * floor. `display:block` while enabled on every floor; `body[data-pure-scenery]` (index.html) hides it under level 0.
 *
 * ORDERS THAT MATTER:
 *   open(opts)        refit.open(opts) when the REFIT section is enabled (F1) → library.open() → _settle().
 *                     `{ firstVisit: true }` focuses the RECOMMENDED card BEFORE the library adopts its subject (the
 *                     hub's `_specsSubject` reads `refit.focusedCodexId()`), or the subject resolves to the
 *                     pre-focus card.
 *   openEntry(id, o)  library.openEntry(id, o) — NEVER library.open() (that drops the click anchor) → refit.open()
 *                     if enabled and the shell is closed → _settle() if closed.
 *   showPart(part)    the F1 click verb: refit.focusPart(part) → the dossier on part.codexId with { via: part.name,
 *                     anchor } (else library.open()) → the shell opens if closed → library.scanPart(part).
 *   close()           `_open = false` FIRST (re-entrancy law: the hub re-reads isOpen() inside the edge) →
 *                     library.close() → refit.close() → slide out → tab → onOpenChange(false).
 *   dispose()         timers, DOM; onOpenChange(false) only if it was open, after `_open = false`. The engines are
 *                     the hub's: the shell closes them and drops their containers, it does not dispose them.
 *
 * TIMINGS (module constants; the 01-numbers "Workbench panes" table is canonical; do NOT add VisualLaw entries
 * here): PANE_SLIDE_MS = 270 (inside the 240–300 ms law, equal to CameraSystem.LADDER_PANE_REFRAME_MS by design: the
 * subject and the pane arrive together), IDLE_FADE_OPACITY = 0.7 / IDLE_FADE_MS = 6000 (pointer wakes it),
 * TAB_PULSE_MS = 900. Reduced motion: the root never moves; the BODY fades in place; the tab flips between the
 * screen edge (closed) and the inner edge (open) through `--workbench-open` and stays visible + clickable while
 * closed. ONE CSS variable (`--workbench-dir`, -1 left-anchored) carries the slide direction and the tab's side: the
 * drawer is LEFT-only (no RTL mirror is implemented), so -1 is baked at build.
 *
 * NO eventBus/Events import and NO live singletons: the shell touches the world through the two engines and the
 * injected `onOpenChange` only, so it is headless-safe (no DOM at import, inert without a usable `doc`) and the
 * `?ladder=0` boot never constructs it.
 *
 * @module ui/WorkbenchPane
 */

import { VisualLaw } from '../core/VisualLaw.js';
import { RAIL_GEOMETRY } from './RailGeometry.js';
import { GestureHints } from './hud/GestureHints.js';
import { INVITE_HALO } from './RailIndicator.js';

/** Pane slide duration (ms): inside the 240–300 ms house window; equals CameraSystem.LADDER_PANE_REFRAME_MS. */
export const PANE_SLIDE_MS = 270;
/** Idle panes fade to 70 %, never vanish. */
export const IDLE_FADE_OPACITY = 0.7;
export const IDLE_FADE_MS = 6000;
/** Pane root stacking. The edge tab is a CHILD of the root, rides its transform and needs no z step of its own. */
export const PANE_Z_INDEX = 35;
/** The pane root's CSS `bottom` (px); the footer tab's `bottom` is the band's bottom minus this. */
export const ROOT_BOTTOM_PX = 96;
/** The F1 exception (§13 r1): the drawer USES the height; the body fills the root (F2–F5 keep ROOT_BOTTOM_PX + shrink-wrap). */
export const ROOT_BOTTOM_PX_F1 = 16;
/** Tab pulse length (ms): the ONE pulse a rising count earns. */
export const TAB_PULSE_MS = 900;
/** DECISIONS §42: the floor-1 drawer's MAIN MENU button: the first tap arms it for this long, a second tap inside
 *  the window leaves; later it disarms (no accidental exit on touch, no save added). */
export const MAIN_MENU_ARM_MS = 3000;
export const MAIN_MENU_LABEL = 'MAIN MENU';
export const MAIN_MENU_ARMED_LABEL = 'TAP AGAIN TO LEAVE';
/** The second tap while the game cannot go to the menu (a catch in progress): no leave, this label for this long. */
export const MAIN_MENU_REFUSED_LABEL = 'Finish the catch first';
export const MAIN_MENU_REFUSED_MS = 2000;

/**
 * Should the SPECS tab step aside? On a short (phone) screen an OPEN DAUGHTERS pane covers the whole tab (measured:
 * 2,359 px² plate / 3,243 px² hit area) with no room under it, so while the drawer is closed and DAUGHTERS is open
 * and shown the tab takes no box and no taps. Taller screens never yield. Pure.
 * @param {{drawerOpen?:boolean, short?:boolean, armsShown?:boolean, armsFolded?:boolean}} s
 */
export function shouldYieldSpecsTab(s = {}) {
  return !s.drawerOpen && !!s.short && !!s.armsShown && !s.armsFolded;
}
/** The drawer chrome's edge border (body + tab); the left anchor's dead side and corner rounding are baked in `_build`. */
const EDGE_BORDER = '1px solid rgba(0,204,255,0.4)';

const _nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Write a CSS custom property (the real DOM needs setProperty; a fake-DOM style object takes the key directly). */
function _setVar(el, name, value) {
  const st = el && el.style;
  if (!st) return;
  if (typeof st.setProperty === 'function') st.setProperty(name, value);
  else st[name] = value;
}

/** House reduced-motion probe (the `FloorMask.js` `_prefersReducedMotion` shape). */
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
   * Every dep optional; the shell is inert headless and never throws on a missing dep or engine method.
   * @param {object} [deps]
   * @param {Document} [deps.doc] - document to build into (default: global)
   * @param {function} [deps.now] - monotonic ms clock (tests)
   * @param {boolean|function} [deps.reducedMotion] - override for the matchMedia probe
   * @param {boolean} [deps.glass] - the boot's glass answer (main.js `_glassBoot`). The 44-pt targets are the
   *   engines' (each takes its own `glass` dep); the shell's one glass law is the SPECS tab's HIT AREA: a transparent
   *   child 44 (TOUCH_PITCH_PX) tall on glass, 32 (FOOTER_BAND_PX) otherwise, centred on the plate. The visible plate
   *   stays FOOTER_BAND_PX tall at the same place (the tab looks the same).
   * @param {number} [deps.footerBottomPx] - the FOOTER BAND's bottom offset from the viewport bottom (the hub passes
   *   RailGeometry.footerBand().bottom = 132); the tab's own `bottom` is that minus the root's 96. Default: the
   *   thumb rest + gap.
   * @param {object} [deps.library] - the hosted SPECS engine (LibraryPane): mount({ head, tail, onRefresh }),
   *   setEnabled, open, openEntry, close, forgetEntry, scanPart, refresh, unreadCount
   * @param {object} [deps.refit] - the hosted REFIT engine (RefitPane): mount(el, { onRefresh }), setEnabled,
   *   open({ firstVisit }), close, focusPart, refresh, affordableCount
   * @param {function} [deps.onMainMenu] - () => void: the MAIN MENU button, on its SECOND tap within MAIN_MENU_ARM_MS
   *   (main.js wires it to the PAUSE_MENU event; the shell keeps no bus import).
   * @param {function} [deps.canLeave] - () => boolean: the game can go to the menu now (main.js reads the GameState
   *   transition table). Asked on the SECOND tap; false = no `onMainMenu`, the button says MAIN_MENU_REFUSED_LABEL for
   *   MAIN_MENU_REFUSED_MS (else the flow manager aborts the trip and the berth before it finds the move refused).
   *   Absent = allowed.
   * @param {function} [deps.onOpenChange] - (isOpen) => void: the ONE open edge (main.js fans it into
   *   _syncWorkbenchPanes: the camera inset, the callout insets, the calm cap, WORKBENCH_RESUME on close). Fires on
   *   open and on close only; the anchor is LEFT on every floor, so a floor ride never moves it.
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
    this._onMainMenu = deps.onMainMenu || null;
    this._canLeave = typeof deps.canLeave === 'function' ? deps.canLeave : null;
    this._menuRefusedTimer = null;
    this._menuBtn = null;         // the MAIN MENU button, last child of the body (floor 1 only)
    this._menuArmedAt = null;     // the clock reading of the first tap while armed, else null
    this._menuTimer = null;
    const fb = Number(deps.footerBottomPx);
    this._footerBottomPx = Number.isFinite(fb) ? fb : (RAIL_GEOMETRY.THUMB_REST_PX + RAIL_GEOMETRY.FOOTER_GAP_PX);

    this._enabled = false;
    /** the floor the controller last applied (null until told); the REFIT section is enabled iff 1 */
    this._floor = null;
    /** the F1 layout last WRITTEN to the DOM (write-on-change; the build bakes the initial values) */
    this._floorLayoutWritten = null;
    /** the anchor side: true = LEFT on EVERY floor (the drawer is left-only); `isLeft()` reads it (main.js) */
    this._left = true;
    this._open = false;
    this._built = false;
    this._disposed = false;
    this._root = null;            // the transform shell (#ladder-workbench)
    this._body = null;            // the panel inside it (.workbench-body — shrink-wraps, scrolls)
    this._head = null;            // .workbench-head  (LibraryPane HEAD)
    this._refitSlot = null;       // .workbench-refit (RefitPane section)
    this._tail = null;            // .workbench-tail  (LibraryPane TAIL)
    this._tab = null;             // the edge tab, a child of the root at its inner edge
    this._tabHit = null;          // its transparent hit layer (44 px on glass)
    this._tabCount = null;
    this._closeBtn = null;        // the ESC × button, a child of the root at its top-right (the body scrolls, the X must not)
    // Whether the tab is PINNED awake on THIS floor (F1; setFloor writes it at every floor apply). Off F1 the tab is
    // EDGE CHROME: it follows the hub's setTabPhase while closed, and an open pane is always awake. Default true so
    // behaviour outside the controller (tests, an unwired boot) holds.
    this._tabPinned = true;
    /** the last EdgeChrome phase the hub wrote ('awake'|'fading'|'hidden'); hidden until told */
    this._chromePhase = 'hidden';
    /** the effective phase last WRITTEN to the tab (write-on-change) */
    this._tabPhaseWritten = null;
    /** the tab steps aside (display:none: no box, no taps, no edge wake) */
    this._tabYield = false;
    this._lastTabText = null;
    // Baseline null so the FIRST paint never pulses; only a later RISE does.
    this._lastCount = null;
    this._pulseTimer = null;
    this._pulseCount = 0;         // total pulses fired (tests/witness probe)
    this._lastActivityMs = this._now();
    this._idle = false;
    this._idleTimer = null;
    // The depot invitation: a pure flag until the tab exists.
    this._invited = false;
  }

  /** Call one engine method when it exists; a missing engine / method is a no-op, a throwing engine is swallowed. */
  _call(engine, method, ...args) {
    if (!engine || typeof engine[method] !== 'function') return undefined;
    try { return engine[method](...args); } catch (_e) { return undefined; }
  }

  /** A guarded count read: finite and > 0, else 0. */
  _count(engine, method) {
    const v = this._call(engine, method);
    return (Number.isFinite(v) && v > 0) ? v : 0;
  }

  /** The REFIT section is live only while the shell is enabled on F1. */
  _refitOn() {
    return this._enabled && this._floor === 1;
  }

  isOpen() { return this._open; }

  /** True = LEFT, on EVERY floor (the drawer never moves). The hub's `_syncWorkbenchPanes` signs the camera bias and callout insets from it. */
  isLeft() { return this._left; }

  /**
   * The pane's laid-out width in CSS px (border-box: the clamp(380px, 28vw, 440px) times the HUD scale on a big
   * screen); 0 headless or before the root is built, never NaN. main.js hands it to
   * `CameraSystem.setLadderPaneInset` (signed by `isLeft()`: +w left, -w right) and `motherCallouts.setPaneInsets`
   * on the onOpenChange edge. A layout read: edges only, never per frame.
   * @returns {number}
   */
  widthPx() {
    const root = this._root;
    if (!root) return 0;
    // The DRAWN width: offsetWidth ignores a CSS scale on the box, getBoundingClientRect() does not (the slide
    // translate never changes a width). Fake / headless roots without a rect fall back to offsetWidth.
    let w = NaN;
    if (typeof root.getBoundingClientRect === 'function') {
      try { const r = root.getBoundingClientRect(); w = r ? r.width : NaN; } catch (_e) { w = NaN; }
    }
    if (!(Number.isFinite(w) && w > 0)) w = root.offsetWidth;
    return (Number.isFinite(w) && w > 0) ? w : 0;
  }

  /**
   * Controller engage / disengage (every floor). On: build lazily, enable the SPECS engine, enable the REFIT engine
   * iff the floor is 1, tab display:block, refresh. Off: close(), both engines disabled, tab display:none. Idempotent.
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
   * The controller's floor write, at EVERY floor apply, before any open. The REFIT section is enabled iff floor === 1;
   * the tab is PINNED awake iff floor === 1 (else the edge-chrome phase rules); the count repaints; and the FLOOR
   * LAYOUT applies write-on-change (§13 r1). setFloor never moves the anchor side: the one edge stays open/close-owned.
   * @param {number} floor
   */
  setFloor(floor) {
    const f = Number(floor);
    this._floor = Number.isFinite(f) ? f : null;
    if (this._enabled) this._call(this._refit, 'setEnabled', this._floor === 1);
    this._setTabPinned(this._floor === 1);
    this._applyFloorLayout();
    this._paintTab();
  }

  /**
   * The hub's per-frame EDGE-CHROME write (`edgeChrome.phase('tab', now)`). Effective phase = pinned OR open →
   * 'awake', else this phase: 'awake' → opacity 1 + visible; 'fading' → opacity RAIL_GEOMETRY.IDLE_FADE (the CSS
   * `transition: opacity EDGE_FADE_MS` ramps); 'hidden' (or unknown) → visibility hidden. Write-on-change.
   * @param {'awake'|'fading'|'hidden'} phase
   */
  setTabPhase(phase) {
    const ph = (phase === 'awake' || phase === 'fading') ? phase : 'hidden';
    if (ph === this._chromePhase) { this._applyTabPhase(); return; }
    this._chromePhase = ph;
    this._applyTabPhase();
  }

  /**
   * Step the SPECS tab aside (or back): the plate and its hit layer take no box and no taps (`display:none`, so an
   * edge wake cannot show them either). Write-on-change; the hub calls it once a frame.
   * @param {boolean} on
   */
  setTabYield(on) {
    on = !!on;
    if (on === this._tabYield) return;
    this._tabYield = on;
    this._applyTabShown();
  }

  /**
   * ENTRY-LESS open (tab / Space / swipe / flick / restore). No-op while disabled. ORDER MATTERS: the REFIT engine
   * opens FIRST (`{ firstVisit: true }` focuses the RECOMMENDED card) so the SPECS engine's subject adopt sees it.
   * @param {{ firstVisit?: boolean }} [opts] - forwarded to refit.open
   */
  open(opts) {
    if (!this._enabled || this._disposed) return;
    if (this._refitOn()) this._call(this._refit, 'open', opts);
    this._call(this._library, 'open');
    this._settle();
  }

  /**
   * Deep link (REFIT title, RELATED chip, ticker chip, the hub's follow): `library.openEntry(id, opts)` keeps the
   * click anchor; the shell NEVER calls `library.open()` on this path. A closed shell opens (the REFIT engine too,
   * when enabled); an open one retargets in place (ONE open edge). While disabled the engine stores the entry for the
   * next open and the shell stays shut.
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
   * The F1 click verb: a hull part / callout-card click shows the part's dossier. The REFIT engine focuses its
   * subsystem, the SPECS engine opens the part's entry with `via` = the clicked callout name and the click anchor
   * (portrait: `part.screen` + `part.bounds` + `partId`; an off-screen part still carries `{ partId }`), the shell
   * opens if closed. The unlock request (`library.scanPart(part)`, immediate) goes FIRST, so the first paint of the
   * entry is already the unlocked page (owner 2026-10-28: a fitted part always opens its full entry). A part without an entry lands the
   * dossier on the subject (`library.open()`). Null part → no-op.
   * @param {{ id?:string, name?:string, codexId?:string|null, screen?:{x:number,y:number}|null, bounds?:object|null }|null} part
   */
  showPart(part) {
    if (!part) return;
    this._call(this._refit, 'focusPart', part);
    this._call(this._library, 'scanPart', part);
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
  }

  /** The shell's own open edge: `_open` flips, slide in, wake, tab, ONE onOpenChange(true). */
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
   * Close the pane. `_open = false` FIRST (the hub re-reads isOpen() inside the edge), then both engines close, the
   * root slides out, ONE onOpenChange(false). Idempotent.
   */
  close() {
    if (!this._open) return;
    this._open = false;
    this._disarmMainMenu();
    this._call(this._library, 'close');
    this._call(this._refit, 'close');
    this._applyOpenState();
    this._applyTabPhase();       // closed off-F1 → the tab follows the edge chrome again
    this._clearIdleTimer();
    this._paintTab();
    if (this._onOpenChange) { try { this._onOpenChange(false); } catch (_e) { /* dep */ } }
  }

  toggle() { if (this._open) this.close(); else this.open(); }

  /**
   * Forget the remembered entry while CLOSED: the hub calls it on a floor arrival / selection change while the pane
   * is shut so the next entry-less open adopts the subject.
   * @returns {boolean} true when an entry was forgotten
   */
  forgetEntry() {
    return this._call(this._library, 'forgetEntry') === true;
  }

  /**
   * A LOCKED part's entry gets an unlock request over the ONE existing path (08-workbench §2). Never opens.
   * @param {{ codexId?: string|null }|null} part
   * @returns {boolean} true when an unlock was requested
   */
  scanPart(part) {
    return this._call(this._library, 'scanPart', part) === true;
  }

  /** Repaint both engines, then the tab count (the pulse fires on a rise). On interaction edges + CODEX_UNLOCKED / CODEX_VIEWED; never per frame. */
  refresh() {
    this._call(this._library, 'refresh');
    this._call(this._refit, 'refresh');
    this._paintTab();
  }

  /**
   * The depot INVITATION on the tab: main.js's ONE DEPOT_INVITATION listener feeds the rail's notch-1 glow (WHERE)
   * AND this tab glow (WHAT: the workbench is the shop). `open` true → the tab edge wears VALUE gold with the steady
   * halo (gold never pulses); false → the resting INFO frame. Write-on-change; survives enable/disable cycles.
   * @param {boolean} open
   */
  setInvitation(open) {
    const want = !!open;
    if (want === this._invited) return;
    this._invited = want;
    this._applyInvitation();
  }

  isInvited() { return this._invited; }

  _applyInvitation() {
    if (!this._tab) return;
    if (this._invited) {
      this._tab.style.borderColor = VisualLaw.COLORS.VALUE;
      this._tab.style.boxShadow = INVITE_HALO;
    } else {
      this._tab.style.borderColor = 'rgba(0,204,255,0.4)';             // the resting INFO frame
      this._tab.style.boxShadow = 'none';
    }
  }

  /** Remove every node + timer; the instance stays inert. The close edge fires only if the pane was open, and observes isOpen() === false. */
  dispose() {
    this._disposed = true;
    if (this._offGlassLabel) { this._offGlassLabel(); this._offGlassLabel = null; }
    this._clearIdleTimer();
    this._clearPulseTimer();
    this._disarmMainMenu();
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
    this._menuBtn = null;
    this._built = false;
    this._lastTabText = null;
    this._tabPhaseWritten = null;
  }

  /** Effective reduced-motion read (dep overrides the house probe). */
  _reducedMotion() {
    const dep = this._reducedMotionDep;
    if (typeof dep === 'function') { try { return !!dep(); } catch (_e) { return false; } }
    if (typeof dep === 'boolean') return dep;
    return _prefersReducedMotion();
  }

  /**
   * The tab's CSS `bottom` inside the pane root: the footer band's bottom minus the root bottom IN FORCE, never
   * negative, so the plate stays inside the 132–164 band (132 → 36 off F1, 116 on F1).
   */
  _tabBottomCss() {
    return Math.max(0, Math.round(this._footerBottomPx - this._rootBottomInForce()));
  }

  /** The SPECS tab's TAP height: 44 on glass, the footer band's 32 otherwise. */
  _tabHitPx() {
    return this._glass ? RAIL_GEOMETRY.TOUCH_PITCH_PX : RAIL_GEOMETRY.FOOTER_BAND_PX;
  }

  /** How far the hit layer reaches past the plate's top and bottom edge: (44 - 32) / 2 = 6 on glass, 0 off. */
  _tabHitOutsetPx() {
    return (this._tabHitPx() - RAIL_GEOMETRY.FOOTER_BAND_PX) / 2;
  }

  /** The root bottom in force: F1 → 16, else 96. */
  _rootBottomInForce() {
    return this._floor === 1 ? ROOT_BOTTOM_PX_F1 : ROOT_BOTTOM_PX;
  }

  /**
   * The F1 floor layout (§13 r1), write-on-change: the root's `bottom`, the body's fill vs shrink-wrap, and the tab's
   * `bottom` (the footer band never moves). `_build` bakes the initial values; only a real F1↔F2+ change re-writes.
   */
  _applyFloorLayout() {
    const f1 = this._floor === 1;
    if (f1 === this._floorLayoutWritten) return;
    this._floorLayoutWritten = f1;
    const root = this._root;
    if (!root) return;
    root.style.bottom = `${this._rootBottomInForce()}px`;
    const body = this._body;
    if (body) {
      body.style.height = f1 ? '100%' : 'auto';
      body.style.maxHeight = f1 ? 'none' : '100%';
    }
    const tab = this._tab;
    if (tab) tab.style.bottom = `${this._tabBottomCss()}px`;
    if (this._menuBtn) this._menuBtn.style.display = f1 ? 'block' : 'none';
    if (!f1) this._disarmMainMenu();
  }

  /** The MAIN MENU button's tap. Unarmed (or past the window) → arm and relabel; a second tap inside MAIN_MENU_ARM_MS
   *  → disarm and, if `canLeave`, call `onMainMenu` once; if it cannot, say so for MAIN_MENU_REFUSED_MS and call nothing. */
  _tapMainMenu() {
    const now = this._now();
    if (this._menuArmedAt !== null && now - this._menuArmedAt <= MAIN_MENU_ARM_MS) {
      this._disarmMainMenu();
      if (!this._leaveAllowed()) { this._refuseMainMenu(); return; }
      if (this._onMainMenu) { try { this._onMainMenu(); } catch (_e) { /* dep */ } }
      return;
    }
    this._clearMenuRefusal();
    this._menuArmedAt = now;
    if (this._menuBtn) this._menuBtn.textContent = MAIN_MENU_ARMED_LABEL;
    if (this._menuTimer) clearTimeout(this._menuTimer);
    this._menuTimer = setTimeout(() => this._disarmMainMenu(), MAIN_MENU_ARM_MS);
    if (this._menuTimer && typeof this._menuTimer.unref === 'function') this._menuTimer.unref();
  }

  /** May the game go to the menu now (a dep that throws counts as yes)? */
  _leaveAllowed() {
    if (!this._canLeave) return true;
    try { return !!this._canLeave(); } catch (_e) { return true; }
  }

  /** The second tap found the move refused: the label says why, then goes back. */
  _refuseMainMenu() {
    if (this._menuBtn) this._menuBtn.textContent = MAIN_MENU_REFUSED_LABEL;
    this._clearMenuRefusal(true);
    this._menuRefusedTimer = setTimeout(() => {
      this._menuRefusedTimer = null;
      if (this._menuBtn && this._menuArmedAt === null) this._menuBtn.textContent = MAIN_MENU_LABEL;
    }, MAIN_MENU_REFUSED_MS);
    if (this._menuRefusedTimer && typeof this._menuRefusedTimer.unref === 'function') this._menuRefusedTimer.unref();
  }

  /** @param {boolean} [keepLabel] leave the label as it is (the caller sets it) */
  _clearMenuRefusal(keepLabel) {
    if (this._menuRefusedTimer) { clearTimeout(this._menuRefusedTimer); this._menuRefusedTimer = null; }
    if (!keepLabel && this._menuBtn && this._menuBtn.textContent === MAIN_MENU_REFUSED_LABEL) this._menuBtn.textContent = MAIN_MENU_LABEL;
  }

  /** Back to the plain MAIN MENU label (window passed, the drawer closed, or the floor changed). */
  _disarmMainMenu() {
    this._menuArmedAt = null;
    if (this._menuTimer) { clearTimeout(this._menuTimer); this._menuTimer = null; }
    this._clearMenuRefusal(true);
    if (this._menuBtn) this._menuBtn.textContent = MAIN_MENU_LABEL;
  }

  /** Build the shell once, then mount the two engines into its slots. */
  _build() {
    if (this._built || this._disposed) return;
    const doc = this._doc;
    if (!doc || typeof doc.createElement !== 'function' || !doc.body) return;
    this._built = true;
    const reduced = this._reducedMotion();

    // The ROOT is the positioning + TRANSFORM shell: it carries the slide, the width clamp and the z layer, paints
    // nothing and takes no pointer events; the BODY and the edge TAB are its children, so the tab RIDES the
    // transform. --workbench-dir is the ONE mirror variable (-1: left-only, §13 r5): every transform and the tab's
    // side follow it. --workbench-open (0|1) is the reduced-motion tab position (see _applyOpenState).
    const f1 = this._floor === 1;
    const root = doc.createElement('div');
    root.id = 'ladder-workbench';
    root.className = reduced ? 'workbench-reduced' : '';
    root.style.cssText = [
      'position:absolute', 'left:0', 'top:56px', `bottom:${this._rootBottomInForce()}px`, `z-index:${PANE_Z_INDEX}`,
      'width:clamp(380px, 28vw, 440px)', 'box-sizing:border-box',
      'pointer-events:none', '--workbench-dir:-1', '--workbench-open:1',
      // Reduced motion swaps the slide for a fade of the BODY at the same duration; the root never moves.
      reduced
        ? ''
        : `transition:transform ${PANE_SLIDE_MS}ms cubic-bezier(0.65,0,0.35,1), opacity 400ms ease`,
    ].join(';');

    // The body: SHRINK-WRAPS its content off F1 and scrolls past the fold; on F1 it FILLS the root (§13 r1).
    // The side against the screen edge carries no border, the corners round away from it.
    const body = doc.createElement('div');
    body.className = 'workbench-body';
    body.style.cssText = [
      'position:absolute', 'top:0', 'right:0', 'left:0', f1 ? 'height:100%' : 'height:auto', f1 ? '' : 'max-height:100%', 'box-sizing:border-box',
      'padding:10px 12px', 'overflow-y:auto',
      `border:${EDGE_BORDER}`, 'border-left:none', 'border-radius:0 6px 6px 0',
      'background:rgba(0,16,32,0.82)', 'color:' + VisualLaw.COLORS.INFO,
      'font-family: var(--font-mono)', 'font-size:0.68rem', 'letter-spacing:0.05em',
      'pointer-events:auto',
      reduced ? `transition:opacity ${PANE_SLIDE_MS}ms ease` : '',
    ].join(';');
    root.appendChild(body);

    // The three section slots in order: Identity (SPECS head), Upgrade (REFIT; the engine hides it off F1), Learn
    // (SPECS tail). Real children (never innerHTML) so the engines' containers survive their neighbours' repaints.
    const head = doc.createElement('div');
    head.className = 'workbench-head';
    // The shell pads the head slot's RIGHT side past the ESC × button so the engine's right-edge chrome (LibraryPane's
    // MAXIMIZE ↗) is never under the X. 96 px ≥ the button's ~86 px width (estimate: 16 px mono 'ESC ×' + 0.15 em
    // spacing + 24 px padding + 2 px border).
    head.style.paddingRight = '96px';
    const refitSlot = doc.createElement('div');
    refitSlot.className = 'workbench-refit';
    const tail = doc.createElement('div');
    tail.className = 'workbench-tail';
    body.appendChild(head);
    body.appendChild(refitSlot);
    body.appendChild(tail);

    // MAIN MENU, the last child of the floor-1 drawer body (a touch screen has no pause screen). The close button's
    // chrome at full width; the first tap arms it, a second within MAIN_MENU_ARM_MS leaves.
    const menuBtn = doc.createElement('button');
    menuBtn.id = 'workbench-main-menu-btn';
    menuBtn.className = 'workbench-main-menu';
    menuBtn.textContent = MAIN_MENU_LABEL;
    menuBtn.setAttribute('aria-label', 'Main menu');
    menuBtn.style.cssText = [
      'display:' + (f1 ? 'block' : 'none'), 'width:100%', 'margin:18px 0 6px',
      'background:none', 'border:1px solid rgba(255,255,255,0.2)', 'color:#888',
      'font-size:16px', 'letter-spacing:0.15em', 'text-transform:uppercase',
      'cursor:pointer', 'padding:4px 12px', 'border-radius:3px',
      'font-family: var(--font-mono)', 'min-height:44px', 'box-sizing:border-box', 'pointer-events:auto',
    ].join(';');
    menuBtn.addEventListener('click', (ev) => {
      this._tapMainMenu();
      if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
    });
    body.appendChild(menuBtn);
    this._menuBtn = menuBtn;

    // The ESC × close button: the #codex-close-btn inline style (CodexViewerUI) plus the 44 px touch target, a child
    // of the ROOT at the drawer's top-right corner. The BODY is the scroll container, so a child of it would scroll
    // away with long REFIT content: the X lives on the non-scrolling shell, z-index above the body,
    // pointer-events:auto. Under reduced motion it hides with the body (_applyOpenState); otherwise it rides the
    // root's slide. NO close on outside click (clicking the ship is how parts are chosen).
    const closeBtn = doc.createElement('button');
    closeBtn.id = 'workbench-close-btn';
    closeBtn.className = 'workbench-close';
    // On glass there is no Esc key: "CLOSE ×". The hub flips glass AFTER this pane is built, so the label is
    // re-applied the moment glass turns on.
    const closeLabel = () => {
      const g = this._glass || GestureHints.isGlass();
      closeBtn.textContent = g ? 'CLOSE ×' : 'ESC ×';
      closeBtn.setAttribute('title', g ? 'Close' : 'Close (Esc)');
    };
    closeLabel();
    closeBtn.setAttribute('aria-label', 'Close');
    this._offGlassLabel = GestureHints.onGlassOn(closeLabel);
    closeBtn.style.cssText = [
      'position:absolute', 'top:0', 'right:0', 'z-index:2',
      'background:none', 'border:1px solid rgba(255,255,255,0.2)', 'color:#888',
      'font-size:16px', 'letter-spacing:0.15em', 'text-transform:uppercase',
      'cursor:pointer', 'padding:4px 12px', 'border-radius:3px',
      'font-family: var(--font-mono)', 'min-width:44px', 'min-height:44px',
      'box-sizing:border-box', 'pointer-events:auto',
    ].join(';');
    closeBtn.addEventListener('click', (ev) => {
      this.close();
      if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
    });
    root.appendChild(closeBtn);

    // The edge tab (08-workbench §2). A CHILD of the root at the pane's INNER edge: closed, the root's slide parks it
    // at the screen edge; open, it sits on the inner edge, never over the content. The side follows the mirror
    // variable: left = 50% − dir·50% and the −100 % self-translate puts the tab outside the box; under reduced
    // motion --workbench-open flips it between the screen edge (closed) and the inner edge (open) because the root
    // never moves. A HORIZONTAL plate in the FOOTER BAND's LEFT slot: `bottom` = the band's bottom minus the root's
    // bottom, height FOOTER_BAND_PX; its opacity / visibility are the edge-chrome truth table's (setTabPhase +
    // setFloor's pin), ramped by `opacity EDGE_FADE_MS` (none under reduced motion).
    const tab = doc.createElement('div');
    tab.id = 'ladder-workbench-tab';
    tab.style.cssText = [
      'position:absolute', `bottom:${this._tabBottomCss()}px`, 'z-index:1',
      'left:calc(50% - var(--workbench-dir, 1) * (2 * var(--workbench-open, 1) - 1) * 50%)',
      'transform:translateX(calc((-1 - var(--workbench-dir, 1)) * 50%))',
      `height:${RAIL_GEOMETRY.FOOTER_BAND_PX}px`, `line-height:${RAIL_GEOMETRY.FOOTER_BAND_PX - 2}px`,
      'box-sizing:border-box', 'padding:0 10px 0 12px', 'white-space:nowrap',
      `border:${EDGE_BORDER}`, 'border-left:none', 'border-radius:0 3px 3px 0', 'background:rgba(0,16,32,0.85)',
      'color:' + VisualLaw.COLORS.INFO, 'cursor:pointer',
      'font-family: var(--font-mono)', 'font-size:0.62rem', 'letter-spacing:0.08em',
      'user-select:none', 'display:none', 'pointer-events:auto',
      // The pulse animates through transition (never under reduced motion); the edge-chrome fade rides it too.
      reduced ? '' : `transition:box-shadow ${TAB_PULSE_MS / 3}ms ease, opacity ${RAIL_GEOMETRY.EDGE_FADE_MS}ms ease`,
    ].join(';');
    // Real children (never innerHTML) so the count node survives every repaint and fake-DOM docs need no querySelector.
    const tabLabel = doc.createElement('span');
    tabLabel.textContent = 'SPECS ';
    const tabCount = doc.createElement('span');
    tabCount.className = 'workbench-tab-count';
    tabCount.style.cssText = `color:${VisualLaw.COLORS.VALUE};font-weight:bold`;
    // The 44 px tap area is a TRANSPARENT child reaching past the plate's top / bottom edges; the plate stays 32 px.
    // Taps on it bubble to the tab's click handler.
    const tabHit = doc.createElement('div');
    tabHit.id = 'ladder-workbench-tab-hit';
    tabHit.className = 'workbench-tab-hit';
    tabHit.style.cssText = [
      // Placed against the tab's PADDING box (inside its 1 px border), so -1 reaches the border edge (measured: -6
      // gave 42 px, the plate's 32 + 2 x 6 less its two borders).
      'position:absolute', 'left:0', 'right:-1px',
      `top:${-(this._tabHitOutsetPx() + 1)}px`, `bottom:${-(this._tabHitOutsetPx() + 1)}px`,
      'background:transparent', 'pointer-events:auto',
    ].join(';');
    tab.appendChild(tabLabel);
    tab.appendChild(tabCount);
    tab.appendChild(tabHit);        // last: the label and the count stay children 0 and 1
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
    this._tabHit = tabHit;
    this._closeBtn = closeBtn;
    this._floorLayoutWritten = f1;  // the cssText above baked the floor layout
    this._tabPhaseWritten = null;   // the phase truth table writes the fresh tab
    this._applyTabPhase();
    this._applyOpenState();
    this._applyInvitation();        // a pre-build setInvitation lands once built

    // Delegated wake on the root, so the engines' content and the tab share it (the tab's own click toggles; here it
    // only wakes). The engines' own delegated clicks ([data-max], [data-rel], [data-buy], chips) live on their containers.
    root.addEventListener('click', () => this._wake());
    root.addEventListener('pointermove', () => this._wake());
    root.addEventListener('pointerdown', () => this._wake());

    // `onRefresh` is the tab's stale-count guard: a BUY / chip tap / related click repaints the engine, and the
    // shell's count follows on the same edge.
    const onRefresh = () => this._paintTab();
    this._call(this._library, 'mount', { head, tail, onRefresh });
    this._call(this._refit, 'mount', refitSlot, { onRefresh });
  }

  /** Enabled → block (every floor); the phase decides the rest. */
  _applyTabShown() {
    if (this._tab) {
      const css = (this._enabled && !this._tabYield) ? 'block' : 'none';
      if (this._tab.style.display !== css) this._tab.style.display = css;
    }
    this._applyTabPhase();
  }

  /** setFloor's pin: F1 → the tab is always awake; elsewhere the edge-chrome phase rules. */
  _setTabPinned(on) {
    on = !!on;
    if (on === this._tabPinned) return;
    this._tabPinned = on;
    this._applyTabPhase();
  }

  /** The pinned / open / chrome truth table → opacity + visibility, on change. */
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
   * Slide (root) / fade (body) to the current open state; the tab rides the root in the slide path and flips edges in
   * the fade path. The ESC × button tracks the BODY's fade under reduced motion and rides the slide otherwise.
   */
  _applyOpenState() {
    const root = this._root;
    if (!root) return;
    const body = this._body;
    const closeBtn = this._closeBtn;
    const reduced = this._reducedMotion();
    if (reduced) {
      root.className = 'workbench-reduced';
      root.style.transform = 'none';              // the root never moves: the fade is the body's
      root.style.visibility = 'visible';
      if (body) {
        body.style.opacity = this._open ? '1' : '0';
        body.style.visibility = this._open ? 'visible' : 'hidden';
      }
      if (closeBtn) {
        closeBtn.style.opacity = this._open ? '1' : '0';
        closeBtn.style.visibility = this._open ? 'visible' : 'hidden';
      }
      // The tab stays visible + clickable while the body is hidden (a snap between edges; reduced motion permits it).
      _setVar(root, '--workbench-open', this._open ? '1' : '0');
    } else {
      root.className = '';
      // The pane slides out toward its anchored screen edge by exactly its width, so the tab at its inner edge parks
      // at the screen edge when closed.
      root.style.transform = this._open
        ? 'translateX(0)'
        : 'translateX(calc(var(--workbench-dir, 1) * 100%))';
      root.style.opacity = this._open ? '1' : '0.999'; // keep painted for the slide
      root.style.visibility = 'visible';
      if (body) { body.style.opacity = '1'; body.style.visibility = 'visible'; }
      if (closeBtn) { closeBtn.style.opacity = '1'; closeBtn.style.visibility = 'visible'; }
      _setVar(root, '--workbench-open', '1');
    }
  }

  /** The ONE displayed number: on F1 the gold affordable-refit count when > 0, else the unread count; off F1 the unread count. */
  _tabCountValue() {
    const affordable = (this._floor === 1) ? this._count(this._refit, 'affordableCount') : 0;
    return affordable > 0 ? affordable : this._count(this._library, 'unreadCount');
  }

  /** Tab count paint (write-on-change) + the ONE pulse on a rise. */
  _paintTab() {
    const n = this._tabCountValue();
    if (this._tabCount) {
      const text = n > 0 ? String(n) : '';
      if (text !== this._lastTabText) {
        this._tabCount.textContent = text;
        this._lastTabText = text;
      }
    }
    // Pulse ONCE on a RISE (new unlock, a fit became affordable); never on the boot baseline or a drop.
    if (this._lastCount != null && n > this._lastCount) this._pulse();
    this._lastCount = n;
  }

  /** One tab pulse. Reduced motion: no animation; the count change is the whole signal. */
  _pulse() {
    this._pulseCount++;
    if (!this._tab || this._reducedMotion()) return;
    this._tab.style.boxShadow = `0 0 12px 2px ${VisualLaw.COLORS.VALUE}`;
    if (this._tab.classList && this._tab.classList.add) this._tab.classList.add('workbench-tab-pulse');
    this._clearPulseTimer();
    this._pulseTimer = setTimeout(() => this._pulseTick(), TAB_PULSE_MS);
  }

  /** Pulse end (tests drive it directly). The invitation dress, when worn, returns (the steady halo is the rest state). */
  _pulseTick() {
    this._pulseTimer = null;
    if (!this._tab) return;
    this._tab.style.boxShadow = this._invited ? INVITE_HALO : 'none';
    if (this._tab.classList && this._tab.classList.remove) this._tab.classList.remove('workbench-tab-pulse');
  }

  _clearPulseTimer() {
    if (this._pulseTimer != null) {
      clearTimeout(this._pulseTimer);
      this._pulseTimer = null;
    }
  }

  _clearIdleTimer() {
    if (this._idleTimer != null) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  /** Activity: restore full opacity + re-arm the idle window. */
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

  _armIdleTimer() {
    this._clearIdleTimer();
    if (!this._open || !this._root || this._disposed) return;
    this._idleTimer = setTimeout(() => this._idleTick(), IDLE_FADE_MS + 20);
  }

  /**
   * The idle beat (tests drive it with an injected clock): past IDLE_FADE_MS of no activity while open → fade to
   * IDLE_FADE_OPACITY, never display:none or visibility loss; otherwise re-arm for the remainder.
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
