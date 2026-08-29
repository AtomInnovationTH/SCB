/**
 * TimeAuthority.js — the Zoom Ladder's ONE world-time choke point (S3 / T2).
 *
 * Before the ladder, "1 real second = 10 game seconds" was smeared across the
 * codebase: every world-sim entity multiplied `Constants.TIME_SCALE_GAMEPLAY`
 * internally (DebrisField, PlayerSatellite, ArmUnit, CaptureNet, LassoSystem,
 * ConjunctionSystem, the bosses, TrawlManager's hardcoded ×10, …). There was no
 * single place to implement the ladder's per-floor time caps or automatic warp
 * (docs/ladder/02-traps.md T2).
 *
 * This module is that single place. It splits the frame's time into two rates:
 *
 *   - **dtReal**  — real (slow-mo-scaled) seconds: camera, UI, ceremonies,
 *     attitude substeps, resources, animations. Unwarped.
 *   - **dtWorld** — world-simulation seconds = `dtReal × scale`, where
 *     `scale = BASE_SCALE × rate` and `rate` (the ladder warp multiplier) drifts
 *     toward the current floor's `timeCap` (docs/ladder/01-numbers.md:
 *     [0,1,1,1,4,20,100]).
 *
 * `BASE_SCALE` mirrors the shipped `Constants.TIME_SCALE_GAMEPLAY` (=10). With
 * the ladder disengaged (`active:false`, i.e. `Constants.LADDER.ENABLED` off or
 * not in gameplay) the authority pins `rate = 1` INSTANTLY — no ramp — so
 * `dtWorld === dtReal × BASE_SCALE` bit-for-bit and shipped behavior is
 * byte-identical.
 *
 * The mechanical sweep replaced every `dt * Constants.TIME_SCALE_GAMEPLAY`:
 *   - world-sim orbital systems (DebrisField/PlayerSatellite/ActiveSatellite/
 *     AutopilotSystem/ConjunctionSystem MOID timer) receive the live `dtWorld`
 *     from the main-loop choke point (default `TimeAuthority.baseGameDt(dt)` for
 *     headless/test callers — byte-identical to the old ×10);
 *   - close-range / cosmetic sites that only ever run at warp 1× (arms, nets,
 *     lassos, comms, tumble spins, sun sweep) read the `BASE_SCALE` constant.
 *
 * Warp behaviors this authority owns (docs/ladder/00-spec.md §7,
 * FloorContract.TIME_RULES):
 *   - **Automatic warp**: `rate` drifts toward the floor cap when calm.
 *   - **Danger cap**: a conjunction inside the alarm horizon ramps `rate` to 1×
 *     (fast, safety) so alarms always land at 1×.
 *   - **Crossing pre-ramp**: during a ride the ZoomLadder core already reports
 *     the DESTINATION floor as the current floor, so feeding its `timeCap` as
 *     the target pre-ramps toward the arrival rate during the flight
 *     (down-crossings ramp fast; up-crossings ease in — "visible feedback").
 *   - **MOID screening** above `MOID_SCREENING_ABOVE` (10×): the per-frame
 *     instantaneous proximity scan is invalid when objects teleport per frame,
 *     so conjunction detection switches to orbit-geometry MOID screening.
 *   - **Drag chunking**: atmospheric drag (a first-order Euler step) integrates
 *     in ≤ `DRAG_CHUNK_GAME_S` (60) game-second chunks so the decay factor can
 *     never go negative at high warp. Kepler propagation is analytic and stable
 *     at any dt, so only drag needs chunking.
 *
 * Pure and deterministic: no THREE/DOM/EventBus, no `Date.now`/timers. The
 * instance holds only the ramp state; every input carries its own `dtReal`.
 *
 * @module systems/TimeAuthority
 */

import { Constants } from '../core/Constants.js';
import { FloorContract } from '../core/FloorContract.js';

const TR = FloorContract.TIME_RULES;

export class TimeAuthority {
  /** Shipped base rate: 1 real second = BASE_SCALE game seconds (=10). */
  static get BASE_SCALE() { return Constants.TIME_SCALE_GAMEPLAY; }

  /** Warp above this switches conjunction detection to MOID screening (=10). */
  static get MOID_SCREENING_ABOVE() { return TR.MOID_SCREENING_ABOVE; }

  /** Atmospheric drag integrates in ≤ this many game-seconds per Euler chunk (=60). */
  static get DRAG_CHUNK_GAME_S() { return TR.DRAG_CHUNK_GAME_S; }

  /**
   * Byte-identical replacement for the old `dt * Constants.TIME_SCALE_GAMEPLAY`.
   * The default `dtWorld` for headless/close-range callers that never warp; the
   * live warped value is threaded from the main-loop choke point instead.
   * @param {number} dtReal - real seconds
   * @returns {number} game seconds at the base (unwarped) rate
   */
  static baseGameDt(dtReal) { return dtReal * Constants.TIME_SCALE_GAMEPLAY; }

  /**
   * Number of ≤ DRAG_CHUNK_GAME_S Euler sub-steps a drag integration should take
   * for a given game-time step. Returns 1 (a single, byte-identical step) for
   * any `gameDt ≤ DRAG_CHUNK_GAME_S`; only high-warp frames subdivide.
   * @param {number} gameDt - world-time step (game seconds)
   * @returns {number} integer ≥ 1
   */
  static dragSubSteps(gameDt) {
    const c = TR.DRAG_CHUNK_GAME_S;
    if (!(gameDt > c)) return 1;
    return Math.ceil(gameDt / c);
  }

  /**
   * @param {object} [opts]
   * @param {number} [opts.rampUpTauMs=400]   - exponential τ ramping warp UP (gentle auto-warp drift)
   * @param {number} [opts.rampDownTauMs=120] - exponential τ ramping warp DOWN (fast safety / down-crossing pre-ramp)
   */
  constructor(opts = {}) {
    this._rampUpTau = opts.rampUpTauMs ?? 400;
    this._rampDownTau = opts.rampDownTauMs ?? 120;

    /** @type {number} warp multiplier on top of BASE_SCALE (1 = shipped speed). */
    this.rate = 1;
    /** @type {number} last real (slow-mo-scaled) delta fed in (seconds). */
    this.dtReal = 0;
    /** @type {number} last world delta = dtReal × scale (game seconds). */
    this.dtWorld = 0;
    /** @type {number} live world scale = BASE_SCALE × rate (game-s per real-s). */
    this.scale = TimeAuthority.BASE_SCALE;
    this._moidScreening = false;
  }

  /** True while warp is high enough that conjunction detection uses MOID screening. */
  isMoidScreening() { return this._moidScreening; }

  /** Instant pin to the shipped base rate (flag-off / disengage). Byte-identical. */
  reset() {
    this.rate = 1;
    this.scale = TimeAuthority.BASE_SCALE;
    this._moidScreening = false;
    this.dtWorld = this.dtReal * this.scale;
    return this;
  }

  /**
   * Advance the warp rate one frame and compute this frame's dtWorld.
   *
   * @param {object} p
   * @param {number}  [p.dtReal=0]      - real (slow-mo-scaled) seconds this frame
   * @param {boolean} [p.active=false]  - warp allowed (ladder flag on + gameplay + engaged)
   * @param {number}  [p.targetCap=1]   - auto-warp target = current/destination floor timeCap
   * @param {boolean} [p.dangerActive=false] - conjunction inside alarm horizon → ramp to 1×
   * @returns {this}
   */
  update({ dtReal = 0, active = false, targetCap = 1, dangerActive = false } = {}) {
    this.dtReal = dtReal;

    // Inactive: pin the shipped base rate with NO ramp so flag-off is
    // byte-identical (dtWorld === dtReal × BASE_SCALE, bit-for-bit).
    if (!active) {
      this.rate = 1;
      this.scale = TimeAuthority.BASE_SCALE;
      this._moidScreening = false;
      this.dtWorld = dtReal * this.scale;
      return this;
    }

    // Auto-warp target = floor cap, clamped to 1× when danger is present. The
    // danger clamp never RAISES the target (min), so a cap-0 floor stays paused.
    const cap = Math.max(0, targetCap);
    const target = dangerActive ? Math.min(1, cap) : cap;

    // Exponential approach; ramping DOWN (target < rate) uses the fast τ so
    // danger and down-crossings arrive slow, ramping UP uses the gentle τ so
    // auto-warp / up-crossings ease in with visible feedback.
    const tau = (target < this.rate) ? this._rampDownTau : this._rampUpTau;
    const alpha = (dtReal > 0 && tau > 0) ? (1 - Math.exp(-(dtReal * 1000) / tau)) : 1;
    this.rate += (target - this.rate) * alpha;
    // Snap when within epsilon so the rate can settle exactly on the cap (incl. 0).
    if (Math.abs(this.rate - target) < 1e-4) this.rate = target;

    this.scale = TimeAuthority.BASE_SCALE * this.rate;
    this.dtWorld = dtReal * this.scale;
    this._moidScreening = this.rate > TimeAuthority.MOID_SCREENING_ABOVE;
    return this;
  }
}
