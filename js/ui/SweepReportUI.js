/**
 * SweepReportUI.js — DOM overlay that displays sweep report at end of trawl.
 * Shows stats, synergies, star rating. Auto-dismisses after timeout.
 * @module ui/SweepReportUI
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

export class SweepReportUI {
  constructor() {
    /** @type {HTMLElement|null} Overlay backdrop */
    this._overlay = null;
    /** @type {HTMLElement|null} Report panel */
    this._panel = null;
    /** @type {number} Auto-dismiss timer ID */
    this._dismissTimer = null;
    /** @type {boolean} Currently visible */
    this._visible = false;
    /** @type {boolean} Whether tutorial is active — suppress reports during tutorial
     *  @deprecated Sprint 3: always false now that TutorialSystem is removed. */
    this._tutorialActive = false;

    this._build();
    this._setupListeners();

    console.log('[SweepReportUI] Initialized');
  }

  // ==========================================================================
  // BUILD DOM
  // ==========================================================================

  /** @private */
  _build() {
    // Inject keyframe animations
    if (!document.getElementById('sweep-report-style')) {
      const style = document.createElement('style');
      style.id = 'sweep-report-style';
      style.textContent = `
        @keyframes sweepReportFadeIn {
          0% { opacity: 0; transform: translate(-50%, -50%) scale(0.9); }
          100% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        }
        @keyframes sweepReportFadeOut {
          0% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
          100% { opacity: 0; transform: translate(-50%, -50%) scale(0.9); }
        }
        @keyframes sweepStarPop {
          0% { transform: scale(0); opacity: 0; }
          60% { transform: scale(1.3); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
      `;
      document.head.appendChild(style);
    }

    // Overlay backdrop
    this._overlay = document.createElement('div');
    this._overlay.id = 'sweep-report-overlay';
    Object.assign(this._overlay.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '100%',
      height: '100%',
      background: 'rgba(0, 0, 0, 0.6)',
      zIndex: '200',
      display: 'none',
      cursor: 'pointer',
    });

    // Panel
    this._panel = document.createElement('div');
    this._panel.id = 'sweep-report-panel';
    Object.assign(this._panel.style, {
      position: 'absolute',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      width: '400px',
      maxHeight: '80vh',
      overflowY: 'auto',
      background: 'rgba(0, 0, 0, 0.85)',
      border: '1px solid #ffaa00',
      borderRadius: '4px',
      padding: '24px 28px',
      fontFamily: "'Courier New', monospace",
      color: '#e0e0e0',
      fontSize: '13px',
      lineHeight: '1.6',
      boxShadow: '0 0 30px rgba(255, 170, 0, 0.15)',
      animation: 'sweepReportFadeIn 0.4s ease-out forwards',
    });

    this._overlay.appendChild(this._panel);
    document.body.appendChild(this._overlay);

    // Click overlay to dismiss
    this._overlay.addEventListener('click', (e) => {
      if (e.target === this._overlay || e.target.id === 'sweep-report-continue-btn') {
        this.dismiss();
      }
    });
  }

  // ==========================================================================
  // EVENT LISTENERS
  // ==========================================================================

  /** @private */
  _setupListeners() {
    eventBus.on(Events.SWEEP_REPORT, (data) => {
      this.show(data);
    });

  }

  // ==========================================================================
  // SHOW / HIDE
  // ==========================================================================

  /**
   * Display the sweep report overlay.
   * @param {object} report — compiled sweep report data from RewardSystem
   */
  show(report) {
    if (this._visible) return;

    // Suppress sweep report during tutorial — it's distracting and shows no useful info
    if (this._tutorialActive) return;

    this._visible = true;

    // Render content
    this._panel.innerHTML = this._renderReport(report);
    this._panel.style.animation = 'sweepReportFadeIn 0.4s ease-out forwards';
    this._overlay.style.display = 'block';

    // Stagger star animations
    const stars = this._panel.querySelectorAll('.sweep-star');
    stars.forEach((star, i) => {
      star.style.animation = `sweepStarPop 0.3s ease-out ${0.3 + i * 0.15}s forwards`;
      star.style.opacity = '0';
    });

    // Key/click dismiss handler
    this._keyHandler = (e) => {
      e.preventDefault();
      this.dismiss();
    };
    setTimeout(() => {
      document.addEventListener('keydown', this._keyHandler, { once: true });
    }, 500); // brief delay so player doesn't accidentally dismiss

    // Auto-dismiss timer
    const timeout = (Constants.SWEEP_REPORT_TIMEOUT || 15) * 1000;
    this._dismissTimer = setTimeout(() => this.dismiss(), timeout);
  }

  /**
   * Dismiss the report overlay.
   */
  dismiss() {
    if (!this._visible) return;
    this._visible = false;

    // Clean up key handler if still attached
    if (this._keyHandler) {
      document.removeEventListener('keydown', this._keyHandler);
      this._keyHandler = null;
    }

    // Clear auto-dismiss
    if (this._dismissTimer) {
      clearTimeout(this._dismissTimer);
      this._dismissTimer = null;
    }

    // Fade out then hide
    this._panel.style.animation = 'sweepReportFadeOut 0.3s ease-in forwards';
    setTimeout(() => {
      this._overlay.style.display = 'none';
    }, 320);

    eventBus.emit(Events.SWEEP_REPORT_DISMISSED);
  }

  // ==========================================================================
  // RENDER
  // ==========================================================================

  /**
   * Render the report HTML.
   * @private
   * @param {object} r — report data
   * @returns {string} HTML string
   */
  _renderReport(r) {
    const pct = r.clearPercentage || 0;
    const timeMM = Math.floor((r.timeElapsed || 0) / 60);
    const timeSS = Math.floor((r.timeElapsed || 0) % 60);
    const timeStr = `${String(timeMM).padStart(2, '0')}:${String(timeSS).padStart(2, '0')}`;

    // Stars
    const starCount = r.stars || 1;
    let starsHTML = '';
    for (let i = 0; i < 5; i++) {
      const filled = i < starCount;
      starsHTML += `<span class="sweep-star" style="
        display: inline-block;
        font-size: 28px;
        margin: 0 3px;
        color: ${filled ? '#ffd700' : '#444'};
        text-shadow: ${filled ? '0 0 8px rgba(255,215,0,0.6)' : 'none'};
      ">★</span>`;
    }

    // Synergies list
    let synergiesHTML = '<span style="color:#666;">None</span>';
    if (r.synergiesTriggered && r.synergiesTriggered.length > 0) {
      synergiesHTML = r.synergiesTriggered.map(s =>
        `<span style="color:#00e5ff;">▸ ${s.name}</span> <span style="color:#888;">(+${s.points})</span>`
      ).join('<br>');
    }

    // Percentage color
    let pctColor = '#ff4444';
    if (pct >= 75) pctColor = '#00ff88';
    else if (pct >= 50) pctColor = '#ffaa00';
    else if (pct >= 25) pctColor = '#ffcc44';

    return `
      <div style="text-align:center; margin-bottom:16px;">
        <div style="
          font-size: 20px;
          font-weight: bold;
          letter-spacing: 4px;
          color: #ffd700;
          text-shadow: 0 0 12px rgba(255,215,0,0.4);
          margin-bottom: 8px;
        ">SWEEP REPORT</div>
        <div style="margin: 12px 0 8px 0;">${starsHTML}</div>
      </div>

      <div style="border-top:1px solid #333; padding-top:12px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
          <span style="color:#888;">Debris Captured</span>
          <span><b>${r.totalCaptured || 0}</b> / ${r.totalTargets || 0}
            <span style="color:${pctColor};">(${pct}%)</span>
          </span>
        </div>

        <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
          <span style="color:#888;">Time</span>
          <span>${timeStr}</span>
        </div>

        <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
          <span style="color:#888;">Arms Deployed</span>
          <span>${r.armsUsed || 0}</span>
        </div>

        <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
          <span style="color:#888;">Arm Catches</span>
          <span>${r.armCatches || 0}</span>
        </div>

        <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
          <span style="color:#888;">Lasso Catches</span>
          <span>${r.lassoCatches || 0}</span>
        </div>
      </div>

      <div style="border-top:1px solid #333; padding-top:10px; margin-top:8px;">
        <div style="color:#888; margin-bottom:4px;">Synergies</div>
        <div style="margin-left:8px; margin-bottom:8px;">${synergiesHTML}</div>
      </div>

      <div style="border-top:1px solid #333; padding-top:10px; margin-top:4px;">
        <div style="display:flex; justify-content:space-between;">
          <span style="color:#888;">Bonus Points</span>
          <span style="color:#ffd700; font-weight:bold; font-size:15px;">
            +${r.totalBonusPoints || 0}
          </span>
        </div>
      </div>

      ${this._renderToolEfficiency(r)}

      <div style="text-align:center; margin-top:20px;">
        <button id="sweep-report-continue-btn" style="
          background: rgba(255,170,0,0.15);
          border: 1px solid #ffaa00;
          color: #ffaa00;
          font-family: 'Courier New', monospace;
          font-size: 13px;
          letter-spacing: 2px;
          padding: 8px 28px;
          cursor: pointer;
          border-radius: 2px;
          transition: background 0.2s;
        " onmouseover="this.style.background='rgba(255,170,0,0.3)'"
           onmouseout="this.style.background='rgba(255,170,0,0.15)'">
          CONTINUE
        </button>
        <div style="font-size:10px; color:#555; margin-top:8px;">
          Press any key or click to dismiss
        </div>
      </div>
    `;
  }

  /**
   * Render the capture efficiency table (ST-4.E).
   * @private
   * @param {object} r — report data (enriched with toolStats by ScoringSystem)
   * @returns {string} HTML string (empty if no tool data)
   */
  _renderToolEfficiency(r) {
    if (!r.toolStats || r.toolStats.length === 0) return '';

    let html = `<div style="border-top:1px solid #333; padding-top:10px; margin-top:8px;">`;
    html += `<div style="color:#ffaa00; font-size:11px; letter-spacing:1.5px; margin-bottom:8px;">CAPTURE EFFICIENCY</div>`;
    html += `<table style="width:100%; font-family:'Courier New',monospace; font-size:11px; border-collapse:collapse;">`;
    html += `<tr style="color:#667788;"><td>Method</td><td style="text-align:center;">Catches</td><td style="text-align:right;">ΔV/catch</td></tr>`;

    for (const t of r.toolStats) {
      const star = t.isBest ? ' ★' : '';
      const color = t.isBest ? '#44ff88' : '#aabbcc';
      html += `<tr style="color:${color};">`;
      html += `<td style="padding:2px 0;">${t.name.toUpperCase()}${star}</td>`;
      html += `<td style="text-align:center;">${t.catches}</td>`;
      html += `<td style="text-align:right;">${t.dvPerCatch.toFixed(2)} m/s</td>`;
      html += `</tr>`;
    }

    html += `</table>`;
    html += `</div>`;
    return html;
  }
}

export default SweepReportUI;
