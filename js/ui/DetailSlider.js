/**
 * DetailSlider.js — the DETAIL slider: one horizontal "volume knob" for how
 * many HUD panels show (Session P, plan D5, owner 2026-09-07: "is the rail
 * even needed… volume control"). It replaces the left-edge DISPLAY rail
 * (js/ui/PaneRail.js — nine per-panel switches, 35 % opacity forever) with
 * ONE control: a track, one tick per pane-density rung, a thumb at the
 * current visible count. Drag or tap → `onLevel(n)`; the hub walks
 * PaneDensity.setLevel(n, { quiet: true }). No labels, no toast — the slider
 * IS the readout (Airbus A3: state shows, nothing confirms).
 *
 * WHAT IT IS NOT. It owns no order and no memory: the SHED ORDER is
 * PaneDensity's rung list (plan D5b — override · cargo · orbit … mother
 * last), the slider only walks it; per-floor ROOM memory needs nothing new —
 * `setLevel` walks real down()/up() steps whose `_onFlip` feeds the existing
 * HUD_PANE_VISIBILITY capture (the D5 law), exactly like the `-`/`+` keys.
 * Level 0 is PURE SCENERY: the hub answers `visibleCount() === 0` with
 * `LadderController.setRailsShy(true)`; the slider itself stays wakeable
 * (its visibility is EdgeChrome's — it is NOT in the body[data-pure-scenery]
 * CSS rule, otherwise level 0 would be a trap on glass).
 *
 * WHERE IT LIVES. The FOOTER BAND's left slot (plan D7): `position:fixed;
 * left:EDGE_PX; bottom:footerBottomPx; height:FOOTER_BAND_PX` — the hub
 * passes `footerBand().bottom` (132 on both surfaces). On GLASS the hit box
 * is TOUCH_PITCH_PX (44) tall: 6 px of transparent padding above and below
 * the 32 px band, the root shifted down by 6 so the VISUAL band still sits
 * at footerBottomPx (Apple HIG 44 pt). F2–F5 only: the hub calls
 * `setShown(floor !== 1)` (the workbench has the REFIT tab in that slot).
 *
 * EDGE CHROME (plan D2/D3). The slider has no idle timer of its own: the
 * hub reads `edgeChrome.phase('slider', now)` per frame and calls
 * `setPhase(phase)` — 'awake' → opacity 1 / visible; 'fading' → opacity
 * IDLE_FADE (0; the CSS `transition: opacity EDGE_FADE_MS` ramps);
 * 'hidden' → visibility hidden. Its own pointerdown / pointermove call
 * `onInteract()` (the hub wakes 'slider'); release calls NOTHING.
 *
 * Laws (the GestureSplash / OverridePane header's): DOM fonts none (no
 * text at all — the aria values are the only words); colours from VisualLaw
 * (INFO for the instrument track and ticks, PLAYER for the thumb); no HTML
 * strings (createElement only); no timers / rAF (the refresh throttle reads the caller clock);
 * no window / document listeners (four pointer listeners on its own root
 * are the only edges); never reads the game's constants table; never touches the DOM at
 * import time; constructible headless (no document: every method callable,
 * nothing thrown); every DOM write is write-on-change (G1); emoji-free.
 *
 * @module ui/DetailSlider
 */

import { RAIL_GEOMETRY } from './RailGeometry.js';
import { VisualLaw } from '../core/VisualLaw.js';

/** The root element id (the probe reads its rect, aria-valuenow and tick count). */
export const DETAIL_SLIDER_ID = 'ladder-detail-slider';

/** The injected stylesheet's id (one <style>, injected once per document). */
export const DETAIL_SLIDER_STYLE_ID = 'detail-slider-style';

/** Unforced `refresh()` reads the density at most this often (≤ 4 Hz). */
export const REFRESH_MIN_MS = 250;

/** The track's width in CSS px (the thumb travels its full length). */
export const TRACK_WIDTH_PX = 160;

/** Horizontal padding inside the root so the thumb has room at 0 % and 100 %. */
const SIDE_PAD_PX = 8;

/** @private '#rrggbb' → 'rgba(r,g,b,a)' (the RailIndicator idiom). */
const _rgba = (hex, a) => {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

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
   * @param {boolean}  [deps.reducedMotion]  true → inline `transition:none` on the root.
   * @param {Document|null} [deps.doc]       document (default: the global one; null = headless, inert).
   * @param {function} [deps.now]            ms clock for the refresh throttle (default performance.now).
   */
  constructor(deps = {}) {
    this._total = typeof deps.total === 'function' ? deps.total : null;
    this._level = typeof deps.level === 'function' ? deps.level : null;
    this._onLevel = typeof deps.onLevel === 'function' ? deps.onLevel : null;
    this._onInteract = typeof deps.onInteract === 'function' ? deps.onInteract : null;
    const fb = Number(deps.footerBottomPx);
    this._footerBottomPx = Number.isFinite(fb) ? fb : (RAIL_GEOMETRY.THUMB_REST_PX + RAIL_GEOMETRY.FOOTER_GAP_PX);
    this._glass = deps.glass === true;
    this._reducedMotion = deps.reducedMotion === true;
    this._doc = deps.doc !== undefined ? deps.doc
      : (typeof document !== 'undefined' ? document : null);
    this._now = typeof deps.now === 'function' ? deps.now : null;

    this._root = null;
    this._track = null;
    this._thumb = null;
    this._ticks = [];
    this._listeners = [];
    this._disposed = false;
    /** @private the last values WRITTEN (write-on-change) */
    this._shown = true;
    this._phase = null;
    this._wroteTotal = null;
    this._wroteLevel = null;
    /** @private the throttle clock of the last unforced read */
    this._readAt = -Infinity;
    /** @private the live gesture: cached track rect + the last detent emitted */
    this._active = false;
    this._rect = null;
    this._lastEmitted = null;
    this._lastX = null;
    this._lastY = null;

    this._build();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Re-read `level()` / `total()` — at most every REFRESH_MIN_MS unless
   * forced — and rewrite the ticks, the thumb and the aria values on change.
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
    if (level !== this._wroteLevel) {
      this._wroteLevel = level;
      this._setAttr('aria-valuenow', String(level));
      if (this._thumb) this._thumb.style.left = DetailSlider.pct(level, total);
    }
    return true;
  }

  /**
   * Whether the slider is on this floor at all (F2–F5). Independent of the
   * edge-chrome phase. Write-on-change on `display`.
   * @param {boolean} on
   */
  setShown(on) {
    const want = on !== false;
    if (want === this._shown) return;
    this._shown = want;
    if (this._root) this._root.style.display = want ? '' : 'none';
  }

  /**
   * The edge-chrome phase (the hub reads EdgeChrome per frame): 'awake' →
   * opacity 1 + visible; 'fading' → opacity IDLE_FADE (the transition ramps);
   * 'hidden' (or unknown) → visibility hidden + opacity at rest. Write-on-change.
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

  /** @returns {Element|null} the root (null headless / disposed) */
  element() { return this._root; }

  /** @returns {boolean} the setShown state (true at birth) */
  isShown() { return this._shown; }

  /** Release the pointer listeners, remove the root; further calls no-op. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
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

  // ── Pure law ────────────────────────────────────────────────────────────────

  /**
   * The detent under a pointer x: round((x − left) / width × total), clamped
   * to 0..total. A zero / unmeasured width reads 0.
   * @param {number} x @param {number} left @param {number} width @param {number} total
   * @returns {number}
   */
  static detentFor(x, left, width, total) {
    const n = Math.max(0, Math.round(Number(total) || 0));
    const w = Number(width);
    if (!(w > 0) || n === 0) return 0;
    const raw = Math.round(((Number(x) - Number(left)) / w) * n);
    return Math.max(0, Math.min(n, Number.isFinite(raw) ? raw : 0));
  }

  /** The thumb / tick position as a CSS percentage of the track. @param {number} i @param {number} total */
  static pct(i, total) {
    const n = Number(total);
    if (!(n > 0)) return '0%';
    return `${(Math.max(0, Math.min(n, i)) / n) * 100}%`;
  }

  // ── Build ───────────────────────────────────────────────────────────────────

  /** @private the root under doc.body (headless: nothing) */
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
    s.left = `${RAIL_GEOMETRY.EDGE_PX}px`;
    s.bottom = `${this._footerBottomPx - pad}px`;
    s.height = `${height}px`;
    s.width = `${TRACK_WIDTH_PX + 2 * SIDE_PAD_PX}px`;
    s.padding = `${pad}px ${SIDE_PAD_PX}px`;
    s.boxSizing = 'border-box';
    s.zIndex = '35';
    s.touchAction = 'none';
    s.pointerEvents = 'auto';
    s.visibility = 'hidden';                 // asleep at birth — EdgeChrome decides (the hub's setPhase)
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

  /** @private one <style id="detail-slider-style"> per document */
  _ensureStyle() {
    const doc = this._doc;
    if (!doc || !doc.head || typeof doc.head.appendChild !== 'function') return;
    if (typeof doc.getElementById === 'function' && doc.getElementById(DETAIL_SLIDER_STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = DETAIL_SLIDER_STYLE_ID;
    const info = VisualLaw.COLORS.INFO;
    style.textContent = `
      /* The DETAIL slider (Session P, plan D5): an INSTRUMENT in the WHERE
       * rail's INFO frame, the thumb in the law's PLAYER. Footer-left slot;
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

  /** @private one tick per rung at i / total (i = 1..total); rebuilt only when total changes */
  _rebuildTicks(total) {
    const doc = this._doc;
    const track = this._track;
    if (!doc || !track) return;
    for (const t of this._ticks) {
      try { if (typeof t.remove === 'function') t.remove(); else if (typeof track.removeChild === 'function') track.removeChild(t); } catch (_e) { /* stub */ }
    }
    this._ticks = [];
    for (let i = 1; i <= total; i++) {
      const tick = doc.createElement('div');
      tick.className = 'ds-tick';
      tick.style.left = DetailSlider.pct(i, total);
      track.appendChild(tick);
      this._ticks.push(tick);
    }
  }

  // ── Pointer law ─────────────────────────────────────────────────────────────

  /** @private pointerdown: capture, cache the track rect, interact, detent */
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

  /** @private pointermove while live: interact when moved, detent on change */
  _move(e) {
    if (!this._active || this._disposed || !e) return;
    if (e.clientX === this._lastX && e.clientY === this._lastY) return;
    this._lastX = e.clientX; this._lastY = e.clientY;
    this._interact();
    this._detent(e.clientX);
  }

  /** @private release: nothing is emitted (the slider IS the readout) */
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

  /** @private the detent under x → onLevel once per change within the gesture */
  _detent(x) {
    const r = this._rect;
    const total = this._readTotal();
    const n = DetailSlider.detentFor(x, r ? r.left : 0, r ? r.width : 0, total);
    if (n === this._lastEmitted) return;
    this._lastEmitted = n;
    if (this._onLevel) { try { this._onLevel(n); } catch (_err) { /* dep */ } }
  }

  /** @private */
  _interact() {
    if (this._onInteract) { try { this._onInteract(); } catch (_err) { /* dep */ } }
  }

  /** @private the track's rect, guarded (a stub without layout reads 0 wide) */
  _trackRect() {
    const t = this._track;
    if (!t || typeof t.getBoundingClientRect !== 'function') return { left: 0, width: 0 };
    try {
      const r = t.getBoundingClientRect();
      return { left: Number(r.left) || 0, width: Number(r.width) || 0 };
    } catch (_e) { return { left: 0, width: 0 }; }
  }

  // ── Reads (guarded) ─────────────────────────────────────────────────────────

  /** @private */
  _readTotal() {
    if (!this._total) return 0;
    try { const n = Math.round(Number(this._total())); return Number.isFinite(n) ? Math.max(0, n) : 0; } catch (_e) { return 0; }
  }

  /** @private */
  _readLevel() {
    if (!this._level) return 0;
    try { const n = Math.round(Number(this._level())); return Number.isFinite(n) ? Math.max(0, n) : 0; } catch (_e) { return 0; }
  }

  /** @private the throttle clock (the injected `now`, else performance.now / Date.now) */
  _clock() {
    if (this._now) { try { return Number(this._now()); } catch (_e) { return NaN; } }
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  /** @private guarded attribute writes */
  _setAttr(k, v) { this._setAttrOn(this._root, k, v); }
  _setAttrOn(el, k, v) {
    if (!el || typeof el.setAttribute !== 'function') return;
    try { el.setAttribute(k, v); } catch (_e) { /* stub */ }
  }
}

export default DetailSlider;
