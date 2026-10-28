/**
 * plumeRibbon.js — the launch plume's tapered, camera-facing ribbon trail: a
 * triangle strip, 2 verts per sample, ONE draw call.
 *
 * Why not Line2/LineMaterial (NetMeshKit.js): `linewidth` there is PER-MATERIAL,
 * so a taper needs one material per band; a strip carries width in geometry.
 *
 * Per-vertex RGBA (`itemSize 4`) fades the tail (same idiom as plumeGeometry.js;
 * three r184 supports vertex alpha with `transparent:true`). Additive,
 * `depthWrite:false`, `depthTest:true`, `frustumCulled:false` (the ribbon spans
 * most of the frame; bounds culling would pop it).
 *
 * renderOrder: the cloud shell is alpha-blended with `depthWrite:false`
 * (Earth.js) and DARKENS an additive plume drawn before it, so the ribbon is in
 * the SPACECRAFT_ADDITIVE band (after Earth/clouds).
 *
 * `halfWidthKm` and `ribbonAlpha` are pure and exported for Node tests.
 *
 * @module scene/plumeRibbon
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { DEG2RAD, RAD2DEG, clamp01 } from '../core/MathUtil.js';

/** Ribbon sample count (verts = 2× this). */
export const RIBBON_SAMPLES = 48;

/**
 * Half-width of the ribbon in km at a sample's altitude: 2 km at the pad
 * widening to 18 km at apogee (120 km) as the plume disperses; capped at 20 km.
 * @param {number} altKm — sample altitude (km)
 * @param {number} apogeeKm — cameo apogee (km), normalises the curve
 */
export function halfWidthKm(altKm, apogeeKm) {
  const u = clamp01(altKm / apogeeKm);
  return 2 + 16 * Math.pow(u, 1.4);   // 2 km → 18 km
}

/**
 * Per-sample alpha ramp: bright head, fading tail.
 * @param {number} s — position along the trail ∈ [0,1] (0 = pad, 1 = head)
 * @returns {number} alpha ∈ [0,1] (before the per-frame master opacity)
 */
export function ribbonAlpha(s) {
  return Math.pow(clamp01(s), 1.5);
}

/** Minimum projected half-width (px): below ~0.75 the thin low trail aliases and shimmers. updateRibbon clamps world half-width to stay ≥ this. */
export const MIN_HALF_WIDTH_PX = 0.75;

const _p = new THREE.Vector3();
const _pNext = new THREE.Vector3();
const _pPrev = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _toCam = new THREE.Vector3();
const _side = new THREE.Vector3();
const _camWorld = new THREE.Vector3();

/** Build the ribbon mesh; geometry is allocated once and rewritten per frame by updateRibbon(). */
export function makePlumeRibbon() {
  const n = RIBBON_SAMPLES;
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(n * 2 * 3);
  const colors = new Float32Array(n * 2 * 4);
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 4));

  // strip index: (0,1,2)(2,1,3)(2,3,4)…
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
 * @param {object} opts
 * @param {function} opts.pointAt — (t, out) → {x,y,z,alt}; the ascent path (local frame)
 * @param {number} opts.tHead — head progress ∈ [0,1]
 * @param {number} opts.apogeeKm — cameo apogee (km)
 * @param {THREE.Object3D} opts.parent — Earth group (localToWorld for the camera axis)
 * @param {number} opts.pxPerDeg — viewport scale (px per degree)
 * @param {number} opts.opacity — master opacity (multiplies every vertex alpha)
 * @param {THREE.Color} opts.color — base ribbon colour
 */
export function updateRibbon(mesh, opts) {
  const { pointAt, tHead, apogeeKm, parent, camera, pxPerDeg, opacity, color } = opts;
  const n = RIBBON_SAMPLES;
  const posAttr = mesh.geometry.attributes.position;
  const colAttr = mesh.geometry.attributes.color;
  const pos = posAttr.array, col = colAttr.array;

  camera.getWorldPosition(_camWorld);

  // Each sample's ascent point is computed ONCE and carried forward (n pointAt
  // calls, not 2n). The tangent uses the NEXT sample, except at the head
  // (i = n-1) where it uses the PREVIOUS: next === current would be degenerate.
  pointAt(0, _p);
  for (let i = 0; i < n; i++) {
    const s = i / (n - 1);                   // 0 = pad, 1 = head
    if (i < n - 1) {
      pointAt(tHead * ((i + 1) / (n - 1)), _pNext);
      _tangent.subVectors(_pNext, _p);
    } else {
      _tangent.subVectors(_p, _pPrev);       // head: real flight direction
    }
    if (_tangent.lengthSq() < 1e-12) _tangent.set(0, 1, 0);   // degenerate → up
    _tangent.normalize();

    // side = normalize(tangent × toCam); if tangent ∥ view the cross degenerates →
    // fall back to radial × tangent. _p is LOCAL-frame; convert to world for the camera vector.
    _toCam.copy(_p);
    parent.localToWorld(_toCam);
    const distKm = _toCam.distanceTo(_camWorld) * 100;
    _toCam.subVectors(_camWorld, _toCam).normalize();
    _side.crossVectors(_tangent, _toCam);
    if (_side.lengthSq() < 1e-6) {
      _side.set(_p.x, _p.y, _p.z).normalize().cross(_tangent);
      if (_side.lengthSq() < 1e-6) _side.set(1, 0, 0);
    }
    _side.normalize();

    // anti-shimmer px floor
    let halfKm = halfWidthKm(_p.alt * 100, apogeeKm);
    const pxHalf = (halfKm / distKm) * RAD2DEG * pxPerDeg;
    if (pxHalf < MIN_HALF_WIDTH_PX) {
      halfKm = (MIN_HALF_WIDTH_PX / pxPerDeg) * DEG2RAD * distKm;
    }
    const halfU = halfKm / 100;   // km → scene units

    const a = ribbonAlpha(s) * opacity;
    const vi = i * 2;
    pos[vi * 3]     = _p.x + _side.x * halfU;
    pos[vi * 3 + 1] = _p.y + _side.y * halfU;
    pos[vi * 3 + 2] = _p.z + _side.z * halfU;
    pos[vi * 3 + 3] = _p.x - _side.x * halfU;
    pos[vi * 3 + 4] = _p.y - _side.y * halfU;
    pos[vi * 3 + 5] = _p.z - _side.z * halfU;
    for (let k = 0; k < 2; k++) {
      const ci = (vi + k) * 4;
      col[ci]     = color.r * a;
      col[ci + 1] = color.g * a;
      col[ci + 2] = color.b * a;
      col[ci + 3] = a;
    }

    _pPrev.copy(_p);                         // carry forward: current → previous
    if (i < n - 1) _p.copy(_pNext);          // …and next → current (no recompute)
  }
  posAttr.needsUpdate = true;
  colAttr.needsUpdate = true;
  // Alpha is baked per-vertex; keep master opacity at 1 so _end()'s opacity=0
  // (which hides the mesh) doesn't stick.
  mesh.material.opacity = 1;
}
