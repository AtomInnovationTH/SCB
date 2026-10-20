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
 *   - earthFrame(...)          u10: WHERE to turn and how far out, so the ship AND the
 *                              field stay in view (the field wins when both cannot)
 *
 * No state, no DOM, imports only `three`. CameraSystem owns the running turn, NavcomFloor
 * gathers the framing inputs, LadderController glides the distance and main.js owns the
 * trigger memory. Plain words for the player: "the camera turns to the debris field you
 * picked, and keeps your ship in view too".
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
 * @param {function} [ease]  u10: the easing (default cubic in-out, u8's turn; a re-frame passes earthFrameEase)
 * @returns {THREE.Vector3} a new unit vector (the inputs are never mutated)
 */
export function earthTurnDirAt(start, target, u, ease) {
  const res = new THREE.Vector3();
  const uu = Number.isFinite(u) ? Math.min(1, Math.max(0, u)) : 0;
  if (uu <= 0) return res.set(start.x, start.y, start.z);
  if (uu >= 1) return res.set(target.x, target.y, target.z);
  const e = (typeof ease === 'function' ? ease : cubicInOut)(uu);   // u10: a re-frame passes earthFrameEase

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

// ───────────────────────────────────────────────────────────────────────────────
// u10 D3 (owner pick "Floor 4 easier to read", 2026-10-20): frame the ship AND the
// focused field. Measured 2026-10-20 (tmp/u10/data/p1-*.json): on floor 4 both sweep
// ~13° per real second round Earth, so a still camera keeps an orbiting object on
// screen only if it shows the whole low-orbit shell they move in. The rule, per
// re-frame (the same trigger as above): look from the midpoint of the ship–field arc;
// glide out to the distance at which that shell fits a circle round Earth's centre
// clear of the screen edges and the HUD panels (never closer than now, never past the
// floor's free zone); if the shell cannot fit and the two cannot even fit right now,
// the field wins (look from the field) and the ship shows its edge arrow.
// ───────────────────────────────────────────────────────────────────────────────

/** u10 D3: added to the larger of the ship's and the field's distance from Earth's centre (u). */
export const EARTH_FRAME_PAD_U = 0.3;
/** u10 D3: beyond 174° apart the ship–field bisector is ill-defined; the arc along the ship's travel is used. */
export const EARTH_FRAME_ANTIPODE_COS = Math.cos(174 * Math.PI / 180);
/**
 * u10 D3 smoothness: a re-frame's turn is stretched so its fastest moment stays at or under this
 * angular speed (deg/s) where it can (≤ 1.5 s): 2° per frame at 60 fps. Plan target: no
 * frame-to-frame jump over 3°. Measured 2026-10-20 (tmp/u10/data/t6-*.json): u8's 1 s
 * cubic in-out arrival turn (a ~69° path) peaked near 200°/s, 3.4–3.6° per game frame, on base and
 * branch alike (cubic in-out peaks at 3x the average speed).
 */
export const EARTH_FRAME_MAX_DEG_S = 120;

/** u10 D3: the share of a re-frame spent speeding up (and again slowing down) — earthFrameEase. */
export const EARTH_FRAME_RAMP = 0.25;

/**
 * u10 D3: a re-frame's easing — speeds up gently over the first quarter (a sine-shaped ramp, so
 * it starts from rest without a kick), cruises, and slows down the same way over the last
 * quarter. It peaks at 1 / (1 − 0.25) = 1.33x the average speed; u8's cubic in-out peaks at 3x,
 * so the same turn has well under half the fastest frame.
 * @param {number} u 0..1
 * @returns {number} 0..1 (monotone; e(0) = 0, e(0.5) = 0.5, e(1) = 1)
 */
export function earthFrameEase(u) {
  const a = EARTH_FRAME_RAMP, v = 1 / (1 - a);
  const uu = Math.min(1, Math.max(0, u));
  const ramp = (x) => v * (x / 2 - (a / (2 * Math.PI)) * Math.sin((Math.PI * x) / a));
  if (uu <= a) return ramp(uu);
  if (uu >= 1 - a) return 1 - ramp(1 - uu);
  return v * (a / 2 + (uu - a));
}

/** u10 D3: the longest a re-frame may take (s; plan: each re-frame eased, ≤ 1.5 s). */
export const EARTH_FRAME_TURN_MAX_S = 1.5;

/**
 * u10 D3: how long (s) the re-frame's turn from `start` to `target` takes — EARTH_TURN_S,
 * stretched up to EARTH_FRAME_TURN_MAX_S when the path eased by earthFrameEase (earthTurnDirAt,
 * sampled at 240 steps) would pass EARTH_FRAME_MAX_DEG_S at its fastest. Pure.
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
  const need = (peak * 180 / Math.PI) / EARTH_FRAME_MAX_DEG_S;
  return Math.min(EARTH_FRAME_TURN_MAX_S, Math.max(EARTH_TURN_S, Number.isFinite(need) ? need : EARTH_TURN_S));
}

const _len = (v) => (v ? Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) : NaN);

/**
 * u10 D3: where floor 4's camera looks from to frame the ship and the field — the
 * midpoint of the shorter arc between them as seen from Earth's centre; for a pair
 * more than 174° apart, the midpoint of the arc that leaves the ship along its
 * velocity. Polar angle clamped to the drag window (as earthTurnTarget).
 * @param {{x,y,z}} ship   scene units, Earth at origin
 * @param {{x,y,z}} field
 * @param {{x,y,z}} [shipVel] any units (direction only)
 * @returns {THREE.Vector3|null} a new unit vector, or null when ship or field is unusable
 */
export function earthPairDir(ship, field, shipVel) {
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
      const half = Math.acos(Math.max(-1, Math.min(1, dot))) / 2;
      m = s.clone().multiplyScalar(Math.cos(half)).add(w.multiplyScalar(Math.sin(half)));
    }
  }
  m.normalize().multiplyScalar(2 * EARTH_RADIUS_U);
  return earthTurnTarget(m);
}

/**
 * u10 D3: the radius (px) of the largest circle round Earth's centre on screen whose
 * every point keeps a marker's footprint inside the viewport and off every panel. A
 * marker's name block faces Earth's centre (ClusterIcons.labelSide), so the footprint is
 * `inner` px on the side toward the centre and `outer` px on the side away from it, `up`
 * above and `down` below; each panel is inflated by it (Minkowski) and the viewport shrunk
 * by it. A panel that a marker on the near side of the centre line (within `flip` px, the
 * label's hysteresis) could reach with its name block is inflated by `inner` on both sides.
 * @param {{centerPx:{x:number,y:number}, viewW:number, viewH:number,
 *          rects?:Array<{x:number,y:number,w:number,h:number}>,
 *          foot:{inner:number,outer:number,up:number,down:number,flip?:number}}} a
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
 * u10 D3: the camera distance at which a sphere of radius `rmax` round Earth's centre
 * (everything orbiting at or below it) projects inside a circle of `rhoPx`: the sphere's
 * outline is asin(rmax/d) off the axis and lands f_px·tan of that from the centre,
 * f_px = (H/2) / tan(fov/2). Infinity when rho is 0.
 * @param {{rmax:number, fovDeg:number, viewH:number, rhoPx:number}} a
 * @returns {number}
 */
export function earthShellDistance({ rmax, fovDeg, viewH, rhoPx }) {
  const fpx = (viewH / 2) / Math.tan((fovDeg * Math.PI) / 360);
  const beta = Math.atan(rhoPx / fpx);
  return beta > 0 ? rmax / Math.sin(beta) : Infinity;
}

/**
 * u10 D3: do these points, seen from `dir`·`distU` looking at Earth's centre (Earth-north
 * up), all land with their footprint inside the viewport and off every panel? Screen
 * positions are taken round `centerPx` (where Earth's centre lands).
 * @returns {boolean}
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
 * u10 D3: the floor-4 framing for one re-frame.
 *   mode 'both'  : look from the ship–field midpoint; distance = the shell distance
 *                  (capped at maxDistU), or maxDistU when the shell does not fit but the
 *                  two fit there right now
 *   mode 'field' : the field wins — look from the field, at maxDistU; the ship shows its
 *                  edge arrow whenever it is off screen
 * LadderController.frameZoomTo never zooms in, so `distU` is a "at least" target.
 * @param {{ship:{x,y,z}, field:{x,y,z}, shipVel?:{x,y,z}, fovDeg:number, viewW:number,
 *          viewH:number, centerPx:{x:number,y:number}, rects?:Array, foot:object,
 *          maxDistU:number}} a
 * @returns {{mode:string, dir:THREE.Vector3, distU:number, dShell:number, rhoPx:number}|null}
 */
export function earthFrame({ ship, field, shipVel, fovDeg, viewW, viewH, centerPx, rects = [], foot, maxDistU }) {
  const ls = _len(ship), lf = _len(field);
  if (!(ls > 0) || !(lf > 0) || !Number.isFinite(ls) || !Number.isFinite(lf)) return null;
  if (!(viewW > 0) || !(viewH > 0) || !(fovDeg > 0) || !(maxDistU > 0) || !centerPx || !foot) return null;
  const rmax = Math.max(ls, lf) + EARTH_FRAME_PAD_U;
  const rhoPx = earthSafeRadiusPx({ centerPx, viewW, viewH, rects, foot });
  const dShell = earthShellDistance({ rmax, fovDeg, viewH, rhoPx });
  const mid = earthPairDir(ship, field, shipVel);
  if (mid && dShell <= maxDistU) return { mode: 'both', dir: mid, distU: dShell, dShell, rhoPx };
  if (mid && earthPointsFit({ points: [ship, field], dir: mid, distU: maxDistU, fovDeg, viewW, viewH, centerPx, rects, foot })) {
    return { mode: 'both', dir: mid, distU: maxDistU, dShell, rhoPx };
  }
  const k = (2 * EARTH_RADIUS_U) / lf;
  const fd = earthTurnTarget({ x: field.x * k, y: field.y * k, z: field.z * k });
  return fd ? { mode: 'field', dir: fd, distU: maxDistU, dShell, rhoPx } : null;
}
