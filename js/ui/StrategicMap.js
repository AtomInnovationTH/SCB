/**
 * StrategicMap.js — ST-6.4 Strategic 3-D orbital overview map
 *
 * Toggled via Shift+V. While open the gameplay HUD is dimmed and the player
 * cannot control the ship directly. Renders a separate THREE.Scene with:
 *   - Wireframe Earth
 *   - 7 altitude-band rings
 *   - 800 debris dots (colour-coded by catalogType, MOID-pulsing)
 *   - Player marker + orbit ellipse
 *   - Hazard zone shells (AO + radiation belt)
 *   - Ground station dots
 *   - DOM overlays: top-N threat list + legend/status bar
 *
 * Uses the EXISTING renderer (no second WebGL context). When map is open the
 * renderer draws this scene with a dedicated PerspectiveCamera; when closed
 * normal gameplay rendering resumes via the SceneManager composer pipeline.
 *
 * Pure helper functions (keplerianToOrbitPoints, latLonToPosition,
 * formatThreatList, catalogTypeToColor) are exported for Node-safe unit tests.
 *
 * @module ui/StrategicMap
 */

// ============================================================================
// THREE.js — browser-only guard
// ============================================================================
let THREE = null;
try {
  THREE = await import('three');
} catch (_) {
  // Node.js test environment — THREE unavailable, pure helpers still work
}

import { Constants } from '../core/Constants.js';
import { Events } from '../core/Events.js';

// ============================================================================
// PURE HELPERS — Node-safe, no THREE dependency
// ============================================================================

/**
 * Convert Keplerian orbital elements to an array of 3-D points tracing the
 * full orbit. Positions are in km (caller converts to scene units if needed).
 *
 * @param {object} orbit - Keplerian elements (semiMajorAxis in km)
 * @param {number} orbit.semiMajorAxis - Semi-major axis (km)
 * @param {number} orbit.eccentricity
 * @param {number} orbit.inclination - rad
 * @param {number} orbit.raan - rad
 * @param {number} orbit.argPerigee - rad
 * @param {number} [segments=64] - Number of sample points
 * @param {number} [mu=398600.4418] - Gravitational parameter (km³/s²)
 * @returns {Array<{x: number, y: number, z: number}>} positions in km
 */
export function keplerianToOrbitPoints(orbit, segments, mu) {
  const N = segments || Constants.STRATEGIC_MAP.ORBIT_SEGMENTS || 64;
  const MU = mu || Constants.MU_EARTH || 398600.4418;
  const { semiMajorAxis: a, eccentricity: e,
          inclination: inc, raan: Omega, argPerigee: omega } = orbit;

  const p = a * (1 - e * e);
  const points = [];

  // Rotation matrix elements: perifocal → ECI (Y-up convention matching
  // OrbitalMechanics.js keplerianToCartesian — Y is polar axis)
  const cosO = Math.cos(Omega), sinO = Math.sin(Omega);
  const cosW = Math.cos(omega), sinW = Math.sin(omega);
  const cosI = Math.cos(inc),   sinI = Math.sin(inc);

  const l1 = cosO * cosW - sinO * sinW * cosI;
  const l2 = -cosO * sinW - sinO * cosW * cosI;
  const m1 = sinO * cosW + cosO * sinW * cosI;
  const m2 = -sinO * sinW + cosO * cosW * cosI;
  const n1 = sinW * sinI;
  const n2 = cosW * sinI;

  for (let i = 0; i < N; i++) {
    // Evenly spaced mean anomaly
    const M = (2 * Math.PI * i) / N;

    // Solve Kepler's equation: M = E - e sin(E)
    let E = M + e * Math.sin(M);
    for (let j = 0; j < 15; j++) {
      const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
      E -= dE;
      if (Math.abs(dE) < 1e-10) break;
    }

    // True anomaly
    const sinV = (Math.sqrt(1 - e * e) * Math.sin(E)) / (1 - e * Math.cos(E));
    const cosV = (Math.cos(E) - e) / (1 - e * Math.cos(E));
    const v = Math.atan2(sinV, cosV);

    // Radius
    const r = p / (1 + e * Math.cos(v));

    // Perifocal position
    const xP = r * Math.cos(v);
    const yP = r * Math.sin(v);

    // Rotate to ECI (Y-up matching OrbitalMechanics.js convention)
    points.push({
      x: l1 * xP + l2 * yP,
      y: n1 * xP + n2 * yP,
      z: m1 * xP + m2 * yP,
    });
  }

  return points;
}

/**
 * Convert latitude / longitude to a 3-D position on a sphere.
 * Convention: Y-up (Three.js default). lat=0, lon=0 → +X axis.
 * lat=90 → +Y (north pole).
 *
 * @param {number} lat_deg - Latitude in degrees (-90…+90)
 * @param {number} lon_deg - Longitude in degrees (-180…+180)
 * @param {number} radius  - Sphere radius
 * @returns {{ x: number, y: number, z: number }}
 */
export function latLonToPosition(lat_deg, lon_deg, radius) {
  const lat = lat_deg * Math.PI / 180;
  const lon = lon_deg * Math.PI / 180;
  return {
    x: radius * Math.cos(lat) * Math.cos(lon),
    y: radius * Math.sin(lat),
    z: radius * Math.cos(lat) * Math.sin(lon),
  };
}

/**
 * Map catalogType string to hex dot colour for strategic map.
 *
 * @param {string} catalogType
 * @param {object} [C=Constants.STRATEGIC_MAP]
 * @returns {string} hex colour
 */
export function catalogTypeToColor(catalogType, C) {
  const k = C || Constants.STRATEGIC_MAP;
  switch (catalogType) {
    case 'debris':      return k.DOT_COLOR_DEBRIS;
    case 'rocket_body': return k.DOT_COLOR_ROCKET_BODY;
    case 'inactive':    return k.DOT_COLOR_INACTIVE;
    case 'active':      return k.DOT_COLOR_ACTIVE;
    case 'fragment':    return k.DOT_COLOR_FRAGMENT;
    default:            return k.DOT_COLOR_FALLBACK;
  }
}

/**
 * Format top-N risk pairs into display strings for the threat list overlay.
 *
 * @param {Array<{id: string|number, moid: number}>} pairs
 * @param {object} debrisField — must have getDebrisById(id)
 * @returns {Array<{badge: string, name: string, moidKm: string, line: string}>}
 */
export function formatThreatList(pairs, debrisField) {
  if (!pairs || !pairs.length) return [];
  return pairs.map((p, i) => {
    const d = debrisField ? debrisField.getDebrisById(p.id) : null;
    const name = (d && d.name) ? d.name : `OBJ-${p.id}`;
    const moidKm = (p.moid / 1000).toFixed(1); // moid is in metres → km
    const badge = d && d.moidBadge ? d.moidBadge : 'LO';
    const line = `${i + 1}. [${badge}] ${name}  MOID: ${moidKm} km`;
    return { badge, name, moidKm, line };
  });
}

// ============================================================================
// STRATEGIC MAP CLASS — browser-only (requires THREE.js + DOM)
// ============================================================================

export class StrategicMap {
  /**
   * @param {object} deps
   * @param {THREE.Scene} deps.scene — gameplay scene (not used for rendering, but for reference)
   * @param {THREE.WebGLRenderer} deps.renderer
   * @param {object} deps.catalogLoader
   * @param {object} deps.debrisField
   * @param {object} deps.playerSatellite
   * @param {object} deps.conjunctionSystem
   * @param {object} deps.environmentSystem
   * @param {object} deps.eventBus
   */
  constructor(deps) {
    this._renderer = deps.renderer;
    this._catalogLoader = deps.catalogLoader;
    this._debrisField = deps.debrisField;
    this._player = deps.playerSatellite;
    this._conjunction = deps.conjunctionSystem;
    this._environment = deps.environmentSystem;
    this._eventBus = deps.eventBus;

    this._open = false;
    this._hazardOverlays = true;
    this._transitioning = false;
    this._transitionProgress = 0;
    this._transitionDir = 0; // +1 opening, -1 closing

    // Three.js objects (created in init)
    this._scene = null;
    this._camera = null;
    this._earthMesh = null;
    this._bandRings = [];
    this._debrisPoints = null;
    this._playerDot = null;
    this._orbitLine = null;
    this._aoZone = null;
    this._radZone = null;
    this._groundStationPoints = null;
    this._groundStationCount = 0;

    // DOM overlays
    this._threatListEl = null;
    this._legendEl = null;
    this._containerEl = null;

    // Mouse orbit state
    this._mouseDown = false;
    this._mouseX = 0;
    this._mouseY = 0;
    this._spherical = { phi: Math.PI / 4, theta: 0, radius: 800 };

    // Bind handlers
    this._onMouseDown = this._handleMouseDown.bind(this);
    this._onMouseMove = this._handleMouseMove.bind(this);
    this._onMouseUp = this._handleMouseUp.bind(this);
    this._onWheel = this._handleWheel.bind(this);
  }

  // --------------------------------------------------------------------------
  // PUBLIC API
  // --------------------------------------------------------------------------

  /** Create all map scene objects, camera, controls, and DOM overlays. */
  init() {
    if (!THREE) return; // Node-safe guard

    const SM = Constants.STRATEGIC_MAP;

    // --- Dedicated scene (Option B: separate scene, idiomatic Three.js) ---
    this._scene = new THREE.Scene();
    this._scene.background = new THREE.Color(0x000005);

    // --- Camera ---
    this._camera = new THREE.PerspectiveCamera(
      SM.CAMERA_FOV,
      window.innerWidth / window.innerHeight,
      SM.CAMERA_NEAR,
      SM.CAMERA_FAR
    );
    this._spherical.radius = SM.CAMERA_INITIAL_DISTANCE;
    this._spherical.phi = SM.CAMERA_ELEVATION_DEG * Math.PI / 180;
    this._updateCameraFromSpherical();

    // --- Ambient light ---
    const ambient = new THREE.AmbientLight(0x446688, 0.5);
    this._scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.3);
    dirLight.position.set(100, 200, 150);
    this._scene.add(dirLight);

    // --- Earth wireframe ---
    this._createEarth();

    // --- Altitude band rings ---
    this._createAltitudeBands();

    // --- Debris dots ---
    this._createDebrisDots();

    // --- Player marker ---
    this._createPlayerMarker();

    // --- Player orbit ellipse ---
    this._createOrbitLine();

    // --- Hazard zones ---
    this._createHazardZones();

    // --- Ground stations ---
    this._createGroundStations();

    // --- DOM overlays ---
    this._createDOMOverlays();
  }

  /** Transition to map view. */
  open() {
    if (this._open) return;
    this._open = true;
    this._transitioning = true;
    this._transitionProgress = 0;
    this._transitionDir = 1;

    // Register mouse handlers for orbit controls
    const canvas = this._renderer?.domElement;
    if (canvas) {
      canvas.addEventListener('mousedown', this._onMouseDown);
      canvas.addEventListener('mousemove', this._onMouseMove);
      canvas.addEventListener('mouseup', this._onMouseUp);
      canvas.addEventListener('wheel', this._onWheel);
    }

    // Show DOM overlays
    if (this._containerEl) this._containerEl.style.display = 'block';

    // Dim gameplay HUD
    if (typeof document !== 'undefined') {
      const gameContainer = document.getElementById('hud-overlay');
      if (gameContainer) gameContainer.classList.add('map-mode');
      // Body-mounted priority panels (objective + control mode) live outside
      // #hud-overlay, so dim them to match the map-mode HUD fade.
      if (typeof document.querySelectorAll === 'function') {
        document.querySelectorAll('.hud-top-priority').forEach((el) => {
          el.style.opacity = '0.15';
        });
      }
    }

    // Emit event
    if (this._eventBus) this._eventBus.emit(Events.STRATEGIC_MAP_OPENED);
  }

  /** Transition back to gameplay. */
  close() {
    if (!this._open) return;
    this._open = false;
    this._transitioning = true;
    this._transitionProgress = 0;
    this._transitionDir = -1;

    // Remove mouse handlers
    const canvas = this._renderer?.domElement;
    if (canvas) {
      canvas.removeEventListener('mousedown', this._onMouseDown);
      canvas.removeEventListener('mousemove', this._onMouseMove);
      canvas.removeEventListener('mouseup', this._onMouseUp);
      canvas.removeEventListener('wheel', this._onWheel);
    }

    // Hide DOM overlays
    if (this._containerEl) this._containerEl.style.display = 'none';

    // Restore gameplay HUD
    if (typeof document !== 'undefined') {
      const gameContainer = document.getElementById('hud-overlay');
      if (gameContainer) gameContainer.classList.remove('map-mode');
      if (typeof document.querySelectorAll === 'function') {
        document.querySelectorAll('.hud-top-priority').forEach((el) => {
          el.style.opacity = '1';
        });
      }
    }

    // Emit event
    if (this._eventBus) this._eventBus.emit(Events.STRATEGIC_MAP_CLOSED);
  }

  /** @returns {boolean} */
  isOpen() {
    return this._open;
  }

  /**
   * Per-frame update.
   * @param {number} dt — delta time in seconds
   */
  update(dt) {
    if (!this._scene) return;

    // --- Transition animation ---
    if (this._transitioning) {
      const SM = Constants.STRATEGIC_MAP;
      const step = dt / (SM.CAMERA_TRANSITION_MS / 1000);
      this._transitionProgress = Math.min(1, this._transitionProgress + step);
      if (this._transitionProgress >= 1) {
        this._transitioning = false;
      }
    }

    if (!this._open) return;

    // --- Update debris dot positions ---
    this._updateDebrisDots();

    // --- Update player marker + orbit ellipse ---
    this._updatePlayerMarker();

    // --- Update threat list DOM ---
    this._updateThreatList();

    // --- Update legend/status ---
    this._updateLegend();

    // --- MOID pulse animation on HI-badge debris ---
    this._animatePulse(dt);
  }

  /**
   * Toggle AO / radiation hazard zone overlays.
   * @param {boolean} enabled
   */
  setHazardOverlays(enabled) {
    this._hazardOverlays = !!enabled;
    if (this._aoZone) this._aoZone.visible = this._hazardOverlays;
    if (this._radZone) this._radZone.visible = this._hazardOverlays;
  }

  /**
   * Render the strategic map scene to the shared renderer.
   * Called by main.js when map is open instead of the normal composer.
   */
  render() {
    if (!this._renderer || !this._scene || !this._camera) return;
    this._camera.aspect = window.innerWidth / window.innerHeight;
    this._camera.updateProjectionMatrix();
    this._renderer.render(this._scene, this._camera);
  }

  /** Cleanup Three.js objects + DOM. */
  dispose() {
    // Remove DOM
    if (this._containerEl && this._containerEl.parentNode) {
      this._containerEl.parentNode.removeChild(this._containerEl);
    }

    // Remove mouse listeners
    const canvas = this._renderer?.domElement;
    if (canvas) {
      canvas.removeEventListener('mousedown', this._onMouseDown);
      canvas.removeEventListener('mousemove', this._onMouseMove);
      canvas.removeEventListener('mouseup', this._onMouseUp);
      canvas.removeEventListener('wheel', this._onWheel);
    }

    // Dispose Three.js geometry/materials
    if (this._scene) {
      this._scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
          else obj.material.dispose();
        }
      });
    }

    this._scene = null;
    this._camera = null;
  }

  // --------------------------------------------------------------------------
  // SCENE CONSTRUCTION — PRIVATE
  // --------------------------------------------------------------------------

  _createEarth() {
    const SM = Constants.STRATEGIC_MAP;
    const geo = new THREE.SphereGeometry(Constants.EARTH_RADIUS, 32, 24);
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(SM.EARTH_WIREFRAME_COLOR),
      wireframe: true,
      transparent: true,
      opacity: 0.4,
    });
    this._earthMesh = new THREE.Mesh(geo, mat);
    this._scene.add(this._earthMesh);
  }

  _createAltitudeBands() {
    const SM = Constants.STRATEGIC_MAP;
    const bands = Constants.DEBRIS.ALT_BANDS;
    const S = Constants.SCENE_SCALE;

    this._bandRings = [];
    for (let i = 0; i < bands.length; i++) {
      const band = bands[i];
      const midAlt = (band.min + band.max) / 2;
      const radius = (Constants.EARTH_RADIUS_KM + midAlt) * S;
      const color = SM.ALT_BAND_COLORS[i] || '#22aadd';
      const opacity = SM.ALT_BAND_OPACITY[i] || 0.08;

      // Use TorusGeometry for a ring: ring radius = orbit radius, tube = visual thickness
      const tubeRadius = Math.max(0.3, radius * 0.005);
      const torus = new THREE.TorusGeometry(radius, tubeRadius, 8, 64);
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(color),
        transparent: true,
        opacity,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(torus, mat);
      // Rotate to lie in equatorial plane (TorusGeometry is in XY plane by default)
      mesh.rotation.x = Math.PI / 2;
      this._scene.add(mesh);
      this._bandRings.push(mesh);
    }
  }

  _createDebrisDots() {
    const SM = Constants.STRATEGIC_MAP;
    const df = this._debrisField;
    if (!df || !df.debrisList) return;

    const count = df.debrisList.length;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const d = df.debrisList[i];
      // Initial position from orbit
      if (d.orbit) {
        const cart = this._orbitToScene(d.orbit);
        positions[i * 3] = cart.x;
        positions[i * 3 + 1] = cart.y;
        positions[i * 3 + 2] = cart.z;
      }
      // Colour by catalogType
      const hexColor = catalogTypeToColor(d.catalogType);
      const c = new THREE.Color(hexColor);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.PointsMaterial({
      size: SM.DOT_SIZE_DEBRIS,
      vertexColors: true,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.85,
    });

    this._debrisPoints = new THREE.Points(geo, mat);
    this._scene.add(this._debrisPoints);
  }

  _createPlayerMarker() {
    const SM = Constants.STRATEGIC_MAP;
    const geo = new THREE.SphereGeometry(0.8, 8, 8);
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(SM.PLAYER_COLOR),
      transparent: true,
      opacity: 0.9,
    });
    this._playerDot = new THREE.Mesh(geo, mat);
    this._scene.add(this._playerDot);
  }

  _createOrbitLine() {
    const SM = Constants.STRATEGIC_MAP;
    const segments = SM.ORBIT_SEGMENTS;
    // Create with placeholder positions (updated each frame)
    const positions = new Float32Array(segments * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.LineBasicMaterial({
      color: new THREE.Color(SM.PLAYER_ORBIT_COLOR),
      transparent: true,
      opacity: 0.5,
    });

    this._orbitLine = new THREE.LineLoop(geo, mat);
    this._scene.add(this._orbitLine);
  }

  _createHazardZones() {
    const SM = Constants.STRATEGIC_MAP;
    const S = Constants.SCENE_SCALE;
    const ER = Constants.EARTH_RADIUS_KM;

    // AO zone: faint shell below 600 km
    const aoRadius = (ER + Constants.ENVIRONMENT.AO_THRESHOLD_KM) * S;
    const aoGeo = new THREE.SphereGeometry(aoRadius, 24, 16);
    const aoMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(SM.AO_ZONE_COLOR),
      transparent: true,
      opacity: SM.AO_ZONE_OPACITY,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this._aoZone = new THREE.Mesh(aoGeo, aoMat);
    this._scene.add(this._aoZone);

    // Radiation belt: shell between 2000-12000 km
    const radInner = (ER + Constants.ENVIRONMENT.RADIATION_BELT_LOW_KM) * S;
    const radOuter = (ER + Constants.ENVIRONMENT.RADIATION_BELT_HIGH_KM) * S;
    const radGeo = new THREE.SphereGeometry(radOuter, 24, 16);
    const radMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(SM.RADIATION_ZONE_COLOR),
      transparent: true,
      opacity: SM.RADIATION_ZONE_OPACITY,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this._radZone = new THREE.Mesh(radGeo, radMat);
    this._scene.add(this._radZone);

    // Inner cutout hint — render an inner sphere slightly smaller
    const radInnerGeo = new THREE.SphereGeometry(radInner, 24, 16);
    const radInnerMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(SM.RADIATION_ZONE_COLOR),
      transparent: true,
      opacity: SM.RADIATION_ZONE_OPACITY * 0.5,
      side: THREE.BackSide,
      depthWrite: false,
    });
    this._radInnerMesh = new THREE.Mesh(radInnerGeo, radInnerMat);
    this._scene.add(this._radInnerMesh);

    // Set initial visibility
    this._aoZone.visible = this._hazardOverlays;
    this._radZone.visible = this._hazardOverlays;
    this._radInnerMesh.visible = this._hazardOverlays;
  }

  _createGroundStations() {
    const SM = Constants.STRATEGIC_MAP;
    const stations = this._catalogLoader ? this._catalogLoader.getAllGroundStations() : [];
    this._groundStationCount = stations.length;

    if (stations.length === 0) return;

    const positions = new Float32Array(stations.length * 3);
    for (let i = 0; i < stations.length; i++) {
      const s = stations[i];
      const lat = s.lat || s.latitude || 0;
      const lon = s.lon || s.longitude || 0;
      const pos = latLonToPosition(lat, lon, Constants.EARTH_RADIUS + 0.2);
      positions[i * 3] = pos.x;
      positions[i * 3 + 1] = pos.y;
      positions[i * 3 + 2] = pos.z;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.PointsMaterial({
      color: new THREE.Color(SM.GROUND_STATION_COLOR),
      size: SM.DOT_SIZE_GROUND_STATION,
      sizeAttenuation: false,
    });

    this._groundStationPoints = new THREE.Points(geo, mat);
    this._scene.add(this._groundStationPoints);
  }

  _createDOMOverlays() {
    // Container for all map DOM overlays
    this._containerEl = document.createElement('div');
    this._containerEl.id = 'strategic-map-overlay';
    this._containerEl.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      pointer-events: none; z-index: 20; display: none;
      font-family: 'Courier New', monospace; color: #00ff88;
    `;

    // Threat list (bottom-left)
    this._threatListEl = document.createElement('div');
    this._threatListEl.style.cssText = `
      position: absolute; bottom: 20px; left: 20px;
      background: rgba(5, 10, 20, 0.9); border: 1px solid rgba(0, 255, 136, 0.3);
      border-radius: 4px; padding: 10px 14px; pointer-events: auto;
      font-size: 12px; min-width: 280px; max-width: 400px;
    `;
    this._threatListEl.innerHTML = '<div style="color:#ff6644;font-weight:bold;margin-bottom:6px">⚠ TOP THREATS</div><div id="threat-lines">Loading…</div>';
    this._containerEl.appendChild(this._threatListEl);

    // Legend / status bar (bottom-right)
    this._legendEl = document.createElement('div');
    this._legendEl.style.cssText = `
      position: absolute; bottom: 20px; right: 20px;
      background: rgba(5, 10, 20, 0.9); border: 1px solid rgba(0, 255, 136, 0.3);
      border-radius: 4px; padding: 10px 14px; pointer-events: auto;
      font-size: 11px; min-width: 200px;
    `;
    this._containerEl.appendChild(this._legendEl);

    // Title bar (top-center)
    const titleEl = document.createElement('div');
    titleEl.style.cssText = `
      position: absolute; top: 16px; left: 50%; transform: translateX(-50%);
      background: rgba(5, 10, 20, 0.85); border: 1px solid rgba(0, 204, 255, 0.4);
      border-radius: 4px; padding: 8px 24px;
      font-size: 14px; color: #00ccff; font-weight: bold; letter-spacing: 2px;
    `;
    titleEl.textContent = '🛰 STRATEGIC OVERVIEW — Shift+V to close';
    this._containerEl.appendChild(titleEl);

    document.body.appendChild(this._containerEl);
  }

  // --------------------------------------------------------------------------
  // PER-FRAME UPDATES — PRIVATE
  // --------------------------------------------------------------------------

  _updateDebrisDots() {
    const df = this._debrisField;
    if (!df || !df.debrisList || !this._debrisPoints) return;

    const posAttr = this._debrisPoints.geometry.getAttribute('position');
    const colAttr = this._debrisPoints.geometry.getAttribute('color');
    const list = df.debrisList;

    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      if (!d.alive) {
        // Hide dead debris off-screen
        posAttr.setXYZ(i, 0, -99999, 0);
        continue;
      }
      if (d.orbit) {
        const cart = this._orbitToScene(d.orbit);
        posAttr.setXYZ(i, cart.x, cart.y, cart.z);
      }
    }
    posAttr.needsUpdate = true;
  }

  _updatePlayerMarker() {
    if (!this._player || !this._playerDot) return;

    // Player position in scene units
    const pos = this._player.getPosition();
    if (pos) {
      this._playerDot.position.set(pos.x, pos.y, pos.z);
    }

    // Update orbit ellipse
    if (this._orbitLine && this._player.orbit) {
      const orbit = this._player.orbit;
      // Convert scene-unit semiMajorAxis to km, compute points, convert back
      const kmOrbit = {
        semiMajorAxis: orbit.semiMajorAxis / Constants.SCENE_SCALE,
        eccentricity: orbit.eccentricity || 0,
        inclination: orbit.inclination || 0,
        raan: orbit.raan || 0,
        argPerigee: orbit.argPerigee || 0,
      };
      const pts = keplerianToOrbitPoints(kmOrbit);
      const posAttr = this._orbitLine.geometry.getAttribute('position');
      const S = Constants.SCENE_SCALE;
      for (let i = 0; i < pts.length && i < posAttr.count; i++) {
        posAttr.setXYZ(i, pts[i].x * S, pts[i].y * S, pts[i].z * S);
      }
      posAttr.needsUpdate = true;
    }
  }

  _updateThreatList() {
    if (!this._threatListEl || !this._conjunction) return;

    const SM = Constants.STRATEGIC_MAP;
    const pairs = this._conjunction.getTopRiskPairs(SM.THREAT_LIST_COUNT);
    const formatted = formatThreatList(pairs, this._debrisField);

    const linesDiv = this._threatListEl.querySelector('#threat-lines');
    if (linesDiv) {
      if (formatted.length === 0) {
        linesDiv.textContent = 'No active threats';
      } else {
        linesDiv.innerHTML = formatted.map(f => {
          const badgeColor = f.badge === 'HI' ? '#ff4444' : f.badge === 'MD' ? '#ffcc00' : '#44aa66';
          return `<div style="color:${badgeColor};margin:2px 0">${f.line}</div>`;
        }).join('');
      }
    }
  }

  _updateLegend() {
    if (!this._legendEl) return;

    const SM = Constants.STRATEGIC_MAP;
    const alt = this._player ? (this._player.getAltitudeKm ? this._player.getAltitudeKm() : '?') : '?';
    const orbitNum = typeof this._player?.orbit?.trueAnomaly === 'number'
      ? Math.floor(this._player.orbit.trueAnomaly / (2 * Math.PI) * 100) / 100
      : '?';

    // Active effects
    let effectsHtml = '';
    if (this._environment && this._environment.getActiveEffects) {
      const effects = this._environment.getActiveEffects();
      if (effects && effects.length > 0) {
        effectsHtml = `<div style="margin-top:4px;color:#ffaa44">⚡ ${effects.join(', ')}</div>`;
      }
    }

    this._legendEl.innerHTML = `
      <div style="color:#00ccff;font-weight:bold;margin-bottom:6px">📊 STATUS</div>
      <div>Alt: ${typeof alt === 'number' ? alt.toFixed(1) : alt} km</div>
      <div style="margin-top:8px;color:#00ccff;font-weight:bold">🎨 LEGEND</div>
      <div><span style="color:${SM.DOT_COLOR_DEBRIS}">●</span> debris</div>
      <div><span style="color:${SM.DOT_COLOR_ROCKET_BODY}">●</span> rocket body</div>
      <div><span style="color:${SM.DOT_COLOR_INACTIVE}">●</span> inactive sat</div>
      <div><span style="color:${SM.DOT_COLOR_ACTIVE}">●</span> active sat</div>
      <div><span style="color:${SM.DOT_COLOR_FRAGMENT}">●</span> fragment</div>
      <div><span style="color:${SM.PLAYER_COLOR}">●</span> player</div>
      <div><span style="color:${SM.GROUND_STATION_COLOR}">●</span> ground station</div>
      ${effectsHtml}
    `;
  }

  /** Animate MOID HI-badge debris with red pulse. */
  _animatePulse(dt) {
    if (!this._debrisPoints || !this._debrisField) return;

    const colAttr = this._debrisPoints.geometry.getAttribute('color');
    const list = this._debrisField.debrisList;
    const t = performance.now() / 1000;

    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      if (!d.alive) continue;

      if (d.moidBadge === 'HI') {
        // Pulse red
        const pulse = 0.5 + 0.5 * Math.sin(t * 4);
        colAttr.setXYZ(i, 1.0, pulse * 0.2, pulse * 0.1);
      } else if (d.moidBadge === 'MD') {
        // Steady yellow
        colAttr.setXYZ(i, 1.0, 0.85, 0.0);
      }
      // else: keep original colour (set during creation)
    }
    colAttr.needsUpdate = true;
  }

  // --------------------------------------------------------------------------
  // CAMERA ORBIT CONTROLS — PRIVATE
  // --------------------------------------------------------------------------

  _updateCameraFromSpherical() {
    if (!this._camera) return;
    const { phi, theta, radius } = this._spherical;
    this._camera.position.set(
      radius * Math.cos(phi) * Math.sin(theta),
      radius * Math.sin(phi),
      radius * Math.cos(phi) * Math.cos(theta),
    );
    this._camera.lookAt(0, 0, 0);
  }

  _handleMouseDown(e) {
    this._mouseDown = true;
    this._mouseX = e.clientX;
    this._mouseY = e.clientY;
  }

  _handleMouseMove(e) {
    if (!this._mouseDown) return;
    const dx = e.clientX - this._mouseX;
    const dy = e.clientY - this._mouseY;
    this._mouseX = e.clientX;
    this._mouseY = e.clientY;

    // Rotate camera
    this._spherical.theta -= dx * 0.005;
    this._spherical.phi += dy * 0.005;
    // Clamp phi to avoid flipping
    this._spherical.phi = Math.max(0.05, Math.min(Math.PI / 2 - 0.05, this._spherical.phi));
    this._updateCameraFromSpherical();
  }

  _handleMouseUp() {
    this._mouseDown = false;
  }

  _handleWheel(e) {
    e.preventDefault();
    const SM = Constants.STRATEGIC_MAP;
    const zoomSpeed = this._spherical.radius * 0.1;
    this._spherical.radius += e.deltaY > 0 ? zoomSpeed : -zoomSpeed;
    this._spherical.radius = Math.max(SM.ZOOM_MIN, Math.min(SM.ZOOM_MAX, this._spherical.radius));
    this._updateCameraFromSpherical();
  }

  // --------------------------------------------------------------------------
  // UTILITIES — PRIVATE
  // --------------------------------------------------------------------------

  /**
   * Convert a scene-unit orbit to scene-unit Cartesian position.
   * Leverages the same math as OrbitalMechanics.orbitToSceneCartesian
   * but inlined to avoid import issues in this module.
   */
  _orbitToScene(orbit) {
    const a = orbit.semiMajorAxis / Constants.SCENE_SCALE; // km
    const e = orbit.eccentricity || 0;
    const inc = orbit.inclination || 0;
    const Omega = orbit.raan || 0;
    const omega = orbit.argPerigee || 0;
    const nu = orbit.trueAnomaly || 0;

    const p = a * (1 - e * e);
    const r = p / (1 + e * Math.cos(nu));

    const xP = r * Math.cos(nu);
    const yP = r * Math.sin(nu);

    const cosO = Math.cos(Omega), sinO = Math.sin(Omega);
    const cosW = Math.cos(omega), sinW = Math.sin(omega);
    const cosI = Math.cos(inc),   sinI = Math.sin(inc);

    const l1 = cosO * cosW - sinO * sinW * cosI;
    const l2 = -cosO * sinW - sinO * cosW * cosI;
    const m1 = sinO * cosW + cosO * sinW * cosI;
    const m2 = -sinO * sinW + cosO * cosW * cosI;
    const n1 = sinW * sinI;
    const n2 = cosW * sinI;

    const S = Constants.SCENE_SCALE;
    return {
      x: (l1 * xP + l2 * yP) * S,
      y: (n1 * xP + n2 * yP) * S,
      z: (m1 * xP + m2 * yP) * S,
    };
  }
}

// ============================================================================
// CJS GUARD — pure helpers available in Node.js tests
// ============================================================================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    keplerianToOrbitPoints,
    latLonToPosition,
    catalogTypeToColor,
    formatThreatList,
    StrategicMap,
  };
}
