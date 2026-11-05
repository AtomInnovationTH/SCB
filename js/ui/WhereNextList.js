/**
 * WhereNextList - the "where next" list on floor 4 (LEO) (DECISIONS §33 rows 6 and 10; FEATURE_FLAGS.FIELDS_BY_HEIGHT).
 * The panel the mission boundary asks "where to?" on: one row per field and a Stay row, the words of
 * js/systems/WhereNextRows.js. It draws at most five destination rows (the best guess first, tagged BEST, the rest
 * cheapest gas first) and a Stay line (`whereNextView`); the model keeps every row for the height scale and the picks.
 * It owns no game state: main.js says when the choice is pending (`setPending`, from `Events.WHERE_NEXT`), NavcomFloor
 * says when floor 4 is the floor she is on (`setFloorShown`, from activate / deactivate), and a pick goes out through
 * `onPick(id)` (GameFlowManager.pickWhereNext). It is OPEN (on screen, taking keys) only while both hold.
 *
 * Input (only while open; nothing pending = every floor-4 key and button as before):
 *   - tap / click a row focuses it; tapping the focused row picks it; a row that cannot be picked ignores taps
 *   - `focusStep(+1 / -1)` (Tab / Shift+Tab, routed by LadderController) moves focus over the rows that can be picked
 *   - `pickFocused()` (Space, routed by LadderController `_dispatchVerb`; the FLY THERE chip's tap is the same Space)
 * Rows are plain <div>s: no <button>, no tabindex, so one Space press cannot also click a focused row.
 *
 * The rows are rebuilt each time the panel opens or is shown again, and about once a second while open; focus stays on
 * the same row while it can still be picked, else it goes to the row the rebuild pre-focuses (the field `defaultNext()`
 * would fly to, else Stay).
 *
 * DOM-guarded (headless-safe): inline styles and only createElement / appendChild / removeChild / setAttribute /
 * textContent / addEventListener, so a tiny fake DOM runs it.
 *
 * @module ui/WhereNextList
 */
import { VisualLaw } from '../core/VisualLaw.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { whereNextView } from '../systems/WhereNextRows.js';
import { jobLineState } from '../systems/JobsBoard.js';

export const WHERE_NEXT_ID = 'where-next-list';
/** Row height on glass (iPad): the 44 px touch target. */
export const ROW_PX_GLASS = 44;
export const ROW_PX_DESKTOP = 28;
export const REFRESH_MS = 1000;
/**
 * Where it sits: bottom centre, its lower edge BOTTOM_PX above the screen's bottom - clear of the FLY THERE chip (88 px
 * up, 48 px high, centred), the transfer readout (bottom left, 400 px wide, to 863 px of a 1024 px screen) and the floor
 * rail (right). The top centre is the vitals, comms, score, pause and next-pane strip (measured at 1366x1024: 0-262 px
 * down).
 */
export const BOTTOM_PX = 164;
export const WIDTH_PX = 580;
/**
 * The panel never grows past the space between the top HUD strip (0-262 px down at 1366x1024) and its own lower edge:
 * more rows than fit scroll inside it.
 */
export const TOP_CLEAR_PX = 280;
export const MAX_HEIGHT_CSS = `calc(100vh - ${BOTTOM_PX + TOP_CLEAR_PX}px)`;
/** Pointer / touch / mouse events that end at the panel: nothing behind it (the map's drag, tap-to-focus, empty-tap scan) sees them. */
export const STOPPED_EVENTS = ['pointerdown', 'pointerup', 'pointermove', 'touchstart', 'touchmove', 'touchend', 'mousedown', 'mouseup', 'click'];
export const TITLE_TEXT = 'Where next?';
export const HINT_DESKTOP = 'Tab: next row \u00b7 Space: go';
export const HINT_GLASS = 'Tap a row, tap it again to go';
/** The tag on the row the game suggests (row 1; it has the focus when the list opens, so one tap or Space goes). */
export const BEST_TAG = 'BEST';

/** The focused row's colour; the height scale's chips on the map read it from here, so the highlight is the same blue. */
export const FOCUS_COLOR = VisualLaw.COLORS.SELECTION;

const MARK = '\u25b8';
const PUSH_PREFIX = 'push:';        // WhereNextRows' `PUSH_PREFIX` (not imported: the list stays free of the rows module)
/**
 * The Routes section's sorts, in the chip's order (RouteCost.SORTS; a test pins that they agree). The planner behind `getRoutes` takes the
 * chosen one; this file never imports it.
 */
export const ROUTE_SORTS = ['credits', 'crPerKg', 'days'];
export const ROUTE_SORT_LABELS = { credits: 'most credits', crPerKg: 'credits per kg gas', days: 'fewest days' };
export const ROUTES_TITLE = 'Routes';
export const ROUTES_EMPTY = 'No priced route from here yet';
export const ROUTES_APPROX = 'approximate';
export const ROUTES_IN_MISSION = 'Routes can be picked when the mission is over';
const _nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class WhereNextList {
  /**
   * @param {object} deps
   * @param {Document|null} [deps.doc]      null = headless
   * @param {function} deps.getRows         () => buildWhereNextRows(...) result: { rows, focusId, selectable, line, job }
   * @param {function} deps.onPick          (id) => boolean: the pick (GameFlowManager.pickWhereNext)
   * @param {function} [deps.glass]         () => true on a touch screen (44 px rows, tap wording)
   * @param {function} [deps.isInputBlocked] () => true when the game would swallow a Space (paused, not gameplay, codex / help / old
   *                                        map open, a ceremony): taps do nothing then, as the FLY THERE chip and Space do
   * @param {function} [deps.onFocus]       (id) => void: the focus moved to row `id` (null = none); the map's height scale
   *                                        (ui/HeightScale.js) keeps its highlighted chip in step with it
   * @param {function} [deps.getRoutes]     (sortBy) => {routes: [{text, numbers, line, firstRowId}], approximate, sortBy, owed}|null: the
   *                                        Routes section (js/systems/RoutePlanner.js `plan`, over GameFlowManager.routePanelState()); it is
   *                                        asked when the rows are rebuilt and when the sort changes. Absent or null = no section.
   * @param {object|null} [deps.bus]        event bus (default the game's; null = listen to nothing). A "push" fate pick
   *                                        (the big-piece fate event) while the list is open focuses that piece's push row
   */
  constructor(deps = {}) {
    this._doc = deps.doc !== undefined ? deps.doc : (typeof document !== 'undefined' ? document : null);
    this._parent = deps.parent || null;
    this._getRows = typeof deps.getRows === 'function' ? deps.getRows : () => ({ rows: [], focusId: null, selectable: [], line: null });
    this._onPick = typeof deps.onPick === 'function' ? deps.onPick : () => false;
    this._glass = typeof deps.glass === 'function' ? deps.glass : () => false;
    this._now = typeof deps.now === 'function' ? deps.now : _nowMs;
    this._blockedFn = typeof deps.isInputBlocked === 'function' ? deps.isInputBlocked : null;
    this._onFocus = typeof deps.onFocus === 'function' ? deps.onFocus : null;
    this._getRoutes = typeof deps.getRoutes === 'function' ? deps.getRoutes : null;
    this._sortBy = ROUTE_SORTS[0];
    this._routes = null;            // the Routes section as last built: {routes, approximate, sortBy, owed} (null = no section)
    this._pending = false;
    this._floorShown = false;       // floor 4 is the floor she is on
    this._model = { rows: [], focusId: null, selectable: [], line: null };
    this._focusId = null;
    this._lastBuildMs = -Infinity;
    this._root = null;
    this._rowEls = [];
    this._built = false;
    this._disposed = false;
    const bus = deps.bus !== undefined ? deps.bus : eventBus;
    this._offFate = bus && typeof bus.on === 'function' ? bus.on(Events.BIG_PIECE_FATE, (e) => this._onFate(e)) : null;
    // The Routes section is computed when the list opens, when the sort changes, and when something that changes a route happens: a catch, a hand-over or
    // disposal, a fate marked, a piece found. Never on the 1 s refresh (pieces drift every second; the search costs 6-100 ms warm, 0.4-1.1 s the first time).
    this._routesDirty = true;
    this._routeAsks = 0;
    const routeEvents = [Events.DEBRIS_CAPTURED, Events.ARM_CAPTURED, Events.BIG_PIECE_FATE, Events.BIG_PIECE_DISPOSED, Events.SCAN_DISCOVERY, Events.TARGET_DISCOVERED];
    this._offRoutes = bus && typeof bus.on === 'function' ? routeEvents.map((ev) => bus.on(ev, () => { this._routesDirty = true; })) : [];
  }

  /**
   * @private The fate list marked a held piece "push": with this list open its row (new, or one that was there) gets the
   * focus; closed or hidden (the fate list is on top), the row waits for the next opening, whose pre-focus is the first
   * push row.
   */
  _onFate(e) {
    if (!e || e.fate !== 'push' || !this.isOpen()) return;
    this._routesDirty = true;
    this._rebuild(false);
    this.focus(`${PUSH_PREFIX}${e.debrisId}`);
  }

  /** The choice is pending (main.js, from Events.WHERE_NEXT). Opening rebuilds the rows and pre-focuses. */
  setPending(on) {
    if (this._disposed) return;
    const was = this.isOpen();
    this._pending = !!on;
    this._routesDirty = true;        // a pick is (again) pending: she has arrived somewhere or a refused pick put the list back
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
    this._routesDirty = true;
    this._sync(was);
  }

  isPending() { return this._pending; }
  isOpen() { return this._pending && this._floorShown && !this._disposed; }

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

  _view() { return whereNextView(this._model, this._focusId); }
  /** The rows as drawn: [{ id, kind, text, state, selectable, focused, best }] (a copy); `text` is the short line the panel shows. */
  rows() {
    const v = this._view();
    return v.rows.map((r) => ({ id: r.id, kind: r.kind, text: r.shortText || r.text, state: r.state, selectable: r.selectable, focused: r.id === this._focusId, best: r.id === v.bestId }));
  }
  bestId() { return this._view().bestId; }
  /** EVERY row as last built, with their numbers (gasKg, days, shortKg, ...), drawn or not: the map's height scale shows
   *  them on its chips (a copy). */
  rowData() { return this._model.rows.map((r) => ({ ...r })); }
  focusedId() { return this._focusId; }
  focusedRow() { return this._model.rows.find((r) => r.id === this._focusId) || null; }
  /** What the FLY THERE chip should say while a pick can be made: 'STAY' on the Stay row, 'CALL' on the call row, 'PUSH' on a
   *  push-down row, 'WAIT' on the wait row (route-1101 lane S2: wait for the station to line up), 'FLY THERE' on a field row, else null. */
  chipLabel() {
    if (!this.isOpen()) return null;
    const r = this.focusedRow();
    if (!r || !r.selectable) return null;
    if (r.kind === 'wait') return 'WAIT';
    return r.kind === 'stay' ? 'STAY' : (r.kind === 'call' ? 'CALL' : (r.kind === 'push' ? 'PUSH' : 'FLY THERE'));
  }

  /** Rebuild the rows from the registry. `preFocus`: take the rebuild's pre-focus instead of keeping the focus. */
  _rebuild(preFocus) {
    let model;
    try { model = this._getRows(); } catch (_e) { model = null; }
    if (!model || !Array.isArray(model.rows)) model = { rows: [], focusId: null, selectable: [], line: null };
    this._model = model;
    this._lastBuildMs = this._now();
    if (this._routesDirty) this._routes = this._askRoutes();         // not on the 1 s refresh: only when the list opened, the sort changed or a route-changing event came
    const keep = !preFocus && this._focusId != null && model.selectable.includes(this._focusId);
    const was = this._focusId;
    this._focusId = keep ? this._focusId : (model.focusId != null ? model.focusId : null);
    this._paint();
    if (this._focusId !== was) this._focused();
  }

  /** About once a second while open: rebuild the rows (focus kept). Called by NavcomFloor.update. */
  tick(nowMs) {
    if (!this.isOpen()) return;
    const t = Number.isFinite(nowMs) ? nowMs : this._now();
    if (t - this._lastBuildMs < REFRESH_MS) return;
    this._rebuild(false);
  }

  /** Move the focus to the next / previous row that can be picked (wraps). @returns {boolean} the focus moved */
  focusStep(dir) {
    if (!this.isOpen()) return false;
    const sel = this._view().rows.filter((r) => r.selectable).map((r) => r.id);          // Tab cycles the rows that are drawn
    if (!sel.length) return false;
    const i = sel.indexOf(this._focusId);
    const next = i < 0 ? 0 : (i + (dir < 0 ? -1 : 1) + sel.length) % sel.length;
    this._focusId = sel[next];
    this._paint();
    this._focused();
    return true;
  }

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
    this._focused();
    return false;
  }

  /**
   * Put the focus on row `id` without picking it (a tap on that row's chip on the map, ui/HeightScale.js). A row that cannot
   * be picked, an unknown id, a closed list or input the game would swallow change nothing. Never a pick: `tapRow` picks a
   * row that already has the focus, this does not.
   * @returns {boolean} the focus is on `id` now
   */
  focus(id) {
    if (!this.isOpen() || this._blocked()) return false;
    const r = this._model.rows.find((x) => x.id === id);
    if (!r || !r.selectable) return false;
    if (this._focusId !== id) {
      this._focusId = id;
      this._paint();
      this._focused();
    }
    return true;
  }

  setOnFocus(fn) { this._onFocus = typeof fn === 'function' ? fn : null; }

  /** @private The Routes section for the current sort (a throwing planner leaves the section out; it never breaks the rows). Counts the asks. */
  _askRoutes() {
    this._routesDirty = false;
    if (!this._getRoutes) return null;
    this._routeAsks++;
    let r = null;
    try { r = this._getRoutes(this._sortBy); } catch (_e) { r = null; }
    return r && Array.isArray(r.routes) ? r : null;
  }

  /** How many times the Routes section was computed (asked of `getRoutes`); the 1 s refresh never adds to it. */
  routeAsks() { return this._routeAsks; }

  /** The sort the Routes section is on now (`ROUTE_SORTS`). */
  sortBy() { return this._sortBy; }

  /** The sort chip: the next sort, the section asked again. @returns {string} the sort now */
  cycleSort() {
    const i = ROUTE_SORTS.indexOf(this._sortBy);
    this._sortBy = ROUTE_SORTS[(i + 1) % ROUTE_SORTS.length];
    if (this.isOpen()) {
      this._routes = this._askRoutes();
      this._paint();
    }
    return this._sortBy;
  }

  /**
   * The Routes section as drawn: [{ i, text, numbers, firstRowId, pickable }] and the chip's words. A route can be picked when the choice
   * is open for a pick (not mid-mission) and the row it begins with can be picked now.
   * @returns {{sortBy: string, sortText: string, approximate: boolean, owed: boolean, routes: Array<object>}|null} null = no section
   */
  routesView() {
    const r = this._routes;
    if (!r) return null;
    const owed = r.owed !== false;
    return {
      sortBy: this._sortBy, sortText: ROUTE_SORT_LABELS[this._sortBy] || this._sortBy, approximate: !!r.approximate, owed,
      routes: r.routes.slice(0, 3).map((x, i) => ({
        i, text: x.text, numbers: x.numbers, firstRowId: x.firstRowId ?? null,
        pickable: owed && x.firstRowId != null && this._model.selectable.includes(x.firstRowId),
      })),
    };
  }

  /**
   * A tap / click on route `i`: the pick of the where-next row it begins with (GameFlowManager.pickWhereNext), the same pick a tap on
   * that row's second tap makes. Nothing happens mid-mission (the list is open only because she is out of gas: field rows cannot be
   * picked then), when that row cannot be picked, or while the game would swallow the key.
   * @returns {boolean} the pick went through
   */
  tapRoute(i) {
    if (!this.isOpen() || this._blocked()) return false;
    const v = this.routesView();
    const r = v && v.routes[i];
    if (!r || !r.pickable) return false;
    return this._pick(r.firstRowId);
  }

  _focused() {
    if (!this._onFocus) return;
    try { this._onFocus(this._focusId); } catch (_e) { /* a listener never breaks the list */ }
  }

  /** @private the game would swallow the key: the same test the chip uses; a throwing getter counts as blocked. */
  _blocked() {
    if (!this._blockedFn) return false;
    try { return !!this._blockedFn(); } catch (_e) { return true; }
  }

  _pick(id) {
    let ok = false;
    try { ok = !!this._onPick(id); } catch (_e) { ok = false; }
    return ok;
  }

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
    const view = this._view();
    const job = this._model.job && this._model.job.text ? this._model.job : null;
    const key = JSON.stringify([glass, this._focusId, view.bestId, view.outLines, this._model.line, job, view.rows.map((r) => [r.id, r.shortText || r.text, r.selectable]), this._routesKey()]);
    if (key === this._paintKey) return;
    this._paintKey = key;
    for (const el of this._rowEls) this._root.removeChild(el);
    this._rowEls = [];
    const add = (el) => { this._root.appendChild(el); this._rowEls.push(el); return el; };
    const title = doc.createElement('div');
    title.textContent = TITLE_TEXT;
    Object.assign(title.style, { color: VisualLaw.COLORS.INFO, marginBottom: '4px', opacity: '0.85' });
    add(title);
    if (job) {      // the jobs board (js/systems/JobsBoard.js): one line under the opening line, not a row (it cannot be picked)
      // several postings (the Vespa bounty and a removal job) come as lines of one text, split at "\n" (JobsBoard.jobLine); each line takes its own
      // state (dim, `data-job`) from its own words (`jobLineState`): a finished bounty must not dim an open removal line. A lone line keeps the
      // model's flags (a model whose text carries no "Done:" / "Missed:" lead).
      const lines = job.text.split('\n').filter((t) => t.length > 0);
      const kindOf = (t) => {
        const own = jobLineState(t);
        return own !== 'wanted' || lines.length > 1 ? own : (job.done ? 'done' : job.missed ? 'missed' : 'wanted');
      };
      const style = (el, kind) => Object.assign(el.style, { color: VisualLaw.COLORS.INFO, marginBottom: '4px', fontSize: '0.75rem', opacity: kind === 'wanted' ? '1' : '0.7' });      // may wrap: the gas and days at its end must stay readable
      const wanted = doc.createElement('div');
      if (lines.length > 1) {
        wanted.setAttribute('data-job-lines', String(lines.length));
        wanted.setAttribute('data-job', kindOf(lines[0]));
        for (const t of lines) {
          const one = doc.createElement('div');
          one.textContent = t;
          const kind = kindOf(t);
          one.setAttribute('data-job', kind);
          style(one, kind);
          wanted.appendChild(one);
        }
        Object.assign(wanted.style, { marginBottom: '4px' });
      } else {
        const kind = kindOf(lines[0] || job.text);
        wanted.textContent = job.text;
        wanted.setAttribute('data-job', kind);
        style(wanted, kind);
      }
      add(wanted);
    }
    for (const r of view.rows) {
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
        color: VisualLaw.COLORS.INFO, opacity: r.selectable ? '1' : '0.55', overflow: 'hidden', whiteSpace: 'nowrap',
      });
      const mark = doc.createElement('span');
      mark.textContent = focused ? MARK : '';
      Object.assign(mark.style, { display: 'inline-block', width: '1.2em', flex: '0 0 auto', color: VisualLaw.COLORS.SELECTION });
      const label = doc.createElement('span');
      label.textContent = r.shortText || r.text;
      Object.assign(label.style, { flex: '1 1 auto', minWidth: '0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });     // one line a row: ellipsis, never a second line
      row.appendChild(mark);
      row.appendChild(label);
      if (r.id === view.bestId) {
        const tag = doc.createElement('span');
        tag.textContent = BEST_TAG;
        tag.setAttribute('data-tag', 'best');
        Object.assign(tag.style, { flex: '0 0 auto', marginLeft: 'auto', paddingLeft: '8px', fontSize: '0.7rem', color: VisualLaw.COLORS.SELECTION });
        row.appendChild(tag);
      }
      if (r.kind === 'stay') row.style.marginTop = '8px';
      row.addEventListener('click', (e) => {
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        this.tapRow(r.id);
      });
      add(row);
    }
    view.outLines.forEach((text, i) => {
      const out = doc.createElement('div');
      out.textContent = text;
      Object.assign(out.style, { marginTop: i === 0 ? '4px' : '1px', opacity: '0.7', fontSize: '0.75rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
      add(out);
    });
    if (this._model.line) {
      const note = doc.createElement('div');
      note.textContent = this._model.line;
      Object.assign(note.style, { marginTop: '4px', color: VisualLaw.COLORS.CAUTION });
      add(note);
    }
    this._paintRoutes(add, doc, glass, rowPx);
    const hint = doc.createElement('div');
    hint.textContent = glass ? HINT_GLASS : HINT_DESKTOP;
    Object.assign(hint.style, { marginTop: '6px', opacity: '0.7', fontSize: '0.7rem' });
    add(hint);
  }

  /** @private what the Routes section draws, for the paint key. */
  _routesKey() {
    const v = this.routesView();
    return v ? [v.sortBy, v.approximate, v.owed, v.routes.map((r) => [r.text, r.numbers, r.pickable])] : null;
  }

  /**
   * @private The Routes section, under the rows: a header (the title, the sort chip, "approximate" when the search was cut short) and
   * up to three routes, each two lines: the stops (wrapping if long), then credits, gas left and days. A route is a plain div like
   * the rows (no button, no tabindex); a tap picks the row it begins with. Mid-mission the routes show and cannot be picked.
   */
  _paintRoutes(add, doc, glass, rowPx) {
    const v = this.routesView();
    if (!v) return;
    const head = doc.createElement('div');
    head.setAttribute('data-routes', 'head');
    Object.assign(head.style, { display: 'flex', alignItems: 'center', marginTop: '8px', color: VisualLaw.COLORS.INFO });
    const title = doc.createElement('span');
    title.textContent = ROUTES_TITLE;
    Object.assign(title.style, { opacity: '0.85', flex: '1 1 auto' });
    head.appendChild(title);
    if (v.approximate) {
      const approx = doc.createElement('span');
      approx.textContent = ROUTES_APPROX;
      approx.setAttribute('data-routes', 'approximate');
      Object.assign(approx.style, { fontSize: '0.7rem', opacity: '0.7', marginRight: '8px' });
      head.appendChild(approx);
    }
    const chip = doc.createElement('div');
    chip.textContent = `${v.sortText} \u25be`;
    chip.setAttribute('data-routes', 'sort');
    chip.setAttribute('role', 'option');
    Object.assign(chip.style, {
      flex: '0 0 auto', boxSizing: 'border-box', minHeight: `${rowPx}px`, display: 'flex', alignItems: 'center', padding: '2px 8px', cursor: 'pointer',
      border: `1px solid ${VisualLaw.COLORS.SELECTION}`, borderRadius: '3px', fontSize: '0.75rem', color: VisualLaw.COLORS.SELECTION,
    });
    chip.addEventListener('click', (e) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); this.cycleSort(); });
    head.appendChild(chip);
    add(head);
    if (!v.routes.length) {
      const none = doc.createElement('div');
      none.textContent = ROUTES_EMPTY;
      none.setAttribute('data-routes', 'none');
      Object.assign(none.style, { marginTop: '2px', opacity: '0.7', fontSize: '0.75rem' });
      add(none);
      return;
    }
    for (const r of v.routes) {
      const row = doc.createElement('div');
      row.setAttribute('role', 'option');
      row.setAttribute('data-route', String(r.i));
      row.setAttribute('aria-disabled', r.pickable ? 'false' : 'true');
      Object.assign(row.style, {
        display: 'flex', flexDirection: 'column', justifyContent: 'center', boxSizing: 'border-box', minHeight: `${rowPx}px`, padding: '2px 6px', marginTop: '2px', borderRadius: '3px',
        cursor: r.pickable ? 'pointer' : 'default', border: '1px solid transparent', color: VisualLaw.COLORS.INFO, fontSize: '0.75rem',
        opacity: r.pickable ? '1' : '0.7', overflow: 'hidden',
      });
      // two lines: the stops (they may wrap onto a second line; the whole text is the title), then the numbers
      const text = doc.createElement('span');
      text.textContent = r.text;
      text.setAttribute('title', r.text);
      Object.assign(text.style, { minWidth: '0', whiteSpace: 'normal', overflow: 'hidden', overflowWrap: 'anywhere' });
      const nums = doc.createElement('span');
      nums.textContent = r.numbers;
      Object.assign(nums.style, { color: VisualLaw.COLORS.SELECTION, whiteSpace: 'nowrap' });
      row.appendChild(text);
      row.appendChild(nums);
      row.addEventListener('click', (e) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); this.tapRoute(r.i); });
      add(row);
    }
    if (!v.owed) {
      const note = doc.createElement('div');
      note.textContent = ROUTES_IN_MISSION;
      note.setAttribute('data-routes', 'mission');
      Object.assign(note.style, { marginTop: '2px', opacity: '0.7', fontSize: '0.7rem' });
      add(note);
    }
  }

  /** The text of the DOM as painted, one string per element (tests). */
  domText() {
    return this._rowEls.map((el) => {
      const kids = el.children ? Array.from(el.children) : [];
      const isTag = (c) => typeof c.getAttribute === 'function' && c.getAttribute('data-tag') === 'best';
      if (kids.length && typeof el.getAttribute === 'function' && el.getAttribute('data-job-lines')) return kids.map((c) => c.textContent).join('\n');      // the board's lines
      return kids.length ? kids.map((c) => (isTag(c) ? ' ' : '') + c.textContent).join('') : el.textContent;
    });
  }

  get element() { return this._root; }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._offFate) { try { this._offFate(); } catch (_e) { /* gone */ } this._offFate = null; }
    for (const off of this._offRoutes) { try { if (typeof off === 'function') off(); } catch (_e) { /* gone */ } }
    this._offRoutes = [];
    if (this._root) {
      if (typeof this._root.remove === 'function') this._root.remove();
      else if (this._parentEl && typeof this._parentEl.removeChild === 'function') this._parentEl.removeChild(this._root);
    }
    this._root = null;
    this._rowEls = [];
  }
}
