/**
 * @module systems/DemoEnd — demo mode ends the game after mission 1, on the engines (owner 2026-10-29: "2 great missions that
 * build anticipation are better than 50 boring mediocre confusing frustrating missions", then, after the bot's timing, "Mission 1,
 * end on the engines"; the end applies on the demo iPad only, the public site keeps every mission). Demo mode is ShowMode.js's switch.
 *
 * Three parts, all free of THREE and of the DOM (Node-safe; the card's look is ui/DemoEndCard.js):
 *  1. `shouldEndDemo`: the pure rule. GameFlowManager asks it (through `setDemoEndCheck`, wired in main.js) on the credit
 *     that completes a mission and on a CONTINUE. At the credit it ARMS the end: the mission ends as ever (the "where next" list,
 *     the pick, the trip's turn and burn) but no route starts the next mission; Events.DEMO_END goes out once the camera's engine
 *     swing of the first burn is over (so she is seen climbing), or at once when no burn comes (a Stay pick, no trip, the burn's
 *     arrival). A pick that cannot go (`_tripCouldNotGo`) puts the list back: no end yet. A CONTINUE of a save past the end ends at once.
 *  2. `DemoEndWalkAway`: the clock for a visitor who walks off with the end card up. Untouched for `idleS` the card shows a
 *     countdown; at zero the new-player reset runs. Any touch restarts it.
 *  3. `wireDemoEnd`: on `Events.DEMO_END` it waits `DEMO_END_DELAY_MS` of real time (she climbs on screen meanwhile; a timer
 *     that a pause cannot stall), pauses the game behind the card the way "Still playing?" does, opens the card, and runs the
 *     walk-away clock. "Play again" (a button, or the countdown) is the New player reset, once.
 */

import { Events } from '../core/Events.js';
import { IDLE_S, COUNTDOWN_S } from './IdleReset.js';

/** The demo ends when this many missions are complete (5 credited catches each). One constant: the owner may move it. */
export const DEMO_END_AFTER_MISSION = 1;
/** Real ms between the end of the first burn's camera swing and the end card (she climbs on the range map meanwhile). */
export const DEMO_END_DELAY_MS = 4000;

/**
 * @param {{ demoOn: boolean, missionsCompleted: number }} a
 * @returns {boolean} true when demo mode is on and the last mission of the demo is complete
 */
export function shouldEndDemo({ demoOn, missionsCompleted } = {}) {
  if (demoOn !== true) return false;
  return Number.isFinite(missionsCompleted) && missionsCompleted >= DEMO_END_AFTER_MISSION;
}

/** The walk-away clock of the end card ('wait' | 'count'). Time is injected (fake clock in tests). */
export class DemoEndWalkAway {
  /**
   * @param {object} [d]
   * @param {Function} [d.now]         () => ms (default Date.now)
   * @param {number} [d.idleS]         untouched seconds before the countdown (default IDLE_S)
   * @param {number} [d.countdownS]    countdown seconds before the reset (default COUNTDOWN_S)
   * @param {Function} [d.onCountdown] (remainingS | null) => void: show the count, or null = hide it (a touch restarted)
   * @param {Function} [d.onReset]     () => void: the count reached zero
   */
  constructor(d = {}) {
    this._now = typeof d.now === 'function' ? d.now : () => Date.now();
    this.idleS = Number.isFinite(d.idleS) ? d.idleS : IDLE_S;
    this.countdownS = Number.isFinite(d.countdownS) ? d.countdownS : COUNTDOWN_S;
    this._onCountdown = d.onCountdown || (() => {});
    this._onReset = d.onReset || (() => {});
    this.state = 'wait';
    this._since = this._now();
    this._shown = null;
    this._done = false;
  }

  /** Restart from now (the card just opened, or a touch). Hides a countdown that was showing. */
  touch() {
    if (this._done) return;
    const wasCounting = this.state === 'count';
    this.state = 'wait';
    this._since = this._now();
    this._shown = null;
    if (wasCounting) this._onCountdown(null);
  }

  /** @returns {number} seconds left of the countdown (countdownS while waiting) */
  remainingS() {
    if (this.state !== 'count') return this.countdownS;
    return Math.max(0, this.countdownS - (this._now() - this._since) / 1000);
  }

  tick() {
    if (this._done) return;
    const elapsed = (this._now() - this._since) / 1000;
    if (this.state === 'wait') {
      if (elapsed < this.idleS) return;
      this.state = 'count';
      this._since = this._now();
      this._shown = Math.ceil(this.countdownS);
      this._onCountdown(this._shown);
      return;
    }
    const rem = this.remainingS();
    if (rem <= 0) { this._done = true; this._onReset(); return; }
    const shown = Math.ceil(rem);
    if (shown !== this._shown) { this._shown = shown; this._onCountdown(shown); }
  }
}

/**
 * Join the end to the game.
 * @param {object} d
 * @param {{ on: Function }} d.bus                     the event bus
 * @param {{ open: Function, close: Function, isOpen: Function, setCountdown: Function }} d.card  ui/DemoEndCard (or a fake)
 * @param {Function} d.reset                           () => the New player reset (resetForNewPlayer with the page's deps)
 * @param {Function} [d.getCaught]                     () => pieces caught (scoringSystem.getStats().debrisCleared)
 * @param {{ isGameplay: Function, isPaused: Function, toggle: Function }} [d.pause]  the Esc path, as wireStillPlaying
 * @param {Function} [d.setTimeoutFn]                  default: the global setTimeout (real time, not timerManager)
 * @param {Function} [d.clearTimeoutFn]
 * @param {Function} [d.setIntervalFn]
 * @param {Function} [d.clearIntervalFn]
 * @param {Function} [d.now]
 * @param {number} [d.delayMs]                         default DEMO_END_DELAY_MS
 * @param {number} [d.idleS]
 * @param {number} [d.countdownS]
 * @param {number} [d.everyMs]                         walk-away tick, default 250
 * @returns {{ isActive: Function, isOpen: Function, open: Function, playAgain: Function, touch: Function, tick: Function }}
 */
export function wireDemoEnd(d) {
  const setT = d.setTimeoutFn || ((fn, ms) => setTimeout(fn, ms));
  const clearT = d.clearTimeoutFn || ((h) => clearTimeout(h));
  const setI = d.setIntervalFn || ((fn, ms) => setInterval(fn, ms));
  const clearI = d.clearIntervalFn || ((h) => clearInterval(h));
  const delayMs = Number.isFinite(d.delayMs) ? d.delayMs : DEMO_END_DELAY_MS;
  const everyMs = d.everyMs || 250;
  let active = false;       // from DEMO_END until the reset: other clocks (Still playing?) stand down
  let timer = null;
  let ticker = null;
  let resetDone = false;
  let walk = null;

  const stopTimers = () => {
    if (timer !== null) { clearT(timer); timer = null; }
    if (ticker !== null) { clearI(ticker); ticker = null; }
  };
  const playAgain = () => {
    if (resetDone) return;
    resetDone = true;
    stopTimers();
    d.reset();
  };
  // Pause the game behind the card; never un-pauses. Also run on every walk-away tick: the "Paused" card (FocusPauseCard) may
  // have been up when this card opened, and its next tap resumes the game behind us (FocusPauseCard.js:182-188).
  const holdPause = () => {
    const p = d.pause;
    if (p && p.isGameplay() && !p.isPaused()) p.toggle();
  };
  const open = () => {
    timer = null;
    if (!active || d.card.isOpen()) return;
    holdPause();
    walk = new DemoEndWalkAway({
      now: d.now, idleS: d.idleS, countdownS: d.countdownS,
      onCountdown: (n) => d.card.setCountdown(n),
      onReset: playAgain,
    });
    d.card.open({ caught: typeof d.getCaught === 'function' ? d.getCaught() : 0 });
    ticker = setI(() => { holdPause(); if (walk) walk.tick(); }, everyMs);
  };

  d.bus.on(Events.DEMO_END, (p) => {
    if (active) return;     // once per run
    active = true;
    resetDone = false;
    if (p && p.immediate === true) open();
    else timer = setT(open, delayMs);
  });
  // A new run (resetGame) un-ends the demo: no card waits, none stays. The pause belongs to the reset.
  d.bus.on(Events.GAME_RESET, () => {
    active = false;
    stopTimers();
    if (d.card.isOpen()) d.card.close();
    walk = null;
  });

  return {
    isActive: () => active,
    isOpen: () => d.card.isOpen(),
    open,
    playAgain,
    touch: () => { if (walk) walk.touch(); },
    tick: () => { if (walk) walk.tick(); },
  };
}

export default shouldEndDemo;
