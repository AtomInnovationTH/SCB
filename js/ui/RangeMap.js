/**
 * RangeMap - the orbital range map beside the "where next" list (range-map lane, 2026-10-25; owner: "an orbital map to clearly
 * understand their range and choices with current fuel and salvage fuel"; "rings around Earth"; plan D1, D6, D7). The thin view over
 * js/systems/RangeMapModel.js (the numbers) and js/systems/MissionGasTally.js (the second gas line).
 *
 * One DOM root on `document.body` (z 33, like the height scale) at the LEFT of the screen in the height column's place (F1.1: the column hides while this
 * shows; a ring tap focuses a field as its chips did), holding one `<canvas>` (the rings, her path, the labels) and the text lines
 * under it (gas aboard, what her catches gave and her own moves used, the orbit count, the day of the trip: packed top-down, `RangeMapModel.textLines`). Only the canvas takes pointer events, and only while the list
 * is open; a tap FOCUSES the ring's row (`WhereNextList.focus`, the height scale chip's path) and never picks: flying stays the list's own tap-again,
 * Space and FLY THERE.
 *
 * When it shows (D6), one frame at a time, from `update()`:
 *   - floor 4 is not the floor she is on: hidden;
 *   - the list is open: shown at once, following the list's focus (polled: `WhereNextList.setOnFocus` is single-slot and the height scale's);
 *   - after a pick (`notePick`, from main.js's onPick, BEFORE the pick runs, so the rows are the ones she chose from): shown through `wait`, the
 *     rows and her height frozen at the pick; hidden from `ION_STARTUP_BEGIN` so the engines are seen; shown again in trip mode (larger, 0.6 s fade)
 *     once the burn runs, the engines are lit and the camera swing is over, her dot moving along the path by the trip's progress with "Day d of N";
 *     hidden at arrival (the trip is idle again). A called satellite (phase `call`, no burn) shows the arrow. A refused pick re-opens the list: the
 *     stored pick is dropped and the map follows the focus again.
 *
 * No eventBus import of its own beyond the two start-up events; everything else comes in through `deps`, so a fake DOM, a fake trip and a fake
 * camera run it. With no document nothing is built and every method still answers.
 *
 * @module ui/RangeMap
 */

import { Constants } from '../core/Constants.js';
import { eventBus as defaultBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { mono } from '../core/Typeface.js';
import { STOPPED_EVENTS } from './WhereNextList.js';
import {
  rangeMapRect, buildLayout, reachBand, ringOfRow, spiralPoints, spiralAt, callArrow, orbitCount, hitTest, textLines,
} from '../systems/RangeMapModel.js';

export const RANGE_MAP_ID = 'range-map';
const RM = () => Constants.RANGE_MAP;

const ARROW_ANGLE = Math.PI;                 // the called satellite's arrow runs along the left radial (the break label is on the right)
const SAT_GLYPH_RAD = -40 * Math.PI / 180;

/** @private the row kinds a path is drawn to */
const isDestination = (row) => !!row && (row.kind === 'field' || row.kind === 'satellite');
/** @private a push-down row: a height of its own, no ring (the free place); her trip to it is shown only once picked (F1.7) */
const isPush = (row) => !!row && row.kind === 'push' && Number.isFinite(row.altKm);

/** @private a stable text of what the layout depends on */
function rowsSignature(rows) {
  return rows.map((r) => `${r.id}:${r.kind}:${Math.round(r.altKm)}:${r.state}:${r.gasKg == null ? '' : Math.round(r.gasKg * 10)}:${r.days == null ? '' : Math.round(r.days)}:${r.shortKg == null ? '' : Math.round(r.shortKg * 10)}`).join('|');
}

/**
 * Draw the map on a 2D context (CSS px; the caller has scaled for the device). Pure in the sense that it only writes to `g`.
 * @param {CanvasRenderingContext2D} g
 * @param {{layout: object, side: number, focusRing: (object|null), originRing: (object|null), band: (object|null), path: (Array|null),
 *   flownTo: (number|null), dot: ({x:number,y:number}|null), arrow: (object|null), tripMode: boolean}} v
 */
export function paintRangeMap(g, v) {
  const L = v.layout;
  const C = RM().COLORS;
  const dash = (a) => { if (typeof g.setLineDash === 'function') g.setLineDash(a); };
  g.clearRect(0, 0, v.side, v.side);
  if (!L || !L.rings.length) return;
  g.save();
  // the reach band under everything
  if (v.band) {
    g.beginPath();
    g.arc(L.cx, L.cy, v.band.outerR, 0, Math.PI * 2);
    g.moveTo(L.cx + v.band.innerR, L.cy);
    g.arc(L.cx, L.cy, v.band.innerR, 0, Math.PI * 2, true);
    g.fillStyle = C.REACH;
    g.fill('evenodd');
    // F1.4: a firm edge at the furthest ring she can reach, a softer one at the inner end
    g.beginPath();
    g.arc(L.cx, L.cy, v.band.outerR, 0, Math.PI * 2);
    g.strokeStyle = C.REACH_EDGE;
    g.lineWidth = 2.5;
    g.stroke();
    if (v.band.innerR > L.earthR + 1) {
      g.beginPath();
      g.arc(L.cx, L.cy, v.band.innerR, 0, Math.PI * 2);
      g.strokeStyle = C.REACH_EDGE_SOFT;
      g.lineWidth = 1;
      g.stroke();
    }
  }
  // Earth
  g.beginPath();
  g.arc(L.cx, L.cy, L.earthR, 0, Math.PI * 2);
  g.fillStyle = C.EARTH;
  g.fill();
  g.strokeStyle = 'rgba(120,180,255,0.6)';
  g.lineWidth = 1;
  g.stroke();
  // the break: a dotted ruler on the right radial, labelled below with the others
  for (const b of L.breaks) {
    g.beginPath();
    dash([2, 3]);
    g.moveTo(L.cx + b.innerR, L.cy);
    g.lineTo(L.cx + b.outerR, L.cy);
    g.strokeStyle = C.TEXT_DIM;
    g.lineWidth = 1;
    g.stroke();
    dash([]);
  }
  // the rings
  for (const ring of L.rings) {
    const focus = v.focusRing === ring;
    const dim = v.tripMode && ring !== v.focusRing && ring !== v.originRing;
    g.globalAlpha = dim ? RM().DIM_RING_ALPHA : 1;
    g.beginPath();
    g.arc(L.cx, L.cy, ring.radius, 0, Math.PI * 2);
    dash(ring.state === 'grey' ? [5, 4] : []);
    if (focus) { g.strokeStyle = C.FOCUS; g.lineWidth = 3.5; }
    else if (ring.state === 'here') { g.strokeStyle = C.HERE; g.lineWidth = 2; }
    else if (ring.state === 'ok') { g.strokeStyle = C.OK; g.lineWidth = 1.5; }
    else if (ring.state === 'cleared') { g.strokeStyle = C.CLEARED; g.lineWidth = 1; }
    else { g.strokeStyle = C.GREY; g.lineWidth = 1.2; }
    g.stroke();
    dash([]);
    if (ring.kind === 'satellite') {                                     // a small satellite: body and two panels
      const x = L.cx + ring.radius * Math.cos(SAT_GLYPH_RAD);
      const y = L.cy + ring.radius * Math.sin(SAT_GLYPH_RAD);
      g.fillStyle = focus ? C.FOCUS : (ring.state === 'ok' || ring.state === 'here' ? C.TEXT : C.TEXT_DIM);
      g.fillRect(x - 3, y - 2.5, 6, 5);
      g.fillRect(x - 10, y - 1, 5, 2);
      g.fillRect(x + 5, y - 1, 5, 2);
    } else if (ring.state === 'cleared') {                               // a tick
      const a = 40 * Math.PI / 180;
      const x = L.cx + ring.radius * Math.cos(a);
      const y = L.cy + ring.radius * Math.sin(a);
      g.beginPath();
      g.moveTo(x - 4, y); g.lineTo(x - 1, y + 3); g.lineTo(x + 4, y - 4);
      g.strokeStyle = C.TEXT_DIM;
      g.lineWidth = 1.5;
      g.stroke();
    }
  }
  g.globalAlpha = 1;
  // her path to the pick (F1.4: thick, on a dark stroke, the part flown brighter, an arrowhead at the target), or the called satellite's arrow
  if (v.path && v.path.length > 1) {
    const P = v.path;
    const trace = (until) => {
      g.beginPath();
      g.moveTo(P[0].x, P[0].y);
      for (let i = 1; i < P.length && (until == null || P[i].f <= until + 1e-9); i++) g.lineTo(P[i].x, P[i].y);
    };
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const part = v.flownTo != null ? RM().UNFLOWN_ALPHA : 1;
    trace(null);
    g.strokeStyle = C.PATH_UNDER;
    g.globalAlpha = part;
    g.lineWidth = RM().PATH_PX + 3;
    g.stroke();
    trace(null);
    g.strokeStyle = C.SPIRAL;
    g.globalAlpha = part;
    g.lineWidth = RM().PATH_PX;
    g.stroke();
    if (v.flownTo != null) {
      g.globalAlpha = 1;
      trace(v.flownTo);
      g.lineWidth = RM().PATH_PX + 1;
      g.stroke();
    }
    g.globalAlpha = 1;
    // the arrowhead: at the last point, along the last stretch of the path
    const end = P[P.length - 1];
    let back = P[P.length - 2];
    for (let i = P.length - 2; i >= 0 && Math.hypot(end.x - P[i].x, end.y - P[i].y) < 4; i--) back = P[i];
    const dx = end.x - back.x;
    const dy = end.y - back.y;
    const n = Math.hypot(dx, dy) || 1;
    const ux = dx / n; const uy = dy / n;
    const A = RM().ARROW_PX;
    g.beginPath();
    g.moveTo(end.x + ux * A * 0.35, end.y + uy * A * 0.35);
    g.lineTo(end.x - ux * A * 0.65 + uy * A * 0.5, end.y - uy * A * 0.65 - ux * A * 0.5);
    g.lineTo(end.x - ux * A * 0.65 - uy * A * 0.5, end.y - uy * A * 0.65 + ux * A * 0.5);
    g.closePath();
    g.fillStyle = C.SPIRAL;
    g.fill();
    g.strokeStyle = C.PATH_UNDER;
    g.lineWidth = 1;
    g.stroke();
  }
  if (v.arrow) {
    const { from, to } = v.arrow;
    g.beginPath();
    g.moveTo(from.x, from.y);
    g.lineTo(to.x, to.y);
    g.strokeStyle = C.SPIRAL;
    g.lineWidth = 2;
    g.stroke();
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const n = Math.hypot(dx, dy) || 1;
    const ux = dx / n; const uy = dy / n;
    g.beginPath();
    g.moveTo(to.x, to.y);
    g.lineTo(to.x - 7 * ux + 4 * uy, to.y - 7 * uy - 4 * ux);
    g.lineTo(to.x - 7 * ux - 4 * uy, to.y - 7 * uy + 4 * ux);
    g.closePath();
    g.fillStyle = C.SPIRAL;
    g.fill();
  }
  // her dot
  if (v.dot) {
    g.beginPath();
    g.arc(v.dot.x, v.dot.y, 4.5, 0, Math.PI * 2);
    g.fillStyle = C.HERE;
    g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.8)';
    g.lineWidth = 1;
    g.stroke();
  }
  // the labels, last, on dark boxes
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const labelOf = (box, text, focus, color) => {
    g.fillStyle = C.BACK;
    g.fillRect(box.x, box.y, box.w, box.h);
    if (focus) { g.strokeStyle = C.FOCUS; g.lineWidth = 1.5; g.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1); }
    g.font = mono(RM().LABEL_FONT_PX, focus ? 'bold' : undefined);
    g.fillStyle = color;
    g.fillText(text, box.x + box.w / 2, box.y + box.h / 2 + 0.5);
  };
  for (const ring of L.rings) {
    const dim = v.tripMode && ring !== v.focusRing && ring !== v.originRing;
    g.globalAlpha = dim ? RM().DIM_LABEL_ALPHA : 1;
    const color = ring.state === 'ok' ? C.TEXT : ring.state === 'here' ? C.HERE : C.TEXT_DIM;
    labelOf(ring.box, ring.label, v.focusRing === ring, color);
  }
  g.globalAlpha = 1;
  for (const b of L.breaks) labelOf(b.box, b.label, false, C.TEXT_DIM);
  g.restore();
}

export class RangeMap {
  /**
   * @param {object} deps
   * @param {object} deps.list           the WhereNextList (isOpen, rowData, focusedId, focus)
   * @param {object|function} deps.registry the FieldRegistry, or () => it (altitudeKm, planTo, atSatellite)
   * @param {object|function} deps.trip  the TransferTrip, or () => it (isCalling, isBurning, isWaiting, lighting, progress, profile, tripDay)
   * @param {object|function} [deps.camera] the CameraSystem, or () => it (isIonStartupActive)
   * @param {function} [deps.floorActive] () => true when floor 4 is the floor she is on (NavcomFloor.isActive)
   * @param {function} [deps.gas]        () => {aboardKg, tankKg}
   * @param {object|function} [deps.tally] the MissionGasTally, or () => it (usedKg, gainedKg)
   * @param {function} [deps.viewport]   () => {w, h} (default: the window)
   * @param {function} [deps.box]        () => {height} the bottom-left transfer-window box's live outer height (TransferWindows.heightPx()), null = unmeasured (its tallest state is assumed)
   * @param {function} [deps.rail]       () => {left, bottom} the floor rail's live edges (RailIndicator.leftPx(), bottomPx(); a null reads as the rail's design place), or false for none
   * @param {Document|null} [deps.doc]   default the global document; null = headless
   * @param {Element} [deps.parent]      default doc.body
   * @param {object|null} [deps.bus]     the event bus (default the game's; null = listen to nothing)
   * @param {function} [deps.now]        ms clock (tests)
   * @param {function} [deps.reducedMotion] () => true: no fade
   * @param {function} [deps.dpr]        () => device pixel ratio
   */
  constructor(deps = {}) {
    this._list = deps.list || null;
    this._registry = deps.registry || null;
    this._trip = deps.trip || null;
    this._camera = deps.camera || null;
    this._floorActive = typeof deps.floorActive === 'function' ? deps.floorActive : () => true;
    this._gas = typeof deps.gas === 'function' ? deps.gas : () => null;
    this._tally = deps.tally || null;
    this._viewport = typeof deps.viewport === 'function' ? deps.viewport
      : () => ({ w: typeof window !== 'undefined' ? window.innerWidth : 1366, h: typeof window !== 'undefined' ? window.innerHeight : 1024 });
    this._doc = deps.doc !== undefined ? deps.doc : (typeof document !== 'undefined' ? document : null);
    this._parent = deps.parent || null;
    this._rail = typeof deps.rail === 'function' ? deps.rail : () => null;
    this._box = typeof deps.box === 'function' ? deps.box : () => null;
    this._now = typeof deps.now === 'function' ? deps.now : () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._reduced = typeof deps.reducedMotion === 'function' ? deps.reducedMotion : () => false;
    this._dpr = typeof deps.dpr === 'function' ? deps.dpr : () => (typeof window !== 'undefined' && window.devicePixelRatio) || 1;

    this._root = null; this._canvas = null; this._g = null; this._lines = []; this._built = false; this._disposed = false;
    this._shown = false;                 // the root is on screen
    this._pick = null;                   // {id, rows, herKm, profile, row}: what she picked, frozen at the pick
    this._ionHold = false;               // ION_STARTUP_BEGIN seen: hidden until the burn shows again
    this._decision = { visible: false, mode: 'choose', phase: 'hidden' };
    this._layout = null; this._layoutKey = null; this._side = 0; this._rect = null;
    this._rows = []; this._focusId = null; this._focusRing = null; this._originRing = null;
    this._plan = null; this._planKey = null; this._planProfile = null; this._path = null; this._arrow = null; this._band = null;
    this._dot = null; this._flownTo = null;
    this._drawKey = null; this._lastDrawMs = -Infinity; this._lastRowsMs = -Infinity; this._lastPhase = null;
    this._text = new Array(RM().TEXT_LINES).fill('');
    this._fadeArmed = false;
    const bus = deps.bus !== undefined ? deps.bus : defaultBus;
    this._offs = [];
    if (bus && typeof bus.on === 'function') {
      this._offs.push(bus.on(Events.ION_STARTUP_BEGIN, () => { if (this._pick) { this._ionHold = true; this._hideNow(); } }));
      this._offs.push(bus.on(Events.WHERE_NEXT, (d) => this._onWhereNext(d)));
    }
  }

  // ── Wiring (main.js) ───────────────────────────────────────────────────────

  /** @private */
  _get(x) { return typeof x === 'function' ? x() : x; }

  /**
   * The pick is about to run (main.js's onPick, before `pickWhereNext`): keep the rows she is choosing from, her height and the picked row's
   * climb, so the map shows her pick through `wait` and the trip, whatever the registry does meanwhile. A refused pick re-opens the list and
   * the next `update()` drops this.
   * @param {string} id the picked row
   */
  notePick(id) {
    if (this._disposed || !this._list) return;
    let rows = [];
    try { rows = this._list.rowData(); } catch (_e) { rows = []; }
    this._storePick(id, rows);
  }

  /** @private keep a pick: the rows it was made from, her height now, the picked row's climb */
  _storePick(id, rows) {
    const row = rows.find((r) => r.id === id) || null;
    const reg = this._get(this._registry);
    let herKm = null;
    try { herKm = reg && typeof reg.altitudeKm === 'function' ? reg.altitudeKm() : null; } catch (_e) { herKm = null; }
    this._pick = { id, rows, herKm: Number.isFinite(herKm) ? herKm : null, row, profile: row && (isDestination(row) || isPush(row)) ? this._profileFor(id) : null };
    this._ionHold = false;
  }

  /**
   * The choice opens or closes (`WHERE_NEXT`). Open: the list is (again) what she looks at, so a stored pick (a refused one) goes at once. Closed with
   * no pick stored (F1.7: a path that called `pickWhereNext` without `notePick`): take the list's last focused row, from the rows it showed.
   * @private
   */
  _onWhereNext(d) {
    if (this._disposed || !d || !this._list) return;
    if (d.open === true) { this._pick = null; this._ionHold = false; return; }
    if (d.open !== false || this._pick) return;
    let id = null;
    let rows = this._rows;
    try {
      if (typeof this._list.isOpen === 'function' && this._list.isOpen()) { id = this._list.focusedId(); rows = this._list.rowData(); }
    } catch (_e) { /* the last painted ones */ }
    if (id == null) id = this._focusId;
    if (id != null && Array.isArray(rows) && rows.length) this._storePick(id, rows);
  }

  /** @private the climb to a destination row: planTo(id).profile, or null (the path is then a straight run between the rings) */
  _profileFor(id) {
    const reg = this._get(this._registry);
    if (!reg || typeof reg.planTo !== 'function') return null;
    try {
      const plan = reg.planTo(id);
      const p = plan && plan.profile;
      return p && Array.isArray(p.samples) && p.samples.length >= 2 ? p : null;
    } catch (_e) { return null; }
  }

  // ── Visibility ─────────────────────────────────────────────────────────────

  /** @private the frame's decision: {visible, mode: 'choose'|'trip', phase: 'list'|'wait'|'burn'|'call'|'hidden'} */
  _decide() {
    const hidden = { visible: false, mode: 'choose', phase: 'hidden' };
    if (!this._floorActive()) return hidden;
    const list = this._list;
    if (list && typeof list.isOpen === 'function' && list.isOpen()) {
      this._pick = null; this._ionHold = false;            // the list is (again) the thing she is looking at
      return { visible: true, mode: 'choose', phase: 'list' };
    }
    if (!this._pick) return hidden;
    const trip = this._get(this._trip);
    if (!trip) { this._pick = null; return hidden; }
    if (trip.isCalling && trip.isCalling()) return { visible: true, mode: 'trip', phase: 'call' };
    if (trip.isBurning && trip.isBurning()) {
      const cam = this._get(this._camera);
      const lighting = !!(trip.lighting && trip.lighting());
      const swing = !!(cam && typeof cam.isIonStartupActive === 'function' && cam.isIonStartupActive());
      if (lighting || swing) return hidden;                // the engines are being seen
      this._ionHold = false;
      return { visible: true, mode: 'trip', phase: 'burn' };
    }
    if (trip.isWaiting && trip.isWaiting() && !this._ionHold) return { visible: true, mode: 'choose', phase: 'wait' };
    if (this._ionHold && trip.isWaiting && trip.isWaiting()) return hidden;
    this._pick = null; this._ionHold = false;              // arrived, a Stay pick, or a pick that went nowhere
    return hidden;
  }

  /** @private */
  _hideNow() {
    if (this._root) this._root.style.display = 'none';
    this._shown = false;
    this._fadeArmed = false;
  }

  /** Whether the map is on screen (tests). */
  isShown() { return this._shown && !!this._root && this._root.style.display !== 'none'; }

  // ── Frame ──────────────────────────────────────────────────────────────────

  /**
   * One frame (main.js, after the navcom tick). Cheap when hidden; when shown it follows the list's focus or the trip and redraws only when
   * what it draws changed (at most REDRAW_MS apart in trip mode).
   * @returns {{visible: boolean, mode: string, phase: string}}
   */
  update() {
    if (this._disposed) return this._decision;
    const d = this._decide();
    this._decision = d;
    if (!d.visible) { if (this._shown) this._hideNow(); return d; }
    const now = this._now();
    const vp = this._viewport();
    let rail = null;
    try { rail = this._rail(); } catch (_e) { rail = null; }
    let box = null;
    try { box = this._box(); } catch (_e) { box = null; }
    const rect = rangeMapRect(vp.w, vp.h, d.mode, { rail, box });
    if (!rect) { if (this._shown) this._hideNow(); this._decision = { visible: false, mode: d.mode, phase: 'hidden' }; return this._decision; }
    this._rect = rect;
    const trip = this._get(this._trip);
    // the rows, her height and the focus the map is about
    const live = d.phase === 'list';
    if (live) {
      const focusId = this._list.focusedId();
      const due = now - this._lastRowsMs >= RM().REDRAW_MS;
      if (!due && focusId === this._focusId && this._shown && this._lastPhase === 'list' && this._rows.length) return d;    // nothing new this frame
      if (due || focusId !== this._focusId || !this._rows.length) {
        this._lastRowsMs = now;
        try { this._rows = this._list.rowData(); } catch (_e) { this._rows = []; }
        const reg = this._get(this._registry);
        let herKm = null;
        try { herKm = reg && typeof reg.altitudeKm === 'function' ? reg.altitudeKm() : null; } catch (_e) { herKm = null; }
        this._herKm = Number.isFinite(herKm) ? herKm : null;
      }
      this._focusId = focusId;
    } else {
      this._rows = this._pick.rows;
      this._herKm = this._pick.herKm;
      this._focusId = this._pick.id;
    }
    if (d.mode === 'trip' && now - this._lastDrawMs < RM().REDRAW_MS && this._drawKey !== null && this._shown) return d;
    this._model(d, trip, rect);
    this._ensureDom();
    this._place(rect, d);
    this._setText(d, trip);
    this._draw(d);
    if (!this._shown) this._show(d);
    this._lastPhase = d.phase;
    return d;
  }

  /** @private layout, focus, path, dot, band for this frame */
  _model(d, trip, rect) {
    const rows = this._rows;
    const layoutKey = `${rowsSignature(rows)}#${this._herKm == null ? '' : Math.round(this._herKm)}#${Math.round(rect.side)}`;
    if (layoutKey !== this._layoutKey) {
      this._layoutKey = layoutKey;
      this._layout = buildLayout({ rows, herKm: this._herKm, side: rect.side });
      this._side = rect.side;
    }
    const L = this._layout;
    this._band = reachBand(L);
    this._originRing = L.rings.find((r) => r.here) || null;
    this._focusRing = ringOfRow(L, this._focusId, rows);
    const row = rows.find((r) => r.id === this._focusId) || null;
    this._path = null; this._arrow = null; this._dot = null; this._flownTo = null; this._plan = null;
    const home = this._originRing;
    const target = this._focusRing;
    if (row && row.kind === 'call' && target && home) {
      this._arrow = callArrow(L, target.altKm, home.altKm, ARROW_ANGLE);
      this._dot = { x: this._arrow.to.x, y: this._arrow.to.y };
    } else if (((isDestination(row) && target) || (isPush(row) && !live(d))) && home && target !== home) {
      const toKm = target ? target.altKm : row.altKm;                 // a push-down row has no ring: its height lies between two of them (F1.7)
      let profile = null;
      if (d.phase === 'burn' && trip && trip.profile && Array.isArray(trip.profile.samples)) profile = trip.profile;
      else if (!live(d) && this._pick) profile = this._pick.profile;
      else {
        const key = `${row.id}#${rowsSignature(rows)}`;
        if (key !== this._planKey) { this._planKey = key; this._planProfile = this._profileFor(row.id); }
        profile = this._planProfile;
      }
      this._plan = { profile, fromKm: home.altKm, toKm };
      this._path = spiralPoints(L, this._plan);
      if (d.phase === 'burn' && trip) {
        const f = Math.max(0, Math.min(1, Number.isFinite(trip.progress) ? trip.progress : 0));
        this._flownTo = f;
        const at = spiralAt(L, this._plan, f);
        this._dot = { x: at.x, y: at.y, radius: at.radius };
      } else if (d.phase === 'wait') {
        const at = spiralAt(L, this._plan, 0);
        this._dot = { x: at.x, y: at.y, radius: at.radius };
      }
    }
    if (!this._dot && home) {
      const a = Math.PI;
      this._dot = { x: L.cx + home.radius * Math.cos(a), y: L.cy - home.radius * Math.sin(a), radius: home.radius };
    }
  }

  /** @private the lines under the canvas (RangeMapModel.textLines: packed top-down, short enough for the smallest canvas) */
  _setText(d, trip) {
    const gas = (() => { try { return this._gas(); } catch (_e) { return null; } })();
    const tally = this._get(this._tally);
    const reg = this._get(this._registry);
    const berthed = !!(reg && typeof reg.atSatellite === 'function' && reg.atSatellite());
    const td = d.phase === 'burn' && trip && typeof trip.tripDay === 'function' ? trip.tripDay() : null;
    const t = textLines({
      aboardKg: gas ? gas.aboardKg : NaN, tankKg: gas ? gas.tankKg : NaN,
      showMission: d.phase === 'list' && !berthed && !!tally, gainedKg: tally ? tally.gainedKg : NaN, usedKg: tally ? tally.usedKg : NaN,
      orbits: this._plan && this._plan.profile && Array.isArray(this._plan.profile.samples) ? orbitCount(this._plan.profile.samples) : 0,
      day: td ? td.day : NaN, days: td ? td.days : NaN, called: d.phase === 'call',
    });
    for (let i = 0; i < t.length; i++) {
      if (t[i] !== this._text[i]) { this._text[i] = t[i]; if (this._lines[i]) this._lines[i].textContent = t[i]; }
    }
  }

  /** @private */
  _draw(d) {
    const L = this._layout;
    const progressKey = this._flownTo == null ? '' : Math.round(this._flownTo * 500);
    const key = `${this._layoutKey}#${this._focusId}#${d.mode}#${d.phase}#${progressKey}#${this._dot ? Math.round(this._dot.x) + ',' + Math.round(this._dot.y) : ''}`;
    if (key === this._drawKey) return;
    this._drawKey = key;
    this._lastDrawMs = this._now();
    if (!this._g || !L) return;
    paintRangeMap(this._g, {
      layout: L, side: this._side, focusRing: this._focusRing, originRing: this._originRing, band: this._band,
      path: this._path, flownTo: this._flownTo, dot: this._dot, arrow: this._arrow, tripMode: d.mode === 'trip',
    });
  }

  // ── Taps ───────────────────────────────────────────────────────────────────

  /**
   * A tap at (x, y) on the canvas (CSS px from its top-left): focus the row of the ring it is nearest to. Only while the list is open; never a pick.
   * @returns {boolean} the focus is on that ring's row now
   */
  tapAt(x, y) {
    if (this._disposed || !this._layout || this._decision.phase !== 'list') return false;
    const ring = hitTest(this._layout, x, y);
    if (!ring || ring.rowId == null || !this._list || typeof this._list.focus !== 'function') return false;
    const ok = !!this._list.focus(ring.rowId);
    if (ok) this.update();
    return ok;
  }

  /** What the map shows now (tests): the decision, the rect, the focused ring, the dot, the lines. */
  state() {
    const L = this._layout;
    return {
      visible: this.isShown(), mode: this._decision.mode, phase: this._decision.phase, rect: this._rect ? { ...this._rect } : null,
      focusId: this._focusId, focusAltKm: this._focusRing ? this._focusRing.altKm : null, originAltKm: this._originRing ? this._originRing.altKm : null,
      rings: L ? L.rings.length : 0, layout: L, dot: this._dot ? { ...this._dot } : null, flownTo: this._flownTo,
      pathStartRadius: this._path ? this._path[0].radius : null, pathEndRadius: this._path ? this._path[this._path.length - 1].radius : null,
      hasArrow: !!this._arrow, band: this._band, lines: this._text.slice(),
    };
  }

  /** The canvas and root elements (tests). */
  get canvas() { return this._canvas; }
  get element() { return this._root; }

  // ── DOM ────────────────────────────────────────────────────────────────────

  /** @private build the root once (hidden) */
  _ensureDom() {
    if (this._built) return;
    const doc = this._doc;
    if (!doc || typeof doc.createElement !== 'function') return;
    const parent = this._parent || doc.body;
    if (!parent || typeof parent.appendChild !== 'function') return;
    this._built = true;
    const root = doc.createElement('div');
    root.id = RANGE_MAP_ID;
    root.setAttribute('aria-label', 'Orbital range map: rings by height, your reach with the gas aboard');
    Object.assign(root.style, {
      position: 'absolute', left: '0px', top: '0px', boxSizing: 'border-box', zIndex: '33', pointerEvents: 'none', display: 'none',
      background: RM().COLORS.BACKING, borderRadius: '6px', boxShadow: `inset 0 0 0 1px ${RM().COLORS.BACKING_EDGE}`,    // F1.3: one dark backing behind the canvas AND the text block
      fontFamily: 'var(--font-mono)', fontSize: `${RM().TEXT_FONT_PX}px`, letterSpacing: '0', opacity: '1',
    });
    const canvas = doc.createElement('canvas');
    canvas.setAttribute('role', 'img');
    Object.assign(canvas.style, { display: 'block', background: 'transparent', boxSizing: 'border-box', pointerEvents: 'none' });
    const stop = (e) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); };
    for (const t of STOPPED_EVENTS) canvas.addEventListener(t, stop);
    canvas.addEventListener('click', (e) => {
      stop(e);
      const b = typeof canvas.getBoundingClientRect === 'function' ? canvas.getBoundingClientRect() : { left: 0, top: 0 };
      const x = (e && Number.isFinite(e.clientX) ? e.clientX : 0) - b.left;
      const y = (e && Number.isFinite(e.clientY) ? e.clientY : 0) - b.top;
      this.tapAt(x, y);
    });
    root.appendChild(canvas);
    const box = doc.createElement('div');
    Object.assign(box.style, { marginTop: '4px', padding: `0 ${RM().TEXT_PAD_PX}px 5px`, pointerEvents: 'none', color: 'rgba(225,240,255,0.95)', textTransform: 'none' });
    for (let i = 0; i < RM().TEXT_LINES; i++) {
      const line = doc.createElement('div');
      Object.assign(line.style, { height: `${RM().TEXT_LINE_PX}px`, lineHeight: `${RM().TEXT_LINE_PX}px`, whiteSpace: 'nowrap', overflow: 'hidden', opacity: '1' });
      line.textContent = '';
      box.appendChild(line);
      this._lines.push(line);
    }
    root.appendChild(box);
    parent.appendChild(root);
    this._root = root;
    this._canvas = canvas;
    this._parentEl = parent;
    this._g = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  }

  /** @private position and size the panel */
  _place(rect, d) {
    if (!this._root) return;
    const side = Math.round(rect.side);
    const key = `${Math.round(rect.x)},${Math.round(rect.y)},${side},${d.mode === 'choose' && d.phase === 'list'}`;
    if (key !== this._posKey) {
      this._posKey = key;
      this._root.style.left = `${Math.round(rect.x)}px`;
      this._root.style.top = `${Math.round(rect.y)}px`;
      this._root.style.width = `${side}px`;
      const dpr = Math.max(1, Math.min(3, Number(this._dpr()) || 1));
      this._canvas.style.width = `${side}px`;
      this._canvas.style.height = `${side}px`;
      this._canvas.width = Math.round(side * dpr);
      this._canvas.height = Math.round(side * dpr);
      if (this._g && typeof this._g.setTransform === 'function') this._g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this._drawKey = null;                                   // a resized canvas is blank
    }
    this._canvas.style.pointerEvents = d.phase === 'list' ? 'auto' : 'none';     // taps only mean something while the list is open
  }

  /** @private on screen: the trip's entrance fades in (0.6 s), the list's is at once */
  _show(d) {
    if (!this._root) return;
    this._shown = true;
    const fade = d.mode === 'trip' && !this._reduced();
    if (fade) {
      this._root.style.transition = 'none';
      this._root.style.opacity = '0';
      this._root.style.display = 'block';
      if (typeof this._root.getBoundingClientRect === 'function') this._root.getBoundingClientRect();   // a reflow, so the opacity change below animates
      this._root.style.transition = `opacity ${RM().FADE_MS}ms ease`;
      this._root.style.opacity = '1';
    } else {
      this._root.style.transition = 'none';
      this._root.style.opacity = '1';
      this._root.style.display = 'block';
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const off of this._offs) { try { off(); } catch (_e) { /* gone */ } }
    this._offs = [];
    if (this._root) {
      if (typeof this._root.remove === 'function') this._root.remove();
      else if (this._parentEl && typeof this._parentEl.removeChild === 'function') this._parentEl.removeChild(this._root);
    }
    this._root = null; this._canvas = null; this._g = null; this._lines = [];
    this._pick = null; this._layout = null; this._rows = [];
  }
}

/** @private is this decision the live list's (a helper for `_model`) */
function live(d) { return d.phase === 'list'; }
