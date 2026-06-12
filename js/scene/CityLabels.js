/**
 * CityLabels.js — Earth city labels (UX-11 #5).
 *
 * Renders each curated city (data/cities.json) as a small glowing dot + name
 * billboard (THREE.Sprite from a Canvas2D texture), parented to an Earth
 * group so the labels ride with it. Far-hemisphere labels are culled
 * (dot(surfaceNormal, dirToCamera) < threshold) and fade with camera
 * distance to avoid clutter.
 *
 * One CityLabels instance manages multiple LAYERS — the command-view Earth
 * (js/scene/Earth.js group) and the Strategic Map's wireframe Earth — so the
 * toggle/persistence state is shared.
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
export const MAX_CITIES = 40;

/** localStorage key for the persisted on/off preference. */
const STORAGE_KEY = 'sc_city_labels_visible';

// Module-level scratch vectors — update() runs every frame; no per-frame
// allocations (project scratch-vector discipline).
const _center = new THREE.Vector3();
const _world = new THREE.Vector3();
const _cam = new THREE.Vector3();

/**
 * Longitude calibration offset (degrees) between the lat/lon convention of
 * [`latLonToPosition`](js/ui/StrategicMap.js:122) (lon 0 → +X) and the Earth
 * day-texture's UV mapping. Adjust here if labels land off their continents.
 */
export const TEXTURE_LON_OFFSET_DEG = 90;

// ============================================================================
// PURE HELPERS (Node-safe)
// ============================================================================

/**
 * Validate + clamp a parsed cities.json payload.
 * @param {object|Array} json — parsed JSON ({ cities: [...] } or bare array)
 * @param {number} [maxCount=MAX_CITIES]
 * @returns {Array<{name:string, lat:number, lon:number}>}
 */
export function parseCityList(json, maxCount = MAX_CITIES) {
  const raw = Array.isArray(json) ? json : (json && Array.isArray(json.cities) ? json.cities : []);
  const out = [];
  for (const c of raw) {
    if (!c || typeof c.name !== 'string' || !c.name.trim()) continue;
    const lat = Number(c.lat), lon = Number(c.lon);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    out.push({ name: c.name.trim(), lat, lon });
    if (out.length >= maxCount) break;
  }
  return out;
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
      console.warn('[CityLabels] load failed — labels disabled:', e.message);
      this._cities = [];
    }
    return this._cities.length;
  }

  /**
   * Attach a render layer.
   * @param {object} opts
   * @param {THREE.Object3D} opts.parent — group/mesh the labels ride with (Earth)
   * @param {number} opts.radius — sphere radius in the parent's local units
   * @param {Function} opts.getCameraPos — () => {x,y,z} world camera position
   * @param {Function} [opts.isActive] — () => boolean; layer skipped when false
   *   (e.g. the Strategic Map layer while the map is closed)
   * @param {number} [opts.lonOffsetDeg=TEXTURE_LON_OFFSET_DEG] — texture calibration
   * @param {number} [opts.spriteScale=1] — relative label size multiplier
   * @param {number} [opts.fadeNear=radius*2] @param {number} [opts.fadeFar=radius*12]
   */
  attach({ parent, radius, getCameraPos, isActive = null,
           lonOffsetDeg = TEXTURE_LON_OFFSET_DEG,
           spriteScale = 1, fadeNear, fadeFar }) {
    if (!parent || !this._cities.length) return null;

    const group = new THREE.Group();
    group.name = 'CityLabels';
    group.visible = this._visible;

    const items = [];
    const surfaceLift = radius * 1.004;   // sit just above the surface
    for (const city of this._cities) {
      const pos = latLonToPosition(city.lat, city.lon + lonOffsetDeg, surfaceLift);
      const sprite = this._makeCitySprite(city.name);
      const s = radius * 0.085 * spriteScale;
      sprite.scale.set(s * 4, s, 1);      // canvas is 4:1 (dot + text)
      sprite.position.set(pos.x, pos.y, pos.z);
      group.add(sprite);
      items.push({ sprite, localPos: { ...pos } });
    }
    parent.add(group);

    const layer = {
      parent, group, items, getCameraPos, isActive,
      fadeNear: fadeNear != null ? fadeNear : radius * 2,
      fadeFar: fadeFar != null ? fadeFar : radius * 12,
    };
    this._layers.push(layer);
    return layer;
  }

  /**
   * Per-frame update: far-hemisphere cull + distance fade per layer.
   * Allocation-free (module scratch vectors); skipped entirely while hidden,
   * and per-layer when the layer's parent isn't part of a visible scene
   * (e.g. the Strategic Map's Earth while the map is closed).
   */
  update() {
    if (!this._visible) return;
    for (const layer of this._layers) {
      if (layer.isActive && !layer.isActive()) continue;
      if (layer.parent.visible === false) continue;
      const cam = layer.getCameraPos ? layer.getCameraPos() : null;
      if (!cam) continue;
      _cam.set(cam.x, cam.y, cam.z);
      // Earth center in world space — once per layer
      layer.parent.getWorldPosition(_center);
      for (const item of layer.items) {
        item.sprite.getWorldPosition(_world);
        const vis = isCityVisible(_world, _center, _cam);
        item.sprite.visible = vis;
        if (vis) {
          const dist = _world.distanceTo(_cam);
          item.sprite.material.opacity = 0.25 + 0.75 * distanceFade(dist, layer.fadeNear, layer.fadeFar);
        }
      }
    }
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
    for (const layer of this._layers) layer.group.visible = this._visible;
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

  /** @private Build a 4:1 canvas sprite: glowing dot + city name. */
  _makeCitySprite(name) {
    const W = 256, H = 64;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');

    // Glowing dot (left)
    const dotX = 18, dotY = H / 2;
    const glow = ctx.createRadialGradient(dotX, dotY, 1, dotX, dotY, 14);
    glow.addColorStop(0, 'rgba(255,235,160,1)');
    glow.addColorStop(0.35, 'rgba(255,210,90,0.85)');
    glow.addColorStop(1, 'rgba(255,200,60,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(dotX - 14, dotY - 14, 28, 28);
    ctx.fillStyle = '#fff3cc';
    ctx.beginPath();
    ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
    ctx.fill();

    // City name
    ctx.font = 'bold 26px "Courier New", monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = '#ffedb0';
    ctx.fillText(name, 38, dotY + 1);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({
      map: texture, transparent: true, depthWrite: false, depthTest: true,
    });
    return new THREE.Sprite(mat);
  }

  /** Remove all layers + dispose GPU resources. */
  dispose() {
    for (const layer of this._layers) {
      layer.parent.remove(layer.group);
      for (const item of layer.items) {
        item.sprite.material.map?.dispose();
        item.sprite.material.dispose();
      }
    }
    this._layers = [];
  }
}

/** Singleton (wired in main.js). */
export const cityLabels = new CityLabels();
export default CityLabels;
