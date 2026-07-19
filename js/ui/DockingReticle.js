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
import {
  getNetClassForType, computeLeadAim, assessNetFit, presentedWidthForApproach,
} from '../entities/CaptureNet.js';
import { dossierSystem } from '../systems/DossierSystem.js';
import { toolShortLabel } from '../systems/ToolOdds.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

/** 1 meter in scene units (1 scene unit = 100 km) */
const M = 0.00001;

/** Daughter states in which net guidance is still meaningful (pre-capture). */
const PRE_CAPTURE_STATES = new Set(['TRANSIT', 'APPROACH']);

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
    // M2: drop the odds-display easing state when the piloted arm or the
    // target changes — otherwise the strip briefly counts up from the previous
    // context's odds and shows phantom trend arrows.
    if (arm !== this._arm || target !== this._target) {
      this._oddsEase = null;
    }
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
    this._lastDt = dt;   // Phase 1b: odds-strip display easing needs frame dt
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
      'TRAWLING', 'HAULING',
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

    // 5/6. Range + closure-rate readouts — MANUAL PILOT ONLY.
    // RNG/CLR are advanced hand-flying instruments: the pilot uses closure
    // rate to feather the final approach and RNG for fine arm-tip distance.
    // Under autopilot the DAP controller flies the approach itself, so these
    // numbers are noise (and RNG duplicates the per-debris TargetReticle
    // distance). Suppress them unless the player is actually flying the arm.
    if (this._arm.isManual && this._arm.isManual()) {
      // 5. Range readout
      this._drawRangeReadout(ctx, cx);

      // 6. Closure rate readout
      this._drawClosureRate(ctx, cx);
    }

    // 7. Alignment bars
    this._drawAlignmentBars(ctx, cx, cy, w, h);

    // 8. Net status
    this._drawNetStatus(ctx, cx, h);

    // 9. Arm info
    this._drawArmInfo(ctx, w, h);

    // 10. (removed 2026-06-14) Station-keep θ/φ/R readout box — declutter.
    //     The live capture-odds strip below already carries the SK feedback the
    //     player acts on; the raw θ/φ/R numbers were noise.

    // 11. CP-1 / P2 — per-arm tool-selection panel (the capture-odds strip)
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

  /**
   * @private Bottom center: net readiness / verb hint — STATE-AWARE (Item 10,
   * 2026-06-12). One hint line, no stacking:
   *   • STATION_KEEP: N/`/R/Esc verb bar — Space does NOTHING in SK (the old
   *     '[SPACE] Deploy' hint pointed at a dead key; the SK fire verb is N).
   *   • TRANSIT/APPROACH + ready: N fire.
   *   • Not ready: get closer.
   *   • Any post-capture / retrieval state (NETTING, GRAPPLED, HAULING,
   *     REELING, RETURNING, …): draw NOTHING — the net is already committed,
   *     so a lingering "NET READY — [N] fire" / "get closer" line is obsolete
   *     (2026-06-13 fix: reticle stayed visible while the piloted arm hauled
   *     its catch home).
   */
  _drawNetStatus(ctx, cx, h) {
    const y = h - 55;
    const state = this._arm && this._arm.state;
    const inSK = state === 'STATION_KEEP';
    // Net guidance is only meaningful before the net is committed. Once the
    // arm leaves the pre-capture deployable states, suppress the line entirely.
    if (!inSK && !PRE_CAPTURE_STATES.has(state)) return;

    const ready = this.isNetReady();

    if (inSK) {
      const tool = (this._arm.selectedTool || 'NET').toUpperCase();
      const pulse = 0.6 + Math.sin(this._time * 4) * 0.4;
      ctx.font = `bold 13px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = ready ? `rgba(0, 255, 136, ${pulse})` : C.gray;
      ctx.fillText(`\u25CF [N] ${tool} \u00B7 [\`] cycle \u00B7 [R] reel \u00B7 [Esc] recall`, cx, y);
    } else if (ready) {
      // Pulsing green when in capture range
      const pulse = 0.6 + Math.sin(this._time * 4) * 0.4;
      ctx.font = `bold 14px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = `rgba(0, 255, 136, ${pulse})`;
      ctx.shadowColor = C.primary;
      ctx.shadowBlur = 10;
      ctx.fillText('\u25CF NET READY: [N] launch', cx, y);
      ctx.shadowBlur = 0;
    } else {
      ctx.font = `13px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = C.gray;
      ctx.fillText('\u25CB NET: get closer to deploy', cx, y);
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
    const armName = this._arm.displayName || `${this._arm.id} [${this._arm.type}]`;
    ctx.fillText(armName.toUpperCase(), x, y);
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
  // (removed 2026-06-14) STATION-KEEP θ/φ/R OVERLAY — decluttered. The capture-
  // odds strip carries the actionable SK feedback; the raw angle/range numbers
  // were visual noise.
  // --------------------------------------------------------------------------

  /**
   * @private Capture Odds Strip — one widget, four context states
   * (capture-feedback overhaul Phase 1b; replaces the vertical ★-score list).
   *
   *   AIM       (STATION_KEEP)        — live odds strip; % is the hero.
   *   IN FLIGHT (NETTING, net away)   — strip dims to labels; `NET AWAY — 34m`.
   *   REELING   (GRAPPLED/REELING + payload) — TENSION bar with RIP/SNAP ticks.
   *   RESULT    — existing full-screen flashes (NET FAILED / TETHER SNAP)
   *               handle it; the widget draws nothing.
   */
  _drawToolSelectionPanel(ctx, cx, cy) {
    const arm = this._arm;
    if (!arm) return;
    if (arm.state === 'STATION_KEEP') {
      this._drawOddsStripAim(ctx, cx, cy);
    } else if (arm.state === 'NETTING') {
      this._drawOddsStripInFlight(ctx, cx, cy);
    } else if ((arm.state === 'GRAPPLED' || arm.state === 'REELING') && arm.capturedDebris) {
      this._drawTensionBar(ctx, cx, cy);
    }
    // RESULT state: full-screen flashes elsewhere — nothing here.
  }

  /** @private Widget frame shared by all states. Returns {left, top, boxW}. */
  _oddsPanelFrame(ctx, cx, cy, boxH) {
    const HUD = Constants.TOOL_HUD || {};
    const boxW = HUD.PANEL_WIDTH_PX || 180;
    const left = cx - boxW / 2;
    const top = cy + 142;
    ctx.fillStyle = 'rgba(0, 20, 40, 0.7)';
    ctx.fillRect(left, top - 4, boxW, boxH);
    ctx.strokeStyle = 'rgba(0, 255, 170, 0.4)';
    ctx.lineWidth = 1;
    ctx.strokeRect(left, top - 4, boxW, boxH);
    return { left, top, boxW };
  }

  /** @private Short column label per verb (names are footnotes; % is the hero). */
  _oddsColLabel(kind) {
    return toolShortLabel(kind);
  }

  /** @private Odds → colour tier (always paired with a symbol/word — colourblind-safe). */
  _oddsColor(pct) {
    const HUD = Constants.TOOL_HUD || {};
    if (pct >= 80) return HUD.COLOR_GOOD || '#00ffaa';
    if (pct >= 50) return HUD.COLOR_MID || '#ffd166';
    if (pct >= 1) return HUD.COLOR_LOW || '#ff7755';
    return HUD.COLOR_ZERO || 'rgba(180,200,210,0.45)';
  }

  /**
   * @private Ease the displayed odds toward the truth (~300 ms lerp) and track
   * the trend rate, so de-spinning reads as a live count-up: 41%↑ 48%↑ 57%↑.
   * Motion IS the reward — this is the loop that teaches "pull a lever → odds climb".
   */
  _easeOdds(kind, pTrue) {
    const TO = Constants.TOOL_ODDS || {};
    const dt = this._lastDt || 0.016;
    if (!this._oddsEase) this._oddsEase = {};
    let e = this._oddsEase[kind];
    if (!e) e = this._oddsEase[kind] = { shown: pTrue, rate: 0, lastTrue: pTrue };
    // Trend rate (smoothed Δp/s) from the TRUE value, so the arrow leads the easing.
    const inst = dt > 0 ? (pTrue - e.lastTrue) / dt : 0;
    e.rate = e.rate * 0.85 + inst * 0.15;
    e.lastTrue = pTrue;
    // Display easing.
    const tau = TO.DISPLAY_LERP_S || 0.3;
    const k = 1 - Math.exp(-dt / tau);
    e.shown += (pTrue - e.shown) * k;
    if (Math.abs(e.shown - pTrue) < 0.002) e.shown = pTrue;
    return e;
  }

  /** @private AIM state — the live Capture Odds Strip. */
  _drawOddsStripAim(ctx, cx, cy) {
    const arm = this._arm;
    const toolset = arm.toolset || [];
    if (toolset.length === 0) return;

    const HUD = Constants.TOOL_HUD || {};
    const TO = Constants.TOOL_ODDS || {};
    const odds = arm._toolOdds || {};
    const selected = arm.selectedTool || 'NET';
    const netCount = (typeof arm.getNetInventory === 'function') ? arm.getNetInventory() : 0;
    // Phase 1.5: knowledge gates the readout — before Full Profile the est-mass
    // strain band is uncertain (NET % renders with ~) and brittleness is
    // unknown (FRAG chip shows ?). Honest about what we don't know.
    const skTarget = arm._stationKeepTarget || arm.target;
    const profiled = skTarget ? dossierSystem.isProfiled(skTarget.id) : true;

    const headerH = 14;
    const oddsRowH = 18;
    const labelRowH = 11;
    const blockerRowH = 10;
    const advisoryH = 13;
    const footerH = 13;
    const boxH = headerH + oddsRowH + labelRowH + blockerRowH + advisoryH + footerH + 6;
    const { left, top, boxW } = this._oddsPanelFrame(ctx, cx, cy, boxH);

    // Header — arm class.
    const armLabel = arm.type === 'weaver' ? 'LARGE' : arm.type === 'spinner' ? 'SMALL' : 'DAUGHTER';
    ctx.font = `bold 10px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0, 255, 170, 0.7)';
    ctx.fillText(armLabel, left + 8, top + 5);

    // ── Fixed columns in cycle order (the eye learns positions) ──
    const colW = HUD.COL_WIDTH_PX || 48;
    const stripW = toolset.length * colW;
    const stripLeft = left + (boxW - stripW) / 2;
    const oddsY = top + headerH + oddsRowH / 2;
    const labelY = top + headerH + oddsRowH + labelRowH / 2;
    const blockerY = labelY + labelRowH / 2 + blockerRowH / 2;
    const cap = TO.DISPLAY_CAP ?? 0.99;
    const trendRate = TO.TREND_RATE_PER_S ?? 0.02;

    let selectedPct = null;
    for (let i = 0; i < toolset.length; i++) {
      const kind = toolset[i];
      const o = odds[kind];
      const colCx = stripLeft + i * colW + colW / 2;
      const isSel = kind === selected;

      let text;
      let color;
      let pct = null;
      let rising = false;
      let falling = false;

      if (!o || o.p == null) {
        // Empty magazine / offline: '--', not 0% — different cause, different fix.
        text = '--';
        color = HUD.COLOR_ZERO || 'rgba(180,200,210,0.45)';
        if (this._oddsEase) delete this._oddsEase[kind];
      } else {
        const e = this._easeOdds(kind, o.p);
        pct = Math.round(Math.min(e.shown, cap) * 100);
        color = this._oddsColor(pct);
        rising = e.rate > trendRate;
        falling = e.rate < -trendRate;
        // Unprofiled target: est-mass strain band is uncertain → honest ~.
        const approx = (kind === 'NET' && !profiled) ? '~' : '';
        text = `${approx}${pct}%${rising ? '\u2191' : falling ? '\u2193' : ''}`;
      }
      if (isSel) selectedPct = pct;

      // Odds number — 14px bold, brightness pulse while rising.
      ctx.font = `bold ${HUD.ODDS_FONT_PX || 14}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = color;
      if (rising) {
        ctx.globalAlpha = 0.8 + 0.2 * Math.abs(Math.sin(this._time * 6));
      }
      ctx.fillText(text, colCx, oddsY);
      ctx.globalAlpha = 1;

      // Label row — 9px, ▶ on selected, ·n magazine count on NET.
      let label = this._oddsColLabel(kind);
      if (kind === 'NET') label += `\u00B7${netCount}`;
      else if (kind === 'PAD' && typeof arm._padUvCureDosesRemaining === 'number') {
        label += `\u00B7${arm._padUvCureDosesRemaining}`;
      }
      ctx.font = `${isSel ? 'bold ' : ''}${HUD.LABEL_FONT_PX || 9}px ${FONT}`;
      ctx.fillStyle = isSel
        ? (HUD.HIGHLIGHT_COLOR || '#ffd166')
        : 'rgba(180, 200, 210, 0.6)';
      ctx.fillText((isSel ? '\u25B6' : '') + label, colCx, labelY);

      // Selected column: odds-coloured underline.
      if (isSel) {
        ctx.strokeStyle = (pct == null) ? (HUD.COLOR_ZERO || 'rgba(180,200,210,0.45)') : color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(colCx - colW / 2 + 8, labelY + 6);
        ctx.lineTo(colCx + colW / 2 - 8, labelY + 6);
        ctx.stroke();
      }

      // Blocker word — 8px red, ONLY when the verb is dead (0% / --).
      // Phase 2: the NET column carries the live aspect chip instead when the
      // target is elongated and the mouth sits between widthM and lengthM —
      // the % already encodes it (0% ↔ 96%); the chip explains WHY.
      const aspectChip = (kind === 'NET') ? this._netAspectChip(skTarget) : null;
      if (aspectChip) {
        ctx.font = `bold ${HUD.BLOCKER_FONT_PX || 8}px ${FONT}`;
        ctx.fillStyle = aspectChip.color;
        ctx.fillText(aspectChip.text, colCx, blockerY);
      } else if (o && (o.p === 0 || o.p == null) && o.blocker) {
        ctx.font = `bold ${HUD.BLOCKER_FONT_PX || 8}px ${FONT}`;
        ctx.fillStyle = HUD.COLOR_BLOCKER || '#ff5555';
        ctx.fillText(o.blocker, colCx, blockerY);
      }
    }

    // ── One advisory line: the single biggest lever ──
    const advisoryY = blockerY + blockerRowH / 2 + advisoryH / 2;
    const adv = this._buildOddsAdvisory(odds, selected, selectedPct);
    if (adv) {
      ctx.font = `9px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = adv.color;
      ctx.fillText(adv.text, cx, advisoryY);
    }

    // ── Footer: keys + ⚠FRAG chip (only when risk ≥ FRAG_CHIP_MIN) ──
    const footerY = advisoryY + advisoryH / 2 + footerH / 2;
    ctx.font = `9px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(0, 255, 170, 0.5)';
    ctx.fillText('[`] cycle   [N] launch', left + 8, footerY);
    const fragRisk = arm._toolOddsFragRisk || 0;
    if (!profiled) {
      // Brittleness unknown until the close-range survey — say so honestly.
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255, 170, 0, 0.55)';
      ctx.fillText('\u26A0FRAG ?', left + boxW - 8, footerY);
    } else if (fragRisk >= (TO.FRAG_CHIP_MIN ?? 0.10)) {
      ctx.textAlign = 'right';
      ctx.fillStyle = fragRisk >= 0.3 ? '#ff5555' : '#ffaa00';
      ctx.fillText(`\u26A0FRAG ${Math.round(fragRisk * 100)}%`, left + boxW - 8, footerY);
    }
    ctx.textAlign = 'left';
  }

  /**
   * @private Phase 2 — live aspect chip for the NET column. Non-null only when
   * the target is elongated AND the mouth ∈ (widthM, lengthM): the catch is
   * orientation-dependent, so name the current presentation.
   * @returns {{text:string, color:string}|null}
   */
  _netAspectChip(target) {
    if (!target) return null;
    if (Constants.isFeatureEnabled && !Constants.isFeatureEnabled('ASPECT_CAPTURE')) return null;
    const arm = this._arm;
    const lengthM = (target.lengthM != null) ? target.lengthM : (target.sizeMeter || 0);
    const widthM = (target.widthM != null) ? target.widthM : (target.sizeMeter || 0);
    if (!(lengthM > widthM)) return null;
    const dia = getNetClassForType(arm.type).DIAMETER || 0;
    if (!(dia > widthM && dia < lengthM)) return null;   // orientation can't change the verdict
    const tp = target._scenePosition;
    if (!tp || !arm.position) return null;
    const presented = presentedWidthForApproach(target, {
      x: tp.x - arm.position.x,
      y: tp.y - arm.position.y,
      z: tp.z - arm.position.z,
    });
    const HUD = Constants.TOOL_HUD || {};
    // M5: the ✓ shows when presented width fits the mouth with the tunable
    // margin (1.0 = exact fit; <1 demands slack before advertising the shot).
    const fitMargin = (Constants.ASPECT_CAPTURE && Constants.ASPECT_CAPTURE.END_ON_FIT_MARGIN) ?? 1.0;
    return presented <= dia * fitMargin
      ? { text: 'END-ON \u2713', color: HUD.COLOR_GOOD || '#00ffaa' }
      : { text: 'BROADSIDE', color: HUD.COLOR_BLOCKER || '#ff5555' };
  }

  /**
   * @private One advisory line — driven by the selected tool's top blocker,
   * preserving the established priority chain for NET (width → range →
   * off-axis → tumble with the live de-spin readout). If a different tool
   * beats the selected by more than SWITCH_ADVISE_MARGIN, offer the switch.
   */
  _buildOddsAdvisory(odds, selected, selectedPct) {
    const arm = this._arm;
    const TO = Constants.TOOL_ODDS || {};
    const target = arm._stationKeepTarget || arm.target;
    const sel = odds[selected];

    // Deterministic blockers on the selected tool → the fix is the advisory.
    if (sel && sel.p == null) {
      return { text: sel.hint || 'unavailable', color: '#ff7755' };
    }

    // Switch offer: another tool beats the selected by > 20 pts.
    const switchMargin = TO.SWITCH_ADVISE_MARGIN ?? 0.20;
    let bestKind = null;
    let bestP = (sel && sel.p) || 0;
    for (const kind of Object.keys(odds)) {
      if (kind === selected) continue;
      const o = odds[kind];
      if (o && o.p != null && o.p > bestP + switchMargin) {
        bestKind = kind;
        bestP = o.p;
      }
    }

    if (selected === 'NET') {
      const range = (typeof arm._standoffR === 'number' && arm._standoffR > 0)
        ? arm._standoffR : 50;
      const netAdv = this._buildNetAdvisory(target, range, selectedPct ?? 0);
      // NET-dead + better tool available → the switch IS the fix.
      if (sel && sel.p === 0 && bestKind) {
        return {
          text: `${this._oddsColLabel(bestKind)} ${Math.round(bestP * 100)}% \u2014 switch [\`]`,
          color: '#ffd166',
        };
      }
      if (netAdv) return { text: netAdv.text, color: netAdv.color };
      if (bestKind) {
        return {
          text: `${this._oddsColLabel(bestKind)} ${Math.round(bestP * 100)}% \u2014 switch [\`]`,
          color: '#ffd166',
        };
      }
      // Phase 1.5: nothing more urgent → offer the knowledge fix.
      if (target && !dossierSystem.isProfiled(target.id)) {
        const surveyM = (Constants.DOSSIER && Constants.DOSSIER.DETAIL_SCAN_RANGE_M) || 50;
        return { text: `close to ${surveyM}m to survey`, color: 'rgba(0, 255, 170, 0.6)' };
      }
      return null;
    }

    // Non-NET selected: blocker hint first, then the switch offer.
    if (sel && sel.p === 0 && sel.hint) {
      return { text: sel.hint, color: '#ff7755' };
    }
    // Phase 3c: live eddy-damping readout — the MAGNET's passive secondary is
    // working; show the tumble bleeding so the NET % climb reads as caused.
    if (selected === 'MAGNET' && target && target._eddyDamping) {
      const deg = Math.abs(target.tumbleRate || 0) * (180 / Math.PI);
      return { text: `eddy-damping ${deg.toFixed(1)}\u00B0/s\u2193`, color: '#66ddff' };
    }
    if (bestKind) {
      return {
        text: `${this._oddsColLabel(bestKind)} ${Math.round(bestP * 100)}% \u2014 switch [\`]`,
        color: '#ffd166',
      };
    }
    if (sel && sel.hint && sel.p < 0.5) {
      return { text: sel.hint, color: 'rgba(0, 255, 170, 0.6)' };
    }
    return null;
  }

  /**
   * @private Map the fired net's FSM state → {label, color} for the in-flight
   * readout. This is where the capture ceremony is now signalled: the net mesh
   * stays ivory Dyneema (CaptureNetVisual realism pass, 2026-06-30) and the
   * phase the player used to read off the net's colour reads here instead.
   * Colours mirror the old net hue energy ramp so the muscle memory carries
   * over — but each is paired with a WORD (colourblind-safe).
   * Returns null for pre-contact flight (caller shows the distance readout).
   * @param {object} net — arm._firedNet (NetProjectile) or null
   * @returns {{ label: string, color: string }|null}
   */
  _netPhaseReadout(net) {
    const S = Constants.CAPTURE_NET && Constants.CAPTURE_NET.STATES;
    if (!net || !S) return null;
    switch (net.state) {
      case S.CONTACT:       return { label: 'CONTACT',        color: '#ffdd44' };
      case S.BRAKE:         return { label: 'TETHER LOCK',    color: '#ff9933' };
      case S.ENVELOP:       return { label: 'ENVELOPING',     color: '#ff6655' };
      case S.CINCH_CLOSING: return { label: 'CINCHING',       color: '#ff66dd' };
      case S.SECURE_CHECK:  return { label: 'SECURING\u2026', color: '#aaff44' };
      case S.CAPTURED:      return { label: 'CAPTURED \u2713', color: '#66ff99' };
      case S.MISSED:        return { label: 'MISS',           color: C.danger };
      default:              return null; // FOLDED/LAUNCHING/SPINNING_UP/FLIGHT → distance
    }
  }

  /** @private IN FLIGHT — strip dims to labels only; status line carries either
   * `NET AWAY — 34m` (pre-contact) or the colour-coded capture phase
   * (CONTACT → … → SECURING) once the net reaches the target. The net mesh no
   * longer changes colour, so this readout IS the capture-state signal. */
  _drawOddsStripInFlight(ctx, cx, cy) {
    const arm = this._arm;
    const toolset = arm.toolset || [];
    if (toolset.length === 0) return;
    const HUD = Constants.TOOL_HUD || {};
    const boxH = 14 + 14 + 16 + 6;
    const { left, top, boxW } = this._oddsPanelFrame(ctx, cx, cy, boxH);

    ctx.font = `bold 10px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0, 255, 170, 0.4)';
    const armLabel = arm.type === 'weaver' ? 'LARGE' : arm.type === 'spinner' ? 'SMALL' : 'DAUGHTER';
    ctx.fillText(armLabel, left + 8, top + 5);

    // Dim labels only — no stale odds during flight.
    const colW = HUD.COL_WIDTH_PX || 48;
    const stripLeft = left + (boxW - toolset.length * colW) / 2;
    ctx.font = `9px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(180, 200, 210, 0.35)';
    for (let i = 0; i < toolset.length; i++) {
      ctx.fillText(this._oddsColLabel(toolset[i]), stripLeft + i * colW + colW / 2, top + 14 + 7);
    }

    // Status line: capture phase once the net is at the target, else net range.
    const net = arm._firedNet;
    const phase = this._netPhaseReadout(net);
    const statusY = top + 14 + 14 + 8;
    ctx.font = `bold 11px ${FONT}`;
    if (phase) {
      // CAPTURED is a brief, celebratory pulse before the arm hands off to the
      // tension-bar (GRAPPLED) view; everything else reads steady.
      const S = Constants.CAPTURE_NET.STATES;
      if (net.state === S.CAPTURED) {
        ctx.globalAlpha = 0.7 + 0.3 * Math.abs(Math.sin(this._time * 6));
      }
      ctx.fillStyle = phase.color;
      ctx.fillText(phase.label, cx, statusY);
      ctx.globalAlpha = 1;
    } else {
      const distM = net ? Math.round(net.distanceTraveled || 0) : null;
      ctx.fillStyle = '#66ddff';
      ctx.fillText(distM != null ? `NET AWAY \u2014 ${distM}m` : 'NET AWAY', cx, statusY);
    }
    ctx.textAlign = 'left';
  }

  /**
   * @private REELING — the strip swaps to the TENSION bar: tether tension with
   * the SNAP tick + payload kg; pulses red near snap. Below it, a thin NET
   * STRAIN bar (payload / rated mass) carries the RIP tick on its own axis —
   * boost-rip risk is driven by strain, not tether tension, so the two never
   * share a scale. (Phase 3a adds the boost-reel key and live tension control.)
   */
  _drawTensionBar(ctx, cx, cy) {
    const arm = this._arm;
    const boxH = 14 + 12 + 16 + 12 + 14 + 6;
    const { left, top, boxW } = this._oddsPanelFrame(ctx, cx, cy, boxH);

    ctx.font = `bold 10px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0, 255, 170, 0.7)';
    ctx.fillText('TENSION', left + 8, top + 5);
    const payloadKg = (arm.capturedDebris && arm.capturedDebris.mass) || 0;
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(0, 255, 170, 0.6)';
    ctx.fillText(`${Math.round(payloadKg)} kg`, left + boxW - 8, top + 5);

    // Bar geometry.
    const barX = left + 10;
    const barW = boxW - 20;
    const barY = top + 14 + 10;
    const barH = 8;

    // Tension fraction of tether break strength (SNAP at 1.0).
    const breakN = arm.tetherBreakStrength || 100;
    const frac = Math.max(0, Math.min(1, (arm.tetherTension || 0) / breakN));
    const warnFrac = Constants.REEL_TENSION_WARNING ?? 0.7;
    const critFrac = Constants.REEL_TENSION_CRITICAL ?? 0.9;
    const critical = frac >= critFrac;

    // Track + fill (solid colour tiers — avoids gradient API in headless tests).
    ctx.fillStyle = 'rgba(0, 255, 170, 0.12)';
    ctx.fillRect(barX, barY, barW, barH);
    let fillCol = frac < warnFrac ? '#00ffaa' : frac < critFrac ? '#ffd166' : '#ff4444';
    if (critical) {
      // Pulse red near snap.
      ctx.globalAlpha = 0.6 + 0.4 * Math.abs(Math.sin(this._time * 8));
      fillCol = '#ff4444';
    }
    ctx.fillStyle = fillCol;
    ctx.fillRect(barX, barY, barW * frac, barH);
    ctx.globalAlpha = 1;

    // SNAP tick (tether axis only — RIP lives on the strain bar below).
    ctx.strokeStyle = '#ff4444';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(barX + barW - 1, barY - 3);
    ctx.lineTo(barX + barW - 1, barY + barH + 3);
    ctx.stroke();
    ctx.font = `8px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ff4444';
    ctx.fillText('SNAP', barX + barW, barY - 7);

    // NET STRAIN bar — the axis rip probability actually lives on
    // (payloadMass / _netRatedMass vs NET_STRAIN_SAFE_FRACTION, the same
    // quantities _updateReeling rolls boost-rip against). Only meaningful for
    // a net catch with a known rated mass.
    const strainY = barY + barH + 8;
    const strainH = 4;
    const ratedKg = arm._netRatedMass || 0;
    const isNetCatch = !arm._captureToolKind || arm._captureToolKind === 'NET';
    if (isNetCatch && ratedKg > 0 && payloadKg > 0) {
      const safe = Constants.NET_STRAIN_SAFE_FRACTION ?? 0.8;
      const strain = Math.max(0, Math.min(1, payloadKg / ratedKg));
      ctx.fillStyle = 'rgba(0, 255, 170, 0.12)';
      ctx.fillRect(barX, strainY, barW, strainH);
      ctx.fillStyle = strain > safe ? '#ffaa00' : 'rgba(0, 255, 170, 0.8)';
      ctx.fillRect(barX, strainY, barW * strain, strainH);
      // RIP tick at the safe fraction of the STRAIN axis.
      ctx.strokeStyle = '#ffaa00';
      ctx.beginPath();
      ctx.moveTo(barX + barW * safe, strainY - 2);
      ctx.lineTo(barX + barW * safe, strainY + strainH + 2);
      ctx.stroke();
      ctx.font = `8px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = strain > safe ? '#ffaa00' : 'rgba(255, 170, 0, 0.55)';
      ctx.fillText('RIP', barX + barW * safe, strainY + strainH + 7);
    }

    // Footer — boost-reel hint lands with Phase 3a's REEL_BOOST.
    if (Constants.isFeatureEnabled && Constants.isFeatureEnabled('REEL_BOOST')) {
      ctx.font = `9px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillStyle = arm._boostReel ? '#ffd166' : 'rgba(0, 255, 170, 0.5)';
      ctx.fillText(arm._boostReel ? 'BOOST REEL \u00D72' : 'hold [\u21E7] fast reel', left + 8, strainY + strainH + 16);
    }
    ctx.textAlign = 'left';
  }

  /**
   * @private NET advisory chain (formerly the P-CLING pre-fire readout — the
   * % itself now lives in the odds strip's NET column; Phase 1b folds the two
   * into one source so no duplicate % is shown). Priority preserved:
   * width → range → off-axis → tumble (with the live de-spin readout).
   * @returns {{ text: string, color: string }|null}
   */
  _buildNetAdvisory(target, range, pct) {
    const arm = this._arm;
    if (!target) return null;
    const netClass = getNetClassForType(arm.type);
    const CN = Constants.CAPTURE_NET;
    const tumbleOn = Constants.isFeatureEnabled && Constants.isFeatureEnabled('LASER_DESPIN');
    const tumbleRate = tumbleOn ? (target.tumbleRate ?? null) : null;

    let advisory = '';
    let advisoryCol = 'rgba(0, 255, 170, 0.6)';

    // UX-11 #1: off-axis warning — the auto-aim leads the target, but a big
    // lead angle (fast transverse drift) makes the shot fragile. Teach the
    // player to re-aim / match velocity before firing.
    let offAxisDeg = 0;
    const tScene = (typeof arm._getTargetScenePos === 'function') ? arm._getTargetScenePos() : null;
    if (tScene && arm.position) {
      const relVel = (arm._leadTargetVelValid && arm._leadTargetVel) ? arm._leadTargetVel : null;
      const launchSpeedScene = (netClass.LAUNCH_SPEED || 10) * M;
      const lead = computeLeadAim(arm.position, tScene, relVel, launchSpeedScene);
      offAxisDeg = lead.offAxisDeg;
    }
    const offAxisWarn = CN.OFF_AXIS_WARN_DEG || 12;

    // Item 4 (2026-06-12): width fork — wider-than-mouth debris is a
    // deterministic reel-time net failure; warn BEFORE the player commits.
    // Phase 2: orientation-aware — pass the live approach bearing so a long
    // body reads ASPECT (fits end-on) instead of a flat TOO_WIDE.
    let approachDir = null;
    if (tScene && arm.position) {
      approachDir = {
        x: tScene.x - arm.position.x,
        y: tScene.y - arm.position.y,
        z: tScene.z - arm.position.z,
      };
    }
    const fit = assessNetFit(target, netClass, approachDir);

    if (fit.fit === 'TOO_WIDE') {
      // Phase 0.2 (capture-feedback overhaul): only advise GRIPPER when this
      // arm actually carries one — the Spinner doesn't, so point at the Weaver.
      const toolset = (Constants.DAUGHTER_TOOLSETS && Constants.DAUGHTER_TOOLSETS[arm.type])
        || arm.toolset || [];
      advisory = toolset.includes('GRIPPER')
        ? 'too wide \u2014 use GRIPPER [`]'
        : 'too wide \u2014 recall [R], send the Large [D]';
      advisoryCol = '#ff5555';
    } else if (fit.fit === 'ASPECT') {
      // Phase 2: currently broadside on a body that fits end-on. Tumble makes
      // θ sweep — de-spin first to freeze the aspect, THEN orbit around.
      const inSpec = (Constants.NET_TUMBLE_PENALTY?.IN_SPEC_DEG) || 10;
      const deg = Math.abs(tumbleRate || 0) * (180 / Math.PI);
      if (tumbleRate != null && deg > inSpec && !target._despinning) {
        advisory = 'de-spin to freeze aspect [L]';
        advisoryCol = '#ffd166';
      } else {
        advisory = 'ASPECT: BROADSIDE \u2014 orbit to end-on';
        advisoryCol = '#ffd166';
      }
    } else if (range > (CN.ENVELOPE_RANGE || 100)) advisory = 'too far. Close in';
    else if (range > (CN.BASELINE_RANGE_MAX || 75)) advisory = 'edge of envelope';
    else if (offAxisDeg > offAxisWarn) {
      advisory = `OFF AXIS ${Math.round(offAxisDeg)}°. Re-aim`;
      advisoryCol = '#ff7755';
    } else if (tumbleRate != null) {
      const deg = Math.abs(tumbleRate) * (180 / Math.PI);
      const inSpec = (Constants.NET_TUMBLE_PENALTY?.IN_SPEC_DEG) || 10;
      // Issue 9 (2026-06-12): live °/s readout — while holding H the player
      // sees the tumble converge toward the in-spec threshold.
      if (target._despinning) {
        advisory = `de-spinning ${deg.toFixed(1)}\u00B0/s \u2192 ${inSpec}\u00B0/s`;
        advisoryCol = '#66ddff';
      } else if (deg > inSpec) {
        advisory = `tumbling ${Math.round(deg)}\u00B0/s \u2014 de-spin [L]`;
      }
    }
    if (!advisory && pct >= 80) advisory = 'good shot';
    return advisory ? { text: advisory, color: advisoryCol } : null;
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
