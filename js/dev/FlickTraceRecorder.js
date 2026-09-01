/**
 * FlickTraceRecorder.js — dev-only, READ-ONLY gesture trace recorder for the
 * Zoom Ladder flick-tuning instrument (docs/ladder/07-flick-tuning.md).
 *
 * Records what the player's hands actually do (wheel + trackpad-pinch + iPad
 * glass-pinch streams) alongside 10 Hz ladder-state samples, so the offline
 * sweep harness (scripts/flick-sweep.mjs → js/dev/flickSweepCore.js) can
 * replay REAL gestures through fresh ZoomLadder cores and score flick-grammar
 * constant candidates against observed behavior. The current constants
 * (FloorContract.HUMP_SPRING FLICK_*) are starting values — retunes must come
 * from traces recorded here, never from guesswork (01-numbers.md doctrine).
 *
 * ZERO gameplay effect, by contract:
 *   - window-capture WHEEL listener registered {passive: true, capture: true};
 *     NEVER calls preventDefault, NEVER calls stopPropagation, mutates nothing
 *     it observes. It coexists with WheelRouter's own capture listener (which
 *     stays the one consumer/owner of wheel input).
 *   - touchstart/move/end(/cancel) listeners, also passive window-capture:
 *     two-finger distance sampling only, mirrored through the SAME
 *     pinchWheelDeltaY math TouchControls feeds the router with — the iPad
 *     glass pinch never surfaces as DOM wheel events, so the recorder derives
 *     the equivalent synthetic stream itself ({kind:'pinch'}).
 *   - an optional injected probe supplies ladder state; absent probe = events
 *     only, never a throw (dep-optional like every ladder consumer).
 *
 * Storage is a bounded ring (TRACE_DEFAULTS.eventCap ≈ 20k events; states
 * bounded separately): the newest data always wins, overwrite counts are
 * reported honestly in meta (`droppedEvents`/`droppedStates`).
 *
 * Node-safe import: nothing here touches window/document at module scope —
 * ALL DOM access happens inside start()/download() behind guards, so the Node
 * test suite exercises the full recording surface via direct handler calls.
 *
 * Publishing (start(), DOM contexts only):
 *   window.__FLICK_TRACE = { snapshot, download }
 * download() serializes {meta, events, states} to a JSON Blob + anchor click
 * (netshot pattern); headless / Blob-less contexts get the JSON on
 * console.log instead. Both paths return the JSON string.
 *
 * Event shape   {tMs, kind:'wheel'|'pinch', deltaY, deltaMode, ctrlKey, sourceClass}
 * State shape   {tMs, floor, z01, engaged}
 * Meta shape    {version, startedAt, t0Ms, tune, touchTune, spring, eventCap,
 *                stateCap, sampleHz, droppedEvents, droppedStates}
 *
 * sourceClass comes from the REAL classifier (classifyWheelSource — a pure
 * WheelRouter export) with the live __WHEEL_TUNE override view, so replay
 * never has to re-derive 'mouse' vs 'scroll' from fields the trace doesn't
 * carry (deltaX is consumed by classification, not recorded).
 *
 * @module dev/FlickTraceRecorder
 */

import { classifyWheelSource, WHEEL_TUNE } from '../systems/WheelRouter.js';
import { pinchWheelDeltaY, TOUCH_TUNE } from '../ui/TouchControls.js';
import { FloorContract } from '../core/FloorContract.js';

/** Trace-format version tag (bump on shape changes; the sweep validates it). */
export const TRACE_VERSION = 'flick-trace-1';

/** Bounds + cadence defaults (overridable via constructor deps, tests use tiny caps). */
export const TRACE_DEFAULTS = {
  eventCap: 20000,   // ~20k gesture events (a long session at trackpad rates)
  stateCap: 20000,   // 10 Hz ⇒ ~33 min of ladder-state samples
  sampleHz: 10,      // ladder-state sampling cadence
};

/**
 * Fixed-capacity ring buffer: newest data wins, overwrites counted.
 * Exported for the suite (bound behavior is a pinned contract).
 */
export class TraceRing {
  /** @param {number} cap - capacity (≥ 1) */
  constructor(cap) {
    this._cap = Math.max(1, cap | 0);
    this._buf = new Array(this._cap);
    this._n = 0;        // filled count (≤ cap)
    this._i = 0;        // next write index
    this.dropped = 0;   // overwrite count (oldest lost)
  }

  get length() { return this._n; }
  get cap() { return this._cap; }

  push(v) {
    if (this._n === this._cap) this.dropped++;
    else this._n++;
    this._buf[this._i] = v;
    this._i = (this._i + 1) % this._cap;
  }

  /** Chronological copy (oldest → newest). */
  toArray() {
    const out = new Array(this._n);
    const start = (this._i - this._n + this._cap) % this._cap;
    for (let k = 0; k < this._n; k++) out[k] = this._buf[(start + k) % this._cap];
    return out;
  }

  clear() {
    this._buf = new Array(this._cap);
    this._n = 0;
    this._i = 0;
    this.dropped = 0;
  }
}

export class FlickTraceRecorder {
  /**
   * @param {object} [deps] - everything optional (dev tool; Node-safe defaults)
   * @param {object|function} [deps.probe] - ladder-state source. Accepts:
   *   a function returning {floor, z01, engaged?} (or a getState()-shaped
   *   object), OR a LadderController-shaped object ({ladder:{getState}},
   *   isActive?) — production passes `ladderController` directly. Absent ⇒
   *   events-only recording.
   * @param {function} [deps.now] - monotonic ms clock (default performance.now)
   * @param {Window}  [deps.win] - window-like listener target (tests inject a
   *   fake; default = the real window, resolved inside start())
   * @param {number} [deps.eventCap] @param {number} [deps.stateCap]
   * @param {number} [deps.sampleHz]
   */
  constructor({ probe, now, win, eventCap, stateCap, sampleHz } = {}) {
    this._probe = probe || null;
    this._now = now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this._win = win || null;   // resolved lazily in start(); null in Node stays null
    this._events = new TraceRing(eventCap ?? TRACE_DEFAULTS.eventCap);
    this._states = new TraceRing(stateCap ?? TRACE_DEFAULTS.stateCap);
    this._sampleHz = sampleHz ?? TRACE_DEFAULTS.sampleHz;

    this._recording = false;
    this._started = false;
    this._startedAt = null;    // ISO string, set by start()
    this._t0Ms = null;         // this._now() at start()
    this._intervalId = null;
    this._pinchDist = null;    // live two-finger distance (px) or null

    // Bound once so add/removeEventListener pair up.
    this.handleWheel = this.handleWheel.bind(this);
    this.handleTouchStart = this.handleTouchStart.bind(this);
    this.handleTouchMove = this.handleTouchMove.bind(this);
    this.handleTouchEnd = this.handleTouchEnd.bind(this);
    this.sampleState = this.sampleState.bind(this);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Begin recording. DOM work happens HERE only: window-capture passive
   * listeners + the 10 Hz state-sample interval + the window.__FLICK_TRACE
   * hook. In a windowless context (Node suite) recording still arms — tests
   * feed the public handlers directly.
   */
  start() {
    if (this._started) return;
    this._started = true;
    this._recording = true;
    this._startedAt = new Date().toISOString();
    this._t0Ms = this._now();

    const win = this._resolveWin();
    if (!win) return;   // headless: armed for direct handler calls, no DOM

    // READ-ONLY listener contract: passive (never preventDefault — the UA may
    // ignore one from a passive listener anyway, and we never call it),
    // capture (observe before any target-phase stopPropagation can hide
    // events), and no mutation of the events observed.
    const opts = { passive: true, capture: true };
    win.addEventListener('wheel', this.handleWheel, opts);
    win.addEventListener('touchstart', this.handleTouchStart, opts);
    win.addEventListener('touchmove', this.handleTouchMove, opts);
    win.addEventListener('touchend', this.handleTouchEnd, opts);
    win.addEventListener('touchcancel', this.handleTouchEnd, opts);

    if (typeof win.setInterval === 'function') {
      this._intervalId = win.setInterval(this.sampleState, Math.round(1000 / this._sampleHz));
    }

    // DevTools surface. Left installed by stop() on purpose: recording stops,
    // but the captured trace stays downloadable.
    win.__FLICK_TRACE = {
      snapshot: () => this.snapshot(),
      download: () => this.download(),
    };
  }

  /** Stop recording (listeners + interval off). Data + hook remain readable. */
  stop() {
    if (!this._started) return;
    this._started = false;
    this._recording = false;
    const win = this._resolveWin();
    if (!win) return;
    win.removeEventListener('wheel', this.handleWheel, { capture: true });
    win.removeEventListener('touchstart', this.handleTouchStart, { capture: true });
    win.removeEventListener('touchmove', this.handleTouchMove, { capture: true });
    win.removeEventListener('touchend', this.handleTouchEnd, { capture: true });
    win.removeEventListener('touchcancel', this.handleTouchEnd, { capture: true });
    if (this._intervalId != null && typeof win.clearInterval === 'function') {
      win.clearInterval(this._intervalId);
    }
    this._intervalId = null;
    this._pinchDist = null;
  }

  /** Drop everything recorded so far (bounds/meta counters reset too). */
  clear() {
    this._events.clear();
    this._states.clear();
  }

  // ── Recording handlers (public: the Node suite drives them directly) ─────

  /**
   * Observe one wheel event. Never consumes it: no preventDefault, no
   * stopPropagation, no field mutation — shape-copies what the sweep needs.
   * @param {WheelEvent|object} e
   */
  handleWheel(e) {
    if (!this._recording || !e) return;
    this._events.push({
      tMs: this._stamp(),
      kind: 'wheel',
      deltaY: _round3(e.deltaY || 0),
      deltaMode: e.deltaMode | 0,
      ctrlKey: !!e.ctrlKey,
      // The REAL classifier + the LIVE tune view: 'mouse'/'scroll' need
      // deltaX + integer-detent context that the recorded shape doesn't
      // carry, so classification happens at capture time, not replay time.
      sourceClass: classifyWheelSource(e, this._liveWheelTune()),
    });
  }

  /** Two-finger distance baseline (≥ 2 touches arms the pinch sampler). */
  handleTouchStart(e) {
    if (!this._recording) return;
    const d = _twoFingerDist(e);
    if (d != null) this._pinchDist = d;
  }

  /**
   * Pinch distance delta → the SAME synthetic-wheel px TouchControls would
   * feed the router (pinchWheelDeltaY, live __TOUCH_TUNE view, pre-scaled —
   * so replay applies NO extra gain, mirroring routeSyntheticWheel's tagged
   * synthetics). Recorded as {kind:'pinch', sourceClass:'pinch'}.
   */
  handleTouchMove(e) {
    if (!this._recording) return;
    const d = _twoFingerDist(e);
    if (d == null) return;
    if (this._pinchDist != null) {
      const dy = pinchWheelDeltaY(this._pinchDist, d, this._liveTouchTune());
      if (dy !== 0) {
        this._events.push({
          tMs: this._stamp(),
          kind: 'pinch',
          deltaY: _round3(dy),
          deltaMode: 0,
          ctrlKey: false,
          sourceClass: 'pinch',   // by construction: routeSyntheticWheel tags __syntheticPinch
        });
      }
    }
    this._pinchDist = d;
  }

  /** Fewer than two fingers left → the pinch sampler disarms. */
  handleTouchEnd(e) {
    const n = (e && e.touches && e.touches.length) | 0;
    if (n < 2) this._pinchDist = null;
  }

  /**
   * One 10 Hz ladder-state sample (interval-driven; tests call directly).
   * Probe absent, unresolvable, or throwing ⇒ silently no sample.
   */
  sampleState() {
    if (!this._recording) return;
    const s = this._readProbe();
    if (!s) return;
    this._states.push({
      tMs: this._stamp(),
      floor: Number.isFinite(s.floor) ? s.floor : null,
      z01: Number.isFinite(s.z01) ? _round4(s.z01) : null,
      engaged: typeof s.engaged === 'boolean' ? s.engaged : null,
    });
  }

  // ── Output ────────────────────────────────────────────────────────────────

  /** Full trace snapshot — fresh arrays/objects, mutation-safe. */
  snapshot() {
    return {
      meta: {
        version: TRACE_VERSION,
        startedAt: this._startedAt,
        t0Ms: this._t0Ms,
        tune: this._liveWheelTune(),            // WHEEL_TUNE ∪ live __WHEEL_TUNE override
        touchTune: this._liveTouchTune(),       // TOUCH_TUNE ∪ live __TOUCH_TUNE override
        spring: { ...FloorContract.HUMP_SPRING }, // recorded baseline the sweep compares against
        eventCap: this._events.cap,
        stateCap: this._states.cap,
        sampleHz: this._sampleHz,
        droppedEvents: this._events.dropped,
        droppedStates: this._states.dropped,
      },
      events: this._events.toArray(),
      states: this._states.toArray(),
    };
  }

  /**
   * Serialize the snapshot to JSON. DOM contexts: Blob + anchor click
   * (flick-trace-<ts>.json, netshot pattern). Headless / Blob-less contexts:
   * the JSON goes to console.log (copy-paste / pipe capture). Returns the
   * JSON string either way.
   * @returns {string}
   */
  download() {
    const json = JSON.stringify(this.snapshot());
    const win = this._resolveWin();
    const doc = win && win.document;
    if (doc && typeof doc.createElement === 'function' &&
        typeof Blob !== 'undefined' && win.URL &&
        typeof win.URL.createObjectURL === 'function') {
      try {
        const blob = new Blob([json], { type: 'application/json' });
        const url = win.URL.createObjectURL(blob);
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const a = doc.createElement('a');
        a.href = url;
        a.download = `flick-trace-${ts}.json`;
        doc.body.appendChild(a);
        a.click();
        doc.body.removeChild(a);
        win.URL.revokeObjectURL(url);
        console.info(`[FlickTrace] saved ${a.download} ` +
          `(${this._events.length} events, ${this._states.length} states)`);
        return json;
      } catch (err) {
        console.warn('[FlickTrace] blob download failed, logging JSON instead:', err);
      }
    }
    console.log(json);   // headless: the JSON itself, capturable/copyable
    return json;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** @private Injected win, else the real window, else null (Node). */
  _resolveWin() {
    if (this._win) return this._win;
    return (typeof window !== 'undefined') ? window : null;
  }

  /** @private Trace timestamp: monotonic ms at 0.1 ms grain (JSON size). */
  _stamp() { return Math.round(this._now() * 10) / 10; }

  /** @private WHEEL_TUNE with any live window.__WHEEL_TUNE override merged. */
  _liveWheelTune() {
    const win = this._resolveWin();
    const o = (win && win.__WHEEL_TUNE) || null;
    return o ? { ...WHEEL_TUNE, ...o } : { ...WHEEL_TUNE };
  }

  /** @private TOUCH_TUNE with any live window.__TOUCH_TUNE override merged. */
  _liveTouchTune() {
    const win = this._resolveWin();
    const o = (win && win.__TOUCH_TUNE) || null;
    return o ? { ...TOUCH_TUNE, ...o } : { ...TOUCH_TUNE };
  }

  /**
   * @private Resolve the injected probe to {floor, z01, engaged}. Accepts a
   * function (returning that shape or a ZoomLadder getState() snapshot) or a
   * LadderController-shaped object. Never throws.
   */
  _readProbe() {
    const p = this._probe;
    if (!p) return null;
    try {
      if (typeof p === 'function') {
        const s = p();
        return s || null;
      }
      if (p.ladder && typeof p.ladder.getState === 'function') {
        const s = p.ladder.getState();
        return {
          floor: s.floor,
          z01: s.z01,
          engaged: (typeof p.isActive === 'function') ? !!p.isActive() : undefined,
        };
      }
      if (typeof p.getState === 'function') {
        const s = p.getState();
        return { floor: s.floor, z01: s.z01, engaged: s.engaged };
      }
    } catch (_e) {
      return null;   // a broken probe must never break recording
    }
    return null;
  }
}

/** @private Two-finger distance in px, or null when < 2 touches. */
function _twoFingerDist(e) {
  const t = e && e.touches;
  if (!t || t.length < 2) return null;
  const dx = t[0].clientX - t[1].clientX;
  const dy = t[0].clientY - t[1].clientY;
  return Math.hypot(dx, dy);
}

function _round3(x) { return Math.round(x * 1000) / 1000; }
function _round4(x) { return Math.round(x * 10000) / 10000; }
