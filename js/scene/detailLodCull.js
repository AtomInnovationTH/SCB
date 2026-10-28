/**
 * Shared distance-hysteresis switch for inert detail meshes (Mother and daughters).
 *
 * @module scene/detailLodCull
 */

import { Constants } from '../core/Constants.js';

const M = 1e-5; // 1 metre in scene units

/**
 * Flips `visible` on `meshes` ONLY when a hysteresis threshold is crossed, so
 * steady-state frames do no work and it never fights systems that own `visible`.
 *
 * @param {number} distSceneUnits camera→craft distance (scene units)
 * @param {boolean} wasHidden the craft's current `_detailHidden` flag
 * @returns {boolean} the new hidden state (assign back to `_detailHidden`)
 */
export function applyDetailLod(distSceneUnits, meshes, wasHidden) {
  const dc = Constants.DETAIL_CULL;
  let hidden = wasHidden;
  if (!hidden && distSceneUnits > dc.HIDE_M * M) hidden = true;
  else if (hidden && distSceneUnits < dc.SHOW_M * M) hidden = false;
  if (hidden === wasHidden) return wasHidden;
  const vis = !hidden;
  for (let i = 0; i < meshes.length; i++) meshes[i].visible = vis;
  return hidden;
}
