/**
 * SeatHullClear.js - "a seated big piece never touches the mother".
 *
 * The snug seat (ArmUnit `seatStandoffM`) puts a piece 2.7 cm off HER end, 0.1-1.5 m nearer than the old support rule,
 * and only knows her own mesh. A 3-5.5 m piece can then reach back over the mother at some of the strut angles the hold
 * planner may pick (the 5 degree grid 34 ... 99 and 100: `_holdPoseOf`, `holdPoseGridDeg`): a 5 m dead satellite touched
 * hull, solar wings or a neighbour strut in 2-3 of 30 attitudes at the 100 degree cap and in 1-15 of 30 at the 34 degree
 * duck fallback (measured); the old layout was at least 666 mm clear.
 *
 * The rule: when a piece over `SEAT_HULL.OVER_M` is seated, its SEATED mesh is placed at every grid angle (the same
 * placement chain as the radiator check, `heldCargoBookingMeters`) and measured against the hull, the nose ring, the
 * solar wings and the other three struts. If it comes within `CLEAR_M + SAMPLE_MARGIN_M` anywhere, the piece keeps the
 * support-rule distance for as long as that memo (its attitude on her) stands. One exact verdict per solve (it rides on
 * the seat memo, `d._seatMemo.hull`), never per frame.
 *
 * What it measures against (ship frame, from the live ship once, then reposed by RIGID moves of the parts that move):
 *   - hull, nose ring, launch cradles excluded (radiators are `HoldWingClear`'s): the drawn triangles, exact;
 *   - the two solar wings always fully rolled out (the verdict stands while the piece is held and the player can roll
 *     them out any time), at the sun-tracking tilt's limits, half way and level (`SEAT_HULL.WING_TILT_SAMPLES` x the
 *     ship's max tilt);
 *   - the other three struts (everything under their pivots) at `STRUT_POSES_DEG`;
 *   - her own strut is not measured here (analytic tube, test-DaughterSeatRingBig3/4); the radiators are the wing profile's;
 *   - the other three daughters docked at their strut tips at the same angles (their solid triangles, `buildSeatGeo`).
 * Not covered (named in DECISIONS section 28 row 5): wings feathered edge-on, a neighbour's strut at an angle between
 * the sampled poses, a second piece in cell 1, the seat of a piece held in hand away from the dock.
 *
 * Needs a real ship (`strutGroups`) and the dock position the manager stored on the arm; anything else answers "clear"
 * (a bare test arm).
 * @module systems/SeatHullClear
 */
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { heldCargoBookingMeters, strutTipMeters } from './CoMCalculator.js';
import { strutLocalDirection, composeDockedArmQuat } from '../entities/ArmDockBasis.js';
import { buildSeatGeo } from '../entities/ArmUnit.js';
import { DebrisField } from '../entities/DebrisField.js';
import { DebrisWireframe } from '../ui/DebrisWireframe.js';
import { workDone, workReset, holdPoseGridDeg, gridNew, gridStep, gridMinD2, prepPiece, trisRun, placeTris, isFxLike } from './HoldWingClear.js';
import { DEG2RAD, clamp01 } from '../core/MathUtil.js';

const M = Constants.SCENE_UNITS_PER_METER;
const POSES = holdPoseGridDeg();
const _from = new THREE.Vector3(0, -1, 0);

/** Counters for probes and tests. */
export const seatHullStats = { checks: 0, kitBuilds: 0, armGrids: 0, worstMs: 0, lastMs: 0, points: 0, worstPoints: 0 };

/** Ship-frame matrix (scene units) of an object's PARENT chain up to (not including) the ship. */
function parentChainInto(o, ship, out) {
  out.identity();
  for (let p = o.parent; p && p !== ship; p = p.parent) { p.updateMatrix(); out.premultiply(p.matrix); }
  return out;
}

/** Flat triangles (scene units, ship frame, LIVE pose) of one mesh. */
function meshTrisInto(o, ship, out) {
  const geo = o.geometry, pos = geo.getAttribute('position');
  const idx = geo.index;
  const m = new THREE.Matrix4();
  for (let p = o; p && p !== ship; p = p.parent) { p.updateMatrix(); m.premultiply(p.matrix); }
  const e = m.elements;
  const n = Math.floor((idx ? idx.count : pos.count) / 3);
  for (let i = 0; i < n * 3; i++) {
    const k = idx ? idx.getX(i) : i;
    const x = pos.getX(k), y = pos.getY(k), z = pos.getZ(k);
    out.push(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
  }
}

/** The rigid move (scene units) that takes a part's triangles from the pivot's LIVE pose to `newQuat` at the same position: PC * T R' S * (T R S)^-1 * PC^-1. */
function relativeMove(pivot, ship, newQuat) {
  const PC = parentChainInto(pivot, ship, new THREE.Matrix4());
  pivot.updateMatrix();
  const oldM = PC.clone().multiply(pivot.matrix);
  const newM = PC.clone().multiply(new THREE.Matrix4().compose(pivot.position, newQuat, pivot.scale));
  return newM.multiply(oldM.invert());
}

function appendMoved(dst, live, mv) {
  const e = mv ? mv.elements : null;
  const inv = 1 / M;
  for (let i = 0; i < live.length; i += 3) {
    const x = live[i], y = live[i + 1], z = live[i + 2];
    if (e) dst.push((e[0] * x + e[4] * y + e[8] * z + e[12]) * inv, (e[1] * x + e[5] * y + e[9] * z + e[13]) * inv, (e[2] * x + e[6] * y + e[10] * z + e[14]) * inv);
    else dst.push(x * inv, y * inv, z * inv);
  }
}

function gridOf(tris) {
  const T = new Float32Array(tris.length);                 // (a plain loop: Float32Array.from over 300k numbers is 5 times slower)
  for (let i = 0; i < T.length; i++) T[i] = tris[i];
  const g = gridNew(T, T.length / 9, Constants.SEAT_HULL.CELL_M);
  gridStep(g, 1e12);
  return g;
}

/** The kit signature: what changes the static obstacles (the number of struts). The wings are always measured rolled out (see `withWingsOut`). */
function kitSigOf(ship) {
  return `${ship.strutGroups.length}`;
}

/**
 * Runs `fn` with both solar wings fully rolled out, then puts each wing back exactly as it was. The player can roll the
 * wings out at any time and the rolled-up shape lies inside the rolled-out one (31 of 240 configs passed rolled up and
 * failed rolled out).
 */
function withWingsOut(ship, fn) {
  const wraps = [ship._rosaPanelWrapper1, ship._rosaPanelWrapper2];
  const saved = wraps.map((w) => (w ? w.scale.x : 1));
  const canSet = typeof ship._setRosaWingProgress === 'function';
  try {
    if (canSet) { ship._setRosaWingProgress(1, 1); ship._setRosaWingProgress(2, 1); }
    return fn();
  } finally {
    if (canSet) {
      wraps.forEach((w, k) => { if (w) ship._setRosaWingProgress(k + 1, clamp01((saved[k] - 0.05) / 0.95)); });
      wraps.forEach((w, k) => { if (w) w.scale.x = saved[k]; });
    }
  }
}

function buildKit(ship, arms) {
  return withWingsOut(ship, () => buildKitNow(ship, arms));
}

function buildKitNow(ship, arms) {
  const SH = Constants.SEAT_HULL;
  const strutPivots = ship.strutGroups.map((g) => g.pivotGroup);
  const wingPivots = [ship.panelRightPivot, ship.panelLeftPivot].filter(Boolean);
  const stat = [], wingLive = wingPivots.map(() => []), strutLive = strutPivots.map(() => []);
  ship.traverse((o) => {
    if (!o.isMesh || !o.visible || !o.geometry || !o.geometry.getAttribute('position') || isFxLike(o)) return;
    let vis = true;
    for (let p = o.parent; p && p !== ship; p = p.parent) if (!p.visible) { vis = false; break; }
    if (!vis) return;
    const path = [];
    let wi = -1, si = -1;
    for (let p = o; p && p !== ship; p = p.parent) {
      path.push(p.name || '');
      if (wi < 0) wi = wingPivots.indexOf(p);
      if (si < 0) si = strutPivots.indexOf(p);
    }
    const full = path.join('<');
    if (/^(FlowerStrut|MountBolt_Flower)/.test(o.name || '') || /FlowerStrutPivot_/.test(full)) return;      // radiators: HoldWingClear's
    if (si >= 0) meshTrisInto(o, ship, strutLive[si]);
    else if (wi >= 0) meshTrisInto(o, ship, wingLive[wi]);
    else meshTrisInto(o, ship, stat);
  });
  const common = [];
  appendMoved(common, stat, null);
  const maxTilt = typeof ship._rosaMaxTiltRad === 'function' ? ship._rosaMaxTiltRad() : 30 * DEG2RAD;
  const eul = new THREE.Euler(), qn = new THREE.Quaternion();
  wingPivots.forEach((pv, k) => {
    for (const f of SH.WING_TILT_SAMPLES) {
      eul.copy(pv.rotation); eul.x = f * maxTilt;
      appendMoved(common, wingLive[k], relativeMove(pv, ship, qn.setFromEuler(eul)));
    }
  });
  // each strut's triangles at the sampled angles (ship frame, metres), kept per strut: an arm's grid is the other three
  const strutAt = strutPivots.map((pv, j) => {
    const out = [];
    for (const deg of SH.STRUT_POSES_DEG) {
      strutLocalDirection(deg * DEG2RAD, ship.strutGroups[j].azRad, _dirTmp);
      appendMoved(out, strutLive[j], relativeMove(pv, ship, qn.setFromUnitVectors(_from, _dirTmp)));
      appendDaughter(out, ship, j, deg * DEG2RAD, arms);
    }
    return out;
  });
  seatHullStats.kitBuilds++;
  return { sig: kitSigOf(ship), common: gridOf(common), strutAt, armGrid: new Map() };
}
const _dirTmp = new THREE.Vector3();
const _dq = new THREE.Quaternion(), _dv = new THREE.Vector3();

/** Daughter `j` docked on her strut at angle `alpha`: her solid triangles (her frame) placed by the docked basis at the strut tip, ship frame, metres. */
function appendDaughter(out, ship, j, alpha, arms) {
  const nb = (arms || (ship.armManager && ship.armManager.arms) || [])[j];
  const dp = nb && nb._dockPos;
  const geo = nb && nb.mesh ? buildSeatGeo(nb.mesh) : null;
  if (!geo || !dp) return;
  const tip = strutTipMeters(dp, alpha);
  const az = Number.isFinite(dp.azimuthDeg) ? dp.azimuthDeg * DEG2RAD : ship.strutGroups[j].azRad;
  strutLocalDirection(alpha, az, _dirTmp);
  composeDockedArmQuat(_dirTmp, az, _dq);
  const T = geo.tris;
  for (let i = 0; i < geo.nTri * 3; i++) {
    _dv.set(T[i * 3], T[i * 3 + 1], T[i * 3 + 2]).applyQuaternion(_dq);
    out.push(_dv.x + tip.x, _dv.y + tip.y, _dv.z + tip.z);
  }
}

function kitFor(ship, arms) {
  if (!ship || !Array.isArray(ship.strutGroups) || ship.strutGroups.length === 0 || typeof ship.traverse !== 'function') return null;
  let k = ship._seatHullKit;
  if (k && k.sig === kitSigOf(ship)) return k;
  k = ship._seatHullKit = buildKit(ship, arms);
  return k;
}

/**
 * Build the obstacle set when the arms are set up, so the first big catch does not pay for it (about 90 ms on the carry
 * world's ship, once; each daughter's own grid of the other three struts, 20 ms, stays lazy: building all four here
 * doubled the cost for every test that sets up a real ship). A ship without struts, or a bare test ship, does nothing.
 * @param {object} ship the player satellite
 * @param {object[]} arms the manager's arms (ArmUnit, `_dockPos` and `mesh` set)
 */
export function seatHullPrime(ship, arms) {
  kitFor(ship, arms);
}

function armGridFor(kit, i) {
  let g = kit.armGrid.get(i);
  if (!g) {
    const tris = [];
    for (let j = 0; j < kit.strutAt.length; j++) if (j !== i) for (const v of kit.strutAt[j]) tris.push(v);
    g = gridOf(tris);
    kit.armGrid.set(i, g);
    seatHullStats.armGrids++;
  }
  return g;
}

const _preps = new Map();
/** The piece's drawn triangles in its own frame (m), cut once to `HOLD_CLEAR.SPLIT_M`; cached by shape and drawn scale. */
function prepFor(d) {
  const key = `${d.type}|${d.id}|${DebrisField.effectiveRenderScale(d)}`;
  let p = _preps.get(key);
  if (!p) {
    const geo = DebrisWireframe.getGeometry(d.type, d.id);
    if (!geo) return null;
    p = prepPiece(d, Constants.HOLD_CLEAR.SPLIT_M);
    p.buf = p.ball ? null : new Float64Array(9 * p.n);
    p.st = p.ball ? null : { t: 0, sp: 0, q: 0, S: new Float64Array(9 * 96) };
    _preps.set(key, p);
  }
  return p;
}

const _proxy = { _rackCell: 0, _rackLocalM: new THREE.Vector3(), _qLocalHer: new THREE.Quaternion() };
const _book = { x: 0, y: 0, z: 0 };
const _poseQ = new THREE.Quaternion();

/**
 * Is the piece, seated at `zM` on her axis in the attitude `q` (her frame), clear of the hull, nose ring, solar wings and the other struts at every
 * hold-pose grid angle? `true` also when there is nothing to measure against (no ship, a bag, a piece with no mesh).
 * @param {object} arm an ArmUnit set up by ArmManager (`_playerSatellite`, `_dockPos`, `index`)
 * @param {object} d the piece
 * @param {{x:number,y:number,z:number,w:number}} q the attitude the seat was solved for (her frame)
 * @param {number} zM the seat's distance from her centre along her +Z (m)
 * @returns {boolean}
 */
export function seatHullClear(arm, d, q, zM) {
  const ship = arm && arm._playerSatellite, dp = arm && arm._dockPos;
  if (!ship || !dp || !d || d.isBag === true || !d.type) return true;
  const kit = kitFor(ship, null);
  if (!kit) return true;
  const prep = prepFor(d);
  if (!prep || prep.ball) return true;
  const SH = Constants.SEAT_HULL, HC = Constants.HOLD_CLEAR;
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const clearM = SH.CLEAR_M + SH.SAMPLE_MARGIN_M;
  const grids = [kit.common, armGridFor(kit, arm.index)];
  const w0 = workDone();                                   // the queries below count in `seatHullStats`, not in the wing profile's frame budget
  _proxy._rackLocalM.set(0, 0, zM);
  _proxy._qLocalHer.set(q.x, q.y, q.z, q.w);
  let ok = true;
  for (let k = 0; k < POSES.length && ok; k++) {
    heldCargoBookingMeters(arm, dp, POSES[k] * DEG2RAD, ship, 0, d.sizeMeter || 0, _book, null, _proxy, _poseQ);
    let placed = false;
    for (const g of grids) {
      const B = prep.reach + clearM, B2 = B * B;
      if (gridMinD2(g, _book.x, _book.y, _book.z, B2, HC.BALL_CAP_POINTS) >= B2) continue;       // nothing within the piece's reach of its centre
      if (!placed) { placeTris(prep, prep.buf, _book.x, _book.y, _book.z, _poseQ); placed = true; }
      prep.st.t = 0; prep.st.sp = 0; prep.st.q = 0;
      if (trisRun(g, prep.buf, prep.n, prep.st, clearM, HC.LEAF_M, SH.MAX_QUERIES, Infinity) !== 1) { ok = false; break; }
    }
  }
  const used = workDone() - w0;
  workReset(w0);
  seatHullStats.points += used; if (used > seatHullStats.worstPoints) seatHullStats.worstPoints = used;
  const ms = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
  seatHullStats.checks++; seatHullStats.lastMs = ms;
  if (ms > seatHullStats.worstMs) seatHullStats.worstMs = ms;
  return ok;
}
