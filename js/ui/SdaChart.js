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
import { ReentryShow, YEAR_LINE, YEAR_LINE_FROM_BOTTOM_PX, YEAR_LINE_FONT_PX } from './ReentryShow.js';
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
 * Sky 20 (owner 2026-11-23: "move 'objects in orbit' pane to bottom to improve view of debris"): the timeline strip moved down, so the LEO
 * ring may grow until its bottom edge is this far above the screen bottom (the strip's top label row glyphs then ended at h-191, plus 10 px of air).
 * The ring still never shrinks below LEO_VFRAC of the half-height. Both numbers are in `meoRadialMap`.
 * Sky 31 (DECISIONS §103 row 1): the strip is at the very bottom now (h-99..h-14) and the page dots stand over it (hit boxes h-148..h-100), so 201 would not
 * be needed any more. It stays 201 on purpose: the real Earth under the chart (`chartEarthDistU`) and every ring keep their size on both screens
 * (§102 row 11: "the chart is not made bigger for its own sake"); the ring's bottom edge is 53 px over the dots' hit boxes.
 */
export const RING_BOTTOM_RESERVE_PX = 201;

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

/** Chart chrome colors (the SDA chart costume, not VisualLaw semantics). Sky 30: no flat Earth disc any more, the real turning globe shows (`chartEarthDistU`). */
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

/** Danger view (Sky 31, §102 row 12 "Danger also reddens the heights where crashes are most likely"): a band at or over this share of the strongest band's danger stands out. */
export const HOT_BAND_MIN_WEIGHT = 0.6;
/** At most this many bands stand out (the top one or two). */
export const HOT_BAND_MAX = 2;
/**
 * The bands that stand out in the Danger view: the most crash-prone heights, strongest first - the top band always (when any has danger), the second only when it is
 * close (at least HOT_BAND_MIN_WEIGHT of the top). Measured 2026-11-25 with the real counts: the 400-600 km band is 1.0, the next two 0.35 and 0.33, so one stands out.
 * @param {Array<{id:string, weight:number}>} rings
 * @returns {string[]} ring ids
 */
export function hotBandIds(rings) {
  const list = (Array.isArray(rings) ? rings : []).filter((r) => r && r.weight > 0).slice().sort((a, b) => b.weight - a.weight);
  const out = [];
  for (const r of list) {
    if (out.length >= HOT_BAND_MAX) break;
    if (out.length === 0 || r.weight >= HOT_BAND_MIN_WEIGHT) out.push(r.id);
  }
  return out;
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

  const leoTopPx = Math.max((h / 2) * LEO_VFRAC, h / 2 - RING_BOTTOM_RESERVE_PX);
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
 * Where the camera must stand so the real, turning Earth under the chart fills the chart's Earth circle (Sky 30, owner 2026-11-24, DECISIONS §102 row 11:
 * "the real globe fills the centre circle exactly"). The chart's circle is `rEarth = EARTH_RADIUS * map.sLeoPxPerU` px about the screen's centre; a sphere of
 * radius R seen from distance d on the view axis (the camera aims at Earth's centre) has the angular radius asin(R/d), and a perspective camera of vertical
 * field of view `fov` over a viewport `hPx` tall draws it with the radius (hPx/2) * tan(asin(R/d)) / tan(fov/2) px. Solved for d: with t = rEarth * tan(fov/2) / (hPx/2),
 * d = R * sqrt(1 + 1/t^2). Pure; page 1's camera distance on both screens and after a resize (CameraSystem, LadderController `_frame`).
 * @param {number} wPx @param {number} hPx - viewport (CSS px)
 * @param {number} fovDeg - the camera's vertical field of view, degrees
 * @returns {number} distance from Earth's centre, scene units
 */
export function chartEarthDistU(wPx, hPx, fovDeg) {
  const map = meoRadialMap({ wPx, hPx });
  const R = Constants.EARTH_RADIUS;
  const rEarthPx = R * map.sLeoPxPerU;
  const t = rEarthPx * Math.tan((fovDeg * Math.PI) / 360) / (Math.max(1, hPx) / 2);
  return R * Math.sqrt(1 + 1 / (t * t));
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
 * covered y 8-43 at the top centre (measured at 1728x1117 and 1366x1024: x 689-1039 / 508-858), so the "MEO compressed" tag,
 * its caveat line and the GEO ring label start below it, one 14 px row apart. Sky 20 (2026-11-23): the page's title stands there now
 * (PageRow TITLE_TOP_PX 14, line box 32 px tall: bottom y 46), so the first line's glyphs (tops 9 px over the baseline: y 53) still clear it.
 */
export const CHART_TOP_CLEAR_PX = 62;
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
 * so the strip's bottom was 150 (ticks end at h-146, the 20-year labels' baseline h-135, descenders h-132: 8 px above the title's glyphs)
 * and its top 202 (the plot was 52 px tall).
 * 2026-11-23 (Sky 20, owner: the strip to the bottom, "just above the page dots"): the page title left for the top centre, so only the dots
 * (hit boxes h-104..h-56, circles h-80 +-5) stand at the bottom now. The strip's bottom is 124 (ticks end at h-120, the 20-year labels'
 * baseline h-109, descenders h-106: 2 px above the dots' hit boxes) and its top 176 (the plot stays 52 px tall; the top label row's glyphs
 * run h-191..h-179). One line of credit used to stand under the dots: it is in the Tech library now.
 * 2026-11-25 (Sky 31, owner 2026-11-24 22:03Z, DECISIONS §103 row 1: "move the 'object in orbit' pane to bottom left. below screen indicator"): the strip is now the lowest
 * thing on the page and the page dots stand over it. Its bottom is 32 (the plot's bottom edge; the decade ticks end at h-28, the 20-year labels' baseline h-17 and
 * their descenders h-14, so the text ends 14 px over the screen's bottom, in the 12-16 px asked) and its top 84 (the plot stays 52 px tall; the title row's glyph tops
 * are 15 px over the top edge: h-99). The dots' hit boxes run h-148..h-100 (PageRow DOTS_BOTTOM_PX 100 + DOT_TARGET_PX 48): they stand 1 px over the title row's glyph tops.
 * The safe-area inset at the bottom (an iPad's home bar) lifts both by the same amount (`stripRect`'s `safeBottom`, PageRow's CSS `env()`).
 */
export const STRIP_TOP_FROM_BOTTOM_PX = 84;
export const STRIP_BOTTOM_FROM_BOTTOM_PX = 32;
/** Decade ticks hang this far under the strip's bottom edge. */
export const STRIP_TICK_PX = 4;
/** The 20-year labels' baseline, px under the strip's bottom edge. */
export const STRIP_LABEL_DROP_PX = 15;

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
/**
 * The height labels' size (Sky 30, owner 2026-11-24, DECISIONS §102 row 9: "double the size of the weight numbers"). They were 10 px (`mono(10)`); twice that is 20 px,
 * and the iPad's least is 18, so one size serves both screens. The 36,000 km label is LABEL_GEO_FONT_PX.
 */
export const LABEL_FONT_PX = 20;
export const LABEL_GEO_FONT_PX = 16;
/**
 * The five height labels stand in ONE column at the UPPER LEFT, highest band on top (Sky 30, §102 row 9: "move numbers and call out high to point at top of globe
 * where layers are easier to see vertical"; before, Sky 23, they stood in a column left of the ring's 9 o'clock side). The text is left-aligned, COLUMN_LEFT_PX from the
 * screen's left edge, the rows COLUMN_ROW_GAP_PX apart (baseline to baseline: 1.7 lines of 20 px). Each label has ONE straight leader from just after its text to its own
 * band at the TOP of the ring (12 o'clock, x = the centre, where the bands stack one above the other). The rows and the band points keep the same order (highest first), so
 * no two leaders cross and, being almost level, none passes through another label. The block is centred on the mean height of the band points, but never higher than
 * the colour key's row under the lens buttons and the radio notice.
 */
export const COLUMN_LEFT_PX = 24;
/** Rows of the column stand this far apart (baseline to baseline), px. */
export const COLUMN_ROW_GAP_PX = 34;
/** The gap between the text's end and the start of its leader, px. */
export const LEADER_GAP_PX = 8;
/** A leader meets the glyphs' middle: this far above the baseline (20 px digits are about 14 px tall). */
export const LEADER_RISE_PX = 7;
/** A guess of the widest column row, px: only where an avoid box is tested (the layout is pure and measures no text). */
const COLUMN_W_GUESS_PX = 420;
/**
 * Clearance the column keeps from the ring's outer edge, px (Sky 30 fix, review of the labels): at each row's height every label's right end and its leader's turn point stand at
 * least this far left of the ring. When one-line labels do not fit (before Sky 31's one-height labels the iPad's Danger view: "400-600 km \u00b7 512 of 1,800 not working" reached the ring at the bottom rows; "400 km \u00b7 115 of 1,864 not working" is shorter) the
 * labels wrap at the "\u00b7" into two lines (the span, then the count), COLUMN_LINE_PX apart; the leader leaves the first line. The choice is per screen and lens, never per row.
 */
export const RING_CLEAR_PX = 8;
/** Baseline to baseline of a wrapped label's two lines, px (the 20 px line's text box is 24 px tall: the two boxes touch, never overlap). */
export const COLUMN_LINE_PX = 24;
/** Two leaders' end points on the ring's top stay at least this far apart, px (the bands are thin on the iPad: 7.4 px between two middles before). */
export const LEADER_END_GAP_PX = 8;
/** What the layout aims at, so rounding never leaves 7.999...: the bound itself stays LEADER_END_GAP_PX. */
const LEADER_END_AIM_PX = LEADER_END_GAP_PX + 1e-6;
/** Glyph tops stand this far over a 20 px baseline, and descenders this far under it (the box `_text` records is 0.9 / 0.3 of the size). */
const GLYPH_UP_PX = 0.9 * LABEL_FONT_PX;
const GLYPH_DOWN_PX = 0.3 * LABEL_FONT_PX;
/** Backing plate behind the column and the key (the 36,000 km label's own plate colour), and its padding, px: the dashed 36,000 km ring never cuts through the text. */
export const PLATE_FILL = 'rgba(2, 6, 12, 0.78)';
export const PLATE_PAD_PX = 5;
/**
 * The colour key above the label column (Sky 19: the search / tick-box panel and its key are not on page 1 any more): one short line,
 * each half drawn in its own colour. Ring dots are warm (orange) for debris, rocket stages and dead satellites and grey-blue for working,
 * "no report" (Sky 32: was "sat") and unknown ones (RealSkyCard CLASS_COLORS, the colours RealSkyLayer's floor-5 canvas fills with). It stands this far above the
 * column's first label baseline (the 20 px row's glyph tops are 15 px over its baseline, the key's descenders 3 px under its own).
 */
export const KEY_ABOVE_PX = 26;
export const KEY_WARM = { text: '\u25cf debris, stage, dead', color: CLASS_COLORS[1] };
export const KEY_COOL = { text: '\u25cf working, no status, unknown', color: CLASS_COLORS[3] };
/** Width of one 10 px label when there is no canvas to measure it (the face is about 6.1 px a glyph). */
const GLYPH_PX = 6.6;

/** The 36,000 km label's first line (its second line is the gold tonnes, "4,384 tonnes"). */
export const GEO_LABEL_LINE1 = '36,000 km ring + graveyard';

/**
 * One band's label, in plain words (Sky 30, §102 row 9; Sky 31, §103 row 2: "A number is better than a range"): ONE height, the band's top, so "400 km \u00b7 894 tonnes" for the
 * 180-400 km band, then 600, 800, 1,000 and 2,000 km. Tonnes: where the mass is an estimate "about 6,100 tonnes" (the sum rounded to the nearest 100 t; it replaces the old
 * "\u00b7 est."). Danger: the count, or "N of M not working" where the real catalogue gave both.
 * @param {string} lens 'VALUE' | 'THREAT'
 * @param {{altKm:number[], massT:number, liveMassT:number, estimate?:boolean, count:number, realCount?:number, realNotWorking?:number}} r
 * @returns {string}
 */
export function bandLabelText(lens, r) {
  const span = `${_thousands(r.altKm[1])} km`;
  if (lens === 'VALUE') {
    const t = r.massT + r.liveMassT;
    return r.estimate ? `${span} \u00b7 about ${_thousands(Math.round(t / 100) * 100)} tonnes` : `${span} \u00b7 ${_thousands(t)} tonnes`;
  }
  if (r.realCount != null) return `${span} \u00b7 ${_thousands(r.realNotWorking)} of ${_thousands(r.realCount)} not working`;
  return `${span} \u00b7 ${_thousands(r.count)} ${r.count === 1 ? 'object' : 'objects'}`;
}

/**
 * Lay the ring labels out so no two text boxes overlap. The band labels (ids `band-...`) stand in ONE column at the upper left (see COLUMN_LEFT_PX), highest band first at
 * `minGap` spacing. Each has a straight leader from its text's end to its band at the top of the ring: `ringX` 0 (the centre), `ringY` = the centre height less the
 * label's `rPx` (the middle of the band). When the block would meet a box over it (`avoid`: {x0, x1, y0, y1} as offsets from the centre/top) it goes above that box, or
 * under it when there is no room above. The block never starts above the colour key's lowest row (under the lens buttons). Any other label (the strip title) passes
 * through untouched; the GEO ring's label is placed by `geoLabelPlacement`, not here. The input is not mutated.
 * @param {Array<{id:*, rPx:number, text?:string}>} labels
 * @param {number} cy - chart centre y, px
 * @param {number} [minGap] - rows' spacing
 * @param {number} [minY]     - first baseline any label may use
 * @param {number} [cxPx]  - chart centre x, px (the column's left edge is COLUMN_LEFT_PX from the screen's left: offset COLUMN_LEFT_PX - cxPx)
 * @param {{x0:number,x1:number,y0:number,y1:number}|null} [avoid] - a rectangle the column must not touch (x from the centre, y from the top)
 * @param {function(string):number} [measure] - text width at LABEL_FONT_PX (default: a glyph guess)
 * @param {number} [ringPx] - the outer LEO ring's radius, px (default 0: no ring to keep clear of, labels stay on one line). With it, every label's right end and its leader's turn
 *   point stay RING_CLEAR_PX left of the ring's edge at their own height; when one line each does not fit, ALL the labels wrap at the "\u00b7" into two lines.
 * @returns {Array<object>} each label plus `x` (the text's LEFT end, offset from the centre; `align` is 'left'), `y` (first line's baseline), `lines` (the text's one or two lines;
 *   the second stands COLUMN_LINE_PX under the first), `ringX` / `ringY` (leader end: x from the centre, y from the top; the band's middle, spread so neighbours are LEADER_END_GAP_PX apart),
 *   `leaderX` / `leaderY` (leader start, at the first line), `elbowX` (where its level run turns toward the band: x from the centre; the same for every row), `leader`
 */
export function layoutLabels(labels, cy, minGap = COLUMN_ROW_GAP_PX, minY = LABEL_TOP_PX, cxPx = 0, avoid = null, measure = null, ringPx = 0) {
  const width = typeof measure === 'function' ? measure : (t) => String(t || '').length * GLYPH_PX * (LABEL_FONT_PX / 10);
  const out = labels.map((l) => {
    const ringY = cy - l.rPx;
    return { ...l, x: 8, y: Math.max(minY, ringY - 3), ringX: 0, ringY, leader: false };
  });
  const bands = out.filter((l) => String(l.id).startsWith('band-')).sort((a, b) => b.rPx - a.rPx);
  if (!bands.length) return out;
  const left = COLUMN_LEFT_PX - cxPx;
  const meanEnd = bands.reduce((a, l) => a + (cy - l.rPx), 0) / bands.length;
  // Under the lens buttons (bottom LENS_STACK_EDGE_PX + 2 * LENS_BTN_H + LENS_STACK_GAP_PX) and the radio notice beside them: the key's baseline is 24 px under their bottom edge.
  const keyMin = LENS_STACK_EDGE_PX + 2 * LENS_BTN_H + LENS_STACK_GAP_PX + 24;
  const keyH = KEY_ABOVE_PX + 15;                                  // the key's glyph tops over the first row's baseline
  const linesOf = (l, wrap) => {
    const text = String(l.text || ''), cut = text.indexOf(' \u00b7 ');
    return wrap && cut > 0 ? [text.slice(0, cut), text.slice(cut + 3)] : [text];
  };
  // Where the block goes for one line count: centred on the band points, above or under an avoid box, never higher than the key's row.
  const plan = (wrap) => {
    const pitch = wrap ? minGap + COLUMN_LINE_PX : minGap;
    const tail = wrap ? COLUMN_LINE_PX : 0;                        // the last label's second line
    const span = (bands.length - 1) * pitch + tail;
    let top = meanEnd - span / 2;                                  // first row's baseline
    if (avoid) {
      // A box over the column (an open card stands left of the ring only on a narrow screen): the block goes above it when it fits, else under it.
      const right = left + COLUMN_W_GUESS_PX;
      const blockTop = top - keyH, blockBottom = top + span + 4;
      if (left < avoid.x1 && right > avoid.x0 && blockBottom > avoid.y0 && blockTop < avoid.y1) {
        const above = avoid.y0 - 6 - 4 - span;
        top = above >= keyMin + KEY_ABOVE_PX ? above : avoid.y1 + 6 + keyH;
      }
    }
    return { pitch, top: Math.max(top, keyMin + KEY_ABOVE_PX, minY) };
  };
  // The ring's outer edge, x from the centre, over a vertical stretch [y0, y1] (the edge is furthest left at the stretch's end nearest the centre height; none above the ring's top).
  const ringEdge = (y0, y1) => {
    if (!(ringPx > 0)) return Infinity;
    const dy = y0 <= cy && cy <= y1 ? 0 : Math.min(Math.abs(y0 - cy), Math.abs(y1 - cy));
    return dy >= ringPx ? Infinity : -Math.sqrt(ringPx * ringPx - dy * dy);
  };
  const elbowFor = (wrap) => Math.max(...bands.flatMap((l) => linesOf(l, wrap).map((t) => left + width(t)))) + LEADER_GAP_PX + 12;
  const fits = (wrap) => {
    const { pitch, top } = plan(wrap), elbow = elbowFor(wrap);
    return bands.every((l, k) => {
      const y = top + k * pitch;
      if (elbow > ringEdge(y - LEADER_RISE_PX, y - LEADER_RISE_PX) - RING_CLEAR_PX) return false;
      return linesOf(l, wrap).every((t, j) => {
        const b = y + j * COLUMN_LINE_PX;
        return left + width(t) <= ringEdge(b - GLYPH_UP_PX, b + GLYPH_DOWN_PX) - RING_CLEAR_PX;
      });
    });
  };
  const wrap = ringPx > 0 && !fits(false) && bands.some((l) => linesOf(l, true).length === 2);
  const { pitch, top } = plan(wrap);
  // One common elbow right of the longest line: every leader runs level from its first line's end to the elbow, then straight to its band. The starts of the slanting parts
  // share one x and keep the rows' order, as do their ends (the ring's top, one band above the next): so no two leaders cross, and none reaches into another row's text.
  const elbowX = elbowFor(wrap);
  // The band points (the middles, highest band first = smallest y first), spread so neighbours are at least LEADER_END_GAP_PX apart.
  const ends = bands.map((l) => cy - l.rPx);
  for (let pass = 0; pass < 60; pass++) {
    let moved = false;
    for (let i = 1; i < ends.length; i++) {
      const d = LEADER_END_AIM_PX - (ends[i] - ends[i - 1]);
      if (d > 1e-9) { ends[i - 1] -= d / 2; ends[i] += d / 2; moved = true; }
    }
    if (!moved) break;
  }
  bands.forEach((l, k) => {
    l.x = left;
    l.align = 'left';
    l.y = top + k * pitch;
    l.lines = linesOf(l, wrap);
    l.leader = true;
    l.leaderX = left + width(l.lines[0]) + LEADER_GAP_PX;
    l.elbowX = elbowX;
    l.leaderY = l.y - LEADER_RISE_PX;
    l.ringX = 0;                                                   // the top of the ring: x = the centre
    l.ringY = ends[k];                                             // the middle of the band (nudged under 1 px at most), where the bands stack vertically
  });
  return out;
}

/** The 36,000 km label's height under the screen's middle, and the dark plate's padding around its text, px. */
export const GEO_LABEL_DY_PX = 120;
export const GEO_LABEL_PAD_PX = 8;

/**
 * The 36,000 km ring's label sits ON its dashed ring (Sky 30, §102 row 10: "the 36,000 km ring label sits on its own ring"). The ring has the radius w / 2 about the screen's
 * centre, so it runs off the screen at the top and bottom and shows as two arcs at the left and right edges. The label stands on the LEFT arc, GEO_LABEL_DY_PX under the
 * middle height: there nothing else is on it (the object panel and the time buttons are at the right, the lens buttons and the height column at the top left, the strip at the bottom),
 * on both screens. Two lines, left-aligned from the ring (the ring runs under the text's left end, behind a dark plate). The "GEO means ..." line stands right under it.
 * @param {number} wPx @param {number} hPx - viewport
 * @returns {{ringX:number, ringY:number, textX:number, y1:number, y2:number, toastTop:number}} screen px: the ring's point, the text's left edge, the two baselines, the toast's top edge
 */
export function geoLabelPlacement(wPx, hPx) {
  const r = wPx / 2;
  const dy = GEO_LABEL_DY_PX;
  const ringY = hPx / 2 + dy;
  const ringX = wPx / 2 - Math.sqrt(Math.max(0, r * r - dy * dy));
  const textX = Math.max(ringX, 0) + 6;
  const y1 = ringY - 4;
  const y2 = y1 + Math.round(LABEL_GEO_FONT_PX * 1.3);
  return { ringX, ringY, textX, y1, y2, toastTop: y2 + 14 };
}

/** The two lens buttons, in flip order: words for what each lens shows (gold = tonnes, red = danger). */
export const LENS_BUTTONS = Object.freeze([
  { lens: 'VALUE', label: 'Tonnes' },
  { lens: 'THREAT', label: 'Danger' },
]);
/** Like the air page's Sun buttons: a fingertip tall (AirChart BUTTON_MIN_H 46). */
export const LENS_BTN_H = 46;
export const LENS_BTN_W = 96;
const LENS_BTN_TEXT = '#eef2f7';
/** The buttons stand in a column: Danger under Tonnes, this far apart, this far from the screen's top and left (CSS px). */
export const LENS_STACK_GAP_PX = 8;
export const LENS_STACK_EDGE_PX = 16;
/** Page 1's radio notice sits at the top left, this far right of the buttons and at least this far before the page title's left edge. */
export const NOTICE_GAP_PX = 12;
export const NOTICE_TITLE_GAP_PX = 16;
/** Narrower than this and the notice goes under the buttons instead. */
export const NOTICE_MIN_W_PX = 340;
/**
 * The page title's half width, CSS px (Sky 20): "DEBRIS BY HEIGHT" in 26 px bold caps with 0.12 em spacing, centred (the score bar that stood
 * there was 350 px wide). Measured by the browser probe (tmp/sky20-pages/p1.mjs prints the title's rect); not scaled by the HUD scale (the title is not a HUD group).
 */
export const TITLE_HALF_W_PX = 160;
/** The once-only "GEO means ..." toast stands left-aligned right under the 36,000 km label and wraps at this width (Sky 30). */
export const TOAST_MAX_W_PX = 260;
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
  const right = wPx / 2 - TITLE_HALF_W_PX - NOTICE_TITLE_GAP_PX;
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
export const NOTE_ESTIMATES = 'Band masses marked "about" are estimates';
export const NOTE_THREAT = 'Some jumps before 2020 are better tracking, not new pieces \u00b7 when a chain reaction starts is disputed';

/** The lowest count the strip's log axis shows (the 1957 start of zero sits on this line), and the decades it spans. */
export const STRIP_LOG_MIN = 1000;

/** The gap the strip keeps before an open card at the bottom right (the iPad's panel), px. */
export const STRIP_KEEPOUT_GAP_PX = 16;
/**
 * The strip is a wide box along the bottom, starting at the left (Sky 30, owner 2026-11-24, DECISIONS §102 row 8: "it should be a wide box"; Sky 31, §103 row 1: bottom left, below
 * the page dots): it runs from STRIP_LEFT_PX to STRIP_RIGHT_PX short of the screen's right edge, the same 24 px at both ends. The time buttons and the object panel are at the top right
 * on both screens (row 7), so nothing stands below them; the open-card keep-out stays for any card that does reach the strip's rows (it stops STRIP_KEEPOUT_GAP_PX before it). Its
 * vertical place is the bottom edge (STRIP_*_FROM_BOTTOM_PX); the page dots stand just over it, at the bottom centre, over the strip's width.
 */
export const STRIP_LEFT_PX = 24;
export const STRIP_RIGHT_PX = 24;

/**
 * The strip's rectangle (CSS px; pure): x0, x1 left and right ends of the plot, y0, y1 its top and bottom.
 * @param {number} w @param {number} h - viewport
 * @param {{x0:number,y0:number,x1:number,y1:number}|null} [cardBox] - an open card: where its box reaches the strip's rows the strip also stops before it
 * @param {number} [safeBottom] - the bottom safe-area inset, px (0 on a Mac and on an iPad in the browser): the strip stands that much higher
 * @returns {{x0:number, x1:number, y0:number, y1:number}}
 */
export function stripRect(w, h, cardBox = null, safeBottom = 0) {
  const lift = Number.isFinite(safeBottom) && safeBottom > 0 ? safeBottom : 0;
  const y0 = h - STRIP_TOP_FROM_BOTTOM_PX - lift, y1 = h - STRIP_BOTTOM_FROM_BOTTOM_PX - lift;
  let x1 = w - STRIP_RIGHT_PX;
  // The box matters only where it reaches the strip's rows: the title line over the plot (glyph tops 15 px over y0) down to the year labels' descenders.
  if (cardBox && cardBox.y1 > y0 - 16 && cardBox.y0 < y1 + STRIP_LABEL_DROP_PX + 4) x1 = Math.min(x1, cardBox.x0 - STRIP_KEEPOUT_GAP_PX);
  return { x0: STRIP_LEFT_PX, x1, y0, y1 };
}
/** The "today" label keeps at least this far from the strip's title; closer than that it moves to the right of its line. */
const TODAY_TITLE_GAP_PX = 12;

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
    /** () => true while the falling pieces must stand still (a paused game); SdaFloor sets it; unset: never paused. */
    this.isPaused = null;
    /** The falling pieces (Sky 31, DECISIONS §103 row 3): their own canvas, drawn every frame while the chart shows (the chart's own canvas stays write-on-change). */
    this._reentry = new ReentryShow({ now: this._now });
    this._reGeom = { cx: 0, cy: 0, rEarth: 0, pxPerKm: 0 };
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
    const cb = m.cardBox ? `|cb${m.cardBox.x0},${m.cardBox.y0},${m.cardBox.x1},${m.cardBox.y1}` : '';
    const oob = m.outOfBand ? `${m.outOfBand.count}` : '0';
    const proj = m.timeline && m.timeline.projection
      ? m.timeline.projection.map((p) => p.tracked).join(',')
      : '';
    const risk = Math.round((m.riskFraction || 0) * 100);
    const epoch = (typeof m.fontEpoch === 'number') ? m.fontEpoch : 0;
    return `${m.lens}|${m.wPx}x${m.hPx}|${bands}|${oob}|${proj}|r${risk}${rs}${cb}|e${epoch}`;
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
   * @private While page 1 shows: the radio notice goes to the top left and the "GEO means" toast under the 36,000 km label (`geoLabelPlacement`; the toast grows
   * downward from its top edge). One attribute on <html>
   * and five variables feed two rules (`!important`: the box's inline width and the sky panel's dodge translate would win otherwise);
   * write-on-change; hide() / dispose() take it all away, so the globe has the box back at the top right.
   */
  _syncPageChrome(wPx, hPx) {
    if (typeof document === 'undefined' || !document.documentElement || !document.head || !this._visible) return;
    const de = document.documentElement;
    if (!document.getElementById(PAGE_STYLE_ID)) {
      const st = document.createElement('style');
      st.id = PAGE_STYLE_ID;
      st.textContent = `html[${PAGE_ATTR}] #hud-comms-panel { translate: var(--sda-notice-x) var(--sda-notice-y) !important; width: var(--sda-notice-w) !important; }`
        + ` html[${PAGE_ATTR}] #notification-zone { top: var(--sda-toast-y) !important; left: var(--sda-toast-x) !important; bottom: auto !important; transform: none !important; transform-origin: 0 0 !important;`
        + ` text-align: left !important; max-width: ${TOAST_MAX_W_PX}px !important; }`;
      document.head.appendChild(st);
    }
    const p = noticePlacement(wPx, hPx);
    const gp = geoLabelPlacement(wPx, hPx);
    const key = `${Math.round(p.x)}|${Math.round(p.y)}|${Math.round(p.wCss)}|${Math.round(gp.textX)}|${Math.round(gp.toastTop)}`;
    if (this._pageKey === key && de.hasAttribute(PAGE_ATTR)) return;
    this._pageKey = key;
    de.style.setProperty('--sda-notice-x', `${Math.round(p.x)}px`);
    de.style.setProperty('--sda-notice-y', `${Math.round(p.y)}px`);
    de.style.setProperty('--sda-notice-w', `${Math.round(p.wCss)}px`);
    de.style.setProperty('--sda-toast-x', `${Math.round(gp.textX)}px`);
    de.style.setProperty('--sda-toast-y', `${Math.round(gp.toastTop)}px`);
    de.setAttribute(PAGE_ATTR, '');
  }

  /** @private Undo {@link SdaChart#_syncPageChrome}. */
  _clearPageChrome() {
    this._pageKey = '';
    if (typeof document === 'undefined' || !document.documentElement || !document.documentElement.removeAttribute) return;
    const de = document.documentElement;
    de.removeAttribute(PAGE_ATTR);
    for (const v of ['--sda-notice-x', '--sda-notice-y', '--sda-notice-w', '--sda-toast-x', '--sda-toast-y']) de.style.removeProperty(v);
  }

  isVisible() { return this._visible; }

  /** The chart's canvas (built on first use; null headless): the page row slides this node. */
  element() { this._build(); return this._canvas || null; }

  /** Every top-level node the page row slides: the canvas, the lens buttons and the falling pieces' box (empty headless). */
  elements() { this._build(); return [this._canvas, this._buttonsRoot, this._reentry.element()].filter(Boolean); }

  show() {
    this._build();
    this._visible = true;
    this._reentry.show();
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
    this._reentry.hide();
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
    // The falling pieces move every frame on the real-time clock (not through the paint gate below); the geometry is Earth's circle and the honest LEO px per km.
    if (this._visible) {
      const rg = this._reGeom;
      rg.cx = wPx / 2; rg.cy = hPx / 2; rg.rEarth = Constants.EARTH_RADIUS * map.sLeoPxPerU; rg.pxPerKm = Constants.SCENE_SCALE * map.sLeoPxPerU;
      this._reentry.frame(rg, !!(this.isPaused && this.isPaused()));
    }
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
      text: bandLabelText(lens, r),
      rPx: (r.innerPx + r.outerPx) / 2,
    }));
    candidates.push({
      id: 'geo-ring',
      weight: lens === 'VALUE' ? 1.01 : 0.5, // the gold ring headlines VALUE
      text: `${GEO_LABEL_LINE1} \u00b7 ${_thousands(gold)} tonnes`,
      rPx: map.geoPx,
    });
    candidates.push({
      id: 'kessler-strip',
      weight: lens === 'THREAT' ? 1.01 : 0.4, // the timeline headlines THREAT
      text: STRIP_TITLE,
      rPx: 0,
    });
    // An open object card (page 1, Sky 20) is a box the label column and its colour key must stay clear of: `avoid` is in the layout's own terms
    // (x from the centre, y from the top). With the column on the left (Sky 23) the card (top right on the Mac, bottom right on the iPad) never meets it
    // on the two screens; a narrow window still moves the column. With no card open nothing is avoided.
    const cardBox = m.cardBox && Number.isFinite(m.cardBox.x0) ? m.cardBox : null;
    const avoid = cardBox ? { x0: cardBox.x0 - wPx / 2, x1: cardBox.x1 - wPx / 2, y0: cardBox.y0, y1: cardBox.y1 } : null;
    const labels = layoutLabels(rankLabels(candidates, FLOOR.labelBudget), hPx / 2, COLUMN_ROW_GAP_PX, LABEL_TOP_PX,
      wPx / 2, avoid, this._labelMeasure(), map.leoTopPx);
    this._syncPageChrome(wPx, hPx);

    const timeline = m.timeline || null;
    const sig = SdaChart.frameSig({
      lens, wPx, hPx, bands,
      outOfBand: m.outOfBand, timeline, riskFraction: m.riskFraction,
      fontEpoch: this._fontEpoch.value(), realSky, cardBox,
    });
    const now = this._now();
    const wouldPaint = SdaChart.shouldPaint(sig, this._lastSig, lens, now, this._lastPaintMs);

    let painted = false;
    if (wouldPaint && this._canvas && this._ctx2d && this._visible) {
      this._paint({ wPx, hPx, lens, map, rings, labels, timeline, outOfBand: m.outOfBand, realSky, cardBox, now });
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

    // Earth: no flat disc (Sky 30, §102 row 11): the real globe under the chart is framed to fill the Earth circle (`chartEarthDistU`).

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

    // The most crash-prone heights stand out in the Danger view: a thin crowded band is hidden under its own dots (the real-sky canvas draws over this one), so it gets a soft
    // halo and a stronger red along its width (Sky 31). Three strokes per band, at the pulse's rhythm; no shadowBlur.
    if (lens === 'THREAT') {
      const hot = hotBandIds(rings);
      for (const r of rings) {
        if (!hot.includes(r.id)) continue;
        const mid = (r.innerPx + r.outerPx) / 2, thick = r.outerPx - r.innerPx;
        g.strokeStyle = this._rgba(ramp, 0.18 * pulse); g.lineWidth = thick + 26; g.beginPath(); g.arc(cx, cy, mid, 0, Math.PI * 2); g.stroke();
        g.strokeStyle = this._rgba(ramp, 0.34 * pulse); g.lineWidth = thick + 12; g.beginPath(); g.arc(cx, cy, mid, 0, Math.PI * 2); g.stroke();
        g.strokeStyle = this._rgba(ramp, 0.95 * pulse); g.lineWidth = thick; g.beginPath(); g.arc(cx, cy, mid, 0, Math.PI * 2); g.stroke();
      }
    }

    // GEO ring at the screen edges: gold, dashed, STEADY on both lenses.
    g.beginPath();
    g.arc(cx, cy, map.geoPx, 0, Math.PI * 2);
    g.setLineDash([6, 6]);
    g.strokeStyle = this._rgba(VisualLaw.COLORS.VALUE, lens === 'VALUE' ? 0.9 : 0.4);
    g.lineWidth = lens === 'VALUE' ? 2 : 1;
    g.stroke();
    g.setLineDash([]);

    // The height labels (Sky 30, §102 row 9): 20 px, a column at the upper left, one straight leader each from the column's elbow to its band at the top of the ring.
    g.font = mono(LABEL_FONT_PX);
    const column = labels.filter((l) => l.leader);
    // A dark plate behind each label and the key hides the dashed 36,000 km ring where it runs under the text (it read "1,000/2,000"); the same plate as the 36,000 km label's.
    g.fillStyle = PLATE_FILL;
    for (const l of column) {
      const lines = l.lines || [l.text];
      const plateW = Math.max(...lines.map((t) => this._textW(g, t))) + 2 * PLATE_PAD_PX;
      g.fillRect(cx + l.x - PLATE_PAD_PX, l.y - GLYPH_UP_PX - 2, plateW, GLYPH_UP_PX + 2 + (lines.length - 1) * COLUMN_LINE_PX + GLYPH_DOWN_PX + 2);
    }
    for (const l of column) {
      g.fillStyle = this._rgba(ramp, 0.95);
      g.textAlign = 'left';
      (l.lines || [l.text]).forEach((t, j) => this._text(g, t, cx + l.x, l.y + j * COLUMN_LINE_PX, LABEL_FONT_PX));
    }
    g.lineWidth = 1;
    g.strokeStyle = this._rgba(ramp, 0.95);
    g.fillStyle = this._rgba(ramp, 0.95);
    for (const l of column) {
      g.beginPath();
      g.moveTo(cx + l.leaderX, l.leaderY);
      g.lineTo(cx + l.elbowX, l.leaderY);
      g.lineTo(cx + l.ringX, l.ringY);
      g.stroke();
      g.beginPath();
      g.arc(cx + l.ringX, l.ringY, 2, 0, Math.PI * 2);
      g.fill();
    }
    const geo = labels.find((l) => l.id === 'geo-ring');
    if (geo) this._paintGeoLabel(g, w, h, lens, geo);

    // The colour key: one line above the label column, left-aligned with it, each half in its dot's colour (what the ring dots mean now that the panel's key is gone).
    if (column.length) {
      g.font = mono(12);
      const kx = cx + column[0].x, ky = Math.min(...column.map((l) => l.y)) - KEY_ABOVE_PX;
      g.fillStyle = PLATE_FILL;                                   // the key's plate (see the labels' plates above)
      g.fillRect(kx - PLATE_PAD_PX, ky - 12, this._textW(g, KEY_WARM.text) + 18 + this._textW(g, KEY_COOL.text) + 2 * PLATE_PAD_PX, 12 + 4 + 2);
      g.textAlign = 'left';
      g.globalAlpha = 0.95;
      g.fillStyle = KEY_WARM.color;
      this._text(g, KEY_WARM.text, kx, ky, 12);
      g.fillStyle = KEY_COOL.color;
      this._text(g, KEY_COOL.text, kx + this._textW(g, KEY_WARM.text) + 18, ky, 12);
      g.globalAlpha = 1;
    }
    g.font = mono(10);

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
    // The page's credit (CC BY 4.0 and the sources) used to stand here as one line at the very bottom; it is in the Tech library entry for this page now
    // (Sky 20, owner 2026-11-23: "remove text at bottom ... should be in tech library").
    g.globalAlpha = 1;

    if (timeline) this._paintStrip(g, w, h, lens, timeline, labels, pulse, f.cardBox || null);
    // The one line about the year of falling pieces (Sky 31, §103 row 3): centred in the free band between the ring's bottom (h-201) and the page dots' tap boxes (h-148).
    // Painted after the strip (which sets its own font) so no font has to be put back.
    g.font = mono(YEAR_LINE_FONT_PX);
    g.textAlign = 'center';
    g.fillStyle = VisualLaw.COLORS.INFO;
    g.globalAlpha = 0.85;
    this._text(g, YEAR_LINE, cx, h - YEAR_LINE_FROM_BOTTOM_PX - this._safeBottomPx(), YEAR_LINE_FONT_PX);
    g.globalAlpha = 1;
    _setChartTextBoxes(this._boxes);
  }

  /**
   * @private The 36,000 km label on its ring (Sky 30, §102 row 10): two lines in the ring's gold on a dark plate that hides the dashed line behind the text, the ring
   * point `geoLabelPlacement` gives at the left; the "GEO means" toast stands right under it (`_syncPageChrome`).
   */
  _paintGeoLabel(g, w, h, lens, geo) {
    const p = geoLabelPlacement(w, h);
    const line2 = geo.text.slice(geo.text.indexOf('\u00b7') + 2);
    g.font = mono(LABEL_GEO_FONT_PX);
    g.textAlign = 'left';
    const w1 = this._textW(g, GEO_LABEL_LINE1), w2 = this._textW(g, line2);
    const plateX = Math.max(0, p.textX - GEO_LABEL_PAD_PX), plateW = Math.max(w1, w2) + 2 * GEO_LABEL_PAD_PX;
    const plateY = p.y1 - 14, plateH = (p.y2 - p.y1) + 14 + 7;   // glyph tops 12 px over a baseline, descenders 4 px under it
    g.fillStyle = 'rgba(2, 6, 12, 0.78)';
    g.fillRect(plateX, plateY, plateW, plateH);
    g.strokeStyle = this._rgba(VisualLaw.COLORS.VALUE, lens === 'VALUE' ? 0.9 : 0.4);
    g.lineWidth = lens === 'VALUE' ? 2 : 1;
    g.beginPath(); g.moveTo(p.ringX, plateY + plateH / 2); g.lineTo(plateX, plateY + plateH / 2); g.stroke();   // the ring's own tick into the plate
    g.fillStyle = this._rgba(VisualLaw.COLORS.VALUE, lens === 'VALUE' ? 0.98 : 0.8);
    this._text(g, GEO_LABEL_LINE1, p.textX, p.y1, LABEL_GEO_FONT_PX);
    this._text(g, line2, p.textX, p.y2, LABEL_GEO_FONT_PX);
  }

  /** @private The width of a height label at LABEL_FONT_PX (null without a canvas: the layout then guesses). */
  _labelMeasure() {
    const g = this._ctx2d;
    if (!g || typeof g.measureText !== 'function') return null;
    return (t) => {
      g.save();
      g.font = mono(LABEL_FONT_PX);
      const w = this._textW(g, t);
      g.restore();
      return w;
    };
  }

  /** @private A string's width in the current font (the fallback _text uses when there is no measureText). */
  _textW(g, s) {
    const str = String(s);
    const m = typeof g.measureText === 'function' ? g.measureText(str) : null;
    return m && Number.isFinite(m.width) ? m.width : str.length * 6.1;
  }

  /**
   * @private The bottom safe-area inset in CSS px (an iPad's home bar; 0 on a Mac and in the browser, and headless): a canvas cannot read `env()`, so a hidden
   * zero-size probe with `padding-bottom: env(safe-area-inset-bottom)` is read. Called only inside a paint (the paint is gated), never per frame.
   */
  _safeBottomPx() {
    if (typeof document === 'undefined' || !document.body || typeof document.createElement !== 'function' || typeof getComputedStyle !== 'function') return 0;
    try {
      if (!this._safeProbe) {
        const d = document.createElement('div');
        d.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-bottom:env(safe-area-inset-bottom, 0px)';
        document.body.appendChild(d);
        this._safeProbe = d;
      }
      const v = parseFloat(getComputedStyle(this._safeProbe).paddingBottom);
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch (_e) { return 0; }
  }

  /** @private fillText that also records the string's box (the glyphs sit about 0.9 of the font size above the baseline, 0.3 of descender; `px` is the font size, default 10). */
  _text(g, s, x, y, px = 10) {
    const str = String(s);
    const m = typeof g.measureText === 'function' ? g.measureText(str) : null;
    const w = m && Number.isFinite(m.width) ? m.width : str.length * 6.1;
    const left = g.textAlign === 'center' ? x - w / 2 : (g.textAlign === 'right' || g.textAlign === 'end') ? x - w : x;
    if (this._boxes) this._boxes.push({ text: str, x: left, y: y - 0.9 * px, w, h: 1.2 * px });
    g.fillText(str, x, y);
  }

  /**
   * @private The timeline strip along the bottom. The count axis is logarithmic (each gridline is 10 times the one under it, STRIP_LOG_MIN
   * at the bottom; the 1957 start of zero sits on that line), so 1957-2026 is a readable climb next to the forecast. The history is a
   * solid line; the forecast after "today" (the last keyframe year) is dashed and fainter than the history.
   */
  _paintStrip(g, w, h, lens, timeline, labels, pulse, cardBox = null) {
    const { x0, x1, y0, y1 } = stripRect(w, h, cardBox, this._safeBottomPx());
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
    // When the strip is short (a narrow window) that spot lies under the title's end: then it stands right of the line instead.
    const todayStr = `today ${today}`;
    const titleEnd = title ? x0 + this._textW(g, title.text) : x0;
    const todayW = this._textW(g, todayStr);
    if (X(today) - 4 - todayW >= titleEnd + TODAY_TITLE_GAP_PX) this._text(g, todayStr, X(today) - 4, y0 - 6);
    else { g.textAlign = 'left'; this._text(g, todayStr, X(today) + 4, y0 - 6); }
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
    if (this._safeProbe && this._safeProbe.remove) this._safeProbe.remove();
    this._safeProbe = null;
    this._reentry.dispose();
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
