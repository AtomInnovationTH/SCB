/**
 * NavSphere.js — 3D radar sphere HUD element
 * Projects all contacts onto a 2D circle for 360° situational awareness.
 * Distance-encoded: hybrid logarithmic dual-zone mapping (Sprint S5-A).
 * Inspired by the Nav Sphere from Independence War (1997).
 * @module ui/NavSphere
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { GameStates } from '../core/GameState.js';
import { orbitToSceneCartesian } from '../entities/OrbitalMechanics.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

const SPHERE_RADIUS = 140;         // px radius — diameter 280 matches targets panel width
const MARGIN_RIGHT = 0;            // px from right screen edge — flush with viewport edge
const MARGIN_TOP_FALLBACK = 10;    // px from top edge — fallback when comms panel is absent
const COMMS_GAP = 6;              // px gap between comms panel bottom and NavSphere top (UX-2 #11)
const MIN_READOUT_HEIGHT = 20;     // px vertical footprint of the minimized LAT/LON/ALT one-liner

/** @enum {string} Color palette */
const C = {
  bg:       'rgba(0, 20, 40, 0.6)',
  grid:     'rgba(0, 255, 136, 0.15)',
  gridEdge: 'rgba(0, 255, 136, 0.25)',
  player:   '#ffffff',
  earth:    'rgba(0, 120, 255, 0.5)',
  earthDim: 'rgba(0, 80, 180, 0.25)',
  sun:      '#ffcc00',
  prograde: '#00ff88',
  selected: '#00ccff',
  geo:      'rgba(80, 170, 255, 0.95)', // LAT/LON/ALT readout — blue, clearly tied to the NavSphere
  green:    '#00ff88',
  yellow:   '#ffcc00',
  red:      '#ff4444',
  white:    '#ffffff',
};

// ============================================================================
// TESTABLE HELPER FUNCTIONS (pure, module-level — exported for Node tests)
// ============================================================================

/** Compute stalk screen-dy for a given z, R, fraction. z > 0 → up (negative dy). */
function _stalkDyForZ(z, R, stalkMaxFraction) {
  const stalkLen = Math.abs(z) * R * stalkMaxFraction;
  return z > 0 ? -stalkLen : +stalkLen;
}

/** Arrow length (px) for a given closure rate (km/s), clamped to max. */
function _arrowLengthPx(closureRateKms, maxKms, maxLengthPx) {
  if (closureRateKms <= 0) return 0;
  return Math.min(closureRateKms / maxKms, 1) * maxLengthPx;
}

/** Sort contacts so selectedId appears last (painter's order). */
function _sortContactsSelectedLast(contacts, selectedId) {
  const result = [];
  let selected = null;
  for (const c of contacts) {
    if (c.id === selectedId) { selected = c; continue; }
    result.push(c);
  }
  if (selected) result.push(selected);
  return result;
}

/**
 * ECI → WGS-84 geodetic conversion with explicit GMST.
 * Game coordinate system: Y = polar axis, XZ = equatorial plane.
 * @param {number} x - ECI X (km)
 * @param {number} y - ECI Y / polar axis (km)
 * @param {number} z - ECI Z (km)
 * @param {number} gmst - Greenwich Mean Sidereal Time (radians)
 * @returns {{ lat: number, lon: number, alt: number }} degrees, degrees, km
 */
function _eciToGeodeticWithGMST(x, y, z, gmst) {
  const cg = Math.cos(gmst), sg = Math.sin(gmst);
  const xe = x * cg + z * sg, ze = -x * sg + z * cg, ye = y;
  const a = 6378.137, f = 1 / 298.257223563, b = a * (1 - f);
  const e2 = 1 - (b * b) / (a * a);
  const p = Math.sqrt(xe * xe + ze * ze);
  let lat = Math.atan2(ye, p * (1 - e2));
  for (let i = 0; i < 5; i++) {
    const sLat = Math.sin(lat);
    const N = a / Math.sqrt(1 - e2 * sLat * sLat);
    lat = Math.atan2(ye + e2 * N * sLat, p);
  }
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  const alt = Math.abs(cosLat) > 1e-10 ? p / cosLat - N : Math.abs(ye) - b;
  return { lat: lat * 180 / Math.PI, lon: Math.atan2(ze, xe) * 180 / Math.PI, alt };
}

/**
 * ECI → WGS-84 geodetic using Date.now() for GMST.
 * Approximate but sufficient: visible LAT/LON drift is correct.
 * Uses Date.now() because no sim-epoch is available in GameState.
 */
function _eciToGeodetic(x, y, z) {
  const jd = Date.now() / 86400000 + 2440587.5;
  const T = (jd - 2451545.0) / 36525.0;
  const gmstDeg = 280.46061837 + 360.98564736629 * (jd - 2451545.0)
    + T * T * (0.000387933 - T / 38710000);
  const gmst = ((gmstDeg % 360) + 360) % 360 * Math.PI / 180;
  return _eciToGeodeticWithGMST(x, y, z, gmst);
}

// ============================================================================
// NAV SPHERE
// ============================================================================

export class NavSphere {
  /**
   * @param {THREE.PerspectiveCamera} camera
   */
  constructor(camera) {
    this.camera = camera;

    /** @type {HTMLCanvasElement} */
    this.canvas = null;
    /** @type {CanvasRenderingContext2D} */
    this.ctx = null;
    this._width = 0;
    this._height = 0;

    this._visible = true;
    this._hidden = false;
    this._minimized = false;             // 9-key style minimize → lat/lon/alt one-liner (8 key)
    this._time = 0;
    this._selectedTargetId = null;
    this._frameSkip = -1;  // Throttle counter for Canvas2D redraws (10Hz at 60fps)
    this._geoDrawCount = 0;              // Separate frame counter for 2 Hz geo readout
    this._geoCache = null;               // { lat, lon, alt } refreshed at 2 Hz

    // Dynamic sensor range (km) — updated each frame from SensorSystem
    this._outerZoneKm = Constants.NAVSPHERE.OUTER_ZONE_KM_MAX;
    this._playerVel = null;

    // Reusable THREE vectors
    this._right   = new THREE.Vector3();
    this._up      = new THREE.Vector3();
    this._forward = new THREE.Vector3();
    this._tmpDir  = new THREE.Vector3();
    this._eqDir   = new THREE.Vector3();  // reusable for equatorial projection

    // §13 Sprint 4 (Phase 3 audit): cached comms-panel bottom (CSS px). The
    // NavSphere draw loop runs at 10 Hz; the previous code called
    // `document.getElementById('hud-comms-panel').getBoundingClientRect()`
    // every draw, forcing a synchronous layout flush (HUD CSS animations +
    // StatusPanel text mutations on the same frame guarantee the layout was
    // dirty). Mirror the Sprint 2 / PR E pattern from
    // [`HUD.js`](js/ui/HUD.js:140): cache the bottom Y, invalidate on resize
    // and VIEW_CONFIG_CHANGE (which can show/hide the comms panel).
    /** @type {number|null} */
    this._commsBottomCache = null;
    /** @type {HTMLElement|null} */
    this._commsElCache = null;
    /** @type {number|null} Timestamp (ms) until which the comms-bottom cache is
     *  recomputed every draw, covering the comms panel's ~0.3s height animation. */
    this._commsResizeSettleAt = null;

    this._createCanvas();
    this._onResize();
    window.addEventListener('resize', () => {
      this._onResize();
      this._commsBottomCache = null; // resize may move the panel
    });

    // Self-manage visibility via EventBus (decoupled from GameFlowManager)
    eventBus.on(Events.VIEW_CONFIG_CHANGE, (config) => {
      if (config.showNavSphere !== undefined) this.setVisible(config.showNavSphere);
      // Comms panel can show/hide too — invalidate the cache so the next
      // draw recomputes the bottom Y from the new layout.
      this._commsBottomCache = null;
    });
    eventBus.on(Events.GAME_STATE_CHANGE, ({ to }) => {
      const gameplay = (to === GameStates.ORBITAL_VIEW || to === GameStates.APPROACH || to === GameStates.INTERACTION);
      if (!gameplay) this.setVisible(false);
    });
    // Comms panel stepped to a new size — its bottom edge (which anchors the
    // sphere's vertical position) moved. The height animates over ~0.3s, so
    // keep recomputing through a short settle window (see update()).
    eventBus.on(Events.COMMS_PANEL_RESIZED, () => {
      this._commsBottomCache = null;
      this._commsResizeSettleAt =
        (typeof performance !== 'undefined' ? performance.now() : Date.now()) + Constants.COMMS_RESIZE_SETTLE_MS;
    });
    eventBus.on(Events.HUD_TARGET_CLICK, (data) => {
      this.setSelectedTarget(data.id);
    });
  }

  // ==========================================================================
  // CANVAS SETUP
  // ==========================================================================

  /** @private */
  _createCanvas() {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'navsphere-canvas';
    this.canvas.style.cssText = `
      position: fixed; top: 0; left: 0;
      width: 100%; height: 100%;
      pointer-events: none; z-index: 9;
    `;
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
  }

  /** @private */
  _onResize() {
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.dpr = dpr;
    this._width  = window.innerWidth;
    this._height = window.innerHeight;
    this.canvas.width  = this._width  * dpr;
    this.canvas.height = this._height * dpr;
    this.canvas.style.width  = this._width  + 'px';
    this.canvas.style.height = this._height + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  /** @param {boolean} visible */
  setVisible(visible) {
    this._visible = visible;
    this._frameSkip = -1; // Reset throttle so next update draws immediately
    if (this._hidden) return; // respect manual toggle
    this.canvas.style.display = visible ? 'block' : 'none';
  }

  /**
   * Clean public toggle — wraps toggleVisibility().
   * Delegation 3 (2026-05-31): InputManager Shift+N prefers this over the
   * internal toggleVisibility() which manages the _hidden flag.
   */
  toggle() { this.toggleVisibility(); }

  /** Toggle NavSphere visibility */
  toggleVisibility() {
    if (!this.canvas) return;
    this._hidden = !this._hidden;
    this._frameSkip = -1; // Reset throttle so next visible frame draws immediately
    this.canvas.style.display = this._hidden ? 'none' : 'block';
  }

  /**
   * Minimize-to-one-line toggle (hotkey revamp 2026-06-14 — the 8 key).
   * Instead of fully hiding, the minimized NavSphere collapses to a compact
   * LAT / LON / ALT readout drawn at the sphere's corner (the sphere geometry,
   * grid, blips and rings are skipped). The readout stays live because update()
   * keeps refreshing _geoCache. Press again to restore the full sphere.
   */
  toggleMinimized() {
    if (!this.canvas) return;
    this._minimized = !this._minimized;
    this._frameSkip = -1; // redraw immediately on the next frame
  }

  /** @returns {boolean} */
  get isMinimized() { return this._minimized; }

  /**
   * Effective vertical footprint (in px) the NavSphere occupies below the comms
   * panel, used by HUD.js to position the right-hand pane column. This is the
   * single source of truth for the NavSphere "slot" height so panes below can
   * reclaim the space when the sphere is minimized or hidden:
   *   • fully hidden / not visible → 0 (column climbs to just below comms)
   *   • minimized (8 key)          → MIN_READOUT_HEIGHT (the one-line readout)
   *   • expanded                   → full diameter (2 × SPHERE_RADIUS)
   * The COMMS_GAP above the slot is added by the caller, not included here.
   * @returns {number} px
   */
  getReservedHeight() {
    if (this._hidden || !this._visible) return 0;
    if (this._minimized) return MIN_READOUT_HEIGHT;
    return 2 * SPHERE_RADIUS;
  }

  /** @param {number|null} id */
  setSelectedTarget(id) { this._selectedTargetId = id; }

  /**
   * Main per-frame update.
   * @param {number} dt
   * @param {object} data
   * @param {THREE.Vector3}  data.playerPos
   * @param {{x:number,y:number,z:number}} data.playerVel
   * @param {object}         data.debrisField
   * @param {object}         data.activeSatellites
   * @param {THREE.Vector3} [data.sunDirection]
   * @param {object}        [data.targetSelector]
   * @param {object}        [data.sensorSystem]
   * @param {object}        [data.armManager] - ArmManager for jellyfish tether viz
   */
  update(dt, data) {
    if (this._hidden) return;
    this._time += dt;

    // Throttle Canvas2D redraws to every 6th frame (≈10Hz at 60fps)
    this._frameSkip++;
    if (this._frameSkip % 6 !== 0) return;

    this.ctx.clearRect(0, 0, this._width, this._height);
    if (!this._visible || !data || !data.playerPos) return;

    // While the comms panel's height animates after a size step, force a
    // per-draw recompute of its bottom edge so the sphere tracks it smoothly.
    if (this._commsResizeSettleAt != null) {
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (now < this._commsResizeSettleAt) this._commsBottomCache = null;
      else this._commsResizeSettleAt = null;
    }

    // Geolocation readout — refresh at 2 Hz (every 5th 10Hz draw frame)
    this._geoDrawCount++;
    if (this._geoDrawCount % 5 === 0 && data.playerPos) {
      const S = Constants.SCENE_SCALE;
      this._geoCache = _eciToGeodetic(
        data.playerPos.x / S,
        data.playerPos.y / S,
        data.playerPos.z / S
      );
    }

    // Minimized (8 key): draw only the LAT/LON/ALT one-liner and skip the
    // sphere. _geoCache above is still refreshed so the readout stays live.
    if (this._minimized) {
      this._drawMinReadout();
      return;
    }

    const { playerPos, playerVel, debrisField, activeSatellites,
            sunDirection, targetSelector, sensorSystem, armManager } = data;

    // Dynamic sensor range
    if (sensorSystem && sensorSystem.range) {
      this._outerZoneKm = sensorSystem.range / Constants.SCENE_SCALE;
    } else {
      this._outerZoneKm = Constants.NAVSPHERE.OUTER_ZONE_KM_MAX;
    }

    // Store player velocity for closure rate calculations
    this._playerVel = playerVel || null;

    // Sync selected target from target selector
    if (targetSelector) {
      const at = targetSelector.getActiveTarget();
      if (at) this._selectedTargetId = at.id;
    }

    // Extract camera local axes
    this.camera.updateMatrixWorld();
    const m = this.camera.matrixWorld;
    this._right.setFromMatrixColumn(m, 0);
    this._up.setFromMatrixColumn(m, 1);
    this._forward.setFromMatrixColumn(m, 2).negate();

    // Sphere center — top-right corner, dynamically below comms panel (UX-2 #11).
    // §13 Sprint 4 (Phase 3 audit): cache the comms-panel bottom across draws
    // to avoid a per-draw sync layout flush. Invalidated on resize and
    // VIEW_CONFIG_CHANGE. At 10 Hz this saves ~10 layout flushes/s.
    const cx = this._width  - MARGIN_RIGHT - SPHERE_RADIUS;
    if (this._commsBottomCache == null) {
      if (!this._commsElCache) {
        this._commsElCache = document.getElementById('hud-comms-panel');
      }
      this._commsBottomCache = this._commsElCache
        ? this._commsElCache.getBoundingClientRect().bottom
        : MARGIN_TOP_FALLBACK;
    }
    const commsBottom = this._commsBottomCache;
    const marginTop = commsBottom + COMMS_GAP;
    const cy = marginTop + SPHERE_RADIUS;
    const R  = SPHERE_RADIUS;
    const ctx = this.ctx;

    ctx.save();

    // ---- Hemisphere background (radial gradient for 3D depth) ----
    const bgGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    bgGrad.addColorStop(0, 'rgba(0, 40, 80, 1.0)');
    bgGrad.addColorStop(0.7, 'rgba(0, 25, 50, 1.0)');
    bgGrad.addColorStop(1, 'rgba(0, 10, 30, 1.0)');
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = bgGrad;
    ctx.fill();

    // Specular highlight (offset up-left, simulating light on glass sphere)
    const hlX = cx - R * 0.3;
    const hlY = cy - R * 0.3;
    const hlR = R * 0.45;
    const hlGrad = ctx.createRadialGradient(hlX, hlY, 0, hlX, hlY, hlR);
    hlGrad.addColorStop(0, 'rgba(180, 220, 255, 0.18)');
    hlGrad.addColorStop(0.5, 'rgba(120, 180, 255, 0.06)');
    hlGrad.addColorStop(1, 'rgba(120, 180, 255, 0.0)');
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = hlGrad;
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip(); // clip all drawing inside the sphere

    // ---- Elliptical grid lines (3D hemisphere great circles) ----
    const gridCol = 'rgba(0, 150, 255, 0.15)';
    ctx.lineWidth = 0.5;

    // Longitude meridians (vertical ellipses)
    for (const deg of [-60, -30, 0, 30, 60]) {
      const phi = deg * Math.PI / 180;
      const rX = Math.abs(R * Math.sin(phi));
      ctx.strokeStyle = gridCol;
      ctx.beginPath();
      if (rX < 1) {
        // Central meridian — vertical line
        ctx.moveTo(cx, cy - R);
        ctx.lineTo(cx, cy + R);
      } else {
        ctx.ellipse(cx, cy, rX, R * 0.92, 0, 0, Math.PI * 2);
      }
      ctx.stroke();
    }

    // Latitude parallels (horizontal ellipses with curvature for 3D effect)
    for (const f of [-0.5, 0, 0.5]) {
      const yOff = f * R;
      const halfW = R * Math.sqrt(1 - f * f);
      // Vertical radius creates the curved 3D appearance
      const rY = halfW * 0.18 * (1 - Math.abs(f) * 0.5);
      ctx.strokeStyle = gridCol;
      ctx.beginPath();
      ctx.ellipse(cx, cy + yOff, halfW * 0.92, Math.max(rY, 1.5), 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    // ---- Distance-encoded range rings (replaces FOV boundary ring) ----
    this._drawRangeRings(ctx, cx, cy, R);

    // ---- Tether range rings (jellyfish tentacle zones) ----
    this._drawTetherRings(ctx, cx, cy, R, armManager);

    // ---- Earth direction indicator ----
    this._drawIndicator(ctx, cx, cy, R,
      playerPos.clone().negate().normalize(),
      C.earth, C.earthDim, 12, 'E');

    // ---- Sun direction indicator ----
    if (sunDirection) {
      this._drawIndicator(ctx, cx, cy, R,
        sunDirection.clone().normalize(),
        C.sun, C.sun, 5, null, 0.9, 0.35);
    }

    // ---- Velocity prograde marker ----
    if (playerVel) {
      const v = new THREE.Vector3(playerVel.x, playerVel.y, playerVel.z);
      if (v.lengthSq() > 1e-8) {
        v.normalize();
        const { sx, sy, z } = this._toSphere(v, cx, cy, R);
        const a = z > 0 ? 0.9 : 0.35;
        ctx.globalAlpha = a;
        ctx.strokeStyle = C.prograde;
        ctx.lineWidth = 2;
        // Small circle
        ctx.beginPath();
        ctx.arc(sx, sy, 6, 0, Math.PI * 2);
        ctx.stroke();
        // Cross-hair ticks
        ctx.beginPath();
        ctx.moveTo(sx - 9, sy); ctx.lineTo(sx - 5, sy);
        ctx.moveTo(sx + 5, sy); ctx.lineTo(sx + 9, sy);
        ctx.moveTo(sx, sy + 5); ctx.lineTo(sx, sy + 9);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // ---- Debris contact dots (painter's order: non-selected first, selected last) ----
    let _selectedDebrisTarget = null;
    if (debrisField) {
      const canDetect = sensorSystem && sensorSystem.canDetectUntracked;
      const sensorRange = this._outerZoneKm * Constants.SCENE_SCALE;
      const targets = debrisField.getDebrisNear(playerPos, sensorRange);
      for (const t of targets) {
        if (!t.alive) continue;
        // Skip untracked debris unless IR Scanner is active or it's the selected target
        if (t.tracked === false && !canDetect && t.id !== this._selectedTargetId) continue;
        if (t.id === this._selectedTargetId) {
          _selectedDebrisTarget = t;  // defer to draw last (on top)
          continue;
        }
        this._drawDebrisDot(ctx, cx, cy, R, t, playerPos);
      }
    }

    // ---- Arm tether lines (jellyfish tentacles) ----
    this._drawArmTetherLines(ctx, cx, cy, R, armManager, playerPos);

    // ---- Sibling arm markers (ARM_PILOT mode — ST-8.5.2) ----
    if (data.pilotedArmId) {
      this._drawSiblingArmMarkers(ctx, cx, cy, R, armManager, playerPos, data.pilotedArmId);
    }

    // ---- Active satellite dots ----
    if (activeSatellites) {
      const sats = activeSatellites.getSatelliteList(playerPos);
      for (const s of sats) {
        if (s.distance / Constants.SCENE_SCALE > this._outerZoneKm) continue;
        this._drawSatDot(ctx, cx, cy, R, s, playerPos);
      }
    }

    // ---- Selected target drawn LAST (painter's order — on top of all others) ----
    if (_selectedDebrisTarget) {
      this._drawDebrisDot(ctx, cx, cy, R, _selectedDebrisTarget, playerPos);
    }

    // ---- Player center dot (drawn last, on top) ----
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = C.player;
    ctx.fill();

    ctx.restore(); // remove clip

    // ---- Rim / edge glow (drawn outside clip so full stroke is visible) ----
    // Outer glow ring (softer, wider)
    ctx.strokeStyle = 'rgba(0, 150, 255, 0.12)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    // Inner rim stroke
    ctx.strokeStyle = 'rgba(0, 150, 255, 0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();

    // ---- Geolocation readout (LAT / LON / ALT) below sphere (ST-5.4) ----
    if (this._geoCache) {
      const geo = this._geoCache;
      ctx.font = '10px "Courier New", monospace';
      ctx.fillStyle = C.geo;
      ctx.textAlign = 'center';
      const latStr = `${geo.lat >= 0 ? '+' : ''}${geo.lat.toFixed(1)}\u00B0`;
      const lonStr = `${geo.lon >= 0 ? '+' : ''}${geo.lon.toFixed(1)}\u00B0`;
      const altStr = `${Math.round(geo.alt)}`;
      ctx.fillText(`LAT ${latStr}  LON ${lonStr}  ALT ${altStr} km`, cx, cy + R + 14);
    }

    // ---- ST-9.3 C-3: HIGH RECOIL warning indicator ----
    // Show amber warning when selected arm's aim alpha is in the high-recoil zone
    // (α < 30° or α > 150°, near stowed/zenith where cos(α) ≈ ±1 → max residual torque)
    if (armManager && armManager.selectedArmIndex >= 0) {
      const selArm = armManager.arms[armManager.selectedArmIndex];
      if (selArm && typeof selArm.isHighRecoilZone === 'function' && selArm.isHighRecoilZone()) {
        const warnY = cy - R - 8;
        ctx.font = 'bold 10px "Courier New", monospace';
        ctx.fillStyle = '#ffcc00';
        ctx.textAlign = 'center';
        ctx.globalAlpha = 0.6 + 0.4 * Math.sin(this._time * 4); // pulse
        ctx.fillText('⚠ HIGH RECOIL', cx, warnY);
        ctx.globalAlpha = 1;
      }
    }

    ctx.restore();
  }

  /**
   * @private Draw the minimized NavSphere — just a compact LAT / LON / ALT
   * one-liner at the top-right corner where the sphere would sit (8 key).
   */
  _drawMinReadout() {
    const ctx = this.ctx;
    if (!ctx) return;
    // Anchor at the sphere's corner; reuse the cached comms-panel bottom.
    if (this._commsBottomCache == null) {
      if (!this._commsElCache) this._commsElCache = document.getElementById('hud-comms-panel');
      this._commsBottomCache = this._commsElCache
        ? this._commsElCache.getBoundingClientRect().bottom
        : MARGIN_TOP_FALLBACK;
    }
    const x = this._width - MARGIN_RIGHT - 8;
    const y = this._commsBottomCache + COMMS_GAP + 12;

    const geo = this._geoCache;
    const latStr = geo ? `${geo.lat >= 0 ? '+' : ''}${geo.lat.toFixed(1)}\u00B0` : '--';
    const lonStr = geo ? `${geo.lon >= 0 ? '+' : ''}${geo.lon.toFixed(1)}\u00B0` : '--';
    const altStr = geo ? `${Math.round(geo.alt)} km` : '--';

    ctx.save();
    ctx.font = '11px "Courier New", monospace';
    ctx.fillStyle = C.geo;
    ctx.textAlign = 'right';
    ctx.fillText(`NAV  LAT ${latStr}  LON ${lonStr}  ALT ${altStr}`, x, y);
    ctx.restore();
  }


  /**
   * Hybrid log + dual-zone distance mapping.
   * Inner zone: 0–5 km → center to 50% R (logarithmic)
   * Outer zone: 5–outerKm → 50% R to rim (logarithmic)
   * @param {number} distKm - distance in kilometers
   * @param {number} R - sphere radius in pixels
   * @returns {number} radius in pixels from center
   */
  _distToRadius(distKm, R) {
    const NS = Constants.NAVSPHERE;
    const innerKm = NS.INNER_ZONE_KM;       // 5
    const split = NS.ZONE_SPLIT;             // 0.50
    const outerKm = this._outerZoneKm || NS.OUTER_ZONE_KM_MAX;

    if (distKm <= 0) return 0;

    if (distKm <= innerKm) {
      // Inner zone: log mapping 0–innerKm → 0–split*R
      return Math.log(1 + distKm) / Math.log(1 + innerKm) * split * R;
    } else {
      // Outer zone: log mapping innerKm–outerKm → split*R – R
      const outerRange = outerKm - innerKm;
      const d = distKm - innerKm;
      return (Math.log(1 + d) / Math.log(1 + outerRange) * (1 - split) + split) * R;
    }
  }

  /**
   * Project a relative position vector to NavSphere screen coordinates
   * using camera-space direction + distance-encoded radius.
   * @param {THREE.Vector3} relVec - relative position (NOT normalized)
   * @param {number} cx - sphere center x
   * @param {number} cy - sphere center y
   * @param {number} R - sphere radius px
   * @returns {{sx: number, sy: number, z: number, distKm: number, clipped: boolean}}
   */
  _toSphereWithDistance(relVec, cx, cy, R) {
    const distScene = relVec.length();
    const distKm = distScene / Constants.SCENE_SCALE;

    // Normalize for direction
    this._tmpDir.copy(relVec).normalize();

    const dx = this._tmpDir.dot(this._right);
    const dy = -this._tmpDir.dot(this._up);      // screen Y is inverted
    const z  = this._tmpDir.dot(this._forward);   // depth (positive = in front)

    // Map distance to radius
    const r = this._distToRadius(distKm, R);

    // Direction on sphere surface (2D unit vector)
    const dirLen = Math.sqrt(dx * dx + dy * dy) || 1e-6;
    const ndx = dx / dirLen;
    const ndy = dy / dirLen;

    // For objects behind the camera (z < 0), place on rim
    let clipped = false;
    let finalR = r;
    if (z < 0) {
      finalR = R * 0.95;  // Push to near-rim
      clipped = true;
    }

    const sx = cx + ndx * finalR;
    const sy = cy + ndy * finalR;

    return { sx, sy, z, distKm, clipped };
  }

  /**
   * Compute closure rate: negative = approaching, positive = receding (E4).
   * @param {object} targetCart - {position: {x,y,z}, velocity: {x,y,z}} from orbitToSceneCartesian
   * @param {THREE.Vector3} playerPos
   * @param {object} playerVel - {x,y,z}
   * @returns {number} closure rate (negative = closing)
   */
  _computeClosureRate(targetCart, playerPos, playerVel) {
    if (!playerVel) return null;

    // Relative position
    const rx = targetCart.position.x - playerPos.x;
    const ry = targetCart.position.y - playerPos.y;
    const rz = targetCart.position.z - playerPos.z;
    const dist = Math.sqrt(rx * rx + ry * ry + rz * rz);
    if (dist < 1e-10) return 0;

    // Unit direction vector
    const ux = rx / dist;
    const uy = ry / dist;
    const uz = rz / dist;

    // Relative velocity (target vel - player vel)
    const tvx = (targetCart.velocity?.x || 0) - playerVel.x;
    const tvy = (targetCart.velocity?.y || 0) - playerVel.y;
    const tvz = (targetCart.velocity?.z || 0) - playerVel.z;

    // Closure rate = dot product of relative velocity with unit direction
    // Negative = approaching, positive = receding
    return tvx * ux + tvy * uy + tvz * uz;
  }

  // ==========================================================================
  // PRIVATE HELPERS
  // ==========================================================================

  /**
   * Project a direction vector onto sphere screen coords.
   * Used for direction-only indicators (Earth, Sun, Prograde, velocity).
   * Can accept unnormalized vectors (e.g., equatorial projections for stalks).
   * @param {THREE.Vector3} dir - Direction vector (normalized or unnormalized)
   * @returns {{ sx: number, sy: number, z: number }}
   */
  _toSphere(dir, cx, cy, R) {
    const x = dir.dot(this._right);
    const y = dir.dot(this._up);
    const z = dir.dot(this._forward);
    return { sx: cx + x * R * 0.85, sy: cy - y * R * 0.85, z };
  }

  /** Draw a labelled direction indicator (Earth, Sun). */
  _drawIndicator(ctx, cx, cy, R, dir, colFront, colBack, size, label,
                  aFront = 1, aBack = 0.4) {
    const { sx, sy, z } = this._toSphere(dir, cx, cy, R);
    ctx.globalAlpha = z > 0 ? aFront : aBack;
    ctx.beginPath();
    ctx.arc(sx, sy, size, 0, Math.PI * 2);
    ctx.fillStyle = z > 0 ? colFront : colBack;
    ctx.fill();
    if (label) {
      ctx.font = '10px sans-serif';
      ctx.fillStyle = 'rgba(100,180,255,0.8)';
      ctx.textAlign = 'center';
      ctx.fillText(label, sx, sy + 3);
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Draw labeled concentric range rings at key distances.
   * Uses _distToRadius for proper log mapping.
   * Replaces the old FOV boundary ring.
   */
  _drawRangeRings(ctx, cx, cy, R) {
    const NS = Constants.NAVSPHERE;
    const rings = NS.RANGE_RINGS_KM;  // [0.2, 0.5, 2, 5, 10, 25, 50]

    ctx.save();
    ctx.font = '8px monospace';
    ctx.textAlign = 'left';

    for (const km of rings) {
      const r = this._distToRadius(km, R);
      if (r < 2 || r > R) continue;

      // 5 km boundary is more prominent (zone split)
      const isZoneBoundary = (km === NS.INNER_ZONE_KM);

      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);

      if (isZoneBoundary) {
        ctx.strokeStyle = NS.COLOR_ZONE_BOUNDARY;
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1.0;
      } else {
        ctx.strokeStyle = 'rgba(0, 255, 136, 0.08)';
        ctx.setLineDash([2, 6]);
        ctx.lineWidth = 0.5;
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // Label (only for larger rings to avoid clutter)
      if (km >= 5 || km === 0.2 || km === 2) {
        const label = km >= 1 ? `${km}km` : `${km * 1000}m`;
        ctx.fillStyle = 'rgba(0, 255, 136, 0.25)';
        ctx.fillText(label, cx + r + 2, cy - 2);
      }
    }
    ctx.restore();
  }

  /** Draw a debris contact dot with zone-based coloring, distance encoding, and type shapes. */
  _drawDebrisDot(ctx, cx, cy, R, target, playerPos) {
    const cart = orbitToSceneCartesian(target.orbit);
    this._tmpDir.set(cart.position.x, cart.position.y, cart.position.z)
      .sub(playerPos);
    const { sx, sy, z, distKm, clipped } = this._toSphereWithDistance(this._tmpDir, cx, cy, R);
    // After _toSphereWithDistance, _tmpDir is normalized (direction only)

    // Continuous dot size: closer = bigger
    const NS = Constants.NAVSPHERE;
    const t = Math.min(distKm / (this._outerZoneKm || NS.OUTER_ZONE_KM_MAX), 1);
    let dotSz = NS.DOT_MAX_PX - t * (NS.DOT_MAX_PX - NS.DOT_MIN_PX);
    const alpha = z > 0 ? 0.9 : 0.4;
    if (z < 0) dotSz = Math.max(NS.DOT_MIN_PX, dotSz - 1);

    // Size modulation from physical debris size (E2)
    let finalSize = dotSz;
    if (target.sizeMeter) {
      // Scale factor: tiny debris (0.1m) = 0.5x, huge debris (10m+) = 1.5x
      const sizeScale = 0.5 + Math.min(target.sizeMeter / 10, 1.0);
      finalSize = dotSz * sizeScale;
    }
    finalSize = Math.max(NS.DOT_MIN_PX, Math.min(finalSize, NS.DOT_MAX_PX));

    // Closure rate coloring (E4)
    const closureRate = this._computeClosureRate(cart, playerPos, this._playerVel);

    // Zone-based coloring with closure rate override
    const sel = target.id === this._selectedTargetId;
    const dotColor = this._getZoneColor(distKm, sel, closureRate);

    // Bidirectional stalk (depth encoding: z > 0 → up, z < 0 → down) (ST-5.4)
    this._drawStalk(ctx, cx, cy, R, this._tmpDir, sx, sy, z, dotColor, distKm);

    // Draw contact shape based on debris type (E1)
    const drawSize = sel ? finalSize + 2.5 : finalSize;
    this._drawContactShape(ctx, sx, sy, target.type, drawSize, dotColor, alpha);

    // Lock-on ring: pulsing double-circle (ST-5.4), colour swapped by MOID badge (ST-6.3)
    if (sel) {
      const NS2 = Constants.NAVSPHERE;
      const pulseT = Math.sin(this._time * NS2.LOCK_ON_PULSE_RATE * 2 * Math.PI);

      // ST-6.3: MOID badge colour override — HI = pulse red, MD = steady yellow, LO/null = default cyan
      let ringColor = C.selected;
      let doPulse = true;
      const moidBadge = target.moidBadge || null;
      if (moidBadge === 'HI') {
        ringColor = Constants.CONJUNCTION.BADGE_COLOR_HI;
        doPulse = true;  // pulse for HI
      } else if (moidBadge === 'MD') {
        ringColor = Constants.CONJUNCTION.BADGE_COLOR_MD;
        doPulse = false; // steady for MD
      }
      // LO or null → keep default cyan, keep pulse

      const pulseAlpha = doPulse ? (0.5 + 0.4 * pulseT) : 0.8;
      ctx.strokeStyle = ringColor;
      ctx.lineWidth = 1.5;
      // Outer ring (1.5× dot size)
      ctx.globalAlpha = alpha * pulseAlpha;
      ctx.beginPath();
      ctx.arc(sx, sy, finalSize * NS2.LOCK_ON_OUTER_RADIUS_MULT, 0, Math.PI * 2);
      ctx.stroke();
      // Inner ring (1.1× dot size)
      ctx.globalAlpha = alpha * pulseAlpha * 0.7;
      ctx.beginPath();
      ctx.arc(sx, sy, finalSize * NS2.LOCK_ON_INNER_RADIUS_MULT, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Velocity (closure) arrow for contacts within range (ST-5.4)
    if (distKm <= Constants.NAVSPHERE.VELOCITY_ARROW_RANGE_KM && closureRate !== null) {
      this._drawVelocityArrow(ctx, sx, sy, closureRate, cart, this._playerVel);
    }

    // Selected target distance readout (E5)
    if (sel && distKm !== undefined) {
      ctx.save();
      ctx.globalAlpha = alpha;  // steady opacity, not pulsing
      ctx.font = '9px monospace';
      ctx.fillStyle = C.selected;
      ctx.textAlign = 'left';
      const label = distKm < 1 ? `${(distKm * 1000).toFixed(0)}m` : `${distKm.toFixed(1)}km`;
      ctx.fillText(label, sx + drawSize + 4, sy + 3);
      ctx.restore();
    }

    ctx.globalAlpha = 1;
  }

  /**
   * Draw a debris contact shape based on type (E1).
   * defunctSat → diamond ◆, rocketBody → rectangle ■,
   * missionDebris → triangle ▲, fragment/default → circle ●
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} sx - screen x
   * @param {number} sy - screen y
   * @param {string} type - debris type (fragment/rocketBody/defunctSat/missionDebris)
   * @param {number} size - shape radius in px
   * @param {string} color - fill color
   * @param {number} alpha - 0–1 opacity
   */
  _drawContactShape(ctx, sx, sy, type, size, color, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;

    switch (type) {
      case 'defunctSat':
        // Diamond ◆
        ctx.beginPath();
        ctx.moveTo(sx, sy - size);
        ctx.lineTo(sx + size, sy);
        ctx.lineTo(sx, sy + size);
        ctx.lineTo(sx - size, sy);
        ctx.closePath();
        ctx.fill();
        break;

      case 'rocketBody':
        // Rectangle ■
        ctx.fillRect(sx - size * 0.7, sy - size, size * 1.4, size * 2);
        break;

      case 'missionDebris':
        // Triangle ▲
        ctx.beginPath();
        ctx.moveTo(sx, sy - size);
        ctx.lineTo(sx + size, sy + size * 0.7);
        ctx.lineTo(sx - size, sy + size * 0.7);
        ctx.closePath();
        ctx.fill();
        break;

      default:
        // Circle ● (fragments, generic)
        ctx.beginPath();
        ctx.arc(sx, sy, size, 0, Math.PI * 2);
        ctx.fill();
        break;
    }
    ctx.restore();
  }

  /** Draw an active satellite dot with distance encoding. */
  _drawSatDot(ctx, cx, cy, R, sat, playerPos) {
    this._tmpDir.subVectors(sat.position, playerPos);
    const { sx, sy, z, distKm, clipped } = this._toSphereWithDistance(this._tmpDir, cx, cy, R);
    // After _toSphereWithDistance, _tmpDir is normalized (direction only)

    // Bidirectional stalk (depth encoding: z > 0 → up, z < 0 → down) (ST-5.4)
    this._drawStalk(ctx, cx, cy, R, this._tmpDir, sx, sy, z, C.white, distKm);

    // Continuous dot size: closer = bigger
    const NS = Constants.NAVSPHERE;
    const tVal = Math.min(distKm / (this._outerZoneKm || NS.OUTER_ZONE_KM_MAX), 1);
    const dotSz = Math.max(3, NS.DOT_MAX_PX - tVal * (NS.DOT_MAX_PX - NS.DOT_MIN_PX));

    ctx.globalAlpha = z > 0 ? 0.8 : 0.3;
    ctx.beginPath();
    ctx.arc(sx, sy, dotSz, 0, Math.PI * 2);
    ctx.fillStyle = C.white;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  /**
   * Draw a bidirectional I-War stalk from a contact dot.
   * Encodes out-of-plane depth: z > 0 → stalk UP (above plane), z < 0 → stalk DOWN.
   * Length proportional to |z| × R × STALK_MAX_FRACTION (ST-5.4).
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} cx   Sphere center X (unused, kept for API compat)
   * @param {number} cy   Sphere center Y (unused, kept for API compat)
   * @param {number} R    Sphere radius
   * @param {THREE.Vector3} dir  Direction (unused, kept for API compat)
   * @param {number} sx   Dot screen X
   * @param {number} sy   Dot screen Y
   * @param {number} z    Camera-space depth (positive = front hemisphere)
   * @param {string} color  CSS color string for the stalk
   * @param {number} distKm  Distance in km (unused, kept for API compat)
   */
  _drawStalk(ctx, cx, cy, R, dir, sx, sy, z, color, distKm) {
    const NS = Constants.NAVSPHERE;
    const stalkLen = Math.abs(z) * R * NS.STALK_MAX_FRACTION;
    if (stalkLen < 0.5) return; // skip tiny stalks

    // z > 0 (front hemisphere / above plane) → stalk UP on screen (negative dy)
    const stalkDy = _stalkDyForZ(z, R, NS.STALK_MAX_FRACTION);

    ctx.strokeStyle = color;
    ctx.lineWidth = NS.STALK_LINE_WIDTH;
    ctx.globalAlpha = NS.STALK_ALPHA;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx, sy + stalkDy);
    ctx.stroke();
    ctx.globalAlpha = 1.0;
  }

  // ==========================================================================
  // JELLYFISH VISUALIZATION — Tether rings, zone colors, arm tethers
  // ==========================================================================

  /**
   * Draw concentric tether range rings (jellyfish tentacle zones).
   * Uses _distToRadius for proper log-mapped ring radii.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} cx - Sphere center X
   * @param {number} cy - Sphere center Y
   * @param {number} R  - Sphere radius in px
   * @param {object} armManager - For deployed arm type detection
   */
  _drawTetherRings(ctx, cx, cy, R, armManager) {
    // Tether ranges in km
    const lassoKm = Constants.LASSO_RANGE / 1000;             // 0.2 km
    const spinnerKm = Constants.SPINNER_TETHER_LENGTH / 1000;  // 0.5 km
    const weaverKm = Constants.WEAVER_TETHER_LENGTH / 1000;    // 2.0 km

    // Convert to NavSphere pixel radius using distance encoding
    const lassoR = this._distToRadius(lassoKm, R);
    const spinnerR = this._distToRadius(spinnerKm, R);
    const weaverR = this._distToRadius(weaverKm, R);

    // Determine which arm types are deployed for pulse/brighten effect
    let hasLassoDeployed = false;
    let hasSpinnerDeployed = false;
    let hasWeaverDeployed = false;
    if (armManager && armManager.arms) {
      for (const arm of armManager.arms) {
        if (arm.state !== 'DOCKED' && arm.state !== 'EXPENDED') {
          if (arm.type === 'lasso') hasLassoDeployed = true;
          if (arm.type === 'spinner') hasSpinnerDeployed = true;
          if (arm.type === 'weaver') hasWeaverDeployed = true;
        }
      }
    }

    // Pulse effect for active arm types (subtle alpha oscillation)
    const pulse = 0.5 + 0.5 * Math.sin(this._time * 2);

    // ---- Zone fills (E6) — drawn BEFORE ring strokes ----
    ctx.globalAlpha = 1;

    // Lasso zone fill (center → lassoR) — white
    const lassoFillAlpha = hasLassoDeployed ? 0.12 : 0.06;
    ctx.beginPath();
    ctx.arc(cx, cy, lassoR, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 255, 255, ${lassoFillAlpha})`;
    ctx.fill();

    // Spinner zone fill (lassoR → spinnerR) — green
    const spinnerFillAlpha = hasSpinnerDeployed ? 0.08 : 0.04;
    this._drawZoneFill(ctx, cx, cy, lassoR, spinnerR,
      `rgba(0, 255, 136, ${spinnerFillAlpha})`);

    // Weaver zone fill (spinnerR → weaverR) — cyan
    const weaverFillAlpha = hasWeaverDeployed ? 0.06 : 0.03;
    this._drawZoneFill(ctx, cx, cy, spinnerR, weaverR,
      `rgba(0, 204, 255, ${weaverFillAlpha})`);

    // ---- Ring strokes (existing) ----

    // Draw Weaver ring (outermost, cyan)
    ctx.strokeStyle = Constants.NAVSPHERE_WEAVER_RING_COLOR;
    ctx.lineWidth = hasWeaverDeployed ? 1.5 + pulse * 0.5 : 1;
    ctx.globalAlpha = hasWeaverDeployed ? 0.3 + pulse * 0.15 : 0.15;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(cx, cy, weaverR, 0, Math.PI * 2);
    ctx.stroke();

    // Draw Spinner ring (middle, green)
    ctx.strokeStyle = Constants.NAVSPHERE_SPINNER_RING_COLOR;
    ctx.lineWidth = hasSpinnerDeployed ? 1.5 + pulse * 0.5 : 1;
    ctx.globalAlpha = hasSpinnerDeployed ? 0.35 + pulse * 0.15 : 0.2;
    ctx.beginPath();
    ctx.arc(cx, cy, spinnerR, 0, Math.PI * 2);
    ctx.stroke();

    // Draw Lasso ring (innermost, white, thin)
    ctx.strokeStyle = Constants.NAVSPHERE_LASSO_RING_COLOR;
    ctx.lineWidth = 0.5;
    ctx.globalAlpha = 0.25;
    ctx.beginPath();
    ctx.arc(cx, cy, lassoR, 0, Math.PI * 2);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.globalAlpha = 1.0;
  }

  /**
   * Draw an annular zone fill between two radii (E6).
   * Uses composite path with counter-clockwise inner arc to cut out center.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} cx - center x
   * @param {number} cy - center y
   * @param {number} innerR - inner radius
   * @param {number} outerR - outer radius
   * @param {string} fillColor - CSS fill color with alpha
   */
  _drawZoneFill(ctx, cx, cy, innerR, outerR, fillColor) {
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
    ctx.arc(cx, cy, innerR, 0, Math.PI * 2, true);  // counter-clockwise to cut out
    ctx.fillStyle = fillColor;
    ctx.fill();
  }

  /**
   * Get dot color based on closure rate or tether zone distance.
   * Closure rate takes priority; selected target always wins.
   * @param {number} distanceKm - Distance from mothership in km
   * @param {boolean} isSelected - Whether this is the selected target
   * @param {number} [closureRate] - Closure rate (negative = approaching)
   * @returns {string} CSS color string
   */
  _getZoneColor(distanceKm, isSelected, closureRate) {
    if (isSelected) return C.selected;

    const NS = Constants.NAVSPHERE;

    // Closure rate coloring takes priority over distance (E4)
    if (closureRate !== undefined && closureRate !== null) {
      if (closureRate < NS.CLOSURE_APPROACHING_THRESHOLD) {
        return NS.COLOR_APPROACHING;    // red — closing in
      } else if (closureRate > NS.CLOSURE_RECEDING_THRESHOLD) {
        return NS.COLOR_RECEDING;       // green — moving away
      } else {
        return NS.COLOR_ORBIT_CROSS;    // amber — orbit-crossing / same speed
      }
    }

    // Fallback to distance-based coloring (existing behavior)
    const lassoKm = Constants.LASSO_RANGE / 1000;             // 0.2 km
    const spinnerKm = Constants.SPINNER_TETHER_LENGTH / 1000;  // 0.5 km
    const weaverKm = Constants.WEAVER_TETHER_LENGTH / 1000;    // 2.0 km

    if (distanceKm <= lassoKm) return '#ffffff';        // white — instant grab range
    if (distanceKm <= spinnerKm) {
      const ratio = distanceKm / spinnerKm;
      if (ratio > 0.8) return '#ffcc00';                // yellow — window closing
      return '#00ff88';                                  // green — Spinner reach
    }
    if (distanceKm <= weaverKm) {
      const ratio = distanceKm / weaverKm;
      if (ratio > 0.9) return '#ff4444';                // red — about to leave
      if (ratio > 0.8) return '#ffcc00';                // yellow
      return '#00ccff';                                  // cyan — Weaver reach
    }
    return 'rgba(100, 120, 140, 0.4)';                  // dim gray — out of reach
  }

  /**
   * Draw arm tether lines from center to deployed arm positions (jellyfish tentacles).
   * Uses distance-encoded projection for arm endpoint positions.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} cx - Sphere center X
   * @param {number} cy - Sphere center Y
   * @param {number} R  - Sphere radius
   * @param {object} armManager
   * @param {THREE.Vector3} playerPos
   */
  _drawArmTetherLines(ctx, cx, cy, R, armManager, playerPos) {
    if (!armManager || !armManager.arms || !playerPos) return;

    for (const arm of armManager.arms) {
      // Only draw for deployed arms (not DOCKED or EXPENDED)
      if (arm.state === 'DOCKED' || arm.state === 'EXPENDED') continue;

      // Get arm position (THREE.Vector3 world position)
      const armPos = arm.position;
      if (!armPos) continue;

      // Direction from player to arm (NOT normalized — distance encoding needs length)
      this._tmpDir.copy(armPos).sub(playerPos);
      const dist = this._tmpDir.length();
      if (dist < 0.0000001) continue;

      // Project arm position using distance-encoded sphere projection
      const { sx: px, sy: py, z, distKm } = this._toSphereWithDistance(this._tmpDir, cx, cy, R);

      // Detached arms: pulsing red triangle (no tether line)
      if (arm.isDetached) {
        const pulse = 0.5 + 0.5 * Math.sin(this._time * 6); // fast pulse
        ctx.globalAlpha = 0.6 + 0.4 * pulse;

        // Draw triangle instead of circle (indicates untethered / warning)
        ctx.fillStyle = '#ff4444';
        ctx.beginPath();
        ctx.moveTo(px, py - 5);
        ctx.lineTo(px - 4, py + 3);
        ctx.lineTo(px + 4, py + 3);
        ctx.closePath();
        ctx.fill();

        // Pulsing red outline ring
        ctx.strokeStyle = '#ff4444';
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.3 + 0.4 * pulse;
        ctx.beginPath();
        ctx.arc(px, py, 7, 0, Math.PI * 2);
        ctx.stroke();

        // Label
        ctx.font = '8px monospace';
        ctx.fillStyle = '#ff6666';
        ctx.globalAlpha = 0.7;
        const label = arm.id ? arm.id.replace(/^(.).*-/, '$1') : '';
        ctx.fillText(label, px + 8, py + 3);

        ctx.globalAlpha = 1.0;
        continue; // skip tether line
      }

      // Choose color by arm type
      const color = arm.type === 'weaver' ? '#00ccff' : '#00ff88';
      const alphaBase = 0.5 + 0.2 * Math.sin(this._time * 3); // subtle pulse

      // Draw tether line from center to arm position
      ctx.strokeStyle = color;
      ctx.globalAlpha = alphaBase;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(px, py);
      ctx.stroke();

      // Draw arm dot (larger than debris dots)
      ctx.fillStyle = color;
      ctx.globalAlpha = Math.min(1.0, alphaBase + 0.3);
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fill();

      // Short label (e.g. "w1", "s2")
      ctx.font = '8px monospace';
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.6;
      const label = arm.id ? arm.id.replace(/^(.).*-/, '$1') : '';
      ctx.fillText(label, px + 6, py + 3);

      ctx.globalAlpha = 1.0;
    }
  }

  /**
   * Draw a velocity (closure) arrow from a contact dot (ST-5.4).
   * Arrow direction = on-sphere projection of relative velocity.
   * Arrow length ∝ closure rate, clamped to VELOCITY_ARROW_MAX_LENGTH_PX.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} sx  Dot screen X
   * @param {number} sy  Dot screen Y
   * @param {number} closureRate  Scalar closure rate (negative = approaching)
   * @param {object} cart  Target cartesian { position, velocity }
   * @param {object} playerVel  Player velocity { x, y, z }
   */
  _drawVelocityArrow(ctx, sx, sy, closureRate, cart, playerVel) {
    if (!playerVel || closureRate === null) return;

    const NS = Constants.NAVSPHERE;
    const absRate = Math.abs(closureRate);
    const pxLen = _arrowLengthPx(absRate, NS.VELOCITY_ARROW_MAX_KMS, NS.VELOCITY_ARROW_MAX_LENGTH_PX);
    if (pxLen < 0.3) return;

    // Relative velocity direction (target − player)
    const rvx = (cart.velocity?.x || 0) - playerVel.x;
    const rvy = (cart.velocity?.y || 0) - playerVel.y;
    const rvz = (cart.velocity?.z || 0) - playerVel.z;

    // Project onto sphere screen axes (camera right / up)
    const adx = this._right.x * rvx + this._right.y * rvy + this._right.z * rvz;
    const ady = -(this._up.x * rvx + this._up.y * rvy + this._up.z * rvz);
    const adLen = Math.sqrt(adx * adx + ady * ady);
    if (adLen < 1e-8) return;

    const ndx = adx / adLen;
    const ndy = ady / adLen;
    const ex = sx + ndx * pxLen;
    const ey = sy + ndy * pxLen;

    ctx.save();
    ctx.strokeStyle = C.selected;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.8;

    // Arrow shaft
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();

    // Arrowhead (simple V at tip)
    const angle = Math.atan2(ndy, ndx);
    const headLen = Math.min(pxLen * 0.5, 2);
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - headLen * Math.cos(angle - 0.5), ey - headLen * Math.sin(angle - 0.5));
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - headLen * Math.cos(angle + 0.5), ey - headLen * Math.sin(angle + 0.5));
    ctx.stroke();

    ctx.restore();
  }

  // --------------------------------------------------------------------------
  // SIBLING ARM MARKERS (ST-8.5.2)
  // --------------------------------------------------------------------------

  /**
   * Draw amber diamond markers for deployed sibling arms during ARM_PILOT mode.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} cx   Sphere center X
   * @param {number} cy   Sphere center Y
   * @param {number} R    Sphere radius px
   * @param {object} armManager
   * @param {THREE.Vector3} playerPos
   * @param {string} pilotedArmId  ID of the currently piloted arm
   */
  _drawSiblingArmMarkers(ctx, cx, cy, R, armManager, playerPos, pilotedArmId) {
    if (!armManager || !armManager.arms || !playerPos) return;

    for (const arm of armManager.arms) {
      // Skip docked, expended, and the currently piloted arm
      if (arm.state === 'DOCKED' || arm.state === 'EXPENDED') continue;
      if (arm.id === pilotedArmId) continue;

      const armPos = arm.position;
      if (!armPos) continue;

      this._tmpDir.copy(armPos).sub(playerPos);
      const dist = this._tmpDir.length();
      if (dist < 0.0000001) continue;

      const { sx: px, sy: py } = this._toSphereWithDistance(this._tmpDir, cx, cy, R);

      // Amber diamond marker
      const size = 5;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = '#ffaa00';
      ctx.globalAlpha = 0.85;
      ctx.fillRect(-size / 2, -size / 2, size, size);
      ctx.strokeStyle = '#ffcc44';
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.5;
      ctx.strokeRect(-size / 2, -size / 2, size, size);
      ctx.restore();

      // Arm label
      ctx.font = '8px monospace';
      ctx.fillStyle = '#ffaa00';
      ctx.globalAlpha = 0.7;
      const label = arm.id ? arm.id.replace(/^(.).*-/, '$1') : '';
      ctx.fillText(label, px + 7, py + 3);
      ctx.globalAlpha = 1.0;
    }
  }

  /** Remove canvas from DOM. */
  dispose() {
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
  }
}

// Node.js / CJS exports for testing (no DOM/Canvas dependencies)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    _eciToGeodetic, _eciToGeodeticWithGMST,
    _stalkDyForZ, _arrowLengthPx, _sortContactsSelectedLast
  };
}

export default NavSphere;
