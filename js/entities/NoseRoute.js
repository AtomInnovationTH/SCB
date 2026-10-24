/**
 * NoseRoute.js — the way a daughter flies the catch she holds from her strut tip to the mother's nose collar
 * (lane u20-nose; measured in scripts/probes/nose-handoff-path.mjs, docs/research/2026-10-nose-handoff.md).
 *
 * ONE function builds the route for both the game (ArmUnit's nose flight) and the probe that certified it, so the flown
 * path and the certified path are the same numbers. Everything is in the SHIP frame, metres. Waypoints are positions of HER
 * CENTRE; her attitude is slerped from her docked attitude (`q0`, strut at the carry angle) towards the final one (`qf`) by
 * the waypoint's fraction `f`, and between two waypoints both position and attitude are interpolated linearly (slerp).
 *
 * The legs (doc "The route"): her strut is at the carry angle (145°). She backs off along the strut line by `backoffM`
 * (no turn: her own strut is not yet clear), goes straight up (same radius) to the stand-off height (no turn), flies
 * straight in to the axis while turning to `qf` (her body trails up the axis, tilted 30° to the side), then straight down
 * the axis to the seat. All waypoints but her centre are bookkeeping on the CATCH CENTRE: her centre is the catch-centre
 * waypoint less the catch's offset in her frame, rotated by her attitude there.
 *
 * Buckets (nose doc, "Reach buckets"): the route is flown for a VIRTUAL catch of the bucket's top reach `R` (`cVirt`, `zSeatVirt`):
 * that is what the sphere certificate covers (a sphere of reach R about the R-catch's centre contains every smaller catch of
 * the same shape and attitude). A smaller real catch (`cReal`, `zSeatReal`) then goes on from the virtual seat pose to its own
 * seat, one more straight leg (the "extension"), at the same attitude. With no real catch the route ends at the virtual seat.
 */
import * as THREE from 'three';
import { carryFinalQuatInto } from './ArmDockBasis.js';

const DEG = Math.PI / 180;
const _rh = new THREE.Vector3(), _th = new THREE.Vector3(), _c = new THREE.Vector3();

/** Unit direction from the catch towards her centre at the seat: up the axis, tilted `trailDeg` towards the tangent (side) of her azimuth. */
export function noseTrailDirInto(azDeg, trailDeg, out) {
  const az = azDeg * DEG, t = trailDeg * DEG;
  _th.set(-Math.sin(az), Math.cos(az), 0);
  return out.set(0, 0, Math.cos(t)).addScaledVector(_th, Math.sin(t));
}

/**
 * @param {object} p
 * @param {THREE.Quaternion} p.q0         her docked attitude with the strut at the carry angle (ship frame)
 * @param {THREE.Vector3} p.dockPos       her centre at the dock (the strut tip), metres, ship frame
 * @param {THREE.Vector3} p.cVirt         the virtual catch's centre in HER frame (metres): the top-reach catch of the bucket
 * @param {number} p.zSeatVirt            the virtual catch's seat: the z of its centre on the axis (metres, ship frame)
 * @param {THREE.Vector3} [p.cReal]       the real catch's centre in her frame (omit: the route ends at the virtual seat)
 * @param {number} [p.zSeatReal]          the real catch's seat z
 * @param {number} p.azDeg                her dock azimuth (deg)
 * @param {{backoffM:number, standoffM:number, standoffMinZ:number, trailDeg:number}} p.spec
 * @returns {{pos:THREE.Vector3[], quat:THREE.Quaternion[], len:number, seg:number[], cum:number[], qf:THREE.Quaternion,
 *   zTop:number, iVirtSeat:number, lenVirt:number, seatPose:{pos:THREE.Vector3, quat:THREE.Quaternion}}}
 *   pos/quat: one per waypoint (dock, back-off, up, in, virtual seat[, real seat]); iVirtSeat: the index of the virtual seat.
 */
export function buildNoseRoute(p) {
  const { q0, dockPos, cVirt, spec } = p;
  const C0 = _c.copy(cVirt).applyQuaternion(q0).add(dockPos).clone();
  const es = new THREE.Vector3(0, 0, 1).applyQuaternion(q0);
  const u0 = cVirt.clone().negate().applyQuaternion(q0).normalize();
  const trail = noseTrailDirInto(p.azDeg, spec.trailDeg, new THREE.Vector3());
  const qf = carryFinalQuatInto(q0, u0, trail, new THREE.Quaternion());
  const zTop = Math.max(p.zSeatVirt + spec.standoffM, spec.standoffMinZ || 0);
  const C1 = C0.clone().addScaledVector(es, spec.backoffM);
  const wps = [{ C: C0, f: 0 }];
  if (spec.backoffM > 0) wps.push({ C: C1, f: 0 });
  wps.push({ C: new THREE.Vector3(C1.x, C1.y, zTop), f: 0 }, { C: new THREE.Vector3(0, 0, zTop), f: 1 }, { C: new THREE.Vector3(0, 0, p.zSeatVirt), f: 1 });
  const pos = [], quat = [];
  for (const w of wps) {
    const q = q0.clone().slerp(qf, w.f);
    quat.push(q);
    pos.push(w.C.clone().sub(cVirt.clone().applyQuaternion(q)));
  }
  const iVirtSeat = pos.length - 1;
  if (p.cReal) {
    quat.push(qf.clone());
    pos.push(new THREE.Vector3(0, 0, p.zSeatReal).sub(p.cReal.clone().applyQuaternion(qf)));
  }
  const seg = [], cum = [0];
  for (let k = 0; k + 1 < pos.length; k++) { seg.push(pos[k].distanceTo(pos[k + 1])); cum.push(cum[k] + seg[k]); }
  const last = pos.length - 1;
  return { pos, quat, len: cum[last], seg, cum, qf, zTop, iVirtSeat, lenVirt: cum[iVirtSeat], seatPose: { pos: pos[last], quat: quat[last] } };
}

/**
 * The virtual (top-reach) catch's centre in her frame, from the real catch's: the catch is the same shape at the same
 * attitude drawn at `R / r` times the size, its nearest point one net gap off her end whatever the size (`rackCellOffsetInto`,
 * cell 0: z = herSupport + gap + nearest-extent, the extent linear in the size). `h` = herSupport + gap.
 * @param {THREE.Vector3} cReal   (0, 0, h + s) for the real catch
 * @param {number} h              herSupportZM() + ARM_HOLD_NET_GAP_M
 * @param {number} reachM         the real catch's reach
 * @param {number} bucketReachM   the bucket's top reach R
 * @param {THREE.Vector3} out
 */
export function virtualCentreInto(cReal, h, reachM, bucketReachM, out) {
  const k = reachM > 0 ? bucketReachM / reachM : 1;
  return out.set(cReal.x, cReal.y, h + (cReal.z - h) * k);
}

/**
 * The certified bucket a reach falls in: loM < reach <= topM (a bucket is open at the bottom, closed at the top), or null.
 * @param {{loM:number, topM:number}[]} buckets  Constants.CARRY.NOSE.BUCKETS
 * @param {number} reachM
 * @returns {object|null}
 */
export function noseBucketFor(buckets, reachM) {
  if (!Array.isArray(buckets) || !(reachM > 0)) return null;
  for (const b of buckets) if (reachM > b.loM + 1e-9 && reachM <= b.topM + 1e-9) return b;
  return null;
}

/**
 * Are the radiators (shared angle, degrees) where the bucket was certified, with the biggest bag now on a tip (`bagReachM`, 0: none)?
 * `bucket.windowsDeg` is a list of `[loDeg, hiDeg, bagMaxM]`: the radiators may stand in [lo, hi] when no bag on any tip is bigger than
 * `bagMaxM` (reach, m; omitted = 0 = no bag on a tip). A window is the span between two angles the rows were run at (at most 2 deg
 * apart), run with a bag of radius `bagMaxM` on every tip. A hair of tolerance (0.01 deg) for the ship's own float noise; nothing
 * more: the window is as measured. A bucket without `windowsDeg` (the shape before u22-nose-tipbags: `closedDeg` / `openDeg`) is
 * offered nowhere.
 * @param {{windowsDeg:number[][]}} bucket
 * @param {number} deg
 * @param {number} [bagReachM]
 * @returns {boolean}
 */
export function noseRadiatorsOk(bucket, deg, bagReachM = 0) {
  const w = bucket && bucket.windowsDeg;
  if (!Array.isArray(w)) return false;
  return w.some((x) => Array.isArray(x) && deg >= x[0] - 0.01 && deg <= x[1] + 0.01 && bagReachM <= (x[2] ?? 0) + 1e-9);
}

/**
 * The spans of radiator angle the bucket is offered at, for the bag now on a tip, touching spans joined: `[[lo, hi], ...]` sorted by
 * angle. For the refusal's words only.
 * @param {{windowsDeg:number[][]}} bucket
 * @param {number} [bagReachM]
 * @returns {number[][]}
 */
export function noseWindowSpans(bucket, bagReachM = 0) {
  const w = (bucket && Array.isArray(bucket.windowsDeg) ? bucket.windowsDeg : [])
    .filter((x) => Array.isArray(x) && bagReachM <= (x[2] ?? 0) + 1e-9)
    .map((x) => [x[0], x[1]])
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const x of w) {
    const last = out[out.length - 1];
    if (last && x[0] <= last[1] + 1e-9) last[1] = Math.max(last[1], x[1]);
    else out.push([x[0], x[1]]);
  }
  return out;
}
