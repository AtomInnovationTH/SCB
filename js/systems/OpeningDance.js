/**
 * OpeningDance.js — the ship unpacks itself (2026-09-16).
 *
 * The deployment cinematic that replaces the 60 s rocket launch at boot. It
 * STARTS IN THE MENU as the EVA astronaut jets off the hull she is welding,
 * cascades radiator → solar wings → daughters at the SHIPPED hardware rates,
 * and hands the player the wheel ~7.8 s after the menu cuts away. No rocket,
 * no fairing, no launch-phase persistence writes, no arm launch lock.
 *
 * Feature-flag gated: FEATURE_FLAGS.OPENING_DANCE (default true). Flag off is
 * a TOTAL no-op (start/tick/skip/applyPacked do nothing) — every path then
 * lands on endState(ship), which is also the CONTINUE / GAMEOVER-retry /
 * reduced-motion / ?shot path. The one invariant: a ship is NEVER seen in the
 * packed pose outside a running dance. endState itself is deliberately NOT
 * flag-gated: with the flag off the ship still boots to the open pose.
 *
 * ── THE CLOCK IS WALL-CLOCK, NOT ACCUMULATED dt ─────────────────────────────
 * The dance is read from TWO independent render loops: MenuScene3D runs its own
 * requestAnimationFrame (js/ui/MenuScene3D.js — its own THREE.Clock, frame-gated
 * to 60/30 fps) while js/main.js runs the game loop. Accumulating dt here would
 * let the two views disagree about how far the unfold has got, and the menu→game
 * cut would pop. So the dance stores a START TIMESTAMP and derives progress from
 * performance.now(); both loops call progress() and get the same answer.
 * tick(dt) exists ONLY to emit the beat edges once each — it must never
 * integrate the pose. (The one exception is the skip fade, where the ship's own
 * drivers physically cannot keep up: there tick APPLIES the pose, but it is
 * still a pure function of the wall clock — nothing is ever accumulated.)
 *
 * ── THE DRIVER DUCK-TYPE ────────────────────────────────────────────────────
 * PlayerSatellite consumes only isActive() and getRosaProgress() from its
 * injected launch driver (PlayerSatellite.js — the setLaunchSequence handshake),
 * plus the isActive() gate on setFlowerPose('LAUNCH') and snapFlowerToLaunch().
 * So this class needs no edits to the flower/ROSA code at all: it is bound with
 * ship.setLaunchSequence(dance) and UNBOUND (setLaunchSequence(null)) at
 * hand-over, which is what returns the player's own furl control. The
 * `isOpeningDance` marker below is the duck-typed tag PlayerSatellite's
 * message-silence gates read (never an instanceof — no import either way).
 *
 * ── BEATS (t = 0 at jet-off; anchors in Constants.OPENING_DANCE) ────────────
 *   t = 0.00  latches pop; radiator 0° → 146° (ends 9.73) — the SHIP's own
 *             15°/s driver (setFlowerPose('STOW') latches the target; the hero
 *             is driven from progress() by MenuScene3D, the sim ship slews
 *             itself once bound)
 *   t = 2.70  cut to game (MENU_START): the sim ship is bound and snapped to
 *             the live progress so the cut has no pop
 *   t = 5.20  ROSA wing 1 rolls out (2.5 s);  t = 6.20  wing 2
 *   t = 7.00  daughters begin, 0.25 s stagger, 0° → 146° each
 *   t = 9.73  radiator + wings seated → OPENING_DANCE_HANDOVER; the player is
 *             flying; the daughter tail keeps opening (~17.5 → COMPLETE)
 * skip(): any input fast-forwards the remaining unfold over SKIP_FADE_S (0.5 s)
 * to the exact hand-over state; the daughter tail still plays out. A player
 * strut command during the tail wins immediately (decision 11).
 *
 * @module systems/OpeningDance
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { audioSystem } from './AudioSystem.js';

/** Beat-table anchors — the ONE named constants block (Constants.js). */
const OD = Constants.OPENING_DANCE;
const FL = Constants.THERMAL.FLOWER;

/**
 * Zero progress — the shape every consumer sees before t = 0 and after unbind.
 * Frozen so a caller can never mutate the shared idle object.
 */
const ZERO_PROGRESS = Object.freeze({
  /** seconds since jet-off (t = 0), clamped at 0 before it */
  t: 0,
  /** radiator/flower sweep 0..1 over 0° → 146° */
  flower: 0,
  /** ROSA wing roll-out 0..1 */
  wing1: 0,
  wing2: 0,
  /** daughter strut sweep 0..1 over 0° → 146°, per arm index */
  struts: Object.freeze([0, 0, 0, 0]),
  /** true once the radiator and both wings are seated (the camera hand-over) */
  handedOver: false,
  /** true once the last daughter seats at 146° */
  complete: false,
});

/** Full 0° → 146° radiator sweep at the shipped 15°/s — 9.7333 s, the long pole. */
const FLOWER_TRAVEL_S = FL.POSE_STOW_DEG / (FL.SLEW_RATE_RAD_S * 180 / Math.PI);
/** One ROSA wing at the gameplay furl rate (the `,` key's rate) — 2.5 s. */
const WING_ROLL_S = 1 / Constants.OCTOPUS_V5.ROSA_FURL_RATE;
/** Daughter strut sweep 0° → the open pose at the shipped 15°/s. */
const STRUT_TRAVEL_S = OD.STRUT_OPEN_DEG / (Constants.OCTOPUS_V5.STRUT_SLEW_RATE * 180 / Math.PI);
/** The open pose in radians — where the daughters bloom to and stay. */
const STRUT_OPEN_RAD = (OD.STRUT_OPEN_DEG * Math.PI) / 180;
/** @private 0..1 clamp — the one used by every derived progress scalar. */
const _clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The hand-over beat: the radiator (the long pole) seated. Wings end 8.70 < 9.73. */
const T_HANDOVER_S = FLOWER_TRAVEL_S;
/**
 * How long skip() stays deaf after a menu skip advanced the clock. One
 * pointerdown reaches MenuScreen's capture-phase handler and InputManager's
 * bubble-phase one; without this the dance would treat the second half of that
 * single gesture as the player asking to fast-forward. Only has to outlive one
 * event's propagation, so it is deliberately tiny — a real second press cannot
 * land inside it.
 */
const SKIP_DEAF_MS = 120;

class OpeningDance {
  constructor() {
    /** Duck-typed tag: PlayerSatellite's message-silence gates read this (no
     * instanceof, no import — the launch-sequence driver stays distinct). */
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
    /** @private the strut beat edges' stagger bookkeeping (last start, for T_COMPLETE) */
    this._lastStrutStartS = OD.STRUT_START_S;
    /** @private the dance's own strut writes, for player-takeover detection */
    this._strutWrites = new Map();
    /** @private beat-edge latch — each edge fires exactly once per arming */
    this._fired = null;
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
   * @private Dance time in seconds since jet-off. NEGATIVE before t = 0 (the
   * caller clamps for progress; skip() refuses to act pre-cut). Skip-aware:
   * during the SKIP_FADE_S window t is accelerated linearly toward
   * T_HANDOVER_S, then resumes at 1× from there.
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
      return this._skipFromT + (T_HANDOVER_S - this._skipFromT) * u;
    }
    return (now - this._t0Ms) / 1000;
  }

  /**
   * Arm the dance and set t = 0. Called from MENU_DEPARTURE_START; t = 0 is
   * jet-off (start + BEAT_JETOFF × durationMs), NOT the departure start — there
   * is deliberately no new jet-off event. Re-arming (a second menu departure)
   * resets every beat latch.
   * @param {{ t0Ms?: number }} [opts] — the jet-off timestamp; defaults to the
   *   caller-derived menu figure (jet-off is 0.26 × the shipped departure)
   */
  start(opts) {
    if (!this.enabled) return;
    const t0Ms = (opts && Number.isFinite(opts.t0Ms))
      ? opts.t0Ms
      : this._now() + OD.BEAT_JETOFF * OD.MENU_DEPARTURE_MS;
    this._t0Ms = t0Ms;
    this._running = true;
    this._skipStartMs = null;
    this._skipFromT = 0;
    this._skipDeafUntilMs = null;
    this._strutWrites.clear();
    this._lastStrutStartS = OD.STRUT_START_S;
    this._fired = { latch: false, wing1: false, wing2: false, struts: [], handover: false, complete: false };
  }

  /**
   * Menu skip (MenuScreen's fast-forward / skipDeparture): the game side must
   * always start from the SAME state, so the clock is advanced to its cut-time
   * value. A menu skip skips the menu, not the dance (plan task 3). No-op once
   * t is at or past the cut, so normal (unskipped) MENU_STARTs are untouched.
   *
   * It also opens a short suppression window, because ONE GESTURE MUST NOT
   * COUNT TWICE. MenuScreen arms its skip on window CAPTURE
   * (MenuScreen._armSkipClick) and InputManager's dance hook is on BUBBLE, so
   * the capture handler always runs first and lands the clock at exactly
   * T_CUT_S — at which point skip()'s `t < T_CUT_S` refusal is false by one
   * float, and the very same click opens the fast-forward fade. The pre-cut
   * refusal alone cannot express "not from the click that caused this".
   */
  advanceClockToCutTime() {
    if (!this.enabled || this._t0Ms === null || this._skipStartMs !== null) return;
    const t = (this._now() - this._t0Ms) / 1000;
    if (t < OD.T_CUT_S) this._t0Ms -= (OD.T_CUT_S - t) * 1000;
    this._skipDeafUntilMs = this._now() + SKIP_DEAF_MS;
  }

  /**
   * @private Stop the dance dead without emitting anything — no hand-over, no
   * completion. Unbinds whatever ship it was driving (which is what returns
   * furl control) and drops every beat latch, so a later start() re-arms from
   * scratch. Idempotent; safe when the dance was never armed.
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
    this._strutWrites.clear();
    this._fired = null;
  }

  /**
   * Bind the ship this dance drives. Called TWICE — the menu hero, then the sim
   * ship — and with null at hand-over to return furl control to the player.
   * While the dance is running, binding ALSO snaps the ship to the live
   * progress in the same call (the MENU_START contract: no frame draws a
   * deployed ship after the cut, and no packed ship survives it).
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
   * @private Snap `ship` to the CURRENT dance pose (the bind-time contract).
   * The flower lock is re-armed (a resetGame between reveal and MENU_START
   * cleared it via snapFlowerToStow), θ is jumped to the wall-clock value, and
   * the STOW target is latched so the ship's OWN 15°/s driver continues the
   * sweep from there — the two never disagree by more than frame jitter.
   * @param {object} ship
   */
  _syncShipPose(ship) {
    const p = this.progress();
    if (ship._flowerGroups && ship._flowerGroups.length) {
      ship._flowerLaunchLock = true;
      ship._flowerOverrideFold = false;
      ship._flowerTargetTheta = (FL.POSE_STOW_DEG * Math.PI) / 180;
      ship._flowerThetaRad = p.flower * (FL.POSE_STOW_DEG * Math.PI) / 180;
      if (typeof ship._updateFlower === 'function') ship._updateFlower(0);
    }
    if (typeof ship._setRosaWingProgress === 'function') {
      ship._setRosaWingProgress(1, p.wing1);
      ship._setRosaWingProgress(2, p.wing2);
    }
    if (ship._rosaFurlProgress !== undefined) {
      ship._rosaFurlProgress = (p.wing1 + p.wing2) / 2;
      ship._rosaFurlTarget = 1.0;
      ship._rosaManualControl = false;
    }
    // Packed daughters: drop any stale slew target a previous run left behind
    // (ArmUnit.reset does not clear it) so nothing creeps open before t = 7.
    const arms = (ship.armManager && ship.armManager.arms) || [];
    for (const arm of arms) {
      if (arm && arm._strutTargetAlpha !== undefined) arm._strutTargetAlpha = undefined;
    }
  }

  /**
   * @private Apply the pose directly from the wall clock — used ONLY during
   * the skip fade, where the ship's own 15°/s drivers cannot keep up with the
   * fast-forward. Pure function of the clock; nothing is integrated.
   * @param {object} ship
   * @param {object} p - this.progress()
   */
  _applyShipPose(ship, p) {
    if (ship._flowerGroups && ship._flowerGroups.length) {
      ship._flowerThetaRad = p.flower * (FL.POSE_STOW_DEG * Math.PI) / 180;
      if (typeof ship._updateFlower === 'function') ship._updateFlower(0);
    }
    if (typeof ship._setRosaWingProgress === 'function') {
      ship._setRosaWingProgress(1, p.wing1);
      ship._setRosaWingProgress(2, p.wing2);
    }
    if (ship._rosaFurlProgress !== undefined) {
      ship._rosaFurlProgress = (p.wing1 + p.wing2) / 2;
    }
  }

  /**
   * Emit the beat edges once each. MUST NOT integrate the pose — progress() is
   * derived from the wall clock so that both render loops agree.
   * @param {number} _dt - seconds (unused: the clock is wall-clock)
   */
  tick(_dt) {
    if (!this.enabled || !this._running || this._fired === null) return;
    // `_dt` is deliberately unused: the pose is a pure function of the wall
    // clock (see the header). tick's ONLY job is to fire each beat edge once.
    const t = Math.max(0, this._t());

    // Skip fade: the ship's own drivers cannot keep up — apply the pose
    // straight from the clock (pure; never integrated). This is the one path
    // that needs the full snapshot, and it only runs during the 0.5 s fade.
    if (this._skipStartMs !== null && this._ship) this._applyShipPose(this._ship, this.progress());

    if (!this._fired.latch) {
      this._fired.latch = true;
      // The latch clunk (decision 12: sound only). playArmDeploy with a short
      // dur — the vocabulary count pins forbid a new entry (task 8).
      try { audioSystem.playArmDeploy(0.2); } catch (_e) { /* headless */ }
      // The ship's own 15°/s driver: latch the STOW target (the hero is driven
      // from progress() by MenuScene3D instead — this latch is for a bound,
      // self-updating ship).
      if (this._ship && typeof this._ship.setFlowerPose === 'function') {
        this._ship.setFlowerPose('STOW');
      }
    }

    if (!this._fired.wing1 && t >= OD.WING1_START_S) {
      this._fired.wing1 = true;
      try { audioSystem.playArmDeploy(0.9); } catch (_e) { /* headless */ }
    }
    if (!this._fired.wing2 && t >= OD.WING2_START_S) {
      this._fired.wing2 = true;
      try { audioSystem.playArmDeploy(0.9); } catch (_e) { /* headless */ }
    }

    // Daughter stagger beats — write `arm._strutTargetAlpha` (the same latch
    // the "." toggle drives); PlayerSatellite._updateStruts slews it at the
    // shipped 15°/s. The tail runs past hand-over by design (decision 11).
    const arms = (this._ship && this._ship.armManager && this._ship.armManager.arms) || [];
    for (let i = 0; i < arms.length; i++) {
      if (this._fired.struts[i]) continue;
      const startS = OD.STRUT_START_S + i * OD.STRUT_STAGGER_S;
      if (t < startS) continue;
      this._fired.struts[i] = true;
      this._lastStrutStartS = startS;
      try { audioSystem.playArmDeploy(0.35); } catch (_e) { /* headless */ }
      const arm = arms[i];
      if (arm && (arm.state === undefined || arm.state === Constants.ARM_STATES.DOCKED)) {
        arm._strutTargetAlpha = STRUT_OPEN_RAD;
        this._strutWrites.set(arm, STRUT_OPEN_RAD);
      }
    }

    if (!this._fired.handover && t >= T_HANDOVER_S) {
      this._fired.handover = true;
      this._fireHandover();
    }

    if (this._fired.handover && !this._fired.complete) {
      // A player strut command during the tail wins immediately (decision 11):
      // any target the dance did not write means the player took the wheel.
      if (this._playerTookStruts() || t >= this._lastStrutStartS + STRUT_TRAVEL_S) {
        this._fireComplete();
      }
    }
  }

  /**
   * @private The hand-over: exact end pose for the radiator and wings, the
   * driver unbound (the player's furl control resumes), the camera event, then
   * the ONE Houston line (force-free; the onboarding boot beat posts first —
   * task 5 starts the director on this same event).
   */
  _fireHandover() {
    const ship = this._ship;
    if (ship) {
      // The exact hand-over state (skip or natural: idempotent).
      if (ship._flowerGroups && ship._flowerGroups.length) {
        ship._flowerLaunchLock = false;
        ship._flowerOverrideFold = false;
        ship._flowerThetaRad = (FL.POSE_STOW_DEG * Math.PI) / 180;
        if (typeof ship._updateFlower === 'function') ship._updateFlower(0);
      }
      if (typeof ship._setRosaWingProgress === 'function') {
        ship._setRosaWingProgress(1, 1);
        ship._setRosaWingProgress(2, 1);
      }
      if (ship._rosaFurlProgress !== undefined) {
        ship._rosaFurlProgress = 1.0;
        ship._rosaFurlTarget = 1.0;
      }
      if (typeof ship.setLaunchSequence === 'function') ship.setLaunchSequence(null);
      this._ship = null;
    }
    this._skipStartMs = null;   // the fade is over (if any)
    eventBus.emit(Events.OPENING_DANCE_HANDOVER, { t: T_HANDOVER_S });
    // ONE short Houston line at hand-over (decision 12) — normal priority, no
    // force, distinct from the onboarding boot beat that fires on the event.
    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'HOUSTON',
      text: 'Radiator seated and arrays out, Cowboy. The arms are still opening — she is yours.',
      priority: 'info',
    });
  }

  /** @private The daughters are seated (or the player took them over). */
  _fireComplete() {
    if (this._fired && this._fired.complete) return;
    if (this._fired) this._fired.complete = true;
    this._running = false;
    this._strutWrites.clear();
    eventBus.emit(Events.OPENING_DANCE_COMPLETE, {});
  }

  /** @private True when a strut target the dance did not write appeared. */
  _playerTookStruts() {
    for (const [arm, val] of this._strutWrites) {
      if (arm._strutTargetAlpha !== undefined && Math.abs(arm._strutTargetAlpha - val) > 1e-9) {
        return true;
      }
    }
    return false;
  }

  /**
   * Any input during the dance fast-forwards the remaining unfold over
   * SKIP_FADE_S and then hands over. No refusal, no scolding. Refused before
   * the cut (t < T_CUT_S): in the menu, input belongs to MenuScreen's own
   * departure skip — a menu skip skips the menu, not the dance (the clock is
   * advanced to cut-time at MENU_START instead).
   */
  skip() {
    if (!this.enabled || !this._running || this._fired === null) return;
    if (this._fired.handover || this._skipStartMs !== null) return;
    // The menu-skip gesture's own echo: the capture-phase MenuScreen handler
    // has just advanced the clock to the cut, and this is the bubble phase of
    // that same pointerdown. See advanceClockToCutTime.
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
   * The whole dance state at the current wall-clock instant. Both render loops
   * call this; neither advances it.
   * @returns {typeof ZERO_PROGRESS}
   */
  progress() {
    if (this._t0Ms === null) return ZERO_PROGRESS;
    const raw = this._t();
    const t = Math.max(0, raw);
    const handedOver = !!(this._fired && this._fired.handover);
    const complete = !!(this._fired && this._fired.complete);
    const struts = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      const startS = OD.STRUT_START_S + i * OD.STRUT_STAGGER_S;
      struts[i] = _clamp01((t - startS) / STRUT_TRAVEL_S);
    }
    return {
      t,
      flower: _clamp01(t / FLOWER_TRAVEL_S),
      wing1: this._wing(OD.WING1_START_S, t),
      wing2: this._wing(OD.WING2_START_S, t),
      struts,
      handedOver,
      complete,
    };
  }

  /**
   * The launch-driver duck-type PlayerSatellite reads for the ROSA roll-out.
   * @returns {{ wing1: number, wing2: number }}
   */
  getRosaProgress() {
    // Read EVERY frame by PlayerSatellite._updateRosaPanels while the dance
    // runs, so it derives the two scalars straight from the clock rather than
    // building (and discarding) a whole progress snapshot per frame.
    const t = this._t0Ms === null ? 0 : Math.max(0, this._t());
    return { wing1: this._wing(OD.WING1_START_S, t), wing2: this._wing(OD.WING2_START_S, t) };
  }

  /** @private one ROSA wing's 0..1 roll-out at dance time `t`. */
  _wing(startS, t) {
    return _clamp01((t - startS) / WING_ROLL_S);
  }

  /**
   * Land `ship` on the finished pose WITHOUT playing anything: radiator 146°,
   * wings 1.0, daughters 146°, dance unbound. EVERY path that does not run the
   * dance calls this — CONTINUE, GAMEOVER retry, reduced motion, flag off, the
   * ?shot harness — so the ship is never seen packed outside the dance. NOT
   * flag-gated (with the flag off the ship still boots to this open pose).
   * @param {object} ship - a PlayerSatellite
   */
  endState(ship) {
    // endState MEANS "the dance is over". A dance left running here would keep
    // driving a ship nobody is watching and fire its hand-over later, on a
    // path that never wanted one — the shape of the bug this guards is a
    // GAMEOVER retry landing mid-unfold (the unfold is ~7.8 s and a Kessler
    // collision inside it is perfectly possible). Stopping is unconditional
    // and idempotent; callers that mean to KEEP the dance must not call this
    // (GameFlowManager.resetGame's `keepOpeningDance`).
    this._abort();
    if (!ship) return;
    if (typeof ship.setLaunchSequence === 'function') ship.setLaunchSequence(null);
    // Radiator: the STOW bud via the ship's own snap (clears any lock; the
    // THERMAL_FLOWER_RELEASED it may emit is silence-gated while a dance is
    // live — and no dance is live on these paths).
    if (typeof ship.snapFlowerToStow === 'function') ship.snapFlowerToStow();
    else if (ship._flowerGroups && ship._flowerGroups.length) {
      ship._flowerLaunchLock = false;
      ship._flowerOverrideFold = false;
      ship._flowerTargetTheta = undefined;
      ship._flowerThetaRad = (FL.POSE_STOW_DEG * Math.PI) / 180;
      if (typeof ship._updateFlower === 'function') ship._updateFlower(0);
    }
    if (typeof ship._setRosaWingProgress === 'function') {
      ship._setRosaWingProgress(1, 1.0);
      ship._setRosaWingProgress(2, 1.0);
    }
    if (ship._rosaFurlProgress !== undefined) {
      ship._rosaFurlProgress = 1.0;
      ship._rosaFurlTarget = 1.0;
      ship._rosaManualControl = false;
    }
    // Daughters: the one open pose (decision 4/5 — 146° and stay). Writing the
    // latch lets PlayerSatellite._updateStruts slew them there at the shipped
    // 15°/s; arms without the DOCKED state (stubs) are written regardless.
    const arms = (ship.armManager && ship.armManager.arms) || [];
    for (const arm of arms) {
      if (!arm) continue;
      if (arm.state !== undefined && arm.state !== Constants.ARM_STATES.DOCKED) continue;
      arm._strutTargetAlpha = STRUT_OPEN_RAD;
    }
  }

  /**
   * Snap `ship` to the PACKED pose — wings furled, radiator folded (θ 0, launch
   * lock armed). Idempotent. Used at hero build (lane C, before any departure
   * arms the clock — so the flower's own isActive() gate cannot be used and the
   * same fields snapFlowerToLaunch writes are written directly) and at
   * MENU_DEPARTURE_REVEAL on the sim ship (belt and braces: the hero still
   * frame-fills at the reveal, and the live pose is applied at MENU_START).
   * @param {object} ship - a PlayerSatellite
   */
  applyPacked(ship) {
    if (!this.enabled || !ship) return;
    if (typeof ship.setLaunchSequence === 'function') ship.setLaunchSequence(this);
    if (ship._flowerGroups && ship._flowerGroups.length) {
      ship._flowerLaunchLock = true;
      ship._flowerOverrideFold = false;
      ship._flowerTargetTheta = undefined;
      ship._flowerThetaRad = (FL.POSE_LAUNCH_DEG * Math.PI) / 180;
      if (typeof ship._updateFlower === 'function') ship._updateFlower(0);
    }
    if (typeof ship._setRosaWingProgress === 'function') {
      ship._setRosaWingProgress(1, 0);
      ship._setRosaWingProgress(2, 0);
    }
  }
}

/**
 * The module singleton. MenuScene3D imports this DIRECTLY: it is constructed
 * inside MenuScreen with no dependency channel, and it already imports
 * Constants and PlayerSatellite the same way. Do not thread a new constructor
 * argument through MenuScreen.
 */
export const openingDance = new OpeningDance();

export { FLOWER_TRAVEL_S, WING_ROLL_S, STRUT_TRAVEL_S, T_HANDOVER_S };
