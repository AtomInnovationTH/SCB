/**
 * SkillsPane.js — "Discoveries" / Journal HUD overlay pane.
 *
 * The compact pane is a footer-chip popover (`DISCOVERIES` chip inboard of the DETAIL slider; the
 * `#hud-discoveries` wrapper owns the density bit). Tap the chip to expand the 280×≤300 popover above the
 * footer; tap again collapses. Expanded state is session-only (never persisted). The J key opens the full
 * skill-tree overlay. Header hit is 44 px on glass.
 *
 * The wrapper is BUILT with `data-density-hidden` (hidden by default on every floor, like the Override gag);
 * only the `experimental` rung's adapter (the last `+`) clears it.
 *
 * Pure DOM component — no canvas, no THREE.js.
 *
 * @module ui/hud/SkillsPane
 * @see archive/SKILLS_ARCHITECTURE.md §B — Pane UI Design
 * @see archive/SKILLS_ARCHITECTURE.md §D — Feedback & Reward Architecture
 */

import { eventBus }  from '../../core/EventBus.js';
import { Events }    from '../../core/Events.js';
import { Constants } from '../../core/Constants.js';
import timerManager  from '../../systems/TimerManager.js';
import { HUD_EDGE_PX, HUD_COLUMN_WIDTH_PX, RAIL_GEOMETRY, footerBand } from '../RailGeometry.js';
import { TouchControls } from '../TouchControls.js';
import { createFooterChip, leftOfSliderCss, leftOfSliderBasePx, ORB_CHIP_WIDTH_PX, FOOTER_CHIP_GAP_PX } from './FooterChip.js';
import { GestureHints } from './GestureHints.js';

export const DISCOVERIES_WRAPPER_ID = 'hud-discoveries';
export const DISCOVERIES_CHIP_ID = 'hud-chip-discoveries';
/**
 * DISCOVERIES chip `right` offset: left of the ORB chip, which stands left of the DETAIL slider (FooterChip.js
 * has the layout). Scale 1 value; the live CSS is {@link DISCOVERIES_CHIP_RIGHT_CSS}.
 */
export const DISCOVERIES_CHIP_OFFSET_PX = leftOfSliderBasePx(ORB_CHIP_WIDTH_PX + FOOTER_CHIP_GAP_PX);
export const DISCOVERIES_CHIP_RIGHT_CSS = leftOfSliderCss(ORB_CHIP_WIDTH_PX + FOOTER_CHIP_GAP_PX);
export const DISCOVERIES_POPOVER_MAX_PX = 300;

function resolveGlass(explicit) {
    if (explicit === true) return true;
    if (explicit === false) return false;
    try { return TouchControls.detectGlass(); } catch (_e) { return false; }
}

// Skill states (match SkillsSystem).
const UNDISCOVERED = 'undiscovered';
const DISCOVERED   = 'discovered';
const PRACTICED    = 'practiced';
const MASTERED     = 'mastered';

const CATEGORY_META = {
    nav:       { label: 'NAVIGATION',  order: 0 },
    scan:      { label: 'SCANNING',    order: 1 },
    collect:   { label: 'COLLECTION',  order: 2 },
    manage:    { label: 'MANAGEMENT',  order: 3 },
    awareness: { label: 'AWARENESS',   order: 4 },
};

const STATE_SYMBOLS = {
    [UNDISCOVERED]: '○',
    [DISCOVERED]:   '●',
    [PRACTICED]:    '●',
    [MASTERED]:     '✓',
};

const MAX_COMPACT_ACTIVE  = 4;
const MAX_COMPACT_SUGGEST = 2;

const FIRST_DISCOVERY_LONG_COUNT = 3;

// Drives show()/fadeOut() by the player's discovered-skill count.
// NOVICE:     pane always visible, high idle opacity, no auto-hide.
// APPRENTICE: pane stays rendered but dims to 45% idle after timeout.
// VETERAN:    toast behavior — fades out and hides completely.
const EXPERIENCE_LEVELS = {
    NOVICE:     { threshold: 0,  idleOpacity: 0.85, autoHideMs: null,  firstDiscoveryMs: null  },
    APPRENTICE: { threshold: 5,  idleOpacity: 0.45, autoHideMs: 15000, firstDiscoveryMs: 20000 },
    VETERAN:    { threshold: 15, idleOpacity: 0.0,  autoHideMs: 4000,  firstDiscoveryMs: 8000  },
};

// Brighten window when a discovery fires in NOVICE mode: after it the pane returns from 100% to idle opacity.
const NOVICE_BRIGHTEN_MS = 3000;

const INITIAL_DISPLAY_DELAY_MS = 500;

const FADE_TO_IDLE_MS = 300;

export class SkillsPane {
    /**
     * @param {HTMLElement} hudContainer — The #hud-overlay div
     * @param {{glass?:boolean, hintBandPx?:number, doc?:Document}} [opts]
     */
    constructor(hudContainer, { glass = null, hintBandPx, doc } = {}) {
        /** @type {HTMLElement} */
        this._hudContainer = hudContainer;
        this._doc = doc || (typeof document !== 'undefined' ? document : null);
        this._glassArg = glass;
        this._glass = resolveGlass(glass);
        const ticker = (Constants.ONBOARDING && Constants.ONBOARDING.TICKER) || {};
        this._hintBandPx = Number.isFinite(Number(hintBandPx))
            ? Number(hintBandPx)
            : ((Number(ticker.BOTTOM_PX) || 0) + (Number(ticker.ROW_HEIGHT_PX) || 0));
        this._band = footerBand({ glass: this._glass, hintBandPx: this._hintBandPx });
        /** @type {boolean} Chip popover open — session-only, never persisted. */
        this._chipOpen = false;
        this._wrapper = null;
        this._chip = null;

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

        /** @type {Object[]} Recent tech unlocks: { id, title, shortText, category, time } */
        this._recentTech = [];
        /** @type {number} Badge counter for unseen tech entries */
        this._unseenTechCount = 0;
        /** @type {number} Max recent tech entries shown in compact view */
        this._techMaxVisible = 3;

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

        /** @type {boolean} Compact pane visible right now */
        this._visible = false;
        /** @type {boolean} Expanded overlay open */
        this._expanded = false;
        /** @type {boolean} Master switch, toggled by GAME_STATE_CHANGE. Default FALSE: hidden on app load
         *  (MENU / BRIEFING / LAUNCH_CINEMATIC); available once the player reaches a gameplay state
         *  (ORBITAL_VIEW / APPROACH / INTERACTION). */
        this._masterVisible = false;
        /** @type {boolean} Currently fading out compact pane */
        this._fading = false;

        /** @type {number|null} Auto-hide setTimeout ID */
        this._hideTimerId = null;
        /** @type {number|null} Fade-end cleanup setTimeout ID */
        this._fadeEndTimerId = null;
        /** @type {Map<string, number>} Mastered-fade setTimeout IDs */
        this._masteredTimers = new Map();
        /** @type {number|null} Initial-display (post-construct) setTimeout ID */
        this._initialTimerId = null;

        /** @type {string} Last level observed — used to log threshold crossings */
        this._lastLevelSeen = 'novice';

        // Checklist mode: NOVICE next-step suggestions
        /** @type {boolean} Enabled while in NOVICE level */
        this._checklistMode = true;
        /** @type {Set<string>} Recently-discovered skill IDs shown with ✓ */
        this._checklistCompletedIds = new Set();
        /** @type {Map<string, number>} skillId → setTimeout handle for ✓ dim */
        this._checklistDimTimers = new Map();

        /** @type {Function[]} */
        this._unsubs = [];

        /** @type {Function} Bubble-phase keydown (J toggles the Journal) */
        this._boundOnKeyDown = this._onKeyDown.bind(this);
        /** @type {Function} Capture-phase keydown (expanded overlay) */
        this._boundOnExpandedKeyDown = this._onExpandedKeyDown.bind(this);

        this._initCatalog();
        this._injectStyles();
        this._build();
        this._setupListeners();
        if (this._doc && typeof this._doc.addEventListener === 'function') {
            this._doc.addEventListener('keydown', this._boundOnKeyDown);
        }

        // Hidden on startup: visibility follows GAME_STATE_CHANGE, so the pane never paints during MENU /
        // BRIEFING. The first setVisible(true) in a gameplay state runs _applyInitialDisplay.
        this._lastLevelSeen = this._getExperienceLevel();
        this._unsubs.push(
            eventBus.on(Events.GAME_STATE_CHANGE, ({ to }) => {
                const gameplay = (to === 'ORBITAL_VIEW' || to === 'APPROACH' || to === 'INTERACTION');
                if (gameplay && !this._masterVisible) {
                    this.setVisible(true);
                    // delayed so the pane appears after the HUD has settled into view
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

    /** Per-frame update; CSS transitions drive all visual effects. */
    update(_dt) {
        // intentionally minimal — CSS transitions drive all visual effects
    }

    /**
     * Show the compact pane. Behavior adapts to player experience level:
     *   NOVICE     — always rendered; show() brightens to 100% and returns to 85% idle after NOVICE_BRIGHTEN_MS.
     *   APPRENTICE — normally visible at 45%; show() brightens to 100% and fades back after 15s (20s for first 3).
     *   VETERAN    — transient toast: slide-in to 100%, full fadeOut after 4s (8s for first 3).
     * The slide-in only plays when the pane is currently hidden (VETERAN idle).
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
            p.style.opacity = '0';
            p.style.transform = 'translateX(-20px)';
            // force reflow so the transition starts from these values
            void p.offsetHeight;
        }
        p.style.opacity = '1';
        p.style.transform = 'translateX(0)';
        this._visible = true;

        const dur = duration != null ? duration : this._getShowDuration(level);
        if (dur != null && dur > 0) {
            this._scheduleHide(dur);
        }
    }

    /** Hide the compact pane with a fade-out animation. */
    hide() {
        if (!this._visible && !this._fading) return;
        this._cancelHideTimer();
        this._fadeOut();
    }

    /** Toggle expanded skill tree view on / off. */
    toggleExpanded() {
        this._expanded ? this._closeExpanded() : this._openExpanded();
    }

    /** Master visibility control (called by HUD.js on game-state changes). */
    setVisible(visible) {
        this._masterVisible = visible;
        if (!visible) {
            this._hideImmediate();
            if (this._expanded) this._closeExpanded();
        }
    }

    /** Reset to a fresh-game state (called by GameFlowManager on new game): clear discoveries and tech, re-apply NOVICE. */
    reset() {
        this._cancelHideTimer();
        this._cancelFadeTimer();
        if (this._initialTimerId !== null) {
            timerManager.clear(this._initialTimerId);
            this._initialTimerId = null;
        }
        for (const tid of this._masteredTimers.values()) timerManager.clear(tid);
        this._masteredTimers.clear();

        for (const def of this._catalog) this._states.set(def.id, UNDISCOVERED);
        this._discoveryOrder.length = 0;
        this._discoveryCount = 0;

        for (const tid of this._checklistDimTimers.values()) timerManager.clear(tid);
        this._checklistDimTimers.clear();
        this._checklistCompletedIds.clear();
        this._checklistMode = true;

        // safety net: kill any other untracked timers owned by this pane (animation fallbacks)
        timerManager.clearByOwner(this);

        this._recentTech.length = 0;
        this._unseenTechCount = 0;

        this._lastLevelSeen = this._getExperienceLevel();
        this._renderCompact();
        this._applyInitialDisplay();
    }

    /** Remove all DOM elements, unsubscribe events, clear timers. */
    dispose() {
        this._cancelHideTimer();
        this._cancelFadeTimer();
        if (this._initialTimerId !== null) {
            timerManager.clear(this._initialTimerId);
            this._initialTimerId = null;
        }
        for (const tid of this._masteredTimers.values()) timerManager.clear(tid);
        this._masteredTimers.clear();

        for (const tid of this._checklistDimTimers.values()) timerManager.clear(tid);
        this._checklistDimTimers.clear();
        this._checklistCompletedIds.clear();

        // safety net: kill any untracked timers tagged with this owner
        timerManager.clearByOwner(this);

        this._recentTech.length = 0;
        this._unseenTechCount = 0;

        for (const unsub of this._unsubs) unsub();
        this._unsubs.length = 0;

        if (this._doc && typeof this._doc.removeEventListener === 'function') {
            this._doc.removeEventListener('keydown', this._boundOnKeyDown);
            this._doc.removeEventListener('keydown', this._boundOnExpandedKeyDown, true);
        }

        if (this._chip) { this._chip.destroy(); this._chip = null; }
        if (this._wrapper?.parentNode) this._wrapper.parentNode.removeChild(this._wrapper);
        this._wrapper = null;
        if (this._expandedOverlay?.parentNode) this._expandedOverlay.parentNode.removeChild(this._expandedOverlay);
        if (this._backdrop?.parentNode) this._backdrop.parentNode.removeChild(this._backdrop);

        const styleEl = this._doc && this._doc.getElementById && this._doc.getElementById('skills-pane-styles');
        if (styleEl) styleEl.remove();
    }

    /** @private Build the catalog lookup map and set all states to UNDISCOVERED. */
    _initCatalog() {
        for (const def of this._catalog) {
            this._defMap.set(def.id, def);
            this._states.set(def.id, UNDISCOVERED);
        }
    }

    /** @private Inject the Skills Pane stylesheet (idempotent). */
    _injectStyles() {
        const doc = this._doc;
        if (!doc || !doc.getElementById || doc.getElementById('skills-pane-styles')) return;
        const el = doc.createElement('style');
        el.id = 'skills-pane-styles';
        el.textContent = `
/* ── Discoveries footer-chip popover (Task 10 / locked #7) ─── */
#hud-discoveries:not([data-expanded]) > .skills-pane { display: none !important; }
#hud-discoveries[data-expanded] > .skills-pane { display: block; }
/* Floor 1 only: the F1 bar (WINGS..FURNACE, 48 px buttons x --hud-scale = 60 px at 1.25, on the footer baseline) is centred and
   reaches under the popover on the iPad (measured 2026-10-22: 20 px of overlap). The popover rises to clear it by 8 px. */
body[data-ladder-floor="1"] #hud-discoveries[data-expanded] > .skills-pane {
    bottom: calc(${this._band.bottom}px + 48px * var(--hud-scale, 1) + 8px) !important;
}
#hud-discoveries[data-glass] .sp-header {
    min-height: ${RAIL_GEOMETRY.TOUCH_PITCH_PX}px;
    box-sizing: border-box;
}
.skills-pane {
    position: fixed;
    left: auto;
    right: ${HUD_EDGE_PX}px;
    width: ${HUD_COLUMN_WIDTH_PX}px;
    box-sizing: border-box;
    max-height: ${DISCOVERIES_POPOVER_MAX_PX}px;
    overflow-y: auto;
    background: rgb(var(--hud-ink-rgb, 0 10 20) / 0.85);
    border: 1px solid rgb(var(--hud-normal-rgb, 0 255 136) / 0.25);
    border-radius: 4px;
    padding: 8px 12px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--hud-text, #ccddcc);
    z-index: 200;
    pointer-events: auto;
}

/* ── Compact pane header ───────────────────────────────────────────────── */
.sp-header {
    padding: 2px 0 6px;
    border-bottom: 1px solid rgb(var(--hud-normal-rgb, 0 255 136) / 0.15);
    margin-bottom: 6px;
    font-size: 11px;
    letter-spacing: 1px;
    color: var(--hud-normal, #00ff88);
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
    color: var(--hud-label, #aaa);
}
.sp-entry.sp-suggest { opacity: 0.35; }
.sp-entry.sp-mastered { color: var(--hud-normal, #00ff88); }
.sp-entry.sp-mastered-fade {
    transition: opacity 2s ease-out;
    opacity: 0 !important;
}

/* ── Discovery animation ───────────────────────────────────────────────── */
@keyframes spPulse {
    0%, 100% { text-shadow: 0 0 0 transparent; }
    50%      { text-shadow: 0 0 12px var(--tier-color, var(--hud-normal, #00ff88)); }
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

/* ── Expanded view. Backdrop ──────────────────────────────────────────── */
.sp-backdrop {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgb(var(--hud-ink-rgb, 0 5 10) / 0.75);
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
    background: rgb(var(--hud-ink-rgb, 0 10 20) / 0.95);
    border: 1px solid rgb(var(--hud-normal-rgb, 0 255 136) / 0.35);
    border-radius: 6px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--hud-text, #ccddcc);
    z-index: 9999;
    display: none;
    pointer-events: auto;
    cursor: default;
    overflow: hidden;
    box-shadow: 0 0 40px rgb(var(--hud-normal-rgb, 0 255 136) / 0.08);
}

/* ── Expanded header ───────────────────────────────────────────────────── */
.sp-ex-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 16px;
    border-bottom: 1px solid rgb(var(--hud-normal-rgb, 0 255 136) / 0.2);
    flex-shrink: 0;
}
.sp-ex-back {
    cursor: pointer;
    color: var(--hud-normal, #00ff88);
    font-size: 13px;
    font-weight: bold;
    letter-spacing: 2px;
    user-select: none;
}
.sp-ex-back:hover { opacity: 0.7; }
.sp-ex-count { color: var(--hud-dim, #888); font-size: 11px; }

/* ── Expanded body (scrollable) ────────────────────────────────────────── */
.sp-ex-body {
    flex: 1;
    overflow-y: auto;
    padding: 12px 16px;
    columns: 2;
    column-gap: 20px;
    scrollbar-width: thin;
    scrollbar-color: rgb(var(--hud-normal-rgb, 0 255 136) / 0.2) transparent;
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
    border-bottom: 1px solid rgb(var(--hud-text-rgb, 255 255 255) / 0.08);
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
    color: var(--hud-dim, #888);
}
.sp-ex-entry.spe-undiscovered { opacity: 0.30; }
.sp-ex-entry.spe-discovered   { opacity: 1.0; }
.sp-ex-entry.spe-practiced    { opacity: 0.75; }
.sp-ex-entry.spe-mastered     { opacity: 0.5; }
.sp-ex-entry.spe-mastered .sp-ex-sym { color: var(--hud-normal, #00ff88); }
.sp-ex-entry.spe-locked       { color: var(--hud-warning, #ff4444); opacity: 0.5; }

/* ── Expanded footer ───────────────────────────────────────────────────── */
.sp-ex-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 16px;
    border-top: 1px solid rgb(var(--hud-normal-rgb, 0 255 136) / 0.2);
    font-size: 10px;
    flex-shrink: 0;
}
.sp-prog-text { color: var(--hud-dim, #888); }
.sp-close-hint { color: var(--hud-dim, #555); }

/* ── New Tech section (Discovery Pane) ─────────────────────────────────── */
.sp-tech-entry {
    font-size: 11px;
    color: var(--hud-info, #00e5ff);
    padding: 2px 8px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    opacity: 0.9;
}
.sp-tech-header {
    font-size: 10px;
    color: var(--hud-info, #00e5ff);
    padding: 4px 8px 2px;
    letter-spacing: 1px;
    text-transform: uppercase;
}
.sp-tech-badge {
    background: var(--hud-info, #00e5ff);
    color: var(--hud-ink, #000);
    border-radius: 8px;
    padding: 0 5px;
    font-size: 9px;
    margin-left: 4px;
    display: inline-block;
    vertical-align: middle;
}
.sp-tech-hint {
    font-size: 9px;
    color: rgb(var(--hud-normal-rgb, 136 255 204) / 0.4);
    padding: 2px 8px 4px;
    text-align: right;
}
.sp-tech-sep {
    border: none;
    border-top: 1px solid rgb(var(--hud-info-rgb, 0 229 255) / 0.2);
    margin: 4px 0 2px;
}

/* ── Checklist mode (ST-3.1: NOVICE next-step suggestions) ─────────────── */
.sp-checklist { padding: 6px 8px; font-family: var(--font-mono); font-size: 11px; }
.sp-checklist-header {
    color: var(--hud-dim, #88aabb);
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
    color: var(--hud-caution, #ffaa00);
    font-size: 10px;
    opacity: 0.8;
}
.sp-cl-done {
    color: rgb(var(--hud-normal-rgb, 140 220 160) / 0.85);
    opacity: 1;
    animation: sp-cl-fade-done 3s ease forwards; /* matches CHECKLIST_DONE_LINGER_MS */
}
.sp-cl-done .sp-cl-mark { color: var(--hud-normal, #44ff88); }
@keyframes sp-cl-fade-done {
    0%   { opacity: 1;   background: rgb(var(--hud-normal-rgb, 68 255 136) / 0.15); }
    80%  { opacity: 1;   background: rgb(var(--hud-normal-rgb, 68 255 136) / 0.05); }
    100% { opacity: 0.35; background: transparent; }
}
.sp-cl-current {
    color: var(--tier-color, var(--hud-info, #44ddff));
    font-weight: 600;
    /* Static current-step affordance: steady accent border + faint tint.
     * The attention pulse plays only on step CHANGE (2 iterations, then
     * settles) — the row is rebuilt each _renderChecklist(), so re-adding
     * the class re-triggers the finite animation naturally. No infinite
     * loop → no perpetual flashing rectangle. */
    border-left: 2px solid var(--tier-color, var(--hud-info, #44ddff));
    padding-left: 4px;
    /* Tint derives from --tier-color so it matches the border on non-cyan
     * tiers (was hardcoded cyan rgba(68,221,255,0.06)). color-mix is safe —
     * Chromium-only app. */
    background: color-mix(in srgb, var(--tier-color, var(--hud-info, #44ddff)) 8%, transparent);
    animation: sp-cl-pulse 1.4s ease-in-out 2; /* matches CHECKLIST_PULSE_PERIOD_MS, finite */
}
.sp-cl-current .sp-cl-mark { color: var(--tier-color, var(--hud-info, #44ddff)); }
@keyframes sp-cl-pulse {
    0%, 100% { opacity: 0.78; }
    50%      { opacity: 1;   }
}
@media (prefers-reduced-motion: reduce) {
    .sp-cl-current { animation: none; opacity: 1; }
}
.sp-cl-upcoming {
    color: rgb(var(--hud-label-rgb, 160 160 160) / 0.55);
}
.sp-cl-upcoming .sp-cl-mark { color: rgb(var(--hud-dim-rgb, 120 120 120) / 0.6); }
.sp-checklist-progress {
    margin-top: 6px;
    padding-top: 4px;
    border-top: 1px solid rgb(var(--hud-dim-rgb, 120 140 160) / 0.2);
    font-size: 10px;
    color: var(--hud-dim, #789);
    text-align: right;
}
/* ── ST-3.4: Celebration flash animations ──────────────────────────────── */
/* Duration must match Constants.SKILLS.CELEBRATION.MASTERY_FLASH_MS (1200) */
.sp-flash-mastered {
    animation: sp-flash-mastery 1200ms ease-out;
}
@keyframes sp-flash-mastery {
    0%   { background: rgb(var(--hud-caution-rgb, 255 200 80) / 0.55); box-shadow: 0 0 12px rgb(var(--hud-caution-rgb, 255 200 80) / 0.6); }
    100% { background: transparent; box-shadow: none; }
}
`;
        if (doc.head && typeof doc.head.appendChild === 'function') doc.head.appendChild(el);
    }

    /** @private Build both compact and expanded DOM trees */
    _build() {
        this._buildCompactPane();
        this._buildExpandedView();
    }

    /**
     * @private Build the compact pane: DISCOVERIES footer chip + `.skills-pane` popover inside `#hud-discoveries`;
     * the density bit on the wrapper hides both.
     */
    _buildCompactPane() {
        const doc = this._doc;
        if (!doc || typeof doc.createElement !== 'function') return;

        const wrapper = doc.createElement('div');
        wrapper.id = DISCOVERIES_WRAPPER_ID;
        if (wrapper.setAttribute) {
            // Hidden by default on EVERY floor (as OverridePane.js does at build): `experimental` is the ladder's
            // index 0, every DEFAULT_ROOMS row says 'gone', and the shipped cockpit has no chip. Without this bit
            // the wrapper showed through the translucent MENU on a fresh boot (HUD.hide() hides only
            // `this.panels`). The bit is written ONLY here and by the rung adapter; setVisible(true),
            // _applyInitialDisplay and the chip tap never touch it.
            wrapper.setAttribute('data-density-hidden', '');
            if (this._glass) wrapper.setAttribute('data-glass', '');
        }

        const pane = doc.createElement('div');
        pane.className = 'skills-pane';
        const popBottom = this._band.top + RAIL_GEOMETRY.FOOTER_GAP_PX;
        const ps = pane.style;
        ps.position = 'fixed';
        ps.left = 'auto';
        ps.right = DISCOVERIES_CHIP_RIGHT_CSS;   // right edge lines up with the chip's
        ps.bottom = `${popBottom}px`;
        ps.width = `${HUD_COLUMN_WIDTH_PX}px`;
        ps.maxHeight = `${DISCOVERIES_POPOVER_MAX_PX}px`;
        ps.overflowY = 'auto';
        ps.boxSizing = 'border-box';

        const header = doc.createElement('div');
        header.className = 'sp-header';
        if (this._glass) header.style.minHeight = `${RAIL_GEOMETRY.TOUCH_PITCH_PX}px`;
        const title = doc.createElement('span');
        title.textContent = '▸ DISCOVERIES';
        const count = doc.createElement('span');
        count.className = 'sp-count';
        header.appendChild(title);
        header.appendChild(count);
        if (typeof header.addEventListener === 'function') {
            header.addEventListener('click', () => this.toggleExpanded());
        }
        pane.appendChild(header);
        this._paneHeader = header;

        const body = doc.createElement('div');
        body.className = 'sp-body';
        pane.appendChild(body);
        this._paneBody = body;

        this._chip = createFooterChip({
            id: DISCOVERIES_CHIP_ID,
            label: 'Discoveries',
            side: 'right',
            offsetPx: DISCOVERIES_CHIP_RIGHT_CSS,
            onTap: () => this._toggleChip(),
            doc,
            bottomPx: this._band.bottom,
            glass: this._glass,
            hintBandPx: this._hintBandPx,
            parent: wrapper,
        });

        wrapper.appendChild(pane);
        const host = this._hudContainer || doc.body;
        if (host && typeof host.appendChild === 'function') host.appendChild(wrapper);
        this._wrapper = wrapper;
        this._pane = pane;
        this._setChipExpanded(false);
    }

    /** @private Session-only chip popover (never persisted). */
    _toggleChip() {
        this._setChipExpanded(!this._chipOpen);
    }

    /** @private */
    _setChipExpanded(v) {
        this._chipOpen = !!v;
        if (this._wrapper && this._wrapper.setAttribute) {
            if (this._chipOpen) this._wrapper.setAttribute('data-expanded', '');
            else this._wrapper.removeAttribute('data-expanded');
        }
        if (this._chip) this._chip.setExpanded(this._chipOpen);
    }

    /** @private Build the expanded overlay (backdrop + centered panel); appended to document.body for z-index independence, like CodexViewerUI. */
    _buildExpandedView() {
        const doc = this._doc;
        if (!doc || typeof doc.createElement !== 'function') return;
        const backdrop = doc.createElement('div');
        backdrop.className = 'sp-backdrop';
        if (typeof backdrop.addEventListener === 'function') {
            backdrop.addEventListener('click', () => this._closeExpanded());
        }
        if (doc.body && typeof doc.body.appendChild === 'function') doc.body.appendChild(backdrop);
        this._backdrop = backdrop;

        const overlay = doc.createElement('div');
        overlay.className = 'sp-expanded';

        const header = doc.createElement('div');
        header.className = 'sp-ex-header';
        const backBtn = doc.createElement('span');
        backBtn.className = 'sp-ex-back';
        backBtn.textContent = '◂ SKILL TREE';
        backBtn.title = this._glassNow() ? 'Close' : 'Close (J or ESC)';
        if (typeof backBtn.addEventListener === 'function') {
            backBtn.addEventListener('click', () => this._closeExpanded());
        }
        const exCount = doc.createElement('span');
        exCount.className = 'sp-ex-count';
        header.appendChild(backBtn);
        header.appendChild(exCount);
        overlay.appendChild(header);

        const body = doc.createElement('div');
        body.className = 'sp-ex-body';
        overlay.appendChild(body);
        this._expandedBody = body;

        const footer = doc.createElement('div');
        footer.className = 'sp-ex-footer';
        const progText = doc.createElement('span');
        progText.className = 'sp-prog-text';
        const closeHint = doc.createElement('span');
        closeHint.className = 'sp-close-hint';
        closeHint.textContent = 'I. Info  ·  J to close';
        footer.appendChild(progText);
        footer.appendChild(closeHint);
        overlay.appendChild(footer);

        if (doc.body && typeof doc.body.appendChild === 'function') doc.body.appendChild(overlay);
        this._expandedOverlay = overlay;
    }

    /** @private Subscribe to EventBus events from SkillsSystem. */
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

        this._unsubs.push(
            eventBus.on(Events.TECH_UNLOCKED, (data) => {
                this._recentTech.unshift({
                    id: data.id,
                    title: data.title,
                    shortText: data.shortText,
                    category: data.category,
                    time: Date.now(),
                });
                // keep 10 in memory (_techMaxVisible are shown)
                if (this._recentTech.length > 10) this._recentTech.pop();
                this._unseenTechCount++;
                this._renderCompact();
                this.show();
            })
        );

        // opening the Tech Library clears the unseen badge
        this._unsubs.push(
            eventBus.on(Events.CODEX_OPENED, () => {
                if (this._unseenTechCount > 0) {
                    this._unseenTechCount = 0;
                    this._renderCompact();
                }
            })
        );

        // the first capture exits NOVICE checklist mode
        this._unsubs.push(
            eventBus.on(Events.LASSO_CAPTURED, () => this._exitChecklistMode())
        );
        this._unsubs.push(
            eventBus.on(Events.ARM_CAPTURED, () => this._exitChecklistMode())
        );

        this._unsubs.push(
            eventBus.on(Events.SKILL_STATE_CHANGED, (d) => {
                if (d?.to === 'practiced') this._flashSkillEntry(d.skillId);
            })
        );
        this._unsubs.push(
            eventBus.on(Events.MASTERY_FANFARE, (d) => {
                if (!d?.skillId) return;
                this._flashSkillEntry(d.skillId, 'mastered');
            })
        );
    }

    /** @private SKILL_DISCOVERED: update local state, render compact pane, auto-show. */
    _onSkillDiscovered(data) {
        const { skillId } = data;
        const def = this._defMap.get(skillId);
        if (!def) return;

        this._states.set(skillId, DISCOVERED);
        if (!this._discoveryOrder.includes(skillId)) {
            this._discoveryOrder.push(skillId);
        }
        this._discoveryCount++;

        if (this._checklistMode) {
            this._handleChecklistDiscovery(skillId);
        }

        this._renderCompact(skillId);

        // auto-hides per level policy
        this.show();

        this._checkLevelTransition();
    }

    /**
     * @private Glass is read when text is drawn, never at construction (the hub flips GestureHints AFTER this
     * pane is built). An explicit ctor `glass: false` still wins.
     */
    _glassNow() {
        if (this._glassArg === false) return false;
        return this._glass || GestureHints.isGlass();
    }

    /** @private The key text of a skill row. Desktop: "[S]". Glass: the touch word ("SCAN", "READ MORE") or nothing, never a key in brackets. */
    _keyText(def) {
        if (!def || !def.key) return '';
        if (this._glassNow()) return GestureHints.wordForSkill(def.id);
        return '[' + def.key + ']';
    }

    /** @private SKILL_STATE_CHANGED: update the state map and visible entries; start the mastered-fade when due. */
    _onSkillStateChanged(data) {
        const { skillId, to } = data;
        this._states.set(skillId, to);

        if (this._visible && this._paneBody) {
            const el = this._paneBody.querySelector(`[data-skill-id="${skillId}"]`);
            if (el) {
                const symEl = el.querySelector('.sp-sym');
                if (to === MASTERED) {
                    if (symEl) { symEl.textContent = '✓'; symEl.style.color = 'var(--hud-normal, #00ff88)'; }
                    el.classList.add('sp-mastered');
                    const lblEl = el.querySelector('.sp-lbl');
                    if (lblEl) lblEl.style.color = 'var(--hud-normal, #00ff88)';

                    if (!this._masteredTimers.has(skillId)) {
                        const tid = timerManager.setTimeout(() => {
                            el.classList.add('sp-mastered-fade');
                            this._masteredTimers.delete(skillId);
                            // remove the node after the opacity transition
                            timerManager.setTimeout(() => { if (el.parentNode) el.remove(); }, 2100, { owner: this });
                        }, Constants.SKILLS.MASTERED_FADE_DELAY, { owner: this });
                        this._masteredTimers.set(skillId, tid);
                    }
                } else if (to === PRACTICED) {
                    if (symEl) symEl.textContent = '●';
                }
            }
        }
    }

    /** @private SKILL_REMINDED: show the compact pane with the reminded skill highlighted. */
    _onSkillReminded(data) {
        const { skillId } = data;
        if (!this._masterVisible) return;
        if (!this._defMap.has(skillId)) return;
        // The pane lists the skill's KEY name; on glass a reminder for a key with no touch control is not shown
        // (same gate as OnboardingDirector._onSkillReminded). Desktop: always.
        if (!GestureHints.reminderFitsGlass(this._defMap.get(skillId), skillId)) return;

        this._renderCompact(skillId);
        this.show(Constants.SKILLS.PANE_SHOW_DURATION);
    }

    /** @private SKILLS_LOADED (SkillsSystem.restore() on a loaded save): bulk-update the state map. */
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

        // a loaded save may jump straight to APPRENTICE/VETERAN behavior
        this._lastLevelSeen = this._getExperienceLevel();
        // exit the checklist if the loaded save is beyond NOVICE
        if (this._checklistMode && this._lastLevelSeen !== 'novice') {
            this._checklistMode = false;
            this._checklistCompletedIds.clear();
        }
        this._applyInitialDisplay();
    }

    /**
     * @private Rebuild the compact pane body: recently active skills (newest first), then undiscovered
     * suggestions to fill the remaining slots.
     * @param {string|null} [highlightId=null] — Skill to highlight with animation
     */
    _renderCompact(highlightId = null) {
        if (this._checklistMode && this._getExperienceLevel() === 'novice') {
            this._renderChecklist();
            return;
        }
        this._paneBody.innerHTML = '';

        // sub-header only if there is tech to show too
        if (this._recentTech.length > 0) {
            const skillsHdr = document.createElement('div');
            skillsHdr.style.cssText = 'font-size:10px;color:var(--hud-normal, #00ff88);padding:2px 0 1px;letter-spacing:1px;opacity:0.7;';
            skillsHdr.textContent = 'SKILLS';
            this._paneBody.appendChild(skillsHdr);
        }

        // active skills (discovered / practiced / mastered), most recent first
        const active = [];
        for (let i = this._discoveryOrder.length - 1; i >= 0; i--) {
            const id = this._discoveryOrder[i];
            const st = this._states.get(id);
            if (st === DISCOVERED || st === PRACTICED || st === MASTERED) {
                active.push(id);
            }
            if (active.length >= MAX_COMPACT_ACTIVE) break;
        }

        // suggestions: undiscovered with prereqs met
        const suggestions = this._getSuggestions(MAX_COMPACT_SUGGEST);

        for (const id of active) {
            const el = this._createCompactEntry(id, id === highlightId);
            this._paneBody.appendChild(el);
        }

        for (const def of suggestions) {
            const el = this._createCompactEntry(def.id, false, true);
            this._paneBody.appendChild(el);
        }

        if (this._recentTech.length > 0) {
            const sep = document.createElement('hr');
            sep.className = 'sp-tech-sep';
            this._paneBody.appendChild(sep);

            const techHdr = document.createElement('div');
            techHdr.className = 'sp-tech-header';
            let hdrHTML = 'NEW TECH';
            if (this._unseenTechCount > 0) {
                hdrHTML += ` <span class="sp-tech-badge">${this._unseenTechCount}</span>`;
            }
            techHdr.innerHTML = hdrHTML;
            this._paneBody.appendChild(techHdr);

            const visibleTech = this._recentTech.slice(0, this._techMaxVisible);
            for (const tech of visibleTech) {
                const entry = document.createElement('div');
                entry.className = 'sp-tech-entry';
                entry.textContent = `▸ ${tech.title}`;
                entry.title = GestureHints.glassWords(tech.shortText || '');
                this._paneBody.appendChild(entry);
            }

            const hint = document.createElement('div');
            hint.className = 'sp-tech-hint';
            hint.textContent = 'I. Info';
            this._paneBody.appendChild(hint);
        }

        this._updateCountBadges();
    }

    /**
     * @private Render the NOVICE checklist into _paneBody: CHECKLIST_SUGGESTION_COUNT (n) items as ✓ / → / ○,
     * recently-completed ones fading out; always exactly n (completed + suggestions).
     */
    _renderChecklist() {
        this._paneBody.innerHTML = '';
        const cfg = Constants.SKILLS.DISCOVERY_PANE;
        const n = cfg.CHECKLIST_SUGGESTION_COUNT;
        const { discovered, total } = this._getProgress();

        // completed items take priority slots
        const completedToShow = [...this._checklistCompletedIds].slice(0, n);
        const suggestionsNeeded = Math.max(n - completedToShow.length, 0);
        const suggestions = this._getSuggestions(suggestionsNeeded);

        const wrap = document.createElement('div');
        wrap.className = 'sp-checklist';

        const hdr = document.createElement('div');
        hdr.className = 'sp-checklist-header';
        hdr.textContent = '▸ NEXT STEPS';
        wrap.appendChild(hdr);

        const items = document.createElement('div');
        items.className = 'sp-checklist-items';

        for (const completedId of completedToShow) {
            const def = this._defMap.get(completedId);
            if (!def) continue;
            const item = document.createElement('div');
            item.className = 'sp-cl-item sp-cl-done';
            item.innerHTML =
                `<span class="sp-cl-mark">✓</span>` +
                `<span class="sp-cl-label">${GestureHints.glassWords(def.label)}</span>` +
                `<span class="sp-cl-key">${this._keyText(def)}</span>`;
            items.appendChild(item);
        }

        // first suggestion = current (→ pulse), rest = upcoming (○)
        let isFirst = true;
        for (const def of suggestions) {
            const tierColor = this._getTierColor(def.tier);
            const item = document.createElement('div');
            if (isFirst) {
                item.className = 'sp-cl-item sp-cl-current';
                item.style.setProperty('--tier-color', tierColor);
                item.innerHTML =
                    `<span class="sp-cl-mark">→</span>` +
                    `<span class="sp-cl-label">${GestureHints.glassWords(def.label)}</span>` +
                    `<span class="sp-cl-key">${this._keyText(def)}</span>`;
                isFirst = false;
            } else {
                item.className = 'sp-cl-item sp-cl-upcoming';
                item.innerHTML =
                    `<span class="sp-cl-mark">○</span>` +
                    `<span class="sp-cl-label">${GestureHints.glassWords(def.label)}</span>` +
                    `<span class="sp-cl-key">${this._keyText(def)}</span>`;
            }
            items.appendChild(item);
        }

        wrap.appendChild(items);

        const prog = document.createElement('div');
        prog.className = 'sp-checklist-progress';
        prog.innerHTML =
            `<span class="sp-cl-progress-count">${discovered}</span>/` +
            `<span class="sp-cl-progress-total">${total}</span> skills discovered`;
        wrap.appendChild(prog);

        this._paneBody.appendChild(wrap);
        this._updateCountBadges();
    }

    /** @private A discovery in checklist mode: add to the completed set with a linger timer, then re-render. */
    _handleChecklistDiscovery(skillId) {
        const cfg = Constants.SKILLS.DISCOVERY_PANE;
        this._checklistCompletedIds.add(skillId);

        if (this._checklistDimTimers.has(skillId)) {
            timerManager.clear(this._checklistDimTimers.get(skillId));
        }

        const tid = timerManager.setTimeout(() => {
            this._checklistCompletedIds.delete(skillId);
            this._checklistDimTimers.delete(skillId);
            this._renderCompact(); // re-renders checklist if still in novice mode
        }, cfg.CHECKLIST_DONE_LINGER_MS, { owner: this });
        this._checklistDimTimers.set(skillId, tid);
    }

    /** @private Exit checklist mode: clear pending dim timers, re-render the normal compact view. */
    _exitChecklistMode() {
        if (!this._checklistMode) return;
        this._checklistMode = false;
        for (const tid of this._checklistDimTimers.values()) timerManager.clear(tid);
        this._checklistDimTimers.clear();
        this._checklistCompletedIds.clear();
        this._renderCompact();
    }

    /**
     * @private Create one compact skill entry element.
     * @param {boolean} [isHighlight=false] — play discovery animation
     * @param {boolean} [isSuggestion=false] — dimmed suggestion styling
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

        const sym = document.createElement('span');
        sym.className = 'sp-sym';
        sym.textContent = isSuggestion ? '○' : (STATE_SYMBOLS[state] || '●');
        if (state === MASTERED) {
            sym.style.color = 'var(--hud-normal, #00ff88)';
        } else if (!isSuggestion) {
            sym.style.color = color;
        }
        entry.appendChild(sym);

        const lbl = document.createElement('span');
        lbl.className = 'sp-lbl';
        lbl.textContent = def ? GestureHints.glassWords(def.label) : skillId;
        if (!isSuggestion) {
            lbl.style.color = state === MASTERED ? 'var(--hud-normal, #00ff88)' : color;
        }
        entry.appendChild(lbl);

        const keyEl = document.createElement('span');
        keyEl.className = 'sp-key';
        if (def && def.key) keyEl.textContent = this._keyText(def);
        entry.appendChild(keyEl);

        if (isHighlight && !isSuggestion) {
            entry.style.setProperty('--tier-color', color);
            entry.classList.add('sp-pulse', 'sp-slide');
            const cleanup = () => entry.classList.remove('sp-pulse', 'sp-slide');
            entry.addEventListener('animationend', cleanup, { once: true });
        }

        return entry;
    }

    /** @private Rebuild the expanded overlay body: skills grouped by category, sorted by tier within each. */
    _renderExpanded() {
        this._expandedBody.innerHTML = '';

        const groups = {};
        for (const cat of Object.keys(CATEGORY_META)) groups[cat] = [];
        for (const def of this._catalog) {
            const g = groups[def.category];
            if (g) g.push(def);
        }

        const sortedCats = Object.keys(CATEGORY_META)
            .sort((a, b) => CATEGORY_META[a].order - CATEGORY_META[b].order);

        for (const cat of sortedCats) {
            const defs = groups[cat];
            if (!defs || defs.length === 0) continue;

            defs.sort((a, b) => a.tier !== b.tier ? a.tier - b.tier : a.label.localeCompare(b.label));

            const catDiscovered = defs.filter(
                d => this._states.get(d.id) !== UNDISCOVERED
            ).length;

            // header colour = the first skill's tier colour
            const catColor = this._getTierColor(defs[0].tier);

            const section = document.createElement('div');
            section.className = 'sp-cat';

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

            for (const def of defs) {
                section.appendChild(this._createExpandedEntry(def));
            }

            this._expandedBody.appendChild(section);
        }

        const progress = this._getProgress();
        const progEl = this._expandedOverlay.querySelector('.sp-prog-text');
        if (progEl) {
            progEl.textContent = `${progress.discovered} / ${progress.total} skills discovered`;
        }
        this._updateCountBadges();
    }

    /**
     * @private Create one expanded skill entry. Safety-gated undiscovered skills show a filled square with red
     * tint and a LOCKED tooltip (the 14px symbol slot cannot hold the word).
     * @param {Object} def — Skill definition from CATALOG
     */
    _createExpandedEntry(def) {
        const state = this._states.get(def.id) || UNDISCOVERED;
        const tierColor = this._getTierColor(def.tier);
        const isLocked = !!(def.safetyGate) && state === UNDISCOVERED;

        const entry = document.createElement('div');
        entry.className = 'sp-ex-entry';
        entry.dataset.skillId = def.id;

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

        const sym = document.createElement('span');
        sym.className = 'sp-ex-sym';
        if (isLocked) {
            sym.textContent = '■';
            entry.title = 'LOCKED';
        } else {
            sym.textContent = STATE_SYMBOLS[state] || '○';
            if (state === MASTERED) {
                sym.style.color = 'var(--hud-normal, #00ff88)';
            } else if (state !== UNDISCOVERED) {
                sym.style.color = tierColor;
            } else {
                sym.style.color = tierColor;
                sym.style.opacity = '0.4';
            }
        }
        entry.appendChild(sym);

        const lbl = document.createElement('span');
        lbl.className = 'sp-ex-lbl';
        lbl.textContent = GestureHints.glassWords(def.label);
        if (state !== UNDISCOVERED && !isLocked) {
            lbl.style.color = state === MASTERED ? 'var(--hud-normal, #00ff88)' : tierColor;
        }
        entry.appendChild(lbl);

        const keyEl = document.createElement('span');
        keyEl.className = 'sp-ex-key';
        if (def.key) keyEl.textContent = this._keyText(def);
        entry.appendChild(keyEl);

        return entry;
    }

    /**
     * @private Flash a skill row on PRACTICED (tier colour, inline style + CSS transition) or MASTERED (gold,
     * keyframe class sp-flash-mastered in _injectStyles).
     * @param {'practiced'|'mastered'} [kind='practiced']
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
                el.classList.remove('sp-flash-mastered');
                void el.offsetWidth;
                el.classList.add('sp-flash-mastered');
                timerManager.setTimeout(() => el.classList.remove('sp-flash-mastered'), dur + 100, { owner: this });
            } else {
                const def = this._defMap?.get(skillId);
                const tierColor = def ? this._getTierColor(def.tier) : 'var(--hud-info, #44ddff)';
                el.style.transition = 'none';
                el.style.background = `color-mix(in srgb, ${tierColor} 35%, transparent)`; // 35% of the tier colour (tierColor may be a var())
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

    /**
     * @private Fade the compact pane: NOVICE to 85% idle and APPRENTICE to 45% idle (both stay rendered); VETERAN
     * fades out and sets display:none.
     */
    _fadeOut() {
        const level = this._getExperienceLevel();
        const cfg = EXPERIENCE_LEVELS[level.toUpperCase()];

        if (level === 'novice' || level === 'apprentice') {
            this._fadeToIdle(cfg.idleOpacity);
            return;
        }

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
            // reset so the next show() starts clean
            p.style.transition = '';
            p.style.opacity = '';
            p.style.transform = '';
        }, dur + 50, { owner: this });
    }

    /** @private Fade to a target idle opacity (0..1) while keeping it rendered (display:block); NOVICE 0.85, APPRENTICE 0.45. */
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
        this._visible = true;
    }

    /** @private Initial display on game start: NOVICE and APPRENTICE see the pane at idle opacity; VETERAN stays hidden. */
    _applyInitialDisplay() {
        if (!this._masterVisible) return;
        const level = this._getExperienceLevel();
        if (level === 'veteran') return; // awaits a discovery
        this._renderCompact();
        const cfg = EXPERIENCE_LEVELS[level.toUpperCase()];
        this._fadeToIdle(cfg.idleOpacity);
    }

    /** @private Hide the compact pane immediately (no animation). */
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

    /** @private Schedule a fade-out after `delayMs`. */
    _scheduleHide(delayMs) {
        this._cancelHideTimer();
        this._hideTimerId = timerManager.setTimeout(() => {
            this._hideTimerId = null;
            this._fadeOut();
        }, delayMs, { owner: this });
    }

    /** @private */
    _cancelHideTimer() {
        if (this._hideTimerId !== null) {
            timerManager.clear(this._hideTimerId);
            this._hideTimerId = null;
        }
    }

    /** @private */
    _cancelFadeTimer() {
        if (this._fadeEndTimerId !== null) {
            timerManager.clear(this._fadeEndTimerId);
            this._fadeEndTimerId = null;
        }
    }

    /**
     * @private How long (ms, always > 0) the pane stays at 100% before fading to idle (NOVICE/APPRENTICE) or
     * disappearing (VETERAN). The first FIRST_DISCOVERY_LONG_COUNT discoveries use the longer per-level duration.
     * @param {string} [level] — 'novice' | 'apprentice' | 'veteran'
     */
    _getShowDuration(level) {
        const lvl = level || this._getExperienceLevel();
        if (lvl === 'novice') {
            return NOVICE_BRIGHTEN_MS;
        }
        const cfg = EXPERIENCE_LEVELS[lvl.toUpperCase()];
        const isFirst = this._discoveryCount <= FIRST_DISCOVERY_LONG_COUNT;
        return isFirst ? cfg.firstDiscoveryMs : cfg.autoHideMs;
    }

    /**
     * @private Count of skills in any state beyond 'undiscovered' (from `_states`, kept in sync by the
     * SKILL_DISCOVERED / SKILLS_LOADED handlers).
     */
    _getDiscoveredSkillCount() {
        let n = 0;
        for (const state of this._states.values()) {
            if (state !== UNDISCOVERED) n++;
        }
        return n;
    }

    /**
     * @private Experience level by discovered-skill count: NOVICE < 5, APPRENTICE 5..14, VETERAN ≥ 15.
     * @returns {'novice'|'apprentice'|'veteran'}
     */
    _getExperienceLevel() {
        const count = this._getDiscoveredSkillCount();
        if (count < EXPERIENCE_LEVELS.APPRENTICE.threshold) return 'novice';
        if (count < EXPERIENCE_LEVELS.VETERAN.threshold)    return 'apprentice';
        return 'veteran';
    }

    /** @private Log a level transition (dev visibility); called after discoveries that may cross a threshold. */
    _checkLevelTransition() {
        const newLevel = this._getExperienceLevel();
        if (newLevel !== this._lastLevelSeen) {
            console.log('[SkillsPane] Level advanced:', this._lastLevelSeen, '→', newLevel);
            // leaving novice disables the checklist
            if (this._checklistMode && newLevel !== 'novice') {
                this._exitChecklistMode();
            }
            this._lastLevelSeen = newLevel;
        }
    }

    /** @private Open the expanded skill tree overlay: hides the compact pane, renders the full list, installs the capture-phase key listener. */
    _openExpanded() {
        this._expanded = true;

        this._hideImmediate();

        this._renderExpanded();

        const bd = this._backdrop;
        bd.style.display = 'block';
        bd.style.opacity = '0';
        bd.style.transition = 'opacity 200ms ease-out';
        void bd.offsetHeight;
        bd.style.opacity = '1';

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

    /** @private Fade out the expanded overlay and remove the capture-phase listener. */
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

    /** @private Bubble-phase keydown: J toggles the Journal view when not already expanded (the capture handler owns J/ESC while open). */
    _onKeyDown(e) {
        if (e.code !== 'KeyJ') return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (this._expanded) return;

        e.preventDefault();
        this.toggleExpanded();
    }

    /** @private Capture-phase keydown, active ONLY while the expanded overlay is open: ESC or J closes it; everything else is suppressed. */
    _onExpandedKeyDown(e) {
        e.preventDefault();
        e.stopPropagation();

        if (e.code === 'Escape' || e.code === 'KeyJ') {
            this._closeExpanded();
        }
    }

    /** @private Colour for a 1-based tier number from Constants.SKILLS.TIERS. */
    _getTierColor(tierNum) {
        const tier = this._tiers.find(t => t.tier === tierNum);
        // Tier colours are identity colours (each tier its own hue), so they stay raw in both looks;
        // mapping them to roles made tiers 2-4 one cyan.
        return tier ? tier.color : 'var(--hud-text, #ccddcc)';
    }

    /** @private Undiscovered skills whose prerequisites are met (skips noReminder), by tier then label, at most `n`. */
    _getSuggestions(n = 2) {
        const result = [];
        for (const def of this._catalog) {
            if (this._states.get(def.id) !== UNDISCOVERED) continue;
            if (def.noReminder) continue;
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

    /** @private @returns {{ discovered: number, total: number }} */
    _getProgress() {
        let discovered = 0;
        for (const state of this._states.values()) {
            if (state !== UNDISCOVERED) discovered++;
        }
        return { discovered, total: this._states.size };
    }

    /** @private Update the [X/Y] count badge in both headers. */
    _updateCountBadges() {
        const { discovered, total } = this._getProgress();
        const text = `[${discovered}/${total}]`;

        const compactEl = this._pane?.querySelector('.sp-count');
        if (compactEl) compactEl.textContent = text;

        const expandedEl = this._expandedOverlay?.querySelector('.sp-ex-count');
        if (expandedEl) expandedEl.textContent = text;
    }
}
