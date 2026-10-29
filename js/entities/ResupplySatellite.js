/**
 * ResupplySatellite.js - the resupply satellite's look in the world (DECISIONS §33 rows 7 and 10: "it berths the mother at her
 * nose collar, its arm swaps net cartridges, it pumps gas"). Procedural THREE geometry: box bus, two solar wings, dish, cartridge
 * rack, a robotic arm with a docking probe, and a fuel line along the arm. Its own `THREE.Group`; NEVER a child of `PlayerSatellite`
 * and NEVER one of `ActiveSatellites` (those are collision hazards: touching one ends the run).
 *
 * Driven by events (the logic is GameFlowManager's):
 *   RESUPPLY_BERTH {phase: 'berthed'}  appears ahead of her on her orbit, facing her; its arm closes on her nose collar
 *                                      (`player.getNetBerthCollarPositionInto`) over about 3 s, then stays mated in her frame.
 *                                      A second 'berthed' while mated or closing does nothing (a trip that could not go re-sends it).
 *   UPGRADE_PURCHASED {motherNetRestock | indiumCartridge}  the arm carries one cartridge from its rack (indium: from its own magazine
 *                                      behind the bus) to her net launcher face, about 4 s. Indium is already in her store at the click
 *                                      (ResourceSystem): this is only the look. Swaps run one at a time, in the order bought.
 *   RESOURCE_UPGRADED {engineGasResupply | coldGasResupply} (or `showGasFlow()`)  lights the effector coupling for about 2 s, only
 *                                      while the grip is on her ring (a swap in progress makes it wait). The fuel line is always visible.
 *   RESUPPLY_BERTH {phase: 'left'}     the arm lets go and the satellite drifts ahead, out of the near field, then hides.
 *   RESUPPLY_BERTH {phase: 'coming', playS}  approaches from far ahead over `playS` real seconds, then waits.
 *   takePiece(piece, {debrisField, onDone})  (DECISIONS §33 row 16 "hand it to a satellite"): before docking (state 'fetch') it takes each
 *                                      big piece she holds (nose one first, then each on a daughter's rack), hauls it clear over TAKE_S
 *                                      (the piece hangs on the grip, never free-flying, §1), then `onDone()` removes it; details at
 *                                      `takePiece`. With none left it docks at the empty collar. Runs on GAME time (second argument
 *                                      of `update`: zero while the world is held).
 *   game over, win, menu, a new run      hidden and reset.
 * A load while berthed emits nothing: on its first update it reads `fieldRegistry.isBerthed()` and appears already mated.
 *
 * Frames and units. Satellite-local metres: +Z toward her (it faces her), +Y up, X along the solar wings; the group's orientation is
 * her orientation turned half a turn about Y, so local +Z is her -Z. Its origin is the bus centre, `dist` metres ahead of her collar
 * along her +Z (her heading is exact prograde, CONVENTIONS Rule 8). Geometry is written in metres times `M` (scene units, 1 m = 1e-5).
 * The whole craft stays within 4 m of its origin so the near-field pass (+-10 m bracket around a root) can hold it: it joins the near
 * pass within 8.5 m of her and leaves beyond 9.5 m (as ArmManager._updateNearFieldMembership). The near pass is off on floors 4 and 5
 * and nothing else hides it, so it hides itself there (a floor getter, not the ladder object).
 *
 * Call it from the main loop AFTER player.update (it sits on her collar; CONVENTIONS Rule G).
 * @module entities/ResupplySatellite
 */
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { GameStates } from '../core/GameState.js';
import { AVIONICS_GUNMETAL, AVIONICS_DARK_OPTIC, AVIONICS_THERMAL_WHITE } from '../scene/avionicsMaterials.js';
import { getSolarCellTexture } from '../scene/solarCellTexture.js';
import { DebrisWireframe } from '../ui/DebrisWireframe.js';
import { DebrisField } from './DebrisField.js';
import { lerp } from '../core/MathUtil.js';
import { degToRad, radToDeg, clamp01, clamp, smoothstep01 } from '../core/MathUtil.js';

const M = Constants.SCENE_UNITS_PER_METER;
const RO = Constants.RENDER_ORDER;

/** The satellite entity main.js built (the last one constructed): GameFlowManager hands it a big piece to take. */
let _active = null;
export function activeResupplySatellite() { return _active; }

/** Bus centre to her nose collar when mated: the bus front face is at +0.9, the arm bridges the rest. */
export const MATED_DIST_M = 3.2;
/** Hover distance while it waits for 'berthed' after a call ('coming'): outside the near field, in sight. */
export const HOVER_DIST_M = 14;
export const COMING_START_M = 1200;
/** Distance at which it appears for a berth with no approach before it. */
export const APPEAR_DIST_M = 9;
/** Seconds the arm takes to close on the collar (the satellite glides in over the first two thirds). */
export const CLOSE_S = 3;
const GLIDE_S = 2;
/** Drift after 'left': the arm retracts for RELEASE_S (2.5 s); a steady push starts at DRIFT_START_S (1.5 s). Hidden beyond HIDE_DIST_M. */
const RELEASE_S = 2.5;  // the arm stows along a raised path (about 6 m of travel): slower than a straight pull
const DRIFT_START_S = 1.5;
const DRIFT_ACCEL = 0.8;                       // m/s^2
export const HIDE_DIST_M = 60;
/** Near-field membership (the ship's own bracket is never widened). */
export const NEAR_JOIN_M = 8.5;
export const NEAR_LEAVE_M = 9.5;
/** Seconds of a coupling show and of a cartridge swap (the timeline below sums to SWAP_S). */
export const GAS_S = 2;
export const SWAP_S = 4.2;
const SWAP_QUEUE_MAX = 8;
/** The take of a big piece, game seconds: the arm reaches the piece (TAKE_REACH_S), the jaws close (TAKE_GRIP_S), the satellite hauls
 *  it clear of her with it in the grip the whole time (TAKE_S), the piece is removed, the arm goes home (TAKE_HOME_S). */
export const TAKE_REACH_S = 1.6;
export const TAKE_GRIP_S = 0.4;
export const TAKE_S = 4;
export const TAKE_HOME_S = 1.2;
export const TAKE_WAIT_MAX_S = 60;  // a piece waiting this long (game time, no take running) for the berth to finish is let go of (taken at once)
// most game time it waits for a piece moving between holders to be seated (the nose hand-off flight is 3 s; this only ends a stuck wait)
export const TRANSIT_WAIT_MAX_S = 300;
const DEFAULT_PLAY_S = 20;

// Craft geometry, satellite-local metres.
const BUS = { x: 1.6, y: 1.2, z: 1.8 };
const WING = { len: 2.7, chord: 1.3, inner: 0.9 };            // x from 0.9 to 3.6: the whole span is 7.2 m (<= 8)
const ARM_BASE = new THREE.Vector3(0, 0.8, 0.8);
const LINK_M = 1.3;
const WRIST_M = 0.3;
const STOW_TIP = new THREE.Vector3(0, 0.85, -0.9);

/** The flight to a big piece, HER frame, metres (+Z her nose, her radiators fold out aft of z -1). Everything is measured from the
 *  drawn piece (mesh, attitude), never from a table: the grip is the drawn point farthest along the approach axis `u` (nose piece: her +Z;
 *  rack piece: +Y or -Y, its daughter's side); the hover puts the bus `STAND_OFF_M` beyond the farthest thing aboard along `u` (every
 *  held piece's bounding sphere, her radiators open: SHIP_KEEP_R_M); the arm reaches straight in from there (tip `GRIP_DIST_*` ahead of
 *  the bus centre; too far for the 2.6 m links = no take drawn, taken at once). The haul then clears the piece: a nose piece forward until
 *  0.5 m off her nose, a rack piece aft until behind her radiators' tips. */
const BUS_FRONT_M = BUS.z / 2 + 0.04;                          // the bus front face and the interface plate
const STAND_OFF_M = 0.6;                                       // bus front face to the plane through the farthest thing aboard
/** A hover pulled in: when the stand-off above puts the bus where the arm cannot reach the grip, the bus moves in along the same line,
 *  from the arm's full reach in `stepM`, to the first spot where its solids keep `STAND_OFF_M` from every piece aboard and the arm's links
 *  (shoulder to wrist joint; the wrist stub and head are the grip itself) keep `armClearM` from them, at the hover and at `poses`
 *  (fractions of the tip's way from the raised point to the grip). `bodyStepM`, `armStepM`, `haulStepM`: sample spacings; `bandM`: only
 *  pieces' points this near the arm's plane can touch it; `farM`: how far out the approach line is swept. */
const PULL = { stepM: 0.1, armClearM: 0.2, bodyStepM: 0.1, bandM: 0.6, armStepM: 0.05, farM: 60, haulStepM: 0.025, poses: [0, 0.2, 0.4, 0.6, 0.8, 0.9, 1] };
/** The satellite's parts that are the arm (swept on their own axes, never as solids). */
const SAT_ARM_PART = /^(SatArm|SatElbow|SatWrist|SatProbe|SatGasLight|SatShoulder|SatFuelLine)/;
/** Squared distance from the point (x, y, z) to the axis-aligned box `b` = [x0, x1, y0, y1, z0, z1]. */
function boxD2(x, y, z, b) {
  const dx = x < b[0] ? b[0] - x : (x > b[1] ? x - b[1] : 0);
  const dy = y < b[2] ? b[2] - y : (y > b[3] ? y - b[3] : 0);
  const dz = z < b[4] ? b[4] - z : (z > b[5] ? z - b[5] : 0);
  return dx * dx + dy * dy + dz * dz;
}
export const GRIP_DIST_MIN_M = 2.4;  // the elbow (it folds forward of the tip below this) stays on the satellite's side of the grip
export const GRIP_DIST_MAX_M = 3.5;                            // 2.6 m links + 0.3 m wrist reach 3.57 m straight ahead of the shoulder; keep 7 cm
// her radiators open: measured 2.90 m about her axis at 90 deg (hull cloud, 0-180 deg every 10); the ring route stays outside
const SHIP_KEEP_R_M = 3.0;
const SHIP_KEEP_Y_M = 2.2;  // ... and 1.97 m along +-Y at 90 deg: a rack piece's hover plane is at least this far out
const SHIP_FRONT_Z_M = 1.4;                                    // her nose: measured 1.33 m
const SAT_R_M = 3.8;                                           // the whole craft is inside this sphere about its bus centre (the wing tip is 3.66 m)
const ARC_MARGIN_M = 0.7;  // round her the bus front face stays this far outside everything aboard
const Z_FORE_M = 9.5;  // the fore station: from here a turn or sideways move is clear of her and the racks
const HAUL_MIN_M = 1.5;
const GRIP_X_MAX_M = 0.35;  // a rack piece is gripped within this of her Y-Z plane: the arm passes between the roots of her radiator petals
const FETCH_SPEED_MPS = 3;                                     // mean flight speed between hover points (one smoothstep per flight)
const FETCH_TURN_M_PER_RAD = 2;
const FETCH_LEG_MIN_S = 1.5;
const FETCH_LEG_MAX_S = 9;
const SLOT_Z = [-0.7, -0.35, 0, 0.35];  // cartridge slots on the rack (x 0); the front one is 0.2 m clear of the shoulder pedestal
const SLOT_Y = 0.72;
const CART = { r: 0.07, len: 0.22 };
/** Ion-fuel cartridges: a smaller cast-indium cartridge in a short magazine that sticks out behind the bus (the net rack is full along
 *  x 0). The same arm picks them up by the front end, same swap path. Two slots 0.32 m apart: the wrist stub trails 0.3 m behind the
 *  grip, so the cartridge behind the gripped one is never inside it. `IN_FRONT_Z` is the +z end the head grips (a pick point). */
const IN_CART = { r: 0.035, len: 0.14 };
const IN_FRONT_Z = [-1.02, -1.34];
const IN_SLOT_Z = IN_FRONT_Z.map((z) => z - IN_CART.len / 2);
/** The fuel line: radius, and its side offset from the arm's axis (the links are r 45-50 mm, so the line floats 18+ mm clear: no z-fight). */
export const GAS_LINE_R = 0.012;
export const GAS_LINE_OFFSET_M = 0.08;
const GAS_COUPLING = new THREE.Vector3(GAS_LINE_OFFSET_M, 0.74, ARM_BASE.z);
const GAS_HEAD_BACK_M = WRIST_M - 0.09;  // along the wrist from the wrist joint: the probe head's back face (the line enters there)
const GAS_COLOR = 0x33ff88;
const GAS_END_IN_M = 0.02;  // the line ends this far inside the probe head, so its flat end cap never reaches past the front face
const FLOW_FADE_S = 0.25;
const LAUNCHER_FACE_BEHIND_M = 0.028;  // her net launcher face is 30 mm behind the collar plane (z 1.27 vs 1.30); stop 2 mm short

/** Cartridge swap path (satellite-local metres, mated: the bus centre is MATED_DIST_M from the collar). The tip never goes straight
 *  through the bus: out along the collar axis, up to RAISE_Y over the rack, down onto the slot's front end, and back the same way. */
const RAISE = new THREE.Vector3(0, 1.05, 1.1);
/** The stow / dock path (arm closed 0 .. 1): up from the stowed pose to RAISE height, forward over the rack to RAISE, then down and out
 *  to the hold point. Same raised waypoints as the swap, so the head and fuel line never cross the bus, tray or cartridges. */
const STOW_RISE = new THREE.Vector3(0, RAISE.y, STOW_TIP.z);
const SWAP_HOLD = new THREE.Vector3(0, 0, MATED_DIST_M);
const SWAP_STAND = new THREE.Vector3(0, 0, MATED_DIST_M - 0.3);
const SWAP_INSERT = new THREE.Vector3(0, 0, MATED_DIST_M + LAUNCHER_FACE_BEHIND_M);
/** The legs of one swap that grips a cartridge's front end at z `frontZ`: [{ d seconds, a, b }]; durations sum to SWAP_S (4.2).
 *  The cartridge is carried from 0.9 s to 3.2 s. */
function swapLegs(frontZ) {
  const pick = new THREE.Vector3(0, SLOT_Y, frontZ);
  const above = new THREE.Vector3(0, RAISE.y, pick.z);
  const L = (d, a, b) => ({ d, a, b });
  return [
    L(0.2, SWAP_HOLD, SWAP_STAND), L(0.2, SWAP_STAND, RAISE), L(0.2, RAISE, above), L(0.2, above, pick),   // out to the slot (0.8)
    L(0.2, pick, pick),
    L(0.25, pick, above), L(0.25, above, RAISE), L(0.5, RAISE, SWAP_STAND),                                // lift and back (to 2.0)
    L(0.9, SWAP_STAND, SWAP_INSERT), L(0.3, SWAP_INSERT, SWAP_INSERT), L(1.0, SWAP_INSERT, SWAP_HOLD),
  ];
}
const SWAP_LEGS = SLOT_Z.map((sz) => swapLegs(sz + CART.len / 2));
const IN_SWAP_LEGS = IN_FRONT_Z.map((z) => swapLegs(z));

const _Z = new THREE.Vector3(0, 0, 1);
const QY_PI = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);   // her frame -> the satellite's (+Z toward her)
const smooth = (t) => { const c = clamp01(t); return smoothstep01(c); };
const _MB = new THREE.Matrix4();
/** The satellite's attitude in HER frame when it faces her axis from the direction `phi` (an angle about her Z, from her +X): +Z toward the axis,
 *  +Y aft (her -Z: the arm folds up and away from her), +X along the wings. phi = +-PI/2: above / below her. */
function qRackPhi(phi, out = new THREE.Quaternion()) {
  const zx = -Math.cos(phi), zy = -Math.sin(phi);
  return out.setFromRotationMatrix(_MB.makeBasis(new THREE.Vector3(-Math.sin(phi), Math.cos(phi), 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(zx, zy, 0)));
}

/** A cylinder along +Z from z 0 to `len` (Rule 4: Cylinder axis is Y, rotateX(PI/2) puts it on Z). Metres in, scene units out. */
function cylZ(r, len, segs = 24) {
  const g = new THREE.CylinderGeometry(r * M, r * M, len * M, segs);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, len * M / 2);
  return g;
}

/** The arm's planar two-link solution for an effector point (satellite-local metres, x = 0), elbow always up (+Y): the joints it stands in,
 *  reach clamped (links keep their length). Used for the pose (`_poseArm`) and the haul plan, so the plan sweeps the arm as drawn. */
function armJoints(tipY, tipZ, out) {
  const wy = tipY;
  const wz = tipZ - WRIST_M;
  let vy = wy - ARM_BASE.y;
  let vz = wz - ARM_BASE.z;
  let d = Math.hypot(vy, vz);
  const L = LINK_M;
  const reach = 2 * L - 1e-3;
  if (d > reach) { vy *= reach / d; vz *= reach / d; d = reach; }
  if (d < 1e-3) { vy = 0; vz = 1e-3; d = 1e-3; }
  const uy = vy / d, uz = vz / d;
  const a = d / 2;
  const h = Math.sqrt(Math.max(L * L - a * a, 0));
  let py = uz, pz = -uy;
  if (py < 0 || (py === 0 && pz < 0)) { py = -py; pz = -pz; }
  out.ey = ARM_BASE.y + uy * a + py * h;
  out.ez = ARM_BASE.z + uz * a + pz * h;
  out.wy = ARM_BASE.y + vy;                             // wrist joint, after the reach clamp
  out.wz = ARM_BASE.z + vz;
  return out;
}
const _AJ = { ey: 0, ez: 0, wy: 0, wz: 0 };

// The haul rule and the planner's measuring tools. A rack piece rests 2-70 mm from her radiator hardware and her daughters, so a haul that
// is only "aft" can pass through a petal. The planner measures instead and judges every line by ONE rule, read by the planner and by
// js/test/_satGeom.js (`haulViolations`): the distance from every sample point of the piece (`haulRulePoints`) to the EXACT triangles of
// each part (her meshes, each docked daughter's meshes, each other piece aboard: one label per mesh). A part nearer than `clearM + slackM`
// to the piece at rest is one it rests against: it may only be left (never closer than it was, less `slackM`). Every other part stays
// `clearM` off.
export const HAUL_RULE = Object.freeze({
  slackM: 0.01,           // the haul may bring the piece this much closer to a part it rests against than it was
  clearM: 0.04,           // every other part stays at least this far from every sample point of the piece
  pieceStepM: 0.05,  // the piece's drawn surface is sampled to this spacing (covering radius about 0.03 m: a crossing cannot hide between points)
  // what a part IS at rest is measured on a denser sample (covering radius about 0.014 m): at 0.05 a touching part could read 1.4 cm
  restStepM: 0.02,
  capM: 0.08,             // distances beyond this are not measured (the largest limit is 0.04)
  armClearM: 0.2,  // her parts stay this far from every arm link's axis (links r 50 mm: 0.15 m of air); a part nearer at rest is only left
  armSlackM: 0.03,        // ... (never closer to the axis than it was, less this)
});
/** The least distance (m) the rule allows a piece's point to a part, given the least it was from that part at rest (Infinity: not near).
 *  Zero or less: no limit. */
export function haulLimitM(restM) { return Math.min(restM - HAUL_RULE.slackM, HAUL_RULE.clearM); }

export const PLAN = {
  // the planner keeps this much inside the rule; the sweep steps by the slack left (never under twice this): no crossing hides between samples
  marginM: 0.001,
  minStepM: 0.002,
  nearStepM: 0.12,        // a carried point with nothing within 0.2 m of it is not looked at again for this far
  maxM: 9,
  endClearM: 0.5,         // the haul ends where nothing carried is within this of anything aboard
  alphaStepDeg: 2.5,      // directions of a rack piece: from straight aft (0) to straight out (90), in this step
  alphaMaxDeg: 90,
  noseConeDeg: 35,        // directions of a nose piece: straight ahead, then a cone about it, to this half angle ...
  noseConeStepDeg: 5,     // ... in this step, 8 azimuths each
  sliceMs: 5,  // the planner's share of one frame (it runs in slices: `update` -> `_serviceJobs`)
  maxSlices: 1e9,  // ... and at most this many slices a frame (the game: only the clock limits it; a test sets a number and `sliceMs` high)
  now: () => performance.now(),  // the planner's clock (a test swaps in a virtual one, so the frames a plan takes do not depend on machine speed)
  sliceWork: 12000,       // work units (a triangle tested = 1) between two yields
  maxTries: 3,
  clusterM: 0.25,         // the carried points are grouped in cells of this size: a group whose centre is far from everything is skipped as a whole
};
const FOLD_CMD_WAIT_S = 20;  // radiators held for a catch hand-off: the fold waits this long for the command to be accepted
const FOLD_MAX_S = 40;                             // a fold is given up (planned at the angle reached) after this
const PLAN_POSE_TOL_M = 0.005;                     // a piece planned must be where it was planned, within this, when it is handed over

/** One mutable counter for the planner's slices: every generator below adds its work and yields when it is due. */
const _work = { n: 0, at: '' };  // `at`: the planner's current stage (a probe reads where the slowest slice ended: `planStats.worstAt`)
const WORK_DUE = () => _work.n >= PLAN.sliceWork;
/** (a probe hook: `on` records the first rule break of a sweep in `hit`, with the step `s` it happened at) */
// `grip`: the last take's grip numbers; `pull`: the pulled-in hovers the last take tried; `restRun`: triangles `restAt` tested since the
// last yield; `maxRestSlice`: the largest such count of any slice
export const PLAN_DEBUG = { on: false, hit: null, fails: [], restRun: 0, maxRestSlice: 0, grip: null, pull: null };

/** The drawn piece's sample points in ITS OWN frame (metres, drawn scale): the surface to `step`, same points for planner and test. */
const _rulePts = new Map();
function* haulRuleGen(d, step = HAUL_RULE.pieceStepM) {
  const geo = d.isBag === true || !d.type ? null : DebrisWireframe.getGeometry(d.type, d.id);
  const sc = DebrisField.effectiveRenderScale(d) / M;
  const hasMesh = !!(geo && geo.getAttribute && sc > 0);
  const key = (hasMesh ? `${geo.uuid}|${sc.toFixed(7)}` : `ball|${Math.max(0.1, DebrisField.trueReachM(d, d.sizeMeter || 1)).toFixed(3)}`) + `|${step}`;
  const hit = _rulePts.get(key);
  if (hit) return hit;
  const out = [];
  const seen = new Set();
  const once = (x, y, z) => {
    const k = ((Math.round(x * 2000) + 65536) * 131072 + (Math.round(y * 2000) + 65536)) * 131072 + (Math.round(z * 2000) + 65536);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(x, y, z);
  };
  if (hasMesh) yield* sampleSurfaceGen(geo, [sc, 0, 0, 0, 0, sc, 0, 0, 0, 0, sc, 0, 0, 0, 0, 1], step, once);
  else sampleBall(0, 0, 0, Math.max(0.1, DebrisField.trueReachM(d, d.sizeMeter || 1)), 240, once);
  const pts = Float64Array.from(out);
  if (_rulePts.size > 24) _rulePts.clear();
  _rulePts.set(key, pts);
  return pts;
}
/** @returns {Float64Array} xyz triples, metres, in the piece's own frame (before its attitude); `step` is the sample spacing, m */
export function haulRulePoints(d, step = HAUL_RULE.pieceStepM) {
  const g = haulRuleGen(d, step);
  for (;;) { const r = g.next(); if (r.done) return r.value; }
}

const _rv = new THREE.Vector3();
/**
 * Fold into `restP[label]` the least distance from the piece's drawn surface to each part near it, on the DENSE sample
 * (`HAUL_RULE.restStepM`), streamed (never stored: a rocket stage is 176,000 points at 2 cm) and only where something is near (`nearAt`).
 * A piece with no drawn mesh (a ball) has none to add: its sample is already dense.
 */
function* restDenseGen(rec, fields, restP) {
  const d = rec.piece;
  const geo = d.isBag === true || !d.type ? null : DebrisWireframe.getGeometry(d.type, d.id);
  const sc = DebrisField.effectiveRenderScale(d) / M;
  if (!(geo && geo.getAttribute && sc > 0)) return;
  const q = rec.qRel, c = rec.cM;
  const emit = (x, y, z) => {
    _rv.set(x, y, z);
    if (q) _rv.applyQuaternion(q);
    const X = _rv.x + c.x, Y = _rv.y + c.y, Z = _rv.z + c.z;
    for (let f = 0; f < fields.length; f++) if (fields[f].nearAt(X, Y, Z)) fields[f].restAt(X, Y, Z, restP);
  };
  yield* sampleSurfaceGen(geo, [sc, 0, 0, 0, 0, sc, 0, 0, 0, 0, sc, 0, 0, 0, 0, 1], HAUL_RULE.restStepM, emit);
}

/** Squared distance from p to the triangle abc (Ericson, Real-Time Collision Detection 5.1.5). */
export function pointTriangleDist2(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const qx = apx - v * abx, qy = apy - v * aby, qz = apz - v * abz;
    return qx * qx + qy * qy + qz * qz;
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const qx = apx - w * acx, qy = apy - w * acy, qz = apz - w * acz;
    return qx * qx + qy * qy + qz * qz;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const qx = bpx - w * (cx - bx), qy = bpy - w * (cy - by), qz = bpz - w * (cz - bz);
    return qx * qx + qy * qy + qz * qz;
  }
  const den = 1 / (va + vb + vc);
  const v = vb * den, w = vc * den;
  const qx = apx - abx * v - acx * w, qy = apy - aby * v - acy * w, qz = apz - abz * v - acz * w;
  return qx * qx + qy * qy + qz * qz;
}

// The triangle field: every triangle of her hull, her daughters and the other pieces aboard (her frame, metres), one label per mesh, in a
// uniform grid (cell 0.1 m), each triangle listed in every cell its box, grown by `capM`, touches. A point's cell then lists every
// triangle within `capM` of it. `near2`: no triangle within 0.2 m (false); `far`: none within 0.5 m (false).
const TG = { res: 0.1, lo: [-4.2, -4.2, -5.2], n: [84, 84, 108] };
const TG_CELLS = TG.n[0] * TG.n[1] * TG.n[2];
const FG = { res: 0.25, lo: [-4.2, -4.2, -5.2], n: [34, 34, 44] };
const FG_CELLS = FG.n[0] * FG.n[1] * FG.n[2];
const WG = { res: 0.2, lo: [-4.2, -4.2, -5.2], n: [42, 42, 54] };  // the arm's grid: each triangle is listed in every cell within `armClearM` of it
const WG_CELLS = WG.n[0] * WG.n[1] * WG.n[2];
const GRID_CHUNK = 65536;
/** Scratch arrays of one pooled grid build (about 10 MB: cell lists, occupancy, dilation): made once, reused by every per-piece field. */
function newGridPool() {
  return { fine: new Int32Array(TG_CELLS + 1), wide: new Int32Array(WG_CELLS + 1), occ: new Uint8Array(TG_CELLS), a: new Uint8Array(TG_CELLS), b: new Uint8Array(TG_CELLS) };
}

class TriField {
  constructor(nTris) {
    this.T = new Float64Array(nTris * 9);
    this.L = new Int32Array(nTris);
    this.n = 0;
    this.nLabels = 0;
    this.names = [];
    this.cs = null;                             // CSR on the fine grid: cell c lists items[cs[c] .. cs[c + 1])
    this.items = null;
    this.wcs = null;
    this.witems = null;
    this.near2 = null;
    this.far = null;
  }

  wideOf(x, y, z) {
    const i = Math.floor((x - WG.lo[0]) / WG.res), j = Math.floor((y - WG.lo[1]) / WG.res), k = Math.floor((z - WG.lo[2]) / WG.res);
    if (i < 0 || j < 0 || k < 0 || i >= WG.n[0] || j >= WG.n[1] || k >= WG.n[2]) return -1;
    return (i * WG.n[1] + j) * WG.n[2] + k;
  }

  /**
   * The slack a point of the piece has under the haul rule (`HAUL_RULE`): the least over the parts near it of (its distance - the limit);
   * negative = it breaks the rule. A part within 1 cm of the piece at rest has no limit. `restL[label]`: the least distance the piece had
   * to that part at rest. Infinity when nothing here limits it. With `PLAN_DEBUG.on` the least-slack part is noted.
   */
  slack(x, y, z, restL) {
    const c = this.cellOf(x, y, z);
    if (c < 0 || this.n === 0) return Infinity;
    const T = this.T, L = this.L;
    let best = Infinity, bt = -1, bd = 0;
    for (let e = this.cs[c], e1 = this.cs[c + 1]; e < e1; e++) {
      const t = this.items[e], o = t * 9;
      const r = restL[L[t]];
      const lim = haulLimitM(r);
      if (!(lim > 0)) continue;
      _work.n++;
      const d = Math.sqrt(pointTriangleDist2(x, y, z, T[o], T[o + 1], T[o + 2], T[o + 3], T[o + 4], T[o + 5], T[o + 6], T[o + 7], T[o + 8]));
      if (d - lim < best) { best = d - lim; bt = t; bd = d; }
    }
    if (PLAN_DEBUG.on && bt >= 0) PLAN_DEBUG.hit = { arm: false, name: this.names[L[bt]], d: bd, slack: best, rest: restL[L[bt]], x, y, z };
    return best;
  }

  /** The same for a point on the axis of an arm link (wide grid, `armClearM` / `armSlackM`). */
  slackArm(x, y, z, restL) {
    const c = this.wideOf(x, y, z);
    if (c < 0 || this.n === 0) return Infinity;
    const T = this.T, L = this.L, R = HAUL_RULE;
    let best = Infinity, bt = -1, bd = 0;
    for (let e = this.wcs[c], e1 = this.wcs[c + 1]; e < e1; e++) {
      const t = this.witems[e], o = t * 9;
      const r = restL[L[t]];
      const lim = Math.min(r - R.armSlackM, R.armClearM);
      if (!(lim > 0)) continue;
      _work.n++;
      const d = Math.sqrt(pointTriangleDist2(x, y, z, T[o], T[o + 1], T[o + 2], T[o + 3], T[o + 4], T[o + 5], T[o + 6], T[o + 7], T[o + 8]));
      if (d - lim < best) { best = d - lim; bt = t; bd = d; }
    }
    if (PLAN_DEBUG.on && bt >= 0) PLAN_DEBUG.hit = { arm: true, name: this.names[L[bt]], d: bd, slack: best, rest: restL[L[bt]], x, y, z };
    return best;
  }

  /** Folds into `out[label]` the least distance (< `armClearM`) from (x, y, z) to each label's triangles (the wide grid: an arm axis point). */
  wideRestAt(x, y, z, out) {
    const c = this.wideOf(x, y, z);
    if (c < 0 || this.n === 0) return;
    const T = this.T, L = this.L, cap2 = HAUL_RULE.armClearM * HAUL_RULE.armClearM;
    for (let e = this.wcs[c], e1 = this.wcs[c + 1]; e < e1; e++) {
      const t = this.witems[e], o = t * 9;
      const d2 = pointTriangleDist2(x, y, z, T[o], T[o + 1], T[o + 2], T[o + 3], T[o + 4], T[o + 5], T[o + 6], T[o + 7], T[o + 8]);
      _work.n++;
      if (d2 < cap2) { const d = Math.sqrt(d2), l = L[t]; if (d < out[l]) out[l] = d; }
    }
  }

  cellOf(x, y, z) {
    const i = Math.floor((x - TG.lo[0]) / TG.res), j = Math.floor((y - TG.lo[1]) / TG.res), k = Math.floor((z - TG.lo[2]) / TG.res);
    if (i < 0 || j < 0 || k < 0 || i >= TG.n[0] || j >= TG.n[1] || k >= TG.n[2]) return -1;
    return (i * TG.n[1] + j) * TG.n[2] + k;
  }

  farOf(x, y, z) {
    const i = Math.floor((x - FG.lo[0]) / FG.res), j = Math.floor((y - FG.lo[1]) / FG.res), k = Math.floor((z - FG.lo[2]) / FG.res);
    if (i < 0 || j < 0 || k < 0 || i >= FG.n[0] || j >= FG.n[1] || k >= FG.n[2]) return -1;
    return (i * FG.n[1] + j) * FG.n[2] + k;
  }

  /** Something may be within 0.2 m of this point (false = nothing is). */
  nearAt(x, y, z) {
    const c = this.cellOf(x, y, z);
    return c >= 0 && this.n > 0 && this.near2[c] === 1;
  }

  /** Something may be within 0.5 m of this point (false = nothing is). */
  farAt(x, y, z) {
    const c = this.farOf(x, y, z);
    return c >= 0 && this.n > 0 && this.far[c] === 1;
  }

  /** Folds into `out[label]` the least distance (< `capM`) from (x, y, z) to each label's triangles; returns the least of all, or Infinity. */
  restAt(x, y, z, out) {
    const c = this.cellOf(x, y, z);
    if (c < 0 || this.n === 0) return Infinity;
    const T = this.T, L = this.L, cap2 = HAUL_RULE.capM * HAUL_RULE.capM;
    let best = Infinity;
    for (let e = this.cs[c], e1 = this.cs[c + 1]; e < e1; e++) {
      const t = this.items[e], o = t * 9;
      const d2 = pointTriangleDist2(x, y, z, T[o], T[o + 1], T[o + 2], T[o + 3], T[o + 4], T[o + 5], T[o + 6], T[o + 7], T[o + 8]);
      _work.n++;
      if (PLAN_DEBUG.on) PLAN_DEBUG.restRun++;
      if (d2 < cap2) { const d = Math.sqrt(d2), l = L[t]; if (d < out[l]) out[l] = d; if (d < best) best = d; }
    }
    return best;
  }
}

const _triCount = (geo) => {
  const pos = geo && geo.getAttribute ? geo.getAttribute('position') : null;
  if (!pos) return 0;
  return Math.floor((geo.index ? geo.index.count : pos.count) / 3);
};

/** Separable box dilation of a 0/1 grid (`nx` x `ny` x `nz`) by `r` cells: out = 1 where any cell within `r` (Chebyshev) is 1. Yields between
 *  planes. `tmp` ({a, b}, both `src.length`): scratch, used and returned (`a`) instead of new arrays. */
function* dilate01(src, nx, ny, nz, r, tmp = null) {
  const a = tmp ? tmp.a.fill(0) : new Uint8Array(src.length), b = tmp ? tmp.b.fill(0) : new Uint8Array(src.length);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const base = (i * ny + j) * nz;
      for (let k = 0; k < nz; k++) {
        if (src[base + k] === 0) continue;
        for (let q = Math.max(0, k - r), q1 = Math.min(nz - 1, k + r); q <= q1; q++) a[base + q] = 1;
      }
    }
    _work.n += ny * nz / 20;
    if (WORK_DUE()) { _work.n = 0; yield; }
  }
  for (let i = 0; i < nx; i++) {
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        if (a[(i * ny + j) * nz + k] === 0) continue;
        for (let q = Math.max(0, j - r), q1 = Math.min(ny - 1, j + r); q <= q1; q++) b[(i * ny + q) * nz + k] = 1;
      }
    }
    _work.n += ny * nz / 20;
    if (WORK_DUE()) { _work.n = 0; yield; }
  }
  a.fill(0);
  for (let j = 0; j < ny; j++) {
    for (let k = 0; k < nz; k++) {
      for (let i = 0; i < nx; i++) {
        if (b[(i * ny + j) * nz + k] === 0) continue;
        for (let q = Math.max(0, i - r), q1 = Math.min(nx - 1, i + r); q <= q1; q++) a[(q * ny + j) * nz + k] = 1;
      }
    }
    _work.n += nx * nz / 20;
    if (WORK_DUE()) { _work.n = 0; yield; }
  }
  return a;
}

/** The cell lists of a grid (`res` m cells from `lo`, `n` cells a side): every triangle is listed in each cell its box, grown by `cap`, touches.
 *  CSR. A generator. `csBuf` (an Int32Array of `cells + 1`, caller-owned): the row-start array is built in it, zeroed first. */
function* buildCsr(F, res, lo, n, cap, csBuf = null) {
  const T = F.T, ny = n[1], nz = n[2], cells = n[0] * ny * nz;
  const cs = csBuf ? csBuf.fill(0) : new Int32Array(cells + 1);
  const r6 = new Int32Array(6);
  const range = (t) => {
    const o = t * 9;
    for (let a = 0; a < 3; a++) {
      const x0 = Math.min(T[o + a], T[o + 3 + a], T[o + 6 + a]) - cap, x1 = Math.max(T[o + a], T[o + 3 + a], T[o + 6 + a]) + cap;
      r6[2 * a] = Math.max(0, Math.floor((x0 - lo[a]) / res));
      r6[2 * a + 1] = Math.min(n[a] - 1, Math.floor((x1 - lo[a]) / res));
    }
  };
  for (let t = 0; t < F.n; t++) {
    range(t);
    const cellsIn = (r6[1] - r6[0] + 1) * (r6[3] - r6[2] + 1) * (r6[5] - r6[4] + 1);
    for (let i = r6[0]; i <= r6[1]; i++) for (let j = r6[2]; j <= r6[3]; j++) for (let k = r6[4]; k <= r6[5]; k++) cs[(i * ny + j) * nz + k + 1]++;
    _work.n += 2 + cellsIn / 30;
    if (WORK_DUE()) { _work.n = 0; yield; }
  }
  for (let c0 = 0; c0 < cells; c0 += GRID_CHUNK) {  // the prefix sum over every cell, in chunks that yield (762,000 cells on the fine grid)
    const c1 = Math.min(cells, c0 + GRID_CHUNK);
    for (let c = c0; c < c1; c++) cs[c + 1] += cs[c];
    _work.n += (c1 - c0) / 100;
    if (WORK_DUE()) { _work.n = 0; yield; }
  }
  const items = new Int32Array(cs[cells]);
  for (let t = 0; t < F.n; t++) {  // fill with `cs` as the cursor (each cell's start moves to its end) ...
    range(t);
    const cellsIn = (r6[1] - r6[0] + 1) * (r6[3] - r6[2] + 1) * (r6[5] - r6[4] + 1);
    for (let i = r6[0]; i <= r6[1]; i++) for (let j = r6[2]; j <= r6[3]; j++) for (let k = r6[4]; k <= r6[5]; k++) items[cs[(i * ny + j) * nz + k]++] = t;
    _work.n += 3 + cellsIn / 30;
    if (WORK_DUE()) { _work.n = 0; yield; }
  }
  for (let c1 = cells - 1; c1 >= 1; c1 -= GRID_CHUNK) {  // ... then back one cell, to the starts again (cs[cells] stays the total)
    const c0 = Math.max(1, c1 - GRID_CHUNK + 1);
    for (let c = c1; c >= c0; c--) cs[c] = cs[c - 1];
    _work.n += (c1 - c0 + 1) / 100;
    if (WORK_DUE()) { _work.n = 0; yield; }
  }
  cs[0] = 0;
  return { cs, items };
}

/**
 * Build a TriField from `sources` ([{ geo, e, label, name }]: a geometry, the 16 elements of its matrix to her frame in METRES, and the part
 * it is). A generator: yields when the planner's slice is used up. Nothing is read from the scene again after the sources are listed.
 * `pool` ({fine, wide, occ, a, b}, see `newGridPool`): the grids are built in it instead of ~10 MB of new arrays (the field is then valid only
 * until the pool is used again: the per-piece field of the pieces aboard, dropped when that piece is planned; the hull field is never pooled).
 */
function* buildTriField(sources, pool = null) {
  let total = 0;
  for (const s of sources) total += _triCount(s.geo);
  const F = new TriField(total);
  for (const s of sources) { F.nLabels = Math.max(F.nLabels, s.label + 1); F.names[s.label] = s.name; }
  _work.at = 'tris';
  const T = F.T, L = F.L;
  for (const s of sources) {
    const pos = s.geo.getAttribute('position'), idx = s.geo.index ? s.geo.index.array : null, e = s.e;
    const nTri = _triCount(s.geo);
    for (let t = 0; t < nTri; t++) {
      const o = F.n * 9;
      for (let k = 0; k < 3; k++) {
        const i = idx ? idx[3 * t + k] : 3 * t + k;
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        T[o + 3 * k] = e[0] * x + e[4] * y + e[8] * z + e[12];
        T[o + 3 * k + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
        T[o + 3 * k + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      }
      const ux = T[o + 3] - T[o], uy = T[o + 4] - T[o + 1], uz = T[o + 5] - T[o + 2];
      const vx = T[o + 6] - T[o], vy = T[o + 7] - T[o + 1], vz = T[o + 8] - T[o + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      if (!(cx * cx + cy * cy + cz * cz > 1e-14)) continue;
      L[F.n++] = s.label;
      _work.n += 4;
      if (WORK_DUE()) { _work.n = 0; yield; }
    }
  }
  // the cell lists: the fine grid (a point sees every triangle within `capM`) and the wide grid (every triangle within `armClearM`: the arm's axis)
  _work.at = 'csr';
  const nx = TG.n[0], ny = TG.n[1], nz = TG.n[2];
  const fine = yield* buildCsr(F, TG.res, TG.lo, TG.n, HAUL_RULE.capM, pool ? pool.fine : null);
  F.cs = fine.cs;
  F.items = fine.items;
  const wide = yield* buildCsr(F, WG.res, WG.lo, WG.n, HAUL_RULE.armClearM, pool ? pool.wide : null);
  F.wcs = wide.cs;
  F.witems = wide.items;
  const cs = F.cs;
  _work.at = 'coarse';
  const occ = pool ? pool.occ.fill(0) : new Uint8Array(TG_CELLS);
  for (let c0 = 0; c0 < TG_CELLS; c0 += GRID_CHUNK) {
    const c1 = Math.min(TG_CELLS, c0 + GRID_CHUNK);
    for (let c = c0; c < c1; c++) if (cs[c + 1] > cs[c]) occ[c] = 1;
    _work.n += (c1 - c0) / 100;
    if (WORK_DUE()) { _work.n = 0; yield; }
  }
  F.near2 = yield* dilate01(occ, nx, ny, nz, 2, pool);
  const coarse = new Uint8Array(FG_CELLS);
  const ratio = TG.res / FG.res;
  for (let i = 0; i < nx; i++) {
    const i0 = Math.floor(i * ratio), i1 = Math.min(FG.n[0] - 1, Math.floor((i + 1) * ratio - 1e-9));
    for (let j = 0; j < ny; j++) {
      const j0 = Math.floor(j * ratio), j1 = Math.min(FG.n[1] - 1, Math.floor((j + 1) * ratio - 1e-9));
      for (let k = 0; k < nz; k++) {
        if (occ[(i * ny + j) * nz + k] === 0) continue;
        const k0 = Math.floor(k * ratio), k1 = Math.min(FG.n[2] - 1, Math.floor((k + 1) * ratio - 1e-9));
        for (let a = i0; a <= i1; a++) for (let b = j0; b <= j1; b++) for (let c = k0; c <= k1; c++) coarse[(a * FG.n[1] + b) * FG.n[2] + c] = 1;
      }
    }
    _work.n += ny * nz / 40;
    if (WORK_DUE()) { _work.n = 0; yield; }
  }
  F.far = yield* dilate01(coarse, FG.n[0], FG.n[1], FG.n[2], 2);
  return F;
}

/** Triangle-sample a geometry's surface to <= `step` m (a generator: yields when the planner's slice is used up). `e` = the 16 elements
 *  of the matrix from the geometry's frame to her frame in METRES; `emit(x, y, z)` gets every point. */
function* sampleSurfaceGen(geo, e, step, emit) {
  const pos = geo && geo.getAttribute ? geo.getAttribute('position') : null;
  if (!pos) return;
  const idx = geo.index ? geo.index.array : null;
  const nTri = (idx ? idx.length : pos.count) / 3;
  const P = new Float64Array(9);
  for (let t = 0; t < nTri; t++) {
    for (let k = 0; k < 3; k++) {
      const i = idx ? idx[3 * t + k] : 3 * t + k;
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      P[3 * k] = e[0] * x + e[4] * y + e[8] * z + e[12];
      P[3 * k + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      P[3 * k + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    const ab = Math.hypot(P[3] - P[0], P[4] - P[1], P[5] - P[2]);
    const bc = Math.hypot(P[6] - P[3], P[7] - P[4], P[8] - P[5]);
    const ca = Math.hypot(P[0] - P[6], P[1] - P[7], P[2] - P[8]);
    // from the vertex OPPOSITE the longest edge: the two edges from it are the short ones
    let A = 0, B = 3, C = 6;
    if (!(bc >= ab && bc >= ca)) { if (ca >= ab && ca >= bc) { A = 3; B = 6; C = 0; } else { A = 6; B = 0; C = 3; } }
    const ux = P[B] - P[A], uy = P[B + 1] - P[A + 1], uz = P[B + 2] - P[A + 2];
    const vx = P[C] - P[A], vy = P[C + 1] - P[A + 1], vz = P[C + 2] - P[A + 2];
    const ku = Math.max(1, Math.ceil(Math.hypot(ux, uy, uz) / step)), kv = Math.max(1, Math.ceil(Math.hypot(vx, vy, vz) / step));
    for (let i = 0; i <= ku; i++) {
      const fu = i / ku;
      for (let j = 0; j <= kv; j++) {
        const fv = j / kv;
        if (fu + fv > 1 + 1e-12) break;
        emit(P[A] + ux * fu + vx * fv, P[A + 1] + uy * fu + vy * fv, P[A + 2] + uz * fu + vz * fv);
        if (WORK_DUE()) { _work.n = 0; yield; }  // (an emit that does work: the 2 cm rest pass tests ~1,900 triangles a point inside her bore)
      }
    }
    _work.n += 4 + (ku * kv) / 2;
    if (WORK_DUE()) { _work.n = 0; yield; }
  }
}

const FX_NAME = /Plume|Glow|Halo|Sprite|Light|Puff|Beam|Cable|Laser(Beam)?$|Outline|Fairing/;
const SOLID_LIGHT = /^NavLight_(Port|Starboard)$/;
const AT_STRUT_STATES = new Set(['DOCKED', 'LAUNCHING', 'RELOADING', 'HOLDING_CATCH', 'DOCKING']);
/** Drawn effects (glow, plume, halo) are not hardware. The same rule as ShipKeepOut's. */
function isFxMesh(o) {
  const nm = o.name || '';
  if (FX_NAME.test(nm) && !SOLID_LIGHT.test(nm)) return true;
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  for (const m of mats) if (m && (m.blending === THREE.AdditiveBlending || (m.transparent === true && m.opacity < 0.2))) return true;
  return false;
}
function hiddenMaterials(o) {
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  if (mats.length === 0) return false;
  for (const m of mats) if (!m || m.visible !== false || (m.userData && m.userData.keepOutSolid)) return false;
  return true;
}

/** The sphere through `n` fibonacci points of radius `r` about (cx, cy, cz): a piece with no drawn mesh. */
function sampleBall(cx, cy, cz, r, n, emit) {
  for (let i = 0; i < n; i++) {
    const y = 1 - 2 * (i + 0.5) / n, rr = Math.sqrt(1 - y * y), ph = i * 2.399963;
    emit(cx + r * rr * Math.cos(ph), cy + r * y, cz + r * rr * Math.sin(ph));
  }
}

/** Group xyz triples in cells of `cell` m: `[{ cx, cy, cz, r, idx }]` (group centre, its reach, the numbers of its points). */
function* clusterPoints(pts, cell) {
  const map = new Map();
  const n = pts.length / 3;
  for (let i = 0; i < n; i++) {
    const k = ((Math.floor(pts[3 * i] / cell) + 512) * 1024 + (Math.floor(pts[3 * i + 1] / cell) + 512)) * 1024 + (Math.floor(pts[3 * i + 2] / cell) + 512);
    const a = map.get(k);
    if (a) a.push(i); else map.set(k, [i]);
    _work.n += 0.3;
    if (WORK_DUE()) { _work.n = 0; yield; }
  }
  const out = [];
  for (const a of map.values()) {
    let sx = 0, sy = 0, sz = 0;
    for (const i of a) { sx += pts[3 * i]; sy += pts[3 * i + 1]; sz += pts[3 * i + 2]; }
    const cx = sx / a.length, cy = sy / a.length, cz = sz / a.length;
    let r = 0;
    for (const i of a) r = Math.max(r, Math.hypot(pts[3 * i] - cx, pts[3 * i + 1] - cy, pts[3 * i + 2] - cz));
    out.push({ cx, cy, cz, r, idx: Int32Array.from(a) });
    _work.n += a.length * 0.3;
    if (WORK_DUE()) { _work.n = 0; yield; }
  }
  return out;
}

/**
 * Sweep everything carried along the line `d` (her frame) from 0 and judge it against the haul rule at every step (a generator). The piece's
 * points and the head are held to `HAUL_RULE`; the arm's axis points to the wider arm rule. A group whose centre is far from everything is
 * not looked at again until it could be near. Returns the haul length (line clear, everything carried `PLAN.endClearM` clear of everything
 * aboard, at least `HAUL_MIN_M`), or -1 when a point breaks the rule or the line never gets clear.
 */
function* sweepLine(ctx, d) {
  const { fields, pc, pa, cl, clA, restP, restA } = ctx;
  // carried points from index `nBody` on are the satellite's own solids (a pulled-in hover): held to the rule with `restB`
  const nBody = ctx.nBody === undefined ? Infinity : ctx.nBody, restB = ctx.restB;
  const mg = PLAN.marginM, minSt = PLAN.minStepM;
  const nextC = new Float64Array(cl.length), nextA = new Float64Array(clA.length);
  const nextP = new Float64Array(pc.length / 3);
  const far = (x, y, z) => { for (let f = 0; f < fields.length; f++) if (fields[f].farAt(x, y, z)) return false; return true; };
  const near = (x, y, z) => { for (let f = 0; f < fields.length; f++) if (fields[f].nearAt(x, y, z)) return true; return false; };
  const fail = (s) => { if (PLAN_DEBUG.on) PLAN_DEBUG.fails.push({ s, dir: [d.x, d.y, d.z].map((v) => +v.toFixed(2)), ...PLAN_DEBUG.hit }); return -1; };
  let s = 0;
  while (s <= PLAN.maxM + 1e-9) {
    const ox = d.x * s, oy = d.y * s, oz = d.z * s;
    let busy = false, nextMin = Infinity;
    for (let c = 0; c < cl.length; c++) {
      if (nextC[c] > s + 1e-9) { if (nextC[c] < nextMin) nextMin = nextC[c]; continue; }
      const g = cl[c];
      _work.n += 0.5;
      if (g.r < 0.4 && far(g.cx + ox, g.cy + oy, g.cz + oz)) {
        // nothing within 0.5 m of the centre: no point of the group is within 0.5 - r of anything, and the rule's largest limit is 0.04 + margin
        nextC[c] = s + Math.max(minSt, 0.5 - g.r - 0.07);
        if (nextC[c] < nextMin) nextMin = nextC[c];
        continue;
      }
      busy = true;
      let nm = Infinity;
      for (let k = 0; k < g.idx.length; k++) {
        const i = g.idx[k];
        if (nextP[i] > s + 1e-9) { if (nextP[i] < nm) nm = nextP[i]; continue; }
        const x = pc[3 * i] + ox, y = pc[3 * i + 1] + oy, z = pc[3 * i + 2] + oz;
        _work.n += 0.5;
        if (!near(x, y, z)) { nextP[i] = s + PLAN.nearStepM; if (nextP[i] < nm) nm = nextP[i]; continue; }
        let sl = Infinity;
        const rl = i >= nBody ? restB : restP;
        for (let f = 0; f < fields.length; f++) { const v = fields[f].slack(x, y, z, rl); if (v < sl) sl = v; }
        if (sl < mg) return fail(s);
        // the distance changes by at most the way moved: the point cannot break the rule within 0.9 of its slack (less the margin)
        nextP[i] = s + Math.max(minSt, 0.9 * ((Number.isFinite(sl) ? Math.min(sl, 0.2) : 0.04) - mg));
        if (nextP[i] < nm) nm = nextP[i];
        if (WORK_DUE()) { _work.n = 0; yield; }
      }
      nextC[c] = nm;
      if (nm < nextMin) nextMin = nm;
      if (WORK_DUE()) { _work.n = 0; yield; }
    }
    for (let c = 0; c < clA.length; c++) {
      if (nextA[c] > s + 1e-9) { if (nextA[c] < nextMin) nextMin = nextA[c]; continue; }
      const g = clA[c];
      if (far(g.cx + ox, g.cy + oy, g.cz + oz)) {
        nextA[c] = s + Math.max(minSt, 0.5 - g.r - HAUL_RULE.armClearM - 0.07);
        if (nextA[c] < nextMin) nextMin = nextA[c];
        continue;
      }
      busy = true;
      let sl = Infinity;
      for (let k = 0; k < g.idx.length; k++) {
        const i = g.idx[k];
        const x = pa[3 * i] + ox, y = pa[3 * i + 1] + oy, z = pa[3 * i + 2] + oz;
        for (let f = 0; f < fields.length; f++) { const v = fields[f].slackArm(x, y, z, restA); if (v < sl) sl = v; }
        if (sl < mg) return fail(s);
        if (WORK_DUE()) { _work.n = 0; yield; }
      }
      nextA[c] = s + Math.max(minSt, 0.9 * ((Number.isFinite(sl) ? Math.min(sl, 0.2) : 0) - mg));
      if (nextA[c] < nextMin) nextMin = nextA[c];
    }
    if (!busy && s >= HAUL_MIN_M - 0.1) {
      let clear = true;
      for (let i = 0; i < pc.length && clear; i += 3) clear = far(pc[i] + ox, pc[i + 1] + oy, pc[i + 2] + oz);
      for (let i = 0; i < pa.length && clear; i += 3) clear = far(pa[i] + ox, pa[i + 1] + oy, pa[i + 2] + oz);
      _work.n += (pc.length + pa.length) / 12;
      if (clear) return Math.max(HAUL_MIN_M, s + 0.1);
    }
    _work.n += (cl.length + clA.length) / 50;
    s = Number.isFinite(nextMin) ? Math.max(nextMin, s + 1e-4) : s + minSt;
    if (WORK_DUE()) { _work.n = 0; yield; }
  }
  return -1;
}

export class ResupplySatellite {
  /**
   * @param {object} [o.sceneManager] for registerNearFieldRoot / unregisterNearFieldRoot
   * @param {object} o.player the mother: `position`, `quaternion`, `getNetBerthCollarPositionInto(out)`
   * @param {object} [o.fieldRegistry] `isBerthed()`, read once on the first update (a load while berthed)
   * @param {() => (number|null)} [o.floor] the ladder floor now, or null (hidden on 4 and 5)
   */
  constructor({ scene, sceneManager = null, player, fieldRegistry = null, floor = null } = {}) {
    this.scene = scene;
    this.sceneManager = sceneManager;
    this.player = player;
    this.fieldRegistry = fieldRegistry;
    this._floor = floor;

    this.group = new THREE.Group();
    this.group.name = 'ResupplySatellite';
    this.group.visible = false;
    this._mats = [];
    this._geos = [];
    this._build();
    if (scene) scene.add(this.group);

    this._state = 'hidden';            // hidden | coming | hover | fetch | docking | mated | leaving
    this._synced = false;
    this._t = 0;
    this._dist = MATED_DIST_M;
    this._distFrom = MATED_DIST_M;
    this._armS = 0;                    // 0 stowed .. 1 closed on the collar
    this._armFrom = 0;
    this._w = 0;                       // weight of her nose frame (1) against her prograde frame (0) in the placement
    this._wFrom = 0;
    this._playS = DEFAULT_PLAY_S;
    this._speed = 0;                   // leaving: m/s ahead
    this._satId = null;
    this._altKm = null;
    this._swapQueue = [];              // the swaps waiting, in the order bought: 'net' | 'indium'
    this._swapT = -1;
    this._swapKind = 'net';
    this._swapSlot = 0;
    this._swapCount = 0;
    this._inSwapCount = 0;
    this._gasT = -1;
    this._gasPending = false;
    this._gasOn = false;               // "gas flowing" shows now (the grip is on her ring and the flow timer runs)
    this._flowI = 0;
    this._dt = 0;
    this._nearMember = false;
    this._tip = new THREE.Vector3();
    this._elbowM = new THREE.Vector3();   // elbow and wrist joints as the arm stands, satellite-local metres (the fuel line follows them)
    this._wristM = new THREE.Vector3();
    this._line = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    this._tmpA = new THREE.Vector3();
    this._tmpB = new THREE.Vector3();
    this._tmpDir = new THREE.Vector3();
    this._tmpV = new THREE.Vector3();
    this._dirNose = new THREE.Vector3();
    this._dirPro = new THREE.Vector3();
    this._qPro = new THREE.Quaternion();
    this._qBase = new THREE.Quaternion();
    this._takes = [];
    // pieces asked for as the one on her nose collar (`requestTakes` `collar`): nose or rack is the HOLDER, never the place
    this._noseSet = new WeakSet();
    this._gridPool = null;             // the planner's scratch grids for the per-piece field (`newGridPool`, made on first use) ...
    this._hullPool = null;  // ... and for the hull field, which lives for one job's plans (the next job builds its own over it)
    this._poolOff = false;             // true while a plan is driven at once (`planTakes`, `_planNow`): it builds its own grids
    this._planned = new WeakMap();
    this._take = null;                 // the take running: { rec, plan, phase: 'fly' | 'reach' | 'grip' | 'carry' | 'home' }
    this._legs = [];  // the 'fetch' flight plan: legs still to run (travel | reach | grip | haul | home | depart | wait)
    this._skipped = 0;  // takes with no plan at their turn: taken at once, never drawn (a counter for the tests)
    this._jobs = [];  // plans asked for (`requestTakes`), run in slices across the frames
    // the radiator fold of a berth with rack pieces: { prevRad, phase: 'cmd' | 'slew' | 'settled' | 'restoring', t, reachedRad }
    this._fold = null;
    this._dockGate = null;             // () => boolean: true while the collar is not free to dock at (a piece it could not take is still on it)
    this._dockGiveUp = null;  // called when it has waited `TAKE_WAIT_MAX_S` for the collar and leaves without docking (the line is the caller's)
    this._gateS = 0;
    this._noWay = false;               // test hook: no rack piece has a way out (a forced plan miss)
    this._noPull = false;  // test hook: the old hover only (no hover pulled in for a grip the default hover cannot reach)
    this._noWayCollar = false;
    this._cleared = null;              // the piece `canTake` just said yes to (consumed by `takePiece`)
    // what the planner cost (a counter for the tests); `byStage`: the worst slice (ms) by the stage it ended in
    this.planStats = { slices: 0, slicesMs: 0, worstSliceMs: 0, worstFrameMs: 0, frames: 0, over16: 0, jobs: 0, worstAt: '', slow: [], byStage: {} };
    this._leg = null;
    this._legT = 0;
    this._dockNext = false;            // the leg running is the last flight: dock when it ends
    this._fp = new THREE.Vector3();    // 'fetch': the bus centre in HER frame, metres
    this._fq = new THREE.Quaternion();
    this._side = 0;                    // 'fetch': +1 / -1 while it stands on the +Y / -Y side of her racks, 0 on the axis ahead of her
    this._fetchHold = new THREE.Vector3(0, 0, MATED_DIST_M);   // 'fetch': where the arm's path ends when closed (satellite-local metres)
    this._collarM = new THREE.Vector3(); // her nose collar in her frame, metres
    this._gdt = 0;                     // the frame's GAME dt (zero while the world is held): the take runs on it
    this._tqA = new THREE.Quaternion();
    this._tqB = new THREE.Quaternion();
    this._tpA = new THREE.Vector3();
    this._tpB = new THREE.Vector3();
    this._tpC = new THREE.Vector3();

    this._onBerth = (e) => this._handleBerth(e || {});
    this._onPurchase = (e) => {
      if (!e) return;
      if (e.effect === 'motherNetRestock') this._queueSwap('net');
      else if (e.effect === 'indiumCartridge') this._queueSwap('indium');
    };
    this._onGas = (e) => { if (e && (e.effect === 'engineGasResupply' || e.effect === 'coldGasResupply')) this._queueGas(); };
    this._onReset = () => this.reset();
    this._onState = (e) => {
      const to = e && e.to;
      if (to === GameStates.MENU || to === GameStates.GAME_OVER || to === GameStates.WIN) this.reset();
    };
    eventBus.on(Events.RESUPPLY_BERTH, this._onBerth);
    eventBus.on(Events.UPGRADE_PURCHASED, this._onPurchase);
    eventBus.on(Events.RESOURCE_UPGRADED, this._onGas);
    eventBus.on(Events.GAME_RESET, this._onReset);
    eventBus.on(Events.GAME_STATE_CHANGE, this._onState);
    this._poseArm();
    this._poseLine();
    _active = this;
  }

  _mat(opts) {
    const m = new THREE.MeshStandardMaterial(opts);
    this._mats.push(m);
    return m;
  }

  _mesh(parent, name, geo, mat, order, x = 0, y = 0, z = 0) {
    this._geos.push(geo);
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.renderOrder = order;
    m.position.set(x * M, y * M, z * M);
    parent.add(m);
    return m;
  }

  _build() {
    const foil = this._mat({ color: 0xb8923c, metalness: 0.7, roughness: 0.4 });
    const gun = this._mat({ ...AVIONICS_GUNMETAL });
    const dark = this._mat({ ...AVIONICS_DARK_OPTIC });
    const white = this._mat({ ...AVIONICS_THERMAL_WHITE });
    const panelBack = this._mat({ color: 0x2a2d35, metalness: 0.5, roughness: 0.5 });
    const cellMat = { color: 0x16264f, metalness: 0.6, roughness: 0.35 };
    const tex = getSolarCellTexture();
    if (tex) cellMat.map = tex;
    const cells = this._mat(cellMat);
    const g = this.group;

    // bus, interface plate (stands 40 mm proud of the front face), dish on a stalk, a thermal-white radiator band
    this._mesh(g, 'SatBus', new THREE.BoxGeometry(BUS.x * M, BUS.y * M, BUS.z * M), foil, RO.SPACECRAFT_OPAQUE);
    this._mesh(g, 'SatInterfacePlate', new THREE.BoxGeometry(1.4 * M, 1.0 * M, 0.04 * M), gun, RO.SPACECRAFT_DETAIL, 0, 0, BUS.z / 2 + 0.02);
    this._mesh(g, 'SatRadiator', new THREE.BoxGeometry((BUS.x + 0.01) * M, 0.16 * M, 1.2 * M), white, RO.SPACECRAFT_DETAIL, 0, -BUS.y / 2 + 0.2, -0.1);
    this._mesh(g, 'SatDishStalk', cylZ(0.03, 0.3, 16), gun, RO.SPACECRAFT_OPAQUE, 0, -0.2, -1.15);
    const dishGeo = new THREE.SphereGeometry(0.4 * M, 32, 12, 0, Math.PI * 2, 0, Math.PI / 3);
    dishGeo.rotateX(Math.PI / 2);                  // pole toward +Z, the bowl opens toward -Z (away from her)
    const dish = this._mesh(g, 'SatDish', dishGeo, white, RO.SPACECRAFT_OPAQUE, 0, -0.2, -1.55);
    dish.material.side = THREE.DoubleSide;

    for (const s of [-1, 1]) {
      this._mesh(g, `SatWingBoom_${s < 0 ? 'L' : 'R'}`, new THREE.CylinderGeometry(0.04 * M, 0.04 * M, 0.2 * M, 16).rotateZ(Math.PI / 2), gun,
        RO.SPACECRAFT_OPAQUE, s * (BUS.x / 2 + 0.05), 0, 0);
      const cx = s * (WING.inner + WING.len / 2);
      this._mesh(g, `SatWingBack_${s < 0 ? 'L' : 'R'}`, new THREE.BoxGeometry(WING.len * M, 0.03 * M, WING.chord * M), panelBack, RO.SPACECRAFT_OPAQUE, cx, 0, 0);
      const cellGeo = new THREE.BoxGeometry((WING.len - 0.04) * M, 0.01 * M, (WING.chord - 0.04) * M);
      this._mesh(g, `SatWingCells_${s < 0 ? 'L' : 'R'}`, cellGeo, cells, RO.SPACECRAFT_DETAIL, cx, 0.022, 0);
    }

    // the tray is half buried (top at 0.625); each cartridge rests 25 mm above it on a saddle, so the probe head (r 90 mm) can grip the
    // front end of a cartridge without touching the tray
    this._mesh(g, 'SatRackTray', new THREE.BoxGeometry(0.5 * M, 0.05 * M, 1.7 * M), gun, RO.SPACECRAFT_DETAIL, 0, BUS.y / 2, 0);
    for (let i = 0; i < SLOT_Z.length; i++) {
      this._mesh(g, `SatRackSaddle_${i}`, new THREE.BoxGeometry(0.12 * M, 0.026 * M, 0.06 * M), gun, RO.SPACECRAFT_DETAIL, 0, 0.6375, SLOT_Z[i] - 0.05);
    }
    this._carts = SLOT_Z.map((z, i) => {
      const c = new THREE.Group();
      c.name = `SatCartridge_${i}`;
      this._mesh(c, `SatCartridgeBody_${i}`, cylZ(CART.r, CART.len), gun, RO.SPACECRAFT_OPAQUE, 0, 0, -CART.len / 2);
      this._mesh(c, `SatCartridgeCap_${i}`, cylZ(CART.r - 0.005, 0.02), white, RO.SPACECRAFT_DETAIL, 0, 0, CART.len / 2 - 0.018);
      c.position.set(0, SLOT_Y * M, z * M);
      g.add(c);
      return c;
    });

    // the ion-fuel magazine: a short tray behind the bus top on a bracket plate against the rear face, two small silver indium cartridges
    // on saddles. Same heights as the net rack, so the arm reaches them along the same raised path.
    const indiumMetal = this._mat({ color: 0xc9ced6, metalness: 0.9, roughness: 0.3 });
    this._mesh(g, 'SatIndiumTray', new THREE.BoxGeometry(0.12 * M, 0.05 * M, 0.66 * M), gun, RO.SPACECRAFT_DETAIL, 0, BUS.y / 2, -1.2);
    this._mesh(g, 'SatIndiumBracket', new THREE.BoxGeometry(0.12 * M, 0.42 * M, 0.04 * M), gun, RO.SPACECRAFT_DETAIL, 0, 0.39, -BUS.z / 2 - 0.02);
    // each cartridge lies in a cradle of two side rails, never on a saddle under it: the wrist stub (r 40 mm) trails over the cartridge
    // and is thicker than it (r 35 mm), so anything directly under the cartridge would touch the stub; the rails stand outside the stub
    for (let i = 0; i < IN_SLOT_Z.length; i++) {
      for (const sx of [-1, 1]) {
        this._mesh(g, `SatIndiumRail_${i}${sx < 0 ? 'L' : 'R'}`, new THREE.BoxGeometry(0.01 * M, 0.1 * M, 0.04 * M), gun, RO.SPACECRAFT_DETAIL, sx * 0.0475, 0.675, IN_SLOT_Z[i] - 0.045);
      }
    }
    this._inCarts = IN_SLOT_Z.map((z, i) => {
      const c = new THREE.Group();
      c.name = `SatIndiumCartridge_${i}`;
      this._mesh(c, `SatIndiumBody_${i}`, cylZ(IN_CART.r, IN_CART.len), indiumMetal, RO.SPACECRAFT_OPAQUE, 0, 0, -IN_CART.len / 2);
      this._mesh(c, `SatIndiumCap_${i}`, cylZ(IN_CART.r - 0.004, 0.016), dark, RO.SPACECRAFT_DETAIL, 0, 0, IN_CART.len / 2 - 0.014);
      c.position.set(0, SLOT_Y * M, z * M);
      g.add(c);
      return c;
    });

    this._mesh(g, 'SatShoulderPedestal', new THREE.BoxGeometry(0.3 * M, 0.12 * M, 0.3 * M), gun, RO.SPACECRAFT_OPAQUE, ARM_BASE.x, ARM_BASE.y - 0.16, ARM_BASE.z);
    this._mesh(g, 'SatShoulder', new THREE.SphereGeometry(0.09 * M, 24, 12), gun, RO.SPACECRAFT_DETAIL, ARM_BASE.x, ARM_BASE.y, ARM_BASE.z);
    this._upper = new THREE.Group(); this._upper.name = 'SatArmUpper';
    this._mesh(this._upper, 'SatArmUpperLink', cylZ(0.05, LINK_M), gun, RO.SPACECRAFT_OPAQUE);
    this._elbow = this._mesh(g, 'SatElbow', new THREE.SphereGeometry(0.07 * M, 24, 12), foil, RO.SPACECRAFT_DETAIL);
    this._fore = new THREE.Group(); this._fore.name = 'SatArmFore';
    this._mesh(this._fore, 'SatArmForeLink', cylZ(0.045, LINK_M), gun, RO.SPACECRAFT_OPAQUE);
    this._wrist = new THREE.Group(); this._wrist.name = 'SatWrist';
    this._mesh(this._wrist, 'SatWristStub', cylZ(0.04, WRIST_M), gun, RO.SPACECRAFT_OPAQUE);
    // the docking probe at the tip: a head (r 90 mm) and a collet ring on the axis, inside the collar bore (r 140 mm to the ring tube),
    // never a ring round the collar (measured: the sun sensors, lamp housings and baffle stand 2-6 cm from any ring of r 0.17-0.25 at z 1.30-1.35)
    this._mesh(this._wrist, 'SatProbeHead', cylZ(0.09, 0.09, 32), foil, RO.SPACECRAFT_DETAIL, 0, 0, WRIST_M - 0.09);
    this._mesh(this._wrist, 'SatProbeCollet', new THREE.TorusGeometry(0.1 * M, 0.012 * M, 12, 48), gun, RO.SPACECRAFT_DETAIL, 0, 0, WRIST_M - 0.09);
    this._upper.position.copy(ARM_BASE).multiplyScalar(M);
    g.add(this._upper, this._fore, this._wrist);

    this._mesh(g, 'SatGasCoupling', new THREE.BoxGeometry(0.06 * M, 0.04 * M, 0.06 * M), gun, RO.SPACECRAFT_CONNECTOR, GAS_COUPLING.x, GAS_COUPLING.y - 0.02, GAS_COUPLING.z);

    // the fuel line: five straight runs (coupling -> shoulder -> elbow -> wrist -> into the probe head -> the effector coupling) and a
    // ball at each bend. It lies a few cm beside the arm in the arm's plane's normal (x) and is re-aimed every frame (_poseLine)
    this._lineMat = this._mat({ ...AVIONICS_DARK_OPTIC, emissive: GAS_COLOR, emissiveIntensity: 0 });
    this._segs = [];
    for (let i = 0; i < 5; i++) this._segs.push(this._mesh(g, `SatFuelLine_${i}`, cylZ(GAS_LINE_R, 1, 10), this._lineMat, RO.SPACECRAFT_CONNECTOR));
    this._joints = [];
    for (let i = 0; i < 4; i++) this._joints.push(this._mesh(g, `SatFuelLineBend_${i}`, new THREE.SphereGeometry(GAS_LINE_R * M, 10, 6), this._lineMat, RO.SPACECRAFT_CONNECTOR));
    // the coupling on the effector's front face where it meets her ring: a dark disc with a small light (green while gas flows).
    // It stands 1 mm proud of the head's face, so it never touches her launcher face when the tip stops 2 mm short.
    this._lightMat = this._mat({ color: 0x0c2a18, metalness: 0.3, roughness: 0.5, emissive: GAS_COLOR, emissiveIntensity: 0 });
    this._gasLight = this._mesh(this._wrist, 'SatGasLight', cylZ(0.035, 0.012, 20), this._lightMat, RO.SPACECRAFT_CONNECTOR, 0, 0, WRIST_M - 0.011);
  }

  _handleBerth(e) {
    const phase = e.phase;
    if (phase === 'berthed') {
      this._satId = e.satId ?? this._satId;
      this._altKm = e.altKm ?? this._altKm;
      if (this._state === 'mated' || this._state === 'docking' || this._state === 'fetch') return;
      this._synced = true;
      this._swapQueue.length = 0; this._swapT = -1; this._gasT = -1; this._gasPending = false;
      if (this._state === 'hidden') { this._dist = APPEAR_DIST_M; this._armS = 0; this._w = 0; }
      // pieces to take first (or being planned: it waits for them): it docks at the empty collar afterwards
      if (this._takes.length > 0 || this._jobs.length > 0) { this._beginFetch(); return; }
      this._distFrom = this._dist;
      this._armFrom = this._armS;
      this._wFrom = this._w;
      this._state = 'docking';
      this._t = 0;
    } else if (phase === 'left') {
      this._jobs.length = 0;                                                 // a plan asked for is dropped: the pieces it was for stay aboard, unpaid
      this._dockGate = null; this._dockGiveUp = null; this._gateS = 0;
      // (never commanded: nothing to put back; a swing under way finishes and is put back)
      if (this._fold && this._fold.phase === 'cmd') this._fold = null;
      this._flushTakes();                                                    // she lets go: a take not finished is over (the piece leaves with it)
      if (this._state === 'hidden' || this._state === 'leaving') return;
      if (this._state === 'fetch') {
        this._drawOff();
        return;
      }
      this._wFrom = this._state === 'mated' ? 1 : this._w;
      this._state = 'leaving';
      this._t = 0;
      this._speed = 0;
      this._swapT = -1; this._swapQueue.length = 0; this._gasT = -1; this._gasPending = false;
    } else if (phase === 'coming') {
      if (this._state !== 'hidden') return;
      this._synced = true;
      this._state = 'coming';
      this._t = 0;
      this._playS = (e.playS > 0 ? e.playS : DEFAULT_PLAY_S);
      this._dist = COMING_START_M;
      this._armS = 0;
      this._w = 0;
    }
  }

  /** @param {'net'|'indium'} kind what the swap carries */
  _queueSwap(kind = 'net') {
    if (this._state !== 'mated' && this._state !== 'docking' && this._state !== 'fetch') return;  // (the swap waits for the dock while it is away on a take)
    if (this._swapQueue.length < SWAP_QUEUE_MAX) this._swapQueue.push(kind);
  }

  get _swapsQueued() { return this._swapQueue.length; }

  _queueGas() { this.showGasFlow(); }

  /** "Gas flowing": about GAS_S seconds of light on the effector coupling. Only while it is berthed to her (closing or mated), and it
   *  shows only while the grip is on her ring: with the arm away on a cartridge swap (or a take) it waits until the grip is back. */
  showGasFlow() {
    if (this._state !== 'mated' && this._state !== 'docking' && this._state !== 'fetch') return;
    this._gasPending = true;
  }

  /**
   * Plan the take of these pieces (still on their holders, about to be handed over) over the next frames, then call `onReady(ok)` with the
   * set the arm can take. Planned in the order the satellite will take them (`_pickNext`: the nose piece first, then the one that sticks out
   * farthest on its side), with earlier ones gone and unreachable ones still aboard. Plans are kept for `takePiece`; a piece with no clear
   * way out is never detached or paid.
   *
   * With `fold` (rack pieces) she first folds her radiators to 90 deg (full radiating area there: no heat cost; 15 deg/s slew), plans once
   * they have settled (or stopped short: at the angle reached), and restores the angle after the takes. Until the plan is ready the berthed
   * satellite waits and does not dock. Planning runs in slices (`PLAN.sliceMs` a frame).
   * @param {object[]} pieces the field's own bodies (with `_scenePosition`)
   * @param {{fold?: boolean, collar?: boolean, onReady?: ((ok: Set<object>) => void)}} [o] `collar`: these pieces are the one on her nose
   *   collar (the HOLDER decides how a piece is taken, never where it sits: after the fold a rack piece can sit ahead of her hinges)
   * @returns {boolean} false when there was nothing to plan (`onReady` has been called with an empty set)
   */
  requestTakes(pieces, { fold = false, collar = false, onReady = null } = {}) {
    const list = [];
    for (const d of pieces || []) if (d && !this.hasPiece(d) && !list.includes(d)) list.push(d);
    if (!list.length) { if (onReady) onReady(new Set()); return false; }
    for (const d of list) { if (collar) this._noseSet.add(d); else this._noseSet.delete(d); }
    this._jobs.push({ pieces: list, fold, onReady, gen: null, tries: 0, foldAsked: false });
    this.planStats.jobs++;
    return true;
  }

  /**
   * Wait for pieces moving between holders (a catch flying from her nose to a daughter's rack, a daughter carrying it): they cannot be
   * planned (`_planFits`) nor detached (`handOverCollarCatch` refuses a net still flying). The wait is a job in the line, so the berthed
   * satellite hovers and does not dock while it lasts (`jobsPending`, `_holdsDock`); it counts toward no `waitS` or `_gateS`, so not toward
   * `TAKE_WAIT_MAX_S`. When none is moving (or `TRANSIT_WAIT_MAX_S` of game time has passed) `onSeated(pieces, timedOut)` gets the pieces
   * still alive; the caller asks for them again by what their holder is NOW.
   * @param {{moving: ((d: object) => boolean), onSeated?: ((pieces: object[], timedOut: boolean) => void)}} o `moving(d)`: is the piece in transit
   * @returns {boolean} false when there was nothing to wait for
   */
  awaitSeated(pieces, { moving, onSeated = null } = {}) {
    const list = [];
    for (const d of pieces || []) if (d && !this.hasPiece(d) && !list.includes(d)) list.push(d);
    if (!list.length || typeof moving !== 'function') return false;
    this._jobs.push({ pieces: list, wait: true, moving, onSeated, waitS: 0 });
    return true;
  }

  hasPiece(d) {
    for (const j of this._jobs) if (j.pieces.includes(d)) return true;
    for (const r of (this._take ? [this._take.rec, ...this._takes] : this._takes)) if (r.piece === d) return true;
    return false;
  }

  /** Could `takePiece` take this piece now (a plan made for it, it is where planned, the satellite not leaving)? Ask BEFORE freeing or paying it. */
  canTake(d) {
    const p = this.player;
    const ok = !!(d && d._scenePosition && p && p.position && p.quaternion && this._state !== 'leaving' && this._planFits(d));
    this._cleared = ok ? d : null;  // the caller frees and pays the piece next, in the same breath: `takePiece` then does not refuse it
    return ok;
  }

  jobsPending() { return this._jobs.length; }

  foldPhase() { return this._fold ? this._fold.phase : null; }

  /** Plan these pieces now, all at once (a probe, a survey): the same plan `requestTakes` makes. @returns {Set<object>} the pieces it can take */
  planTakes(pieces, { collar = false } = {}) {
    for (const d of pieces || []) if (d) { if (collar) this._noseSet.add(d); else this._noseSet.delete(d); }
    const gen = this._planBatchGen(pieces || []);
    this._poolOff = true;                                              // (driven at once: it must not share the pool with a plan a job has paused)
    try { for (;;) { const r = gen.next(); if (r.done) return r.value; } } finally { this._poolOff = false; }
  }

  /**
   * The collar is not free to dock at while `fn()` is true (a piece it could not take is still on it): the satellite waits for it to clear. It waits
   * at most `TAKE_WAIT_MAX_S` of game time with nothing else to do (no plan being made, no take): then `onGiveUp()` is called and it draws
   * off and hides
   * WITHOUT docking (no hover for good, no swaps while the piece is on her nose; the next berth asks again).
   * @param {(() => boolean)|null} fn @param {{onGiveUp?: (() => void)}} [o]
   */
  setDockGate(fn, { onGiveUp = null } = {}) {
    this._dockGate = typeof fn === 'function' ? fn : null;
    this._dockGiveUp = this._dockGate && typeof onGiveUp === 'function' ? onGiveUp : null;
    this._gateS = 0;
  }

  /** Waited long enough for the collar to clear: say so (the caller's line), draw off along the line from her and hide, without docking. */
  _giveUpDock() {
    const say = this._dockGiveUp;
    this._dockGate = null; this._dockGiveUp = null; this._gateS = 0;
    this._drawOff();
    if (say) say();
  }

  /** 'fetch': away from her collar: the satellite draws off along the line from her, then hides (the swaps queued and the gas light are dropped). */
  _drawOff() {
    this._legs.length = 0;
    this._leg = { k: 'away', armFrom: this._armS, p0: this._fp.clone(), dir: this._fp.lengthSq() > 1e-6 ? this._fp.clone().normalize() : new THREE.Vector3(0, 0, 1) };
    this._legT = 0; this._dockNext = false;
    this._swapT = -1; this._swapQueue.length = 0; this._gasT = -1; this._gasPending = false;
  }

  *_planBatchGen(pieces) {
    const ok = new Set();
    const p = this.player;
    const todo = [];
    for (const d of pieces) {
      if (!d || d.alive === false || !d._scenePosition || !p || !p.position || !p.quaternion || this._state === 'leaving') continue;
      const pose = this._bodyPose(d);
      todo.push({ piece: d, cM: pose.cM, qRel: pose.qRel, nose: this._noseSet.has(d) });
    }
    if (todo.length === 0) return ok;
    const gone = { bodies: new Set(), cs: [] };
    // the nose piece (at her collar) is taken before any rack piece (`_pickNext`): it is gone when a rack piece's turn comes
    for (const o of (this._take ? [this._take.rec, ...this._takes] : this._takes)) {
      if (!o.done && o.piece.alive !== false && o.nose) { gone.bodies.add(o.piece); gone.cs.push(o.cM); }
    }
    const hull = yield* this._hullTriField();
    while (todo.length > 0) {
      let bi = 0, best = -Infinity;
      for (let i = 0; i < todo.length; i++) {
        if (todo[i].nose) { bi = i; break; }
        const s = this._support(todo[i], this._tpA.set(0, todo[i].cM.y < 0 ? -1 : 1, 0));
        if (s > best + 1e-9) { best = s; bi = i; }
      }
      const rec = todo.splice(bi, 1)[0];
      const plan = yield* this._planTakeGen(rec, gone, hull);
      if (!plan) continue;
      plan.cM = rec.cM.clone();
      plan.qRel = rec.qRel ? rec.qRel.clone() : null;
      this._planned.set(rec.piece, plan);
      ok.add(rec.piece);
      gone.bodies.add(rec.piece);
      gone.cs.push(rec.cM);
    }
    return ok;
  }

  /** Is this piece where its plan was made (it is handed over in the same frame the plan is finished: nothing may have moved it)? */
  _planFits(piece) {
    const pre = this._planned.get(piece);
    const p = this.player;
    if (!pre || !pre.cM || !piece._scenePosition || !p || !p.quaternion) return false;
    const pose = this._bodyPose(piece);
    if (pre.cM.distanceTo(pose.cM) > PLAN_POSE_TOL_M) return false;
    if (pre.qRel && pose.qRel && 2 * Math.acos(Math.min(1, Math.abs(pre.qRel.dot(pose.qRel)))) > 0.01) return false;
    return true;
  }

  _serviceJobs(gdt) {
    this._serviceFold(gdt);
    const job = this._jobs[0];
    if (!job) return;
    if (job.wait) {
      // a wait for pieces in transit (`awaitSeated`): the berthed satellite hovers; nothing is planned, detached or paid until they are seated
      job.waitS += gdt;
      const alive = job.pieces.filter((d) => d && d.alive !== false);
      const moving = alive.some((d) => job.moving(d));
      const timedOut = moving && job.waitS > TRANSIT_WAIT_MAX_S;
      if (moving && !timedOut) return;
      this._jobs.shift();
      if (typeof job.onSeated === 'function') job.onSeated(alive, timedOut);
      return;
    }
    if (job.fold) {
      // rack pieces: her radiators fold first, once the pieces ahead of them (the nose piece) are taken with the radiators as they stand, so no plan
      // is made on a hull that is moving
      // on a hull that is moving
      if (!job.foldAsked) {
        if (this._takes.length > 0 || this._take) return;
        job.foldAsked = true;
        this._beginFold();
      }
      if (this._fold && (this._fold.phase === 'cmd' || this._fold.phase === 'slew')) return;
    }
    if (!job.gen) job.gen = this._planBatchGen(job.pieces);
    const now = PLAN.now;
    const t0 = now();
    let r;
    let worst = 0;
    let nSlices = 0;
    do {
      const s0 = now();
      r = job.gen.next();
      nSlices++;
      if (PLAN_DEBUG.on) { if (PLAN_DEBUG.restRun > PLAN_DEBUG.maxRestSlice) PLAN_DEBUG.maxRestSlice = PLAN_DEBUG.restRun; PLAN_DEBUG.restRun = 0; }
      const ms = now() - s0;
      this.planStats.slices++; this.planStats.slicesMs += ms;
      if (ms > worst) { worst = ms; if (ms > this.planStats.worstSliceMs) this.planStats.worstAt = _work.at; }
      if (ms > 8 && this.planStats.slow.length < 16) this.planStats.slow.push(`${ms.toFixed(1)}@${_work.at}`);
      if (!(ms <= (this.planStats.byStage[_work.at] || 0))) this.planStats.byStage[_work.at] = ms;
    } while (!r.done && now() - t0 < PLAN.sliceMs && nSlices < PLAN.maxSlices);
    if (worst > this.planStats.worstSliceMs) this.planStats.worstSliceMs = worst;
    const frameMs = now() - t0;
    this.planStats.frames++;
    if (frameMs > 16) this.planStats.over16++;
    this.planStats.worstFrameMs = Math.max(this.planStats.worstFrameMs || 0, frameMs);
    if (!r.done) return;
    job.gen = null;
    const planned = r.value;
    job.good = job.good || new Set();
    const stale = [];
    for (const d of planned) { if (this._planFits(d)) job.good.add(d); else stale.push(d); }
    // a piece that moved while it was planned (a daughter shifted it) is planned again before anything is detached or paid
    if (stale.length && job.tries < PLAN.maxTries) { job.tries++; job.pieces = stale; return; }
    this._jobs.shift();
    if (typeof job.onReady === 'function') job.onReady(job.good);
  }

  // The radiator fold: the rack pieces are taken with her radiators at 90 deg.

  /** Fold the radiators to 90 deg with the existing flower controls (`setFlowerPose('CARGO')`: 15 deg/s slew) before the racks are planned. */
  _beginFold() {
    const p = this.player;
    const FL = Constants.THERMAL && Constants.THERMAL.FLOWER;
    if (!p || !FL || typeof p.setFlowerPose !== 'function' || !Number.isFinite(p._flowerThetaRad)) return;
    if (this._fold) {
      if (this._fold.phase === 'restoring' || this._fold.phase === 'settled') { this._fold.phase = 'cmd'; this._fold.t = 0; }
      return;
    }
    const goal = degToRad(FL.POSE_CARGO_DEG);
    // already at 90 deg: planned as she stands (above or below it she goes to 90: closed at 0 deg the racks are as walled in as at 146)
    if (Math.abs(p._flowerThetaRad - goal) <= 0.01) return;
    this._fold = { prevRad: p._flowerThetaRad, goalRad: goal, phase: 'cmd', t: 0 };
  }

  _serviceFold(gdt) {
    const f = this._fold, p = this.player;
    if (!f || !p) return;
    f.t += gdt;
    const th = p._flowerThetaRad;
    const say = (text) => eventBus.emit(Events.COMMS_MESSAGE, { text, priority: 'info', _keep: true });
    if (f.phase === 'cmd') {
      if (!p.flowerCommandsLocked) {
        if (p.setFlowerPose('CARGO') !== null) {
          f.phase = 'slew'; f.t = 0;
          say(th > f.goalRad ? 'Folding the radiators to 90° so the satellite can reach the racks.' : 'Opening the radiators to 90° so the satellite can reach the racks.');
        }
        else f.phase = 'settled';
      } else if (f.t > FOLD_CMD_WAIT_S) f.phase = 'settled';                          // held for a catch hand-off: planned at the angle she has
    } else if (f.phase === 'slew') {
      if (p._flowerTargetTheta === undefined || Math.abs(th - f.goalRad) < 0.01) f.phase = 'settled';
      else if (f.t > FOLD_MAX_S) { p._flowerTargetTheta = undefined; f.phase = 'settled'; }  // stopped short (a wing blocked): planned at the angle reached
    } else if (f.phase === 'settled') {
      if (this._jobs.length === 0 && this._takes.length === 0 && !this._take) { f.phase = 'restoring'; f.t = 0; f.back = false; }
    } else if (f.phase === 'restoring') {
      // the swing back is under way: it ends where the driver lands her (a 180 deg start lands at her open angle, 146: the line says that one)
      if (f.back) {
        if (p._flowerTargetTheta === undefined || Math.abs(th - f.prevRad) < 0.01 || f.t > FOLD_MAX_S) {
          say(`Radiators back to ${Math.round(radToDeg(th))}°.`);
          this._fold = null;
        } else if (Math.abs(p._flowerTargetTheta - f.prevRad) > 1e-9 && !p.flowerCommandsLocked) p._flowerTargetTheta = f.prevRad;
        return;
      }
      if (Math.abs(th - f.goalRad) > 0.03 && p._flowerTargetTheta === undefined) { this._fold = null; return; }  // she was moved by hand since: left as she is
      if (Math.abs(th - f.prevRad) < 0.01 || f.t > FOLD_MAX_S) { this._fold = null; return; }
      if (p._flowerTargetTheta === undefined || Math.abs(p._flowerTargetTheta - f.prevRad) > 1e-9) {
        if (!p.flowerCommandsLocked) { p._flowerTargetTheta = f.prevRad; f.back = true; }
        else if (f.t > FOLD_CMD_WAIT_S) this._fold = null;
      }
    }
  }

  /**
   * Take a big piece she holds: the caller (GameFlowManager) has freed it from its holder and paid it. The piece is pinned in HER frame at
   * once and waits its turn. The satellite goes to it before it docks (or lets go of her collar, if mated), hovers outside her, the arm
   * grips the nearest drawn point, hauls it clear over TAKE_S with the piece in the grip every frame, then `onDone()` removes it. A take cut
   * short (she lets go, game over, a new run) ends at once the same way: the piece leaves with the satellite.
   * @param {{debrisField?: object, onDone?: (() => void)}} [o]
   * @returns {boolean} false = it cannot be taken now (no ship, the satellite is leaving, or no plan fits the piece where it is): the caller
   *   must NOT have detached or paid it (`requestTakes` says first which pieces it can take; a piece it refuses stays aboard)
   */
  takePiece(piece, { debrisField = null, onDone = null } = {}) {
    const p = this.player;
    if (!piece || !piece._scenePosition || !p || !p.position || !p.quaternion || this._state === 'leaving') return false;
    if (this._cleared === piece) this._cleared = null;
    else if (!this._planFits(piece)) return false;  // every take is planned, and it is where it was planned: nothing is taken for want of a plan
    const inv = this._tqA.copy(p.quaternion).invert();
    const rec = { piece, df: debrisField, onDone, done: false, waitS: 0, rel: new THREE.Vector3(), cM: new THREE.Vector3(), qRel: null, plan: null, nose: this._noseSet.has(piece) };
    rec.rel.copy(piece._scenePosition).sub(p.position).applyQuaternion(inv);
    rec.cM.copy(rec.rel).multiplyScalar(1 / M);
    if (piece.tumbleAxis && Number.isFinite(piece.tumbleAngle)) {      // the attitude it is drawn at now, kept in her frame from here on
      rec.qRel = new THREE.Quaternion().setFromAxisAngle(this._tpA.copy(piece.tumbleAxis).normalize(), piece.tumbleAngle);
      rec.qRel.premultiply(inv);
    }
    rec.plan = this._planned.get(piece);
    this._planned.delete(piece);
    this._takes.push(rec);
    this._pinRec(rec);
    this._syncTakeLock();
    return true;
  }

  /**
   * Take back a take `takePiece` accepted a moment ago, before it has started (the caller could not free the piece from its holder after all):
   * the piece is not taken, `onDone` does not run, and the plan is kept so it can be asked for again.
   * @returns {boolean} false when there is no such waiting take
   */
  cancelTake(piece) {
    const i = this._takes.findIndex((r) => r.piece === piece);
    if (i < 0) return false;
    const [rec] = this._takes.splice(i, 1);
    if (rec.plan) this._planned.set(piece, rec.plan);
    rec.done = true;
    rec._verts = undefined;
    this._syncTakeLock();
    return true;
  }

  /** Pin every waiting piece where it stands in her frame again (the hand-over frees a piece from its rack a moment after `takePiece` pinned it). */
  repinTakes() {
    for (const rec of this._takes) this._pinRec(rec);
  }

  _pinRec(rec) {
    const p = this.player;
    this._pinTo(rec, this._tpA.copy(rec.rel).applyQuaternion(p.quaternion).add(p.position));
  }

  _pinTo(rec, pos) {
    // its attitude is her frame's too (she turns with the orbit: a frame left in the world's would turn the piece against her); written before
    // the pin so the pin draws it at this frame's attitude
    const d = rec.piece;
    if (rec.qRel && d.tumbleAxis) {
      const q = this._tqB.copy(this.player.quaternion).multiply(rec.qRel);
      const w = clamp(q.w, -1, 1);
      const s = Math.sqrt(Math.max(0, 1 - w * w));
      if (s > 1e-6) d.tumbleAxis.set(q.x / s, q.y / s, q.z / s); else d.tumbleAxis.set(0, 1, 0);
      d.tumbleAngle = 2 * Math.acos(w);
      const canon = rec.df && rec.df.debrisMap ? rec.df.debrisMap.get(d.id) : null;
      if (canon && canon !== d && canon.tumbleAxis) { canon.tumbleAxis.copy(d.tumbleAxis); canon.tumbleAngle = d.tumbleAngle; }
    }
    // Hanging on her grip (carry): the piece is the resupply craft's, so it is drawn exactly when SHE is, not when the mother is
    // (DebrisField.carrierHidden). Waiting or flying-to pieces are still on the mother's rack and follow the mother.
    const carried = !!(this._take && this._take.rec === rec && this._take.phase === 'carry');
    d._carrierObj = carried ? this.group : null;
    const canonCar = rec.df && rec.df.debrisMap ? rec.df.debrisMap.get(d.id) : null;
    if (canonCar && canonCar !== d) canonCar._carrierObj = d._carrierObj;
    if (rec.df && typeof rec.df.pinCapturedDebris === 'function') rec.df.pinCapturedDebris(d, pos);
    else if (d._scenePosition) d._scenePosition.copy(pos);
  }

  _finishRec(rec) {
    if (rec.done) return;
    rec.done = true;
    rec._verts = undefined;
    if (rec.piece) rec.piece._carrierObj = null;
    if (typeof rec.onDone === 'function') rec.onDone();
  }

  /** While a take is waiting or running her radiators are not the player's to move (`PlayerSatellite.flowerCommandsLocked` reads this). */
  _syncTakeLock() {
    const p = this.player;
    if (!p) return;
    const on = !!(this._take || this._takes.length > 0);
    if ((p._resupplyTaking === true) !== on) {
      p._resupplyTaking = on;
      // (the lock turned on or off with no catch hand-off holding: the take's refusal says its line once per take)
      if (!p.flowerHandoffHeld) p._flowerHoldWarned = false;
    }
  }

  _flushTakes() {
    const all = this._take ? [this._take.rec, ...this._takes] : this._takes.slice();
    this._take = null;
    this._takes.length = 0;
    this._legs.length = 0;
    this._leg = null;
    this._dockNext = false;
    for (const rec of all) this._finishRec(rec);
    this._syncTakeLock();
  }

  // The flight to a piece ('fetch': away from her collar, in HER frame, metres).

  /** Where the satellite stands now in HER frame (bus centre, attitude), and her nose collar, from the placement of this moment. */
  _snapPose() {
    this._place();
    const p = this.player;
    const inv = this._tqA.copy(p.quaternion).invert();
    this._fp.copy(this.group.position).sub(p.position).applyQuaternion(inv).multiplyScalar(1 / M);
    this._fq.copy(inv).multiply(this.group.quaternion);
    p.getNetBerthCollarPositionInto(this._tpA);
    this._collarM.copy(this._tpA).sub(p.position).applyQuaternion(inv).multiplyScalar(1 / M);
  }

  /** The satellite goes away from where it is (hidden, waiting at hover, or mated: the arm lets go first) to take the pieces waiting. */
  _beginFetch() {
    const fromMated = this._state === 'mated';
    this._snapPose();
    this._state = 'fetch';
    this._legs.length = 0;
    this._leg = null;
    this._legT = 0;
    this._dockNext = false;
    this._side = 0;
    this._w = 1;
    this._fetchHold.copy(SWAP_HOLD);
    if (fromMated) { this._legs.push({ k: 'depart', dur: RELEASE_S }); this._armS = 1; }
  }

  _toDocking() {
    this._state = 'docking';
    this._t = 0;
    this._dist = this._fp.z - this._collarM.z;
    this._distFrom = this._dist;
    this._armFrom = this._armS;
    this._wFrom = 1;
    this._w = 1;
    this._take = null;
    this._leg = null;
    this._legs.length = 0;
    this._dockNext = false;
  }

  /** The farthest the piece is drawn from its centre (metres), true size (the same reach the racks' keep-out spheres use). */
  _reachM(rec) {
    const d = rec.piece;
    return Math.max(0.1, DebrisField.trueReachM(d, d.sizeMeter || 1));
  }

  /** Everything else aboard as spheres in HER frame, metres: held catches (nose, tip bags, racks) and the pieces the satellite has in line. */
  _aboardSpheres(except) {
    const out = [];
    const am = this.player && this.player.armManager;
    if (am && typeof am._heldCatchSpheres === 'function') {
      for (const s of am._heldCatchSpheres()) out.push({ x: s.c[0], y: s.c[1], z: s.c[2], r: s.r });
    }
    const recs = this._take ? [this._take.rec, ...this._takes] : this._takes;
    for (const rec of recs) {
      if (rec === except || rec.done || rec.piece.alive === false) continue;
      out.push({ x: rec.cM.x, y: rec.cM.y, z: rec.cM.z, r: this._reachM(rec) });
    }
    return out;
  }

  /** The piece's drawn vertices in HER frame, metres, at the attitude it is held at (a ball, or a mesh not found: null). */
  _pieceVerts(rec) {
    if (rec._verts !== undefined) return rec._verts;
    const d = rec.piece;
    let out = null;
    const geo = d.isBag === true || !d.type ? null : DebrisWireframe.getGeometry(d.type, d.id);
    const pos = geo && geo.getAttribute ? geo.getAttribute('position') : null;
    const sc = DebrisField.effectiveRenderScale(d) / M;
    if (pos && sc > 0) {
      out = new Float64Array(pos.count * 3);
      const v = this._tpB;
      for (let i = 0; i < pos.count; i++) {
        v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).multiplyScalar(sc);
        if (rec.qRel) v.applyQuaternion(rec.qRel);
        v.add(rec.cM);
        out[3 * i] = v.x; out[3 * i + 1] = v.y; out[3 * i + 2] = v.z;
      }
    }
    rec._verts = out;
    return out;
  }

  _support(rec, u) {
    const verts = this._pieceVerts(rec);
    if (!verts) return rec.cM.dot(u) + this._reachM(rec);
    let best = -Infinity;
    for (let i = 0; i < verts.length; i += 3) { const dot = verts[i] * u.x + verts[i + 1] * u.y + verts[i + 2] * u.z; if (dot > best) best = dot; }
    return best;
  }

  /**
   * Where the satellite stands to take this piece and how it hauls it, all in HER frame, metres, from the piece's drawn mesh; null when the
   * arm cannot reach it from a spot clear of everything aboard, or no line out passes the haul rule (`HAUL_RULE`; the piece then stays aboard).
   * A generator: it yields between slices of work (`_serviceJobs`), the nose piece and the rack pieces alike.
   * @param {object} rec the piece's record: `{ piece, cM, qRel }` in her frame
   * @param {{bodies: Set<object>, cs: THREE.Vector3[]}} gone pieces counted as already taken (the batch plans in the satellite's order)
   * @returns {{nose: boolean, side: number, u: THREE.Vector3, G: THREE.Vector3, Dg: number, H0: THREE.Vector3, H1: THREE.Vector3,
   *   Q: THREE.Quaternion, hold: THREE.Vector3, gripOff: THREE.Vector3}|null}
   */
  *_planTakeGen(rec, gone, hull) {
    // the HOLDER decides: the piece on her nose collar; a rack piece can sit ahead of her hinges once her radiators have folded
    const nose = rec.nose === true;
    if (nose ? this._noWayCollar : this._noWay) return null;
    const side = nose ? 0 : (rec.cM.y < 0 ? -1 : 1);
    const u = nose ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, side, 0);
    const verts = this._pieceVerts(rec);
    const G = new THREE.Vector3();
    let su;
    if (verts) {
      // the grip: the farthest vertex along `u` within GRIP_X_MAX_M of her Y-Z plane, so the arm runs through the gap between her radiator petals,
      // never beside one; a piece with nothing that near the plane is gripped at its farthest vertex
      let best = -Infinity, bi = -1, bestAll = -Infinity, bj = 0;
      for (let i = 0; i < verts.length; i += 3) {
        const dot = verts[i] * u.x + verts[i + 1] * u.y + verts[i + 2] * u.z;
        if (dot > bestAll) { bestAll = dot; bj = i; }
        if (!nose && Math.abs(verts[i]) <= GRIP_X_MAX_M && dot > best) { best = dot; bi = i; }
      }
      if (bi < 0) bi = bj;
      su = bestAll;
      G.set(verts[bi], verts[bi + 1], verts[bi + 2]);
    } else {
      const r = Math.max(0.1, (rec.piece.sizeMeter || 1) / 2);
      G.copy(rec.cM).addScaledVector(u, r);
      su = G.dot(u);
    }
    const gu = G.dot(u);
    // the hover plane is beyond everything else aboard along `u`: her hull (nose / radiators open), the held catches (spheres), and every other
    // piece in line at its drawn mesh (a piece that sticks out farther than this one is taken first: `_pickNext`)
    let D = Math.max(su, nose ? SHIP_FRONT_Z_M : SHIP_KEEP_Y_M);
    const am = this.player && this.player.armManager;
    if (am && typeof am._heldCatchSpheres === 'function') {
      for (const s of am._heldCatchSpheres()) {
        if (/^rack catch/.test(s.name || '')) continue;
        D = Math.max(D, s.c[0] * u.x + s.c[1] * u.y + s.c[2] * u.z + s.r);
      }
    }
    for (const o of this._aboardRecs(rec.piece, gone)) D = Math.max(D, this._support(o, u) + 0.05);
    const DgBase = Math.max(GRIP_DIST_MIN_M, D - gu + BUS_FRONT_M + STAND_OFF_M);
    const reachOk = DgBase <= GRIP_DIST_MAX_M;
    if (PLAN_DEBUG.on) { PLAN_DEBUG.pull = null; PLAN_DEBUG.grip = { nose, side, Dg: DgBase, D, su, gu, G: G.toArray(), reachOk }; }
    const Q = nose ? QY_PI.clone() : qRackPhi(side * Math.PI / 2);
    let Dg = DgBase;
    let H0 = new THREE.Vector3().copy(G).addScaledVector(u, Dg);
    let body = null;
    if (!reachOk) {
      // the default hover is out of the arm's reach: the bus moves in along the same line to the first spot that measures clear. A nose piece does
      // not: it is gripped at its farthest vertex
      if (nose || this._noPull) return null;
      const pick = yield* this._pullInGen(rec, gone, hull, G, u, Q);
      if (!pick) return null;
      Dg = pick.Dg; H0 = pick.H0; body = pick.body;
      if (PLAN_DEBUG.on) PLAN_DEBUG.grip.pulledDg = Dg;
    }
    // the haul of EVERY piece (the nose piece too) is measured against the rule, never assumed: none clear = no take
    const route = yield* this._planHaulGen(rec, nose, side, H0, Q, Dg, gone, hull, body);
    if (!route) return null;
    const dir = route.dir, haul = route.len;
    const H1 = new THREE.Vector3().copy(H0).addScaledVector(dir, haul);
    return { nose, side, u, G, Dg, H0, H1, Q, dir, haul, hold: new THREE.Vector3(0, 0, Dg), gripOff: new THREE.Vector3().copy(rec.cM).sub(G) };
  }

  /**
   * The satellite's drawn solids in ITS frame, metres (read once from the meshes, as `js/test/_satGeom.js` `satSolids` reads them): `boxes`: one
   * axis-aligned box `[x0, x1, y0, y1, z0, z1]` per mesh that is not the arm (a box inside another is dropped); `ext`: the same boxes swept straight
   * out along the approach line (local -Z, away from her); `names`; `pts`: their surfaces sampled to `PULL.bodyStepM` (xyz triples). The arm is
   * swept on its own axes (`armJoints`), never as a solid.
   */
  _bodyModel() {
    if (this._bodyM) return this._bodyM;
    const g = this.group;
    const list = [];
    const mm = new THREE.Matrix4();
    g.traverse((o) => {
      if (o === g || !o.isMesh || !o.geometry || SAT_ARM_PART.test(o.name)) return;
      const chain = [];
      for (let p = o; p && p !== g; p = p.parent) { if (SAT_ARM_PART.test(p.name)) return; chain.push(p); }
      mm.identity();
      for (let i = chain.length - 1; i >= 0; i--) { chain[i].updateMatrix(); mm.multiply(chain[i].matrix); }
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const b = o.geometry.boundingBox.clone().applyMatrix4(mm);
      list.push({ name: o.name, b: [b.min.x / M, b.max.x / M, b.min.y / M, b.max.y / M, b.min.z / M, b.max.z / M] });
    });
    const inside = (a, c) => a[0] >= c[0] - 0.005 && a[1] <= c[1] + 0.005 && a[2] >= c[2] - 0.005 && a[3] <= c[3] + 0.005 && a[4] >= c[4] - 0.005 && a[5] <= c[5] + 0.005;
    const kept = list.filter((a, i) => !list.some((c, j) => j !== i && inside(a.b, c.b) && (!inside(c.b, a.b) || j < i)));
    const pts = [];
    const st = PULL.bodyStepM;
    for (const { b } of kept) {
      const nx = Math.max(1, Math.ceil((b[1] - b[0]) / st)), ny = Math.max(1, Math.ceil((b[3] - b[2]) / st)), nz = Math.max(1, Math.ceil((b[5] - b[4]) / st));
      for (let i = 0; i <= nx; i++) for (let j = 0; j <= ny; j++) for (let k = 0; k <= nz; k++) {
        if (i > 0 && i < nx && j > 0 && j < ny && k > 0 && k < nz) continue;
        pts.push(b[0] + (b[1] - b[0]) * i / nx, b[2] + (b[3] - b[2]) * j / ny, b[4] + (b[5] - b[4]) * k / nz);
      }
    }
    this._bodyM = { boxes: kept.map((a) => a.b), names: kept.map((a) => a.name), ext: kept.map((a) => [a.b[0], a.b[1], a.b[2], a.b[3], -PULL.farM, a.b[5]]), pts: Float64Array.from(pts) };
    return this._bodyM;
  }

  /**
   * A hover pulled in, a generator. The default hover (the bus `STAND_OFF_M` beyond everything aboard) can leave the grip farther than the
   * arm reaches (`GRIP_DIST_MAX_M`): a long piece whose far end lies well past its gripped point. Hovers along the same line are tried from
   * the arm's full reach down to `GRIP_DIST_MIN_M` in `PULL.stepM`; the first is taken at which, measured on the drawn things in her frame:
   *  - the satellite's solids (`_bodyModel`, swept straight out along the approach) keep `STAND_OFF_M` from every piece aboard and from the
   *    spheres of the nose catch and the tip bags;
   *  - the arm's links keep `PULL.armClearM` from every piece aboard, at the hover and along the end of the reach (the wrist stub and the
   *    head are the grip itself, they touch the piece);
   *  - nothing of her hardware or her docked daughters is within 0.2 m of the solids at the hover, and the straight run in passes the haul rule.
   * The haul is then swept with the solids carried too (`_planHaulGen`). `PLAN_DEBUG.pull` records every hover tried. The triangle fields
   * cover 4.2 m about her axis (`TG`) while the solids hover and haul farther out and the other pieces aboard reach to 7.69 m, so a second
   * check along the haul, `_haulSolidsClearGen`, holds the same 0.6 m from them. Her own hull and daughters lie inside the fields (measured:
   * within 2.3 m of her axis), so the sweep sees them.
   * @returns {{Dg: number, H0: THREE.Vector3, body: Float64Array}|null} `body`: the solids' sample points at the hover, her frame
   */
  *_pullInGen(rec, gone, hull, G, u, Q) {
    _work.at = 'pull';
    const dbg = PLAN_DEBUG.on ? { cands: [], picked: null } : null;
    if (dbg) PLAN_DEBUG.pull = dbg;
    const model = this._bodyModel();
    const ext = model.ext, nBox = ext.length;
    const Qi = new THREE.Quaternion().copy(Q).invert();
    const v = new THREE.Vector3();
    // every piece aboard, as the satellite sees it with the bus at the grip: x, y, z (the grip point is the origin); the hover `Dg` is then z + Dg
    const W = [];
    for (const r of [rec, ...this._aboardRecs(rec.piece, gone)]) {
      const rp = yield* haulRuleGen(r.piece);
      const w = new Float64Array(rp.length);
      for (let i = 0; i < rp.length; i += 3) {
        v.set(rp[i], rp[i + 1], rp[i + 2]);
        if (r.qRel) v.applyQuaternion(r.qRel);
        v.add(r.cM).sub(G).applyQuaternion(Qi);
        w[i] = v.x; w[i + 1] = v.y; w[i + 2] = v.z;
        _work.n += 0.3;
        if (WORK_DUE()) { _work.n = 0; yield; }
      }
      W.push(w);
    }
    const band = [];
    for (const w of W) for (let i = 0; i < w.length; i += 3) if (Math.abs(w[i]) <= PULL.bandM) band.push(w[i], w[i + 1], w[i + 2]);
    const B = Float64Array.from(band);
    const spheres = [];  // the nose catch and the tip bags (a rack's catch is measured at its mesh, above)
    const am = this.player && this.player.armManager;
    if (am && typeof am._heldCatchSpheres === 'function') {
      for (const s of am._heldCatchSpheres()) {
        if (/^rack catch/.test(s.name || '')) continue;
        v.set(s.c[0], s.c[1], s.c[2]).sub(G).applyQuaternion(Qi);
        spheres.push({ x: v.x, y: v.y, z: v.z, r: s.r });
      }
    }
    const stand2 = STAND_OFF_M * STAND_OFF_M, arm2 = PULL.armClearM * PULL.armClearM;
    const restB = new Float64Array(hull.nLabels).fill(Infinity);           // the solids rest against nothing (checked below: nothing within 0.2 m)
    const J = { ey: 0, ez: 0, wy: 0, wz: 0 };
    const ay = [], az = [];
    const loc = new THREE.Vector3();
    for (let n = 0; ; n++) {
      const Dg = +(GRIP_DIST_MAX_M - n * PULL.stepM).toFixed(3);
      if (Dg < GRIP_DIST_MIN_M - 1e-9) break;
      const c = { Dg, busM: Infinity, busPart: '', catchM: Infinity, armM: Infinity, near: 0, approach: null, ok: false };
      if (dbg) dbg.cands.push(c);
      // 1. the solids against every piece aboard, swept out along the approach
      let best2 = Infinity, part = -1;
      scan: for (const w of W) {
        for (let i = 0; i < w.length; i += 3) {
          const x = w[i], y = w[i + 1], z = w[i + 2] + Dg;
          for (let k = 0; k < nBox; k++) {
            const d2 = boxD2(x, y, z, ext[k]);
            if (d2 < best2) { best2 = d2; part = k; }
          }
          if (best2 < stand2 && !(dbg && n === 0)) break scan;
          _work.n += nBox * 0.04;
          if (WORK_DUE()) { _work.n = 0; yield; }
        }
      }
      c.busM = Math.sqrt(best2); c.busPart = part >= 0 ? model.names[part] : '';
      if (best2 < stand2) continue;
      // 2. the nose catch and the tip bags
      for (const s of spheres) {
        let m = Infinity;
        for (let k = 0; k < nBox; k++) { const d2 = boxD2(s.x, s.y, s.z + Dg, ext[k]); if (d2 < m) m = d2; }
        c.catchM = Math.min(c.catchM, Math.sqrt(m) - s.r);
      }
      if (c.catchM < STAND_OFF_M) continue;
      // 3. the arm's links, at the hover and along the end of the reach, against the pieces near its plane
      let armBest2 = Infinity;
      for (const t of PULL.poses) {
        armJoints(RAISE.y * (1 - t), lerp(RAISE.z, Dg, t), J);
        ay.length = 0; az.length = 0;
        const linkTo = (y0, z0, y1, z1) => {
          const n = Math.max(1, Math.ceil(Math.hypot(y1 - y0, z1 - z0) / PULL.armStepM));
          for (let i = 0; i <= n; i++) { ay.push(y0 + (y1 - y0) * i / n); az.push(z0 + (z1 - z0) * i / n); }
        };
        linkTo(ARM_BASE.y, ARM_BASE.z, J.ey, J.ez);
        linkTo(J.ey, J.ez, J.wy, J.wz);
        for (let a = 0; a < ay.length; a++) {
          for (let i = 0; i < B.length; i += 3) {
            const dy = B[i + 1] - ay[a], dz = B[i + 2] + Dg - az[a];
            const d2 = B[i] * B[i] + dy * dy + dz * dz;
            if (d2 < armBest2) armBest2 = d2;
          }
          _work.n += B.length / 3 * 0.02;
          if (WORK_DUE()) { _work.n = 0; yield; }
        }
      }
      c.armM = Math.sqrt(armBest2);
      if (armBest2 < arm2) continue;
      // 4. nothing of her hardware or her daughters within 0.2 m of the solids at the hover
      const H0 = new THREE.Vector3().copy(G).addScaledVector(u, Dg);
      const bodyHer = new Float64Array(model.pts.length);
      for (let i = 0; i < model.pts.length; i += 3) {
        loc.set(model.pts[i], model.pts[i + 1], model.pts[i + 2]).applyQuaternion(Q).add(H0);
        bodyHer[i] = loc.x; bodyHer[i + 1] = loc.y; bodyHer[i + 2] = loc.z;
        if (hull.nearAt(loc.x, loc.y, loc.z)) c.near++;
      }
      _work.n += model.pts.length / 40;
      if (c.near > 0) continue;
      // 5. the straight run in along the approach (the line out, reversed) passes the haul rule with the solids alone
      const cl = yield* clusterPoints(bodyHer, PLAN.clusterM);
      const run = yield* sweepLine({ fields: [hull], pc: bodyHer, pa: new Float64Array(0), cl, clA: [], restP: restB, restA: restB, nBody: 0, restB }, u);
      c.approach = run > 0;
      if (!(run > 0)) continue;
      c.ok = true;
      if (dbg) dbg.picked = c.Dg;
      return { Dg, H0, body: bodyHer };
    }
    return null;
  }

  /** Where a body is in HER frame now, metres, and the attitude it is drawn at (null: none). The same read `takePiece` pins it by. */
  _bodyPose(d) {
    const p = this.player;
    const inv = this._tqA.copy(p.quaternion).invert();
    const cM = new THREE.Vector3().copy(d._scenePosition).sub(p.position).applyQuaternion(inv).multiplyScalar(1 / M);
    let qRel = null;
    if (d.tumbleAxis && Number.isFinite(d.tumbleAngle)) {
      qRel = new THREE.Quaternion().setFromAxisAngle(this._tpA.copy(d.tumbleAxis).normalize(), d.tumbleAngle);
      qRel.premultiply(inv);
    }
    return { cM, qRel };
  }

  /**
   * Her meshes and her docked daughters' meshes as one triangle field (her frame, metres), built in slices (a generator). Each mesh of the ship and
   * each mesh of each docked daughter is its OWN part (label), so a piece that touches one of its daughter's parts at rest is held to the rule for
   * that part only. Drawn effects are not hardware (`isFxMesh`); a daughter out in space is no obstacle.
   */
  *_hullTriField() {
    _work.at = 'hull-list';
    const sources = [];
    const p = this.player;
    if (p && typeof p.traverse === 'function' && p.matrixWorld) {
      const S = new THREE.Matrix4().makeScale(1 / M, 1 / M, 1 / M);
      let label = 0;
      const visit = (root, detail, skip, prefix) => {
        // (her frame is read afresh for each part of the list: the planner yields between them, and she moves in the world between frames)
        p.updateMatrixWorld(true);
        if (root !== p) root.updateWorldMatrix(true, true);
        const inv = new THREE.Matrix4().copy(p.matrixWorld).invert();
        root.traverse((o) => {
          if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || !o.geometry || !o.geometry.getAttribute('position') || isFxMesh(o)) return;
          if (!detail.has(o) && !o.visible) return;
          if (hiddenMaterials(o)) return;
          for (let q = o.parent; q && q !== root; q = q.parent) if (!q.visible && !skip.has(q)) return;
          const mw = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld).premultiply(S);
          sources.push({ geo: o.geometry, e: mw.elements.slice(), label: label++, name: prefix + (o.name || '?') });
        });
      };
      visit(p, new Set(p._detailMeshes || []), new Set(), '');
      yield;
      const am = p.armManager;
      const arms = (am && am.arms) || [];
      for (let i = 0; i < arms.length; i++) {
        const arm = arms[i];
        if (!arm || !arm.group || !AT_STRUT_STATES.has(arm.state)) continue;
        if (arm.state === 'LAUNCHING' && arm._springFired) continue;
        visit(arm.group, new Set(arm._detailMeshes || []), new Set([arm.mesh]), `daughter${i}:`);
        yield;
      }
    }
    return yield* buildTriField(sources, this._poolOff ? null : (this._hullPool || (this._hullPool = newGridPool())));
  }

  /**
   * The other pieces aboard (not in `gone`) as a triangle field: each piece's drawn mesh (a ball of its true reach when it has none) at the place and
   * attitude it is held at, one label per piece from `labelBase` on. Null when no other piece is aboard.
   */
  *_othersTriField(except, gone, labelBase) {
    const sources = [];
    this._aboardRecs(except, gone).forEach((r, n) => {
      const d = r.piece;
      const geo = d.isBag === true || !d.type ? null : DebrisWireframe.getGeometry(d.type, d.id);
      const sc = DebrisField.effectiveRenderScale(d) / M;
      const q = r.qRel || new THREE.Quaternion();
      if (geo && geo.getAttribute && sc > 0) {
        sources.push({ geo, e: new THREE.Matrix4().compose(r.cM, q, new THREE.Vector3(sc, sc, sc)).elements.slice(), label: labelBase + n, name: `piece${n}` });
      } else {
        const rr = Math.max(0.1, DebrisField.trueReachM(d, d.sizeMeter || 1));
        sources.push({ geo: new THREE.IcosahedronGeometry(1, 2), e: new THREE.Matrix4().compose(r.cM, q, new THREE.Vector3(rr, rr, rr)).elements.slice(), label: labelBase + n, name: `piece${n}` });
      }
    });
    if (!sources.length) return null;
    // the grids are built in ONE pool the planner keeps (about 10 MB a piece otherwise: the allocations set off the collector mid-frame). The
    // field is dropped when its piece's plan is made, before the next piece's is built; `_planNow` (a plan made while a job's plan may be paused)
    // never shares it.
    if (!this._poolOff && !this._gridPool) this._gridPool = newGridPool();
    return yield* buildTriField(sources, this._poolOff ? null : this._gridPool);
  }

  /** Every other piece aboard not in `gone`, as `{ piece, cM, qRel }` in HER frame: the ones in line and on a daughter's rack, where drawn now. */
  _aboardRecs(except, gone = null) {
    const out = [];
    const seen = new Set([except]);
    if (gone) for (const b of gone.bodies) seen.add(b);
    for (const r of (this._take ? [this._take.rec, ...this._takes] : this._takes)) {
      if (r.done || r.piece.alive === false || seen.has(r.piece)) continue;
      seen.add(r.piece);
      out.push(r);
    }
    const am = this.player && this.player.armManager;
    const arms = (am && am.arms) || [];
    for (const arm of arms) {
      const held = arm && arm.heldCatches;
      if (!held) continue;
      for (const d of held) {
        if (!d || seen.has(d) || d.alive === false || !d._scenePosition) continue;
        seen.add(d);
        const pose = this._bodyPose(d);
        out.push({ piece: d, cM: pose.cM, qRel: pose.qRel });
      }
    }
    return out;
  }

  /**
   * The way a piece is hauled out, MEASURED (a generator): a straight line, tried in turn from straight aft (a rack piece: in the plane
   * through her axis and the satellite, 0 to 90 deg off aft in `PLAN.alphaStepDeg`) or from straight ahead (the nose piece: then a cone
   * about it). Every sample point of the piece (`haulRulePoints`), the grip head and the arm's links are swept along the line against the
   * exact triangles of her hardware, her daughters and the other pieces aboard (`HAUL_RULE`), and the first line that passes (with
   * `PLAN.marginM` to spare) runs until everything carried is 0.5 m clear. Null when none passes.
   * `body` (a hover pulled in, `_pullInGen`): the satellite's solids' sample points at the hover, her frame: carried too, held to the rule
   * against everything that is not the piece (nothing is near them at the start), since the bus is no longer beyond everything aboard.
   * @returns {{dir: THREE.Vector3, len: number, alphaDeg: number}|null}
   */
  *_planHaulGen(rec, nose, side, H0, Q, Dg, gone, hull, body = null) {
    const others = yield* this._othersTriField(rec.piece, gone, hull.nLabels);
    const fields = others ? [hull, others] : [hull];
    const nL = others ? others.nLabels : hull.nLabels;
    // everything carried that is held to the piece's rule, in her frame: the piece's sample points and a ball about the grip head (on the piece)
    const rp = yield* haulRuleGen(rec.piece);
    _work.at = 'carried';
    const nP = rp.length / 3;
    const pc = new Float64Array(rp.length + 40 * 3 + (body ? body.length : 0));
    const v = this._tpB;
    const q = rec.qRel;
    for (let i = 0; i < nP; i++) {
      v.set(rp[3 * i], rp[3 * i + 1], rp[3 * i + 2]);
      if (q) v.applyQuaternion(q);
      pc[3 * i] = v.x + rec.cM.x; pc[3 * i + 1] = v.y + rec.cM.y; pc[3 * i + 2] = v.z + rec.cM.z;
      _work.n += 0.25;
      if (WORK_DUE()) { _work.n = 0; yield; }
    }
    const J = armJoints(0, Dg, _AJ);
    const loc = new THREE.Vector3();
    const toHer = (x, y, z) => loc.set(x, y, z).applyQuaternion(Q).add(H0);
    const tip = toHer(0, J.wy, J.wz + WRIST_M).clone();
    let np = nP * 3;
    sampleBall(tip.x, tip.y, tip.z, 0.1, 40, (x, y, z) => { pc[np++] = x; pc[np++] = y; pc[np++] = z; });
    const iBody = np;
    if (body) pc.set(body, iBody);
    const arm = [];
    const seg = (ay, az, by, bz) => {
      const n = Math.max(1, Math.ceil(Math.hypot(by - ay, bz - az) / 0.05));
      for (let i = 0; i <= n; i++) { const t = i / n; const w = toHer(0, lerp(ay, by, t), lerp(az, bz, t)); arm.push(w.x, w.y, w.z); }
    };
    seg(ARM_BASE.y, ARM_BASE.z, J.ey, J.ez);
    seg(J.ey, J.ez, J.wy, J.wz);
    const pa = Float64Array.from(arm);

    _work.at = 'rest';
    const restP = new Float64Array(nL).fill(Infinity), restA = new Float64Array(nL).fill(Infinity);
    for (let i = 0; i < iBody; i += 3) {
      for (const F of fields) if (F.nearAt(pc[i], pc[i + 1], pc[i + 2])) F.restAt(pc[i], pc[i + 1], pc[i + 2], restP);
      if (WORK_DUE()) { _work.n = 0; yield; }
    }
    // the same on a DENSER sample of the drawn surface (`restStepM`): a part the piece touches must read as touched, not 1-3 cm off between samples
    yield* restDenseGen(rec, fields, restP);
    for (let i = 0; i < pa.length; i += 3) {
      for (const F of fields) F.wideRestAt(pa[i], pa[i + 1], pa[i + 2], restA);
      if (WORK_DUE()) { _work.n = 0; yield; }
    }

    _work.at = 'cluster';
    const cl = yield* clusterPoints(pc, PLAN.clusterM);
    const clA = yield* clusterPoints(pa, 0.2);
    yield;
    const dirs = [];
    if (nose) {
      dirs.push({ d: new THREE.Vector3(0, 0, 1), deg: 0 });
      for (let a = PLAN.noseConeStepDeg; a <= PLAN.noseConeDeg + 1e-9; a += PLAN.noseConeStepDeg) {
        for (let k = 0; k < 8; k++) {
          const ph = k * Math.PI / 4, ar = degToRad(a);
          dirs.push({ d: new THREE.Vector3(Math.sin(ar) * Math.cos(ph), Math.sin(ar) * Math.sin(ph), Math.cos(ar)), deg: a });
        }
      }
    } else {
      for (let deg = 0; deg <= PLAN.alphaMaxDeg + 1e-9; deg += PLAN.alphaStepDeg) {
        const a = degToRad(deg);
        dirs.push({ d: new THREE.Vector3(0, side * Math.sin(a), -Math.cos(a)), deg });
      }
    }
    const ctx = { fields, hull, pc, pa, cl, clA, restP, restA, nBody: body ? iBody / 3 : undefined, restB: body ? new Float64Array(nL).fill(Infinity) : null };
    const stay = body ? yield* this._haulStayGen(rec, gone, H0, Q) : null;
    _work.at = 'sweep';
    for (const o of dirs) {
      const len = yield* sweepLine(ctx, o.d);
      if (len <= 0) continue;
      if (stay && !(yield* this._haulSolidsClearGen(stay, Q, o.d, len))) continue;
      return { dir: o.d.clone(), len, alphaDeg: o.deg };
    }
    return null;
  }

  /**
   * What the satellite's solids keep `STAND_OFF_M` from along a haul from a hover pulled in: every other piece aboard (its sample points) and the
   * nose catch / tip-bag spheres, in the satellite's frame at the hover (same frame and numbers as `_pullInGen`). The triangle fields cover 4.2 m
   * about her axis and the satellite hovers beyond it, while a piece aboard reaches farther (7.69 m measured), so the sweep alone cannot see them.
   * @returns {{pts: Float64Array, spheres: {x: number, y: number, z: number, r: number}[], lo: number[], hi: number[]}}
   *   `lo`/`hi`: the box round the solids
   */
  *_haulStayGen(rec, gone, H0, Q) {
    const Qi = new THREE.Quaternion().copy(Q).invert();
    const v = new THREE.Vector3();
    const out = [];
    for (const r of this._aboardRecs(rec.piece, gone)) {
      const rp = yield* haulRuleGen(r.piece);
      for (let i = 0; i < rp.length; i += 3) {
        v.set(rp[i], rp[i + 1], rp[i + 2]);
        if (r.qRel) v.applyQuaternion(r.qRel);
        v.add(r.cM).sub(H0).applyQuaternion(Qi);
        out.push(v.x, v.y, v.z);
        _work.n += 0.3;
        if (WORK_DUE()) { _work.n = 0; yield; }
      }
    }
    const spheres = [];
    const am = this.player && this.player.armManager;
    if (am && typeof am._heldCatchSpheres === 'function') {
      for (const s of am._heldCatchSpheres()) {
        if (/^rack catch/.test(s.name || '')) continue;
        v.set(s.c[0], s.c[1], s.c[2]).sub(H0).applyQuaternion(Qi);
        spheres.push({ x: v.x, y: v.y, z: v.z, r: s.r });
      }
    }
    const boxes = this._bodyModel().boxes;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const b of boxes) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], b[2 * a]); hi[a] = Math.max(hi[a], b[2 * a + 1]); }
    return { pts: Float64Array.from(out), spheres, lo, hi };
  }

  /**
   * The solids carried `len` m along `dir` (her frame) keep `STAND_OFF_M` from `stay` (`_haulStayGen`), measured every `PULL.haulStepM` (the
   * distance to a box changes by no more than the step, so a pass is at least `STAND_OFF_M` less half a step). A point whose line never comes
   * near the box round all
   * the solids is skipped whole.
   * @returns {boolean}
   */
  *_haulSolidsClearGen(stay, Q, dir, len) {
    const model = this._bodyModel();
    const boxes = model.boxes, nBox = boxes.length;
    const d = new THREE.Vector3().copy(dir).applyQuaternion(new THREE.Quaternion().copy(Q).invert());
    const n = Math.max(1, Math.ceil(len / PULL.haulStepM));
    const m = STAND_OFF_M + PULL.haulStepM;
    const near = (x, y, z, r) => {  // the point's whole line against the solids' box, grown by the stand-off (+ the sphere's radius)
      const P = [x, y, z], D = [-d.x * len, -d.y * len, -d.z * len];
      let t0 = 0, t1 = 1;
      for (let a = 0; a < 3; a++) {
        const lo = stay.lo[a] - m - r, hi = stay.hi[a] + m + r;
        if (Math.abs(D[a]) < 1e-12) { if (P[a] < lo || P[a] > hi) return false; continue; }
        let s0 = (lo - P[a]) / D[a], s1 = (hi - P[a]) / D[a];
        if (s0 > s1) { const t = s0; s0 = s1; s1 = t; }
        t0 = Math.max(t0, s0); t1 = Math.min(t1, s1);
        if (t0 > t1) return false;
      }
      return true;
    };
    const hit = (x, y, z, r) => {
      const lim2 = (STAND_OFF_M + r) * (STAND_OFF_M + r);
      for (let i = 1; i <= n; i++) {
        const s = Math.min(len, i * PULL.haulStepM);
        const px = x - d.x * s, py = y - d.y * s, pz = z - d.z * s;
        for (let k = 0; k < nBox; k++) if (boxD2(px, py, pz, boxes[k]) < lim2) return true;
      }
      return false;
    };
    for (const s of stay.spheres) {
      if (near(s.x, s.y, s.z, s.r) && hit(s.x, s.y, s.z, s.r)) return false;
    }
    const P = stay.pts;
    for (let i = 0; i < P.length; i += 3) {
      if (!near(P[i], P[i + 1], P[i + 2], 0)) continue;
      if (hit(P[i], P[i + 1], P[i + 2], 0)) return false;
      _work.n += n * nBox * 0.04;
      if (WORK_DUE()) { _work.n = 0; yield; }
    }
    return true;
  }

  /**
   * The way from where it stands to `tgt` ({side: +1 / -1 for a rack hover, 0 for the axis ahead of her, P, Q, dock?}) as waypoints {P, Q} in HER
   * frame. Every stretch keeps the whole craft beyond a plane or a cylinder that holds everything aboard: out and in along the approach axis; round
   * her on a ring of radius `rho` (the bus front face `ARC_MARGIN_M` outside the farthest thing aboard and her open radiators), 45 deg chords;
   * and at the
   * fore station (z >= `top`, the craft's own radius ahead of everything) any sideways move or turn.
   */
  _routeTo(tgt) {
    const sph = this._aboardSpheres(null);
    let R = SHIP_KEEP_R_M, top = Z_FORE_M;
    for (const s of sph) { R = Math.max(R, Math.hypot(s.x, s.y) + s.r); top = Math.max(top, s.z + s.r + SAT_R_M + 0.5); }
    const rho = R + BUS_FRONT_M + ARC_MARGIN_M;
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const P0 = this._fp, s0 = this._side;
    const P1 = tgt.dock ? V(this._collarM.x, this._collarM.y, top) : tgt.P;
    const pts = [{ P: P0.clone(), Q: this._fq.clone() }];
    const go = (x, y, z, q) => pts.push({ P: V(x, y, z), Q: q });
    const qS = (s) => qRackPhi(s * Math.PI / 2);
    if (s0 !== 0) {
      const r0 = Math.max(rho, Math.abs(P0.y));
      go(P0.x, s0 * r0, P0.z, qS(s0));
      if (tgt.side === s0) {
        go(P1.x, s0 * r0, P1.z, qS(s0));
      } else if (tgt.side === -s0) {
        const rc = r0 / Math.cos(Math.PI / 8);                            // round her: 45 deg chords whose mid points are on the ring
        for (let k = 1; k <= 3; k++) {
          const phi = s0 * (Math.PI / 2 - k * Math.PI / 4);
          go(rc * Math.cos(phi), rc * Math.sin(phi), lerp(P0.z, P1.z, k / 4), qRackPhi(phi));
        }
        go(P1.x, tgt.side * r0, P1.z, qS(tgt.side));
      } else {
        go(P0.x, s0 * r0, top, qS(s0));
        go(P1.x, P1.y, top, tgt.Q);
      }
    } else if (tgt.side !== 0) {
      const zA = Math.max(P0.z, top);
      if (P0.z < zA) go(P0.x, P0.y, zA, this._fq.clone());               // forward off her nose first, along the axis
      go(P1.x, tgt.side * rho, zA, qS(tgt.side));
      go(P1.x, tgt.side * rho, P1.z, qS(tgt.side));
    }
    go(P1.x, P1.y, P1.z, tgt.Q);
    return pts;
  }

  /** A flight along waypoints: one smoothstep over the whole way (a turn counts as FETCH_TURN_M_PER_RAD metres per radian). */
  _travel(pts, side, dock = false) {
    const seg = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const ang = 2 * Math.acos(Math.min(1, Math.abs(a.Q.dot(b.Q))));
      const len = a.P.distanceTo(b.P) + FETCH_TURN_M_PER_RAD * ang;
      seg.push(len); total += len;
    }
    const dur = total < 1e-6 ? 0 : Math.min(FETCH_LEG_MAX_S, Math.max(FETCH_LEG_MIN_S, total / FETCH_SPEED_MPS));
    return { k: 'travel', pts, seg, total, dur, side, dock };
  }

  _travelPose(leg, e) {
    const u = e * leg.total;
    let acc = 0;
    const last = leg.pts.length - 1;
    for (let i = 0; i < leg.seg.length; i++) {
      if (u <= acc + leg.seg[i] || i === leg.seg.length - 1) {
        const f = leg.seg[i] > 1e-9 ? Math.min(1, (u - acc) / leg.seg[i]) : 1;
        this._fp.lerpVectors(leg.pts[i].P, leg.pts[i + 1].P, f);
        this._fq.slerpQuaternions(leg.pts[i].Q, leg.pts[i + 1].Q, f);
        return;
      }
      acc += leg.seg[i];
    }
    this._fp.copy(leg.pts[last].P);
    this._fq.copy(leg.pts[last].Q);
  }

  /** The next piece to take: the one on her nose first (the collar must be free to dock), then the rack piece that sticks out farthest on its side
   *  (it may be in the way of a smaller one behind it; once it is gone the others are nearer the hover plane). */
  _pickNext() {
    let bi = 0, best = -Infinity;
    for (let i = 0; i < this._takes.length; i++) {
      const rec = this._takes[i];
      if (rec.nose) return this._takes.splice(i, 1)[0];
      const u = this._tpA.set(0, rec.cM.y < 0 ? -1 : 1, 0);
      const s = this._support(rec, u);
      if (s > best + 1e-9) { best = s; bi = i; }
    }
    return this._takes.splice(bi, 1)[0];
  }

  _planNext() {
    while (this._takes.length > 0) {
      const rec = this._pickNext();
      if (rec.piece.alive === false) { rec.done = true; continue; }
      const plan = rec.plan || this._planNow(rec);
      rec.plan = null;
      if (!plan) { this._skipped++; this._finishRec(rec); continue; }   // (unreachable: a piece is never taken without a plan that fits it)
      this._take = { rec, plan, phase: 'fly' };
      this._legs.push(
        this._travel(this._routeTo({ side: plan.side, P: plan.H0, Q: plan.Q }), plan.side),
        { k: 'reach', dur: TAKE_REACH_S }, { k: 'grip', dur: TAKE_GRIP_S }, { k: 'haul', dur: TAKE_S }, { k: 'home', dur: TAKE_HOME_S });
      return;
    }
    // a plan is still being made, or a piece it could not take is on the collar: it waits where it is
    if (this._holdsDock()) { this._legs.push({ k: 'wait', dur: 0 }); return; }
    this._legs.push(this._travel(this._routeTo({ side: 0, P: null, Q: QY_PI.clone(), dock: true }), 0, true));
  }

  _planNow(rec) {
    const drive = (g) => { for (;;) { const r = g.next(); if (r.done) return r.value; } };
    this._poolOff = true;
    try { return drive(this._planTakeGen(rec, null, drive(this._hullTriField()))); } finally { this._poolOff = false; }
  }

  _holdsDock() {
    if (this._jobs.length > 0) return true;
    return !!(this._dockGate && this._dockGate());
  }

  _nextLeg() {
    for (let guard = 0; guard < 16; guard++) {
      if (this._legs.length === 0) this._planNext();
      const leg = this._legs.shift();
      if (this._startLeg(leg)) { this._leg = leg; this._legT = 0; return true; }
    }
    return false;
  }

  /** @returns {boolean} false = skip this leg (its piece is gone: nothing to reach, grip or haul) */
  _startLeg(leg) {
    const tk = this._take;
    switch (leg.k) {
      case 'travel': if (tk) tk.phase = 'fly'; return true;
      case 'reach':
      case 'grip':
      case 'haul': {
        if (!tk || tk.rec.piece.alive === false) {
          if (leg.k === 'reach' || !tk) { this._legs.length = 0; this._take = null; } else this._legs = this._legs.filter((l) => l.k === 'home');
          return false;
        }
        tk.phase = leg.k === 'haul' ? 'carry' : leg.k;
        if (leg.k === 'reach') this._fetchHold.copy(tk.plan.hold);
        return true;
      }
      case 'home': if (tk) tk.phase = 'home'; return true;
      default: return true;
    }
  }

  _endLeg(leg) {
    this._leg = null;
    const tk = this._take;
    if (leg.k === 'travel') {
      this._side = leg.side;
      if (leg.dock && this._takes.length === 0) this._toDocking();     // (a piece handed over while it flew to the dock is taken first)
    } else if (leg.k === 'haul') {
      if (tk) this._finishRec(tk.rec);
    } else if (leg.k === 'home') {
      this._take = null;
    }
  }

  /** 'fetch': one frame of the flight plan (`dt` real seconds for the draw-off after 'left', `g` game seconds for everything else). */
  _advanceFetch(dt, g) {
    if (!this._leg && !this._nextLeg()) return;
    const leg = this._leg;
    if (leg.k === 'away') {
      this._legT += dt;
      this._armS = leg.armFrom * (1 - smooth(this._legT / RELEASE_S));
      const t = Math.max(0, this._legT - DRIFT_START_S);
      this._fp.copy(leg.p0).addScaledVector(leg.dir, 0.5 * DRIFT_ACCEL * t * t);
      if (this._fp.length() >= HIDE_DIST_M) { this._state = 'hidden'; this._leg = null; this._armS = 0; this._synced = true; }
      return;
    }
    this._legT += g;
    if (leg.k === 'wait') {
      if (this._takes.length > 0 || !this._holdsDock()) { this._leg = null; this._gateS = 0; return; }
      if (this._jobs.length === 0 && this._dockGate) {  // only the collar holds it: the existing cap, then it goes away without docking
        this._gateS += g;
        if (this._gateS > TAKE_WAIT_MAX_S) this._giveUpDock();
      }
      return;
    }
    const f = leg.dur > 0 ? Math.min(1, this._legT / leg.dur) : 1;
    const e = smooth(f);
    const tk = this._take;
    switch (leg.k) {
      case 'depart': this._armS = 1 - e; break;
      case 'travel': this._travelPose(leg, e); this._armS = 0; break;
      case 'reach': this._armS = e; break;
      case 'grip': this._armS = 1; break;
      case 'haul': this._armS = 1; this._fp.lerpVectors(tk.plan.H0, tk.plan.H1, e); break;
      case 'home': this._armS = 1 - e; break;
      default: break;
    }
    if (f >= 1) this._endLeg(leg);
  }

  /** After the arm is posed: every piece the satellite has in hand or in line stays pinned (the haul: on the grip, rigid with it). */
  _servicePieces() {
    if (this._takes.length === 0 && !this._take) return;
    for (let i = this._takes.length - 1; i >= 0; i--) {
      const rec = this._takes[i];
      if (rec.piece.alive === false) { this._takes.splice(i, 1); continue; }
      if (!this._take) rec.waitS += this._gdt;  // only time with no take running counts: a long line of takes never starves the last piece
      if (rec.waitS > TAKE_WAIT_MAX_S) {
        // no piece waits for ever, and none is thrown away undrawn (it is already freed and paid): the satellite goes for it now, the swaps queued
        // give way (a piece handed over while it was hidden or hovering: it comes and takes it)
        rec.waitS = 0;
        if (this._state === 'mated') { this._swapQueue.length = 0; if (this._swapT >= 0) { this._swapT = -1; this._restoreCarts(); } }
        else if (this._state === 'hidden' || this._state === 'hover') { this._distFrom = this._dist; this._beginFetch(); }
      }
      this._pinRec(rec);
    }
    const tk = this._take;
    if (!tk || tk.rec.done || tk.rec.piece.alive === false) return;
    if (tk.phase === 'carry') {
      // the piece hangs on the grip where it was gripped: grip point to centre is fixed in her frame (the satellite does not turn while hauling)
      const off = this._tpB.copy(tk.plan.gripOff).multiplyScalar(M).applyQuaternion(this.player.quaternion);
      this._pinTo(tk.rec, this.getEffectorWorldPosition(this._tpC).add(off));
    } else {
      this._pinRec(tk.rec);
    }
  }

  reset() {
    this._flushTakes();
    this._gridPool = null; this._hullPool = null;
    this._jobs.length = 0;
    this._fold = null;
    this._dockGate = null; this._dockGiveUp = null; this._gateS = 0;
    this._state = 'hidden';
    this._synced = false;
    this._t = 0;
    this._armS = 0; this._armFrom = 0; this._w = 0; this._wFrom = 0;
    this._side = 0; this._legT = 0;
    this._fetchHold.copy(SWAP_HOLD);
    this._swapQueue.length = 0; this._swapT = -1; this._gasT = -1; this._gasPending = false;
    this._flowI = 0; this._dt = 0; this._gdt = 0;
    this._speed = 0;
    this.group.visible = false;
    this._setNear(false);
    this._restoreCarts();
    this._poseArm();
    this._poseLine();
  }

  /**
   * @param {number} dt real seconds (the berth, the cartridge swaps and the gas show play on it: they play while the world is held)
   * @param {number} [gameDt=dt] GAME seconds: zero while the world is held. The take of a big piece runs on this
   */
  update(dt, gameDt = dt) {
    const player = this.player;
    if (!player) return;
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    const gdt = Math.min(Math.max(gameDt || 0, 0), 0.1);

    // a load or a new gameplay start while berthed emits nothing: read the registry once and appear already mated
    if (!this._synced) {
      this._synced = true;
      const reg = this.fieldRegistry;
      if (this._state === 'hidden' && reg && typeof reg.isBerthed === 'function' && reg.isBerthed()) {
        const sat = typeof reg.berthedSatellite === 'function' ? reg.berthedSatellite() : null;
        this._satId = sat ? sat.id : this._satId;
        this._altKm = sat ? sat.altKm : this._altKm;
        this._state = 'mated';
        this._dist = MATED_DIST_M;
        this._armS = 1;
      }
    }

    this._dt = dt;
    this._gdt = gdt;
    this._serviceJobs(gdt);
    this._advance(dt, gdt);
    this._place();
    this._poseArm();
    this._poseLine();
    this._servicePieces();
    this._syncTakeLock();

    let floor = null;
    if (this._floor) { try { floor = this._floor(); } catch (_e) { floor = null; } }
    this.group.visible = this._state !== 'hidden' && floor !== 4 && floor !== 5;
    this._updateNearMembership();
  }

  _advance(dt, g = dt) {
    switch (this._state) {
      case 'coming': {
        this._t += dt;
        const s = Math.min(1, this._t / this._playS);
        this._dist = lerp(COMING_START_M, HOVER_DIST_M, 1 - (1 - s) * (1 - s));
        if (s >= 1) { this._dist = HOVER_DIST_M; this._state = 'hover'; }
        break;
      }
      case 'fetch': {
        this._advanceFetch(dt, g);
        break;
      }
      case 'docking': {
        this._t += dt;
        this._dist = lerp(this._distFrom, MATED_DIST_M, smooth(this._t / GLIDE_S));
        this._armS = lerp(this._armFrom, 1, smooth(this._t / CLOSE_S));
        if (this._t >= CLOSE_S) { this._dist = MATED_DIST_M; this._armS = 1; this._state = 'mated'; this._t = 0; }
        break;
      }
      case 'mated': {
        this._armS = 1;
        this._dist = MATED_DIST_M;
        if (this._swapT < 0 && this._swapQueue.length > 0) {
          this._swapKind = this._swapQueue.shift();
          this._swapT = 0;
          this._swapSlot = this._swapKind === 'indium' ? this._inSwapCount++ % IN_SLOT_Z.length : this._swapCount++ % SLOT_Z.length;
        }
        if (this._swapT >= 0) {
          this._swapT += dt;
          if (this._swapT >= SWAP_S) { this._swapT = -1; this._restoreCarts(); }
        }
        // a piece handed over while it is mated (picked from the list): once the swaps are done it lets go, takes it and docks again
        if (this._swapT < 0 && this._swapQueue.length === 0 && this._takes.length > 0) { this._beginFetch(); break; }
        // gas flows only while the grip is on her ring (no swap running or queued); a flow cut off by a swap pauses and resumes after it
        if (this._swapT < 0 && this._swapsQueued === 0) {
          if (this._gasPending && this._gasT < 0) { this._gasPending = false; this._gasT = 0; }
          if (this._gasT >= 0) {
            this._gasT += dt;
            if (this._gasT >= GAS_S) this._gasT = -1;
          }
        }
        break;
      }
      case 'leaving': {
        this._t += dt;
        this._armS = 1 - smooth(this._t / RELEASE_S);
        if (this._t > DRIFT_START_S) {
          this._speed += DRIFT_ACCEL * dt;
          this._dist += this._speed * dt;
        }
        if (this._dist >= HIDE_DIST_M) { this._state = 'hidden'; this._armS = 0; this._synced = true; }
        break;
      }
      default: break;
    }
  }

  /** Weight of her nose frame in the placement now: 1 docked, 0 on her orbit (coming, waiting), easing between while it glides in or drifts out. */
  _noseWeight() {
    switch (this._state) {
      case 'mated': return 1;
      case 'docking': return lerp(this._wFrom, 1, smooth(this._t / GLIDE_S));
      case 'leaving': return this._wFrom * (1 - smooth((this._dist - 5) / 5));  // keeps her nose line until clear of her hull (5 m), on her orbit by 10 m
      default: return 0;
    }
  }

  /** The group sits `dist` from her collar: along her nose and in her attitude while docked, along her PROGRADE (her velocity) otherwise. */
  _place() {
    const p = this.player;
    const q = p.quaternion;
    if (this._state === 'fetch') {
      this._w = 1;
      this._dist = this._fp.z - this._collarM.z;
      this.group.position.copy(this._fp).multiplyScalar(M).applyQuaternion(q).add(p.position);
      this.group.quaternion.copy(q).multiply(this._fq);
      return;
    }
    const collar = p.getNetBerthCollarPositionInto(this._tmpA);
    const pro = typeof p._progradeQuat === 'function' ? p._progradeQuat(this._qPro) : null;
    const w = pro ? this._noseWeight() : 1;
    this._w = w;
    const dir = this._dirNose.copy(_Z).applyQuaternion(q);
    if (w < 1) {
      this._dirPro.copy(_Z).applyQuaternion(pro);
      dir.multiplyScalar(w).addScaledVector(this._dirPro, 1 - w).normalize();
      this._qBase.slerpQuaternions(pro, q, w);
    } else {
      this._qBase.copy(q);
    }
    this.group.position.copy(collar).addScaledVector(dir, this._dist * M);
    this.group.quaternion.copy(this._qBase).multiply(QY_PI);
  }

  /** Swap timeline: the legs of the running slot (SWAP_LEGS), no allocation. The cartridge is carried from GRAB_AT to INSERT_AT. */
  _swapTip(t, out) {
    const legs = this._swapKind === 'indium' ? IN_SWAP_LEGS[this._swapSlot] : SWAP_LEGS[this._swapSlot];
    let acc = 0;
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      if (t <= acc + leg.d) return out.lerpVectors(leg.a, leg.b, smooth((t - acc) / leg.d));
      acc += leg.d;
    }
    return out.copy(SWAP_HOLD);
  }

  /** Whether the swap has the cartridge in the grip at time t (grabbed at 0.9 s, inserted at 3.2 s). */
  _carrying(t) { return t >= 0.9 && t < 3.2; }

  _pathTip(s, hold, out) {
    const l0 = STOW_TIP.distanceTo(STOW_RISE), l1 = STOW_RISE.distanceTo(RAISE), l2 = RAISE.distanceTo(hold);
    let u = clamp01(s) * (l0 + l1 + l2);
    if (u <= l0) return out.lerpVectors(STOW_TIP, STOW_RISE, u / l0);
    u -= l0;
    if (u <= l1) return out.lerpVectors(STOW_RISE, RAISE, u / l1);
    return out.lerpVectors(RAISE, hold, Math.min(1, (u - l1) / Math.max(l2, 1e-6)));
  }

  _poseArm() {
    const tip = this._tip;
    const hold = this._state === 'fetch' ? this._fetchHold : this._tmpA.set(0, 0, this._dist);
    if (this._swapT >= 0) this._swapTip(this._swapT, tip);
    else this._pathTip(this._armS, hold, tip);

    // planar two-link IK in the YZ plane (x = 0), elbow always up (+Y). The links keep their length (LINK_M) always: a take is planned from a
    // hover point the arm reaches (GRIP_DIST_MAX_M), never stretched.
    const J = armJoints(tip.y, tip.z, _AJ);
    const ey = J.ey, ez = J.ez, wyc = J.wy, wzc = J.wz;

    const E = this._tmpB.set(0, ey, ez);
    this._elbowM.copy(E);
    this._wristM.set(0, wyc, wzc);
    this._elbow.position.copy(E).multiplyScalar(M);
    this._aim(this._upper, ARM_BASE, E);
    this._fore.position.copy(E).multiplyScalar(M);
    this._aim(this._fore, E, this._tmpV.set(0, wyc, wzc));
    this._wrist.position.set(0, wyc * M, wzc * M);
    this._tip.set(0, wyc, wzc + WRIST_M);

    // the carried cartridge rides in the probe's grip (front end at the tip); otherwise each sits in its slot
    if (this._swapT >= 0) {
      const indium = this._swapKind === 'indium';
      const c = indium ? this._inCarts[this._swapSlot] : this._carts[this._swapSlot];
      const len = indium ? IN_CART.len : CART.len;
      const t = this._swapT;
      if (this._carrying(t)) {
        c.visible = true;
        c.position.set(0, this._tip.y * M, (this._tip.z - len / 2) * M);
      } else if (t >= 3.2) {
        c.visible = false;
      } else {
        c.visible = true;
        c.position.set(0, SLOT_Y * M, (indium ? IN_SLOT_Z[this._swapSlot] : SLOT_Z[this._swapSlot]) * M);
      }
    }
  }

  _aim(grp, a, b) {
    grp.position.set(a.x * M, a.y * M, a.z * M);
    const dir = this._tmpDir.set(b.x - a.x, b.y - a.y, b.z - a.z).normalize();
    grp.quaternion.setFromUnitVectors(_Z, dir);
  }

  _restoreCarts() {
    for (let i = 0; i < this._carts.length; i++) {
      const c = this._carts[i];
      c.visible = true;
      c.position.set(0, SLOT_Y * M, SLOT_Z[i] * M);
    }
    for (let i = 0; i < this._inCarts.length; i++) {
      const c = this._inCarts[i];
      c.visible = true;
      c.position.set(0, SLOT_Y * M, IN_SLOT_Z[i] * M);
    }
  }

  /** The fuel line follows the arm: coupling -> shoulder -> elbow -> wrist -> head back -> effector coupling, all `GAS_LINE_OFFSET_M` to the side
   *  of the arm's plane except the coupling ends. Also drives the flow light (an envelope over the 2 s). No allocation. */
  _poseLine() {
    const L = this._line;
    const x = GAS_LINE_OFFSET_M;
    L[0].copy(GAS_COUPLING);
    L[1].set(x, ARM_BASE.y, ARM_BASE.z);
    L[2].set(x, this._elbowM.y, this._elbowM.z);
    L[3].set(x, this._wristM.y, this._wristM.z);
    L[4].set(x, this._wristM.y, this._wristM.z + GAS_HEAD_BACK_M);
    L[5].set(this._tip.x, this._tip.y, this._tip.z - GAS_END_IN_M);   // ends inside the head (the cap is flat and the run leans ~48 deg to the arm)
    for (let i = 0; i < 5; i++) {
      const a = L[i], b = L[i + 1];
      const seg = this._segs[i];
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const len = Math.hypot(dx, dy, dz);
      seg.position.set(a.x * M, a.y * M, a.z * M);
      if (len > 1e-6) seg.quaternion.setFromUnitVectors(_Z, this._tmpV.set(dx / len, dy / len, dz / len));
      seg.scale.set(1, 1, Math.max(len, 1e-6));
    }
    for (let i = 0; i < 4; i++) this._joints[i].position.set(L[i + 1].x * M, L[i + 1].y * M, L[i + 1].z * M);

    // "gas flowing": the timer only runs while the grip is on her ring (_advance); envelope: 0.4 s up, 0.4 s down
    this._gasOn = this._state === 'mated' && this._gasT >= 0 && this._swapT < 0 && this._swapsQueued === 0 && !this._take;
    let p = 0;
    if (this._gasOn) {
      const t = this._gasT;
      p = t < 0.4 ? smooth(t / 0.4) : (t > GAS_S - 0.4 ? smooth((GAS_S - t) / 0.4) : 1);
    }
    // a swap starting mid-flow (the target drops to 0 at once) fades the light out over FLOW_FADE_S, and it fades back in after: never a cut
    const step = this._dt / FLOW_FADE_S;
    this._flowI += Math.min(step, Math.max(-step, p - this._flowI));
    this._lightMat.emissiveIntensity = 2.5 * this._flowI;
    this._lineMat.emissiveIntensity = 0.5 * this._flowI;
  }

  _updateNearMembership() {
    const want = this.group.visible && this._state !== 'hidden';
    const d = this.group.position.distanceTo(this.player.position) / M;
    if (!this._nearMember && want && d <= NEAR_JOIN_M) this._setNear(true);
    else if (this._nearMember && (!want || d >= NEAR_LEAVE_M)) this._setNear(false);
  }

  _setNear(on) {
    const sm = this.sceneManager;
    if (on === this._nearMember) return;
    this._nearMember = on;
    if (!sm) return;
    if (on && typeof sm.registerNearFieldRoot === 'function') sm.registerNearFieldRoot(this.group);
    else if (!on && typeof sm.unregisterNearFieldRoot === 'function') sm.unregisterNearFieldRoot(this.group);
  }

  getState() { return this._state; }
  isMated() { return this._state === 'mated'; }
  isNearMember() { return this._nearMember; }
  isCarrying() { return this._swapT >= 0 && this._carrying(this._swapT); }
  isSwapping() { return this._swapT >= 0; }
  gasShowing() { return this._gasOn; }

  /** The fuel line's points, satellite-local metres, as of the last update: [bus coupling, shoulder, elbow, wrist, head back, effector coupling]. */
  getFuelLinePointsM() { return this._line; }
  /** Metres from her collar to the bus centre along her +Z. */
  getDistM() { return this._dist; }

  getEffectorLocalM(out = new THREE.Vector3()) { return out.copy(this._tip); }

  getEffectorWorldPosition(out = new THREE.Vector3()) {
    return out.set(this._tip.x * M, this._tip.y * M, this._tip.z * M).applyQuaternion(this.group.quaternion).add(this.group.position);
  }

  getCartridgeWorldPosition(i, out = new THREE.Vector3()) {
    return out.copy(this._carts[i].position).applyQuaternion(this.group.quaternion).add(this.group.position);
  }

  getIndiumCartridgeWorldPosition(i, out = new THREE.Vector3()) {
    return out.copy(this._inCarts[i].position).applyQuaternion(this.group.quaternion).add(this.group.position);
  }

  isTaking() { return !!this._take; }
  takePhase() { return this._take ? this._take.phase : null; }
  takesWaiting() { return this._takes.length; }
  /** Takes the arm could not reach from a clear spot (the piece was taken at once, nothing drawn): 0 in every layout the racks can make today. */
  takesSkipped() { return this._skipped; }
  /** The bus centre in HER frame, metres (the pose of the flight; 'fetch' only, else as last placed), and its attitude relative to hers. */
  getFetchPoseM(outP = new THREE.Vector3(), outQ = new THREE.Quaternion()) { outP.copy(this._fp); outQ.copy(this._fq); return outP; }
  /** The running take's plan: grip point and hover point in HER frame (metres), the arm's reach to the grip, the haul end; null when none runs. */
  getTakePlan() {
    const t = this._take && this._take.plan;
    return t ? { nose: t.nose, side: t.side, grip: t.G.clone(), hover: t.H0.clone(), haulEnd: t.H1.clone(), haulDir: t.dir.clone(), haulM: t.haul, gripDistM: t.Dg, gripOffM: t.gripOff.clone() } : null;
  }

  swapSlot() { return this._swapT >= 0 ? this._swapSlot : -1; }

  swapKind() { return this._swapT >= 0 ? this._swapKind : null; }

  dispose() {
    this._flushTakes();
    this._gridPool = null; this._hullPool = null;
    if (_active === this) _active = null;
    eventBus.off(Events.RESUPPLY_BERTH, this._onBerth);
    eventBus.off(Events.UPGRADE_PURCHASED, this._onPurchase);
    eventBus.off(Events.RESOURCE_UPGRADED, this._onGas);
    eventBus.off(Events.GAME_RESET, this._onReset);
    eventBus.off(Events.GAME_STATE_CHANGE, this._onState);
    this._setNear(false);
    if (this.scene) this.scene.remove(this.group);
    for (const g of this._geos) g.dispose();
    for (const m of this._mats) m.dispose();
  }
}
