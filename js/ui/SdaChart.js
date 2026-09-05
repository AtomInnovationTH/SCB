/**
 * SdaChart.js — the Zoom Ladder F7 (SDA DOWNLINK) whole-domain chart overlay
 * (S5, M4, FloorContract.FLOORS[6]).
 *
 * On F7 the camera sits 500–1300 u from Earth center and the domain is read as
 * a CHART, not a scene: an Earth-centered altitude-band diagram of the 200–2000
 * km LEO shells with aggregated object counts per band (live debris clusters +
 * active satellites), the GEO ring pinned to the left/right screen edges by the
 * aspect-derived MEO radial compression (honest "MEO compressed" tag whenever
 * the map is actually compressed — never silently distort), and a decade-scale
 * Kessler timeline strip along the bottom.
 *
 * TWO LENSES (FloorContract.FLOORS[6].chart.lenses, flipped by the F7 Space
 * verb 'flip-lens'):
 *   - VALUE  — gold (VisualLaw.COLORS.VALUE, STEADY — gold never pulses):
 *     salvage mass per band from the canonical FloorContract.MASS_BANDS table
 *     (LEO_SUB_BANDS are ESTIMATE-flagged and rendered with the flag — the
 *     mass-honesty rule), plus the GEO belt+graveyard "gold" total on the ring.
 *   - THREAT — red-orange (VisualLaw.COLORS.THREAT, ALWAYS pulses): live
 *     count-weighted density per band (counts / shell volume, normalized) and
 *     the Kessler timeline with keyframes, single-event injections, and the
 *     branch projection ahead — plus the honesty notes the spec requires on
 *     this lens (sensor-jump + disputed-onset caveats).
 *
 * THE PROJECTION IS PURE AND EXPORTED (projectDensity): it mirrors
 * KesslerSystem's quadratic density model (KesslerSystem.update():260 —
 * expected secondary-collision rate ∝ (count/threshold)²) at catalog scale:
 * dN/dt = c·N²/N₀, whose closed form N(t) = N₀ / (1 − c·Δt) grows
 * hyperbolically toward a finite-time cascade singularity. The default
 * coefficient is calibrated to the FloorContract BAU branch anchor (~4× by
 * 2059, Lewis 2009); the LIVE game feeds KesslerSystem.getCascadeRisk() in as
 * `riskBoost`, so fragments the player creates visibly steepen the projected
 * decade curve. Deterministic, side-effect free, unit-tested.
 *
 * VISUAL LAW: color is never the sole channel (lens is double-encoded: ramp
 * color AND which figures are drawn — mass tonnage vs density bars — AND the
 * THREAT pulse); at most `labelBudget` (F7 = 7) named labels are painted,
 * ranked by lens weight (rankLabels). Axis numerals / honesty tags are chart
 * chrome, not world labels.
 *
 * NO PER-FRAME CHURN (the G1 lesson — ClusterIcons._paintIcon /
 * TransferWindows.DOM_WRITE_MIN_INTERVAL_MS precedent): the chart is
 * screen-static while the data is static (Earth-anchored floor — Earth stays
 * centered), so render() rasterizes ONLY when the frame signature changes
 * (lens, viewport, band aggregates, timeline inputs). The THREAT pulse (the
 * one legitimately time-varying element) repaints at most every
 * PULSE_TICK_MS (250 ms → ≤4 Hz real, the F6 DOM-write cap precedent), never
 * per frame. The gate is the pure static shouldPaint() so tests pin it
 * headless. render() always computes and returns frame descriptors; painting
 * is the gated side effect.
 *
 * Pattern-matches the ReachOrb canvas overlay: full-screen canvas,
 * pointer-events:none, built lazily on show(), opacity-transitioned, fully
 * DOM-guarded (inert + constructible in Node tests).
 *
 * FLOOR CONTENT (parallel track, docs/ladder/03-plan.md): no camera, no debris
 * source, no game loop, no EventBus — SdaFloor (the F7 orchestrator) feeds it
 * aggregates + a viewport and owns the lifecycle; the serial track wires
 * SdaFloor into main.js/LadderController.
 *
 * @module ui/SdaChart
 */

import { Constants } from '../core/Constants.js';
import { VisualLaw } from '../core/VisualLaw.js';
import { FloorContract } from '../core/FloorContract.js';

/** The F5 (SDA) contract row (chart framing + labelBudget + lenses) — by id (Session H). */
const F7 = FloorContract.byId(5);

/** The two lenses, in flip order. VALUE is the arrival default (00-spec §3). */
export const LENSES = F7.chart.lenses; // ['VALUE', 'THREAT']

/**
 * THREAT-pulse repaint quantum (ms): the only time-varying paint input is the
 * pulse phase, quantized so the canvas rasterizes at ≤4 Hz real — the same cap
 * the F6 planner uses for warp-driven countdown text (G1). VALUE is STEADY
 * (gold never pulses — VisualLaw law), so on VALUE nothing repaints until the
 * data/viewport/lens signature changes. Own-module tunable (house rule).
 */
export const PULSE_TICK_MS = 250;

/** Full pulse period (ms) — a slow 2 s breathe, amplitude handled in paint. */
export const PULSE_PERIOD_MS = 2000;

/**
 * LEO zone vertical budget: the honest-scale zone (Earth disc + 200–2000 km
 * shells) fills this fraction of the half-height; the MEO compression factor
 * follows from what's left to the left/right screen edge (aspect-derived).
 */
export const LEO_VFRAC = 0.6;

/**
 * Projected-cascade display ceiling (× base count). The hyperbolic BAU curve
 * has a finite-time singularity (that IS the cascade); past it the tracked
 * count is clamped here so the strip stays drawable — the honesty notes say
 * onset timing is disputed, so the ceiling reads as "cascade", not a number.
 */
export const CASCADE_CEIL_FACTOR = 20;

/**
 * Default quadratic-growth coefficient (per year), calibrated so the pure
 * curve passes the FloorContract BAU branch anchor: ~4× tracked by 2059
 * (Lewis 2009), from the 2026 keyframe. N(t)=N₀/(1−cΔt) hits 4× when
 * 1−cΔt = 1/4 → c = 0.75/(2059−2026).
 */
export const BAU_QUADRUPLE_YEAR = 2059;

/** Chart chrome colors (not VisualLaw semantics — the F7 chart costume). */
const CHART_EARTH_BLUE = 'rgba(24, 62, 100, 0.92)'; // chart-blue flat disc
const CHART_GRID = 'rgba(0, 204, 255, 0.18)';       // faint INFO grid/rings

/** Monotonic ms clock (DOM-guarded module — Date.now fallback headless). */
const _nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ─────────────────────────────────────────────────────────────────────────────
// Pure aggregation + projection (exported, headless — the testable core)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Altitude (km) of one active-sat record. Accepts the data/active-sats.json
 * shape ({tle:{alt_km}}), the ActiveSatellites template shape ({altKm}), and a
 * bare {alt_km}. NaN when unknown (the record then lands out-of-band, never
 * silently vanishes).
 * @param {object} sat
 * @returns {number}
 */
export function satAltKm(sat) {
  if (!sat) return NaN;
  if (sat.tle && Number.isFinite(sat.tle.alt_km)) return sat.tle.alt_km;
  if (Number.isFinite(sat.altKm)) return sat.altKm;
  if (Number.isFinite(sat.alt_km)) return sat.alt_km;
  return NaN;
}

/**
 * Aggregate live objects into the F7 altitude bands.
 *
 * Bands are the canonical FloorContract.MASS_BANDS.LEO_SUB_BANDS shells
 * (never Constants.DEBRIS.ALT_BANDS / DebrisMap's UI array — the SSOT rule):
 * each band carries its canonical salvage mass (massT, ESTIMATE-flagged) plus
 * the live aggregates: debris-cluster member counts, active-sat counts, and
 * live cluster salvage mass (t). Objects outside [firstLo, lastHi] km — GEO
 * comms, GNSS, HEO — are aggregated into `outOfBand` (counted, never dropped:
 * the honesty rule) since the LEO shells are the chart's radial domain.
 *
 * Band rule: lo ≤ alt < hi, except the last band which includes its top edge.
 *
 * @param {object} [src]
 * @param {Array}  [src.clusters] - DebrisField.getDebrisClusters() shapes
 *                 ({count, avgAltKm, totalMassKg, ...})
 * @param {Array}  [src.sats]     - active-sat records (satAltKm shapes)
 * @returns {{bands: Array<{altKm:[number,number], massT:number, estimate:boolean,
 *            note:string, count:number, clusterCount:number, satCount:number,
 *            liveMassT:number}>, outOfBand:{count:number, satCount:number,
 *            clusterCount:number}, totalCount:number}}
 */
export function aggregateBands(src = {}) {
  const clusters = Array.isArray(src.clusters) ? src.clusters : [];
  const sats = Array.isArray(src.sats) ? src.sats : [];
  const bands = FloorContract.MASS_BANDS.LEO_SUB_BANDS.map((b) => ({
    altKm: [b.altKm[0], b.altKm[1]],
    massT: b.massT,
    estimate: !!b.estimate,
    note: b.note || '',
    count: 0,
    clusterCount: 0,
    satCount: 0,
    liveMassT: 0,
  }));
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
  return { bands, outOfBand, totalCount };
}

/**
 * Per-band lens weights, normalized 0..1 against the strongest band.
 *   VALUE  — salvage-mass weighted: canonical band mass + live cluster mass.
 *   THREAT — count-weighted DENSITY: objects per shell volume (the Kessler
 *            risk driver — a thin crowded shell out-threats a thick sparse
 *            one), volume ∝ (R+hi)³ − (R+lo)³.
 * All-zero input → all-zero weights (no divide-by-zero).
 * @param {Array} bands - aggregateBands().bands
 * @param {string} lens - 'VALUE' | 'THREAT'
 * @returns {number[]}
 */
export function lensWeights(bands, lens) {
  const list = Array.isArray(bands) ? bands : [];
  const R = Constants.EARTH_RADIUS_KM;
  const raw = list.map((b) => {
    if (lens === 'THREAT') {
      const [lo, hi] = b.altKm;
      const vol = Math.pow(R + hi, 3) - Math.pow(R + lo, 3);
      return vol > 0 ? (b.count || 0) / vol : 0;
    }
    return (b.massT || 0) + (b.liveMassT || 0);
  });
  const max = raw.reduce((a, v) => Math.max(a, v), 0);
  return raw.map((v) => (max > 0 ? v / max : 0));
}

/**
 * Resolve the FloorContract KESSLER_KEYFRAMES into a cumulative tracked-count
 * polyline: `tracked` keyframes are absolute; `delta` keyframes (single-event
 * fragment injections — Fengyun-1C, Iridium/Kosmos) add onto the last
 * cumulative value and are marked `event: true` for the strip's markers.
 * @param {Array} [keyframes] - default FloorContract.KESSLER_KEYFRAMES
 * @returns {Array<{year:number, tracked:number, event:boolean, note:string}>}
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
 * PURE Kessler density projection — KesslerSystem's model at catalog scale.
 *
 * KesslerSystem models the expected secondary-collision rate as QUADRATIC in
 * density (update(): riskFactor = (count/threshold)², KesslerSystem.js:260).
 * The same functional form projected on the tracked catalog:
 *
 *     dN/dt = c_eff · N²/N₀   ⇒   N(Δt) = N₀ / (1 − c_eff·Δt)
 *
 * hyperbolic growth with a finite-time singularity at Δt = 1/c_eff — the
 * cascade. c_eff = coeffPerYear · (1 + riskBoost): the live game feeds
 * KesslerSystem.getCascadeRisk() (0..1) in, so player-made fragments steepen
 * the curve and removals (risk decay) relax it. Past the singularity the
 * count clamps at CASCADE_CEIL_FACTOR·N₀ and `cascaded` flips true.
 *
 * Deterministic and side-effect free: same inputs → same output array.
 *
 * @param {object} [opts]
 * @param {number} [opts.baseYear]  - projection epoch (default: last keyframe year)
 * @param {number} [opts.baseCount] - tracked count at epoch (default: last keyframe)
 * @param {number} [opts.horizonYears=100] - how far to project (2126 endings frame)
 * @param {number} [opts.stepYears=10]     - decade-scale sampling
 * @param {number} [opts.coeffPerYear]     - quadratic coefficient (default: BAU
 *                 anchor calibration — ~4× by BAU_QUADRUPLE_YEAR)
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
  const risk = Math.max(0, Math.min(1, opts.riskBoost || 0));
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
 * Build the whole timeline model for the strip: resolved history keyframes,
 * the decade projection from the live risk, and the FloorContract branches
 * (the ADR branch is the player's role — the endings frame).
 * Pure: a plain-data assembly of the two pure functions above.
 * @param {object} [opts]
 * @param {number} [opts.riskBoost=0] - KesslerSystem.getCascadeRisk()
 * @param {number} [opts.horizonYears=100]
 * @param {number} [opts.stepYears=10]
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
 * Aspect-derived radial map (the MEO compression, 00-spec §3 F7).
 *
 * The LEO zone (Earth disc + shells up to the last band's top) is drawn at an
 * HONEST linear scale sized to LEO_VFRAC of the half-height; the MEO zone
 * beyond is radially compressed by the single factor that lands the GEO ring
 * (FloorContract chart.geoRingU ≈ 420 u) exactly at the left/right screen
 * edges (x = ±w/2). cFactor < 1 ⇒ compressed ⇒ the honest tag must show;
 * on a hyper-wide viewport where the honest scale already reaches the edge
 * (cFactor ≥ 1) nothing is distorted and the tag hides.
 *
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
  const geoU = F7.chart.geoRingU;

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
 * Radial pixel distance from screen center for a circular altitude (km),
 * through the piecewise honest-LEO / compressed-MEO map. Monotone in altKm.
 * @param {object} map - meoRadialMap() result
 * @param {number} altKm
 * @returns {number} px
 */
export function radiusPxForAltKm(map, altKm) {
  const u = Constants.EARTH_RADIUS + Math.max(0, altKm) * Constants.SCENE_SCALE;
  if (u <= map.leoTopU) return u * map.sLeoPxPerU;
  return map.leoTopPx + (u - map.leoTopU) * map.sLeoPxPerU * map.cFactor;
}

/**
 * Rank label candidates for the floor's labelBudget (F7 = 7): weight-desc,
 * stable on ties by id, truncate. Pure — mirrors ClusterIcons.rank.
 * @param {Array<{id:*, weight:number}>} candidates
 * @param {number} [budget] - default F7.labelBudget
 * @returns {Array}
 */
export function rankLabels(candidates, budget = F7.labelBudget) {
  const list = Array.isArray(candidates) ? candidates.slice() : [];
  list.sort((a, b) => {
    const dw = (b.weight || 0) - (a.weight || 0);
    if (dw !== 0) return dw;
    return String(a.id).localeCompare(String(b.id));
  });
  return list.slice(0, Math.max(0, budget | 0));
}

export class SdaChart {
  /**
   * @param {object} [deps]
   * @param {function} [deps.now] - monotonic ms clock (tests); default performance.now
   */
  constructor(deps = {}) {
    this._now = deps.now || _nowMs;
    this._canvas = null;
    this._ctx2d = null;
    this._built = false;
    this._visible = false;
    this._lens = LENSES[0]; // VALUE — the arrival default (00-spec §3 F7)
    // Write-on-change state (G1): last painted signature + paint clock.
    this._lastSig = null;
    this._lastPaintMs = -Infinity;
    /** Rasterizations actually performed (tests + probes). */
    this.paintCount = 0;
  }

  // ── Lens state ──────────────────────────────────────────────────────────────

  /** @returns {string} current lens ('VALUE' | 'THREAT') */
  getLens() { return this._lens; }

  /**
   * Set the lens (endings land on THREAT; arrival resets to VALUE).
   * Unknown values are ignored. @param {string} lens @returns {string} the lens
   */
  setLens(lens) {
    if (LENSES.includes(lens)) this._lens = lens;
    return this._lens;
  }

  /** Flip VALUE↔THREAT (the F7 'flip-lens' Space verb). @returns {string} new lens */
  flipLens() {
    this._lens = LENSES[(LENSES.indexOf(this._lens) + 1) % LENSES.length];
    return this._lens;
  }

  // ── Write-on-change gate (G1 — pure + static, headless-pinnable) ────────────

  /**
   * Should render() rasterize this frame?
   *   - signature change (lens/viewport/data) → always paint;
   *   - identical signature on the STEADY lens (VALUE — gold never pulses)
   *     → never repaint;
   *   - identical signature on THREAT (the pulse breathes) → repaint at most
   *     every PULSE_TICK_MS (≤4 Hz real), never per frame.
   * @param {string} sig - frame signature
   * @param {string|null} lastSig - previously painted signature
   * @param {string} lens - 'VALUE' | 'THREAT'
   * @param {number} nowMs - monotonic clock
   * @param {number} lastPaintMs - time of the previous rasterization
   * @returns {boolean}
   */
  static shouldPaint(sig, lastSig, lens, nowMs, lastPaintMs) {
    if (sig !== lastSig) return true;
    if (lens !== 'THREAT') return false;
    return (nowMs - lastPaintMs) >= PULSE_TICK_MS;
  }

  /**
   * Frame signature: every input that changes the rasterized pixels except
   * the THREAT pulse phase (which is time-gated instead). Pure + static.
   * @param {object} m - {lens, wPx, hPx, bands, outOfBand, timeline, riskFraction}
   * @returns {string}
   */
  static frameSig(m) {
    const bands = (m.bands || [])
      .map((b) => `${b.count}/${b.satCount}/${Math.round((b.liveMassT || 0) * 10)}`)
      .join('|');
    const oob = m.outOfBand ? `${m.outOfBand.count}` : '0';
    const proj = m.timeline && m.timeline.projection
      ? m.timeline.projection.map((p) => p.tracked).join(',')
      : '';
    const risk = Math.round((m.riskFraction || 0) * 100);
    return `${m.lens}|${m.wPx}x${m.hPx}|${bands}|${oob}|${proj}|r${risk}`;
  }

  // ── DOM lifecycle (all no-op headless; ReachOrb overlay pattern) ────────────

  /** @private */
  _build() {
    if (this._built || typeof document === 'undefined' || !document.body) return;
    this._built = true;
    const canvas = document.createElement('canvas');
    canvas.id = 'ladder-sda-chart';
    // z-index 33: the F7 costume layer (the F6 icon layer is hidden on F7 —
    // the two floors never paint together).
    canvas.style.cssText = [
      'position:absolute', 'left:0', 'top:0', 'width:100%', 'height:100%',
      'pointer-events:none', 'z-index:33', 'opacity:0', 'transition:opacity 0.3s',
    ].join(';');
    document.body.appendChild(canvas);
    this._canvas = canvas;
    this._ctx2d = canvas.getContext ? canvas.getContext('2d') : null;
  }

  /** @returns {boolean} shown (activate/deactivate lifecycle probe) */
  isVisible() { return this._visible; }

  show() {
    this._build();
    this._visible = true;
    if (this._canvas) this._canvas.style.opacity = '1';
    // A re-show must repaint even into an unchanged world (the canvas may
    // have been cleared on hide): drop the signature.
    this._lastSig = null;
  }

  hide() {
    this._visible = false;
    if (this._canvas) {
      this._canvas.style.opacity = '0';
      // Clear immediately so a re-shown F7 never flashes a stale frame.
      if (this._ctx2d) this._ctx2d.clearRect(0, 0, this._canvas.width, this._canvas.height);
    }
  }

  // ── Render (compute always; rasterize on change only) ───────────────────────

  /**
   * Compute one chart frame and rasterize it iff the write-on-change gate
   * passes. Headless (no canvas) the computation is identical and
   * `painted` is false while `wouldPaint` still reports the gate decision.
   *
   * @param {object} m
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
    const wPx = m.wPx || ((typeof window !== 'undefined') ? window.innerWidth : 1280);
    const hPx = m.hPx || ((typeof window !== 'undefined') ? window.innerHeight : 720);
    const bands = m.bands || [];
    const map = meoRadialMap({ wPx, hPx });
    const weights = lensWeights(bands, lens);

    // Ring descriptors: one shell per band (inner/outer px through the map).
    const rings = bands.map((b, i) => ({
      id: `band-${b.altKm[0]}`,
      altKm: b.altKm,
      innerPx: radiusPxForAltKm(map, b.altKm[0]),
      outerPx: radiusPxForAltKm(map, b.altKm[1]),
      weight: weights[i],
      count: b.count,
      massT: b.massT,
      liveMassT: b.liveMassT,
      estimate: b.estimate,
    }));

    // Label candidates (named world labels — the budget applies): the five
    // bands (lens-weighted), the GEO gold ring, the timeline strip title.
    const gold = FloorContract.MASS_BANDS.REGIMES
      .filter((r) => r.gold)
      .reduce((a, r) => a + r.massT, 0); // 4,384 t belt+graveyard
    const candidates = rings.map((r, i) => ({
      id: r.id,
      weight: weights[i],
      text: lens === 'VALUE'
        ? `${r.altKm[0]}\u2013${r.altKm[1]} km \u00b7 ${Math.round(r.massT + r.liveMassT)} t${r.estimate ? ' \u00b7 EST' : ''}`
        : `${r.altKm[0]}\u2013${r.altKm[1]} km \u00b7 ${r.count} obj`,
      rPx: (r.innerPx + r.outerPx) / 2,
    }));
    candidates.push({
      id: 'geo-ring',
      weight: lens === 'VALUE' ? 1.01 : 0.5, // the gold ring headlines VALUE
      text: `GEO belt+graveyard \u00b7 ${gold} t`,
      rPx: map.geoPx,
    });
    candidates.push({
      id: 'kessler-strip',
      weight: lens === 'THREAT' ? 1.01 : 0.4, // the timeline headlines THREAT
      text: 'KESSLER TIMELINE 1957\u21922126',
      rPx: 0,
    });
    const labels = rankLabels(candidates, F7.labelBudget);

    const timeline = m.timeline || null;
    const sig = SdaChart.frameSig({
      lens, wPx, hPx, bands,
      outOfBand: m.outOfBand, timeline, riskFraction: m.riskFraction,
    });
    const now = this._now();
    const wouldPaint = SdaChart.shouldPaint(sig, this._lastSig, lens, now, this._lastPaintMs);

    let painted = false;
    if (wouldPaint && this._canvas && this._ctx2d && this._visible) {
      this._paint({ wPx, hPx, lens, map, rings, labels, timeline, outOfBand: m.outOfBand, now });
      painted = true;
    }
    if (wouldPaint) {
      // The gate advances on the DECISION so headless tests pin the same
      // cadence the browser sees (paint itself is the DOM-guarded effect).
      this._lastSig = sig;
      this._lastPaintMs = now;
    }

    return {
      lens, map, weights, rings, labels, timeline,
      compressed: map.compressed, wouldPaint, painted, sig,
    };
  }

  // ── Rasterization (DOM-only; never called headless) ─────────────────────────

  /** @private Paint the whole chart: disc, shells, GEO ring, labels, strip. */
  _paint(f) {
    const g = this._ctx2d;
    const canvas = this._canvas;
    const { wPx: w, hPx: h, lens, map, rings, labels, timeline, now } = f;
    this.paintCount++;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    g.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const ramp = lens === 'VALUE' ? VisualLaw.COLORS.VALUE : VisualLaw.COLORS.THREAT;
    // THREAT ALWAYS pulses (VisualLaw); phase quantized by the paint gate.
    const pulse = lens === 'THREAT'
      ? 0.75 + 0.25 * Math.sin((now % PULSE_PERIOD_MS) / PULSE_PERIOD_MS * Math.PI * 2)
      : 1;

    // Earth: chart-blue flat disc (the chart costume — an overlay, the real
    // Earth mesh is untouched; the F7 visual-defaults revisit owns the 3D
    // overlay sphere).
    const rEarth = Constants.EARTH_RADIUS * map.sLeoPxPerU;
    g.beginPath();
    g.arc(cx, cy, rEarth, 0, Math.PI * 2);
    g.fillStyle = CHART_EARTH_BLUE;
    g.fill();

    // Self-lit altitude bands: annulus fills, lens ramp alpha by weight.
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

    // GEO ring at the screen edges — gold, dashed, STEADY on both lenses
    // (gold never pulses).
    g.beginPath();
    g.arc(cx, cy, map.geoPx, 0, Math.PI * 2);
    g.setLineDash([6, 6]);
    g.strokeStyle = this._rgba(VisualLaw.COLORS.VALUE, lens === 'VALUE' ? 0.9 : 0.4);
    g.lineWidth = lens === 'VALUE' ? 2 : 1;
    g.stroke();
    g.setLineDash([]);

    // Named labels (budget-ranked upstream, ≤ 7).
    g.font = '10px "Courier New", monospace';
    g.textAlign = 'left';
    for (const l of labels) {
      if (l.id === 'kessler-strip') continue; // painted with the strip below
      const y = cy - l.rPx;
      g.fillStyle = this._rgba(ramp, 0.95);
      g.fillText(l.text, cx + 8, Math.max(12, y - 3));
    }

    // Honesty chrome (not world labels): the MEO tag + ESTIMATE provenance.
    g.textAlign = 'center';
    g.fillStyle = VisualLaw.COLORS.INFO;
    g.globalAlpha = 0.8;
    if (map.compressed) g.fillText(F7.chart.compressionTag, cx, 16);
    if (lens === 'VALUE') {
      g.fillText('sub-LEO band masses are estimates (EST)', cx, 30);
    } else {
      g.fillText('pre-2020 count jumps partly = better sensors \u00b7 cascade onset disputed', cx, 30);
    }
    // Out-of-band honesty line: objects beyond the LEO shells are counted,
    // never silently dropped (GEO/GNSS/HEO live outside the radial domain).
    if (f.outOfBand && f.outOfBand.count > 0) {
      g.textAlign = 'right';
      g.fillText(`beyond ${rings.length ? rings[rings.length - 1].altKm[1] : 2000} km: ${f.outOfBand.count} obj`, w - 10, 16);
    }
    g.globalAlpha = 1;

    if (timeline) this._paintStrip(g, w, h, lens, timeline, labels, pulse);
  }

  /** @private The decade-scale Kessler timeline strip along the bottom. */
  _paintStrip(g, w, h, lens, timeline, labels, pulse) {
    const x0 = w * 0.08, x1 = w * 0.92;
    const y0 = h - 78, y1 = h - 34;
    const hist = timeline.history || [];
    const proj = timeline.projection || [];
    if (!hist.length && !proj.length) return;
    const years = [...hist.map((p) => p.year), ...proj.map((p) => p.year)];
    const counts = [...hist.map((p) => p.tracked), ...proj.map((p) => p.tracked)];
    const yr0 = Math.min(...years), yr1 = Math.max(...years);
    const cMax = Math.max(...counts, 1);
    const X = (yr) => x0 + ((yr - yr0) / Math.max(1, yr1 - yr0)) * (x1 - x0);
    const Y = (n) => y1 - (n / cMax) * (y1 - y0);

    // Decade ticks (chrome).
    g.strokeStyle = CHART_GRID;
    g.lineWidth = 1;
    for (let yr = Math.ceil(yr0 / 10) * 10; yr <= yr1; yr += 10) {
      g.beginPath(); g.moveTo(X(yr), y1); g.lineTo(X(yr), y1 + 4); g.stroke();
    }

    // History polyline (INFO cyan) + event markers (the two injections).
    g.strokeStyle = VisualLaw.COLORS.INFO;
    g.beginPath();
    hist.forEach((p, i) => { const x = X(p.year), y = Y(p.tracked); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); });
    g.stroke();
    for (const p of hist) {
      if (!p.event) continue;
      g.fillStyle = VisualLaw.COLORS.THREAT;
      g.beginPath(); g.arc(X(p.year), Y(p.tracked), 2.5, 0, Math.PI * 2); g.fill();
    }

    // Projection polyline — THREAT red (pulsing on the THREAT lens).
    g.strokeStyle = this._rgba(VisualLaw.COLORS.THREAT, (lens === 'THREAT' ? 0.95 : 0.5) * pulse);
    g.beginPath();
    proj.forEach((p, i) => { const x = X(p.year), y = Y(p.tracked); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); });
    g.stroke();

    // Strip title (a budgeted world label) + endpoint numerals (chrome).
    const title = labels.find((l) => l.id === 'kessler-strip');
    g.font = '10px "Courier New", monospace';
    if (title) {
      g.textAlign = 'left';
      g.fillStyle = this._rgba(lens === 'THREAT' ? VisualLaw.COLORS.THREAT : VisualLaw.COLORS.INFO, 0.95);
      g.fillText(title.text, x0, y0 - 6);
    }
    g.textAlign = 'center';
    g.fillStyle = VisualLaw.COLORS.INFO;
    g.globalAlpha = 0.7;
    g.fillText(String(yr0), X(yr0), y1 + 14);
    g.fillText(String(yr1), X(yr1), y1 + 14);
    g.globalAlpha = 1;
  }

  /** @private hex → rgba() with alpha. */
  _rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, a))})`;
  }

  /** Remove the whole layer. */
  dispose() {
    if (this._canvas && this._canvas.remove) this._canvas.remove();
    this._canvas = null;
    this._ctx2d = null;
    this._built = false;
    this._visible = false;
    this._lastSig = null;
    this._lastPaintMs = -Infinity;
  }
}
