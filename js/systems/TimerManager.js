/**
 * TimerManager.js — Centralized setTimeout / setInterval registry.
 *
 * Why this exists (PR 5 / P2.8):
 *   Raw setTimeout/setInterval calls scattered across ~70 sites in the
 *   codebase made it impossible to (a) reason about teardown, (b) clear
 *   timers when a GameState transition invalidates them, or (c) audit
 *   for leaks. Symptoms included: stale toast removers firing after
 *   state changes, intervals still ticking after game-over, and dev-mode
 *   reset leaving zombie callbacks alive.
 *
 * What this provides:
 *   - Tagged timers (owner ref + GameState string) for grouped clearing.
 *   - Auto-removal from registry when a one-shot timeout fires.
 *   - Subscribes to Events.STATE_CHANGE so timers tagged with `state: X`
 *     are auto-cleared when the FSM leaves X. (Payload shape verified
 *     against GameState.setState() — { from, to, payload }.)
 *   - activeCount() for leak-detection in tests.
 *
 * Migration convention:
 *   - `owner` is usually `this` (the calling instance) so a destroy
 *     handler can call TimerManager.clearByOwner(this) without tracking
 *     every individual id.
 *   - `state` is the GameStates value during which the timer is
 *     meaningful. Pass null for state-agnostic timers (audio fades,
 *     network timeouts, etc.).
 *
 * Underlying mechanism: Node's / the browser's global setTimeout/
 * setInterval. No polyfill — this module is just bookkeeping.
 *
 * @module systems/TimerManager
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

class TimerManager {
  constructor() {
    /** Monotonically increasing public id (string keys avoid integer
     *  collision with raw setTimeout handles if a caller mixes the two). */
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

    // Subscribe to the FSM's state-transition event. GameState.setState()
    // emits Events.STATE_CHANGE with payload { from, to, payload }; we
    // clear every timer tagged with state === payload.from.
    //
    // Note: we listen via eventBus rather than a direct GameState import
    // to keep this module decoupled from the FSM's class shape.
    this._stateUnsub = eventBus.on(Events.STATE_CHANGE, (data) => {
      if (data && typeof data.from === 'string') {
        this.clearByState(data.from);
      }
    });
  }

  /**
   * Schedule a one-shot callback. Auto-removes from registry on fire.
   * @param {Function} cb
   * @param {number} ms
   * @param {{ state?: string|null, owner?: any }} [opts]
   * @returns {number} timer id (pass to clear())
   */
  setTimeout(cb, ms, opts = {}) {
    const { state = null, owner = null } = opts;
    const id = this._next++;
    const handle = setTimeout(() => {
      // Mark fired and remove BEFORE calling user code so re-entrant
      // clear(id) / clearByOwner(this) inside cb is a no-op (not a double-clear).
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
   * Schedule a repeating callback. Persists until explicitly cleared.
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
   * Cancel a single timer by id. Safe to call with stale/unknown ids.
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
   * Clear every timer tagged with the given state string.
   * Called automatically on STATE_CHANGE for `from` state; callers may
   * also invoke explicitly during teardown.
   * @param {string} state
   * @returns {number} count cleared
   */
  clearByState(state) {
    if (state == null) return 0;
    let n = 0;
    // Snapshot ids first — Map.delete inside iteration is technically
    // safe in modern JS but the snapshot is clearer and avoids any
    // engine-specific ordering edge cases.
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
   * Clear every timer owned by the given ref. Compared with === so the
   * caller can pass `this` (instance), a module sentinel, or a string tag.
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
   * Cancel every registered timer. Use for hard shutdown / test reset.
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
   * Number of live (un-fired, un-cleared) timers. Primarily for tests
   * and dev-overlay leak detection.
   * @returns {number}
   */
  activeCount() {
    return this._timers.size;
  }
}

/** Singleton — import default for consumers. */
const timerManager = new TimerManager();
export { TimerManager };
export default timerManager;
