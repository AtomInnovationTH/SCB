/**
 * FateRows - the words of the fate list: what a big caught piece is worth and the five ways to dispose of it, with what each pays
 * and costs NOW (Nets step 3 slice 5, lane 5c; plan C3, C5, C6 and L1; DECISIONS §33 rows 16-17; Constants.BIG_PIECES).
 *
 * Pure: no DOM, no events, no game state of its own. `buildFateRows(piece, ctx)` reads the piece (`pieceValues`, `fatePay`,
 * `pushTargetKm`, `sailLifeYears` of lane 5a) and a context the caller gives it (`fateContext` builds the live one from the field
 * registry, her ship and her stock). The list (js/ui/FateList.js), the Targets pane's row and the tests all read the same words.
 *
 *   values   "Removal fee: 14,000 (Russia pays when it is gone)" / "Scrap metal: 840 kg, 58,800" / "Metal for the anchor: 840 kg, 63,000"
 *            / "Parts to reuse: 4,900" / "Collector value: 3,000" / "Rights: Russia owns it; reusing or melting it costs 20 % of what you sell"
 *   rows     one per fate, in this order, `{id, text, selectable, state, current}`:
 *     satellite  "Hand it over now . pays 20,920" (berthed), else the nearest satellite by height:
 *                "Hand it to the satellite at 825 km . next trip, 14 days, 1.6 kg gas . pays 20,920" (the numbers are `planTo`'s)
 *     push       "Push it down to 635 km and let go . 10.4 kg gas, 95 days, then about 1.8 kg to climb back . pays 14,000"
 *                (down from her height with her mass now, back up without the piece); short of gas for both legs: not selectable,
 *                "needs 12.2 kg gas, 4.7 kg short"; at or within 0.5 km above that height: selectable, "Let the SL-14 stage go here at
 *                635 km: it comes down in about 24 years . pays 14,000" (the where-next row's words)
 *     sail       "Fit a drag sail and let go . down in 39 years . over 25 years, no fee . 1 of 2 sails"; none aboard: not selectable
 *     keep       "Keep it for now . pays nothing yet . 1,400 kg more on every trip"
 *     melt       "Melt it for metal . melted in the tip furnaces on your next trips . pays up to 61,040"; selectable only with
 *                `ctx.bigMelt` (FEATURE_FLAGS.BIG_MELT), else "the furnaces cannot take it yet"
 *   A piece already in the furnaces (`_disposal.meltDoneKg` > 0, C7 "Melt progress"): `progress` "In the furnaces: 820 of 1,400 kg
 *   melted" and no fate row at all.
 *
 * @module systems/FateRows
 */

import { Constants } from '../core/Constants.js';
import { pieceValues, fatePay } from './BigPieceValues.js';
import { pushTargetKm, sailLifeYears, lifetimeYears, dragAreaM2 } from './OrbitLifetime.js';
import { creditsText, kgText, daysText } from './WhereNextRows.js';
import { tripProfile, realThrustN, daysWithTurnWait } from './TripProfile.js';
import { pieceName, pieceNameCap, bigBodiesOf, FATES } from './BigPieces.js';

const DOT = '\u00b7';
/** How far above the push height she still counts as "at it" (km): the same band as the where-next push row (lane 5d). */
const PUSH_SLACK_KM = 0.5;

/** The order of the five rows. */
export const FATE_ORDER = Object.freeze(['satellite', 'push', 'sail', 'keep', 'melt']);

/** @param {number} cr @returns {string} "pays 20,920", or "pays nothing" */
function paysText(cr) { return cr > 0 ? `pays ${creditsText(cr)}` : 'pays nothing'; }

/** @param {number} years @returns {string} "39 years", "1 year", "under a year", "never" */
export function yearsText(years) {
  if (!Number.isFinite(years)) return 'never';
  if (years < 1) return 'under a year';
  const y = Math.round(years);
  return `${y} ${y === 1 ? 'year' : 'years'}`;
}

/** @param {number} n @returns {string} a mass, whole kg with commas */
const kgWhole = (n) => creditsText(n);

/**
 * The largest pay among the fates a piece can still pick (the Targets pane says "up to"): satellite or push, and melt only while the
 * furnaces can take it (`FEATURE_FLAGS.BIG_MELT`; with it off the melt row cannot be picked, so its pay is not on offer). A sail pays
 * the fee at most, which the push pays too.
 * @param {object} d the piece (or bag) @returns {number} credits (0 for a piece that is not big)
 */
export function maxFatePayCr(d) {
  let best = 0;
  const fates = Constants.FEATURE_FLAGS && Constants.FEATURE_FLAGS.BIG_MELT ? ['satellite', 'push', 'melt'] : ['satellite', 'push'];
  for (const f of fates) best = Math.max(best, fatePay(d, f).totalCr);
  return best;
}

/**
 * The Targets pane's line for a big piece (plan L4): "Pays when disposed of: up to 61,040 · Russia owns it". Null for a piece that is not big.
 * @param {object|null} d the field body @returns {string|null}
 */
export function bigPayLine(d) {
  if (!d || !bigBodiesOf(d).length) return null;
  const h = holderOf(d);
  const who = h.status === 'abandoned' ? 'nobody owns it'
    : (h.status === 'insurer' ? `${h.name || 'its insurer'} owns it` : `${h.name || 'its owner'} owns it`);
  return `Pays when disposed of: up to ${creditsText(maxFatePayCr(d))} ${DOT} ${who}`;
}

/** @returns {{name: (string|null), status: (string|null)}} who holds the piece's papers, first big member */
function holderOf(d) {
  const first = bigBodiesOf(d)[0];
  return first && first.owner ? { name: first.owner.name == null ? null : first.owner.name, status: first.owner.status } : { name: null, status: null };
}

/** The values block (plain words, C3). */
function valueLines(d) {
  const v = pieceValues(d);
  const h = holderOf(d);
  const who = h.name || (h.status === 'insurer' ? 'its insurer' : 'its owner');
  const pct = Math.round(v.consentShare * 100);
  const out = [];
  out.push(h.status === 'abandoned'
    ? 'Removal fee: none (its company is gone, so nobody pays)'
    : `Removal fee: ${creditsText(v.removalFeeCr)} (${who} pays when it is gone)`);
  out.push(`Scrap metal: ${kgWhole(v.scrapKg)} kg, ${creditsText(v.scrapCr)}`);
  out.push(`Metal for the anchor: ${kgWhole(v.scrapKg)} kg, ${creditsText(v.anchorCr)}`);
  out.push(`Parts to reuse: ${creditsText(v.partsCr)}`);
  out.push(v.collectorCr > 0 ? `Collector value: ${creditsText(v.collectorCr)}` : 'Collector value: none');
  if (h.status === 'abandoned') out.push('Rights: nobody owns it, so there is nobody to ask or pay');
  else if (h.status === 'insurer') out.push(`Rights: ${who} paid out and owns it; reusing or melting it costs ${pct} % of what you sell`);
  else out.push(`Rights: ${who} owns it; reusing or melting it costs ${pct} % of what you sell`);
  return out;
}

/**
 * @typedef {object} FateRow
 * @property {string} id           the fate: 'satellite' | 'push' | 'sail' | 'keep' | 'melt'
 * @property {string} text
 * @property {boolean} selectable
 * @property {string} state        'ok' | 'short' | 'cannot' | 'none' | 'off' | 'low'
 * @property {boolean} current     the piece's marked fate is this one
 * @property {string} label @property {string} money @property {string} sub   the big row's three strings (`rowWords`)
 * @property {string} clause @property {string} why   the short phrase and reason for the "Not possible now" detail line
 * @property {number} [payCr]      what this fate pays now
 * @property {number} [gasKg] @property {number} [shortKg] @property {number} [days] @property {number} [backGasKg] @property {number} [targetKm]
 */

/**
 * @param {object} piece the field body (or scoop bag) with `_disposal`
 * @param {{fromKm?: number, planTo?: Function, planBack?: Function, berth?: ({id: string, altKm: number}|null), sats?: Array<{id: string, altKm: number}>,
 *   sailsAboard?: number, bigMelt?: boolean, turnWaitS?: ({up: number, down: number}|null)}} [ctx] see `fateContext`
 * @returns {{name: string, mass: number, values: string[], rows: FateRow[], progress: (string|null), maxPayCr: number, picked: (string|null), berthed: boolean,
 *   choices: string[], also: string[], details: string[]}}
 *   `rows` are all five fates; `choices` the ids shown big (see `pickChoices`), `also` the other fates she can still pick, `details` the short
 *   lines under them ("Not possible now: ...", "Owner: ...", "Values: ...").
 */
export function buildFateRows(piece, ctx = {}) {
  const d = piece;
  const disp = (d && d._disposal) || {};
  const picked = FATES.includes(disp.fate) ? disp.fate : null;
  const mass = d && Number.isFinite(d.mass) ? d.mass : 0;
  const base = { name: pieceNameCap(d), mass, values: valueLines(d), maxPayCr: maxFatePayCr(d), picked, berthed: !!ctx.berth };
  if (disp.meltDoneKg > 0) {
    const total = Number.isFinite(disp.massAtCatch) && disp.massAtCatch > 0 ? disp.massAtCatch : mass;
    return { ...base, rows: [], progress: `In the furnaces: ${kgWhole(disp.meltDoneKg)} of ${kgWhole(total)} kg melted`, choices: [], also: [], details: [] };
  }
  const x = { mass, name: pieceName(d), berthed: !!ctx.berth };
  const rows = [
    satelliteRow(d, ctx), pushRow(d, ctx), sailRow(d, ctx), keepRow(d, mass), meltRow(d, ctx),
  ].map((r) => withWords({ ...r, current: r.id === picked }, x));
  const { choices, also } = pickChoices(rows);
  return { ...base, rows, progress: null, choices, also, details: detailLines(d, rows) };
}

/** How easy a fate is to finish, easiest first: one hand-over beats a trip; the melt takes several trips (keep is not ranked: it is always last). */
export const EASE_RANK = Object.freeze(['satellite', 'sail', 'push', 'melt']);

/**
 * Which fates show as the big choices, by rule (owner 2026-10-26: "3 easy choices. 1st choice is most likely"):
 *   choice 1 = the easiest selectable fate that pays (by `EASE_RANK`); none pays: the easiest selectable one;
 *   choice 2 = the selectable paying fate with the highest pay other than choice 1 (a tie goes to the easier); none: the next selectable by rank;
 *   choice 3 = keep, always last. Never a fate that cannot be picked. The fate she already picked (`current`), if selectable, is always shown:
 *   it takes slot 2 when the rule leaves it out. Every other selectable fate comes back in `also` (still pickable), in `FATE_ORDER`.
 * Pure. @param {FateRow[]} rows @returns {{choices: string[], also: string[]}}
 */
export function pickChoices(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const ranked = EASE_RANK.map((id) => list.find((r) => r.id === id)).filter((r) => r && r.selectable);
  const paying = ranked.filter((r) => r.payCr > 0);
  const first = paying[0] || ranked[0] || null;
  let second = null;
  if (first) {
    const others = paying.filter((r) => r !== first);
    for (const r of others) if (!second || r.payCr > second.payCr) second = r;       // ranked order: a tie keeps the easier
    if (!second) second = ranked.find((r) => r !== first) || null;
  }
  const cur = list.find((r) => r.current && r.selectable && r.id !== 'keep') || null;
  const big = [first, second].filter(Boolean);
  if (cur && !big.includes(cur)) { if (big.length > 1) big[1] = cur; else big.push(cur); }
  const choices = big.map((r) => r.id);
  if (list.some((r) => r.id === 'keep' && r.selectable)) choices.push('keep');
  const also = FATE_ORDER.filter((id) => !choices.includes(id) && list.some((r) => r.id === id && r.selectable));
  return { choices, also };
}

/** @private the details under the choices: what cannot be done now (with why), who owns it, what it is worth. */
function detailLines(d, rows) {
  const out = [];
  const no = rows.filter((r) => !r.selectable).map((r) => `${r.clause}${r.why ? ` (${r.why})` : ''}${r.current ? ' (your pick)' : ''}`);
  if (no.length) out.push(`Not possible now: ${no.join(` ${DOT} `)}`);
  const h = holderOf(d);
  const v = pieceValues(d);
  const who = h.name || (h.status === 'insurer' ? 'its insurer' : 'its owner');
  const pct = Math.round(v.consentShare * 100);
  if (h.status === 'abandoned') out.push('Owner: nobody (its company is gone), so no removal fee and nobody to ask or pay.');
  else if (h.status || h.name) {
    const takes = pct > 0 ? ` ${who} takes ${pct} % of ${v.partsCr > 0 ? 'metal or parts' : 'metal'} you sell.` : '';   // only the parts the piece has; no rights, no sentence
    out.push(`Owner: ${who}. Removal fee ${creditsText(v.removalFeeCr)} cr, paid when it is gone.${takes}`);
  }
  const vals = [`scrap metal ${kgWhole(v.scrapKg)} kg, ${creditsText(v.scrapCr)} cr`, `anchor metal ${creditsText(v.anchorCr)} cr`];
  if (v.partsCr > 0) vals.push(`parts ${creditsText(v.partsCr)} cr`);
  if (v.collectorCr > 0) vals.push(`collector ${creditsText(v.collectorCr)} cr`);
  out.push(`Values: ${vals.join(` ${DOT} `)}`);
  return out;
}

/** @private "Hand it to a satellite": at once while berthed, else the nearest satellite by height. */
function satelliteRow(d, ctx) {
  const payCr = fatePay(d, 'satellite').totalCr;
  const head = 'Hand it to a satellite';
  if (ctx.berth) return { id: 'satellite', state: 'ok', selectable: true, payCr, text: `Hand it over now ${DOT} ${paysText(payCr)}` };
  const sats = Array.isArray(ctx.sats) ? ctx.sats : [];
  const from = Number.isFinite(ctx.fromKm) ? ctx.fromKm : 0;
  const sat = sats.slice().sort((a, b) => Math.abs(a.altKm - from) - Math.abs(b.altKm - from) || a.altKm - b.altKm)[0];
  if (!sat) return { id: 'satellite', state: 'none', selectable: false, payCr, text: `${head} ${DOT} there is no satellite to take it` };
  const where = `Hand it to the satellite at ${Math.round(sat.altKm)} km`;
  const plan = typeof ctx.planTo === 'function' ? ctx.planTo(sat) : null;
  if (!plan || !plan.profile || !plan.profile.ok) {
    return { id: 'satellite', state: 'cannot', selectable: true, payCr, text: `${where} ${DOT} at your next berth ${DOT} ${paysText(payCr)}` };
  }
  const gasKg = plan.profile.gasKg;
  const days = tripDays(plan.profile, ctx.turnWaitS);
  if (!plan.enough) {
    const shortKg = gasKg - plan.gasAboardKg;
    return { id: 'satellite', state: 'short', selectable: true, payCr, gasKg, shortKg, days, targetKm: sat.altKm,
      text: `${where} ${DOT} next trip needs ${kgText(gasKg)} kg gas, ${kgText(shortKg)} kg short ${DOT} ${paysText(payCr)}` };
  }
  return { id: 'satellite', state: 'ok', selectable: true, payCr, gasKg, days, targetKm: sat.altKm,
    text: `${where} ${DOT} next trip, ${daysText(days)}, ${kgText(gasKg)} kg gas ${DOT} ${paysText(payCr)}` };
}

// ── the words of a row: label, money, sub (the list's big rows) and clause / why (its "Not possible now" line) ──────────────────

/** @param {number} cr @returns {string} "+19,293 cr", or "pays nothing" */
function plusCr(cr) { return cr > 0 ? `+${creditsText(cr)} cr` : 'pays nothing'; }

/**
 * The one table from a row's fate and state to its short words, for every state this file produces (the fate list paints these;
 * `text` stays the long single line). Built from the same numbers as `text`.
 * @param {string} id @param {string} state @param {object} r the row as built (payCr, gasKg, shortKg, days, backGasKg, targetKm, lifeYears ...)
 * @param {{mass?: number, name?: string, berthed?: boolean}} x what the row does not carry itself (the piece's mass and name, berthed)
 * @returns {{label: string, money: string, sub: string, clause: string, why: string}}
 */
export function rowWords(id, state, r, x = {}) {
  const gas = (k) => `${kgText(k)} kg gas`;
  switch (`${id}/${state}`) {
    case 'satellite/ok':
      return x.berthed
        ? { label: 'Hand it over now', money: plusCr(r.payCr), sub: 'the satellite is right here', clause: 'hand it over now', why: '' }
        : { label: 'Hand it to the satellite', money: plusCr(r.payCr), sub: `next trip, ${daysText(r.days)} ${DOT} ${gas(r.gasKg)}`, clause: 'hand it to the satellite', why: '' };
    case 'satellite/short':
      return { label: 'Hand it to the satellite', money: plusCr(r.payCr), sub: `next trip needs ${gas(r.gasKg)}, ${kgText(r.shortKg)} kg short`,
        clause: 'hand it to the satellite', why: `${kgText(r.shortKg)} kg gas short` };
    case 'satellite/cannot':
      return { label: 'Hand it to the satellite', money: plusCr(r.payCr), sub: 'at your next berth', clause: 'hand it to the satellite', why: 'at your next berth' };
    case 'satellite/none':
      return { label: 'Hand it to a satellite', money: plusCr(r.payCr), sub: 'there is no satellite to take it', clause: 'hand it to a satellite', why: 'there is no satellite to take it' };
    case 'push/ok': {
      const km = Math.round(r.targetKm);
      return { label: `Push it down to ${km} km and let go`, money: plusCr(r.payCr),
        sub: `${gas(r.gasKg)}, ${daysText(r.days)} ${DOT} then about ${kgText(r.backGasKg)} kg to climb back`, clause: `push it down to ${km} km`, why: '' };
    }
    case 'push/low': {
      const n = Math.max(1, Math.round(r.lifeYears));
      const when = Number.isFinite(r.lifeYears) ? `comes down in about ${n} ${n === 1 ? 'year' : 'years'}` : 'it stays up';
      return { label: `Let the ${x.name || 'piece'} go here`, money: plusCr(r.payCr), sub: `at ${Math.round(r.fromKm)} km ${DOT} ${when}`, clause: 'let it go here', why: '' };
    }
    case 'push/short': {
      const km = Math.round(r.targetKm);
      return { label: `Push it down to ${km} km and let go`, money: plusCr(r.payCr), sub: `needs ${kgText(r.gasKg + r.backGasKg)} kg gas, ${kgText(r.shortKg)} kg short`,
        clause: `push it down to ${km} km`, why: `${kgText(r.shortKg)} kg gas short` };
    }
    case 'push/cannot': {
      const km = Number.isFinite(r.targetKm) ? ` to ${Math.round(r.targetKm)} km` : '';
      const why = r.reason || 'its size is not known';
      return { label: `Push it down${km} and let go`, money: plusCr(r.payCr), sub: why, clause: `push it down${km}`, why };
    }
    case 'sail/ok':
      return { label: 'Fit a drag sail and let go', money: r.within ? plusCr(r.payCr) : 'no fee',
        sub: `down in ${yearsText(r.lifeYears)}${r.within ? '' : ` (over ${Constants.BIG_PIECES.RULE_YEARS} years)`} ${DOT} 1 of ${r.aboard} ${r.aboard === 1 ? 'sail' : 'sails'}`,
        clause: 'fit a drag sail', why: '' };
    case 'sail/none':
      return { label: 'Fit a drag sail and let go', money: 'no fee', sub: 'buy one at a resupply satellite', clause: 'fit a drag sail', why: 'buy one at a resupply satellite' };
    case 'keep/ok':
      return { label: 'Keep it for now', money: 'pays nothing yet', sub: `${creditsText(x.mass)} kg more on every trip`, clause: 'keep it for now', why: '' };
    case 'melt/ok':
      return { label: 'Melt it for metal', money: `up to ${plusCr(r.payCr)}`, sub: 'in the tip furnaces, over your next trips', clause: 'melt it for metal', why: '' };
    case 'melt/off':
      return { label: 'Melt it for metal', money: `up to ${plusCr(r.payCr)}`, sub: 'the furnaces cannot take it yet', clause: 'melt it for metal', why: 'the furnaces cannot take it yet' };
    default:
      return { label: String(id), money: '', sub: '', clause: String(id), why: '' };
  }
}

/** @private add the words to a built row (the row's own `text` is unchanged). */
function withWords(row, x) {
  const w = rowWords(row.id, row.state, row, x);
  return { ...row, label: w.label, money: w.money, sub: w.sub, clause: w.clause, why: w.why };
}

/** @private the days a trip shows: the profile's plus the wait for her nose, as the where-next rows say them. */
function tripDays(profile, turn) {
  if (!turn || typeof turn !== 'object') return profile.days;
  const w = profile.dir > 0 ? turn.up : (profile.dir < 0 ? turn.down : 0);
  return daysWithTurnWait(profile.days, Number.isFinite(w) ? w : 0);
}

/** @private "Push it down": to its 25-year height, let go there, then climb back; both legs must be in the tank. */
function pushRow(d, ctx) {
  const payCr = fatePay(d, 'push').totalCr;
  const target = pushTargetKm(d);
  if (!Number.isFinite(target)) return { id: 'push', state: 'cannot', selectable: false, payCr, reason: 'its size is not known', text: `Push it down ${DOT} its size is not known` };
  const head = `Push it down to ${Math.round(target)} km and let go`;
  const from = Number.isFinite(ctx.fromKm) ? ctx.fromKm : null;
  if (from != null && from <= target + PUSH_SLACK_KM) {
    // At or below the push height (the band's top is 0.5 km above it, as the where-next row says): nothing to push, so let it go here.
    // Same words and numbers as WhereNextRows.pushRow (lane 5d): the life at her height, the pay of the push.
    const life = lifetimeYears(from, d.mass, dragAreaM2(d));
    const n = Math.max(1, Math.round(life));
    const when = Number.isFinite(life) ? `it comes down in about ${n} ${n === 1 ? 'year' : 'years'}` : 'it stays up';
    return { id: 'push', state: 'low', selectable: true, payCr, targetKm: target, lifeYears: life, fromKm: from,
      text: `Let the ${pieceName(d)} go here at ${Math.round(from)} km: ${when} ${DOT} ${paysText(payCr)}` };
  }
  const down = typeof ctx.planTo === 'function' ? ctx.planTo({ id: 'free', altKm: target }) : null;
  if (!down || !down.profile || !down.profile.ok) {
    return { id: 'push', state: 'cannot', selectable: false, payCr, targetKm: target, reason: 'the thruster cannot take her there', text: `${head} ${DOT} the thruster cannot take her there` };
  }
  const back = typeof ctx.planBack === 'function' ? ctx.planBack(down, target, from != null ? from : down.fromKm, d.mass) : null;
  if (!back || !back.ok) {
    return { id: 'push', state: 'cannot', selectable: false, payCr, targetKm: target, reason: 'the thruster cannot bring her back up', text: `${head} ${DOT} the thruster cannot bring her back up` };
  }
  const gasKg = down.profile.gasKg;
  const backGasKg = back.gasKg;
  const days = tripDays(down.profile, ctx.turnWaitS);
  const needKg = gasKg + backGasKg;
  if (needKg > down.gasAboardKg + 1e-9) {
    const shortKg = needKg - down.gasAboardKg;
    return { id: 'push', state: 'short', selectable: false, payCr, gasKg, backGasKg, shortKg, days, targetKm: target,
      text: `${head} ${DOT} needs ${kgText(needKg)} kg gas, ${kgText(shortKg)} kg short` };
  }
  return { id: 'push', state: 'ok', selectable: true, payCr, gasKg, backGasKg, days, targetKm: target,
    text: `${head} ${DOT} ${kgText(gasKg)} kg gas, ${daysText(days)}, then about ${kgText(backGasKg)} kg to climb back ${DOT} ${paysText(payCr)}` };
}

/** @private "Fit a drag sail": one from her stock, let go where she is. */
function sailRow(d, ctx) {
  const head = 'Fit a drag sail and let go';
  const aboard = Number.isFinite(ctx.sailsAboard) ? Math.max(0, Math.floor(ctx.sailsAboard)) : 0;
  if (aboard < 1) {
    return { id: 'sail', state: 'none', selectable: false, payCr: 0, text: `${head} ${DOT} needs a drag sail: buy one at a resupply satellite` };
  }
  const km = Number.isFinite(ctx.fromKm) ? ctx.fromKm : NaN;
  const life = sailLifeYears(d, km);
  const pay = fatePay(d, 'sail', { lifeYears: life });
  const within = Number.isFinite(life) && life <= Constants.BIG_PIECES.RULE_YEARS;
  const rule = within ? paysText(pay.totalCr) : `over ${Constants.BIG_PIECES.RULE_YEARS} years, no fee`;
  return { id: 'sail', state: 'ok', selectable: true, payCr: pay.totalCr, lifeYears: life, aboard, within,
    text: `${head} ${DOT} down in ${yearsText(life)} ${DOT} ${rule} ${DOT} 1 of ${aboard} ${aboard === 1 ? 'sail' : 'sails'}` };
}

/** @private "Keep it for now": the default; its mass already costs gas on every trip. */
function keepRow(d, mass) {
  return { id: 'keep', state: 'ok', selectable: true, payCr: 0, text: `Keep it for now ${DOT} pays nothing yet ${DOT} ${kgWhole(mass)} kg more on every trip` };
}

/** @private "Melt it for metal": the tip furnaces, on trips (lane 5e); with the flag off the furnaces cannot take it yet. */
function meltRow(d, ctx) {
  const payCr = fatePay(d, 'melt').totalCr;
  const head = 'Melt it for metal';
  if (!ctx.bigMelt) return { id: 'melt', state: 'off', selectable: false, payCr, text: `${head} ${DOT} the furnaces cannot take it yet` };
  return { id: 'melt', state: 'ok', selectable: true, payCr, text: `${head} ${DOT} melted in the tip furnaces on your next trips ${DOT} pays up to ${creditsText(payCr)}` };
}

// ── the live context ───────────────────────────────────────────────────────────

const _backCache = new Map();
const BACK_CACHE_MAX = 32;

/**
 * The context the rows read, from the live game: her height, `planTo` (the registry's own: the gas now, her mass now), `planBack` (the
 * climb back WITHOUT the piece: the push lets it go, so her mass then is her mass now less the piece's), the berthed satellite or none,
 * the satellites, her sails and the melt flag.
 * @param {{registry: object, player?: object, resourceSystem?: object, turnWaitS?: ({up: number, down: number}|null), bigMelt?: boolean}} deps
 * @returns {object}
 */
export function fateContext(deps = {}) {
  const reg = deps.registry;
  const player = deps.player || null;
  const rs = deps.resourceSystem || null;
  const here = reg && typeof reg.altitudeKm === 'function' ? reg.altitudeKm() : null;
  const fallback = reg && typeof reg.currentField === 'function' ? (reg.currentField() || {}).altKm : null;
  const fromKm = Number.isFinite(here) ? here : (Number.isFinite(fallback) ? fallback : null);
  return {
    fromKm,
    planTo: (target, opts) => (reg && typeof reg.planTo === 'function' ? reg.planTo(target, opts) : null),
    planBack: (plan, atKm, toKm, pieceMassKg) => {
      const mass = (player && Number.isFinite(player.mass) ? player.mass : NaN) - (Number.isFinite(pieceMassKg) ? pieceMassKg : 0);
      if (!plan || !(mass > 0) || !Number.isFinite(toKm)) return null;
      const fuel = reg && typeof reg._loadedGas === 'function' ? reg._loadedGas() : null;
      const args = { fromKm: atKm, toKm, massKg: mass, thrustN: realThrustN(fuel), ispS: plan.ispS, areaM2: plan.areaM2, cos: 1 };
      const key = [args.fromKm, args.toKm, args.massKg, args.thrustN, args.ispS, args.areaM2].join('|');
      let hit = _backCache.get(key);
      if (hit === undefined) {
        hit = tripProfile(args);
        if (_backCache.size >= BACK_CACHE_MAX) _backCache.delete(_backCache.keys().next().value);
        _backCache.set(key, hit);
      }
      return hit;
    },
    berth: reg && typeof reg.berthedSatellite === 'function' ? reg.berthedSatellite() : null,
    sats: reg && typeof reg.satellites === 'function' ? reg.satellites() : [],
    sailsAboard: rs && Number.isFinite(rs.dragSails) ? rs.dragSails : 0,
    bigMelt: deps.bigMelt !== undefined ? !!deps.bigMelt : Constants.isFeatureEnabled('BIG_MELT'),
    turnWaitS: deps.turnWaitS || null,
  };
}
