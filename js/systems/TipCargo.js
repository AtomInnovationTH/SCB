/**
 * TipCargo.js — the HOLDER for bags on the radiator tips: one bag per tip, 4 slots.
 *
 * DECISIONS §1 (the leash ends at a radiator tip, where the tip magnet latches the steel washer at the net's neck),
 * §12 (pieces go to furnaces on the radiator tips; the furnace is not built, the stand-in cook is the existing span
 * law), §5a (hardware keeps 0.15 m outside the engine plume cones).
 *
 * Mirrors the daughter rack (ArmUnit._pinHeldCatches / _updateHoldingCatch):
 *   - PIN: every frame ("a gap reads as a release"). The bag centre is the latch point + radius · dir, where `dir`
 *     lives in the radiator HINGE frame so the bag turns with the radiator and the ship. After `swingToBoom(i)` the
 *     dir slews to the boom axis at SWING_RATE_DEG_S.
 *   - COOK: the same clock (`dt · BASE_SCALE · sunScale`), span (`FURNACE_TRANSFER.digestSpanS(mass)`), phases
 *     (hold / chop / feed), chop scale and `_breakdownActive` as the rack, each tip on its own clock.
 *     Ends with CATCH_PROCESSED { digested: true, source: 'tip', tipIndex }.
 *   - BOOKS: `massBookings()` feeds CoMCalculator.computeCoM / computeInertia; `totalMassKg()` feeds
 *     ArmManager.getCargoMassKg.
 *   - RADIATOR CEILING: `maxRadiatorThetaRad()` is read by PlayerSatellite._updateFlower: a bag on a tip must stay
 *     out of the engine plume cones, so the radiators may not open past the band row for the largest bag held
 *     (measured, tmp/probes/leash/lat15/bsum.txt).
 *
 * Frames: positions handed to the debris field are scene units in the world frame (1 m = 1e-5). `massBookings()` /
 * `spheres()` are metres in the ship body frame (the frame `strutTipMeters` uses: barrel long axis = Z).
 */
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { TimeAuthority } from './TimeAuthority.js';
import { tripMelting } from './TransferTrip.js';
import {
  seedShipRelativeAttitude,
  applyShipRelativeAttitude,
  clearShipRelativeAttitude,
} from '../entities/CaptureNet.js';
import { DebrisField } from '../entities/DebrisField.js';
import { degToRad, clamp01, clamp, lerp, smoothstep01 } from '../core/MathUtil.js';

const M = Constants.SCENE_UNITS_PER_METER ?? 0.00001;

/** Latch point offset beyond the pad origin along the outward boom (m). Measured: lat15/bsum.txt. */
export const TIP_STALK_M = 0.15;
/**
 * Largest bag radius a tip takes (m): every radius up to it has a measured hand-off angle with and without bags held
 * on the other tips (Constants.LEASH.HANDOFF_THETA_TABLE, tmp/v12bb/summ.txt).
 */
export const MAX_BAG_R_M = 0.75;
/**
 * Bag radius (m) → max radiator angle (deg) with that bag on a tip, 0.15 m floor to every engine plume cone (the same
 * for all four tips), floored to a whole degree. Measured with the 0.15 m latch at the 2.30 m radiators
 * (tmp/probes/arm-length/band.mjs, tmp/v12bb/band-s0.2.txt). A bag takes the row for the next radius at or above its own.
 */
export const TIP_BAND = [[0.10, 146], [0.15, 145], [0.22, 143], [0.30, 142], [0.40, 140], [0.50, 138], [0.60, 136], [0.75, 134]];
/** How fast a bag turns from the line it arrived on to the boom axis (deg/s). ESTIMATE, not measured. */
export const SWING_RATE_DEG_S = 20;
/** Tip order for the next free tip: azimuth 40 → 220 → 140 → 320 (AZIMUTHS_DEG indices). */
const PICK_ORDER = [0, 2, 1, 3];
const SLOT_COUNT = 4;

const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _X = new THREE.Vector3(1, 0, 0);

// Melt bag look (owner 2026-10-27, "a bunch of grey triangles in a sphere shape ... research more"): a woven ceramic-fibre
// cloth bag stretched taut over the cut parts: ONE closed, smooth skin (a detail-6 icosphere, corners merged by position
// so no corner moves twice and there are no gaps) shaped as the CONVEX HULL of a few packed part corners (flat-ish faces,
// soft ridges), a small dazzling focus spot inside a dull-red halo where the furnace heats it, and the hull relaxing
// toward a sphere as the parts melt (docs/research/2026-10-slice5-big-pieces.md).
/**
 * Hull weight k: how far the skin follows the packed parts (1 = their hull, 0 = a sphere). 0.8 down to frac 0.3, then
 * fading to 0.1 at frac 0 (the bag is only drawn while melting, so the parts must show).
 */
export const PART_BAG_HULL_FULL = 0.8;
export const PART_BAG_HULL_FLOOR = 0.1;
/** The hull weight holds at its full value down to this melt fraction, then fades. */
export const PART_BAG_HULL_HOLD = 0.3;
const PART_BAG_SMOOTH_ITERS = 3;               // edge softening passes (6 blurred the faces into an egg)
/** A bag's skin is rebuilt only when its melt fraction has moved by more than this since the last build. */
export const PART_BAG_REBUILD_STEP = 0.02;
const PART_BAG_CLOTH = 0xcdc4aa;          // warm cream, darker than white so sunlight does not blow it out, no blue or grey tint: ESTIMATE, not sourced
const PART_BAG_ROUGHNESS = 0.95;
const PART_BAG_BUMP = 0.5;                // ESTIMATE
const PART_BAG_WEAVE_REPEAT = [48, 24];   // weave tiles around / pole to pole (u spans 2 pi, v spans pi): ESTIMATE
const PART_BAG_WEAVE_SWING = 0.07;        // luminance swing of the weave, 7 % (5-8 %: barely visible at 3 m)
const PART_BAG_WEAVE_TINT = [255, 249, 232];   // warm cream tint of the weave texture: R >= G > B
const PART_BAG_GLOW_EMISSIVE = 1.0;       // the dazzling core is emissive 1.0; the halo's own colour is dimmed in the texture
const PART_BAG_CORE_COLOR = [255, 240, 190];   // white-yellow focus spot: ESTIMATE
const PART_BAG_HALO_PEAK = [178, 38, 6];       // cherry red at the halo's inner edge, red 0.7 of full (cloth next to a ~1 kW focus runs far hotter than the 660 C melt): ESTIMATE
const PART_BAG_CORE_R = 0.09;             // core radius, in bag radii (angular, on the +X side): 8-10 % per the owner round
const PART_BAG_HALO_R = 0.25;             // halo radius, in bag radii
const PART_BAG_GLOW_WINDOW = 0.36;        // the glow texture covers dir.y, dir.z in -0.36..0.36 (a cap about 21 deg across), black outside; the far side is pushed out of range
export const PART_BAG_WEAVE_SIZE = 64;
export const PART_BAG_GLOW_SIZE = 64;

function seededRng(seed) {                 // mulberry32
  let a = (Math.imul(seed | 0, 2654435761) + 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let _partBagBase = null;
/** The unit icosphere (detail 6) with corners merged by position, vertex neighbours, and the two uv sets (weave, focus glow). */
function partBagBase() {
  if (_partBagBase) return _partBagBase;
  const src = new THREE.IcosahedronGeometry(1, 6);          // detail 6 (3 gave a visibly polygonal outline); non-indexed: three corners per triangle, shared corners repeated
  const sp = src.attributes.position;
  const ids = new Map();
  const dirs = [];
  const index = [];
  for (let k = 0; k < sp.count; k++) {
    const x = sp.getX(k), y = sp.getY(k), z = sp.getZ(k);
    const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    let id = ids.get(key);
    if (id === undefined) { id = dirs.length / 3; ids.set(key, id); dirs.push(x, y, z); }
    index.push(id);
  }
  src.dispose();
  const n = dirs.length / 3;
  const nb = Array.from({ length: n }, () => new Set());
  for (let t = 0; t < index.length; t += 3) {
    for (let e = 0; e < 3; e++) { const a = index[t + e], b = index[t + (e + 1) % 3]; nb[a].add(b); nb[b].add(a); }
  }
  const nbr = nb.map((s) => Array.from(s));
  // weave uv: longitude/latitude about the Y axis, the seam on the -X side (away from the furnace); glow uv: the dir.y, dir.z plane, only on the +X cap
  const uv = new Float32Array(2 * n);
  const uv1 = new Float32Array(2 * n);
  for (let v = 0; v < n; v++) {
    const x = dirs[3 * v], y = dirs[3 * v + 1], z = dirs[3 * v + 2];
    uv[2 * v] = Math.atan2(z, x) / (2 * Math.PI) + 0.5;
    uv[2 * v + 1] = Math.acos(clamp(y, -1, 1)) / Math.PI;
    if (x > 0.5) { uv1[2 * v] = 0.5 + y / (2 * PART_BAG_GLOW_WINDOW); uv1[2 * v + 1] = 0.5 + z / (2 * PART_BAG_GLOW_WINDOW); }
    else { uv1[2 * v] = 5; uv1[2 * v + 1] = 5; }
  }
  _partBagBase = { dirs: new Float32Array(dirs), index, nbr, uv, uv1, n, hulls: new Map() };
  return _partBagBase;
}

/** The packed parts' corners for a seed and attempt: 6-8 corners, well spread in direction (at least ~50 deg apart), radii 0.7-1.3, so the hull has a few big flat-ish faces. */
function partBagCorners(seed, attempt = 0) {
  const rng = seededRng(seed + 7919 * attempt);
  const n = 6 + Math.floor(rng() * 3);
  const pts = [];
  for (let guard = 0; pts.length < n && guard < 400; guard++) {
    const d = new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5);
    if (d.lengthSq() < 1e-4) continue;
    d.normalize();
    const minDot = guard < 200 ? 0.64 : 0.8;                   // cos 50 deg, relaxed late so the loop always ends
    if (pts.some((q) => q.clone().normalize().dot(d) > minDot)) continue;
    pts.push(d.multiplyScalar(0.7 + 0.6 * rng()));
  }
  return pts;
}
/** Hull planes (unit normal n, distance h from the origin) of a point set that holds the origin inside: every triple's plane with all points on one side. */
function hullPlanes(pts) {
  const planes = [];
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nrm = new THREE.Vector3();
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) for (let k = j + 1; k < pts.length; k++) {
    e1.subVectors(pts[j], pts[i]); e2.subVectors(pts[k], pts[i]); nrm.crossVectors(e1, e2);
    const len = nrm.length();
    if (len < 1e-6) continue;
    nrm.divideScalar(len);
    let h = nrm.dot(pts[i]);
    let sgn = 1;
    if (h < 0) { h = -h; sgn = -1; }
    if (h < 0.05) continue;
    let ok = true;
    for (const p of pts) { if (sgn * nrm.dot(p) > h + 1e-6) { ok = false; break; } }
    if (ok) planes.push([sgn * nrm.x, sgn * nrm.y, sgn * nrm.z, h]);
  }
  return planes;
}
/** The hull's radius along every skin direction, softened (cloth rounds the edges), the largest = 1. Cached per seed. */
function partBagHull(seed) {
  const base = partBagBase();
  const hit = base.hulls.get(seed);
  if (hit) return hit;
  let r = null;
  for (let attempt = 0; attempt < 24 && !r; attempt++) {      // keep the first packing whose hull closes round the centre (origin inside, no flat sliver)
    const planes = hullPlanes(partBagCorners(seed, attempt));
    const cand = new Float32Array(base.n);
    let ok = planes.length >= 4, lo = Infinity;
    for (let v = 0; v < base.n && ok; v++) {
      const x = base.dirs[3 * v], y = base.dirs[3 * v + 1], z = base.dirs[3 * v + 2];
      let m = Infinity;
      for (const pl of planes) { const c = x * pl[0] + y * pl[1] + z * pl[2]; if (c > 1e-6) m = Math.min(m, pl[3] / c); }
      if (!Number.isFinite(m)) ok = false;
      cand[v] = m; lo = Math.min(lo, m);
    }
    if (ok && lo > 0.3) r = cand;
  }
  if (!r) r = new Float32Array(base.n).fill(1);
  for (let it = 0; it < PART_BAG_SMOOTH_ITERS; it++) {          // cloth rounds the edges a little: relax each radius toward its neighbours' mean
    const nx = new Float32Array(base.n);
    for (let v = 0; v < base.n; v++) {
      let sum = 0; const ns = base.nbr[v];
      for (let q = 0; q < ns.length; q++) sum += r[ns[q]];
      nx[v] = 0.5 * r[v] + 0.5 * sum / ns.length;
    }
    r = nx;
  }
  let peak = 0;
  for (let v = 0; v < base.n; v++) peak = Math.max(peak, r[v]);
  for (let v = 0; v < base.n; v++) r[v] /= peak;
  if (base.hulls.size >= 16) base.hulls.clear();
  base.hulls.set(seed, r);
  return r;
}
/** Hull weight for a melt fraction (PART_BAG_HULL_*). */
export function partBagHullK(frac) {
  const f = clamp01(Number.isFinite(frac) ? frac : 1);
  if (f >= PART_BAG_HULL_HOLD) return PART_BAG_HULL_FULL;
  return lerp(PART_BAG_HULL_FLOOR, PART_BAG_HULL_FULL, f / PART_BAG_HULL_HOLD);
}
/** A fresh closed, indexed, smooth-shaded skin for a melt fraction and a bag seed (the caller owns it and disposes it). */
export function buildPartBagGeometry(frac, seed = 0) {
  const base = partBagBase();
  const hull = partBagHull(seed);
  const k = partBagHullK(frac);
  const grow = 1 + 0.1 * k;                                   // the largest radius stays inside the old 1.12 the radiator ceiling was measured with
  const pos = new Float32Array(3 * base.n);
  for (let v = 0; v < base.n; v++) {
    const r = grow * (1 + k * (hull[v] - 1));
    pos[3 * v] = base.dirs[3 * v] * r; pos[3 * v + 1] = base.dirs[3 * v + 1] * r; pos[3 * v + 2] = base.dirs[3 * v + 2] * r;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(base.uv.slice(), 2));
  g.setAttribute('uv1', new THREE.BufferAttribute(base.uv1.slice(), 2));
  g.setIndex(base.index.slice());
  g.computeVertexNormals();
  return g;
}

function dataTexture(data, size) {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}
let _partBagGlow = null;
/** The focus glow, 64x64 over dir.y, dir.z: a small white-yellow core (emissive ~1.0) inside a dull-red halo, black outside. Used through uv1 (texture channel 1). No `document` needed. */
export function partBagGlowMap() {
  if (_partBagGlow) return _partBagGlow;
  const W = PART_BAG_GLOW_SIZE;
  const data = new Uint8Array(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const dy = ((x + 0.5) / W - 0.5) * 2 * PART_BAG_GLOW_WINDOW, dz = ((y + 0.5) / W - 0.5) * 2 * PART_BAG_GLOW_WINDOW;
    const rho = Math.hypot(dy, dz);
    const halo = Math.pow(clamp01((PART_BAG_HALO_R - rho) / (PART_BAG_HALO_R - PART_BAG_CORE_R)), 0.7);   // 1 at the core's edge, 0 at 25 % of the radius; the 0.7 power keeps it clearly lit at mid radius
    const t = clamp01((PART_BAG_CORE_R + 0.01 - rho) / 0.03);         // 1 inside about 0.07 .. 0 at 0.10
    const core = smoothstep01(t);
    const o = 4 * (y * W + x);
    for (let c = 0; c < 3; c++) data[o + c] = Math.round(PART_BAG_HALO_PEAK[c] * halo * (1 - core) + PART_BAG_CORE_COLOR[c] * core);
    data[o + 3] = 255;
  }
  const tex = dataTexture(data, W);
  if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.channel = 1;
  _partBagGlow = tex;
  return tex;
}
let _partBagWeave = null;
/** The woven look, 64x64 warm cream, low contrast (8x8-texel cells, plain weave: warp over weft and back, tiled 48x24 over the bag): used as colour map and bump map. Procedural, no `document`. */
export function partBagWeaveMap() {
  if (_partBagWeave) return _partBagWeave;
  const W = PART_BAG_WEAVE_SIZE, C = 8;
  const data = new Uint8Array(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const cx = Math.floor(x / C), cy = Math.floor(y / C);
    const along = ((cx + cy) % 2 === 0) ? (x % C) : (y % C);       // across the thread on top: it is round, bright at its crown
    const crown = Math.sin(Math.PI * (along + 0.5) / C);
    const grain = ((Math.imul(x * 73856093 ^ y * 19349663, 2654435761) >>> 24) / 255 - 0.5) * 0.15 * PART_BAG_WEAVE_SWING;
    const g = clamp01(1 - PART_BAG_WEAVE_SWING * (1 - crown) + grain);    // brightest 1.0 at the thread crown, 7 % darker between threads
    const o = 4 * (y * W + x);
    for (let c = 0; c < 3; c++) data[o + c] = Math.round(PART_BAG_WEAVE_TINT[c] * g);
    data[o + 3] = 255;
  }
  const tex = dataTexture(data, W);
  if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(PART_BAG_WEAVE_REPEAT[0], PART_BAG_WEAVE_REPEAT[1]);
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 4;
  return tex;
}
function partBagMaterial() {
  const weave = partBagWeaveMap();
  return new THREE.MeshStandardMaterial({
    color: PART_BAG_CLOTH, roughness: PART_BAG_ROUGHNESS, metalness: 0,
    map: weave, bumpMap: weave, bumpScale: PART_BAG_BUMP,
    emissive: 0xffffff, emissiveMap: partBagGlowMap(), emissiveIntensity: PART_BAG_GLOW_EMISSIVE,
  });
}

/** Band row (deg) for a bag radius, or null when the bag is too big for a tip. */
export function bandDegForRadius(radiusM) {
  const r = Number.isFinite(radiusM) ? radiusM : 0;
  for (const [maxR, deg] of TIP_BAND) {
    if (r <= maxR + 1e-9) return deg;
  }
  return null;
}

export class TipCargo {
  /**
   * @param {{ player: object, debrisField?: object, armManager?: object, eventBus?: object }} deps
   */
  constructor({ player, debrisField = null, armManager = null, eventBus: bus = eventBus } = {}) {
    this.player = player;
    this.debrisField = debrisField;
    this.armManager = armManager;
    this.eventBus = bus;
    /** @type {Array<null|object>} one bag per tip */
    this._slots = [null, null, null, null];
    /** tips a daughter is carrying a catch to (see `reserve`) */
    this._reserved = [false, false, false, false];
    this._tipCache = [null, null, null, null];
    this._bookings = [];
    this._lastThetas = [null, null, null, null];   // each occupied tip's petal angle at the last update
    /** the part of a big piece being melted in tip i's furnace, drawn as a bag (see `showPartBag`) */
    this._partBags = [null, null, null, null];
    this._boundReset = () => this.reset();
    this.eventBus.on(Events.GAME_RESET, this._boundReset);
    this.eventBus.on(Events.GAMEOVER_CONTINUE, this._boundReset);
  }

  dispose() {
    this.clearPartBags();
    this.eventBus.off(Events.GAME_RESET, this._boundReset);
    this.eventBus.off(Events.GAMEOVER_CONTINUE, this._boundReset);
  }

  // tip hardware: found lazily by name (pairs are installed late)

  /** @returns {{hinge:THREE.Object3D, tip:THREE.Object3D, pad:THREE.Object3D|null}|null} */
  _tipRec(i) {
    const c = this._tipCache[i];
    if (c && c.hinge.parent) return c;
    const groups = this.player && this.player._flowerGroups;
    if (!groups) return null;
    const az = Constants.THERMAL.FLOWER.AZIMUTHS_DEG[i];
    for (const fg of groups) {
      if (fg.azDeg !== az || !fg.hinge) continue;
      const tip = fg.hinge.getObjectByName(`FlowerStrutTip_${i}`);
      if (!tip) return null;
      const pad = tip.getObjectByName(`FlowerStrutTipPad_${i}`) || null;
      return (this._tipCache[i] = { hinge: fg.hinge, tip, pad });
    }
    return null;
  }

  /** Hinge-frame point → ship-local point (scene units), into `out`. */
  _hingeToShip(rec, p, out) {
    const hinge = rec.hinge;
    const pivot = hinge.parent;
    out.copy(p).applyQuaternion(hinge.quaternion).add(hinge.position);
    if (pivot) out.applyQuaternion(pivot.quaternion).add(pivot.position);
    return out;
  }

  /** Quaternion hinge frame → ship frame, into `out`. */
  _hingeQuatShip(rec, out) {
    const pivot = rec.hinge.parent;
    if (pivot) out.copy(pivot.quaternion).multiply(rec.hinge.quaternion);
    else out.copy(rec.hinge.quaternion);
    return out;
  }

  /** The latch point in the HINGE frame (scene units): pad origin + 0.15 m along local +X. */
  _latchHingeInto(rec, out) {
    out.copy(rec.tip.position);
    if (rec.pad) out.add(rec.pad.position);
    else out.x -= 0.0275 * M;
    out.x += TIP_STALK_M * M;
    return out;
  }

  _shipPos(out) {
    const p = this.player;
    if (p && p.position) return out.copy(p.position);
    return out.set(0, 0, 0);
  }

  /**
   * World position (scene units) of tip i's latch point — where the swivel cone
   * holds the washer: pad origin + 0.15 m along the outward boom.
   * @returns {THREE.Vector3|null} `out`, or null when the tip does not exist
   */
  latchWorldInto(i, out) {
    const rec = this._tipRec(i);
    if (!rec) return null;
    this._latchHingeInto(rec, _v1);
    this._hingeToShip(rec, _v1, out);
    out.applyQuaternion(this.player.quaternion).add(this._shipPos(_v2));
    return out;
  }

  /** Unit outward boom direction of tip i in the world frame. */
  axisWorldInto(i, out) {
    const rec = this._tipRec(i);
    if (!rec) return null;
    this._hingeQuatShip(rec, _q1);
    return out.copy(_X).applyQuaternion(_q1).applyQuaternion(this.player.quaternion).normalize();
  }

  /**
   * The turn from tip i's HINGE frame to the ship body frame, as plain {x,y,z,w} into `out` (read-only view of
   * `_hingeQuatShip`; the frame `_place` seats the bag in). null when the tip does not exist.
   */
  hingeQuatShipInto(i, out) {
    const rec = this._tipRec(i);
    if (!rec) return null;
    this._hingeQuatShip(rec, _q1);
    out.x = _q1.x; out.y = _q1.y; out.z = _q1.z; out.w = _q1.w;
    return out;
  }

  /**
   * Next free tip that exists (order az 40 → 220 → 140 → 320), or null. A tip a daughter is carrying to is not free.
   * A free tip whose daughter holds no catch is preferred, so a nose catch does not take the tip a loaded daughter is
   * waiting for while another tip is free; with every free tip wanted by a loaded daughter, the order above decides.
   */
  pickTip() {
    let wanted = null;
    for (const i of PICK_ORDER) {
      if (this._slots[i] || this._reserved[i] || !this._tipRec(i)) continue;
      if (!this._daughterLoaded(i)) return i;
      if (wanted === null) wanted = i;
    }
    return wanted;
  }

  /** @private Tip i's daughter (the one on her line: arm index = tip index) holds a catch on her rack. */
  _daughterLoaded(i) {
    const arms = this.armManager && this.armManager.arms;
    const a = Array.isArray(arms) ? arms[i] : null;
    return !!(a && !a.isDetached && Array.isArray(a.heldCatches) && a.heldCatches.length > 0);
  }

  /**
   * Hold tip i's slot for a daughter on her way with a catch: `pickTip` skips it until the stow (which clears it),
   * `unreserve`, or `reset`.
   * @returns {boolean} false when the tip is taken, already reserved, or does not exist
   */
  reserve(i) {
    if (!(i >= 0 && i < SLOT_COUNT) || this._slots[i] || this._reserved[i] || !this._tipRec(i)) return false;
    this._reserved[i] = true;
    return true;
  }

  unreserve(i) { if (i >= 0 && i < SLOT_COUNT) this._reserved[i] = false; }

  isReserved(i) { return !!this._reserved[i]; }

  /**
   * Tip i's bag point for a bag of radius `radiusM`: the latch point plus the radius along the boom, SHIP-LOCAL scene units
   * (the point `stow` seats the bag at once its direction has swung onto the boom). The carrying daughter flies the
   * delivered catch's centre onto it. null when the tip does not exist.
   * @returns {THREE.Vector3|null} `out`
   */
  bagPointShipInto(i, radiusM, out) {
    const rec = this._tipRec(i);
    if (!rec) return null;
    this._latchHingeInto(rec, _v1);
    this._hingeToShip(rec, _v1, out);
    this._hingeQuatShip(rec, _q1);
    _v2.copy(_X).applyQuaternion(_q1).normalize();
    return out.addScaledVector(_v2, radiusM * M);
  }

  /** Does a bag of this radius fit on a tip at all? */
  fits(radiusM) {
    return Number.isFinite(radiusM) && radiusM >= 0 && radiusM <= MAX_BAG_R_M + 1e-9;
  }

  has(i) { return !!this._slots[i]; }
  /**
   * What the mother digest line prints ("Tips 1/2", "cooking 40%"). Returns ONE reused object, so a 10 Hz readout
   * allocates nothing: `held` bags, `tips` fitted (2 per radiator pair, 4 with both), `cookingPct` (0..100, the
   * furthest-along bag's share of its cook clock) or null while nothing is cooking.
   * @returns {{held:number, tips:number, cookingPct:number|null}}
   */
  digest() {
    const out = this._digest || (this._digest = { held: 0, tips: 0, cookingPct: null });
    const FEED = Constants.FURNACE_TRANSFER.FEED_S;
    let held = 0, tips = 0, best = -1;
    for (let i = 0; i < SLOT_COUNT; i++) {
      if (this._tipRec(i)) tips++;
      const s = this._slots[i];
      if (!s) continue;
      held++;
      if (s.phaseT > 0 && s.phaseT > best) best = s.phaseT;
    }
    out.held = held;
    out.tips = tips;
    out.cookingPct = best > 0 ? Math.min(100, Math.floor((best / FEED) * 100)) : null;
    return out;
  }
  count() { let n = 0; for (const s of this._slots) if (s) n++; return n; }
  isSwinging(i) { const s = this._slots[i]; return !!(s && s.swinging); }
  /** @returns {object|null} the debris held on tip i */
  debrisAt(i) { const s = this._slots[i]; return s ? s.debris : null; }

  totalMassKg() {
    let m = 0;
    for (const s of this._slots) if (s) m += s.massKg;
    return m;
  }

  /**
   * Latch a bag onto tip i. The bag arrives along `fromDirWorld` (the line,
   * from the latch point out to the bag centre); it keeps that direction in
   * the radiator's frame until `swingToBoom(i)` turns it onto the boom axis.
   * @param {number} i tip index (0..3)
   * @param {object} debris the caught body (must carry `tumbleAxis` for the attitude pin)
   * @param {{massKg?:number, radiusM?:number, fromDirWorld?:{x:number,y:number,z:number}}} [opts]
   * @returns {boolean} true when stowed
   */
  stow(i, debris, opts = {}) {
    if (!debris || !(i >= 0 && i < SLOT_COUNT) || this._slots[i]) return false;
    const rec = this._tipRec(i);
    if (!rec) return false;
    for (const s of this._slots) if (s && s.debris === debris) return false;
    const massKg = Number.isFinite(opts.massKg) ? opts.massKg : (debris.mass || 0);
    const radiusM = Number.isFinite(opts.radiusM) ? opts.radiusM : DebrisField.trueReachM(debris, 0);   // tip-fit: the catch as drawn
    if (!this.fits(radiusM)) return false;

    const dirLocal = new THREE.Vector3(1, 0, 0);
    const f = opts.fromDirWorld;
    if (f && (f.x * f.x + f.y * f.y + f.z * f.z) > 1e-12) {
      // world → ship → hinge frame, so the bag turns with the radiator
      this._hingeQuatShip(rec, _q1);
      _q2.copy(this.player.quaternion).multiply(_q1).invert();
      dirLocal.set(f.x, f.y, f.z).normalize().applyQuaternion(_q2).normalize();
    }

    const slot = {
      i, debris, massKg, radiusM, dirLocal, swinging: false,
      pos: new THREE.Vector3(),
      posShip: { massKg, posShip: { x: 0, y: 0, z: 0 } },
      breakdownStarted: false, chunksFired: 0, phaseT: 0,
      anchor: { kind: 'tip', index: i },   // one object per bag, reused by every event (no per-frame allocation)
    };
    this._slots[i] = slot;
    this.clearPartBags(i, true);                   // a furnace-test demo bag on the tip gives way to the real bag
    this._reserved[i] = false;                     // a stow (the carry's or a leash's) ends any reservation of the slot
    this._place(slot, rec);
    debris._captured = true;
    debris._armPinned = true;
    debris._tipIndex = i;
    debris._breakdownActive = false;
    if (!debris._armPinPos) debris._armPinPos = new THREE.Vector3();
    debris._armPinPos.copy(slot.pos);
    // Take the catch's current attitude into the ship's frame; it turns with the ship from here on.
    seedShipRelativeAttitude(debris, this.player.quaternion, this.debrisField);
    this._invalidateInertia();
    return true;
  }

  /** Start turning tip i's bag from its arrival line onto the boom axis. */
  swingToBoom(i) {
    const s = this._slots[i];
    if (!s) return false;
    s.swinging = true;
    return true;
  }

  /**
   * The lowest radiator angle limit, in radians, set by the bags held: for each
   * bag the band row for its radius (the next radius at or above it); the
   * minimum over all bags. Infinity when no tip holds a bag.
   */
  maxRadiatorThetaRad() {
    let best = Infinity;
    for (const s of this._slots) {
      if (!s) continue;
      const deg = bandDegForRadius(s.radiusM);
      const rad = degToRad(deg === null ? TIP_BAND[TIP_BAND.length - 1][1] : deg);
      if (rad < best) best = rad;
    }
    // a part bag shown on a tip holds the radiators at its band exactly as a real bag of its reach does
    for (const b of this._partBags) {
      if (!b || b.demo) continue;                  // a furnace-test demo bag never holds the radiators
      const deg = bandDegForRadius(b.radiusM);
      const rad = degToRad(deg === null ? TIP_BAND[TIP_BAND.length - 1][1] : deg);
      if (rad < best) best = rad;
    }
    return best;
  }

  // part bags: a big piece melting in a tip furnace

  /**
   * Show (or update) the bag of the PART of a big piece being melted in tip i's furnace: a woven ceramic-cloth bag (one
   * closed skin over the packed parts' hull, a dazzling focus spot in a dull-red halo on its furnace +X side) pinned to
   * the tip like a real bag, rounding and shrinking as it melts. Only a drawing: no field body, no CATCH_PROCESSED, no
   * NET_CONSUMED, no mass booking (the part's kilograms stay in the piece until it melts, GameFlowManager books them
   * then). It counts in `maxRadiatorThetaRad()` as a real bag of its drawn reach does (the part's size with its
   * parent's geometry, `DebrisField.trueReachM`: 0.70 m reads the 134 deg row), at its FULL size, so the radiators
   * settle once and do not chase the shrinking bag. The ceiling lifts at `clearPartBags`.
   * @param {number} i tip index (0..3)
   * @param {{type: string, sizeM: number, frac?: number, demo?: boolean}} spec `sizeM` the packed part's diameter (m), `frac` 1 = whole .. 0 = melted;
   *   `demo` true = the OVERRIDE panel's furnace test (a drawing and nothing else): it is left out of
   *   `maxRadiatorThetaRad()`, it never replaces a real melt's bag on the tip (returns false), and a real `showPartBag`
   *   (no `demo`) on the tip takes it over; `stow` on the tip drops it. A demo is also refused while tip i's radiator is
   *   open past the band row of its reach (the angle a real bag would have capped it at).
   * @returns {boolean} false when the tip does not exist, holds a real bag, or the part does not fit a tip (or a demo meets a real melt's bag, or the radiators are open past its band)
   */
  showPartBag(i, spec = {}) {
    if (!(i >= 0 && i < SLOT_COUNT) || this._slots[i]) return false;
    const rec = this._tipRec(i);
    if (!rec || !(spec.sizeM > 0)) return false;
    const radiusM = DebrisField.trueReachM({ type: spec.type, id: 1, sizeMeter: spec.sizeM }, 0);
    if (!this.fits(radiusM)) return false;
    let b = this._partBags[i];
    if (b && spec.demo === true && !b.demo) return false;        // a real melt's bag stays
    if (spec.demo === true && this._radiatorsPastBand(i, radiusM)) return false;   // no cap holds the radiators for a demo bag, so none is drawn where the cap would have protected
    if (!b) b = this._partBags[i] = { i, type: spec.type, sizeM: spec.sizeM, radiusM, frac: 1, mesh: null, demo: false };
    b.demo = spec.demo === true;
    b.type = spec.type; b.sizeM = spec.sizeM; b.radiusM = radiusM;
    b.frac = Number.isFinite(spec.frac) ? clamp01(spec.frac) : 1;
    if (!b.mesh) {
      b.mesh = new THREE.Mesh(buildPartBagGeometry(b.frac, b.i), partBagMaterial());
      b.builtFrac = b.frac; b.builds = 1;
    } else if (Math.abs(b.frac - b.builtFrac) > PART_BAG_REBUILD_STEP + 1e-6) {      // the lumps fade as it melts: a new skin per 0.02 of melt
      b.mesh.geometry.dispose();
      b.mesh.geometry = buildPartBagGeometry(b.frac, b.i);
      b.builtFrac = b.frac; b.builds++;
    }
    const mesh = b.mesh;
    if (mesh.parent !== rec.hinge) rec.hinge.add(mesh);          // pinned to the radiator: it turns with the petal and the ship
    mesh.layers.mask = rec.hinge.layers.mask;                    // the ship's near-field pass
    mesh.name = `PartBag_${i}`;
    this._latchHingeInto(rec, _v1);
    mesh.position.copy(_v1).addScaledVector(_X, radiusM * M);    // the bag's centre: latch + reach along the boom, as a real bag sits
    mesh.scale.setScalar((spec.sizeM / 2) * Math.cbrt(Math.max(b.frac, 0.02)) * M);
    mesh.visible = true;
    return true;
  }

  /** Is tip i's radiator open past the band row for `radiusM` (where a real bag would cap it)? Unknown angle reads as not past. */
  _radiatorsPastBand(i, radiusM) {
    const p = this.player;
    if (!p) return false;
    const th = typeof p.petalThetaRad === 'function' ? p.petalThetaRad(Constants.THERMAL.FLOWER.AZIMUTHS_DEG[i]) : p._flowerThetaRad;
    if (!Number.isFinite(th)) return false;
    const deg = bandDegForRadius(radiusM);
    const bandRad = degToRad(deg === null ? TIP_BAND[TIP_BAND.length - 1][1] : deg);
    return th > bandRad + 1e-6;
  }

  /** Is a part bag shown on tip i (or on any tip)? */
  hasPartBag(i) { return i === undefined ? this._partBags.some(Boolean) : !!this._partBags[i]; }

  /** The part bag on tip i, as `{type, sizeM, radiusM, frac, builds}` (a copy; `builds` = how many skins have been built for it so far), or null. */
  partBagAt(i) { const b = this._partBags[i]; return b ? { type: b.type, sizeM: b.sizeM, radiusM: b.radiusM, frac: b.frac, builds: b.builds, demo: b.demo === true } : null; }

  /** Take the part bag off tip `i` (all four when `i` is omitted): the drawing goes and the radiator ceiling it set is lifted. `demoOnly` leaves a real melt's bag alone. */
  clearPartBags(i, demoOnly = false) {
    const from = i === undefined ? 0 : i;
    const to = i === undefined ? SLOT_COUNT : i + 1;
    for (let k = from; k < to; k++) {
      const b = this._partBags[k];
      if (!b || (demoOnly && !b.demo)) continue;
      if (b.mesh) {
        if (b.mesh.parent) b.mesh.parent.remove(b.mesh);
        b.mesh.visible = false;
        b.mesh.geometry.dispose();
        b.mesh.material.dispose();                 // per bag; the shared glow and weave textures stay
      }
      this._partBags[k] = null;
    }
  }

  /** Bag centre for a slot: scene-unit world into slot.pos, metres ship-frame into slot.posShip. */
  _place(slot, rec) {
    // latch + r·dir in the hinge frame, then to ship / world
    this._latchHingeInto(rec, _v1);
    _v3.copy(slot.dirLocal).multiplyScalar(slot.radiusM * M).add(_v1);
    this._hingeToShip(rec, _v3, _v2);               // ship-local, scene units
    const ps = slot.posShip.posShip;
    ps.x = _v2.x / M; ps.y = _v2.y / M; ps.z = _v2.z / M;
    slot.pos.copy(_v2).applyQuaternion(this.player.quaternion).add(this._shipPos(_v3));
  }

  _advanceSwing(slot, dt) {
    if (!slot.swinging || !(dt > 0)) return;
    const d = slot.dirLocal;
    const cos = Math.max(-1, Math.min(1, d.dot(_X)));
    const angle = Math.acos(cos);
    if (angle < 1e-9) { d.copy(_X); slot.swinging = false; return; }
    const step = (degToRad(SWING_RATE_DEG_S)) * dt;
    if (step >= angle) { d.copy(_X); slot.swinging = false; return; }
    _v1.crossVectors(d, _X);
    if (_v1.lengthSq() < 1e-12) _v1.set(0, 0, 1);   // exactly opposite: any perpendicular will do
    _v1.normalize();
    d.applyAxisAngle(_v1, step).normalize();
  }

  /**
   * Pin every bag and run its cook. `dt` is the game step (0 while the world is
   * held: the pin still runs — the ship may turn — but the clocks do not).
   */
  update(dt) {
    const player = this.player;
    if (!player) return;
    let any = false;
    for (let i = 0; i < SLOT_COUNT; i++) {
      const slot = this._slots[i];
      if (!slot) continue;
      any = true;
      const rec = this._tipRec(i);
      if (!rec) continue;   // hardware gone: leave the bag where it was pinned
      this._advanceSwing(slot, dt);
      this._place(slot, rec);
      this._cook(slot, dt);
    }
    // The radiator swing moves the bags (books): the cached inertia must follow. Each bag rides ITS petal, so the check
    // is per tip (a held petal swings while the rest stay still).
    if (any) {
      let moved = false;
      for (let i = 0; i < SLOT_COUNT; i++) {
        if (!this._slots[i]) { this._lastThetas[i] = null; continue; }
        const th = typeof player.petalThetaRad === 'function'
          ? player.petalThetaRad(Constants.THERMAL.FLOWER.AZIMUTHS_DEG[i])
          : player._flowerThetaRad;
        const last = this._lastThetas[i];
        if (last === null || Math.abs(th - last) > 1e-4) { this._lastThetas[i] = th; moved = true; }
      }
      if (moved) this._invalidateInertia();
    } else {
      for (let i = 0; i < SLOT_COUNT; i++) this._lastThetas[i] = null;
    }
  }

  _sunScale() {
    const cns = (this.armManager && this.armManager.playerSatellite
      && this.armManager.playerSatellite._captureNetSystem)
      || (this.player && this.player._captureNetSystem);
    return (cns && cns._digestSunScale) ?? 1.0;
  }

  _invalidateInertia() {
    const p = this.player;
    if (p && '_attitudeInertia' in p) p._attitudeInertia = null;
  }

  /** Pin + cook one bag — the rack's _updateHoldingCatch / ArmManager pin loop on a tip. */
  _cook(slot, dt) {
    const d = slot.debris;
    const FT = Constants.FURNACE_TRANSFER;
    const bus = this.eventBus;
    const anchor = slot.anchor;

    // With no furnace the clock never runs, so the bag never reaches the hold/chop/feed phases below: no breakdown
    // events, no shrink, the slot stays held. The four tip furnaces cook while a transfer trip burns, and only then (the
    // nose collar and the racks have no furnace: their flag reads stay FURNACE_COOK alone). Same span, same sun factor,
    // same real-dt clock.
    const cook = Constants.isFeatureEnabled('FURNACE_COOK') || tripMelting();
    if (dt > 0 && cook) {
      const span = FT.digestSpanS(slot.massKg);
      d._digestProgress = (d._digestProgress || 0) + dt * TimeAuthority.BASE_SCALE * this._sunScale();
      slot.phaseT = Math.min(FT.FEED_S, (d._digestProgress / span) * FT.FEED_S);
    }
    // A melt the trip left unfinished keeps its stage (and its size) until the next trip: the clock is off, the bag is not reset.
    const t = slot.phaseT || 0;

    // Pin every frame (a gap reads as a release); position + ship-relative attitude.
    d._armPinned = true;
    d._captured = true;
    let scaleMul = 1;
    if (t >= FT.HOLD_S && !slot.breakdownStarted) {
      slot.breakdownStarted = true;
      d._breakdownActive = true;           // the furnace visual owns scale/disposal
      d._capturedByArm = null;
      bus.emit(Events.CATCH_BREAKDOWN_START, {
        armId: 'mother', debrisId: d.id, chunkCount: FT.CHUNK_COUNT, anchor,
      });
    }
    if (d._breakdownActive) scaleMul = FT.chopScaleMul(t);
    if (this.debrisField && typeof this.debrisField.pinCapturedDebris === 'function') {
      this.debrisField.pinCapturedDebris(d, slot.pos, scaleMul);
    } else {
      if (!d._armPinPos) d._armPinPos = new THREE.Vector3();
      d._armPinPos.copy(slot.pos);
    }
    applyShipRelativeAttitude(d, this.player.quaternion, this.debrisField);

    if (!cook || t < FT.HOLD_S) return;

    if (t >= FT.CHOP_S && t < FT.FEED_S) {
      const feedFrac = (t - FT.CHOP_S) / Math.max(1e-6, FT.FEED_S - FT.CHOP_S);
      const due = Math.min(FT.CHUNK_COUNT, Math.floor(feedFrac * FT.CHUNK_COUNT) + 1);
      this._fireChunks(slot, due, anchor);
      return;
    }
    if (t < FT.FEED_S) return;

    // ── Digestion complete: flush chunks, free the tip, then the one CATCH_PROCESSED ──
    this._fireChunks(slot, FT.CHUNK_COUNT, anchor);
    const debrisId = d.id;
    const type = d.type;
    this._slots[slot.i] = null;
    d._armPinned = false;
    d._armPinPos = null;
    d._breakdownActive = false;
    d._tipIndex = undefined;
    clearShipRelativeAttitude(d);
    this._invalidateInertia();
    bus.emit(Events.NET_CONSUMED, { armId: 'mother', debrisId, anchor });
    bus.emit(Events.CATCH_PROCESSED, {
      debrisId, armId: null, source: 'tip', tipIndex: slot.i, type, digested: true,
    });
  }

  _fireChunks(slot, due, anchor) {
    const FT = Constants.FURNACE_TRANSFER;
    while (slot.chunksFired < due) {
      this.eventBus.emit(Events.CATCH_BREAKDOWN_CHUNK, {
        armId: 'mother', debrisId: slot.debris.id, index: slot.chunksFired, total: FT.CHUNK_COUNT, anchor,
      });
      slot.chunksFired++;
    }
  }

  /**
   * owner 2026-10-24: "each catch moves to a free tip and melts before you arrive" (DECISIONS §33 row 17: many hours or
   * days of realtime to melt debris). Finish every melt in progress NOW, the end of a transfer trip's days. Each occupied
   * tip gets its whole span and the melt's own completion runs (`_cook(slot, 0)`, the code `update` runs at the end of
   * the span), so the chunks, `NET_CONSUMED` and `CATCH_PROCESSED` (`digested: true`, source 'tip') fire exactly as in
   * play and the tip is free. Only while melting runs (the furnace flag, or a trip burning: `tripMelting`); outside one
   * it does nothing. A tip whose hardware is gone is left, as `update` leaves it.
   * @returns {number} how many bags melted
   */
  finishMelts() {
    if (!(Constants.isFeatureEnabled('FURNACE_COOK') || tripMelting())) return 0;
    const FT = Constants.FURNACE_TRANSFER;
    let n = 0;
    for (let i = 0; i < SLOT_COUNT; i++) {
      const slot = this._slots[i];
      if (!slot || !this._tipRec(i)) continue;
      slot.debris._digestProgress = FT.digestSpanS(slot.massKg);
      slot.phaseT = FT.FEED_S;
      this._cook(slot, 0);
      if (!this._slots[i]) n++;
    }
    return n;
  }

  /**
   * Held mass and where it sits, for computeCoM / computeInertia.
   * @returns {Array<{massKg:number, posShip:{x:number,y:number,z:number}}>} metres, ship body
   *   frame. The array and its entries are reused between calls — read, do not keep.
   */
  massBookings() {
    const out = this._bookings;
    out.length = 0;
    for (const s of this._slots) {
      if (!s || !(s.massKg > 0)) continue;
      const rec = this._tipRec(s.i);
      if (rec) this._place(s, rec);   // fresh: the radiator may have moved since update()
      out.push(s.posShip);
    }
    return out;
  }

  /** Bag spheres (metres, ship body frame) for clearance checks. */
  spheres() {
    const out = [];
    for (const s of this._slots) {
      if (!s) continue;
      const rec = this._tipRec(s.i);
      if (rec) this._place(s, rec);
      const p = s.posShip.posShip;
      out.push({ c: { x: p.x, y: p.y, z: p.z }, r: s.radiusM, name: `tipBag_${s.i}` });
    }
    return out;
  }

  /**
   * Let go of tip i's bag WITHOUT cooking it (only tests call it now). Frees the slot and clears every pin the tip
   * wrote; the caller owns what happens to the body (the game removes it from the field, already paid). Emits
   * NET_CONSUMED so the bag visual clears the way the cook's end does; no CATCH_PROCESSED (nothing is credited or
   * digested).
   * @param {number} i tip index (0..3)
   * @returns {object|null} the released debris, or null when the tip is empty
   */
  releaseSlot(i) {
    const s = this._slots[i];
    if (!s) return null;
    const d = s.debris;
    this._slots[i] = null;
    d._armPinned = false;
    d._armPinPos = null;
    d._captured = false;
    d._breakdownActive = false;
    d._tipIndex = undefined;
    clearShipRelativeAttitude(d);
    this._invalidateInertia();
    this.eventBus.emit(Events.NET_CONSUMED, { armId: 'mother', debrisId: d.id, anchor: s.anchor });
    return d;
  }

  /** Drop every bag: release the bodies to the field as free, re-targetable pieces. */
  reset() {
    this.clearPartBags();
    this._reserved = [false, false, false, false];
    const held = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      const s = this._slots[i];
      if (!s) continue;
      held.push(s.debris);
      this._slots[i] = null;
    }
    this._lastThetas = [null, null, null, null];
    if (held.length === 0) return;
    const am = this.armManager;
    const vel = (this.player && typeof this.player.getVelocity === 'function')
      ? this.player.getVelocity() : null;
    if (am && typeof am._releaseDroppedCargo === 'function') {
      am._releaseDroppedCargo(held, vel);
    }
    for (const d of held) {
      // belt and braces for an armManager without the helper: the pin must never outlive the hold
      d._armPinned = false;
      d._armPinPos = null;
      d._capturedByArm = null;
      d._captured = false;
      d._breakdownActive = false;
      d._tipIndex = undefined;
      clearShipRelativeAttitude(d);
    }
    this._invalidateInertia();
  }
}
