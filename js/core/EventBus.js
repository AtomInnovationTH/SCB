/**
 * EventBus.js — Pub/sub event system for decoupled communication
 * @module core/EventBus
 * 
 * Singleton pattern: import { eventBus } from './EventBus.js'
 */

class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
  }

  /**
   * Subscribe to an event
   * @param {string} event - Event name
   * @param {Function} callback - Handler function
   * @returns {Function} Unsubscribe function
   */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);

    // Return unsubscribe convenience function
    return () => this.off(event, callback);
  }

  /**
   * Unsubscribe from an event
   * @param {string} event - Event name
   * @param {Function} callback - The exact handler to remove
   */
  off(event, callback) {
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.delete(callback);
      if (handlers.size === 0) {
        this.listeners.delete(event);
      }
    }
  }

  /**
   * Subscribe once — auto-unsubscribes after first call
   * @param {string} event - Event name
   * @param {Function} callback - Handler function
   * @returns {Function} Unsubscribe function
   */
  once(event, callback) {
    const wrapper = (data) => {
      this.off(event, wrapper);
      callback(data);
    };
    return this.on(event, wrapper);
  }

  /**
   * Emit an event to all subscribers
   * @param {string} event - Event name
   * @param {*} [data] - Optional payload
   */
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

  /**
   * Remove all listeners for a specific event, or all events
   * @param {string} [event] - If omitted, clears everything
   */
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
