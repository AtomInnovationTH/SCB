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
 *  • Events.LANGUAGE_CHANGED (in MENU state) starts a ~2 s eased morph of the
 *    actual orbit elements — RAAN swing (Earth slides east/west), inclination
 *    roll (Sun-sync ↔ equatorial), along-track slide — so the backdrop TRAVELS
 *    to the new homeland instead of cutting. Retarget-safe mid-flight.
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
/** Morph duration in seconds. */
export const PREVIEW_MORPH_S = 2.0;

/** easeInOutCubic — slow start, fast middle, slow settle. */
export function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Interpolate an angle the short way around the circle (mod 2π).
 * @param {number} a @param {number} b — radians
 * @param {number} t ∈ [0,1]
 * @returns {number} radians, normalised to [0, 2π)
 */
export function lerpAngleShortest(a, b, t) {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d < -Math.PI) d += TWO_PI;
  return (((a + d * t) % TWO_PI) + TWO_PI) % TWO_PI;
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
    this._tween = null;   // { from, to, t } — orbit element morph in progress
    this._onLangChanged = (data) => this._retarget(data && data.lang);
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
    this._tween = null;
  }

  /** @private Begin (or retarget) a morph toward a new language's orbit. */
  _retarget(lang) {
    if (!this._player || !this._player.orbit) return;
    // Only the menu backdrop is cosmetic — never touch a live flight.
    if (gameState.currentState !== GameStates.MENU) return;
    const target = computeStartOrbit(lang);
    if (!target) return;
    if (_prefersReducedMotion()) { this._snap(lang); return; }
    this._tween = {
      t: 0,
      from: {
        inclination: this._player.orbit.inclination,
        raan: this._player.orbit.raan,
        trueAnomaly: this._player.orbit.trueAnomaly,
      },
      to: target,
    };
  }

  /**
   * Per-frame advance of the morph. Ungated in the main loop; a no-op outside
   * MENU state (any in-flight morph is cancelled — the start paths re-stage).
   * @param {number} dt — seconds
   */
  update(dt) {
    if (!this._tween || !this._player || !this._player.orbit) return;
    if (gameState.currentState !== GameStates.MENU) { this._tween = null; return; }
    this._tween.t = Math.min(1, this._tween.t + dt / PREVIEW_MORPH_S);
    const k = easeInOutCubic(this._tween.t);
    const { from, to } = this._tween;
    this._player.orbit.inclination = from.inclination + (to.inclination - from.inclination) * k;
    this._player.orbit.raan = lerpAngleShortest(from.raan, to.raan, k);
    this._player.orbit.trueAnomaly = lerpAngleShortest(from.trueAnomaly, to.trueAnomaly, k);
    if (this._tween.t >= 1) {
      // Settle exactly on the computed orbit.
      this._player.orbit.inclination = to.inclination;
      this._player.orbit.raan = to.raan;
      this._player.orbit.trueAnomaly = to.trueAnomaly;
      this._tween = null;
    }
  }

  dispose() {
    eventBus.off(Events.LANGUAGE_CHANGED, this._onLangChanged);
    this._tween = null;
    this._player = null;
  }
}

/** Singleton (wired in main.js). */
export const menuOrbitPreview = new MenuOrbitPreview();
export default MenuOrbitPreview;
