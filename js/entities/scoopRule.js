/**
 * scoopRule.js - the scoop net's rules, pure (lane u20-nets, 2026-10-23; owner's ruling DECISIONS §38 row 5 / §35 row 1).
 *
 * "Daughters may need ways to combine many small pieces in one net" (owner, 2026-10-23). When a daughter's net closes on
 * its target, every other catchable piece inside the net's mouth joins the target in ONE bag. The bag is one catch (a
 * daughter still holds one catch; the mission counts one of its five); each member is paid as if it had been caught alone.
 *
 * What this module decides (nothing here allocates scene objects; metres throughout, positions are the scene frame / 1e-5):
 *
 *  - THE MOUTH VOLUME. The ball of radius `DIAMETER / 2` about the net's centre at contact. That is the ball the net's own
 *    contact test uses for the target (`CaptureNet` FLIGHT: `distance <= effectiveCatchRadius(DIAMETER / 2)`; that test adds a
 *    close-range forgiveness for near grazes, so the target itself can sit a little outside the plain ball: it is a member by
 *    right), so a piece the net could not have touched is never in the bag. Its depth is one mouth diameter, about the length
 *    of the flight cone the net is drawn as (4.1 m for the 3 m net). The net's centre at contact is kept as an OFFSET from the
 *    target (`mouthOffsetM`), so it stays right while both drift together until the bag closes.
 *  - WHO IS ELIGIBLE. A piece the net could have been aimed at: alive, in the field (not stored), not held, pinned, parked,
 *    netted, committed to another daughter's net, or already inside a bag, and not itself a bag (no nesting). Background
 *    shards are not in the field's piece list at all, so they are out by construction.
 *  - WHAT FITS. Nearest the mouth centre first; a piece is skipped when the running mass would pass the net's rated mass
 *    (the strain ramp's own rating), and the walk goes on to the next one. The target is always a member, whatever it weighs.
 *  - THE BAG'S SIZE. A closed net is a ball with the mesh's own area, so radius mouth / 4 at the most (docs/research/
 *    2026-10-debris-sizes.md §6). Inside it the pieces pack loosely (fill 0.5; a flat piece, a fragment, fills a quarter of
 *    its bounding cube): `r = max(largest member reach, cbrt(3 / (4 pi) x sum(volume) / 0.5))`, capped at mouth / 4 but never
 *    under the largest member's reach. `sizeMeter` of the bag is `2 r`. All of these are estimates [E], not measurements.
 *
 * @module entities/scoopRule
 */
import { Constants } from '../core/Constants.js';

export const SCOOP = Object.freeze({
  /** how much of the bag's ball the packed pieces fill (doc §6, estimate) */
  PACK_FILL: 0.5,
  /** how much of its bounding cube a flat piece (a fragment) fills (doc §6, estimate) */
  FLAT_CUBE_FILL: 0.25,
  /** how much of its bounding cube any other piece fills (estimate: a solid box is 1, a hollow body less) */
  BODY_CUBE_FILL: 0.5,
  /** the bag's ball is at most this fraction of the mouth diameter in radius (mouth / 4: a ball of the mesh's own area) */
  MAX_RADIUS_OF_MOUTH: 0.25,
});

/** @returns {number} metres per scene unit's inverse: the scene frame is 1 m = SCENE_UNITS_PER_METER */
function sceneToM() { return 1 / Constants.SCENE_UNITS_PER_METER; }

/**
 * A piece's centre in metres in the scene frame: `_scenePosition` (scene units) when the field has placed it, else a plain
 * `position` in metres (a test rig), else null.
 * @param {{_scenePosition?:{x:number,y:number,z:number}, position?:{x:number,y:number,z:number}}|null} d
 * @param {{x:number,y:number,z:number}} [out]
 * @returns {{x:number,y:number,z:number}|null}
 */
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

/**
 * Could a net be aimed at this piece, and is it still free? The test for joining a bag (never the target: the target is a
 * member by right).
 * @param {object|null} d candidate
 * @param {number|null} [armId=null] the daughter whose net this is (a piece committed to HER net is not "another's")
 * @returns {boolean}
 */
export function isScoopable(d, armId = null) {
  if (!d || d.alive === false) return false;
  if (d.isBag === true || d._inBag === true) return false;                       // no bag inside a bag; no piece in two
  if (d._captured || d._armPinned || d._capturedByArm || d._motherParked || d._netted) return false;
  if (d._onboardingPinned || d._fieldStored) return false;
  if (d.hazard === true) return false;                                           // a live hazard is never a pick-up
  if (d._committedNetArmId != null && d._committedNetArmId !== armId) return false;
  if (!Number.isFinite(d.mass) || !(d.mass >= 0)) return false;
  return true;
}

/**
 * Pick the members of a scoop. Pure: no field, no events.
 * @param {object} target the piece the net was aimed at (always the first member)
 * @param {Iterable<object>} candidates the field's pieces (the target may be among them)
 * @param {{DIAMETER:number, MAX_CAPTURE_MASS?:number}} netClass
 * @param {object} [opts]
 * @param {{x:number,y:number,z:number}|null} [opts.mouthOffsetM] the net's centre at contact minus the target's centre (m); null = on the target
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
  const rated = Number.isFinite(opts.ratedMassKg) && opts.ratedMassKg > 0
    ? opts.ratedMassKg
    : ((netClass && netClass.MAX_CAPTURE_MASS) || Infinity);
  const near = [];
  const p = { x: 0, y: 0, z: 0 };
  for (const c of candidates) {
    if (!c || c === target || (c.id != null && c.id === target.id)) continue;
    if (!isScoopable(c, opts.armId ?? null)) continue;
    if (!pieceCentreM(c, p)) continue;
    const dx = p.x - cx, dy = p.y - cy, dz = p.z - cz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist <= R) near.push({ c, dist });                                       // the mouth test: centre inside the ball
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

/**
 * The bag's size from its members. `reachOf(member)` is the member's drawn reach in metres (`DebrisField.trueReachM`; the
 * caller passes it so this module needs no mesh code).
 * @param {object[]} members
 * @param {{DIAMETER:number}} netClass
 * @param {(d:object)=>number} reachOf
 * @returns {{radiusM:number, sizeMeter:number, massKg:number, packedRadiusM:number, maxReachM:number, capped:boolean}}
 */
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

/** The one comms line a scoop says (nothing is said for one piece). */
export function scoopLine(daughterName, count) {
  return `${daughterName}'s net took ${count} pieces in one bag.`;
}
