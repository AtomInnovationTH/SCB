/**
 * StatusPanel.js — Score display, resource bars, mass budget, ΔV bar,
 * arm fleet status, and capture notifications.
 *
 * Session Q (plan D12b, owner 2026-09-07 — the dark cockpit): the MEMO slot.
 * With the `{ memoSlot: true }` ctor option (HUD passes the ladder gate) the
 * `#autopilot-indicator` chip — since F15 inside the collapsed PROPULSION
 * block, state nobody could see — becomes a steady token list in the MOTHER
 * header (`.mother-memo`, after the title, PLAYER green, no border): `AP
 * <MODE>` · `HOLD`, at most MEMO_MAX 3, joined with ` · `. Empty = the AP is
 * off (Airbus A1: nothing lit means normal). The slot text is written on change
 * only; a change to a NON-EMPTY string stamps a BOX_MS window (Airbus A4: the
 * one transient is a box around what changed) that `tickMemo(now)` paints as
 * the edge-chrome BOX_OUTLINE, write-on-change, from HUD.update — a local
 * timestamp, no timer. Without the option the markup and the chip are today's
 * byte for byte (`?ladder=0`). `memoTokens(mode, phase)` is the pure core.
 *
 * @module ui/hud/StatusPanel
 */

import { Constants } from '../../core/Constants.js';
import { eventBus } from '../../core/EventBus.js';
import { Events } from '../../core/Events.js';
import { GameStates } from '../../core/GameState.js';
import { VisualLaw } from '../../core/VisualLaw.js';
import { powerDistribution } from '../../systems/PowerDistribution.js';
import { captureNetSystem, netMaxReachM } from '../../entities/CaptureNet.js';
import timerManager from '../../systems/TimerManager.js';
import { shortTypeName } from './TargetPanel.js';
import { PaneChrome } from './PaneChrome.js';
import {
  shortScreenNow, watchShortScreen, daughtersSummary, departureEdges,
  FOLD_TOGGLE_TOUCH_PX, FOLD_CLOSED_GLYPH, FOLD_OPEN_GLYPH,
} from './PhoneFold.js';
import { GestureHints } from './GestureHints.js';
import { pressKey } from '../../core/KeyDispatch.js';
import { RAIL_GEOMETRY, PANE_CORNER_PX, MOTHER_PANE_WIDTH_PX, ARMS_PANE_WIDTH_PX, LEFT_COLUMN_WIDTH_PX } from '../RailGeometry.js';
import { BOX_OUTLINE, BOX_OUTLINE_OFFSET } from '../RailIndicator.js';
import { dividedByScale, onHudScaleChange } from '../HudScale.js';
import { TouchControls } from '../TouchControls.js';
import { radToDeg, clamp01, clamp } from '../../core/MathUtil.js';

/** The left column's max height on screen (px room below the top edge); divided by the HUD scale on a big screen. */
const LEFT_COLUMN_MAX_HEIGHT = 'calc(100vh - 60px)';

// ST-6.6: Active-tool → NASA TRL metadata used to live here, feeding a
// bottom-center "RCS / COLD GAS / MPD BURST / ARM PILOT" control-mode badge.
// Removed (2026-06-05): the mothership flies on autopilot by default and is
// steered with the arrow keys — WASD/RCS attitude modes are not part of the
// player-facing core loop, so a permanent centre-screen jargon badge only
// distracted new pilots. The CONTROL_MODE_CHANGE event itself is retained
// (CollisionAvoidanceSystem + CodexSystem consume it); only the HUD widget is
// gone. Mode/tool meaning, where it matters, is conveyed in plain-language
// comms instead.

/**
 * Short label for each trailing-rendezvous phase. Matches
 * AUTOPILOT_ANALYSIS.md §D.4 breadcrumb form (FAR · MATCH · ALIGN · HOLD).
 */
const _PHASE_LABELS = {
  OFF:             '',
  RENDEZVOUS_FAR:  'FAR',
  MATCH_ORBIT:     'MATCH',
  TRAIL_ALIGN:     'ALIGN',
  HOLD:            'HOLD',
};

/** The MEMO slot holds at most this many tokens (Session Q, plan D12b). */
export const MEMO_MAX = 3;

/** The MEMO token separator (the house middle dot). */
export const MEMO_SEP = ' \u00b7 ';

/**
 * The MEMO tokens for an autopilot state (pure). `OFF` → nothing lit. Else
 * `AP` (+ the heading mode when it is a real one — `ENGAGED` is the bare
 * engage) and `HOLD` while the phase is HOLD. Capped at MEMO_MAX.
 * @param {string} mode   'OFF' | 'ENGAGED' | 'TARGET' | 'TRAWL' | 'DEBRIS' | 'PROGRADE' | 'CLUSTER' | ...
 * @param {string} phase  'OFF' | 'RENDEZVOUS_FAR' | 'MATCH_ORBIT' | 'TRAIL_ALIGN' | 'HOLD'
 * @returns {string[]}
 */
export function memoTokens(mode, phase) {
  if (!mode || mode === 'OFF') return [];
  const tokens = ['AP' + ((typeof mode === 'string' && mode !== 'ENGAGED') ? ' ' + mode : '')];
  if (phase === 'HOLD') tokens.push('HOLD');
  return tokens.slice(0, MEMO_MAX);
}

// Shared "net" identity colour. NET reads the same ivory in BOTH the MOTHER
// digest (lasso ammo) and the DAUGHTERS list (per-unit magazine) so the player
// learns one colour for "nets". Low/empty still warns amber/red in both.
const NET_COLOR = 'var(--hud-text, #f0ecd8)'; // ivory white

/**
 * DECISIONS §33 row 10: the mother's ONE count of nets reads red at 0, amber at the low mark (1 net left,
 * `Constants.INVENTORY.LASSO_LOW_THRESHOLD`), and the ivory net colour otherwise.
 * @param {number} n nets left
 * @returns {string} a CSS colour
 */
export function motherNetsColor(n) {
  const low = (Constants.INVENTORY && Constants.INVENTORY.LASSO_LOW_THRESHOLD) || 1;
  if (n <= 0) return 'var(--hud-warning, #ff4444)';
  if (n <= low) return 'var(--hud-caution, #ffaa00)';
  return NET_COLOR;
}

// §11.3 reaction-wheel gauge (DAUGHTER_NET_RECOIL). Fixed 4-entry pip lookup —
// fill is threshold-relative, so the gauge stays honest if the tuning moves.
// Below the floor the wheel is "quiet" and the readout is hidden (no HUD noise;
// also where absent-field legacy mocks and the flag-OFF neutral 0/false land).
const WHEEL_PIPS = ['▯▯▯', '▮▯▯', '▮▮▯', '▮▮▮'];
const WHEEL_SHOW_FLOOR = 0.25; // normalized units — one fire (1.0) bleeds past this ~22 s later
// Daughter closing-rate smoothing (owner 10-22 13:26Z, the "opng/clsg" flicker). The shown rate is the Theil-Sen
// slope (median of pair slopes) of the displayed range over the last RANGE_RATE_WINDOW_S; the closing word shows above the HI edge and goes
// below the LO edge (m/s). Below the band the line reads "0.0 m/s" with no word.
const RANGE_RATE_WINDOW_S = 1.0;
const RANGE_RATE_MIN_SPAN_S = 0.6;
const RANGE_RATE_PAIR_GAP_S = 0.4;
const RANGE_RATE_BAND_HI = 0.15;
const RANGE_RATE_BAND_LO = 0.08;

// Session J (D-I): how many FLEET rows a tap can select. A row tap presses
// Digit(idx+1) — InputManager binds only Digit1-4 to `_handleArmKey` (arms 5-8
// are deferred until tiers ship, D2), so rows past the 4th are display-only.
export const FLEET_TAP_ROWS = 4;

/**
 * Session J review fix: the FLEET tap grammar (tappable rows, the DEPLOY /
 * REEL IN / RECALL buttons, the click delegate) is part of the Zoom-Ladder
 * programme and rides its ONE flag — `?ladder=0` (Constants.LADDER.ENABLED
 * false) must render the SHIPPED fleet pane byte-for-byte (text-only letter
 * hints, no buttons, no row handlers). Read live (the flag is a boot-time
 * constant; a getter keeps tests honest).
 * @returns {boolean}
 */
export function fleetTapEnabled() {
  return !!(Constants.LADDER && Constants.LADDER.ENABLED);
}

/**
 * Glass (iPad): ctor `glass` wins; else the hub's GestureHints switch; else
 * TouchControls.detectGlass() (coarse primary pointer + real touch points).
 * Plan Task 13 / locked #13 — 44 px hits and Mother tap apply on glass only.
 * @param {boolean|null|undefined} explicit
 * @returns {boolean}
 */
function resolveGlass(explicit) {
  if (explicit === true) return true;
  if (explicit === false) return false;
  try { if (GestureHints.isGlass()) return true; } catch (_e) { /* headless */ }
  try { return TouchControls.detectGlass(); } catch (_e) { return false; }
}

export class StatusPanel {
  /**
   * @param {HTMLElement} container - the HUD overlay the panes mount into
   * @param {{ keyDispatch?: (code: string, opts?: object) => boolean }} [deps]
   *   `keyDispatch` — Session J (D-I): the ONE way the FLEET pane's tap
   *   affordances act. Defaults to KeyDispatch.pressKey (synthetic keydown →
   *   keyup on window, InputManager's listener target); tests inject a
   *   recorder. Also settable later via setKeyDispatch().
   *   `glass` — Task 13: 44 px Daughters hits + Mother tap. Omit to reuse
   *   GestureHints.isGlass() / TouchControls.detectGlass(); tests pass true/false.
   */
  constructor(container, { keyDispatch = pressKey, memoSlot = false, now = null, glass = null, cargoPaneVisible = null } = {}) {
    this._container = container;
    this._armManager = null;
    this._keyDispatch = keyDispatch;
    this._glassArg = glass;
    this._glass = resolveGlass(glass);
    // Session Q (plan D12b): the MEMO slot option + its local box clock.
    this._memoSlot = !!memoSlot;
    this._now = (typeof now === 'function') ? now
      : (() => ((typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now()));
    this._memoText = '';              // the slot's last written text (write-on-change)
    this._memoBoxedUntil = -Infinity; // the A4 box window's end (a local timestamp, no timer)
    this._memoBoxedPainted = false;   // the outline's last written state
    this._memoEl = null;              // cached #autopilot-indicator once found
    this._simple = false;            // z1-calm-scan D5: mission-1 simple level (update() data.simple); DAUGHTERS hides LAUNCH + ΔV
    this._fleetClickBound = false;   // the ONE #hud-arms-status click delegate, attached once
    // u4-phone-fold D2: the DAUGHTERS fold (short screens only; see PhoneFold.js).
    this._armsShort = false;         // window.innerHeight < 500, live
    this._armsFolded = false;        // folded to one line while short (in memory only)
    this._armsDockedPrev = null;     // id -> was at the dock (the departure edge detector)
    this._armsSummary = '';          // last written "N of M ready" (write-on-change)
    this._foldToggleEl = null;       // the DAUGHTERS fold line (built in _buildArmsFold)
    this._foldRightEl = null;
    this._armsFoldKey = '';          // last painted fold inputs (write-on-change; u4 review fix 6)
    this._armsFoldWrites = 0;        // count of real paints (tests)
    this._unwatchArmsShort = null;   // the resize unwatch (dispose; u4 review fix 8)
    this._cargoStatus = null;   // cached from CARGO_UPDATED events
    // Locked #15: Mother's CARGO kg/cap line is hidden while the Cargo pane's
    // rung is visible (injected getter; default false so tests without HUD
    // still show the line).
    this._cargoPaneVisible = typeof cargoPaneVisible === 'function' ? cargoPaneVisible : () => false;
    this._lastPowerState = null;
    this._motherExpanded = false;     // MOTHER detail hover-expand state
    this._motherPinned = false;       // badge-pinned open (chrome 'normal' step)
    this._motherHovering = false;     // pointer currently over the MOTHER pane
    this._motherCollapseTimer = null;
    this._motherTapDown = null;       // glass tap: pointerdown position (drag ≠ tap)
    this._motherTapHandled = false;   // glass tap: pointerup already toggled → swallow click
    this._throttleLevel = 1.0;  // F14: cached throttle for HUD display
    this._autopilotMode = 'OFF'; // F15: cached autopilot mode for HUD
    this._autopilotPhase = 'OFF'; // Trailing-rendezvous phase (F15.1)
    this._mpdUnlocked = false;   // F16: MPD thruster unlocked flag
    this._mpdArmed = false;      // S3b: MPD burst mode state

    // V5: Crossbow arm HUD state
    this._tetherTensions = {};          // {armIndex: fraction} — cached from events

    // Daughter telemetry: per-id finite-difference range-rate cache. Live
    // velocity fields are absolute scene-space (~orbital speed) and useless to a
    // pilot, so the HUD differences the displayed range itself. Keyed by daughter
    // id → { range, t, targeting } so a target change invalidates the sample.
    this._daughterRangeCache = new Map();
    this._pulseScanState = 'READY';     // READY | SCANNING | COOLDOWN

    // ST-1.3: Lasso cooldown ring state
    this._lassoCooldownDuration = 0;    // total cooldown duration (s)
    this._lassoCooldownStart = 0;       // Date.now() when cooldown started
    this._lassoCooldownActive = false;  // true while cooling
    this._lassoDeniedFlash = 0;         // Date.now() timestamp of last denied flash

    // MOTHER readiness-digest dark-cockpit state — each segment reports whether
    // it is nominal; the line dims when all three are. Start nominal (quiet).
    this._netNominal = true;

    /** @type {Object<string, HTMLElement>} DOM panels for show/hide */
    this.panels = {};

    this._build();

    // u3-payoff-calm D1/D2: the one payoff line under the score strip.
    this._payoffTimer = null;
    this._payoffData = null;
    this._payoffEl = null;
    this._payoffLineEl = null;
    this._payoffNameEl = null;   // "Caught a rocket body · 4,232 kg": the only part that may shorten
    this._payoffCrEl = null;     // "+1,250 cr": never shrinks
    this._payoffMatEl = null;
    this._payoffPending = 0;     // catch-bonus credits that arrived before their catch's line (same frame)
    this._payoffFrame = false;   // true until the microtask after the first catch / bonus event (= the same frame)
    this._payoffCatchInFrame = false;   // a catch's line was written in this same frame
    this._bindPayoff();

    // Phase 4: Listen for fuel changes
    eventBus.on(Events.FUEL_CHANGED, (data) => this._updateFuelIndicator(data));

    // Phase R6: EDT indicator — track via player telemetry
    // F16: MPD cathode + lithium visibility via telemetry
    eventBus.on(Events.PLAYER_TELEMETRY, (t) => {
      const edtEl = document.getElementById('edt-indicator');
      if (edtEl) {
        edtEl.style.display = t.edtActive ? '' : 'none';
      }

      // F16: Show MPD elements when unlocked
      if (t.hasMPD && !this._mpdUnlocked) {
        this._mpdUnlocked = true;
        const liRow = document.getElementById('mpd-lithium-row');
        if (liRow) liRow.style.display = '';
        const cathRow = document.getElementById('mpd-cathode-row');
        if (cathRow) cathRow.style.display = '';
      }
      if (this._mpdUnlocked) {
        this._updateCathodeDisplay(t.mpdCathodeTime || 0, t.mpdCathodeHealth, t.mpdCathodeLife);
        // S3b: Update MPD burst display from telemetry
        this._mpdArmed = !!t.mpdArmed;
        this._mpdTelemetry = t;
        this._updateMPDBurstDisplay();
      }
    });

    // Sprint A1: Cache cargo status for HUD cargo summary line
    eventBus.on(Events.CARGO_UPDATED, (status) => {
      this._cargoStatus = status;
      this._updateCargoLine();
    });

    // Sprint C2: Re-render arm panel when selection changes
    eventBus.on(Events.ARM_SELECT, () => this._renderArmPanel());
    eventBus.on(Events.ARM_DESELECT, () => this._renderArmPanel());

    // F14: Listen for throttle changes
    eventBus.on(Events.THROTTLE_CHANGE, (data) => {
      this._throttleLevel = data.level;
      this._updateThrottleGauge();
    });

    // F15: Listen for autopilot state changes
    eventBus.on(Events.AUTOPILOT_ENGAGE, (data) => {
      this._autopilotMode = data.mode || 'ENGAGED';
      if (data.phase) this._autopilotPhase = data.phase;
      this._updateAutopilotIndicator();
    });
    eventBus.on(Events.AUTOPILOT_DISENGAGE, () => {
      this._autopilotMode = 'OFF';
      this._autopilotPhase = 'OFF';
      this._updateAutopilotIndicator();
    });

    // S3b: MPD burst mode indicators
    eventBus.on(Events.MPD_BURST_END, () => {
      this._mpdArmed = false;
      this._updateMPDBurstDisplay();
    });

    // V5: Tether tension per-arm updates
    eventBus.on(Events.TETHER_TENSION_UPDATE, (data) => {
      if (data.armIndex !== undefined) {
        this._tetherTensions[data.armIndex] = data.fraction || 0;
      }
    });

    // V5: Pulse scan lifecycle
    eventBus.on(Events.PULSE_SCAN_START, () => {
      this._pulseScanState = 'SCANNING';
      this._renderArmPanel();
    });
    eventBus.on(Events.PULSE_SCAN_COMPLETE, () => {
      this._pulseScanState = 'COOLDOWN';
      this._renderArmPanel();
    });

    // V5: Crossbow fire — refresh the fleet list (the daughter's status changes).
    eventBus.on(Events.CROSSBOW_FIRE, () => {
      this._renderArmPanel();
    });

    // V5: Tether snap — clear tension for that arm
    eventBus.on(Events.TETHER_SNAP, (data) => {
      if (data.armIndex !== undefined) {
        delete this._tetherTensions[data.armIndex];
      }
    });

    // ST-1.3: Lasso cooldown ring — track cooldown start/end via events
    eventBus.on(Events.LASSO_COOLDOWN_START, (data) => {
      this._lassoCooldownDuration = data.duration || 2;
      this._lassoCooldownStart = Date.now();
      this._lassoCooldownActive = true;
      this._updateNetDigest();
    });
    eventBus.on(Events.LASSO_COOLDOWN_END, () => {
      this._lassoCooldownActive = false;
      this._updateNetDigest();
    });
    // Also flash denied state briefly
    eventBus.on(Events.LASSO_DENIED, () => {
      this._lassoDeniedFlash = Date.now();
      this._updateNetDigest();
    });
    // DECISIONS §33 (2026-10-20): ONE count of mother nets, owned by CaptureNetSystem. It arrives as
    // NET_INVENTORY_CHANGED { source:'mother', motherNets } (handled just below); the old 50-shot lasso count is gone.
    this._lassoAmmoMax = Constants.CAPTURE_NET.LARGE.MAGAZINE_SIZE;
    this._lassoAmmo = this._lassoAmmoMax;

    // Net ladder Phase B: Mother Large Net inventory segment. The digest
    // NET bar counts LASSO ammo; this separate M-NET segment tracks the whale-
    // hunt launcher, fed by NET_INVENTORY_CHANGED { source:'mother', podInventory }.
    // Owner 2026-10-13: ONE launcher, so the payload is a one-element array.
    this._motherPods = null;      // [n0] once a mother event arrives
    this._motherPodsMax = null;   // [max0]
    eventBus.on(Events.NET_INVENTORY_CHANGED, (data) => this._onMotherInventory(data));

  }

  /**
   * The mother's inventory event (NET_INVENTORY_CHANGED { source:'mother', podInventory, podMax?, motherNets }): the NET
   * digest reads left / capacity. nets-step2: the capacity grows with the line-fibre upgrade (4 -> 6 -> 8 -> 10), so it
   * comes from the event's podMax, never a fixed 4. Not a mother event: ignored.
   * @private
   * @param {object} data
   */
  _onMotherInventory(data) {
    if (!data || data.source !== 'mother') return;
    if (Array.isArray(data.podInventory)) this._motherPods = data.podInventory.slice();
    if (Array.isArray(data.podMax)) {
      this._motherPodsMax = data.podMax.slice();
      const cap = this._motherPodsMax.reduce((a, b) => a + (b || 0), 0);
      if (cap > 0) this._lassoAmmoMax = cap;
    }
    if (Number.isFinite(data.motherNets)) {
      this._lassoAmmo = data.motherNets;
      this._updateNetDigest();
    }
    this._updateMotherPodDigest();
  }

  // ==========================================================================
  // BUILD DOM
  // ==========================================================================

  /** @returns {HTMLElement|null} The left-column flex container */
  get leftColumn() { return this._leftColumn; }

  /** @private Create a styled HUD panel */
  _createPanel(id, styles) {
    const div = document.createElement('div');
    div.id = id;
    div.className = 'hud-panel';
    Object.assign(div.style, styles);
    this._container.appendChild(div);
    return div;
  }

  /**
   * @private Create a top-priority panel mounted on document.body.
   * Unlike _createPanel (which appends to the dimmable HUD overlay), these
   * panels sit ABOVE the reticle canvas (z=11) and the 3D scene, and escape the
   * per-view `hudOpacity` dimming — used for the always-bright mission objective
   * and the live control-mode indicator so neither is occluded or faded.
   */
  _createTopPanel(id, styles) {
    const div = document.createElement('div');
    div.id = id;
    div.className = 'hud-panel hud-top-priority';
    Object.assign(div.style, {
      position: 'fixed',
      zIndex: '50',     // above #reticle-canvas (11) and #hud-overlay (10)
      opacity: '1',
      pointerEvents: 'none',
    });
    Object.assign(div.style, styles);
    document.body.appendChild(div);
    return div;
  }

  /**
   * @private The MOTHER pane's markup (Session Q: a pure string builder so the
   * two shapes can be pinned). Without the memo slot: today's string byte for
   * byte. With it: the `#autopilot-indicator` chip is the header's second
   * child (`.mother-memo`) and the PROPULSION block omits it.
   * @returns {string}
   */
  _motherMarkup() {
    const memo = this._memoSlot;
    // h1-mother-pane D2: the MOTHER title row lives in VitalsPane (it is the pane's
    // title on every floor); this panel only OWNS the memo chip, and attachToVitals()
    // moves `#autopilot-indicator` into the title row's right-hand slot.
    return `${memo ? `
      <span id="autopilot-indicator" class="mother-memo" style="font-size:10px;letter-spacing:0.08em;color:var(--hud-normal, ${VisualLaw.COLORS.PLAYER});opacity:1;white-space:nowrap;"></span>` : `
      <div id="autopilot-indicator" style="font-size:10px;padding:2px 6px;border-radius:2px;display:inline-block;background:rgb(var(--hud-ink-rgb, 0 0 0) / 0.4);border:1px solid rgb(var(--hud-text-rgb, 255 255 255) / 0.1);color:var(--hud-dim, #555);">[Autopilot: OFF]</div>`}
      <div id="mother-digest" style="font-size:11px;white-space:nowrap;display:flex;align-items:center;gap:6px;transition:opacity 0.3s ease;">
        <span id="mother-digest-net" class="md-seg" style="display:inline-flex;align-items:center;gap:4px;color:${NET_COLOR};">
          <span class="md-core">
          <span class="md-label">NET</span>
          <span class="md-track"><span class="md-fill" id="mother-digest-net-fill"></span></span>
          <span class="md-count" id="mother-digest-net-count" title="Mother nets left">${Constants.CAPTURE_NET.LARGE.MAGAZINE_SIZE}/${Constants.CAPTURE_NET.LARGE.MAGAZINE_SIZE}</span>
          <span id="mother-digest-net-reload" style="display:none;">↻</span>
          </span>
          <span class="md-reach-group" id="mother-digest-net-reach-group"><span class="md-sep">·</span><span class="md-reach" id="mother-digest-net-reach" title="Small net reach">${StatusPanel.reachText(Constants.LASSO_RANGE)}</span></span>
        </span>
        <span class="md-sep" id="mother-digest-mnet-sep" style="display:none;">│</span>
        <span id="mother-digest-mnet" class="md-seg" style="display:none;align-items:center;gap:4px;color:${NET_COLOR};" title="Mother Large Net (whale hunts)">
          <span class="md-core">
          <span class="md-label">LARGE</span>
          <span class="md-count" id="mother-digest-mnet-count" title="Large net launcher"></span>
          </span>
          <span class="md-reach-group" id="mother-digest-mnet-reach-group"><span class="md-sep">·</span><span class="md-reach" id="mother-digest-mnet-reach" title="Large net reach">${StatusPanel.reachText(netMaxReachM(Constants.CAPTURE_NET.LARGE))}</span></span>
        </span>
      </div>
      <div class="mother-detail">
        <div id="mother-power-flow" class="mother-flow" style="font-size:10px;margin-top:6px;opacity:0.85;white-space:nowrap;font-variant-numeric:tabular-nums;" title="Power in and out"></div>
        <div class="mother-block mother-block-propulsion" data-hud-group="fuel-group" data-activate-key="A">
      <div class="panel-full-content">
        <div class="pane-title" style="font-size:11px;margin-top:6px;margin-bottom:4px;color:var(--hud-normal, #00ff88);opacity:0.7;">PROPULSION</div>
        <div id="mpd-lithium-row" class="hud-resource-row" style="display:none;">
          <span style="color:var(--hud-info, #88ccff);">Li</span>
          <div class="hud-bar-track"><div class="hud-bar-fill" id="hud-bar-lithium" style="width:0%;background-color:var(--hud-info, #88ccff);"></div></div>
          <span id="hud-val-lithium" style="width:36px;text-align:right;color:var(--hud-info, #88ccff);">0</span>
        </div>
        <div id="mpd-cathode-row" style="display:none;font-size:10px;color:var(--hud-label, #aaa);margin-top:1px;margin-bottom:2px;">
          <span title="MPD engine wear indicator">CATHODE:</span> <span id="hud-cathode-health" style="color:var(--hud-info, #88ccff);">100%</span>
          <span id="hud-cathode-time" style="opacity:0.5;margin-left:4px;">(0s/600s)</span>
        </div>
        <div id="mpd-burst-row" style="display:none;font-size:10px;margin-top:2px;margin-bottom:2px;">
          <div style="display:flex;align-items:center;gap:4px;">
            <span id="mpd-burst-label" style="color:var(--hud-target, #ff44ff);font-weight:bold;">MPD</span>
            <span id="mpd-burst-status" style="color:var(--hud-target, #ff44ff);">ARMED</span>
          </div>
          <div id="mpd-heat-row" style="display:flex;align-items:center;gap:4px;margin-top:2px;">
            <span style="color:var(--hud-dim, #666);font-size:9px;">HEAT</span>
            <div style="flex:1;height:6px;background:rgb(var(--hud-ink-rgb, 0 0 0) / 0.5);border:1px solid rgb(var(--hud-target-rgb, 255 68 255) / 0.3);border-radius:2px;overflow:hidden;">
              <div id="mpd-heat-bar" style="height:100%;width:0%;background:var(--hud-normal, #44ff44);transition:width 0.2s ease;"></div>
            </div>
            <span id="mpd-heat-val" style="width:30px;text-align:right;color:var(--hud-dim, #888);font-size:9px;">0%</span>
          </div>
        </div>
        <div id="fuel-type-indicator" style="font-size:10px;color:var(--hud-info, #4fc3f7);margin-top:2px;margin-bottom:2px">
          —
        </div>
        <div id="throttle-gauge" style="display:none;align-items:center;gap:4px;font-size:10px;margin-bottom:4px;">
          <span style="color:var(--hud-normal, #00ff88);opacity:0.7;">Throttle</span>
          <div style="flex:1;height:8px;background:rgb(var(--hud-ink-rgb, 0 0 0) / 0.5);border:1px solid rgb(var(--hud-normal-rgb, 0 255 136) / 0.3);border-radius:2px;overflow:hidden;position:relative;">
            <div id="throttle-bar-fill" style="height:100%;width:100%;background:var(--hud-normal, #00ff88);transition:width 0.15s ease;"></div>
          </div>
          <span id="throttle-val" style="width:30px;text-align:right;color:var(--hud-normal, #00ff88);font-weight:bold;">100%</span>
        </div>
        <div id="com-drift-row" style="display:none;font-size:10px;margin-top:3px;margin-bottom:2px;">
          <span style="opacity:0.7;">CoM Δ: </span><span id="com-drift-val" style="font-weight:bold;color:var(--hud-normal, #00ff88);">0.000 m</span>
          <span id="com-stow-hint" style="display:none;color:var(--hud-caution, #ffaa00);margin-left:4px;font-size:11px;"></span>
        </div>
        <div id="att-rate-row" style="display:none;font-size:10px;margin-top:1px;margin-bottom:2px;">
          <span style="opacity:0.7;">Rate: </span><span id="att-rate-val" style="font-weight:bold;color:var(--hud-normal, #00ff88);">P 0.0°/s · Y 0.0°/s · R 0.0°/s</span>
        </div>
        <div id="cargo-summary" data-hud-group="cargo-group" style="font-size:10px;margin-top:3px;color:var(--hud-dim, #666);display:none;"></div>
        <div class="panel-expand-section propulsion-expand">
          <div style="font-size:10px;margin-top:6px;padding-top:4px;color:var(--hud-info, #4488ff);opacity:0.7;" title="Fuel mass breakdown (Tsiolkovsky)">MASS BUDGET</div>
          <div id="hud-mass-budget" style="font-size:10px;line-height:1.5;">
            <span style="opacity:0.5">Computing…</span>
          </div>
        </div>
      </div>
        </div>
        <div class="mother-block mother-block-energy" id="hud-power-panel" data-hud-group="power-group">
      <div class="panel-full-content">
        <div class="pane-title" style="font-size:11px;margin-top:6px;margin-bottom:4px;color:var(--hud-normal, #00ff88);opacity:0.7;display:flex;justify-content:space-between;align-items:center;">
          <span>POWER SPLIT</span>
          <span id="power-collapse-indicator" style="font-size:10px;opacity:0.4;transition:transform 0.2s;">▸</span>
        </div>
        <div id="hud-power-bars" style="font-size:10px;line-height:1.6;transition:max-height 0.2s ease,opacity 0.2s ease;overflow:hidden;">
          <div class="hud-power-row" data-bus="thrust" style="margin:2px 0;">
            <div style="display:flex;align-items:center;gap:4px;">
              <span class="power-label" style="width:52px;color:var(--hud-normal, #00ff88);">Thrust</span>
              <div style="flex:1;height:10px;background:rgb(var(--hud-ink-rgb, 0 0 0) / 0.5);border:1px solid rgb(var(--hud-normal-rgb, 0 255 136) / 0.3);border-radius:2px;overflow:hidden;">
                <div id="hud-power-bar-thrust" style="height:100%;width:40%;background:var(--hud-normal, #00ff88);transition:width 0.2s ease;"></div>
              </div>
              <span class="power-value" id="hud-power-val-thrust" style="width:28px;text-align:right;font-size:10px;">40%</span>
            </div>
          </div>
          <div class="hud-power-row" data-bus="sensors" style="margin:2px 0;">
            <div style="display:flex;align-items:center;gap:4px;">
              <span class="power-label" style="width:52px;color:var(--hud-info, #4488ff);">Sensors</span>
              <div style="flex:1;height:10px;background:rgb(var(--hud-ink-rgb, 0 0 0) / 0.5);border:1px solid rgb(var(--hud-normal-rgb, 0 255 136) / 0.3);border-radius:2px;overflow:hidden;">
                <div id="hud-power-bar-sensors" style="height:100%;width:30%;background:var(--hud-info, #4488ff);transition:width 0.2s ease;"></div>
              </div>
              <span class="power-value" id="hud-power-val-sensors" style="width:28px;text-align:right;font-size:10px;">30%</span>
            </div>
          </div>
          <div class="hud-power-row" data-bus="arms" style="margin:2px 0;">
            <div style="display:flex;align-items:center;gap:4px;">
              <span class="power-label" style="width:52px;color:var(--hud-normal, #00ff88);">Daughters</span>
              <div style="flex:1;height:10px;background:rgb(var(--hud-ink-rgb, 0 0 0) / 0.5);border:1px solid rgb(var(--hud-normal-rgb, 0 255 136) / 0.3);border-radius:2px;overflow:hidden;">
                <div id="hud-power-bar-arms" style="height:100%;width:30%;background:var(--hud-normal, #00ff88);transition:width 0.2s ease;"></div>
              </div>
              <span class="power-value" id="hud-power-val-arms" style="width:28px;text-align:right;font-size:10px;">30%</span>
            </div>
          </div>
        </div>
        <div class="energy-hint" style="font-size:10px;opacity:0;margin-top:3px;border-top:1px solid rgb(var(--hud-normal-rgb, 0 255 136) / 0.1);padding-top:3px;">
          ⇧1-3: select · [ ] ±10%
          </div>
        </div>
        </div>
        <div class="mother-block mother-block-thermal" id="hud-thermal-panel" data-hud-group="thermal-group" style="display:none;">
          <div class="pane-title" style="font-size:11px;margin-top:6px;margin-bottom:4px;color:var(--hud-normal, #a3d9c9);opacity:0.7;">THERMAL</div>
          <div id="hud-thermal-flower" style="font-size:10px;line-height:1.5;"></div>
        </div>
      </div>
      `;
  }

  /** @private */
  _build() {
    // --- Left-column flex container for stacked panels ---
    // Follow-up 2026-09-09 (plan 1788926404388-hud-followups-0909.md §1.15 —
    // the inverted U): the column is as wide as its widest child (Mother 480, as wide as comms);
    // `align-items: flex-start` hugs the 350 Daughters and the 280 riders to
    // the LEFT edge, so the U's outer edge stays straight at PANE_CORNER_PX (0: MOTHER is in the corner).
    this._leftColumn = document.createElement('div');
    this._leftColumn.id = 'hud-left-column';
    Object.assign(this._leftColumn.style, {
      position: 'absolute',
      top: `max(${PANE_CORNER_PX}px, env(safe-area-inset-top))`,   // MOTHER sits IN the top-left corner (owner 2026-10-18); safe-area clears a notch
      left: `max(${PANE_CORNER_PX}px, env(safe-area-inset-left))`,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-start',
      gap: '10px',           // Pane-to-pane vertical gap — keep in sync with right column (HUD.js)
      width: `var(--hud-side-w, ${LEFT_COLUMN_WIDTH_PX}px)`,
      // u9-big-text: the column is drawn HUD_SCALE x bigger from its top edge on a big screen, so its layout box is
      // (screen room) / scale: the scaled column still ends where it ends today, and scrolls inside when longer.
      maxHeight: dividedByScale(LEFT_COLUMN_MAX_HEIGHT),
      overflowY: 'auto',
      zIndex: '10',
    });
    this._container.appendChild(this._leftColumn);
    this._unsubHudScale = onHudScaleChange(() => {
      if (this._leftColumn) this._leftColumn.style.maxHeight = dividedByScale(LEFT_COLUMN_MAX_HEIGHT);
    });

    // --- Mission Objective bar (top center) ---
    // Sim-reframe: the persistent top HUD shows only the mission objective
    // (hero "CLEARED N/60") plus a quiet credit wallet. Live flight state (RCS),
    // telemetry (orbit/altitude), and lore (TRL) live where they're contextual:
    // the reticle, the NavSphere/Orbit MFD, and tooltips/Codex respectively.
    // Mass recovered is taught through consequence (salvage card / run summary),
    // not a sterile running counter. See FULL_HUD_STRATEGY.md §13.
    //
    // PRIORITY LAYER: the objective is the single most important readout, so it
    // is mounted on document.body (NOT the HUD overlay) to escape the per-view
    // `hudOpacity` dimming, kept OUT of the progressive-luminance group so it is
    // never dormant/dimmed, and given a z-index above the reticle canvas (z=11)
    // and 3D debris so nothing can occlude it.
    this.panels.score = this._createTopPanel('hud-score-panel', {
      top: '8px', left: '50%', transform: 'translateX(-50%)',
      padding: '4px 14px',
    });
    // PRIORITY-LAYER CONTENT — restored to the documented "objective + quiet
    // wallet" intent: this most-seen, never-dimmed strip now carries ONLY the
    // hero CLEARED N/60 progress meter plus a quiet credit wallet.
    //   • The elevator-contract tracker was REMOVED from here. It is a slow,
    //     shop-driven, late-game objective that stays at 0 (and is mechanically
    //     unreachable — the Forge isn't taught in onboarding) for a new pilot's
    //     whole first session, so a static "0/10,000 kg" in this slot was clutter
    //     in premium real estate. It now lives gated atop the comms pane
    //     (CommsPanel._onContractUpdate), revealed on the first contribution,
    //     grouped with the channel that already narrates its milestones.
    //   • The daughter-tier badge (it lived in the DAUGHTERS pane header) was
    //     deleted with the tier upgrades, 2026-10-16.
    this.panels.score.innerHTML = `
      <div style="display:flex;align-items:center;gap:14px;white-space:nowrap;line-height:1;">
        <div style="display:flex;align-items:baseline;gap:7px;">
          <span style="font-size:10px;letter-spacing:2px;opacity:0.7;text-transform:uppercase;">Cleared</span>
          <span style="font-size:18px;font-weight:bold;letter-spacing:1px;color:var(--hud-normal, #00ff88);text-shadow:0 0 6px rgb(var(--hud-normal-rgb, 0 255 136) / 0.45);">
            <b id="hud-cleared">0</b><span style="opacity:0.5;font-weight:normal;font-size:13px;">/${Constants.WIN_DEBRIS_COUNT}</span>
          </span>
          <span id="hud-cleared-track" style="width:42px;height:3px;background:rgb(var(--hud-normal-rgb, 0 255 136) / 0.2);border-radius:2px;overflow:hidden;align-self:center;">
            <span id="hud-cleared-fill" style="display:block;width:0%;height:100%;background:var(--hud-normal, #00ff88);transition:width 0.4s ease;"></span>
          </span>
        </div>
        <span style="color:var(--hud-text, ${VisualLaw.COLORS.VALUE});font-size:12px;font-weight:bold;opacity:0.85;font-variant-numeric:tabular-nums;"><b id="hud-credits">0</b> cr</span>
      </div>
    `;

    // --- Control-mode indicator removed (2026-06-05) ---
    // A bottom-center "RCS" badge used to advertise what WASD does. The mother
    // flies on autopilot and steers with the arrow keys (no player-facing WASD
    // attitude modes), so the badge was jargon noise for new pilots. See the
    // note by the former _MODE_DISPLAY constant near the top of this file.

    // --- MOTHER Pane (left side, top) — unified Propulsion + Energy + Net digest ---
    // Replaces the former separate #hud-resources-panel + #hud-power-panel panes.
    // Leads with a one-line strategic-readiness digest (Net charges · ΔV budget %
    // · power glyph); the full Propulsion + Energy detail is hidden by default and
    // revealed on hover (or pinned open via the chrome badge). See
    // .kilo/plans/…-mother-pane-readiness-digest.md.
    //
    // NOTE: the inner propulsion/energy blocks intentionally KEEP all of the
    // element IDs, data-hud-group values, and the data-activate-key='A' that the
    // updaters and tests key off — only their parent box is now the MOTHER pane.
    // Mother is as wide as comms (480 via --hud-side-w; both narrow together on
    // smaller screens — DECISIONS §23 row 1, 2026-10-15); inline width beats
    // the .hud-panel 280 base.
    this.panels.mother = this._createPanel('hud-mother-panel', { width: `var(--hud-side-w, ${MOTHER_PANE_WIDTH_PX}px)` });
    this.panels.mother.className = 'hud-panel hud-panel-expandable';
    this.panels.mother.innerHTML = this._motherMarkup();
    this._leftColumn.appendChild(this.panels.mother);
    this.panels.mother.style.position = 'relative';
    if (this._glass && this.panels.mother.setAttribute) this.panels.mother.setAttribute('data-glass', '');
    this._injectPowerPulseStyle();
    this._injectMotherDigestStyle();

    // Cache the energy sub-block (drives the power-collapse CSS/JS via #hud-power-panel)
    this.panels.power = this.panels.mother.querySelector('#hud-power-panel');
    // Back-compat alias: other code historically referenced panels.resources as
    // the propulsion box. It now lives inside the MOTHER pane.
    this.panels.resources = this.panels.mother.querySelector('.mother-block-propulsion');
    // Set the propulsion onboarding activate-key via JS (matches the arms pane
    // pattern) so the progressive-luminance dormant-keycap glyph + the
    // activate-keys grep test (`activateKey = 'A'`) still find it.
    if (this.panels.resources) this.panels.resources.dataset.activateKey = 'A';

    // B5 → MOTHER: the energy bars default to compact bars-only; the whole MOTHER
    // detail (propulsion + energy) expands together on hover (see _expandMother).
    this._injectPowerCollapseStyle();
    if (this.panels.power) this.panels.power.classList.add('power-collapsed');

    // --- V5 Crossbow Arm Status Panel (left side, bottom) — DAUGHTERS pane ---
    // Follow-up 2026-09-09 (§1.15): 350 wide (ARMS_PANE_WIDTH_PX), hugging the
    // left edge under the 480 Mother (the column is align-items: flex-start).
    this.panels.arms = this._createPanel('hud-arms-panel', { width: `min(${ARMS_PANE_WIDTH_PX}px, var(--hud-side-w, ${MOTHER_PANE_WIDTH_PX}px))` });
    this.panels.arms.className = 'hud-panel hud-panel-expandable';
    this.panels.arms.dataset.hudGroup = 'arms-group';
    this.panels.arms.dataset.activateKey = 'D';
    // DAUGHTERS pane: one always-visible list, one line per daughter (plain
    // status + fuel). No hover layer / no resize badge — the selected daughter
    // highlights and shows the single action it can take right now.
    this.panels.arms.innerHTML = `
      <div class="pane-title" id="fleet-header" title="Keys 1–4 select a daughter" style="font-size:11px;margin-bottom:3px;color:var(--hud-normal, #00ff88);opacity:0.7;display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;">
        <span id="fleet-legacy" style="display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;">
          <span>DAUGHTERS</span>
        </span>
      </div>
      <div id="hud-arms-status" style="font-size:11px;line-height:1.6;">
        <span style="opacity:0.5">Initializing daughter fleet…</span>
      </div>
    `;
    this._leftColumn.appendChild(this.panels.arms);
    this.panels.arms.style.position = 'relative';
    // Session J (D-I): the FLEET pane is a tap surface — rows tap-select, the
    // selected row carries DEPLOY / REEL IN / RECALL buttons. Mirror TargetPanel
    // (`panels.targets.style.pointerEvents = 'auto'`) so the pane receives
    // clicks even where the .hud-panel default is pointer-events:none; ONE
    // click delegate on #hud-arms-status, attached once here (the list body is
    // re-rendered via innerHTML, so per-row listeners would not survive).
    // Flag-gated (review fix): a ?ladder=0 boot keeps the shipped pane —
    // no pointer opt-in, no button style, no delegate.
    if (this._glass && this.panels.arms.setAttribute) this.panels.arms.setAttribute('data-glass', '');
    if (fleetTapEnabled()) {
      this.panels.arms.style.pointerEvents = 'auto';
      this._injectFleetButtonStyle();
      this._bindFleetClicks();
    }
    this._buildArmsFold();

    // --- Resize chrome for the MOTHER pane (2-step: min / normal) ---
    // The MOTHER pane defaults to 'min' (compact digest only); hovering reveals
    // the full Propulsion + Energy detail. (The badge itself is hidden via CSS;
    // the step machinery + hover handlers below drive the reveal.)
    this._motherChrome = new PaneChrome({
      pane: this.panels.mother, keyLabel: '–', bracket: false,
      steps: ['min', 'normal'], initial: 'min',
      title: 'Mother systems',
      onStep: (name) => this._onMotherStep(name),
    });

    // MOTHER disclosure: hover reveals detail; mouse-leave collapses (unless
    // pinned open via the chrome badge / 'normal' step). The energy block no
    // longer self-collapses independently — it follows the MOTHER expand state.
    // Glass (Task 13): hover stays the desktop trigger; tap on the header
    // toggles .mother-expanded. Skip hover on glass so iOS ghost-hover cannot
    // expand-then-collapse under the tap.
    // h1-mother-pane D4: the handlers are bound to ONE hover target — the MOTHER panel until
    // attachToVitals() moves them to the merged pane's root, so hovering any meter row opens
    // the detail too (and moving from a meter onto the nets row is not a "leave").
    this._onMotherEnter = () => {
      if (this._glass) return;
      this._motherHovering = true;
      this._expandMother();
    };
    this._onMotherLeave = () => {
      if (this._glass) return;
      this._motherHovering = false;
      this._scheduleMotherCollapse();
    };
    this._hoverTarget = this.panels.mother;
    this.panels.mother.addEventListener('mouseenter', this._onMotherEnter);
    this.panels.mother.addEventListener('mouseleave', this._onMotherLeave);
    this._bindMotherGlassTap();
    // Reflect the initial compact step in the detail visibility + energy block.
    this._onMotherStep('min');

    // Phase 5 → R3 (relocated): the elevator-contract tracker used to live in the
    // top-center score strip and was ALWAYS visible. It moved to a gated header
    // atop the comms pane (CommsPanel._onContractUpdate) — revealed only once the
    // player makes their first contribution (contractMassKg > 0) — so a new pilot
    // isn't shown a static, unreachable 0/10,000 objective in the most-seen HUD
    // slot. The comms zone already narrates the contract milestones
    // (MissionMilestones), so the tracker and its narration share one cluster.

    // Phase 1 #13 / Phase 2: the ΔV pulse keyframe (deltav-pulse) and the
    // center-screen capture-notification overlay were both retired — low-fuel
    // urgency is steady red + audio, and the delivery moment is confirmed by the
    // salvage-reveal card + CLEARED counter + comms. No build step needed here.
  }

  // ==========================================================================
  // PUBLIC
  // ==========================================================================

  /**
   * h1-mother-pane D1/D2/D4: merge into the VitalsPane box. The MOTHER panel becomes a
   * child section of `#hud-vitals` (no border / background / title of its own — index.html),
   * the memo chip moves into the title row's right-hand slot, and the hover + glass-tap
   * handlers move from the panel to the merged root. The FloorMask table is untouched: the
   * mother section still follows the 'mother' rung (F2 by default); the root stays display-only
   * (index.html turns its pointer events on only while the section is visible).
   * @param {import('./VitalsPane.js').VitalsPane} vitals
   * @returns {boolean} true when merged
   */
  attachToVitals(vitals) {
    const root = vitals && vitals.root;
    const mother = this.panels && this.panels.mother;
    if (!root || !mother || !vitals.mountSection) return false;
    if (!vitals.mountSection(mother)) return false;
    this._vitals = vitals;
    if (mother.style) mother.style.width = 'auto';
    // The memo chip: out of the section, into the title row.
    const chip = typeof mother.querySelector === 'function' ? mother.querySelector('#autopilot-indicator') : null;
    const slot = vitals.titleSlot;
    if (chip && slot && typeof slot.appendChild === 'function') slot.appendChild(chip);
    // q3-mother-pane D2: the net line (`NET ━ 50/50 · 90 m │ LARGE 4/4 · 100 m`) rides the title row too, left of the
    // chip. It stays the mother rung's: index.html hides it wherever `#hud-mother-panel` is hidden (F1, F3, F4, −).
    const digest = typeof mother.querySelector === 'function' ? mother.querySelector('#mother-digest') : null;
    if (digest && slot && slot.parentNode && typeof slot.parentNode.insertBefore === 'function') slot.parentNode.insertBefore(digest, slot);
    // q3 round 2 (R2): re-fit the net line when the title row or the chip slot changes width (resize, a new chip text).
    if (digest && slot && slot.parentNode && typeof ResizeObserver === 'function') {
      if (this._fitObserver) this._fitObserver.disconnect();
      this._fitObserver = new ResizeObserver(() => this._fitDigest());
      this._fitObserver.observe(slot.parentNode);
      this._fitObserver.observe(slot);
    }
    // Hover / glass tap: off the panel, onto the merged root.
    if (typeof mother.removeEventListener === 'function') {
      mother.removeEventListener('mouseenter', this._onMotherEnter);
      mother.removeEventListener('mouseleave', this._onMotherLeave);
    }
    this._unbindMotherGlassTap();
    this._hoverTarget = root;
    root.addEventListener('mouseenter', this._onMotherEnter);
    root.addEventListener('mouseleave', this._onMotherLeave);
    this._bindMotherGlassTap();
    return true;
  }

  /**
   * Set the ArmManager reference for real-time status polling.
   * @param {import('../../entities/ArmManager.js').ArmManager} armManager
   */
  setArmManager(armManager) {
    this._armManager = armManager;
    this._renderArmPanel();
  }

  /**
   * Update score, resources, mass budget, and ΔV bar.
   * Called at 10 Hz from the coordinator.
   * @param {object} data
   * @param {number} data.score
   * @param {number} data.credits
   * @param {number} data.debrisCleared
   * @param {object} data.resources
   * @param {Array}  data.cachedTargets
   * @param {boolean} [data.simple]  mission-1 simple level (DAUGHTERS hides LAUNCH and ΔV); default false
   */
  update(data) {
    this._updateScorePanel(data);
    this._updateResourceBars(data.resources);
    this._renderMassBudget();
    this._paintPowerFlow();
    this._updateDeltaVBar(data.cachedTargets);
    this._updatePowerBars();
    this._renderThermalGroup();
    if (data.cargoStatus) {
      this._cargoStatus = data.cargoStatus;
    }
    this._updateCargoLine();

    // C-9: Update CoM drift display + plume block indicator
    this._updateCoMDisplay(data);

    // Attitude: live body angular-rate readout (rigid-body dynamics legibility)
    this._updateAttitudeRate(data);

    // V5: Re-render arm panel at 10Hz for live tension/scan/flash updates.
    // z1-calm-scan D5: `data.simple` = HUD.isSimpleTargets() (mission 1, no extra pane) — the ONE gate
    // TargetPanel uses; kept on the instance so the event-driven renders agree. Absent = detail level.
    this._simple = !!data.simple;
    this._renderArmPanel();

    // ST-1.3: Update lasso cooldown ring at 10Hz for smooth arc depletion
    this._updateNetDigest();

    // Mother pod cooldown countdown (§12) — tick at 10 Hz so the ·Ns suffix
    // clears itself when the cooldown expires (the digest is otherwise
    // event-driven and would show a stale countdown until the next shot).
    if (Array.isArray(this._motherPods)) this._updateMotherPodDigest();
  }

  /** Re-render the arm status panel (call on arm state-change events). */
  renderArmPanel() {
    this._renderArmPanel();
  }

  /**
   * C-9: Update the CoM drift display and plume-block indicator.
   * Shows/hides based on COM_TRACKING / THRUSTER_INTERLOCK feature flags.
   * Color coding: green < 0.5×threshold; amber < threshold; red ≥ threshold.
   * @param {object} data — from HUD update() call
   * @private
   */
  _updateCoMDisplay(data) {
    const comRow = document.getElementById('com-drift-row');
    const comVal = document.getElementById('com-drift-val');
    const comHint = document.getElementById('com-stow-hint');
    const plumeRow = document.getElementById('plume-block-row');

    // CoM drift display — gated by COM_TRACKING flag
    if (Constants.FEATURE_FLAGS.COM_TRACKING && comRow && comVal) {
      comRow.style.display = '';
      const drift = data.comDriftM || 0;
      const threshold = Constants.COM_DRIFT_WARN_THRESHOLD;
      const balanced = Constants.COM_BALANCED_THRESHOLD;
      comVal.textContent = drift.toFixed(3) + ' m';

      // Color coding: green (balanced) → amber (drift) → red (warning)
      if (drift >= threshold) {
        comVal.style.color = 'var(--hud-warning, #ff4444)'; // red
      } else if (drift >= balanced) {
        comVal.style.color = 'var(--hud-caution, #ffaa00)'; // amber
      } else {
        comVal.style.color = 'var(--hud-normal, #00ff88)'; // green
      }

      // Stow suggestion hint
      if (comHint) {
        if (drift >= threshold && data.comSuggestedStowArm !== undefined && data.comSuggestedStowArm !== null) {
          comHint.style.display = '';
          comHint.textContent = `Stow Daughter #${data.comSuggestedStowArm + 1} to rebalance`;
        } else {
          comHint.style.display = 'none';
          comHint.textContent = '';
        }
      }
    } else if (comRow) {
      comRow.style.display = 'none';
    }

    // Plume block indicator — gated by THRUSTER_INTERLOCK flag
    if (Constants.FEATURE_FLAGS.THRUSTER_INTERLOCK && plumeRow) {
      const blocks = data.plumeBlocks || {};
      const hasBlocks = Object.keys(blocks).length > 0;
      plumeRow.style.display = hasBlocks ? '' : 'none';
    } else if (plumeRow) {
      plumeRow.style.display = 'none';
    }
  }

  /**
   * Live body angular-rate readout (rigid-body attitude dynamics). Shown only
   * while the hull is actually turning (|rate| above a small threshold on any
   * axis) so it doesn't add noise when the ship is steady. Color: green while
   * under the rate cap, amber as it approaches the cap.
   * @param {object} data — from HUD update() call; expects data.angularRate
   *   {pitch,yaw,roll} in deg/s (from PlayerSatellite.getAngularRate)
   * @private
   */
  _updateAttitudeRate(data) {
    const row = document.getElementById('att-rate-row');
    const val = document.getElementById('att-rate-val');
    if (!row || !val) return;
    const r = data.angularRate;
    if (!r) { row.style.display = 'none'; return; }

    const maxAbs = Math.max(Math.abs(r.pitch), Math.abs(r.yaw), Math.abs(r.roll));
    const capDeg = radToDeg(Constants.ATTITUDE?.MAX_RATE ?? 0.6); // ~34°/s
    const show = maxAbs > 0.05; // deg/s — hide when effectively steady
    row.style.display = show ? '' : 'none';
    if (!show) return;

    val.textContent = `P ${r.pitch.toFixed(1)}°/s · Y ${r.yaw.toFixed(1)}°/s · R ${r.roll.toFixed(1)}°/s`;
    val.style.color = maxAbs >= capDeg * 0.9 ? 'var(--hud-caution, #ffaa00)' : 'var(--hud-normal, #00ff88)';
  }

  /**
   * Update the MOTHER digest's Net segment (`mother-digest-net`).
   *
   * Reframe: the net is a depleting-magazine gauge — a thin bar (fraction
   * remaining) with the charges count as the hero number, mirroring the score
   * mini-track. The ~2s reload gap pulses the fill + shows a `↻` glyph (the
   * reticle owns the fire moment, so no cooldown ring here). This is the ONE
   * count of the mother's nets (DECISIONS §33 row 10): `n/4`, red at 0, amber at
   * 1, ivory above; brief red flash on a denied fire; the line never dims.
   * Updates stable child nodes (no per-tick innerHTML reparse).
   * @private
   */
  _updateNetDigest() {
    const seg = document.getElementById('mother-digest-net');
    const fill = document.getElementById('mother-digest-net-fill');
    const count = document.getElementById('mother-digest-net-count');
    const reloadGlyph = document.getElementById('mother-digest-net-reload');
    if (!seg || !fill || !count) return;

    const ammo = this._lassoAmmo ?? Constants.CAPTURE_NET.LARGE.MAGAZINE_SIZE;
    const ammoMax = this._lassoAmmoMax ?? Constants.CAPTURE_NET.LARGE.MAGAZINE_SIZE;
    const pct = ammoMax > 0 ? clamp((ammo / ammoMax) * 100, 0, 100) : 0;
    let color = motherNetsColor(ammo);

    // Reload state — resolve the ~2s cooldown window (auto-clear when elapsed).
    let remaining = 0;
    if (this._lassoCooldownActive && this._lassoCooldownDuration > 0) {
      remaining = this._lassoCooldownDuration - (Date.now() - this._lassoCooldownStart) / 1000;
      if (remaining <= 0) { this._lassoCooldownActive = false; remaining = 0; }
    }
    const reloading = this._lassoCooldownActive && remaining > 0;

    // Denied flash (300ms) overrides the tier color with a red pulse.
    const deniedAge = this._lassoDeniedFlash ? (Date.now() - this._lassoDeniedFlash) / 1000 : 999;
    const denied = deniedAge < 0.3;
    if (denied) color = 'var(--hud-warning, #ff4444)';

    fill.style.width = `${pct}%`;
    fill.style.backgroundColor = color;
    count.textContent = `${Math.max(0, ammo)}/${ammoMax}`;   // q3: count / max, like BATTERY 298/600 and the Large Net 4/4
    count.style.color = color;
    this._digestFull = { ...(this._digestFull || {}), net: count.textContent };

    if (reloadGlyph) reloadGlyph.style.display = reloading ? '' : 'none';

    // DECISIONS §33 row 10: no nominal dimming. The mother carries four nets for the whole run, so the line is
    // never the "plenty of charges" case the dark-cockpit dimming was made for (it was > 10 of 50): always full strength.
    this._netNominal = false;
    this._refreshDigestDim();
    this._fitDigest();
  }

  /**
   * Update the MOTHER digest's Large Net segment (`mother-digest-mnet`): the large net's reach and the launcher's
   * STATE (reload countdown, catch held / cooking / berthed, radiator tips). DECISIONS §33 row 10: it carries NO count
   * of its own any more - the mother has one count of nets and it is the NET segment's `n/4`, so the screen never
   * shows two. Hidden until a `source:'mother'` NET_INVENTORY_CHANGED arrives (CAPTURE_NET off => never shown). The
   * segment takes the same colour as the count (red at 0, amber at 1).
   * @private
   */
  _updateMotherPodDigest() {
    const seg = document.getElementById('mother-digest-mnet');
    const sep = document.getElementById('mother-digest-mnet-sep');
    const count = document.getElementById('mother-digest-mnet-count');
    if (!seg || !count) return;

    if (!Array.isArray(this._motherPods)) {
      seg.style.display = 'none';
      if (sep) sep.style.display = 'none';
      this._digestFull = { ...(this._digestFull || {}), mnet: null };
      return;
    }

    const nets = this._motherPods.reduce((a, b) => a + (b || 0), 0);
    const perLauncher = (Constants.CAPTURE_NET && Constants.CAPTURE_NET.LARGE
      && Constants.CAPTURE_NET.LARGE.MAGAZINE_SIZE) || 4;
    const maxNets = Array.isArray(this._motherPodsMax)
      ? this._motherPodsMax.reduce((a, b) => a + (b || 0), 0)
      : perLauncher * this._motherPods.length;

    const color = motherNetsColor(nets);

    seg.style.display = 'inline-flex';
    if (sep) sep.style.display = '';
    count.textContent = '';   // no second count on screen (DECISIONS §33 row 10): only state words below
    count.style.color = color;
    seg.style.color = color;

    // Mother-net-reel plan §4.14/§12: surface the launcher reload cooldown,
    // which previously had NO HUD reader — a cooling launcher looked
    // identical to a ready one until the player pressed N and ate the
    // refusal. Polled from the system (10 Hz update cadence) and appended as
    // ` · Ns` while it is cooling. Deliberately separate from the count so
    // "no ammo" (red 0/max) and "reloading" (amber ·Ns) never conflate.
    const cd = (typeof captureNetSystem?.getCooldown === 'function')
      ? captureNetSystem.getCooldown('pod', 0)
      : 0;
    if (cd > 0) {
      count.textContent = `${Math.ceil(cd)}s`;
      count.style.color = 'var(--hud-caution, #ffaa00)';
    }

    // §8 A2 launcher-state indicator: a mated catch holds the collar station
    // (S13(e): it no longer BLOCKS the launcher as such; a shot refuses only
    // per-shot when it fouls the cargo, which on the axis is every shot).
    // Explicit BERTHED tag — never faked by zeroing the count (which would
    // conflate "no ammo" with "docked").
    const docked = (typeof captureNetSystem?.getDockedCatch === 'function')
      ? captureNetSystem.getDockedCatch() : null;
    // Register item 48: the collar cook is visible — while the mated catch
    // digests (COLLARED), the segment reads the live _digestProgress / span
    // through the system's getter (the getCooldown/getDockedCatch poll
    // precedent). [K] jettison stays valid through the whole cook (the piece
    // keeps its _digestProgress), so the title's hint is honest. The berth
    // tag + title stay byte-identical whenever nothing cooks.
    const collarCook = (typeof captureNetSystem?.getCollarDigestion === 'function')
      ? captureNetSystem.getCollarDigestion() : null;
    // no-melt: with no furnace nothing cooks, so a collared catch reads HELD (no percentage that can never move).
    const cookOn = Constants.isFeatureEnabled('FURNACE_COOK');
    // u3-payoff-calm D4: the HELD / COOK n% / BERTHED words are Details — the simple level (mission 1)
    // keeps the bare `nets/max` count (and the hover title); from mission 2 they show. Nets and reach stay.
    const tagOn = !this._simple;
    if (docked && collarCook && !cookOn) {
      if (tagOn) {
        count.textContent = 'HELD';
        count.style.color = 'var(--hud-info, #66ddff)';
      }
      seg.title = 'Catch held at the collar. It goes to a furnace on the trip to the next field if it fits one — [K] jettison';
    } else if (docked && collarCook) {
      const pct = Math.round(clamp01(collarCook.frac || 0) * 100);
      if (tagOn) {
        count.textContent = `COOK ${pct}%`;
        count.style.color = 'var(--hud-caution, #ff9800)';   // the forge panel's MELT — furnace language
      }
      seg.title = (collarCook.sunScale ?? 1.0) < 1
        ? `Solar furnace cooking the catch — ${pct}% · eclipse: embers until dawn · [K] jettison`
        : `Solar furnace cooking the catch — ${pct}% · [K] jettison`;
    } else if (docked) {
      if (tagOn) {
        count.textContent = 'BERTHED';
        count.style.color = 'var(--hud-info, #66ddff)';
      }
      seg.title = 'Catch mated at the collar — [K] jettison';
    } else {
      seg.title = 'Mother Large Net (whale hunts)';
    }

    // l6-look: catches hanging on the radiator tips (the leash hand-off). Plain words: "Tips 1/2" = one of the two
    // tips is holding a catch; "cooking 40%" while it digests. Nothing is printed while no tip holds one.
    const tipCargo = this._armManager && this._armManager.playerSatellite
      && this._armManager.playerSatellite.tipCargo;
    const tipDigest = tipCargo && typeof tipCargo.digest === 'function' ? tipCargo.digest() : null;
    if (tipDigest && tipDigest.held > 0) {
      let txt = `Tips ${tipDigest.held}/${tipDigest.tips}`;
      if (tipDigest.cookingPct !== null && cookOn) txt += ` · cooking ${tipDigest.cookingPct}%`;
      count.textContent = count.textContent ? `${count.textContent} · ${txt}` : txt;
    }
    this._digestFull = { ...(this._digestFull || {}), mnet: count.textContent };
    this._fitDigest();
  }

  /**
   * q3 round 2 (R2) — the net line never clips. The title row (MOTHER · net line · memo chip) is one line; when the
   * line is wider than the room the chip leaves it, optional parts drop in this order, and come back when room returns:
   *   1 the two reaches  2 the gauge `━`  3 the Large Net tail (reload countdown / BERTHED / COOK % / Tips; the
   *   tooltip and colour keep it)  4 the `/max` suffixes (`NET 50 │ LARGE 4`).
   * The counts, `NET`, `LARGE` and the chip are never hidden. Each change re-checks from the fullest form (level 0),
   * at most once per change: the key is (row width, chip slot width, the two full count texts, shown?).
   * Hidden parts are `data-fit` tokens on `#mother-digest` (index.html has the matching rules).
   */
  _fitDigest(force = false) {
    if (typeof document === 'undefined' || !document || typeof document.getElementById !== 'function') return;
    const digest = document.getElementById('mother-digest');
    const row = digest && digest.parentNode;
    if (!digest || !row) return;
    const slot = row.querySelector ? row.querySelector('.vp-title-slot') : null;
    const full = this._digestFull || {};
    const key = [row.clientWidth, slot ? slot.offsetWidth : 0, full.net, full.mnet, digest.scrollWidth > 0 ? 1 : 0].join('|');
    if (!force && key === this._digestFitKey && this._digestFitLevel !== undefined) {
      this._applyDigestFit(this._digestFitLevel);   // the updater just rewrote the full texts: put the level back
      return;
    }
    const tooWide = () => row.scrollWidth > row.clientWidth || digest.scrollWidth > digest.clientWidth;
    let level = 0;
    for (; level <= StatusPanel.DIGEST_FIT_STEPS.length - 1; level++) {
      this._applyDigestFit(level);
      if (!tooWide()) break;
    }
    if (level >= StatusPanel.DIGEST_FIT_STEPS.length) level = StatusPanel.DIGEST_FIT_STEPS.length - 1;
    this._digestFitLevel = level;
    this._digestFitKey = [row.clientWidth, slot ? slot.offsetWidth : 0, full.net, full.mnet, digest.scrollWidth > 0 ? 1 : 0].join('|');
  }

  /** @private Show the digest at fit `level` (0 = fullest): the hidden-part tokens and the shortened count texts. */
  _applyDigestFit(level) {
    const digest = document.getElementById('mother-digest');
    if (!digest) return;
    const hidden = StatusPanel.DIGEST_FIT_STEPS[clamp(StatusPanel.DIGEST_FIT_STEPS.length - 1, 0, level)];
    const tokens = hidden.join(' ');
    if (typeof digest.setAttribute === 'function') digest.setAttribute('data-fit', tokens);
    else if (digest.dataset) digest.dataset.fit = tokens;
    const full = this._digestFull || {};
    const short = (text) => {
      if (typeof text !== 'string') return text;
      const m = /^(\d+)\/(\d+)/.exec(text);
      if (!m) return text;
      if (hidden.includes('max')) return m[1];
      if (hidden.includes('tail')) return `${m[1]}/${m[2]}`;
      return text;
    };
    for (const [id, text] of [['mother-digest-net-count', full.net], ['mother-digest-mnet-count', full.mnet]]) {
      if (typeof text !== 'string') continue;
      const el = document.getElementById(id);
      const next = short(text);
      if (el && el.textContent !== next) el.textContent = next;
    }
  }

  /** Clean up DOM elements appended outside the HUD container. */
  dispose() {
    // Body-mounted priority panels (objective) are appended to document.body
    // by _createTopPanel, so they are not torn down with the HUD container —
    // remove them explicitly to avoid orphaned duplicate-id nodes.
    if (this._fitObserver) { this._fitObserver.disconnect(); this._fitObserver = null; }   // q3 round 3 (S5)
    if (this._unwatchArmsShort) { this._unwatchArmsShort(); this._unwatchArmsShort = null; }   // u4 review fix 8
    if (this._unsubHudScale) { this._unsubHudScale(); this._unsubHudScale = null; }   // u9-big-text
    this.clearPayoff();
    for (const p of [this.panels.score]) {
      if (p && p.parentNode) p.parentNode.removeChild(p);
    }
  }

  // ==========================================================================
  // PRIVATE UPDATERS
  // ==========================================================================

  // ==========================================================================
  // PAYOFF LINE (u3-payoff-calm D1 + D2)
  // ==========================================================================

  /** Seconds-in-ms the payoff line stays after a credited catch. */
  static get PAYOFF_MS() { return 3000; }

  /** @private Listen for the catch's SCORE_UPDATE, the salvage detail and the clear events. */
  _bindPayoff() {
    eventBus.on(Events.SCORE_UPDATE, (d) => { if (!this.addPayoffBonus(d)) this.showPayoff(d); });
    eventBus.on(Events.SALVAGE_REVEAL, (d) => this.showPayoffMaterials(d));
    eventBus.on(Events.GAME_RESET, () => this.clearPayoff());
    if (Events.GAME_WIN) eventBus.on(Events.GAME_WIN, () => this.clearPayoff());
    eventBus.on(Events.GAME_STATE_CHANGE, (d) => {
      const to = d && d.to;
      if (to === GameStates.GAME_OVER || to === GameStates.WIN) this.clearPayoff();
    });
  }

  /**
   * The payoff line in two parts: `name` (`Caught a rocket body · 4,232 kg`) and `cr` (`+1,250 cr`).
   * kg: 0.1-99.9 one decimal, under 0.1 two decimals, 100 and over whole kg with a thousands separator.
   * Numbers use `toLocaleString()` like the strip's credits.
   * A scoop bag (`bagId`, `bagCount`, `bagMassKg` on the payload): `Caught a bag of 12 pieces · 2.66 kg`.
   * @param {{debrisType?: string|null, massKg?: number, creditsDelta?: number, bagId?: *, bagCount?: number, bagMassKg?: number}} d
   * @returns {{name: string, cr: string}}
   */
  static payoffParts(d) {
    const bag = !!(d && d.bagId != null && Number(d.bagCount) > 0);
    const name = shortTypeName(d && d.debrisType).toLowerCase();
    const article = (d && d.debrisType && name !== 'debris') ? 'a ' : '';
    // u23 B1: a scoop bag reads as one catch: `Caught a bag of 12 pieces · 2.66 kg · +520 cr` (the bag's total mass)
    const parts = [bag ? `Caught a bag of ${Math.round(Number(d.bagCount))} ${Number(d.bagCount) === 1 ? 'piece' : 'pieces'}` : `Caught ${article}${name}`];
    const kg = Number(bag ? d.bagMassKg : d && d.massKg);
    if (Number.isFinite(kg) && kg > 0) {
      // a bag's total is read to two decimals under 10 kg (a bag of 12 small pieces: 2.66 kg, not 2.7)
      const twoDp = kg < 0.1 || (bag && kg < 10);
      parts.push(kg >= 100 ? `${Math.round(kg).toLocaleString()} kg` : `${twoDp ? kg.toFixed(2) : kg.toFixed(1)} kg`);
    }
    const cr = Number.isFinite(Number(d && d.creditsDelta)) ? Math.round(Number(d.creditsDelta)) : 0;
    return { name: parts.join(' \u00b7 '), cr: `+${cr.toLocaleString()} cr` };
  }

  /**
   * The payoff text for one credited catch: `Caught a fragment · 4.0 kg · +508 cr`.
   * @param {{debrisType?: string|null, massKg?: number, creditsDelta?: number}} d
   * @returns {string}
   */
  static payoffText(d) {
    const { name, cr } = StatusPanel.payoffParts(d);
    return `${name} \u00b7 ${cr}`;
  }

  /** @private Write the shown payoff data into the line's name / separator / credits spans. */
  _paintPayoff() {
    const { name, cr } = StatusPanel.payoffParts(this._payoffData);
    this._payoffNameEl.textContent = name;
    this._payoffCrEl.textContent = cr;
  }

  /** @private The payoff element, created under the strip on first use. */
  _ensurePayoff() {
    if (this._payoffEl && this._payoffEl.parentNode) return this._payoffEl;
    const strip = this.panels.score;
    if (!strip) return null;
    const el = document.createElement('div');
    el.id = 'hud-payoff';
    el.setAttribute('role', 'status');
    el.style.cssText = 'position:absolute;top:100%;left:50%;transform:translateX(-50%);margin-top:4px;'
      + 'max-width:300px;text-align:center;pointer-events:none;display:none;'
      + 'color:var(--hud-text, #e8f0e8);text-shadow:0 0 4px rgb(var(--hud-ink-rgb, 0 0 0) / 0.95), 0 1px 2px rgb(var(--hud-ink-rgb, 0 0 0) / 0.95);';
    // The line is a flex row: the name part may shorten (ellipsis), the credits never do (a big catch keeps its payoff).
    const line = document.createElement('div');
    line.className = 'payoff-line';
    line.style.cssText = 'display:flex;justify-content:center;align-items:baseline;font-size:12px;white-space:nowrap;font-variant-numeric:tabular-nums;';
    const nameEl = document.createElement('span');
    nameEl.className = 'payoff-name';
    nameEl.style.cssText = 'flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;';
    const sepEl = document.createElement('span');
    sepEl.className = 'payoff-sep';
    sepEl.style.cssText = 'flex:none;white-space:pre;';
    sepEl.textContent = ' \u00b7 ';
    const crEl = document.createElement('span');
    crEl.className = 'payoff-cr';
    crEl.style.cssText = 'flex:none;white-space:nowrap;';
    line.appendChild(nameEl);
    line.appendChild(sepEl);
    line.appendChild(crEl);
    const mat = document.createElement('div');
    mat.className = 'payoff-materials';
    mat.style.cssText = 'font-size:10px;opacity:0.75;margin-top:2px;display:none;';
    el.appendChild(line);
    el.appendChild(mat);
    strip.appendChild(el);
    this._payoffEl = el;
    this._payoffLineEl = line;
    this._payoffNameEl = nameEl;
    this._payoffCrEl = crEl;
    this._payoffMatEl = mat;
    return el;
  }

  /**
   * Show the payoff line for a credited catch (SCORE_UPDATE with kind === 'catch').
   * A new catch replaces the line and restarts its 3 s.
   * @param {object} d  the SCORE_UPDATE payload
   */
  showPayoff(d) {
    if (!d || d.kind !== 'catch') return;
    const el = this._ensurePayoff();
    if (!el) return;
    // u23 B1: a scoop bag pays one award per member, each its own SCORE_UPDATE in the same frame. Members of one bag
    // (same `bagId`) join ONE line: the credits add up, the line names the bag (count, total mass).
    const prev = this._payoffData;
    const shownNow = prev && this._payoffEl && this._payoffEl.style.display !== 'none';
    const joinsBag = d.bagId != null && shownNow && prev.bagId === d.bagId;
    this._payoffData = { ...d };
    if (joinsBag) this._payoffData.creditsDelta = (Number(prev.creditsDelta) || 0) + (Number(d.creditsDelta) || 0);
    // A bonus released with this catch can come BEFORE its SCORE_UPDATE (a daughter's first dock emits DEBRIS_CAPTURED, then
    // CATCH_PROCESSED; a lasso emits ARM_CAPTURED, then the award): it waits here, same frame, and joins the line.
    if (this._payoffPending > 0) {
      this._payoffData.creditsDelta = (Number(this._payoffData.creditsDelta) || 0) + this._payoffPending;
      this._payoffPending = 0;
    }
    this._openPayoffFrame();
    this._payoffCatchInFrame = true;
    this._paintPayoff();
    this._payoffMatEl.textContent = '';
    this._payoffMatEl.style.display = 'none';
    this._payoffMats = null;         // u23 BF2: the materials sum starts again with the new line (a bag's reveals follow all its awards)
    el.style.display = 'block';
    if (this._payoffTimer != null) timerManager.clear(this._payoffTimer);
    this._payoffTimer = timerManager.setTimeout(() => this.clearPayoff(), StatusPanel.PAYOFF_MS, { owner: this });
  }

  /** @private The "same frame" window: open from the first catch / bonus event to the end of the current task (a microtask). */
  _openPayoffFrame() {
    if (this._payoffFrame) return;
    this._payoffFrame = true;
    queueMicrotask(() => { this._payoffFrame = false; this._payoffCatchInFrame = false; this._payoffPending = 0; });
  }

  /**
   * A credit released WITH the catch (the survey bounty deferred during onboarding is released on the first dock's
   * DEBRIS_CAPTURED; a synergy or field-clear award at the capture) is part of the same payoff: the line adds it, so
   * `+N cr` equals the strip's credit jump. Identified by the payload (`kind: 'catch-bonus'`, set by ScoringSystem from the
   * award's `withCatch`), not by timing; "with the catch" means the same frame (JS task), whichever event comes first:
   * after the catch's line it is added to it (a bonus from ANOTHER arm in the same frame joins the line the same way);
   * before it, it waits (`_payoffPending`) for the catch of the same frame and is dropped at the frame's end if none
   * comes (a bonus at the grab, seconds before the park, is the strip's own jump).
   * @param {object} d  a SCORE_UPDATE payload
   * @returns {boolean} true when it was taken as a catch bonus
   */
  addPayoffBonus(d) {
    if (!d || d.kind !== 'catch-bonus' || !(Number(d.delta) > 0)) return false;
    this._openPayoffFrame();
    const shownNow = this._payoffData && this._payoffEl && this._payoffEl.style.display !== 'none';
    if (shownNow && this._payoffCatchInFrame) {
      this._payoffData.creditsDelta = (Number(this._payoffData.creditsDelta) || 0) + Number(d.delta);
      this._paintPayoff();
    } else {
      this._payoffPending += Number(d.delta);
    }
    return true;
  }

  /**
   * D2: above the simple level the SALVAGE_REVEAL that follows the catch adds a
   * smaller materials line under the payoff line. At the simple level: nothing.
   * @param {{metals?: Array<{name?: string, subtype?: string, amount?: number, massKg?: number}>}} d
   */
  showPayoffMaterials(d) {
    if (this._simple) return;
    const el = this._payoffEl;
    if (!el || el.style.display === 'none') return;
    const metals = (d && d.metals) || [];
    if (metals.length === 0) return;
    // u23 BF2: a scoop bag reveals once per member (same `bagId`): the line adds them up, so it shows the whole bag's metals (in the order
    // first seen). A solo catch (no bagId) shows its own, as before.
    const bagId = d && d.bagId != null ? d.bagId : null;
    const one = (m) => [m.name || m.subtype || 'Unknown', Number(m.amount != null ? m.amount : m.massKg) || 0];
    let rows;
    if (bagId == null) {
      this._payoffMats = null;
      rows = metals.map(one);
    } else {
      if (!this._payoffMats || this._payoffMats.bagId !== bagId) this._payoffMats = { bagId, sums: new Map() };
      const sums = this._payoffMats.sums;
      for (const m of metals) { const [name, amt] = one(m); sums.set(name, (sums.get(name) || 0) + amt); }
      rows = [...sums];
    }
    const text = rows.map(([name, amt]) => `${name} ${amt.toFixed(1)}`).join(' \u00b7 ') + ' kg';
    this._payoffMatEl.textContent = text;
    this._payoffMatEl.style.display = 'block';
  }

  /** Hide the payoff line now (timer end, GAME_RESET, GAME_WIN, game over). */
  clearPayoff() {
    if (this._payoffTimer != null) { timerManager.clear(this._payoffTimer); this._payoffTimer = null; }
    // u4-phone-fold D8: a cleared line forgets the same-frame state too (a bonus waiting for a catch, a catch in frame).
    this._payoffPending = 0;
    this._payoffCatchInFrame = false;
    if (this._payoffEl) {
      this._payoffEl.style.display = 'none';
      this._payoffData = null;
      this._payoffMats = null;
      this._payoffNameEl.textContent = '';
      this._payoffCrEl.textContent = '';
      this._payoffMatEl.textContent = '';
      this._payoffMatEl.style.display = 'none';
    }
  }

  /** @private */
  _updateScorePanel(data) {
    const clearedEl = document.getElementById('hud-cleared');
    const fillEl = document.getElementById('hud-cleared-fill');
    const creditsEl = document.getElementById('hud-credits');

    if (clearedEl) clearedEl.textContent = data.debrisCleared;
    if (fillEl) {
      const pct = Math.min(100, (data.debrisCleared / Constants.WIN_DEBRIS_COUNT) * 100);
      fillEl.style.width = `${pct}%`;
    }
    if (creditsEl) {
      creditsEl.textContent = data.credits.toLocaleString();

      // Credit flash — bright yellow pulse when credits increase
      if (this._lastCredits !== undefined && data.credits > this._lastCredits) {
        creditsEl.style.transition = 'none';
        creditsEl.style.color = 'var(--hud-caution, #ffff00)';
        creditsEl.style.textShadow = '0 0 10px var(--hud-caution, #ffaa00)';
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            creditsEl.style.transition = 'color 0.8s ease-out, text-shadow 0.8s ease-out';
            creditsEl.style.color = '';
            creditsEl.style.textShadow = '';
          });
        });
      }
      this._lastCredits = data.credits;
    }
  }

  /** @private */
  _updateResourceBars(resources) {
    // h1-mother-pane D3: the Xenon / Gas / Bat bars and the SUN line left this detail — the merged
    // pane's meters (VitalsPane) are the one place those readings live. What stays: the MPD-armed
    // purple tint (now on the BATTERY row's bar fill), the lithium row and the `_lastResources` cache.
    const batteryMax = resources.batteryMax || Constants.BATTERY_MAX;

    // S3b: MPD armed -> the battery bar fill goes purple (amber blink under 15 %)
    if (this._vitals && typeof this._vitals.setMpdTint === 'function') {
      if (this._mpdArmed) {
        const batteryFrac = batteryMax > 0 ? resources.battery / batteryMax : 1;
        this._vitals.setMpdTint(batteryFrac < 0.15 && (Date.now() % 500 < 250) ? 'amber' : 'armed');
      } else {
        this._vitals.setMpdTint('');
      }
    }

    // F16: Lithium bar (only visible when MPD is unlocked)
    if (this._mpdUnlocked) {
      const lithiumMax = resources.lithiumMax || Constants.MPD_LITHIUM_CAPACITY || 100;
      const lithiumPct = lithiumMax > 0 ? (resources.lithium / lithiumMax) * 100 : 0;
      const lithiumRow = document.getElementById('mpd-lithium-row');
      if (lithiumRow) lithiumRow.style.display = '';
      this._setLithiumBar(lithiumPct, resources.lithium, lithiumMax);
    }

    // Cache for cross-method access (used by _updateDeltaVBar for DELTAV_UPDATE payload)
    this._lastResources = resources;
  }

  /**
   * @private Update fuel type indicator from FUEL_CHANGED event data. The name and colour come
   * from the event; the number is the mass budget's `isp` (the one the ΔV maths uses), read in
   * `_paintFuelLine` — the event's own `isp` is only the fallback before the budget is ready.
   * @param {object} fuelData - { name, isp, color }
   */
  _updateFuelIndicator(fuelData) {
    if (fuelData) {
      if (typeof fuelData.name === 'string' && fuelData.name) this._fuelName = fuelData.name;
      if (Number.isFinite(fuelData.isp)) this._fuelIsp = fuelData.isp;
      this._fuelColor = fuelData.color || null;
    }
    this._paintFuelLine(null);
    const el = document.getElementById('fuel-type-indicator');
    if (el && fuelData) el.style.color = fuelData.color || 'var(--hud-info, #4fc3f7)';
  }

  /** @private The loaded fuel's display name (the last FUEL_CHANGED, else the default fuel's). */
  _currentFuelName() {
    if (this._fuelName) return this._fuelName;
    const f = Constants.FUELS && Constants.FUELS[Constants.DEFAULT_FUEL];
    return (f && f.name) || '—';
  }

  /**
   * @private The hover detail's fuel line: `Xenon · 1500 s` — the fuel's name and the mass
   * budget's `isp`, in whole seconds (h4b D6; write-on-change). No constants here: with no budget the event's isp is used.
   * @param {object|null} mb the mass budget, if the caller has it
   */
  _paintFuelLine(mb) {
    const el = document.getElementById('fuel-type-indicator');
    if (!el) return;
    const isp = mb && Number.isFinite(mb.isp) ? mb.isp : this._fuelIsp;
    const text = Number.isFinite(isp) ? `${this._currentFuelName()} · Isp ${Math.round(isp)} s` : this._currentFuelName();
    if (el.textContent !== text) el.textContent = text;
  }

  /** @private The power in / out line of the hover detail (VitalsPane owns the text; write-on-change). */
  _paintPowerFlow() {
    const el = document.getElementById('mother-power-flow');
    if (!el) return;
    const t = this._vitals && typeof this._vitals.flowText === 'function' ? this._vitals.flowText() : '';
    if (el.textContent !== t) el.textContent = t;
  }

  /**
   * @private F16: Set lithium bar fill and value.
   * Uses silver/light-blue color (#88ccff) for lithium.
   * @param {number} pct - Lithium percentage (0-100)
   * @param {number} current - Current lithium amount
   * @param {number} max - Max lithium capacity
   */
  _setLithiumBar(pct, current, max) {
    const bar = document.getElementById('hud-bar-lithium');
    const val = document.getElementById('hud-val-lithium');
    if (bar) {
      bar.style.width = `${clamp(pct, 0, 100)}%`;
      // Color: silver-blue at normal, amber at low, red at critical
      if (pct > 30) bar.style.backgroundColor = 'var(--hud-info, #88ccff)';
      else if (pct > 15) bar.style.backgroundColor = 'var(--hud-caution, #ffaa00)';
      else bar.style.backgroundColor = 'var(--hud-warning, #ff4444)';
    }
    if (val) val.textContent = `${Math.round(current)}/${max}`;
  }

  /**
   * @private F16: Update cathode health display.
   * @param {number} cathodeTime - seconds of MPD operation
   * @param {number} cathodeHealth - 0.0 to 1.0 health fraction
   */
  _updateCathodeDisplay(cathodeTime, cathodeHealth, cathodeLife) {
    const healthEl = document.getElementById('hud-cathode-health');
    const timeEl = document.getElementById('hud-cathode-time');
    cathodeLife = cathodeLife || Constants.MPD_CATHODE_LIFE || 600;

    if (healthEl) {
      const healthPct = Math.round((cathodeHealth ?? 1) * 100);
      healthEl.textContent = `${healthPct}%`;
      // Color by health
      if (healthPct > 50) healthEl.style.color = 'var(--hud-info, #88ccff)';
      else if (healthPct > 0) healthEl.style.color = 'var(--hud-caution, #ffaa00)';
      else healthEl.style.color = 'var(--hud-warning, #ff4444)';
    }
    if (timeEl) {
      timeEl.textContent = `(${Math.round(cathodeTime)}s/${cathodeLife}s)`;
    }
  }

  /**
   * S3b: Update MPD burst mode HUD display.
   * Shows armed indicator, heat bar, cooldown timer, and battery tint.
   * @private
   */
  _updateMPDBurstDisplay() {
    const burstRow = document.getElementById('mpd-burst-row');
    if (!burstRow) return;

    const t = this._mpdTelemetry || {};
    const armed = this._mpdArmed;
    const heat = t.mpdHeat || 0;
    const heatFraction = t.mpdHeatFraction || 0;
    const cooldown = t.mpdCooldownRemaining || 0;
    const degraded = t.mpdDegraded || false;

    // Show burst row when MPD is unlocked and (armed OR heat > 0 OR cooling down)
    if (this._mpdUnlocked && (armed || heat > 0 || cooldown > 0)) {
      burstRow.style.display = '';
    } else {
      burstRow.style.display = 'none';
    }

    // Update status label
    const statusEl = document.getElementById('mpd-burst-status');
    const labelEl = document.getElementById('mpd-burst-label');
    if (statusEl) {
      if (cooldown > 0) {
        statusEl.textContent = `COOLING ${Math.ceil(cooldown)}s`;
        statusEl.style.color = 'var(--hud-warning, #ff6600)';
      } else if (armed && degraded) {
        statusEl.textContent = 'DEGRADED';
        statusEl.style.color = 'var(--hud-caution, #ffaa00)';
      } else if (armed) {
        statusEl.textContent = 'ARMED';
        statusEl.style.color = 'var(--hud-target, #ff44ff)';
        // Calm-HUD: steady — the magenta ARMED label already carries the state
        // (the old per-frame opacity strobe was the same class of infinite DOM
        // blink the Phase 1 pass removed from the CSS layer).
        statusEl.style.opacity = 1;
      } else {
        statusEl.textContent = 'STANDBY';
        statusEl.style.color = 'var(--hud-dim, #888)';
        statusEl.style.opacity = 1;
      }
    }
    if (labelEl) {
      labelEl.style.color = armed ? 'var(--hud-target, #ff44ff)' : (cooldown > 0 ? 'var(--hud-warning, #ff6600)' : 'var(--hud-dim, #888)');
    }

    // Update heat bar
    const heatBar = document.getElementById('mpd-heat-bar');
    const heatVal = document.getElementById('mpd-heat-val');
    if (heatBar) {
      const pct = Math.min(100, heatFraction * 100);
      heatBar.style.width = `${pct}%`;
      // Color by heat level: green → amber → red
      if (pct < 50) heatBar.style.background = 'var(--hud-normal, #44ff44)';
      else if (pct < 80) heatBar.style.background = 'var(--hud-caution, #ffaa00)';
      else heatBar.style.background = 'var(--hud-warning, #ff4444)';
    }
    if (heatVal) {
      heatVal.textContent = `${Math.round(heatFraction * 100)}%`;
    }

    // Note: Battery bar purple tint is applied in _updateResourceBars() which runs every frame
    // (avoids being overwritten by _setBar's default coloring)
  }

  /**
   * @private F14: Update throttle gauge bar and label.
   */
  _updateThrottleGauge() {
    const fill = document.getElementById('throttle-bar-fill');
    const val = document.getElementById('throttle-val');
    if (!fill || !val) return;

    const pct = Math.round(this._throttleLevel * 100);

    // Dark-cockpit (#6): full throttle is the default, so the gauge is just
    // visual filler at 100%. Hide the whole row unless the pilot has actually
    // throttled down — then it reappears to show exactly how far.
    const gauge = document.getElementById('throttle-gauge');
    if (gauge) gauge.style.display = pct >= 100 ? 'none' : 'flex';

    fill.style.width = `${pct}%`;
    val.textContent = `${pct}%`;

    // Color: green at high, amber at mid, red at zero
    if (pct > 50) {
      fill.style.backgroundColor = 'var(--hud-normal, #00ff88)';
      val.style.color = 'var(--hud-normal, #00ff88)';
    } else if (pct > 0) {
      fill.style.backgroundColor = 'var(--hud-caution, #ffaa00)';
      val.style.color = 'var(--hud-caution, #ffaa00)';
    } else {
      fill.style.backgroundColor = 'var(--hud-warning, #ff4444)';
      val.style.color = 'var(--hud-warning, #ff4444)';
    }
  }

  /**
   * Poll-driven setter for the current autopilot phase. Called by
   * [`HUD.update()`](js/ui/HUD.js:1) from the per-frame game loop. No-op when
   * the phase has not changed — avoids DOM thrash.
   * @param {'OFF'|'RENDEZVOUS_FAR'|'MATCH_ORBIT'|'TRAIL_ALIGN'|'HOLD'} phase
   */
  setAutopilotPhase(phase) {
    if (phase === this._autopilotPhase) return;
    this._autopilotPhase = phase || 'OFF';
    this._updateAutopilotIndicator();
  }

  /**
   * @private F15: Update autopilot indicator color and text.
   * Engaged-state chip format: `[Autopilot: <mode> · <phase>]` (e.g. `[Autopilot: TARGET · ALIGN]`).
   * Phase segment is hidden when the AP is OFF.
   */
  _updateAutopilotIndicator() {
    // Session Q (plan D12b): with the memo slot the chip is the MOTHER header's
    // steady token list — a different renderer, the same two state fields.
    if (this._memoSlot) { this._renderMemo(); return; }
    const el = document.getElementById('autopilot-indicator');
    const phaseLabel = _PHASE_LABELS[this._autopilotPhase] || '';

    if (this._autopilotMode === 'OFF') {
      if (el) {
        el.textContent = '[Autopilot: OFF]';
        el.style.color = 'var(--hud-dim, #555)';
        el.style.borderColor = 'rgb(var(--hud-text-rgb, 255 255 255) / 0.1)';
        el.style.background = 'rgb(var(--hud-ink-rgb, 0 0 0) / 0.4)';
      }
    } else {
      const fullLabel = phaseLabel
        ? `[Autopilot: ${this._autopilotMode} · ${phaseLabel}]`
        : `[Autopilot: ${this._autopilotMode}]`;
      if (el) {
        el.textContent = fullLabel;
        el.style.color = 'var(--hud-normal, #00ff88)';
        el.style.borderColor = 'rgb(var(--hud-normal-rgb, 0 255 136) / 0.5)';
        el.style.background = 'rgb(var(--hud-normal-rgb, 0 255 136) / 0.08)';
      }
    }
  }

  // ==========================================================================
  // THE MEMO SLOT (Session Q, plan D12b)
  // ==========================================================================

  /** @private The slot element, resolved once (null headless / before build). */
  _memoElement() {
    if (this._memoEl) return this._memoEl;
    if (typeof document === 'undefined' || !document || typeof document.getElementById !== 'function') return null;
    const el = document.getElementById('autopilot-indicator');
    if (el) this._memoEl = el;
    return el;
  }

  /**
   * @private Write the MEMO tokens for the cached AP mode / phase — text on
   * change only; a change to a NON-EMPTY string stamps the A4 box window.
   */
  _renderMemo() {
    const text = memoTokens(this._autopilotMode, this._autopilotPhase).join(MEMO_SEP);
    if (text === this._memoText) return;
    this._memoText = text;
    if (text !== '') this._memoBoxedUntil = this._now() + RAIL_GEOMETRY.BOX_MS;
    const el = this._memoElement();
    if (el) el.textContent = text;
    this._fitDigest();   // q3 round 2: the chip's width changed the room for the net line
  }

  /**
   * Per frame (HUD.update): paint the box while the window is open —
   * write-on-change, a local timestamp, no timer. No-op without the slot.
   * @param {number} [nowMs]
   */
  tickMemo(nowMs) {
    if (!this._memoSlot) return;
    const now = (typeof nowMs === 'number' && Number.isFinite(nowMs)) ? nowMs : this._now();
    const boxed = now < this._memoBoxedUntil;
    if (boxed === this._memoBoxedPainted) return;
    const el = this._memoElement();
    if (!el) return;                      // keep the painted state until an element exists
    el.style.outline = boxed ? BOX_OUTLINE : 'none';
    el.style.outlineOffset = boxed ? BOX_OUTLINE_OFFSET : '0px';
    this._memoBoxedPainted = boxed;
  }

  /** @returns {string} the slot's current text ('' = the AP is off / no slot) */
  memoText() { return this._memoText; }

  /**
   * @param {number} [nowMs]
   * @returns {boolean} whether the A4 box window is open at `nowMs`
   */
  memoBoxed(nowMs) {
    const now = (typeof nowMs === 'number' && Number.isFinite(nowMs)) ? nowMs : this._now();
    return this._memoSlot && now < this._memoBoxedUntil;
  }

  /** @private Inject CSS for power bus selection pulse */
  _injectPowerPulseStyle() {
    if (!document.getElementById('power-pulse-style')) {
      const style = document.createElement('style');
      style.id = 'power-pulse-style';
      style.textContent = `
        .hud-power-row[data-selected="true"] {
          background: rgb(var(--hud-normal-rgb, 0 255 136) / 0.08);
          border-left: 2px solid var(--hud-normal, #00ff88);
          padding-left: 2px;
        }
        .hud-power-row[data-selected="false"] {
          border-left: 2px solid transparent;
          padding-left: 2px;
        }
      `;
      document.head.appendChild(style);
    }
  }

  /** @private Inject CSS for the MOTHER readiness-digest gauges (count + mini-bars). */
  _injectMotherDigestStyle() {
    if (document.getElementById('mother-digest-style')) return;
    const style = document.createElement('style');
    style.id = 'mother-digest-style';
    style.textContent = `
      #mother-digest .md-label {
        opacity: 0.55;
        font-weight: bold;
        letter-spacing: 0.06em;
      }
      #mother-digest .md-sep { opacity: 0.25; }
      /* q3 round 3 (S4): the divider between the two nets reads like the PROPULSION row's: label colour, 0.35 */
      #mother-digest > .md-sep { color: var(--hud-label, #9fb0c0); opacity: 0.35; }
      #mother-digest .md-track {
        width: 38px;
        height: 3px;
        border-radius: 2px;
        overflow: hidden;
        display: inline-block;
        background: rgb(var(--hud-text-rgb, 255 255 255) / 0.12);
      }
      #mother-digest .md-fill {
        display: block;
        height: 100%;
        width: 100%;
        border-radius: 2px;
        transition: width 0.3s ease, background-color 0.3s ease;
      }
      #mother-digest .md-count {
        font-weight: bold;
        min-width: 16px;
        text-align: right;
      }
      #mother-digest-net-reload { opacity: 0.8; }
      /* q3-mother-pane: the digest sits on MOTHER's title row (attachToVitals moves it there),
       * beside the memo chip. Each net names its own count and reach: NET ━ 50/50 · 90 m │ LARGE 4/4 · 100 m.
       * Title styles (wide letter-spacing, bold, glow) are reset for the digest; the reaches drop out on
       * narrow panes by a CSS rule in index.html (they stay in the tooltips); under any other pressure
       * the line shrinks from its right end rather than overlapping MOTHER or the chip. */
      #mother-digest { line-height: 16px; letter-spacing: 0.015em; font-weight: 400; text-shadow: none; text-transform: none; }   /* S2: units read 90 m and ·8s, not the title capitals */
      #mother-digest > * { flex-shrink: 0; }
      #mother-digest .md-seg { min-width: min-content; }
      #mother-digest .md-core { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; }
      #mother-digest .md-reach-group { display: inline-flex; align-items: center; gap: 3px; flex: 0 0 auto; }
      #mother-digest .md-reach { opacity: 0.7; }
    `;
    document.head.appendChild(style);
  }

  /**
   * @private Inject CSS for the FLEET pane's tap buttons (Session J, D-I).
   * Styled like the pane's existing chrome: small mono caps, SELECTION blue
   * (the selected-row colour) hairline border, quiet until hovered / pressed.
   * `.fleet-row` rows show a pointer only where a tap does something.
   */
  _injectFleetButtonStyle() {
    if (typeof document === 'undefined' || !document.head) return;
    if (document.getElementById('fleet-button-style')) return;
    const style = document.createElement('style');
    style.id = 'fleet-button-style';
    style.textContent = `
      #hud-arms-status .fleet-btn {
        font: bold 11px/1.2 var(--font-mono);
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--hud-info, ${VisualLaw.COLORS.SELECTION});
        background: rgb(var(--hud-info-rgb, 68 136 255) / 0.08);
        border: 1px solid rgb(var(--hud-info-rgb, 68 136 255) / 0.55);
        border-radius: 3px;
        padding: 3px 10px;
        margin: 0 6px 0 0;
        min-height: 18px;
        cursor: pointer;
        pointer-events: auto;
        touch-action: manipulation;
        -webkit-tap-highlight-color: transparent;
        user-select: none;
        vertical-align: middle;
        transition: background 0.15s ease, border-color 0.15s ease;
      }
      /* Glass: 44 px HIT boxes (Apple HIG / RAIL_GEOMETRY.TOUCH_PITCH_PX). Visual
         padding stays the desktop values; the hit box is the min-height. */
      #hud-arms-panel[data-glass] .fleet-row {
        min-height: ${RAIL_GEOMETRY.TOUCH_PITCH_PX}px;
        box-sizing: border-box;
      }
      #hud-arms-panel[data-glass] .fleet-btn {
        min-height: ${RAIL_GEOMETRY.TOUCH_PITCH_PX}px;
        min-width: ${RAIL_GEOMETRY.TOUCH_PITCH_PX}px;
        box-sizing: border-box;
      }
      #hud-arms-status .fleet-btn:hover {
        background: rgb(var(--hud-info-rgb, 68 136 255) / 0.18);
        border-color: var(--hud-info, ${VisualLaw.COLORS.SELECTION});
      }
      #hud-arms-status .fleet-btn:active {
        background: rgb(var(--hud-info-rgb, 68 136 255) / 0.35);
        color: var(--hud-label, ${VisualLaw.COLORS.LABEL});
      }
      #hud-arms-status .fleet-btn:focus { outline: none; }
      #hud-arms-status .fleet-row-tap:hover {
        background: rgb(var(--hud-info-rgb, 68 136 255) / 0.05);
      }
    `;
    document.head.appendChild(style);
  }

  /** @private Inject CSS for power panel collapse/expand (B5) */
  _injectPowerCollapseStyle() {
    if (document.getElementById('power-collapse-style')) return;
    const style = document.createElement('style');
    style.id = 'power-collapse-style';
    style.textContent = `
      #hud-power-panel.power-collapsed .power-label {
        display: none;
      }
      #hud-power-panel.power-collapsed .power-value {
        display: none;
      }
      #hud-power-panel.power-collapsed .hud-power-row {
        margin: 0 !important;
      }
      #hud-power-panel.power-collapsed #hud-power-bars {
        line-height: 1;
        max-height: 46px;
      }
      #hud-power-panel.power-collapsed .energy-hint {
        display: none;
      }
      #hud-power-panel.power-collapsed .hud-power-row > div {
        gap: 2px !important;
      }
      #hud-power-panel:not(.power-collapsed) #hud-power-bars {
        max-height: 200px;
      }
      #hud-power-panel:not(.power-collapsed) .energy-hint {
        opacity: 0.4 !important;
      }
      #hud-power-panel.power-collapsed #power-collapse-indicator {
        transform: rotate(0deg);
      }
      #hud-power-panel:not(.power-collapsed) #power-collapse-indicator {
        transform: rotate(90deg);
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * @private MOTHER disclosure — react to a chrome step change.
   * 'normal' = pinned open (detail always visible); 'min' = compact (detail
   * hidden unless hovered). Keeps the energy block's `power-collapsed` class in
   * sync so the energy bars expand/collapse with the rest of the detail.
   */
  _onMotherStep(name) {
    this._motherPinned = (name === 'normal');
    if (this._motherPinned) {
      this._expandMother();
    } else {
      // Un-pinning: collapse the detail — but NOT while the pointer is still over
      // the pane. CSS `:hover` would keep `.mother-detail` open while
      // `power-collapsed` hid the energy-bar labels, stranding unlabeled bars
      // until the next mouseenter. The mouseleave handler will collapse it.
      if (this._motherHovering) return;
      this._collapseMother();
    }
  }

  /**
   * @private Glass: TAP on the Mother header toggles .mother-expanded (plan
   * Task 13). pointerup is the tap; the following synthetic click is swallowed
   * so a tap cannot double-toggle. A drag/scroll (finger moved > 8 px) is not
   * a tap. Hover remains the desktop path.
   */
  _bindMotherGlassTap() {
    const pane = this._hoverTarget || (this.panels && this.panels.mother);
    if (!pane || typeof pane.addEventListener !== 'function') return;
    const SLOP = 8;
    const down = (e) => {
      if (!this._glass) return;
      this._motherTapDown = { x: Number(e && e.clientX) || 0, y: Number(e && e.clientY) || 0 };
      this._motherTapHandled = false;
    };
    const up = (e) => {
      if (!this._glass || !this._motherTapDown) { this._motherTapDown = null; return; }
      const dx = (Number(e && e.clientX) || 0) - this._motherTapDown.x;
      const dy = (Number(e && e.clientY) || 0) - this._motherTapDown.y;
      this._motherTapDown = null;
      if (Math.hypot(dx, dy) > SLOP) return;
      if (!this._inMotherTapZone(e && e.target)) return;
      this._toggleMotherTap();
      this._motherTapHandled = true;
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
    };
    const click = (e) => {
      if (!this._glass) return;
      if (this._motherTapHandled) {
        this._motherTapHandled = false;
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        return;
      }
      if (!this._inMotherTapZone(e && e.target)) return;
      this._toggleMotherTap();
    };
    pane.addEventListener('pointerdown', down);
    pane.addEventListener('pointerup', up);
    pane.addEventListener('click', click);
    this._glassTapBound = { pane, down, up, click };
  }

  /** @private Take the glass-tap listeners off their current target (attachToVitals re-binds them on the root). */
  _unbindMotherGlassTap() {
    const b = this._glassTapBound;
    this._glassTapBound = null;
    if (!b || typeof b.pane.removeEventListener !== 'function') return;
    b.pane.removeEventListener('pointerdown', b.down);
    b.pane.removeEventListener('pointerup', b.up);
    b.pane.removeEventListener('click', b.click);
  }

  /** @private The whole merged pane (title, meters, nets) is the tap zone — not the expanded .mother-detail. */
  _inMotherTapZone(t) {
    const pane = this._hoverTarget || (this.panels && this.panels.mother);
    if (!t) return false;
    if (t === pane) return true;
    if (typeof t.closest !== 'function') return t === pane;
    if (t.closest('.mother-detail')) return false;
    return !!(t.closest('.vp-title') || t.closest('#mother-digest') || t.closest('#hud-mother-panel') || t.closest('#hud-vitals'));
  }

  /** @private Glass tap: flip the expand class (pinned chrome still wins). */
  _toggleMotherTap() {
    if (this._motherPinned) return;
    if (this._motherExpanded) this._collapseMother();
    else this._expandMother();
  }

  /** @private Expand the MOTHER detail (Propulsion + Energy) to full view. */
  _expandMother() {
    if (this._motherCollapseTimer) {
      clearTimeout(this._motherCollapseTimer);
      this._motherCollapseTimer = null;
    }
    this._motherExpanded = true;
    if (this.panels.mother) this.panels.mother.classList.add('mother-expanded');
    // Energy block follows the MOTHER expand state.
    if (this.panels.power) this.panels.power.classList.remove('power-collapsed');
  }

  /** @private Collapse the MOTHER detail back to the digest-only view. */
  _collapseMother() {
    this._motherCollapseTimer = null;
    // Stay open while pinned via the chrome badge.
    if (this._motherPinned) return;
    this._motherExpanded = false;
    if (this.panels.mother) this.panels.mother.classList.remove('mother-expanded');
    if (this.panels.power) this.panels.power.classList.add('power-collapsed');
  }

  /** @private Schedule a MOTHER collapse shortly after the pointer leaves. */
  _scheduleMotherCollapse() {
    // Keep the detail open while pinned, or while the pointer is still over the
    // pane (e.g. the player pressed 1/2/3 to reallocate power without leaving) —
    // otherwise CSS :hover would keep .mother-detail open while `power-collapsed`
    // hid the bar labels, stranding unlabeled bars until the next mouseenter.
    if (this._motherPinned || this._motherHovering) return;
    if (this._motherCollapseTimer) clearTimeout(this._motherCollapseTimer);
    this._motherCollapseTimer = setTimeout(() => this._collapseMother(), 400);
  }

  /** @private Update power distribution bars from PowerDistribution state */
  _updatePowerBars() {
    const state = powerDistribution.getState();

    // B5 → MOTHER: expand the detail on power state change (keyboard interaction
    // via 1/2/3 keys) so the player sees the bars they're adjusting, then let it
    // auto-collapse unless pinned.
    const stateKey = `${state.thrust}-${state.sensors}-${state.arms}-${state.selectedBus}`;
    if (this._lastPowerState !== null && this._lastPowerState !== stateKey) {
      this._expandMother();
      this._scheduleMotherCollapse();
    }
    this._lastPowerState = stateKey;

    const buses = ['thrust', 'sensors', 'arms'];
    const colors = { thrust: 'var(--hud-normal, #00ff88)', sensors: 'var(--hud-info, #4488ff)', arms: 'var(--hud-normal, #00ff88)' };

    for (const bus of buses) {
      const bar = document.getElementById(`hud-power-bar-${bus}`);
      const val = document.getElementById(`hud-power-val-${bus}`);
      const row = this.panels.power?.querySelector(`.hud-power-row[data-bus="${bus}"]`);

      if (bar) {
        bar.style.width = `${state[bus]}%`;
        // Dim the bar color if allocation is 0
        bar.style.opacity = state[bus] === 0 ? '0.2' : '1';
      }
      if (val) val.textContent = `${state[bus]}%`;
      if (row) row.setAttribute('data-selected', state.selectedBus === bus ? 'true' : 'false');

    }
  }

  /**
   * @private Dark-cockpit dimming for the readiness digest. When every segment
   * is nominal the whole line goes quiet (~0.5 opacity); the moment anything
   * deviates the line returns to full opacity so the off-colour segment reads as
   * an alert rather than wallpaper. Each segment updater sets its own flag.
   */
  _refreshDigestDim() {
    const digest = document.getElementById('mother-digest');
    if (!digest) return;
    const allNominal = this._netNominal !== false;
    digest.style.opacity = allNominal ? '0.5' : '1';
  }

  /** @private Render mass budget / Tsiolkovsky ΔV display */
  _renderMassBudget() {
    const el = document.getElementById('hud-mass-budget');
    if (!el || !this._armManager) return;

    const mb = this._armManager.getMassBudget();
    this._paintFuelLine(mb);
    // g1-gas-upgrades D7: colour tiers read the mass fraction (same for every gas), else kg / kg-max
    const gasFrac = Number.isFinite(mb.gasFrac) ? mb.gasFrac : (mb.xenonMax > 0 ? mb.xenonCurrent / mb.xenonMax : 0);
    const xeColor = gasFrac > 0.5 ? 'var(--hud-normal, #00ff88)' :
                     gasFrac > 0.2 ? 'var(--hud-caution, #ffaa00)' : 'var(--hud-warning, #ff4444)';

    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;opacity:0.7;">
        <span>${this._currentFuelName()}:</span>
        <span style="color:${xeColor};">${mb.xenonCurrent}/${mb.xenonMax} kg</span>
      </div>
      <div style="display:flex;justify-content:space-between;opacity:0.7;">
        <span>Nitrogen:</span>
        <span>${mb.coldGasCurrent}/${mb.coldGasMax} kg</span>
      </div>
      <div style="display:flex;justify-content:space-between;opacity:0.7;">
        <span>Mass:</span>
        <span>${mb.wetMass} kg</span>
      </div>
      ${mb.cargoMass > 0 ? `
      <div style="display:flex;justify-content:space-between;color:var(--hud-caution, #ffaa00);">
        <span>Cargo:</span>
        <span>+${mb.cargoMass} kg</span>
      </div>` : ''}
      <div style="display:flex;justify-content:space-between;opacity:0.5;font-size:10px;">
        <span>Daughters: ${mb.dockedArmMass}kg docked</span>
        <span>${mb.deployedArmMass}kg out</span>
      </div>
    `;
  }

  /**
   * @private The ΔV alarm driver. h1-mother-pane D3: the old detail bar + text and the
   * digest's ΔV segment are gone (the engine row of the merged pane shows the ΔV), but
   * this emit is the ONE driver of the ΔV alarm (AudioSystem's DELTAV_UPDATE listener),
   * so it stays — with no DOM dependency. `pct` (0-1) is the engine TANK fraction, the same
   * number the engine row's bar shows, so a 60 % start reads 60 % (the first-reading
   * `maxDV` baseline would have read 100 % there).
   */
  _updateDeltaVBar(cachedTargets) {
    if (!this._armManager) return;

    const mb = this._armManager.getMassBudget();
    const dv = mb.deltaV;

    const res = this._lastResources || {};
    // h4-simple-first D10: the tank fraction is the mass budget's (the engine half's bar), else
    // the resource pool's own — no propellant constant here.
    let frac = 1;
    if (mb && Number.isFinite(mb.gasFrac)) {
      frac = clamp01(mb.gasFrac);   // g1-gas-upgrades D7: by mass, the same for every gas
    } else if (mb && mb.xenonMax > 0 && Number.isFinite(mb.xenonCurrent)) {
      frac = clamp01(mb.xenonCurrent / mb.xenonMax);
    } else if (res.xenonMax > 0 && Number.isFinite(res.xenon)) {
      frac = clamp01(res.xenon / res.xenonMax);
    }

    // Phase R9: Predictive ΔV — warn if matching selected target would drop below threshold.
    // Same scale as `pct`: the tank fraction left after paying the transfer.
    let predictedPct = null;
    if (cachedTargets && cachedTargets.length > 0) {
      const selectedTarget = cachedTargets.find(t => t.selected || t.isSelected);
      if (selectedTarget && selectedTarget.deltaV && dv > 0) {
        const costMs = selectedTarget.deltaV * 1000;  // km/s to m/s
        const predictedDv = dv - costMs;
        predictedPct = Math.max(0, frac * (predictedDv / dv));
      }
    }
    this._predictedDvPct = predictedPct;

    // Phase R9: Emit ΔV telemetry for AudioSystem 4-tier alarm + ambient state
    eventBus.emit(Events.DELTAV_UPDATE, {
      pct: frac,                 // 0-1, the engine tank fraction
      deltaV: dv,
      predictedPct: predictedPct,
      solarRate: res.solarRate || 0,
      batteryPct: res.battery ? (res.battery / (res.batteryMax || 100)) * 100 : 100,
    });
  }

  /**
   * @private Shared ΔV colour + pulse-animation ladder (audio tiers 30/15/5/1%).
   * Used by BOTH the propulsion detail bar and the MOTHER digest segment so the
   * two readouts can never drift. `nominalColor` is the only intended difference
   * (detail bar = solid green `#00ff88`; digest = dimmer teal `#aaffdd`).
   * @param {number} pct — remaining ΔV, 0..100
   * @param {string} nominalColor — colour when pct > 30
   * @returns {{ color: string, anim: string }}
   */
  _dvColorTier(pct, nominalColor) {
    if (pct > 30) return { color: nominalColor, anim: 'none' };
    if (pct > 15) return { color: 'var(--hud-caution, #ffaa00)', anim: 'none' };
    // Phase 1 #5: low-fuel urgency reads as steady red colour + the existing
    // audio warble. The old sub-second opacity strobe (deltav-pulse) blinked
    // continuously while the tank stayed low — removed for all tiers.
    return { color: 'var(--hud-warning, #ff4444)', anim: 'none' };
  }

  /**
   * @private P2 thermal HUD group — flower deploy-state/pose line for the
   * `data-hud-group="thermal-group"` node (declared-and-unbacked at
   * HUD.js:103/:110 until this panel; the reveal machinery already routes it
   * with the power group). Pure string builder on the §11.3 wheel-gauge idiom
   * (StatusPanel._wheelReadout): '' while there is nothing to show — no pairs
   * purchased returns '' and the panel stays display:none, so the pre-flower
   * HUD renders byte-identically. EMPTY-SAFE by charter: deploy state + pose
   * ONLY — NO thermal numbers (heat/PCM/rejection are P3).
   * Design 7b / owner amendment 2026-09-09: pose 'LAUNCH' (θ 0, the fore-folded
   * launch pack — reached in play only through the SAFETY OVERRIDE sweep) reads
   * FOLDED, and while the launch lock is armed (`locked` — folded, folding, or
   * releasing below the CLOSED floor) the line carries the reason the drive will
   * not answer: ' · THRUST INHIBITED' (the 7b pose-band guard; deploying past
   * the CLOSED floor clears it). `locked` absent (older snapshots) → no suffix.
   * Labels (h1-mother-pane D3): the angle then a plain word — `Radiator 2° · closed`,
   * `Radiator 146° · open`, `Radiator 90° · moving`, folded (146° is the open angle;
   * 180° is the push-through).
   * @param {{pairCount:number, thetaDeg:number, openFrac:number,
   *          slewing:boolean, pose:string, locked?:boolean}|null} st
   * @returns {string} span HTML, or '' when nothing should be shown
   */
  _flowerReadout(st, receiving = null) {
    if (!st || !st.pairCount) return '';
    const theta = Math.round(st.thetaDeg);
    // Plain words only (owner 2026-10-09: say the angle, never a pose name; h1-mother-pane
    // D3: no "Flower", "PAIRS", "A+B" or "% open" either): `Radiator 2\u00b0 \u00b7 closed`,
    // `Radiator 146\u00b0 \u00b7 open`, `Radiator 90\u00b0 \u00b7 moving`. Every non-closed rest reads open.
    const word = st.slewing ? 'moving'
      : st.pose === 'CLOSED' ? 'closed'
        : st.pose === 'LAUNCH' ? 'folded' : 'open';
    const label = st.locked === true ? `${theta}\u00b0 \u00b7 ${word} \u00b7 THRUST INHIBITED` : `${theta}\u00b0 \u00b7 ${word}`;
    // Inhibited = steady CAUTION amber (the denial token; the same '#ffaa00' the slew line wears).
    const c = st.locked === true ? `var(--hud-caution, ${VisualLaw.COLORS.CAUTION})`
      : st.slewing ? 'var(--hud-caution, #ffaa00)' : 'var(--hud-text, #a3d9c9)';
    // petal-single: the angle above is the shared one (the player's); while a catch is handed to a tip only THAT radiator
    // moves, and the panel says which one (1-based, as the player counts them).
    const recv = Array.isArray(receiving) && receiving.length > 0
      ? `<div style="display:flex;gap:6px;"><span style="opacity:0.7;">Radiator ${receiving.join(' and ')}</span>`
        + `<span style="color:var(--hud-caution, #ffaa00);">receiving</span></div>`
      : '';
    return `<div style="display:flex;gap:6px;">`
      + `<span style="opacity:0.7;">Radiator</span>`
      + `<span style="color:${c};">${label}</span>`
      + '</div>' + recv;
  }

  /** @private Per-frame thermal-group updater — DOM write only on change. */
  _renderThermalGroup() {
    const panel = document.getElementById('hud-thermal-panel');
    const el = document.getElementById('hud-thermal-flower');
    if (!panel || !el) return;
    const ps = this._armManager && this._armManager.playerSatellite;
    const st = (ps && typeof ps.getFlowerStatus === 'function') ? ps.getFlowerStatus() : null;
    const receiving = (ps && typeof ps.receivingRadiators === 'function') ? ps.receivingRadiators() : null;
    const html = this._flowerReadout(st, receiving);
    if (html === this._lastFlowerHtml) return;
    this._lastFlowerHtml = html;
    panel.style.display = html ? '' : 'none';
    el.innerHTML = html;
  }

  // ==========================================================================
  // FLEET pane tap grammar (Session J, D-I)
  // ==========================================================================

  /**
   * Replace the key dispatcher the FLEET pane's taps act through. A non-
   * function restores the default (KeyDispatch.pressKey → synthetic keydown /
   * keyup on window, the SAME path the physical keyboard drives).
   * @param {(code: string, opts?: object) => boolean} [fn]
   */
  setKeyDispatch(fn) {
    this._keyDispatch = typeof fn === 'function' ? fn : pressKey;
  }

  // ==========================================================================
  // DAUGHTERS FOLD (u4-phone-fold D2) - short screens only
  // ==========================================================================

  /**
   * @private Build the DAUGHTERS fold line (a `.fold-toggle` inside #fleet-header, built with createElement
   * so stub-DOM tests can tap it) and start watching the screen height. On a tall screen the line stays
   * hidden and the pane is today's pane. The toggle is a CHILD of the header (the header is PaneHelp's
   * deep-link element; a fold tap must never deep-link).
   */
  _buildArmsFold() {
    if (typeof document === 'undefined' || !document || typeof document.createElement !== 'function') return;
    const arms = this.panels.arms;
    const header = (arms && typeof arms.querySelector === 'function') ? arms.querySelector('#fleet-header') : null;
    const toggle = document.createElement('div');
    toggle.className = 'fold-toggle';
    Object.assign(toggle.style, {
      display: 'none', alignItems: 'center', justifyContent: 'space-between', flex: '1 1 100%',
      minHeight: `${this._glass ? FOLD_TOGGLE_TOUCH_PX : 24}px`, cursor: 'pointer', userSelect: 'none',
    });
    const left = document.createElement('span');
    left.textContent = 'DAUGHTERS';
    const right = document.createElement('span');
    right.className = 'fold-right';
    Object.assign(right.style, { fontWeight: 'normal', letterSpacing: 'normal', fontSize: '11px', opacity: '0.85', whiteSpace: 'nowrap' });
    toggle.appendChild(left);
    toggle.appendChild(right);
    toggle.addEventListener('click', () => this.toggleFold());
    if (header && typeof header.appendChild === 'function') header.appendChild(toggle);
    this._foldToggleEl = toggle;
    this._foldRightEl = right;
    this._armsHeaderEl = header;
    const win = (typeof window !== 'undefined') ? window : null;
    this._armsShort = shortScreenNow(win);
    this._armsFolded = this._armsShort;
    this._unwatchArmsShort = watchShortScreen(win, (short) => {
      this._armsShort = short;
      this._armsFolded = short;            // folded whenever the screen becomes short
      this._applyArmsFold();
    });
    this._applyArmsFold();
  }

  /**
   * u6 D9 (+ round 1 F4): is the DAUGHTERS pane on screen? False when the floor's room / the
   * density rung hides it (`data-density-hidden`) or when the HUD hid the pane or its left
   * column with an inline `display:none` (HUD.js applyFloorMask). Attribute / inline-style
   * reads only - no layout read.
   */
  isArmsShown() {
    const arms = this.panels && this.panels.arms;
    if (!arms) return false;
    if (arms.hasAttribute && arms.hasAttribute('data-density-hidden')) return false;
    if (arms.style && arms.style.display === 'none') return false;
    const col = this._leftColumn;
    if (col && col.style && col.style.display === 'none') return false;
    return true;
  }

  /** True while the DAUGHTERS pane is folded to its one line (short screens only). */
  isFolded() { return !!(this._armsShort && this._armsFolded); }

  /** Fold / unfold the DAUGHTERS pane (the fold toggle's tap; a no-op on a tall screen). */
  toggleFold() {
    if (!this._armsShort) return false;
    this._armsFolded = !this._armsFolded;
    this._applyArmsFold();
    return this._armsFolded;
  }

  /** @private Find a DAUGHTERS part: the pane's own tree first, then the document (stub DOMs register either). */
  _armsPart(id) {
    const arms = this.panels && this.panels.arms;
    let el = (arms && typeof arms.querySelector === 'function') ? arms.querySelector('#' + id) : null;
    if (!el && typeof document !== 'undefined' && document && typeof document.getElementById === 'function') el = document.getElementById(id);
    return el || null;
  }

  /**
   * @private Paint the fold state: toggle line, header, list, padding. Write on change (CONVENTIONS):
   * the inputs (short, folded, summary text) are keyed and an unchanged key writes nothing (this runs
   * at 10 Hz on every screen).
   */
  _applyArmsFold() {
    const toggle = this._foldToggleEl;
    if (!toggle) return;
    const short = !!this._armsShort;
    const folded = this.isFolded();
    const text = this._foldRightText();
    const key = `${short ? 1 : 0}|${folded ? 1 : 0}|${text}`;
    if (key === this._armsFoldKey) return;
    this._armsFoldKey = key;
    this._armsFoldWrites = (this._armsFoldWrites || 0) + 1;
    toggle.style.display = short ? 'flex' : 'none';
    if (this._foldRightEl && this._foldRightEl.textContent !== text) this._foldRightEl.textContent = text;
    const legacy = this._armsPart('fleet-legacy');
    if (legacy && legacy.style) legacy.style.display = short ? 'none' : 'flex';
    const list = this._armsPart('hud-arms-status');
    if (list && list.style) list.style.display = folded ? 'none' : '';
    const header = this._armsHeaderEl || this._armsPart('fleet-header');
    if (header && header.style) header.style.marginBottom = folded ? '0' : '3px';
    const pane = this.panels && this.panels.arms;
    if (pane && pane.style) pane.style.padding = folded ? '0 8px' : '';
  }

  /** @private `N of M ready ▸` / `▾` - the right side of the DAUGHTERS fold line. */
  _foldRightText() {
    return `${this._armsSummary} ${this.isFolded() ? FOLD_CLOSED_GLYPH : FOLD_OPEN_GLYPH}`.trim();
  }

  /**
   * @private Called from _renderArmPanel with the current statuses: refresh the summary and open the pane
   * once on each new departure (a daughter going docked -> not docked). Folding it again while she is out
   * keeps it folded until the next departure.
   */
  _updateArmsFold(statuses) {
    const list = Array.isArray(statuses) ? statuses : [];
    const rows = list.map((a, idx) => ({ label: this._daughterStatus(a, idx).label }));
    this._armsSummary = daughtersSummary(rows).text;
    const edges = departureEdges(this._armsDockedPrev, list.map((a) => ({
      id: a.id,
      docked: a.state === 'DOCKED' || a.state === 'RELOADING' || a.state === 'HOLDING_CATCH',
    })));
    this._armsDockedPrev = edges.next;
    if (edges.departed && this._armsShort && this._armsFolded) this._armsFolded = false;
    if (this._foldToggleEl) this._applyArmsFold();
  }

  /**
   * @private Attach the ONE click delegate for the FLEET list (#hud-arms-status)
   * — once. The list body is re-rendered via innerHTML on every ARM_SELECT /
   * fire / reload, so listeners live on the stable container, never on rows.
   * Mirrors TargetPanel's #hud-target-list delegate. Idempotent + DOM-guarded.
   * @returns {boolean} true when the delegate is (already) attached
   */
  _bindFleetClicks() {
    if (this._fleetClickBound) return true;
    const pane = this.panels && this.panels.arms;
    let list = null;
    if (pane && typeof pane.querySelector === 'function') list = pane.querySelector('#hud-arms-status');
    if (!list && typeof document !== 'undefined' && document && typeof document.getElementById === 'function') {
      list = document.getElementById('hud-arms-status');
    }
    if (!list || typeof list.addEventListener !== 'function') return false;
    list.addEventListener('click', (e) => this._onFleetClick(e));
    this._fleetClickBound = true;
    return true;
  }

  /**
   * @private The FLEET list click delegate. Two affordances, ONE key path each:
   *   • a `.fleet-btn` → press its `data-press` code (KeyD deploy / KeyR reel
   *     in + recall) and stop there — the row underneath must NOT also toggle
   *     the selection (stopPropagation + early return);
   *   • a row (`[data-arm-idx]`) → press Digit(idx+1): InputManager's
   *     `_handleArmKey` select path, including its re-press-to-deselect toggle.
   *     Only digits 1-4 exist today (arms 5-8 deferred, D2) → other rows no-op.
   * The pressed button is blurred so a later Space / Enter cannot re-click it.
   * @param {Event} e
   * @returns {string|null} the code pressed (for tests / logging), or null
   */
  _onFleetClick(e) {
    const t = e && e.target;
    if (!t || typeof t.closest !== 'function') return null;

    const btn = t.closest('.fleet-btn');
    if (btn) {
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      if (typeof btn.blur === 'function') btn.blur();
      const code = btn.dataset ? btn.dataset.press : null;
      if (!code) return null;
      this._keyDispatch(code);
      return code;
    }

    const row = t.closest('[data-arm-idx]');
    if (!row || !row.dataset) return null;
    const idx = parseInt(row.dataset.armIdx, 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= FLEET_TAP_ROWS) return null;
    const code = 'Digit' + (idx + 1);
    this._keyDispatch(code);
    return code;
  }

  /** @private Render the V5 crossbow arm status panel */
  _renderArmPanel() {
    const el = document.getElementById('hud-arms-status');
    if (!el) return;

    if (!this._armManager) {
      el.innerHTML = '<span style="opacity:0.5">No daughters</span>';
      this._updateArmsFold([]);
      return;
    }

    const statuses = this._armManager.getAllStatus();
    if (statuses.length === 0) {
      el.innerHTML = '<span style="opacity:0.5">No daughters</span>';
      this._updateArmsFold([]);
      return;
    }
    this._updateArmsFold(statuses);   // u4-phone-fold D2: the "N of M ready" line + the departure auto-open

    // Register item 100: the speed-dial header — fleet launch speed, the
    // equipped spring tier's ceiling, and the dial keys. Reads the same
    // getStatus fields the daughter lines use (null-safe for legacy mocks);
    // fleet truth is the MAX across arms, matching ArmManager.getFleetLaunchSpeed.
    // Re-rendered on LAUNCH_SPEED_CHANGED (wired in HUD.js).
    const _spd = Math.max(...statuses.map((a) => a.launchSpeed ?? Constants.CROSSBOW_LAUNCH_SPEED_DEFAULT));
    const _ceil = Math.max(...statuses.map((a) => (Constants.SPRING_TIERS[a.springTier ?? 0] || {}).maxSpeed ?? 0)) || _spd;
    const _dialHeader = `<div style="font-size:0.7rem;color:rgb(var(--hud-normal-rgb, 0 255 136) / 0.65);padding-bottom:2px;" title="Fleet launch speed — the item-100 dial. A hotter shot trades reload (∝ v²) for range.">LAUNCH ${_spd.toFixed(1)} m/s · max ${_ceil.toFixed(1)} · <span style="opacity:0.75">[;] down · ['] up</span></div>`;

    // List by size: Large daughters (weavers) first, then Small (spinners). A
    // small gap separates the two size groups — no headers, no resized rows.
    const sizeRank = { weaver: 0, spinner: 1 };
    const sorted = statuses
      .map((a, idx) => ({ a, idx }))
      .sort((x, y) => (sizeRank[x.a.type] ?? 2) - (sizeRank[y.a.type] ?? 2) || x.idx - y.idx);

    let prevType = null;
    // z1-calm-scan D5: the simple level has no LAUNCH row (launch speed / dial keys come one level up).
    el.innerHTML = (this._simple ? '' : _dialHeader) + sorted.map((e) => {
      const gap = (prevType !== null && e.a.type !== prevType) ? '<div style="height:6px;"></div>' : '';
      prevType = e.a.type;
      return gap + this._renderDaughterLine(e.a, e.idx);
    }).join('');

    // Prune range-rate cache entries for daughters no longer present (destroyed
    // mid-flight without passing through EXPENDED) so the Map can't grow across
    // a long session.
    if (this._daughterRangeCache.size > statuses.length) {
      const live = new Set(statuses.map((s) => s.id));
      for (const id of this._daughterRangeCache.keys()) {
        if (!live.has(id)) this._daughterRangeCache.delete(id);
      }
    }
  }

  /**
   * @private Plain-English status word + colour for one daughter — what it's
   * doing, in words a new player understands (not the internal state enum).
   * Critical tether stress / tangle override the state so trouble reads first.
   * @returns {{label: string, color: string}}
   */
  _daughterStatus(a, idx) {
    const tens = this._tetherTensions[idx];
    if (tens !== undefined && tens >= (Constants.REEL_TENSION_CRITICAL || 0.9)
        && a.state !== 'DOCKED' && a.state !== 'RELOADING') {
      return { label: 'Tether stress', color: 'var(--hud-warning, #ff4444)' };
    }

    switch (a.state) {
      case 'DOCKED':
        return a.springCharged
          ? { label: 'Ready', color: 'var(--hud-normal, #00ff88)' }
          : { label: 'Charging', color: 'var(--hud-caution, #ffaa00)' };
      case 'RELOADING':
        return { label: `Reloading ${Math.round((a.reloadProgress || 0) * 100)}%`, color: 'var(--hud-info, #00ffff)' };
      case 'LAUNCHING': case 'UNDOCKING': case 'TRANSIT':
        return { label: 'Heading out', color: 'var(--hud-info, #00ffff)' };
      case 'APPROACH': case 'STATION_KEEP':
        return { label: 'Approaching', color: 'var(--hud-info, #00ffff)' };
      case 'NETTING': case 'GRAPPLED': case 'MAGNETIC_GRAPPLE':
      case 'GRIPPER_GRAPPLE': case 'PAD_CONTACT': case 'WEB_SHOT':
        return { label: 'Capturing', color: 'var(--hud-info, #00ffff)' };
      case 'REELING': case 'HAULING': case 'RETURNING': case 'DOCKING': {
        // reel-view (owner 2026-10-22: "on slow reel-in it seems like nothing is happening"): on a reel home the row says
        // what the reel is doing (Pulling in / Reeling in / Braking / Lining up / Latching), not just "Returning".
        const rp = this._reelProgressOf(idx);
        return { label: rp ? rp.phase : 'Returning', color: 'var(--hud-info, #00ffff)' };
      }
      case 'HOLDING_CATCH': {
        // Register item 48: the rack cook is visible — the daughter line reads
        // the head piece's _digestProgress / span (ArmUnit.getStatus().digest).
        // The eclipse trickle dims to embers; the title tells the dawn story.
        // No digest field (legacy mocks) → the pre-48 line, byte-identical.
        // no-melt: with no furnace the digest fraction never moves; the line reads "Catch held" instead.
        if (a.digest && !Constants.isFeatureEnabled('FURNACE_COOK')) {
          return { label: 'Catch held', color: 'var(--hud-caution, #ffaa00)', title: 'Held on the rack. It goes to a furnace on the trip to the next field' };
        }
        if (a.digest) {
          const pct = Math.round(clamp01(a.digest.frac || 0) * 100);
          const q = (a.digest.queued || 0) > 0 ? ` +${a.digest.queued}` : '';
          const eclipsed = (a.digest.sunScale ?? 1.0) < 1;
          return {
            label: `Cooking ${pct}%${q}`,
            color: eclipsed ? 'var(--hud-caution, #cc8800)' : 'var(--hud-caution, #ffaa00)',
            title: eclipsed
              ? 'Eclipse — the furnace smoulders on panel embers until dawn'
              : `Solar furnace cooking the catch — ${pct}%`,
          };
        }
        return { label: 'Catch aboard', color: 'var(--hud-caution, #ffaa00)' };
      }
      case 'TRAWLING':
        return { label: 'Trawling', color: 'var(--hud-normal, #00ff88)' };
      case 'SCANNING':
        return { label: 'Scanning', color: 'var(--hud-info, #4488ff)' };
      case 'ABLATING':
        return { label: 'De-spinning', color: 'var(--hud-info, #00ffff)' };
      case 'DEORBITING':
        return { label: 'Deorbiting', color: 'var(--hud-warning, #ff4444)' };
      case 'ADRIFT':
        return { label: 'Adrift', color: 'var(--hud-caution, #ffaa00)' };
      case 'EXPENDED':
        return { label: 'Lost', color: 'var(--hud-warning, #ff4444)' };
      default:
        return { label: a.state, color: 'var(--hud-dim, #888)' };
    }
  }

  /**
   * @private The action line shown on the selected daughter's 2nd line — the
   * ONE verb relevant to its current state, as a tap button (Session J, D-I:
   * DEPLOY / REEL IN / RECALL, each pressing its key through `_keyDispatch`)
   * followed by the desktop letter hint in plain words. Empty when it's busy /
   * not actionable. Daughters fly on autopilot, so the only verbs surfaced are
   * launch (D) and recall (R). A daughter parked with a catch (HOLDING_CATCH) gets TO RADIATOR (C) only while
   * `ArmManager.canMoveCatchToRadiator(idx)` says C would start her hand-off, so the button never promises what C
   * refuses (u17b, owner pick 2026-10-22; the arms rows are rebuilt every 0.1 s, so it follows the getter).
   * @param {object} a  the daughter's `getStatus()`
   * @param {number} [idx]  her index (the status has none)
   */
  _daughterHotkeys(a, idx) {
    // u15b B-T7: on glass the DEPLOY / REEL IN / RECALL button IS the control - no key span beside it (read when drawn, D7).
    const glassNow = this._glassArg !== false && (this._glass || GestureHints.isGlass());
    const key = (k, verb) => (glassNow ? '' : `<span style="color:var(--hud-info, ${VisualLaw.COLORS.SELECTION});font-weight:bold;">${k}</span>`
      + `<span style="opacity:0.8;"> ${verb}</span>`);
    // type=button (never submits), tabindex=-1 (Tab is a game key; the button
    // must not become the keyboard's focus target).
    // Flag-gated (review fix): flag-off, the shipped letter hint alone.
    const on = fleetTapEnabled();
    const btn = (code, label) => (on
      ? `<button type="button" class="fleet-btn" tabindex="-1" data-press="${code}">${label}</button>`
      : '');
    switch (a.state) {
      case 'DOCKED':
        return (a.springCharged && a.fuel > 0) ? btn('KeyD', 'DEPLOY') + key('D', 'launch') : '';
      case 'HOLDING_CATCH': {
        const am = this._armManager;
        return (am && typeof am.canMoveCatchToRadiator === 'function' && am.canMoveCatchToRadiator(idx))
          ? btn('KeyC', 'TO RADIATOR') + key('C', 'to radiator') : '';
      }
      case 'EXPENDED': case 'RELOADING': case 'DOCKING':
        return '';
      case 'ADRIFT':
        return btn('KeyR', 'REEL IN') + key('R', 'reel in');
      default:
        // u18c D4: CHANGE TOOL (the backquote key) beside RECALL while her tool can be changed (see toolButtonUp).
        return (this.toolButtonUp(idx) ? btn('Backquote', 'CHANGE TOOL') + key('`', 'change tool') : '')
          + btn('KeyR', 'RECALL') + key('R', 'recall');
    }
  }

  /**
   * u18c D4: how StatusPanel learns which daughter the player is piloting (a getter, read when a row is drawn).
   * @param {(() => (object|null))|null} fn  returns the piloted ArmUnit, or null when no daughter is piloted
   */
  setPilotedArmGetter(fn) {
    this._pilotedArmGetter = typeof fn === 'function' ? fn : null;
  }

  /**
   * u18c D4: is the CHANGE TOOL button on daughter `idx`'s row right now? Exactly when backquote would change her tool:
   * the tap grammar is on (`fleetTapEnabled`), she is the piloted daughter, she holds station on a piece
   * (STATION_KEEP), carries more than one tool and the multi-tool flag is on. The row (`_daughterHotkeys`) and the
   * reticle's glass advisory (main.js `setGlassControls` -> `toolButtonUp`) both read this one answer.
   * @param {number} idx  her index in the arm manager
   * @returns {boolean}
   */
  toolButtonUp(idx) {
    if (!fleetTapEnabled()) return false;
    const am = this._armManager;
    const arm = am && Array.isArray(am.arms) && Number.isInteger(idx) ? am.arms[idx] : null;
    if (!arm || arm.state !== Constants.ARM_STATES.STATION_KEEP) return false;
    if (!Array.isArray(arm.toolset) || arm.toolset.length <= 1) return false;
    if (!Constants.isFeatureEnabled('DAUGHTER_MULTITOOL')) return false;
    let piloted = null;
    try { piloted = this._pilotedArmGetter ? this._pilotedArmGetter() : null; } catch (_e) { piloted = null; }
    return !!piloted && piloted === arm;
  }

  /**
   * @private Scene-units → metres. SCENE_SCALE is scene-units/km, so
   * metres = scene / SCENE_SCALE × 1000 (canonical conversion, see
   * InputManager.js:2349). Positions (arm, mothership, debris `_scenePosition`)
   * all share the same scene-space frame, so no frame conversion is needed.
   */
  _sceneToMetres(distScene) {
    const s = Constants.SCENE_SCALE || 0.01;
    return (distScene / s) * 1000;
  }

  /** @private Euclidean distance between two {x,y,z} points, or null. */
  _pointDist(p1, p2) {
    if (!p1 || !p2) return null;
    const dx = p1.x - p2.x, dy = p1.y - p2.y, dz = p1.z - p2.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** @private Clock for the range-rate smoother (ms). A method so a test can drive a fake clock. */
  _rangeClockMs() {
    return performance.now();
  }

  /**
   * @private Smoothed range-rate for one daughter (m/s, positive = closing): the Theil-Sen slope of the
   * displayed range over the last RANGE_RATE_WINDOW_S seconds of samples. (owner 10-22 13:26Z: the closing word
   * flipped "opng"/"clsg" ten times a second for a still daughter, because the rate was the difference of two
   * 10 Hz samples; the slope over a window averages that noise out.) `key` is whatever the range is measured to:
   * the target object while targeting, `false` for the mothership-drift sample, so a retarget invalidates the
   * cache rather than spiking off a stale range. Returns null until the window spans RANGE_RATE_MIN_SPAN_S.
   */
  _daughterRangeRate(id, rangeM, key) {
    const now = this._rangeClockMs();
    let e = this._daughterRangeCache.get(id);
    const last = e && e.samples && e.samples.length ? e.samples[e.samples.length - 1] : null;
    if (!e || !e.samples || e.targeting !== key || !last || (now - last.t) / 1000 > 1 || now < last.t) {
      // new daughter / retarget / stale (paused, hidden) → start over
      e = { samples: [], targeting: key, word: null };
      this._daughterRangeCache.set(id, e);
    }
    e.samples.push({ t: now, range: rangeM });
    const cutoff = now - RANGE_RATE_WINDOW_S * 1000;
    while (e.samples.length > 2 && e.samples[0].t < cutoff) e.samples.shift();
    const n = e.samples.length;
    if (n < 3) return null;
    const span = (now - e.samples[0].t) / 1000;
    if (span < RANGE_RATE_MIN_SPAN_S) return null;
    // Theil-Sen: the median of the slopes between sample pairs at least RANGE_RATE_PAIR_GAP_S apart. A single
    // wild sample (a launch or origin-shift frame) cannot drag it the way it drags a least-squares fit (a first version
    // of this smoother showed "opng 1031 m/s" for a second after one stray launch frame in the pane probe).
    const slopes = this._rangeSlopes || (this._rangeSlopes = []);
    slopes.length = 0;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const dt = (e.samples[j].t - e.samples[i].t) / 1000;
        if (dt >= RANGE_RATE_PAIR_GAP_S) slopes.push((e.samples[i].range - e.samples[j].range) / dt); // range falls while closing
      }
    }
    if (slopes.length === 0) return null;
    slopes.sort((x, y) => x - y);
    const m = slopes.length >> 1;
    return slopes.length & 1 ? slopes[m] : 0.5 * (slopes[m - 1] + slopes[m]);
  }

  /**
   * @private The closing word with hysteresis, for one daughter's smoothed rate. Returns 'clsg', 'opng' or null.
   * The word appears only above RANGE_RATE_BAND_HI, and goes only below RANGE_RATE_BAND_LO, so noise near zero
   * never flips it (any appearance or disappearance counts as a flip). A word whose sign the rate has left
   * drops to null first and the opposite word needs the upper edge.
   */
  _closingWord(id, rate) {
    const e = this._daughterRangeCache.get(id);
    if (!e) return null;
    let w = e.word || null;
    if (rate === null) { e.word = null; return null; }
    if (w === 'clsg') {
      if (rate <= RANGE_RATE_BAND_LO) w = rate <= -RANGE_RATE_BAND_HI ? 'opng' : null;
    } else if (w === 'opng') {
      if (rate >= -RANGE_RATE_BAND_LO) w = rate >= RANGE_RATE_BAND_HI ? 'clsg' : null;
    } else if (rate >= RANGE_RATE_BAND_HI) w = 'clsg';
    else if (rate <= -RANGE_RATE_BAND_HI) w = 'opng';
    e.word = w;
    return w;
  }

  /** @private Format a distance in metres: whole m below 1 km, else km @2dp. */
  _fmtDist(m) {
    return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
  }

  /**
   * @private §11.3 wheel-saturation readout for one daughter, from the
   * ArmUnit.getStatus() wheelMomentum/wheelSaturated pair. '' while the wheel
   * is quiet — absent fields (legacy mocks), the flag-OFF neutral 0/false, or
   * momentum bled below the floor — so the pre-wheel line renders
   * byte-identically. A dim→amber pip gauge while momentum accumulates
   * (amber from 70% of threshold, mirroring the tether-tension tier), and the
   * red desat-surcharge warning while saturated. Pure string builder — no DOM,
   * no per-arm state (Node-testable like _daughterStatus).
   * @returns {string} span HTML, or '' when nothing should be shown
   */
  _wheelReadout(a) {
    if (a.wheelSaturated) {
      return '<span style="color:var(--hud-warning, #ff4444);white-space:nowrap;" '
        + 'title="Reaction wheels saturated — every net fire pays the RCS desat surcharge until momentum bleeds off">'
        + '↻ WHEEL SAT — desat surcharge</span>';
    }
    const m = a.wheelMomentum || 0;
    if (m < WHEEL_SHOW_FLOOR) return '';
    const th = (Constants.DAUGHTER_NET_RECOIL || {}).WHEEL_SATURATION_THRESHOLD || 3;
    const filled = clamp(Math.round((m / th) * 3), 0, 3);
    const c = m >= th * 0.7 ? 'var(--hud-caution, #ffaa00)' : 'var(--hud-text, #e8e4d0)';
    return `<span style="color:${c};opacity:0.7;" title="Reaction-wheel momentum ${m.toFixed(1)} of ${th} — desat surcharge when saturated">↻ ${WHEEL_PIPS[filled]}</span>`;
  }

  /**
   * @private reel-view: the reel's progress for daughter `idx` (ArmUnit.reelProgress), or null when she is not on a reel
   * home (or the arm object is a mock without it). Read-only.
   * @returns {{phase:string, distM:number, speedMs:number, etaS:(number|null), frac:number}|null}
   */
  _reelProgressOf(idx) {
    const arms = this._armManager && this._armManager.arms;
    const arm = arms && idx >= 0 ? arms[idx] : null;
    if (!arm || typeof arm.reelProgress !== 'function') return null;
    return arm.reelProgress() || null;
  }

  /**
   * @private reel-view: the reel row, "<phase> · <distance> m · <speed> m/s · <time> s", and a thin bar under it (the
   * fraction of the reel's starting distance done). Pure string builder.
   * @param {{phase:string, distM:number, speedMs:number, etaS:(number|null), frac:number}} rp
   * @returns {string} HTML for the row's inner part (no wrapper div)
   */
  static reelRowHtml(rp) {
    const t = rp.etaS == null ? '–' : `${Math.max(rp.etaS > 0.05 ? 1 : 0, Math.ceil(rp.etaS - 1e-9))} s`;
    const text = `${rp.phase} · ${Math.round(rp.distM)} m · ${rp.speedMs.toFixed(2)} m/s · ${t}`;
    const pct = Math.round(clamp01(rp.frac) * 100);
    return `<span class="reel-row" style="color:var(--hud-info, #00ffff);">${text}</span>`
      + `<div class="reel-bar" title="Reel progress ${pct}%" style="height:2px;margin-top:2px;background:rgb(var(--hud-info-rgb, 68 136 255) / 0.2);">`
      + `<div style="height:2px;width:${pct}%;background:var(--hud-info, #00ffff);"></div></div>`;
  }

  /**
   * @private The launched-daughter telemetry line: mothership range + drift +
   * tether, swapped for target range + closing rate when a target exists.
   * Returns '' for docked/reloading/expended daughters (no telemetry line),
   * except that live §11.3 wheel momentum still shows (it survives docking).
   */
  _renderDaughterTelemetry(a, armObj, idx) {
    // owner 10-22 13:26Z: a daughter parked on her strut holding a catch is grounded too (no range or closing line
    // against her own catch, which sat there flipping "opng"/"clsg").
    const grounded = a.state === 'DOCKED' || a.state === 'RELOADING' || a.state === 'EXPENDED' || a.state === 'HOLDING_CATCH';
    if (grounded) {
      this._daughterRangeCache.delete(a.id);
      // §11.3: wheel momentum survives docking (bleeds in every state) — keep
      // the gauge visible so a desat fee on the next launch isn't a surprise.
      // '' when quiet → the grounded line stays byte-identical to today.
      const wheel = this._wheelReadout(a);
      return wheel
        ? `<div style="padding-left:28px;font-size:10px;margin-top:1px;white-space:nowrap;">${wheel}</div>`
        : '';
    }
    const dim = 'color:var(--hud-text, #e8e4d0);opacity:0.7;';
    const parts = [];

    // reel-view: on a reel home the line is the reel's own progress, not the range / drift / tether numbers
    const rp = this._reelProgressOf(idx);
    if (rp) {
      const wheelR = this._wheelReadout(a);
      return `<div style="padding-left:28px;font-size:10px;margin-top:1px;white-space:nowrap;">`
        + StatusPanel.reelRowHtml(rp)
        + (wheelR ? ` <span style="opacity:0.4;"> · </span>${wheelR}` : '')
        + `</div>`;
    }

    const target = armObj && armObj.target;
    const targetPos = target ? (target._scenePosition || (target.mesh && target.mesh.position)) : null;

    if (target && targetPos) {
      // Targeting: show target range + closing rate (mothership range hidden).
      const rng = this._sceneToMetres(this._pointDist(targetPos, a.position) || 0);
      const rate = this._daughterRangeRate(a.id, rng, target);
      const word = this._closingWord(a.id, rate);
      parts.push(`<span style="${dim}">tgt ${this._fmtDist(rng)}</span>`);
      // owner 10-22: inside the dead band (and while the window is still filling) the line reads "0.0 m/s" with no
      // word, so noise can neither flip the word nor print a 0.1.
      // Red when closing fast at short range — imminent contact needs a glance.
      const hot = word === 'clsg' && rate > 5 && rng < 100;
      const c = hot ? 'var(--hud-warning, #ff4444)' : 'var(--hud-text, #e8e4d0)';
      const speed = word ? Math.abs(rate).toFixed(1) : '0.0';
      parts.push(`<span style="color:${c};opacity:0.85;">${word ? word + ' ' : ''}${speed} m/s</span>`);
    } else {
      // No target: mothership range + drift rate.
      const ps = this._armManager && this._armManager.playerSatellite;
      const motherPos = ps && (ps.position || (ps.mesh && ps.mesh.position));
      const d = this._pointDist(motherPos, a.position);
      if (d !== null) {
        const rng = this._sceneToMetres(d);
        const rate = this._daughterRangeRate(a.id, rng, false);
        parts.push(`<span style="${dim}">↦ ${this._fmtDist(rng)}</span>`);
        if (rate !== null) {
          parts.push(`<span style="${dim}">Δ ${Math.abs(rate).toFixed(1)} m/s</span>`);
        }
      } else {
        this._daughterRangeCache.delete(a.id);
      }
    }

    // Tether length — only meaningful while attached. Reuse the amber/red
    // tension styling so a stressed tether reads consistently with the status.
    if (!a.isDetached && a.tetherLength > 0) {
      const tens = idx >= 0 ? this._tetherTensions[idx] : undefined;
      const crit = Constants.REEL_TENSION_CRITICAL || 0.9;
      const tc = tens !== undefined && tens >= crit ? 'var(--hud-warning, #ff4444)'
        : tens !== undefined && tens >= crit * 0.7 ? 'var(--hud-caution, #ffaa00)' : 'var(--hud-text, #e8e4d0)';
      parts.push(`<span style="color:${tc};opacity:0.7;">tether ${Math.round(a.tetherLength)} m</span>`);
    }

    // §11.3 reaction-wheel gauge — last, it's advisory. Quiet wheels (absent
    // fields / flag OFF / bled down) add nothing, keeping the line byte-
    // identical to the pre-wheel render.
    const wheel = this._wheelReadout(a);
    if (wheel) parts.push(wheel);

    if (parts.length === 0) return '';
    return `<div style="padding-left:28px;font-size:10px;margin-top:1px;white-space:nowrap;">`
      + parts.join('<span style="opacity:0.4;"> · </span>')
      + `</div>`;
  }

  /**
   * W2 meters (DECISIONS §15 row 8, "the mother and daughter panes show their
   * reach and nets left"): a reach in plain words — `90 m`, `500 m`, `2 km`,
   * `2.5 km`. Non-finite / non-positive -> ''.
   * @param {number} m metres
   * @returns {string}
   */
  /** q3 round 2: what the net line has dropped at fit level 0..4 (see `_fitDigest`). */
  static DIGEST_FIT_STEPS = [[], ['reach'], ['reach', 'track'], ['reach', 'track', 'tail'], ['reach', 'track', 'tail', 'max']];

  static reachText(m) {
    if (!Number.isFinite(m) || m <= 0) return '';
    if (m < 1000) return `${Math.round(m)} m`;
    const km = Math.round(m / 100) / 10;
    return `${Number.isInteger(km) ? km : km.toFixed(1)} km`;
  }

  /**
   * @private One daughter row. Unselected = a single details line
   * (number · status · nets · fuel). Selected = two lines: the details line,
   * plus a 2nd line listing the hotkey(s) relevant to its current state.
   */
  _renderDaughterLine(a, idx) {
    const selectedIdx = this._armManager ? this._armManager.selectedArmIndex : -1;
    const total = this._armManager ? this._armManager.arms.length : 0;
    const isSel = idx === selectedIdx;

    // 1-4 (front/back letters only matter on the big late-game fleets).
    let label = String(idx + 1);
    if (total > 6 && idx === total - 2) label = 'F';
    else if (total > 6 && idx === total - 1) label = 'B';

    const { label: status, color: statusColor, title: statusTitle } = this._daughterStatus(a, idx);
    // The carrying-a-catch flag is a 1-char geometric dot: the status column is
    // a tight 1fr slot (ellipsis-clipped), so a word would clip the status.
    const catchFlag = a.hasCaptured ? ' <span title="Carrying a catch">●</span>' : '';

    // NET — each daughter's own magazine. Same ivory NET colour as the MOTHER
    // pane (shared NET_COLOR), warning amber at half / red at empty (at 0 it
    // can't capture). Net inventory isn't in getStatus, so read the arm object
    // directly. Always emit a cell (empty when absent) to keep columns aligned.
    const armObj = this._armManager ? this._armManager.arms[idx] : null;
    let netHtml = '<span></span>';
    if (armObj && typeof armObj.getNetInventory === 'function') {
      const nets = armObj.getNetInventory();
      const maxNets = typeof armObj.getNetInventoryMax === 'function' ? armObj.getNetInventoryMax() : 0;
      const netColor = nets <= 0 ? 'var(--hud-warning, #ff4444)' : (maxNets > 0 && nets <= maxNets * 0.5) ? 'var(--hud-caution, #ffaa00)' : NET_COLOR;
      // W2 meters (DECISIONS §15 row 8): the daughter's live tether reach
      // (config.tetherMax — purchases / old saves scale it) beside its nets.
      const reach = StatusPanel.reachText(armObj.config && armObj.config.tetherMax);
      const reachHtml = reach ? `<span class="fleet-reach" style="opacity:0.7;" title="Tether reach"> · ${reach}</span>` : '';
      netHtml = this._simple
        // z1-calm-scan D5: "2 nets · 2 km" - how many nets and how far, nothing else.
        ? `<span style="color:${netColor};white-space:nowrap;" title="Nets remaining · tether reach">${nets} net${nets === 1 ? '' : 's'}${reachHtml}</span>`
        : `<span style="color:${netColor};white-space:nowrap;" title="Nets remaining">NET ${nets}/${maxNets}${reachHtml}</span>`;
    }

    // ΔV — same label/colour ladder as the MOTHER pane (no fuel-gauge icon).
    // Daughter ΔV is its fuel % × type budget (getStatus.remainingDeltaV is
    // unreliable, so derive it). Right-aligned so it hugs the pane's right edge.
    const fuelPct = Math.round(a.fuel ?? 0);
    const dvMax = a.type === 'weaver' ? (Constants.WEAVER_DELTA_V || 500)
      : (Constants.SPINNER_DELTA_V || 297);
    const dv = Math.round((fuelPct / 100) * dvMax);
    const dvColor = this._dvColorTier(fuelPct, 'var(--hud-text, #aaffdd)').color;
    const dvHtml = `<span style="color:${dvColor};white-space:nowrap;text-align:right;" title="Maneuver budget (ΔV)">ΔV ${dv}</span>`;

    const numHtml = isSel
      ? `<span style="color:var(--hud-info, ${VisualLaw.COLORS.SELECTION});font-weight:bold;">▸${label}</span>`
      : `<span style="opacity:0.6;">${label}</span>`;

    // Line 1 — details laid out as fixed columns so N · status · NET · ΔV line up
    // vertically down the list. The number column is right-aligned (the ▸ marker
    // hangs left of the digit); the ΔV column is right-aligned to the pane edge.
    // W2 meters: the NET column carries the reach too (`NET 4/4 · 500 m`, 110 px measured), 50 -> 112 px.
    const detailLine = `<div style="display:grid;grid-template-columns:${this._simple ? '20px 1fr 112px' : '20px 1fr 112px 56px'};column-gap:8px;align-items:baseline;">`
      + `<span style="text-align:right;">${numHtml}</span>`
      + `<span style="color:${statusColor};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"${statusTitle ? ` title="${statusTitle}"` : ''}>${status}${catchFlag}</span>`
      + netHtml
      + (this._simple ? '' : dvHtml)
      + `</div>`;

    // 2nd line: pilot telemetry for launched daughters (empty when docked).
    const telemetryLine = this._renderDaughterTelemetry(a, armObj, idx);

    // Session J (D-I): every row names its arm (data-arm-idx = the ORIGINAL
    // index, not the size-sorted position) so the #hud-arms-status click
    // delegate can press Digit(idx+1). Rows a tap can select (1-4) read as
    // tappable (cursor:pointer + .fleet-row-tap hover); the rest stay display-only.
    // Flag-gated (review fix): with the ladder off the rows are the SHIPPED
    // markup byte-for-byte (no class, no data-arm-idx, no cursor).
    const on = fleetTapEnabled();
    const tappable = on && idx >= 0 && idx < FLEET_TAP_ROWS;
    const rowAttrs = on ? `class="fleet-row${tappable ? ' fleet-row-tap' : ''}" data-arm-idx="${idx}" ` : '';
    const rowCursor = tappable ? 'cursor:pointer;' : '';

    if (!isSel) {
      return `<div ${rowAttrs}style="padding:1px 4px;border-left:2px solid transparent;${rowCursor}">${detailLine}${telemetryLine}</div>`;
    }

    // Line 2 — the action button + the relevant hotkey hint, indented to sit
    // under the status column (inline flow: the hint's leading space must
    // survive, so no flex here; the button vertical-aligns to the text middle).
    // Flag-off keeps the shipped 1 px top margin (no button to align).
    const keys = this._daughterHotkeys(a, idx);
    // u18a (D3, owner 2026-10-22: a holding daughter's row read "busy…"): while TO RADIATOR is not up, her slot says what
    // she holds instead. Other states keep "busy…".
    const slot = keys
      || (a.state === 'HOLDING_CATCH' ? this._holdingSlotHtml(armObj) : '<span style="opacity:0.4;">busy…</span>');
    const keysLine = `<div style="padding-left:28px;font-size:10px;margin-top:${on ? 2 : 1}px;">`
      + slot
      + `</div>`;

    return `<div ${rowAttrs}style="padding:2px 4px;background:rgb(var(--hud-info-rgb, 68 136 255) / 0.08);border-left:2px solid var(--hud-info, ${VisualLaw.COLORS.SELECTION});${rowCursor}">`
      + detailLine
      + telemetryLine
      + keysLine
      + `</div>`;
  }

  /**
   * @private u18a (D3): the selected holding daughter's slot when TO RADIATOR is not up: `holding a fragment · 4.0 kg`.
   * Her first (head) rack piece, worded by `payoffParts` (the same type phrase and kg format as the catch payoff line, so a
   * plain "debris" never reads "a debris"). '' when she has no catch data to show, so the slot stays empty, never "busy…".
   * @param {object} [armObj]  the ArmUnit (`getStatus()` has no catch type)
   * @returns {string} HTML
   */
  _holdingSlotHtml(armObj) {
    const piece = armObj && Array.isArray(armObj.heldCatches) ? armObj.heldCatches[0] : null;
    if (!piece) return '';
    const text = StatusPanel.payoffParts({ debrisType: piece.type, massKg: piece.mass }).name.replace(/^Caught /, 'holding ');
    return `<span style="opacity:0.8;">${text}</span>`;
  }

  // ==========================================================================
  // DAUGHTERS PANE: HEADER
  // ==========================================================================
  // u7 D3: no "select 1–4" line on any size. The header's `title` carries the keys
  // on desktop hover and the Help list keeps its "1 – 4  Select a daughter" row.

  // ==========================================================================
  // F17: CODEX UNSEEN BADGE
  // ==========================================================================

  /**
   * Set the CodexSystem reference for unseen badge updates.
   * @param {import('../../systems/CodexSystem.js').CodexSystem} codexSystem
   */
  setCodexSystem(codexSystem) {
    this._codexSystem = codexSystem;
    this._updateCodexBadge();
  }

  /** @private Update the codex unseen-entries badge (stub — badge UI not yet wired). */
  _updateCodexBadge() {
    // TODO: implement unseen-entry badge once CodexSystem exposes an unseen count
  }

  // ==========================================================================
  // CARGO LINE (Sprint A1)
  // ==========================================================================

  /** @private Update the cargo summary line in the PROPULSION panel */
  _updateCargoLine() {
    const el = document.getElementById('cargo-summary');
    if (!el) return;
    let hide = false;
    try { hide = !!this._cargoPaneVisible(); } catch (_e) { hide = false; }
    if (hide) {
      el.style.display = 'none';
      return;
    }

    const status = this._cargoStatus;
    if (!status || status.totalMassKg <= 0) {
      // Sprint S2: Show empty cargo state for economy discovery
      el.style.display = '';
      el.innerHTML = `<span style="color:var(--hud-dim, #555);">CARGO: 0/${status ? status.capacityKg : 500}kg</span>`;
      return;
    }

    el.style.display = '';

    // Build compact manifest string: "Al:20 Cu:30 ..."
    const manifest = status.manifest || [];
    const items = manifest
      .filter(m => m.massKg >= 0.1)
      .map(m => {
        // Use short 2-char name prefix for compactness
        const shortName = m.name.substring(0, 2);
        return `<span style="color:${m.color || 'var(--hud-label, #aaa)'}">${shortName}:${Math.round(m.massKg)}</span>`;
      })
      .join(' ');

    const pctUsed = status.utilizationPct || 0;
    const pctColor = pctUsed > 0.8 ? 'var(--hud-caution, #ffaa00)' : 'var(--hud-normal, #00ff88)';
    const massText = `${Math.round(status.totalMassKg)}/${status.capacityKg}kg`;

    el.innerHTML = `<span style="color:${pctColor};">CARGO:</span> ${massText} ${items ? '· ' + items : ''}`;
  }
}
