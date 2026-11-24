/**
 * MapClockSlider.js — the map clock slider on floors 4 and 5 (owner 2026-11-18: "Floors 4-5 open at real speed (dots creep a
 * pixel or so a second). A slider sets pause / real / 10x / 100x / 1000x on the game's one clock, so everything stays in step").
 *
 * One row of five buttons (a stepped slider; each at least 44 px high and wide on every device): Pause, Real, 10x, 100x, 1000x.
 * The chosen step is lit. It owns no time: a pick calls `onPick(stepIndex)` and main.js's time block writes it into
 * `MapClock`, which feeds the TimeAuthority target. While a transfer trip sets the clock itself (burning), the row is dimmed and
 * cannot be picked, and the caption shows the trip's current speed instead (a trip never slows to real time). While a daughter is
 * NEAR her piece (from 400 m out until she holds it) the clock runs at real speed (DECISIONS §70 row 10): Real is lit, 10x / 100x /
 * 1000x are dimmed and cannot be picked (title "Real speed near a daughter's piece"). While one is out but none is near the clock runs at
 * the field's speed, 10x at most: her step or 10x is lit, 100x / 1000x are dimmed (title "Field speed while a daughter is out"). Pause
 * can always be picked; the choice is kept and lights again when she is home. The two titles are in `mapClockText.js` (7 languages).
 *
 * Shown on floors 4 and 5 only (`setShown`). Placement is set by `setLayout({ floor, glass, radio })` from main.js; it takes
 * pointer events itself and keeps them from the game under it. DOM-guarded: with no document every method is inert. Styles are
 * inline. The words come from `mapClockText.js` in the menu's language; digits are numbers and are not translated.
 *
 * @module ui/MapClockSlider
 */

import { MAP_CLOCK_TEXT, mapClockTextFor, NO_SPACING_LANGS } from './mapClockText.js';

export const MAP_CLOCK_SLIDER_ID = 'map-clock-slider';
/** Hit-box minimum in CSS px (DECISIONS §32: touch targets at least 44 px). */
export const BUTTON_MIN_PX = 44;

/** What a step button says. Pause and Real are words (translated); the rest are numbers. */
const STEP_LABELS = ['@pause', '@real', '10\u00d7', '100\u00d7', '1000\u00d7'];

/** The steps above this one are dimmed and cannot be picked while a daughter is near her piece (index 1 = Real). */
export const NEAR_MAX_STEP = 1;
/** The steps above this one are dimmed while a daughter is out but none is near (index 2 = 10x: the field's rate, `TimeAuthority.FIELD_CAP`). */
export const OUT_MAX_STEP = 2;
/** The English tooltips (the words live in `mapClockText.js`, `nearTitle` / `outTitle`, all 7 languages). */
export const DAUGHTER_NEAR_TITLE = MAP_CLOCK_TEXT.en.nearTitle;
export const DAUGHTER_OUT_TITLE = MAP_CLOCK_TEXT.en.outTitle;

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

/** The left-edge spot's inset from the window edge (px; floor 5 elsewhere). The top-right corner has none: see `sliderPlacement`. */
export const EDGE_PX = 12;
/** The least width of the box in the top-right corner (px; the English row is about 281 wide): the object panel under it is exactly as wide (RealSkyCard SKY_COLUMN_MIN_W_PX, the same number). */
export const CORNER_MIN_W_PX = 284;

/**
 * Where the row sits. Sky 30 (owner 2026-11-24, DECISIONS §102 row 7: "consider moving time buttons to top right on all 3 screens. consistent"): the globe (floor 4)
 * and page 1 (floor 5's debris chart) put it at the TOP-RIGHT corner, on the Mac and the iPad alike. Sky 30 F (owner 2026-11-24 14:45Z: "comms pane is really top
 * right. all the way top, all the way right"): flush in that corner, exactly where the radio box (`#hud-comms-panel`) sits on floor 2 (measured top 0, right 0 on
 * both screens; only the safe-area insets keep it off a notch), with no border or round corner on the sides that touch the screen. The object panel stands
 * directly under it on both screens (RealSkyCard `panelPlacement`, top = the row's height less the shared 1 px border), and the radio box and right column dodge
 * under that (RealSkyCard `_syncDodge`). Until Sky 30 the row was at the bottom right (on touch lifted over the panel by `--sky-panel-lift`; gone). Page 2 hides
 * the control (main.js). Floor 5 elsewhere: the old left-edge spot, top 800 px or 230 px above the bottom, stays for any other caller. Pure.
 * @param {{floor:number|null, glass:boolean, page1?:boolean}} p `page1`: floor 5 shows the debris page
 * @returns {{left:string, top:string, right:string, bottom:string, corner:boolean}} `corner`: the flush top-right form
 */
export function sliderPlacement(p) {
  const p0 = p || {};
  const globeSpot = p0.floor === 4 || (p0.floor === 5 && p0.page1 === true);
  if (globeSpot) return { left: 'auto', top: 'env(safe-area-inset-top, 0px)', right: 'env(safe-area-inset-right, 0px)', bottom: 'auto', corner: true };
  return { left: `${EDGE_PX}px`, top: 'min(800px, calc(100vh - 230px))', right: 'auto', bottom: 'auto', corner: false };
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
    this._out = false;
    this._near = false;
    this._tripText = '';
    this._titles = [];
    this._lang = null;
    this._placed = '';
  }

  /** @returns {boolean} */
  isShown() { return this._shown; }
  /** @returns {number} the highest step she can pick now: Real near a piece, 10x out on the far leg, else all (a burning trip: the trip sets it) */
  maxStep() { return this._locked ? Infinity : (this._out && this._near) ? NEAR_MAX_STEP : this._out ? OUT_MAX_STEP : Infinity; }
  /** @returns {number} the lit step: while a daughter is out a faster choice reads as the cap (the choice itself is kept in MapClock) */
  litStep() { return Math.min(this._step, this.maxStep()); }
  /** @returns {boolean} the row is dimmed (a trip sets the clock) */
  isLocked() { return this._locked; }
  /** @returns {boolean} a daughter is out: the faster steps are dimmed and cannot be picked */
  isDaughterOut() { return this._out && !this._locked; }
  /** @returns {boolean} a daughter is near her piece: only Pause and Real can be picked */
  isDaughterNear() { return this._out && this._near && !this._locked; }

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
   * @param {boolean} [daughterOut] a daughter is out: steps above 10x are dimmed and cannot be picked (her step or 10x is lit); Pause
   *   still can. Her choice is not changed: it returns when she is home. A burning trip wins.
   * @param {boolean} [daughterNear] a daughter is near her piece (implies out): the clock is at real speed, Real is lit and the steps above
   *   it are dimmed
   */
  setState(step, locked, tripSpeed = '', daughterOut = false, daughterNear = false) {
    locked = !!locked;
    daughterNear = !!daughterNear;
    daughterOut = !!daughterOut || daughterNear;
    const changed = step !== this._step || locked !== this._locked || daughterOut !== this._out || daughterNear !== this._near
      || (locked && tripSpeed !== this._tripText);
    this._step = step;
    this._locked = locked;
    this._out = daughterOut;
    this._near = daughterNear;
    this._tripText = locked ? String(tripSpeed || '') : '';
    if (changed && this._root) this._paintState();
  }

  /** @param {{floor?:number|null, glass?:boolean, page1?:boolean}} p write-on-change placement */
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
    // The corner form touches two screen edges: no border or round corner there (the radio box does the same); the 1 px of top border comes back as padding,
    // so the row stays as tall as before (RealSkyCard SKY_CLOCK_H_PX). It is never narrower than the panel under it.
    const s = this._root.style;
    s.borderTopWidth = pl.corner ? '0' : '1px';
    s.borderRightWidth = pl.corner ? '0' : '1px';
    s.paddingTop = pl.corner ? '5px' : '4px';
    s.borderRadius = pl.corner ? '0' : '8px';
    s.minWidth = pl.corner ? `${CORNER_MIN_W_PX}px` : '';
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
        if (i > this.maxStep()) return;   // a daughter is out: the clock is real speed near her piece (10x at most on the far leg), the faster steps wait for her
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
      this._titles[i] = lab === '@real' ? t.realTitle : '';
    });
    this._paintState();
  }

  _paintState() {
    if (!this._root) return;
    const t = mapClockTextFor(this._lang || this._getLanguage() || 'en');
    const out = this._out && !this._locked;
    const maxStep = this.maxStep();
    const why = out ? (this._near ? t.nearTitle : t.outTitle) : '';
    const cap = this._locked ? `${t.trip} ${this._tripText}`.trim() : t.caption;
    if (this._caption && this._caption.textContent !== cap) this._caption.textContent = cap;
    this._root.style.opacity = this._locked ? '0.5' : '1';
    const lit = this.litStep();
    this._buttons.forEach((b, i) => {
      const on = i === lit;
      const wait = i > maxStep;   // dimmed and not clickable while a daughter is out (above Real near a piece, above 10x on the far leg)
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.disabled = this._locked || wait;
      b.style.opacity = wait ? '0.4' : '';
      b.style.cursor = wait ? 'not-allowed' : 'pointer';
      b.style.background = on ? 'rgba(80,150,255,0.55)' : 'rgba(20,30,50,0.9)';
      b.style.borderColor = on ? '#8fc0ff' : 'rgba(160,180,220,0.35)';
      const title = (out && (wait || (on && this._step >= maxStep))) ? why : (this._titles[i] || '');
      if (b.title !== title) b.title = title;
    });
    const rootTitle = why;
    if (this._root.title !== rootTitle) this._root.title = rootTitle;
  }
}

export { MAP_CLOCK_TEXT };
export default MapClockSlider;
