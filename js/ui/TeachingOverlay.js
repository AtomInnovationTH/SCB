/**
 * TeachingOverlay.js — Non-blocking contextual overlay for teaching moments (ST-6.5)
 *
 * Renders a semi-transparent panel at top-center of screen with fade-in/fade-out.
 * Queues up to MAX_QUEUE_DEPTH moments; silently drops beyond that.
 * Pure DOM manipulation — no Three.js dependency.
 *
 * @module ui/TeachingOverlay
 */

import { Constants } from '../core/Constants.js';

const _hasDOM = typeof document !== 'undefined';

// ============================================================================
// TEACHING OVERLAY CLASS
// ============================================================================

export class TeachingOverlay {
  /**
   * @param {HTMLElement} [containerElement] — DOM parent (defaults to document.body)
   */
  constructor(containerElement) {
    this._container = (_hasDOM && containerElement) || (_hasDOM && document.body) || null;
    this._element = null;
    this._visible = false;
    this._queue = [];
    this._fadeOutTimer = null;
    this._holdTimer = null;
    this._disposed = false;
  }

  // --------------------------------------------------------------------------
  // PUBLIC API
  // --------------------------------------------------------------------------

  /**
   * Display a teaching moment overlay.
   * If one is already visible, queues it (up to MAX_QUEUE_DEPTH).
   * @param {{ id: string, title: string, body: string, duration: number, icon: string }} moment
   */
  show(moment) {
    if (this._disposed || !_hasDOM) return;
    if (!moment) return;

    const C = (Constants && Constants.TEACHING) || {};
    const maxQueue = C.MAX_QUEUE_DEPTH || 3;

    if (this._visible) {
      // Queue if under limit
      if (this._queue.length < maxQueue) {
        this._queue.push(moment);
      } else {
        // Silently drop — log for debug
        if (typeof console !== 'undefined') {
          console.debug(`[TeachingOverlay] Queue full (${maxQueue}), dropping moment: ${moment.id}`);
        }
      }
      return;
    }

    this._showImmediate(moment);
  }

  /**
   * Early dismiss of current overlay.
   */
  dismiss() {
    if (!_hasDOM || !this._element) return;
    this._clearTimers();
    this._fadeOut();
  }

  /**
   * Whether an overlay is currently visible.
   * @returns {boolean}
   */
  isVisible() {
    return this._visible;
  }

  /**
   * Number of moments waiting in queue.
   * @returns {number}
   */
  getQueueLength() {
    return this._queue.length;
  }

  /**
   * Cleanup DOM and timers.
   */
  dispose() {
    this._disposed = true;
    this._clearTimers();
    this._queue.length = 0;
    if (this._element && this._element.parentNode) {
      this._element.parentNode.removeChild(this._element);
    }
    this._element = null;
    this._visible = false;
  }

  // --------------------------------------------------------------------------
  // INTERNAL
  // --------------------------------------------------------------------------

  /**
   * Immediately display a moment (no queue check).
   * @param {{ id: string, title: string, body: string, duration: number, icon: string }} moment
   * @private
   */
  _showImmediate(moment) {
    const C = (Constants && Constants.TEACHING) || {};

    // Remove any leftover element
    if (this._element && this._element.parentNode) {
      this._element.parentNode.removeChild(this._element);
    }

    // Build overlay DOM
    const el = document.createElement('div');
    el.className = 'teaching-overlay';
    el.style.cssText = `
      position: fixed;
      top: ${C.OVERLAY_TOP_MARGIN_PX || 20}px;
      left: 50%;
      transform: translateX(-50%);
      max-width: ${C.OVERLAY_WIDTH_PX || 400}px;
      min-width: ${C.OVERLAY_MIN_WIDTH_PX || 280}px;
      background: ${C.OVERLAY_BG || 'rgba(0, 10, 20, 0.85)'};
      border: 1px solid ${C.OVERLAY_BORDER_COLOR || '#00ccff'};
      border-radius: 6px;
      padding: 12px 16px;
      z-index: 9000;
      pointer-events: auto;
      opacity: 0;
      transition: opacity ${(C.FADE_IN_MS || 300)}ms ease-in;
      font-family: 'Courier New', monospace;
      box-shadow: 0 0 12px rgba(0, 204, 255, 0.15);
    `;

    // Close button
    const closeBtn = document.createElement('span');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = `
      position: absolute;
      top: 4px;
      right: 8px;
      cursor: pointer;
      color: ${C.OVERLAY_BODY_COLOR || '#ccddee'};
      font-size: 16px;
      line-height: 1;
      opacity: 0.6;
    `;
    closeBtn.addEventListener('click', () => this.dismiss());
    el.appendChild(closeBtn);

    // Title row (icon + title)
    const titleRow = document.createElement('div');
    titleRow.style.cssText = `
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 6px;
    `;

    const iconSpan = document.createElement('span');
    iconSpan.textContent = moment.icon || '';
    iconSpan.style.fontSize = '16px';
    titleRow.appendChild(iconSpan);

    const titleSpan = document.createElement('span');
    titleSpan.textContent = moment.title.toUpperCase();
    titleSpan.style.cssText = `
      font-weight: bold;
      color: ${C.OVERLAY_TITLE_COLOR || '#00ccff'};
      font-size: 14px;
      letter-spacing: 0.05em;
    `;
    titleRow.appendChild(titleSpan);
    el.appendChild(titleRow);

    // Body text
    const bodyP = document.createElement('p');
    bodyP.textContent = moment.body;
    bodyP.style.cssText = `
      margin: 0;
      color: ${C.OVERLAY_BODY_COLOR || '#ccddee'};
      font-size: 12px;
      line-height: 1.4;
    `;
    el.appendChild(bodyP);

    // Attach to DOM
    this._element = el;
    this._container.appendChild(el);
    this._visible = true;

    // Fade in (force reflow first)
    void el.offsetHeight;
    el.style.opacity = '1';

    // Auto-dismiss after duration
    const duration = moment.duration || C.DEFAULT_DURATION_MS || 7000;
    const fadeOutMs = C.FADE_OUT_MS || 500;

    this._holdTimer = setTimeout(() => {
      this._fadeOut();
    }, duration);
  }

  /**
   * Fade out the current element and process queue.
   * @private
   */
  _fadeOut() {
    if (!this._element) return;

    const C = (Constants && Constants.TEACHING) || {};
    const fadeOutMs = C.FADE_OUT_MS || 500;

    this._element.style.transition = `opacity ${fadeOutMs}ms ease-out`;
    this._element.style.opacity = '0';

    this._fadeOutTimer = setTimeout(() => {
      if (this._element && this._element.parentNode) {
        this._element.parentNode.removeChild(this._element);
      }
      this._element = null;
      this._visible = false;

      // Process next in queue
      if (this._queue.length > 0 && !this._disposed) {
        const next = this._queue.shift();
        this._showImmediate(next);
      }
    }, fadeOutMs);
  }

  /**
   * Clear all pending timers.
   * @private
   */
  _clearTimers() {
    if (this._holdTimer) {
      clearTimeout(this._holdTimer);
      this._holdTimer = null;
    }
    if (this._fadeOutTimer) {
      clearTimeout(this._fadeOutTimer);
      this._fadeOutTimer = null;
    }
  }
}

// CJS guard — expose queue logic for Node.js tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TeachingOverlay };
}

export default TeachingOverlay;
