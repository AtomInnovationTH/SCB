/**
 * Dev-only, READ-ONLY gesture trace recorder for the Zoom Ladder flick-tuning instrument (docs/ladder/07-flick-tuning.md).
 * Records wheel + trackpad-pinch + iPad glass-pinch streams alongside 10 Hz ladder-state samples so the offline sweep
 * (scripts/flick-sweep.mjs -> js/dev/flickSweepCore.js) can replay REAL gestures. FloorContract.HUMP_SPRING FLICK_* are
 * starting values: retunes come from traces recorded here, never guesswork (01-numbers.md doctrine).
 *
 * ZERO gameplay effect, by contract:
 *   - window-capture WHEEL listener {passive: true, capture: true}; NEVER preventDefault/stopPropagation, mutates nothing
 *     (WheelRouter's own capture listener stays the one consumer of wheel input).
 *   - touchstart/move/end/cancel, also passive window-capture: two-finger distance only, through the SAME pinchWheelDeltaY math
 *     TouchControls feeds the router. The iPad glass pinch never surfaces as DOM wheel events, so the recorder derives the
 *     synthetic stream itself ({kind:'pinch'}).
 *   - an optional injected probe supplies ladder state; absent probe = events only, never a throw.
 *
 * Storage is a bounded ring (TRACE_DEFAULTS caps): newest wins; overwrites reported in meta (`droppedEvents`/`droppedStates`).
 *
 * Node-safe import: no window/document at module scope; ALL DOM access is inside start()/download() behind guards, so the
 * Node suite drives the handlers directly.
 *
 * start() publishes `window.__FLICK_TRACE = { snapshot, download }`. download() writes {meta, events, states} as a JSON Blob +
 * anchor click; headless / Blob-less contexts get console.log instead. Both return the JSON string.
 *
 * Event shape   {tMs, tIn, kind:'wheel'|'pinch', deltaX, deltaY, deltaMode, ctrlKey, sourceClass, wantsPaneSwipe}
 * State shape   {tMs, floor, z01, engaged, refit, library, wantsPaneSwipe}
 * Meta shape    {version, startedAt, t0Ms, tune, touchTune, spring, eventCap, stateCap, sampleHz, droppedEvents, droppedStates}
 *
 * sourceClass comes from the REAL classifier (classifyWheelSource) with the live __WHEEL_TUNE view, so replay never re-derives
 * 'mouse' vs 'scroll'. Swipe monitor: the live router CLAIMS horizontal-dominant wheel events on the workbench floor for the pane
 * carousel (WheelRouter._claimPaneSwipe), so each wheel event also carries `deltaX`, `tIn` (e.timeStamp, the INPUT-timeline stamp the
 * gesture gap is measured on; null if none) and `wantsPaneSwipe` (the hub's claim verdict at capture, via the probe's read-only
 * `paneState()`; null without it); samples carry the two panes' open state. flickSweepCore.scorePaneSwipe replays the claim from
 * these fields. Traces before flick-trace-2 carry no deltaX and score as unavailable.
 *
 * @module dev/FlickTraceRecorder
 */

import { classifyWheelSource, WHEEL_TUNE } from '../systems/WheelRouter.js';
import { pinchWheelDeltaY, TOUCH_TUNE } from '../ui/TouchControls.js';
import { FloorContract } from '../core/FloorContract.js';

/** Trace-format version tag (bump on shape changes; the sweep validates it). */
export const TRACE_VERSION = 'flick-trace-2';

export const TRACE_DEFAULTS = {
  eventCap: 20000,   // ~20k gesture events (a long session at trackpad rates)
  stateCap: 20000,   // 10 Hz ⇒ ~33 min of ladder-state samples
  sampleHz: 10,      // ladder-state sampling cadence
};

/** Fixed-capacity ring buffer: newest wins, overwrites counted. Exported: the bound is a pinned contract. */
export class TraceRing {
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
   * @param {object} [deps] all optional (Node-safe defaults)
   * @param {object|function} [deps.probe] ladder-state source: a function returning {floor, z01, engaged?} (or a getState()-shaped
   *   object), or a LadderController-shaped object ({ladder:{getState}}, isActive?); production passes `ladderController`.
   * @param {function} [deps.now] monotonic ms clock (default performance.now)
   * @param {Window} [deps.win] window-like listener target (default: real window, resolved in start())
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

    // bound once so add/removeEventListener pair up
    this.handleWheel = this.handleWheel.bind(this);
    this.handleTouchStart = this.handleTouchStart.bind(this);
    this.handleTouchMove = this.handleTouchMove.bind(this);
    this.handleTouchEnd = this.handleTouchEnd.bind(this);
    this.sampleState = this.sampleState.bind(this);
  }

  /** Begin recording. DOM work happens HERE only. Windowless (Node): still arms for direct handler calls. */
  start() {
    if (this._started) return;
    this._started = true;
    this._recording = true;
    this._startedAt = new Date().toISOString();
    this._t0Ms = this._now();

    const win = this._resolveWin();
    if (!win) return;   // headless: armed for direct handler calls, no DOM

    // passive (never preventDefault) + capture (observe before any target-phase stopPropagation hides events)
    const opts = { passive: true, capture: true };
    win.addEventListener('wheel', this.handleWheel, opts);
    win.addEventListener('touchstart', this.handleTouchStart, opts);
    win.addEventListener('touchmove', this.handleTouchMove, opts);
    win.addEventListener('touchend', this.handleTouchEnd, opts);
    win.addEventListener('touchcancel', this.handleTouchEnd, opts);

    if (typeof win.setInterval === 'function') {
      this._intervalId = win.setInterval(this.sampleState, Math.round(1000 / this._sampleHz));
    }

    // left installed by stop() on purpose: the captured trace stays downloadable
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

  clear() {
    this._events.clear();
    this._states.clear();
  }

  /** Observe one wheel event; shape-copies what the sweep needs, never consumes it. */
  handleWheel(e) {
    if (!this._recording || !e) return;
    const ps = this._readPaneState();
    this._events.push({
      tMs: this._stamp(),
      // INPUT-timeline stamp (performance.now() timeline), the clock WheelRouter measures the pane-swipe gap on; null for synthetic stubs
      tIn: (Number.isFinite(e.timeStamp) && e.timeStamp > 0) ? _round1(e.timeStamp) : null,
      kind: 'wheel',
      deltaX: _round3(e.deltaX || 0),
      deltaY: _round3(e.deltaY || 0),
      deltaMode: e.deltaMode | 0,
      ctrlKey: !!e.ctrlKey,
      // REAL classifier + LIVE tune at capture; the recorded verdict wins in replay
      sourceClass: classifyWheelSource(e, this._liveWheelTune()),
      // hub's live claim verdict for THIS event (paneState().wantsPaneSwipe); null if the probe has no pane surface
      wantsPaneSwipe: ps ? ps.wantsPaneSwipe : null,
    });
  }

  handleTouchStart(e) {
    if (!this._recording) return;
    const d = _twoFingerDist(e);
    if (d != null) this._pinchDist = d;
  }

  /**
   * Pinch distance delta -> the SAME synthetic-wheel px TouchControls feeds the router (pinchWheelDeltaY, live __TOUCH_TUNE),
   * pre-scaled so replay applies NO extra gain (as routeSyntheticWheel's tagged synthetics). Recorded {kind:'pinch', sourceClass:'pinch'}.
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
          tIn: null,              // a derived sample, not a DOM event: no input stamp
          kind: 'pinch',
          deltaX: 0,              // a pinch is zoom whatever its axis (isHorizontalWheel excludes it)
          deltaY: _round3(dy),
          deltaMode: 0,
          ctrlKey: false,
          sourceClass: 'pinch',   // by construction: routeSyntheticWheel tags __syntheticPinch
          wantsPaneSwipe: null,   // never claimed — not a wheel event
        });
      }
    }
    this._pinchDist = d;
  }

  handleTouchEnd(e) {
    const n = (e && e.touches && e.touches.length) | 0;
    if (n < 2) this._pinchDist = null;
  }

  /** One 10 Hz ladder-state sample; probe absent, unresolvable or throwing = no sample. */
  sampleState() {
    if (!this._recording) return;
    const s = this._readProbe();
    if (!s) return;
    // a function probe may carry pane state on its snapshot; a LadderController-shaped one answers via paneState()
    const ps = this._readPaneState() || {};
    const bool = (a, b) => (typeof a === 'boolean') ? a : ((typeof b === 'boolean') ? b : null);
    this._states.push({
      tMs: this._stamp(),
      floor: Number.isFinite(s.floor) ? s.floor : null,
      z01: Number.isFinite(s.z01) ? _round4(s.z01) : null,
      engaged: typeof s.engaged === 'boolean' ? s.engaged : null,
      refit: bool(s.refit, ps.refit),
      library: bool(s.library, ps.library),
      wantsPaneSwipe: bool(s.wantsPaneSwipe, ps.wantsPaneSwipe),
    });
  }

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

  /** Serialize the snapshot to JSON: Blob + anchor click (flick-trace-<ts>.json) in DOM contexts, else console.log. Returns the JSON. */
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

  _resolveWin() {
    if (this._win) return this._win;
    return (typeof window !== 'undefined') ? window : null;
  }

  _stamp() { return Math.round(this._now() * 10) / 10; }

  _liveWheelTune() {
    const win = this._resolveWin();
    const o = (win && win.__WHEEL_TUNE) || null;
    return o ? { ...WHEEL_TUNE, ...o } : { ...WHEEL_TUNE };
  }

  _liveTouchTune() {
    const win = this._resolveWin();
    const o = (win && win.__TOUCH_TUNE) || null;
    return o ? { ...TOUCH_TUNE, ...o } : { ...TOUCH_TUNE };
  }

  /** Read-only `paneState()` of the probe -> {refit, library, wantsPaneSwipe}; absent/throwing -> null. */
  _readPaneState() {
    const p = this._probe;
    if (!p || typeof p.paneState !== 'function') return null;
    try {
      const ps = p.paneState();
      if (!ps) return null;
      const bool = (v) => (typeof v === 'boolean') ? v : null;
      return { refit: bool(ps.refit), library: bool(ps.library), wantsPaneSwipe: bool(ps.wantsPaneSwipe) };
    } catch (_e) {
      return null;
    }
  }

  /** Resolve the probe to {floor, z01, engaged} (function, getState()-shaped, or LadderController-shaped); never throws. */
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

function _twoFingerDist(e) {
  const t = e && e.touches;
  if (!t || t.length < 2) return null;
  const dx = t[0].clientX - t[1].clientX;
  const dy = t[0].clientY - t[1].clientY;
  return Math.hypot(dx, dy);
}

function _round1(x) { return Math.round(x * 10) / 10; }
function _round3(x) { return Math.round(x * 1000) / 1000; }
function _round4(x) { return Math.round(x * 10000) / 10000; }
