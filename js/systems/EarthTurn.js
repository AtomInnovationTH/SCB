/**
 * EarthTurn.js — floor 4 turns to the debris field in focus.
 *
 * The floor-4 camera looks at Earth's centre from a direction `dir` (inertial, held in CameraSystem's ladder
 * state). The focused debris field is usually off to one side (measured 42 degrees off the view axis, so mostly off
 * screen). Putting the camera ON the line from Earth's centre through the field puts the field between the camera and
 * Earth: dead centre of the view. Pure maths, four parts:
 *
 *   - earthTurnTarget(center)  where the camera should be (unit direction from Earth)
 *   - earthTurnDirAt(...)      the path to it: 1 s, round Earth's axis plus a tilt, never over a pole (Earth-north
 *                              stays up)
 *   - earthTurnTrigger(...)    WHEN to turn: each time a ride into floor 4 ends, and each time the focused field
 *                              changes while on floor 4
 *   - earthFrame(...)          WHERE to turn and how far out, so the ship AND the field stay in view (the field wins
 *                              when both cannot)
 *
 * No state, no DOM, imports only `three`. CameraSystem owns the running turn, NavcomFloor gathers the framing
 * inputs, LadderController glides the distance and main.js owns the trigger memory. Plain words for the player:
 * "the camera turns to the debris field you picked, and keeps your ship in view too".
 *
 * @module systems/EarthTurn
 */

import * as THREE from 'three';
import { degToRad, radToDeg, clamp01, clamp, lerp } from '../core/MathUtil.js';

export const EARTH_TURN_S = 1.0;

/**
 * Earth's radius in scene units (1 u = 100 km). Same number as `Constants.EARTH_RADIUS` (63.71); a local copy keeps
 * this module free of imports but `three` (test-EarthTurn pins the two together).
 */
export const EARTH_RADIUS_U = 63.71;

/**
 * Smallest gap between the camera and the field (camera distance minus the field's distance from Earth's centre) at
 * which a turn can still show the field. A field at or above the camera cannot be shown by turning: the ladder has
 * no live zoom-out. 6 u is above floor 4's near clip plane (0.05 u) plus 1 u.
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
 * Where the camera should sit so the field at `center` is in the middle of the view: the unit direction from
 * Earth's centre toward the field, its polar angle from +Y clamped to [0.1, pi - 0.1] (the drag's own gimbal
 * window), its azimuth kept.
 *
 * @param {{x:number,y:number,z:number}|THREE.Vector3|null|undefined} center  scene units, Earth at origin
 * @returns {THREE.Vector3|null} a new unit vector, or null for a missing or non-finite centre, or one inside Earth
 *   (a mean of members spread round the shell: its direction is noise)
 */
export function earthTurnTarget(center) {
  if (!center) return null;
  const x = center.x, y = center.y, z = center.z;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  const r = Math.sqrt(x * x + y * y + z * z);
  if (!(r >= EARTH_RADIUS_U)) return null;
  const phi = Math.min(EARTH_TURN_POLAR_MAX, Math.max(EARTH_TURN_POLAR_MIN, Math.acos(clamp(y / r, -1, 1))));
  const theta = Math.atan2(x, z);
  const s = Math.sin(phi);
  return new THREE.Vector3(s * Math.sin(theta), Math.cos(phi), s * Math.cos(theta));
}

/**
 * The view direction `u` of the way from `start` to `target` (both unit vectors). Blends in spherical coordinates
 * about +Y: the azimuth (atan2(x, z)) goes the SHORT way round (an exact half turn goes +pi), the polar angle moves
 * linearly, so the view spins like a globe and tilts, Earth-north stays up and the polar angle never leaves the
 * range between the two ends (no pole crossing). `u` is clamped to [0, 1] and eased with cubicInOut; u = 0 returns
 * start, u = 1 returns target exactly. When an end is at a pole its azimuth is undefined: it takes the other end's
 * (no spin).
 *
 * @param {number} u  progress 0..1 (not yet eased)
 * @param {function} [ease]  the easing (default cubic in-out; a re-frame passes earthFrameEase)
 * @returns {THREE.Vector3} a new unit vector (the inputs are never mutated)
 */
export function earthTurnDirAt(start, target, u, ease) {
  const res = new THREE.Vector3();
  const uu = Number.isFinite(u) ? clamp01(u) : 0;
  if (uu <= 0) return res.set(start.x, start.y, start.z);
  if (uu >= 1) return res.set(target.x, target.y, target.z);
  const e = (typeof ease === 'function' ? ease : cubicInOut)(uu);

  const phiS = Math.acos(clamp(start.y, -1, 1));
  const phiT = Math.acos(clamp(target.y, -1, 1));
  const sinS = Math.sin(phiS), sinT = Math.sin(phiT);
  const startAtPole = sinS < 1e-6, targetAtPole = sinT < 1e-6;
  let thS = startAtPole ? 0 : Math.atan2(start.x, start.z);
  let thT = targetAtPole ? 0 : Math.atan2(target.x, target.z);
  if (startAtPole && !targetAtPole) thS = thT;
  else if (targetAtPole && !startAtPole) thT = thS;

  let dTh = thT - thS;
  while (dTh > Math.PI) dTh -= 2 * Math.PI;           // short way round; exactly +pi stays +pi
  while (dTh <= -Math.PI) dTh += 2 * Math.PI;         // exactly -pi becomes +pi

  const phi = lerp(phiS, phiT, e);
  const th = thS + dTh * e;
  const s = Math.sin(phi);
  return res.set(s * Math.sin(th), Math.cos(phi), s * Math.cos(th));
}

/**
 * When the floor-4 camera should turn to the focused field. Called once per frame with the current facts and the
 * memory from the last frame; pure.
 *
 *   settled = on floor 4 and not riding
 *   turn    = settled, a field is focused, and either we were not settled last frame (a ride into floor 4 just
 *             ended) or the focused field changed
 *
 * @returns {{turn:boolean, settled:boolean, focusId:(string|number|null)}} `settled` and `focusId` are the memory
 *   for next frame
 */
export function earthTurnTrigger({ floor, riding, focusId, prevSettled, prevFocusId }) {
  const settled = floor === 4 && !riding;
  const id = focusId == null ? null : focusId;
  const prev = prevFocusId == null ? null : prevFocusId;
  const turn = settled && id != null && (!prevSettled || id !== prev);
  return { turn, settled, focusId: id };
}

// Frame the ship AND the focused field (owner pick "Floor 4 easier to read", 2026-10-20). Measured: on floor 4 both
// sweep ~13° per real second round Earth, so a still camera keeps an orbiting object on screen only if it shows the
// whole low-orbit shell they move in. The rule, per re-frame (the same trigger as above): look from the midpoint of
// the ship–field arc; glide out to the distance at which that shell fits a circle round Earth's centre clear of the
// screen edges and the HUD panels (never closer than now, never past the floor's free zone); if the shell cannot fit
// and the two cannot even fit right now, the field wins (look from the field) and the ship shows its edge arrow.

/** Added to the larger of the ship's and the field's distance from Earth's centre (u). */
export const EARTH_FRAME_PAD_U = 0.3;
/**
 * How far above the ship's orbit plane (toward Earth-north) floor 4's default view sits, degrees. Owner, 2026-10-31:
 * "take a look at floor 4, the default camera view should be higher so the blue ring around earth can be noticed as a
 * disc, not just a blue line." The reach band is two Earth-centred circles in the ship's orbit plane, so a view in
 * that plane (measured -0.7° on the day) shows it edge-on. V1.05 used 30°; after seeing it on his Mac the owner said
 * (2026-10-31 ~14:15Z) "too high, where is it 30? try 20 degrees", after 20° on his Mac (~14:49Z) "16 please", and
 * after 16° (~14:53Z) "make it 15 and push". At 15° the ring is an ellipse about a quarter as tall as wide (sin 15° =
 * 0.26, estimate: ignores perspective).
 */
export const EARTH_FRAME_LIFT_DEG = 15;
/** Beyond 174° apart the ship–field bisector is ill-defined; the arc along the ship's travel is used. */
export const EARTH_FRAME_ANTIPODE_COS = Math.cos(degToRad(174));
/**
 * Smoothness: a re-frame's turn is stretched so its fastest moment stays at or under this angular speed (deg/s)
 * where it can (≤ 1.5 s): 2° per frame at 60 fps; target: no frame-to-frame jump over 3°. Measured: the 1 s cubic
 * in-out arrival turn (a ~69° path) peaked near 200°/s, 3.4–3.6° per game frame (cubic in-out peaks at 3x the
 * average speed).
 */
export const EARTH_FRAME_MAX_DEG_S = 120;

/** The share of a re-frame spent speeding up (and again slowing down), see earthFrameEase. */
export const EARTH_FRAME_RAMP = 0.25;

/**
 * A re-frame's easing: speeds up gently over the first quarter (a sine-shaped ramp, so it starts from rest without a
 * kick), cruises, and slows down the same way over the last quarter. It peaks at 1 / (1 − 0.25) = 1.33x the average
 * speed; the cubic in-out peaks at 3x, so the same turn has well under half the fastest frame.
 * @returns {number} 0..1 (monotone; e(0) = 0, e(0.5) = 0.5, e(1) = 1)
 */
export function earthFrameEase(u) {
  const a = EARTH_FRAME_RAMP, v = 1 / (1 - a);
  const uu = clamp01(u);
  const ramp = (x) => v * (x / 2 - (a / (2 * Math.PI)) * Math.sin((Math.PI * x) / a));
  if (uu <= a) return ramp(uu);
  if (uu >= 1 - a) return 1 - ramp(1 - uu);
  return v * (a / 2 + (uu - a));
}

/** The longest a re-frame may take (s; each re-frame eased, ≤ 1.5 s). */
export const EARTH_FRAME_TURN_MAX_S = 1.5;

/**
 * How long (s) the re-frame's turn from `start` to `target` takes: EARTH_TURN_S, stretched up to
 * EARTH_FRAME_TURN_MAX_S when the path eased by earthFrameEase (earthTurnDirAt, sampled at 240 steps) would pass
 * EARTH_FRAME_MAX_DEG_S at its fastest. Pure.
 * @param {{x,y,z}} start   unit vector
 * @param {{x,y,z}} target  unit vector
 * @returns {number} seconds in [EARTH_TURN_S, EARTH_FRAME_TURN_MAX_S]
 */
export function earthFrameTurnS(start, target) {
  const N = 240;
  let prev = earthTurnDirAt(start, target, 0, earthFrameEase), peak = 0;   // fastest angle per unit of progress (rad)
  for (let k = 1; k <= N; k++) {
    const d = earthTurnDirAt(start, target, k / N, earthFrameEase);
    const a = prev.angleTo(d) * N;
    if (a > peak) peak = a;
    prev = d;
  }
  const need = (radToDeg(peak)) / EARTH_FRAME_MAX_DEG_S;
  return Math.min(EARTH_FRAME_TURN_MAX_S, Math.max(EARTH_TURN_S, Number.isFinite(need) ? need : EARTH_TURN_S));
}

const _len = (v) => (v ? Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) : NaN);

/** The lift steps tried in order (deg): the first whose view shows both the ship and the field, 0 = the plain midpoint. */
const LIFT_STEPS_DEG = [EARTH_FRAME_LIFT_DEG, 10, 0];
/** A direction this close to her plane (|m . n| <= this) counts as in the plane: it has no side of its own. */
const IN_PLANE_EPS = 1e-3;
/** An orbit normal this level (|n . north| < this) is near-polar: "the north side" is no longer a stable choice. */
const NEAR_POLAR_N_Y = 0.1;

/**
 * Is `p` hidden behind Earth for a camera at `cam`? Exact: the segment camera -> p passes through the sphere of
 * EARTH_RADIUS_U (the radius earthShellDistance and the polar window are built on). Earth at the origin.
 * @param {{x,y,z}} cam
 * @param {{x,y,z}} p
 * @returns {boolean}
 */
export function earthHides(cam, p) {
  const dx = p.x - cam.x, dy = p.y - cam.y, dz = p.z - cam.z;
  const dd = dx * dx + dy * dy + dz * dz;
  if (!(dd > 0)) return false;
  const t = clamp01(-(cam.x * dx + cam.y * dy + cam.z * dz) / dd);
  const qx = cam.x + dx * t, qy = cam.y + dy * t, qz = cam.z + dz * t;
  return qx * qx + qy * qy + qz * qz < EARTH_RADIUS_U * EARTH_RADIUS_U;
}

/**
 * Put a view direction exactly `liftDeg` above the ship's orbit plane: dir = normalize(flat cos L + n sin L), flat = dir
 * projected into the plane, n = the unit plane normal (pos x vel) on the side `dir` already sits on (sign of dir . n),
 * so the lift never carries the view across the plane to the far side from the field. A direction in the plane
 * (|dir . n| <= IN_PLANE_EPS) takes the north side (n . +Y >= 0). For a near-polar orbit (|n . +Y| < NEAR_POLAR_N_Y) the
 * north side is rounding noise, so the in-plane tie-break there is the sign of n . +Z (then n . +X when that is ~0): a
 * fixed horizontal axis, so 89.9, 90 and 90.1 deg inclinations give the same side. No velocity (missing, non-finite,
 * or along the radius), or a direction along the normal: `dir` unchanged.
 * @param {THREE.Vector3} dir  unit vector (not mutated)
 * @param {{x,y,z}} ship  scene units, Earth at origin
 * @param {{x,y,z}} [shipVel]  any units (direction only)
 * @param {number} [liftDeg]  default EARTH_FRAME_LIFT_DEG
 * @returns {THREE.Vector3} a new unit vector
 */
export function earthLiftDir(dir, ship, shipVel, liftDeg = EARTH_FRAME_LIFT_DEG) {
  const out = new THREE.Vector3(dir.x, dir.y, dir.z);
  const ls = _len(ship);
  if (!(liftDeg > 0) || !(ls > 0) || !Number.isFinite(ls) || !shipVel || !Number.isFinite(_len(shipVel))) return out;
  const n = new THREE.Vector3(ship.x, ship.y, ship.z).cross(new THREE.Vector3(shipVel.x, shipVel.y, shipVel.z));
  if (!(n.length() > 1e-9 * ls * _len(shipVel))) return out;
  n.normalize();
  const side = n.dot(out);
  if (Math.abs(side) > IN_PLANE_EPS) {
    if (side < 0) n.negate();                                 // the side the view already sits on
  } else if (Math.abs(n.y) >= NEAR_POLAR_N_Y) {
    if (n.y < 0) n.negate();                                  // the north side
  } else {
    const k = Math.abs(n.z) > 1e-6 ? n.z : n.x;               // near-polar: a fixed horizontal axis, not noise
    if (k < 0) n.negate();
  }
  // The view's own direction made level with the plane first (a field off her plane would otherwise leave the lift
  // short or long of the angle), then tilted up by exactly L: the elevation above the plane is L.
  const flat = out.clone().sub(n.clone().multiplyScalar(n.dot(out)));
  if (flat.lengthSq() < 1e-12) return out;                    // looking along the normal: nothing to lift
  const L = degToRad(liftDeg);
  return flat.normalize().multiplyScalar(Math.cos(L)).add(n.multiplyScalar(Math.sin(L))).normalize();
}

/**
 * The lifted view for the unit direction `m`: the largest of LIFT_STEPS_DEG (15, 10, 0) whose camera, at `distU`
 * from Earth's centre, sees every point of `pts` (none behind Earth: earthHides). Polar angle clamped to the drag
 * window (earthTurnTarget), and the check runs on the clamped direction. With no usable `distU` the full lift is used
 * unchecked.
 * @returns {THREE.Vector3|null}
 */
function _liftedView(m, ship, shipVel, pts, distU) {
  const check = Number.isFinite(distU) && distU > 0;
  let d = null;
  for (const L of LIFT_STEPS_DEG) {
    d = earthTurnTarget(earthLiftDir(m, ship, shipVel, L).multiplyScalar(2 * EARTH_RADIUS_U));
    if (!d || !check) return d;
    const cam = { x: d.x * distU, y: d.y * distU, z: d.z * distU };
    if (!pts.some((p) => earthHides(cam, p))) return d;
  }
  return d;
}

/** The unit direction the framing starts from, before any lift (see earthPairDir). Null when ship or field is unusable. */
function _pairMid(ship, field, shipVel) {
  const ls = _len(ship), lf = _len(field);
  if (!(ls > 0) || !(lf > 0) || !Number.isFinite(ls) || !Number.isFinite(lf)) return null;
  const s = new THREE.Vector3(ship.x / ls, ship.y / ls, ship.z / ls);
  const f = new THREE.Vector3(field.x / lf, field.y / lf, field.z / lf);
  const dot = s.dot(f);
  let m;
  if (dot >= EARTH_FRAME_ANTIPODE_COS) {
    m = s.clone().add(f);
    if (m.lengthSq() < 1e-18) m = f.clone();
  } else {
    const v = shipVel && Number.isFinite(_len(shipVel)) ? new THREE.Vector3(shipVel.x, shipVel.y, shipVel.z) : null;
    const w = v ? v.sub(s.clone().multiplyScalar(v.dot(s))) : null;   // the travel direction, tangent at the ship
    if (!w || w.lengthSq() < 1e-18) {
      m = f.clone();                                                 // no travel direction: the field wins
    } else {
      w.normalize();
      const half = Math.acos(clamp(dot, -1, 1)) / 2;
      m = s.clone().multiplyScalar(Math.cos(half)).add(w.multiplyScalar(Math.sin(half)));
    }
  }
  return m.normalize();
}

/**
 * Where floor 4's camera looks from to frame the ship and the field: the midpoint of the shorter arc between them as
 * seen from Earth's centre; for a pair more than 174° apart, the midpoint of the arc that leaves the ship along its
 * velocity; then lifted up to EARTH_FRAME_LIFT_DEG above the ship's orbit plane when `shipVel` is known (earthLiftDir),
 * on the field's side of the plane, in steps of 30/20/10/0° until neither the ship nor the field is behind Earth for a
 * camera `distU` out (skipped when `distU` is omitted). Polar angle clamped to the drag window (as earthTurnTarget).
 * @param {{x,y,z}} ship   scene units, Earth at origin
 * @param {{x,y,z}} [shipVel] any units (direction only)
 * @param {number} [distU]  the camera distance the view will have (u from Earth's centre); farther only helps
 * @returns {THREE.Vector3|null} a new unit vector, or null when ship or field is unusable
 */
export function earthPairDir(ship, field, shipVel, distU) {
  const m = _pairMid(ship, field, shipVel);
  return m ? _liftedView(m, ship, shipVel, [ship, field], distU) : null;
}

/**
 * The radius (px) of the largest circle round Earth's centre on screen whose every point keeps a marker's footprint
 * inside the viewport and off every panel. A marker's name block faces Earth's centre (ClusterIcons.labelSide), so
 * the footprint is `inner` px on the side toward the centre and `outer` px on the side away from it, `up` above and
 * `down` below; each panel is inflated by it (Minkowski) and the viewport shrunk by it. A panel that a marker on the
 * near side of the centre line (within `flip` px, the label's hysteresis) could reach with its name block is
 * inflated by `inner` on both sides.
 * @returns {number} >= 0
 */
export function earthSafeRadiusPx({ centerPx, viewW, viewH, rects = [], foot }) {
  const cx = centerPx.x, cy = centerPx.y;
  const i = foot.inner, o = foot.outer, flip = foot.flip || 0;
  let rho = Math.min(cx - o, viewW - o - cx, cy - foot.up, viewH - foot.down - cy);
  for (const r of rects || []) {
    if (!r || !(r.w > 0) || !(r.h > 0)) continue;
    let L = i, R = i;                                    // the marker box's extents left / right of its point
    if (r.x >= cx + flip + i) { L = i; R = o; }          // right of centre: only left-facing labels reach it
    else if (r.x + r.w <= cx - flip - i) { L = o; R = i; }
    const x0 = r.x - R, x1 = r.x + r.w + L;
    const y0 = r.y - foot.down, y1 = r.y + r.h + foot.up;
    const dx = Math.max(x0 - cx, 0, cx - x1), dy = Math.max(y0 - cy, 0, cy - y1);
    rho = Math.min(rho, Math.hypot(dx, dy));
  }
  return Math.max(0, rho);
}

/**
 * The camera distance at which a sphere of radius `rmax` round Earth's centre (everything orbiting at or below it)
 * projects inside a circle of `rhoPx`: the sphere's outline is asin(rmax/d) off the axis and lands f_px·tan of that
 * from the centre, f_px = (H/2) / tan(fov/2). Infinity when rho is 0.
 */
export function earthShellDistance({ rmax, fovDeg, viewH, rhoPx }) {
  const fpx = (viewH / 2) / Math.tan((fovDeg * Math.PI) / 360);
  const beta = Math.atan(rhoPx / fpx);
  return beta > 0 ? rmax / Math.sin(beta) : Infinity;
}

/**
 * Do these points, seen from `dir`·`distU` looking at Earth's centre (Earth-north up), all land with their footprint
 * inside the viewport and off every panel? Screen positions are taken round `centerPx` (where Earth's centre lands).
 */
export function earthPointsFit({ points, dir, distU, fovDeg, viewW, viewH, centerPx, rects = [], foot }) {
  const z = new THREE.Vector3(dir.x, dir.y, dir.z).normalize();
  const x = new THREE.Vector3(0, 1, 0).cross(z);
  if (x.lengthSq() < 1e-12) return false;
  x.normalize();
  const y = z.clone().cross(x);
  const fpx = (viewH / 2) / Math.tan((fovDeg * Math.PI) / 360);
  for (const p of points) {
    const rx = p.x - z.x * distU, ry = p.y - z.y * distU, rz = p.z - z.z * distU;
    const depth = -(rx * z.x + ry * z.y + rz * z.z);
    if (!(depth > 0)) return false;
    const px = centerPx.x + ((rx * x.x + ry * x.y + rz * x.z) / depth) * fpx;
    const py = centerPx.y - ((rx * y.x + ry * y.y + rz * y.z) / depth) * fpx;
    const L = px > centerPx.x ? foot.inner : foot.outer;   // the name block faces Earth's centre
    const R = px > centerPx.x ? foot.outer : foot.inner;
    if (px - L < 0 || px + R > viewW || py - foot.up < 0 || py + foot.down > viewH) return false;
    for (const r of rects || []) {
      if (!r || !(r.w > 0) || !(r.h > 0)) continue;
      if (px > r.x - R && px < r.x + r.w + L && py > r.y - foot.down && py < r.y + r.h + foot.up) return false;
    }
  }
  return true;
}

/**
 * The floor-4 framing for one re-frame.
 *   mode 'both'  : look from the ship–field midpoint; distance = the shell distance (capped at maxDistU), or
 *                  maxDistU when the shell does not fit but the two fit there right now
 *   mode 'field' : the field wins — look from the field, at maxDistU; the ship shows its edge arrow whenever it is
 *                  off screen
 * LadderController.frameZoomTo never zooms in, so `distU` is an "at least" target.
 */
export function earthFrame({ ship, field, shipVel, fovDeg, viewW, viewH, centerPx, rects = [], foot, maxDistU }) {
  const ls = _len(ship), lf = _len(field);
  if (!(ls > 0) || !(lf > 0) || !Number.isFinite(ls) || !Number.isFinite(lf)) return null;
  if (!(viewW > 0) || !(viewH > 0) || !(fovDeg > 0) || !(maxDistU > 0) || !centerPx || !foot) return null;
  const rmax = Math.max(ls, lf) + EARTH_FRAME_PAD_U;
  const rhoPx = earthSafeRadiusPx({ centerPx, viewW, viewH, rects, foot });
  const dShell = earthShellDistance({ rmax, fovDeg, viewH, rhoPx });
  const m = _pairMid(ship, field, shipVel);
  const mid = m && _liftedView(m, ship, shipVel, [ship, field], Math.min(dShell, maxDistU));
  if (mid && dShell <= maxDistU) return { mode: 'both', dir: mid, distU: dShell, dShell, rhoPx };
  const fitAt = (dir) => earthPointsFit({ points: [ship, field], dir, distU: maxDistU, fovDeg, viewW, viewH, centerPx, rects, foot });
  if (mid && fitAt(mid)) return { mode: 'both', dir: mid, distU: maxDistU, dShell, rhoPx };
  const flatMid = m && earthTurnTarget({ x: m.x * 2 * EARTH_RADIUS_U, y: m.y * 2 * EARTH_RADIUS_U, z: m.z * 2 * EARTH_RADIUS_U });
  if (flatMid && fitAt(flatMid)) return { mode: 'both', dir: flatMid, distU: maxDistU, dShell, rhoPx };   // the lift does not fit: the plain midpoint
  const fd = _liftedView(new THREE.Vector3(field.x / lf, field.y / lf, field.z / lf), ship, shipVel, [field], maxDistU);   // the ship may be off screen here (its edge arrow): only the field must be seen
  return fd ? { mode: 'field', dir: fd, distU: maxDistU, dShell, rhoPx } : null;
}
