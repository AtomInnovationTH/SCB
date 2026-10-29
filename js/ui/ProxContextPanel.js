/**
 * ProxContextPanel.js — the Zoom Ladder PROX NET (id 3) 'tactical-approach' context panel
 * (FloorContract.FLOORS[4].contextPanel).
 *
 * No generic context-panel host exists (grep "contextPanel" hits only FloorContract entries), so this is a
 * self-contained overlay in the ProxNet family, in the TransferWindows pane style: pure static readout model
 * (headless-testable), DOM fully guarded (inert without a document), VisualLaw colours, and write-on-change — an
 * innerHTML cache plus a ≤4 Hz cap on non-structural writes (02-traps G1: no per-frame DOM churn although the floor
 * feeds refresh() every frame).
 *
 * Reads (fed by ProxNetFloor.update):
 *   - the focused cluster's NAME + a FIELD VERDICT (HOT/WARM/COLD): the hottest InsertionPlanner candidate risk,
 *     classified by the FieldRiskModel zone thresholds (ZONE_CORE_MIN/ZONE_MID_MIN, imported: single source);
 *   - the three insertion candidates (edge/mid/core): the SELECTED one expanded to {zone, riskScore, est scavenge
 *     rate, ΔV estimate}, the other two as compact rows;
 *   - the approach/autopilot state line (EN ROUTE → zone after the approach verb commits; STANDBY otherwise);
 *   - the Space-verb hint 'SPACE — APPROACH', only while a cluster is aimed (the verb no-ops without one).
 *
 * Slot: left:16px/bottom:16px, z-index 34, TransferWindows' slot; the two NEVER coexist (that panel is the F6
 * costume, this is F5), like ProxOverlay reusing ReachOrb's z 32.
 *
 * Colour law: a PLANNING surface, not an alarm — THREAT red must pulse, so risk is carried by the STEADY ProxOverlay
 * INFO→THREAT gradient and the WORD/number always double-encode it. SELECTION blue marks only the selected
 * candidate (blue = pilot-selected). Never colour-alone.
 *
 * @module ui/ProxContextPanel
 */

import { VisualLaw } from '../core/VisualLaw.js';
import { FloorContract } from '../core/FloorContract.js';
import { ProxOverlay } from './ProxOverlay.js';
import { PANE_CORNER_PX } from './RailGeometry.js';
import { ZONE_CORE_MIN, ZONE_MID_MIN } from '../entities/FieldRiskModel.js';

/**
 * Player-facing floor labels come from the ONE source (FloorContract `name`, as the rail paints it; owner relabel
 * 2026-09-05: 3 DEBRIS, 4 LEO); never hard-code a floor name in a panel.
 */
const THIS_FLOOR = FloorContract.byId(3);
const PLAN_FLOOR = FloorContract.byId(4);
const FLOOR_TITLE = THIS_FLOOR ? THIS_FLOOR.name : 'DEBRIS';
const PLAN_FLOOR_LABEL = PLAN_FLOOR ? `${PLAN_FLOOR.id} ${PLAN_FLOOR.name}` : '4 LEO';

/**
 * Write cap: min real-time interval between innerHTML writes when the STRUCTURAL content is unchanged (structural
 * changes write at once). Same as TransferWindows.DOM_WRITE_MIN_INTERVAL_MS: a warp-fast floor re-polls faster than
 * the DOM should re-parse.
 */
const DOM_WRITE_MIN_INTERVAL_MS = 250;

/** Monotonic ms clock (Date.now fallback for headless). */
const _nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class ProxContextPanel {
  /**
   * @param {object} [deps]
   * @param {function} [deps.simple] - () => true at the simple level (mission 1, no `+` pane pulled in): the panel
   *                 then shows only its title line. Absent = never simple.
   */
  constructor(deps = {}) {
    this._now = deps.now || _nowMs;
    this._simple = typeof deps.simple === 'function' ? deps.simple : null;
    this._root = null;
    this._built = false;
    this._visible = false;
    this._lastHtml = null;         // last painted markup (skip identical writes)
    this._lastStructKey = null;    // last painted structural fingerprint
    this._lastWriteMs = -Infinity; // last innerHTML write (real time)
  }

  isVisible() { return this._visible; }

  static get DOM_WRITE_MIN_INTERVAL_MS() { return DOM_WRITE_MIN_INTERVAL_MS; }

  /**
   * Pure gate: should refresh() write the DOM now? Structural changes always write; otherwise writes are capped at
   * DOM_WRITE_MIN_INTERVAL_MS (same contract as TransferWindows.shouldWrite).
   */
  static shouldWrite(structKey, lastStructKey, nowMs, lastWriteMs) {
    if (structKey !== lastStructKey) return true;
    return (nowMs - lastWriteMs) >= DOM_WRITE_MIN_INTERVAL_MS;
  }

  /**
   * FIELD VERDICT: the hottest candidate's riskScore by the FieldRiskModel zone thresholds: ≥ ZONE_CORE_MIN ⇒ HOT,
   * ≥ ZONE_MID_MIN ⇒ WARM, else COLD. No risk reads (no debris source injected) ⇒ the honest '—'.
   * @param {Array<{riskScore:?number}>|null} candidates
   * @returns {{level:'hot'|'warm'|'cold'|null, risk01:number|null, text:string}}
   */
  static verdict(candidates) {
    let max = null;
    for (const c of (candidates || [])) {
      if (c && Number.isFinite(c.riskScore)) max = (max == null) ? c.riskScore : Math.max(max, c.riskScore);
    }
    if (max == null) return { level: null, risk01: null, text: '\u2014' };
    if (max >= ZONE_CORE_MIN) return { level: 'hot', risk01: max, text: 'HOT' };
    if (max >= ZONE_MID_MIN) return { level: 'warm', risk01: max, text: 'WARM' };
    return { level: 'cold', risk01: max, text: 'COLD' };
  }

  /** 'risk 42%' (or 'risk —' without a read); matches the overlay's rounding. */
  static fmtRisk(riskScore) {
    return Number.isFinite(riskScore) ? `risk ${Math.round(riskScore * 100)}%` : 'risk \u2014';
  }

  /** '~3.2/min' scavenge estimate (or '~—/min'); matches the overlay label. */
  static fmtRate(ratePerMin) {
    return Number.isFinite(ratePerMin) ? `~${ratePerMin.toFixed(1)}/min` : '~\u2014/min';
  }

  /** 'ΔV 118 m/s' (or 'ΔV —'); matches the overlay label. */
  static fmtDv(dvMps) {
    return Number.isFinite(dvMps) ? `\u0394V ${Math.round(dvMps)} m/s` : '\u0394V \u2014';
  }

  /**
   * Build the display model. Pure: no DOM, no clocks.
   * @param {object} [state]
   * @param {object|null} [state.cluster]  - focused cluster ({name, id}) or null
   * @param {Array|null} [state.candidates] - InsertionPlanner candidates
   *                 ({zone, riskScore, estScavengeRate, dvEstimate})
   * @param {number} [state.selectedIndex] - index of the SELECTED candidate
   * @param {object|null} [state.approach] - the floor's committed approach
   *                 ({zone}) — null before the verb fires / after a re-aim
   * @returns {{
   *   empty:boolean, clusterName:string,
   *   verdictText:string, verdictLevel:?string, verdictRisk01:?number,
   *   rows:Array<{zone:string, selected:boolean, risk01:?number,
   *               riskText:string, rateText:string, dvText:string}>,
   *   stateText:string, engaged:boolean, hintText:string, guideText:string,
   * }}
   */
  static readout(state = {}) {
    const cluster = state.cluster || null;
    const cands = Array.isArray(state.candidates) ? state.candidates : [];
    if (!cluster) {
      return {
        empty: true, clusterName: '\u2014',
        verdictText: '\u2014', verdictLevel: null, verdictRisk01: null,
        rows: [],
        stateText: 'NO TARGET', engaged: false,
        hintText: '',
        guideText: `aim a cluster on ${PLAN_FLOOR_LABEL} to plan an approach`,
      };
    }
    const v = ProxContextPanel.verdict(cands);
    const sel = Number.isInteger(state.selectedIndex) ? state.selectedIndex : -1;
    const rows = cands.map((c, i) => ({
      zone: String(c.zone || '?').toUpperCase(),
      selected: i === sel,
      risk01: Number.isFinite(c.riskScore) ? c.riskScore : null,
      riskText: ProxContextPanel.fmtRisk(c.riskScore),
      rateText: ProxContextPanel.fmtRate(c.estScavengeRate),
      dvText: ProxContextPanel.fmtDv(c.dvEstimate),
    }));
    const approach = state.approach || null;
    const engaged = !!(approach && approach.zone);
    return {
      empty: false,
      clusterName: cluster.name || String(cluster.id != null ? cluster.id : '\u2014'),
      verdictText: v.text, verdictLevel: v.level, verdictRisk01: v.risk01,
      rows,
      stateText: engaged
        ? `AUTOPILOT \u00b7 EN ROUTE \u2192 ${String(approach.zone).toUpperCase()}`
        : 'AUTOPILOT \u00b7 STANDBY',
      engaged,
      hintText: 'SPACE \u2014 APPROACH',
      guideText: '',
    };
  }

  _build() {
    if (this._built || typeof document === 'undefined' || !document.body) return;
    this._built = true;
    const root = document.createElement('div');
    root.id = 'ladder-prox-context';
    root.style.cssText = [
      'position:absolute', `left:max(${PANE_CORNER_PX}px, env(safe-area-inset-left))`, 'bottom:16px', 'min-width:240px',   // left edge = the MOTHER pane's
      'padding:8px 12px', 'border:1px solid rgba(0,204,255,0.4)', 'border-radius:4px',
      'background:rgba(0,16,32,0.72)', 'color:' + VisualLaw.COLORS.INFO,
      'font-family: var(--font-mono)', 'font-size:0.7rem', 'letter-spacing:0.06em',
      'z-index:34', 'pointer-events:none', 'opacity:0', 'transition:opacity 0.3s',
    ].join(';');
    document.body.appendChild(root);
    this._root = root;
  }

  show() { this._build(); this._visible = true; if (this._root) this._root.style.opacity = '1'; }
  hide() { this._visible = false; if (this._root) this._root.style.opacity = '0'; }

  /**
   * Paint the tactical-approach readout. Safe per frame: write-on-change (innerHTML cache + write cap).
   * @returns {object} the display model that was rendered
   */
  refresh(state = {}) {
    const model = ProxContextPanel.readout(state);
    let simple = false;
    try { simple = !!(this._simple && this._simple()); } catch (_e) { simple = false; }
    model.simple = simple;
    if (!this._root) return model;
    // The simple level paints the title line only, so only the title can be structural.
    const structKey = simple ? `S\u0001${model.clusterName}\u0001${model.empty}` : [
      model.clusterName, model.empty, model.verdictText, model.stateText, model.hintText,
      model.rows.map((r) => `${r.zone}:${r.selected ? 1 : 0}:${r.riskText}:${r.rateText}:${r.dvText}`).join('|'),
    ].join('\u0001');
    const now = this._now();
    if (!ProxContextPanel.shouldWrite(structKey, this._lastStructKey, now, this._lastWriteMs)) {
      return model;
    }
    const html = this._html(model);
    if (html !== this._lastHtml) {
      this._root.innerHTML = html;
      this._lastHtml = html;
      this._lastStructKey = structKey;
      this._lastWriteMs = now;
    }
    return model;
  }

  _html(m) {
    const rows = [
      `<div style="color:${VisualLaw.COLORS.PLAYER}">${FLOOR_TITLE} \u00b7 ${m.clusterName}</div>`,
    ];
    if (m.simple) {   // no verdict, no zone rows, no autopilot / Space lines
      // With nothing focused, keep one plain hint.
      if (m.empty) rows.push(`<div style="opacity:0.7">Point at a debris field on ${PLAN_FLOOR_LABEL} to plan a trip.</div>`);
      return rows.join('');
    }
    if (m.empty) {
      rows.push(`<div>${m.stateText}</div>`);
      rows.push(`<div style="opacity:0.7">${m.guideText}</div>`);
      return rows.join('');
    }
    // Field verdict: steady risk-gradient colour; the WORD carries the level.
    const vColor = (m.verdictRisk01 != null)
      ? ProxOverlay.riskColor(m.verdictRisk01) : VisualLaw.COLORS.INFO;
    rows.push(`<div style="color:${vColor}">FIELD ${m.verdictText} \u00b7 ${ProxContextPanel.fmtRisk(m.verdictRisk01 == null ? NaN : m.verdictRisk01)}</div>`);
    // Three insertion candidates: SELECTED expanded, others compact.
    for (const r of m.rows) {
      const rColor = (r.risk01 != null) ? ProxOverlay.riskColor(r.risk01) : VisualLaw.COLORS.INFO;
      if (r.selected) {
        // Selection is SELECTION blue (VisualLaw.COLORS.SELECTION) + the ▸ shape channel.
        rows.push(`<div style="color:${VisualLaw.COLORS.SELECTION}">\u25b8 ${r.zone}</div>`);
        rows.push(`<div style="color:${rColor};padding-left:12px">${r.riskText} \u00b7 ${r.rateText}</div>`);
        rows.push(`<div style="padding-left:12px">${r.dvText}</div>`);
      } else {
        rows.push(`<div style="color:${rColor};opacity:0.75;padding-left:12px">${r.zone} \u00b7 ${r.riskText} \u00b7 ${r.dvText}</div>`);
      }
    }
    // State line: engaged reads PLAYER green (a live system), standby stays dim INFO.
    rows.push(m.engaged
      ? `<div style="color:${VisualLaw.COLORS.PLAYER}">${m.stateText}</div>`
      : `<div style="opacity:0.7">${m.stateText}</div>`);
    rows.push(`<div style="opacity:0.7">${m.hintText}</div>`);
    return rows.join('');
  }

  dispose() {
    if (this._root && this._root.remove) this._root.remove();
    this._root = null;
    this._built = false;
    this._visible = false;
    this._lastHtml = null;
    this._lastStructKey = null;
    this._lastWriteMs = -Infinity;
  }
}

export default ProxContextPanel;
