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
let _owner = null;

export const CeremonyTimeScale = {
  /**
   * Read the current ceremony time-scale.
   * @returns {number} Multiplier in (0, 1.0]. Defaults to 1.0 (no scaling).
   */
  get() {
    return _scale;
  },

  /**
   * The object that currently owns a non-1.0 scale (recorded on `set`), or
   * `null` when unscaled. Single-writer bookkeeping (visual-centerpiece plan
   * §6 P3): lets the owner detect and clear a scale it pinned but abandoned.
   * @returns {*} owner token or null
   */
  owner() {
    return _owner;
  },

  /**
   * Write the current ceremony time-scale. Non-positive or non-finite values
   * are coerced to 1.0 for safety (a runaway zero would freeze the projectile
   * FSM mid-flight).
   * @param {number} s — desired multiplier (typically 0.3 – 1.0)
   * @param {*} [owner] — token identifying the writer. Recorded so the same
   *   writer (or an unconditional reset) can later clear the scale. When
   *   omitted, the existing owner is preserved (re-assert of one's own scale).
   */
  set(s, owner) {
    if (typeof s === 'number' && isFinite(s) && s > 0) {
      _scale = s;
      if (owner !== undefined) _owner = owner;
    } else {
      _scale = 1.0;
      _owner = null;
    }
  },

  /**
   * Reset to 1.0× (no scaling). Single-writer discipline (§6 P3): an owned
   * scale is cleared only by its owner, or by an unconditional (no-owner)
   * reset. Teardown, the pause path, and hard state transitions all use the
   * unconditional form — `reset()` — so a pinned scale can never survive a
   * ceremony that stopped receiving `update()`. Passing a non-matching owner
   * is a no-op, so one ceremony cannot clobber another's scale.
   * @param {*} [owner] — when supplied, only clears if it matches the recorded owner
   */
  reset(owner) {
    if (owner === undefined || owner === _owner) {
      _scale = 1.0;
      _owner = null;
    }
  },
};

export default CeremonyTimeScale;
