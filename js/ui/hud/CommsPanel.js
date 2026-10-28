/**
 * CommsPanel.js — the colour-coded comms pane: left-edge colour stripe per message row, the 7 key cycles the
 * size (line / normal / large), PageUp/PageDown history scrolling.
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
import { PANE_CORNER_PX } from '../RailGeometry.js';
import { VITALS_COLLAPSED_HEIGHT_PX } from './VitalsPane.js';

const COMMS = Constants.COMMS;

// Sizes: a 1-line strip, the normal 4-line log, the large 10-line review (heights from COMMS constants).
const COMMS_STEPS = ['line', 'normal', 'large'];

// Height (px) the pane GROWS by when the gated elevator-contract tracker is revealed, so the log keeps its full height.
const CONTRACT_HEADER_PX = 26;

// One rendered message row (the template in `_updateCommsPanel`): margin 2 px 0, padding 3 px 6 px. The trim and the
// tall-row clamp read the same numbers, so the markup and the arithmetic cannot drift apart.
const ROW_MARGIN_Y_PX = 2;
const ROW_PAD_Y_PX = 3;
// Row line height where there is no getComputedStyle (node tests): 13 px body x 1.45.
const ROW_LINE_HEIGHT_FALLBACK_PX = 13 * 1.45;
// COMMS_SCROLL_UP / _DOWN move the window by at most this many messages (fewer when fewer rows are shown).
const SCROLL_STEP_MAX = 3;
// The panel's own display list holds at most as many rows as CommsSystem's store (its MAX_MESSAGES).
const SHOWN_MAX = 20;
// A float sum of frame times can land a hair under the limit; this slack never lets a line leave early in play.
const SHOW_TIME_SLACK_S = 1e-6;

// 3-colour palette by priority: green = normal, amber = warning, red = critical.
const COMMS_COLOR_NORMAL = 'var(--hud-normal, #00ff88)';   // green  — info / nominal
const COMMS_COLOR_WARNING = 'var(--hud-caution, #ffaa00)';  // amber  — warnings
const COMMS_COLOR_CRITICAL = 'var(--hud-warning, #ff4444)'; // red    — critical / alerts

/**
 * Map a message priority to one of the 3 palette colours (green normal / yellow warning / red critical).
 * Accepts both the CommsPriority enum values (INFO/WARNING/CRITICAL) AND the looser mixed-case vocabulary
 * emitters actually use ('warning', 'danger', 'alert', 'emergency', …).
 * @param {string} priority
 * @returns {string} CSS colour
 */
function getPriorityColor(priority) {
  const p = String(priority || '').toLowerCase();
  if (p === 'critical' || p === 'danger' || p === 'emergency' ||
      p === 'risk' || p === 'fatal' || p === 'error') {
    return COMMS_COLOR_CRITICAL;
  }
  if (p === 'warning' || p === 'warn' || p === 'alert' || p === 'caution') {
    return COMMS_COLOR_WARNING;
  }
  return COMMS_COLOR_NORMAL;
}

/** True when a message priority is in the "red" (critical/danger) band (case-insensitive, loose vocabulary). */
function isCriticalPriority(priority) {
  return getPriorityColor(priority) === COMMS_COLOR_CRITICAL;
}

/**
 * True for a yellow OR red line (owner: "warnings jump the queue"). Red shows at once; yellow goes to the front of the
 * queue (after the newest row's 3 s) and is never cut.
 */
function isWarningOrWorse(priority) {
  return getPriorityColor(priority) !== COMMS_COLOR_NORMAL;
}

/**
 * Round-trip filter state through JSON (for persistence testing). Missing channels default to true.
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
 * True when a comms message is a guidance instruction the player has already followed (its onboarding beat id
 * is in the satisfied set). Such a line must NOT keep the "latest" attention highlight.
 * @param {object} msg — stored comms message (may carry `onboardingBeatId`)
 */
function isFollowedInstruction(msg, satisfiedBeatIds) {
  return !!(msg && msg.onboardingBeatId != null
    && satisfiedBeatIds && satisfiedBeatIds.has(msg.onboardingBeatId));
}

/**
 * localStorage key for the player's last Comms size step (a persisted step wins the default).
 * `_v2` is a ONE-TIME RESET: steps stored under the old key came from a bug that sized every boot at 144 px;
 * the old key is never read again.
 */
const COMMS_STEP_STORE_KEY = 'spacecowboy_comms_pane_step_v2';

/** Glass: ctor `glass` wins; else GestureHints.isGlass(); else detectGlass(). */
function resolveGlass(explicit) {
  if (explicit === true) return true;
  if (explicit === false) return false;
  try { if (GestureHints.isGlass()) return true; } catch (_e) { /* headless */ }
  try { return TouchControls.detectGlass(); } catch (_e) { return false; }
}

/**
 * Initial Comms size step. A persisted player step wins; else `'line'` under the ladder gate and `'normal'`
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

export class CommsPanel {
  /**
   * @param {HTMLElement} container
   * @param {{ glass?: boolean|null }} [opts]
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

    /** @type {Set<string|number>} Onboarding beat ids whose instruction the player has already followed. */
    this._satisfiedBeatIds = new Set();

    /** @type {Object<string, HTMLElement>} DOM panels for show/hide */
    this.panels = {};

    /**
     * @type {import('../../systems/codex/GlossaryState.js').GlossaryState|null}
     * First-use seen-state for the inline glossary; optional (without it every term keeps its first-use cue).
     */
    this._glossaryState = null;

    /** @type {number} Message rows left in the log after the last render's trim (see `_scrollStep`); -1 = none yet. */
    this._shownRows = -1;
    /** @type {number} The log's last seen `offsetWidth` (only a WIDTH change re-renders); -1 = not seen yet. */
    this._logWidth = -1;
    this._logResizeObserver = null;
    this._logResizeListener = null;
    this._logResizeRaf = 0;
    this._disposed = false;

    // The panel keeps its OWN display list so every line stays on screen at least COMMS.PANE_MIN_SHOW_S seconds.
    // CommsSystem still stores (and coalesces) every line at once; the panel takes each stored object once
    // (`_taken`), queues it (`_waiting`) and moves it on to `_shown` (the rows drawn, newest last) one at a time.
    /** @type {object[]} stored comms messages waiting for their turn (oldest first) */
    this._waiting = [];
    /** @type {object[]} stored comms messages in the order they were drawn (newest last, at most SHOWN_MAX) */
    this._shown = [];
    /** @type {WeakSet<object>} stored objects already queued or shown */
    this._taken = new WeakSet();
    /** @type {number} real seconds since the newest row was drawn; Infinity = nothing on screen yet (the first line is at once) */
    this._sinceShown = Infinity;
    /** @type {number} stored objects taken so far; 0 = the panel has never queued anything (draws the store) */
    this._intakeCount = 0;

    this._build();
    this._setupListeners();
  }

  /** Inject the glossary seen-state controller so first-use cues drop after a term has been seen. */
  setGlossaryState(state) { this._glossaryState = state; }

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
    // COMMS sits IN the top-right corner (DECISIONS §28): `top` and `right` read PANE_CORNER_PX (0), each under a
    // safe-area max so a notched screen (viewport-fit=cover in index.html's viewport meta) is cleared.
    // Rails/tabs keep HUD_EDGE_PX.
    this.panels.comms = this._createPanel('hud-comms-panel', {
      top: `max(${PANE_CORNER_PX}px, env(safe-area-inset-top))`,
      right: `max(${PANE_CORNER_PX}px, env(safe-area-inset-right))`,
      width: `var(--hud-side-w, ${COMMS.PANE_WIDTH_PX}px)`,
      height: `${COMMS.PANE_HEIGHT_PX}px`,
      overflowY: 'hidden',
      transition: 'height 0.3s ease, border-color 0.3s ease',
    });
    this.panels.comms.dataset.hudGroup = 'manage_comms';
    this.panels.comms.classList.add('hud-active');

    // Elevator-contract tracker (the 10,000 kg endgame objective): display:none until the first contribution
    // (CONTRACT_UPDATE with contractMassKg > 0), so a new pilot never sees an unreachable 0/10,000.
    this._contractVisible = false;
    this._contractEl = document.createElement('div');
    this._contractEl.id = 'hud-contract-tracker';
    Object.assign(this._contractEl.style, {
      display: 'none',
      boxSizing: 'border-box',
      height: `${CONTRACT_HEADER_PX}px`,
      paddingBottom: '5px',
      borderBottom: '1px solid rgb(var(--hud-normal-rgb, 129 199 132) / 0.18)',
      alignItems: 'center',
      gap: '7px',
      whiteSpace: 'nowrap',
      fontSize: '11px',
      color: 'var(--hud-normal, #81c784)',
    });
    this._contractEl.innerHTML = `
      <span style="font-size:10px;letter-spacing:0.08em;opacity:0.7;text-transform:uppercase;">Anchor contract</span>
      <span><b id="hud-anchor-mass" style="font-variant-numeric:tabular-nums;">0</b><span style="opacity:0.5;">/</span><b id="hud-anchor-target" style="font-variant-numeric:tabular-nums;">10,000</b><span style="opacity:0.7;"> kg</span></span>
      <span style="flex:1;height:3px;background:rgb(var(--hud-normal-rgb, 129 199 132) / 0.2);border-radius:2px;overflow:hidden;margin-right:22px;">
        <span id="hud-contract-fill" style="display:block;width:0%;height:100%;background:var(--hud-normal, #81c784);transition:width 0.4s ease;"></span>
      </span>
    `;
    this.panels.comms.appendChild(this._contractEl);

    this._logEl = document.createElement('div');
    this._logEl.id = 'hud-comms-log';
    Object.assign(this._logEl.style, {
      fontSize: '13px',
      lineHeight: '1.45',
      overflowY: 'auto',
      height: `${COMMS.PANE_HEIGHT_PX - 12}px`,
      transition: 'height 0.3s ease',
    });

    this._logEl.addEventListener('transitionend', (e) => this._onLogTransitionEnd(e));
    this.panels.comms.appendChild(this._logEl);
    this._observeLogWidth();

    // Inline glossary: one-time stylesheet + delegated click handler (deep-links terms with a codex entry).
    ensureGlossaryCss();
    delegateGlossaryClicks(this._logEl);

    // The 7 key cycles the size via _expandPane(). No "GROUND COMMS" label and no visible [7] badge
    // (the key is in the Help page and the hover tip).
    this._chrome = new PaneChrome({
      pane: this.panels.comms,
      keyLabel: '7',
      badge: false,
      steps: COMMS_STEPS,
      initial: commsInitialStep(),
      color: COMMS_COLOR_NORMAL,
      title: 'Comms size (7)',
      onStep: (step) => {
        // PaneChrome applies the initial step from INSIDE its constructor, so on that first call
        // `this._chrome` is still null: the step MUST come from the callback.
        this._applyCommsStep(step);
        if (this._commsStepReady) {
          try { localStorage.setItem(COMMS_STEP_STORE_KEY, step); } catch (_e) { /* private mode */ }
        }
      },
    });
    this._commsStepReady = true;
  }

  /** @private */
  _setupListeners() {
    eventBus.on(Events.COMMS_FOCUS, () => {
      // 7 always re-reveals the pane, even when the pane-density ladder hid it: clear the flag first.
      if (this.panels.comms) this.panels.comms.removeAttribute('data-density-hidden');
      this._expandPane();
    });

    // The step is the number of rows actually on screen (at most 3), so a trimmed window never skips a message.
    eventBus.on(Events.COMMS_SCROLL_UP, () => {
      this._scrollOffset = Math.min(this._scrollOffset + this._scrollStep(), this._getMaxScroll());
      this._updateCommsPanel();
    });

    eventBus.on(Events.COMMS_SCROLL_DOWN, () => this._scrollDown());

    // A satisfied onboarding hint drops the matching guidance line's attention highlight right away.
    eventBus.on(Events.HINT_SATISFIED, (d) => {
      if (!d || d.id == null) return;
      this._satisfiedBeatIds.add(d.id);
      this._updateCommsPanel();
    });

    eventBus.on(Events.CONTRACT_UPDATE, (data) => this._onContractUpdate(data));

    // A new game empties the queue and the rows drawn (CommsSystem empties its store on the same event).
    eventBus.on(Events.GAME_RESET, () => this._resetQueue());
  }

  /** @param {import('../../systems/CommsSystem.js').CommsSystem} commsSystem */
  setCommsSystem(commsSystem) {
    this._commsSystem = commsSystem;
  }

  /**
   * Handle an incoming comms message event: updates the log, flashes the border for a critical one.
   * @param {object} msg — { text, priority, channel, … }
   */
  onMessage(msg) {
    if (isCriticalPriority(msg.priority)) {
      this._commsFlashTimer = 3.0;
    }
    if (!this._queueReady()) {
      this._scrollOffset = 0; // reset scroll on new message
      this._updateCommsPanel();
      return;
    }
    // Take what CommsSystem stored since the last call (a text line, or the text-less repaint after a COMMS_RELEASE:
    // either way the store is the truth), draw a warning at once and the first waiting line if its turn has come.
    // A queued-only call keeps the scroll position but still redraws (pruning may have changed it).
    this._pruneQueue();
    const jumped = this._takeNew();
    const released = this._releaseNext();
    this._capQueue();
    if (jumped || released) this._scrollOffset = 0; // a new row on screen: reset scroll as a new message always did
    this._updateCommsPanel();
  }

  /**
   * Per-frame update — drives the flash timer.
   * @param {number} dt — seconds
   */
  update(dt) {
    this._tickQueue(dt);
    if (this._commsFlashTimer > 0) {
      this._commsFlashTimer -= dt;
      // Calm-HUD: a steady red border for the critical window (no strobe).
      this.panels.comms.style.borderColor = 'rgb(var(--hud-warning-rgb, 255 68 68) / 0.7)';
      if (this._commsFlashTimer <= 0) {
        const step = this._currentStep();
        this.panels.comms.style.borderColor = (step === 'large')
          ? 'rgb(var(--hud-info-rgb, 0 255 255) / 1.0)' : 'var(--hud-hairline, rgb(var(--hud-normal-rgb, 0 255 136) / 0.3))';
      }
    }
  }

  /** No-op (the C-hold radial menu is gone); HUD still calls it at 10 Hz. */
  updateMenu() {
    // Intentionally empty
  }

  /** Legacy: expands the pane. */
  toggleComms() {
    this._expandPane();
  }

  /** Always false: the center popup is gone. */
  isCommsOpen() {
    return false;
  }

  /** Clean up DOM elements. */
  dispose() {
    this._disposed = true;
    this._resetQueue();
    if (this._logResizeObserver && typeof this._logResizeObserver.disconnect === 'function') {
      this._logResizeObserver.disconnect();
    }
    this._logResizeObserver = null;
    if (this._logResizeListener && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('resize', this._logResizeListener);
    }
    this._logResizeListener = null;
    if (this._logResizeRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._logResizeRaf);
    this._logResizeRaf = 0;
  }

  // Display queue: every line stays on screen at least COMMS.PANE_MIN_SHOW_S seconds.

  /** @private True when the constructor built the display list (a bare prototype rig in a test has none: store drawn as ever). */
  _queueReady() {
    return Array.isArray(this._waiting) && Array.isArray(this._shown) && !!this._taken;
  }

  /** @private The messages the log draws: the panel's own `_shown` once anything has come through intake, else the store. */
  _displayMessages() {
    const store = this._commsSystem ? this._commsSystem.getMessages() : [];
    if (!Array.isArray(this._shown) || !(this._intakeCount > 0)) return store;
    return this._shown;
  }

  /** @private Append a stored message to the rows drawn (newest last). */
  _pushShown(m) {
    this._shown.push(m);
    while (this._shown.length > SHOWN_MAX) this._shown.shift();
  }

  /**
   * @private Forget every queued or drawn object CommsSystem no longer stores (coalescing replaced it with a
   * summary, the ring buffer dropped it, or `CommsSystem.reset()` emptied the store). A drawn row that vanishes is
   * redrawn at once by the caller (`true`); a scroll position past the end is brought back inside.
   * @returns {boolean} true when a drawn row was removed
   */
  _pruneQueue() {
    const store = this._commsSystem ? this._commsSystem.getMessages() : [];
    const waiting = this._waiting;
    for (let i = waiting.length - 1; i >= 0; i--) {
      if (store.indexOf(waiting[i]) < 0) waiting.splice(i, 1);
    }
    const shown = this._shown;
    const newest = shown.length ? shown[shown.length - 1] : null;
    let removed = false;
    for (let i = shown.length - 1; i >= 0; i--) {
      if (store.indexOf(shown[i]) < 0) { shown.splice(i, 1); removed = true; }
    }
    // the newest row itself went (coalesced into a summary): the next waiting line may show at once
    if (newest && store.indexOf(newest) < 0) this._sinceShown = Infinity;
    if (removed && this._scrollOffset > 0) this._scrollOffset = Math.min(this._scrollOffset, this._getMaxScroll());
    return removed;
  }

  /**
   * @private Walk the store in order and take every object not taken yet. A warning goes straight onto the
   * screen (newest row, the show clock restarts, the border flashes); anything else waits.
   * @returns {boolean} true when a warning was drawn
   */
  _takeNew() {
    const store = this._commsSystem ? this._commsSystem.getMessages() : [];
    let jumped = false;
    for (let i = 0; i < store.length; i++) {
      const m = store[i];
      if (!m || typeof m !== 'object' || this._taken.has(m)) continue;
      this._taken.add(m);
      this._intakeCount++;
      if (isCriticalPriority(m.priority)) {
        this._pushShown(m);
        this._sinceShown = 0;
        this._commsFlashTimer = 3.0;
        jumped = true;
      } else if (isWarningOrWorse(m.priority)) {
        // yellow: front of the queue, behind any warning already waiting (warnings keep their own order)
        let k = this._waiting.findIndex((w) => !isWarningOrWorse(w.priority));
        if (k < 0) k = this._waiting.length;
        this._waiting.splice(k, 0, m);
      } else {
        this._waiting.push(m);
      }
    }
    return jumped;
  }

  /**
   * @private At most COMMS.PANE_QUEUE_MAX lines wait. Past that the oldest waiting non-warning line is skipped
   * (never drawn; it stays in CommsSystem's log). Run AFTER the release step, so a batch (COMMS_RELEASE) still starts
   * with its oldest line and only then loses the surplus from the front of the queue.
   */
  _capQueue() {
    const cap = COMMS.PANE_QUEUE_MAX;
    while (this._waiting.length > cap) {
      const k = this._waiting.findIndex((m) => !isWarningOrWorse(m.priority));
      if (k < 0) break;
      this._waiting.splice(k, 1);
    }
  }

  /**
   * @private Draw the head of the queue when the newest row has been on screen long enough, or when nothing is on
   * screen at all (never "Awaiting transmission…" while a line waits). One line per call.
   * @returns {boolean} true when a row was drawn
   */
  _releaseNext() {
    if (this._waiting.length === 0) return false;
    if (this._shown.length > 0 && this._sinceShown + SHOW_TIME_SLACK_S < COMMS.PANE_MIN_SHOW_S) return false;
    this._pushShown(this._waiting.shift());
    this._sinceShown = 0;
    return true;
  }

  /** @private Per-frame: advance the show clock, drop what CommsSystem no longer stores, release when due. */
  _tickQueue(dt) {
    if (!this._queueReady()) return;
    if (typeof dt === 'number' && dt > 0) this._sinceShown += dt;
    if (this._waiting.length === 0 && this._shown.length === 0) return;
    const pruned = this._pruneQueue();
    const released = this._releaseNext();
    if (released) this._scrollOffset = 0;
    if (pruned || released) this._updateCommsPanel();
  }

  /** @private GAME_RESET / dispose - nothing queued, nothing drawn, the next line shows at once. */
  _resetQueue() {
    if (!this._queueReady()) return;
    this._waiting.length = 0;
    this._shown.length = 0;
    this._sinceShown = Infinity;
    this._taken = new WeakSet();
  }

  /** @private Cycles the pane size (line → normal → large → line). */
  _expandPane() {
    if (this._chrome) this._chrome.cycle();
  }

  /**
   * @private The current size step: PaneChrome's once it exists, else the last step APPLIED (recorded by
   * `_applyCommsStep`, valid while PaneChrome is still constructing), else 'normal'.
   */
  _currentStep() {
    if (this._chrome && COMMS_STEPS.includes(this._chrome.step)) return this._chrome.step;
    if (this._commsStep && COMMS_STEPS.includes(this._commsStep)) return this._commsStep;
    return 'normal';
  }

  /**
   * @private Resolve the pane/log height for the current step.
   * @param {string} [stepArg] the step PaneChrome just applied; explicit because the initial call arrives
   *   from inside PaneChrome's constructor, before `this._chrome` exists.
   */
  _applyCommsStep(stepArg) {
    const step = COMMS_STEPS.includes(stepArg) ? stepArg : this._currentStep();
    this._commsStep = step;
    let h;
    if (step === 'line') h = VITALS_COLLAPSED_HEIGHT_PX;   // as tall as MOTHER's collapsed pane (one number, VitalsPane)
    else if (step === 'large') h = COMMS.PANE_EXPAND_HEIGHT_PX;
    else h = COMMS.PANE_HEIGHT_PX;

    // The pane grows by the contract header (when revealed) so the tracker never clips messages.
    const logH = h - 12;
    const panelH = h + (this._contractVisible ? CONTRACT_HEADER_PX : 0);
    this.panels.comms.style.height = `${panelH}px`;
    this._logEl.style.height = `${logH}px`;

    if (this._commsFlashTimer <= 0) {
      this.panels.comms.style.borderColor = (step === 'large')
        ? 'rgb(var(--hud-info-rgb, 0 255 255) / 1.0)'
        : 'var(--hud-hairline, rgb(var(--hud-normal-rgb, 0 255 136) / 0.3))';
    }

    this._updateCommsPanel();

    // Layout consumers (HUD right column + NavSphere slot) invalidate their cached comms-bottom on this. The
    // height animates over 0.3 s (CSS transition), so listeners keep recomputing through a short settle window.
    eventBus.emit(Events.COMMS_PANEL_RESIZED, { step, height: h });
  }

  /**
   * @private Update the gated elevator-contract tracker. Reveals the header the first time contractMassKg > 0
   * and keeps it shown; the pane then grows by CONTRACT_HEADER_PX (COMMS_PANEL_RESIZED reflows the column).
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
    // Colour intensity: muted below 50 %, brighter above.
    if (this._contractEl && target > 0) {
      const c = (mass / target) > 0.5 ? 'var(--hud-normal, #a5d6a7)' : 'var(--hud-normal, #81c784)';
      this._contractEl.style.color = c;
      if (fillEl) fillEl.style.background = c;
    }

    if (mass > 0 && !this._contractVisible) {
      this._contractVisible = true;
      if (this._contractEl) this._contractEl.style.display = 'flex';
      this._applyCommsStep();
    }
  }

  /**
   * @private Watch the log's WIDTH. A narrower log wraps a message onto more lines, so rows rendered at the old
   * width can end up cut; only a render re-trims them. A `ResizeObserver` on the border box (a `window` `resize`
   * listener where there is none); nothing in node tests.
   */
  _observeLogWidth() {
    if (typeof ResizeObserver === 'function') {
      this._logResizeObserver = new ResizeObserver(() => this._onLogObserved());
      this._logResizeObserver.observe(this._logEl, { box: 'border-box' });
    } else if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      this._logResizeListener = () => this._onLogResized();
      window.addEventListener('resize', this._logResizeListener);
    }
  }

  /**
   * @private True when the log's width differs from the last one seen (and remembers the new one). The width is the
   * border-box `offsetWidth`: the observer's content width shifts by the 4 px scrollbar whenever it appears, which
   * would re-render, hide the scrollbar, and oscillate. The 0.3 s height animation changes only the height (the
   * transitionend render's business), so a pure height change reports false.
   */
  _logWidthChanged() {
    const w = this._logEl ? this._logEl.offsetWidth : NaN;
    if (typeof w !== 'number' || !(w >= 0) || w === this._logWidth) return false;
    this._logWidth = w;
    return true;
  }

  /**
   * @private The ResizeObserver fired. The FIRST callback (right after the first layout, around boot) only records
   * the width: nothing is rendered before boot has finished. Later, a width change renders AT ONCE inside the
   * callback (it runs after layout and before paint; deferring to the next frame painted one frame with a cut row).
   * Re-rendering cannot re-trigger the observer: the log's border box does not change.
   */
  _onLogObserved() {
    if (this._disposed || !this._logEl) return;
    if (this._logWidth < 0) {
      const w = this._logEl.offsetWidth;
      if (typeof w === 'number' && w >= 0) this._logWidth = w;
      return;
    }
    if (this._logWidthChanged()) this._updateCommsPanel();
  }

  /**
   * @private The `window` `resize` fallback (no ResizeObserver): re-render at most once per animation frame, when
   * the log's width changed (`resize` comes in bursts while a window is dragged).
   */
  _onLogResized() {
    if (this._disposed || !this._logEl) return;
    if (!this._logWidthChanged()) return;
    if (typeof requestAnimationFrame !== 'function') { this._updateCommsPanel(); return; }
    if (this._logResizeRaf) return;
    this._logResizeRaf = requestAnimationFrame(() => {
      this._logResizeRaf = 0;
      if (!this._disposed) this._updateCommsPanel();
    });
  }

  /**
   * @private Show whole message rows only, at every size step: remove the oldest rendered rows while the log
   * content overflows its box, so no row is cut through at the top edge. Leaves at least one row, and when that
   * row is itself taller than the box, clamps it (`_clampTallRow`). No-op where the log has no layout.
   */
  _trimCutRows() {
    const log = this._logEl;
    if (!log || !log.children || typeof log.removeChild !== 'function') return;
    // Trim against the SMALLER of the target height and the box's height right now. A step change animates the
    // log's `height` over 0.3 s: shrinking, the target is the smaller (a row that will not fit must not come back
    // at the end); growing, the current box is the smaller (a row must not stick out over the top while the box is
    // still small; the transitionend render adds what fits later). With no layout yet the target alone counts.
    const target = parseFloat(log.style && log.style.height);
    const box = () => {
      const now = log.clientHeight;
      if (target > 0 && now > 0) return Math.min(target, now);
      return target > 0 ? target : now;
    };
    while (log.children.length > 1 && log.clientHeight > 0 && this._logContentHeight() > box() + 1) {
      log.removeChild(log.children[0]);
    }
    if (log.children.length === 1 && log.clientHeight > 0) this._clampTallRow(log.children[0], box());
  }

  /**
   * @private The one row left is still taller than the box. Keep its START (scroll-to-bottom would cut the start of
   * the message in half a row) and end it with an ellipsis: clamp to the whole lines that fit (`-webkit-line-clamp`),
   * full text in the row's tooltip. Every render builds fresh rows, so a clamp never outlives its render.
   * @param {HTMLElement} row
   * @param {number} boxH the log box height the row has to fit
   */
  _clampTallRow(row, boxH) {
    if (!row || !row.style || !(boxH > 0)) return;
    if (!(this._logContentHeight() > boxH + 1)) return;
    let lineH = NaN;
    try {
      if (typeof getComputedStyle === 'function') lineH = parseFloat(getComputedStyle(row).lineHeight);
    } catch (_e) { /* no style engine */ }
    if (!(lineH > 0)) lineH = ROW_LINE_HEIGHT_FALLBACK_PX;
    const room = boxH - 2 * (ROW_MARGIN_Y_PX + ROW_PAD_Y_PX);
    const lines = Math.max(1, Math.floor(room / lineH + 1e-3));
    row.style.display = '-webkit-box';
    row.style.webkitBoxOrient = 'vertical';
    row.style.overflow = 'hidden';
    row.style.webkitLineClamp = String(lines);   // CSS -webkit-line-clamp: N whole lines, then "…"
    row.title = String(row.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /** @private Height of the rendered rows (with their 2 px margins), independent of the box they sit in. */
  _logContentHeight() {
    const log = this._logEl;
    const kids = log.children;
    const first = kids[0], last = kids[kids.length - 1];
    if (first && last && typeof first.getBoundingClientRect === 'function' && typeof last.getBoundingClientRect === 'function') {
      const a = first.getBoundingClientRect(), b = last.getBoundingClientRect();
      if (b.bottom > a.top) return b.bottom - a.top + 2 * ROW_MARGIN_Y_PX;
    }
    return log.scrollHeight;   // no layout (tests): the content height of a box that is not mid-animation
  }

  /**
   * @private The log's height finished animating: render again against the settled box (growing, the rows that
   * now fit come back whole).
   */
  _onLogTransitionEnd(e) {
    if (e && e.propertyName && e.propertyName !== 'height') return;
    this._updateCommsPanel();
  }

  /** @private Visible line count for the current size step. */
  _visibleLineCount() {
    const step = this._currentStep();
    if (step === 'line') return COMMS.PANE_LINES_MIN;
    if (step === 'large') return COMMS.PANE_LINES_EXPANDED;
    return COMMS.PANE_LINES_DEFAULT;
  }

  /**
   * @private Message rows on screen after the last render's trim, at most the step's line count. Before any
   * render, or when the log cannot say, the step's line count.
   */
  _rowsOnScreen() {
    const cap = this._visibleLineCount();
    const n = this._shownRows;
    return (n >= 0 && n < cap) ? n : cap;
  }

  /**
   * @private How many messages one COMMS_SCROLL_UP / _DOWN moves: 3, but never more than the rows on screen
   * (a trimmed window of 1 row steps by 1, so no message is jumped over), at least 1.
   */
  _scrollStep() {
    return Math.max(1, Math.min(SCROLL_STEP_MAX, this._rowsOnScreen()));
  }

  /**
   * @private PageDown: move toward the newest messages by one step, without jumping over a message. The window
   * below can hold taller messages, so the new window may show fewer rows than the step moved; its oldest row
   * would then be newer than the message right after the previous newest, which is skipped. So step back (one
   * render each, at most the step) until the new window reaches down to it. In offsets (messages newer than the
   * window): the new oldest shown row has `offset + rows - 1` newer messages, the message after the previous
   * newest has `prevOffset - 1`.
   */
  _scrollDown() {
    const prevOffset = this._scrollOffset;
    this._scrollOffset = Math.max(prevOffset - this._scrollStep(), 0);
    this._updateCommsPanel();
    while (this._scrollOffset + Math.max(1, this._shownRows) < prevOffset) {
      this._scrollOffset = Math.max(this._scrollOffset + 1, prevOffset - Math.max(1, this._shownRows));
      this._updateCommsPanel();
    }
  }

  /**
   * @private Max scroll offset: the oldest window holds `total - rows on screen` messages above it (when the trim
   * leaves fewer rows than the step's line count, the oldest messages would otherwise never come into view).
   */
  _getMaxScroll() {
    const total = this._displayMessages().length;
    return Math.max(0, total - Math.max(1, this._rowsOnScreen()));
  }

  /** @private Update the comms panel log display */
  _updateCommsPanel() {
    if (!this._logEl) return;

    const allMessages = this._displayMessages();

    if (allMessages.length === 0) {
      this._logEl.innerHTML = `<span style="opacity:0.4;font-size:13px;">Awaiting transmission…</span>`;
      this._shownRows = 0;
      return;
    }

    // visible line count follows the current size step
    const visibleCount = this._visibleLineCount();
    const end = allMessages.length - this._scrollOffset;
    const start = Math.max(0, end - visibleCount);
    const visible = allMessages.slice(start, end);

    // Index (within `visible`) of the newest message — highlighted unless scrolled up into history.
    const latestIdx = (this._scrollOffset === 0) ? visible.length - 1 : -1;

    this._logEl.innerHTML = visible.map((msg, i) => {
      const color = getPriorityColor(msg.priority);
      // a satisfied onboarding instruction renders dimmed like history, even as the newest line
      const isLatest = (i === latestIdx) && !isFollowedInstruction(msg, this._satisfiedBeatIds);

      const textOpacity = isLatest ? '1' : '0.6';
      const rowBg = isLatest ? 'rgb(var(--hud-text-rgb, 255 255 255) / 0.06)' : 'transparent';
      const weight = (isLatest || isCriticalPriority(msg.priority)) ? '700' : '400';

      const sourceText = msg.source ? `${escapeHtml(msg.source)}: ` : '';

      // Inline glossary: wrap recognised jargon in the message body only (never the source label). A term is
      // marked seen only when it is the latest, un-scrolled row, so history re-renders don't burn every cue.
      // A message carrying a `link` (`{ term, entryId, anchor? }`, copied by CommsSystem's listener) gets its
      // first whole-word `term` wrapped as a SPECS deep link, same span class and click delegation.
      const gs = this._glossaryState;
      const markSeen = isLatest && this._scrollOffset === 0;
      const body = decorateGlossary(msg.text, {
        once: true,
        isNew: gs ? (term) => gs.isNew(term) : undefined,
        onSeen: (gs && markSeen) ? (term) => gs.markSeen(term) : undefined,
        links: msg.link ? [msg.link] : undefined,
      });

      // The inner <div> keeps label and body inline when `_clampTallRow` turns the row into a -webkit-box
      // (some engines make every direct child of a -webkit-box its own block).
      return `<div style="margin:${ROW_MARGIN_Y_PX}px 0;padding:${ROW_PAD_Y_PX}px 6px;border-left:${COMMS.STRIPE_WIDTH_PX}px solid ${color};background:${rowBg};border-radius:2px;"><div>
        <span style="color:${color};font-weight:700;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;">${sourceText}</span><span style="color:${color};opacity:${textOpacity};font-weight:${weight};font-size:13px;">${body}</span>
      </div></div>`;
    }).join('');

    // Whole message rows only, at EVERY size step: rendered rows can be taller than the log box, and then the
    // oldest sticks out over the top edge: drop the oldest while the content is taller than the box. Never the
    // last one; a last row that is still too tall is clamped (`_clampTallRow`).
    this._trimCutRows();
    const rendered = this._logEl.children;
    this._shownRows = (rendered && rendered.length > 0) ? rendered.length : visible.length;

    if (this._scrollOffset === 0) {
      this._logEl.scrollTop = this._logEl.scrollHeight;
    }

    // critical flash; the enlarged ('large') state keeps its cyan border
    const step = this._currentStep();
    if (this._commsFlashTimer > 0) {
      this.panels.comms.style.borderColor = 'rgb(var(--hud-warning-rgb, 255 68 68) / 0.7)';
    } else if (step !== 'large') {
      this.panels.comms.style.borderColor = 'var(--hud-hairline, rgb(var(--hud-normal-rgb, 0 255 136) / 0.3))';
    }
  }
}

export { filterRoundTrip, getPriorityColor, isCriticalPriority, isFollowedInstruction,
  COMMS_COLOR_NORMAL, COMMS_COLOR_WARNING, COMMS_COLOR_CRITICAL };

// CJS guard: expose pure helpers for Node.js tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { filterRoundTrip, getPriorityColor, isCriticalPriority, isFollowedInstruction,
    COMMS_COLOR_NORMAL, COMMS_COLOR_WARNING, COMMS_COLOR_CRITICAL };
}
