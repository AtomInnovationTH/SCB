/**
 * LaunchCameo.js — a single launch-plume cameo rising from the player's home
 * spaceport during the opening orbital pass.
 *
 * DESIGN CONSTRAINT: at 1 unit = 100 km, a plume climbing to 120 km is a
 * 1.2-unit feature; seen from 1000 km that subtends ~7° ≈ 110 px on a 900 px
 * screen. So this is a *very* visible element — restraint, not visibility, is
 * the design requirement. It is kept thin (a 1 px trail), dim (opacity capped
 * at 0.7), and brief (12 s — see the window distribution below).
 *
 * REALISM LICENCE: a real ascent to orbit takes ~8 minutes; the cameo
 * compresses it ~40× to 12 s so the whole climb is watchable during the
 * opening pass. Apogee is capped at 120 km (a sub-orbital-looking arc) rather
 * than the player's 350 km, so the plume never reads as reaching the ship.
 *
 * TWO FACTS every earlier attempt got wrong (measured by
 * scripts/visual-ab/launch-plume-geometry-audit.mjs; see the plan):
 *   1. The on-screen window is a WIDE distribution, not a number: min 2.3 s,
 *      p10 4.0 s, median 15.3 s, p90 21.3 s, max 24.3 s across all 42 launch
 *      opportunities. CAMEO_DURATION_S = 12 overruns 40% of them (16 overran
 *      52%; 24 would overrun 98%).
 *   2. BLOOM CANNOT BE RELIED ON HERE. main.js gates the bloom pass on
 *      SunLight.isBloomSourceVisible(), which is false on most night-side
 *      frames (it is true only when the sun or a blooming body such as Venus is
 *      in view), so the UnrealBloom mip chain is usually NOT running while these
 *      launches play. The glow is therefore authored explicitly (a hot core
 *      sprite + a larger dimmer halo sprite, both additive) — NOT by pushing a
 *      colour past the bloom threshold. That also means the cameo looks the same
 *      whether the gate happens to be open or closed: every colour here is LDR.
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
import { makePlumeRibbon, updateRibbon } from './plumeRibbon.js';

/**
 * Cameo duration in seconds (real ascent ≈ 8 min → ~40× compression).
 * Measured (audit, §3): the on-screen window is a WIDE distribution — min 2.3 s,
 * p10 4.0 s, median 15.3 s, p90 21.3 s, max 24.3 s. 52% of windows are SHORTER
 * than the old 16 s, so the cameo overran half its own opportunities (the plume
 * kept climbing after the pad left the frame). 12 s overruns only 40%; 24 s
 * would overrun 98%. No external consumers — only the division in _updatePlume.
 */
export const CAMEO_DURATION_S = 12;
/** Apogee altitude in scene units (1 unit = 100 km → 1.2 = 120 km). */
export const CAMEO_APOGEE_U = 1.2;
/** Downrange distance in scene units (4.0 = 400 km). */
const CAMEO_DOWNRANGE_U = 4.0;
/** Peak opacity cap — keeps the plume a bright thread, not a flare. */
const MAX_OPACITY = 0.7;
/** Halo sprite size as a multiple of the core (Task 3.1). */
const HALO_TO_CORE = 3.0;
/** Halo opacity as a fraction of the core's (the atmosphere, not the source). */
const HALO_OPACITY = 0.4;
/** Reference core px for the area-compensation term (Task 4.3): the ignition
 * size. opacity ∝ (CORE_REF_PX / corePx)² holds mean luminance as the core
 * grows 6→16 px, so the payoff head doesn't pile on additive energy. */
const CORE_REF_PX = 6;
/** Seconds the ribbon lingers and dissipates after the head arrives (Task 8). */
const RIBBON_FADE_S = 1.5;
/** Ribbon colour — cool-white tinted toward the cyan launch glow (Task 3.2). */
const _ribbonColor = new THREE.Color(0.55, 0.9, 1.0);

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

/**
 * Fire-gate margin for the PLUME HEAD (Task 1). launchVisible() tests the PAD;
 * what the player must actually see is the plume. Measured across all 42 launch
 * opportunities (scripts/visual-ab/launch-plume-geometry-audit.mjs): the pad-only
 * gate averages 75% head-on-frame with 14 bad fires (incl. ja/Taiyuan at NDC 1.02
 * — literally off-screen, 0% visible). Requiring the mid-flight head (t=0.5) to
 * project within NDC 0.8 lifts the average to 90%, cuts bad fires to 5, and loses
 * ZERO good launches. 0.8 (not 1.0) keeps the climb from skimming the frame edge.
 */
export const HEAD_GATE_NDC = 0.8;

// Scratch for the projection in launchVisible (no per-call allocation).
const _ndc = new THREE.Vector3();
// Scratch ascent point for plumeHeadVisible's t=0.5 probe (no per-call allocation).
const _headGatePt = { x: 0, y: 0, z: 0, alt: 0 };

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
 * THE plume gate, layered on top of launchVisible() in fire(): is the plume's
 * mid-flight head (t=0.5) actually going to be on screen? The pad passing
 * launchVisible is necessary but NOT sufficient — a pad can sit at the frame
 * edge (NDC up to FRAME_MARGIN=1.1) while its plume climbs out of frame
 * entirely (ja/Taiyuan: pad NDC 1.02, plume 0% visible, fires twice a session).
 *
 * Costs one ascentPoint + project at fire time. No prediction, no new state.
 * Pure and Node-testable (mirrors the audit's winning gate, §4 of the plan).
 * @param {number} lat @param {number} lon — pad coordinates (degrees)
 * @param {number} radius — Earth radius (scene units)
 * @param {boolean} mirrorLon — match CityLabels' mirrored-longitude convention
 * @param {number} azimuthDeg — launch heading
 * @param {THREE.Camera} camera — for projection
 * @param {number} [gate=HEAD_GATE_NDC]
 * @returns {boolean} true if the t=0.5 head projects within NDC `gate`
 */
export function plumeHeadVisible(lat, lon, radius, mirrorLon, azimuthDeg, camera, gate = HEAD_GATE_NDC) {
  const h = ascentPoint(lat, lon, radius, 0.5, mirrorLon, azimuthDeg, _headGatePt);
  _ndc.set(h.x, h.y, h.z).project(camera);
  return _ndc.z < 1 && Math.abs(_ndc.x) <= gate && Math.abs(_ndc.y) <= gate;
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
  // Task 5 (verified on-frame-NEUTRAL by the audit, §5): the OLD exponents gave a
  // near-CONSTANT up:out ratio (0.52 → 0.30), and a constant ratio is a straight
  // line — the arc read as a ballistic diagonal with no vertical phase. The new
  // curves sweep 3.36 → 0.30: a front-loaded climb (vertical early) that pitches
  // over downrange late. Exponents stay ≥ 1 on alt so the slope at t=0 is finite
  // (an exponent < 1 gives infinite slope — the vehicle would jump off the pad).
  // Assertions preserved: alt 0 at t=0, monotonic, = CAMEO_APOGEE_U at t=1.
  const alt = CAMEO_APOGEE_U * (1 - Math.pow(1 - tc, 1.5));   // front-loaded climb
  const down = CAMEO_DOWNRANGE_U * Math.pow(tc, 2.5);         // back-loaded downrange

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
/**
 * Plume brightness from sun geometry. Brightest near the terminator (the
 * physically correct behaviour for a twilight plume).
 *
 * Task 4.4 — the DAYTIME floor is lifted 0.45 → 0.70: the plume was dimmest
 * exactly where the background is brightest (measured day-side contrast only
 * 1.24–1.72; it needs ~2×). The terminator peak stays 1.0 and the midnight
 * floor stays 0.45 (dark-adapted) — only the day side is raised.
 * @param {number} sunDot — dot(surfaceNormal, sunDirection) ∈ [-1,1]
 * @returns {number} intensity ∈ [0.45, 1.0]
 */
export function cameoIntensity(sunDot) {
  // Day side (sunDot > 0): 0.70 at noon → 1.0 at the terminator.
  // Night side (sunDot < 0): 0.45 at midnight → 1.0 at the terminator.
  const v = sunDot >= 0
    ? 0.70 + 0.30 * (1 - sunDot)
    : 0.45 + 0.55 * (1 + sunDot);
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

/**
 * Target on-screen CORE size in px over the flight (Task 3.3). The measured
 * defect was a 10× spread in apparent head size (4.3–44.0 px) because the old
 * code scaled the sprite by limbBoost's facing-dot only, never the actual slant
 * range — a close pass got a 44 px blob, a distant one a 4 px speck. We instead
 * hold the core in a tight band that grows gently with the climb: ~6 px at
 * ignition → ~16 px at apogee (the payoff). Pure and Node-testable.
 * @param {number} t — progress ∈ [0,1]
 * @returns {number} target core diameter in px
 */
export function coreTargetPx(t) {
  const tc = Math.max(0, Math.min(1, t));
  return 6 + 10 * tc;   // 6 px → 16 px
}

/**
 * Convert a desired on-screen size (px) to a sprite world size (scene units) at
 * a given slant range — the actual-distance compensation the old code lacked
 * (Task 3.3). worldSize = slant × angularSize, where angularSize = px / pxPerDeg
 * in degrees. Pure and Node-testable.
 * @param {number} px — desired on-screen size (px)
 * @param {number} slantKm — camera→head slant range (km)
 * @param {number} pxPerDeg — viewport scale (px per degree, = heightPx / FOV)
 * @returns {number} sprite world size (scene units; 1 unit = 100 km)
 */
export function worldSizeForPx(px, slantKm, pxPerDeg) {
  const angRad = (px / pxPerDeg) * (Math.PI / 180);
  return (slantKm * Math.tan(angRad)) / 100;   // km → scene units
}

/**
 * The shared ignition ramp (Fix: dedup). Real launches are bright near-instantly,
 * so both the head envelope and the ribbon's sustain ramp reach full brightness
 * over the first 4% (~0.5 s at 12 s). Extracted so the head and trail can't
 * drift if the ramp is ever tuned. Pure and Node-testable.
 * @param {number} t — progress ∈ [0,1]
 * @returns {number} ramp ∈ [0,1]
 */
export function plumeFadeIn(t) {
  return Math.min(1, Math.max(0, t) / 0.04);
}

/**
 * The show-arc envelope (Task 4.1–4.2). The OLD envelope faded out over the last
 * 25% — opacity was ~0.15 at the payoff, a straight bug. The new envelope:
 * near-instant ignition (real launches are bright immediately), a sustained
 * plateau through the climb, and a SHORT fade only over the last 12% so the head
 * doesn't hard-cut at t=1. Peak sits at t ≈ 0.5–0.88 (not t=1: with a 12 s
 * flight, 4 of 33 gated fires are already leaving frame by then).
 * Pure and Node-testable.
 * @param {number} t — progress ∈ [0,1]
 * @returns {number} envelope ∈ [0,1]
 */
export function plumeEnvelope(t) {
  const tc = Math.max(0, Math.min(1, t));
  const fadeOut = 1 - Math.max(0, (tc - 0.88) / 0.12);   // fade last 12%
  return plumeFadeIn(tc) * fadeOut;
}

// Module scratch vectors (no per-frame allocation).
const _v = new THREE.Vector3();
const _c = new THREE.Vector3();
// Scratch ascent point for update()'s head call (no per-frame allocation).
// (The ribbon trail uses its own scratch inside plumeRibbon.js.)
const _headPt = { x: 0, y: 0, z: 0, alt: 0 };

export class LaunchCameo {
  constructor() {
    this._layer = null;
    // Plume slots (pool of MAX_PLUMES). Each: {active, t, pad, padWorld,
    // sprite, trail, trailPos}. Meshes are built lazily per slot on first use.
    this._plumes = [];
    for (let i = 0; i < MAX_PLUMES; i++) {
      this._plumes.push({ active: false, t: 0, phase: 'rise', endOpacity: 0, pad: null, azimuthDeg: 90, padWorld: null, pointAt: null, sprite: null, halo: null, ribbon: null });
    }
    this.firedOnce = false;   // set on first successful fire(); read by the ambient scheduler
    /** Why the last fire() returned false: 'pool' (transient), 'gate'/'geometry'
     * (permanent this pass), 'unavailable', or null (last call succeeded / never
     * called). Read by the ambient scheduler to decide edge pinning. */
    this.lastRefusal = null;
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
   *
   * On a `false` return, `this.lastRefusal` records WHY so the ambient scheduler
   * can tell a TRANSIENT refusal ('pool' — a slot frees shortly, keep the edge
   * live) from a PERMANENT one ('gate'/'geometry' — the pad/plume is off-frame
   * this pass and retrying next tick will refuse again, so consume the edge).
   * Review finding: pinning the edge on a permanent refusal let a geometrically-
   * doomed pad win chooseAmbientPad every tick and starve fireable pads.
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

    // Gate: launch only when the pad is BOTH above the horizon AND on screen —
    // a plume outside the frustum is invisible by definition (owner: "why am I
    // not seeing the launch", 2026-07-26).
    const lonDeg = mirrorLon ? -pad.lon : pad.lon;
    const surf = latLonToPosition(pad.lat, lonDeg, radius);
    _v.set(surf.x, surf.y, surf.z);
    parent.localToWorld(_v);
    parent.getWorldPosition(_c);
    camera.getWorldPosition(this._camPos || (this._camPos = new THREE.Vector3()));
    if (!launchVisible(_v, _c, this._camPos, camera)) { this.lastRefusal = 'gate'; return false; }

    // Gate 2 (Task 1): the PAD being on screen is not enough — require the
    // plume's mid-flight head to be on screen too. This is a PERMANENT geometric
    // refusal for this pass (unlike the transient pool-full case). Use the SAME
    // azimuth the flight will use so the gate predicts the real arc (Task 6).
    const azimuthDeg = (typeof pad.azimuthDeg === 'number') ? pad.azimuthDeg : 90;
    if (!plumeHeadVisible(pad.lat, pad.lon, radius, mirrorLon, azimuthDeg, camera)) { this.lastRefusal = 'geometry'; return false; }

    slot.pad = pad;
    slot.azimuthDeg = azimuthDeg;   // resolved at fire time; flight matches the gate
    slot.t = 0;
    slot.active = true;
    /** Set on the first successful fire() since the last reset(). The ambient
     * scheduler defers to the scripted opening cameo until this is true. */
    this.firedOnce = true;
    // Cache the pad's world position for the per-frame limb-boost in update().
    slot.padWorld = slot.padWorld || new THREE.Vector3();
    slot.padWorld.copy(_v);
    // Build the ribbon's ascent-path closure ONCE here (Fix 4): it captures the
    // fire-time pad/azimuth and the layer's radius/mirrorLon, so _drawRibbon
    // doesn't allocate a fresh closure every frame. Rebuilt each fire (cheap,
    // once per launch) so a reused slot always points at its own pad.
    const lat = pad.lat, lon = pad.lon;
    slot.pointAt = (tt, out) => ascentPoint(lat, lon, radius, tt, mirrorLon, azimuthDeg, out);
    this._build(slot);
    return true;
  }

  /** @private Build a slot's core + halo sprites + trail (lazily, on first fire). */
  _build(slot) {
    const { parent } = this._layer;
    if (!slot.sprite) {
      // Task 3.1 — bloom is OFF on the night side (see module header), so the
      // glow is authored EXPLICITLY as two additive sprites: a small hot CORE
      // plus a larger, dimmer HALO. No reliance on the bloom threshold.
      // Task 3.2 — cool-white, NOT the old warm 0xfff2c8. This applies the
      // existing launch-pad convention (KIND_STYLE.launch = #e6faff + cyan
      // glow, CityLabels.js) so the plume stops reading as one warm round blob
      // among dozens of warm city-light blobs on the night side.
      const coreMap = getRadialGlowTexture({ size: 64, coreStop: 0.0, midStop: 0.3, midAlpha: 0.7 });
      const coreMat = new THREE.SpriteMaterial({
        map: coreMap, color: 0xe6faff, blending: THREE.AdditiveBlending,
        depthWrite: false, transparent: true, opacity: 0,
      });
      slot.sprite = new THREE.Sprite(coreMat);
      slot.sprite.scale.setScalar(0.06);
      parent.add(slot.sprite);

      // Halo: larger, dimmer, tinted toward the cyan launch glow rgb(80,210,255).
      const haloMap = getRadialGlowTexture({ size: 64, coreStop: 0.0, midStop: 0.5, midAlpha: 0.28 });
      const haloMat = new THREE.SpriteMaterial({
        map: haloMap, color: 0x50d2ff, blending: THREE.AdditiveBlending,
        depthWrite: false, transparent: true, opacity: 0,
      });
      slot.halo = new THREE.Sprite(haloMat);
      slot.halo.scale.setScalar(0.18);
      parent.add(slot.halo);

      // Task 7 — the trail is a tapered, camera-facing RIBBON (one draw call),
      // not a 1 px THREE.Line. Built once, rewritten per frame in _updatePlume.
      if (!slot.ribbon) {
        slot.ribbon = makePlumeRibbon();
        parent.add(slot.ribbon);
      }
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
    const { radius, mirrorLon, sunLight, camera, parent } = this._layer;
    const pad = slot.pad;
    // Viewport scale, computed ONCE per slot-frame and shared by the core-sprite
    // sizing and the ribbon (Fix 5 — they must agree or head and trail drift).
    // Headless fallback = the audit's 1440×763 reference.
    const heightPx = (typeof window !== 'undefined' && window.innerHeight) ? window.innerHeight : 763;
    const pxPerDeg = heightPx / Constants.CAMERA_FOV;

    // Task 8 — SOFT END. The head (core+halo) plays the rise and is hidden at
    // t=1 (the vehicle "arrives"); the RIBBON then lingers and dissipates over
    // RIBBON_FADE_S inside the SAME slot (phase 'fade'). No decay pool, no new
    // reset()/dispose() surface — just one extra phase value.
    if (slot.phase === 'fade') {
      const k = (slot.t - CAMEO_DURATION_S) / RIBBON_FADE_S;
      if (k >= 1) { this._end(slot); return; }
      this._drawRibbon(slot, 1, (1 - k) * slot.endOpacity, pxPerDeg);
      return;
    }

    const t = slot.t / CAMEO_DURATION_S;
    if (t >= 1) {
      // slot.endOpacity already holds the ribbon's SUSTAINED opacity (set on
      // the last rise frame) — fade FROM that, not the head's collapsed value.
      // Hide the head (the vehicle has arrived) and switch to 'fade'.
      if (slot.sprite) slot.sprite.material.opacity = 0;
      if (slot.halo) slot.halo.material.opacity = 0;
      slot.phase = 'fade';
      return;
    }

    // Limb compensation: grazing-angle pads get a BRIGHTER plume (distance /
    // foreshortening). Kept for brightness only — size now uses slant range.
    parent.getWorldPosition(_c);
    camera.getWorldPosition(this._camPos || (this._camPos = new THREE.Vector3()));
    const boost = limbBoost(cityFacingDot(slot.padWorld, _c, this._camPos));

    // Head position + actual slant range (Task 3.3).
    const head = ascentPoint(pad.lat, pad.lon, radius, t, mirrorLon, slot.azimuthDeg, _headPt);
    slot.sprite.position.set(head.x, head.y, head.z);
    if (slot.halo) slot.halo.position.set(head.x, head.y, head.z);
    _v.set(head.x, head.y, head.z);
    parent.localToWorld(_v);
    const slantKm = _v.distanceTo(this._camPos) * 100;

    // Task 3.3 — clamp APPARENT size: derive the sprite world size from the
    // actual slant range so the core holds a ~6–16 px band on every gated fire
    // (was 4.3–44 px under facing-dot-only scaling). The halo is a fixed
    // multiple of the core. pxPerDeg is the shared per-frame value (Fix 5).
    const corePx = coreTargetPx(t);
    const coreWorld = worldSizeForPx(corePx, slantKm, pxPerDeg);
    slot.sprite.scale.setScalar(coreWorld);
    if (slot.halo) slot.halo.scale.setScalar(coreWorld * HALO_TO_CORE);

    // Task 4 — ONE consolidated brightness expression. Each term owns exactly
    // one concern (documented so the next pass doesn't re-derive it):
    //   intensity(sunDot) — SUN GEOMETRY. Terminator-bright; day floor lifted.
    //   envelope(t)       — SHOW ARC. Fast in, plateau, short fade at the end
    //                       (the old t>0.75 collapse is deleted — Task 4.1).
    //   boost(fd)         — DISTANCE. limbBoost foreshortening compensation.
    //   areaComp          — AREA. Holds mean luminance as the core grows 6→16px:
    //                       opacity ∝ (ref/cur)² so the growing head doesn't
    //                       linearly pile on additive energy (Task 4.3).
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
    // Halo rides the same expression but dimmer (it's the atmosphere, not the
    // source) — a fixed fraction keeps core and halo locked together.
    if (slot.halo) slot.halo.material.opacity = op * HALO_OPACITY;

    // Task 7/8 — the RIBBON uses a SUSTAINED envelope (fade-in only, no end
    // collapse): the head fades as it arrives, but the exhaust trail must HOLD
    // through arrival so Task 8 can dissipate it in the 'fade' phase. Without
    // this the ribbon would inherit the head's end-fade and vanish at t=1.
    // Shares plumeFadeIn with the head envelope so the two can't drift (Fix 6).
    const opRibbon = Math.min(cap, intensity * plumeFadeIn(t) * boost * areaComp);
    slot.endOpacity = opRibbon;   // remembered for the Task-8 'fade' phase
    this._drawRibbon(slot, t, opRibbon, pxPerDeg);
  }

  /**
   * @private Rewrite the slot's ribbon to follow the ascent path up to `tHead`,
   * at master opacity `opacity`. Shared by the 'rise' and 'fade' phases.
   * Uses the per-slot `pointAt` closure built once at fire time (Fix 4 — no
   * per-frame allocation) and the shared per-frame `pxPerDeg` (Fix 5).
   * @param {object} slot @param {number} tHead ∈ [0,1] @param {number} opacity
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

  /**
   * Force-reset on GAME_RESET. Without this, a reset within the cameo window
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
