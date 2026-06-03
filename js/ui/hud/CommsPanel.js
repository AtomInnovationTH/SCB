/**
 * CommsPanel.js — 6-channel colour-coded comms pane (ST-5.1)
 * Replaces monolithic 120 px log + center popup with:
 *   - ~144 px tall, ~400 px wide pane (top-right, clears NavSphere)
 *   - 6 channel filter toggles (CMD, ALERT, HOUSTON, SCI, FLAVOR, MISSION)
 *   - Left-edge colour stripe per message row
 *   - C-tap → expand pane; C-hold → radial menu (via EventBus)
 *   - PageUp/PageDown history scrolling
 * @module ui/hud/CommsPanel
 */

import { Constants } from '../../core/Constants.js';
import { eventBus } from '../../core/EventBus.js';
import { Events } from '../../core/Events.js';
import { CommsPriority } from '../../systems/CommsSystem.js';
import { PaneChrome } from './PaneChrome.js';

const COMMS = Constants.COMMS;

// 3-step sizes for the comms pane: a 1-line strip, the normal 4-line log, and
// the large 10-line review. Heights are resolved from COMMS constants below.
const COMMS_STEPS = ['line', 'normal', 'large'];

// ----------------------------------------------------------------------------
// SIMPLIFIED 3-COLOUR PALETTE (priority-based, not per-channel)
// Keeps the pane easy to scan: green = normal, amber = warning, red = critical.
// ----------------------------------------------------------------------------
const COMMS_COLOR_NORMAL = '#00ff88';   // green  — info / nominal
const COMMS_COLOR_WARNING = '#ffaa00';  // amber  — warnings
const COMMS_COLOR_CRITICAL = '#ff4444'; // red    — critical / alerts

/**
 * Map a message priority to one of the 3 palette colours.
 * @param {string} priority
 * @returns {string} hex colour
 */
function getPriorityColor(priority) {
  if (priority === CommsPriority.CRITICAL) return COMMS_COLOR_CRITICAL;
  if (priority === CommsPriority.WARNING) return COMMS_COLOR_WARNING;
  return COMMS_COLOR_NORMAL;
}

// ============================================================================
// PURE HELPERS (CJS-exportable for tests)
// ============================================================================

/**
 * Discriminate between tap and hold based on timestamps.
 * @param {number} downTs — keydown timestamp (ms)
 * @param {number} upTs — keyup timestamp (ms)
 * @param {number} [threshold] — hold threshold in ms (default COMMS.C_HOLD_THRESHOLD_MS)
 * @returns {'tap'|'hold'}
 */
function discriminateKeyEvent(downTs, upTs, threshold) {
  const t = threshold != null ? threshold : COMMS.C_HOLD_THRESHOLD_MS;
  return (upTs - downTs) >= t ? 'hold' : 'tap';
}

/**
 * Round-trip filter state through JSON (for persistence testing).
 * Missing channels default to true.
 * @param {object} filters — partial filter map
 * @returns {object} — complete filter map with all 6 channels
 */
function filterRoundTrip(filters) {
  const json = JSON.stringify(filters);
  const parsed = JSON.parse(json);
  const result = {};
  for (const ch of COMMS.CHANNELS) {
    result[ch] = parsed[ch] !== undefined ? parsed[ch] : true;
  }
  return result;
}

// ============================================================================
// COMMS PANEL CLASS
// ============================================================================

export class CommsPanel {
  constructor(container) {
    this._container = container;
    this._commsSystem = null;
    this._armManager = null;
    this._commsFlashTimer = 0;

    /** @type {import('./PaneChrome.js').PaneChrome|null} 3-step size chrome */
    this._chrome = null;

    /** @type {number} Scroll offset for PageUp/PageDown review */
    this._scrollOffset = 0;

    /** @type {Object<string, HTMLElement>} DOM panels for show/hide */
    this.panels = {};

    this._build();
    this._setupListeners();
  }

  // ==========================================================================
  // BUILD DOM
  // ==========================================================================

  /** @private Create a styled HUD panel */
  _createPanel(id, styles) {
    const div = document.createElement('div');
    div.id = id;
    div.className = 'hud-panel';
    Object.assign(div.style, styles);
    this._container.appendChild(div);
    return div;
  }

  /** @private */
  _build() {
    // --- Comms Panel (top-right — fixed size, UX-2 #11) ---
    this.panels.comms = this._createPanel('hud-comms-panel', {
      top: '10px',
      right: '10px',
      width: `${COMMS.PANE_WIDTH_PX}px`,
      height: `${COMMS.PANE_HEIGHT_PX}px`,
      overflowY: 'hidden',
      transition: 'height 0.3s ease, border-color 0.3s ease',
    });
    this.panels.comms.dataset.hudGroup = 'manage_comms';
    // Comms panel starts active — messages arrive from boot sequence immediately.
    // Skill discovery (COMMS_OPENED) still fires for progression tracking.
    this.panels.comms.classList.add('hud-active');

    // --- Log container ---
    this._logEl = document.createElement('div');
    this._logEl.id = 'hud-comms-log';
    Object.assign(this._logEl.style, {
      fontSize: '13px',
      lineHeight: '1.45',
      overflowY: 'auto',
      height: `${COMMS.PANE_HEIGHT_PX - 12}px`,
      transition: 'height 0.3s ease',
    });

    this.panels.comms.appendChild(this._logEl);

    // --- Resize chrome (3-step: line / normal / large) ---
    // Clickable top-right [C] badge cycles the size; the C key also cycles via
    // _expandPane(). No "GROUND COMMS" label — keep the pane clean.
    this._chrome = new PaneChrome({
      pane: this.panels.comms,
      keyLabel: 'C',
      steps: COMMS_STEPS,
      initial: 'normal',
      color: COMMS_COLOR_NORMAL,
      title: 'Comms size (C) — click to cycle line / normal / large',
      onStep: () => this._applyCommsStep(),
    });
  }

  // ==========================================================================
  // EVENT LISTENERS
  // ==========================================================================

  /** @private */
  _setupListeners() {
    // C-tap → expand pane temporarily
    eventBus.on(Events.COMMS_FOCUS, () => {
      this._expandPane();
    });

    // PageUp / PageDown history scrolling
    eventBus.on(Events.COMMS_SCROLL_UP, () => {
      this._scrollOffset = Math.min(this._scrollOffset + 3, this._getMaxScroll());
      this._updateCommsPanel();
    });

    eventBus.on(Events.COMMS_SCROLL_DOWN, () => {
      this._scrollOffset = Math.max(this._scrollOffset - 3, 0);
      this._updateCommsPanel();
    });
  }

  // ==========================================================================
  // PUBLIC
  // ==========================================================================

  /**
   * Set the CommsSystem reference.
   * @param {import('../../systems/CommsSystem.js').CommsSystem} commsSystem
   */
  setCommsSystem(commsSystem) {
    this._commsSystem = commsSystem;
  }

  /**
   * Set the ArmManager reference (for RadialMenu gating).
   * @param {import('../../entities/ArmManager.js').ArmManager} armManager
   */
  setArmManager(armManager) {
    this._armManager = armManager;
  }

  /**
   * Handle an incoming comms message event. Updates the log and may trigger
   * a border flash for critical messages.
   * @param {object} msg — { text, priority, channel, … }
   */
  onMessage(msg) {
    if (msg.priority === CommsPriority.CRITICAL) {
      this._commsFlashTimer = 3.0;
    }
    this._scrollOffset = 0; // reset scroll on new message
    this._updateCommsPanel();
  }

  /**
   * Per-frame update — drives the comms panel flash timer.
   * @param {number} dt — delta time
   */
  update(dt) {
    if (this._commsFlashTimer > 0) {
      this._commsFlashTimer -= dt;
      const flash = Math.sin(Date.now() * 0.01) > 0;
      this.panels.comms.style.borderColor = flash ? 'rgba(255,68,68,0.7)' : 'rgba(255,68,68,0.3)';
      if (this._commsFlashTimer <= 0) {
        const step = this._chrome ? this._chrome.step : 'normal';
        this.panels.comms.style.borderColor = (step === 'large')
          ? 'rgba(0, 255, 255, 1.0)' : 'rgba(0,255,136,0.3)';
      }
    }
  }

  /**
   * Refresh radial menu command availability (called at 10 Hz).
   * ST-5.1: No-op — radial menu handles its own gating on open.
   */
  updateMenu() {
    // Intentionally empty — gating moved to RadialMenu
  }

  /**
   * Toggle comms — ST-5.1: now a no-op for backward compatibility.
   * C-tap/hold discrimination is handled by InputManager → EventBus.
   */
  toggleComms() {
    // Legacy compatibility: expand pane on toggle
    this._expandPane();
  }

  /** @returns {boolean} ST-5.1: radial menu open state is on RadialMenu, not here */
  isCommsOpen() {
    return false; // Center popup fully removed
  }

  /**
   * Execute a numbered comms command (1-6).
   * Ported from old popup — now invoked by RadialMenu via EventBus.
   * @param {number} num — Command number (1-6)
   */
  executeCommsCommand(num) {
    switch (num) {
      case 1:
        eventBus.emit(Events.ARM_DEPLOY, { preferType: 'weaver' });
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: 'Deploy Weaver — executing',
          priority: 'info',
          source: 'COMMS',
          channel: 'CMD',
        });
        break;
      case 2:
        eventBus.emit(Events.ARM_DEPLOY, { preferType: 'spinner' });
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: 'Deploy Spinner — executing',
          priority: 'info',
          source: 'COMMS',
          channel: 'CMD',
        });
        break;
      case 3:
        eventBus.emit(Events.ARM_FISH);
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: 'Fish mode — casting all',
          priority: 'info',
          source: 'COMMS',
          channel: 'CMD',
        });
        break;
      case 4:
        eventBus.emit(Events.ARM_RECALL_ALL);
        break;
      case 5:
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: 'Use P key to toggle ARM PILOT mode',
          priority: 'info',
          source: 'COMMS',
          channel: 'CMD',
        });
        break;
      case 6:
        eventBus.emit(Events.ARM_DEORBIT_CMD);
        break;
      default:
        return;
    }
  }

  /** Clean up DOM elements. */
  dispose() {
    // No center popup to remove (ST-5.1: _buildCommsMenu deleted)
  }

  // ==========================================================================
  // PRIVATE
  // ==========================================================================

  /** @private C-tap cycles the pane size (line → normal → large → line). */
  _expandPane() {
    if (this._chrome) this._chrome.cycle();
  }

  /** @private Resolve the pane/log height for the current step. */
  _applyCommsStep() {
    const step = this._chrome ? this._chrome.step : 'normal';
    let h;
    if (step === 'line') h = COMMS.PANE_HEIGHT_MIN_PX;
    else if (step === 'large') h = COMMS.PANE_EXPAND_HEIGHT_PX;
    else h = COMMS.PANE_HEIGHT_PX;

    this.panels.comms.style.height = `${h}px`;
    this._logEl.style.height = `${h - 12}px`;

    // Brighter border when enlarged beyond normal; default otherwise.
    if (this._commsFlashTimer <= 0) {
      this.panels.comms.style.borderColor = (step === 'large')
        ? 'rgba(0, 255, 255, 1.0)'
        : 'rgba(0,255,136,0.3)';
    }

    // Re-render so the visible line count matches the new height.
    this._updateCommsPanel();
  }

  /** @private Visible line count for the current size step. */
  _visibleLineCount() {
    const step = this._chrome ? this._chrome.step : 'normal';
    if (step === 'line') return COMMS.PANE_LINES_MIN;
    if (step === 'large') return COMMS.PANE_LINES_EXPANDED;
    return COMMS.PANE_LINES_DEFAULT;
  }

  /** @private Get max scroll offset */
  _getMaxScroll() {
    const total = this._commsSystem ? this._commsSystem.getMessages().length : 0;
    return Math.max(0, total - this._visibleLineCount());
  }

  /** @private Update the comms panel log display */
  _updateCommsPanel() {
    if (!this._logEl) return;

    const allMessages = this._commsSystem ? this._commsSystem.getMessages() : [];

    if (allMessages.length === 0) {
      this._logEl.innerHTML = `<span style="opacity:0.4;font-size:13px;">Awaiting transmission…</span>`;
      return;
    }

    // Apply scroll offset — visible line count follows the current size step.
    const visibleCount = this._visibleLineCount();
    const end = allMessages.length - this._scrollOffset;
    const start = Math.max(0, end - visibleCount);
    const visible = allMessages.slice(start, end);

    // Index (within `visible`) of the most-recent message — highlighted unless
    // the user has scrolled up into history.
    const latestIdx = (this._scrollOffset === 0) ? visible.length - 1 : -1;

    this._logEl.innerHTML = visible.map((msg, i) => {
      const color = getPriorityColor(msg.priority);
      const isLatest = i === latestIdx;

      // Latest message: full-strength, subtle highlight band. Older: dimmed.
      const textOpacity = isLatest ? '1' : '0.6';
      const rowBg = isLatest ? 'rgba(255,255,255,0.06)' : 'transparent';
      const weight = (isLatest || msg.priority === CommsPriority.CRITICAL) ? '600' : '400';

      const sourceText = msg.source ? `${msg.source}: ` : '';

      return `<div style="margin:2px 0;padding:3px 6px;border-left:${COMMS.STRIPE_WIDTH_PX}px solid ${color};background:${rowBg};border-radius:2px;">
        <span style="color:${color};font-weight:600;font-size:13px;">${sourceText}</span><span style="color:${color};opacity:${textOpacity};font-weight:${weight};font-size:13px;">${msg.text}</span>
      </div>`;
    }).join('');

    // Auto-scroll to bottom (unless scrolled up)
    if (this._scrollOffset === 0) {
      this._logEl.scrollTop = this._logEl.scrollHeight;
    }

    // Flash border for critical messages (respect enlarged-state cyan border)
    const step = this._chrome ? this._chrome.step : 'normal';
    if (this._commsFlashTimer > 0) {
      this.panels.comms.style.borderColor = 'rgba(255,68,68,0.7)';
    } else if (step !== 'large') {
      this.panels.comms.style.borderColor = 'rgba(0,255,136,0.3)';
    }
  }
}

// ============================================================================
// NAMED EXPORTS (for tests)
// ============================================================================

export { discriminateKeyEvent, filterRoundTrip };

// ST-5.1: CJS guard — expose pure helpers for Node.js tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { discriminateKeyEvent, filterRoundTrip };
}
