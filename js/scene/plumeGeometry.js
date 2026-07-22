/**
 * plumeGeometry.js — Shared diverging ion-plume frustum builder.
 *
 * Field-emission / ion exhaust (FEEP, Hall, gridded) is a faint, steady,
 * DIVERGING beam — narrow at the nozzle exit, widening downstream — the opposite
 * of a converging chemical-flame cone. This builds a `CylinderGeometry` frustum
 * (narrow near-end → wide far-end), translated so the NEAR (nozzle) end sits at
 * the local origin, so scaling `.scale.y` at runtime grows the beam AFT while its
 * root stays welded to the exit plane. A 4-component per-vertex colour fades the
 * far end to alpha 0 (three r184 supports vertex alpha on MeshBasicMaterial with
 * `transparent:true`); `material.opacity` then multiplies the whole beam.
 *
 * Shared by the Mother (PlayerSatellite FEEP) and daughters (ArmUnit) so the
 * beam shape/fade stay consistent.
 *
 * @module scene/plumeGeometry
 */

import * as THREE from 'three';

/**
 * @param {number} rNear  radius at the nozzle exit (scene units)
 * @param {number} rFar   radius at the downstream end (scene units)
 * @param {number} len    beam length (scene units)
 * @param {number} [radial=12]
 * @param {number} [rings=4]
 * @returns {THREE.CylinderGeometry}  with a `color` (itemSize 4) alpha-fade attribute
 */
export function makePlumeFrustum(rNear, rFar, len, radial = 12, rings = 4) {
  // top = far (rFar), bottom = near (rNear); axis is local +Y.
  const geo = new THREE.CylinderGeometry(rFar, rNear, len, radial, rings, true);
  geo.translate(0, len / 2, 0);   // near end (bottom) → local origin
  const pos = geo.attributes.position;
  const n = pos.count;
  const colors = new Float32Array(n * 4);
  for (let v = 0; v < n; v++) {
    const normY = Math.min(1, Math.max(0, pos.getY(v) / len)); // 0 near → 1 far
    const a = Math.pow(1 - normY, 1.3);                        // fade to 0 aft
    colors[v * 4] = 1; colors[v * 4 + 1] = 1; colors[v * 4 + 2] = 1; colors[v * 4 + 3] = a;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  return geo;
}
