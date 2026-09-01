/**
 * ProxOverlay.js — the Zoom Ladder F5 (PROX NET) tactical overlay (S4).
 *
 * On F5 the near field stays live (fidelity.debrisMode 'tactical') but the
 * working range is 100 m – 120 km: individual meshes are sub-pixel, so this
 * layer draws the tactical read over them:
 *   - VALUE-CODED OBJECT MARKERS from DebrisField.getEnhancedTargetList()
 *     (estimatedPoints/risk fields): VisualLaw VALUE gold, steady, marker
 *     radius exaggerated by value (MARKER_MIN_PX..MARKER_MAX_PX against
 *     VALUE_REF_PTS) — never color-alone. At most `labelBudget` (F5 = 7)
 *     markers carry a text label, ranked by estimatedPoints.
 *   - PLAYER MARKER + orbit direction: a PLAYER-green chevron rotated to the
 *     screen-space velocity heading (the ClusterIcons ship grammar).
 *   - WIREFRAME DENSITY SHELLS: 2–3 translucent rings in the player's orbital
 *     plane at the FieldRiskModel sampling radii, each labeled with its zone
 *     and opacity-weighted by its measured shell density.
 *   - INSERTION POINTS (when a target cluster is set): the InsertionPlanner's
 *     edge/mid/core candidates with risk-colored trajectories — a VisualLaw
 *     THREAT gradient (INFO cyan at risk 0 → THREAT red-orange at risk 1),
 *     double-encoded in line width; the SELECTED candidate reads SELECTION
 *     white with a heavier ring (selection is the ONLY use of white).
 *
 * Pattern-matches the ClusterIcons/ReachOrb overlay style: one full-screen
 * canvas, pointer-events:none (F5 selection is CYCLED by the floor controller
 * — click/keyboard-free per the F5 brief — so no hitboxes are mounted), built
 * lazily on show(), opacity-transitioned, fully DOM-guarded (inert +
 * constructible headless). render() always computes and RETURNS the frame
 * descriptors so tests assert layout/ranking/colors without a browser;
 * painting happens only when the DOM canvas exists and the layer is shown.
 *
 * FLOOR CONTENT (parallel track): no camera, no debris source, no game loop —
 * ProxNetFloor feeds render() from its own per-frame tick with an injected
 * projector `(worldVec3) -> {x, y, visible}`.
 *
 * @module ui/ProxOverlay
 */

import { VisualLaw } from '../core/VisualLaw.js';
import { FloorContract } from '../core/FloorContract.js';

/** Value-marker radius band (px): radius = MIN + (MAX−MIN)·√(min(1, pts/REF)).
 *  √ so mid-value targets stay distinguishable; REF saturates the band. */
export const MARKER_MIN_PX = 3;
export const MARKER_MAX_PX = 14;
export const VALUE_REF_PTS = 1500;

/** Density-shell sampling (points per ring). */
export const SHELL_SEGMENTS = 48;

/** Trajectory stroke width band (px): width = MIN + (MAX−MIN)·risk. */
export const TRAJ_WIDTH_MIN_PX = 1;
export const TRAJ_WIDTH_MAX_PX = 3;

/** Insertion-point ring radius (px); the selected ring draws 1.4×. */
export const INSERTION_RING_PX = 8;

/** F5 floor entry (id 5) — labelBudget source. */
const F5 = FloorContract.FLOORS[4];

/** @private clamp to [0,1] */
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** @private '#rrggbb' → [r,g,b] */
function hexRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const INFO_RGB = hexRgb(VisualLaw.COLORS.INFO);
const THREAT_RGB = hexRgb(VisualLaw.COLORS.THREAT);

export class ProxOverlay {
  constructor() {
    this._canvas = null;
    this._ctx2d = null;
    this._built = false;
    this._visible = false;
  }

  /** @returns {boolean} shown (activate/deactivate lifecycle probe) */
  isVisible() { return this._visible; }

  // ── Pure grammar (static, headless-testable) ────────────────────────────────

  /**
   * Value-exaggerated marker radius (px) for an estimatedPoints value.
   * @param {number} estimatedPoints
   * @returns {number} px ∈ [MARKER_MIN_PX, MARKER_MAX_PX]
   */
  static markerRadiusPx(estimatedPoints) {
    const v = clamp01((estimatedPoints || 0) / VALUE_REF_PTS);
    return MARKER_MIN_PX + (MARKER_MAX_PX - MARKER_MIN_PX) * Math.sqrt(v);
  }

  /**
   * Rank targets for the label budget: highest estimatedPoints first (stable
   * on ties by id), truncated to `budget`. Pure + static.
   * @param {Array<{id:*, estimatedPoints:number}>} targets
   * @param {number} budget
   * @returns {Array} the top `budget` targets, value-desc
   */
  static rankByValue(targets, budget) {
    const list = Array.isArray(targets) ? targets.slice() : [];
    list.sort((a, b) => {
      const dv = (b.estimatedPoints || 0) - (a.estimatedPoints || 0);
      if (dv !== 0) return dv;
      return String(a.id).localeCompare(String(b.id));
    });
    return list.slice(0, Math.max(0, budget | 0));
  }

  /**
   * The VisualLaw THREAT gradient: risk 0 → INFO cyan, risk 1 → THREAT
   * red-orange (linear RGB lerp). Color is never the sole channel — callers
   * double-encode risk in stroke width (trajWidthPx).
   * @param {number} risk01
   * @returns {string} 'rgb(r,g,b)'
   */
  static riskColor(risk01) {
    const t = clamp01(risk01 || 0);
    const r = Math.round(INFO_RGB[0] + (THREAT_RGB[0] - INFO_RGB[0]) * t);
    const g = Math.round(INFO_RGB[1] + (THREAT_RGB[1] - INFO_RGB[1]) * t);
    const b = Math.round(INFO_RGB[2] + (THREAT_RGB[2] - INFO_RGB[2]) * t);
    return `rgb(${r}, ${g}, ${b})`;
  }

  /** Risk-scaled trajectory stroke width (px) — the non-color risk channel. */
  static trajWidthPx(risk01) {
    return TRAJ_WIDTH_MIN_PX + (TRAJ_WIDTH_MAX_PX - TRAJ_WIDTH_MIN_PX) * clamp01(risk01 || 0);
  }

  /**
   * Orthonormal in-plane basis of the player's orbital plane (the ReachOrb
   * plane rule): normal = pos × vel, degenerate/missing velocity falls back to
   * the scene equator. Used to orient the density-shell rings.
   * @param {{x,y,z}} posU
   * @param {{x,y,z}|null} velU
   * @returns {{e1:{x,y,z}, e2:{x,y,z}}}
   */
  static planeBasis(posU, velU) {
    const p = posU || { x: 1, y: 0, z: 0 };
    const v = velU || { x: 0, y: 0, z: 0 };
    let nx = p.y * v.z - p.z * v.y;
    let ny = p.z * v.x - p.x * v.z;
    let nz = p.x * v.y - p.y * v.x;
    let nLen = Math.hypot(nx, ny, nz);
    const pLen = Math.hypot(p.x, p.y, p.z) || 1;
    if (!(nLen > 1e-9 * pLen)) { nx = 0; ny = 0; nz = 1; nLen = 1; }
    nx /= nLen; ny /= nLen; nz /= nLen;
    let e1x = p.x - (p.x * nx + p.y * ny + p.z * nz) * nx;
    let e1y = p.y - (p.x * nx + p.y * ny + p.z * nz) * ny;
    let e1z = p.z - (p.x * nx + p.y * ny + p.z * nz) * nz;
    let e1Len = Math.hypot(e1x, e1y, e1z);
    if (!(e1Len > 1e-12)) { e1x = 1; e1y = 0; e1z = 0; e1Len = 1; }
    e1x /= e1Len; e1y /= e1Len; e1z /= e1Len;
    return {
      e1: { x: e1x, y: e1y, z: e1z },
      e2: {
        x: ny * e1z - nz * e1y,
        y: nz * e1x - nx * e1z,
        z: nx * e1y - ny * e1x,
      },
    };
  }

  /**
   * Sample a circle of radius `radiusU` around `centerU` in the given plane
   * basis. Pure world-space points (no projection).
   * @param {{x,y,z}} centerU
   * @param {number} radiusU
   * @param {{e1:{x,y,z}, e2:{x,y,z}}} basis
   * @param {number} [n=SHELL_SEGMENTS]
   * @returns {Array<{x:number,y:number,z:number}>}
   */
  static ringPoints(centerU, radiusU, basis, n = SHELL_SEGMENTS) {
    const { e1, e2 } = basis;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const th = (i / n) * Math.PI * 2;
      const c = Math.cos(th) * radiusU;
      const s = Math.sin(th) * radiusU;
      pts.push({
        x: centerU.x + c * e1.x + s * e2.x,
        y: centerU.y + c * e1.y + s * e2.y,
        z: centerU.z + c * e1.z + s * e2.z,
      });
    }
    return pts;
  }

  // ── DOM lifecycle (all no-op headless; ReachOrb overlay pattern) ────────────

  /** @private */
  _build() {
    if (this._built || typeof document === 'undefined' || !document.body) return;
    this._built = true;
    const canvas = document.createElement('canvas');
    canvas.id = 'ladder-prox-overlay';
    // z-index 32 (ReachOrb's slot — the two never coexist: orb is F6, this is
    // F5): beneath the cluster icons (33) + transfer panel (34). No hitboxes:
    // F5 selection cycling is dispatch-driven (ProxNetFloor.cycleInsertion),
    // so the whole layer stays pointer-events:none.
    canvas.style.cssText = [
      'position:absolute', 'left:0', 'top:0', 'width:100%', 'height:100%',
      'pointer-events:none', 'z-index:32', 'opacity:0', 'transition:opacity 0.3s',
    ].join(';');
    document.body.appendChild(canvas);
    this._canvas = canvas;
    this._ctx2d = canvas.getContext ? canvas.getContext('2d') : null;
  }

  show() { this._build(); this._visible = true; if (this._canvas) this._canvas.style.opacity = '1'; }

  hide() {
    this._visible = false;
    if (this._canvas) {
      this._canvas.style.opacity = '0';
      // Clear immediately so a re-shown F5 never flashes a stale frame.
      if (this._ctx2d) this._ctx2d.clearRect(0, 0, this._canvas.width, this._canvas.height);
    }
  }

  // ── Per-frame ───────────────────────────────────────────────────────────────

  /**
   * Compute (and, when the DOM layer is shown, paint) one overlay frame.
   *
   * @param {object} frame
   * @param {Array} [frame.targets] - merged marker records:
   *                 {id, estimatedPoints, risk, posU:{x,y,z}} (ProxNetFloor
   *                 merges getEnhancedTargetList entries with live positions)
   * @param {{x,y,z}} [frame.shipPos] - player position (scene units)
   * @param {number} [frame.shipAngleRad] - screen-space velocity heading
   * @param {{x,y,z}|null} [frame.shipVel] - player velocity (shell plane)
   * @param {Array} [frame.shells] - FieldRiskModel shell reads:
   *                 {radiusU, radiusKm, sat01, cumCount} (rings center on ship)
   * @param {object|null} [frame.insertion] - {candidates, selectedIndex} from
   *                 the InsertionPlanner via ProxNetFloor
   * @param {number} [frame.labelBudget] - default F5 labelBudget (7)
   * @param {(pos:{x,y,z}) => {x,y,visible}} project - world→screen
   * @returns {{
   *   markers: Array<{id, x, y, visible, rPx, color, labeled, label, risk}>,
   *   ship: {x, y, visible, angleRad}|null,
   *   shells: Array<{radiusKm, sat01, zoneLabel, pts:Array<{x,y,visible}>}>,
   *   insertion: {
   *     points: Array<{zone, x, y, visible, selected, risk01, color, label}>,
   *     trajectories: Array<{zone, selected, risk01, color, widthPx, pts:Array<{x,y,visible}>}>,
   *   }|null,
   * }}
   */
  render(frame = {}, project) {
    const budget = (frame.labelBudget != null) ? frame.labelBudget : F5.labelBudget;
    const proj = (typeof project === 'function')
      ? project
      : () => ({ x: 0, y: 0, visible: false });

    // ── Value markers ──
    const targets = Array.isArray(frame.targets) ? frame.targets : [];
    const labeledIds = new Set(ProxOverlay.rankByValue(targets, budget).map((t) => t.id));
    const markers = [];
    for (const t of targets) {
      if (!t || !t.posU) continue;
      const p = proj(t.posU) || { x: 0, y: 0, visible: false };
      const labeled = labeledIds.has(t.id);
      markers.push({
        id: t.id,
        x: p.x, y: p.y, visible: !!p.visible,
        rPx: ProxOverlay.markerRadiusPx(t.estimatedPoints),
        color: VisualLaw.COLORS.VALUE,      // gold, STEADY (never pulses)
        labeled,
        label: labeled ? `${t.estimatedPoints || 0}` : null,
        risk: t.risk || null,
      });
    }

    // ── Player marker ──
    let ship = null;
    if (frame.shipPos) {
      const p = proj(frame.shipPos) || { x: 0, y: 0, visible: false };
      ship = { x: p.x, y: p.y, visible: !!p.visible, angleRad: frame.shipAngleRad || 0 };
    }

    // ── Density shells (rings around the ship in its orbital plane) ──
    const shells = [];
    if (frame.shipPos && Array.isArray(frame.shells) && frame.shells.length) {
      const basis = ProxOverlay.planeBasis(frame.shipPos, frame.shipVel || null);
      for (const s of frame.shells) {
        if (!(s && s.radiusU > 0)) continue;
        const pts3 = ProxOverlay.ringPoints(frame.shipPos, s.radiusU, basis);
        shells.push({
          radiusKm: s.radiusKm,
          sat01: clamp01(s.sat01 || 0),
          zoneLabel: `${s.radiusKm} km \u00b7 ${s.cumCount || 0}`,
          pts: pts3.map((q) => proj(q) || { x: 0, y: 0, visible: false }),
        });
      }
    }

    // ── Insertion points + risk-colored trajectories ──
    let insertion = null;
    const cands = frame.insertion && Array.isArray(frame.insertion.candidates)
      ? frame.insertion.candidates : null;
    if (cands && cands.length) {
      const sel = frame.insertion.selectedIndex | 0;
      const points = [];
      const trajectories = [];
      for (let i = 0; i < cands.length; i++) {
        const c = cands[i];
        if (!c || !c.pos) continue;
        const selected = i === sel;
        const risk01 = clamp01(c.riskScore || 0);
        const p = proj(c.pos) || { x: 0, y: 0, visible: false };
        const riskPct = Math.round(risk01 * 100);
        const rate = Number.isFinite(c.estScavengeRate) ? c.estScavengeRate.toFixed(1) : '\u2014';
        const dv = Number.isFinite(c.dvEstimate) ? `${Math.round(c.dvEstimate)} m/s` : '\u2014';
        points.push({
          zone: c.zone,
          x: p.x, y: p.y, visible: !!p.visible,
          selected,
          risk01,
          // Selection is WHITE (the only use of white); unselected points read
          // the risk gradient. Selection double-encodes via the heavier ring.
          color: selected ? VisualLaw.COLORS.SELECTION : ProxOverlay.riskColor(risk01),
          label: `${(c.zone || '').toUpperCase()} \u00b7 risk ${riskPct}% \u00b7 ~${rate}/min \u00b7 \u0394V ${dv}`,
        });
        trajectories.push({
          zone: c.zone,
          selected,
          risk01,
          color: ProxOverlay.riskColor(risk01),
          widthPx: ProxOverlay.trajWidthPx(risk01) + (selected ? 1 : 0),
          pts: (c.waypoints || []).map((q) => proj(q) || { x: 0, y: 0, visible: false }),
        });
      }
      insertion = { points, trajectories };
    }

    const out = { markers, ship, shells, insertion };
    this._paint(out);
    return out;
  }

  // ── Painting (no-op headless / while hidden) ────────────────────────────────

  /** @private */
  _paint(f) {
    const canvas = this._canvas;
    const g = this._ctx2d;
    if (!canvas || !g || !this._visible) return;
    const w = (typeof window !== 'undefined') ? window.innerWidth : canvas.width;
    const h = (typeof window !== 'undefined') ? window.innerHeight : canvas.height;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    g.clearRect(0, 0, w, h);
    g.font = '10px "Courier New", monospace';

    // Density shells first (context, never occludes the actionables).
    for (const s of f.shells) {
      g.strokeStyle = VisualLaw.COLORS.INFO;
      g.globalAlpha = 0.12 + 0.28 * s.sat01;   // density-weighted translucency
      g.lineWidth = 1;
      this._strokePolyline(g, s.pts, false);
      // Ring tag at the first visible sample.
      const tag = s.pts.find((p) => p.visible);
      if (tag) {
        g.globalAlpha = 0.5;
        g.fillStyle = VisualLaw.COLORS.INFO;
        g.textAlign = 'left';
        g.fillText(s.zoneLabel, tag.x + 4, tag.y - 4);
      }
      g.globalAlpha = 1;
    }

    // Trajectories under their arrival points.
    if (f.insertion) {
      for (const t of f.insertion.trajectories) {
        g.strokeStyle = t.color;
        g.lineWidth = t.widthPx;
        g.globalAlpha = t.selected ? 0.9 : 0.45;
        this._strokePolyline(g, t.pts, true);
        g.globalAlpha = 1;
      }
      for (const p of f.insertion.points) {
        if (!p.visible) continue;
        const r = INSERTION_RING_PX * (p.selected ? 1.4 : 1);
        g.strokeStyle = p.color;
        g.lineWidth = p.selected ? 2 : 1;
        g.beginPath();
        g.arc(p.x, p.y, r, 0, Math.PI * 2);
        g.stroke();
        // Cross-hair tick (shape channel — selection/risk never color-alone).
        g.beginPath();
        g.moveTo(p.x - r - 3, p.y); g.lineTo(p.x - r + 3, p.y);
        g.moveTo(p.x + r - 3, p.y); g.lineTo(p.x + r + 3, p.y);
        g.stroke();
        g.fillStyle = p.color;
        g.textAlign = 'left';
        g.fillText(p.label, p.x + r + 5, p.y + 3);
      }
    }

    // Value markers (gold, steady).
    for (const m of f.markers) {
      if (!m.visible) continue;
      g.strokeStyle = m.color;
      g.lineWidth = 1;
      g.globalAlpha = 0.9;
      g.beginPath();
      // Diamond (VisualLaw debris shape) sized by value.
      g.moveTo(m.x, m.y - m.rPx);
      g.lineTo(m.x + m.rPx, m.y);
      g.lineTo(m.x, m.y + m.rPx);
      g.lineTo(m.x - m.rPx, m.y);
      g.closePath();
      g.stroke();
      if (m.labeled) {
        g.fillStyle = m.color;
        g.textAlign = 'center';
        g.fillText(m.label, m.x, m.y - m.rPx - 4);
      }
      g.globalAlpha = 1;
    }

    // Player chevron (heritage green, points along the screen velocity).
    if (f.ship && f.ship.visible) {
      const { x, y, angleRad } = f.ship;
      const L = 7;
      g.strokeStyle = VisualLaw.COLORS.PLAYER;
      g.lineWidth = 2;
      g.beginPath();
      const tipX = x + Math.cos(angleRad) * L;
      const tipY = y + Math.sin(angleRad) * L;
      const backA = angleRad + Math.PI * 0.75;
      const backB = angleRad - Math.PI * 0.75;
      g.moveTo(x + Math.cos(backA) * L, y + Math.sin(backA) * L);
      g.lineTo(tipX, tipY);
      g.lineTo(x + Math.cos(backB) * L, y + Math.sin(backB) * L);
      g.stroke();
    }
  }

  /** @private Stroke a projected polyline, skipping invisible segments.
   *  `open` polylines connect i→i+1 only; closed rings also join last→first. */
  _strokePolyline(g, pts, open) {
    if (!pts || pts.length < 2) return;
    g.beginPath();
    const n = pts.length;
    const last = open ? n - 1 : n;
    for (let i = 0; i < last; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      if (!a.visible || !b.visible) continue;
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
    }
    g.stroke();
  }

  /** Remove the whole layer. */
  dispose() {
    if (this._canvas && this._canvas.remove) this._canvas.remove();
    this._canvas = null;
    this._ctx2d = null;
    this._built = false;
    this._visible = false;
  }
}
