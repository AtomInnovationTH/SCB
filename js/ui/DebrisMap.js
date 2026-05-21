/**
 * DebrisMap.js — Full-Screen Debris Map (Strategic Orbital Survey)
 * Canvas2D modal that polls DebrisField.getDebrisClusters() every 5 seconds,
 * ranks the top 5 clusters by a composite score incorporating mass, variety,
 * ΔV cost, and conjunction risk, and lets the player engage autopilot toward
 * a selected cluster via Shift+A.
 *
 * Full-screen strategic overlay toggled via Backquote key. Hidden by default.
 * @module ui/DebrisMap
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { GameStates } from '../core/GameState.js';
import { totalDeltaV } from '../entities/OrbitalMechanics.js';

const DM = Constants.DEBRIS_MAP;

// Altitude band definitions for the orbital schematic (km)
const ALT_BANDS = [
  { min: 200, max: 400, label: '200–400' },
  { min: 400, max: 600, label: '400–600' },
  { min: 700, max: 900, label: '700–900' },
  { min: 900, max: 1200, label: '900–1200' },
  { min: 1200, max: 2000, label: '1200–2000' },
];

export class DebrisMap {
  constructor() {
    // --- Responsive canvas sizing ---
    this._W = Math.min(800, window.innerWidth - 80);
    this._H = Math.min(600, window.innerHeight - 80);

    // --- Canvas setup (DPR-aware) ---
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;

    this._canvas = document.createElement('canvas');
    this._canvas.width = this._W * dpr;
    this._canvas.height = this._H * dpr;
    Object.assign(this._canvas.style, {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      width: this._W + 'px',
      height: this._H + 'px',
      zIndex: '2000',
      pointerEvents: 'auto',
      display: 'none',
      borderRadius: '8px',
      border: '2px solid rgba(255, 170, 0, 0.6)',
      boxShadow: '0 0 40px rgba(0, 0, 0, 0.8), 0 0 15px rgba(255, 170, 0, 0.2)',
      imageRendering: 'auto',
    });
    document.body.appendChild(this._canvas);
    this._ctx = this._canvas.getContext('2d');
    this._ctx.scale(dpr, dpr);
    this._ctx.imageSmoothingEnabled = true;

    // --- Backdrop (semi-transparent click-to-close) ---
    this._backdrop = document.createElement('div');
    Object.assign(this._backdrop.style, {
      position: 'fixed',
      top: '0', left: '0', right: '0', bottom: '0',
      background: 'rgba(0, 0, 0, 0.6)',
      zIndex: '1999',
      display: 'none',
      pointerEvents: 'auto',
    });
    this._backdrop.addEventListener('click', () => this.hide());
    document.body.appendChild(this._backdrop);

    // --- State ---
    this._visible = false;
    this._clusters = [];
    this._rankedClusters = [];   // top N scored
    this._selectedIndex = 0;     // highlighted cluster
    this._pollTimer = 0;
    this._debrisField = null;
    this._player = null;
    this._autopilotSystem = null;

    // Conjunction risk map: altitude band → alert count
    this._conjunctionAlerts = new Map();

    // --- EventBus subscriptions ---
    // NO auto-show on ORBITAL_VIEW — this is a strategic modal, toggled by player
    eventBus.on(Events.GAME_STATE_CHANGE, ({ to }) => {
      const gameplay = [
        GameStates.ORBITAL_VIEW,
        GameStates.APPROACH,
        GameStates.INTERACTION,
      ].includes(to);
      if (!gameplay) this.hide();
    });
    eventBus.on(Events.GAME_RESET, () => this.hide());

    // Accumulate conjunction alerts for risk scoring
    eventBus.on(Events.CONJUNCTION_WARNING, (data) => {
      if (data && data.distance != null) {
        // Bucket by 100 km altitude bands
        const altBand = Math.round((data.distance || 0) / 100) * 100;
        const prev = this._conjunctionAlerts.get(altBand) || 0;
        this._conjunctionAlerts.set(altBand, prev + 1);
      }
    });
    eventBus.on(Events.CONJUNCTION_CLEAR, () => {
      this._conjunctionAlerts.clear();
    });
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /** Toggle map visibility. */
  toggle() {
    if (this._visible) {
      this.hide();
    } else {
      this.show();
    }
  }

  /** Show the debris map. */
  show() {
    this._visible = true;
    this._canvas.style.display = 'block';
    this._backdrop.style.display = 'block';
    this._refreshClusters();  // immediate poll on open
  }

  /** Hide the debris map. */
  hide() {
    this._visible = false;
    this._canvas.style.display = 'none';
    this._backdrop.style.display = 'none';
  }

  /** @returns {boolean} Whether the map is currently visible. */
  isVisible() { return this._visible; }

  /** Select next cluster in the ranked list. */
  selectNext() {
    if (this._rankedClusters.length === 0) return;
    this._selectedIndex = Math.min(this._selectedIndex + 1, this._rankedClusters.length - 1);
    this._emitSelection();
  }

  /** Select previous cluster in the ranked list. */
  selectPrev() {
    if (this._rankedClusters.length === 0) return;
    this._selectedIndex = Math.max(this._selectedIndex - 1, 0);
    this._emitSelection();
  }

  /** @returns {object|null} Currently highlighted cluster (with scoring metadata). */
  getSelectedCluster() {
    return this._rankedClusters[this._selectedIndex] ?? null;
  }

  /** Engage autopilot toward the currently selected cluster. */
  engageSelectedCluster() {
    const cluster = this.getSelectedCluster();
    if (!cluster || !this._autopilotSystem) return;
    this._autopilotSystem.engageCluster(cluster);
  }

  /**
   * Called every frame from the main game loop.
   * @param {number} dt — frame delta in seconds
   * @param {object} deps — { debrisField, player, autopilotSystem }
   */
  update(dt, deps) {
    if (!this._visible) return;

    this._debrisField = deps.debrisField;
    this._player = deps.player;
    this._autopilotSystem = deps.autopilotSystem;

    // Poll clusters at configured interval
    this._pollTimer += dt;
    if (this._pollTimer >= DM.POLL_INTERVAL_S) {
      this._pollTimer = 0;
      this._refreshClusters();
    }

    this._draw();
  }

  // ===========================================================================
  // Scoring (static for testability)
  // ===========================================================================

  /**
   * Score a single cluster relative to the player's orbit and conjunction state.
   * Pure function — no side effects, fully testable.
   *
   * @param {object} cluster — cluster from DebrisField.getDebrisClusters()
   * @param {object} playerOrbitKm — player orbital elements with semiMajorAxis in km
   * @param {Map} conjAlerts — altitude band → alert count
   * @returns {object} cluster augmented with { dvMs, varietyBonus, conjRisk, reachable, score }
   */
  static scoreCluster(cluster, playerOrbitKm, conjAlerts) {
    // Build a synthetic orbit for the cluster center (circular, at mean altitude)
    const clusterOrbit = {
      semiMajorAxis: Constants.EARTH_RADIUS_KM + cluster.avgAltKm,
      inclination: cluster.incCenter * Math.PI / 180,
      eccentricity: 0.001,
      argumentOfPeriapsis: 0,
      raan: 0,
    };

    // totalDeltaV returns km/s; convert to m/s
    const dvKms = totalDeltaV(playerOrbitKm, clusterOrbit);
    const dvMs = dvKms * 1000;

    // Variety bonus: count of distinct debris type categories present
    const varietyBonus = Object.keys(cluster.types).filter(k => cluster.types[k] > 0).length;

    // Conjunction risk: untracked targets + active alerts in altitude band
    const untrackedCount = cluster.targets.filter(t => !t.tracked).length;
    const alertCount = DebrisMap._getAlertsInBand(cluster.altRange, conjAlerts);
    const conjRisk = untrackedCount * 0.5 + alertCount;

    // Reachability gate
    const reachable = dvMs < DM.MAX_DV_MS;

    // Score = (totalMassKg × varietyBonus × reachable) / (ΔV_ms + conjRisk×100 + ε)
    const score = reachable
      ? (cluster.totalMassKg * varietyBonus) / (dvMs + conjRisk * 100 + 1)
      : 0;

    return {
      ...cluster,
      dvMs,
      varietyBonus,
      conjRisk,
      reachable,
      score,
    };
  }

  /**
   * Count conjunction alerts overlapping an altitude range.
   * @param {{ min: number, max: number }} altRange — km
   * @param {Map} conjAlerts — altBand → count
   * @returns {number}
   */
  static _getAlertsInBand(altRange, conjAlerts) {
    let count = 0;
    for (const [band, n] of conjAlerts) {
      if (band >= altRange.min && band <= altRange.max) count += n;
    }
    return count;
  }

  // ===========================================================================
  // Internal — cluster refresh
  // ===========================================================================

  /** Re-poll clusters from DebrisField and rank them. */
  _refreshClusters() {
    if (!this._debrisField || !this._player) return;

    this._clusters = this._debrisField.getDebrisClusters();

    // Build player orbit in km for totalDeltaV
    const playerOrbit = this._player.orbit || this._player.getOrbitalElements?.() || {};
    const playerOrbitKm = {
      ...playerOrbit,
      semiMajorAxis: playerOrbit.semiMajorAxis / Constants.SCENE_SCALE,
    };

    this._rankedClusters = this._clusters
      .filter(c => c.count > 0)
      .map(c => DebrisMap.scoreCluster(c, playerOrbitKm, this._conjunctionAlerts))
      .filter(c => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, DM.MAX_DISPLAY);

    // Clamp selection index
    if (this._selectedIndex >= this._rankedClusters.length) {
      this._selectedIndex = Math.max(0, this._rankedClusters.length - 1);
    }
  }

  // ===========================================================================
  // Internal — canvas rendering
  // ===========================================================================

  /** Render the full-screen debris map. */
  _draw() {
    const ctx = this._ctx;
    const W = this._W;
    const H = this._H;

    ctx.clearRect(0, 0, W, H);

    // Semi-transparent background with rounded rect
    ctx.fillStyle = 'rgba(8, 12, 20, 0.94)';
    ctx.beginPath();
    this._roundRect(ctx, 0, 0, W, H, 8);
    ctx.fill();

    // Border
    ctx.strokeStyle = 'rgba(255, 170, 0, 0.4)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, W - 1, H - 1);

    // Layout: left column (60%) for cluster list, right column (40%) for schematic
    const LEFT_W = Math.floor(W * 0.58);
    const RIGHT_W = W - LEFT_W;
    const RIGHT_X = LEFT_W;

    // Vertical divider
    ctx.strokeStyle = 'rgba(255, 170, 0, 0.2)';
    ctx.beginPath();
    ctx.moveTo(LEFT_W, 30);
    ctx.lineTo(LEFT_W, H - 30);
    ctx.stroke();

    // === LEFT COLUMN: Title + Cluster List ===
    this._drawLeftColumn(ctx, LEFT_W, H);

    // === RIGHT COLUMN: Orbital Schematic ===
    this._drawRightColumn(ctx, RIGHT_X, RIGHT_W, H);

    // === FOOTER ===
    this._drawFooter(ctx, W, H);
  }

  /** Draw the left column: title bar + ranked cluster list. */
  _drawLeftColumn(ctx, W, H) {
    // Title bar
    ctx.fillStyle = '#ffaa00';
    ctx.font = 'bold 14px "Courier New", monospace';
    ctx.fillText('▸ DEBRIS MAP', 16, 22);

    // Cluster count
    ctx.fillStyle = '#667788';
    ctx.font = '11px "Courier New", monospace';
    ctx.fillText(`${this._rankedClusters.length} ranked clusters`, 170, 22);

    // Handle empty state
    if (this._rankedClusters.length === 0) {
      ctx.fillStyle = '#556677';
      ctx.font = '13px "Courier New", monospace';
      ctx.fillText('No debris clusters detected', 40, H / 2 - 20);
      ctx.fillText('Waiting for sensor data…', 50, H / 2);
      return;
    }

    // Cluster rows
    const ROW_H = 80;
    const START_Y = 38;

    for (let i = 0; i < this._rankedClusters.length; i++) {
      const c = this._rankedClusters[i];
      const y = START_Y + i * ROW_H;
      const selected = (i === this._selectedIndex);

      // Selection highlight
      if (selected) {
        ctx.fillStyle = 'rgba(255, 170, 0, 0.12)';
        ctx.fillRect(6, y, W - 12, ROW_H - 6);
        ctx.strokeStyle = 'rgba(255, 170, 0, 0.6)';
        ctx.lineWidth = 1;
        ctx.strokeRect(6.5, y + 0.5, W - 13, ROW_H - 7);
      }

      // Rank number
      ctx.fillStyle = selected ? '#ffcc44' : '#667788';
      ctx.font = 'bold 16px "Courier New", monospace';
      ctx.fillText(`${i + 1}.`, 14, y + 20);

      // Cluster name
      ctx.fillStyle = selected ? '#ffffff' : '#aabbcc';
      ctx.font = '12px "Courier New", monospace';
      const name = c.name.length > 30 ? c.name.slice(0, 28) + '…' : c.name;
      ctx.fillText(name, 40, y + 20);

      // Stats line 1: count / mass / variety
      ctx.fillStyle = '#88aacc';
      ctx.font = '11px "Courier New", monospace';
      ctx.fillText(
        `${c.count} obj  ${(c.totalMassKg / 1000).toFixed(1)}t  ×${c.varietyBonus} types`,
        40, y + 37,
      );

      // Stats line 2: ΔV / risk / score
      const dvColor = c.dvMs < 50 ? '#44ff88' : c.dvMs < 200 ? '#ffcc44' : '#ff6644';
      ctx.fillStyle = dvColor;
      ctx.font = '11px "Courier New", monospace';
      ctx.fillText(`ΔV ${c.dvMs.toFixed(0)} m/s`, 40, y + 54);

      const riskColor = c.conjRisk < 2 ? '#44ff88' : c.conjRisk < 5 ? '#ffcc44' : '#ff4444';
      ctx.fillStyle = riskColor;
      ctx.fillText(`risk ${c.conjRisk.toFixed(1)}`, 160, y + 54);

      ctx.fillStyle = '#ffaa00';
      ctx.font = 'bold 11px "Courier New", monospace';
      ctx.fillText(`SCORE ${c.score.toFixed(1)}`, 260, y + 54);

      // Stats line 3: altitude range
      ctx.fillStyle = '#556677';
      ctx.font = '10px "Courier New", monospace';
      ctx.fillText(
        `ALT ${c.altRange.min}–${c.altRange.max} km  INC ${c.incCenter.toFixed(1)}°`,
        40, y + 68,
      );
    }
  }

  /** Draw the right column: orbital altitude schematic with debris density arcs. */
  _drawRightColumn(ctx, x, w, H) {
    const cx = x + w / 2;
    const cy = 30 + (H - 60) / 2;  // center vertically between title and footer
    const maxR = Math.min(w / 2 - 20, (H - 80) / 2 - 10);

    // Title
    ctx.fillStyle = '#ffaa00';
    ctx.font = 'bold 11px "Courier New", monospace';
    ctx.fillText('ORBITAL SURVEY', x + 10, 22);

    // Draw Earth center
    const earthR = maxR * 0.2;
    ctx.fillStyle = 'rgba(60, 120, 180, 0.4)';
    ctx.beginPath();
    ctx.arc(cx, cy, earthR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(60, 120, 180, 0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#4488aa';
    ctx.font = '9px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('EARTH', cx, cy + 3);
    ctx.textAlign = 'left';

    // Draw altitude band rings
    const minAlt = 200;
    const maxAlt = 2000;
    const altToRadius = (alt) => earthR + (alt - minAlt) / (maxAlt - minAlt) * (maxR - earthR);

    for (const band of ALT_BANDS) {
      const r = altToRadius((band.min + band.max) / 2);

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();

      // Band label
      ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.font = '8px "Courier New", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(band.label, cx - r - 3, cy - 2);
      ctx.textAlign = 'left';
    }

    // Draw cluster indicators as arcs on the schematic
    for (let i = 0; i < this._rankedClusters.length; i++) {
      const c = this._rankedClusters[i];
      const selected = (i === this._selectedIndex);

      // Position arc at cluster's altitude
      const meanAlt = (c.altRange.min + c.altRange.max) / 2;
      const r = altToRadius(meanAlt);

      // Arc angular position based on inclination (spread clusters visually)
      const incRad = c.incCenter * Math.PI / 180;
      const startAngle = incRad - 0.4 - i * 0.15;
      const endAngle = incRad + 0.4 + i * 0.15;

      // Arc thickness based on cluster count (more objects = thicker)
      const arcWidth = Math.min(8, 2 + c.count * 0.3);

      // Color by score ranking with conjunction risk influence
      let arcColor;
      if (selected) {
        arcColor = 'rgba(255, 200, 50, 0.9)';
      } else if (c.conjRisk > 5) {
        arcColor = 'rgba(255, 68, 68, 0.6)';
      } else if (c.conjRisk > 2) {
        arcColor = 'rgba(255, 170, 0, 0.5)';
      } else {
        arcColor = 'rgba(0, 255, 136, 0.5)';
      }

      ctx.strokeStyle = arcColor;
      ctx.lineWidth = arcWidth;
      ctx.beginPath();
      ctx.arc(cx, cy, r, startAngle, endAngle);
      ctx.stroke();

      // Cluster number label near the arc
      const labelAngle = (startAngle + endAngle) / 2;
      const lx = cx + (r + 12) * Math.cos(labelAngle);
      const ly = cy + (r + 12) * Math.sin(labelAngle);

      ctx.fillStyle = selected ? '#ffcc44' : '#aabbcc';
      ctx.font = selected ? 'bold 10px "Courier New", monospace' : '9px "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${i + 1}`, lx, ly + 3);
      ctx.textAlign = 'left';

      // Selected cluster highlight ring
      if (selected) {
        ctx.strokeStyle = 'rgba(255, 200, 50, 0.3)';
        ctx.lineWidth = arcWidth + 4;
        ctx.beginPath();
        ctx.arc(cx, cy, r, startAngle - 0.05, endAngle + 0.05);
        ctx.stroke();
      }
    }

    // Player position indicator (small green diamond)
    if (this._player) {
      const playerOrbit = this._player.orbit || this._player.getOrbitalElements?.() || {};
      const playerAltKm = (playerOrbit.semiMajorAxis || 0) / Constants.SCENE_SCALE - Constants.EARTH_RADIUS_KM;
      if (playerAltKm > minAlt && playerAltKm < maxAlt) {
        const pr = altToRadius(playerAltKm);
        const pa = -Math.PI / 2; // top position
        const px = cx + pr * Math.cos(pa);
        const py = cy + pr * Math.sin(pa);

        ctx.fillStyle = '#00ff88';
        ctx.beginPath();
        ctx.moveTo(px, py - 5);
        ctx.lineTo(px + 4, py);
        ctx.lineTo(px, py + 5);
        ctx.lineTo(px - 4, py);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = '#00ff88';
        ctx.font = '8px "Courier New", monospace';
        ctx.textAlign = 'center';
        ctx.fillText('YOU', px, py - 8);
        ctx.textAlign = 'left';
      }
    }

    // Legend
    const legendY = H - 55;
    ctx.fillStyle = '#556677';
    ctx.font = '9px "Courier New", monospace';
    ctx.fillText('● low risk', x + 10, legendY);
    ctx.fillText('● med risk', x + 10, legendY + 12);
    ctx.fillText('● high risk', x + 10, legendY + 24);

    ctx.fillStyle = 'rgba(0, 255, 136, 0.7)';
    ctx.fillRect(x + 10, legendY - 7, 6, 6);
    ctx.fillStyle = 'rgba(255, 170, 0, 0.7)';
    ctx.fillRect(x + 10, legendY + 5, 6, 6);
    ctx.fillStyle = 'rgba(255, 68, 68, 0.7)';
    ctx.fillRect(x + 10, legendY + 17, 6, 6);
  }

  /** Draw footer keybind hints. */
  _drawFooter(ctx, W, H) {
    const footerY = H - 14;

    // Footer background bar
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.fillRect(0, H - 28, W, 28);

    ctx.fillStyle = '#667788';
    ctx.font = '10px "Courier New", monospace';
    ctx.fillText('[`] close   [,/.] select   [Shift+A] engage autopilot   [Esc] close', 16, footerY);
  }

  /** Emit cluster selection event for external consumers. */
  _emitSelection() {
    const cluster = this.getSelectedCluster();
    if (cluster) {
      eventBus.emit(Events.DEBRIS_MAP_CLUSTER_SELECTED, { clusterId: cluster.id });
    }
  }

  /** Helper: draw a rounded rectangle path. */
  _roundRect(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
  }

  /** Clean up DOM + events. */
  dispose() {
    this._canvas?.remove();
    this._backdrop?.remove();
  }
}
