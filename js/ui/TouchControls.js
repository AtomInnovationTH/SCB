/**
 * TouchControls.js — the iPad / touch-glass input layer (Phase 1 of the port,
 * see Ipad.md; Phase 4 rail-drag added post-play-test).
 *
 * Scope (deliberately small): the two verbs a sealed-iPad build needs to be a
 * watchable, explorable sim —
 *   1. ZOOM between Zoom-Ladder floors, two ways, both one-handed:
 *        a. two-finger PINCH on the game canvas → synthetic wheel through
 *           `WheelRouter.routeSyntheticWheel(...)`, the SAME dispatch recipe as
 *           the physical wheel (Ipad.md §5.1 "one behavior, two triggers"), so
 *           arm-SK priority, StrategicMap ownership, ladder active/inactive and
 *           the legacy camera zoom all keep working through one path;
 *        b. a one-finger DRAG on an invisible grip laid over the visible
 *           Zoom-Ladder rail (#ladder-rail) → `ladderController.jump({toFloor})`,
 *           the ladder's own "rail-notch jump" API. Drag to the floor you want;
 *           a dock-gated floor (DEPOT) flashes its notch instead of entering,
 *           exactly like the wheel path, because jump() runs the same wall
 *           decisions. (The old fixed +/− buttons were removed once pinch +
 *           rail-drag proved enough on glass.)
 *   2. THE TWO-THUMB GRAMMAR (Wave 5 Session J, plan D-I — no virtual stick):
 *        a. one-finger DRAG on the canvas = ship turn, by writing the PUBLIC
 *           key map `inputManager.keys` (ArrowLeft/Right/Up/Down — InputManager
 *           reads the booleans each frame; it is never edited), dead zone
 *           `turnDeadPx`; while a drawer is open on the workbench floor
 *           (`ladderController.turntableActive()`) the same drag orbits the
 *           CAMERA instead (`cameraSystem.ladderDragNudge`, D-F — the camera's
 *           drag is mouse-only, touch never reached it);
 *        b. TAP = `onTap({x, y})` — the hub resolves it (nearest target →
 *           HUD_TARGET_CLICK, else SCAN_QUICK; hull parts stay MotherCallouts');
 *        c. LONG-PRESS on the selected target (`onHold({x, y})` truthy) = the
 *           RADIAL: AUTOPILOT / NET / DAUGHTER / REEL, every button pressing the
 *           SAME key the keyboard would (`pressKey(code)`), NET and DAUGHTER
 *           hold-to-fire;
 *        d. EDGE-BAND SWIPE (24 px) opens/closes the REFIT (left) / SPECS
 *           (right) drawers through `openPane(which, open)`.
 *      Any moment with two fingers down POISONS the gesture (a pinch that
 *      starts on a part is never a tap). The STORE chip stays until Session K
 *      retires the full-screen shop; the PANES density slider and the LIBRARY
 *      chip retired with the WHAT rail + the SPECS-everywhere tab (D-H / D-C).
 *      Gameplay-gated chrome: hidden on the menu / briefing / end screens
 *      (gameState.isGameplay()).
 *
 * Optional zoom-feel telemetry (Ipad.md §6): when a `telemetry` sink is
 * injected, each pinch/rail gesture and every floor crossing is logged for
 * tuning. Purely additive — no sink, no logging.
 *
 * Gate (Ipad.md §4.5): construct this ONLY when `TouchControls.detect()` is
 * true — real touch hardware. Desktop and headless bench contexts then see
 * zero listeners, zero DOM, zero pixels by construction, keeping every
 * existing suite byte-identical.
 *
 * Runtime quirks honored (Ipad.md §3):
 *   - the canvas owns its touches (preventDefault on touchstart/move —
 *     scroll/zoom/long-press must never eat play);
 *   - idle UI FADES (never vanishes) so controls stay discoverable;
 *   - a screen wake lock is grabbed on first touch and re-grabbed on
 *     visibilitychange (locks auto-release on hide);
 *   - touch targets ≥ 44 pt, anchored inside env(safe-area-inset-*).
 *
 * Tunables live in-module (house rule) and are overridable via
 * `window.__TOUCH_TUNE` (Ipad.md §5.2 doctrine: a gentler profile is a
 * wrapper concern, not a fork).
 *
 * Node-safe: importing this file touches no window/document; everything DOM
 * happens inside start(). Pure math (`pinchWheelDeltaY`, `railFloorForY`) is
 * exported for the Node test suite.
 *
 * @module ui/TouchControls
 */

import { NOTCH_PX } from '../systems/WheelRouter.js';
import { FloorContract } from '../core/FloorContract.js';

/** Number of Zoom-Ladder floors (SSOT: FloorContract). */
const FLOOR_COUNT = FloorContract.FLOORS.length;
/** The four keys the one-finger drag may write — never any other (D-I). */
const ARROW_KEYS = Object.freeze(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

/** Field-tunable knobs (overridable, not forked — window.__TOUCH_TUNE). */
export const TOUCH_TUNE = {
  // px of wheel deltaY per px of pinch-distance change. Calibrated 2026-09-02
  // to EQUAL WheelRouter.WHEEL_TUNE.pinchGain (pinned in test-TouchControls):
  // glass and trackpad pinches must produce the same notch rate per px, because
  // the ladder's hump grammar (CHARGE_THRESHOLD 1.2 × 1.6 inbound, CHARGE_TAU
  // 250 ms, MIN_SPAN 200 ms, FLICK_MIN_MAG) was tuned on the ctrl-pinch path.
  // At the earlier 1.6 a typical 200 px glass pinch moved z01 by ~0.13 (three
  // pinches to reach a wall) and at the wall its charge peaked at ~0.67 of the
  // inbound threshold — the iPad could never cross toward the hull ("stuck on
  // F4"). At 4.0 one pinch flicks to the wall and the next crosses, both
  // directions, every floor (headless emulation, docs/ladder/08-workbench.md).
  pinchGain: 4.0,
  pinchMaxStepPx: 240, // per-event clamp (≤ 2.4 notches; router caps mag at 4)
  pinchMinStepPx: 1,   // ignore sub-px jitter
  idleFadeMs: 4000,    // controls fade (never vanish) after this idle time
  idleOpacity: 0.35,   // faded opacity
  activeOpacity: 0.92, // touched/recent opacity
  sliderSyncMs: 700,   // rail-grip + chrome re-sync cadence (the name predates the slider's retirement)
  // Session J (plan D-I) — the two-thumb grammar:
  turnDeadPx: 12,      // one-finger drag dead zone before an arrow key is written
  tapMaxMs: 250,       // a press released within this, moved ≤ tapSlopPx = TAP
  tapSlopPx: 10,       // tap / hold movement tolerance
  holdMs: 450,         // a press held this long, moved ≤ tapSlopPx = HOLD (the radial)
  fireHoldMs: 350,     // NET / DAUGHTER radial buttons fire after this hold (release before = no shot)
  radialIdleMs: 4000,  // the radial closes on its own after this
  edgeBandPx: 24,      // the drawer swipe band at the left / right canvas edge
  edgeSwipePx: 60,     // travel needed for an edge swipe to open / close a drawer
};

/** The radial's four verbs — label → the key the keyboard would press; hold-to-fire for the two shots. */
export const RADIAL_VERBS = Object.freeze([
  Object.freeze({ key: 'KeyA', label: 'AUTOPILOT', hold: false, dir: 'n' }),
  Object.freeze({ key: 'KeyN', label: 'NET', hold: true, dir: 'e' }),
  Object.freeze({ key: 'KeyD', label: 'DAUGHTER', hold: true, dir: 's' }),
  Object.freeze({ key: 'KeyR', label: 'REEL', hold: false, dir: 'w' }),
]);
/** Radial button size (px) and ring radius (px) — ≥ 44 pt targets around the finger. */
export const RADIAL_BTN_PX = 64;
export const RADIAL_RING_PX = 72;

/**
 * Pinch → synthetic wheel deltaY (px), wheel convention: spreading the fingers
 * (zoom IN) yields NEGATIVE deltaY. Clamped per event so one fast pinch frame
 * cannot leap floors (the router additionally caps mag at 4).
 *
 * @param {number} prevDist  previous two-finger distance (px)
 * @param {number} curDist   current two-finger distance (px)
 * @param {{pinchGain:number, pinchMaxStepPx:number, pinchMinStepPx:number}} [tune]
 * @returns {number} deltaY px — 0 when below the jitter floor
 */
export function pinchWheelDeltaY(prevDist, curDist, tune = TOUCH_TUNE) {
  if (!Number.isFinite(prevDist) || !Number.isFinite(curDist)) return 0;
  const raw = (prevDist - curDist) * tune.pinchGain;
  if (Math.abs(raw) < tune.pinchMinStepPx) return 0;
  const cap = Math.abs(tune.pinchMaxStepPx) || NOTCH_PX;
  return Math.max(-cap, Math.min(cap, raw));
}

/**
 * Finger Y → target Zoom-Ladder floor id (1..count) for the invisible rail
 * grip. The rail (#ladder-rail) is column-reverse: F1 (innermost, zoom-in) sits
 * at the BOTTOM, floor `count` (outermost, zoom-out) at the TOP — so the top of
 * the rail maps to the highest floor. Even spacing over the rail's box, rounded
 * to the nearest notch, clamped to [1, count]. Pure + exported for the suite.
 *
 * @param {number} clientY  touch Y (viewport px)
 * @param {number} topY     rail bounding-rect top (px)
 * @param {number} bottomY  rail bounding-rect bottom (px)
 * @param {number} count    floor count (FLOOR_COUNT)
 * @returns {number} floor id 1..count (1 on degenerate input)
 */
export function railFloorForY(clientY, topY, bottomY, count = FLOOR_COUNT) {
  if (!Number.isFinite(clientY) || !(bottomY > topY) || !(count >= 1)) return 1;
  const fromBottom = (bottomY - clientY) / (bottomY - topY); // 0 at bottom, 1 at top
  const idx = Math.round(Math.max(0, Math.min(1, fromBottom)) * (count - 1));
  return idx + 1;
}

/**
 * Session J (D-I): one-finger drag → the arrow keys the SHIP would read.
 * Dead zone `deadPx` from the touch start; the dominant axis alone unless
 * both axes exceed the dead zone (a diagonal drag turns both). Pure.
 * @param {number} dx  finger x − start x (px; right positive)
 * @param {number} dy  finger y − start y (px; down positive)
 * @param {number} deadPx
 * @returns {{ArrowLeft:boolean, ArrowRight:boolean, ArrowUp:boolean, ArrowDown:boolean}}
 */
export function turnKeysFor(dx, dy, deadPx) {
  const out = { ArrowLeft: false, ArrowRight: false, ArrowUp: false, ArrowDown: false };
  const d = Number.isFinite(deadPx) && deadPx >= 0 ? deadPx : TOUCH_TUNE.turnDeadPx;
  const ax = Number.isFinite(dx) ? Math.abs(dx) : 0;
  const ay = Number.isFinite(dy) ? Math.abs(dy) : 0;
  const xOn = ax > d, yOn = ay > d;
  if (!xOn && !yOn) return out;
  const both = xOn && yOn;
  if (xOn && (both || ax >= ay)) { if (dx < 0) out.ArrowLeft = true; else out.ArrowRight = true; }
  if (yOn && (both || ay > ax)) { if (dy < 0) out.ArrowUp = true; else out.ArrowDown = true; }
  return out;
}

/**
 * Session J (D-I): classify a finished one-finger track. Pure — the live
 * dispatcher records the track and asks this at release (the HOLD itself fires
 * on a timer while the finger is still down; 'hold' here is the release of a
 * press that lasted ≥ holdMs without moving).
 * @param {{startX:number,startY:number,x:number,y:number,t0:number,t:number,maxTouches?:number,moved?:number}} track
 * @param {object} [tune=TOUCH_TUNE]
 * @param {number} [canvasWidth=Infinity] CSS px — needed for the right edge band
 * @returns {'tap'|'hold'|'drag'|'edge-open-left'|'edge-open-right'|'edge-close-left'|'edge-close-right'|'pinch'|null}
 */
export function classifyGesture(track, tune = TOUCH_TUNE, canvasWidth = Infinity) {
  if (!track) return null;
  if ((track.maxTouches || 1) >= 2) return 'pinch';
  const T = tune || TOUCH_TUNE;
  const W = Number.isFinite(canvasWidth) ? canvasWidth : Infinity;
  const dx = track.x - track.startX;
  const moved = Number.isFinite(track.moved) ? track.moved : Math.hypot(dx, track.y - track.startY);
  const dt = track.t - track.t0;
  const band = T.edgeBandPx, swipe = T.edgeSwipePx;
  const startL = track.startX <= band, startR = Number.isFinite(W) && track.startX >= W - band;
  if (startL && dx >= swipe) return 'edge-open-left';
  if (startR && -dx >= swipe) return 'edge-open-right';
  if (!startL && track.x <= band && -dx >= swipe) return 'edge-close-left';
  if (!startR && Number.isFinite(W) && track.x >= W - band && dx >= swipe) return 'edge-close-right';
  if (startL || startR) return null;                 // a band press that never swiped: nothing
  if (moved <= T.tapSlopPx) {
    if (dt <= T.tapMaxMs) return 'tap';
    if (dt >= T.holdMs) return 'hold';
    return null;                                     // a slow tap: nothing
  }
  return 'drag';
}

export class TouchControls {
  /** The pure laws, reachable on the class too (tests / the hub). */
  static turnKeysFor(dx, dy, deadPx) { return turnKeysFor(dx, dy, deadPx); }
  static classifyGesture(track, tune, canvasWidth) { return classifyGesture(track, tune, canvasWidth); }

  /**
   * Real-touch detection (Ipad.md §4.5). Headless bench Chromium and desktops
   * report neither signal, so every touch path is dead by construction there.
   * @returns {boolean}
   */
  static detect() {
    if (typeof window === 'undefined') return false;
    try {
      return ('ontouchstart' in window) ||
        !!(window.matchMedia && window.matchMedia('(pointer:coarse)').matches);
    } catch (_) {
      return false;
    }
  }

  /**
   * Session I follow-up (review, (l)) — is the PRIMARY pointer the glass?
   * The thermal clamp (SceneManager.setGlassPixelRatioCap → pixel ratio 1.0)
   * is for tablets and phones; a hybrid laptop (Surface class: touch hardware
   * + a mouse, hi-DPI) must keep its sharp picture, yet `detect()` says true
   * there (Chromium exposes `ontouchstart` whenever touch hardware exists).
   * `detect()` stays the broad "has touch at all" gate for the touch
   * affordances — a Surface with a mouse still benefits from them. This is the
   * narrow one: a COARSE primary pointer AND real touch points. An iPad with a
   * Magic Keyboard keeps a coarse primary pointer (the trackpad is
   * `any-pointer: fine`) → still glass; a hybrid laptop driven by a mouse has
   * a fine primary pointer → not glass; the same laptop in tablet mode (no
   * mouse) → glass, which is what it is at that moment.
   * @param {object} [win=window] - injectable for tests (needs matchMedia)
   * @param {object} [nav=navigator] - injectable for tests (needs maxTouchPoints)
   * @returns {boolean}
   */
  static detectGlass(win, nav) {
    const w = win !== undefined ? win : (typeof window !== 'undefined' ? window : undefined);
    const n = nav !== undefined ? nav : (typeof navigator !== 'undefined' ? navigator : undefined);
    if (!w || !n) return false;
    try {
      const coarse = !!(w.matchMedia && w.matchMedia('(pointer: coarse)').matches);
      const touch = (Number(n.maxTouchPoints) || 0) > 0;
      return coarse && touch;
    } catch (_) {
      return false;
    }
  }

  /**
   * @param {object} deps
   * @param {HTMLCanvasElement} deps.canvas          the game canvas
   * @param {object} deps.wheelRouter                provides routeSyntheticWheel(deltaY, target)
   * @param {object|null} [deps.ladderController]     provides jump({toFloor}) — the rail-drag sink —
   *   and turntableActive() (Session J: the drag orbits the camera while true)
   * @param {object|null} [deps.gameState]           provides isGameplay() — gates the chrome (menu hides it)
   * @param {object|null} [deps.openShop]            callback: open the store (KeyB path; guards its own state)
   * @param {object|null} [deps.telemetry]           optional zoom-feel sink: log(kind, data)
   * @param {object} [deps.tune]                     TOUCH_TUNE override (tests)
   * @param {object|null} [deps.inputKeys]           Session J: the PUBLIC `inputManager.keys` map — the
   *   one-finger drag writes ArrowLeft/Right/Up/Down into it (InputManager never edited)
   * @param {object|null} [deps.cameraSystem]        Session J: ladderDragNudge(dx, dy) — the turntable
   * @param {function|null} [deps.onTap]             Session J: ({x, y}) → the hub resolves the tap
   * @param {function|null} [deps.onHold]            Session J: ({x, y}) → truthy = a selected target is under
   *   the finger → the radial opens
   * @param {function|null} [deps.pressKey]          Session J: (code) → the hub presses the key (KeyDispatch)
   * @param {function|null} [deps.openPane]          Session J: ('refit'|'library', open) → the hub opens/closes
   *   the drawer (the edge-band swipe)
   * @param {object|null} [deps.paneDensity]         RETIRED (Session J): accepted and ignored — the WHAT rail
   *   is the pane surface
   * @param {function|null} [deps.toggleLibrary]     RETIRED (Session J): accepted and ignored — the SPECS tab
   *   lives on every floor
   */
  constructor({ canvas, wheelRouter, ladderController = null, gameState = null,
                paneDensity = null, openShop = null, toggleLibrary = null,
                telemetry = null, tune = null,
                inputKeys = null, cameraSystem = null, onTap = null, onHold = null,
                pressKey = null, openPane = null } = {}) {
    this._canvas = canvas || null;
    this._router = wheelRouter || null;
    this._ladder = ladderController;   // rail-drag → jump({toFloor}); turntableActive()
    this._gameState = gameState;       // isGameplay() → hide the chrome off-play
    void paneDensity; void toggleLibrary;   // retired deps (Session J) — accepted, ignored
    this._openShop = (typeof openShop === 'function') ? openShop : null;
    this._telemetry = telemetry;
    // Session J (D-I) sinks — every one optional; absent ⇒ that gesture is inert.
    this._keys = (inputKeys && typeof inputKeys === 'object') ? inputKeys : null;
    this._camera = cameraSystem || null;
    this._onTap = (typeof onTap === 'function') ? onTap : null;
    this._onHold = (typeof onHold === 'function') ? onHold : null;
    this._pressKey = (typeof pressKey === 'function') ? pressKey : null;
    this._openPane = (typeof openPane === 'function') ? openPane : null;
    const userTune = (typeof window !== 'undefined' && window.__TOUCH_TUNE) || null;
    this._tune = Object.assign({}, TOUCH_TUNE, tune || {}, userTune || {});

    this._root = null;          // fixed overlay containing all touch chrome
    this._grip = null;          // invisible drag surface over #ladder-rail
    this._railActive = false;   // a one-finger rail drag is live
    this._railLastFloor = null; // last floor jumped to this drag (dedupe)
    this._syncTimer = null;
    this._idleTimer = null;
    this._wakeLock = null;
    this._wakeLockWanted = false;
    this._pinch = null;         // { idA, idB, dist } while a pinch is live
    this._started = false;
    // Session J: the one-finger gesture track (null between gestures) —
    // { id, startX, startY, x, y, t0, moved, maxTouches, poisoned, edge, held,
    //   lastX, lastY, keysWritten } — and the radial state.
    this._gesture = null;
    this._holdTimer = null;
    this._radial = null;        // { el, idleTimer, fireTimer, firing }

    this._onTouchStart = this._handleTouchStart.bind(this);
    this._onTouchMove = this._handleTouchMove.bind(this);
    this._onTouchEnd = this._handleTouchEnd.bind(this);
    this._onVisibility = this._handleVisibility.bind(this);
    this._onGripStart = this._handleGripStart.bind(this);
    this._onGripMove = this._handleGripMove.bind(this);
    this._onGripEnd = this._handleGripEnd.bind(this);
  }

  /** Build the DOM chrome + bind canvas touch listeners. Idempotent. */
  start() {
    if (this._started || typeof document === 'undefined' || !this._canvas) return;
    this._started = true;

    // Machine-observable input state (Ipad.md §5.3): lets the headless probe
    // and on-device DevTools witness that gestures actually flow. Created only
    // here — desktop/headless-without-touch contexts never see the global.
    const stats = { pinch: 0, rail: 0, nav: 0, tap: 0, hold: 0, drag: 0, turn: 0, edge: 0, radial: 0 };
    if (typeof window !== 'undefined') {
      window.__TOUCH = this._stats = stats;
    } else {
      this._stats = stats;
    }

    // The canvas owns its touches (§3): passive:false so preventDefault works.
    this._canvas.addEventListener('touchstart', this._onTouchStart, { passive: false });
    this._canvas.addEventListener('touchmove', this._onTouchMove, { passive: false });
    this._canvas.addEventListener('touchend', this._onTouchEnd, { passive: false });
    this._canvas.addEventListener('touchcancel', this._onTouchEnd, { passive: false });
    document.addEventListener('visibilitychange', this._onVisibility);

    this._injectStyles();
    this._buildChrome();
    this._armIdleFade();
    this._startSync();
  }

  /** Remove listeners + DOM (tests / teardown). */
  stop() {
    if (!this._started) return;
    this._started = false;
    this._canvas.removeEventListener('touchstart', this._onTouchStart);
    this._canvas.removeEventListener('touchmove', this._onTouchMove);
    this._canvas.removeEventListener('touchend', this._onTouchEnd);
    this._canvas.removeEventListener('touchcancel', this._onTouchEnd);
    document.removeEventListener('visibilitychange', this._onVisibility);
    if (this._syncTimer) { clearInterval(this._syncTimer); this._syncTimer = null; }
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    this._endGesture();                 // releases any held arrow, clears the hold timer
    this._closeRadial();
    if (this._grip) {
      this._grip.removeEventListener('touchstart', this._onGripStart);
      this._grip.removeEventListener('touchmove', this._onGripMove);
      this._grip.removeEventListener('touchend', this._onGripEnd);
      this._grip.removeEventListener('touchcancel', this._onGripEnd);
      if (this._grip.parentNode) this._grip.parentNode.removeChild(this._grip);
      this._grip = null;
    }
    if (this._root && this._root.parentNode) this._root.parentNode.removeChild(this._root);
    this._root = null;
    if (typeof window !== 'undefined' && window.__TOUCH === this._stats) delete window.__TOUCH;
    this._stats = null;
  }

  // ── canvas pinch ─────────────────────────────────────────────────────────

  /** @private Distance between the two tracked touches, or NaN. */
  _pinchDist(touches) {
    const p = this._pinch;
    if (!p) return NaN;
    let a = null, b = null;
    for (const t of touches) {
      if (t.identifier === p.idA) a = t;
      else if (t.identifier === p.idB) b = t;
    }
    if (!a || !b) return NaN;
    return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
  }

  /** @private ms clock (performance.now when present). */
  _now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

  /** @private */
  _handleTouchStart(e) {
    // Own the canvas: no scroll-bounce, no double-tap zoom, no long-press.
    // (cancelable guard: a gesture the compositor already owns — e.g. a scroll
    // that began on overlay DOM — cannot be canceled; trying logs a console
    // error on every such event.)
    if (e.cancelable) e.preventDefault();
    this._touched();
    this._requestWakeLock();
    // Session J: a canvas touch while the radial is open CLOSES it and is
    // consumed (never a tap / drag of its own — one intent per touch).
    if (this._radial) {
      this._closeRadial();
      this._endGesture();
      this._gesture = { consumed: true, id: e.changedTouches[0] ? e.changedTouches[0].identifier : -1 };
      return;
    }
    if (!this._pinch && e.touches.length >= 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      this._pinch = {
        idA: a.identifier,
        idB: b.identifier,
        dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
      };
    }
    // Session J (D-I): the one-finger gesture track.
    if (e.touches.length >= 2) {
      this._poisonGesture();             // a second finger: never a tap / hold / drag
      return;
    }
    if (!this._gesture && e.touches.length === 1) {
      const t = e.touches[0];
      const now = this._now();
      this._gesture = {
        id: t.identifier, startX: t.clientX, startY: t.clientY, x: t.clientX, y: t.clientY,
        lastX: t.clientX, lastY: t.clientY, t0: now, t: now, moved: 0, maxTouches: 1,
        poisoned: false, edge: this._inEdgeBand(t.clientX), held: false, keysWritten: false, consumed: false,
      };
      this._armHold();
    }
  }

  /** @private */
  _handleTouchMove(e) {
    if (e.cancelable) e.preventDefault();
    this._touched();
    if (this._pinch) {
      const cur = this._pinchDist(e.touches);
      if (Number.isFinite(cur)) {
        const dy = pinchWheelDeltaY(this._pinch.dist, cur, this._tune);
        if (dy !== 0 && this._router && this._router.routeSyntheticWheel) {
          this._router.routeSyntheticWheel(dy, this._canvas);
          this._pinch.dist = cur;          // consume only what was emitted
          if (this._stats) this._stats.pinch++;
          if (this._telemetry) this._telemetry.log('pinch', { dy });
        }
      }
    }
    // Session J (D-I): the one-finger track.
    const g = this._gesture;
    if (!g || g.consumed) return;
    if (e.touches.length >= 2) { this._poisonGesture(); return; }
    if (g.poisoned || g.held) return;
    let t = null;
    for (const c of e.touches) if (c.identifier === g.id) { t = c; break; }
    if (!t) return;
    g.lastX = g.x; g.lastY = g.y;
    g.x = t.clientX; g.y = t.clientY; g.t = this._now();
    g.moved = Math.max(g.moved, Math.hypot(g.x - g.startX, g.y - g.startY));
    if (g.moved > this._tune.tapSlopPx) this._clearHold();   // a moving finger is not a hold
    if (g.edge) return;                                       // the drawer swipe writes no keys, nudges nothing
    if (this._ladder && typeof this._ladder.turntableActive === 'function' && this._ladder.turntableActive()) {
      // The TURNTABLE (D-F): the pixel delta since the previous move onto the
      // camera's ONE drag mechanism — the mouse path's math, verbatim.
      if (g.keysWritten) this._releaseKeys();                 // the drawer opened mid-drag: the ship lets go
      if (this._camera && typeof this._camera.ladderDragNudge === 'function') {
        const dx = g.x - g.lastX, dy = g.y - g.lastY;
        if (dx !== 0 || dy !== 0) {
          this._camera.ladderDragNudge(dx, dy);
          if (this._stats) this._stats.turn++;
        }
      }
      return;
    }
    // SHIP TURN: the arrow-key state the ship reads each frame (write-on-change).
    if (this._keys) {
      const want = turnKeysFor(g.x - g.startX, g.y - g.startY, this._tune.turnDeadPx);
      let changed = false;
      for (const k of ARROW_KEYS) {
        if (!!this._keys[k] !== want[k]) { this._keys[k] = want[k]; changed = true; }
      }
      const any = want.ArrowLeft || want.ArrowRight || want.ArrowUp || want.ArrowDown;
      if (any) { if (!g.keysWritten && this._stats) this._stats.drag++; g.keysWritten = true; }
      if (changed && this._telemetry) this._telemetry.log('turn', want);
    }
  }

  /** @private */
  _handleTouchEnd(e) {
    if (e.cancelable) e.preventDefault();
    if (this._pinch) {
      for (const t of e.changedTouches) {
        if (t.identifier === this._pinch.idA || t.identifier === this._pinch.idB) {
          this._pinch = null;
          break;
        }
      }
    }
    // Re-arm immediately when two touches remain (finger swap mid-pinch).
    if (!this._pinch && e.touches.length >= 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      this._pinch = {
        idA: a.identifier,
        idB: b.identifier,
        dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
      };
    }
    // Session J (D-I): resolve the one-finger track when ITS finger lifts.
    const g = this._gesture;
    if (!g) return;
    let mine = false;
    for (const t of e.changedTouches) if (t.identifier === g.id) { mine = true; break; }
    if (!mine) return;
    if (g.consumed || g.poisoned || g.held) { this._endGesture(); return; }
    g.t = this._now();
    const W = this._canvasWidth();
    const kind = classifyGesture(g, this._tune, W);
    this._endGesture();                                       // releases any written arrow first
    switch (kind) {
      case 'tap':
        if (this._stats) this._stats.tap++;
        if (this._telemetry) this._telemetry.log('tap', { x: g.x, y: g.y });
        if (this._onTap) { try { this._onTap({ x: g.x, y: g.y }); } catch (_err) { /* dep */ } }
        break;
      case 'edge-open-left': this._swipePane('refit', true); break;
      case 'edge-open-right': this._swipePane('library', true); break;
      case 'edge-close-left': this._swipePane('refit', false); break;
      case 'edge-close-right': this._swipePane('library', false); break;
      default: break;                                         // drag / slow tap / hold release: nothing more
    }
  }

  // ── Session J (D-I): gesture bookkeeping ─────────────────────────────────

  /** @private CSS-px canvas width (Infinity when unknown → no right band). */
  _canvasWidth() {
    const c = this._canvas;
    if (c && typeof c.getBoundingClientRect === 'function') {
      const r = c.getBoundingClientRect();
      if (r && r.width > 0) return r.width;
    }
    if (c && c.clientWidth > 0) return c.clientWidth;
    if (typeof window !== 'undefined' && window.innerWidth > 0) return window.innerWidth;
    return Infinity;
  }

  /** @private Did the press start inside the left/right edge band? */
  _inEdgeBand(x) {
    const band = this._tune.edgeBandPx;
    if (x <= band) return true;
    const W = this._canvasWidth();
    return Number.isFinite(W) && x >= W - band;
  }

  /** @private Arm the long-press timer for the live track. */
  _armHold() {
    this._clearHold();
    this._holdTimer = setTimeout(() => {
      this._holdTimer = null;
      const g = this._gesture;
      if (!g || g.poisoned || g.consumed || g.edge || g.moved > this._tune.tapSlopPx) return;
      g.held = true;
      if (this._stats) this._stats.hold++;
      if (this._telemetry) this._telemetry.log('hold', { x: g.x, y: g.y });
      let ok = false;
      if (this._onHold) { try { ok = !!this._onHold({ x: g.x, y: g.y }); } catch (_err) { ok = false; } }
      if (ok) this._openRadial(g.x, g.y);
    }, this._tune.holdMs);
  }

  /** @private */
  _clearHold() {
    if (this._holdTimer) { clearTimeout(this._holdTimer); this._holdTimer = null; }
  }

  /** @private A second finger: the track can never resolve to anything. */
  _poisonGesture() {
    const g = this._gesture;
    if (!g) return;
    g.poisoned = true;
    g.maxTouches = 2;
    this._clearHold();
    this._releaseKeys();
  }

  /** @private Release every arrow this layer wrote (write-on-change). */
  _releaseKeys() {
    const g = this._gesture;
    if (!this._keys || !g || !g.keysWritten) return;
    for (const k of ARROW_KEYS) if (this._keys[k]) this._keys[k] = false;
    g.keysWritten = false;
  }

  /** @private Drop the track: keys released, hold timer cleared. */
  _endGesture() {
    this._clearHold();
    this._releaseKeys();
    this._gesture = null;
  }

  /** @private The edge-band swipe → the hub's drawer opener. */
  _swipePane(which, open) {
    if (this._stats) this._stats.edge++;
    if (this._telemetry) this._telemetry.log('edge', { which, open });
    if (this._openPane) { try { this._openPane(which, open); } catch (_err) { /* dep */ } }
  }

  // ── Session J (D-I): the RADIAL — AUTOPILOT / NET / DAUGHTER / REEL ──────

  /** @private Is the radial open? (tests / the hub) */
  radialOpen() { return !!this._radial; }

  /**
   * @private Open the four-verb radial around (x, y) — DOM `#touch-radial`,
   * four `.touch-radial-btn[data-key]` buttons at N/E/S/W. AUTOPILOT and REEL
   * fire on a tap of their button; NET and DAUGHTER are HOLD-TO-FIRE (fireHoldMs;
   * a release before that cancels — no shot). Every fire is `pressKey(code)` —
   * the same key the keyboard would press. Closes on fire, on a canvas touch,
   * or after radialIdleMs.
   */
  _openRadial(x, y) {
    if (typeof document === 'undefined' || this._radial) return;
    const el = document.createElement('div');
    el.id = 'touch-radial';
    const half = RADIAL_BTN_PX / 2;
    const W = this._canvasWidth();
    const H = (typeof window !== 'undefined' && window.innerHeight > 0) ? window.innerHeight : Infinity;
    const cx = Math.max(RADIAL_RING_PX + half, Math.min(Number.isFinite(W) ? W - RADIAL_RING_PX - half : x, x));
    const cy = Math.max(RADIAL_RING_PX + half, Math.min(Number.isFinite(H) ? H - RADIAL_RING_PX - half : y, y));
    el.style.cssText = `position:fixed;left:${cx}px;top:${cy}px;width:0;height:0;z-index:38;pointer-events:none;`;
    const radial = { el, idleTimer: null, fireTimer: null, firing: null };
    const offsets = { n: [0, -RADIAL_RING_PX], e: [RADIAL_RING_PX, 0], s: [0, RADIAL_RING_PX], w: [-RADIAL_RING_PX, 0] };
    for (const v of RADIAL_VERBS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'touch-radial-btn';
      b.dataset.key = v.key;
      b.dataset.hold = v.hold ? '1' : '0';
      b.textContent = v.label;
      const [ox, oy] = offsets[v.dir];
      b.style.cssText = `left:${ox - half}px;top:${oy - half}px;`;
      if (v.hold) {
        b.addEventListener('touchstart', (ev) => {
          if (ev.cancelable) ev.preventDefault();
          ev.stopPropagation();
          this._radialArm();
          radial.firing = v.key;
          b.classList.add('touch-radial-arming');
          if (radial.fireTimer) clearTimeout(radial.fireTimer);
          radial.fireTimer = setTimeout(() => {
            radial.fireTimer = null;
            if (radial.firing !== v.key) return;
            this._radialFire(v.key);
          }, this._tune.fireHoldMs);
        }, { passive: false });
        const cancel = (ev) => {
          if (ev && ev.cancelable) ev.preventDefault();
          if (ev) ev.stopPropagation();
          if (radial.fireTimer) { clearTimeout(radial.fireTimer); radial.fireTimer = null; }
          radial.firing = null;
          b.classList.remove('touch-radial-arming');
        };
        b.addEventListener('touchend', cancel, { passive: false });
        b.addEventListener('touchcancel', cancel, { passive: false });
      } else {
        b.addEventListener('touchstart', (ev) => { if (ev.cancelable) ev.preventDefault(); ev.stopPropagation(); this._radialArm(); }, { passive: false });
        b.addEventListener('touchend', (ev) => {
          if (ev.cancelable) ev.preventDefault();
          ev.stopPropagation();
          this._radialFire(v.key);
        }, { passive: false });
      }
      el.appendChild(b);
    }
    document.body.appendChild(el);
    this._radial = radial;
    if (this._stats) this._stats.radial++;
    this._radialArm();
  }

  /** @private (Re)arm the radial's idle close. */
  _radialArm() {
    const r = this._radial;
    if (!r) return;
    if (r.idleTimer) clearTimeout(r.idleTimer);
    r.idleTimer = setTimeout(() => { this._closeRadial(); }, this._tune.radialIdleMs);
  }

  /** @private Press the verb's key through the hub and close. */
  _radialFire(code) {
    this._closeRadial();
    if (this._telemetry) this._telemetry.log('radial', { code });
    if (this._pressKey) { try { this._pressKey(code); } catch (_err) { /* dep */ } }
  }

  /** @private */
  _closeRadial() {
    const r = this._radial;
    if (!r) return;
    this._radial = null;
    if (r.idleTimer) clearTimeout(r.idleTimer);
    if (r.fireTimer) clearTimeout(r.fireTimer);
    if (r.el && r.el.parentNode) r.el.parentNode.removeChild(r.el);
  }

  // ── rail drag (one finger, invisible grip over #ladder-rail) ──────────────

  /** @private Map a touch to a floor and jump the ladder there (once per floor). */
  _railJumpTo(touch) {
    if (!touch || !this._ladder || typeof this._ladder.jump !== 'function') return;
    if (typeof document === 'undefined') return;
    const rail = document.getElementById('ladder-rail');
    if (!rail) return;
    const r = rail.getBoundingClientRect();
    if (!(r.height > 0)) return;
    const floor = railFloorForY(touch.clientY, r.top, r.bottom, FLOOR_COUNT);
    if (floor === this._railLastFloor) return;   // still on the same notch
    this._railLastFloor = floor;
    // jump() runs the same wall/dock decisions as the wheel path: a blocked
    // floor flashes its notch (rail.flashDenied) instead of entering, and no-ops
    // when already there. Returns [] unless the ladder is engaged.
    this._ladder.jump({ toFloor: floor });
    if (this._stats) this._stats.rail++;
    if (this._telemetry) this._telemetry.log('rail', { floor });
  }

  /** @private */
  _handleGripStart(e) {
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();                 // the grip owns its region, not the canvas
    if (e.touches.length !== 1) return;  // two fingers here = accidental; ignore
    this._touched();
    this._requestWakeLock();
    this._railActive = true;
    this._railLastFloor = null;          // first move always jumps
    this._railJumpTo(e.touches[0]);
  }

  /** @private */
  _handleGripMove(e) {
    if (!this._railActive) return;
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    if (e.touches.length !== 1) return;
    this._touched();
    this._railJumpTo(e.touches[0]);
  }

  /** @private */
  _handleGripEnd(e) {
    if (e.cancelable) e.preventDefault();
    this._railActive = false;
  }

  // ── DOM chrome ───────────────────────────────────────────────────────────

  /** @private One-time stylesheet (range thumbs need real CSS, not inline). */
  _injectStyles() {
    if (document.getElementById('touch-controls-style')) return;
    const s = document.createElement('style');
    s.id = 'touch-controls-style';
    s.textContent = `
      #touch-controls {
        position: fixed; inset: 0; z-index: 15; pointer-events: none;
        font-family: var(--font-mono); color: #00ff88;
        opacity: ${this._tune.activeOpacity};
        transition: opacity 0.6s ease;
        -webkit-user-select: none; user-select: none; -webkit-touch-callout: none;
      }
      #touch-controls.touch-idle { opacity: ${this._tune.idleOpacity}; }
      /* The STORE tap chip — bottom-left, ≥44pt target (Ipad.md §3), same fade
         family as the rest of the chrome. (The LIBRARY chip retired in Session
         J: the SPECS tab lives on every floor; the PANES slider retired with
         the WHAT rail.) */
      .touch-nav-dock {
        position: absolute;
        left: calc(12px + env(safe-area-inset-left, 0px));
        bottom: calc(12px + env(safe-area-inset-bottom, 0px));
        pointer-events: auto;
        display: flex; gap: 10px;
      }
      .touch-nav-chip {
        min-width: 96px; min-height: 44px;
        background: rgba(5, 10, 20, 0.78);
        border: 1px solid rgba(0, 255, 136, 0.3); border-radius: 8px;
        color: rgba(0, 255, 136, 0.85);
        font-family: var(--font-mono);
        font-size: 12px; letter-spacing: 0.14em;
        padding: 10px 14px;
        -webkit-user-select: none; user-select: none; touch-action: manipulation;
      }
      .touch-nav-chip:active {
        background: rgba(0, 255, 136, 0.18);
        border-color: rgba(0, 255, 136, 0.8);
      }
      /* Invisible one-finger zoom grip laid over the visible ladder rail.
         No pixels of its own — the rail IS the affordance; touch-action:none so
         the drag never scroll-bounces. Positioned + toggled by _syncGrip. */
      #touch-ladder-grip {
        position: fixed; z-index: 36; pointer-events: none;
        background: transparent; touch-action: none;
      }
      /* Session J (D-I): the long-press RADIAL — four ≥ 44 pt verbs around the
         finger; the two shots (NET / DAUGHTER) arm while held. Text only. */
      .touch-radial-btn {
        position: absolute; width: ${RADIAL_BTN_PX}px; height: ${RADIAL_BTN_PX}px;
        border-radius: 50%; pointer-events: auto; touch-action: none;
        background: rgba(5, 10, 20, 0.86);
        border: 1px solid rgba(0, 255, 136, 0.55);
        color: rgba(0, 255, 136, 0.92);
        font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.08em;
        -webkit-user-select: none; user-select: none; -webkit-touch-callout: none;
        box-shadow: 0 0 10px rgba(0, 255, 136, 0.25);
      }
      .touch-radial-btn[data-hold="1"] { border-style: dashed; }
      .touch-radial-btn.touch-radial-arming {
        background: rgba(0, 255, 136, 0.22); border-color: rgba(0, 255, 136, 0.95);
        transition: background ${TOUCH_TUNE.fireHoldMs}ms linear;
      }
    `;
    document.head.appendChild(s);
  }

  /** @private */
  _buildChrome() {
    const root = document.createElement('div');
    root.id = 'touch-controls';
    // Gameplay-gated: the chrome has no business on the menu / briefing / end
    // screens. Start hidden when we're off-play; _syncChrome reveals it in
    // gameplay. No gameState (tests / other hosts) ⇒ previous always-visible.
    if (this._gameState && typeof this._gameState.isGameplay === 'function'
        && !this._gameState.isGameplay()) {
      root.style.display = 'none';
    }

    // The STORE tap chip — bottom-left dock (iPad port: the desktop opener is
    // KeyB, which does not exist on glass; the chip calls the SAME open path,
    // injected from main.js so the state guard stays in ONE place). Rendered
    // only when the callback was provided. It STAYS until Session K retires
    // the full-screen shop (otherwise glass loses the shop between J and K);
    // the LIBRARY chip left in Session J — the SPECS tab is on every floor.
    if (this._openShop) {
      const nav = document.createElement('div');
      nav.className = 'touch-nav-dock';
      const mkChip = (text, cb) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'touch-nav-chip';
        b.textContent = text;
        b.addEventListener('click', () => {
          this._touched();
          if (this._stats) this._stats.nav++;
          cb();
        });
        nav.appendChild(b);
        return b;
      };
      mkChip('STORE', this._openShop);
      root.appendChild(nav);
    }

    document.body.appendChild(root);
    this._root = root;

    // Rail grip lives OUTSIDE #touch-controls: it must stack above the rail
    // (#ladder-rail z-index 35), which the root's z-index 15 stacking context
    // could never reach from within. Invisible; aligned to the rail by
    // _syncGrip, and only pointer-active while the rail is showing.
    if (this._ladder && typeof this._ladder.jump === 'function') {
      const grip = document.createElement('div');
      grip.id = 'touch-ladder-grip';
      grip.addEventListener('touchstart', this._onGripStart, { passive: false });
      grip.addEventListener('touchmove', this._onGripMove, { passive: false });
      grip.addEventListener('touchend', this._onGripEnd, { passive: false });
      grip.addEventListener('touchcancel', this._onGripEnd, { passive: false });
      document.body.appendChild(grip);
      this._grip = grip;
    }
  }

  /** @private Keep the grip aligned + the chrome gated (the sync cadence). */
  _startSync() {
    if (!this._grip && !this._gameState) return;
    this._syncTimer = setInterval(() => {
      this._syncGrip();
      this._syncChrome();
    }, this._tune.sliderSyncMs);
  }

  /**
   * @private Show the touch chrome (the STORE chip) only in gameplay. The
   * menu / briefing / end screens hide it — gated on gameState.isGameplay(),
   * polled on the sync cadence like the rail grip. No gameState ⇒ no gating.
   */
  _syncChrome() {
    if (!this._root || !this._gameState ||
        typeof this._gameState.isGameplay !== 'function') return;
    const want = this._gameState.isGameplay() ? '' : 'none';
    if (this._root.style.display !== want) this._root.style.display = want;
  }

  /**
   * @private Align the invisible grip to #ladder-rail's live rect and toggle its
   * pointer-events with the rail's visibility. The rail is mid-height-anchored
   * and static during gameplay, so the sync cadence is ample; when the rail is
   * hidden (menus) the grip goes inert so it never eats a bottom-right touch.
   */
  _syncGrip() {
    const grip = this._grip;
    if (!grip || typeof document === 'undefined') return;
    const rail = document.getElementById('ladder-rail');
    let visible = false;
    if (rail) {
      const shown = typeof getComputedStyle === 'function'
        ? getComputedStyle(rail).opacity !== '0'
        : rail.style.opacity !== '0';
      const r = rail.getBoundingClientRect();
      if (shown && r.height > 0) {
        visible = true;
        grip.style.left = `${Math.max(0, r.left - 8)}px`;
        grip.style.top = `${r.top}px`;
        grip.style.width = `${r.width + 16}px`;
        grip.style.height = `${r.height}px`;
      }
    }
    grip.style.pointerEvents = visible ? 'auto' : 'none';
    if (!visible) this._railActive = false;
  }

  // ── idle fade (fade, never vanish — §3) ─────────────────────────────────

  /** @private */
  _touched() {
    if (!this._root) return;
    this._root.classList.remove('touch-idle');
    this._armIdleFade();
  }

  /** @private */
  _armIdleFade() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      if (this._root) this._root.classList.add('touch-idle');
    }, this._tune.idleFadeMs);
  }

  // ── wake lock (§3: no touches for minutes must not dim mid-watch) ───────

  /** @private Request once per gesture; quiet on unsupported/denied. */
  _requestWakeLock() {
    if (this._wakeLock || typeof navigator === 'undefined' || !navigator.wakeLock) return;
    this._wakeLockWanted = true;
    navigator.wakeLock.request('screen').then((lock) => {
      this._wakeLock = lock;
      lock.addEventListener('release', () => { this._wakeLock = null; });
    }).catch(() => { /* denied / low battery — never surface an error */ });
  }

  /** @private Locks auto-release on hide; re-grab when visible again (§3). */
  _handleVisibility() {
    if (typeof document !== 'undefined' && !document.hidden &&
        this._wakeLockWanted && !this._wakeLock) {
      this._requestWakeLock();
    }
  }
}

export default TouchControls;
