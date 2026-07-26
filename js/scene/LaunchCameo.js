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
 * Pill-flash duration at ignition (seconds). The flash is a short "launching
 * NOW" cue that pulls the eye to the pad — then the plume itself holds it.
 * A flash that runs the whole plume duration competes with the plume.
 */
export const LAUNCH_FLASH_S = 3.5;

/**
 * Fire gate: a pad launches the instant its label pill BEGINS to fade into
 * view (city labels fade in over fd ∈ [0, 0.55]; fd = 0 is the geometric
 * horizon). At 10°/15 s ground speed, 0.15 cost ~8.5 s of "pill visible, no
 * launch" (owner: "Expecting launch IMMEDIATELY when the city pill first
 * begins to fade into view"). 0.03 sits a hair above the horizon so the
 * plume's climb emerges over the limb as the pill appears.
 */
export const FIRE_GATE = 0.03;

/**
 * Max simultaneous plumes. The Thai opening needs two: Wenchang (scripted,
 * 7 s) is still climbing when Sriharikota's pill appears (~17 s) and the
 * ambient launch must fire immediately rather than wait out the first plume.
 */
export const MAX_PLUMES = 2;

/**
 * Frustum margin for the visibility gate. 1.0 = exact frame edge; 1.1 lets the
 * ignition flash start just as the pad reaches the visible edge rather than
 * popping in from off-screen.
 */
export const FRAME_MARGIN = 1.1;

// Scratch for the projection in launchVisible (no per-call allocation).
const _ndc = new THREE.Vector3();

/**
 * THE visibility gate, shared by fire() and the ambient scheduler: the pad is
 * both above the horizon (cityFacingDot > FIRE_GATE) AND inside the camera
 * frustum (NDC within FRAME_MARGIN). A launch the player cannot see is a bug,
 * not a feature — measured 2026-07-26: Wenchang is NEVER on screen from the
 * Thai chase view (NDC x 1.4–8.5), and Sriharikota's on-screen window on th
 * is only ~17–26 s, so firing on facing-dot alone put plumes off-frame.
 * @param {THREE.Vector3} padWorld — pad world position
 * @param {THREE.Vector3} centre — Earth centre (world)
 * @param {THREE.Vector3} camPos — camera world position
 * @param {THREE.Camera} camera — for projection
 * @param {number} [margin=FRAME_MARGIN]
 * @returns {boolean}
 */
export function launchVisible(padWorld, centre, camPos, camera, margin = FRAME_MARGIN) {
  if (cityFacingDot(padWorld, centre, camPos) <= FIRE_GATE) return false;
  _ndc.copy(padWorld).project(camera);
  return _ndc.z < 1 && Math.abs(_ndc.x) <= margin && Math.abs(_ndc.y) <= margin;
}

/**
 * Per-language home pad for the SCRIPTED opening cameo. Chosen by measured
 * on-screen visibility from the chase view (launchVisible), not map distance —
 * the old distance-based picks were wrong where it mattered: Wenchang is NEVER
 * in frame from the th orbit (owner report), and hi's Sriharikota only enters
 * the frame ~518 s in, so hi gets Baikonur (visible at ~18 s). pt has NO pad
 * visible in the opening window, so it gets no scripted cameo — the ambient
 * scheduler fires Alcantara when it enters the frame (~514 s).
 * `azimuthDeg` is the launch heading. Coordinates are NOT stored here — they
 * come from the shared cities list (data/cities.json, kind:'launch', matched
 * by name) so a data correction can't desync the cameo from the pad's label.
 */
export const CAMEO_PADS = {
  en: { name: 'Cape Canaveral', vehicle: 'Falcon 9', azimuthDeg: 90 },
  th: { name: 'Sriharikota', vehicle: 'PSLV', azimuthDeg: 140 },
  ja: { name: 'Tanegashima', vehicle: 'H3', azimuthDeg: 100 },
  es: { name: 'El Arenosillo', vehicle: 'sounding rocket', azimuthDeg: 230 },
  hi: { name: 'Baikonur', vehicle: 'Soyuz', azimuthDeg: 60 },
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

/**
 * Limb compensation for the cameo. A pad seen at grazing angle (small facing
 * dot) is ~2000 km away and heavily foreshortened, so the plume is boosted in
 * brightness and scale — physically defensible (twilight limb plumes are
 * famously bright), and what makes the th/hi cameos readable at all.
 * @param {number} facingDot — cityFacingDot of the pad (0 = horizon, 1 = nadir)
 * @returns {number} multiplier ∈ [1.0, 1.8] (fd ≥ 0.5 → 1.0, fd ≤ 0 → 1.8)
 */
export function limbBoost(facingDot) {
  const k = Math.max(0, Math.min(1, 1 - facingDot / 0.5));
  return 1 + 0.8 * k;
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
    // Plume slots (pool of MAX_PLUMES). Each: {active, t, pad, padWorld,
    // sprite, trail, trailPos}. Meshes are built lazily per slot on first use.
    this._plumes = [];
    for (let i = 0; i < MAX_PLUMES; i++) {
      this._plumes.push({ active: false, t: 0, pad: null, padWorld: null, sprite: null, trail: null, trailPos: null });
    }
    this.firedOnce = false;   // set on first successful fire(); read by the ambient scheduler
  }

  /** @returns {boolean} true while any plume is active (compat for callers). */
  get _active() { return this._plumes.some((p) => p.active); }

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
   * Fire the cameo from a pad, if the pad is on the visible hemisphere and a
   * plume slot is free (up to MAX_PLUMES concurrent).
   * @param {{lat:number,lon:number,name:string,vehicle:string,azimuthDeg?:number}} pad
   * @returns {boolean} true if the cameo started, false if gated out / pool full
   */
  fire(pad) {
    if (!this._layer || !pad) return false;
    if (!Constants.FEATURE_FLAGS.LAUNCH_CAMEO) return false;
    const slot = this._plumes.find((p) => !p.active);
    if (!slot) return false;
    const { parent, radius, camera, mirrorLon } = this._layer;

    // Gate: launch only when the pad is BOTH above the horizon AND on screen —
    // a plume outside the frustum is invisible by definition (owner: "why am I
    // not seeing the launch", 2026-07-26).
    const lonDeg = mirrorLon ? -pad.lon : pad.lon;
    const surf = latLonToPosition(pad.lat, lonDeg, radius);
    _v.set(surf.x, surf.y, surf.z);
    parent.localToWorld(_v);
    parent.getWorldPosition(_c);
    camera.getWorldPosition(this._camPos || (this._camPos = new THREE.Vector3()));
    if (!launchVisible(_v, _c, this._camPos, camera)) return false;

    slot.pad = pad;
    slot.t = 0;
    slot.active = true;
    /** Set on the first successful fire() since the last reset(). The ambient
     * scheduler defers to the scripted opening cameo until this is true. */
    this.firedOnce = true;
    // Cache the pad's world position for the per-frame limb-boost in update().
    slot.padWorld = slot.padWorld || new THREE.Vector3();
    slot.padWorld.copy(_v);
    this._build(slot);
    return true;
  }

  /** @private Build a slot's sprite + trail (lazily, on first fire). */
  _build(slot) {
    const { parent } = this._layer;
    if (!slot.sprite) {
      const map = getRadialGlowTexture({ size: 64, coreStop: 0.0, midStop: 0.35, midAlpha: 0.5 });
      const mat = new THREE.SpriteMaterial({
        map, color: 0xfff2c8, blending: THREE.AdditiveBlending,
        depthWrite: false, transparent: true, opacity: 0,
      });
      slot.sprite = new THREE.Sprite(mat);
      slot.sprite.scale.setScalar(0.06);
      parent.add(slot.sprite);

      const geo = new THREE.BufferGeometry();
      slot.trailPos = new Float32Array(TRAIL_POINTS * 3);
      geo.setAttribute('position', new THREE.BufferAttribute(slot.trailPos, 3));
      const colors = new Float32Array(TRAIL_POINTS * 3);
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      const lmat = new THREE.LineBasicMaterial({
        vertexColors: true, blending: THREE.AdditiveBlending,
        depthWrite: false, transparent: true, opacity: 0,
      });
      slot.trail = new THREE.Line(geo, lmat);
      slot.trail.frustumCulled = false;
      parent.add(slot.trail);
    }
  }

  /**
   * Per-frame update. Advances every active plume, frees finished slots.
   * @param {number} dt — seconds
   */
  update(dt) {
    if (!this._layer) return;
    for (const slot of this._plumes) {
      if (slot.active) this._updatePlume(slot, dt);
    }
  }

  /** @private Advance one plume slot. */
  _updatePlume(slot, dt) {
    slot.t += dt;
    const t = slot.t / CAMEO_DURATION_S;
    if (t >= 1) { this._end(slot); return; }

    const { radius, mirrorLon, sunLight, camera, parent } = this._layer;
    const pad = slot.pad;

    // Limb compensation: grazing-angle pads get a bigger, brighter plume.
    parent.getWorldPosition(_c);
    camera.getWorldPosition(this._camPos || (this._camPos = new THREE.Vector3()));
    const boost = limbBoost(cityFacingDot(slot.padWorld, _c, this._camPos));

    // Head position.
    const head = ascentPoint(pad.lat, pad.lon, radius, t, mirrorLon, pad.azimuthDeg, _headPt);
    slot.sprite.position.set(head.x, head.y, head.z);
    slot.sprite.scale.setScalar((0.06 + 0.12 * t) * boost);

    // Brightness from sun geometry (brightest near the terminator).
    let intensity = 0.8;
    if (sunLight && typeof sunLight.getSunDirection === 'function') {
      const sd = sunLight.getSunDirection();
      const nLen = Math.hypot(head.x, head.y, head.z) || 1;
      const sunDot = (head.x * sd.x + head.y * sd.y + head.z * sd.z) / nLen;
      intensity = cameoIntensity(sunDot);
    }
    // Ignition is near-instant (real launches are bright immediately) — a
    // 4% fade-in (0.64 s) so the flash is visible the moment it matters;
    // then fade out over the last 25%.
    const envelope = Math.min(1, t / 0.04) * (1 - Math.max(0, (t - 0.75) / 0.25));
    // Opacity cap rises with the boost: 0.70 steep (the original restraint)
    // → 0.85 at the limb, where the extra brightness is spent on readability.
    const cap = MAX_OPACITY + 0.15 * (boost - 1) / 0.8;
    const op = Math.min(cap, intensity * envelope * boost);
    slot.sprite.material.opacity = op;

    // Trail: sample the path behind the head, alpha ramping down the tail.
    const posAttr = slot.trail.geometry.attributes.position;
    const colAttr = slot.trail.geometry.attributes.color;
    for (let i = 0; i < TRAIL_POINTS; i++) {
      const ti = t * (i / (TRAIL_POINTS - 1));
      const p = ascentPoint(pad.lat, pad.lon, radius, ti, mirrorLon, pad.azimuthDeg, _trailPt);
      slot.trailPos[i * 3] = p.x;
      slot.trailPos[i * 3 + 1] = p.y;
      slot.trailPos[i * 3 + 2] = p.z;
      const a = (i / (TRAIL_POINTS - 1)) * op;
      colAttr.array[i * 3] = a;
      colAttr.array[i * 3 + 1] = a * 0.92;
      colAttr.array[i * 3 + 2] = a * 0.75;
    }
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    slot.trail.material.opacity = 1;   // alpha carried per-vertex
  }

  /** @private End a plume and free its slot. */
  _end(slot) {
    slot.active = false;
    if (slot.sprite) slot.sprite.material.opacity = 0;
    if (slot.trail) slot.trail.material.opacity = 0;
  }

  /**
   * Force-reset on GAME_RESET. Without this, a reset within the 16 s cameo
   * window left plumes stuck active and the next game's fire() silently
   * returned false — dropping the cameo and its comms line (review finding).
   */
  reset() {
    this.firedOnce = false;
    for (const slot of this._plumes) this._end(slot);
  }

  /** Remove meshes from the parent. */
  dispose() {
    if (this._layer) {
      for (const slot of this._plumes) {
        if (slot.sprite) this._layer.parent.remove(slot.sprite);
        if (slot.trail) this._layer.parent.remove(slot.trail);
        slot.sprite = null;
        slot.trail = null;
        slot.active = false;
      }
    }
    this._layer = null;
  }
}

/** Singleton (wired in main.js). */
export const launchCameo = new LaunchCameo();
export default LaunchCameo;
