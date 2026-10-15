/**
 * TargetPanel.js — Target list sidebar with tracked targets,
 * untracked sensor contacts, and active satellites.
 * S6-A: CSS grid layout, collapsed/expanded rows, reduced caps.
 *
 * Session Q (plan D15): `{ colorLaw }` ctor option (HUD passes the ladder
 * gate), `data.targetLaw` per update (null → shipped rows), `reachKm()` (the
 * tether reach TargetPanel always computed, now shared through
 * TargetColorLaw.reachKmFrom).
 * @module ui/hud/TargetPanel
 */

import { Constants } from '../../core/Constants.js';
import { eventBus } from '../../core/EventBus.js';
import { Events } from '../../core/Events.js';
import { VisualLaw } from '../../core/VisualLaw.js';
import { computeTotalSalvageDeltaV } from '../../entities/OrbitalMechanics.js';
import { assessNetFit, presentedWidthForApproach, getNetClassForType, renderedSpanM, renderedSpanOverflows } from '../../entities/CaptureNet.js';
import { classifyNetTarget } from '../../systems/netRouting.js';
import { computeToolOdds, computeBestTool, toolShortLabel, makeNetOddsLockCache } from '../../systems/ToolOdds.js';
import { dossierSystem, appraiseSalvage } from '../../systems/DossierSystem.js';
import { PaneChrome } from './PaneChrome.js';
import { GestureHints } from './GestureHints.js';
import { classify, oddsColor, reachKmFrom, THIN_ALPHA } from './TargetColorLaw.js';
import { lookColor } from '../HudLook.js';
import { TouchControls } from '../TouchControls.js';
import { TARGETS_PANE_WIDTH_PX } from '../RailGeometry.js';

/** Desktop target-row min-height (shipped). */
export const TARGET_ROW_PX = 20;
/** Glass hit-box (Apple HIG; RAIL_GEOMETRY.TOUCH_PITCH_PX). Plan Task 13. */
export const TARGET_ROW_GLASS_PX = 44;
/** Header line + margin that sits above the rows. */
export const TARGET_HEADER_PX = 24;
/**
 * The pane's own vertical chrome: `.hud-panel` 2 × 6 px padding + 2 × 1 px
 * border (index.html), which `* { box-sizing: border-box }` counts INSIDE a
 * written `height`. Folded into the height law 2026-09-09 (owner amendment to
 * plan §1.18b — "fixed 5-row list" must actually show 5 rows): without it a
 * 124 px `height` left 110 px of content for a 24 + 5 × 20 = 124 px list — four
 * rows and a 6 px sliver (glass: 230 for 244 — four rows and 30 px).
 */
export const TARGET_PANE_CHROME_PX = 14;
/**
 * Rows that fit each PaneChrome step (height = chrome + header + k rows).
 * Follow-up 2026-09-09 (plan 1788926404388-hud-followups-0909.md §1.18b):
 * `normal` 4 → 5 and the pane writes a FIXED `height` (not `maxHeight`), so the
 * box no longer breathes with the list — "nothing should move" (owner). w1-hud-calm
 * 2026-10-05 (owner notes 2026-09-30: show more tracked targets): desktop
 * `normal` 5 → 7 and `max` 7 → 9 — desktop 178 / 218 at 'normal' / 'max'
 * (14 + 24 + 7 / 9 rows of 20). A longer list scrolls (overflowY auto); the 0
 * key's 'min' (58 / 82) is the player's remedy for an empty sector.
 */
export const TARGET_STEP_ROWS = Object.freeze({ min: 1, normal: 7, max: 9 });
/**
 * Desktop `normal` falls back to 5 rows (138) on a viewport shorter than
 * TARGET_TALL_VIEWPORT_PX: at 1024×768 / 1366×768 the 7-row stack (Targets 178
 * + Debris 202 + Next 110 + gaps = 510) overflows the 479 px column and scrolls
 * the Next pane out of view (w1-hud-calm review, 2026-10-05). The two extra rows
 * show wherever they fit; `max` stays 9 everywhere. Headless (no window) = 7.
 */
export const TARGET_TALL_VIEWPORT_PX = 800;
export const TARGET_NORMAL_ROWS_SHORT = 5;
/**
 * Glass rows per step. `normal` stays 5 (258): the right column (Targets +
 * Debris 202 + Next 110 + two 10 px gaps) already overflows 1024×768 landscape
 * at 5 glass rows, and 7 × 44 would push it a further 88 px (measured, see the
 * w1-hud-calm plan Log); `max` takes the 9 rows (434) — the player's remedy.
 */
export const TARGET_STEP_ROWS_GLASS = Object.freeze({ min: 1, normal: 5, max: 9 });

/**
 * Target pane height for a chrome step: the pane's own chrome + the header +
 * k rows, so exactly k rows of CONTENT show under border-box. Glass recomputes
 * from the 44 px row so N rows still fit. Plan Task 13 / 14; a fixed `height`
 * since 2026-09-09. Desktop / glass: min 58 / 82, normal 178 / 258 (desktop 138
 * under an 800 px viewport), max 218 / 434.
 * @param {string} step  'min' | 'normal' | 'max'
 * @param {boolean} [glass]
 * @param {number} [viewportH]  window.innerHeight, read once per layout pass by
 *   the caller; absent / non-finite = a tall viewport (desktop normal 7)
 * @returns {number}
 */
export function targetHeightPx(step, glass, viewportH) {
  const rows = glass ? TARGET_STEP_ROWS_GLASS : TARGET_STEP_ROWS;
  const name = rows[step] ? step : 'normal';
  const short = !glass && name === 'normal' && Number.isFinite(viewportH) && viewportH < TARGET_TALL_VIEWPORT_PX;
  const k = short ? TARGET_NORMAL_ROWS_SHORT : rows[name];
  const row = glass ? TARGET_ROW_GLASS_PX : TARGET_ROW_PX;
  return TARGET_PANE_CHROME_PX + TARGET_HEADER_PX + k * row;
}

/** The live viewport height, or undefined headless (→ the tall-viewport rows). */
function viewportHeight() {
  return (typeof window !== 'undefined' && window && Number.isFinite(window.innerHeight)) ? window.innerHeight : undefined;
}

/**
 * Glass: ctor `glass` wins; else GestureHints.isGlass(); else detectGlass().
 * @param {boolean|null|undefined} explicit
 * @returns {boolean}
 */
function resolveGlass(explicit) {
  if (explicit === true) return true;
  if (explicit === false) return false;
  try { if (GestureHints.isGlass()) return true; } catch (_e) { /* headless */ }
  try { return TouchControls.detectGlass(); } catch (_e) { return false; }
}

/** @private hex (#rrggbb) → 'r, g, b' for rgba(). */
function hexToRgb(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

/** h4b D4: the simple list shows the colour-law hazard word as one glyph (title = the word). Unknown word → '!'. */
const SIMPLE_WORD_GLYPH = Object.freeze({ TUMBLING: '\u21BB', HYDRAZINE: '!', HEAVY: '\u25A0', CONJUNCTION: '!', 'CLOSE PASS': '!' });

export class TargetPanel {
  constructor(container, { colorLaw = false, glass = null } = {}) {
    this._container = container;
    this._sortMode = 'tpi';  // FIX_PLAN §4: Default to composite TPI sort
    this._armManager = null;
    this._colorLaw = !!colorLaw;
    this._glass = resolveGlass(glass);
    this._targetLaw = null;
    this._reachKm = 0;
    /** h4-simple-first D6: mission 1 on F1/F2 — rows show name, distance and the in-reach dot only (HUD passes it on every update). */
    this._simple = false;
    this._simpleBtn = null;          // last written display of the TPI sort button (write-on-change)
    /** h4b D3: the selected simple row carries the one "analyse" chip until target info was opened once (HUD passes it). */
    this._analyseChip = false;
    /** h4b D2: called when the player taps the already-selected row (= analyse; HUD wires noteAnalyse). */
    this.onAnalyse = null;
    this._downId = null;             // row id at pointerdown (the list is rebuilt at 2 Hz: ids survive, nodes do not)
    this._skipClick = false;         // pointerup handled the tap; the click that follows must not count again

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
    const sel = this._colorLaw ? VisualLaw.COLORS.SELECTION : '#00ccff';
    const selRgb = (this._colorLaw ? hexToRgb(sel) : '0, 204, 255').replace(/,\s*/g, ' '); // 'r g b' — the --hud-info-rgb fallback
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
            font-family: var(--font-mono);
            font-variant-numeric: tabular-nums;
            border-left: 2px solid transparent;
            border-radius: 2px;
            margin: 1px 0;
            min-height: ${TARGET_ROW_PX}px;
            cursor: pointer;
            transition: background 0.2s;
            color: var(--hud-label, #aaaaaa);
        }
        #hud-targets-panel[data-glass] .target-row {
            min-height: ${TARGET_ROW_GLASS_PX}px;
            box-sizing: border-box;
        }
        /* h4-simple-first D6: mission 1 on F1/F2 — name, distance, in-reach dot (no ΔV column). */
        .target-row.simple {
            grid-template-columns: 16px minmax(0, 1fr) 72px 16px;
        }
        /* h4b D4: a simple row is ONE line - the hazard word is a glyph (word in its title), the analyse chip sits inside the name cell. */
        .target-row.simple .target-word-glyph { margin-left: 4px; font-weight: bold; }
        .target-row.simple .analyse-chip {
            margin-left: 6px; font-size: 0.85em; font-weight: normal; letter-spacing: 0.04em;
            color: var(--hud-info, ${sel}); opacity: 0.8; text-shadow: none;
        }
        .target-row:hover {
            background: rgb(var(--hud-normal-rgb, 0 255 136) / 0.06);
        }
        .target-row.selected {
            border-left: 3px solid var(--hud-info, ${sel});
            background: rgb(var(--hud-info-rgb, ${selRgb}) / ${Constants.SELECTED_ROW_ALPHA});
            box-shadow: 0 0 8px rgb(var(--hud-info-rgb, ${selRgb}) / ${Constants.SELECTED_ROW_GLOW_ALPHA}) inset;
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
        .target-row .target-word {
            grid-column: 2 / -1;
            line-height: 12px;
        }
        
        /* Expanded (selected) row */
        .target-row.selected .target-name {
            font-size: 12px;
            font-weight: bold;
            color: var(--hud-info, ${sel});
            text-shadow: 0 0 6px rgb(var(--hud-info-rgb, ${selRgb}) / ${Constants.SELECTED_ROW_TEXT_GLOW});
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
            color: var(--hud-label, #aaaaaa);
            flex-wrap: wrap;
        }
        .target-expanded .econ-line > span { white-space: nowrap; }
        .target-expanded .hint-line {
            font-size: 10px;
            color: var(--hud-dim, #666666);
            margin-top: 1px;
        }
        
        /* Section headers */
        .target-section-header {
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 0.08em;
            opacity: 0.7;
            padding: 4px 4px 2px;
            user-select: none;
        }
        
        /* Sort button */
        .target-sort-btn {
            font-size: 10px;
            color: var(--hud-dim, #888888);
            background: none;
            border: 1px solid rgb(var(--hud-dim-rgb, 136 136 136) / 0.3);
            border-radius: 3px;
            padding: 1px 6px;
            cursor: pointer;
            font-family: var(--font-mono);
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
            font-family: var(--font-mono);
            color: var(--hud-label, #aaaaaa);
            min-height: 18px;
        }
        
        /* Active sat row */
        .activesat-row {
            display: grid;
            grid-template-columns: 1fr 60px;
            align-items: center;
            padding: 1px 4px;
            font-size: 11px;
            font-family: var(--font-mono);
            color: var(--hud-label, #aaaaaa);
            min-height: 18px;
        }
        
        /* Section separators */
        .target-section {
            border-top: 1px solid rgb(var(--hud-normal-rgb, 0 255 136) / 0.15);
            margin-top: 4px;
            padding-top: 4px;
        }
        .target-section:empty,
        .target-section.hidden {
            display: none;
        }
        
        /* Progressive data reveal */
        .data-unknown {
            color: var(--hud-dim, #444444);
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
   * "Target pane" toggle). Emits a reactive comms line naming the undo key.
   * Pressing 0 ALWAYS re-reveals the pane, even when the pane-density ladder
   * (−) hid it.
   *
   * Wave 5 Session H (owner lift 2026-09-05 — 03-plan Session H FINDINGS (i)):
   * the HIDE direction drives the pane's ONE visibility bit — the density
   * ladder's `data-density-hidden` attribute (CSS `display:none !important`,
   * HUD._injectStyles) — never an inline `display:none`. That attribute is the
   * bit FloorMask's room memory reads (intent, never presence — Session G), the
   * bit the density `+` restores, and the bit view-switch / skill-reveal
   * re-shows cannot resurrect (the HUD's own rule for the attribute). Before
   * this, a 0-key hide wrote inline display and the room captured "shown": the
   * hide never survived a reload, and `+` on it was a dead press. An inline
   * `display:none` (HUD._applyViewConfig's view hide, or a pre-fix state) still
   * reads as hidden here and is cleared on the re-reveal, so 0 never goes dead.
   */
  toggleVisible() {
    const panel = this.panels && this.panels.targets;
    if (!panel) return;
    // w7-panes review (2026-10-13): before the first scan the pane is held back
    // by HUD's scan gate, not the density bit — a press here must not save a
    // hide the player never saw. Say when it comes, write nothing.
    if (panel.hasAttribute('data-scan-wait')) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Targets appear after your first scan (S)', priority: 'info', _reactive: true,
      });
      return;
    }
    let nowVisible;
    if (panel.hasAttribute('data-density-hidden')) {
      // Hidden by the ONE bit (the density ladder, this key, a floor's room) —
      // this press reveals it regardless of inline state.
      panel.removeAttribute('data-density-hidden');
      panel.style.display = '';
      nowVisible = true;
    } else if (panel.style.display === 'none') {
      // Inline-hidden (view config / legacy) — reveal.
      panel.style.display = '';
      nowVisible = true;
    } else {
      // HIDE: the ONE bit, never an inline write (doc comment above).
      panel.setAttribute('data-density-hidden', '');
      nowVisible = false;
    }
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: nowVisible ? 'Targets pane shown (0 to hide)' : 'Targets pane hidden (0 to show)',
      priority: 'info',
      _reactive: true,
    });
    // Wave 5 Session H (Job A): the 0 key just flipped the pane's ONE
    // visibility bit — the room-memory write trigger (emitted AFTER the flip;
    // the consumer is gated in main.js, so this is ladder-agnostic HUD).
    eventBus.emit(Events.HUD_PANE_VISIBILITY, { pane: 'targets', shown: nowVisible });
  }

  /** @private */
  _build() {
    this._injectStyles();

    // Follow-up 2026-09-09 (§1.15 / §1.18b): the right arm's first pane is
    // 350 wide (TARGETS_PANE_WIDTH_PX — the arm's width; Debris / Next keep
    // the 280 base and hug the right edge) and a FIXED height per step.
    this.panels.targets = this._createPanel('hud-targets-panel', {
      position: 'relative',
      width: `${TARGETS_PANE_WIDTH_PX}px`,
      height: `${targetHeightPx('normal', this._glass, viewportHeight())}px`,
      overflowY: 'auto',
      outline: 'none',
    });
    if (this._glass && this.panels.targets.setAttribute) this.panels.targets.setAttribute('data-glass', '');
    this.panels.targets.dataset.hudGroup = 'target-list';
    this.panels.targets.dataset.activateKey = 'S';
    this.panels.targets.tabIndex = -1;
    this.panels.targets.style.pointerEvents = 'auto';
    this.panels.targets.style.cursor = 'default';

    this.panels.targets.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;padding-right:24px;">
        <span class="pane-title target-section-header" style="color:var(--hud-normal, #00ff88);padding:0;">TARGETS <span style="opacity:0.4;font-size:10px;">[T]</span></span>
        <button id="hud-sort-btn" class="target-sort-btn" title="Click to cycle sort">TPI ↑</button>
      </div>
      <div id="hud-targets-min-summary" data-pane-show="min" style="display:none;font-size:11px;color:var(--hud-normal, #00ff88);opacity:0.7;">. </div>
      <div data-pane-hide="min">
        <div id="hud-target-list"></div>
        <div id="hud-untracked-section" class="target-section">
          <div class="target-section-header" style="color:var(--hud-caution, #ffaa00);">UNTRACKED (SENSOR)</div>
          <div id="hud-untracked-list"></div>
        </div>
        <div id="hud-activesat-section" class="target-section">
          <div class="target-section-header" style="color:var(--hud-label, #ffffff);">ACTIVE SATS</div>
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
      // h4b D2: the list is rebuilt with innerHTML every 2 Hz tick, so a tap can lose its row between
      // pointerdown and click (no click is fired then). The tap is decided on pointerup by row id;
      // a plain click (mouse without pointer events, keyboard, tests) is the fallback.
      const rowId = (e) => {
        const row = e && e.target && e.target.closest ? e.target.closest('.target-row') : null;
        const id = row ? parseInt(row.dataset.id) : NaN;
        return isNaN(id) ? null : id;
      };
      listEl.addEventListener('pointerdown', (e) => { this._downId = rowId(e); this._skipClick = false; });
      listEl.addEventListener('pointerup', (e) => {
        const id = rowId(e);
        const down = this._downId;
        this._downId = null;
        if (id == null || down !== id) return;     // dragged off the row / scroll: not a tap
        this._skipClick = true;
        this._rowTap(id);
      });
      listEl.addEventListener('click', (e) => {
        if (this._skipClick) { this._skipClick = false; return; }
        const id = rowId(e);
        if (id != null) this._rowTap(id);
      });
    }

    // --- Resize chrome (3-step: min / normal / max) ---
    // min: header + one-line count only. normal: standard list. max: taller list.
    this._chrome = new PaneChrome({
      pane: this.panels.targets,
      keyLabel: '0',
      steps: ['min', 'normal', 'max'],
      initial: 'normal',
      color: 'var(--hud-normal, #00ff88)',
      title: 'Targets pane — 0 shows / hides · click to resize min / normal / max',
      onStep: (step) => {
        // Step table = header + k rows (recomputed from the live row height).
        this._applyTargetHeight(step);
        this._updateMinSummary();
      },
    });
  }

  /**
   * @private height = header + k rows — a FIXED box (follow-up 2026-09-09
   * §1.18b): the chrome step alone sizes it; an empty list no longer collapses
   * to 'min' (a box that breathed with the list moved everything under it —
   * owner: "nothing should move"). overflowY:auto scrolls a longer list.
   * Plan Task 13 / 14 — glass rows are 44 px so the same k still fits.
   * Write-on-change.
   * @param {string} [step]
   */
  _applyTargetHeight(step) {
    const pane = this.panels && this.panels.targets;
    if (!pane || !pane.style) return;
    const name = step || (this._chrome && this._chrome.step) || 'normal';
    const h = `${targetHeightPx(name, this._glass, viewportHeight())}px`;   // one viewport read per pass
    if (pane.style.height !== h) pane.style.height = h;
  }

  /** @private Populate the minimized one-line target summary. */
  _updateMinSummary() {
    const el = this.panels.targets && this.panels.targets.querySelector('#hud-targets-min-summary');
    if (!el) return;
    const n = this._lastTrackedCount || 0;
    el.textContent = n > 0 ? `${n} target${n === 1 ? '' : 's'}` : 'No targets';
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

  /** Ready tether reach, km (0 = none). */
  reachKm() { return this._reachKm || 0; }

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
      // Register item 17: a GREEN NET badge (pct ≥ 80) whose DRAWN span
      // outspans the bag drops to amber + a span note — the cue only ever
      // qualifies a confident green, never lifts a red (the odds stay the
      // primary signal; the verdict is untouched, item 7b).
      const nc = best === 'NET' ? getNetClassForType(arm.type) : null;
      const overflow = nc && pct >= 80 && renderedSpanOverflows(t, nc);
      const col = this._targetLaw ? lookColor(oddsColor(pct, overflow)) : overflow ? 'var(--hud-caution, #ffd166)' : pct >= 80 ? 'var(--hud-normal, #00ffaa)' : pct >= 50 ? 'var(--hud-caution, #ffd166)' : 'var(--hud-warning, #ff7755)';
      const tip = overflow ? ` — drawn hull spans ~${Math.round(renderedSpanM(t))} m vs the ${nc.DIAMETER} m bag: it will visibly overflow (accepted stylization, CAPTURE_NET.md §8)` : '';
      return `<span style="color:${col};font-size:10px;font-weight:bold;" title="Best tool odds (${arm.type})${tip}">${label} ${pct}%</span>`;
    }
    // Nothing rollable — name the blocker (e.g. TOO WIDE / EMPTY).
    const netBlocker = (odds.NET && odds.NET.blocker) || (o && o.blocker) || 'NO TOOL';
    const word = netBlocker === 'WIDE' ? 'TOO WIDE'
      : netBlocker === 'HEAVY' ? 'TOO HEAVY' : netBlocker;
    return `<span style="color:${this._targetLaw ? `var(--hud-caution, ${VisualLaw.COLORS.CAUTION})` : 'var(--hud-warning, #ff7755)'};font-size:10px;font-weight:bold;" title="No viable tool (${arm.type})">${word}</span>`;
  }

  /**
   * @private Mother-net-reel plan §12: whale-class odds row. The model was
   * built and unused — computeToolOdds({armType:'mother'}) defaults netCount
   * from captureNetSystem.getMotherNetCount() and accepts netClass +
   * presentedWidthM; no caller ever passed 'mother', so the panel showed
   * daughter odds (or a lying L badge) for the one target class only the
   * mother can take.
   * @returns {string} HTML span
   */
  _renderMotherOddsBadge(t) {
    const CN = Constants.CAPTURE_NET;
    // Wave-4 QA #3: the mother pod's pre-fire odds surface. One persistent
    // lock cache for the whale badge — lock-stable cling factors compute once
    // per locked whale instead of per 2 Hz re-render; the input-keyed contract
    // (ToolOdds.makeNetOddsLockCache) recomputes on target change, so several
    // whale rows simply alternate recomputes (== fresh path, still exact).
    // The per-row daughter planning badges above keep the fresh path: they
    // sweep MANY targets per render, where a single-slot cache buys nothing.
    if (!this._motherOddsLockCache) this._motherOddsLockCache = makeNetOddsLockCache();
    const odds = computeToolOdds({
      armType: 'mother',
      target: t,
      netClass: CN && CN.LARGE,
      presentedWidthM: presentedWidthForApproach(t, null),
      lockCache: this._motherOddsLockCache,
    });
    const o = odds && odds.NET;
    if (o && o.p != null && o.p > 0) {
      const cap = (Constants.TOOL_ODDS && Constants.TOOL_ODDS.DISPLAY_CAP) ?? 0.99;
      const pct = Math.round(Math.min(o.p, cap) * 100);
      // Register item 17: same overflow qualifier as the daughter badge —
      // only ever downgrades a GREEN (pct ≥ 80) to amber, never lifts a red.
      const overflow = pct >= 80 && renderedSpanOverflows(t, CN && CN.LARGE);
      const col = this._targetLaw ? lookColor(oddsColor(pct, overflow)) : overflow ? 'var(--hud-caution, #ffd166)' : pct >= 80 ? 'var(--hud-normal, #00ffaa)' : pct >= 50 ? 'var(--hud-caution, #ffd166)' : 'var(--hud-warning, #ff7755)';
      const tip = overflow ? ` — drawn hull spans ~${Math.round(renderedSpanM(t))} m vs the ${CN.LARGE.DIAMETER} m bag: it will visibly overflow (accepted stylization, CAPTURE_NET.md §8)` : '';
      return `<span style="color:${col};font-size:10px;font-weight:bold;" title="Mother Large Net odds${tip}">${pct}% [N]</span>`;
    }
    const blocker = (o && o.blocker) || 'NO NET';
    const word = blocker === 'WIDE' ? 'TOO WIDE'
      : blocker === 'HEAVY' ? 'TOO HEAVY'
      : blocker === 'EMPTY' ? 'NO NETS' : blocker;
    return `<span style="color:${this._targetLaw ? `var(--hud-caution, ${VisualLaw.COLORS.CAUTION})` : 'var(--hud-warning, #ff7755)'};font-size:10px;font-weight:bold;" title="Mother Large Net">${word}</span>`;
  }

  /**
   * Update the target list display. Called at 2 Hz from the coordinator.
   * @param {object} data
   * @param {Array}  data.cachedTargets
   * @param {Array}  data.cachedUntracked
   * @param {Array}  data.cachedActiveSats
   */
  update(data) {
    this._targetLaw = (this._colorLaw && data && data.targetLaw) ? data.targetLaw : null;
    this._playerOrbit = data.playerOrbit || null;
    this._simple = !!data.simple;
    this._analyseChip = !!data.analyseChip;
    this._applySimpleChrome();
    this._updateTargetList(data.cachedTargets, data.cachedUntracked, data.cachedActiveSats);
  }

  /**
   * @private A tap / click on target row `id`: select it; tapping the row that was ALREADY selected is
   * the analyse action (h4b D2 — touch has no Z key).
   */
  _rowTap(id) {
    const was = this.selectedTargetId;
    this.selectedTargetId = id;
    eventBus.emit(Events.HUD_TARGET_CLICK, { id });
    if (was === id && typeof this.onAnalyse === 'function') this.onAnalyse(id);
  }

  /** True while the list is in simple-first form (mission 1, F1/F2; HUD decides). */
  isSimple() { return this._simple; }

  /** @private The TPI sort toggle hides in simple mode (write-on-change). */
  _applySimpleChrome() {
    const btn = this.panels.targets && this.panels.targets.querySelector('#hud-sort-btn');
    if (!btn || !btn.style) return;
    const want = this._simple ? 'none' : '';
    if (this._simpleBtn === want) return;
    this._simpleBtn = want;
    btn.style.display = want;
  }

  // ==========================================================================
  // PRIVATE — TARGET LIST
  // ==========================================================================

  /** @private Update enhanced 3-section target list */
  _updateTargetList(cachedTargets, cachedUntracked, cachedActiveSats) {
    // Track count for the minimized one-line summary.
    this._lastTrackedCount = Array.isArray(cachedTargets) ? cachedTargets.length : 0;
    if (this._chrome && this._chrome.isMinimized) this._updateMinSummary();

    // --- TARGETS (the tracked list) ---
    const listEl = document.getElementById('hud-target-list');
    if (listEl) {
      const maxArmRangeKm = this._reachKm = reachKmFrom(this._armManager ? this._armManager.getAllStatus() : null, { weaver: Constants.WEAVER_TETHER_LENGTH / 1000, spinner: Constants.SPINNER_TETHER_LENGTH / 1000 });

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

      targets = targets.slice(0, TARGET_STEP_ROWS.max);   // as many rows as the tallest step shows (9)

      if (targets.length === 0) {
        listEl.innerHTML = '<span style="opacity:0.4">No targets nearby</span>';
        this._applyTargetHeight();
      } else {
        listEl.innerHTML = targets.map(t => {
          const selected = t.id === this.selectedTargetId;
          const typeIcon = this._getTypeIcon(t.type);
          const typeName = this._getShortTypeName(t.type);
          const L = this._targetLaw;
          const law = L ? classify({
            selected,
            managed: L.apTargetId != null && t.id === L.apTargetId,
            threatTier: (L.threatId != null && t.id === L.threatId) ? L.threatTier : null,
            hydrazine: !!(t.salvage && t.salvage.hydrazine),
            tumbleDegS: (t.tumbleRate || 0) * 180 / Math.PI,
            massKg: t.mass,
            distanceKm: t.distanceKm,
            reachKm: maxArmRangeKm,
          }) : null;
          const tierColor = law ? lookColor(law.color) : (selected ? 'var(--hud-info, #00ccff)' : this._getTargetColor(t));
          const iconClass = (t.sizeMeter && t.sizeMeter > 5) ? 'type-icon large' : 'type-icon';

          // Salvage indicator: a 1-char ASCII mark (the 72px name column ellipsizes;
          // the row colour tier already reads salvage).
          const salvageIcon = t.hasSalvage ? ' <span title="Salvage aboard">*</span>' : '';

          // Progressive data reveal
          const dataLevel = this._getDataLevel(t.distanceKm);
          const dvClass = dataLevel === 'FAR' ? 'target-dv data-unknown' :
                          dataLevel === 'MEDIUM' ? 'target-dv data-estimated' : 'target-dv';

          // Distance + ΔV formatting
          const dist = this._formatDist(t.distanceKm);
          const deltaV = this._formatDeltaV(t.deltaV, dataLevel);

          // Range indicator
          let range;
          if (law) {
            const inReach = maxArmRangeKm > 0 && t.distanceKm <= maxArmRangeKm;
            range = {
              dot: inReach ? '\u25CF' : '\u25CB',
              color: `var(--hud-normal, ${VisualLaw.COLORS.PLAYER})`,
              opacity: inReach ? null : THIN_ALPHA,
            };
          } else {
            range = this._getRangeIndicator(t.distanceKm, maxArmRangeKm);
          }
          const rangeStyle = range.opacity != null
            ? `color:${range.color};opacity:${range.opacity}`
            : `color:${range.color}`;
          const wordTag = (alpha) => (law && law.word)
            ? `<span class="target-word" style="color:${lookColor(law.wordColor)};font-size:10px;font-weight:bold;letter-spacing:0.08em${alpha != null ? `;opacity:${alpha}` : ''}">${law.word}</span>`
            : '';

          if (this._simple) {
            // h4-simple-first D6: name, distance and the in-reach dot — no ΔV column, no MOID badge,
            // no detail line, no key prompts (those come one pane level up and from mission 2).
            const name = selected ? this._getFullTypeName(t.type) : typeName;
            const nameStyle = selected
              ? (law ? ` style="color:${lookColor(law.color)}"` : '')
              : ` style="color:${tierColor}${law ? `;opacity:${law.alpha}` : ''}"`;
            // h4b D4: the hazard word is ONE glyph in the name cell (the word stays in its title), never a second line.
            const glyph = (law && law.word)
              ? `<span class="target-word-glyph" title="${law.word}" style="color:${lookColor(law.wordColor)}">${SIMPLE_WORD_GLYPH[law.word] || '!'}</span>`
              : '';
            // h4b D3: ONE prompt for the selected row until target info was opened once (touch has no Z).
            const chip = (selected && this._analyseChip)
              ? `<span class="analyse-chip">${this._glass ? 'tap again: analyse' : 'Z analyse'}</span>`
              : '';
            return `<div class="target-row simple${selected ? ' selected' : ''}" data-id="${t.id}">
    <span class="${iconClass}">${typeIcon}</span>
    <span class="target-name"${nameStyle}>${name}${selected ? '' : salvageIcon}${glyph}${chip}</span>
    <span class="target-dist">${dist}</span>
    <span class="range-dot" style="${rangeStyle}">${range.dot}</span>
</div>`;
          }

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
            // Mother-net-reel plan §12: a WHALE (>500 kg) short-circuits to
            // the mother row — the daughter badge was showing "L✗ TOO HEAVY"
            // (judged against the weaver's 500 kg MEDIUM net) exactly when
            // the mother's LARGE net is the right tool, and `_getFitBadgeArm`
            // would show daughter odds for a target no daughter can take.
            let fitBadge;
            const isWhale = classifyNetTarget(t.mass || 0).band === 'whale';
            if (isWhale) {
              fitBadge = this._renderMotherOddsBadge(t);
            } else {
            const badgeArm = this._getFitBadgeArm();
            if (badgeArm) {
              fitBadge = this._renderBestToolBadge(badgeArm, t);
            } else {
              const wFit = assessNetFit(t, Constants.CAPTURE_NET && Constants.CAPTURE_NET.MEDIUM);
              const sFit = assessNetFit(t, Constants.CAPTURE_NET && Constants.CAPTURE_NET.SMALL);
              // Register item 17: an OK whose DRAWN span outspans that class's
              // bag renders as an amber ✓ with a span note — the verdict stays
              // logical (item 7b); this is the advisory-only cue.
              const seg = (tag, f, nc) => {
                const ok = f.fit === 'OK';
                const overflow = ok && renderedSpanOverflows(t, nc);
                const col = this._targetLaw ? (ok ? (overflow ? `var(--hud-caution, ${VisualLaw.COLORS.CAUTION})` : `var(--hud-normal, ${VisualLaw.COLORS.PLAYER})`) : `var(--hud-caution, ${VisualLaw.COLORS.CAUTION})`) : (ok ? (overflow ? 'var(--hud-caution, #ffd166)' : 'var(--hud-normal, #00ffaa)') : f.fit === 'DESPIN_FIRST' ? 'var(--hud-caution, #ffd166)' : 'var(--hud-warning, #ff7755)');
                const tip = overflow ? ` title="drawn hull spans ~${Math.round(renderedSpanM(t))} m vs the ${nc.DIAMETER} m bag — it will visibly overflow (accepted stylization, CAPTURE_NET.md §8)"` : '';
                return `<span style="color:${col}"${tip}>${tag}${ok ? '✓' : '✗'}</span>`;
              };
              fitBadge = `<span style="font-size:10px;font-weight:bold;" title="Capture fit (daughter nets): L = weaver's MEDIUM / LD-NET 5 m class, S = spinner's SMALL / SD-NET 1.5 m class — not the mother net">${seg('L', wFit, Constants.CAPTURE_NET && Constants.CAPTURE_NET.MEDIUM)} ${seg('S', sFit, Constants.CAPTURE_NET && Constants.CAPTURE_NET.SMALL)}</span>`;
            }
            }

            // Phase 1.5: appraised value — only once the close-range survey
            // decrypted the manifest (value-if-profiled; dossier is the SSOT).
            let valueBadge = '';
            if (dossierSystem.isProfiled(t.id)) {
              const { total } = appraiseSalvage(t.salvage);
              if (total > 0) {
                valueBadge = `<span style="color:var(--hud-caution, #ffcc00);font-size:10px;font-weight:bold;" title="Appraised salvage value">${total} cr</span>`;
              }
            }

            // ── EXPANDED ROW (selected target) ──
            const fullType = this._getFullTypeName(t.type);
            return `<div class="target-row selected" data-id="${t.id}">
    <span class="${iconClass}">${typeIcon}</span>
    <span class="target-name"${law ? ` style="color:${lookColor(law.color)}"` : ''}>${fullType}${moidBadge}</span>
    <span class="target-dist">${dist}</span>
    <span class="${dvClass}">${deltaV}</span>
    <span class="range-dot" style="${rangeStyle}">${range.dot}</span>
    ${wordTag(null)}
    <div class="target-expanded">
        <div class="econ-line">
            <span>\u0394V ${deltaV}</span>
            <span style="color:${netDvColor}">Net ${netDvStr}${frozenTag}</span>
            <span>${t.estimatedPoints}pt</span>
            ${fitBadge}${valueBadge ? `\n            ${valueBadge}` : ''}
        </div>${moidStat}
        <div class="hint-line">[D] Deploy · [A] Auto · [Z] Analyze</div>
    </div>
</div>`;
          } else {
            // ST-6.3: MOID badge for collapsed row
            const moidBadge = this._renderMoidBadge(t);

            // ── COLLAPSED ROW (non-selected) ──
            return `<div class="target-row" data-id="${t.id}">
    <span class="${iconClass}">${typeIcon}</span>
    <span class="target-name" style="color:${tierColor}${law ? `;opacity:${law.alpha}` : ''}">${typeName}${salvageIcon}${moidBadge}</span>
    <span class="target-dist">${dist}</span>
    <span class="${dvClass}">${deltaV}</span>
    <span class="range-dot" style="${rangeStyle}">${range.dot}</span>
    ${wordTag(law ? law.alpha : null)}
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
        this._applyTargetHeight();
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
          const riskColor = u.riskLevel === 'HIGH' ? 'var(--hud-warning, #ff4444)' : u.riskLevel === 'MED' ? 'var(--hud-caution, #ffaa00)' : 'var(--hud-normal, #00ff88)';
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
    <span style="color:var(--hud-info, #00ccff)">${s.name}</span>
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
    if (!maxArmRangeKm || maxArmRangeKm <= 0) return { dot: '○', color: 'var(--hud-warning, #ff4444)' };
    if (distKm <= maxArmRangeKm) return { dot: '●', color: 'var(--hud-normal, #00ff88)' };
    if (distKm <= maxArmRangeKm * 3) return { dot: '◐', color: 'var(--hud-caution, #ffcc00)' };
    return { dot: '○', color: 'var(--hud-warning, #ff4444)' };
  }

  // ==========================================================================
  // PRIVATE — HELPERS
  // ==========================================================================

  /** @private Get target color — VisualLaw tokens only (ladder reorder rev 3,
   *  locked #12: legacy value-colours removed). */
  _getTargetColor(target) {
    if (target.risk === 'Extreme' || (target.salvage && target.salvage.hydrazine)) {
      return `var(--hud-warning, ${VisualLaw.COLORS.THREAT})`;
    }
    if (target.estimatedPoints && target.estimatedPoints >= 100) {
      return `var(--hud-info, ${VisualLaw.COLORS.INFO})`;
    }
    if (target.hasSalvage) {
      return `var(--hud-text, ${VisualLaw.COLORS.VALUE})`;
    }
    if (target.type === 'fragment' && target.sizeMeter && target.sizeMeter < 0.5) {
      return `var(--hud-normal, ${VisualLaw.COLORS.PLAYER})`;
    }
    return `var(--hud-normal, ${VisualLaw.COLORS.PLAYER})`;
  }

  /** @private Get compact salvage hint HTML (e.g. "Xe In M3") with tooltips */
  _getSalvageHint(salvage) {
    if (!salvage) return '';
    const hints = [];
    if (salvage.xenon > 0) hints.push('<span title="Xenon fuel">Xe</span>');
    if (salvage.indium > 0) hints.push('<span title="Indium metal">In</span>');
    if (salvage.gaAs > 0) hints.push('<span title="Solar panel (GaAs)">GaAs</span>');
    if (salvage.battery > 0) hints.push('<span title="Battery">Bat</span>');
    if (salvage.hydrazine > 0) hints.push('<span title="Hydrazine (hazardous)">HAZ</span>');
    if (salvage.lithium > 0) hints.push('<span title="Lithium">Li</span>');
    // Metal count indicator (Phase 2)
    const metalCount = salvage.metals ? salvage.metals.length : 0;
    if (metalCount > 0) hints.push(`M${metalCount}`);
    return hints.length > 0 ? hints.join(' ') : '';
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
    if (netDv > 0.001) return 'var(--hud-normal, #00ff88)';   // Net positive — green
    if (netDv < -0.001) return 'var(--hud-warning, #ff4444)';  // Net negative — red
    return 'var(--hud-label, #aaaaaa)';                       // Neutral — grey
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
    return ` <span style="color:${color};font-size:10px;font-weight:bold;" title="Minimum Orbit Intersection Distance">[${badge}]</span>`;
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
      : badge === 'LO' ? C.BADGE_COLOR_LO : 'var(--hud-dim, #888888)';
    // Format: km with 1 decimal when ≥1 km; metres when <1 km
    const str = moid >= 1000 ? `${(moid / 1000).toFixed(1)} km` : `${moid.toFixed(0)} m`;
    return `\n        <div class="econ-line"><span style="color:${color}">MOID: ${str}</span></div>`;
  }

}
