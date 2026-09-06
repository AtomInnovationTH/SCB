/**
 * PaneRail.js — the left WHAT rail (plan D-H; Session J item 1).
 *
 * The right rail (RailIndicator) answers WHERE — which floor. This rail
 * answers WHAT — which panes this floor allows: one notch per pane-density
 * rung, LIT when the pane is shown, DIM when hidden (the "there's more" hint),
 * a hotkey suffix on the notches a keyboard can also flip (`TARGET PANE ·0`),
 * and a tap that toggles the pane instantly through the rung's own
 * `setVisible` — the ONE visibility bit every party already composes on
 * (FloorMask T8). It is the glass replacement for the density slider and the
 * LIBRARY chip; the `-` / `+` keys still walk PaneDensity's ladder and the hub
 * animates the affected notch here (`flash`).
 *
 * THE HEIGHT RULE (plan: "12 today + first-wave panes would be ~16 × 40 pt =
 * too tall for an 11" iPad"): `populate(floor)` lists only this floor's
 * room-default panes (FloorMask tier 'shown' or 'faint' — injected as a
 * `roomTiers(floor)` getter, never imported) PLUS any rung that is visible
 * right now, at most RAIL_GEOMETRY.MAX_NOTCHES (8; room defaults outrank
 * visible extras when the cap bites, rung order inside each group). Every
 * other rung sits behind ONE `MORE` notch at the top of the stack; a tap on
 * it expands them (dim, since they are hidden by definition), a second tap
 * folds them. A null room (no tiers for the floor, or no getter) lists every
 * rung up to the cap + MORE. A rest rung that becomes visible out of band
 * (the `+` key, a pane's own key) is PROMOTED into the list on the next
 * refresh so a shown pane always has a lit notch.
 *
 * GEOMETRY (RailGeometry — shared with the WHERE rail so the two never
 * drift): mid-height on the LEFT edge, clear of the bottom ~100 pt thumb
 * rest; 40 px notches; a tap is a pointerdown→pointerup pair on the SAME notch
 * within SLOP_PX (44) — a drag across notches does nothing; idle fade to
 * IDLE_FADE (0.35) after IDLE_FADE_MS (4 s) without interaction, any tap /
 * hover / populate wakes it (RefitPane's _armIdleTimer pattern). Column-
 * reverse like the WHERE rail: the first notch sits at the BOTTOM, the HEAD
 * cap (`WHAT`) at the top. Long-press (>= LONG_PRESS_MS) on the head =
 * RESET ROOM (`onResetRoom(floor)` — the hub maps it to the mask); a short
 * press on the head does nothing.
 *
 * PATTERNS (the RailIndicator law): lazy `_build()`, inline CSS strings, one
 * injected <style> for the CSS-only bits (dim opacity, the desktop hover peek
 * +15 %, the flash), per-notch records, write-on-change paints, `show/hide`.
 * NO event-bus / Events import — every side effect goes through an injected
 * dep and every dep is optional. Headless-INERT: constructible and every
 * method callable with no `document`; no timer is ever allocated unless the
 * DOM exists (timers are armed only from DOM event handlers and from
 * show/populate once a root exists).
 *
 * @module ui/PaneRail
 */

import { VisualLaw } from '../core/VisualLaw.js';
import { RAIL_GEOMETRY, midHeightCss, dodgeTop } from './RailGeometry.js';

// ── Tunables (own-module exports; the house rule) ───────────────────────────

/** The `-`/`+` notch flash (ms) — RailIndicator's DENY_FLASH_MS: one-shot ≪ 3 Hz. */
export const FLASH_MS = 320;
/** Head long-press threshold (ms) — the RESET ROOM gesture. */
export const LONG_PRESS_MS = 600;
/** A hidden pane's notch opacity (CSS, via data-lit="0") — the "there's more" hint. */
export const NOTCH_DIM_OPACITY = 0.35;
/** Desktop hover lifts a dim notch by this much (CSS only — the peek). */
export const HOVER_PEEK = 0.15;
/**
 * The per-frame refresh throttle. Review fix (Session J): 1000 ms, not 250 —
 * every scan asks each rung's `isVisible()`, and the HUD's dom rungs answer
 * with `getClientRects()` (a forced layout read); at 4 Hz that was ~50 layout
 * reads/s inside the rAF loop for a state that changes at event rate. The
 * per-frame poll now only catches the bits no event announces (a view-config
 * toggle, the pin widget's goal-less collapse); every announced change — the
 * HUD_PANE_VISIBILITY edge (the 0/9/8 keys, `-`/`+`, the rail's own tap) and
 * the floor arrival (`populate`) — repaints at once through `force`.
 */
export const REFRESH_MIN_MS = 1000;
/** The MORE notch's pane id (never a rung id). */
export const MORE_ID = '__more';
/** The injected stylesheet's element id. */
export const STYLE_ID = 'pane-rail-style';
/** Root element id. */
export const ROOT_ID = 'ladder-pane-rail';
/** The HUD column on the WHAT rail's side — what the dodge measures (HUD.js's left stack). */
export const SIDE_COLUMN_ID = 'hud-left-column';
/** Fade transition for the root opacity (ms) — the WHERE rail's 0.3 s. */
const ROOT_FADE_MS = 300;

/**
 * Default hotkey suffix table: rung id → the InputManager digit that toggles
 * that pane (0 Target pane · 9 Debris pane · 8 Nav orb · 7 Comms · 5 City
 * names). Rendered as `LABEL ·0`. Injectable (`deps.hotkeys`) — the table is
 * data, never a key binding: the rail never listens for keys.
 */
export const DEFAULT_HOTKEYS = Object.freeze({
  targets: '0', debris: '9', navsphere: '8', comms: '7', skylabels: '5',
});

/** Notch palette (INFO instrument frame — the rail reads as a CONTROL). */
const NOTCH_REST_BORDER = 'rgba(0,204,255,0.35)';
const NOTCH_REST_COLOR = 'rgba(0,204,255,0.62)';
const NOTCH_LIT_BORDER = 'rgba(0,204,255,0.7)';
const NOTCH_LIT_COLOR = 'rgba(0,204,255,0.95)';
/** The flash halo — PLAYER green (#00ff88 = 0,255,136), one-shot, steady while it lasts. */
export const FLASH_HALO = '0 0 8px rgba(0,255,136,0.55)';

/** Monotonic ms clock (DOM-guarded module — Date.now fallback headless). */
const _nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** House reduced-motion probe (the FloorMask / RefitPane shape). */
function _prefersReducedMotion() {
  try {
    return !!(typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (_e) {
    return false;
  }
}

/** Defensive isVisible() — a throwing/absent adapter reads as hidden (PaneDensity._safeVisible). */
function _safeVisible(rung) {
  try { return !!(rung && typeof rung.isVisible === 'function' && rung.isVisible()); } catch (_e) { return false; }
}

export class PaneRail {
  /**
   * @param {object} [deps] — every dep optional; absent deps = state-only no-ops.
   * @param {() => Array<{id:string,label:string,isVisible:function,setVisible:function}>} [deps.rungs]
   *   LIVE getter for the pane-density rungs (the hub: `() => hud.paneDensity.rungs`).
   * @param {(floor:number|null) => (Object<string,'shown'|'faint'|'gone'>|null)} [deps.roomTiers]
   *   The floor's default room row (the hub: FloorMask DEFAULT_ROOMS[floor] || null).
   *   Pane ids that are not rung ids (reticles, hints) are ignored; null = no room.
   * @param {(paneId:string, shown:boolean) => void} [deps.onFlip]
   *   Called AFTER a tap flipped the rung (the hub emits HUD_PANE_VISIBILITY → room memory).
   * @param {(floor:number|null) => void} [deps.onResetRoom]
   *   Called on a head long-press (the hub: floorMask.resetRoom(floor)).
   * @param {Object<string,string>} [deps.hotkeys] rung id → digit suffix (DEFAULT_HOTKEYS).
   * @param {Document|null} [deps.doc] document (default: the global one; null = headless).
   * @param {() => number} [deps.now] ms clock (default performance.now).
   * @param {{setTimeout:function, clearTimeout:function}} [deps.timer] timer pair (default globals).
   * @param {boolean|function} [deps.reducedMotion] override for the matchMedia probe.
   */
  constructor(deps = {}) {
    this._rungsFn = typeof deps.rungs === 'function' ? deps.rungs : null;
    this._roomTiers = typeof deps.roomTiers === 'function' ? deps.roomTiers : null;
    this._onFlip = typeof deps.onFlip === 'function' ? deps.onFlip : null;
    this._onResetRoom = typeof deps.onResetRoom === 'function' ? deps.onResetRoom : null;
    this._hotkeys = (deps.hotkeys && typeof deps.hotkeys === 'object') ? deps.hotkeys : DEFAULT_HOTKEYS;
    this._doc = deps.doc !== undefined ? deps.doc
      : (typeof document !== 'undefined' ? document : null);
    this._now = typeof deps.now === 'function' ? deps.now : _nowMs;
    this._timer = deps.timer || null;
    this._reducedMotionDep = deps.reducedMotion;
    /**
     * GLASS (owner 2026-09-06, the touchable law): true → every notch is a
     * TOUCH_PITCH_PX (44 pt, HIG) hit box with the compact plate centred in it
     * and the boxes tile gap-less; false (default, desktop) → the tight
     * 5 px-gap rows. main.js passes TouchControls.detectGlass().
     */
    this._glass = !!deps.glass;

    this._built = false;
    this._disposed = false;
    this._root = null;
    this._stack = null;          // the notch column (rebuilt per populate)
    this._head = null;           // the WHAT cap (long-press target)
    this._more = null;           // { el, label } while a MORE notch exists
    /** @type {Array<{id:string, rung:object, el:object, label:object, key:object, rest:boolean, lit:(boolean|null), flashing:boolean, flashTimer:*}>} */
    this._notches = [];
    this._visible = false;
    this._floor = null;
    this._expanded = false;
    this._plan = { listed: [], rest: [] };
    this._planKey = null;
    this._lastScanMs = -Infinity;
    /** @private the dodge's last applied top (null = mid-height) — write-on-change */
    this._dodgeTop = null;
    /** @private Session L: the root's RIGHT edge (CSS px) from the dodge's 1 Hz read; null unmeasured (rightPx) */
    this._railRight = null;
    // Idle fade (RefitPane pattern): activity clock, flag, timer.
    this._lastActivityMs = this._now();
    this._idle = false;
    this._idleTimer = null;
    this._opacity = null;        // last root opacity WRITTEN (write-on-change)
    // Pointer press bookkeeping (tap = down→up on the same notch within SLOP_PX).
    this._press = null;          // { rec, x, y, head, consumed }
    this._longPressTimer = null;
    this._headFlashTimer = null;
  }

  // ── Pure laws (headless-testable) ───────────────────────────────────────────

  /**
   * THE HEIGHT RULE. From the live rungs and a floor's room row, which rung
   * ids are LISTED (in rung order) and which sit behind MORE (rung order).
   *   room null  → every rung is a candidate.
   *   room given → a rung whose tier is 'shown' or 'faint' is a candidate
   *                (rank 0), else it is a candidate only while visible (rank 1).
   *   cap        → when candidates exceed `max`, room defaults outrank visible
   *                extras, rung order inside each rank; the overflow joins the rest.
   * Pure: never touches the DOM; `isVisible()` is read defensively.
   * @param {Array<{id:string,isVisible?:function}>} rungs
   * @param {Object<string,string>|null} room
   * @param {number} [max=RAIL_GEOMETRY.MAX_NOTCHES]
   * @returns {{listed:string[], rest:string[]}}
   */
  static planNotches(rungs, room, max = RAIL_GEOMETRY.MAX_NOTCHES) {
    const list = Array.isArray(rungs) ? rungs.filter((r) => r && typeof r.id === 'string') : [];
    const cap = Math.max(0, Number.isFinite(max) ? Math.floor(max) : RAIL_GEOMETRY.MAX_NOTCHES);
    const hasRoom = !!room && typeof room === 'object';
    const cands = [];
    list.forEach((r, idx) => {
      if (!hasRoom) { cands.push({ id: r.id, rank: 0, idx }); return; }
      const tier = room[r.id];
      if (tier === 'shown' || tier === 'faint') cands.push({ id: r.id, rank: 0, idx });
      else if (_safeVisible(r)) cands.push({ id: r.id, rank: 1, idx });
    });
    let keep = cands;
    if (cands.length > cap) {
      keep = cands.slice().sort((a, b) => (a.rank - b.rank) || (a.idx - b.idx)).slice(0, cap);
    }
    const keepSet = new Set(keep.map((c) => c.id));
    const listed = [];
    const rest = [];
    for (const r of list) (keepSet.has(r.id) ? listed : rest).push(r.id);
    return { listed, rest };
  }

  /**
   * Notch text law: the rung label UPPERCASE with a trailing " PANE" dropped
   * (owner, 2026-09-06: the WHAT rail wears the WHERE rail's compact rows —
   * `TARGET ·0` beside a floor row, not `TARGET PANE ·0`; every notch on this
   * rail IS a pane, the word carried nothing), plus the hotkey suffix glyph
   * (` ·0` — a middle dot then the digit) when the table maps this id.
   * @param {string} label @param {string|undefined|null} key
   * @returns {{text:string, key:string}} key = '' when unmapped
   */
  static notchLabel(label, key) {
    const text = String(label == null ? '' : label).toUpperCase().replace(/\s+PANE$/, '');
    const k = (typeof key === 'string' && key.length) ? `\u00b7${key}` : '';
    return { text, key: k };
  }

  /**
   * Notch paint law: what a notch wears for a state.
   *   flashing → PLAYER border + label + FLASH_HALO (the `-`/`+` pulse; wins while it lasts)
   *   lit      → the bright INFO frame (the pane is shown)
   *   dim      → the INFO resting frame (opacity comes from the stylesheet via data-lit)
   * @param {{lit:boolean, flashing?:boolean}} flags
   * @returns {{borderColor:string, color:string, boxShadow:string}}
   */
  static notchPaint({ lit, flashing = false }) {
    if (flashing) return { borderColor: VisualLaw.COLORS.PLAYER, color: VisualLaw.COLORS.PLAYER, boxShadow: FLASH_HALO };
    if (lit) return { borderColor: NOTCH_LIT_BORDER, color: NOTCH_LIT_COLOR, boxShadow: 'none' };
    return { borderColor: NOTCH_REST_BORDER, color: NOTCH_REST_COLOR, boxShadow: 'none' };
  }

  /**
   * Tap law: a pointerdown→pointerup pair is a TAP when it stayed within
   * RAIL_GEOMETRY.SLOP_PX (Euclidean) — anything further is a drag.
   * @param {number} dx @param {number} dy
   * @returns {boolean}
   */
  static isTap(dx, dy) {
    const x = Number(dx) || 0;
    const y = Number(dy) || 0;
    return Math.hypot(x, y) <= RAIL_GEOMETRY.SLOP_PX;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Show the rail (builds on first show; wakes the idle fade). */
  show() {
    if (this._disposed) return;
    this._build();
    this._visible = true;
    this._applyOpacity();
    this._wake();
  }

  /** Hide the rail (clears every pending timer and press). */
  hide() {
    this._visible = false;
    this._clearTimers();
    this._press = null;
    this._applyOpacity();
  }

  /** @returns {boolean} true while shown (independent of the idle fade). */
  isVisible() { return this._visible; }

  /** @returns {object|null} the root element (null headless / before build / after dispose). */
  element() { return this._root; }

  /** @returns {number|null} the floor the rail was last populated for. */
  floor() { return this._floor; }

  /**
   * Session L (Session K FINDINGS (a)): the rail's RIGHT edge in CSS px
   * wherever it sits — dodged or mid-height — else null while hidden / no
   * DOM / unmeasured. The hub feeds it to MotherCallouts.setRailInsets so the
   * hull callouts' left column starts right of the rail instead of under it.
   * Recorded by the 1 Hz dodge read from the SAME root rect that gives railH;
   * no layout read of its own.
   * @returns {number|null}
   */
  rightPx() { return this._visible ? this._railRight : null; }

  /**
   * Re-plan the rail for `floor` (the hub calls this at every ride start and
   * on engage): the floor's room row via `roomTiers(floor)`, the live rungs,
   * the height rule, collapsed MORE, every notch painted from live
   * `isVisible()`. Wakes the idle fade. Headless: the plan is kept as state
   * (notchIds()/notchCount() answer), no DOM, no timers.
   * @param {number|null} floor
   */
  populate(floor) {
    if (this._disposed) return;
    this._floor = (typeof floor === 'number' && Number.isFinite(floor)) ? floor : null;
    this._expanded = false;
    this._build();
    this._replan(true);
    this._lastScanMs = this._now();
    this._wake();
  }

  /**
   * Cheap per-frame sync (write-on-change per notch from live `isVisible()`),
   * throttled to 1 Hz (REFRESH_MIN_MS) unless `force` (the HUD_PANE_VISIBILITY edge). A rest
   * rung found visible is promoted into the list (re-plan, same floor/room).
   * @param {{force?:boolean}} [opts]
   * @returns {boolean} whether a scan ran this call
   */
  refresh({ force = false } = {}) {
    if (this._disposed) return false;
    const t = this._now();
    if (!force && (t - this._lastScanMs) < REFRESH_MIN_MS) return false;
    this._lastScanMs = t;
    this._scan();
    return true;
  }

  /**
   * Flip one pane through its rung (`setVisible(!isVisible())`), then
   * `onFlip(id, shown)` AFTER the flip, then repaint. Unknown id / MORE →
   * false. Works headless (the rung is the injected model).
   * @param {string} paneId
   * @returns {boolean} whether a rung flipped
   */
  toggle(paneId) {
    if (this._disposed || paneId === MORE_ID) return false;
    const rung = this._rungById(paneId);
    if (!rung || typeof rung.setVisible !== 'function') return false;
    const next = !_safeVisible(rung);
    try { rung.setVisible(next); } catch (_e) { return false; }
    if (this._onFlip) {
      try { this._onFlip(paneId, next); } catch (_e) { /* dep */ }
    }
    this._scan();
    return true;
  }

  /**
   * ~320 ms highlight on one notch (the hub calls it from the
   * HUD_PANE_VISIBILITY listener for the `-`/`+` keys). A rest rung is
   * promoted first so the pane that just changed has a notch to flash.
   * Re-calls restart the timer (per notch). Headless / not built: no-op.
   * @param {string} paneId
   */
  flash(paneId) {
    if (this._disposed || !this._root) return;
    this._scan();                           // promotes a newly visible rest rung
    const rec = this._notches.find((n) => n.id === paneId);
    if (!rec || (rec.rest && !this._expanded)) return;
    rec.flashing = true;
    this._setAttr(rec.el, 'data-flash', '1');
    this._paintColors(rec.plate || rec.el, PaneRail.notchPaint({ lit: !!rec.lit, flashing: true }));
    if (rec.flashTimer != null) this._clearTimeout(rec.flashTimer);
    rec.flashTimer = this._setTimeout(() => {
      rec.flashTimer = null;
      rec.flashing = false;
      this._setAttr(rec.el, 'data-flash', '0');
      rec.lit = null;                       // force the repaint
      this._paintNotch(rec, _safeVisible(rec.rung));
    }, FLASH_MS);
  }

  /** Expand / fold the rest behind MORE. @returns {boolean} the new state */
  toggleMore() {
    if (this._disposed) return this._expanded;
    if (!this._plan.rest.length) { this._expanded = false; return false; }
    this._expanded = !this._expanded;
    this._applyExpanded();
    this._wake();
    return this._expanded;
  }

  /** @returns {boolean} true while the rest notches are unfolded. */
  isExpanded() { return this._expanded; }

  /** @returns {boolean} true when a MORE notch exists (rungs beyond the list). */
  hasMore() { return this._plan.rest.length > 0; }

  /** @returns {string[]} the displayed pane ids, bottom→top (listed, then the rest when expanded). */
  notchIds() {
    return this._expanded ? this._plan.listed.concat(this._plan.rest) : this._plan.listed.slice();
  }

  /** @returns {number} displayed pane notches (MORE and the head excluded). */
  notchCount() { return this.notchIds().length; }

  /** Remove every node + timer; the instance stays inert afterwards. */
  dispose() {
    if (this._disposed) return;
    this._clearTimers();
    this._press = null;
    this._visible = false;
    if (this._root && typeof this._root.remove === 'function') this._root.remove();
    this._root = null;
    this._stack = null;
    this._head = null;
    this._more = null;
    this._notches = [];
    this._built = false;
    this._disposed = true;
  }

  // ── Internals: model ────────────────────────────────────────────────────────

  /** @private The live rung list (defensive; [] when absent/throwing). */
  _rungs() {
    if (!this._rungsFn) return [];
    try {
      const r = this._rungsFn();
      return Array.isArray(r) ? r : [];
    } catch (_e) { return []; }
  }

  /** @private */
  _rungById(id) {
    for (const r of this._rungs()) if (r && r.id === id) return r;
    return null;
  }

  /** @private The floor's room row via the injected getter (null when absent/throwing). */
  _room() {
    if (!this._roomTiers) return null;
    try {
      const row = this._roomTiers(this._floor);
      return (row && typeof row === 'object') ? row : null;
    } catch (_e) { return null; }
  }

  /**
   * @private Recompute the plan; rebuild the notch column when it changed
   * (or when forced — populate). Then paint every displayed notch.
   */
  _replan(force) {
    const rungs = this._rungs();
    const plan = PaneRail.planNotches(rungs, this._room(), RAIL_GEOMETRY.MAX_NOTCHES);
    const key = `${plan.listed.join(',')}|${plan.rest.join(',')}`;
    const changed = force || key !== this._planKey;
    this._plan = plan;
    this._planKey = key;
    if (!plan.rest.length) this._expanded = false;
    if (changed) this._rebuildStack(rungs);
    this._paintAll();
  }

  /** @private Per-notch write-on-change paint; a rest rung found visible re-plans. */
  _scan() {
    if (!this._root) return;
    let promote = false;
    const displayed = new Set(this.notchIds());
    for (const r of this._rungs()) {
      if (r && !displayed.has(r.id) && _safeVisible(r)) { promote = true; break; }
    }
    if (promote) { this._replan(false); return; }
    this._paintAll();
    this._applyDodge();
  }

  /**
   * @private THE DODGE (RailGeometry.dodgeTop): the rail slides under the LEFT
   * HUD column when mid-height would overlap it, back to mid-height when it
   * clears. Runs inside the 1 Hz scan (the ONE layout read per second this
   * module makes — the per-frame law); write-on-change on `top`/`transform`.
   * Headless / no column element → mid-height (nothing measured, nothing written).
   */
  _applyDodge() {
    const root = this._root;
    const doc = this._doc;
    if (!root || !doc || typeof root.getBoundingClientRect !== 'function' || typeof doc.getElementById !== 'function') return;
    const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
    const innerH = win ? Number(win.innerHeight) : 0;
    const col = doc.getElementById(SIDE_COLUMN_ID);
    const cr = (col && typeof col.getBoundingClientRect === 'function') ? col.getBoundingClientRect() : null;
    const colBottom = (cr && cr.height > 0) ? cr.bottom : -Infinity;
    const rr = root.getBoundingClientRect();   // the ONE root read: .height (the dodge) + .right (rightPx)
    // Session L: the rail's RIGHT edge from the SAME rect — the hull callouts'
    // second inset source (rightPx → the hub → MotherCallouts.setRailInsets).
    this._railRight = (rr.height > 0) ? rr.right : null;
    const top = dodgeTop({ railH: rr.height, colBottom, innerH });
    if (top === this._dodgeTop) return;
    this._dodgeTop = top;
    if (top == null) {
      root.style.top = '50%';
      root.style.transform = 'translateY(-50%)';
    } else {
      root.style.top = `${top}px`;
      root.style.transform = 'none';
    }
  }

  /** @private */
  _paintAll() {
    for (const rec of this._notches) {
      if (rec.rest && !this._expanded) continue;    // folded: not on screen, nothing to write
      this._paintNotch(rec, _safeVisible(rec.rung));
    }
  }

  /** @private Write-on-change: lit attr + frame colours (opacity is CSS via data-lit). */
  _paintNotch(rec, lit) {
    if (rec.flashing || rec.lit === lit) return;
    rec.lit = lit;
    this._setAttr(rec.el, 'data-lit', lit ? '1' : '0');
    this._paintColors(rec.plate || rec.el, PaneRail.notchPaint({ lit }));
  }

  /** @private */
  _paintColors(el, p) {
    if (!el || !el.style) return;
    el.style.borderColor = p.borderColor;
    el.style.color = p.color;
    el.style.boxShadow = p.boxShadow;
  }

  // ── Internals: DOM ──────────────────────────────────────────────────────────

  /** @private Effective reduced-motion read (dep overrides the house probe). */
  _reducedMotion() {
    const dep = this._reducedMotionDep;
    if (typeof dep === 'function') { try { return !!dep(); } catch (_e) { return false; } }
    if (typeof dep === 'boolean') return dep;
    return _prefersReducedMotion();
  }

  /** @private Lazily build the root + head (idempotent, no-op headless). */
  _build() {
    if (this._built || this._disposed) return;
    const doc = this._doc;
    if (!doc || typeof doc.createElement !== 'function' || !doc.body) return;
    this._built = true;
    const reduced = this._reducedMotion();
    this._ensureStyle(doc);

    // Root: mid-height LEFT edge (the shared geometry), column-reverse so the
    // first notch is at the BOTTOM and the head at the TOP (the WHERE rail's
    // elevator order). pointer-events:none on the root — its gaps/padding
    // never eat a canvas tap; every notch and the head opt back in.
    const root = doc.createElement('div');
    root.id = ROOT_ID;
    root.style.cssText = midHeightCss('left') + [
      'display:flex', 'flex-direction:column-reverse', 'gap:5px',
      'font-family: var(--font-mono)', 'font-size:0.6rem', 'letter-spacing:0.08em',
      'text-transform:uppercase',
      'padding:6px 8px 6px 6px',
      `border-right:2px solid ${NOTCH_REST_BORDER}`,
      'background:rgba(0,10,22,0.42)', 'border-radius:4px',
      'z-index:35', 'pointer-events:none', 'opacity:0',
      reduced ? '' : `transition:opacity ${ROOT_FADE_MS}ms`,
    ].join(';');

    // The notch column — rebuilt on every populate; a child of the root so the
    // head (appended after it) stays at the top of the column-reverse root.
    // gap 5px = the WHERE rail's row gap (RailIndicator root) — the two rails
    // read as one instrument family.
    const stack = doc.createElement('div');
    stack.className = 'pane-rail-stack';
    stack.style.cssText = `display:flex;flex-direction:column-reverse;gap:${this._glass ? 0 : 5}px`;
    root.appendChild(stack);

    // HEAD cap: the rail's name and the long-press RESET ROOM target. Styled
    // as the WHERE rail's warp readout row (its head): INFO colour, one text
    // row, no fixed height (owner 2026-09-06 — the compact rows).
    const head = doc.createElement('div');
    head.className = 'pane-rail-head';
    head.textContent = 'WHAT';
    head.style.cssText = [
      'padding:0 8px 2px', 'text-align:left', 'white-space:nowrap',
      `color:${VisualLaw.COLORS.INFO}`, 'font-size:0.62rem', 'letter-spacing:0.12em',
      'opacity:0.85', 'pointer-events:auto', 'cursor:default',
      'display:flex', 'align-items:flex-end',
      this._glass ? `min-height:${RAIL_GEOMETRY.TOUCH_PITCH_PX}px` : '',
    ].join(';');
    this._bindHead(head);
    root.appendChild(head);

    // Hover anywhere on the rail wakes the idle fade (bubbles from the notches).
    if (typeof root.addEventListener === 'function') {
      root.addEventListener('pointerover', () => this._wake());
      root.addEventListener('pointercancel', () => this._cancelPress());
      root.addEventListener('pointerleave', () => this._cancelPress());
      root.addEventListener('contextmenu', (e) => { if (e && e.preventDefault) e.preventDefault(); });
    }

    doc.body.appendChild(root);
    this._root = root;
    this._stack = stack;
    this._head = head;
    this._applyOpacity();
    if (this._planKey != null) this._replan(true);   // a pre-build populate lands now
  }

  /** @private The CSS-only laws: dim opacity, the +15 % hover peek, the flash lift. */
  _ensureStyle(doc) {
    if (!doc || !doc.head || typeof doc.createElement !== 'function') return;
    if (typeof doc.getElementById === 'function' && doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    const peek = Math.min(1, NOTCH_DIM_OPACITY + HOVER_PEEK);
    style.textContent = `
      /* WHAT rail (plan D-H): a hidden pane's notch is DIM — the "there's more"
       * hint; a shown pane's notch is lit. Opacity lives HERE (never inline)
       * so the desktop hover peek can lift it. */
      #${ROOT_ID} .pane-rail-notch { opacity: 1; transition: opacity 240ms ease; cursor: pointer;
        user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; touch-action: manipulation; }
      #${ROOT_ID} .pane-rail-notch[data-lit="0"] { opacity: ${NOTCH_DIM_OPACITY}; }
      #${ROOT_ID} .pane-rail-notch[data-lit="0"]:hover { opacity: ${peek}; }
      #${ROOT_ID} .pane-rail-notch[data-flash="1"] { opacity: 1; }
      #${ROOT_ID} .pane-rail-head { user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; touch-action: manipulation; }
      @media (prefers-reduced-motion: reduce) {
        #${ROOT_ID} .pane-rail-notch { transition: none; }
      }
    `;
    doc.head.appendChild(style);
  }

  /** @private Tear down the notch column and rebuild it from the plan. */
  _rebuildStack(rungs) {
    if (!this._stack) return;
    for (const rec of this._notches) {
      if (rec.flashTimer != null) { this._clearTimeout(rec.flashTimer); rec.flashTimer = null; }
      this._detach(rec.el);
    }
    if (this._more) { this._detach(this._more.el); this._more = null; }
    this._notches = [];
    this._press = null;
    const byId = new Map();
    for (const r of rungs) if (r && r.id) byId.set(r.id, r);
    const doc = this._doc;
    // A notch is TWO boxes: `el` = the HIT box (transparent; on glass a
    // TOUCH_PITCH_PX row so a thumb lands on it — the touchable law), `plate`
    // = the LOOK (the WHERE rail's compact row, centred in the hit box).
    // Paint (border/colour/halo) goes on the plate; data-* state on el.
    const mk = (id, rest) => {
      const rung = byId.get(id);
      const el = doc.createElement('div');
      el.className = 'pane-rail-notch';
      this._setAttr(el, 'data-pane', id);
      el.style.cssText = this._hitCss();
      const plate = doc.createElement('span');
      plate.className = 'pane-rail-plate';
      plate.style.cssText = this._notchCss();
      el.appendChild(plate);
      const lbl = PaneRail.notchLabel(rung ? rung.label : id, this._hotkeys[id]);
      const label = doc.createElement('span');
      label.className = 'pane-rail-label';
      label.textContent = lbl.text;
      plate.appendChild(label);
      const key = doc.createElement('span');
      key.className = 'pane-rail-key';
      key.style.cssText = 'margin-left:6px;opacity:0.7;letter-spacing:0';
      key.textContent = lbl.key;
      plate.appendChild(key);
      const rec = { id, rung, el, plate, label, key, rest, lit: null, flashing: false, flashTimer: null };
      this._bindNotch(rec);
      this._stack.appendChild(el);
      this._notches.push(rec);
      return rec;
    };
    for (const id of this._plan.listed) mk(id, false);
    for (const id of this._plan.rest) mk(id, true);
    if (this._plan.rest.length) {
      const el = doc.createElement('div');
      el.className = 'pane-rail-notch pane-rail-more';
      this._setAttr(el, 'data-pane', MORE_ID);
      this._setAttr(el, 'data-lit', '1');
      el.style.cssText = this._hitCss();
      const plate = doc.createElement('span');
      plate.className = 'pane-rail-plate';
      plate.style.cssText = this._notchCss() + ';justify-content:center;font-style:italic';
      el.appendChild(plate);
      const label = doc.createElement('span');
      label.className = 'pane-rail-label';
      plate.appendChild(label);
      this._more = { el, plate, label };
      this._bindMore(el);
      this._stack.appendChild(el);
      this._paintColors(plate, PaneRail.notchPaint({ lit: true }));
    }
    this._applyExpanded();
  }

  /**
   * @private The HIT box: transparent, opts back into pointer events (the root
   * is pointer-events:none), holds the plate centred. Glass → TOUCH_PITCH_PX
   * tall (HIG 44 pt); desktop → the plate's own height.
   */
  _hitCss() {
    return [
      'position:relative', 'display:flex', 'align-items:center',
      'pointer-events:auto',
      this._glass ? `min-height:${RAIL_GEOMETRY.TOUCH_PITCH_PX}px` : '',
    ].join(';');
  }

  /**
   * @private ONE notch row = the WHERE rail's notch row (RailIndicator:
   * `min-width:96px; padding:2px 8px; 1px border; radius 3px; the same plate`)
   * mirrored to left-aligned text toward its edge — the compact vertical style
   * the owner asked for (2026-09-06; was a fixed 40 px row). No fixed height:
   * the row is the text's own height (~17 px at 0.6rem), so the rail is
   * ~4 px per row taller than the WHERE rail's and reads as its twin. Hit
   * surface opt-in (the root is pointer-events:none).
   */
  _notchCss() {
    return [
      'position:relative', 'box-sizing:border-box', 'flex:1 1 auto',
      'min-width:96px', 'padding:2px 8px', 'display:flex', 'align-items:center',
      `border:1px solid ${NOTCH_REST_BORDER}`, 'border-radius:3px',
      'background:rgba(0,14,28,0.55)', `color:${NOTCH_REST_COLOR}`,
      'text-align:left', 'white-space:nowrap', 'overflow:hidden',
    ].join(';');
  }

  /** @private Fold/unfold the rest notches + the MORE label (write-on-change). */
  _applyExpanded() {
    const show = this._expanded;
    for (const rec of this._notches) {
      if (!rec.rest) continue;
      const want = show ? 'flex' : 'none';
      if (rec.el.style.display !== want) rec.el.style.display = want;
      if (show) this._paintNotch(rec, _safeVisible(rec.rung));
    }
    if (this._more) {
      const text = show ? 'LESS' : 'MORE';
      if (this._more.label.textContent !== text) this._more.label.textContent = text;
      this._setAttr(this._more.el, 'data-expanded', show ? '1' : '0');
    }
  }

  /** @private Root opacity from state: hidden 0 · idle IDLE_FADE · shown 1 (write-on-change). */
  _applyOpacity() {
    if (!this._root) return;
    const want = !this._visible ? '0' : (this._idle ? String(RAIL_GEOMETRY.IDLE_FADE) : '1');
    if (want !== this._opacity) {
      this._root.style.opacity = want;
      this._opacity = want;
    }
  }

  /** @private */
  _setAttr(el, name, value) {
    if (el && typeof el.setAttribute === 'function') el.setAttribute(name, value);
  }

  /** @private */
  _detach(el) {
    if (el && typeof el.remove === 'function') el.remove();
  }

  // ── Internals: pointer grammar ─────────────────────────────────────────────

  /** @private A pane notch: down records, up within slop on the SAME notch toggles. */
  _bindNotch(rec) {
    const el = rec.el;
    if (!el || typeof el.addEventListener !== 'function') return;
    el.addEventListener('pointerdown', (e) => {
      this._wake();
      this._press = { rec, x: this._ex(e), y: this._ey(e), head: false, consumed: false };
    });
    el.addEventListener('pointerup', (e) => {
      const p = this._press;
      this._press = null;
      if (!p || p.rec !== rec || p.head) return;
      if (!PaneRail.isTap(this._ex(e) - p.x, this._ey(e) - p.y)) return;
      this._wake();
      this.toggle(rec.id);
    });
  }

  /** @private The MORE notch: a tap unfolds/folds the rest. */
  _bindMore(el) {
    if (!el || typeof el.addEventListener !== 'function') return;
    el.addEventListener('pointerdown', (e) => {
      this._wake();
      this._press = { rec: this._more, x: this._ex(e), y: this._ey(e), head: false, consumed: false };
    });
    el.addEventListener('pointerup', (e) => {
      const p = this._press;
      this._press = null;
      if (!p || p.rec !== this._more) return;
      if (!PaneRail.isTap(this._ex(e) - p.x, this._ey(e) - p.y)) return;
      this.toggleMore();
    });
  }

  /** @private The head: hold >= LONG_PRESS_MS = RESET ROOM; a short press does nothing. */
  _bindHead(head) {
    if (!head || typeof head.addEventListener !== 'function') return;
    head.addEventListener('pointerdown', (e) => {
      this._wake();
      this._clearLongPress();
      const press = { rec: null, x: this._ex(e), y: this._ey(e), head: true, consumed: false };
      this._press = press;
      this._longPressTimer = this._setTimeout(() => {
        this._longPressTimer = null;
        if (this._press !== press) return;
        press.consumed = true;
        this._fireResetRoom();
      }, LONG_PRESS_MS);
    });
    head.addEventListener('pointermove', (e) => {
      const p = this._press;
      if (!p || !p.head || p.consumed) return;
      if (!PaneRail.isTap(this._ex(e) - p.x, this._ey(e) - p.y)) this._cancelPress();
    });
    head.addEventListener('pointerup', () => {
      // Short press: nothing. Long press already fired (consumed) — swallow the up.
      this._clearLongPress();
      this._press = null;
    });
  }

  /** @private The RESET ROOM gesture: dep first, then re-plan for the same floor. */
  _fireResetRoom() {
    if (this._onResetRoom) {
      try { this._onResetRoom(this._floor); } catch (_e) { /* dep */ }
    }
    if (this._head) {
      this._setAttr(this._head, 'data-flash', '1');
      const prev = this._head.style.color;
      this._head.style.color = VisualLaw.COLORS.PLAYER;
      if (this._headFlashTimer != null) this._clearTimeout(this._headFlashTimer);
      this._headFlashTimer = this._setTimeout(() => {
        this._headFlashTimer = null;
        if (!this._head) return;
        this._setAttr(this._head, 'data-flash', '0');
        this._head.style.color = prev || VisualLaw.COLORS.INFO;
      }, FLASH_MS);
    }
    if (!this._disposed) {
      this._expanded = false;
      this._replan(true);
      this._lastScanMs = this._now();
    }
  }

  /** @private */
  _cancelPress() {
    this._clearLongPress();
    this._press = null;
  }

  /** @private */
  _clearLongPress() {
    if (this._longPressTimer != null) { this._clearTimeout(this._longPressTimer); this._longPressTimer = null; }
  }

  /** @private Pointer coordinates (clientX/Y; a bare stub event reads 0). */
  _ex(e) { const v = e && e.clientX; return Number.isFinite(v) ? v : 0; }
  _ey(e) { const v = e && e.clientY; return Number.isFinite(v) ? v : 0; }

  // ── Internals: idle fade (RefitPane._armIdleTimer pattern) ─────────────────

  /** @private Activity: restore full opacity + re-arm the idle window. */
  _wake() {
    this._lastActivityMs = this._now();
    if (this._idle) {
      this._idle = false;
      this._applyOpacity();
    }
    this._armIdleTimer();
  }

  /** @private */
  _armIdleTimer() {
    this._clearIdleTimer();
    if (!this._visible || !this._root || this._disposed) return;
    this._idleTimer = this._setTimeout(() => this._idleTick(), RAIL_GEOMETRY.IDLE_FADE_MS + 20);
  }

  /**
   * @private The idle beat (timer-fired; tests drive it with an injected
   * clock): past IDLE_FADE_MS of no activity while shown → drop to IDLE_FADE
   * (never display:none — the rail never vanishes); otherwise re-arm for the
   * remainder.
   */
  _idleTick() {
    this._idleTimer = null;
    if (!this._visible || !this._root || this._disposed) return;
    const since = this._now() - this._lastActivityMs;
    if (since >= RAIL_GEOMETRY.IDLE_FADE_MS) {
      this._idle = true;
      this._applyOpacity();
    } else {
      this._idleTimer = this._setTimeout(() => this._idleTick(), (RAIL_GEOMETRY.IDLE_FADE_MS - since) + 20);
    }
  }

  /** @private */
  _clearIdleTimer() {
    if (this._idleTimer != null) { this._clearTimeout(this._idleTimer); this._idleTimer = null; }
  }

  /** @private Every timer this instance may hold (hide / dispose). */
  _clearTimers() {
    this._clearIdleTimer();
    this._clearLongPress();
    if (this._headFlashTimer != null) {
      this._clearTimeout(this._headFlashTimer);
      this._headFlashTimer = null;
      if (this._head) { this._setAttr(this._head, 'data-flash', '0'); this._head.style.color = VisualLaw.COLORS.INFO; }
    }
    for (const rec of this._notches) {
      if (rec.flashTimer != null) {
        this._clearTimeout(rec.flashTimer);
        rec.flashTimer = null;
      }
      if (rec.flashing) {
        rec.flashing = false;
        this._setAttr(rec.el, 'data-flash', '0');
        rec.lit = null;
        if (!rec.rest || this._expanded) this._paintNotch(rec, _safeVisible(rec.rung));
      }
    }
  }

  // ── Internals: injected timer pair ─────────────────────────────────────────

  /** @private */
  _setTimeout(fn, ms) {
    const t = this._timer;
    if (t && typeof t.setTimeout === 'function') return t.setTimeout(fn, ms);
    return setTimeout(fn, ms);
  }

  /** @private */
  _clearTimeout(id) {
    const t = this._timer;
    if (t && typeof t.clearTimeout === 'function') { t.clearTimeout(id); return; }
    clearTimeout(id);
  }
}

export default PaneRail;
