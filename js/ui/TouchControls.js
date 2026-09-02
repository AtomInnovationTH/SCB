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
   *   2. HUD pane density: a slider bound to the PaneDensity ladder —
 *      slide left = fewer panes (`-`), right = more (`+`), via
 *      `paneDensity.setLevel(n)` which re-reads live pane visibility so the
 *      keyboard keys and per-pane toggles compose. Gameplay-gated: the chrome
 *      is hidden on the menu / briefing / end screens (gameState.isGameplay()),
 *      so the slider never floats over a non-play screen.
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

/** Field-tunable knobs (overridable, not forked — window.__TOUCH_TUNE). */
export const TOUCH_TUNE = {
  pinchGain: 1.6,     // px of wheel deltaY per px of pinch-distance change
  pinchMaxStepPx: 240, // per-event clamp (≤ 2.4 notches; router caps mag at 4)
  pinchMinStepPx: 1,   // ignore sub-px jitter
  idleFadeMs: 4000,    // controls fade (never vanish) after this idle time
  idleOpacity: 0.35,   // faded opacity
  activeOpacity: 0.92, // touched/recent opacity
  sliderSyncMs: 700,   // pane-slider + rail-grip re-sync cadence
};

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

export class TouchControls {
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
   * @param {object} deps
   * @param {HTMLCanvasElement} deps.canvas          the game canvas
   * @param {object} deps.wheelRouter                provides routeSyntheticWheel(deltaY, target)
   * @param {object|null} [deps.ladderController]     provides jump({toFloor}) — the rail-drag sink
   * @param {object|null} [deps.gameState]           provides isGameplay() — gates the chrome (menu hides it)
   * @param {object|null} [deps.paneDensity]         PaneDensity: total/visibleCount()/setLevel(n)
   * @param {object|null} [deps.openShop]            callback: open the store (KeyB path; guards its own state)
   * @param {object|null} [deps.toggleLibrary]       callback: toggle the Tech Library (KeyI path)
   * @param {object|null} [deps.telemetry]           optional zoom-feel sink: log(kind, data)
   * @param {object} [deps.tune]                     TOUCH_TUNE override (tests)
   */
  constructor({ canvas, wheelRouter, ladderController = null, gameState = null,
                paneDensity = null, openShop = null, toggleLibrary = null,
                telemetry = null, tune = null } = {}) {
    this._canvas = canvas || null;
    this._router = wheelRouter || null;
    this._ladder = ladderController;   // rail-drag → jump({toFloor})
    this._gameState = gameState;       // isGameplay() → hide the chrome off-play
    this._paneDensity = paneDensity;
    this._openShop = (typeof openShop === 'function') ? openShop : null;
    this._toggleLibrary = (typeof toggleLibrary === 'function') ? toggleLibrary : null;
    this._telemetry = telemetry;
    const userTune = (typeof window !== 'undefined' && window.__TOUCH_TUNE) || null;
    this._tune = Object.assign({}, TOUCH_TUNE, tune || {}, userTune || {});

    this._root = null;          // fixed overlay containing all touch chrome
    this._slider = null;
    this._grip = null;          // invisible drag surface over #ladder-rail
    this._sliderDragging = false;
    this._dragDirty = false;    // a drag changed pane state → announce on release
    this._railActive = false;   // a one-finger rail drag is live
    this._railLastFloor = null; // last floor jumped to this drag (dedupe)
    this._sliderTimer = null;
    this._idleTimer = null;
    this._wakeLock = null;
    this._wakeLockWanted = false;
    this._pinch = null;         // { idA, idB, dist } while a pinch is live
    this._started = false;

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
    if (typeof window !== 'undefined') {
      window.__TOUCH = this._stats = { pinch: 0, rail: 0, slider: 0, nav: 0 };
    } else {
      this._stats = { pinch: 0, rail: 0, slider: 0, nav: 0 };
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
    if (this._sliderTimer) { clearInterval(this._sliderTimer); this._sliderTimer = null; }
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
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
    this._slider = null;
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

  /** @private */
  _handleTouchStart(e) {
    // Own the canvas: no scroll-bounce, no double-tap zoom, no long-press.
    // (cancelable guard: a gesture the compositor already owns — e.g. a scroll
    // that began on overlay DOM — cannot be canceled; trying logs a console
    // error on every such event.)
    if (e.cancelable) e.preventDefault();
    this._touched();
    this._requestWakeLock();
    if (!this._pinch && e.touches.length >= 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      this._pinch = {
        idA: a.identifier,
        idB: b.identifier,
        dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
      };
    }
  }

  /** @private */
  _handleTouchMove(e) {
    if (e.cancelable) e.preventDefault();
    this._touched();
    if (!this._pinch) return;
    const cur = this._pinchDist(e.touches);
    if (!Number.isFinite(cur)) return;
    const dy = pinchWheelDeltaY(this._pinch.dist, cur, this._tune);
    if (dy !== 0 && this._router && this._router.routeSyntheticWheel) {
      this._router.routeSyntheticWheel(dy, this._canvas);
      this._pinch.dist = cur;          // consume only what was emitted
      if (this._stats) this._stats.pinch++;
      if (this._telemetry) this._telemetry.log('pinch', { dy });
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
        font-family: 'Courier New', monospace; color: #00ff88;
        opacity: ${this._tune.activeOpacity};
        transition: opacity 0.6s ease;
        -webkit-user-select: none; user-select: none; -webkit-touch-callout: none;
      }
      #touch-controls.touch-idle { opacity: ${this._tune.idleOpacity}; }
      .touch-pane-dock {
        position: absolute;
        right: calc(160px + env(safe-area-inset-right, 0px));
        bottom: calc(12px + env(safe-area-inset-bottom, 0px));
        pointer-events: auto;
        display: flex; align-items: center; gap: 8px;
        background: rgba(5, 10, 20, 0.78);
        border: 1px solid rgba(0, 255, 136, 0.3); border-radius: 8px;
        padding: 10px 12px;
      }
      .touch-pane-dock label {
        font-size: 11px; letter-spacing: 0.12em; color: rgba(0,255,136,0.75);
      }
      #touch-pane-slider {
        -webkit-appearance: none; appearance: none;
        width: 190px; height: 44px; background: transparent;
        touch-action: none; margin: 0;
      }
      #touch-pane-slider::-webkit-slider-runnable-track {
        height: 4px; border-radius: 2px;
        background: linear-gradient(90deg, rgba(0,255,136,0.15), rgba(0,255,136,0.55));
      }
      #touch-pane-slider::-webkit-slider-thumb {
        -webkit-appearance: none; appearance: none;
        width: 34px; height: 34px; border-radius: 50%;
        margin-top: -15px;
        background: rgba(5, 10, 20, 0.9);
        border: 2px solid rgba(0, 255, 136, 0.8);
        box-shadow: 0 0 10px rgba(0, 255, 136, 0.35);
      }
      /* STORE / LIBRARY tap chips — bottom-left, ≥44pt targets (Ipad.md §3),
         same fade family as the rest of the chrome. */
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
        font-family: 'Courier New', monospace;
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
    `;
    document.head.appendChild(s);
  }

  /** @private */
  _buildChrome() {
    const root = document.createElement('div');
    root.id = 'touch-controls';
    // Gameplay-gated: the PANES slider has no business on the menu / briefing /
    // end screens. Start hidden when we're off-play; _syncChrome reveals it in
    // gameplay. No gameState (tests / other hosts) ⇒ previous always-visible.
    if (this._gameState && typeof this._gameState.isGameplay === 'function'
        && !this._gameState.isGameplay()) {
      root.style.display = 'none';
    }

    // Pane-density slider — bottom-right dock. Left = fewer panes, right = more.
    if (this._paneDensity && typeof this._paneDensity.setLevel === 'function') {
      const dock = document.createElement('div');
      dock.className = 'touch-pane-dock';
      const label = document.createElement('label');
      label.textContent = 'PANES';
      label.htmlFor = 'touch-pane-slider';
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.id = 'touch-pane-slider';
      slider.min = '0';
      slider.max = String(this._paneDensity.total);
      slider.step = '1';
      slider.value = String(this._paneDensity.visibleCount());
      slider.addEventListener('input', () => {
        this._touched();
        // Quiet while dragging: input fires per detent (up to `total` per
        // slide) — the summary toast/log is emitted ONCE on release instead.
        const steps = this._paneDensity.setLevel(Number(slider.value), { quiet: this._sliderDragging });
        if (steps > 0 && this._sliderDragging) this._dragDirty = true;
        if (this._stats) this._stats.slider++;
      });
      const dragOn = () => { this._sliderDragging = true; this._touched(); };
      const dragOff = () => {
        if (!this._sliderDragging) return; // pointerup + touchend both fire — once
        this._sliderDragging = false;
        // Land the thumb on the LIVE count (a refused step must not lie).
        slider.value = String(this._paneDensity.visibleCount());
        if (this._dragDirty) {
          this._dragDirty = false;
          this._paneDensity.announceLevel();
        }
      };
      slider.addEventListener('touchstart', dragOn, { passive: true });
      slider.addEventListener('touchend', dragOff);
      slider.addEventListener('touchcancel', dragOff);
      slider.addEventListener('pointerdown', dragOn);
      slider.addEventListener('pointerup', dragOff);
      dock.appendChild(label);
      dock.appendChild(slider);
      root.appendChild(dock);
      this._slider = slider;
    }

    // STORE / LIBRARY tap chips — bottom-left dock (iPad port: the desktop
    // openers are KeyB / KeyI, which do not exist on glass; these call the
    // SAME open paths, injected from main.js so state guards stay in ONE
    // place). Only rendered when a callback was actually provided, so hosts
    // without the deps (tests, other embeds) see zero extra DOM.
    if (this._openShop || this._toggleLibrary) {
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
      if (this._openShop) mkChip('STORE', this._openShop);
      if (this._toggleLibrary) mkChip('LIBRARY', this._toggleLibrary);
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

  /** @private Keep the slider honest + the grip aligned + the chrome gated. */
  _startSync() {
    if (!this._slider && !this._grip && !this._gameState) return;
    this._sliderTimer = setInterval(() => {
      if (this._slider && this._paneDensity && !this._sliderDragging) {
        const live = String(this._paneDensity.visibleCount());
        if (this._slider.value !== live) this._slider.value = live;
      }
      this._syncGrip();
      this._syncChrome();
    }, this._tune.sliderSyncMs);
  }

  /**
   * @private Show the touch chrome (the PANES slider) only in gameplay. The
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
   * pointer-events with the rail's visibility. The rail is bottom-anchored and
   * static during gameplay, so the pane-sync cadence is ample; when the rail is
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
