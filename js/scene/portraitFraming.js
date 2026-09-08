/**
 * portraitFraming.js — pure camera-framing math for the SPECS pane's one-shot
 * PART PORTRAIT (Session T, plan tmp/plans/1788863200000-specs-pane-part-imagery.md
 * §1.6 / T0). No DOM, no WebGL, no renderer state: given a part's world Box3
 * and a viewing direction it answers WHERE a 35° camera must stand so the
 * part's bounding sphere fills `fill` of a 16:10 frame, plus the near/far
 * planes that bracket it. Everything is in the BOX'S units (scene units, 1e-5
 * per metre) — the caller scales into the ×S near-field space itself
 * (SceneManager.renderPartPortrait multiplies near/far by NEAR_FIELD_SCALE).
 *
 * Why a dedicated camera at all (plan §1.5): the orbit/ladder camera pivots on
 * the SHIP centre, so a close orbit can never centre an off-axis part — every
 * pane-ready portrait needs a camera aimed AT the part's box. This module is
 * that aim, kept pure so `test-PortraitFraming.js` pins the distance law
 * (a 0.5 m bounding-sphere radius at fill 0.7 / fov 35 / 16:10 → 2.265 m).
 *
 * @module scene/portraitFraming
 */
import { Vector3 } from 'three';

const DEG2RAD = Math.PI / 180;

/**
 * The plan §2.2 default viewing direction (ship frame +X stbd / +Y up / +Z
 * fore): a 3/4 fore-starboard-up quarter — the hull's classic beauty side —
 * used only when neither the player's side nor a per-card override is usable.
 * @type {readonly number[]}
 */
export const PORTRAIT_DEFAULT_DIR = Object.freeze([0.6, 0.45, 0.75]);

/** Default bounding-sphere fill of the frame's limiting axis (plan §1.6). */
export const PORTRAIT_DEFAULT_FILL = 0.7;

/**
 * Dot-product limit past which `portraitUpFor` swaps the image "up" from the
 * ship's +Y to its +Z (fore): a camera looking nearly straight down (or up) the
 * ship's Y axis would otherwise get a roll decided by fp noise.
 */
export const PORTRAIT_UP_COS_LIMIT = 0.9;

const _tmpDir = new Vector3();

/** @private true when every component of a {x,y,z} triple is a finite number */
function finite3(v) {
  return !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/** @private read a direction given as a Vector3-like or a [x,y,z] array into `out`; null when unusable */
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
 *   radius   = ½ · |box size| (the bounding sphere — orientation-free, so a
 *              wing seen edge-on and face-on get the same distance)
 *   fovV     = the frame's LIMITING field of view: the vertical `fovDeg` when
 *              the frame is wider than tall, else the horizontal one
 *              (2·atan(tan(fov/2)·aspect)) so a narrow frame never crops the
 *              sphere sideways
 *   distance = radius / (fill · tan(fovV/2)) — the sphere spans `fill` of the
 *              limiting axis
 *   position = target + dir · distance   (`dir` points from the part TOWARD
 *              the camera — the side the part is photographed from)
 *   near     = max(distance − 1.5·radius, 0.05·radius)
 *   far      = distance + max(3·radius, farSlack)
 *
 * `farSlack` (box units, default 0) lets the caller keep the hull BEHIND a
 * small part in frame: for a 5 cm sun-sensor puck 3·radius is 9 cm and the
 * deck plate it sits on would be clipped to black; SceneManager passes the
 * near-field bracket slack (10 m) so the portrait's far plane always covers
 * the whole ship whatever the part's size.
 *
 * Returns null on a degenerate box (empty, non-finite, or a bounding-sphere
 * radius under 1e-9) or an unusable direction / fov / aspect — the caller then
 * falls back to the live-crop photo (plan §1.6: never a throw at the photo
 * edge).
 *
 * @param {{ min: {x:number,y:number,z:number}, max: {x:number,y:number,z:number}, isEmpty?: function }} box
 *   a THREE.Box3 (or any {min,max} pair) in the caller's units
 * @param {{x:number,y:number,z:number}|number[]} dirUnit part → camera direction (normalised here)
 * @param {number} fovDeg vertical field of view, degrees (the portrait camera's 35)
 * @param {number} aspect frame width / height (16:10 → 1.6)
 * @param {number} [fill] fraction of the limiting axis the bounding sphere spans (default 0.7)
 * @param {number} [farSlack] minimum depth kept behind the target, box units (default 0)
 * @returns {{ position: Vector3, target: Vector3, dir: Vector3, distance: number,
 *   radius: number, near: number, far: number, fovV: number }|null}
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
 * extent spans this fraction of the frame's limiting axis (checkpoint-1
 * amendment (a), 2026-09-08 — the sphere law's 0.7 of a sphere DIAMETER left
 * even single parts at 27–43 % of the frame width; the witness read 5/40).
 * T7 (pose tuning): 0.8 → 0.95 — the fit bounds the 8 corners of the part's
 * BOX, so a round / irregular silhouette sits well inside that rectangle; at
 * 0.8 the second witness still asked to "punch in" on 30 of 40 cards.
 */
export const PORTRAIT_FIT_FILL = 0.95;

/**
 * Auto-roll hysteresis for {@link portraitCameraFit}: the frame is rolled 90°
 * only when the long projected axis exceeds the short one by this factor, so
 * a near-square part never flips roll between two clicks.
 */
export const PORTRAIT_ROLL_RATIO = 1.15;

const _fitX = new Vector3();
const _fitY = new Vector3();
const _fitZ = new Vector3();
const _fitV = new Vector3();

/**
 * The 8 corners of a local Box3 taken through `matrix` into world (fresh
 * Vector3s — per click, never per frame). A ship-local box is a TIGHT
 * oriented box for ship-aligned hardware; its WORLD axis-aligned box is not
 * (the wings' 3.06 × 0.00 × 2.00 m local box becomes 3.23 × 2.26 × 2.62 m
 * once the ship's LVLH attitude rotates it — the bug the first witness
 * measured), which is why the fit works on corners, not on a world AABB.
 *
 * @param {{ min: {x:number,y:number,z:number}, max: {x:number,y:number,z:number} }} box
 * @param {import('three').Matrix4|null} [matrix] local → world; identity when null
 * @returns {Vector3[]|null} 8 corners, or null on a degenerate / non-finite box
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
 * Checkpoint-1 amendment (a) + (c): the TIGHT projected-corner fit. Given the
 * part's 8 world corners (from its ship-local box — {@link boxCornersWorld}),
 * a view direction and an image up, stand the camera where the LARGEST
 * projected extent of the corners spans `fill` (default PORTRAIT_FIT_FILL,
 * 0.95 after T7) of the frame's limiting axis:
 *
 *   basis    z = dir (part → camera), x = up × z, y = z × x
 *   corner   (cx, cy, cz) = (c − target) · (x, y, z);  ex = max|cx|, ey = max|cy|
 *   roll     when the frame is wider than tall (aspect > 1) and
 *            ey > ex · PORTRAIT_ROLL_RATIO, roll 90° (up := x) so the long
 *            axis runs along the WIDE axis; for a frame taller than wide the
 *            long axis goes vertical. Deterministic for a given box + dir.
 *   distance d = max over corners of ( |cx| / (fill·tan(fovH/2)) + cz,
 *                                      |cy| / (fill·tan(fovV/2)) + cz )
 *            — every corner inside the fill frustum at ITS depth (d − cz);
 *            floored at maxCz + 0.05·radius so the camera is in front of
 *            every corner
 *   position = target + dir · d;   target = the corners' centroid (the
 *            local box centre through the matrix)
 *   near     = max(0.5 · (d − maxCz), 0.05·radius) — half-way to the
 *            nearest corner;  far = d + max(3·radius, farSlack)
 *
 * Null on fewer than 8 finite corners, a zero-extent part, an unusable dir /
 * fov / aspect — the caller falls back to {@link portraitCameraFor} (the
 * sphere law, the documented FALLBACK path). Returns a fresh result: `up` is
 * the (possibly rolled) image up the camera must use.
 *
 * @param {Vector3[]} corners 8 world corners (box units)
 * @param {{x:number,y:number,z:number}|number[]} dirUnit part → camera
 * @param {{x:number,y:number,z:number}|number[]} upUnit image up (world); world +Y when unusable
 * @param {number} fovDeg vertical field of view, degrees
 * @param {number} aspect frame width / height
 * @param {number} [fill] fraction of the limiting axis the largest extent spans (default PORTRAIT_FIT_FILL)
 * @param {number} [farSlack] minimum depth kept behind the target, box units (default 0)
 * @param {boolean} [autoRoll] roll so the long axis follows the frame's long axis (default true)
 * @returns {{ position: Vector3, target: Vector3, dir: Vector3, up: Vector3, distance: number,
 *   radius: number, near: number, far: number, fovV: number, ex: number, ey: number,
 *   rolled: boolean, method: 'fit' }|null}
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
  // The bounding sphere of the corners (for the depth floors / the far plane).
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
 * The direction (part → camera, unit) a portrait is taken from — the plan
 * §2.2 precedence:
 *   1. a per-card `override` (ship-frame table row already turned into a
 *      world direction by the hub), normalised — the ANCHORS truth table says
 *      the player's side is known-bad for that part;
 *   2. else the player's current side: the unit vector from `target` to
 *      `cameraPos` (the part is un-occluded from there — the player just
 *      saw / clicked it);
 *   3. else {@link PORTRAIT_DEFAULT_DIR} (normalised) when both are unusable
 *      (non-finite, zero-length, camera on the part).
 * Always returns a fresh unit Vector3 — never null, never throws.
 *
 * @param {{x:number,y:number,z:number}|null} cameraPos
 * @param {{x:number,y:number,z:number}|null} target
 * @param {{x:number,y:number,z:number}|number[]|null} [override]
 * @returns {Vector3}
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
 * The image "up" for a portrait taken along `dirUnit`: the ship's up (`shipUp`)
 * unless the view runs within {@link PORTRAIT_UP_COS_LIMIT} of parallel to it
 * (a top-down / bottom-up shot — the wings, the reels), where the ship's fore
 * (`shipFore`) takes over so the roll is a choice (nose up in the picture),
 * not fp noise. Returns a fresh unit Vector3; a missing / degenerate fallback
 * keeps `shipUp`; when even that is unusable, world +Y.
 *
 * @param {{x:number,y:number,z:number}} dirUnit part → camera direction
 * @param {{x:number,y:number,z:number}} shipUp ship +Y in world
 * @param {{x:number,y:number,z:number}} [shipFore] ship +Z in world
 * @param {number} [cosLimit]
 * @returns {Vector3}
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
