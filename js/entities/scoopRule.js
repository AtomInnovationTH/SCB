/**
 * scoopRule.js - the scoop net's rules, pure (owner's ruling DECISIONS §38 row 5 / §35 row 1).
 *
 * owner 2026-10-23: "Daughters may need ways to combine many small pieces in one net".
 * When a daughter's net closes on its target, every other catchable piece inside the net's mouth joins the target in ONE bag. The bag is
 * one catch (a daughter still holds one catch; the mission counts one of its five); each member is paid as if it had been caught alone.
 *
 * What this module decides (nothing here allocates scene objects; metres throughout, positions are the scene frame / 1e-5):
 *
 *  - THE MOUTH VOLUME. What you see is what you catch: the volume the DRAWN net sweeps (measured 2026-10-24 from the real kit, `NetMeshKit.build` /
 *    `CaptureNetVisual`). The apex is the net's centre at contact. The flying net is a cone `coneHeight` long (`mouthR x 2 x CONE_LENGTH_FRAC`,
 *    2.55 m for the 3 m net) opening to the mouth radius (`DIAMETER / 2`, 1.5 m); in ENVELOP the rim weights then sweep a cylinder of that
 *    radius from one `coneHeight` to two ahead of the apex (2.55 to 5.1 m), and the ring closes back at `coneHeight`. So a piece is inside
 *    when, with `z` its distance ahead of the apex along the net's axis and `rho` its distance from that axis: `0 <= z <= 2 x coneHeight` and
 *    `rho <= mouthR x min(1, z / coneHeight)`. At contact the target is only about 1.8 m ahead of the apex (the contact ball is the mouth
 *    radius x the close-range forgiveness), so pieces beside it and beyond it are inside the net; a piece beside the target but off the cone
 *    near the daughter is not (the net never reached it). The target itself is a member by right (the contact test adds a forgiveness).
 *    The apex is kept as an OFFSET from the target (`mouthOffsetM`, net centre minus target) and the axis as `mouthAxis`, so both stay right
 *    while the net and the group drift together until the bag closes. With no axis (a net that never touched: a test rig, `forceResolve`
 *    without flying) the mouth is a ball of `DIAMETER / 2` about the offset point.
 *  - WHO IS ELIGIBLE. A piece the net could have been aimed at: alive, in the field (not stored), not held, pinned, parked, netted, committed
 *    to another daughter's net, or already inside a bag, and not itself a bag (no nesting). Background shards are not in the field's piece
 *    list at all, so they are out by construction.
 *  - WHAT FITS. Nearest the target first (nearest the ball's centre when there is no axis); a piece is skipped when the running mass would
 *    pass the net's rated mass (the strain ramp's own rating), and the walk goes on to the next one. The target is always a member.
 *  - THE BAG'S SIZE. A closed net is a ball with the mesh's own area, so radius mouth / 4 at the most (archive/research/2026-10-debris-sizes.md
 *    §6). Inside it the pieces pack loosely (fill 0.5; a flat piece, a fragment, fills a quarter of its bounding cube):
 *    `r = max(largest member reach, cbrt(3 / (4 pi) x sum(volume) / 0.5))`, capped at mouth / 4 but never under the largest member's reach.
 *    `sizeMeter` of the bag is `2 r`. All of these are estimates [E], not measurements.
 *
 * @module entities/scoopRule
 */
import { Constants } from '../core/Constants.js';

export const SCOOP = Object.freeze({
  PACK_FILL: 0.5,
  FLAT_CUBE_FILL: 0.25,
  /** how much of its bounding cube any other piece fills (estimate: a solid box is 1, a hollow body less) */
  BODY_CUBE_FILL: 0.5,
  /** the bag's ball is at most this fraction of the mouth diameter in radius (mouth / 4: a ball of the mesh's own area) */
  MAX_RADIUS_OF_MOUTH: 0.25,
});

function sceneToM() { return 1 / Constants.SCENE_UNITS_PER_METER; }

/** A piece's centre in metres in the scene frame: `_scenePosition` (scene units) when the field has placed it, else a plain `position` in
 *  metres (a test rig), else null. */
export function pieceCentreM(d, out = { x: 0, y: 0, z: 0 }) {
  if (!d) return null;
  const sp = d._scenePosition;
  if (sp && Number.isFinite(sp.x)) {
    const k = sceneToM();
    out.x = sp.x * k; out.y = sp.y * k; out.z = sp.z * k;
    return out;
  }
  const p = d.position;
  if (p && Number.isFinite(p.x)) { out.x = p.x; out.y = p.y; out.z = p.z; return out; }
  return null;
}

/** Could a net be aimed at this piece, and is it still free? The test for joining a bag (never the target, a member by right).
 *  `armId`: the daughter whose net this is (a piece committed to HER net is not "another's"). */
export function isScoopable(d, armId = null) {
  if (!d || d.alive === false) return false;
  if (d._disposed === true) return false;
  if (d.isBag === true || d._inBag === true) return false;
  if (d._captured || d._armPinned || d._capturedByArm || d._motherParked || d._netted) return false;
  if (d._onboardingPinned || d._fieldStored) return false;
  if (d.hazard === true) return false;
  if (d._committedNetArmId != null && d._committedNetArmId !== armId) return false;
  if (!Number.isFinite(d.mass) || !(d.mass >= 0)) return false;
  return true;
}

/** The drawn mouth's size for a net class ({DIAMETER}): the cone/cylinder radius `mouthR` and the cone's length `coneH`, in metres, the
 *  kit's own formulas (`NetMeshKit.build`: `mouthRadius = D/2 x CONE_OPEN_RADIUS_FRAC`, `coneHeight = mouthRadius x 2 x CONE_LENGTH_FRAC`). */
export function mouthShape(netClass) {
  const cer = Constants.CAPTURE_NET.NET_CEREMONY;
  const mouthR = ((netClass && netClass.DIAMETER) || 0) / 2 * cer.CONE_OPEN_RADIUS_FRAC;
  return { mouthR, coneH: mouthR * 2 * cer.CONE_LENGTH_FRAC };
}

/** Is a point inside the volume the drawn net sweeps? (See THE MOUTH VOLUME.) `px,py,pz`: the point relative to the apex (m); `ax,ay,az`: the
 *  net's unit launch direction. */
export function insideSweptMouth(px, py, pz, ax, ay, az, mouthR, coneH) {
  const z = px * ax + py * ay + pz * az;
  if (z < 0 || z > 2 * coneH) return false;
  const lx = px - z * ax, ly = py - z * ay, lz = pz - z * az;
  const rho = Math.sqrt(lx * lx + ly * ly + lz * lz);
  return rho <= mouthR * Math.min(1, z / coneH);
}

/**
 * Pick the members of a scoop. Pure: no field, no events.
 * @param {object} target the piece the net was aimed at (always the first member)
 * @param {Iterable<object>} candidates the field's pieces (the target may be among them)
 * @param {{DIAMETER:number, MAX_CAPTURE_MASS?:number}} netClass
 * @param {{x:number,y:number,z:number}|null} [opts.mouthOffsetM] the net's centre (the apex) at contact minus the target's centre (m); null = on
 *   the target
 * @param {{x:number,y:number,z:number}|null} [opts.mouthAxis] the net's launch direction at contact (any length); with it the mouth is the drawn
 *   net's swept volume, without it a ball
 * @param {number|null} [opts.armId] the daughter's id (for the committed-net test)
 * @param {number} [opts.ratedMassKg] the rated mass to hold to (default the class rating)
 * @returns {{members: object[], skipped: {id:number, why:string}[]}} members nearest-first after the target
 */
export function pickScoopMembers(target, candidates, netClass, opts = {}) {
  const members = [target];
  const skipped = [];
  const tC = pieceCentreM(target);
  const dia = (netClass && netClass.DIAMETER) || 0;
  if (!tC || !(dia > 0) || !candidates) return { members, skipped };
  const off = opts.mouthOffsetM || null;
  const cx = tC.x + (off ? off.x : 0), cy = tC.y + (off ? off.y : 0), cz = tC.z + (off ? off.z : 0);
  const R = dia / 2;
  // the drawn net's axis, normalised; null (a ball) when the net never recorded one
  const axis = opts.mouthAxis || null;
  const axLen = axis ? Math.hypot(axis.x, axis.y, axis.z) : 0;
  const swept = axLen > 1e-9;
  const ax = swept ? axis.x / axLen : 0, ay = swept ? axis.y / axLen : 0, az = swept ? axis.z / axLen : 0;
  const shape = swept ? mouthShape(netClass) : null;
  const rated = Number.isFinite(opts.ratedMassKg) && opts.ratedMassKg > 0
    ? opts.ratedMassKg
    : ((netClass && netClass.MAX_CAPTURE_MASS) || Infinity);
  const near = [];
  const p = { x: 0, y: 0, z: 0 };
  for (const c of candidates) {
    if (!c || c === target || (c.id != null && c.id === target.id)) continue;
    if (!isScoopable(c, opts.armId ?? null)) continue;
    if (!pieceCentreM(c, p)) continue;
    if (swept) {
      if (!insideSweptMouth(p.x - cx, p.y - cy, p.z - cz, ax, ay, az, shape.mouthR, shape.coneH)) continue;
      const tx = p.x - tC.x, ty = p.y - tC.y, tz = p.z - tC.z;
      near.push({ c, dist: Math.sqrt(tx * tx + ty * ty + tz * tz) });
      continue;
    }
    const dx = p.x - cx, dy = p.y - cy, dz = p.z - cz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist <= R) near.push({ c, dist });
  }
  near.sort((a, b) => (a.dist - b.dist) || ((a.c.id ?? 0) - (b.c.id ?? 0)));
  let mass = Number.isFinite(target.mass) ? target.mass : 0;
  for (const { c } of near) {
    const m = c.mass || 0;
    if (mass + m > rated) { skipped.push({ id: c.id, why: 'mass' }); continue; }  // would overflow the rating: skip, go on
    mass += m;
    members.push(c);
  }
  return { members, skipped };
}

/** Volume (m^3) one member takes inside the bag: its bounding cube times how much of that cube it fills. */
export function memberVolumeM3(d) {
  const s = Number.isFinite(d.sizeMeter) && d.sizeMeter > 0 ? d.sizeMeter : 0;
  const fill = d.type === 'fragment' ? SCOOP.FLAT_CUBE_FILL : SCOOP.BODY_CUBE_FILL;
  return s * s * s * fill;
}

/** The bag's size from its members. `reachOf(member)` is the member's drawn reach in metres (`DebrisField.trueReachM`; the caller passes it so
 *  this module needs no mesh code). */
export function bagSize(members, netClass, reachOf) {
  let vol = 0, mass = 0, maxReach = 0;
  for (const d of members) {
    vol += memberVolumeM3(d);
    mass += d.mass || 0;
    maxReach = Math.max(maxReach, reachOf(d) || 0);
  }
  const packed = Math.cbrt((3 / (4 * Math.PI)) * vol / SCOOP.PACK_FILL);
  const cap = ((netClass && netClass.DIAMETER) || 0) * SCOOP.MAX_RADIUS_OF_MOUTH;
  let r = Math.max(maxReach, packed);
  let capped = false;
  if (cap > 0 && r > cap) { r = Math.max(cap, maxReach); capped = true; }        // capped at mouth / 4, never under the largest reach
  return { radiusM: r, sizeMeter: 2 * r, massKg: mass, packedRadiusM: packed, maxReachM: maxReach, capped };
}

export function scoopLine(daughterName, count) {
  return `${daughterName}'s net took ${count} pieces in one bag.`;
}
