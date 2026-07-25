/**
 * AimDecomposition.js — Two-axis aim decomposition utility (ST-9.3 C-3).
 *
 * Given a target direction in SHIP-LOCAL space, decomposes it into:
 *   1. Which antipodal arm pair best aligns (meridian plane closest to target)
 *   2. What Mother rotation is needed to put the target in that pair's meridian plane
 *   3. What strut α angle within the meridian plane intercepts the target
 *
 * FRAME CONVENTION (aim-before-launch plan): the daughter ring is arranged
 * around the Mother's barrel/pole = ship-local **+Z**, azimuth measured in the
 * x–y plane. This matches the SSOT strut geometry in
 * [`PlayerSatellite._updateStruts`](js/entities/PlayerSatellite.js:5427):
 *
 *     strutDir_local = ( sinα·cos(az), sinα·sin(az), −cosα )
 *       α=0   → −Z (stowed aft, against the barrel)
 *       α=π/2 → radial-outward (equatorial)
 *       α=π   → +Z (zenith / forward)
 *
 * The meridian plane for azimuth θ is spanned by radial(θ)=(cosθ,sinθ,0) and
 * the Z axis; its normal is the collar tangent (−sinθ, cosθ, 0).
 *
 * Pure math utility — no THREE.js dependency (uses raw {x,y,z} objects).
 *
 * NOTE (aim-before-launch): this is a standalone, unit-tested helper — it is NOT
 * on the live aim path. The runtime aim sequence in
 * [`AutopilotSystem._tickAimCoroutine`](js/systems/AutopilotSystem.js:1) drives
 * attitude by minimal-arc quaternion slerp and derives α inline; the firing arm
 * (hence its azimuth) is chosen upstream in
 * [`ArmManager._deployWithCeremony`](js/entities/ArmManager.js:1). This util is
 * kept for pair-ranking / tooling and to document + test the shared Z-pole
 * convention (see `ArmDockBasis.strutLocalDirection`). Editing it does not change
 * live firing behavior.
 *
 * @module systems/AimDecomposition
 */

import { Constants } from '../core/Constants.js';

/**
 * Decompose a unit target direction (SHIP-LOCAL frame) into aim components,
 * returning ranked antipodal pairs (best meridian-plane fit first).
 *
 * @param {object} targetDir — unit vector {x, y, z} in SHIP-LOCAL frame
 * @param {Array<{azimuthDeg: number}>} dockPositions — dock geometry from ArmManager
 * @returns {{
 *   pairIndex: number,
 *   partnerIndex: number|null,
 *   motherRotationRad: number,
 *   strutAlpha: number,
 *   rankedPairs: Array<{ pairIndex:number, partnerIndex:number, azimuthDeg:number,
 *                        motherRotationRad:number, strutAlpha:number, outOfPlaneAbs:number }>
 * }}
 */
export function decomposeAimTarget(targetDir, dockPositions) {
  const fallback = {
    pairIndex: 0, partnerIndex: null,
    motherRotationRad: 0, strutAlpha: Math.PI / 2, rankedPairs: [],
  };
  if (!dockPositions || dockPositions.length === 0) return fallback;

  // Build unique antipodal pairs (each processed once).
  const pairs = [];
  const seen = new Set();
  for (let i = 0; i < dockPositions.length; i++) {
    if (seen.has(i)) continue;
    const azDeg = dockPositions[i].azimuthDeg;
    const antiAzDeg = (azDeg + 180) % 360;
    let partnerIdx = -1;
    for (let j = i + 1; j < dockPositions.length; j++) {
      if (Math.abs(dockPositions[j].azimuthDeg - antiAzDeg) < 0.1) { partnerIdx = j; break; }
    }
    if (partnerIdx >= 0) {
      seen.add(i);
      seen.add(partnerIdx);
      pairs.push({ arm1: i, arm2: partnerIdx, azimuthDeg: azDeg });
    }
  }
  if (pairs.length === 0) return fallback;

  const tx = targetDir.x, ty = targetDir.y, tz = targetDir.z;

  const ranked = [];
  for (let p = 0; p < pairs.length; p++) {
    const theta = pairs[p].azimuthDeg * Math.PI / 180;
    const cosT = Math.cos(theta), sinT = Math.sin(theta);

    // Meridian-plane normal = collar tangent (−sinθ, cosθ, 0).
    const outOfPlane = -tx * sinT + ty * cosT;

    // In-plane components (Z-pole convention):
    //   radialComp = t · radial(θ) = sinα
    //   d.z = −cosα, and d.z ≈ t.z when in-plane → cosα = −t.z
    const radialComp = tx * cosT + ty * sinT;
    let alpha = Math.atan2(radialComp, -tz);
    alpha = Math.max(0, Math.min(Math.PI, alpha));

    // Rotation to null the out-of-plane component (small-angle asin).
    const motherRot = Math.asin(Math.min(1, Math.max(-1, outOfPlane)));

    ranked.push({
      pairIndex: pairs[p].arm1,
      partnerIndex: pairs[p].arm2,
      azimuthDeg: pairs[p].azimuthDeg,
      motherRotationRad: motherRot,
      strutAlpha: alpha,
      outOfPlaneAbs: Math.abs(outOfPlane),
    });
  }

  ranked.sort((a, b) => a.outOfPlaneAbs - b.outOfPlaneAbs);
  const best = ranked[0];
  return {
    pairIndex: best.pairIndex,
    partnerIndex: best.partnerIndex,
    motherRotationRad: best.motherRotationRad,
    strutAlpha: best.strutAlpha,
    rankedPairs: ranked,
  };
}

