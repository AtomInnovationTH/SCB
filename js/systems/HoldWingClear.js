/**
 * @module systems/HoldWingClear — hold-clear (DECISIONS §35 rows 8-9, owner 2026-10-23: a held catch never touches a
 * radiator wing).
 *
 * For every catch a daughter holds on her rack this answers, per strut angle on the hold-pose grid (34, 39 ... 99, 100
 * deg), two booleans from the catch's real drawn mesh, her cell and its frozen attitude (the placement chain of
 * `CoMCalculator.heldCargoBookingMeters`, the same one the plume check and the net duck read):
 *   - `rest[p]`: the catch stays `REEL_HOLD.CLEAR_M` off every radiator part at every wing angle in
 *     `restAnglesDeg()` (the angles the wings stand at, and samples of the transit angles outside the band:
 *     `HOLD_CLEAR.REST_STEP_DEG`);
 *   - `band[p]`: the same at every wing angle `REEL_HOLD.BAND_LO_DEG .. BAND_HI_DEG` (step `HOLD_CLEAR.BAND_STEP_DEG`).
 *   Each set is judged `HOLD_CLEAR.REST_MARGIN_M` / `BAND_MARGIN_M` beyond `REEL_HOLD.CLEAR_M` (wings are sampled, not swept).
 *
 * How:
 *   - The radiator kit is read from the live ship ONCE: each `FlowerStrutPivot_i` subtree is copied into a detached
 *     shadow tree (transforms only) and posed by the ship's own `_writeFlowerPose` (called on a stand-in `this`), so
 *     the live meshes are never touched and the maths is the game's. For each angle set the triangles of every
 *     radiator at every angle (the parts that do not turn once) go into ONE uniform grid: "clear of the grid" is
 *     "clear at every angle of the set".
 *   - A catch's drawn triangles are cut (once) into pieces of at most `SPLIT_M`; per piece, the exact distance from
 *     its centroid to the radiator triangles: farther than `CLEAR_M + the piece's own radius` -> the piece is clear; a
 *     centroid nearer than `CLEAR_M` is a real surface point in the wrong place -> blocked; in between the piece is
 *     bisected down to `LEAF_M`, where it still counts as blocked. Never a false "clear" (triangle inequality);
 *     false "blocked" only inside a `LEAF_M` shell. A scoop bag and a typeless catch are balls (exact).
 *   - Work is counted in units (not milliseconds), so a frame does the same work on every machine and tests repeat.
 *
 * Pure geometry + state on `piece._wingClear`; nothing here moves a mesh, a strut or a radiator.
 */
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { DebrisField } from '../entities/DebrisField.js';
import { DebrisWireframe } from '../ui/DebrisWireframe.js';
import { heldCargoBookingMeters } from './CoMCalculator.js';
import { DEG2RAD } from '../core/MathUtil.js';

const M = 0.00001;

/** Strut angles (deg) of the hold-pose grid: 34, 39 ... 99, then 100. */
export function holdPoseGridDeg() {
  const V5 = Constants.OCTOPUS_V5;
  const lo = Math.round(V5.STRUT_REST_ALPHA / DEG2RAD);
  const hi = V5.HOLD_POSE_MAX_DEG;
  const out = [];
  for (let deg = lo; deg < hi; deg += V5.HOLD_POSE_STEP_DEG) out.push(deg);
  out.push(hi);
  return out;
}
const POSES = holdPoseGridDeg();
const NP = POSES.length;

export function bandAnglesDeg() {
  const R = Constants.REEL_HOLD;
  const step = Constants.HOLD_CLEAR.BAND_STEP_DEG;
  const out = [];
  for (let d = R.BAND_LO_DEG; d < R.BAND_HI_DEG - 1e-9; d += step) out.push(d);
  out.push(R.BAND_HI_DEG);
  return out;
}

/**
 * @returns {number[]} the wing angles (deg) of the rest set: every wing angle outside the band the wings stand at or
 * pass through — 0 .. BAND_LO and BAND_HI .. 180 in `REST_STEP_DEG` steps (both band edges and 180 included: the wings
 * wait AT an edge) plus the angles they stand at in those ranges (`REST_STAND_DEG`: closed 0, park 135, open 146,
 * vent 180). Derived from the band, so moving the band's top edge moves this set.
 */
export function restAnglesDeg() {
  const R = Constants.REEL_HOLD, HC = Constants.HOLD_CLEAR;
  const lo = R.BAND_LO_DEG, hi = R.BAND_HI_DEG, step = HC.REST_STEP_DEG;
  const set = new Set();
  for (let d = 0; d < lo - 1e-9; d += step) set.add(d);
  set.add(lo);
  set.add(hi);
  for (let d = hi + step; d < 180 - 1e-9; d += step) set.add(d);
  set.add(180);
  for (const d of HC.REST_STAND_DEG) if (d <= lo + 1e-9 || d >= hi - 1e-9) set.add(d);
  return Array.from(set).sort((a, b) => a - b);
}

// Exact point-triangle distance (Ericson), squared; `T` flat, `o` the triangle's offset
function ptTri2(px, py, pz, T, o) {
  const ax = T[o], ay = T[o + 1], az = T[o + 2];
  const abx = T[o + 3] - ax, aby = T[o + 4] - ay, abz = T[o + 5] - az;
  const acx = T[o + 6] - ax, acy = T[o + 7] - ay, acz = T[o + 8] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
  const bpx = px - T[o + 3], bpy = py - T[o + 4], bpz = pz - T[o + 5];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const dx = apx - v * abx, dy = apy - v * aby, dz = apz - v * abz;
    return dx * dx + dy * dy + dz * dz;
  }
  const cpx = px - T[o + 6], cpy = py - T[o + 7], cpz = pz - T[o + 8];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const dx = apx - w * acx, dy = apy - w * acy, dz = apz - w * acz;
    return dx * dx + dy * dy + dz * dz;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const qx = T[o + 3] + w * (T[o + 6] - T[o + 3]), qy = T[o + 4] + w * (T[o + 7] - T[o + 4]), qz = T[o + 5] + w * (T[o + 8] - T[o + 5]);
    const dx = px - qx, dy = py - qy, dz = pz - qz;
    return dx * dx + dy * dy + dz * dz;
  }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  const dx = apx - (abx * v + acx * w), dy = apy - (aby * v + acy * w), dz = apz - (abz * v + acz * w);
  return dx * dx + dy * dy + dz * dz;
}

function gridNew(tris, n, cell) {
  return {
    tris, n, c: cell, phase: 0, cur: 0, done: false,
    ox: 0, oy: 0, oz: 0, nx: 1, ny: 1, nz: 1,
    bx0: Infinity, by0: Infinity, bz0: Infinity, bx1: -Infinity, by1: -Infinity, bz1: -Infinity,
    start: null, ids: null, pos: null, box: new Float32Array(6 * n),     // box: each triangle's own min/max (the cheap reject)
  };
}

/** Runs the grid build for about `budget` triangles' worth of work; returns the budget left (<= 0 when spent). */
function gridStep(g, budget) {
  const T = g.tris, box = g.box;
  while (budget > 0 && !g.done) {
    if (g.phase === 0) {                                   // bounds + per-triangle boxes
      const end = Math.min(g.n, g.cur + budget);
      for (let t = g.cur; t < end; t++) {
        const o = 9 * t;
        let x0 = T[o], x1 = x0, y0 = T[o + 1], y1 = y0, z0 = T[o + 2], z1 = z0;
        for (let v = 1; v < 3; v++) {
          const x = T[o + 3 * v], y = T[o + 3 * v + 1], z = T[o + 3 * v + 2];
          if (x < x0) x0 = x; else if (x > x1) x1 = x;
          if (y < y0) y0 = y; else if (y > y1) y1 = y;
          if (z < z0) z0 = z; else if (z > z1) z1 = z;
        }
        const q = 6 * t;
        box[q] = x0; box[q + 1] = y0; box[q + 2] = z0; box[q + 3] = x1; box[q + 4] = y1; box[q + 5] = z1;
        if (x0 < g.bx0) g.bx0 = x0; if (x1 > g.bx1) g.bx1 = x1;
        if (y0 < g.by0) g.by0 = y0; if (y1 > g.by1) g.by1 = y1;
        if (z0 < g.bz0) g.bz0 = z0; if (z1 > g.bz1) g.bz1 = z1;
      }
      budget -= end - g.cur; g.cur = end;
      if (g.cur >= g.n) {
        const c = g.c;
        if (g.n === 0) { g.bx0 = g.by0 = g.bz0 = 0; g.bx1 = g.by1 = g.bz1 = 0; }
        g.ox = g.bx0 - 1e-4; g.oy = g.by0 - 1e-4; g.oz = g.bz0 - 1e-4;
        g.nx = Math.max(1, Math.floor((g.bx1 - g.ox) / c) + 1);
        g.ny = Math.max(1, Math.floor((g.by1 - g.oy) / c) + 1);
        g.nz = Math.max(1, Math.floor((g.bz1 - g.oz) / c) + 1);
        g.start = new Int32Array(g.nx * g.ny * g.nz + 1);
        g.phase = 1; g.cur = 0;
      }
    } else if (g.phase === 1 || g.phase === 3) {             // 1: count tris per cell (into start[cell+1]); 3: fill
      const fill = g.phase === 3;
      const c = g.c, nx = g.nx, ny = g.ny, nz = g.nz, start = g.start, ids = g.ids, pos = g.pos;
      const end = Math.min(g.n, g.cur + budget);
      for (let t = g.cur; t < end; t++) {
        const q = 6 * t;
        const ix0 = Math.max(0, Math.floor((box[q] - g.ox) / c)), ix1 = Math.min(nx - 1, Math.floor((box[q + 3] - g.ox) / c));
        const iy0 = Math.max(0, Math.floor((box[q + 1] - g.oy) / c)), iy1 = Math.min(ny - 1, Math.floor((box[q + 4] - g.oy) / c));
        const iz0 = Math.max(0, Math.floor((box[q + 2] - g.oz) / c)), iz1 = Math.min(nz - 1, Math.floor((box[q + 5] - g.oz) / c));
        for (let iz = iz0; iz <= iz1; iz++) for (let iy = iy0; iy <= iy1; iy++) for (let ix = ix0; ix <= ix1; ix++) {
          const cell = (iz * ny + iy) * nx + ix;
          if (fill) ids[pos[cell]++] = t; else start[cell + 1]++;
        }
      }
      budget -= end - g.cur; g.cur = end;
      if (g.cur >= g.n) {
        if (!fill) g.phase = 2; else { g.phase = 4; g.pos = null; g.done = true; }
        g.cur = 0;
      }
    } else if (g.phase === 2) {                              // prefix sums (one go: a cell is a hundredth of a unit)
      const s = g.start, nc = s.length - 1;
      for (let i = 0; i < nc; i++) s[i + 1] += s[i];
      g.ids = new Int32Array(s[nc]);
      g.pos = s.slice(0, nc);
      budget -= Math.ceil(nc / 100);
      g.phase = 3; g.cur = 0;
    }
  }
  return budget;
}

/**
 * Work points: a deterministic cost (not a clock) of what the distance queries did: 8 per query, 1 per cell read,
 * 1 per triangle looked at and 5 more per triangle measured. 1 point is about 10 ns on the dev Mac;
 * `HOLD_CLEAR.UNITS_PER_FRAME` is a number of points.
 */
let _work = 0;
let _stamp = new Int32Array(0);
let _stampId = 0;

/**
 * Best squared distance below `bound2` from (x, y, z) to any triangle of the grid; `bound2` itself when none is
 * nearer. Only cells whose box is nearer than the best so far are read; a triangle spanning several cells is looked
 * at once per query; a triangle whose own box is too far is not measured.
 */
function gridMinD2(g, x, y, z, bound2, cap = Infinity) {
  const B = Math.sqrt(bound2);
  if (x + B < g.bx0 || x - B > g.bx1 || y + B < g.by0 || y - B > g.by1 || z + B < g.bz0 || z - B > g.bz1) return bound2;
  const c = g.c, nx = g.nx, ny = g.ny, nz = g.nz;
  const ix0 = Math.max(0, Math.floor((x - B - g.ox) / c)), ix1 = Math.min(nx - 1, Math.floor((x + B - g.ox) / c));
  const iy0 = Math.max(0, Math.floor((y - B - g.oy) / c)), iy1 = Math.min(ny - 1, Math.floor((y + B - g.oy) / c));
  const iz0 = Math.max(0, Math.floor((z - B - g.oz) / c)), iz1 = Math.min(nz - 1, Math.floor((z + B - g.oz) / c));
  const start = g.start, ids = g.ids, T = g.tris, box = g.box;
  if (_stamp.length < g.n) { _stamp = new Int32Array(g.n); _stampId = 0; }
  if (++_stampId === 0x7fffffff) { _stamp.fill(0); _stampId = 1; }
  const sid = _stampId, stamp = _stamp;
  const w0 = _work;
  _work += 8;
  let best = bound2;
  for (let iz = iz0; iz <= iz1; iz++) {
    const z0 = g.oz + iz * c; const dz = z0 > z ? z0 - z : (z > z0 + c ? z - z0 - c : 0); const dz2 = dz * dz;
    if (dz2 >= best) continue;
    for (let iy = iy0; iy <= iy1; iy++) {
      const y0 = g.oy + iy * c; const dy = y0 > y ? y0 - y : (y > y0 + c ? y - y0 - c : 0); const dyz2 = dz2 + dy * dy;
      if (dyz2 >= best) continue;
      if (_work - w0 > cap) return 0;                        // over its cap: "something may be near" (never a false clear): the caller goes on to the exact way
      const row = (iz * ny + iy) * nx;
      for (let ix = ix0; ix <= ix1; ix++) {
        const x0 = g.ox + ix * c; const dx = x0 > x ? x0 - x : (x > x0 + c ? x - x0 - c : 0);
        if (dyz2 + dx * dx >= best) continue;
        const cell = row + ix; _work++;
        for (let k = start[cell], e = start[cell + 1]; k < e; k++) {
          const id = ids[k];
          _work++;
          if (stamp[id] === sid) continue;
          stamp[id] = sid;
          const q = 6 * id;
          let a = box[q] - x; if (a < 0) { a = x - box[q + 3]; if (a < 0) a = 0; }
          let b = box[q + 1] - y; if (b < 0) { b = y - box[q + 4]; if (b < 0) b = 0; }
          let cc = box[q + 2] - z; if (cc < 0) { cc = z - box[q + 5]; if (cc < 0) cc = 0; }
          if (a * a + b * b + cc * cc >= best) continue;
          _work += 5;
          const d = ptTri2(x, y, z, T, 9 * id);
          if (d < best) best = d;
        }
      }
    }
  }
  return best;
}

/** Same test as js/test/_flowerFold.js `isFx`: parts that are effects, not hardware. */
function isFxLike(o) {
  return /Plume|Glow|Halo|Sprite|Light|Puff|Beam|Cable|Laser(Beam)?$|Outline|Fairing/.test(o.name || '')
    || (o.material && (o.material.blending === THREE.AdditiveBlending || (o.material.transparent === true && o.material.opacity < 0.2)));
}

export function kitSig(ship) {
  const gs = ship && ship._flowerGroups;
  if (!Array.isArray(gs) || gs.length === 0) return '';
  let s = '';
  for (let i = 0; i < gs.length; i++) {
    const fg = gs[i], h = fg && fg.hinge, p = h && h.parent;
    if (!p) return '';
    let tipX = 0;
    for (let k = 0; k < h.children.length; k++) if ((h.children[k].name || '').startsWith('FlowerStrutTip_')) { tipX = Math.round(h.children[k].position.x / M * 1000); break; }
    s += `${fg.azDeg}:${p.children.length}.${h.children.length}.${tipX};`;
  }
  return s + 'c' + cradlesOf(ship).length;
}

/** The launch hold-downs: `FlowerStrutCradle_i` and its `_Pin` sit on the hull skin, outside every pivot subtree, and never turn. */
function cradlesOf(ship) {
  const out = [];
  const ch = ship.children;
  if (Array.isArray(ch)) for (let i = 0; i < ch.length; i++) if (ch[i].isMesh && /^FlowerStrutCradle_\d+(_Pin)?$/.test(ch[i].name || '')) out.push(ch[i]);
  return out;
}

function shadowOf(o, map, out, inHinge, hinge, depth) {
  const n = new THREE.Object3D();
  n.name = o.name;
  n.rotation.copy(o.rotation);                       // Euler (with its order) first: it drives the quaternion
  n.position.copy(o.position);
  n.scale.copy(o.scale);
  map.set(o, n);
  const moving = inHinge || o === hinge;
  if (o.isMesh && o.geometry && o.geometry.getAttribute('position') && !isFxLike(o)) out.push({ node: n, local: localTrisOf(o.geometry), moving, name: o.name });
  for (let i = 0; i < o.children.length; i++) {
    const c = shadowOf(o.children[i], map, out, moving, hinge, depth + 1);
    n.add(c);
  }
  return n;
}

function meshTriCount(geo) {
  const pos = geo.getAttribute('position');
  return (geo.index ? geo.index.count : pos.count) / 3;
}

const _localCache = new WeakMap();
/**
 * A part's triangles in its own frame (flat Float32Array). A part of up to `SIMPLIFY_TRIS` triangles is kept exact (the
 * radiator panels are 12-triangle boxes); anything finer (lugs, bolts, hoses, ears) is replaced by its bounding box
 * in the part's own frame, which contains it — "clear of the box" is "clear of the part"; only a part's own rounding
 * (a cylinder's corners, about a centimetre) can read blocked early. The kit is about eight times smaller.
 */
function localTrisOf(geo) {
  let l = _localCache.get(geo);
  if (l) return l;
  const pos = geo.getAttribute('position'), idx = geo.index ? geo.index.array : null;
  const n = meshTriCount(geo);
  if (n <= Constants.HOLD_CLEAR.SIMPLIFY_TRIS) {
    l = new Float32Array(n * 9);
    for (let t = 0; t < n; t++) for (let k = 0; k < 3; k++) {
      const vi = idx ? idx[3 * t + k] : 3 * t + k;
      l[9 * t + 3 * k] = pos.getX(vi); l[9 * t + 3 * k + 1] = pos.getY(vi); l[9 * t + 3 * k + 2] = pos.getZ(vi);
    }
  } else {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const c = (i) => [(i & 1) ? x1 : x0, (i & 2) ? y1 : y0, (i & 4) ? z1 : z0];
    const faces = [[0, 2, 3, 0, 3, 1], [4, 5, 7, 4, 7, 6], [0, 1, 5, 0, 5, 4], [2, 6, 7, 2, 7, 3], [0, 4, 6, 0, 6, 2], [1, 3, 7, 1, 7, 5]];
    const out = [];
    for (const f of faces) for (const i of f) out.push(...c(i));
    l = Float32Array.from(out);
  }
  _localCache.set(geo, l);
  return l;
}

/**
 * Build (once per kit signature) the detached radiator copies and the two angle sets. Null when the ship has no
 * radiator kit. `opts` (probes only): other wing-angle sets.
 */
export function buildKit(ship, opts = null) {
  const sig = kitSig(ship);
  if (!sig || typeof ship._writeFlowerPose !== 'function') return null;
  const HC = Constants.HOLD_CLEAR;
  const groups = [];
  const fakeGroups = [];
  for (const fg of ship._flowerGroups) {
    const pivot = fg.hinge.parent;
    const map = new Map();
    const meshes = [];
    const root = shadowOf(pivot, map, meshes, false, fg.hinge, 0);
    const sh = map.get(fg.hinge);
    const tw = fg.tipHw;
    fakeGroups.push({
      hinge: sh, azDeg: fg.azDeg, pair: fg.pair, wings: fg.wings.map((w) => map.get(w)),
      tipHw: tw ? { index: tw.index, stalk: map.get(tw.stalk), stalkIn: map.get(tw.stalkIn), conePivot: map.get(tw.conePivot), cone: map.get(tw.cone), u: NaN } : null,
    });
    let moving = 0, fixed = 0;
    for (const m of meshes) { const n = m.local.length / 9; if (m.moving) moving += n; else fixed += n; }
    groups.push({ az: fg.azDeg, root, meshes, moving, fixed });
  }
  for (const c of cradlesOf(ship)) {                  // round 1 F6: the hold-downs are radiator hardware too (fixed parts, in the ship's frame like the pivots)
    const meshes = [];
    const root = shadowOf(c, new Map(), meshes, false, null, 0);
    let fixed = 0;
    for (const m of meshes) fixed += m.local.length / 9;
    groups.push({ az: -1, root, meshes, moving: 0, fixed });
  }
  const fake = {
    _flowerGroups: fakeGroups, _petalHolds: [], _flowerThetaRad: 0, tipCargo: null, leashDriver: null,
    _flowerWingFoldAngle: ship._flowerWingFoldAngle, _updateTipStalks: ship._updateTipStalks,
  };
  const mkSet = (name, angles) => {
    let cap = 0;
    for (const g of groups) cap += g.fixed + g.moving * angles.length;
    return { name, angles, tris: new Float32Array(cap * 9), cap, n: 0, phase: 'fixed', ai: 0, gi: 0, grid: null, done: false };
  };
  const kit = {
    sig, groups, fake, writePose: ship._writeFlowerPose,
    sets: [mkSet('rest', (opts && opts.rest) || restAnglesDeg()), mkSet('band', (opts && opts.band) || bandAnglesDeg())],
    si: 0, ready: false, trisTotal: 0, nGroups: ship._flowerGroups.length, calls: 0,
  };
  for (const s of kit.sets) kit.trisTotal += s.cap * 2;       // extraction + grid passes (the count and fill passes are about one pass each)
  return kit;
}

/**
 * The kit for this ship: built on first use, rebuilt when its signature changes; null without a radiator kit. The
 * signature (a string, asked every frame) is re-read when the petal count changes, else once per `SIG_RECHECK` calls.
 */
const SIG_RECHECK = 120;
export function kitFor(ship) {
  if (!ship) return null;
  let k = ship._holdWingKit;
  const n = Array.isArray(ship._flowerGroups) ? ship._flowerGroups.length : 0;
  if (k && n === k.nGroups && (k.calls = (k.calls + 1) % SIG_RECHECK) !== 0) return k;
  const sig = kitSig(ship);
  if (!sig) { ship._holdWingKit = null; return null; }
  if (!k || k.sig !== sig) { k = buildKit(ship); ship._holdWingKit = k; }
  return k;
}

function poseKit(kit, thetaDeg) {
  kit.fake._flowerThetaRad = thetaDeg * DEG2RAD;
  kit.writePose.call(kit.fake);
  for (const g of kit.groups) g.root.updateMatrixWorld(true);
}

function extractMesh(set, entry) {
  const L = entry.local;
  const e = entry.node.matrixWorld.elements;
  const e0 = e[0], e1 = e[1], e2 = e[2], e4 = e[4], e5 = e[5], e6 = e[6], e8 = e[8], e9 = e[9], e10 = e[10], e12 = e[12], e13 = e[13], e14 = e[14];
  const inv = 1 / M;
  const n = L.length / 9;
  const T = set.tris;
  let o = set.n * 9;
  for (let i = 0; i < 3 * n; i++) {
    const x = L[3 * i], y = L[3 * i + 1], z = L[3 * i + 2];
    T[o++] = (e0 * x + e4 * y + e8 * z + e12) * inv;
    T[o++] = (e1 * x + e5 * y + e9 * z + e13) * inv;
    T[o++] = (e2 * x + e6 * y + e10 * z + e14) * inv;
  }
  set.n += n;
  return n;
}

/** Work points the kit's build still needs (an estimate: triangles left to extract and to put in a grid, `KIT_TRI_POINTS` each). */
export function kitWorkLeft(kit) {
  if (!kit || kit.ready) return 0;
  let tris = 0;
  for (let i = kit.si; i < kit.sets.length; i++) {
    const st = kit.sets[i];
    if (st.done) continue;
    tris += 2 * st.cap - (i === kit.si ? st.n + (st.grid ? st.grid.cur : 0) : 0);
  }
  return Math.max(0, tris) * KIT_TRI_POINTS;
}

/** Work points per radiator triangle in the kit build (extraction, bounds, count and fill passes; ~0.2 us on the dev Mac). */
const KIT_TRI_POINTS = 25;

export function kitStep(kit, points) {
  if (!kit || kit.ready) return true;
  const budget0 = points / KIT_TRI_POINTS;
  let budget = budget0;
  while (budget > 0 && !kit.ready) {
    const set = kit.sets[kit.si];
    if (set.phase === 'fixed') {
      const g = kit.groups[set.gi];
      if (set.gi === 0 && set.ai === 0) poseKit(kit, set.angles.length ? set.angles[0] : 0);
      for (const m of g.meshes) if (!m.moving) budget -= extractMesh(set, m);
      budget -= 1;
      if (++set.gi >= kit.groups.length) { set.phase = 'angles'; set.gi = 0; set.ai = 0; }
    } else if (set.phase === 'angles') {
      if (set.ai >= set.angles.length) { set.phase = 'grid'; set.grid = gridNew(set.tris, set.n, Constants.HOLD_CLEAR.CELL_M); continue; }
      if (set.gi === 0) poseKit(kit, set.angles[set.ai]);
      const g = kit.groups[set.gi];
      for (const m of g.meshes) if (m.moving) budget -= extractMesh(set, m);
      budget -= 1;
      if (++set.gi >= kit.groups.length) { set.gi = 0; set.ai++; }
    } else if (set.phase === 'grid') {
      budget = gridStep(set.grid, budget);
      if (set.grid.done) { set.phase = 'done'; set.done = true; kit.si++; if (kit.si >= kit.sets.length) kit.ready = true; }
    }
  }
  _work += Math.round((budget0 - budget) * KIT_TRI_POINTS);      // what was really spent (a step may run a little over), in the one counter
  return kit.ready;
}

export function kitFinish(kit) {
  while (kit && !kit.ready) kitStep(kit, 1e12);
  return kit;
}

function splitTris(src, maxR) {
  const out = [];
  const n = src.length / 9;
  const q = [];
  for (let t = 0; t < n; t++) {
    q.length = 0;
    q.push(Array.from(src.subarray(9 * t, 9 * t + 9)));
    while (q.length) {
      const a = q.pop();
      const gx = (a[0] + a[3] + a[6]) / 3, gy = (a[1] + a[4] + a[7]) / 3, gz = (a[2] + a[5] + a[8]) / 3;
      let r2 = 0;
      for (let v = 0; v < 3; v++) { const dx = a[3 * v] - gx, dy = a[3 * v + 1] - gy, dz = a[3 * v + 2] - gz; const d = dx * dx + dy * dy + dz * dz; if (d > r2) r2 = d; }
      if (r2 <= maxR * maxR || q.length > 60) { for (let k = 0; k < 9; k++) out.push(a[k]); continue; }
      let l = 0, best = -1;
      for (let v = 0; v < 3; v++) { const w = (v + 1) % 3; const dx = a[3 * v] - a[3 * w], dy = a[3 * v + 1] - a[3 * w + 1], dz = a[3 * v + 2] - a[3 * w + 2]; const d = dx * dx + dy * dy + dz * dz; if (d > best) { best = d; l = v; } }
      const p = l, qv = (l + 1) % 3, r = (l + 2) % 3;
      const mx = (a[3 * p] + a[3 * qv]) / 2, my = (a[3 * p + 1] + a[3 * qv + 1]) / 2, mz = (a[3 * p + 2] + a[3 * qv + 2]) / 2;
      q.push([a[3 * p], a[3 * p + 1], a[3 * p + 2], mx, my, mz, a[3 * r], a[3 * r + 1], a[3 * r + 2]]);
      q.push([mx, my, mz, a[3 * qv], a[3 * qv + 1], a[3 * qv + 2], a[3 * r], a[3 * r + 1], a[3 * r + 2]]);
    }
  }
  return Float64Array.from(out);
}

/** The work points `prepPiece` will cost: ~100 per source triangle and 200 over (read from the cached geometry: cheap, no copy). */
function prepCost(piece) {
  if (piece.isBag === true || !piece.type) return 200;
  const geo = DebrisWireframe.getGeometry(piece.type, piece.id);
  const pos = geo && geo.getAttribute('position');
  if (!pos) return 200;
  return 100 * ((geo.index ? geo.index.array.length : pos.count) / 3) + 200;
}

/**
 * Pay `cost` work points in installments within the call's budget (`until`, a value of `_work`). A profile's own
 * bookkeeping (mesh prep, placing a pose) runs in one go, so it is paid BEFORE it runs: a frame never spends more than
 * its budget plus one distance query. `w.owed` is the unpaid rest between calls. True when paid in full.
 */
function pay(w, cost, until) {
  if (w.owed === null) w.owed = cost;
  const p = Math.min(w.owed, Math.max(0, until - _work));
  w.owed -= p; _work += p;
  if (w.owed > 0) return false;
  w.owed = null;
  return true;
}

/** What a piece is, for the clearance test: a ball (scoop bag, typeless catch) or its drawn triangles in the piece's own frame (m). */
function prepPiece(piece, splitM) {
  const sizeM = piece.sizeMeter || 0;
  const reach = DebrisField.trueReachM(piece, sizeM);
  if (piece.isBag === true || !piece.type) return { ball: true, reach, tris: null, n: 0, src: 0 };
  const geo = DebrisWireframe.getGeometry(piece.type, piece.id);
  const pos = geo && geo.getAttribute('position');
  const sc = DebrisField.effectiveRenderScale(piece) / M;
  if (!pos || !(sc > 0)) return { ball: true, reach, tris: null, n: 0, src: 0 };
  const idx = geo.index ? geo.index.array : null;
  const nTri = (idx ? idx.length : pos.count) / 3;
  const src = new Float64Array(nTri * 9);
  let r2 = 0;
  for (let t = 0; t < nTri; t++) for (let k = 0; k < 3; k++) {
    const vi = idx ? idx[3 * t + k] : 3 * t + k;
    const x = pos.getX(vi) * sc, y = pos.getY(vi) * sc, z = pos.getZ(vi) * sc;
    src[9 * t + 3 * k] = x; src[9 * t + 3 * k + 1] = y; src[9 * t + 3 * k + 2] = z;
    const d = x * x + y * y + z * z; if (d > r2) r2 = d;
  }
  const tris = splitTris(src, splitM);
  return { ball: false, reach: Math.max(reach, Math.sqrt(r2)), tris, n: tris.length / 9, src: nTri };
}

/**
 * Walk the triangles `T[9 * st.t .. 9n)` (placed in the ship frame) until `_work` reaches `until`. Each is cut by
 * bisection where its distance from the radiator grid cannot yet be told from the clearance. State lives in `st`
 * (`t`, `sp`, `q`, the stack `S`). Returns 1 = every triangle is `clearM` or more off the grid, 0 = one is not (or
 * cannot be shown to be), -1 = out of budget, resume. Never a false 1 (triangle inequality).
 */
function trisRun(grid, T, n, st, clearM, leafM, maxQ, until) {
  const S = st.S;
  for (;;) {
    if (st.sp === 0) {
      if (st.t >= n) return 1;
      const o = 9 * st.t++;
      for (let k = 0; k < 9; k++) S[k] = T[o + k];
      st.sp = 9;
    }
    st.sp -= 9;
    const o = st.sp;
    const gx = (S[o] + S[o + 3] + S[o + 6]) / 3, gy = (S[o + 1] + S[o + 4] + S[o + 7]) / 3, gz = (S[o + 2] + S[o + 5] + S[o + 8]) / 3;
    let r2 = 0;
    for (let v = 0; v < 3; v++) { const dx = S[o + 3 * v] - gx, dy = S[o + 3 * v + 1] - gy, dz = S[o + 3 * v + 2] - gz; const d = dx * dx + dy * dy + dz * dz; if (d > r2) r2 = d; }
    const R = Math.sqrt(r2);
    const B = clearM + R, B2 = B * B;
    if (++st.q > maxQ) return 0;
    const b2 = gridMinD2(grid, gx, gy, gz, B2);
    if (b2 < B2) {
      if (b2 < clearM * clearM) return 0;                       // the centroid is a surface point inside the clearance
      if (R < leafM || o + 18 > S.length) return 0;             // cannot prove it: blocked
      let l = 0, best = -1;
      for (let v = 0; v < 3; v++) { const w = (v + 1) % 3; const dx = S[o + 3 * v] - S[o + 3 * w], dy = S[o + 3 * v + 1] - S[o + 3 * w + 1], dz = S[o + 3 * v + 2] - S[o + 3 * w + 2]; const d = dx * dx + dy * dy + dz * dz; if (d > best) { best = d; l = v; } }
      const p = o + 3 * l, q = o + 3 * ((l + 1) % 3), r = o + 3 * ((l + 2) % 3);
      const mx = (S[p] + S[q]) / 2, my = (S[p + 1] + S[q + 1]) / 2, mz = (S[p + 2] + S[q + 2]) / 2;
      const px = S[p], py = S[p + 1], pz = S[p + 2], qx = S[q], qy = S[q + 1], qz = S[q + 2], rx = S[r], ry = S[r + 1], rz = S[r + 2];
      S[o] = px; S[o + 1] = py; S[o + 2] = pz; S[o + 3] = mx; S[o + 4] = my; S[o + 5] = mz; S[o + 6] = rx; S[o + 7] = ry; S[o + 8] = rz;
      S[o + 9] = mx; S[o + 10] = my; S[o + 11] = mz; S[o + 12] = qx; S[o + 13] = qy; S[o + 14] = qz; S[o + 15] = rx; S[o + 16] = ry; S[o + 17] = rz;
      st.sp = o + 18;
    }
    if (_work >= until) return -1;
  }
}

const _book = { x: 0, y: 0, z: 0 };
const _poseQ = new THREE.Quaternion();

function placeTris(prep, D, cx, cy, cz, q) {
  const n = prep.n;
  const x = q.x, y = q.y, z = q.z, w = q.w;
  const r00 = 1 - 2 * (y * y + z * z), r01 = 2 * (x * y - z * w), r02 = 2 * (x * z + y * w);
  const r10 = 2 * (x * y + z * w), r11 = 1 - 2 * (x * x + z * z), r12 = 2 * (y * z - x * w);
  const r20 = 2 * (x * z - y * w), r21 = 2 * (y * z + x * w), r22 = 1 - 2 * (x * x + y * y);
  const S = prep.tris;
  for (let i = 0; i < 3 * n; i++) {
    const px = S[3 * i], py = S[3 * i + 1], pz = S[3 * i + 2];
    D[3 * i] = cx + r00 * px + r01 * py + r02 * pz;
    D[3 * i + 1] = cy + r10 * px + r11 * py + r12 * pz;
    D[3 * i + 2] = cz + r20 * px + r21 * py + r22 * pz;
  }
}

/** The cache key of a profile: arm, rack cell, frozen attitude, cell offset, size and kit. Valid only while it matches. */
function keyOf(piece, armIndex, kitSigStr) {
  const q = piece._qLocalHer, o = piece._rackLocalM;
  return [armIndex, Number.isInteger(piece._rackCell) ? piece._rackCell : -1,
    q ? q.x : 0, q ? q.y : 0, q ? q.z : 0, q ? q.w : 1, o ? o.x : 0, o ? o.y : 0, o ? o.z : 0,
    piece.sizeMeter || 0, piece.isBag === true ? 1 : 0, piece.id | 0, kitSigStr, piece.type || ''];
}
/** `keyOf(piece, armIndex, sig)` equals `k`, without building the array (asked for every racked catch each frame). */
function keyMatches(k, piece, armIndex, sig) {
  if (!k) return false;
  const q = piece._qLocalHer, o = piece._rackLocalM;
  return k[0] === armIndex && k[1] === (Number.isInteger(piece._rackCell) ? piece._rackCell : -1)
    && k[2] === (q ? q.x : 0) && k[3] === (q ? q.y : 0) && k[4] === (q ? q.z : 0) && k[5] === (q ? q.w : 1)
    && k[6] === (o ? o.x : 0) && k[7] === (o ? o.y : 0) && k[8] === (o ? o.z : 0)
    && k[9] === (piece.sizeMeter || 0) && k[10] === (piece.isBag === true ? 1 : 0) && k[11] === (piece.id | 0)
    && k[12] === sig && k[13] === (piece.type || '');
}

export function profileValid(mgr, armIndex, piece) {
  const w = piece && piece._wingClear;
  const ship = mgr && mgr.playerSatellite;
  if (!w || !ship) return false;
  const kit = ship._holdWingKit;
  return !!kit && keyMatches(w.key, piece, armIndex, kit.sig);
}

/**
 * Begin a profile for one racked piece; a valid one already there is kept. False when the ship has no radiator kit
 * or the piece has no mass.
 */
export function startProfile(mgr, armIndex, piece) {
  const ship = mgr.playerSatellite;
  const kit = kitFor(ship);
  if (!kit || !piece || !piece.mass) return false;
  const w = piece._wingClear;
  if (w && keyMatches(w.key, piece, armIndex, kit.sig)) return true;
  piece._wingClear = {
    arm: armIndex, key: keyOf(piece, armIndex, kit.sig), rest: new Uint8Array(NP), band: new Uint8Array(NP), done: false,
    prep: null, owed: null, k: 0, s: 0, stage: 0, placed: false, buf: null, st: null, spent: 0,
  };
  return true;
}

/**
 * Run about `points` work points of one piece's profile: the kit's build first (while not ready), then the piece's
 * preparation, then its poses (each against the rest grid, then the band grid), suspending between queries. Returns
 * the points not spent (<= 0 when the budget ran out). `piece._wingClear.done` is set at the end.
 */
export function stepProfile(mgr, piece, points) {
  const w = piece && piece._wingClear;
  if (!w || w.done) return points;
  const HC = Constants.HOLD_CLEAR;
  const ship = mgr.playerSatellite;
  const kit = kitFor(ship);
  if (!kit) return points;
  if (!kit.ready) {
    const w0 = _work;
    kitStep(kit, points);
    points -= _work - w0;                                   // the build's own spend comes out of this call's budget
    if (!kit.ready || points <= 0) return 0;
  }
  const arm = mgr.arms[w.arm];
  const dp = mgr._dockPositions && mgr._dockPositions[w.arm];
  if (!arm || !dp) return points;
  const clearM0 = Constants.REEL_HOLD.CLEAR_M;
  const t0 = _work;
  const until = t0 + points;
  const slot = Math.max(0, arm.heldCatches ? arm.heldCatches.indexOf(piece) : 0);
  while (_work < until && !w.done) {
    if (!w.prep) {
      if (!pay(w, prepCost(piece), until)) break;                // ~1 us per source triangle
      w.prep = prepPiece(piece, HC.SPLIT_M);
      if (!w.prep.ball) { w.buf = new Float64Array(9 * w.prep.n); w.st = { t: 0, sp: 0, q: 0, S: new Float64Array(9 * 96) }; }
      continue;
    }
    const k = w.k;
    if (!w.placed) {                                         // her pose at this strut angle, once per pose (both grids read it)
      if (!pay(w, (w.prep.ball ? 0 : w.prep.n * 3) + 20, until)) break;
      heldCargoBookingMeters(arm, dp, POSES[k] * DEG2RAD, ship, slot, piece.sizeMeter || 0, _book, null, piece, _poseQ);
      w.cx = _book.x; w.cy = _book.y; w.cz = _book.z;
      if (!w.prep.ball) placeTris(w.prep, w.buf, w.cx, w.cy, w.cz, _poseQ);
      w.placed = true; w.stage = 0;
      if (w.st) { w.st.t = 0; w.st.sp = 0; w.st.q = 0; }
    }
    const grid = kit.sets[w.s].grid;
    const out = w.s === 0 ? w.rest : w.band;
    const clearM = clearM0 + (w.s === 0 ? HC.REST_MARGIN_M : HC.BAND_MARGIN_M);     // sampled, not swept: the margin covers what a step can miss
    let res;
    if (w.stage === 0) {                                     // the whole piece lies within `reach` of its pin point: nothing that near -> clear
      const B = w.prep.reach + clearM, B2 = B * B;
      if (gridMinD2(grid, w.cx, w.cy, w.cz, B2, w.prep.ball ? Infinity : HC.BALL_CAP_POINTS) >= B2) res = 1;
      else if (w.prep.ball) res = 0;
      else w.stage = 1;
    }
    if (w.stage === 1) res = trisRun(grid, w.buf, w.prep.n, w.st, clearM, HC.LEAF_M, HC.MAX_QUERIES, until);
    if (res === -1) break;                                    // out of budget: resume here next call
    out[k] = res === 1 ? 1 : 0;
    w.stage = 0;
    if (w.st) { w.st.t = 0; w.st.sp = 0; w.st.q = 0; }
    if (++w.s >= 2) {
      w.s = 0; w.k++; w.placed = false;
      if (w.k >= NP) { w.done = true; w.prep = null; w.buf = null; w.st = null; }
    }
  }
  const used = _work - t0;
  w.spent += used;
  return points - used;
}

/** Work points spent so far by every kit build and profile step (the deterministic counter the per-frame budget uses). Test helper. */
export function workDone() { return _work; }

const _prof = { state: 0, rest: new Uint8Array(NP), band: new Uint8Array(NP) };
/**
 * The arm's profile as one read: state 0 = none started on her rack, 1 = pending, 2 = done; `rest` and `band` are the
 * AND over every racked piece. The returned object is a shared scratch: read it at once.
 */
export function armProfile(arm) {
  const rack = arm && arm.heldCatches;
  _prof.state = 0;
  if (!Array.isArray(rack) || Constants.HOLD_CLEAR.ENABLED === false) return _prof;
  let any = false, pending = false;
  _prof.rest.fill(1); _prof.band.fill(1);
  for (let i = 0; i < rack.length; i++) {
    const p = rack[i];
    if (!p || !p.mass) continue;
    const w = p._wingClear;
    if (!w) continue;
    any = true;
    if (!w.done) { pending = true; continue; }
    for (let k = 0; k < NP; k++) { if (!w.rest[k]) _prof.rest[k] = 0; if (!w.band[k]) _prof.band[k] = 0; }
  }
  _prof.state = !any ? 0 : (pending ? 1 : 2);
  return _prof;
}

/**
 * Is a strut angle (deg) clear in the profile's `set`? A grid angle reads its own pose; between two grid poses needs
 * both neighbours clear; outside the grid it reads the end pose.
 */
export function profileClearAt(prof, set, deg) {
  const a = prof[set];
  if (deg <= POSES[0]) return a[0] === 1;
  if (deg >= POSES[NP - 1]) return a[NP - 1] === 1;
  for (let k = 0; k < NP - 1; k++) {
    if (deg >= POSES[k] - 1e-6 && deg <= POSES[k + 1] + 1e-6) {
      if (Math.abs(deg - POSES[k]) < 1e-6) return a[k] === 1;
      if (Math.abs(deg - POSES[k + 1]) < 1e-6) return a[k + 1] === 1;
      return a[k] === 1 && a[k + 1] === 1;
    }
  }
  return true;
}

export function poseIndexOf(deg) { return POSES.indexOf(Math.round(deg)); }
