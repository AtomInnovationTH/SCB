/**
 * EdgeChrome.js — the edge-chrome idle law. The right-edge WHERE rail, the bottom-left DETAIL slider and the
 * bottom-right SPECS tab VANISH while the pilot is idle and wake only from edge-scoped input (a zoom charge,
 * a floor change, a touch or hover in a side edge band or the footer band, a pane flip — never a centre tap).
 * Airbus A1/A4: nothing lit means normal; the only transient is a BOX around what just changed.
 * owner 2026-09-07: edge chrome vanishes while idle (dark cockpit).
 *
 * PURE CORE — timestamps only: no DOM, no timers, no listeners, no imports beyond the shared geometry table
 * (test-EdgeChrome pins this). Consumers read it once per frame and write the DOM on change only (G1).
 *
 * Every member owns ONE timestamp, `awakeUntil`:
 *   wake(member?, now)   → awakeUntil = now + idleMs   (no member = all)
 *   hold(member?, until) → awakeUntil = max(awakeUntil, until)  (never shortens; splash hold, a ride's warp time)
 *   sleep(now)           → every awakeUntil = now (fade starts NOW; asleep is still WAKEABLE, unlike hide())
 * Phases a consumer paints:
 *   'awake'   now < awakeUntil                      → opacity 1, visibility visible
 *   'fading'  awakeUntil ≤ now < awakeUntil + fadeMs → opacity restOpacity (the consumer's CSS transition does
 *                                                     the ramp — no timer)
 *   'hidden'  otherwise (and at birth)              → visibility hidden, written ONLY in this phase
 * `opacityFor` is 1 awake, else `restOpacity` (RAIL_GEOMETRY.IDLE_FADE — 0; the "ghost tier" fallback is 0.12).
 * REDUCED MOTION forces fadeMs to 0: no 'fading' phase, awake → hidden the instant the window ends.
 *
 * A4 BOX: `box(name, now)` stamps `boxedUntil[name] = now + boxMs`; a changed mode (arrival floor's notch
 * 'floor', rate label 'rate') wears a 1 px outline while `isBoxed(name, now)`. Unknown member / box names are
 * ignored everywhere: no throw, every read false / 'hidden' / -Infinity.
 *
 * `nowMs` is OPTIONAL on every method: omitted / null / non-finite falls back to `performance.now()`
 * (else `Date.now()`).
 *
 * @module ui/EdgeChrome
 */

import { RAIL_GEOMETRY } from './RailGeometry.js';

/** The edge-chrome members: the WHERE rail, the DETAIL slider, the SPECS tab. */
export const MEMBERS = Object.freeze(['rail', 'slider', 'tab']);

export const BOXES = Object.freeze(['floor', 'rate']);

/** @private Finite non-negative number or the fallback. */
function _num(v, fallback) {
  const n = (typeof v === 'number') ? v : ((v == null || typeof v === 'symbol') ? NaN : Number(v));
  return Number.isFinite(n) ? Math.max(0, n) : fallback;
}

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

  _has(member) { return typeof member === 'string' && Object.prototype.hasOwnProperty.call(this._awakeUntil, member); }

  /** Wake ONE member (null/undefined = ALL) until `now + idleMs`. */
  wake(member, nowMs) {
    const until = _clock(nowMs) + this.idleMs;
    if (member == null) {
      for (const m of MEMBERS) this._awakeUntil[m] = until;
      return;
    }
    if (this._has(member)) this._awakeUntil[member] = until;
  }

  /** Extend a member's (null = all) awake window to `untilMs`; never shortens. */
  hold(member, untilMs) {
    const until = _clock(untilMs);
    const rise = (m) => { if (until > this._awakeUntil[m]) this._awakeUntil[m] = until; };
    if (member == null) {
      for (const m of MEMBERS) rise(m);
      return;
    }
    if (this._has(member)) rise(member);
  }

  /** Fade starts NOW for every member. Asleep is still wakeable, unlike a consumer's hide(). */
  sleep(nowMs) {
    const t = _clock(nowMs);
    for (const m of MEMBERS) this._awakeUntil[m] = t;
  }

  /** @returns {boolean} now < awakeUntil (unknown → false) */
  isAwake(member, nowMs) {
    if (!this._has(member)) return false;
    return _clock(nowMs) < this._awakeUntil[member];
  }

  /** @returns {'awake'|'fading'|'hidden'} (unknown → 'hidden') */
  phase(member, nowMs) {
    if (!this._has(member)) return 'hidden';
    const t = _clock(nowMs);
    const until = this._awakeUntil[member];
    if (t < until) return 'awake';
    if (this.fadeMs > 0 && t < until + this.fadeMs) return 'fading';
    return 'hidden';
  }

  /** @returns {number} 1 while awake, else restOpacity */
  opacityFor(member, nowMs) {
    return this.isAwake(member, nowMs) ? 1 : this.restOpacity;
  }

  /** A4 box: `boxedUntil[name] = now + boxMs`. */
  box(name, nowMs) {
    if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(this._boxedUntil, name)) return;
    this._boxedUntil[name] = _clock(nowMs) + this.boxMs;
  }

  /** @returns {boolean} now < boxedUntil (unknown → false) */
  isBoxed(name, nowMs) {
    if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(this._boxedUntil, name)) return false;
    return _clock(nowMs) < this._boxedUntil[name];
  }

  /** @returns {number} boxed-until stamp; -Infinity when never boxed / unknown (no clock read) */
  boxedUntil(name) {
    if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(this._boxedUntil, name)) return -Infinity;
    return this._boxedUntil[name];
  }
}

export default EdgeChrome;
