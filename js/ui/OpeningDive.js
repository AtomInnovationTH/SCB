/**
 * OpeningDive.js — the opening dive through the real dots, behind a test switch (lane sky-dive-1118, DECISIONS §75 row 5).
 *
 * Owner 2026-11-18: "A job makes a slower dive, about 6 s, from the globe through the real dots down to her ship. The dots fade
 * near the ship, and any key skips it as today. It stays behind a test switch until you look on the Mac."
 *
 * The switch is `?dive=1`, read through `devSearch()`: it works on a dev host (localhost on the Mac) and nowhere else, so a public
 * page never dives. With it off nothing in this file runs and the opening is exactly today's.
 *
 * The camera ride itself belongs to LadderController (`armIntroRide({ dive: true })`, INTRO_DIVE_MS, `diveInFlight()`,
 * `finishDive()`). This file owns what the dive adds on top: the dots' opacity by the camera's distance from the ship, and
 * the skip. Every frame (main.js, next to `realSkyLayer.update()`):
 *   - dive begins: the dots turn on at opacity 0 (RealSkyLayer.diveBegin), and the ship's hull callouts are held back
 *     (`suppress(true)`): the dive's far clip plane brings the ship into the frame 800 u out, where its part names would
 *     hang round a one-pixel ship (measured 2026-11-19, frame at dance t 3.0 s); today's far plane clipped them;
 *   - dive flies: opacity = `diveAlpha(distance from the ship)`, the dots are moved (diveTick);
 *   - a skip (OpeningDance.isSkipping, set by any key / click / tap) during the dive: the camera finishes the descent within
 *     INTRO_DIVE_SKIP_MS (finishDive) and the dots hide at once;
 *   - the dive is over (landing, skip, input): diveEnd puts the dots back on today's floor 4-5 rules at once; `suppress(false)`
 *     lets the callouts in again only when the ladder's dive far plane is released (`diveClipActive()` false), because after
 *     input or a skip the camera still descends with that plane.
 *
 * @module ui/OpeningDive
 */

import { devSearch } from '../core/DevHost.js';

/**
 * The dots are at full opacity while the camera is farther than this from the ship, metres: floor 4's near edge, 7,000 km (the
 * camera then stands among the dots, as the player does on floor 4).
 */
export const DIVE_FADE_START_M = 7.0e6;
/**
 * ... and gone once it is closer than this, metres: 120 km, the top of floor 3 (the ship's own neighbourhood). Between the two
 * the opacity falls with the LOGARITHM of the distance (the ride covers the last decades in its last moments).
 */
export const DIVE_FADE_END_M = 1.2e5;

/**
 * The `?dive=1` test switch (dev host only; `loc` is injectable for tests).
 * @param {{protocol?:string, hostname?:string, search?:string}|null|undefined} [loc]
 * @returns {boolean}
 */
export function devDive(loc = globalThis.location) {
  return new URLSearchParams(devSearch(loc)).get('dive') === '1';
}

/**
 * The dots' opacity at a camera distance from the ship: 1 at DIVE_FADE_START_M and beyond, 0 at DIVE_FADE_END_M and inside,
 * linear in log10(distance) between. A non-finite distance gives 0 (nothing is shown that cannot be placed).
 * @param {number} distM metres
 * @returns {number} 0..1
 */
export function diveAlpha(distM) {
  if (!Number.isFinite(distM)) return 0;
  if (distM >= DIVE_FADE_START_M) return 1;
  if (distM <= DIVE_FADE_END_M) return 0;
  return Math.log(distM / DIVE_FADE_END_M) / Math.log(DIVE_FADE_START_M / DIVE_FADE_END_M);
}

/**
 * The dissolve between the menu's last frame and the dive's first (lane sky-divecut-1119). Measured 2026-11-19 (tmp/divecut):
 * the cut from the menu to the dive is ONE frame in which Earth's centre moves 2,606 px and its radius falls 3,196 -> 85 px
 * (1728x1117), the camera 16.6 m -> 73,900 km from the ship. No continuous camera path joins the two views (a path would pull
 * out to the globe and fall back along the same line), so the picture fades to black over the last DIVE_VEIL_OUT_MS of the
 * departure and the dive fades up from black over DIVE_VEIL_IN_MS: 1.15 s of dissolve, no time added to the opening.
 */
export const DIVE_VEIL_OUT_MS = 450;
/** The dive fades up from black this long, from its first frame, ms. */
export const DIVE_VEIL_IN_MS = 700;
/** If no dive has started this long after the cut (the switch was on but nothing armed a dive), the veil lifts anyway, ms. */
export const DIVE_VEIL_FALLBACK_MS = 1500;
/** A skip during the dive: the veil, if still up, lifts in this many ms. */
export const DIVE_VEIL_SKIP_MS = 200;

/**
 * The black veil over the screen for the menu -> dive cut. States: idle -> armed (begin: fade-out scheduled) -> out (fading to
 * black) -> black (the cut) -> in (the dive's fade-up) -> idle (element removed). All times are milliseconds on the page's own
 * clock (`now`), driven by `raf`; both and the DOM are injectable for tests. With the `?dive=1` switch off nothing here is
 * ever called.
 */
export class DiveVeil {
  /**
   * @param {object} [env]
   * @param {Document} [env.doc] default `globalThis.document`
   * @param {function} [env.now] () => ms, default performance.now
   * @param {function} [env.raf] (cb) => id, default requestAnimationFrame
   * @param {function} [env.caf] (id) => void
   * @param {function} [env.setT] setTimeout
   * @param {function} [env.clearT] clearTimeout
   */
  constructor(env = {}) {
    this._doc = env.doc || globalThis.document || null;
    this._now = env.now || (() => globalThis.performance.now());
    this._raf = env.raf || ((cb) => globalThis.requestAnimationFrame(cb));
    this._caf = env.caf || ((id) => globalThis.cancelAnimationFrame(id));
    this._setT = env.setT || ((f, ms) => globalThis.setTimeout(f, ms));
    this._clearT = env.clearT || ((id) => globalThis.clearTimeout(id));
    this._state = 'idle';
    this._el = null;
    this._opacity = 0;
    this._from = 0; this._to = 0; this._t0 = 0; this._dur = 1;
    this._rafId = 0;
    this._outTimer = null;
    this._fallbackTimer = null;
    this._menu = null;
    this._menuTransition = '';
  }

  /** The veil's opacity now, 0..1. */
  opacity() { return this._opacity; }
  /** idle | armed | out | black | in. */
  state() { return this._state; }
  /** True from begin() until the veil is gone (the power-up flash stays off meanwhile). */
  active() { return this._state !== 'idle'; }

  /** @private */
  _ensureEl() {
    if (this._el || !this._doc || !this._doc.body) return;
    const el = this._doc.createElement('div');
    el.id = 'dive-veil';
    el.style.cssText = 'position:fixed;inset:0;background:#000;pointer-events:none;z-index:9999;opacity:0';
    this._doc.body.appendChild(el);
    this._el = el;
  }

  /** @private */
  _set(o) {
    this._opacity = o;
    if (this._el) this._el.style.opacity = String(o);
  }

  /** @private fade from the current opacity to `to` over `ms`, smoothstep. */
  _fade(to, ms) {
    this._ensureEl();
    this._from = this._opacity; this._to = to; this._t0 = this._now(); this._dur = Math.max(1, ms);
    if (!this._rafId) this._rafId = this._raf(() => this._frame());
  }

  /** @private */
  _frame() {
    this._rafId = 0;
    const k = Math.min(1, Math.max(0, (this._now() - this._t0) / this._dur));
    const s = k * k * (3 - 2 * k);
    this._set(this._from + (this._to - this._from) * s);
    if (k < 1) { this._rafId = this._raf(() => this._frame()); return; }
    if (this._state === 'out') this._state = 'black';
    else if (this._state === 'in') this._finish();
  }

  /** @private the veil is gone. */
  _finish() {
    this._state = 'idle';
    this._opacity = 0;
    if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
    this._el = null;
    this._restoreMenu();
  }

  /** @private */
  _cancelTimers() {
    if (this._outTimer !== null) { this._clearT(this._outTimer); this._outTimer = null; }
    if (this._fallbackTimer !== null) { this._clearT(this._fallbackTimer); this._fallbackTimer = null; }
    if (this._rafId) { this._caf(this._rafId); this._rafId = 0; }
  }

  /**
   * The departure starts (MENU_DEPARTURE_START with the switch on): fade to black over the last DIVE_VEIL_OUT_MS of it.
   * @param {number} durationMs the departure's length (MENU_START comes this long after the click)
   */
  begin(durationMs) {
    this.clear();
    this._state = 'armed';
    const wait = Math.max(0, (Number.isFinite(durationMs) ? durationMs : 0) - DIVE_VEIL_OUT_MS);
    this._outTimer = this._setT(() => {
      this._outTimer = null;
      if (this._state !== 'armed') return;
      this._state = 'out';
      this._fade(1, DIVE_VEIL_OUT_MS);
    }, wait);
    // The backup starts here too, from the end of the fade-out: if MENU_START never comes (hide() mid-departure cancels the
    // timer that sends it) the screen would stay black. cut() restarts it from the cut.
    this._fallbackTimer = this._setT(() => { this._fallbackTimer = null; this.release(); }, wait + DIVE_VEIL_OUT_MS + DIVE_VEIL_FALLBACK_MS);
  }

  /**
   * MENU_START: the cut. Black at once (a skip arrives here early, mid fade), the menu's own picture is hidden at once (its
   * canvas would otherwise show through the fade-up while the menu fades out over 0.5 s), and a fallback lifts the veil if no
   * dive follows. A no-op unless begin() ran.
   */
  cut() {
    if (this._state !== 'armed' && this._state !== 'out' && this._state !== 'black') return;
    this._cancelTimers();
    this._state = 'black';
    this._ensureEl();
    this._set(1);
    this._hideMenu();
    this._fallbackTimer = this._setT(() => { this._fallbackTimer = null; this.release(); }, DIVE_VEIL_FALLBACK_MS);
  }

  /** @private Menu screen off with no fade (its frozen last 3D frame would show through the fade-up). Undone in _finish(). */
  _hideMenu() {
    const m = this._doc && this._doc.getElementById ? this._doc.getElementById('menu-screen') : null;
    if (!m || !m.style || this._menu) return;
    this._menu = m;
    this._menuTransition = m.style.transition;
    m.style.transition = 'none';
    m.style.opacity = '0';
  }

  /** @private Give the menu screen its fade back (show() sets its opacity itself). */
  _restoreMenu() {
    if (!this._menu) return;
    this._menu.style.transition = this._menuTransition || '';
    this._menu = null;
  }

  /**
   * The dive's first frame (or the fallback, or a skip): fade up from the current opacity. A call while already fading up only
   * shortens the fade (a skip), never lengthens it.
   * @param {number} [ms] default DIVE_VEIL_IN_MS
   */
  release(ms = DIVE_VEIL_IN_MS) {
    if (this._state === 'idle') return;
    if (this._state === 'armed') { this.clear(); return; }   // the departure never reached its cut here
    if (this._fallbackTimer !== null) { this._clearT(this._fallbackTimer); this._fallbackTimer = null; }
    if (this._state === 'in') {
      const left = this._dur - (this._now() - this._t0);
      if (ms >= left) return;
    }
    this._state = 'in';
    this._fade(0, ms);
  }

  /** Drop everything now (back on the menu, a Continue, a new begin). */
  clear() {
    this._cancelTimers();
    this._finish();
  }
}

/** The one veil of the page (the frame loop's OpeningDive and main.js's event listeners share it). Builds no DOM until used. */
export const diveVeil = new DiveVeil();

export class OpeningDive {
  /**
   * @param {object} deps every one needed; a missing one makes update() a no-op
   * @param {{diveInFlight:function, finishDive:function, diveClipActive:function}} deps.ladder LadderController
   * @param {{diveBegin:function, diveSetAlpha:function, diveTick:function, diveEnd:function}} deps.layer RealSkyLayer
   * @param {{isSkipping:function}} deps.dance OpeningDance
   * @param {function} deps.getDistM () => the camera's distance from the ship, metres
   * @param {function} [deps.suppress] (on:boolean) => void; holds the hull callouts back (MotherCallouts.setSuppressed)
   * @param {DiveVeil} [deps.veil] the menu -> dive dissolve (default: the page's `diveVeil`): lifted at the dive's first frame, lifted fast on a skip
   */
  constructor(deps = {}) {
    this._ladder = deps.ladder || null;
    this._layer = deps.layer || null;
    this._dance = deps.dance || null;
    this._getDistM = deps.getDistM || (() => NaN);
    this._suppress = deps.suppress || null;
    this._veil = deps.veil || diveVeil;
    this._on = false;        // the layer's dive is running
    this._skipped = false;   // a skip ended the dive (stays set until the ladder's dive is over)
    this._held = false;      // the hull callouts are held back (until the ladder's dive far plane is released)
  }

  /** True while the dots are being shown for the dive. */
  active() { return this._on; }

  /** @private the dive's dots off: back to today's rules. The callouts are released separately (`_release`), later. */
  _stop() {
    if (!this._on) return;
    this._on = false;
    this._layer.diveEnd();
  }

  /**
   * @private Lets the hull callouts back, but only once the dive's far plane is gone (`ladder.diveClipActive()`): after input or a
   * skip mid-dive the camera keeps descending with the 2000 far plane, and the names would hang round a one-pixel ship.
   * A ladder with no such getter has no clip to wait for.
   */
  _release() {
    if (!this._held) return;
    const l = this._ladder;
    if (typeof l.diveClipActive === 'function' && l.diveClipActive()) return;
    this._held = false;
    if (this._suppress) this._suppress(false);
  }

  /** One frame. Cheap when no dive flies: one boolean read. */
  update() {
    const ladder = this._ladder, layer = this._layer;
    if (!ladder || !layer) return;
    const flying = ladder.diveInFlight();
    if (!flying) {
      this._skipped = false;
      this._stop();
      this._release();
      return;
    }
    if (!this._skipped && this._dance && this._dance.isSkipping && this._dance.isSkipping()) {
      this._skipped = true;
      ladder.finishDive();
      if (this._veil) this._veil.release(DIVE_VEIL_SKIP_MS);
    }
    if (this._skipped) {
      this._stop();
      this._release();
      return;
    }
    if (!this._on) {
      this._on = true;
      if (!this._held) { this._held = true; if (this._suppress) this._suppress(true); }
      layer.diveBegin();
      if (this._veil) this._veil.release();   // the dive's first frame: fade up from black
    }
    layer.diveSetAlpha(diveAlpha(this._getDistM()));
    layer.diveTick();
  }
}
