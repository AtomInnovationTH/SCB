/**
 * @module systems/CeremonyTimeScale — shared time-scale source for the Net-Launch Ceremony (archive/CEREMONY_REDESIGN.md
 * §5, §6 R1):
 *   - CameraSystem writes the current beat's `timeScale` here when entering / advancing a NET_CINEMATIC beat, and
 *     resets to 1.0 on exit.
 *   - NetProjectile.update() and CaptureNetVisual.update() read this value to scale their internal dt — and ONLY
 *     their internal dt. World dt (orbital propagation, debris field, conjunctions, station-keep, tether, scoring,
 *     etc.) MUST remain at 1.0× (§6 R1: "Time-dilation bleed into game state" is a High severity risk).
 *
 * Process-global by design: exactly one ceremony is in flight at a time (§R8), so a single shared cell suffices. The
 * default 1.0 is a hard short-circuit: with no ceremony active (or the feature flag off) readers run at normal speed.
 *
 * Why a tiny module instead of a getter on CameraSystem: CameraSystem is exported as a class and instantiated inside
 * main.js, so NetProjectile / CaptureNetVisual would need the live instance routed through both entities.
 */

let _scale = 1.0;
let _owner = null;

export const CeremonyTimeScale = {
  /** Current ceremony time-scale: multiplier in (0, 1.0], default 1.0 (no scaling). */
  get() {
    return _scale;
  },

  /**
   * The object that currently owns a non-1.0 scale (recorded on `set`), or `null` when unscaled. Single-writer
   * bookkeeping: lets the owner detect and clear a scale it pinned but abandoned.
   */
  owner() {
    return _owner;
  },

  /**
   * Write the current ceremony time-scale. Non-positive or non-finite values are coerced to 1.0 for safety (a runaway
   * zero would freeze the projectile FSM mid-flight).
   * @param {number} s — desired multiplier (typically 0.3 – 1.0)
   * @param {*} [owner] — token identifying the writer, so the same writer (or an unconditional reset) can later clear
   *   the scale. When omitted, the existing owner is preserved (re-assert of one's own scale).
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
   * Reset to 1.0× (no scaling). Single-writer discipline: an owned scale is cleared only by its owner, or by an
   * unconditional (no-owner) reset. Teardown, the pause path, and hard state transitions all use the unconditional
   * `reset()`, so a pinned scale can never survive a ceremony that stopped receiving `update()`. A non-matching owner
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
