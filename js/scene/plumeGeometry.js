/**
 * plumeGeometry.js — shared diverging ion-plume frustum builder (FEEP/Hall/gridded
 * exhaust: faint, steady, narrow at the nozzle, widening downstream). A
 * `CylinderGeometry` frustum translated so the NEAR (nozzle) end sits at the local
 * origin, so scaling `.scale.y` grows the beam AFT with its root on the exit
 * plane. Per-vertex RGBA fades the far end to alpha 0 (three r184 vertex alpha
 * needs `transparent:true`); `material.opacity` multiplies the whole beam. Shared
 * by Mother (PlayerSatellite FEEP) and daughters (ArmUnit).
 *
 * @module scene/plumeGeometry
 */

import * as THREE from 'three';

/**
 * @param {number} rNear  radius at the nozzle exit (scene units)
 * @param {number} rFar   radius at the downstream end (scene units)
 * @param {number} len    beam length (scene units)
 * @returns {THREE.CylinderGeometry}  with a `color` (itemSize 4) alpha-fade attribute
 */
export function makePlumeFrustum(rNear, rFar, len, radial = 12, rings = 4) {
  // top = far, bottom = near; axis is local +Y
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
