/**
 * CeremonyTimeScale.js — shared time-scale source for the Q2 Net-Launch Ceremony.
 *
 * Stage 4 plumbing (CEREMONY_REDESIGN.md §5, §6 R1):
 *   - CameraSystem writes the current beat's `timeScale` here when entering /
 *     advancing a NET_CINEMATIC beat, and resets to 1.0 on exit.
 *   - NetProjectile.update() and CaptureNetVisual.update() read this value to
 *     scale their internal dt — and ONLY their internal dt. World dt (orbital
 *     propagation, debris field, conjunctions, station-keep, tether, scoring,
 *     etc.) MUST remain at 1.0× per §6 R1 ("Time-dilation bleed into game
 *     state" — High severity risk).
 *
 * This module is process-global by design. There is exactly one ceremony in
 * flight at a time (Q2 §R8), so a single shared cell is sufficient. The
 * default value of 1.0 is a hard short-circuit — when no ceremony is active
 * (or the feature flag is off and CameraSystem never writes), readers get
 * 1.0× and run at normal speed.
 *
 * Why a tiny module instead of a getter on CameraSystem:
 *   CameraSystem is exported as a class (not a singleton instance) and is
 *   instantiated inside main.js. Importing the class to call an instance
 *   method from NetProjectile / CaptureNetVisual would require routing the
 *   live instance reference through both entities. A shared module sidesteps
 *   that import direction problem and keeps the coupling additive.
 *
 * @module systems/CeremonyTimeScale
 */

let _scale = 1.0;

export const CeremonyTimeScale = {
  /**
   * Read the current ceremony time-scale.
   * @returns {number} Multiplier in (0, 1.0]. Defaults to 1.0 (no scaling).
   */
  get() {
    return _scale;
  },

  /**
   * Write the current ceremony time-scale. Non-positive or non-finite values
   * are coerced to 1.0 for safety (a runaway zero would freeze the projectile
   * FSM mid-flight).
   * @param {number} s — desired multiplier (typically 0.3 – 1.0)
   */
  set(s) {
    if (typeof s === 'number' && isFinite(s) && s > 0) {
      _scale = s;
    } else {
      _scale = 1.0;
    }
  },

  /**
   * Reset to 1.0× (no scaling). Used by CameraSystem._exitNetCeremony() and
   * by tests in teardown.
   */
  reset() {
    _scale = 1.0;
  },
};

export default CeremonyTimeScale;
