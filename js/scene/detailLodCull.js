/**
 * detailLodCull.js — Shared distance-hysteresis switch for inert detail meshes.
 *
 * Both the Mother (PlayerSatellite) and daughters (ArmUnit) hide their mm-scale
 * inert hardware when the camera is far. The hysteresis state machine is
 * identical for both, so it lives here (single SSOT) — each craft keeps only its
 * own `_detailMeshes` set + `_detailHidden` flag and calls `applyDetailLod`.
 *
 * @module scene/detailLodCull
 */

import { Constants } from '../core/Constants.js';

const M = 1e-5; // 1 metre in scene units

/**
 * Apply the LOD cull for one craft. Flips `visible` on every mesh in `meshes`
 * ONLY when a hysteresis threshold is crossed (state change), so steady-state
 * frames do no work and it never fights systems that own `visible` elsewhere.
 *
 * @param {number} distSceneUnits camera→craft distance (scene units)
 * @param {THREE.Object3D[]} meshes the craft's inert-detail set
 * @param {boolean} wasHidden the craft's current `_detailHidden` flag
 * @returns {boolean} the new hidden state (assign back to `_detailHidden`)
 */
export function applyDetailLod(distSceneUnits, meshes, wasHidden) {
  const dc = Constants.DETAIL_CULL;
  let hidden = wasHidden;
  if (!hidden && distSceneUnits > dc.HIDE_M * M) hidden = true;
  else if (hidden && distSceneUnits < dc.SHOW_M * M) hidden = false;
  if (hidden === wasHidden) return wasHidden;      // no crossing → no work
  const vis = !hidden;
  for (let i = 0; i < meshes.length; i++) meshes[i].visible = vis;
  return hidden;
}
