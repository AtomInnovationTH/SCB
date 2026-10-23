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
 * She turns with her strut like a rigid body on a hinge (owner 2026-10-23, roll-90): forward (+Z) is the strut
 * direction, and her side axis (+X) is the strut's HINGE axis, Z × radial = (−sin az, cos az, 0), the line the strut
 * swings about. That axis is the same at every sweep angle, so the roll never jumps. Her up (+Y) is forward × side.
 * For a strut swept less than 90° up is the radial-outward direction at the arm's azimuth (projected perpendicular to
 * forward), the roll the dock ring was laid out with, so every daughter still shares one roll convention around the
 * mother (the asymmetric splay `setFromUnitVectors()` produced came from a roll that differed per azimuth).
 *
 * The earlier basis took up = radial and side = radial × forward = −cosα·(radial × Z). That flips sign at α = 90° (the
 * radial lies along the strut there), so the daughter and her catch rolled 180° in one frame as the strut swept
 * through the equator (measured: 0.5° per 0.5° step, then 180.00° at exactly 90°). Past 90° she was rolled 180°
 * from the hinged pose; she now stays on it.
 *
 * @param {THREE.Vector3} strutDir - unit strut/forward direction (player-local)
 * @param {number} azRad - arm azimuth (radians): sets the hinge axis
 * @param {THREE.Quaternion} outQuat - receives the local orientation
 * @returns {THREE.Quaternion} outQuat (for chaining)
 */
export function composeDockedArmQuat(strutDir, azRad, outQuat) {
  // Forward = strut direction.
  _armDir.copy(strutDir).normalize();

  // Side = the strut's hinge axis Z × radial. A strut lies in the swing plane, so it is already perpendicular to
  // forward; the projection only guards an input that is not a strut direction.
  _armRight.set(-Math.sin(azRad), Math.cos(azRad), 0);
  _armRight.addScaledVector(_armDir, -_armRight.dot(_armDir));
  if (_armRight.lengthSq() < 1e-8) {
    // forward ∥ hinge axis (not reachable by a strut) or a zero-length input: fall back to Z, then X.
    _armUp.set(0, 0, 1);
    _armRight.crossVectors(_armUp, _armDir);
    if (_armRight.lengthSq() < 1e-8) _armRight.set(1, 0, 0);
  }
  _armRight.normalize();

  // Up = forward × side, so the basis is exactly orthonormal (right × up = forward).
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

/**
 * The strut sweep angle whose axis points closest to a wanted direction (launch-aim lane).
 *
 * u(α) = sinα·(cos az, sin az, 0) + cosα·(0, 0, −1) is the strut axis, so the angle to a wanted
 * direction `dir` is smallest where dir·u(α) = t_out·sinα + t_aft·cosα is largest, with
 * t_out = dir·(cos az, sin az, 0) and t_aft = −dir.z. Over α ∈ [0, π]:
 *   t_out >= 0 → the unconstrained maximum atan2(t_out, t_aft) is already in range;
 *   t_out <  0 → the maximum is an end point: 0 when t_aft >= 0, else π.
 * (A signed atan2 clamped to [0, π] is wrong for t_out < 0: a target nearly dead ahead gave about −178° and the clamp made it 0°,
 * strut aft. AutopilotSystem's two aim paths used that form until d-launch-ahead (2026-10-20) and now call this. CameraSystem's
 * `|sinA|` form is also wrong for t_out < 0, but runs only when LAUNCH_AIMS_STRUT is off.)
 *
 * @param {{x:number,y:number,z:number}} dirShip - wanted direction, player-LOCAL frame (need not be unit)
 * @param {number} azRad - the arm's collar azimuth (radians): atan2(dockOffset.y, dockOffset.x)
 * @returns {number} α in [0, π]
 */
export function bestStrutAlpha(dirShip, azRad) {
  // `+ 0` turns −0 into +0, so a direction exactly along +z gives atan2(+0, −1) = π, not −π.
  const tOut = dirShip.x * Math.cos(azRad) + dirShip.y * Math.sin(azRad) + 0;
  const tAft = -dirShip.z;
  if (tOut >= 0) return Math.atan2(tOut, tAft);
  return tAft >= 0 ? 0 : Math.PI;
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

// ── petal-single: the carry's attitude family ───────────────────────────────────────────────────────────────────────
// Carried in her docked attitude, her body ended 0.04-0.15 m from the receiving radiator's cone / boom / plate whatever the
// pose (exhaustive search, 7 x 4300+ strut/petal pairs, none clear 0.15 m). So she TURNS on the way: while she seats the
// catch her body trails away from the radiator along one of a few directions fixed in the tip's own frame. The generator
// (js/test/_carryGate.js) and the carry (ArmUnit) both build the final attitude with these three functions, so they cannot drift.

/** Number of trailing directions (index k in the gate table's `dir`). */
export const CARRY_DIR_COUNT = 5;
// in the tip's hinge frame (TipCargo.hingeQuatShipInto): +X the boom, outward from the ship; Y the hinge axis; Z the in-plane perpendicular
const CARRY_DIR_AXES = [[1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]];
const _cdQ = new THREE.Quaternion();
const _cdR = new THREE.Quaternion();

/**
 * Direction k of the carry's attitude family in the ship frame.
 * @param {{x:number,y:number,z:number,w:number}} hingeQuat turn from the tip's hinge frame to the ship frame
 * @param {number} k 0 = along the boom outward, 1/2 = along +-Z, 3/4 = along +-Y
 * @param {THREE.Vector3} out unit vector (ship frame)
 */
export function carryDirInto(hingeQuat, k, out) {
  const a = CARRY_DIR_AXES[k];
  _cdQ.set(hingeQuat.x, hingeQuat.y, hingeQuat.z, hingeQuat.w);
  return out.set(a[0], a[1], a[2]).applyQuaternion(_cdQ);
}

/**
 * Her attitude at the seat: the shortest turn that takes the direction from the catch's centre to her centre (`u0`, unit,
 * ship frame, in her DOCKED attitude `q0`) onto `dir`. out = R * q0.
 * @returns {THREE.Quaternion} out
 */
export function carryFinalQuatInto(q0, u0, dir, out) {
  _cdR.setFromUnitVectors(u0, dir);
  return out.copy(_cdR).multiply(q0);
}

/**
 * How far through the turn she is at fraction `t` (0..1, of the straight line her centre flies): nothing while she leaves
 * her strut (the first `ownFreeM` metres of `lengthM`, where the gate does not count her own strut), then a linear turn
 * that is over at 55 % of the line (later on a very short line), so the last stretch is a plain approach.
 * @returns {{a:number, b:number}} the fractions of the line at which the turn starts and ends (`carryRotFrac` is its value)
 */
/** The turn is over at this fraction of the line (later on a short line), and lasts at least this much of it. Part of what the gate certifies. */
export const CARRY_TURN_END = 0.55;
export const CARRY_TURN_MIN_SPAN = 0.1;
export function carryRotSpan(lengthM, ownFreeM) {
  const a = lengthM > 0 ? Math.min(0.95, ownFreeM / lengthM) : 0;
  return { a, b: Math.min(1, Math.max(CARRY_TURN_END, a + CARRY_TURN_MIN_SPAN)) };
}
export function carryRotFrac(t, lengthM, ownFreeM) {
  const { a, b } = carryRotSpan(lengthM, ownFreeM);
  if (t <= a) return 0;
  if (t >= b) return 1;
  return (t - a) / (b - a);
}
