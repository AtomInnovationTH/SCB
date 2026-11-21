/**
 * TimeAuthority.js — the Zoom Ladder's ONE world-time choke point.
 *
 * "1 real second = 10 game seconds" used to be smeared across every world-sim entity (`Constants.TIME_SCALE_GAMEPLAY` inlined,
 * incl. TrawlManager's hardcoded ×10), leaving no single place for the ladder's per-floor time caps or automatic warp
 * (archive/ladder/02-traps.md T2). This module is that place. It splits the frame's time into two rates:
 *
 *   - **dtReal**  — real (slow-mo-scaled) seconds: camera, UI, ceremonies, attitude substeps, resources, animations. Unwarped.
 *   - **dtWorld** — world-simulation seconds = `dtReal × scale`, where `scale = BASE_SCALE × rate` and `rate` (the ladder
 *     warp multiplier) drifts toward the current floor's `timeCap` (docs/ladder/01-numbers.md: [0,1,1,1,4,20,100]; since
 *     2026-11-18 floors 4-5 open at real speed, 0.1, and the player's map clock slider (systems/MapClock.js) picks the
 *     target there: pause / 0.1 / 1 / 10 / 100).
 *
 * `BASE_SCALE` mirrors the shipped `Constants.TIME_SCALE_GAMEPLAY` (=10). With the ladder disengaged (`active:false`, i.e.
 * `Constants.LADDER.ENABLED` off or not in gameplay) the authority pins `rate = 1` INSTANTLY (no ramp), so
 * `dtWorld === dtReal × BASE_SCALE` bit-for-bit.
 *
 * Who reads what:
 *   - world-sim orbital systems (DebrisField/PlayerSatellite/ActiveSatellite/AutopilotSystem/ConjunctionSystem MOID timer)
 *     receive the live `dtWorld` from the main-loop choke point (default `TimeAuthority.baseGameDt(dt)` for headless/test callers);
 *   - a daughter's own motion steps on `armDt(dt)` (the world's seconds while the one clock is on), the reel on `reelDt(dt)`;
 *   - clocks that run on the fixed base rate (docked servicing, the net cutter, the mother's lasso) read `fixedClockScale()`
 *     (BASE_SCALE, slowed only while a daughter is near a piece); cosmetic draws read `worldClockScale()`.
 *
 * Warp behaviors this authority owns (docs/ladder/00-spec.md §7, FloorContract.TIME_RULES):
 *   - **One clock, real time only near the piece** (DECISIONS §70 rows 6 and 10, re-picked 2026-11-20; plan debris-1 D6): while any
 *     daughter is NEAR her piece (`ArmManager.anyNear`: from 400 m out until she holds a catch) the target is clamped to REAL speed
 *     (`daughterCap`, 1 game second per real second) on every floor; while one is out but none is near the world runs at the field's
 *     rate (10x floors 1-2, 40x floor 3, floors 4-5 min(slider step, 10x)); when all are home the floor's cap (or the player's slider
 *     step) returns through the ordinary ramp. Her own motion advances on the world's seconds (`armDt`, `worldRate`).
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

/**
 * True while main.js says the ladder is engaged and no trip burns: the daughters then run on the ONE clock (`armDt`: the world's seconds,
 * true units, `armScale` 1). Off (tests, headless, ladder off, a trip burning): her old game units on real seconds, byte-for-byte.
 */
let _armRealClock = false;

/**
 * The live world scale (game s per real s) of the last `update`, its field target (the rate a daughter that is out but not near
 * gets) and whether a daughter was near: read by `worldRate`, `fieldRate` and `fixedClockScale`. Shared by every instance, like
 * `_outDisplayScale` (the game has one authority).
 */
let _liveScale = Constants.TIME_SCALE_GAMEPLAY;
let _fieldScale = Constants.TIME_SCALE_GAMEPLAY;
let _nearNow = false;
/** Real seconds of the last `update` frame: `lastFarStepS` (the look-ahead of `armNearPiece`, Fix C1-1 F4). */
let _lastDtReal = 0;

/**
 * The live world scale (game s per real s) while a daughter is out, capped at BASE_SCALE, else null (the display clocks keep BASE_SCALE).
 * Written by `update` from the frame the clock was computed in; read by `worldClockScale`. Shared by every instance, like `_liveScale`
 * (the game has one authority).
 * @type {number|null}
 */
let _outDisplayScale = null;

export class TimeAuthority {
  /** Shipped base rate: 1 real second = BASE_SCALE game seconds (=10). */
  static get BASE_SCALE() { return Constants.TIME_SCALE_GAMEPLAY; }

  /**
   * The warp target while a daughter is near her piece (owner 2026-11-18 / 11-20, DECISIONS §70 row 10): REAL speed, 1 game second per
   * real second = `1 / BASE_SCALE` of the base rate (the same value as the map clock's "Real" step, `FloorContract` cap 0.1).
   */
  static get REAL_CAP() { return 1 / Constants.TIME_SCALE_GAMEPLAY; }

  /**
   * The field's usual rate while a daughter is out but none is near (D6): 10x (cap 1). Floors 1-3 keep their own cap (10x, 10x, 40x);
   * on floors 4-5 the slider's step is capped here (main.js passes it as `outCap` there).
   */
  static get FIELD_CAP() { return 1; }

  /**
   * The ONE clamp for daughters (DECISIONS §70 row 10; plan debris-1 D6): any daughter near her piece → never above real speed; out but
   * none near → never above `outCap` (the field rate on floors 4-5; Infinity elsewhere, so floors 1-3 keep 10x / 40x). Only min()s,
   * so a lower cap (pause, an open drawer) still wins and nothing is ever raised. Pure; `update` applies it.
   * @param {number} cap the warp target before the clamp
   * @param {boolean} near any daughter is near her piece (`ArmManager.anyNear`)
   * @param {boolean} [out=false] any daughter is out (`ArmManager.anyOut`)
   * @param {number} [outCap=Infinity] the far-leg cap while one is out but none near
   * @returns {number}
   */
  static daughterCap(cap, near, out = false, outCap = Infinity) {
    if (near) return Math.min(cap, TimeAuthority.REAL_CAP);
    return out ? Math.min(cap, outCap) : cap;
  }

  /**
   * Her unit factor: game units per true unit of her speeds. `BASE_SCALE` (=10) while the one clock is off (`setArmRealClock(false)`:
   * tests, headless, ladder off, a trip burning: her old game units on real seconds, unchanged), `1` while it is on (her speeds are
   * TRUE m/s and she steps on the world's seconds, `armDt`). Kept (not retired) so the arms' clock-off path stays byte-for-byte; it is
   * no longer a clock: the clock is `worldRate`.
   * @returns {number}
   */
  static armScale() { return _armRealClock ? 1 : TimeAuthority.BASE_SCALE; }

  /**
   * main.js, once per frame: the ladder is engaged and no transfer trip burns, so the daughters run on the one clock (`armDt`). Off
   * everywhere else (ladder off: the clock stays at BASE_SCALE and so do her game units; a trip keeps its own rates).
   * @param {boolean} on
   */
  static setArmRealClock(on) { _armRealClock = !!on; }

  /** @returns {boolean} true while the daughters run on the one clock (see `setArmRealClock`) */
  static armClockOn() { return _armRealClock; }

  /**
   * World seconds per real second this frame (the live scale of the last `update`: 1 near a piece, 10 / 40 on a far leg, the floor's
   * rate at home; the ramp included). `BASE_SCALE` while the one clock is off. Not `worldClockScale` (a display scale for drawn spins).
   * @returns {number}
   */
  static worldRate() { return _armRealClock ? _liveScale : TimeAuthority.BASE_SCALE; }

  /**
   * World seconds per real second a daughter that is out but not near gets (the field target of the last `update`, not the ramp):
   * what a reel home or a far leg will run at. For estimates said before the leg starts. `BASE_SCALE` while the one clock is off.
   * @returns {number}
   */
  static fieldRate() { return _armRealClock ? _fieldScale : TimeAuthority.BASE_SCALE; }

  /**
   * World seconds a far-leg frame as long as the last `update` frame covers (its dtReal x `fieldRate()`; 0 before the first).
   * `armNearPiece` looks half of it ahead along her closing speed, so real time starts within half a frame of 400 m (plan debris-1 Fix C1-1
   * F4). The field rate, not the live one: the look-ahead must not shrink once the world is at 1x, or she flickers out of near.
   * @returns {number}
   */
  static lastFarStepS() { return _lastDtReal * TimeAuthority.fieldRate(); }

  /**
   * Real seconds of the last `update` frame (0 before the first). Her launch cap counts the spring coast in whole frames of this length
   * (`ArmUnit._straightLaunchCap`, plan debris-1 Fix C1-2 G2: at 10 fps the coast is 3-4 frames, 0.3-0.4 s, not the 0.25 s of the timers).
   * @returns {number}
   */
  static lastDtReal() { return _lastDtReal; }

  /**
   * THE one place her step is computed: the seconds of her own motion this frame, in her units. One clock on: `dt × worldRate()`
   * (world seconds, true units). Off: `dt` (her old game units on real seconds, exactly as before).
   * @param {number} dt real (slow-mo-scaled) seconds
   * @returns {number}
   */
  static armDt(dt) { return _armRealClock ? dt * _liveScale : dt; }

  /**
   * World seconds of her frame, for her physics clock (thrust limits, the gravity gradient, the curve's elapsed time, the ion bill, the
   * reel's push on the mother): `armDt(dt) × armScale()`. Off: `dt × BASE_SCALE` (the old "game seconds" of her clock, unchanged); on:
   * `dt × worldRate()`. A thrust limit `aMax × armWorldS(dt)` in her velocity units is then `aMax` true m/s² under the one clock.
   * @param {number} dt real seconds
   * @returns {number}
   */
  static armWorldS(dt) { return TimeAuthority.armDt(dt) * TimeAuthority.armScale(); }

  /**
   * The reel's step: the reel keeps its game-scale speeds (true × BASE_SCALE, `REEL_PROFILE`), so its seconds are world seconds ÷
   * BASE_SCALE: `armDt(dt) × armScale() / BASE_SCALE`. Floors 1-2 (10x) = real seconds (screen times as before); floor 3 (40x) 4x;
   * near a piece (1x) 1/10. Off: `dt` exactly.
   * @param {number} dt real seconds
   * @returns {number}
   */
  static reelDt(dt) { return _armRealClock ? dt * _liveScale / TimeAuthority.BASE_SCALE : dt; }

  /**
   * Game seconds per real second for the clocks that run on the fixed BASE_SCALE (docked servicing: gas refill, the indium swap, the
   * furnace, the net cutter; the mother's lasso): `BASE_SCALE` at home and on a far leg on every floor (unchanged), slowed with the
   * world only while a daughter is near a piece (min(scale, BASE_SCALE), plan debris-1 D6: "only slow down"). Off: BASE_SCALE.
   * @returns {number}
   */
  static fixedClockScale() {
    return (_armRealClock && _nearNow) ? Math.min(TimeAuthority.BASE_SCALE, _liveScale) : TimeAuthority.BASE_SCALE;
  }

  /**
   * Game seconds per real second that pieces' DISPLAYED motion runs at (tumble draw, the mother's net-lead estimate, the despin hint's
   * screen time): `BASE_SCALE` (=10) as shipped and whenever she is home (the draw never followed the warp rate, so home is unchanged),
   * and the live world scale while a daughter is out, capped at BASE_SCALE (a far leg at 10x or 40x draws as at home; near a piece, 1:
   * spins show their true rate), the ramp included, never below 1 (real speed; a paused world does not divide by zero). Differs from
   * `worldRate()` (her clock, which follows 40x).
   * @returns {number}
   */
  static worldClockScale() {
    return _outDisplayScale === null ? TimeAuthority.BASE_SCALE : Math.max(TimeAuthority.BASE_SCALE * TimeAuthority.REAL_CAP, _outDisplayScale);
  }

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
    _outDisplayScale = null;
    _liveScale = _fieldScale = TimeAuthority.BASE_SCALE;
    _nearNow = false;
    _lastDtReal = 0;
    this.dtWorld = this.dtReal * this.scale;
    return this;
  }

  /**
   * Advance the warp rate one frame and compute this frame's dtWorld.
   * @param {number}  [p.dtReal=0]      real (slow-mo-scaled) seconds this frame
   * @param {boolean} [p.active=false]  warp allowed (ladder flag on + gameplay + engaged)
   * @param {number}  [p.targetCap=1]   auto-warp target = current/destination floor timeCap
   * @param {boolean} [p.dangerActive=false] conjunction inside alarm horizon → ramp to 1×
   * @param {boolean} [p.daughterOut=false]  any daughter is out (`ArmManager.anyOut`): the far-leg cap `outCap` applies
   * @param {boolean} [p.daughterNear=false] any daughter is near her piece (`ArmManager.anyNear`) → the target is clamped to REAL speed
   * @param {number}  [p.outCap=Infinity]    the far-leg cap while one is out but none near (`FIELD_CAP` on floors 4-5)
   */
  update({ dtReal = 0, active = false, targetCap = 1, dangerActive = false, daughterOut = false, daughterNear = false, outCap = Infinity } = {}) {
    this.dtReal = dtReal;

    // Inactive: pin the base rate with NO ramp (dtWorld === dtReal × BASE_SCALE, bit-for-bit).
    if (!active) {
      this.rate = 1;
      this.scale = TimeAuthority.BASE_SCALE;
      this._moidScreening = false;
      _outDisplayScale = null;
      _liveScale = _fieldScale = TimeAuthority.BASE_SCALE;
      _nearNow = false;
      this.dtWorld = dtReal * this.scale;
      _lastDtReal = dtReal;
      return this;
    }

    // Target = floor cap, clamped to 1× under danger. The clamp is a min(), so it never RAISES the target: a cap-0 floor
    // stays paused.
    const cap = Math.max(0, targetCap);
    let target = dangerActive ? Math.min(1, cap) : cap;
    // The daughters' clamp (DECISIONS §70 row 10, D6): real speed while any is near her piece; the field rate while one is out but
    // none near; the floor's cap (or the player's slider step) comes back through the ordinary ramp when all are home. Only min()s:
    // pause and a held world stay at 0.
    const fieldTarget = TimeAuthority.daughterCap(target, false, true, outCap);
    target = TimeAuthority.daughterCap(target, daughterNear, daughterOut, outCap);

    // Exponential approach: ramping DOWN uses the fast τ (danger and down-crossings arrive slow), UP the gentle τ
    // (auto-warp / up-crossings ease in with visible feedback). A daughter near her piece drops to real speed at once, no ease (plan
    // debris-1 Fix C1-1 F4: the 120 ms ease left floor 3 at 40x-ish until 331-335 m).
    const tau = (target < this.rate) ? this._rampDownTau : this._rampUpTau;
    const alpha = (daughterNear && target < this.rate) ? 1 : (dtReal > 0 && tau > 0) ? (1 - Math.exp(-(dtReal * 1000) / tau)) : 1;
    this.rate += (target - this.rate) * alpha;
    // Snap when within epsilon so the rate can settle exactly on the cap (incl. 0).
    if (Math.abs(this.rate - target) < 1e-4) this.rate = target;

    this.scale = TimeAuthority.BASE_SCALE * this.rate;
    this.dtWorld = dtReal * this.scale;
    _lastDtReal = dtReal;
    _outDisplayScale = daughterOut ? Math.min(TimeAuthority.BASE_SCALE, this.scale) : null;   // see `worldClockScale`
    _liveScale = this.scale;
    _fieldScale = TimeAuthority.BASE_SCALE * fieldTarget;
    _nearNow = !!daughterNear;
    this._moidScreening = this.rate > TimeAuthority.MOID_SCREENING_ABOVE;
    return this;
  }
}
