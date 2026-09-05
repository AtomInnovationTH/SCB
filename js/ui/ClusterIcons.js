/**
 * ClusterIcons.js — the Zoom Ladder F6 (NAVCOM) world-icon layer (S5, M3).
 *
 * On F6 the near-field render pass is OFF and the full debris meshes are hidden
 * (FloorContract.FLOORS[5].fidelity.debrisMode === 'clusters', costume transform
 * 'ship-to-icon'). This layer draws the replacement: each debris cluster as a
 * ring + count icon, and the player ship as a velocity-aligned chevron
 * (VisualLaw.ICONS.SHAPES: cluster 'ring-count', ship 'chevron').
 *
 * VISUAL LAW (js/core/VisualLaw.js) — pinned by test-FloorContract.js:
 *   - icon sizes are exactly the 3 bands [12, 18, 24] px (count-weighted);
 *   - color is never the SOLE channel: count → size, focus → color AND scale;
 *   - clusters read INFO cyan; the focused cluster reads SELECTION white;
 *   - FUEL-REACHABILITY (optional opts.assessments): unreachable clusters are
 *     dimmed + dash-ringed, marginal read VALUE gold + dashed (never
 *     color-alone), and the FOCUSED cluster's label gains an estimate line
 *     ('ΔV 320 · Xe 2.1 kg · 14 min'); icon hitboxes (ring + count only — the
 *     root stays pointer-events:none) click-dispatch to the onSelect sink;
 *   - at most `labelBudget` (F6 = 7) icons carry a text label, the rest are
 *     ranked out (highest count first) — hover would reveal the rest (S6).
 *
 * The projection is INJECTED (`project(worldVec3) -> {x, y, visible}`) so the
 * layout math is unit-testable headless — the module never imports THREE and is
 * fully DOM-guarded (inert + constructible in Node tests). `render()` returns the
 * computed icon descriptors (also what drives the DOM) so tests assert layout,
 * ranking, sizing, and focus without a browser.
 *
 * This is FLOOR CONTENT (parallel track, docs/ladder/03-plan.md): it owns no
 * camera, no debris source, and no game loop — NavcomFloor (S5) feeds it clusters
 * + a projector, and the serial track wires NavcomFloor into main.js.
 *
 * @module ui/ClusterIcons
 */

import { VisualLaw } from '../core/VisualLaw.js';
import { FloorContract } from '../core/FloorContract.js';

/** Count thresholds mapping a cluster's member count to a VisualLaw size band.
 *  Three bands ↔ SIZES_PX [12, 18, 24]; endpoints pinned by test. */
const SIZE_BREAKS = [25, 100]; // <25 → 12px, <100 → 18px, else 24px

/**
 * FUEL-REACHABILITY (F6): opacity applied to clusters the ΔV budget cannot
 * reach. Verdict encoding is never color-alone (VisualLaw law): unreachable =
 * dim + dashed ring; marginal = VALUE gold + dashed ring; reachable = normal
 * INFO cyan solid. Own-module tunable (house rule: not FloorContract/Constants).
 */
export const UNREACHABLE_DIM_OPACITY = 0.35;

export class ClusterIcons {
  constructor() {
    this._root = null;
    this._shipEl = null;
    this._icons = new Map();  // clusterId → { el, ring, label }
    this._built = false;
    this._visible = false;
    this._onSelect = null;    // click-to-select sink: (clusterId) => void
  }

  /**
   * Wire the click-to-select sink. Individual icon hitboxes (ring + count
   * label only — the root stays pointer-events:none) dispatch the cluster id
   * here; NavcomFloor routes it into focusById().
   * @param {(id:*) => void} fn
   */
  setOnSelect(fn) { this._onSelect = (typeof fn === 'function') ? fn : null; }

  /**
   * Dispatch a click on a cluster icon to the onSelect sink. Public so the
   * dispatch path is headless-testable (the DOM listener calls this).
   * @param {*} id - cluster id
   */
  clickIcon(id) { if (this._onSelect) this._onSelect(id); }

  /**
   * Format a reachability assessment as the focused icon's estimate line,
   * e.g. 'ΔV 320 · Xe 2.1 kg · 14 min'. Pure + static.
   * @param {{dvCost:number, fuelKg:number, timeS:number}} a
   * @returns {string}
   */
  static estimateLine(a) {
    if (!a) return '';
    const dv = Number.isFinite(a.dvCost) ? Math.round(a.dvCost) : '\u2014';
    const xe = Number.isFinite(a.fuelKg) ? (Math.round(a.fuelKg * 10) / 10) : '\u2014';
    return `\u0394V ${dv} \u00b7 Xe ${xe} kg \u00b7 ${ClusterIcons.formatTime(a.timeS)}`;
  }

  /**
   * Compact duration for the estimate line. Pure + static.
   * @param {number} s - seconds
   * @returns {string} '45 s' / '14 min' / '2.5 h' ('—' for non-finite)
   */
  static formatTime(s) {
    if (!Number.isFinite(s)) return '\u2014';
    if (s < 90) return `${Math.round(s)} s`;
    if (s < 5400) return `${Math.round(s / 60)} min`;
    return `${(s / 3600).toFixed(1)} h`;
  }

  /**
   * Map a cluster member count to one of the three VisualLaw icon sizes.
   * Pure + static so the size law is unit-testable.
   * @param {number} count
   * @returns {number} px ∈ VisualLaw.ICONS.SIZES_PX ([12, 18, 24])
   */
  static sizeForCount(count) {
    const [small, mid, large] = VisualLaw.ICONS.SIZES_PX;
    const c = count > 0 ? count : 0;
    if (c < SIZE_BREAKS[0]) return small;
    if (c < SIZE_BREAKS[1]) return mid;
    return large;
  }

  /**
   * Rank clusters for the label budget: highest member count first (stable on
   * ties by id) then truncate to `budget`. Pure + static for testability.
   * @param {Array<{id:*, count:number}>} clusters
   * @param {number} budget
   * @returns {Array} the top `budget` clusters, count-desc
   */
  static rank(clusters, budget) {
    const list = Array.isArray(clusters) ? clusters.slice() : [];
    list.sort((a, b) => {
      const dc = (b.count || 0) - (a.count || 0);
      if (dc !== 0) return dc;
      return String(a.id).localeCompare(String(b.id));
    });
    const n = Math.max(0, budget | 0);
    return list.slice(0, n);
  }

  // ── DOM lifecycle (all no-op headless) ─────────────────────────────────────

  /** @private */
  _build() {
    if (this._built || typeof document === 'undefined' || !document.body) return;
    this._built = true;
    const root = document.createElement('div');
    root.id = 'ladder-cluster-icons';
    root.style.cssText = [
      'position:absolute', 'left:0', 'top:0', 'width:100%', 'height:100%',
      'pointer-events:none', 'z-index:33', 'opacity:0', 'transition:opacity 0.3s',
      'font-family:"Courier New",monospace', 'font-size:0.6rem',
    ].join(';');
    document.body.appendChild(root);
    this._root = root;
  }

  show() { this._build(); this._visible = true; if (this._root) this._root.style.opacity = '1'; }

  hide() {
    this._visible = false;
    if (this._root) this._root.style.opacity = '0';
    // Leaving the DOM in place (opacity 0) keeps re-show cheap; positions refresh
    // on the next render(). Nothing paints while hidden.
  }

  /**
   * Lay out the cluster icons for one frame.
   * @param {Array} clusters - from DebrisField.getDebrisClusters() (id, name, count, center{x,y,z})
   * @param {(pos:{x,y,z}) => {x:number, y:number, visible:boolean}} project - world→screen
   * @param {object} [opts]
   * @param {number} [opts.budget] - max labelled icons (default F6 labelBudget = 7)
   * @param {*} [opts.focusId] - the currently-focused cluster id (SELECTION white)
   * @param {Map|object} [opts.assessments] - FUEL-REACHABILITY: clusterId →
   *                 ReachabilityModel.assess() result. Absent → the pre-reach
   *                 rendering, byte-identical.
   * @returns {Array<{id:*, name:string, count:number, x:number, y:number, sizePx:number,
   *                  focused:boolean, verdict:?string, estimate:?string, dimmed:boolean}>}
   */
  render(clusters, project, opts = {}) {
    const budget = (opts.budget != null) ? opts.budget : FloorContract.byId(6).labelBudget;
    const focusId = (opts.focusId != null) ? opts.focusId : null;
    const assessments = opts.assessments || null;
    const assessFor = (id) => {
      if (!assessments) return null;
      return (typeof assessments.get === 'function') ? (assessments.get(id) || null) : (assessments[id] || null);
    };
    const ranked = ClusterIcons.rank(clusters, budget);

    const descriptors = [];
    const seen = new Set();
    for (const c of ranked) {
      const p = project ? project(c.center) : { x: 0, y: 0, visible: false };
      if (!p || !p.visible) continue;
      const sizePx = ClusterIcons.sizeForCount(c.count);
      const focused = focusId != null && c.id === focusId;
      const a = assessFor(c.id);
      const verdict = a ? a.verdict : null;
      const estimate = (focused && a) ? ClusterIcons.estimateLine(a) : null;
      const dimmed = verdict === 'unreachable';
      descriptors.push({
        id: c.id, name: c.name, count: c.count, x: p.x, y: p.y, sizePx, focused,
        verdict, estimate, dimmed,
      });
      seen.add(c.id);
      this._paintIcon(c, p, sizePx, focused, verdict, estimate);
    }
    // Retire icons no longer in the visible set (idempotent — G1 churn fix).
    for (const [id, rec] of this._icons) {
      if (!seen.has(id) && rec._display !== 'none') {
        rec.el.style.display = 'none';
        rec._display = 'none';
      }
    }
    return descriptors;
  }

  /** @private Build/position one ring+count icon. */
  _paintIcon(cluster, p, sizePx, focused, verdict = null, estimate = null) {
    if (!this._root) return;
    let rec = this._icons.get(cluster.id);
    if (!rec) {
      const el = document.createElement('div');
      el.style.cssText = 'position:absolute;transform:translate(-50%,-50%);text-align:center;';
      const ring = document.createElement('div');
      ring.style.cssText = 'border-style:solid;border-radius:50%;margin:0 auto;';
      const label = document.createElement('div');
      label.style.cssText = 'margin-top:2px;white-space:nowrap;';
      el.appendChild(ring);
      el.appendChild(label);
      // Click-to-select: the ROOT stays pointer-events:none; only the ring +
      // count label are hitboxes (12–30 px + a short number — small enough to
      // never block canvas interaction elsewhere). The listener sits on the
      // wrapper and dispatches through clickIcon() → the onSelect sink.
      ring.style.pointerEvents = 'auto';
      ring.style.cursor = 'pointer';
      label.style.pointerEvents = 'auto';
      label.style.cursor = 'pointer';
      el.addEventListener('click', (ev) => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        this.clickIcon(cluster.id);
      });
      this._root.appendChild(el);
      // The `_`-prefixed fields cache the last WRITTEN value of every property
      // that rarely changes, so the per-frame render only touches left/top
      // (world-anchored — legitimately changes every frame). G1 (post-M3
      // play-test): the unconditional writes re-replaced the label text node
      // every frame — the instrumented probe measured #ladder-cluster-icons
      // childList mutations at one add+remove per icon per frame (~17 Hz
      // headless, would be ~120 Hz at 120 fps) for text that almost never
      // changes. Same-value style writes are cached on the same principle.
      // est (the focused estimate line) is created LAZILY on first use so the
      // no-assessment path leaves the DOM exactly as before (byte-identical).
      rec = {
        el, ring, label, est: null,
        _display: null, _dim: null, _focused: null, _color: null, _count: null,
        _dimmed: false, _dashed: false, _estText: null,
      };
      this._icons.set(cluster.id, rec);
    }
    // FUEL-REACHABILITY verdict encoding (never color-alone): marginal = VALUE
    // gold + dashed; unreachable = dimmed + dashed; reachable/unknown = INFO
    // solid. Focus stays SELECTION white (double-encoded: thicker ring + scale).
    const color = focused ? VisualLaw.COLORS.SELECTION
      : (verdict === 'marginal' ? VisualLaw.COLORS.VALUE : VisualLaw.COLORS.INFO);
    const scale = focused ? 1.25 : 1;
    const dim = Math.round(sizePx * scale);
    if (rec._display !== 'block') { rec.el.style.display = 'block'; rec._display = 'block'; }
    rec.el.style.left = `${p.x}px`;
    rec.el.style.top = `${p.y}px`;
    if (rec._dim !== dim) {
      rec.ring.style.width = `${dim}px`;
      rec.ring.style.height = `${dim}px`;
      rec._dim = dim;
    }
    if (rec._focused !== focused) {
      rec.ring.style.borderWidth = focused ? '2px' : '1px';
      rec._focused = focused;
    }
    if (rec._color !== color) {
      rec.ring.style.borderColor = color;
      rec.label.style.color = color;
      rec._color = color;
    }
    const dimmed = verdict === 'unreachable';
    if (rec._dimmed !== dimmed) {
      rec.el.style.opacity = dimmed ? String(UNREACHABLE_DIM_OPACITY) : '1';
      rec._dimmed = dimmed;
    }
    const dashed = verdict === 'marginal' || verdict === 'unreachable';
    if (rec._dashed !== dashed) {
      rec.ring.style.borderStyle = dashed ? 'dashed' : 'solid';
      rec._dashed = dashed;
    }
    if (rec._count !== cluster.count) {
      rec.label.textContent = String(cluster.count);
      rec._count = cluster.count;
    }
    if (rec._estText !== estimate) {
      if (estimate) {
        if (!rec.est) {
          const est = document.createElement('div');
          est.style.cssText = 'margin-top:1px;white-space:nowrap;opacity:0.85;pointer-events:none;';
          rec.el.appendChild(est);
          rec.est = est;
        }
        rec.est.style.display = 'block';
        rec.est.style.color = rec._color;
        rec.est.textContent = estimate;
      } else if (rec.est) {
        rec.est.style.display = 'none';
        rec.est.textContent = '';
      }
      rec._estText = estimate;
    }
  }

  /**
   * Draw the player ship as a velocity-aligned chevron (ship-to-icon transform).
   * @param {{x:number, y:number, visible:boolean}} p - projected ship position
   * @param {number} [angleRad] - screen-space velocity heading (0 = +x)
   * @returns {{x:number, y:number, visible:boolean, shape:string, angleRad:number}}
   */
  renderShip(p, angleRad = 0) {
    const out = { x: p?.x ?? 0, y: p?.y ?? 0, visible: !!(p && p.visible), shape: VisualLaw.ICONS.SHAPES.ship, angleRad };
    if (!this._root) return out;
    if (!this._shipEl) {
      const el = document.createElement('div');
      // A CSS chevron (two strokes) sized within the icon band, tinted PLAYER green.
      el.style.cssText = [
        'position:absolute', 'transform-origin:center', 'pointer-events:none',
        `width:${VisualLaw.ICONS.SIZES_PX[0]}px`, `height:${VisualLaw.ICONS.SIZES_PX[0]}px`,
        `border-left:2px solid ${VisualLaw.COLORS.PLAYER}`, `border-top:2px solid ${VisualLaw.COLORS.PLAYER}`,
      ].join(';');
      this._root.appendChild(el);
      this._shipEl = el;
    }
    const display = out.visible ? 'block' : 'none';
    if (this._shipDisplay !== display) { this._shipEl.style.display = display; this._shipDisplay = display; }
    if (out.visible) {
      // The bare corner (border-left+top) reads as a chevron; rotate to heading.
      this._shipEl.style.left = `${out.x}px`;
      this._shipEl.style.top = `${out.y}px`;
      this._shipEl.style.transform = `translate(-50%,-50%) rotate(${angleRad + Math.PI / 4}rad)`;
    }
    return out;
  }

  /** Remove the whole layer. */
  dispose() {
    if (this._root && this._root.remove) this._root.remove();
    this._root = null;
    this._shipEl = null;
    this._icons.clear();
    this._built = false;
  }
}
