/**
 * OpeningDance.js — the ship unpacks itself (2026-09-16).
 *
 * The deployment cinematic that replaces the 60 s rocket launch at boot. It
 * STARTS IN THE MENU as the EVA astronaut jets off the hull she is welding,
 * the menu hero's solar wings roll out at the SHIPPED hardware rate (the
 * player's ship keeps its wings rolled up — w4-power D2), and the player gets
 * the wheel 4.0 s after the menu cuts away. No rocket, no fairing, no
 * persistence writes, no arm launch lock.
 *
 * DECISIONS §15 row 4 (owner 2026-10-08, lane w2-start-pose): the ship STARTS
 * CLOSED — the radiator stays folded flat along the body, at its 0° launch
 * latch (= POSE_CLOSED_DEG since 2026-10-16: owner, no slightly-open step
 * after the clamp release; it eased to 2° before) and the daughter struts stay shut at α 0.
 * Before that ruling the dance swept the radiator out to the 146° bud and
 * opened the struts to 146° after the hand-over; both beats are gone.
 *
 * Feature-flag gated: FEATURE_FLAGS.OPENING_DANCE (default true). Flag off is
 * a TOTAL no-op (start/tick/skip/applyPacked do nothing) — every path then
 * lands on endState(ship), which is also the CONTINUE / GAMEOVER-retry /
 * reduced-motion / ?shot path. The one invariant: a ship is NEVER seen with
 * the radiator's launch lock armed outside a running dance.
 * endState itself is deliberately NOT flag-gated: with the flag off the ship
 * still boots to the finished pose.
 *
 * w4-power D2 (owner 2026-10-12: "Mother starts with wings and daughters
 * retracted, battery is 50% and dropping until wings open"): the SHIP's wings
 * now stay rolled up through the dance and on every start path; the player
 * opens them (`,` or WINGS on floor 1). The wing beats below still play on the
 * menu hero (MenuScene3D reads progress()); getRosaProgress() reports 0.
 *
 * Owner 2026-10-20 (DECISIONS "Opening at the start"): the start state holds
 * only until the player's FIRST ACTION. Then StartOpening (systems/
 * StartOpening.js) rolls the wings out, opens the radiators to 146° and takes
 * the struts to 34°. This module only arms it: `setOnStartApplied(fn)` is
 * called once the start state is in place, at the hand-over and at the end of
 * `endState` (every other start path).
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
 * plus the isActive() gate on setFlowerPose('LAUNCH').
 * So this class needs no edits to the flower/ROSA code at all: it is bound with
 * ship.setLaunchSequence(dance) and UNBOUND (setLaunchSequence(null)) at
 * hand-over, which is what returns the player's own furl control. The
 * `isOpeningDance` marker below is the duck-typed tag PlayerSatellite's
 * message-silence gates read (never an instanceof — no import either way).
 *
 * ── BEATS (t = 0 at jet-off; anchors in Constants.OPENING_DANCE) ────────────
 *   t = 0.00  latches pop; the radiator rests at CLOSED 0° (no ease; was 2°, 0.13 s) — the
 *             SHIP's own 15°/s driver (setFlowerPose(REST_POSE) latches the
 *             target and releases the launch lock; the hero is driven from
 *             progress() by MenuScene3D, the sim ship slews itself once bound)
 *   t = 2.70  cut to game (MENU_START): the sim ship is bound and snapped to
 *             the live progress so the cut has no pop
 *   t = 5.20  hero wing 1 rolls out as the camera's dive lands (2.5 s);
 *             t = 6.20  hero wing 2 (the intro dolly drifts out through both).
 *             The player's ship does NOT roll them out (w4-power D2) and
 *             the dance plays no sound for them; the beats are bookkeeping.
 *   t = 8.70  time-based hand-over (the hero's wing 2 is seated by then) →
 *             OPENING_DANCE_HANDOVER and, in the same tick,
 *             OPENING_DANCE_COMPLETE (there is no daughter tail any more); the
 *             player is flying, radiator folded, struts shut
 * skip(): any input fast-forwards the remaining unfold over SKIP_FADE_S (0.5 s)
 * to the exact hand-over state.
 *
 * @module systems/OpeningDance
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { audioSystem } from './AudioSystem.js';
import { GestureHints } from '../ui/hud/GestureHints.js';
import { devShotGate } from '../core/DevShotGate.js';
import { wingsHint } from './WingsHint.js';
import { degToRad, radToDeg, lerp } from '../core/MathUtil.js';

/** Beat-table anchors — the ONE named constants block (Constants.js). */
const OD = Constants.OPENING_DANCE;
const FL = Constants.THERMAL.FLOWER;

/** w4-power D2: what getRosaProgress() reports to the bound ship — rolled up. */
const SHIP_WINGS_ROLLED_UP = Object.freeze({ wing1: 0, wing2: 0 });

/** w4-power D3 / u2-one-voice D3: the start line — true to the start (the
 *  battery at half and draining, the wings still rolled up) and key-free. Since
 *  2026-10-20 (DECISIONS "Opening at the start") it also says when she opens:
 *  on the player's first action, which StartOpening carries out. */
export const HANDOVER_LINE = 'Battery at half and falling, Cowboy. Press or tap anything and she opens up. '
  + 'She is yours.';

/**
 * Zero progress — the shape every consumer sees before t = 0 and after unbind.
 * Frozen so a caller can never mutate the shared idle object.
 */
const ZERO_PROGRESS = Object.freeze({
  /** seconds since jet-off (t = 0), clamped at 0 before it */
  t: 0,
  /** radiator θ as a fraction of the 0° → 146° sweep (θ = flower × 146°, the
   *  mapping MenuScene3D's hero and the sim-ship sync both use). Since
   *  DECISIONS §15 row 4 the dance leaves it at CLOSED 0° (it eased to 2° until 2026-10-16), so it ends at
   *  FLOWER_REST_FRAC (0), not 1. */
  flower: 0,
  /** ROSA wing roll-out 0..1 */
  wing1: 0,
  wing2: 0,
  /** daughter strut sweep per arm index — always 0 since DECISIONS §15 row 4
   *  (the struts stay shut; kept so the snapshot shape never changes) */
  struts: Object.freeze([0, 0, 0, 0]),
  /** true once the radiator and both wings are seated (the camera hand-over) */
  handedOver: false,
  /** true once the dance is over — the same tick as the hand-over now */
  complete: false,
});

/** The rest θ the dance lands on: REST_POSE (CLOSED, DECISIONS §15 row 4),
 *  through the ONE mapping (Constants.THERMAL.FLOWER.REST_DEG — the same the
 *  ship's own _flowerRestDeg reads). */
const REST_DEG = FL.REST_DEG;
const REST_RAD = degToRad(REST_DEG);
/** The radiator's dance travel, LAUNCH 0° → REST at the shipped 15°/s — 0.133 s
 *  for CLOSED 0°: no travel at all (was 0.13 s to 2°, 9.73 s to the bud). */
const FLOWER_TRAVEL_S = (REST_DEG - FL.POSE_LAUNCH_DEG) / (radToDeg(FL.SLEW_RATE_RAD_S));
/** progress().flower once the radiator is at rest: θ_rest / 146°. */
const FLOWER_REST_FRAC = REST_DEG / FL.POSE_STOW_DEG;
/** One ROSA wing at the gameplay furl rate (the `,` key's rate) — 2.5 s. */
const WING_ROLL_S = 1 / Constants.OCTOPUS_V5.ROSA_FURL_RATE;
/** @private 0..1 clamp — the one used by every derived progress scalar. */
const _clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** The daughter struts' snapshot — always shut (DECISIONS §15 row 4). */
const STRUTS_SHUT = Object.freeze([0, 0, 0, 0]);

/** The hand-over beat: the last scripted motion ends — wing 2 seated, 8.70 s
 *  (the radiator's 0.13 s ease is long done). */
const T_HANDOVER_S = Math.max(FLOWER_TRAVEL_S, OD.WING2_START_S + WING_ROLL_S);
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
     * instanceof, no import — the dance is the only driver of that slot). */
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
    /** @private beat-edge latch — each edge fires exactly once per arming */
    this._fired = null;
    /** @private StartOpening's arm(): called once the start state is applied (see setOnStartApplied) */
    this._onStartApplied = null;
  }

  /**
   * StartOpening hook (owner 2026-10-20: the ship opens on the player's first
   * action). `fn` runs every time the START STATE has just been applied — the
   * new game's hand-over (`_fireHandover`) and `endState` (CONTINUE, retry,
   * game over → shop exit, reduced motion, flag off) — and arms the opening.
   * No bus event: the arming is a direct call, owned by main.js's wiring.
   * @param {(() => void)|null} fn
   */
  setOnStartApplied(fn) {
    this._onStartApplied = (typeof fn === 'function') ? fn : null;
  }

  /** @private tell the opening the start state is in place (a throwing hook never breaks a start) */
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
      return lerp(this._skipFromT, T_HANDOVER_S, u);
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
    // u5-info-ap-hold D3: comms holds the start's lines until the hand-over (a disabled dance never holds).
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
   * the REST target is latched so the ship's OWN 15°/s driver finishes the
   * ease from there and releases the lock at the CLOSED floor — the two never
   * disagree by more than frame jitter. (In practice the 0.13 s ease is long
   * over by the 2.70 s cut, so this lands θ at rest and the lock clears in
   * the same `_updateFlower(0)`.)
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
    // w4-power D2 (owner 2026-10-12: "Mother starts with wings and daughters
    // retracted, battery is 50% and dropping until wings open"): the ship's
    // wings stay rolled up through the dance and after it — the start furl is
    // held like a player hold (manual control, target 0), so the auto roll-out
    // in _updateRosaPanels never undoes it. The menu hero keeps the dance's
    // wing values (MenuScene3D reads progress(), not this ship).
    if (typeof ship._setRosaWingProgress === 'function') {
      ship._setRosaWingProgress(1, 0);
      ship._setRosaWingProgress(2, 0);
    }
    if (ship._rosaFurlProgress !== undefined) {
      ship._rosaFurlProgress = 0;
      ship._rosaFurlTarget = 0;
      ship._rosaManualControl = true;
    }
    // Shut daughters: drop any stale slew target a previous run left behind
    // (ArmUnit.reset does not clear it) so nothing creeps open — the struts
    // stay at α 0 for the whole dance (DECISIONS §15 row 4).
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
    // w4-power D2: the wings are not part of the ship's pose any more — they
    // stay rolled up (the hero keeps p.wing1/p.wing2 through progress()).
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
      // The ship's own 15°/s driver: latch the REST target — the release out
      // of the launch fold to CLOSED (the hero is driven from progress() by
      // MenuScene3D instead — this latch is for a bound, self-updating ship).
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

    // No daughter beat (DECISIONS §15 row 4): the struts stay shut at α 0, so
    // the dance never writes `arm._strutTargetAlpha` and the hand-over is
    // also the end — OPENING_DANCE_COMPLETE follows in the same tick.
    if (!this._fired.handover && t >= T_HANDOVER_S) {
      this._fired.handover = true;
      this._fireHandover();
      this._fireComplete();
    }
  }

  /**
   * @private The hand-over: exact end pose for the radiator (CLOSED, lock
   * off) and wings, the driver unbound (the player's furl control resumes),
   * the camera event, then the ONE Houston line (force-free; the onboarding
   * boot beat posts first — task 5 starts the director on this same event).
   */
  _fireHandover() {
    const ship = this._ship;
    // w4-power D3: the line is true to the wings. They start rolled up (D2);
    // only a player who already pressed `,` during the dance has them opening.
    let wingsOpening = false;
    if (ship) {
      // The exact hand-over state (skip or natural: idempotent).
      if (ship._flowerGroups && ship._flowerGroups.length) {
        ship._flowerLaunchLock = false;
        ship._flowerOverrideFold = false;
        ship._flowerThetaRad = REST_RAD;
        if (typeof ship._updateFlower === 'function') ship._updateFlower(0);
      }
      // w4-power D2: both wings stay rolled up (target 0, held like a player
      // hold) — unless the player asked for them during the dance, which is
      // kept: the roll-out then starts the frame the driver unbinds.
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
    // u5-info-ap-hold D3: comms opens FIRST (the held boot lines enter the log in order), then the hand-over
    // listeners post "Powering up ..." and the battery line, which stay the last two. Never rely on listener order.
    eventBus.emit(Events.COMMS_RELEASE, {});
    eventBus.emit(Events.OPENING_DANCE_HANDOVER, { t: T_HANDOVER_S });
    // ONE short Houston line at hand-over (decision 12) — normal priority, no
    // force, distinct from the onboarding boot beat that fires on the event.
    this._postStartLine(wingsOpening);
    // Owner 2026-10-20: the ship opens on the player's first action. The start
    // state is in place — arm it (a player who already asked for a part during
    // the dance has acted: StartOpening opens the rest when the ride ends).
    this._notifyStartApplied();
  }

  /**
   * @private The ONE start line (w4-power D3), shared by the dance hand-over
   * and the non-dance starts (endState). True to the pose — the battery at
   * half and falling, the wings still rolled up — and it says she opens up on
   * the first action (StartOpening), key-free, so glass and desktop read the same.
   * @param {boolean} wingsOpening - the player already asked for the wings: the
   *   opening fires itself at the end of the ride and posts its own line, so
   *   there is no start line (the old "Arrays rolling out ... the radiator
   *   stays folded" is untrue now that the radiators open with it)
   */
  _postStartLine(wingsOpening) {
    if (wingsOpening) return;
    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'HOUSTON',
      text: GestureHints.speak(HANDOVER_LINE),
      priority: 'info',
      // m1-finish: the hand-over starts the Director first (OPENING_DANCE_HANDOVER ->
      // ONBOARDING_STARTED), which drops comms to tier 0; an untagged line was muted
      // there (measured by test-WingsHint A1). _onboarding is the tier-0 pass.
      _onboarding: true,
    });
    // m1-finish: the comms line scrolls away, the battery keeps falling — keep ONE
    // ticker row up until the wings are out (WingsHint; removed by the game loop's
    // update once the ship's wing value passes WINGS_OUT_PROGRESS). The START arms
    // the hint WITHOUT a row (owner 2026-10-28): any first action opens the ship.
    wingsHint.post({ start: true });
  }

  /** @private The dance is over (fires in the hand-over tick). */
  _fireComplete() {
    if (this._fired && this._fired.complete) return;
    if (this._fired) this._fired.complete = true;
    this._running = false;
    eventBus.emit(Events.OPENING_DANCE_COMPLETE, {});
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
   * The launch-driver duck-type PlayerSatellite reads for the ROSA roll-out.
   * w4-power D2: the dance no longer rolls the ship's wings out — it reports
   * them rolled up for its whole run (PlayerSatellite holds them at 0). The
   * dance's own wing beats live on in progress(), which drives the menu hero.
   * @returns {{ wing1: number, wing2: number }}
   */
  getRosaProgress() {
    return SHIP_WINGS_ROLLED_UP;
  }

  /** @private one ROSA wing's 0..1 roll-out at dance time `t`. */
  _wing(startS, t) {
    return _clamp01((t - startS) / WING_ROLL_S);
  }

  /**
   * Land `ship` on the finished pose WITHOUT playing anything: radiator CLOSED
   * (REST_POSE, lock off), wings rolled up (w4-power D2 — held at 0 until the
   * player opens them), daughter struts shut at α 0, dance
   * unbound. EVERY path that does not run the dance calls this — CONTINUE,
   * GAMEOVER retry, reduced motion, flag off, the ?shot harness — so the ship
   * is never seen with the launch lock armed outside the dance. NOT
   * flag-gated (with the flag off the ship still boots to this pose).
   * @param {object} ship - a PlayerSatellite
   */
  endState(ship) {
    // endState MEANS "the dance is over". A dance left running here would keep
    // driving a ship nobody is watching and fire its hand-over later, on a
    // path that never wanted one — the shape of the bug this guards is a
    // GAMEOVER retry landing mid-unfold (a Kessler collision inside the
    // unfold is perfectly possible). Stopping is unconditional
    // and idempotent; callers that mean to KEEP the dance must not call this
    // (GameFlowManager.resetGame's `keepOpeningDance`).
    this._abort();
    // u5-info-ap-hold D3: a start without the dance (CONTINUE, retry) opens comms before its own line.
    eventBus.emit(Events.COMMS_RELEASE, {});
    if (!ship) return;
    if (typeof ship.setLaunchSequence === 'function') ship.setLaunchSequence(null);
    // Radiator: the REST pose (CLOSED) via the ship's own snap (clears any
    // lock; the THERMAL_FLOWER_RELEASED it may emit is silence-gated while a
    // dance is live — and no dance is live on these paths).
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
    // w4-power D2: every path that starts or restarts play leaves both wings
    // rolled up, the start furl held like a player hold (target 0).
    if (ship._rosaFurlProgress !== undefined) {
      ship._rosaFurlProgress = 0;
      ship._rosaFurlTarget = 0;
      ship._rosaManualControl = true;
    }
    // w4-power: a start that skipped the dance (CONTINUE, retry, reduced
    // motion, flag off) begins at half battery, draining, wings rolled up — say
    // so once, the same line the hand-over posts. Not in ?shot screenshot runs.
    // A bare test-harness endState(stub) cannot be told apart from a real
    // start (no marker on the ship), so it posts too.
    if (!devShotGate.requested && !(ship._rosaFurlTarget >= 0.5)) this._postStartLine(false);
    // Daughters: shut at α 0 (DECISIONS §15 row 4 — the daughter docks at the
    // full closed strut position, §4). Every production caller has just run
    // armManager.reset(), which parks them at 0; this drops any stale slew
    // latch (ArmUnit.reset does not clear it) and snaps a docked strut that is
    // somehow still open back to 0. A stub without setAimAlpha gets a latch
    // to 0 instead.
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
    // Owner 2026-10-20: every start path ends here, so the opening is armed here.
    this._notifyStartApplied();
  }

  /**
   * Snap `ship` to the PACKED pose — wings furled, radiator folded (θ 0, launch
   * lock armed). Idempotent. Used at hero build (lane C, before any departure
   * arms the clock — so the flower's own isActive() gate cannot be used and the
   * launch-lock fields are written directly) and at
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
      ship._flowerThetaRad = degToRad(FL.POSE_LAUNCH_DEG);
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

export { FLOWER_TRAVEL_S, FLOWER_REST_FRAC, WING_ROLL_S, T_HANDOVER_S };
