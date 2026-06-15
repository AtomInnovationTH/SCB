/**
 * CityLabels.js — Earth city labels (UX-11 #5).
 *
 * Renders each curated city (data/cities.json) as a screen-space HTML label:
 * a small glowing dot anchored to the city's surface point with the name in a
 * crisp 2D overlay beside it. Each frame the city's 3D surface point is
 * projected to screen coordinates (via the layer's camera) and the label DOM
 * element is positioned there — so labels are a constant on-screen size (they
 * never inflate when zooming) and never tilt/float like a 3D billboard.
 * Far-hemisphere labels are culled (dot(surfaceNormal, dirToCamera) <
 * threshold) and fade with camera distance to avoid clutter.
 *
 * One CityLabels instance manages multiple LAYERS — the command-view Earth
 * (js/scene/Earth.js group, projected with the gameplay camera into the
 * #hud-overlay) and the Strategic Map's wireframe Earth (projected with the
 * map camera into the map overlay) — so the toggle/persistence state is shared.
 *
 * Toggle: Shift+C (InputManager emits Events.CITY_LABELS_TOGGLE). OFF by
 * default; the on/off preference persists in localStorage (offline-first).
 *
 * Pure helpers (`parseCityList`, `isCityVisible`, `distanceFade`) are
 * Node-testable; everything THREE/DOM lives behind init guards.
 *
 * @module scene/CityLabels
 */

import * as THREE from 'three';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { latLonToPosition } from '../ui/StrategicMap.js';

/** Hard cap on rendered labels (performance + clutter). */
export const MAX_CITIES = 220;

/**
 * Number of LOD tiers. tier 1 = always shown (major cities + isolated ocean /
 * remote references), higher tiers reveal progressively as the camera zooms in.
 */
export const TIER_MAX = 3;

/** Marker-dot diameter in CSS px (used to align the label to its surface point). */
const DOT_PX = 8;

/** localStorage key for the persisted on/off preference. */
const STORAGE_KEY = 'sc_city_labels_visible';

// Module-level scratch vectors — update() runs every frame; no per-frame
// allocations (project scratch-vector discipline).
const _center = new THREE.Vector3();
const _world = new THREE.Vector3();
const _cam = new THREE.Vector3();
const _proj = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _nadir = new THREE.Vector3();

// Calibration aid: load with ?cityCal=1 to print the sub-satellite point and
// the nearest label each ~2 s — lets us verify/lock the texture longitude
// registration without guessing.
const _cityCal = (typeof window !== 'undefined' && window.location &&
  /[?&]cityCal=1/.test(window.location.search || ''));
let _calLastMs = 0;

/**
 * Longitude calibration offset (degrees) applied AFTER any mirroring. The
 * command-view textured Earth uses a default THREE.SphereGeometry (no mesh
 * rotation; shader samples raw UVs), so for a standard equirectangular day
 * texture the prime meridian (lon 0) faces +X and longitude increases EAST
 * toward -Z. `latLonToPosition` instead runs east toward +Z, so the command
 * view must MIRROR longitude (see `mirrorLon` in `attach`) with zero offset.
 * Tweak this only if labels are uniformly rotated off their continents.
 */
export const TEXTURE_LON_OFFSET_DEG = 0;

// ============================================================================
// PURE HELPERS (Node-safe)
// ============================================================================

/**
 * Validate + clamp a parsed cities.json payload.
 * @param {object|Array} json — parsed JSON ({ cities: [...] } or bare array)
 * @param {number} [maxCount=MAX_CITIES]
 * @returns {Array<{name:string, lat:number, lon:number, tier:number}>}
 */
export function parseCityList(json, maxCount = MAX_CITIES) {
  const raw = Array.isArray(json) ? json : (json && Array.isArray(json.cities) ? json.cities : []);
  const out = [];
  for (const c of raw) {
    if (!c || typeof c.name !== 'string' || !c.name.trim()) continue;
    const lat = Number(c.lat), lon = Number(c.lon);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    // LOD tier: clamp to [1, TIER_MAX]; default 2 (mid) when missing/invalid.
    const tRaw = Math.round(Number(c.tier));
    const tier = isFinite(tRaw) ? Math.min(Math.max(tRaw, 1), TIER_MAX) : 2;
    out.push({ name: c.name.trim(), lat, lon, tier });
    if (out.length >= maxCount) break;
  }
  return out;
}

/**
 * Highest LOD tier to show at a given camera distance. Reuses the near/far ramp:
 * full detail (TIER_MAX) at/under `near`, down to tier 1 only at/beyond `far`.
 * @param {number} camDist — camera-to-Earth-center distance (scene units)
 * @param {number} near @param {number} far
 * @returns {number} max tier ∈ [1, TIER_MAX]
 */
export function lodMaxTier(camDist, near, far) {
  return 1 + Math.round(distanceFade(camDist, near, far) * (TIER_MAX - 1));
}

/**
 * Far-hemisphere cull: a city is visible when its surface normal points
 * toward the camera. Plain-object math (no THREE) for testability.
 * @param {{x,y,z}} cityWorldPos
 * @param {{x,y,z}} earthCenter
 * @param {{x,y,z}} camPos
 * @param {number} [threshold=0.05] — small positive bias hides limb labels
 * @returns {boolean}
 */
export function isCityVisible(cityWorldPos, earthCenter, camPos, threshold = 0.05) {
  const nx = cityWorldPos.x - earthCenter.x;
  const ny = cityWorldPos.y - earthCenter.y;
  const nz = cityWorldPos.z - earthCenter.z;
  const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  const cx = camPos.x - cityWorldPos.x;
  const cy = camPos.y - cityWorldPos.y;
  const cz = camPos.z - cityWorldPos.z;
  const cLen = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
  const dot = (nx * cx + ny * cy + nz * cz) / (nLen * cLen);
  return dot > threshold;
}

/**
 * Distance fade: 1.0 inside `near`, linear to 0.0 at `far`.
 * @param {number} dist — camera-to-city distance (scene units)
 * @param {number} near @param {number} far
 * @returns {number} opacity ∈ [0, 1]
 */
export function distanceFade(dist, near, far) {
  if (!(far > near)) return 1;
  if (dist <= near) return 1;
  if (dist >= far) return 0;
  return 1 - (dist - near) / (far - near);
}

// ============================================================================
// CITY LABELS (browser-only past this point)
// ============================================================================

export class CityLabels {
  constructor() {
    /** @type {Array<{name,lat,lon}>} */
    this._cities = [];
    /** @type {Array<object>} attached render layers */
    this._layers = [];
    /** @type {boolean} master visibility (persisted; default OFF) */
    this._visible = false;
    this._loadPreference();

    eventBus.on(Events.CITY_LABELS_TOGGLE, () => this.toggle());
  }

  /** @returns {boolean} */
  isVisible() { return this._visible; }

  /** @returns {Array<{name,lat,lon}>} */
  getCities() { return this._cities; }

  /**
   * Load the curated list (offline-first local JSON, same pattern as the
   * catalog loader).
   * @param {string} [url='data/cities.json']
   * @returns {Promise<number>} number of cities loaded
   */
  async load(url = 'data/cities.json') {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this._cities = parseCityList(await res.json());
    } catch (e) {
      console.warn('[CityLabels] load failed. Labels disabled:', e.message);
      this._cities = [];
    }
    return this._cities.length;
  }

  /**
   * Attach a render layer (one Earth + camera + DOM container).
   * @param {object} opts
   * @param {THREE.Object3D} opts.parent — group/mesh the cities ride with (Earth)
   * @param {number} opts.radius — sphere radius in the parent's local units
   * @param {THREE.Camera} opts.camera — camera used to project city points
   * @param {HTMLElement} opts.container — overlay element labels are appended to
   * @param {Function} [opts.isActive] — () => boolean; layer skipped when false
   *   (e.g. the Strategic Map layer while the map is closed, or the command
   *   layer while the map is open)
   * @param {number} [opts.lonOffsetDeg=TEXTURE_LON_OFFSET_DEG] — texture calibration
   * @param {boolean} [opts.mirrorLon=false] — negate longitude so labels match a
   *   default-SphereGeometry equirectangular texture (command-view Earth). Leave
   *   false for the wireframe Strategic Map so labels co-locate with ground stations.
   * @param {number} [opts.fadeNear=radius*2] @param {number} [opts.fadeFar=radius*18]
   * @param {number} [opts.lodNear=radius*3] — at/under this camera distance all
   *   tiers show; @param {number} [opts.lodFar=radius*10] — at/over this only tier 1.
   */
  attach({ parent, radius, camera, container, isActive = null,
           lonOffsetDeg = TEXTURE_LON_OFFSET_DEG, mirrorLon = false,
           fadeNear, fadeFar, lodNear, lodFar }) {
    if (!parent || !camera || !this._cities.length) return null;
    if (typeof document === 'undefined') return null;

    // A per-layer wrapper so the whole layer can be shown/hidden in one write.
    const root = document.createElement('div');
    root.className = 'sc-city-labels';
    root.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;';
    root.style.display = this._visible ? 'block' : 'none';
    if (container) container.appendChild(root);

    const items = [];
    // Anchor exactly on the surface. These are 2D DOM overlays (no depth test,
    // so no z-fighting), and any radial lift would project pins outward from
    // disk-centre — pushing limb/coastal cities off the coast into the ocean.
    const surfaceLift = radius;
    for (const city of this._cities) {
      const lonDeg = (mirrorLon ? -city.lon : city.lon) + lonOffsetDeg;
      const pos = latLonToPosition(city.lat, lonDeg, surfaceLift);
      const el = this._makeLabelEl(city.name);
      root.appendChild(el);
      items.push({
        el, name: city.name, tier: city.tier || 2,
        anchor: new THREE.Vector3(pos.x, pos.y, pos.z), shown: false,
      });
    }

    const layer = {
      parent, camera, root, items, isActive,
      fadeNear: fadeNear != null ? fadeNear : radius * 2,
      fadeFar: fadeFar != null ? fadeFar : radius * 18,
      lodNear: lodNear != null ? lodNear : radius * 3,
      lodFar: lodFar != null ? lodFar : radius * 10,
    };
    this._layers.push(layer);
    return layer;
  }

  /**
   * Per-frame update: project each city's surface point to screen space, apply
   * zoom-based LOD (hide higher tiers when far), cull far-hemisphere /
   * behind-camera labels, and position the DOM elements. Allocation-free
   * (module scratch vectors). Skipped entirely while hidden; a layer is hidden
   * wholesale when its `isActive` gate is false.
   */
  update() {
    if (!this._visible || typeof window === 'undefined') return;
    const W = window.innerWidth, H = window.innerHeight;
    for (const layer of this._layers) {
      const active = (!layer.isActive || layer.isActive()) && layer.parent.visible !== false;
      if (layer.root.style.display !== (active ? 'block' : 'none')) {
        layer.root.style.display = active ? 'block' : 'none';
      }
      if (!active) continue;

      const camera = layer.camera;
      // Ensure the camera's view matrix is current regardless of render order.
      camera.updateMatrixWorld();
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
      camera.getWorldPosition(_cam);
      layer.parent.updateMatrixWorld();
      layer.parent.getWorldPosition(_center);

      // Zoom-based LOD: how detailed a tier to reveal at this camera distance.
      const maxTier = lodMaxTier(_cam.distanceTo(_center), layer.lodNear, layer.lodFar);

      if (_cityCal) this._logCalibration(layer);

      for (const item of layer.items) {
        // LOD declutter: hide tiers above the current zoom's threshold.
        if (item.tier > maxTier) {
          if (item.shown) { item.el.style.display = 'none'; item.shown = false; }
          continue;
        }

        // City surface point in world space.
        _world.copy(item.anchor);
        layer.parent.localToWorld(_world);

        // Far-hemisphere cull.
        if (!isCityVisible(_world, _center, _cam)) {
          if (item.shown) { item.el.style.display = 'none'; item.shown = false; }
          continue;
        }

        // Project to normalised device coords, then to CSS pixels.
        _proj.copy(_world).project(camera);
        if (_proj.z > 1) {   // behind the camera
          if (item.shown) { item.el.style.display = 'none'; item.shown = false; }
          continue;
        }
        const sx = (_proj.x * 0.5 + 0.5) * W;
        const sy = (_proj.y * -0.5 + 0.5) * H;

        const dist = _world.distanceTo(_cam);
        const op = 0.55 + 0.45 * distanceFade(dist, layer.fadeNear, layer.fadeFar);

        // Anchor the marker dot on the surface point; the name sits to its right.
        item.el.style.transform =
          `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(${-DOT_PX / 2}px, -50%)`;
        item.el.style.opacity = op.toFixed(3);
        if (!item.shown) { item.el.style.display = 'flex'; item.shown = true; }
      }
    }
  }

  /**
   * @private Calibration readout (?cityCal=1). Prints the sub-satellite point
   * (the surface point directly under the camera) as the texture-aligned
   * lat/lon the label system currently assumes, plus the nearest label and how
   * far off it sits. `_cam`/`_center` must already be set for the layer.
   */
  _logCalibration(layer) {
    const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    if (now - _calLastMs < 2000) return;
    _calLastMs = now;

    // Sub-satellite direction (from Earth centre toward the camera).
    _nadir.copy(_cam).sub(_center).normalize();
    // Invert the label mapping: y = sin(lat); world azimuth atan2(z,x) maps to
    // the label's longitude argument. This is the (lat, lonArg) a label would
    // need to sit exactly under the camera.
    const lat = Math.asin(Math.max(-1, Math.min(1, _nadir.y))) * 180 / Math.PI;
    const lonArg = Math.atan2(_nadir.z, _nadir.x) * 180 / Math.PI;

    let bestName = '(none)', bestAng = 999;
    for (const item of layer.items) {
      _tmp.copy(item.anchor);
      layer.parent.localToWorld(_tmp);
      const ang = _tmp.sub(_center).normalize().angleTo(_nadir) * 180 / Math.PI;
      if (ang < bestAng) { bestAng = ang; bestName = item.name; }
    }
    console.log(
      `[cityCal] sub-satellite point: lat≈${lat.toFixed(1)}°, label-lonArg≈${lonArg.toFixed(1)}° ` +
      `| nearest label: "${bestName}" ${bestAng.toFixed(1)}° away ` +
      `| camDist≈${_cam.distanceTo(_center).toFixed(1)}`
    );
  }

  /** Toggle on/off (Shift+C) — persists and announces the new state. */
  toggle() {
    this.setVisible(!this._visible);
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: this._visible ? 'City labels ON (Shift+C to hide)' : 'City labels OFF',
      priority: 'info',
      _postOnboarding: true,
    });
  }

  /** @param {boolean} v */
  setVisible(v) {
    this._visible = !!v;
    for (const layer of this._layers) {
      layer.root.style.display = this._visible ? 'block' : 'none';
    }
    this._savePreference();
    if (this._visible) this.update();
  }

  /** @private */
  _loadPreference() {
    try {
      if (typeof localStorage !== 'undefined') {
        this._visible = localStorage.getItem(STORAGE_KEY) === '1';
      }
    } catch (_) { this._visible = false; }
  }

  /** @private */
  _savePreference() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, this._visible ? '1' : '0');
      }
    } catch (_) { /* private mode etc. — non-fatal */ }
  }

  /**
   * @private Build a screen-space label element: a glowing marker dot followed
   * by the city name. Styled inline (no stylesheet dependency) and sized in CSS
   * px so it stays constant on screen. Positioned each frame by `update()`.
   */
  _makeLabelEl(name) {
    const el = document.createElement('div');
    el.className = 'sc-city-label';
    el.style.cssText = [
      'position:absolute',
      'top:0', 'left:0',
      'display:none',                 // shown by update() once projected on-screen
      'align-items:center',
      'pointer-events:none',
      'white-space:nowrap',
    ].join(';');

    const dot = document.createElement('span');
    dot.style.cssText = [
      `width:${DOT_PX}px`, `height:${DOT_PX}px`,
      'border-radius:50%',
      'background:#fff3cc',
      'box-shadow:0 0 6px 2px rgba(255,210,90,0.9),0 0 2px 1px rgba(255,235,160,1)',
      'flex:0 0 auto',
    ].join(';');

    const text = document.createElement('span');
    text.textContent = name;
    text.style.cssText = [
      'margin-left:6px',
      "font:500 12px/1 'Courier New',monospace",
      'letter-spacing:0.5px',
      'color:#ffedb0',
      'text-shadow:0 1px 2px rgba(0,0,0,0.95),0 0 3px rgba(0,0,0,0.9)',
    ].join(';');

    el.appendChild(dot);
    el.appendChild(text);
    return el;
  }

  /** Remove all layers + DOM elements. */
  dispose() {
    for (const layer of this._layers) {
      layer.root.remove();
    }
    this._layers = [];
  }
}

/** Singleton (wired in main.js). */
export const cityLabels = new CityLabels();
export default CityLabels;
