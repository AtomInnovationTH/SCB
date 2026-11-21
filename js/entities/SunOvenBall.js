/**
 * SunOvenBall.js — the four 2 m sun-oven balls at the radiator tips (plan P34, lane L1; DECISIONS "Furnaces" row).
 *
 * One ball per radiator strut tip: a clear film sphere (2.0 m) with a mirrored cap of 45 deg half-angle, a fixed 0.6 m foil
 * receiver with a 10 cm aperture 0.59 m from the ball's centre toward the mirror, a gimbal (a head on the tip pad plus a
 * thin inflated half-ring holding the ball at two poles) that turns the ball about its own centre so the mirror faces away
 * from the sun, and a canister that packs film and ring when stowed. The ball rides rigidly with its radiator.
 *
 * States per ball: stowed -> inflating -> up -> folding -> stowed. The 88 deg rule (D8): a ball may be up only while its
 * own radiator angle (per-petal when a petal moves on its own) AND that radiator's target are in [MIN_DEG, TOP_DEG]; a
 * target outside the band starts the fold at once, and the radiator waits at the band edge until the fold ends (at most
 * FOLD_S): `sharedGate` / `limitsFor` give the driver the floor and cap it clamps with (`PlayerSatellite._updateFlower`,
 * `_stepPetalHolds`). `stowAll()` is the instant hard reset (no gas), so a reset never leaves a radiator held.
 * Gas (D6): each inflate bills N2_KG_PER_INFLATE of steering gas once, at inflate start; the gas is lost at the fold.
 *
 * Fit (2026-10-29, plan P34 L3-fix; measured: with a 5.2 m rocket body on a rack a ball was inside it in 200 of 200 trips): a ball opens
 * only where its envelope (`outerRadiusM`, 1.0115 m, read from the built meshes) clears every held piece by FIT_CLEAR_M (20 mm).
 * `fits(i, theta)` / `blocker` / `blockerAcross(i, from, to)` measure the exact distance to the piece's triangles after a box prefilter
 * (and a piece holding the ball's centre inside its closed mesh blocks too: three axis rays crossing it an odd number of times);
 * the pieces are every rack catch (placed by `heldCargoBookingMeters`, the chain the radiator clearance reads) and a catch in hand.
 * Plan P34 L3-fix2 (owner 2026-10-29, "Hold the piece higher"; measured: with the piece at her hold pose 2 of 4 balls opened on the
 * 5.2 m body, with her at her radiator-lift pose 4 of 4): a ball opens only with its radiator AT REST in the band (no sweep angle counts)
 * and, while the trip's burn lift is on (`ArmManager.setBurnLift`), only once every holder stands at her lift pose
 * (`burnLiftSettled`); the pieces are then placed where she stands (`'now'`) at inflate time and at her lift pose (`'lift'`:
 * `burnLiftPoseOf`) for `requestUp` and for the trip's plan; a holder with no lift pose (the game's checks refuse one) is placed over
 * her `'legacy'` range, her strut angle now, her hold pose and her lift pose and every 5 deg between, as before. `requestUp` refuses a
 * ball that does not fit at the radiators' rest angle (their target) and the check runs again at inflate time (a request made below
 * the band has no angle yet): stowed, nothing latched, no gas. `inflatesAffordable` tells the trip how many inflates the tank can pay;
 * `requestUp(i, who)` / `requestDown(i, who)` / `ownerOf` let the FURNACE TEST fold only the balls it asked for.
 *
 * Frame (MOUNT in Constants.SUN_OVEN_BALL): everything lives under the tip group in its local axes (x boom outward,
 * y tangential, z in-plane perpendicular = "ef", nose-ward at radiator 90 deg), scene units (positions x M).
 * Names start with `FlowerStrut` so `_flowerFold.js` classes them as radiator parts.
 *
 * Update order (`PlayerSatellite._stepFlowerAndOvens`, called from `update`): `sunOvenBalls.update(dt, gameDt)` runs BEFORE
 * `_updateFlower(dt)` (the 88 deg gate needs this frame's states), then `sunOvenBalls.aim()` runs AFTER it (pointing
 * uses this frame's radiator angle); dt is real seconds, gameDt (the frame's game seconds, a missing value = dt) drives the lid and the plate.
 */
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { coldGasKgToPool } from '../systems/ResourceSystem.js';
import { degToRad, smoothstep01 } from '../core/MathUtil.js';
import { DebrisField } from './DebrisField.js';
import { prepPiece, placeTris } from '../systems/HoldWingClear.js';
import { heldCargoBookingMeters, heldInHandBookingMeters } from '../systems/CoMCalculator.js';

const M = 0.00001;                       // scene units per metre (CONVENTIONS §9 rule 3)
const BAND_EPS_RAD = 1e-6;
const PARALLEL_SIN = Math.sin(degToRad(1));   // d x sun shorter than this: the pole axis is undefined, keep the last azimuth
const NEUTRAL_GATE = Object.freeze({ floorRad: -Infinity, ceilRad: Infinity });
/** A ball opens only where its envelope clears every held piece by this much, m (plan P34 L3-fix rule 1; the L1 fit margin on the hull). */
const FIT_CLEAR_M = 0.02;
/** The radiator angles a ball passes while it opens are tested every this many degrees, so the ball centre (1.07 m from the hinge) moves 19 mm between tests: under the margin. */
const SWEEP_STEP_DEG = 1;
/** The strut angles a daughter's catch can have are tested every this many degrees between her lowest and highest (her piece moves 5 deg x her strut length between two). */
const PLACE_STEP_DEG = 5;
/** The melt draws a piece shortened to the share `_meltK` of its mass left, never below this (DebrisField.setDrawScale); tested down to it. */
const MELT_K_FLOOR = 0.02;
/**
 * The shortening is walked per triangle (`_sweptNear`): every vertex moves in a straight line as the share left `k` falls, so each step
 * goes as far as the triangle's fastest vertex can before it could reach the ball's zone, and when the surface is already within
 * SWEEP_SURFACE_STEP_M (10 mm) of the zone, exactly that far: the surface never moves more than 10 mm between two tests that are close to
 * touching (an 11 m stage moved 55 mm a step with a fixed 0.01 step of `k`). Not exact at the margin's edge: within 10 mm of the zone the
 * surface can go into the 20 mm margin and come out again between two tests, at most 5 mm deep (half of a 10 mm step), so the margin that
 * is really held is at least 15 mm (a piece that would reach the ball itself is never stepped over).
 */
const SWEEP_SURFACE_STEP_M = 0.01;
const _tri9 = new Float64Array(9);
const _eul = new THREE.Euler();
const _mm = new THREE.Matrix4();
const _vf = new THREE.Vector3();
const _bookV = { x: 0, y: 0, z: 0 };
const _bookQ = new THREE.Quaternion();
const _vg = new THREE.Vector3();
const _axisV = { x: 0, y: 0, z: 0 };
/** prepared meshes of held pieces (`prepPiece` with no split: the piece's own triangles, m), by piece; re-made when its drawn scale changes */
const _prepCache = new WeakMap();

/** Squared distance from point p to triangle T[o..o+8] (Ericson, Real-Time Collision Detection 5.1.5). */
function ptTri2(px, py, pz, T, o) {
  const ax = T[o], ay = T[o + 1], az = T[o + 2];
  const abx = T[o + 3] - ax, aby = T[o + 4] - ay, abz = T[o + 5] - az;
  const acx = T[o + 6] - ax, acy = T[o + 7] - ay, acz = T[o + 8] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
  const bpx = px - T[o + 3], bpy = py - T[o + 4], bpz = pz - T[o + 5];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); const dx = apx - v * abx, dy = apy - v * aby, dz = apz - v * abz; return dx * dx + dy * dy + dz * dz; }
  const cpx = px - T[o + 6], cpy = py - T[o + 7], cpz = pz - T[o + 8];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); const dx = apx - w * acx, dy = apy - w * acy, dz = apz - w * acz; return dx * dx + dy * dy + dz * dz; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const qx = T[o + 3] + w * (T[o + 6] - T[o + 3]), qy = T[o + 4] + w * (T[o + 7] - T[o + 4]), qz = T[o + 5] + w * (T[o + 8] - T[o + 5]);
    const dx = px - qx, dy = py - qy, dz = pz - qz; return dx * dx + dy * dy + dz * dz;
  }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  const dx = apx - (abx * v + acx * w), dy = apy - (aby * v + acy * w), dz = apz - (abz * v + acz * w);
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Does the ray from (px,py,pz) along +axis (0 x, 1 y, 2 z) cross an odd number of the n triangles T? Each triangle is projected onto the
 * plane normal to the ray and tested against the point with signed areas, so a closed mesh gives an even count from outside and an odd
 * one from inside. A hit exactly on an edge may count twice: the caller asks three axes.
 */
function rayOdd(px, py, pz, T, n, axis) {
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const p = [px, py, pz];
  let hits = 0;
  for (let t = 0; t < n; t++) {
    const o = 9 * t;
    const ax = T[o + a1] - p[a1], ay = T[o + a2] - p[a2];
    const bx = T[o + 3 + a1] - p[a1], by = T[o + 3 + a2] - p[a2];
    const cx = T[o + 6 + a1] - p[a1], cy = T[o + 6 + a2] - p[a2];
    const d1 = ax * by - ay * bx, d2 = bx * cy - by * cx, d3 = cx * ay - cy * ax;
    if (((d1 < 0) || (d2 < 0) || (d3 < 0)) && ((d1 > 0) || (d2 > 0) || (d3 > 0))) continue;
    const area = d1 + d2 + d3;
    if (area === 0) continue;                                          // edge-on
    const along = (d2 * T[o + axis] + d3 * T[o + 3 + axis] + d1 * T[o + 6 + axis]) / area;   // where the ray meets the triangle's plane
    if (along > p[axis]) hits++;
  }
  return (hits & 1) === 1;
}

/**
 * Is the point c within `need` of the n triangles T (box lo/hi first), or inside the closed piece (three axis rays crossing it an odd number of times)?
 */
function withinTris(T, n, lo, hi, c, need) {
  const gx = Math.max(lo[0] - c.x, 0, c.x - hi[0]), gy = Math.max(lo[1] - c.y, 0, c.y - hi[1]), gz = Math.max(lo[2] - c.z, 0, c.z - hi[2]);
  const need2 = need * need;
  if (gx * gx + gy * gy + gz * gz >= need2) return false;
  for (let t = 0; t < n; t++) if (ptTri2(c.x, c.y, c.z, T, 9 * t) < need2) return true;
  // no surface within reach, but the centre may lie deep inside a closed piece (its walls farther than the ball's radius): inside when
  // the rays along all three axes cross an odd number of triangles (an open mesh gives a stray odd count on one axis, not on all three)
  return gx === 0 && gy === 0 && gz === 0 && rayOdd(c.x, c.y, c.z, T, n, 0) && rayOdd(c.x, c.y, c.z, T, n, 1) && rayOdd(c.x, c.y, c.z, T, n, 2);
}

const _Y = new THREE.Vector3(0, 1, 0);
const _Z = new THREE.Vector3(0, 0, 1);
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qc = new THREE.Quaternion();
const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _vc = new THREE.Vector3();
const _vd = new THREE.Vector3();
const _ve = new THREE.Vector3();
const _m4 = new THREE.Matrix4();

/** @returns {number} signed angle (rad) from `a` to `b` about unit axis `n` (a and b taken in the plane normal to n). */
function signedAngle(a, b, n) {
  _ve.crossVectors(a, b);
  return Math.atan2(_ve.dot(n), a.dot(b));
}

/**
 * Run `build` with a private `Math.random`. three.js draws four numbers from `Math.random` for every object, geometry and
 * material it creates (its UUIDs), and the seeded test rigs (`_satHaulRig.js` `seeded`, test-SatHandover.js) build the ship
 * inside a seeded window: ~130 extra draws per station moved every seeded layout (measured 2026-10-29: 34 test files
 * failed with only `addStation` added, none with it skipped). The balls draw their UUIDs from this counter instead, so the
 * global stream is exactly as long as before.
 */
let _uuidSeed = 0x5eed0b11;
function withPrivateRandom(build) {
  const saved = Math.random;
  Math.random = () => {
    _uuidSeed = (_uuidSeed + 0x9e3779b9) >>> 0;
    let z = _uuidSeed;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b); z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35); z ^= z >>> 16;
    return (z >>> 0) / 4294967296;
  };
  try { return build(); } finally { Math.random = saved; }
}

export class SunOvenBalls {
  /** @param {object} ship the PlayerSatellite (or a stub with the same fields: see `update`). */
  constructor(ship) {
    this.ship = ship;
    /** @type {Array<object|undefined>} per tip index (0..3); a tip whose pair is not built stays undefined. */
    this._st = [];
  }

  // ───────────────────────────── build ─────────────────────────────

  /**
   * Build tip i's ball hardware on its tip group. Called from the flower builder once the pad exists. Replaces a station
   * built twice. Everything is hidden but the head and the canister (the ball group is invisible while stowed).
   * @param {number} i tip index
   * @param {THREE.Object3D} tipGroup `FlowerStrutTip_i`
   * @param {THREE.Object3D} padMesh `FlowerStrutTipPad_i` (child of the tip group)
   * @param {THREE.Object3D} hinge `FlowerStrutHinge_i` (parent of the tip group)
   */
  addStation(i, tipGroup, padMesh, hinge) {
    withPrivateRandom(() => this._addStation(i, tipGroup, padMesh, hinge));
  }

  /** @private */
  _addStation(i, tipGroup, padMesh, hinge) {
    if (!tipGroup || !padMesh) return;
    if (this._st[i]) this._disposeStation(this._st[i]);
    const C = Constants.SUN_OVEN_BALL;
    const R = C.DIAMETER_M / 2;
    const FL = Constants.THERMAL.FLOWER;
    const RO = Constants.RENDER_ORDER;
    const mask = tipGroup.layers.mask;
    const geos = [], mats = [];
    const own = (o) => { o.layers.mask = mask; return o; };
    const geo = (g) => { geos.push(g); return g; };
    const mat = (m) => { mats.push(m); return m; };

    // Frame (tip-local metres): pad centre, ball centre, head->centre axis d, the ring's pole axis at azimuth 0 (p0).
    const pad = new THREE.Vector3(padMesh.position.x / M, padMesh.position.y / M, padMesh.position.z / M);
    const phi = degToRad(C.MOUNT_PHI_DEG);
    const centre = new THREE.Vector3(pad.x + C.MOUNT_S_M, C.MOUNT_H_M * Math.sin(phi), C.MOUNT_H_M * Math.cos(phi));
    const d = centre.clone().sub(pad);
    const reach = d.length();
    d.normalize();
    const p0 = new THREE.Vector3(0, 1, 0);
    const a0 = new THREE.Vector3().crossVectors(d, p0).normalize();   // base mirror axis: perpendicular to d and p0
    const qBase = new THREE.Quaternion().setFromUnitVectors(_Z, a0);
    const canister = new THREE.Vector3(C.CANISTER_POS_M[0], C.CANISTER_POS_M[1] * (C.CANISTER_SIDE[i] ?? 1), C.CANISTER_POS_M[2]);
    const toCentre = centre.clone().sub(canister).normalize();
    const anchor = centre.clone().addScaledVector(toCentre, -R);      // the point of the final sphere nearest the canister

    // --- gimbal head: a short post on the pad's ball-facing side, up to the ring's midpoint ---
    // Its axis is the tip-local z (ef), not d: a head along d would stand 23 mm past the pad's end face and the launch fold
    // pins the folded tip at z 1.305 (test-FlowerLaunchFold (ii)); x_max stays 0.010. The bottom cap is dropped (buried).
    const ringMid = centre.clone().addScaledVector(d, -C.RING_CENTRE_R_M);
    const headTop = ringMid.z - C.RING_TUBE_R_M + 0.001;                 // 1 mm into the ring's tube
    const headGeo = geo(new THREE.CylinderGeometry(C.HEAD_R_M * M, C.HEAD_R_M * M, (headTop - C.HEAD_BASE_Z_M) * M, 48));
    headGeo.setIndex(Array.from(headGeo.index.array).slice(0, headGeo.groups[2].start));   // groups: torso, top cap, bottom cap
    headGeo.clearGroups();
    const head = own(new THREE.Mesh(headGeo,
      mat(new THREE.MeshStandardMaterial({ color: 0x444455, metalness: 0.7, roughness: 0.3 }))));
    head.position.set(C.HEAD_X_M * M, 0, ((headTop + C.HEAD_BASE_Z_M) / 2) * M);
    head.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);   // cylinder Y -> tip-local z
    head.name = `FlowerStrutSunOvenHead_${i}`;
    head.renderOrder = RO.SPACECRAFT_OPAQUE;
    tipGroup.add(head);

    // --- canister (film + ring packed) ---
    const can = own(new THREE.Mesh(geo(new THREE.CylinderGeometry(C.CANISTER_D_M / 2 * M, C.CANISTER_D_M / 2 * M, C.CANISTER_H_M * M, 64)),
      mat(new THREE.MeshStandardMaterial({ color: 0xb8bcc4, metalness: 0.75, roughness: 0.35 }))));
    can.position.copy(canister).multiplyScalar(M);
    can.quaternion.setFromAxisAngle(_Z, -Math.PI / 2);                 // axis along the boom (x): flat to the folded tip, so the launch fold's z 1.305 stands
    can.name = `FlowerStrutSunOvenCanister_${i}`;
    can.renderOrder = RO.SPACECRAFT_OPAQUE;
    tipGroup.add(can);

    // --- the ball group: sits at the centre, scaled and shifted while inflating (see `_setK`) ---
    const ball = own(new THREE.Group());
    ball.name = `FlowerStrutSunOvenBall_${i}`;
    ball.position.copy(centre).multiplyScalar(M);
    ball.visible = false;
    tipGroup.add(ball);

    // the ring turns about d only (azimuth); the ball's own group tilts about the ring's pole axis (and carries the azimuth)
    const ring = own(new THREE.Mesh(geo(new THREE.TorusGeometry(C.RING_CENTRE_R_M * M, C.RING_TUBE_R_M * M, 8, 32, Math.PI)),
      mat(new THREE.MeshStandardMaterial({ color: 0xdfe3ea, metalness: 0.2, roughness: 0.5 }))));
    ring.name = `FlowerStrutSunOvenRing_${i}`;
    ring.renderOrder = RO.SPACECRAFT_OPAQUE;
    // torus local: arc from +x through +y to -x. +-x are the poles (p0 at azimuth 0), +y the midpoint, which faces the head (-d).
    const ringZ = new THREE.Vector3().crossVectors(p0, d.clone().negate());
    const qRing0 = new THREE.Quaternion().setFromRotationMatrix(_m4.makeBasis(p0, d.clone().negate(), ringZ));
    ring.quaternion.copy(qRing0);
    ball.add(ring);

    const rot = own(new THREE.Group());
    rot.name = `FlowerStrutSunOvenBallRot_${i}`;
    rot.quaternion.copy(qBase);
    ball.add(rot);

    const film = own(new THREE.Mesh(geo(new THREE.SphereGeometry(R * M, 64, 32)),
      mat(new THREE.MeshStandardMaterial({
        color: 0xcfe6ff, transparent: true, opacity: 0.16, roughness: 0.06, metalness: 0.0,
        side: THREE.DoubleSide, depthWrite: false,
      }))));
    film.name = `FlowerStrutSunOvenFilm_${i}`;
    film.renderOrder = RO.SPACECRAFT_TRANSPARENT;
    rot.add(film);

    const capGeo = geo(new THREE.SphereGeometry((R - 0.005) * M, 64, 8, 0, Math.PI * 2, 0, degToRad(C.CAP_HALF_ANGLE_DEG)));
    capGeo.rotateX(Math.PI / 2);                                       // sphere pole +Y -> +Z: the cap is centred on the mirror axis
    const mirror = own(new THREE.Mesh(capGeo,
      mat(new THREE.MeshStandardMaterial({ color: 0xe8eef5, metalness: 1.0, roughness: 0.08, side: THREE.DoubleSide }))));
    mirror.name = `FlowerStrutSunOvenMirror_${i}`;
    mirror.renderOrder = RO.SPACECRAFT_OPAQUE;
    rot.add(mirror);

    // loading sleeve: a 0.6 m ring on the sphere at the cap's vertex
    const sleeveZ = Math.sqrt(R * R - C.SLEEVE_R_M * C.SLEEVE_R_M);
    const sleeve = own(new THREE.Mesh(geo(new THREE.TorusGeometry(C.SLEEVE_R_M * M, 0.012 * M, 16, 64)),
      mat(new THREE.MeshStandardMaterial({ color: 0xb8bcc4, metalness: 0.7, roughness: 0.4 }))));
    sleeve.position.set(0, 0, sleeveZ * M);
    sleeve.name = `FlowerStrutSunOvenSleeve_${i}`;
    sleeve.renderOrder = RO.SPACECRAFT_OPAQUE;
    rot.add(sleeve);

    // receiver: a 0.6 m foil sphere whose mirror-side pole is the aperture (0.59 m from the centre)
    const recR = C.RECEIVER_D_M / 2;
    const recCz = C.APERTURE_FROM_CENTRE_M - recR;
    const recBody = own(new THREE.Mesh(geo(new THREE.SphereGeometry(recR * M, 64, 32)),
      mat(new THREE.MeshStandardMaterial({ color: 0xc9a64a, metalness: 0.85, roughness: 0.32 }))));
    recBody.position.set(0, 0, recCz * M);
    recBody.name = `FlowerStrutSunOvenReceiverBody_${i}`;
    recBody.renderOrder = RO.SPACECRAFT_OPAQUE;
    rot.add(recBody);

    // mast: a thin tube parallel to the axis, 0.12 m off it, from the receiver's mirror-side face to the cap vertex region
    const mastX = 0.12;
    const mastZ0 = recCz + Math.sqrt(recR * recR - mastX * mastX) - 0.01;
    const mastZ1 = Math.sqrt(R * R - mastX * mastX);
    const mast = own(new THREE.Mesh(geo(new THREE.CylinderGeometry(C.MAST_R_M * M, C.MAST_R_M * M, (mastZ1 - mastZ0) * M, 48)),
      mat(new THREE.MeshStandardMaterial({ color: 0x8a8f96, metalness: 0.6, roughness: 0.45 }))));
    mast.rotation.x = Math.PI / 2;                                     // cylinder Y -> Z
    mast.position.set(mastX * M, 0, ((mastZ0 + mastZ1) / 2) * M);
    mast.name = `FlowerStrutSunOvenMast_${i}`;
    mast.renderOrder = RO.SPACECRAFT_OPAQUE;
    rot.add(mast);

    // aperture: 10 cm disc facing the mirror (+Z), 2 mm proud of the receiver's pole; emissive glow off by default
    const apMat = mat(new THREE.MeshStandardMaterial({
      color: 0x20140c, metalness: 0.4, roughness: 0.6, emissive: new THREE.Color(0xff5a1a), emissiveIntensity: 0,
    }));
    const aperture = own(new THREE.Mesh(geo(new THREE.CircleGeometry(C.APERTURE_D_M / 2 * M, 48)), apMat));
    aperture.position.set(0, 0, (C.APERTURE_FROM_CENTRE_M + 0.002) * M);
    aperture.name = `FlowerStrutSunOvenAperture_${i}`;
    aperture.renderOrder = RO.SPACECRAFT_DETAIL;
    rot.add(aperture);

    // the receiver node: at the aperture, local +Z from the aperture toward the sun side (the mirror axis points away from it)
    const receiver = own(new THREE.Object3D());
    receiver.name = `FlowerStrutSunOvenReceiver_${i}`;
    receiver.position.set(0, 0, C.APERTURE_FROM_CENTRE_M * M);
    receiver.rotation.x = Math.PI;
    rot.add(receiver);

    // --- Furnace 3: the tip's tool and the foil lid (drawn only; the melt is unchanged). Read from the tool table, not imported from BigMelt ---
    const tool = (Constants.BIG_MELT && Constants.BIG_MELT.TOOLS && Constants.BIG_MELT.TOOLS.TIP_TOOL[i]) || 'ball';
    const pinR = C.HINGE_PIN_R_M;
    const lidR = C.LID_D_M / 2;
    const foilMat = () => mat(new THREE.MeshStandardMaterial({ color: 0xdfe4ea, metalness: 0.95, roughness: 0.22, side: THREE.DoubleSide }));
    const steelMat = () => mat(new THREE.MeshStandardMaterial({ color: 0x7d838c, metalness: 0.8, roughness: 0.4 }));
    const recSurfaceZ = (r) => recCz + Math.sqrt(Math.max(0, recR * recR - r * r));       // the receiver's mirror-side surface at distance r from the axis
    /** a post along Z from the receiver's surface (sunk 3 mm) up to z1, at (x, y) */
    const post = (name, x, y, z1) => {
      const z0 = recSurfaceZ(Math.hypot(x, y)) - 0.003;
      const m = own(new THREE.Mesh(geo(new THREE.CylinderGeometry(pinR * M, pinR * M, (z1 - z0) * M, 16)), steelMat()));
      m.rotation.x = Math.PI / 2;
      m.position.set(x * M, y * M, ((z0 + z1) / 2) * M);
      m.name = `FlowerStrutSunOven${name}_${i}`;
      m.renderOrder = RO.SPACECRAFT_OPAQUE;
      rot.add(m);
      return m;
    };

    // lid: a 0.13 m, 3 mm foil disc on a hinge at its -x rim (axis along y), raised so the shut lid clears a plate that is in
    const lidHinge = own(new THREE.Group());
    lidHinge.name = `FlowerStrutSunOvenLidHinge_${i}`;
    lidHinge.position.set(-lidR * M, 0, C.LID_HINGE_Z_M * M);
    rot.add(lidHinge);
    const lidGeo = geo(new THREE.CylinderGeometry(lidR * M, lidR * M, C.LID_T_M * M, 48));
    lidGeo.rotateX(Math.PI / 2);                                       // cylinder Y -> Z: a flat disc
    const lid = own(new THREE.Mesh(lidGeo, foilMat()));
    lid.position.set(lidR * M, 0, 0);
    lid.name = `FlowerStrutSunOvenLid_${i}`;
    lid.renderOrder = RO.SPACECRAFT_OPAQUE;
    lidHinge.add(lid);
    post('LidPost', -lidR - 0.006, 0, C.LID_HINGE_Z_M);        // beside the hinge line, 3 mm clear of the lid's rim (a post at the rim shares a facet plane with it: z-fight)

    let plate = null, plateHinge = null, plateHole = null, plateArm = null;
    let pot = null, coil = null, cable = null;
    if (tool === 'plate') {
      // plate: a 0.12 m, 4 mm grey disc with a 2 cm hole on a hinge at its -y rim (axis along x): in = flat over the aperture, 2 mm proud of it
      const pr = C.PLATE_D_M / 2;
      plateHinge = own(new THREE.Group());
      plateHinge.name = `FlowerStrutSunOvenPlateHinge_${i}`;
      plateHinge.position.set(0, -pr * M, C.PLATE_Z_M * M);
      rot.add(plateHinge);
      const shape = new THREE.Shape();
      shape.absarc(0, 0, pr, 0, Math.PI * 2, false);
      const hole = new THREE.Path();
      hole.absarc(0, 0, C.PLATE_HOLE_D_M / 2, 0, Math.PI * 2, true);
      shape.holes.push(hole);
      const plateGeo = geo(new THREE.ExtrudeGeometry(shape, { depth: C.PLATE_T_M, bevelEnabled: false, curveSegments: 32 }));
      plateGeo.translate(0, pr, -C.PLATE_T_M / 2);
      plateGeo.scale(M, M, M);
      plate = own(new THREE.Mesh(plateGeo, steelMat()));
      plate.name = `FlowerStrutSunOvenPlate_${i}`;
      plate.renderOrder = RO.SPACECRAFT_OPAQUE;
      plateHinge.add(plate);
      // the hole, drawn dark like the aperture; it carries the glow while the plate is in
      plateHole = own(new THREE.Mesh(geo(new THREE.CircleGeometry(C.PLATE_HOLE_D_M / 2 * M, 32)), mat(new THREE.MeshStandardMaterial({
        color: 0x20140c, metalness: 0.4, roughness: 0.6, emissive: new THREE.Color(0xff5a1a), emissiveIntensity: 0,
      }))));
      plateHole.position.set(0, pr * M, -0.0015 * M);
      plateHole.name = `FlowerStrutSunOvenPlateHole_${i}`;
      plateHole.renderOrder = RO.SPACECRAFT_DETAIL;
      plateHinge.add(plateHole);
      // the hinge barrel (along x) and its post
      const armGeo = geo(new THREE.CylinderGeometry(pinR * M, pinR * M, 0.04 * M, 16));
      plateArm = own(new THREE.Mesh(armGeo, steelMat()));
      plateArm.rotation.z = Math.PI / 2;                               // cylinder Y -> x
      plateArm.name = `FlowerStrutSunOvenPlateArm_${i}`;
      plateArm.renderOrder = RO.SPACECRAFT_OPAQUE;
      plateHinge.add(plateArm);
      post('PlateMount', 0, -pr, C.PLATE_Z_M);
    } else if (tool === 'pot') {
      // pot: a gold-foil cylinder on the axis, centred on the receiver's sun-side pole: its top half inside the receiver, the rest out on the sun
      // side (-Z) within the receiver's own shadow (radius 0.30 m of the axis): it blocks no sunlight the receiver does not
      const potZ = recCz - recR;
      const potR = C.POT_D_M / 2;
      const potGeo = geo(new THREE.CylinderGeometry(potR * M, potR * M, C.POT_H_M * M, 64));
      potGeo.rotateX(Math.PI / 2);
      pot = own(new THREE.Mesh(potGeo, mat(new THREE.MeshStandardMaterial({ color: 0xc9a64a, metalness: 0.85, roughness: 0.32 }))));
      pot.position.set(0, 0, potZ * M);
      pot.name = `FlowerStrutSunOvenPot_${i}`;
      pot.renderOrder = RO.SPACECRAFT_OPAQUE;
      rot.add(pot);
      // the coil: a dull copper band round the pot's visible part; it glows orange-red while the pot melts
      coil = own(new THREE.Mesh(geo(new THREE.TorusGeometry(C.COIL_R_M * M, C.COIL_TUBE_R_M * M, 8, 64)), mat(new THREE.MeshStandardMaterial({
        color: 0x9a5a34, metalness: 0.7, roughness: 0.5, emissive: new THREE.Color(0xff3a0c), emissiveIntensity: 0,
      }))));
      coil.position.set(0, 0, (potZ - 0.05) * M);
      coil.name = `FlowerStrutSunOvenCoil_${i}`;
      coil.renderOrder = RO.SPACECRAFT_DETAIL;
      rot.add(coil);
      // the cable: a 5 mm dark tube that leaves the pot's side wall just above its base (start sunk 5 mm into the wall, so it is plainly attached),
      // out past the coil, up the receiver's +x/+y side (7 mm off its skin) to the mast's foot, then up the mast to the film
      const base = potZ - C.POT_H_M / 2;
      const rho = recR + 0.007;
      const pts = [[0.1025, 0.1025, base + 0.015], [0.1308, 0.1308, base + 0.015], [0.1308, 0.1308, -0.05]];
      const b0 = Math.asin(0.185 / rho);                               // the arc starts where it is 0.185 m off the axis (clear of the pot's 0.15 and the coil's 0.165)
      const b1 = degToRad(28);
      for (let k = 0; k <= 24; k++) {                                  // 24 steps: the chord between two samples sags 0.3 mm toward the receiver
        const t = k / 24, beta = Math.PI - b0 + (b1 - (Math.PI - b0)) * t, phi = degToRad(45 - 37 * t);
        pts.push([rho * Math.sin(beta) * Math.cos(phi), rho * Math.sin(beta) * Math.sin(phi), recCz + rho * Math.cos(beta)]);
      }
      const hugX = mastX + (C.MAST_R_M + C.CABLE_D_M / 2) * Math.cos(degToRad(55)), hugY = (C.MAST_R_M + C.CABLE_D_M / 2) * Math.sin(degToRad(55));
      pts.push([hugX, hugY, 0.6], [hugX, hugY, 0.975]);
      const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p[0] * M, p[1] * M, p[2] * M)), false, 'centripetal');
      cable = own(new THREE.Mesh(geo(new THREE.TubeGeometry(curve, 96, C.CABLE_D_M / 2 * M, 6, false)),
        mat(new THREE.MeshStandardMaterial({ color: 0x202226, metalness: 0.1, roughness: 0.7 }))));
      cable.name = `FlowerStrutSunOvenCable_${i}`;
      cable.renderOrder = RO.SPACECRAFT_DETAIL;
      rot.add(cable);
    }

    // the ball's largest outer radius about its centre, read from the built meshes (the ring and the sleeve reach 1.0115 m, past the film's
    // 1.000 m): the envelope `fits` clears the held pieces with. Turning the ball about its centre never changes it.
    ball.updateMatrixWorld(true);
    _m4.copy(ball.matrixWorld).invert();
    let r2 = 0;
    ball.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const pos = o.geometry.getAttribute('position');
      if (!pos) return;
      _mm.multiplyMatrices(_m4, o.matrixWorld);
      for (let k = 0; k < pos.count; k++) {
        const v = _vf.fromBufferAttribute(pos, k).applyMatrix4(_mm);
        const q = v.lengthSq();
        if (q > r2) r2 = q;
      }
    });
    const outerR = Math.sqrt(r2) / M;

    this._st[i] = {
      i, az: FL.AZIMUTHS_DEG[i], tip: tipGroup, hinge: hinge || tipGroup.parent, pad: padMesh, outerR,
      state: 'stowed', t: 0, k: 0, kFold: 0, want: false, owner: null, gasWarned: false, glow: 0,
      d, p0, a0, qBase, qRing0, centre, anchor, azimuth: 0, aimed: false,
      ball, rot, ring, film, mirror, sleeve, recBody, mast, aperture, receiver, head, can,
      tool, lidHinge, lid, plate, plateHinge, plateHole, plateArm, pot, coil, cable,
      lidK: 0, plateK: 0, metal: null, toolsInit: false,
      geos, mats,
    };
    this._poseTools(this._st[i]);
  }

  /** @private */
  _disposeStation(s) {
    for (const o of [s.ball, s.head, s.can]) if (o && o.parent) o.parent.remove(o);
    for (const g of s.geos) g.dispose();
    for (const m of s.mats) m.dispose();
    this._st[s.i] = undefined;
  }

  /** Remove every station's meshes and free their geometries and materials. */
  dispose() {
    for (const s of this._st) if (s) this._disposeStation(s);
    this._st.length = 0;
  }

  // ───────────────────────────── API ─────────────────────────────

  /**
   * Ask ball i to come up: latched, it inflates as soon as its radiator and that radiator's target are in the band. A ball that
   * does not fit (a held piece is inside its envelope at an angle it passes, `blockerAcross`) is refused: it stays stowed and
   * no gas is billed (plan P34 L3-fix rule 1). The same test runs again when the ball is about to inflate (the radiators may
   * have been below the band when it was asked).
   * @param {number} i tip index
   * @param {string} [who] who asks ('trip' = the melt, the default; 'f1' = the FURNACE TEST): the last asker owns the ball, see `requestDown`
   * @returns {boolean} true when the request is latched (a missing station: false)
   */
  requestUp(i, who = 'trip') {
    const s = this._st[i];
    if (!s) return false;
    if (!this._opensHere(s)) { s.want = false; return false; }
    s.want = true;
    s.owner = who;
    return true;
  }

  /** @returns {string|null} who last asked ball i up ('trip', 'f1'), null when nobody does */
  ownerOf(i) {
    const s = this._st[i];
    return s && s.want ? s.owner : null;
  }

  /**
   * Ask ball i to go down: an inflating or up ball starts folding now. With `who` the request only counts while `who` still owns the ball
   * (the FURNACE TEST never folds a ball a melt took over since); without it the ball goes down whoever asked.
   * @param {number} i tip index
   * @param {string} [who]
   */
  requestDown(i, who) {
    const s = this._st[i];
    if (!s) return;
    if (who !== undefined && s.want && s.owner !== who) return;
    s.want = false;
    s.gasWarned = false;
    if (s.state === 'inflating' || s.state === 'up') this._beginFold(s);
  }

  /** @returns {'stowed'|'inflating'|'up'|'folding'} a missing station is 'stowed' */
  stateOf(i) {
    const s = this._st[i];
    return s ? s.state : 'stowed';
  }

  /** @returns {boolean} inflating or up (the ball counts as working: the melt may run in it) */
  isWorking(i) {
    const st = this.stateOf(i);
    return st === 'inflating' || st === 'up';
  }

  /** @returns {number} the angle (rad) ball i's radiator is heading for, the one `requestUp` checks the fit at: a held petal's target, else the shared target, else where it stands; NaN for a missing station */
  restAngleOf(i) {
    const s = this._st[i];
    return s ? this._targetOf(s) : NaN;
  }

  /** @returns {THREE.Object3D|null} the receiver node at ball i's aperture (local +Z toward the sun side) */
  receiverNode(i) {
    const s = this._st[i];
    return s ? s.receiver : null;
  }

  /** Aperture glow k 0..1: 1 = aluminium at 933 K, a dull red-orange. Only visible while the ball is up. A steel melt on the plate tip lights the plate's hole, a steel or titanium melt on the pot tip its coil (`setMeltMetal`). */
  setReceiverGlow(i, k) {
    const s = this._st[i];
    if (!s) return;
    s.glow = Math.min(1, Math.max(0, Number.isFinite(k) ? k : 0));
    this._applyGlow(s);
  }

  /**
   * The metal melting on tip i now (null = nothing): the plate tip swings its plate in for 'steel' (once the lid is open), the glow of a steel or
   * titanium melt moves to the pot's coil. The melt itself is unchanged (step 1): only the drawing follows.
   * @param {number} i tip index
   * @param {string|null} metal the piece's material ('steel', 'titanium', 'aluminum', ...)
   */
  setMeltMetal(i, metal) {
    const s = this._st[i];
    if (!s) return;
    s.metal = metal || null;
    this._applyGlow(s);
  }

  /** @returns {string|null} the metal set last by `setMeltMetal` */
  meltMetalOf(i) {
    const s = this._st[i];
    return s ? s.metal : null;
  }

  /** @returns {number} lid i's opening: 0 shut .. 1 open (a missing station: 1) */
  lidOpenK(i) {
    const s = this._st[i];
    return s ? s.lidK : 1;
  }

  /** @returns {number} the plate of tip i: 0 out (parked) .. 1 in place over the aperture (no plate or a missing station: 0) */
  plateInK(i) {
    const s = this._st[i];
    return s ? s.plateK : 0;
  }

  /** @private the glow lands on the part that holds the melt: the aperture, the plate's hole (plate in), or the pot's coil */
  _applyGlow(s) {
    const g = s.glow;
    let ap = g, hole = 0, coil = 0;
    if (s.tool === 'plate' && s.metal === 'steel') { ap = 0; hole = g * s.plateK; }
    else if (s.tool === 'pot' && (s.metal === 'steel' || s.metal === 'titanium')) { ap = 0; coil = g; }
    s.aperture.material.emissiveIntensity = 1.6 * ap;
    if (s.plateHole) s.plateHole.material.emissiveIntensity = 1.6 * hole;
    if (s.coil) s.coil.material.emissiveIntensity = 1.4 * coil;
  }

  /** @private turn the lid and the plate to their states (`lidK`, `plateK`), eased */
  _poseTools(s) {
    const C = Constants.SUN_OVEN_BALL;
    s.lidHinge.rotation.y = -degToRad(C.LID_OPEN_DEG) * smoothstep01(s.lidK);   // negative: the lid's free edge swings UP and over, never down into the receiver
    if (s.plateHinge) s.plateHinge.rotation.x = degToRad(C.PLATE_OUT_DEG) * (1 - smoothstep01(s.plateK));
    this._applyGlow(s);
  }

  /** @private lid and plate to their rest states at once, no swing: lid shut in Earth's shadow and open in sun, plate out */
  _snapTools(s) {
    s.lidK = this.ship._inShadow === true ? 0 : 1;
    s.plateK = 0;
    s.toolsInit = true;
    this._poseTools(s);
  }

  /**
   * @private one step of the lid (shut in Earth's shadow, open in sun) and the plate (in for a steel melt, once the lid is fully open), in
   * GAME seconds. A stowed ball (and a station's first step) takes the rest state at once, so a ball that inflates in shadow starts and
   * stays shut. The lid does not start to shut while the plate is part-way (it would sweep through it).
   * @param {object} s station
   * @param {number} g game seconds
   */
  _stepTools(s, g) {
    if (s.state === 'stowed' || !s.toolsInit) { this._snapTools(s); return; }
    const C = Constants.SUN_OVEN_BALL;
    const want = this.ship._inShadow === true ? 0 : 1;
    const plateMid = s.plateK > 0 && s.plateK < 1;
    const lidWasOpen = s.lidK >= 1;                                    // the plate moves only through a lid that stood fully open when the step began
    if (want > s.lidK) s.lidK = Math.min(1, s.lidK + g / C.LID_SWING_S);
    else if (want < s.lidK && !plateMid) s.lidK = Math.max(0, s.lidK - g / C.LID_SWING_S);
    if (s.plateHinge && lidWasOpen && s.lidK >= 1) {
      const target = s.metal === 'steel' ? 1 : 0;
      if (target > s.plateK) s.plateK = Math.min(1, s.plateK + g / C.PLATE_SWING_S);
      else if (target < s.plateK) s.plateK = Math.max(0, s.plateK - g / C.PLATE_SWING_S);
    }
    this._poseTools(s);
  }

  /** @returns {number} the receiver glow set last (0..1) */
  receiverGlow(i) {
    const s = this._st[i];
    return s ? s.glow : 0;
  }

  /** @returns {boolean} every ball is stowed (a missing station counts as stowed) */
  allStowed() {
    for (const s of this._st) if (s && s.state !== 'stowed') return false;
    return true;
  }

  /** Instant hard reset: every ball stowed at once, no gas, no latched request, so no radiator stays held at the band edge. */
  stowAll() {
    for (const s of this._st) {
      if (!s) continue;
      s.want = false; s.gasWarned = false;
      s.state = 'stowed'; s.t = 0;
      this._setK(s, 0);
      this._snapTools(s);                                  // plate out, lid at the shadow state, at once
    }
  }

  /** @returns {object|undefined} named scene nodes of tip i's ball (head, canister, ball, ring, film, mirror, ...) for tests and the look */
  nodesOf(i) {
    const s = this._st[i];
    return s ? { head: s.head, canister: s.can, ball: s.ball, ring: s.ring, film: s.film, mirror: s.mirror, sleeve: s.sleeve,
      receiverBody: s.recBody, mast: s.mast, aperture: s.aperture, receiver: s.receiver, rot: s.rot,
      lidHinge: s.lidHinge, lid: s.lid, plateHinge: s.plateHinge, plate: s.plate, plateHole: s.plateHole, plateArm: s.plateArm,
      pot: s.pot, coil: s.coil, cable: s.cable } : undefined;
  }

  // ───────────────────────────── fit (plan P34 L3-fix rule 1) ─────────────────────────────

  /** @returns {number} ball i's largest outer radius about its centre, m, read from the built meshes (0 for a missing station) */
  outerRadiusM(i) {
    const s = this._st[i];
    return s ? s.outerR : 0;
  }

  /** @private ball s's centre in the ship's frame, m, with its radiator at `thetaRad`: the chain of transforms from the ship down to the tip group, the hinge turned to that angle (no live node is touched) */
  _centreAt(s, thetaRad, out) {
    const ship = this.ship;
    _m4.identity();
    const chain = [];
    for (let o = s.tip; o && o !== ship; o = o.parent) chain.push(o);
    for (let k = chain.length - 1; k >= 0; k--) {
      const o = chain[k];
      if (o === s.hinge) {
        _eul.set(o.rotation.x, thetaRad - Math.PI / 2, o.rotation.z, o.rotation.order);   // `_writeFlowerPose`: hinge.rotation.y = theta - 90 deg
        _qa.setFromEuler(_eul);
        _mm.compose(o.position, _qa, o.scale);
      } else _mm.compose(o.position, o.quaternion, o.scale);
      _m4.multiply(_mm);
    }
    return out.copy(s.centre).multiplyScalar(M).applyMatrix4(_m4).multiplyScalar(1 / M);
  }

  /** @private one held piece placed in the ship's frame (m): its triangles at the booking `book`/`q`, with their box; a typeless piece or an in-hand catch is a ball of its reach */
  _place(piece, book, q, asBall, sweep = false) {
    const sc = DebrisField.effectiveRenderScale(piece);
    let c = _prepCache.get(piece);
    if (!c || c.sc !== sc) { c = { sc, prep: prepPiece(piece, 1e9) }; _prepCache.set(piece, c); }
    const prep = c.prep;
    const e = { piece, ball: asBall || prep.ball, reach: prep.reach, cx: book.x, cy: book.y, cz: book.z, n: prep.n, T: null, lo: null, hi: null, sweep: null };
    if (e.ball) return e;
    const T = new Float64Array(9 * prep.n);
    // a piece the melt has cut is drawn shortened (`_meltK`: the share of its mass left, along its long local axis about its centre): place it as drawn
    const kNow = piece._meltK < 1 ? Math.max(piece._meltK, MELT_K_FLOOR) : 1;
    const ax = { x: 0, y: 1, z: 2 }[DebrisField.meltAxis(piece)];
    let placed = prep;
    if (kNow < 1) {
      const S = new Float64Array(prep.tris);
      for (let i = 0; i < 9 * prep.n; i++) if ((i % 3) === ax) S[i] *= kNow;
      placed = { n: prep.n, tris: S };
    }
    placeTris(placed, T, book.x, book.y, book.z, q);
    const meltable = kNow < 1 || (piece._disposal && piece._disposal.fate === 'melt');
    if (sweep && meltable) e.sweep = { prep, ax, kNow, cx: book.x, cy: book.y, cz: book.z, q: { x: q.x, y: q.y, z: q.z, w: q.w } };
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 3 * prep.n; k++) for (let a = 0; a < 3; a++) { const v = T[3 * k + a]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; }
    e.T = T; e.lo = lo; e.hi = hi;
    return e;
  }

  /**
   * @private every held piece placed in the ship's frame, at every strut angle its daughter can have while a ball is open. Modes:
   * `'legacy'`: each rack piece (the chain the radiator clearance reads, `heldCargoBookingMeters`) at her strut angle now, her hold pose, and
   * her radiator-lift pose (`_radClearPose`: she lifts the catch while the radiators are in the band, then goes back to the hold pose), and
   * every PLACE_STEP_DEG between the lowest and the highest of those three (she slews between them while the radiators move).
   * `'lift'` (plan P34 L3-fix2: the trip's burn keeps her lifted, `ArmManager.setBurnLift`): a holder that has a burn-lift pose
   * (`burnLiftPoseOf`) is placed at that pose only, where she will stand while a ball is open; the others as `'legacy'`.
   * `'now'`: the same holders at the angle they stand at this frame (the ball is about to inflate, her piece is at rest).
   * A catch held in hand is a ball. Empty without an arm manager (a stub ship).
   * @param {'legacy'|'lift'|'now'} [mode]
   */
  _heldPieces(mode = 'legacy') {
    const ship = this.ship;
    const am = ship && ship.armManager;
    const out = [];
    if (!am || !Array.isArray(am.arms)) return out;
    for (let a = 0; a < am.arms.length; a++) {
      const arm = am.arms[a];
      const dp = am._dockPositions && am._dockPositions[a];
      if (!arm || arm.isDetached || !dp || typeof arm.getAimAlpha !== 'function') continue;
      const now = arm.getAimAlpha();
      if (!Number.isFinite(now)) continue;
      const rack = Array.isArray(arm.heldCatches) ? arm.heldCatches : [];
      if (rack.some((p) => p && p.mass)) {
        let lo = now, hi = now;
        const lp = mode !== 'legacy' && typeof am.burnLiftPoseOf === 'function' ? am.burnLiftPoseOf(a) : null;
        if (lp !== null) {
          const at = mode === 'now' ? now : lp;
          lo = at; hi = at;
        } else {
          const hp = typeof am._holdPoseCached === 'function' ? am._holdPoseCached(arm, a, 0) : null;
          if (hp && Number.isFinite(hp.rad)) { lo = Math.min(lo, hp.rad); hi = Math.max(hi, hp.rad); }
          const cp = typeof am._radClearPose === 'function' ? am._radClearPose(arm, a, 0) : null;
          if (cp && Number.isFinite(cp.rad)) { lo = Math.min(lo, cp.rad); hi = Math.max(hi, cp.rad); }
        }
        const steps = Math.max(1, Math.ceil((hi - lo) / degToRad(PLACE_STEP_DEG) - 1e-9));
        for (let k = 0; k <= steps; k++) {
          const alpha = lo + (hi - lo) * (k / steps);
          for (let slot = 0; slot < rack.length; slot++) {
            const piece = rack[slot];
            if (!piece || !piece.mass) continue;
            heldCargoBookingMeters(arm, dp, alpha, ship, slot, piece.sizeMeter || 0, _bookV, null, piece, _bookQ);
            out.push(this._place(piece, _bookV, _bookQ, false, mode !== 'legacy'));
          }
        }
      }
      const hand = arm.capturedDebris;
      if (hand && hand.mass && !rack.includes(hand)) {
        heldInHandBookingMeters(arm, dp, now, ship, hand.sizeMeter || 0, _bookV, _axisV);
        out.push(this._place(hand, _bookV, _bookQ, true));
      }
    }
    return out;
  }

  /** @private is placed piece `e` closer than FIT_CLEAR_M to the sphere (centre `c`, radius `r`, m)? Box prefilter, then the exact distance to every triangle. */
  _within(e, c, r) {
    const need = r + FIT_CLEAR_M;
    if (e.ball) {
      const dx = c.x - e.cx, dy = c.y - e.cy, dz = c.z - e.cz;
      const lim = need + e.reach;
      return dx * dx + dy * dy + dz * dz < lim * lim;
    }
    if (withinTris(e.T, e.n, e.lo, e.hi, c, need)) return true;
    const w = e.sweep;
    if (!w || !(w.kNow > MELT_K_FLOOR + 1e-9)) return false;
    // P34 L3-fix2 (measured: 5 of 40 seeds of a 5.2 m body): the melt draws the piece shortened along its long axis about its centre, and a
    // wider part moves into the ball's place, so a ball that clears the piece now can be inside it later: test every drawn length from now
    // down to the 2 % floor. L3-fix3: cheap first (the box of every length: a ball outside it, the usual case, costs one pass), then the
    // triangles whose own sweep reaches the ball, each walked by `_sweptNear`.
    if (!w.D) this._sweepPrep(w);
    const need2 = need * need;
    const gx = Math.max(w.lo[0] - c.x, 0, c.x - w.hi[0]), gy = Math.max(w.lo[1] - c.y, 0, c.y - w.hi[1]), gz = Math.max(w.lo[2] - c.z, 0, c.z - w.hi[2]);
    if (gx * gx + gy * gy + gz * gz >= need2) return false;
    return this._sweptNear(w, c, need);
  }

  /**
   * @private The sweep's data for a piece that is drawn shortened (or will be): placing a vertex is linear in the share left `k` along the
   * long axis, so a vertex at `k` stands at T0 + k D (T0: placed with the axis coordinate 0, D: its move for the whole length). `w.lo/hi` is
   * the box of every length from `w.kNow` down to the floor (a vertex goes along a straight line, so the box of its two ends holds it).
   */
  _sweepPrep(w) {
    const n = w.prep.n, N = 9 * n;
    const S1 = w.prep.tris;
    const S0 = new Float64Array(N);
    for (let i = 0; i < N; i++) S0[i] = (i % 3) === w.ax ? 0 : S1[i];
    const T0 = new Float64Array(N), D = new Float64Array(N);
    placeTris({ n, tris: S0 }, T0, w.cx, w.cy, w.cz, w.q);
    placeTris(w.prep, D, w.cx, w.cy, w.cz, w.q);
    for (let i = 0; i < N; i++) D[i] -= T0[i];
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < N; i++) {
      const a = i % 3;
      const v1 = T0[i] + w.kNow * D[i], v2 = T0[i] + MELT_K_FLOOR * D[i];
      const mn = v1 < v2 ? v1 : v2, mx = v1 < v2 ? v2 : v1;
      if (mn < lo[a]) lo[a] = mn;
      if (mx > hi[a]) hi[a] = mx;
    }
    w.T0 = T0; w.D = D; w.lo = lo; w.hi = hi;
  }

  /**
   * @private Does any triangle of a piece swept from `w.kNow` down to the floor come within `need` of point `c`? Per triangle: skip it when the box of
   * its two ends is `need` or more away; else walk `k` down from now to the floor, each step as long as the fastest vertex needs to cover the
   * distance still to go (`gap` = distance - need, at least SWEEP_SURFACE_STEP_M), so nothing is stepped over at a distance; at the margin's
   * edge the held margin is 15 mm at least, not 20 (see SWEEP_SURFACE_STEP_M).
   */
  _sweptNear(w, c, need) {
    const T0 = w.T0, D = w.D, n = w.prep.n, need2 = need * need;
    const kN = w.kNow;
    for (let t = 0; t < n; t++) {
      const o = 9 * t;
      let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity, vm2 = 0;
      for (let j = 0; j < 9; j += 3) {
        const dx = D[o + j], dy = D[o + j + 1], dz = D[o + j + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > vm2) vm2 = d2;
        const ax = T0[o + j] + kN * dx, ay = T0[o + j + 1] + kN * dy, az = T0[o + j + 2] + kN * dz;
        const fx = T0[o + j] + MELT_K_FLOOR * dx, fy = T0[o + j + 1] + MELT_K_FLOOR * dy, fz = T0[o + j + 2] + MELT_K_FLOOR * dz;
        if (ax < bx0) bx0 = ax; if (fx < bx0) bx0 = fx; if (ax > bx1) bx1 = ax; if (fx > bx1) bx1 = fx;
        if (ay < by0) by0 = ay; if (fy < by0) by0 = fy; if (ay > by1) by1 = ay; if (fy > by1) by1 = fy;
        if (az < bz0) bz0 = az; if (fz < bz0) bz0 = fz; if (az > bz1) bz1 = az; if (fz > bz1) bz1 = fz;
      }
      const gx = Math.max(bx0 - c.x, 0, c.x - bx1), gy = Math.max(by0 - c.y, 0, c.y - by1), gz = Math.max(bz0 - c.z, 0, c.z - bz1);
      if (gx * gx + gy * gy + gz * gz >= need2 || !(vm2 > 1e-12)) continue;      // out of reach at every length (or a triangle that does not move: tested at `kNow`)
      const vmax = Math.sqrt(vm2);
      let k = kN;
      for (;;) {
        for (let j = 0; j < 9; j++) _tri9[j] = T0[o + j] + k * D[o + j];
        const dist = Math.sqrt(ptTri2(c.x, c.y, c.z, _tri9, 0));
        if (dist < need) return true;
        if (k <= MELT_K_FLOOR) break;
        k -= Math.max(dist - need, SWEEP_SURFACE_STEP_M) / vmax;
        if (k < MELT_K_FLOOR) k = MELT_K_FLOOR;
      }
    }
    return false;
  }


  /**
   * The held piece in ball i's way with its radiator at `thetaRad`: the first one whose surface comes within FIT_CLEAR_M (20 mm) of the
   * ball's whole envelope (largest outer radius, 1.0115 m: film, ring and sleeve), by the exact distance to its triangles after a box
   * prefilter, or whose inside holds the ball's centre. Null when none does, and for a missing station or a ship with no arm manager.
   * @param {number} i tip index @param {number} thetaRad radiator angle
   * @param {boolean} [lifted] place a holder that has a burn-lift pose at that pose (the planning question: the trip will raise her); default: only while the burn lift is on
   * @returns {object|null} the piece (debris object)
   */
  blocker(i, thetaRad, lifted = false) {
    return this.blockerAcross(i, thetaRad, thetaRad, false, lifted);
  }

  /** @returns {boolean} no held piece is in ball i's way with its radiator at `thetaRad` (see `blocker`) */
  fits(i, thetaRad, lifted = false) {
    return this.blocker(i, thetaRad, lifted) === null;
  }

  /** @private the placement mode for a question: 'lift' when asked as lifted or the burn lift is on, else 'legacy' */
  _modeFor(lifted) {
    const am = this.ship && this.ship.armManager;
    return lifted || (am && typeof am.burnLiftOn === 'function' && am.burnLiftOn()) ? 'lift' : 'legacy';
  }

  /**
   * The held piece in the way of ball i at some radiator angle from `fromRad` to `toRad`, tested every SWEEP_STEP_DEG. Both ends are
   * clamped into the ball's band when `clamp` is true (the default): below 88 deg no ball is up. A ball inflates only with its radiator at
   * rest (`update`), so the trip asks for the rest angle (`from` = `to`); a sweep is for a caller that wants every angle in between.
   * @param {boolean} [lifted] see `blocker`
   * @param {'legacy'|'lift'|'now'} [mode] overrides the placement mode (the inflate check places her where she stands)
   * @returns {object|null}
   */
  blockerAcross(i, fromRad, toRad, clamp = true, lifted = false, mode = null) {
    const s = this._st[i];
    if (!s) return null;
    const pieces = this._heldPieces(mode || this._modeFor(lifted));
    if (!pieces.length) return null;
    const C = Constants.SUN_OVEN_BALL;
    let a = Math.min(fromRad, toRad), b = Math.max(fromRad, toRad);
    if (clamp) { a = Math.min(Math.max(a, degToRad(C.MIN_DEG)), degToRad(C.TOP_DEG)); b = Math.min(Math.max(b, degToRad(C.MIN_DEG)), degToRad(C.TOP_DEG)); }
    const steps = Math.max(1, Math.ceil((b - a) / degToRad(SWEEP_STEP_DEG) - 1e-9));
    const c = _vg;
    for (let k = 0; k <= steps; k++) {
      this._centreAt(s, a + (b - a) * (k / steps), c);
      for (const e of pieces) if (this._within(e, c, s.outerR)) return e.piece;
    }
    return null;
  }

  /**
   * @private does ball s fit where its radiator will come to rest (the target; the angle it stands at when it is not moving)? A ball opens
   * only at rest (plan P34 L3-fix2), so no angle in between counts. `atInflate`: her piece stands where it is now (mode 'now'), else where
   * the burn lift will hold it. True when the rest angle is outside the band (asked again when it is in).
   */
  _opensHere(s, atInflate = false) {
    const C = Constants.SUN_OVEN_BALL;
    const rest = this._targetOf(s);
    if (!Number.isFinite(rest)) return true;
    if (rest < degToRad(C.MIN_DEG) - BAND_EPS_RAD || rest > degToRad(C.TOP_DEG) + BAND_EPS_RAD) return true;
    let mode = null;
    if (atInflate) mode = this._modeFor(false) === 'lift' ? 'now' : 'legacy';
    return this.blockerAcross(s.i, rest, rest, false, false, mode) === null;
  }

  /**
   * How many balls the steering tank can inflate now, 0..4 (the tank minus the reserve a spinning cold-gas turn keeps, in whole inflates of
   * N2_KG_PER_INFLATE). `_tryInflate` bills one at a time with the same test.
   * @returns {number}
   */
  inflatesAffordable() {
    const C = Constants.SUN_OVEN_BALL;
    const ship = this.ship;
    const want = coldGasKgToPool(C.N2_KG_PER_INFLATE);
    if (!(want > 0)) return 4;
    let pool = typeof ship._nonTurnPoolBudget === 'function' ? ship._nonTurnPoolBudget(want * 4) : want * 4;
    const tank = Number(ship.resources && ship.resources.coldGas);
    if (Number.isFinite(tank)) pool = Math.min(pool, tank);
    return Math.max(0, Math.min(4, Math.floor((pool + 1e-12) / want)));
  }

  // ───────────────────────────── the 88 deg gate ─────────────────────────────

  /**
   * The floor and cap the SHARED radiator angle must keep: the band of every ball that is not stowed on a radiator that
   * follows the shared angle (a petal on its own hold is gated by `limitsFor`). Neutral (-/+Infinity) when nothing is up.
   * @param {ReadonlyArray<{az:number}>} holds the ship's `_petalHolds`
   */
  sharedGate(holds) {
    let any = false;
    for (const s of this._st) {
      if (!s || s.state === 'stowed') continue;
      let held = false;
      if (holds) for (let h = 0; h < holds.length; h++) if (holds[h].az === s.az) { held = true; break; }
      if (!held) { any = true; break; }
    }
    return any ? { floorRad: degToRad(Constants.SUN_OVEN_BALL.MIN_DEG), ceilRad: degToRad(Constants.SUN_OVEN_BALL.TOP_DEG) } : NEUTRAL_GATE;
  }

  /** The floor and cap for the petal at azimuth `az` (its own ball); neutral when that ball is stowed or missing. */
  limitsFor(az) {
    for (const s of this._st) {
      if (s && s.az === az && s.state !== 'stowed') {
        return { floorRad: degToRad(Constants.SUN_OVEN_BALL.MIN_DEG), ceilRad: degToRad(Constants.SUN_OVEN_BALL.TOP_DEG) };
      }
    }
    return NEUTRAL_GATE;
  }

  // ───────────────────────────── per-frame ─────────────────────────────

  /** @private the angle band test of the 88 deg rule (rad) */
  _inBand(rad) {
    const C = Constants.SUN_OVEN_BALL;
    return rad >= degToRad(C.MIN_DEG) - BAND_EPS_RAD && rad <= degToRad(C.TOP_DEG) + BAND_EPS_RAD;
  }

  /** @private where ball s's radiator is heading (rad): a held petal's hold, else the shared target, else where it sits */
  _targetOf(s) {
    const ship = this.ship;
    const shared = ship._flowerTargetTheta !== undefined ? ship._flowerTargetTheta : ship._flowerThetaRad;
    const holds = ship._petalHolds;
    if (holds) for (let h = 0; h < holds.length; h++) if (holds[h].az === s.az) return holds[h].releasing ? shared : holds[h].targetRad;
    return shared;
  }

  /**
   * @private plan P34 L3-fix2: has ball s's radiator come to rest (it stands at its target, so no sweep is running)? A shared radiator
   * clears its target on arrival; a held petal's own target is within the drive's settle band of it when it has arrived.
   */
  _atRest(s, theta) {
    const tgt = this._targetOf(s);
    if (!Number.isFinite(tgt) || !Number.isFinite(theta)) return true;
    const holds = this.ship._petalHolds;
    let held = false;
    if (holds) for (let h = 0; h < holds.length; h++) if (holds[h].az === s.az) { held = true; break; }
    return Math.abs(tgt - theta) < (held ? Constants.THERMAL.FLOWER.SETTLE_EPS_RAD : 1e-6);
  }

  /** @private plan P34 L3-fix2: every holder the burn lifts stands at her lift pose (`ArmManager.burnLiftSettled`); true with no arm manager (a stub ship) */
  _holdersSettled() {
    const am = this.ship && this.ship.armManager;
    return !am || typeof am.burnLiftSettled !== 'function' || am.burnLiftSettled();
  }

  /** @private */
  _beginFold(s) {
    s.kFold = s.k;
    s.t = 0;
    s.state = 'folding';
  }

  /**
   * Advance every ball by `dt` real seconds. Reads from the ship: `petalThetaRad(az)`, `_flowerThetaRad`,
   * `_flowerTargetTheta`, `_petalHolds`, `_sunDirWorld`, `_inShadow`, `quaternion`, `resources.coldGas` and
   * `_nonTurnPoolBudget`. Runs before the radiator driver, so the driver sees this frame's states; the pointing is `aim()`, after it.
   * @param {number} dt real seconds
   * @param {number} [gameDt] game seconds of the frame (the lid and the plate swing on the world clock: the eclipse is game time); a missing value is `dt`
   */
  update(dt, gameDt) {
    const C = Constants.SUN_OVEN_BALL;
    const ship = this.ship;
    const step = dt > 0 ? dt : 0;
    const g = gameDt > 0 ? gameDt : (gameDt === undefined || gameDt === null ? step : 0);
    for (const s of this._st) {
      if (!s) continue;
      const theta = typeof ship.petalThetaRad === 'function' ? ship.petalThetaRad(s.az) : ship._flowerThetaRad;
      const ok = this._inBand(theta) && this._inBand(this._targetOf(s));
      if (s.state === 'stowed' && s.want && ok && this._atRest(s, theta) && this._holdersSettled()) this._tryInflate(s);
      if (s.state === 'inflating') {
        if (!ok || !s.want) this._beginFold(s);
        else {
          s.t += step;
          if (s.t >= C.INFLATE_S) { s.t = C.INFLATE_S; s.state = 'up'; this._setK(s, 1); } else this._setK(s, smoothstep01(s.t / C.INFLATE_S));
        }
      } else if (s.state === 'up' && (!ok || !s.want)) this._beginFold(s);
      if (s.state === 'folding') {
        const total = Math.max(1e-6, C.FOLD_S * s.kFold);
        s.t += step;
        if (s.t >= total) { s.state = 'stowed'; s.t = 0; this._setK(s, 0); } else this._setK(s, s.kFold * (1 - smoothstep01(s.t / total)));
      }
      this._stepTools(s, g);
    }
  }

  /**
   * The area the inflated balls add to her drag (Ruling 0: a 2 m film sphere in the air is real area), m2: the sum of pi r^2 over every
   * ball that is not stowed (inflating, up, folding), r = DIAMETER_M / 2 times its growth `k`. A sphere shows pi r^2 from every direction,
   * so no velocity direction is needed. Added by `PlayerSatellite.dragAreaM2`; four full balls add 4 pi = 12.57 m2.
   * @returns {number} m2
   */
  dragAreaM2() {
    const R = Constants.SUN_OVEN_BALL.DIAMETER_M / 2;
    let a = 0;
    for (const s of this._st) if (s && s.state !== 'stowed') { const r = R * s.k; a += Math.PI * r * r; }
    return a;
  }

  /**
   * D2 pointing for every ball that is not stowed. Called AFTER the radiator driver has moved the radiators this frame (the
   * aim reads the tip group's chain of rotations: run before it, the ball would point where its radiator WAS, 0.245 deg off
   * at 15 deg/s), while `update` stays before the driver (the 88 deg gate reads the states it sets).
   */
  aim() {
    for (const s of this._st) if (s && s.state !== 'stowed') this._aim(s);
  }

  /** @private try to start inflating a stowed ball: needs the steering gas; one comms line when the tank cannot pay */
  _tryInflate(s) {
    const C = Constants.SUN_OVEN_BALL;
    const ship = this.ship;
    const want = coldGasKgToPool(C.N2_KG_PER_INFLATE);
    const budget = typeof ship._nonTurnPoolBudget === 'function' ? ship._nonTurnPoolBudget(want) : want;
    const tank = Number(ship.resources && ship.resources.coldGas);
    const paid = budget >= want - 1e-12 && (!Number.isFinite(tank) || tank >= want - 1e-12);
    if (paid && !this._opensHere(s, true)) { s.want = false; return; }       // a held piece is in the way where she stands: stays stowed, no gas billed (the trip says why)
    if (!paid) {
      if (!s.gasWarned) {
        s.gasWarned = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'THERMAL',
          text: 'Steering tank empty: the sun ovens cannot inflate.',
          priority: 'warning',
          _reactive: true,
        });
      }
      return;
    }
    eventBus.emit(Events.RESOURCE_CONSUME, { resource: 'coldGas', amount: want });
    s.gasWarned = false;
    s.state = 'inflating';
    s.t = 0;
    this._setK(s, 0);
    this._aim(s, true);
  }

  /** @private growth: radius R*k about the point of the final sphere nearest the canister (every partial ball lies inside the final one) */
  _setK(s, k) {
    s.k = k;
    if (!(k > 0)) { s.ball.visible = false; return; }
    const kk = Math.max(k, 1e-3);                                      // never scale 0 (breaks keep-out maths)
    s.ball.visible = true;
    s.ball.scale.setScalar(kk);
    _va.copy(s.centre).sub(s.anchor).multiplyScalar(kk).add(s.anchor).multiplyScalar(M);
    s.ball.position.copy(_va);
  }

  /**
   * @private D2: turn the ball about its own centre so the mirror axis points away from the sun. Ring azimuth about d: the
   * pole axis is d x sun (kept when that is within 1 deg of parallel); then the ball tilts about the pole axis. Held while
   * the ship is in Earth's shadow, and when there is no sun direction.
   */
  _aim(s, force = false) {
    const ship = this.ship;
    if (!force && ship._inShadow && s.aimed) return;
    const sun = ship._sunDirWorld;
    if (!sun) return;
    // sun in the tip group's frame: the chain of quaternions from the ship down to the tip
    _qa.identity();
    for (let o = s.tip; o && o !== ship; o = o.parent) _qa.premultiply(o.quaternion);
    if (ship.quaternion) _qa.premultiply(ship.quaternion);
    _qa.invert();
    const sl = _va.copy(sun).applyQuaternion(_qa).normalize();
    const at = _vb.copy(sl).negate();                                  // wanted mirror axis (tip-local)
    _vc.crossVectors(s.d, sl);
    if (_vc.length() > PARALLEL_SIN) s.azimuth = signedAngle(s.p0, _vc.normalize(), s.d);
    _qb.setFromAxisAngle(s.d, s.azimuth);                              // ring azimuth about d
    const p = _vc.copy(s.p0).applyQuaternion(_qb);                     // the ring's pole axis now
    const base = _vd.copy(s.a0).applyQuaternion(_qb);                  // mirror axis at zero tilt
    const psi = signedAngle(base, at, p);
    s.ring.quaternion.copy(_qb).multiply(s.qRing0);
    _qc.setFromAxisAngle(p, psi);
    s.rot.quaternion.copy(_qc).multiply(_qb).multiply(s.qBase);
    s.aimed = true;
  }
}
