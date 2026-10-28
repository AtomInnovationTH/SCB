/**
 * portraitFraming.js — pure camera-framing math for the SPECS pane's one-shot
 * part portrait: where a 35° camera must stand so a part's bounding sphere fills
 * `fill` of a 16:10 frame, plus the near/far planes. No DOM, no WebGL.
 * Everything is in the BOX'S units (scene units, 1e-5 per metre); the caller
 * scales into the ×S near-field space (SceneManager.renderPartPortrait scales
 * near/far by NEAR_FIELD_SCALE).
 *
 * Why a dedicated camera: the orbit camera pivots on the SHIP centre, so it
 * can't centre an off-axis part. `test-PortraitFraming.js` pins the distance law
 * (0.5 m sphere radius at fill 0.7 / fov 35 / 16:10 → 2.265 m).
 *
 * @module scene/portraitFraming
 */
import { Vector3 } from 'three';

const DEG2RAD = Math.PI / 180;

/**
 * Default viewing direction (ship frame +X stbd / +Y up / +Z fore): a 3/4
 * fore-starboard-up quarter, used only when neither the player's side nor a
 * per-card override is usable.
 * @type {readonly number[]}
 */
export const PORTRAIT_DEFAULT_DIR = Object.freeze([0.6, 0.45, 0.75]);

/** Default bounding-sphere fill of the frame's limiting axis. */
export const PORTRAIT_DEFAULT_FILL = 0.7;

/** Dot-product limit past which `portraitUpFor` swaps image "up" from ship +Y to +Z (fore); else roll near the Y axis is fp noise. */
export const PORTRAIT_UP_COS_LIMIT = 0.9;

const _tmpDir = new Vector3();

function finite3(v) {
  return !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/** Read a Vector3-like or [x,y,z] direction into `out`, normalised; null when unusable. */
function readDir(d, out) {
  if (!d) return null;
  if (Array.isArray(d)) {
    if (d.length < 3) return null;
    out.set(Number(d[0]), Number(d[1]), Number(d[2]));
  } else {
    out.set(Number(d.x), Number(d.y), Number(d.z));
  }
  if (!finite3(out) || out.lengthSq() < 1e-24) return null;
  return out.normalize();
}

/**
 * Where a perspective camera must stand to frame `box`.
 *
 *   target   = the box centre
 *   radius   = ½ · |box size| (bounding sphere: orientation-free)
 *   fovV     = the LIMITING field of view: vertical `fovDeg` when the frame is
 *              wider than tall, else the horizontal one (2·atan(tan(fov/2)·aspect))
 *   distance = radius / (fill · tan(fovV/2))
 *   position = target + dir · distance   (`dir` points from the part TOWARD the camera)
 *   near     = max(distance − 1.5·radius, 0.05·radius)
 *   far      = distance + max(3·radius, farSlack)
 *
 * `farSlack` (box units) keeps the hull BEHIND a small part in frame: for a
 * 5 cm puck 3·radius is 9 cm and its deck plate would clip to black.
 * SceneManager passes the near-field bracket slack (10 m).
 *
 * Returns null on a degenerate box (empty, non-finite, radius < 1e-9) or an
 * unusable direction / fov / aspect; the caller falls back to the live-crop
 * photo (never a throw).
 *
 * @param {{ min: {x:number,y:number,z:number}, max: {x:number,y:number,z:number}, isEmpty?: function }} box
 *   a THREE.Box3 (or any {min,max} pair) in the caller's units
 * @param {{x:number,y:number,z:number}|number[]} dirUnit part → camera direction (normalised here)
 * @param {number} fovDeg vertical field of view, degrees
 * @param {number} aspect frame width / height (16:10 → 1.6)
 */
export function portraitCameraFor(box, dirUnit, fovDeg, aspect, fill = PORTRAIT_DEFAULT_FILL, farSlack = 0) {
  if (!box || !box.min || !box.max) return null;
  if (typeof box.isEmpty === 'function' && box.isEmpty()) return null;
  if (!finite3(box.min) || !finite3(box.max)) return null;
  const sx = box.max.x - box.min.x, sy = box.max.y - box.min.y, sz = box.max.z - box.min.z;
  if (sx < 0 || sy < 0 || sz < 0) return null;                 // an inverted box is empty
  const radius = 0.5 * Math.sqrt(sx * sx + sy * sy + sz * sz);
  if (!Number.isFinite(radius) || radius < 1e-9) return null;
  const dir = readDir(dirUnit, new Vector3());
  if (!dir) return null;
  if (!Number.isFinite(fovDeg) || fovDeg <= 0 || fovDeg >= 180) return null;
  if (!Number.isFinite(aspect) || aspect <= 0) return null;
  const f = (Number.isFinite(fill) && fill > 0) ? fill : PORTRAIT_DEFAULT_FILL;
  const slack = (Number.isFinite(farSlack) && farSlack > 0) ? farSlack : 0;

  const halfV = fovDeg * 0.5 * DEG2RAD;
  const halfH = Math.atan(Math.tan(halfV) * aspect);          // the horizontal half-angle
  const halfLimit = Math.min(halfV, halfH);                     // the narrower axis limits the frame
  const fovV = 2 * halfLimit / DEG2RAD;
  const distance = radius / (f * Math.tan(halfLimit));
  if (!Number.isFinite(distance) || distance <= 0) return null;

  const target = new Vector3(
    0.5 * (box.min.x + box.max.x),
    0.5 * (box.min.y + box.max.y),
    0.5 * (box.min.z + box.max.z),
  );
  const position = target.clone().addScaledVector(dir, distance);
  const near = Math.max(distance - radius * 1.5, radius * 0.05);
  const far = distance + Math.max(radius * 3, slack);
  return { position, target, dir, distance, radius, near, far, fovV, method: 'sphere' };
}

/**
 * Default fill for {@link portraitCameraFit}: the part's LARGEST projected
 * extent spans this fraction of the frame's limiting axis. High (0.95) because
 * the fit bounds the 8 corners of the part's BOX, so a round silhouette sits
 * well inside that rectangle.
 */
export const PORTRAIT_FIT_FILL = 0.95;

/** Auto-roll hysteresis: roll 90° only when the long projected axis exceeds the short one by this factor (near-square parts never flip). */
export const PORTRAIT_ROLL_RATIO = 1.15;

const _fitX = new Vector3();
const _fitY = new Vector3();
const _fitZ = new Vector3();
const _fitV = new Vector3();

/**
 * The 8 corners of a local Box3 taken through `matrix` into world (fresh
 * Vector3s — per click, never per frame). The fit works on corners, not a world
 * AABB: a ship-local box is tight for ship-aligned hardware, its world AABB is
 * not (the wings' 3.06 × 0.00 × 2.00 m local box becomes 3.23 × 2.26 × 2.62 m
 * under the LVLH attitude).
 *
 * @param {import('three').Matrix4|null} [matrix] local → world; identity when null
 * @returns {Vector3[]|null} null on a degenerate / non-finite box
 */
export function boxCornersWorld(box, matrix) {
  if (!box || !box.min || !box.max) return null;
  if (typeof box.isEmpty === 'function' && box.isEmpty()) return null;
  if (!finite3(box.min) || !finite3(box.max)) return null;
  if (box.max.x < box.min.x || box.max.y < box.min.y || box.max.z < box.min.z) return null;
  const out = [];
  for (let k = 0; k < 8; k++) {
    const v = new Vector3(k & 1 ? box.max.x : box.min.x, k & 2 ? box.max.y : box.min.y, k & 4 ? box.max.z : box.min.z);
    if (matrix) v.applyMatrix4(matrix);
    if (!finite3(v)) return null;
    out.push(v);
  }
  return out;
}

/**
 * Tight projected-corner fit. Given the part's 8 world corners
 * ({@link boxCornersWorld}), a view direction and an image up, stand the camera
 * where the LARGEST projected extent spans `fill` of the frame's limiting axis:
 *
 *   basis    z = dir (part → camera), x = up × z, y = z × x
 *   corner   (cx, cy, cz) = (c − target) · (x, y, z);  ex = max|cx|, ey = max|cy|
 *   roll     frame wider than tall (aspect > 1) and ey > ex · PORTRAIT_ROLL_RATIO
 *            → roll 90° (up := x) so the long axis runs along the WIDE axis; a
 *            taller-than-wide frame goes the other way. Deterministic.
 *   distance d = max over corners of ( |cx| / (fill·tan(fovH/2)) + cz,
 *                                      |cy| / (fill·tan(fovV/2)) + cz )
 *            — every corner inside the frustum at ITS depth; floored at
 *            maxCz + 0.05·radius so the camera is in front of every corner
 *   position = target + dir · d;   target = the corners' centroid
 *   near     = max(0.5 · (d − maxCz), 0.05·radius);  far = d + max(3·radius, farSlack)
 *
 * Null on fewer than 8 finite corners, a zero-extent part, or an unusable dir /
 * fov / aspect; the caller falls back to {@link portraitCameraFor}. `up` in the
 * result is the (possibly rolled) image up the camera must use.
 *
 * @param {Vector3[]} corners 8 world corners (box units)
 * @param {{x:number,y:number,z:number}|number[]} upUnit image up (world); world +Y when unusable
 * @param {number} fovDeg vertical field of view, degrees
 * @param {number} aspect frame width / height
 */
export function portraitCameraFit(corners, dirUnit, upUnit, fovDeg, aspect, fill = PORTRAIT_FIT_FILL, farSlack = 0, autoRoll = true) {
  if (!Array.isArray(corners) || corners.length !== 8) return null;
  for (const c of corners) if (!finite3(c)) return null;
  const dir = readDir(dirUnit, new Vector3());
  if (!dir) return null;
  if (!Number.isFinite(fovDeg) || fovDeg <= 0 || fovDeg >= 180) return null;
  if (!Number.isFinite(aspect) || aspect <= 0) return null;
  const f = (Number.isFinite(fill) && fill > 0) ? fill : PORTRAIT_FIT_FILL;
  const slack = (Number.isFinite(farSlack) && farSlack > 0) ? farSlack : 0;

  const target = new Vector3();
  for (const c of corners) target.add(c);
  target.multiplyScalar(1 / 8);
  let radius = 0;
  for (const c of corners) radius = Math.max(radius, _fitV.copy(c).sub(target).length());
  if (!Number.isFinite(radius) || radius < 1e-9) return null;

  let up = readDir(upUnit, new Vector3()) || new Vector3(0, 1, 0);
  const basis = (u) => {
    _fitZ.copy(dir);
    _fitX.crossVectors(u, _fitZ);
    if (_fitX.lengthSq() < 1e-12) {            // up ∥ dir: any perpendicular will do, deterministically
      _fitX.set(1, 0, 0).cross(_fitZ);
      if (_fitX.lengthSq() < 1e-12) _fitX.set(0, 1, 0).cross(_fitZ);
    }
    _fitX.normalize();
    _fitY.crossVectors(_fitZ, _fitX).normalize();
  };
  const extents = () => {
    let ex = 0, ey = 0;
    for (const c of corners) {
      _fitV.copy(c).sub(target);
      ex = Math.max(ex, Math.abs(_fitV.dot(_fitX)));
      ey = Math.max(ey, Math.abs(_fitV.dot(_fitY)));
    }
    return { ex, ey };
  };
  basis(up);
  let { ex, ey } = extents();
  let rolled = false;
  if (autoRoll !== false) {
    const wide = aspect >= 1;
    const wantRoll = wide ? (ey > ex * PORTRAIT_ROLL_RATIO) : (ex > ey * PORTRAIT_ROLL_RATIO);
    if (wantRoll) {
      up = _fitX.clone();                        // a 90° roll about the view axis: the old right becomes up
      basis(up);
      ({ ex, ey } = extents());
      rolled = true;
    }
  }
  if (ex < 1e-12 && ey < 1e-12) return null;     // a point / a line along the view axis

  const halfV = fovDeg * 0.5 * DEG2RAD;
  const tanV = Math.tan(halfV);
  const tanH = tanV * aspect;
  const fovV = fovDeg;
  let d = 0, maxCz = -Infinity;
  for (const c of corners) {
    _fitV.copy(c).sub(target);
    const cx = _fitV.dot(_fitX), cy = _fitV.dot(_fitY), cz = _fitV.dot(_fitZ);
    maxCz = Math.max(maxCz, cz);
    d = Math.max(d, Math.abs(cx) / (f * tanH) + cz, Math.abs(cy) / (f * tanV) + cz);
  }
  d = Math.max(d, maxCz + radius * 0.05);
  if (!Number.isFinite(d) || d <= 0) return null;
  const position = target.clone().addScaledVector(dir, d);
  const near = Math.max(0.5 * (d - maxCz), radius * 0.05);
  const far = d + Math.max(radius * 3, slack);
  return { position, target, dir, up: up.clone(), distance: d, radius, near, far, fovV, ex, ey, rolled, method: 'fit' };
}

/**
 * The direction (part → camera, unit) a portrait is taken from, by precedence:
 *   1. a per-card `override` (already a world direction), normalised — used when
 *      the player's side is known-bad for that part;
 *   2. the player's current side: unit vector from `target` to `cameraPos`;
 *   3. {@link PORTRAIT_DEFAULT_DIR} when both are unusable (non-finite,
 *      zero-length, camera on the part).
 * Always returns a fresh unit Vector3; never null, never throws.
 */
export function portraitDirFor(cameraPos, target, override) {
  const out = new Vector3();
  if (readDir(override, out)) return out;
  if (finite3(cameraPos) && finite3(target)) {
    out.set(cameraPos.x - target.x, cameraPos.y - target.y, cameraPos.z - target.z);
    if (out.lengthSq() >= 1e-24) return out.normalize();
  }
  return out.set(PORTRAIT_DEFAULT_DIR[0], PORTRAIT_DEFAULT_DIR[1], PORTRAIT_DEFAULT_DIR[2]).normalize();
}

/**
 * The image "up" for a portrait along `dirUnit`: `shipUp` unless the view runs
 * within {@link PORTRAIT_UP_COS_LIMIT} of parallel to it (top-down shots), where
 * `shipFore` takes over so the roll is a choice, not fp noise. Fresh unit
 * Vector3; a missing / degenerate `shipFore` keeps `shipUp`; if that is unusable
 * too, world +Y.
 *
 * @param {{x:number,y:number,z:number}} shipUp ship +Y in world
 * @param {{x:number,y:number,z:number}} [shipFore] ship +Z in world
 */
export function portraitUpFor(dirUnit, shipUp, shipFore, cosLimit = PORTRAIT_UP_COS_LIMIT) {
  const up = readDir(shipUp, new Vector3()) || new Vector3(0, 1, 0);
  const dir = readDir(dirUnit, _tmpDir);
  if (!dir) return up;
  if (Math.abs(dir.dot(up)) <= cosLimit) return up;
  const fore = readDir(shipFore, new Vector3());
  if (!fore || Math.abs(dir.dot(fore)) > cosLimit) return up;
  return fore;
}
