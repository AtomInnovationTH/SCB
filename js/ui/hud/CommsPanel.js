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
import { PaneChrome } from './PaneChrome.js';
import { decorateGlossary, escapeHtml } from '../../systems/codex/glossary.js';
import { ensureGlossaryCss, delegateGlossaryClicks } from '../glossaryDom.js';

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
 *
 * Semantics (per UX spec):
 *   • GREEN  — normal / info / guidance / nominal / "attaboy"
 *   • YELLOW — warning / alert / caution
 *   • RED    — danger / risk / emergency / critical
 *
 * Accepts both the canonical CommsPriority enum values (INFO/WARNING/CRITICAL)
 * AND the looser, human vocabulary that emitters across the codebase actually
 * use (mixed case: 'warning', 'critical', 'danger', 'alert', 'emergency', …).
 * Previously this only matched the exact uppercase enum, so the many lowercase
 * `priority:'warning'` emitters rendered green — defeating the colour code.
 *
 * @param {string} priority
 * @returns {string} hex colour
 */
function getPriorityColor(priority) {
  const p = String(priority || '').toLowerCase();
  // RED — danger / risk / emergency / critical
  if (p === 'critical' || p === 'danger' || p === 'emergency' ||
      p === 'risk' || p === 'fatal' || p === 'error') {
    return COMMS_COLOR_CRITICAL;
  }
  // YELLOW — warning / alert / caution
  if (p === 'warning' || p === 'warn' || p === 'alert' || p === 'caution') {
    return COMMS_COLOR_WARNING;
  }
  // GREEN — everything else (info / guidance / nominal / attaboy / '')
  return COMMS_COLOR_NORMAL;
}

/**
 * True when a message priority is in the "red" (critical/danger) band.
 * Case-insensitive and accepts the looser danger vocabulary.
 * @param {string} priority
 * @returns {boolean}
 */
function isCriticalPriority(priority) {
  return getPriorityColor(priority) === COMMS_COLOR_CRITICAL;
}

// ============================================================================
// PURE HELPERS (CJS-exportable for tests)
// ============================================================================

// (UX-11 #9 review cleanup: discriminateKeyEvent removed — the C tap/hold
// discrimination it modelled no longer exists anywhere in the input path.)

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
 * True when a comms message is a guidance instruction the player has already
 * followed (its onboarding beat id is in the satisfied set). Such a line must
 * NOT keep the "latest" attention highlight — once obeyed it should read like
 * history. Pure + exported so the de-highlight contract is testable DOM-free.
 * @param {object} msg — stored comms message (may carry `onboardingBeatId`)
 * @param {Set<string|number>} satisfiedBeatIds
 * @returns {boolean}
 */
function isFollowedInstruction(msg, satisfiedBeatIds) {
  return !!(msg && msg.onboardingBeatId != null
    && satisfiedBeatIds && satisfiedBeatIds.has(msg.onboardingBeatId));
}

// ============================================================================
// COMMS PANEL CLASS
// ============================================================================

export class CommsPanel {
  constructor(container) {
    this._container = container;
    this._commsSystem = null;
    this._commsFlashTimer = 0;

    /** @type {import('./PaneChrome.js').PaneChrome|null} 3-step size chrome */
    this._chrome = null;

    /** @type {number} Scroll offset for PageUp/PageDown review */
    this._scrollOffset = 0;

    /**
     * @type {Set<string|number>} Onboarding beat ids whose instruction the
     * player has already followed. A guidance line tagged with one of these
     * ids drops its "latest" attention highlight immediately — the moment the
     * player obeys the comms direction it stops demanding attention.
     */
    this._satisfiedBeatIds = new Set();

    /** @type {Object<string, HTMLElement>} DOM panels for show/hide */
    this.panels = {};

    /**
     * @type {import('../../systems/codex/GlossaryState.js').GlossaryState|null}
     * First-use seen-state for the inline glossary. Optional — comms still
     * decorates terms without it (every term just keeps its first-use cue).
     */
    this._glossaryState = null;

    this._build();
    this._setupListeners();
  }

  /**
   * Inject the glossary seen-state controller so first-use cues drop after a
   * term has been seen. @param {object} state GlossaryState-like
   */
  setGlossaryState(state) { this._glossaryState = state; }

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

    // Inline-glossary affordances: a one-time stylesheet for `.glossary-term`
    // and a delegated click handler that deep-links terms with a codex entry.
    ensureGlossaryCss();
    delegateGlossaryClicks(this._logEl);

    // --- Resize chrome (3-step: line / normal / large) ---
    // Clickable top-right [C] badge cycles the size; the C key also cycles via
    // _expandPane(). No "GROUND COMMS" label — keep the pane clean.
    this._chrome = new PaneChrome({
      pane: this.panels.comms,
      keyLabel: 'C',
      steps: COMMS_STEPS,
      initial: 'normal',
      color: COMMS_COLOR_NORMAL,
      title: 'Comms size (C). Click to cycle line / normal / large',
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

    // When an onboarding hint is satisfied (the player followed the direction),
    // drop the matching guidance line's attention highlight right away so it
    // stops demanding attention — without waiting for a follow-up "ack" line.
    eventBus.on(Events.HINT_SATISFIED, (d) => {
      if (!d || d.id == null) return;
      this._satisfiedBeatIds.add(d.id);
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
   * Handle an incoming comms message event. Updates the log and may trigger
   * a border flash for critical messages.
   * @param {object} msg — { text, priority, channel, … }
   */
  onMessage(msg) {
    if (isCriticalPriority(msg.priority)) {
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
   * Refresh command availability (called at 10 Hz).
   * No-op since ST-5.1; the C-hold radial menu was removed entirely (UX-11 #9).
   */
  updateMenu() {
    // Intentionally empty
  }

  /**
   * Toggle comms — ST-5.1: now a no-op for backward compatibility.
   * C-tap/hold discrimination is handled by InputManager → EventBus.
   */
  toggleComms() {
    // Legacy compatibility: expand pane on toggle
    this._expandPane();
  }

  /** @returns {boolean} Center popup fully removed (and the radial menu after it) */
  isCommsOpen() {
    return false; // Center popup fully removed
  }

  // (UX-11 #9 review cleanup: executeCommsCommand removed — the RadialMenu
  // was its only conceptual invoker and the HUD wrapper had zero callers.)

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

    // Notify layout consumers (HUD right column + NavSphere slot) that the
    // comms panel's height — and therefore its bottom edge — has changed, so
    // they can invalidate their cached comms-bottom and reflow. The panel
    // height animates over 0.3s (CSS transition), so listeners keep recomputing
    // through a short settle window rather than snapping at the end.
    eventBus.emit(Events.COMMS_PANEL_RESIZED, { step, height: h });
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
      // A satisfied onboarding instruction is no longer "demanding attention":
      // even if it's still the most-recent line, render it dimmed like history.
      const isLatest = (i === latestIdx) && !isFollowedInstruction(msg, this._satisfiedBeatIds);

      // Latest message: full-strength, subtle highlight band. Older: dimmed.
      const textOpacity = isLatest ? '1' : '0.6';
      const rowBg = isLatest ? 'rgba(255,255,255,0.06)' : 'transparent';
      const weight = (isLatest || isCriticalPriority(msg.priority)) ? '600' : '400';

      const sourceText = msg.source ? `${escapeHtml(msg.source)}: ` : '';

      // Inline glossary: wrap recognised jargon in the message body (only — never
      // the source label). The first-use cue is driven by the seen-state, and a
      // term is marked seen only when it's the freshest line the player is
      // actually reading (the latest, un-scrolled row) so history re-renders
      // don't silently burn every cue.
      const gs = this._glossaryState;
      const markSeen = isLatest && this._scrollOffset === 0;
      const body = decorateGlossary(msg.text, {
        once: true,
        isNew: gs ? (term) => gs.isNew(term) : undefined,
        onSeen: (gs && markSeen) ? (term) => gs.markSeen(term) : undefined,
      });

      return `<div style="margin:2px 0;padding:3px 6px;border-left:${COMMS.STRIPE_WIDTH_PX}px solid ${color};background:${rowBg};border-radius:2px;">
        <span style="color:${color};font-weight:600;font-size:13px;">${sourceText}</span><span style="color:${color};opacity:${textOpacity};font-weight:${weight};font-size:13px;">${body}</span>
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

export { filterRoundTrip, getPriorityColor, isCriticalPriority, isFollowedInstruction,
  COMMS_COLOR_NORMAL, COMMS_COLOR_WARNING, COMMS_COLOR_CRITICAL };

// ST-5.1: CJS guard — expose pure helpers for Node.js tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { filterRoundTrip, getPriorityColor, isCriticalPriority, isFollowedInstruction,
    COMMS_COLOR_NORMAL, COMMS_COLOR_WARNING, COMMS_COLOR_CRITICAL };
}
