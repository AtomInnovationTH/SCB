/**
 * ArmDockBasis.js — shared docked-daughter orientation basis.
 *
 * Single source of truth for the deterministic "docked arm" local quaternion so
 * that both the mother ([`PlayerSatellite.postArmUpdate`](js/entities/PlayerSatellite.js:1),
 * which orients DOCKED arms) and the daughter ([`ArmUnit`](js/entities/ArmUnit.js:1),
 * which now self-aligns during DOCKING and HOLDING_CATCH) compose the SAME basis.
 *
 * Keeping one implementation avoids the override-fight class of bug documented in
 * HANDOFF.md §10 Rule B — when two owners compose orientation for overlapping
 * states they slerp toward different bases and the visual flickers / points the
 * wrong way (the exact tether-direction bug fixed in this shift).
 *
 * THREE.js convention (HANDOFF.md §9 Rule 2/4): the resulting quaternion maps the
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
