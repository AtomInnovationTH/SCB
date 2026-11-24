/**
 * SdaFloor.js — the Zoom Ladder SDA DOWNLINK floor (id 5, FloorContract.FLOORS[6]) content orchestrator.
 *
 * SDA DOWNLINK is the Earth-anchored whole-domain strategic chart. This is its "costume" controller: it owns the
 * floor's content while the near field is off, full debris meshes are hidden and the ship is out of frame
 * (fidelity.debrisMode === 'massBands', costume.transform 'earth-to-chart'):
 *   - the SdaChart overlay: 200–2000 km altitude shells with aggregated live counts (debris clusters + active
 *     sats), the MASS_BANDS salvage table, the GEO gold ring at the screen edges, and the decade-scale Kessler
 *     timeline strip (history + the PURE projection from KesslerSystem's quadratic density model);
 *   - two lenses, VALUE (gold, mass-weighted) / THREAT (red, count-weighted + timeline); VALUE is the arrival
 *     default (00-spec §3 F5), the endings may land on THREAT via setLens();
 *   - the Space verb 'flip-lens' (00-spec §5): flipLens(), dispatched by LadderController.
 *
 * Every dependency is INJECTED and optional, so it is unit-testable headless (no THREE, no DOM, no EventBus):
 * cluster source = any object with getDebrisClusters(); sat source = a function returning active-sat records
 * (data/active-sats.json shape) or an object with getAllActiveSats(); kessler = anything with
 * getCascadeRisk()/getStatus() (KesslerSystem). It emits NO events. LadderController activates it on the arrival
 * floor's debrisMode 'massBands', ticks update() per frame while active, and dispatches 'flip-lens'.
 *
 * DATA CADENCE: sources are re-polled on activate() and then at most every DATA_REFRESH_MS, never per frame (the
 * cluster pass walks the whole debris list). The chart rasterizes write-on-change only (SdaChart's G1 gate), so a
 * calm floor costs zero paints and one aggregation pass per refresh window.
 *
 * @module systems/SdaFloor
 */

import { FloorContract } from '../core/FloorContract.js';
import { SdaChart, aggregateBands, buildTimeline, LENSES } from '../ui/SdaChart.js';
import { clamp01 } from '../core/MathUtil.js';

// by id, never by index
const FLOOR = FloorContract.byId(5);

/**
 * Minimum real-time interval between source re-polls (cluster walk + sat list + kessler status) while active;
 * per-frame aggregation would be waste. Own-module tunable (house rule: not FloorContract/Constants).
 */
export const DATA_REFRESH_MS = 2000;

// monotonic ms clock (headless-safe; injectable for tests)
const _nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class SdaFloor {
  /**
   * @param {object} [deps]
   * @param {object} [deps.clusterSource] - getDebrisClusters() (DebrisField)
   * @param {function|object} [deps.satSource] - () => active-sat records, or getAllActiveSats() (CatalogLoader)
   * @param {object} [deps.kessler] - getCascadeRisk() and/or getStatus() (KesslerSystem); feeds the timeline riskBoost
   * @param {object} [deps.chart] - SdaChart instance (default: fresh)
   * @param {function} [deps.realSkySource] - () => data/real-sky.json summary or null (CatalogLoader.getRealSky())
   * @param {function} [deps.now] - monotonic ms clock (tests)
   * @param {object} [deps.realSkyLayer] - RealSkyLayer (show(5) / hide(5)); absent = no real dots
   * @param {function():boolean} [deps.isPaused] - true while the falling pieces must stand still (the map clock's Pause step, a paused game)
   */
  constructor(deps = {}) {
    this._clusterSource = deps.clusterSource || null;
    this._satSource = deps.satSource || null;
    this._realSkySource = deps.realSkySource || null;
    this._kessler = deps.kessler || null;
    this._chart = deps.chart || new SdaChart();
    // The chart's two lens buttons (Tonnes / Danger) set the lens through this floor, like the endings ride does.
    if ('onLens' in this._chart) this._chart.onLens = (lens) => this.setLens(lens);
    // The falling pieces stand still while this says so (the time buttons' Pause, a paused game): main.js passes it (Sky 31, DECISIONS §103 row 3).
    if ('isPaused' in this._chart && typeof deps.isPaused === 'function') this._chart.isPaused = deps.isPaused;
    this._now = deps.now || _nowMs;
    this._realSkyLayer = deps.realSkyLayer || null;   // the real-catalogue dots (ui/RealSkyLayer.js, plan sky-1116): show(5) / hide(5)

    this._active = false;
    this._bands = [];
    this._outOfBand = { count: 0, satCount: 0, clusterCount: 0 };
    this._realSky = null;
    this._timeline = null;
    this._risk = 0;
    this._lastRefreshMs = -Infinity;
  }

  isActive() { return this._active; }

  get chart() { return this._chart; }


  /** Enter the floor: reset the lens to the arrival default (VALUE, 00-spec §3 F5), sample data afresh, show the chart. */
  activate() {
    if (this._active) return;
    this._active = true;
    this._chart.setLens(LENSES[0]); // VALUE on arrival, every arrival
    this.refreshData();
    if (this._chart.show) this._chart.show();
    if (this._realSkyLayer) this._realSkyLayer.show(FLOOR.id);
  }

  deactivate() {
    if (!this._active) return;
    this._active = false;
    if (this._chart.hide) this._chart.hide();
    if (this._realSkyLayer) this._realSkyLayer.hide(FLOOR.id);
  }


  /** Re-poll the sources and rebuild bands + timeline; safe headless with any subset of deps (absent = empty). */
  refreshData() {
    this._lastRefreshMs = this._now();
    const clusters = (this._clusterSource && this._clusterSource.getDebrisClusters)
      ? (this._clusterSource.getDebrisClusters() || [])
      : [];
    const sats = this._readSats();
    const realSky = this._readRealSky();
    const agg = aggregateBands({ clusters, sats, realSky });
    this._bands = agg.bands;
    this._outOfBand = agg.outOfBand;
    this._realSky = agg.realSky;
    this._risk = this._readRisk();
    this._timeline = buildTimeline({ riskBoost: this._risk });
  }

  /** @private The GCAT real-sky summary, or null (no source, no data, or a throwing source: the chart keeps its estimates). */
  _readRealSky() {
    const s = this._realSkySource;
    if (typeof s !== 'function') return null;
    try {
      return s() || null;
    } catch (_) {
      return null;
    }
  }

  /** @private Active-sat records from either dep shape. */
  _readSats() {
    const s = this._satSource;
    if (!s) return [];
    if (typeof s === 'function') return s() || [];
    if (typeof s.getAllActiveSats === 'function') return s.getAllActiveSats() || [];
    return [];
  }

  /** @private Cascade risk 0..1 from the kessler dep (0 without it). */
  _readRisk() {
    const k = this._kessler;
    if (!k) return 0;
    if (typeof k.getCascadeRisk === 'function') {
      const r = k.getCascadeRisk();
      return Number.isFinite(r) ? clamp01(r) : 0;
    }
    if (typeof k.getStatus === 'function') {
      const st = k.getStatus() || {};
      return Number.isFinite(st.cascadeRisk) ? clamp01(st.cascadeRisk) : 0;
    }
    return 0;
  }

  getBands() { return this._bands; }

  /** Objects outside the LEO shells (counted, never dropped). */
  getOutOfBand() { return this._outOfBand; }

  getTimeline() { return this._timeline; }

  getRisk() { return this._risk; }


  getLens() { return this._chart.getLens(); }

  /** Flip VALUE↔THREAT (the 'flip-lens' Space verb). The next update() repaints. Callable while inactive: harmless. */
  flipLens() { return this._chart.flipLens(); }

  /** Set the lens explicitly (the endings ride lands on THREAT with the career ledger — 00-spec §9); unknown ignored. */
  setLens(lens) { return this._chart.setLens(lens); }


  /** One frame; no-op while inactive. Re-polls at most every DATA_REFRESH_MS; rasterizes only on a changed frame signature (G1). */
  update(ctx = {}) {
    if (!this._active) return null;
    if ((this._now() - this._lastRefreshMs) >= DATA_REFRESH_MS) this.refreshData();
    return this._chart.render({
      bands: this._bands,
      outOfBand: this._outOfBand,
      realSky: this._realSky,
      // an open object card (page 1, Sky 20): the chart keeps its label column and colour key clear of it
      cardBox: this._realSkyLayer && typeof this._realSkyLayer.cardBox === 'function' ? this._realSkyLayer.cardBox() : null,
      timeline: this._timeline,
      riskFraction: this._risk,
      wPx: ctx.wPx,
      hPx: ctx.hPx,
    });
  }

  dispose() {
    if (this._chart.dispose) this._chart.dispose();
  }
}
