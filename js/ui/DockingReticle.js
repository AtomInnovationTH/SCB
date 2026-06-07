/**
 * DockingReticle.js — Orbiter-heritage docking crosshair Canvas2D overlay
 * Full-screen overlay visible ONLY during ARM PILOT mode.
 * Shows center crosshair, target indicator, range/closure readouts,
 * alignment bars, net readiness, vignette, and arm status.
 * @module ui/DockingReticle
 */

import * as THREE from 'three';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { GameStates } from '../core/GameState.js';
import { Constants } from '../core/Constants.js';
import { audioSystem } from '../systems/AudioSystem.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

/** 1 meter in scene units (1 scene unit = 100 km) */
const M = 0.00001;

/** Offset-to-pixel scale: 1 meter of lateral offset ≈ 3px on screen */
const OFFSET_SCALE = 3;

/** Color palette (consistent with HUD green theme) */
const C = {
  primary:    '#00ff88',
  primaryDim: 'rgba(0, 255, 136, 0.3)',
  primaryGlow:'rgba(0, 255, 136, 0.15)',
  warning:    '#ffaa00',
  warningDim: 'rgba(255, 170, 0, 0.3)',
  danger:     '#ff4444',
  dangerDim:  'rgba(255, 68, 68, 0.3)',
  white:      '#ffffff',
  gray:       'rgba(255, 255, 255, 0.35)',
  bg:         'rgba(0, 0, 0, 0.6)',
};

const FONT = "'Courier New', monospace";

// ============================================================================
// DOCKING RETICLE
// ============================================================================

export class DockingReticle {
  /**
   * @param {THREE.PerspectiveCamera} camera - For projection math
   */
  constructor(camera, scene) {
    this._camera = camera;
    this._scene = scene || null;

    /** @type {HTMLCanvasElement} */
    this._canvas = null;
    /** @type {CanvasRenderingContext2D} */
    this._ctx = null;
    this._width = 0;
    this._height = 0;

    this._visible = false;
    this._arm = null;
    this._target = null;
    this._time = 0;

    // Computed metrics
    this._range = 0;
    this._closureRate = 0;
    this._lastRange = -1;
    this._offsetX = 0;     // meters lateral
    this._offsetY = 0;     // meters vertical

    // Phase 7: Approach audio state
    this._lastBeepTime = 0;
    this._alignmentToneActive = false;

    // Reusable THREE vectors
    this._tmpVec = new THREE.Vector3();
    this._tmpVec2 = new THREE.Vector3();
    this._tmpVec3 = new THREE.Vector3();

    this._skActive = false;

    this._createCanvas();
    this._onResize();
    this._resizeHandler = () => this._onResize();
    window.addEventListener('resize', this._resizeHandler);

    // Self-manage visibility via EventBus (decoupled from GameFlowManager)
    eventBus.on(Events.GAME_STATE_CHANGE, ({ to }) => {
      const gameplay = (to === GameStates.ORBITAL_VIEW || to === GameStates.APPROACH || to === GameStates.INTERACTION);
      if (!gameplay) this.setVisible(false);
    });
  }

  // ==========================================================================
  // CANVAS SETUP (same pattern as NavSphere)
  // ==========================================================================

  /** @private */
  _createCanvas() {
    this._canvas = document.createElement('canvas');
    this._canvas.id = 'docking-reticle-canvas';
    this._canvas.style.cssText = `
      position: fixed; top: 0; left: 0;
      width: 100%; height: 100%;
      pointer-events: none; z-index: 12;
      display: none;
    `;
    document.body.appendChild(this._canvas);
    this._ctx = this._canvas.getContext('2d');
  }

  /** @private */
  _onResize() {
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.dpr = dpr;
    this._width = window.innerWidth;
    this._height = window.innerHeight;
    this._canvas.width = this._width * dpr;
    this._canvas.height = this._height * dpr;
    this._canvas.style.width = this._width + 'px';
    this._canvas.style.height = this._height + 'px';
    this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._ctx.imageSmoothingEnabled = true;
    this._ctx.imageSmoothingQuality = 'high';
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  /**
   * Show or hide the reticle overlay.
   * @param {boolean} visible
   */
  setVisible(visible) {
    this._visible = visible;
    this._canvas.style.display = visible ? 'block' : 'none';
    if (!visible) {
      // Clear canvas when hiding
      this._ctx.clearRect(0, 0, this._width, this._height);
      this._lastRange = -1;
      // Phase 7: Stop alignment tone when hiding
      if (this._alignmentToneActive) {
        this._alignmentToneActive = false;
        audioSystem.stopAlignmentTone();
      }
      this._skActive = false;
    }
  }

  /**
   * Set the arm and target for rendering metrics.
   * @param {import('../entities/ArmUnit.js').ArmUnit} arm
   * @param {object|null} target - Debris object with .mesh.position
   */
  setArmData(arm, target) {
    this._arm = arm;
    this._target = target;
  }

  /**
   * Per-frame update — compute metrics and redraw.
   * @param {number} dt - Delta time in seconds
   */
  update(dt) {
    if (!this._visible || !this._arm) return;
    this._time += dt;
    this._computeMetrics(dt);
    this._updateApproachAudio();
    this._render();
    this._updateSkActiveFlag();
  }

  /**
   * True if within net deployment range.
   * @returns {boolean}
   */
  isNetReady() {
    if (!this._arm) return false;
    const netRange = (this._arm.config?.netSize || 5) * 2; // deploy range = 2× net size
    return this._range < netRange && this._range > 0;
  }

  /**
   * Get alignment metrics for scoring.
   * @returns {{ range: number, closureRate: number, offsetX: number, offsetY: number }}
   */
  getAlignment() {
    return {
      range: this._range,
      closureRate: this._closureRate,
      offsetX: this._offsetX,
      offsetY: this._offsetY,
    };
  }

  /**
   * Remove canvas and clean up event listeners.
   */
  dispose() {
    window.removeEventListener('resize', this._resizeHandler);
    if (this._canvas && this._canvas.parentNode) {
      this._canvas.parentNode.removeChild(this._canvas);
    }
    this._canvas = null;
    this._ctx = null;
  }

  // ==========================================================================
  // METRICS COMPUTATION
  // ==========================================================================

  /** @private Compute range, closure rate, and alignment offsets */
  _computeMetrics(dt) {
    if (!this._arm || !this._target?._scenePosition) {
      this._range = 0;
      this._closureRate = 0;
      this._offsetX = 0;
      this._offsetY = 0;
      return;
    }

    const armPos = this._arm.position;
    const targetPos = this._target._scenePosition;

    // Range in meters
    const rangeScene = armPos.distanceTo(targetPos);
    this._range = rangeScene / M;

    // Closure rate (delta range per second, positive = closing)
    if (this._lastRange >= 0) {
      this._closureRate = (this._lastRange - this._range) / Math.max(dt, 0.001);
    }
    this._lastRange = this._range;

    // Compute target offset in arm's local frame
    const toTarget = this._tmpVec.copy(targetPos).sub(armPos);

    let forward;
    if (toTarget.lengthSq() > 1e-16) {
      forward = this._tmpVec2.copy(toTarget).normalize();
    } else {
      forward = this._tmpVec2.set(0, 0, 1);
    }

    const up = this._tmpVec3.copy(armPos).normalize(); // radial up
    const right = new THREE.Vector3().crossVectors(forward, up).normalize();
    const localUp = new THREE.Vector3().crossVectors(right, forward).normalize();

    // Project toTarget onto right and up axes for lateral/vertical offset (meters)
    this._offsetX = toTarget.dot(right) / M;
    this._offsetY = toTarget.dot(localUp) / M;
  }

  // ==========================================================================
  // APPROACH AUDIO (Phase 7 — §5.4)
  // ==========================================================================

  /** @private Update docking approach beeps and alignment confirmation tone */
  _updateApproachAudio() {
    const range = this._range;
    const now = performance.now() / 1000;

    // Suppress the rapid close-range docking beeps once the arm reaches
    // station-keep or any post-approach state (NETTING / GRAPPLED / REELING /
    // DOCKING). At that point the pilot is parked at standoff (≤20 m) or
    // actively capturing — the fast "beep-beep-beep" becomes annoying spam
    // rather than useful approach feedback (user is no longer approaching).
    // Also stop any active alignment tone for the same reason.
    const POST_APPROACH_STATES = new Set([
      'STATION_KEEP', 'NETTING', 'GRAPPLED', 'REELING', 'DOCKING',
      'FISHING', 'TRAWLING', 'HAULING',
    ]);
    const inPostApproach = this._arm && POST_APPROACH_STATES.has(this._arm.state);
    if (inPostApproach) {
      if (this._alignmentToneActive) {
        this._alignmentToneActive = false;
        audioSystem.stopAlignmentTone();
      }
      return;
    }

    // --- Range-based beeping (sonar-ping during APPROACH) ---
    // Tuned 2026-05-15 polish task 2: the close-range tier was 0.2 s /
    // 1200 Hz which the user found annoyingly rapid+high once inside
    // ~20 m. Softened to 0.4 s / 1000 Hz — still a clear "you are close"
    // cue but less of a fire-alarm. SK entry hard-cuts the whole loop
    // above (line 270-277), so this only fires during APPROACH itself.
    let interval = null, freq = 600, vol = 0.1;
    if (range > 0 && range <= 200) {
      if (range > 100)      { interval = 2.0; freq = 600;  vol = 0.10; }
      else if (range > 50)  { interval = 1.0; freq = 800;  vol = 0.15; }
      else if (range > 20)  { interval = 0.5; freq = 900;  vol = 0.20; }
      else                  { interval = 0.4; freq = 1000; vol = 0.22; }
    }

    if (interval && now - this._lastBeepTime >= interval) {
      this._lastBeepTime = now;
      audioSystem.playDockingBeep(freq, vol);
    }

    // --- Alignment confirmation tone (H+V within 5m, range < 25m) ---
    const aligned = Math.abs(this._offsetX) < 5 && Math.abs(this._offsetY) < 5
                    && range > 0 && range < 25;
    if (aligned && !this._alignmentToneActive) {
      this._alignmentToneActive = true;
      audioSystem.startAlignmentTone();
    } else if (!aligned && this._alignmentToneActive) {
      this._alignmentToneActive = false;
      audioSystem.stopAlignmentTone();
    }
  }

  // ==========================================================================
  // RENDERING
  // ==========================================================================

  /** @private Full redraw */
  _render() {
    const ctx = this._ctx;
    const w = this._width;
    const h = this._height;
    const cx = w / 2;
    const cy = h / 2;

    // 1. Clear
    ctx.clearRect(0, 0, w, h);

    // 2. Vignette
    this._drawVignette(ctx, cx, cy, w, h);

    // During STATION_KEEP all of the green approach reticle chrome (centre
    // crosshair, target diamond, SK centre dot) is redundant with the cyan
    // TargetReticle bracket already drawn around the debris — and the green
    // crosshair + diamond+dashed-line stack reads as visual clutter inside
    // the bracket.  Suppress them during SK (debug session 2026-05-15).
    const _inSk = this._arm && this._arm.state === 'STATION_KEEP';
    if (!_inSk) {
      // 3. Center crosshair (+) — approach alignment aid
      this._drawCrosshair(ctx, cx, cy);

      // 3b. Station-keep centre dot — vestigial; no-op outside SK so the call
      // is cheap but kept here for symmetry / future SK indicators.
      this._drawSkCenterDot(ctx, cx, cy);

      // 4. Target indicator — green diamond + dashed line showing where the
      // target is relative to the crosshair.  Useless during SK because
      // (a) the target is at NDC≈(0,0) and (b) the TargetReticle bracket
      // already marks the debris.
      this._drawTargetIndicator(ctx, cx, cy);
    }

    // 5. Range readout
    this._drawRangeReadout(ctx, cx);

    // 6. Closure rate readout
    this._drawClosureRate(ctx, cx);

    // 7. Alignment bars
    this._drawAlignmentBars(ctx, cx, cy, w, h);

    // 8. Net status
    this._drawNetStatus(ctx, cx, h);

    // 9. Arm info
    this._drawArmInfo(ctx, w, h);

    // 10. Station-keep θ/φ/R readout (ST-8.5.1)
    this._drawStationKeepOverlay(ctx, cx, cy);

    // 11. CP-1 / P2 — per-arm tool-selection panel (below the SK readout)
    if (Constants.isFeatureEnabled('DAUGHTER_MULTITOOL')) {
      this._drawToolSelectionPanel(ctx, cx, cy);
    }
  }

  // --------------------------------------------------------------------------
  // DRAWING HELPERS
  // --------------------------------------------------------------------------

  /** @private Darken corners — narrow-FOV camera feel */
  _drawVignette(ctx, cx, cy, w, h) {
    const maxR = Math.sqrt(cx * cx + cy * cy);
    const grad = ctx.createRadialGradient(cx, cy, maxR * 0.35, cx, cy, maxR);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.6, 'rgba(0,0,0,0.15)');
    grad.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }

  /** @private Central cross (+) */
  _drawCrosshair(ctx, cx, cy) {
    const armLen = 40;
    const gap = 8;
    const lineW = 2;

    ctx.strokeStyle = C.primary;
    ctx.lineWidth = lineW;
    ctx.shadowColor = C.primaryGlow;
    ctx.shadowBlur = 6;

    ctx.beginPath();
    // Horizontal arms
    ctx.moveTo(cx - armLen, cy);
    ctx.lineTo(cx - gap, cy);
    ctx.moveTo(cx + gap, cy);
    ctx.lineTo(cx + armLen, cy);
    // Vertical arms
    ctx.moveTo(cx, cy - armLen);
    ctx.lineTo(cx, cy - gap);
    ctx.moveTo(cx, cy + gap);
    ctx.lineTo(cx, cy + armLen);
    ctx.stroke();

    // Small circle at center
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.strokeStyle = C.primary;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.shadowBlur = 0;
  }

  /**
   * @private Bright fixed centre dot visible only during STATION_KEEP.
   * Anchors the eye on the debris's projected screen-position, which is
   * mathematically (0,0) NDC every frame (verified by forensic NDC log).
   * The brain otherwise locks onto the rotating wireframe-cage / daughter
   * mesh as a reference frame and perceives the static debris as moving
   * during sweep — the centre dot eliminates that illusion.
   * Sits inside the existing crosshair gap & ring, no visual conflict.
   */
  _drawSkCenterDot(ctx, cx, cy) {
    if (!this._arm || this._arm.state !== 'STATION_KEEP') return;

    // Bright filled disc at radius 2 (within the crosshair's 4 px ring)
    ctx.save();
    ctx.shadowColor = C.primaryGlow;
    ctx.shadowBlur = 8;
    ctx.fillStyle = C.primary;
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** @private Diamond/square showing target position relative to crosshair */
  _drawTargetIndicator(ctx, cx, cy) {
    if (!this._target?._scenePosition) return;

    // Map offsets to screen pixels
    const sx = cx + this._offsetX * OFFSET_SCALE;
    const sy = cy - this._offsetY * OFFSET_SCALE; // invert Y: up is negative in screen

    // Clamp to visible area with margin
    const margin = 30;
    const clampedX = Math.max(margin, Math.min(this._width - margin, sx));
    const clampedY = Math.max(margin, Math.min(this._height - margin, sy));

    const totalOffset = Math.sqrt(this._offsetX ** 2 + this._offsetY ** 2);

    // Color by distance offset
    let color;
    if (totalOffset < 10) color = C.primary;
    else if (totalOffset < 50) color = C.warning;
    else color = C.danger;

    // Dashed alignment line from center to target indicator
    ctx.save();
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = C.primaryDim;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(clampedX, clampedY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // Draw diamond (rotated square)
    const size = 8;
    ctx.save();
    ctx.translate(clampedX, clampedY);
    ctx.rotate(Math.PI / 4);

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.strokeRect(-size / 2, -size / 2, size, size);

    // Inner dot when very close
    if (totalOffset < 5) {
      ctx.fillStyle = color;
      ctx.fillRect(-2, -2, 4, 4);
    }

    ctx.shadowBlur = 0;
    ctx.restore();
  }

  /** @private Top-center range readout: RNG: 145m */
  _drawRangeReadout(ctx, cx) {
    const y = 50;

    // Color by range
    let color;
    if (this._range < 50) color = C.primary;
    else if (this._range <= 200) color = C.warning;
    else color = C.danger;

    const rangeStr = this._range < 1000
      ? `RNG: ${this._range.toFixed(1)}m`
      : `RNG: ${(this._range / 1000).toFixed(2)}km`;

    ctx.font = `bold 14px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 4;
    ctx.fillText(rangeStr, cx, y);
    ctx.shadowBlur = 0;
  }

  /** @private Below range: CLR: -2.3 m/s with directional arrow */
  _drawClosureRate(ctx, cx) {
    const y = 70;

    const absRate = Math.abs(this._closureRate);
    let color, arrow;

    if (this._closureRate > 0.1) {
      // Closing
      color = C.primary;
      arrow = '▼';
    } else if (this._closureRate < -0.1) {
      // Opening
      color = C.danger;
      arrow = '▲';
    } else {
      // Near-zero
      color = C.warning;
      arrow = '●';
    }

    const rateStr = `CLR: ${arrow} ${absRate.toFixed(1)} m/s`;

    ctx.font = `13px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(rateStr, cx, y);
  }

  /** @private Left/bottom alignment bars with moving pips */
  _drawAlignmentBars(ctx, cx, cy, w, h) {
    const barLen = 200;
    const barThick = 4;
    const pipSize = 8;

    // ---------- Left bar (vertical offset: target above/below) ----------
    const lbX = 40;
    const lbY = cy - barLen / 2;

    // Bar background
    ctx.fillStyle = 'rgba(0, 255, 136, 0.08)';
    ctx.fillRect(lbX - barThick / 2, lbY, barThick, barLen);

    // Center tick
    ctx.fillStyle = C.primaryDim;
    ctx.fillRect(lbX - 6, cy - 0.5, 12, 1);

    // Pip position: clamp offset to [-100, 100], map to bar range
    const vClamp = Math.max(-100, Math.min(100, this._offsetY));
    const vPipY = cy - (vClamp / 100) * (barLen / 2);

    // Pip
    ctx.fillStyle = Math.abs(this._offsetY) < 10 ? C.primary : C.warning;
    ctx.beginPath();
    ctx.moveTo(lbX - pipSize, vPipY);
    ctx.lineTo(lbX, vPipY - pipSize / 2);
    ctx.lineTo(lbX, vPipY + pipSize / 2);
    ctx.closePath();
    ctx.fill();

    // Label
    ctx.font = `10px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = C.gray;
    ctx.fillText('V', lbX, lbY - 8);

    // ---------- Bottom bar (horizontal offset: target left/right) ----------
    const bbX = cx - barLen / 2;
    const bbY = h - 100;

    // Bar background
    ctx.fillStyle = 'rgba(0, 255, 136, 0.08)';
    ctx.fillRect(bbX, bbY - barThick / 2, barLen, barThick);

    // Center tick
    ctx.fillStyle = C.primaryDim;
    ctx.fillRect(cx - 0.5, bbY - 6, 1, 12);

    // Pip
    const hClamp = Math.max(-100, Math.min(100, this._offsetX));
    const hPipX = cx + (hClamp / 100) * (barLen / 2);

    ctx.fillStyle = Math.abs(this._offsetX) < 10 ? C.primary : C.warning;
    ctx.beginPath();
    ctx.moveTo(hPipX, bbY + pipSize);
    ctx.lineTo(hPipX - pipSize / 2, bbY);
    ctx.lineTo(hPipX + pipSize / 2, bbY);
    ctx.closePath();
    ctx.fill();

    // Label
    ctx.fillStyle = C.gray;
    ctx.fillText('H', bbX - 10, bbY + 3);
  }

  /** @private Bottom center: net readiness indicator */
  _drawNetStatus(ctx, cx, h) {
    const y = h - 55;
    const ready = this.isNetReady();

    if (ready) {
      // Pulsing green when in capture range
      const pulse = 0.6 + Math.sin(this._time * 4) * 0.4;
      ctx.font = `bold 14px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = `rgba(0, 255, 136, ${pulse})`;
      ctx.shadowColor = C.primary;
      ctx.shadowBlur = 10;
      ctx.fillText('● NET READY — [SPACE] Deploy', cx, y);
      ctx.shadowBlur = 0;
    } else {
      ctx.font = `13px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = C.gray;
      ctx.fillText('○ NET — get closer to deploy', cx, y);
    }
  }

  /** @private Bottom-right: arm ID, fuel, tether */
  _drawArmInfo(ctx, w, h) {
    if (!this._arm) return;

    const x = w - 20;
    let y = h - 80;
    const lineH = 16;

    ctx.font = `12px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    // Arm ID + type
    ctx.fillStyle = C.primary;
    ctx.fillText(`${this._arm.id.toUpperCase()} [${this._arm.type.toUpperCase()}]`, x, y);
    y += lineH;

    // Fuel percentage
    const fuel = Math.round(this._arm.fuel ?? 0);
    let fuelColor;
    if (fuel > 50) fuelColor = C.primary;
    else if (fuel > 20) fuelColor = C.warning;
    else fuelColor = C.danger;
    ctx.fillStyle = fuelColor;
    ctx.fillText(`FUEL: ${fuel}%`, x, y);
    y += lineH;

    // Tether length
    const tether = Math.round(this._arm.tetherLength ?? 0);
    const tetherMax = this._arm.config?.tetherMax ?? 2000;
    const tetherPct = (tether / tetherMax * 100).toFixed(0);
    let tetherColor;
    if (tether / tetherMax > 0.9) tetherColor = C.danger;
    else if (tether / tetherMax > 0.7) tetherColor = C.warning;
    else tetherColor = C.primary;
    ctx.fillStyle = tetherColor;
    ctx.fillText(`TETHER: ${tether}m (${tetherPct}%)`, x, y);
  }

  // --------------------------------------------------------------------------
  // STATION-KEEP OVERLAY (ST-8.5.1)
  // --------------------------------------------------------------------------

  /** @private Draw θ/φ/R readout when arm is in STATION_KEEP state */
  _drawStationKeepOverlay(ctx, cx, cy) {
    if (!this._arm || this._arm.state !== 'STATION_KEEP') return;

    const theta = (this._arm._orbitTheta * 180 / Math.PI) % 360;
    const phi = this._arm._orbitPhi * 180 / Math.PI;
    const radius = this._arm._standoffR;

    // Draw readout box below center crosshair
    const boxX = cx;
    const boxY = cy + 70;

    // § Q5: extra height for NET counter when CAPTURE_NET is ON.
    // When DAUGHTER_MULTITOOL is ON the dedicated tool panel renders the NET (n)
    // row below, so suppress the in-box counter to avoid showing it twice.
    const showNetCount = Constants.isFeatureEnabled('CAPTURE_NET')
      && !Constants.isFeatureEnabled('DAUGHTER_MULTITOOL');
    const netCount = showNetCount && typeof this._arm.getNetInventory === 'function'
      ? this._arm.getNetInventory() : 0;

    // Background
    ctx.fillStyle = 'rgba(0, 20, 40, 0.7)';
    const boxW = 180;
    const boxH = showNetCount ? 68 : 52;
    ctx.fillRect(boxX - boxW / 2, boxY - 4, boxW, boxH);

    // Border
    ctx.strokeStyle = 'rgba(0, 255, 170, 0.4)';
    ctx.lineWidth = 1;
    ctx.strokeRect(boxX - boxW / 2, boxY - 4, boxW, boxH);

    // Header
    ctx.font = `bold 10px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0, 255, 170, 0.7)';
    ctx.fillText('STATION KEEP', boxX, boxY + 6);

    // θ / φ / R values
    ctx.font = `13px ${FONT}`;
    ctx.fillStyle = '#00ffaa';
    const thetaStr = `\u03B8:${theta >= 0 ? '+' : ''}${theta.toFixed(1)}\u00B0`;
    const phiStr = `\u03C6:${phi >= 0 ? '+' : ''}${phi.toFixed(1)}\u00B0`;
    const rStr = `R:${radius.toFixed(1)}m`;
    ctx.fillText(`${thetaStr}  ${phiStr}  ${rStr}`, boxX, boxY + 26);

    // Min/max range indicator bar
    const rMin = this._arm._rMin || 2;
    const rMax = this._arm._rMax || 15;
    const barY = boxY + 40;
    const barW = boxW - 20;
    const barX = boxX - barW / 2;

    ctx.fillStyle = 'rgba(0, 255, 170, 0.1)';
    ctx.fillRect(barX, barY - 2, barW, 4);

    // Current radius pip on bar
    const rFrac = Math.max(0, Math.min(1, (radius - rMin) / (rMax - rMin)));
    const pipX = barX + rFrac * barW;
    ctx.fillStyle = '#00ffaa';
    ctx.beginPath();
    ctx.arc(pipX, barY, 3, 0, Math.PI * 2);
    ctx.fill();

    // §13 Q5: NET inventory counter below range bar
    if (showNetCount) {
      const netY = barY + 16;
      ctx.font = `bold 11px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = netCount === 0 ? '#ff4444' : 'rgba(0, 255, 170, 0.8)';
      ctx.fillText('NET (' + netCount + ')', boxX, netY);
    }
  }

  /**
   * @private CP-1 / P2 — STATION_KEEP tool-selection panel
   * (DAUGHTER_MULTITOOL_SPEC §8.1). Renders one row per verb in the arm's
   * toolset with a ▶ on the selected tool, ★ scores, NET (n) magazine count,
   * and a hint. Sits directly below the θ/φ/R readout box; no overlap.
   */
  _drawToolSelectionPanel(ctx, cx, cy) {
    const arm = this._arm;
    if (!arm || arm.state !== 'STATION_KEEP') return;
    const toolset = arm.toolset || [];
    if (toolset.length === 0) return;

    const HUD = Constants.TOOL_HUD || {};
    const GLYPHS = HUD.GLYPHS || { NET: 'N', MAGNET: 'M', GRIPPER: 'G', PAD: 'P' };
    const scores = arm._toolScores || {};
    const hints = arm._toolHints || {};
    const selected = arm.selectedTool || 'NET';
    const netCount = (typeof arm.getNetInventory === 'function') ? arm.getNetInventory() : 0;

    const rowH = HUD.ROW_HEIGHT_PX || 16;
    const boxW = HUD.PANEL_WIDTH_PX || 180;
    // Position below the SK readout box (boxY = cy+70, max bottom ≈ cy+134).
    const boxX = cx;
    const boxY = cy + 142;
    const headerH = 16;
    const footerH = 14;
    const boxH = headerH + toolset.length * rowH + footerH + 8;
    const left = boxX - boxW / 2;

    // Background + border
    ctx.fillStyle = 'rgba(0, 20, 40, 0.7)';
    ctx.fillRect(left, boxY - 4, boxW, boxH);
    ctx.strokeStyle = 'rgba(0, 255, 170, 0.4)';
    ctx.lineWidth = 1;
    ctx.strokeRect(left, boxY - 4, boxW, boxH);

    // Header
    const armLabel = arm.type === 'weaver' ? 'Weaver' : arm.type === 'spinner' ? 'Spinner' : 'Daughter';
    ctx.font = `bold 10px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0, 255, 170, 0.7)';
    ctx.fillText(`TOOL  (${armLabel})`, left + 8, boxY + 6);

    // Rows
    let y = boxY + headerH + 6;
    for (const kind of toolset) {
      const isSel = kind === selected;
      const score = scores[kind] || 0;
      const dimmed = score <= 0;
      const glyph = GLYPHS[kind] || kind[0];
      let label = kind;
      if (kind === 'NET') label = `NET (${netCount})`;

      // selection marker
      ctx.font = `bold 11px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillStyle = isSel ? (HUD.HIGHLIGHT_COLOR || '#ffd166') : 'rgba(0,255,170,0.3)';
      ctx.fillText(isSel ? '\u25B6' : ' ', left + 6, y);

      // glyph + label
      ctx.font = `${isSel ? 'bold ' : ''}11px ${FONT}`;
      ctx.fillStyle = dimmed
        ? (HUD.DIMMED_COLOR || 'rgba(180,200,210,0.55)')
        : (isSel ? (HUD.HIGHLIGHT_COLOR || '#ffd166') : 'rgba(0,255,170,0.85)');
      ctx.fillText(`${glyph} \u00B7 ${label}`, left + 20, y);

      // stars (score) or em-dash if not viable
      ctx.textAlign = 'right';
      if (score > 0) {
        ctx.fillStyle = HUD.RECOMMEND_COLOR || '#00ffaa';
        ctx.fillText('\u2605'.repeat(score), left + boxW - 8, y);
      } else {
        ctx.fillStyle = HUD.DIMMED_COLOR || 'rgba(180,200,210,0.55)';
        ctx.fillText('\u2014', left + boxW - 8, y);
      }
      y += rowH;
    }

    // Footer
    ctx.font = `9px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(0, 255, 170, 0.5)';
    ctx.fillText('[`] cycle   [F] dispatch', left + 8, y + 2);

    // Selected-tool hint (right-aligned under footer, if present)
    const hint = hints[selected];
    if (hint) {
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(0, 255, 170, 0.45)';
      ctx.fillText(hint, left + boxW - 8, y + 2);
    }
    ctx.textAlign = 'left';
  }

  /**
   * @private Update the _skActive flag (used by _drawSkCenterDot to render
   * the on-screen Canvas2D centre dot during STATION_KEEP).
   * Previously this method also managed a Three.js standoff wireframe sphere
   * around the debris (color 0x00ffaa) but that visual was removed:
   * it cluttered the SK view and competed with the debris for visual focus.
   */
  _updateSkActiveFlag() {
    this._skActive = !!(this._arm && this._arm.state === 'STATION_KEEP');
  }

}
