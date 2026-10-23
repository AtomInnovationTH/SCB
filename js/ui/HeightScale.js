/**
 * HeightScale - the fields and the resupply satellite on floor 4 (the LEO map), as a height scale beside her ship marker
 * (Nets step 3 slice 3, lane 3e s3-map-icons; DECISIONS §33 row 6: "floor 4 shows the next fields and the satellite with fuel and
 * travel time"; FEATURE_FLAGS.FIELDS_BY_HEIGHT).
 *
 * Why a scale and not icons at map positions: a field is a ring at a HEIGHT in her tilt, not a point (the registry knows only
 * `altKm`), and the cluster icons (ClusterIcons) group the debris by inclination band and height cell, so f350 and f375 share one
 * "ISS Band" icon and the other fields have none (only her own field's pieces are laid out). So the chips stand in a column beside
 * her ship marker, highest at the top:
 *   "450 km · cleared"   "425 km · 7 pieces"   "Resupply satellite · 500 km"   ...   "You · 352 km" (her real height, marked)
 * While the where-next list is open each chip also carries its row's gas and days ("0.6 kg gas · 5 days", "needs 1.2 kg gas, 0.4 kg
 * short"), the focused row's chip is highlighted, and tapping a chip FOCUSES its row (`WhereNextList.focus`, never a pick: flying
 * stays the list's own tap-again / Space / FLY THERE). Her own field's chip is the Stay row's. Flag off (or no registry): nothing is
 * built, the map is exactly as before.
 *
 * Pure parts are exported (`buildScaleChips`, `placeColumn`) so the words and the placement are tested without a DOM. The DOM part
 * uses inline styles and only createElement / appendChild / removeChild / setAttribute / textContent / addEventListener, so a tiny
 * fake DOM runs it; with no document nothing is built and every method still answers.
 *
 * @module ui/HeightScale
 */
import { VisualLaw } from '../core/VisualLaw.js';
import { STAY_ID, piecesText, daysText, kgText } from '../systems/WhereNextRows.js';
import { STOPPED_EVENTS, FOCUS_COLOR } from './WhereNextList.js';
import { ClusterIcons } from './ClusterIcons.js';

export const HEIGHT_SCALE_ID = 'field-height-scale';
/** Chip height (px; two lines: the height and pieces, then gas and days): a pointer, and glass (44 px touch target). */
export const CHIP_PX_DESKTOP = 36;
export const CHIP_PX_GLASS = 44;
/** The "You" marker row's height (px), the gap between rows, the column's width. */
export const YOU_PX = 22;
export const GAP_PX = 3;
export const WIDTH_PX = 236;
/** How far right (or left) of her ship marker the column stands (px): clear of the 18 px chevron and its ring. */
export const SHIP_GAP_PX = 44;
/** Keep the column off the top HUD strip (vitals, comms, score: 0-262 px down at 1366x1024) and the bottom rail (px). */
export const TOP_MIN_PX = 90;
export const BOTTOM_MIN_PX = 24;
export const SIDE_MIN_PX = 8;
/** Real-time interval between reads of the HUD panels' rects (ms): they change when a panel opens, not per frame. */
export const RECTS_MS = 500;

const DOT = '\u00b7';
const MARK = '\u25b8';

/** @param {number} km @returns {string} her height as "352 km" */
function kmText(km) { return `${Math.round(km)} km`; }

/** The words under a chip's height while the list is open: that row's gas and days (or why she cannot go). */
function rowDetail(row) {
  if (!row) return '';
  if (row.state === 'stay') return 'Stay here';
  if (row.state === 'ok') return `${kgText(row.gasKg)} kg gas ${DOT} ${daysText(row.days)}`;
  if (row.state === 'short') return `needs ${kgText(row.gasKg)} kg gas, ${kgText(row.shortKg)} kg short`;
  if (row.state === 'cannot') return 'the thruster cannot take her there';
  return '';
}

/**
 * @typedef {object} ScaleItem
 * @property {'field'|'satellite'|'you'} kind
 * @property {string} id         chip id: the field id, the satellite id, or 'you'
 * @property {string|null} rowId the where-next row a tap focuses (her own field -> the Stay row), or null
 * @property {number} altKm
 * @property {string} text       the chip's first line
 * @property {string} detail     the second line ('' = none)
 * @property {boolean} here      her own field (not berthed), or the satellite she is berthed at
 * @property {boolean} cleared
 * @property {boolean} selectable the row exists and can be picked (a tap on the chip focuses only these)
 * @property {boolean} focused    the list is open and this chip's row has the focus
 */

/**
 * The chips, highest first, with her own height marked. Pure.
 * @param {object} reg a FieldRegistry (or anything with `isOn`, `fields`, `satellites`, `remainingCount`, `currentId`,
 *   `berthedSatellite`, `altitudeKm`)
 * @param {{open: boolean, rows: Array, focusId: (string|null)}|null} [list] the where-next list's state when it is open
 * @returns {ScaleItem[]} [] when the map is off
 */
export function buildScaleChips(reg, list = null) {
  if (!reg || typeof reg.isOn !== 'function' || !reg.isOn() || typeof reg.fields !== 'function') return [];
  const open = !!(list && list.open);
  const byId = new Map();
  if (open && Array.isArray(list.rows)) for (const r of list.rows) byId.set(r.id, r);
  const berth = typeof reg.berthedSatellite === 'function' ? reg.berthedSatellite() : null;
  const hereId = typeof reg.currentId === 'function' ? reg.currentId() : null;
  const focusId = open ? list.focusId : null;
  /** @type {ScaleItem[]} */
  const items = [];
  for (const f of reg.fields()) {
    const n = reg.remainingCount(f.id);
    const here = !berth && f.id === hereId;
    const rowId = here ? STAY_ID : f.id;
    const row = byId.get(rowId) || null;
    let detail = rowDetail(row);
    if (here && !(row && row.state === 'stay')) detail = 'You are here';
    items.push({
      kind: 'field', id: f.id, rowId: row ? rowId : null, altKm: f.altKm, here, cleared: n === 0,
      text: `${kmText(f.altKm)} ${DOT} ${n === 0 ? 'cleared' : piecesText(n)}`, detail,
      selectable: !!(row && row.selectable), focused: !!row && focusId === rowId,
    });
  }
  const sats = typeof reg.satellites === 'function' ? reg.satellites() : [];
  for (const s of sats) {
    const here = !!berth && berth.id === s.id;
    const row = byId.get(s.id) || null;
    items.push({
      kind: 'satellite', id: s.id, rowId: row ? s.id : null, altKm: s.altKm, here, cleared: false,
      text: `${s.name || 'Resupply satellite'} ${DOT} ${kmText(s.altKm)}`, detail: here ? 'Berthed' : rowDetail(row),
      selectable: !!(row && row.selectable), focused: !!row && focusId === s.id,
    });
  }
  const alt = typeof reg.altitudeKm === 'function' ? reg.altitudeKm() : null;
  if (Number.isFinite(alt)) {
    items.push({ kind: 'you', id: 'you', rowId: null, altKm: alt, here: true, cleared: false, text: `You ${DOT} ${kmText(alt)}`, detail: '', selectable: false, focused: false });
  }
  const rank = (i) => (i.kind === 'you' ? 1 : 0);
  items.sort((a, b) => b.altKm - a.altKm || rank(a) - rank(b));
  return items;
}

/** The column's height (px) for its items. */
export function columnHeight(items, chipPx) {
  let h = 0;
  for (const it of items) h += (it.kind === 'you' ? YOU_PX : chipPx) + GAP_PX;
  return Math.max(0, h - GAP_PX);
}

function hits(l, t, w, h, r) { return l < r.x + r.w && l + w > r.x && t < r.y + r.h && t + h > r.y; }

/**
 * Where the column goes: beside her ship marker (right first, else left), centred on it, clamped to the screen and moved up or down
 * (24 px steps, the least move) until it clears every rect (the HUD panels, the where-next list). When nothing clears, the clamped
 * right-hand spot. Pure.
 * @param {{x: number, y: number}} ship her marker's screen position
 * @param {{w: number, h: number, viewW: number, viewH: number, rects?: Array<{x,y,w,h}>}} a
 * @returns {{left: number, top: number, side: 'right'|'left', clear: boolean}}
 */
export function placeColumn(ship, { w, h, viewW, viewH, rects = [] }) {
  const lo = TOP_MIN_PX;
  const hi = Math.max(lo, viewH - BOTTOM_MIN_PX - h);
  const clampT = (t) => Math.min(hi, Math.max(lo, t));
  const ideal = clampT(ship.y - h / 2);
  const fitsRight = ship.x + SHIP_GAP_PX + w <= viewW - SIDE_MIN_PX;
  const fitsLeft = ship.x - SHIP_GAP_PX - w >= SIDE_MIN_PX;
  const lefts = [
    { side: 'right', left: Math.min(viewW - w - SIDE_MIN_PX, Math.max(SIDE_MIN_PX, ship.x + SHIP_GAP_PX)), pen: 0, ok: fitsRight },
    { side: 'left', left: Math.min(viewW - w - SIDE_MIN_PX, Math.max(SIDE_MIN_PX, ship.x - SHIP_GAP_PX - w)), pen: 12, ok: fitsLeft },
  ];
  let best = null;
  // a side that runs off the screen would stand over her marker: it is the last resort, after a side that fits
  for (const c of lefts.filter((x) => x.ok).concat(lefts.filter((x) => !x.ok && !(fitsRight || fitsLeft)))) {
    for (let k = 0; ; k++) {
      const offs = k === 0 ? [0] : [-24 * k, 24 * k];
      let any = false;
      for (const o of offs) {
        const t = ideal + o;
        if (t < lo - 1e-9 || t > hi + 1e-9) continue;
        any = true;
        if (rects.some((r) => hits(c.left, t, w, h, r))) continue;
        const cost = Math.abs(o) + c.pen;
        if (!best || cost < best.cost) best = { left: c.left, top: t, side: c.side, clear: true, cost };
      }
      if (!any && k > 0) break;
    }
  }
  if (best) return { left: best.left, top: best.top, side: best.side, clear: true };
  return { left: lefts[0].left, top: ideal, side: 'right', clear: false };
}

export class HeightScale {
  /**
   * @param {object} deps
   * @param {object|function} deps.registry   the FieldRegistry, or () => it (main.js builds it before this)
   * @param {object} [deps.list]              the WhereNextList (isOpen, rowData, focusedId, focus, setOnFocus, element)
   * @param {Document|null} [deps.doc]        document (default: the global one; null = headless)
   * @param {Element} [deps.parent]           where the column goes (default doc.body)
   * @param {function} [deps.glass]           () => true on a touch screen (44 px chips)
   * @param {function} [deps.now]             ms clock (tests)
   */
  constructor(deps = {}) {
    this._registry = deps.registry || null;
    this._list = deps.list || null;
    this._doc = deps.doc !== undefined ? deps.doc : (typeof document !== 'undefined' ? document : null);
    this._parent = deps.parent || null;
    this._glass = typeof deps.glass === 'function' ? deps.glass : () => false;
    this._now = typeof deps.now === 'function' ? deps.now : () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._root = null;
    this._built = false;
    this._disposed = false;
    this._visible = false;
    this._items = [];
    this._els = [];
    this._paintKey = null;
    this._shapeKey = null;
    this._parts = [];
    this._posKey = null;
    this._rects = [];
    this._rectsMs = -Infinity;
    this._lastView = null;
    if (this._list && typeof this._list.setOnFocus === 'function') this._list.setOnFocus(() => this._repaint());
    // the cluster label on the map names her field by its height (ClusterIcons.nameLine) from the same registry
    if (this._registry) ClusterIcons.setFieldRegistry(this._registry);
  }

  /** @private */
  _reg() { return typeof this._registry === 'function' ? this._registry() : this._registry; }

  /** @private the list's state for the chips (open rows and focus), or null when it is closed. */
  _listState() {
    const l = this._list;
    if (!l || typeof l.isOpen !== 'function' || !l.isOpen()) return null;
    return { open: true, rows: typeof l.rowData === 'function' ? l.rowData() : l.rows(), focusId: l.focusedId() };
  }

  /** The chips as last painted (a copy; tests). */
  items() { return this._items.map((i) => ({ ...i })); }
  isShown() { return this._visible && !!this._root && this._root.style.display !== 'none'; }
  /** The text of each chip as painted: the first line, then the second ('' none), joined by " | " (tests). */
  domText() { return this._els.map((el) => (el.children || []).map((c) => c.textContent).filter(Boolean).join(' | ')); }
  /** The chip elements (tests). */
  get chipElements() { return this._els.slice(); }
  get element() { return this._root; }

  // ── Floor 4 shows / hides it (NavcomFloor.activate / deactivate) ───────────

  show() { this._visible = true; if (this._root) this._root.style.display = this._items.length ? 'block' : 'none'; }
  hide() { this._visible = false; if (this._root) this._root.style.display = 'none'; }

  // ── Frame ──────────────────────────────────────────────────────────────────

  /**
   * One frame while floor 4 is the floor she is on: refresh the chips and put the column beside her marker. Map off = nothing built.
   * @param {object} [ctx]
   * @param {{x: number, y: number, visible?: boolean}|null} [ctx.shipPx] her ship marker's screen position
   * @param {number} [ctx.viewW] @param {number} [ctx.viewH]   viewport (default: the window's)
   * @param {function} [ctx.rects]   () => the HUD panels' rects, read about every RECTS_MS (NavcomFloor.hudPanelRects)
   * @returns {{items: ScaleItem[], left: number, top: number, side: string}|null}
   */
  render(ctx = {}) {
    if (this._disposed) return null;
    const items = this._compute();
    if (!items.length) { this._items = []; if (this._root) this._root.style.display = 'none'; return null; }
    this._lastView = ctx;
    this._items = items;
    this._ensureRoot();
    if (!this._root) return { items, left: 0, top: 0, side: 'right' };
    this._paint();
    const W = Number.isFinite(ctx.viewW) ? ctx.viewW : (typeof window !== 'undefined' ? window.innerWidth : 1366);
    const H = Number.isFinite(ctx.viewH) ? ctx.viewH : (typeof window !== 'undefined' ? window.innerHeight : 1024);
    const now = this._now();
    if (typeof ctx.rects === 'function' && now - this._rectsMs >= RECTS_MS) {
      this._rectsMs = now;
      try { this._rects = ctx.rects() || []; } catch (_e) { this._rects = []; }
    }
    const rects = this._rects.filter((r) => r && r.id !== HEIGHT_SCALE_ID).concat(this._listRect());
    const chipPx = this._glass() ? CHIP_PX_GLASS : CHIP_PX_DESKTOP;
    const w = Math.min(WIDTH_PX, W - 2 * SIDE_MIN_PX);
    const h = columnHeight(items, chipPx);
    const p = ctx.shipPx && Number.isFinite(ctx.shipPx.x) && Number.isFinite(ctx.shipPx.y) ? ctx.shipPx : { x: W * 0.12, y: H * 0.5 };
    const at = placeColumn(p, { w, h, viewW: W, viewH: H, rects });
    const key = `${Math.round(at.left)},${Math.round(at.top)},${w}`;
    if (key !== this._posKey) {
      this._posKey = key;
      this._root.style.left = `${Math.round(at.left)}px`;
      this._root.style.top = `${Math.round(at.top)}px`;
      this._root.style.width = `${w}px`;
    }
    this._root.style.display = this._visible ? 'block' : 'none';
    return { items, left: at.left, top: at.top, side: at.side };
  }

  /** @private the where-next list's panel rect while it is open (it stands bottom centre; the column keeps clear of it). */
  _listRect() {
    const l = this._list;
    const el = l && l.element;
    if (!el || typeof el.getBoundingClientRect !== 'function' || !(l.isOpen && l.isOpen())) return [];
    const b = el.getBoundingClientRect();
    return b && b.width > 1 && b.height > 1 ? [{ id: 'where-next-list', x: b.x, y: b.y, w: b.width, h: b.height }] : [];
  }

  /** @private */
  _compute() {
    const reg = this._reg();
    if (!reg) return [];
    let list = null;
    try { list = this._listState(); } catch (_e) { list = null; }
    try { return buildScaleChips(reg, list); } catch (_e) { return []; }
  }

  /** @private the list's focus moved (or a pick put the rows back): repaint the chips now, not next frame. */
  _repaint() {
    if (this._disposed || !this._root) return;
    const items = this._compute();
    if (!items.length) return;
    this._items = items;
    this._paint();
  }

  // ── DOM ────────────────────────────────────────────────────────────────────

  /** @private build the root once (hidden). */
  _ensureRoot() {
    if (this._built) return;
    const doc = this._doc;
    if (!doc || typeof doc.createElement !== 'function') return;
    const parent = this._parent || doc.body;
    if (!parent || typeof parent.appendChild !== 'function') return;
    this._built = true;
    const root = doc.createElement('div');
    root.id = HEIGHT_SCALE_ID;
    root.setAttribute('aria-label', 'Fields and the resupply satellite by height');
    Object.assign(root.style, {
      position: 'absolute', left: '0px', top: '0px', boxSizing: 'border-box', width: `${WIDTH_PX}px`, zIndex: '33',
      pointerEvents: 'none', display: 'none', fontFamily: 'var(--font-mono)', fontSize: '0.7rem', letterSpacing: '0.03em',
    });
    parent.appendChild(root);
    this._root = root;
    this._parentEl = parent;
  }

  /**
   * @private repaint the chips. The chip ELEMENTS are rebuilt only when the set of chips changes (their ids, kinds, whether a tap
   * lands, whether there is a second line, glass, list open); a change of text, focus or her height is written into the same
   * nodes, so a tap that lands while the rows refresh (or her height ticks) is never lost to a rebuilt node.
   */
  _paint() {
    if (!this._root) return;
    const doc = this._doc;
    const glass = !!this._glass();
    const open = !!(this._list && this._list.isOpen && this._list.isOpen());
    const shapeKey = JSON.stringify([glass, open, this._items.map((i) => [i.id, i.kind, i.rowId != null, !!i.detail])]);
    const key = JSON.stringify([shapeKey, this._items.map((i) => [i.text, i.detail, i.here, i.focused, i.selectable, i.cleared])]);
    if (key === this._paintKey) return;
    this._paintKey = key;
    if (shapeKey !== this._shapeKey) {
      this._shapeKey = shapeKey;
      for (const el of this._els) this._root.removeChild(el);
      this._els = [];
      this._parts = [];
      for (const it of this._items) {
        const el = doc.createElement('div');
        el.setAttribute('data-id', it.id);
        el.setAttribute('data-kind', it.kind);
        const a = doc.createElement('span');
        el.appendChild(a);
        const part = { a, b: null };
        if (it.kind !== 'you' && it.detail) { part.b = doc.createElement('span'); el.appendChild(part.b); }
        if (it.kind !== 'you' && open && it.rowId != null) {
          const stop = (e) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); };
          for (const t of STOPPED_EVENTS) el.addEventListener(t, stop);
          el.addEventListener('click', (e) => { stop(e); this.tapChip(it.id); });
        }
        this._root.appendChild(el);
        this._els.push(el);
        this._parts.push(part);
      }
    }
    const chipPx = glass ? CHIP_PX_GLASS : CHIP_PX_DESKTOP;
    this._items.forEach((it, i) => {
      const el = this._els[i];
      const { a, b } = this._parts[i];
      const base = {
        boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'center', marginBottom: `${GAP_PX}px`,
        padding: '2px 8px', borderRadius: '3px', overflow: 'hidden', whiteSpace: 'nowrap', pointerEvents: 'none',
        color: VisualLaw.COLORS.INFO, textTransform: 'none',
      };
      if (it.kind === 'you') {
        Object.assign(el.style, base, {
          height: `${YOU_PX}px`, background: 'rgba(0,0,0,0.78)', color: VisualLaw.COLORS.PLAYER,
          borderLeft: `3px solid ${VisualLaw.COLORS.PLAYER}`, fontWeight: 'bold',
        });
        a.textContent = it.text;
        return;
      }
      const tappable = open && it.rowId != null;
      Object.assign(el.style, base, {
        height: `${chipPx}px`, background: it.focused ? 'rgba(68,136,255,0.28)' : 'rgba(0,16,32,0.88)',
        border: `1px solid ${it.focused ? FOCUS_COLOR : (it.here ? VisualLaw.COLORS.PLAYER : 'rgba(0,204,255,0.45)')}`,
        opacity: it.cleared || (open && it.rowId != null && !it.selectable) ? '0.6' : '1',
        pointerEvents: tappable ? 'auto' : 'none', cursor: it.selectable ? 'pointer' : 'default',
      });
      a.textContent = `${it.focused ? `${MARK} ` : ''}${it.text}`;
      if (b) {
        b.textContent = it.detail;
        Object.assign(b.style, { opacity: '0.8', fontSize: '0.64rem', color: it.here ? VisualLaw.COLORS.PLAYER : VisualLaw.COLORS.INFO });
      }
    });
  }

  /**
   * A tap on a chip: focus its row in the where-next list. Never a pick (flying stays the list's own tap-again / Space / chip).
   * @param {string} id the chip id (a field id or the satellite's)
   * @returns {boolean} the focus is on that row now
   */
  tapChip(id) {
    const it = this._items.find((i) => i.id === id);
    if (!it || it.rowId == null || !this._list || typeof this._list.focus !== 'function') return false;
    return !!this._list.focus(it.rowId);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._registry) ClusterIcons.setFieldRegistry(null);
    if (this._list && typeof this._list.setOnFocus === 'function') this._list.setOnFocus(null);
    if (this._root) {
      if (typeof this._root.remove === 'function') this._root.remove();
      else if (this._parentEl && typeof this._parentEl.removeChild === 'function') this._parentEl.removeChild(this._root);
    }
    this._root = null;
    this._els = [];
    this._items = [];
  }
}
