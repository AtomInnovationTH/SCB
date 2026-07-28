/**
 * plumeRibbon.js — the launch plume's tapered, camera-facing ribbon trail.
 *
 * Task 7 of the launch-plume plan. Replaces the 1 px `THREE.Line` trail with a
 * soft, tapered RIBBON that reads as an exhaust plume rather than a wire. A
 * camera-facing triangle strip: 2 verts per sample, ~48 samples, ONE draw call.
 *
 * Why not Line2/LineMaterial (NetMeshKit.js): `linewidth` there is PER-MATERIAL,
 * so a taper would need one material per band. A triangle strip carries its
 * width in geometry — one material, one draw call, arbitrary per-sample taper.
 *
 * Per-vertex RGBA (`itemSize 4`) fades the tail — the same idiom as
 * plumeGeometry.js (three r184 supports vertex alpha with `transparent:true`).
 * Additive, `depthWrite:false`, `depthTest:true`, `frustumCulled:false` (the
 * ribbon spans most of the frame; frustum culling it by bounds would pop it).
 *
 * The width/alpha curves (`halfWidthKm`, `ribbonAlpha`) are PURE and exported
 * for Node tests; all THREE lives in the builder/updater.
 *
 * renderOrder: the cloud shell is alpha-blended with `depthWrite:false`
 * (Earth.js) and will DARKEN an additive plume drawn before it. The ribbon is
 * therefore drawn in the SPACECRAFT_ADDITIVE band (after Earth/clouds). Day-side
 * cloud darkening is a pixel-checkable acceptance item, not Node-checkable.
 *
 * @module scene/plumeRibbon
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';

/** Ribbon sample count (verts = 2× this). ~48 keeps the taper smooth at 970 px. */
export const RIBBON_SAMPLES = 48;

/**
 * Half-width of the ribbon in km at a given sample's altitude (Task 7). Garnish,
 * not a centerpiece: 2 km at the pad widening to 18 km at apogee (120 km) — the
 * plume disperses as it climbs into thinner air. Capped at 20 km (the plan's
 * 30–60 km was cut as too much for a decoration). Pure and Node-testable.
 * @param {number} altKm — sample altitude (km)
 * @param {number} apogeeKm — cameo apogee (km), normalises the curve
 * @returns {number} half-width (km)
 */
export function halfWidthKm(altKm, apogeeKm) {
  const u = Math.max(0, Math.min(1, altKm / apogeeKm));
  return 2 + 16 * Math.pow(u, 1.4);   // 2 km → 18 km
}

/**
 * Per-sample alpha ramp (Task 7). Bright at the head, fading down the tail so
 * the ribbon reads as a dissipating exhaust, not a solid rod. Pure/Node-testable.
 * @param {number} s — sample position along the trail ∈ [0,1] (0 = pad, 1 = head)
 * @returns {number} alpha ∈ [0,1] (before the per-frame master opacity)
 */
export function ribbonAlpha(s) {
  return Math.pow(Math.max(0, Math.min(1, s)), 1.5);
}

/**
 * Minimum projected half-width in px (anti-shimmer, Task 7). Below ~0.75 px the
 * thin low trail aliases on the pixel grid and shimmers as the camera moves.
 * The updater clamps the world half-width so its projection stays ≥ this.
 */
export const MIN_HALF_WIDTH_PX = 0.75;

// Module scratch (no per-frame allocation in the hot loop).
const _p = new THREE.Vector3();
const _pNext = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _toCam = new THREE.Vector3();
const _side = new THREE.Vector3();
const _camWorld = new THREE.Vector3();
const _centreWorld = new THREE.Vector3();

/**
 * Build the ribbon mesh. Geometry is allocated once and rewritten per frame by
 * updateRibbon(). Per-vertex RGBA (itemSize 4) carries the tail fade.
 * @returns {THREE.Mesh}
 */
export function makePlumeRibbon() {
  const n = RIBBON_SAMPLES;
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(n * 2 * 3);
  const colors = new Float32Array(n * 2 * 4);
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 4));

  // Triangle-strip index: (0,1,2)(2,1,3)(2,3,4)… across the 2-vert samples.
  const index = [];
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
    index.push(a, b, c, c, b, d);
  }
  geo.setIndex(index);

  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,   // camera-facing strip can edge-on flip
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;
  mesh.name = 'PlumeRibbon';
  return mesh;
}

/**
 * Rewrite the ribbon to follow the ascent path, camera-facing, tapered.
 * @param {THREE.Mesh} mesh — from makePlumeRibbon()
 * @param {object} opts
 * @param {function} opts.pointAt — (t, out) → {x,y,z,alt}; the ascent path (local frame)
 * @param {number} opts.tHead — head progress ∈ [0,1]
 * @param {number} opts.apogeeKm — cameo apogee (km)
 * @param {THREE.Object3D} opts.parent — Earth group (localToWorld for the camera axis)
 * @param {THREE.Camera} opts.camera — for the camera-facing axis + px clamp
 * @param {number} opts.pxPerDeg — viewport scale (px per degree)
 * @param {number} opts.opacity — master opacity (multiplies every vertex alpha)
 * @param {THREE.Color} opts.color — base ribbon colour (cool-white/cyan)
 */
export function updateRibbon(mesh, opts) {
  const { pointAt, tHead, apogeeKm, parent, camera, pxPerDeg, opacity, color } = opts;
  const n = RIBBON_SAMPLES;
  const posAttr = mesh.geometry.attributes.position;
  const colAttr = mesh.geometry.attributes.color;
  const pos = posAttr.array, col = colAttr.array;

  camera.getWorldPosition(_camWorld);
  parent.getWorldPosition(_centreWorld);

  for (let i = 0; i < n; i++) {
    const s = i / (n - 1);                 // 0 = pad, 1 = head
    const t = tHead * s;
    pointAt(t, _p);
    // Tangent from the next sample (fallback: previous at the head).
    const tN = tHead * Math.min(1, (i + 1) / (n - 1));
    pointAt(tN, _pNext);
    _tangent.set(_pNext.x - _p.x, _pNext.y - _p.y, _pNext.z - _p.z);
    if (_tangent.lengthSq() < 1e-12) _tangent.set(0, 1, 0);   // degenerate → up
    _tangent.normalize();

    // Camera-facing side axis: side = normalize(tangent × toCam). If tangent is
    // near-parallel to the view direction the cross degenerates → fall back to
    // the surface-normal × tangent (the ribbon lies flat against the sky).
    // (_p is the LOCAL-frame point; convert to world for the camera vector.)
    _toCam.copy(_p);
    parent.localToWorld(_toCam);
    const distKm = _toCam.distanceTo(_camWorld) * 100;
    _toCam.subVectors(_camWorld, _toCam).normalize();
    _side.crossVectors(_tangent, _toCam);
    if (_side.lengthSq() < 1e-6) {
      // tangent ∥ viewDir: use the local radial (up) as the stable axis.
      _side.set(_p.x, _p.y, _p.z).normalize().cross(_tangent);
      if (_side.lengthSq() < 1e-6) _side.set(1, 0, 0);
    }
    _side.normalize();

    // Half-width in scene units, with the anti-shimmer px floor (Task 7).
    let halfKm = halfWidthKm(_p.alt * 100, apogeeKm);
    const pxHalf = (halfKm / distKm) * (180 / Math.PI) * pxPerDeg;
    if (pxHalf < MIN_HALF_WIDTH_PX) {
      halfKm = (MIN_HALF_WIDTH_PX / pxPerDeg) * (Math.PI / 180) * distKm;
    }
    const halfU = halfKm / 100;   // km → scene units

    const a = ribbonAlpha(s) * opacity;
    const vi = i * 2;
    // left vert
    pos[vi * 3]     = _p.x + _side.x * halfU;
    pos[vi * 3 + 1] = _p.y + _side.y * halfU;
    pos[vi * 3 + 2] = _p.z + _side.z * halfU;
    // right vert
    pos[vi * 3 + 3] = _p.x - _side.x * halfU;
    pos[vi * 3 + 4] = _p.y - _side.y * halfU;
    pos[vi * 3 + 5] = _p.z - _side.z * halfU;
    // RGBA both verts (cool-white → cyan carried by `color`)
    for (let k = 0; k < 2; k++) {
      const ci = (vi + k) * 4;
      col[ci]     = color.r * a;
      col[ci + 1] = color.g * a;
      col[ci + 2] = color.b * a;
      col[ci + 3] = a;
    }
  }
  posAttr.needsUpdate = true;
  colAttr.needsUpdate = true;
  // Alpha is baked per-vertex (itemSize 4); keep the master opacity at 1 so a
  // previous _end()'s opacity=0 doesn't stick. material.opacity multiplies the
  // vertex alpha (transparent:true), so _end() can hide the mesh with opacity=0.
  mesh.material.opacity = 1;
}
