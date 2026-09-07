/**
 * EdgeChrome.js — the EDGE-CHROME idle law (Session P, plan D2/D3, owner
 * 2026-09-07 — the dark cockpit). The right-edge WHERE rail, the bottom-left
 * DETAIL slider and the bottom-right SPECS tab are EDGE CHROME: they VANISH
 * while the pilot is idle and wake only from edge-scoped input (a zoom
 * charge, a floor change, a touch or hover in a side edge band or the footer
 * band, a pane flip — never a centre tap). Airbus A1/A4: nothing lit means
 * normal; the only transient is a BOX around what just changed.
 *
 * This module is the PURE CORE — timestamps only. No DOM, no timers, no
 * listeners, no imports beyond the shared geometry table. Consumers (the
 * rail inside `RailIndicator.refresh`, the slider and the tab inside the
 * hub's per-frame anchor block) read it once per frame and write the DOM on
 * change only (G1: no idle timers anywhere; per-frame reads, write-on-change
 * in the consumer).
 *
 * THE IDLE LAW. Every member owns ONE timestamp, `awakeUntil` — the instant
 * its idle window ends.
 *   wake(member?, now)  → awakeUntil = now + idleMs   (no member = all)
 *   hold(member?, until) → awakeUntil = max(awakeUntil, until)  (never shortens;
 *                         the splash hold, a ride's warp time)
 *   sleep(now)          → every awakeUntil = now (the fade starts NOW — pure
 *                         scenery; asleep is still WAKEABLE, unlike hide())
 * The three-state walk a consumer paints:
 *   'awake'   now < awakeUntil                 → opacity 1, visibility visible
 *   'fading'  awakeUntil ≤ now < awakeUntil + fadeMs → opacity restOpacity
 *                                                (the consumer's CSS
 *                                                `transition: opacity fadeMs`
 *                                                does the ramp — no timer)
 *   'hidden'  otherwise (and at birth)         → visibility hidden — written
 *                                                ONLY in this phase, so a
 *                                                fading member still paints
 * `opacityFor` is 1 awake, else `restOpacity` (RAIL_GEOMETRY.IDLE_FADE — 0:
 * rest = vanish; the "ghost tier" fallback is that ONE number, 0.12).
 * REDUCED MOTION forces fadeMs to 0: the 'fading' phase never appears — a
 * member steps awake → hidden the instant its window ends.
 *
 * THE A4 BOX. `box(name, now)` stamps `boxedUntil[name] = now + boxMs`: a
 * changed mode — the arrival floor's notch ('floor'), the rate label
 * ('rate') — wears a 1 px outline for BOX_MS, painted by the consumer from
 * `isBoxed(name, now)`. Unknown member / box names are ignored everywhere:
 * no throw, no effect, every read false / 'hidden' / -Infinity.
 *
 * `nowMs` is OPTIONAL on every method: omitted / null / non-finite falls back
 * to `performance.now()` (else `Date.now()`) — the hub drives real clocks
 * (the rAF timestamp), the tests drive fake ones and always pass one.
 *
 * @module ui/EdgeChrome
 */

import { RAIL_GEOMETRY } from './RailGeometry.js';

/** The three edge-chrome members: the WHERE rail, the DETAIL slider, the SPECS tab. */
export const MEMBERS = Object.freeze(['rail', 'slider', 'tab']);

/** The two A4 box targets: the arrival floor's notch, the rate label. */
export const BOXES = Object.freeze(['floor', 'rate']);

/** @private A finite, non-negative number or the fallback (constructor sanitising). */
function _num(v, fallback) {
  const n = (typeof v === 'number') ? v : ((v == null || typeof v === 'symbol') ? NaN : Number(v));
  return Number.isFinite(n) ? Math.max(0, n) : fallback;
}

/** @private The optional clock: a finite `nowMs`, else the real clock. */
function _clock(nowMs) {
  const t = (typeof nowMs === 'number') ? nowMs : ((nowMs == null || typeof nowMs === 'symbol') ? NaN : Number(nowMs));
  if (Number.isFinite(t)) return t;
  return (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
}

export class EdgeChrome {
  /**
   * @param {object} [o]
   * @param {number}  [o.idleMs]        the awake window (default RAIL_GEOMETRY.IDLE_FADE_MS 4000)
   * @param {number}  [o.fadeMs]        the fade window (default RAIL_GEOMETRY.EDGE_FADE_MS 300; FORCED to 0 under reducedMotion)
   * @param {number}  [o.boxMs]         the A4 box window (default RAIL_GEOMETRY.BOX_MS 4000)
   * @param {number}  [o.restOpacity]   the non-awake opacity (default RAIL_GEOMETRY.IDLE_FADE 0)
   * @param {boolean} [o.reducedMotion] true → instant fade (no 'fading' phase)
   * Non-finite numbers fall back to the defaults; negatives clamp to 0.
   */
  constructor({ idleMs = RAIL_GEOMETRY.IDLE_FADE_MS, fadeMs = RAIL_GEOMETRY.EDGE_FADE_MS,
                boxMs = RAIL_GEOMETRY.BOX_MS, restOpacity = RAIL_GEOMETRY.IDLE_FADE,
                reducedMotion = false } = {}) {
    /** @type {boolean} */
    this.reducedMotion = reducedMotion === true;
    /** @type {number} */
    this.idleMs = _num(idleMs, RAIL_GEOMETRY.IDLE_FADE_MS);
    /** @type {number} 0 under reduced motion — the consumer's transition length too. */
    this.fadeMs = this.reducedMotion ? 0 : _num(fadeMs, RAIL_GEOMETRY.EDGE_FADE_MS);
    /** @type {number} */
    this.boxMs = _num(boxMs, RAIL_GEOMETRY.BOX_MS);
    /** @type {number} */
    this.restOpacity = _num(restOpacity, RAIL_GEOMETRY.IDLE_FADE);
    /** @private per-member awake-until stamps (-Infinity = asleep since birth) */
    this._awakeUntil = Object.create(null);
    /** @private per-box boxed-until stamps (-Infinity = never boxed) */
    this._boxedUntil = Object.create(null);
    for (const m of MEMBERS) this._awakeUntil[m] = -Infinity;
    for (const b of BOXES) this._boxedUntil[b] = -Infinity;
  }

  /** @private a known member name? */
  _has(member) { return typeof member === 'string' && Object.prototype.hasOwnProperty.call(this._awakeUntil, member); }

  /**
   * Wake ONE member — or ALL when `member` is null / undefined — until
   * `now + idleMs`. Unknown names are ignored.
   * @param {string|null} [member]
   * @param {number} [nowMs]
   */
  wake(member, nowMs) {
    const until = _clock(nowMs) + this.idleMs;
    if (member == null) {
      for (const m of MEMBERS) this._awakeUntil[m] = until;
      return;
    }
    if (this._has(member)) this._awakeUntil[member] = until;
  }

  /**
   * Extend a member's (null = every member's) awake window to `untilMs` —
   * never shortens (max semantics). Unknown names are ignored.
   * @param {string|null} member
   * @param {number} untilMs
   */
  hold(member, untilMs) {
    const until = _clock(untilMs);
    const rise = (m) => { if (until > this._awakeUntil[m]) this._awakeUntil[m] = until; };
    if (member == null) {
      for (const m of MEMBERS) rise(m);
      return;
    }
    if (this._has(member)) rise(member);
  }

  /**
   * The fade starts NOW for every member (`awakeUntil = now`). Asleep is
   * still wakeable — the difference from a consumer's hide().
   * @param {number} [nowMs]
   */
  sleep(nowMs) {
    const t = _clock(nowMs);
    for (const m of MEMBERS) this._awakeUntil[m] = t;
  }

  /**
   * @param {string} member @param {number} [nowMs]
   * @returns {boolean} now < awakeUntil (unknown → false)
   */
  isAwake(member, nowMs) {
    if (!this._has(member)) return false;
    return _clock(nowMs) < this._awakeUntil[member];
  }

  /**
   * @param {string} member @param {number} [nowMs]
   * @returns {'awake'|'fading'|'hidden'} (unknown → 'hidden')
   */
  phase(member, nowMs) {
    if (!this._has(member)) return 'hidden';
    const t = _clock(nowMs);
    const until = this._awakeUntil[member];
    if (t < until) return 'awake';
    if (this.fadeMs > 0 && t < until + this.fadeMs) return 'fading';
    return 'hidden';
  }

  /**
   * @param {string} member @param {number} [nowMs]
   * @returns {number} 1 while awake, else restOpacity
   */
  opacityFor(member, nowMs) {
    return this.isAwake(member, nowMs) ? 1 : this.restOpacity;
  }

  /**
   * The A4 box: `boxedUntil[name] = now + boxMs`. Unknown names are ignored.
   * @param {string} name @param {number} [nowMs]
   */
  box(name, nowMs) {
    if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(this._boxedUntil, name)) return;
    this._boxedUntil[name] = _clock(nowMs) + this.boxMs;
  }

  /**
   * @param {string} name @param {number} [nowMs]
   * @returns {boolean} now < boxedUntil (unknown → false)
   */
  isBoxed(name, nowMs) {
    if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(this._boxedUntil, name)) return false;
    return _clock(nowMs) < this._boxedUntil[name];
  }

  /**
   * @param {string} name
   * @returns {number} the boxed-until stamp, -Infinity when never boxed / unknown (a pure table read, no clock)
   */
  boxedUntil(name) {
    if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(this._boxedUntil, name)) return -Infinity;
    return this._boxedUntil[name];
  }
}

export default EdgeChrome;
