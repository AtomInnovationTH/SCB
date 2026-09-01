/**
 * flickSweepCore.js — PURE offline scoring core for the flick-tuning sweep
 * (docs/ladder/07-flick-tuning.md). The CLI wrapper is scripts/flick-sweep.mjs;
 * everything here is deterministic, DOM-free, Date-free, and exported for the
 * Node suite (test-FlickSweep.js).
 *
 * Pipeline:
 *   1. segmentBursts(events)      — recorded gesture events → intent bursts
 *      (silence-gap segmentation: one burst ≈ one continuous stream of hand
 *      activity — a flick plus its momentum tail, a sustained push, a
 *      free-scroll adjustment).
 *   2. replayTrace(events, opts)  — feed the trace through a FRESH ZoomLadder
 *      per candidate, converting recorded deltas with the SAME normalizeWheel
 *      math + source-class gating the WheelRouter applies live (recorded
 *      sourceClass wins — deltaX is consumed at capture time, not carried).
 *      Ride completions are simulated on the recorded clock (the core stays
 *      mode:'riding' until rideFinished; offline there is no camera to report
 *      it, so the harness schedules it at the decision's own duration).
 *   3. scoreReplay(...)           — per-burst crossing attribution → metrics.
 *   4. sweepGrid(traces, opts)    — cartesian candidate grid (spring
 *      overrides: the FLICK_* constants + CHARGE_THRESHOLD live on the
 *      ZoomLadder `spring` dep surface) → ranked candidates, deterministic
 *      order (score asc, candidate key asc).
 *
 * Metrics (lower composite score = better; see 07-flick-tuning.md for how to
 * read them — they are COMPARATIVE across candidates on the same trace, not
 * absolute quality numbers):
 *   crossingsPerBurst — floor changes per gesture burst (1.0 ideal: one
 *                       intent, one crossing; free-scroll bursts drag it
 *                       below 1 by construction — same drag for every
 *                       candidate).
 *   overshoots        — extra crossings inside one burst (multi-cross: the
 *                       grammar read one intent as several floor changes).
 *   denied            — wall bounces (dock gate / ladder end refusals).
 *   undos             — reversal crossings shortly after a cross (the player
 *                       or the grammar walking back a floor change; high
 *                       values = mistaken crossings needing forgiveness).
 *   medianLatencyMs   — burst start → first crossing in that burst
 *                       (responsiveness of the flick trigger).
 *
 * @module dev/flickSweepCore
 */

import { ZoomLadder } from '../core/ZoomLadder.js';
import { normalizeWheel, classifyWheelSource, WHEEL_TUNE } from '../systems/WheelRouter.js';
import { FloorContract } from '../core/FloorContract.js';

/** Sweep knobs (every one overridable per call; defaults documented in 07). */
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
};

/** Default candidate grid — includes the shipped baseline values
 *  (FloorContract.HUMP_SPRING: 2.0 / 160 / 800) so the incumbent always
 *  appears in the ranking. CHARGE_THRESHOLD is sweepable via the same spring
 *  surface (CLI --CHARGE_THRESHOLD=…), left off the default grid. */
export const DEFAULT_GRID = {
  FLICK_MIN_MAG: [1.4, 1.7, 2.0, 2.4, 2.8],
  FLICK_MAX_DRIVE_MS: [120, 160, 200, 240],
  FLICK_UNDO_WINDOW_MS: [500, 800, 1100],
};

// ── Burst segmentation ──────────────────────────────────────────────────────

/**
 * Split recorded gesture events into bursts on silence gaps. Input order is
 * not trusted (sorted copy; the input array is never mutated). A gap of
 * EXACTLY gapMs starts a new burst (gap >= gapMs, pinned).
 *
 * @param {Array<{tMs:number}>} events
 * @param {number} [gapMs]
 * @returns {Array<{startMs:number, endMs:number, count:number}>}
 */
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

// ── Trace event → ladder input (the router's ladder-owns-wheel math) ────────

/**
 * Convert one recorded trace event into the {tMs, dir, mag} the ladder core
 * would have received live — the WheelRouter recipe verbatim: source-class
 * feed gating (muted classes never reach the core), ctrl-pinch gain (tagged
 * synthetic pinches arrive pre-scaled: no gain), then normalizeWheel
 * (deltaMode scaling, invert, MAX_MAG cap).
 *
 * The RECORDED sourceClass wins over re-classification: 'mouse' vs 'scroll'
 * depends on deltaX, which classification consumed at capture time.
 *
 * @param {{tMs:number, kind:string, deltaY:number, deltaMode:number,
 *          ctrlKey:boolean, sourceClass?:string}} ev
 * @param {typeof WHEEL_TUNE} [tune] - the trace's recorded tune (meta.tune)
 * @param {boolean} [invert]
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

// ── Replay ──────────────────────────────────────────────────────────────────

/**
 * Replay a recorded event stream through a fresh ZoomLadder built with the
 * candidate's spring overrides, honoring recorded timestamps. Ride
 * completions are simulated: a 'cross' decision finishes crossRideMs later
 * (midpoint of the locked 450–650 ms window — arming the G3 undo window on
 * the same clock the core uses live); a 'ride' decision finishes at its own
 * miniMs (flickWall/jump) or crossRideMs when null. A later ride decision
 * REPLACES the pending completion, exactly like S2's ride swap.
 *
 * @param {Array} events - recorded trace events (chronology enforced here)
 * @param {object} [opts]
 * @param {object} [opts.spring] - candidate spring overrides (FLICK_*, CHARGE_THRESHOLD…)
 * @param {object} [opts.rules]  - ZoomLadder rules overrides (e.g. devFullAccess)
 * @param {typeof WHEEL_TUNE} [opts.tune] @param {boolean} [opts.invert]
 * @param {number} [opts.crossRideMs]
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
    const le = ladderEventFromTrace(raw, tune, opts.invert);
    if (!le) continue;                      // muted class / zero mag: the core never saw it live either
    record(t, ladder.wheel(le));
  }
  if (pendingRideEndMs != null) {
    ladder.rideFinished({ tMs: pendingRideEndMs });
  }
  return { decisions, finalState: ladder.getState() };
}

// ── Scoring ─────────────────────────────────────────────────────────────────

/** Median of a numeric array (average of the middle two when even); null on empty. */
export function median(xs) {
  if (!Array.isArray(xs) || xs.length === 0) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return (s.length % 2 === 1) ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Score one replay against the trace's observed gesture bursts.
 * Crossings/denials are attributed to the burst whose [startMs, endMs] span
 * contains their trigger event (crossings only ever fire ON wheel events, so
 * containment is exact). Undos are reversal crossings: direction opposite to
 * the previous crossing within reversalWindowMs — an OBSERVATIONAL window
 * (fixed), deliberately not the candidate's own FLICK_UNDO_WINDOW_MS.
 *
 * @param {Array} events - the recorded events the replay consumed
 * @param {Array<{tMs:number, d:object}>} decisions - replayTrace output
 * @param {object} [opts] {burstGapMs, reversalWindowMs}
 * @returns {{bursts:number, crossings:number, crossingsPerBurst:number,
 *            overshoots:number, denied:number, undos:number,
 *            latencies:number[], medianLatencyMs:?number}}
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
 * Composite score — LOWER is better. Per-burst normalization keeps traces of
 * different lengths comparable; a candidate that never crosses at all takes
 * the full |cpb−1| penalty plus the noCrossLatencyMs stand-in, so "flick
 * unreachable" candidates rank last deterministically.
 *
 * @param {object} m - metrics (scoreReplay/aggregate shape)
 * @param {object} [weights]
 * @param {number} [noCrossLatencyMs]
 * @returns {number}
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

// ── Grid sweep ──────────────────────────────────────────────────────────────

/**
 * Cartesian product of a {KEY: [values]} grid → candidate spring-override
 * objects. Keys are sorted (input key order never changes the output), empty
 * axes are dropped, an empty grid yields [].
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

/** Stable display/tiebreak key for a candidate (sorted `K=V` pairs). */
export function candidateKey(c) {
  return Object.keys(c).sort().map((k) => `${k}=${c[k]}`).join(' ');
}

/** True when every overridden value equals the shipped HUMP_SPRING baseline. */
export function isBaselineCandidate(c) {
  return Object.keys(c).every((k) => FloorContract.HUMP_SPRING[k] === c[k]);
}

/**
 * Evaluate ONE candidate against one or more traces: fresh ladder per trace,
 * counts summed, latencies pooled (median over the pool).
 *
 * @param {Array<{events:Array, tune?:object}>} traces - parsed trace files
 *   ({events, tune} — pass trace.meta.tune as tune to honor the recorded
 *   WHEEL_TUNE; per-trace tunes are honored independently)
 * @param {object} candidate - spring overrides
 * @param {object} [opts] {rules, invert, tune, crossRideMs, burstGapMs,
 *   reversalWindowMs, weights, noCrossLatencyMs}
 * @returns {{candidate:object, key:string, metrics:object, score:number}}
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
 * Sweep the full candidate grid over the traces. Deterministic: candidates
 * come from the sorted cartesian product, results sort by (score asc, key
 * asc) — the same traces + grid always print the same ranking.
 *
 * @param {Array<{events:Array, tune?:object}>} traces
 * @param {object} [opts] {grid, …evaluateCandidate opts}
 * @returns {Array<{candidate, key, metrics, score, baseline:boolean}>}
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
