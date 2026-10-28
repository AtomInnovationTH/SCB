/**
 * TimeAuthority.js — the Zoom Ladder's ONE world-time choke point.
 *
 * "1 real second = 10 game seconds" used to be smeared across every world-sim entity (`Constants.TIME_SCALE_GAMEPLAY` inlined,
 * incl. TrawlManager's hardcoded ×10), leaving no single place for the ladder's per-floor time caps or automatic warp
 * (archive/ladder/02-traps.md T2). This module is that place. It splits the frame's time into two rates:
 *
 *   - **dtReal**  — real (slow-mo-scaled) seconds: camera, UI, ceremonies, attitude substeps, resources, animations. Unwarped.
 *   - **dtWorld** — world-simulation seconds = `dtReal × scale`, where `scale = BASE_SCALE × rate` and `rate` (the ladder
 *     warp multiplier) drifts toward the current floor's `timeCap` (docs/ladder/01-numbers.md: [0,1,1,1,4,20,100]).
 *
 * `BASE_SCALE` mirrors the shipped `Constants.TIME_SCALE_GAMEPLAY` (=10). With the ladder disengaged (`active:false`, i.e.
 * `Constants.LADDER.ENABLED` off or not in gameplay) the authority pins `rate = 1` INSTANTLY (no ramp), so
 * `dtWorld === dtReal × BASE_SCALE` bit-for-bit.
 *
 * Who reads what:
 *   - world-sim orbital systems (DebrisField/PlayerSatellite/ActiveSatellite/AutopilotSystem/ConjunctionSystem MOID timer)
 *     receive the live `dtWorld` from the main-loop choke point (default `TimeAuthority.baseGameDt(dt)` for headless/test callers);
 *   - close-range / cosmetic sites that only ever run at warp 1× (arms, nets, lassos, comms, tumble spins, sun sweep) read
 *     the `BASE_SCALE` constant.
 *
 * Warp behaviors this authority owns (docs/ladder/00-spec.md §7, FloorContract.TIME_RULES):
 *   - **Automatic warp**: `rate` drifts toward the floor cap when calm.
 *   - **Danger cap**: a conjunction inside the alarm horizon ramps `rate` to 1× (fast) so alarms always land at 1×.
 *   - **Crossing pre-ramp**: during a ride the ZoomLadder core already reports the DESTINATION floor as current, so its
 *     `timeCap` pre-ramps toward the arrival rate during the flight (down-crossings fast; up-crossings ease in).
 *   - **MOID screening** above `MOID_SCREENING_ABOVE` (10×): the per-frame proximity scan is invalid when objects teleport
 *     per frame, so conjunction detection switches to orbit-geometry MOID screening.
 *   - **Drag chunking**: atmospheric drag (a first-order Euler step) integrates in ≤ `DRAG_CHUNK_GAME_S` (60) game-second
 *     chunks so the decay factor can never go negative at high warp. Kepler propagation is analytic and stable at any dt.
 *
 * Pure and deterministic: no THREE/DOM/EventBus, no `Date.now`/timers. The instance holds only the ramp state; every input
 * carries its own `dtReal`.
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
   * Byte-identical replacement for the old `dt * Constants.TIME_SCALE_GAMEPLAY`: the default `dtWorld` for headless/close-range
   * callers that never warp (the live warped value is threaded from the main-loop choke point instead).
   * @param {number} dtReal real seconds
   * @returns {number} game seconds at the base (unwarped) rate
   */
  static baseGameDt(dtReal) { return dtReal * Constants.TIME_SCALE_GAMEPLAY; }

  /**
   * Euler sub-steps (each ≤ DRAG_CHUNK_GAME_S) a drag integration should take: 1 (a single, byte-identical step) for any
   * `gameDt ≤ DRAG_CHUNK_GAME_S`; only high-warp frames subdivide.
   * @param {number} gameDt world-time step (game seconds)
   * @returns {number} integer ≥ 1
   */
  static dragSubSteps(gameDt) {
    const c = TR.DRAG_CHUNK_GAME_S;
    if (!(gameDt > c)) return 1;
    return Math.ceil(gameDt / c);
  }

  /**
   * Warp-feed rule (docs/ladder/08-workbench.md §8: "time changes only at the slow end of a flight"). The per-frame
   * `targetCap` is normally the CURRENT floor's timeCap (the core reports the destination during a ride: the pre-ramp).
   * While a cross-anchor ride goes UP, and until its post-ride level phase completes, the camera reports a HOLD floor (the
   * departure) whose cap wins, so the time-lapse engages only after arrival + leveling, never during the flight. Down-rides
   * pass no hold (the fast destination pre-ramp still settles time first). Pure.
   * @param {number} floorCap the core's current/destination floor timeCap
   * @param {number|null|undefined} holdCap the departure floor's timeCap while an up-crossing holds
   *   (CameraSystem.ladderWarpHoldFloor), else null
   * @returns {number} the cap to feed `update({ targetCap })`
   */
  static ladderTargetCap(floorCap, holdCap) {
    return (holdCap != null && Number.isFinite(holdCap)) ? holdCap : floorCap;
  }

  /**
   * The HELD-WORLD rule (supersedes the 1× of 00-spec §7's D10 calm cap; owner decision D-F, 2026-09-05). Applied to the warp
   * target AFTER ladderTargetCap: an open workbench drawer (REFIT / TECH LIBRARY) clamps the cap to **0**: the world clock
   * STOPS while you shop or read (the rail reads HOLD). The ramp to 0 is the shipped cap-0 mechanism (rate ramps down and
   * snaps to 0; the danger clamp is a min() and can never un-pause — test-TimeAuthority). Like the danger clamp it never
   * RAISES a cap. Pure; main.js feeds `_workbenchPaneOpen` (the ONE pane edge).
   * @param {number} floorCap the cap from ladderTargetCap (current/hold floor)
   * @param {boolean} paneOpen a workbench drawer (REFIT / TECH LIBRARY) is open
   * @returns {number} the cap to feed `update({ targetCap })`
   */
  static calmCap(floorCap, paneOpen) {
    return paneOpen ? 0 : floorCap;
  }

  /**
   * The ONE held-world input (owner 2026-10-22: "Stop the world while it's open"). The world is held while a workbench
   * drawer (REFIT / TECH LIBRARY) is open (D-F, DECISIONS §13 row 5) OR the full-screen codex / help page (SPECS, opened by
   * tapping a HUD pane) is showing during gameplay. Out of gameplay (menu, shop, game over) the codex holds nothing: those
   * screens have their own pause rules. Feeds `calmCap` and `tripWarpArgs` (`workbenchOpen`) in main.js's time loop, once
   * per frame. Pure.
   * @param {{paneOpen?:boolean, codexVisible?:boolean, gameplay?:boolean}} p
   * @returns {boolean} true = clamp the world clock to 0
   */
  static worldHoldOpen(p) {
    if (!p) return false;
    return !!p.paneOpen || (!!p.codexVisible && !!p.gameplay);
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
   * @param {number}  [p.dtReal=0]      real (slow-mo-scaled) seconds this frame
   * @param {boolean} [p.active=false]  warp allowed (ladder flag on + gameplay + engaged)
   * @param {number}  [p.targetCap=1]   auto-warp target = current/destination floor timeCap
   * @param {boolean} [p.dangerActive=false] conjunction inside alarm horizon → ramp to 1×
   */
  update({ dtReal = 0, active = false, targetCap = 1, dangerActive = false } = {}) {
    this.dtReal = dtReal;

    // Inactive: pin the base rate with NO ramp (dtWorld === dtReal × BASE_SCALE, bit-for-bit).
    if (!active) {
      this.rate = 1;
      this.scale = TimeAuthority.BASE_SCALE;
      this._moidScreening = false;
      this.dtWorld = dtReal * this.scale;
      return this;
    }

    // Target = floor cap, clamped to 1× under danger. The clamp is a min(), so it never RAISES the target: a cap-0 floor
    // stays paused.
    const cap = Math.max(0, targetCap);
    const target = dangerActive ? Math.min(1, cap) : cap;

    // Exponential approach: ramping DOWN uses the fast τ (danger and down-crossings arrive slow), UP the gentle τ
    // (auto-warp / up-crossings ease in with visible feedback).
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
