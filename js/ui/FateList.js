/**
 * FateList - the fate list: what to do with a big caught piece (DECISIONS §33 rows 16-17).
 * A big piece pays when disposed of, not at the catch (js/systems/BigPieces.js): hand it to a satellite, push it down,
 * fit a drag sail, keep it aboard, or melt it. Same pattern as ui/WhereNextList.js, with its own id, title and hints.
 *
 * Owns no game state. `getPieces()` gives the pending pieces (BigPieces.pendingAboard: oldest catch first),
 * `getRows(piece)` the words (js/systems/FateRows.js). A pick calls `setFate(id, fate)` (GameFlowManager.setFate)
 * and, ONLY when that returned true, emits `Events.BIG_PIECE_FATE {debrisId, fate}` for the fate's executor, says one
 * plain line and closes. Refreshes on `BIG_PIECE_DISPOSED` and once a second while open; closes when nothing is left.
 *
 * Opens with U (InputManager calls `toggleFromKey`) on floors 2-4, or the CHOOSE chip on glass (it presses U), only
 * with a big piece aboard. While open, `onOpenChange(true)` lets the host hide the where-next list.
 *
 * Three big choices by rule (FateRows.pickChoices: easiest fate that pays, best-paying other, keep); under them a
 * DETAILS block: the "Also" rows (other pickable fates) and plain lines. The model keeps all five fates.
 *
 * Keys (while open; a window capture listener, so the ladder's arrows and Tab never see them):
 *   Left / Right  the previous / next piece ("1 of 3")        Up / Down / Tab  the previous / next choice, then the "Also" rows
 *   Enter / Space pick the focused row                         Esc / U          close
 * Touch / mouse: a tap focuses a row, tapping the focused row picks it; tabs and close are 44 px targets on glass.
 *
 * DOM-guarded (no document: nothing built, every method still answers). Only createElement / appendChild /
 * removeChild / setAttribute / textContent / addEventListener, so a tiny fake DOM runs it.
 *
 * @module ui/FateList
 */
import { VisualLaw } from '../core/VisualLaw.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { FloorContract } from '../core/FloorContract.js';
import { pieceName } from '../systems/BigPieces.js';

export const FATE_LIST_ID = 'fate-list';
export const TITLE_TEXT = 'WHAT TO DO WITH IT';
/** Row / button height (px): glass (touch target) and pointer. */
export const ROW_PX_GLASS = 44;
export const ROW_PX_DESKTOP = 28;
/** Real-time ms between rebuilds while open (gas, mass and stock change while she thinks). */
export const REFRESH_MS = 1000;
/** Sits exactly where the where-next list sits (bottom centre, never past the top HUD strip). */
export const BOTTOM_PX = 164;
export const WIDTH_PX = 580;
export const TOP_CLEAR_PX = 280;
export const MAX_HEIGHT_CSS = `calc(100vh - ${BOTTOM_PX + TOP_CLEAR_PX}px)`;
export const STOPPED_EVENTS = ['pointerdown', 'pointerup', 'pointermove', 'touchstart', 'touchmove', 'touchend', 'mousedown', 'mouseup', 'click'];
export const HINT_DESKTOP = '\u2190 \u2192 other piece \u00b7 \u2191 \u2193 choice \u00b7 Enter: choose \u00b7 U: close';
export const HINT_GLASS = 'Tap a row, tap it again to choose';
/** Floors the list opens on; no ladder (no floor number) opens anywhere. */
export const FLOORS = Object.freeze([2, 3, 4]);

const MARK = '\u25b8';
const _nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const FLOOR4 = (FloorContract.byId(4) || { name: 'map' }).name;

/** Painted sizes (CSS px) for the height ESTIMATE; only a browser measures the real one. */
export const LAYOUT_PX = Object.freeze({
  PAD: 18,              // padding 8 + 8 and the 1 px border either side
  HEAD_TEXT: 20,        // the title line (the close button is `px` tall)
  TABS_TEXT: 18,
  CHOICE_MIN: 52,       // a big row: bold label line + one dim sub-line + padding (never under the touch target)
  DIVIDER: 12,          // rule, gap and the small "DETAILS" label
  DETAIL_LINE: 15,      // one wrapped line of a detail
  DETAIL_GAP: 4,
  DETAIL_CHARS: 70,     // characters per wrapped line at 0.7rem in 560 px (estimate)
  HINT: 20,
});

/** Fills in the choice fields: a model with no `choices` (a host's own, older shape) shows every pickable row as a choice. */
export function normalizeModel(m) {
  const rows = m.rows.map((r) => ({ ...r, label: r.label != null ? r.label : r.text, money: r.money || '', sub: r.sub || '' }));
  const hasChoices = Array.isArray(m.choices);
  const choices = hasChoices ? m.choices.filter((id) => rows.some((r) => r.id === id)) : rows.filter((r) => r.selectable).map((r) => r.id);
  const also = Array.isArray(m.also) ? m.also.filter((id) => rows.some((r) => r.id === id) && !choices.includes(id)) : [];
  return { ...m, rows, choices, also, details: Array.isArray(m.details) ? m.details : [] };
}

/** Estimated open-panel height (px) from the counts, at the LAYOUT_PX heights. */
export function estimateHeightPx(m, glass) {
  const px = glass ? ROW_PX_GLASS : ROW_PX_DESKTOP;
  const L = LAYOUT_PX;
  let h = L.PAD + Math.max(px, L.HEAD_TEXT) + 4 + Math.max(px, L.TABS_TEXT) + 2;
  h += m.choices.length * (Math.max(px, L.CHOICE_MIN) + 2);
  if (m.also.length || m.details.length) h += L.DIVIDER;
  h += m.also.length * (Math.max(px, L.DETAIL_LINE) + 2);
  for (const line of m.details) h += Math.max(1, Math.ceil(String(line).length / L.DETAIL_CHARS)) * L.DETAIL_LINE + L.DETAIL_GAP;
  return h + 6 + L.HINT;
}

/** The one line a pick says; the fate's executor says the rest when it acts. */
export function pickLine(fate, name, berthed) {
  switch (fate) {
    case 'keep': return `Keeping the ${name} aboard.`;
    case 'satellite': return berthed ? `Handing the ${name} to the satellite now.` : `The ${name} goes to the satellite at your next berth.`;
    case 'push': return `Push the ${name} down from the ${FLOOR4} map at your next trip.`;
    case 'sail': return `Fitting a drag sail to the ${name}.`;
    case 'melt': return `The ${name} goes to the tip furnaces: it melts on your next trips.`;
    default: return '';
  }
}

export class FateList {
  /**
   * @param {object} deps
   * @param {Document|null} [deps.doc]       default the global one; null = headless
   * @param {Element} [deps.parent]          default doc.body
   * @param {object} [deps.win]              where the key listener goes (default the global window)
   * @param {function} deps.getPieces        () => [{debris, holder, fate}] (BigPieces.pendingAboard)
   * @param {function} deps.getRows          (debris) => buildFateRows result
   * @param {function} deps.setFate          (id, fate) => boolean (GameFlowManager.setFate)
   * @param {function} [deps.glass]          () => true on a touch screen (44 px targets, tap wording)
   * @param {function} [deps.isInputBlocked] () => true when the game would swallow the key (paused, codex / help open)
   * @param {function} [deps.getFloor]       () => the ladder's floor number, or null (no ladder)
   * @param {function} [deps.inGameplay]     () => false closes the list (a menu, the shop)
   * @param {function} [deps.onOpenChange]   (open) => void
   * @param {boolean}  [deps.poll=true]      false = no refresh timer (tests call `tick`)
   */
  constructor(deps = {}) {
    this._doc = deps.doc !== undefined ? deps.doc : (typeof document !== 'undefined' ? document : null);
    this._parent = deps.parent || null;
    this._win = deps.win !== undefined ? deps.win : (typeof window !== 'undefined' ? window : null);
    this._bus = deps.bus || eventBus;
    this._getPieces = typeof deps.getPieces === 'function' ? deps.getPieces : () => [];
    this._getRows = typeof deps.getRows === 'function' ? deps.getRows : () => null;
    this._setFate = typeof deps.setFate === 'function' ? deps.setFate : () => false;
    this._glass = typeof deps.glass === 'function' ? deps.glass : () => false;
    this._blockedFn = typeof deps.isInputBlocked === 'function' ? deps.isInputBlocked : null;
    this._getFloor = typeof deps.getFloor === 'function' ? deps.getFloor : null;
    this._inGameplay = typeof deps.inGameplay === 'function' ? deps.inGameplay : null;
    this._onOpenChange = typeof deps.onOpenChange === 'function' ? deps.onOpenChange : null;
    this._now = typeof deps.now === 'function' ? deps.now : _nowMs;
    this._poll = deps.poll !== false;
    this._open = false;
    this._pieces = [];
    this._pieceId = null;
    this._model = null;         // buildFateRows result for the shown piece
    this._focusId = null;
    this._lastBuildMs = -Infinity;
    this._root = null;
    this._rowEls = [];
    this._paintKey = null;
    this._built = false;
    this._disposed = false;
    this._timer = null;
    this._unsubs = [];
    this._keyHandler = (e) => this._onWindowKey(e);
    if (this._win && typeof this._win.addEventListener === 'function') this._win.addEventListener('keydown', this._keyHandler, true);
    const on = (name, h) => { if (name && this._bus && typeof this._bus.on === 'function') { const u = this._bus.on(name, h); if (typeof u === 'function') this._unsubs.push(u); } };
    on(Events.BIG_PIECE_DISPOSED, () => { if (this._open) this._rebuild(false); });
    on(Events.GAME_RESET, () => this.close());
  }

  isOpen() { return this._open && !this._disposed; }

  /** The pending pieces as last read: [{id, name, holder, fate}] (a copy). */
  pieces() { return this._pieces.map((p) => ({ id: p.debris.id, name: pieceName(p.debris), holder: p.holder, fate: p.fate })); }
  /** 0-based index of the shown piece, or -1. */
  index() { return this._pieces.findIndex((p) => p.debris.id === this._pieceId); }
  pieceId() { return this._pieceId; }
  /** The shown piece's rows as built: [{id, text, label, money, sub, selectable, state, current, focused}], all five fates (a copy). */
  rows() { return this._model ? this._model.rows.map((r) => ({ ...r, focused: r.id === this._focusId })) : []; }
  choices() { return this._model ? this._model.choices.slice() : []; }
  /** Ids of the "Also" rows (pickable, shown small under the choices). */
  also() { return this._model ? this._model.also.slice() : []; }
  focusOrder() { return this._model ? this._model.choices.concat(this._model.also) : []; }
  /** Detail lines under the choices ("Not possible now: ...", "Owner: ...", "Values: ..."). */
  details() { return this._model ? this._model.details.slice() : []; }
  model() { return this._model; }
  focusedId() { return this._focusId; }

  /** @private floors 2-4; no ladder = any. */
  _floorOk() {
    if (!this._getFloor) return true;
    let f = null;
    try { f = this._getFloor(); } catch (_e) { f = null; }
    return f == null || FLOORS.includes(f);
  }

  /** @private a throwing getter counts as blocked. */
  _blocked() {
    if (!this._blockedFn) return false;
    try { return !!this._blockedFn(); } catch (_e) { return true; }
  }

  /** A big piece aboard, floors 2-4, not blocked. */
  canOpen() {
    if (this._disposed || this._blocked() || !this._floorOk()) return false;
    let ps = [];
    try { ps = this._getPieces() || []; } catch (_e) { ps = []; }
    return ps.length > 0;
  }

  /** @returns {boolean} the key was used (opened or closed) */
  toggleFromKey() {
    if (this._disposed) return false;
    if (this._open) { this.close(); return true; }
    return this.open();
  }

  /** Opens on the oldest pending piece (or the one shown last, if still pending). @returns {boolean} it is open */
  open() {
    if (this._disposed) return false;
    if (this._open) return true;
    if (!this.canOpen()) return false;
    this._open = true;
    this._build();
    this._rebuild(true);
    if (!this._open) return false;           // nothing left after the read
    this._show(true);
    this._startTimer();
    this._changed(true);
    return true;
  }

  close() {
    if (!this._open) return false;
    this._open = false;
    this._stopTimer();
    this._show(false);
    this._changed(false);
    return true;
  }

  _changed(open) {
    if (!this._onOpenChange) return;
    try { this._onOpenChange(open); } catch (_e) { /* a host never breaks the list */ }
  }

  /** @private `preFocus`: take the rebuild's pre-focus instead of keeping the focus. */
  _rebuild(preFocus) {
    let ps = [];
    try { ps = this._getPieces() || []; } catch (_e) { ps = []; }
    this._pieces = ps.filter((p) => p && p.debris);
    if (!this._pieces.length) { this._model = null; this._pieceId = null; this._focusId = null; this.close(); return; }
    let i = this._pieces.findIndex((p) => p.debris.id === this._pieceId);
    const changed = i < 0;
    if (i < 0) i = 0;
    const entry = this._pieces[i];
    this._pieceId = entry.debris.id;
    let model = null;
    try { model = this._getRows(entry.debris); } catch (_e) { model = null; }
    if (!model || !Array.isArray(model.rows)) model = { name: pieceName(entry.debris), mass: 0, values: [], rows: [], progress: null, maxPayCr: 0, picked: null, berthed: false };
    model = normalizeModel(model);
    this._model = model;
    this._lastBuildMs = this._now();
    const sel = model.choices.concat(model.also);
    const keep = !preFocus && !changed && this._focusId != null && sel.includes(this._focusId);
    if (keep) { /* the focus stays */ } else {
      const picked = model.rows.find((r) => r.current && r.selectable && sel.includes(r.id));
      this._focusId = picked ? picked.id : (sel.length ? sel[0] : null);
    }
    this._paint();
  }

  /** Timer call, about once a second while open: rebuild (focus kept); close when she leaves the floors or the game. */
  tick(nowMs) {
    if (!this.isOpen()) return;
    if ((this._inGameplay && !this._safe(this._inGameplay, true)) || !this._floorOk()) { this.close(); return; }
    const t = Number.isFinite(nowMs) ? nowMs : this._now();
    if (t - this._lastBuildMs < REFRESH_MS) return;
    this._rebuild(false);
  }

  _safe(fn, dflt) { try { return fn(); } catch (_e) { return dflt; } }

  _startTimer() {
    if (!this._poll || this._timer != null || typeof setInterval !== 'function') return;
    this._timer = setInterval(() => this.tick(), REFRESH_MS);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
  }

  _stopTimer() {
    if (this._timer != null && typeof clearInterval === 'function') clearInterval(this._timer);
    this._timer = null;
  }

  /** Show the previous / next pending piece (wraps). @returns {boolean} the piece changed */
  step(dir) {
    if (!this.isOpen() || this._pieces.length < 2) return false;
    const n = this._pieces.length;
    const i = Math.max(0, this.index());
    this._pieceId = this._pieces[(i + (dir < 0 ? -1 : 1) + n) % n].debris.id;
    this._rebuild(true);
    return true;
  }

  /** Focus the next / previous choice, then the "Also" rows (wraps). @returns {boolean} the focus moved */
  focusStep(dir) {
    if (!this.isOpen() || !this._model) return false;
    const sel = this.focusOrder();
    if (!sel.length) return false;
    const i = sel.indexOf(this._focusId);
    this._focusId = sel[i < 0 ? 0 : (i + (dir < 0 ? -1 : 1) + sel.length) % sel.length];
    this._paint();
    return true;
  }

  pickFocused() {
    if (!this.isOpen()) return false;
    const r = this._model && this.focusOrder().includes(this._focusId) && this._model.rows.find((x) => x.id === this._focusId);
    if (!r || !r.selectable) return false;
    return this._pick(r.id);
  }

  /** A tap on row `id`: focus it, or pick it when it already has the focus. Unpickable or unlisted rows ignore it. */
  tapRow(id) {
    if (!this.isOpen() || this._blocked()) return false;
    const r = this._model && this.focusOrder().includes(id) && this._model.rows.find((x) => x.id === id);
    if (!r || !r.selectable) return false;
    if (this._focusId === id) return this._pick(id);
    this._focusId = id;
    this._paint();
    return false;
  }

  /** @private `setFate` first; ONLY when it said true does the executor's event go out, one line is said and the list closes. */
  _pick(fate) {
    const id = this._pieceId;
    if (id == null) return false;
    const name = pieceName((this._pieces.find((p) => p.debris.id === id) || {}).debris);
    const berthed = !!(this._model && this._model.berthed);
    let ok = false;
    try { ok = !!this._setFate(id, fate); } catch (_e) { ok = false; }
    if (!ok) { this._rebuild(false); return false; }      // refused (piece moved on, furnaces have it): fresh rows
    const text = pickLine(fate, name, berthed);
    if (text) this._bus.emit(Events.COMMS_MESSAGE, { source: 'HOUSTON', channel: 'CMD', text, priority: 'info', _keep: true });
    this._bus.emit(Events.BIG_PIECE_FATE, { debrisId: id, fate });     // the executor may dispose of the piece at once: its own line follows ours
    this.close();
    return true;
  }

  /** @param {string} code KeyboardEvent.code @returns {boolean} the key was taken (it must not reach the ladder or the game) */
  handleKey(code, e = {}) {
    if (!this.isOpen() || this._blocked()) return false;
    switch (code) {
      case 'Escape': case 'KeyU': this.close(); return true;
      case 'ArrowLeft': this.step(-1); return true;
      case 'ArrowRight': this.step(1); return true;
      case 'ArrowUp': this.focusStep(-1); return true;
      case 'ArrowDown': this.focusStep(1); return true;
      case 'Tab': this.focusStep(e.shiftKey ? -1 : 1); return true;
      case 'Enter': case 'NumpadEnter': case 'Space': this.pickFocused(); return true;
      default: return false;
    }
  }

  _onWindowKey(e) {
    if (!this.isOpen() || !e) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // A U PRESSED ON THE WINDOW ITSELF (KeyDispatch.pressKey: the CHOOSE button and the ticker chip) reaches this capture
    // listener AFTER InputManager's bubble listener (at the target, listeners run in the order added). InputManager has
    // already toggled the list, so closing it here would undo the tap. A real keystroke runs this listener first and
    // is consumed here: InputManager never sees it.
    if (e.code === 'KeyU' && this._win && e.target === this._win) return;
    if (this.handleKey(e.code, e)) {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      else if (typeof e.stopPropagation === 'function') e.stopPropagation();
    }
  }

  _build() {
    if (this._built) return;
    const doc = this._doc;
    if (!doc || typeof doc.createElement !== 'function') return;
    const parent = this._parent || doc.body;
    if (!parent || typeof parent.appendChild !== 'function') return;
    this._built = true;
    const root = doc.createElement('div');
    root.id = FATE_LIST_ID;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', TITLE_TEXT);
    Object.assign(root.style, {
      position: 'absolute', left: '50%', bottom: `${BOTTOM_PX}px`, transform: 'translateX(-50%)', boxSizing: 'border-box',
      width: `min(${WIDTH_PX}px, calc(100vw - 24px))`, padding: '8px 10px', border: `1px solid ${VisualLaw.COLORS.INFO}`,
      borderRadius: '4px', background: 'rgba(0,16,32,0.95)', color: VisualLaw.COLORS.INFO,
      fontFamily: 'var(--font-mono)', fontSize: '0.8rem', letterSpacing: '0.04em', zIndex: '35',
      pointerEvents: 'auto', display: 'none', maxHeight: MAX_HEIGHT_CSS, overflowY: 'auto', overscrollBehavior: 'contain',
    });
    const stop = (e) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); };
    for (const t of STOPPED_EVENTS) root.addEventListener(t, stop);
    parent.appendChild(root);
    this._root = root;
    this._parentEl = parent;
  }

  _show(on) {
    if (on) this._build();
    if (!this._root) return;
    this._root.style.display = on ? 'block' : 'none';
    this._root.setAttribute('aria-hidden', on ? 'false' : 'true');
  }

  _button(label, px, onTap, act) {
    const el = this._doc.createElement('div');
    el.setAttribute('role', 'button');
    el.setAttribute('data-act', act);
    el.textContent = label;
    Object.assign(el.style, {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box', minWidth: `${px}px`, minHeight: `${px}px`,
      padding: '0 8px', border: `1px solid ${VisualLaw.COLORS.INFO}`, borderRadius: '3px', cursor: 'pointer', userSelect: 'none',
    });
    el.addEventListener('click', (e) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); if (!this._blocked()) onTap(); });
    return el;
  }

  _heldText() {
    const e = this._pieces.find((p) => p.debris.id === this._pieceId);
    if (!e) return '';
    return e.holder === 'collar' ? 'at your nose' : 'on a daughter';
  }

  /** @private repaint; write-on-change by the whole text. */
  _paint() {
    if (!this._root || !this._model) return;
    const doc = this._doc;
    const glass = !!this._glass();
    const px = glass ? ROW_PX_GLASS : ROW_PX_DESKTOP;
    const m = this._model;
    const n = this._pieces.length;
    const at = Math.max(0, this.index());
    const key = JSON.stringify([glass, this._focusId, n, at, this._pieceId, m.name, m.mass, m.progress, m.picked, m.choices, m.also, m.details,
      m.rows.map((r) => [r.id, r.text, r.label, r.money, r.sub, r.selectable, r.current])]);
    if (key === this._paintKey) return;
    this._paintKey = key;
    for (const el of this._rowEls) this._root.removeChild(el);
    this._rowEls = [];
    const add = (el) => { this._root.appendChild(el); this._rowEls.push(el); return el; };

    const head = doc.createElement('div');
    Object.assign(head.style, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' });
    const title = doc.createElement('span');
    title.textContent = TITLE_TEXT;
    Object.assign(title.style, { opacity: '0.85' });
    head.appendChild(title);
    head.appendChild(this._button('\u00d7', px, () => this.close(), 'close'));
    add(head);

    // "1 of 3" with the tabs, then name and where it is held
    const tabs = doc.createElement('div');
    Object.assign(tabs.style, { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px' });
    if (n > 1) tabs.appendChild(this._button('\u25c2', px, () => this.step(-1), 'prev'));
    const count = doc.createElement('span');
    count.textContent = `${at + 1} of ${n}`;
    tabs.appendChild(count);
    if (n > 1) tabs.appendChild(this._button('\u25b8', px, () => this.step(1), 'next'));
    const what = doc.createElement('span');
    what.textContent = `${m.name} ${'\u00b7'} ${Math.round(m.mass).toLocaleString('en-US')} kg ${'\u00b7'} ${this._heldText()}`;
    Object.assign(what.style, { color: VisualLaw.COLORS.SELECTION, marginLeft: '6px' });
    tabs.appendChild(what);
    add(tabs);

    if (m.progress) {
      const pr = doc.createElement('div');
      pr.textContent = m.progress;
      Object.assign(pr.style, { marginTop: '6px', color: VisualLaw.COLORS.CAUTION });
      add(pr);
    }
    const rowOf = (id) => m.rows.find((r) => r.id === id);
    const tap = (id) => (e) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); this.tapRow(id); };
    const base = (r, focused) => {
      const row = doc.createElement('div');
      row.setAttribute('role', 'option');
      row.setAttribute('data-id', r.id);
      row.setAttribute('aria-selected', focused ? 'true' : 'false');
      row.setAttribute('aria-disabled', r.selectable ? 'false' : 'true');
      Object.assign(row.style, {
        boxSizing: 'border-box', minHeight: `${px}px`, marginTop: '2px', borderRadius: '3px', cursor: r.selectable ? 'pointer' : 'default',
        border: `1px solid ${focused ? VisualLaw.COLORS.SELECTION : 'transparent'}`,
        background: focused ? 'rgba(68,136,255,0.18)' : 'transparent', color: VisualLaw.COLORS.INFO,
      });
      row.addEventListener('click', tap(r.id));
      return row;
    };
    const markEl = (focused) => {
      const mark = doc.createElement('span');
      mark.textContent = focused ? MARK : '';
      Object.assign(mark.style, { display: 'inline-block', width: '1.2em', flex: '0 0 auto', color: VisualLaw.COLORS.SELECTION });
      return mark;
    };

    // big choices: number, bold action left, money right, one dim sub-line
    m.choices.forEach((id, i) => {
      const r = rowOf(id);
      if (!r) return;
      const focused = id === this._focusId;
      const row = base(r, focused);
      Object.assign(row.style, { display: 'grid', gridTemplateColumns: '1.2em 1.6em 1fr auto', columnGap: '4px', alignItems: 'center', padding: '4px 6px' });
      const num = doc.createElement('span');
      num.textContent = String(i + 1);
      Object.assign(num.style, { gridColumn: '2', gridRow: '1 / span 2', opacity: '0.7', fontWeight: 'bold', fontSize: '1rem' });
      const label = doc.createElement('span');
      label.textContent = r.current ? `${r.label} (your pick)` : r.label;
      Object.assign(label.style, { gridColumn: '3', gridRow: '1', fontWeight: 'bold', fontSize: '0.95rem' });
      const money = doc.createElement('span');
      money.textContent = r.money;
      Object.assign(money.style, { gridColumn: '4', gridRow: '1', textAlign: 'right', fontWeight: 'bold', fontSize: '0.95rem', whiteSpace: 'nowrap' });
      const sub = doc.createElement('span');
      sub.textContent = r.sub;
      Object.assign(sub.style, { gridColumn: '3 / span 2', gridRow: '2', opacity: '0.6', fontSize: '0.72rem' });
      const mark = markEl(focused);
      Object.assign(mark.style, { gridColumn: '1', gridRow: '1 / span 2' });
      for (const el of [mark, num, label, money, sub]) row.appendChild(el);
      add(row);
    });

    // details: rule, dim label, "Also" rows (pickable), then plain lines (not pickable)
    if (m.also.length || m.details.length) {
      const rule = doc.createElement('div');
      Object.assign(rule.style, { borderTop: `1px solid ${VisualLaw.COLORS.INFO}`, opacity: '0.3', marginTop: '8px' });
      add(rule);
      const tag = doc.createElement('div');
      tag.textContent = 'DETAILS';
      Object.assign(tag.style, { opacity: '0.55', fontSize: '0.68rem', marginTop: '4px' });
      add(tag);
    }
    for (const id of m.also) {
      const r = rowOf(id);
      if (!r) continue;
      const focused = id === this._focusId;
      const row = base(r, focused);
      Object.assign(row.style, { display: 'flex', alignItems: 'center', padding: '2px 6px', fontSize: '0.72rem' });
      const text = doc.createElement('span');
      const lower = r.label.charAt(0).toLowerCase() + r.label.slice(1);
      text.textContent = `Also: ${lower}${r.money ? ` ${'\u00b7'} ${r.money}` : ''}`;
      Object.assign(text.style, { opacity: focused ? '1' : '0.8' });
      row.appendChild(markEl(focused));
      row.appendChild(text);
      add(row);
    }
    for (const t of m.details) {
      const line = doc.createElement('div');
      line.textContent = t;
      Object.assign(line.style, { opacity: '0.6', fontSize: '0.7rem', marginTop: '4px', lineHeight: '1.25' });
      add(line);
    }
    const hint = doc.createElement('div');
    hint.textContent = glass ? HINT_GLASS : HINT_DESKTOP;
    Object.assign(hint.style, { marginTop: '6px', opacity: '0.7', fontSize: '0.7rem' });
    add(hint);
  }

  /** Painted DOM text, one string per element (tests). */
  domText() {
    return this._rowEls.map((el) => {
      const kids = el.children ? Array.from(el.children) : [];
      return kids.length ? kids.map((c) => c.textContent).filter((t) => t !== '').join(' ') : el.textContent;
    }).filter((t) => t !== '');
  }

  get element() { return this._root; }

  dispose() {
    if (this._disposed) return;
    this._stopTimer();
    this._disposed = true;
    for (const u of this._unsubs) { try { u(); } catch (_e) { /* ignore */ } }
    this._unsubs.length = 0;
    if (this._win && typeof this._win.removeEventListener === 'function') this._win.removeEventListener('keydown', this._keyHandler, true);
    if (this._root) {
      if (typeof this._root.remove === 'function') this._root.remove();
      else if (this._parentEl && typeof this._parentEl.removeChild === 'function') this._parentEl.removeChild(this._root);
    }
    this._root = null;
    this._rowEls = [];
  }
}
