/**
 * WhereNextRows - the rows of the "where next" list on floor 4 (DECISIONS §33 rows 6 and 10; FEATURE_FLAGS.FIELDS_BY_HEIGHT).
 *
 * Pure: reads the field registry (`fields()`, `currentField()`, `remainingCount()`, `planTo()`, `defaultNext()`) and answers
 * plain data and plain words; no DOM, events or game state, so the list (js/ui/WhereNextList.js), the flow manager and the
 * tests see the same rows. Rebuilt each time the list opens or is shown again (gas, her mass and the pieces left change).
 *
 * Order (DECISIONS §33 rows 7 and 10; Constants.RESUPPLY): when she is NOT berthed the satellites' rows come first (nearest by
 * height first, a tie to the lower), then one row per field other than hers (same order), then "Stay here" last when her own
 * field still has pieces. Gas % is of the gas aboard now; days are whole ("under a day" below one). A trip she cannot afford
 * reads "needs 1.2 kg gas, 0.4 kg short" and is not selectable.
 * Berthed at the satellite there is no satellite row, no Stay and no field is hers: every field is a row, nearest by height
 * from the satellite first (the one she left included).
 *
 * The call (§33 row 7 "Stuck: call it to you for 1,000 credits"): when she is not berthed and the NEAREST satellite's row cannot
 * be picked, a row right after it offers the call (it brings that satellite: `satId`), given the wallet (`opts.credits`; none = no call row):
 * `opts.startOwed` false (a mission is going on: the list opened because she is out of gas) means trips happen between
 * missions: a field says "finish this mission first" and cannot be picked, and Stay is always there (it is how she goes on,
 * even in a cleared field). A satellite CALLED to her (`berthedHere`) leaves her field hers: Stay and the fields as at any
 * list, but no satellite row and no call row.
 *
 * Pre-focus: the nearest satellite she can fly to when she has NO mother nets aboard (`opts.motherNets` 0: mission 1 used all four,
 * row 10), else the field `defaultNext()` would fly to (the nearest one with pieces she can reach), else the call (stuck: the way
 * out), else Stay, else the first row she can pick. Nothing selectable at all gives `line` = NO_REACH_LINE (berthed:
 * BERTH_NO_REACH_LINE, or ALL_CLEARED_LINE when every field is empty) and an empty pick set: away from the satellite the flow
 * manager says the line and starts the next mission where she is; berthed it says the line and keeps the list open.
 *
 * Big pieces (DECISIONS §33 row 16-17): `opts.bigPieces` (`pendingAboard()`'s `[{debris, holder, fate}]`) adds, FIRST and
 * pre-focused, one row per held big piece marked "push" (kind `push`, id `push:<debrisId>`):
 * Every satellite row she can fly to also says "hands over the SL-14 stage, pays 20,920" for the pieces marked "satellite" (summed).
 * @module systems/WhereNextRows
 */

import { Constants } from '../core/Constants.js';
import { FloorContract } from '../core/FloorContract.js';
import { daysWithTurnWait } from './TripProfile.js';
import { pieceName } from './BigPieces.js';
import { fatePay } from './BigPieceValues.js';
import { pushTargetKm, lifetimeYears, dragAreaM2 } from './OrbitLifetime.js';
import { jobLine } from './JobsBoard.js';

export const STAY_ID = 'stay';

// The floor's name comes from the contract, never typed here.
export const OPEN_LINE = `Mission done. Pick where next on the ${(FloorContract.byId(4) || { name: 'map' }).name} map.`;

export const NO_REACH_LINE = 'No field you can reach with the gas aboard.';

/** Berthed with nothing she can pick (no gas for any field): the list stays open (DECISIONS §33 row 7: gas is bought there). */
export const BERTH_NO_REACH_LINE = 'Buy gas at the workbench, then pick a field.';

const FLOOR_NAME = (FloorContract.byId(4) || { name: 'map' }).name;

/** Berthed with every field empty: gas is not the reason, so the list says what is true and stays open. */
export const ALL_CLEARED_LINE = 'Every field you can reach is cleared.';

export const BERTH_LINE = `Berthed at the resupply satellite. Buy nets and gas at the workbench, then pick a field on the ${FLOOR_NAME} map.`;

/** The same, when the satellite was called mid-mission: the mission goes on here. */
export const BERTH_MISSION_LINE = `Berthed at the resupply satellite. Buy nets and gas at the workbench, then pick Stay here on the ${FLOOR_NAME} map.`;

/** Said once when she is out of gas away from the satellite and can pay for the call. */
export const STUCK_CALL_LINE = `Out of gas. Call the resupply satellite for ${creditsText(Constants.RESUPPLY.CALL_CREDITS)} credits on the ${FLOOR_NAME} map.`;

export const CALL_ID = 'call';
export const CALL_KIND = 'call';

export const SATELLITE_ROW_KIND = 'satellite';

export const PUSH_KIND = 'push';
export const PUSH_PREFIX = 'push:';

const DOT = '\u00b7';

export function creditsText(n) {
  const v = Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function piecesText(n) { return `${n} ${n === 1 ? 'piece' : 'pieces'}`; }

export function daysText(days) {
  if (!(days >= 1)) return 'under a day';
  const d = Math.round(days);
  return `${d} ${d === 1 ? 'day' : 'days'}`;
}

export function kgText(kg) {
  const v = Math.max(0, Number.isFinite(kg) ? kg : 0);
  return v < 0.095 ? v.toFixed(2) : v.toFixed(1);
}

export function pctText(gasKg, aboardKg) {
  if (!(aboardKg > 0)) return '0 %';
  const p = gasKg / aboardKg * 100;
  return p > 0 && p < 1 ? '<1 %' : `${Math.round(p)} %`;
}

/**
 * @typedef {object} WhereNextRow
 * @property {'field'|'stay'|'satellite'|'call'|'push'} kind
 * @property {number} altKm       the field's height (Stay and the call: her own field's; the satellite's)
 * @property {'ok'|'cleared'|'short'|'cannot'|'stay'|'mission'|'poor'|'here'} state   'mission': a mission is going on, trips wait
 *   for its end; 'poor': the call, short of credits; 'here': a push row with no trip (she is at or below the piece's 25-year height)
 * @property {string} [shortText] the panel's one short line for a trip she can fly; drawn in place of `text` when there
 * @property {number} [days]      the profile's days (the call: the satellite's days, the estimate when the profile cannot be read)
 * @property {number} [shortKg]   profile gas minus gas aboard (state 'short')
 * @property {number} [credits]   the call's price
 * @property {string} [satId]     the call: the satellite that would come
 * @property {number|string} [debrisId]  a push row: the piece it lets go
 * @property {number} [targetKm]   a push row: the height it lets go at
 * @property {number} [payCr]      a push row: what the removal fee pays
 */

/**
 * `opts`: `bigPieces` the held big pieces (`pendingAboard()`: their push rows and the satellite rows' hand-over words);
 * `motherNets` the mother's nets aboard now (an unknown count never pre-focuses the satellite); `credits` her wallet (no number
 * = no call row); `gasCredits` one gas buy's price (the call needs it on top of its own price); `startOwed` false = a mission is
 * going on (a field cannot be picked: "finish this mission first"; Stay is always there), default true; `turnWaitS` {up, down}.
 * `job` the posted job to show (js/systems/JobsBoard.js; none = no board line): the result's `job` is its line, and the posting's
 * field row ends " \u00b7 Wanted".
 * @returns {{rows: WhereNextRow[], focusId: (string|null), selectable: string[], line: (string|null), job: ({text: string, fieldId: string, done: boolean, missed: boolean}|null)}}
 */
export function buildWhereNextRows(reg, opts = {}) {
  const berth = typeof reg.berthedSatellite === 'function' ? reg.berthedSatellite() : null;
  const called = !!(berth && typeof reg.berthedHere === 'function' && reg.berthedHere()); // called to her: her field is hers
  const atSat = !!berth && !called; // she flew there: no field is hers
  const owed = !(opts && opts.startOwed === false);
  const credits = opts && Number.isFinite(opts.credits) ? opts.credits : null;
  const gasCredits = opts && Number.isFinite(opts.gasCredits) && opts.gasCredits > 0 ? opts.gasCredits : 0;
  const turn = opts && opts.turnWaitS && typeof opts.turnWaitS === 'object' ? opts.turnWaitS : null;
  const here = reg.currentField();
  const fromKm = atSat ? berth.altKm : here.altKm;
  const others = reg.fields()
    .filter((f) => atSat || f.id !== here.id)
    .sort((a, b) => Math.abs(a.altKm - fromKm) - Math.abs(b.altKm - fromKm) || a.altKm - b.altKm);
  /** @type {WhereNextRow[]} */
  const rows = [];
  // the held big pieces marked "push" come first; the ones marked "satellite" add their words to the satellite rows
  const held = opts && Array.isArray(opts.bigPieces) ? opts.bigPieces.filter((e) => e && e.debris) : [];
  const herKm = typeof reg.altitudeKm === 'function' && Number.isFinite(reg.altitudeKm()) ? reg.altitudeKm() : fromKm;
  for (const e of held) if (e.fate === 'push') { const r = pushRow(reg, e.debris, owed, turn, herKm); if (r) rows.push(r); }
  const handPieces = held.filter((e) => e.fate === 'satellite').map((e) => e.debris);
  const handOver = handOverWords(handPieces);
  const handOverShort = handPieces.length ? `pays ${creditsText(handPieces.reduce((sum, d) => sum + fatePay(d, 'satellite').totalCr, 0))}` : '';
  if (typeof reg.satellites === 'function') {
    // Order as the fields. The call summons the NEAREST satellite and sits right after its row when she cannot fly there. Berthed
    // at one, the OTHER satellites are still destinations (nearest from where she is); no call then.
    const sats = reg.satellites().filter((s) => !berth || s.id !== berth.id)
      .sort((a, b) => Math.abs(a.altKm - fromKm) - Math.abs(b.altKm - fromKm) || a.altKm - b.altKm);
    for (let i = 0; i < sats.length; i++) {
      const row = satelliteRow(reg, sats[i], owed, turn);
      if (handOver && row.state === 'ok') { row.text += ` ${DOT} ${handOver}`; row.shortText += ` ${DOT} ${handOverShort}`; }
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
      shortText: `${Math.round(f.altKm)} km ${DOT} ${piecesText(n)} ${DOT} ${kgText(gasKg)} kg gas ${DOT} ${daysText(days)}`,
    });
  }
  const hereN = reg.remainingCount(here.id);
  // Stay: she goes on where she is. With a mission going on it is the only way on (a cleared field included: background pieces remain),
  // so it is always there then; flown to the satellite there is none.
  if (!atSat && (hereN > 0 || !owed)) {
    rows.push({
      id: STAY_ID, kind: 'stay', altKm: here.altKm, pieces: hereN, state: 'stay', selectable: true,
      text: hereN > 0 ? `Stay here ${DOT} ${piecesText(hereN)}` : `Stay here ${DOT} field cleared`,
    });
  }
  const selectable = rows.filter((r) => r.selectable).map((r) => r.id);
  const next = reg.defaultNext();
  const satRow = rows.find((r) => r.kind === SATELLITE_ROW_KIND && r.selectable);
  const callSel = rows.find((r) => r.kind === CALL_KIND && r.selectable);
  const noNets = Number.isFinite(opts && opts.motherNets) && opts.motherNets <= 0;     // mission 1 used all four (row 10)
  const flyable = next && selectable.includes(next.id);
  const pushSel = rows.find((r) => r.kind === PUSH_KIND && r.selectable);  // a piece marked for the push comes first
  let focusId = null;
  if (pushSel) focusId = pushSel.id;
  else if (satRow && noNets && !berth) focusId = satRow.id;  // berthed: never pre-select the OTHER satellite (she is at the shop already)
  else if (flyable) focusId = next.id;
  else if (callSel) focusId = callSel.id;
  else if (selectable.includes(STAY_ID)) focusId = STAY_ID;
  else if (selectable.length) focusId = selectable[0];
  const anyPieces = rows.some((r) => r.kind === 'field' && r.pieces > 0);
  // Berthed with every field cleared she is told so even when the other satellite can be flown to: that row is a hop to the shop, not a
  // field, and the list stays open either way.
  const onlySatellites = selectable.every((id) => { const r = rows.find((x) => x.id === id); return !!r && r.kind === SATELLITE_ROW_KIND; });
  const line = selectable.length
    ? (berth && !anyPieces && onlySatellites ? ALL_CLEARED_LINE : null)
    : (berth ? (anyPieces ? BERTH_NO_REACH_LINE : ALL_CLEARED_LINE) : NO_REACH_LINE);
  return { rows, focusId, selectable, line, job: jobOf(rows, opts && opts.job) };
}

/**
 * @private The jobs board's line for the list, and the " \u00b7 Wanted" tag on the posting's field row while it is open. The posting's field has
 * no row when it is the field she is at (the line then says "Wanted here"). Null with nothing to show.
 */
function jobOf(rows, posting) {
  if (!posting || !posting.posted) return null;
  const closed = !!(posting.done || posting.missed);
  const row = closed ? null : rows.find((r) => r.kind === 'field' && r.id === posting.fieldId) || null;
  const text = jobLine(posting, row, { kgText, daysText });
  if (!closed && row && row.state !== 'cleared') {
    row.text += ` ${DOT} Wanted`;
    if (row.shortText) row.shortText += ` ${DOT} Wanted`;
  }
  return text ? { text, fieldId: posting.fieldId, done: !!posting.done, missed: !!posting.missed } : null;
}

/** The panel draws at most this many destination rows (fields, satellites, the call and push-down rows; not "Stay here"). */
export const TOP_N = 5;

const moreFields = (n) => `${n} more ${n === 1 ? 'field' : 'fields'}`;

/**
 * What the "where next" panel draws (owner 2026-10-25: a wall of text; "just the top five with the best guess highlighted"). Pure, over a
 * `buildWhereNextRows` result, which still holds every row (the height scale and the picks read the full data). `rows` are the rows to draw, in order.
 *   - `bestId`: the pick the game pre-selects (`model.focusId`), when it is a destination (not Stay): row 1, with the "BEST" tag.
 *   - the rest: rows she can pick now, cheapest gas first, a tie by fewer days (the call, which costs credits not gas, after the gas ones).
 *     At most TOP_N destinations in all. Rows she cannot pick (cleared, short of gas, a mission going on) are not drawn.
 *   - `focusId` on a reachable row outside the five: drawn as one extra line while it has the focus (a chip tap on the map).
 *   - the field of an open job (`model.job`, not done, not missed) she can pick is always drawn: one extra line after the five when it is not among them.
 *   - Stay is its own line at the bottom, outside the five.
 *   - the call, when she can pick it, is always among the five (it has no chip on the height scale).
 *   - `outLines`: at most two short lines saying why rows are not drawn ("3 more fields out of reach: need more gas"); none when there
 *     is nothing to say, and none when the model already carries its own line (nothing can be picked).
 * @param {{rows: WhereNextRow[], focusId: (string|null), line?: (string|null)}} model @param {string|null} [focusId] the focus now
 * @returns {{rows: WhereNextRow[], topIds: string[], bestId: (string|null), outLines: string[]}}
 */
export function whereNextView(model, focusId = null) {
  const all = model && Array.isArray(model.rows) ? model.rows : [];
  const reach = all.filter((r) => r.kind !== 'stay' && r.selectable);
  const best = reach.find((r) => r.id === model.focusId) || null;
  const gas = (r) => (r.kind === CALL_KIND ? Infinity : (Number.isFinite(r.gasKg) ? r.gasKg : 0));
  const days = (r) => (Number.isFinite(r.days) ? r.days : Infinity);
  const rest = reach.map((r, i) => ({ r, i })).filter((x) => x.r !== best)
    .sort((a, b) => (gas(a.r) - gas(b.r) || days(a.r) - days(b.r) || a.i - b.i) || 0)
    .map((x) => x.r);
  const top = (best ? [best, ...rest] : rest).slice(0, TOP_N);
  // the call costs credits, not gas, so it sorts last; it has no chip on the height scale, so when she can pick it it is always
  // drawn: it takes the last of the five when the five are full
  const callRow = reach.find((r) => r.kind === CALL_KIND);
  if (callRow && !top.includes(callRow)) { if (top.length >= TOP_N) top[TOP_N - 1] = callRow; else top.push(callRow); }
  const drawn = top.slice();
  // an open job's field is always on the list (the Wanted line tells her to go there): one extra row after the five when it is not among them
  const job = model && model.job;
  const jobRow = job && job.fieldId && !job.done && !job.missed ? reach.find((r) => r.kind === 'field' && r.id === job.fieldId) : null;
  if (jobRow && !top.includes(jobRow)) drawn.push(jobRow);
  const extra = focusId != null && !drawn.some((r) => r.id === focusId) ? reach.find((r) => r.id === focusId) : null;
  if (extra) drawn.push(extra);
  const stay = all.find((r) => r.kind === 'stay');
  if (stay) drawn.push(stay);
  const outLines = model && model.line ? [] : outOfReachLines(all);
  return { rows: drawn, topIds: top.map((r) => r.id), bestId: best ? best.id : null, outLines };
}

/** @private "3 more fields and 1 resupply satellite" for the rows in these states, by kind; '' when none. */
function countWords(all, states) {
  const n = (kind) => all.filter((r) => r.kind === kind && states.includes(r.state)).length;
  const f = n('field'); const s = n(SATELLITE_ROW_KIND); const p = n(PUSH_KIND);
  const parts = [];
  if (f) parts.push(moreFields(f));
  if (s) parts.push(`${s} resupply ${s === 1 ? 'satellite' : 'satellites'}`);
  if (p) parts.push(`${p} ${p === 1 ? 'push-down' : 'push-downs'}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] || '');
}

/**
 * @private The short lines that say why rows are not drawn (at most two): line 1 the gas and the engine ("3 more fields out of reach: need
 * more gas; 1 more field too far for the engine"), line 2 a mission still going and a call she cannot pay for ("2 more fields: finish this
 * mission first; calling the satellite needs more credits"). Cleared fields are not counted.
 */
function outOfReachLines(all) {
  const gas = countWords(all, ['short']);
  const engine = countWords(all, ['cannot']);
  const wait = countWords(all, ['mission']);
  const poor = all.some((r) => r.kind === CALL_KIND && r.state === 'poor');
  const one = [gas && `${gas} out of reach: need more gas`, engine && `${engine} too far for the engine`].filter(Boolean).join('; ');
  const two = [wait && `${wait}: finish this mission first`, poor && 'calling the satellite needs more credits'].filter(Boolean).join('; ');
  return [one, two].filter(Boolean);
}

/**
 * @private The days a trip shows: the profile's, plus the wait for her nose the trip will fly before the push counts (`turn`: the
 * caller's seconds for a climb and a descent from her attitude now; none = the profile's days).
 */
function tripDays(profile, turn) {
  if (!turn) return profile.days;
  const w = profile.dir > 0 ? turn.up : (profile.dir < 0 ? turn.down : 0);
  return daysWithTurnWait(profile.days, Number.isFinite(w) ? w : 0);
}

const MISSION_FIRST = 'finish this mission first';

/**
 * @private The row of a satellite she can fly to: where, what it is for, then the real trip's gas, share of the gas aboard and days
 * (as a field row says them), or what she is short. A mission going on (`owed` false) keeps trips for later, after the gas is told.
 * `turn`: the real seconds her push waits for her nose, up and down (null = not known).
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
  base.plainDays = plan.profile.days;  // the trip without her turn: a called satellite comes to her
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
    shortText: `${s.name || 'Resupply satellite'} ${Math.round(s.altKm)} km ${DOT} ${kgText(gasKg)} kg gas ${DOT} ${daysText(days)}`,
  };
}

/**
 * @private The call row: the satellite comes to her for `RESUPPLY.CALL_CREDITS`. Its days are the satellite's PLAIN trip days from where she
 * is (the real profile's, even when she lacks the gas herself; no turn wait: the satellite comes to her, she does not turn),
 * `RESUPPLY.CALL_DAYS_EST` when that profile cannot be read. She can call only if she can pay the call AND one gas buy (`gasCredits`,
 * the gas price now): else she would arrive with the call paid and under the gas price, and the berth's stop rule (credits + cargo
 * below the gas price) would end the run 15 s later.
 */
function callRow(s, satRow, here, credits, gasCredits) {
  const price = Constants.RESUPPLY.CALL_CREDITS;
  const days = Number.isFinite(satRow.plainDays) && satRow.plainDays > 0 ? satRow.plainDays : Constants.RESUPPLY.CALL_DAYS_EST;
  const base = { id: CALL_ID, kind: CALL_KIND, altKm: here.altKm, pieces: 0, days, credits: price, satId: s.id };
  const head = `Call the resupply satellite to you ${DOT} ${creditsText(price)} credits`;
  if (credits >= price + gasCredits) return { ...base, state: 'ok', selectable: true, text: `${head} ${DOT} ${daysText(days)}`, shortText: `Call the satellite ${DOT} ${creditsText(price)} credits ${DOT} ${daysText(days)}` };
  return { ...base, state: 'poor', selectable: false, text: `${head}${gasCredits > 0 ? ' + gas' : ''}, you have ${creditsText(credits)}` };
}

/**
 * @private The row of a held big piece marked "push": go down to its 25-year height, let it go there. Selectable only when her gas
 * covers the push AND the climb back to where she is now (flown without the piece: its mass is gone by then). A piece she is already
 * at or below the height of needs no trip: "let it go here" (the same pick, no burn). Null when no height can be worked out.
 */
function pushRow(reg, d, owed, turn, herKm) {
  const target = pushTargetKm(d);
  if (!Number.isFinite(target) || !Number.isFinite(herKm)) return null;
  const name = pieceName(d);
  const pay = fatePay(d, 'push');
  const payText = pay.totalCr > 0 ? `pays ${creditsText(pay.totalCr)}` : 'pays nothing';
  const base = /** @type {any} */ ({ id: `${PUSH_PREFIX}${d.id}`, kind: PUSH_KIND, altKm: target, pieces: 0, debrisId: d.id, targetKm: target, payCr: pay.totalCr });
  const head = `Push the ${name} down to ${Math.round(target)} km and let go`;
  if (!owed) return { ...base, state: 'mission', selectable: false, text: `${head} ${DOT} ${MISSION_FIRST}` };
  if (herKm <= target + 0.5) {
    const years = lifetimeYears(herKm, d.mass, dragAreaM2(d));
    const when = Number.isFinite(years) ? `it comes down in about ${Math.max(1, Math.round(years))} ${Math.max(1, Math.round(years)) === 1 ? 'year' : 'years'}` : 'it stays up';
    return {
      ...base, state: 'here', altKm: herKm, targetKm: herKm, selectable: true, text: `Let the ${name} go here at ${Math.round(herKm)} km: ${when} ${DOT} ${payText}`,
      shortText: `Let ${name} go here ${DOT} ${when.replace('it comes down in about', 'down in about')} ${DOT} ${payText}`,
    };
  }
  const down = reg.planTo({ id: 'free', altKm: target });
  if (!down || !down.profile || !down.profile.ok) return { ...base, state: 'cannot', selectable: false, text: `${head} ${DOT} the thruster cannot take her there` };
  const back = reg.planTo({ id: 'free-back', altKm: herKm }, { fromKm: target, lessKg: d.mass || 0 });
  if (!back || !back.profile || !back.profile.ok) return { ...base, state: 'cannot', selectable: false, text: `${head} ${DOT} the thruster cannot bring her back up` };
  const gasKg = down.profile.gasKg;
  const days = tripDays(down.profile, turn);
  const needKg = gasKg + back.profile.gasKg;
  if (needKg > down.gasAboardKg + 1e-9) {
    const shortKg = needKg - down.gasAboardKg;
    return { ...base, state: 'short', selectable: false, gasKg, shortKg, days, text: `${head} ${DOT} needs ${kgText(needKg)} kg gas, ${kgText(shortKg)} kg short` };
  }
  const gasPct = down.gasAboardKg > 0 ? gasKg / down.gasAboardKg * 100 : 0;
  return {
    ...base, state: 'ok', selectable: true, gasKg, gasPct, days, backGasKg: back.profile.gasKg,
    text: `${head} ${DOT} ${kgText(gasKg)} kg gas (${pctText(gasKg, down.gasAboardKg)}) ${DOT} ${daysText(days)} ${DOT} ${payText}`,
    shortText: `Push ${name} to ${Math.round(target)} km ${DOT} ${kgText(gasKg)} kg gas ${DOT} ${daysText(days)} ${DOT} ${payText}`,
  };
}

/**
 * @private What a satellite row adds for the held pieces marked "satellite": "hands over the SL-14 stage, pays 20,920"
 * (several: "hands over the SL-14 stage and the Cosmos 1175 satellite, pays 25,520"). '' with none.
 */
function handOverWords(pieces) {
  if (!pieces.length) return '';
  const names = pieces.map((d) => `the ${pieceName(d)}`);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const total = pieces.reduce((sum, d) => sum + fatePay(d, 'satellite').totalCr, 0);
  return `hands over ${list}, pays ${creditsText(total)}`;
}
