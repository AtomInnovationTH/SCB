/**
 * BlueprintOverlay.js — the Zoom Ladder F3 (HULL CAM) blueprint callout layer
 * (S4, FloorContract.FLOORS[2], costume.arrive 'BlueprintOverlay' — with the
 * cyan hull outline it IS the F3 workbench costume, 08-workbench §2).
 *
 * F3 is the close-inspection floor: this layer draws the "blueprint" costume —
 * labeled subsystem callouts (ENGINEERING / POWER / COMMS / THERMAL / CARGO,
 * js/data/blueprintSubsystems.js) joined to their hull anchor points by elbow
 * LEADER LINES, in the MotherCallouts visual language (anchor dot → elbow →
 * side-rail card, cards stacked so labels never crowd or cross). DOM cards +
 * one SVG line layer; no THREE.
 *
 * VISUAL LAW (js/core/VisualLaw.js):
 *   - callouts read INFO cyan; the focused subsystem reads SELECTION white and
 *     is double-encoded (thicker leader + heavier card border — never
 *     color-alone);
 *   - at most `labelBudget` (F3 = 7) callouts render, priority-ranked via
 *     the static rank() law (highest first, stable ties by id).
 *
 * The projection is INJECTED (`project(shipLocalU) -> {x, y, visible}`, ship-
 * LOCAL scene units — HullCamFloor resolves anchors, the serial track composes
 * localToWorld ∘ worldToScreen), so layout is unit-testable headless: the
 * module is fully DOM-guarded (inert + constructible in Node) and render()
 * returns the computed descriptors that also drive the DOM.
 *
 * WRITE-ON-CHANGE (the ClusterIcons G1 / TransferWindows shouldWrite house
 * rule): every descriptor carries `dirty` — true only when that callout's
 * CONTENT fingerprint (contentKey: label/rows/color/lens) changed since the
 * last render. Content DOM writes (text, colors, borders) are gated on it;
 * only positions (card left/top, leader points, dot) write per frame, because
 * the ship legitimately rotates under the camera. The `dirty` flag IS the DOM
 * gate (one computation), so pinning descriptors pins the DOM behavior.
 *
 * FLOOR CONTENT (parallel track, docs/ladder/03-plan.md): owns no camera, no
 * lens state, no game loop — HullCamFloor feeds it items + a projector; the
 * serial track mounts it.
 *
 * @module ui/BlueprintOverlay
 */

import { VisualLaw } from '../core/VisualLaw.js';
import { FloorContract } from '../core/FloorContract.js';

/** Card attach-edge distance from the layout center line (px). */
export const RAIL_DX_PX = 190;
/** Horizontal elbow run between the leader knee and the card edge (px). */
export const ELBOW_DX_PX = 16;
/** Minimum vertical gap between stacked cards on one rail (px). */
export const SLOT_GAP_PX = 30;
/** Max rows painted on one card (MotherCallouts focused-card budget). */
export const CARD_ROW_BUDGET = 6;

const SVG_NS = 'http://www.w3.org/2000/svg';

export class BlueprintOverlay {
  constructor() {
    this._root = null;
    this._svg = null;
    this._cards = new Map();   // id → { el, title, rows, line, dot, caches… }
    this._keys = new Map();    // id → last painted contentKey (headless too)
    this._built = false;
    this._visible = false;
  }

  /**
   * Rank callout items for the label budget: highest priority first, stable
   * on ties by id, truncated to `budget`. Pure + static (ClusterIcons.rank
   * shape) so the budget law is unit-testable.
   * @param {Array<{id:*, priority:number}>} items
   * @param {number} budget
   * @returns {Array}
   */
  static rank(items, budget) {
    const list = Array.isArray(items) ? items.slice() : [];
    list.sort((a, b) => {
      const dp = (b.priority || 0) - (a.priority || 0);
      if (dp !== 0) return dp;
      return String(a.id).localeCompare(String(b.id));
    });
    const n = Math.max(0, budget | 0);
    return list.slice(0, n);
  }

  /**
   * Content fingerprint of one callout: everything a content DOM write paints
   * (label, rows, color, focus weight, lens variant) — and nothing positional.
   * Pure + static; the single source for the write-on-change gate.
   * @param {{label:string, rows:?Array<string>, focused:boolean}} item
   * @param {string} lens - 'detail' | 'overview'
   * @returns {string}
   */
  static contentKey(item, lens) {
    const rows = Array.isArray(item.rows) ? item.rows.slice(0, CARD_ROW_BUDGET) : [];
    return [
      item.label, item.focused ? 'F' : '-', lens || 'overview', rows.join('|'),
    ].join('::');
  }

  // ── DOM lifecycle (all no-op headless) ─────────────────────────────────────

  /** @private */
  _build() {
    // Feature-check everything this layer touches: earlier-registered tests
    // leak PARTIAL document stubs into the shared Node process (createElement
    // + body, no createElementNS), and a DOM-guarded module must stay inert
    // under them, not crash (the ClusterIcons guard, extended for the SVG).
    if (this._built || typeof document === 'undefined' || !document.body
      || typeof document.createElementNS !== 'function') return;
    this._built = true;
    const root = document.createElement('div');
    root.id = 'ladder-blueprint-overlay';
    root.style.cssText = [
      'position:absolute', 'left:0', 'top:0', 'width:100%', 'height:100%',
      'pointer-events:none', 'z-index:32', 'opacity:0', 'transition:opacity 0.3s',
      'font-family:"Courier New",monospace', 'font-size:0.62rem',
      'letter-spacing:0.5px',
    ].join(';');
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.style.cssText = 'position:absolute;left:0;top:0;overflow:visible;';
    root.appendChild(svg);
    document.body.appendChild(root);
    this._root = root;
    this._svg = svg;
  }

  show() { this._build(); this._visible = true; if (this._root) this._root.style.opacity = '1'; }

  hide() {
    this._visible = false;
    if (this._root) this._root.style.opacity = '0';
    // DOM stays (opacity 0) so re-show is cheap; nothing paints while hidden.
  }

  /**
   * Lay out the blueprint callouts for one frame.
   *
   * @param {Array<{id:*, label:string, anchorU:{x,y,z}, priority:number,
   *                rows:?Array<string>, focused:boolean}>} items
   * @param {(pos:{x,y,z}) => {x:number, y:number, visible:boolean}} project
   *                 - ship-local scene units → screen px
   * @param {object} [opts]
   * @param {number} [opts.budget]  - max callouts (default F3 labelBudget = 7)
   * @param {string} [opts.lens]    - 'detail' | 'overview' (card variant key)
   * @param {number} [opts.centerX] - screen x of the subject center (rail side
   *                 split); default = mean of the visible anchor x
   * @returns {Array<{id:*, label:string, x:number, y:number, side:string,
   *                  cardX:number, cardY:number, color:string, focused:boolean,
   *                  rows:Array<string>, dirty:boolean,
   *                  leader:Array<Array<number>>}>}
   */
  render(items, project, opts = {}) {
    const budget = (opts.budget != null) ? opts.budget : FloorContract.FLOORS[2].labelBudget;
    const lens = opts.lens || 'overview';
    const ranked = BlueprintOverlay.rank(items, budget);

    // Project every ranked anchor; drop off-screen ones (projector contract).
    const projected = [];
    for (const item of ranked) {
      const p = project ? project(item.anchorU) : { x: 0, y: 0, visible: false };
      if (!p || !p.visible) continue;
      projected.push({ item, x: p.x, y: p.y });
    }

    // Rail-side split around the subject center (mean anchor x fallback).
    let centerX = opts.centerX;
    if (centerX == null) {
      centerX = projected.length
        ? projected.reduce((s, r) => s + r.x, 0) / projected.length
        : 0;
    }

    // Stack each rail top-to-bottom by anchor y, enforcing the slot gap so
    // cards never overlap and leaders never cross (MotherCallouts rail order).
    const left = projected.filter((r) => r.x <= centerX).sort((a, b) => a.y - b.y);
    const right = projected.filter((r) => r.x > centerX).sort((a, b) => a.y - b.y);
    for (const rail of [left, right]) {
      let prevY = -Infinity;
      for (const r of rail) {
        r.cardY = Math.max(r.y, prevY + SLOT_GAP_PX);
        prevY = r.cardY;
        r.side = (rail === left) ? 'left' : 'right';
        r.cardX = (rail === left) ? centerX - RAIL_DX_PX : centerX + RAIL_DX_PX;
      }
    }

    const descriptors = [];
    const seen = new Set();
    for (const r of projected) {
      const item = r.item;
      const color = item.focused ? VisualLaw.COLORS.SELECTION : VisualLaw.COLORS.INFO;
      const rows = Array.isArray(item.rows) ? item.rows.slice(0, CARD_ROW_BUDGET) : [];
      const key = BlueprintOverlay.contentKey(item, lens);
      const dirty = this._keys.get(item.id) !== key;
      this._keys.set(item.id, key);
      // Elbow leader: anchor → knee (level with the card) → card attach edge.
      const kneeX = r.cardX + (r.side === 'left' ? ELBOW_DX_PX : -ELBOW_DX_PX);
      const leader = [[r.x, r.y], [kneeX, r.cardY], [r.cardX, r.cardY]];
      const d = {
        id: item.id, label: item.label, x: r.x, y: r.y, side: r.side,
        cardX: r.cardX, cardY: r.cardY, color, focused: !!item.focused,
        rows, dirty, leader,
      };
      descriptors.push(d);
      seen.add(item.id);
      this._paintCallout(d);
    }
    // Retire callouts no longer in the visible set (idempotent).
    for (const [id, rec] of this._cards) {
      if (!seen.has(id) && rec._display !== 'none') {
        rec.el.style.display = 'none';
        rec.line.style.display = 'none';
        rec.dot.style.display = 'none';
        rec._display = 'none';
      }
    }
    return descriptors;
  }

  /** @private Build/position one callout (card + leader polyline + dot). */
  _paintCallout(d) {
    if (!this._root) return;
    let rec = this._cards.get(d.id);
    if (!rec) {
      const el = document.createElement('div');
      el.style.cssText = 'position:absolute;max-width:200px;padding:2px 6px;'
        + 'background:rgba(0,10,25,0.72);white-space:nowrap;';
      const title = document.createElement('div');
      title.style.cssText = 'font-weight:bold;';
      const rows = document.createElement('div');
      rows.style.cssText = 'opacity:0.85;';
      el.appendChild(title);
      el.appendChild(rows);
      const line = document.createElementNS(SVG_NS, 'polyline');
      line.setAttribute('fill', 'none');
      this._svg.appendChild(line);
      const dot = document.createElement('div');
      dot.style.cssText = 'position:absolute;width:6px;height:6px;border-radius:50%;'
        + 'transform:translate(-50%,-50%);border:1px solid;';
      this._root.appendChild(el);
      this._root.appendChild(dot);
      // `_`-prefixed fields cache the last WRITTEN value of everything that
      // rarely changes (ClusterIcons G1): the per-frame path touches only
      // positions. Content writes are gated on d.dirty (the contentKey law).
      rec = {
        el, title, rows, line, dot,
        _display: null, _color: null, _focused: null, _titleText: null,
        _rowsHtml: null, _side: null,
      };
      this._cards.set(d.id, rec);
    }
    if (rec._display !== 'block') {
      rec.el.style.display = 'block';
      rec.line.style.display = 'block';
      rec.dot.style.display = 'block';
      rec._display = 'block';
    }
    // Content writes — only when the fingerprint moved (write-on-change).
    if (d.dirty || rec._color !== d.color) {
      rec.title.textContent = d.label;
      rec._titleText = d.label;
      const html = d.rows.map((rw) => `<div>${rw}</div>`).join('');
      if (rec._rowsHtml !== html) { rec.rows.innerHTML = html; rec._rowsHtml = html; }
      rec.el.style.color = d.color;
      // Focus is double-encoded: SELECTION color AND heavier strokes.
      rec.el.style.border = `${d.focused ? 2 : 1}px solid ${d.color}`;
      rec.line.setAttribute('stroke', d.color);
      rec.line.setAttribute('stroke-width', d.focused ? '2' : '1');
      rec.line.setAttribute('opacity', '0.8');
      rec.dot.style.borderColor = d.color;
      rec.dot.style.background = d.focused ? d.color : 'transparent';
      rec._color = d.color;
      rec._focused = d.focused;
    }
    if (rec._side !== d.side) {
      // Left-rail cards end at the attach edge; right-rail cards start there.
      rec.el.style.transform = (d.side === 'left')
        ? 'translate(-100%,-50%)' : 'translate(0,-50%)';
      rec.el.style.textAlign = (d.side === 'left') ? 'right' : 'left';
      rec._side = d.side;
    }
    // Position writes — every frame (the ship rotates under the camera).
    rec.el.style.left = `${d.cardX}px`;
    rec.el.style.top = `${d.cardY}px`;
    rec.dot.style.left = `${d.x}px`;
    rec.dot.style.top = `${d.y}px`;
    rec.line.setAttribute('points', d.leader.map((p) => p.join(',')).join(' '));
  }

  /** Remove the whole layer (headless-safe). */
  dispose() {
    if (this._root && this._root.remove) this._root.remove();
    this._root = null;
    this._svg = null;
    this._cards.clear();
    this._keys.clear();
    this._built = false;
  }
}
