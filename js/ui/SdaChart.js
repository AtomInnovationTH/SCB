/**
 * SdaChart.js — Zoom Ladder SDA DOWNLINK (id 5) whole-domain chart overlay (FloorContract.FLOORS[6]).
 *
 * The camera sits 500–1300 u from Earth center and the domain is read as a CHART: an Earth-centered altitude-band
 * diagram of the 200–2000 km LEO shells with aggregated object counts (live debris clusters + active satellites), the
 * GEO ring pinned to the left/right screen edges by the aspect-derived MEO radial compression (the "MEO compressed"
 * tag shows whenever the map is compressed — never silently distort), and a decade-scale Kessler timeline strip.
 *
 * TWO LENSES (FloorContract.byId(5).chart.lenses, flipped by the SDA Space verb 'flip-lens'):
 *   - VALUE  — gold (VisualLaw.COLORS.VALUE, STEADY — gold never pulses): salvage mass per band from
 *     FloorContract.MASS_BANDS (LEO_SUB_BANDS are ESTIMATE-flagged and rendered with the flag — mass-honesty rule),
 *     plus the GEO belt+graveyard "gold" total on the ring.
 *   - THREAT — red-orange (VisualLaw.COLORS.THREAT, ALWAYS pulses): count-weighted density per band (counts / shell
 *     volume, normalized) and the Kessler timeline (keyframes, single-event injections, branch projection), plus the
 *     required honesty notes (sensor-jump + disputed-onset caveats).
 *
 * projectDensity is PURE and exported: it mirrors KesslerSystem.update()'s quadratic density model (secondary-collision
 * rate ∝ (count/threshold)²) at catalog scale: dN/dt = c·N²/N₀, N(t) = N₀ / (1 − c·Δt), hyperbolic toward a
 * finite-time cascade singularity. The default coefficient is calibrated to the FloorContract BAU branch anchor
 * (~4× by 2059, Lewis 2009); the live game feeds KesslerSystem.getCascadeRisk() in as `riskBoost`.
 *
 * VISUAL LAW: color is never the sole channel (lens is double-encoded: ramp color AND which figures are drawn AND the
 * THREAT pulse); at most `labelBudget` (SDA = 7) named labels are painted, ranked by lens weight (rankLabels).
 * Axis numerals / honesty tags are chart chrome, not world labels.
 *
 * NO PER-FRAME CHURN: the chart is screen-static while the data is static (Earth-anchored floor), so render()
 * rasterizes ONLY when the frame signature changes (lens, viewport, band aggregates, timeline inputs). The THREAT
 * pulse repaints at most every PULSE_TICK_MS (250 ms, ≤4 Hz), never per frame. The gate is the pure static
 * shouldPaint(); render() always computes and returns frame descriptors; painting is the gated side effect.
 *
 * Follows the ReachOrb canvas overlay pattern: full-screen canvas, pointer-events:none, built lazily on show(),
 * opacity-transitioned, DOM-guarded (inert + constructible in Node tests). No camera, debris source, game loop or
 * EventBus: SdaFloor feeds it aggregates + a viewport and owns the lifecycle.
 *
 * @module ui/SdaChart
 */

import { Constants } from '../core/Constants.js';
import { VisualLaw } from '../core/VisualLaw.js';
import { FloorContract } from '../core/FloorContract.js';
import { mono, fontEpoch as defaultFontEpoch } from '../core/Typeface.js';
import { clamp01 } from '../core/MathUtil.js';
import { CLASS_COLORS } from './RealSkyCard.js';
import { hudScaleFor } from './HudScale.js';

/** The SDA DOWNLINK (id 5) contract row (chart framing + labelBudget + lenses). */
const FLOOR = FloorContract.byId(5);

/** The two lenses, in flip order. VALUE is the arrival default. */
export const LENSES = FLOOR.chart.lenses; // ['VALUE', 'THREAT']

/**
 * THREAT-pulse repaint quantum (ms): the pulse phase is the only time-varying paint input, so the canvas rasterizes
 * at ≤4 Hz (same cap as the NAVCOM planner's countdown text). VALUE is STEADY: nothing repaints until the signature changes.
 */
export const PULSE_TICK_MS = 250;

/** Full pulse period (ms) — a slow 2 s breathe, amplitude handled in paint. */
export const PULSE_PERIOD_MS = 2000;

/**
 * LEO zone vertical budget: the honest-scale zone (Earth disc + 200–2000 km shells) fills this fraction of the
 * half-height; the MEO compression factor follows from what is left to the left/right screen edge.
 */
export const LEO_VFRAC = 0.6;

/**
 * Projected-cascade display ceiling (× base count). The hyperbolic BAU curve has a finite-time singularity (the
 * cascade); past it the count is clamped here so the strip stays drawable. Onset timing is disputed, so it reads as "cascade".
 */
export const CASCADE_CEIL_FACTOR = 20;

/**
 * Year the BAU branch anchor reaches ~4× tracked (Lewis 2009, from the 2026 keyframe): N₀/(1−cΔt) = 4N₀ at
 * 1−cΔt = 1/4, so the default c = 0.75/(2059−2026).
 */
export const BAU_QUADRUPLE_YEAR = 2059;

/** Chart chrome colors (the SDA chart costume, not VisualLaw semantics). */
const CHART_EARTH_BLUE = 'rgba(24, 62, 100, 0.92)'; // chart-blue flat disc
const CHART_GRID = 'rgba(0, 204, 255, 0.18)';       // faint INFO grid/rings

const _nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Altitude (km) of one active-sat record: data/active-sats.json ({tle:{alt_km}}), ActiveSatellites ({altKm}) or a bare
 * {alt_km}. NaN when unknown (the record then lands out-of-band, never vanishes).
 */
export function satAltKm(sat) {
  if (!sat) return NaN;
  if (sat.tle && Number.isFinite(sat.tle.alt_km)) return sat.tle.alt_km;
  if (Number.isFinite(sat.altKm)) return sat.altKm;
  if (Number.isFinite(sat.alt_km)) return sat.alt_km;
  return NaN;
}

/**
 * Aggregate live objects into the SDA altitude bands: the canonical FloorContract.MASS_BANDS.LEO_SUB_BANDS shells
 * (never Constants.DEBRIS.ALT_BANDS / DebrisMap's UI array — SSOT), each with its canonical salvage mass (massT,
 * ESTIMATE-flagged) plus live debris-cluster counts, active-sat counts and live cluster mass (t). Objects outside
 * [firstLo, lastHi] km (GEO comms, GNSS, HEO) go into `outOfBand` — counted, never dropped (honesty rule).
 * Band rule: lo ≤ alt < hi, except the last band includes its top edge.
 * @param {object} [src]
 * @param {Array} [src.clusters] - DebrisField.getDebrisClusters() shapes ({count, avgAltKm, totalMassKg, ...})
 * @param {Array} [src.sats]     - active-sat records (satAltKm shapes)
 * @param {object} [src.realSky] - data/real-sky.json (GCAT counts + masses per height; CatalogLoader.getRealSky()). A
 *   band whose [lo,hi] equals one of its `bands[].altKm` takes the real mass (estimate false) and carries `realCount` /
 *   `realNotWorking`; an edge that does not match keeps the estimate (no partial merge). Absent → exactly the estimates.
 * @returns {{bands: Array<{altKm:[number,number], massT:number, estimate:boolean,
 *            note:string, count:number, clusterCount:number, satCount:number,
 *            liveMassT:number, realCount?:number, realNotWorking?:number}>, outOfBand:{count:number, satCount:number,
 *            clusterCount:number}, totalCount:number, realSky:object|null}}
 */
export function aggregateBands(src = {}) {
  const clusters = Array.isArray(src.clusters) ? src.clusters : [];
  const sats = Array.isArray(src.sats) ? src.sats : [];
  const realSky = (src.realSky && Array.isArray(src.realSky.bands)) ? src.realSky : null;
  const bands = FloorContract.MASS_BANDS.LEO_SUB_BANDS.map((b) => {
    const band = {
      altKm: [b.altKm[0], b.altKm[1]],
      massT: b.massT,
      estimate: !!b.estimate,
      note: b.note || '',
      count: 0,
      clusterCount: 0,
      satCount: 0,
      liveMassT: 0,
    };
    const real = realSky && realSky.bands.find((r) => r && r.altKm
      && r.altKm[0] === b.altKm[0] && r.altKm[1] === b.altKm[1]);
    if (real && Number.isFinite(real.massT) && Number.isFinite(real.n)) {
      band.massT = real.massT;
      band.estimate = false;
      band.realCount = real.n;
      band.realNotWorking = real.n - ((real.byClass && real.byClass.working) || 0);
    }
    return band;
  });
  const lo0 = bands[0].altKm[0];
  const hiN = bands[bands.length - 1].altKm[1];
  const outOfBand = { count: 0, satCount: 0, clusterCount: 0 };

  const bandFor = (alt) => {
    if (!Number.isFinite(alt) || alt < lo0 || alt > hiN) return null;
    for (let i = 0; i < bands.length; i++) {
      const [lo, hi] = bands[i].altKm;
      if (alt >= lo && (alt < hi || (i === bands.length - 1 && alt <= hi))) return bands[i];
    }
    return null;
  };

  for (const c of clusters) {
    if (!c) continue;
    const n = c.count || 0;
    const band = bandFor(c.avgAltKm);
    if (band) {
      band.count += n;
      band.clusterCount += 1;
      band.liveMassT += (c.totalMassKg || 0) / 1000;
    } else {
      outOfBand.count += n;
      outOfBand.clusterCount += 1;
    }
  }
  for (const s of sats) {
    const band = bandFor(satAltKm(s));
    if (band) {
      band.count += 1;
      band.satCount += 1;
    } else {
      outOfBand.count += 1;
      outOfBand.satCount += 1;
    }
  }
  const totalCount = bands.reduce((a, b) => a + b.count, 0) + outOfBand.count;
  return { bands, outOfBand, totalCount, realSky };
}

/** 12816 → "12,816" (fixed separator, never the locale's). */
const _thousands = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * Per-band lens weights, normalized 0..1 against the strongest band (all-zero input → all-zero weights).
 *   VALUE  — canonical band mass + live cluster mass.
 *   THREAT — count-weighted DENSITY, objects per shell volume ∝ (R+hi)³ − (R+lo)³ (the Kessler risk driver: a thin
 *            crowded shell out-threats a thick sparse one).
 * @param {Array} bands - aggregateBands().bands
 */
export function lensWeights(bands, lens) {
  const list = Array.isArray(bands) ? bands : [];
  const R = Constants.EARTH_RADIUS_KM;
  const raw = list.map((b) => {
    if (lens === 'THREAT') {
      const [lo, hi] = b.altKm;
      const vol = Math.pow(R + hi, 3) - Math.pow(R + lo, 3);
      const n = b.realCount != null ? b.realCount : (b.count || 0); // real GCAT count when the band has one
      return vol > 0 ? n / vol : 0;
    }
    return (b.massT || 0) + (b.liveMassT || 0);
  });
  const max = raw.reduce((a, v) => Math.max(a, v), 0);
  return raw.map((v) => (max > 0 ? v / max : 0));
}

/**
 * Resolve FloorContract KESSLER_KEYFRAMES into a cumulative tracked-count polyline: `tracked` keyframes are absolute;
 * `delta` keyframes (single-event injections — Fengyun-1C, Iridium/Kosmos) add onto the last value and get `event: true`.
 * @param {Array} [keyframes] - default FloorContract.KESSLER_KEYFRAMES
 */
export function resolveKeyframes(keyframes = FloorContract.KESSLER_KEYFRAMES) {
  const out = [];
  let last = 0;
  for (const k of keyframes) {
    const tracked = (k.tracked != null) ? k.tracked : last + (k.delta || 0);
    out.push({ year: k.year, tracked, event: k.tracked == null, note: k.note || '' });
    last = tracked;
  }
  return out;
}

/**
 * PURE Kessler density projection: KesslerSystem's model at catalog scale. KesslerSystem's secondary-collision rate
 * is QUADRATIC in density (update(): riskFactor = (count/threshold)²), so the same form on the tracked catalog:
 *
 *     dN/dt = c_eff · N²/N₀   ⇒   N(Δt) = N₀ / (1 − c_eff·Δt)
 *
 * with a finite-time singularity at Δt = 1/c_eff (the cascade). c_eff = coeffPerYear · (1 + riskBoost): the live game
 * feeds KesslerSystem.getCascadeRisk() (0..1) in, so player-made fragments steepen the curve and risk decay relaxes
 * it. Past the singularity the count clamps at CASCADE_CEIL_FACTOR·N₀ and `cascaded` flips true.
 * @param {number} [opts.baseYear]  - projection epoch (default: last keyframe year)
 * @param {number} [opts.baseCount] - tracked count at epoch (default: last keyframe)
 * @param {number} [opts.horizonYears=100] - how far to project
 * @param {number} [opts.stepYears=10]     - decade-scale sampling
 * @param {number} [opts.coeffPerYear]     - quadratic coefficient (default: BAU anchor, ~4× by BAU_QUADRUPLE_YEAR)
 * @param {number} [opts.riskBoost=0]      - live cascade risk 0..1 (KesslerSystem)
 * @returns {Array<{year:number, tracked:number, cascaded:boolean}>}
 */
export function projectDensity(opts = {}) {
  const kf = resolveKeyframes();
  const lastKf = kf[kf.length - 1];
  const baseYear = (opts.baseYear != null) ? opts.baseYear : lastKf.year;
  const baseCount = (opts.baseCount != null) ? opts.baseCount : lastKf.tracked;
  const horizonYears = (opts.horizonYears != null) ? opts.horizonYears : 100;
  const stepYears = (opts.stepYears != null) ? opts.stepYears : 10;
  const coeff = (opts.coeffPerYear != null)
    ? opts.coeffPerYear
    : 0.75 / (BAU_QUADRUPLE_YEAR - baseYear);
  const risk = clamp01(opts.riskBoost || 0);
  const cEff = coeff * (1 + risk);
  const ceil = baseCount * CASCADE_CEIL_FACTOR;

  const out = [];
  for (let dt = 0; dt <= horizonYears; dt += stepYears) {
    const denom = 1 - cEff * dt;
    const cascaded = denom <= (1 / CASCADE_CEIL_FACTOR);
    const tracked = cascaded ? ceil : Math.round(baseCount / denom);
    out.push({ year: baseYear + dt, tracked, cascaded });
  }
  return out;
}

/**
 * The whole timeline model for the strip: resolved history keyframes, the decade projection from the live risk, and
 * the FloorContract branches (the ADR branch is the player's role — the endings frame).
 * @param {number} [opts.riskBoost=0] - KesslerSystem.getCascadeRisk()
 * @returns {{history:Array, projection:Array, branches:Array, baseYear:number}}
 */
export function buildTimeline(opts = {}) {
  const history = resolveKeyframes();
  const projection = projectDensity({
    riskBoost: opts.riskBoost || 0,
    horizonYears: opts.horizonYears,
    stepYears: opts.stepYears,
  });
  return {
    history,
    projection,
    branches: FloorContract.KESSLER_BRANCHES,
    baseYear: history[history.length - 1].year,
  };
}

/**
 * Aspect-derived radial map (the MEO compression). The LEO zone (Earth disc + shells up to the last band's top) is
 * drawn at an HONEST linear scale sized to LEO_VFRAC of the half-height; the MEO zone beyond is radially compressed by
 * the single factor that lands the GEO ring (FloorContract chart.geoRingU ≈ 420 u) exactly at the left/right screen
 * edges (x = ±w/2). cFactor < 1 ⇒ compressed ⇒ the honest tag must show; on a hyper-wide viewport (cFactor ≥ 1)
 * nothing is distorted and the tag hides.
 * @param {object} vp - {wPx, hPx}
 * @returns {{sLeoPxPerU:number, leoTopPx:number, leoTopU:number, geoU:number,
 *            geoPx:number, cFactor:number, compressed:boolean}}
 */
export function meoRadialMap(vp) {
  const w = Math.max(1, vp && vp.wPx || 1);
  const h = Math.max(1, vp && vp.hPx || 1);
  const RE_U = Constants.EARTH_RADIUS; // 63.71 u
  const bands = FloorContract.MASS_BANDS.LEO_SUB_BANDS;
  const leoTopKm = bands[bands.length - 1].altKm[1]; // 2000 km
  const leoTopU = RE_U + leoTopKm * Constants.SCENE_SCALE; // 83.71 u
  const geoU = FLOOR.chart.geoRingU;

  const leoTopPx = (h / 2) * LEO_VFRAC;
  const sLeoPxPerU = leoTopPx / leoTopU;
  const geoPx = w / 2;
  const cFactor = (geoPx - leoTopPx) / (sLeoPxPerU * (geoU - leoTopU));
  return {
    sLeoPxPerU, leoTopPx, leoTopU, geoU, geoPx,
    cFactor,
    compressed: cFactor < 1,
  };
}

/**
 * Radial pixel distance from screen center for a circular altitude (km), through the piecewise honest-LEO /
 * compressed-MEO map. Monotone in altKm.
 * @param {object} map - meoRadialMap() result
 * @returns {number} px
 */
export function radiusPxForAltKm(map, altKm) {
  const u = Constants.EARTH_RADIUS + Math.max(0, altKm) * Constants.SCENE_SCALE;
  if (u <= map.leoTopU) return u * map.sLeoPxPerU;
  return map.leoTopPx + (u - map.leoTopU) * map.sLeoPxPerU * map.cFactor;
}

/**
 * Rank label candidates for the floor's labelBudget (SDA = 7): weight-desc, stable on ties by id, truncate.
 * Mirrors ClusterIcons.rank.
 * @param {Array<{id:*, weight:number}>} candidates
 * @param {number} [budget] - default FLOOR.labelBudget
 */
export function rankLabels(candidates, budget = FLOOR.labelBudget) {
  const list = Array.isArray(candidates) ? candidates.slice() : [];
  list.sort((a, b) => {
    const dw = (b.weight || 0) - (a.weight || 0);
    if (dw !== 0) return dw;
    return String(a.id).localeCompare(String(b.id));
  });
  return list.slice(0, Math.max(0, budget | 0));
}

/** Smallest allowed distance between two label baselines, px (10 px font). */
export const LABEL_MIN_GAP_PX = 14;
/**
 * First baseline the chart's own text may use at the top, px (owner 2026-11-17, DECISIONS §74 row 3 / lane T6). The score bar
 * covers y 8-43 at the top centre (measured at 1728x1117 and 1366x1024: x 689-1039 / 508-858), so the "MEO compressed" tag,
 * its caveat line and the GEO ring label used to print under it. They now start below it, one 14 px row apart.
 */
export const CHART_TOP_CLEAR_PX = 62; // 56 left the tag's glyphs 5 px under the score bar on the iPad (visual check 2026-11-18): 11 px now
/**
 * The Kessler strip's top and bottom edges as distances from the screen bottom, px (lane fix F2, 2026-11-18). The bottom used to be
 * 34: the field-heights line (baseline h-23, glyph tops h-31) touched the decade ticks (to h-30) and the trace. At 44 the ticks end at
 * h-40, 9 px above the field-heights line's glyph tops (at least 6 px asked).
 * 2026-11-22 (sky 18): the year labels now run every 20 years under the whole strip, so they sit in the field-heights line's rows: the
 * bottom is 52 (ticks end at h-48), the labels' baseline 15 px under it (glyphs h-45..h-37, 6 px above that line's glyph tops at h-31),
 * and the top 112 (the plot is 60 px tall: a 32 px plot made the 1957-2026 climb a hairline. The page title "Debris by height" is
 * centred with its bottom at h-108, so the forecast must stay under it: it is at most 0.78 of the plot high over the title's width.
 * The page dots' circles sit at h-80 +-5, centred; the line passes over them.)
 * 2026-11-22 (sky 19, owner: the title and dots sat ON the strip): the strip now stands wholly above the page row's band. That band is
 * the title (PageRow TITLE_BOTTOM_PX 108, about 16 px tall: glyphs h-124..h-108) and the dots (hit targets h-104..h-56, circles h-80 +-5),
 * so the strip's bottom is 150 (ticks end at h-146, the 20-year labels' baseline h-135, descenders h-132: 8 px above the title's glyphs)
 * and its top 202 (the plot is 52 px tall). One credit line sits under the dots at h-7.
 */
export const STRIP_TOP_FROM_BOTTOM_PX = 202;
export const STRIP_BOTTOM_FROM_BOTTOM_PX = 150;
/** Decade ticks hang this far under the strip's bottom edge. */
export const STRIP_TICK_PX = 4;
/** The 20-year labels' baseline, px under the strip's bottom edge. */
const STRIP_LABEL_DROP_PX = 15;

/**
 * Every string the chart painted last (CSS px: x, y top, w, h) - the real-sky dots canvas (z 34) sits over the chart (z 33) and
 * clears these rectangles after painting its dots, so no label is overprinted by a dot (lane fix F1, 2026-11-18). Module-level
 * because the two layers never meet otherwise; a hidden chart reports none.
 * @type {Array<{text:string,x:number,y:number,w:number,h:number}>}
 */
let _chartTextBoxes = [];
let _chartTextVersion = 0;
/** @returns {Array<{text:string,x:number,y:number,w:number,h:number}>} the last painted chart text boxes (empty when hidden) */
export function chartTextBoxes() { return _chartTextBoxes; }
/** @returns {number} bumps whenever the boxes change (the dots canvas repaints on it) */
export function chartTextVersion() { return _chartTextVersion; }
function _setChartTextBoxes(list) { _chartTextBoxes = list; _chartTextVersion++; }
/** The lowest a label baseline may start: below the tag and the caveat row (CHART_TOP_CLEAR_PX + 2 rows). */
export const LABEL_TOP_PX = CHART_TOP_CLEAR_PX + 28;
/** Label x offset from the centre for a label that has no leader (the far ring's label at the top). */
const LABEL_X_NEAR = 8;
/** The five height labels stand in a column at the upper right, outside the outermost band (owner 2026-11-22, sky 18). */
const COLUMN_X_FRAC = 0.72;   // column left edge = this x the outermost band's outer radius + COLUMN_X_PAD_PX, from the centre
const COLUMN_X_PAD_PX = 16;
/** Clear space between the outermost ring and the nearest corner of any column label box, px. */
const COLUMN_CLEAR_PX = 10;
/** Where each leader leaves its ring: this many degrees clockwise from 12 o'clock (about half past one). */
const LEADER_ANGLE_DEG = 50;
/**
 * The colour key above the label column (Sky 19: the search / tick-box panel and its key are not on page 1 any more): one short line,
 * each half drawn in its own colour. Ring dots are warm (orange) for debris, rocket stages and dead satellites and grey-blue for working,
 * "sat" and unknown ones (RealSkyCard CLASS_COLORS, the colours RealSkyLayer's floor-5 canvas fills with). It stands this far above the
 * column's first label baseline.
 */
export const KEY_ABOVE_PX = 18;
export const KEY_WARM = { text: '\u25cf debris, stage, dead', color: CLASS_COLORS[1] };
export const KEY_COOL = { text: '\u25cf working, sat, unknown', color: CLASS_COLORS[3] };
/** Width of one 10 px label when there is no canvas to measure it (the face is about 6.1 px a glyph). */
const GLYPH_PX = 6.6;

/**
 * Lay the ring labels out so no two text boxes overlap. The band labels (ids `band-…`) stand in ONE column at the upper right,
 * outermost band first at fixed `minGap` spacing, entirely outside the outermost ring (`outerPx`, the outer radius of the last
 * band): the column's left edge sits at 0.72 of that radius + 16 px, and its lowest box ends where the circle (radius + 10 px)
 * passes it. Each label has a leader from its OWN ring (its `rPx`, about half past one o'clock) to the column. When the column
 * would meet a box that sits over it (`avoid`: {x0, x1, y0, y1} as offsets from the centre/top; the Mac radio box) the column, with its colour key,
 * goes under that box instead. Any
 * other label (the GEO ring's) sits at the top beside the centre line. The input is not mutated; the strip title (rPx 0, painted
 * with the strip) passes through untouched.
 * @param {Array<{id:*, rPx:number, text?:string}>} labels
 * @param {number} cy - chart centre y, px
 * @param {number} [minGap]
 * @param {number} [minY]     - first baseline the column may use
 * @param {number} [outerPx]  - outer radius of the outermost band, px (default: the outermost label's radius + 4)
 * @param {{x0:number,x1:number,y0:number,y1:number}|null} [avoid] - a rectangle the column must not touch (x from the centre, y from the top)
 * @returns {Array<object>} each label plus `x` (offset from the centre), `y` (baseline), `ringX` / `ringY` (leader start: x from
 *   the centre, y from the top), `leader`
 */
export function layoutLabels(labels, cy, minGap = LABEL_MIN_GAP_PX, minY = 12, outerPx = 0, avoid = null) {
  const out = labels.map((l) => {
    const ringY = cy - l.rPx;
    return { ...l, x: LABEL_X_NEAR, y: Math.max(minY, ringY - 3), ringX: 0, ringY, leader: false };
  });
  const bands = out.filter((l) => String(l.id).startsWith('band-')).sort((a, b) => b.rPx - a.rPx);
  if (!bands.length) return out;
  const edge = outerPx > 0 ? outerPx : bands[0].rPx + 4;
  const x0 = edge * COLUMN_X_FRAC + COLUMN_X_PAD_PX;
  let x = x0;
  const reach = edge + COLUMN_CLEAR_PX;
  const dy = Math.sqrt(Math.max(0, reach * reach - x * x));
  let bottom = cy - dy - 3;                       // baseline of the lowest label; its box ends 3 px lower
  const span = (bands.length - 1) * minGap;
  if (avoid) {
    // The colour key stands KEY_ABOVE_PX over the first label (glyph top 9 px over its baseline), so it counts as part of the column.
    const colTop = bottom - span - KEY_ABOVE_PX - 9, colBottom = bottom + 3;
    if (x + 400 > avoid.x0 && x < avoid.x1 && colBottom > avoid.y0 && colTop < avoid.y1) {
      // Under the rectangle (the radio box): key 6 px below it, the column under the key. Lower down the ring is wider at the column's
      // height, so the column also moves right until its nearest corner is outside the circle again (the leaders get longer).
      bottom = avoid.y1 + 6 + KEY_ABOVE_PX + 9 + span;
      const below = cy - (bottom + 3);
      if (below > 0 && below < reach) x = Math.max(x0, Math.sqrt(reach * reach - below * below));
    }
  }
  const top = Math.max(minY + 14, bottom - span);   // one row under the first top line, whose box ends 3 px under its baseline (the GEO label)
  const a = LEADER_ANGLE_DEG * Math.PI / 180;
  bands.forEach((l, k) => {
    l.x = x;
    l.y = top + k * minGap;
    l.leader = true;
    l.ringX = l.rPx * Math.sin(a);
    l.ringY = cy - l.rPx * Math.cos(a);
  });
  return out;
}

/** The two lens buttons, in flip order: words for what each lens shows (gold = tonnes, red = danger). */
export const LENS_BUTTONS = Object.freeze([
  { lens: 'VALUE', label: 'Tonnes' },
  { lens: 'THREAT', label: 'Danger' },
]);
/** Like the air page's Sun buttons: a fingertip tall (AirChart BUTTON_MIN_H 46). */
export const LENS_BTN_H = 46;
const LENS_BTN_W = 96;
const LENS_BTN_TEXT = '#eef2f7';
/** The buttons stand in a column: Danger under Tonnes, this far apart, this far from the screen's top and left (CSS px). */
export const LENS_STACK_GAP_PX = 8;
export const LENS_STACK_EDGE_PX = 16;
/** Page 1's radio notice sits at the top left, this far right of the buttons and at least this far before the score bar's left edge. */
export const NOTICE_GAP_PX = 12;
export const NOTICE_SCORE_GAP_PX = 16;
/** Narrower than this and the notice goes under the buttons instead. */
export const NOTICE_MIN_W_PX = 340;
/** The score bar's half width: 140 px (the 280 px strip, #hud-score-panel) x the HUD scale (measured 350 wide at 1728 and 1366). */
const SCORE_HALF_W_PX = 140;
/** The once-only "GEO means ..." toast's bottom edge on page 1: just above the timeline strip's top label (strip top h-202, label glyphs h-222). */
export const TOAST_BOTTOM_PX = 228;
export const PAGE_ATTR = 'data-sda-page';
const PAGE_STYLE_ID = 'sda-page-chrome-style';

/**
 * Where the radio notice (`#hud-comms-panel`) goes on page 1 (CSS px; pure). The box is a HUD group scaled by `scale` from its top-right
 * corner, so the width is given before scaling and the move is the `translate` property (outside the scale): from its natural place
 * (flush right, top 0) to the target left edge and top. Right of the stacked buttons when that leaves {@link NOTICE_MIN_W_PX}, else under them.
 * @returns {{x:number, y:number, wScreen:number, wCss:number, under:boolean}} x, y: the translate; wScreen: the width on screen
 */
export function noticePlacement(wPx, hPx, scale = hudScaleFor(wPx, hPx)) {
  const stackBottom = LENS_STACK_EDGE_PX + 2 * LENS_BTN_H + LENS_STACK_GAP_PX;
  const right = wPx / 2 - SCORE_HALF_W_PX * scale - NOTICE_SCORE_GAP_PX;
  const leftSide = LENS_STACK_EDGE_PX + LENS_BTN_W + NOTICE_GAP_PX;
  const sideW = right - leftSide;
  const under = sideW < NOTICE_MIN_W_PX;
  const left = under ? LENS_STACK_EDGE_PX : leftSide;
  const top = under ? stackBottom + NOTICE_GAP_PX : LENS_STACK_EDGE_PX;
  const wScreen = Math.max(0, Math.min(right - left, 480 * scale));
  const wCss = wScreen / scale;
  return { x: left - (wPx - wScreen), y: top, wScreen, wCss, under };
}

/** The strip's title (plain words; the forecast starts at "today"). */
export const STRIP_TITLE = 'Objects in orbit, 1957\u20132126 \u00b7 after today: forecast';
/** The strip's scale note: the count axis is logarithmic, so every step up is ten times more. */
export const STRIP_SCALE_NOTE = 'Each step up is 10 times more objects';
/** The strip's honest-scale caveats (VALUE: some masses are estimates; THREAT: the timeline's two caveats). */
export const NOTE_ESTIMATES = 'Band masses marked est. are estimates';
export const NOTE_THREAT = 'Some jumps before 2020 are better tracking, not new pieces \u00b7 when a chain reaction starts is disputed';

/** The lowest count the strip's log axis shows (the 1957 start of zero sits on this line), and the decades it spans. */
export const STRIP_LOG_MIN = 1000;

/**
 * The page's one credit line: the GCAT credit (CC BY 4.0) plus the other sources the real-sky layer names, in a few words (the search
 * panel used to carry them; owner 2026-11-22: the credit shows on floor 5 too). Only sources the layer's own credit text claims are named
 * (CelesTrak only with the status join), and an old snapshot says so, as the panel's short credit did.
 * @param {string} gcatCredit  realSky.credit
 * @param {string} [layerCredit]  RealSkyLayer.creditLine() (its full wording)
 * @returns {string}
 */
export function footerCredit(gcatCredit, layerCredit = '') {
  const t = String(layerCredit || '');
  const names = [];
  if (/Space-Track/i.test(t)) names.push('Space-Track');
  if (/CelesTrak/i.test(t)) names.push('CelesTrak');
  const old = t.match(/Snapshot (\d+) days old\./);
  const extra = [names.join(', '), old ? `snapshot ${old[1]} days old` : ''].filter(Boolean).join(' \u00b7 ');
  return extra ? `${gcatCredit} \u00b7 ${extra}` : String(gcatCredit);
}

export class SdaChart {
  /**
   * @param {function} [deps.now] - monotonic ms clock (tests); default performance.now
   * @param {import('../core/Typeface.js').FontEpoch} [deps.fontEpoch] - typeface epoch; one term of the frame signature, so a
   *   chart painted before the B612 faces settled repaints ONCE when they do. Tests inject their own.
   */
  constructor(deps = {}) {
    this._now = deps.now || _nowMs;
    this._fontEpoch = deps.fontEpoch || defaultFontEpoch;
    this._canvas = null;
    this._ctx2d = null;
    this._built = false;
    this._visible = false;
    this._buttonsRoot = null;
    /** @type {Map<string, HTMLElement>} lens -> its button (built with the canvas, browser only) */
    this._lensButtons = new Map();
    /** A press on a lens button calls this with 'VALUE' | 'THREAT' (SdaFloor sets it to its own setLens); unset: the chart's own. */
    this.onLens = null;
    this._lens = LENSES[0]; // VALUE — the arrival default (00-spec §3 F5)
    // Write-on-change state: last painted signature + paint clock.
    this._lastSig = null;
    this._lastPaintMs = -Infinity;
    /** Rasterizations actually performed (tests + probes). */
    this.paintCount = 0;
  }

  /** @returns {string} current lens ('VALUE' | 'THREAT') */
  getLens() { return this._lens; }

  /** Set the lens (endings land on THREAT; arrival resets to VALUE). Unknown values are ignored. */
  setLens(lens) {
    if (LENSES.includes(lens)) this._lens = lens;
    return this._lens;
  }

  /** Flip VALUE↔THREAT (the SDA 'flip-lens' Space verb). */
  flipLens() {
    this._lens = LENSES[(LENSES.indexOf(this._lens) + 1) % LENSES.length];
    return this._lens;
  }

  /**
   * Should render() rasterize this frame? Signature change → always; identical signature on the STEADY lens (VALUE) →
   * never; identical signature on THREAT (the pulse breathes) → at most every PULSE_TICK_MS, never per frame.
   */
  static shouldPaint(sig, lastSig, lens, nowMs, lastPaintMs) {
    if (sig !== lastSig) return true;
    if (lens !== 'THREAT') return false;
    return (nowMs - lastPaintMs) >= PULSE_TICK_MS;
  }

  /**
   * Frame signature: every input that changes the rasterized pixels except the THREAT pulse phase (time-gated instead).
   * `fontEpoch` (integer) is one term: a chart painted on the fallback face repaints once when the faces settle.
   * The real-sky terms (band mass, estimate flag, real count; the `rs` term) appear only when real data is present, so a
   * chart without it signs exactly as it always did and a chart that receives the file repaints.
   * @param {object} m - {lens, wPx, hPx, bands, outOfBand, timeline, riskFraction, fontEpoch, realSky}
   */
  static frameSig(m) {
    const bands = (m.bands || [])
      .map((b) => `${b.count}/${b.satCount}/${Math.round((b.liveMassT || 0) * 10)}`
        + (b.realCount != null ? `/r${b.realCount}/m${Math.round((b.massT || 0) * 10)}/${b.estimate ? 1 : 0}` : ''))
      .join('|');
    const rs = m.realSky ? `|rs${(m.realSky.beyond2000 && m.realSky.beyond2000.n) || 0}` : '';
    const sc = m.skyCredit ? `|sc${m.skyCredit}` : '';
    const oob = m.outOfBand ? `${m.outOfBand.count}` : '0';
    const proj = m.timeline && m.timeline.projection
      ? m.timeline.projection.map((p) => p.tracked).join(',')
      : '';
    const risk = Math.round((m.riskFraction || 0) * 100);
    const epoch = (typeof m.fontEpoch === 'number') ? m.fontEpoch : 0;
    return `${m.lens}|${m.wPx}x${m.hPx}|${bands}|${oob}|${proj}|r${risk}${rs}${sc}|e${epoch}`;
  }

  /** @private */
  _build() {
    if (this._built || typeof document === 'undefined' || !document.body) return;
    this._built = true;
    const canvas = document.createElement('canvas');
    canvas.id = 'ladder-sda-chart';
    // z-index 33: the SDA costume layer (the NAVCOM icon layer is hidden on the SDA floor; they never paint together).
    canvas.style.cssText = [
      'position:absolute', 'left:0', 'top:0', 'width:100%', 'height:100%',
      'pointer-events:none', 'z-index:33', 'opacity:0', 'transition:opacity 0.3s',
    ].join(';');
    document.body.appendChild(canvas);
    this._canvas = canvas;
    this._ctx2d = canvas.getContext ? canvas.getContext('2d') : null;
    this._buildLensButtons();
  }

  /**
   * @private The two lens buttons, real <button>s built like the air page's Sun buttons (AirChart): 46 px tall, the active one
   * highlighted, top left (nothing else lives there on page 1). They slide with the chart (the page row moves `elements()`) and show
   * only while the chart does. A press goes through `onLens` (SdaFloor.setLens) and then lets go of focus, so Space stays the flip.
   */
  _buildLensButtons() {
    const root = document.createElement('div');
    root.id = 'sda-lens-buttons';
    root.style.cssText = [
      'position:absolute', `left:${LENS_STACK_EDGE_PX}px`, `top:${LENS_STACK_EDGE_PX}px`, 'display:none', 'flex-direction:column', 'align-items:stretch', `gap:${LENS_STACK_GAP_PX}px`, 'z-index:36',
      'pointer-events:none', 'opacity:0', 'transition:opacity 0.3s', 'font-family:var(--font-mono)',
      'user-select:none', '-webkit-user-select:none',
    ].join(';');
    for (const b of LENS_BUTTONS) {
      const el = document.createElement('button');
      el.type = 'button';
      el.textContent = b.label;
      el.dataset.lens = b.lens;
      el.setAttribute('aria-pressed', 'false');
      el.tabIndex = -1;
      el.style.cssText = [
        'box-sizing:border-box', 'cursor:pointer', 'border-radius:6px', `color:${LENS_BTN_TEXT}`, 'font-family:inherit',
        'font-size:15px', 'touch-action:manipulation', 'padding:0 14px', `height:${LENS_BTN_H}px`, `min-width:${LENS_BTN_W}px`,
        'pointer-events:auto', '-webkit-tap-highlight-color:transparent',
      ].join(';');
      const press = (e) => {
        e.preventDefault(); e.stopPropagation();
        if (this.onLens) this.onLens(b.lens); else this.setLens(b.lens);
        this._syncLensButtons();
        if (typeof el.blur === 'function') el.blur();
      };
      el.addEventListener('click', press);
      // a touch or press on a button is the button's, never the page row's swipe or the globe's
      for (const type of ['touchstart', 'mousedown', 'pointerdown']) {
        el.addEventListener(type, (e) => { e.stopPropagation(); if (type === 'mousedown') e.preventDefault(); });
      }
      root.appendChild(el);
      this._lensButtons.set(b.lens, el);
    }
    document.body.appendChild(root);
    this._buttonsRoot = root;
    this._syncLensButtons();
  }

  /** @private Highlight the button of the current lens (also after Space flips it). */
  _syncLensButtons() {
    if (!this._buttonsRoot) return;
    for (const [lens, el] of this._lensButtons) {
      const on = lens === this._lens;
      if (el.dataset.on === (on ? '1' : '0')) continue;
      el.dataset.on = on ? '1' : '0';
      el.setAttribute('aria-pressed', on ? 'true' : 'false');
      el.style.background = on ? 'rgba(86, 116, 156, 0.55)' : 'rgba(30, 44, 66, 0.9)';
      el.style.border = on ? `2px solid ${LENS_BTN_TEXT}` : '1px solid rgba(150, 176, 206, 0.45)';
    }
  }

  /**
   * @private While page 1 shows: the radio notice goes to the top left and the "GEO means" toast above the strip. One attribute on <html>
   * and three variables feed two rules (`!important`: the box's inline width and the sky panel's dodge translate would win otherwise);
   * write-on-change; hide() / dispose() take it all away, so the globe has the box back at the top right.
   */
  _syncPageChrome(wPx, hPx) {
    if (typeof document === 'undefined' || !document.documentElement || !document.head || !this._visible) return;
    const de = document.documentElement;
    if (!document.getElementById(PAGE_STYLE_ID)) {
      const st = document.createElement('style');
      st.id = PAGE_STYLE_ID;
      st.textContent = `html[${PAGE_ATTR}] #hud-comms-panel { translate: var(--sda-notice-x) var(--sda-notice-y) !important; width: var(--sda-notice-w) !important; }`
        + ` html[${PAGE_ATTR}] #notification-zone { bottom: ${TOAST_BOTTOM_PX}px !important; }`;
      document.head.appendChild(st);
    }
    const p = noticePlacement(wPx, hPx);
    const key = `${Math.round(p.x)}|${Math.round(p.y)}|${Math.round(p.wCss)}`;
    if (this._pageKey === key && de.hasAttribute(PAGE_ATTR)) return;
    this._pageKey = key;
    de.style.setProperty('--sda-notice-x', `${Math.round(p.x)}px`);
    de.style.setProperty('--sda-notice-y', `${Math.round(p.y)}px`);
    de.style.setProperty('--sda-notice-w', `${Math.round(p.wCss)}px`);
    de.setAttribute(PAGE_ATTR, '');
  }

  /** @private Undo {@link SdaChart#_syncPageChrome}. */
  _clearPageChrome() {
    this._pageKey = '';
    if (typeof document === 'undefined' || !document.documentElement || !document.documentElement.removeAttribute) return;
    const de = document.documentElement;
    de.removeAttribute(PAGE_ATTR);
    for (const v of ['--sda-notice-x', '--sda-notice-y', '--sda-notice-w']) de.style.removeProperty(v);
  }

  isVisible() { return this._visible; }

  /** The chart's canvas (built on first use; null headless): the page row slides this node. */
  element() { this._build(); return this._canvas || null; }

  /** Every top-level node the page row slides: the canvas and the lens buttons (empty headless). */
  elements() { this._build(); return [this._canvas, this._buttonsRoot].filter(Boolean); }

  show() {
    this._build();
    this._visible = true;
    if (this._canvas) this._canvas.style.opacity = '1';
    if (this._buttonsRoot) {
      this._syncLensButtons();
      this._buttonsRoot.style.display = 'flex';
      this._buttonsRoot.style.opacity = '1';
    }
    // A re-show must repaint even into an unchanged world (the canvas may have been cleared on hide).
    this._lastSig = null;
  }

  hide() {
    this._visible = false;
    this._clearPageChrome();
    this._boxes = [];
    _setChartTextBoxes([]);
    if (this._buttonsRoot) { this._buttonsRoot.style.opacity = '0'; this._buttonsRoot.style.display = 'none'; }
    if (this._canvas) {
      this._canvas.style.opacity = '0';
      if (this._ctx2d) this._ctx2d.clearRect(0, 0, this._canvas.width, this._canvas.height);
    }
  }

  /**
   * Compute one chart frame and rasterize it iff the write-on-change gate passes. Headless (no canvas) the computation
   * is identical, `painted` is false and `wouldPaint` still reports the gate decision.
   * @param {Array}  m.bands       - aggregateBands().bands
   * @param {object} [m.outOfBand] - aggregateBands().outOfBand
   * @param {object} [m.timeline]  - buildTimeline() result
   * @param {number} [m.riskFraction=0] - live KesslerSystem cascade risk 0..1
   * @param {number} [m.wPx] [m.hPx]    - viewport (default window / 1280×720)
   * @returns {{lens:string, map:object, weights:number[], rings:Array,
   *            labels:Array, timeline:object|null, compressed:boolean,
   *            wouldPaint:boolean, painted:boolean, sig:string}}
   */
  render(m = {}) {
    const lens = this._lens;
    this._syncLensButtons(); // Space may have flipped the lens since the last frame
    const wPx = m.wPx || ((typeof window !== 'undefined') ? window.innerWidth : 1280);
    const hPx = m.hPx || ((typeof window !== 'undefined') ? window.innerHeight : 720);
    const bands = m.bands || [];
    const map = meoRadialMap({ wPx, hPx });
    const weights = lensWeights(bands, lens);

    const rings = bands.map((b, i) => {
      const ring = {
        id: `band-${b.altKm[0]}`,
        altKm: b.altKm,
        innerPx: radiusPxForAltKm(map, b.altKm[0]),
        outerPx: radiusPxForAltKm(map, b.altKm[1]),
        weight: weights[i],
        count: b.count,
        massT: b.massT,
        liveMassT: b.liveMassT,
        estimate: b.estimate,
      };
      if (b.realCount != null) { // GCAT real numbers for this band (aggregateBands, realSky)
        ring.realCount = b.realCount;
        ring.realNotWorking = b.realNotWorking;
      }
      return ring;
    });
    const realSky = m.realSky || null;

    // Named world-label candidates (the budget applies): the bands (lens-weighted), the GEO gold ring, the strip title.
    const gold = FloorContract.MASS_BANDS.REGIMES
      .filter((r) => r.gold)
      .reduce((a, r) => a + r.massT, 0); // 4,384 t belt+graveyard
    const candidates = rings.map((r, i) => ({
      id: r.id,
      weight: weights[i],
      text: lens === 'VALUE'
        ? `${_thousands(r.altKm[0])}\u2013${_thousands(r.altKm[1])} km \u00b7 ${_thousands(r.massT + r.liveMassT)} t${r.estimate ? ' \u00b7 est.' : ''}`
        : (r.realCount != null
          ? `${_thousands(r.altKm[0])}\u2013${_thousands(r.altKm[1])} km \u00b7 ${_thousands(r.realNotWorking)} of ${_thousands(r.realCount)} not working`
          : `${_thousands(r.altKm[0])}\u2013${_thousands(r.altKm[1])} km \u00b7 ${_thousands(r.count)} ${r.count === 1 ? 'object' : 'objects'}`),
      rPx: (r.innerPx + r.outerPx) / 2,
    }));
    candidates.push({
      id: 'geo-ring',
      weight: lens === 'VALUE' ? 1.01 : 0.5, // the gold ring headlines VALUE
      text: `36,000 km ring + graveyard \u00b7 ${_thousands(gold)} t`,
      rPx: map.geoPx,
    });
    candidates.push({
      id: 'kessler-strip',
      weight: lens === 'THREAT' ? 1.01 : 0.4, // the timeline headlines THREAT
      text: STRIP_TITLE,
      rPx: 0,
    });
    // Nothing sits at the top right of page 1 to avoid (the search panel is gone; the radio notice is at the top left here): the column
    // stands where the rings put it.
    const labels = layoutLabels(rankLabels(candidates, FLOOR.labelBudget), hPx / 2, LABEL_MIN_GAP_PX, LABEL_TOP_PX,
      map.leoTopPx, null);
    this._syncPageChrome(wPx, hPx);

    const timeline = m.timeline || null;
    const sig = SdaChart.frameSig({
      lens, wPx, hPx, bands,
      outOfBand: m.outOfBand, timeline, riskFraction: m.riskFraction,
      fontEpoch: this._fontEpoch.value(), realSky, skyCredit: m.skyCredit || '',
    });
    const now = this._now();
    const wouldPaint = SdaChart.shouldPaint(sig, this._lastSig, lens, now, this._lastPaintMs);

    let painted = false;
    if (wouldPaint && this._canvas && this._ctx2d && this._visible) {
      this._paint({ wPx, hPx, lens, map, rings, labels, timeline, outOfBand: m.outOfBand, realSky, skyCredit: m.skyCredit || '', now });
      painted = true;
    }
    if (wouldPaint) {
      // The gate advances on the DECISION so headless tests pin the cadence the browser sees.
      this._lastSig = sig;
      this._lastPaintMs = now;
    }

    return {
      lens, map, weights, rings, labels, timeline,
      compressed: map.compressed, wouldPaint, painted, sig,
    };
  }

  /** @private Paint the whole chart. */
  _paint(f) {
    const g = this._ctx2d;
    const canvas = this._canvas;
    const { wPx: w, hPx: h, lens, map, rings, labels, timeline, now } = f;
    this.paintCount++;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    g.clearRect(0, 0, w, h);
    this._boxes = [];
    const cx = w / 2, cy = h / 2;
    const ramp = lens === 'VALUE' ? VisualLaw.COLORS.VALUE : VisualLaw.COLORS.THREAT;
    // THREAT ALWAYS pulses (VisualLaw); phase quantized by the paint gate.
    const pulse = lens === 'THREAT'
      ? 0.75 + 0.25 * Math.sin((now % PULSE_PERIOD_MS) / PULSE_PERIOD_MS * Math.PI * 2)
      : 1;

    // Earth: chart-blue flat disc — an overlay; the real Earth mesh is untouched.
    const rEarth = Constants.EARTH_RADIUS * map.sLeoPxPerU;
    g.beginPath();
    g.arc(cx, cy, rEarth, 0, Math.PI * 2);
    g.fillStyle = CHART_EARTH_BLUE;
    g.fill();

    for (const r of rings) {
      g.beginPath();
      g.arc(cx, cy, r.outerPx, 0, Math.PI * 2);
      g.arc(cx, cy, r.innerPx, 0, Math.PI * 2, true);
      g.fillStyle = this._rgba(ramp, (0.06 + 0.30 * r.weight) * pulse);
      g.fill();
      g.beginPath();
      g.arc(cx, cy, r.outerPx, 0, Math.PI * 2);
      g.strokeStyle = CHART_GRID;
      g.lineWidth = 1;
      g.stroke();
    }

    // GEO ring at the screen edges: gold, dashed, STEADY on both lenses.
    g.beginPath();
    g.arc(cx, cy, map.geoPx, 0, Math.PI * 2);
    g.setLineDash([6, 6]);
    g.strokeStyle = this._rgba(VisualLaw.COLORS.VALUE, lens === 'VALUE' ? 0.9 : 0.4);
    g.lineWidth = lens === 'VALUE' ? 2 : 1;
    g.stroke();
    g.setLineDash([]);

    g.font = mono(10);
    g.textAlign = 'left';
    for (const l of labels) {
      if (l.id === 'kessler-strip') continue; // painted with the strip below
      g.fillStyle = this._rgba(ramp, 0.95);
      if (l.leader) { // column label: a thin leader from its own ring (same colour as the label), a dot where it leaves the ring
        g.beginPath();
        g.moveTo(cx + l.ringX, l.ringY);
        g.lineTo(cx + l.x - 3, l.y - 4);
        g.strokeStyle = this._rgba(ramp, 0.95);
        g.lineWidth = 1;
        g.stroke();
        g.beginPath();
        g.arc(cx + l.ringX, l.ringY, 1.5, 0, Math.PI * 2);
        g.fill();
      }
      this._text(g, l.text, cx + l.x, l.y);
    }

    // The colour key: one line above the label column, each half in its dot's colour (what the ring dots mean now that the panel's key is gone).
    const column = labels.filter((l) => l.leader);
    if (column.length) {
      const kx = cx + column[0].x, ky = Math.min(...column.map((l) => l.y)) - KEY_ABOVE_PX;
      g.textAlign = 'left';
      g.globalAlpha = 0.95;
      g.fillStyle = KEY_WARM.color;
      this._text(g, KEY_WARM.text, kx, ky);
      const m1 = typeof g.measureText === 'function' ? g.measureText(KEY_WARM.text) : null;
      const w1 = m1 && Number.isFinite(m1.width) ? m1.width : KEY_WARM.text.length * 6.1;
      g.fillStyle = KEY_COOL.color;
      this._text(g, KEY_COOL.text, kx + w1 + 14, ky);
      g.globalAlpha = 1;
    }

    // Honesty chrome (not world labels): the scale tag + ESTIMATE provenance.
    g.textAlign = 'center';
    g.fillStyle = VisualLaw.COLORS.INFO;
    g.globalAlpha = 0.8;
    const realSky = f.realSky || null;
    // Objects beyond the LEO shells are counted, never silently dropped: in the top caption with the scale tag (Sky 19; it was bottom right).
    const topKm = rings.length ? rings[rings.length - 1].altKm[1] : 2000;
    let far = '';
    if (realSky && realSky.beyond2000 && Number.isFinite(realSky.beyond2000.n)) far = `${_thousands(realSky.beyond2000.n)} tracked out there`;
    else if (f.outOfBand && f.outOfBand.count > 0) far = `${_thousands(f.outOfBand.count)} ${f.outOfBand.count === 1 ? 'object' : 'objects'} out there`;
    if (map.compressed) this._text(g, far ? `${FLOOR.chart.compressionTag} \u00b7 ${far}` : FLOOR.chart.compressionTag, cx, CHART_TOP_CLEAR_PX);
    else if (far) this._text(g, `beyond ${_thousands(topKm)} km: ${far}`, cx, CHART_TOP_CLEAR_PX);
    if (lens === 'VALUE') {
      // The estimate line stays only while some band still shows an estimate (a real band has none).
      if (rings.some((r) => r.estimate)) this._text(g, NOTE_ESTIMATES, cx, CHART_TOP_CLEAR_PX + 14);
    } else {
      this._text(g, NOTE_THREAT, cx, CHART_TOP_CLEAR_PX + 14);
    }
    // Real numbers need their credit (CC BY 4.0): ONE line at the very bottom centre, both lenses, with the sources the search panel
    // used to name (Space-Track, CelesTrak; Sky 19). The page title and dots stand above it (h-56 and up).
    if (realSky && typeof realSky.credit === 'string' && realSky.credit) {
      g.textAlign = 'center';
      this._text(g, footerCredit(realSky.credit, f.skyCredit), cx, h - 7);
    }
    g.globalAlpha = 1;

    if (timeline) this._paintStrip(g, w, h, lens, timeline, labels, pulse);
    _setChartTextBoxes(this._boxes);
  }

  /** @private fillText that also records the string's box (the glyphs sit about 8 px above the baseline, 3 px of descender). */
  _text(g, s, x, y) {
    const str = String(s);
    const m = typeof g.measureText === 'function' ? g.measureText(str) : null;
    const w = m && Number.isFinite(m.width) ? m.width : str.length * 6.1;
    const left = g.textAlign === 'center' ? x - w / 2 : (g.textAlign === 'right' || g.textAlign === 'end') ? x - w : x;
    if (this._boxes) this._boxes.push({ text: str, x: left, y: y - 9, w, h: 12 });
    g.fillText(str, x, y);
  }

  /**
   * @private The timeline strip along the bottom. The count axis is logarithmic (each gridline is 10 times the one under it, STRIP_LOG_MIN
   * at the bottom; the 1957 start of zero sits on that line), so 1957-2026 is a readable climb next to the forecast. The history is a
   * solid line; the forecast after "today" (the last keyframe year) is dashed and fainter than the history.
   */
  _paintStrip(g, w, h, lens, timeline, labels, pulse) {
    const x0 = w * 0.08, x1 = w * 0.92;
    const y0 = h - STRIP_TOP_FROM_BOTTOM_PX, y1 = h - STRIP_BOTTOM_FROM_BOTTOM_PX;
    const hist = timeline.history || [];
    const proj = timeline.projection || [];
    if (!hist.length && !proj.length) return;
    const years = [...hist.map((p) => p.year), ...proj.map((p) => p.year)];
    const counts = [...hist.map((p) => p.tracked), ...proj.map((p) => p.tracked)];
    const yr0 = Math.min(...years), yr1 = Math.max(...years);
    const cMax = Math.max(...counts, 1);
    const decades = Math.max(1, Math.ceil(Math.log10(cMax / STRIP_LOG_MIN) - 1e-9));
    const today = Number.isFinite(timeline.baseYear) ? timeline.baseYear : (hist.length ? hist[hist.length - 1].year : yr0);
    const X = (yr) => x0 + ((yr - yr0) / Math.max(1, yr1 - yr0)) * (x1 - x0);
    const Y = (n) => y1 - (Math.log10(Math.max(n, STRIP_LOG_MIN) / STRIP_LOG_MIN) / decades) * (y1 - y0);

    g.strokeStyle = CHART_GRID;
    g.lineWidth = 1;
    for (let k = 0; k <= decades; k++) { // one faint line per ten-fold step of the count
      const y = Y(STRIP_LOG_MIN * Math.pow(10, k));
      g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
    }
    for (let yr = Math.ceil(yr0 / 10) * 10; yr <= yr1; yr += 10) {
      g.beginPath(); g.moveTo(X(yr), y1); g.lineTo(X(yr), y1 + STRIP_TICK_PX); g.stroke();
    }

    g.strokeStyle = VisualLaw.COLORS.INFO;
    g.beginPath();
    hist.forEach((p, i) => { const x = X(p.year), y = Y(p.tracked); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); });
    g.stroke();
    for (const p of hist) {
      if (!p.event) continue;
      g.fillStyle = VisualLaw.COLORS.THREAT;
      g.beginPath(); g.arc(X(p.year), Y(p.tracked), 2.5, 0, Math.PI * 2); g.fill();
    }

    // The forecast: dashed, fainter than the history on the VALUE lens, brighter on THREAT (which pulses it).
    g.strokeStyle = this._rgba(VisualLaw.COLORS.THREAT, (lens === 'THREAT' ? 0.95 : 0.5) * pulse);
    g.setLineDash([5, 4]);
    g.beginPath();
    proj.forEach((p, i) => { const x = X(p.year), y = Y(p.tracked); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); });
    g.stroke();
    g.setLineDash([]);

    // "today": a thin dashed upright at the year the history ends and the forecast starts.
    g.strokeStyle = this._rgba(VisualLaw.COLORS.INFO, 0.55);
    g.setLineDash([2, 3]);
    g.beginPath(); g.moveTo(X(today), y0); g.lineTo(X(today), y1); g.stroke();
    g.setLineDash([]);

    const title = labels.find((l) => l.id === 'kessler-strip');
    g.font = mono(10);
    if (title) {
      g.textAlign = 'left';
      g.fillStyle = this._rgba(lens === 'THREAT' ? VisualLaw.COLORS.THREAT : VisualLaw.COLORS.INFO, 0.95);
      this._text(g, title.text, x0, y0 - 6);
    }
    g.fillStyle = VisualLaw.COLORS.INFO;
    g.globalAlpha = 0.8;
    g.textAlign = 'right';
    this._text(g, STRIP_SCALE_NOTE, x1, y0 - 6);
    g.textAlign = 'right'; // left of its line: centred, it touched the page title on the iPad (visual check 2026-11-22)
    this._text(g, `today ${today}`, X(today) - 4, y0 - 6);
    g.globalAlpha = 0.7;
    g.textAlign = 'center';
    for (let yr = Math.ceil(yr0 / 20) * 20; yr <= yr1; yr += 20) this._text(g, String(yr), X(yr), y1 + STRIP_LABEL_DROP_PX);
    g.globalAlpha = 1;
  }

  _rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return `rgba(${r}, ${g}, ${b}, ${clamp01(a)})`;
  }

  dispose() {
    this._clearPageChrome();
    if (this._canvas && this._canvas.remove) this._canvas.remove();
    if (this._buttonsRoot && this._buttonsRoot.remove) this._buttonsRoot.remove();
    this._buttonsRoot = null;
    this._lensButtons = new Map();
    this._canvas = null;
    this._ctx2d = null;
    this._built = false;
    this._visible = false;
    this._boxes = [];
    _setChartTextBoxes([]);
    this._lastSig = null;
    this._lastPaintMs = -Infinity;
  }
}
