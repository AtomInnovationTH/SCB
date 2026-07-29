/**
 * hudPulse.js — Calm-HUD pulse helpers and the shared rate ceiling.
 *
 * Policy (user-confirmed, Phase 4 de-blink): standing states read steady —
 * colour/glyph carry severity; events may pulse but finitely; nothing
 * oscillates forever; any retained motion stays ≤ MAX_ALERT_PULSE_HZ with
 * small amplitude. The in-repo reference shape is the TargetReticle "▸ N"
 * nudge: ~0.29 Hz breathe, amplitude easing ±0.16 → ±0.05 over ~6 s, then
 * settling near-steady behind a 0.8 s fade-in.
 *
 * Diagnostic gap (worth knowing before the next audit):
 * `document.getAnimations()` CANNOT see canvas pulses — the reticle /
 * NavSphere overlays write `ctx.globalAlpha` per frame, so a "is anything
 * still blinking?" check based on that API will report nothing for them.
 * DOM strobes can also hide as per-frame `style.opacity` / `style.borderColor`
 * writes with no CSS keyframes at all. The reliable checks are:
 *   rg -n "(globalAlpha|opacity)\s*=?.*Math\.(sin|abs)" js/ui js/systems
 *   rg -n "const (pulse|blink|flash|breathe)\w*\s*=.*Math\.sin" js/ui js/systems
 * plus visual inspection (a frozen-`_time` debug toggle on the reticles works
 * well). CSS-only greps (`@keyframes`, `animation:`) are necessary but NOT
 * sufficient.
 *
 * @module ui/hudPulse
 */

import { Constants } from '../core/Constants.js';

/**
 * Detect the OS/browser reduce-motion preference (Node-safe, cached).
 * When true, canvas overlays should skip all pulsing — the Phase 1 CSS media
 * block only reaches DOM animations, not per-frame `ctx.globalAlpha` writes.
 * @returns {boolean}
 */
let _reducedMotionCache = null;
export function prefersReducedMotion() {
  if (_reducedMotionCache !== null) return _reducedMotionCache;
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
      _reducedMotionCache = !!mql.matches;
      // Live invalidation: the rest of the codebase (main.js, CameraSystem,
      // MenuScreen) re-queries matchMedia on every call, so respond to a
      // mid-session OS toggle too. One-shot listener: after it fires, the
      // next read re-queries and re-registers on a fresh MQL.
      if (typeof mql.addEventListener === 'function') {
        mql.addEventListener('change', _resetReducedMotionCache, { once: true });
      }
    } else {
      _reducedMotionCache = false;
    }
  } catch (_) {
    _reducedMotionCache = false;
  }
  return _reducedMotionCache;
}

/** Clear the cached media-query result (media-query change listener + test hook). */
export function _resetReducedMotionCache() {
  _reducedMotionCache = null;
}

/**
 * Calm arrival cue: a slow breathe whose amplitude decays toward a small
 * steady-state, behind a short fade-in. Greets the eye, then settles instead
 * of nagging. Rate is clamped to Constants.HUD.MAX_ALERT_PULSE_HZ.
 *
 * @param {number} time — monotonic clock (e.g. this._time), seconds
 * @param {number} shownFor — seconds since the cue appeared (0 at arrival)
 * @param {object} [opts]
 * @param {number} [opts.hz=0.2865] — breathe frequency (clamped to ceiling);
 *   default matches the reference "▸ N" nudge exactly (sin(t·1.8) rad/s)
 * @param {number} [opts.base=0.9] — steady-state alpha the cue settles to
 * @param {number} [opts.amp0=0.16] — initial amplitude (±)
 * @param {number} [opts.ampMin=0.05] — settled amplitude (±)
 * @param {number} [opts.decayPerSec=0.018] — linear amplitude decay rate
 * @param {number} [opts.fadeInS=0.8] — fade-in duration
 * @returns {number} alpha multiplier in (0, 1]
 */
export function calmBreathe(time, shownFor, opts = {}) {
  if (prefersReducedMotion()) return 1;
  const ceiling = (Constants.HUD && Constants.HUD.MAX_ALERT_PULSE_HZ) || 0.5;
  const hz = Math.min(opts.hz ?? (1.8 / (2 * Math.PI)), ceiling);
  const base = opts.base ?? 0.9;
  const amp0 = opts.amp0 ?? 0.16;
  const ampMin = opts.ampMin ?? 0.05;
  const decayPerSec = opts.decayPerSec ?? 0.018;
  const fadeInS = opts.fadeInS ?? 0.8;
  const fadeIn = Math.min(1, shownFor / fadeInS);
  const amp = Math.max(ampMin, amp0 - decayPerSec * shownFor);
  return fadeIn * (base + amp * Math.sin(time * hz * 2 * Math.PI));
}

/**
 * Finite event pulse: `cycles` full oscillations at `hz` starting at
 * `elapsed = 0`, then settles to 1. For events (lock-on, capture), never for
 * standing states. Rate is clamped to Constants.HUD.MAX_ALERT_PULSE_HZ.
 *
 * @param {number} elapsed — seconds since the event started
 * @param {object} [opts]
 * @param {number} [opts.hz=0.5] — pulse frequency (clamped to ceiling)
 * @param {number} [opts.cycles=2] — number of full oscillations before settling
 * @param {number} [opts.base=0.7] — oscillation centre
 * @param {number} [opts.amp=0.3] — oscillation amplitude (±)
 * @returns {number} alpha multiplier in (0, 1]
 */
export function finitePulse(elapsed, opts = {}) {
  if (prefersReducedMotion()) return 1;
  const ceiling = (Constants.HUD && Constants.HUD.MAX_ALERT_PULSE_HZ) || 0.5;
  const hz = Math.min(opts.hz ?? 0.5, ceiling);
  const cycles = opts.cycles ?? 2;
  const base = opts.base ?? 0.7;
  const amp = opts.amp ?? 0.3;
  const duration = cycles / hz;
  if (elapsed >= duration) return 1;
  return base + amp * Math.sin(elapsed * hz * 2 * Math.PI);
}
