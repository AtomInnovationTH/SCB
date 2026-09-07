/**
 * CargoPane.js — the CARGO HUD pane (Session K, 2026-09-06).
 *
 * The cargo manifest as a HUD pane over CargoSystem, with SELL / SELL ALL /
 * -> ELEVATOR acting through ShopScreen's PUBLIC wrappers (sellMetal /
 * sellAllCargo / contributeToElevator — never CargoSystem.removeMetal
 * directly, so the sale pipeline, the contract mass and the win check stay in
 * the shop). It is a pane-density RUNG like the other DOM panes: `rung()`
 * returns the HUD domRung shape ({id:'cargo', label, isVisible, setVisible})
 * whose ONE visibility bit is the `data-density-hidden` attribute on the root,
 * so the DETAIL slider counts it as a rung and FloorMask rooms it per floor
 * (MASK_PANES.cargo / DEFAULT_ROOMS[floor].cargo).
 *
 * Wiring (the hub's, main.js inside the LADDER gate): construct with the live
 * CargoSystem + ShopScreen, push `pane.rung()` into hud.paneDensity.rungs
 * BEFORE the first floorMask.setFloor, and feed `setDodge(underPx, floorPx)`
 * per frame with the bottom edge of whatever rides above the pane on the
 * right edge (the WHERE rail or the SPECS tab) and the lowest allowed bottom
 * edge. setDodge is write-on-change on its two inputs: repeated identical
 * inputs perform no DOM write and no layout read.
 *
 * Laws: the root is a DIRECT child of #hud-overlay (the side columns are
 * dimmed to 0.35 + pointer-events:none while the hull callouts are active);
 * NO backdrop-filter (the .hud-panel GPU ban, index.html); render on EVENTS
 * only (CARGO_UPDATED / CARGO_STORE / CARGO_SELL / CARGO_SELL_ALL /
 * CONTRACT_UPDATE / UPGRADE_PURCHASED / GAME_RESET + the pane's own actions),
 * never per frame; a keyed row pool (by metalId) makes a re-render cheap and
 * every text write is write-on-change; nothing registers on window/document;
 * NO keyboard binding — every digit is taken by InputManager, so the notch
 * carries no hotkey suffix; no timers. Every dep is optional and guarded:
 * importing the module and constructing it with no document must not throw
 * (headless-safe), and an absent `cargo` renders `bay empty` with the buttons
 * disabled.
 *
 * @module ui/hud/CargoPane
 */

import { Constants } from '../../core/Constants.js';
import { eventBus } from '../../core/EventBus.js';
import { Events } from '../../core/Events.js';

/** The root element id (FloorMask MASK_PANES.cargo.els = ['#hud-cargo-pane']). */
export const CARGO_PANE_ID = 'hud-cargo-pane';

/** The injected stylesheet's id (one <style>, injected once per document). */
export const CARGO_STYLE_ID = 'cargo-pane-style';

/** The pane-density rung id (FloorMask MASK_PANES.cargo.rung). */
export const CARGO_RUNG_ID = 'cargo';

/**
 * CARGO_GEOMETRY — the pane's numbers (px). FULL_MAX_PX is a hard budget: on
 * the 13-inch iPad landscape the pane gets exactly y 724–924 under the SPECS
 * tab. ROW_* / BTN_* are the per-row and button heights (desktop / glass, the
 * 44 pt HIG hit box). COMPACT_* is the compact form's outer height: FRAME +
 * HEADER + FOOT_GAP + BTN (the header line and the two buttons cannot share
 * one 262 px inner row, so the compact form is two stacked lines). FRAME_PX is
 * the .hud-panel chrome (6 px padding + 1 px border, top and bottom);
 * HEADER_PX / PROGRESS_PX / LIST_PAD_PX / FOOT_GAP_PX are the fixed block
 * heights the full form's minimum is computed from (fullMinPx).
 */
export const CARGO_GEOMETRY = Object.freeze({
  WIDTH_PX: 280,
  RIGHT_PX: 10,
  FULL_MAX_PX: 200,
  GAP_PX: 8,
  ROW_PX: 24,
  ROW_GLASS_PX: 44,
  BTN_PX: 24,
  BTN_GLASS_PX: 44,
  COMPACT_PX: 58,
  COMPACT_GLASS_PX: 78,
  FRAME_PX: 14,
  HEADER_PX: 16,
  PROGRESS_PX: 18,
  LIST_PAD_PX: 4,
  FOOT_GAP_PX: 4,
});

/** The rung's ONE hide bit (HUD._initPaneDensity domRung grammar). */
const DENSITY_HIDDEN_ATTR = 'data-density-hidden';
/** Mode 'hidden' (no room under the rider): display:none via the style. */
const CLIPPED_ATTR = 'data-cargo-clipped';
const MODE_ATTR = 'data-cargo-mode';

/**
 * The full form's minimum outer height: frame + header + progress + list
 * padding + ONE row + footer gap + the footer buttons.
 * @param {boolean} glass
 * @returns {number}
 */
export function fullMinPx(glass) {
  const G = CARGO_GEOMETRY;
  return G.FRAME_PX + G.HEADER_PX + G.PROGRESS_PX + G.LIST_PAD_PX +
    (glass ? G.ROW_GLASS_PX : G.ROW_PX) + G.FOOT_GAP_PX + (glass ? G.BTN_GLASS_PX : G.BTN_PX);
}

/**
 * The full form's natural outer height for `rows` manifest rows (the `bay
 * empty` line counts as one row).
 * @param {number} rows
 * @param {boolean} glass
 * @returns {number}
 */
export function naturalPx(rows, glass) {
  const n = Math.max(1, rows | 0);
  return fullMinPx(glass) + (n - 1) * (glass ? CARGO_GEOMETRY.ROW_GLASS_PX : CARGO_GEOMETRY.ROW_PX);
}

/** @private 1-decimal kg. */
function fmt1(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n.toFixed(1) : '0.0';
}

/** @private Capacity / target kg: integers stay integers, else 1 decimal. */
function fmtCap(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return '0';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** @private Credits: whole cents. */
function fmtCents(x) {
  const n = Number(x);
  return `${Number.isFinite(n) ? Math.round(n) : 0}\u00a2`;
}

export class CargoPane {
  /**
   * @param {object} [deps]
   * @param {object}   [deps.cargo]  CargoSystem — getManifest() → [{metalId, name,
   *   massKg, value}], getStatus() → {totalMassKg, capacityKg, totalValue}.
   *   Absent ⇒ `bay empty`, buttons disabled.
   * @param {object}   [deps.shop]   ShopScreen — sellMetal / sellAllCargo /
   *   contributeToElevator / getContractMass (the public wrappers). Absent ⇒
   *   the buttons are inert.
   * @param {boolean}  [deps.glass]  true ⇒ 44 pt rows and buttons.
   * @param {Document|null} [deps.doc]    document (default: the global one; null = headless).
   * @param {Element}  [deps.parent] root's parent (default: doc.getElementById('hud-overlay')).
   * @param {object}   [deps.bus]    event bus with on(event, fn) → unsubscribe (default: eventBus).
   * @param {object}   [deps.events] the Events name table (default: Events).
   * @param {function} [deps.now]    ms clock — accepted for the house dep shape; the pane
   *   owns no timer and never reads it.
   */
  constructor(deps = {}) {
    this._cargo = deps.cargo || null;
    this._shop = deps.shop || null;
    this._glass = !!deps.glass;
    this._doc = deps.doc !== undefined ? deps.doc
      : (typeof document !== 'undefined' ? document : null);
    this._bus = deps.bus !== undefined ? deps.bus : eventBus;
    this._events = deps.events !== undefined ? deps.events : Events;
    this._now = typeof deps.now === 'function' ? deps.now : null;

    this._root = null;
    this._el = null;                 // { head, fill, worth, elevLabel, elevBar, list, empty, foot, sellAll, elevator }
    /** @type {Map<string, {el:object, name:object, kg:object, val:object, btn:object}>} keyed row pool */
    this._rows = new Map();
    this._order = [];                // metalIds in DOM order
    this._rowCount = 1;              // rows the natural height is computed from (>= 1)
    this._empty = true;
    this._mode = 'hidden';           // until the first setDodge places the pane
    this._topPx = null;              // the placed top (Session M: the NEXT pane rides above it)
    this._underPx = undefined;       // last setDodge inputs (write-on-change)
    this._floorPx = undefined;
    this._heightPx = 0;              // cached rendered height (offsetHeight, read once per change)
    this._expectedPx = 0;            // the arithmetic expectation (fallback when offsetHeight is unavailable)
    this._rung = null;
    this._unsubs = [];
    this._disposed = false;

    this._build(deps.parent);
    this._subscribe();
    if (this._root) this._render();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * The pane-density rung adapter (cached object; HUD domRung shape). The ONE
   * visibility bit is `data-density-hidden` on the root; isVisible() also
   * honours on-screen presence (getClientRects) like HUD's DOM rungs. Never
   * throws headless (no root ⇒ not visible, setVisible no-op).
   * @returns {{id:string, label:string, isVisible:function, setVisible:function}}
   */
  rung() {
    if (!this._rung) {
      this._rung = {
        id: CARGO_RUNG_ID,
        label: 'Cargo',
        isVisible: () => {
          const el = this._root;
          if (!el || (el.hasAttribute && el.hasAttribute(DENSITY_HIDDEN_ATTR))) return false;
          try {
            return typeof el.getClientRects === 'function' && el.getClientRects().length > 0;
          } catch (_e) {
            return false;
          }
        },
        setVisible: (v) => {
          const el = this._root;
          if (!el || !el.setAttribute) return;
          if (v) el.removeAttribute(DENSITY_HIDDEN_ATTR);
          else el.setAttribute(DENSITY_HIDDEN_ATTR, '');
        },
      };
    }
    return this._rung;
  }

  /**
   * THE DODGE (the hub calls it per frame). `underPx` = bottom edge of whatever
   * rides above the pane on the right edge (null = nothing: bottom-anchored);
   * `floorPx` = the lowest allowed bottom edge. Write-on-change on the two
   * inputs: repeated identical inputs return before any DOM access.
   *   bottom = floorPx − GAP_PX;  want = bottom − min(FULL_MAX_PX, natural)
   *   top    = want, pushed DOWN to underPx + GAP_PX only when that is lower
   *            (bottom-anchored; it yields upward only as far as it must)
   *   avail  = bottom − top
   *   mode   = 'full' (avail ≥ fullMinPx) | 'compact' (avail ≥ COMPACT_*) | 'hidden'
   * Writes data-cargo-mode, top and max-height (min(FULL_MAX_PX, avail) in full).
   * @param {number|null} underPx
   * @param {number} floorPx
   */
  setDodge(underPx, floorPx) {
    if (this._disposed || !this._root) return;
    const u = Number(underPx);
    const under = (underPx == null || !Number.isFinite(u)) ? null : u;
    let floor = Number(floorPx);
    if (!Number.isFinite(floor)) floor = this._viewportHeight();
    if (!Number.isFinite(floor)) return;
    if (under === this._underPx && floor === this._floorPx) return;   // write-on-change (inputs)
    this._underPx = under;
    this._floorPx = floor;
    if (this._layout()) this._measure();
  }

  /** The current mode: 'full' | 'compact' | 'hidden' ('hidden' until the first setDodge, and headless). */
  mode() { return this._mode; }

  /**
   * Session M — the right-edge chain: the pane's PLACED top edge (CSS px) while
   * it is on screen (placed, not clipped, its density bit clear), else null.
   * The NEXT pane rides ABOVE this pane and takes this as its floor (the hub's
   * gameLoop wire), so CARGO keeps its bottom slot and its own law. A cached
   * layout number + one attribute read — never a layout read.
   * @returns {number|null}
   */
  topPx() {
    const el = this._root;
    if (!el || this._mode === 'hidden' || this._topPx == null) return null;
    if (el.hasAttribute && el.hasAttribute(DENSITY_HIDDEN_ATTR)) return null;
    return this._topPx;
  }

  /** The cached rendered height (px): offsetHeight read once per render / dodge change, never per frame. */
  heightPx() { return this._heightPx; }

  /** Re-read the manifest and repaint (event-rate; also after every own action). */
  refresh() { this._render(); }

  /** Unsubscribe every listener, remove the root; further calls no-op. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const off of this._unsubs) {
      try { off(); } catch (_e) { /* stub bus */ }
    }
    this._unsubs = [];
    if (this._root && this._root.remove) {
      try { this._root.remove(); } catch (_e) { /* stub */ }
    }
    this._root = null;
    this._el = null;
    this._rows.clear();
    this._order = [];
    this._mode = 'hidden';
    this._heightPx = 0;
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  /** @private Inject the style once, build the DOM under `parent` (headless: nothing). */
  _build(parentDep) {
    const doc = this._doc;
    if (!doc || typeof doc.createElement !== 'function') return;
    const parent = parentDep || (doc.getElementById ? doc.getElementById('hud-overlay') : null);
    if (!parent || typeof parent.appendChild !== 'function') return;
    this._ensureStyle();
    const G = CARGO_GEOMETRY;

    const root = doc.createElement('div');
    root.id = CARGO_PANE_ID;
    root.className = 'hud-panel' + (this._glass ? ' cargo-glass' : '');
    // Geometry literals live inline (the style sheet carries the look); `top`
    // and `max-height` are written ONLY by setDodge.
    root.style.right = `${G.RIGHT_PX}px`;
    root.style.width = `${G.WIDTH_PX}px`;
    root.style.boxSizing = 'border-box';
    root.style.pointerEvents = 'auto';
    root.style.overflow = 'hidden';
    root.setAttribute(MODE_ATTR, 'hidden');
    root.setAttribute(CLIPPED_ATTR, '');           // placed by the first setDodge

    const mk = (tag, cls, text) => {
      const el = doc.createElement(tag);
      if (cls) el.className = cls;
      if (text != null) el.textContent = text;
      return el;
    };
    const btn = (cls, label) => {
      const b = mk('button', `cargo-btn ${cls}`, label);
      if (b.setAttribute) { b.setAttribute('type', 'button'); b.setAttribute('tabindex', '-1'); }
      return b;
    };

    const head = mk('div', 'cargo-head');
    const title = mk('span', 'cargo-title', 'CARGO');
    const fill = mk('span', 'cargo-fill', '');
    const worth = mk('span', 'cargo-worth', '');
    head.appendChild(title); head.appendChild(fill); head.appendChild(worth);

    const elev = mk('div', 'cargo-elev');
    const elevLabel = mk('div', 'cargo-elev-label', '');
    const elevTrack = mk('div', 'cargo-elev-track');
    const elevBar = mk('div', 'cargo-elev-bar');
    elevTrack.appendChild(elevBar);
    elev.appendChild(elevLabel); elev.appendChild(elevTrack);

    const list = mk('div', 'cargo-list');
    const empty = mk('div', 'cargo-empty', 'bay empty');
    list.appendChild(empty);

    const foot = mk('div', 'cargo-foot');
    const sellAll = btn('cargo-sell-all', 'SELL ALL');
    const elevator = btn('cargo-elevator', '-> ELEVATOR');
    foot.appendChild(sellAll); foot.appendChild(elevator);

    root.appendChild(head); root.appendChild(elev); root.appendChild(list); root.appendChild(foot);
    parent.appendChild(root);

    if (sellAll.addEventListener) {
      sellAll.addEventListener('click', () => this._sellAll());
      elevator.addEventListener('click', () => this._contributeAll());
    }

    this._root = root;
    this._el = { head, fill, worth, elevLabel, elevBar, list, empty, foot, sellAll, elevator };
  }

  /** @private The one <style id="cargo-pane-style"> (per document). No backdrop-filter. */
  _ensureStyle() {
    const doc = this._doc;
    if (!doc || !doc.head || (doc.getElementById && doc.getElementById(CARGO_STYLE_ID))) return;
    const G = CARGO_GEOMETRY;
    const style = doc.createElement('style');
    style.id = CARGO_STYLE_ID;
    style.textContent = `
      /* The house HUD grammar rides in from .hud-panel (Courier New 13px,
       * #00ff88 on rgba(5,10,20,0.95), 1px rgba(0,255,136,0.3) border). */
      #${CARGO_PANE_ID} {
        display: flex;
        flex-direction: column;
        pointer-events: auto;
        box-sizing: border-box;
        overflow: hidden;
      }
      /* The rung's ONE bit (HUD's catch-effects-style carries the global rule
       * too; this copy keeps the pane honest when it stands alone). */
      #${CARGO_PANE_ID}[${DENSITY_HIDDEN_ATTR}] { display: none !important; }
      /* Mode 'hidden': no room under the rider (setDodge). The density bit is untouched. */
      #${CARGO_PANE_ID}[${CLIPPED_ATTR}] { display: none !important; }
      #${CARGO_PANE_ID} .cargo-head {
        display: flex; align-items: baseline; gap: 8px;
        height: ${G.HEADER_PX}px; line-height: ${G.HEADER_PX}px; white-space: nowrap;
        flex: 0 0 auto;
      }
      #${CARGO_PANE_ID} .cargo-title { font-weight: bold; letter-spacing: 0.08em; }
      #${CARGO_PANE_ID} .cargo-fill { flex: 1 1 auto; text-align: right; }
      #${CARGO_PANE_ID} .cargo-worth { color: #f0c040; }
      #${CARGO_PANE_ID} .cargo-elev {
        height: ${G.PROGRESS_PX}px; font-size: 11px; line-height: 14px; opacity: 0.85;
        white-space: nowrap; flex: 0 0 auto;
      }
      #${CARGO_PANE_ID} .cargo-elev-track { height: 2px; margin-top: 2px; background: rgba(0, 255, 136, 0.15); }
      #${CARGO_PANE_ID} .cargo-elev-bar { height: 2px; width: 0%; background: #00ff88; }
      #${CARGO_PANE_ID} .cargo-list {
        flex: 1 1 auto; min-height: 0; margin: ${G.LIST_PAD_PX / 2}px 0;
        overflow-y: auto; overflow-x: hidden;
        -webkit-overflow-scrolling: touch; touch-action: pan-y;
        overscroll-behavior: contain;
      }
      #${CARGO_PANE_ID} .cargo-row {
        display: flex; align-items: center; gap: 6px; height: ${G.ROW_PX}px; white-space: nowrap;
      }
      #${CARGO_PANE_ID}.cargo-glass .cargo-row { height: ${G.ROW_GLASS_PX}px; }
      #${CARGO_PANE_ID} .cargo-row-name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; }
      #${CARGO_PANE_ID} .cargo-row-kg { flex: 0 0 64px; text-align: right; }
      #${CARGO_PANE_ID} .cargo-row-val { flex: 0 0 52px; text-align: right; color: #f0c040; }
      #${CARGO_PANE_ID} .cargo-empty { height: ${G.ROW_PX}px; line-height: ${G.ROW_PX}px; opacity: 0.5; }
      #${CARGO_PANE_ID}.cargo-glass .cargo-empty { height: ${G.ROW_GLASS_PX}px; line-height: ${G.ROW_GLASS_PX}px; }
      #${CARGO_PANE_ID} .cargo-foot { display: flex; gap: 8px; margin-top: ${G.FOOT_GAP_PX}px; flex: 0 0 auto; }
      #${CARGO_PANE_ID} .cargo-foot .cargo-btn { flex: 1 1 0; }
      /* Buttons: the StatusPanel .fleet-btn shape in the pane's green. */
      #${CARGO_PANE_ID} .cargo-btn {
        font: bold 10px/1.2 var(--font-mono);
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #00ff88;
        background: rgba(0, 255, 136, 0.08);
        border: 1px solid rgba(0, 255, 136, 0.55);
        border-radius: 3px;
        padding: 0 10px;
        min-height: ${G.BTN_PX}px;
        cursor: pointer;
        pointer-events: auto;
        touch-action: manipulation;
        user-select: none;
        -webkit-user-select: none;
        -webkit-tap-highlight-color: transparent;
        -webkit-touch-callout: none;
        transition: background 0.15s ease, border-color 0.15s ease;
      }
      #${CARGO_PANE_ID}.cargo-glass .cargo-btn { min-height: ${G.BTN_GLASS_PX}px; min-width: 44px; }
      #${CARGO_PANE_ID} .cargo-btn:hover { background: rgba(0, 255, 136, 0.18); border-color: #00ff88; }
      #${CARGO_PANE_ID} .cargo-btn:active { background: rgba(0, 255, 136, 0.35); color: #ffffff; }
      #${CARGO_PANE_ID} .cargo-btn:focus { outline: none; }
      #${CARGO_PANE_ID} .cargo-btn[aria-disabled="true"] { opacity: 0.35; cursor: default; pointer-events: none; }
      /* Compact: the header line + the two buttons; the progress line and the list fold away. */
      #${CARGO_PANE_ID}[${MODE_ATTR}="compact"] .cargo-elev,
      #${CARGO_PANE_ID}[${MODE_ATTR}="compact"] .cargo-list { display: none; }
    `;
    doc.head.appendChild(style);
  }

  /** @private Subscribe the render to the cargo / contract / capacity / reset events (injected bus). */
  _subscribe() {
    const bus = this._bus;
    const E = this._events;
    if (!bus || typeof bus.on !== 'function' || !E) return;
    const names = [E.CARGO_UPDATED, E.CARGO_STORE, E.CARGO_SELL, E.CARGO_SELL_ALL,
      E.CONTRACT_UPDATE, E.UPGRADE_PURCHASED, E.GAME_RESET];
    const onEvent = () => this._render();
    for (const name of names) {
      if (!name) continue;
      const off = bus.on(name, onEvent);
      if (typeof off === 'function') this._unsubs.push(off);
      else if (typeof bus.off === 'function') this._unsubs.push(() => bus.off(name, onEvent));
    }
  }

  // ── Reads (every one guarded) ──────────────────────────────────────────────

  /** @private The manifest array (absent / throwing cargo ⇒ []). */
  _manifest() {
    const c = this._cargo;
    if (!c || typeof c.getManifest !== 'function') return [];
    try {
      const m = c.getManifest();
      return Array.isArray(m) ? m : [];
    } catch (_e) {
      return [];
    }
  }

  /** @private {totalMassKg, capacityKg, totalValue} (absent ⇒ zeros). */
  _status() {
    const c = this._cargo;
    if (c && typeof c.getStatus === 'function') {
      try {
        const s = c.getStatus();
        if (s && typeof s === 'object') return s;
      } catch (_e) { /* fall through */ }
    }
    return { totalMassKg: 0, capacityKg: 0, totalValue: 0 };
  }

  /** @private The contract mass so far (shop.getContractMass, guarded). */
  _contractKg() {
    const s = this._shop;
    if (!s || typeof s.getContractMass !== 'function') return 0;
    try {
      const n = Number(s.getContractMass());
      return Number.isFinite(n) ? n : 0;
    } catch (_e) {
      return 0;
    }
  }

  /** @private The elevator target mass (Constants.ELEVATOR_CONTRACT.TARGET_MASS_KG). */
  _targetKg() {
    const ec = Constants && Constants.ELEVATOR_CONTRACT;
    const t = ec && Number(ec.TARGET_MASS_KG);
    return (Number.isFinite(t) && t > 0) ? t : 10000;
  }

  /** @private The window height when the hub passes no floor (never per frame: setDodge caches). */
  _viewportHeight() {
    const doc = this._doc;
    const win = (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
    const h = win && Number(win.innerHeight);
    return Number.isFinite(h) && h > 0 ? h : NaN;
  }

  // ── Actions (through the SHOP wrappers only) ───────────────────────────────

  /** @private Row SELL → shop.sellMetal(metalId); re-render. */
  _sellRow(metalId) {
    const s = this._shop;
    if (this._disposed || !s || typeof s.sellMetal !== 'function') return;
    try { s.sellMetal(metalId); } finally { this._render(); }
  }

  /** @private SELL ALL → shop.sellAllCargo() once; re-render. */
  _sellAll() {
    const s = this._shop;
    if (this._disposed || this._empty || !s || typeof s.sellAllCargo !== 'function') return;
    try { s.sellAllCargo(); } finally { this._render(); }
  }

  /**
   * @private -> ELEVATOR: contribute EVERY manifest item, one
   * shop.contributeToElevator(metalId, massKg) per item, stopping early once
   * shop.getContractMass() reaches the target (the win fires inside the shop).
   */
  _contributeAll() {
    const s = this._shop;
    if (this._disposed || this._empty || !s || typeof s.contributeToElevator !== 'function') return;
    const target = this._targetKg();
    const items = this._manifest();           // snapshot: the shop removes as it goes
    try {
      for (const item of items) {
        if (this._contractKg() >= target) break;
        if (!item || item.metalId == null) continue;
        const kg = Number(item.massKg);
        if (!(kg > 0)) continue;
        s.contributeToElevator(item.metalId, kg);
      }
    } finally {
      this._render();
    }
  }

  // ── Render (event-rate) ────────────────────────────────────────────────────

  /** @private Repaint from the reads; keyed rows; write-on-change everywhere. */
  _render() {
    if (this._disposed || !this._root) return;
    const el = this._el;
    const items = this._manifest();
    const status = this._status();
    const empty = items.length === 0;

    const cur = Number(status.totalMassKg);
    const cap = Number(status.capacityKg);
    let value = Number(status.totalValue);
    if (!Number.isFinite(value)) value = items.reduce((a, i) => a + (Number(i.value) || 0), 0);
    this._setText(el.fill, `${fmt1(cur)} / ${fmtCap(cap)} kg`);
    this._setText(el.worth, fmtCents(value));

    const contract = this._contractKg();
    const target = this._targetKg();
    const pct = Math.max(0, Math.min(100, (contract / target) * 100));
    this._setText(el.elevLabel, `ELEVATOR ${fmt1(contract)} / ${fmtCap(target)} kg`);
    this._setStyle(el.elevBar, 'width', `${Math.round(pct * 10) / 10}%`);

    this._syncRows(items);
    this._setStyle(el.empty, 'display', empty ? '' : 'none');
    this._setDisabled(el.sellAll, empty);
    this._setDisabled(el.elevator, empty);
    this._empty = empty;
    this._rowCount = Math.max(1, items.length);

    this._layout();
    this._measure();
  }

  /** @private Keyed row pool by metalId: reuse, retext, reorder only when the order changed. */
  _syncRows(items) {
    const list = this._el.list;
    const pool = this._rows;
    const seen = new Set();
    const ids = [];
    let changed = false;
    for (const item of items) {
      if (!item || item.metalId == null) continue;
      const id = String(item.metalId);
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      let rec = pool.get(id);
      if (!rec) {
        rec = this._makeRow(id);
        pool.set(id, rec);
        list.appendChild(rec.el);
        changed = true;
      }
      this._setText(rec.name, item.name != null ? String(item.name) : id);
      this._setText(rec.kg, `${fmt1(item.massKg)} kg`);
      this._setText(rec.val, fmtCents(item.value));
    }
    for (const [id, rec] of pool) {
      if (seen.has(id)) continue;
      if (rec.el.remove) rec.el.remove();
      pool.delete(id);
      changed = true;
    }
    if (!changed) {
      for (let i = 0; i < ids.length; i++) if (this._order[i] !== ids[i]) { changed = true; break; }
    }
    if (changed) {
      for (const id of ids) list.appendChild(pool.get(id).el);   // appendChild MOVES an attached child
      this._order = ids;
    }
  }

  /** @private One manifest row: name | kg | value | SELL (the SELL button is keyed to its metalId). */
  _makeRow(id) {
    const doc = this._doc;
    const mk = (tag, cls, text) => {
      const e = doc.createElement(tag);
      e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    };
    const el = mk('div', 'cargo-row');
    if (el.setAttribute) el.setAttribute('data-metal', id);
    const name = mk('span', 'cargo-row-name', id);
    const kg = mk('span', 'cargo-row-kg', '');
    const val = mk('span', 'cargo-row-val', '');
    const btn = mk('button', 'cargo-btn cargo-row-sell', 'SELL');
    if (btn.setAttribute) { btn.setAttribute('type', 'button'); btn.setAttribute('tabindex', '-1'); btn.setAttribute('data-metal', id); }
    if (btn.addEventListener) btn.addEventListener('click', () => this._sellRow(id));
    el.appendChild(name); el.appendChild(kg); el.appendChild(val); el.appendChild(btn);
    return { el, name, kg, val, btn };
  }

  // ── Layout (setDodge + render; pure arithmetic, write-on-change outputs) ───

  /**
   * @private Place the pane from the cached dodge inputs. Returns true when a
   * DOM write happened. No layout reads.
   */
  _layout() {
    const root = this._root;
    if (!root || !Number.isFinite(this._floorPx)) return false;
    const G = CARGO_GEOMETRY;
    const glass = this._glass;
    const natural = naturalPx(this._rowCount, glass);
    const bottom = this._floorPx - G.GAP_PX;
    // BOTTOM-ANCHORED: the pane hugs the floor (the thumb-rest line on glass)
    // and gives ground UPWARD only as far as what rides above it forces —
    // never higher than it must (the hub's gate on the 13-inch iPad: the
    // hull callout columns end ~700 px on the shop floor; a pane parked at
    // `under + GAP` sat over the PROPULSION card's last line).
    const want = bottom - Math.min(G.FULL_MAX_PX, natural);
    let top = (this._underPx == null) ? want : Math.max(want, this._underPx + G.GAP_PX);
    if (top < 0) top = 0;
    const avail = bottom - top;
    const compactMin = glass ? G.COMPACT_GLASS_PX : G.COMPACT_PX;
    let mode, maxH;
    if (avail >= fullMinPx(glass)) { mode = 'full'; maxH = Math.min(G.FULL_MAX_PX, avail); }
    else if (avail >= compactMin) { mode = 'compact'; maxH = compactMin; }
    else { mode = 'hidden'; maxH = 0; }

    let wrote = false;
    if (mode !== this._mode) {
      this._mode = mode;
      root.setAttribute(MODE_ATTR, mode);
      if (mode === 'hidden') root.setAttribute(CLIPPED_ATTR, '');
      else root.removeAttribute(CLIPPED_ATTR);
      wrote = true;
    }
    if (mode !== 'hidden') {
      wrote = this._setStyle(root, 'top', `${Math.round(top)}px`) || wrote;
      wrote = this._setStyle(root, 'maxHeight', `${Math.round(maxH)}px`) || wrote;
    }
    this._topPx = mode === 'hidden' ? null : Math.round(top);
    this._expectedPx = mode === 'hidden' ? 0 : Math.min(maxH, mode === 'full' ? natural : compactMin);
    return wrote;
  }

  /** @private Cache the rendered height: ONE offsetHeight read (fallback: the computed expectation). */
  _measure() {
    const root = this._root;
    if (!root) { this._heightPx = 0; return; }
    if (this._mode === 'hidden') { this._heightPx = 0; return; }
    const h = root.offsetHeight;
    this._heightPx = (typeof h === 'number' && h > 0) ? h : (this._expectedPx || 0);
  }

  // ── Write-on-change helpers ────────────────────────────────────────────────

  /** @private */
  _setText(el, text) {
    if (!el || el.textContent === text) return false;
    el.textContent = text;
    return true;
  }

  /** @private */
  _setStyle(el, prop, value) {
    if (!el || !el.style || el.style[prop] === value) return false;
    el.style[prop] = value;
    return true;
  }

  /** @private disabled + aria-disabled (the dim rule keys off the attribute). */
  _setDisabled(btn, disabled) {
    if (!btn) return;
    if (btn.disabled !== disabled) btn.disabled = disabled;
    const want = disabled ? 'true' : null;
    const have = btn.getAttribute ? btn.getAttribute('aria-disabled') : null;
    if (have === want) return;
    if (disabled) btn.setAttribute('aria-disabled', 'true');
    else btn.removeAttribute('aria-disabled');
  }
}

export default CargoPane;
