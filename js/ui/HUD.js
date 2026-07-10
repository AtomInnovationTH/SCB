/**
 * HUD.js — Main heads-up display overlay (thin coordinator).
 * Delegates rendering to sub-panel modules: StatusPanel, TargetPanel, CommsPanel.
 * Owns event routing, timing, data caching, warnings, and view-config management.
 * Integrates DebrisWireframe above TargetPanel in a unified right column.
 * @module ui/HUD
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { GameStates } from '../core/GameState.js';
import timerManager from '../systems/TimerManager.js';
import { StatusPanel } from './hud/StatusPanel.js';
import { TargetPanel } from './hud/TargetPanel.js';
import { CommsPanel } from './hud/CommsPanel.js';
import { HintTicker } from './hud/HintTicker.js';
import { NetInventoryPanel } from './hud/NetInventoryPanel.js';
 import { DebrisWireframe }   from './DebrisWireframe.js';
 import { DaughterWireframe } from './DaughterWireframe.js';
import { StrutLabels }       from './hud/StrutLabels.js';
import { updateDriftWarning, updateThrusterBlocks } from '../systems/CoMCalculator.js';

/** Camera view → HUD info-level mapping */
const VIEW_INFO_LEVELS = {
  FIRST_PERSON: {
    showTargetList: true, showResources: true, showNavSphere: true,
    showComms: true, showArms: true, showProgress: true, showWarnings: true,
    showAnalysis: true,
    showClosureRate: true,
    showVelocityVectors: true,
    hudOpacity: 1.0, label: 'COCKPIT VIEW',
  },
  CHASE: {
    showTargetList: true, showResources: true, showNavSphere: true,
    showComms: false, showArms: true, showProgress: false, showWarnings: true,
    showAnalysis: true,
    showClosureRate: true,
    showVelocityVectors: true,
    hudOpacity: 0.85, label: 'COMMAND VIEW',
  },
  TARGET_LOCK: {
    // Unreachable as of 2026-06-03 (TARGET_LOCK dropped from the V-cycle in
    // CameraSystem). Retained for possible re-enable; see CameraSystem VIEW_CYCLE.
    showTargetList: true, showResources: true, showNavSphere: true,
    showComms: false, showArms: true, showProgress: false, showWarnings: true,
    showAnalysis: true,
    showClosureRate: true,
    showVelocityVectors: true,
    hudOpacity: 0.85, label: 'TARGET LOCK',
  },
  ORBIT: {
    showTargetList: false, showResources: false, showNavSphere: false,
    showComms: false, showArms: false, showProgress: false, showWarnings: true,
    showAnalysis: false,
    showClosureRate: false,
    showVelocityVectors: false,
    hudOpacity: 0.6, label: 'OVERVIEW',
  },
  // INSPECTION (2026-06-03 rev. 2): no longer a V-cycle view. Used by the
  // discrete bare-I shortcut and the ARM_PILOT / debris-locked contextual
  // wireframe path. (The OVERVIEW zoom-driven mothership inspection sub-state
  // keeps the view as ORBIT and therefore uses the ORBIT config above; its
  // inspection cues are the wireframe overlay, hull outline, vignette + narrow
  // FOV rather than extra HUD panels.) Keeps target detail/arms readouts: the
  // debris subject expands the right-column wireframe; the mother subject hides
  // the right column via the INSPECTION_TOGGLE handler.
  INSPECTION: {
    showTargetList: false, showResources: true, showNavSphere: false,
    showComms: false, showArms: true, showProgress: false, showWarnings: true,
    showAnalysis: true,
    showClosureRate: false,
    showVelocityVectors: false,
    hudOpacity: 0.8, label: 'INSPECT',
  },
  ARM_PILOT: {
    showTargetList: false, showResources: true, showNavSphere: false,
    showComms: true, showArms: true, showProgress: false, showWarnings: true,
    showAnalysis: true,
    showClosureRate: true,
    showVelocityVectors: false,
    hudOpacity: 0.9, label: 'DAUGHTER PILOT',
  },
};

export { VIEW_INFO_LEVELS };

/**
 * Map CATALOG hudGroup names → DOM data-hud-group attribute values.
 * A single CATALOG group can activate multiple DOM groups.
 * @type {Object<string, string[]>}
 */
const SKILL_GROUP_TO_DOM = {
  'score':       ['score-group'],      // activated by timer in GameFlowManager, not a skill
  'targets':     ['target-list'],
  'target-info': ['target-detail'],
  'propulsion':  ['fuel-group'],
  'orbit-mfd':   ['fuel-group'],       // shares fuel section
  'fleet':       ['arms-group', 'cargo-group'],  // deploying arms is prereq for cargo
  'power':       ['power-group', 'thermal-group'],
};

/** All DOM data-hud-group values that participate in skill-based revelation */
const ALL_REVEAL_GROUPS = [
  'score-group', 'target-list', 'target-detail',
  'fuel-group', 'arms-group', 'cargo-group',
  'power-group', 'thermal-group',
];

export class HUD {
  constructor() {
    this.container = document.getElementById('hud-overlay');
    this.visible = false;
    this.panels = {};
    this._warningQueue = [];
    this._warningTimer = 0;
    this._updateTimers = { resources: 0, targets: 0, warnings: 0, comms: 0 };
    this._controlsHintTimer = 30; // seconds until fade
    this._firstPlay = true;

    /** @type {boolean} Whether skill-based HUD revelation is active (always true — Sprint 3) */
    this._skillRevealActive = true;
    /** @type {Set<string>} Active CATALOG hudGroup names (e.g. 'targets', 'fleet') */
    this._skillActiveGroups = new Set();

    /** @type {object|null} Current camera-view info config */
    this._currentViewConfig = null;

    // Cached data
    this._cachedTargets = [];
    this._cachedUntracked = [];
    this._cachedActiveSats = [];
    this._score = 0;
    this._credits = 0;
    this._debrisCleared = 0;
    this._totalMassKg = 0;
    this._resources = { xenon: 100, coldGas: 20, battery: 100, solarRate: 0 };
    this._targetInfo = null;

    // Sub-panels
    this.statusPanel = null;
    this.targetPanel = null;
    this.commsPanel = null;
    // UX-11 #9: radialMenu removed (C-hold radial retired)
    /** @type {DebrisWireframe|null} Integrated wireframe analysis */
    this.debrisWireframe = null;
    /** @type {DaughterWireframe|null} Daughter arm part-callout panel */
    this.daughterWireframe = null;
    /** @type {StrutLabels|null} Screen-space strut tip labels */
    this.strutLabels = null;
    /** @type {NetInventoryPanel|null} Lasso/net inventory chips */
    this.netInventoryPanel = null;
    /** @type {object|null} Last tracked piloted arm */
    this._lastPilotedArm = null;
    /** @type {number} Last piloted arm index */
    this._lastArmIndex = 0;
    /** @type {HTMLElement|null} Right-column container for wireframe + target list */
    this._rightColumn = null;
    /** @type {number} Cached right-column top position (UX-2 #11 dynamic layout) */
    this._lastRightColTop = 0;

    // Sprint 2 / PR E — cached comms-panel bottom (in CSS px). Avoids a
    // per-frame `getBoundingClientRect()` synchronous-layout flush in
    // [`HUD.update()`](js/ui/HUD.js:835). Recomputed only on:
    //   - window resize
    //   - VIEW_CONFIG_CHANGE (comms panel may show/hide)
    //   - first access (lazy init via `_recomputeCommsRectCache()`)
    /** @type {number|null} */
    this._commsRectBottom = null;

    this._build();
    this._setupEventListeners();
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
    this.container.appendChild(div);
    return div;
  }

  /** @private */
  _build() {
    // --- Right-column container (wireframe + target list) ---
    this._rightColumn = document.createElement('div');
    this._rightColumn.id = 'hud-right-column';
    this._rightColumn.tabIndex = -1; // Prevent Tab focus capture (game keys on document)
    Object.assign(this._rightColumn.style, {
      position: 'absolute',
      top: '446px',         // Below NavSphere (UX-2 #11: 160 margin + 280 diameter + 6 gap)
      right: '0px',
      width: '280px',       // Match NavSphere diameter for aligned left edges
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      maxHeight: 'calc(100vh - 480px)',  // Adjusted for new top offset
      overflowY: 'auto',
      zIndex: '10',
      outline: 'none', // No focus ring
    });
    this.container.appendChild(this._rightColumn);

    // --- Wireframe container (mounts inside right column) ---
    const wireframeContainer = document.createElement('div');
    wireframeContainer.id = 'hud-wireframe-container';
    wireframeContainer.dataset.hudGroup = 'target-detail';
    wireframeContainer.dataset.activateKey = 'Tab';
    this._rightColumn.appendChild(wireframeContainer);
    this.debrisWireframe = new DebrisWireframe(wireframeContainer);

    // MotherWireframe (2D pane) removed 2026-06-03 — replaced by in-world 3D
    // inspection callouts (ui/MotherCallouts.js, owned by main.js). The player
    // no longer looks back and forth between the ship and a separate schematic.

    // --- DaughterWireframe (floating, bottom-left — Delegation 3) ---
    this.daughterWireframe = new DaughterWireframe();

    // --- StrutLabels (DOM screen-space labels — Delegation 3) ---
    this.strutLabels = new StrutLabels();

    // --- Instantiate sub-panels ---
    this.statusPanel = new StatusPanel(this.container);
    // TargetPanel mounts inside the right column (below wireframe)
    this.targetPanel = new TargetPanel(this._rightColumn);
    // Delegation 4 (2026-05-31) — lasso + net inventory chips, just below
    // the target list inside the right column. Subscribes to
    // LASSO_AMMO_CHANGED and NET_INVENTORY_CHANGED; emits INVENTORY_LOW
    // (with HOUSTON comms) when totals cross the thresholds defined in
    // [`Constants.INVENTORY`](js/core/Constants.js:1).  Dependencies are
    // injected later via setArmManager / setLassoSystem.
    this.netInventoryPanel = new NetInventoryPanel(this._rightColumn);
    this.commsPanel = new CommsPanel(this.container);
    // UX-11 #9: RadialMenu (C-hold command wheel) removed — every action has
    // a direct key (D deploy, Shift+R recall all, 1-4 select/pilot, Ctrl+Shift+D deorbit).
    // Delegation 2 (2026-05-31): bottom-screen onboarding hint ticker.
    // Mounted on document.body so the strip sits above the notification slot
    // (which lives at viewport bottom) regardless of HUD overlay visibility.
    this.hintTicker = new HintTicker();

    // --- Warning Strip (bottom center) ---
    this.panels.warnings = this._createPanel('hud-warnings-panel', {
      bottom: '170px', left: '50%', transform: 'translateX(-50%)',
      minWidth: '300px', textAlign: 'center',
    });
    this.panels.warnings.style.display = 'none';
    this.panels.warnings.innerHTML = `
      <div id="hud-warning-text" style="color:#ff4444;font-size:12px;font-weight:bold;"></div>
    `;

    // --- Interaction Progress (center, shown during interaction) ---
    this.panels.progress = this._createPanel('hud-progress-panel', {
      top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
      textAlign: 'center', minWidth: '200px',
    });
    this.panels.progress.style.display = 'none';
    this.panels.progress.innerHTML = `
      <div id="hud-progress-content" style="font-size:12px;"></div>
    `;

    // --- Conjunction Alert Overlay (center-top, Sprint C1) ---
    this._conjunctionPanel = document.createElement('div');
    this._conjunctionPanel.id = 'hud-conjunction-panel';
    Object.assign(this._conjunctionPanel.style, {
      position: 'absolute', top: '60px', left: '50%',
      transform: 'translateX(-50%)', minWidth: '280px', maxWidth: '340px',
      textAlign: 'center', display: 'none',
      background: 'rgba(0,0,0,0.88)', border: '1px solid',
      borderRadius: '4px', padding: '10px 18px', zIndex: '120',
      fontFamily: "'Courier New', monospace",
    });
    this._conjunctionPanel.innerHTML = `
      <div id="hud-conjunction-header"
           style="font-size:13px;font-weight:bold;letter-spacing:2px;"></div>
      <div id="hud-conjunction-details"
           style="font-size:11px;margin-top:6px;opacity:0.92;line-height:1.5;"></div>
    `;
    this.container.appendChild(this._conjunctionPanel);

    // --- Launch Phase Banner (ST-9.11 C-5) ---
    // TODO: visual cinematic — replace text banner with 3D launch sequence overlay
    this._launchBanner = document.createElement('div');
    this._launchBanner.id = 'hud-launch-banner';
    Object.assign(this._launchBanner.style, {
      position: 'absolute', top: '100px', left: '50%',
      transform: 'translateX(-50%)', minWidth: '320px', maxWidth: '400px',
      textAlign: 'center', display: 'none',
      background: 'rgba(0,0,0,0.92)', border: '1px solid rgba(0,200,255,0.5)',
      borderRadius: '4px', padding: '12px 24px', zIndex: '130',
      fontFamily: "'Courier New', monospace", color: '#00ccff',
      letterSpacing: '1.5px', fontSize: '13px',
    });
    this._launchBanner.innerHTML = `
      <div id="hud-launch-phase" style="font-weight:bold;font-size:14px;letter-spacing:2px;"></div>
      <div id="hud-launch-detail" style="font-size:11px;margin-top:6px;opacity:0.85;"></div>
    `;
    this.container.appendChild(this._launchBanner);

    // --- Pause Overlay ---
    this._pauseOverlay = document.createElement('div');
    this._pauseOverlay.id = 'hud-pause-overlay';
    Object.assign(this._pauseOverlay.style, {
      position: 'absolute',
      top: '0', left: '0', width: '100%', height: '100%',
      display: 'none',
      background: 'rgba(0, 10, 20, 0.7)',
      zIndex: '150',
      pointerEvents: 'auto',
      fontFamily: "'Courier New', monospace",
    });
    this._pauseOverlay.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;">
        <div style="font-size:2rem;color:#00ff88;letter-spacing:0.3em;margin-bottom:2rem;
                    text-shadow:0 0 20px rgba(0,255,136,0.5);">PAUSED</div>
        <div id="pause-resume-btn" style="font-size:1rem;color:#00ff88;cursor:pointer;padding:10px 30px;
            border:1px solid rgba(0,255,136,0.5);border-radius:4px;margin:8px;
            background:rgba(0,255,136,0.1);letter-spacing:0.15em;">
            RESUME [ESC]
        </div>
        <div id="pause-menu-btn" style="font-size:1rem;color:#ffaa00;cursor:pointer;padding:10px 30px;
            border:1px solid rgba(255,170,0,0.4);border-radius:4px;margin:8px;
            background:rgba(255,170,0,0.08);letter-spacing:0.15em;">
            MAIN MENU
        </div>
      </div>
    `;
    this.container.appendChild(this._pauseOverlay);

    // Pause button handlers (S1 Fix L1: use Events constants instead of raw strings)
    this._pauseOverlay.querySelector('#pause-resume-btn').addEventListener('click', () => {
      eventBus.emit(Events.PAUSE_RESUME);
    });
    this._pauseOverlay.querySelector('#pause-menu-btn').addEventListener('click', () => {
      eventBus.emit(Events.PAUSE_MENU);
    });

    // Aggregate sub-panel DOM elements into this.panels for show/hide
    Object.assign(this.panels, this.statusPanel.panels);
    Object.assign(this.panels, this.targetPanel.panels);
    Object.assign(this.panels, this.commsPanel.panels);

    // --- Weather Indicator Container (top-left, small badges) ---
    this._weatherContainer = document.createElement('div');
    this._weatherContainer.id = 'hud-weather-indicator';
    Object.assign(this._weatherContainer.style, {
      position: 'absolute',
      top: '10px',
      left: '10px',
      display: 'flex',
      flexDirection: 'column',
      gap: '4px',
      zIndex: '110',
      pointerEvents: 'none',
    });
    this.container.appendChild(this._weatherContainer);
    /** @type {Map<string, HTMLElement>} Active weather badge elements by type */
    this._weatherBadges = new Map();

    // --- Inject catch-effect CSS animations (Phase 1C) + detach flash (Phase 6) + codex/weather (Phase 7) ---
    if (!document.getElementById('catch-effects-style')) {
      const catchStyle = document.createElement('style');
      catchStyle.id = 'catch-effects-style';
      catchStyle.textContent = `
        /* Progressive luminance: dormant/active states (§2.2) */
        .hud-dormant {
            opacity: 0.5;
            pointer-events: none;
            filter: saturate(0.4);
            transition: opacity 600ms ease-out, filter 600ms ease-out;
        }
        .hud-active {
            opacity: 1.0;
            pointer-events: auto;
            filter: saturate(1.0);
            transition: opacity 600ms ease-out, filter 600ms ease-out;
        }
        /* ST-3.3. Dormant panel corner-glyph affordance */
        [data-hud-group][data-activate-key] {
            position: relative;
        }
        [data-hud-group].hud-dormant[data-activate-key]::after {
            content: attr(data-activate-key);
            position: absolute;
            top: 4px;
            right: 6px;
            padding: 1px 6px;
            min-width: 14px;
            font-family: 'Courier New', monospace;
            font-size: 10px;
            font-weight: 700;
            letter-spacing: 0.5px;
            color: rgba(255, 200, 80, 0.95);
            background: rgba(20, 14, 6, 0.55);
            border: 1px solid rgba(255, 200, 80, 0.65);
            border-radius: 3px;
            box-shadow: 0 0 6px rgba(255, 200, 80, 0.35);
            pointer-events: none;
            opacity: 1;
            transition: opacity 0.45s ease;
            animation: hud-keycap-pulse 1.8s ease-in-out infinite;
            z-index: 20;
        }
        [data-hud-group].hud-active[data-activate-key]::after {
            opacity: 0;
            animation: none;
        }
        @keyframes hud-keycap-pulse {
            0%, 100% { box-shadow: 0 0 6px rgba(255, 200, 80, 0.25); }
            50%      { box-shadow: 0 0 10px rgba(255, 200, 80, 0.7); }
        }
        @keyframes catchFlash {
          0% { opacity: 1; }
          100% { opacity: 0; }
        }
        @keyframes catchBorderPulse {
          0%   { box-shadow: inset 0 0 60px 20px rgba(255, 204, 0, 0.5); }
          50%  { box-shadow: inset 0 0 30px 10px rgba(0, 255, 136, 0.3); }
          100% { box-shadow: inset 0 0 0 0 rgba(0, 255, 136, 0); }
        }
        @keyframes captureNotifPop {
          0%   { transform: translateX(-50%) scale(0.6); opacity: 0; }
          40%  { transform: translateX(-50%) scale(1.15); opacity: 1; }
          70%  { transform: translateX(-50%) scale(0.95); opacity: 1; }
          100% { transform: translateX(-50%) scale(1.0); opacity: 1; }
        }
        @keyframes detachFlash {
          0% { opacity: 0.8; }
          50% { opacity: 0.5; }
          100% { opacity: 0; }
        }
        @keyframes detachTextFloat {
          0%   { opacity: 1; transform: translate(-50%, -50%) scale(1.5); }
          30%  { opacity: 1; transform: translate(-50%, -70%) scale(1.2); }
          100% { opacity: 0; transform: translate(-50%, -130%) scale(0.9); }
        }
        @keyframes scoreFloat {
          0%   { opacity: 1; transform: translate(-50%, -50%) scale(1.2); }
          30%  { opacity: 1; transform: translate(-50%, -70%) scale(1.0); }
          100% { opacity: 0; transform: translate(-50%, -120%) scale(0.8); }
        }
        @keyframes synergyFloat {
          0%   { opacity: 1; transform: translate(-50%, -50%) scale(1.3); }
          20%  { opacity: 1; transform: translate(-50%, -65%) scale(1.1); }
          100% { opacity: 0; transform: translate(-50%, -140%) scale(0.85); }
        }
        @keyframes weatherPulse {
          0%   { opacity: 0.85; }
          50%  { opacity: 1; }
          100% { opacity: 0.85; }
        }
        @keyframes salvageRevealIn {
          0%   { opacity: 0; transform: translate(-50%, 0) scale(0.8); }
          100% { opacity: 1; transform: translate(-50%, 0) scale(1.0); }
        }
        @keyframes salvageRevealOut {
          0%   { opacity: 1; transform: translate(-50%, 0); }
          100% { opacity: 0; transform: translate(-50%, -20px); }
        }
        /* Item 6 stage 5 — HUD power-on: panels slide+fade in with a stagger
         * on the first mission start (matches SkillsPane's slide-in feel).
         * Applied per-panel via .hud-poweron with a per-element delay set in
         * JS. Reduced motion → a plain quick fade, no translate. */
        @keyframes hud-poweron {
          0%   { opacity: 0; transform: translateX(-16px); }
          100% { opacity: 1; transform: translateX(0); }
        }
        .hud-poweron { animation: hud-poweron 0.34s ease-out both; }
        @media (prefers-reduced-motion: reduce) {
          @keyframes hud-poweron { 0% { opacity: 0; } 100% { opacity: 1; } }
          .hud-poweron { animation: hud-poweron 0.2s ease both; }
        }
      `;
      document.head.appendChild(catchStyle);
    }

    // --- Notification Zone (bottom-center, UX-2 #12) ---
    // Delegation 4 (2026-05-31) — Browser-playtest Bug 2 fix:
    // The earlier P0-3 fix lifted this toast from bottom:80 → bottom:132 to
    // clear the HintTicker (88–124 px), but 132 sat inside the band already
    // occupied by the salvage-reveal popup ([`HUD.showSalvageReveal()`](js/ui/HUD.js:1569)
    // at bottom:120) and the warnings panel ([`HUD.panels.warnings`](js/ui/HUD.js:236)
    // at bottom:170). Players reported the toast crowding those overlays.
    //
    // We now drop it to bottom:48 — well below the HintTicker (88) and
    // clear of every other bottom-center overlay. SkillsPane (bottom:10 left)
    // is horizontally isolated, so 48 is the simplest clean slot.
    this._notificationZone = document.createElement('div');
    this._notificationZone.id = 'notification-zone';
    Object.assign(this._notificationZone.style, {
      position: 'fixed',
      bottom: '48px',
      left: '50%',
      transform: 'translateX(-50%)',
      textAlign: 'center',
      zIndex: '100',
      color: '#00ffcc',
      fontFamily: "'Courier New', monospace",
      fontSize: '14px',
      letterSpacing: '2px',
      textTransform: 'uppercase',
      pointerEvents: 'none',
      opacity: '0',
      transition: 'opacity 0.3s ease',
    });
    document.body.appendChild(this._notificationZone);
    /** @type {number|null} Timer handle for notification auto-hide */
    this._notifTimer = null;
  }

  // ==========================================================================
  // EVENT LISTENERS
  // ==========================================================================


  /**
   * Enable skill-based progressive HUD revelation.
   * Replaces tutorial-stage driven dimming. On fresh game, all reveal-groups
   * start dormant; they undim as skills with hudGroup are discovered.
   * On loaded game, restored groups are immediately active.
   * Called from main.js after SkillsSystem and HUD are both created.
   * @param {Set<string>} [initialGroups] — Pre-active CATALOG hudGroup names (from persistence)
   */
  enableSkillReveal(initialGroups) {
    this._skillRevealActive = true;
    this._skillActiveGroups = initialGroups instanceof Set ? new Set(initialGroups) : new Set();
    // Score-group activates via HUD_GROUP_ACTIVATE (5s timer in GameFlowManager)
    if (this.visible) {
      this._applySkillReveal();
    }
  }

  /**
   * Force all [data-hud-group] panels to the active (bright) state.
   * Progressive-luminance dimming is disabled — panels are legible from the
   * start. Skill discovery still drives `_skillActiveGroups` elsewhere; this
   * method no longer applies `hud-dormant`. (SKILL_GROUP_TO_DOM /
   * ALL_REVEAL_GROUPS are retained for a possible re-enable of luminance.)
   * @private
   */
  _applySkillReveal() {
    // VISIBILITY: all panels start (and stay) bright for legibility. The
    // progressive-luminance dimming was reported as hard to read, so we no
    // longer apply `hud-dormant`. Skill discovery still populates
    // `_skillActiveGroups` for progression/affordance tracking (the dormant
    // keycap glyph still keys off the active state), but panels render at full
    // opacity from frame one regardless of which skills are known.
    this.container.querySelectorAll('[data-hud-group]').forEach(el => {
      el.classList.remove('hud-dormant');
      el.classList.add('hud-active');
    });

    // Comms panel: bright from the start as well.
    if (this.panels.comms) {
      this.panels.comms.style.opacity = '';
      this.panels.comms.style.pointerEvents = '';
    }

    // Ensure panels are visible (dormant handles dimming, not display:none)
    if (this.panels.targets) this.panels.targets.style.display = '';
    if (this.panels.arms) this.panels.arms.style.display = '';
    if (this.panels.mother) this.panels.mother.style.display = '';
    if (this._rightColumn) this._rightColumn.style.display = 'flex';
    if (this.statusPanel && this.statusPanel.leftColumn) {
      this.statusPanel.leftColumn.style.display = 'flex';
    }
    if (this.panels.comms) this.panels.comms.style.display = '';
  }

  /** @private */
  _setupEventListeners() {
    eventBus.on(Events.SCORE_UPDATE, (data) => {
      this._score = data.total;
      this._credits = data.credits != null ? data.credits : this._credits;
      this._debrisCleared = data.debrisCleared || this._debrisCleared;
      this._totalMassKg = data.totalMassKg || this._totalMassKg || 0;
      // Flash capture notification when score increases
      if (data.delta > 0) {
        this.statusPanel.showCaptureNotification(
          data.delta, this._debrisCleared, data.massKg || 0, this._totalMassKg
        );
      }
    });

    // ST-9.11 C-5: Launch sequence phase indicator with countdown
    eventBus.on(Events.LAUNCH_PHASE_CHANGED, (data) => {
      if (!this._launchBanner) return;
      const phaseEl = this._launchBanner.querySelector('#hud-launch-phase');
      const detailEl = this._launchBanner.querySelector('#hud-launch-detail');
      if (!phaseEl || !detailEl) return;

      const label = (data.toPhase || '').replace(/_/g, ' ');
      const t = Math.round(data.elapsedTotalS || 0);
      phaseEl.textContent = label;

      // Build countdown detail: "T+12s — NEXT PHASE in 28s"
      const dur = data.phaseDurationS || 0;
      const next = data.nextPhase;
      if (next && dur > 0 && isFinite(dur)) {
        const nextLabel = next.replace(/_/g, ' ');
        detailEl.textContent = `T+${t}s. ${nextLabel} in ${Math.round(dur)}s`;
      } else {
        detailEl.textContent = `T+${t}s`;
      }

      // Show banner (hidden when READY)
      if (data.toPhase !== 'READY') {
        this._launchBanner.style.display = 'block';
      } else {
        this._launchBanner.style.display = 'none';
      }
    });

    eventBus.on(Events.LAUNCH_SEQUENCE_COMPLETE, () => {
      if (this._launchBanner) this._launchBanner.style.display = 'none';
    });

    eventBus.on(Events.COLLISION_WARNING, (data) => {
      this.showWarning(`⚠ Active satellite ${data.name} at ${data.distance.toFixed(1)}km`, 'critical');
    });

    eventBus.on(Events.COLLISION_EVASION, (data) => {
      this.showWarning(`⚡ Auto-evasion! ${data.name} at ${data.distance.toFixed(0)}m`, 'critical');
    });

    eventBus.on(Events.INTERACTION_DATA_CAPTURE, (data) => {
      this.showWarning(`✓ Data captured! +${data.points} pts`, 'success');
    });

    eventBus.on(Events.INTERACTION_DEORBIT, (data) => {
      this.showWarning(`✓ Target deorbited! +${data.points} pts`, 'success');
    });

    eventBus.on(Events.INTERACTION_CAPTURE, (data) => {
      this.showWarning(`✓ Target captured! +${data.points} pts`, 'success');
    });

    eventBus.on(Events.PLAYER_LOW_BATTERY, () => {
      this.showWarning('⚠ Low battery!');
    });

    eventBus.on(Events.PLAYER_LOW_XENON, () => {
      this.showWarning('⚠ Low xenon fuel!');
    });

    // V3 Arm state changes → re-render arm panel
    eventBus.on(Events.ARM_STATE_CHANGE, () => this.statusPanel.renderArmPanel());
    eventBus.on(Events.ARM_DEPLOYED, () => this.statusPanel.renderArmPanel());
    eventBus.on(Events.ARM_CAPTURED, (data) => {
      this.statusPanel.renderArmPanel();
      // Phase 1C: catch juice effects
      this.showCatchFlash();
      const armLabel = (data.type || 'arm').charAt(0).toUpperCase() + (data.type || 'arm').slice(1);
      const debrisLabel = data.debrisType || 'debris';
      this.showScorePopup(
        data.mass || 0,
        `${armLabel}. ${debrisLabel} secured`
      );
    });

    // S4: Catch juice on lasso captures too
    eventBus.on(Events.LASSO_CAPTURED, () => {
      this.showCatchFlash();
    });

    eventBus.on(Events.ARM_RETURNED, () => this.statusPanel.renderArmPanel());
    eventBus.on(Events.ARM_DOCKED, () => this.statusPanel.renderArmPanel());
    eventBus.on(Events.ARM_EXPENDED, () => this.statusPanel.renderArmPanel());

    // Phase 6: Tether detach warning flash
    eventBus.on(Events.ARM_DETACHED, () => {
      this.statusPanel.renderArmPanel();
      this.showDetachFlash();
    });

    // Comms messages → route to CommsPanel
    eventBus.on(Events.COMMS_MESSAGE, (msg) => {
      this.commsPanel.onMessage(msg);
    });


    // --- Conjunction alerts (Sprint C1) ---
    // UX-2 #2: Only show center-screen overlay for RED tier; GREEN/YELLOW go to comms only
    eventBus.on(Events.CONJUNCTION_WARNING, (data) => {
      if (data.tier === 'RED') {
        this._showConjunctionAlert(data);
      }
    });
    eventBus.on(Events.CONJUNCTION_CLEAR, () => {
      this._hideConjunctionAlert();
    });

    // --- Synergy bonus popup (Phase 5 Rewards) ---
    eventBus.on(Events.SYNERGY_BONUS, (data) => {
      this.showSynergyPopup(data.points, data.name);
    });

    // ST-3.4: Mastery celebration toast (first N masteries only)
    eventBus.on(Events.MASTERY_FANFARE, (d) => {
      if (d?.largeToast) this.showMasteryToast(d);
    });

    // Codex unlock feedback deliberately lives OFF the flight HUD: the
    // Discoveries pane (SkillsPane, TECH_UNLOCKED) records every unlock and the
    // audio chime (AudioSystem, CODEX_UNLOCKED) cues it. No popup over the view.

    // --- Weather indicator badges (Phase 7) ---
    eventBus.on(Events.WEATHER_EFFECT_START, (data) => {
      this._addWeatherBadge(data);
    });
    eventBus.on(Events.WEATHER_EFFECT_END, (data) => {
      this._removeWeatherBadge(data.type);
    });

    // --- Notification zone (UX-2 #12) ---
    eventBus.on(Events.SHOW_NOTIFICATION, ({ text, duration }) => {
      this.showNotification(text, duration);
    });

    // PR 6 / P3.13: Audio unlock failure — one-time toast
    eventBus.on(Events.AUDIO_UNLOCK_FAILED, () => {
      this.showNotification('Audio blocked. Click anywhere to enable sound', 5000);
    });

    // Phase 8: Salvage reveal loot popup
    eventBus.on(Events.SALVAGE_REVEAL, (data) => {
      this.showSalvageReveal(data);
    });

    // V5: Crossbow reload events → re-render arm panel
    eventBus.on(Events.CROSSBOW_RELOAD_START, () => this.statusPanel.renderArmPanel());
    eventBus.on(Events.CROSSBOW_RELOAD_COMPLETE, () => this.statusPanel.renderArmPanel());

    // V5: Tether snap → dramatic alert + re-render
    eventBus.on(Events.TETHER_SNAP, (data) => {
      this.showTetherSnapAlert(data);
      this.statusPanel.renderArmPanel();
    });

    // Net-integrity failure (recoverable) → amber alert + re-render
    eventBus.on(Events.NET_FAILED, (data) => {
      this.showNetFailedAlert(data);
      this.statusPanel.renderArmPanel();
    });

    // Phase 3b (capture-feedback overhaul): fragmentation → red alert flash.
    eventBus.on(Events.NET_FRAGMENTATION, (data) => {
      this.showFragmentationAlert(data);
    });

    // V5: Tether tangle → re-render arm panel
    eventBus.on(Events.TETHER_TANGLE, () => this.statusPanel.renderArmPanel());

    // V5: Dual-fire → re-render arm panel (individual CROSSBOW_FIRE events handle per-arm flashes)
    eventBus.on(Events.DUAL_FIRE, () => this.statusPanel.renderArmPanel());

    // --- Self-manage visibility via GAME_STATE_CHANGE (decoupled from GameFlowManager) ---
    const SHOW_STATES = new Set([GameStates.ORBITAL_VIEW, GameStates.APPROACH, GameStates.INTERACTION]);
    eventBus.on(Events.GAME_STATE_CHANGE, ({ to }) => {
      if (SHOW_STATES.has(to)) {
        this.show();
      } else {
        this.hide();
      }
      // T7: replay the power-on stagger per MISSION, not per page load. Return
      // to MENU (quit) rearms it so the next ORBITAL_VIEW show() plays it again.
      if (to === GameStates.MENU) {
        this._didPowerOn = false;
      }
    });

    // --- Self-manage view config via VIEW_CONFIG_CHANGE (decoupled from GameFlowManager) ---
    eventBus.on(Events.VIEW_CONFIG_CHANGE, (config) => {
      this.setViewConfig(config);
      // Sprint 2 / PR E — comms panel may have just been show/hidden;
      // invalidate the cached rect so the next frame recomputes.
      this._commsRectBottom = null;
    });

    // Sprint 2 / PR E — recompute the cached comms-panel rect on viewport resize.
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', () => {
        this._commsRectBottom = null;
      });
    }

    // Comms panel stepped to a new size (line/normal/large). Its bottom edge
    // moves, so the NavSphere slot + right-hand pane column must follow. The
    // panel height animates over ~0.3s, so keep recomputing the cached bottom
    // each frame until the transition settles (see update()).
    eventBus.on(Events.COMMS_PANEL_RESIZED, () => {
      this._commsRectBottom = null;
      this._commsResizeSettleAt =
        (typeof performance !== 'undefined' ? performance.now() : Date.now()) + Constants.COMMS_RESIZE_SETTLE_MS;
    });

    // --- Self-manage selected target via HUD_TARGET_CLICK (decoupled from GameFlowManager) ---
    eventBus.on(Events.HUD_TARGET_CLICK, (data) => {
      this.setSelectedTarget(data.id);
    });

    // --- Self-manage pause overlay via PAUSE events (decoupled from GameFlowManager) ---
    eventBus.on(Events.PAUSE_RESUME, () => {
      this.hidePause();
    });
    eventBus.on(Events.PAUSE_MENU, () => {
      this.hidePause();
    });

    // --- Skill-based progressive revelation (Phase 2B) ---
    eventBus.on(Events.SKILL_DISCOVERED, (data) => {
      if (!this._skillRevealActive) return;
      if (data.hudGroup) {
        this._skillActiveGroups.add(data.hudGroup);
        this._applySkillReveal();
      }
    });
    eventBus.on(Events.SKILLS_LOADED, (data) => {
      if (!this._skillRevealActive) return;
      // Rebuild active groups from loaded skill records
      const skills = data.skills;
      if (skills instanceof Map) {
        for (const [, rec] of skills) {
          if (rec.state !== 'undiscovered' && rec.def && rec.def.hudGroup) {
            this._skillActiveGroups.add(rec.def.hudGroup);
          }
        }
      }
      this._applySkillReveal();
    });
    // Reset skill reveal state on new game
    eventBus.on(Events.GAME_RESET, () => {
      if (!this._skillRevealActive) return;
      this._skillActiveGroups.clear();
    });

    // Direct HUD group activation (bypasses skill discovery)
    eventBus.on(Events.HUD_GROUP_ACTIVATE, ({ group }) => {
      if (!this._skillRevealActive) return;
      this._skillActiveGroups.add(group);
      this._applySkillReveal();
    });

    // UX Fix C: ARM PILOT controls strip — show/hide on camera view change
    eventBus.on(Events.CAMERA_VIEW_CHANGE, (data) => {
      if (data && data.view === 'ARM_PILOT') {
        this._showArmPilotStrip();
      } else {
        this._hideArmPilotStrip();
      }
    });

    // Delegation 3 (2026-05-31): INSPECTION_TOGGLE — coordinate wireframe panels.
    // 2026-06-03: the 'mother' subject is now handled entirely by the in-world
    // 3D callouts (ui/MotherCallouts.js); the HUD no longer hides the right
    // column for a (now removed) 2D mother pane. Only the 'debris' subject still
    // drives a HUD panel here.
    eventBus.on(Events.INSPECTION_TOGGLE, ({ subject } = {}) => {
      if (subject === 'debris') {
        // Toggle the expanded debris wireframe. Two contexts:
        //   • ARM_PILOT  → debris-from-daughter view (badged with the arm).
        //   • Mothership → the currently Tab-selected debris (2026-06-03: the
        //                  V-cycle INSPECT view focuses a locked target here).
        if (this.debrisWireframe?._expandedMode) {
          this.debrisWireframe.clearExpandedMode();
          return;
        }
        if (this._lastPilotedArm) {
          const arm        = this._lastPilotedArm;
          const armTarget  = arm.getApproachTarget?.() ?? arm._approachTarget ?? null;
          this.debrisWireframe?.setExpandedMode(this._lastArmIndex, armTarget);
        } else if (this.debrisWireframe?._target) {
          // Mothership context — expand the already-tracked selected target.
          this.debrisWireframe.setExpandedMode(null);
        } else {
          eventBus.emit(Events.COMMS_MESSAGE, {
            text: 'Select a target with Tab first.',
            priority: 'info',
            source: 'SYSTEM',
          });
        }
      }
    });
  }

  // ==========================================================================
  // PUBLIC API (unchanged from original)
  // ==========================================================================

  /**
   * Set the comms system reference.
   * @param {import('../systems/CommsSystem.js').CommsSystem} commsSystem
   */
  setCommsSystem(commsSystem) {
    this.commsPanel.setCommsSystem(commsSystem);
  }

  /**
   * Set the ArmManager reference for real-time status polling.
   * @param {import('../entities/ArmManager.js').ArmManager} armManager
   */
  setArmManager(armManager) {
    this.statusPanel.setArmManager(armManager);
    this.targetPanel.setArmManager(armManager);
    // (commsPanel.setArmManager removed — dead store after RadialMenu deletion)
    if (this.netInventoryPanel) this.netInventoryPanel.setArmManager(armManager);
  }

  /**
   * Delegation 4 (2026-05-31): Set the LassoSystem reference so the
   * NetInventoryPanel can poll initial ammo state.  Wired from main.js
   * after lassoSystem construction.
   * @param {import('../systems/LassoSystem.js').LassoSystem} lassoSystem
   */
  setLassoSystem(lassoSystem) {
    if (this.netInventoryPanel) this.netInventoryPanel.setLassoSystem(lassoSystem);
  }

  /**
   * Set the NavSphere reference so the right-hand pane column can reserve the
   * correct amount of vertical space and reclaim it when the sphere is
   * minimized (8 key) or hidden. Wired from main.js after NavSphere
   * construction. See HUD.update()'s right-column repositioning.
   * @param {import('./NavSphere.js').NavSphere} navSphere
   */
  setNavSphere(navSphere) {
    this._navSphere = navSphere;
  }

  /**
   * F17: Set the CodexSystem reference for unseen entry badge.
   * @param {import('../systems/CodexSystem.js').CodexSystem} codexSystem
   */
  setCodexSystem(codexSystem) {
    this.statusPanel.setCodexSystem(codexSystem);
  }

  /**
   * Set selected target ID from external source.
   * @param {number} id
   */
  setSelectedTarget(id) {
    this.targetPanel.setSelectedTarget(id);
  }

  /**
   * Toggle comms command menu visibility.
   */
  toggleComms() {
    this.commsPanel.toggleComms();
  }

  /** @returns {Array} Cached tracked/detected targets for route planner (Phase 6) */
  getCachedTargets() {
    return this._cachedTargets;
  }

  /** @returns {boolean} Whether the comms command menu is currently open */
  isCommsOpen() {
    return this.commsPanel.isCommsOpen();
  }

  // (UX-11 #9 review cleanup: executeCommsCommand wrapper removed — it had
  // zero callers once the RadialMenu was deleted.)

  /**
   * Show a warning message.
   * @param {string} message
   * @param {string} [severity='warning'] — 'warning', 'critical', 'success'
   */
  showWarning(message, severity = 'warning') {
    this._warningQueue.push({ message, severity, timer: 3.0 });
  }

  // ==========================================================================
  // UPDATE
  // ==========================================================================

  /**
   * Update all HUD panels. Called every frame from the game loop.
   * @param {number} dt — Delta time
   * @param {object} data — Game data
   */
  update(dt, data) {
    if (!this.visible) return;

    // UX-2 #11: Dynamically position right column below comms + NavSphere.
    // Sprint 2 / PR E — `getBoundingClientRect()` forces a sync layout each
    // frame because StatusPanel mutates textContent on the same frame; we now
    // cache the comms-panel bottom and invalidate only on resize / view-config
    // change (see _setupEventListeners). Saves ~0.2–0.5 ms/frame on dense missions.
    if (this._rightColumn && this.panels.comms) {
      // While the comms panel's height animates after a size step, force a
      // per-frame recompute so the column tracks the bottom edge smoothly
      // instead of snapping once the transition ends.
      if (this._commsResizeSettleAt != null) {
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        if (now < this._commsResizeSettleAt) this._commsRectBottom = null;
        else this._commsResizeSettleAt = null;
      }
      if (this._commsRectBottom == null) {
        this._commsRectBottom = this.panels.comms.getBoundingClientRect().bottom;
      }
      // NavSphere slot height is dynamic: it collapses to a one-line readout
      // when minimized (8 key) and to 0 when hidden, letting the pane column
      // climb up and reclaim the freed real estate. Falls back to the full
      // 280px diameter if the NavSphere ref was never wired.
      const navReserved = this._navSphere?.getReservedHeight?.() ?? 280;
      const navSphereBottom = this._commsRectBottom + 6 + navReserved; // 6px gap above NavSphere slot
      const newTop = Math.round(navSphereBottom + 6);          // 6px gap below NavSphere
      if (this._lastRightColTop !== newTop) {
        this._rightColumn.style.top = newTop + 'px';
        this._rightColumn.style.maxHeight = `calc(100vh - ${newTop + 30}px)`;
        this._lastRightColTop = newTop;
      }
    }

    const { player, debrisField, activeSatellites, targetSelector, sensorSystem,
            autopilotSystem, cameraSystem, armManager } = data;
    if (!player) return;

    // Poll the autopilot phase once per frame. Cheap O(1) no-op when phase
    // hasn't changed (StatusPanel.setAutopilotPhase short-circuits). Preferred
    // over event-driven updates here because HUD already has a per-frame loop
    // and this keeps AutopilotSystem untouched. See AUTOPILOT_ANALYSIS.md §D.4.
    if (autopilotSystem && typeof autopilotSystem.getCurrentPhase === 'function') {
      this.statusPanel.setAutopilotPhase(autopilotSystem.getCurrentPhase());
    }

    // Update at different rates for performance
    this._updateTimers.resources += dt;
    this._updateTimers.targets += dt;

    // Resources at 10 Hz
    if (this._updateTimers.resources > 0.1) {
      this._updateTimers.resources = 0;
      this._resources = { ...player.resources };

      // C-9: Compute CoM drift warning + plume blocks (at HUD rate, 10 Hz)
      let comDriftM = 0;
      let comSuggestedStowArm = null;
      let plumeBlocks = {};
      if (player.armManager) {
        const driftState = updateDriftWarning(player.armManager, player);
        comDriftM = driftState.offsetM;
        comSuggestedStowArm = driftState.suggestedArm;
        plumeBlocks = updateThrusterBlocks(player.armManager);
      }

      this.statusPanel.update({
        score: this._score,
        credits: this._credits,
        debrisCleared: this._debrisCleared,
        resources: this._resources,
        cachedTargets: this._cachedTargets,
        forgeState: data.forgeState,
        cargoStatus: data.cargoStatus,
        totalMassKg: this._totalMassKg || 0,
        thrusterInterlocked: player.thrusterInterlocked || false,
        comDriftM,
        comSuggestedStowArm,
        plumeBlocks,
      });

      // V5: STABILIZE warning when angular velocity too high for crossbow fire
      if (player.isCrossbowFireSafe && !player.isCrossbowFireSafe()) {
        this._showStabilizeWarning();
      } else {
        this._hideStabilizeWarning();
      }
      this.commsPanel.updateMenu();
    }

    // Targets at 2 Hz
    if (this._updateTimers.targets > 0.5) {
      this._updateTimers.targets = 0;
      if (debrisField) {
        // Enhanced target list with 3 sections
        const canDetect = sensorSystem && sensorSystem.canDetectUntracked;
        const allTargets = debrisField.getEnhancedTargetList(
          player.getPosition(),
          player.getOrbitalElements()
        );
        // Currently-selected target always passes the filter
        this._cachedTargets = allTargets.filter(t =>
          t.tracked !== false || canDetect || t.id === this.targetPanel.selectedTargetId
        );

        // Untracked small debris (sensor contacts)
        this._cachedUntracked = debrisField.getUntrackedDebrisNear(
          player.getPosition(),
          0.1 // 10km sensor range
        );

        // Active satellites
        if (activeSatellites) {
          this._cachedActiveSats = activeSatellites.getSatelliteList(player.getPosition());
        }

        this.targetPanel.update({
          cachedTargets: this._cachedTargets,
          cachedUntracked: this._cachedUntracked,
          cachedActiveSats: this._cachedActiveSats,
          playerOrbit: player ? player.getOrbitalElements() : null,
        });
      }
    }

    // Target info (immediate on change) — wire to wireframe analysis + target panel sync
    if (targetSelector) {
      const target = targetSelector.getActiveTarget();
      if (target !== this._targetInfo) {
        this._targetInfo = target;
        // Update wireframe: shows target or falls back to ADR satellite
        if (this.debrisWireframe) {
          this.debrisWireframe.setTarget(target);
        }
        // Sync TargetPanel highlight with wireframe's active target
        this.targetPanel.setSelectedTarget(target ? target.id : null);
      }
    }

    // Update wireframe salvage scanner state from sensor system
    if (this.debrisWireframe && data.sensorSystem) {
      this.debrisWireframe.setSalvageScanner(data.sensorSystem.canScanSalvage || false);
    }

    // Update wireframe animation (handles both ADR self-view and debris targets)
    if (this.debrisWireframe) {
      this.debrisWireframe.update(dt);
    }

    // Delegation 3 — mother/daughter wireframes + strut labels ─────────────
    const pilotArm = cameraSystem?.getPilotedArm?.() ?? null;
    if (pilotArm !== this._lastPilotedArm) {
      this._lastPilotedArm = pilotArm;
      if (pilotArm && armManager) {
        const armList = armManager.getArms?.() || [];
        const idx = armList.indexOf(pilotArm);
        this._lastArmIndex = idx >= 0 ? idx : 0;
      }
    }
    if (this.daughterWireframe) {
      this.daughterWireframe.setPilotedArm(pilotArm, this._lastArmIndex);
      this.daughterWireframe.update(dt);
    }
    if (this.strutLabels && cameraSystem?.camera) {
      this.strutLabels.update(cameraSystem.camera, dt);
    }

    // Warning display
    this._updateWarnings(dt);

    // Update ARM_PILOT strip context (switches between ARM PILOT / STATION KEEP hints)
    if (this._armPilotStrip && this._armPilotStrip.style.display !== 'none') {
      const pilotArm = cameraSystem?.getPilotedArm();
      this._updateArmPilotStripContent(pilotArm);
    }

    // Comms flash timer
    this.commsPanel.update(dt);
  }

  // ==========================================================================
  // WARNINGS
  // ==========================================================================

  /** @private Update warning display */
  _updateWarnings(dt) {
    if (this._warningQueue.length === 0) {
      this.panels.warnings.style.display = 'none';
      return;
    }

    // Show first warning
    const warning = this._warningQueue[0];
    warning.timer -= dt;

    if (warning.timer <= 0) {
      this._warningQueue.shift();
      return;
    }

    this.panels.warnings.style.display = 'block';
    const textEl = document.getElementById('hud-warning-text');
    if (textEl) {
      textEl.textContent = warning.message;
      if (warning.severity === 'critical') {
        textEl.style.color = '#ff4444';
        this.panels.warnings.style.borderColor = 'rgba(255,68,68,0.5)';
        // Pulse animation
        const pulse = Math.sin(Date.now() * 0.01) > 0;
        textEl.style.opacity = pulse ? '1' : '0.6';
      } else if (warning.severity === 'success') {
        textEl.style.color = '#00ff88';
        textEl.style.opacity = '1';
        this.panels.warnings.style.borderColor = 'rgba(0,255,136,0.5)';
      } else {
        textEl.style.color = '#ffaa00';
        textEl.style.opacity = '1';
        this.panels.warnings.style.borderColor = 'rgba(255,170,0,0.3)';
      }
    }
  }

  // ==========================================================================
  // SHOW / HIDE
  // ==========================================================================

  show() {
    this.visible = true;
    Object.values(this.panels).forEach(p => {
      if (p.id !== 'hud-warnings-panel' && p.id !== 'hud-progress-panel') {
        p.style.display = '';
      }
    });
    // Show right column (wireframe + target list)
    if (this._rightColumn) this._rightColumn.style.display = 'flex';
    // Re-apply view config (may hide some panels or adjust opacity)
    this._applyViewConfig();
    // Re-apply progressive luminance (must come after view config)
    this._applySkillReveal();
    // Item 6 stage 5 — power-on stagger, first mission start only (not on
    // returns from SHOP/pause). Panels slide+fade in with a small cascade.
    if (!this._didPowerOn) {
      this._didPowerOn = true;
      this._playPowerOn();
    }
  }

  /**
   * @private Stagger the visible HUD panels in with the hud-poweron animation.
   * One-shot; the class self-cleans on animationend so it never lingers.
   */
  _playPowerOn() {
    // T10: comms-crackle cue — the HUD coming online. Once per mission (this
    // method is guarded by _didPowerOn, reset per-mission in T7).
    eventBus.emit(Events.HUD_POWER_ON);
    // Left → center → right cascade using the natural panel order.
    const targets = [];
    Object.values(this.panels).forEach(p => {
      if (p && p.style.display !== 'none') targets.push(p);
    });
    if (this._rightColumn && this._rightColumn.style.display !== 'none') {
      targets.push(this._rightColumn);
    }
    targets.forEach((el, i) => {
      const delayMs = Math.min(i * 55, 400);
      el.style.animationDelay = `${delayMs}ms`;
      el.classList.add('hud-poweron');
      let fallback = null;
      const clear = () => {
        if (fallback) { clearTimeout(fallback); fallback = null; }
        el.classList.remove('hud-poweron');
        el.style.animationDelay = '';
        el.removeEventListener('animationend', clear);
      };
      el.addEventListener('animationend', clear);
      // Fallback: if the panel is hidden (display:none) or the HUD is torn
      // down before animationend fires, animationend never arrives — clean up
      // anyway so the class + inline delay can't linger. Covers delay (≤400ms)
      // + the 0.34s animation with margin.
      fallback = setTimeout(clear, delayMs + 800);
    });
  }

  hide() {
    this.visible = false;
    Object.values(this.panels).forEach(p => p.style.display = 'none');
    // Hide right column (wireframe + target list)
    if (this._rightColumn) this._rightColumn.style.display = 'none';
    if (this.debrisWireframe) this.debrisWireframe.setVisible(false);
    // Always hide pause overlay when leaving gameplay
    this.hidePause();
    // UX Fix C: Hide ARM PILOT strip (lives on document.body, not HUD container)
    this._hideArmPilotStrip();
    // Reset container opacity so non-gameplay screens are full brightness
    if (this.container) this.container.style.opacity = '1';
  }

  showPause() {
    if (this._pauseOverlay) this._pauseOverlay.style.display = 'block';
  }

  hidePause() {
    if (this._pauseOverlay) this._pauseOverlay.style.display = 'none';
  }

  // ==========================================================================
  // CAMERA VIEW INFO LEVELS
  // ==========================================================================

  /**
   * Set the HUD info-level config based on the active camera view.
   * @param {object} config — one of the VIEW_INFO_LEVELS entries
   */
  setViewConfig(config) {
    this._currentViewConfig = config;
    if (!this.visible) return;
    this._applyViewConfig();
  }

  /** @private Apply panel visibility and opacity from the current view config.
   *  During tutorial (§2.6): only overall opacity is applied — panels stay visible
   *  (dormant/active CSS classes handle dimming). Comms always visible.
   *  Post-tutorial: full camera-view panel management. */
  _applyViewConfig() {
    const cfg = this._currentViewConfig;
    if (!cfg) return;

    // Overall HUD opacity (always applied, even during skills reveal)
    if (this.container) {
      this.container.style.opacity = String(cfg.hudOpacity);
    }

    if (this._skillRevealActive) {
      // During skill reveal: panels stay visible;
      // dormant/active CSS classes handle dimming. Only overall opacity applied.
      if (this.panels.comms) this.panels.comms.style.display = '';
      return;
    }

    // --- Post-tutorial: camera view controls panel visibility ---

    // MOTHER pane (Propulsion + Energy + Net digest) — keyed off showResources.
    // The net's visibility now follows showResources (it is a Mother system).
    const showRes = cfg.showResources !== undefined ? cfg.showResources : true;
    if (this.panels.mother) {
      this.panels.mother.style.display = showRes ? '' : 'none';
    }

    // Toggle entire left column when all left-side panels are hidden
    if (this.statusPanel && this.statusPanel.leftColumn) {
      const anyLeftVisible = showRes || cfg.showArms;
      this.statusPanel.leftColumn.style.display = anyLeftVisible ? 'flex' : 'none';
    }

    // Right column (analysis wireframe + target list)
    if (this._rightColumn) {
      const showRight = cfg.showAnalysis || cfg.showTargetList;
      this._rightColumn.style.display = showRight ? 'flex' : 'none';
    }

    // Wireframe analysis panel
    if (this.debrisWireframe) {
      const showAnalysis = cfg.showAnalysis !== undefined ? cfg.showAnalysis : true;
      this.debrisWireframe.setVisible(showAnalysis);
    }

    // Target list panel
    if (this.panels.targets) {
      this.panels.targets.style.display = cfg.showTargetList ? '' : 'none';
    }

    // Arms panel
    if (this.panels.arms) {
      this.panels.arms.style.display = cfg.showArms ? '' : 'none';
    }

    // Progress panel: don't force-show — it's managed by interaction state

    // Comms panel: hide only if camera view says no AND menu isn't open
    if (this.panels.comms && !this.commsPanel.isCommsOpen()) {
      this.panels.comms.style.display = cfg.showComms ? '' : 'none';
    }
  }

  // ==========================================================================
  // CATCH EFFECTS (Phase 1C)
  // ==========================================================================

  /**
   * S9-A: Show a subtle green-cyan flash + border pulse overlay on successful catch.
   * Self-removes after animation completes — no stacking issues.
   */
  showCatchFlash() {
    // Sim-appropriate: NO screen flash, NO border pulse.
    // Previously emitted a green radial + gold->green border pulse ("catch juice"),
    // which read as arcade-style sparks. Removed per user feedback: this is a sim.
    // Capture confirmation lives in the comms panel text + score popup only.
  }

  /**
   * Show a red tinted flash + floating "TETHER CUT" text on detach.
   * Phase 6: Risk-Reward detach dramatic feedback.
   */
  showDetachFlash() {
    // Red radial flash
    const flash = document.createElement('div');
    flash.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: radial-gradient(circle, rgba(255,50,50,0.5) 0%, rgba(255,0,0,0) 70%);
      pointer-events: none; z-index: 100;
      animation: detachFlash 0.5s ease-out forwards;
    `;
    document.body.appendChild(flash);
    timerManager.setTimeout(() => flash.remove(), 550, { owner: this });

    // Floating "TETHER CUT" text
    const text = document.createElement('div');
    text.style.cssText = `
      position: fixed; top: 40%; left: 50%;
      transform: translate(-50%, -50%);
      color: #ff4444; font-family: 'Courier New', monospace;
      font-size: 28px; font-weight: bold; letter-spacing: 4px;
      text-shadow: 0 0 20px rgba(255,50,50,0.8), 0 0 40px rgba(255,0,0,0.4);
      pointer-events: none; z-index: 101;
      animation: detachTextFloat 1.2s ease-out forwards;
    `;
    text.textContent = 'TETHER CUT';
    document.body.appendChild(text);
    timerManager.setTimeout(() => text.remove(), 1300, { owner: this });
  }

  /**
   * Show a floating mass popup that drifts upward and fades.
   * @param {number} massKg - Mass in kg to display
   * @param {string} [label] - Optional descriptive label
   */
  showScorePopup(massKg, label) {
    const popup = document.createElement('div');
    popup.style.cssText = `
      position: fixed;
      top: 45%; left: 50%;
      transform: translate(-50%, -50%);
      color: #00ff88;
      font-family: 'Courier New', monospace;
      font-size: 28px;
      font-weight: bold;
      text-shadow: 0 0 10px rgba(0, 255, 136, 0.5);
      pointer-events: none;
      z-index: 101;
      animation: scoreFloat 1.5s ease-out forwards;
    `;
    // S9-A: Show mass in kg instead of abstract points
    const massText = massKg > 0 ? `+${massKg.toLocaleString()} kg` : '+0 kg';
    if (label) {
      popup.innerHTML = `${massText}<br><span style="font-size:14px;color:#88ccff">${label}</span>`;
    } else {
      popup.textContent = massText;
    }
    document.body.appendChild(popup);
    timerManager.setTimeout(() => popup.remove(), 1600, { owner: this });
  }

  // ==========================================================================
  // SYNERGY POPUP (Phase 5 Rewards)
  // ==========================================================================

  // ==========================================================================
  // NOTIFICATION ZONE (UX-2 #12)
  // ==========================================================================

  /**
   * Show a transient notification in the bottom-center zone.
   * @param {string} text — Notification text
   * @param {number} [durationMs=2500] — Display duration in ms
   */
  showNotification(text, durationMs = 2500) {
    if (!this._notificationZone) return;
    this._notificationZone.textContent = text;
    this._notificationZone.style.opacity = '1';
    // PR 5 / P2.8: TimerManager-tracked notification timer (debounced).
    if (this._notifTimer) timerManager.clear(this._notifTimer);
    this._notifTimer = timerManager.setTimeout(() => {
      this._notificationZone.style.opacity = '0';
      this._notifTimer = null;
    }, durationMs, { owner: this });
  }

  /**
   * Show a floating synergy bonus popup (cyan/teal, distinct from gold score popup).
   * @param {number} points - Bonus points
   * @param {string} name - Synergy name
   */
  showSynergyPopup(points, name) {
    const popup = document.createElement('div');
    popup.style.cssText = `
      position: fixed;
      top: 38%; left: 50%;
      transform: translate(-50%, -50%);
      color: #00e5ff;
      font-family: 'Courier New', monospace;
      font-size: 24px;
      font-weight: bold;
      text-shadow: 0 0 12px rgba(0, 229, 255, 0.6), 0 0 24px rgba(0, 229, 255, 0.3);
      pointer-events: none;
      z-index: 102;
      text-align: center;
      animation: synergyFloat 2.0s ease-out forwards;
    `;
    popup.innerHTML = `+${points} ${name}<br><span style="font-size:12px;color:#4dd0e1;">⚡ SYNERGY BONUS</span>`;
    document.body.appendChild(popup);
    timerManager.setTimeout(() => popup.remove(), 2100, { owner: this });
  }

  // ==========================================================================
  // CONJUNCTION ALERT OVERLAY (Sprint C1)
  // ==========================================================================

  /**
   * Show the conjunction alert overlay with tier-coloured styling.
   * @private
   * @param {object} data — CONJUNCTION_WARNING event payload
   */
  _showConjunctionAlert(data) {
    const panel = this._conjunctionPanel;
    if (!panel) return;

    const tierColors = {
      GREEN:  { border: '#00cc66', text: '#00ff88', label: 'GREEN. INFORMATIONAL' },
      YELLOW: { border: '#ccaa00', text: '#ffdd44', label: 'YELLOW. CAUTION' },
      RED:    { border: '#ff3333', text: '#ff5555', label: 'RED. CRITICAL' },
    };
    const tc = tierColors[data.tier] || tierColors.GREEN;

    panel.style.borderColor = tc.border;
    panel.style.display = 'block';

    // Header
    const header = panel.querySelector('#hud-conjunction-header');
    if (header) {
      header.innerHTML = `⚠ CONJUNCTION ALERT <span id="hud-conjunction-help" style="cursor:pointer;opacity:0.7;font-size:11px;margin-left:6px;" title="Open Tech Library">[?]</span>`;
      header.style.color = tc.text;
      // ST-2.1: [?] glyph → open codex to conjunction entry
      const helpGlyph = header.querySelector('#hud-conjunction-help');
      if (helpGlyph) helpGlyph.onclick = () => eventBus.emit(Events.CODEX_OPENED);
    }

    // Evasion direction hint
    const evDir = this._formatEvasionDir(data.evasionVector);

    // Details
    const details = panel.querySelector('#hud-conjunction-details');
    if (details) {
      details.innerHTML =
        `<span style="color:${tc.text};font-weight:bold;">${tc.label}</span><br>` +
        `TCA: <b>${data.tca}s</b> &nbsp;|&nbsp; Miss: <b>${data.distance}m</b><br>` +
        `Object: ${(data.debrisType || 'unknown').toUpperCase()} #${data.debrisId}<br>` +
        `<span style="color:${tc.text};font-size:14px;">${evDir}</span>`;
    }

    // RED tier: add pulsing animation via inline style
    if (data.tier === 'RED') {
      panel.style.animation = 'conjunction-pulse 0.6s ease-in-out infinite alternate';
      // Inject keyframes if not yet present
      if (!document.getElementById('conjunction-pulse-style')) {
        const style = document.createElement('style');
        style.id = 'conjunction-pulse-style';
        style.textContent = `
          @keyframes conjunction-pulse {
            from { box-shadow: 0 0 8px rgba(255,50,50,0.4); opacity: 1; }
            to   { box-shadow: 0 0 20px rgba(255,50,50,0.8); opacity: 0.85; }
          }
        `;
        document.head.appendChild(style);
      }
    } else {
      panel.style.animation = '';
      panel.style.boxShadow = '';
    }
  }

  /**
   * Hide the conjunction alert overlay.
   * @private
   */
  _hideConjunctionAlert() {
    if (this._conjunctionPanel) {
      this._conjunctionPanel.style.display = 'none';
      this._conjunctionPanel.style.animation = '';
    }
  }

  /**
   * Convert a 3D evasion vector to a human-readable direction hint.
   * @private
   * @param {{x:number,y:number,z:number}} ev — normalised evasion vector
   * @returns {string} Direction arrow + label
   */
  _formatEvasionDir(ev) {
    if (!ev) return 'MANEUVER RECOMMENDED';
    const ax = Math.abs(ev.x), ay = Math.abs(ev.y), az = Math.abs(ev.z);
    if (ay >= ax && ay >= az) {
      return ev.y > 0 ? '↑ EVADE RADIAL OUT' : '↓ EVADE RADIAL IN';
    } else if (ax >= az) {
      return ev.x > 0 ? '→ EVADE CROSS-TRACK' : '← EVADE CROSS-TRACK';
    }
    return ev.z > 0 ? '↗ EVADE PROGRADE' : '↙ EVADE RETROGRADE';
  }

  // ==========================================================================
  // WEATHER INDICATORS (Phase 7 — Learning Systems)
  // ==========================================================================

  /**
   * Add a weather event badge to the top-left indicator area.
   * @private
   * @param {{ type: string, name: string, icon: string, color: string, duration: number }} data
   */
  _addWeatherBadge(data) {
    // Remove existing badge of same type (shouldn't happen, but safety)
    this._removeWeatherBadge(data.type);

    const badge = document.createElement('div');
    badge.style.cssText = `
      display: inline-flex; align-items: center; gap: 6px;
      background: rgba(0, 0, 0, 0.8);
      border: 1px solid ${data.color || '#888'};
      border-radius: 4px; padding: 4px 10px;
      font-family: 'Courier New', monospace; font-size: 10px;
      color: ${data.color || '#ccc'}; white-space: nowrap;
      animation: weatherPulse 2s ease-in-out infinite;
      pointer-events: none;
    `;
    badge.innerHTML = `<span style="font-size:12px;">${data.icon || '🌐'}</span><span>${data.name}</span>`;
    badge.dataset.weatherType = data.type;
    this._weatherContainer.appendChild(badge);
    this._weatherBadges.set(data.type, badge);
  }

  /**
   * Remove a weather event badge when the event ends.
   * @private
   * @param {string} type
   */
  _removeWeatherBadge(type) {
    const badge = this._weatherBadges.get(type);
    if (badge) {
      badge.remove();
      this._weatherBadges.delete(type);
    }
  }

  // ==========================================================================
  // SALVAGE REVEAL POPUP (Phase 8 — Audio & Polish)
  // ==========================================================================

  /**
   * Show a salvage reveal loot popup — gold-bordered with metal icons.
   * Displays for 3 seconds center-bottom, then fades out.
   * @param {{ metals: Array<{name: string, amount: number}>, totalMass: number, debrisType: string }} data
   */
  showSalvageReveal(data) {
    const popup = document.createElement('div');
    popup.style.cssText = `
      position: fixed;
      bottom: 120px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(10, 8, 4, 0.92);
      border: 2px solid #d4a017;
      border-radius: 8px;
      padding: 10px 20px;
      font-family: 'Courier New', monospace;
      font-size: 13px;
      color: #ffe088;
      text-align: center;
      z-index: 150;
      pointer-events: none;
      box-shadow: 0 0 20px rgba(212, 160, 23, 0.4), inset 0 0 12px rgba(212, 160, 23, 0.1);
      animation: salvageRevealIn 0.3s ease-out forwards;
      min-width: 200px;
    `;

    // Build content
    let metalHtml = '';
    const metals = data.metals || [];
    if (metals.length > 0) {
      const metalIcons = { aluminum: '🔩', titanium: '⚙️', copper: '🔶', steel: '🔧', gold: '✨', platinum: '💎' };
      metalHtml = metals.map(m => {
        const icon = metalIcons[m.name?.toLowerCase()] || metalIcons[m.subtype?.toLowerCase()] || '🔩';
        const name = (m.name || m.subtype || 'Unknown').charAt(0).toUpperCase() + (m.name || m.subtype || 'Unknown').slice(1);
        const amount = (m.amount || m.massKg || 0).toFixed(1);
        return `${icon} ${name} ${amount}kg`;
      }).join(' <span style="color:#665522">|</span> ');
    } else {
      metalHtml = '🔧 Salvage Collected';
    }

    const typeLabel = (data.debrisType || 'debris').toUpperCase();
    popup.innerHTML = `
      <div style="font-size:11px;color:#aa8844;letter-spacing:2px;margin-bottom:4px;">▸ SALVAGE. ${typeLabel} ◂</div>
      <div>${metalHtml}</div>
      ${data.totalMass ? `<div style="font-size:10px;color:#887744;margin-top:4px;">Total: ${data.totalMass.toFixed(1)}kg recovered</div>` : ''}
    `;

    document.body.appendChild(popup);

    // Fade out after 2.5s, remove at 3s
    timerManager.setTimeout(() => {
      popup.style.animation = 'salvageRevealOut 0.5s ease-in forwards';
    }, 2500, { owner: this });
    timerManager.setTimeout(() => popup.remove(), 3100, { owner: this });
  }

  // ==========================================================================
  // V5 CROSSBOW FEEDBACK
  // ==========================================================================

  /**
   * V5: Show dramatic "TETHER SNAP" alert on tether break.
   * Red flash for 2 seconds with floating text, similar to detach flash.
   * @param {{ armIndex: number, cause: string }} data
   */
  showTetherSnapAlert(data) {
    // Red radial flash (more intense than detach)
    const flash = document.createElement('div');
    flash.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: radial-gradient(circle, rgba(255,50,50,0.6) 0%, rgba(255,0,0,0) 70%);
      pointer-events: none; z-index: 100;
      animation: detachFlash 0.8s ease-out forwards;
    `;
    document.body.appendChild(flash);
    timerManager.setTimeout(() => flash.remove(), 850, { owner: this });

    // Floating "TETHER SNAP" text
    const text = document.createElement('div');
    text.style.cssText = `
      position: fixed; top: 35%; left: 50%;
      transform: translate(-50%, -50%);
      color: #ff3333; font-family: 'Courier New', monospace;
      font-size: 32px; font-weight: bold; letter-spacing: 4px;
      text-shadow: 0 0 20px rgba(255,50,50,0.8), 0 0 40px rgba(255,0,0,0.4);
      pointer-events: none; z-index: 101;
      animation: detachTextFloat 2.0s ease-out forwards;
    `;
    text.textContent = 'TETHER SNAP';
    document.body.appendChild(text);
    timerManager.setTimeout(() => text.remove(), 2100, { owner: this });

    // Also show as a queued warning
    const cause = data?.cause || 'overload';
    this.showWarning(`⚠ TETHER SNAP. ${cause}`, 'critical');
  }

  /**
   * Recoverable net failure: amber flash + "NET FAILED" text. Less severe than
   * a tether snap (the daughter survives and the debris is re-capturable).
   */
  showNetFailedAlert(data) {
    // Amber radial flash (softer than the red tether-snap flash)
    const flash = document.createElement('div');
    flash.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: radial-gradient(circle, rgba(255,170,40,0.45) 0%, rgba(255,140,0,0) 70%);
      pointer-events: none; z-index: 100;
      animation: detachFlash 0.8s ease-out forwards;
    `;
    document.body.appendChild(flash);
    timerManager.setTimeout(() => flash.remove(), 850, { owner: this });

    // Floating "NET FAILED" text
    const text = document.createElement('div');
    text.style.cssText = `
      position: fixed; top: 35%; left: 50%;
      transform: translate(-50%, -50%);
      color: #ffaa33; font-family: 'Courier New', monospace;
      font-size: 28px; font-weight: bold; letter-spacing: 4px;
      text-shadow: 0 0 18px rgba(255,170,50,0.8), 0 0 36px rgba(255,140,0,0.4);
      pointer-events: none; z-index: 101;
      animation: detachTextFloat 2.0s ease-out forwards;
    `;
    text.textContent = 'NET FAILED';
    document.body.appendChild(text);
    timerManager.setTimeout(() => text.remove(), 2100, { owner: this });

    this.showWarning('⚠ NET FAILED. Debris slipped free', 'warning');
  }

  /**
   * Phase 3b (capture-feedback overhaul): fragmentation alert — the impact
   * broke debris into new tracked fragments (Kessler ticks up). Red flash;
   * the mercy waiver is named when it applies.
   * @param {{ debrisId:*, fragmentCount:number, mercyApplied:boolean }} data
   */
  showFragmentationAlert(data) {
    const flash = document.createElement('div');
    flash.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: radial-gradient(circle, rgba(255,80,40,0.5) 0%, rgba(255,40,0,0) 70%);
      pointer-events: none; z-index: 100;
      animation: detachFlash 0.8s ease-out forwards;
    `;
    document.body.appendChild(flash);
    timerManager.setTimeout(() => flash.remove(), 850, { owner: this });

    const text = document.createElement('div');
    text.style.cssText = `
      position: fixed; top: 35%; left: 50%;
      transform: translate(-50%, -50%);
      color: #ff6633; font-family: 'Courier New', monospace;
      font-size: 28px; font-weight: bold; letter-spacing: 4px;
      text-shadow: 0 0 18px rgba(255,100,50,0.8), 0 0 36px rgba(255,60,0,0.4);
      pointer-events: none; z-index: 101;
      animation: detachTextFloat 2.0s ease-out forwards;
    `;
    text.textContent = 'FRAGMENTATION';
    document.body.appendChild(text);
    timerManager.setTimeout(() => text.remove(), 2100, { owner: this });

    const n = data?.fragmentCount || 1;
    this.showWarning(
      data?.mercyApplied
        ? `⚠ FRAGMENTATION. ${n} new fragment${n > 1 ? 's' : ''} (first-time penalty waived)`
        : `⚠ FRAGMENTATION. ${n} new fragment${n > 1 ? 's' : ''} tracked`,
      'critical');
  }

  /**
   * V5: Show blinking "STABILIZE" warning when angular velocity is too
   * high for safe crossbow fire.
   * @private
   */
  _showStabilizeWarning() {
    if (!this._stabilizeEl) {
      this._stabilizeEl = document.createElement('div');
      this._stabilizeEl.id = 'hud-stabilize-warning';
      this._stabilizeEl.style.cssText = `
        position: absolute; bottom: 210px; left: 50%;
        transform: translateX(-50%);
        font-family: 'Courier New', monospace;
        font-size: 14px; font-weight: bold; letter-spacing: 2px;
        color: #ffaa00; text-shadow: 0 0 8px rgba(255,170,0,0.5);
        pointer-events: none; z-index: 110;
        animation: deltav-pulse 0.6s ease-in-out infinite;
      `;
      this._stabilizeEl.textContent = '⚠ STABILIZE';
      this.container.appendChild(this._stabilizeEl);
    }
    this._stabilizeEl.style.display = '';
  }

  /**
   * V5: Hide the STABILIZE warning.
   * @private
   */
  _hideStabilizeWarning() {
    if (this._stabilizeEl) {
      this._stabilizeEl.style.display = 'none';
    }
  }

  // ==========================================================================
  // ST-3.4: MASTERY TOAST
  // ==========================================================================

  /**
   * Display a centered "Mastery Unlocked — {label}" banner for the first few masteries.
   * Fades after MASTERY_TOAST_DURATION_MS. Pattern follows showSynergyPopup().
   * @param {{ label: string }} data
   */
  showMasteryToast(data) {
    const label = data?.label ?? 'Skill';
    const toast = document.createElement('div');
    toast.className = 'hud-mastery-toast';
    toast.style.cssText = `
      position: fixed;
      left: 50%;
      top: 28%;
      transform: translate(-50%, -50%);
      padding: 12px 28px;
      background: linear-gradient(135deg, rgba(20, 12, 40, 0.92), rgba(60, 30, 80, 0.92));
      border: 2px solid rgba(255, 200, 80, 0.85);
      box-shadow: 0 0 24px rgba(255, 200, 80, 0.55), 0 4px 18px rgba(0, 0, 0, 0.6);
      color: #fff;
      font-family: 'Courier New', monospace;
      font-size: 18px;
      letter-spacing: 2px;
      text-align: center;
      z-index: 9000;
      opacity: 0;
      transition: opacity 0.3s ease;
      pointer-events: none;
    `;
    toast.innerHTML = `
      <div style="font-size:11px; color:#ffcc66; letter-spacing:3px; margin-bottom:4px;">◆ MASTERY UNLOCKED ◆</div>
      <div style="font-size:18px; color:#fff;">${label.replace(/</g, '&lt;')}</div>
    `;
    document.body.appendChild(toast);
    // Next frame: fade in
    requestAnimationFrame(() => { toast.style.opacity = '1'; });
    // Hold, then fade out and remove
    const durMs = Constants.SKILLS.CELEBRATION.MASTERY_TOAST_DURATION_MS;
    timerManager.setTimeout(() => { toast.style.opacity = '0'; }, durMs - 300, { owner: this });
    timerManager.setTimeout(() => { toast.remove(); }, durMs, { owner: this });
  }

  // ==========================================================================
  // UX Fix C: ARM PILOT CONTROLS STRIP
  // ==========================================================================

  /** @private Create the ARM PILOT controls strip DOM element (lazy, once). */
  _createArmPilotStrip() {
    if (this._armPilotStrip) return;
    this._armPilotStrip = document.createElement('div');
    this._armPilotStrip.id = 'arm-pilot-controls';
    // Content set dynamically by _updateArmPilotStripContent() — no static HTML here
    Object.assign(this._armPilotStrip.style, {
      position: 'fixed',
      bottom: '12px',
      left: '50%',
      transform: 'translateX(-50%)',
      background: 'rgba(0, 30, 60, 0.85)',
      border: '1px solid rgba(0, 200, 255, 0.4)',
      borderRadius: '6px',
      padding: '6px 16px',
      color: '#88ccff',
      fontFamily: '"Share Tech Mono", monospace',
      fontSize: '11px',
      letterSpacing: '0.5px',
      zIndex: '1000',
      display: 'none',
      alignItems: 'center',
      gap: '8px',
      opacity: '0',
      transition: 'opacity 0.3s ease-in-out',
      pointerEvents: 'none',
    });
    document.body.appendChild(this._armPilotStrip);

    // Inject styles if not already present
    if (!document.getElementById('apc-styles')) {
      const style = document.createElement('style');
      style.id = 'apc-styles';
      style.textContent = `
        .apc-badge { color: #00ccff; font-weight: bold; font-size: 12px; }
        .apc-key { background: rgba(0,200,255,0.15); border: 1px solid rgba(0,200,255,0.3);
                   border-radius: 3px; padding: 1px 5px; color: #00ccff; font-weight: bold; }
        .apc-sep { color: rgba(0,200,255,0.25); }
      `;
      document.head.appendChild(style);
    }
  }

  /**
   * @private Update the ARM PILOT strip innerHTML based on the piloted arm's state.
   * In STATION_KEEP the strip shows orbit/capture controls; otherwise default steer controls.
   */
  _updateArmPilotStripContent(arm) {
    if (!this._armPilotStrip) return;

    const isStationKeep = arm && arm.state === Constants.ARM_STATES.STATION_KEEP;
    // Avoid redundant DOM writes — track which variant is showing
    if (isStationKeep && this._armStripMode === 'sk') return;
    if (!isStationKeep && this._armStripMode === 'pilot') return;

    if (isStationKeep) {
      this._armStripMode = 'sk';
      // Hotkey cleanup 2026-06-13: capture verb is N (was F); Shift = fine
      // folded onto the Orbit hint.
      this._armPilotStrip.innerHTML =
        '<span class="apc-badge">🛰️ STATION KEEP</span>' +
        '<span class="apc-sep">│</span>' +
        '<span class="apc-key">↑↓←→</span> Orbit (Shift = fine) ' +
        '<span class="apc-sep">│</span>' +
        '<span class="apc-key">+/-</span> Distance ' +
        '<span class="apc-sep">│</span>' +
        '<span class="apc-key">N</span> Capture ' +
        '<span class="apc-sep">│</span>' +
        '<span class="apc-key">ESC</span> Exit';
    } else {
      this._armStripMode = 'pilot';
      // Hotkey revamp 2026-06-14: WASD/Q-E daughter thrust was removed — the
      // daughter flies autonomously to her target. The only pilot-mode actions
      // are deploy-net (N), recall (R), and exit (ESC).
      this._armPilotStrip.innerHTML =
        '<span class="apc-badge">🤖 DAUGHTER PILOT</span>' +
        '<span class="apc-sep">│</span>' +
        '<span class="apc-key">N</span> Deploy Net ' +
        '<span class="apc-sep">│</span>' +
        '<span class="apc-key">R</span> Recall ' +
        '<span class="apc-sep">│</span>' +
        '<span class="apc-key">ESC</span> Exit';
    }
  }

  /** @private Show the ARM PILOT controls strip with fade-in. */
  _showArmPilotStrip() {
    this._createArmPilotStrip();
    // Set initial content (default ARM PILOT; update loop will swap to STATION_KEEP if needed)
    this._updateArmPilotStripContent(null);
    this._armPilotStrip.style.display = 'flex';
    requestAnimationFrame(() => { this._armPilotStrip.style.opacity = '1'; });
  }

  /** @private Hide the ARM PILOT controls strip with fade-out. */
  _hideArmPilotStrip() {
    if (this._armPilotStrip) {
      this._armPilotStrip.style.opacity = '0';
      this._armStripMode = null; // Reset so next show gets fresh content update
      timerManager.setTimeout(() => {
        if (this._armPilotStrip) this._armPilotStrip.style.display = 'none';
      }, 300, { owner: this });
    }
  }
}

export default HUD;
