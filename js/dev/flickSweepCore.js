/**
 * PURE offline scoring core for the flick-tuning sweep (docs/ladder/07-flick-tuning.md); CLI wrapper
 * scripts/flick-sweep.mjs. Deterministic, DOM-free, Date-free; exported for test-FlickSweep.js.
 *
 * Pipeline:
 *   1. segmentBursts(events)     - recorded gesture events -> intent bursts (silence-gap segmentation)
 *   2. replayTrace(events, opts) - feed the trace through a FRESH ZoomLadder per candidate, with the same normalizeWheel
 *      math + source-class gating as WheelRouter (recorded sourceClass wins: deltaX is consumed at capture time).
 *      Ride completions are simulated on the recorded clock: offline there is no camera to report rideFinished.
 *   3. scoreReplay(...)          - per-burst crossing attribution -> metrics
 *   4. sweepGrid(traces, opts)   - cartesian grid of ZoomLadder `spring` overrides (FLICK_* + CHARGE_THRESHOLD),
 *      ranked by score asc, candidate key asc
 *
 * Metrics (lower composite score = better; COMPARATIVE across candidates on one trace, not absolute):
 *   crossingsPerBurst - floor changes per burst (1.0 ideal; free-scroll bursts pull it below 1 equally for every
 *                       candidate)
 *   overshoots        - extra crossings inside one burst
 *   denied            - wall bounces (dock gate / ladder end refusals)
 *   undos             - reversal crossings shortly after a cross
 *   medianLatencyMs   - burst start to first crossing in that burst
 *
 * @module dev/flickSweepCore
 */

import { ZoomLadder } from '../core/ZoomLadder.js';
import {
  normalizeWheel, classifyWheelSource, WHEEL_TUNE, isHorizontalWheel, wheelDeltaXPx, stepPaneSwipe,
} from '../systems/WheelRouter.js';
import { FloorContract } from '../core/FloorContract.js';

export const SWEEP_DEFAULTS = {
  burstGapMs: 300,          // inter-event silence ≥ this starts a new burst
  reversalWindowMs: 1500,   // cross reversing the previous cross within this = an undo
  crossRideMs: 550,         // simulated crossing-ride duration (midpoint of the 450–650 window)
  noCrossLatencyMs: 1000,   // latency penalty stand-in when a candidate never crosses
  weights: {                // composite score weights (lower score = better)
    cpb: 1.0,               // |crossingsPerBurst − 1|
    overshoot: 1.5,         // overshoots per burst (worst failure: unintended floors)
    denied: 1.0,            // denials per burst
    undo: 1.0,              // undos per burst
    latency: 0.5,           // medianLatencyMs / 1000
  },
  paneReversalMs: 1500,     // a page then a REVERSE page within this = a FALSE page (observational, fixed)
  paneMissLowPx: 90,        // an unfired gesture whose peak |sum| ∈ [this, paneSwipePx) = a MISSED page
  paneRiseFactor: 1.5,      // inside a latched tail: |dx| ≥ prev × this (and ≥ prev + paneRiseMinPx) after ≥ 2 decaying events = an EATEN second flick
  paneRiseMinPx: 8,
};

/** Default candidate grid; includes the shipped baseline (FloorContract.HUMP_SPRING: 2.0 / 160 / 800) so the incumbent always ranks.
 *  CHARGE_THRESHOLD is sweepable via CLI (--CHARGE_THRESHOLD=...) but off the grid. */
export const DEFAULT_GRID = {
  FLICK_MIN_MAG: [1.4, 1.7, 2.0, 2.4, 2.8],
  FLICK_MAX_DRIVE_MS: [120, 160, 200, 240],
  FLICK_UNDO_WINDOW_MS: [500, 800, 1100],
};

/** Split events into bursts on silence gaps (sorted copy; input not mutated). A gap >= gapMs starts a new burst (pinned). */
export function segmentBursts(events, gapMs = SWEEP_DEFAULTS.burstGapMs) {
  if (!Array.isArray(events) || events.length === 0) return [];
  const sorted = events.slice().sort((a, b) => a.tMs - b.tMs);
  const bursts = [];
  let cur = { startMs: sorted[0].tMs, endMs: sorted[0].tMs, count: 1 };
  for (let i = 1; i < sorted.length; i++) {
    const t = sorted[i].tMs;
    if (t - cur.endMs >= gapMs) {
      bursts.push(cur);
      cur = { startMs: t, endMs: t, count: 1 };
    } else {
      cur.endMs = t;
      cur.count++;
    }
  }
  bursts.push(cur);
  return bursts;
}

/**
 * One recorded trace event -> the {tMs, dir, mag} the ladder core got live (WheelRouter recipe): source-class feed gating, ctrl-pinch
 * gain (tagged synthetic pinches arrive pre-scaled: no gain), then normalizeWheel. The RECORDED sourceClass wins over
 * re-classification ('mouse' vs 'scroll' depends on deltaX, consumed at capture time).
 * @param {typeof WHEEL_TUNE} [tune] the trace's recorded tune (meta.tune)
 * @returns {?{tMs:number, dir:'in'|'out', mag:number}} null = muted/zero
 */
export function ladderEventFromTrace(ev, tune = WHEEL_TUNE, invert = false) {
  if (!ev || !Number.isFinite(ev.tMs)) return null;
  const src = ev.sourceClass || classifyWheelSource({
    deltaY: ev.deltaY, deltaMode: ev.deltaMode, ctrlKey: ev.ctrlKey,
    __syntheticPinch: ev.kind === 'pinch',
  }, tune);
  const feed = src === 'pinch' ? tune.pinchZoom
    : src === 'mouse' ? tune.mouseWheelZoom
    : tune.scrollZoom;
  if (!feed) return null;
  const scaled = (src === 'pinch' && ev.ctrlKey)
    ? { deltaY: (ev.deltaY || 0) * (Number.isFinite(tune.pinchGain) ? tune.pinchGain : 1), deltaMode: 0 }
    : { deltaY: ev.deltaY || 0, deltaMode: ev.deltaMode || 0 };
  const { dir, mag } = normalizeWheel(scaled, !!invert);
  return mag > 0 ? { tMs: ev.tMs, dir, mag } : null;
}

/**
 * Replay events through a fresh ZoomLadder with the candidate's spring overrides on recorded timestamps. Ride completions are
 * simulated: a 'cross' finishes crossRideMs later (midpoint of the locked 450-650 ms window; arms the G3 undo window on the core's
 * clock); a 'ride' at its own miniMs (flickWall/jump) or crossRideMs when null. A later ride REPLACES the pending completion (S2 ride swap).
 * @param {object} [opts] {spring, rules (ZoomLadder overrides), tune, invert, crossRideMs}
 * @returns {{decisions: Array<{tMs:number, d:object}>, finalState: object}}
 */
export function replayTrace(events, opts = {}) {
  const tune = { ...WHEEL_TUNE, ...(opts.tune || {}) };
  const crossRideMs = Number.isFinite(opts.crossRideMs)
    ? opts.crossRideMs : SWEEP_DEFAULTS.crossRideMs;
  const ladder = new ZoomLadder({
    spring: opts.spring || {},
    rules: opts.rules || {},
  });

  const sorted = (events || []).slice().sort((a, b) => a.tMs - b.tMs);
  const decisions = [];
  let pendingRideEndMs = null;

  const record = (tMs, ds) => {
    for (const d of ds) {
      decisions.push({ tMs, d });
      if (d.type === 'cross') {
        pendingRideEndMs = tMs + crossRideMs;
      } else if (d.type === 'ride') {
        pendingRideEndMs = tMs + (Number.isFinite(d.miniMs) ? d.miniMs : crossRideMs);
      }
    }
  };

  for (const raw of sorted) {
    const t = raw.tMs;
    if (!Number.isFinite(t)) continue;
    if (pendingRideEndMs != null && pendingRideEndMs <= t) {
      const endT = pendingRideEndMs;
      pendingRideEndMs = null;
      ladder.rideFinished({ tMs: endT });   // arms the undo window on-clock
    }
    record(t, ladder.update(t));            // settle-back etc. on the trace clock
    // an event the live router CLAIMED for the pane carousel never reached the zoom core; replay skips it too
    // (older traces carry neither deltaX nor the claim verdict and replay as before)
    if (isClaimedEvent(raw, tune)) continue;
    const le = ladderEventFromTrace(raw, tune, opts.invert);
    if (!le) continue;                      // muted class / zero mag: the core never saw it live either
    record(t, ladder.wheel(le));
  }
  if (pendingRideEndMs != null) {
    ladder.rideFinished({ tMs: pendingRideEndMs });
  }
  return { decisions, finalState: ladder.getState() };
}

/**
 * Would the live router have CLAIMED this recorded event for the pane carousel? `WheelRouter._claimPaneSwipe`'s gate replayed from
 * recorded fields: tune `paneSwipe` on, `isHorizontalWheel` (|deltaX| > |deltaY|, never a pinch), and the hub's verdict
 * `wantsPaneSwipe` recorded AT CAPTURE. No `deltaX` or no verdict never claims. Pure.
 * @param {typeof WHEEL_TUNE} [tune] the trace's recorded tune
 */
export function isClaimedEvent(ev, tune = WHEEL_TUNE) {
  if (!ev || !tune.paneSwipe || ev.wantsPaneSwipe !== true) return false;
  if (!Number.isFinite(ev.deltaX) || ev.deltaX === 0) return false;
  return isHorizontalWheel({
    deltaX: ev.deltaX, deltaY: ev.deltaY || 0, ctrlKey: !!ev.ctrlKey,
    __syntheticPinch: ev.kind === 'pinch',
  });
}

/**
 * Replay the recorded horizontal axis through the pure `stepPaneSwipe` law (recorded `WHEEL_TUNE.paneSwipe*`; gesture gap measured on
 * the INPUT timeline `tIn` when recorded, else `tMs`) and score the player's hands against the grammar's decisions. Pure.
 *
 * A GESTURE is a run of claimed horizontal events with gaps < recorded `paneSwipeGapMs` (not the zoom sweep's --gap). Metrics:
 *   gestures, pages (verbs fired; pagesPerGesture), claimedEvents, pinchEvents (never horizontal),
 *   horizontalUnclaimed - horizontal-dominant but the hub said no (off F3, disengaged, no panes)
 *   falsePages  - a page followed by a REVERSE page within paneReversalMs
 *   missedPages - unfired gestures whose PEAK |signed sum| reached [paneMissLowPx, paneSwipePx)
 *   eatenFlicks - rising edges of |deltaX| inside a LATCHED tail (after a page fired, >= 2 decaying events, then |dx| >= prev x
 *                 paneRiseFactor and >= prev + paneRiseMinPx): a second flick the gap law swallowed (owner decision 4: no
 *                 rising-edge re-arm until these say so)
 *   fireLatencies / medianFireLatencyMs - gesture start to the firing event (ms, input timeline)
 * Traces without `deltaX` report `{ available: false }`.
 *
 * @param {typeof WHEEL_TUNE} [tune] the trace's recorded tune (meta.tune)
 * @param {object} [opts] {paneReversalMs, paneMissLowPx, paneRiseFactor, paneRiseMinPx}
 */
export function scorePaneSwipe(events, tune = WHEEL_TUNE, opts = {}) {
  const T = { ...WHEEL_TUNE, ...(tune || {}) };
  const revMs = Number.isFinite(opts.paneReversalMs) ? opts.paneReversalMs : SWEEP_DEFAULTS.paneReversalMs;
  const missLow = Number.isFinite(opts.paneMissLowPx) ? opts.paneMissLowPx : SWEEP_DEFAULTS.paneMissLowPx;
  const riseK = Number.isFinite(opts.paneRiseFactor) ? opts.paneRiseFactor : SWEEP_DEFAULTS.paneRiseFactor;
  const riseMin = Number.isFinite(opts.paneRiseMinPx) ? opts.paneRiseMinPx : SWEEP_DEFAULTS.paneRiseMinPx;
  const gapMs = Number.isFinite(T.paneSwipeGapMs) ? T.paneSwipeGapMs : WHEEL_TUNE.paneSwipeGapMs;
  const thr = Number.isFinite(T.paneSwipePx) ? T.paneSwipePx : WHEEL_TUNE.paneSwipePx;

  const list = (events || []).filter((e) => e && Number.isFinite(e.tMs)).slice().sort((a, b) => a.tMs - b.tMs);
  const available = list.some((e) => Number.isFinite(e.deltaX));
  const base = {
    available, tune: { paneSwipe: !!T.paneSwipe, paneSwipePx: thr, paneSwipeGapMs: gapMs, paneSwipeSign: T.paneSwipeSign === -1 ? -1 : 1 },
    events: list.length, claimedEvents: 0, horizontalUnclaimed: 0, pinchEvents: 0,
    gestures: 0, pages: 0, pagesPerGesture: 0, falsePages: 0, missedPages: 0, eatenFlicks: 0,
    fireLatencies: [], medianFireLatencyMs: null, pageLog: [],
  };
  if (!available) return base;

  const s = { acc: 0, lastMs: -Infinity, latched: false };
  let g = null;                     // the open gesture
  const closeGesture = () => {
    if (!g) return;
    base.gestures++;
    if (!g.fired && g.peak >= missLow && g.peak < thr) base.missedPages++;
    g = null;
  };
  for (const ev of list) {
    if (ev.kind === 'pinch' || ev.ctrlKey) { base.pinchEvents++; continue; }
    const horizontal = isHorizontalWheel({ deltaX: ev.deltaX || 0, deltaY: ev.deltaY || 0, ctrlKey: false });
    if (!horizontal) continue;
    if (!isClaimedEvent(ev, T)) { base.horizontalUnclaimed++; continue; }
    base.claimedEvents++;
    const tIn = Number.isFinite(ev.tIn) ? ev.tIn : ev.tMs;
    const dx = wheelDeltaXPx({ deltaX: ev.deltaX, deltaMode: ev.deltaMode || 0 });
    if (g && tIn - g.lastIn >= gapMs) closeGesture();
    if (!g) g = { startIn: tIn, lastIn: tIn, peak: 0, fired: false, prevAbs: null, decaying: 0 };
    const toward = stepPaneSwipe(s, dx, tIn, T);
    g.lastIn = tIn;
    if (!g.fired) {
      const a = Math.abs(s.acc);
      if (a > g.peak) g.peak = a;
    }
    if (toward) {
      g.fired = true;
      g.peak = thr;
      base.pages++;
      base.fireLatencies.push(tIn - g.startIn);
      base.pageLog.push({ tMs: ev.tMs, toward });
      g.prevAbs = Math.abs(dx); g.decaying = 0;
    } else if (g.fired) {
      // Inside the latched tail: watch for a rising edge (a second flick).
      const a = Math.abs(dx);
      if (g.prevAbs != null) {
        if (a < g.prevAbs) g.decaying++;
        else if (g.decaying >= 2 && a >= g.prevAbs * riseK && a >= g.prevAbs + riseMin) { base.eatenFlicks++; g.decaying = 0; }
      }
      g.prevAbs = a;
    }
  }
  closeGesture();
  for (let i = 1; i < base.pageLog.length; i++) {
    const p = base.pageLog[i], q = base.pageLog[i - 1];
    if (p.toward !== q.toward && (p.tMs - q.tMs) <= revMs) base.falsePages++;
  }
  base.pagesPerGesture = base.pages / (base.gestures || 1);
  base.medianFireLatencyMs = median(base.fireLatencies);
  return base;
}

export function median(xs) {
  if (!Array.isArray(xs) || xs.length === 0) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return (s.length % 2 === 1) ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Score one replay against the trace's gesture bursts. Crossings/denials go to the burst whose [startMs, endMs] contains their
 * trigger event (crossings only fire ON wheel events, so containment is exact). Undos = a crossing opposite to the previous one within
 * reversalWindowMs, an OBSERVATIONAL window (fixed), deliberately not the candidate's FLICK_UNDO_WINDOW_MS.
 * @param {Array<{tMs:number, d:object}>} decisions replayTrace output
 * @param {object} [opts] {burstGapMs, reversalWindowMs}
 */
export function scoreReplay(events, decisions, opts = {}) {
  const gapMs = Number.isFinite(opts.burstGapMs) ? opts.burstGapMs : SWEEP_DEFAULTS.burstGapMs;
  const revMs = Number.isFinite(opts.reversalWindowMs)
    ? opts.reversalWindowMs : SWEEP_DEFAULTS.reversalWindowMs;

  const bursts = segmentBursts(events, gapMs);
  const crosses = [];
  let denied = 0;
  for (const { tMs, d } of decisions) {
    if (d.type === 'cross') crosses.push({ tMs, direction: d.direction });
    else if (d.type === 'denied') denied++;
  }

  let overshoots = 0;
  const latencies = [];
  for (const b of bursts) {
    let inBurst = 0;
    let firstT = null;
    for (const c of crosses) {
      if (c.tMs >= b.startMs && c.tMs <= b.endMs) {
        inBurst++;
        if (firstT === null) firstT = c.tMs;
      }
    }
    if (inBurst > 1) overshoots += inBurst - 1;
    if (firstT !== null) latencies.push(firstT - b.startMs);
  }

  let undos = 0;
  for (let i = 1; i < crosses.length; i++) {
    if (crosses[i].direction !== crosses[i - 1].direction &&
        (crosses[i].tMs - crosses[i - 1].tMs) <= revMs) {
      undos++;
    }
  }

  return {
    bursts: bursts.length,
    crossings: crosses.length,
    crossingsPerBurst: crosses.length / (bursts.length || 1),
    overshoots,
    denied,
    undos,
    latencies,
    medianLatencyMs: median(latencies),
  };
}

/**
 * Composite score, LOWER is better. Per-burst normalization keeps different-length traces comparable; a candidate that never crosses
 * takes the full |cpb-1| penalty plus the noCrossLatencyMs stand-in, so it ranks last.
 * @param {object} m metrics (scoreReplay/aggregate shape)
 */
export function scoreFromMetrics(m, weights = SWEEP_DEFAULTS.weights,
  noCrossLatencyMs = SWEEP_DEFAULTS.noCrossLatencyMs) {
  const w = { ...SWEEP_DEFAULTS.weights, ...(weights || {}) };
  const perBurst = (x) => x / (m.bursts || 1);
  const latencyMs = (m.medianLatencyMs == null) ? noCrossLatencyMs : m.medianLatencyMs;
  return w.cpb * Math.abs(m.crossingsPerBurst - 1)
    + w.overshoot * perBurst(m.overshoots)
    + w.denied * perBurst(m.denied)
    + w.undo * perBurst(m.undos)
    + w.latency * (latencyMs / 1000);
}

/**
 * Cartesian product of a {KEY: [values]} grid -> spring-override candidates. Keys sorted (input order irrelevant),
 * empty axes dropped, empty grid -> [].
 */
export function candidateGrid(grid) {
  const keys = Object.keys(grid || {})
    .filter((k) => Array.isArray(grid[k]) && grid[k].length > 0)
    .sort();
  if (keys.length === 0) return [];
  let out = [{}];
  for (const k of keys) {
    const next = [];
    for (const base of out) {
      for (const v of grid[k]) next.push({ ...base, [k]: v });
    }
    out = next;
  }
  return out;
}

export function candidateKey(c) {
  return Object.keys(c).sort().map((k) => `${k}=${c[k]}`).join(' ');
}

export function isBaselineCandidate(c) {
  return Object.keys(c).every((k) => FloorContract.HUMP_SPRING[k] === c[k]);
}

/**
 * Evaluate ONE candidate against one or more traces: fresh ladder per trace, counts summed, latencies pooled.
 * @param {Array<{events:Array, tune?:object}>} traces per-trace tunes (trace.meta.tune) are honored independently
 * @param {object} candidate spring overrides
 * @param {object} [opts] {rules, invert, tune, crossRideMs, burstGapMs, reversalWindowMs, weights, noCrossLatencyMs}
 */
export function evaluateCandidate(traces, candidate, opts = {}) {
  const agg = { bursts: 0, crossings: 0, overshoots: 0, denied: 0, undos: 0, latencies: [] };
  for (const tr of traces) {
    const events = (tr && tr.events) || [];
    const tune = { ...WHEEL_TUNE, ...((tr && tr.tune) || {}), ...(opts.tune || {}) };
    const { decisions } = replayTrace(events, {
      spring: candidate,
      rules: opts.rules,
      invert: opts.invert,
      tune,
      crossRideMs: opts.crossRideMs,
    });
    const m = scoreReplay(events, decisions, opts);
    agg.bursts += m.bursts;
    agg.crossings += m.crossings;
    agg.overshoots += m.overshoots;
    agg.denied += m.denied;
    agg.undos += m.undos;
    for (const l of m.latencies) agg.latencies.push(l);
  }
  const metrics = {
    bursts: agg.bursts,
    crossings: agg.crossings,
    crossingsPerBurst: agg.crossings / (agg.bursts || 1),
    overshoots: agg.overshoots,
    denied: agg.denied,
    undos: agg.undos,
    latencyCount: agg.latencies.length,
    medianLatencyMs: median(agg.latencies),
  };
  return {
    candidate,
    key: candidateKey(candidate),
    metrics,
    score: scoreFromMetrics(metrics, opts.weights, opts.noCrossLatencyMs),
  };
}

/**
 * Sweep the full grid over the traces; deterministic (sorted product, results by score asc then key asc). @param
 * {object} [opts] {grid, ...evaluateCandidate opts}
 */
export function sweepGrid(traces, opts = {}) {
  const candidates = candidateGrid(opts.grid || DEFAULT_GRID);
  const results = candidates.map((c) => {
    const r = evaluateCandidate(traces, c, opts);
    return { ...r, baseline: isBaselineCandidate(c) };
  });
  results.sort((a, b) => (a.score - b.score) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return results;
}
