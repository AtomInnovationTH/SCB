/**
 * LaunchCameo.js — a launch-plume cameo rising from the player's home spaceport
 * during the opening orbital pass.
 *
 * DESIGN CONSTRAINT: at 1 unit = 100 km a plume climbing to 120 km is a 1.2-unit
 * feature (~7° ≈ 110 px from 1000 km), so it is very visible: restraint is the
 * requirement. Thin (1 px trail), dim (opacity ≤ 0.7), brief (12 s).
 *
 * REALISM LICENCE: a real ascent takes ~8 min; the cameo compresses it ~40× to 12 s.
 * Apogee is 120 km (not the player's 350 km) so the plume never reads as reaching the ship.
 *
 * BLOOM CANNOT BE RELIED ON HERE: main.js gates the bloom pass on
 * SunLight.isBloomSourceVisible(), false on most night-side frames, so the glow is
 * authored explicitly (hot core sprite + larger dimmer halo sprite, both additive)
 * and every colour is LDR. The cameo looks the same whether the gate is open or closed.
 *
 * Anchored to the Earth group with CityLabels' mirrored-longitude convention (the
 * solid Earth never rotates; the sub-point tracks westward, `lonEci = -lonEastDeg`).
 *
 * Pure helpers (`ascentPoint`, `cameoIntensity`, `padFor`) are Node-testable;
 * THREE/DOM lives behind init guards and tolerates a null glow map.
 *
 * @module scene/LaunchCameo
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { latLonToPosition } from './Ephemeris.js';
import { getRadialGlowTexture } from './glowSpriteTexture.js';
import { cityFacingDot } from './CityLabels.js';
import { makePlumeRibbon, updateRibbon } from './plumeRibbon.js';
import { DEG2RAD, degToRad, clamp01, clamp } from '../core/MathUtil.js';

/**
 * Cameo duration in seconds (real ascent ≈ 8 min → ~40× compression). The on-screen
 * window is a wide distribution over all 42 launch opportunities (measured by
 * scripts/visual-ab/launch-plume-geometry-audit.mjs): min 2.3 s, p10 4.0 s, median
 * 15.3 s, p90 21.3 s, max 24.3 s. 12 s overruns 40% of them (16 s: 52%; 24 s: 98%).
 */
export const CAMEO_DURATION_S = 12;
/** Apogee altitude in scene units (1 unit = 100 km → 1.2 = 120 km). */
export const CAMEO_APOGEE_U = 1.2;
/** Downrange distance in scene units (4.0 = 400 km). */
const CAMEO_DOWNRANGE_U = 4.0;
/** Peak opacity cap — keeps the plume a bright thread, not a flare. */
const MAX_OPACITY = 0.7;
/** Halo sprite size as a multiple of the core. */
const HALO_TO_CORE = 3.0;
/** Halo opacity as a fraction of the core's (the atmosphere, not the source). */
const HALO_OPACITY = 0.4;
/**
 * Reference core px (the ignition size) for the area compensation: opacity ∝ (CORE_REF_PX / corePx)² holds mean
 * luminance as the core grows 6→16 px.
 */
const CORE_REF_PX = 6;
/** Seconds the ribbon lingers and dissipates after the head arrives. */
const RIBBON_FADE_S = 1.5;
/** Ribbon colour — cool-white tinted toward the cyan launch glow. */
const _ribbonColor = new THREE.Color(0.55, 0.9, 1.0);

/** Pill-flash duration at ignition (s): a short "launching NOW" cue; a longer flash competes with the plume. */
export const LAUNCH_FLASH_S = 3.5;

/**
 * Fire gate (cityFacingDot; 0 = geometric horizon): a pad launches the instant its
 * label pill BEGINS to fade into view. owner: launch IMMEDIATELY when the pill first
 * fades in. 0.03 sits a hair above the horizon so the climb emerges over the limb
 * as the pill appears.
 */
export const FIRE_GATE = 0.03;

/** Max simultaneous plumes. The Thai opening needs two: Wenchang (scripted, 7 s) is still climbing when Sriharikota's pill appears (~17 s). */
export const MAX_PLUMES = 2;

/** Frustum margin for the visibility gate (NDC; 1.0 = exact frame edge). */
export const FRAME_MARGIN = 1.1;

/**
 * Fire-gate margin (NDC) for the PLUME HEAD: the mid-flight head (t=0.5) must project
 * within it. Measured over all 42 launch opportunities
 * (scripts/visual-ab/launch-plume-geometry-audit.mjs): the pad-only gate averages 75%
 * head-on-frame with 14 bad fires; this lifts it to 90%, 5 bad fires, ZERO good
 * launches lost. 0.8 (not 1.0) keeps the climb off the frame edge.
 */
export const HEAD_GATE_NDC = 0.8;

// Scratch (no per-call allocation): projection in launchVisible; plumeHeadVisible's t=0.5 probe.
const _ndc = new THREE.Vector3();
const _headGatePt = { x: 0, y: 0, z: 0, alt: 0 };

/**
 * THE visibility gate, shared by fire() and the ambient scheduler: the pad is above
 * the horizon (cityFacingDot > FIRE_GATE) AND inside the camera frustum (NDC within
 * FRAME_MARGIN). owner 2026-07-26: a launch the player cannot see is a bug (Wenchang
 * is NEVER on screen from the Thai chase view, NDC x 1.4–8.5; Sriharikota's window
 * there is ~17–26 s).
 * @param {THREE.Vector3} padWorld — pad world position
 * @param {THREE.Vector3} centre — Earth centre (world)
 * @param {THREE.Vector3} camPos — camera world position
 * @returns {boolean}
 */
export function launchVisible(padWorld, centre, camPos, camera, margin = FRAME_MARGIN) {
  if (cityFacingDot(padWorld, centre, camPos) <= FIRE_GATE) return false;
  _ndc.copy(padWorld).project(camera);
  return _ndc.z < 1 && Math.abs(_ndc.x) <= margin && Math.abs(_ndc.y) <= margin;
}

/**
 * THE plume gate, on top of launchVisible() in fire(): will the plume's mid-flight
 * head (t=0.5) be on screen? A pad can sit at the frame edge while its plume climbs
 * out of frame (ja/Taiyuan: pad NDC 1.02, plume 0% visible).
 * @param {number} lat @param {number} lon — pad coordinates (degrees)
 * @param {number} radius — Earth radius (scene units)
 * @param {boolean} mirrorLon — match CityLabels' mirrored-longitude convention
 * @param {number} azimuthDeg — launch heading
 * @returns {boolean} true if the t=0.5 head projects within NDC `gate`
 */
export function plumeHeadVisible(lat, lon, radius, mirrorLon, azimuthDeg, camera, gate = HEAD_GATE_NDC) {
  const h = ascentPoint(lat, lon, radius, 0.5, mirrorLon, azimuthDeg, _headGatePt);
  _ndc.set(h.x, h.y, h.z).project(camera);
  return _ndc.z < 1 && Math.abs(_ndc.x) <= gate && Math.abs(_ndc.y) <= gate;
}

/**
 * Per-language home pad for the SCRIPTED opening cameo, chosen by measured on-screen
 * visibility from the chase view (launchVisible), not map distance: Wenchang is NEVER
 * in frame from the th orbit; hi's Sriharikota enters only ~518 s in, so hi gets
 * Baikonur (~18 s). pt has no pad visible in the opening window, so no scripted
 * cameo (the ambient scheduler fires Alcantara at ~514 s). `azimuthDeg` is the launch
 * heading. Coordinates come from data/cities.json (kind:'launch', matched by name)
 * so a data correction can't desync the cameo from the pad's label.
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
 * Resolve the home pad for a language code from the caller-supplied cities list
 * (cityLabels.getCities() in prod).
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
 * A point on the ascent path. Pass `out` to reuse an object (update() calls this 33×/frame).
 * @param {number} lat @param {number} lon — pad coordinates (degrees)
 * @param {number} radius — Earth radius (scene units)
 * @param {number} t — progress ∈ [0,1]
 * @param {boolean} mirrorLon — match CityLabels' mirrored-longitude convention
 * @param {number} [azimuthDeg=90] — launch heading (90 = due east)
 * @returns {{x:number,y:number,z:number,alt:number}} position + altitude (units)
 */
export function ascentPoint(lat, lon, radius, t, mirrorLon, azimuthDeg = 90, out) {
  const tc = clamp01(t);
  // Up:out ratio sweeps 3.36 → 0.30 (a constant ratio is a straight ballistic diagonal):
  // front-loaded climb, pitching over downrange late. alt exponent must stay ≥ 1: below
  // 1 the slope at t=0 is infinite (the vehicle would jump off the pad).
  const alt = CAMEO_APOGEE_U * (1 - Math.pow(1 - tc, 1.5));   // front-loaded climb
  const down = CAMEO_DOWNRANGE_U * Math.pow(tc, 2.5);         // back-loaded downrange

  const lonDeg = mirrorLon ? -lon : lon;
  const surf = latLonToPosition(lat, lonDeg, radius);
  const nLen = Math.hypot(surf.x, surf.y, surf.z) || 1;
  const nx = surf.x / nLen, ny = surf.y / nLen, nz = surf.z / nLen;

  // Downrange = local east (d(position)/d(lon) in the latLonToPosition frame) rotated by the azimuth around n.
  const la = degToRad(lat), lo = degToRad(lonDeg);
  let ex = -Math.cos(la) * Math.sin(lo), ey = 0, ez = Math.cos(la) * Math.cos(lo);
  const eLen = Math.hypot(ex, ey, ez) || 1;
  ex /= eLen; ez /= eLen;
  // North = n × east.
  let ux = ny * ez - nz * ey, uy = nz * ex - nx * ez, uz = nx * ey - ny * ex;
  const az = degToRad(azimuthDeg);
  const ca = Math.cos(az), sa = Math.sin(az);
  const dx = ex * ca + ux * sa, dy = ey * ca + uy * sa, dz = ez * ca + uz * sa;

  // Projected back onto the sphere of radius R+alt.
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
 * Plume brightness from sun geometry. Brightest near the terminator (a twilight
 * plume). The day floor is 0.70 because day-side contrast measured only 1.24–1.72
 * and needs ~2×; the midnight floor stays 0.45 (dark-adapted).
 * @param {number} sunDot — dot(surfaceNormal, sunDirection) ∈ [-1,1]
 * @returns {number} intensity ∈ [0.45, 1.0]
 */
export function cameoIntensity(sunDot) {
  // Day side (sunDot > 0): 0.70 at noon → 1.0 at the terminator.
  // Night side (sunDot < 0): 0.45 at midnight → 1.0 at the terminator.
  const v = sunDot >= 0
    ? 0.70 + 0.30 * (1 - sunDot)
    : 0.45 + 0.55 * (1 + sunDot);
  return clamp(v, 0.45, 1.0);
}

/**
 * Limb compensation: a pad at grazing angle is ~2000 km away and heavily
 * foreshortened, so the plume is boosted (what makes the th/hi cameos readable).
 * @param {number} facingDot — cityFacingDot of the pad (0 = horizon, 1 = nadir)
 * @returns {number} multiplier ∈ [1.0, 1.8] (fd ≥ 0.5 → 1.0, fd ≤ 0 → 1.8)
 */
export function limbBoost(facingDot) {
  const k = clamp01(1 - facingDot / 0.5);
  return 1 + 0.8 * k;
}

/**
 * Target on-screen CORE size in px over the flight: 6 px at ignition → 16 px at
 * apogee. Scaling by facing-dot alone gave a 10× spread (4.3–44.0 px) across passes.
 * @param {number} t — progress ∈ [0,1]
 * @returns {number} target core diameter in px
 */
export function coreTargetPx(t) {
  const tc = clamp01(t);
  return 6 + 10 * tc;   // 6 px → 16 px
}

/**
 * Convert a desired on-screen size (px) to a sprite world size at a slant range:
 * worldSize = slant × tan(px / pxPerDeg degrees).
 * @param {number} px — desired on-screen size (px)
 * @param {number} slantKm — camera→head slant range (km)
 * @param {number} pxPerDeg — viewport scale (px per degree, = heightPx / FOV)
 * @returns {number} sprite world size (scene units; 1 unit = 100 km)
 */
export function worldSizeForPx(px, slantKm, pxPerDeg) {
  const angRad = (px / pxPerDeg) * DEG2RAD;
  return (slantKm * Math.tan(angRad)) / 100;   // km → scene units
}

/**
 * The shared ignition ramp: full brightness over the first 4% (~0.5 s at 12 s).
 * Shared by the head envelope and the ribbon so the two can't drift.
 * @param {number} t — progress ∈ [0,1]
 * @returns {number} ramp ∈ [0,1]
 */
export function plumeFadeIn(t) {
  return Math.min(1, Math.max(0, t) / 0.04);
}

/**
 * The show-arc envelope: near-instant ignition, a plateau through the climb, and a
 * short fade over the last 12% so the head doesn't hard-cut at t=1. Peak is at
 * t ≈ 0.5–0.88 (4 of 33 gated fires are already leaving frame by t=1).
 * @param {number} t — progress ∈ [0,1]
 * @returns {number} envelope ∈ [0,1]
 */
export function plumeEnvelope(t) {
  const tc = clamp01(t);
  const fadeOut = 1 - Math.max(0, (tc - 0.88) / 0.12);   // fade last 12%
  return plumeFadeIn(tc) * fadeOut;
}

// Module scratch (no per-frame allocation); the ribbon uses its own inside plumeRibbon.js.
const _v = new THREE.Vector3();
const _c = new THREE.Vector3();
const _headPt = { x: 0, y: 0, z: 0, alt: 0 };

export class LaunchCameo {
  constructor() {
    this._layer = null;
    // Plume slot pool (MAX_PLUMES); meshes are built lazily on first use.
    this._plumes = [];
    for (let i = 0; i < MAX_PLUMES; i++) {
      this._plumes.push({ active: false, t: 0, phase: 'rise', endOpacity: 0, pad: null, azimuthDeg: 90, padWorld: null, pointAt: null, sprite: null, halo: null, ribbon: null });
    }
    this.firedOnce = false;   // set on first successful fire(); read by the ambient scheduler
    /** Why the last fire() returned false: 'pool' (transient), 'gate'/'geometry'
     * (permanent this pass), 'unavailable', or null. Read by the ambient scheduler. */
    this.lastRefusal = null;
  }

  /** @returns {boolean} true while any plume is active. */
  get _active() { return this._plumes.some((p) => p.active); }

  /**
   * @param {THREE.Object3D} opts.parent — the Earth group the plume rides with
   * @param {number} opts.radius — Earth radius (scene units)
   * @param {THREE.Camera} opts.camera — for the visibility gates
   * @param {boolean} [opts.mirrorLon=true] — match CityLabels
   * @param {object} [opts.sunLight] — SunLight instance (getSunDirection)
   */
  attach({ parent, radius, camera, mirrorLon = true, sunLight = null }) {
    if (!parent || !camera || typeof document === 'undefined') return null;
    this._layer = { parent, radius, camera, mirrorLon, sunLight };
    return this._layer;
  }

  /**
   * Fire the cameo from a pad if it passes both visibility gates and a plume slot is free.
   * On `false`, `this.lastRefusal` says why, so the ambient scheduler can tell a TRANSIENT
   * refusal ('pool': keep the edge live) from a PERMANENT one ('gate'/'geometry': consume
   * the edge; pinning it let a geometrically-doomed pad win chooseAmbientPad every tick
   * and starve fireable pads).
   * @param {{lat:number,lon:number,name:string,vehicle:string,azimuthDeg?:number}} pad
   * @returns {boolean} true if the cameo started, false if gated out / pool full
   */
  fire(pad) {
    this.lastRefusal = null;
    if (!this._layer || !pad) { this.lastRefusal = 'unavailable'; return false; }
    if (!Constants.FEATURE_FLAGS.LAUNCH_CAMEO) { this.lastRefusal = 'unavailable'; return false; }
    const slot = this._plumes.find((p) => !p.active);
    if (!slot) { this.lastRefusal = 'pool'; return false; }   // transient — a slot frees soon
    const { parent, radius, camera, mirrorLon } = this._layer;

    // Gate 1: pad above the horizon AND on screen.
    const lonDeg = mirrorLon ? -pad.lon : pad.lon;
    const surf = latLonToPosition(pad.lat, lonDeg, radius);
    _v.set(surf.x, surf.y, surf.z);
    parent.localToWorld(_v);
    parent.getWorldPosition(_c);
    camera.getWorldPosition(this._camPos || (this._camPos = new THREE.Vector3()));
    if (!launchVisible(_v, _c, this._camPos, camera)) { this.lastRefusal = 'gate'; return false; }

    // Gate 2: the plume's mid-flight head must be on screen too (PERMANENT refusal for
    // this pass). Uses the SAME azimuth as the flight so the gate predicts the real arc.
    const azimuthDeg = (typeof pad.azimuthDeg === 'number') ? pad.azimuthDeg : 90;
    if (!plumeHeadVisible(pad.lat, pad.lon, radius, mirrorLon, azimuthDeg, camera)) { this.lastRefusal = 'geometry'; return false; }

    slot.pad = pad;
    slot.azimuthDeg = azimuthDeg;
    slot.t = 0;
    slot.active = true;
    /** Set on the first successful fire() since reset(); the ambient scheduler defers to the scripted cameo until then. */
    this.firedOnce = true;
    // Cached for the per-frame limb boost.
    slot.padWorld = slot.padWorld || new THREE.Vector3();
    slot.padWorld.copy(_v);
    // Ribbon ascent-path closure built once per fire (not per frame); captures this
    // pad/azimuth so a reused slot points at its own pad.
    const lat = pad.lat, lon = pad.lon;
    slot.pointAt = (tt, out) => ascentPoint(lat, lon, radius, tt, mirrorLon, azimuthDeg, out);
    this._build(slot);
    return true;
  }

  /** @private Build a slot's core + halo sprites + trail (lazily, on first fire). */
  _build(slot) {
    const { parent } = this._layer;
    if (!slot.sprite) {
      // Two additive sprites (hot CORE + larger dimmer HALO; see module header on bloom).
      // Cool-white per KIND_STYLE.launch (CityLabels.js) so the plume doesn't read as one
      // warm blob among warm city lights.
      const coreMap = getRadialGlowTexture({ size: 64, coreStop: 0.0, midStop: 0.3, midAlpha: 0.7 });
      const coreMat = new THREE.SpriteMaterial({
        map: coreMap, color: 0xe6faff, blending: THREE.AdditiveBlending,
        depthWrite: false, transparent: true, opacity: 0,
      });
      slot.sprite = new THREE.Sprite(coreMat);
      slot.sprite.scale.setScalar(0.06);
      parent.add(slot.sprite);

      // Halo tinted toward the cyan launch glow rgb(80,210,255).
      const haloMap = getRadialGlowTexture({ size: 64, coreStop: 0.0, midStop: 0.5, midAlpha: 0.28 });
      const haloMat = new THREE.SpriteMaterial({
        map: haloMap, color: 0x50d2ff, blending: THREE.AdditiveBlending,
        depthWrite: false, transparent: true, opacity: 0,
      });
      slot.halo = new THREE.Sprite(haloMat);
      slot.halo.scale.setScalar(0.18);
      parent.add(slot.halo);

      // Trail: tapered camera-facing RIBBON (one draw call), rewritten per frame in _updatePlume.
      if (!slot.ribbon) {
        slot.ribbon = makePlumeRibbon();
        parent.add(slot.ribbon);
      }
    }
  }

  /** @param {number} dt — seconds */
  update(dt) {
    if (!this._layer) return;
    for (const slot of this._plumes) {
      if (slot.active) this._updatePlume(slot, dt);
    }
  }

  /** @private Advance one plume slot. */
  _updatePlume(slot, dt) {
    slot.t += dt;
    const { radius, mirrorLon, sunLight, camera, parent } = this._layer;
    const pad = slot.pad;
    // Viewport scale, shared by core-sprite sizing and the ribbon (they must agree or
    // head and trail drift). Headless fallback = the audit's 1440×763 reference.
    const heightPx = (typeof window !== 'undefined' && window.innerHeight) ? window.innerHeight : 763;
    const pxPerDeg = heightPx / Constants.CAMERA_FOV;

    // SOFT END: the head is hidden at t=1 (the vehicle "arrives"); the RIBBON then
    // dissipates over RIBBON_FADE_S in the SAME slot (phase 'fade').
    if (slot.phase === 'fade') {
      const k = (slot.t - CAMEO_DURATION_S) / RIBBON_FADE_S;
      if (k >= 1) { this._end(slot); return; }
      this._drawRibbon(slot, 1, (1 - k) * slot.endOpacity, pxPerDeg);
      return;
    }

    const t = slot.t / CAMEO_DURATION_S;
    if (t >= 1) {
      // slot.endOpacity holds the ribbon's SUSTAINED opacity (set on the last rise
      // frame): fade FROM that, not the head's collapsed value.
      if (slot.sprite) slot.sprite.material.opacity = 0;
      if (slot.halo) slot.halo.material.opacity = 0;
      slot.phase = 'fade';
      return;
    }

    // Limb boost: brightness only; size uses slant range.
    parent.getWorldPosition(_c);
    camera.getWorldPosition(this._camPos || (this._camPos = new THREE.Vector3()));
    const boost = limbBoost(cityFacingDot(slot.padWorld, _c, this._camPos));

    // Head position + slant range.
    const head = ascentPoint(pad.lat, pad.lon, radius, t, mirrorLon, slot.azimuthDeg, _headPt);
    slot.sprite.position.set(head.x, head.y, head.z);
    if (slot.halo) slot.halo.position.set(head.x, head.y, head.z);
    _v.set(head.x, head.y, head.z);
    parent.localToWorld(_v);
    const slantKm = _v.distanceTo(this._camPos) * 100;

    // Sprite world size from the slant range holds the core in a ~6–16 px band; halo is a fixed multiple.
    const corePx = coreTargetPx(t);
    const coreWorld = worldSizeForPx(corePx, slantKm, pxPerDeg);
    slot.sprite.scale.setScalar(coreWorld);
    if (slot.halo) slot.halo.scale.setScalar(coreWorld * HALO_TO_CORE);

    // Brightness; each term owns one concern:
    //   intensity(sunDot) — SUN GEOMETRY.
    //   envelope(t)       — SHOW ARC.
    //   boost(fd)         — DISTANCE (limbBoost foreshortening compensation).
    //   areaComp          — AREA: opacity ∝ (ref/cur)² holds mean luminance as the core grows.
    //   cap               — CEILING, not a factor. Rises with boost (0.70→0.85).
    let intensity = 0.8;
    if (sunLight && typeof sunLight.getSunDirection === 'function') {
      const sd = sunLight.getSunDirection();
      const nLen = Math.hypot(head.x, head.y, head.z) || 1;
      const sunDot = (head.x * sd.x + head.y * sd.y + head.z * sd.z) / nLen;
      intensity = cameoIntensity(sunDot);
    }
    const envelope = plumeEnvelope(t);
    const areaComp = (CORE_REF_PX / corePx) * (CORE_REF_PX / corePx);
    const cap = MAX_OPACITY + 0.15 * (boost - 1) / 0.8;
    const op = Math.min(cap, intensity * envelope * boost * areaComp);
    slot.sprite.material.opacity = op;
    // Halo: the same expression at a fixed fraction (the atmosphere, not the source).
    if (slot.halo) slot.halo.material.opacity = op * HALO_OPACITY;

    // The RIBBON uses a SUSTAINED envelope (fade-in only): the trail must HOLD through
    // arrival so the 'fade' phase can dissipate it, not vanish with the head's end-fade.
    const opRibbon = Math.min(cap, intensity * plumeFadeIn(t) * boost * areaComp);
    slot.endOpacity = opRibbon;   // remembered for the 'fade' phase
    this._drawRibbon(slot, t, opRibbon, pxPerDeg);
  }

  /**
   * @private Rewrite the slot's ribbon along the ascent path up to `tHead` at master
   * `opacity`; shared by the 'rise' and 'fade' phases.
   * @param {number} tHead ∈ [0,1]
   * @param {number} pxPerDeg — shared viewport scale from _updatePlume
   */
  _drawRibbon(slot, tHead, opacity, pxPerDeg) {
    if (!slot.ribbon || !slot.pointAt) return;
    const { camera, parent } = this._layer;
    updateRibbon(slot.ribbon, {
      pointAt: slot.pointAt,
      tHead,
      apogeeKm: CAMEO_APOGEE_U * 100,
      parent,
      camera,
      pxPerDeg,
      opacity,
      color: _ribbonColor,
    });
  }

  /** @private End a plume and free its slot. */
  _end(slot) {
    slot.active = false;
    slot.phase = 'rise';
    slot.endOpacity = 0;
    if (slot.sprite) slot.sprite.material.opacity = 0;
    if (slot.halo) slot.halo.material.opacity = 0;
    if (slot.ribbon) slot.ribbon.material.opacity = 0;
  }

  /** Force-reset on GAME_RESET: otherwise plumes stay active and the next game's fire() silently returns false. */
  reset() {
    this.firedOnce = false;
    for (const slot of this._plumes) this._end(slot);
  }

  dispose() {
    if (this._layer) {
      for (const slot of this._plumes) {
        if (slot.sprite) this._layer.parent.remove(slot.sprite);
        if (slot.halo) this._layer.parent.remove(slot.halo);
        if (slot.ribbon) this._layer.parent.remove(slot.ribbon);
        slot.sprite = null;
        slot.halo = null;
        slot.ribbon = null;
        slot.active = false;
      }
    }
    this._layer = null;
  }
}

/** Singleton (wired in main.js). */
export const launchCameo = new LaunchCameo();
export default LaunchCameo;
