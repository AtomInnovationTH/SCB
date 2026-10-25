/**
 * FateList - the fate list: what to do with a big caught piece (Nets step 3 slice 5, lane 5c; plan C6, L2, L3; DECISIONS §33 rows 16-17).
 * A big piece pays when it is disposed of, not at the catch (js/systems/BigPieces.js), so this panel is where she picks the way:
 * hand it to a satellite, push it down, fit a drag sail, keep it aboard, or melt it. Built on the pattern of ui/WhereNextList.js, with
 * its own id, title and hints (WhereNextList.js is not touched).
 *
 * It owns no game state. It reads the pending pieces through `getPieces()` (BigPieces.pendingAboard: oldest catch first) and the words
 * of each through `getRows(piece)` (js/systems/FateRows.js: the values and the five rows from her live numbers). A pick calls
 * `setFate(id, fate)` (GameFlowManager.setFate) and, ONLY when that returned true, emits `Events.BIG_PIECE_FATE {debrisId, fate}` for
 * the executor of that fate, says one plain line and closes. It refreshes on `BIG_PIECE_DISPOSED`, once a second while open, and
 * closes when nothing is left.
 *
 * Opening: U (InputManager calls `toggleFromKey`) on floors 2-4, or the CHOOSE chip on glass (it presses U), only with a big piece
 * aboard. While it is open `onOpenChange(true)` lets the host hide the where-next list (it stays pending and comes back on close).
 *
 * Keys (only while open; a capture listener on the window, so the ladder's arrows and Tab never see them):
 *   Left / Right  the previous / next piece ("1 of 3")        Up / Down / Tab  the previous / next fate row (those that can be picked)
 *   Enter / Space pick the focused row                         Esc / U          close
 * Touch / mouse: a tap on a row focuses it, tapping the focused row picks it; the tabs and the close button are 44 px targets on glass.
 *
 * DOM-guarded: with no document nothing is built and every method still answers (headless-safe); inline styles and only
 * createElement / appendChild / removeChild / setAttribute / textContent / addEventListener, so a tiny fake DOM runs it.
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
/** Row / button height on glass (the 44 px touch target) and with a pointer. */
export const ROW_PX_GLASS = 44;
export const ROW_PX_DESKTOP = 28;
/** Real-time interval between rebuilds while open (ms): the gas, her mass and the stock change while she thinks. */
export const REFRESH_MS = 1000;
/** Where it sits: exactly where the where-next list sits (bottom centre, 164 px up, 580 px wide, never past the top HUD strip). */
export const BOTTOM_PX = 164;
export const WIDTH_PX = 580;
export const TOP_CLEAR_PX = 280;
export const MAX_HEIGHT_CSS = `calc(100vh - ${BOTTOM_PX + TOP_CLEAR_PX}px)`;
export const STOPPED_EVENTS = ['pointerdown', 'pointerup', 'pointermove', 'touchstart', 'touchmove', 'touchend', 'mousedown', 'mouseup', 'click'];
export const HINT_DESKTOP = '\u2190 \u2192 other piece \u00b7 \u2191 \u2193 row \u00b7 Enter: choose \u00b7 U: close';
export const HINT_GLASS = 'Tap a row, tap it again to choose';
/** The floors the list opens on (the ladder's floors 2-4); no ladder (no floor number) opens anywhere. */
export const FLOORS = Object.freeze([2, 3, 4]);

const MARK = '\u25b8';
const _nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const FLOOR4 = (FloorContract.byId(4) || { name: 'map' }).name;

/** The one line a pick says (the executor of the fate says the rest when it acts). @param {string} fate @param {string} name @param {boolean} berthed */
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
   * @param {Document|null} [deps.doc]       document (default the global one; null = headless)
   * @param {Element} [deps.parent]          where the panel goes (default doc.body)
   * @param {object} [deps.win]              where the key listener goes (default the global window)
   * @param {object} [deps.bus]              event bus (default the game's)
   * @param {function} deps.getPieces        () => [{debris, holder, fate}] (BigPieces.pendingAboard)
   * @param {function} deps.getRows          (debris) => buildFateRows result
   * @param {function} deps.setFate          (id, fate) => boolean (GameFlowManager.setFate)
   * @param {function} [deps.glass]          () => true on a touch screen (44 px targets, tap wording)
   * @param {function} [deps.isInputBlocked] () => true when the game would swallow the key (paused, not gameplay, codex / help open)
   * @param {function} [deps.getFloor]       () => the ladder's floor number, or null (no ladder)
   * @param {function} [deps.inGameplay]     () => false closes the list (a menu, the shop)
   * @param {function} [deps.onOpenChange]   (open) => void (the host hides / returns the where-next list)
   * @param {function} [deps.now]            ms clock (tests)
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

  // ── State ──────────────────────────────────────────────────────────────────

  isOpen() { return this._open && !this._disposed; }

  /** The pending pieces as last read: [{id, name, holder, fate}] (a copy). */
  pieces() { return this._pieces.map((p) => ({ id: p.debris.id, name: pieceName(p.debris), holder: p.holder, fate: p.fate })); }
  /** 0-based index of the shown piece, or -1. */
  index() { return this._pieces.findIndex((p) => p.debris.id === this._pieceId); }
  /** The shown piece's id, or null. */
  pieceId() { return this._pieceId; }
  /** The shown piece's rows as built: [{id, text, selectable, state, current, focused}] (a copy). */
  rows() { return this._model ? this._model.rows.map((r) => ({ ...r, focused: r.id === this._focusId })) : []; }
  /** The shown piece's whole model (values, progress, picked), or null. */
  model() { return this._model; }
  focusedId() { return this._focusId; }

  /** @private the ladder's floor allows the list (floors 2-4; no ladder = any). */
  _floorOk() {
    if (!this._getFloor) return true;
    let f = null;
    try { f = this._getFloor(); } catch (_e) { f = null; }
    return f == null || FLOORS.includes(f);
  }

  /** @private the game would swallow the key; a throwing getter counts as blocked. */
  _blocked() {
    if (!this._blockedFn) return false;
    try { return !!this._blockedFn(); } catch (_e) { return true; }
  }

  /** Is there something to choose for, and may the list open now (a big piece aboard, floors 2-4, not blocked)? */
  canOpen() {
    if (this._disposed || this._blocked() || !this._floorOk()) return false;
    let ps = [];
    try { ps = this._getPieces() || []; } catch (_e) { ps = []; }
    return ps.length > 0;
  }

  /** The U key: opens when it can, closes when open. @returns {boolean} the key was used (opened or closed) */
  toggleFromKey() {
    if (this._disposed) return false;
    if (this._open) { this.close(); return true; }
    return this.open();
  }

  /** Open on the oldest pending piece (or the one shown last, if still pending). @returns {boolean} it is open */
  open() {
    if (this._disposed) return false;
    if (this._open) return true;
    if (!this.canOpen()) return false;
    this._open = true;
    this._build();
    this._rebuild(true);
    if (!this._open) return false;           // (nothing left after the read)
    this._show(true);
    this._startTimer();
    this._changed(true);
    return true;
  }

  /** Close (nothing is picked). */
  close() {
    if (!this._open) return false;
    this._open = false;
    this._stopTimer();
    this._show(false);
    this._changed(false);
    return true;
  }

  /** @private tell the host the open state moved. */
  _changed(open) {
    if (!this._onOpenChange) return;
    try { this._onOpenChange(open); } catch (_e) { /* a host never breaks the list */ }
  }

  // ── Model ──────────────────────────────────────────────────────────────────

  /** @private read the pieces and the shown piece's rows; `preFocus`: take the rebuild's pre-focus instead of keeping the focus. */
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
    this._model = model;
    this._lastBuildMs = this._now();
    const sel = model.rows.filter((r) => r.selectable).map((r) => r.id);
    const keep = !preFocus && !changed && this._focusId != null && sel.includes(this._focusId);
    if (keep) { /* the focus stays */ } else {
      const picked = model.rows.find((r) => r.current && r.selectable);
      this._focusId = picked ? picked.id : (sel.length ? sel[0] : null);
    }
    this._paint();
  }

  /** About once a second while open: rebuild (focus kept), and close when she leaves the floors or the game. Called by the timer. */
  tick(nowMs) {
    if (!this.isOpen()) return;
    if ((this._inGameplay && !this._safe(this._inGameplay, true)) || !this._floorOk()) { this.close(); return; }
    const t = Number.isFinite(nowMs) ? nowMs : this._now();
    if (t - this._lastBuildMs < REFRESH_MS) return;
    this._rebuild(false);
  }

  /** @private */
  _safe(fn, dflt) { try { return fn(); } catch (_e) { return dflt; } }

  /** @private */
  _startTimer() {
    if (!this._poll || this._timer != null || typeof setInterval !== 'function') return;
    this._timer = setInterval(() => this.tick(), REFRESH_MS);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
  }

  /** @private */
  _stopTimer() {
    if (this._timer != null && typeof clearInterval === 'function') clearInterval(this._timer);
    this._timer = null;
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  /** Show the previous / next pending piece (wraps). @returns {boolean} the piece changed */
  step(dir) {
    if (!this.isOpen() || this._pieces.length < 2) return false;
    const n = this._pieces.length;
    const i = Math.max(0, this.index());
    this._pieceId = this._pieces[(i + (dir < 0 ? -1 : 1) + n) % n].debris.id;
    this._rebuild(true);
    return true;
  }

  /** Move the focus to the next / previous row that can be picked (wraps). @returns {boolean} the focus moved */
  focusStep(dir) {
    if (!this.isOpen() || !this._model) return false;
    const sel = this._model.rows.filter((r) => r.selectable).map((r) => r.id);
    if (!sel.length) return false;
    const i = sel.indexOf(this._focusId);
    this._focusId = sel[i < 0 ? 0 : (i + (dir < 0 ? -1 : 1) + sel.length) % sel.length];
    this._paint();
    return true;
  }

  /** Pick the focused row (Enter). @returns {boolean} the pick was made */
  pickFocused() {
    if (!this.isOpen()) return false;
    const r = this._model && this._model.rows.find((x) => x.id === this._focusId);
    if (!r || !r.selectable) return false;
    return this._pick(r.id);
  }

  /** A tap / click on row `id`: focus it, or pick it when it already has the focus. Rows that cannot be picked ignore it. */
  tapRow(id) {
    if (!this.isOpen() || this._blocked()) return false;
    const r = this._model && this._model.rows.find((x) => x.id === id);
    if (!r || !r.selectable) return false;
    if (this._focusId === id) return this._pick(id);
    this._focusId = id;
    this._paint();
    return false;
  }

  /**
   * The pick: `setFate` first; ONLY when it said true does the executor's event go out, one line is said and the list closes.
   * @private @param {string} fate @returns {boolean}
   */
  _pick(fate) {
    const id = this._pieceId;
    if (id == null) return false;
    const name = pieceName((this._pieces.find((p) => p.debris.id === id) || {}).debris);
    const berthed = !!(this._model && this._model.berthed);
    let ok = false;
    try { ok = !!this._setFate(id, fate); } catch (_e) { ok = false; }
    if (!ok) { this._rebuild(false); return false; }      // refused (the piece moved on, the furnaces have it): fresh rows
    const text = pickLine(fate, name, berthed);
    if (text) this._bus.emit(Events.COMMS_MESSAGE, { source: 'HOUSTON', channel: 'CMD', text, priority: 'info', _keep: true });
    this._bus.emit(Events.BIG_PIECE_FATE, { debrisId: id, fate });     // (the executor may dispose of the piece at once: its own line follows ours)
    this.close();
    return true;
  }

  /**
   * One key while open. @param {string} code KeyboardEvent.code @param {{shiftKey?: boolean}} [e]
   * @returns {boolean} the key was taken (the caller stops it reaching the ladder and the game)
   */
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

  /** @private the window's capture listener: a taken key goes no further. */
  _onWindowKey(e) {
    if (!this.isOpen() || !e) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (this.handleKey(e.code, e)) {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      else if (typeof e.stopPropagation === 'function') e.stopPropagation();
    }
  }

  // ── DOM ────────────────────────────────────────────────────────────────────

  /** @private build the root once (hidden). */
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

  /** @private */
  _show(on) {
    if (on) this._build();
    if (!this._root) return;
    this._root.style.display = on ? 'block' : 'none';
    this._root.setAttribute('aria-hidden', on ? 'false' : 'true');
  }

  /** @private a 44 px (glass) / 28 px button: a plain div that takes taps. */
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

  /** @private where the shown piece is held, in words. */
  _heldText() {
    const e = this._pieces.find((p) => p.debris.id === this._pieceId);
    if (!e) return '';
    return e.holder === 'collar' ? 'at your nose' : 'on a daughter';
  }

  /** @private repaint into the root (write-on-change by the whole text). */
  _paint() {
    if (!this._root || !this._model) return;
    const doc = this._doc;
    const glass = !!this._glass();
    const px = glass ? ROW_PX_GLASS : ROW_PX_DESKTOP;
    const m = this._model;
    const n = this._pieces.length;
    const at = Math.max(0, this.index());
    const key = JSON.stringify([glass, this._focusId, n, at, this._pieceId, m.name, m.mass, m.values, m.progress, m.picked, m.rows.map((r) => [r.id, r.text, r.selectable, r.current])]);
    if (key === this._paintKey) return;
    this._paintKey = key;
    for (const el of this._rowEls) this._root.removeChild(el);
    this._rowEls = [];
    const add = (el) => { this._root.appendChild(el); this._rowEls.push(el); return el; };

    // head: title and the close button
    const head = doc.createElement('div');
    Object.assign(head.style, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' });
    const title = doc.createElement('span');
    title.textContent = TITLE_TEXT;
    Object.assign(title.style, { opacity: '0.85' });
    head.appendChild(title);
    head.appendChild(this._button('\u00d7', px, () => this.close(), 'close'));
    add(head);

    // the piece: "1 of 3" with the tabs, then its name and where it is held
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

    // what it is worth
    for (const v of m.values) {
      const line = doc.createElement('div');
      line.textContent = v;
      Object.assign(line.style, { opacity: '0.8', fontSize: '0.72rem' });
      add(line);
    }

    if (m.progress) {
      const pr = doc.createElement('div');
      pr.textContent = m.progress;
      Object.assign(pr.style, { marginTop: '6px', color: VisualLaw.COLORS.CAUTION });
      add(pr);
    }
    for (const r of m.rows) {
      const focused = r.id === this._focusId;
      const row = doc.createElement('div');
      row.setAttribute('role', 'option');
      row.setAttribute('data-id', r.id);
      row.setAttribute('aria-selected', focused ? 'true' : 'false');
      row.setAttribute('aria-disabled', r.selectable ? 'false' : 'true');
      Object.assign(row.style, {
        display: 'flex', alignItems: 'center', boxSizing: 'border-box', minHeight: `${px}px`, padding: '2px 6px',
        marginTop: '2px', borderRadius: '3px', cursor: r.selectable ? 'pointer' : 'default',
        border: `1px solid ${focused ? VisualLaw.COLORS.SELECTION : 'transparent'}`,
        background: focused ? 'rgba(68,136,255,0.18)' : 'transparent',
        color: VisualLaw.COLORS.INFO, opacity: r.selectable ? '1' : '0.55',
      });
      const mark = doc.createElement('span');
      mark.textContent = focused ? MARK : '';
      Object.assign(mark.style, { display: 'inline-block', width: '1.2em', flex: '0 0 auto', color: VisualLaw.COLORS.SELECTION });
      const label = doc.createElement('span');
      label.textContent = r.current ? `${r.text} (your pick)` : r.text;
      row.appendChild(mark);
      row.appendChild(label);
      row.addEventListener('click', (e) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); this.tapRow(r.id); });
      add(row);
    }
    const hint = doc.createElement('div');
    hint.textContent = glass ? HINT_GLASS : HINT_DESKTOP;
    Object.assign(hint.style, { marginTop: '6px', opacity: '0.7', fontSize: '0.7rem' });
    add(hint);
  }

  /** The text of the DOM as painted, one string per element (tests). */
  domText() {
    return this._rowEls.map((el) => {
      const kids = el.children ? Array.from(el.children) : [];
      return kids.length ? kids.map((c) => c.textContent).join('') : el.textContent;
    });
  }

  /** The panel's root element (tests / layout probes), or null. */
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
