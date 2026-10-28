/**
 * TimerManager.js — centralized setTimeout / setInterval registry, so timers can be torn down by owner or GameState
 * (no stale toast removers after state changes, no intervals ticking after game-over, no zombies after dev reset).
 *
 *   - Timers are tagged with an owner ref + GameState string for grouped clearing.
 *   - A one-shot timeout removes itself from the registry when it fires.
 *   - On Events.STATE_CHANGE (payload { from, to, payload }) timers tagged `state: X` clear when the FSM leaves X.
 *   - activeCount() is for leak detection in tests.
 *
 * `owner` is usually `this`, so a destroy handler can call TimerManager.clearByOwner(this).
 * `state` is the GameStates value the timer is meaningful in; null for state-agnostic timers (audio fades, network timeouts).
 * Just bookkeeping over the global setTimeout/setInterval; no polyfill.
 *
 * @module systems/TimerManager
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

class TimerManager {
  constructor() {
    /** Monotonically increasing public id. */
    this._next = 1;

    /**
     * id → {
     *   kind: 'timeout' | 'interval',
     *   handle: ReturnType<typeof setTimeout>,
     *   state: string | null,
     *   owner: object | string | null,
     *   fired: boolean,         // timeouts flip true on fire
     * }
     * @type {Map<number, object>}
     */
    this._timers = new Map();

    // Clear every timer tagged state === payload.from. Listens via eventBus, not a GameState import, to stay decoupled
    // from the FSM's class shape.
    this._stateUnsub = eventBus.on(Events.STATE_CHANGE, (data) => {
      if (data && typeof data.from === 'string') {
        this.clearByState(data.from);
      }
    });
  }

  /**
   * @param {Function} cb
   * @param {number} ms
   * @param {{ state?: string|null, owner?: any }} [opts]
   * @returns {number} timer id (pass to clear())
   */
  setTimeout(cb, ms, opts = {}) {
    const { state = null, owner = null } = opts;
    const id = this._next++;
    const handle = setTimeout(() => {
      // Mark fired and remove BEFORE user code so a re-entrant clear(id) / clearByOwner(this) in cb is a no-op.
      const entry = this._timers.get(id);
      if (entry) entry.fired = true;
      this._timers.delete(id);
      try {
        cb();
      } catch (err) {
        console.error('[TimerManager] timeout callback threw:', err);
      }
    }, ms);
    this._timers.set(id, { kind: 'timeout', handle, state, owner, fired: false });
    return id;
  }

  /**
   * Repeats until cleared.
   * @param {Function} cb
   * @param {number} ms
   * @param {{ state?: string|null, owner?: any }} [opts]
   * @returns {number} timer id
   */
  setInterval(cb, ms, opts = {}) {
    const { state = null, owner = null } = opts;
    const id = this._next++;
    const handle = setInterval(() => {
      try {
        cb();
      } catch (err) {
        console.error('[TimerManager] interval callback threw:', err);
      }
    }, ms);
    this._timers.set(id, { kind: 'interval', handle, state, owner, fired: false });
    return id;
  }

  /**
   * Safe with stale/unknown ids.
   * @param {number} id
   * @returns {boolean} true if a live timer was canceled
   */
  clear(id) {
    const entry = this._timers.get(id);
    if (!entry) return false;
    if (entry.kind === 'interval') {
      clearInterval(entry.handle);
    } else {
      clearTimeout(entry.handle);
    }
    this._timers.delete(id);
    return true;
  }

  /**
   * Called automatically on STATE_CHANGE for the `from` state; also callable in teardown.
   * @param {string} state
   * @returns {number} count cleared
   */
  clearByState(state) {
    if (state == null) return 0;
    let n = 0;
    const victims = [];
    for (const [id, entry] of this._timers) {
      if (entry.state === state) victims.push(id);
    }
    for (const id of victims) {
      if (this.clear(id)) n++;
    }
    return n;
  }

  /**
   * Owner is compared with ===: `this`, a module sentinel, or a string tag.
   * @param {any} owner
   * @returns {number} count cleared
   */
  clearByOwner(owner) {
    if (owner == null) return 0;
    let n = 0;
    const victims = [];
    for (const [id, entry] of this._timers) {
      if (entry.owner === owner) victims.push(id);
    }
    for (const id of victims) {
      if (this.clear(id)) n++;
    }
    return n;
  }

  /**
   * Hard shutdown / test reset.
   * @returns {number} count cleared
   */
  clearAll() {
    let n = 0;
    for (const [, entry] of this._timers) {
      if (entry.kind === 'interval') clearInterval(entry.handle);
      else clearTimeout(entry.handle);
      n++;
    }
    this._timers.clear();
    return n;
  }

  /**
   * Live (un-fired, un-cleared) timers; for tests and dev-overlay leak detection.
   * @returns {number}
   */
  activeCount() {
    return this._timers.size;
  }
}

const timerManager = new TimerManager();
export { TimerManager };
export default timerManager;
