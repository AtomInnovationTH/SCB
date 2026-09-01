/**
 * ProxContextPanel.js — the Zoom Ladder F5 (PROX NET) 'tactical-approach'
 * context panel (S4, FloorContract.FLOORS[4].contextPanel).
 *
 * NO GENERIC CONTEXT-PANEL HOST EXISTS YET (F6/F7 shipped without one — grep
 * "contextPanel" hits only FloorContract entries), so per the S4 brief this is
 * a SELF-CONTAINED overlay in the ProxNet family, pattern-matched to the F6
 * TransferWindows pane (the de-facto floor-panel house style): pure static
 * readout model (headless-testable), DOM fully guarded (inert without a
 * document), VisualLaw colors, and the G1 write-on-change discipline — an
 * innerHTML cache plus the ≤4 Hz structural-change write cap (02-traps G1:
 * no per-frame DOM churn even though the floor feeds refresh() every frame).
 *
 * WHAT IT READS (fed by ProxNetFloor.update from the floor's own data):
 *   - the focused cluster's NAME + a FIELD VERDICT (HOT/WARM/COLD) derived
 *     from the InsertionPlanner candidates' FieldRiskModel reads — the
 *     hottest candidate risk classified by the model's own zone thresholds
 *     (ZONE_CORE_MIN/ZONE_MID_MIN — single source of truth, imported);
 *   - the three insertion candidates (edge/mid/core), the SELECTED one
 *     expanded to {zone, riskScore, est scavenge rate, ΔV estimate}, the
 *     other two as compact rows;
 *   - the approach/autopilot state line (EN ROUTE → zone after the approach
 *     verb commits; STANDBY otherwise);
 *   - the Space-verb hint 'SPACE — APPROACH' (only while a cluster is aimed
 *     — the verb no-ops without one).
 *
 * Layout slot: left:16px/bottom:16px, z-index 34 — TransferWindows' slot.
 * The two NEVER coexist (that panel is the F6 costume, this is F5), same as
 * ProxOverlay reusing ReachOrb's z 32.
 *
 * Color law (VisualLaw + the TransferWindows precedent): this is a PLANNING
 * surface, not an alarm — THREAT red must pulse, so risk is carried by the
 * STEADY ProxOverlay INFO→THREAT gradient (the F5 trajectory colors) and the
 * WORD/number always double-encode it. SELECTION white marks only the
 * selected candidate. Never color-alone.
 *
 * @module ui/ProxContextPanel
 */

import { VisualLaw } from '../core/VisualLaw.js';
import { ProxOverlay } from './ProxOverlay.js';
import { ZONE_CORE_MIN, ZONE_MID_MIN } from '../entities/FieldRiskModel.js';

/**
 * G1 write cap: minimum real-time interval between innerHTML writes when the
 * STRUCTURAL content is unchanged (structural changes write immediately).
 * Same value/semantics as TransferWindows.DOM_WRITE_MIN_INTERVAL_MS — the
 * panel's numbers legitimately move on the floor's REFRESH_MS re-polls, but
 * a warp-fast floor may re-poll faster than the DOM should re-parse.
 */
const DOM_WRITE_MIN_INTERVAL_MS = 250;

/** Monotonic ms clock (DOM-guarded module — Date.now fallback for headless). */
const _nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class ProxContextPanel {
  /**
   * @param {object} [deps]
   * @param {function} [deps.now] - monotonic ms clock (tests)
   */
  constructor(deps = {}) {
    this._now = deps.now || _nowMs;
    this._root = null;
    this._built = false;
    this._visible = false;
    this._lastHtml = null;         // last painted markup (skip identical writes)
    this._lastStructKey = null;    // last painted structural fingerprint
    this._lastWriteMs = -Infinity; // last innerHTML write (real time)
  }

  /** @returns {boolean} shown (activate/deactivate lifecycle probe) */
  isVisible() { return this._visible; }

  /** G1 pin surface: the DOM-write cap (ms). */
  static get DOM_WRITE_MIN_INTERVAL_MS() { return DOM_WRITE_MIN_INTERVAL_MS; }

  /**
   * G1 pure gate: should refresh() write the DOM now? Structural changes
   * always write; otherwise writes are capped at DOM_WRITE_MIN_INTERVAL_MS.
   * (Same contract as TransferWindows.shouldWrite — pinned headless.)
   * @param {string} structKey
   * @param {string|null} lastStructKey
   * @param {number} nowMs
   * @param {number} lastWriteMs
   * @returns {boolean}
   */
  static shouldWrite(structKey, lastStructKey, nowMs, lastWriteMs) {
    if (structKey !== lastStructKey) return true;
    return (nowMs - lastWriteMs) >= DOM_WRITE_MIN_INTERVAL_MS;
  }

  // ── Pure formatting (static, headless-testable) ─────────────────────────────

  /**
   * FIELD VERDICT from the insertion candidates: the hottest candidate's
   * riskScore classified by the FieldRiskModel zone thresholds —
   * ≥ ZONE_CORE_MIN ⇒ HOT, ≥ ZONE_MID_MIN ⇒ WARM, else COLD. Candidates
   * without risk reads (no debris source injected) ⇒ the honest '—'.
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

  /** 'risk 42%' (or 'risk —' without a read). Matches the overlay's rounding. */
  static fmtRisk(riskScore) {
    return Number.isFinite(riskScore) ? `risk ${Math.round(riskScore * 100)}%` : 'risk \u2014';
  }

  /** '~3.2/min' scavenge estimate (or '~—/min'). Matches the overlay label. */
  static fmtRate(ratePerMin) {
    return Number.isFinite(ratePerMin) ? `~${ratePerMin.toFixed(1)}/min` : '~\u2014/min';
  }

  /** 'ΔV 118 m/s' (or 'ΔV —'). Matches the overlay label. */
  static fmtDv(dvMps) {
    return Number.isFinite(dvMps) ? `\u0394V ${Math.round(dvMps)} m/s` : '\u0394V \u2014';
  }

  /**
   * Build the display model. Pure — no DOM, no clocks.
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
        guideText: 'aim a cluster on NAVCOM to plan an approach',
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

  // ── DOM (guarded — TransferWindows house pattern) ───────────────────────────

  /** @private */
  _build() {
    if (this._built || typeof document === 'undefined' || !document.body) return;
    this._built = true;
    const root = document.createElement('div');
    root.id = 'ladder-prox-context';
    // TransferWindows' slot (left/bottom, z 34): the two never coexist — that
    // panel is the F6 costume, this is F5's.
    root.style.cssText = [
      'position:absolute', 'left:16px', 'bottom:16px', 'min-width:240px',
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
   * Paint the tactical-approach readout. Safe to call per frame: headless it
   * only computes the model; with a DOM the innerHTML cache + the G1 write cap
   * bound real writes to structural changes / ≤4 Hz.
   * @param {object} [state] - see readout()
   * @returns {object} the display model that was rendered
   */
  refresh(state = {}) {
    const model = ProxContextPanel.readout(state);
    if (!this._root) return model;
    const structKey = [
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

  /** @private Markup for a display model (VisualLaw colors; see header). */
  _html(m) {
    const rows = [
      `<div style="color:${VisualLaw.COLORS.PLAYER}">PROX NET \u00b7 ${m.clusterName}</div>`,
    ];
    if (m.empty) {
      rows.push(`<div>${m.stateText}</div>`);
      rows.push(`<div style="opacity:0.7">${m.guideText}</div>`);
      return rows.join('');
    }
    // Field verdict — steady risk-gradient color; the WORD carries the level.
    const vColor = (m.verdictRisk01 != null)
      ? ProxOverlay.riskColor(m.verdictRisk01) : VisualLaw.COLORS.INFO;
    rows.push(`<div style="color:${vColor}">FIELD ${m.verdictText} \u00b7 ${ProxContextPanel.fmtRisk(m.verdictRisk01 == null ? NaN : m.verdictRisk01)}</div>`);
    // The three insertion candidates: SELECTED expanded, others compact.
    for (const r of m.rows) {
      const rColor = (r.risk01 != null) ? ProxOverlay.riskColor(r.risk01) : VisualLaw.COLORS.INFO;
      if (r.selected) {
        // Selection is WHITE (the only use of white) + the ▸ shape channel.
        rows.push(`<div style="color:${VisualLaw.COLORS.SELECTION}">\u25b8 ${r.zone}</div>`);
        rows.push(`<div style="color:${rColor};padding-left:12px">${r.riskText} \u00b7 ${r.rateText}</div>`);
        rows.push(`<div style="padding-left:12px">${r.dvText}</div>`);
      } else {
        rows.push(`<div style="color:${rColor};opacity:0.75;padding-left:12px">${r.zone} \u00b7 ${r.riskText} \u00b7 ${r.dvText}</div>`);
      }
    }
    // Approach/autopilot state line: engaged reads PLAYER green (a live
    // system), standby stays dim INFO.
    rows.push(m.engaged
      ? `<div style="color:${VisualLaw.COLORS.PLAYER}">${m.stateText}</div>`
      : `<div style="opacity:0.7">${m.stateText}</div>`);
    // The Space-verb hint (F5 spaceVerb 'approach').
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
