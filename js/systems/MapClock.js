/**
 * MapClock.js — the map clock slider's one piece of state (owner 2026-11-18: "Floors 4-5 open at real speed ... A slider sets
 * pause / real / 10x / 100x / 1000x on the game's one clock, so everything stays in step").
 *
 * Holds the chosen step (an index into `FloorContract.TIME_RULES.MAP_CLOCK_STEPS`). The choice stays while she moves between
 * floors 4 and 5 and goes back to real speed the moment the current (or destination) floor is anywhere else, or the ladder is
 * not engaged (menu, shop, new game). The step is NOT the clock: it is one more term in the TimeAuthority target
 * (`TimeAuthority.mapClockCap`), so every hold that wins today still wins (conjunction alert, planned daughter flight, drawer).
 *
 * Pure and deterministic: no DOM, no THREE, no timers.
 * @module systems/MapClock
 */

import { FloorContract } from '../core/FloorContract.js';

const TR = FloorContract.TIME_RULES;

export class MapClock {
  constructor() {
    /** @type {number} index into MAP_CLOCK_STEPS */
    this._step = TR.MAP_CLOCK_DEFAULT;
  }

  /** @returns {number} the chosen step index */
  step() { return this._step; }

  /** @returns {{id:string, cap:number}} the chosen step row */
  stepRow() { return TR.MAP_CLOCK_STEPS[this._step]; }

  /**
   * Choose a step. Out-of-range or non-integer indexes are ignored.
   * @param {number} i
   * @returns {boolean} true when the choice changed
   */
  setStep(i) {
    if (!Number.isInteger(i) || i < 0 || i >= TR.MAP_CLOCK_STEPS.length || i === this._step) return false;
    this._step = i;
    return true;
  }

  /**
   * Called once per frame with the engaged floor (the destination during a ride), or null when the ladder is not engaged.
   * Anywhere but floors 4-5 the choice goes back to real speed.
   * @param {number|null} floorId
   */
  observeFloor(floorId) {
    if (!TR.MAP_CLOCK_FLOORS.includes(floorId)) this._step = TR.MAP_CLOCK_DEFAULT;
  }

  /**
   * The cap for a floor's row: the chosen step on floors 4-5, the floor's own timeCap elsewhere. Pure on the state.
   * @param {number|null} floorId
   * @param {number} floorCap the floor's own timeCap
   * @returns {number}
   */
  capFor(floorId, floorCap) {
    return TR.MAP_CLOCK_FLOORS.includes(floorId) ? TR.MAP_CLOCK_STEPS[this._step].cap : floorCap;
  }
}

export default MapClock;
