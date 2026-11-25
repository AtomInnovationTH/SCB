/**
 * ReentryShow.js - page 1's falling pieces: one year of re-entries in one minute (Sky 31, owner 2026-11-24, DECISIONS §103 row 3 and §102 row 12:
 * "consider how object hit earth on reentry. how to give visual sense of how many tons burn up each year, consider objects start glowing how at lower
 * altitudes? Then streak across earth. from little shooting start to fireball").
 *
 * What it draws (canvas 2D, over the real Earth the chart frames; both views, Tonnes and Danger):
 *   1. SINK    small dots in their kind colours leave the two lowest bands (180-400 and 400-600 km) and sink inward, slowly at first and faster as they
 *              drop (the air thickens): the height follows h0 -> 120 km as 1 - p^2.2, and they circle faster as they drop.
 *   2. GLOW    at 120 km (a few px above Earth's edge on the chart's scale) a piece starts to glow orange, still moving along the edge.
 *   3. STREAK  it then crosses Earth's face on a short curve seen from above: a thin faint line first (a little shooting star), brightening and thickening;
 *              pieces of 0.5 t and over break into 2-5 sparks at the break-up point (78 km nominal, drawn at 58-70 % of the path) that fade; pieces of 1.5 t
 *              and over are fireballs (a bigger head, a wider tail), smaller ones stay shooting stars. The streak is a drawing of the sequence, not a trajectory.
 *   4. LANDING about one piece in four BY MASS survives: its spark reaches the end of the path and leaves a tiny dot that fades in 1.8 s.
 *              (Where it lands is not tied to the picture of Earth under it, so the dot says nothing about land or sea.)
 *
 * THE YEAR (every number below is measured data, then a drawn mix; sources read 2026-11-25):
 *   - 2025: 1,757.4 t came down (Jonathan McDowell, planet4589.org/space/stats/out/yremass.txt, "Payloads and rockets", by re-entry year, row 2025, tonnage);
 *     4,222.5 t went up (remass.txt, by launch year, row 2025); 1,553 objects re-entered (yrecount.txt, row 2025); rocket stages alone 314 objects and 925.4 t
 *     (yrecountr.txt, yremassr.txt). Those files measure tonnage and counts but state no unit; "tonnes" is the page's word "Tonnage".
 *   - The survivor mass: 470.3 t is the file's "Landed" column (2025 row). By the page's own label it is objects that came down intact and landed, which is mostly
 *     controlled returns (capsules and boosters), not scraps of burnt-up debris: the picture uses it for the share "about a quarter reaches the ground", as the plan asked.
 *   - Heating and glow start about 110-120 km up (ESA, "Reentry and collision avoidance"); break-up at 84-72 km, 78 km nominal (NASA ODPO, nasa.gov/odpo/reentry).
 *
 * The drawn mix of the 1,553 pieces (the three numbers are the file's; the split among the others is chosen, "believable", not measured):
 *   314 rocket stages totalling 925.4 t          (about 1.6-4.2 t each, scaled to the file's total; kind "rocket stage")
 *   1,000 satellites of 0.35-0.85 t, "working"    (Starlink-sized payloads, the many)
 *   100 big satellites of 1-3 t, "dead"
 *   139 small pieces of 0.02-0.5 t, "debris"
 *   the 1,239 non-stage pieces total 832.0 t (1,757.4 - 925.4); each group is scaled so the totals are exact.
 * One loop is LOOP_S = 60 s: each piece starts once, evenly spread (about 26 per second). A year in a minute. Only the real-time clock moves them: the
 * a paused game freezes them, every other speed leaves the loop alone.
 *
 * No allocation per frame: the pieces are typed arrays built once (seeded, so the show is the same every time), the active list is a preallocated
 * Int16Array, and the drawing uses constant colour strings with `globalAlpha` (no gradients). Constructible and testable in Node (no DOM: `frame`
 * still moves the clock and collects the active pieces; `drawn` stays false).
 *
 * @module ui/ReentryShow
 */

import { CLASS_COLORS } from './RealSkyCard.js';

/** One loop of the show, seconds: one year in a minute. */
export const LOOP_S = 60;
/** Heating and glow start here (km): ESA "Reentry and collision avoidance", 110-120 km. */
export const H_ENTRY_KM = 120;
/** Nominal break-up height (km): NASA ODPO, 84-72 km. */
export const H_BREAK_KM = 78;
/** A piece starts its sink at a height between these two (km): the two lowest bands, 180-400 and 400-600 km. */
export const SINK_FROM_KM = Object.freeze([200, 600]);
/** One frame's clock step never exceeds this (a hidden tab or a stall must not skip the show forward). */
export const MAX_DT_S = 0.1;
/** A survivor's dot stays this long, seconds. */
export const POST_S = 1.8;

/** The measured year (2025), tonnes and counts. See the header for the sources. */
export const YEAR_FACTS = Object.freeze({
  year: 2025, downT: 1757.4, upT: 4222.5, landedT: 470.3, objects: 1553, stages: 314, stagesT: 925.4,
});
/** The drawn mix (see the header). */
export const MIX = Object.freeze([
  { name: 'stage', kind: 1, n: 314, lo: 1.6, hi: 4.2, totalT: 925.4 },
  { name: 'working', kind: 3, n: 1000, lo: 0.35, hi: 0.85, totalT: null },
  { name: 'dead', kind: 2, n: 100, lo: 1, hi: 3, totalT: null },
  { name: 'debris', kind: 0, n: 139, lo: 0.02, hi: 0.5, totalT: null },
]);
/** Pieces under this mass (t) stay shooting stars (no sparks); at or over BIG_T they are fireballs. */
export const SPARK_MIN_T = 0.5;
export const BIG_T = 1.5;

/** The one quiet line of text (plain words, no comparisons), drawn by SdaChart in the free band over the page dots. */
export const YEAR_LINE = 'Each year about 1,750 tonnes fall back and mostly burn up, and about 4,200 tonnes go up. Here a year passes in a minute.';
/** Its baseline stands this far over the screen's bottom (px; the band between the ring's bottom and the dots' tap boxes, h-201..h-148), and its font size. */
export const YEAR_LINE_FROM_BOTTOM_PX = 156;
export const YEAR_LINE_FONT_PX = 13;

const TWO_PI = Math.PI * 2;
const SINK_POW = 2.2;
const OMEGA_GAIN = 3;        // the circling is 1 + 3 p^2 times faster at the end of the sink
const KIND_COLORS = Object.freeze([CLASS_COLORS[0], CLASS_COLORS[1], CLASS_COLORS[2], CLASS_COLORS[3]]);
const GLOW_COLOR = '#ff8a2a';
const GLOW_CORE = '#ffd9a8';
const FIRE_OUTER = '#ff6a10';
const FIRE_MID = '#ffa84a';
const FIRE_CORE = '#fff0d6';
const SPARK_COLOR = '#ffd08a';
const LAND_COLOR = '#ffe2b0';

/** Deterministic PRNG (mulberry32): the same show every run. */
function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates over 0..n-1. */
function shuffled(n, rnd) {
  const a = new Int32Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/**
 * The year's pieces, built once (pure, seeded). Typed arrays by piece index; `start` is the second in the loop a piece enters its sink.
 * @param {number} [seed]
 * @returns {{n:number, mass:Float64Array, kind:Uint8Array, start:Float32Array, theta0:Float32Array, omega0:Float32Array, sinkDur:Float32Array, h0:Float32Array,
 *   glowDur:Float32Array, thetaS:Float32Array, len:Float32Array, dur:Float32Array, bias:Float32Array, xb:Float32Array, f:Float32Array, life:Float32Array,
 *   nSp:Uint8Array, spAng:Float32Array, spDist:Float32Array, survive:Uint8Array, totalT:number, survivorT:number, stagesT:number}}
 */
export function buildYear(seed = 2025) {
  const rnd = mulberry32(seed);
  let n = 0;
  for (const g of MIX) n += g.n;
  const mass = new Float64Array(n);
  const kind = new Uint8Array(n);
  // masses by group, then each group scaled to its total (stages: the file's 925.4 t; the rest together: 1,757.4 - 925.4)
  let at = 0;
  const groups = [];
  for (const g of MIX) {
    groups.push({ g, from: at, to: at + g.n });
    for (let k = 0; k < g.n; k++) { mass[at] = g.lo + (g.hi - g.lo) * rnd(); kind[at] = g.kind; at++; }
  }
  const scaleTo = (from, to, total) => {
    let s = 0;
    for (let i = from; i < to; i++) s += mass[i];
    const k = total / s;
    for (let i = from; i < to; i++) mass[i] *= k;
  };
  scaleTo(groups[0].from, groups[0].to, YEAR_FACTS.stagesT);
  scaleTo(groups[1].from, n, YEAR_FACTS.downT - YEAR_FACTS.stagesT);
  const out = {
    n, mass, kind,
    start: new Float32Array(n), theta0: new Float32Array(n), omega0: new Float32Array(n), sinkDur: new Float32Array(n), h0: new Float32Array(n),
    glowDur: new Float32Array(n), thetaS: new Float32Array(n), len: new Float32Array(n), dur: new Float32Array(n), bias: new Float32Array(n),
    xb: new Float32Array(n), f: new Float32Array(n), life: new Float32Array(n), nSp: new Uint8Array(n), spAng: new Float32Array(n * 5), spDist: new Float32Array(n * 5),
    survive: new Uint8Array(n), totalT: 0, survivorT: 0, stagesT: 0,
  };
  // start times: spread evenly over the loop in a shuffled order (a steady rain, about n / LOOP_S per second)
  const order = shuffled(n, rnd);
  for (let r = 0; r < n; r++) out.start[order[r]] = ((r + rnd()) / n) * LOOP_S;
  for (let i = 0; i < n; i++) {
    const m = mass[i];
    const f = Math.sqrt(Math.min(1, Math.max(0, (m - 0.05) / 3.95)));
    out.f[i] = f;
    out.theta0[i] = rnd() * TWO_PI;
    out.omega0[i] = 0.07 + 0.03 * rnd();
    out.sinkDur[i] = 5 + 4 * rnd();
    out.h0[i] = SINK_FROM_KM[0] + (SINK_FROM_KM[1] - SINK_FROM_KM[0]) * rnd();
    out.glowDur[i] = 0.6 + 0.3 * f;
    const th1 = out.theta0[i] + out.omega0[i] * 2 * out.sinkDur[i];            // p = 1: omega0 (tau + sinkDur p^3)
    out.thetaS[i] = th1 + out.omega0[i] * (1 + OMEGA_GAIN) * out.glowDur[i];
    out.len[i] = 55 + 85 * f + 20 * rnd();
    out.dur[i] = 0.85 + 0.75 * f;
    out.bias[i] = 0.6 + 0.8 * rnd();
    out.xb[i] = 0.58 + 0.12 * rnd();
    out.nSp[i] = m >= SPARK_MIN_T ? 2 + Math.floor(rnd() * 4) : 0;
    for (let k = 0; k < 5; k++) { out.spAng[i * 5 + k] = (rnd() * 2 - 1) * 0.7; out.spDist[i * 5 + k] = 0.12 + 0.23 * rnd(); }
    out.life[i] = out.sinkDur[i] + out.glowDur[i] + out.dur[i] + POST_S;
    out.totalT += m;
    if (kind[i] === 1) out.stagesT += m;
  }
  // survivors: pieces taken in a shuffled order while the survivors' mass stays within the file's 470.3 t "Landed" (a quarter of the year's mass)
  const pick = shuffled(n, rnd);
  let acc = 0;
  for (let r = 0; r < n; r++) {
    const i = pick[r];
    if (acc + mass[i] <= YEAR_FACTS.landedT) { out.survive[i] = 1; acc += mass[i]; }
  }
  out.survivorT = acc;
  return out;
}

let _year = null;
/** @returns {ReturnType<typeof buildYear>} the shared year (built on first use) */
export function year() { return _year || (_year = buildYear()); }

const smooth = (x) => { const t = x < 0 ? 0 : x > 1 ? 1 : x; return t * t * (3 - 2 * t); };

export class ReentryShow {
  /**
   * @param {object} [deps]
   * @param {function():number} [deps.now] monotonic ms clock (tests)
   * @param {ReturnType<typeof buildYear>} [deps.year] pieces (tests)
   */
  constructor(deps = {}) {
    this._now = deps.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this._y = deps.year || year();
    /** The loop clock, seconds (0 .. LOOP_S). Moves only on the real-time clock, and not while paused. */
    this._t = 0;
    this._lastMs = null;
    this._wrap = null;
    this._canvas = null;
    this._ctx = null;
    this._visible = false;
    this._S = 0;
    this._gx = NaN; this._gy = NaN; this._gr = NaN; this._gk = NaN;
    this._act = new Int16Array(this._y.n);
    this._actTau = new Float32Array(this._y.n);
    this._nAct = 0;
    // the bezier of the streak being drawn (numbers, not an object)
    this._p0x = 0; this._p0y = 0; this._p1x = 0; this._p1y = 0; this._p2x = 0; this._p2y = 0; this._bx = 0; this._by = 0;
    /** True once a frame has been rasterized since the last show(). */
    this.drawn = false;
    /** Frames rasterized (tests, probes). */
    this.drawCount = 0;
  }

  /** @returns {number} the loop clock, seconds */
  clock() { return this._t; }

  /** @returns {number} how many pieces were active in the last frame */
  activeCount() { return this._nAct; }

  /** The wrapper element the page row slides (a full-screen box holding the small canvas); null headless. */
  element() { this._build(); return this._wrap || null; }

  /** @private Built lazily, browser only. z-index 34: with the real-sky dots (the chart is 33), under the object card (35+). */
  _build() {
    if (this._wrap || typeof document === 'undefined' || !document.body) return;
    const wrap = document.createElement('div');
    wrap.id = 'ladder-reentry-show';
    wrap.style.cssText = ['position:absolute', 'left:0', 'top:0', 'width:100%', 'height:100%', 'pointer-events:none', 'z-index:34', 'opacity:0', 'transition:opacity 0.3s', 'overflow:hidden'].join(';');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none';
    wrap.appendChild(canvas);
    document.body.appendChild(wrap);
    this._wrap = wrap;
    this._canvas = canvas;
    this._ctx = canvas.getContext ? canvas.getContext('2d') : null;
  }

  show() {
    this._build();
    this._visible = true;
    this._lastMs = null;
    this.drawn = false;
    if (this._wrap) this._wrap.style.opacity = '1';
  }

  hide() {
    this._visible = false;
    this.drawn = false;
    this._lastMs = null;
    if (this._wrap) this._wrap.style.opacity = '0';
    if (this._ctx && this._canvas) this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
  }

  dispose() {
    this._visible = false;
    if (this._wrap && this._wrap.remove) this._wrap.remove();
    this._wrap = null; this._canvas = null; this._ctx = null;
  }

  /**
   * One frame: move the loop clock by the real time since the last call (none while paused), and draw when something moved or the chart's place changed.
   * @param {{cx:number, cy:number, rEarth:number, pxPerKm:number}} geom the chart's centre, Earth's radius and the px per km of its honest LEO scale (CSS px)
   * @param {boolean} [paused] true freezes the show (a paused game)
   * @returns {boolean} true when it drew (or would have, headless)
   */
  frame(geom, paused = false) {
    const nowMs = this._now();
    let dt = this._lastMs === null ? 0 : (nowMs - this._lastMs) / 1000;
    this._lastMs = nowMs;
    if (!(dt > 0)) dt = 0; else if (dt > MAX_DT_S) dt = MAX_DT_S;
    if (paused) dt = 0;
    this._t = (this._t + dt) % LOOP_S;
    const same = geom.cx === this._gx && geom.cy === this._gy && geom.rEarth === this._gr && geom.pxPerKm === this._gk;
    if (dt === 0 && same && this.drawn) return false;
    this._gx = geom.cx; this._gy = geom.cy; this._gr = geom.rEarth; this._gk = geom.pxPerKm;
    this._collect(this._t);
    if (!this._ctx || !this._visible) return true;
    this._draw(geom);
    this.drawn = true;
    this.drawCount++;
    return true;
  }

  /** @private The pieces alive at loop second t, into the preallocated lists. */
  _collect(t) {
    const y = this._y;
    let k = 0;
    for (let i = 0; i < y.n; i++) {
      let tau = t - y.start[i];
      if (tau < 0) tau += LOOP_S;
      if (tau >= y.life[i]) continue;
      this._act[k] = i;
      this._actTau[k] = tau;
      k++;
    }
    this._nAct = k;
  }

  /** @private The canvas is a square about Earth, as big as the sink reaches plus a margin; moved and resized only when the chart's place changes. */
  _place(geom) {
    const S = 2 * Math.ceil(geom.rEarth + SINK_FROM_KM[1] * geom.pxPerKm + 24);
    if (this._S !== S) { this._S = S; this._canvas.width = S; this._canvas.height = S; }
    // the style strings are built only when the place moves (no allocation per frame; Sky 31 review)
    const lx = Math.round(geom.cx - S / 2), ty = Math.round(geom.cy - S / 2);
    if (this._lx !== lx) { this._lx = lx; this._canvas.style.left = `${lx}px`; }
    if (this._ty !== ty) { this._ty = ty; this._canvas.style.top = `${ty}px`; }
  }

  /** @private Evaluate the streak's bezier at u into (_bx, _by). */
  _bez(u) {
    const a = (1 - u) * (1 - u), b = 2 * (1 - u) * u, c = u * u;
    this._bx = a * this._p0x + b * this._p1x + c * this._p2x;
    this._by = a * this._p0y + b * this._p1y + c * this._p2y;
  }

  /** @private Set the streak's bezier for piece i (centre-relative px): from the 120 km edge, along the tangent, curving inward across the face. */
  _setPath(i, r1) {
    const y = this._y;
    const th = y.thetaS[i], L = y.len[i], bias = y.bias[i];
    const ct = Math.cos(th), st = Math.sin(th);
    this._p0x = r1 * ct; this._p0y = r1 * st;
    this._p1x = this._p0x - st * 0.45 * L - ct * 0.22 * L * bias; this._p1y = this._p0y + ct * 0.45 * L - st * 0.22 * L * bias;
    this._p2x = this._p0x - st * 0.62 * L - ct * 0.80 * L; this._p2y = this._p0y + ct * 0.62 * L - st * 0.80 * L;
  }

  /** @private The centre-relative position of piece i in its sink at local time tau, into (_bx, _by). @returns {number} its height, km */
  _sinkPos(i, tau, geom) {
    const y = this._y;
    const p = tau / y.sinkDur[i];
    const h = H_ENTRY_KM + (y.h0[i] - H_ENTRY_KM) * (1 - Math.pow(p, SINK_POW));
    const r = geom.rEarth + h * geom.pxPerKm;
    const th = y.theta0[i] + y.omega0[i] * (tau + y.sinkDur[i] * p * p * p);
    this._bx = r * Math.cos(th); this._by = r * Math.sin(th);
    return h;
  }

  /** @private Stroke the streak's path from u0 to u1 (5 segments) with the current style. */
  _line(g, u0, u1) {
    g.beginPath();
    for (let s = 0; s <= 5; s++) {
      this._bez(u0 + (u1 - u0) * (s / 5));
      if (s === 0) g.moveTo(this._bx, this._by); else g.lineTo(this._bx, this._by);
    }
    g.stroke();
  }

  _dot(g, x, y, r) {
    g.beginPath();
    g.arc(x, y, r, 0, TWO_PI);
    g.fill();
  }

  /** @private Rasterize the active pieces. */
  _draw(geom) {
    const g = this._ctx, y = this._y;
    this._place(geom);
    const half = this._S / 2;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this._S, this._S);
    g.translate(half, half);
    const r1 = geom.rEarth + H_ENTRY_KM * geom.pxPerKm;
    const nAct = this._nAct, act = this._act, taus = this._actTau;
    // 1. the sinking dots, one pass per kind colour
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 0.9;
    for (let k = 0; k < 4; k++) {
      g.fillStyle = KIND_COLORS[k];
      for (let a = 0; a < nAct; a++) {
        const i = act[a];
        if (y.kind[i] !== k || taus[a] >= y.sinkDur[i]) continue;
        this._sinkPos(i, taus[a], geom);
        const s = 0.8 + 0.8 * y.f[i];
        g.fillRect(this._bx - s, this._by - s, 2 * s, 2 * s);
      }
    }
    // 2-4. glow, streak, sparks, landing: light adds up
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (let a = 0; a < nAct; a++) {
      const i = act[a];
      let tau = taus[a] - y.sinkDur[i];
      if (tau < 0) continue;
      if (tau < y.glowDur[i]) { this._drawGlow(g, i, tau, r1); continue; }
      tau -= y.glowDur[i];
      if (tau < y.dur[i]) { this._setPath(i, r1); this._drawStreak(g, i, tau / y.dur[i]); continue; }
      tau -= y.dur[i];
      if (y.survive[i]) { this._setPath(i, r1); this._bez(1); g.globalAlpha = 0.9 * (1 - tau / POST_S); g.fillStyle = LAND_COLOR; this._dot(g, this._bx, this._by, 1.5); }
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
  }

  /** @private A piece at the edge at 120 km, warming up: orange, growing. */
  _drawGlow(g, i, tau, r1) {
    const y = this._y;
    const fr = tau / y.glowDur[i];
    const th = y.theta0[i] + y.omega0[i] * 2 * y.sinkDur[i] + y.omega0[i] * (1 + OMEGA_GAIN) * tau;
    const x = r1 * Math.cos(th), yy = r1 * Math.sin(th);
    const r = 1 + 1.8 * fr;
    g.globalAlpha = 0.2 + 0.25 * fr; g.fillStyle = GLOW_COLOR; this._dot(g, x, yy, r * 2.4);
    g.globalAlpha = 0.45 + 0.5 * fr; this._dot(g, x, yy, r);
    g.globalAlpha = 0.5 * fr; g.fillStyle = GLOW_CORE; this._dot(g, x, yy, r * 0.5);
  }

  /** @private The streak at progress x (0..1) along the path set by `_setPath`. */
  _drawStreak(g, i, x) {
    const y = this._y;
    const f = y.f[i], xb = y.xb[i];
    const u = 1 - Math.pow(1 - x, 1.35);
    const bright = smooth((x - 0.3) / (xb - 0.3));
    // intensity: faint thin line, then bright, then fading after the break-up
    let I;
    if (x < 0.3) I = 0.3 + 0.35 * (x / 0.3);
    else if (x <= xb) I = 0.65 + 0.35 * ((x - 0.3) / (xb - 0.3));
    else I = 1 - (x - xb) / (1 - xb);
    const wMax = 0.9 + 2.0 * f;
    const w = 0.8 + (wMax - 0.8) * bright;
    let tailF = (0.28 + 0.2 * f) * Math.min(1, x / 0.3);
    if (x > xb) tailF *= 1 - 0.85 * ((x - xb) / (1 - xb));
    const u0 = Math.max(0, u - tailF);
    if (I > 0.01) {
      g.strokeStyle = FIRE_OUTER; g.lineWidth = w * 3.2; g.globalAlpha = 0.10 * I * (0.4 + 0.6 * bright); this._line(g, u0, u);
      g.strokeStyle = FIRE_MID; g.lineWidth = w * 1.8; g.globalAlpha = 0.28 * I; this._line(g, u0, u);
      g.strokeStyle = FIRE_CORE; g.lineWidth = Math.max(0.7, w * 0.8); g.globalAlpha = 0.5 * I; this._line(g, u0, u);
      g.globalAlpha = 0.5 * I; this._line(g, (u0 + u) / 2, u);
      // the head
      this._bez(u);
      const rh = 0.7 + 2.5 * f * bright;
      g.fillStyle = GLOW_COLOR; g.globalAlpha = 0.25 * I * (0.3 + 0.7 * bright); this._dot(g, this._bx, this._by, rh * 2.2);
      g.fillStyle = FIRE_CORE; g.globalAlpha = 0.95 * I; this._dot(g, this._bx, this._by, rh);
    }
    // the break-up: 2-5 sparks that fade; a survivor's first spark follows the path to its end
    const nSp = y.nSp[i];
    if (nSp > 0 && x > xb) {
      const xp = (x - xb) / (1 - xb);
      const ub = 1 - Math.pow(1 - xb, 1.35);
      this._bez(ub);
      const bx = this._bx, by = this._by;
      const e = 0.02;
      const ua = Math.min(1, ub + e);
      this._bez(ua);
      const phi = Math.atan2(this._by - by, this._bx - bx);
      g.fillStyle = SPARK_COLOR;
      const sr = 0.9 + 0.5 * f;
      const L = y.len[i];
      for (let k = 0; k < nSp; k++) {
        if (k === 0 && y.survive[i]) {
          this._bez(ub + (1 - ub) * Math.pow(xp, 0.8));
          g.globalAlpha = 0.95;
          this._dot(g, this._bx, this._by, sr + 0.2);
        } else {
          const ang = phi + y.spAng[i * 5 + k], d = y.spDist[i * 5 + k] * L * Math.pow(xp, 0.7);
          g.globalAlpha = 0.9 * (1 - xp);
          this._dot(g, bx + Math.cos(ang) * d, by + Math.sin(ang) * d, sr);
        }
      }
    }
  }
}
