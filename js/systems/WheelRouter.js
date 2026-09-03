/**
 * WheelRouter.js — the Zoom Ladder's single window-capture wheel owner (S2).
 *
 * Replaces the three shipped wheel listeners (T3 — docs/ladder/02-traps.md):
 *   - InputManager window-capture listener  (js/systems/InputManager.js:296)
 *   - CameraSystem canvas listener          (js/systems/CameraSystem.js:3414)
 *   - StrategicMap own-canvas listener       (js/ui/StrategicMap.js:374)
 * All three are removed in the SAME commit this module lands; their handler
 * BODIES survive as callable methods the router dispatches to
 * (inputManager.handleArmPilotWheel, cameraSystem.handleWheelZoom,
 * strategicMap.handleWheel), so the flag-off path stays byte-identical.
 *
 * Routing recipe (T3, docs/ladder/02-traps.md §T3):
 *   1. arm-pilot STATION_KEEP branch — highest priority, verbatim (consumes).
 *   2. legacy CAMERA_ZOOM_INPUT — emitted for EVERY wheel event so the
 *      OnboardingDirector zoom-discovery beat (js/systems/OnboardingDirector.js:437)
 *      keeps firing (matches the shipped InputManager._handleWheel:329 ordering,
 *      which emitted before its arm-SK return).
 *   3. ladder active → preventDefault, then feed BY SOURCE CLASS (2026-09-01
 *      pinch-first retune, see classifyWheelSource + WHEEL_TUNE):
 *        - 'pinch'  (ctrl+wheel — macOS/iPadOS trackpad pinch — or the iPad
 *          glass pinch via routeSyntheticWheel): zooms; ctrl deltas are small,
 *          so they get WHEEL_TUNE.pinchGain (synthetic pinches arrive
 *          pre-scaled by TouchControls and skip the gain).
  *        - 'mouse'  (discrete physical wheel): zooms (mouseWheelZoom, default on).
  *        - 'scroll' (trackpad two-finger scroll): zooms (scrollZoom, default
  *          ON again since 2026-09-02 — owner: "laptop should be two-finger
  *          scroll, like before"; the 09-01 retune had muted it). The G2/G3
  *          hump + flick grammar was tuned on exactly these trackpad traces.
  *          Glass is unaffected by construction: touches never produce wheel
  *          events (TouchControls → tagged synthetic pinch), so the iPad keeps
  *          pinch; only an external trackpad on the iPad sees scroll-zoom, the
  *          same as a laptop. `window.__WHEEL_TUNE = {scrollZoom:false}`
  *          restores pinch-first live. Always consumed (preventDefault) so the
  *          page never scrolls/zooms under the game.
 *      Before the class feed, on the WORKBENCH floor only (Wave 5 Session C —
 *      08-workbench §2 "Vertical = where, Horizontal = what"): a HORIZONTAL-
 *      dominant event (|deltaX| > |deltaY|, not a pinch) is CLAIMED by the
 *      pane-swipe accumulator and never reaches the zoom feed — see
 *      _claimPaneSwipe + the paneSwipe* tunables. The classifier still reads
 *      any deltaX as 'scroll'; the claim runs first, exactly as the
 *      06-core-api Wave-5 note asked. Everywhere else the axis is fed/muted
 *      exactly as before (ladder-off byte-identical).
 * F1/F2 DOM-overlay scroll passthrough (do NOT blanket-preventDefault so the
 * shop can scroll) is an S6 concern — in M1 those floors have no active costume
 * and the ladder is gameplay-gated, so SHOP/codex overlays run under the
 * legacy dispatch below (ladder inactive) and scroll exactly as shipped.
 *
 * When `Constants.LADDER.ENABLED` is false (ships false) OR the ladder is not
 * active (non-gameplay states), the router reproduces the shipped dispatch:
 * arm-SK, then StrategicMap zoom (when open), then camera zoom (canvas only).
 *
 * @module systems/WheelRouter
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';

/** One wheel notch ≈ 100 px of deltaY in the default pixel delta mode.
 *  EXPORTED (with MAX_MAG) as the single source of notch scale: TouchControls
 *  builds synthetic deltas and its tests derive bounds from these — a retune
 *  here must rescale touch input in lockstep, never silently diverge. */
export const NOTCH_PX = 100;
/** deltaMode 1 (DOM_DELTA_LINE): approximate one line as this many px. */
const LINE_PX = 16;
/** Per-event magnitude cap. The core does NOT bound per-event travel
 *  (06-core-api.md S1 notes) — bounding mag is the ROUTER's obligation, so one
 *  oversized trackpad flick can't leap the whole floor in a single event. */
export const MAX_MAG = 4;

/**
 * Wheel-source tuning (owning-module tunables, house rule). Field-overridable
 * live via `window.__WHEEL_TUNE` (same doctrine as TouchControls'
 * __TOUCH_TUNE — a gentler profile is a wrapper concern, not a fork).
 *
 * The 2026-09-01 pinch-first retune: deliberate PINCH is the ladder zoom
 * gesture on trackpads (laptop + iPad Magic Keyboard). Two-finger scroll had
 * the classic failure — every incidental scroll gesture rocketed through
 * floors — so 'scroll' shipped muted for one day. Physical mouse wheels keep
 * zooming: their discrete detents are the original ladder instrument (00-spec §0).
 *
 * 2026-09-02 owner flip: 'scroll' zooms again on the laptop ("like before") —
 * the G3 flick grammar (rising-mag detector, tail rejection, 800 ms undo) is
 * what actually tamed the rocketing, and it was tuned on real trackpad scroll
 * traces. Pinch stays on everywhere; glass never emits wheel events, so the
 * iPad is untouched. Pinch-first is one override away: `{scrollZoom:false}`.
 */
export const WHEEL_TUNE = {
  pinchZoom: true,      // ctrl+wheel (trackpad pinch) + iPad glass pinch drive the ladder
  pinchGain: 4.0,       // browsers emit small ctrl+wheel deltas per pinch frame — scale to notch feel
  mouseWheelZoom: true, // discrete physical wheel detents keep zooming
  scrollZoom: true,     // trackpad two-finger scroll zooms (owner flip 2026-09-02; was muted 09-01)
  mouseIntThresholdPx: 80, // pixel-mode integer |deltaY| at/over this reads as a mouse detent
  gesturePxPerScale: 300,  // WebKit GestureEvent bridge: px of wheel deltaY per 1.0 of e.scale change
  // ── Horizontal pane swipe (Wave 5 Session C; workbench floor F3 only) ──
  paneSwipe: true,      // claim |deltaX| > |deltaY| events on F3 and page the panes ({paneSwipe:false} → fed as scroll, the pre-Session-C axis)
  paneSwipePx: 140,     // accumulated |deltaX| (px, one gesture) that fires ONE page verb — a deliberate short flick, never an incidental drift
  paneSwipeSign: 1,     // +1: positive deltaX (a two-finger swipe LEFT under natural scrolling — content follows the finger) pages toward the RIGHT pane (LIBRARY); −1 flips (owner decision 3, 2026-09-03)
  paneSwipeGapMs: 220,  // silence on the horizontal axis ≥ this ends the gesture: accumulator resets, the one-verb latch releases (a momentum tail never pages twice)
};

/**
 * Classify a wheel event's physical source. Pure + exported for the suite.
 *
 *   'pinch'  — ctrlKey (the cross-browser trackpad-pinch synthesis on
 *              macOS/iPadOS/Windows; a real Ctrl+mousewheel lands here too,
 *              which conveniently gives mice a guaranteed zoom modifier), or
 *              the router's own synthetic iPad glass pinch
 *              (routeSyntheticWheel tags __syntheticPinch).
 *   'mouse'  — non-pixel deltaMode (line/page = discrete wheel, e.g. Firefox
 *              mice), or a pixel-mode integer detent at/over
 *              tune.mouseIntThresholdPx with no horizontal component
 *              (Chromium mice emit ±100·k; trackpads emit small/fractional
 *              deltas and usually some deltaX).
 *   'scroll' — everything else: trackpad two-finger scroll / momentum.
 *
 * Heuristic honesty: a violent trackpad fling can produce a large integer
 * deltaY and read as 'mouse' for one event — MAX_MAG bounds the damage to a
 * fraction of a floor. Tune the threshold rather than fork the rule.
 *
 * @param {WheelEvent|object} e
 * @param {typeof WHEEL_TUNE} [tune]
 * @returns {'pinch'|'mouse'|'scroll'}
 */
export function classifyWheelSource(e, tune = WHEEL_TUNE) {
  if (e.ctrlKey || e.__syntheticPinch) return 'pinch';
  if (e.deltaMode !== 0) return 'mouse';
  if (e.deltaX) return 'scroll';
  const dy = e.deltaY || 0;
  const thr = Number.isFinite(tune.mouseIntThresholdPx)
    ? tune.mouseIntThresholdPx : WHEEL_TUNE.mouseIntThresholdPx;
  return (Number.isInteger(dy) && Math.abs(dy) >= thr) ? 'mouse' : 'scroll';
}

/**
 * Normalize a WheelEvent's deltaY to notch-scale ladder input, applying the
 * invert setting. "Router-normalized wheel magnitude" = notch-scale units
 * (≈ 1 per notch), NOT raw deltaY (06-core-api.md S1 notes).
 *
 * Direction (00-spec.md §4 "scroll up = zoom in"): deltaY < 0 (wheel up) → 'in'.
 *
 * @param {WheelEvent} e
 * @param {boolean} invert
 * @returns {{dir: 'in'|'out', mag: number}} mag >= 0 (0 = ignore)
 */
export function normalizeWheel(e, invert) {
  let dy = e.deltaY || 0;
  if (e.deltaMode === 1) dy *= LINE_PX;          // lines → px
  else if (e.deltaMode === 2) dy *= NOTCH_PX * 3; // pages → a few notches
  const notches = dy / NOTCH_PX;
  let dir = notches < 0 ? 'in' : 'out';
  if (invert) dir = dir === 'in' ? 'out' : 'in';
  const mag = Math.min(MAX_MAG, Math.abs(notches));
  return { dir, mag };
}

/**
 * Is this wheel event HORIZONTAL-dominant — the pane axis (08-workbench §2
 * "Horizontal = what")? Pure + exported for the suite. Pinches (ctrl or the
 * tagged synthetic glass pinch) are ZOOM whatever their axis and never
 * qualify; a tie (|dx| == |dy|, incl. 0/0) is vertical (the settled grammar
 * keeps every event it had).
 * @param {WheelEvent|object} e
 * @returns {boolean}
 */
export function isHorizontalWheel(e) {
  if (e.ctrlKey || e.__syntheticPinch) return false;
  const dx = e.deltaX || 0, dy = e.deltaY || 0;
  return Math.abs(dx) > Math.abs(dy);
}

/**
 * A wheel event's deltaX in CSS px (the same deltaMode scaling normalizeWheel
 * applies to deltaY: lines × LINE_PX, pages × 3 notches). Pure.
 * @param {WheelEvent|object} e
 * @returns {number}
 */
export function wheelDeltaXPx(e) {
  let dx = e.deltaX || 0;
  if (e.deltaMode === 1) dx *= LINE_PX;
  else if (e.deltaMode === 2) dx *= NOTCH_PX * 3;
  return dx;
}

/**
 * The pane-swipe accumulator law (Wave 5 Session C) as a pure step, so the
 * suite pins it headless and the router just applies it: one gesture = the
 * run of horizontal events with gaps < gapMs; the signed deltaX px sum
 * crossing ±thresholdPx fires ONE verb and LATCHES the gesture (its tail —
 * the finger still moving, the platform's momentum events — is eaten, never
 * a second page); a gap ≥ gapMs starts a fresh gesture. Reversals inside a
 * gesture cancel (the sum is signed). `toward` is a SCREEN side: with sign
 * +1 a positive sum (natural-scrolling swipe LEFT) pages toward the RIGHT
 * pane — the LIBRARY — content following the finger; sign −1 flips.
 *
 * @param {{ acc:number, lastMs:number, latched:boolean }} s - gesture state (mutated + returned)
 * @param {number} dxPx  - this event's deltaX in px
 * @param {number} tMs   - this event's clock
 * @param {{ paneSwipePx:number, paneSwipeSign:number, paneSwipeGapMs:number }} tune
 * @returns {'left'|'right'|null} the ONE verb to emit, or null
 */
export function stepPaneSwipe(s, dxPx, tMs, tune) {
  const gap = Number.isFinite(tune.paneSwipeGapMs) ? tune.paneSwipeGapMs : WHEEL_TUNE.paneSwipeGapMs;
  const thr = Number.isFinite(tune.paneSwipePx) ? tune.paneSwipePx : WHEEL_TUNE.paneSwipePx;
  const sign = (tune.paneSwipeSign === -1) ? -1 : 1;
  if (tMs - s.lastMs >= gap) { s.acc = 0; s.latched = false; }   // a new gesture
  s.lastMs = tMs;
  if (s.latched) return null;                                      // the flick already paged: eat the tail
  s.acc += dxPx;
  if (Math.abs(s.acc) < thr) return null;
  const toward = (s.acc * sign) > 0 ? 'right' : 'left';
  s.acc = 0;
  s.latched = true;
  return toward;
}

export class WheelRouter {
  /**
   * @param {object} deps
   * @param {HTMLCanvasElement} [deps.canvas]        - the game canvas (game-canvas)
   * @param {object} [deps.inputManager]  - provides handleArmPilotWheel(e) -> boolean
   * @param {object} [deps.cameraSystem]  - provides handleWheelZoom(e) (legacy zoom)
   * @param {object} [deps.strategicMap]  - provides isOpen() + handleWheel(e)
   * @param {object} [deps.ladderController] - provides isActive() + wheel({tMs,dir,mag});
   *   Session C (optional, duck-typed): wantsPaneSwipe() + pagePane({tMs,toward}) for the
   *   F3 horizontal pane swipe — absent, horizontal events flow to the zoom feed as before
   * @param {function} [deps.now] - monotonic clock (ms); defaults to performance.now
   */
  constructor(deps = {}) {
    this._canvas = deps.canvas || null;
    this._inputManager = deps.inputManager || null;
    this._cameraSystem = deps.cameraSystem || null;
    this._strategicMap = deps.strategicMap || null;
    this._ladder = deps.ladderController || null;
    this._now = deps.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this._onWheel = this._handleWheel.bind(this);
    this._onGestureStart = this._handleGestureStart.bind(this);
    this._onGestureChange = this._handleGestureChange.bind(this);
    this._onGestureEnd = this._handleGestureEnd.bind(this);
    /** @type {?number} last GestureEvent scale while a WebKit pinch is live */
    this._gestureScale = null;
    /** Pane-swipe gesture state (Session C): signed deltaX px sum, the last
     *  horizontal event's clock, and the one-verb-per-flick latch. */
    this._swipe = { acc: 0, lastMs: -Infinity, latched: false };
    this._started = false;
  }

  /** Register the single window-capture wheel listener. */
  start() {
    if (this._started || typeof window === 'undefined') return;
    window.addEventListener('wheel', this._onWheel, { passive: false, capture: true });
    // WebKit pinch bridge (Safari on macOS + the iPad Magic Keyboard trackpad
    // in the WebClip): Safari does NOT synthesize ctrl+wheel for trackpad
    // pinches — it fires proprietary GestureEvents instead. Bridge them into
    // the same pinch class. Glass pinches never double-dispatch: TouchControls
    // preventDefaults touchstart on the canvas, which suppresses the derived
    // GestureEvents for that touch sequence (the bridge then only ever sees
    // trackpad pinches). Feature-gated: Chromium/Firefox have no GestureEvent.
    if (typeof window.GestureEvent === 'function') {
      window.addEventListener('gesturestart', this._onGestureStart, { passive: false, capture: true });
      window.addEventListener('gesturechange', this._onGestureChange, { passive: false, capture: true });
      window.addEventListener('gestureend', this._onGestureEnd, { passive: false, capture: true });
    }
    this._started = true;
  }

  /** Remove the listener. */
  stop() {
    if (!this._started || typeof window === 'undefined') return;
    window.removeEventListener('wheel', this._onWheel, { capture: true });
    if (typeof window.GestureEvent === 'function') {
      window.removeEventListener('gesturestart', this._onGestureStart, { capture: true });
      window.removeEventListener('gesturechange', this._onGestureChange, { capture: true });
      window.removeEventListener('gestureend', this._onGestureEnd, { capture: true });
    }
    this._gestureScale = null;
    this._started = false;
  }

  /** Live invert setting (00-spec.md §4). */
  _invert() {
    return !!(Constants.LADDER && Constants.LADDER.INVERT_SCROLL);
  }

  /**
   * Live tuning view: WHEEL_TUNE unless a window.__WHEEL_TUNE override exists
   * (merged, override wins). Allocation-free on the un-overridden hot path.
   * @private @returns {typeof WHEEL_TUNE}
   */
  _tune() {
    const w = (typeof window !== 'undefined' && window.__WHEEL_TUNE) || null;
    return w ? { ...WHEEL_TUNE, ...w } : WHEEL_TUNE;
  }

  /** True when wheel input belongs to the ladder core (flag on + active). */
  _ladderOwnsWheel() {
    return !!(Constants.LADDER && Constants.LADDER.ENABLED &&
      this._ladder && this._ladder.isActive && this._ladder.isActive());
  }

  /**
   * Touch bridge (iPad port — Ipad.md §5.1 "same code path" doctrine): route a
   * SYNTHETIC wheel of `deltaY` px through the exact dispatch recipe below, so
   * pinch gestures and on-screen zoom buttons inherit every routing rule —
   * arm-SK priority, StrategicMap ownership, ladder active/inactive, and the
   * legacy canvas-only camera zoom — without growing a second input path.
   *
   * @param {number} deltaY  px, wheel convention (negative = zoom in)
   * @param {EventTarget|null} [target]  event target for the canvas-only
   *   legacy branch; defaults to the game canvas so camera zoom still works
   *   when the ladder is off.
   */
  routeSyntheticWheel(deltaY, target = this._canvas) {
    if (!Number.isFinite(deltaY) || deltaY === 0) return;
    this._handleWheel({
      deltaY,
      deltaMode: 0,
      ctrlKey: false,
      // Source tag: the iPad glass pinch (TouchControls) IS a pinch — the
      // classifier must never mute it as 'scroll'. It arrives pre-scaled
      // (TOUCH_TUNE.pinchGain + clamp), so the router's ctrl-pinch gain is
      // NOT applied to tagged synthetics.
      __syntheticPinch: true,
      target,
      preventDefault() {},
      stopPropagation() {},
    });
  }

  /**
   * The single wheel handler. Public for tests (call with a fake event).
   * @param {WheelEvent} e
   */
  _handleWheel(e) {
    // (2) legacy onboarding signal — always, before anything consumes the event.
    eventBus.emit(Events.CAMERA_ZOOM_INPUT);

    // (1) arm-pilot STATION_KEEP — highest priority, consumes verbatim.
    if (this._inputManager && this._inputManager.handleArmPilotWheel &&
        this._inputManager.handleArmPilotWheel(e)) {
      return;
    }

    if (this._ladderOwnsWheel()) {
      // (3): the ladder owns the event wholesale — consume it first (page must
      // never scroll or browser-zoom under an engaged ladder), then feed by
      // source class (pinch-first retune; see WHEEL_TUNE).
      if (typeof e.preventDefault === 'function') e.preventDefault();
      const tune = this._tune();
      // Session C: on the workbench floor the HORIZONTAL axis is the pane
      // axis — a horizontal-dominant event is claimed here, BEFORE the class
      // feed, and never reaches the zoom core (06-core-api Wave-5 note).
      if (this._claimPaneSwipe(e, tune)) return;
      const src = classifyWheelSource(e, tune);
      const feed = src === 'pinch' ? tune.pinchZoom
        : src === 'mouse' ? tune.mouseWheelZoom
        : tune.scrollZoom;
      if (!feed) return; // muted class (an override, e.g. {scrollZoom:false}) — consumed, not fed
      // ctrl-pinch deltas are tiny per frame — scale toward notch feel.
      // Tagged synthetic pinches (iPad glass) arrive pre-scaled: gain 1.
      const ev = (src === 'pinch' && e.ctrlKey)
        ? { deltaY: (e.deltaY || 0) * (Number.isFinite(tune.pinchGain) ? tune.pinchGain : 1), deltaMode: 0 }
        : e;
      const { dir, mag } = normalizeWheel(ev, this._invert());
      if (mag > 0) {
        this._ladder.wheel({ tMs: this._now(), dir, mag });
      }
      return;
    }

    // ── Ladder off / inactive: byte-identical shipped dispatch ──────────────
    if (this._strategicMap && this._strategicMap.isOpen && this._strategicMap.isOpen()) {
      // Strategic map renders onto the SAME canvas as the game; its shipped
      // listener preventDefaults + zooms the map. (The shipped CameraSystem
      // canvas listener also fired here but only mutated an unrendered
      // orbit.distance — invisible; not reproduced.)
      if (this._strategicMap.handleWheel) this._strategicMap.handleWheel(e);
      return;
    }
    // Camera zoom only when the event actually lands on the game canvas — a DOM
    // overlay covering the canvas swallowed the shipped canvas listener and let
    // the page scroll, which this preserves.
    if (this._cameraSystem && this._cameraSystem.handleWheelZoom && this._onCanvas(e)) {
      this._cameraSystem.handleWheelZoom(e);
    }
  }

  /** @private Whether the event's target is (within) the game canvas. */
  _onCanvas(e) {
    if (!this._canvas) return false;
    const t = e && e.target;
    if (t === this._canvas) return true;
    return !!(t && typeof this._canvas.contains === 'function' && this._canvas.contains(t));
  }

  // ── Horizontal pane swipe (Wave 5 Session C, 08-workbench §2 grammar) ─────

  /**
   * Claim a HORIZONTAL-dominant wheel event for the workbench panes. Runs on
   * the ladder-owned path only (the caller has already preventDefaulted).
   * Returns true when the event belongs to the pane axis — the caller then
   * returns WITHOUT feeding the zoom core — and false when the event is the
   * zoom grammar's (vertical-dominant, a pinch, the tunable off, or the hub
   * says the swipe is not live: off the workbench floor, no pane deps, or a
   * controller without `wantsPaneSwipe`). The accumulator law is the pure
   * `stepPaneSwipe`; a verb reaches `ladderController.pagePane({tMs,
   * toward})` ONCE per flick (the router decides WHEN, the hub decides WHAT).
   * Byte-identical everywhere the claim declines: the event flows on exactly
   * as before this session.
   * @private
   * @param {WheelEvent} e
   * @param {typeof WHEEL_TUNE} tune
   * @returns {boolean} claimed
   */
  _claimPaneSwipe(e, tune) {
    if (!tune.paneSwipe || !isHorizontalWheel(e)) return false;
    const lc = this._ladder;
    if (!lc || typeof lc.wantsPaneSwipe !== 'function' || !lc.wantsPaneSwipe()) return false;
    const t = this._now();
    const toward = stepPaneSwipe(this._swipe, wheelDeltaXPx(e), t, tune);
    if (toward && typeof lc.pagePane === 'function') lc.pagePane({ tMs: t, toward });
    return true;
  }

  // ── WebKit GestureEvent pinch bridge (Safari / iPad trackpad) ──────────────

  /** @private Pinch begins: e.scale starts at 1. Consume so the page never zooms. */
  _handleGestureStart(e) {
    if (typeof e.preventDefault === 'function') e.preventDefault();
    this._gestureScale = Number.isFinite(e.scale) ? e.scale : 1;
  }

  /**
   * Pinch frame: scale delta since the last frame → a tagged synthetic pinch
   * through the ONE dispatch recipe (spread = scale up = zoom in = negative
   * deltaY, matching both the wheel convention and TouchControls' glass math).
   * Public shape for tests (call with { scale, target, preventDefault }).
   * @private
   */
  _handleGestureChange(e) {
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (this._gestureScale == null || !Number.isFinite(e.scale)) return;
    const dScale = e.scale - this._gestureScale;
    if (dScale === 0) return;
    this._gestureScale = e.scale;
    const tune = this._tune();
    const px = Number.isFinite(tune.gesturePxPerScale)
      ? tune.gesturePxPerScale : WHEEL_TUNE.gesturePxPerScale;
    this.routeSyntheticWheel(-dScale * px, (e && e.target) || this._canvas);
  }

  /** @private */
  _handleGestureEnd(e) {
    if (typeof e.preventDefault === 'function') e.preventDefault();
    this._gestureScale = null;
  }
}
