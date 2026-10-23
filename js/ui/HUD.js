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
import { VitalsPane } from './hud/VitalsPane.js';
import { isSimpleTargets, currentMissionNumber } from './hud/SimpleFirst.js';
import { TargetPanel } from './hud/TargetPanel.js';
import { shortScreenNow } from './hud/PhoneFold.js';
import { CommsPanel } from './hud/CommsPanel.js';
import { HintTicker } from './hud/HintTicker.js';
import { GestureHints } from './hud/GestureHints.js';
import { NetInventoryPanel } from './hud/NetInventoryPanel.js';
import { PaneDensity, compositeRung } from './hud/PaneDensity.js';
import { PaneHelp } from './hud/PaneHelp.js';
import { AlertArbiter, STRIP_KIND } from './hud/AlertHierarchy.js';
import { approachLive } from './hud/TargetColorLaw.js';
import { VisualLaw } from '../core/VisualLaw.js';
import { pinProgress } from './shopPin.js'; // S1 retention: pinned-upgrade progress math (pure, DOM-free)
import { PANE_CORNER_PX, HUD_COLUMN_WIDTH_PX, RIGHT_COLUMN_WIDTH_PX, RAIL_GEOMETRY, footerBand } from './RailGeometry.js';
import { dividedByScale, onHudScaleChange, currentHudScale } from './HudScale.js';
 import { DebrisWireframe }   from './DebrisWireframe.js';
 import { DaughterWireframe } from './DaughterWireframe.js';
import { StrutLabels }       from './hud/StrutLabels.js';
import { updateDriftWarning, updateThrusterBlocks } from '../systems/CoMCalculator.js';
import { FLOOR_WORDS } from '../systems/FloorWordsStore.js';   // u7 D6: the two orbit-word lines show in sentence case

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

/**
 * Session O (plan D12, owner 2026-09-07): the ONE toast-policy drop table —
 * the Airbus alert hierarchy's visual twin (the comms channel already has its
 * tier law — commsSuppression.js; this is the toast side).
 *
 * Kinds below `prompt` die while `setToastPolicy('engaged')` is set — even
 * under `force:true` (the density per-step toasts are `confirm` + `force` and
 * must die so a `-` press shows no toast; the pure-scenery reminder
 * "+ restores" is `prompt` + `force` and must show). Untagged toasts default
 * to `prompt` — the safe default — so no policy set (flag-off / disengaged) is
 * byte-identical to today for every kind.
 *
 * Shown while engaged (the survivors): `prompt` + untagged + `alert-red` +
 * `alert-amber` (the alert kinds are named NOW for Session Q, but behave as
 * `prompt` in O). Session Q adds levels / inhibit windows / one-at-a-time.
 *
 * @type {ReadonlySet<string>}
 */
export const TOAST_DROP_WHILE_ENGAGED = Object.freeze(new Set([
  'confirm',   // confirmations die — the arm pane + score tick + Houston comms line ARE the confirmation (A3)
  'notice',    // CommsSystem.js already narrates evasion; RewardSystem narrates synergy — a toast would duplicate (D12)
  'view',      // the WHERE rail + camera indicator carry the view change
  'inspect',   // the inspection overlay itself is the feedback
  'memo',      // AP state moves to the MOTHER MEMO slot in Q; as a toast it is dropped while engaged
]));

/** Task 9 — hide/show reflow duration (ms). */
export const DENSITY_MOTION_MS = 200;
/** VisualLaw's cubic-in-out — CSS cubic-bezier (VisualLaw.EASING is the name, not a CSS function). */
export const DENSITY_MOTION_EASING = 'cubic-bezier(0.65, 0, 0.35, 1)';
/** Pin widget natural height when unmeasured (plan layout target). */
export const PIN_NATURAL_PX = 27;

/**
 * The bottom-centre stacking law (follow-up 2026-09-09, plan
 * .kilo/plans/1788926404388-hud-followups-0909.md §1.4 — the SAFETY OVERRIDE
 * gag moved to the viewport bottom): offsets from the viewport bottom, ladder
 * on — 12–68 gag · 88–124 hint ticker · 120 salvage popup (legacy) · **132
 * toast** (was 48) · 132–164 footer band, free centre · 170 warnings · **172
 * ARM PILOT strip** (was 12). (The 148 F1 breadcrumb was retired 2026-09-09,
 * plan 1788954873769-one-workbench-pane §D8.) `?ladder=0` is byte-identical:
 * toast 48 / strip 12. PURE: the caller passes `ladderOn` read from
 * `Constants.LADDER.ENABLED` in the constructor path (the URL flips it inside
 * `init()` before `new HUD` — never read at module level).
 *
 * The ticker band's top is TICKER.BOTTOM_PX 88 + ROW_HEIGHT_PX 36 = 124 (the
 * hub's `_HINT_BAND_PX`), so `footerBand({ hintBandPx: 124 })` → bottom 132 /
 * top 164 on both surfaces (124 ≥ the 100 thumb rest).
 * @private
 */
function _hintBandPx() {
  const t = (Constants.ONBOARDING && Constants.ONBOARDING.TICKER) || {};
  return (Number(t.BOTTOM_PX) || 0) + (Number(t.ROW_HEIGHT_PX) || 0);
}

/**
 * CSS `bottom` (px) of the `#notification-zone` toast: the footer band's
 * bottom edge (132) with the ladder on — the band's centre is free now that
 * the gag sits at the bottom — else the shipped 48.
 * @param {boolean} ladderOn
 * @returns {number}
 */
export function toastBottomPx(ladderOn) {
  return ladderOn ? footerBand({ hintBandPx: _hintBandPx() }).bottom : 48;
}

/**
 * u9-big-text: the step chip (`#hud-hint-ticker`) is drawn HUD_SCALE x bigger from its bottom edge, so its top
 * rises by (scale - 1) x its row height (36 px with a mouse, 48 px on touch; measured 2026-10-20). The toast sits
 * on the footer band's edge (132 px), which the chip's top would otherwise cross by up to 16 px on the iPad; the
 * toast rises by the larger (touch) growth, 12 px at 1.25 and 0 at scale 1.
 * @param {number} [scale]  defaults to the installed HUD scale
 * @returns {number}
 */
export function toastLiftPx(scale = currentHudScale()) {
  return scale > 1 ? Math.ceil((scale - 1) * 48) : 0;
}

/**
 * CSS `bottom` (px) of the `#arm-pilot-controls` strip: one FOOTER_GAP_PX above
 * the footer band's top (164 + 8 = 172) with the ladder on, else the shipped 12.
 * @param {boolean} ladderOn
 * @returns {number}
 */
export function armPilotStripBottomPx(ladderOn) {
  return ladderOn ? footerBand({ hintBandPx: _hintBandPx() }).top + RAIL_GEOMETRY.FOOTER_GAP_PX : 12;
}

/**
 * u7 D6: the toast zone is upper-case by default; the two orbit-word explainers (FLOOR_WORDS) are plain
 * sentences and show as written. Decided from the text itself because every toast reaches the zone through
 * the arbiter, which forwards only text / duration / kind.
 * @param {string} text
 * @returns {'none'|'uppercase'}
 */
function _toastCase(text) {
  return (text === FLOOR_WORDS[4] || text === FLOOR_WORDS[5]) ? 'none' : 'uppercase';
}

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

    // Phase 3 (onboarding gating): current mission awareness. MISSION_START is
    // NOT emitted for mission 1 (ScoringSystem._lastMissionNumber starts at 1,
    // so the 1→1 transition is a no-op — see OnboardingDirector note), so the
    // default here MUST behave as mission 1: collision warnings suppressed.
    /** @type {number} Current mission number (default 1). */
    this._missionNumber = 1;
    /** @type {object|null} Current mission profile from MISSION_START (null ⇒ mission 1). */
    this._missionProfile = null;

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
    /** @type {Map<Element, {timer:*, onEnd:Function, done:boolean}>} Task 9 density phase timers */
    this._densityPhases = new Map();
    /** @type {number} Cached right-column top position (UX-2 #11 dynamic layout) */
    this._lastRightColTop = null;   // null until the first write (u7 review: rightColumnTopPx() is null, not 0, before it)

    // Sprint 2 / PR E — cached comms-panel bottom (in CSS px). Avoids a
    // per-frame `getBoundingClientRect()` synchronous-layout flush in
    // [`HUD.update()`](js/ui/HUD.js:835). Recomputed only on:
    //   - window resize
    //   - VIEW_CONFIG_CHANGE (comms panel may show/hide)
    //   - first access (lazy init via `_recomputeCommsRectCache()`)
    /** @type {number|null} */
    this._commsRectBottom = null;

    // Session O (plan D16 (b), owner 2026-09-07): the score strip's rect cache
    // (the exclusion band TargetReticle keeps debris brackets out of). Lazily
    // computed + invalidated on window resize (beside the comms-rect cache);
    // the ONE reused object (no per-frame allocation).
    /** @type {{left:number, top:number, right:number, bottom:number}|null} */
    this._scoreStripRect = null;

    /**
     * Session O (plan D12): the engaged toast-policy flag. The hub (main.js,
     * the ladder per-frame block) sets 'engaged' on engage, null on disengage —
     * write-on-change via setToastPolicy(), so the per-frame call is free.
     * @type {'engaged'|null}
     */
    this._toastPolicy = null;

    /**
     * Session Q (plan D12 / D12c): the ALERT HIERARCHY — ONE pure arbiter
     * (js/ui/hud/AlertHierarchy.js) over the two bottom-centre transient sinks
     * while the engaged policy is set: the notification zone (level 1,
     * `prompt`) and the warning strip (levels 2–3, `alert-amber` / `alert-red`
     * = showWarning's `warning` / `critical`). Levels, the inhibit windows
     * (the intro flyby from the hub; the live approach from the 2 Hz targets
     * tick), one visible at a time, a lower kind never replacing a higher one,
     * a pre-empted lower one replaying after. Both sinks are per-frame
     * write-on-change mirrors of `visible(now)` — the zone's timer and the
     * strip's `_warningQueue` are the null-policy mechanisms and never run
     * while engaged. With the policy null every shipped path is byte for byte.
     */
    this._alerts = new AlertArbiter();
    this._introInhibit = false;      // the hub's setToastInhibit (LadderController.introInFlight)
    this._approachLive = false;      // the 2 Hz poll: the selected row inside reachKm × APPROACH_FACTOR
    this._alertZoneText = null;      // the zone's last arbiter write (null = nothing arbiter-shown)
    this._alertStrip = null;         // the strip's last arbiter write { kind, text } (null = hidden)
    this._alertNow = null;           // optional clock seam (tests); null = performance.now()

    this._scanGateOpen = false;      // the TARGETS + TARGET INFO panes wait for the first scan (once per boot)
    this._floorMask = null;          // h4-simple-first D5: FloorMask hands itself over (attachFloorMask)
    this._infoAnalysed = false;      // h4-simple-first D7: the player pressed Z since the scan (simple mode only needs it)
    this._infoPulled = false;        // a pane the room hides was pulled in after the scan: target info stays open for good (until a new game)
    this._infoGateWait = null;       // last written wait state of the TARGET INFO pane (write-on-change)
    this._railFree = false;          // h4-simple-first D9: the player changed pane level themselves (lifts the first-frame quiet)
    this._railQuiet = true;          // the floor rail is held back (mission 1, before the first scan); the first 10 Hz tick re-decides
    this._railEl = null;             // #ladder-rail, found lazily (the rail builds itself on its first show)
    this._build();
    this._setupEventListeners();
    this._scanGateOn(true);
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
    // Bottom clearance for the dynamic relayout in update() (UX-2 #11): the
    // shipped value is 30 px; ladder-on it is 189 px so the column bottom
    // stays 14 px above the bottom-anchored rail (see maxHeight note below).
    this._rightColBottomClearPx = (Constants.LADDER && Constants.LADDER.ENABLED) ? 189 : 30;
    // Follow-up 2026-09-09 (plan 1788926404388-hud-followups-0909.md §1.15 —
    // the inverted U): the column is as wide as its widest child (Targets 350);
    // `align-items: flex-end` hugs the 280 Debris / Next to the RIGHT edge, so
    // the U's outer edge stays straight at PANE_CORNER_PX (0: COMMS is in the corner).
    Object.assign(this._rightColumn.style, {
      position: 'absolute',
      top: '90px',          // placeholder; update() rewrites from commsBottom + 10
      right: `max(${PANE_CORNER_PX}px, env(safe-area-inset-right))`,   // = COMMS's right edge
      width: `${RIGHT_COLUMN_WIDTH_PX}px`,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-end',
      gap: '10px',          // Pane-to-pane vertical gap — keep in sync with left column (StatusPanel.js)
      // Zoom Ladder G4/G5 (post-M3 review follow-ups): with the ladder on, the
      // rail is bottom-anchored on the right edge and occupies the bottom
      // 175 px (14 px inset + ~161 px body — tmp/g3-rail measurements at 3
      // viewports), so this column must stop 189 px short of the viewport
      // bottom (14 px clear of the rail top) or a filled dossier/tracked-
      // targets column slides under the rail (the G3 play-test complaint).
      // This static value only covers the pre-first-update frames: the LIVE
      // bound is the dynamic relayout in update() (UX-2 #11), which rewrites
      // maxHeight from the comms-derived top using the SAME
      // _rightColBottomClearPx clearance (G5 fix — G4 set only this static
      // value and was clobbered on frame one). Flag-off both sites keep the
      // shipped strings byte-identical (docs/ladder/01-numbers.md §"Post-M3
      // glue").
      // u9-big-text: the column is drawn HUD_SCALE x bigger from its top edge on a big screen: its layout box is
      // (screen room) / scale, so the scaled column ends where it ends today and scrolls inside when longer.
      maxHeight: dividedByScale((Constants.LADDER && Constants.LADDER.ENABLED)
        ? 'calc(100vh - 279px)'   // 90 top + (100vh - 279) height → bottom at 100vh - 189
        : 'calc(100vh - 120px)'),
      overflowY: 'auto',
      zIndex: '10',
      outline: 'none', // No focus ring
      // Task 9: the column's `top` glides when Comms resizes / hides (set top
      // BEFORE un-hiding). The transition lives in the catch-style sheet, NOT
      // inline, so the reduced-motion block can gate it (review 2026-09-08).
    });
    this.container.appendChild(this._rightColumn);

    // --- Wireframe container (mounts inside right column, AFTER TargetPanel) ---
    const wireframeContainer = document.createElement('div');
    wireframeContainer.id = 'hud-wireframe-container';
    wireframeContainer.dataset.hudGroup = 'target-detail';
    wireframeContainer.dataset.activateKey = 'Tab';

    // --- DaughterWireframe (floating, bottom-left — Delegation 3) ---
    this.daughterWireframe = new DaughterWireframe();

    // --- StrutLabels (DOM screen-space labels — Delegation 3) ---
    this.strutLabels = new StrutLabels();

    // --- Instantiate sub-panels ---
    // Session Q (plan D12b): with the ladder on the autopilot chip becomes the
    // MOTHER header's MEMO slot (steady tokens, the A4 box on change); off, the
    // shipped PROPULSION chip byte for byte.
    this.statusPanel = new StatusPanel(this.container, {
      memoSlot: !!(Constants.LADDER && Constants.LADDER.ENABLED),
      cargoPaneVisible: () => this.isRungVisible('cargo'),
    });
    // W2 meters (DECISIONS §15 rows 5 + 8): heat, battery, gas and ion — the
    // VITALS pane is the FIRST child of the left column, above MOTHER. FloorMask
    // rooms it by attribute (shown on F1-F4, gone on F5); never a density rung.
    // h1-mother-pane: ONE pane — the MOTHER section (nets + hover detail) is mounted inside this
    // box, the memo chip rides its title row. The engine row's ΔV comes from a LAZY provider:
    // the arm manager arrives after the HUD is built (setArmManager) and is read on every update.
    this.vitalsPane = new VitalsPane({
      parent: this.statusPanel.leftColumn,
      getMassBudget: () => this._armManager?.getMassBudget?.() ?? null,
    });
    // A HUD pane like the rest: hide() / show() (menu, shop, game over) carry it —
    // the FloorMask's null restore re-shows mask panes, so the panels map must own it.
    if (this.vitalsPane.root) {
      this.panels.vitals = this.vitalsPane.root;
      this.statusPanel.attachToVitals(this.vitalsPane);
    }
    // Ladder reorder rev 3 Task 6: DOM order inside the column is TargetPanel
    // → #hud-wireframe-container → NextPane (Next is parented by main.js as
    // the last child via hud.rightColumnEl).
    this.targetPanel = new TargetPanel(this._rightColumn, { colorLaw: !!(Constants.LADDER && Constants.LADDER.ENABLED) });
    this.targetPanel.onAnalyse = () => this.noteAnalyse();   // h4b D2: a tap on the selected row is analyse
    this._rightColumn.appendChild(wireframeContainer);
    this._wireframeContainerEl = wireframeContainer;
    this.debrisWireframe = new DebrisWireframe(wireframeContainer);
    // Delegation 4 (2026-05-31) — lasso + net inventory chips, just below
    // the target list inside the right column. Subscribes to
    // NET_INVENTORY_CHANGED (the mother's nets + the daughters'); emits INVENTORY_LOW
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
    // u7 D5b: the step chip steps aside for the Targets pane on a short phone (attributes only, no layout read).
    this.hintTicker.setTargetsShown(() => {
      const t = this.panels && this.panels.targets;
      if (!t || !t.hasAttribute) return false;
      return !(t.hasAttribute('data-density-hidden') || t.hasAttribute('data-scan-wait')
        || t.hasAttribute('data-floor-gone') || (t.style && t.style.display === 'none'));
    });

    // --- Warning Strip (bottom center) ---
    this.panels.warnings = this._createPanel('hud-warnings-panel', {
      bottom: '170px', left: '50%', transform: 'translateX(-50%)',
      minWidth: '300px', textAlign: 'center',
    });
    this.panels.warnings.style.display = 'none';
    this.panels.warnings.innerHTML = `
      <div id="hud-warning-text" style="color:var(--hud-warning, #ff4444);font-size:12px;font-weight:bold;"></div>
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
      background: 'rgb(var(--hud-ink-rgb, 0 0 0) / 0.88)', border: '1px solid',
      borderRadius: '4px', padding: '10px 18px', zIndex: '120',
      fontFamily: 'var(--font-mono)',
    });
    this._conjunctionPanel.innerHTML = `
      <div id="hud-conjunction-header"
           style="font-size:13px;font-weight:bold;letter-spacing:2px;"></div>
      <div id="hud-conjunction-details"
           style="font-size:11px;margin-top:6px;opacity:0.92;line-height:1.5;"></div>
    `;
    this.container.appendChild(this._conjunctionPanel);

    // --- Pause Overlay ---
    this._pauseOverlay = document.createElement('div');
    this._pauseOverlay.id = 'hud-pause-overlay';
    Object.assign(this._pauseOverlay.style, {
      position: 'absolute',
      top: '0', left: '0', width: '100%', height: '100%',
      display: 'none',
      background: 'rgb(var(--hud-ink-rgb, 0 10 20) / 0.7)',
      zIndex: '150',
      pointerEvents: 'auto',
      fontFamily: 'var(--font-mono)',
    });
    this._pauseOverlay.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;">
        <div style="font-size:2rem;color:var(--hud-normal, #00ff88);letter-spacing:0.3em;margin-bottom:2rem;
                    text-shadow:0 0 20px rgb(var(--hud-normal-rgb, 0 255 136) / 0.5);">PAUSED</div>
        <div id="pause-resume-btn" style="font-size:1rem;color:var(--hud-normal, #00ff88);cursor:pointer;padding:10px 30px;
            border:1px solid rgb(var(--hud-normal-rgb, 0 255 136) / 0.5);border-radius:4px;margin:8px;
            background:rgb(var(--hud-normal-rgb, 0 255 136) / 0.1);letter-spacing:0.15em;">
            RESUME [P / ESC]
        </div>
        <div id="pause-menu-btn" style="font-size:1rem;color:var(--hud-caution, #ffaa00);cursor:pointer;padding:10px 30px;
            border:1px solid rgb(var(--hud-caution-rgb, 255 170 0) / 0.4);border-radius:4px;margin:8px;
            background:rgb(var(--hud-caution-rgb, 255 170 0) / 0.08);letter-spacing:0.15em;">
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

    // --- Weather Indicator Container (small badges) ---
    // followups-1018 D4: it no longer floats at top:10px/left:10px over the MOTHER pane (which now sits flush in the
    // top-left corner); it is a child of the left column, directly after the MOTHER pane, so a badge sits below it at
    // the same left edge. Empty = display:none = no space, nothing shifts in normal play (_addWeatherBadge shows it).
    this._weatherContainer = document.createElement('div');
    this._weatherContainer.id = 'hud-weather-indicator';
    Object.assign(this._weatherContainer.style, {
      display: 'none',
      flexDirection: 'column',
      gap: '4px',
      pointerEvents: 'none',
    });
    const leftCol = this.statusPanel && this.statusPanel.leftColumn;
    const motherPane = this.statusPanel && this.statusPanel.panels && this.statusPanel.panels.mother;
    if (leftCol && motherPane && typeof leftCol.insertBefore === 'function' && motherPane.parentNode === leftCol) {
      leftCol.insertBefore(this._weatherContainer, motherPane.nextSibling || null);
    } else if (leftCol && typeof leftCol.appendChild === 'function') {
      leftCol.appendChild(this._weatherContainer);
    } else {
      this.container.appendChild(this._weatherContainer);
    }
    /** @type {Map<string, HTMLElement>} Active weather badge elements by type */
    this._weatherBadges = new Map();

    // The F1 inspection-depth breadcrumb (round 4 T5: the bottom-centre
    // INSPECT strip at bottom 148 that lit the current band word — SYSTEMS /
    // PARTS / DETAIL — plus a one-shot "zoom in" hint) was RETIRED 2026-09-09
    // (owner: confusing; plan .kilo/plans/1788954873769-one-workbench-pane.md
    // §D8). Nothing replaces it — the callout cards speak for themselves. The
    // pane-dim below (the same CALLOUT_BAND_CHANGE edge) stays. test-Fonts
    // pins the absence.

    // --- Inspection pane-dim (round 5) ---
    // While callouts are active (either inspection path), ghost the HUD pane
    // columns so the blueprint cards own the screen. The panes stay glanceable
    // (NET/ΔV) but stop competing: screenshots showed right-rail cards sliding
    // under the dossier/tracked panes and the old green palette clashing with
    // the cyan blueprint chrome. ID-scoped selectors beat `.hud-active`'s
    // `opacity: 1.0` (specificity 1,2,1 vs 0,1,0); the class is toggled from
    // the CALLOUT_BAND_CHANGE handler below.
    if (!document.getElementById('callout-dim-style')) {
      const dimStyle = document.createElement('style');
      dimStyle.id = 'callout-dim-style';
      dimStyle.textContent = `
        #hud-left-column, #hud-right-column, #hud-comms-panel {
          transition: opacity 450ms ease;
        }
        #hud-overlay.callouts-active #hud-left-column,
        #hud-overlay.callouts-active #hud-right-column,
        #hud-overlay.callouts-active #hud-comms-panel {
          opacity: 0.35;
          pointer-events: none;
        }
      `;
      document.head.appendChild(dimStyle);
    }

    // --- Net-ceremony cinema mode (2026-08-25, filmstrip analysis) ---
    // The camera cut + CeremonyTimeScale slow-mo are the cinema. The HUD used to
    // ghost to 10% opacity while the camera owned the screen; REMOVED 2026-10-05
    // (owner 2026-09-30: "interferes with sim") — capture never dims the panes.
    // The 500ms opacity transition stays: per-view hudOpacity dims and
    // callouts-active use it. The `net-cinema` body class is still toggled.
    if (!document.getElementById('net-cinema-style')) {
      const cinemaStyle = document.createElement('style');
      cinemaStyle.id = 'net-cinema-style';
      cinemaStyle.textContent = `
        #hud-overlay > * { transition: opacity 500ms ease; }
      `;
      document.head.appendChild(cinemaStyle);
    }

    // --- Inject catch-effect CSS animations (Phase 1C) + detach flash (Phase 6) + codex/weather (Phase 7) ---
    if (!document.getElementById('catch-effects-style')) {
      const catchStyle = document.createElement('style');
      catchStyle.id = 'catch-effects-style';
      catchStyle.textContent = `
        /* Pane-density ladder (-/+): panes tagged data-density-hidden are hard
         * off. !important beats the inline display writes from view-switch code
         * (HUD._applyViewConfig) and the content-driven warnings re-show in the
         * update loop, so a density-hidden pane cannot be resurrected by those
         * paths — only the ladder (+) or the pane's own toggle (7/8/9/0) clears it. */
        [data-density-hidden] { display: none !important; }
        /* DAUGHTERS pane waits for the struts (owner 2026-10-12): hidden until the
         * struts first open this boot (HUD._tickArmsGate), whatever the floor. */
        [data-arms-wait] { display: none !important; }
        /* TARGETS + TARGET INFO wait for the first scan (owner 2026-10-13): hidden
         * until the first SCAN_COMPLETE of this boot (HUD._openScanGate), whatever
         * the floor; nothing is marked before then, so the lists would be empty. */
        [data-scan-wait] { display: none !important; }
        /* Layout-hidden left-arm riders (LeftStack). Never the density bit. */
        [data-stack-hidden] { display: none !important; }
        #hud-pin-widget, #hud-right-column {
          transition: top ${DENSITY_MOTION_MS}ms ${DENSITY_MOTION_EASING};
        }
        /* Task 9 — animated reflow (rev 3). Max-height (not grid 0fr): TargetPanel
         * (overflow-y + inner flex header), NextPane (display:flex column), and
         * #hud-wireframe-container own layouts that display:grid on the root
         * would break. Leaving pane is treated as hidden by isVisible(). */
        [data-density-leaving] {
          overflow: hidden !important;
          opacity: 0;
          margin-top: 0;
          margin-bottom: 0;
          max-height: 0 !important;
          transition: max-height ${DENSITY_MOTION_MS}ms ${DENSITY_MOTION_EASING},
                      opacity ${DENSITY_MOTION_MS}ms ${DENSITY_MOTION_EASING},
                      margin ${DENSITY_MOTION_MS}ms ${DENSITY_MOTION_EASING};
        }
        [data-density-entering] {
          overflow: hidden;
          opacity: 0;
          max-height: 0;
        }
        /* Pane-density "quiet" mode (Reticles & alerts rung engaged): mute
         * transient teaching/hint POPUPS that are re-created per show() and so
         * can't be tagged individually on the keypress. A body-level attribute +
         * CSS catches current AND future cards continuously. */
        body[data-density-quiet] .teaching-overlay { display: none !important; }
        /* Mission-1 onboarding: while the guided pipeline runs, suppress the
         * dormant-panel keycap badges so the teaching beats own attention.
         * Mirrors the density-quiet rule above; cleared on ONBOARDING_COMPLETE /
         * GAME_RESET. Veteran-skip (COMPLETE without STARTED) never sets it. */
        body[data-onboarding-active] [data-hud-group].hud-dormant[data-activate-key]::after { display: none; }
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
            font-family: var(--font-mono);
            font-size: 10px;
            font-weight: 700;
            letter-spacing: 0.5px;
            color: rgb(var(--hud-caution-rgb, 255 200 80) / 0.95);
            background: rgb(var(--hud-ink-rgb, 20 14 6) / 0.55);
            border: 1px solid rgb(var(--hud-caution-rgb, 255 200 80) / 0.65);
            border-radius: 3px;
            box-shadow: 0 0 6px rgb(var(--hud-caution-rgb, 255 200 80) / 0.35);
            pointer-events: none;
            opacity: 1;
            transition: opacity 0.45s ease;
            z-index: 20;
        }
        [data-hud-group].hud-active[data-activate-key]::after {
            opacity: 0;
        }
        @keyframes detachTextFloat {
          0%   { opacity: 1; transform: translate(-50%, -50%) scale(1.5); }
          30%  { opacity: 1; transform: translate(-50%, -70%) scale(1.2); }
          100% { opacity: 0; transform: translate(-50%, -130%) scale(0.9); }
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
          /* Phase 1 #12: silence the remaining finite alert animations — the
           * conjunction RED pulse and the floating alert texts. The elements
           * still show (steady) and self-remove on their timers. */
          #hud-conjunction-panel { animation: none !important; }
          .hud-alert-float { animation: none !important; }
          #hud-pin-widget, #hud-right-column { transition: none !important; }
        }
      `;
      document.head.appendChild(catchStyle);
    }

    // --- Notification Zone (bottom-center, UX-2 #12) ---
    // Delegation 4 (2026-05-31) — Browser-playtest Bug 2 fix — dropped the toast
    // from bottom:132 to bottom:48 because 132 then sat inside the band shared
    // by the salvage-reveal popup (bottom:120) and the SAFETY OVERRIDE gag's
    // baseline. Follow-up 2026-09-09 (plan 1788926404388-hud-followups-0909.md
    // §1.4): with the ladder on the gag lives at the viewport bottom (12–68)
    // and the footer band's centre (132–164) is free, so the toast goes back
    // to 132 = `toastBottomPx(true)` — clear of the ticker (88–124), of the
    // gag, and below the warnings panel (170). `?ladder=0` keeps 48 byte for
    // byte. The flag is read HERE (the constructor path): the URL flips it
    // inside init() before `new HUD`, so a module-level read would be stale.
    const ladderOn = !!(Constants.LADDER && Constants.LADDER.ENABLED);
    this._notificationZone = document.createElement('div');
    this._notificationZone.id = 'notification-zone';
    Object.assign(this._notificationZone.style, {
      position: 'fixed',
      bottom: `${toastBottomPx(ladderOn) + toastLiftPx()}px`,
      left: '50%',
      transform: 'translateX(-50%)',
      textAlign: 'center',
      zIndex: '100',
      color: 'var(--hud-normal, #00ffcc)',
      fontFamily: 'var(--font-mono)',
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

    // --- Pane-density ladder (bare -/+ keys) ---
    this._initPaneDensity();

    // --- S1 retention: pinned next-upgrade progress widget ---
    this._buildPinWidget();

    // --- Pane help (Wave 4, 08-workbench §11): data-help on every pane header,
    // ONE delegated handler set (glossaryDom pattern) for hover-tooltip /
    // click-deep-link / long-press-on-touch. Entries resolve lazily because
    // setCodexSystem() is wired from main.js after construction.
    this.paneHelp = new PaneHelp({
      getEntry: (id) => (this._codexSystem && typeof this._codexSystem.getEntry === 'function')
        ? this._codexSystem.getEntry(id) : null,
      // Rev 3 Task 16: rows derive `label (rung i/total)` from the LIVE ladder
      // (a getter — PaneDensity is built after this panel, and main.js splices
      // the instruments in later; `?ladder=0` reads its own 11-rung shape).
      ladder: () => this._paneDensity || null,
    });
    this.paneHelp.install();
  }

  /**
   * @private Build the compact pinned-next-upgrade HUD widget (S1 retention).
   * One glanceable line near the credits readout: `▸ NAME 2,140/3,000 cr` with a
   * thin progress bar; switches to a highlighted READY state when affordable.
   * No modal, no interruption. Hidden until an upgrade is pinned.
   */
  _buildPinWidget() {
    const el = document.createElement('div');
    el.id = 'hud-pin-widget';
    Object.assign(el.style, {
      position: 'absolute',
      left: `max(${PANE_CORNER_PX}px, env(safe-area-inset-left))`,   // = the left column's edge
      width: `${HUD_COLUMN_WIDTH_PX}px`,
      padding: '4px 8px',
      background: 'rgb(var(--hud-ink-rgb, 0 0 0) / 0.72)',
      border: '1px solid rgb(var(--hud-caution-rgb, 240 192 64) / 0.35)',
      color: `var(--hud-text, ${VisualLaw.COLORS.VALUE})`,
      fontFamily: 'var(--font-mono)',
      fontSize: '11px',
      letterSpacing: '0.04em',
      pointerEvents: 'none',
      display: 'none',
      zIndex: '12',
    });
    el.innerHTML = `
      <div id="hud-pin-label" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>
      <div style="height:3px;margin-top:3px;background:rgb(var(--hud-caution-rgb, 240 192 64) / 0.15);border-radius:2px;overflow:hidden;">
        <div id="hud-pin-bar" style="height:100%;width:0%;background:var(--hud-caution, #f0c040);transition:width 0.3s ease;"></div>
      </div>`;
    this.container.appendChild(el);
    this._pinWidget = el;
    /** @type {{id:string,name:string,cost:number}|null} */
    this._pinned = null;
    /** @private guards the one-shot READY comms per pin */
    this._pinReadyFired = false;
  }

  /**
   * @private Update the pinned-upgrade widget from the current pin + credits.
   * Uses the pure pinProgress helper so display math is unit-tested.
   */
  _updatePinWidget() {
    if (!this._pinWidget) return;
    if (!this._pinned || !this._pinned.id || !(this._pinned.cost > 0)) {
      this._pinWidget.style.display = 'none';
      return;
    }
    const { pct, remaining, affordable } = pinProgress(this._credits, this._pinned);
    // The pin is player-chosen (pinned in the shop), so show it immediately —
    // even at 0 credits — it is a goal the player actually picked.
    const label = this._pinWidget.querySelector('#hud-pin-label');
    const bar = this._pinWidget.querySelector('#hud-pin-bar');
    if (affordable) {
      this._pinWidget.style.borderColor = 'rgb(var(--hud-normal-rgb, 0 255 136) / 0.55)';
      this._pinWidget.style.color = `var(--hud-normal, ${VisualLaw.COLORS.PLAYER})`;
      if (label) label.textContent = `▸ ${this._pinned.name} — READY AT DEPOT`;
      if (bar) { bar.style.width = '100%'; bar.style.background = `var(--hud-normal, ${VisualLaw.COLORS.PLAYER})`; }
      if (!this._pinReadyFired) {
        this._pinReadyFired = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          source: 'HOUSTON',
          text: `You've got the credits for ${this._pinned.name}. See you at the depot.`,
          priority: 1,
        });
      }
    } else {
      this._pinWidget.style.borderColor = 'rgb(var(--hud-caution-rgb, 240 192 64) / 0.35)';
      this._pinWidget.style.color = `var(--hud-text, ${VisualLaw.COLORS.VALUE})`;
      if (label) {
        label.textContent = `▸ ${this._pinned.name} ${Math.round(this._credits).toLocaleString()}/${this._pinned.cost.toLocaleString()} cr`;
      }
      if (bar) { bar.style.width = `${Math.round(pct * 100)}%`; bar.style.background = `var(--hud-text, ${VisualLaw.COLORS.VALUE})`; }
      void remaining;
    }
    this._pinWidget.style.display = 'block';
  }

   /**
    * @private Build the pane-priority density ladder (rev 3) and wire it to
    * HUD_DENSITY_DOWN/UP. Plan:
    * tmp/plans/1788867799156-hud-pane-ladder-reorder.md
    *
    * 10 base rungs (also the `?ladder=0` order; hide order 2026-10-22). Index 0 sheds first on `-`;
    * slider level k = last k rungs. main.js (ladder gate) splices four
    * instruments via insertBefore and adds the Override gag as a member of
    * `experimental`. 14 rungs → 15 detents. The alerts & indicators chrome is a FOLLOWER, not a
    * rung (it goes with the last HUD step). Adapters read/drive LIVE pane
    * state so the ladder needs no counter and composes with the 7/8/9/0
    * toggles.
    */
  _initPaneDensity() {
    // DOM rung: hidden via the data-density-hidden attribute (CSS !important),
    // which survives inline display writes from view-switch / update code.
    // isVisible() also honours ANCESTOR visibility (getClientRects): the
    // debris/target/arms/mother panes live inside the right/left columns that
    // _applyViewConfig() collapses in minimal views (e.g. Overview). Without the
    // rects check the ladder would "hide" a pane that isn't on screen, waste a
    // rung, and leave it density-hidden after the view switches back.
    const self = this;
    const domRung = (id, label, getEls) => ({
      id, label,
      isVisible: () => getEls().some(el => self._densityIsVisible(el)),
      // Slider slots: a pane is a slot while it shows OR the ladder itself is what hides it
      // (its density bit). A pane that cannot show right now (waiting for the scan / the
      // daughters gate, or off screen with no bit of ours on it) is not a slot.
      isAvailable: () => getEls().some(el => self._densityIsAvailable(el)),
      setVisible: (v) => getEls().forEach(el => {
        if (!el) return;
        self._densitySetVisible(el, v);
      }),
    });
    const byId = (id) => () => [document.getElementById(id)];
    const bySelector = (sel) => () => Array.from(document.querySelectorAll(sel));

    // Flag rung: a "suppression category" whose hidden state is a HUD-level flag
    // (NOT read from the DOM) so it ENGAGES even when its target is not
    // momentarily on screen — hiding the reticle / warning category keeps future
    // brackets & alerts suppressed in pure scenery, and the craft / constellation
    // categories drive scene objects that carry no data-density attribute.
    // `apply(hidden)` performs the concrete hide/show.
    const flagRung = (id, label, apply, world, gate) => {
      const rung = {
        id, label, _hidden: false,
        // `gate` (optional): () => boolean, false while the category cannot show yet. A gated rung
        // that waits reads hidden, like a pane that waits (`-` and `+` walk past it) and is no slider slot.
        isVisible: () => !rung._hidden && (typeof gate !== 'function' || gate() !== false),
        isAvailable: () => typeof gate !== 'function' || gate() !== false,
        setVisible: (v) => { rung._hidden = !v; apply(rung._hidden); },
      };
      if (world === true) rung.world = true;
      return rung;
    };

    // Toggle data-density-hidden across a fixed selector set (flag rungs whose
    // DOM targets are frequently display:none when inactive).
    const applyAttr = (selectors, hidden) => {
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach(el => {
          if (hidden) el.setAttribute('data-density-hidden', '');
          else el.removeAttribute('data-density-hidden');
        });
      }
    };

    // Constellation names + celestial body (Sun / Moon / planet) NAME labels —
    // world annotations, not HUD (the discs & stars stay). Remember the player's
    // prior constellation choice and only restore it on `+`; the body labels are
    // occlusion-gated with no player toggle, so they just follow the flag.
    this._constellationsWereOn = false;
    const applySkyLabels = (hidden) => {
      const sf = this._starfield;
      if (sf && typeof sf.setConstellationsVisible === 'function') {
        if (hidden) {
          this._constellationsWereOn = typeof sf.isConstellationsVisible === 'function'
            ? sf.isConstellationsVisible() : true;
          sf.setConstellationsVisible(false);
        } else if (this._constellationsWereOn) {
          sf.setConstellationsVisible(true);
          this._constellationsWereOn = false;
        }
      }
      const sl = this._sunLight;
      if (sl && typeof sl.setBodyLabelsVisible === 'function') sl.setBodyLabelsVisible(!hidden);
    };

    // Craft — the mother ship + all daughters. Prior visibility is remembered so
    // a restore never fights the external owners that also toggle these (main.js
    // hides the mother during menu/cutscene handoffs; ArmUnit hides a daughter's
    // group on deorbit).
    const applyCraft = (hidden) => {
      const mother = this._motherCraft;
      if (mother) {
        if (hidden) { this._motherPrevVisible = mother.visible; mother.visible = false; }
        else if (this._motherPrevVisible != null) {
          mother.visible = this._motherPrevVisible;
          this._motherPrevVisible = null;
        }
      }
      const am = this._armManager;
      if (am && typeof am.setFleetVisible === 'function') am.setFleetVisible(!hidden);
    };

    // World steps (owner 2026-10-22: no `-`/`+` press shows nothing). A step's gate reads what the
    // floor and the settings fix, never what the camera happens to see this frame, so the slider's
    // positions do not change while the player pans. Sky labels and ships have none: measured on
    // floors 1-5 they exist on every floor (tmp/t2/walk-before-mac.json); only the city labels
    // (`cityCanShow`) and the target marks (scan + floor gate) can be steadily absent.
    const cityCanShow = () => {
      const cl = self._cityLabels;
      if (!cl) return false;
      return typeof cl.canShow === 'function' ? cl.canShow() !== false : true;
    };
    const skylabelsFlag = flagRung('skylabels', 'Sky labels', applySkyLabels, true);

    // Rungs ordered lowest-priority → highest (index 0 hides FIRST on `-`,
    // restores LAST on `+`). 10 base rungs (also `?ladder=0`); main.js splices
    // four instruments in at the ladder gate (copilot, next, orbit, cargo) and
    // adds the Override gag to `experimental` as a member: 14 rungs → 15
    // detents; slider level k = last k rungs. Hide order (owner 2026-10-22):
    // targets → target marks → daughters → comms → score → whole mother box
    // (section included, one step) → ships & city labels (one step); the alerts go with the last HUD step.
    const rungs = [
      // 0 — Experimental: nav orb + discoveries. main.js addMember()s the
      //     Override gag at the ladder gate (still the last `+`).
      compositeRung('experimental', 'Experimental', [
        {
          id: 'navsphere', label: 'Nav orb',
          isVisible: () => !!(this._navSphere && this._navSphere.isOrbVisible && this._navSphere.isOrbVisible()),
          setVisible: (v) => { if (this._navSphere && this._navSphere.setOrbHidden) this._navSphere.setOrbHidden(!v); },
        },
        // Rev 3 Task 10: the Discoveries pane is a footer-chip popover inside
        // the `#hud-discoveries` wrapper (chip + `.skills-pane`); the density
        // bit lands on the WRAPPER so the rung hides chip and popover together.
        domRung('discoveries', 'Discoveries', byId('hud-discoveries')),
      ]),
      // 1 — Sky labels (world) + pinned next-upgrade goal.
      compositeRung('decor', 'Sky labels & goal pin', [
        skylabelsFlag,
        domRung('pin', 'Upgrade goal', byId('hud-pin-widget')),
      ]),
      // 2 — Debris analysis pane (9 key re-reveals it).
      domRung('debris', 'Target info pane', byId('hud-wireframe-container')),
      // 3 — Targets pane (0 key re-reveals it).
      domRung('targets', 'Targets pane', byId('hud-targets-panel')),
      // 4 — Target marks (owner 2026-10-21: "targeting reticles should be hidden before
      //     daughters pane"): the whole #reticle-canvas — target brackets and their "▸ N"
      //     prompt, prograde/retrograde markers, active-satellite diamonds, lasso cooldown
      //     ring, AP badge, off-screen arrows. A flag rung (engages even when the canvas is
      //     momentarily blank), and the ONE writer of the canvas's hide bit: FloorMask's
      //     `reticles` entry points at this step.
      //     It waits for the first scan like the Targets and Target info panes ("No reticles until
      //     you scan", DECISIONS §15 row 1; owner 2026-10-22 "Keep scan-first", and no empty `-`/`+`
      //     press): before it nothing is painted, so a `-` there would change nothing. The same
      //     holds on the route and chart floors (F4/F5), where the ladder keeps the aiming
      //     reticles off whatever this step says (LadderController._setReticlesHidden):
      //     main.js hands `setTargetMarksFloorGate` the floor's answer.
      flagRung('targetmarks', 'Target marks', (hidden) => { applyAttr(['#reticle-canvas'], hidden); },
        false, () => self._scanGateOpen === true
          && (typeof self._targetMarksFloorGate !== 'function' || self._targetMarksFloorGate() !== false)),
      // 5 — Daughters / arms pane (owner 2026-10-21: before comms).
      domRung('arms', 'Daughters pane', byId('hud-arms-panel')),
      // 6 — Comms pane (7 key re-reveals it).
      domRung('comms', 'Comms', byId('hud-comms-panel')),
      // 7 — Score strip + hint ticker (one rung).
      domRung('score', 'Score strip', () => [
        document.getElementById('hud-score-panel'),
        document.getElementById('hud-hint-ticker'),
      ]),
      // 8 — The whole MOTHER box in ONE step (owner 2026-10-22: "can these be combined into one
      //     '-' or '+' keypress"): heat, battery, gas, ion and the MOTHER section inside it. A
      //     composite, so one `-` hides both and one `+` brings both back. The members keep their
      //     own ids because FloorMask drives them separately: `vitals` is the ONE writer of
      //     #hud-vitals's hide bit (the F1 drawer cover in main.js writes `style.visibility`, a
      //     different bit), `mother` the ONE writer of the MOTHER section's (shown on F2 only by
      //     default). The composite reads visible while the box shows, even with the section
      //     hidden; a `-` then `+` brings the section back on floors that start without it.
      compositeRung('motherbox', 'Mother & meters', [
        domRung('vitals', 'Meters box', byId('hud-vitals')),
        domRung('mother', 'Mother pane', byId('hud-mother-panel')),
      ]),
      // 9 — Ships & city labels (world, the last step; owner 2026-10-22). One step because whether a
      //     city label is in view depends on the camera, so a step of its own could show nothing.
      //     One `-` hides both, one `+` shows both. Members: the mother ship + daughters, and the
      //     city/landmark pills. The pills adapter reads CityLabels' OWN density flag — not the DOM —
      //     so it engages while F1/F5 suppression already hides the pills, and the 5 key can clear
      //     the gate coherently; its gate (`cityCanShow`: 5-key preference on, floor not
      //     suppressing) only decides whether the LABELS part can show. The ships always can, so
      //     the step is always a slot. Whether a pill happens to be in view this frame is the
      //     camera's business, never the step's.
      (() => {
        const ships = flagRung('ships', 'Ships', applyCraft, true);
        const cityPills = {
          id: 'citypills', label: 'City labels', world: true,
          isVisible: () => cityCanShow() && !!(this._cityLabels && typeof this._cityLabels.isDensityHidden === 'function' && !this._cityLabels.isDensityHidden()),
          isAvailable: () => cityCanShow(),
          setVisible: (v) => { const cl = this._cityLabels; if (cl && typeof cl.setDensityHidden === 'function') cl.setDensityHidden(!v); },
        };
        const step = compositeRung('craft', 'Ships & city labels', [ships, cityPills]);
        step.world = true;
        return step;
      })(),
    ];

    // Alerts & indicators: not a step of its own. It hides the warnings, progress, conjunction and
    // weather chrome, the arm-pilot controls, the camera-view indicator and the docking reticle, and
    // mutes gameplay toasts, but only while no HUD step is showing — the press that hides the last
    // HUD step takes it along, the press that brings a HUD step back returns it (owner 2026-10-22:
    // as its own step it showed the player nothing, so `+` next to the mother ship looked dead).
    // Safety: it stays late, because it only ever goes with the last HUD step.
    const alertsFollower = flagRung('reticles', 'Alerts & indicators', (hidden) => {
      applyAttr([
        '#docking-reticle-canvas',
        '#hud-warnings-panel', '#hud-progress-panel', '#hud-conjunction-panel',
        '#hud-weather-indicator', '#arm-pilot-controls', '#camera-view-indicator',
      ], hidden);
      // Mute gameplay toasts (autopilot/view/inspection); the ladder's own
      // toasts pass force:true and still show (see showNotification). The body
      // attribute additionally CSS-hides transient teaching/hint popups
      // (.teaching-overlay) that are re-created per show() (onboarding
      // escalations like "LAUNCH NET (N)"), which per-element tagging misses.
      this._transientPopupsQuiet = hidden;
      if (typeof document !== 'undefined' && document.body) {
        document.body.toggleAttribute('data-density-quiet', hidden);
      }
    });

    this._paneDensity = new PaneDensity({
      rungs,
      followers: [alertsFollower],
      notify: (text, kind) => this.showNotification(text, 2500, { force: true, kind }),
      log: (text) => eventBus.emit(Events.COMMS_MESSAGE, {
        text, priority: 'info', source: 'HUD', _reactive: true,
      }),
      // Wave 5 Session H (Job A — the D5 room-memory write trigger): the
      // density ladder's flip edge, once per FLIPPED rung, after its
      // setVisible ran. Wired here (not inside PaneDensity — that module is
      // pure/EventBus-free by design) and NOT on the rung adapters: FloorMask
      // drives rung.setVisible directly on every floor change, and a mask
      // write must never read as a player edit.
      onFlip: (paneId, shown) => eventBus.emit(Events.HUD_PANE_VISIBILITY, {
        pane: paneId, shown,
      }),
    });
    this._paneDensity.attach(eventBus, Events);
  }

  /**
   * 10 Hz guard: if any HUD pane is showing while the alerts & indicators are muted, show them. The 7
   * key, panes that get content or appear after a scan, and leaving the look-around view bring a pane
   * back without any visibility event. Show-only (only a `-` press mutes); cheap when nothing is muted.
   * @private
   */
  _pollAlerts() {
    if (this._paneDensity) this._paneDensity.revealFollowers();
  }

  /**
   * The pane-density ladder instance — consumed by the iPad touch slider
   * (js/ui/TouchControls.js), which drives it via setLevel()/visibleCount()
   * so keys, per-pane toggles and the slider all compose on live state.
   */
  get paneDensity() { return this._paneDensity; }

  /**
   * Density-rung visibility for LeftStack.hidden(). Layout-hidden
   * (`data-stack-hidden`) is NOT a density hide — `_densityIsVisible` treats
   * it as still visible so the stack can un-hide. Returns false when the
   * rung is missing or throws.
   * @param {string} id
   * @returns {boolean}
   */
  isRungVisible(id) {
    const pd = this._paneDensity;
    if (!pd || typeof pd.find !== 'function') return false;
    try {
      const rung = pd.find(id);
      if (!rung) return false;
      return !!rung.isVisible();
    } catch (_e) { return false; }
  }

  /**
   * Pin widget natural height (measured when laid out, else PIN_NATURAL_PX).
   * @returns {number}
   */
  pinNaturalPx() {
    const el = this._pinWidget;
    if (el && typeof el.offsetHeight === 'number' && el.offsetHeight > 0) return el.offsetHeight;
    return PIN_NATURAL_PX;
  }

  /**
   * LeftStack apply for the pin widget. Writes `top` BEFORE un-hiding.
   * mode 'hidden' → data-stack-hidden (never the density bit).
   * @param {number} top
   * @param {number} _height
   * @param {'natural'|'compact'|'trimmed'|'hidden'} mode
   */
  setPinAnchor(top, _height, mode) {
    const el = this._pinWidget;
    if (!el || !el.style) return;
    const t = Number(top);
    const topStr = `${Math.round(Number.isFinite(t) ? t : 0)}px`;
    if (el.style.top !== topStr) el.style.top = topStr;
    if (mode === 'hidden') {
      if (el.setAttribute) el.setAttribute('data-stack-hidden', '');
    } else if (el.removeAttribute) {
      el.removeAttribute('data-stack-hidden');
    }
  }

  /**
   * The right-arm column (`#hud-right-column`). NextPane mounts as its last
   * child (main.js: `new NextPane({ …, parent: hud.rightColumnEl })`).
   * @returns {HTMLElement|null}
   */
  get rightColumnEl() { return this._rightColumn; }

  /**
   * Task 9 — injectable clock for density hide/show. Tests set
   * `HUD._densityMotion = { raf, setTimeout, clearTimeout, reducedMotion }`.
   * @returns {{raf:Function, setTimeout:Function, clearTimeout:Function, reducedMotion:Function}}
   * @private
   */
  _densityMotionHooks() {
    const h = HUD._densityMotion;
    if (h) return h;
    return {
      raf: (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16)),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
      reducedMotion: () => {
        try {
          return typeof matchMedia === 'function'
            && !!matchMedia('(prefers-reduced-motion: reduce)').matches;
        } catch (_e) { return false; }
      },
    };
  }

  /**
   * DOM-rung visibility: `data-density-hidden` OR `data-density-leaving` reads
   * as hidden so a `-`/`+` during the glide sees the right state. Ancestor
   * collapse (getClientRects) still applies.
   * @param {Element|null} el
   * @returns {boolean}
   */
  _densityIsVisible(el) {
    if (!el) return false;
    if (el.hasAttribute && (el.hasAttribute('data-density-hidden') || el.hasAttribute('data-density-leaving')
      || el.hasAttribute('data-arms-wait') || el.hasAttribute('data-scan-wait'))) {
      return false;
    }
    // Layout-hidden is not a density hide — LeftStack must be able to un-hide.
    if (el.hasAttribute && el.hasAttribute('data-stack-hidden')) return true;
    try {
      return typeof el.getClientRects === 'function' && el.getClientRects().length > 0;
    } catch (_e) {
      return false;
    }
  }

  /**
   * Slider slot test for a DOM pane: could this element show once the ladder lets it? True when it
   * shows now, or when our density bit is what hides it (leaving / hidden / layout-hidden). A wait
   * gate (scan / daughters) is not ours to lift, so it is no slot.
   * @param {Element|null} el
   * @returns {boolean}
   */
  _densityIsAvailable(el) {
    if (!el) return false;
    if (el.hasAttribute && (el.hasAttribute('data-arms-wait') || el.hasAttribute('data-scan-wait'))) return false;
    if (el.hasAttribute && (el.hasAttribute('data-density-hidden') || el.hasAttribute('data-density-leaving')
      || el.hasAttribute('data-stack-hidden'))) return true;
    return this._densityIsVisible(el);
  }

  /** @param {Element} el @param {boolean} v */
  _densitySetVisible(el, v) {
    if (!el || !el.setAttribute) return;
    if (v) this._densityShow(el);
    else this._densityHide(el);
  }

  /** @param {Element} el */
  _densityCancel(el) {
    if (!this._densityPhases) this._densityPhases = new Map();
    const st = this._densityPhases.get(el);
    if (!st) return;
    const hooks = this._densityMotionHooks();
    if (st.timer != null) hooks.clearTimeout(st.timer);
    if (st.onEnd && el.removeEventListener) el.removeEventListener('transitionend', st.onEnd);
    this._densityPhases.delete(el);
  }

  /** @param {Element} el */
  _densityHide(el) {
    if (el.hasAttribute && el.hasAttribute('data-density-hidden')) return;
    if (el.hasAttribute && el.hasAttribute('data-density-leaving')) return;
    const hooks = this._densityMotionHooks();
    this._densityCancel(el);
    if (el.removeAttribute) el.removeAttribute('data-density-entering');
    if (hooks.reducedMotion && hooks.reducedMotion()) {
      el.setAttribute('data-density-hidden', '');
      return;
    }
    el.setAttribute('data-density-leaving', '');
    const finish = () => {
      const st = this._densityPhases.get(el);
      if (!st || st.done) return;
      st.done = true;
      if (el.removeAttribute) el.removeAttribute('data-density-leaving');
      el.setAttribute('data-density-hidden', '');
      this._densityCancel(el);
    };
    const onEnd = (ev) => { if (ev && ev.target && ev.target !== el) return; finish(); };
    if (!this._densityPhases) this._densityPhases = new Map();
    const timer = hooks.setTimeout(finish, DENSITY_MOTION_MS + 20);
    this._densityPhases.set(el, { timer, onEnd, done: false });
    if (el.addEventListener) el.addEventListener('transitionend', onEnd);
  }

  /** @param {Element} el */
  _densityShow(el) {
    const leaving = el.hasAttribute && el.hasAttribute('data-density-leaving');
    const hidden = el.hasAttribute && el.hasAttribute('data-density-hidden');
    const entering = el.hasAttribute && el.hasAttribute('data-density-entering');
    if (!leaving && !hidden && !entering) return;
    this._densityCancel(el);
    if (el.removeAttribute) {
      el.removeAttribute('data-density-leaving');
      el.removeAttribute('data-density-hidden');
    }
    const hooks = this._densityMotionHooks();
    if (hooks.reducedMotion && hooks.reducedMotion()) {
      if (el.removeAttribute) el.removeAttribute('data-density-entering');
      return;
    }
    el.setAttribute('data-density-entering', '');
    hooks.raf(() => {
      if (el.removeAttribute) el.removeAttribute('data-density-entering');
    });
  }

  /**
   * Land every in-flight density phase (GAME_RESET / view switch). A pending
   * HIDE is FINISHED — `data-density-leaving` stripped, `data-density-hidden`
   * set — never dropped: dropping it left the pane on screen while `setFloor`
   * (idempotent) never retried the room, which is how the DISCOVERIES chip
   * stayed up on F2 after a mid-glide view switch (owner report 2026-09-09;
   * plan 1788926404388-hud-followups-0909.md §1.9). An ENTERING pane is just
   * stripped (it is already un-hidden). Resting `data-density-hidden` is
   * untouched. Every `_densityPhases` entry is a pending hide (`_densityShow`
   * registers none); the document sweep catches phases from an earlier HUD.
   */
  _clearDensityPhases() {
    const finishHide = (el) => {
      if (!el || !el.removeAttribute || !el.setAttribute) return;
      el.removeAttribute('data-density-leaving');
      el.setAttribute('data-density-hidden', '');
    };
    const strip = (el) => {
      if (el && el.removeAttribute) el.removeAttribute('data-density-entering');
    };
    if (this._densityPhases) {
      for (const el of [...this._densityPhases.keys()]) {
        finishHide(el);
        strip(el);
        this._densityCancel(el);
      }
    }
    if (typeof document !== 'undefined' && document.querySelectorAll) {
      document.querySelectorAll('[data-density-leaving]').forEach(finishHide);
      document.querySelectorAll('[data-density-entering]').forEach(strip);
    }
  }

  /**
   * Ladder reorder rev 3 Task 6: column top = round(commsBottom + 10). The
   * NavSphere reserved slot is gone (the orb is a footer chip). Keeps the
   * comms-resize settle and the maxHeight rewrite (viewport − top − footer).
   * Sets `top` before any un-hide (Task 9).
   *
   * Hotfix 2026-09-09 (owner: "tracked target is overlapping comms vertically"):
   * the density layer's SHOW path parks the comms pane at max-height 0 for one
   * frame (`data-density-entering`, stripped on the next rAF) and its HIDE path
   * collapses it over DENSITY_MOTION_MS (`data-density-leaving`). FloorMask
   * nulls the cache at the end of the floor apply — the same frame — so the
   * next update() measured the 0-height placeholder (bottom = the pane's TOP)
   * and cached it: the column sat 10 px under the comms top, over the comms
   * pane, until the next resize / 7-key step / rung flip. The intro ride now
   * runs on every New Game and its F1 → F2 pull-back shows comms through this
   * path, so that was every game. Rule: a mid-phase box is never cached —
   * entering keeps last frame's top (skip), leaving is followed frame by frame
   * and cached only once it lands (hidden → display:none → bottom 0 → the
   * column takes the comms slot, as before).
   * @private
   */
  _syncRightColumnTop() {
    if (!this._rightColumn || !this.panels.comms) return;
    const comms = this.panels.comms;
    const inPhase = (a) => !!(comms.hasAttribute && comms.hasAttribute(a));
    if (inPhase('data-density-entering')) {
      this._commsRectBottom = null;   // a 0-height placeholder — measure next frame
      return;
    }
    const leaving = inPhase('data-density-leaving');
    if (this._commsResizeSettleAt != null) {
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (now < this._commsResizeSettleAt) this._commsRectBottom = null;
      else this._commsResizeSettleAt = null;
    }
    if (this._commsRectBottom == null || leaving) {
      this._commsRectBottom = comms.getBoundingClientRect().bottom;
    }
    const newTop = Math.round(this._commsRectBottom + 10);
    if (leaving) this._commsRectBottom = null;   // mid-glide — never cache it
    // u4-phone-fold D3: on a SHORT screen (innerHeight < 500) the 189 px rail clearance would leave the column
    // 56 px tall on a 390 px phone (every Targets row clipped); the column keeps the non-ladder 30 px instead.
    const clear = shortScreenNow(typeof window !== 'undefined' ? window : null) ? 30 : (this._rightColBottomClearPx ?? 30);
    if (this._lastRightColTop !== newTop || this._lastRightColClear !== clear) {
      this._rightColumn.style.top = newTop + 'px';
      this._rightColumn.style.maxHeight = dividedByScale(`calc(100vh - ${newTop + clear}px)`);   // u9-big-text: layout box = screen room / scale
      this._lastRightColTop = newTop;
      this._lastRightColClear = clear;
    }
  }

  /** u7 D5b: once a frame (main.js) - the step chip clears the Targets pane when they would overlap. */
  syncHintPlacement() {
    if (this.hintTicker && typeof this.hintTicker.syncPlacement === 'function') this.hintTicker.syncPlacement();
  }

  /**
   * u7 D2: the right column's top (px) as last written by _syncRightColumnTop (comms bottom + 10), or
   * null before the first write. While the column is hidden the cached comms bottom + 10 (null if none yet).
   * A cached number: no layout read.
   * @returns {number|null}
   */
  rightColumnTopPx() {
    const col = this._rightColumn;
    if (!col) return null;
    if (col.style && col.style.display === 'none') {
      // Hidden by a view setting (showRight false): the comms bottom is still where the disc belongs - a cached number.
      return Number.isFinite(this._commsRectBottom) ? Math.round(this._commsRectBottom + 10) : null;
    }
    return Number.isFinite(this._lastRightColTop) ? this._lastRightColTop : null;
  }

  /** Set `top` then un-hide the right column (Task 9: top BEFORE un-hiding). */
  _showRightColumn() {
    if (!this._rightColumn) return;
    this._syncRightColumnTop();
    this._rightColumn.style.display = 'flex';
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
    // Score-group activates via HUD_GROUP_ACTIVATE (2 s settle-aligned timer in GameFlowManager)
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
    if (this._rightColumn) this._showRightColumn();
    if (this.statusPanel && this.statusPanel.leftColumn) {
      this.statusPanel.leftColumn.style.display = 'flex';
    }
    if (this.panels.comms) this.panels.comms.style.display = '';
  }

  /** @private */
  _setupEventListeners() {
    // Net-ceremony cinema mode: toggle `body.net-cinema` (no HUD ghosting since
    // 2026-10-05, no letterbox bars since 2026-09-09) while the ceremony
    // camera owns the screen. ENTERED/EXITED are strictly paired by
    // CameraSystem (every exit route — beats done, miss truncation, skip,
    // abort-on-view-change — emits EXITED), and GAME_RESET clears the class
    // as a belt-and-braces recovery.
    eventBus.on(Events.NET_CINEMATIC_ENTERED, () => {
      document.body.classList.add('net-cinema');
    });
    eventBus.on(Events.NET_CINEMATIC_EXITED, () => {
      document.body.classList.remove('net-cinema');
    });
    eventBus.on(Events.GAME_RESET, () => {
      document.body.classList.remove('net-cinema');
    });
    // TARGETS + TARGET INFO appear after the first scan and then stay for the
    // rest of the boot: GAME_RESET and floor changes never re-arm the gate.
    eventBus.on(Events.SCAN_COMPLETE, () => this._openScanGate());
    // h4-simple-first D7: in simple mode (mission 1, F1/F2) TARGET INFO waits for the player's
    // own Z (analyse) after the scan; a new game starts that wait again.
    eventBus.on(Events.GAME_RESET, () => { this._infoAnalysed = false; this._infoPulled = false; this._syncInfoGate(); });
    // h4b D5: the battery median forgets the last game; its 30-sample warm-up starts again.
    eventBus.on(Events.GAME_RESET, () => { if (this.vitalsPane && typeof this.vitalsPane.resetMedian === 'function') this.vitalsPane.resetMedian(); });
    // h4-simple-first D9: the floor rail ("1 UPGRADE … 5 GEO", "1×") stays out of mission 1's first
    // frames, until the first scan — or until the player changes level themselves (the intro ride
    // has no CAMERA_ZOOM_INPUT: this event is the player's own).
    if (Events.CAMERA_ZOOM_INPUT) eventBus.on(Events.CAMERA_ZOOM_INPUT, () => { this._railFree = true; this._syncRailQuiet(true); });
    // h4b D2: analyse is the game's own Z path (InputManager KeyZ → noteAnalyse) and a tap on the
    // selected target row (TargetPanel → onAnalyse); no raw document keydown listener.

    // SCORE_UPDATE is emitted before gameState.clearDebris() increments the count, so the cache
    // below stays one behind a catch; DEBRIS_CLEARED carries the new count.
    eventBus.on(Events.DEBRIS_CLEARED, (d) => { if (d && Number.isFinite(d.count)) this._debrisCleared = d.count; });

    eventBus.on(Events.SCORE_UPDATE, (data) => {
      this._score = data.total;
      this._credits = data.credits != null ? data.credits : this._credits;
      if (data && Number.isFinite(data.debrisCleared)) this._debrisCleared = data.debrisCleared;
      this._totalMassKg = data.totalMassKg || this._totalMassKg || 0;
      // Phase 3 (onboarding gating): keep the mission number current from the
      // debris count too. MISSION_START is the authoritative profile source but
      // is NOT emitted on a bare continue, and the direct-points SCORE_UPDATE
      // path (scan rewards / mission events) fires WITHOUT a MISSION_START — so
      // this keeps the collision-warning gate correct on continued games as soon
      // as any score event arrives. Mirrors CollisionAvoidanceSystem.
      if (typeof data.debrisCleared === 'number') {
        const per = Constants.MISSIONS?.DEBRIS_PER_MISSION || 5;
        this._missionNumber = Math.floor(data.debrisCleared / per) + 1;
      }
      // Phase 2 (capture feedback): the delivery moment is confirmed by the
      // payoff line under the score strip + the top-strip CLEARED counter +
      // comms. The old center-screen capture-notif pop was redundant — removed.
      // S1 retention: advance the pinned-upgrade progress on every credit change.
      this._updatePinWidget();
    });

    // S1 retention: pinned next-upgrade widget lifecycle.
    eventBus.on(Events.UPGRADE_PINNED, (data) => {
      if (data && data.id) {
        this._pinned = { id: data.id, name: data.name, cost: data.cost };
        this._pinReadyFired = false; // reset one-shot READY comms for the new pin
        if (data.credits != null) this._credits = data.credits;
      } else {
        this._pinned = null;
      }
      this._updatePinWidget();
    });
    eventBus.on(Events.UPGRADE_PURCHASED, (data) => {
      // Clear the pin display when the pinned item is purchased; ShopScreen
      // re-broadcasts a fresh pin on the next shop close.
      if (data && this._pinned && data.id === this._pinned.id) {
        this._pinned = null;
        this._updatePinWidget();
      }
    });

    eventBus.on(Events.COLLISION_WARNING, (data) => {
      // D2 (ROADMAP §4 P2): debris proximity warning from CollisionAvoidanceSystem.
      // Phase 3 gate: suppressed in mission 1 (onboarding). Steady-display
      // collision warnings begin at mission 2 (profile.collisionWarnings).
      if (!this._collisionWarningsEnabled()) return;
      const closing = (data.closingSpeedMs != null) ? `, closing ${Math.round(data.closingSpeedMs)} m/s` : '';
      this.showWarning(`⚠ Debris ${data.debrisId} — ${Math.round(data.distanceM)} m${closing}`, 'critical');
    });

    eventBus.on(Events.COLLISION_EVASION, (data) => {
      // D2: CA autopilot performed an avoidance burn. Phase 1 #3: not actionable
      // (the ship already dodged) → quiet bottom toast, not the critical strip.
      // Phase 3 gate: suppressed in mission 1 (onboarding).
      if (!this._collisionWarningsEnabled()) return;
      const dir = data.direction ? ` (${data.direction})` : '';
      this.showNotification(`⚡ Auto-evasion — Debris ${data.debrisId} at ${Math.round(data.distanceM)} m${dir}`, undefined, { kind: 'notice' });
    });

    eventBus.on(Events.INTERACTION_DATA_CAPTURE, (data) => {
      this.showNotification(`✓ Data captured! +${data.points} pts`, undefined, { kind: 'confirm' });
    });

    eventBus.on(Events.INTERACTION_DEORBIT, (data) => {
      this.showNotification(`✓ Target deorbited! +${data.points} pts`, undefined, { kind: 'confirm' });
    });

    eventBus.on(Events.INTERACTION_CAPTURE, (data) => {
      this.showNotification(`✓ Target captured! +${data.points} pts`, undefined, { kind: 'confirm' });
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
    // Item 100: the speed dial → arms-panel header readout
    eventBus.on(Events.LAUNCH_SPEED_CHANGED, () => this.statusPanel.renderArmPanel());
    eventBus.on(Events.ARM_CAPTURED, (data) => {
      this.statusPanel.renderArmPanel();
      // Phase 2 (capture feedback): one confirmation per moment. The catch is
      // already reflected by the arm pane + comms + status lights, so the catch
      // moment gets a single quiet bottom toast (no center-screen float).
      const armLabel = (data.type || 'arm').charAt(0).toUpperCase() + (data.type || 'arm').slice(1);
      const debrisLabel = data.debrisType || 'debris';
      const massKg = data.mass || 0;
      const massText = massKg > 0 ? ` (+${massKg.toLocaleString()} kg)` : '';
      this.showNotification(`${armLabel} — ${debrisLabel} secured${massText}`, undefined, { kind: 'confirm' });
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
      // comms-after-tutorial D6b: a line CommsSystem drops (suppression tier or `_quiet`) must not
      // redraw the panel or reset the PageUp scroll - hidden lines are invisible everywhere.
      const cs = this._commsSystem;
      if (cs && typeof cs.wouldShow === 'function' && !cs.wouldShow(msg)) return;
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

    // --- Synergy bonus (Phase 5 Rewards) ---
    // Phase 2 (capture feedback): downgraded from a center-screen cyan float to
    // the quiet bottom toast; RewardSystem already narrates the synergy in comms.
    eventBus.on(Events.SYNERGY_BONUS, (data) => {
      this.showNotification(`⚡ +${data.points} ${data.name} — SYNERGY BONUS`, undefined, { kind: 'notice' });
    });

    // Owner 2026-10-21: no mastery popup or fanfare in the sim (the skills pane still flashes the row).

    // m1-finish: the end of a mission is a headline that fades by itself (no card,
    // no hold: DECISIONS §14 — the depot is an invitation, never a forced stop).
    eventBus.on(Events.MISSION_COMPLETE, (d) => this.showMissionComplete(d));

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
    eventBus.on(Events.SHOW_NOTIFICATION, ({ text, duration, kind }) => {
      this.showNotification(text, duration, { kind });
    });

    // AUDIO_UNLOCK_FAILED has no HUD listener (owner ruling 2026-10-05: the
    // game always has sound — no audio-blocked toast; InputManager retries
    // the unlock on every gesture).

    // u3-payoff-calm D2: the salvage card is gone. The payoff line under the score strip
    // (StatusPanel) carries the catch; SALVAGE_REVEAL stays for the sound and the
    // above-simple materials line.

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
    // Session O (D16 (b)): the score-strip rect cache rides the same invalidate edge.
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', () => {
        this._commsRectBottom = null;
        this._scoreStripRect = null;
      });
    }

    // u9-big-text: a HUD scale change (a resize across the 1280 x 880 line) moves every scaled rect: the cached comms
    // bottom, the score-strip band and the right column's top / maxHeight (written divided by the scale) are all stale,
    // so they ride the same invalidate edge as a resize (the next update() re-measures after the new layout).
    this._unsubHudScale = onHudScaleChange(() => {
      this._commsRectBottom = null;
      this._scoreStripRect = null;
      this._lastRightColTop = null;
      this._lastRightColClear = null;
      if (this._notificationZone) {
        this._notificationZone.style.bottom = `${toastBottomPx(!!(Constants.LADDER && Constants.LADDER.ENABLED)) + toastLiftPx()}px`;
      }
    });

    // Comms panel stepped to a new size (line/normal/large). Its bottom edge
    // moves, so the NavSphere slot + right-hand pane column must follow. The
    // panel height animates over ~0.3s, so keep recomputing the cached bottom
    // each frame until the transition settles (see update()).
    // Session O (plan D16 (a), owner 2026-09-07): a comms VISIBILITY toggle (a
    // pane-density rung flip / FloorMask floor apply) moves the pane's bottom edge
    // — but arrives with NO COMMS_PANEL_RESIZED (the cache was measured against a
    // hidden pane: bottom 0 → the right column's top ≈ 12 px → COMMS/TARGETS
    // overlap on the iPad, the owner's screenshot). Null the cached rect on the comms
    // visibility edge so the next frame recomputes (order-independent vs any other
    // consumer — a nulled cache is recomputed lazily). No new Events (D14): the
    // ONE existing visibility event is reused — HUD is its SECOND listener file
    // beside main.js's DISPLAY-rail sink (test-events-graph pins both).
    eventBus.on(Events.HUD_PANE_VISIBILITY, (data) => {
      if (data && data.pane === 'comms') this.invalidateCommsLayout();
      // Review (2026-09-07, W1): the score-strip rect cache (D16 (b)) rides the
      // same edge — a `-` walk that hides the score rung would otherwise leave
      // brackets skipping an EMPTY top band until the next resize (the strip's
      // density attribute flips display at once; the next read re-measures and
      // reads zero-area → null → no band).
      if (data && data.pane === 'score') this._scoreStripRect = null;
      // A pane the player just brought back with its own key (7/8/9/0) ends a muted-alerts
      // state: the alerts return with the first HUD pane. Show-only — see revealFollowers.
      if (data && data.shown === true && this._paneDensity) this._paneDensity.revealFollowers();
    });

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
    // S1 retention: clear the pinned-upgrade widget on a new game.
    eventBus.on(Events.GAME_RESET, () => {
      this._pinned = null;
      this._pinReadyFired = false;
      this._updatePinWidget();
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
        this._armPilotView = true;
        this._showArmPilotStrip();
      } else {
        this._armPilotView = false;
        this._hideArmPilotStrip();
        this._syncHoldingStrip();   // u17b: the view left pilot mode with a holding daughter selected: her strip, not none
      }
    });
    // u17b (owner 2026-10-22 bug): a selected daughter parked with a catch is not piloted, so the pilot strip never showed
    // for her and the bottom centre was blank or stale. Her own strip (true options only) follows the selection; the
    // per-frame refresh in update() follows her state (it leaves when she leaves HOLDING_CATCH).
    eventBus.on(Events.ARM_SELECT, () => this._syncHoldingStrip());
    eventBus.on(Events.ARM_DESELECT, () => this._syncHoldingStrip());

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

    // --- Phase 3 (onboarding gating): mission awareness -------------------
    // Store the mission number + profile so display-layer gates (e.g. collision
    // warnings) can consult the active difficulty profile. MISSION_START does
    // NOT fire for mission 1, so the constructor default (mission 1, suppressed)
    // stands until the first 1→2 transition.
    eventBus.on(Events.MISSION_START, (data) => {
      if (data && typeof data.missionNumber === 'number') {
        this._missionNumber = data.missionNumber;
      }
      this._missionProfile = (data && data.profile) || null;
    });

    // Keycap badges during the guided pipeline: while onboarding runs, a body
    // attribute suppresses the dormant-panel activate-key glyphs (CSS in the
    // injected HUD styles) so the teaching beats own attention. The veteran-skip
    // path fires COMPLETE without STARTED and so never sets the attribute.
    eventBus.on(Events.ONBOARDING_STARTED, () => {
      if (typeof document !== 'undefined') {
        document.body.setAttribute('data-onboarding-active', '');
      }
    });
    eventBus.on(Events.ONBOARDING_COMPLETE, () => {
      if (typeof document !== 'undefined') {
        document.body.removeAttribute('data-onboarding-active');
      }
    });

    // GAME_RESET: clear onboarding + mission state so a new game starts fresh
    // (back to mission-1 suppressed defaults).
    eventBus.on(Events.GAME_RESET, () => {
      if (typeof document !== 'undefined') {
        document.body.removeAttribute('data-onboarding-active');
      }
      this._missionNumber = 1;
      this._missionProfile = null;
      this.container.classList.remove('callouts-active'); // restore panes
      this._clearDensityPhases();
    });

    // Inspection pane-dim (round 5): while callouts are active on any band
    // (either inspection path), the `callouts-active` rule injected in _build
    // ghosts the HUD pane columns; a null band restores them. This is the whole
    // handler since 2026-09-09 — the depth breadcrumb + one-shot zoom hint that
    // used to fill it were retired (plan 1788954873769-one-workbench-pane §D8).
    // The class matters only under `?ladder=0`, where F1's HUD panes are
    // visible.
    eventBus.on(Events.CALLOUT_BAND_CHANGE, ({ band } = {}) => {
      if (!this.container) return;
      if (band == null) {
        this.container.classList.remove('callouts-active'); // restore panes
        return;
      }
      this.container.classList.add('callouts-active'); // ghost panes (round 5)
    });
  }

  /**
   * @private Phase 3: whether steady-display collision warnings are enabled for
   * the current mission. Suppressed during mission 1 (onboarding) and enabled
   * from mission 2 up via the profile flag `collisionWarnings`. Prefers the
   * authoritative profile from MISSION_START; when that hasn't arrived (e.g. a
   * continued game, before the next score event) it resolves the profile from
   * the tracked mission number so a mission-≥2 continue isn't wrongly muted.
   * @returns {boolean}
   */
  _collisionWarningsEnabled() {
    const profile = this._missionProfile || this._profileForMission(this._missionNumber);
    return !!(profile && profile.collisionWarnings);
  }

  /**
   * @private Resolve the mission difficulty profile for a mission number using
   * the highest-matching `minMission` rule (mirrors ScoringSystem._getMissionProfile).
   * Keeps `collisionWarnings` (and other flags) as the single source of truth so
   * the gate can never drift from Constants.MISSIONS.PROFILES.
   * @param {number} missionNumber
   * @returns {object|null}
   */
  _profileForMission(missionNumber) {
    const profiles = Constants.MISSIONS?.PROFILES;
    if (!Array.isArray(profiles) || profiles.length === 0) return null;
    let best = profiles[0];
    for (const p of profiles) {
      if (missionNumber >= p.minMission) best = p;
    }
    return best;
  }

  // ==========================================================================
  // PUBLIC API (unchanged from original)
  // ==========================================================================

  /**
   * Set the comms system reference.
   * @param {import('../systems/CommsSystem.js').CommsSystem} commsSystem
   */
  setCommsSystem(commsSystem) {
    this._commsSystem = commsSystem;
    this.commsPanel.setCommsSystem(commsSystem);
  }

  /**
   * Set the ArmManager reference for real-time status polling.
   * @param {import('../entities/ArmManager.js').ArmManager} armManager
   */
  setArmManager(armManager) {
    this._armManager = armManager;
    this._armsGateOpen = false;      // re-armed with each manager (every boot starts with the struts shut)
    this._armsGateOn(!!armManager);
    this._tickArmsGate();
    this.statusPanel.setArmManager(armManager);
    this.targetPanel.setArmManager(armManager);
    // (commsPanel.setArmManager removed — dead store after RadialMenu deletion)
    if (this.netInventoryPanel) this.netInventoryPanel.setArmManager(armManager);
  }

  /**
   * The DAUGHTERS pane waits for the struts (owner 2026-10-12): `#hud-arms-panel`
   * carries `data-arms-wait` (a `display:none !important` rule, so it beats the
   * forced `display=''`, the floor mask and the density ladder alike) until the
   * struts first open — or any daughter leaves the dock — then the gate latches
   * open for the rest of the boot. It only ever hides: the floor mask still
   * decides gone / shown / faint on top. Polled from the 10 Hz block of update();
   * does nothing without an arm manager (menu, test rigs).
   * @private
   */
  _tickArmsGate() {
    const am = this._armManager;
    if (!am || this._armsGateOpen) return;
    let open = false;
    try {
      open = (typeof am.strutsDeployed === 'function' && am.strutsDeployed() === true)
        || (Array.isArray(am.arms) && am.arms.some((a) => a && a.state !== Constants.ARM_STATES.DOCKED));
    } catch (_e) { open = false; }
    if (!open) return;
    this._armsGateOpen = true;
    this._armsGateOn(false);
  }

  /**
   * The TARGETS and TARGET INFO panes wait for the first scan (owner
   * 2026-10-13: "Tracked targets pane and target dossier pane should be visible
   * after scan"): both carry `data-scan-wait` (a `display:none !important`
   * rule, like the DAUGHTERS gate) from the HUD's construction until the first
   * `SCAN_COMPLETE` of the boot (SensorSystem._completeScan — every scan type
   * ends there), then the gate latches open. Nothing is saved: a new boot
   * starts shut. It only ever hides — the floor mask still decides which floor
   * shows them (F2 only).
   * @private
   */
  _openScanGate() {
    if (this._scanGateOpen) return;
    this._scanGateOpen = true;
    this._scanGateOn(false);
    this._syncRailQuiet(true);
  }

  /** @private Set / clear the wait attribute on the two scan-gated panes. */
  _scanGateOn(on) {
    const targets = this.panels && this.panels.targets;
    if (targets && targets.setAttribute) {
      if (on) targets.setAttribute('data-scan-wait', '');
      else if (targets.removeAttribute) targets.removeAttribute('data-scan-wait');
    }
    if (on) {
      const el = this._wireframeContainerEl;
      if (el && el.setAttribute) el.setAttribute('data-scan-wait', '');
      this._infoGateWait = '';
    } else {
      this._infoGateWait = null;      // re-decide below, whatever was written before
      this._syncInfoGate();
    }
  }

  /**
   * h4-simple-first D5: the pane level the FloorMask last applied is the HUD's to read — the
   * mask hands itself over in its constructor (a test stub HUD simply has no such method).
   * @param {{getCurrentFloor: function}} mask
   */
  attachFloorMask(mask) { this._floorMask = mask || null; }

  /**
   * h4b D1: true in mission 1 while no pane the room hides by default has been pulled in (one `+`
   * past the room, FloorMask.extraPaneShown): the targets list and the target info stay simple.
   * One answer for TargetPanel and the target-info gate.
   * @returns {boolean}
   */
  isSimpleTargets() {
    let extra = false;
    try { extra = this._floorMask && typeof this._floorMask.extraPaneShown === 'function' ? !!this._floorMask.extraPaneShown() : false; } catch (_e) { extra = false; }
    return isSimpleTargets(undefined, extra);
  }

  /**
   * @private h4-simple-first D9: hold the floor rail back in mission 1 until the first scan (or the
   * player's own level change). It rides the shared `data-scan-wait` hide rule. The rail builds
   * itself on its first show, so the element is looked up until it exists; the want-state is
   * recomputed at 10 Hz (`recompute`) and re-applied to the element in between.
   * @param {boolean} [recompute]
   */
  _syncRailQuiet(recompute = false) {
    if (recompute) {
      this._railQuiet = !this._railFree && !this._scanGateOpen && currentMissionNumber() === 1;
    }
    if (typeof document === 'undefined' || !document || typeof document.getElementById !== 'function') return;
    if (!this._railEl || this._railEl.isConnected === false) this._railEl = document.getElementById('ladder-rail');
    const el = this._railEl;
    if (!el || typeof el.setAttribute !== 'function') return;
    const has = typeof el.hasAttribute === 'function' && el.hasAttribute('data-scan-wait');
    if (this._railQuiet && !has) el.setAttribute('data-scan-wait', '');
    else if (!this._railQuiet && has && typeof el.removeAttribute === 'function') el.removeAttribute('data-scan-wait');
  }

  /**
   * h4-simple-first D7: the player pressed Z (analyse). After the first scan this opens TARGET INFO
   * for good (until a new game) — before the scan nothing can be analysed, so it is ignored.
   */
  noteAnalyse() {
    if (!this._scanGateOpen || this._infoAnalysed) return;
    this._infoAnalysed = true;
    this._syncInfoGate();
  }

  /**
   * @private The TARGET INFO pane waits for the first scan and — in simple mode — for the player's
   * Z; not simple (mission 2+, F3 and up) = today's behaviour (open right after the scan).
   * Write-on-change; polled from the 10 Hz block too, so a floor or mission change lands.
   */
  _syncInfoGate() {
    // u5 D1: the target info draws its two-line simple form on the same gate as the Targets list.
    if (this.debrisWireframe && typeof this.debrisWireframe.setSimple === 'function') this.debrisWireframe.setSimple(this.isSimpleTargets());
    const el = this._wireframeContainerEl;
    if (!el || !el.setAttribute) return;
    // The value says why it waits: '' = the first scan, 'analyse' = the player's Z (DebrisWireframe's 9-key line reads it).
    // Pulled in (one `+` past the room) opens the pane for good, like Z: hiding the extra pane again
    // (the `-` step before this one) must not take target info away from under its own step.
    if (this._scanGateOpen && !this.isSimpleTargets()) this._infoPulled = true;
    const wait = !this._scanGateOpen ? '' : (!this._infoAnalysed && !this._infoPulled && this.isSimpleTargets()) ? 'analyse' : false;
    if (wait === this._infoGateWait) return;
    this._infoGateWait = wait;
    if (wait !== false) el.setAttribute('data-scan-wait', wait);
    else if (el.removeAttribute) el.removeAttribute('data-scan-wait');
  }

  /** @private Set / clear the wait attribute on the DAUGHTERS pane. */
  _armsGateOn(on) {
    const el = this.panels && this.panels.arms;
    if (!el || !el.setAttribute) return;
    if (on) el.setAttribute('data-arms-wait', '');
    else if (el.removeAttribute) el.removeAttribute('data-arms-wait');
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
   * Set the Starfield reference so the pane-density ladder's pure-scenery rung
   * can also drop the constellation name labels (a THREE world annotation with
   * no DOM). Wired from main.js after Starfield construction.
   * @param {import('../scene/Starfield.js').Starfield} starfield
   */
  setStarfield(starfield) {
    this._starfield = starfield;
  }

  /**
   * Set the CityLabels reference so the pane-density `citypills` world rung
   * can drive CityLabels' own density flag (not the DOM — F1/F5 suppression
   * already hides the pills). Wired from main.js right after HUD construction.
   * Parallel agent owns setDensityHidden / isDensityHidden (guarded).
   * @param {object} cityLabels
   */
  setCityLabels(cityLabels) {
    this._cityLabels = cityLabels;
  }

  /**
   * The floor's answer to "can target marks show here?" for the `targetmarks` step: false on the
   * route and chart floors, where the ladder keeps the aiming reticles off. Wired from main.js at
   * the ladder gate (`!ladderController.reticlesSuppressed()`); absent = open.
   * @param {(() => boolean)|null} fn
   */
  setTargetMarksFloorGate(fn) {
    this._targetMarksFloorGate = typeof fn === 'function' ? fn : null;
  }

  /**
   * Set the SunLight reference so the pane-density "sky labels" rung can also
   * drop the Sun / Moon / planet NAME labels alongside the constellation names
   * (the discs stay — they are scenery). Wired from main.js.
   * @param {import('../scene/SunLight.js').SunLight} sunLight
   */
  setSunLight(sunLight) {
    this._sunLight = sunLight;
  }

  /**
   * Set the mother-craft (PlayerSatellite, a THREE.Group) reference so the
   * pane-density pure-scenery rung can hide the ship itself for an empty-orbit
   * view. Wired from main.js after PlayerSatellite construction.
   * @param {import('three').Object3D} craft
   */
  setMotherCraft(craft) {
    this._motherCraft = craft;
  }

  /**
   * F17: Set the CodexSystem reference for unseen entry badge.
   * Also feeds the pane-help tooltips (data-help → entry shortText).
   * @param {import('../systems/CodexSystem.js').CodexSystem} codexSystem
   */
  setCodexSystem(codexSystem) {
    this._codexSystem = codexSystem;
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
    // Session Q (plan D12): while engaged the strip is the arbiter's level 2 / 3
    // sink — `critical` = alert-red (L3), anything else = alert-amber (L2);
    // the same 3 s the queue gave. Null policy: the shipped queue, byte for byte.
    if (this._toastPolicy === 'engaged' && this._alerts) {
      const now = this._alertClock();
      const kind = STRIP_KIND[severity] || 'alert-amber';
      if (this._alerts.offer({ kind, text: message, durationMs: 3000 }, now) === 'show') this._syncAlertSinks(now);
      return;
    }
    this._warningQueue.push({ message, severity, timer: 3.0 });
  }

  /**
   * Session O (plan D16 (a), owner 2026-09-07): null the cached comms-panel
   * bottom so the next update() frame recomputes it. Harmless if called often:the
   * cache is just a number; a nulled cache costs one getBoundingClientRect on the
   * next frame. Public — FloorMask calls it at the end of every floor apply (the
   * room apply drives each rung's setVisible directly, no event arrives) and this
   * class calls it on the HUD_PANE_VISIBILITY comms edge (a rung flip — the
   * pane-density layer's ONE visibility event).
   */
  invalidateCommsLayout() {
    this._commsRectBottom = null;
  }

  /**
   * Session Q (plan D15 / D12c): the ready TETHER reach, km, as the TARGETS
   * panel computes it every 2 Hz tick (TargetColorLaw.reachKmFrom over
   * ArmManager.getAllStatus(): DOCKED + fuel > 5, weaver 2 km over spinner
   * 0.5 km; 0 = no arm ready). The hub feeds it to the reticle's law so the
   * bracket and the row agree on "in reach".
   * @returns {number}
   */
  reachKm() {
    return (this.targetPanel && typeof this.targetPanel.reachKm === 'function') ? this.targetPanel.reachKm() : 0;
  }

  /**
   * Session O (plan D16 (b), owner 2026-09-07): the score strip's on-screen rect
   * — the exclusion band TargetReticle keeps its debris brackets out of (the strip's
   * opaque panel sat over a bracket's distance label at the top — chrome-over-chrome).
   * Cached on window resize (invalidate beside the comms-rect cache) and lazily
   * computed on the first read — the ONE reused object (zero per-frame allocation;
   * main.js reads it once a frame). Null when the panel is missing or hidden
   * (a hidden HUD/strip reads a zero-area rect at the page origin, which would
   * otherwise look like a real band at the top-left corner — so zero-area → null).
   * main.js passes this to targetReticle.update(dt,{ … exclusionRect }) only while
   * the ladder is on (flag-off passes null → byte-identical shipped path).
   * @returns {{left:number, top:number, right:number, bottom:number}|null}
   */
  scoreStripRect() {
    // Cached: return the measured object untouched (zero per-frame work — the
    // resize handler nulls the cache to force ONE re-measure).
    if (this._scoreStripRect != null) return this._scoreStripRect;
    const el = (typeof document !== 'undefined') ? document.getElementById('hud-score-panel') : null;
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    const r = el.getBoundingClientRect();
    if (!r) return null;
    const left = r.left || 0, top = r.top || 0, right = r.right || 0, bottom = r.bottom || 0;
    // Hidden: display:none → a zero-area rect (falling back to 0 for the
    // undefined edges a fake/stub rect may omit). A strip with no area reserves
    // nothing and is never a real band. (Cache stays null: a later reveal of the
    // panel re-measures on that frame — hidden edges are rare, so no per-frame cost.
    if (!(right > left) || !(bottom > top)) return null;
    this._scoreStripRect = { left, top, right, bottom };
    return this._scoreStripRect;
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
    if (this._railQuiet) this._syncRailQuiet();   // h4-simple-first D9: the rail builds itself on its first show

    // UX-2 #11: Dynamically position right column below comms + NavSphere.
    // Sprint 2 / PR E — `getBoundingClientRect()` forces a sync layout each
    // frame because StatusPanel mutates textContent on the same frame; we now
    // cache the comms-panel bottom and invalidate only on resize / view-config
    // change (see _setupEventListeners). Saves ~0.2–0.5 ms/frame on dense missions.
    if (this._rightColumn && this.panels.comms) this._syncRightColumnTop();

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
    // Session Q (plan D12b): the MEMO slot's box window — write-on-change on
    // its local timestamp (no timer); a no-op without the slot.
    if (typeof this.statusPanel.tickMemo === 'function') this.statusPanel.tickMemo();

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

      // Attitude: live body angular rate (deg/s) for the rigid-body dynamics
      // readout. getAngularRate exists on the real player; guard for headless
      // mocks that don't implement it.
      const angularRate = (typeof player.getAngularRate === 'function')
        ? player.getAngularRate() : null;

      this.statusPanel.update({
        score: this._score,
        credits: this._credits,
        debrisCleared: this._debrisCleared,
        resources: this._resources,
        cachedTargets: this._cachedTargets,
        cargoStatus: data.cargoStatus,
        totalMassKg: this._totalMassKg || 0,
        thrusterInterlocked: player.thrusterInterlocked || false,
        comDriftM,
        comSuggestedStowArm,
        plumeBlocks,
        angularRate,
        simple: this.isSimpleTargets(),   // z1-calm-scan D5: DAUGHTERS hides LAUNCH and ΔV on the simple level
      });
      // W2 meters: the four vitals rows (self-throttled to 10 Hz, write-on-change).
      if (this.vitalsPane) this.vitalsPane.update(player);
      this._tickArmsGate();      // DAUGHTERS pane waits for the struts
      this._syncInfoGate();      // TARGET INFO: simple-first follows the floor and the mission
      this._syncRailQuiet(true); // floor rail: not on mission 1's first frames
      this._pollAlerts();        // alerts & indicators return with any HUD pane (no event covers the 7 key etc.)

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
          targetLaw: data.targetLaw || null,   // Session Q (plan D15): the hub's law inputs (null off the ladder)
          simple: this.isSimpleTargets(),      // h4-simple-first D6: name, distance, in reach only
          analyseChip: this.isSimpleTargets() && !this._infoAnalysed && !this._infoPulled,   // h4b D3: the one "analyse" prompt
        });

        // Session Q (plan D12c): the LIVE-APPROACH inhibit window rides this
        // tick — no new physics read: the selected row's distanceKm against the
        // panel's tether reach × APPROACH_FACTOR (TargetColorLaw.approachLive).
        // Engaged only (the null policy never inhibits anything).
        if (this._toastPolicy === 'engaged' && this._alerts) {
          const selId = this.targetPanel.selectedTargetId;
          const sel = (selId != null && Array.isArray(this._cachedTargets)) ? this._cachedTargets.find((t) => t.id === selId) : null;
          this._approachLive = !!sel && approachLive({ distanceKm: sel.distanceKm, reachKm: this.targetPanel.reachKm() });
        } else {
          this._approachLive = false;
        }
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

    // Session Q (plan D12 / D12c): the alert hierarchy's frame — the inhibit
    // state (intro OR live approach), ONE promotion, the two sinks mirrored
    // write-on-change. Only while engaged; the shipped queue below is inert then.
    this._tickAlerts();

    // Warning display
    this._updateWarnings(dt);

    this._tickArmStrips(cameraSystem);

    // Comms flash timer
    this.commsPanel.update(dt);
  }

  /**
   * @private The per-frame work of the bottom-centre strip (called from update()). u17b: the selected holding daughter's strip
   * comes and goes with her state; the pilot strip's context refresh (ARM PILOT / STATION KEEP) runs only while the camera
   * really is in pilot view (`_armPilotView`), so it can never write pilot text into a holding strip that is fading out.
   * @param {object} [cameraSystem]
   */
  _tickArmStrips(cameraSystem) {
    this._syncHoldingStrip();
    if (this._armPilotView && !this._holdingStripOn && this._armPilotStrip && this._armPilotStrip.style.display !== 'none') {
      this._updateArmPilotStripContent(cameraSystem?.getPilotedArm());
    }
  }

  // ==========================================================================
  // WARNINGS
  // ==========================================================================

  /** @private Update warning display */
  _updateWarnings(dt) {
    // Session Q (plan D12): the arbiter drives the strip while engaged.
    if (this._toastPolicy === 'engaged' && this._alerts) return;
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
        textEl.style.color = 'var(--hud-warning, #ff4444)';
        this.panels.warnings.style.borderColor = 'rgb(var(--hud-warning-rgb, 255 68 68) / 0.5)';
        // Phase 1 #1: severity reads as steady colour (red text/border), not a
        // sub-second opacity strobe. The old Math.sin(Date.now()) toggle blinked
        // for the entire time a long-lived critical warning was queued.
        textEl.style.opacity = '1';
      } else {
        // 'warning' (default) — steady amber. The former 'success' severity was
        // retired (success feedback now routes to the quiet bottom toast).
        textEl.style.color = 'var(--hud-caution, #ffaa00)';
        textEl.style.opacity = '1';
        this.panels.warnings.style.borderColor = 'rgb(var(--hud-caution-rgb, 255 170 0) / 0.3)';
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
    // Show right column (wireframe + target list) — top before un-hide.
    this._showRightColumn();
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
    this._clearDensityPhases();
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
      if (showRight) this._showRightColumn();
      else this._rightColumn.style.display = 'none';
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
  // DETACH / TETHER FEEDBACK
  // ==========================================================================

  /**
   * Show a floating "TETHER CUT" text on detach.
   * Phase 6: Risk-Reward detach dramatic feedback.
   * Phase 1 #11: the full-screen radial flash was removed — floating text +
   * comms + audio carry the event.
   */
  showDetachFlash() {
    // Floating "TETHER CUT" text
    const text = document.createElement('div');
    text.className = 'hud-alert-float';
    text.style.cssText = `
      position: fixed; top: 40%; left: 50%;
      transform: translate(-50%, -50%);
      color: var(--hud-warning, #ff4444); font-family: var(--font-mono);
      font-size: 28px; font-weight: bold; letter-spacing: 4px;
      text-shadow: 0 0 20px rgb(var(--hud-warning-rgb, 255 50 50) / 0.8), 0 0 40px rgb(var(--hud-warning-rgb, 255 0 0) / 0.4);
      pointer-events: none; z-index: 101;
      animation: detachTextFloat 1.2s ease-out forwards;
    `;
    text.textContent = 'TETHER CUT';
    document.body.appendChild(text);
    timerManager.setTimeout(() => text.remove(), 1300, { owner: this });
  }

  // ==========================================================================
  // TOAST POLICY (Session O — plan D12:the alert-hierarchy drop table)
  // ==========================================================================

  /**
   * Set the toast policy. 'engaged' arms the ONE drop table
   * (TOAST_DROP_WHILE_ENGAGED): confirmations / notices / views / inspect /
   * memo die — even under `force:true` — while `prompt` + untagged + the
   * alert kinds survive (the pure-scenery reminder is `prompt` + `force` and
   * must show). null = shipped behavior (every kind shows, byte-identical to
   * today for every kind; flag-off never calls this).
   *
   * Called per frame from the hub's ladder block — write-on-change, so
   * repeated calls with the same mode are free.
   *
   * @param {'engaged'|null} mode
   */
  setToastPolicy(mode) {
    const next = (mode === 'engaged') ? 'engaged' : null;
    if (next === this._toastPolicy) return;
    this._toastPolicy = next;
    // Session Q (plan D12): the arbiter owns both sinks while engaged. On the
    // way IN a pending shipped toast timer and the shipped strip queue are
    // dropped (the sinks start clean — the engage is the intro dive, which
    // inhibits everything below red anyway); on the way OUT the arbiter is
    // cleared and whatever it painted is hidden, so the shipped mechanisms
    // resume on empty sinks. Duck-typed: a HUD without the arbiter is Session O.
    if (!this._alerts) return;
    if (next === 'engaged') {
      if (this._notifTimer) { timerManager.clear(this._notifTimer); this._notifTimer = null; }
      if (this._notificationZone) this._notificationZone.style.opacity = '0';
      if (Array.isArray(this._warningQueue)) this._warningQueue.length = 0;
      if (this.panels && this.panels.warnings) this.panels.warnings.style.display = 'none';
      this._alertZoneText = null;
      this._alertStrip = null;
    } else {
      this._alerts.clear();
      this._approachLive = false;
      if (this._alertZoneText !== null && this._notificationZone) this._notificationZone.style.opacity = '0';
      if (this._alertStrip !== null && this.panels && this.panels.warnings) this.panels.warnings.style.display = 'none';
      this._alertZoneText = null;
      this._alertStrip = null;
    }
  }

  /**
   * The current toast policy (default null = today's behavior).
   * @returns {'engaged'|null}
   */
  toastPolicy() { return this._toastPolicy; }

  /**
   * Session Q (plan D12c): the hub's inhibit input — the intro flyby
   * (`LadderController.introInFlight()`), written per frame write-on-change.
   * OR-ed with the live-approach poll into the arbiter every update.
   * @param {boolean} on
   */
  setToastInhibit(on) {
    const next = !!on;
    if (next === this._introInhibit) return;
    this._introInhibit = next;
  }

  /**
   * Session Q: the alert hierarchy's state for tests and the `?shot` probe.
   * @returns {{policy:('engaged'|null), inhibited:boolean, intro:boolean, approach:boolean, visible:(object|null), held:Array}}
   */
  alertState() {
    const now = this._alertClock();
    return {
      policy: this._toastPolicy,
      inhibited: !!(this._alerts && this._alerts.inhibited()),
      intro: !!this._introInhibit,
      approach: !!this._approachLive,
      visible: this._alerts ? this._alerts.visible(now) : null,
      held: this._alerts ? this._alerts.held() : [],
    };
  }

  /**
   * @private Session Q (plan D12 / D12c): the alert hierarchy's per-frame step —
   * the inhibit state (intro OR live approach), ONE promotion, the two sinks
   * mirrored write-on-change. Only while engaged (duck-typed on the arbiter).
   * @param {number} [nowMs] the clock (tests); default the seam / performance.now()
   */
  _tickAlerts(nowMs) {
    if (this._toastPolicy !== 'engaged' || !this._alerts) return;
    const now = (typeof nowMs === 'number' && Number.isFinite(nowMs)) ? nowMs : this._alertClock();
    this._alerts.setInhibited(!!(this._introInhibit || this._approachLive));
    this._alerts.next(now);
    this._syncAlertSinks(now);
  }

  /** @private The arbiter's clock: the optional seam, else performance.now(). */
  _alertClock() {
    if (typeof this._alertNow === 'function') return this._alertNow();
    return (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
  }

  /**
   * @private Session Q (plan D12): mirror the arbiter's visible item into the two
   * sinks — the zone for level 1, the strip for levels 2–3 — write-on-change.
   * The strip's colours on this path are the law's THREAT / CAUTION.
   */
  _syncAlertSinks(now) {
    const v = this._alerts.visible(now);
    const zoneText = (v && v.level === 1) ? v.text : null;
    if (zoneText !== this._alertZoneText) {
      this._alertZoneText = zoneText;
      const z = this._notificationZone;
      if (z) {
        if (zoneText !== null) { z.textContent = zoneText; z.style.textTransform = _toastCase(zoneText); z.style.opacity = '1'; }
        else z.style.opacity = '0';
      }
    }
    const stripKind = (v && v.level >= 2) ? v.kind : null;
    const cur = this._alertStrip;
    const curKind = cur ? cur.kind : null;
    const curText = cur ? cur.text : null;
    if (stripKind !== curKind || (stripKind && v.text !== curText)) {
      this._alertStrip = stripKind ? { kind: stripKind, text: v.text } : null;
      const panel = this.panels && this.panels.warnings;
      if (panel) {
        if (stripKind) {
          const red = stripKind === 'alert-red';
          panel.style.display = 'block';
          panel.style.borderColor = red ? 'rgb(var(--hud-warning-rgb, 255 68 34) / 0.5)' : 'rgb(var(--hud-caution-rgb, 255 170 0) / 0.3)';
          const textEl = (typeof document !== 'undefined') ? document.getElementById('hud-warning-text') : null;
          if (textEl) {
            textEl.textContent = v.text;
            textEl.style.color = red ? `var(--hud-warning, ${VisualLaw.COLORS.THREAT})` : `var(--hud-caution, ${VisualLaw.COLORS.CAUTION})`;
            textEl.style.opacity = '1';
          }
        } else {
          panel.style.display = 'none';
        }
      }
    }
  }

  // ==========================================================================
  // NOTIFICATION ZONE (UX-2 #12)
  // ==========================================================================

  /**
   * u7 D6: would a toast sent now be lost or parked? True while gameplay toasts are muted (the "Reticles & alerts"
   * rung) or the arbiter holds every prompt (the intro flyby, or a live approach to the selected target:
   * measured 2026-10-20, after the first scan the LEO line sat in `held` through all of floors 4 and 5), or
   * an amber / red alert is showing or waiting.
   * The once-only floor lines wait for false, so they are shown, not just marked taught.
   */
  toastsQuiet() {
    if (this._transientPopupsQuiet || this._introInhibit || this._approachLive) return true;
    // u7 review: also while the arbiter shows or holds an amber / red alert - a prompt sent now would wait behind it
    // (or be pre-empted), and the once-only line must not be marked taught unseen.
    const a = this._alerts;
    if (!a || typeof a.visible !== 'function') return false;
    const v = a.visible(this._alertClock());
    if (v && v.level >= 2) return true;
    return a.held().some((h) => h.level >= 2);
  }

  /**
   * Show a transient notification in the bottom-center zone.
   *
   * Session O (plan D12, owner 2026-09-07): toasts carry a `kind` —
   * untagged = 'prompt' = shown (the safe default). ONE policy table
   * (TOAST_DROP_WHILE_ENGAGED) drops everything below 'prompt' while the
   * ladder's engaged policy is set — `force` does NOT override the kind drop
   * (the density per-step toasts are `confirm` + `force` and must die so a
   * `-` press shows no toast; the pure-scenery reminder "+ restores" is
   * `prompt` + `force` and must show). No policy (flag-off/disengaged) →
   * every kind shows, byte-identical to today. Session Q adds levels /
   * inhibit windows / one-at-a-time (the alert kinds `alert-red`/`alert-amber`
   * are named now but behave as `prompt` in O).
   *
   * @param {string} text — Notification text
   * @param {number} [durationMs=2500] — Display duration in ms
   * @param {{ force?: boolean, kind?: string }} [opts] — force:true bypasses
   *   pane-density quiet mode (used by the density ladder's own toasts, which
   *   are the exit affordance and must always show). kind: 'prompt' | 'confirm'
   *   | 'notice' | 'view' | 'inspect' | 'memo' | 'alert-red' | 'alert-amber'.
   */
  showNotification(text, durationMs = 2500, opts = {}) {
    const kind = opts.kind || 'prompt';
    // Session O (plan D12): the engaged policy's ONE drop table — BEFORE every
    // other gate, so the pure-scenery reminder (prompt + force) always reaches
    // the zone and the density per-step toasts (confirm + force) never do.
    if (this._toastPolicy === 'engaged' && TOAST_DROP_WHILE_ENGAGED.has(kind)) return;
    if (!this._notificationZone) return;
    // Pane-density: once the "Reticles & alerts" rung is engaged, transient
    // GAMEPLAY toasts (SHOW_NOTIFICATION — autopilot/view/inspection, etc.) are
    // muted so pure scenery stays quiet. The ladder's own notify() passes
    // force:true so its restore/pure-scenery toasts still appear.
    if (!opts.force && this._transientPopupsQuiet) return;
    // Session Q (plan D12 / D12c): while engaged the ARBITER owns the zone —
    // levels, the inhibit windows, one at a time (drop table → density quiet →
    // arbiter, in that order). 'show' paints through the sink mirror; 'hold'
    // parks it for `next()`; the shipped timer path never runs. Duck-typed on
    // the arbiter so a fabricated Session O HUD keeps the O behaviour.
    if (this._toastPolicy === 'engaged' && this._alerts) {
      const now = this._alertClock();
      if (this._alerts.offer({ kind, text, durationMs, force: !!opts.force }, now) === 'show') this._syncAlertSinks(now);
      return;
    }
    this._notificationZone.textContent = text;
    this._notificationZone.style.textTransform = _toastCase(text);
    this._notificationZone.style.opacity = '1';
    // PR 5 / P2.8: TimerManager-tracked notification timer (debounced).
    if (this._notifTimer) timerManager.clear(this._notifTimer);
    this._notifTimer = timerManager.setTimeout(() => {
      this._notificationZone.style.opacity = '0';
      this._notifTimer = null;
    }, durationMs, { owner: this });
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
      GREEN:  { border: 'var(--hud-normal, #00cc66)', text: 'var(--hud-normal, #00ff88)', label: 'GREEN. INFORMATIONAL' },
      YELLOW: { border: 'var(--hud-caution, #ccaa00)', text: 'var(--hud-caution, #ffdd44)', label: 'YELLOW. CAUTION' },
      RED:    { border: 'var(--hud-warning, #ff3333)', text: 'var(--hud-warning, #ff5555)', label: 'RED. CRITICAL' },
    };
    const tc = tierColors[data.tier] || tierColors.GREEN;

    panel.style.borderColor = tc.border;
    panel.style.display = 'block';

    // Header
    const header = panel.querySelector('#hud-conjunction-header');
    if (header) {
      header.innerHTML = `⚠ CONJUNCTION ALERT <span id="hud-conjunction-help" style="cursor:pointer;pointer-events:auto;opacity:0.7;font-size:11px;margin-left:6px;" title="What is a conjunction? Open the Library page">[?]</span>`;
      header.style.color = tc.text;
      // ST-2.1 → Wave 4 (08-workbench §11): the [?] glyph is a REAL deep link.
      // It used to emit bare CODEX_OPENED, which nothing routes to the viewer
      // (and the panel inherited pointer-events:none, so the handler was
      // unreachable — decorative). Now: stop propagation so the pane-level
      // data-help click doesn't double-fire, then deep-link the Conjunction
      // Alerts entry via CODEX_OPEN_ENTRY (main.js → CodexViewerUI.openEntry),
      // the same path glossary terms use. PaneHelp's rescan enables pointer
      // events on the panel, which is what makes this glyph clickable at all.
      const helpGlyph = header.querySelector('#hud-conjunction-help');
      if (helpGlyph) {
        helpGlyph.onclick = (e) => {
          if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
          eventBus.emit(Events.CODEX_OPEN_ENTRY, { id: 'pane_conjunction_alerts' });
        };
      }
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

    // RED tier: finite attention-grab. Phase 1 #8: ~3 pulses (6 alternate
    // half-cycles) then settle to the steady full-opacity red-bordered panel —
    // no longer an infinite strobe. This is the single retained alert pulse
    // (imminent collision, mission ≥7). _hideConjunctionAlert clears the
    // animation on CONJUNCTION_CLEAR, so a later distinct RED re-pulses.
    if (data.tier === 'RED') {
      panel.style.animation = 'conjunction-pulse 0.6s ease-in-out 6 alternate';
      // Inject keyframes if not yet present
      if (!document.getElementById('conjunction-pulse-style')) {
        const style = document.createElement('style');
        style.id = 'conjunction-pulse-style';
        style.textContent = `
          @keyframes conjunction-pulse {
            from { box-shadow: 0 0 8px rgb(var(--hud-warning-rgb, 255 50 50) / 0.4); opacity: 1; }
            to   { box-shadow: 0 0 20px rgb(var(--hud-warning-rgb, 255 50 50) / 0.8); opacity: 0.85; }
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
      background: rgb(var(--hud-ink-rgb, 0 0 0) / 0.8);
      border: 1px solid ${data.color || 'var(--hud-dim, #888)'};
      border-radius: 4px; padding: 4px 10px;
      font-family: var(--font-mono); font-size: 10px;
      color: ${data.color || 'var(--hud-text, #ccc)'}; white-space: nowrap;
      pointer-events: none;
    `;
    badge.innerHTML = `<span style="font-size:12px;">${data.icon || '🌐'}</span><span>${data.name}</span>`;
    badge.dataset.weatherType = data.type;
    this._weatherContainer.appendChild(badge);
    this._weatherContainer.style.display = 'flex';   // followups-1018 D4: takes space only while it holds a badge
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
      if (this._weatherBadges.size === 0) this._weatherContainer.style.display = 'none';
    }
  }

  // ==========================================================================
  // V5 CROSSBOW FEEDBACK
  // ==========================================================================

  /**
   * V5: Show dramatic "TETHER SNAP" alert on tether break.
   * Floating text + queued critical warning + audio carry the event.
   * Phase 1 #11: the full-screen radial flash was removed.
   * @param {{ armIndex: number, cause: string }} data
   */
  showTetherSnapAlert(data) {
    // Floating "TETHER SNAP" text
    const text = document.createElement('div');
    text.className = 'hud-alert-float';
    text.style.cssText = `
      position: fixed; top: 35%; left: 50%;
      transform: translate(-50%, -50%);
      color: var(--hud-warning, #ff3333); font-family: var(--font-mono);
      font-size: 32px; font-weight: bold; letter-spacing: 4px;
      text-shadow: 0 0 20px rgb(var(--hud-warning-rgb, 255 50 50) / 0.8), 0 0 40px rgb(var(--hud-warning-rgb, 255 0 0) / 0.4);
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
   * Recoverable net failure: "NET FAILED" text + queued warning. Less severe
   * than a tether snap (the daughter survives and the debris is re-capturable).
   * Phase 1 #11: the full-screen radial flash was removed.
   */
  showNetFailedAlert(data) {
    // Floating "NET FAILED" text
    const text = document.createElement('div');
    text.className = 'hud-alert-float';
    text.style.cssText = `
      position: fixed; top: 35%; left: 50%;
      transform: translate(-50%, -50%);
      color: var(--hud-caution, #ffaa33); font-family: var(--font-mono);
      font-size: 28px; font-weight: bold; letter-spacing: 4px;
      text-shadow: 0 0 18px rgb(var(--hud-caution-rgb, 255 170 50) / 0.8), 0 0 36px rgb(var(--hud-caution-rgb, 255 140 0) / 0.4);
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
   * broke debris into new tracked fragments (Kessler ticks up). Floating text +
   * queued warning; the mercy waiver is named when it applies.
   * Phase 1 #11: the full-screen radial flash was removed.
   * @param {{ debrisId:*, fragmentCount:number, mercyApplied:boolean }} data
   */
  showFragmentationAlert(data) {
    const text = document.createElement('div');
    text.className = 'hud-alert-float';
    text.style.cssText = `
      position: fixed; top: 35%; left: 50%;
      transform: translate(-50%, -50%);
      color: var(--hud-warning, #ff6633); font-family: var(--font-mono);
      font-size: 28px; font-weight: bold; letter-spacing: 4px;
      text-shadow: 0 0 18px rgb(var(--hud-warning-rgb, 255 100 50) / 0.8), 0 0 36px rgb(var(--hud-warning-rgb, 255 60 0) / 0.4);
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
   * V5: Show a steady "STABILIZE" warning when angular velocity is too
   * high for safe crossbow fire. Phase 1 #4: steady amber text (no strobe);
   * show/hide logic unchanged.
   * @private
   */
  _showStabilizeWarning() {
    if (!this._stabilizeEl) {
      this._stabilizeEl = document.createElement('div');
      this._stabilizeEl.id = 'hud-stabilize-warning';
      this._stabilizeEl.style.cssText = `
        position: absolute; bottom: 210px; left: 50%;
        transform: translateX(-50%);
        font-family: var(--font-mono);
        font-size: 14px; font-weight: bold; letter-spacing: 2px;
        color: var(--hud-caution, #ffaa00); text-shadow: 0 0 8px rgb(var(--hud-caution-rgb, 255 170 0) / 0.5);
        pointer-events: none; z-index: 110;
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
  // m1-finish: MISSION COMPLETE HEADLINE
  // ==========================================================================

  /**
   * Show the centred "MISSION N COMPLETE" headline when a mission's last catch lands
   * (Events.MISSION_COMPLETE). Fixed, centred, top 28 %,
   * click-through, faded by timerManager. Visible MISSION_COMPLETE_MS in all, then removed.
   * No button, no world hold, no dimming, no countdown (DECISIONS §14 rows 1 and 3), and it is
   * not part of any floor, so FloorMask never hides it.
   * @param {{ mission?: number, debrisCleared?: number }} data
   */
  showMissionComplete(data) {
    const MISSION_COMPLETE_MS = 4000;
    const mission = Math.max(1, Math.floor(Number(data && data.mission)) || 1);
    const pieces = (Constants.MISSIONS && Constants.MISSIONS.DEBRIS_PER_MISSION) || 5;
    if (this._missionCompleteEl && this._missionCompleteEl.remove) this._missionCompleteEl.remove();
    // A mastery toast on screen sits at 28 %; go below it instead of on top of it.
    const top = document.querySelector('.hud-mastery-toast') ? 40 : 28;
    const el = document.createElement('div');
    el.className = 'hud-mission-complete';
    el.style.cssText = `
      position: fixed;
      left: 50%;
      top: ${top}%;
      transform: translate(-50%, -50%);
      padding: 14px 36px;
      background: linear-gradient(135deg, rgb(var(--hud-ink-rgb, 20 12 40) / 0.9), rgb(var(--hud-target-rgb, 60 30 80) / 0.9));
      border: 2px solid rgb(var(--hud-caution-rgb, 255 200 80) / 0.85);
      box-shadow: 0 0 24px rgb(var(--hud-caution-rgb, 255 200 80) / 0.55), 0 4px 18px rgb(var(--hud-ink-rgb, 0 0 0) / 0.6);
      color: var(--hud-label, #fff);
      font-family: var(--font-mono);
      text-align: center;
      z-index: 9000;
      opacity: 0;
      transition: opacity 0.3s ease;
      pointer-events: none;
    `;
    el.innerHTML = `
      <div style="font-size:22px; letter-spacing:4px; color:var(--hud-label, #fff);">MISSION ${mission} COMPLETE</div>
      <div style="font-size:13px; letter-spacing:2px; margin-top:6px; color:var(--hud-caution, #ffcc66);">${pieces} of ${pieces} pieces caught</div>
    `;
    document.body.appendChild(el);
    this._missionCompleteEl = el;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { el.style.opacity = '1'; });
    else el.style.opacity = '1';
    timerManager.setTimeout(() => { el.style.opacity = '0'; }, MISSION_COMPLETE_MS - 300, { owner: this });
    timerManager.setTimeout(() => {
      el.remove();
      if (this._missionCompleteEl === el) this._missionCompleteEl = null;
    }, MISSION_COMPLETE_MS, { owner: this });
  }

  // ==========================================================================
  // UX Fix C: ARM PILOT CONTROLS STRIP
  // ==========================================================================

  /** @private Create the ARM PILOT controls strip DOM element (lazy, once). */
  _createArmPilotStrip() {
    if (this._armPilotStrip) return;
    this._armPilotStrip = document.createElement('div');
    this._armPilotStrip.id = 'arm-pilot-controls';
    // Follow-up 2026-09-09 (plan 1788926404388-hud-followups-0909.md §1.4): with
    // the ladder on the strip rides one gap above the footer band (172 =
    // `armPilotStripBottomPx(true)`) — the gag owns the viewport bottom now;
    // `?ladder=0` keeps the shipped 12. Lazy (first show), so the flag is long
    // since set by init(); the same `Constants.LADDER.ENABLED` read as the
    // constructor's toast, never a module-level read.
    const ladderOn = !!(Constants.LADDER && Constants.LADDER.ENABLED);
    // Content set dynamically by _updateArmPilotStripContent() — no static HTML here
    Object.assign(this._armPilotStrip.style, {
      position: 'fixed',
      bottom: `${armPilotStripBottomPx(ladderOn)}px`,
      left: '50%',
      transform: 'translateX(-50%)',
      background: 'rgb(var(--hud-ink-rgb, 0 30 60) / 0.85)',
      border: '1px solid rgb(var(--hud-info-rgb, 0 200 255) / 0.4)',
      borderRadius: '6px',
      padding: '6px 16px',
      color: 'var(--hud-info, #88ccff)',
      fontFamily: 'var(--font-mono)',
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
        .apc-badge { color: var(--hud-info, #00ccff); font-weight: bold; font-size: 12px; }
        .apc-key { background: rgb(var(--hud-info-rgb, 0 200 255) / 0.15); border: 1px solid rgb(var(--hud-info-rgb, 0 200 255) / 0.3);
                   border-radius: 3px; padding: 1px 5px; color: var(--hud-info, #00ccff); font-weight: bold; }
        .apc-sep { color: rgb(var(--hud-info-rgb, 0 200 255) / 0.25); }
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
    // u17b: a daughter parked with a catch gets her own strip (below), never the pilot strip's N / R / ESC options.
    if (arm && arm.state === Constants.ARM_STATES.HOLDING_CATCH) { this._updateHoldingStripContent(arm); return; }

    const isStationKeep = arm && arm.state === Constants.ARM_STATES.STATION_KEEP;
    // u15b fix 4: glass is read when the strip is drawn (D7), and the glass strip lists only the controls that exist right
    // now (a chip on screen), so the cached mode carries them: a glass flip or a chip coming and going redraws the strip.
    // Desktop keeps the bare 'sk' / 'pilot' keys and its HTML byte for byte.
    const glass = GestureHints.isGlass();
    const chip = glass ? this._glassStripChips() : null;
    const fly = glass ? this._glassFlyingLine(arm) : '';   // u18a (D2): TRANSIT / APPROACH only; the whole metres are in the text, so in the key
    const base = isStationKeep ? 'sk' : 'pilot';
    const mode = glass ? `${base}:glass:${chip.net}:${chip.reel}:${fly}` : base;
    // Avoid redundant DOM writes — track which variant is showing
    if (this._armStripMode === mode) return;
    this._armStripMode = mode;

    if (glass) {
      // Touch controls that really exist in that state (InputManager ~:1952 / ~:2142-2166, TouchActionChip):
      // the turn pad steers her only while she holds station; tapping her DAUGHTERS row again hands her back; the net
      // button and REEL are named only while their chip is up; no +/- distance control exists on glass.
      const sep = '<span class="apc-sep">│</span>';
      const key = (w) => `<span class="apc-key">${w}</span>`;
      const parts = isStationKeep
        ? ['<span class="apc-badge">🛰️ STATION KEEP</span>', `${key('TURN PAD')} Orbit`]
        : ['<span class="apc-badge">🤖 DAUGHTER PILOT</span>'];
      if (fly) parts.push(fly);
      if (chip.net) parts.push(`${key(chip.net)} ${isStationKeep ? 'Capture' : 'Deploy Net'}`);
      if (chip.reel) parts.push(`${key('REEL')} Recall`);
      parts.push('Tap her row in DAUGHTERS again to exit');
      this._armPilotStrip.innerHTML = parts.join(sep);
      return;
    }

    if (isStationKeep) {
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
        '<span class="apc-key">ESC</span> Recall';
    } else {
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

  /**
   * @private u15b fix 4: which touch chips are on screen right now, for the glass pilot strip: the net button
   * ('LAUNCH NET', 'STICK PAD', 'CLOSE GRIPPER' or 'USE MAGNET' (u18c: her tool's word), else '') and whether REEL is up. Read from the ticker's step buttons (TouchActionChip posts them).
   * @returns {{net:string, reel:boolean}}
   */
  _glassStripChips() {
    const t = this.hintTicker;
    const has = (label) => !!(t && typeof t.hasStepButton === 'function' && t.hasStepButton(label));
    const net = ['LAUNCH NET', 'STICK PAD', 'CLOSE GRIPPER', 'USE MAGNET'].find(has) || '';
    return { net, reel: has('REEL') };
  }

  /**
   * @private u17b: the selected daughter when she is parked with a catch and not being piloted (the pilot strip wins in
   * pilot view), else null. Read from the arm manager, never cached.
   * @returns {object|null}
   */
  _holdingStripArm() {
    if (!this.visible || this._armPilotView) return null;
    const am = this._armManager;
    const arm = am && typeof am.getSelectedArm === 'function' ? am.getSelectedArm() : null;
    return arm && arm.state === Constants.ARM_STATES.HOLDING_CATCH ? arm : null;
  }

  /**
   * @private u18a (D2, owner 2026-10-22 "LAUNCH NET ~5 s late"): what the glass pilot strip says while she is piloted and
   * still flying in: `Flying to the piece · 34 m` (whole metres to her target; just `Flying to the piece` when her target has
   * no position to measure from; NO text at all when she has no target, as after a DEPLOY with none). TRANSIT and APPROACH
   * only: from station-keep on, the net chip and the strip's
   * Capture word take over; in REELING / NETTING / the rest it says nothing. No key, no net button: the LAUNCH NET chip is
   * not offered out here (the small net always misses beyond about 26 m, and she holds station at 16-24 m). The text
   * itself goes into the strip's cached mode key, so the metres count down. Tolerates a bare HUD, no arm, no target.
   * @param {object} [arm] - the piloted ArmUnit
   * @returns {string} '' when nothing applies
   */
  _glassFlyingLine(arm) {
    const S = Constants.ARM_STATES;
    if (!arm || (arm.state !== S.TRANSIT && arm.state !== S.APPROACH)) return '';
    // No target (DEPLOY with nothing selected sets none; also after a trawl): she is not flying to a piece, so say nothing.
    if (!arm.target) return '';
    const there = arm.target._scenePosition;
    const here = arm.position;
    if (!there || !here) return 'Flying to the piece';
    const metres = Math.hypot(there.x - here.x, there.y - here.y, there.z - here.z) / Constants.SCENE_UNITS_PER_METER;
    return Number.isFinite(metres) ? `Flying to the piece \u00B7 ${Math.round(metres)} m` : 'Flying to the piece';
  }

  /**
   * @private u17b: show, refresh or hide the strip for a selected holding daughter. Called on selection changes, on the
   * camera leaving pilot view, and every frame from update() (she leaves HOLDING_CATCH by a carry, a launch, a loss).
   */
  _syncHoldingStrip() {
    const arm = this._holdingStripArm();
    if (arm) {
      if (!this._holdingStripOn) this._showArmPilotStrip(arm);
      this._holdingStripOn = true;
      this._updateArmPilotStripContent(arm);
    } else if (this._holdingStripOn) {
      this._hideArmPilotStrip();
    }
  }

  /**
   * @private u17b: the strip for a selected daughter parked with a catch: only options that work for her right now.
   * Desktop: `.` moves her strut, `C` To radiator only while `ArmManager.canMoveCatchToRadiator` says it would start, her number
   * puts her down (ESC does not deselect a daughter who is not piloted, so it is never listed). Glass: TO RADIATOR only while
   * her row's button is up (the same getter), and the row tap that deselects; `.` has no touch control, so it is left out.
   * No net, no recall: neither does anything for her. Read when drawn (glass is never cached at construction).
   */
  _updateHoldingStripContent(arm) {
    const am = this._armManager;
    const canMove = !!(am && typeof am.canMoveCatchToRadiator === 'function' && am.canMoveCatchToRadiator(arm.index));
    const glass = GestureHints.isGlass();
    // The row button rides the ladder flag (StatusPanel `fleetTapEnabled`, the same gate as DEPLOY): on glass the strip names
    // TO RADIATOR only when that button is really on her row. The C key does not depend on the flag.
    const rowButton = canMove && !!(Constants.LADDER && Constants.LADDER.ENABLED);
    const mode = `hold:${glass ? 'glass' : 'desk'}:${arm.index}:${(glass ? rowButton : canMove) ? 'c' : '-'}`;
    if (this._armStripMode === mode) return;
    this._armStripMode = mode;
    const sep = '<span class="apc-sep">\u2502</span>';
    const key = (w) => `<span class="apc-key">${w}</span>`;
    const badge = `<span class="apc-badge">\u{1F916} DAUGHTER ${arm.index + 1} HOLDING A CATCH</span>`;
    const parts = [badge];
    if (glass) {
      if (rowButton) parts.push(`${key('TO RADIATOR')} Move her catch`);
      parts.push('Tap her row in DAUGHTERS again to deselect');
    } else {
      parts.push(`${key('.')} Strut`);
      if (canMove) parts.push(`${key('C')} To radiator`);
      parts.push(`${key(String(arm.index + 1))} Deselect`);
    }
    this._armPilotStrip.innerHTML = parts.join(sep);
  }

  /** @private Show the ARM PILOT controls strip with fade-in (`arm`: a holding daughter, u17b - her strip's content from the first frame). */
  _showArmPilotStrip(arm = null) {
    this._createArmPilotStrip();
    this._armStripHideToken = (this._armStripHideToken || 0) + 1;   // a fade-out still waiting must not hide this show
    // Set initial content (default ARM PILOT; update loop will swap to STATION_KEEP if needed)
    this._holdingStripOn = !!arm;
    this._updateArmPilotStripContent(arm);
    this._armPilotStrip.style.display = 'flex';
    requestAnimationFrame(() => { this._armPilotStrip.style.opacity = '1'; });
  }

  /** @private Hide the ARM PILOT controls strip with fade-out. */
  _hideArmPilotStrip() {
    this._holdingStripOn = false;
    if (this._armPilotStrip) {
      this._armPilotStrip.style.opacity = '0';
      this._armStripMode = null; // Reset so next show gets fresh content update
      const token = (this._armStripHideToken = (this._armStripHideToken || 0) + 1);
      timerManager.setTimeout(() => {
        if (this._armPilotStrip && token === this._armStripHideToken) this._armPilotStrip.style.display = 'none';
      }, 300, { owner: this });
    }
  }
}

export default HUD;
