/**
 * TargetReticle.js — Canvas 2D overlay for HUD reticle tracking
 * Inspired by Independence War (iWar) and MechWarrior 2 target tracking.
 * Projects 3D debris positions to 2D screen space and draws:
 *  - On-screen reticles (brackets/diamonds) with distance labels
 *  - Off-screen directional arrows along screen edges
 *  - Lead indicators and velocity vectors for selected target
 * @module ui/TargetReticle
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { GameStates } from '../core/GameState.js';
import { orbitToSceneCartesian, orbitToSceneCartesianInto, keplerianToCartesian, orbitToKm } from '../entities/OrbitalMechanics.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

const MAX_RETICLE_RANGE = 1.0;        // 100km in scene units
const OFFSCREEN_ARROW_RANGE = 0.5;    // 50km for off-screen arrows
const ACTIVE_SAT_ARROW_RANGE = 0.2;   // 20km for active sat warnings
const EDGE_PADDING = 40;              // px from screen edge for arrows
const RETICLE_MIN_SIZE = 12;          // px minimum bracket size
const RETICLE_MAX_SIZE = 60;          // px maximum bracket size
const SELECTED_RETICLE_SCALE = 1.6;   // Selected target is bigger
const PULSE_SPEED = 3.0;             // Hz for pulsing effects
const CALLOUT_DURATION = 8;          // seconds for first-encounter callout labels

/** Color scheme */
const COLORS = {
  green:   '#00ff88',
  yellow:  '#ffaa00',
  red:     '#ff4444',
  white:   '#ffffff',
  cyan:    '#4488ff',
  cyanDim: 'rgba(68,136,255,0.4)',
  magenta: '#ff44ff',
};

/** Contact type icon symbols */
const TYPE_ICONS = {
  'rocketBody':    '⬡',   // hexagon — large cylindrical
  'defunctSat':    '◈',   // diamond — satellite
  'fragment':      '◇',   // small diamond — fragment
  'missionDebris': '•',   // dot — small hardware
};

// ============================================================================
// TARGET RETICLE SYSTEM
// ============================================================================

export class TargetReticle {
  /**
   * @param {THREE.PerspectiveCamera} camera - The scene camera
   */
  constructor(camera) {
    this.camera = camera;

    /** @type {HTMLCanvasElement} */
    this.canvas = null;
    /** @type {CanvasRenderingContext2D} */
    this.ctx = null;

    this._width = 0;
    this._height = 0;
    this._halfW = 0;
    this._halfH = 0;

    // Reusable math objects
    this._tempVec3 = new THREE.Vector3();
    this._tempVec4 = new THREE.Vector4();
    this._projMatrix = new THREE.Matrix4();

    // Sprint 2 / PR A — scratch outputs for [`orbitToSceneCartesianInto`](js/entities/OrbitalMechanics.js:1).
    // Hot path: per visible target per frame (5–15 calls/frame typical).
    this._tmpCartPos = { x: 0, y: 0, z: 0 };
    this._tmpCartVel = { x: 0, y: 0, z: 0 };

    // Cached target data
    this._selectedTargetId = null;
    this._capturedIds = new Set();  // UX Fix E+: Skip rendering captured debris
    this._debrisTargets = [];
    this._activeSatTargets = [];
    this._time = 0;

    // Closure rate tracking
    this.previousDistances = new Map();
    this._dt = 0;

    // First-encounter callout tracking
    this._progradeFirstSeen = false;
    this._retroFirstSeen = false;
    this._leadFirstSeen = false;
    this._progradeCalloutTimer = 0;
    this._retroCalloutTimer = 0;
    this._leadCalloutTimer = 0;

    // Phase 1: Telemetry & relative velocity tracking
    this._deltaVSpent = 0;
    this._thrustDirection = null;
    this._relativeVelocity = 0;  // relative to selected target, in km/s

    // Phase R6: Closure rate / ETA for selected target (prograde marker)
    this._selectedTargetDistKm = 0;
    this._prevSelectedTargetDist = null;
    this._prevClosureTargetId = null;   // reset tracking on target switch
    this._selectedClosureRate = 0;      // km/s, positive = closing

    // Phase R6: Cached player ΔV from PLAYER_TELEMETRY event
    this._cachedPlayerDeltaV = 0;

    // Phase R6: Periapsis proximity flag for Oberth hint
    this._nearPeriapsis = false;

    // Phase 5: Target Lock Ceremony animation state
    this._lockAnimT = 1;              // 0→1 over 300ms (1 = complete/idle)
    this._lockAnimActive = false;
    this._lockLostAnimT = 1;          // 0→1 over 200ms (1 = complete/idle)
    this._lockLostAnimActive = false;
    this._lockLostTargetId = null;    // ID of target being animated out

    // Phase 7: Autopilot visual indicator state
    this._apEngaged = false;
    this._apMode = '';
    this._apTargetName = '';
    this._selectedScreenPos = null;   // { x, y } screen coords of selected target

    // Listen for target events to trigger lock ceremonies
    eventBus.on(Events.TARGET_SELECTED, () => {
      this._lockAnimT = 0;
      this._lockAnimActive = true;
      this._lockLostAnimActive = false; // Cancel any active lost animation
    });

    eventBus.on(Events.TARGET_CLEARED, () => {
      this._lockLostAnimT = 0;
      this._lockLostAnimActive = true;
      this._lockLostTargetId = this._selectedTargetId;
      this._selectedTargetId = null; // Clear so brackets transition to lock-lost rendering
      this._selectedInRange = true;  // reset range state on clear
    });

    // Reward-first spine: track whether the selected target is inside net-lock
    // range. Drives the yellow "OUT OF RANGE" reticle state (out) vs the cyan
    // lock (in). AutoLockController emits these on the crossing.
    this._selectedInRange = true;
    eventBus.on(Events.TARGET_IN_RANGE, () => { this._selectedInRange = true; });
    eventBus.on(Events.TARGET_OUT_OF_RANGE, () => { this._selectedInRange = false; });

    // Phase 6: Lasso feedback state
    this._lassoInFlight = false;        // true while lasso projectile is active
    this._lassoCooldownTimer = 0;       // >0 after capture/cancel, counts down
    this._lassoCooldownMax = 2;         // matches LassoSystem cooldown (2s)
    this._lassoFlightTimeout = 0;       // safety: auto-clear in-flight after max time
    this._lassoDeniedTimer = 0;         // >0 = show denied red flash
    this._lassoShakeTimer = 0;          // >0 = screen micro-shake active
    this._lassoContactFlashTimer = 0;   // >0 = flash target bracket white
    this._lassoContactTargetId = null;  // ID of target hit by lasso

    // S9-B: Catch pulse state — bracket expand + green flash on capture
    this._catchPulseActive = false;
    this._catchPulseTime = 0;           // countdown from 0.3 → 0

    eventBus.on(Events.LASSO_FIRED, () => {
      this._lassoInFlight = true;
      this._lassoCooldownTimer = 0;     // Not cooling yet — in flight
      this._lassoFlightTimeout = 65;    // 60s max flight + margin
      this._lassoShakeTimer = 0.1;      // 100ms micro-shake
    });

    eventBus.on(Events.LASSO_CAPTURED, (data) => {
      this._lassoInFlight = false;
      this._lassoCooldownTimer = this._lassoCooldownMax; // Start actual cooldown
      this._lassoFlightTimeout = 0;
      this.showCatchPulse(); // S9-B: bracket pulse on lasso catch
      // UX Fix E+: Hide captured debris reticle immediately
      if (data && data.debrisId) this._capturedIds.add(data.debrisId);
    });

    // S9-B: Bracket pulse on arm capture
    eventBus.on(Events.ARM_CAPTURED, (data) => {
      this.showCatchPulse();
      // UX Fix E+: Hide captured debris reticle immediately
      if (data && data.targetId) this._capturedIds.add(data.targetId);
    });

    // UX Fix E+: Cleanup captured ID when debris is fully removed from field
    eventBus.on(Events.DEBRIS_REMOVED, (data) => {
      if (data && data.id) this._capturedIds.delete(data.id);
    });

    eventBus.on(Events.LASSO_DENIED, () => {
      this._lassoDeniedTimer = 0.3; // 300ms red flash on arc
    });

    eventBus.on(Events.LASSO_CONTACT, (data) => {
      this._lassoContactFlashTimer = 0.2; // 200ms bracket flash
      this._lassoContactTargetId = data.targetId;
    });

    // Phase 7: Autopilot indicator events
    eventBus.on(Events.AUTOPILOT_ENGAGE, (data) => {
      this._apEngaged = true;
      this._apMode = data.mode || '';
      this._apTargetName = data.targetName || data.mode || '';
    });
    eventBus.on(Events.AUTOPILOT_DISENGAGE, () => {
      this._apEngaged = false;
    });

    // View-config flags (set by CameraSystem progressive info levels)
    this._viewConfig = {
      showClosureRate: true,
      showTypeIcons: true,
      showVelocityVectors: true,
      showLeadIndicators: true,
    };

    this._createCanvas();
    this._onResize();
    window.addEventListener('resize', () => this._onResize());

    // Self-manage visibility via EventBus (decoupled from GameFlowManager)
    eventBus.on(Events.VIEW_CONFIG_CHANGE, (config) => {
      this.setViewConfig(config);
    });
    eventBus.on(Events.GAME_STATE_CHANGE, ({ to }) => {
      const gameplay = (to === GameStates.ORBITAL_VIEW || to === GameStates.APPROACH || to === GameStates.INTERACTION);
      this.setVisible(gameplay);
    });
    eventBus.on(Events.HUD_TARGET_CLICK, (data) => {
      this.setSelectedTarget(data.id);
    });

    // Phase R6: Listen for telemetry to cache player ΔV for post-burn readout
    eventBus.on(Events.PLAYER_TELEMETRY, (t) => {
      if (t.resources) {
        // Compute current ΔV via Tsiolkovsky (mirrors ArmManager.getMassBudget)
        const coreDry = Constants.OCTOPUS_CORE_DRY_MASS || 214;
        const xenonMax = Constants.OCTOPUS_CORE_XENON || 12;
        const coldGasMax = Constants.OCTOPUS_CORE_COLD_GAS || 2;
        const xenonPoolMax = Constants.XENON_FUEL_MAX || 50;
        const coldGasPoolMax = Constants.COLD_GAS_MAX || 20;
        const xenonPct = (t.resources.xenon || 0) / xenonPoolMax;
        const xenonCurrent = xenonMax * xenonPct;
        const coldGasCurrent = coldGasMax * ((t.resources.coldGas || 0) / coldGasPoolMax);
        const wetMass = coreDry + xenonCurrent + coldGasCurrent;
        const dryMass = coreDry;
        const isp = Constants.OCTOPUS_CORE_HALL_ISP || 1600;
        const g0 = Constants.G0 || 9.80665;
        this._cachedPlayerDeltaV = (dryMass > 0 && wetMass > dryMass)
          ? isp * g0 * Math.log(wetMass / dryMass)
          : 0;
      }
    });
  }

  // ==========================================================================
  // CANVAS SETUP
  // ==========================================================================

  /** @private Create the 2D canvas overlay */
  _createCanvas() {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'reticle-canvas';
    this.canvas.style.cssText = `
      position: fixed; top: 0; left: 0;
      width: 100%; height: 100%;
      pointer-events: none;
      z-index: 11;
    `;
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
  }

  /** @private Handle window resize */
  _onResize() {
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.dpr = dpr;
    this._width = window.innerWidth;
    this._height = window.innerHeight;
    this._halfW = this._width / 2;
    this._halfH = this._height / 2;
    this.canvas.width = this._width * dpr;
    this.canvas.height = this._height * dpr;
    this.canvas.style.width = this._width + 'px';
    this.canvas.style.height = this._height + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  /**
   * Set the currently selected target ID.
   * @param {number|null} id
   */
  setSelectedTarget(id) {
    this._selectedTargetId = id;
  }

  /**
   * Set view-level rendering config (from CameraSystem info levels).
   * @param {object} config
   */
  setViewConfig(config) {
    if (!config) return;
    if (config.showClosureRate !== undefined)    this._viewConfig.showClosureRate    = config.showClosureRate;
    if (config.showTypeIcons !== undefined)      this._viewConfig.showTypeIcons      = config.showTypeIcons;
    if (config.showVelocityVectors !== undefined) this._viewConfig.showVelocityVectors = config.showVelocityVectors;
    if (config.showLeadIndicators !== undefined) this._viewConfig.showLeadIndicators  = config.showLeadIndicators;
  }

  /**
   * Main update — called each frame from the game loop.
   * @param {number} dt - Delta time
   * @param {object} data - Game data
   * @param {object} data.debrisField - DebrisField instance
   * @param {object} data.activeSatellites - ActiveSatellites instance
   * @param {THREE.Vector3} data.playerPos - Player position
   * @param {object} data.targetSelector - TargetSelector for selected target
   * @param {object} [data.playerVel] - Player velocity { x, y, z }
   */
  update(dt, data) {
    this._time += dt;
    this._dt = dt;

    // Decrement first-encounter callout timers
    if (this._progradeCalloutTimer > 0) this._progradeCalloutTimer -= dt;
    if (this._retroCalloutTimer > 0) this._retroCalloutTimer -= dt;
    if (this._leadCalloutTimer > 0) this._leadCalloutTimer -= dt;

    // Advance lock ceremony timers
    if (this._lockAnimActive) {
      this._lockAnimT += dt / 0.3; // 300ms duration
      if (this._lockAnimT >= 1) {
        this._lockAnimT = 1;
        this._lockAnimActive = false;
      }
    }
    if (this._lockLostAnimActive) {
      this._lockLostAnimT += dt / 0.2; // 200ms duration
      if (this._lockLostAnimT >= 1) {
        this._lockLostAnimT = 1;
        this._lockLostAnimActive = false;
        this._lockLostTargetId = null;
      }
    }

    // Phase 6: Advance lasso feedback timers
    if (this._lassoCooldownTimer > 0) this._lassoCooldownTimer -= dt;
    if (this._lassoDeniedTimer > 0) this._lassoDeniedTimer -= dt;
    if (this._lassoShakeTimer > 0) this._lassoShakeTimer -= dt;
    if (this._lassoContactFlashTimer > 0) this._lassoContactFlashTimer -= dt;
    if (this._lassoFlightTimeout > 0) {
      this._lassoFlightTimeout -= dt;
      if (this._lassoFlightTimeout <= 0) {
        this._lassoInFlight = false; // Safety: clear stale in-flight state
        this._lassoCooldownTimer = 1; // Show brief cooldown arc for cancel case
      }
    }

    // S9-B: Advance catch pulse timer
    if (this._catchPulseActive) {
      this._catchPulseTime -= dt;
      if (this._catchPulseTime <= 0) {
        this._catchPulseActive = false;
        this._catchPulseTime = 0;
      }
    }

    this.ctx.clearRect(0, 0, this._width, this._height);

    // Phase 6: Screen micro-shake on lasso fire (2px, 100ms)
    const doShake = this._lassoShakeTimer > 0;
    if (doShake) {
      this.ctx.save();
      this.ctx.translate((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4);
    }

    if (!data || !data.playerPos) {
      if (doShake) this.ctx.restore();
      // 2026-05-15 polish task 4: also gate the early-return arc on SK,
      // matching the main-path gate below at line ~544. Without this the
      // green "Ready" ring would still render on the first frame after
      // SK entry while data is briefly absent.
      if (!data || data.skTargetId == null) {
        this._drawLassoCooldownArc();
      }
      return;
    }

    // Capture Phase 1 telemetry
    if (data.telemetry) {
      this._deltaVSpent = data.telemetry.deltaVSpent || 0;
      this._thrustDirection = data.telemetry.thrustDirection || null;
    }

    const { debrisField, activeSatellites, playerPos, targetSelector } = data;

    // Compute relative velocity to selected target
    this._relativeVelocity = 0;
    if (targetSelector && data.playerVel && data.playerOrbit) {
      const activeTarget = targetSelector.getActiveTarget();
      if (activeTarget && activeTarget.orbit) {
        // Sprint 2 / PR A — scratch-output variant.
        orbitToSceneCartesianInto(activeTarget.orbit, this._tmpCartPos, this._tmpCartVel);
        const rv = this._tmpCartVel;     // km/s
        const pv = data.playerVel;       // km/s
        const dvx = rv.x - pv.x;
        const dvy = rv.y - pv.y;
        const dvz = rv.z - pv.z;
        this._relativeVelocity = Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz);
      }
    }

    // Phase R6: Track selected target distance for prograde closure rate + ETA
    this._selectedTargetDistKm = 0;
    this._selectedClosureRate = 0;
    if (targetSelector && data.playerPos) {
      const selTarget = targetSelector.getActiveTarget();
      const selTargetId = selTarget ? selTarget.id : null;
      // Reset previous distance when target changes to avoid closure rate spikes
      if (selTargetId !== this._prevClosureTargetId) {
        this._prevSelectedTargetDist = null;
        this._prevClosureTargetId = selTargetId;
      }
      if (selTarget && selTarget.orbit) {
        // Sprint 2 / PR A — scratch-output variant.
        orbitToSceneCartesianInto(selTarget.orbit, this._tmpCartPos, this._tmpCartVel);
        const tp = this._tmpCartPos;
        const dx = tp.x - data.playerPos.x;
        const dy = tp.y - data.playerPos.y;
        const dz = tp.z - data.playerPos.z;
        const distKm = Math.sqrt(dx * dx + dy * dy + dz * dz) / Constants.SCENE_SCALE;
        this._selectedTargetDistKm = distKm;
        if (this._dt > 0 && this._prevSelectedTargetDist !== null) {
          this._selectedClosureRate = (this._prevSelectedTargetDist - distKm) / this._dt;
        }
        this._prevSelectedTargetDist = distKm;
      } else {
        this._prevSelectedTargetDist = null;
      }
    }

    // Phase R6: Periapsis detection for Oberth efficiency hint
    this._nearPeriapsis = false;
    if (data.playerOrbit) {
      const ecc = data.playerOrbit.eccentricity || 0;
      const ta = data.playerOrbit.trueAnomaly || 0;
      if (ecc > 0.01) {
        this._nearPeriapsis = (ta < Math.PI / 6) || (ta > (2 * Math.PI - Math.PI / 6));
      }
    }

    // Update projection matrix
    this.camera.updateMatrixWorld();
    this._projMatrix.multiplyMatrices(
      this.camera.projectionMatrix,
      this.camera.matrixWorldInverse
    );

    // Get selected target ID from target selector
    if (targetSelector) {
      const activeTarget = targetSelector.getActiveTarget();
      if (activeTarget) {
        this._selectedTargetId = activeTarget.id;
      }
    }

    // --- Gather debris targets within range ---
    if (debrisField) {
      this._debrisTargets = debrisField.getDebrisNear(playerPos, MAX_RETICLE_RANGE);
    }

    // --- Gather active satellite targets ---
    if (activeSatellites) {
      this._activeSatTargets = activeSatellites.getSatelliteList(playerPos);
    }

    // Phase 7: Reset selected target screen pos each frame (avoid stale heading line)
    this._selectedScreenPos = null;

    // During STATION_KEEP we want to silence all on-screen target chrome
    // EXCEPT a faint outline on the actual target debris.  The arm pilot is
    // focused on a single piece of debris ~8 m away — surrounding contacts'
    // brackets, labels, ETAs, and arrows are visual noise that pull the eye
    // away from the work.  We render the SK target with reduced globalAlpha
    // (no labels) so the pilot still has a positional confirmation.
    const skTargetId = data.skTargetId;
    if (skTargetId != null) {
      this.ctx.save();
      this.ctx.globalAlpha = 0.2;   // very faint outline only
      for (const target of this._debrisTargets) {
        if (target.id !== skTargetId) continue;
        if (!target.alive || target._captured || this._capturedIds.has(target.id)) continue;
        this._drawDebrisReticle(target, playerPos);
      }
      this.ctx.restore();
      // Skip neighbouring debris + active sats entirely while station-keeping.
    } else {
      // --- Draw reticles for debris ---
      for (const target of this._debrisTargets) {
        if (!target.alive || target._captured || this._capturedIds.has(target.id)) continue;
        this._drawDebrisReticle(target, playerPos);
      }

      // --- Draw reticles for active satellites ---
      for (const sat of this._activeSatTargets) {
        if (sat.distance / Constants.SCENE_SCALE > 100) continue; // Skip if > 100km
        this._drawActiveSatReticle(sat, playerPos);
      }
    }

    // --- Draw prograde/retrograde velocity markers (Phase 2.3) ---
    if (this._viewConfig.showVelocityVectors) {
      this._drawVelocityMarkers(data);
    }

    // --- Draw lead indicator for selected target (Phase 2.4) ---
    if (this._viewConfig.showLeadIndicators && targetSelector) {
      this._drawTargetLeadIndicator(data);
    }

    // Clean up stale closure rate entries
    const activeIds = new Set(this._debrisTargets.map(t => t.id));
    for (const id of this.previousDistances.keys()) {
      if (!activeIds.has(id)) this.previousDistances.delete(id);
    }

    // Phase 6: Restore shake transform
    if (doShake) this.ctx.restore();

    // Phase 6: Draw lasso cooldown arc (on top, no shake).
    // 2026-05-15 polish task 4: the cooldown arc's "Ready" state is a
    // green ring (#00ff88 @ α0.35, radius 22) drawn at screen-centre —
    // exactly the mid-screen green circle the user reported as still
    // visible during SK. The pilot isn't going to fire a lasso while
    // parked on a target (Space is bound to capture in SK at line 777),
    // so the arc has no purpose there and is purely visual noise inside
    // the SK target bracket. Skip when in SK.
    if (data.skTargetId == null) {
      this._drawLassoCooldownArc();
    }
  }

  /**
   * Show/hide the canvas.
   * @param {boolean} visible
   */
  setVisible(visible) {
    this.canvas.style.display = visible ? 'block' : 'none';
  }

  /**
   * Sim mode: catch pulse is disabled — no bracket flash, no green glow.
   * Previously expanded brackets +30% and flashed #00ff88 over 300ms, which
   * read as arcade sparks on capture. Removed per user feedback.
   */
  showCatchPulse() {
    // no-op — keep method signature for external call sites.
  }

  // ==========================================================================
  // PROJECTION
  // ==========================================================================

  /**
   * Project a 3D world position to 2D screen coordinates.
   * @param {THREE.Vector3} worldPos
   * @returns {{ x: number, y: number, z: number, visible: boolean }}
   */
  _project(worldPos) {
    this._tempVec4.set(worldPos.x, worldPos.y, worldPos.z, 1.0);
    this._tempVec4.applyMatrix4(this._projMatrix);

    const w = this._tempVec4.w;
    if (Math.abs(w) < 1e-10) {
      return { x: 0, y: 0, z: 0, visible: false, behind: true };
    }

    const ndcX = this._tempVec4.x / w;
    const ndcY = this._tempVec4.y / w;
    const ndcZ = this._tempVec4.z / w;

    // Behind camera check
    const behind = w < 0;

    // Convert NDC to screen pixels
    const screenX = (ndcX + 1) * this._halfW;
    const screenY = (1 - ndcY) * this._halfH;

    // Check if within viewport (with small margin)
    const margin = 50;
    const visible = !behind &&
      ndcX >= -1 && ndcX <= 1 &&
      ndcY >= -1 && ndcY <= 1 &&
      ndcZ >= -1 && ndcZ <= 1;

    return { x: screenX, y: screenY, z: ndcZ, visible, behind, ndcX, ndcY };
  }

  /**
   * Calculate edge-of-screen position for off-screen arrow.
   * @param {number} ndcX - NDC x (-1 to 1, or beyond)
   * @param {number} ndcY - NDC y (-1 to 1, or beyond)
   * @param {boolean} behind - Whether target is behind camera
   * @returns {{ x: number, y: number, angle: number }}
   */
  _getEdgePosition(ndcX, ndcY, behind) {
    // If behind camera, flip direction
    let dx = ndcX;
    let dy = ndcY;
    if (behind) {
      dx = -dx;
      dy = -dy;
    }

    // Normalize to unit direction
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.001) {
      dx = 0; dy = -1; // Default: point up
    } else {
      dx /= len;
      dy /= len;
    }

    // Find intersection with screen edges
    const pad = EDGE_PADDING;
    const edgeW = this._width - pad * 2;
    const edgeH = this._height - pad * 2;

    // Scale so that the longer axis hits the edge
    let scale;
    if (Math.abs(dx) * edgeH > Math.abs(dy) * edgeW) {
      scale = (edgeW / 2) / Math.abs(dx);
    } else {
      scale = (edgeH / 2) / Math.abs(dy);
    }

    const ex = this._halfW + dx * scale;
    const ey = this._halfH - dy * scale; // Flip Y for screen coords

    // Angle for the arrow (points toward target)
    const angle = Math.atan2(-dy, dx); // Screen space angle

    return {
      x: Math.max(pad, Math.min(this._width - pad, ex)),
      y: Math.max(pad, Math.min(this._height - pad, ey)),
      angle,
    };
  }

  // ==========================================================================
  // DEBRIS RETICLE DRAWING
  // ==========================================================================

  /**
   * Draw reticle for a debris target (on-screen or off-screen arrow).
   * @private
   */
  _drawDebrisReticle(target, playerPos) {
    // Get world position — Sprint 2 / PR A — scratch-output variant.
    orbitToSceneCartesianInto(target.orbit, this._tmpCartPos, this._tmpCartVel);
    // Perf: reuse pre-allocated _tempVec3 instead of new Vector3 per visible target.
    this._tempVec3.set(this._tmpCartPos.x, this._tmpCartPos.y, this._tmpCartPos.z);
    const worldPos = this._tempVec3;

    // Project to screen
    const proj = this._project(worldPos);
    const distKm = target.distanceKm;

    // Track closure rate (distance delta over time)
    target._closureRate = null;
    if (this._dt > 0) {
      const prevDist = this.previousDistances.get(target.id);
      this.previousDistances.set(target.id, distKm);
      if (prevDist !== undefined) {
        target._closureRate = (prevDist - distKm) * 1000 / this._dt; // m/s
      }
    }

    const isSelected = target.id === this._selectedTargetId;

    // Phase 7: Capture selected target screen position for AP heading line
    if (isSelected && proj.visible) {
      this._selectedScreenPos = { x: proj.x, y: proj.y };
    }

    // Determine color based on tumble rate and type
    const color = this._getDebrisColor(target);

    if (proj.visible) {
      // === ON-SCREEN RETICLE ===
      // Sprint 2 / PR A fix — pass the velocity scratch directly. The old
      // `cart` binding (a `{position, velocity}` literal from the allocating
      // `orbitToSceneCartesian`) was removed when this site migrated to the
      // scratch-output variant at line 677, but the downstream argument and
      // four `cart.velocity.*` reads inside `_drawOnScreenReticle` were left
      // dangling — causing `ReferenceError: cart is not defined` every frame
      // in ORBITAL_VIEW. `_tmpCartVel` is the velocity object written by
      // `orbitToSceneCartesianInto` above; it carries `.x/.y/.z` km/s directly
      // (no nested `.velocity`).
      this._drawOnScreenReticle(proj, target, color, isSelected, distKm, worldPos, playerPos, this._tmpCartVel);
    } else {
      // === OFF-SCREEN ARROW ===
      const showArrow = isSelected ||
        distKm < 50 ||
        (target.type === 'rocketBody' && distKm < 30);
      if (showArrow) {
        this._drawOffScreenArrow(proj, target, color, isSelected, distKm);
      }
    }
  }

  /**
   * Draw on-screen bracket reticle for debris.
   * @private
   * @param {{x:number,y:number,z:number}|null} vel — km/s velocity scratch from
   *   [`orbitToSceneCartesianInto`](js/entities/OrbitalMechanics.js:593). The
   *   parameter shape changed in Sprint 2 / PR A: callers now pass the velocity
   *   scratch object directly instead of a `{position, velocity}` wrapper.
   */
  _drawOnScreenReticle(proj, target, color, isSelected, distKm, worldPos, playerPos, vel) {
    const ctx = this.ctx;
    const x = proj.x;
    const y = proj.y;

    // Size scales with distance (larger when closer)
    const distFactor = Math.max(0.2, Math.min(1.0, 5.0 / (distKm + 1)));
    let size = RETICLE_MIN_SIZE + (RETICLE_MAX_SIZE - RETICLE_MIN_SIZE) * distFactor;

    // Target lock ceremony state
    const isLockLost = !isSelected && target.id === this._lockLostTargetId && this._lockLostAnimActive;

    if (isSelected) {
      size *= SELECTED_RETICLE_SCALE;
      // Lock-on ceremony: brackets shrink from 2.5× → 1× over 300ms
      if (this._lockAnimActive) {
        size *= 1 + 1.5 * (1 - this._easeOutCubic(this._lockAnimT));
      }
      // ST-2.2: Gentle bracket breathing at 0.8 Hz (±1.5% scale)
      const breatheHz = Constants.RETICLE_PULSE_HZ || 0.8;
      size *= 1 + 0.015 * Math.sin(this._time * breatheHz * 2 * Math.PI);
    } else if (isLockLost) {
      // Lock-lost ceremony: start at selected scale, expand to 2×
      size *= SELECTED_RETICLE_SCALE * (1 + this._lockLostAnimT);
    }

    // S9-B: Catch pulse — expand brackets outward during pulse
    if (this._catchPulseActive && isSelected) {
      const pulseProgress = Math.max(0, this._catchPulseTime / 0.3);
      size *= 1 + 0.3 * pulseProgress; // 1.3× at start, 1.0× at end
    }

    const half = size / 2;
    const corner = size * 0.3; // Corner bracket length

    // Reward-first spine: a selected-but-OUT-OF-RANGE target renders YELLOW
    // (no lock glow) — the silent "too far for the net" state that teaches
    // Autopilot. In range → cyan lock. Derived once here and reused by both the
    // bracket and label sub-sections below to avoid drift within this method.
    const outOfRange = this._selectedInRange === false;
    const selColor = outOfRange ? COLORS.yellow : COLORS.cyan;

    ctx.save();

    if (isSelected) {
      // Steady alpha for selected target (Issue #5 — removed pulse)
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = selColor;
      ctx.lineWidth = Constants.RETICLE_BRACKET_WIDTH_SELECTED || 3.0;

      // White corner flash at start of lock-on animation (~60ms window) — only
      // for an in-range lock (the flash is the "locked, act now" cue).
      if (!outOfRange && this._lockAnimActive && this._lockAnimT < 0.20) {
        ctx.strokeStyle = COLORS.white;
        ctx.shadowColor = COLORS.white;
        ctx.shadowBlur = 16;
      } else {
        // Outer glow
        ctx.shadowColor = selColor;
        ctx.shadowBlur = 0;
      }
    } else if (isLockLost) {
      // Lock-lost: cyan brackets fading out
      ctx.globalAlpha = 1 - this._lockLostAnimT;
      ctx.strokeStyle = COLORS.cyan;
      ctx.lineWidth = Constants.RETICLE_BRACKET_WIDTH_SELECTED || 3.0;
      ctx.shadowColor = COLORS.cyan;
      ctx.shadowBlur = 8 * (1 - this._lockLostAnimT);
    } else {
      ctx.globalAlpha = 0.8;
      ctx.strokeStyle = color;
      ctx.lineWidth = Constants.RETICLE_BRACKET_WIDTH || 2.0;
    }

    // Phase 6: Lasso contact flash — temporarily override bracket to white
    if (this._lassoContactFlashTimer > 0 && target.id === this._lassoContactTargetId) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = COLORS.white;
      ctx.lineWidth = 3;
      ctx.shadowColor = COLORS.white;
      ctx.shadowBlur = 16;
    }

    // S9-B: Catch pulse — green-cyan flash on selected target brackets
    if (this._catchPulseActive && isSelected) {
      const pulseProgress = Math.max(0, this._catchPulseTime / 0.3);
      ctx.globalAlpha = 0.7 + 0.3 * pulseProgress;
      ctx.strokeStyle = '#00ff88';
      ctx.lineWidth = 2.5;
      ctx.shadowColor = '#00ff88';
      ctx.shadowBlur = 12 * pulseProgress;
    }

    // Draw corner brackets [ ]
    ctx.beginPath();
    // Top-left corner
    ctx.moveTo(x - half, y - half + corner);
    ctx.lineTo(x - half, y - half);
    ctx.lineTo(x - half + corner, y - half);
    // Top-right corner
    ctx.moveTo(x + half - corner, y - half);
    ctx.lineTo(x + half, y - half);
    ctx.lineTo(x + half, y - half + corner);
    // Bottom-right corner
    ctx.moveTo(x + half, y + half - corner);
    ctx.lineTo(x + half, y + half);
    ctx.lineTo(x + half - corner, y + half);
    // Bottom-left corner
    ctx.moveTo(x - half + corner, y + half);
    ctx.lineTo(x - half, y + half);
    ctx.lineTo(x - half, y - half + corner);
    ctx.stroke();

    // Reset shadow
    ctx.shadowBlur = 0;

    // Lock-lost ceremony: only draw fading brackets, skip all labels
    if (isLockLost) {
      ctx.restore();
      return;
    }

    // --- Contact type icon (top-left of bracket) ---
    if (this._viewConfig.showTypeIcons) {
      const typeIcon = TYPE_ICONS[target.type] || '○';
      ctx.font = '11px sans-serif';
      ctx.fillStyle = isSelected ? COLORS.cyan : color;
      ctx.textAlign = 'left';
      ctx.fillText(typeIcon, x - half + 3, y - half + 12);
    }

    // --- Distance text below reticle ---
    // 2026-05-28 (Item 7 readability pass): font sizes doubled (10/11/9 → 20/22/18)
    // and vertical offsets re-spaced to clear the larger glyph height. The
    // sequence below reticle is: distance (20 px) → closure rate (18 px) →
    // metal preview (18 px). Baselines need ~22 px spacing per row to avoid
    // overlap; previously they were at +14/+26/+38 (12 px spacing).
    ctx.font = '20px "Courier New", monospace';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';

    if (isSelected) {
      ctx.fillStyle = COLORS.cyan;
      ctx.font = 'bold 22px "Courier New", monospace';
    }

    const distText = distKm < 1 ? `${(distKm * 1000).toFixed(0)}m` : `${distKm.toFixed(1)}km`;
    ctx.fillText(distText, x, y + half + 22);

    // --- Closure rate below distance ---
    if (target._closureRate != null && this._viewConfig.showClosureRate) {
      const rate = target._closureRate;
      const absRate = Math.abs(rate);
      ctx.font = '18px "Courier New", monospace';
      ctx.textAlign = 'center';
      if (absRate < 0.5) {
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.fillText('~0 m/s', x, y + half + 46);
      } else {
        const arrow = rate > 0 ? '▼' : '▲';
        ctx.fillStyle = rate > 0 ? COLORS.green : COLORS.red;
        ctx.fillText(`${arrow}${absRate.toFixed(0)} m/s`, x, y + half + 46);
      }
    }

    // Phase R6: Metal loot preview — removed 2026-06-14 (declutter). The
    // refined-metal breakdown lives in the target dossier / shop; the floating
    // "⛏ Al:..kg" line next to every selected target was noise.

    // --- Selected target: extra info ---
    if (isSelected) {
      ctx.font = 'bold 11px "Courier New", monospace';
      ctx.fillStyle = selColor;

      // Type name above reticle
      const typeName = this._getTypeName(target.type);
      ctx.fillText(typeName, x, y - half - 18);

      // Reward-first spine: clean-mono "OUT OF RANGE" callout below the
      // distance when the selected target is beyond net-lock range. This is
      // the silent teach that points the player at Autopilot (A).
      if (outOfRange) {
        ctx.font = 'bold 16px "Courier New", monospace';
        ctx.fillStyle = COLORS.yellow;
        ctx.fillText('OUT OF RANGE', x, y + half + 70);
      }

      // Tumble rate (CP-2: show a ▼ DE-SPIN marker while the mother laser is firing)
      const tumbleDeg = (target.tumbleRate * 180 / Math.PI).toFixed(1);
      ctx.font = '10px "Courier New", monospace';
      ctx.fillStyle = selColor;
      const tumbleLabel = target._despinning
        ? `${tumbleDeg}°/s \u25BC DE-SPIN  ${target.sizeMeter.toFixed(1)}m`
        : `${tumbleDeg}°/s  ${target.sizeMeter.toFixed(1)}m`;
      ctx.fillText(tumbleLabel, x, y - half - 6);

      // Velocity vector indicator (small line showing debris direction)
      if (vel && this._viewConfig.showVelocityVectors) {
        const velDir = new THREE.Vector3(vel.x, vel.y, vel.z);
        const velEndWorld = worldPos.clone().add(velDir.normalize().multiplyScalar(0.001));
        const velProj = this._project(velEndWorld);
        if (velProj.visible) {
          ctx.beginPath();
          ctx.strokeStyle = COLORS.cyan;
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.moveTo(x, y);
          ctx.lineTo(velProj.x, velProj.y);
          ctx.stroke();
          ctx.setLineDash([]);

          // Arrow head
          const vdx = velProj.x - x;
          const vdy = velProj.y - y;
          const vlen = Math.sqrt(vdx * vdx + vdy * vdy);
          if (vlen > 10) {
            const tipX = x + (vdx / vlen) * Math.min(vlen, 40);
            const tipY = y + (vdy / vlen) * Math.min(vlen, 40);
            this._drawArrowhead(tipX, tipY, Math.atan2(vdy, vdx), 6);
          }
        }
      }

      // Lead indicator (small dot ahead in velocity direction)
      if (vel && this._viewConfig.showLeadIndicators) {
        const leadTime = 2.0; // seconds ahead
        const leadPos = worldPos.clone().add(
          new THREE.Vector3(
            vel.x * leadTime * Constants.SCENE_SCALE,
            vel.y * leadTime * Constants.SCENE_SCALE,
            vel.z * leadTime * Constants.SCENE_SCALE
          )
        );
        const leadProj = this._project(leadPos);
        if (leadProj.visible) {
          ctx.beginPath();
          ctx.arc(leadProj.x, leadProj.y, 3, 0, Math.PI * 2);
          ctx.fillStyle = COLORS.cyan;
          ctx.globalAlpha = 0.8;
          ctx.fill();
        }
      }

      // Tumble visualization (small rotating tick mark)
      const tumbleAngle = this._time * target.tumbleRate;
      const tumbleR = half + 6;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.strokeStyle = COLORS.cyan;
      ctx.lineWidth = 1.5;
      const tX = x + Math.cos(tumbleAngle) * tumbleR;
      const tY = y + Math.sin(tumbleAngle) * tumbleR;
      ctx.moveTo(x + Math.cos(tumbleAngle) * (tumbleR - 4), y + Math.sin(tumbleAngle) * (tumbleR - 4));
      ctx.lineTo(tX, tY);
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * Draw off-screen directional arrow.
   * @private
   */
  _drawOffScreenArrow(proj, target, color, isSelected, distKm) {
    const ctx = this.ctx;
    const edge = this._getEdgePosition(proj.ndcX, proj.ndcY, proj.behind);

    ctx.save();

    if (isSelected) {
      ctx.strokeStyle = COLORS.cyan;
      ctx.fillStyle = COLORS.cyan;
      ctx.lineWidth = 2.5;
      ctx.shadowColor = COLORS.cyan;
      ctx.shadowBlur = 6;
      const pulse = 0.7 + 0.3 * Math.sin(this._time * PULSE_SPEED * 2 * Math.PI);
      ctx.globalAlpha = pulse;
    } else {
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = Math.max(0.3, 1.0 - distKm / 50);
    }

    // Draw arrow
    const arrowSize = isSelected ? 12 : 8;
    this._drawArrowShape(edge.x, edge.y, edge.angle, arrowSize);

    // Distance text
    ctx.shadowBlur = 0;
    ctx.font = isSelected ? 'bold 11px "Courier New", monospace' : '9px "Courier New", monospace';
    ctx.textAlign = 'center';
    const distText = distKm < 1 ? `${(distKm * 1000).toFixed(0)}m` : `${distKm.toFixed(1)}km`;

    // Position text near the arrow
    const textOffsetX = Math.cos(edge.angle + Math.PI) * 20;
    const textOffsetY = -Math.sin(edge.angle + Math.PI) * 20;
    ctx.fillText(distText, edge.x + textOffsetX, edge.y + textOffsetY);

    // Selected target: show type name too
    if (isSelected) {
      const typeName = this._getTypeName(target.type);
      ctx.fillText(typeName, edge.x + textOffsetX, edge.y + textOffsetY - 12);
    }

    ctx.restore();
  }

  // ==========================================================================
  // ACTIVE SATELLITE RETICLE
  // ==========================================================================

  /**
   * Draw reticle/arrow for an active satellite.
   * @private
   */
  _drawActiveSatReticle(sat, playerPos) {
    const worldPos = sat.position;
    const proj = this._project(worldPos);
    const distKm = sat.distance / Constants.SCENE_SCALE;

    if (proj.visible) {
      this._drawDiamondReticle(proj, sat, distKm);
    } else if (distKm < 20) {
      // Off-screen warning arrow for nearby active sats
      this._drawActiveSatArrow(proj, sat, distKm);
    }
  }

  /**
   * Draw white diamond reticle for active satellite (on-screen).
   * @private
   */
  _drawDiamondReticle(proj, sat, distKm) {
    const ctx = this.ctx;
    const x = proj.x;
    const y = proj.y;

    const distFactor = Math.max(0.3, Math.min(1.0, 10.0 / (distKm + 1)));
    const size = 10 + 20 * distFactor;

    ctx.save();
    ctx.strokeStyle = COLORS.white;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.9;

    // Diamond shape ◇
    ctx.beginPath();
    ctx.moveTo(x, y - size);
    ctx.lineTo(x + size, y);
    ctx.lineTo(x, y + size);
    ctx.lineTo(x - size, y);
    ctx.closePath();
    ctx.stroke();

    // Name and distance
    ctx.font = '9px "Courier New", monospace';
    ctx.fillStyle = COLORS.white;
    ctx.textAlign = 'center';
    ctx.fillText(sat.name, x, y - size - 6);
    const distText = distKm < 1 ? `${(distKm * 1000).toFixed(0)}m` : `${distKm.toFixed(1)}km`;
    ctx.fillText(distText, x, y + size + 12);

    // Warning if close
    if (distKm < 5) {
      const pulse = Math.sin(this._time * 6) > 0;
      ctx.globalAlpha = pulse ? 0.9 : 0.4;
      ctx.fillStyle = COLORS.red;
      ctx.font = 'bold 11px "Courier New", monospace';
      ctx.fillText('⚠ DO NOT APPROACH', x, y + size + 24);
    }

    ctx.restore();
  }

  /**
   * Draw off-screen arrow for active satellite with warning.
   * @private
   */
  _drawActiveSatArrow(proj, sat, distKm) {
    const ctx = this.ctx;
    const edge = this._getEdgePosition(proj.ndcX, proj.ndcY, proj.behind);

    ctx.save();

    const urgent = distKm < 5;
    const pulse = urgent ? (Math.sin(this._time * 8) > 0 ? 1.0 : 0.5) : 0.8;

    ctx.strokeStyle = urgent ? COLORS.red : COLORS.white;
    ctx.fillStyle = urgent ? COLORS.red : COLORS.white;
    ctx.lineWidth = urgent ? 2.5 : 1.5;
    ctx.globalAlpha = pulse;

    this._drawArrowShape(edge.x, edge.y, edge.angle, urgent ? 12 : 8);

    ctx.shadowBlur = 0;
    ctx.font = urgent ? 'bold 10px "Courier New", monospace' : '9px "Courier New", monospace';
    ctx.textAlign = 'center';

    const textOffsetX = Math.cos(edge.angle + Math.PI) * 22;
    const textOffsetY = -Math.sin(edge.angle + Math.PI) * 22;

    const distText = `${distKm.toFixed(1)}km`;
    const label = urgent ? `⚠ ${sat.name} ${distText}` : `${sat.name} ${distText}`;
    ctx.fillText(label, edge.x + textOffsetX, edge.y + textOffsetY);

    ctx.restore();
  }

  // ==========================================================================
  // PROGRADE / RETROGRADE VELOCITY MARKERS (Phase 2.3)
  // ==========================================================================

  /**
   * Draw prograde (⊙) and retrograde (⊗) markers projected onto the screen
   * at the player's velocity vector direction — key navigational aids from iWar.
   * @private
   * @param {object} data - Game data with playerPos and playerVel
   */
  _drawVelocityMarkers(data) {
    const vel = data.playerVel;
    if (!vel) return;

    const velVec = new THREE.Vector3(vel.x, vel.y, vel.z);
    const velMagSq = velVec.lengthSq();
    if (velMagSq < 1e-14) return; // Essentially stationary

    const velMag = Math.sqrt(velMagSq);
    const progradeDir = velVec.clone().normalize();
    const playerPos = data.playerPos instanceof THREE.Vector3
      ? data.playerPos
      : new THREE.Vector3(data.playerPos.x, data.playerPos.y, data.playerPos.z);

    // --- Prograde marker: point far ahead in velocity direction ---
    const progradeWorld = playerPos.clone().add(progradeDir.clone().multiplyScalar(10));
    const proProj = this._project(progradeWorld);
    if (proProj.visible) {
      this._drawProgradeMarker(proProj.x, proProj.y, velMag);
    }

    // --- Retrograde marker: point far behind (opposite velocity) ---
    const retrogradeWorld = playerPos.clone().add(progradeDir.clone().multiplyScalar(-10));
    const retProj = this._project(retrogradeWorld);
    if (retProj.visible) {
      this._drawRetrogradeMarker(retProj.x, retProj.y, this._relativeVelocity);
    }
  }

  /**
   * Draw prograde marker ⊙ — circle with center dot.
   * @private
   * @param {number} x - Screen X
   * @param {number} y - Screen Y
   * @param {number} velMag - Velocity magnitude in km/s (from OrbitalMechanics)
   */
  _drawProgradeMarker(x, y, velMag) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.9;

    // Outer circle
    ctx.strokeStyle = COLORS.green;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 14, 0, Math.PI * 2);
    ctx.stroke();

    // Center dot
    ctx.fillStyle = COLORS.green;
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fill();

    // Three prongs (up, left, right) — classic prograde symbol
    const r = 14;
    ctx.beginPath();
    ctx.moveTo(x, y - r); ctx.lineTo(x, y - r - 6);
    ctx.moveTo(x - r, y); ctx.lineTo(x - r - 6, y);
    ctx.moveTo(x + r, y); ctx.lineTo(x + r + 6, y);
    ctx.stroke();

    // First-encounter callout trigger
    if (!this._progradeFirstSeen) {
      this._progradeFirstSeen = true;
      this._progradeCalloutTimer = CALLOUT_DURATION;
    }

    // Label: Prograde + velocity magnitude (or callout on first encounter)
    ctx.textAlign = 'left';
    if (this._progradeCalloutTimer > 0) {
      // Callout alpha: full for first 6s, fade over last 2s
      const calloutAlpha = this._progradeCalloutTimer <= 2
        ? this._progradeCalloutTimer / 2
        : 1.0;
      const calloutText = 'Prograde. Direction of travel';
      ctx.font = 'bold 13px monospace';
      this._drawCalloutPill(x + 22, y - 6, calloutText, COLORS.green, calloutAlpha);
      ctx.globalAlpha = calloutAlpha;
      ctx.fillStyle = COLORS.green;
      ctx.fillText(calloutText, x + 22, y + 4);
    } else {
      ctx.font = '10px "Courier New", monospace';
      ctx.fillStyle = COLORS.green;

      // Velocity readout (velMag already in km/s from OrbitalMechanics)
      const velText = velMag >= 1
        ? `${velMag.toFixed(2)} km/s`
        : `${(velMag * 1000).toFixed(0)} m/s`;
      ctx.fillText(`Prograde ${velText}`, x + 22, y + 4);

      let lineY = y + 18;

      // Phase 1: ΔV-spent counter below prograde label (always show to prevent flashing)
      {
        ctx.font = '9px "Courier New", monospace';
        ctx.fillStyle = 'rgba(0, 255, 136, 0.6)';
        const spentMs = this._deltaVSpent * 1000; // convert km/s game units → m/s
        ctx.fillText(spentMs > 0.05 ? `Spent: ${spentMs.toFixed(1)} m/s` : 'Spent: 0.0 m/s', x + 22, lineY);
        lineY += 12;
      }

      // Phase R6: Closure rate + ETA for selected target (always show to prevent flashing)
      if (this._selectedTargetDistKm > 0) {
        const cr = this._selectedClosureRate; // km/s, positive = closing
        {
          ctx.font = '9px "Courier New", monospace';
          ctx.globalAlpha = 0.8;
          if (Math.abs(cr) > 0.001) {
            const label = cr > 0 ? 'Closing' : 'Opening';
            ctx.fillStyle = cr > 0 ? COLORS.green : COLORS.red;
            const crKms = Math.abs(cr);
            const crText = crKms >= 1
              ? `${crKms.toFixed(2)} km/s`
              : `${(crKms * 1000).toFixed(0)} m/s`;
            ctx.fillText(`${label}: ${crText}`, x + 22, lineY);
          } else {
            ctx.fillStyle = 'rgba(255,255,255,0.4)';
            ctx.fillText('~0 m/s', x + 22, lineY);
          }
          lineY += 12;
        }
        // ETA when closing on target
        if (cr > 0.001) {
          const etaSec = this._selectedTargetDistKm / cr;
          if (etaSec < 3600) { // Only show if < 1 hour
            const etaStr = etaSec > 120
              ? `${(etaSec / 60).toFixed(1)}m`
              : `${etaSec.toFixed(0)}s`;
            ctx.font = '9px "Courier New", monospace';
            ctx.fillStyle = COLORS.yellow;
            ctx.globalAlpha = 0.7;
            ctx.fillText(`ETA: ${etaStr}`, x + 22, lineY);
            lineY += 12;
          }
        }
      }

      // Phase R6: Periapsis hint — Oberth effect teaching moment
      if (this._nearPeriapsis) {
        ctx.font = '9px "Courier New", monospace';
        ctx.fillStyle = COLORS.yellow;
        ctx.globalAlpha = 0.5;
        ctx.fillText('Periapsis. Efficient burn', x + 22, lineY);
      }
    }

    // Phase 7: Autopilot engaged indicator — amber pulsing text above prograde
    if (this._apEngaged) {
      const apAlpha = 0.6 + 0.4 * Math.sin(this._time * Math.PI); // 0.5Hz pulse
      ctx.globalAlpha = apAlpha;
      ctx.font = 'bold 11px "Courier New", monospace';
      ctx.fillStyle = COLORS.yellow;
      ctx.textAlign = 'center';
      ctx.fillText(`◉ AP → ${this._apTargetName}`, x, y - 28);

      // Dashed amber heading line from prograde to selected target
      if (this._selectedScreenPos) {
        const tx = this._selectedScreenPos.x;
        const ty = this._selectedScreenPos.y;
        const dx = tx - x, dy = ty - y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 30) {
          ctx.globalAlpha = 0.35;
          ctx.strokeStyle = COLORS.yellow;
          ctx.lineWidth = 1;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.moveTo(x + (dx / dist) * 22, y + (dy / dist) * 22); // start past prograde circle
          ctx.lineTo(tx, ty);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }

    ctx.restore();
  }

  /**
   * Draw retrograde marker ⊗ — circle with X through it.
   * @private
   * @param {number} x - Screen X
   * @param {number} y - Screen Y
   * @param {number} [relativeVelocity=0] - Relative velocity to selected target in km/s
   */
  _drawRetrogradeMarker(x, y, relativeVelocity = 0) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.9;

    // Outer circle
    ctx.strokeStyle = '#ff8844';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 14, 0, Math.PI * 2);
    ctx.stroke();

    // X through center
    const d = 9;
    ctx.beginPath();
    ctx.moveTo(x - d, y - d); ctx.lineTo(x + d, y + d);
    ctx.moveTo(x + d, y - d); ctx.lineTo(x - d, y + d);
    ctx.stroke();

    // Three prongs (down, left, right) — classic retrograde symbol
    const r = 14;
    ctx.beginPath();
    ctx.moveTo(x, y + r); ctx.lineTo(x, y + r + 6);
    ctx.moveTo(x - r, y); ctx.lineTo(x - r - 6, y);
    ctx.moveTo(x + r, y); ctx.lineTo(x + r + 6, y);
    ctx.stroke();

    // First-encounter callout trigger
    if (!this._retroFirstSeen) {
      this._retroFirstSeen = true;
      this._retroCalloutTimer = CALLOUT_DURATION;
    }

    // Label (or callout on first encounter)
    ctx.textAlign = 'left';
    if (this._retroCalloutTimer > 0) {
      const calloutAlpha = this._retroCalloutTimer <= 2
        ? this._retroCalloutTimer / 2
        : 1.0;
      const calloutText = 'Retrograde. Brake direction';
      ctx.font = 'bold 13px monospace';
      this._drawCalloutPill(x + 22, y - 6, calloutText, '#ff8844', calloutAlpha);
      ctx.globalAlpha = calloutAlpha;
      ctx.fillStyle = '#ff8844';
      ctx.fillText(calloutText, x + 22, y + 4);
    } else {
      ctx.font = '10px "Courier New", monospace';
      ctx.fillStyle = '#ff8844';
      ctx.fillText('Retrograde', x + 22, y + 4);

      // Phase 1: ΔV-to-match readout when a target is selected
      if (relativeVelocity > 0) {
        ctx.font = '10px "Courier New", monospace';
        ctx.fillStyle = '#ff8844';
        const relVelMs = relativeVelocity * 1000; // km/s → m/s
        const matchText = relVelMs < 1000
          ? `ΔV to match: ${relVelMs.toFixed(1)} m/s`
          : `ΔV to match: ${relativeVelocity.toFixed(2)} km/s`;
        ctx.fillText(matchText, x + 22, y + 18);

        // Phase R6: Post-burn ΔV — what remains after matching target velocity
        if (this._cachedPlayerDeltaV > 0) {
          const costMs = relVelMs;
          const postBurn = this._cachedPlayerDeltaV - costMs;
          const pbColor = postBurn > 200 ? COLORS.green
            : postBurn > 50 ? COLORS.yellow : COLORS.red;
          ctx.font = '9px "Courier New", monospace';
          ctx.fillStyle = pbColor;
          ctx.globalAlpha = 0.8;
          ctx.fillText(`Post-burn ΔV: ${Math.round(postBurn)} m/s`, x + 22, y + 30);
        }
      }
    }

    ctx.restore();
  }

  // ==========================================================================
  // TARGET LEAD INDICATOR (Phase 2.4)
  // ==========================================================================

  /**
   * Draw a lead indicator showing where the selected target WILL BE when a
   * deployed arm would arrive. Helps players understand orbital phasing.
   * @private
   * @param {object} data - Game data
   */
  _drawTargetLeadIndicator(data) {
    const target = data.targetSelector?.getActiveTarget();
    if (!target || !target.orbit) return;

    // Compute current target position — Sprint 2 / PR A — scratch-output variant.
    orbitToSceneCartesianInto(target.orbit, this._tmpCartPos, this._tmpCartVel);
    const targetPos = new THREE.Vector3(
      this._tmpCartPos.x,
      this._tmpCartPos.y,
      this._tmpCartPos.z
    );

    const playerPos = data.playerPos instanceof THREE.Vector3
      ? data.playerPos
      : new THREE.Vector3(data.playerPos.x, data.playerPos.y, data.playerPos.z);

    const dist = playerPos.distanceTo(targetPos);
    if (dist < 1e-10) return;

    // Estimate arm transit time (arm speed in scene units per real second)
    const transitTime = dist / Constants.ARM_APPROACH_SPEED; // real seconds
    const transitTimeCapped = Math.min(transitTime, 300); // cap at 5 min

    // Approximate orbital angular velocity: n = sqrt(mu / r³)
    // Convert scene radius to km for the calculation
    const r_km = targetPos.length() / Constants.SCENE_SCALE;
    if (r_km < 100) return; // Safety check

    const mu = 398600.4418; // km³/s² (Earth standard gravitational parameter)
    const n = Math.sqrt(mu / (r_km * r_km * r_km)); // rad/s

    // Predict future angular displacement (accounting for game time scale)
    const angle = n * transitTimeCapped * Constants.TIME_SCALE_GAMEPLAY;

    // Rotate target position around Earth center (Y axis) by predicted angle
    const futurePos = targetPos.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);

    // Project both current and future positions
    const currentProj = this._project(targetPos);
    const futureProj = this._project(futurePos);

    if (futureProj.visible) {
      // Draw dashed line from current target to lead indicator
      if (currentProj.visible) {
        const ctx = this.ctx;
        ctx.save();
        ctx.strokeStyle = '#ffaa00';
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.4;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(currentProj.x, currentProj.y);
        ctx.lineTo(futureProj.x, futureProj.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }

      this._drawLeadIndicatorMarker(futureProj.x, futureProj.y, transitTimeCapped);
    }
  }

  /**
   * Draw the lead indicator diamond ◆ marker with time estimate.
   * @private
   * @param {number} x - Screen X
   * @param {number} y - Screen Y
   * @param {number} transitTime - Estimated transit time in seconds
   */
  _drawLeadIndicatorMarker(x, y, transitTime) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.85;

    // Diamond shape ◆
    ctx.strokeStyle = '#ffaa00';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y - 10);
    ctx.lineTo(x + 8, y);
    ctx.lineTo(x, y + 10);
    ctx.lineTo(x - 8, y);
    ctx.closePath();
    ctx.stroke();

    // Small center dot
    ctx.fillStyle = '#ffaa00';
    ctx.beginPath();
    ctx.arc(x, y, 1.5, 0, Math.PI * 2);
    ctx.fill();

    // First-encounter callout trigger
    if (!this._leadFirstSeen) {
      this._leadFirstSeen = true;
      this._leadCalloutTimer = CALLOUT_DURATION;
    }

    ctx.textAlign = 'left';
    if (this._leadCalloutTimer > 0) {
      const calloutAlpha = this._leadCalloutTimer <= 2
        ? this._leadCalloutTimer / 2
        : 1.0;
      const calloutText = 'Lead. Aim here to intercept';
      ctx.font = 'bold 13px monospace';
      this._drawCalloutPill(x + 12, y - 8, calloutText, '#ffaa00', calloutAlpha);
      ctx.globalAlpha = calloutAlpha;
      ctx.fillStyle = '#ffaa00';
      ctx.fillText(calloutText, x + 12, y + 2);
    } else {
      // Time estimate label
      ctx.font = '10px "Courier New", monospace';
      const timeStr = transitTime < 60
        ? `~${Math.round(transitTime)}s`
        : `~${(transitTime / 60).toFixed(1)}m`;
      ctx.fillText(timeStr, x + 12, y + 4);

      // "Lead" label
      ctx.font = '9px "Courier New", monospace';
      ctx.globalAlpha = 0.6;
      ctx.fillText('Lead', x + 12, y - 8);
    }

    ctx.restore();
  }

  // ==========================================================================
  // CALLOUT PILL HELPER
  // ==========================================================================

  /**
   * Draw a semi-transparent dark background pill behind callout text.
   * @private
   * @param {number} x - Text X position
   * @param {number} y - Text Y position (baseline)
   * @param {string} text - The callout text (used to measure width)
   * @param {string} color - Border/accent color
   * @param {number} alpha - Opacity (0-1)
   */
  _drawCalloutPill(x, y, text, color, alpha) {
    const ctx = this.ctx;
    ctx.save();
    const metrics = ctx.measureText(text);
    const pw = metrics.width + 12;
    const ph = 20;
    const px = x - 4;
    const py = y - 4;
    const r = 4; // corner radius

    // Helper: trace a rounded rectangle path
    const tracePill = () => {
      ctx.beginPath();
      ctx.moveTo(px + r, py);
      ctx.lineTo(px + pw - r, py);
      ctx.arcTo(px + pw, py, px + pw, py + r, r);
      ctx.lineTo(px + pw, py + ph - r);
      ctx.arcTo(px + pw, py + ph, px + pw - r, py + ph, r);
      ctx.lineTo(px + r, py + ph);
      ctx.arcTo(px, py + ph, px, py + ph - r, r);
      ctx.lineTo(px, py + r);
      ctx.arcTo(px, py, px + r, py, r);
      ctx.closePath();
    };

    ctx.globalAlpha = alpha * 0.7;
    ctx.fillStyle = '#000000';
    tracePill();
    ctx.fill();

    ctx.globalAlpha = alpha * 0.5;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    tracePill();
    ctx.stroke();

    ctx.restore();
  }

  // ==========================================================================
  // DRAWING PRIMITIVES
  // ==========================================================================

  /**
   * Draw a filled arrow shape at a position.
   * @private
   */
  _drawArrowShape(x, y, angle, size) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-angle); // Canvas angles are clockwise

    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(-size * 0.5, -size * 0.6);
    ctx.lineTo(-size * 0.2, 0);
    ctx.lineTo(-size * 0.5, size * 0.6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Draw a small arrowhead at a position.
   * @private
   */
  _drawArrowhead(x, y, angle, size) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-size, -size * 0.4);
    ctx.lineTo(-size, size * 0.4);
    ctx.closePath();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();

    ctx.restore();
  }

  // ==========================================================================
  // EASING HELPERS
  // ==========================================================================

  /**
   * Cubic ease-out: decelerating to zero velocity.
   * @param {number} t - Progress 0-1
   * @returns {number} Eased value 0-1
   */
  _easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  // ==========================================================================
  // PHASE 6: LASSO COOLDOWN ARC
  // ==========================================================================

  /**
   * Draw lasso cooldown arc around crosshair center.
   * Green ring when ready, gray pulsing ring during flight,
   * gray filling arc during cooldown, red flash on denied.
   * @private
   */
  _drawLassoCooldownArc() {
    const ctx = this.ctx;
    const cx = this._halfW;
    const cy = this._halfH;
    const radius = 22;

    ctx.save();
    ctx.lineWidth = 2.5;

    if (this._lassoDeniedTimer > 0) {
      // Denied flash: red arc pulses
      const alpha = this._lassoDeniedTimer / 0.3;
      ctx.globalAlpha = alpha * 0.9;
      ctx.strokeStyle = '#ff4444';
      ctx.shadowColor = '#ff4444';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();
    } else if (this._lassoInFlight) {
      // In flight: gray pulsing ring (lasso active, can't fire)
      const pulse = 0.2 + 0.1 * Math.sin(this._time * 4 * Math.PI);
      ctx.globalAlpha = pulse;
      ctx.strokeStyle = '#888888';
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();
    } else if (this._lassoCooldownTimer > 0) {
      // Cooling: gray background ring + gray fill arc
      const progress = 1 - (this._lassoCooldownTimer / this._lassoCooldownMax);

      // Gray background ring
      ctx.globalAlpha = 0.15;
      ctx.strokeStyle = '#888888';
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();

      // Fill arc (clockwise from top, -π/2 start)
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = '#aaaaaa';
      ctx.beginPath();
      ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * progress));
      ctx.stroke();
    }
    // 2026-05-15 polish task 4 (urgent revision): the original "Ready"
    // branch drew a faint green ring at canvas centre (radius 22, α 0.35,
    // #00ff88) any time the lasso was charged. User reported it as a
    // mid-screen green circle that persisted regardless of game state
    // (not just SK). Removed entirely — readiness is already conveyed by
    // the absence of the cooldown / in-flight / denied indicators, plus
    // the dedicated lasso HUD elements in TargetPanel. Keeping cooldown
    // (gray), in-flight (gray pulse), and denied (red flash) since those
    // communicate active state changes; only the static "you are ready"
    // ring is gone.

    ctx.restore();
  }

  // ==========================================================================
  // COLOR & TYPE HELPERS
  // ==========================================================================

  /**
   * Get color for debris based on type and tumble rate.
   * @private
   */
  _getDebrisColor(target) {
    const tumbleDeg = target.tumbleRate * 180 / Math.PI;

    // High tumble or large rocket body = red (dangerous)
    if (tumbleDeg > 60 || (target.type === 'rocketBody' && target.mass > 3000)) {
      return COLORS.red;
    }
    // Medium tumble or defunct sats = yellow
    if (tumbleDeg > 20 || target.type === 'defunctSat') {
      return COLORS.yellow;
    }
    // Low tumble fragments = green (easy)
    return COLORS.green;
  }

  /**
   * Get human-readable type name.
   * @private
   */
  _getTypeName(type) {
    switch (type) {
      case 'rocketBody': return 'ROCKET BODY';
      case 'defunctSat': return 'DEFUNCT SAT';
      case 'missionDebris': return 'MISSION DEB';
      case 'fragment': return 'FRAGMENT';
      default: return 'DEBRIS';
    }
  }
}

export default TargetReticle;
