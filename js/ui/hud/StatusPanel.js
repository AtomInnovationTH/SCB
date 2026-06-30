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

// Shared "net" identity colour. NET reads the same ivory in BOTH the MOTHER
// digest (lasso ammo) and the DAUGHTERS list (per-unit magazine) so the player
// learns one colour for "nets". Low/empty still warns amber/red in both.
const NET_COLOR = '#f0ecd8'; // ivory white

export class StatusPanel {
  constructor(container) {
    this._container = container;
    this._armManager = null;
    this._initialDeltaV = null;
    this._captureNotifTimer = null;
    this._captureNotifEl = null;
    this._forgeRevealed = false;
    this._cargoStatus = null;   // cached from CARGO_UPDATED events
    this._lastPowerState = null;
    this._motherExpanded = false;     // MOTHER detail hover-expand state
    this._motherPinned = false;       // badge-pinned open (chrome 'normal' step)
    this._motherHovering = false;     // pointer currently over the MOTHER pane
    this._motherCollapseTimer = null;
    this._throttleLevel = 1.0;  // F14: cached throttle for HUD display
    this._autopilotMode = 'OFF'; // F15: cached autopilot mode for HUD
    this._autopilotPhase = 'OFF'; // Trailing-rendezvous phase (F15.1)
    this._mpdUnlocked = false;   // F16: MPD thruster unlocked flag
    this._mpdArmed = false;      // S3b: MPD burst mode state

    // V5: Crossbow arm HUD state
    this._tetherTensions = {};          // {armIndex: fraction} — cached from events
    this._tangleState = null;           // {armIndices, startTime, duration} — active tangle
    this._pulseScanState = 'READY';     // READY | SCANNING | COOLDOWN

    // ST-1.3: Lasso cooldown ring state
    this._lassoCooldownDuration = 0;    // total cooldown duration (s)
    this._lassoCooldownStart = 0;       // Date.now() when cooldown started
    this._lassoCooldownActive = false;  // true while cooling
    this._lassoDeniedFlash = 0;         // Date.now() timestamp of last denied flash

    // MOTHER readiness-digest dark-cockpit state — each segment reports whether
    // it is nominal; the line dims when all three are. Start nominal (quiet).
    this._netNominal = true;
    this._dvNominal = true;
    this._pwrNominal = true;

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
    // UX-3 #7: Lasso ammo tracking
    this._lassoAmmo = Constants.LASSO_AMMO_MAX;
    this._lassoAmmoMax = Constants.LASSO_AMMO_MAX;
    eventBus.on(Events.LASSO_AMMO_CHANGED, (data) => {
      this._lassoAmmo = data.remaining;
      this._lassoAmmoMax = data.max;
      this._updateNetDigest();
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
    // PRIORITY-LAYER CONTENT — restored to the documented "objective + quiet
    // wallet" intent: this most-seen, never-dimmed strip now carries ONLY the
    // hero CLEARED N/50 progress meter plus a quiet credit wallet.
    //   • The elevator-contract tracker was REMOVED from here. It is a slow,
    //     shop-driven, late-game objective that stays at 0 (and is mechanically
    //     unreachable — the Forge isn't taught in onboarding) for a new pilot's
    //     whole first session, so a static "0/10,000 kg" in this slot was clutter
    //     in premium real estate. It now lives gated atop the comms pane
    //     (CommsPanel._onContractUpdate), revealed on the first contribution,
    //     grouped with the channel that already narrates its milestones.
    //   • The daughter-tier badge (#hud-arm-tier, feature-flagged) moved to the
    //     DAUGHTERS pane header where it is contextual.
    this.panels.score.innerHTML = `
      <div style="display:flex;align-items:center;gap:14px;white-space:nowrap;line-height:1;">
        <div style="display:flex;align-items:baseline;gap:7px;">
          <span style="font-size:10px;letter-spacing:2px;opacity:0.7;text-transform:uppercase;">Cleared</span>
          <span style="font-size:18px;font-weight:bold;letter-spacing:1px;color:#00ff88;text-shadow:0 0 6px rgba(0,255,136,0.45);">
            <b id="hud-cleared">0</b><span style="opacity:0.5;font-weight:normal;font-size:13px;">/${Constants.WIN_DEBRIS_COUNT}</span>
          </span>
          <span id="hud-cleared-track" style="width:42px;height:3px;background:rgba(0,255,136,0.2);border-radius:2px;overflow:hidden;align-self:center;">
            <span id="hud-cleared-fill" style="display:block;width:0%;height:100%;background:#00ff88;transition:width 0.4s ease;"></span>
          </span>
        </div>
        <span style="color:#ffaa00;font-size:12px;font-weight:bold;opacity:0.85;">💰 <b id="hud-credits">0</b></span>
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
    this.panels.mother = this._createPanel('hud-mother-panel', {});
    this.panels.mother.className = 'hud-panel hud-panel-expandable';
    this.panels.mother.innerHTML = `
      <div class="mother-header pane-title" style="font-size:11px;margin-bottom:3px;color:#00ff88;opacity:0.7;display:flex;align-items:baseline;gap:6px;">
        <span>MOTHER</span>
      </div>
      <div id="mother-digest" style="font-size:11px;line-height:1.4;white-space:nowrap;display:flex;align-items:center;gap:6px;transition:opacity 0.3s ease;">
        <span id="mother-digest-net" style="display:inline-flex;align-items:center;gap:4px;color:${NET_COLOR};">
          <span class="md-label">NET</span>
          <span class="md-track"><span class="md-fill" id="mother-digest-net-fill"></span></span>
          <span class="md-count" id="mother-digest-net-count">${Constants.LASSO_AMMO_MAX}</span>
          <span id="mother-digest-net-reload" style="display:none;">↻</span>
        </span>
        <span class="md-sep">·</span>
        <span id="mother-digest-dv" style="display:inline-flex;align-items:center;gap:4px;color:#aaffdd;">
          <span class="md-label">ΔV</span>
          <span class="md-track"><span class="md-fill" id="mother-digest-dv-fill"></span></span>
          <span class="md-count" id="mother-digest-dv-pct" style="display:none;"></span>
        </span>
        <span class="md-sep">·</span>
        <span id="mother-digest-pwr" style="display:inline-flex;align-items:center;gap:3px;color:#00ff88;">
          <span>⚡</span>
          <span id="mother-digest-pwr-text" style="display:none;font-weight:bold;letter-spacing:0.05em;"></span>
        </span>
      </div>
      <div class="mother-detail">
        <div class="mother-block mother-block-propulsion" data-hud-group="fuel-group" data-activate-key="A">
      <div class="panel-full-content">
        <div class="pane-title" style="font-size:11px;margin-top:6px;margin-bottom:4px;color:#00ff88;opacity:0.7;">PROPULSION</div>
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
        </div>
        <div class="mother-block mother-block-energy" id="hud-power-panel" data-hud-group="power-group">
      <div class="panel-full-content">
        <div class="pane-title" style="font-size:11px;margin-top:6px;margin-bottom:4px;color:#00ff88;opacity:0.7;display:flex;justify-content:space-between;align-items:center;">
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
        </div>
      </div>
      `;
    this._leftColumn.appendChild(this.panels.mother);
    this.panels.mother.style.position = 'relative';
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
    this.panels.arms = this._createPanel('hud-arms-panel', {});
    this.panels.arms.className = 'hud-panel hud-panel-expandable';
    this.panels.arms.dataset.hudGroup = 'arms-group';
    this.panels.arms.dataset.activateKey = 'D';
    // DAUGHTERS pane: one always-visible list, one line per daughter (plain
    // status + fuel). No hover layer / no resize badge — the selected daughter
    // highlights and shows the single action it can take right now.
    this.panels.arms.innerHTML = `
      <div class="pane-title" id="fleet-header" style="font-size:11px;margin-bottom:3px;color:#00ff88;opacity:0.7;display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;">
        <span>DAUGHTERS</span>
        <span id="fleet-select-hint" style="font-weight:normal;letter-spacing:normal;font-size:10px;opacity:0.4;white-space:nowrap;">select 1–4</span>
        <span id="hud-arm-tier" title="Current daughter configuration tier"
              style="display:none;color:#ff8800;font-weight:normal;letter-spacing:0.05em;font-size:10px;">Y0 Quad. 4 daughters</span>
      </div>
      <div id="hud-arms-status" style="font-size:11px;line-height:1.6;">
        <span style="opacity:0.5">Initializing daughter fleet…</span>
      </div>
    `;
    this._leftColumn.appendChild(this.panels.arms);
    this.panels.arms.style.position = 'relative';

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
    this.panels.mother.addEventListener('mouseenter', () => {
      this._motherHovering = true;
      this._expandMother();
    });
    this.panels.mother.addEventListener('mouseleave', () => {
      this._motherHovering = false;
      this._scheduleMotherCollapse();
    });
    // Reflect the initial compact step in the detail visibility + energy block.
    this._onMotherStep('min');

    // Phase 5 → R3 (relocated): the elevator-contract tracker used to live in the
    // top-center score strip and was ALWAYS visible. It moved to a gated header
    // atop the comms pane (CommsPanel._onContractUpdate) — revealed only once the
    // player makes their first contribution (contractMassKg > 0) — so a new pilot
    // isn't shown a static, unreachable 0/10,000 objective in the most-seen HUD
    // slot. The comms zone already narrates the contract milestones
    // (MissionMilestones), so the tracker and its narration share one cluster.

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
    this._updateNetDigest();
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
   * Update the MOTHER digest's Net segment (`mother-digest-net`).
   *
   * Reframe: the net is a depleting-magazine gauge — a thin bar (fraction
   * remaining) with the charges count as the hero number, mirroring the score
   * mini-track. The ~2s reload gap pulses the fill + shows a `↻` glyph (the
   * reticle owns the fire moment, so no cooldown ring here). Color tiers: ≤5
   * red, ≤10 amber, else ivory. Empty/`0` red at depletion; brief red flash on a
   * denied fire. Updates stable child nodes (no per-tick innerHTML reparse).
   * @private
   */
  _updateNetDigest() {
    const seg = document.getElementById('mother-digest-net');
    const fill = document.getElementById('mother-digest-net-fill');
    const count = document.getElementById('mother-digest-net-count');
    const reloadGlyph = document.getElementById('mother-digest-net-reload');
    if (!seg || !fill || !count) return;

    const ammo = this._lassoAmmo ?? Constants.LASSO_AMMO_MAX;
    const ammoMax = this._lassoAmmoMax ?? Constants.LASSO_AMMO_MAX;
    const pct = ammoMax > 0 ? Math.max(0, Math.min(100, (ammo / ammoMax) * 100)) : 0;
    let color = ammo <= 5 ? '#ff4444' : ammo <= 10 ? '#ffaa00' : NET_COLOR;

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
    if (denied) color = '#ff4444';

    fill.style.width = `${pct}%`;
    fill.style.backgroundColor = color;
    count.textContent = String(Math.max(0, ammo));
    count.style.color = color;

    if (reloadGlyph) reloadGlyph.style.display = reloading ? '' : 'none';
    seg.classList.toggle('reloading', reloading);

    // Nominal = plenty of charges, not reloading, not just denied. Drives the
    // dark-cockpit dimming of the whole digest line.
    this._netNominal = ammo > 10 && !reloading && !denied;
    this._refreshDigestDim();
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
   * Phase segment is hidden when the AP is OFF.
   */
  _updateAutopilotIndicator() {
    const el = document.getElementById('autopilot-indicator');
    const phaseLabel = _PHASE_LABELS[this._autopilotPhase] || '';

    if (this._autopilotMode === 'OFF') {
      if (el) {
        el.textContent = '[Autopilot: OFF]';
        el.style.color = '#555';
        el.style.borderColor = 'rgba(255,255,255,0.1)';
        el.style.background = 'rgba(0,0,0,0.4)';
      }
    } else {
      const fullLabel = phaseLabel
        ? `[Autopilot: ${this._autopilotMode} · ${phaseLabel}]`
        : `[Autopilot: ${this._autopilotMode}]`;
      if (el) {
        el.textContent = fullLabel;
        el.style.color = '#00ff88';
        el.style.borderColor = 'rgba(0,255,136,0.5)';
        el.style.background = 'rgba(0,255,136,0.08)';
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
      #mother-digest .md-track {
        width: 38px;
        height: 3px;
        border-radius: 2px;
        overflow: hidden;
        display: inline-block;
        background: rgba(255, 255, 255, 0.12);
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
      @keyframes mother-net-reload {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.3; }
      }
      #mother-digest-net.reloading #mother-digest-net-fill {
        animation: mother-net-reload 0.7s ease-in-out infinite;
      }
      #mother-digest-net-reload { opacity: 0.8; }
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
    const colors = { thrust: '#00ff88', sensors: '#4488ff', arms: '#00ff88' };

    // Track starvation for the digest power glyph.
    let anyStarved = false;

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

      if (state[bus] === 0) anyStarved = true;
    }

    // Digest ⚡ glyph — derived power health.
    this._updatePowerDigestGlyph(anyStarved);
  }

  /**
   * @private Update the MOTHER digest `⚡` power-health glyph.
   * Dark-cockpit: the glyph is colour-coded and a word only appears on a fault.
   * Green (no word) when battery >20% and no bus starved; amber `LOW` at 5–20%
   * or a starved bus; red `CRIT` <5%. Battery comes from the last cached payload.
   * @param {boolean} anyStarved — true if any power bus is allocated 0%.
   */
  _updatePowerDigestGlyph(anyStarved) {
    const seg = document.getElementById('mother-digest-pwr');
    const txt = document.getElementById('mother-digest-pwr-text');
    if (!seg) return;

    const res = this._lastResources || {};
    const batteryMax = res.batteryMax || Constants.BATTERY_MAX || 100;
    const batteryPct = batteryMax > 0 && res.battery != null
      ? (res.battery / batteryMax) * 100
      : 100;

    let color, label;
    if (batteryPct < 5) {
      color = '#ff4444';
      label = 'CRIT';
    } else if (batteryPct < 20 || anyStarved) {
      color = '#ffaa00';
      label = 'LOW';
    } else {
      color = '#00ff88';
      label = '';
    }
    seg.style.color = color;
    if (txt) {
      txt.textContent = label;
      txt.style.display = label ? '' : 'none';
    }

    this._pwrNominal = !label;
    this._refreshDigestDim();
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
    const allNominal =
      this._netNominal !== false &&
      this._dvNominal !== false &&
      this._pwrNominal !== false;
    digest.style.opacity = allNominal ? '0.5' : '1';
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

    // Color transitions based on percentage (synchronized with audio tiers: 30/15/5/1%).
    // Shared ladder (_dvColorTier) so the detail bar and the MOTHER digest segment
    // below cannot drift. The detail bar uses solid green as its nominal colour.
    {
      const tier = this._dvColorTier(pct, '#00ff88');
      fill.style.backgroundColor = tier.color;
      fill.style.animation = tier.anim;
    }

    text.textContent = `ΔV: ${Math.round(dv)} m/s • ${Math.round(pct)}%`;
    if (barText) barText.textContent = `${Math.round(dv)} m/s`;

    // Color the text label too
    if (pct <= 5) {
      text.style.color = '#ff4444';
    } else if (pct <= 15) {
      text.style.color = '#ffaa00';
    } else {
      text.style.color = '#aaffdd';
    }

    // MOTHER digest ΔV segment — a thin remaining-budget gauge; the `%` text
    // appears only when low (≤30%), dark-cockpit style. The bar fraction is the
    // honest "what can I still do before I refuel?" read and uses the SAME
    // _dvColorTier ladder as the detail bar above (only the nominal colour
    // differs: the digest uses the dimmer teal), so the two never diverge.
    //
    // (This replaced `~N transfers` — shipΔV ÷ avg cost of the 5 nearest targets.
    // That metric was degenerate: the nearest targets are the ones you're already
    // co-orbital with, so their cost rounds to a few m/s and hit the 10 m/s floor,
    // collapsing the readout to shipΔV/10 (~300) regardless of tactical state.)
    const dvFill = document.getElementById('mother-digest-dv-fill');
    const dvPct = document.getElementById('mother-digest-dv-pct');
    if (dvFill) {
      dvFill.style.width = `${pct}%`;
      const tier = this._dvColorTier(pct, '#aaffdd');
      dvFill.style.backgroundColor = tier.color;
      dvFill.style.animation = tier.anim;
      if (dvPct) {
        if (pct <= 30) {
          dvPct.style.display = '';
          dvPct.textContent = `${Math.round(pct)}%`;
          dvPct.style.color = tier.color;
        } else {
          dvPct.style.display = 'none';
        }
      }
      this._dvNominal = pct > 30;
      this._refreshDigestDim();
    }
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
    if (pct > 15) return { color: '#ffaa00', anim: 'none' };
    if (pct > 5)  return { color: '#ff4444', anim: 'none' };
    // 5%-1%: pulsing red. <1%: faster strobe matching the continuous audio warble.
    if (pct > 1)  return { color: '#ff4444', anim: 'deltav-pulse 0.8s ease-in-out infinite' };
    return { color: '#ff4444', anim: 'deltav-pulse 0.3s ease-in-out infinite' };
  }

  /** @private Render the V5 crossbow arm status panel */
  _renderArmPanel() {
    const el = document.getElementById('hud-arms-status');
    if (!el) return;

    if (!this._armManager) {
      el.innerHTML = '<span style="opacity:0.5">No daughters</span>';
      this._updateFleetHeader();
      return;
    }

    const statuses = this._armManager.getAllStatus();
    if (statuses.length === 0) {
      el.innerHTML = '<span style="opacity:0.5">No daughters</span>';
      this._updateFleetHeader();
      return;
    }

    // List by size: Large daughters (weavers) first, then Small (spinners). A
    // small gap separates the two size groups — no headers, no resized rows.
    const sizeRank = { weaver: 0, spinner: 1 };
    const sorted = statuses
      .map((a, idx) => ({ a, idx }))
      .sort((x, y) => (sizeRank[x.a.type] ?? 2) - (sizeRank[y.a.type] ?? 2) || x.idx - y.idx);

    let prevType = null;
    el.innerHTML = sorted.map((e) => {
      const gap = (prevType !== null && e.a.type !== prevType) ? '<div style="height:6px;"></div>' : '';
      prevType = e.a.type;
      return gap + this._renderDaughterLine(e.a, e.idx);
    }).join('');

    this._updateFleetHeader();
  }

  /**
   * @private Plain-English status word + colour for one daughter — what it's
   * doing, in words a new player understands (not the internal state enum).
   * Critical tether stress / tangle override the state so trouble reads first.
   * @returns {{label: string, color: string}}
   */
  _daughterStatus(a, idx) {
    const tens = this._tetherTensions[idx];
    const tangled = this._tangleState && this._tangleState.armIndices.includes(idx);
    if (a.state === 'TANGLED' || tangled) return { label: 'Tangled', color: '#ffaa00' };
    if (tens !== undefined && tens >= (Constants.REEL_TENSION_CRITICAL || 0.9)
        && a.state !== 'DOCKED' && a.state !== 'RELOADING') {
      return { label: 'Tether stress', color: '#ff4444' };
    }

    switch (a.state) {
      case 'DOCKED':
        return a.springCharged
          ? { label: 'Ready', color: '#00ff88' }
          : { label: 'Charging', color: '#ffaa00' };
      case 'RELOADING':
        return { label: `Reloading ${Math.round((a.reloadProgress || 0) * 100)}%`, color: '#00ffff' };
      case 'LAUNCHING': case 'UNDOCKING': case 'TRANSIT':
        return { label: 'Heading out', color: '#00ffff' };
      case 'APPROACH': case 'STATION_KEEP':
        return { label: 'Approaching', color: '#00ffff' };
      case 'NETTING': case 'GRAPPLED': case 'MAGNETIC_GRAPPLE':
      case 'GRIPPER_GRAPPLE': case 'PAD_CONTACT': case 'WEB_SHOT':
        return { label: 'Capturing', color: '#00ffff' };
      case 'REELING': case 'HAULING': case 'RETURNING': case 'DOCKING':
        return { label: 'Returning', color: '#00ffff' };
      case 'HOLDING_CATCH':
        return { label: 'Catch aboard', color: '#ffaa00' };
      case 'FISHING': case 'TRAWLING':
        return { label: 'Fishing', color: '#00ff88' };
      case 'SCANNING':
        return { label: 'Scanning', color: '#4488ff' };
      case 'ABLATING':
        return { label: 'De-spinning', color: '#00ffff' };
      case 'DEORBITING':
        return { label: 'Deorbiting', color: '#ff4444' };
      case 'ADRIFT':
        return { label: 'Adrift', color: '#ffaa00' };
      case 'EXPENDED':
        return { label: 'Lost', color: '#ff4444' };
      default:
        return { label: a.state, color: '#888' };
    }
  }

  /**
   * @private The hotkey hint shown on the selected daughter's 2nd line — the
   * key(s) relevant to its current state, in plain words. Empty when it's busy /
   * not actionable. Daughters fly on autopilot, so the only verbs surfaced are
   * launch (D) and recall (R).
   */
  _daughterHotkeys(a) {
    const key = (k, verb) => `<span style="color:#00ffff;font-weight:bold;">${k}</span>`
      + `<span style="opacity:0.8;"> ${verb}</span>`;
    switch (a.state) {
      case 'DOCKED':
        return (a.springCharged && a.fuel > 0) ? key('D', 'launch') : '';
      case 'EXPENDED': case 'RELOADING': case 'HOLDING_CATCH': case 'DOCKING':
        return '';
      case 'ADRIFT':
        return key('R', 'reel in');
      default:
        return key('R', 'recall');
    }
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

    const { label: status, color: statusColor } = this._daughterStatus(a, idx);
    const catchFlag = a.hasCaptured ? ' <span title="Carrying a catch">🎣</span>' : '';

    // NET — each daughter's own magazine. Same ivory NET colour as the MOTHER
    // pane (shared NET_COLOR), warning amber at half / red at empty (at 0 it
    // can't capture). Net inventory isn't in getStatus, so read the arm object
    // directly. Always emit a cell (empty when absent) to keep columns aligned.
    const armObj = this._armManager ? this._armManager.arms[idx] : null;
    let netHtml = '<span></span>';
    if (armObj && typeof armObj.getNetInventory === 'function') {
      const nets = armObj.getNetInventory();
      const maxNets = typeof armObj.getNetInventoryMax === 'function' ? armObj.getNetInventoryMax() : 0;
      const netColor = nets <= 0 ? '#ff4444' : (maxNets > 0 && nets <= maxNets * 0.5) ? '#ffaa00' : NET_COLOR;
      netHtml = `<span style="color:${netColor};white-space:nowrap;" title="Nets remaining">NET ${nets}</span>`;
    }

    // ΔV — same label/colour ladder as the MOTHER pane (no fuel-gauge icon).
    // Daughter ΔV is its fuel % × type budget (getStatus.remainingDeltaV is
    // unreliable, so derive it). Right-aligned so it hugs the pane's right edge.
    const fuelPct = Math.round(a.fuel ?? 0);
    const dvMax = a.type === 'weaver' ? (Constants.WEAVER_DELTA_V || 500)
      : (Constants.SPINNER_DELTA_V || 297);
    const dv = Math.round((fuelPct / 100) * dvMax);
    const dvColor = this._dvColorTier(fuelPct, '#aaffdd').color;
    const dvHtml = `<span style="color:${dvColor};white-space:nowrap;text-align:right;" title="Maneuver budget (ΔV)">ΔV ${dv}</span>`;

    const numHtml = isSel
      ? `<span style="color:#00ffff;font-weight:bold;">▸${label}</span>`
      : `<span style="opacity:0.6;">${label}</span>`;

    // Line 1 — details laid out as fixed columns so N · status · NET · ΔV line up
    // vertically down the list. The number column is right-aligned (the ▸ marker
    // hangs left of the digit); the ΔV column is right-aligned to the pane edge.
    const detailLine = `<div style="display:grid;grid-template-columns:20px 1fr 50px 56px;column-gap:8px;align-items:baseline;">`
      + `<span style="text-align:right;">${numHtml}</span>`
      + `<span style="color:${statusColor};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${status}${catchFlag}</span>`
      + netHtml
      + dvHtml
      + `</div>`;

    if (!isSel) {
      return `<div style="padding:1px 4px;border-left:2px solid transparent;">${detailLine}</div>`;
    }

    // Line 2 — the relevant hotkey(s), indented to sit under the status column.
    const keys = this._daughterHotkeys(a);
    const keysLine = `<div style="padding-left:28px;font-size:10px;margin-top:1px;">`
      + (keys || '<span style="opacity:0.4;">busy…</span>')
      + `</div>`;

    return `<div style="padding:2px 4px;background:rgba(0,255,255,0.08);border-left:2px solid #00ffff;">`
      + detailLine
      + keysLine
      + `</div>`;
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
  // DAUGHTERS PANE: HEADER
  // ==========================================================================

  /**
   * @private Update the header. Shows a faint "select 1–4" hint while no
   * daughter is selected (the entry point for new players); once one is
   * selected, that daughter's line carries the contextual action prompt so the
   * hint is redundant and hidden.
   */
  _updateFleetHeader() {
    const hint = document.getElementById('fleet-select-hint');
    if (!hint) return;
    const hasSelection = !!this._armManager && this._armManager.selectedArmIndex >= 0;
    hint.style.display = hasSelection ? 'none' : '';
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
