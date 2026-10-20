/**
 * EarthTurn.js — floor 4 turns to the debris field in focus (lane u8-f4-frame-field).
 *
 * The floor-4 camera looks at Earth's centre from a direction `dir` (inertial, held in
 * CameraSystem's ladder state). The debris field in focus is usually off to one side
 * (measured 42 degrees off the view axis, so mostly off screen). Putting the camera ON
 * the line from Earth's centre through the field puts the field between the camera and
 * Earth: dead centre of the view. This module is the pure maths for that, three parts:
 *
 *   - earthTurnTarget(center)  where the camera should be (unit direction from Earth)
 *   - earthTurnDirAt(...)      the path to it: 1 s, round Earth's axis plus a tilt,
 *                              never over a pole (Earth-north stays up)
 *   - earthTurnTrigger(...)    WHEN to turn: each time a ride into floor 4 ends, and
 *                              each time the focused field changes while on floor 4
 *
 * No state, no DOM, imports only `three`. CameraSystem owns the running turn and
 * main.js owns the trigger memory. Plain words for the player: "the camera turns to the
 * debris field you picked".
 *
 * @module systems/EarthTurn
 */

import * as THREE from 'three';

/** Length of the turn, seconds. */
export const EARTH_TURN_S = 1.0;

/**
 * Earth's radius in scene units (1 u = 100 km). The same number as `Constants.EARTH_RADIUS`
 * (63.71); a local copy keeps this module free of imports but `three` (test-EarthTurn pins
 * the two together).
 */
export const EARTH_RADIUS_U = 63.71;

/**
 * Smallest gap between the camera and the field (camera distance minus the field's
 * distance from Earth's centre) at which a turn can still show the field. A field at or
 * above the camera cannot be shown by turning: the ladder has no live zoom-out. 6 u is
 * above floor 4's near clip plane (0.05 u) plus 1 u.
 */
export const EARTH_TURN_MIN_GAP_U = 6;

/** The polar window, as the floor-4 drag clamps it: [0.1, pi - 0.1] rad from Earth-north. */
export const EARTH_TURN_POLAR_MIN = 0.1;
export const EARTH_TURN_POLAR_MAX = Math.PI - 0.1;

/** Cubic in-out; identical to CameraSystem's private `cubicInOut` (the pane bias and the rides use it). */
function cubicInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Where the camera should sit so the field at `center` is in the middle of the view:
 * the unit direction from Earth's centre toward the field, its polar angle from +Y
 * clamped to [0.1, pi - 0.1] (the drag's own gimbal window), its azimuth kept.
 *
 * @param {{x:number,y:number,z:number}|THREE.Vector3|null|undefined} center  a plain
 *   object or a Vector3 (cluster.center is a plain object), scene units, Earth at origin
 * @returns {THREE.Vector3|null} a new unit vector, or null for a missing or non-finite
 *   centre, or one inside Earth (a mean of members spread round the shell: its direction
 *   is noise)
 */
export function earthTurnTarget(center) {
  if (!center) return null;
  const x = center.x, y = center.y, z = center.z;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  const r = Math.sqrt(x * x + y * y + z * z);
  if (!(r >= EARTH_RADIUS_U)) return null;
  const phi = Math.min(EARTH_TURN_POLAR_MAX, Math.max(EARTH_TURN_POLAR_MIN, Math.acos(Math.max(-1, Math.min(1, y / r)))));
  const theta = Math.atan2(x, z);
  const s = Math.sin(phi);
  return new THREE.Vector3(s * Math.sin(theta), Math.cos(phi), s * Math.cos(theta));
}

/**
 * The view direction `u` of the way from `start` to `target` (both unit vectors).
 * Blends in spherical coordinates about +Y: the azimuth (atan2(x, z)) goes the SHORT way
 * round (an exact half turn goes +pi), the polar angle moves linearly, so the view spins
 * like a globe and tilts, Earth-north stays up and the polar angle never leaves the range
 * between the two ends (no pole crossing). `u` is clamped to [0, 1] and eased with
 * cubicInOut; u = 0 returns start, u = 1 returns target exactly. When an end is at a pole
 * its azimuth is undefined: it takes the other end's (no spin).
 *
 * @param {{x:number,y:number,z:number}} start
 * @param {{x:number,y:number,z:number}} target
 * @param {number} u  progress 0..1 (not yet eased)
 * @returns {THREE.Vector3} a new unit vector (the inputs are never mutated)
 */
export function earthTurnDirAt(start, target, u) {
  const res = new THREE.Vector3();
  const uu = Number.isFinite(u) ? Math.min(1, Math.max(0, u)) : 0;
  if (uu <= 0) return res.set(start.x, start.y, start.z);
  if (uu >= 1) return res.set(target.x, target.y, target.z);
  const e = cubicInOut(uu);

  const phiS = Math.acos(Math.max(-1, Math.min(1, start.y)));
  const phiT = Math.acos(Math.max(-1, Math.min(1, target.y)));
  const sinS = Math.sin(phiS), sinT = Math.sin(phiT);
  const startAtPole = sinS < 1e-6, targetAtPole = sinT < 1e-6;
  let thS = startAtPole ? 0 : Math.atan2(start.x, start.z);
  let thT = targetAtPole ? 0 : Math.atan2(target.x, target.z);
  if (startAtPole && !targetAtPole) thS = thT;
  else if (targetAtPole && !startAtPole) thT = thS;

  let dTh = thT - thS;
  while (dTh > Math.PI) dTh -= 2 * Math.PI;           // short way round; exactly +pi stays +pi
  while (dTh <= -Math.PI) dTh += 2 * Math.PI;         // exactly -pi becomes +pi

  const phi = phiS + (phiT - phiS) * e;
  const th = thS + dTh * e;
  const s = Math.sin(phi);
  return res.set(s * Math.sin(th), Math.cos(phi), s * Math.cos(th));
}

/**
 * When the floor-4 camera should turn to the focused field. Called once per frame with the
 * current facts and the memory from the last frame; pure.
 *
 *   settled = on floor 4 and not riding
 *   turn    = settled, a field is focused, and either we were not settled last frame
 *             (a ride into floor 4 just ended) or the focused field changed
 *
 * @param {{floor:(number|null), riding:boolean, focusId:(string|number|null|undefined),
 *          prevSettled:boolean, prevFocusId:(string|number|null|undefined)}} s
 * @returns {{turn:boolean, settled:boolean, focusId:(string|number|null)}} `settled` and `focusId` are the memory for next frame
 */
export function earthTurnTrigger({ floor, riding, focusId, prevSettled, prevFocusId }) {
  const settled = floor === 4 && !riding;
  const id = focusId == null ? null : focusId;
  const prev = prevFocusId == null ? null : prevFocusId;
  const turn = settled && id != null && (!prevSettled || id !== prev);
  return { turn, settled, focusId: id };
}
