/**
 * WhereNextRows - the rows of the "where next" list on floor 4 (Nets step 3 slice 2b, lane 2b-2; plan decision K;
 * DECISIONS §33 rows 6 and 10; FEATURE_FLAGS.FIELDS_BY_HEIGHT).
 *
 * Pure: it reads the field registry (`fields()`, `currentField()`, `remainingCount()`, `planTo()`, `defaultNext()`) and answers
 * plain data and plain words. No DOM, no events, no game state, so the list (js/ui/WhereNextList.js), the flow manager and the
 * tests all see the same rows. Rebuilt each time the list opens or is shown again: the gas, her mass and the pieces left change.
 *
 * Slice 3 (the resupply satellite, DECISIONS §33 rows 7 and 10; Constants.RESUPPLY): when she is NOT berthed the satellites' rows
 * come first (one per satellite, the nearest by height first, a tie to the lower: slice 4 has two), then one row per field other than hers, the nearest height first (a tie goes to the lower field), then "Stay here"
 * last when her own field still has pieces:
 *   "Resupply satellite at 500 km · nets, gas, shop · 1.8 kg gas (14 %) · 16 days"   a trip she can fly (the real profile)
 *   "Resupply satellite at 500 km · needs 1.8 kg gas, 0.4 kg short"                  not enough gas for it; not selectable
 *   "Field at 400 km · 7 pieces · 0.6 kg gas (5 %) · 5 days"       a trip she can fly (the real profile: TripProfile)
 *   "Field at 425 km · cleared"                                    nothing left there; not selectable
 *   "Field at 450 km · needs 1.2 kg gas, 0.4 kg short"             not enough gas aboard for the whole trip; not selectable
 *   "Stay here · 2 pieces"                                         the next mission starts where she is
 * Berthed at the satellite there is no satellite row, no Stay and no field is hers: every field is a row, nearest by height from
 * the satellite first (the one she left included).
 * The gas percentage is of the gas aboard now; days are whole days ("under a day" below one).
 *
 * Lane 3c (the call; §33 row 7 "Stuck: call it to you for 1,000 credits"): when she is not berthed and the NEAREST satellite's row cannot be
 * picked, a row right after it offers the call (it brings that satellite: `satId`), given the wallet (`opts.credits`; without it no call row):
 *   "Call the resupply satellite to you · 1,000 credits · 16 days"       she can pay
 *   "Call the resupply satellite to you · 1,000 credits, you have 640"   she cannot yet; not selectable
 * `opts.startOwed` false (a mission is going on: no boundary asked her, the list opened because she is out of gas) means trips happen
 * between missions: a field says "finish this mission first" and cannot be picked, and the Stay row is always there (it is how she goes
 * on, even in a cleared field). A satellite CALLED to her (`berthedHere`) leaves her field hers: Stay and the fields as at any list,
 * but no satellite row and no call row.
 *
 * Pre-focus: the nearest satellite she can fly to when she has NO mother nets aboard (`opts.motherNets` 0: mission 1 used all four,
 * row 10), else the field `defaultNext()` would fly to (the nearest one with pieces she can reach), else the call (stuck: nothing she
 * can fly, the call is the way out), else Stay, else the first row she can pick. Nothing selectable at all (no reachable field, no
 * Stay, no satellite) gives `line` = NO_REACH_LINE (berthed: BERTH_NO_REACH_LINE, or ALL_CLEARED_LINE when every field is empty) and an
 * empty pick set: away from the satellite the flow manager says the line and starts the next mission where she is; berthed it says
 * the line and keeps the list open.
 *
 * @module systems/WhereNextRows
 */

import { Constants } from '../core/Constants.js';
import { FloorContract } from '../core/FloorContract.js';
import { daysWithTurnWait } from './TripProfile.js';

/** The id of the "Stay here" row (field ids are f<km>). */
export const STAY_ID = 'stay';

/** The one comms line when the choice opens (the floor's name comes from the contract, never typed here). */
export const OPEN_LINE = `Mission done. Pick where next on the ${(FloorContract.byId(4) || { name: 'map' }).name} map.`;

/** What she is told when nothing in the list can be picked. */
export const NO_REACH_LINE = 'No field you can reach with the gas aboard.';

/** Berthed with nothing she can pick (no gas for any field): the list stays open (DECISIONS §33 row 7: gas is bought there). */
export const BERTH_NO_REACH_LINE = 'Buy gas at the workbench, then pick a field.';

const FLOOR_NAME = (FloorContract.byId(4) || { name: 'map' }).name;

/** Berthed with every field empty (lane 3c, owed from the 3a review): gas is not the reason, so the list says what is true and stays open. */
export const ALL_CLEARED_LINE = 'Every field you can reach is cleared.';

/** The one comms line when she has berthed at the resupply satellite (slice 3, S5). */
export const BERTH_LINE = `Berthed at the resupply satellite. Buy nets and gas at the workbench, then pick a field on the ${FLOOR_NAME} map.`;

/** The same, when the satellite was called to her in the middle of a mission (lane 3c): there is no field to fly to, the mission goes on here. */
export const BERTH_MISSION_LINE = `Berthed at the resupply satellite. Buy nets and gas at the workbench, then pick Stay here on the ${FLOOR_NAME} map.`;

/** She is out of gas away from the satellite and can pay for the call (lane 3c, C3): said once, the list opens with the call on it. */
export const STUCK_CALL_LINE = `Out of gas. Call the resupply satellite for ${creditsText(Constants.RESUPPLY.CALL_CREDITS)} credits on the ${FLOOR_NAME} map.`;

/** The id and `kind` of the call row (the flow manager picks by id; the list paints any row). */
export const CALL_ID = 'call';
export const CALL_KIND = 'call';

/** The `kind` of a satellite row (the list paints any row; the flow manager picks by id). */
export const SATELLITE_ROW_KIND = 'satellite';

const DOT = '\u00b7';

/** @param {number} n @returns {string} whole credits with thousands commas, "1,000" (no locale: the words are the same everywhere) */
export function creditsText(n) {
  const v = Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** @param {number} n @returns {string} "7 pieces", "1 piece" */
export function piecesText(n) { return `${n} ${n === 1 ? 'piece' : 'pieces'}`; }

/** @param {number} days @returns {string} whole days; "under a day" below one */
export function daysText(days) {
  if (!(days >= 1)) return 'under a day';
  const d = Math.round(days);
  return `${d} ${d === 1 ? 'day' : 'days'}`;
}

/** @param {number} kg @returns {string} one decimal ("0.6"), two below 0.1 ("0.05") */
export function kgText(kg) {
  const v = Math.max(0, Number.isFinite(kg) ? kg : 0);
  return v < 0.095 ? v.toFixed(2) : v.toFixed(1);
}

/** @param {number} gasKg @param {number} aboardKg @returns {string} the share of the gas aboard, "5 %" ("<1 %" below one) */
export function pctText(gasKg, aboardKg) {
  if (!(aboardKg > 0)) return '0 %';
  const p = gasKg / aboardKg * 100;
  return p > 0 && p < 1 ? '<1 %' : `${Math.round(p)} %`;
}

/**
 * @typedef {object} WhereNextRow
 * @property {string} id          field id ('f400'), a satellite id ('sat500'), STAY_ID or CALL_ID
 * @property {'field'|'stay'|'satellite'|'call'} kind
 * @property {number} altKm       the field's height (Stay and the call: her own field's; the satellite's)
 * @property {number} pieces      pieces left in that field (0 for the satellite and the call)
 * @property {'ok'|'cleared'|'short'|'cannot'|'stay'|'mission'|'poor'} state   'mission': a mission is going on, trips wait for its end; 'poor': the call, short of credits
 * @property {boolean} selectable
 * @property {string} text        the row's words
 * @property {number} [gasKg]     the whole trip's gas (a trip she can fly, or one she is short for)
 * @property {number} [gasPct]    gas / gas aboard, percent
 * @property {number} [days]      the profile's days (the call: the satellite's days, the estimate when the profile cannot be read)
 * @property {number} [shortKg]   profile gas minus gas aboard (state 'short')
 * @property {number} [credits]   the call's price
 * @property {string} [satId]     the call: the satellite that would come
 */

/**
 * @param {object} reg a FieldRegistry (or anything with its read face)
 * @param {{motherNets?: number, credits?: number, gasCredits?: number, startOwed?: boolean, turnWaitS?: {up: number, down: number}}} [opts] `motherNets`: the mother's nets aboard now (an unknown
 *   count never pre-focuses the satellite); `credits`: her wallet (no number = no call row); `gasCredits`: one gas buy's price (the call needs it on top of its own price); `startOwed` false = a mission is going on (a
 *   field cannot be picked: "finish this mission first"; Stay is always there), default true
 * @returns {{rows: WhereNextRow[], focusId: (string|null), selectable: string[], line: (string|null)}}
 */
export function buildWhereNextRows(reg, opts = {}) {
  const berth = typeof reg.berthedSatellite === 'function' ? reg.berthedSatellite() : null;
  const called = !!(berth && typeof reg.berthedHere === 'function' && reg.berthedHere());       // the satellite came to her: her field is hers
  const atSat = !!berth && !called;                                                              // she flew there: no field is hers
  const owed = !(opts && opts.startOwed === false);
  const credits = opts && Number.isFinite(opts.credits) ? opts.credits : null;
  const gasCredits = opts && Number.isFinite(opts.gasCredits) && opts.gasCredits > 0 ? opts.gasCredits : 0;
  const turn = opts && opts.turnWaitS && typeof opts.turnWaitS === 'object' ? opts.turnWaitS : null;
  const here = reg.currentField();
  const fromKm = atSat ? berth.altKm : here.altKm;
  const others = reg.fields()
    .filter((f) => atSat || f.id !== here.id)                  // flown to the satellite: no field is hers
    .sort((a, b) => Math.abs(a.altKm - fromKm) - Math.abs(b.altKm - fromKm) || a.altKm - b.altKm);
  /** @type {WhereNextRow[]} */
  const rows = [];
  if (typeof reg.satellites === 'function') {
    // N satellites (slice 4): nearest by height from her field first, a tie to the lower one (as the fields are listed). The call
    // summons the NEAREST one: it comes right after that satellite's row, when she cannot fly there (out of gas, or a mission is going on).
    // Berthed at one (fix round 1, F4) the OTHER satellites are still destinations (nearest from where she is); no call then (she is berthed).
    const sats = reg.satellites().filter((s) => !berth || s.id !== berth.id)
      .sort((a, b) => Math.abs(a.altKm - fromKm) - Math.abs(b.altKm - fromKm) || a.altKm - b.altKm);
    for (let i = 0; i < sats.length; i++) {
      const row = satelliteRow(reg, sats[i], owed, turn);
      rows.push(row);
      if (!berth && i === 0 && credits !== null && !row.selectable) rows.push(callRow(sats[i], row, here, credits, gasCredits));
    }
  }
  for (const f of others) {
    const n = reg.remainingCount(f.id);
    const head = `Field at ${Math.round(f.altKm)} km`;
    if (n === 0) {
      rows.push({ id: f.id, kind: 'field', altKm: f.altKm, pieces: 0, state: 'cleared', selectable: false, text: `${head} ${DOT} cleared` });
      continue;
    }
    if (!owed) {
      rows.push({ id: f.id, kind: 'field', altKm: f.altKm, pieces: n, state: 'mission', selectable: false, text: `${head} ${DOT} ${MISSION_FIRST}` });
      continue;
    }
    const plan = reg.planTo(f);
    if (!plan || !plan.profile || !plan.profile.ok) {
      rows.push({ id: f.id, kind: 'field', altKm: f.altKm, pieces: n, state: 'cannot', selectable: false, text: `${head} ${DOT} the thruster cannot take her there` });
      continue;
    }
    const gasKg = plan.profile.gasKg;
    const days = tripDays(plan.profile, turn);
    if (!plan.enough) {
      const shortKg = gasKg - plan.gasAboardKg;
      rows.push({
        id: f.id, kind: 'field', altKm: f.altKm, pieces: n, state: 'short', selectable: false, gasKg, shortKg, days,
        text: `${head} ${DOT} needs ${kgText(gasKg)} kg gas, ${kgText(shortKg)} kg short`,
      });
      continue;
    }
    const gasPct = plan.gasAboardKg > 0 ? gasKg / plan.gasAboardKg * 100 : 0;
    rows.push({
      id: f.id, kind: 'field', altKm: f.altKm, pieces: n, state: 'ok', selectable: true, gasKg, gasPct, days,
      text: `${head} ${DOT} ${piecesText(n)} ${DOT} ${kgText(gasKg)} kg gas (${pctText(gasKg, plan.gasAboardKg)}) ${DOT} ${daysText(days)}`,
    });
  }
  const hereN = reg.remainingCount(here.id);
  // Stay: she goes on where she is. With a mission going on it is the only way on (a cleared field included: background pieces remain),
  // so it is always there then; flown to the satellite there is none (no field is hers).
  if (!atSat && (hereN > 0 || !owed)) {
    rows.push({
      id: STAY_ID, kind: 'stay', altKm: here.altKm, pieces: hereN, state: 'stay', selectable: true,
      text: hereN > 0 ? `Stay here ${DOT} ${piecesText(hereN)}` : `Stay here ${DOT} field cleared`,
    });
  }
  const selectable = rows.filter((r) => r.selectable).map((r) => r.id);
  const next = reg.defaultNext();
  const satRow = rows.find((r) => r.kind === SATELLITE_ROW_KIND && r.selectable);    // (rows are nearest first: the nearest one she can fly to)
  const callSel = rows.find((r) => r.kind === CALL_KIND && r.selectable);
  const noNets = Number.isFinite(opts && opts.motherNets) && opts.motherNets <= 0;     // mission 1 used all four (row 10)
  const flyable = next && selectable.includes(next.id);
  let focusId = null;
  if (satRow && noNets && !berth) focusId = satRow.id;                                // berthed (fix round 2, G1): never pre-select the OTHER satellite: she is at the shop already
  else if (flyable) focusId = next.id;
  else if (callSel) focusId = callSel.id;                                              // stuck: nothing she can fly, the call is the way out
  else if (selectable.includes(STAY_ID)) focusId = STAY_ID;
  else if (selectable.length) focusId = selectable[0];
  const anyPieces = rows.some((r) => r.kind === 'field' && r.pieces > 0);
  // Berthed with every field cleared she is told so even when the other satellite can be flown to (slice 4 integration): that row is a
  // hop to the shop, not a field, and the list stays open either way.
  const onlySatellites = selectable.every((id) => { const r = rows.find((x) => x.id === id); return !!r && r.kind === SATELLITE_ROW_KIND; });
  const line = selectable.length
    ? (berth && !anyPieces && onlySatellites ? ALL_CLEARED_LINE : null)
    : (berth ? (anyPieces ? BERTH_NO_REACH_LINE : ALL_CLEARED_LINE) : NO_REACH_LINE);
  return { rows, focusId, selectable, line };
}

/**
 * @private The days a trip shows: the profile's, plus the wait for her nose the trip will fly before the push counts (slice 4, S2: the caller
 * gives the seconds for a climb and a descent from her attitude now; none given = the profile's days, as before).
 * @param {{days: number, dir: number}} profile @param {{up: number, down: number}|null} turn
 */
function tripDays(profile, turn) {
  if (!turn) return profile.days;
  const w = profile.dir > 0 ? turn.up : (profile.dir < 0 ? turn.down : 0);
  return daysWithTurnWait(profile.days, Number.isFinite(w) ? w : 0);
}

/** @private "Field at 400 km . finish this mission first": a mission is going on, so trips wait for its end. */
const MISSION_FIRST = 'finish this mission first';

/**
 * @private The row of a satellite she can fly to: where, what it is for, then the real trip's gas, share of the gas aboard and days
 * (as a field row says them), or what she is short. A mission going on (`owed` false) keeps trips for later, after the gas is told.
 * @param {object} reg @param {{id: string, altKm: number, name?: string}} s @param {boolean} owed a mission start is owed (a boundary asked her)
 * @param {{up: number, down: number}|null} turn the real seconds her push waits for her nose, up and down (null = not known)
 * @returns {WhereNextRow}
 */
function satelliteRow(reg, s, owed, turn) {
  const head = `${s.name || 'Resupply satellite'} at ${Math.round(s.altKm)} km`;
  const base = /** @type {any} */ ({ id: s.id, kind: SATELLITE_ROW_KIND, altKm: s.altKm, pieces: 0 });
  const plan = reg.planTo(s);
  if (!plan || !plan.profile || !plan.profile.ok) {
    return { ...base, state: 'cannot', selectable: false, text: `${head} ${DOT} the thruster cannot take her there` };
  }
  const gasKg = plan.profile.gasKg;
  const days = tripDays(plan.profile, turn);
  base.plainDays = plan.profile.days;                       // the trip without her turn: a called satellite comes to her, she does not turn (F1)
  if (!plan.enough) {
    const shortKg = gasKg - plan.gasAboardKg;
    return { ...base, state: 'short', selectable: false, gasKg, shortKg, days, text: `${head} ${DOT} needs ${kgText(gasKg)} kg gas, ${kgText(shortKg)} kg short` };
  }
  const gasPct = plan.gasAboardKg > 0 ? gasKg / plan.gasAboardKg * 100 : 0;
  if (!owed) {
    return { ...base, state: 'mission', selectable: false, gasKg, gasPct, days, text: `${head} ${DOT} ${MISSION_FIRST}` };
  }
  return {
    ...base, state: 'ok', selectable: true, gasKg, gasPct, days,
    text: `${head} ${DOT} nets, gas, shop ${DOT} ${kgText(gasKg)} kg gas (${pctText(gasKg, plan.gasAboardKg)}) ${DOT} ${daysText(days)}`,
  };
}

/**
 * @private The call row (lane 3c): the satellite comes to her for `RESUPPLY.CALL_CREDITS`. Its days are the satellite's PLAIN trip days from where she
 * is (the real profile's, even when she lacks the gas for it herself; no turn wait: the satellite comes to her, she does not turn, fix round 1 F1), `RESUPPLY.CALL_DAYS_EST` when that profile cannot be read.
 * Review fix F1: she can call only if she can pay the call AND one gas buy (`gasCredits`, the gas price now): else she would arrive with
 * the call paid and under the gas price, and the berth's stop rule (credits + cargo below the gas price) would end the run 15 s later.
 * @param {{id: string}} s the satellite @param {WhereNextRow} satRow its (unpickable) row @param {object} here her field @param {number} credits her wallet
 * @param {number} gasCredits one gas buy's price (0 = not asked)
 * @returns {WhereNextRow}
 */
function callRow(s, satRow, here, credits, gasCredits) {
  const price = Constants.RESUPPLY.CALL_CREDITS;
  const days = Number.isFinite(satRow.plainDays) && satRow.plainDays > 0 ? satRow.plainDays : Constants.RESUPPLY.CALL_DAYS_EST;
  const base = { id: CALL_ID, kind: CALL_KIND, altKm: here.altKm, pieces: 0, days, credits: price, satId: s.id };
  const head = `Call the resupply satellite to you ${DOT} ${creditsText(price)} credits`;
  if (credits >= price + gasCredits) return { ...base, state: 'ok', selectable: true, text: `${head} ${DOT} ${daysText(days)}` };
  return { ...base, state: 'poor', selectable: false, text: `${head}${gasCredits > 0 ? ' + gas' : ''}, you have ${creditsText(credits)}` };
}
