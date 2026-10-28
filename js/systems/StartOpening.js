/**
 * StartOpening.js — the ship opens up on the player's first action (owner 2026-10-20, DECISIONS "Opening at the start").
 *
 * Every start leaves the ship as its row says: battery at half and falling, wings rolled up, radiators closed (0°),
 * daughter struts shut (0°). That holds until the player's FIRST ACTION; then, at once and never waiting for each
 * other (DECISIONS §10/§11): the wings roll out, the radiators open to 146°, the daughter struts go to their 34° rest.
 * Same on Mac and iPad. The one line posted here is "Solar panels open. Power coming in." (owner 2026-10-28; the
 * radiator explanation is gone), or just "Solar panels open." when the ship is in Earth's shadow.
 *
 * What counts as the first action: the first of these that arrives while the opening is ARMED, the game is in a
 * gameplay state and the start ride (the intro fly-by) is not in flight:
 *   • a `keydown` that is not a repeat, not a bare modifier (Shift, Control, Alt, Meta, CapsLock), not Escape and
 *     not held with Meta or Control (browser shortcuts). The step chip's synthetic keys count.
 *   • a `pointerdown` anywhere on the page (canvas, HUD, F1 bar, chips, pads);
 *   • a `wheel` (scroll zoom, trackpad pinch).
 * Mouse moves and hovers do not count. Counting is decided at CAPTURE time, before InputManager's own listeners: the
 * key that skips the opening dance was judged "not armed" (the dance arms nothing) and never fires this. An input
 * during the start ride only skips the ride; the next one fires.
 *
 * When it acts: only the actuation is deferred, so it runs AFTER the triggering input's own handlers and each part is
 * a SET, never a toggle: a first press of `,` `O` or `.`, a tap on the wings chip, or an F1 bar button can never
 * close a part again.
 *   • key, wheel: a 0 ms task after the event;
 *   • pointerdown: wait for that pointer's `pointerup` / `pointercancel`, then for a `click` that may follow (up to
 *     CLICK_WAIT_MS), then a 0 ms task. So a long look-around drag opens her at its end; the F1 bar and the step
 *     chip run on that click, before this does.
 * `ownsStepTap('Comma')` lets main.js hold back the wings chip's own key press while a tap on it waits here (the key
 * is a toggle; the opening is the set the tap asked for).
 *
 * Armed: `arm()` runs every time the start state is applied: the new game's hand-over, CONTINUE, retry, game over →
 * shop exit (OpeningDance's `setOnStartApplied` hook). Once per arming, then disarmed. If a part is already commanded
 * open when the ride ends (the player pressed `,` `O` or `.` during the dance or ride) the player has already acted:
 * it fires then, found by a light poll (RIDE_POLL_MS) that runs only while armed.
 *
 * Pure of the DOM except `install()`: gates, actuators, clock and the line's sink are injected, so it unit-tests
 * without a page. `shipOpeningActuators` builds the real ones from the player ship and the arm manager.
 *
 * @module systems/StartOpening
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { GestureHints } from '../ui/hud/GestureHints.js';
import { radToDeg } from '../core/MathUtil.js';

/**
 * The parts the first action opens, in the order the line names them. ONE constant: the owner is being asked whether
 * the radiators stay in the opening (measured 2026-10-20: open, the ship cools to 0 °C in about 150 s and the heaters
 * then eat the extra sun, so after 3.5-5 min the battery is lower than with them shut). Drop 'radiators' here and
 * they open by themselves at 70 °C (ThermalSystem._updateAutoRadiator); the line changes with it.
 */
export const OPENING_PARTS = Object.freeze(['wings', 'radiators', 'struts']);

/** The opening line (owner 2026-10-28; the onboarding Director leaves it on screen, see OnboardingDirector). */
export const OPENING_LINE = 'Solar panels open. Power coming in.';
/** The same line in Earth's shadow: no power is coming in, so it says only what happened. */
export const OPENING_LINE_SHADOW = 'Solar panels open.';
/** @returns {boolean} `text` is one of the two opening lines */
export function isOpeningLine(text) { return text === OPENING_LINE || text === OPENING_LINE_SHADOW; }

/** How long after a pointer lets go a `click` may still follow (the F1 bar and the step chip run on it). */
export const CLICK_WAIT_MS = 350;
export const RIDE_POLL_MS = 250;
/** A pointer held longer than this counts as released (a lost `pointerup` must not hold the opening forever). */
export const POINTER_HOLD_MAX_MS = 30000;
/**
 * After a pointer-started opening has fired, a chip's late comma press (a click after CLICK_WAIT_MS on a slow touch
 * stack) is still held back this long: it is a toggle and would roll the wings straight back up.
 */
export const STEP_TAP_GRACE_MS = 800;

/** Bare modifiers never count as an action. */
const MODIFIER_CODES = new Set([
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
  'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight', 'CapsLock',
]);
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'OS', 'CapsLock']);

// Whether a keydown is a first action: not a repeat, not a bare modifier, not Escape, not a browser shortcut.
export function keyCounts(e) {
  if (!e || e.repeat) return false;
  if (e.metaKey || e.ctrlKey) return false;
  if (e.code === 'Escape' || e.key === 'Escape') return false;
  if (MODIFIER_CODES.has(e.code) || MODIFIER_KEYS.has(e.key)) return false;
  return true;
}

// The one comms line, posted on the first action (owner 2026-10-28). Only when the wings opened (it says solar panels
// open); '' otherwise. `opts.inShadow`: no power comes in, so only the first sentence.
export function openingLine(opened, opts = {}) {
  if (!Array.isArray(opened) || !opened.includes('wings')) return '';
  return opts.inShadow === true ? OPENING_LINE_SHADOW : OPENING_LINE;
}

// Whether the radiator's COMMANDED angle is nearer the open pose than the rest pose (the "." law).
function flowerCommandedOpen(p) {
  const FL = Constants.THERMAL.FLOWER;
  const rad = p._flowerTargetTheta !== undefined ? p._flowerTargetTheta : p._flowerThetaRad;
  if (!Number.isFinite(rad)) return false;
  const deg = radToDeg(rad);
  return Math.abs(deg - FL.OPEN_DEG) < Math.abs(deg - FL.REST_DEG);
}

function flowerFitted(p) {
  return !!(p && typeof p.getFlowerPairCount === 'function' && p.getFlowerPairCount() > 0
    && typeof p.setFlowerPose === 'function');
}

/**
 * The real SET actuators and the "already commanded open" reader over the player ship and the arm manager (getters:
 * both are made after boot).
 *
 * Radiators go through the ship's `setFlowerPose(OPEN_POSE)` (146°), then emit THERMAL_FLOWER_INPUT
 * { deploying: true } — exactly what the O key and the F1 bar emit — so ThermalSystem sees a player opening (its
 * auto-open lets go, the 30 s player-wins window starts, the codex trigger fires). No click and no THERMAL comms
 * line: the opening's one line replaces the O handler's "Radiator opening to 146° ...". A radiator the player
 * already opened (their own O) is left alone and emits nothing more. Wings and struts emit nothing:
 * STRUT_DEPLOY_INPUT / ROSA_FURL_INPUT are the tutorial's "the player did this" credit, and the player did not.
 */
export function shipOpeningActuators({ getPlayer, getArmManager, bus = eventBus }) {
  const actuators = {
    wings() {
      const p = getPlayer();
      if (!p || typeof p.setRosaFurl !== 'function') return false;
      if (!(p._rosaFurlTarget >= 0.5)) p.setRosaFurl(1.0);
      return true;
    },
    radiators() {
      const p = getPlayer();
      if (!flowerFitted(p)) return false;
      if (flowerCommandedOpen(p)) return true;               // the player already opened it (their own O): leave it
      if (p.flowerHandoffHeld === true || p.flowerCommandsLocked === true) return false;       // held for a catch hand-off or a daughter's carry: the ship says so itself
      const FL = Constants.THERMAL.FLOWER;
      if (p.setFlowerPose(FL.OPEN_POSE) === null) return false;
      bus.emit(Events.THERMAL_FLOWER_INPUT, { deploying: true });
      return true;
    },
    struts() {
      const am = getArmManager();
      if (!am || typeof am.restStruts !== 'function') return false;
      return am.restStruts() === true;
    },
  };
  const commanded = () => {
    const p = getPlayer();
    const am = getArmManager();
    return {
      wings: !!(p && p._rosaFurlTarget >= 0.5),
      radiators: !!(flowerFitted(p) && flowerCommandedOpen(p)),
      struts: !!(am && typeof am.strutsDeployed === 'function' && am.strutsDeployed()),
    };
  };
  return { actuators, commanded };
}

/**
 * @typedef {object} StartOpeningDeps
 * @property {() => boolean} [isGameplay] - the game is in a gameplay state
 * @property {() => boolean} [introInFlight] - the start ride is flying
 * @property {object} [actuators] - { wings, radiators, struts }: one SET per part; true = now open or opening
 * @property {() => object} [commanded] - which parts are already commanded open
 * @property {(text: string) => void} [say] - the sink of the one comms line
 * @property {readonly string[]} [parts] - defaults to OPENING_PARTS
 * @property {() => void} [beforeLine] - posts the start lines still waiting, called before the opening line
 * @property {() => boolean} [inShadow] - the ship is in Earth's shadow now (the line then omits "Power coming in.")
 * @property {object} [timers] - { setTimeout(fn, ms), clear(id) }
 */

export class StartOpening {
  constructor(deps = {}) {
    this._isGameplay = deps.isGameplay || (() => false);
    this._introInFlight = deps.introInFlight || (() => false);
    this._actuators = deps.actuators || {};
    this._commanded = deps.commanded || (() => ({}));
    this._say = deps.say || StartOpening.defaultSay;
    // Earth's shadow at the moment of the first action (main.js: the ship's cached flag); unknown = sunlit
    // Called right before the opening line goes out: posts the start lines still waiting (a new game without the
    // dance), so "Arrived", "Systems" always come first
    this._beforeLine = typeof deps.beforeLine === 'function' ? deps.beforeLine : () => {};
    this._inShadow = typeof deps.inShadow === 'function' ? deps.inShadow : () => false;
    this._parts = Array.isArray(deps.parts) ? deps.parts : OPENING_PARTS;
    this._timers = deps.timers || {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clear: (id) => clearTimeout(id),
    };
    // armed: the next first action opens the ship
    this._armed = false;
    // the action that counted and is waiting to actuate, or null
    this._pending = null;
    // the ride-end poll's timer
    this._pollId = null;
    // a pointer-started opening just fired: a chip's late comma press is still held back
    this._grace = null;
    this._fires = 0;
    this._lastLine = '';
    this._target = null;
    this._listeners = [];

    this._onKeyDown = (e) => this.onKeyDown(e);
    this._onPointerDown = (e) => this.onPointerDown(e);
    this._onPointerUp = (e) => this.onPointerUp(e);
    this._onClick = (e) => this.onClick(e);
    this._onWheel = (e) => this.onWheel(e);
  }

/** Default sink: one HOUSTON line, tier-0 pass (the onboarding Director mutes everything else early on). */
  static defaultSay(text) {
    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'HOUSTON',
      text: GestureHints.speak(text),
      priority: 'info',
      _onboarding: true,
      // never folded away by the 2 s burst rule (a fast first action must not drop "Arrived" / "Systems")
      _keep: true,
    });
  }


  /** The start state was just applied: the next first action opens the ship. Safe to call again (a retry). */
  arm() {
    this._cancelPending();
    this._cancelPoll();
    this._endGrace();
    this._armed = true;
    this._schedulePoll();
  }

  disarm() {
    this._armed = false;
    this._cancelPending();
    this._cancelPoll();
    this._endGrace();
  }

  isArmed() { return this._armed; }

  isPending() { return this._armed && this._pending !== null; }

  /** A pointer press is waiting here as the player's first action; the canvas tap that is that same press must not also scan. */
  isPointerPending() { return this._armed && this._pending !== null && this._pending.kind === 'pointer'; }

  get fires() { return this._fires; }

  get lastLine() { return this._lastLine; }

  /**
   * True while a tap on a step chip waits here as the first action (or just fired, STEP_TAP_GRACE_MS): the chip's own
   * key press (a toggle) must be held back. Only the wings chip's `Comma`.
   */
  ownsStepTap(code) {
    if (code !== 'Comma') return false;
    if (this._grace !== null) return true;
    return this._armed && this._pending !== null && this._pending.kind === 'pointer';
  }

  _endGrace() {
    if (this._grace !== null) this._timers.clear(this._grace);
    this._grace = null;
  }

  /** Listen on the page (capture, passive) so the judgement runs before any other listener. Idempotent. */
  install(target) {
    this.uninstall();
    if (!target || typeof target.addEventListener !== 'function') return false;
    const opts = { capture: true, passive: true };
    this._listeners = [
      ['keydown', this._onKeyDown],
      ['pointerdown', this._onPointerDown],
      ['pointerup', this._onPointerUp],
      ['pointercancel', this._onPointerUp],
      ['click', this._onClick],
      ['wheel', this._onWheel],
    ];
    for (const [type, fn] of this._listeners) target.addEventListener(type, fn, opts);
    this._target = target;
    return true;
  }

  uninstall() {
    const t = this._target;
    if (t && typeof t.removeEventListener === 'function') {
      for (const [type, fn] of this._listeners) t.removeEventListener(type, fn, { capture: true });
    }
    this._target = null;
    this._listeners = [];
  }


  /** Armed, in gameplay and no ride in flight: an input now is a first action. */
  _counts() {
    if (!this._armed) return false;
    let play = false;
    let ride = false;
    try { play = !!this._isGameplay(); } catch (_e) { play = false; }
    try { ride = !!this._introInFlight(); } catch (_e) { ride = false; }
    return play && !ride;
  }

  onKeyDown(e) {
    if (!this._armed || !keyCounts(e)) return;
    if (this._pending) {
      // A pointer is still down: a key is an action too, so do not wait for the release.
      if (this._pending.state === 'down') this._fireSoon();
      return;
    }
    if (!this._counts()) return;
    this._begin({ kind: 'key', state: 'fire' });
    this._fireSoon();
  }

  onWheel(_e) {
    if (!this._armed) return;
    if (this._pending) {
      if (this._pending.state === 'down') this._fireSoon();
      return;
    }
    if (!this._counts()) return;
    this._begin({ kind: 'wheel', state: 'fire' });
    this._fireSoon();
  }

  onPointerDown(e) {
    if (!this._armed || !e) return;
    const id = e.pointerId === undefined ? 0 : e.pointerId;
    if (this._pending) {
      // The same pointer pressed again without a release in between: the release was lost.
      if (this._pending.kind === 'pointer' && this._pending.state === 'down' && this._pending.pointerId === id) this._fireSoon();
      return;
    }
    if (!this._counts()) return;
    this._begin({ kind: 'pointer', state: 'down', pointerId: id });
    // Safety: a lost pointerup must not hold the opening for ever.
    this._pending.timer = this._timers.setTimeout(() => this._fireSoon(), POINTER_HOLD_MAX_MS);
  }

  onPointerUp(e) {
    const p = this._pending;
    if (!this._armed || !p || p.kind !== 'pointer' || p.state !== 'down') return;
    const id = e && e.pointerId !== undefined ? e.pointerId : 0;
    if (id !== p.pointerId) return;
    this._clearTimer(p);
    p.state = 'click';
    // A click may still follow (the F1 bar, the step chip): wait for it, but not for ever.
    p.timer = this._timers.setTimeout(() => this._fireSoon(), CLICK_WAIT_MS);
  }

  onClick(_e) {
    const p = this._pending;
    if (!this._armed || !p || p.kind !== 'pointer') return;
    if (p.state === 'down' || p.state === 'click') this._fireSoon();
  }


  _begin(p) {
    this._pending = Object.assign({ timer: null }, p);
  }

  _clearTimer(p) {
    if (p && p.timer !== null && p.timer !== undefined) this._timers.clear(p.timer);
    if (p) p.timer = null;
  }

  _cancelPending() {
    const p = this._pending;
    this._pending = null;
    this._clearTimer(p);
  }

  /** @private run the opening in a 0 ms task: after the triggering event's own handlers */
  _fireSoon() {
    const p = this._pending;
    if (!p || p.queued) return;
    this._clearTimer(p);
    p.state = 'fire';
    p.queued = true;
    p.timer = this._timers.setTimeout(() => {
      p.timer = null;
      if (this._pending !== p) return;      // re-armed or disarmed meanwhile
      this.fire();
    }, 0);
  }


  _schedulePoll() {
    this._pollId = this._timers.setTimeout(() => this._poll(), RIDE_POLL_MS);
  }

  _cancelPoll() {
    if (this._pollId !== null && this._pollId !== undefined) this._timers.clear(this._pollId);
    this._pollId = null;
  }

  _poll() {
    this._pollId = null;
    if (!this._armed) return;
    if (!this._pending && this._counts() && this._anyCommanded()) {
      this.fire();
      return;
    }
    this._schedulePoll();
  }

  _anyCommanded() {
    let c = null;
    try { c = this._commanded() || {}; } catch (_e) { c = {}; }
    return !!(c.wings || c.radiators || c.struts);
  }

  /**
   * Open the ship now: each part of `parts` is a SET (see `shipOpeningActuators`), none waits for another, then ONE
   * comms line names what opened and why. Once per arming. If the game left gameplay meanwhile (the first key was
   * the shop's), nothing happens and it stays armed for the next gameplay input. Null when not armed / not in gameplay.
   */
  fire() {
    if (!this._armed) return null;
    const viaPointer = !!(this._pending && this._pending.kind === 'pointer');
    this._cancelPending();
    let play = false;
    try { play = !!this._isGameplay(); } catch (_e) { play = false; }
    if (!play) return null;
    this._armed = false;
    this._cancelPoll();
    if (viaPointer) {
      this._endGrace();
      this._grace = this._timers.setTimeout(() => { this._grace = null; }, STEP_TAP_GRACE_MS);
    }
    try { this._beforeLine(); } catch (e) { console.error('[StartOpening] beforeLine:', e); }
    const opened = [];
    for (const part of this._parts) {
      const act = this._actuators[part];
      if (typeof act !== 'function') continue;
      let ok = false;
      try { ok = act() === true; } catch (e) { console.error('[StartOpening] ' + part + ':', e); }
      if (ok) opened.push(part);
    }
    this._fires++;
    let inShadow = false;
    try { inShadow = this._inShadow() === true; } catch (_e) { inShadow = false; }
    const line = openingLine(opened, { inShadow });
    this._lastLine = line;
    if (line) {
      try { this._say(line); } catch (e) { console.error('[StartOpening] say:', e); }
    }
    return { opened, line };
  }
}
