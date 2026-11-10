/**
 * TrainingHintGate.js — in training missions 1-3 a "do this" line waits until she has done nothing useful for about 10 s
 * (owner 2026-11-07: "Hint only when stuck"; DECISIONS §65 row 1). Lines that report a result (catch, grams, seconds)
 * are never held. The key chips on screen (HintTicker) are separate and are not touched.
 *
 * Owned by CommsSystem (it posts released lines). Pure of the DOM; the clock is injected for tests.
 *
 * Rules (training plan, Decisions 2-5):
 *  - The idle clock is the gate's own: it accrues only from `tick()` calls, each adding min(real ms since the last tick,
 *    TICK_CAP_MS). Pause, a hidden tab, slow motion and the x8 wheel clock neither speed it up nor slow it down.
 *  - The idle clock restarts on every useful input (`noteInput`), at mission start, and each time a hint is shown (at most
 *    one "do this" line per 10 s of her doing nothing). A held L or arrow (`noteHolding`, from PLAYER_HOLDING) keeps it at 0
 *    while held; it is not a new input (no held line is dropped).
 *  - A hint posted while she has been idle >= 10 s shows at once; otherwise it is held. Held hints show one at a time,
 *    oldest first. Held hints with the same `_hintKey` collapse to the newest text. At most MAX_HELD are kept.
 *  - A hint is dropped only when what it asks for has happened or can no longer happen: `_hintStale()` true, or a useful
 *    input with its `_hintKey`. `_hintReady()` false keeps it held. On any other useful input a held hint WITH `_hintStale`
 *    stays held; one WITHOUT it is dropped.
 *  - Mission start (the gate is built, the mission getter's value changes, GAME_RESET / MISSION_START) clears held hints.
 *
 * @module systems/TrainingHintGate
 */

import { TRAINING_MISSIONS } from '../core/missionProgress.js';

/** Real seconds of doing nothing useful before a "do this" line shows (owner 2026-11-07: "about 10 s"). */
export const HINT_IDLE_MS = 10000;
/** One tick adds at most this much to the idle clock (a stall / hidden tab must not add a minute at once). */
export const TICK_CAP_MS = 250;
/** Held hints kept (the newest). */
export const MAX_HELD = 8;

/** @type {(() => number)|null} the one mission getter (set once at wiring by main.js; tests set their own) */
let missionGetter = null;

/**
 * Set the one mission getter (main.js: `() => scoringSystem.getMissionNumber()`). `null` = not training anywhere.
 * @param {(() => number)|null} fn
 */
export function setTrainingMissionGetter(fn) {
  missionGetter = typeof fn === 'function' ? fn : null;
}

/** @returns {number|null} the current internal mission number, or null with no getter. */
export function getTrainingMission() {
  if (!missionGetter) return null;
  try {
    const n = missionGetter();
    return Number.isFinite(n) ? n : null;
  } catch (e) {
    return null;
  }
}

/**
 * Is the game in training missions 1..TRAINING_MISSIONS right now? Reads the mission getter live (never a flag set on
 * MISSION_START, which is not emitted for mission 1 or for a continue). No getter = not training.
 * @returns {boolean}
 */
export function isTrainingNow() {
  const n = getTrainingMission();
  return n !== null && n >= 1 && n <= TRAINING_MISSIONS;
}

/** @type {TrainingHintGate|null} the gate CommsSystem owns; teaching cards and the coach's forced card read its idle clock */
let activeGate = null;
/** @type {Set<(key: string|null) => void>} called on every useful input (a held teaching card is dropped by one) */
const inputListeners = new Set();

/**
 * CommsSystem registers its gate here so the other "do this" surfaces (teaching cards, MissionCoach's forced card) share
 * the ONE idle clock.
 * @param {TrainingHintGate|null} gate
 */
export function setActiveTrainingGate(gate) { activeGate = gate || null; }

/** @returns {TrainingHintGate|null} */
export function getActiveTrainingGate() { return activeGate; }

/**
 * Real ms she has done nothing useful, by the one gate's clock; null outside training or with no gate registered.
 * @returns {number|null}
 */
export function trainingIdleMs() {
  return activeGate && isTrainingNow() ? activeGate.idleMs() : null;
}

/** A "do this" card was shown: the idle clock restarts (at most one per 10 s of her doing nothing). */
export function noteTrainingHintShown() {
  if (activeGate) activeGate.noteHintShown();
}

/**
 * Listen for her useful inputs (any key reaching the action handling or a game event she causes).
 * @param {(key: string|null) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onTrainingInput(fn) {
  inputListeners.add(fn);
  return () => inputListeners.delete(fn);
}

/** @type {Set<(data: object, text: string) => void>} called when a hint line is SHOWN (logged), held or not */
const shownListeners = new Set();

/**
 * Listen for hint lines at the moment they are shown (logged). The codex text triggers use this in training 1-3: they must
 * fire on what she can read, not on the raw emit of a hint that is then held for ~10 s (or dropped and never seen).
 * @param {(data: object, text: string) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onTrainingHintShown(fn) {
  shownListeners.add(fn);
  return () => shownListeners.delete(fn);
}

/**
 * CommsSystem calls this when the gate releases a held hint into the log.
 * @param {object} data the hint's payload
 * @param {string} text the line as shown
 */
export function notifyTrainingHintShown(data, text) {
  for (const fn of shownListeners) {
    try { fn(data, text); } catch (e) { /* a listener never breaks the log */ }
  }
}

/**
 * Run a message predicate; a throwing or missing one is `fallback`.
 * @param {object} data
 * @param {'_hintStale'|'_hintReady'} name
 * @param {boolean} fallback
 * @returns {boolean}
 */
function ask(data, name, fallback) {
  const fn = data && data[name];
  if (typeof fn !== 'function') return fallback;
  try {
    return !!fn.call(data);
  } catch (e) {
    return fallback;
  }
}

/**
 * @typedef {object} HeldHint
 * @property {object} data the raw message payload (carries `_hintKey`, `_hintStale`, `_hintReady`)
 * @property {object} [own] the payload the stored line is built from, when that is not `data` (CommsSystem's `addMessage` path)
 * @property {() => void} post posts it into the log (the owner's normal post path)
 */

export class TrainingHintGate {
  /**
   * @param {object} [opts]
   * @param {() => number} [opts.now] wall clock in ms (default Date.now); injected by tests
   * @param {number} [opts.idleMs] idle needed before a hint shows (default HINT_IDLE_MS)
   */
  constructor(opts = {}) {
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this._idleMs = Number.isFinite(opts.idleMs) ? opts.idleMs : HINT_IDLE_MS;
    /** @type {HeldHint[]} oldest first */
    this._held = [];
    this._idle = 0;
    /** Useful inputs counted so far (`noteInput` and `noteHolding`, wherever either zeroes the idle clock). A line that was
     *  released and waits in the comms panel compares this with the count it was stored at: a change means she acted. Never reset. */
    this._inputs = 0;
    this._lastTick = null;
    this._mission = getTrainingMission();
  }

  /** Mission start: the idle clock restarts and the held hints are cleared. */
  reset() {
    this._held = [];
    this._idle = 0;
  }

  /** @returns {number} real ms of doing nothing useful, as the gate counts it */
  idleMs() { return this._idle; }

  /** @returns {number} useful inputs counted so far (see `_inputs`); a released hint is "fresh" while this has not moved */
  inputCount() { return this._inputs; }

  /** Another "do this" surface (a teaching card) showed a hint: the idle clock restarts, as when a held line is released. */
  noteHintShown() { this._idle = 0; }

  /** @returns {number} hints waiting */
  heldCount() { return this._held.length; }

  /** @returns {string[]} the held lines' text, oldest first (tests) */
  heldTexts() { return this._held.map((h) => String(h.data.text)); }

  /** A mission change seen by the getter is a mission start. */
  _syncMission() {
    const m = getTrainingMission();
    if (m !== this._mission) {
      this._mission = m;
      this.reset();
    }
  }

  /**
   * Drop the stale hints, then release at most one: the first ready hint, when the idle clock has reached its limit.
   * The idle clock restarts when one is released.
   * @returns {HeldHint[]} released hints (0 or 1), to be posted by the caller
   */
  _drain() {
    if (this._held.length) this._held = this._held.filter((h) => !ask(h.data, '_hintStale', false));
    if (this._idle < this._idleMs) return [];
    const i = this._held.findIndex((h) => ask(h.data, '_hintReady', true));
    if (i < 0) return [];
    const [hint] = this._held.splice(i, 1);
    this._idle = 0;
    return [hint];
  }

  /**
   * One frame of play. Call it from CommsSystem.update, which runs only in the gameplay branch.
   * @returns {HeldHint[]} released hints, to be posted by the caller
   */
  tick() {
    this._syncMission();
    const t = this._now();
    if (this._lastTick !== null) {
      const d = t - this._lastTick;
      if (d > 0) this._idle += Math.min(d, TICK_CAP_MS);
    }
    this._lastTick = t;
    return this._drain();
  }

  /**
   * A useful input (a key reaching the game's action handling, or a game event she caused). The idle clock restarts.
   * @param {string} [key] 'S'|'N'|'D'|'A'|... ; a held hint with this `_hintKey` is dropped
   */
  noteInput(key) {
    this._idle = 0;
    this._inputs++;
    for (const fn of inputListeners) {
      try { fn(key ? String(key).toUpperCase() : null); } catch (e) { /* a listener never breaks input */ }
    }
    if (!this._held.length) return;
    const k = key ? String(key).toUpperCase() : null;
    this._held = this._held.filter((h) => {
      if (k && String(h.data._hintKey || '').toUpperCase() === k) return false;   // she did what it asks
      return typeof h.data._hintStale === 'function';                              // predicate hints keep waiting
    });
  }

  /**
   * A useful key is HELD (L, or an arrow that acts): the idle clock stays at 0 for as long as it is held. Unlike `noteInput` this
   * is not "she did something new": no held line is dropped and no input listener runs (the keydown did that once).
   */
  noteHolding() { this._idle = 0; this._inputs++; }

  /**
   * A hint is posted. Held unless she has been idle long enough; a hint whose ask is already done is dropped.
   * @param {HeldHint} hint
   * @returns {{ dropped: boolean, held: boolean, released: HeldHint[] }} `released` lists what to post now (it may
   *   contain `hint` itself: then `held` is false)
   */
  submit(hint) {
    this._syncMission();
    if (ask(hint.data, '_hintStale', false)) return { dropped: true, held: false, released: [] };
    const key = hint.data._hintKey;
    const same = key ? this._held.findIndex((h) => h.data._hintKey === key) : -1;
    if (same >= 0) this._held[same] = hint;   // collapse to the newest text, keep the place in the queue
    else this._held.push(hint);
    while (this._held.length > MAX_HELD) this._held.shift();
    const released = this._drain();
    const held = this._held.includes(hint);
    return { dropped: !held && !released.includes(hint), held, released };
  }

  /**
   * A released hint that waited in the comms panel queue is withdrawn and goes back (`CommsSystem.takeStaleHint`). Like `submit`,
   * except that a hint whose `_hintKey` is already held is dropped: the held copy is newer (it was submitted after this one was
   * released), and the gate collapses to the newest text.
   * @param {HeldHint} hint
   * @returns {{ dropped: boolean, held: boolean, released: HeldHint[] }} as `submit`
   */
  resubmit(hint) {
    const key = hint.data._hintKey;
    if (key && this._held.some((h) => h.data._hintKey === key)) return { dropped: true, held: false, released: [] };
    return this.submit(hint);
  }
}

export default TrainingHintGate;
