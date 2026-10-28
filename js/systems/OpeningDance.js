/**
 * @module systems/OpeningDance — the boot cinematic: the ship unpacks itself. It STARTS IN THE MENU as the EVA
 * astronaut jets off the hull, the menu hero's solar wings roll out at the SHIPPED hardware rate, and the player gets
 * the wheel 4.0 s after the menu cuts away. No rocket, no fairing, no persistence writes, no arm launch lock.
 *
 * DECISIONS §15 row 4 (owner 2026-10-08): the ship STARTS CLOSED — radiator folded flat at its 0° launch latch
 * (= POSE_CLOSED_DEG; owner 2026-10-16: no slightly-open step after the clamp release), daughter struts shut at α 0.
 * The player's ship keeps its wings rolled up through the dance and on every start path (DECISIONS "Start state";
 * owner 2026-10-12: "Mother starts with wings and daughters retracted, battery is 50% and dropping until wings
 * open"); the player opens them (`,` or WINGS on floor 1). The wing beats
 * still play on the menu hero (MenuScene3D reads progress()); getRosaProgress() reports 0.
 *
 * DECISIONS "Opening at the start" (owner 2026-10-20): the start state holds only until the player's FIRST ACTION,
 * then StartOpening (systems/StartOpening.js) opens the ship. This module only arms it: `setOnStartApplied(fn)` is
 * called at the hand-over and at the end of `endState` (every other start path).
 *
 * Feature flag FEATURE_FLAGS.OPENING_DANCE (default true). Flag off is a TOTAL no-op (start/tick/skip/applyPacked) —
 * every path then lands on endState(ship), which is also the CONTINUE / GAMEOVER-retry / reduced-motion / ?shot path.
 * Invariant: a ship is NEVER seen with the radiator's launch lock armed outside a running dance. endState itself is
 * deliberately NOT flag-gated: with the flag off the ship still boots to the finished pose.
 *
 * THE CLOCK IS WALL-CLOCK, NOT ACCUMULATED dt. The dance is read from TWO independent render loops: MenuScene3D runs
 * its own requestAnimationFrame (own THREE.Clock, frame-gated to 60/30 fps) while js/main.js runs the game loop.
 * Accumulating dt would let the views disagree and the menu→game cut would pop. So the dance stores a START
 * TIMESTAMP and derives progress from performance.now(); both loops call progress() and get the same answer.
 * tick(dt) exists ONLY to emit the beat edges once each — it must never integrate the pose. (Exception: during the
 * skip fade the ship's own drivers cannot keep up, so tick APPLIES the pose — still a pure function of the clock.)
 *
 * THE DRIVER DUCK-TYPE. PlayerSatellite consumes only isActive() and getRosaProgress() from its injected launch
 * driver (setLaunchSequence handshake), plus the isActive() gate on setFlowerPose('LAUNCH'). The dance is bound with
 * ship.setLaunchSequence(dance) and UNBOUND (setLaunchSequence(null)) at hand-over, which returns the player's own
 * furl control. `isOpeningDance` is the duck-typed tag PlayerSatellite's message-silence gates read (never an
 * instanceof — no import either way).
 *
 * BEATS (t = 0 at jet-off; anchors in Constants.OPENING_DANCE):
 *   t = 0.00  latches pop; the radiator rests at CLOSED 0° (no ease) — the SHIP's own 15°/s driver
 *             (setFlowerPose(REST_POSE) latches the target and releases the launch lock; the hero is driven from
 *             progress() by MenuScene3D, the sim ship slews itself once bound)
 *   t = 2.70  cut to game (MENU_START): the sim ship is bound and snapped to the live progress (no pop)
 *   t = 5.20  hero wing 1 rolls out as the camera's dive lands (2.5 s); t = 6.20 hero wing 2. The player's ship does
 *             NOT roll them out and the dance plays no sound for them; the beats are bookkeeping.
 *   t = 8.70  time-based hand-over (hero wing 2 seated) → OPENING_DANCE_HANDOVER and, in the same tick,
 *             OPENING_DANCE_COMPLETE; the player is flying, radiator folded, struts shut
 * skip(): any input fast-forwards the remaining unfold over SKIP_FADE_S (0.5 s) to the exact hand-over state.
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { audioSystem } from './AudioSystem.js';
import { GestureHints } from '../ui/hud/GestureHints.js';
import { devShotGate } from '../core/DevShotGate.js';
import { wingsHint } from './WingsHint.js';
import { fieldArrivedLine, freeArrivedLine, SATELLITE_ARRIVED_LINE } from './TransferTrip.js';
import { degToRad, radToDeg, lerp } from '../core/MathUtil.js';

/** Beat-table anchors (Constants.OPENING_DANCE). */
const OD = Constants.OPENING_DANCE;
const FL = Constants.THERMAL.FLOWER;

/** What getRosaProgress() reports to the bound ship — rolled up. */
const SHIP_WINGS_ROLLED_UP = Object.freeze({ wing1: 0, wing2: 0 });

/** The two start lines (owner 2026-10-28), both HOUSTON, posted at every start (the hand-over and the non-dance
 *  starts). The first is true only at the start field; elsewhere `_arrivedLine` says the field she is at. The wings
 *  open on the player's first action (StartOpening, "Solar panels open. Power coming in.", DECISIONS "Opening at the start"). */
export const START_ARRIVED_FIRST_LINE = 'Arrived at first debris field.';
export const START_SYSTEMS_LINE = 'Systems... nominal.';

/** Zero progress — what every consumer sees before t = 0 and after unbind. Frozen: the idle object is shared. */
const ZERO_PROGRESS = Object.freeze({
  /** seconds since jet-off (t = 0), clamped at 0 before it */
  t: 0,
  /** radiator θ as a fraction of the 0° → 146° sweep (θ = flower × 146°; MenuScene3D's hero and the sim-ship sync
   *  both use it). Ends at FLOWER_REST_FRAC (0): DECISIONS §15 row 4 starts the ship closed. */
  flower: 0,
  /** ROSA wing roll-out 0..1 */
  wing1: 0,
  wing2: 0,
  /** daughter strut sweep per arm index — always 0 (DECISIONS §15 row 4); kept so the snapshot shape is stable */
  struts: Object.freeze([0, 0, 0, 0]),
  /** true once the radiator and both wings are seated (the camera hand-over) */
  handedOver: false,
  /** true once the dance is over — the same tick as the hand-over now */
  complete: false,
});

/** The rest θ the dance lands on: REST_POSE (CLOSED, DECISIONS §15 row 4) through the ONE mapping,
 *  Constants.THERMAL.FLOWER.REST_DEG (the same the ship's _flowerRestDeg reads). */
const REST_DEG = FL.REST_DEG;
const REST_RAD = degToRad(REST_DEG);
/** The radiator's dance travel, LAUNCH 0° → REST at the shipped 15°/s — zero for CLOSED 0°. */
const FLOWER_TRAVEL_S = (REST_DEG - FL.POSE_LAUNCH_DEG) / (radToDeg(FL.SLEW_RATE_RAD_S));
/** progress().flower once the radiator is at rest: θ_rest / 146°. */
const FLOWER_REST_FRAC = REST_DEG / FL.POSE_STOW_DEG;
/** One ROSA wing at the gameplay furl rate (the `,` key's rate) — 2.5 s. */
const WING_ROLL_S = 1 / Constants.OCTOPUS_V5.ROSA_FURL_RATE;
/** @private 0..1 clamp for every derived progress scalar. */
const _clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** The daughter struts' snapshot — always shut (DECISIONS §15 row 4). */
const STRUTS_SHUT = Object.freeze([0, 0, 0, 0]);

/** The hand-over beat: the last scripted motion ends — wing 2 seated, 8.70 s. */
const T_HANDOVER_S = Math.max(FLOWER_TRAVEL_S, OD.WING2_START_S + WING_ROLL_S);
/**
 * How long skip() stays deaf after a menu skip advanced the clock: one pointerdown reaches MenuScreen's capture-phase
 * handler and InputManager's bubble-phase one, and the second must not count as a fast-forward request. Only has to
 * outlive one event's propagation, so it is tiny — a real second press cannot land inside it.
 */
const SKIP_DEAF_MS = 120;

class OpeningDance {
  constructor() {
    /** Duck-typed tag: PlayerSatellite's message-silence gates read this (no instanceof, no import). */
    this.isOpeningDance = true;
    /** @private wall-clock ms at t = 0 (jet-off), or null when not armed */
    this._t0Ms = null;
    /** @private the ship currently driven — hero first, then the sim ship */
    this._ship = null;
    /** @private true from start() until OPENING_DANCE_COMPLETE */
    this._running = false;
    /** @private set by skip(); the remaining unfold fast-forwards over SKIP_FADE_S */
    this._skipStartMs = null;
    /** @private dance time at the skip instant (t, may be pre-cut) */
    this._skipFromT = 0;
    /** @private skip() ignores input until this wall-clock ms (see SKIP_DEAF_MS) */
    this._skipDeafUntilMs = null;
    this._startPending = null;    // endState({deferStartLine}) waits here for postStartLine (CONTINUE: after the load)
    this._fieldProvider = null;   // setFieldProvider: where she is, for the "Arrived" line
    /** @private beat-edge latch — each edge fires exactly once per arming */
    this._fired = null;
    /** @private StartOpening's arm(): called once the start state is applied (see setOnStartApplied) */
    this._onStartApplied = null;
  }

  /**
   * StartOpening hook (DECISIONS "Opening at the start"). `fn` runs every time the START STATE has just been applied —
   * the hand-over (`_fireHandover`) and `endState` (CONTINUE, retry, game over → shop exit, reduced motion, flag
   * off) — and arms the opening. No bus event: a direct call, owned by main.js's wiring.
   * @param {(() => void)|null} fn
   */
  setOnStartApplied(fn) {
    this._onStartApplied = (typeof fn === 'function') ? fn : null;
  }

  /** @private a throwing hook never breaks a start */
  _notifyStartApplied() {
    if (!this._onStartApplied) return;
    try { this._onStartApplied(); } catch (e) { console.error('[OpeningDance] onStartApplied:', e); }
  }

  /** @returns {boolean} the flag, read live so a test can flip it */
  get enabled() {
    return !!Constants.FEATURE_FLAGS.OPENING_DANCE;
  }

  /** @private the wall clock (seam for tests) */
  _now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  /**
   * @private Dance time in seconds since jet-off. NEGATIVE before t = 0 (progress clamps; skip() refuses pre-cut).
   * During the SKIP_FADE_S window t accelerates linearly toward T_HANDOVER_S, then resumes at 1×.
   */
  _t() {
    if (this._t0Ms === null) return 0;
    const now = this._now();
    if (this._skipStartMs !== null) {
      const fadeMs = OD.SKIP_FADE_S * 1000;
      const elapsed = now - this._skipStartMs;
      if (elapsed >= fadeMs) {
        return T_HANDOVER_S + (elapsed - fadeMs) / 1000;
      }
      const u = elapsed / fadeMs;
      return lerp(this._skipFromT, T_HANDOVER_S, u);
    }
    return (now - this._t0Ms) / 1000;
  }

  /**
   * Arm the dance and set t = 0. Called from MENU_DEPARTURE_START; t = 0 is jet-off (start + BEAT_JETOFF ×
   * durationMs), NOT the departure start — there is deliberately no new jet-off event. Re-arming resets every latch.
   * @param {{ t0Ms?: number }} [opts] — the jet-off timestamp; defaults to the menu figure
   */
  start(opts) {
    if (!this.enabled) return;
    // comms holds the start's lines until the hand-over (a disabled dance never holds).
    eventBus.emit(Events.COMMS_HOLD, {});
    const t0Ms = (opts && Number.isFinite(opts.t0Ms))
      ? opts.t0Ms
      : this._now() + OD.BEAT_JETOFF * OD.MENU_DEPARTURE_MS;
    this._t0Ms = t0Ms;
    this._running = true;
    this._skipStartMs = null;
    this._skipFromT = 0;
    this._skipDeafUntilMs = null;
    this._fired = { latch: false, wing1: false, wing2: false, handover: false, complete: false };
  }

  /**
   * Menu skip (MenuScreen's fast-forward / skipDeparture): the game side must always start from the SAME state, so
   * the clock is advanced to its cut-time value. A menu skip skips the menu, not the dance. No-op once t is at or
   * past the cut.
   *
   * It also opens a short suppression window: ONE GESTURE MUST NOT COUNT TWICE. MenuScreen arms its skip on window
   * CAPTURE and InputManager's dance hook is on BUBBLE, so the capture handler runs first and lands the clock at
   * exactly T_CUT_S — where skip()'s `t < T_CUT_S` refusal is false by one float, and the same click would open
   * the fast-forward fade.
   */
  advanceClockToCutTime() {
    if (!this.enabled || this._t0Ms === null || this._skipStartMs !== null) return;
    const t = (this._now() - this._t0Ms) / 1000;
    if (t < OD.T_CUT_S) this._t0Ms -= (OD.T_CUT_S - t) * 1000;
    this._skipDeafUntilMs = this._now() + SKIP_DEAF_MS;
  }

  /**
   * @private Stop the dance dead without emitting anything. Unbinds the driven ship (which returns furl control)
   * and drops every beat latch. Idempotent; safe when never armed.
   */
  _abort() {
    if (this._ship && typeof this._ship.setLaunchSequence === 'function') {
      this._ship.setLaunchSequence(null);
    }
    this._ship = null;
    this._running = false;
    this._t0Ms = null;
    this._skipStartMs = null;
    this._skipFromT = 0;
    this._skipDeafUntilMs = null;
    this._fired = null;
    this._startPending = null;
  }

  /**
   * Bind the ship this dance drives. Called TWICE — the menu hero, then the sim ship — and with null at hand-over to
   * return furl control to the player. While running, binding ALSO snaps the ship to the live progress in the same
   * call (the MENU_START contract: no frame draws a deployed ship after the cut, no packed ship survives it).
   * @param {object|null} ship - a PlayerSatellite, or null to unbind
   */
  bindShip(ship) {
    if (!this.enabled) return;
    if (this._ship && this._ship !== ship && typeof this._ship.setLaunchSequence === 'function') {
      this._ship.setLaunchSequence(null);
    }
    this._ship = ship || null;
    if (!this._ship) return;
    if (typeof this._ship.setLaunchSequence === 'function') this._ship.setLaunchSequence(this);
    if (this._running && this._t0Ms !== null) this._syncShipPose(this._ship);
  }

  /**
   * @private Snap `ship` to the CURRENT dance pose (the bind-time contract). The flower lock is re-armed (a resetGame
   * between reveal and MENU_START cleared it), θ jumps to the wall-clock value, and the REST target is latched so the
   * ship's OWN 15°/s driver finishes the ease and releases the lock at the CLOSED floor.
   * @param {object} ship
   */
  _syncShipPose(ship) {
    const p = this.progress();
    if (ship._flowerGroups && ship._flowerGroups.length) {
      ship._flowerLaunchLock = true;
      ship._flowerOverrideFold = false;
      ship._flowerTargetTheta = REST_RAD;
      ship._flowerThetaRad = p.flower * (FL.POSE_STOW_DEG * Math.PI) / 180;
      if (typeof ship._updateFlower === 'function') ship._updateFlower(0);
    }
    // Wings stay rolled up: the start furl is held like a player hold (manual control, target 0) so the auto
    // roll-out in _updateRosaPanels never undoes it. The menu hero keeps the dance's wing values.
    if (typeof ship._setRosaWingProgress === 'function') {
      ship._setRosaWingProgress(1, 0);
      ship._setRosaWingProgress(2, 0);
    }
    if (ship._rosaFurlProgress !== undefined) {
      ship._rosaFurlProgress = 0;
      ship._rosaFurlTarget = 0;
      ship._rosaManualControl = true;
    }
    // Shut daughters: drop any stale slew target a previous run left behind (ArmUnit.reset does not clear it) so
    // nothing creeps open: the struts stay at α 0 for the whole dance (DECISIONS §15 row 4).
    const arms = (ship.armManager && ship.armManager.arms) || [];
    for (const arm of arms) {
      if (arm && arm._strutTargetAlpha !== undefined) arm._strutTargetAlpha = undefined;
    }
  }

  /**
   * @private Apply the pose directly from the wall clock — ONLY during the skip fade, where the ship's own 15°/s
   * drivers cannot keep up. Pure function of the clock; nothing is integrated.
   * @param {object} ship
   * @param {object} p - this.progress()
   */
  _applyShipPose(ship, p) {
    if (ship._flowerGroups && ship._flowerGroups.length) {
      ship._flowerThetaRad = p.flower * (FL.POSE_STOW_DEG * Math.PI) / 180;
      if (typeof ship._updateFlower === 'function') ship._updateFlower(0);
    }
    // Wings are not part of the ship's pose: they stay rolled up (the hero keeps p.wing1/p.wing2).
  }

  /**
   * Emit the beat edges once each. MUST NOT integrate the pose — progress() derives from the wall clock so both
   * render loops agree.
   * @param {number} _dt - seconds (unused: the clock is wall-clock)
   */
  tick(_dt) {
    if (!this.enabled || !this._running || this._fired === null) return;
    const t = Math.max(0, this._t());

    // Skip fade: apply the pose straight from the clock (pure; never integrated).
    if (this._skipStartMs !== null && this._ship) this._applyShipPose(this._ship, this.progress());

    if (!this._fired.latch) {
      this._fired.latch = true;
      // The latch clunk (sound only): playArmDeploy with a short dur — the vocabulary count pins forbid a new entry.
      try { audioSystem.playArmDeploy(0.2); } catch (_e) { /* headless */ }
      // The ship's own 15°/s driver latches the REST target (release out of the launch fold to CLOSED). The hero is
      // driven from progress() by MenuScene3D instead; this latch is for a bound, self-updating ship.
      if (this._ship && typeof this._ship.setFlowerPose === 'function') {
        this._ship.setFlowerPose(FL.REST_POSE || 'STOW');
      }
    }

    if (!this._fired.wing1 && t >= OD.WING1_START_S) {
      this._fired.wing1 = true;   // beat bookkeeping only: no sound (w4-power: the ship's wings stay rolled up)
    }
    if (!this._fired.wing2 && t >= OD.WING2_START_S) {
      this._fired.wing2 = true;   // beat bookkeeping only: no sound (w4-power: the ship's wings stay rolled up)
    }

    // No daughter beat (DECISIONS §15 row 4): the struts stay shut, so the hand-over is also the end.
    if (!this._fired.handover && t >= T_HANDOVER_S) {
      this._fired.handover = true;
      this._fireHandover();
      this._fireComplete();
    }
  }

  /**
   * @private The hand-over: exact end pose for the radiator (CLOSED, lock off) and wings, the driver unbound, the
   * camera event, then the ONE Houston line (the onboarding boot beat posts first).
   */
  _fireHandover() {
    const ship = this._ship;
    // The line is true to the wings: only a player who already pressed `,` during the dance has them opening.
    let wingsOpening = false;
    if (ship) {
      // The exact hand-over state (skip or natural: idempotent).
      if (ship._flowerGroups && ship._flowerGroups.length) {
        ship._flowerLaunchLock = false;
        ship._flowerOverrideFold = false;
        ship._flowerThetaRad = REST_RAD;
        if (typeof ship._updateFlower === 'function') ship._updateFlower(0);
      }
      // Wings stay rolled up (target 0, held like a player hold) unless the player asked for them during the dance:
      // the roll-out then starts the frame the driver unbinds.
      wingsOpening = ship._rosaManualControl === true && ship._rosaFurlTarget >= 0.5;
      if (!wingsOpening) {
        if (typeof ship._setRosaWingProgress === 'function') {
          ship._setRosaWingProgress(1, 0);
          ship._setRosaWingProgress(2, 0);
        }
        if (ship._rosaFurlProgress !== undefined) {
          ship._rosaFurlProgress = 0;
          ship._rosaFurlTarget = 0;
          ship._rosaManualControl = true;
        }
      }
      if (typeof ship.setLaunchSequence === 'function') ship.setLaunchSequence(null);
      this._ship = null;
    }
    this._skipStartMs = null;   // the fade is over (if any)
    // ORDER: comms opens FIRST (held boot lines enter the log in order), then the hand-over listeners and the
    // start lines go out in order. Never rely on listener order.
    eventBus.emit(Events.COMMS_RELEASE, {});
    eventBus.emit(Events.OPENING_DANCE_HANDOVER, { t: T_HANDOVER_S });
    // The two start lines (a new game), normal priority; also when the wings are already asked for.
    this._postStartLine(wingsOpening, true);
    // Arm the opening (a player who already asked for a part during the dance has acted: StartOpening opens the
    // rest when the ride ends).
    this._notifyStartApplied();
  }

  /**
   * Late wiring (main.js): where she is. `() => ({ start, altKm, free, berthed }) | null` (null: the field map is off or
   * not built, the field is unknown). Read at the moment the start lines are posted.
   */
  setFieldProvider(fn) { this._fieldProvider = typeof fn === 'function' ? fn : null; }

  /**
   * @private The "Arrived ..." line, true to where she is. The start field (or a new game whose field is unknown) says
   * "Arrived at first debris field."; any other place she is says its own words (TransferTrip); an unknown field on a
   * start that is not a new game says nothing.
   * @returns {string|null}
   */
  _arrivedLine(newGame, atStart = false) {
    // A retry always restarts at the start field: said without asking the registry, so it never depends on whether the
    // registry's own GAMEOVER_CONTINUE listener has run yet.
    if (atStart) return START_ARRIVED_FIRST_LINE;
    let f = null;
    try { f = this._fieldProvider ? this._fieldProvider() : null; } catch (_e) { f = null; }
    if (!f) return newGame ? START_ARRIVED_FIRST_LINE : null;
    if (f.berthed) return SATELLITE_ARRIVED_LINE;
    if (f.free) return freeArrivedLine(f.altKm);
    if (f.start) return START_ARRIVED_FIRST_LINE;
    return fieldArrivedLine(f.altKm);
  }

  /**
   * The start that `endState(ship, { deferStartLine: true })` held back: the two lines, the silent wings-hint arm and the
   * StartOpening arm go out now (CONTINUE: the saved field is known only after the load). Exactly once: a second call,
   * or a call with nothing pending (a failed load, a return to the menu, a later start), does nothing.
   * @returns {boolean} the start went out
   */
  postStartLine() {
    const p = this._startPending;
    if (!p) return false;
    this._startPending = null;
    // `armed`: the wings hint and the opening were armed at the start already (a new game without the dance); only the lines wait
    if (!devShotGate.requested) this._postStartLine(p.armed === true, p.newGame === true, p.atStart === true);
    if (!p.armed) this._notifyStartApplied();
    return true;
  }

  /** A deferred start that must not happen any more (the run went back to the menu, the load failed). */
  cancelPendingStart() { this._startPending = null; }

  /** @returns {boolean} a deferred start is waiting for `postStartLine` */
  hasPendingStart() { return this._startPending !== null; }

  /**
   * @private The start lines, shared by the dance hand-over and the non-dance starts (endState): "Arrived ..." and
   * "Systems... nominal." as two HOUSTON messages. They come for every start, also when the player already asked for the
   * wings (the opening line follows them then).
   * @param {boolean} wingsOpening - the player already asked for the wings: the opening fires itself at the end of
   *   the ride, so the wings hint is not armed
   * @param {boolean} [newGame=true] - a new game (decides the "Arrived" words when the field is unknown)
   */
  _postStartLine(wingsOpening, newGame = true, atStart = false) {
    const arrived = this._arrivedLine(newGame, atStart);
    for (const line of [arrived, START_SYSTEMS_LINE]) {
      if (!line) continue;
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'HOUSTON',
        text: GestureHints.speak(line),
        priority: 'info',
        // The hand-over starts the Director first (OPENING_DANCE_HANDOVER -> ONBOARDING_STARTED), which drops comms
        // to tier 0; an untagged line was muted there (test-WingsHint A1). _onboarding is the tier-0 pass.
        _onboarding: true,
        // never folded away by CommsSystem's burst rule: a fast first action must not drop "Arrived" / "Systems"
        _keep: true,
      });
    }
    if (wingsOpening) return;
    // m1-finish: the comms line scrolls away, the battery keeps falling — keep ONE
    // ticker row up until the wings are out (WingsHint; removed by the game loop's
    // update once the ship's wing value passes WINGS_OUT_PROGRESS). The START arms
    // the hint WITHOUT a row (owner 2026-10-28): any first action opens the ship.
    wingsHint.post({ start: true });
  }

  /** @private fires in the hand-over tick */
  _fireComplete() {
    if (this._fired && this._fired.complete) return;
    if (this._fired) this._fired.complete = true;
    this._running = false;
    eventBus.emit(Events.OPENING_DANCE_COMPLETE, {});
  }

  /**
   * Any input during the dance fast-forwards the remaining unfold over SKIP_FADE_S, then hands over. Refused before
   * the cut (t < T_CUT_S): in the menu, input belongs to MenuScreen's own departure skip (the clock is advanced to
   * cut-time at MENU_START instead).
   */
  skip() {
    if (!this.enabled || !this._running || this._fired === null) return;
    if (this._fired.handover || this._skipStartMs !== null) return;
    // The menu-skip gesture's own echo (bubble phase of the pointerdown MenuScreen's capture handler just used).
    if (this._skipDeafUntilMs !== null && this._now() < this._skipDeafUntilMs) return;
    const t = this._t();
    if (t < OD.T_CUT_S) return;
    this._skipFromT = Math.max(0, t);
    this._skipStartMs = this._now();
  }

  /** @returns {boolean} the launch-driver duck-type's activity gate */
  isActive() {
    return !!(this._running && this._t0Ms !== null && this._fired !== null && !this._fired.handover);
  }

  /**
   * The whole dance state at the current wall-clock instant. Both render loops call this; neither advances it.
   * @returns {typeof ZERO_PROGRESS}
   */
  progress() {
    if (this._t0Ms === null) return ZERO_PROGRESS;
    const raw = this._t();
    const t = Math.max(0, raw);
    const handedOver = !!(this._fired && this._fired.handover);
    const complete = !!(this._fired && this._fired.complete);
    return {
      t,
      flower: FLOWER_REST_FRAC * (FLOWER_TRAVEL_S > 0 ? _clamp01(t / FLOWER_TRAVEL_S) : 1),
      wing1: this._wing(OD.WING1_START_S, t),
      wing2: this._wing(OD.WING2_START_S, t),
      struts: STRUTS_SHUT,
      handedOver,
      complete,
    };
  }

  /**
   * The launch-driver duck-type PlayerSatellite reads for the ROSA roll-out: reports the wings rolled up for the
   * whole run. The dance's own wing beats live in progress(), which drives the menu hero.
   * @returns {{ wing1: number, wing2: number }}
   */
  getRosaProgress() {
    return SHIP_WINGS_ROLLED_UP;
  }

  _wing(startS, t) {
    return _clamp01((t - startS) / WING_ROLL_S);
  }

  /**
   * Land `ship` on the finished pose WITHOUT playing anything: radiator CLOSED (REST_POSE, lock off), wings rolled
   * up, daughter struts shut at α 0, dance unbound. EVERY path that does not run the dance calls this — CONTINUE,
   * GAMEOVER retry, reduced motion, flag off, the ?shot harness. NOT flag-gated.
   * @param {object} ship - a PlayerSatellite
   */
  endState(ship, opts = {}) {
    // endState MEANS "the dance is over". A dance left running would fire its hand-over later on a path that never
    // wanted one (e.g. a GAMEOVER retry landing mid-unfold). Unconditional and idempotent; callers that mean to KEEP
    // the dance must not call this (GameFlowManager.resetGame's `keepOpeningDance`).
    this._abort();
    // A start without the dance opens comms before its own line.
    eventBus.emit(Events.COMMS_RELEASE, {});
    if (!ship) return;
    if (typeof ship.setLaunchSequence === 'function') ship.setLaunchSequence(null);
    // Radiator: the REST pose (CLOSED) via the ship's own snap (THERMAL_FLOWER_RELEASED is silence-gated only while
    // a dance is live, and none is on these paths).
    if (typeof ship.snapFlowerToStow === 'function') ship.snapFlowerToStow();
    else if (ship._flowerGroups && ship._flowerGroups.length) {
      ship._flowerLaunchLock = false;
      ship._flowerOverrideFold = false;
      ship._flowerTargetTheta = undefined;
      ship._flowerThetaRad = REST_RAD;
      if (typeof ship._updateFlower === 'function') ship._updateFlower(0);
    }
    if (typeof ship._setRosaWingProgress === 'function') {
      ship._setRosaWingProgress(1, 0);
      ship._setRosaWingProgress(2, 0);
    }
    // Every start path leaves both wings rolled up, the start furl held like a player hold.
    if (ship._rosaFurlProgress !== undefined) {
      ship._rosaFurlProgress = 0;
      ship._rosaFurlTarget = 0;
      ship._rosaManualControl = true;
    }
    // A start that skipped the dance begins at half battery, draining, wings rolled up — say so once, the same
    // lines the hand-over posts. Not in ?shot runs. A bare test-harness endState(stub) posts too (no marker on ship).
    // `deferStartLine`: the caller posts them itself later (postStartLine) once the saved field is known.
    // (the pending start also holds back the StartOpening arm, see postStartLine).
    // `armNow` (with deferStartLine): only the LINES wait; the wings hint and the opening arm at once, and StartOpening
    // flushes the lines before its own line (a first action before they are due keeps the order).
    if (opts.deferStartLine) {
      const armed = opts.armNow === true;
      this._startPending = { newGame: opts.newGame === true, atStart: opts.atStart === true, armed };
      if (armed && !devShotGate.requested) wingsHint.post({ start: true });
    } else if (!devShotGate.requested && !(ship._rosaFurlTarget >= 0.5)) {
      this._postStartLine(false, opts.newGame === true, opts.atStart === true);
    }
    // Daughters: shut at α 0 (DECISIONS §15 row 4; §4 the daughter docks at the full closed strut position).
    // Production callers just ran armManager.reset(); this drops any stale slew latch (ArmUnit.reset does not clear
    // it) and snaps a docked strut still open back to 0. A stub without setAimAlpha gets a latch to 0.
    const arms = (ship.armManager && ship.armManager.arms) || [];
    for (const arm of arms) {
      if (!arm) continue;
      if (arm.state !== undefined && arm.state !== Constants.ARM_STATES.DOCKED) continue;
      arm._strutTargetAlpha = undefined;
      const aim = typeof arm.getAimAlpha === 'function' ? arm.getAimAlpha() : 0;
      if (!(Math.abs(aim) > 1e-9)) continue;
      if (typeof arm.setAimAlpha === 'function') arm.setAimAlpha(0, 0);
      else arm._strutTargetAlpha = 0;
    }
    // Every start path ends here, so the opening is armed here (a deferred start arms in postStartLine).
    if (!opts.deferStartLine || opts.armNow === true) this._notifyStartApplied();
  }

  /**
   * Snap `ship` to the PACKED pose — wings furled, radiator folded (θ 0, launch lock armed). Idempotent. Used at hero
   * build (before any departure arms the clock, so the flower's own isActive() gate cannot be used and the
   * launch-lock fields are written directly) and at MENU_DEPARTURE_REVEAL on the sim ship (belt and braces).
   * @param {object} ship - a PlayerSatellite
   */
  applyPacked(ship) {
    if (!this.enabled || !ship) return;
    if (typeof ship.setLaunchSequence === 'function') ship.setLaunchSequence(this);
    if (ship._flowerGroups && ship._flowerGroups.length) {
      ship._flowerLaunchLock = true;
      ship._flowerOverrideFold = false;
      ship._flowerTargetTheta = undefined;
      ship._flowerThetaRad = degToRad(FL.POSE_LAUNCH_DEG);
      if (typeof ship._updateFlower === 'function') ship._updateFlower(0);
    }
    if (typeof ship._setRosaWingProgress === 'function') {
      ship._setRosaWingProgress(1, 0);
      ship._setRosaWingProgress(2, 0);
    }
  }
}

/** The module singleton. MenuScene3D imports it DIRECTLY (constructed inside MenuScreen with no dependency channel):
 *  do not thread a new constructor argument through MenuScreen. */
export const openingDance = new OpeningDance();

export { FLOWER_TRAVEL_S, FLOWER_REST_FRAC, WING_ROLL_S, T_HANDOVER_S };
