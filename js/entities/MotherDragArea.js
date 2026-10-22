/**
 * MotherDragArea.js — her projected area across her velocity (Nets step 3 slice 2a, 2026-10-22).
 *
 * The drag law needs the area she presents to the air, and she is not a ball: nose-first with the wings edge-on she shows
 * 3.2 m2 (radiators 146 deg), turned broadside 3.5, with the wings facing forward 5.9. The game used a bare 20 m2.
 *
 * The model (decision C of the slice plan; measured against the built meshes, see test-MotherDragArea.js):
 *
 *     A(d) = ( sum_i ( |d_i| * C_i(theta) )^1.5 )^(1/1.5)  +  sum_wings  A_w * s * |n . d|
 *
 *   d       her velocity direction in HER BODY FRAME (unit; +Z = nose, +Y = radial up, X = orbit normal)
 *   C_i     the core table: her projected area across body axis i with the two ROSA blankets left out and the wings at 0 deg,
 *           by radiator angle theta; Constants.MOTHER_DRAG.CORE_AREA_M2, linearly interpolated between its rows
 *   A_w     one blanket, ROSA_WIDTH x ROSA_LENGTH = 2.0 m2;  s  the wing's deploy scale (wrapper scale.x, 1 = out)
 *   n       the blanket's normal in the body frame, from the pivot's real transform
 *
 * Why this and not the simpler sums: the axis sum |dx|Cx + |dy|Cy + |dz|Cz is always over (max 35 %, median 20 % on the
 * 360 test poses), and a table of the whole ship by axis cannot follow a turned flat plate (max 88-195 % off the axes). A
 * p-norm of 1.5 over the core with the wings as the plates they are is exact on the axes, unbiased (mean signed error
 * ~0.5 %) and costs a few multiplies per frame. Not in it (owed, named in the slice plan): the radiators hiding part of a
 * wing seen nose-first (the model reads up to +22 % there), a held catch's area, launched daughters leaving the core,
 * single-petal holds (the shared radiator angle is used), air that turns with the Earth.
 *
 * Pure: no THREE, no game state. PlayerSatellite.dragAreaM2() gathers her state and calls this.
 */
import { Constants } from '../core/Constants.js';

/** The p of the core blend: 1 is the axis sum (too big), 2 the root of squares (too small); 1.5 is unbiased on the meshes. */
export const CORE_BLEND_P = 1.5;

const DEG = Math.PI / 180;

/** One blanket's area, m2: the drawn plane is PlaneGeometry(ROSA_WIDTH, ROSA_LENGTH) at full deploy. */
export function wingAreaM2() {
  const V5 = Constants.OCTOPUS_V5;
  return V5.ROSA_WIDTH * V5.ROSA_LENGTH;
}

/**
 * The core's projected area across the three body axes at radiator angle `thetaRad`, m2: the CORE_AREA_M2 rows
 * interpolated linearly in the angle, clamped to the first and last row.
 * @param {number} thetaRad radiator angle (the shared `_flowerThetaRad`), radians
 * @param {number[]} [out] receives [Cx, Cy, Cz]
 * @returns {number[]} out
 */
export function coreAreaAt(thetaRad, out = [0, 0, 0]) {
  const rows = Constants.MOTHER_DRAG.CORE_AREA_M2;
  const last = rows.length - 1;
  const deg = Number.isFinite(thetaRad) ? thetaRad / DEG : 0;
  if (deg <= rows[0][0]) { out[0] = rows[0][1]; out[1] = rows[0][2]; out[2] = rows[0][3]; return out; }
  if (deg >= rows[last][0]) { out[0] = rows[last][1]; out[1] = rows[last][2]; out[2] = rows[last][3]; return out; }
  let k = 0;
  while (k < last - 1 && deg > rows[k + 1][0]) k++;
  const a = rows[k], b = rows[k + 1];
  const t = (deg - a[0]) / (b[0] - a[0]);
  out[0] = a[1] + t * (b[1] - a[1]);
  out[1] = a[2] + t * (b[2] - a[2]);
  out[2] = a[3] + t * (b[3] - a[3]);
  return out;
}

const _core = [0, 0, 0];

/**
 * Her projected area across the direction `d`, m2.
 * @param {number} dx velocity direction in her body frame (any length; a zero vector means +Z: she is not moving, nose-first)
 * @param {number} dy
 * @param {number} dz
 * @param {number} thetaRad radiator angle, radians
 * @param {Array<{scale:number, nx:number, ny:number, nz:number}>} [wings] each ROSA wing: deploy scale (wrapper scale.x) and its
 *   blanket normal in the body frame (unit)
 * @param {number} [nWings] how many leading entries of `wings` to count (default all); lets a caller reuse one array
 * @returns {number}
 */
export function motherDragAreaM2(dx, dy, dz, thetaRad, wings, nWings) {
  let len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(len > 1e-12)) { dx = 0; dy = 0; dz = 1; len = 1; }
  const ux = dx / len, uy = dy / len, uz = dz / len;
  const C = coreAreaAt(thetaRad, _core);
  const p = CORE_BLEND_P;
  let area = Math.pow(
    Math.pow(Math.abs(ux) * C[0], p) + Math.pow(Math.abs(uy) * C[1], p) + Math.pow(Math.abs(uz) * C[2], p),
    1 / p,
  );
  if (wings) {
    const aw = wingAreaM2();
    const n = nWings === undefined ? wings.length : Math.min(nWings, wings.length);
    for (let i = 0; i < n; i++) {
      const w = wings[i];
      if (!w) continue;
      const s = w.scale > 0 ? w.scale : 0;
      area += aw * s * Math.abs(w.nx * ux + w.ny * uy + w.nz * uz);
    }
  }
  return area;
}

/** The blanket normal at wing turn `aRad` (both wings turn together about body X, +Y at 0): (0, cos a, sin a). */
export function wingNormalAt(aRad) {
  return { nx: 0, ny: Math.cos(aRad), nz: Math.sin(aRad) };
}

let _reference = null;

/**
 * Her REFERENCE area, m2: how she flies. Nose-first (+Z), radiators at THERMAL.FLOWER.OPEN_DEG (146 deg, the working angle), both wings out and
 * tracking the sun, taken as the mean of the model over the wing turn a uniform in 0..180 deg (the plate's |n.d| = |sin a|
 * nose-first, so the mean is 2/pi): about 3.2 + 2.5 m2. This is the area the sinking arrow's threshold and the welcome
 * pieces (before she has taken a drag step) are computed with.
 * @returns {number}
 */
export function referenceDragAreaM2() {
  if (_reference !== null) return _reference;
  const N = 180;                                       // midpoints of 1-degree bins over 0..180 deg
  let sum = 0;
  const wings = [{ scale: 1, nx: 0, ny: 0, nz: 0 }, { scale: 1, nx: 0, ny: 0, nz: 0 }];
  for (let i = 0; i < N; i++) {
    const n = wingNormalAt((i + 0.5) * DEG);
    for (const w of wings) { w.nx = n.nx; w.ny = n.ny; w.nz = n.nz; }
    sum += motherDragAreaM2(0, 0, 1, Constants.THERMAL.FLOWER.OPEN_DEG * DEG, wings);
  }
  _reference = sum / N;
  return _reference;
}
