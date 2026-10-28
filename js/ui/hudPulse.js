/**
 * @module ui/hudPulse — Calm-HUD pulse helpers and the shared rate ceiling.
 * Policy (user-confirmed): standing states read steady (colour/glyph carry severity); events may pulse but
 * finitely (nothing oscillates forever); any retained motion stays <= MAX_ALERT_PULSE_HZ with small amplitude.
 * Reference shape: the TargetReticle "▸ N" nudge, ~0.29 Hz breathe over ~6 s behind a 0.8 s fade-in.
 * Gotcha: `document.getAnimations()` CANNOT see canvas pulses (reticle / NavSphere write `ctx.globalAlpha` per
 * frame), and DOM strobes can hide as per-frame `style.opacity` writes. Audit with:
 *   rg -n "(globalAlpha|opacity)\s*=?.*Math\.(sin|abs)" js/ui js/systems
 *   rg -n "const (pulse|blink|flash|breathe)\w*\s*=.*Math\.sin" js/ui js/systems
 * CSS-only greps (`@keyframes`, `animation:`) are necessary but not sufficient.
 */

import { Constants } from '../core/Constants.js';
import { clamp01 } from '../core/MathUtil.js';

/**
 * OS/browser reduce-motion preference (Node-safe, cached). When true, canvas overlays skip all pulsing
 * (the CSS media block only reaches DOM animations, not per-frame `ctx.globalAlpha` writes).
 */
let _reducedMotionCache = null;
export function prefersReducedMotion() {
  if (_reducedMotionCache !== null) return _reducedMotionCache;
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
      _reducedMotionCache = !!mql.matches;
      // One-shot listener: after a mid-session OS toggle the next read re-queries and re-registers.
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
 * Calm arrival cue: a slow breathe whose amplitude decays to a small steady state, behind a short fade-in.
 * Rate is clamped to Constants.HUD.MAX_ALERT_PULSE_HZ. Reference shape is the TargetReticle "▸ N" nudge.
 *
 * @param {number} time — monotonic clock, seconds
 * @param {number} shownFor — seconds since the cue appeared (0 at arrival)
 * @param {object} [opts]
 * @param {number} [opts.hz=0.2865] — breathe frequency (clamped to ceiling); default = sin(t·1.8) rad/s
 * @param {number} [opts.base=0.84] — steady-state alpha. Keep base + amp0 ≤ 1: canvas IGNORES an
 *   out-of-range globalAlpha (keeps the previous value), so a peak above 1 would flatten the breath.
 * @param {number} [opts.amp0=0.16] — initial amplitude (±)
 * @param {number} [opts.ampMin=0.05] — settled amplitude (±)
 * @param {number} [opts.decayPerSec=0.018] — linear amplitude decay rate
 * @param {number} [opts.fadeInS=0.8] — fade-in duration
 * @returns {number} alpha multiplier in [0, 1]
 */
export function calmBreathe(time, shownFor, opts = {}) {
  if (prefersReducedMotion()) return 1;
  const ceiling = (Constants.HUD && Constants.HUD.MAX_ALERT_PULSE_HZ) || 0.5;
  const hz = Math.min(opts.hz ?? (1.8 / (2 * Math.PI)), ceiling);
  const base = opts.base ?? 0.84;
  const amp0 = opts.amp0 ?? 0.16;
  const ampMin = opts.ampMin ?? 0.05;
  const decayPerSec = opts.decayPerSec ?? 0.018;
  const fadeInS = opts.fadeInS ?? 0.8;
  const fadeIn = Math.min(1, Math.max(0, shownFor) / fadeInS);
  const amp = Math.max(ampMin, amp0 - decayPerSec * shownFor);
  const a = fadeIn * (base + amp * Math.sin(time * hz * 2 * Math.PI));
  // Clamp: canvas silently ignores an out-of-range globalAlpha (leaks the previous alpha).
  return clamp01(a);
}

/**
 * Finite event flourish (capture, lock-on; never standing states): one smooth dip that STARTS and ENDS at
 * alpha 1. Ending at 1 matters: oscillating around a dim base looks faded, then pops to full at expiry.
 * Rate is clamped to Constants.HUD.MAX_ALERT_PULSE_HZ.
 *
 * @param {number} elapsed — seconds since the event started
 * @param {object} [opts]
 * @param {number} [opts.hz=0.5] — pulse frequency (clamped to ceiling)
 * @param {number} [opts.cycles=2] — duration = cycles/hz seconds
 * @param {number} [opts.depth=0.3] — how far the dip descends below 1
 * @returns {number} alpha multiplier in [0, 1]
 */
export function finitePulse(elapsed, opts = {}) {
  if (prefersReducedMotion()) return 1;
  const ceiling = (Constants.HUD && Constants.HUD.MAX_ALERT_PULSE_HZ) || 0.5;
  const hz = Math.min(opts.hz ?? 0.5, ceiling);
  const duration = (opts.cycles ?? 2) / hz;
  const depth = opts.depth ?? 0.3;
  if (!(elapsed > 0) || elapsed >= duration) return 1;
  const a = 1 - depth * Math.sin(Math.PI * elapsed / duration);
  return clamp01(a);
}
