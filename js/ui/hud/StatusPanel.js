/**
 * StatusPanel.js — Score display, resource bars, mass budget, ΔV bar,
 * arm fleet status, and capture notifications.
 * @module ui/hud/StatusPanel
 */

import { Constants } from '../../core/Constants.js';
import { eventBus } from '../../core/EventBus.js';
import { Events } from '../../core/Events.js';
import { powerDistribution } from '../../systems/PowerDistribution.js';
import { tetherReel } from '../../systems/TetherReel.js';
import { BridleRing } from '../../entities/BridleRing.js';
import { PaneChrome } from './PaneChrome.js';

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

/**
 * Canonical daughter-state → color map. Shared by the expanded per-card render
 * (`_renderArmPanel`) and the collapsed fleet summary (`_updateFleetCollapsedSummary`)
 * so a given state always reads the same color in both. Previously these were
 * two separate maps that had drifted (e.g. TRANSIT showed blue when expanded
 * but amber when collapsed; FISHING amber vs cyan).
 */
const ARM_STATE_COLORS = {
  DOCKED:        '#00ff88', // green — ready
  UNDOCKING:     '#4488ff', // blue — in motion
  LAUNCHING:     '#00ffff', // cyan — spring launch
  TRANSIT:       '#4488ff', // blue — in motion
  APPROACH:      '#4488ff', // blue — in motion
  RETURNING:     '#4488ff', // blue — in motion
  DOCKING:       '#4488ff', // blue — in motion
  NETTING:       '#ffaa00', // amber — working
  GRAPPLED:      '#ffaa00', // amber — working
  HAULING:       '#ffaa00', // amber — working
  REELING:       '#00ffff', // cyan — motor reel-in
  FISHING:       '#ffaa00', // amber — working
  CAPTURING:     '#ff8800', // orange — working
  TRAWLING:      '#44aaff', // light blue — passive sweep
  RELOADING:     '#ffaa00', // amber — spring reloading
  HOLDING_CATCH: '#ffcc44', // gold — docked holding a catch (occupied)
  ABLATING:      '#ff44ff', // magenta — laser de-spin
  SCANNING:      '#00ffff', // cyan — pulse scan
  TANGLED:       '#ff8800', // orange — tether tangle
  DEORBITING:    '#ff4400', // orange-red — sacrificial burn
  STATION_KEEP:  '#00ffaa', // teal — orbital crane hold
  ADRIFT:        '#ffaa00', // amber — out of usable FEEP but tethered & recoverable
  EXPENDED:      '#ff4444', // red — lost/dead
};

export class StatusPanel {
  constructor(container) {
    this._container = container;
    this._armManager = null;
    this._initialDeltaV = null;
    this._captureNotifTimer = null;
    this._captureNotifEl = null;
    this._forgeRevealed = false;
    this._cargoStatus = null;   // cached from CARGO_UPDATED events
    this._powerExpanded = false;
    this._powerCollapseTimer = null;
    this._lastPowerState = null;
    this._throttleLevel = 1.0;  // F14: cached throttle for HUD display
    this._autopilotMode = 'OFF'; // F15: cached autopilot mode for HUD
    this._autopilotPhase = 'OFF'; // Trailing-rendezvous phase (F15.1)
    this._mpdUnlocked = false;   // F16: MPD thruster unlocked flag
    this._mpdArmed = false;      // S3b: MPD burst mode state

    // V5: Crossbow arm HUD state
    this._tetherTensions = {};          // {armIndex: fraction} — cached from events
    this._tangleState = null;           // {armIndices, startTime, duration} — active tangle
    this._pulseScanState = 'READY';     // READY | SCANNING | COOLDOWN
    this._thrusterInterlock = false;    // back arm blocking exhaust
    this._crossbowFireFlash = {};       // {armIndex: timestamp} — flash start times

    // ST-1.3: Lasso cooldown ring state
    this._lassoCooldownDuration = 0;    // total cooldown duration (s)
    this._lassoCooldownStart = 0;       // Date.now() when cooldown started
    this._lassoCooldownActive = false;  // true while cooling
    this._lassoDeniedFlash = 0;         // Date.now() timestamp of last denied flash

    /** @type {Object<string, HTMLElement>} DOM panels for show/hide */
    this.panels = {};

    this._build();

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

    // Phase R3: Reveal forge inline on first metal cargo store
    eventBus.on(Events.CARGO_STORE, (data) => {
      if (!this._forgeRevealed) {
        this._forgeRevealed = true;
        const forgeInline = document.getElementById('forge-inline');
        if (forgeInline) forgeInline.style.display = '';
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

    // Fleet hotkey "learned" tracking — the header hint shows full labels until
    // the player has both launched and recalled at least once, then fades to
    // terse glyphs (progressive disclosure; #4 dark-cockpit cleanup).
    this._fleetLaunchUsed = false;
    this._fleetRecallUsed = false;
    eventBus.on(Events.ARM_DEPLOYED, () => { this._fleetLaunchUsed = true; });
    eventBus.on(Events.ARM_RECALLED, () => { this._fleetRecallUsed = true; });
    eventBus.on(Events.ARM_RECALL_ONE, () => { this._fleetRecallUsed = true; });
    eventBus.on(Events.ARM_RECALL_ALL, () => { this._fleetRecallUsed = true; });

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
    eventBus.on(Events.MPD_BURST_START, () => {
      this._mpdArmed = true;
      this._updateMPDBurstDisplay();
    });
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

    // V5: Tether tangle detection — start auto-resolve countdown
    eventBus.on(Events.TETHER_TANGLE, (data) => {
      this._tangleState = {
        armIndices: data.armIndices || [],
        startTime: Date.now(),
        duration: (Constants.TANGLE_RESOLVE_TIME || 8) * 1000,
      };
      this._renderArmPanel();
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

    // V5: Crossbow fire flash — store timestamp per arm, immediate re-render
    eventBus.on(Events.CROSSBOW_FIRE, (data) => {
      if (data.armIndex !== undefined) {
        this._crossbowFireFlash[data.armIndex] = Date.now();
      }
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
      this._updateLassoCooldownRing();
    });
    eventBus.on(Events.LASSO_COOLDOWN_END, () => {
      this._lassoCooldownActive = false;
      this._updateLassoCooldownRing();
    });
    // Also flash denied state briefly
    eventBus.on(Events.LASSO_DENIED, () => {
      this._lassoDeniedFlash = Date.now();
      this._updateLassoCooldownRing();
    });
    // UX-3 #7: Lasso ammo tracking
    this._lassoAmmo = Constants.LASSO_AMMO_MAX;
    this._lassoAmmoMax = Constants.LASSO_AMMO_MAX;
    eventBus.on(Events.LASSO_AMMO_CHANGED, (data) => {
      this._lassoAmmo = data.remaining;
      this._lassoAmmoMax = data.max;
      this._updateLassoCooldownRing();
    });

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

  /** @private */
  _build() {
    // --- Left-column flex container for stacked panels ---
    this._leftColumn = document.createElement('div');
    this._leftColumn.id = 'hud-left-column';
    Object.assign(this._leftColumn.style, {
      position: 'absolute',
      top: '10px',
      left: '10px',
      display: 'flex',
      flexDirection: 'column',
      gap: '20px',
      width: '260px',
      maxHeight: 'calc(100vh - 60px)',
      overflowY: 'auto',
      zIndex: '10',
    });
    this._container.appendChild(this._leftColumn);

    // --- Mission Objective bar (top center) ---
    // Sim-reframe: the persistent top HUD shows only the mission objective
    // (hero "CLEARED N/50") plus a quiet credit wallet. Live flight state (RCS),
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
    this.panels.score.innerHTML = `
      <div style="display:flex;align-items:center;gap:16px;white-space:nowrap;line-height:1;">
        <div style="display:flex;align-items:baseline;gap:7px;">
          <span style="font-size:10px;letter-spacing:2px;opacity:0.7;text-transform:uppercase;">Cleared</span>
          <span style="font-size:18px;font-weight:bold;letter-spacing:1px;color:#00ff88;text-shadow:0 0 6px rgba(0,255,136,0.45);">
            <b id="hud-cleared">0</b><span style="opacity:0.5;font-weight:normal;font-size:13px;">/${Constants.WIN_DEBRIS_COUNT}</span>
          </span>
          <span id="hud-cleared-track" style="width:42px;height:3px;background:rgba(0,255,136,0.2);border-radius:2px;overflow:hidden;align-self:center;">
            <span id="hud-cleared-fill" style="display:block;width:0%;height:100%;background:#00ff88;transition:width 0.4s ease;"></span>
          </span>
        </div>
        <span style="color:#ffaa00;font-size:13px;font-weight:bold;">💰 <b id="hud-credits">0</b></span>
        <span id="hud-arm-tier" title="Current daughter configuration tier"
              style="display:none;color:#ff8800;font-size:11px;letter-spacing:0.05em;">Y0 Quad. 4 daughters</span>
        <span id="hud-anchor-wrap" title="Elevator contract. Deliver refined metal at the shop to win"
              style="color:#81c784;font-size:11px;">⚓ <span style="font-size:9px;letter-spacing:1px;opacity:0.7;">CONTRACT</span> <b id="hud-anchor-mass">0</b>/<b id="hud-anchor-target">10,000</b> kg</span>
      </div>
    `;

    // --- Control-mode indicator removed (2026-06-05) ---
    // A bottom-center "RCS" badge used to advertise what WASD does. The mother
    // flies on autopilot and steers with the arrow keys (no player-facing WASD
    // attitude modes), so the badge was jargon noise for new pilots. See the
    // note by the former _MODE_DISPLAY constant near the top of this file.

    // --- Propulsion Panel (left side) — F11: horizontal-expand ---
    this.panels.resources = this._createPanel('hud-resources-panel', {});
    this.panels.resources.className = 'hud-panel hud-panel-expandable';
    this.panels.resources.dataset.hudGroup = 'fuel-group';
    this.panels.resources.dataset.activateKey = 'A';
    this.panels.resources.innerHTML = `
      <div class="panel-collapsed-summary" id="propulsion-collapsed-summary">
        <div style="font-size:10px;color:#00ff88;opacity:0.7;margin-bottom:3px;white-space:nowrap;">PROPULSION <span id="autopilot-mini" style="color:#555;font-weight:bold;">Auto:OFF</span></div>
        <div style="width:96px;height:8px;background:rgba(0,0,0,0.5);border:1px solid rgba(0,255,136,0.3);border-radius:2px;overflow:hidden;margin-bottom:4px;">
          <div id="propulsion-mini-dv-fill" style="height:100%;width:100%;background:#00ff88;transition:width 0.5s ease,background-color 0.5s ease;"></div>
        </div>
        <div id="propulsion-fuel-pips" style="display:flex;gap:4px;align-items:center;font-size:9px;">
          <span style="color:#00ff88;">●</span><span style="opacity:0.5;" title="Xenon fuel">Xenon</span>
          <span style="color:#00ff88;">●</span><span style="opacity:0.5;" title="Cold gas (RCS)">Gas</span>
          <span style="color:#00ff88;">●</span><span style="opacity:0.5;" title="Battery charge">Batt</span>
        </div>
      </div>
      <div class="panel-full-content">
        <div class="pane-title" style="font-size:11px;margin-bottom:4px;color:#00ff88;opacity:0.7;">PROPULSION</div>
        <div id="autopilot-indicator" style="font-size:10px;margin-bottom:4px;padding:2px 6px;border-radius:2px;display:inline-block;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);color:#555;">[Autopilot: OFF]</div>
        <div id="deltav-bar-track" style="position:relative;width:100%;height:16px;background:rgba(0,0,0,0.5);
             border:1px solid rgba(0,255,136,0.3);border-radius:2px;overflow:hidden;">
          <div id="deltav-bar-fill" style="height:100%;width:100%;background:#00ff88;
               transition:width 0.5s ease, background-color 0.5s ease;"></div>
          <span id="deltav-bar-text" style="position:absolute;right:4px;top:0;line-height:16px;font-size:10px;color:#fff;text-shadow:0 0 3px rgba(0,0,0,0.8);background:rgba(0,0,0,0.4);padding:0 4px;border-radius:2px;">. M/s ~. </span>
        </div>
        <div id="deltav-text" style="font-size:11px;margin-top:4px;margin-bottom:6px;color:#aaffdd;">
          ΔV: m/s • ~. Transfers
        </div>
        <div class="hud-resource-row">
          <span>Xenon</span>
          <div class="hud-bar-track"><div class="hud-bar-fill" id="hud-bar-xenon" style="width:100%"></div></div>
          <span id="hud-val-xenon" style="width:36px;text-align:right">100%</span>
        </div>
        <div class="hud-resource-row">
          <span>Gas</span>
          <div class="hud-bar-track"><div class="hud-bar-fill" id="hud-bar-coldgas" style="width:100%"></div></div>
          <span id="hud-val-coldgas" style="width:36px;text-align:right">20</span>
        </div>
        <div class="hud-resource-row">
          <span>Bat</span>
          <div class="hud-bar-track"><div class="hud-bar-fill" id="hud-bar-battery" style="width:100%"></div></div>
          <span id="hud-val-battery" style="width:36px;text-align:right">100%</span>
          <span id="edt-indicator" style="display:none;color:#4488ff;font-size:10px;margin-left:4px;font-weight:bold;" title="Electrodynamic Tether">E-Tether</span>
        </div>
        <div id="mpd-lithium-row" class="hud-resource-row" style="display:none;">
          <span style="color:#88ccff;">Li</span>
          <div class="hud-bar-track"><div class="hud-bar-fill" id="hud-bar-lithium" style="width:0%;background-color:#88ccff;"></div></div>
          <span id="hud-val-lithium" style="width:36px;text-align:right;color:#88ccff;">0</span>
        </div>
        <div id="mpd-cathode-row" style="display:none;font-size:10px;color:#aaa;margin-top:1px;margin-bottom:2px;">
          <span title="MPD engine wear indicator">CATHODE:</span> <span id="hud-cathode-health" style="color:#88ccff;">100%</span>
          <span id="hud-cathode-time" style="opacity:0.5;margin-left:4px;">(0s/600s)</span>
        </div>
        <div id="mpd-burst-row" style="display:none;font-size:10px;margin-top:2px;margin-bottom:2px;">
          <div style="display:flex;align-items:center;gap:4px;">
            <span id="mpd-burst-label" style="color:#ff44ff;font-weight:bold;">⚡ MPD</span>
            <span id="mpd-burst-status" style="color:#ff44ff;">ARMED</span>
          </div>
          <div id="mpd-heat-row" style="display:flex;align-items:center;gap:4px;margin-top:2px;">
            <span style="color:#666;font-size:9px;">HEAT</span>
            <div style="flex:1;height:6px;background:rgba(0,0,0,0.5);border:1px solid rgba(255,68,255,0.3);border-radius:2px;overflow:hidden;">
              <div id="mpd-heat-bar" style="height:100%;width:0%;background:#44ff44;transition:width 0.2s ease;"></div>
            </div>
            <span id="mpd-heat-val" style="width:30px;text-align:right;color:#888;font-size:9px;">0%</span>
          </div>
        </div>
        <div id="fuel-type-indicator" style="font-size:10px;color:#4fc3f7;margin-top:2px;margin-bottom:2px">
          Xenon · 1600s
        </div>
        <div id="throttle-gauge" style="display:none;align-items:center;gap:4px;font-size:10px;margin-bottom:4px;">
          <span style="color:#00ff88;opacity:0.7;">Throttle</span>
          <div style="flex:1;height:8px;background:rgba(0,0,0,0.5);border:1px solid rgba(0,255,136,0.3);border-radius:2px;overflow:hidden;position:relative;">
            <div id="throttle-bar-fill" style="height:100%;width:100%;background:#00ff88;transition:width 0.15s ease;"></div>
          </div>
          <span id="throttle-val" style="width:30px;text-align:right;color:#00ff88;font-weight:bold;">100%</span>
        </div>
        <div id="com-drift-row" style="display:none;font-size:10px;margin-top:3px;margin-bottom:2px;">
          <span style="opacity:0.7;">CoM Δ: </span><span id="com-drift-val" style="font-weight:bold;color:#00ff88;">0.000 m</span>
          <span id="com-stow-hint" style="display:none;color:#ffaa00;margin-left:4px;font-size:9px;"></span>
        </div>
        <div id="plume-block-row" style="display:none;font-size:10px;margin-top:1px;margin-bottom:2px;color:#ff4444;font-weight:bold;">
          ⚠ PLUME BLOCK
        </div>
        <div id="cargo-summary" data-hud-group="cargo-group" style="font-size:10px;margin-top:3px;color:#666;display:none;"></div>
        <div id="forge-inline" data-hud-group="cargo-group" style="font-size:10px;margin-top:3px;display:none;">
          <div style="display:flex;align-items:center;gap:4px;">
            <span style="color:#666;">[F] Forge:</span>
            <span id="forge-inline-status" style="color:#666;">Idle</span>
          </div>
          <div id="forge-progress-inline" style="display:none;margin-top:2px;">
            <div style="position:relative;width:100%;height:10px;background:rgba(0,0,0,0.5);
                 border:1px solid rgba(0,255,136,0.3);border-radius:2px;overflow:hidden;">
              <div id="forge-inline-bar" style="height:100%;width:0%;transition:width 0.3s ease;"></div>
            </div>
            <div style="display:flex;justify-content:space-between;margin-top:1px;">
              <span id="forge-inline-batch" style="font-size:10px;color:#888;"></span>
              <span id="forge-inline-pct" style="font-size:10px;color:#888;"></span>
            </div>
          </div>
          <div id="forge-hint" style="display:none;font-size:10px;color:#ffaa00;margin-top:1px;"></div>
        </div>
        <div class="panel-expand-section propulsion-expand">
          <div style="font-size:10px;margin-top:6px;padding-top:4px;color:#4488ff;opacity:0.7;" title="Fuel mass breakdown (Tsiolkovsky)">MASS BUDGET</div>
          <div id="hud-mass-budget" style="font-size:10px;line-height:1.5;">
            <span style="opacity:0.5">Computing…</span>
          </div>
          <div style="font-size:10px;margin-top:3px;opacity:0.6;">
            ☀ <span id="hud-val-solar">0</span> W
          </div>
        </div>
      </div>
    `;
    this._leftColumn.appendChild(this.panels.resources);
    this.panels.resources.style.position = 'relative';

    // --- Power Distribution Panel (left side, middle) — F11: horizontal-expand ---
    this.panels.power = this._createPanel('hud-power-panel', {});
    this.panels.power.className = 'hud-panel hud-panel-expandable';
    this.panels.power.dataset.hudGroup = 'power-group';
    this.panels.power.innerHTML = `
      <div class="panel-collapsed-summary" id="energy-collapsed-summary">
        <div style="font-size:10px;color:#00ff88;opacity:0.7;margin-bottom:3px;white-space:nowrap;">⚡ ENERGY</div>
        <div style="display:flex;gap:4px;align-items:flex-end;height:32px;">
          <div style="flex:1;display:flex;flex-direction:column;align-items:center;">
            <div style="width:100%;background:rgba(0,0,0,0.5);border:1px solid rgba(0,255,136,0.3);border-radius:2px;height:28px;position:relative;overflow:hidden;">
              <div id="energy-mini-thrust" style="position:absolute;bottom:0;width:100%;height:40%;background:#00ff88;transition:height 0.2s ease;"></div>
            </div>
            <span style="font-size:7px;opacity:0.4;margin-top:1px;">T</span>
          </div>
          <div style="flex:1;display:flex;flex-direction:column;align-items:center;">
            <div style="width:100%;background:rgba(0,0,0,0.5);border:1px solid rgba(68,136,255,0.3);border-radius:2px;height:28px;position:relative;overflow:hidden;">
              <div id="energy-mini-sensors" style="position:absolute;bottom:0;width:100%;height:30%;background:#4488ff;transition:height 0.2s ease;"></div>
            </div>
            <span style="font-size:7px;opacity:0.4;margin-top:1px;">S</span>
          </div>
          <div style="flex:1;display:flex;flex-direction:column;align-items:center;">
            <div style="width:100%;background:rgba(0,0,0,0.5);border:1px solid rgba(0,255,136,0.3);border-radius:2px;height:28px;position:relative;overflow:hidden;">
              <div id="energy-mini-arms" style="position:absolute;bottom:0;width:100%;height:30%;background:#00ff88;transition:height 0.2s ease;"></div>
            </div>
            <span style="font-size:7px;opacity:0.4;margin-top:1px;">A</span>
          </div>
        </div>
      </div>
      <div class="panel-full-content">
        <div class="pane-title" style="font-size:11px;margin-bottom:4px;color:#00ff88;opacity:0.7;display:flex;justify-content:space-between;align-items:center;">
          <span>⚡ ENERGY</span>
          <span id="power-collapse-indicator" style="font-size:10px;opacity:0.4;transition:transform 0.2s;">▸</span>
        </div>
        <div id="hud-power-bars" style="font-size:10px;line-height:1.6;transition:max-height 0.2s ease,opacity 0.2s ease;overflow:hidden;">
          <div class="hud-power-row" data-bus="thrust" style="margin:2px 0;">
            <div style="display:flex;align-items:center;gap:4px;">
              <span class="power-label" style="width:52px;color:#00ff88;">Thrust</span>
              <div style="flex:1;height:10px;background:rgba(0,0,0,0.5);border:1px solid rgba(0,255,136,0.3);border-radius:2px;overflow:hidden;">
                <div id="hud-power-bar-thrust" style="height:100%;width:40%;background:#00ff88;transition:width 0.2s ease;"></div>
              </div>
              <span class="power-value" id="hud-power-val-thrust" style="width:28px;text-align:right;font-size:10px;">40%</span>
            </div>
          </div>
          <div class="hud-power-row" data-bus="sensors" style="margin:2px 0;">
            <div style="display:flex;align-items:center;gap:4px;">
              <span class="power-label" style="width:52px;color:#4488ff;">Sensors</span>
              <div style="flex:1;height:10px;background:rgba(0,0,0,0.5);border:1px solid rgba(0,255,136,0.3);border-radius:2px;overflow:hidden;">
                <div id="hud-power-bar-sensors" style="height:100%;width:30%;background:#4488ff;transition:width 0.2s ease;"></div>
              </div>
              <span class="power-value" id="hud-power-val-sensors" style="width:28px;text-align:right;font-size:10px;">30%</span>
            </div>
          </div>
          <div class="hud-power-row" data-bus="arms" style="margin:2px 0;">
            <div style="display:flex;align-items:center;gap:4px;">
              <span class="power-label" style="width:52px;color:#00ff88;">Daughters</span>
              <div style="flex:1;height:10px;background:rgba(0,0,0,0.5);border:1px solid rgba(0,255,136,0.3);border-radius:2px;overflow:hidden;">
                <div id="hud-power-bar-arms" style="height:100%;width:30%;background:#00ff88;transition:width 0.2s ease;"></div>
              </div>
              <span class="power-value" id="hud-power-val-arms" style="width:28px;text-align:right;font-size:10px;">30%</span>
            </div>
          </div>
        </div>
        <div class="energy-hint" style="font-size:10px;opacity:0;margin-top:3px;border-top:1px solid rgba(0,255,136,0.1);padding-top:3px;">
          ⇧1-3: select · [ ] ±10%
          </div>
        </div>
      `;
      this._leftColumn.appendChild(this.panels.power);
      this.panels.power.style.position = 'relative';
      this._injectPowerPulseStyle();

    // B5: Energy auto-collapse — default to compact bars-only
    this._injectPowerCollapseStyle();
    this.panels.power.classList.add('power-collapsed');
    this.panels.power.addEventListener('mouseenter', () => this._expandPower());
    this.panels.power.addEventListener('mouseleave', () => this._schedulePowerCollapse());

    // --- V5 Crossbow Arm Status Panel (left side, bottom) — F12: fleet collapsed summary ---
    this.panels.arms = this._createPanel('hud-arms-panel', {});
    this.panels.arms.className = 'hud-panel hud-panel-expandable';
    this.panels.arms.dataset.hudGroup = 'arms-group';
    this.panels.arms.dataset.activateKey = 'D';
    this.panels.arms.innerHTML = `
      <div class="pane-title" id="fleet-header" style="font-size:11px;margin-bottom:4px;color:#00ff88;opacity:0.7;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;">
        <span>🛰️ DAUGHTERS</span>
        <span id="fleet-aggregate" style="font-weight:normal;letter-spacing:normal;font-size:10px;opacity:0.75;"></span>
        <span id="fleet-hotkeys" style="margin-left:auto;font-weight:normal;letter-spacing:normal;font-size:9px;opacity:0.4;white-space:nowrap;"></span>
      </div>
      <div class="fleet-collapsed-summary" id="fleet-collapsed-summary">
        <span style="opacity:0.5;font-size:10px;">Loading fleet…</span>
      </div>
      <div class="fleet-full-content">
        <div id="hud-arms-status" style="font-size:10px;line-height:1.5;">
          <span style="opacity:0.5">Initializing daughter fleet…</span>
        </div>
        <div id="lasso-cooldown-row" style="display:flex;align-items:center;gap:6px;margin-top:4px;padding-top:3px;border-top:1px solid rgba(0,255,136,0.1);font-size:10px;">
          <svg id="lasso-cd-ring" width="18" height="18" viewBox="0 0 18 18" style="flex-shrink:0;">
            <circle cx="9" cy="9" r="7" fill="none" stroke="rgba(255,204,0,0.15)" stroke-width="2"/>
            <circle id="lasso-cd-arc" cx="9" cy="9" r="7" fill="none" stroke="#ffcc00" stroke-width="2"
                    stroke-dasharray="44" stroke-dashoffset="0"
                    stroke-linecap="round" transform="rotate(-90 9 9)"
                    style="transition:stroke-dashoffset 0.1s linear;"/>
          </svg>
          <span id="lasso-cd-label" style="color:#ffcc00;opacity:0.7;">WEB: ${Constants.LASSO_AMMO_MAX}/${Constants.LASSO_AMMO_MAX}. <span style="color:#00ff88;">READY</span></span>
        </div>
      </div>
    `;
    this._leftColumn.appendChild(this.panels.arms);
    this.panels.arms.style.position = 'relative';

    // --- Resize chrome for left-column panels (2-step: min / normal) ---
    // These panels' real hotkeys (A=autopilot, D=deploy) are taken, so resize is
    // badge-only: a +/− glyph top-right toggles the compact summary vs full
    // content (CSS in index.html flips the always-expanded left-column default
    // when the .pane-step-min class is present).
    this._resourcesChrome = new PaneChrome({
      pane: this.panels.resources, keyLabel: '–', bracket: false,
      steps: ['min', 'normal'], initial: 'normal',
      title: 'Propulsion. Click to minimize / restore',
    });
    this._powerChrome = new PaneChrome({
      pane: this.panels.power, keyLabel: '–', bracket: false,
      steps: ['min', 'normal'], initial: 'normal',
      title: 'Energy. Click to minimize / restore',
    });
    this._armsChrome = new PaneChrome({
      pane: this.panels.arms, keyLabel: '–', bracket: false,
      steps: ['min', 'normal'], initial: 'normal',
      title: 'Fleet. Click to minimize / restore',
    });

    // Phase 5 → R3: Listen for contract updates (now updates score bar anchor segment)
    // UX-11 #12: the contract track is ALWAYS visible (dual-objective HUD) —
    // the player should never have to open the shop to know if they're winning.
    eventBus.on(Events.CONTRACT_UPDATE, (data) => {
      const wrap = document.getElementById('hud-anchor-wrap');
      const massEl = document.getElementById('hud-anchor-mass');
      const targetEl = document.getElementById('hud-anchor-target');
      if (massEl) massEl.textContent = data.contractMassKg.toFixed(0);
      if (targetEl) targetEl.textContent = data.targetMassKg.toLocaleString();
      // Color intensity: muted below 50%, brighter above
      if (wrap && data.targetMassKg > 0) {
        const pct = data.contractMassKg / data.targetMassKg;
        wrap.style.color = pct > 0.5 ? '#a5d6a7' : '#81c784';
      }
    });

    this._buildDeltaVBar();
    this._buildCaptureNotification();
  }

  /** @private Inject ΔV pulse animation — bar lives inside resources panel */
  _buildDeltaVBar() {
    if (!document.getElementById('deltav-pulse-style')) {
      const style = document.createElement('style');
      style.id = 'deltav-pulse-style';
      style.textContent = `
        @keyframes deltav-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `;
      document.head.appendChild(style);
    }
  }

  /** @private Build the capture notification overlay */
  _buildCaptureNotification() {
    const notif = document.createElement('div');
    notif.id = 'capture-notification';
    Object.assign(notif.style, {
      position: 'fixed', top: '15%', left: '50%', transform: 'translateX(-50%)',
      textAlign: 'center', pointerEvents: 'none', opacity: '0',
      transition: 'opacity 0.2s ease-in', zIndex: '20',
    });
    notif.innerHTML = `
      <div id="capture-notif-delta" style="font-size:28px;color:#00ff88;
           text-shadow:0 0 10px #00ff88;font-family:'Courier New',monospace;font-weight:bold;"></div>
      <div id="capture-notif-count" style="font-size:14px;color:#88ffcc;margin-top:4px;
           font-family:'Courier New',monospace;"></div>
    `;
    document.body.appendChild(notif);
    this._captureNotifEl = notif;
  }

  // ==========================================================================
  // PUBLIC
  // ==========================================================================

  /**
   * Set the ArmManager reference for real-time status polling.
   * @param {import('../../entities/ArmManager.js').ArmManager} armManager
   */
  setArmManager(armManager) {
    this._armManager = armManager;
    this._renderArmPanel();
    this._updateArmTierBadge();

    // C-10: Listen for tier upgrades to update the badge
    eventBus.on(Events.TIER_UPGRADED, () => this._updateArmTierBadge());
  }

  /**
   * @private Update the arm tier badge in the score panel (C-10).
   * Only visible when FEATURE_FLAGS.TIER_UPGRADES is enabled.
   */
  _updateArmTierBadge() {
    const badge = this._container.querySelector('#hud-arm-tier');
    if (!badge) return;

    if (!Constants.FEATURE_FLAGS.TIER_UPGRADES) {
      badge.style.display = 'none';
      return;
    }

    badge.style.display = 'inline-block';
    if (this._armManager && typeof this._armManager.getCurrentTier === 'function') {
      const tierKey = this._armManager.getCurrentTier();
      const ladder = Constants.ARM_LADDER[tierKey];
      if (ladder) {
        const displayNames = { Y0_QUAD: 'Y0 Quad', Y1_HEX: 'Y1 Hex', Y3_OCTO: 'Y3 Octo' };
        badge.textContent = `${displayNames[tierKey] || tierKey}. ${ladder.armCount} daughters`;
      }
    }
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
   */
  update(data) {
    this._updateScorePanel(data);
    this._updateResourceBars(data.resources);
    this._renderMassBudget();
    this._updateDeltaVBar(data.cachedTargets);
    this._updatePowerBars();
    if (data.forgeState) {
      this._updateForgePanel(data.forgeState);
    }
    if (data.cargoStatus) {
      this._cargoStatus = data.cargoStatus;
    }
    this._updateCargoLine();

    // V5: Cache thruster interlock state from PlayerSatellite
    if (data.thrusterInterlocked !== undefined) {
      this._thrusterInterlock = data.thrusterInterlocked;
    }

    // C-9: Update CoM drift display + plume block indicator
    this._updateCoMDisplay(data);

    // V5: Auto-clear expired tangle state
    if (this._tangleState) {
      const elapsed = Date.now() - this._tangleState.startTime;
      if (elapsed >= this._tangleState.duration) {
        this._tangleState = null;
      }
    }
    // V5: Re-render arm panel at 10Hz for live tension/scan/flash updates
    this._renderArmPanel();

    // ST-1.3: Update lasso cooldown ring at 10Hz for smooth arc depletion
    this._updateLassoCooldownRing();
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
        comVal.style.color = '#ff4444'; // red
      } else if (drift >= balanced) {
        comVal.style.color = '#ffaa00'; // amber
      } else {
        comVal.style.color = '#00ff88'; // green
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
   * ST-1.3: Update the lasso cooldown ring SVG + label.
   * Ring depletes from full → empty during cooldown, then shows READY.
   * @private
   */
  _updateLassoCooldownRing() {
    const arc = document.getElementById('lasso-cd-arc');
    const label = document.getElementById('lasso-cd-label');
    if (!arc || !label) return;

    const circumference = 2 * Math.PI * 7; // r=7 ≈ 44
    const ammo = this._lassoAmmo ?? Constants.LASSO_AMMO_MAX;
    const ammoMax = this._lassoAmmoMax ?? Constants.LASSO_AMMO_MAX;
    const ammoTag = `WEB: ${ammo}/${ammoMax}`;
    const ammoColor = ammo <= 5 ? '#ff4444' : ammo <= 10 ? '#ffaa00' : '#ffcc00';

    // Denied flash (300ms red pulse)
    const deniedAge = this._lassoDeniedFlash ? (Date.now() - this._lassoDeniedFlash) / 1000 : 999;
    if (deniedAge < 0.3) {
      arc.setAttribute('stroke', '#ff4444');
      arc.setAttribute('stroke-dashoffset', '0');
      label.innerHTML = `<span style="color:${ammoColor};opacity:0.7;">${ammoTag}. <span style="color:#ff4444;">DENIED</span></span>`;
      return;
    }

    if (this._lassoCooldownActive && this._lassoCooldownDuration > 0) {
      const elapsed = (Date.now() - this._lassoCooldownStart) / 1000;
      const remaining = Math.max(0, this._lassoCooldownDuration - elapsed);
      // fraction: 1 = just started (full ring), 0 = done (empty ring)
      const frac = remaining / this._lassoCooldownDuration;
      const offset = circumference * (1 - frac);
      arc.setAttribute('stroke', '#888888');
      arc.setAttribute('stroke-dashoffset', String(offset));
      label.innerHTML = `<span style="color:${ammoColor};opacity:0.7;">${ammoTag}. <span style="color:#888;">${remaining.toFixed(1)}s</span></span>`;

      // Auto-clear when elapsed exceeds duration
      if (remaining <= 0) {
        this._lassoCooldownActive = false;
      }
    } else {
      // Ready state — full green ring (or depleted if ammo=0)
      const statusColor = ammo <= 0 ? '#ff4444' : '#00ff88';
      const statusText = ammo <= 0 ? 'DEPLETED' : 'READY';
      arc.setAttribute('stroke', statusColor);
      arc.setAttribute('stroke-dashoffset', '0');
      label.innerHTML = `<span style="color:${ammoColor};opacity:0.7;">${ammoTag}. <span style="color:${statusColor};">${statusText}</span></span>`;
    }
  }

  /**
   * Show a capture notification flash.
   * @param {number} delta  — score delta
   * @param {number} debrisCleared — total debris captured so far
   */
  showCaptureNotification(delta, debrisCleared, massKg, totalMassKg) {
    this._showCaptureNotification(delta, debrisCleared, massKg, totalMassKg);
  }

  /** Clean up DOM elements appended outside the HUD container. */
  dispose() {
    if (this._captureNotifEl && this._captureNotifEl.parentNode) {
      this._captureNotifEl.parentNode.removeChild(this._captureNotifEl);
    }
    if (this._captureNotifTimer) {
      clearTimeout(this._captureNotifTimer);
    }
    // Body-mounted priority panels (objective) are appended to document.body
    // by _createTopPanel, so they are not torn down with the HUD container —
    // remove them explicitly to avoid orphaned duplicate-id nodes.
    for (const p of [this.panels.score]) {
      if (p && p.parentNode) p.parentNode.removeChild(p);
    }
  }

  // ==========================================================================
  // PRIVATE UPDATERS
  // ==========================================================================

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
        creditsEl.style.color = '#ffff00';
        creditsEl.style.textShadow = '0 0 10px #ffaa00';
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
    const xenonMax = resources.xenonMax || Constants.XENON_FUEL_MAX;
    const coldGasMax = resources.coldGasMax || Constants.COLD_GAS_MAX;
    const batteryMax = resources.batteryMax || Constants.BATTERY_MAX;
    const xenonPct = (resources.xenon / xenonMax) * 100;
    const coldGasPct = (resources.coldGas / coldGasMax) * 100;
    const batteryPct = (resources.battery / batteryMax) * 100;

    this._setBar('hud-bar-xenon', xenonPct, 'hud-val-xenon', `${Math.round(xenonPct)}%`);
    this._setBar('hud-bar-coldgas', coldGasPct, 'hud-val-coldgas', resources.coldGas.toFixed(1));
    this._setBar('hud-bar-battery', batteryPct, 'hud-val-battery', `${Math.round(batteryPct)}%`);

    // S3b: Override battery bar color when MPD is armed (purple tint)
    if (this._mpdArmed) {
      const batBar = document.getElementById('hud-bar-battery');
      if (batBar) {
        const batteryFrac = batteryMax > 0 ? resources.battery / batteryMax : 1;
        if (batteryFrac < 0.15) {
          batBar.style.backgroundColor = (Date.now() % 500 < 250) ? '#ffaa00' : '#aa44ff';
        } else {
          batBar.style.backgroundColor = '#aa44ff';
        }
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

    const solarEl = document.getElementById('hud-val-solar');
    if (solarEl) solarEl.textContent = resources.solarRate.toFixed(0);

    // Cache for cross-method access (used by _updateDeltaVBar for DELTAV_UPDATE payload)
    this._lastResources = resources;

    // F11: Update propulsion collapsed summary fuel pips
    this._updatePropulsionPips();
  }

  /**
   * @private Update fuel type indicator from FUEL_CHANGED event data.
   * @param {object} fuelData - { name, isp, color }
   */
  _updateFuelIndicator(fuelData) {
    const el = document.getElementById('fuel-type-indicator');
    if (!el) return;
    if (fuelData) {
      el.textContent = `${fuelData.name} · ${fuelData.isp}s`;
      el.style.color = fuelData.color || '#4fc3f7';
    }
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
      bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
      // Color: silver-blue at normal, amber at low, red at critical
      if (pct > 30) bar.style.backgroundColor = '#88ccff';
      else if (pct > 15) bar.style.backgroundColor = '#ffaa00';
      else bar.style.backgroundColor = '#ff4444';
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
      if (healthPct > 50) healthEl.style.color = '#88ccff';
      else if (healthPct > 0) healthEl.style.color = '#ffaa00';
      else healthEl.style.color = '#ff4444';
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
        statusEl.style.color = '#ff6600';
      } else if (armed && degraded) {
        statusEl.textContent = 'DEGRADED';
        statusEl.style.color = '#ffaa00';
      } else if (armed) {
        statusEl.textContent = 'ARMED';
        statusEl.style.color = '#ff44ff';
        // Pulsing effect
        const pulse = Math.sin(Date.now() * 0.008) * 0.3 + 0.7;
        statusEl.style.opacity = pulse;
      } else {
        statusEl.textContent = 'STANDBY';
        statusEl.style.color = '#888';
        statusEl.style.opacity = 1;
      }
    }
    if (labelEl) {
      labelEl.style.color = armed ? '#ff44ff' : (cooldown > 0 ? '#ff6600' : '#888');
    }

    // Update heat bar
    const heatBar = document.getElementById('mpd-heat-bar');
    const heatVal = document.getElementById('mpd-heat-val');
    if (heatBar) {
      const pct = Math.min(100, heatFraction * 100);
      heatBar.style.width = `${pct}%`;
      // Color by heat level: green → amber → red
      if (pct < 50) heatBar.style.background = '#44ff44';
      else if (pct < 80) heatBar.style.background = '#ffaa00';
      else heatBar.style.background = '#ff4444';
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
      fill.style.backgroundColor = '#00ff88';
      val.style.color = '#00ff88';
    } else if (pct > 0) {
      fill.style.backgroundColor = '#ffaa00';
      val.style.color = '#ffaa00';
    } else {
      fill.style.backgroundColor = '#ff4444';
      val.style.color = '#ff4444';
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
   * Mini collapsed label: `Auto:<mode>·<phase>` (e.g. `Auto:TARGET·ALIGN`).
   * Phase segment is hidden when the AP is OFF.
   */
  _updateAutopilotIndicator() {
    const el = document.getElementById('autopilot-indicator');
    const mini = document.getElementById('autopilot-mini');
    const phaseLabel = _PHASE_LABELS[this._autopilotPhase] || '';

    if (this._autopilotMode === 'OFF') {
      if (el) {
        el.textContent = '[Autopilot: OFF]';
        el.style.color = '#555';
        el.style.borderColor = 'rgba(255,255,255,0.1)';
        el.style.background = 'rgba(0,0,0,0.4)';
      }
      if (mini) {
        mini.textContent = 'Auto:OFF';
        mini.style.color = '#555';
      }
    } else {
      const fullLabel = phaseLabel
        ? `[Autopilot: ${this._autopilotMode} · ${phaseLabel}]`
        : `[Autopilot: ${this._autopilotMode}]`;
      const miniLabel = phaseLabel
        ? `Auto:${this._autopilotMode}·${phaseLabel}`
        : `Auto:${this._autopilotMode}`;
      if (el) {
        el.textContent = fullLabel;
        el.style.color = '#00ff88';
        el.style.borderColor = 'rgba(0,255,136,0.5)';
        el.style.background = 'rgba(0,255,136,0.08)';
      }
      if (mini) {
        mini.textContent = miniLabel;
        mini.style.color = '#00ff88';
      }
    }
  }

  /** @private Set bar fill width and value text */
  _setBar(barId, pct, valId, text) {
    const bar = document.getElementById(barId);
    const val = document.getElementById(valId);
    if (bar) {
      bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
      // Color: green → amber → red
      if (pct > 30) bar.style.backgroundColor = '#00ff88';
      else if (pct > 15) bar.style.backgroundColor = '#ffaa00';
      else bar.style.backgroundColor = '#ff4444';
    }
    if (val) val.textContent = text;
  }

  /** @private Inject CSS for power bus selection pulse */
  _injectPowerPulseStyle() {
    if (!document.getElementById('power-pulse-style')) {
      const style = document.createElement('style');
      style.id = 'power-pulse-style';
      style.textContent = `
        .hud-power-row[data-selected="true"] {
          background: rgba(0,255,136,0.08);
          border-left: 2px solid #00ff88;
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

  /** @private Expand the power panel to full detail view (B5) */
  _expandPower() {
    if (this._powerCollapseTimer) {
      clearTimeout(this._powerCollapseTimer);
      this._powerCollapseTimer = null;
    }
    if (!this._powerExpanded) {
      this._powerExpanded = true;
      this.panels.power.classList.remove('power-collapsed');
    }
  }

  /** @private Collapse the power panel to bars-only view (B5) */
  _collapsePower() {
    this._powerExpanded = false;
    this.panels.power.classList.add('power-collapsed');
    this._powerCollapseTimer = null;
  }

  /** @private Schedule auto-collapse after 3s of no interaction (B5) */
  _schedulePowerCollapse() {
    if (this._powerCollapseTimer) {
      clearTimeout(this._powerCollapseTimer);
    }
    this._powerCollapseTimer = setTimeout(() => this._collapsePower(), 3000);
  }

  /** @private Update power distribution bars from PowerDistribution state */
  _updatePowerBars() {
    const state = powerDistribution.getState();

    // B5: Expand on power state change (keyboard interaction via 1/2/3 keys)
    const stateKey = `${state.thrust}-${state.sensors}-${state.arms}-${state.selectedBus}`;
    if (this._lastPowerState !== null && this._lastPowerState !== stateKey) {
      this._expandPower();
      this._schedulePowerCollapse();
    }
    this._lastPowerState = stateKey;

    const buses = ['thrust', 'sensors', 'arms'];
    const colors = { thrust: '#00ff88', sensors: '#4488ff', arms: '#00ff88' };

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

      // F11: Update energy collapsed summary mini bar
      const mini = document.getElementById(`energy-mini-${bus}`);
      if (mini) {
        mini.style.height = `${state[bus]}%`;
        mini.style.opacity = state[bus] === 0 ? '0.2' : '1';
      }
    }
  }

  /** @private Render mass budget / Tsiolkovsky ΔV display */
  _renderMassBudget() {
    const el = document.getElementById('hud-mass-budget');
    if (!el || !this._armManager) return;

    const mb = this._armManager.getMassBudget();
    const dvColor = mb.deltaV > 500 ? '#00ff88' : mb.deltaV > 200 ? '#ffaa00' : '#ff4444';
    const xeColor = mb.xenonCurrent > mb.xenonMax * 0.5 ? '#00ff88' :
                     mb.xenonCurrent > mb.xenonMax * 0.2 ? '#ffaa00' : '#ff4444';

    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;">
        <span>ΔV:</span>
        <span style="color:${dvColor};font-weight:bold;">${mb.deltaV} m/s</span>
      </div>
      <div style="display:flex;justify-content:space-between;opacity:0.7;">
        <span>Xe:</span>
        <span style="color:${xeColor};">${mb.xenonCurrent}/${mb.xenonMax} kg</span>
      </div>
      <div style="display:flex;justify-content:space-between;opacity:0.7;">
        <span>Mass:</span>
        <span>${mb.wetMass} kg</span>
      </div>
      <div style="display:flex;justify-content:space-between;opacity:0.5;font-size:10px;">
        <span>Daughters: ${mb.dockedArmMass}kg docked</span>
        <span>${mb.deployedArmMass}kg out</span>
      </div>
    `;
  }

  /** @private Update the ΔV budget bar */
  _updateDeltaVBar(cachedTargets) {
    const fill = document.getElementById('deltav-bar-fill');
    const text = document.getElementById('deltav-text');
    const barText = document.getElementById('deltav-bar-text');
    if (!fill || !text || !this._armManager) return;

    const mb = this._armManager.getMassBudget();
    const dv = mb.deltaV;

    // Capture initial ΔV on first non-zero reading
    if (this._initialDeltaV === null && dv > 0) {
      this._initialDeltaV = dv;
    }

    const maxDV = this._initialDeltaV || 500; // fallback estimate
    const pct = Math.max(0, Math.min(100, (dv / maxDV) * 100));

    // Estimate transfers based on actual nearby target costs (or 50 m/s default)
    const avgTransferCostMs = cachedTargets.length > 0
      ? (cachedTargets.slice(0, 5).reduce((sum, t) => sum + (t.deltaV || 0), 0) / Math.min(5, cachedTargets.length)) * 1000
      : 50;
    const transfers = avgTransferCostMs > 0 ? Math.floor(dv / Math.max(avgTransferCostMs, 10)) : 0;

    // Phase R9: Predictive ΔV — warn if matching selected target would drop below threshold
    let predictedPct = null;
    if (cachedTargets && cachedTargets.length > 0) {
      const selectedTarget = cachedTargets.find(t => t.selected || t.isSelected);
      if (selectedTarget && selectedTarget.deltaV) {
        const costMs = selectedTarget.deltaV * 1000;  // km/s to m/s
        const predictedDv = dv - costMs;
        predictedPct = Math.max(0, (predictedDv / maxDV));
      }
    }
    this._predictedDvPct = predictedPct;

    // Phase R9: Emit ΔV telemetry for AudioSystem 4-tier alarm + ambient state
    const res = this._lastResources || {};
    eventBus.emit(Events.DELTAV_UPDATE, {
      pct: pct / 100,            // normalize to 0-1
      deltaV: dv,
      predictedPct: predictedPct,
      solarRate: res.solarRate || 0,
      batteryPct: res.battery ? (res.battery / (res.batteryMax || 100)) * 100 : 100,
    });

    // Update bar width
    fill.style.width = `${pct}%`;

    // Color transitions based on percentage (synchronized with audio tiers: 30/15/5/1%)
    if (pct > 30) {
      fill.style.backgroundColor = '#00ff88';
      fill.style.animation = 'none';
    } else if (pct > 15) {
      fill.style.backgroundColor = '#ffaa00';
      fill.style.animation = 'none';
    } else if (pct > 5) {
      fill.style.backgroundColor = '#ff4444';
      fill.style.animation = 'none';
    } else if (pct > 1) {
      // 5%-1%: pulsing red bar
      fill.style.backgroundColor = '#ff4444';
      fill.style.animation = 'deltav-pulse 0.8s ease-in-out infinite';
    } else {
      // <1%: strobing red (faster pulse matching continuous audio warble)
      fill.style.backgroundColor = '#ff4444';
      fill.style.animation = 'deltav-pulse 0.3s ease-in-out infinite';
    }

    text.textContent = `ΔV: ${Math.round(dv)} m/s • ~${transfers} transfers`;
    if (barText) barText.textContent = `${Math.round(dv)} m/s ~${transfers}`;

    // Color the text label too
    if (pct <= 5) {
      text.style.color = '#ff4444';
    } else if (pct <= 15) {
      text.style.color = '#ffaa00';
    } else {
      text.style.color = '#aaffdd';
    }

    // F11: Update propulsion collapsed summary mini ΔV bar
    const miniDvFill = document.getElementById('propulsion-mini-dv-fill');
    if (miniDvFill) {
      miniDvFill.style.width = fill.style.width;
      miniDvFill.style.backgroundColor = fill.style.backgroundColor;
    }
  }

  /** @private Render the V5 crossbow arm status panel */
  _renderArmPanel() {
    const el = document.getElementById('hud-arms-status');
    if (!el) return;

    if (!this._armManager) {
      el.innerHTML = '<span style="opacity:0.5">No daughter manager</span>';
      this._updateFleetHeader([]);
      this._updateFleetCollapsedSummary([]);
      return;
    }

    const statuses = this._armManager.getAllStatus();
    if (statuses.length === 0) {
      el.innerHTML = '<span style="opacity:0.5">No daughters configured</span>';
      this._updateFleetHeader([]);
      this._updateFleetCollapsedSummary([]);
      return;
    }

    const stateColors = ARM_STATE_COLORS;

    const selectedIdx = this._armManager.selectedArmIndex;
    const now = Date.now();

    // V5: Arm label — indices 0–5 numbered 1–6, index N-2 = "F" (front), N-1 = "B" (back)
    const getLabel = (idx, total) => {
      if (total > 6 && idx === total - 2) return 'F';
      if (total > 6 && idx === total - 1) return 'B';
      return String(idx + 1);
    };

    const renderCard = (a, idx) => {
      const color = stateColors[a.state] || '#888';
      const isSelected = idx === selectedIdx;
      const label = getLabel(idx, statuses.length);
      const typeLetter = a.type === 'weaver' ? 'L' : a.type === 'spinner' ? 'S' : '·';

      // Selection styling — cyan number marker + card border/glow.
      const selBorder = isSelected
        ? `border:1px solid #00ffff;box-shadow:0 0 6px rgba(0,255,255,0.4);`
        : '';
      const numHtml = isSelected
        ? `<span style="color:#00ffff;font-weight:bold;">▸${label}</span>`
        : `<span style="opacity:0.55;">&nbsp;${label}</span>`;

      // V5: Crossbow fire flash (white glow for 200ms after fire)
      const flashTs = this._crossbowFireFlash[idx];
      const flashActive = flashTs && (now - flashTs) < 200;
      const flashStyle = flashActive
        ? 'border-color:#ffffff !important;box-shadow:0 0 10px rgba(255,255,255,0.6) !important;'
        : '';

      // ── Deviation badges — rendered ONLY when they carry information, so an
      //    idle docked fleet collapses to one tidy line per daughter and the
      //    pane only gets loud when a unit actually does something. ──
      const badges = [];

      // Holding a catch — needs to be brought home.
      if (a.hasCaptured) badges.push('<span title="Holding a catch">🎣</span>');

      // Fuel — only when below full (100% is the boring default).
      if (a.fuel < 100) {
        const fuelColor = a.fuel > 50 ? '#00ff88' : a.fuel > 20 ? '#ffaa00' : '#ff4444';
        badges.push(`<span style="color:${fuelColor};" title="Daughter fuel">⛽${a.fuel}%</span>`);
      }

      // Spring not charged while home — can't fire yet.
      if ((a.state === 'DOCKED' || a.state === 'DOCKING') && !a.springCharged) {
        badges.push('<span style="color:#ffaa00;" title="Spring not charged">○</span>');
      }

      // Tether length — only while deployed.
      if (a.state !== 'DOCKED' && a.state !== 'RELOADING' &&
          a.state !== 'HOLDING_CATCH' && a.tetherLength) {
        badges.push(`<span style="opacity:0.7;" title="Tether deployed">T:${a.tetherLength}m</span>`);
      }

      // Tether tension — color-coded; flashes red near snap.
      const tensFrac = this._tetherTensions[idx];
      if (tensFrac !== undefined && a.state !== 'DOCKED' && a.state !== 'RELOADING') {
        const tensPct = Math.round(tensFrac * 100);
        let tensColor = '#00ff88';
        if (tensFrac >= (Constants.REEL_TENSION_CRITICAL || 0.9)) {
          tensColor = (now % 400 < 200) ? '#ff3333' : '#ff6666'; // flashing red
        } else if (tensFrac >= (Constants.REEL_TENSION_WARNING || 0.7)) {
          tensColor = '#ffaa00';
        }
        badges.push(`<span style="color:${tensColor};" title="Tether tension">⊗${tensPct}%</span>`);
      }

      const badgeHtml = badges.length
        ? `<span style="display:flex;gap:6px;margin-left:auto;opacity:0.9;">${badges.join('')}</span>`
        : '';

      // ── Active-only sub-rows ──
      // V5: Reload progress bar (shown when RELOADING)
      let reloadHtml = '';
      if (a.state === 'RELOADING') {
        const pct = Math.round((a.reloadProgress || 0) * 100);
        const barColor = pct >= 100 ? '#00ff88' : '#00ffff';
        reloadHtml = `<div style="display:flex;align-items:center;gap:4px;margin-top:1px;">
            <span style="font-size:9px;color:#888;">RLD</span>
            <div style="flex:1;height:4px;background:rgba(0,0,0,0.5);border:1px solid rgba(0,255,255,0.3);border-radius:1px;overflow:hidden;">
              <div style="height:100%;width:${pct}%;background:${barColor};transition:width 0.15s ease;"></div>
            </div>
            <span style="font-size:9px;color:${barColor};">${pct}%</span>
          </div>`;
      }

      // V5: Tangle warning per arm (with auto-resolve countdown)
      // Uses JS-calculated opacity to avoid animation restart on 10Hz innerHTML rebuild
      let tangleHtml = '';
      if (this._tangleState && this._tangleState.armIndices.includes(idx)) {
        const elapsed = now - this._tangleState.startTime;
        const remaining = Math.max(0, (this._tangleState.duration - elapsed) / 1000);
        const tangleOpacity = 0.5 + 0.5 * Math.sin(now * 0.01);
        tangleHtml = `<div style="font-size:9px;color:#ffaa00;opacity:${tangleOpacity.toFixed(2)};">⚠ TANGLE ${remaining.toFixed(0)}s</div>`;
      }

      // ── Feature-gated diagnostics (all OFF by default; debug overlays) ──
      // C-4: Deploy state indicator (only when STOW_DEPLOY_STATE_MACHINE flag is on)
      let deployHtml = '';
      if (Constants.FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE &&
          this._armManager && this._armManager.arms[idx]) {
        const armObj = this._armManager.arms[idx];
        if (typeof armObj.getDeployState === 'function') {
          const ds = armObj.getDeployState();
          // Color coding: LOCKED=red, STOWED=amber, DEPLOYING/STOWING=cyan, DEPLOYED=green
          const dsColors = {
            'LOCKED': '#ff4444', 'STOWED': '#ffaa00',
            'DEPLOYING': '#00ffff', 'DEPLOYED': '#00ff88', 'STOWING': '#00ffff',
          };
          const dsColor = dsColors[ds] || '#888';
          let dsLabel = ds;
          // Add progress % for transitional states
          if ((ds === 'DEPLOYING' || ds === 'STOWING') &&
              typeof armObj.getDeployProgress === 'function') {
            const pct = Math.round(armObj.getDeployProgress() * 100);
            dsLabel = `${ds} ${pct}%`;
          }
          deployHtml = `<div style="font-size:9px;margin-top:1px;">
            <span style="color:${dsColor};">▸ ${dsLabel}</span>
          </div>`;
        }
      }

      // C-7: Tether reel HUD row (only when TETHER_REEL flag is ON)
      let reelHtml = '';
      if (Constants.FEATURE_FLAGS.TETHER_REEL) {
        const reelRec = tetherReel.getReelRecord(idx);
        if (reelRec && reelRec.state !== 'STOWED') {
          const cLen = reelRec.cableLengthM.toFixed(1);
          const cMax = reelRec.maxCableLengthM.toFixed(0);
          const breakN = Constants.OCTOPUS_V5.REEL.BREAKING_TENSION_N;
          const tensPct = breakN > 0 ? (reelRec.tensionN / breakN * 100) : 0;
          const reelColors = {
            'PAYING_OUT': '#00ffff', 'STATIC': '#00ff88',
            'REELING_IN': '#4488ff', 'JAMMED': '#ff8800', 'CUT': '#ff4444',
          };
          const rsColor = reelColors[reelRec.state] || '#888';

          // Tension bar color
          let tBarColor = '#00ff88';
          if (tensPct >= 90) tBarColor = '#ff3333';
          else if (tensPct >= 75) tBarColor = '#ffaa00';

          reelHtml = `<div style="font-size:9px;margin-top:1px;display:flex;gap:6px;align-items:center;">
            <span style="color:${rsColor};">⊙${reelRec.state}</span>
            <span style="color:#88ccff;">${cLen}/${cMax}m</span>
            <span style="color:${tBarColor};">⊗${Math.round(tensPct)}%</span>
          </div>`;
        }
      }

      // C-8: Bridle ring status row (only when BRIDLE_RING flag is ON)
      let bridleHtml = '';
      if (Constants.FEATURE_FLAGS.BRIDLE_RING) {
        const brStatus = BridleRing.getStatus(idx);
        if (brStatus) {
          const occupied = brStatus.attachPoints.filter(p => p.isOccupied).length;
          const total = brStatus.attachPoints.length;
          const loadKg = brStatus.totalLoadKg.toFixed(0);
          const brColors = {
            'IDLE': '#888', 'ATTACHED': '#00ff88',
            'OVERLOADED': '#ffaa00', 'DAMAGED': '#ff3333',
          };
          const brColor = brColors[brStatus.state] || '#888';
          if (occupied > 0 || brStatus.state !== 'IDLE') {
            bridleHtml = `<div style="font-size:9px;margin-top:1px;">
              <span style="color:${brColor};">◎ Bridle: ${occupied}/${total}. ${loadKg} kg</span>
            </div>`;
          }
        }
      }

      return `<div style="margin:1px 0;padding:2px 4px;border-left:2px solid ${color};background:rgba(0,20,40,0.4);${selBorder}${flashStyle}">
        <div style="display:flex;align-items:center;gap:6px;">
          ${numHtml}
          <span style="opacity:0.5;">${typeLetter}</span>
          <span style="color:${color};white-space:nowrap;">● ${a.state}</span>
          ${badgeHtml}
        </div>${reloadHtml}${tangleHtml}${deployHtml}${reelHtml}${bridleHtml}
        <div class="arm-hover-detail" style="display:none;font-size:10px;opacity:0.6;padding-left:12px;">
          ΔV ${a.remainingDeltaV ? a.remainingDeltaV.toFixed(0) + ' m/s' : '—'} · 🏆 ${a.captures} · ⛽ ${a.fuel}%
        </div>
      </div>`;
    };

    // ── Dark-cockpit fleet assembly (#1) + urgency sort (#3) ──────────────────
    // Classify each daughter so the pane stays silent when the fleet is nominal
    // and surfaces trouble first. Lower priority number = more attention:
    //   0 urgent (expended / low fuel / tangled / tension critical)
    //   1 needs delivery (holding a catch)
    //   2 active (deployed / in motion / working)
    //   3 watched (selected, or docked-but-not-charged)
    //   4 nominal (docked, charged, essentially full)  → collapses out of sight
    const LOW_FUEL = 25;
    // Daughters do not refuel while docked, so a docked unit below this bar is
    // shown as a full card (pri 3) rather than collapsing into the silent strip
    // — otherwise a drained-but-docked daughter would hide its fuel badge and
    // the pilot could launch it half-empty believing the fleet was topped off.
    const NOMINAL_FUEL = 95;
    const classify = (a, idx) => {
      const tens = this._tetherTensions[idx];
      const tensionCritical = tens !== undefined && tens >= (Constants.REEL_TENSION_CRITICAL || 0.9);
      const tangled = this._tangleState && this._tangleState.armIndices.includes(idx);
      if (a.state === 'EXPENDED' || a.state === 'ADRIFT' || tangled || tensionCritical || a.fuel <= LOW_FUEL) return 0;
      if (a.hasCaptured) return 1;
      if (a.state !== 'DOCKED') return 2;
      if (idx === selectedIdx || !a.springCharged || a.fuel < NOMINAL_FUEL) return 3;
      return 4;
    };

    const entries = statuses.map((a, idx) => ({ a, idx, pri: classify(a, idx) }));
    const allNominal = entries.every(e => e.pri === 4);

    let armsHtml;
    if (allNominal) {
      // Whole fleet docked, charged and full → one quiet strip of dots. The
      // header aggregate carries the "N ready" count, so this just confirms the
      // individual units exist (and lets selection still highlight one).
      armsHtml = `<div style="display:flex;gap:9px;align-items:center;font-size:10px;opacity:0.55;flex-wrap:wrap;">` +
        entries.map(e =>
          `<span><span style="color:#00ff88;">●</span><span style="opacity:0.7;">${getLabel(e.idx, statuses.length)}</span></span>`
        ).join('') +
        `</div>`;
    } else {
      // Sort by attention, stable within a priority band (keeps numbering calm).
      const sorted = entries.slice().sort((x, y) => x.pri - y.pri || x.idx - y.idx);
      const cards = sorted.filter(e => e.pri <= 3);
      const docked = sorted.filter(e => e.pri === 4);
      armsHtml = cards.map(e => renderCard(e.a, e.idx)).join('');
      if (docked.length) {
        // Nominal docked units fold into a single dim tail line.
        const dots = docked
          .map(e => `<span style="color:#00ff88;">●</span>${getLabel(e.idx, statuses.length)}`)
          .join(' ');
        armsHtml += `<div style="font-size:9px;opacity:0.4;margin-top:2px;">+${docked.length} docked&ensp;${dots}</div>`;
      }
    }

    // V5: Fleet status footer — pulse scan, thruster interlock.
    // (Launch speed was removed: it's a static config value, not a live readout,
    //  so it only added idle noise. It lives in the shop / upgrade screen.)

    // Thruster interlock warning — the only footer element that carries live,
    // actionable signal. (The former "SCAN" readout was removed: pulseScan() has
    // no hotkey / caller in the shipped build, so it could never change from
    // "SCAN ✓" — permanent filler. The mechanic itself is left intact in
    // ArmManager for when/if it gets wired up.) JS-calculated pulse for 10Hz-safe
    // rendering.
    let interlockHtml = '';
    if (this._thrusterInterlock) {
      const lockPulse = 0.5 + 0.5 * Math.sin(now * 0.01);
      interlockHtml = `<span style="color:#ff3333;font-weight:bold;opacity:${lockPulse.toFixed(2)};">⚠ THR LOCK</span>`;
    }

    // Footer renders ONLY when there's something to say — silent by default.
    const footerHtml = interlockHtml
      ? `<div style="font-size:10px;margin-top:3px;padding-top:3px;border-top:1px solid rgba(0,255,136,0.1);display:flex;gap:8px;align-items:center;flex-wrap:wrap;">${interlockHtml}</div>`
      : '';

    el.innerHTML = armsHtml + footerHtml;

    // Header aggregate + hotkey hint (#4/#5)
    this._updateFleetHeader(statuses);

    // F12: Update fleet collapsed summary
    this._updateFleetCollapsedSummary(statuses);
  }

  /**
   * @private Show a capture notification flash.
   * @param {number} delta — score delta
   * @param {number} debrisCleared — total debris captured so far
   */
  _showCaptureNotification(delta, debrisCleared, massKg, totalMassKg) {
    const notif = this._captureNotifEl;
    if (!notif) return;

    const deltaEl = document.getElementById('capture-notif-delta');
    const countEl = document.getElementById('capture-notif-count');
    // S9-A: Show mass if available, fall back to credits
    if (deltaEl) deltaEl.textContent = massKg > 0 ? `+${massKg.toLocaleString()} kg` : `+${delta.toLocaleString()} cr`;
    if (countEl) countEl.textContent = totalMassKg > 0
      ? `${debrisCleared} cleared · Mass recovered: ${totalMassKg.toLocaleString()} kg`
      : `${debrisCleared}/${Constants.WIN_DEBRIS_COUNT} CAPTURED · +${delta.toLocaleString()} cr`;

    // Clear any pending fade-out
    if (this._captureNotifTimer) {
      clearTimeout(this._captureNotifTimer);
    }

    // S4: Pop-in animation — scale up from 60% with overshoot
    notif.style.transition = 'none';
    notif.style.animation = 'none';
    // Force reflow to restart animation
    void notif.offsetWidth;
    notif.style.animation = 'captureNotifPop 0.35s ease-out forwards';
    notif.style.opacity = '1';

    // Fade out slowly (0.8s) after 2 seconds
    this._captureNotifTimer = setTimeout(() => {
      notif.style.animation = 'none';
      notif.style.transition = 'opacity 0.8s ease-out';
      notif.style.opacity = '0';
      this._captureNotifTimer = null;
    }, 2000);
  }

  /** @private Update forge panel from ForgeSystem state (Sprint A2: enhanced) */
  _updateForgePanel(forgeState) {
    if (!forgeState) return;

    // Auto-reveal forge section if forge has been used or is active (handles save-restore)
    if (!this._forgeRevealed && (forgeState.isActive || forgeState.totalBatches > 0)) {
      this._forgeRevealed = true;
      const forgeInline = document.getElementById('forge-inline');
      if (forgeInline) forgeInline.style.display = '';
    }

    const inlineEl = document.getElementById('forge-inline-status');
    const progressContainer = document.getElementById('forge-progress-inline');
    const progressBar = document.getElementById('forge-inline-bar');
    const batchLabel = document.getElementById('forge-inline-batch');
    const pctLabel = document.getElementById('forge-inline-pct');
    const hintEl = document.getElementById('forge-hint');

    const phaseColors = {
      INTAKE: '#4fc3f7',
      SEPARATE: '#ce93d8',
      MELT: '#ff9800',
      COOL: '#81c784',
    };

    if (!forgeState.isActive) {
      // --- Idle state ---
      if (inlineEl) {
        if (forgeState.totalBatches > 0) {
          inlineEl.textContent = `Idle · ${forgeState.totalProcessedKg}kg processed`;
        } else {
          inlineEl.textContent = 'Idle';
        }
        inlineEl.style.color = '#666';
      }
      if (progressContainer) progressContainer.style.display = 'none';

      // Sprint A2: Show forge hotkey hint when idle with cargo available.
      // Hotkey revamp 2026-06-14: the live Forge/Kiln binding is F (was 5/F4).
      // Keep this hint in sync with InputManager 'KeyF'.
      if (hintEl) {
        const hasCargo = this._cargoStatus && this._cargoStatus.totalMassKg > 0;
        if (hasCargo) {
          hintEl.style.display = '';
          hintEl.textContent = '▸ Press [F] to process cargo';
          hintEl.style.color = '#ffaa00';
        } else {
          hintEl.style.display = 'none';
        }
      }
      return;
    }

    // --- Active state: show progress bar ---
    const phase = forgeState.phase;
    const progressPct = (forgeState.phaseProgress * 100).toFixed(0);
    const color = phaseColors[phase] || '#ff9800';

    if (inlineEl) {
      inlineEl.textContent = phase;
      inlineEl.style.color = color;
    }

    if (progressContainer) progressContainer.style.display = '';

    if (progressBar) {
      progressBar.style.width = `${progressPct}%`;
      progressBar.style.backgroundColor = color;
    }

    if (batchLabel) {
      if (forgeState.currentBatch) {
        const b = forgeState.currentBatch;
        batchLabel.textContent = `${b.massKg.toFixed(1)}kg ${b.name} → ${b.outputMode}`;
        batchLabel.style.color = b.color || color;
      } else {
        batchLabel.textContent = '';
      }
    }

    if (pctLabel) {
      const remaining = Math.max(0, forgeState.phaseDuration - forgeState.phaseTimer);
      pctLabel.textContent = `${progressPct}% · ${remaining.toFixed(0)}s`;
      pctLabel.style.color = color;
    }

    // Hide hint while active
    if (hintEl) hintEl.style.display = 'none';
  }

  // ==========================================================================
  // F11: PROPULSION COLLAPSED SUMMARY UPDATER
  // ==========================================================================

  /** @private Update the propulsion collapsed summary fuel pips */
  _updatePropulsionPips() {
    const pipsEl = document.getElementById('propulsion-fuel-pips');
    if (!pipsEl || !this._lastResources) return;

    const r = this._lastResources;
    const xenonMax = r.xenonMax || Constants.XENON_FUEL_MAX;
    const coldGasMax = r.coldGasMax || Constants.COLD_GAS_MAX;
    const batteryMax = r.batteryMax || Constants.BATTERY_MAX;
    const xenonPct = (r.xenon / xenonMax) * 100;
    const coldGasPct = (r.coldGas / coldGasMax) * 100;
    const batteryPct = (r.battery / batteryMax) * 100;

    const pipColor = (pct) => pct > 30 ? '#00ff88' : pct > 15 ? '#ffaa00' : '#ff4444';
    const liPipColor = (pct) => pct > 30 ? '#88ccff' : pct > 15 ? '#ffaa00' : '#ff4444';

    // F16: Include lithium pip when MPD is unlocked
    const lithiumPip = this._mpdUnlocked
      ? (() => {
          const liMax = r.lithiumMax || Constants.MPD_LITHIUM_CAPACITY || 100;
          const liPct = liMax > 0 ? (r.lithium / liMax) * 100 : 0;
          return ` <span style="color:${liPipColor(liPct)};">●</span><span style="opacity:0.5;">Li</span>`;
        })()
      : '';

    pipsEl.innerHTML = `
      <span style="color:${pipColor(xenonPct)};">●</span><span style="opacity:0.5;margin-right:2px;">Xe</span>
      <span style="color:${pipColor(coldGasPct)};">●</span><span style="opacity:0.5;margin-right:2px;">Gs</span>
      <span style="color:${pipColor(batteryPct)};">●</span><span style="opacity:0.5;">Bt</span>${lithiumPip}
    `;
  }

  // ==========================================================================
  // F12: FLEET COLLAPSED SUMMARY UPDATER
  // ==========================================================================

  /**
   * @private Update the header line: the at-a-glance fleet aggregate (#5) and
   * the progressive-disclosure hotkey hint (#4). Kept separate from the card
   * list so it refreshes on the same cadence without rebuilding the rows.
   */
  _updateFleetHeader(statuses) {
    // Hotkey hint — full labels until the player has both launched and recalled,
    // then fade to terse glyphs. Mother (0), Recall-All (Shift+R) and De-spin (L)
    // are intentionally not advertised here to keep the line short.
    const hk = document.getElementById('fleet-hotkeys');
    if (hk) {
      const learned = this._fleetLaunchUsed && this._fleetRecallUsed;
      hk.innerHTML = learned
        ? '<span title="Select 1-4 · Launch D · Recall R">1-4 · D · R</span>'
        : '1-4 Select&ensp;D Launch&ensp;R Recall';
      hk.style.opacity = learned ? '0.28' : '0.5';
    }

    const agg = document.getElementById('fleet-aggregate');
    if (!agg) return;
    if (!statuses || statuses.length === 0) { agg.textContent = ''; return; }

    const isOut = (s) => s.state !== 'DOCKED' && s.state !== 'RELOADING' && s.state !== 'HOLDING_CATCH';
    const out = statuses.filter(isOut).length;
    const ready = statuses.filter(s => s.state === 'DOCKED' && s.springCharged).length;

    let attention = 0;
    statuses.forEach((s, idx) => {
      const tens = this._tetherTensions[idx];
      const crit = tens !== undefined && tens >= (Constants.REEL_TENSION_CRITICAL || 0.9);
      const tangled = this._tangleState && this._tangleState.armIndices.includes(idx);
      if (s.state === 'EXPENDED' || s.state === 'ADRIFT' || s.fuel <= 25 || s.hasCaptured || tangled || crit) attention++;
    });

    let txt, color, opacity;
    if (attention > 0) {
      txt = `${attention}⚠${out ? ` · ${out} out` : ''}`;
      color = '#ffaa00'; opacity = '0.95';
    } else if (out > 0) {
      txt = `${out} out · ${ready} ready`;
      color = '#aaffdd'; opacity = '0.75';
    } else {
      txt = `${ready} ready`;
      color = '#00ff88'; opacity = '0.7';
    }
    agg.textContent = txt;
    agg.style.color = color;
    agg.style.opacity = opacity;
  }

  /** @private Update the fleet collapsed summary with arm state counts */
  _updateFleetCollapsedSummary(statuses) {
    const el = document.getElementById('fleet-collapsed-summary');
    if (!el) return;

    if (!statuses || statuses.length === 0) {
      el.innerHTML = '<span style="opacity:0.5;font-size:10px;">No fleet</span>';
      return;
    }

    const stateColors = ARM_STATE_COLORS;

    // Count by state
    const counts = {};
    for (const a of statuses) {
      counts[a.state] = (counts[a.state] || 0) + 1;
    }

    const parts = Object.entries(counts).map(([state, count]) => {
      const color = stateColors[state] || '#888';
      return `${count}<span style="color:${color};">●</span>${state}`;
    });

    el.innerHTML = `<span style="white-space:nowrap;font-size:10px;">FLEET: ${parts.join(' ')}</span>`;
  }

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

    const status = this._cargoStatus;
    if (!status || status.totalMassKg <= 0) {
      // Sprint S2: Show empty cargo state for economy discovery
      el.style.display = '';
      el.innerHTML = `<span style="color:#555;">CARGO: 0/${status ? status.capacityKg : 500}kg</span>`;
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
        return `<span style="color:${m.color || '#aaa'}">${shortName}:${Math.round(m.massKg)}</span>`;
      })
      .join(' ');

    const pctUsed = status.utilizationPct || 0;
    const pctColor = pctUsed > 0.8 ? '#ffaa00' : '#00ff88';
    const massText = `${Math.round(status.totalMassKg)}/${status.capacityKg}kg`;

    el.innerHTML = `<span style="color:${pctColor};">CARGO:</span> ${massText} ${items ? '· ' + items : ''}`;
  }
}
