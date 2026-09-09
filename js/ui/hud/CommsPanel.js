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
import { GestureHints } from './GestureHints.js';
import { decorateGlossary, escapeHtml } from '../../systems/codex/glossary.js';
import { ensureGlossaryCss, delegateGlossaryClicks } from '../glossaryDom.js';
import { TouchControls } from '../TouchControls.js';
import { RAIL_GEOMETRY } from '../RailGeometry.js';

const COMMS = Constants.COMMS;

// 3-step sizes for the comms pane: a 1-line strip, the normal 4-line log, and
// the large 10-line review. Heights are resolved from COMMS constants below.
const COMMS_STEPS = ['line', 'normal', 'large'];

// Height (px) reserved at the top of the comms pane for the gated elevator-
// contract tracker. The pane GROWS by this much when the tracker is revealed,
// so the message log keeps its full per-step height (no clipped lines).
const CONTRACT_HEADER_PX = 26;

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

/**
 * localStorage key for the player's last Comms size step (a persisted player
 * step wins the default). `_v2` (follow-up 2026-09-09, plan
 * .kilo/plans/1788926404388-hud-followups-0909.md §1.13 — a ONE-TIME RESET):
 * ladder reorder rev 3 introduced this persistence together with the `'line'`
 * ladder default, but until 2026-09-09 `_applyCommsStep` read `this._chrome`
 * from INSIDE PaneChrome's constructor callback (still null → 'normal'), so
 * every boot sized the pane at 144 whatever the step said — "two lines in a
 * four-line box". Any step a player cycled to while fighting that box must not
 * outlive the fix; the old key is simply never read again.
 */
const COMMS_STEP_STORE_KEY = 'spacecowboy_comms_pane_step_v2';

/**
 * Glass: ctor `glass` wins; else GestureHints.isGlass(); else detectGlass().
 * Plan Task 6 / locked #13 — [7] badge 44 px hit on glass only.
 * @param {boolean|null|undefined} explicit
 * @returns {boolean}
 */
function resolveGlass(explicit) {
  if (explicit === true) return true;
  if (explicit === false) return false;
  try { if (GestureHints.isGlass()) return true; } catch (_e) { /* headless */ }
  try { return TouchControls.detectGlass(); } catch (_e) { return false; }
}

/**
 * Initial Comms size step. A persisted player step wins; else `'line'` under
 * the ladder gate (rev 3 — the right arm's top follows it) and `'normal'`
 * with the gate off (`?ladder=0`).
 * @param {{ladderEnabled?: boolean, stored?: string|null}} [opts]
 * @returns {string}
 */
export function commsInitialStep({ ladderEnabled, stored } = {}) {
  let persisted = stored;
  if (persisted === undefined) {
    try {
      persisted = (typeof localStorage !== 'undefined')
        ? localStorage.getItem(COMMS_STEP_STORE_KEY) : null;
    } catch (_e) { persisted = null; }
  }
  if (persisted && COMMS_STEPS.includes(persisted)) return persisted;
  const gated = ladderEnabled !== undefined
    ? ladderEnabled : !!(Constants.LADDER && Constants.LADDER.ENABLED);
  if (gated) return Constants.COMMS.PANE_STEP_DEFAULT || 'line';
  return 'normal';
}

/**
 * 44 px hit box on the [7] badge (Apple HIG / RAIL_GEOMETRY.TOUCH_PITCH_PX).
 * No-op off glass.
 * @param {HTMLElement|null} badge
 * @param {boolean} glass
 */
export function applyCommsBadgeHit(badge, glass) {
  if (!badge || !badge.style || !glass) return;
  const px = `${RAIL_GEOMETRY.TOUCH_PITCH_PX}px`;
  badge.style.minWidth = px;
  badge.style.minHeight = px;
  badge.style.display = 'flex';
  badge.style.alignItems = 'center';
  badge.style.justifyContent = 'center';
  badge.style.boxSizing = 'border-box';
}

// ============================================================================
// COMMS PANEL CLASS
// ============================================================================

export class CommsPanel {
  /**
   * @param {HTMLElement} container
   * @param {{ glass?: boolean|null }} [opts]  `glass` — Task 6: 44 px [7] badge hit.
   */
  constructor(container, { glass = null } = {}) {
    this._container = container;
    this._glass = resolveGlass(glass);
    this._commsSystem = null;
    this._commsFlashTimer = 0;

    /** @type {import('./PaneChrome.js').PaneChrome|null} 3-step size chrome */
    this._chrome = null;
    /** @type {string|null} the last size step APPLIED (valid before `_chrome` exists — see `_currentStep`) */
    this._commsStep = null;

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
    // Follow-up 2026-09-09 (§1.14): flush with the right arm — `right` is the
    // ONE inset every other edge uses (HUD_EDGE_PX 16; was 10, 6 px outboard).
    this.panels.comms = this._createPanel('hud-comms-panel', {
      top: '10px',
      right: `${RAIL_GEOMETRY.HUD_EDGE_PX}px`,
      width: `${COMMS.PANE_WIDTH_PX}px`,
      height: `${COMMS.PANE_HEIGHT_PX}px`,
      overflowY: 'hidden',
      transition: 'height 0.3s ease, border-color 0.3s ease',
    });
    this.panels.comms.dataset.hudGroup = 'manage_comms';
    // Comms panel starts active — messages arrive from boot sequence immediately.
    // Skill discovery (COMMS_OPENED) still fires for progression tracking.
    this.panels.comms.classList.add('hud-active');

    // --- Elevator-contract tracker (gated header) ---
    // The slow, shop-driven 10,000 kg endgame objective. Hidden until the player
    // makes their first contribution (CONTRACT_UPDATE with contractMassKg > 0),
    // then revealed here at the TOP of the comms pane — grouping the long-game
    // objective with the channel that narrates its milestones. Starts
    // display:none so a new pilot never sees a static, unreachable 0/10,000 in
    // the always-bright score strip. Reused ids (hud-anchor-mass/-target) keep
    // continuity with the former score-strip segment.
    this._contractVisible = false;
    this._contractEl = document.createElement('div');
    this._contractEl.id = 'hud-contract-tracker';
    Object.assign(this._contractEl.style, {
      display: 'none',
      boxSizing: 'border-box',
      height: `${CONTRACT_HEADER_PX}px`,
      paddingBottom: '5px',
      borderBottom: '1px solid rgba(129,199,132,0.18)',
      alignItems: 'center',
      gap: '7px',
      whiteSpace: 'nowrap',
      fontSize: '11px',
      color: '#81c784',
    });
    this._contractEl.innerHTML = `
      <span style="font-size:10px;letter-spacing:0.08em;opacity:0.7;text-transform:uppercase;">Anchor contract</span>
      <span><b id="hud-anchor-mass" style="font-variant-numeric:tabular-nums;">0</b><span style="opacity:0.5;">/</span><b id="hud-anchor-target" style="font-variant-numeric:tabular-nums;">10,000</b><span style="opacity:0.7;"> kg</span></span>
      <span style="flex:1;height:3px;background:rgba(129,199,132,0.2);border-radius:2px;overflow:hidden;margin-right:22px;">
        <span id="hud-contract-fill" style="display:block;width:0%;height:100%;background:#81c784;transition:width 0.4s ease;"></span>
      </span>
    `;
    this.panels.comms.appendChild(this._contractEl);

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
    // Clickable top-right [7] badge cycles the size; the 7 key also cycles via
    // _expandPane(). No "GROUND COMMS" label — keep the pane clean.
    this._chrome = new PaneChrome({
      pane: this.panels.comms,
      keyLabel: '7',
      steps: COMMS_STEPS,
      initial: commsInitialStep(),
      color: COMMS_COLOR_NORMAL,
      title: 'Comms size (7). Click to cycle line / normal / large',
      onStep: (step) => {
        // PaneChrome applies the initial step from INSIDE its constructor, so
        // on that first call `this._chrome` is still null — the step MUST come
        // from the callback (follow-up 2026-09-09 §1.13: reading `this._chrome`
        // here fell back to 'normal' and sized every boot at 144 px while the
        // badge said 'line' — "two lines in a four-line box").
        this._applyCommsStep(step);
        if (this._commsStepReady) {
          try { localStorage.setItem(COMMS_STEP_STORE_KEY, step); } catch (_e) { /* private mode */ }
        }
      },
    });
    this._commsStepReady = true;
    if (this.panels.comms && this.panels.comms.querySelector) {
      applyCommsBadgeHit(this.panels.comms.querySelector('.hud-pane-badge'), this._glass);
    }
  }

  // ==========================================================================
  // EVENT LISTENERS
  // ==========================================================================

  /** @private */
  _setupListeners() {
    // 7-tap → expand pane temporarily
    eventBus.on(Events.COMMS_FOCUS, () => {
      // 7 always re-reveals the comms pane, even when the pane-density ladder
      // (−) hid it — clear the density flag before expanding.
      if (this.panels.comms) this.panels.comms.removeAttribute('data-density-hidden');
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

    // Elevator-contract tracker — gated header atop the comms pane (replaces the
    // former always-on score-strip segment). Reveals on first contribution.
    eventBus.on(Events.CONTRACT_UPDATE, (data) => this._onContractUpdate(data));
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
      // Calm-HUD: hold a steady red border for the critical window — the red
      // already carries severity; the old 1.59 Hz square-wave strobe was the
      // live JS twin of the .comms-flash class removed in the Phase 1 pass.
      this.panels.comms.style.borderColor = 'rgba(255,68,68,0.7)';
      if (this._commsFlashTimer <= 0) {
        const step = this._currentStep();
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

  /**
   * @private The current size step: PaneChrome's once it exists (the state
   * owner), else the last step APPLIED (`_applyCommsStep` records it — right
   * while PaneChrome is still constructing and `this._chrome` is null), else
   * 'normal'.
   */
  _currentStep() {
    if (this._chrome && COMMS_STEPS.includes(this._chrome.step)) return this._chrome.step;
    if (this._commsStep && COMMS_STEPS.includes(this._commsStep)) return this._commsStep;
    return 'normal';
  }

  /**
   * @private Resolve the pane/log height for the current step.
   * @param {string} [stepArg] the step PaneChrome just applied (its `onStep`
   *   argument) — passed explicitly because the initial call arrives from
   *   inside PaneChrome's constructor, before `this._chrome` exists.
   */
  _applyCommsStep(stepArg) {
    const step = COMMS_STEPS.includes(stepArg) ? stepArg : this._currentStep();
    this._commsStep = step;
    let h;
    if (step === 'line') h = COMMS.PANE_HEIGHT_MIN_PX;
    else if (step === 'large') h = COMMS.PANE_EXPAND_HEIGHT_PX;
    else h = COMMS.PANE_HEIGHT_PX;

    // The log keeps its full per-step height; the pane grows by the contract
    // header (when revealed) so revealing the tracker never clips messages.
    const logH = h - 12;
    const panelH = h + (this._contractVisible ? CONTRACT_HEADER_PX : 0);
    this.panels.comms.style.height = `${panelH}px`;
    this._logEl.style.height = `${logH}px`;

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

  /**
   * @private Update the gated elevator-contract tracker. Reveals the header the
   * first time the player has contributed mass (contractMassKg > 0) and keeps it
   * shown thereafter. On reveal the comms pane grows by CONTRACT_HEADER_PX so the
   * message log keeps its full height (COMMS_PANEL_RESIZED reflows the column).
   * @param {object} data — { contractMassKg, targetMassKg }
   */
  _onContractUpdate(data) {
    if (!data || typeof data.contractMassKg !== 'number') return;
    const mass = data.contractMassKg;
    const target = data.targetMassKg
      || (Constants.ELEVATOR_CONTRACT && Constants.ELEVATOR_CONTRACT.TARGET_MASS_KG) || 10000;

    const massEl = document.getElementById('hud-anchor-mass');
    const targetEl = document.getElementById('hud-anchor-target');
    const fillEl = document.getElementById('hud-contract-fill');
    if (massEl) massEl.textContent = mass.toFixed(0);
    if (targetEl) targetEl.textContent = target.toLocaleString();
    if (fillEl && target > 0) {
      fillEl.style.width = `${Math.min(100, (mass / target) * 100)}%`;
    }
    // Color intensity: muted below 50 %, brighter above (mirrors the old strip).
    if (this._contractEl && target > 0) {
      const c = (mass / target) > 0.5 ? '#a5d6a7' : '#81c784';
      this._contractEl.style.color = c;
      if (fillEl) fillEl.style.background = c;
    }

    // Gate: reveal once the contract is actually in play, then keep it shown.
    if (mass > 0 && !this._contractVisible) {
      this._contractVisible = true;
      if (this._contractEl) this._contractEl.style.display = 'flex';
      // Grow the pane to fit the header without stealing log height, and notify
      // the layout (NavSphere slot + right-hand pane column) to reflow.
      this._applyCommsStep();
    }
  }

  /** @private Visible line count for the current size step. */
  _visibleLineCount() {
    const step = this._currentStep();
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
      const weight = (isLatest || isCriticalPriority(msg.priority)) ? '700' : '400';

      const sourceText = msg.source ? `${escapeHtml(msg.source)}: ` : '';

      // Inline glossary: wrap recognised jargon in the message body (only — never
      // the source label). The first-use cue is driven by the seen-state, and a
      // term is marked seen only when it's the freshest line the player is
      // actually reading (the latest, un-scrolled row) so history re-renders
      // don't silently burn every cue. A message carrying a `link`
      // (`{ term, entryId, anchor? }`, copied by CommsSystem's listener — the
      // FURNACE gag's "manual", plan 1788957399035 §7.26) gets its first
      // whole-word `term` wrapped as a SPECS deep link over the SAME span class
      // and the SAME click delegation as every glossary term.
      const gs = this._glossaryState;
      const markSeen = isLatest && this._scrollOffset === 0;
      const body = decorateGlossary(msg.text, {
        once: true,
        isNew: gs ? (term) => gs.isNew(term) : undefined,
        onSeen: (gs && markSeen) ? (term) => gs.markSeen(term) : undefined,
        links: msg.link ? [msg.link] : undefined,
      });

      return `<div style="margin:2px 0;padding:3px 6px;border-left:${COMMS.STRIPE_WIDTH_PX}px solid ${color};background:${rowBg};border-radius:2px;">
        <span style="color:${color};font-weight:700;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;">${sourceText}</span><span style="color:${color};opacity:${textOpacity};font-weight:${weight};font-size:13px;">${body}</span>
      </div>`;
    }).join('');

    // Auto-scroll to bottom (unless scrolled up)
    if (this._scrollOffset === 0) {
      this._logEl.scrollTop = this._logEl.scrollHeight;
    }

    // Flash border for critical messages (respect enlarged-state cyan border)
    const step = this._currentStep();
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
