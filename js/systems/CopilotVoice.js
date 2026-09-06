/**
 * CopilotVoice.js — the COPILOT's spoken phrases (Session M, 2026-09-06).
 *
 * At most EIGHT short imperative English phrases through SpeechSynthesis, one
 * per cue: engage / match / align / arrived / off_manual / off / no_target /
 * drift. They are the co-pilot's voice, not the comms channel's text: none
 * repeats a COMMS_MESSAGE line ('AUTOPILOT ENGAGED. ...' / 'AUTOPILOT OFF. ...'
 * / 'ON STATION ...') verbatim, and none carries a pictographic glyph.
 *
 * NO DOM. Every dep is injected and optional: `synth` (a speechSynthesis-like
 * { speak, cancel, speaking }), `Utterance` (the SpeechSynthesisUtterance
 * constructor), `bus` / `events` (the game EventBus + the Events table; the
 * module defaults to the singletons like CargoPane), `now` (ms clock), and
 * the hub's closures `enabled` (false under the dev shot gate — passed in,
 * never parsed here), `isMuted`, `duck` (AudioSystem.duckForVoice). Missing
 * synth ⇒ silence; a throwing utterance ⇒ swallowed. Nothing is emitted.
 *
 * ARMING: iPad Safari speaks only inside a user gesture, so `attach(target)`
 * adds ONE `pointerdown` and ONE `keydown` listener (capture, passive, once)
 * whose first firing calls `arm()`: a primer utterance (a single space at
 * volume 0) spoken inside that gesture unlocks the synthesiser for the cues
 * that follow. No touch* listener anywhere (the desktop touch-listener law).
 *
 * CUES: `cue(key)` is a no-op unless enabled && armed && synth && Utterance
 * && !isMuted(); utterances are rate-limited to >= 1500 ms apart; a PHASE cue
 * (match / align / arrived / drift / off / off_manual) cancels the current
 * utterance first (the newest state wins); `duck(true)` on utterance start,
 * `duck(false)` on end / error / cancel (balanced — one duck per utterance).
 *
 * WIRING: the bus gives engage / off / no_target (AUTOPILOT_ENGAGE — the first
 * one of an engagement only, since the AP re-emits it on a heading-mode change
 * mid-flight — / AUTOPILOT_DISENGAGE by reason / AUTOPILOT_NO_TARGET); the
 * FMA strip's `onPhaseChange` gives match / align / arrived / drift through
 * `phase(prev, next)`. AUTOPILOT_ARRIVED is deliberately NOT subscribed: the
 * HOLD phase already speaks 'arrived' (pinned — no double-speak).
 *
 * @module systems/CopilotVoice
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

/**
 * PHRASES — the whole vocabulary: <= 8 entries, each <= 40 characters, plain
 * ASCII, imperative. Keyed by cue. Frozen; `phrases()` returns this table.
 */
export const PHRASES = Object.freeze({
  engage:     'Hands off. Autopilot has the ship.',
  match:      'Matching orbit. Stand by.',
  align:      'Aligning. Watch the range.',
  arrived:    'Holding station. Launch when ready.',
  off_manual: 'You have the ship. Fly it.',
  off:        'Autopilot released. Your ship.',
  no_target:  'Pick a target first.',
  drift:      'Drifting. Hold on.',
});

/** The cues that describe a state change — they cancel whatever is still being spoken. */
export const PHASE_CUES = Object.freeze(['match', 'align', 'arrived', 'drift', 'off', 'off_manual']);

/** Minimum spacing between two utterances (ms). */
export const RATE_LIMIT_MS = 1500;

/** The primer spoken inside the arming gesture: one space at volume 0. */
export const PRIMER_TEXT = ' ';

/**
 * The cue for an autopilot phase change (AutopilotSystem PHASE keys), or null.
 * MATCH_ORBIT ⇒ 'match'; TRAIL_ALIGN ⇒ 'align' (from HOLD it is a fall-back:
 * 'drift'); HOLD ⇒ 'arrived'. RENDEZVOUS_FAR / OFF say nothing here — the bus
 * cues (engage / off) cover them.
 * @param {string|null} prev
 * @param {string|null} next
 * @returns {string|null}
 */
export function cueForPhase(prev, next) {
  switch (next) {
    case 'MATCH_ORBIT': return 'match';
    case 'TRAIL_ALIGN': return prev === 'HOLD' ? 'drift' : 'align';
    case 'HOLD': return 'arrived';
    default: return null;
  }
}

const LISTENER_OPTS = Object.freeze({ capture: true, passive: true, once: true });

export class CopilotVoice {
  /**
   * @param {object} [deps]
   * @param {object}   [deps.synth]     speechSynthesis-like { speak(u), cancel(), speaking }. Absent ⇒ silent.
   * @param {function} [deps.Utterance] the SpeechSynthesisUtterance constructor. Absent ⇒ silent.
   * @param {object}   [deps.bus]       event bus with on(event, fn) → unsubscribe (default: eventBus; null ⇒ no wiring).
   * @param {object}   [deps.events]    the Events name table (default: Events).
   * @param {function} [deps.now]       ms clock (default: performance.now / Date.now).
   * @param {boolean}  [deps.enabled=true] false ⇒ attach adds nothing, cue speaks nothing (the hub passes !devShotGate.requested).
   * @param {function} [deps.isMuted]   () → boolean; true ⇒ cue speaks nothing (default: () => false).
   * @param {function} [deps.duck]      (on: boolean) → void; the mix duck around an utterance (default: none).
   * @param {string}   [deps.lang='en-US']
   * @param {number}   [deps.rate=1.0]
   */
  constructor(deps = {}) {
    this._synth = deps.synth || null;
    this._Utterance = typeof deps.Utterance === 'function' ? deps.Utterance : null;
    this._bus = deps.bus !== undefined ? deps.bus : eventBus;
    this._events = deps.events !== undefined ? deps.events : Events;
    this._now = typeof deps.now === 'function' ? deps.now : defaultNow;
    this._enabled = deps.enabled === undefined ? true : !!deps.enabled;
    this._isMuted = typeof deps.isMuted === 'function' ? deps.isMuted : () => false;
    this._duck = typeof deps.duck === 'function' ? deps.duck : null;
    this._lang = typeof deps.lang === 'string' ? deps.lang : 'en-US';
    this._rate = Number.isFinite(deps.rate) ? deps.rate : 1.0;

    this._armed = false;
    this._disposed = false;
    this._lastMs = null;             // the last utterance's start (rate limit)
    this._ducked = false;            // one duck outstanding (balanced on end / error / cancel)
    this._engaged = false;           // own bookkeeping: AUTOPILOT_ENGAGE speaks once per engagement
    this._unsubs = [];
    this._attached = null;           // { target, onGesture } while the arming listeners are registered

    this._subscribe();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** True once a user gesture (or an explicit arm()) has unlocked speech. */
  get armed() { return this._armed; }

  /** The frozen phrase table (for the pin). */
  phrases() { return PHRASES; }

  /**
   * Register the arming gesture listeners on `target` (the hub passes
   * window): one pointerdown + one keydown, capture / passive / once; the
   * first to fire arms and both leave. Nothing when disabled, already armed,
   * disposed, or the target cannot listen.
   * @param {EventTarget} target
   * @returns {boolean} whether listeners were added
   */
  attach(target) {
    if (!this._enabled || this._armed || this._disposed || this._attached) return false;
    if (!target || typeof target.addEventListener !== 'function') return false;
    const onGesture = () => this.arm();
    this._attached = { target, onGesture };
    target.addEventListener('pointerdown', onGesture, LISTENER_OPTS);
    target.addEventListener('keydown', onGesture, LISTENER_OPTS);
    return true;
  }

  /**
   * Unlock speech: once — speaks the volume-0 primer (inside the caller's
   * gesture on iOS) and marks the voice armed; the arming listeners leave.
   * @returns {boolean} whether this call armed
   */
  arm() {
    if (!this._enabled || this._armed || this._disposed) return false;
    this._armed = true;
    this._detach();
    this._speak(PRIMER_TEXT, { volume: 0, duck: false });
    return true;
  }

  /**
   * Speak the phrase for `key` (a PHRASES key). No-op unless enabled, armed,
   * a synth + Utterance exist, and not muted; rate-limited; phase cues cancel
   * the current utterance first.
   * @param {string} key
   * @returns {boolean} whether an utterance was queued
   */
  cue(key) {
    if (this._disposed || !this._enabled || !this._armed) return false;
    if (!this._synth || !this._Utterance) return false;
    const text = PHRASES[key];
    if (!text) return false;
    if (this._muted()) return false;
    const t = Number(this._now());
    if (this._lastMs !== null && Number.isFinite(t) && t - this._lastMs < RATE_LIMIT_MS) return false;
    if (PHASE_CUES.includes(key)) this._cancel();
    if (!this._speak(text, { duck: true })) return false;
    this._lastMs = Number.isFinite(t) ? t : this._lastMs;
    return true;
  }

  /**
   * An autopilot phase change (the FMA strip's onPhaseChange): speaks the
   * mapped cue, if any.
   * @param {string|null} prev
   * @param {string|null} next
   * @returns {boolean} whether an utterance was queued
   */
  phase(prev, next) {
    const key = cueForPhase(prev, next);
    return key ? this.cue(key) : false;
  }

  /** Unsubscribe the bus, drop the arming listeners, cancel speech (guarded); further calls no-op. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const off of this._unsubs) {
      try { off(); } catch (_e) { /* stub bus */ }
    }
    this._unsubs = [];
    this._detach();
    this._cancel();
  }

  // ── Bus ────────────────────────────────────────────────────────────────────

  /** @private engage / off / no_target from the autopilot's own events (ARRIVED is the HOLD phase's). */
  _subscribe() {
    const bus = this._bus;
    const E = this._events;
    if (!bus || typeof bus.on !== 'function' || !E) return;
    const wire = (name, fn) => {
      if (!name) return;
      const off = bus.on(name, fn);
      if (typeof off === 'function') this._unsubs.push(off);
      else if (typeof bus.off === 'function') this._unsubs.push(() => bus.off(name, fn));
    };
    wire(E.AUTOPILOT_ENGAGE, () => {
      if (this._engaged) return;               // a heading-mode re-emit mid-flight, not a new engagement
      this._engaged = true;
      this.cue('engage');
    });
    wire(E.AUTOPILOT_DISENGAGE, (data) => {
      this._engaged = false;
      this.cue(data && data.reason === 'ARROW_INPUT' ? 'off_manual' : 'off');
    });
    wire(E.AUTOPILOT_NO_TARGET, () => { this.cue('no_target'); });
  }

  // ── Speech (every call guarded) ────────────────────────────────────────────

  /** @private isMuted() guarded: a throwing closure reads as muted. */
  _muted() {
    try { return !!this._isMuted(); } catch (_e) { return true; }
  }

  /**
   * @private Build + queue one utterance. `opts.volume` overrides the volume
   * (the primer's 0); `opts.duck` wires the duck around it. Errors are swallowed.
   * @returns {boolean} queued
   */
  _speak(text, opts = {}) {
    const synth = this._synth;
    const Utterance = this._Utterance;
    if (!synth || typeof synth.speak !== 'function' || !Utterance) return false;
    try {
      const u = new Utterance(text);
      u.lang = this._lang;
      u.rate = this._rate;
      if (opts.volume !== undefined) u.volume = opts.volume;
      if (opts.duck && this._duck) {
        u.onstart = () => this._setDuck(true);
        u.onend = () => this._setDuck(false);
        u.onerror = () => this._setDuck(false);
      }
      synth.speak(u);
      return true;
    } catch (_e) {
      return false;
    }
  }

  /** @private Cancel whatever is being spoken (guarded) and release the duck — no event may follow a cancel. */
  _cancel() {
    const synth = this._synth;
    if (synth && typeof synth.cancel === 'function') {
      try { synth.cancel(); } catch (_e) { /* swallowed */ }
    }
    this._setDuck(false);
  }

  /** @private Balanced duck: at most one outstanding duck(true) per utterance. */
  _setDuck(on) {
    if (!this._duck || this._ducked === !!on) return;
    this._ducked = !!on;
    try { this._duck(!!on); } catch (_e) { /* the mix is not the voice's problem */ }
  }

  /** @private Remove the arming listeners (guarded; the fired `once` one is already gone). */
  _detach() {
    const a = this._attached;
    if (!a) return;
    this._attached = null;
    const t = a.target;
    if (!t || typeof t.removeEventListener !== 'function') return;
    try {
      t.removeEventListener('pointerdown', a.onGesture, LISTENER_OPTS);
      t.removeEventListener('keydown', a.onGesture, LISTENER_OPTS);
    } catch (_e) { /* stub target */ }
  }
}

/** @private The default clock: performance.now when present, else Date.now. */
function defaultNow() {
  if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export default CopilotVoice;
