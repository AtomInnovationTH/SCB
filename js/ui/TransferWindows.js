/**
 * TransferWindows.js — the Zoom Ladder F6 (NAVCOM) transfer-window surface
 * (S5, M3, FloorContract.FLOORS[5].costume.arrive 'TransferWindows').
 *
 * F6 is the orbital-neighborhood PLANNING floor: it reads the transfer window
 * from the player's orbit to the focused debris cluster (the §24 lesson — "space
 * is periodic, go now is usually wrong") and surfaces the depart/transfer/arrive
 * countdown + ΔV. The window math lives in js/entities/LaunchWindow.js
 * (computeTransferWindow / coOrbitalReadout); this module is the read-only
 * costume that formats + paints it.
 *
 * Pure formatting (`formatDuration`, `readout`, `fuelLine`) is static +
 * THREE/DOM-free so the planning readout is unit-testable exactly like the
 * legacy DebrisMap readout (coOrbitalReadout precedent). The DOM panel is fully
 * guarded (inert headless). FUEL-REACHABILITY: `readout`/`refresh` accept an
 * optional `opts.assessment` (ReachabilityModel.assess result) and surface a
 * verdict + xenon + margin row; without it the model/markup are unchanged.
 *
 * FLOOR CONTENT (parallel track): no game loop, no autopilot, no event emission —
 * NavcomFloor feeds it a window; the plan-transfer VERB (Space on F6) is what
 * commits/engages, wired by the serial track.
 *
 * @module ui/TransferWindows
 */

import { Constants } from '../core/Constants.js';
import { VisualLaw } from '../core/VisualLaw.js';
import { coOrbitalReadout } from '../entities/LaunchWindow.js';

/** T-minus threshold at which a window reads "imminent" (shared with DebrisMap). */
const IMMINENT_S = Constants.DEBRIS_MAP.WINDOW_IMMINENT_S;

/**
 * G1 (post-M3 play-test): minimum real-time interval between innerHTML writes.
 * The M3-review html cache capped the churn at the rate the TEXT changes —
 * ~1 Hz at 1× (formatDuration rounds to whole seconds). Under F6 warp (20×)
 * the countdown text legitimately changes ~20×/s, so the cache alone lets the
 * panel tear down/re-parse its rows at 20 Hz on a 120 fps machine. This cap
 * bounds DOM writes to ≤4 Hz REAL regardless of warp; STRUCTURAL changes
 * (target/emptiness/imminence/ΔV text) bypass it so nothing important lags.
 * Documented in docs/ladder/01-numbers.md §"Post-M3 glue".
 */
const DOM_WRITE_MIN_INTERVAL_MS = 250;

/** Monotonic ms clock (DOM-guarded module — Date.now fallback for headless). */
const _nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class TransferWindows {
  /**
   * @param {object} [deps]
   * @param {function} [deps.now] - monotonic ms clock (tests); defaults to performance.now
   */
  constructor(deps = {}) {
    this._now = deps.now || _nowMs;
    this._root = null;
    this._built = false;
    this._visible = false;
    this._lastHtml = null;      // last painted markup — skips per-frame innerHTML churn
    this._lastStructKey = null; // last painted STRUCTURAL key (shouldWrite)
    this._lastWriteMs = -Infinity; // last innerHTML write (real time)
  }

  /**
   * G1 pure gate: should refresh() write the DOM this frame?
   * Structural changes always write; countdown-only changes are capped at
   * DOM_WRITE_MIN_INTERVAL_MS (250 ms → ≤4 Hz real) so F6 warp can't turn the
   * per-second countdown into a per-frame innerHTML teardown. Pure + static so
   * the cap is headless-pinnable (test-NavcomFloor).
   * @param {string} structKey  - structural fingerprint of the new model
   * @param {string|null} lastStructKey - previously painted fingerprint
   * @param {number} nowMs      - monotonic clock
   * @param {number} lastWriteMs - time of the previous DOM write
   * @returns {boolean}
   */
  static shouldWrite(structKey, lastStructKey, nowMs, lastWriteMs) {
    if (structKey !== lastStructKey) return true;
    return (nowMs - lastWriteMs) >= DOM_WRITE_MIN_INTERVAL_MS;
  }

  /** G1 pin surface: the DOM-write cap (ms). */
  static get DOM_WRITE_MIN_INTERVAL_MS() { return DOM_WRITE_MIN_INTERVAL_MS; }

  /**
   * Format a duration in seconds as a compact T-minus string.
   * @param {number} s - seconds (0 / negative → "OPEN NOW"; non-finite → "—")
   * @returns {string}
   */
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
   * Build the display model for a transfer window. Pure — no DOM.
   * @param {object|null} win - a computeTransferWindow() result (or null)
   * @param {object} [opts]
   * @param {string} [opts.targetName] - focused cluster name
   * @param {object} [opts.assessment] - FUEL-REACHABILITY: the focused cluster's
   *                 ReachabilityModel.assess() result ({verdict, fuelKg,
   *                 budgetAfter, ...}). Absent → fuelText '' (pre-reach model).
   * @param {object} [opts.budget] - getMassBudget() sample (reserved; the row
   *                 reads budgetAfter so remaining fuel is post-burn honest)
   * @returns {{
   *   empty:boolean, coOrbital:boolean, targetName:string,
   *   departText:string, transferText:string, arriveText:string,
   *   dvText:string, periodText:string, imminent:boolean, showArrive:boolean,
   *   fuelText:string, verdict:?string
   * }}
   */
  static readout(win, opts = {}) {
    const targetName = opts.targetName || '\u2014';
    const a = opts.assessment || null;
    const fuelText = (win && a) ? TransferWindows.fuelLine(a) : '';
    const verdict = (win && a) ? (a.verdict || null) : null;
    if (!win) {
      return {
        empty: true, coOrbital: false, targetName,
        departText: 'NO TARGET', transferText: '', arriveText: '',
        dvText: '', periodText: 'aim a cluster to plan a transfer',
        imminent: false, showArrive: false,
        fuelText: '', verdict: null,
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
    };
  }

  /**
   * FUEL-REACHABILITY row text: verdict + xenon cost + post-burn ΔV margin,
   * e.g. 'REACHABLE · Xe 2.1 kg · 512 m/s left'. Pure + static.
   * @param {{verdict:string, fuelKg:number, budgetAfter:number}} a
   * @returns {string}
   */
  static fuelLine(a) {
    if (!a || !a.verdict) return '';
    const xe = Number.isFinite(a.fuelKg) ? (Math.round(a.fuelKg * 10) / 10) : '\u2014';
    const left = Number.isFinite(a.budgetAfter) ? Math.round(a.budgetAfter) : '\u2014';
    return `${String(a.verdict).toUpperCase()} \u00b7 Xe ${xe} kg \u00b7 ${left} m/s left`;
  }

  // ── DOM (guarded) ───────────────────────────────────────────────────────────

  /** @private */
  _build() {
    if (this._built || typeof document === 'undefined' || !document.body) return;
    this._built = true;
    const root = document.createElement('div');
    root.id = 'ladder-transfer-windows';
    root.style.cssText = [
      'position:absolute', 'left:16px', 'bottom:16px', 'min-width:220px',
      'padding:8px 12px', 'border:1px solid rgba(0,204,255,0.4)', 'border-radius:4px',
      'background:rgba(0,16,32,0.72)', 'color:' + VisualLaw.COLORS.INFO,
      'font-family:"Courier New",monospace', 'font-size:0.7rem', 'letter-spacing:0.06em',
      'z-index:34', 'pointer-events:none', 'opacity:0', 'transition:opacity 0.3s',
    ].join(';');
    document.body.appendChild(root);
    this._root = root;
  }

  show() { this._build(); this._visible = true; if (this._root) this._root.style.opacity = '1'; }
  hide() { this._visible = false; if (this._root) this._root.style.opacity = '0'; }

  /**
   * Paint the transfer-window readout for the focused cluster.
   * @param {object|null} win - computeTransferWindow() result (or null)
   * @param {object} [opts] - { targetName, assessment, budget }
   * @returns {object} the display model that was rendered (readout())
   */
  refresh(win, opts = {}) {
    const model = TransferWindows.readout(win, opts);
    if (!this._root) return model;
    // G1 warp churn cap: structural changes paint immediately; countdown-only
    // ticks are bounded to ≤4 Hz real (see shouldWrite / DOM_WRITE_MIN_INTERVAL_MS).
    // The fuel row is structural: a verdict/margin change repaints immediately.
    const structKey = `${model.targetName}|${model.empty}|${model.coOrbital}|${model.imminent}|${model.dvText}|${model.showArrive}|${model.fuelText}`;
    const now = this._now();
    if (!TransferWindows.shouldWrite(structKey, this._lastStructKey, now, this._lastWriteMs)) {
      return model;
    }
    // The window title never pulses (it is INFO/planning, not THREAT). "Imminent"
    // is double-encoded: SELECTION-white depart line + the [IMMINENT] tag.
    const departColor = model.imminent ? VisualLaw.COLORS.SELECTION : VisualLaw.COLORS.INFO;
    const rows = [
      `<div style="color:${VisualLaw.COLORS.PLAYER}">NAVCOM \u00b7 ${model.targetName}</div>`,
      `<div style="color:${departColor}">${model.departText}${model.imminent ? '  [IMMINENT]' : ''}</div>`,
    ];
    if (model.showArrive) rows.push(`<div>${model.transferText} \u2192 ${model.arriveText}</div>`);
    if (model.dvText) rows.push(`<div>${model.dvText}</div>`);
    if (model.fuelText) {
      // Verdict color: reachable = PLAYER green, marginal = VALUE gold (steady),
      // unreachable = dim INFO (the WORD carries it — THREAT red must pulse and
      // this is a planning surface, not an alarm). Never color-alone.
      const fuelColor = model.verdict === 'reachable' ? VisualLaw.COLORS.PLAYER
        : model.verdict === 'marginal' ? VisualLaw.COLORS.VALUE
        : VisualLaw.COLORS.INFO;
      const fuelDim = model.verdict === 'unreachable' ? ';opacity:0.6' : '';
      rows.push(`<div style="color:${fuelColor}${fuelDim}">${model.fuelText}</div>`);
    }
    rows.push(`<div style="opacity:0.7">${model.periodText}</div>`);
    // M3 review fix: refresh() is ticked every frame while F6 is active, but the
    // readout only changes ~1/s at 1× (formatDuration rounds to seconds) — skip
    // the full innerHTML teardown/re-parse when the markup is unchanged.
    const html = rows.join('');
    if (html !== this._lastHtml) {
      this._root.innerHTML = html;
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
    this._lastHtml = null;
    this._lastStructKey = null;
    this._lastWriteMs = -Infinity;
  }
}
