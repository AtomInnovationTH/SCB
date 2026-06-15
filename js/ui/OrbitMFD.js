/**
 * OrbitMFD.js — Orbiter-heritage orbit visualization panel
 * Canvas2D overlay showing player/target orbits as 2D ellipses
 * in a polar top-down (north pole) view.
 * Toggle with M key.
 * @module ui/OrbitMFD
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { GameStates } from '../core/GameState.js';
import {
  sceneToKm,
  hohmannDeltaV,
  totalDeltaV,
} from '../entities/OrbitalMechanics.js';
import { audioSystem } from '../systems/AudioSystem.js';

const TWO_PI = Math.PI * 2;
const DEG = 180 / Math.PI;

export class OrbitMFD {
  constructor() {
    this._size = 320;
    this._centerX = 160;
    this._centerY = 145; // slightly above center for readout room

    // --- Canvas setup ---
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;

    this._canvas = document.createElement('canvas');
    this._canvas.width = this._size * dpr;
    this._canvas.height = this._size * dpr;
    Object.assign(this._canvas.style, {
      position: 'fixed',
      bottom: '60px',
      left: '10px',     // bottom-left to avoid target panel overlap
      width: this._size + 'px',
      height: this._size + 'px',
      zIndex: '510',    // above comms panel
      pointerEvents: 'none',
      display: 'none',
      imageRendering: 'auto',
    });
    document.body.appendChild(this._canvas);
    this._ctx = this._canvas.getContext('2d');
    this._ctx.scale(dpr, dpr);
    this._ctx.imageSmoothingEnabled = true;
    this._ctx.imageSmoothingQuality = 'high';

    // --- State ---
    this._visible = false;
    this._updateTimer = 0;
    this._playerOrbit = null;
    this._targetOrbit = null;
    this._selectedTargetId = null;
    this._pxPerKm = 0;

    // --- Route Planner (Phase 6) ---
    this._routePlan = [];        // array of { target, orbit, dvToReach, cumulativeDV }
    this._showRoute = false;
    this._routeTotalDV = 0;

    // --- Altitude Sweep Planner (D2) ---
    this._sweepBands = [];       // { altMin, altMax, midAlt, count, density }
    this._sweepTarget = null;    // { alt, dv, bandIdx } — densest reachable band
    this._sweepStale = true;
    this._lastDebrisCount = 0;
    this._lastSweepAlt = 0;

    // --- Route staleness (D3) ---
    this._routeStale = true;
    this._lastPlayerSMA = 0;

    // Self-manage visibility via EventBus (decoupled from GameFlowManager)
    eventBus.on(Events.GAME_STATE_CHANGE, ({ to }) => {
      const gameplay = (to === GameStates.ORBITAL_VIEW || to === GameStates.APPROACH || to === GameStates.INTERACTION);
      if (!gameplay) this.hide();
    });
    eventBus.on(Events.GAME_RESET, () => {
      this.hide();
    });
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /** Toggle visibility of the MFD panel. */
  toggle() {
    if (this._visible) {
      this.hide();
    } else {
      this.show();
    }
    audioSystem.playClick();
  }

  /** Show the MFD panel. */
  show() {
    this._visible = true;
    this._canvas.style.display = 'block';
  }

  /** Hide the MFD panel. */
  hide() {
    this._visible = false;
    this._canvas.style.display = 'none';
  }

  /**
   * Called each frame from the game loop.
   * @param {number} dt — frame delta time (seconds)
   * @param {{ playerOrbit: object|null, targetOrbit: object|null, selectedTargetId: string|null }} data
   */
  update(dt, data) {
    if (!this._visible) return;

    // Throttle to ~5 Hz
    this._updateTimer += dt;
    if (this._updateTimer < 0.2) return;
    this._updateTimer = 0;

    this._playerOrbit = data.playerOrbit || null;
    this._targetOrbit = data.targetOrbit || null;
    this._selectedTargetId = data.selectedTargetId || null;

    // Altitude Sweep Planner (D2): update density bands
    if (data.cachedTargets && data.playerOrbit) {
      const pAltKm = sceneToKm(data.playerOrbit.semiMajorAxis) - Constants.EARTH_RADIUS_KM;
      this._updateSweepPlanner(data.cachedTargets, pAltKm);
    }

    // Route planner (D3): recalculate when stale or player moved significantly
    if (data.cachedTargets && data.playerOrbit) {
      const curSMA = data.playerOrbit.semiMajorAxis;
      if (this._routeStale || Math.abs(curSMA - this._lastPlayerSMA) > 0.05) {
        this.updateRoutePlan(data.cachedTargets, data.playerOrbit);
        this._lastPlayerSMA = curSMA;
        this._routeStale = false;
      }
    }

    if (this._playerOrbit) {
      this._render();
    }
  }

  /** Remove canvas from DOM and clean up. */
  dispose() {
    if (this._canvas && this._canvas.parentNode) {
      this._canvas.parentNode.removeChild(this._canvas);
    }
    this._ctx = null;
    this._canvas = null;
  }

  // ===========================================================================
  // Master render
  // ===========================================================================

  /** @private */
  _render() {
    const ctx = this._ctx;
    const p = this._playerOrbit;
    const t = this._targetOrbit;

    this._computeScale();

    ctx.clearRect(0, 0, this._size, this._size);

    this._drawBackground();
    this._drawGrid();
    this._drawEarth();

    // Player orbit (always)
    this._drawOrbit(p, '#00ff88', 1.5);

    // Target orbit (if selected)
    if (t) {
      this._drawOrbit(t, '#00ccff', 1.5);
      this._drawTransferArc(p, t);
    }

    // Position markers
    this._drawPosition(p, '#00ff88', 'triangle');
    if (t) {
      this._drawPosition(t, '#00ccff', 'diamond');
    }

    // --- R7: Educational orbital mechanics labels ---
    this._drawApPeLabels(p);
    this._drawProgradeArrow(p);
    if (t) {
      this._drawTransferLabels(p, t);
      this._drawInclinationLabel(p, t);
    }

    // Altitude sweep density bands (D2)
    this._drawSweepPlanner();

    // Route plan overlay (D3 / Phase 6)
    this._drawRoutePlan();

    this._drawHeader();
    this._drawReadouts();
  }

  // ===========================================================================
  // Scale computation
  // ===========================================================================

  /** @private Compute px-per-km so the largest orbit fits in ~76% of canvas width. */
  _computeScale() {
    const p = this._playerOrbit;
    const t = this._targetOrbit;

    const a1Km = sceneToKm(p.semiMajorAxis);
    const e1 = p.eccentricity;
    let maxR = a1Km * (1 + e1);

    if (t) {
      const a2Km = sceneToKm(t.semiMajorAxis);
      const e2 = t.eccentricity;
      const r2 = a2Km * (1 + e2);
      if (r2 > maxR) maxR = r2;
    }

    maxR *= 1.1; // 10 % margin
    this._pxPerKm = (this._size * 0.38) / maxR;

    // Minimum to prevent infinitely small orbits
    if (this._pxPerKm < 0.001) this._pxPerKm = 0.001;
  }

  // ===========================================================================
  // Coordinate conversion
  // ===========================================================================

  /**
   * Convert Keplerian orbit + true anomaly → 2D canvas point (polar top-down).
   * @private
   * @param {object} orbit
   * @param {number} trueAnomaly — radians
   * @returns {{ x: number, y: number }}
   */
  _orbitToScreen(orbit, trueAnomaly) {
    const aKm = sceneToKm(orbit.semiMajorAxis);
    const e = orbit.eccentricity;
    const raan = orbit.raan;
    const omega = orbit.argPerigee;

    // Radius at this true anomaly (vis-viva orbit equation)
    const p = aKm * (1 - e * e);
    const r = p / (1 + e * Math.cos(trueAnomaly));

    // Position in orbital plane (perifocal), rotated by argument of perigee
    const angle = trueAnomaly + omega;
    const xP = r * Math.cos(angle);
    const yP = r * Math.sin(angle);

    // Rotate by RAAN for top-down north-pole view
    const x = xP * Math.cos(raan) - yP * Math.sin(raan);
    const y = xP * Math.sin(raan) + yP * Math.cos(raan);

    return {
      x: this._centerX + x * this._pxPerKm,
      y: this._centerY - y * this._pxPerKm, // Y-flip for canvas
    };
  }

  // ===========================================================================
  // Drawing helpers
  // ===========================================================================

  /** @private Fill background, border, and corner accents. */
  _drawBackground() {
    const ctx = this._ctx;
    const s = this._size;

    // Background fill
    ctx.fillStyle = 'rgba(0, 10, 20, 0.88)';
    ctx.fillRect(0, 0, s, s);

    // Border
    ctx.strokeStyle = 'rgba(0, 255, 136, 0.4)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, s - 1, s - 1);

    // Corner accents (tiny L-shapes)
    const len = 12;
    ctx.strokeStyle = 'rgba(0, 255, 136, 0.6)';
    ctx.lineWidth = 1.5;

    // Top-left
    ctx.beginPath();
    ctx.moveTo(1, len);
    ctx.lineTo(1, 1);
    ctx.lineTo(len, 1);
    ctx.stroke();

    // Top-right
    ctx.beginPath();
    ctx.moveTo(s - len, 1);
    ctx.lineTo(s - 1, 1);
    ctx.lineTo(s - 1, len);
    ctx.stroke();

    // Bottom-left
    ctx.beginPath();
    ctx.moveTo(1, s - len);
    ctx.lineTo(1, s - 1);
    ctx.lineTo(len, s - 1);
    ctx.stroke();

    // Bottom-right
    ctx.beginPath();
    ctx.moveTo(s - len, s - 1);
    ctx.lineTo(s - 1, s - 1);
    ctx.lineTo(s - 1, s - len);
    ctx.stroke();
  }

  /** @private Draw "ORBIT VIEW" header. */
  _drawHeader() {
    const ctx = this._ctx;

    ctx.font = '11px "Courier New", monospace';
    ctx.textBaseline = 'top';

    // Title
    ctx.fillStyle = '#00ff88';
    ctx.textAlign = 'left';
    ctx.fillText('ORBIT VIEW', 8, 6);

    // Thin line below header
    ctx.strokeStyle = 'rgba(0, 255, 136, 0.25)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(4, 20);
    ctx.lineTo(this._size - 4, 20);
    ctx.stroke();
  }

  /** @private Draw central Earth disc. */
  _drawEarth() {
    const ctx = this._ctx;
    const rPx = Math.max(8, Constants.EARTH_RADIUS_KM * this._pxPerKm);

    ctx.beginPath();
    ctx.arc(this._centerX, this._centerY, rPx, 0, TWO_PI);
    ctx.fillStyle = '#1a3a5a';
    ctx.fill();
    ctx.strokeStyle = '#4488aa';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /** @private Draw concentric altitude-reference rings at 200 km intervals. */
  _drawGrid() {
    const ctx = this._ctx;
    const altitudes = [200, 400, 600, 800, 1000];

    ctx.strokeStyle = 'rgba(0, 80, 40, 0.25)';
    ctx.lineWidth = 0.5;

    for (let i = 0; i < altitudes.length; i++) {
      const alt = altitudes[i];
      const rPx = (Constants.EARTH_RADIUS_KM + alt) * this._pxPerKm;

      ctx.beginPath();
      ctx.arc(this._centerX, this._centerY, rPx, 0, TWO_PI);
      ctx.stroke();

      // Label every other ring (200, 600, 1000) at 12 o'clock
      if (i % 2 === 0) {
        ctx.fillStyle = 'rgba(0, 255, 136, 0.3)';
        ctx.font = '8px "Courier New", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`${alt}`, this._centerX, this._centerY - rPx - 1);
      }
    }
  }

  /**
   * Draw one orbit as a traced ellipse.
   * @private
   * @param {object} orbit
   * @param {string} color
   * @param {number} lineWidth
   */
  _drawOrbit(orbit, color, lineWidth) {
    const ctx = this._ctx;
    const segments = 64;

    ctx.beginPath();
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * TWO_PI;
      const pt = this._orbitToScreen(orbit, angle);
      if (i === 0) {
        ctx.moveTo(pt.x, pt.y);
      } else {
        ctx.lineTo(pt.x, pt.y);
      }
    }
    ctx.closePath();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }

  /**
   * Draw position marker on orbit.
   * @private
   * @param {object} orbit
   * @param {string} color
   * @param {'triangle'|'diamond'} shape
   */
  _drawPosition(orbit, color, shape) {
    const ctx = this._ctx;
    const pt = this._orbitToScreen(orbit, orbit.trueAnomaly);
    const r = 4; // marker half-size (~8px across)

    ctx.fillStyle = color;
    ctx.strokeStyle = this._darkenColor(color, 0.6);
    ctx.lineWidth = 1;

    if (shape === 'triangle') {
      // Compute orbit direction for triangle orientation
      const dt = 0.02;
      const ptAhead = this._orbitToScreen(orbit, orbit.trueAnomaly + dt);
      const dx = ptAhead.x - pt.x;
      const dy = ptAhead.y - pt.y;
      const heading = Math.atan2(dy, dx);

      // Equilateral triangle — tip points along heading (orbit velocity direction)
      ctx.beginPath();
      ctx.moveTo(
        pt.x + r * Math.cos(heading),
        pt.y + r * Math.sin(heading)
      );
      ctx.lineTo(
        pt.x + r * Math.cos(heading + TWO_PI / 3),
        pt.y + r * Math.sin(heading + TWO_PI / 3)
      );
      ctx.lineTo(
        pt.x + r * Math.cos(heading - TWO_PI / 3),
        pt.y + r * Math.sin(heading - TWO_PI / 3)
      );
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (shape === 'diamond') {
      ctx.beginPath();
      ctx.moveTo(pt.x, pt.y - r);     // top
      ctx.lineTo(pt.x + r, pt.y);     // right
      ctx.lineTo(pt.x, pt.y + r);     // bottom
      ctx.lineTo(pt.x - r, pt.y);     // left
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  /**
   * Draw Hohmann transfer arc (dashed half-ellipse).
   * @private
   * @param {object} playerOrbit
   * @param {object} targetOrbit
   */
  _drawTransferArc(playerOrbit, targetOrbit) {
    const ctx = this._ctx;
    const r1 = sceneToKm(playerOrbit.semiMajorAxis);
    const r2 = sceneToKm(targetOrbit.semiMajorAxis);
    const aT = (r1 + r2) / 2;
    const eT = Math.abs(r2 - r1) / (r2 + r1);

    // When raising orbit (r1 ≤ r2): periapsis at player, draw 0 → π
    // When lowering orbit (r1 > r2): periapsis opposite player, draw π → 2π
    const raising = r1 <= r2;
    const argOffset = raising ? 0 : Math.PI;
    const startAngle = raising ? 0 : Math.PI;
    const endAngle = raising ? Math.PI : TWO_PI;

    // Build a synthetic transfer orbit object (in scene units for _orbitToScreen)
    const transferOrbit = {
      semiMajorAxis: aT * Constants.SCENE_SCALE, // convert back to scene units
      eccentricity: eT,
      raan: playerOrbit.raan,
      argPerigee: playerOrbit.argPerigee + playerOrbit.trueAnomaly + argOffset,
      trueAnomaly: 0,
    };

    const segments = 32;

    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#ffaa00';
    ctx.lineWidth = 1;

    ctx.beginPath();
    for (let i = 0; i <= segments; i++) {
      const angle = startAngle + (i / segments) * (endAngle - startAngle);
      const pt = this._orbitToScreen(transferOrbit, angle);
      if (i === 0) {
        ctx.moveTo(pt.x, pt.y);
      } else {
        ctx.lineTo(pt.x, pt.y);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** @private Draw numerical readouts below the orbit view. */
  _drawReadouts() {
    const ctx = this._ctx;
    const p = this._playerOrbit;
    const t = this._targetOrbit;
    const y0 = 262; // Starting y for readouts
    const lineH = 16;

    // Slightly darker strip behind readouts
    ctx.fillStyle = 'rgba(0, 5, 10, 0.5)';
    ctx.fillRect(4, y0 - 4, this._size - 8, this._size - y0);

    // Thin separator
    ctx.strokeStyle = 'rgba(0, 255, 136, 0.2)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(8, y0 - 5);
    ctx.lineTo(this._size - 8, y0 - 5);
    ctx.stroke();

    ctx.font = '10px "Courier New", monospace';
    ctx.textBaseline = 'top';

    const pAltKm = sceneToKm(p.semiMajorAxis) - Constants.EARTH_RADIUS_KM;

    // --- Line 1: ALT + TGT ---
    ctx.textAlign = 'left';
    ctx.fillStyle = '#666666';
    ctx.fillText('ALT', 10, y0);
    ctx.fillStyle = '#00ff88';
    ctx.fillText(`${Math.round(pAltKm)} km`, 38, y0);

    ctx.fillStyle = '#666666';
    ctx.fillText('TGT', 140, y0);
    if (t) {
      const tAltKm = sceneToKm(t.semiMajorAxis) - Constants.EARTH_RADIUS_KM;
      ctx.fillStyle = '#00ccff';
      ctx.fillText(`${Math.round(tAltKm)} km`, 168, y0);
    } else {
      ctx.fillStyle = '#444444';
      ctx.fillText('---', 168, y0);
    }

    // --- Line 2: ΔV + Δi ---
    const y1 = y0 + lineH;
    ctx.fillStyle = '#666666';
    ctx.fillText('\u0394V', 10, y1);

    if (t) {
      const pKm = this._orbitToKm(p);
      const tKm = this._orbitToKm(t);
      const dv = totalDeltaV(pKm, tKm);
      ctx.fillStyle = '#ffaa00';
      ctx.fillText(`${dv.toFixed(2)} km/s`, 38, y1);

      const deltaI = Math.abs(t.inclination - p.inclination) * DEG;
      ctx.fillStyle = '#666666';
      ctx.fillText('\u0394i', 160, y1);
      ctx.fillStyle = '#ffaa00';
      ctx.fillText(`${deltaI.toFixed(1)}\u00B0`, 180, y1);
    } else {
      ctx.fillStyle = '#444444';
      ctx.fillText('---', 38, y1);
      ctx.fillStyle = '#666666';
      ctx.fillText('\u0394i', 160, y1);
      ctx.fillStyle = '#444444';
      ctx.fillText('---', 180, y1);
    }

    // --- Line 3: XFER + ΔAlt ---
    const y2 = y0 + lineH * 2;
    ctx.fillStyle = '#666666';
    ctx.fillText('XFER', 10, y2);

    if (t) {
      const r1 = sceneToKm(p.semiMajorAxis);
      const r2 = sceneToKm(t.semiMajorAxis);
      const hoh = hohmannDeltaV(r1, r2);
      ctx.fillStyle = '#ffaa00';
      ctx.fillText(this._formatTime(hoh.transferTime), 46, y2);

      const deltaAlt = Math.abs(
        (sceneToKm(t.semiMajorAxis) - Constants.EARTH_RADIUS_KM) -
        (sceneToKm(p.semiMajorAxis) - Constants.EARTH_RADIUS_KM)
      );
      ctx.fillStyle = '#666666';
      ctx.fillText('\u0394Alt', 155, y2);
      ctx.fillStyle = '#00ccff';
      ctx.fillText(`${Math.round(deltaAlt)} km`, 188, y2);
    } else {
      ctx.fillStyle = '#444444';
      ctx.fillText('---', 46, y2);
      ctx.fillStyle = '#666666';
      ctx.fillText('\u0394Alt', 155, y2);
      ctx.fillStyle = '#444444';
      ctx.fillText('---', 188, y2);
    }
  }

  // ===========================================================================
  // Route Planner (Phase 6)
  // ===========================================================================

  /**
   * Compute a ΔV-optimal visit order using nearest-neighbor heuristic.
   * (True TSP is NP-hard; greedy nearest-neighbor is good enough for 6 waypoints.)
   * Computes ΔV between orbits using totalDeltaV from OrbitalMechanics.
   * @param {Array} targets — cached target objects with orbit data (scene units)
   * @param {object} playerOrbit — player's current orbital elements (scene units)
   */
  updateRoutePlan(targets, playerOrbit) {
    if (!targets || targets.length === 0) {
      this._routePlan = [];
      this._routeTotalDV = 0;
      this._showRoute = false;
      return;
    }

    // Filter to targets with orbit data & limit to MAX_WAYPOINTS
    const maxWP = (Constants.ROUTE_PLANNER && Constants.ROUTE_PLANNER.MAX_WAYPOINTS) || 6;
    const candidates = targets
      .filter(t => t.orbit && t.orbit.semiMajorAxis)
      .slice(0, maxWP * 2); // take more than needed for selection

    if (candidates.length === 0) {
      this._routePlan = [];
      this._routeTotalDV = 0;
      this._showRoute = false;
      return;
    }

    // Convert player orbit to km for ΔV computation
    const playerKm = this._orbitToKm(playerOrbit);

    // Nearest-neighbor greedy from player's current orbit
    const visited = [];
    const remaining = [...candidates];
    let currentOrbitKm = playerKm;
    let totalDV = 0;

    while (visited.length < maxWP && remaining.length > 0) {
      // Find nearest by ΔV from current orbit
      let bestIdx = 0;
      let bestDV = Infinity;

      for (let i = 0; i < remaining.length; i++) {
        const targetKm = this._orbitToKm(remaining[i].orbit);
        const dv = totalDeltaV(currentOrbitKm, targetKm);
        if (dv < bestDV) {
          bestDV = dv;
          bestIdx = i;
        }
      }

      const chosen = remaining.splice(bestIdx, 1)[0];
      totalDV += bestDV;

      visited.push({
        target: chosen,
        orbit: chosen.orbit,
        dvToReach: bestDV,
        cumulativeDV: totalDV,
      });

      // Next leg starts from the chosen target's orbit
      currentOrbitKm = this._orbitToKm(chosen.orbit);
    }

    this._routePlan = visited;
    this._routeTotalDV = totalDV;
    this._showRoute = visited.length >= 1;
  }

  /**
   * Draw route plan overlay — numbered waypoints with ΔV cost legs.
   * @private
   */
  _drawRoutePlan() {
    if (!this._showRoute || this._routePlan.length < 1) return;

    const ctx = this._ctx;
    ctx.save();

    // Player-to-first-waypoint leg (D3)
    if (this._playerOrbit && this._routePlan.length > 0) {
      const wp0 = this._routePlan[0];
      if (wp0.orbit) {
        const pPos = this._orbitToScreen(this._playerOrbit, this._playerOrbit.trueAnomaly);
        const w0Pos = this._orbitToScreen(wp0.orbit, wp0.orbit.trueAnomaly || 0);
        const dvMs0 = wp0.dvToReach * 1000;
        const lc = dvMs0 < 20 ? 'rgba(0,255,100,0.6)'
          : dvMs0 < 50 ? 'rgba(255,200,0,0.6)' : 'rgba(255,60,60,0.6)';
        ctx.beginPath();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = lc;
        ctx.lineWidth = 1.5;
        ctx.moveTo(pPos.x, pPos.y);
        ctx.lineTo(w0Pos.x, w0Pos.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Draw route legs as dashed lines connecting target positions
    for (let i = 0; i < this._routePlan.length; i++) {
      const wp = this._routePlan[i];
      if (!wp.orbit) continue;

      // Draw waypoint position on orbit
      const pos = this._orbitToScreen(wp.orbit, wp.orbit.trueAnomaly || 0);
      if (!pos) continue;

      // Waypoint circle
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 6, 0, Math.PI * 2);
      ctx.strokeStyle = '#ff9800';
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.stroke();

      // Waypoint number
      ctx.fillStyle = '#ff9800';
      ctx.font = 'bold 9px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${i + 1}`, pos.x, pos.y);

      // ΔV cost label
      const dvThreshold = (Constants.ROUTE_PLANNER && Constants.ROUTE_PLANNER.DISPLAY_DV_THRESHOLD) || 0.01;
      const dvText = wp.dvToReach >= dvThreshold
        ? `${(wp.dvToReach * 1000).toFixed(0)}m/s`
        : '<10m/s';
      ctx.font = '8px monospace';
      ctx.fillStyle = '#ffcc80';
      ctx.textBaseline = 'bottom';
      ctx.fillText(dvText, pos.x, pos.y - 10);

      // Draw connecting leg to next waypoint — color-coded by ΔV (D3)
      if (i < this._routePlan.length - 1) {
        const nextWp = this._routePlan[i + 1];
        if (!nextWp.orbit) continue;
        const nextPos = this._orbitToScreen(nextWp.orbit, nextWp.orbit.trueAnomaly || 0);
        if (nextPos) {
          // Color code: green (<20 m/s), yellow (20-50 m/s), red (>50 m/s)
          const legDvMs = nextWp.dvToReach * 1000;
          let legColor;
          if (legDvMs < 20) {
            legColor = 'rgba(0, 255, 100, 0.6)';
          } else if (legDvMs < 50) {
            legColor = 'rgba(255, 200, 0, 0.6)';
          } else {
            legColor = 'rgba(255, 60, 60, 0.6)';
          }
          ctx.beginPath();
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = legColor;
          ctx.lineWidth = 1.5;
          ctx.moveTo(pos.x, pos.y);
          ctx.lineTo(nextPos.x, nextPos.y);
          ctx.stroke();
        }
      }
    }

    // Total ΔV summary at bottom of MFD
    ctx.setLineDash([]);
    ctx.fillStyle = '#ff9800';
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const nWp = this._routePlan.length;
    ctx.fillText(
      `ROUTE: ${nWp} target${nWp !== 1 ? 's' : ''}, \u0394V ${(this._routeTotalDV * 1000).toFixed(0)} m/s`,
      10, this._size - 10
    );

    ctx.restore();
  }

  // ===========================================================================
  // Altitude Sweep Planner (D2)
  // ===========================================================================

  /**
   * Compute debris-density altitude bands and identify the best sweep target.
   * Called from update() at ~5 Hz; short-circuits when nothing has changed.
   * @private
   * @param {Array} debrisList — cached target objects with orbit data
   * @param {number} playerAltKm — player altitude above Earth surface (km)
   */
  _updateSweepPlanner(debrisList, playerAltKm) {
    const candidates = debrisList.filter(t => t.orbit && t.orbit.semiMajorAxis);
    const count = candidates.length;

    // Short-circuit if nothing meaningful changed
    if (!this._sweepStale &&
        count === this._lastDebrisCount &&
        Math.abs(playerAltKm - this._lastSweepAlt) < 10) {
      return;
    }
    this._sweepStale = false;
    this._lastDebrisCount = count;
    this._lastSweepAlt = playerAltKm;

    const BAND_W = 50;    // km per band
    const ALT_MIN = 200;  // km — lower LEO bound
    const ALT_MAX = 800;  // km — upper sweep bound
    const nBands = Math.ceil((ALT_MAX - ALT_MIN) / BAND_W);

    // Build empty bands
    const bands = [];
    for (let i = 0; i < nBands; i++) {
      bands.push({
        altMin: ALT_MIN + i * BAND_W,
        altMax: ALT_MIN + (i + 1) * BAND_W,
        midAlt: ALT_MIN + (i + 0.5) * BAND_W,
        count: 0,
        density: 0,
      });
    }

    // Tally debris into altitude bands
    let maxCount = 0;
    for (const t of candidates) {
      const alt = sceneToKm(t.orbit.semiMajorAxis) - Constants.EARTH_RADIUS_KM;
      const idx = Math.floor((alt - ALT_MIN) / BAND_W);
      if (idx >= 0 && idx < nBands) {
        bands[idx].count++;
        if (bands[idx].count > maxCount) maxCount = bands[idx].count;
      }
    }

    // Normalise density to 0..1
    for (const b of bands) {
      b.density = maxCount > 0 ? b.count / maxCount : 0;
    }
    this._sweepBands = bands;

    // Pick densest band (discount the band player is already inside)
    let bestIdx = -1;
    let bestScore = -1;
    for (let i = 0; i < nBands; i++) {
      if (bands[i].count === 0) continue;
      const inBand = playerAltKm >= bands[i].altMin && playerAltKm < bands[i].altMax;
      const score = inBand ? bands[i].count * 0.5 : bands[i].count;
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }

    if (bestIdx >= 0) {
      const tgtAlt = bands[bestIdx].midAlt;
      const r1 = Constants.EARTH_RADIUS_KM + playerAltKm;
      const r2 = Constants.EARTH_RADIUS_KM + tgtAlt;
      const hoh = hohmannDeltaV(r1, r2);
      // Only mark route stale when sweep target band actually changes
      const changed = !this._sweepTarget || this._sweepTarget.bandIdx !== bestIdx;
      this._sweepTarget = { alt: tgtAlt, dv: hoh.total, bandIdx: bestIdx };
      if (changed) this._routeStale = true;
    } else {
      if (this._sweepTarget) this._routeStale = true; // had target, now gone
      this._sweepTarget = null;
    }
  }

  /**
   * Render debris-density bar chart on MFD right edge and sweep-arc overlay.
   * Green (sparse) → yellow (moderate) → red (dense — good hunting).
   * @private
   */
  _drawSweepPlanner() {
    if (this._sweepBands.length === 0 || !this._playerOrbit) return;

    const ctx = this._ctx;
    ctx.save();

    // --- Density bar chart on right edge ---
    const barX = this._size - 20;
    const barW = 10;
    const barH = 150;
    const barY0 = 28;
    const bandH = barH / this._sweepBands.length;

    // Background strip
    ctx.fillStyle = 'rgba(0, 10, 20, 0.6)';
    ctx.fillRect(barX - 2, barY0 - 2, barW + 4, barH + 4);

    for (let i = 0; i < this._sweepBands.length; i++) {
      const band = this._sweepBands[i];
      // Bottom of chart = lowest altitude band
      const y = barY0 + (this._sweepBands.length - 1 - i) * bandH;
      const d = band.density;

      // Green → yellow → red colour ramp
      let cr, cg, cb;
      if (d < 0.33) {
        cr = 0; cg = 160 + Math.round(d * 280); cb = Math.round(100 * (1 - d * 3));
      } else if (d < 0.66) {
        const t = (d - 0.33) / 0.33;
        cr = Math.round(255 * t); cg = Math.round(200 - 50 * t); cb = 0;
      } else {
        const t = (d - 0.66) / 0.34;
        cr = 255; cg = Math.round(100 * (1 - t)); cb = 0;
      }

      const w = Math.max(1, barW * d);
      ctx.fillStyle = `rgba(${cr},${cg},${cb},${d < 0.05 ? 0.2 : 0.75})`;
      ctx.fillRect(barX + (barW - w) / 2, y + 1, w, bandH - 2);

      // Highlight sweep-target band with white border
      if (this._sweepTarget && i === this._sweepTarget.bandIdx) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.strokeRect(barX - 1, y, barW + 2, bandH);
      }
    }

    // Altitude range labels
    ctx.font = '7px "Courier New", monospace';
    ctx.fillStyle = 'rgba(0, 255, 136, 0.4)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText('800', barX - 3, barY0);
    ctx.textBaseline = 'bottom';
    ctx.fillText('200', barX - 3, barY0 + barH);

    // Column title
    ctx.fillStyle = 'rgba(0, 255, 136, 0.5)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('DEN', barX + barW / 2, barY0 - 3);

    // --- Sweep arc from player altitude to target band ---
    if (this._sweepTarget) {
      const pAlt = sceneToKm(this._playerOrbit.semiMajorAxis) - Constants.EARTH_RADIUS_KM;
      const tAlt = this._sweepTarget.alt;

      const r1Px = (Constants.EARTH_RADIUS_KM + pAlt) * this._pxPerKm;
      const r2Px = (Constants.EARTH_RADIUS_KM + tAlt) * this._pxPerKm;

      // Spiral arc across a 90° sector (right side of display)
      const aStart = -Math.PI * 0.25;
      const aEnd = Math.PI * 0.25;
      const segs = 24;

      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(255, 200, 0, 0.45)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let s = 0; s <= segs; s++) {
        const t = s / segs;
        const a = aStart + t * (aEnd - aStart);
        const rad = r1Px + t * (r2Px - r1Px);
        const sx = this._centerX + rad * Math.cos(a);
        const sy = this._centerY - rad * Math.sin(a);
        if (s === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // ΔV label at arc midpoint
      const mA = (aStart + aEnd) / 2;
      const mR = (r1Px + r2Px) / 2;
      const lx = this._centerX + mR * Math.cos(mA) + 5;
      const ly = this._centerY - mR * Math.sin(mA);
      const dvMs = Math.round(this._sweepTarget.dv * 1000);

      ctx.font = '9px "Courier New", monospace';
      ctx.fillStyle = '#ffcc00';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`\u0394V: ${dvMs} m/s`, lx, ly);

      // Target altitude label below ΔV
      ctx.font = '8px "Courier New", monospace';
      ctx.fillStyle = 'rgba(255, 200, 0, 0.7)';
      ctx.fillText(`\u2192 ${Math.round(tAlt)}km`, lx, ly + 11);
    }

    ctx.restore();
  }

  // ===========================================================================
  // R7: Educational orbital mechanics labels
  // ===========================================================================

  /**
   * Draw Apoapsis/Periapsis labels (eccentric orbit) or Circular label.
   * @private
   * @param {object} orbit — player orbital elements
   */
  _drawApPeLabels(orbit) {
    const ctx = this._ctx;
    const e = orbit.eccentricity;

    ctx.save();
    ctx.font = '9px "Courier New", monospace';
    ctx.textBaseline = 'middle';

    if (e > 0.01) {
      // --- Eccentric orbit: show Ap and Pe ---
      const aKm = sceneToKm(orbit.semiMajorAxis);
      const apRadKm = aKm * (1 + e);
      const peRadKm = aKm * (1 - e);
      const apAltKm = Math.round(apRadKm - Constants.EARTH_RADIUS_KM);
      const peAltKm = Math.round(peRadKm - Constants.EARTH_RADIUS_KM);

      // Apoapsis at true anomaly = π, periapsis at true anomaly = 0
      const apPt = this._orbitToScreen(orbit, Math.PI);
      const pePt = this._orbitToScreen(orbit, 0);

      ctx.fillStyle = 'rgba(68, 136, 255, 0.8)'; // #4488ff

      // Ap label — offset radially outward from Earth center
      const apDx = apPt.x - this._centerX;
      const apDy = apPt.y - this._centerY;
      const apDist = Math.sqrt(apDx * apDx + apDy * apDy) || 1;
      const apOffX = (apDx / apDist) * 12;
      const apOffY = (apDy / apDist) * 12;
      ctx.textAlign = apDx >= 0 ? 'left' : 'right';
      ctx.fillText(`Ap: ${apAltKm}km`, apPt.x + apOffX, apPt.y + apOffY);

      // Pe label — offset radially outward
      const peDx = pePt.x - this._centerX;
      const peDy = pePt.y - this._centerY;
      const peDist = Math.sqrt(peDx * peDx + peDy * peDy) || 1;
      const peOffX = (peDx / peDist) * 12;
      const peOffY = (peDy / peDist) * 12;
      ctx.textAlign = peDx >= 0 ? 'left' : 'right';
      ctx.fillText(`Pe: ${peAltKm}km`, pePt.x + peOffX, pePt.y + peOffY);

    } else {
      // --- Nearly circular orbit: single label near player ---
      const aKm = sceneToKm(orbit.semiMajorAxis);
      const altKm = Math.round(aKm - Constants.EARTH_RADIUS_KM);
      const pt = this._orbitToScreen(orbit, orbit.trueAnomaly);

      ctx.fillStyle = 'rgba(0, 255, 136, 0.75)'; // #00ff88
      ctx.textAlign = 'left';
      ctx.fillText(`Circular: ~${altKm}km`, pt.x + 10, pt.y - 10);
    }

    ctx.restore();
  }

  /**
   * Draw a small prograde-direction arrow on the player position marker.
   * @private
   * @param {object} orbit — player orbital elements
   */
  _drawProgradeArrow(orbit) {
    const ctx = this._ctx;
    const pt = this._orbitToScreen(orbit, orbit.trueAnomaly);

    // Compute prograde heading (tangent to orbit)
    const dt = 0.02;
    const ptAhead = this._orbitToScreen(orbit, orbit.trueAnomaly + dt);
    const dx = ptAhead.x - pt.x;
    const dy = ptAhead.y - pt.y;
    const heading = Math.atan2(dy, dx);

    // Arrow: 6px triangle, offset 7px past the position marker
    const offset = 7;
    const arrowLen = 6;
    const arrowHW = 2.5; // half-width
    const baseX = pt.x + offset * Math.cos(heading);
    const baseY = pt.y + offset * Math.sin(heading);
    const tipX = baseX + arrowLen * Math.cos(heading);
    const tipY = baseY + arrowLen * Math.sin(heading);

    ctx.save();
    ctx.fillStyle = 'rgba(0, 255, 136, 0.8)';
    ctx.strokeStyle = 'rgba(0, 200, 100, 0.6)';
    ctx.lineWidth = 0.5;

    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(
      baseX + arrowHW * Math.cos(heading + Math.PI / 2),
      baseY + arrowHW * Math.sin(heading + Math.PI / 2)
    );
    ctx.lineTo(
      baseX + arrowHW * Math.cos(heading - Math.PI / 2),
      baseY + arrowHW * Math.sin(heading - Math.PI / 2)
    );
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Draw Hohmann transfer ΔV₁ / ΔV₂ labels and "Hohmann transfer" arc label.
   * @private
   * @param {object} playerOrbit
   * @param {object} targetOrbit
   */
  _drawTransferLabels(playerOrbit, targetOrbit) {
    const ctx = this._ctx;
    const r1 = sceneToKm(playerOrbit.semiMajorAxis);
    const r2 = sceneToKm(targetOrbit.semiMajorAxis);

    const hoh = hohmannDeltaV(r1, r2);

    // Departure point — player's current position on orbit
    const depPt = this._orbitToScreen(playerOrbit, playerOrbit.trueAnomaly);

    // Build the same synthetic transfer orbit as _drawTransferArc
    const aT = (r1 + r2) / 2;
    const eT = Math.abs(r2 - r1) / (r2 + r1);
    const raising = r1 <= r2;
    const argOffset = raising ? 0 : Math.PI;
    const endAngle = raising ? Math.PI : TWO_PI;
    const midAngle = raising ? Math.PI / 2 : Math.PI * 1.5;

    const transferOrbit = {
      semiMajorAxis: aT * Constants.SCENE_SCALE,
      eccentricity: eT,
      raan: playerOrbit.raan,
      argPerigee: playerOrbit.argPerigee + playerOrbit.trueAnomaly + argOffset,
      trueAnomaly: 0,
    };

    // Arrival burn point (end of transfer arc)
    const arrPt = this._orbitToScreen(transferOrbit, endAngle);
    // Midpoint of arc for "Hohmann transfer" label
    const midPt = this._orbitToScreen(transferOrbit, midAngle);

    ctx.save();
    ctx.font = '9px "Courier New", monospace';
    ctx.textBaseline = 'bottom';

    // ΔV₁ at departure
    const dv1Ms = (hoh.dv1 * 1000).toFixed(0);
    ctx.fillStyle = 'rgba(255, 170, 0, 0.8)'; // #ffaa00
    ctx.textAlign = 'left';
    ctx.fillText(`\u0394V\u2081: +${dv1Ms} m/s`, depPt.x + 8, depPt.y - 6);

    // ΔV₂ at arrival
    const dv2Ms = (hoh.dv2 * 1000).toFixed(0);
    ctx.textAlign = 'right';
    ctx.fillText(`\u0394V\u2082: -${dv2Ms} m/s`, arrPt.x - 8, arrPt.y - 6);

    // "Hohmann transfer" arc label — dim white
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.font = '8px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Hohmann transfer', midPt.x, midPt.y);

    ctx.restore();
  }

  /**
   * Draw inclination difference label near target orbit when Δi > 0.5°.
   * @private
   * @param {object} playerOrbit
   * @param {object} targetOrbit
   */
  _drawInclinationLabel(playerOrbit, targetOrbit) {
    const deltaI = Math.abs(targetOrbit.inclination - playerOrbit.inclination) * DEG;
    if (deltaI <= 0.5) return;

    const ctx = this._ctx;

    // Position near target orbit at ~45° true anomaly for visibility
    const pt = this._orbitToScreen(targetOrbit, Math.PI / 4);

    ctx.save();
    ctx.font = '9px "Courier New", monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';

    // Amber for > 2° difference, blue for ≤ 2°
    ctx.fillStyle = deltaI > 2
      ? 'rgba(255, 170, 0, 0.8)'   // #ffaa00 — amber
      : 'rgba(68, 136, 255, 0.8)'; // #4488ff — blue
    ctx.fillText(`Inc: ${deltaI.toFixed(1)}\u00B0 diff`, pt.x + 6, pt.y + 6);

    ctx.restore();
  }

  // ===========================================================================
  // Utility helpers
  // ===========================================================================

  /**
   * Create a copy of orbit elements with semiMajorAxis converted to km
   * (for use with totalDeltaV / hohmannDeltaV which expect km).
   * @private
   * @param {object} orbit — orbit in scene units
   * @returns {object} orbit copy with semiMajorAxis in km
   */
  _orbitToKm(orbit) {
    return {
      semiMajorAxis: sceneToKm(orbit.semiMajorAxis),
      eccentricity: orbit.eccentricity,
      inclination: orbit.inclination,
      raan: orbit.raan,
      argPerigee: orbit.argPerigee,
      trueAnomaly: orbit.trueAnomaly,
      meanMotion: orbit.meanMotion,
    };
  }

  /**
   * Format seconds into "Xm Ys" string.
   * @private
   * @param {number} seconds
   * @returns {string}
   */
  _formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '--m --s';
    const totalSec = Math.round(Math.abs(seconds));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    if (m > 999) return '>999m';
    return `${m}m ${s < 10 ? '0' : ''}${s}s`;
  }

  /**
   * Darken a hex color.
   * @private
   * @param {string} hex — e.g. '#00ff88'
   * @param {number} factor — 0..1 (1 = no change)
   * @returns {string} hex color
   */
  _darkenColor(hex, factor) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const dr = Math.round(r * factor);
    const dg = Math.round(g * factor);
    const db = Math.round(b * factor);
    return `rgb(${dr},${dg},${db})`;
  }
}
