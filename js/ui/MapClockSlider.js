/**
 * MapClockSlider.js — the map clock slider on floors 4 and 5 (owner 2026-11-18: "Floors 4-5 open at real speed (dots creep a
 * pixel or so a second). A slider sets pause / real / 10x / 100x / 1000x on the game's one clock, so everything stays in step").
 *
 * One row of five buttons (a stepped slider; each at least 44 px high and wide on every device): Pause, Real, 10x, 100x, 1000x.
 * The chosen step is lit. It owns no time: a pick calls `onPick(stepIndex)` and main.js's time block writes it into
 * `MapClock`, which feeds the TimeAuthority target. While a transfer trip sets the clock itself (burning), the row is dimmed and
 * cannot be picked, and the caption shows the trip's current speed instead (a trip never slows to real time).
 *
 * Shown on floors 4 and 5 only (`setShown`). Placement is set by `setLayout({ floor, glass, radio })` from main.js; it takes
 * pointer events itself and keeps them from the game under it. DOM-guarded: with no document every method is inert. Styles are
 * inline. The words come from `mapClockText.js` in the menu's language; digits are numbers and are not translated.
 *
 * @module ui/MapClockSlider
 */

import { MAP_CLOCK_TEXT, mapClockTextFor, NO_SPACING_LANGS } from './mapClockText.js';
import { SKY_PANEL_LIFT_VAR } from './RealSkyCard.js';

export const MAP_CLOCK_SLIDER_ID = 'map-clock-slider';
/** Hit-box minimum in CSS px (DECISIONS §32: touch targets at least 44 px). */
export const BUTTON_MIN_PX = 44;

/** What a step button says. Pause and Real are words (translated); the rest are numbers. */
const STEP_LABELS = ['@pause', '@real', '10\u00d7', '100\u00d7', '1000\u00d7'];

/**
 * The speed a rate reads as, in game seconds per real second: "0", "1", "10", "100", "1000" (a rate between steps rounds).
 * @param {number} rate TimeAuthority rate (BASE_SCALE multiples)
 * @param {number} baseScale game seconds per real second at rate 1
 * @returns {string}
 */
export function speedText(rate, baseScale = 10) {
  const v = Math.max(0, Number(rate) || 0) * baseScale;
  if (v < 0.05) return '0\u00d7';
  if (v < 10) return `${Math.round(v * 10) / 10}\u00d7`;
  return `${Math.round(v).toLocaleString('en-US')}\u00d7`;
}

/** The bottom-right corner's inset from the window edge (px), the real-sky panel's own. */
export const EDGE_PX = 12;

/**
 * Where the row sits (owner 2026-11-19, DECISIONS §78 row 12). Floor 4: the bottom-right corner (12 px in; the bottom-centre holds REACH and
 * the FLY THERE button, the left the hint box). On touch the real-sky panel holds that corner (his 11-17 pick), so the row stands directly
 * above it, right edges aligned, its bottom edge = 12 px + the panel's live height (`--sky-panel-lift`, set by RealSkyCard, so a tapped dot's
 * taller card pushes it up). Floor 5: the left edge, top 800 px (or 230 px above the bottom on a shorter window): the gap between the Kessler
 * timeline (from y 920) and the left column, measured 2026-11-18 (tmp/clockshots/layout.mjs, 1366x1024 and 1728x1117). Pure.
 * @param {{floor:number|null, glass:boolean}} p
 * @returns {{left:string, top:string, right:string, bottom:string}}
 */
export function sliderPlacement(p) {
  const p0 = p || {};
  const right = `calc(${EDGE_PX}px + env(safe-area-inset-right, 0px))`;
  const bottom = `calc(${EDGE_PX}px + env(safe-area-inset-bottom, 0px))`;
  if (p0.floor === 4 && p0.glass) {
    // iPad: the real-sky panel holds the corner (right 12 px, bottom 12 px + safe area); stand directly above it, right edges aligned, and follow its height (a tapped dot's card makes it taller)
    return { left: 'auto', top: 'auto', right: `${EDGE_PX}px`, bottom: `calc(${EDGE_PX}px + env(safe-area-inset-bottom, 0px) + var(${SKY_PANEL_LIFT_VAR}, 0px))` };
  }
  if (p0.floor === 4) return { left: 'auto', top: 'auto', right, bottom };
  return { left: `${EDGE_PX}px`, top: 'min(800px, calc(100vh - 230px))', right: 'auto', bottom: 'auto' };
}

export class MapClockSlider {
  /**
   * @param {object} [deps]
   * @param {Document} [deps.document]
   * @param {function} [deps.getLanguage] () => language code; read again on every show / repaint
   * @param {function} [deps.onPick] (stepIndex) => void
   */
  constructor(deps = {}) {
    this._doc = deps.document !== undefined ? deps.document : (typeof document !== 'undefined' ? document : null);
    this._getLanguage = typeof deps.getLanguage === 'function' ? deps.getLanguage : () => 'en';
    this._onPick = typeof deps.onPick === 'function' ? deps.onPick : null;
    this._root = null;
    this._buttons = [];
    this._caption = null;
    this._shown = false;
    this._step = 1;
    this._locked = false;
    this._tripText = '';
    this._lang = null;
    this._placed = '';
  }

  /** @returns {boolean} */
  isShown() { return this._shown; }
  /** @returns {number} the lit step */
  litStep() { return this._step; }
  /** @returns {boolean} the row is dimmed (a trip sets the clock) */
  isLocked() { return this._locked; }

  /** @param {boolean} on show on floors 4-5, hide elsewhere (write-on-change) */
  setShown(on) {
    on = !!on;
    if (on === this._shown) return;
    this._shown = on;
    if (!this._doc) return;
    if (on) this._build();
    if (this._root) this._root.style.display = on ? 'flex' : 'none';
    if (on) this._paintText();
  }

  /**
   * Light a step and dim the row while a trip sets the clock. Write-on-change; cheap per frame.
   * @param {number} step the MapClock choice
   * @param {boolean} locked a transfer trip is burning
   * @param {string} [tripSpeed] the trip's current speed text ("100x"), shown as the caption while locked
   */
  setState(step, locked, tripSpeed = '') {
    locked = !!locked;
    const changed = step !== this._step || locked !== this._locked || (locked && tripSpeed !== this._tripText);
    this._step = step;
    this._locked = locked;
    this._tripText = locked ? String(tripSpeed || '') : '';
    if (changed && this._root) this._paintState();
  }

  /** @param {{floor?:number|null, glass?:boolean}} p write-on-change placement */
  setLayout(p) {
    if (!this._root) return;
    const pl = sliderPlacement(p);
    const key = `${pl.left}|${pl.top}|${pl.right}|${pl.bottom}`;
    if (key === this._placed) return;
    this._placed = key;
    this._root.style.left = pl.left;
    this._root.style.top = pl.top;
    this._root.style.right = pl.right;
    this._root.style.bottom = pl.bottom;
  }

  /** Language read again (the menu's picker can change it between games). */
  refreshLanguage() { if (this._root && this._shown) this._paintText(); }

  _build() {
    if (this._root || !this._doc) return;
    const doc = this._doc;
    const root = doc.createElement('div');
    root.id = MAP_CLOCK_SLIDER_ID;
    root.setAttribute('role', 'group');
    root.style.cssText = 'position:fixed;left:12px;top:min(800px,calc(100vh - 230px));z-index:36;display:none;flex-direction:column;'
      + 'align-items:center;gap:2px;pointer-events:auto;box-sizing:border-box;padding:4px 6px 6px;border-radius:8px;'
      + 'background:rgba(8,12,22,0.78);border:1px solid rgba(160,180,220,0.28);color:#dbe4f5;font-family:var(--font-mono);'
      + 'font-size:11px;line-height:1.2;user-select:none;-webkit-user-select:none;touch-action:manipulation;';
    const caption = doc.createElement('div');
    caption.style.cssText = 'font-size:10px;opacity:0.8;white-space:nowrap;';
    root.appendChild(caption);
    const row = doc.createElement('div');
    row.style.cssText = 'display:flex;gap:3px;';
    this._buttons = STEP_LABELS.map((_, i) => {
      const b = doc.createElement('button');
      b.setAttribute('type', 'button');
      b.setAttribute('tabindex', '-1');                        // a focused button would take Space / Enter from the game
      b.setAttribute('data-step', String(i));
      b.style.cssText = `min-width:${BUTTON_MIN_PX}px;min-height:${BUTTON_MIN_PX}px;box-sizing:border-box;padding:0 8px;`
        + 'font:inherit;font-size:12px;font-weight:700;cursor:pointer;border-radius:6px;white-space:nowrap;'
        + 'background:rgba(20,30,50,0.9);color:#dbe4f5;border:1px solid rgba(160,180,220,0.35);';
      b.addEventListener('mousedown', (e) => { if (e && e.preventDefault) e.preventDefault(); });   // keep focus on the game
      b.addEventListener('click', (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        if (this._locked) return;
        if (this._onPick) this._onPick(i);
      });
      row.appendChild(b);
      return b;
    });
    root.appendChild(row);
    // The game under the row never sees a press, drag or wheel on it.
    for (const ev of ['pointerdown', 'pointerup', 'pointermove', 'touchstart', 'touchend', 'wheel', 'contextmenu']) {
      root.addEventListener(ev, (e) => { if (e && e.stopPropagation) e.stopPropagation(); });
    }
    (doc.body || doc.documentElement).appendChild(root);
    this._root = root;
    this._caption = caption;
    this._paintState();
  }

  _paintText() {
    const code = this._getLanguage() || 'en';
    this._lang = code;
    const t = mapClockTextFor(code);
    const plain = NO_SPACING_LANGS.includes(code);
    if (this._root) {
      this._root.setAttribute('aria-label', t.aria);
      this._root.style.letterSpacing = plain ? 'normal' : '0.02em';
      this._root.style.textTransform = plain ? 'none' : '';
    }
    this._buttons.forEach((b, i) => {
      const lab = STEP_LABELS[i];
      const text = lab === '@pause' ? t.pause : lab === '@real' ? t.real : lab;
      if (b.textContent !== text) b.textContent = text;
      b.title = lab === '@real' ? t.realTitle : '';
    });
    this._paintState();
  }

  _paintState() {
    if (!this._root) return;
    const t = mapClockTextFor(this._lang || this._getLanguage() || 'en');
    const cap = this._locked ? `${t.trip} ${this._tripText}`.trim() : t.caption;
    if (this._caption && this._caption.textContent !== cap) this._caption.textContent = cap;
    this._root.style.opacity = this._locked ? '0.5' : '1';
    this._buttons.forEach((b, i) => {
      const on = i === this._step;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.disabled = this._locked;
      b.style.background = on ? 'rgba(80,150,255,0.55)' : 'rgba(20,30,50,0.9)';
      b.style.borderColor = on ? '#8fc0ff' : 'rgba(160,180,220,0.35)';
    });
  }
}

export { MAP_CLOCK_TEXT };
export default MapClockSlider;
