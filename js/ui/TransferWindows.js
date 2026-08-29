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
 * Pure formatting (`formatDuration`, `readout`) is static + THREE/DOM-free so the
 * planning readout is unit-testable exactly like the legacy DebrisMap readout
 * (coOrbitalReadout precedent). The DOM panel is fully guarded (inert headless).
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

export class TransferWindows {
  constructor() {
    this._root = null;
    this._built = false;
    this._visible = false;
  }

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
   * @returns {{
   *   empty:boolean, coOrbital:boolean, targetName:string,
   *   departText:string, transferText:string, arriveText:string,
   *   dvText:string, periodText:string, imminent:boolean, showArrive:boolean
   * }}
   */
  static readout(win, opts = {}) {
    const targetName = opts.targetName || '\u2014';
    if (!win) {
      return {
        empty: true, coOrbital: false, targetName,
        departText: 'NO TARGET', transferText: '', arriveText: '',
        dvText: '', periodText: 'aim a cluster to plan a transfer',
        imminent: false, showArrive: false,
      };
    }
    const dvText = `\u0394V ${Math.round(win.dvTotal)} m/s`;
    const co = coOrbitalReadout(win);
    if (co) {
      return {
        empty: false, coOrbital: true, targetName,
        departText: co.departText, transferText: '', arriveText: '',
        dvText, periodText: co.periodText, imminent: false, showArrive: co.showArrive,
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
    };
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
   * @param {object} [opts] - { targetName }
   * @returns {object} the display model that was rendered (readout())
   */
  refresh(win, opts = {}) {
    const model = TransferWindows.readout(win, opts);
    if (!this._root) return model;
    // The window title never pulses (it is INFO/planning, not THREAT). "Imminent"
    // is double-encoded: SELECTION-white depart line + the [IMMINENT] tag.
    const departColor = model.imminent ? VisualLaw.COLORS.SELECTION : VisualLaw.COLORS.INFO;
    const rows = [
      `<div style="color:${VisualLaw.COLORS.PLAYER}">NAVCOM · ${model.targetName}</div>`,
      `<div style="color:${departColor}">${model.departText}${model.imminent ? '  [IMMINENT]' : ''}</div>`,
    ];
    if (model.showArrive) rows.push(`<div>${model.transferText} → ${model.arriveText}</div>`);
    if (model.dvText) rows.push(`<div>${model.dvText}</div>`);
    rows.push(`<div style="opacity:0.7">${model.periodText}</div>`);
    this._root.innerHTML = rows.join('');
    return model;
  }

  dispose() {
    if (this._root && this._root.remove) this._root.remove();
    this._root = null;
    this._built = false;
  }
}
