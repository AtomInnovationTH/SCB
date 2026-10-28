/**
 * CargoPane.js — the CARGO HUD pane: the cargo manifest over CargoSystem, with SELL / SELL ALL / -> ELEVATOR acting
 * through ShopScreen's PUBLIC wrappers (sellMetal / sellAllCargo / contributeToElevator — never
 * CargoSystem.removeMetal directly, so the sale pipeline, contract mass and win check stay in the shop).
 * A pane-density RUNG: `rung()` returns the HUD domRung shape ({id:'cargo', label, isVisible, setVisible}) whose ONE
 * visibility bit is `data-density-hidden` on the root, so the DETAIL slider counts it and FloorMask rooms it per floor
 * (MASK_PANES.cargo / DEFAULT_ROOMS[floor].cargo).
 *
 * Wiring (main.js, LADDER gate): construct with the live CargoSystem + ShopScreen, push `pane.rung()` into
 * hud.paneDensity.rungs BEFORE the first floorMask.setFloor. LeftStack places it as the first left-arm overlay rider
 * via `setStack(top, height, mode)` (write-on-change). Layout-hidden uses `data-stack-hidden`, never the density bit.
 *
 * Laws: the root is a DIRECT child of #hud-overlay (the side columns are dimmed to 0.35 + pointer-events:none while
 * the hull callouts are active); NO backdrop-filter (the .hud-panel GPU ban, index.html); render on EVENTS only
 * (CARGO_UPDATED / CARGO_STORE / CARGO_SELL / CARGO_SELL_ALL / CONTRACT_UPDATE / UPGRADE_PURCHASED / GAME_RESET + own
 * actions), never per frame; a keyed row pool (by metalId) and write-on-change text; nothing registers on
 * window/document; NO keyboard binding (every digit is taken by InputManager, so the notch has no hotkey suffix);
 * no timers. Every dep is optional and guarded: construction with no document must not throw, and an absent `cargo`
 * renders `bay empty` with the buttons disabled.
 *
 * @module ui/hud/CargoPane
 */

import { Constants } from '../../core/Constants.js';
import { sellAtLine, contributeAtLine } from '../../systems/resupplyWords.js';
import { eventBus } from '../../core/EventBus.js';
import { Events } from '../../core/Events.js';
import { VisualLaw } from '../../core/VisualLaw.js';
import { PANE_CORNER_PX, HUD_COLUMN_WIDTH_PX } from '../RailGeometry.js';
import { DENSITY_MOTION_MS, DENSITY_MOTION_EASING } from '../HUD.js';
import { clamp } from '../../core/MathUtil.js';

/** FloorMask MASK_PANES.cargo.els = ['#hud-cargo-pane']. */
export const CARGO_PANE_ID = 'hud-cargo-pane';

export const CARGO_STYLE_ID = 'cargo-pane-style';

/** FloorMask MASK_PANES.cargo.rung. */
export const CARGO_RUNG_ID = 'cargo';

/**
 * The pane's numbers (px). FULL_MAX_PX is a hard budget: on the 13-inch iPad landscape the pane gets exactly
 * y 724–924 under the SPECS tab. ROW_* / BTN_* are per-row and button heights (desktop / glass, the 44 pt hit box).
 * COMPACT_* = FRAME + HEADER + FOOT_GAP + BTN (the header line and the two buttons cannot share one 262 px inner row,
 * so the compact form is two stacked lines). FRAME_PX is the .hud-panel chrome (6 px padding + 1 px border, top and
 * bottom); HEADER_PX / PROGRESS_PX / LIST_PAD_PX / FOOT_GAP_PX feed fullMinPx.
 */
export const CARGO_GEOMETRY = Object.freeze({
  WIDTH_PX: HUD_COLUMN_WIDTH_PX,
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

const DENSITY_HIDDEN_ATTR = 'data-density-hidden';
/** Layout-hidden (LeftStack): display:none via the pane's own style — never the density bit. */
const STACK_HIDDEN_ATTR = 'data-stack-hidden';
const MODE_ATTR = 'data-cargo-mode';

/** The full form's minimum outer height: frame + header + progress + list padding + ONE row + footer gap + buttons. */
export function fullMinPx(glass) {
  const G = CARGO_GEOMETRY;
  return G.FRAME_PX + G.HEADER_PX + G.PROGRESS_PX + G.LIST_PAD_PX +
    (glass ? G.ROW_GLASS_PX : G.ROW_PX) + G.FOOT_GAP_PX + (glass ? G.BTN_GLASS_PX : G.BTN_PX);
}

/** The full form's natural outer height for `rows` manifest rows (`bay empty` counts as one). */
export function naturalPx(rows, glass) {
  const n = Math.max(1, rows | 0);
  return fullMinPx(glass) + (n - 1) * (glass ? CARGO_GEOMETRY.ROW_GLASS_PX : CARGO_GEOMETRY.ROW_PX);
}
/** Alias so the instance method `naturalPx()` does not recurse into itself. */
const _naturalPx = naturalPx;

function fmt1(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n.toFixed(1) : '0.0';
}

/** Integers stay integers, else 1 decimal. */
function fmtCap(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return '0';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

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
    this._el = null;
    /** @type {Map<string, {el:object, name:object, kg:object, val:object, btn:object}>} keyed row pool */
    this._rows = new Map();
    this._order = [];                // metalIds in DOM order
    this._rowCount = 1;              // rows the natural height is computed from (>= 1)
    this._empty = true;
    this._mode = 'hidden';           // until the first setStack places the pane
    this._stackMode = undefined;     // last setStack inputs (write-on-change)
    this._stackTop = undefined;
    this._stackH = undefined;
    this._topPx = null;              // the placed top
    this._heightPx = 0;              // cached offsetHeight, read once per change
    this._expectedPx = 0;            // fallback when offsetHeight is unavailable
    this._rung = null;
    this._unsubs = [];
    this._disposed = false;

    this._build(deps.parent);
    this._subscribe();
    if (this._root) this._render();
  }

  /** The pane-density rung adapter (cached). Never throws headless (no root ⇒ not visible, setVisible no-op). */
  rung() {
    if (!this._rung) {
      this._rung = {
        id: CARGO_RUNG_ID,
        label: 'Cargo',
        isVisible: () => {
          const el = this._root;
          if (!el || !el.hasAttribute) return false;
          // Layout-hidden (`data-stack-hidden`) must not read as a density hide (LeftStack would skip apply).
          return !el.hasAttribute(DENSITY_HIDDEN_ATTR) && !el.hasAttribute('data-density-leaving');
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
   * LeftStack apply (per frame). Write-on-change. Stack mode → data-cargo-mode: natural/trimmed → 'full',
   * compact → 'compact', hidden → 'hidden' + data-stack-hidden. Sets `top` BEFORE un-hiding so the reflow glides.
   * @param {'natural'|'compact'|'trimmed'|'hidden'} mode
   */
  setStack(top, height, mode) {
    if (this._disposed || !this._root) return;
    const t = Number(top);
    const h = Number(height);
    if (!Number.isFinite(t)) return;
    const m = (mode === 'compact' || mode === 'trimmed' || mode === 'hidden') ? mode : 'natural';
    const hh = Number.isFinite(h) ? h : 0;
    if (t === this._stackTop && hh === this._stackH && m === this._stackMode) return;
    this._stackTop = t;
    this._stackH = hh;
    this._stackMode = m;
    if (this._layout()) this._measure();
  }

  naturalPx() {
    return Math.min(CARGO_GEOMETRY.FULL_MAX_PX, _naturalPx(this._rowCount, this._glass));
  }

  compactPx() {
    return this._glass ? CARGO_GEOMETRY.COMPACT_GLASS_PX : CARGO_GEOMETRY.COMPACT_PX;
  }

  minPx() {
    return fullMinPx(this._glass);
  }

  /** The current cargo-mode: 'full' | 'compact' | 'hidden' ('hidden' until the first setStack, and headless). */
  mode() { return this._mode; }

  /** The PLACED top edge (CSS px) while on screen (placed, not layout-hidden, density bit clear), else null. Never a layout read. */
  topPx() {
    const el = this._root;
    if (!el || this._mode === 'hidden' || this._topPx == null) return null;
    if (el.hasAttribute && (el.hasAttribute(DENSITY_HIDDEN_ATTR) || el.hasAttribute(STACK_HIDDEN_ATTR))) return null;
    return this._topPx;
  }

  /** Cached offsetHeight (px), read once per render / dodge change, never per frame. */
  heightPx() { return this._heightPx; }

  refresh() { this._render(); }

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

  /** @private Headless: builds nothing. */
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
    // left / width at build; `top` and `max-height` are written ONLY by setStack.
    root.style.position = 'absolute';
    root.style.left = `max(${PANE_CORNER_PX}px, env(safe-area-inset-left))`;   // the left column's edge
    root.style.width = `${G.WIDTH_PX}px`;
    root.style.boxSizing = 'border-box';
    root.style.pointerEvents = 'auto';
    root.style.overflow = 'hidden';
    root.setAttribute(MODE_ATTR, 'hidden');
    root.setAttribute(STACK_HIDDEN_ATTR, '');           // placed by the first setStack

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

  /** @private One <style> per document. No backdrop-filter. */
  _ensureStyle() {
    const doc = this._doc;
    if (!doc || !doc.head || (doc.getElementById && doc.getElementById(CARGO_STYLE_ID))) return;
    const G = CARGO_GEOMETRY;
    const style = doc.createElement('style');
    style.id = CARGO_STYLE_ID;
    style.textContent = `
      /* The house HUD grammar rides in from .hud-panel (B612 Mono 13px,
       * #00ff88 on rgba(5,10,20,0.95), 1px rgba(0,255,136,0.3) border). */
      #${CARGO_PANE_ID} {
        display: flex;
        flex-direction: column;
        pointer-events: auto;
        box-sizing: border-box;
        overflow: hidden;
        transition: top ${DENSITY_MOTION_MS}ms ${DENSITY_MOTION_EASING};
      }
      @media (prefers-reduced-motion: reduce) {
        #${CARGO_PANE_ID} { transition: none; }
      }
      /* The rung's ONE bit (HUD's catch-effects-style carries the global rule
       * too; this copy keeps the pane honest when it stands alone). */
      #${CARGO_PANE_ID}[${DENSITY_HIDDEN_ATTR}] { display: none !important; }
      /* Mode 'hidden': no room in the left stack. The density bit is untouched. */
      #${CARGO_PANE_ID}[${STACK_HIDDEN_ATTR}] { display: none !important; }
      #${CARGO_PANE_ID} .cargo-head {
        display: flex; align-items: baseline; gap: 8px;
        height: ${G.HEADER_PX}px; line-height: ${G.HEADER_PX}px; white-space: nowrap;
        flex: 0 0 auto;
      }
      #${CARGO_PANE_ID} .cargo-title { font-weight: bold; letter-spacing: 0.08em; }
      #${CARGO_PANE_ID} .cargo-fill { flex: 1 1 auto; text-align: right; }
      #${CARGO_PANE_ID} .cargo-worth { color: var(--hud-text, ${VisualLaw.COLORS.VALUE}); }
      #${CARGO_PANE_ID} .cargo-elev {
        height: ${G.PROGRESS_PX}px; font-size: 11px; line-height: 14px; opacity: 0.85;
        white-space: nowrap; flex: 0 0 auto;
      }
      #${CARGO_PANE_ID} .cargo-elev-track { height: 2px; margin-top: 2px; background: rgb(var(--hud-normal-rgb, 0 255 136) / 0.15); }
      #${CARGO_PANE_ID} .cargo-elev-bar { height: 2px; width: 0%; background: var(--hud-normal, ${VisualLaw.COLORS.PLAYER}); }
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
      #${CARGO_PANE_ID} .cargo-row-val { flex: 0 0 52px; text-align: right; color: var(--hud-text, ${VisualLaw.COLORS.VALUE}); }
      #${CARGO_PANE_ID} .cargo-empty { height: ${G.ROW_PX}px; line-height: ${G.ROW_PX}px; opacity: 0.5; }
      #${CARGO_PANE_ID}.cargo-glass .cargo-empty { height: ${G.ROW_GLASS_PX}px; line-height: ${G.ROW_GLASS_PX}px; }
      #${CARGO_PANE_ID} .cargo-foot { display: flex; gap: 8px; margin-top: ${G.FOOT_GAP_PX}px; flex: 0 0 auto; }
      #${CARGO_PANE_ID} .cargo-foot .cargo-btn { flex: 1 1 0; }
      /* Buttons: the StatusPanel .fleet-btn shape in the pane's green. */
      #${CARGO_PANE_ID} .cargo-btn {
        font: bold 11px/1.2 var(--font-mono);
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--hud-normal, ${VisualLaw.COLORS.PLAYER});
        background: rgb(var(--hud-normal-rgb, 0 255 136) / 0.08);
        border: 1px solid rgb(var(--hud-normal-rgb, 0 255 136) / 0.55);
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
      #${CARGO_PANE_ID} .cargo-btn:hover { background: rgb(var(--hud-normal-rgb, 0 255 136) / 0.18); border-color: var(--hud-normal, ${VisualLaw.COLORS.PLAYER}); }
      #${CARGO_PANE_ID} .cargo-btn:active { background: rgb(var(--hud-normal-rgb, 0 255 136) / 0.35); color: var(--hud-label, ${VisualLaw.COLORS.LABEL}); }
      #${CARGO_PANE_ID} .cargo-btn:focus { outline: none; }
      /* Mid-mission (not at the resupply stop): the button still takes the click (the shop answers it with the
       * reason in comms) but reads as unavailable. */
      #${CARGO_PANE_ID} .cargo-btn[data-closed] { opacity: 0.55; }
      #${CARGO_PANE_ID} .cargo-btn[aria-disabled="true"] { opacity: 0.35; cursor: default; pointer-events: none; }
      /* Compact: the header line + the two buttons; the progress line and the list fold away. */
      #${CARGO_PANE_ID}[${MODE_ATTR}="compact"] .cargo-elev,
      #${CARGO_PANE_ID}[${MODE_ATTR}="compact"] .cargo-list { display: none; }
    `;
    doc.head.appendChild(style);
  }

  _subscribe() {
    // The shop tells us when the resupply stop opens / closes (a plain callback, no EventBus event); a stub shop
    // without the hook is simply never told.
    const shop = this._shop;
    if (shop && typeof shop.onResupplyStopChange === 'function') {
      try {
        const off = shop.onResupplyStopChange(() => this._render());
        if (typeof off === 'function') this._unsubs.push(off);
      } catch (_e) { /* stub shop */ }
    }
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

  /** @private False only when the shop says it is mid-mission (`canTrade() === false`); a stub shop is permissive. */
  _tradeOpen() {
    const s = this._shop;
    if (!s || typeof s.canTrade !== 'function') return true;
    try { return s.canTrade() !== false; } catch (_e) { return true; }
  }

  /**
   * @private Mid-mission the button carries the full sentence as tooltip and accessible name and is dimmed
   * (data-closed); a click still goes to the shop, whose gate refuses it with the comms line. Write-on-change.
   * The visible text stays short: the footer is a fixed-budget row.
   */
  _wordTradeButton(btn, closed, openLabel, closedLabel) {
    if (!btn || !btn.setAttribute) return;
    const had = btn.hasAttribute ? btn.hasAttribute('data-closed') : false;
    if (closed === had && (!closed || btn.getAttribute('title') === closedLabel)) return;
    if (closed) {
      btn.setAttribute('data-closed', '');
      btn.setAttribute('title', closedLabel);
      btn.setAttribute('aria-label', closedLabel);
    } else {
      btn.removeAttribute('data-closed');
      btn.removeAttribute('title');
      if (openLabel) btn.setAttribute('aria-label', openLabel); else btn.removeAttribute('aria-label');
    }
  }

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

  _targetKg() {
    const ec = Constants && Constants.ELEVATOR_CONTRACT;
    const t = ec && Number(ec.TARGET_MASS_KG);
    return (Number.isFinite(t) && t > 0) ? t : 10000;
  }

  _sellRow(metalId) {
    const s = this._shop;
    if (this._disposed || !s || typeof s.sellMetal !== 'function') return;
    try { s.sellMetal(metalId); } finally { this._render(); }
  }

  _sellAll() {
    const s = this._shop;
    if (this._disposed || this._empty || !s || typeof s.sellAllCargo !== 'function') return;
    try { s.sellAllCargo(); } finally { this._render(); }
  }

  /** @private Contributes EVERY manifest item, stopping once getContractMass() reaches the target (the win fires in the shop). */
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
    const pct = clamp((contract / target) * 100, 0, 100);
    this._setText(el.elevLabel, `ELEVATOR ${fmt1(contract)} / ${fmtCap(target)} kg`);
    this._setStyle(el.elevBar, 'width', `${Math.round(pct * 10) / 10}%`);

    this._syncRows(items);
    this._setStyle(el.empty, 'display', empty ? '' : 'none');
    this._setDisabled(el.sellAll, empty);
    this._setDisabled(el.elevator, empty);
    // Mid-mission every sell / contribute button reads "... at the resupply stop".
    const closed = !this._tradeOpen();
    this._wordTradeButton(el.sellAll, closed, null, sellAtLine());
    this._wordTradeButton(el.elevator, closed, null, contributeAtLine());
    for (const rec of this._rows.values()) this._wordTradeButton(rec.btn, closed, null, sellAtLine());
    this._empty = empty;
    this._rowCount = Math.max(1, items.length);

    this._measure();
  }

  /** @private Reorders only when the order changed. */
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

  /** @private Returns true when a DOM write happened. Sets `top` BEFORE un-hiding. No layout reads. */
  _layout() {
    const root = this._root;
    if (!root || !Number.isFinite(this._stackTop)) return false;
    const stack = this._stackMode;
    const cargoMode = stack === 'compact' ? 'compact' : (stack === 'hidden' ? 'hidden' : 'full');
    const hidden = stack === 'hidden';
    const top = Math.round(this._stackTop);
    const maxH = hidden ? 0 : Math.round(Math.max(0, this._stackH));
    let wrote = false;
    // Top first so the reflow glides before display:none lifts.
    wrote = this._setStyle(root, 'top', `${top}px`) || wrote;
    if (cargoMode !== this._mode) {
      this._mode = cargoMode;
      root.setAttribute(MODE_ATTR, cargoMode);
      wrote = true;
    }
    if (hidden) {
      if (!root.hasAttribute(STACK_HIDDEN_ATTR)) { root.setAttribute(STACK_HIDDEN_ATTR, ''); wrote = true; }
    } else {
      if (root.hasAttribute(STACK_HIDDEN_ATTR)) { root.removeAttribute(STACK_HIDDEN_ATTR); wrote = true; }
      wrote = this._setStyle(root, 'maxHeight', `${maxH}px`) || wrote;
    }
    this._topPx = hidden ? null : top;
    this._expectedPx = hidden ? 0 : maxH;
    return wrote;
  }

  /** @private ONE offsetHeight read (fallback: the computed expectation). */
  _measure() {
    const root = this._root;
    if (!root) { this._heightPx = 0; return; }
    if (this._mode === 'hidden') { this._heightPx = 0; return; }
    const h = root.offsetHeight;
    this._heightPx = (typeof h === 'number' && h > 0) ? h : (this._expectedPx || 0);
  }

  _setText(el, text) {
    if (!el || el.textContent === text) return false;
    el.textContent = text;
    return true;
  }

  _setStyle(el, prop, value) {
    if (!el || !el.style || el.style[prop] === value) return false;
    el.style[prop] = value;
    return true;
  }

  /** @private The dim rule keys off aria-disabled. */
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
