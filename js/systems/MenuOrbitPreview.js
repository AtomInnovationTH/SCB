/**
 * MenuOrbitPreview.js — re-aim the live menu backdrop when the language changes.
 *
 * The menu canvas is transparent and the LIVE orbital scene renders behind it:
 * in MENU state the player satellite slowly propagates its orbit (0.1×) with
 * the camera following (main.js "Camera still follows (slow) for nice menu
 * background"). But the starting orbit was only staged on New Game — so the
 * backdrop used to sit on a default orbit unrelated to the selected language
 * until the game started.
 *
 * This module closes the gap:
 *  • init() snaps the player's orbit to the current language's start orbit so
 *    the menu backdrop matches the identity from first paint.
 *  • Events.LANGUAGE_CHANGED (in MENU state) drives the actual orbit elements
 *    — RAAN swing (Earth slides east/west), inclination roll (Sun-sync ↔
 *    equatorial), along-track slide — to the new homeland with a
 *    rate-capped RAMP UP / CRUISE / RAMP DOWN (trapezoidal velocity) profile
 *    instead of cutting. Duration falls out of the distance: short hops stay
 *    snappy (~1 s), the longest traverse (es→pt, ~173° RAAN) takes ~5 s at a
 *    capped 40°/s instead of whipping through it in 2 s.
 *  • Retarget-safe mid-flight: the current sweep rate carries over to the new
 *    target (clamped to what is brakeable in the new distance), so clicking
 *    through several languages stays continuous instead of stalling and
 *    re-accelerating on every click.
 *  • On MENU_DEPARTURE_START (Start pressed) an in-flight morph races an
 *    arrival deadline just inside the cinematic so the backdrop LANDS before
 *    MENU_START snaps the orbit at the cut — unless the deadline is
 *    unreachable (short continue departure), in which case the cut masks it.
 *
 * Zero gameplay risk: GameFlowManager._applyStartLocation() re-stages the same
 * orbit authoritatively on every start path (both use computeStartOrbit from
 * startOrbitMath.js — the single source of truth).
 *
 * Reduced motion: prefers-reduced-motion snaps instantly, no morph.
 *
 * @module systems/MenuOrbitPreview
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { gameState, GameStates } from '../core/GameState.js';
import { settingsManager } from './SettingsManager.js';
import { computeStartOrbit } from './startOrbitMath.js';

const TWO_PI = 2 * Math.PI;
/** Peak sweep rate of the dominant orbit element, rad/s (~40°/s). */
export const MORPH_MAX_RATE = 40 * Math.PI / 180;
/** Accel/decel limit, rad/s² (~50°/s² → 0.8 s ramps). */
export const MORPH_ACCEL = 50 * Math.PI / 180;
/** Settle threshold, rad. */
export const MORPH_EPS = 1e-4;
/** Ceiling on the sweep rate while racing a departure deadline, rad/s (~100°/s). */
export const MORPH_RUSH_MAX_RATE = 2.5 * MORPH_MAX_RATE;
/** Aim to land this far inside the departure window (fraction of duration). */
export const MORPH_DEADLINE_FRACTION = 0.9;

/**
 * Signed shortest angular delta from a to b, in [-π, π].
 * @param {number} a @param {number} b — radians
 * @returns {number} radians
 */
export function shortestDelta(a, b) {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d < -Math.PI) d += TWO_PI;
  return d;
}

/**
 * Interpolate an angle the short way around the circle (mod 2π).
 * @param {number} a @param {number} b — radians
 * @param {number} t ∈ [0,1]
 * @returns {number} radians, normalised to [0, 2π)
 */
export function lerpAngleShortest(a, b, t) {
  return (((a + shortestDelta(a, b) * t) % TWO_PI) + TWO_PI) % TWO_PI;
}

/**
 * Closed-form duration of the trapezoidal (or triangular) profile for a given
 * dominant-element distance. Used by tests and for tuning the constants.
 * @param {number} dist — radians
 * @returns {number} seconds
 */
export function estimateMorphDuration(dist) {
  const dRamp = (MORPH_MAX_RATE * MORPH_MAX_RATE) / (2 * MORPH_ACCEL);
  if (dist <= 2 * dRamp) return 2 * Math.sqrt(dist / MORPH_ACCEL);
  return 2 * (MORPH_MAX_RATE / MORPH_ACCEL) + (dist - 2 * dRamp) / MORPH_MAX_RATE;
}

/** Detect the OS/browser reduce-motion preference (Node-safe). */
function _prefersReducedMotion() {
  try {
    return !!(typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (_) {
    return false;
  }
}

export class MenuOrbitPreview {
  constructor() {
    this._player = null;
    this._target = null;  // {inclination, raan, trueAnomaly} | null — morph goal
    this._rate = 0;       // current sweep rate of the dominant element, rad/s
    this._deadline = null; // seconds left to arrive before a pending departure cut, else null
    this._onLangChanged = (data) => this._retarget(data && data.lang);
    this._onDeparture = (data) => this._raceDeparture(data);
  }

  /**
   * @param {object} opts
   * @param {object} opts.player — must expose .orbit {inclination, raan, trueAnomaly}
   */
  init({ player } = {}) {
    this._player = player || null;
    // Snap the backdrop to the current language so the menu opens over home.
    this._snap(settingsManager.getLanguageEntry());
    eventBus.on(Events.LANGUAGE_CHANGED, this._onLangChanged);
    eventBus.on(Events.MENU_DEPARTURE_START, this._onDeparture);
  }

  /** @private Write a computed start orbit straight onto the player's orbit. */
  _snap(lang) {
    if (!this._player || !this._player.orbit) return;
    const orbit = computeStartOrbit(lang);
    if (!orbit) return;
    this._player.orbit.inclination = orbit.inclination;
    this._player.orbit.raan = orbit.raan;
    this._player.orbit.trueAnomaly = orbit.trueAnomaly;
    this._player.orbit.eccentricity = 0.0001;
    this._player.orbit.argPerigee = 0;
    this._target = null;
    this._rate = 0;
    this._deadline = null;
  }

  /** @private Dominant-element angular distance from the orbit to a target. */
  _distanceTo(target) {
    const o = this._player.orbit;
    return Math.max(
      Math.abs(target.inclination - o.inclination),
      Math.abs(shortestDelta(o.raan, target.raan)),
      Math.abs(shortestDelta(o.trueAnomaly, target.trueAnomaly)),
    );
  }

  /** @private Begin (or retarget) a morph toward a new language's orbit. */
  _retarget(lang) {
    if (!this._player || !this._player.orbit) return;
    // Only the menu backdrop is cosmetic — never touch a live flight.
    if (gameState.currentState !== GameStates.MENU) return;
    const target = computeStartOrbit(lang);
    if (!target) return;
    if (_prefersReducedMotion()) { this._snap(lang); return; }
    this._target = target;
    // Carry the current sweep rate over (no stall-and-kick per click), but
    // never more than is brakeable in the new distance — a reversal must not
    // produce a late hard stop.
    this._rate = Math.min(this._rate, Math.sqrt(2 * MORPH_ACCEL * this._distanceTo(target)));
    // A language click during a departure is not reachable in practice (the
    // menu chrome is already tearing down). If it ever were, drop the rush —
    // a fresh target invalidates the old arrival budget.
    this._deadline = null;
  }

  /**
   * @private On MENU_DEPARTURE_START, race an in-flight morph to arrive before
   * MENU_START snaps the orbit (GameFlowManager._applyStartLocation) at the cut.
   * Declines an unreachable deadline (e.g. the ~600 ms continue departure): a
   * match-cut masks a snap far better than a violent whip would.
   * @param {{durationMs?:number}} data
   */
  _raceDeparture({ durationMs } = {}) {
    if (!this._target || !this._player || !this._player.orbit) return;
    if (gameState.currentState !== GameStates.MENU) return;
    const secs = (Number.isFinite(durationMs) ? durationMs : 0) / 1000 * MORPH_DEADLINE_FRACTION;
    if (secs <= 0) return;
    if (this._distanceTo(this._target) / secs > MORPH_RUSH_MAX_RATE) return;
    this._deadline = secs;
  }

  /**
   * Per-frame advance of the morph: accelerate toward MORPH_MAX_RATE, decelerate
   * when the remaining distance is within stopping distance, settle exactly.
   * While a departure deadline is pending, the rate is floored at what arrival
   * requires (capped at MORPH_RUSH_MAX_RATE) so the view lands before the cut.
   * Ungated in the main loop; a no-op outside MENU state (any in-flight morph
   * is cancelled — the start paths re-stage).
   * @param {number} dt — seconds
   */
  update(dt) {
    if (!this._target || !this._player || !this._player.orbit) return;
    if (gameState.currentState !== GameStates.MENU) {
      this._target = null;
      this._rate = 0;
      this._deadline = null;
      return;
    }
    const o = this._player.orbit, t = this._target;
    const dInc = t.inclination - o.inclination;
    const dRaan = shortestDelta(o.raan, t.raan);
    const dNu = shortestDelta(o.trueAnomaly, t.trueAnomaly);
    const dist = Math.max(Math.abs(dInc), Math.abs(dRaan), Math.abs(dNu));
    if (dist <= MORPH_EPS) {
      o.inclination = t.inclination;
      o.raan = t.raan;
      o.trueAnomaly = t.trueAnomaly;
      this._target = null;
      this._rate = 0;
      this._deadline = null;
      return;
    }

    const stopDist = (this._rate * this._rate) / (2 * MORPH_ACCEL);
    this._rate = dist <= stopDist
      // Floor at one accel step so the approach can never crawl asymptotically.
      ? Math.max(MORPH_ACCEL * dt, this._rate - MORPH_ACCEL * dt)
      : Math.min(MORPH_MAX_RATE, this._rate + MORPH_ACCEL * dt);

    // Departure deadline: floor the rate at what arrival requires so the view
    // lands before MENU_START snaps the orbit. Only ever raises the rate, and
    // only up to the rush ceiling; the step clamp below still bars overshoot.
    // `need` uses the remaining time BEFORE this frame's decrement so it never
    // inflates above the arm-time reachability check.
    if (this._deadline !== null) {
      const need = dist / Math.max(this._deadline, dt);   // guard div-by-zero
      this._deadline = Math.max(0, this._deadline - dt);
      this._rate = Math.min(MORPH_RUSH_MAX_RATE, Math.max(this._rate, need));
    }

    const step = Math.min(dist, this._rate * dt);   // clamp ⇒ never overshoot
    const f = step / dist;
    o.inclination += dInc * f;
    o.raan = lerpAngleShortest(o.raan, t.raan, f);
    o.trueAnomaly = lerpAngleShortest(o.trueAnomaly, t.trueAnomaly, f);
    if (step >= dist) {
      // Settle exactly on the computed orbit.
      o.inclination = t.inclination;
      o.raan = t.raan;
      o.trueAnomaly = t.trueAnomaly;
      this._target = null;
      this._rate = 0;
      this._deadline = null;
    }
  }

  dispose() {
    eventBus.off(Events.LANGUAGE_CHANGED, this._onLangChanged);
    eventBus.off(Events.MENU_DEPARTURE_START, this._onDeparture);
    this._target = null;
    this._rate = 0;
    this._deadline = null;
    this._player = null;
  }
}

/** Singleton (wired in main.js). */
export const menuOrbitPreview = new MenuOrbitPreview();
export default MenuOrbitPreview;
