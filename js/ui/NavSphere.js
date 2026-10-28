/**
 * NavSphere.js — 3D radar sphere HUD element (after the Nav Sphere in Independence War, 1997).
 * Projects all contacts onto a 2D circle for 360° situational awareness; distance is encoded by a hybrid
 * logarithmic dual-zone mapping.
 *
 * The minimized state IS the ORB footer chip (inboard of the SPECS tab). Rung show lands in the chip; chip tap / 8
 * expands the disc bottom-right above the footer. getReservedHeight() is deprecated (always 0 — HUD.js no longer
 * reads a column slot).
 * @module ui/NavSphere
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { VisualLaw } from '../core/VisualLaw.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { GameStates } from '../core/GameState.js';
import { orbitToSceneCartesian } from '../entities/OrbitalMechanics.js';
import { gmstDeg } from '../scene/Ephemeris.js';
import { prefersReducedMotion } from './hudPulse.js';
import { mono } from '../core/Typeface.js';
import { HUD_EDGE_PX, RAIL_GEOMETRY, footerBand } from './RailGeometry.js';
import { createFooterChip, leftOfSliderCss, leftOfSliderBasePx, ORB_CHIP_WIDTH_PX } from './hud/FooterChip.js';
import { isMarked } from '../systems/ScanMarks.js';
import { testsRequestedHere } from './hud/TestsSwitch.js';
import { isShortScreen } from './hud/PhoneFold.js';
import { degToRad, radToDeg, clamp } from '../core/MathUtil.js';

const SPHERE_RADIUS = 140;         // px radius — diameter 280 matches targets panel width

/**
 * ORB chip `right` offset: one gap left of the DETAIL slider (bottom right), so the chip never sits on it. Scale 1 value;
 * the live CSS is {@link ORB_CHIP_RIGHT_CSS} (the slider grows with `--hud-scale`).
 */
export const ORB_CHIP_OFFSET_PX = leftOfSliderBasePx(0);
export const ORB_CHIP_RIGHT_CSS = leftOfSliderCss(0);
export const ORB_CHIP_ID = 'hud-chip-orb';

/**
 * Expanded-disc centre: bottom-right above the footer band. cy = H − footerTop − 8 − R; cx = W − HUD_EDGE_PX − R.
 * @param {{width:number, height:number, radius?:number, footerTop:number, edgePx?:number}} p
 */
export function orbDiscCenter({ width, height, radius = SPHERE_RADIUS, footerTop, edgePx = HUD_EDGE_PX }) {
  return {
    cx: width - edgePx - radius,
    cy: height - footerTop - RAIL_GEOMETRY.FOOTER_GAP_PX - radius,
  };
}

/** Smallest / largest corner-orb radius on a short screen (px). */
const SHORT_ORB_MIN_PX = 40;
const SHORT_ORB_MAX_PX = 84;
/** Gap between the right column's last box and the orb disc (px). */
export const SHORT_ORB_GAP_PX = 8;

/**
 * The corner orb's disc on a SHORT screen (height < 500): its right edge stays at W - 16 and it sits under the right
 * column (comms, NEXT) instead of over it. r fits the room left above the bottom margin, clamped 40..84. Pure.
 * @param {{W:number, H:number, top:number}} p  top = the disc's top edge (bottom of the lowest right-column
 *   box + SHORT_ORB_GAP_PX)
 * @returns {{cx:number, cy:number, r:number}}
 */
export function shortScreenOrbDisc({ W, H, top }) {
  const r = Math.min(SHORT_ORB_MAX_PX, Math.max(SHORT_ORB_MIN_PX, Math.floor((H - 8 - top) / 2)));
  return { cx: W - HUD_EDGE_PX - r, cy: top + r, r };
}

/** @enum {string} Color palette */
const C = {
  bg:       'rgba(0, 20, 40, 0.6)',
  grid:     'rgba(0, 255, 136, 0.15)',
  gridEdge: 'rgba(0, 255, 136, 0.25)',
  player:   '#ffffff',
  earth:    'rgba(0, 120, 255, 0.5)',
  earthDim: 'rgba(0, 80, 180, 0.25)',
  sun:      '#ffcc00',
  prograde: VisualLaw.COLORS.PLAYER,
  selected: VisualLaw.COLORS.INFO,
  geo:      'rgba(80, 170, 255, 0.95)', // LAT/LON/ALT readout — blue, clearly tied to the NavSphere
  green:    VisualLaw.COLORS.PLAYER,
  yellow:   '#ffcc00',
  red:      '#ff4444',
  white:    '#ffffff',
};

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
 * ECI → WGS-84 geodetic with explicit GMST. Game frame: Y = polar axis, XZ = equatorial plane.
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
  return { lat: radToDeg(lat), lon: radToDeg(Math.atan2(ze, xe)), alt };
}

/**
 * ECI → WGS-84 geodetic using Date.now() for GMST (no sim-epoch in GameState; approximate, but the visible LAT/LON drift is
 * correct). GMST comes from scene/Ephemeris.js, the source the real-clock sky seeding uses, so readouts and sky stay in lockstep.
 */
function _eciToGeodetic(x, y, z) {
  const jd = Date.now() / 86400000 + 2440587.5;
  const gmst = degToRad(gmstDeg(jd - 2451545.0));
  return _eciToGeodeticWithGMST(x, y, z, gmst);
}

export class NavSphere {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {{glass?:boolean, hintBandPx?:number, doc?:Document, win?:Window}} [opts]
   */
  constructor(camera, { glass = false, hintBandPx, doc, win } = {}) {
    this.camera = camera;
    this._doc = doc || (typeof document !== 'undefined' ? document : null);
    this._win = win || (typeof window !== 'undefined' ? window : null);
    const ticker = (Constants.ONBOARDING && Constants.ONBOARDING.TICKER) || {};
    this._hintBandPx = Number.isFinite(Number(hintBandPx))
      ? Number(hintBandPx)
      : ((Number(ticker.BOTTOM_PX) || 0) + (Number(ticker.ROW_HEIGHT_PX) || 0));
    this._glass = !!glass;
    this._band = footerBand({ glass: this._glass, hintBandPx: this._hintBandPx });
    this._footerTop = this._band.top;
    this._chip = null;

    /** @type {HTMLCanvasElement} */
    this.canvas = null;
    /** @type {CanvasRenderingContext2D} */
    this.ctx = null;
    this._width = 0;
    this._height = 0;

    this._visible = true;
    this._hidden = true;                 // off by default — press 8 to bring the nav orb up
    this._minimized = false;             // 9-key style minimize → lat/lon/alt one-liner (8 key)
    this._time = 0;
    this._selectedTargetId = null;
    this._frameSkip = -1;  // Throttle counter for Canvas2D redraws (10Hz at 60fps)
    this._geoDrawCount = 0;              // Separate frame counter for 2 Hz geo readout
    this._geoCache = null;               // { lat, lon, alt } refreshed at 2 Hz
    this.testsSwitch = testsRequestedHere();   // u6 D3: the LAT/LON/ALT line is a Tests-switch extra; read once, tests may set it

    // Dynamic sensor range (km) — updated each frame from SensorSystem
    this._outerZoneKm = Constants.NAVSPHERE.OUTER_ZONE_KM_MAX;
    this._playerVel = null;

    this._right   = new THREE.Vector3();
    this._up      = new THREE.Vector3();
    this._forward = new THREE.Vector3();
    this._tmpDir  = new THREE.Vector3();
    this._eqDir   = new THREE.Vector3();  // reusable for equatorial projection

    // Zoom Ladder PROX NET (id 3) additive opts; null by default ⇒ shipped paths unchanged. While CORNER-MOUNTED
    // (ProxMiniSphere.mount) the sphere shrinks in place to this radius and the layer is FORCED ON; the manual 8-key hold and
    // the minimized one-liner are suspended, not overwritten (their flags survive for the unmount).
    /** @type {number|null} corner-minimap radius (px), null = unmounted */
    this._cornerMountRadiusPx = null;
    /** @type {(() => (number|null))|null} bottom of the right column's lowest box (short-screen clearance) */
    this._cornerTopProvider = null;
    // Floor-fed tactical layer drawn over the radar (see ProxMiniSphere).
    /** @type {{clusterPos:?{x,y,z}, clusterName:?string, insertionPos:?{x,y,z}, insertionZone:?string}|null} */
    this._tacticalOverlay = null;

    this._createCanvas();
    this._createOrbChip();
    this._onResize();
    if (this._win && typeof this._win.addEventListener === 'function') {
      this._win.addEventListener('resize', () => {
        this._onResize();
      });
    }

    // Self-manage visibility via EventBus (decoupled from GameFlowManager)
    eventBus.on(Events.VIEW_CONFIG_CHANGE, (config) => {
      if (config.showNavSphere !== undefined) this.setVisible(config.showNavSphere);
    });
    eventBus.on(Events.GAME_STATE_CHANGE, ({ to }) => {
      const gameplay = (to === GameStates.ORBITAL_VIEW || to === GameStates.APPROACH || to === GameStates.INTERACTION);
      if (!gameplay) this.setVisible(false);
    });
    // Held off by default so players aren't faced with the radar before choosing to bring it up (8 key, toggleMinimized); the
    // choice persists across missions. `_hidden` is honoured by setVisible(), so the view config's showNavSphere:true can't
    // override the manual hold. This listener only refreshes canvas state on a mission boundary without forcing the orb back on.
    eventBus.on(Events.MISSION_START, () => {
      this._frameSkip = -1;
      this._syncCanvasDisplay();
      this._syncChip();
    });
    eventBus.on(Events.HUD_TARGET_CLICK, (data) => {
      this.setSelectedTarget(data.id);
    });
  }

  /** @private */
  _createCanvas() {
    const doc = this._doc;
    if (!doc || typeof doc.createElement !== 'function') return;
    this.canvas = doc.createElement('canvas');
    this.canvas.id = 'navsphere-canvas';
    const s = this.canvas.style;
    s.position = 'fixed';
    s.top = '0';
    s.left = '0';
    s.width = '100%';
    s.height = '100%';
    s.pointerEvents = 'none';
    s.zIndex = '9';
    s.display = 'none';
    if (doc.body && typeof doc.body.appendChild === 'function') doc.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext ? this.canvas.getContext('2d') : null;
  }

  /** @private ORB footer chip — minimized state. */
  _createOrbChip() {
    const doc = this._doc;
    if (!doc || typeof doc.createElement !== 'function') return;
    this._chip = createFooterChip({
      id: ORB_CHIP_ID,
      label: 'Orb',
      side: 'right',
      offsetPx: ORB_CHIP_RIGHT_CSS,
      minWidthPx: ORB_CHIP_WIDTH_PX,
      onTap: () => this.toggleMinimized(),
      doc,
      bottomPx: this._band.bottom,
      glass: this._glass,
      hintBandPx: this._hintBandPx,
    });
    this._syncChip();
  }

  /** @private */
  _syncCanvasDisplay() {
    if (!this.canvas || !this.canvas.style) return;
    if (this._cornerMountRadiusPx != null) {
      this.canvas.style.display = 'block';
      return;
    }
    const showDisc = !this._hidden && this._visible && !this._minimized;
    this.canvas.style.display = showDisc ? 'block' : 'none';
  }

  /** @private */
  _syncChip() {
    if (!this._chip) return;
    this._chip.setVisible(!this._hidden && this._visible);
    this._chip.setExpanded(!this._hidden && this._visible && !this._minimized);
  }

  /** @private */
  _onResize() {
    if (!this.canvas) return;
    const win = this._win;
    const dpr = Math.min((win && win.devicePixelRatio) || 1, 2);
    this.dpr = dpr;
    this._width  = (win && win.innerWidth) || 0;
    this._height = (win && win.innerHeight) || 0;
    this.canvas.width  = this._width  * dpr;
    this.canvas.height = this._height * dpr;
    this.canvas.style.width  = this._width  + 'px';
    this.canvas.style.height = this._height + 'px';
    if (this.ctx && typeof this.ctx.setTransform === 'function') {
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.imageSmoothingQuality = 'high';
    }
  }

  /** @param {boolean} visible */
  setVisible(visible) {
    this._visible = visible;
    this._frameSkip = -1; // Reset throttle so next update draws immediately
    if (this._hidden) return; // respect manual toggle
    this._syncCanvasDisplay();
    this._syncChip();
  }

  /**
   * Clean public toggle — wraps toggleVisibility(); InputManager Shift+N prefers this over toggleVisibility(), which manages
   * the _hidden flag.
   */
  toggle() { this.toggleVisibility(); }

  toggleVisibility() {
    this._hidden = !this._hidden;
    this._frameSkip = -1;
    this._syncCanvasDisplay();
    this._syncChip();
  }

  /**
   * Chip / disc toggle (the 8 key). Minimized = ORB chip; expanded draws the disc bottom-right above the footer. First press
   * while hidden re-reveals (HUD_PANE_VISIBILITY) and expands.
   */
  toggleMinimized() {
    if (!this.canvas && !this._chip) return;
    let shown;
    // If the orb is held off (default, a prior manual hide, or hidden by the pane-density ladder via setOrbHidden), the first
    // 8 press brings it up instead of collapsing a hidden orb. Later presses expand/collapse the disc.
    if (this._hidden) {
      this._hidden = false;
      this._minimized = false;
      this._frameSkip = -1;
      shown = true;
      // The un-hide path flips `_hidden` — the intent flag isOrbVisible() reads (the rung's bit). The minimize fold below never
      // touches it, so only THIS path signals (after the flip).
      eventBus.emit(Events.HUD_PANE_VISIBILITY, { pane: 'navsphere', shown: true });
    } else {
      this._minimized = !this._minimized;
      this._frameSkip = -1; // redraw immediately on the next frame
      shown = !this._minimized;
    }
    this._syncCanvasDisplay();
    this._syncChip();
    // Reactive feedback for the 8 key (never suppressed — see commsSuppression).
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: shown ? 'Nav orb shown (8 to hide)' : 'Nav orb hidden (8 to show)',
      priority: 'info',
      _reactive: true,
    });
  }

  get isMinimized() { return this._minimized; }

  /**
   * Pane-density ladder — is the orb currently ON (chip or disc showing)? Reads the same `_hidden` flag the 8 key drives, so
   * an individual 8 press re-reveals a density-hidden orb.
   */
  isOrbVisible() { return !this._hidden; }

  /**
   * Pane-density ladder — show/hide the orb by driving the manual `_hidden` flag (NOT the view-config `_visible` flag), so the
   * density hide survives a camera-view switch and the 8 key can re-reveal it. SHOW lands in the CHIP; HIDE collapses the
   * disc and hides chip + canvas.
   * @param {boolean} hidden
   */
  setOrbHidden(hidden) {
    this._hidden = !!hidden;
    this._minimized = true;
    this._frameSkip = -1;
    this._syncCanvasDisplay();
    this._syncChip();
  }

  /**
   * @deprecated The orb no longer occupies a right-column slot; HUD.js stops reading this. Always 0.
   * @returns {number} px
   */
  getReservedHeight() {
    return 0;
  }

  /** @param {number|null} id */
  setSelectedTarget(id) { this._selectedTargetId = id; }

  /**
   * Zoom Ladder PROX NET corner-minimap mount (FloorContract.FLOORS[4].costume 'NavSphere:corner-minimap'). While mounted the
   * sphere draws at `radiusPx` in the bottom-right corner (where the 8-key disc sits), the canvas is forced visible
   * (`_hidden`/`_minimized` suspended but PRESERVED, so the player's 8-key state resumes on unmount) and the [8] badge is
   * suppressed. Pass null to unmount. Never called by shipped code paths (ProxMiniSphere only).
   * @param {number|null} radiusPx
   */
  setCornerMount(radiusPx) {
    this._cornerMountRadiusPx = (radiusPx > 0) ? radiusPx : null;
    this._frameSkip = -1; // redraw at the new geometry on the next frame
    this._syncCanvasDisplay();
    this._syncChip();
  }

  /**
   * Where the right column's lowest box ends (px), asked of the HUD at each draw; null/absent → the standard disc.
   * Only the corner mount on a short screen reads it.
   * @param {(() => (number|null))|null} fn
   */
  setCornerTopProvider(fn) {
    this._cornerTopProvider = (typeof fn === 'function') ? fn : null;
  }

  /**
   * @private The disc this draw uses: orbDiscCenter at the mount radius (or SPHERE_RADIUS), except a corner mount on a short
   * screen with a column-bottom provider, which clears the right column (shortScreenOrbDisc).
   * @returns {{cx:number, cy:number, r:number}}
   */
  _discGeometry() {
    const mounted = this._cornerMountRadiusPx != null;
    if (mounted && this._cornerTopProvider && isShortScreen(this._height)) {
      const bottom = this._cornerTopProvider();
      if (Number.isFinite(bottom)) {
        return shortScreenOrbDisc({ W: this._width, H: this._height, top: bottom + SHORT_ORB_GAP_PX });
      }
    }
    const r = mounted ? this._cornerMountRadiusPx : SPHERE_RADIUS;
    const { cx, cy } = orbDiscCenter({
      width: this._width, height: this._height, radius: r,
      footerTop: this._footerTop, edgePx: HUD_EDGE_PX,
    });
    return { cx, cy, r };
  }

  /**
   * PROX NET floor-fed tactical layer (see ProxMiniSphere): focused cluster bearing + selected insertion point, drawn by update()
   * over the radar contacts. Stored by reference (the adapter mutates ONE reused object; no per-frame stores). Null ⇒ nothing extra.
   * @param {{clusterPos:?{x,y,z}, clusterName:?string, insertionPos:?{x,y,z}, insertionZone:?string}|null} overlay
   */
  setTacticalOverlay(overlay) {
    this._tacticalOverlay = overlay || null;
  }

  /**
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
    // Corner-mounted (PROX NET): the mount suspends the manual hold; the flags keep the player's choice for unmount.
    if (this._hidden && this._cornerMountRadiusPx == null) return;
    // Self-heal the forced display against flag-driven hides (setVisible/setOrbHidden/toggleMinimized write display directly;
    // while mounted the mount owns the layer). Style write only when it differs.
    if (this._cornerMountRadiusPx != null && this.canvas
        && this.canvas.style.display !== 'block') {
      this.canvas.style.display = 'block';
    }
    this._time += dt;

    // Throttle Canvas2D redraws to every 6th frame (≈10Hz at 60fps)
    this._frameSkip++;
    if (this._frameSkip % 6 !== 0) return;

    this.ctx.clearRect(0, 0, this._width, this._height);
    if (!this._visible || !data || !data.playerPos) return;

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

    // Minimized (8 key): the ORB chip is the minimized state — disc not drawn (suspended while corner-mounted: the minimap
    // always draws).
    if (this._minimized && this._cornerMountRadiusPx == null) {
      return;
    }

    const { playerPos, playerVel, debrisField, activeSatellites,
            sunDirection, targetSelector, sensorSystem, armManager } = data;

    if (sensorSystem && sensorSystem.range) {
      this._outerZoneKm = sensorSystem.range / Constants.SCENE_SCALE;
    } else {
      this._outerZoneKm = Constants.NAVSPHERE.OUTER_ZONE_KM_MAX;
    }

    this._playerVel = playerVel || null;

    if (targetSelector) {
      const at = targetSelector.getActiveTarget();
      if (at) this._selectedTargetId = at.id;
    }

    this.camera.updateMatrixWorld();
    const m = this.camera.matrixWorld;
    this._right.setFromMatrixColumn(m, 0);
    this._up.setFromMatrixColumn(m, 1);
    this._forward.setFromMatrixColumn(m, 2).negate();

    // Sphere center: bottom-right above the footer band, where the 8-key disc sits (cx = W − HUD_EDGE_PX − R,
    // cy = H − footerTop − 8 − R). Corner-mounted PROX NET uses the same spot at its smaller radius, so it never depends on the
    // COMMS height and can't cover the NEXT pane; on a short screen it sits under the right column (see _discGeometry).
    const { cx, cy, r: R } = this._discGeometry();
    const ctx = this.ctx;

    ctx.save();

    const bgGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    bgGrad.addColorStop(0, 'rgba(0, 40, 80, 1.0)');
    bgGrad.addColorStop(0.7, 'rgba(0, 25, 50, 1.0)');
    bgGrad.addColorStop(1, 'rgba(0, 10, 30, 1.0)');
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = bgGrad;
    ctx.fill();

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

    const gridCol = 'rgba(0, 150, 255, 0.15)';
    ctx.lineWidth = 0.5;

    for (const deg of [-60, -30, 0, 30, 60]) {
      const phi = degToRad(deg);
      const rX = Math.abs(R * Math.sin(phi));
      ctx.strokeStyle = gridCol;
      ctx.beginPath();
      if (rX < 1) {
        ctx.moveTo(cx, cy - R);
        ctx.lineTo(cx, cy + R);
      } else {
        ctx.ellipse(cx, cy, rX, R * 0.92, 0, 0, Math.PI * 2);
      }
      ctx.stroke();
    }

    for (const f of [-0.5, 0, 0.5]) {
      const yOff = f * R;
      const halfW = R * Math.sqrt(1 - f * f);
      const rY = halfW * 0.18 * (1 - Math.abs(f) * 0.5);
      ctx.strokeStyle = gridCol;
      ctx.beginPath();
      ctx.ellipse(cx, cy + yOff, halfW * 0.92, Math.max(rY, 1.5), 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    this._drawRangeRings(ctx, cx, cy, R);

    this._drawTetherRings(ctx, cx, cy, R, armManager);

    this._drawIndicator(ctx, cx, cy, R,
      playerPos.clone().negate().normalize(),
      C.earth, C.earthDim, 12, 'E');

    if (sunDirection) {
      this._drawIndicator(ctx, cx, cy, R,
        sunDirection.clone().normalize(),
        C.sun, C.sun, 5, null, 0.9, 0.35);
    }

    if (playerVel) {
      const v = new THREE.Vector3(playerVel.x, playerVel.y, playerVel.z);
      if (v.lengthSq() > 1e-8) {
        v.normalize();
        const { sx, sy, z } = this._toSphere(v, cx, cy, R);
        const a = z > 0 ? 0.9 : 0.35;
        ctx.globalAlpha = a;
        ctx.strokeStyle = C.prograde;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(sx, sy, 6, 0, Math.PI * 2);
        ctx.stroke();
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
        // Scan-first (DECISIONS §15 row 1): no radar dot until a scan reveals it.
        if (!isMarked(t)) continue;
        // Skip untracked debris unless IR Scanner is active or it's the selected target. A background shard 10 cm or bigger is
        // `tracked` (known to radar) but still scenery, never a contact: dotted only where an untracked shard always was (IR scanner).
        if ((t.tracked === false || t.hazard === true) && !canDetect && t.id !== this._selectedTargetId) continue;
        if (t.id === this._selectedTargetId) {
          _selectedDebrisTarget = t;  // defer to draw last (on top)
          continue;
        }
        this._drawDebrisDot(ctx, cx, cy, R, t, playerPos);
      }
    }

    this._drawArmTetherLines(ctx, cx, cy, R, armManager, playerPos);

    // ---- Sibling arm markers (ARM_PILOT mode — ST-8.5.2) ----
    if (data.pilotedArmId) {
      this._drawSiblingArmMarkers(ctx, cx, cy, R, armManager, playerPos, data.pilotedArmId);
    }

    if (activeSatellites) {
      const sats = activeSatellites.getSatelliteList(playerPos);
      for (const s of sats) {
        if (s.distance / Constants.SCENE_SCALE > this._outerZoneKm) continue;
        this._drawSatDot(ctx, cx, cy, R, s, playerPos);
      }
    }

    // PROX NET tactical overlay (null ⇒ skipped; see setTacticalOverlay). Drawn before the selected target + player dot so the
    // actionables stay on top.
    if (this._tacticalOverlay) {
      this._drawTacticalOverlay(ctx, cx, cy, R, playerPos);
    }

    // ---- Selected target drawn LAST (painter's order — on top of all others) ----
    if (_selectedDebrisTarget) {
      this._drawDebrisDot(ctx, cx, cy, R, _selectedDebrisTarget, playerPos);
    }

    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = C.player;
    ctx.fill();

    ctx.restore(); // remove clip

    // ---- Rim / edge glow (drawn outside clip so full stroke is visible) ----
    ctx.strokeStyle = 'rgba(0, 150, 255, 0.12)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0, 150, 255, 0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();

    // Geolocation readout (LAT / LON / ALT) above the disc; drawn only with the Tests switch on.
    if (this._geoCache && this.testsSwitch) {
      const geo = this._geoCache;
      ctx.font = mono(10);
      ctx.fillStyle = C.geo;
      ctx.textAlign = 'center';
      const latStr = `${geo.lat >= 0 ? '+' : ''}${geo.lat.toFixed(1)}\u00B0`;
      const lonStr = `${geo.lon >= 0 ? '+' : ''}${geo.lon.toFixed(1)}\u00B0`;
      const altStr = `${Math.round(geo.alt)}`;
      const geoText = `LAT ${latStr}  LON ${lonStr}  ALT ${altStr} km`;
      // Centred on the ball, but never past the right screen edge (84 px corner ball).
      const geoX = Math.min(cx, this._width - HUD_EDGE_PX - ctx.measureText(geoText).width / 2);
      ctx.fillText(geoText, geoX, cy - R - 14);
    }

    // HIGH RECOIL warning: amber when the selected arm's aim alpha is in the high-recoil zone (α < 30° or α > 150°, near
    // stowed/zenith where cos(α) ≈ ±1 → max residual torque)
    if (armManager && armManager.selectedArmIndex >= 0) {
      const selArm = armManager.arms[armManager.selectedArmIndex];
      if (selArm && typeof selArm.isHighRecoilZone === 'function' && selArm.isHighRecoilZone()) {
        const warnY = cy - R - 8;
        ctx.font = mono(10, 'bold');
        ctx.fillStyle = '#ffcc00';
        ctx.textAlign = 'center';
        // Calm-HUD: steady amber — a standing state, not an event; the WARN word and amber already carry the warning.
        ctx.globalAlpha = 1;
        const warnX = Math.min(cx, this._width - HUD_EDGE_PX - ctx.measureText('WARN HIGH RECOIL').width / 2);
        ctx.fillText('WARN HIGH RECOIL', warnX, warnY);
      }
    }

    // [8] hotkey badge at the sphere's top-right corner (matches [7]/[0]); suppressed while corner-mounted (the minimap is the
    // floor costume, so the badge would advertise a suspended toggle).
    if (this._cornerMountRadiusPx == null) {
      this._drawKeyBadge(ctx, cx + R - 4, cy - R + 4);
    }

    ctx.restore();
  }

  /** @private Draw the `[8]` hotkey badge at the sphere's top-right corner, matching the [7]/[0] pane badges (dim green, right-aligned). */
  _drawKeyBadge(ctx, rightX, topY) {
    ctx.save();
    ctx.font = mono(10, 'bold');
    ctx.fillStyle = 'rgba(0,255,136,0.35)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText('[8]', rightX, topY);
    ctx.restore();
  }

  /**
   * @private PROX NET tactical overlay (drawn only when setTacticalOverlay() stored a descriptor). VisualLaw grammar, never
   * color-alone:
   *   - focused cluster bearing: VALUE-gold RING (the cluster 'ring-count' shape) + name label, distance-encoded via
   *     _toSphereWithDistance and clamped to the rim (the PROX NET corridor target usually sits beyond the sensor's outer zone);
   *   - selected insertion point: SELECTION-blue ring + cross-hair ticks + zone label (the ProxOverlay insertion grammar).
   * Behind-camera points dim to the house 0.4 alpha like every other contact.
   * @param {number} R  - sphere radius px (mount-resolved)
   */
  _drawTacticalOverlay(ctx, cx, cy, R, playerPos) {
    const ov = this._tacticalOverlay;
    if (!ov || !playerPos) return;
    const RIM = 0.92; // max fraction of R — keep markers inside the clip

    /** Project a world position; returns {sx, sy, z} clamped to the rim. */
    const projectClamped = (posU) => {
      this._tmpDir.set(posU.x - playerPos.x, posU.y - playerPos.y, posU.z - playerPos.z);
      if (this._tmpDir.lengthSq() < 1e-16) return null;
      const { sx, sy, z } = this._toSphereWithDistance(this._tmpDir, cx, cy, R);
      const dx = sx - cx, dy = sy - cy;
      const r = Math.sqrt(dx * dx + dy * dy);
      const max = R * RIM;
      if (r > max && r > 1e-6) {
        return { sx: cx + (dx / r) * max, sy: cy + (dy / r) * max, z };
      }
      return { sx, sy, z };
    };

    ctx.save();
    ctx.font = mono(10);

    // Focused cluster bearing — gold ring + name (cluster icon grammar).
    if (ov.clusterPos) {
      const p = projectClamped(ov.clusterPos);
      if (p) {
        ctx.globalAlpha = p.z > 0 ? 0.9 : 0.4;
        ctx.strokeStyle = VisualLaw.COLORS.VALUE; // gold (steady — never pulses)
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, 1.5, 0, Math.PI * 2);
        ctx.fillStyle = VisualLaw.COLORS.VALUE;
        ctx.fill();
        if (ov.clusterName) {
          ctx.textAlign = 'left';
          ctx.fillText(String(ov.clusterName), p.sx + 9, p.sy + 3);
        }
      }
    }

    // Selected insertion point — white ring + ticks + zone (selection ONLY).
    if (ov.insertionPos) {
      const p = projectClamped(ov.insertionPos);
      if (p) {
        ctx.globalAlpha = p.z > 0 ? 0.95 : 0.4;
        ctx.strokeStyle = VisualLaw.COLORS.SELECTION; // blue = selection (Session Q)
        ctx.lineWidth = 1.5;
        const r = 5;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(p.sx - r - 3, p.sy); ctx.lineTo(p.sx - r + 2, p.sy);
        ctx.moveTo(p.sx + r - 2, p.sy); ctx.lineTo(p.sx + r + 3, p.sy);
        ctx.stroke();
        if (ov.insertionZone) {
          ctx.fillStyle = VisualLaw.COLORS.SELECTION;
          ctx.textAlign = 'left';
          ctx.fillText(String(ov.insertionZone).toUpperCase(), p.sx + r + 4, p.sy + 3);
        }
      }
    }

    ctx.globalAlpha = 1;
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
      return Math.log(1 + distKm) / Math.log(1 + innerKm) * split * R;
    } else {
      const outerRange = outerKm - innerKm;
      const d = distKm - innerKm;
      return (Math.log(1 + d) / Math.log(1 + outerRange) * (1 - split) + split) * R;
    }
  }

  /**
   * Project a relative position vector to NavSphere screen coordinates (camera-space direction + distance-encoded radius).
   * @param {THREE.Vector3} relVec - relative position (NOT normalized)
   * @returns {{sx: number, sy: number, z: number, distKm: number, clipped: boolean}}
   */
  _toSphereWithDistance(relVec, cx, cy, R) {
    const distScene = relVec.length();
    const distKm = distScene / Constants.SCENE_SCALE;

    this._tmpDir.copy(relVec).normalize();

    const dx = this._tmpDir.dot(this._right);
    const dy = -this._tmpDir.dot(this._up);      // screen Y is inverted
    const z  = this._tmpDir.dot(this._forward);   // depth (positive = in front)

    const r = this._distToRadius(distKm, R);

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
   * Closure rate (km/s): negative = approaching, positive = receding.
   * @param {object} targetCart - {position: {x,y,z}, velocity: {x,y,z}} from orbitToSceneCartesian
   * @param {object} playerVel - {x,y,z}
   */
  _computeClosureRate(targetCart, playerPos, playerVel) {
    if (!playerVel) return null;

    const rx = targetCart.position.x - playerPos.x;
    const ry = targetCart.position.y - playerPos.y;
    const rz = targetCart.position.z - playerPos.z;
    const dist = Math.sqrt(rx * rx + ry * ry + rz * rz);
    if (dist < 1e-10) return 0;

    const ux = rx / dist;
    const uy = ry / dist;
    const uz = rz / dist;

    const tvx = (targetCart.velocity?.x || 0) - playerVel.x;
    const tvy = (targetCart.velocity?.y || 0) - playerVel.y;
    const tvz = (targetCart.velocity?.z || 0) - playerVel.z;

    // Closure rate = dot(relative velocity, unit direction); negative = approaching
    return tvx * ux + tvy * uy + tvz * uz;
  }

  /**
   * Project a direction vector (normalized or not, e.g. equatorial projections for stalks) onto sphere screen coords;
   * for direction-only indicators (Earth, Sun, Prograde, velocity).
   * @returns {{ sx: number, sy: number, z: number }}
   */
  _toSphere(dir, cx, cy, R) {
    const x = dir.dot(this._right);
    const y = dir.dot(this._up);
    const z = dir.dot(this._forward);
    return { sx: cx + x * R * 0.85, sy: cy - y * R * 0.85, z };
  }

  _drawIndicator(ctx, cx, cy, R, dir, colFront, colBack, size, label,
                  aFront = 1, aBack = 0.4) {
    const { sx, sy, z } = this._toSphere(dir, cx, cy, R);
    ctx.globalAlpha = z > 0 ? aFront : aBack;
    ctx.beginPath();
    ctx.arc(sx, sy, size, 0, Math.PI * 2);
    ctx.fillStyle = z > 0 ? colFront : colBack;
    ctx.fill();
    if (label) {
      ctx.font = mono(10);
      ctx.fillStyle = 'rgba(100,180,255,0.8)';
      ctx.textAlign = 'center';
      ctx.fillText(label, sx, sy + 3);
    }
    ctx.globalAlpha = 1;
  }

  /** Labeled concentric range rings at key distances, log-mapped via _distToRadius. */
  _drawRangeRings(ctx, cx, cy, R) {
    const NS = Constants.NAVSPHERE;
    const rings = NS.RANGE_RINGS_KM;  // [0.2, 0.5, 2, 5, 10, 25, 50]

    ctx.save();
    ctx.font = mono(10);
    ctx.textAlign = 'left';

    const labelled = [];
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

      if (km >= 5 || km === 0.2 || km === 2) {
        const label = km >= 1 ? `${km}km` : `${km * 1000}m`;
        labelled.push({ km, r, label });
      }
    }

    // Labels in a second pass, outermost first, one measure per label — a label that would run into the one outside it is
    // skipped (the 200m / 2km / 5km run-together at the orb's right)
    ctx.fillStyle = 'rgba(0, 255, 136, 0.25)';
    let lastLeft = Infinity;
    for (let i = labelled.length - 1; i >= 0; i--) {
      const { r, label } = labelled[i];
      const x = cx + r + 2;
      const w = ctx.measureText(label).width;
      if (x + w <= lastLeft - 3) {
        ctx.fillText(label, x, cy - 2);
        lastLeft = x;
      }
    }
    ctx.restore();
  }

  _drawDebrisDot(ctx, cx, cy, R, target, playerPos) {
    const cart = orbitToSceneCartesian(target.orbit);
    this._tmpDir.set(cart.position.x, cart.position.y, cart.position.z)
      .sub(playerPos);
    const { sx, sy, z, distKm, clipped } = this._toSphereWithDistance(this._tmpDir, cx, cy, R);
    // After _toSphereWithDistance, _tmpDir is normalized (direction only)

    const NS = Constants.NAVSPHERE;
    const t = Math.min(distKm / (this._outerZoneKm || NS.OUTER_ZONE_KM_MAX), 1);
    let dotSz = NS.DOT_MAX_PX - t * (NS.DOT_MAX_PX - NS.DOT_MIN_PX);
    const alpha = z > 0 ? 0.9 : 0.4;
    if (z < 0) dotSz = Math.max(NS.DOT_MIN_PX, dotSz - 1);

    let finalSize = dotSz;
    if (target.sizeMeter) {
      // Scale factor: tiny debris (0.1m) = 0.5x, huge debris (10m+) = 1.5x
      const sizeScale = 0.5 + Math.min(target.sizeMeter / 10, 1.0);
      finalSize = dotSz * sizeScale;
    }
    finalSize = clamp(NS.DOT_MAX_PX, NS.DOT_MIN_PX, finalSize);

    const closureRate = this._computeClosureRate(cart, playerPos, this._playerVel);

    const sel = target.id === this._selectedTargetId;
    const dotColor = this._getZoneColor(distKm, sel, closureRate);

    this._drawStalk(ctx, cx, cy, R, this._tmpDir, sx, sy, z, dotColor, distKm);

    const drawSize = sel ? finalSize + 2.5 : finalSize;
    this._drawContactShape(ctx, sx, sy, target.type, drawSize, dotColor, alpha);

    // Lock-on ring: steady double-circle (ST-5.4), colour swapped by MOID badge (ST-6.3)
    if (sel) {
      const NS2 = Constants.NAVSPHERE;

      // MOID badge colour override — HI = red, MD = yellow, LO/null = cyan. Calm-HUD: the ring is steady for every badge —
      // selection is a standing state and the colour already differentiates threat level.
      let ringColor = C.selected;
      const moidBadge = target.moidBadge || null;
      if (moidBadge === 'HI') {
        ringColor = Constants.CONJUNCTION.BADGE_COLOR_HI;
      } else if (moidBadge === 'MD') {
        ringColor = Constants.CONJUNCTION.BADGE_COLOR_MD;
      }

      const ringAlpha = 0.8;
      ctx.strokeStyle = ringColor;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = alpha * ringAlpha;
      ctx.beginPath();
      ctx.arc(sx, sy, finalSize * NS2.LOCK_ON_OUTER_RADIUS_MULT, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = alpha * ringAlpha * 0.7;
      ctx.beginPath();
      ctx.arc(sx, sy, finalSize * NS2.LOCK_ON_INNER_RADIUS_MULT, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (distKm <= Constants.NAVSPHERE.VELOCITY_ARROW_RANGE_KM && closureRate !== null) {
      this._drawVelocityArrow(ctx, sx, sy, closureRate, cart, this._playerVel);
    }

    if (sel && distKm !== undefined) {
      ctx.save();
      ctx.globalAlpha = alpha;  // steady opacity, not pulsing
      ctx.font = mono(10);
      ctx.fillStyle = C.selected;
      ctx.textAlign = 'left';
      const label = distKm < 1 ? `${(distKm * 1000).toFixed(0)}m` : `${distKm.toFixed(1)}km`;
      ctx.fillText(label, sx + drawSize + 4, sy + 3);
      ctx.restore();
    }

    ctx.globalAlpha = 1;
  }

  /**
   * Draw a debris contact shape by type: defunctSat → diamond ◆, rocketBody → rectangle ■, missionDebris → triangle ▲,
   * fragment/default → circle ●.
   * @param {string} type - debris type (fragment/rocketBody/defunctSat/missionDebris)
   * @param {number} size - shape radius in px
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
        ctx.beginPath();
        ctx.moveTo(sx, sy - size);
        ctx.lineTo(sx + size, sy);
        ctx.lineTo(sx, sy + size);
        ctx.lineTo(sx - size, sy);
        ctx.closePath();
        ctx.fill();
        break;

      case 'rocketBody':
        ctx.fillRect(sx - size * 0.7, sy - size, size * 1.4, size * 2);
        break;

      case 'missionDebris':
        ctx.beginPath();
        ctx.moveTo(sx, sy - size);
        ctx.lineTo(sx + size, sy + size * 0.7);
        ctx.lineTo(sx - size, sy + size * 0.7);
        ctx.closePath();
        ctx.fill();
        break;

      default:
        ctx.beginPath();
        ctx.arc(sx, sy, size, 0, Math.PI * 2);
        ctx.fill();
        break;
    }
    ctx.restore();
  }

  _drawSatDot(ctx, cx, cy, R, sat, playerPos) {
    this._tmpDir.subVectors(sat.position, playerPos);
    const { sx, sy, z, distKm, clipped } = this._toSphereWithDistance(this._tmpDir, cx, cy, R);

    this._drawStalk(ctx, cx, cy, R, this._tmpDir, sx, sy, z, C.white, distKm);

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
   * Draw a bidirectional I-War stalk from a contact dot: out-of-plane depth z > 0 → stalk UP (above plane), z < 0 → DOWN.
   * Length ∝ |z| × R × STALK_MAX_FRACTION. cx, cy, dir and distKm are unused (kept for API compat).
   * @param {number} z    Camera-space depth (positive = front hemisphere)
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

  /**
   * Concentric tether range rings (jellyfish tentacle zones), log-mapped via _distToRadius.
   * @param {object} armManager - for deployed arm type detection
   */
  _drawTetherRings(ctx, cx, cy, R, armManager) {
    // Tether ranges in km
    const lassoKm = Constants.LASSO_RANGE / 1000;             // 0.09 km (= NET_LOCK_RANGE_M)
    const spinnerKm = Constants.SPINNER_TETHER_LENGTH / 1000;  // 0.5 km
    const weaverKm = Constants.WEAVER_TETHER_LENGTH / 1000;    // 2.0 km

    const lassoR = this._distToRadius(lassoKm, R);
    const spinnerR = this._distToRadius(spinnerKm, R);
    const weaverR = this._distToRadius(weaverKm, R);

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

    // Pulse for active arm types (subtle alpha oscillation). Calm-HUD: 0.32 Hz / small amplitude, frozen under
    // prefers-reduced-motion (the CSS media block can't reach canvas writes).
    const pulse = prefersReducedMotion() ? 0.5 : 0.5 + 0.5 * Math.sin(this._time * 2);

    // ---- Zone fills: drawn BEFORE ring strokes ----
    ctx.globalAlpha = 1;

    const lassoFillAlpha = hasLassoDeployed ? 0.12 : 0.06;
    ctx.beginPath();
    ctx.arc(cx, cy, lassoR, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 255, 255, ${lassoFillAlpha})`;
    ctx.fill();

    const spinnerFillAlpha = hasSpinnerDeployed ? 0.08 : 0.04;
    this._drawZoneFill(ctx, cx, cy, lassoR, spinnerR,
      `rgba(0, 255, 136, ${spinnerFillAlpha})`);

    const weaverFillAlpha = hasWeaverDeployed ? 0.06 : 0.03;
    this._drawZoneFill(ctx, cx, cy, spinnerR, weaverR,
      `rgba(0, 204, 255, ${weaverFillAlpha})`);

    ctx.strokeStyle = Constants.NAVSPHERE_WEAVER_RING_COLOR;
    ctx.lineWidth = hasWeaverDeployed ? 1.5 + pulse * 0.5 : 1;
    ctx.globalAlpha = hasWeaverDeployed ? 0.3 + pulse * 0.15 : 0.15;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(cx, cy, weaverR, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = Constants.NAVSPHERE_SPINNER_RING_COLOR;
    ctx.lineWidth = hasSpinnerDeployed ? 1.5 + pulse * 0.5 : 1;
    ctx.globalAlpha = hasSpinnerDeployed ? 0.35 + pulse * 0.15 : 0.2;
    ctx.beginPath();
    ctx.arc(cx, cy, spinnerR, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = Constants.NAVSPHERE_LASSO_RING_COLOR;
    ctx.lineWidth = 0.5;
    ctx.globalAlpha = 0.25;
    ctx.beginPath();
    ctx.arc(cx, cy, lassoR, 0, Math.PI * 2);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.globalAlpha = 1.0;
  }

  /** Annular zone fill between two radii (composite path; the counter-clockwise inner arc cuts out the center). */
  _drawZoneFill(ctx, cx, cy, innerR, outerR, fillColor) {
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
    ctx.arc(cx, cy, innerR, 0, Math.PI * 2, true);  // counter-clockwise to cut out
    ctx.fillStyle = fillColor;
    ctx.fill();
  }

  /**
   * Dot color from closure rate or tether zone distance. Closure rate takes priority; selected target always wins.
   * @param {number} distanceKm - distance from mothership
   * @param {number} [closureRate] - negative = approaching
   */
  _getZoneColor(distanceKm, isSelected, closureRate) {
    if (isSelected) return C.selected;

    const NS = Constants.NAVSPHERE;

    if (closureRate !== undefined && closureRate !== null) {
      if (closureRate < NS.CLOSURE_APPROACHING_THRESHOLD) {
        return NS.COLOR_APPROACHING;    // red — closing in
      } else if (closureRate > NS.CLOSURE_RECEDING_THRESHOLD) {
        return NS.COLOR_RECEDING;       // green — moving away
      } else {
        return NS.COLOR_ORBIT_CROSS;    // amber — orbit-crossing / same speed
      }
    }

    const lassoKm = Constants.LASSO_RANGE / 1000;             // 0.09 km (= NET_LOCK_RANGE_M)
    const spinnerKm = Constants.SPINNER_TETHER_LENGTH / 1000;  // 0.5 km
    const weaverKm = Constants.WEAVER_TETHER_LENGTH / 1000;    // 2.0 km

    if (distanceKm <= lassoKm) return '#ffffff';        // white — instant grab range
    if (distanceKm <= spinnerKm) {
      const ratio = distanceKm / spinnerKm;
      if (ratio > 0.8) return '#ffcc00';                // yellow — window closing
      return VisualLaw.COLORS.PLAYER;                                  // green — Spinner reach
    }
    if (distanceKm <= weaverKm) {
      const ratio = distanceKm / weaverKm;
      if (ratio > 0.9) return '#ff4444';                // red — about to leave
      if (ratio > 0.8) return '#ffcc00';                // yellow
      return VisualLaw.COLORS.INFO;                                  // cyan — Weaver reach
    }
    return 'rgba(100, 120, 140, 0.4)';                  // dim gray — out of reach
  }

  /**
   * Draw arm tether lines from center to deployed arm positions (jellyfish tentacles), distance-encoded.
   * @param {object} armManager
   * @param {THREE.Vector3} playerPos
   */
  _drawArmTetherLines(ctx, cx, cy, R, armManager, playerPos) {
    if (!armManager || !armManager.arms || !playerPos) return;

    for (const arm of armManager.arms) {
      if (arm.state === 'DOCKED' || arm.state === 'EXPENDED') continue;

      const armPos = arm.position;
      if (!armPos) continue;

      // Direction from player to arm (NOT normalized — distance encoding needs length)
      this._tmpDir.copy(armPos).sub(playerPos);
      const dist = this._tmpDir.length();
      if (dist < 0.0000001) continue;

      const { sx: px, sy: py, z, distKm } = this._toSphereWithDistance(this._tmpDir, cx, cy, R);

      // Detached arms: steady red triangle (no tether line). Calm-HUD: a detached arm is a standing hazard, not an event — the red
      // triangle already reads "untethered / warning".
      if (arm.isDetached) {
        ctx.globalAlpha = 0.9;

        ctx.fillStyle = '#ff4444';
        ctx.beginPath();
        ctx.moveTo(px, py - 5);
        ctx.lineTo(px - 4, py + 3);
        ctx.lineTo(px + 4, py + 3);
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = '#ff4444';
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.arc(px, py, 7, 0, Math.PI * 2);
        ctx.stroke();

        ctx.font = mono(10);
        ctx.fillStyle = '#ff6666';
        ctx.globalAlpha = 0.7;
        const label = arm.id ? arm.id.replace(/^(.).*-/, '$1') : '';
        ctx.fillText(label, px + 8, py + 3);

        ctx.globalAlpha = 1.0;
        continue; // skip tether line
      }

      const color = arm.type === 'weaver' ? VisualLaw.COLORS.INFO : VisualLaw.COLORS.PLAYER;
      // Calm-HUD: steady tether line — presence + colour already encode the arm; an alpha oscillation would be a standing-state pulse.
      const alphaBase = 0.6;

      ctx.strokeStyle = color;
      ctx.globalAlpha = alphaBase;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(px, py);
      ctx.stroke();

      ctx.fillStyle = color;
      ctx.globalAlpha = Math.min(1.0, alphaBase + 0.3);
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fill();

      // Short label (e.g. "w1", "s2")
      ctx.font = mono(10);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.6;
      const label = arm.id ? arm.id.replace(/^(.).*-/, '$1') : '';
      ctx.fillText(label, px + 6, py + 3);

      ctx.globalAlpha = 1.0;
    }
  }

  /**
   * Draw a velocity (closure) arrow from a contact dot: direction = on-sphere projection of relative velocity, length ∝
   * closure rate, clamped to VELOCITY_ARROW_MAX_LENGTH_PX.
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

    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();

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

  /**
   * Draw amber diamond markers for deployed sibling arms during ARM_PILOT mode.
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

      const size = 5;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = VisualLaw.COLORS.CAUTION;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(-size / 2, -size / 2, size, size);
      ctx.strokeStyle = '#ffcc44';
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.5;
      ctx.strokeRect(-size / 2, -size / 2, size, size);
      ctx.restore();

      ctx.font = mono(10);
      ctx.fillStyle = VisualLaw.COLORS.CAUTION;
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
