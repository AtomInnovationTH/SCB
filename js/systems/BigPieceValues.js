/**
 * BigPieceValues.js - what a big piece is worth, and what each way of disposing of it pays (Nets step 3 slice 5, lane 5a;
 * DECISIONS §33 row 16-17; the numbers are `Constants.BIG_PIECES`).
 *
 * Pure: imports Constants only. A BIG PIECE is a field body of type `rocketBody` or `defunctSat` that carries an `owner`
 * ({name, status: 'owner'|'insurer'|'abandoned', launchYear, notable}; set only by the high-field spawn). A scoop bag is the sum of
 * its big members (`bagMembers[i].piece`, each by its own mass and owner). Anything else values to zero.
 *
 *   pieceValues(d)               -> {removalFeeCr, scrapKg, scrapCr, anchorCr, partsCr, collectorCr, consentShare, holder: {name, status}}
 *   fatePay(d, fate, {lifeYears, anchor}) -> {fate, totalCr, lines: [{key, label, cr, from?, shareCr?}], note?}
 *   payLine(d, pay)              -> "removal fee 14,000 from Russia, parts 3,920 after Russia's share, collector 3,000. +20,920 cr."
 *
 * What each fate pays (C3/C5): satellite = removal fee + parts x (1 - consent) + collector; push = removal fee (it re-enters within 25
 * years by construction); sail = removal fee only when its life with the sail (`lifeYears`, from OrbitLifetime.sailLifeYears) is within
 * RULE_YEARS, else nothing; keep = nothing yet; melt = removal fee + scrap x (1 - consent) (or, with `anchor`, the anchor metal less the holder's share of the scrap at the in-orbit price, lane 5e).
 * The owner pays the removal fee; an `abandoned` piece has no owner: no fee and no consent. Every credit figure is a whole number.
 * @module systems/BigPieceValues
 */

import { Constants } from '../core/Constants.js';

/** Plain-word labels (the fate list and the pay line read these). */
export const LABELS = {
  fee: 'Removal fee',
  scrap: 'Scrap metal',
  anchor: 'Metal for the anchor',
  parts: 'Parts to reuse',
  collector: 'Collector value',
  share: "Owner's share",
};

const isBigLike = (p) => !!p && Constants.BIG_PIECES.TYPES.includes(p.type) && !!p.owner;
const massOf = (p) => (Number.isFinite(p.mass) ? p.mass : (Number.isFinite(p.massKg) ? p.massKg : 0));

/** The big members of `d`: itself, or the big pieces inside a scoop bag. */
function bigMembers(d) {
  if (!d) return [];
  if (d.isBag === true && Array.isArray(d.bagMembers)) {
    return d.bagMembers.map((m) => (m && m.piece) ? m.piece : m).filter(isBigLike);
  }
  return isBigLike(d) ? [d] : [];
}

/** One big body's values, whole credits. */
function oneValues(p) {
  const B = Constants.BIG_PIECES;
  const mass = massOf(p);
  const status = p.owner.status;
  const abandoned = status === 'abandoned';
  const price = B.IN_ORBIT_CR_PER_KG;
  const scrapKg = mass * (B.METAL_FRACTION[p.type] || 0);
  const year = p.owner.launchYear;
  let collectorCr = 0;
  if (Number.isFinite(year)) {
    if (year < B.COLLECTOR.EARLY_BEFORE_YEAR) collectorCr = B.COLLECTOR.EARLY_CR;
    else if (year <= B.COLLECTOR.MID_UNTIL_YEAR) collectorCr = B.COLLECTOR.MID_CR;
  }
  return {
    removalFeeCr: abandoned ? 0 : Math.round(mass * B.FEE_CR_PER_KG),
    scrapKg,
    scrapCr: Math.round(scrapKg * price),
    anchorCr: Math.round(scrapKg * (price + B.ANCHOR_PREMIUM_CR_PER_KG)),
    partsCr: Math.round(mass * (B.PARTS_FRACTION[p.type] || 0) * price),
    collectorCr,
    consentShare: abandoned ? 0 : B.CONSENT_SHARE,
    holder: { name: p.owner.name == null ? null : p.owner.name, status },
    _mass: mass,
  };
}

/**
 * What a big piece is worth. A bag sums its big members; a piece that is not big values to zero.
 * @param {object} d the field body (or scoop bag)
 * @returns {{removalFeeCr:number, scrapKg:number, scrapCr:number, anchorCr:number, partsCr:number, collectorCr:number, consentShare:number, holder:{name:(string|null), status:(string|null)}}}
 */
export function pieceValues(d) {
  const ms = bigMembers(d);
  const out = { removalFeeCr: 0, scrapKg: 0, scrapCr: 0, anchorCr: 0, partsCr: 0, collectorCr: 0, consentShare: 0, holder: { name: null, status: null } };
  if (!ms.length) return out;
  let massSum = 0, consentMass = 0;
  for (const p of ms) {
    const v = oneValues(p);
    out.removalFeeCr += v.removalFeeCr; out.scrapKg += v.scrapKg; out.scrapCr += v.scrapCr; out.anchorCr += v.anchorCr;
    out.partsCr += v.partsCr; out.collectorCr += v.collectorCr;
    massSum += v._mass; consentMass += v._mass * v.consentShare;
  }
  out.consentShare = massSum > 0 ? consentMass / massSum : 0;
  const first = oneValues(ms[0]);
  out.holder = { name: first.holder.name, status: first.holder.status };
  return out;
}

/**
 * What one way of disposing of a big piece pays now.
 * @param {object} d the piece (or bag)
 * @param {'satellite'|'push'|'sail'|'keep'|'melt'} fate
 * @param {{lifeYears?:number, anchor?:boolean}} [opts] `lifeYears` the piece's life with the sail (sail only; missing = too long);
 *   `anchor` pays a melt as metal for the anchor (default: scrap metal)
 * @returns {{fate:string, totalCr:number, lines:Array<{key:string,label:string,cr:number,from?:string,shareCr?:number}>, note?:string}}
 */
export function fatePay(d, fate, opts = {}) {
  const lines = [];
  let note;
  const add = (key, cr, from, shareCr) => {
    cr = Math.round(cr);
    if (!(cr > 0)) return;
    const line = { key, label: LABELS[key], cr };
    if (from) line.from = from;
    if (shareCr > 0) line.shareCr = Math.round(shareCr);
    lines.push(line);
  };
  const lifeOk = Number.isFinite(opts.lifeYears) && opts.lifeYears <= Constants.BIG_PIECES.RULE_YEARS;
  for (const p of bigMembers(d)) {
    const v = oneValues(p);
    const from = v.holder.name;
    const net = (gross) => gross * (1 - v.consentShare);
    switch (fate) {
      case 'satellite':
        add('fee', v.removalFeeCr, from);
        add('parts', net(v.partsCr), from, v.partsCr * v.consentShare);
        add('collector', v.collectorCr);
        break;
      case 'push':
        add('fee', v.removalFeeCr, from);
        break;
      case 'sail':
        if (lifeOk) add('fee', v.removalFeeCr, from);
        break;
      case 'melt': {
        add('fee', v.removalFeeCr, from);
        if (opts.anchor) {
          // lane 5e (E4): the holder's share is taken at the MELT, at the in-orbit price of the metal, whatever the elevator then pays for it:
          // the anchor line is the anchor's price less that share (SL-14: 63,000 - 11,760 = 51,240; it was 63,000 x 0.8 = 50,400 before)
          const shareCr = v.scrapCr * v.consentShare;
          add('anchor', v.anchorCr - shareCr, from, shareCr);
        } else {
          add('scrap', net(v.scrapCr), from, v.scrapCr * v.consentShare);
        }
        break;
      }
      default: break;   // keep (or an unknown fate): nothing yet
    }
  }
  if (fate === 'sail' && !lifeOk && bigMembers(d).length) {
    note = Number.isFinite(opts.lifeYears)
      ? `no removal fee: with the sail it would stay up ${Math.round(opts.lifeYears)} years`
      : 'no removal fee: with the sail it would not come down';
  }
  const totalCr = lines.reduce((s, l) => s + l.cr, 0);
  const pay = { fate, totalCr, lines };
  if (note) pay.note = note;
  return pay;
}

const fmt = (n) => Math.round(n).toLocaleString('en-US');

/**
 * The plain sentence for a pay, e.g. "removal fee 14,000 from Russia, parts 3,920 after Russia's share, collector 3,000. +20,920 cr."
 * The caller puts its action words in front ("Handed the SL-14 stage to the satellite: ").
 * @param {object} d the piece (unused beyond the contract: the names ride on the pay's lines)
 * @param {{totalCr:number, lines:Array, note?:string}} pay from fatePay
 * @returns {string}
 */
export function payLine(d, pay) {
  const p = pay || { totalCr: 0, lines: [] };
  const parts = (p.lines || []).map((l) => {
    const name = l.from || null;
    const poss = name ? `${name}'s` : null;
    switch (l.key) {
      case 'fee': return name ? `removal fee ${fmt(l.cr)} from ${name}` : `removal fee ${fmt(l.cr)}`;
      case 'parts': return `parts ${fmt(l.cr)}${poss && l.shareCr ? ` after ${poss} share` : ''}`;
      case 'scrap': return `scrap metal ${fmt(l.cr)}${poss && l.shareCr ? ` after ${poss} share` : ''}`;
      case 'anchor': return `metal for the anchor ${fmt(l.cr)}${poss && l.shareCr ? ` after ${poss} share` : ''}`;
      case 'collector': return `collector ${fmt(l.cr)}`;
      default: return `${String(l.label || l.key).toLowerCase()} ${fmt(l.cr)}`;
    }
  });
  const head = parts.length ? parts.join(', ') : (p.note || 'nothing to pay');
  return `${head}. +${fmt(p.totalCr || 0)} cr.`;
}
