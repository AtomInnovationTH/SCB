/**
 * heldBagShape.js — where a net's bag sits round the catch it holds: the ONE pure home (lane net-cinch, 2026-10-20).
 *
 * A net is built as the 6.8 m flight cone. Once it has closed on its catch it is drawn as a compact bag (CaptureNetVisual
 * `_shapeHeldBag`): the apex ball (where the tether ends, the bag's "neck") touches the rear of the catch, one DRAWN radius
 * behind its centre, on the tow line from the launcher's ring to the catch, but never closer to that ring than the ring
 * can seat it. Three places need the same point in the same frame: the visual draws the bag there, CaptureNet seats the
 * net's position there while a daughter holds the catch, and ArmUnit `_rhSyncBag` winds the line to it (the line's length
 * is muzzle -> neck). They all call this module, so the sim measures to the point the picture draws.
 *
 * Units: `c` (the catch centre), `ring` and the results are SCENE units, `rS` too. Nothing here allocates (callers pass
 * scratch vectors; plain {x,y,z} objects work as well as THREE.Vector3).
 *
 * The ring is the mother's capture ring (berth collar) for a mother net and the daughter's net-launcher MUZZLE for a
 * daughter's net. A daughter's neck also keeps `HELD_BAG.HUB_RADIUS_M` off the muzzle along the tow line (`standM`): the
 * apex ball is 5 cm in radius and the muzzle is the front face of her net launcher, so a neck AT the muzzle would sink the
 * ball into her hull.
 *
 * @module entities/heldBagShape
 */
import { Constants } from '../core/Constants.js';
import { DebrisField } from './DebrisField.js';
import { DebrisWireframe } from '../ui/DebrisWireframe.js';

const M = Constants.SCENE_UNITS_PER_METER;

export const HELD_BAG = Object.freeze({
  /** the apex ball touches the rear of the catch: one drawn radius behind its centre */
  APEX_BACK_FRAC: 1.0,
  /** floor of the drawn radius, metres (a speck still gets a bag) */
  MIN_RADIUS_M: 0.03,
  /** the neck is never closer than this to the catch centre, metres */
  MIN_BACK_M: 0.01,
  /** a ring -> catch line shorter than this has no direction, metres */
  MIN_TOW_M: 0.05,
  /** the apex ball's drawn radius, metres (measured 0.048) */
  HUB_RADIUS_M: 0.05,
});

/**
 * The radius the catch is DRAWN at, scene units: the instance's render scale times its bounding radius, deflated by the
 * digestion chop. No floor.
 * @param {object} d the catch
 * @param {number|null} [chopMul=null]
 * @returns {number}
 */
export function drawnCatchRadiusScene(d, chopMul = null) {
  // u20-nets: a scoop bag is a ball of radius `sizeMeter / 2` (its `type` is the heaviest member's, whose mesh is not the bag's
  // shape): the net's wrap goes round that ball, at true size, no readability floor.
  if (d.isBag === true && d.sizeMeter > 0) return (d.sizeMeter / 2) * M * (chopMul != null ? chopMul : 1);
  DebrisWireframe.getGeometry(d.type, d.id);            // fills the bounding-radius cache
  const br = DebrisWireframe.getBoundingRadius(d.type, d.id) || 1;
  let renderScale = DebrisField.effectiveRenderScale(d);
  if (chopMul != null) renderScale *= chopMul;
  return renderScale * br;
}

/**
 * The bag's sizing radius, scene units: the drawn radius with the floor.
 * @param {object} d
 * @param {number|null} [chopMul=null]
 * @returns {number}
 */
export function heldBagRadiusScene(d, chopMul = null) {
  return Math.max(HELD_BAG.MIN_RADIUS_M * M, drawnCatchRadiusScene(d, chopMul));
}

/**
 * The bag's axis (unit, local -Z of the bag group points along it): from the launch direction (g = 0) to the tow line
 * ring -> catch (g = 1), so a bag hauled in from off-centre lines up with its tether.
 * @param {{x:number,y:number,z:number,set?:Function}} L receives the unit axis
 * @param {{x:number,y:number,z:number}} c catch centre, scene units
 * @param {{x:number,y:number,z:number}|null} ring the launcher's ring (null: launch direction only)
 * @param {{x:number,y:number,z:number}} fallbackDir launch direction
 * @param {number} [g=1] how far the bag has gathered, 0..1
 * @returns {object} L
 */
export function heldBagAxisInto(L, c, ring, fallbackDir, g = 1) {
  const lx = fallbackDir.x, ly = fallbackDir.y, lz = fallbackDir.z;
  L.x = lx; L.y = ly; L.z = lz;
  if (ring) {
    const ax = c.x - ring.x, ay = c.y - ring.y, az = c.z - ring.z;
    const dist = Math.sqrt(ax * ax + ay * ay + az * az);
    if (dist > HELD_BAG.MIN_TOW_M * M) {
      const k = 1 / dist;
      L.x = L.x * (1 - g) + ax * k * g;
      L.y = L.y * (1 - g) + ay * k * g;
      L.z = L.z * (1 - g) + az * k * g;
    }
  }
  if (L.x * L.x + L.y * L.y + L.z * L.z < 1e-12) { L.x = lx; L.y = ly; L.z = lz; }
  const len = Math.sqrt(L.x * L.x + L.y * L.y + L.z * L.z) || 1;
  L.x /= len; L.y /= len; L.z /= len;
  return L;
}

/**
 * How far behind the catch's centre the neck sits, scene units: touching the rear of the catch, but never behind the ring
 * (a catch drawn larger than its seat would put the neck inside the ship), `standM` metres of clearance kept off it.
 * @param {number} rS the bag's sizing radius (`heldBagRadiusScene`)
 * @param {{x:number,y:number,z:number}} c
 * @param {{x:number,y:number,z:number}|null} ring
 * @param {{x:number,y:number,z:number}} L the unit axis (`heldBagAxisInto`)
 * @param {number} [standM=0] clearance off the ring along the axis, metres
 * @returns {number}
 */
export function heldBagBack(rS, c, ring, L, standM = 0) {
  let back = HELD_BAG.APEX_BACK_FRAC * rS;
  if (ring) {
    const fromRing = (c.x - ring.x) * L.x + (c.y - ring.y) * L.y + (c.z - ring.z) * L.z;
    if (Number.isFinite(fromRing)) back = Math.min(back, Math.max(HELD_BAG.MIN_BACK_M * M, fromRing - standM * M));
  }
  return back;
}

const _L = { x: 0, y: 0, z: 1 };

/**
 * A closed bag's neck for the catch `c` held on a line from `ring` (g = 1): `c - axis * back`. The simulation's form
 * (CaptureNet seats the held net's position there; ArmUnit winds the line to it). Returns the neck in `out`.
 * @param {{x:number,y:number,z:number}} out receives the neck, scene units
 * @param {{x:number,y:number,z:number}} c catch centre, scene units
 * @param {{x:number,y:number,z:number}} ring muzzle (daughter) / capture ring (mother), scene units
 * @param {{x:number,y:number,z:number}} fallbackDir launch direction (used with no tow line)
 * @param {number} rS the bag's sizing radius, scene units
 * @param {number} [standM=0]
 * @returns {object} out
 */
export function heldBagNeckInto(out, c, ring, fallbackDir, rS, standM = 0) {
  heldBagAxisInto(_L, c, ring, fallbackDir, 1);
  const back = heldBagBack(rS, c, ring, _L, standM);
  out.x = c.x - _L.x * back;
  out.y = c.y - _L.y * back;
  out.z = c.z - _L.z * back;
  return out;
}

/** The neck's clearance off a daughter's muzzle, metres: the apex ball's radius (see the header). */
export const DAUGHTER_STAND_M = HELD_BAG.HUB_RADIUS_M;
