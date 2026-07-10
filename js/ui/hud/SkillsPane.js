/**
 * SkillsPane.js — "Discoveries" / Journal HUD overlay pane.
 *
 * Contextual reward overlay that appears when skills are discovered or
 * tech entries are unlocked. Compact view slides in from the left, shows
 * recently discovered skills, new tech unlocks, and next suggestions,
 * then auto-hides. Expanded view (J key — Journal) shows the full skill
 * tree organized by category with tier colors and key bindings.
 *
 * Delegation 1 (2026-05-31) onboarding rebind: open-key migrated from K → J
 * because bare K was freed by the broader hotkey overhaul (Forge moved to F4).
 *
 * Pure DOM component — no canvas, no THREE.js.
 *
 * @module ui/hud/SkillsPane
 * @see SKILLS_ARCHITECTURE.md §B — Pane UI Design
 * @see SKILLS_ARCHITECTURE.md §D — Feedback & Reward Architecture
 */

import { eventBus }  from '../../core/EventBus.js';
import { Events }    from '../../core/Events.js';
import { Constants } from '../../core/Constants.js';
import timerManager  from '../../systems/TimerManager.js';

// ── Skill state constants (match SkillsSystem) ────────────────────────────
const UNDISCOVERED = 'undiscovered';
const DISCOVERED   = 'discovered';
const PRACTICED    = 'practiced';
const MASTERED     = 'mastered';

// ── Category display metadata ─────────────────────────────────────────────
const CATEGORY_META = {
    nav:       { label: 'NAVIGATION',  order: 0 },
    scan:      { label: 'SCANNING',    order: 1 },
    collect:   { label: 'COLLECTION',  order: 2 },
    manage:    { label: 'MANAGEMENT',  order: 3 },
    awareness: { label: 'AWARENESS',   order: 4 },
};

// ── State symbols for skill display ───────────────────────────────────────
const STATE_SYMBOLS = {
    [UNDISCOVERED]: '○',
    [DISCOVERED]:   '●',
    [PRACTICED]:    '●',
    [MASTERED]:     '✓',
};

// ── Compact view limits ───────────────────────────────────────────────────
const MAX_COMPACT_ACTIVE  = 4;
const MAX_COMPACT_SUGGEST = 2;

// ── First-discovery threshold (longer display for first N) ────────────────
const FIRST_DISCOVERY_LONG_COUNT = 3;

// ── Progression-aware persistence levels ─────────────────────────────────
// Drives show()/fadeOut() behavior based on player's discovered-skill count.
// NOVICE:     pane always visible, high idle opacity, no auto-hide.
// APPRENTICE: pane stays rendered but dims to 45% idle after timeout.
// VETERAN:    current toast behavior — fades out and hides completely.
const EXPERIENCE_LEVELS = {
    NOVICE:     { threshold: 0,  idleOpacity: 0.85, autoHideMs: null,  firstDiscoveryMs: null  },
    APPRENTICE: { threshold: 5,  idleOpacity: 0.45, autoHideMs: 15000, firstDiscoveryMs: 20000 },
    VETERAN:    { threshold: 15, idleOpacity: 0.0,  autoHideMs: 4000,  firstDiscoveryMs: 8000  },
};

// ── Brighten window when a discovery fires in NOVICE mode ────────────────
// After this delay the pane transitions back from 100% to the idle opacity.
const NOVICE_BRIGHTEN_MS = 3000;

// ── Delay before first auto-display after construction ────────────────────
const INITIAL_DISPLAY_DELAY_MS = 500;

// ── Fade-to-idle transition duration ──────────────────────────────────────
const FADE_TO_IDLE_MS = 300;

export class SkillsPane {
    /**
     * Create the Skills Pane and attach it to the HUD overlay.
     * @param {HTMLElement} hudContainer — The #hud-overlay div
     */
    constructor(hudContainer) {
        /** @type {HTMLElement} */
        this._hudContainer = hudContainer;

        // ── Skill data ────────────────────────────────────────────────
        /** @type {Object[]} Full catalog from Constants.SKILLS.CATALOG */
        this._catalog = Constants.SKILLS.CATALOG;
        /** @type {Object[]} Tier definitions from Constants.SKILLS.TIERS */
        this._tiers = Constants.SKILLS.TIERS;
        /** @type {Map<string, Object>} Skill definition lookup by ID */
        this._defMap = new Map();
        /** @type {Map<string, string>} Local state tracking: skillId → state */
        this._states = new Map();
        /** @type {string[]} Discovery order (oldest first) */
        this._discoveryOrder = [];
        /** @type {number} Running count of discoveries this session */
        this._discoveryCount = 0;

        // ── Tech unlock data (from CodexSystem via TECH_UNLOCKED) ───────
        /** @type {Object[]} Recent tech unlocks: { id, title, shortText, category, time } */
        this._recentTech = [];
        /** @type {number} Badge counter for unseen tech entries */
        this._unseenTechCount = 0;
        /** @type {number} Max recent tech entries shown in compact view */
        this._techMaxVisible = 3;

        // ── DOM elements ──────────────────────────────────────────────
        /** @type {HTMLElement|null} Compact pane container */
        this._pane = null;
        /** @type {HTMLElement|null} Compact pane header row */
        this._paneHeader = null;
        /** @type {HTMLElement|null} Compact pane body (skill list area) */
        this._paneBody = null;
        /** @type {HTMLElement|null} Expanded overlay panel */
        this._expandedOverlay = null;
        /** @type {HTMLElement|null} Expanded backdrop */
        this._backdrop = null;
        /** @type {HTMLElement|null} Expanded body (scrollable skill list) */
        this._expandedBody = null;

        // ── Visibility state ──────────────────────────────────────────
        /** @type {boolean} Compact pane visible right now */
        this._visible = false;
        /** @type {boolean} Expanded overlay open */
        this._expanded = false;
        /** @type {boolean} Master switch — toggled by GAME_STATE_CHANGE.
         *  Default FALSE: pane is hidden on app load (MENU / BRIEFING /
         *  LAUNCH_CINEMATIC), only becomes available once the player
         *  reaches a gameplay state (ORBITAL_VIEW / APPROACH / INTERACTION).
         *  2026-05-15 polish task 7. */
        this._masterVisible = false;
        /** @type {boolean} Currently fading out compact pane */
        this._fading = false;

        // ── Timers ────────────────────────────────────────────────────
        /** @type {number|null} Auto-hide setTimeout ID */
        this._hideTimerId = null;
        /** @type {number|null} Fade-end cleanup setTimeout ID */
        this._fadeEndTimerId = null;
        /** @type {Map<string, number>} Mastered-fade setTimeout IDs */
        this._masteredTimers = new Map();
        /** @type {number|null} Initial-display (post-construct) setTimeout ID */
        this._initialTimerId = null;

        // ── Progression-aware persistence tracking ───────────────────
        /** @type {string} Last level observed — used to log threshold crossings */
        this._lastLevelSeen = 'novice';

        // ── Checklist mode (ST-3.1: NOVICE next-step suggestions) ─────
        /** @type {boolean} Enabled while in NOVICE level */
        this._checklistMode = true;
        /** @type {Set<string>} Recently-discovered skill IDs shown with ✓ */
        this._checklistCompletedIds = new Set();
        /** @type {Map<string, number>} skillId → setTimeout handle for ✓ dim */
        this._checklistDimTimers = new Map();

        // ── Event unsubscribers ───────────────────────────────────────
        /** @type {Function[]} */
        this._unsubs = [];

        // ── Key handlers (bound once) ─────────────────────────────────
        /** @type {Function} Bubble-phase keydown (J key toggle — Journal) */
        this._boundOnKeyDown = this._onKeyDown.bind(this);
        /** @type {Function} Capture-phase keydown (expanded overlay) */
        this._boundOnExpandedKeyDown = this._onExpandedKeyDown.bind(this);

        // ── Bootstrap ─────────────────────────────────────────────────
        this._initCatalog();
        this._injectStyles();
        this._build();
        this._setupListeners();
        document.addEventListener('keydown', this._boundOnKeyDown);

        // 2026-05-15 polish task 7: hidden on startup. Used to call
        // _applyInitialDisplay() unconditionally 500 ms after construct,
        // which painted the pane during MENU / BRIEFING. Now we wire
        // visibility to GAME_STATE_CHANGE — pane only appears once the
        // player reaches a gameplay state. The first call to
        // setVisible(true) in a gameplay state runs _applyInitialDisplay.
        this._lastLevelSeen = this._getExperienceLevel();
        this._unsubs.push(
            eventBus.on(Events.GAME_STATE_CHANGE, ({ to }) => {
                const gameplay = (to === 'ORBITAL_VIEW' || to === 'APPROACH' || to === 'INTERACTION');
                if (gameplay && !this._masterVisible) {
                    this.setVisible(true);
                    // Re-apply initial display now that we're past the menu.
                    // Slight delay matches the original behavior so the
                    // pane appears *after* the HUD has settled into view.
                    if (this._initialTimerId !== null) timerManager.clear(this._initialTimerId);
                    this._initialTimerId = timerManager.setTimeout(() => {
                        this._initialTimerId = null;
                        this._applyInitialDisplay();
                    }, INITIAL_DISPLAY_DELAY_MS, { owner: this });
                } else if (!gameplay && this._masterVisible) {
                    this.setVisible(false);
                }
            })
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  PUBLIC API
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Per-frame update. CSS transitions handle animations; reserved for
     * future frame-driven effects.
     * @param {number} _dt — Delta time in seconds
     */
    update(_dt) {
        // intentionally minimal — CSS transitions drive all visual effects
    }

    /**
     * Show the compact pane. Behavior adapts to player experience level:
     *   NOVICE     — pane is always rendered; show() brightens to 100% and
     *                returns to 85% idle after NOVICE_BRIGHTEN_MS.
     *   APPRENTICE — pane is normally visible at 45%; show() brightens to
     *                100% and fades back to 45% after 15s (20s for first 3).
     *   VETERAN    — classic transient toast: slide-in to 100%, full fadeOut
     *                after 4s (8s for first 3).
     * Slide-in animation only plays when the pane is currently hidden (i.e.
     * VETERAN idle). For NOVICE/APPRENTICE the pane is already rendered so
     * only the opacity transition plays.
     * @param {number} [duration] — Override auto-hide duration (ms)
     */
    show(duration) {
        if (!this._masterVisible) return;
        this._cancelHideTimer();
        this._cancelFadeTimer();
        this._fading = false;

        const p = this._pane;
        const level = this._getExperienceLevel();
        const isCurrentlyHidden = p.style.display === 'none' || !this._visible;

        p.style.display = 'block';
        p.style.transition = 'opacity 200ms ease-out, transform 200ms ease-out';
        if (isCurrentlyHidden) {
            // Slide-in from left (veteran idle → active, or first-ever show)
            p.style.opacity = '0';
            p.style.transform = 'translateX(-20px)';
            // Force reflow so browser registers starting values before transition
            void p.offsetHeight;
        }
        p.style.opacity = '1';
        p.style.transform = 'translateX(0)';
        this._visible = true;

        const dur = duration != null ? duration : this._getShowDuration(level);
        if (dur != null && dur > 0) {
            this._scheduleHide(dur);
        }
        // If dur is null (shouldn't happen — novice returns NOVICE_BRIGHTEN_MS),
        // the pane stays at 100% indefinitely until next show() or fadeOut().
    }

    /**
     * Hide the compact pane with a fade-out animation.
     */
    hide() {
        if (!this._visible && !this._fading) return;
        this._cancelHideTimer();
        this._fadeOut();
    }

    /**
     * Toggle expanded skill tree view on / off.
     */
    toggleExpanded() {
        this._expanded ? this._closeExpanded() : this._openExpanded();
    }

    /**
     * Master visibility control (called by HUD.js on game-state changes).
     * @param {boolean} visible
     */
    setVisible(visible) {
        this._masterVisible = visible;
        if (!visible) {
            this._hideImmediate();
            if (this._expanded) this._closeExpanded();
        }
    }

    /**
     * Reset to a fresh-game state: clear all skill discoveries, tech entries,
     * and re-apply NOVICE behavior. Called by GameFlowManager on new game.
     */
    reset() {
        this._cancelHideTimer();
        this._cancelFadeTimer();
        if (this._initialTimerId !== null) {
            timerManager.clear(this._initialTimerId);
            this._initialTimerId = null;
        }
        for (const tid of this._masteredTimers.values()) timerManager.clear(tid);
        this._masteredTimers.clear();

        // Reset skill state
        for (const def of this._catalog) this._states.set(def.id, UNDISCOVERED);
        this._discoveryOrder.length = 0;
        this._discoveryCount = 0;

        // Reset checklist mode (ST-3.1)
        for (const tid of this._checklistDimTimers.values()) timerManager.clear(tid);
        this._checklistDimTimers.clear();
        this._checklistCompletedIds.clear();
        this._checklistMode = true;

        // PR 5 / P2.8: safety net — kill any other untracked timers owned
        // by this pane (e.g. animation fallbacks scheduled but not stored).
        timerManager.clearByOwner(this);

        // Reset tech state
        this._recentTech.length = 0;
        this._unseenTechCount = 0;

        // Re-apply NOVICE behavior (always visible at 85% idle)
        this._lastLevelSeen = this._getExperienceLevel();
        this._renderCompact();
        this._applyInitialDisplay();
    }

    /**
     * Remove all DOM elements, unsubscribe events, clear timers.
     */
    dispose() {
        this._cancelHideTimer();
        this._cancelFadeTimer();
        if (this._initialTimerId !== null) {
            timerManager.clear(this._initialTimerId);
            this._initialTimerId = null;
        }
        for (const tid of this._masteredTimers.values()) timerManager.clear(tid);
        this._masteredTimers.clear();

        // Clear checklist timers (ST-3.1)
        for (const tid of this._checklistDimTimers.values()) timerManager.clear(tid);
        this._checklistDimTimers.clear();
        this._checklistCompletedIds.clear();

        // PR 5 / P2.8: safety net — kill any timers tagged with this owner
        // that haven't been explicitly tracked (animation-end fallbacks etc.).
        timerManager.clearByOwner(this);

        // Clear tech state
        this._recentTech.length = 0;
        this._unseenTechCount = 0;

        for (const unsub of this._unsubs) unsub();
        this._unsubs.length = 0;

        document.removeEventListener('keydown', this._boundOnKeyDown);
        document.removeEventListener('keydown', this._boundOnExpandedKeyDown, true);

        if (this._pane?.parentNode) this._pane.parentNode.removeChild(this._pane);
        if (this._expandedOverlay?.parentNode) this._expandedOverlay.parentNode.removeChild(this._expandedOverlay);
        if (this._backdrop?.parentNode) this._backdrop.parentNode.removeChild(this._backdrop);

        const styleEl = document.getElementById('skills-pane-styles');
        if (styleEl) styleEl.remove();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  INITIALIZATION
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Build the catalog lookup map and set all states to UNDISCOVERED.
     * @private
     */
    _initCatalog() {
        for (const def of this._catalog) {
            this._defMap.set(def.id, def);
            this._states.set(def.id, UNDISCOVERED);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  CSS INJECTION
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Inject the Skills Pane stylesheet (idempotent).
     * @private
     */
    _injectStyles() {
        if (document.getElementById('skills-pane-styles')) return;
        const el = document.createElement('style');
        el.id = 'skills-pane-styles';
        el.textContent = `
/* ── Skills Pane. Compact pane docked in the left column under Daughters ─── */
.skills-pane {
    position: relative;
    width: 100%;
    box-sizing: border-box;
    max-height: 300px;
    overflow-y: auto;
    background: rgba(0, 10, 20, 0.85);
    border: 1px solid rgba(0, 255, 136, 0.25);
    border-radius: 4px;
    padding: 8px 12px;
    font-family: 'Courier New', monospace;
    font-size: 12px;
    color: #ccddcc;
    z-index: 200;
    pointer-events: none;
    display: none;
}

/* ── Compact pane header ───────────────────────────────────────────────── */
.sp-header {
    padding: 2px 0 6px;
    border-bottom: 1px solid rgba(0, 255, 136, 0.15);
    margin-bottom: 6px;
    font-size: 11px;
    letter-spacing: 1px;
    color: #00ff88;
    opacity: 0.8;
    user-select: none;
    pointer-events: auto;
    cursor: pointer;
    display: flex;
    justify-content: space-between;
    align-items: center;
}
.sp-header:hover { opacity: 1; }
.sp-count { font-size: 10px; opacity: 0.6; }

/* ── Compact skill entry ───────────────────────────────────────────────── */
.sp-entry {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 1px 0;
    line-height: 1.6;
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
}
.sp-sym {
    width: 12px;
    text-align: center;
    flex-shrink: 0;
    font-size: 10px;
}
.sp-lbl {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
}
.sp-key {
    flex-shrink: 0;
    opacity: 0.4;
    font-size: 10px;
    color: #aaa;
}
.sp-entry.sp-suggest { opacity: 0.35; }
.sp-entry.sp-mastered { color: #00ff88; }
.sp-entry.sp-mastered-fade {
    transition: opacity 2s ease-out;
    opacity: 0 !important;
}

/* ── Discovery animation ───────────────────────────────────────────────── */
@keyframes spPulse {
    0%, 100% { text-shadow: 0 0 0 transparent; }
    50%      { text-shadow: 0 0 12px var(--tier-color, #00ff88); }
}
.sp-entry.sp-pulse {
    animation: spPulse 600ms ease-in-out 2;
}
@keyframes spSlideIn {
    from { opacity: 0; transform: translateX(-20px); }
    to   { opacity: 1; transform: translateX(0); }
}
.sp-entry.sp-slide {
    animation: spSlideIn 250ms ease-out forwards;
}

/* ── Screen-edge glow ──────────────────────────────────────────────────── */
@keyframes spEdgeGlow {
    0%   { opacity: 0; }
    30%  { opacity: 0.5; }
    100% { opacity: 0; }
}
.sp-edge-glow {
    position: fixed;
    top: 0; left: 0; bottom: 0;
    width: 40px;
    pointer-events: none;
    z-index: 199;
    animation: spEdgeGlow 500ms ease-out forwards;
}

/* ── Expanded view. Backdrop ──────────────────────────────────────────── */
.sp-backdrop {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0, 5, 10, 0.75);
    z-index: 9998;
    display: none;
}

/* ── Expanded view. Panel ─────────────────────────────────────────────── */
.sp-expanded {
    position: fixed;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    width: 480px;
    max-width: 92vw;
    max-height: 82vh;
    background: rgba(0, 10, 20, 0.95);
    border: 1px solid rgba(0, 255, 136, 0.35);
    border-radius: 6px;
    font-family: 'Courier New', monospace;
    font-size: 12px;
    color: #ccddcc;
    z-index: 9999;
    display: none;
    pointer-events: auto;
    cursor: default;
    overflow: hidden;
    box-shadow: 0 0 40px rgba(0, 255, 136, 0.08);
}

/* ── Expanded header ───────────────────────────────────────────────────── */
.sp-ex-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 16px;
    border-bottom: 1px solid rgba(0, 255, 136, 0.2);
    flex-shrink: 0;
}
.sp-ex-back {
    cursor: pointer;
    color: #00ff88;
    font-size: 13px;
    font-weight: bold;
    letter-spacing: 2px;
    user-select: none;
}
.sp-ex-back:hover { opacity: 0.7; }
.sp-ex-count { color: #888; font-size: 11px; }

/* ── Expanded body (scrollable) ────────────────────────────────────────── */
.sp-ex-body {
    flex: 1;
    overflow-y: auto;
    padding: 12px 16px;
    columns: 2;
    column-gap: 20px;
    scrollbar-width: thin;
    scrollbar-color: rgba(0,255,136,0.2) transparent;
}

/* ── Category section (break-inside: avoid keeps group in one column) ─── */
.sp-cat {
    break-inside: avoid;
    margin-bottom: 14px;
}
.sp-cat-hdr {
    font-size: 10px;
    letter-spacing: 2px;
    margin-bottom: 4px;
    padding-bottom: 3px;
    border-bottom: 1px solid rgba(255,255,255,0.08);
    opacity: 0.85;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
}
.sp-cat-prog {
    font-size: 9px;
    opacity: 0.5;
    letter-spacing: 0;
}

/* ── Expanded skill entry ──────────────────────────────────────────────── */
.sp-ex-entry {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 2px 0;
    font-size: 11px;
    line-height: 1.5;
}
.sp-ex-sym {
    width: 14px;
    text-align: center;
    flex-shrink: 0;
    font-size: 11px;
}
.sp-ex-lbl {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.sp-ex-key {
    flex-shrink: 0;
    opacity: 0.35;
    font-size: 10px;
    color: #888;
}
.sp-ex-entry.spe-undiscovered { opacity: 0.30; }
.sp-ex-entry.spe-discovered   { opacity: 1.0; }
.sp-ex-entry.spe-practiced    { opacity: 0.75; }
.sp-ex-entry.spe-mastered     { opacity: 0.5; }
.sp-ex-entry.spe-mastered .sp-ex-sym { color: #00ff88; }
.sp-ex-entry.spe-locked       { color: #ff4444; opacity: 0.5; }

/* ── Expanded footer ───────────────────────────────────────────────────── */
.sp-ex-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 16px;
    border-top: 1px solid rgba(0, 255, 136, 0.2);
    font-size: 10px;
    flex-shrink: 0;
}
.sp-prog-text { color: #888; }
.sp-close-hint { color: #555; }

/* ── New Tech section (Discovery Pane) ─────────────────────────────────── */
.sp-tech-entry {
    font-size: 11px;
    color: #00e5ff;
    padding: 2px 8px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    opacity: 0.9;
}
.sp-tech-header {
    font-size: 10px;
    color: #00e5ff;
    padding: 4px 8px 2px;
    letter-spacing: 1px;
    text-transform: uppercase;
}
.sp-tech-badge {
    background: #00e5ff;
    color: #000;
    border-radius: 8px;
    padding: 0 5px;
    font-size: 9px;
    margin-left: 4px;
    display: inline-block;
    vertical-align: middle;
}
.sp-tech-hint {
    font-size: 9px;
    color: rgba(136,255,204,0.4);
    padding: 2px 8px 4px;
    text-align: right;
}
.sp-tech-sep {
    border: none;
    border-top: 1px solid rgba(0,229,255,0.2);
    margin: 4px 0 2px;
}

/* ── Checklist mode (ST-3.1: NOVICE next-step suggestions) ─────────────── */
.sp-checklist { padding: 6px 8px; font-family: 'Courier New', monospace; font-size: 11px; }
.sp-checklist-header {
    color: #88aabb;
    font-size: 10px;
    letter-spacing: 1px;
    margin-bottom: 4px;
    opacity: 0.85;
}
.sp-checklist-items { display: flex; flex-direction: column; gap: 2px; }
.sp-cl-item {
    display: grid;
    grid-template-columns: 16px 1fr auto;
    gap: 6px;
    align-items: center;
    padding: 2px 4px;
    border-radius: 2px;
    transition: opacity 0.4s ease;
}
.sp-cl-item .sp-cl-mark { text-align: center; font-weight: bold; }
.sp-cl-item .sp-cl-key {
    color: #ffaa00;
    font-size: 10px;
    opacity: 0.8;
}
.sp-cl-done {
    color: rgba(140, 220, 160, 0.85);
    opacity: 1;
    animation: sp-cl-fade-done 3s ease forwards; /* matches CHECKLIST_DONE_LINGER_MS */
}
.sp-cl-done .sp-cl-mark { color: #44ff88; }
@keyframes sp-cl-fade-done {
    0%   { opacity: 1;   background: rgba(68, 255, 136, 0.15); }
    80%  { opacity: 1;   background: rgba(68, 255, 136, 0.05); }
    100% { opacity: 0.35; background: transparent; }
}
.sp-cl-current {
    color: var(--tier-color, #44ddff);
    font-weight: 600;
    /* Static current-step affordance: steady accent border + faint tint.
     * The attention pulse plays only on step CHANGE (2 iterations, then
     * settles) — the row is rebuilt each _renderChecklist(), so re-adding
     * the class re-triggers the finite animation naturally. No infinite
     * loop → no perpetual flashing rectangle. */
    border-left: 2px solid var(--tier-color, #44ddff);
    padding-left: 4px;
    /* Tint derives from --tier-color so it matches the border on non-cyan
     * tiers (was hardcoded cyan rgba(68,221,255,0.06)). color-mix is safe —
     * Chromium-only app. */
    background: color-mix(in srgb, var(--tier-color, #44ddff) 8%, transparent);
    animation: sp-cl-pulse 1.4s ease-in-out 2; /* matches CHECKLIST_PULSE_PERIOD_MS, finite */
}
.sp-cl-current .sp-cl-mark { color: var(--tier-color, #44ddff); }
@keyframes sp-cl-pulse {
    0%, 100% { opacity: 0.78; }
    50%      { opacity: 1;   }
}
@media (prefers-reduced-motion: reduce) {
    .sp-cl-current { animation: none; opacity: 1; }
}
.sp-cl-upcoming {
    color: rgba(160, 160, 160, 0.55);
}
.sp-cl-upcoming .sp-cl-mark { color: rgba(120, 120, 120, 0.6); }
.sp-checklist-progress {
    margin-top: 6px;
    padding-top: 4px;
    border-top: 1px solid rgba(120, 140, 160, 0.2);
    font-size: 10px;
    color: #789;
    text-align: right;
}
/* ── ST-3.4: Celebration flash animations ──────────────────────────────── */
/* Duration must match Constants.SKILLS.CELEBRATION.MASTERY_FLASH_MS (1200) */
.sp-flash-mastered {
    animation: sp-flash-mastery 1200ms ease-out;
}
@keyframes sp-flash-mastery {
    0%   { background: rgba(255, 200, 80, 0.55); box-shadow: 0 0 12px rgba(255, 200, 80, 0.6); }
    100% { background: transparent; box-shadow: none; }
}
`;
        document.head.appendChild(el);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  DOM CONSTRUCTION
    // ═══════════════════════════════════════════════════════════════════════

    /** @private Build both compact and expanded DOM trees */
    _build() {
        this._buildCompactPane();
        this._buildExpandedView();
    }

    /**
     * Build the compact pane: header + body. Docked into the left-column stack
     * (`#hud-left-column`) directly under the Daughters pane so the readiness
     * board reads top-to-bottom: MOTHER → DAUGHTERS → DISCOVERIES. Falls back to
     * the HUD overlay if the column isn't present yet.
     * @private
     */
    _buildCompactPane() {
        const pane = document.createElement('div');
        pane.className = 'skills-pane';

        // Header — clickable to open expanded view
        const header = document.createElement('div');
        header.className = 'sp-header';
        const title = document.createElement('span');
        title.textContent = '▸ DISCOVERIES';
        const count = document.createElement('span');
        count.className = 'sp-count';
        header.appendChild(title);
        header.appendChild(count);
        header.addEventListener('click', () => this.toggleExpanded());
        pane.appendChild(header);
        this._paneHeader = header;

        // Body — will hold skill entries
        const body = document.createElement('div');
        body.className = 'sp-body';
        pane.appendChild(body);
        this._paneBody = body;

        // Dock in the left column under Daughters (StatusPanel appends MOTHER then
        // DAUGHTERS, so appending here lands directly beneath them). Fall back to
        // the HUD overlay if the column hasn't been built.
        const leftColumn = document.getElementById('hud-left-column');
        (leftColumn || this._hudContainer).appendChild(pane);
        this._pane = pane;
    }

    /**
     * Build the expanded overlay: backdrop + centered panel with header,
     * scrollable body, and footer. Appended to document.body for z-index
     * independence (same pattern as CodexViewerUI).
     * @private
     */
    _buildExpandedView() {
        // ── Backdrop ──
        const backdrop = document.createElement('div');
        backdrop.className = 'sp-backdrop';
        backdrop.addEventListener('click', () => this._closeExpanded());
        document.body.appendChild(backdrop);
        this._backdrop = backdrop;

        // ── Panel ──
        const overlay = document.createElement('div');
        overlay.className = 'sp-expanded';

        // Header
        const header = document.createElement('div');
        header.className = 'sp-ex-header';
        const backBtn = document.createElement('span');
        backBtn.className = 'sp-ex-back';
        backBtn.textContent = '◂ SKILL TREE';
        backBtn.title = 'Close (J or ESC)';
        backBtn.addEventListener('click', () => this._closeExpanded());
        const exCount = document.createElement('span');
        exCount.className = 'sp-ex-count';
        header.appendChild(backBtn);
        header.appendChild(exCount);
        overlay.appendChild(header);

        // Body (scrollable, 2-column via CSS columns)
        const body = document.createElement('div');
        body.className = 'sp-ex-body';
        overlay.appendChild(body);
        this._expandedBody = body;

        // Footer
        const footer = document.createElement('div');
        footer.className = 'sp-ex-footer';
        const progText = document.createElement('span');
        progText.className = 'sp-prog-text';
        const closeHint = document.createElement('span');
        closeHint.className = 'sp-close-hint';
        closeHint.textContent = 'I. Info  ·  J to close';
        footer.appendChild(progText);
        footer.appendChild(closeHint);
        overlay.appendChild(footer);

        document.body.appendChild(overlay);
        this._expandedOverlay = overlay;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  EVENT LISTENERS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Subscribe to EventBus events from SkillsSystem.
     * @private
     */
    _setupListeners() {
        this._unsubs.push(
            eventBus.on(Events.SKILL_DISCOVERED, (d) => this._onSkillDiscovered(d))
        );
        this._unsubs.push(
            eventBus.on(Events.SKILL_STATE_CHANGED, (d) => this._onSkillStateChanged(d))
        );
        this._unsubs.push(
            eventBus.on(Events.SKILL_REMINDED, (d) => this._onSkillReminded(d))
        );
        this._unsubs.push(
            eventBus.on(Events.SKILLS_PANE_TOGGLE, () => this.toggleExpanded())
        );
        this._unsubs.push(
            eventBus.on(Events.SKILLS_LOADED, (d) => this._onSkillsLoaded(d))
        );

        // ── Tech unlock tracking (Phase 3+4: Discovery Pane) ────────────
        this._unsubs.push(
            eventBus.on(Events.TECH_UNLOCKED, (data) => {
                this._recentTech.unshift({
                    id: data.id,
                    title: data.title,
                    shortText: data.shortText,
                    category: data.category,
                    time: Date.now(),
                });
                // Keep max 10 in memory, show max 3
                if (this._recentTech.length > 10) this._recentTech.pop();
                this._unseenTechCount++;
                this._renderCompact();
                this.show();
            })
        );

        // Clear unseen badge when Tech Library (L key) is opened
        this._unsubs.push(
            eventBus.on(Events.CODEX_OPENED, () => {
                if (this._unseenTechCount > 0) {
                    this._unseenTechCount = 0;
                    this._renderCompact();
                }
            })
        );

        // ST-3.1: First capture exits NOVICE checklist mode
        this._unsubs.push(
            eventBus.on(Events.LASSO_CAPTURED, () => this._exitChecklistMode())
        );
        this._unsubs.push(
            eventBus.on(Events.ARM_CAPTURED, () => this._exitChecklistMode())
        );

        // ST-3.4: Celebration visual feedback on state transitions
        this._unsubs.push(
            eventBus.on(Events.SKILL_STATE_CHANGED, (d) => {
                if (d?.to === 'practiced') this._flashSkillEntry(d.skillId);
            })
        );
        this._unsubs.push(
            eventBus.on(Events.MASTERY_FANFARE, (d) => {
                if (!d?.skillId) return;
                const color = this._getTierColor(d.tier);
                this._showEdgeGlow(color);
                this._flashSkillEntry(d.skillId, 'mastered');
            })
        );
    }

    /**
     * Handle SKILL_DISCOVERED: update local state, render compact pane,
     * play edge glow, and auto-show.
     * @param {{ skillId: string, tier: number, label: string }} data
     * @private
     */
    _onSkillDiscovered(data) {
        const { skillId, tier } = data;
        const def = this._defMap.get(skillId);
        if (!def) return;

        // Update local tracking
        this._states.set(skillId, DISCOVERED);
        if (!this._discoveryOrder.includes(skillId)) {
            this._discoveryOrder.push(skillId);
        }
        this._discoveryCount++;

        // ST-3.1: Handle checklist completion animation
        if (this._checklistMode) {
            this._handleChecklistDiscovery(skillId);
        }

        // Render compact with highlight on the new skill
        this._renderCompact(skillId);

        // Edge glow in tier color
        this._showEdgeGlow(this._getTierColor(tier));

        // Show pane (auto-hides per level policy)
        this.show();

        // Log threshold crossings (novice → apprentice → veteran)
        this._checkLevelTransition();
    }

    /**
     * Handle SKILL_STATE_CHANGED: update local state map, refresh visible
     * skill entries, and initiate mastered-fade when appropriate.
     * @param {{ skillId: string, from: string, to: string }} data
     * @private
     */
    _onSkillStateChanged(data) {
        const { skillId, to } = data;
        this._states.set(skillId, to);

        // If compact pane is showing, update the affected entry
        if (this._visible && this._paneBody) {
            const el = this._paneBody.querySelector(`[data-skill-id="${skillId}"]`);
            if (el) {
                const symEl = el.querySelector('.sp-sym');
                if (to === MASTERED) {
                    if (symEl) { symEl.textContent = '✓'; symEl.style.color = '#00ff88'; }
                    el.classList.add('sp-mastered');
                    // Update label color to green for mastered
                    const lblEl = el.querySelector('.sp-lbl');
                    if (lblEl) lblEl.style.color = '#00ff88';

                    // Start mastered-fade timer
                    if (!this._masteredTimers.has(skillId)) {
                        const tid = timerManager.setTimeout(() => {
                            el.classList.add('sp-mastered-fade');
                            this._masteredTimers.delete(skillId);
                            // Remove DOM node after opacity transition
                            timerManager.setTimeout(() => { if (el.parentNode) el.remove(); }, 2100, { owner: this });
                        }, Constants.SKILLS.MASTERED_FADE_DELAY, { owner: this });
                        this._masteredTimers.set(skillId, tid);
                    }
                } else if (to === PRACTICED) {
                    // Practiced keeps ● symbol (same as discovered)
                    if (symEl) symEl.textContent = '●';
                }
            }
        }
    }

    /**
     * Handle SKILL_REMINDED: show the compact pane with the reminded skill
     * highlighted so the player notices the contextual nudge.
     * @param {{ skillId: string }} data
     * @private
     */
    _onSkillReminded(data) {
        const { skillId } = data;
        if (!this._masterVisible) return;
        if (!this._defMap.has(skillId)) return;

        // Re-render compact view with the reminded skill highlighted
        this._renderCompact(skillId);
        this.show(Constants.SKILLS.PANE_SHOW_DURATION);
    }

    /**
     * Handle SKILLS_LOADED: bulk-update local state map from persisted data.
     * Fired by SkillsSystem.restore() when a saved game is loaded.
     * @param {{ skills: Map<string, Object> }} data
     * @private
     */
    _onSkillsLoaded(data) {
        const skills = data.skills;
        if (!(skills instanceof Map)) return;

        for (const [id, rec] of skills) {
            if (rec.state && rec.state !== UNDISCOVERED) {
                this._states.set(id, rec.state);
                if (!this._discoveryOrder.includes(id)) {
                    this._discoveryOrder.push(id);
                }
            }
        }
        this._discoveryCount = this._discoveryOrder.length;
        this._updateCountBadges();

        // Refresh level tracking + apply correct initial display for the
        // restored progression state (a loaded save may jump straight to
        // APPRENTICE/VETERAN behavior).
        this._lastLevelSeen = this._getExperienceLevel();
        // ST-3.1: Exit checklist if loaded save is beyond NOVICE
        if (this._checklistMode && this._lastLevelSeen !== 'novice') {
            this._checklistMode = false;
            this._checklistCompletedIds.clear();
        }
        this._applyInitialDisplay();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  RENDERING — COMPACT VIEW
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Rebuild the compact pane body. Shows recently active skills (newest
     * first), then undiscovered suggestions to fill remaining slots.
     * @param {string|null} [highlightId=null] — Skill to highlight with animation
     * @private
     */
    _renderCompact(highlightId = null) {
        // ST-3.1: In NOVICE checklist mode, use the dedicated checklist renderer
        if (this._checklistMode && this._getExperienceLevel() === 'novice') {
            this._renderChecklist();
            return;
        }
        this._paneBody.innerHTML = '';

        // ── SKILLS section ──────────────────────────────────────────────
        // Sub-header for skills (only if we also have tech to show)
        if (this._recentTech.length > 0) {
            const skillsHdr = document.createElement('div');
            skillsHdr.style.cssText = 'font-size:10px;color:#00ff88;padding:2px 0 1px;letter-spacing:1px;opacity:0.7;';
            skillsHdr.textContent = 'SKILLS';
            this._paneBody.appendChild(skillsHdr);
        }

        // 1. Active skills (discovered / practiced / mastered — most recent first)
        const active = [];
        for (let i = this._discoveryOrder.length - 1; i >= 0; i--) {
            const id = this._discoveryOrder[i];
            const st = this._states.get(id);
            if (st === DISCOVERED || st === PRACTICED || st === MASTERED) {
                active.push(id);
            }
            if (active.length >= MAX_COMPACT_ACTIVE) break;
        }

        // 2. Suggestions (undiscovered with prereqs met)
        const suggestions = this._getSuggestions(MAX_COMPACT_SUGGEST);

        // Render active entries
        for (const id of active) {
            const el = this._createCompactEntry(id, id === highlightId);
            this._paneBody.appendChild(el);
        }

        // Render suggestions
        for (const def of suggestions) {
            const el = this._createCompactEntry(def.id, false, true);
            this._paneBody.appendChild(el);
        }

        // ── NEW TECH section (only if any tech unlocked) ────────────────
        if (this._recentTech.length > 0) {
            // Separator
            const sep = document.createElement('hr');
            sep.className = 'sp-tech-sep';
            this._paneBody.appendChild(sep);

            // Header with badge
            const techHdr = document.createElement('div');
            techHdr.className = 'sp-tech-header';
            let hdrHTML = 'NEW TECH';
            if (this._unseenTechCount > 0) {
                hdrHTML += ` <span class="sp-tech-badge">${this._unseenTechCount}</span>`;
            }
            techHdr.innerHTML = hdrHTML;
            this._paneBody.appendChild(techHdr);

            // Recent tech entries (up to _techMaxVisible)
            const visibleTech = this._recentTech.slice(0, this._techMaxVisible);
            for (const tech of visibleTech) {
                const entry = document.createElement('div');
                entry.className = 'sp-tech-entry';
                entry.textContent = `🔧 ${tech.title}`;
                entry.title = tech.shortText || '';
                this._paneBody.appendChild(entry);
            }

            // Hint
            const hint = document.createElement('div');
            hint.className = 'sp-tech-hint';
            hint.textContent = 'I. Info';
            this._paneBody.appendChild(hint);
        }

        this._updateCountBadges();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  RENDERING — NOVICE CHECKLIST MODE (ST-3.1)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Render the NOVICE checklist view into _paneBody. Shows up to
     * CHECKLIST_SUGGESTION_COUNT next-step suggestions as ✓ / → / ○ items
     * plus recently-completed items with a fade-out animation.
     * Always displays exactly n items (completed + suggestions = n).
     * @private
     */
    _renderChecklist() {
        this._paneBody.innerHTML = '';
        const cfg = Constants.SKILLS.DISCOVERY_PANE;
        const n = cfg.CHECKLIST_SUGGESTION_COUNT;
        const { discovered, total } = this._getProgress();

        // Completed items take priority slots; fill remainder with suggestions
        const completedToShow = [...this._checklistCompletedIds].slice(0, n);
        const suggestionsNeeded = Math.max(n - completedToShow.length, 0);
        const suggestions = this._getSuggestions(suggestionsNeeded);

        const wrap = document.createElement('div');
        wrap.className = 'sp-checklist';

        // Header
        const hdr = document.createElement('div');
        hdr.className = 'sp-checklist-header';
        hdr.textContent = '▸ NEXT STEPS';
        wrap.appendChild(hdr);

        // Items container
        const items = document.createElement('div');
        items.className = 'sp-checklist-items';

        // Recently-completed items (shown with ✓, fading out)
        for (const completedId of completedToShow) {
            const def = this._defMap.get(completedId);
            if (!def) continue;
            const item = document.createElement('div');
            item.className = 'sp-cl-item sp-cl-done';
            item.innerHTML =
                `<span class="sp-cl-mark">✓</span>` +
                `<span class="sp-cl-label">${def.label}</span>` +
                `<span class="sp-cl-key">${def.key ? '[' + def.key + ']' : ''}</span>`;
            items.appendChild(item);
        }

        // Undiscovered suggestions: first = current (→ pulse), rest = upcoming (○)
        let isFirst = true;
        for (const def of suggestions) {
            const tierColor = this._getTierColor(def.tier);
            const item = document.createElement('div');
            if (isFirst) {
                item.className = 'sp-cl-item sp-cl-current';
                item.style.setProperty('--tier-color', tierColor);
                item.innerHTML =
                    `<span class="sp-cl-mark">→</span>` +
                    `<span class="sp-cl-label">${def.label}</span>` +
                    `<span class="sp-cl-key">${def.key ? '[' + def.key + ']' : ''}</span>`;
                isFirst = false;
            } else {
                item.className = 'sp-cl-item sp-cl-upcoming';
                item.innerHTML =
                    `<span class="sp-cl-mark">○</span>` +
                    `<span class="sp-cl-label">${def.label}</span>` +
                    `<span class="sp-cl-key">${def.key ? '[' + def.key + ']' : ''}</span>`;
            }
            items.appendChild(item);
        }

        wrap.appendChild(items);

        // Progress footer
        const prog = document.createElement('div');
        prog.className = 'sp-checklist-progress';
        prog.innerHTML =
            `<span class="sp-cl-progress-count">${discovered}</span>/` +
            `<span class="sp-cl-progress-total">${total}</span> skills discovered`;
        wrap.appendChild(prog);

        this._paneBody.appendChild(wrap);
        this._updateCountBadges();
    }

    /**
     * Handle a skill discovery while in checklist mode: add to completed set
     * with a linger timer, then re-render.
     * @param {string} skillId
     * @private
     */
    _handleChecklistDiscovery(skillId) {
        const cfg = Constants.SKILLS.DISCOVERY_PANE;
        this._checklistCompletedIds.add(skillId);

        // Clear any existing timer for this skill
        if (this._checklistDimTimers.has(skillId)) {
            timerManager.clear(this._checklistDimTimers.get(skillId));
        }

        // Schedule removal after linger period
        const tid = timerManager.setTimeout(() => {
            this._checklistCompletedIds.delete(skillId);
            this._checklistDimTimers.delete(skillId);
            this._renderCompact(); // re-renders checklist if still in novice mode
        }, cfg.CHECKLIST_DONE_LINGER_MS, { owner: this });
        this._checklistDimTimers.set(skillId, tid);
    }

    /**
     * Exit checklist mode. Clears all pending dim timers and re-renders
     * using the normal compact view.
     * @private
     */
    _exitChecklistMode() {
        if (!this._checklistMode) return;
        this._checklistMode = false;
        // Clear all pending checklist timers
        for (const tid of this._checklistDimTimers.values()) timerManager.clear(tid);
        this._checklistDimTimers.clear();
        this._checklistCompletedIds.clear();
        this._renderCompact();
    }

    /**
     * Create a single compact skill entry DOM element.
     * @param {string} skillId
     * @param {boolean} [isHighlight=false] — play discovery animation
     * @param {boolean} [isSuggestion=false] — dimmed suggestion styling
     * @returns {HTMLElement}
     * @private
     */
    _createCompactEntry(skillId, isHighlight = false, isSuggestion = false) {
        const def   = this._defMap.get(skillId);
        const state = this._states.get(skillId) || UNDISCOVERED;
        const color = this._getTierColor(def ? def.tier : 1);

        const entry = document.createElement('div');
        entry.className = 'sp-entry';
        entry.dataset.skillId = skillId;

        if (isSuggestion) entry.classList.add('sp-suggest');
        if (state === MASTERED) entry.classList.add('sp-mastered');

        // Symbol
        const sym = document.createElement('span');
        sym.className = 'sp-sym';
        sym.textContent = isSuggestion ? '○' : (STATE_SYMBOLS[state] || '●');
        if (state === MASTERED) {
            sym.style.color = '#00ff88';
        } else if (!isSuggestion) {
            sym.style.color = color;
        }
        entry.appendChild(sym);

        // Label
        const lbl = document.createElement('span');
        lbl.className = 'sp-lbl';
        lbl.textContent = def ? def.label : skillId;
        if (!isSuggestion) {
            lbl.style.color = state === MASTERED ? '#00ff88' : color;
        }
        entry.appendChild(lbl);

        // Key binding hint
        const keyEl = document.createElement('span');
        keyEl.className = 'sp-key';
        if (def && def.key) keyEl.textContent = `[${def.key}]`;
        entry.appendChild(keyEl);

        // Discovery animation (pulse + slide)
        if (isHighlight && !isSuggestion) {
            entry.style.setProperty('--tier-color', color);
            entry.classList.add('sp-pulse', 'sp-slide');
            const cleanup = () => entry.classList.remove('sp-pulse', 'sp-slide');
            entry.addEventListener('animationend', cleanup, { once: true });
        }

        return entry;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  RENDERING — EXPANDED VIEW
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Rebuild the expanded overlay body. Groups all 35 skills by category,
     * sorted within each category by tier number.
     * @private
     */
    _renderExpanded() {
        this._expandedBody.innerHTML = '';

        // Group skills by category
        const groups = {};
        for (const cat of Object.keys(CATEGORY_META)) groups[cat] = [];
        for (const def of this._catalog) {
            const g = groups[def.category];
            if (g) g.push(def);
        }

        // Render categories in defined order
        const sortedCats = Object.keys(CATEGORY_META)
            .sort((a, b) => CATEGORY_META[a].order - CATEGORY_META[b].order);

        for (const cat of sortedCats) {
            const defs = groups[cat];
            if (!defs || defs.length === 0) continue;

            // Sort skills within category by tier, then label
            defs.sort((a, b) => a.tier !== b.tier ? a.tier - b.tier : a.label.localeCompare(b.label));

            // Count discovered in this category
            const catDiscovered = defs.filter(
                d => this._states.get(d.id) !== UNDISCOVERED
            ).length;

            // Determine category header color (use first skill's tier color)
            const catColor = this._getTierColor(defs[0].tier);

            // Section container
            const section = document.createElement('div');
            section.className = 'sp-cat';

            // Category header
            const hdr = document.createElement('div');
            hdr.className = 'sp-cat-hdr';
            hdr.style.color = catColor;

            const hdrLabel = document.createElement('span');
            hdrLabel.textContent = CATEGORY_META[cat].label;
            const hdrProg = document.createElement('span');
            hdrProg.className = 'sp-cat-prog';
            hdrProg.textContent = `${catDiscovered}/${defs.length}`;
            hdr.appendChild(hdrLabel);
            hdr.appendChild(hdrProg);
            section.appendChild(hdr);

            // Skill entries
            for (const def of defs) {
                section.appendChild(this._createExpandedEntry(def));
            }

            this._expandedBody.appendChild(section);
        }

        // Update footer and badges
        const progress = this._getProgress();
        const progEl = this._expandedOverlay.querySelector('.sp-prog-text');
        if (progEl) {
            progEl.textContent = `${progress.discovered} / ${progress.total} skills discovered`;
        }
        this._updateCountBadges();
    }

    /**
     * Create a single expanded skill entry DOM element.
     * Shows state symbol, label with tier color, and key binding.
     * Safety-gated undiscovered skills show 🔒 with red tint.
     * @param {Object} def — Skill definition from CATALOG
     * @returns {HTMLElement}
     * @private
     */
    _createExpandedEntry(def) {
        const state = this._states.get(def.id) || UNDISCOVERED;
        const tierColor = this._getTierColor(def.tier);
        const isLocked = !!(def.safetyGate) && state === UNDISCOVERED;

        const entry = document.createElement('div');
        entry.className = 'sp-ex-entry';
        entry.dataset.skillId = def.id;

        // State-based class
        if (isLocked) {
            entry.classList.add('spe-locked');
        } else if (state === MASTERED) {
            entry.classList.add('spe-mastered');
        } else if (state === PRACTICED) {
            entry.classList.add('spe-practiced');
        } else if (state === DISCOVERED) {
            entry.classList.add('spe-discovered');
        } else {
            entry.classList.add('spe-undiscovered');
        }

        // Symbol
        const sym = document.createElement('span');
        sym.className = 'sp-ex-sym';
        if (isLocked) {
            sym.textContent = '🔒';
        } else {
            sym.textContent = STATE_SYMBOLS[state] || '○';
            if (state === MASTERED) {
                sym.style.color = '#00ff88';
            } else if (state !== UNDISCOVERED) {
                sym.style.color = tierColor;
            } else {
                sym.style.color = tierColor;
                sym.style.opacity = '0.4';
            }
        }
        entry.appendChild(sym);

        // Label
        const lbl = document.createElement('span');
        lbl.className = 'sp-ex-lbl';
        lbl.textContent = def.label;
        if (state !== UNDISCOVERED && !isLocked) {
            lbl.style.color = state === MASTERED ? '#00ff88' : tierColor;
        }
        entry.appendChild(lbl);

        // Key hint
        const keyEl = document.createElement('span');
        keyEl.className = 'sp-ex-key';
        if (def.key) keyEl.textContent = `[${def.key}]`;
        entry.appendChild(keyEl);

        return entry;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  ANIMATIONS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Flash a subtle left-edge glow in the given tier color when a skill
     * is discovered. Creates a temporary DOM element that auto-removes
     * after its CSS animation completes.
     * @param {string} tierColor — CSS color string (e.g. '#00ff88')
     * @private
     */
    _showEdgeGlow(tierColor) {
        const glow = document.createElement('div');
        glow.className = 'sp-edge-glow';
        glow.style.background = `linear-gradient(to right, ${tierColor}50, transparent)`;
        document.body.appendChild(glow);
        glow.addEventListener('animationend', () => {
            if (glow.parentNode) glow.remove();
        });
        // Safety fallback: remove after 800ms even if animationend doesn't fire
        timerManager.setTimeout(() => { if (glow.parentNode) glow.remove(); }, 800, { owner: this });
    }

    /**
     * Flash a skill entry row to celebrate PRACTICED or MASTERED transitions.
     * PRACTICED uses the skill's tier color via inline style + CSS transition.
     * MASTERED uses gold via CSS keyframe class (sp-flash-mastered in _injectStyles).
     * @param {string} skillId
     * @param {'practiced'|'mastered'} [kind='practiced']
     * @private
     */
    _flashSkillEntry(skillId, kind = 'practiced') {
        const containers = [this._paneBody, this._expandedBody].filter(Boolean);
        const dur = kind === 'mastered'
            ? Constants.SKILLS.CELEBRATION.MASTERY_FLASH_MS
            : Constants.SKILLS.CELEBRATION.PRACTICE_FLASH_MS;

        for (const container of containers) {
            const el = container.querySelector(`[data-skill-id="${CSS.escape(skillId)}"]`);
            if (!el) continue;

            if (kind === 'mastered') {
                // Gold flash via CSS keyframe animation
                el.classList.remove('sp-flash-mastered');
                void el.offsetWidth;
                el.classList.add('sp-flash-mastered');
                timerManager.setTimeout(() => el.classList.remove('sp-flash-mastered'), dur + 100, { owner: this });
            } else {
                // Tier-color flash via inline style + CSS transition
                const def = this._defMap?.get(skillId);
                const tierColor = def ? this._getTierColor(def.tier) : '#44ddff';
                el.style.transition = 'none';
                el.style.background = `${tierColor}59`; // hex alpha ≈ 35%
                void el.offsetWidth;
                el.style.transition = `background ${dur}ms ease-out`;
                el.style.background = 'transparent';
                timerManager.setTimeout(() => {
                    el.style.background = '';
                    el.style.transition = '';
                }, dur + 100, { owner: this });
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  SHOW / HIDE MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Fade the compact pane. Behavior depends on player experience level:
     *   NOVICE     — fade to 85% idle opacity, remain rendered.
     *   APPRENTICE — fade to 45% idle opacity, remain rendered.
     *   VETERAN    — fade out completely and set display:none.
     * @private
     */
    _fadeOut() {
        const level = this._getExperienceLevel();
        const cfg = EXPERIENCE_LEVELS[level.toUpperCase()];

        if (level === 'novice' || level === 'apprentice') {
            this._fadeToIdle(cfg.idleOpacity);
            return;
        }

        // VETERAN — classic full fade-and-hide
        if (this._fading) return;
        this._fading = true;

        const p = this._pane;
        const dur = Constants.SKILLS.PANE_FADE_DURATION;
        p.style.transition = `opacity ${dur}ms ease-out, transform ${dur}ms ease-out`;
        p.style.opacity = '0';
        p.style.transform = 'translateX(-10px)';

        this._fadeEndTimerId = timerManager.setTimeout(() => {
            this._visible = false;
            this._fading = false;
            this._fadeEndTimerId = null;
            p.style.display = 'none';
            // Reset inline styles so next show() starts clean
            p.style.transition = '';
            p.style.opacity = '';
            p.style.transform = '';
        }, dur + 50, { owner: this }); // small buffer
    }

    /**
     * Fade the pane to a target idle opacity while keeping it rendered
     * (display:block). Used by NOVICE (0.85) and APPRENTICE (0.45) levels.
     * @param {number} targetOpacity — 0..1
     * @private
     */
    _fadeToIdle(targetOpacity) {
        this._cancelHideTimer();
        this._cancelFadeTimer();
        this._fading = false;

        const p = this._pane;
        if (!p) return;
        p.style.display = 'block';
        p.style.transition =
            `opacity ${FADE_TO_IDLE_MS}ms ease-out, transform ${FADE_TO_IDLE_MS}ms ease-out`;
        p.style.transform = 'translateX(0)';
        p.style.opacity = String(targetOpacity);
        // Pane remains visible at idle opacity
        this._visible = true;
    }

    /**
     * Apply the level-appropriate initial display on game start. NOVICE and
     * APPRENTICE players see the pane at their idle opacity from the outset;
     * VETERAN players get the classic hidden default.
     * @private
     */
    _applyInitialDisplay() {
        if (!this._masterVisible) return;
        const level = this._getExperienceLevel();
        if (level === 'veteran') return; // hidden by default — awaits discovery
        this._renderCompact();
        const cfg = EXPERIENCE_LEVELS[level.toUpperCase()];
        this._fadeToIdle(cfg.idleOpacity);
    }

    /**
     * Hide compact pane immediately (no animation).
     * @private
     */
    _hideImmediate() {
        this._cancelHideTimer();
        this._cancelFadeTimer();
        this._visible = false;
        this._fading = false;
        const p = this._pane;
        p.style.display = 'none';
        p.style.transition = '';
        p.style.opacity = '';
        p.style.transform = '';
    }

    /**
     * Schedule a fade-out after the given delay.
     * @param {number} delayMs
     * @private
     */
    _scheduleHide(delayMs) {
        this._cancelHideTimer();
        this._hideTimerId = timerManager.setTimeout(() => {
            this._hideTimerId = null;
            this._fadeOut();
        }, delayMs, { owner: this });
    }

    /**
     * Cancel the auto-hide timer if active.
     * @private
     */
    _cancelHideTimer() {
        if (this._hideTimerId !== null) {
            timerManager.clear(this._hideTimerId);
            this._hideTimerId = null;
        }
    }

    /**
     * Cancel the fade-end cleanup timer if active.
     * @private
     */
    _cancelFadeTimer() {
        if (this._fadeEndTimerId !== null) {
            timerManager.clear(this._fadeEndTimerId);
            this._fadeEndTimerId = null;
        }
    }

    /**
     * Determine how long the compact pane should stay at 100% opacity before
     * fading to idle (NOVICE/APPRENTICE) or disappearing (VETERAN). Varies by
     * experience level; first FIRST_DISCOVERY_LONG_COUNT discoveries use the
     * longer per-level duration.
     * @param {string} [level] — 'novice' | 'apprentice' | 'veteran'
     * @returns {number} Duration in ms (always > 0)
     * @private
     */
    _getShowDuration(level) {
        const lvl = level || this._getExperienceLevel();
        if (lvl === 'novice') {
            // Brighten window before returning to 85% idle
            return NOVICE_BRIGHTEN_MS;
        }
        const cfg = EXPERIENCE_LEVELS[lvl.toUpperCase()];
        const isFirst = this._discoveryCount <= FIRST_DISCOVERY_LONG_COUNT;
        return isFirst ? cfg.firstDiscoveryMs : cfg.autoHideMs;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  PROGRESSION-AWARE PERSISTENCE
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Count of skills in any state beyond 'undiscovered'. Derived from the
     * local _states Map which is kept in sync via SKILL_DISCOVERED and
     * SKILLS_LOADED event handlers.
     * @returns {number}
     * @private
     */
    _getDiscoveredSkillCount() {
        let n = 0;
        for (const state of this._states.values()) {
            if (state !== UNDISCOVERED) n++;
        }
        return n;
    }

    /**
     * Current experience level based on discovered-skill count.
     *   NOVICE     < 5
     *   APPRENTICE 5..14
     *   VETERAN    ≥ 15
     * @returns {'novice'|'apprentice'|'veteran'}
     * @private
     */
    _getExperienceLevel() {
        const count = this._getDiscoveredSkillCount();
        if (count < EXPERIENCE_LEVELS.APPRENTICE.threshold) return 'novice';
        if (count < EXPERIENCE_LEVELS.VETERAN.threshold)    return 'apprentice';
        return 'veteran';
    }

    /**
     * Log a level transition (dev visibility for UX evolution). Called after
     * discoveries that may cross a threshold.
     * @private
     */
    _checkLevelTransition() {
        const newLevel = this._getExperienceLevel();
        if (newLevel !== this._lastLevelSeen) {
            console.log('[SkillsPane] Level advanced:', this._lastLevelSeen, '→', newLevel);
            // ST-3.1: Disable checklist on level-up from novice
            if (this._checklistMode && newLevel !== 'novice') {
                this._exitChecklistMode();
            }
            this._lastLevelSeen = newLevel;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  EXPANDED VIEW MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Open the expanded skill tree overlay. Hides compact pane, renders
     * full category list, and installs capture-phase key listener.
     * @private
     */
    _openExpanded() {
        this._expanded = true;

        // Hide compact pane while expanded is open
        this._hideImmediate();

        // Render fresh content
        this._renderExpanded();

        // Show backdrop
        const bd = this._backdrop;
        bd.style.display = 'block';
        bd.style.opacity = '0';
        bd.style.transition = 'opacity 200ms ease-out';
        void bd.offsetHeight;
        bd.style.opacity = '1';

        // Show overlay
        const ov = this._expandedOverlay;
        ov.style.display = 'flex';
        ov.style.flexDirection = 'column';
        ov.style.opacity = '0';
        ov.style.transition = 'opacity 200ms ease-out';
        void ov.offsetHeight;
        ov.style.opacity = '1';

        // Capture-phase key listener blocks all other keys while expanded
        document.addEventListener('keydown', this._boundOnExpandedKeyDown, true);
    }

    /**
     * Close the expanded overlay. Fades out, removes capture-phase listener.
     * @private
     */
    _closeExpanded() {
        this._expanded = false;

        const bd = this._backdrop;
        const ov = this._expandedOverlay;

        bd.style.transition = 'opacity 200ms ease-out';
        ov.style.transition = 'opacity 200ms ease-out';
        bd.style.opacity = '0';
        ov.style.opacity = '0';

        timerManager.setTimeout(() => {
            bd.style.display = 'none';
            ov.style.display = 'none';
        }, 220, { owner: this });

        document.removeEventListener('keydown', this._boundOnExpandedKeyDown, true);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  KEY HANDLING
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Bubble-phase keydown: J key toggles expanded Journal view when not
     * already expanded (capture handler owns J/ESC when overlay is open).
     * Delegation 1 (2026-05-31) rebind: K → J.
     * @param {KeyboardEvent} e
     * @private
     */
    _onKeyDown(e) {
        if (e.code !== 'KeyJ') return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        // Ignore if typing in a form element
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        // Don't handle if expanded — capture handler owns this
        if (this._expanded) return;

        e.preventDefault();
        this.toggleExpanded();
    }

    /**
     * Capture-phase keydown: active ONLY while expanded overlay is open.
     * ESC or J closes the overlay; everything else is suppressed.
     * Delegation 1 (2026-05-31) rebind: K → J.
     * @param {KeyboardEvent} e
     * @private
     */
    _onExpandedKeyDown(e) {
        e.preventDefault();
        e.stopPropagation();

        if (e.code === 'Escape' || e.code === 'KeyJ') {
            this._closeExpanded();
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  HELPERS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Look up the color for a tier number from Constants.SKILLS.TIERS.
     * @param {number} tierNum — 1-based tier number
     * @returns {string} CSS color hex (e.g. '#00ff88')
     * @private
     */
    _getTierColor(tierNum) {
        const tier = this._tiers.find(t => t.tier === tierNum);
        return tier ? tier.color : '#ccddcc';
    }

    /**
     * Compute undiscovered skill suggestions whose prerequisites are met.
     * Skips noReminder skills. Sorted by tier (lower first), then label.
     * @param {number} [n=2] — Maximum suggestions to return
     * @returns {Object[]} Array of skill definition objects from CATALOG
     * @private
     */
    _getSuggestions(n = 2) {
        const result = [];
        for (const def of this._catalog) {
            if (this._states.get(def.id) !== UNDISCOVERED) continue;
            if (def.noReminder) continue;
            // Hard / safety prereqs must be met
            if (def.prereqType === 'hard' || def.prereqType === 'safety') {
                const met = def.prereqs.every(pid => this._states.get(pid) !== UNDISCOVERED);
                if (!met) continue;
            }
            result.push(def);
        }
        result.sort((a, b) => {
            if (a.tier !== b.tier) return a.tier - b.tier;
            return a.label.localeCompare(b.label);
        });
        return result.slice(0, n);
    }

    /**
     * Get overall discovery progress.
     * @returns {{ discovered: number, total: number }}
     * @private
     */
    _getProgress() {
        let discovered = 0;
        for (const state of this._states.values()) {
            if (state !== UNDISCOVERED) discovered++;
        }
        return { discovered, total: this._states.size };
    }

    /**
     * Update the [X/Y] count badge in both compact header and expanded header.
     * @private
     */
    _updateCountBadges() {
        const { discovered, total } = this._getProgress();
        const text = `[${discovered}/${total}]`;

        const compactEl = this._pane?.querySelector('.sp-count');
        if (compactEl) compactEl.textContent = text;

        const expandedEl = this._expandedOverlay?.querySelector('.sp-ex-count');
        if (expandedEl) expandedEl.textContent = text;
    }
}
