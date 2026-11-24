/**
 * GameDate.js - the ONE game date, and the angle Earth has turned to at it (Reality 7, DECISIONS §94 row 1, plan decision 3).
 *
 * The scene is inertial (the frame law, `OrbitalMechanics.eciToScene`); Earth turns under it by GMST of the game date about +Y
 * (rotation.y = angle: +X turns toward -Z, which is east). Everything that reads where Earth is now reads it here: the globe
 * (`main.js` -> `Earth.setTurn`), the real-sky dots (`RealSkyLayer`, same clock object), her start orbit (`startOrbitMath`),
 * the ground readers (orbit pane, NEXT pane, nav orb) and the sun / Moon seed.
 *
 * The date is what the game already keeps: the first-start real date + the days the ship has lived (`SunStorms.dateMs`, set as the
 * clock's source by main.js) + the world seconds that ran since that date last changed (the clock's `tick`, fed every frame with
 * the world clock: held and warped as the game holds and warps it; a trip landing moves the date and restarts the sum). Training
 * 1-3 have no date: the clock stamps the real time on first read and runs world seconds from there; when the real date arrives
 * (first live use) the clock carries on from the same moment, so the globe never jumps between missions.
 *
 * Pure: no THREE, no DOM. Node-safe.
 *
 * @module systems/GameDate
 */

import { gmstDeg } from '../scene/Ephemeris.js';

const DAY_MS = 86400000;
const DEG2RAD = Math.PI / 180;

/** Earth's turn rate with respect to the stars, degrees per day (the GMST rate, `Ephemeris.gmstDeg`). */
export const EARTH_ROT_DEG_PER_DAY = 360.98564736629;
/** Earth's turn rate, radians per world second. */
export const EARTH_RATE_RAD_S = EARTH_ROT_DEG_PER_DAY * DEG2RAD / 86400;

/**
 * The one fixed game date of a seeded run (`?seed=N` on a dev host, main.js): the instant Earth's turn angle is 0 (GMST = 0,
 * 2026-01-01 17:14:31.4479 UTC; measured 5e-10 rad). Equal to `TEST_ZERO_ANGLE_MS` in js/test/_testClock.js (a test pins that).
 * With it her start orbit and the pieces' world-fixed tumble meet the same way at any hour, so the same seed repeats the same run.
 */
export const SEEDED_RUN_DATE_MS = 1767287671447.9324;

/**
 * Greenwich sidereal angle at a date: how far Earth has turned about +Y (the polar axis), radians in [0, 2π).
 * Geographic east longitude λ sits at inertial longitude λ + angle.
 * @param {number} dateMs  Unix ms
 * @returns {number}
 */
export function earthAngleRad(dateMs) {
  const d = dateMs / DAY_MS + 2440587.5 - 2451545.0;   // days since J2000
  return gmstDeg(d) * DEG2RAD;
}

/** The shared game clock: base date (from a source) + world seconds since it last moved; see the module header. */
export class GameClock {
  /**
   * @param {{source?: function(): number, now?: function(): number}} [opts] `source` () => the game date ms (NaN before the first
   *   start); `now` () => real ms, read once for the no-date stamp
   */
  constructor(opts = {}) {
    this._source = typeof opts.source === 'function' ? opts.source : () => NaN;
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this._sumS = 0;
    this._last = undefined;     // the source date the sum counts from
    this._stamp = null;         // real ms stamped on first read while there is no date (training)
    this._carryMs = 0;          // keeps the date continuous when the real date arrives after a no-date stretch
  }

  /** @param {function(): number} fn  () => game date ms (NaN = none yet); a source change restarts the sum */
  setSource(fn) { this._source = typeof fn === 'function' ? fn : () => NaN; }

  /** @param {function(): number} fn  () => real ms (tests) */
  setNow(fn) { this._now = typeof fn === 'function' ? fn : () => Date.now(); }

  /** Forget the stamp, the carry and the sum (a test, a new game from the menu). */
  reset() { this._sumS = 0; this._last = undefined; this._stamp = null; this._carryMs = 0; }

  _sync() {
    const d = Number(this._source());
    const same = Object.is(d, this._last) || (Number.isNaN(d) && Number.isNaN(this._last));
    if (same) return;
    // The real date arrives after a no-date stretch: carry on from the moment the clock had reached.
    const wasNone = this._last !== undefined && Number.isNaN(this._last);
    this._carryMs = (wasNone && Number.isFinite(d) && this._stamp !== null) ? (this._stamp + this._sumS * 1000 - d) : 0;
    this._stamp = null;         // a no-date stretch restarts from a fresh stamp
    this._sumS = 0;
    this._last = d;
  }

  /**
   * World seconds that ran this frame (held and warped as the game holds and warps it). Call every frame, on every floor.
   * @param {number} dtWorldS
   */
  tick(dtWorldS) {
    this._sync();
    if (dtWorldS > 0 && Number.isFinite(dtWorldS)) this._sumS += dtWorldS;
  }

  /** @returns {number} the source's game date ms (NaN while none) */
  baseMs() { this._sync(); return Number(this._last); }

  /** @returns {number} world seconds since the source date last changed */
  sinceDateS() { this._sync(); return this._sumS; }

  /**
   * The game date now, ms: the source date + world seconds since it moved; with no source date, the real time stamped at the
   * first read + the same seconds. Never NaN.
   * @returns {number}
   */
  dateMs() {
    this._sync();
    if (Number.isFinite(this._last)) return this._last + this._carryMs + this._sumS * 1000;
    if (this._stamp === null) this._stamp = Number(this._now());
    return this._stamp + this._sumS * 1000;
  }

  /** @returns {number} Earth's turn angle at the game date now, radians */
  earthAngleRad() { return earthAngleRad(this.dateMs()); }
}

/** The game's one clock. main.js sets its source (`sunStorms.dateMs`) and ticks it with the world clock every frame. */
export const gameClock = new GameClock();

/** @returns {number} the game date now, ms */
export function gameDateMs() { return gameClock.dateMs(); }

/** @returns {number} Earth's turn angle at the game date now, radians */
export function gameEarthAngleRad() { return gameClock.earthAngleRad(); }

export default { gameClock, gameDateMs, gameEarthAngleRad, earthAngleRad, GameClock, EARTH_RATE_RAD_S, EARTH_ROT_DEG_PER_DAY };
