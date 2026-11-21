/**
 * @module systems/BigMelt — melting a big caught piece for metal in the four radiator-tip furnaces, on the SHIP'S clock
 * during trip burns (DECISIONS §33 rows 16-17). PURE: numbers in, numbers out; GameFlowManager plays the result.
 * A delivery takes minutes of ship time, a melt takes hours: the days of a trip burn and the room in the hold set the
 * pace, not the delivery.
 *
 * Each furnace is a fixed 0.6 m foil-insulated receiver inside a sun-oven ball (P34): a part must fit it
 * (REACH_LIMIT_M 0.30 m: 5 kg stage / 11 kg satellite parts), and the empty receiver warms once per burn before its
 * first part (RECEIVER_WARM_S sunlit seconds, so a tip is free from RECEIVER_WARM_S / TRIP_SUN, not from 0).
 * Parts are cut one at a time and delivered one at a time (DELIVERY_S each, overlapping the warm-up) to the next free
 * furnace; a furnace melts one part at a time at FURNACE_S_PER_KG sunlit seconds per kg (TRIP_SUN of the ship's time) for aluminium.
 * Furnace 2 (DECISIONS §82 rows 1-2): the tips carry different tools (`Constants.BIG_MELT.TOOLS`): steel and titanium melt only
 * on the plate (tip 1) and the pot (tip 3), slower or faster per kg, in parts that fit the 0.3 m receiver (`partKgSmall`).
 * A part starts only if it can finish before the burn ends (no part is ever left half melted), and only if the hold
 * can take its metal.
 */

import { Constants } from '../core/Constants.js';
import { DebrisField } from '../entities/DebrisField.js';
import { pieceValues } from './BigPieceValues.js';
import { bigBodiesOf } from './BigPieces.js';
import { clamp01 } from '../core/MathUtil.js';

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

/** The largest whole kg a part of `type` ('rocketBody' | 'defunctSat') can weigh and still reach no further than `cfg.REACH_LIMIT_M`. */
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

const _partKgSmallMemo = new Map();

/**
 * The most kg (fractional, not floored) a part of `type` can weigh and still reach no further than `reachM` (the same packed-ball
 * reach test as `partKgFor`). The steel and titanium parts of the plate and pot tips fit the 0.3 m receiver (reach
 * `TOOLS.SMALL_REACH_M`, 0.15 m): about 0.63 kg of a rocket body, 1.40 kg of a satellite. `partKgFor` is the integer one at the
 * 0.30 m reach and stays as it is (the job board and about ten tests pin it).
 */
export function partKgAtReach(type, reachM, cfg = Constants.BIG_MELT) {
  const key = `${type}|${cfg.PACKED_KG_M3}|${reachM}`;
  if (_partKgSmallMemo.has(key)) return _partKgSmallMemo.get(key);
  let lo = 0, hi = 20000;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (partReachM(type, mid, cfg) <= reachM + 1e-9) lo = mid; else hi = mid;
  }
  _partKgSmallMemo.set(key, lo);
  return lo;
}

/** The part kg (fractional) a steel or titanium piece of `type` is cut to for the plate and the pot (`TOOLS.SMALL_REACH_M`). */
export function partKgSmall(type, cfg = Constants.BIG_MELT) {
  return partKgAtReach(type, cfg.TOOLS.SMALL_REACH_M, cfg);
}

// ---- Furnace tools per tip (Constants.BIG_MELT.TOOLS): which metal each tip melts, and how fast ----

/** The order tips are filled in: azimuth 40, 220, 140, 320 degrees = tips 0, 2, 1, 3 (`TipCargo.pickTip` reads it; the two aluminium tips come first). */
export const TIP_PICK_ORDER = Object.freeze([0, 2, 1, 3]);

/** The metals the tools tell apart. Any other material (composite, mli_mylar, solar_cell) or none melts on any tip as aluminium. */
const TOOL_METALS = ['aluminum', 'steel', 'titanium'];

/** True when `material` is a metal the tools tell apart ('aluminum', 'steel', 'titanium'). */
export function isToolMetal(material) { return TOOL_METALS.includes(material); }

/** True when `material` melts only in the plate's or the pot's 0.3 m receiver, in small parts ('steel', 'titanium'). */
export function needsSmallPart(material) { return material === 'steel' || material === 'titanium'; }

/** The tool of tip `tip`: 'ball' (tips 0 and 2), 'plate' (tip 1), 'pot' (tip 3); a tip index past the table is a plain 'ball'. */
export function toolOfTip(tip, cfg = Constants.BIG_MELT) {
  const t = cfg.TOOLS.TIP_TOOL[tip];
  return t || 'ball';
}

/** Can tip `tip`'s tool melt a catch of `material`? A non-metal or missing material: any tip (today's behaviour). */
export function tipCanMelt(tip, material, cfg = Constants.BIG_MELT) {
  if (!isToolMetal(material)) return true;
  return cfg.TOOLS[toolOfTip(tip, cfg)].melts.includes(material);
}

/** Sunlit seconds per kg tip `tip` takes to melt `material`: aluminium (and any non-metal) at `FURNACE_S_PER_KG`; NaN when the tool cannot melt it. */
export function tipSPerKg(tip, material, cfg = Constants.BIG_MELT) {
  if (!isToolMetal(material) || material === 'aluminum') return cfg.FURNACE_S_PER_KG;
  const r = cfg.TOOLS[toolOfTip(tip, cfg)].sPerKg[material];
  return r > 0 ? r : NaN;
}

/** `tipSPerKg` ÷ the aluminium rate: 1 for aluminium and non-metals, the slowdown (or speed-up) of that tool for a metal; NaN when it cannot melt it. */
export function tipRateFactor(tip, material, cfg = Constants.BIG_MELT) {
  return tipSPerKg(tip, material, cfg) / cfg.FURNACE_S_PER_KG;
}

/** The biggest part `planBurn` cuts from a spec: its `smallKg` for a steel or titanium piece that has one, else its `partKg`. */
export function meltPartKg(x) { return needsSmallPart(x.metal) && x.smallKg > 0 ? x.smallKg : x.partKg; }

/** `PART_KG.rocketBody`, `PART_KG.defunctSat`: computed on first read from the game's own functions. */
export const PART_KG = {
  get rocketBody() { return partKgFor('rocketBody'); },
  get defunctSat() { return partKgFor('defunctSat'); },
};

/** The type a piece's parts are sized by: its own, or a bag's heaviest big member's. */
export function pieceType(d) {
  if (!d) return null;
  if (d.isBag === true) {
    const bigs = bigBodiesOf(d);
    if (bigs.length) return bigs.reduce((a, b) => ((b.mass || 0) > (a.mass || 0) ? b : a), bigs[0]).type;
  }
  return d.type;
}

/**
 * The hold's listed value per kg of orbit metal: a sale of `BULK_THRESHOLD_KG` or more nets exactly the in-orbit price
 * per kg after the market spread and the bulk bonus (`computeSaleValue`); derived from those constants, never a literal.
 */
export function metalListedCrPerKg() {
  const m = Constants.MARKET || {};
  return Constants.BIG_PIECES.IN_ORBIT_CR_PER_KG / ((m.SELL_PRICE_MODIFIER || 0.85) * (m.BULK_BONUS_MULTIPLIER || 1.15));
}

/**
 * The schedule of one trip burn. Parts of each piece go oldest piece first, each piece in whole parts of `partKg` with
 * the remainder last; a part is cut when the delivery chain is free, delivered in `DELIVERY_S`, and melts on the
 * able furnace that frees first.
 *
 * Furnace tools (Furnace 2 step 1, `Constants.BIG_MELT.TOOLS`): a piece goes only to a tip whose tool can melt its `metal`
 * ('aluminum' | 'steel' | 'titanium'; a non-metal or none: any tip), at that tool's rate (`tipSPerKg`). A steel or titanium
 * piece is cut to its `smallKg` (the plate's and the pot's 0.3 m receiver; `partKg` when none is given). A piece with no able
 * furnace among the free tips is left for a later burn and the planner goes on to the next piece. Warm-up is the same on every tool.
 *
 * @param {number} p.burnShipS the burn's ship time, seconds (planned days x 86,400)
 * @param {Array<{id: *, kg: number, partKg: number, metalPerKg: number, metal?: (string|null), smallKg?: number}>} p.pieces melt-marked
 *   pieces, oldest catch first: `kg` still to melt, `partKg` the biggest part (aluminium and non-metals), `metalPerKg` kg of
 *   metal per kg of piece, `metal` the piece's material, `smallKg` the biggest part of a steel or titanium piece
 * @param {Array<*>} p.tips the free furnaces (tip indices)
 * @param {number} p.roomKg room in the hold for orbit metal, kg
 * @returns {{parts: Array<{pieceId: *, n: number, kg: number, metalKg: number, cutS: number, startS: number, endS: number, tip: *, last: boolean}>,
 *   stop: (null|'hold'|'time'|'furnaces'), metalKg: number, skipped?: Array<*>}}
 *   `stop`: why the work ended before every piece was done: the hold could not take the next part (`hold`), the next
 *   part could not finish inside the burn (`time`), no furnace was free, or none able to melt the work (`furnaces`); null when
 *   every piece was done. `skipped` (only when not empty): ids of pieces no free furnace could melt. Times are ship seconds from the burn's start.
 */
export function planBurn({ burnShipS, pieces, tips, roomKg }, cfg = Constants.BIG_MELT) {
  const out = { parts: [], stop: null, metalKg: 0 };
  const sizeOf = meltPartKg;
  const list = (pieces || []).filter((x) => x && x.kg > 1e-9 && sizeOf(x) > 0);
  if (!list.length) return out;
  if (!tips || !tips.length) { out.stop = 'furnaces'; return out; }
  const warmS = (cfg.RECEIVER_WARM_S || 0) / cfg.TRIP_SUN;   // each receiver warms once before its first part (every tool)
  const free = tips.map(() => warmS);                      // when each furnace is free again
  let chain = 0;                                           // when the delivery chain is free again
  let room = Number.isFinite(roomKg) ? roomKg : Infinity;
  const burn = Number.isFinite(burnShipS) ? burnShipS : 0;
  for (const piece of list) {
    const able = [];                                       // indices into `tips` whose tool melts this piece's metal
    for (let i = 0; i < tips.length; i++) if (tipCanMelt(tips[i], piece.metal, cfg)) able.push(i);
    if (!able.length) { (out.skipped || (out.skipped = [])).push(piece.id); continue; }
    const partKg = sizeOf(piece);
    let left = piece.kg;
    let n = 0;
    while (left > 1e-9) {
      const kg = left > partKg + 1e-9 ? partKg : left;
      const metalKg = kg * piece.metalPerKg;
      if (metalKg > room + 1e-9) { out.stop = 'hold'; return out; }
      let j = able[0];
      for (let a = 1; a < able.length; a++) if (free[able[a]] < free[j]) j = able[a];
      const cutS = Math.max(chain, free[j] - cfg.DELIVERY_S, 0);
      const startS = cutS + cfg.DELIVERY_S;
      const endS = startS + (kg * tipSPerKg(tips[j], piece.metal, cfg)) / cfg.TRIP_SUN;
      if (endS > burn + 1e-9) { out.stop = 'time'; return out; }
      chain = startS;
      free[j] = endS;
      room -= metalKg;
      out.metalKg += metalKg;
      left -= kg;
      out.parts.push({ pieceId: piece.id, n: n++, kg, metalKg, cutS, startS, endS, tip: tips[j], last: left <= 1e-9 });
    }
  }
  if (!out.parts.length && out.skipped) out.stop = 'furnaces';   // free tips, but none of their tools can melt what is aboard
  return out;
}

/** A piece's values at the catch: a copy at `massAtCatch`, never the shrinking remainder. A bag's values come from its big members. */
export function valuesAtCatch(d, massAtCatch) {
  if (d && d.isBag === true) return pieceValues(d);
  return pieceValues({ type: d && d.type, owner: d && d.owner, mass: massAtCatch });
}

/**
 * What the melt of a piece has paid and made once `doneKg` (kg) of it is melted (cumulative): the removal fee, the
 * holder's share of the metal at the in-orbit price (taken at the melt, not at the sale: the shop cannot tell whose
 * orbit metal is whose), and the metal. Cumulative and rounded once per point, so a part's pay is the difference of two
 * points and the total over all parts is exact.
 * @returns {{feeCr: number, shareCr: number, netCr: number, metalKg: number}}
 */
export function meltedSoFar(d, massAtCatch, doneKg) {
  const v = valuesAtCatch(d, massAtCatch);
  const f = massAtCatch > 0 ? clamp01(doneKg / massAtCatch) : 0;
  const feeCr = Math.round(v.removalFeeCr * f);
  const shareCr = Math.round(v.consentShare * v.scrapKg * f * Constants.BIG_PIECES.IN_ORBIT_CR_PER_KG);
  return { feeCr, shareCr, netCr: Math.max(0, feeCr - shareCr), metalKg: v.scrapKg * f };
}

/** One part's account: the difference of `meltedSoFar` before and after it, plus the piece's `holder` ({name, status}). */
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
 * The one line a trip says about a piece it worked on: "The furnaces melted 820 kg of the SL-14 stage: 491 kg of orbit
 * metal in the hold. Removal fee 8,200 from Russia, less Russia's share 6,888: +1,312 cr." `t` is the trip's totals
 * for the piece (sums of `meltAccount`, plus `name`).
 */
export function tripLine(t) {
  const head = `The furnaces melted ${fmt(t.kg)} kg of the ${t.name}: ${fmt(t.metalKg)} kg of orbit metal in the hold.`;
  if (!(t.feeCr > 0) && t.holder && t.holder.status === 'abandoned') return `${head} Nobody owns it, so there is no removal fee.`;
  const who = (t.holder && t.holder.name) || 'the owner';
  return `${head} Removal fee ${fmt(t.feeCr)} from ${who}, less ${who}'s share ${fmt(t.shareCr)}: +${fmt(t.netCr)} cr.`;
}

export function tooShortLine(name) {
  return `This trip was too short to melt any of the ${name}.`;
}

export function noFurnaceLine(name) {
  return `Every tip furnace is busy: the ${name} waits for a trip with one free.`;
}

/**
 * Furnace 2: the line for a piece left out of the burn because no FREE tip's tool can melt its metal (other tips may be free, or other
 * pieces may be melting). Names the metal and the furnaces that can melt it: steel the steel (plate) and titanium (pot) ones,
 * titanium the titanium one.
 * @param {string} name the piece's name ("SL-14 stage")
 * @param {string} metal 'steel' | 'titanium' (the metals only some tools melt)
 * @param {Iterable<number>} [cannotWork] tips that are free but whose sun oven cannot open this trip (an able furnace in this set is not "busy")
 */
export function noAbleFurnaceLine(name, metal, cfg = Constants.BIG_MELT, cannotWork = []) {
  const label = { plate: 'steel', pot: 'titanium' };
  const dead = new Set(cannotWork);
  const able = [];                       // label -> true when that furnace cannot work this trip (else it is busy)
  const cannot = {};
  for (let i = 0; i < cfg.TOOLS.TIP_TOOL.length; i++) {
    if (!tipCanMelt(i, metal, cfg)) continue;
    const l = label[toolOfTip(i, cfg)] || null;
    if (!l) continue;
    if (!able.includes(l)) able.push(l);
    if (dead.has(i)) cannot[l] = true;
  }
  if (!able.length) return noFurnaceLine(name);
  const list = able.length > 1 ? `the ${able.join(' and ')} furnaces` : `the ${able[0]} furnace`;
  const nCannot = able.filter((l) => cannot[l]).length;
  let why;
  if (nCannot === 0) why = able.length > 1 ? 'both are busy' : 'it is busy';
  else if (able.length === 1) why = 'it cannot work this trip';
  else if (nCannot === able.length) why = 'neither can work this trip';
  else why = 'one is busy and the other cannot work this trip';
  return `The ${name} (${metal}) waits: only ${list} can melt it, and ${why}.`;
}
