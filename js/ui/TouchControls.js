/**
 * TouchControls.js — the iPad / touch-glass input layer (Phase 1 of the port,
 * see Ipad.md).
 *
 * Scope (deliberately small): the two verbs a sealed-iPad build needs to be a
 * watchable, explorable sim —
 *   1. ZOOM between Zoom-Ladder floors: two-finger pinch on the game canvas
 *      plus fixed +/− buttons. Both synthesize wheel input through
 *      `WheelRouter.routeSyntheticWheel(...)` — the SAME dispatch recipe as the
 *      physical wheel (Ipad.md §5.1 "one behavior, two triggers"), so arm-SK
 *      priority, StrategicMap ownership, ladder active/inactive and the legacy
 *      camera zoom all keep working without a second input path.
 *   2. HUD pane density: a slider bound to the PaneDensity ladder —
 *      slide left = fewer panes (`-`), right = more (`+`), via
 *      `paneDensity.setLevel(n)` which re-reads live pane visibility so the
 *      keyboard keys and per-pane toggles compose.
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
 * happens inside start(). Pure math (`pinchWheelDeltaY`) is exported for the
 * Node test suite.
 *
 * @module ui/TouchControls
 */

import { NOTCH_PX } from '../systems/WheelRouter.js';

/** Field-tunable knobs (overridable, not forked — window.__TOUCH_TUNE). */
export const TOUCH_TUNE = {
  pinchGain: 1.6,     // px of wheel deltaY per px of pinch-distance change
  pinchMaxStepPx: 240, // per-event clamp (≤ 2.4 notches; router caps mag at 4)
  pinchMinStepPx: 1,   // ignore sub-px jitter
  buttonNotches: 1,    // notches per +/− button tap
  idleFadeMs: 4000,    // controls fade (never vanish) after this idle time
  idleOpacity: 0.35,   // faded opacity
  activeOpacity: 0.92, // touched/recent opacity
  sliderSyncMs: 700,   // pane-slider re-sync cadence (live count → thumb)
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
   * @param {HTMLCanvasElement} deps.canvas        the game canvas
   * @param {object} deps.wheelRouter              provides routeSyntheticWheel(deltaY, target)
   * @param {object|null} [deps.paneDensity]       PaneDensity: total/visibleCount()/setLevel(n)
   * @param {object} [deps.tune]                   TOUCH_TUNE override (tests)
   */
  constructor({ canvas, wheelRouter, paneDensity = null, tune = null } = {}) {
    this._canvas = canvas || null;
    this._router = wheelRouter || null;
    this._paneDensity = paneDensity;
    const userTune = (typeof window !== 'undefined' && window.__TOUCH_TUNE) || null;
    this._tune = Object.assign({}, TOUCH_TUNE, tune || {}, userTune || {});

    this._root = null;          // fixed overlay containing all touch chrome
    this._slider = null;
    this._sliderDragging = false;
    this._dragDirty = false;    // a drag changed pane state → announce on release
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
  }

  /** Build the DOM chrome + bind canvas touch listeners. Idempotent. */
  start() {
    if (this._started || typeof document === 'undefined' || !this._canvas) return;
    this._started = true;

    // Machine-observable input state (Ipad.md §5.3): lets the headless probe
    // and on-device DevTools witness that gestures actually flow. Created only
    // here — desktop/headless-without-touch contexts never see the global.
    if (typeof window !== 'undefined') {
      window.__TOUCH = this._stats = { pinch: 0, notches: 0, slider: 0 };
    } else {
      this._stats = { pinch: 0, notches: 0, slider: 0 };
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
    this._startSliderSync();
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
      .touch-zoom-col {
        position: absolute;
        /* Left of the ladder rail (#ladder-rail: right 10px, ~135px wide,
           bottom-anchored, gameplay-only) and above the pane dock — the
           bottom-right ocean region the HUD deliberately leaves empty. */
        right: calc(160px + env(safe-area-inset-right, 0px));
        bottom: calc(92px + env(safe-area-inset-bottom, 0px));
        display: flex; flex-direction: row; gap: 14px;
      }
      .touch-zoom-btn {
        pointer-events: auto; touch-action: manipulation;
        width: 56px; height: 56px;
        font: 28px 'Courier New', monospace; color: #00ff88;
        background: rgba(5, 10, 20, 0.78);
        border: 1px solid rgba(0, 255, 136, 0.45); border-radius: 8px;
        display: flex; align-items: center; justify-content: center;
      }
      .touch-zoom-btn:active {
        background: rgba(0, 255, 136, 0.25);
      }
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
    `;
    document.head.appendChild(s);
  }

  /** @private */
  _buildChrome() {
    const root = document.createElement('div');
    root.id = 'touch-controls';

    // Zoom floor steps — right edge, thumb-reachable, 56 px targets (§3).
    const col = document.createElement('div');
    col.className = 'touch-zoom-col';
    const mkBtn = (text, sign, label) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'touch-zoom-btn';
      b.textContent = text;
      b.setAttribute('aria-label', label);
      // ONE dispatch path for both triggers (touch + mouse click) so stats,
      // fade and wake lock can never diverge between them.
      let lastTouchMs = -Infinity;
      const fire = () => {
        this._touched();
        this._requestWakeLock();
        if (this._router && this._router.routeSyntheticWheel) {
          this._router.routeSyntheticWheel(sign * this._tune.buttonNotches * NOTCH_PX, this._canvas);
          if (this._stats) this._stats.notches += this._tune.buttonNotches;
        }
      };
      b.addEventListener('touchstart', (e) => {
        // Own the tap: no double-tap zoom. (cancelable guard — see canvas note.)
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        lastTouchMs = performance.now();
        fire();
      }, { passive: false });
      // Desktop-with-touchscreen convenience: clicks still work. A click that
      // trails a touch is the browser-synthesized one — preventDefault on a
      // NON-cancelable touchstart cannot suppress it, and Chromium synthesizes
      // it with detail=1, so suppress by recency, not by e.detail.
      b.addEventListener('click', (e) => {
        e.preventDefault();
        if (performance.now() - lastTouchMs < 700) return;
        fire();
      });
      return b;
    };
    // Wheel convention: deltaY < 0 = zoom in.
    col.appendChild(mkBtn('+', -1, 'Zoom in one floor'));
    col.appendChild(mkBtn('−', +1, 'Zoom out one floor'));
    root.appendChild(col);

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

    document.body.appendChild(root);
    this._root = root;
  }

  /** @private Keep the slider honest against keys / per-pane toggles (§ no-counter). */
  _startSliderSync() {
    if (!this._slider || !this._paneDensity) return;
    this._sliderTimer = setInterval(() => {
      if (this._sliderDragging || !this._slider) return;
      const live = String(this._paneDensity.visibleCount());
      if (this._slider.value !== live) this._slider.value = live;
    }, this._tune.sliderSyncMs);
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
