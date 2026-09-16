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
 * a TOTAL no-op — every path then lands on endState(ship), which is also the
 * CONTINUE / GAMEOVER-retry / reduced-motion / ?shot path. The one invariant:
 * a ship is NEVER seen in the packed pose outside a running dance.
 *
 * ── THE CLOCK IS WALL-CLOCK, NOT ACCUMULATED dt ─────────────────────────────
 * The dance is read from TWO independent render loops: MenuScene3D runs its own
 * requestAnimationFrame (js/ui/MenuScene3D.js — its own THREE.Clock, frame-gated
 * to 60/30 fps) while js/main.js runs the game loop. Accumulating dt here would
 * let the two views disagree about how far the unfold has got, and the menu→game
 * cut would pop. So the dance stores a START TIMESTAMP and derives progress from
 * performance.now(); both loops call progress() and get the same answer.
 * tick(dt) exists ONLY to emit the beat edges once each — it must never
 * integrate the pose.
 *
 * ── THE DRIVER DUCK-TYPE ────────────────────────────────────────────────────
 * PlayerSatellite consumes only isActive() and getRosaProgress() from its
 * injected launch driver (PlayerSatellite.js — the setLaunchSequence handshake),
 * plus the isActive() gate on setFlowerPose('LAUNCH') and snapFlowerToLaunch().
 * So this class needs no edits to the flower/ROSA code at all: it is bound with
 * ship.setLaunchSequence(dance) and UNBOUND (setLaunchSequence(null)) at
 * hand-over, which is what returns the player's own furl control.
 *
 * ── STATUS ──────────────────────────────────────────────────────────────────
 * PLACEHOLDER API CONTRACT (dispatcher, 2026-09-16). This file currently
 * declares the shape that js/ui/MenuScene3D.js, js/main.js and
 * js/systems/GameFlowManager.js import, and is INERT: isActive() is false,
 * progress() is zero, no events, no mesh writes. The driver lane replaces every
 * body below with the real beat table (plan task 1); the signatures and the
 * module-singleton export are the part other lanes depend on.
 *
 * @module systems/OpeningDance
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

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

class OpeningDance {
  constructor() {
    /** @private wall-clock ms at t = 0 (jet-off), or null when not armed */
    this._t0Ms = null;
    /** @private the ship currently driven — hero first, then the sim ship */
    this._ship = null;
    /** @private */
    this._running = false;
    /** @private set by skip(); the remaining unfold fast-forwards over SKIP_FADE_S */
    this._skipAtMs = null;
  }

  /** @returns {boolean} the flag, read live so a test can flip it */
  get enabled() {
    return !!Constants.FEATURE_FLAGS.OPENING_DANCE;
  }

  /**
   * Arm the dance and set t = 0. Called from MENU_DEPARTURE_START; t = 0 is
   * jet-off (start + BEAT_JETOFF × durationMs), NOT the departure start — there
   * is deliberately no new jet-off event.
   * @param {{ t0Ms?: number }} [_opts]
   */
  start(_opts) {
    if (!this.enabled) return;
    // TODO(driver lane): set _t0Ms from the departure start + BEAT_JETOFF.
  }

  /**
   * Bind the ship this dance drives. Called TWICE — the menu hero, then the sim
   * ship — and with null at hand-over to return furl control to the player.
   * @param {object|null} _ship - a PlayerSatellite, or null to unbind
   */
  bindShip(_ship) {
    if (!this.enabled) return;
    // TODO(driver lane): ship.setLaunchSequence(this) / (null) handshake.
  }

  /**
   * Emit the beat edges once each. MUST NOT integrate the pose — progress() is
   * derived from the wall clock so that both render loops agree.
   * @param {number} _dt - seconds
   */
  tick(_dt) {
    if (!this.enabled || !this._running) return;
    // TODO(driver lane): edge-detect the beats, fire audio + the two events.
  }

  /**
   * Any input during the dance fast-forwards the remaining unfold over
   * SKIP_FADE_S and then hands over. No refusal, no scolding.
   */
  skip() {
    if (!this.enabled || !this._running) return;
    // TODO(driver lane).
  }

  /** @returns {boolean} the launch-driver duck-type's activity gate */
  isActive() {
    return false;
  }

  /**
   * The whole dance state at the current wall-clock instant. Both render loops
   * call this; neither advances it.
   * @returns {typeof ZERO_PROGRESS}
   */
  progress() {
    return ZERO_PROGRESS;
  }

  /**
   * The launch-driver duck-type PlayerSatellite reads for the ROSA roll-out.
   * @returns {{ wing1: number, wing2: number }}
   */
  getRosaProgress() {
    const p = this.progress();
    return { wing1: p.wing1, wing2: p.wing2 };
  }

  /**
   * Land `ship` on the finished pose WITHOUT playing anything: radiator 146°,
   * wings 1.0, daughters 146°, dance unbound. EVERY path that does not run the
   * dance calls this — CONTINUE, GAMEOVER retry, reduced motion, flag off, the
   * ?shot harness — so the ship is never seen packed outside the dance.
   * @param {object} _ship - a PlayerSatellite
   */
  endState(_ship) {
    // TODO(driver lane): snapFlowerToStow() + wings 1.0 + struts 146° + unbind.
  }

  /**
   * Snap `ship` to the PACKED pose — wings furled, radiator folded. Idempotent.
   * Needs isActive() true first (the flower's own launch-pose gate).
   * @param {object} _ship - a PlayerSatellite
   */
  applyPacked(_ship) {
    if (!this.enabled) return;
    // TODO(driver lane): snapFlowerToLaunch() + _setRosaWingProgress(1|2, 0).
  }
}

/**
 * The module singleton. MenuScene3D imports this DIRECTLY: it is constructed
 * inside MenuScreen with no dependency channel, and it already imports
 * Constants and PlayerSatellite the same way. Do not thread a new constructor
 * argument through MenuScreen.
 */
export const openingDance = new OpeningDance();

export { OpeningDance, ZERO_PROGRESS };

// Referenced so the event names travel with the module that owns them; the
// driver lane emits both from tick().
void eventBus;
void Events.OPENING_DANCE_HANDOVER;
void Events.OPENING_DANCE_COMPLETE;
