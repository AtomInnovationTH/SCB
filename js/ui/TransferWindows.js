/**
 * TransferWindows.js — the NAVCOM floor's transfer-window surface (FloorContract costume.arrive 'TransferWindows').
 *
 * Reads the transfer window from the player's orbit to the focused debris cluster ("space is periodic, go now is
 * usually wrong") and surfaces the depart/transfer/arrive countdown + ΔV. The window math lives in
 * js/entities/LaunchWindow.js (computeTransferWindow / coOrbitalReadout); this module is the read-only costume that
 * formats and paints it: no game loop, no autopilot, no events (NavcomFloor feeds it a window).
 *
 * Pure formatting (`formatDuration`, `readout`, `fuelLine`) is static and THREE/DOM-free, so it is unit-testable.
 * The DOM panel is guarded (inert headless). `readout`/`refresh` accept optional `opts.assessment`
 * (ReachabilityModel.assess result: verdict + engine gas + margin row), `opts.route` (OrbitPlanners.computeRoutePlan)
 * and `opts.sweep` (computeSweepBands), the last two fed by NavcomFloor from the whole cluster field. Those rows
 * are labelled FIELD-scoped ("FIELD ROUTE …" / "FIELD DENSEST BAND …") so they never read as the focused cluster's
 * window above them. Absent opts ⇒ markup unchanged.
 *
 * @module ui/TransferWindows
 */

import { Constants } from '../core/Constants.js';
import { FloorContract } from '../core/FloorContract.js';
import { VisualLaw } from '../core/VisualLaw.js';
import { coOrbitalReadout } from '../entities/LaunchWindow.js';
import { PANE_CORNER_PX } from './RailGeometry.js';

/** T-minus threshold at which a window reads "imminent" (shared with DebrisMap). */
const IMMINENT_S = Constants.DEBRIS_MAP.WINDOW_IMMINENT_S;

/**
 * The panel titles itself from the ONE source of floor labels (FloorContract `name`, as the rail does; owner relabel
 * 2026-09-05: 4 LEO). Never hard-code a floor name.
 */
const THIS_FLOOR = FloorContract.byId(4);
const FLOOR_TITLE = THIS_FLOOR ? THIS_FLOOR.name : 'LEO';

/**
 * Minimum real-time interval between innerHTML writes. The html cache only limits churn to the rate the TEXT
 * changes (~1 Hz at 1×); under 20× warp it changes ~20×/s. This bounds DOM writes to ≤4 Hz REAL regardless of
 * warp; STRUCTURAL changes (target/emptiness/imminence/ΔV text) bypass it. See docs/ladder/01-numbers.md §"Post-M3 glue".
 */
const DOM_WRITE_MIN_INTERVAL_MS = 250;

const _nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** The box's distance above the screen's bottom (its CSS `bottom`); RANGE_MAP.XFER_BOX_BOTTOM_PX is pinned to it. */
export const BOX_BOTTOM_PX = 16;

export class TransferWindows {
  /**
   * @param {object} [deps]
   * @param {function} [deps.now] - monotonic ms clock (tests); defaults to performance.now
   * @param {function} [deps.simple] - () => true at the simple level (mission 1, no `+` pane pulled in):
   *                 the panel then paints two plain sentences instead of the numbers.
   */
  constructor(deps = {}) {
    this._now = deps.now || _nowMs;
    this._simple = typeof deps.simple === 'function' ? deps.simple : null;
    this._root = null;
    this._built = false;
    this._visible = false;
    this._boxH = null;          // the box's measured outer height (heightPx)
    this._lastHtml = null;      // last painted markup — skips per-frame innerHTML churn
    this._lastStructKey = null; // last painted STRUCTURAL key (shouldWrite)
    this._lastWriteMs = -Infinity; // last innerHTML write (real time)
  }

  /**
   * Should refresh() write the DOM this frame? Structural changes always write; countdown-only changes are capped
   * at DOM_WRITE_MIN_INTERVAL_MS (pinned by test-NavcomFloor).
   * @param {string} structKey  - structural fingerprint of the new model
   * @param {string|null} lastStructKey - previously painted fingerprint
   */
  static shouldWrite(structKey, lastStructKey, nowMs, lastWriteMs) {
    if (structKey !== lastStructKey) return true;
    return (nowMs - lastWriteMs) >= DOM_WRITE_MIN_INTERVAL_MS;
  }

  static get DOM_WRITE_MIN_INTERVAL_MS() { return DOM_WRITE_MIN_INTERVAL_MS; }

  /** @param {number} s - seconds (0 / negative → "OPEN NOW"; non-finite → "—") */
  static formatDuration(s) {
    if (!Number.isFinite(s)) return '\u2014';
    if (s <= 0) return 'OPEN NOW';
    const sec = Math.round(s);
    if (sec < 60) return `T-${sec}s`;
    const m = Math.floor(sec / 60);
    if (m < 60) return `T-${m}m${String(sec % 60).padStart(2, '0')}s`;
    const h = Math.floor(m / 60);
    if (h < 24) return `T-${h}h${String(m % 60).padStart(2, '0')}m`;
    const d = Math.floor(h / 24);
    return `T-${d}d${String(h % 24).padStart(2, '0')}h`;
  }

  /**
   * A coarse window phrase for a player line (game time runs about 40x real, so a minute countdown would churn).
   * <= 0 -> `open now`; under an hour -> `in under an hour`; under a day -> `in about N h`; else `in about N days`.
   * Non-finite -> null (the caller folds the line / row).
   * @param {number} s - seconds until the window opens
   * @returns {?string}
   */
  static plainWindow(s) {
    if (!Number.isFinite(s)) return null;
    if (s <= 0) return 'open now';
    if (s < 3600) return 'in under an hour';
    if (Math.round(s / 3600) < 24) return `in about ${Math.round(s / 3600)} h`;   // 84,600 s+ reads "1 day", never "24 h"
    const d = Math.round(s / 86400);
    return d === 1 ? 'in about 1 day' : `in about ${d} days`;
  }

  /**
   * Display model for a transfer window. Pure — no DOM.
   * @param {object|null} win - a computeTransferWindow() result (or null)
   * @param {object} [opts]
   * @param {string} [opts.targetName] - focused cluster name
   * @param {object} [opts.assessment] - the focused cluster's ReachabilityModel.assess() result ({verdict, fuelKg,
   *                 budgetAfter, ...}). Absent → fuelText ''.
   * @param {object} [opts.budget] - getMassBudget() sample (reserved; the row reads budgetAfter, post-burn)
   * @param {object} [opts.route] - OrbitPlanners.computeRoutePlan() result ({plan, totalDv}), whole-field.
   *                 Absent → routeText '' (no row).
   * @param {boolean} [opts.simple] - add the plain two-line form (`simple:true`, `plainText`, `plainFuelText`)
   * @param {object} [opts.sweep] - OrbitPlanners.computeSweepBands() result ({bands, densest}), whole-field.
   *                 Absent → sweepText '' (no row).
   * @returns {{
   *   empty:boolean, coOrbital:boolean, targetName:string,
   *   departText:string, transferText:string, arriveText:string,
   *   dvText:string, periodText:string, imminent:boolean, showArrive:boolean,
   *   fuelText:string, verdict:?string, routeText:string, sweepText:string
   * }}
   */
  static readout(win, opts = {}) {
    const model = TransferWindows._readout(win, opts);
    if (!opts.simple) return model;
    // Simple level: two plain sentences, no numbers of the trip itself.
    let plainText;
    let plainFuelText = '';
    if (model.empty) plainText = 'Point at a debris field to plan a trip.';
    else if (model.coOrbital) plainText = 'You are already at this height. No trip needed.';
    else {
      const when = TransferWindows.plainWindow(win.departIn);
      plainText = when == null ? '' : `Next window ${when}`;
      const v = model.verdict;
      plainFuelText = v === 'reachable' ? 'Enough fuel to go'
        : v === 'marginal' ? 'Only just enough fuel'
        : v === 'unreachable' ? 'Not enough fuel to go' : '';
    }
    return { ...model, simple: true, plainText, plainFuelText };
  }

  /** @private The full (Details) model. */
  static _readout(win, opts = {}) {
    const targetName = opts.targetName || '\u2014';
    const a = opts.assessment || null;
    const fuelText = (win && a) ? TransferWindows.fuelLine(a) : '';
    const verdict = (win && a) ? (a.verdict || null) : null;
    // Field-scoped rows are independent of whether a window exists (NO TARGET still shows them).
    const routeText = TransferWindows.routeLine(opts.route || null);
    const sweepText = TransferWindows.sweepLine(opts.sweep || null);
    if (!win) {
      return {
        empty: true, coOrbital: false, targetName,
        departText: 'NO TARGET', transferText: '', arriveText: '',
        dvText: '', periodText: 'aim a cluster to plan a transfer',
        imminent: false, showArrive: false,
        fuelText: '', verdict: null,
        routeText, sweepText,
      };
    }
    const dvText = `\u0394V ${Math.round(win.dvTotal)} m/s`;
    const co = coOrbitalReadout(win);
    if (co) {
      return {
        empty: false, coOrbital: true, targetName,
        departText: co.departText, transferText: '', arriveText: '',
        dvText, periodText: co.periodText, imminent: false, showArrive: co.showArrive,
        fuelText, verdict,
        routeText, sweepText,
      };
    }
    return {
      empty: false, coOrbital: false, targetName,
      departText: TransferWindows.formatDuration(win.departIn),
      transferText: `xfer ${TransferWindows.formatDuration(win.transferTime).replace('T-', '')}`,
      arriveText: TransferWindows.formatDuration(win.arriveIn),
      dvText,
      periodText: `window every ${TransferWindows.formatDuration(win.synodic)}`,
      imminent: win.departIn <= IMMINENT_S,
      showArrive: true,
      fuelText, verdict,
      routeText, sweepText,
    };
  }

  /** Verdict + engine gas cost + post-burn ΔV margin, e.g. 'REACHABLE · Gas 2.1 kg · 512 m/s left'. */
  static fuelLine(a) {
    if (!a || !a.verdict) return '';
    const xe = Number.isFinite(a.fuelKg) ? (Math.round(a.fuelKg * 10) / 10) : '\u2014';
    const left = Number.isFinite(a.budgetAfter) ? Math.round(a.budgetAfter) : '\u2014';
    return `${String(a.verdict).toUpperCase()} \u00b7 Gas ${xe} kg \u00b7 ${left} m/s left`;
  }

  /** FIELD ROUTE row, e.g. "FIELD ROUTE 6 stops · ΔV 0.41 km/s"; '' when there is no route or an empty plan. */
  static routeLine(route) {
    if (!route || !Array.isArray(route.plan) || route.plan.length === 0) return '';
    const n = route.plan.length;
    const dv = Number.isFinite(route.totalDv) ? route.totalDv.toFixed(2) : '\u2014';
    return `FIELD ROUTE ${n} stop${n !== 1 ? 's' : ''} \u00b7 \u0394V ${dv} km/s`;
  }

  /** FIELD DENSEST BAND row, e.g. "FIELD DENSEST BAND 800–900 km · 17 obj"; '' when there is no densest band. */
  static sweepLine(sweep) {
    const d = sweep && sweep.densest;
    if (!d) return '';
    return `FIELD DENSEST BAND ${Math.round(d.altMinKm)}\u2013${Math.round(d.altMaxKm)} km \u00b7 ${d.count} obj`;
  }

  _build() {
    if (this._built || typeof document === 'undefined' || !document.body) return;
    this._built = true;
    const root = document.createElement('div');
    root.id = 'ladder-transfer-windows';
    root.style.cssText = [
      'position:absolute', `left:max(${PANE_CORNER_PX}px, env(safe-area-inset-left))`, `bottom:${BOX_BOTTOM_PX}px`, 'min-width:220px',   // left edge = the MOTHER pane's
      'padding:8px 12px', 'border:1px solid rgba(0,204,255,0.4)', 'border-radius:4px',
      'background:rgba(0,16,32,0.72)', 'color:' + VisualLaw.COLORS.INFO,
      'font-family: var(--font-mono)', 'font-size:0.7rem', 'letter-spacing:0.06em',
      'z-index:34', 'pointer-events:none', 'opacity:0', 'transition:opacity 0.3s',
    ].join(';');
    document.body.appendChild(root);
    this._root = root;
  }

  show() { this._build(); this._visible = true; if (this._root) this._root.style.opacity = '1'; this._measure(); }
  hide() { this._visible = false; if (this._root) this._root.style.opacity = '0'; }

  /**
   * The box's live outer height in px (border and padding included), for panels that must clear it. Its top edge is
   * innerHeight - BOX_BOTTOM_PX - heightPx(). Null while not showing or not measured (the caller then assumes its
   * tallest state). Measured only after a markup write and at show(), never per frame.
   * @returns {number|null}
   */
  heightPx() { return (this._visible && this._boxH > 0) ? this._boxH : null; }

  /** @private A missing rect (headless DOM) leaves it unmeasured. */
  _measure() {
    const root = this._root;
    if (!root || typeof root.getBoundingClientRect !== 'function') { this._boxH = null; return; }
    let h = 0;
    try { h = Number(root.getBoundingClientRect().height); } catch (_e) { h = 0; }
    this._boxH = h > 0 ? h : null;
  }

  /**
   * @param {object|null} win - computeTransferWindow() result (or null)
   * @param {object} [opts] - { targetName, assessment, budget, route, sweep }
   * @returns {object} the display model that was rendered (readout())
   */
  refresh(win, opts = {}) {
    let simple = false;
    try { simple = !!(this._simple && this._simple()); } catch (_e) { simple = false; }
    const model = TransferWindows.readout(win, simple ? { ...opts, simple: true } : opts);
    if (!this._root) return model;
    // Structural changes paint immediately; countdown-only ticks are capped (shouldWrite). The fuel and FIELD
    // route/sweep rows are structural (NavcomFloor recomputes them on its own throttled cadence).
    const structKey = `${simple ? 'S' : 'F'}|${model.plainText || ''}|${model.plainFuelText || ''}|${model.targetName}|${model.empty}|${model.coOrbital}|${model.imminent}|${model.dvText}|${model.showArrive}|${model.fuelText}|${model.routeText}|${model.sweepText}`;
    const now = this._now();
    if (!TransferWindows.shouldWrite(structKey, this._lastStructKey, now, this._lastWriteMs)) {
      return model;
    }
    // Never pulses (INFO/planning, not THREAT). "Imminent" is double-encoded: LABEL-white depart line + [IMMINENT] tag.
    const departColor = model.imminent ? VisualLaw.COLORS.LABEL : VisualLaw.COLORS.INFO;
    const titleRow = `<div style="color:${VisualLaw.COLORS.PLAYER}">${FLOOR_TITLE} \u00b7 ${model.targetName}</div>`;
    if (model.simple) {
      // Sentence case, no numbers of the trip; the verdict keeps its colour (the WORDS carry it).
      const rowsS = [titleRow];
      if (model.plainText) rowsS.push(`<div style="color:${departColor}">${model.plainText}</div>`);
      if (model.plainFuelText) {
        const fc = model.verdict === 'reachable' ? VisualLaw.COLORS.PLAYER
          : model.verdict === 'marginal' ? VisualLaw.COLORS.VALUE : VisualLaw.COLORS.INFO;
        rowsS.push(`<div style="color:${fc}">${model.plainFuelText}</div>`);
      }
      const htmlS = rowsS.join('');
      if (htmlS !== this._lastHtml) {
        this._root.innerHTML = htmlS;
        this._measure();
        this._lastHtml = htmlS;
        this._lastStructKey = structKey;
        this._lastWriteMs = now;
      }
      return model;
    }
    const rows = [
      titleRow,
      `<div style="color:${departColor}">${model.departText}${model.imminent ? '  [IMMINENT]' : ''}</div>`,
    ];
    if (model.showArrive) rows.push(`<div>${model.transferText} \u2192 ${model.arriveText}</div>`);
    if (model.dvText) rows.push(`<div>${model.dvText}</div>`);
    if (model.fuelText) {
      // reachable = PLAYER green, marginal = VALUE gold (steady), unreachable = dim INFO (THREAT red must pulse and
      // this is a planning surface, not an alarm). Never color-alone: the WORD carries it.
      const fuelColor = model.verdict === 'reachable' ? VisualLaw.COLORS.PLAYER
        : model.verdict === 'marginal' ? VisualLaw.COLORS.VALUE
        : VisualLaw.COLORS.INFO;
      const fuelDim = model.verdict === 'unreachable' ? ';opacity:0.6' : '';
      rows.push(`<div style="color:${fuelColor}${fuelDim}">${model.fuelText}</div>`);
    }
    if (model.routeText) rows.push(`<div style="opacity:0.85">${model.routeText}</div>`);
    if (model.sweepText) rows.push(`<div style="opacity:0.85">${model.sweepText}</div>`);
    rows.push(`<div style="opacity:0.7">${model.periodText}</div>`);
    // Ticked every frame; skip the innerHTML teardown/re-parse when the markup is unchanged.
    const html = rows.join('');
    if (html !== this._lastHtml) {
      this._root.innerHTML = html;
      this._measure();
      this._lastHtml = html;
      this._lastStructKey = structKey;
      this._lastWriteMs = now;
    }
    return model;
  }

  dispose() {
    if (this._root && this._root.remove) this._root.remove();
    this._root = null;
    this._built = false;
    this._boxH = null;
    this._lastHtml = null;
    this._lastStructKey = null;
    this._lastWriteMs = -Infinity;
  }
}
