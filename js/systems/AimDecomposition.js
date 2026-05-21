/**
 * AimDecomposition.js — Two-axis aim decomposition utility (ST-9.3 C-3).
 *
 * Given a target direction in world space, decomposes it into:
 *   1. Which antipodal arm pair best aligns
 *   2. What Mother rotation is needed to put the target in that pair's meridian plane
 *   3. What strut α angle within the meridian plane intercepts the target
 *
 * Pure math utility — no THREE.js dependency (uses raw {x,y,z} objects).
 * See ARM_PIVOT_GAPS_EXPLAINER.md §V-5 for design rationale.
 *
 * @module systems/AimDecomposition
 */

import { Constants } from '../core/Constants.js';

/**
 * Decompose a unit target direction into (pairIndex, motherRotation, strutAlpha).
 *
 * Algorithm:
 *   1. For each arm pair's meridian plane (defined by azimuth θ):
 *      - The meridian plane normal = swingAxis = (-sin θ, 0, cos θ)
 *      - Project target onto the meridian plane
 *      - The out-of-plane component magnitude = |target · normal|
 *      - The in-plane projection gives the required α via atan2
 *   2. Pick the pair with the smallest out-of-plane angle (least Mother rotation).
 *   3. The Mother rotation = angle to rotate the chosen plane to contain the target.
 *
 * @param {object} targetDir — unit vector {x, y, z} in world frame
 * @param {Array<{azimuthDeg: number}>} dockPositions — dock position geometry from ArmManager
 * @returns {{ pairIndex: number, motherRotationRad: number, strutAlpha: number }}
 */
export function decomposeAimTarget(targetDir, dockPositions) {
  if (!dockPositions || dockPositions.length === 0) {
    return { pairIndex: 0, motherRotationRad: 0, strutAlpha: Math.PI / 2 };
  }

  // Build unique pair azimuths: for each arm, check if (az + 180) % 360 exists
  // and only process each pair once.
  const pairs = [];
  const seen = new Set();

  for (let i = 0; i < dockPositions.length; i++) {
    if (seen.has(i)) continue;
    const azDeg = dockPositions[i].azimuthDeg;
    const antiAzDeg = (azDeg + 180) % 360;
    let partnerIdx = -1;
    for (let j = i + 1; j < dockPositions.length; j++) {
      if (Math.abs(dockPositions[j].azimuthDeg - antiAzDeg) < 0.1) {
        partnerIdx = j;
        break;
      }
    }
    if (partnerIdx >= 0) {
      seen.add(i);
      seen.add(partnerIdx);
      pairs.push({ arm1: i, arm2: partnerIdx, azimuthDeg: azDeg });
    }
  }

  if (pairs.length === 0) {
    return { pairIndex: 0, motherRotationRad: 0, strutAlpha: Math.PI / 2 };
  }

  const tx = targetDir.x;
  const ty = targetDir.y;
  const tz = targetDir.z;

  let bestPairIdx = 0;
  let bestOutOfPlane = Infinity;
  let bestAlpha = Math.PI / 2;
  let bestMotherRot = 0;

  for (let p = 0; p < pairs.length; p++) {
    const thetaDeg = pairs[p].azimuthDeg;
    const theta = thetaDeg * Math.PI / 180;

    // Meridian plane dockOutward direction
    const ox = Math.cos(theta);
    const oz = Math.sin(theta);

    // Swing axis (plane normal) = tangent to collar = (-sin θ, 0, cos θ)
    const nx = -Math.sin(theta);
    const nz = Math.cos(theta);

    // Out-of-plane component — dot(target, normal)
    const outOfPlane = tx * nx + tz * nz; // ty * 0 = 0

    // In-plane projection
    // The meridian plane is spanned by:
    //   dockOutward = (cos θ, 0, sin θ)
    //   ŷ = (0, 1, 0)
    // Fire direction at angle α: d̂ = sin(α)·outward − cos(α)·ŷ
    // So: target_inplane · outward = sin(α), target_inplane · (−ŷ) = cos(α)
    const inPlaneOutward = tx * ox + tz * oz;  // dot(target, outward)
    const inPlaneMinusY = -ty;                  // dot(target, -ŷ)

    // α = atan2(sin(α), cos(α)) = atan2(inPlaneOutward, inPlaneMinusY)
    let alpha = Math.atan2(inPlaneOutward, inPlaneMinusY);
    // Clamp to [0, π]
    alpha = Math.max(0, Math.min(Math.PI, alpha));

    const absOutOfPlane = Math.abs(outOfPlane);
    if (absOutOfPlane < bestOutOfPlane) {
      bestOutOfPlane = absOutOfPlane;
      bestPairIdx = p;
      bestAlpha = alpha;
      // Mother rotation = asin of out-of-plane component (small angle ≈ outOfPlane)
      bestMotherRot = Math.asin(Math.min(1, Math.max(-1, outOfPlane)));
    }
  }

  return {
    pairIndex: pairs[bestPairIdx].arm1,
    motherRotationRad: bestMotherRot,
    strutAlpha: bestAlpha,
  };
}
