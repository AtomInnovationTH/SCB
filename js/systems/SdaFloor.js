/**
 * SdaFloor.js — the Zoom Ladder F7 (SDA DOWNLINK) floor content orchestrator
 * (S5, M4, FloorContract.FLOORS[6]).
 *
 * F7 is the Earth-anchored whole-domain strategic chart. This module is the F7
 * "costume" controller: it owns the floor's replacement content while the near
 * field is off, the full debris meshes are hidden, and the ship is out of
 * frame (fidelity.debrisMode === 'massBands', costume.transform
 * 'earth-to-chart'):
 *   - the SDA chart overlay (SdaChart): 200–2000 km altitude shells with
 *     aggregated live object counts (debris clusters + active sats), the
 *     canonical MASS_BANDS salvage table, the GEO gold ring at the screen
 *     edges (aspect-derived MEO compression + honest tag), and the
 *     decade-scale Kessler timeline strip (history keyframes + the PURE
 *     projection from KesslerSystem's quadratic density model);
 *   - the two lenses — VALUE (gold, mass-weighted) / THREAT (red,
 *     count-weighted + timeline) — with VALUE the arrival default
 *     (00-spec §3 F7) and the endings free to land on THREAT via setLens();
 *   - the Space verb 'flip-lens' (00-spec §5): flipLens(), dispatched by
 *     LadderController (HANDOFF — the serial track wires the verb case).
 *
 * DESIGN (docs/ladder/03-plan.md, this is the PARALLEL track — NavcomFloor
 * pattern):
 *   - Every dependency is INJECTED and optional, so the module is
 *     unit-testable headless (no THREE, no DOM, no EventBus). The cluster
 *     source is any object exposing getDebrisClusters(); the sat source is a
 *     function returning active-sat records (data/active-sats.json shapes) or
 *     an object exposing getAllActiveSats(); the kessler dep is anything
 *     exposing getCascadeRisk()/getStatus() (KesslerSystem).
 *   - It emits NO events. LadderController activates it on the arrival
 *     floor's fidelity.debrisMode === 'massBands', ticks update() per frame
 *     while active, and dispatches the 'flip-lens' verb (serial-track wire).
 *   - DATA CADENCE: sources are re-polled on activate() and then at most
 *     every DATA_REFRESH_MS from the per-frame tick — never per frame (the
 *     cluster pass walks the whole debris list). The chart itself rasterizes
 *     write-on-change only (SdaChart's G1 gate), so a calm F7 costs zero
 *     paints and one aggregation pass per refresh window.
 *
 * @module systems/SdaFloor
 */

import { FloorContract } from '../core/FloorContract.js';
import { SdaChart, aggregateBands, buildTimeline, LENSES } from '../ui/SdaChart.js';

/** The F7 (SDA) contract row — by id, never by index (Session H prep). */
const F7 = FloorContract.byId(7);

/**
 * Minimum real-time interval between source re-polls (cluster walk + sat list
 * + kessler status) while F7 is active. The chart reads slow strategic data;
 * per-frame aggregation would be pure waste (G1 discipline at the data layer).
 * Own-module tunable (house rule: not FloorContract/Constants).
 */
export const DATA_REFRESH_MS = 2000;

/** Monotonic ms clock (headless-safe; injectable for tests). */
const _nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class SdaFloor {
  /**
   * @param {object} [deps]
   * @param {object} [deps.clusterSource] - exposes getDebrisClusters() (DebrisField)
   * @param {function|object} [deps.satSource] - () => active-sat records, or an
   *                 object exposing getAllActiveSats() (CatalogLoader shape)
   * @param {object} [deps.kessler]       - exposes getCascadeRisk() and/or
   *                 getStatus() (KesslerSystem) — live cascade pressure feeds
   *                 the timeline projection's riskBoost
   * @param {object} [deps.chart]         - SdaChart instance (default: fresh)
   * @param {function} [deps.now]         - monotonic ms clock (tests)
   */
  constructor(deps = {}) {
    this._clusterSource = deps.clusterSource || null;
    this._satSource = deps.satSource || null;
    this._kessler = deps.kessler || null;
    this._chart = deps.chart || new SdaChart();
    this._now = deps.now || _nowMs;

    this._active = false;
    this._bands = [];
    this._outOfBand = { count: 0, satCount: 0, clusterCount: 0 };
    this._timeline = null;
    this._risk = 0;
    this._lastRefreshMs = -Infinity;
  }

  /** @returns {boolean} */
  isActive() { return this._active; }

  /** The chart view instance (for the serial track to mount / tests). */
  get chart() { return this._chart; }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Enter F7: reset the lens to the arrival default (VALUE — 00-spec §3 F7),
   * take a fresh data sample, and show the chart.
   */
  activate() {
    if (this._active) return;
    this._active = true;
    this._chart.setLens(LENSES[0]); // VALUE on arrival, every arrival
    this.refreshData();
    if (this._chart.show) this._chart.show();
  }

  /** Leave F7: hide the chart (state kept so re-entry is cheap). */
  deactivate() {
    if (!this._active) return;
    this._active = false;
    if (this._chart.hide) this._chart.hide();
  }

  // ── Data (throttled — never per frame) ─────────────────────────────────────

  /**
   * Re-poll the sources and rebuild the band aggregation + timeline model.
   * Called on activate() and from the throttled per-frame path; safe headless
   * with any subset of deps (absent sources aggregate as empty).
   */
  refreshData() {
    this._lastRefreshMs = this._now();
    const clusters = (this._clusterSource && this._clusterSource.getDebrisClusters)
      ? (this._clusterSource.getDebrisClusters() || [])
      : [];
    const sats = this._readSats();
    const agg = aggregateBands({ clusters, sats });
    this._bands = agg.bands;
    this._outOfBand = agg.outOfBand;
    this._risk = this._readRisk();
    this._timeline = buildTimeline({ riskBoost: this._risk });
  }

  /** @private Active-sat records from either dep shape (fn or CatalogLoader). */
  _readSats() {
    const s = this._satSource;
    if (!s) return [];
    if (typeof s === 'function') return s() || [];
    if (typeof s.getAllActiveSats === 'function') return s.getAllActiveSats() || [];
    return [];
  }

  /** @private Live cascade risk 0..1 from the kessler dep (0 without it). */
  _readRisk() {
    const k = this._kessler;
    if (!k) return 0;
    if (typeof k.getCascadeRisk === 'function') {
      const r = k.getCascadeRisk();
      return Number.isFinite(r) ? Math.max(0, Math.min(1, r)) : 0;
    }
    if (typeof k.getStatus === 'function') {
      const st = k.getStatus() || {};
      return Number.isFinite(st.cascadeRisk) ? Math.max(0, Math.min(1, st.cascadeRisk)) : 0;
    }
    return 0;
  }

  /** The current band aggregation (tests / context panel). */
  getBands() { return this._bands; }

  /** Objects outside the LEO shells (counted, never dropped). */
  getOutOfBand() { return this._outOfBand; }

  /** The current timeline model (tests / endings ledger). */
  getTimeline() { return this._timeline; }

  /** The last-sampled cascade risk fed to the projection. */
  getRisk() { return this._risk; }

  // ── Lens (the 'flip-lens' Space verb surface) ──────────────────────────────

  /** @returns {string} current lens ('VALUE' | 'THREAT') */
  getLens() { return this._chart.getLens(); }

  /**
   * Dispatch the F7 Space verb (FloorContract.FLOORS[6].spaceVerb
   * 'flip-lens'): flip VALUE↔THREAT. The next update() repaints (the flip
   * changes the frame signature). Callable while inactive (harmless — the
   * lens is reset to VALUE on the next arrival anyway).
   * @returns {string} the new lens
   */
  flipLens() { return this._chart.flipLens(); }

  /**
   * Set the lens explicitly (the endings ride lands on THREAT with the career
   * ledger overlaid — 00-spec §9). Unknown values are ignored.
   * @param {string} lens @returns {string} the lens in effect
   */
  setLens(lens) { return this._chart.setLens(lens); }

  // ── Per-frame ──────────────────────────────────────────────────────────────

  /**
   * Render one frame of the F7 costume. No-op while inactive. Re-polls the
   * sources at most every DATA_REFRESH_MS; the chart rasterizes only when its
   * frame signature changed (write-on-change — G1).
   * @param {object} [ctx]
   * @param {number} [ctx.wPx] [ctx.hPx] - viewport override (headless tests)
   * @returns {object|null} the SdaChart frame descriptors (tests), or null
   */
  update(ctx = {}) {
    if (!this._active) return null;
    if ((this._now() - this._lastRefreshMs) >= DATA_REFRESH_MS) this.refreshData();
    return this._chart.render({
      bands: this._bands,
      outOfBand: this._outOfBand,
      timeline: this._timeline,
      riskFraction: this._risk,
      wPx: ctx.wPx,
      hPx: ctx.hPx,
    });
  }

  /** Tear down the owned view. */
  dispose() {
    if (this._chart.dispose) this._chart.dispose();
  }
}
