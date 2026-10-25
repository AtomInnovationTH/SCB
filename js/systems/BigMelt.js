/**
 * BigMelt.js - melting a big caught piece for metal in the four radiator-tip furnaces, on the SHIP'S clock during trip burns (Nets step 3
 * slice 5, lane 5e; DECISIONS §33 row 16-17; plan E1-E8). PURE: numbers in, numbers out; GameFlowManager plays the result.
 *
 * The owner (row 17): "4 furnaces, one on each radiator strut", "2 min game time, but many hours or days of realtime to melt debris. and
 * many hours or days to move between debris fields or orbits." So a delivery takes minutes of ship time, a melt takes hours, and the days
 * of a trip burn and the room in the hold set the pace, not the delivery.
 *
 *   PART_KG[type]              the largest whole-kg part a tip takes: the part, packed to PACKED_KG_M3 and drawn with its parent's mesh,
 *                              reaches no further than REACH_LIMIT_M (E3). Computed from the game's own functions, never a literal.
 *   planBurn(...)              the schedule of one trip burn: which parts are cut, delivered and melted, on which tip, at what ship time (E1)
 *   meltAccount(d, ...)        what the parts melted between two points of a piece's melt pay and make (E4): metal, fee, the owner's share
 *   metalListedCrPerKg()       the hold's listed value per kg so a sale of 50 kg or more nets the in-orbit price after the spread and bulk bonus
 *   tripLine / tooShortLine    the plain lines the trip says
 *
 * Parts are cut one at a time and delivered one at a time (DELIVERY_S each) to the next free furnace; a furnace melts one part at a time at
 * FURNACE_S_PER_KG ship-seconds per kg, in sunlight only (TRIP_SUN of the ship's time). A part starts only if it can finish before the burn
 * ends (no part is ever left half melted), and only if the hold can take its metal.
 * @module systems/BigMelt
 */

import { Constants } from '../core/Constants.js';
import { DebrisField } from '../entities/DebrisField.js';
import { pieceValues } from './BigPieceValues.js';
import { bigBodiesOf } from './BigPieces.js';

/** Seconds in a day (a trip's days are ship days). */
export const DAY_S = 86400;

/** Diameter (m) of a sphere of `kg` packed to `cfg.PACKED_KG_M3`: the size a cut part is drawn and tested at. */
export function packedSizeM(kg, cfg = Constants.BIG_MELT) {
  return 2 * Math.cbrt((3 * (kg / cfg.PACKED_KG_M3)) / (4 * Math.PI));
}

/** The drawn reach (m) of a part of `kg` of `type`: packed size, the parent's geometry (`DebrisField.trueReachM`, the number the tip's fit reads). */
export function partReachM(type, kg, cfg = Constants.BIG_MELT) {
  return DebrisField.trueReachM({ type, id: 1, sizeMeter: packedSizeM(kg, cfg) }, 0);
}

const _partKgMemo = new Map();

/**
 * The largest whole kg a part of `type` can weigh and still reach no further than `cfg.REACH_LIMIT_M` (E3).
 * @param {string} type 'rocketBody' | 'defunctSat' @returns {number}
 */
export function partKgFor(type, cfg = Constants.BIG_MELT) {
  const key = `${type}|${cfg.PACKED_KG_M3}|${cfg.REACH_LIMIT_M}`;
  if (_partKgMemo.has(key)) return _partKgMemo.get(key);
  let lo = 0, hi = 20000;                               // integer kg: reach grows with the mass, so the answer is a clean bisection
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (partReachM(type, mid, cfg) <= cfg.REACH_LIMIT_M + 1e-9) lo = mid; else hi = mid;
  }
  _partKgMemo.set(key, lo);
  return lo;
}

/** `PART_KG.rocketBody`, `PART_KG.defunctSat`: computed on first read from the game's own functions (E3). */
export const PART_KG = {
  get rocketBody() { return partKgFor('rocketBody'); },
  get defunctSat() { return partKgFor('defunctSat'); },
};

/** The type a piece's parts are sized by: its own, or a bag's heaviest big member's (E3). */
export function pieceType(d) {
  if (!d) return null;
  if (d.isBag === true) {
    const bigs = bigBodiesOf(d);
    if (bigs.length) return bigs.reduce((a, b) => ((b.mass || 0) > (a.mass || 0) ? b : a), bigs[0]).type;
  }
  return d.type;
}

/**
 * The hold's listed value per kg of orbit metal: a sale of `BULK_THRESHOLD_KG` or more nets exactly the in-orbit price per kg after the
 * market spread and the bulk bonus (`computeSaleValue`); derived from those constants, never a literal (E4).
 */
export function metalListedCrPerKg() {
  const m = Constants.MARKET || {};
  return Constants.BIG_PIECES.IN_ORBIT_CR_PER_KG / ((m.SELL_PRICE_MODIFIER || 0.85) * (m.BULK_BONUS_MULTIPLIER || 1.15));
}

/**
 * The schedule of one trip burn (E1). Parts of each piece go oldest piece first, each piece in whole parts of `partKg` with the remainder
 * last; a part is cut when the delivery chain is free, delivered in `DELIVERY_S`, and melts on the furnace that frees first.
 *
 * @param {object} p
 * @param {number} p.burnShipS the burn's ship time, seconds (planned days x 86,400)
 * @param {Array<{id: *, kg: number, partKg: number, metalPerKg: number}>} p.pieces melt-marked pieces, oldest catch first: `kg` still to melt,
 *   `partKg` the biggest part, `metalPerKg` kg of metal per kg of piece
 * @param {Array<*>} p.tips the free furnaces (tip indices)
 * @param {number} p.roomKg room in the hold for orbit metal, kg
 * @param {object} [cfg] `Constants.BIG_MELT` (a test passes its own)
 * @returns {{parts: Array<{pieceId: *, n: number, kg: number, metalKg: number, cutS: number, startS: number, endS: number, tip: *, last: boolean}>,
 *   stop: (null|'hold'|'time'|'furnaces'), metalKg: number}}
 *   `stop`: why the work ended before every piece was done: the hold could not take the next part (`hold`), the next part could not finish
 *   inside the burn (`time`), no furnace was free (`furnaces`); null when every piece was done. Times are ship seconds from the burn's start.
 */
export function planBurn({ burnShipS, pieces, tips, roomKg }, cfg = Constants.BIG_MELT) {
  const out = { parts: [], stop: null, metalKg: 0 };
  const list = (pieces || []).filter((x) => x && x.kg > 1e-9 && x.partKg > 0);
  if (!list.length) return out;
  if (!tips || !tips.length) { out.stop = 'furnaces'; return out; }
  const free = tips.map(() => 0);                          // when each furnace is free again
  let chain = 0;                                           // when the delivery chain is free again
  let room = Number.isFinite(roomKg) ? roomKg : Infinity;
  const burn = Number.isFinite(burnShipS) ? burnShipS : 0;
  const meltS = (kg) => (kg * cfg.FURNACE_S_PER_KG) / cfg.TRIP_SUN;
  for (const piece of list) {
    let left = piece.kg;
    let n = 0;
    while (left > 1e-9) {
      const kg = left > piece.partKg + 1e-9 ? piece.partKg : left;
      const metalKg = kg * piece.metalPerKg;
      if (metalKg > room + 1e-9) { out.stop = 'hold'; return out; }
      let j = 0;
      for (let i = 1; i < free.length; i++) if (free[i] < free[j]) j = i;
      const cutS = Math.max(chain, free[j] - cfg.DELIVERY_S, 0);
      const startS = cutS + cfg.DELIVERY_S;
      const endS = startS + meltS(kg);
      if (endS > burn + 1e-9) { out.stop = 'time'; return out; }
      chain = startS;
      free[j] = endS;
      room -= metalKg;
      out.metalKg += metalKg;
      left -= kg;
      out.parts.push({ pieceId: piece.id, n: n++, kg, metalKg, cutS, startS, endS, tip: tips[j], last: left <= 1e-9 });
    }
  }
  return out;
}

/** A piece's values at the catch (E4): a copy at `massAtCatch`, never the shrinking remainder. A bag's values come from its big members. */
export function valuesAtCatch(d, massAtCatch) {
  if (d && d.isBag === true) return pieceValues(d);
  return pieceValues({ type: d && d.type, owner: d && d.owner, mass: massAtCatch });
}

/**
 * What the melt of a piece has paid and made once `doneKg` of it is melted (cumulative, E4): the removal fee, the holder's share of the
 * metal at the in-orbit price (taken at the melt, not at the sale: the shop cannot tell whose orbit metal is whose), and the metal. Cumulative
 * and rounded once per point, so a part's pay is the difference of two points and the total over all parts is exact.
 * @param {object} d the piece @param {number} massAtCatch @param {number} doneKg kg melted so far
 * @returns {{feeCr: number, shareCr: number, netCr: number, metalKg: number}}
 */
export function meltedSoFar(d, massAtCatch, doneKg) {
  const v = valuesAtCatch(d, massAtCatch);
  const f = massAtCatch > 0 ? Math.max(0, Math.min(1, doneKg / massAtCatch)) : 0;
  const feeCr = Math.round(v.removalFeeCr * f);
  const shareCr = Math.round(v.consentShare * v.scrapKg * f * Constants.BIG_PIECES.IN_ORBIT_CR_PER_KG);
  return { feeCr, shareCr, netCr: Math.max(0, feeCr - shareCr), metalKg: v.scrapKg * f };
}

/**
 * One part's account: the difference of `meltedSoFar` before and after it.
 * @returns {{kg: number, metalKg: number, feeCr: number, shareCr: number, netCr: number, holder: {name: (string|null), status: (string|null)}}}
 */
export function meltAccount(d, massAtCatch, doneBefore, doneAfter) {
  const a = meltedSoFar(d, massAtCatch, doneBefore);
  const b = meltedSoFar(d, massAtCatch, doneAfter);
  return {
    kg: doneAfter - doneBefore,
    metalKg: b.metalKg - a.metalKg,
    feeCr: b.feeCr - a.feeCr,
    shareCr: b.shareCr - a.shareCr,
    netCr: b.netCr - a.netCr,
    holder: valuesAtCatch(d, massAtCatch).holder,
  };
}

const fmt = (n) => Math.round(n).toLocaleString('en-US');

export const HOLD_FULL_LINE = 'The hold is full: sell orbit metal at a satellite to melt more.';

/**
 * The one line a trip says about a piece it worked on (E2): "The furnaces melted 820 kg of the SL-14 stage: 491 kg of orbit metal in the
 * hold. Removal fee 8,200 from Russia, less Russia's share 6,888: +1,312 cr."
 * @param {{name: string, kg: number, metalKg: number, feeCr: number, shareCr: number, netCr: number, holder: {name: (string|null), status: (string|null)}}} t
 *   the trip's totals for the piece (sums of `meltAccount`)
 */
export function tripLine(t) {
  const head = `The furnaces melted ${fmt(t.kg)} kg of the ${t.name}: ${fmt(t.metalKg)} kg of orbit metal in the hold.`;
  if (!(t.feeCr > 0) && t.holder && t.holder.status === 'abandoned') return `${head} Nobody owns it, so there is no removal fee.`;
  const who = (t.holder && t.holder.name) || 'the owner';
  return `${head} Removal fee ${fmt(t.feeCr)} from ${who}, less ${who}'s share ${fmt(t.shareCr)}: +${fmt(t.netCr)} cr.`;
}

/** A trip too short for any part to finish says so (E2). */
export function tooShortLine(name) {
  return `This trip was too short to melt any of the ${name}.`;
}

/** No tip furnace is free for a trip's work (every tip holds a catch). */
export function noFurnaceLine(name) {
  return `Every tip furnace is busy: the ${name} waits for a trip with one free.`;
}
