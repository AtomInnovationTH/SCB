/**
 * VitalsPane.js — the one MOTHER pane: title, heat, battery, nitrogen and the
 * engine fuel, always on screen at the top of the left column (DECISIONS §15
 * rows 5 + 8, owner 2026-10-08: "standard stuff like a health bar, with modern
 * cockpit HUD style"; heat "a lot like MechWarrior 2"; "the temp gauge should
 * be obvious top left"). h1-mother-pane (owner 2026-10-14: "integrate mother
 * pane and pane for heat/battery/gas/ion. Label the gas"): this box now ALSO
 * carries the MOTHER section (nets row + hover detail, built by StatusPanel
 * and mounted here through `mountSection`), as wide as comms (480 px,
 * `--hud-side-w`; both narrow together on smaller screens — §23 row 1).
 *
 * Rows, top to bottom (an Airbus-style readout: green normal, amber caution,
 * red warning, white labels, flat strokes, a dark halo and no glow; the DOM
 * font rides `.hud-panel`'s `var(--font-mono)`, B612 Mono). h4-simple-first
 * (owner 2026-10-15, DECISIONS §23 row 1, "4 rows"): MOTHER is four rows —
 * HEAT, BATTERY, PROPULSION and the nets row StatusPanel mounts under them.
 *
 *   TITLE    `MOTHER` and, on the right, the memo chip slot (`.vp-title-slot`;
 *            StatusPanel moves `#autopilot-indicator` in).
 *   HEAT     0-100 C bar, tick marks at 60 and 85 C; green < 60, amber 60-85,
 *            red >= 85 (DECISIONS §2 row 5). Text `47C ▲` (the arrow is the
 *            trend); a small RADIATOR AUTO tag while the ship opened the
 *            radiator itself. Source: `ResourceSystem.getThermalSnapshot()`.
 *   BATTERY  ONE row: fill = level; number = `312/600 Wh`; the trend arrow ▲/▼
 *            and the time left (`empty in 5 min` / `full in 2 min`; real minutes
 *            on the battery clock, `W_PER_UNIT_S`) on the same row. Both come from the MEDIAN of the last 30 one-second
 *            means of the net power (`NetPowerMedian`), so a scan burst (measured
 *            2026-10-15: ~10.5-12 kW for ~7 s, ~86 Wh) never reads "empty in
 *            1 min"; both stay blank until 30 such means exist (the first 30 s). amber < 25 %, red < 10 %; the
 *            COST FLASH: when the level drops by >= 1 % of the capacity inside
 *            0.5 s, the dropped chunk lights up at the end of the fill and
 *            fades over 0.8 s. The in / out watts line is not drawn here: it
 *            lives in the MOTHER hover detail (`flowText()` feeds it).
 *            Source: `getPowerSnapshot()`, falling back to the plain
 *            `player.resources` copy.
 *   PROPULSION one row, two halves: `N₂ ▮▮▮▯ 3.6 kg │ ARGON ▮▮▮▯ 1468 m/s`.
 *            The nitrogen half = the cold-gas tank (kg from the mass budget's
 *            `coldGasCurrent`); amber < 25 %, red < 10 %; the same cost flash
 *            for any spend of >= 0.25 % of the tank. The engine half = the
 *            loaded fuel's own name in capitals (`getCurrentFuel().name`),
 *            the tank bar (mass budget `xenonCurrent / xenonMax`) and the
 *            ship's ΔV in m/s (`getMassBudget().deltaV`; `—` before the
 *            budget is ready); amber < 15 %, red only when empty. No physics
 *            constant is read here: every kg and m/s comes from the budget.
 *   PLUME    `#plume-block-row` — the red WARN PLUME BLOCK line under the
 *            propulsion row (hidden unless StatusPanel lights it): never hover-only.
 *
 * Contract with the ResourceSystem (both OPTIONAL — every method is probed
 * with `?.` and a missing one falls back, never throws):
 *   getPowerSnapshot()   -> { battery, batteryMax, inW, outW, netW, genW }
 *   getThermalSnapshot() -> { tempC, band, trend: -1|0|1, autoOpened } | null
 *   getCurrentFuel()     -> { name, ... }
 * No thermal snapshot -> HEAT reads `—` in grey, bar empty. The band is
 * derived from `tempC` here (not read from the snapshot) so the fill colour,
 * the two tick marks and the displayed number can never disagree; the number
 * is truncated, not rounded, so `60` is amber and `59` is green.
 *
 * Colours (h1-mother-pane D6): every colour is written as
 * `var(--hud-<role>, <today's hex>)` so a later look only has to define the
 * variables; undefined -> today's look exactly. Nothing here defines them.
 *
 * Rate limit + cost: `update(player)` self-throttles to MIN_INTERVAL_MS (10 Hz)
 * on top of the HUD's own 10 Hz resource tick; every DOM write is
 * write-on-change; the flash history is two preallocated typed arrays; the
 * flash fade is a CSS animation (two alternating keyframe names restart it
 * with no forced layout). Nothing runs per frame.
 *
 * Home: the FIRST child of `#hud-left-column`. FloorMask hides it by attribute
 * (`vitals` pane: shown on F1-F4, gone on F5); it is not a density rung, so
 * the MORE ladder never touches it. Display only (`pointer-events: none`)
 * unless the MOTHER section is visible (index.html turns it on, so a hover
 * anywhere on the merged pane opens the detail).
 *
 * @module ui/hud/VitalsPane
 */

import { VisualLaw } from '../../core/VisualLaw.js';
import { Constants } from '../../core/Constants.js';

/** The root element id (FloorMask MASK_PANES.vitals.els = ['#hud-vitals']). */
export const VITALS_ID = 'hud-vitals';

/** The injected stylesheet's id (one <style> per document). */
export const VITALS_STYLE_ID = 'vitals-pane-style';

/** The rows of this box, top to bottom (the nets row is the fourth MOTHER row; StatusPanel mounts it). */
export const VITALS_ROWS = Object.freeze(['heat', 'battery', 'propulsion']);

/** The two halves of the PROPULSION row: nitrogen, then the engine gas. */
export const VITALS_HALVES = Object.freeze(['gas', 'ion']);

/** Row / half labels. The engine half's label follows the loaded fuel's name. */
export const VITALS_LABELS = Object.freeze({
  heat: 'HEAT', battery: 'BATTERY', propulsion: 'PROPULSION', gas: 'N\u2082',
  // q3 D4: until the loaded fuel is known the engine half carries the DEFAULT fuel's name (argon), not 'XENON'.
  ion: String((Constants.FUELS && Constants.FUELS[Constants.DEFAULT_FUEL] && Constants.FUELS[Constants.DEFAULT_FUEL].name) || 'Argon').toUpperCase(),
});

/**
 * VITALS_GEOMETRY — the pane's numbers (CSS px). The pane is 480 wide (=
 * the comms pane, h1b; index.html's `--hud-side-w` narrows both together, down
 * to 300) with 18 px rows and a 16 px title row: 2 border + 2 x 5 padding + 16
 * title + 3 x 18 rows + 3 x 3 gaps = 91 px. The label column holds
 * "PROPULSION"; the BATTERY value column holds "312/600 Wh". `FLOW_PX` is the
 * retired power line's height (kept for the pins that import it).
 */
export const VITALS_GEOMETRY = Object.freeze({
  WIDTH_PX: 480,
  ROW_PX: 18,
  GAP_PX: 3,
  PAD_Y_PX: 5,
  PAD_X_PX: 7,
  LABEL_PX: 64,
  VALUE_PX: 78,
  TRACK_PX: 8,
  FLOW_PX: 11,
  TITLE_PX: 16,
});

/**
 * q3-mother-pane D3: MOTHER's collapsed height, the ONE number the comms pane's default ('line') step reads, so the
 * two panes end at the same height. = 2 border + 2 x PAD_Y + TITLE + 3 meter rows + 3 gaps (the net line rides the
 * title row; the empty MOTHER section's flex gap is cancelled by a -GAP_PX margin in index.html). A browser test
 * (tmp/q3 notes in the plan log) measured the rendered pane at this height.
 */
export const VITALS_COLLAPSED_HEIGHT_PX = 2 + 2 * VITALS_GEOMETRY.PAD_Y_PX + VITALS_GEOMETRY.TITLE_PX
  + VITALS_ROWS.length * VITALS_GEOMETRY.ROW_PX + VITALS_ROWS.length * VITALS_GEOMETRY.GAP_PX;

/**
 * VITALS_LAW — the thresholds (DECISIONS §2 row 5 + §15 row 5), the update
 * rate and the cost-flash numbers. Fractions are of the tank / capacity.
 */
export const VITALS_LAW = Object.freeze({
  HEAT_SCALE_C: 100,        // the HEAT bar's full scale
  // The bands are the ship's (w2-heat's Constants.SHIP_HEAT); 60 / 85 is the
  // DECISIONS §2 row 5 ruling, used until that block exists.
  HEAT_YELLOW_C: Constants.SHIP_HEAT?.YELLOW_C ?? 60,   // amber from here (economic pain starts)
  HEAT_RED_C: Constants.SHIP_HEAT?.RED_C ?? 85,         // red from here (tools refuse)
  BATT_AMBER: 0.25,
  BATT_RED: 0.10,
  GAS_AMBER: 0.25,
  GAS_RED: 0.10,
  ION_AMBER: 0.15,
  RATE_HIDE_W: 20,          // |net| under this -> no trend arrow, no time left
  MEDIAN_SAMPLES: 30,       // the trend / time-left use the median of this many one-second means
  MEDIAN_BUCKET_MS: 1000,   // each sample = the mean net power over one second
  MIN_INTERVAL_MS: 100,     // at most 10 updates per second
  FLASH_WINDOW_MS: 500,     // a drop inside this window is one action
  FLASH_FADE_MS: 800,
  FLASH_BATT_FRAC: 0.01,    // >= 1 % of capacity
  // The gas flash in TANK terms (h1-mother-pane D5: 0.05 kg of the 20 kg pool = 0.25 %).
  FLASH_GAS_FRAC: 0.0025,
  // While a flash still fades, a further drain at least this fast extends it
  // (low end follows the level, fade restarts): a scan's slow analysis draw
  // (w2-heat: quick 2 % at once + 4 % over 3.5 s = 1.1 %/s) shows as ONE 6 %
  // chunk. The base load (~0.1 %/s) never extends a flash.
  FLASH_EXTEND_BATT_FRAC_PER_S: 0.005,
  FLASH_EXTEND_GAS_FRAC_PER_S: 0.005,   // 0.1 kg/s of the 20 kg pool
});

/** The shipped red tier (StatusPanel low / empty) — the colour law's static warning red. */
const WARNING_RED = '#ff4444';
/** Neutral grey for "no reading". */
const NO_READING_GREY = '#8a9099';

const DOT_UP = '\u25b2';      // ▲ (Geometric Shapes)
const DOT_DOWN = '\u25bc';    // ▼
const MINUS = '\u2212';       // − (Math Operators)
const DASH = '\u2014';        // —
const DEG = '\u00b0';         // °

/**
 * The heat band for a temperature: green < 60, yellow 60 to < 85, red >= 85.
 * Non-finite -> 'none'.
 * @param {number} tempC
 * @returns {'green'|'yellow'|'red'|'none'}
 */
export function heatBand(tempC) {
  if (!Number.isFinite(tempC)) return 'none';
  if (tempC >= VITALS_LAW.HEAT_RED_C) return 'red';
  if (tempC >= VITALS_LAW.HEAT_YELLOW_C) return 'yellow';
  return 'green';
}

/**
 * A fuel / battery band: red below `redBelow`, yellow below `yellowBelow`
 * (fractions of full), else green. `redBelow` null = no red step.
 * @param {number} frac
 * @param {number} yellowBelow
 * @param {number|null} redBelow
 * @returns {'green'|'yellow'|'red'|'none'}
 */
export function levelBand(frac, yellowBelow, redBelow) {
  if (!Number.isFinite(frac)) return 'none';
  if (redBelow != null && frac < redBelow) return 'red';
  if (frac < yellowBelow) return 'yellow';
  return 'green';
}

const NO_RATE = Object.freeze({ text: '', dir: '' });

/**
 * The net-rate text: `▲ +1.2 kW` / `▼ −3.4 kW` / `▲ +450 W`; '' when the
 * rate is missing or under RATE_HIDE_W. `dir` is 'up' / 'down' / ''.
 * @param {number|null|undefined} netW
 * @returns {{text:string, dir:''|'up'|'down'}}
 */
export function fmtRate(netW) {
  if (netW == null || !Number.isFinite(netW)) return NO_RATE;
  const abs = Math.abs(netW);
  if (abs < VITALS_LAW.RATE_HIDE_W) return NO_RATE;
  const up = netW > 0;
  const body = abs < 999.5 ? `${Math.round(abs)} W` : `${(abs / 1000).toFixed(1)} kW`;
  return { text: `${up ? DOT_UP : DOT_DOWN} ${up ? '+' : MINUS}${body}`, dir: up ? 'up' : 'down' };
}

const TREND_UP = Object.freeze({ text: DOT_UP, dir: 'up' });
const TREND_DOWN = Object.freeze({ text: DOT_DOWN, dir: 'down' });
/**
 * The BATTERY trend arrow: `▲` charging / `▼` draining, '' under RATE_HIDE_W or when missing.
 * @param {number|null|undefined} netW
 * @returns {{text:string, dir:''|'up'|'down'}}
 */
export function fmtTrend(netW) {
  if (netW == null || !Number.isFinite(netW) || Math.abs(netW) < VITALS_LAW.RATE_HIDE_W) return NO_RATE;
  return netW > 0 ? TREND_UP : TREND_DOWN;
}

/**
 * NetPowerMedian — the median of the last `size` one-second means of the net
 * battery power (h4-simple-first D4). `push(t, w)` folds a sample into the
 * current one-second bucket; when a bucket closes its mean joins the ring.
 * `value()` is the median of the closed buckets (fewer than `size` -> the
 * median of what exists); before the first bucket closes it is the open
 * bucket's mean, and NaN with no sample at all. A one-second burst is one
 * sample of 30, so it can never move the median of a steady history.
 * Two preallocated typed arrays: no allocation per sample.
 */
export class NetPowerMedian {
  /**
   * @param {number} [size]      ring size (default VITALS_LAW.MEDIAN_SAMPLES)
   * @param {number} [bucketMs]  bucket length (default VITALS_LAW.MEDIAN_BUCKET_MS)
   */
  constructor(size = VITALS_LAW.MEDIAN_SAMPLES, bucketMs = VITALS_LAW.MEDIAN_BUCKET_MS) {
    this._ring = new Float64Array(size);
    this._scratch = new Float64Array(size);
    this._bucketMs = bucketMs;
    this._n = 0;
    this._head = 0;
    this._start = NaN;
    this._sum = 0;
    this._count = 0;
  }

  /** Forget everything. */
  reset() {
    this._n = 0; this._head = 0; this._start = NaN; this._sum = 0; this._count = 0;
  }

  /**
   * @param {number} t  ms clock
   * @param {number} w  net power now (W, + charging)
   */
  push(t, w) {
    if (!Number.isFinite(t) || !Number.isFinite(w)) return;
    if (!Number.isFinite(this._start)) this._start = t;
    if (t - this._start >= this._bucketMs && this._count > 0) {
      this._ring[this._head] = this._sum / this._count;
      this._head = (this._head + 1) % this._ring.length;
      if (this._n < this._ring.length) this._n++;
      this._start = t;
      this._sum = 0;
      this._count = 0;
    }
    this._sum += w;
    this._count++;
  }

  /** @returns {number} how many one-second means are closed (0..size). */
  count() { return this._n; }

  /** @returns {number} the median net power in W, NaN with no sample. */
  value() {
    const n = this._n;
    if (n === 0) return this._count > 0 ? this._sum / this._count : NaN;
    const a = this._scratch;
    for (let i = 0; i < n; i++) {   // insertion sort of the n closed means
      const v = this._ring[i];
      let j = i - 1;
      while (j >= 0 && a[j] > v) { a[j + 1] = a[j]; j--; }
      a[j + 1] = v;
    }
    return (n & 1) ? a[(n - 1) >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2;
  }
}

/**
 * w4-power D4: the BATTERY power line — `in 1725 W · out 500 W`, whole watts,
 * both always shown (a negative or non-finite reading reads 0).
 * @param {number} inW
 * @param {number} outW
 * @returns {string}
 */
export function fmtFlow(inW, outW) {
  const w = (v) => `${Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0} W`;
  return `in ${w(inW)} · out ${w(outW)}`;
}
/** `18.2 kg`; 100 kg and over read without a decimal so the value column never overflows. */
export function fmtKg(kg) {
  if (!Number.isFinite(kg)) return DASH;
  const v = Math.max(0, kg);
  return `${v >= 99.95 ? String(Math.round(v)) : v.toFixed(1)} kg`;
}

/** `600 Wh` (integer); 10 kWh and over read in kWh. */
export function fmtCapacity(wh) {
  if (!Number.isFinite(wh) || wh <= 0) return DASH;
  return wh >= 10000 ? `${(wh / 1000).toFixed(1)} kWh` : `${Math.round(wh)} Wh`;
}

/** `312/600 Wh` — level / capacity in whole Wh; 10 kWh and over read in kWh (`3.1/10.0 kWh`). */
export function fmtBattery(level, max) {
  if (!Number.isFinite(level) || !Number.isFinite(max) || max <= 0) return DASH;
  const lv = Math.max(0, Math.min(level, max));
  return max >= 10000
    ? `${(lv / 1000).toFixed(1)}/${(max / 1000).toFixed(1)} kWh`
    : `${Math.round(lv)}/${Math.round(max)} Wh`;
}

/** `19 min` / `1 h 40 min` (60 min and over). */
export function fmtMinutes(min) {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** The longest time-left the battery line will state (beyond it the line stays quiet). */
const TIME_LEFT_MAX_MIN = 24 * 60;

/**
 * The battery time-left text: draining -> `empty in 5 min` (level / |net|),
 * charging -> `full in 2 min` ((max - level) / net). The minutes are REAL
 * minutes on the battery clock: seconds = Wh x W_PER_UNIT_S / |W|
 * (312 Wh at -984 W -> 317 s -> `5 min`). Under one minute it reads
 * `empty in under 1 min` / `full in under 1 min`. '' when the net is under
 * RATE_HIDE_W, when the answer is over 24 h, or when the battery is already
 * empty / full.
 * @param {number} level  Wh
 * @param {number} max    Wh
 * @param {number} netW   + charging, - draining
 * @returns {string}
 */
export function fmtTimeLeft(level, max, netW) {
  if (!Number.isFinite(level) || !Number.isFinite(max) || !(max > 0) || !Number.isFinite(netW)) return '';
  const abs = Math.abs(netW);
  if (abs < VITALS_LAW.RATE_HIDE_W) return '';
  const toGo = netW < 0 ? level : max - level;
  if (!(toGo > 0)) return '';
  // The battery runs on its own clock (ResourceSystem.billWatts): 1 Wh unit = W_PER_UNIT_S watt-seconds.
  const seconds = (toGo * Constants.SHIP_HEAT.W_PER_UNIT_S) / abs;
  const min = seconds / 60;
  if (min > TIME_LEFT_MAX_MIN) return '';
  const word = netW < 0 ? 'empty' : 'full';
  return min < 1 ? `${word} in under 1 min` : `${word} in ${fmtMinutes(min)}`;
}

/** `1234 m/s` — the ship's ΔV, whole m/s ('—' when not a number). */
export function fmtDeltaV(dv) {
  return Number.isFinite(dv) ? `${Math.max(0, Math.round(dv))} m/s` : DASH;
}

/** `47°C ▲` / `−24°C` — degrees truncated toward zero (U+2212 minus) plus the trend arrow (none when steady). */
export function fmtHeat(tempC, trend) {
  if (!Number.isFinite(tempC)) return DASH;
  const arrow = trend > 0 ? ` ${DOT_UP}` : (trend < 0 ? ` ${DOT_DOWN}` : '');
  const d = Math.trunc(tempC);
  return `${d < 0 ? MINUS : ''}${Math.abs(d)}${DEG}C${arrow}`;
}

/**
 * CostFlash — the "what did that action cost" detector. Two preallocated
 * typed arrays hold the last few samples; a sample that sits `threshold` or
 * more below the highest sample inside `windowMs` is ONE drop. When it fires
 * the history restarts from the new sample (so a single spend flashes once,
 * not once per sample it stays inside the window) and `lo` / `hi` hold the
 * dropped chunk in the pool's own units.
 */
export class CostFlash {
  /** @param {number} [size] ring size — >= windowMs / MIN_INTERVAL_MS + 1 */
  constructor(size = 8) {
    this._t = new Float64Array(size);
    this._v = new Float64Array(size);
    this._n = 0;
    this._head = 0;
    this.lo = 0;
    this.hi = 0;
  }

  /**
   * @param {number} t          sample time (ms)
   * @param {number} v          the level (pool units)
   * @param {number} threshold  the smallest drop that counts (same units)
   * @param {number} windowMs
   * @returns {boolean} true when this sample completed a drop (lo / hi set)
   */
  sample(t, v, threshold, windowMs) {
    let hi = v;
    for (let i = 0; i < this._n; i++) {
      if (t - this._t[i] <= windowMs && this._v[i] > hi) hi = this._v[i];
    }
    const size = this._t.length;
    if (hi - v >= threshold - 1e-9) {
      this.lo = v;
      this.hi = hi;
      this._t[0] = t;
      this._v[0] = v;
      this._n = 1;
      this._head = 1 % size;
      return true;
    }
    this._t[this._head] = t;
    this._v[this._head] = v;
    this._head = (this._head + 1) % size;
    if (this._n < size) this._n++;
    return false;
  }
}

function defaultNow() {
  return (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now() : Date.now();
}

function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

/** A fill width as a write-stable string: 0.1 % steps. */
function pctStr(frac) { return `${(Math.round(clamp01(frac) * 1000) / 10)}%`; }

export class VitalsPane {
  /**
   * @param {object} [deps]
   * @param {Document|null} [deps.doc]    default: the global document (null = headless: nothing is built).
   * @param {Element|null}  [deps.parent] the left column — the pane becomes its FIRST child. Absent = built detached.
   * @param {function}      [deps.now]    ms clock (default performance.now); tests inject.
   * @param {function}      [deps.getMassBudget] lazy provider -> the mass budget (`deltaV`, `xenonCurrent`, `xenonMax`, `coldGasCurrent`) | null (ArmManager.getMassBudget);
   *                        read on every update — the arm manager arrives after the HUD is built.
   * @param {number}        [deps.medianWarmup] one-second means needed before the arrow / time left show
   *                        (default VITALS_LAW.MEDIAN_SAMPLES = 30; format tests pass 0).
   */
  constructor(deps = {}) {
    this._doc = deps.doc !== undefined ? deps.doc
      : (typeof document !== 'undefined' ? document : null);
    this._now = typeof deps.now === 'function' ? deps.now : defaultNow;
    /** @type {null|(() => (object|null))} */
    this._getMassBudget = typeof deps.getMassBudget === 'function' ? deps.getMassBudget : null;
    this._root = null;
    this._titleSlot = null;      // the memo chip's home (right of MOTHER)
    this._plumeEl = null;        // #plume-block-row
    this._timeEl = null;         // the battery time-left text
    this._timeText = '';
    this._fuelLabel = VITALS_LABELS.ion;
    this._median = new NetPowerMedian();   // D4: the trend / time-left use the median net power
    // D4: the arrow and the time left wait until this many one-second means exist (a full window by
    // default) — a first scan 12 s into the game must not be the median of a 12-sample history.
    this._warmup = Number.isFinite(deps.medianWarmup) ? Math.max(0, deps.medianWarmup) : VITALS_LAW.MEDIAN_SAMPLES;
    this._row = {};              // key -> { el, fill, flash, value, rate, tag, st }; 'gas' / 'ion' are the PROPULSION halves
    /** the in / out watts text (`in … W · out … W`): not drawn here, StatusPanel's hover detail shows it */
    this._flowText = '';
    this._lastMs = null;
    this._detect = { battery: new CostFlash(), gas: new CostFlash() };
    this._prev = { battery: { t: NaN, v: NaN }, gas: { t: NaN, v: NaN } };
    /** @type {Object<string, {count:number, lo:number, hi:number, until:number}>} the flash state per row (tests read it) */
    this._flash = {
      battery: { count: 0, lo: 0, hi: 0, until: -Infinity, phase: 0 },
      gas: { count: 0, lo: 0, hi: 0, until: -Infinity, phase: 0 },
    };
    this._build(deps.parent || null);
  }

  /**
   * h4b D5: a new game forgets the last game's power samples; the warm-up (30 one-second means)
   * starts again, so the arrow and the time left stay blank until a full window exists.
   */
  resetMedian() { this._median.reset(); this._writeTime(''); }

  /** The root element, or null headless. */
  get root() { return this._root; }

  /** The title row's right-hand slot (the memo chip's home), or null headless. */
  get titleSlot() { return this._titleSlot; }

  /**
   * Mount the MOTHER section (StatusPanel's `#hud-mother-panel`) as the last
   * child of the root, under the meter rows. No-op headless.
   * @param {Element} el
   * @returns {boolean} true when mounted
   */
  mountSection(el) {
    if (!this._root || !el || typeof this._root.appendChild !== 'function') return false;
    this._root.appendChild(el);
    return true;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Refresh the four rows from the player (HUD calls it inside its 10 Hz
   * resource block). Self-throttled to MIN_INTERVAL_MS; every write is
   * write-on-change; never throws on a half-wired player.
   * @param {object} player  needs `.resources` and (optionally) `._resourceSystem`
   * @param {number} [nowMs] ms clock override (tests); default `deps.now()`
   * @returns {boolean} true when this call sampled (false = throttled / headless)
   */
  update(player, nowMs) {
    if (!this._root) return false;
    let t = Number(nowMs);
    if (!Number.isFinite(t)) t = Number(this._now());
    if (!Number.isFinite(t)) return false;
    if (this._lastMs !== null && t - this._lastMs < VITALS_LAW.MIN_INTERVAL_MS) return false;
    this._lastMs = t;

    const res = player && player.resources ? player.resources : null;
    const rs = player ? player._resourceSystem : null;
    const thermal = VitalsPane._snap(rs, 'getThermalSnapshot');
    const power = VitalsPane._snap(rs, 'getPowerSnapshot');

    let mb = null;
    if (this._getMassBudget) {
      try { mb = this._getMassBudget(); } catch (_e) { mb = null; }
      if (!mb || typeof mb !== 'object') mb = null;
    }

    this._paintHeat(thermal);
    this._paintBattery(res, power, t);
    this._paintGas(res, mb, t);
    this._paintIon(res, rs, mb);
    return true;
  }

  /** The row's visible text as one string, e.g. `HEAT 47°C ▲`, `BATTERY 600 Wh ▼ −3.4 kW`. */
  rowText(key) {
    const r = this._row[key];
    if (!r) return '';
    if (key === 'propulsion') return `${VITALS_LABELS.propulsion} ${this.rowText('gas')} ${this.rowText('ion')}`;
    const parts = [key === 'ion' ? this._fuelLabel : VITALS_LABELS[key], r.st.value];
    if (r.st.rate) parts.push(r.st.rate);
    if (r.st.tag) parts.push(r.st.tag);
    return parts.join(' ');
  }

  /** The in / out watts text, e.g. `in 1725 W · out 500 W` ('' with no power snapshot); the MOTHER hover detail shows it. */
  flowText() { return this._flowText; }

  /** The BATTERY time-left text, e.g. `empty in 19 min` ('' when quiet). */
  timeText() { return this._timeText || ''; }

  /** The engine half's label (the loaded fuel's name in capitals). */
  fuelLabel() { return this._fuelLabel; }

  /**
   * h1-mother-pane D3: the MPD-armed tint on the BATTERY bar fill (it was a write to the
   * deleted `hud-bar-battery`). '' = none, 'armed' = purple, 'amber' = the low-charge blink phase.
   * @param {''|'armed'|'amber'} mode
   */
  setMpdTint(mode) {
    const r = this._row.battery;
    if (!r) return;
    const m = mode === 'armed' || mode === 'amber' ? mode : '';
    if (m === (r.mpd || '')) return;
    r.mpd = m;
    if (m) r.el.setAttribute('data-mpd', m); else r.el.removeAttribute('data-mpd');
  }

  /** The BATTERY row's MPD tint mode ('' | 'armed' | 'amber'). */
  mpdTint() { const r = this._row.battery; return (r && r.mpd) || ''; }

  /** The row's current band ('green' | 'yellow' | 'red' | 'none'). */
  band(key) { const r = this._row[key]; return r ? r.st.band : 'none'; }

  /** The row's fill as a CSS width string (`47%`). */
  fill(key) { const r = this._row[key]; return r ? r.st.fill : ''; }

  /** The cost-flash state of 'battery' | 'gas': { count, lo, hi } as fractions of the pool, plus `until` (ms). */
  flashInfo(key) { return this._flash[key] || null; }

  // ── Readers ────────────────────────────────────────────────────────────────

  /** @private A snapshot method's result, or null (missing method, thrown error, non-object). */
  static _snap(rs, method) {
    if (!rs || typeof rs[method] !== 'function') return null;
    try {
      const s = rs[method]();
      return (s && typeof s === 'object') ? s : null;
    } catch (_e) {
      return null;
    }
  }

  // ── Painters ───────────────────────────────────────────────────────────────

  /** @private HEAT: the thermal snapshot, or `—` in grey. */
  _paintHeat(thermal) {
    const r = this._row.heat;
    const t = thermal ? Number(thermal.tempC) : NaN;
    if (!Number.isFinite(t)) {
      this._write(r, { band: 'none', fill: '0%', value: DASH, tag: '' });
      return;
    }
    const trend = Number(thermal.trend) || 0;
    this._write(r, {
      band: heatBand(t),
      fill: pctStr(t / VITALS_LAW.HEAT_SCALE_C),
      value: fmtHeat(t, trend),
      tag: thermal.autoOpened ? 'RADIATOR AUTO' : '',
    });
  }

  /** @private BATTERY: level + capacity + trend arrow + time left (median net power) + the cost flash. */
  _paintBattery(res, power, t) {
    const r = this._row.battery;
    let level = NaN;
    let max = NaN;
    if (power && Number.isFinite(power.battery) && Number.isFinite(power.batteryMax) && power.batteryMax > 0) {
      level = power.battery; max = power.batteryMax;
    } else if (res && Number.isFinite(res.battery) && Number.isFinite(res.batteryMax) && res.batteryMax > 0) {
      level = res.battery; max = res.batteryMax;
    }
    this._writeFlow(power);
    // D4: the net power goes through the median-of-30-seconds filter; the arrow and the time left read the median.
    if (power && Number.isFinite(Number(power.netW))) this._median.push(t, Number(power.netW));
    else this._median.reset();
    if (!(max > 0)) {
      this._write(r, { band: 'none', fill: '0%', value: DASH, rate: '', rateDir: '' });
      this._writeTime('');
      return;
    }
    const frac = clamp01(level / max);
    const net = power && this._median.count() >= this._warmup ? this._median.value() : NaN;
    const trend = fmtTrend(net);
    this._write(r, {
      band: levelBand(frac, VITALS_LAW.BATT_AMBER, VITALS_LAW.BATT_RED),
      fill: pctStr(frac),
      value: fmtBattery(level, max),
      rate: trend.text,
      rateDir: trend.dir,
    });
    this._writeTime(fmtTimeLeft(level, max, net));
    this._cost('battery', t, level, max, VITALS_LAW.FLASH_BATT_FRAC * max, VITALS_LAW.FLASH_EXTEND_BATT_FRAC_PER_S * max);
  }

  /**
   * @private w4-power D4 (owner 2026-10-12: "rotating mother should show
   * immediate drop in power-in"): the in / out watts text — `in` is this
   * frame's generation, unsmoothed (getPowerSnapshot().genW, the rate
   * PlayerSatellite._updateSolarPower writes), `out` is the ledger's draw
   * (smoothed over POWER_TAU_S 0.5 s). Whole watts, both always shown. Since
   * h4-simple-first D3 the text is not drawn in this pane: StatusPanel's MOTHER
   * hover detail reads `flowText()`.
   */
  _writeFlow(power) {
    let text = '';
    if (power) {
      const gen = Number.isFinite(power.genW) ? power.genW : Number(power.inW);
      const out = Number(power.outW);
      if (Number.isFinite(gen) && Number.isFinite(out)) {
        text = fmtFlow(gen, out);
      }
    }
    this._flowText = text;
  }

  /** @private The battery time-left text (write-on-change; empty = nothing drawn). */
  _writeTime(text) {
    if (text === this._timeText) return;
    this._timeText = text;
    if (this._timeEl) this._timeEl.textContent = text;
  }

  /**
   * @private The nitrogen half: the cold-gas tank. The bar is the pool fraction
   * (resources.coldGas / coldGasMax; the mass budget's fraction when there is
   * no player resource copy); the number is the budget's `coldGasCurrent` in
   * physical kg (`—` before the budget is ready). Plus the cost flash in tank terms.
   */
  _paintGas(res, mb, t) {
    const r = this._row.gas;
    let v = res ? Number(res.coldGas) : NaN;
    let max = res ? Number(res.coldGasMax) : NaN;
    if ((!Number.isFinite(v) || !(max > 0)) && mb && mb.coldGasMax > 0 && Number.isFinite(mb.coldGasCurrent)) {
      v = mb.coldGasCurrent; max = mb.coldGasMax;
    }
    if (!Number.isFinite(v) || !(max > 0)) {
      this._write(r, { band: 'none', fill: '0%', value: DASH });
      return;
    }
    const frac = clamp01(v / max);
    this._write(r, {
      band: levelBand(frac, VITALS_LAW.GAS_AMBER, VITALS_LAW.GAS_RED),
      fill: pctStr(frac),
      value: mb && Number.isFinite(mb.coldGasCurrent) ? fmtKg(mb.coldGasCurrent) : DASH,
    });
    this._cost('gas', t, v, max, VITALS_LAW.FLASH_GAS_FRAC * max, VITALS_LAW.FLASH_EXTEND_GAS_FRAC_PER_S * max);
  }

  /**
   * @private The cost flash for one pool: a new drop (>= `step` inside the
   * window) starts / merges a flash; while it fades, a further drain at
   * >= `extendPerS` (pool units per second) extends its low end and restarts
   * the fade, so a multi-second action reads as one chunk.
   */
  _cost(key, t, v, max, step, extendPerS) {
    const det = this._detect[key];
    const prev = this._prev[key];
    if (det.sample(t, v, step, VITALS_LAW.FLASH_WINDOW_MS)) {
      this._flashChunk(key, det.lo / max, det.hi / max, t, false);
    } else {
      const f = this._flash[key];
      const dt = (t - prev.t) / 1000;
      if (t < f.until && dt > 0 && (prev.v - v) / dt >= extendPerS) {
        this._flashChunk(key, v / max, f.hi, t, true);
      }
    }
    prev.t = t;
    prev.v = v;
  }

  /**
   * @private The engine half: the label is the loaded fuel's name in capitals;
   * the bar is the engine tank (the mass budget's `xenonCurrent / xenonMax`,
   * else the pool fraction); the number is the ship's ΔV in m/s from the mass
   * budget (`—` before the budget is ready). Amber < 15 %, red only when empty.
   */
  _paintIon(res, rs, mb) {
    const r = this._row.ion;
    this._paintFuelLabel(rs);
    let v = mb ? Number(mb.xenonCurrent) : NaN;
    let max = mb ? Number(mb.xenonMax) : NaN;
    if (!Number.isFinite(v) || !(max > 0)) {
      v = res ? Number(res.xenon) : NaN;
      max = res ? Number(res.xenonMax) : NaN;
    }
    if (!Number.isFinite(v) || !(max > 0)) {
      this._write(r, { band: 'none', fill: '0%', value: DASH });
      return;
    }
    // g1-gas-upgrades D7: the bar is the tank by MASS, the same for every gas (the budget's `gasFrac`).
    const frac = mb && Number.isFinite(mb.gasFrac) ? clamp01(mb.gasFrac) : clamp01(v / max);
    this._write(r, {
      band: frac <= 0 ? 'red' : levelBand(frac, VITALS_LAW.ION_AMBER, null),
      fill: pctStr(frac),
      value: mb && Number.isFinite(mb.deltaV) ? fmtDeltaV(mb.deltaV) : DASH,
    });
  }

  /** @private The engine half's label: the loaded fuel's name in capitals (write-on-change). */
  _paintFuelLabel(rs) {
    let name = '';
    if (rs && typeof rs.getCurrentFuel === 'function') {
      try {
        const f = rs.getCurrentFuel();
        if (f && typeof f.name === 'string') name = f.name.trim().toUpperCase();
      } catch (_e) { name = ''; }
    }
    const label = name || VITALS_LABELS.ion;
    if (label === this._fuelLabel) return;
    this._fuelLabel = label;
    const r = this._row.ion;
    if (r && r.label) r.label.textContent = label;
  }

  // ── DOM writes (all write-on-change) ───────────────────────────────────────

  /** @private Apply a partial state to a row; only the parts that differ touch the DOM. */
  _write(r, s) {
    if (!r) return;
    const st = r.st;
    if (s.band !== undefined && s.band !== st.band) {
      st.band = s.band;
      r.el.setAttribute('data-band', s.band);
    }
    if (s.fill !== undefined && s.fill !== st.fill) {
      st.fill = s.fill;
      r.fill.style.width = s.fill;
    }
    if (s.value !== undefined && s.value !== st.value) {
      st.value = s.value;
      r.value.textContent = s.value;
    }
    if (r.rate && s.rate !== undefined && s.rate !== st.rate) {
      st.rate = s.rate;
      r.rate.textContent = s.rate;
      r.rate.setAttribute('data-dir', s.rateDir || '');
      if (s.rate) r.rate.removeAttribute('data-empty'); else r.rate.setAttribute('data-empty', '');
    }
    if (r.tag && s.tag !== undefined && s.tag !== st.tag) {
      st.tag = s.tag;
      r.tag.textContent = s.tag;
      if (s.tag) r.tag.removeAttribute('data-empty'); else r.tag.setAttribute('data-empty', '');
    }
  }

  /**
   * @private Light the dropped chunk (fractions of the pool) and restart the
   * fade. A flash still fading is MERGED (its high end kept, the low end
   * moved to the new level), so a long drain reads as one growing bright
   * chunk rather than a blink per sample. `extend` = the same action still
   * draining (not counted as a new flash).
   */
  _flashChunk(key, loFrac, hiFrac, t, extend) {
    const f = this._flash[key];
    const r = this._row[key];
    let hi = hiFrac;
    if (t < f.until && f.hi > hi) hi = f.hi;
    if (!extend) f.count++;
    f.lo = clamp01(loFrac);
    f.hi = clamp01(hi);
    f.until = t + VITALS_LAW.FLASH_FADE_MS;
    if (!r || !r.flash) return;
    r.flash.style.left = pctStr(f.lo);
    r.flash.style.width = pctStr(f.hi - f.lo);
    f.phase ^= 1;
    r.flash.setAttribute('data-phase', f.phase ? 'a' : 'b');   // alternating keyframes restart the fade
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  /** @private Inject the style once, build title + rows + plume line, make the pane the parent's FIRST child. */
  _build(parent) {
    const doc = this._doc;
    if (!doc || typeof doc.createElement !== 'function') return;
    this._ensureStyle();

    const root = doc.createElement('div');
    root.id = VITALS_ID;
    root.className = 'hud-panel';
    root.setAttribute('data-vitals', '');

    const mk = (tag, cls, text) => {
      const el = doc.createElement(tag);
      el.className = cls;
      if (text !== undefined) el.textContent = text;
      return el;
    };

    // The title row: MOTHER on the left, the memo chip's slot on the right.
    const title = mk('div', 'vp-title pane-title');
    title.setAttribute('data-title', 'mother');
    title.appendChild(mk('span', 'vp-title-text', 'MOTHER'));
    this._titleSlot = mk('span', 'vp-title-slot');
    title.appendChild(this._titleSlot);
    root.appendChild(title);

    // A bar track with its fill (+ the cost-flash chunk where the pool has one).
    const mkTrack = (key, flash) => {
      const track = mk('span', `vp-track vp-track-${key}`);
      const fill = mk('span', 'vp-fill');
      fill.style.width = '0%';
      track.appendChild(fill);
      const flashEl = flash ? mk('span', 'vp-flash') : null;
      if (flashEl) track.appendChild(flashEl);
      track.appendChild(mk('span', 'vp-ticks'));
      return { track, fill, flash: flashEl };
    };
    const rec0 = (el, label, t) => ({ el, label, fill: t.fill, flash: t.flash, value: null, rate: null, tag: null,
      st: { band: 'none', fill: '0%', value: DASH, rate: '', tag: '' } });

    for (const key of VITALS_ROWS) {
      const el = mk('div', 'vp-row');
      el.setAttribute('data-row', key);
      el.setAttribute('data-band', 'none');
      const label = mk('span', 'vp-label', VITALS_LABELS[key]);
      el.appendChild(label);

      if (key === 'propulsion') {
        // One row, two halves: `N₂ ▮▮▮▯ 3.6 kg │ ARGON ▮▮▮▯ 1468 m/s`. Each half has its own band.
        this._row.propulsion = { el, label, st: { band: 'none', fill: '', value: '', rate: '', tag: '' } };
        VITALS_HALVES.forEach((hk, i) => {
          if (i > 0) el.appendChild(mk('span', 'vp-sep', '\u2502'));
          const half = mk('span', 'vp-half');
          half.setAttribute('data-half', hk);
          half.setAttribute('data-band', 'none');
          const sub = mk('span', 'vp-sublabel', VITALS_LABELS[hk]);
          const t = mkTrack(hk, hk === 'gas');
          const rec = rec0(half, sub, t);
          rec.value = mk('span', 'vp-value', DASH);
          half.appendChild(sub);
          half.appendChild(t.track);
          half.appendChild(rec.value);
          el.appendChild(half);
          this._row[hk] = rec;
        });
        root.appendChild(el);
        continue;
      }

      const t = mkTrack(key, key === 'battery');
      const rec = rec0(el, label, t);
      if (key === 'heat') {
        // The two thresholds, drawn where they are: 60 and 85 of a 0-100 scale.
        for (const c of [VITALS_LAW.HEAT_YELLOW_C, VITALS_LAW.HEAT_RED_C]) {
          const m = mk('span', 'vp-mark');
          m.style.left = `${(c / VITALS_LAW.HEAT_SCALE_C) * 100}%`;
          t.track.appendChild(m);
        }
        rec.tag = mk('span', 'vp-tag');
        rec.tag.setAttribute('data-empty', '');
        t.track.appendChild(rec.tag);
      }
      rec.value = mk('span', 'vp-value', DASH);
      el.appendChild(t.track);
      el.appendChild(rec.value);
      if (key === 'battery') {
        // h4-simple-first D3: the trend arrow and the time left ride the BATTERY row itself
        // (the in / out watts line moved into the MOTHER hover detail). The E-Tether tag keeps its id.
        const edt = mk('span', 'vp-edt', 'E-Tether');
        edt.id = 'edt-indicator';
        edt.setAttribute('title', 'Electrodynamic Tether');
        edt.style.display = 'none';
        el.appendChild(edt);
        rec.rate = mk('span', 'vp-rate');
        rec.rate.setAttribute('data-empty', '');
        el.appendChild(rec.rate);
        this._timeEl = mk('span', 'vp-time');
        el.appendChild(this._timeEl);
      }
      root.appendChild(el);
      this._row[key] = rec;
    }

    // The plume warning lives with the meters, never in the hover detail: a warning is never hover-only.
    this._plumeEl = mk('div', 'vp-plume', 'WARN PLUME BLOCK');
    this._plumeEl.id = 'plume-block-row';
    this._plumeEl.style.display = 'none';
    root.appendChild(this._plumeEl);

    this._root = root;
    if (parent && typeof parent.prepend === 'function') parent.prepend(root);
  }

  /** @private The one <style id="vitals-pane-style"> (per document). No backdrop-filter, no glow. */
  _ensureStyle() {
    const doc = this._doc;
    if (!doc || !doc.head || (doc.getElementById && doc.getElementById(VITALS_STYLE_ID))) return;
    const G = VITALS_GEOMETRY;
    const L = VITALS_LAW;
    const P = VisualLaw.COLORS;
    const HALO = '0 0 2px var(--hud-ink, #000), 0 0 2px var(--hud-ink, #000), 0 1px 1px var(--hud-ink, #000)';
    // D6: every colour is a role variable with today's hex as its fallback.
    const LABEL = `var(--hud-label, ${P.LABEL})`;
    const TITLE = 'var(--hud-label, #00ff88)';
    const TEXT = `var(--hud-text, ${P.LABEL})`;
    const NORMAL = `var(--hud-normal, ${P.PLAYER})`;
    const CAUTION = `var(--hud-caution, ${P.CAUTION})`;
    const WARNING = `var(--hud-warning, ${WARNING_RED})`;
    const INFO = 'var(--hud-info, #4488ff)';
    const DIM = `var(--hud-dim, ${NO_READING_GREY})`;
    const TITLE_SHADOW = 'var(--hud-title-shadow, 0 0 8px rgba(0, 255, 136, 0.35))';
    const style = doc.createElement('style');
    style.id = VITALS_STYLE_ID;
    style.textContent = `
      /* The house HUD grammar (the mono token, the dark plate, the green
       * hairline) rides in from .hud-panel; the left column's own rule makes
       * the pane position:relative. Width budget at the full width: ${G.WIDTH_PX} - 2 border -
       * ${2 * G.PAD_X_PX} padding = ${G.WIDTH_PX - 2 - 2 * G.PAD_X_PX} px per row: label ${G.LABEL_PX} + value
       * ${G.VALUE_PX} + 2 x 5 gap leaves the track ${G.WIDTH_PX - 2 - 2 * G.PAD_X_PX - G.LABEL_PX - G.VALUE_PX - 10} px
       * (the track is the flexible column: it takes any extra or lost room). */
      #${VITALS_ID} {
        width: var(--hud-side-w, ${G.WIDTH_PX}px);
        box-sizing: border-box;
        padding: ${G.PAD_Y_PX}px ${G.PAD_X_PX}px;
        display: flex;
        flex-direction: column;
        gap: ${G.GAP_PX}px;
        flex: 0 0 auto;
        font-size: 10px;
        pointer-events: none;
      }
      #${VITALS_ID} .vp-title {
        display: flex;
        align-items: baseline;
        gap: 6px;
        height: ${G.TITLE_PX}px;
        line-height: ${G.TITLE_PX}px;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.14em;
        color: ${TITLE};
        opacity: 0.95;
        text-shadow: ${TITLE_SHADOW};
        white-space: nowrap;
      }
      #${VITALS_ID} .vp-title-slot {
        margin-left: auto;
        font-size: 10px;
        font-weight: 400;
        letter-spacing: 0.08em;
        text-shadow: none;
      }
      #${VITALS_ID} .vp-row {
        display: flex;
        align-items: center;
        gap: 5px;
        height: ${G.ROW_PX}px;
        line-height: ${G.ROW_PX}px;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
        --vp-c: ${DIM};
      }
      #${VITALS_ID} :is(.vp-row, .vp-half)[data-band="green"]  { --vp-c: ${NORMAL}; }
      #${VITALS_ID} :is(.vp-row, .vp-half)[data-band="yellow"] { --vp-c: ${CAUTION}; }
      #${VITALS_ID} :is(.vp-row, .vp-half)[data-band="red"]    { --vp-c: ${WARNING}; }
      /* h4-simple-first D2: PROPULSION is one row of two halves (N\u2082 | engine gas), each with its own
       * band; the halves share what the label column leaves, the engine half takes the longer text. */
      #${VITALS_ID} .vp-half {
        display: flex;
        align-items: center;
        gap: 4px;
        flex: 1 1 0;
        min-width: 0;
        --vp-c: ${DIM};
      }
      #${VITALS_ID} .vp-half .vp-sublabel {
        flex: 0 0 auto;
        font-weight: 700;
        color: ${LABEL};
        opacity: 0.72;
        text-shadow: ${HALO};
      }
      #${VITALS_ID} .vp-half .vp-track { min-width: 12px; }
      #${VITALS_ID} .vp-half .vp-value { flex: 0 0 auto; }
      #${VITALS_ID} .vp-half[data-half="ion"] { flex-grow: 1.15; }
      #${VITALS_ID} .vp-sep { flex: 0 0 auto; opacity: 0.35; color: ${LABEL}; }
      #${VITALS_ID} .vp-label {
        flex: 0 0 ${G.LABEL_PX}px;
        font-weight: 700;
        letter-spacing: 0.02em;
        color: ${LABEL};
        opacity: 0.72;
        text-shadow: ${HALO};
      }
      #${VITALS_ID} .vp-value {
        flex: 0 0 ${G.VALUE_PX}px;
        text-align: right;
        font-weight: 700;
        color: var(--vp-c);
        text-shadow: ${HALO};
      }
      #${VITALS_ID} .vp-track {
        position: relative;
        flex: 1 1 auto;
        height: ${G.TRACK_PX}px;
        overflow: hidden;
        border-radius: 1px;
        background: rgb(var(--hud-text-rgb, 255 255 255) / 0.12);
      }
      /* HEAT: the zones are painted behind the bar - pale to 60, amber 60-85, red 85-100. */
      #${VITALS_ID} .vp-track-heat {
        background: linear-gradient(to right,
          rgb(var(--hud-text-rgb, 255 255 255) / 0.12) 0 ${L.HEAT_YELLOW_C}%,
          rgb(var(--hud-caution-rgb, 255 170 0) / 0.30) ${L.HEAT_YELLOW_C}% ${L.HEAT_RED_C}%,
          rgb(var(--hud-warning-rgb, 255 68 68) / 0.38) ${L.HEAT_RED_C}% 100%);
      }
      #${VITALS_ID} .vp-fill {
        position: absolute; left: 0; top: 0; bottom: 0;
        background: var(--vp-c);
      }
      /* h1-mother-pane D3: the MPD-armed purple tint rides the BATTERY bar fill. */
      #${VITALS_ID} .vp-row[data-row="battery"][data-mpd="armed"] .vp-fill { background: var(--hud-mpd, #aa44ff); }
      #${VITALS_ID} .vp-row[data-row="battery"][data-mpd="amber"] .vp-fill { background: ${CAUTION}; }
      /* The 10 % segments: a 1 px dark line at the right edge of each tenth. */
      #${VITALS_ID} .vp-ticks {
        position: absolute; left: 0; top: 0; right: 0; bottom: 0;
        background-image: linear-gradient(to left, rgb(var(--hud-ink-rgb, 5 10 20) / 0.95) 1px, transparent 1px);
        background-size: 10% 100%;
      }
      #${VITALS_ID} .vp-mark {
        position: absolute; top: 0; bottom: 0; width: 1px;
        background: ${LABEL};
        opacity: 0.9;
      }
      /* The cost flash: bright at the fill's end, fades over ${L.FLASH_FADE_MS} ms. The two keyframe
       * names are identical; alternating them restarts the fade with no forced layout. */
      #${VITALS_ID} .vp-flash {
        position: absolute; top: 0; bottom: 0; left: 0; width: 0;
        min-width: 2px;
        background: ${LABEL};
        opacity: 0;
      }
      #${VITALS_ID} .vp-flash[data-phase="a"] { animation: vp-flash-a ${L.FLASH_FADE_MS}ms linear forwards; }
      #${VITALS_ID} .vp-flash[data-phase="b"] { animation: vp-flash-b ${L.FLASH_FADE_MS}ms linear forwards; }
      @keyframes vp-flash-a { from { opacity: 1; } to { opacity: 0; } }
      @keyframes vp-flash-b { from { opacity: 1; } to { opacity: 0; } }
      #${VITALS_ID} .vp-tag {
        position: absolute; left: 3px; top: 0; bottom: 0;
        font-size: 9px;
        letter-spacing: 0.04em;
        font-weight: 700;
        line-height: ${G.TRACK_PX}px;
        color: ${LABEL};
        background: var(--hud-ink, #000);
        padding: 0 3px;
        border-radius: 2px;
        text-shadow: none;
      }
      #${VITALS_ID} .vp-rate[data-dir="up"]   { color: ${NORMAL}; }
      #${VITALS_ID} .vp-rate[data-dir="down"] { color: ${CAUTION}; }
      /* h4-simple-first D3: the trend arrow and the time left sit on the BATTERY row, after the number. */
      #${VITALS_ID} .vp-rate {
        flex: 0 0 auto;
        font-size: 9px;
        font-weight: 700;
        white-space: nowrap;
        color: ${LABEL};
        text-shadow: ${HALO};
      }
      #${VITALS_ID} .vp-time {
        flex: 0 1 auto;
        min-width: 0;
        overflow: hidden;
        font-size: 9px;
        font-weight: 700;
        color: ${TEXT};
        opacity: 0.85;
        text-shadow: ${HALO};
      }
      #${VITALS_ID} .vp-edt { color: ${INFO}; font-size: 9px; font-weight: 700; flex: 0 0 auto; }
      #${VITALS_ID} .vp-rate[data-empty] { display: none; }
      #${VITALS_ID} .vp-tag[data-empty] { display: none; }
      /* The plume warning: hidden until StatusPanel lights it (inline display), never part of the hover detail. */
      #${VITALS_ID} .vp-plume {
        font-size: 10px;
        font-weight: 700;
        color: ${WARNING};
        text-shadow: ${HALO};
      }
    `;
    doc.head.appendChild(style);
  }
}

export default VitalsPane;
