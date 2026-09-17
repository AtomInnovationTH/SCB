/**
 * ArmDockBasis.js — shared docked-daughter orientation basis.
 *
 * Single source of truth for the deterministic "docked arm" local quaternion so
 * that both the mother ([`PlayerSatellite.postArmUpdate`](js/entities/PlayerSatellite.js:1),
 * which orients DOCKED arms) and the daughter ([`ArmUnit`](js/entities/ArmUnit.js:1),
 * which now self-aligns during DOCKING and HOLDING_CATCH) compose the SAME basis.
 *
 * Keeping one implementation avoids the override-fight class of bug documented in
 * CONVENTIONS.md §10 Rule B — when two owners compose orientation for overlapping
 * states they slerp toward different bases and the visual flickers / points the
 * wrong way (the exact tether-direction bug fixed in this shift).
 *
 * THREE.js convention (CONVENTIONS.md §9 Rule 2/4): the resulting quaternion maps the
 * daughter's local +Z (forward) onto `strutDir`. All vectors are in the player-
 * LOCAL frame; compose with the mother's world quaternion at the call site:
 *
 *   composeDockedArmQuat(strutDir, azRad, outLocal);
 *   armGroup.quaternion.copy(motherWorldQuat).multiply(outLocal);
 */
import * as THREE from 'three';

/* Preallocated temps — module-private, single-threaded game loop. */
const _armDir   = new THREE.Vector3();
const _armUp    = new THREE.Vector3();
const _armRight = new THREE.Vector3();
const _armBasis = new THREE.Matrix4();

/**
 * Write a deterministic docked-arm LOCAL quaternion into `outQuat`.
 *
 * Builds an explicit orthonormal basis where the daughter's forward (+Z) is the
 * strut direction and its up (+Y) is the radial-outward direction at the arm's
 * azimuth (projected perpendicular to forward). Because the "up" reference is the
 * same azimuth-radial used to lay out the dock ring, every daughter ends up with
 * the SAME roll convention around the mother — fixing the asymmetric splay that
 * `setFromUnitVectors()` produced (its roll was an arbitrary by-product of the
 * minimal-arc rotation and differed per azimuth).
 *
 * @param {THREE.Vector3} strutDir - unit strut/forward direction (player-local)
 * @param {number} azRad - arm azimuth (radians) used for the radial up reference
 * @param {THREE.Quaternion} outQuat - receives the local orientation
 * @returns {THREE.Quaternion} outQuat (for chaining)
 */
export function composeDockedArmQuat(strutDir, azRad, outQuat) {
  // Forward = strut direction.
  _armDir.copy(strutDir).normalize();

  // Preferred up = radial-outward at this azimuth.
  _armUp.set(Math.cos(azRad), Math.sin(azRad), 0);

  // Degenerate guard: if radial ≈ parallel to forward, fall back to Z then X.
  _armRight.crossVectors(_armUp, _armDir);
  if (_armRight.lengthSq() < 1e-8) {
    _armUp.set(0, 0, 1);
    _armRight.crossVectors(_armUp, _armDir);
    if (_armRight.lengthSq() < 1e-8) _armRight.set(1, 0, 0);
  }
  _armRight.normalize();

  // Re-orthogonalize up so the basis is exactly orthonormal.
  _armUp.crossVectors(_armDir, _armRight).normalize();

  // Columns: X = right, Y = up, Z = forward (so local +Z maps to strutDir).
  _armBasis.makeBasis(_armRight, _armUp, _armDir);
  outQuat.setFromRotationMatrix(_armBasis);
  return outQuat;
}

/**
 * Single source of truth for the player-LOCAL strut/fire direction as a function
 * of strut sweep angle α and collar azimuth. This is the exact convention driven
 * by [`PlayerSatellite._updateStruts`](js/entities/PlayerSatellite.js:1) for the
 * rendered strut pose, so every consumer (the rendered strut, the daughter's
 * launch direction, and the autopilot aim-convergence boresight) stays in lockstep:
 *
 *     d̂_local = ( sinα·cos(az), sinα·sin(az), −cosα )
 *       α=0   → −Z (stowed aft, against the barrel)
 *       α=π/2 → radial-outward (equatorial)
 *       α=π   → +Z (zenith / forward)
 *
 * @param {number} alpha - strut sweep angle (radians)
 * @param {number} azRad - collar azimuth (radians)
 * @param {THREE.Vector3} out - receives the local direction (not normalized; it is unit by construction)
 * @returns {THREE.Vector3} out (for chaining)
 */
export function strutLocalDirection(alpha, azRad, out) {
  const sinA = Math.sin(alpha);
  return out.set(sinA * Math.cos(azRad), sinA * Math.sin(azRad), -Math.cos(alpha));
}

/* Preallocated temp for strutTipFoulsCorridor — module-private. */
const _tipDir = new THREE.Vector3();

/**
 * Does one strut tip intrude into a berth-approach corridor?
 *
 * THE ONE COPY of this test. It had drifted to three near-identical
 * implementations — `CaptureNet._corridorClear` (the authoritative berth gate),
 * `CaptureNet._repPoseCorridorClear` (the representative-pose pre-check) and
 * `ArmManager._strutFoulsInboundCorridor` (the lean-aside duck) — which is
 * exactly the shape that fails silently: if the geometry changes in one, an arm
 * that should duck simply doesn't, the authoritative gate then holds the catch
 * at the corridor standoff until the timeout berths it extended, and nothing
 * reports a fault. Callers supply their own policy (which arms to test, what
 * radius, what to do about it); the geometry lives here.
 *
 * The corridor is a cylinder on the ship-local +Z axis through the berth
 * anchor. A tip counts as fouling only when it is FORE of the muzzle plane
 * (axial z > 0) — a strut swept aft cannot be clipped by an incoming catch —
 * and its radial distance from the axis is inside `radiusM`.
 *
 * All inputs are in the player-LOCAL frame and in METRES, so the test is
 * attitude- and position-free.
 *
 * @param {number} alpha - strut sweep angle (radians)
 * @param {number} azRad - collar azimuth (radians)
 * @param {number} collarR - collar radius (m), the strut pivot's radial offset
 * @param {number} collarY - collar height (m) along ship-local +Z
 * @param {number} strutLen - strut length (m)
 * @param {{x:number,y:number,z:number}} anchor - berth anchor, ship-local metres
 * @param {number} radiusM - corridor radius (m)
 * @returns {boolean} true when this tip intrudes into the corridor
 */
export function strutTipFoulsCorridor(alpha, azRad, collarR, collarY, strutLen, anchor, radiusM) {
  strutLocalDirection(alpha, azRad, _tipDir);
  const tipZ = collarY + _tipDir.z * strutLen - anchor.z;
  if (tipZ <= 0) return false;                     // aft of the muzzle plane
  const tipX = Math.cos(azRad) * collarR + _tipDir.x * strutLen - anchor.x;
  const tipY = Math.sin(azRad) * collarR + _tipDir.y * strutLen - anchor.y;
  return (tipX * tipX + tipY * tipY) < radiusM * radiusM;
}
