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

const COMMS = Constants.COMMS;

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

/**
 * Get channel stripe colour.
 * @param {string} channel
 * @returns {string} hex colour
 */
function getChannelColor(channel) {
  return COMMS.CHANNEL_COLORS[channel] || COMMS.CHANNEL_COLORS[COMMS.DEFAULT_CHANNEL];
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

    /** @type {boolean} Whether the pane is in expanded mode (C-tap) */
    this._expanded = false;
    /** @type {number|null} Auto-collapse timer handle */
    this._expandTimer = null;

    /** @type {number} Scroll offset for PageUp/PageDown review */
    this._scrollOffset = 0;

    /** @type {Object<string, boolean>} Channel filter state (true = visible) */
    this._filters = this._loadFilters();

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

    // --- Filter bar at top ---
    const filterBar = document.createElement('div');
    filterBar.id = 'hud-comms-filters';
    Object.assign(filterBar.style, {
      display: 'flex',
      gap: '2px',
      marginBottom: '3px',
      flexWrap: 'wrap',
    });

    this._filterButtons = {};
    for (const ch of COMMS.CHANNELS) {
      const btn = document.createElement('button');
      btn.textContent = ch.slice(0, 3);
      btn.title = ch;
      Object.assign(btn.style, {
        fontFamily: "'Courier New', monospace",
        fontSize: '9px',
        padding: '1px 4px',
        border: `1px solid ${getChannelColor(ch)}`,
        borderRadius: '2px',
        background: this._filters[ch] ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.2)',
        color: this._filters[ch] ? getChannelColor(ch) : '#444',
        cursor: 'pointer',
        outline: 'none',
        letterSpacing: '0.5px',
        opacity: this._filters[ch] ? '1' : '0.4',
        transition: 'opacity 0.15s, color 0.15s',
      });
      btn.addEventListener('click', () => this._toggleFilter(ch));
      filterBar.appendChild(btn);
      this._filterButtons[ch] = btn;
    }

    // --- Header row ---
    const header = document.createElement('div');
    header.style.cssText = 'font-size:11px;margin-bottom:2px;color:#00ff88;opacity:0.7;display:flex;justify-content:space-between;align-items:center;';
    header.innerHTML = '<span>GROUND COMMS [C]</span>';
    header.appendChild(filterBar);

    // --- Log container ---
    this._logEl = document.createElement('div');
    this._logEl.id = 'hud-comms-log';
    Object.assign(this._logEl.style, {
      fontSize: '10px',
      lineHeight: '1.5',
      overflowY: 'auto',
      height: `${COMMS.PANE_HEIGHT_PX - 30}px`,
      transition: 'height 0.3s ease',
    });

    this.panels.comms.appendChild(header);
    this.panels.comms.appendChild(this._logEl);
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
        this.panels.comms.style.borderColor = this._expanded
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

  /** @private Toggle pane expand/collapse on C-tap (UX-2 #10) */
  _expandPane() {
    this._expanded = !this._expanded;

    if (this._expanded) {
      this.panels.comms.style.height = `${COMMS.PANE_EXPAND_HEIGHT_PX}px`;
      this._logEl.style.height = `${COMMS.PANE_EXPAND_HEIGHT_PX - 30}px`;
      // Brighter border when expanded
      if (this._commsFlashTimer <= 0) {
        this.panels.comms.style.borderColor = 'rgba(0, 255, 255, 1.0)';
      }
    } else {
      this._collapsePane();
    }

    this._updateCommsPanel();
  }

  /** @private Collapse pane to normal size */
  _collapsePane() {
    this._expanded = false;
    this.panels.comms.style.height = `${COMMS.PANE_HEIGHT_PX}px`;
    this._logEl.style.height = `${COMMS.PANE_HEIGHT_PX - 30}px`;
    if (this._commsFlashTimer <= 0) {
      this.panels.comms.style.borderColor = 'rgba(0,255,136,0.3)';
    }
  }

  /** @private Toggle a channel filter */
  _toggleFilter(channel) {
    this._filters[channel] = !this._filters[channel];
    this._saveFilters();
    this._updateFilterButton(channel);
    this._updateCommsPanel();
  }

  /** @private Update a filter button's visual state */
  _updateFilterButton(channel) {
    const btn = this._filterButtons[channel];
    if (!btn) return;
    const active = this._filters[channel];
    btn.style.color = active ? getChannelColor(channel) : '#444';
    btn.style.background = active ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.2)';
    btn.style.opacity = active ? '1' : '0.4';
  }

  /** @private Load filter state from localStorage */
  _loadFilters() {
    const defaults = {};
    for (const ch of COMMS.CHANNELS) defaults[ch] = true;
    try {
      const stored = localStorage.getItem(COMMS.FILTER_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        for (const ch of COMMS.CHANNELS) {
          if (parsed[ch] !== undefined) defaults[ch] = !!parsed[ch];
        }
      }
    } catch (_) { /* ignore localStorage failures */ }
    return defaults;
  }

  /** @private Save filter state to localStorage */
  _saveFilters() {
    try {
      localStorage.setItem(COMMS.FILTER_STORAGE_KEY, JSON.stringify(this._filters));
    } catch (_) { /* ignore */ }
  }

  /** @private Get max scroll offset */
  _getMaxScroll() {
    const total = this._commsSystem ? this._commsSystem.getMessages().length : 0;
    const visibleCount = this._expanded ? COMMS.PANE_LINES_EXPANDED : COMMS.PANE_LINES_DEFAULT;
    return Math.max(0, total - visibleCount);
  }

  /** @private Update the comms panel log display */
  _updateCommsPanel() {
    if (!this._logEl) return;

    const allMessages = this._commsSystem ? this._commsSystem.getMessages() : [];

    // Filter by active channels
    const filtered = allMessages.filter(msg => {
      const ch = msg.channel || COMMS.DEFAULT_CHANNEL;
      return this._filters[ch] !== false;
    });

    if (filtered.length === 0) {
      this._logEl.innerHTML = '<span style="opacity:0.4">Awaiting transmission…</span>';
      return;
    }

    // Apply scroll offset (UX-2 #11: 3 default, 10 expanded)
    const visibleCount = this._expanded ? COMMS.PANE_LINES_EXPANDED : COMMS.PANE_LINES_DEFAULT;
    const end = filtered.length - this._scrollOffset;
    const start = Math.max(0, end - visibleCount);
    const visible = filtered.slice(start, end);

    this._logEl.innerHTML = visible.map(msg => {
      const channel = msg.channel || COMMS.DEFAULT_CHANNEL;
      const stripeColor = getChannelColor(channel);

      let textColor = 'rgba(255,255,255,0.8)';
      let sourceColor = '#00ff88';
      let sourceText = `${msg.source}:`;

      // HOUSTON-specific styling — distinct mint color + arrow prefix
      const isHouston = msg.source === 'HOUSTON';
      if (isHouston) {
        sourceColor = '#88ffcc';
        textColor = '#ccffee';
        sourceText = 'HOUSTON▸';
      }

      // Priority overrides
      if (msg.priority === CommsPriority.CRITICAL) {
        sourceColor = '#ff4444';
      } else if (msg.priority === CommsPriority.WARNING) {
        sourceColor = '#ffaa00';
      }

      // ST-6.3: MOID badge prefix for conjunction messages
      let badgePrefix = '';
      if (msg._moidBadge && msg._moidBadgeColor) {
        badgePrefix = `<span style="color:${msg._moidBadgeColor};font-weight:bold;font-size:10px;">[${msg._moidBadge}]</span> `;
      }

      return `<div style="margin:1px 0;padding:1px 0 1px ${COMMS.STRIPE_WIDTH_PX + 4}px;border-bottom:1px solid rgba(0,255,136,0.05);border-left:${COMMS.STRIPE_WIDTH_PX}px solid ${stripeColor};position:relative;">
        <span style="color:${sourceColor};font-weight:${msg.priority === CommsPriority.CRITICAL ? 'bold' : 'normal'};font-size:10px;">${sourceText}</span>
        ${badgePrefix}<span style="color:${textColor};font-size:10px;">${msg.text}</span>
      </div>`;
    }).join('');

    // Auto-scroll to bottom (unless scrolled up)
    if (this._scrollOffset === 0) {
      this._logEl.scrollTop = this._logEl.scrollHeight;
    }

    // Flash border for critical messages (respect expanded-state cyan border)
    if (this._commsFlashTimer > 0) {
      this.panels.comms.style.borderColor = 'rgba(255,68,68,0.7)';
    } else if (!this._expanded) {
      this.panels.comms.style.borderColor = 'rgba(0,255,136,0.3)';
    }
  }
}

// ============================================================================
// NAMED EXPORTS (for tests)
// ============================================================================

export { discriminateKeyEvent, filterRoundTrip, getChannelColor };

// ST-5.1: CJS guard — expose pure helpers for Node.js tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { discriminateKeyEvent, filterRoundTrip, getChannelColor };
}
