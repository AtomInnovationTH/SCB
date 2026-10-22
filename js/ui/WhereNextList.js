/**
 * WhereNextList - the "where next" list on floor 4 (LEO) (Nets step 3 slice 2b, lane 2b-2; plan decision K; DECISIONS §33 rows 6 and
 * 10; FEATURE_FLAGS.FIELDS_BY_HEIGHT). The panel the mission boundary asks "where to?" on: one row per field and a Stay row, the
 * words of js/systems/WhereNextRows.js. It owns no game state: main.js says when the choice is pending (`setPending`, from
 * `Events.WHERE_NEXT`), NavcomFloor says when floor 4 is the floor she is on (`setFloorShown`, from activate / deactivate), and a pick
 * goes out through `onPick(id)` (GameFlowManager.pickWhereNext). It is OPEN (on screen, taking keys) only while both hold.
 *
 * Input (only while open; nothing pending = every floor-4 key and button as before):
 *   - tap / click a row focuses it; tapping the focused row picks it; a row that cannot be picked ignores taps
 *   - `focusStep(+1 / -1)` (Tab / Shift+Tab, routed by LadderController) moves focus over the rows that can be picked
 *   - `pickFocused()` (Space, routed by LadderController `_dispatchVerb`; the FLY THERE chip's tap is the same Space) picks the focus
 * Rows are plain <div>s: no <button>, no tabindex, so one Space press cannot also click a focused row.
 *
 * The rows are rebuilt every time the panel opens or is shown again, and about once a second while open (the gas, her mass and the
 * pieces left change while she waits); focus stays on the same row while it can still be picked, else it goes to the row the rebuild
 * pre-focuses (the field `defaultNext()` would fly to, else Stay).
 *
 * DOM-guarded: with no document nothing is built and every method still answers (headless-safe). Inline styles and only
 * createElement / appendChild / removeChild / setAttribute / textContent / addEventListener, so a tiny fake DOM runs it.
 *
 * @module ui/WhereNextList
 */
import { VisualLaw } from '../core/VisualLaw.js';

export const WHERE_NEXT_ID = 'where-next-list';
/** Row height on glass (iPad): the 44 px touch target. */
export const ROW_PX_GLASS = 44;
/** Row height with a pointer. */
export const ROW_PX_DESKTOP = 28;
/** Real-time interval between rebuilds of the rows while the list is open (ms). */
export const REFRESH_MS = 1000;
/**
 * Where it sits: bottom centre, its lower edge BOTTOM_PX above the screen's bottom - clear of the FLY THERE chip (88 px up, 48 px high,
 * centred), the transfer readout (bottom left, 400 px wide, to 863 px of a 1024 px screen) and the floor rail (right). The top centre
 * is the vitals, comms, score, pause and next-pane strip (measured at 1366x1024: 0-262 px down).
 */
export const BOTTOM_PX = 164;
export const WIDTH_PX = 580;
/**
 * The panel never grows past the space between the top HUD strip (vitals, comms, score, next pane: 0-262 px down at 1366x1024) and
 * its own lower edge: more rows than fit scroll inside it (slice 3 adds rows).
 */
export const TOP_CLEAR_PX = 280;
export const MAX_HEIGHT_CSS = `calc(100vh - ${BOTTOM_PX + TOP_CLEAR_PX}px)`;
/** Pointer / touch / mouse events that end at the panel: nothing behind it (the map's drag, tap-to-focus, empty-tap scan) sees them. */
export const STOPPED_EVENTS = ['pointerdown', 'pointerup', 'pointermove', 'touchstart', 'touchmove', 'touchend', 'mousedown', 'mouseup', 'click'];
export const TITLE_TEXT = 'Where next?';
/** The hint line: keys with a keyboard, taps on glass (read at draw time, as the other glass branches). */
export const HINT_DESKTOP = 'Tab: next row \u00b7 Space: go';
export const HINT_GLASS = 'Tap a row, tap it again to go';

const MARK = '\u25b8';
const _nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class WhereNextList {
  /**
   * @param {object} deps
   * @param {Document|null} [deps.doc]      document (default: the global one; null = headless)
   * @param {Element} [deps.parent]         where the panel goes (default doc.body)
   * @param {function} deps.getRows         () => buildWhereNextRows(...) result: { rows, focusId, selectable, line }
   * @param {function} deps.onPick          (id) => boolean: the pick (GameFlowManager.pickWhereNext)
   * @param {function} [deps.glass]         () => true on a touch screen (44 px rows, tap wording)
   * @param {function} [deps.now]           ms clock (tests)
   * @param {function} [deps.isInputBlocked] () => true when the game would swallow a Space (paused, not gameplay, codex / help / old
   *                                        map open, a ceremony): taps do nothing then, as the FLY THERE chip and Space do
   */
  constructor(deps = {}) {
    this._doc = deps.doc !== undefined ? deps.doc : (typeof document !== 'undefined' ? document : null);
    this._parent = deps.parent || null;
    this._getRows = typeof deps.getRows === 'function' ? deps.getRows : () => ({ rows: [], focusId: null, selectable: [], line: null });
    this._onPick = typeof deps.onPick === 'function' ? deps.onPick : () => false;
    this._glass = typeof deps.glass === 'function' ? deps.glass : () => false;
    this._now = typeof deps.now === 'function' ? deps.now : _nowMs;
    this._blockedFn = typeof deps.isInputBlocked === 'function' ? deps.isInputBlocked : null;
    this._pending = false;          // the choice exists (Events.WHERE_NEXT {open: true})
    this._floorShown = false;       // floor 4 is the floor she is on
    this._model = { rows: [], focusId: null, selectable: [], line: null };
    this._focusId = null;
    this._lastBuildMs = -Infinity;
    this._root = null;
    this._rowEls = [];
    this._built = false;
    this._disposed = false;
  }

  // ── State ──────────────────────────────────────────────────────────────────

  /** The choice is pending (main.js, from Events.WHERE_NEXT). Opening rebuilds the rows and pre-focuses. */
  setPending(on) {
    if (this._disposed) return;
    const was = this.isOpen();
    this._pending = !!on;
    this._sync(was);
  }

  /**
   * Floor 4 is (not) the floor she is on (NavcomFloor.activate / deactivate). Coming back rebuilds the rows and puts the focus on the
   * row the rebuild pre-focuses (the field `defaultNext()` would fly to, else Stay), NOT on the row she had before she left.
   */
  setFloorShown(on) {
    if (this._disposed) return;
    const was = this.isOpen();
    this._floorShown = !!on;
    this._sync(was);
  }

  isPending() { return this._pending; }
  /** On screen and taking input: the choice is pending and floor 4 is the floor she is on. */
  isOpen() { return this._pending && this._floorShown && !this._disposed; }

  /** @private open / close edge: build and show on open, hide on close. */
  _sync(wasOpen) {
    const open = this.isOpen();
    if (open && !wasOpen) {
      this._build();
      this._rebuild(true);
      this._show(true);
    } else if (!open && wasOpen) {
      this._show(false);
    } else if (open && wasOpen) {
      this._rebuild(false);        // a second {open: true} (a refused pick put it back): fresh rows, focus kept where it can be
    }
  }

  // ── Model ──────────────────────────────────────────────────────────────────

  /** The rows as last built: [{ id, kind, text, state, selectable, focused }] (a copy). */
  rows() { return this._model.rows.map((r) => ({ id: r.id, kind: r.kind, text: r.text, state: r.state, selectable: r.selectable, focused: r.id === this._focusId })); }
  focusedId() { return this._focusId; }
  /** The row that is focused, or null. */
  focusedRow() { return this._model.rows.find((r) => r.id === this._focusId) || null; }
  /** What the FLY THERE chip should say while a pick can be made: 'STAY' on the Stay row, 'FLY THERE' on a field row, else null. */
  chipLabel() {
    if (!this.isOpen()) return null;
    const r = this.focusedRow();
    if (!r || !r.selectable) return null;
    return r.kind === 'stay' ? 'STAY' : 'FLY THERE';
  }

  /** Rebuild the rows from the registry. `preFocus`: take the rebuild's pre-focus instead of keeping the focus. */
  _rebuild(preFocus) {
    let model;
    try { model = this._getRows(); } catch (_e) { model = null; }
    if (!model || !Array.isArray(model.rows)) model = { rows: [], focusId: null, selectable: [], line: null };
    this._model = model;
    this._lastBuildMs = this._now();
    const keep = !preFocus && this._focusId != null && model.selectable.includes(this._focusId);
    this._focusId = keep ? this._focusId : (model.focusId != null ? model.focusId : null);
    this._paint();
  }

  /** About once a second while open: rebuild the rows (focus kept). Called by NavcomFloor.update. */
  tick(nowMs) {
    if (!this.isOpen()) return;
    const t = Number.isFinite(nowMs) ? nowMs : this._now();
    if (t - this._lastBuildMs < REFRESH_MS) return;
    this._rebuild(false);
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  /** Move the focus to the next / previous row that can be picked (wraps). @returns {boolean} the focus moved */
  focusStep(dir) {
    if (!this.isOpen()) return false;
    const sel = this._model.selectable;
    if (!sel.length) return false;
    const i = sel.indexOf(this._focusId);
    const next = i < 0 ? 0 : (i + (dir < 0 ? -1 : 1) + sel.length) % sel.length;
    this._focusId = sel[next];
    this._paint();
    return true;
  }

  /** Pick the focused row (Space). @returns {boolean} the pick was made */
  pickFocused() {
    if (!this.isOpen()) return false;
    const r = this.focusedRow();
    if (!r || !r.selectable) return false;
    return this._pick(r.id);
  }

  /** A tap / click on row `id`: focus it, or pick it when it already has the focus. Rows that cannot be picked ignore it. */
  tapRow(id) {
    if (!this.isOpen() || this._blocked()) return false;
    const r = this._model.rows.find((x) => x.id === id);
    if (!r || !r.selectable) return false;
    if (this._focusId === id) return this._pick(id);
    this._focusId = id;
    this._paint();
    return false;
  }

  /** @private the game would swallow the key: the same test the chip uses; a throwing getter counts as blocked. */
  _blocked() {
    if (!this._blockedFn) return false;
    try { return !!this._blockedFn(); } catch (_e) { return true; }
  }

  /** @private */
  _pick(id) {
    let ok = false;
    try { ok = !!this._onPick(id); } catch (_e) { ok = false; }
    return ok;
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
    root.id = WHERE_NEXT_ID;
    root.setAttribute('role', 'listbox');
    root.setAttribute('aria-label', TITLE_TEXT);
    Object.assign(root.style, {
      position: 'absolute', left: '50%', bottom: `${BOTTOM_PX}px`, transform: 'translateX(-50%)', boxSizing: 'border-box',
      width: `min(${WIDTH_PX}px, calc(100vw - 24px))`, padding: '8px 10px', border: `1px solid ${VisualLaw.COLORS.INFO}`,
      borderRadius: '4px', background: 'rgba(0,16,32,0.93)', color: VisualLaw.COLORS.INFO,
      fontFamily: 'var(--font-mono)', fontSize: '0.8rem', letterSpacing: '0.04em', zIndex: '34',
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

  /** @private repaint rows into the root (write-on-change by the whole text). */
  _paint() {
    if (!this._root) return;
    const doc = this._doc;
    const glass = !!this._glass();
    const rowPx = glass ? ROW_PX_GLASS : ROW_PX_DESKTOP;
    const key = JSON.stringify([glass, this._focusId, this._model.rows.map((r) => [r.id, r.text, r.selectable])]);
    if (key === this._paintKey) return;
    this._paintKey = key;
    for (const el of this._rowEls) this._root.removeChild(el);
    this._rowEls = [];
    const add = (el) => { this._root.appendChild(el); this._rowEls.push(el); return el; };
    const title = doc.createElement('div');
    title.textContent = TITLE_TEXT;
    Object.assign(title.style, { color: VisualLaw.COLORS.INFO, marginBottom: '4px', opacity: '0.85' });
    add(title);
    for (const r of this._model.rows) {
      const focused = r.id === this._focusId;
      const row = doc.createElement('div');
      row.setAttribute('role', 'option');
      row.setAttribute('data-id', r.id);
      row.setAttribute('aria-selected', focused ? 'true' : 'false');
      row.setAttribute('aria-disabled', r.selectable ? 'false' : 'true');
      Object.assign(row.style, {
        display: 'flex', alignItems: 'center', boxSizing: 'border-box', minHeight: `${rowPx}px`, padding: '2px 6px',
        marginTop: '2px', borderRadius: '3px', cursor: r.selectable ? 'pointer' : 'default',
        border: `1px solid ${focused ? VisualLaw.COLORS.SELECTION : 'transparent'}`,
        background: focused ? 'rgba(68,136,255,0.18)' : 'transparent',
        color: VisualLaw.COLORS.INFO, opacity: r.selectable ? '1' : '0.55',
      });
      const mark = doc.createElement('span');
      mark.textContent = focused ? MARK : '';
      Object.assign(mark.style, { display: 'inline-block', width: '1.2em', flex: '0 0 auto', color: VisualLaw.COLORS.SELECTION });
      const label = doc.createElement('span');
      label.textContent = r.text;
      row.appendChild(mark);
      row.appendChild(label);
      row.addEventListener('click', (e) => {
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        this.tapRow(r.id);
      });
      add(row);
    }
    if (this._model.line) {
      const note = doc.createElement('div');
      note.textContent = this._model.line;
      Object.assign(note.style, { marginTop: '4px', color: VisualLaw.COLORS.CAUTION });
      add(note);
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
    this._disposed = true;
    if (this._root) {
      if (typeof this._root.remove === 'function') this._root.remove();
      else if (this._parentEl && typeof this._parentEl.removeChild === 'function') this._parentEl.removeChild(this._root);
    }
    this._root = null;
    this._rowEls = [];
  }
}
