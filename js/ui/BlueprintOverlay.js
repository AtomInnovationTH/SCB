/**
 * BlueprintOverlay.js — the Zoom Ladder F3 (HULL CAM) blueprint callout layer (FloorContract.FLOORS[2]).
 *
 * STATUS (owner, playtest 2026-09-02): NO LONGER THE F3 COSTUME. The F3 costume is MotherCallouts + the cyan hull
 * outline (FloorContract F3 costume.arrive ['MotherCallouts', 'HullOutline']; docs/ladder/08-workbench.md §2). This
 * module is SHELVED as the refit-index renderer: main.js still constructs HullCamFloor (which constructs this) but
 * does not inject it into the ladder, so nothing shows it.
 *
 * Draws labeled subsystem callouts (the seven-entry manifest, js/data/blueprintSubsystems.js) joined to their hull
 * anchor points by elbow LEADER LINES, in the MotherCallouts visual language (anchor dot → elbow → side-rail card,
 * cards stacked so labels never crowd or cross). DOM cards + one SVG line layer; no THREE.
 *
 * VISUAL LAW (js/core/VisualLaw.js):
 *   - callouts read INFO cyan; the focused subsystem reads SELECTION blue and is double-encoded (thicker leader +
 *     heavier card border — never color-alone);
 *   - at most `labelBudget` (F3 = 7) callouts render, priority-ranked via the static rank() law (highest first,
 *     stable ties by id).
 *
 * HOVER (08-workbench §2 Motion): 120 ms delay → the card outline brightens, the card lifts 4 % and the leader
 * whitens. The lift is a CSS :hover rule (a --bp-lift var composed into the base transform, so hover never clobbers
 * rail alignment); the brighten/whiten half is the hoverCard() hook, because the SVG leader and the anchor dot are
 * siblings CSS :hover cannot reach. Hover rides its OWN write-on-change axis (never dirties content).
 *
 * HITBOXES: the overlay ROOT and the SVG layer stay pointer-events:none; ONLY the cards re-enable pointer events, so
 * the layer never blocks canvas interaction outside the cards. hide() drops the card hitboxes and clears hover, so
 * the faded-out layer is never a click trap.
 *
 * CLICK (08-workbench §2 D2 — "the hull is the index"):
 *   - card click → the setOnSelect(cb) sink with the subsystem id (HullCamFloor routes it into focusById);
 *   - TITLE click → CODEX_OPEN_ENTRY with the subsystem's codexId (payload { id }); a codex-less title degrades to
 *     select so no click is ever dead.
 * Both paths are public (clickCard / clickTitle) so dispatch is headless-testable.
 *
 * The projection is INJECTED (`project(shipLocalU) -> {x, y, visible}`, ship-LOCAL scene units), so layout is
 * unit-testable headless: the module is fully DOM-guarded (inert + constructible in Node) and render() returns the
 * computed descriptors that also drive the DOM.
 *
 * WRITE-ON-CHANGE: every descriptor carries `dirty` — true only when that callout's CONTENT fingerprint (contentKey:
 * label/rows/color/lens) changed since the last render. Content DOM writes (text, colors, borders) are gated on it;
 * only positions (card left/top, leader points, dot) write per frame, because the ship rotates under the camera.
 * The `dirty` flag IS the DOM gate (one computation), so pinning descriptors pins the DOM behavior.
 *
 * Owns no camera, no lens state, no game loop: HullCamFloor feeds it items + a projector.
 *
 * @module ui/BlueprintOverlay
 */

import { VisualLaw } from '../core/VisualLaw.js';
import { FloorContract } from '../core/FloorContract.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

/** Card attach-edge distance from the layout center line (px). */
export const RAIL_DX_PX = 190;
/** Horizontal elbow run between the leader knee and the card edge (px). */
export const ELBOW_DX_PX = 16;
/** Minimum vertical gap between stacked cards on one rail (px). */
export const SLOT_GAP_PX = 30;
/** Max rows painted on one card (MotherCallouts focused-card budget). */
export const CARD_ROW_BUDGET = 6;
/** Hover intent delay before the affordance fires (ms). */
export const HOVER_DELAY_MS = 120;
/** Hover lift: the card scales up 4 %. */
export const HOVER_LIFT_SCALE = 1.04;

const SVG_NS = 'http://www.w3.org/2000/svg';

export class BlueprintOverlay {
  constructor() {
    this._root = null;
    this._svg = null;
    this._cards = new Map();   // id → { el, title, rows, line, dot, caches… }
    this._keys = new Map();    // id → last painted contentKey (headless too)
    this._built = false;
    this._visible = false;
    this._hoverId = null;      // hovered callout id (its own write axis)
    this._onSelect = null;     // card-click sink: (subsystemId) => void
    this._codexIds = new Map();// id → codexId (title deep-link target)
  }

  /**
   * Wire the card-click-to-select sink: card hitboxes dispatch the subsystem id here.
   * @param {(id:*) => void} fn
   */
  setOnSelect(fn) { this._onSelect = (typeof fn === 'function') ? fn : null; }

  /**
   * Dispatch a click on a callout card to the onSelect sink (the DOM listener calls this).
   * @param {*} id - subsystem id
   */
  clickCard(id) { if (this._onSelect) this._onSelect(id); }

  /**
   * Dispatch a click on a callout TITLE: deep-link the Tech Library on the subsystem's codexId (CODEX_OPEN_ENTRY
   * { id }, as MotherCallouts emits). A callout without a codexId degrades to the select sink.
   * @param {*} id - subsystem id
   * @returns {?string} the codexId opened, or null when it fell back to select
   */
  clickTitle(id) {
    const codexId = this._codexIds.get(id) || null;
    if (codexId) {
      eventBus.emit(Events.CODEX_OPEN_ENTRY, { id: codexId });
      return codexId;
    }
    this.clickCard(id);
    return null;
  }

  /**
   * Rank callout items for the label budget: highest priority first, stable on ties by id, truncated to `budget`.
   * Pure + static so the budget law is unit-testable.
   * @param {Array<{id:*, priority:number}>} items
   * @param {number} budget
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
   * Content fingerprint of one callout: everything a content DOM write paints (label, rows, color, focus weight,
   * lens variant) and nothing positional. Pure + static; the single source for the write-on-change gate.
   * @param {{label:string, rows:?Array<string>, focused:boolean}} item
   * @param {string} lens - 'detail' | 'overview'
   */
  static contentKey(item, lens) {
    const rows = Array.isArray(item.rows) ? item.rows.slice(0, CARD_ROW_BUDGET) : [];
    return [
      item.label, item.focused ? 'F' : '-', lens || 'overview', rows.join('|'),
    ].join('::');
  }

  /**
   * Set/clear the hovered callout (the card's mouseenter after HOVER_DELAY_MS / mouseleave; headless callers drive it
   * directly). At most ONE callout is hovered; un-hovering an id that is not the hovered one is a no-op. Writes fire
   * on transition only.
   * @param {*} id - callout id
   * @param {boolean} hovering
   * @returns {*} the current hovered id (or null)
   */
  hoverCard(id, hovering) {
    const next = hovering ? id : (this._hoverId === id ? null : this._hoverId);
    if (next === this._hoverId) return this._hoverId;
    const prev = this._hoverId;
    this._hoverId = next;
    const prevRec = (prev != null) ? this._cards.get(prev) : null;
    if (prevRec && prevRec._hovered) {
      prevRec._hovered = false;
      this._applyHoverColors(prevRec, false);
    }
    const nextRec = (next != null) ? this._cards.get(next) : null;
    if (nextRec && !nextRec._hovered) {
      nextRec._hovered = true;
      this._applyHoverColors(nextRec, true);
    }
    return this._hoverId;
  }

  /**
   * @private The brighten half of the hover affordance: the card outline brightens and the leader + anchor dot turn
   * SELECTION blue; off restores the callout's own content color. (The 4 % lift is the .bp-card:hover CSS rule.)
   * Never called on unbuilt recs.
   */
  _applyHoverColors(rec, on) {
    const base = rec._color || VisualLaw.COLORS.INFO;
    const c = on ? VisualLaw.COLORS.SELECTION : base;
    rec.el.style.borderColor = c;
    rec.line.setAttribute('stroke', c);
    rec.line.setAttribute('opacity', on ? '1' : '0.8');
    rec.dot.style.borderColor = c;
  }

  _build() {
    // Feature-check everything this layer touches: earlier tests leak PARTIAL document stubs into the shared Node
    // process (createElement + body, no createElementNS), and this module must stay inert under them, not crash.
    if (this._built || typeof document === 'undefined' || !document.body
      || typeof document.createElementNS !== 'function') return;
    this._built = true;
    const root = document.createElement('div');
    root.id = 'ladder-blueprint-overlay';
    root.style.cssText = [
      'position:absolute', 'left:0', 'top:0', 'width:100%', 'height:100%',
      'pointer-events:none', 'z-index:32', 'opacity:0', 'transition:opacity 0.3s',
      'font-family: var(--font-mono)', 'font-size:0.62rem',
      'letter-spacing:0.5px',
    ].join(';');
    // The hover LIFT: a :hover rule on the card class sets a --bp-lift var that the per-side base transform
    // composes in. transition-delay lives on the :hover rule only → delayed in, instant out.
    const style = document.createElement('style');
    style.textContent =
      '#ladder-blueprint-overlay .bp-card{transition:transform 0.15s ease-in-out;}'
      + `#ladder-blueprint-overlay .bp-card:hover{--bp-lift:${HOVER_LIFT_SCALE};`
      + `transition-delay:${HOVER_DELAY_MS}ms;}`;
    root.appendChild(style);
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.style.cssText = 'position:absolute;left:0;top:0;overflow:visible;';
    root.appendChild(svg);
    document.body.appendChild(root);
    this._root = root;
    this._svg = svg;
  }

  show() {
    this._build();
    this._visible = true;
    if (!this._root) return;
    this._root.style.opacity = '1';
    for (const rec of this._cards.values()) rec.el.style.pointerEvents = 'auto';
  }

  hide() {
    this._visible = false;
    // A hidden layer must never be a click trap (opacity 0 keeps receiving events).
    for (const rec of this._cards.values()) {
      if (rec._hoverTimer) { clearTimeout(rec._hoverTimer); rec._hoverTimer = null; }
      rec.el.style.pointerEvents = 'none';
    }
    if (this._hoverId != null) this.hoverCard(this._hoverId, false);
    if (this._root) this._root.style.opacity = '0';
  }

  /**
   * @param {Array<{id:*, label:string, anchorU:{x,y,z}, priority:number,
   *                rows:?Array<string>, focused:boolean, codexId:?string}>} items
   * @param {(pos:{x,y,z}) => {x:number, y:number, visible:boolean}} project
   *                 - ship-local scene units → screen px
   * @param {object} [opts]
   * @param {number} [opts.budget]  - max callouts (default F3 labelBudget = 7)
   * @param {string} [opts.lens]    - 'detail' | 'overview' (card variant key)
   * @param {number} [opts.centerX] - screen x of the subject center (rail side
   *                 split); default = mean of the visible anchor x
   * @returns {Array<{id:*, label:string, x:number, y:number, side:string,
   *                  cardX:number, cardY:number, color:string, focused:boolean,
   *                  rows:Array<string>, dirty:boolean, hovered:boolean,
   *                  codexId:?string, leader:Array<Array<number>>}>}
   */
  render(items, project, opts = {}) {
    const budget = (opts.budget != null) ? opts.budget : FloorContract.byId(1).labelBudget;
    const lens = opts.lens || 'overview';
    const ranked = BlueprintOverlay.rank(items, budget);

    const projected = [];
    for (const item of ranked) {
      const p = project ? project(item.anchorU) : { x: 0, y: 0, visible: false };
      if (!p || !p.visible) continue;
      projected.push({ item, x: p.x, y: p.y });
    }

    // Rail-side split around the subject center (mean anchor x fallback)
    let centerX = opts.centerX;
    if (centerX == null) {
      centerX = projected.length
        ? projected.reduce((s, r) => s + r.x, 0) / projected.length
        : 0;
    }

    // Stack each rail top-to-bottom by anchor y, enforcing the slot gap so cards never overlap and leaders never cross
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
      // deep-link target for clickTitle (headless too)
      this._codexIds.set(item.id, item.codexId != null ? item.codexId : null);
      // Elbow leader: anchor → knee (level with the card) → card attach edge.
      const kneeX = r.cardX + (r.side === 'left' ? ELBOW_DX_PX : -ELBOW_DX_PX);
      const leader = [[r.x, r.y], [kneeX, r.cardY], [r.cardX, r.cardY]];
      const d = {
        id: item.id, label: item.label, x: r.x, y: r.y, side: r.side,
        cardX: r.cardX, cardY: r.cardY, color, focused: !!item.focused,
        rows, dirty, leader, hovered: this._hoverId === item.id,
        codexId: item.codexId != null ? item.codexId : null,
      };
      descriptors.push(d);
      seen.add(item.id);
      this._paintCallout(d);
    }
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
      // HITBOX: only the card re-enables pointer events. .bp-card carries the :hover lift rule injected in _build().
      el.className = 'bp-card';
      el.style.pointerEvents = this._visible ? 'auto' : 'none';
      el.style.cursor = 'pointer';
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
      // `_`-prefixed fields cache the last WRITTEN value, so the per-frame path touches only positions.
      rec = {
        el, title, rows, line, dot,
        _display: null, _color: null, _focused: null, _titleText: null,
        _rowsHtml: null, _side: null, _hovered: false, _hoverTimer: null,
      };
      this._cards.set(d.id, rec);
      // The TITLE deep-links the Tech Library (stopPropagation keeps it out of the card path); the CARD selects
      // the subsystem via the onSelect sink.
      el.addEventListener('click', (ev) => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        this.clickCard(d.id);
      });
      title.addEventListener('click', (ev) => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        this.clickTitle(d.id);
      });
      // Hover intent: fires after HOVER_DELAY_MS of dwell; leaving cancels the pending intent AND the active hover.
      el.addEventListener('mouseenter', () => {
        if (rec._hoverTimer) clearTimeout(rec._hoverTimer);
        rec._hoverTimer = setTimeout(() => {
          rec._hoverTimer = null;
          this.hoverCard(d.id, true);
        }, HOVER_DELAY_MS);
      });
      el.addEventListener('mouseleave', () => {
        if (rec._hoverTimer) { clearTimeout(rec._hoverTimer); rec._hoverTimer = null; }
        this.hoverCard(d.id, false);
      });
    }
    if (rec._display !== 'block') {
      rec.el.style.display = 'block';
      rec.line.style.display = 'block';
      rec.dot.style.display = 'block';
      rec._display = 'block';
    }
    if (d.dirty || rec._color !== d.color) {
      rec.title.textContent = d.label;
      rec._titleText = d.label;
      const html = d.rows.map((rw) => `<div>${rw}</div>`).join('');
      if (rec._rowsHtml !== html) { rec.rows.innerHTML = html; rec._rowsHtml = html; }
      rec.el.style.color = d.color;
      rec.el.style.border = `${d.focused ? 2 : 1}px solid ${d.color}`;
      rec.line.setAttribute('stroke', d.color);
      rec.line.setAttribute('stroke-width', d.focused ? '2' : '1');
      rec.line.setAttribute('opacity', '0.8');
      rec.dot.style.borderColor = d.color;
      rec.dot.style.background = d.focused ? d.color : 'transparent';
      rec._color = d.color;
      rec._focused = d.focused;
      // A content repaint rewrites border/leader from d.color: restore the hover brighten on top.
      if (rec._hovered) this._applyHoverColors(rec, true);
    }
    // Hover re-sync: a hoverCard call before this card was built lands here on the next frame.
    if (rec._hovered !== d.hovered) {
      rec._hovered = d.hovered;
      this._applyHoverColors(rec, d.hovered);
    }
    if (rec._side !== d.side) {
      // Left-rail cards end at the attach edge; right-rail cards start there. scale(var(--bp-lift,1)) composes the lift.
      rec.el.style.transform = (d.side === 'left')
        ? 'translate(-100%,-50%) scale(var(--bp-lift,1))'
        : 'translate(0,-50%) scale(var(--bp-lift,1))';
      rec.el.style.textAlign = (d.side === 'left') ? 'right' : 'left';
      rec._side = d.side;
    }
    rec.el.style.left = `${d.cardX}px`;
    rec.el.style.top = `${d.cardY}px`;
    rec.dot.style.left = `${d.x}px`;
    rec.dot.style.top = `${d.y}px`;
    rec.line.setAttribute('points', d.leader.map((p) => p.join(',')).join(' '));
  }

  dispose() {
    for (const rec of this._cards.values()) {
      if (rec._hoverTimer) { clearTimeout(rec._hoverTimer); rec._hoverTimer = null; }
    }
    if (this._root && this._root.remove) this._root.remove();
    this._root = null;
    this._svg = null;
    this._cards.clear();
    this._keys.clear();
    this._codexIds.clear();
    this._built = false;
    this._hoverId = null;
  }
}
