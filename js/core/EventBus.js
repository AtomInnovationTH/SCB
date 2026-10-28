/**
 * @module core/EventBus — pub/sub for decoupled communication. Singleton: `import { eventBus } from './EventBus.js'`.
 */

class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
  }

  /** Subscribe to an event. @returns {Function} unsubscribe function */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);

    return () => this.off(event, callback);
  }

  /** Unsubscribe the exact handler from an event. */
  off(event, callback) {
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.delete(callback);
      if (handlers.size === 0) {
        this.listeners.delete(event);
      }
    }
  }

  /** Subscribe once: auto-unsubscribes after the first call. @returns {Function} unsubscribe function */
  once(event, callback) {
    const wrapper = (data) => {
      this.off(event, wrapper);
      callback(data);
    };
    return this.on(event, wrapper);
  }

  /** Emit an event to all subscribers (a throwing handler is logged, not propagated). */
  emit(event, data) {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (err) {
          console.error(`[EventBus] Error in handler for "${event}":`, err);
        }
      }
    }
  }

  /** Remove all listeners for an event, or for every event when omitted. */
  clear(event) {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }
}

/** Singleton instance */
export const eventBus = new EventBus();
export default eventBus;
