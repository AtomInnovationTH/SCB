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
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { decorateGlossary } from '../systems/codex/glossary.js';
import { ensureGlossaryCss, delegateGlossaryClicks } from './glossaryDom.js';
import { GestureHints } from './hud/GestureHints.js';
import { VisualLaw } from '../core/VisualLaw.js';

const _hasDOM = typeof document !== 'undefined';

// ============================================================================
// PLACEMENT (u13-polish D1) — pure, so the rule is testable without a DOM
// ============================================================================

const _vis = (r) => !!r && r.w > 0 && r.h > 0;

/**
 * Where the card goes so it never covers the text a player needs (owner 2026-10-21: the range-wall card sat on the
 * score strip). Screens at least `OVERLAY_WIDE_MIN_PX` wide only; narrower ones (phones, frozen) keep the old top margin.
 *
 * The card sits `OVERLAY_GAP_PX` below the lowest of: the score strip (its real rect; when its element is not in the page
 * (`strip: null`) the fallback `OVERLAY_STRIP_TOP_PX + OVERLAY_STRIP_H_PX * scale`), the line under the strip, the
 * collision warning (when shown) and the autopilot badge (drawn on the canvas, so passed as a flag).
 *
 * @param {object} o
 * @param {number} o.viewportW
 * @param {number} [o.scale=1]            the HUD scale (--hud-scale), 1 when none
 * @param {number} [o.cardH=100]          the card's height now
 * @param {?{x,y,w,h}} [o.strip]          #hud-score-panel rect; null = element missing; w=0 = hidden
 * @param {?{x,y,w,h}} [o.payoff]         #hud-payoff rect
 * @param {?{x,y,w,h}} [o.conj]           #hud-conjunction-panel rect
 * @param {boolean} [o.apEngaged]         the autopilot badge is up
 * @returns {{top:number, maxWidth:number, gated:boolean}}
 */
export function placeTeachingCard(o) {
  const C = (Constants && Constants.TEACHING) || {};
  const margin = C.OVERLAY_TOP_MARGIN_PX != null ? C.OVERLAY_TOP_MARGIN_PX : 20;
  const maxW = C.OVERLAY_WIDTH_PX || 400;
  const minW = C.OVERLAY_MIN_WIDTH_PX || 280;
  const wideMin = C.OVERLAY_WIDE_MIN_PX || 920;
  if (!(o.viewportW >= wideMin)) return { top: margin, maxWidth: maxW, gated: true };
  const gap = C.OVERLAY_GAP_PX != null ? C.OVERLAY_GAP_PX : 8;
  const scale = o.scale > 0 ? o.scale : 1;
  const cardH = o.cardH > 0 ? o.cardH : 100;

  let bottom = 0;
  if (o.strip == null) bottom = (C.OVERLAY_STRIP_TOP_PX != null ? C.OVERLAY_STRIP_TOP_PX : 8)
    + (C.OVERLAY_STRIP_H_PX != null ? C.OVERLAY_STRIP_H_PX : 28) * scale;
  for (const r of [o.strip, o.payoff, o.conj]) if (_vis(r)) bottom = Math.max(bottom, r.y + r.h);
  if (o.apEngaged) bottom = Math.max(bottom, C.OVERLAY_AP_BADGE_BOTTOM_PX != null ? C.OVERLAY_AP_BADGE_BOTTOM_PX : 111);
  let top = bottom > 0 ? Math.max(margin, bottom + gap) : margin;
  return { top, maxWidth: maxW, gated: false };
}

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
    // u13-polish D1: the autopilot badge is drawn on the canvas where no DOM probe sees it; mirror its on/off events
    // (the same two TargetReticle listens to) so the card can stay below it.
    this._apEngaged = false;
    this._layoutTimer = null;
    this._unsub = [];
    if (_hasDOM && eventBus && Events) {
      if (Events.AUTOPILOT_ENGAGE) this._unsub.push(eventBus.on(Events.AUTOPILOT_ENGAGE, () => { this._apEngaged = true; this._layout(); }));
      if (Events.AUTOPILOT_DISENGAGE) this._unsub.push(eventBus.on(Events.AUTOPILOT_DISENGAGE, () => { this._apEngaged = false; }));
    }
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
   * Cleanup DOM and timers.
   */
  dispose() {
    this._disposed = true;
    for (const off of this._unsub) { try { off(); } catch (_) { /* gone */ } }
    this._unsub.length = 0;
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
      border: 1px solid ${C.OVERLAY_BORDER_COLOR || VisualLaw.COLORS.INFO};
      border-radius: 6px;
      padding: 12px 16px;
      z-index: 9000;
      pointer-events: auto;
      opacity: 0;
      transition: opacity ${(C.FADE_IN_MS || 300)}ms ease-in;
      font-family: var(--font-mono);
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

    // Title row. The moment's `icon` field (a pictograph in the data) is NOT
    // rendered (Session L D-J, no pictographs in the chrome): the title alone.
    const titleRow = document.createElement('div');
    titleRow.style.cssText = `
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 6px;
    `;

    const titleSpan = document.createElement('span');
    titleSpan.textContent = moment.title.toUpperCase();
    titleSpan.style.cssText = `
      font-weight: bold;
      color: ${C.OVERLAY_TITLE_COLOR || VisualLaw.COLORS.INFO};
      font-size: 14px;
      letter-spacing: 0.05em;
    `;
    titleRow.appendChild(titleSpan);
    el.appendChild(titleRow);

    // Body text — inline glossary decorated (escapes the source, then wraps
    // jargon). Switched from textContent to innerHTML; decorateGlossary handles
    // escaping so this stays injection-safe. GestureHints.speak first: on
    // glass the stall card's "Press N to launch the net." speaks the gesture
    // (Session J item 5); off glass it returns the same string instance.
    const bodyP = document.createElement('p');
    bodyP.innerHTML = decorateGlossary(GestureHints.speak(moment.body), { once: true });
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

    // Inline-glossary affordances on this overlay instance.
    ensureGlossaryCss();
    delegateGlossaryClicks(el);

    // u13-polish D1: clear of the score strip, the collision warning, the autopilot badge
    this._layout();
    if (typeof window !== 'undefined' && typeof setInterval === 'function') {
      this._layoutTimer = setInterval(() => this._layout(), 250);   // a warning or badge that appears while the card shows
    }

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
   * Place the card (u13-polish D1): read the real rects of the things it must not cover and move it clear. Only ever
   * moves DOWN or narrows while it shows (a warning that goes away does not pull the card back up under the reader's eye).
   * No-op without a real layout (headless tests).
   * @private
   */
  _layout() {
    const el = this._element;
    if (!el || typeof window === 'undefined' || typeof el.getBoundingClientRect !== 'function') return;
    const rectOf = (id) => {
      const e = document.getElementById ? document.getElementById(id) : null;
      if (!e || typeof e.getBoundingClientRect !== 'function') return null;
      const b = e.getBoundingClientRect();
      return { x: b.left, y: b.top, w: b.width, h: b.height };
    };
    let scale = 1;
    try {
      const v = parseFloat(window.getComputedStyle(document.documentElement).getPropertyValue('--hud-scale'));
      if (v > 0) scale = v;
    } catch (_) { /* no computed style */ }
    const args = {
      viewportW: window.innerWidth, scale, apEngaged: this._apEngaged,
      strip: rectOf('hud-score-panel'), payoff: rectOf('hud-payoff'),
      conj: rectOf('hud-conjunction-panel'),
    };
    let res = placeTeachingCard({ ...args, cardH: el.getBoundingClientRect().height });
    if (res.gated) return;
    if (res.maxWidth < (parseFloat(el.style.maxWidth) || Infinity)) {
      el.style.maxWidth = `${res.maxWidth}px`;
      res = placeTeachingCard({ ...args, cardH: el.getBoundingClientRect().height });   // narrower = taller
    }
    const cur = parseFloat(el.style.top) || 0;
    el.style.top = `${Math.max(cur, res.top)}px`;
  }

  /**
   * Fade out the current element and process queue.
   * @private
   */
  _fadeOut() {
    if (!this._element) return;
    if (this._layoutTimer) { clearInterval(this._layoutTimer); this._layoutTimer = null; }

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
    if (this._layoutTimer) {
      clearInterval(this._layoutTimer);
      this._layoutTimer = null;
    }
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
