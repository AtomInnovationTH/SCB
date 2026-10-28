/**
 * DetailSlider.js — the DETAIL slider: one horizontal "volume knob" for how many HUD panels show (owner 2026-09-07:
 * "is the rail even needed… volume control"). A track, one tick per pane-density rung, a thumb at the current visible
 * count. Drag or tap → `onLevel(n)`; the hub walks PaneDensity.setLevel(n, { quiet: true }). No labels, no toast:
 * the slider IS the readout.
 *
 * It owns no order and no memory: the SHED ORDER is PaneDensity's rung list, the slider only walks it; per-floor
 * room memory comes from the real down()/up() steps' `_onFlip` (HUD_PANE_VISIBILITY capture), like the `-`/`+` keys.
 * Level 0 is PURE SCENERY: the hub answers `visibleCount() === 0` with `LadderController.setRailsShy(true)`; the
 * slider itself stays wakeable (its visibility is EdgeChrome's; it is NOT in the body[data-pure-scenery] CSS rule,
 * otherwise level 0 would be a trap on glass).
 *
 * Placement: the FOOTER BAND's RIGHT slot (DECISIONS §13 ruling 5): `position:fixed; right:EDGE_PX;
 * bottom:footerBottomPx; height:FOOTER_BAND_PX`, the hub passes `footerBand().bottom`. On GLASS the hit box is
 * TOUCH_PITCH_PX (44) tall: 6 px of transparent padding above and below the 32 px band, the root shifted down by 6
 * so the VISUAL band still sits at footerBottomPx. F2–F5 only: the hub calls `setShown(floor !== 1)`.
 *
 * Edge chrome: no idle timer of its own. The hub reads `edgeChrome.phase('slider', now)` per frame and calls
 * `setPhase(phase)`: 'awake' → opacity 1 / visible; 'fading' → opacity IDLE_FADE; 'hidden' → visibility hidden.
 * Its own pointerdown / pointermove call `onInteract()`; release calls NOTHING.
 *
 * Laws: no text at all (the aria values are the only words); colours from VisualLaw (INFO for track and ticks,
 * PLAYER for the thumb); no HTML strings (createElement only); no timers / rAF (the refresh throttle reads the
 * caller clock); no window / document listeners (four pointer listeners on its own root); never reads the game's
 * constants table; never touches the DOM at import time; constructible headless (no document: every method
 * callable, nothing thrown); every DOM write is write-on-change; emoji-free.
 *
 * 17 detents (levels 0..16) with a 3 px drag dead-zone past each detent boundary so a thumb held still never
 * flickers. The slider shows only the positions that can show right now (up to 14: the alerts ride the last HUD pane
 * and city labels ride the ships, so neither is a position); the milestones are read live. Ships = position 1.
 *
 * @module ui/DetailSlider
 */

import { RAIL_GEOMETRY } from './RailGeometry.js';
import { VisualLaw } from '../core/VisualLaw.js';
import { shortScreenNow, watchShortScreen } from './hud/PhoneFold.js';

/** The root element id (the probe reads its rect, aria-valuenow and tick count). */
export const DETAIL_SLIDER_ID = 'ladder-detail-slider';

export const DETAIL_SLIDER_STYLE_ID = 'detail-slider-style';

/** Unforced `refresh()` reads the density at most this often (ms). */
export const REFRESH_MIN_MS = 250;

export const TRACK_WIDTH_PX = 160;

/**
 * Drag hysteresis: a level change while dragging commits only once the pointer has moved ≥ this many CSS px
 * PAST the detent boundary it would cross. Tap / first contact and release ignore it.
 */
export const DEADZONE_PX = 3;

/** Horizontal padding inside the root so the thumb has room at 0 % and 100 %. */
const SIDE_PAD_PX = 8;

/** @private '#rrggbb' → 'rgba(r,g,b,a)' */
const _rgba = (hex, a) => {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

/** @private finite unique sorted LEVEL indices; non-arrays → []. */
const _normalizeMilestones = (arr) => {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  out.sort((a, b) => a - b);
  return out;
};

/** Short screens: the slider's visual-band bottom (px), bottom centre. */
const SHORT_BOTTOM_PX = 8;

/**
 * Where the slider sits on a SHORT screen (phone sideways), in CSS px, from the same numbers `_applyPlacement` /
 * `_build` use: bottom centre, `SHORT_BOTTOM_PX` above the screen bottom (the visual band), width = track + side
 * padding, height = the 44 px glass box or the footer band. main.js `_edgeBandWake` reads it so a tap on the
 * slider's own spot wakes it.
 * @param {number} viewW  innerWidth
 * @param {number} viewH  innerHeight
 * @param {boolean} glass  touch device (the 44 px hit box)
 * @returns {{left:number, top:number, right:number, bottom:number, width:number, height:number}}
 */
export function shortSliderRect(viewW, viewH, glass) {
  const pad = glass ? (RAIL_GEOMETRY.TOUCH_PITCH_PX - RAIL_GEOMETRY.FOOTER_BAND_PX) / 2 : 0;
  const height = glass ? RAIL_GEOMETRY.TOUCH_PITCH_PX : RAIL_GEOMETRY.FOOTER_BAND_PX;
  const width = TRACK_WIDTH_PX + 2 * SIDE_PAD_PX;
  const bottom = viewH - (SHORT_BOTTOM_PX - pad);
  const left = viewW / 2 - width / 2;
  return { left, top: bottom - height, right: left + width, bottom, width, height };
}

export class DetailSlider {
  /**
   * @param {object} [deps]
   * @param {function} [deps.total]          () → rung count (the range max). Guarded: throw / NaN → 0.
   * @param {function} [deps.level]          () → current visible count (the thumb). Guarded.
   * @param {function} [deps.onLevel]        (n) — every DETENT CHANGE while dragging / tapping; never on release.
   * @param {function} [deps.onInteract]     () — pointerdown and every pointermove that moved; never on release.
   * @param {number}   [deps.footerBottomPx] CSS bottom of the VISUAL band (the hub passes footerBand().bottom).
   *                                         Default THUMB_REST_PX + FOOTER_GAP_PX when absent / non-finite.
    * @param {boolean}  [deps.glass]          true → the 44 pt hit box (6 px pads, bottom shifted down 6).
    * @param {Window|null} [deps.win]         window for the short-screen answer (default: the global one; none = tall).
    *                                         On a SHORT screen (innerHeight < 500, live) the slider sits bottom
    *                                         centre so it never covers the right column.
    * @param {boolean}  [deps.reducedMotion]  true → inline `transition:none` on the root.
    * @param {number[]} [deps.milestones]     LEVEL indices whose ticks render bold (thicker /
    *                                         longer). Default []. main.js also calls setMilestones after splicing.
    * @param {Document|null} [deps.doc]       document (default: the global one; null = headless, inert).
    * @param {function} [deps.now]            ms clock for the refresh throttle (default performance.now).
    */
  constructor(deps = {}) {
    this._total = typeof deps.total === 'function' ? deps.total : null;
    this._level = typeof deps.level === 'function' ? deps.level : null;
    this._onLevel = typeof deps.onLevel === 'function' ? deps.onLevel : null;
    this._onInteract = typeof deps.onInteract === 'function' ? deps.onInteract : null;
    this._milestones = _normalizeMilestones(deps.milestones);
    this._milestoneFn = null;
    const fb = Number(deps.footerBottomPx);
    this._footerBottomPx = Number.isFinite(fb) ? fb : (RAIL_GEOMETRY.THUMB_REST_PX + RAIL_GEOMETRY.FOOTER_GAP_PX);
    this._glass = deps.glass === true;
    this._reducedMotion = deps.reducedMotion === true;
    this._doc = deps.doc !== undefined ? deps.doc
      : (typeof document !== 'undefined' ? document : null);
    this._now = typeof deps.now === 'function' ? deps.now : null;
    this._win = deps.win !== undefined ? deps.win : (typeof window !== 'undefined' ? window : null);
    this._placed = 'tall';
    this._unwatchShort = null;
    this._placeWrites = 0;

    this._root = null;
    this._track = null;
    this._thumb = null;
    this._ticks = [];
    this._listeners = [];
    this._disposed = false;
    this._shown = true;
    this._phase = null;
    this._wroteTotal = null;
    this._wroteLevel = null;
    this._readAt = -Infinity;
    this._active = false;
    this._rect = null;
    this._lastEmitted = null;
    this._lastX = null;
    this._lastY = null;

    this._build();
  }

  /**
   * Re-read `level()` / `total()` (throttled unless forced); rewrites ticks, thumb and aria values on change.
   * @param {{force?:boolean}} [opts]
   * @returns {boolean} whether the density was read this call
   */
  refresh({ force = false } = {}) {
    if (this._disposed || !this._root) return false;
    const t = this._clock();
    if (!force && Number.isFinite(t) && (t - this._readAt) < REFRESH_MIN_MS) return false;
    if (Number.isFinite(t)) this._readAt = t;
    const total = this._readTotal();
    const level = Math.max(0, Math.min(total, this._readLevel()));
    if (total !== this._wroteTotal) {
      this._wroteTotal = total;
      this._rebuildTicks(total);
      this._setAttr('aria-valuemax', String(total));
      this._wroteLevel = null;              // the thumb's percentage changed base
    }
    if (this._milestoneFn) this.setMilestones(this._milestoneFn);
    if (level !== this._wroteLevel) {
      this._wroteLevel = level;
      this._setAttr('aria-valuenow', String(level));
      if (this._thumb) this._thumb.style.left = DetailSlider.pct(level, total);
    }
    return true;
  }

  /**
   * Whether the slider is on this floor at all (F2–F5). Independent of the edge-chrome phase.
   * @param {boolean} on
   */
  setShown(on) {
    const want = on !== false;
    if (want === this._shown) return;
    this._shown = want;
    if (this._root) this._root.style.display = want ? '' : 'none';
  }

  /**
   * The edge-chrome phase: 'awake' → opacity 1 + visible; 'fading' → opacity IDLE_FADE (the transition ramps);
   * 'hidden' (or unknown) → visibility hidden + opacity at rest.
   * @param {'awake'|'fading'|'hidden'} phase
   */
  setPhase(phase) {
    const ph = (phase === 'awake' || phase === 'fading') ? phase : 'hidden';
    if (ph === this._phase) return;
    this._phase = ph;
    if (!this._root) return;
    const s = this._root.style;
    if (ph === 'awake') {
      s.opacity = '1';
      s.visibility = 'visible';
    } else if (ph === 'fading') {
      s.opacity = String(RAIL_GEOMETRY.IDLE_FADE);
    } else {
      s.visibility = 'hidden';
      s.opacity = String(RAIL_GEOMETRY.IDLE_FADE);
    }
  }

  /**
   * Bold-tick LEVEL indices. main.js computes these from the live ladder after the rungs are spliced.
   * Rebuilds ticks when a refresh has already painted them. A function instead of an array is kept and re-read on
   * every unthrottled `refresh()`, so the bold ticks follow a position count that changes (first scan, floor change).
   * @param {number[]|function(): number[]} arr
   */
  setMilestones(arr) {
    if (typeof arr === 'function') {
      this._milestoneFn = arr;
      arr = this._readMilestones();
    } else {
      this._milestoneFn = null;
    }
    const next = _normalizeMilestones(arr);
    if (next.length === this._milestones.length && next.every((v, i) => v === this._milestones[i])) return;
    this._milestones = next;
    if (!this._disposed && this._track && this._wroteTotal != null) this._rebuildTicks(this._wroteTotal);
  }

  /** @private guarded: a throwing source keeps the last milestones */
  _readMilestones() {
    try { return this._milestoneFn ? this._milestoneFn() : this._milestones; } catch (_e) { return this._milestones; }
  }

  /** @returns {Element|null} the root (null headless / disposed) */
  element() { return this._root; }

  isShown() { return this._shown; }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._unwatchShort) { try { this._unwatchShort(); } catch (_e) { /* stub */ } this._unwatchShort = null; }
    const root = this._root;
    if (root) {
      for (const [type, fn] of this._listeners) {
        try { if (typeof root.removeEventListener === 'function') root.removeEventListener(type, fn); } catch (_e) { /* stub */ }
      }
      try { if (typeof root.remove === 'function') root.remove(); } catch (_e) { /* stub */ }
    }
    this._listeners = [];
    this._root = null;
    this._track = null;
    this._thumb = null;
    this._ticks = [];
  }

  /**
   * The detent under a pointer x: round((x − left) / width × total), clamped to 0..total. A zero / unmeasured width reads 0.
   * @param {number} x @param {number} left @param {number} width @param {number} total
   */
  static detentFor(x, left, width, total) {
    const n = Math.max(0, Math.round(Number(total) || 0));
    const w = Number(width);
    if (!(w > 0) || n === 0) return 0;
    const raw = Math.round(((Number(x) - Number(left)) / w) * n);
    return Math.max(0, Math.min(n, Number.isFinite(raw) ? raw : 0));
  }

  /**
   * Drag hysteresis around detentFor: a change from `current` commits only once x is ≥ deadzonePx past the boundary
   * being crossed. `current` null / non-finite → detentFor (tap / first contact).
   * @param {number} x @param {number} left @param {number} width @param {number} total
   * @param {number|null} current @param {number} [deadzonePx]
   */
  static detentForDrag(x, left, width, total, current, deadzonePx = DEADZONE_PX) {
    const raw = DetailSlider.detentFor(x, left, width, total);
    if (current == null) return raw;
    const cur = Math.round(Number(current));
    if (!Number.isFinite(cur) || raw === cur) return raw;
    const n = Math.max(0, Math.round(Number(total) || 0));
    const w = Number(width);
    const dz = Number(deadzonePx);
    if (!(w > 0) || n === 0 || !(dz > 0)) return raw;
    const dir = raw > cur ? 1 : -1;
    const boundary = Number(left) + ((cur + dir * 0.5) / n) * w;
    const commitAt = boundary + dir * dz;
    if (dir > 0 && Number(x) < commitAt) return cur;
    if (dir < 0 && Number(x) > commitAt) return cur;
    return raw;
  }

  /** The thumb / tick position as a CSS percentage of the track. @param {number} i @param {number} total */
  static pct(i, total) {
    const n = Number(total);
    if (!(n > 0)) return '0%';
    return `${(Math.max(0, Math.min(n, i)) / n) * 100}%`;
  }

  /**
   * @private Short screens (phone sideways): bottom centre, `bottom: 8px` less the glass pad (so the 44 px hit box
   * keeps its 6 px pads), clear of the right column. Tall screens: the footer-right slot. Writes only when the answer flips.
   * @param {boolean} short
   */
  _applyPlacement(short) {
    const root = this._root;
    if (!root || this._disposed) return;
    const want = short ? 'short' : 'tall';
    if (want === this._placed) return;
    this._placed = want;
    this._placeWrites++;
    const s = root.style;
    const pad = this._pad || 0;
    if (short) {
      s.left = '50%';
      s.transform = 'translateX(-50%)';
      s.right = 'auto';
      s.bottom = `${SHORT_BOTTOM_PX - pad}px`;
    } else {
      s.left = '';
      s.transform = '';
      s.right = `${RAIL_GEOMETRY.EDGE_PX}px`;
      s.bottom = `${this._footerBottomPx - pad}px`;
    }
  }

  _build() {
    const doc = this._doc;
    if (!doc || typeof doc.createElement !== 'function' || !doc.body || typeof doc.body.appendChild !== 'function') return;
    this._ensureStyle();
    const root = doc.createElement('div');
    root.id = DETAIL_SLIDER_ID;
    root.className = 'ds-root';
    const pad = this._glass ? (RAIL_GEOMETRY.TOUCH_PITCH_PX - RAIL_GEOMETRY.FOOTER_BAND_PX) / 2 : 0;
    const height = this._glass ? RAIL_GEOMETRY.TOUCH_PITCH_PX : RAIL_GEOMETRY.FOOTER_BAND_PX;
    const s = root.style;
    s.position = 'fixed';
    s.right = `${RAIL_GEOMETRY.EDGE_PX}px`;
    s.bottom = `${this._footerBottomPx - pad}px`;
    this._pad = pad;
    s.height = `${height}px`;
    s.width = `${TRACK_WIDTH_PX + 2 * SIDE_PAD_PX}px`;
    s.padding = `${pad}px ${SIDE_PAD_PX}px`;
    s.boxSizing = 'border-box';
    s.zIndex = '35';
    s.touchAction = 'none';
    s.pointerEvents = 'auto';
    s.visibility = 'hidden';                 // asleep at birth: EdgeChrome decides via setPhase
    s.opacity = String(RAIL_GEOMETRY.IDLE_FADE);
    if (this._reducedMotion) s.transition = 'none';
    this._setAttrOn(root, 'role', 'slider');
    this._setAttrOn(root, 'aria-label', 'DETAIL');
    this._setAttrOn(root, 'aria-valuemin', '0');
    this._setAttrOn(root, 'aria-valuemax', '0');
    this._setAttrOn(root, 'aria-valuenow', '0');
    this._setAttrOn(root, 'tabindex', '-1');

    const track = doc.createElement('div');
    track.className = 'ds-track';
    const thumb = doc.createElement('div');
    thumb.className = 'ds-thumb';
    thumb.style.left = '0%';
    track.appendChild(thumb);
    root.appendChild(track);
    doc.body.appendChild(root);

    this._root = root;
    this._track = track;
    this._thumb = thumb;
    this._applyPlacement(shortScreenNow(this._win));
    this._unwatchShort = watchShortScreen(this._win, (short) => this._applyPlacement(short));

    const on = (type, fn) => {
      if (typeof root.addEventListener !== 'function') return;
      root.addEventListener(type, fn);
      this._listeners.push([type, fn]);
    };
    on('pointerdown', (e) => this._down(e));
    on('pointermove', (e) => this._move(e));
    on('pointerup', (e) => this._up(e));
    on('pointercancel', (e) => this._up(e));
  }

  _ensureStyle() {
    const doc = this._doc;
    if (!doc || !doc.head || typeof doc.head.appendChild !== 'function') return;
    if (typeof doc.getElementById === 'function' && doc.getElementById(DETAIL_SLIDER_STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = DETAIL_SLIDER_STYLE_ID;
    const info = VisualLaw.COLORS.INFO;
    style.textContent = `
      /* The DETAIL slider (Session P, plan D5): an INSTRUMENT in the WHERE
       * rail's INFO frame, the thumb in the law's PLAYER. Footer-right slot
       * (§13 r5, 2026-09-24);
       * asleep at birth (EdgeChrome's phase writes opacity / visibility). */
      #${DETAIL_SLIDER_ID} {
        display: flex;
        align-items: center;
        user-select: none;
        -webkit-user-select: none;
        -webkit-touch-callout: none;
        transition: opacity ${RAIL_GEOMETRY.EDGE_FADE_MS}ms ease;
      }
      #${DETAIL_SLIDER_ID} .ds-track {
        position: relative;
        width: ${TRACK_WIDTH_PX}px;
        height: ${RAIL_GEOMETRY.FOOTER_BAND_PX}px;
        flex: 0 0 auto;
      }
      #${DETAIL_SLIDER_ID} .ds-track::before {
        content: '';
        position: absolute;
        left: 0; right: 0; top: 50%;
        height: 1px;
        background: ${_rgba(info, 0.35)};
      }
      #${DETAIL_SLIDER_ID} .ds-tick {
        position: absolute;
        top: 50%;
        width: 1px;
        height: 6px;
        transform: translate(-50%, -50%);
        background: ${_rgba(info, 0.55)};
      }
      /* Bold ticks at 0 · 2 · 8 · 10 · 14 · 16 (Scenery · Ships · Flight · Ops · Instruments · All). Names never on screen. */
      #${DETAIL_SLIDER_ID} .ds-tick-milestone {
        width: 2px;
        height: 10px;
      }
      #${DETAIL_SLIDER_ID} .ds-thumb {
        position: absolute;
        top: 50%;
        width: 10px;
        height: 14px;
        border-radius: 2px;
        transform: translate(-50%, -50%);
        background: ${VisualLaw.COLORS.PLAYER};
        box-shadow: 0 0 6px ${_rgba(VisualLaw.COLORS.PLAYER, 0.35)};
      }
      @media (prefers-reduced-motion: reduce) {
        #${DETAIL_SLIDER_ID} { transition: none; }
      }
    `;
    doc.head.appendChild(style);
  }

  /** @private one tick per rung at i / total (i = 1..total); a tick at 0 only when 0 is a milestone. */
  _rebuildTicks(total) {
    const doc = this._doc;
    const track = this._track;
    if (!doc || !track) return;
    for (const t of this._ticks) {
      try { if (typeof t.remove === 'function') t.remove(); else if (typeof track.removeChild === 'function') track.removeChild(t); } catch (_e) { /* stub */ }
    }
    this._ticks = [];
    const n = Math.max(0, Math.round(Number(total) || 0));
    const marks = new Set();
    for (const v of this._milestones) { if (v >= 0 && v <= n) marks.add(v); }
    const start = marks.has(0) ? 0 : 1;
    for (let i = start; i <= n; i++) {
      const tick = doc.createElement('div');
      tick.className = marks.has(i) ? 'ds-tick ds-tick-milestone' : 'ds-tick';
      tick.style.left = DetailSlider.pct(i, n);
      track.appendChild(tick);
      this._ticks.push(tick);
    }
  }

  _down(e) {
    if (this._disposed || !this._root || !e) return;
    this._active = true;
    this._rect = this._trackRect();
    this._lastEmitted = null;
    this._lastX = e.clientX; this._lastY = e.clientY;
    try {
      if (typeof this._root.setPointerCapture === 'function' && e.pointerId != null) this._root.setPointerCapture(e.pointerId);
    } catch (_err) { /* capture is a nicety */ }
    if (typeof e.preventDefault === 'function') { try { e.preventDefault(); } catch (_err) { /* stub */ } }
    this._interact();
    this._detent(e.clientX);
  }

  _move(e) {
    if (!this._active || this._disposed || !e) return;
    if (e.clientX === this._lastX && e.clientY === this._lastY) return;
    this._lastX = e.clientX; this._lastY = e.clientY;
    this._interact();
    this._detent(e.clientX);
  }

  /** @private release: nothing is emitted */
  _up(e) {
    if (!this._active) return;
    this._active = false;
    this._rect = null;
    this._lastEmitted = null;
    this._lastX = null; this._lastY = null;
    try {
      if (this._root && typeof this._root.releasePointerCapture === 'function' && e && e.pointerId != null) this._root.releasePointerCapture(e.pointerId);
    } catch (_err) { /* stub */ }
  }

  /** @private onLevel once per detent change within the gesture; first contact uses detentFor (tap), later moves the dead-zone. */
  _detent(x) {
    const r = this._rect;
    const total = this._readTotal();
    const left = r ? r.left : 0;
    const width = r ? r.width : 0;
    const n = this._lastEmitted == null
      ? DetailSlider.detentFor(x, left, width, total)
      : DetailSlider.detentForDrag(x, left, width, total, this._lastEmitted);
    if (n === this._lastEmitted) return;
    this._lastEmitted = n;
    if (this._onLevel) { try { this._onLevel(n); } catch (_err) { /* dep */ } }
  }

  _interact() {
    if (this._onInteract) { try { this._onInteract(); } catch (_err) { /* dep */ } }
  }

  /** @private guarded: a stub without layout reads 0 wide */
  _trackRect() {
    const t = this._track;
    if (!t || typeof t.getBoundingClientRect !== 'function') return { left: 0, width: 0 };
    try {
      const r = t.getBoundingClientRect();
      return { left: Number(r.left) || 0, width: Number(r.width) || 0 };
    } catch (_e) { return { left: 0, width: 0 }; }
  }

  _readTotal() {
    if (!this._total) return 0;
    try { const n = Math.round(Number(this._total())); return Number.isFinite(n) ? Math.max(0, n) : 0; } catch (_e) { return 0; }
  }

  _readLevel() {
    if (!this._level) return 0;
    try { const n = Math.round(Number(this._level())); return Number.isFinite(n) ? Math.max(0, n) : 0; } catch (_e) { return 0; }
  }

  _clock() {
    if (this._now) { try { return Number(this._now()); } catch (_e) { return NaN; } }
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  _setAttr(k, v) { this._setAttrOn(this._root, k, v); }
  _setAttrOn(el, k, v) {
    if (!el || typeof el.setAttribute !== 'function') return;
    try { el.setAttribute(k, v); } catch (_e) { /* stub */ }
  }
}

export default DetailSlider;
