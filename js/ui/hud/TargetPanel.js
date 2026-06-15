/**
 * TargetPanel.js — Target list sidebar with tracked targets,
 * untracked sensor contacts, and active satellites.
 * S6-A: CSS grid layout, collapsed/expanded rows, reduced caps.
 * @module ui/hud/TargetPanel
 */

import { Constants } from '../../core/Constants.js';
import { eventBus } from '../../core/EventBus.js';
import { Events } from '../../core/Events.js';
import { computeTotalSalvageDeltaV } from '../../entities/OrbitalMechanics.js';
import { assessNetFit } from '../../entities/CaptureNet.js';
import { computeToolOdds, computeBestTool, toolShortLabel } from '../../systems/ToolOdds.js';
import { dossierSystem, appraiseSalvage } from '../../systems/DossierSystem.js';
import { PaneChrome } from './PaneChrome.js';

export class TargetPanel {
  constructor(container) {
    this._container = container;
    this._sortMode = 'tpi';  // FIX_PLAN §4: Default to composite TPI sort
    this._armManager = null;

    /** Currently-selected target ID (public for coordinator read-access) */
    this.selectedTargetId = null;

    /** @type {Object<string, HTMLElement>} DOM panels for show/hide */
    this.panels = {};

    /** @type {Set<number>} UX-3 #9: IDs of targets newly discovered (pending animation) */
    this._newlyDiscovered = new Set();

    // UX-3 #9: Track newly discovered targets for entry animation
    eventBus.on(Events.TARGET_DISCOVERED, (data) => {
      if (data && data.target && data.target.id !== undefined) {
        this._newlyDiscovered.add(data.target.id);
      }
    });

    // UX Fix F: Clear selected target when debris is removed/captured
    eventBus.on(Events.TARGET_CLEARED, () => {
      this.selectedTargetId = null;
    });

    // FIX: Self-healing listener — TargetPanel stays in sync with TargetSelector
    // even if external setSelectedTarget() calls fail (exception, missing ref, etc.)
    eventBus.on(Events.TARGET_SELECTED, (data) => {
      if (data && data.id != null) {
        this.selectedTargetId = data.id;
      }
    });

    this._build();
  }

  // ==========================================================================
  // STYLES
  // ==========================================================================

  /** @private Inject CSS classes for target panel layout (once only) */
  _injectStyles() {
    if (document.getElementById('target-panel-styles')) return;
    const style = document.createElement('style');
    style.id = 'target-panel-styles';
    style.textContent = `
        /* Target Panel Layout */
        .target-row {
            display: grid;
            grid-template-columns: 16px 72px 1fr 72px 16px;
            align-items: center;
            padding: 2px 4px;
            font-size: 11px;
            font-family: monospace;
            border-left: 2px solid transparent;
            border-radius: 2px;
            margin: 1px 0;
            min-height: 20px;
            cursor: pointer;
            transition: background 0.2s;
            color: #aaaaaa;
        }
        .target-row:hover {
            background: rgba(0, 255, 136, 0.06);
        }
        .target-row.selected {
            border-left: 3px solid #00ccff;
            background: rgba(0, 204, 255, ${Constants.SELECTED_ROW_ALPHA});
            box-shadow: 0 0 8px rgba(0, 204, 255, ${Constants.SELECTED_ROW_GLOW_ALPHA}) inset;
        }
        .target-row .type-icon {
            font-size: 12px;
            text-align: center;
            line-height: 1;
        }
        .target-row .type-icon.large {
            font-weight: bold;
        }
        .target-row .target-name {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .target-row .target-dist {
            text-align: right;
            font-variant-numeric: tabular-nums;
        }
        .target-row .target-dv {
            text-align: right;
            font-variant-numeric: tabular-nums;
        }
        .target-row .range-dot {
            text-align: center;
            font-size: 10px;
        }
        
        /* Expanded (selected) row */
        .target-row.selected .target-name {
            font-size: 12px;
            font-weight: bold;
            color: #00ccff;
            text-shadow: 0 0 6px rgba(0, 204, 255, ${Constants.SELECTED_ROW_TEXT_GLOW});
        }
        .target-expanded {
            grid-column: 1 / -1;
            padding: 2px 0 2px 20px;
            font-size: 11px;
        }
        .target-expanded .econ-line {
            display: flex;
            justify-content: space-between;
            gap: 8px;
            color: #aaaaaa;
        }
        .target-expanded .hint-line {
            font-size: 10px;
            color: #666666;
            margin-top: 1px;
        }
        
        /* Section headers */
        .target-section-header {
            font-size: 11px;
            font-weight: normal;
            opacity: 0.7;
            padding: 4px 4px 2px;
            user-select: none;
        }
        
        /* Sort button */
        .target-sort-btn {
            font-size: 10px;
            color: #888888;
            background: none;
            border: 1px solid rgba(136,136,136,0.3);
            border-radius: 3px;
            padding: 1px 6px;
            cursor: pointer;
            font-family: monospace;
            opacity: 0.5;
            transition: opacity 0.2s;
        }
        .target-sort-btn:hover {
            opacity: 1.0;
        }
        
        /* Untracked row (simpler grid) */
        .untracked-row {
            display: grid;
            grid-template-columns: 40px 1fr 60px;
            align-items: center;
            padding: 1px 4px;
            font-size: 11px;
            font-family: monospace;
            color: #aaaaaa;
            min-height: 18px;
        }
        
        /* Active sat row */
        .activesat-row {
            display: grid;
            grid-template-columns: 1fr 60px;
            align-items: center;
            padding: 1px 4px;
            font-size: 11px;
            font-family: monospace;
            color: #aaaaaa;
            min-height: 18px;
        }
        
        /* Section separators */
        .target-section {
            border-top: 1px solid rgba(0, 255, 136, 0.15);
            margin-top: 4px;
            padding-top: 4px;
        }
        .target-section:empty,
        .target-section.hidden {
            display: none;
        }
        
        /* Progressive data reveal */
        .data-unknown {
            color: #444444;
            font-style: italic;
        }
        .data-estimated::before {
            content: '';
        }
        
        /* UX-3 #9: Discovery slide-in animation */
        @keyframes target-discover {
            from { opacity: 0; transform: translateX(20px); }
            to   { opacity: 1; transform: translateX(0); }
        }
        .target-row.discovered-new {
            animation: target-discover 0.4s ease-in-out forwards;
        }
    `;
    document.head.appendChild(style);
  }

  // ==========================================================================
  // BUILD DOM
  // ==========================================================================

  /** @private Create a styled HUD panel */
  _createPanel(id, styles) {
    const div = document.createElement('div');
    div.id = id;
    div.className = 'hud-panel';
    Object.assign(div.style, styles);
    this._container.appendChild(div);
    return div;
  }

  /**
   * Show/hide the target pane (hotkey revamp 2026-06-14 — the 0 key,
   * "Target pane" toggle). Toggles the panel container's display.
   */
  toggleVisible() {
    const panel = this.panels && this.panels.targets;
    if (!panel) return;
    const hidden = panel.style.display === 'none';
    panel.style.display = hidden ? '' : 'none';
  }

  /** @private */
  _build() {
    this._injectStyles();

    this.panels.targets = this._createPanel('hud-targets-panel', {
      position: 'relative',
      maxHeight: 'calc(100vh - 326px)',
      overflowY: 'auto',
      outline: 'none',
    });
    this.panels.targets.dataset.hudGroup = 'target-list';
    this.panels.targets.dataset.activateKey = 'S';
    this.panels.targets.tabIndex = -1;
    this.panels.targets.style.pointerEvents = 'auto';
    this.panels.targets.style.cursor = 'default';

    this.panels.targets.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;padding-right:24px;">
        <span class="target-section-header" style="color:#00ff88;padding:0;">TRACKED TARGETS <span style="opacity:0.4;font-size:10px;">[Tab]</span></span>
        <button id="hud-sort-btn" class="target-sort-btn" title="Click to cycle sort">TPI ↑</button>
      </div>
      <div id="hud-targets-min-summary" data-pane-show="min" style="display:none;font-size:11px;color:#00ff88;opacity:0.7;">. </div>
      <div data-pane-hide="min">
        <div id="hud-target-list"></div>
        <div id="hud-untracked-section" class="target-section">
          <div class="target-section-header" style="color:#ffaa00;">UNTRACKED (SENSOR)</div>
          <div id="hud-untracked-list"></div>
        </div>
        <div id="hud-activesat-section" class="target-section">
          <div class="target-section-header" style="color:#ffffff;">ACTIVE SATS</div>
          <div id="hud-activesat-list"></div>
        </div>
      </div>
    `;

    // Sort button handler — FIX_PLAN §4: 4-way cycle tpi → deltaV → distance → points → tpi
    const sortBtn = this.panels.targets.querySelector('#hud-sort-btn');
    if (sortBtn) {
      const SORT_CYCLE = ['tpi', 'deltaV', 'distance', 'points'];
      const SORT_LABELS = {
        tpi: 'TPI ↑',
        deltaV: 'ΔV ↑',
        distance: 'Dist ↑',
        points: 'Pts ↓',
      };
      sortBtn.addEventListener('click', () => {
        const idx = SORT_CYCLE.indexOf(this._sortMode);
        const next = SORT_CYCLE[(idx + 1) % SORT_CYCLE.length];
        this._sortMode = next;
        sortBtn.textContent = SORT_LABELS[next];
      });
    }

    // Event delegation for target row clicks
    const listEl = this.panels.targets.querySelector('#hud-target-list');
    if (listEl) {
      listEl.addEventListener('click', (e) => {
        const row = e.target.closest('.target-row');
        if (!row) return;
        const id = parseInt(row.dataset.id);
        if (isNaN(id)) return;
        this.selectedTargetId = id;
        eventBus.emit(Events.HUD_TARGET_CLICK, { id });
      });
    }

    // --- Resize chrome (3-step: min / normal / max) ---
    // min: header + one-line count only. normal: standard list. max: taller list.
    this._chrome = new PaneChrome({
      pane: this.panels.targets,
      keyLabel: 'Tab',
      steps: ['min', 'normal', 'max'],
      initial: 'normal',
      color: '#00ff88',
      title: 'Targets size. Click to cycle min / normal / max',
      onStep: (step) => {
        // Grow the scroll cap when maximised; restore otherwise.
        this.panels.targets.style.maxHeight = (step === 'max')
          ? 'calc(100vh - 120px)' : 'calc(100vh - 326px)';
        this._updateMinSummary();
      },
    });
  }

  /** @private Populate the minimized one-line target summary. */
  _updateMinSummary() {
    const el = this.panels.targets && this.panels.targets.querySelector('#hud-targets-min-summary');
    if (!el) return;
    const n = this._lastTrackedCount || 0;
    el.textContent = n > 0 ? `${n} tracked target${n === 1 ? '' : 's'}` : 'No tracked targets';
  }

  // ==========================================================================
  // PUBLIC
  // ==========================================================================

  /**
   * Set the selected target ID (called from coordinator or external source).
   * @param {number} id
   */
  setSelectedTarget(id) {
    this.selectedTargetId = id;
  }

  /**
   * Set the ArmManager reference for arm-range display.
   * @param {import('../../entities/ArmManager.js').ArmManager} armManager
   */
  setArmManager(armManager) {
    this._armManager = armManager;
  }

  /**
   * @private Phase 0.1 (capture-feedback overhaul): the daughter whose net
   * class judges the capture-fit badge — the player-selected arm when one is
   * selected, else the next-available (docked, charged, fuelled) daughter.
   * @returns {object|null} ArmUnit or null when no arm context exists
   */
  _getFitBadgeArm() {
    const am = this._armManager;
    if (!am || !Array.isArray(am.arms) || am.arms.length === 0) return null;
    const sel = (typeof am.getSelectedArm === 'function') ? am.getSelectedArm() : null;
    if (sel) return sel;
    return am.arms.find(a => a.state === 'DOCKED' && a.springCharged && a.fuel > 0) || null;
  }

  /**
   * @private Phase 1c (capture-feedback overhaul): best-tool + odds badge for
   * one target judged by one arm — `NET 92%` / `GRAB\u25B6 95%` / `TOO WIDE`.
   * Uses the same ToolOdds model as the reticle odds strip (SSOT).
   * @returns {string} HTML span
   */
  _renderBestToolBadge(arm, t) {
    const toolset = arm.toolset
      || (Constants.DAUGHTER_TOOLSETS && Constants.DAUGHTER_TOOLSETS[arm.type])
      || ['NET'];
    const netCount = (typeof arm.getNetInventory === 'function') ? arm.getNetInventory() : undefined;
    // Range: when the arm is already station-keeping THIS target, use its live
    // standoff so the badge matches the reticle odds strip exactly (SSOT).
    // Otherwise omit it — computeToolOdds assumes the 50 m nominal standoff,
    // which is the honest planning number for a not-yet-dispatched arm (the
    // mother→target distance is the wrong axis: capture happens at standoff).
    let range;
    if (arm._stationKeepTarget && arm._stationKeepTarget === t
        && typeof arm._standoffR === 'number' && arm._standoffR > 0) {
      range = arm._standoffR;
    }
    const odds = computeToolOdds({
      armType: arm.type,
      toolset,
      target: t,
      range,
      netCount,
      padUvDoses: arm._padUvCureDosesRemaining,
    });
    const best = computeBestTool(odds, toolset);
    const o = odds[best];
    const label = toolShortLabel(best);
    if (o && o.p != null && o.p > 0) {
      const cap = (Constants.TOOL_ODDS && Constants.TOOL_ODDS.DISPLAY_CAP) ?? 0.99;
      const pct = Math.round(Math.min(o.p, cap) * 100);
      const col = pct >= 80 ? '#00ffaa' : pct >= 50 ? '#ffd166' : '#ff7755';
      return `<span style="color:${col};font-size:9px;font-weight:bold;" title="Best tool odds (${arm.type})">${label} ${pct}%</span>`;
    }
    // Nothing rollable — name the blocker (e.g. TOO WIDE / EMPTY).
    const netBlocker = (odds.NET && odds.NET.blocker) || (o && o.blocker) || 'NO TOOL';
    const word = netBlocker === 'WIDE' ? 'TOO WIDE'
      : netBlocker === 'HEAVY' ? 'TOO HEAVY' : netBlocker;
    return `<span style="color:#ff7755;font-size:9px;font-weight:bold;" title="No viable tool (${arm.type})">${word}</span>`;
  }

  /**
   * Update the target list display. Called at 2 Hz from the coordinator.
   * @param {object} data
   * @param {Array}  data.cachedTargets
   * @param {Array}  data.cachedUntracked
   * @param {Array}  data.cachedActiveSats
   */
  update(data) {
    this._playerOrbit = data.playerOrbit || null;
    this._updateTargetList(data.cachedTargets, data.cachedUntracked, data.cachedActiveSats);
  }

  // ==========================================================================
  // PRIVATE — TARGET LIST
  // ==========================================================================

  /** @private Update enhanced 3-section target list */
  _updateTargetList(cachedTargets, cachedUntracked, cachedActiveSats) {
    // Track count for the minimized one-line summary.
    this._lastTrackedCount = Array.isArray(cachedTargets) ? cachedTargets.length : 0;
    if (this._chrome && this._chrome.isMinimized) this._updateMinSummary();

    // --- TRACKED TARGETS ---
    const listEl = document.getElementById('hud-target-list');
    if (listEl) {
      // Get max arm range from arm manager
      let maxArmRangeKm = 0;
      if (this._armManager) {
        const statuses = this._armManager.getAllStatus();
        for (const arm of statuses) {
          if (arm.state === 'DOCKED' && arm.fuel > 5) {
            const rangeKm = arm.type === 'weaver'
              ? Constants.WEAVER_TETHER_LENGTH / 1000
              : Constants.SPINNER_TETHER_LENGTH / 1000;
            maxArmRangeKm = Math.max(maxArmRangeKm, rangeKm);
          }
        }
      }

      let targets = [...cachedTargets];

      // FIX_PLAN §4: Sort modes — 'tpi' is already sorted upstream by
      // getEnhancedTargetList; other modes re-sort the cached list here.
      if (this._sortMode === 'distance') {
        targets.sort((a, b) => a.distanceKm - b.distanceKm);
      } else if (this._sortMode === 'points') {
        targets.sort((a, b) => b.estimatedPoints - a.estimatedPoints);
      } else if (this._sortMode === 'deltaV') {
        targets.sort((a, b) => a.deltaV - b.deltaV);
      }
      // 'tpi' mode: already sorted upstream

      targets = targets.slice(0, 7);

      if (targets.length === 0) {
        listEl.innerHTML = '<span style="opacity:0.4">No targets nearby</span>';
      } else {
        listEl.innerHTML = targets.map(t => {
          const selected = t.id === this.selectedTargetId;
          const typeIcon = this._getTypeIcon(t.type);
          const typeName = this._getShortTypeName(t.type);
          const tierColor = selected ? '#00ccff' : this._getTargetColor(t);
          const iconClass = (t.sizeMeter && t.sizeMeter > 5) ? 'type-icon large' : 'type-icon';

          // Salvage indicator
          const salvageIcon = t.hasSalvage ? ' \u26CF' : '';

          // Progressive data reveal
          const dataLevel = this._getDataLevel(t.distanceKm);
          const dvClass = dataLevel === 'FAR' ? 'target-dv data-unknown' :
                          dataLevel === 'MEDIUM' ? 'target-dv data-estimated' : 'target-dv';

          // Distance + ΔV formatting
          const dist = this._formatDist(t.distanceKm);
          const deltaV = this._formatDeltaV(t.deltaV, dataLevel);

          // Range indicator
          const range = this._getRangeIndicator(t.distanceKm, maxArmRangeKm);

          if (selected) {
            // --- Net ΔV computation ---
            // UX-3 #1: Use frozen ΔV from selection time if available, else live
            const useDv = (t.selectedDeltaV !== undefined && t.selectedDeltaV !== null)
              ? t.selectedDeltaV : t.deltaV;
            const frozenTag = (t.selectedDeltaV !== undefined && t.selectedDeltaV !== null)
              ? ' (at select)' : '';
            const captureCostMs = useDv * 1000;
            const metalItems = (t.salvage && t.salvage.metals || [])
              .filter(s => s.ispAsThrust > 0)
              .map(s => ({ massKg: s.amount, ispAsThrust: s.ispAsThrust }));
            const shipDryMass = Constants.OCTOPUS_TOTAL_DRY_MASS || 214;
            const salvageYield = computeTotalSalvageDeltaV(metalItems, shipDryMass);
            const netDV = salvageYield - captureCostMs;
            const netDvColor = this._getNetDvColor(netDV);
            const netDvStr = (dataLevel === 'FAR' || dataLevel === 'MEDIUM')
              ? '---'
              : (netDV >= 0 ? `+${netDV.toFixed(0)}` : `${netDV.toFixed(0)}`);

            // ST-6.3: MOID badge for selected target
            const moidBadge = this._renderMoidBadge(t);
            const moidStat = this._renderMoidStat(t);

            // Phase 1c (capture-feedback overhaul): best-tool + live odds for
            // the arm that would take the shot — same ToolOdds model as the
            // reticle strip, so the panel and the strip can never disagree.
            // No arm context → dual W/S fit badge (Phase 0.1 fallback).
            let fitBadge;
            const badgeArm = this._getFitBadgeArm();
            if (badgeArm) {
              fitBadge = this._renderBestToolBadge(badgeArm, t);
            } else {
              const wFit = assessNetFit(t, Constants.CAPTURE_NET && Constants.CAPTURE_NET.MEDIUM);
              const sFit = assessNetFit(t, Constants.CAPTURE_NET && Constants.CAPTURE_NET.SMALL);
              const seg = (tag, f) => {
                const ok = f.fit === 'OK';
                const col = ok ? '#00ffaa' : f.fit === 'DESPIN_FIRST' ? '#ffd166' : '#ff7755';
                return `<span style="color:${col}">${tag}${ok ? '\u2713' : '\u2717'}</span>`;
              };
              fitBadge = `<span style="font-size:9px;font-weight:bold;" title="Capture fit: Weaver / Spinner nets">${seg('W', wFit)} ${seg('S', sFit)}</span>`;
            }

            // Phase 1.5: appraised value — only once the close-range survey
            // decrypted the manifest (value-if-profiled; dossier is the SSOT).
            let valueBadge = '';
            if (dossierSystem.isProfiled(t.id)) {
              const { total } = appraiseSalvage(t.salvage);
              if (total > 0) {
                valueBadge = `<span style="color:#ffcc00;font-size:9px;font-weight:bold;" title="Appraised salvage value">\u20B9${total}</span>`;
              }
            }

            // ── EXPANDED ROW (selected target) ──
            const fullType = this._getFullTypeName(t.type);
            return `<div class="target-row selected" data-id="${t.id}">
    <span class="${iconClass}">${typeIcon}</span>
    <span class="target-name">${fullType}${moidBadge}</span>
    <span class="target-dist">${dist}</span>
    <span class="${dvClass}">${deltaV}</span>
    <span class="range-dot" style="color:${range.color}">${range.dot}</span>
    <div class="target-expanded">
        <div class="econ-line">
            <span>\u0394V ${deltaV}</span>
            <span style="color:${netDvColor}">Net ${netDvStr}${frozenTag}</span>
            <span>${t.estimatedPoints}pt</span>
            ${fitBadge}${valueBadge ? `\n            ${valueBadge}` : ''}
        </div>${moidStat}
        <div class="hint-line">[D] Deploy  [A] Autopilot  [Z] Analyze</div>
    </div>
</div>`;
          } else {
            // ST-6.3: MOID badge for collapsed row
            const moidBadge = this._renderMoidBadge(t);

            // ── COLLAPSED ROW (non-selected) ──
            return `<div class="target-row" data-id="${t.id}">
    <span class="${iconClass}">${typeIcon}</span>
    <span class="target-name" style="color:${tierColor}">${typeName}${salvageIcon}${moidBadge}</span>
    <span class="target-dist">${dist}</span>
    <span class="${dvClass}">${deltaV}</span>
    <span class="range-dot" style="color:${range.color}">${range.dot}</span>
</div>`;
          }
        }).join('');

        // UX-3 #9: Apply discovery animation to newly discovered rows
        if (this._newlyDiscovered.size > 0) {
          requestAnimationFrame(() => {
            for (const id of this._newlyDiscovered) {
              const row = listEl.querySelector(`.target-row[data-id="${id}"]`);
              if (row) row.classList.add('discovered-new');
            }
            this._newlyDiscovered.clear();
          });
        }
      }
    }

    // --- UNTRACKED (SENSOR) ---
    const untrackedEl = document.getElementById('hud-untracked-list');
    const untrackedSection = document.getElementById('hud-untracked-section');
    if (untrackedEl && untrackedSection) {
      const untracked = cachedUntracked.slice(0, 3);
      if (untracked.length === 0) {
        untrackedSection.classList.add('hidden');
      } else {
        untrackedSection.classList.remove('hidden');
        untrackedEl.innerHTML = untracked.map(u => {
          const riskColor = u.riskLevel === 'HIGH' ? '#ff4444' : u.riskLevel === 'MED' ? '#ffaa00' : '#00ff88';
          const dist = this._formatDist(u.distanceKm);
          return `<div class="untracked-row">
    <span>${u.sizeCm}cm</span>
    <span style="color:${riskColor}">${u.riskLevel}</span>
    <span style="text-align:right">${dist}</span>
</div>`;
        }).join('');
      }
    }

    // --- ACTIVE SATS ---
    const activeSatEl = document.getElementById('hud-activesat-list');
    const activeSatSection = document.getElementById('hud-activesat-section');
    if (activeSatEl && activeSatSection) {
      const sats = cachedActiveSats
        .filter(s => s.distance / Constants.SCENE_SCALE < 50)
        .slice(0, 3);
      if (sats.length === 0) {
        activeSatSection.classList.add('hidden');
      } else {
        activeSatSection.classList.remove('hidden');
        activeSatEl.innerHTML = sats.map(s => {
          const distKm = s.distance / Constants.SCENE_SCALE;
          const dist = this._formatDist(distKm);
          return `<div class="activesat-row">
    <span style="color:#00ccff">${s.name}</span>
    <span style="text-align:right">${dist}</span>
</div>`;
        }).join('');
      }
    }
  }

  // ==========================================================================
  // PRIVATE — FORMATTING HELPERS
  // ==========================================================================

  /** @private Format distance value for display */
  _formatDist(distKm) {
    if (distKm === undefined || distKm === null) return '---';
    if (distKm < 1) return `${(distKm * 1000).toFixed(0)}m`;
    if (distKm < 10) return `${distKm.toFixed(2)}km`;
    if (distKm < 100) return `${distKm.toFixed(1)}km`;
    return `${distKm.toFixed(0)}km`;
  }

  /** @private Format ΔV value for display, precision based on data level */
  _formatDeltaV(dv, dataLevel) {
    if (dv === undefined || dv === null || dv < 0) return '---';

    switch (dataLevel) {
      case 'FAR':
        return '---';
      case 'MEDIUM':
        return `~${dv.toFixed(1)}`;
      case 'NEAR':
        return `~${dv.toFixed(2)}`;
      case 'CLOSE':
      default:
        if (dv < 0.01) return '< 0.01';
        return dv.toFixed(2);
    }
  }

  /** @private Get range indicator dot and color */
  _getRangeIndicator(distKm, maxArmRangeKm) {
    if (!maxArmRangeKm || maxArmRangeKm <= 0) return { dot: '○', color: '#ff4444' };
    if (distKm <= maxArmRangeKm) return { dot: '●', color: '#00ff88' };
    if (distKm <= maxArmRangeKm * 3) return { dot: '◐', color: '#ffcc00' };
    return { dot: '○', color: '#ff4444' };
  }

  // ==========================================================================
  // PRIVATE — HELPERS
  // ==========================================================================

  /** @private Get target color based on value tier (danger > jackpot > salvage > junk > standard) */
  _getTargetColor(target) {
    // Danger: extreme risk or hydrazine
    if (target.risk === 'Extreme' || (target.salvage && target.salvage.hydrazine)) {
      return '#ff4444';
    }
    // Jackpot: high-point targets
    if (target.estimatedPoints && target.estimatedPoints >= 100) {
      return '#00ccff';
    }
    // Salvage: has recoverable materials
    if (target.hasSalvage) {
      return '#ffcc00';
    }
    // Junk: tiny fragments with no salvage
    if (target.type === 'fragment' && target.sizeMeter && target.sizeMeter < 0.5) {
      return '#557755';
    }
    // Standard
    return '#00ff88';
  }

  /** @private Get compact salvage hint HTML (e.g. "Xe In ⛏3") with tooltips */
  _getSalvageHint(salvage) {
    if (!salvage) return '';
    const hints = [];
    if (salvage.xenon > 0) hints.push('<span title="Xenon fuel">Xe</span>');
    if (salvage.indium > 0) hints.push('<span title="Indium metal">In</span>');
    if (salvage.gaAs > 0) hints.push('<span title="Solar panel (GaAs)">\u2600</span>');
    if (salvage.battery > 0) hints.push('<span title="Battery">\u26A1</span>');
    if (salvage.hydrazine > 0) hints.push('<span title="Hydrazine (hazardous)">\u26A0</span>');
    if (salvage.lithium > 0) hints.push('<span title="Lithium">Li</span>');
    // Metal count indicator (Phase 2)
    const metalCount = salvage.metals ? salvage.metals.length : 0;
    if (metalCount > 0) hints.push(`\u26CF${metalCount}`);
    return hints.length > 0 ? hints.join('') : '';
  }

  /** @private Get short type name */
  _getShortTypeName(type) {
    switch (type) {
      case 'rocketBody': return 'Rocket Body';
      case 'defunctSat': return 'Defunct Sat';
      case 'missionDebris': return 'Mission Deb';
      case 'fragment': return 'Fragment';
      default: return 'Debris';
    }
  }

  /** @private Get full type name for expanded rows */
  _getFullTypeName(type) {
    switch (type) {
      case 'rocketBody': return 'Rocket Body';
      case 'defunctSat': return 'Defunct Sat';
      case 'missionDebris': return 'Mission Debris';
      case 'fragment': return 'Fragment';
      default: return 'Debris';
    }
  }

  /** @private Get type-appropriate Unicode icon for debris (matches NavSphere S5 shapes) */
  _getTypeIcon(type) {
    switch (type) {
      case 'fragment':       return '\u25B3';     // △
      case 'rocketBody':     return '\u25AE';     // ▮
      case 'defunctSat':     return '\u25FB';     // ◻
      case 'missionDebris':  return '\u25CF';     // ●
      default:               return '\u00B7';     // ·
    }
  }

  /**
   * Determine data precision level based on distance.
   * FAR (>25km): minimal data
   * MEDIUM (10-25km): estimated data
   * NEAR (2-10km): good data
   * CLOSE (<2km): precise data
   * @private
   */
  _getDataLevel(distKm) {
    if (distKm === undefined || distKm === null) return 'FAR';
    if (distKm < 2) return 'CLOSE';
    if (distKm < 10) return 'NEAR';
    if (distKm < 25) return 'MEDIUM';
    return 'FAR';
  }

  /** @private Get color for net ΔV display */
  _getNetDvColor(netDv) {
    if (netDv > 0.001) return '#00ff88';   // Net positive — green
    if (netDv < -0.001) return '#ff4444';  // Net negative — red
    return '#aaaaaa';                       // Neutral — grey
  }

  // ==========================================================================
  // ST-6.3: MOID BADGE RENDERING
  // ==========================================================================

  /**
   * Render a small coloured MOID badge next to target name.
   * Returns empty string if no badge applicable.
   * @private
   * @param {object} target — cached target with optional moidBadge
   * @returns {string} HTML snippet
   */
  _renderMoidBadge(target) {
    const badge = target.moidBadge;
    if (!badge) return '';
    const C = Constants.CONJUNCTION;
    const color = badge === 'HI' ? C.BADGE_COLOR_HI
      : badge === 'MD' ? C.BADGE_COLOR_MD : C.BADGE_COLOR_LO;
    return ` <span style="color:${color};font-size:9px;font-weight:bold;" title="Minimum Orbit Intersection Distance">[${badge}]</span>`;
  }

  /**
   * Render MOID stat line for expanded (selected) target row.
   * @private
   * @param {object} target
   * @returns {string} HTML snippet (empty if no MOID data)
   */
  _renderMoidStat(target) {
    if (!target.moid_m || !isFinite(target.moid_m)) return '';
    const C = Constants.CONJUNCTION;
    const moid = target.moid_m;
    const badge = target.moidBadge;
    const color = badge === 'HI' ? C.BADGE_COLOR_HI
      : badge === 'MD' ? C.BADGE_COLOR_MD
      : badge === 'LO' ? C.BADGE_COLOR_LO : '#888888';
    // Format: km with 1 decimal when ≥1 km; metres when <1 km
    const str = moid >= 1000 ? `${(moid / 1000).toFixed(1)} km` : `${moid.toFixed(0)} m`;
    return `\n        <div class="econ-line"><span style="color:${color}">MOID: ${str}</span></div>`;
  }

}
