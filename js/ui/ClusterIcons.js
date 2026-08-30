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

export class ClusterIcons {
  constructor() {
    this._root = null;
    this._shipEl = null;
    this._icons = new Map();  // clusterId → { el, ring, label }
    this._built = false;
    this._visible = false;
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
   * @returns {Array<{id:*, name:string, count:number, x:number, y:number, sizePx:number, focused:boolean}>}
   */
  render(clusters, project, opts = {}) {
    const budget = (opts.budget != null) ? opts.budget : FloorContract.FLOORS[5].labelBudget;
    const focusId = (opts.focusId != null) ? opts.focusId : null;
    const ranked = ClusterIcons.rank(clusters, budget);

    const descriptors = [];
    const seen = new Set();
    for (const c of ranked) {
      const p = project ? project(c.center) : { x: 0, y: 0, visible: false };
      if (!p || !p.visible) continue;
      const sizePx = ClusterIcons.sizeForCount(c.count);
      const focused = focusId != null && c.id === focusId;
      descriptors.push({ id: c.id, name: c.name, count: c.count, x: p.x, y: p.y, sizePx, focused });
      seen.add(c.id);
      this._paintIcon(c, p, sizePx, focused);
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
  _paintIcon(cluster, p, sizePx, focused) {
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
      this._root.appendChild(el);
      // The `_`-prefixed fields cache the last WRITTEN value of every property
      // that rarely changes, so the per-frame render only touches left/top
      // (world-anchored — legitimately changes every frame). G1 (post-M3
      // play-test): the unconditional writes re-replaced the label text node
      // every frame — the instrumented probe measured #ladder-cluster-icons
      // childList mutations at one add+remove per icon per frame (~17 Hz
      // headless, would be ~120 Hz at 120 fps) for text that almost never
      // changes. Same-value style writes are cached on the same principle.
      rec = { el, ring, label, _display: null, _dim: null, _focused: null, _color: null, _count: null };
      this._icons.set(cluster.id, rec);
    }
    const color = focused ? VisualLaw.COLORS.SELECTION : VisualLaw.COLORS.INFO;
    // Focus is double-encoded: color (white) AND a thicker ring + slight scale.
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
    if (rec._count !== cluster.count) {
      rec.label.textContent = String(cluster.count);
      rec._count = cluster.count;
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
