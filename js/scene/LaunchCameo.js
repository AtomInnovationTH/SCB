/**
 * LaunchCameo.js — a single launch-plume cameo rising from the player's home
 * spaceport during the opening orbital pass.
 *
 * DESIGN CONSTRAINT: at 1 unit = 100 km, a plume climbing to 120 km is a
 * 1.2-unit feature; seen from 1000 km that subtends ~7° ≈ 110 px on a 900 px
 * screen. So this is a *very* visible element — restraint, not visibility, is
 * the design requirement. It is kept thin (a 1 px trail), dim (opacity capped
 * at 0.7), and brief (16 s).
 *
 * REALISM LICENCE: a real ascent to orbit takes ~8 minutes; the cameo
 * compresses it ~30× to 16 s so the whole climb is watchable during the
 * opening pass. Apogee is capped at 120 km (a sub-orbital-looking arc) rather
 * than the player's 350 km, so the plume never reads as reaching the ship.
 *
 * The plume is anchored to the Earth group and uses the same mirrored-
 * longitude convention as CityLabels (the solid Earth never rotates, and the
 * sub-point tracks westward, `lonEci = -lonEastDeg`).
 *
 * Pure helpers (`ascentPoint`, `cameoIntensity`, `padFor`) are Node-testable;
 * everything THREE/DOM lives behind init guards and tolerates a null glow map.
 *
 * @module scene/LaunchCameo
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { latLonToPosition } from '../ui/StrategicMap.js';
import { getRadialGlowTexture } from './glowSpriteTexture.js';
import { cityFacingDot } from './CityLabels.js';

/** Cameo duration in seconds (real ascent ≈ 8 min → ~30× compression). */
export const CAMEO_DURATION_S = 16;
/** Apogee altitude in scene units (1 unit = 100 km → 1.2 = 120 km). */
export const CAMEO_APOGEE_U = 1.2;
/** Downrange distance in scene units (4.0 = 400 km). */
const CAMEO_DOWNRANGE_U = 4.0;
/** Trail sample count. */
const TRAIL_POINTS = 32;
/** Peak opacity cap — keeps the plume a bright thread, not a flare. */
const MAX_OPACITY = 0.7;

/**
 * Per-language home pad. Each is verified to sit inside that language's
 * ~19° starting window (great-circle Δ from the spawn anchor), so the cameo is
 * actually visible when it fires. `azimuthDeg` is the launch heading.
 * Coordinates are NOT stored here — they come from the shared cities list
 * (data/cities.json, kind:'launch', matched by name) so a data correction
 * can't desync the cameo from the pad's city label (review finding).
 */
export const CAMEO_PADS = {
  en: { name: 'Cape Canaveral', vehicle: 'Falcon 9', azimuthDeg: 90 },
  th: { name: 'Wenchang', vehicle: 'Long March 5', azimuthDeg: 100 },
  ja: { name: 'Tanegashima', vehicle: 'H3', azimuthDeg: 100 },
  es: { name: 'El Arenosillo', vehicle: 'sounding rocket', azimuthDeg: 230 },
  pt: { name: 'Alcantara', vehicle: 'VLS', azimuthDeg: 80 },
  hi: { name: 'Sriharikota', vehicle: 'PSLV', azimuthDeg: 140 },
  ta: { name: 'Sriharikota', vehicle: 'PSLV', azimuthDeg: 140 },
};

/**
 * Resolve the home pad for a language code. Pure: coordinates are looked up
 * from the caller-supplied cities list (cityLabels.getCities() in prod, a
 * parsed fixture in tests) — kind 'launch', matched by name.
 * @param {string} code
 * @param {Array<{name:string,kind:string,lat:number,lon:number}>} [cities]
 * @returns {{name:string,lat:number,lon:number,vehicle:string,azimuthDeg:number}|null}
 *   null for an unknown code, or when cities aren't loaded / the pad is missing.
 */
export function padFor(code, cities) {
  const entry = CAMEO_PADS[code];
  if (!entry) return null;
  const geo = (cities || []).find((c) => c.kind === 'launch' && c.name === entry.name);
  if (!geo) return null;
  return { ...entry, lat: geo.lat, lon: geo.lon };
}

/**
 * A point on the ascent path. Pure and Node-testable.
 * Pass `out` to write into a reused object (allocation-free in the hot loop —
 * update() calls this 33×/frame); omit it for a fresh object (tests, one-offs).
 * @param {number} lat @param {number} lon — pad coordinates (degrees)
 * @param {number} radius — Earth radius (scene units)
 * @param {number} t — progress ∈ [0,1]
 * @param {boolean} mirrorLon — match CityLabels' mirrored-longitude convention
 * @param {number} [azimuthDeg=90] — launch heading (90 = due east)
 * @param {object} [out] — optional target {x,y,z,alt} to mutate and return
 * @returns {{x:number,y:number,z:number,alt:number}} position + altitude (units)
 */
export function ascentPoint(lat, lon, radius, t, mirrorLon, azimuthDeg = 90, out) {
  const tc = Math.max(0, Math.min(1, t));
  const alt = CAMEO_APOGEE_U * Math.pow(tc, 1.6);
  const down = CAMEO_DOWNRANGE_U * tc * tc;

  const lonDeg = mirrorLon ? -lon : lon;
  const surf = latLonToPosition(lat, lonDeg, radius);
  // Surface normal (unit).
  const nLen = Math.hypot(surf.x, surf.y, surf.z) || 1;
  const nx = surf.x / nLen, ny = surf.y / nLen, nz = surf.z / nLen;

  // Downrange direction: rotate the local-east tangent by the azimuth around n.
  // Local east (in the latLonToPosition frame) is d(position)/d(lon).
  const la = lat * Math.PI / 180, lo = lonDeg * Math.PI / 180;
  let ex = -Math.cos(la) * Math.sin(lo), ey = 0, ez = Math.cos(la) * Math.cos(lo);
  const eLen = Math.hypot(ex, ey, ez) || 1;
  ex /= eLen; ez /= eLen;
  // North = n × east.
  let ux = ny * ez - nz * ey, uy = nz * ex - nx * ez, uz = nx * ey - ny * ex;
  const az = azimuthDeg * Math.PI / 180;
  const ca = Math.cos(az), sa = Math.sin(az);
  // downrange dir = east*cos(az) + north*sin(az)
  const dx = ex * ca + ux * sa, dy = ey * ca + uy * sa, dz = ez * ca + uz * sa;

  // position = normalize(n*(R+alt) + downrange*d) * (R+alt)
  const px = nx * (radius + alt) + dx * down;
  const py = ny * (radius + alt) + dy * down;
  const pz = nz * (radius + alt) + dz * down;
  const pLen = Math.hypot(px, py, pz) || 1;
  const s = (radius + alt) / pLen;
  const r = out || {};
  r.x = px * s; r.y = py * s; r.z = pz * s; r.alt = alt;
  return r;
}

/**
 * Plume brightness from sun geometry. Brightest near the terminator (the
 * physically correct behaviour for a twilight plume), dimmest at local noon.
 * @param {number} sunDot — dot(surfaceNormal, sunDirection) ∈ [-1,1]
 * @returns {number} intensity ∈ [0.45, 1.0]
 */
export function cameoIntensity(sunDot) {
  const v = 0.45 + 0.55 * (1 - Math.abs(sunDot));
  return Math.max(0.45, Math.min(1.0, v));
}

// Module scratch vectors (no per-frame allocation).
const _v = new THREE.Vector3();
const _c = new THREE.Vector3();
// Scratch ascent points for update()'s head + trail calls (33 allocs/frame → 0).
const _headPt = { x: 0, y: 0, z: 0, alt: 0 };
const _trailPt = { x: 0, y: 0, z: 0, alt: 0 };

export class LaunchCameo {
  constructor() {
    this._layer = null;
    this._active = false;
    this._t = 0;
    this._pad = null;
    this._sprite = null;
    this._trail = null;
    this._trailPos = null;
  }

  /**
   * Attach the cameo to an Earth group.
   * @param {object} opts
   * @param {THREE.Object3D} opts.parent — the Earth group the plume rides with
   * @param {number} opts.radius — Earth radius (scene units)
   * @param {THREE.Camera} opts.camera — for the hemisphere visibility gate
   * @param {boolean} [opts.mirrorLon=true] — match CityLabels
   * @param {object} [opts.sunLight] — SunLight instance (getSunDirection)
   */
  attach({ parent, radius, camera, mirrorLon = true, sunLight = null }) {
    if (!parent || !camera || typeof document === 'undefined') return null;
    this._layer = { parent, radius, camera, mirrorLon, sunLight };
    return this._layer;
  }

  /**
   * Fire the cameo from a pad, if the pad is on the visible hemisphere.
   * @param {{lat:number,lon:number,name:string,vehicle:string,azimuthDeg?:number}} pad
   * @returns {boolean} true if the cameo started, false if gated out
   */
  fire(pad) {
    if (!this._layer || this._active || !pad) return false;
    if (!Constants.FEATURE_FLAGS.LAUNCH_CAMEO) return false;
    const { parent, radius, camera, mirrorLon } = this._layer;

    // Hemisphere gate: only fire when the pad faces the camera.
    const lonDeg = mirrorLon ? -pad.lon : pad.lon;
    const surf = latLonToPosition(pad.lat, lonDeg, radius);
    _v.set(surf.x, surf.y, surf.z);
    parent.localToWorld(_v);
    parent.getWorldPosition(_c);
    camera.getWorldPosition(this._camPos || (this._camPos = new THREE.Vector3()));
    if (cityFacingDot(_v, _c, this._camPos) <= 0.15) return false;

    this._pad = pad;
    this._t = 0;
    this._active = true;
    this._build();
    return true;
  }

  /** @private Build the sprite + trail (lazily, on first fire). */
  _build() {
    const { parent } = this._layer;
    if (!this._sprite) {
      const map = getRadialGlowTexture({ size: 64, coreStop: 0.0, midStop: 0.35, midAlpha: 0.5 });
      const mat = new THREE.SpriteMaterial({
        map, color: 0xfff2c8, blending: THREE.AdditiveBlending,
        depthWrite: false, transparent: true, opacity: 0,
      });
      this._sprite = new THREE.Sprite(mat);
      this._sprite.scale.setScalar(0.06);
      parent.add(this._sprite);

      const geo = new THREE.BufferGeometry();
      this._trailPos = new Float32Array(TRAIL_POINTS * 3);
      geo.setAttribute('position', new THREE.BufferAttribute(this._trailPos, 3));
      const colors = new Float32Array(TRAIL_POINTS * 3);
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      const lmat = new THREE.LineBasicMaterial({
        vertexColors: true, blending: THREE.AdditiveBlending,
        depthWrite: false, transparent: true, opacity: 0,
      });
      this._trail = new THREE.Line(geo, lmat);
      this._trail.frustumCulled = false;
      parent.add(this._trail);
    }
  }

  /**
   * Per-frame update. Advances the ascent, fades the trail, frees at the end.
   * @param {number} dt — seconds
   */
  update(dt) {
    if (!this._active || !this._layer || !this._sprite) return;
    this._t += dt;
    const t = this._t / CAMEO_DURATION_S;
    if (t >= 1) { this._end(); return; }

    const { radius, mirrorLon, sunLight } = this._layer;
    const pad = this._pad;

    // Head position.
    const head = ascentPoint(pad.lat, pad.lon, radius, t, mirrorLon, pad.azimuthDeg, _headPt);
    this._sprite.position.set(head.x, head.y, head.z);
    this._sprite.scale.setScalar(0.06 + 0.12 * t);

    // Brightness from sun geometry (brightest near the terminator).
    let intensity = 0.8;
    if (sunLight && typeof sunLight.getSunDirection === 'function') {
      const sd = sunLight.getSunDirection();
      const nLen = Math.hypot(head.x, head.y, head.z) || 1;
      const sunDot = (head.x * sd.x + head.y * sd.y + head.z * sd.z) / nLen;
      intensity = cameoIntensity(sunDot);
    }
    // Fade in over the first 10%, out over the last 25%.
    const envelope = Math.min(1, t / 0.1) * (1 - Math.max(0, (t - 0.75) / 0.25));
    const op = Math.min(MAX_OPACITY, intensity * envelope);
    this._sprite.material.opacity = op;

    // Trail: sample the path behind the head, alpha ramping down the tail.
    const posAttr = this._trail.geometry.attributes.position;
    const colAttr = this._trail.geometry.attributes.color;
    for (let i = 0; i < TRAIL_POINTS; i++) {
      const ti = t * (i / (TRAIL_POINTS - 1));
      const p = ascentPoint(pad.lat, pad.lon, radius, ti, mirrorLon, pad.azimuthDeg, _trailPt);
      this._trailPos[i * 3] = p.x;
      this._trailPos[i * 3 + 1] = p.y;
      this._trailPos[i * 3 + 2] = p.z;
      const a = (i / (TRAIL_POINTS - 1)) * op;
      colAttr.array[i * 3] = a;
      colAttr.array[i * 3 + 1] = a * 0.92;
      colAttr.array[i * 3 + 2] = a * 0.75;
    }
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    this._trail.material.opacity = 1;   // alpha carried per-vertex
  }

  /** @private End the cameo and hide the meshes. */
  _end() {
    this._active = false;
    if (this._sprite) this._sprite.material.opacity = 0;
    if (this._trail) this._trail.material.opacity = 0;
  }

  /**
   * Force-reset on GAME_RESET. Without this, a reset within the 16 s cameo
   * window left `_active` stuck true and the next game's fire() silently
   * returned false — dropping the cameo and its comms line (review finding).
   */
  reset() {
    this._end();
  }

  /** Remove meshes from the parent. */
  dispose() {
    if (this._layer && this._sprite) {
      this._layer.parent.remove(this._sprite);
      this._layer.parent.remove(this._trail);
    }
    this._sprite = null;
    this._trail = null;
    this._layer = null;
    this._active = false;
  }
}

/** Singleton (wired in main.js). */
export const launchCameo = new LaunchCameo();
export default LaunchCameo;
