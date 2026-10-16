/**
 * ShipKeepOut.js — one exact answer to "what is in the way?" for the ship and
 * the daughters docked on it.
 *
 *   const ko = createShipKeepOut({ player, armManager });
 *   ko.segment(a, b, radius, opts) → { gap, dist, name, cat, hits? }
 *   ko.sphere(c, r, opts)          → { gap, dist, name, cat, hits? }
 *   ko.measureCat(cat, dir)        → { centre, halfWidth, halfLength, n }
 *   ko.setSphereProvider(fn)       // extra obstacles each query (held catches)
 *   ko.refresh()                   // force a structure re-collect + matrix update
 *
 * All points are in the SHIP frame (the player root's local frame), in METRES.
 * `gap` is the exact distance from the segment (or point) to the nearest
 * triangle of the nearest obstacle, minus `radius` (<= 0 means touching or
 * overlapping). `name` is that mesh's name; `cat` is one of
 * hull | wing | rad | nose | strut<N> | dau<N> | catch.
 *
 * WHY EXACT TRIANGLES: the leash line passes 0.050-0.113 m from the nose
 * sensors (LaserBaffle, EO_Bezel, IR_Aperture, LIDAR_Lens); boxes or cylinders
 * would report snags there that do not exist (probe 2026-10-14, tmp/probes/leash).
 *
 * HOW IT STAYS CURRENT WITHOUT A RE-COLLECT: every mesh's triangles are stored
 * once in the mesh's OWN frame. A query is carried into each candidate mesh's
 * local frame through the CURRENT `matrixWorld` (struts, radiators, wing tilt,
 * a daughter's pose all move), so a part that moved since the last query is
 * seen where it is now. Meshes whose ship-relative matrix is not a rigid motion
 * with one uniform scale (a handful of harness / furled-coil pieces) take a slow
 * path: their triangles are re-transformed whenever that matrix changes.
 *
 * MESH FILTER (the reference probe's rules; `isFx` of js/test/_flowerFold.js):
 *   - THREE.Mesh only (no InstancedMesh / SkinnedMesh, no Line / Sprite / Points)
 *   - dropped as effects when the name matches
 *     /Plume|Glow|Halo|Sprite|Light|Puff|Beam|Cable|Laser(Beam)?$|Outline|Fairing/
 *     (note: that also drops names containing "Cable" and "Fairing"; the solid
 *     NavLight_Port / NavLight_Starboard spheres are exempt from the "Light" rule), or the
 *     material is additive-blended, or transparent with opacity < 0.2
 *   - LOD / cull visibility is IGNORED: the ship's `_detailMeshes` set (hidden
 *     by camera distance, PlayerSatellite.setCameraDistance) and a daughter's
 *     `_detailMeshes` are solid whatever their `.visible` says (except her
 *     bridle ring / hardpoints, which ArmUnit also hides BY STATE while the
 *     tether is stowed); a docked daughter's `group.visible` / `mesh.visible`
 *     (hidden by the caller, e.g. at the menu) are ignored too.
 *   - every OTHER `.visible === false` (own or ancestor) or `material.visible
 *     === false` means "this part does not exist in the current state" (the
 *     furled-wing coil while the wings are out, a retracted clamp pin, a
 *     daughter's stowed gimbal ring) and is skipped. Radiator pairs that are
 *     not installed are simply not in the scene graph.
 *   - daughters count only while they sit on their strut (DOCKED, LAUNCHING
 *     before the spring fires, RELOADING, HOLDING_CATCH, DOCKING); a daughter
 *     out in space is not an obstacle.
 *
 * No test import, no scene mutation, no per-frame cost until asked.
 *
 * @module systems/ShipKeepOut
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';

/** Light-named meshes that are real hardware, not glow (PlayerSatellite._buildNavLights). */
const SOLID_LIGHT = /^NavLight_(Port|Starboard)$/;
const FX_NAME = /Plume|Glow|Halo|Sprite|Light|Puff|Beam|Cable|Laser(Beam)?$|Outline|Fairing/;
/** Daughter states in which the daughter physically sits on her strut. */
const AT_STRUT = new Set(['DOCKED', 'LAUNCHING', 'RELOADING', 'HOLDING_CATCH', 'DOCKING']);

/** Same rule as the probe's `isFx` (js/test/_flowerFold.js) — documented in the header. */
function isFxMesh(o) {
  // NavLight_Port / NavLight_Starboard are 25 mm solid spheres (the glow is their
  // separate additive halo child), so the "Light" effect rule must not drop them.
  if (FX_NAME.test(o.name || '') && !SOLID_LIGHT.test(o.name || '')) return true;
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  for (const m of mats) {
    if (m && (m.blending === THREE.AdditiveBlending || (m.transparent === true && m.opacity < 0.2))) return true;
  }
  return false;
}
function materialsHidden(o) {
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  if (mats.length === 0) return false;
  for (const m of mats) if (!m || m.visible !== false) return false;
  return true;
}

// ── primitives (scalar, allocation-free; port of tmp/probes/leash/eng.mjs) ────

/** Squared distance, point (px,py,pz) → triangle T[o..o+8] (Ericson 5.1.5). */
function ptTri2(px, py, pz, T, o) {
  const ax = T[o], ay = T[o + 1], az = T[o + 2], bx = T[o + 3], by = T[o + 4], bz = T[o + 5], cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let qx, qy, qz;
  if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; }
  else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { qx = bx; qy = by; qz = bz; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3); qx = ax + abx * v; qy = ay + aby * v; qz = az + abz * v;
      } else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { qx = cx; qy = cy; qz = cz; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6); qx = ax + acx * w; qy = ay + acy * w; qz = az + acz * w;
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
              const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
              qx = bx + (cx - bx) * w; qy = by + (cy - by) * w; qz = bz + (cz - bz) * w;
            } else {
              const s = va + vb + vc;
              if (!(Math.abs(s) > 1e-300)) {
                // zero-area triangle: nearest vertex (its neighbours cover the rest)
                const da = apx * apx + apy * apy + apz * apz;
                const db = bpx * bpx + bpy * bpy + bpz * bpz;
                const dc = cpx * cpx + cpy * cpy + cpz * cpz;
                return Math.min(da, db, dc);
              }
              const den = 1 / s, v = vb * den, w = vc * den;
              qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
            }
          }
        }
      }
    }
  }
  const dx = px - qx, dy = py - qy, dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

/** Squared distance between segments p1q1 and p2q2 (Ericson 5.1.9). */
function segSeg2(p1x, p1y, p1z, q1x, q1y, q1z, p2x, p2y, p2z, q2x, q2y, q2z) {
  const d1x = q1x - p1x, d1y = q1y - p1y, d1z = q1z - p1z;
  const d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z;
  const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  const EPS = 1e-12;
  let s, t;
  if (a <= EPS && e <= EPS) { s = 0; t = 0; }
  else if (a <= EPS) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
  else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z, den = a * e - b * b;
      s = den > EPS ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  const dx = (p1x + d1x * s) - (p2x + d2x * t), dy = (p1y + d1y * s) - (p2y + d2y * t), dz = (p1z + d1z * s) - (p2z + d2z * t);
  return dx * dx + dy * dy + dz * dz;
}

/** Squared distance, segment p0p1 → triangle T[o..o+8] (0 when they cross). */
function segTri2(p0x, p0y, p0z, p1x, p1y, p1z, T, o) {
  const ax = T[o], ay = T[o + 1], az = T[o + 2], bx = T[o + 3], by = T[o + 4], bz = T[o + 5], cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
  const dx = p1x - p0x, dy = p1y - p0y, dz = p1z - p0z;
  const den = nx * dx + ny * dy + nz * dz;
  if (Math.abs(den) > 1e-14) {
    const t = (nx * (ax - p0x) + ny * (ay - p0y) + nz * (az - p0z)) / den;
    if (t >= 0 && t <= 1) {
      const xx = p0x + dx * t - ax, xy = p0y + dy * t - ay, xz = p0z + dz * t - az;
      const d00 = abx * abx + aby * aby + abz * abz, d01 = abx * acx + aby * acy + abz * acz, d11 = acx * acx + acy * acy + acz * acz;
      const d20 = xx * abx + xy * aby + xz * abz, d21 = xx * acx + xy * acy + xz * acz;
      const dn = d00 * d11 - d01 * d01;
      const v = (d11 * d20 - d01 * d21) / dn, w = (d00 * d21 - d01 * d20) / dn;
      if (v >= 0 && w >= 0 && v + w <= 1) return 0;
    }
  }
  let m = ptTri2(p0x, p0y, p0z, T, o);
  if (m === 0) return 0;
  const m1 = ptTri2(p1x, p1y, p1z, T, o); if (m1 < m) m = m1;
  const e0 = segSeg2(p0x, p0y, p0z, p1x, p1y, p1z, ax, ay, az, bx, by, bz); if (e0 < m) m = e0;
  const e1 = segSeg2(p0x, p0y, p0z, p1x, p1y, p1z, bx, by, bz, cx, cy, cz); if (e1 < m) m = e1;
  const e2 = segSeg2(p0x, p0y, p0z, p1x, p1y, p1z, cx, cy, cz, ax, ay, az); if (e2 < m) m = e2;
  return m;
}

/** Squared distance from point c to segment ab. */
function ptSeg2(cx, cy, cz, ax, ay, az, bx, by, bz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 > 1e-30 ? ((cx - ax) * abx + (cy - ay) * aby + (cz - az) * abz) / l2 : 0;
  t = Math.min(1, Math.max(0, t));
  const dx = cx - (ax + abx * t), dy = cy - (ay + aby * t), dz = cz - (az + abz * t);
  return dx * dx + dy * dy + dz * dz;
}

const v3 = (p) => (Array.isArray(p) || ArrayBuffer.isView(p)) ? [p[0], p[1], p[2]] : [p.x, p.y, p.z];

/** Positions of a geometry as [x,y,z] reads, with index → flat Float64Array of triangles. */
function extractTriangles(geo, invScale) {
  const pos = geo.getAttribute('position');
  const idx = geo.index ? geo.index.array : null;
  const nVert = idx ? idx.length : pos.count;
  const n = Math.floor(nVert / 3);
  const tris = new Float64Array(9 * n), tb = new Float64Array(6 * n);
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const plain = pos.isBufferAttribute && !pos.normalized;
  const arr = plain ? pos.array : null, stride = pos.itemSize;
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      const vi = idx ? idx[3 * t + k] : 3 * t + k;
      let x, y, z;
      if (plain) { x = arr[vi * stride]; y = arr[vi * stride + 1]; z = arr[vi * stride + 2]; }
      else { x = pos.getX(vi); y = pos.getY(vi); z = pos.getZ(vi); }
      tris[9 * t + 3 * k] = x * invScale; tris[9 * t + 3 * k + 1] = y * invScale; tris[9 * t + 3 * k + 2] = z * invScale;
    }
    for (let c = 0; c < 3; c++) {
      const a = tris[9 * t + c], b = tris[9 * t + 3 + c], d = tris[9 * t + 6 + c];
      const lo = Math.min(a, b, d), hi = Math.max(a, b, d);
      tb[6 * t + c] = lo; tb[6 * t + 3 + c] = hi;
      if (lo < box[c]) box[c] = lo; if (hi > box[3 + c]) box[3 + c] = hi;
    }
  }
  return { tris, tb, n, box };
}

// ── the module ───────────────────────────────────────────────────────────────

/**
 * @param {{ player: THREE.Object3D, armManager?: { arms: any[] } }} deps
 */
export function createShipKeepOut({ player, armManager } = {}) {
  if (!player || typeof player.updateWorldMatrix !== 'function') {
    throw new Error('createShipKeepOut: player must be a THREE.Object3D');
  }
  const Ms = Constants.SCENE_UNITS_PER_METER;
  const entries = new Map();          // mesh → entry
  let list = [];                      // current entries (ship first, then daughters)
  let treeSig = '';
  let sphereProvider = null;
  const SWinv = new THREE.Matrix4();
  const rel = new THREE.Matrix4();
  const cand = [];
  const stats = { entries: 0, triangles: 0, collects: 0, lastCollectMs: 0, lastQueryMs: 0, queries: 0, slowEntries: 0 };

  // ---- collection ----------------------------------------------------------
  function classifyShip(o) {
    let strut = -1, wing = false, rad = false;
    for (let p = o; p && p !== player; p = p.parent) {
      const m = /^StrutPivot_(\d+)$/.exec(p.name || '');
      if (m) { strut = +m[1]; break; }
      if (p === player._solarArrayPivot) wing = true;
      if (/^FlowerStrut/.test(p.name || '')) rad = true;
    }
    if (strut >= 0) return 'strut' + strut;
    const nm = o.name || '';
    if (wing || /^Wing(Clamp|Motor)/.test(nm)) return 'wing';
    if (rad || /^(FlowerStrut|MountBolt_Flower)/.test(nm)) return 'rad';
    if (/^(NetLauncher|BerthCollar|BerthFace)/.test(nm)) return 'nose';
    return 'hull';
  }

  function chainOf(o, root, skip) {
    const chain = [];
    for (let p = o.parent; p && p !== root; p = p.parent) if (!skip || !skip.has(p)) chain.push(p);
    return chain;
  }

  function buildEntry(o, root, kind, arm, armIndex, detail) {
    const geo = o.geometry;
    const pos = geo.getAttribute('position');
    const ex = extractTriangles(geo, 1 / Ms);
    const skip = kind === 'dau' ? new Set([arm.group, arm.mesh]) : null;
    return {
      mesh: o, name: o.name || '(unnamed)', root, kind, arm, armIndex,
      cat: kind === 'dau' ? 'dau' + armIndex : classifyShip(o),
      geo, posVer: pos.version, idxVer: geo.index ? geo.index.version : 0,
      tris: ex.tris, tb: ex.tb, n: ex.n, box: ex.box,
      detail, chain: chainOf(o, root, skip),
      slow: null, slowKey: null,
      // per-query scratch (this entry's view of the current query)
      _mode: 0, _kk: 1, _lb: 0, _p0: [0, 0, 0], _p1: [0, 0, 0], _ig: null, _igBuf: null,
      _lm: new Float64Array(12), _tx: 0, _ty: 0, _tz: 0, _l0: 1,
      _T: null, _tb: null, _nT: 0,
    };
  }

  function collect() {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const next = [];
    const seen = new Set();
    const visit = (root, kind, arm, armIndex) => {
      const detailSrc = (kind === 'dau' ? arm._detailMeshes : player._detailMeshes) || [];
      const detail = new Set(detailSrc);
      // The daughter's bridle hardware is in her LOD set too, but ArmUnit._updateBridle
      // ALSO hides it by state (only drawn while the tether is out) — honour that flag.
      if (kind === 'dau') for (const o of [arm._gimbalRing, arm._bridleHpA, arm._bridleHpB]) if (o) detail.delete(o);
      root.traverse((o) => {
        if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh) return;
        const geo = o.geometry;
        const pos = geo && geo.getAttribute('position');
        if (!pos || isFxMesh(o)) return;
        let e = entries.get(o);
        if (!e || e.geo !== geo || e.root !== root || e.kind !== kind || e.armIndex !== armIndex
            || e.posVer !== pos.version || e.idxVer !== (geo.index ? geo.index.version : 0)) {
          e = buildEntry(o, root, kind, arm, armIndex, detail.has(o));
          entries.set(o, e);
        } else { e.detail = detail.has(o); e.arm = arm; }
        seen.add(o);
        next.push(e);
      });
    };
    visit(player, 'ship', null, -1);
    const arms = (armManager && armManager.arms) || [];
    for (let i = 0; i < arms.length; i++) {
      const arm = arms[i];
      if (arm && arm.group) visit(arm.group, 'dau', arm, i);
    }
    for (const o of [...entries.keys()]) if (!seen.has(o)) entries.delete(o);
    list = next;
    let tn = 0;
    for (const e of list) tn += e.n;
    stats.entries = list.length; stats.triangles = tn; stats.collects++;
    stats.lastCollectMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  }

  function signature() {
    let s = 0, c = 0;
    const f = (o) => { c++; s += o.id; };
    player.traverse(f);
    const arms = (armManager && armManager.arms) || [];
    for (const a of arms) if (a && a.group) a.group.traverse(f);
    return c + ':' + s + ':' + arms.length;
  }

  /** Bring every matrix up to date and (cheaply) notice a changed scene graph. */
  function freshen(force) {
    player.updateWorldMatrix(true, true);
    const arms = (armManager && armManager.arms) || [];
    for (const a of arms) if (a && a.group) a.group.updateWorldMatrix(true, true);
    const sig = signature();
    if (force || sig !== treeSig) { treeSig = sig; collect(); }
    else {
      // geometry rewritten in place (position buffer re-uploaded) → refresh that entry only
      for (let i = 0; i < list.length; i++) {
        const e = list[i], g = e.mesh.geometry;
        if (g !== e.geo || g.getAttribute('position').version !== e.posVer) { collect(); break; }
      }
    }
  }

  // ---- per-entry view of the query ------------------------------------------
  /** Bring the world segment/point into entry `e`'s frame. Returns false to skip (collapsed mesh). */
  function setupView(e, ax, ay, az, bx, by, bz) {
    rel.multiplyMatrices(SWinv, e.mesh.matrixWorld);
    const m = rel.elements;
    const l0 = m[0] * m[0] + m[1] * m[1] + m[2] * m[2];
    const l1 = m[4] * m[4] + m[5] * m[5] + m[6] * m[6];
    const l2 = m[8] * m[8] + m[9] * m[9] + m[10] * m[10];
    if (!(l0 > 1e-40 && l1 > 1e-40 && l2 > 1e-40)) return false;      // scaled to nothing
    const tx = m[12] / Ms, ty = m[13] / Ms, tz = m[14] / Ms;
    const tol = 2e-7;
    const uniform = Math.abs(l1 - l0) <= tol * l0 && Math.abs(l2 - l0) <= tol * l0
      && Math.abs(m[0] * m[4] + m[1] * m[5] + m[2] * m[6]) <= tol * l0
      && Math.abs(m[0] * m[8] + m[1] * m[9] + m[2] * m[10]) <= tol * l0
      && Math.abs(m[4] * m[8] + m[5] * m[9] + m[6] * m[10]) <= tol * l0;
    if (uniform) {
      e._mode = 0; e._kk = Math.sqrt(l0);
      e._T = e.tris; e._tb = e.tb; e._nT = e.n;
      let dx = ax - tx, dy = ay - ty, dz = az - tz;
      e._p0[0] = (m[0] * dx + m[1] * dy + m[2] * dz) / l0;
      e._p0[1] = (m[4] * dx + m[5] * dy + m[6] * dz) / l0;
      e._p0[2] = (m[8] * dx + m[9] * dy + m[10] * dz) / l0;
      dx = bx - tx; dy = by - ty; dz = bz - tz;
      e._p1[0] = (m[0] * dx + m[1] * dy + m[2] * dz) / l0;
      e._p1[1] = (m[4] * dx + m[5] * dy + m[6] * dz) / l0;
      e._p1[2] = (m[8] * dx + m[9] * dy + m[10] * dz) / l0;
      for (let i = 0; i < 12; i++) e._lm[i] = m[i];
      e._tx = tx; e._ty = ty; e._tz = tz; e._l0 = l0;
      const bb = e.box, kk = e._kk;
      // gap between the query's local AABB and the mesh's local AABB (valid lower bound)
      const lo0 = Math.min(e._p0[0], e._p1[0]), hi0 = Math.max(e._p0[0], e._p1[0]);
      const lo1 = Math.min(e._p0[1], e._p1[1]), hi1 = Math.max(e._p0[1], e._p1[1]);
      const lo2 = Math.min(e._p0[2], e._p1[2]), hi2 = Math.max(e._p0[2], e._p1[2]);
      const gx = Math.max(bb[0] - hi0, 0, lo0 - bb[3]), gy = Math.max(bb[1] - hi1, 0, lo1 - bb[4]), gz = Math.max(bb[2] - hi2, 0, lo2 - bb[5]);
      e._lb = Math.sqrt(gx * gx + gy * gy + gz * gz) * kk;
      return true;
    }
    // slow path: transformed copy in ship metres, rebuilt when the matrix changed
    const kk0 = Math.sqrt(Math.max(l0, l1, l2));
    let stale = !e.slow;
    if (stale) stats.slowEntries++;
    if (!stale) {
      const k = e.slowKey;
      for (let i = 0; i < 12; i++) if (Math.abs(k[i] - m[i]) > 1e-10 * kk0) { stale = true; break; }
      if (!stale) for (let i = 12; i < 15; i++) if (Math.abs(k[i] - m[i]) > 1e-10 * Ms) { stale = true; break; }
    }
    if (stale) {
      const src = e.tris, nTri = e.n;
      const T = new Float64Array(9 * nTri), tb = new Float64Array(6 * nTri);
      const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let t = 0; t < nTri; t++) {
        for (let k = 0; k < 3; k++) {
          const o9 = 9 * t + 3 * k;
          const x = src[o9], y = src[o9 + 1], z = src[o9 + 2];
          T[o9] = m[0] * x + m[4] * y + m[8] * z + tx;
          T[o9 + 1] = m[1] * x + m[5] * y + m[9] * z + ty;
          T[o9 + 2] = m[2] * x + m[6] * y + m[10] * z + tz;
        }
        for (let c = 0; c < 3; c++) {
          const a = T[9 * t + c], b = T[9 * t + 3 + c], d = T[9 * t + 6 + c];
          const lo = Math.min(a, b, d), hi = Math.max(a, b, d);
          tb[6 * t + c] = lo; tb[6 * t + 3 + c] = hi;
          if (lo < box[c]) box[c] = lo; if (hi > box[3 + c]) box[3 + c] = hi;
        }
      }
      e.slow = { T, tb, box };
      e.slowKey = Float64Array.from(m);
    }
    e._mode = 1; e._kk = 1;
    e._T = e.slow.T; e._tb = e.slow.tb; e._nT = e.n;
    e._p0[0] = ax; e._p0[1] = ay; e._p0[2] = az; e._p1[0] = bx; e._p1[1] = by; e._p1[2] = bz;
    const bb = e.slow.box;
    const lo0 = Math.min(ax, bx), hi0 = Math.max(ax, bx), lo1 = Math.min(ay, by), hi1 = Math.max(ay, by), lo2 = Math.min(az, bz), hi2 = Math.max(az, bz);
    const gx = Math.max(bb[0] - hi0, 0, lo0 - bb[3]), gy = Math.max(bb[1] - hi1, 0, lo1 - bb[4]), gz = Math.max(bb[2] - hi2, 0, lo2 - bb[5]);
    e._lb = Math.sqrt(gx * gx + gy * gy + gz * gz);
    return true;
  }

  function entryLive(e) {
    const o = e.mesh;
    if (!e.detail && !o.visible) return false;
    if (materialsHidden(o)) return false;
    for (let i = 0; i < e.chain.length; i++) if (!e.chain[i].visible) return false;
    return true;
  }

  function entryObstacle(e) {
    if (e.kind !== 'dau') return true;
    const a = e.arm;
    if (!a || !AT_STRUT.has(a.state)) return false;
    if (a.state === 'LAUNCHING' && a._springFired) return false;
    return true;
  }

  // ---- the scan over one entry's triangles ----------------------------------
  let _improved = false;
  /** ignoreNear in this entry's frame: skip triangles wholly inside any {p, r}. */
  function triIgnored(T, o, ig, nIg) {
    for (let k = 0; k < nIg; k++) {
      const px = ig[4 * k], py = ig[4 * k + 1], pz = ig[4 * k + 2], r2 = ig[4 * k + 3];
      let inside = true;
      for (let v = 0; v < 3 && inside; v++) {
        const dx = T[o + 3 * v] - px, dy = T[o + 3 * v + 1] - py, dz = T[o + 3 * v + 2] - pz;
        if (dx * dx + dy * dy + dz * dz > r2) inside = false;
      }
      if (inside) return true;
    }
    return false;
  }

  function scan(e, isSeg, b2, ig, nIg) {
    const T = e._T, tb = e._tb, n = e._nT;
    const p0x = e._p0[0], p0y = e._p0[1], p0z = e._p0[2];
    const p1x = e._p1[0], p1y = e._p1[1], p1z = e._p1[2];
    const mnx = Math.min(p0x, p1x), mxx = Math.max(p0x, p1x);
    const mny = Math.min(p0y, p1y), mxy = Math.max(p0y, p1y);
    const mnz = Math.min(p0z, p1z), mxz = Math.max(p0z, p1z);
    _improved = false;
    for (let t = 0; t < n; t++) {
      const o6 = 6 * t;
      const dx = Math.max(tb[o6] - mxx, 0, mnx - tb[o6 + 3]);
      const dy = Math.max(tb[o6 + 1] - mxy, 0, mny - tb[o6 + 4]);
      const dz = Math.max(tb[o6 + 2] - mxz, 0, mnz - tb[o6 + 5]);
      if (dx * dx + dy * dy + dz * dz >= b2) continue;
      if (nIg && triIgnored(T, 9 * t, ig, nIg)) continue;
      const d2 = isSeg ? segTri2(p0x, p0y, p0z, p1x, p1y, p1z, T, 9 * t) : ptTri2(p0x, p0y, p0z, T, 9 * t);
      if (d2 < b2) { b2 = d2; _improved = true; if (b2 === 0) break; }
    }
    return b2;
  }

  /**
   * The ignoreNear balls of a query: `opts.ignoreNear` plus any OBJECT entries of
   * `opts.ignore` (the leash machine passes `{ point, r, names }` there). An entry is
   * `{ p | point, r, names? }`; with `names`, only triangles of meshes whose name
   * starts with one of them are skipped inside the ball.
   */
  function nearList(opts) {
    const a = opts && opts.ignoreNear, b = opts && opts.ignore;
    let objs = null;
    if (b) for (const x of b) if (x && typeof x === 'object') (objs || (objs = [])).push(x);
    if (!objs) return a && a.length ? a : null;
    return a && a.length ? [...a, ...objs] : objs;
  }
  function nameMatches(name, names) {
    for (let i = 0; i < names.length; i++) if (name.startsWith(names[i])) return true;
    return false;
  }

  function igFor(e, near) {
    if (!near || !near.length) { e._ig = null; return 0; }
    if (!e._igBuf || e._igBuf.length < 4 * near.length) e._igBuf = new Float64Array(4 * near.length);
    const buf = e._igBuf;
    let n = 0;
    for (let k = 0; k < near.length; k++) {
      const ent = near[k];
      if (ent.names && ent.names.length && !nameMatches(e.name, ent.names)) continue;
      const p = v3(ent.p || ent.point), r = ent.r;
      if (e._mode === 0) {
        const m = e._lm, dx = p[0] - e._tx, dy = p[1] - e._ty, dz = p[2] - e._tz, l0 = e._l0;
        buf[4 * n] = (m[0] * dx + m[1] * dy + m[2] * dz) / l0;
        buf[4 * n + 1] = (m[4] * dx + m[5] * dy + m[6] * dz) / l0;
        buf[4 * n + 2] = (m[8] * dx + m[9] * dy + m[10] * dz) / l0;
        const rl = r / e._kk; buf[4 * n + 3] = rl * rl;
      } else { buf[4 * n] = p[0]; buf[4 * n + 1] = p[1]; buf[4 * n + 2] = p[2]; buf[4 * n + 3] = r * r; }
      n++;
    }
    e._ig = buf;
    return n;
  }

  function extraSpheres(opts) {
    const out = [];
    const add = (arr) => { if (arr) for (const s of arr) if (s && s.r >= 0) out.push(s); };
    add(opts && opts.spheres);
    if (sphereProvider) add(sphereProvider());
    return out;
  }

  // ---- the query -----------------------------------------------------------
  function run(isSeg, a, b, radius, opts, wantHits) {
    const tq0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    freshen(false);
    SWinv.copy(player.matrixWorld).invert();
    const A = v3(a), B = isSeg ? v3(b) : A;
    const ignore = opts && opts.ignore && opts.ignore.length ? opts.ignore : null;
    const near = nearList(opts);
    const skipped = (name, cat) => {
      if (!ignore) return false;
      for (let i = 0; i < ignore.length; i++) {
        const g = ignore[i];
        if (typeof g === 'string' && (cat === g || name.startsWith(g))) return true;   // objects = ignoreNear balls
      }
      return false;
    };
    const margin = (opts && opts.margin) || 0;
    const thr = radius + margin + 1e-9;                       // hits: anything closer than this
    let bestD = Infinity, bestName = '', bestCat = '';
    const hits = wantHits ? [] : null;

    // extra spheres first (cheap; seeds the nearest distance)
    for (const s of extraSpheres(opts)) {
      const nm = s.name || 'catch', ct = s.cat || 'catch';
      if (skipped(nm, ct)) continue;
      const c = v3(s.c);
      const d = Math.max(0, Math.sqrt(isSeg ? ptSeg2(c[0], c[1], c[2], A[0], A[1], A[2], B[0], B[1], B[2])
        : (c[0] - A[0]) ** 2 + (c[1] - A[1]) ** 2 + (c[2] - A[2]) ** 2) - s.r);
      if (wantHits) { if (d < thr) hits.push({ name: nm, cat: ct, gap: d - radius }); }
      if (d < bestD) { bestD = d; bestName = nm; bestCat = ct; }
    }

    cand.length = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (skipped(e.name, e.cat)) continue;
      if (!entryObstacle(e) || !entryLive(e)) continue;
      if (!setupView(e, A[0], A[1], A[2], B[0], B[1], B[2])) continue;
      cand.push(e);
    }
    if (!wantHits) cand.sort((x, y) => x._lb - y._lb);

    for (let i = 0; i < cand.length; i++) {
      const e = cand[i];
      const limit = wantHits ? thr : bestD;
      if (e._lb >= limit) { if (wantHits) continue; break; }
      const nIg = igFor(e, near);
      const lim2 = limit === Infinity ? Infinity : (limit / e._kk) * (limit / e._kk);
      const b2 = scan(e, isSeg, lim2, e._ig, nIg);
      if (!_improved) continue;
      const d = Math.sqrt(b2) * e._kk;
      if (wantHits) hits.push({ name: e.name, cat: e.cat, gap: d - radius });
      if (d < bestD) { bestD = d; bestName = e.name; bestCat = e.cat; }
    }
    stats.queries++;
    stats.lastQueryMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - tq0;
    const out = { gap: bestD - radius, dist: bestD, name: bestName, cat: bestCat };
    if (wantHits) { hits.sort((x, y) => x.gap - y.gap); out.hits = hits; }
    return out;
  }

  // ---- measuring a body --------------------------------------------------------
  /**
   * Measure the live triangles of category `cat` in the ship frame: bounding-box
   * centre, the farthest vertex across `dir` (a unit vector; half-width of the
   * body when it travels along `dir`) and along it.
   */
  function measureCat(cat, dir) {
    freshen(false);
    SWinv.copy(player.matrixWorld).invert();
    const d = dir ? v3(dir) : [0, 0, 1];
    const dl = Math.hypot(d[0], d[1], d[2]) || 1; d[0] /= dl; d[1] /= dl; d[2] /= dl;
    const pts = [];
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const push = (x, y, z) => {
      pts.push(x, y, z);
      if (x < lo[0]) lo[0] = x; if (x > hi[0]) hi[0] = x;
      if (y < lo[1]) lo[1] = y; if (y > hi[1]) hi[1] = y;
      if (z < lo[2]) lo[2] = z; if (z > hi[2]) hi[2] = z;
    };
    let n = 0;
    for (const e of list) {
      if (e.cat !== cat || !entryLive(e)) continue;
      rel.multiplyMatrices(SWinv, e.mesh.matrixWorld);
      const m = rel.elements, tx = m[12] / Ms, ty = m[13] / Ms, tz = m[14] / Ms;
      const src = e.tris;
      for (let i = 0; i < src.length; i += 3) {
        const x = src[i], y = src[i + 1], z = src[i + 2];
        push(m[0] * x + m[4] * y + m[8] * z + tx, m[1] * x + m[5] * y + m[9] * z + ty, m[2] * x + m[6] * y + m[10] * z + tz);
      }
      n++;
    }
    if (n === 0) return { centre: [0, 0, 0], halfWidth: 0, halfLength: 0, n: 0 };
    const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    let w2 = 0, len = 0;
    for (let i = 0; i < pts.length; i += 3) {
      const rx = pts[i] - c[0], ry = pts[i + 1] - c[1], rz = pts[i + 2] - c[2];
      const along = rx * d[0] + ry * d[1] + rz * d[2];
      const perp2 = rx * rx + ry * ry + rz * rz - along * along;
      if (perp2 > w2) w2 = perp2;
      if (Math.abs(along) > len) len = Math.abs(along);
    }
    return { centre: c, halfWidth: Math.sqrt(w2), halfLength: len, n };
  }

  return {
    /** Exact gap from segment a→b (swept by `radius`) to the nearest obstacle; see the header. */
    segment(a, b, radius = 0, opts = null) { return run(true, a, b, radius, opts, !!(opts && opts.hits)); },
    /** Exact gap from a sphere (centre c, radius r) to the nearest obstacle. */
    sphere(c, r = 0, opts = null) { return run(false, c, c, r, opts, !!(opts && opts.hits)); },
    measureCat,
    /** `fn() → [{ c: [x,y,z] ship metres, r, name?, cat? }]` — extra obstacles every query (held catches). */
    setSphereProvider(fn) { sphereProvider = typeof fn === 'function' ? fn : null; },
    /** Update every matrix and re-collect the scene graph now. */
    refresh() { freshen(true); },
    stats,
    /** Test hook: the live entry list (name, cat, n). */
    _entries() { if (list.length === 0) freshen(true); return list; },
  };
}
