/**
 * WhereNextRows - the rows of the "where next" list on floor 4 (Nets step 3 slice 2b, lane 2b-2; plan decision K;
 * DECISIONS §33 rows 6 and 10; FEATURE_FLAGS.FIELDS_BY_HEIGHT).
 *
 * Pure: it reads the field registry (`fields()`, `currentField()`, `remainingCount()`, `planTo()`, `defaultNext()`) and answers
 * plain data and plain words. No DOM, no events, no game state, so the list (js/ui/WhereNextList.js), the flow manager and the
 * tests all see the same rows. Rebuilt each time the list opens or is shown again: the gas, her mass and the pieces left change.
 *
 * Slice 3 (the resupply satellite, DECISIONS §33 rows 7 and 10; Constants.RESUPPLY): when she is NOT berthed the satellite's row
 * comes first, then one row per field other than hers, the nearest height first (a tie goes to the lower field), then "Stay here"
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
 * Pre-focus: the satellite when it can be flown and she has NO mother nets aboard (`opts.motherNets` 0: mission 1 used all four,
 * row 10), else the field `defaultNext()` would fly to (the nearest one with pieces she can reach), else Stay, else the first row
 * she can pick. Nothing selectable at all (no reachable field, no Stay, no satellite) gives `line` = NO_REACH_LINE (berthed:
 * BERTH_NO_REACH_LINE) and an empty pick set: away from the satellite the flow manager says the line and starts the next mission
 * where she is; berthed it says the line and keeps the list open.
 *
 * @module systems/WhereNextRows
 */

import { FloorContract } from '../core/FloorContract.js';

/** The id of the "Stay here" row (field ids are f<km>). */
export const STAY_ID = 'stay';

/** The one comms line when the choice opens (the floor's name comes from the contract, never typed here). */
export const OPEN_LINE = `Mission done. Pick where next on the ${(FloorContract.byId(4) || { name: 'map' }).name} map.`;

/** What she is told when nothing in the list can be picked. */
export const NO_REACH_LINE = 'No field you can reach with the gas aboard.';

/** Berthed with nothing she can pick (no gas for any field): the list stays open (DECISIONS §33 row 7: gas is bought there). */
export const BERTH_NO_REACH_LINE = 'Buy gas at the workbench, then pick a field.';

const FLOOR_NAME = (FloorContract.byId(4) || { name: 'map' }).name;

/** The one comms line when she has berthed at the resupply satellite (slice 3, S5). */
export const BERTH_LINE = `Berthed at the resupply satellite. Buy nets and gas at the workbench, then pick a field on the ${FLOOR_NAME} map.`;

/** The `kind` of a satellite row (the list paints any row; the flow manager picks by id). */
export const SATELLITE_ROW_KIND = 'satellite';

const DOT = '\u00b7';

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
 * @property {string} id          field id ('f400'), a satellite id ('sat500') or STAY_ID
 * @property {'field'|'stay'|'satellite'} kind
 * @property {number} altKm       the field's height (Stay: her own field's; the satellite's)
 * @property {number} pieces      pieces left in that field (0 for the satellite)
 * @property {'ok'|'cleared'|'short'|'cannot'|'stay'} state
 * @property {boolean} selectable
 * @property {string} text        the row's words
 * @property {number} [gasKg]     the whole trip's gas (a trip she can fly, or one she is short for)
 * @property {number} [gasPct]    gas / gas aboard, percent
 * @property {number} [days]      the profile's days
 * @property {number} [shortKg]   profile gas minus gas aboard (state 'short')
 */

/**
 * @param {object} reg a FieldRegistry (or anything with its read face)
 * @param {{motherNets?: number}} [opts] `motherNets`: the mother's nets aboard now (an unknown count never pre-focuses the satellite)
 * @returns {{rows: WhereNextRow[], focusId: (string|null), selectable: string[], line: (string|null)}}
 */
export function buildWhereNextRows(reg, opts = {}) {
  const berth = typeof reg.berthedSatellite === 'function' ? reg.berthedSatellite() : null;
  const here = reg.currentField();
  const fromKm = berth ? berth.altKm : here.altKm;
  const others = reg.fields()
    .filter((f) => berth || f.id !== here.id)                  // berthed: no field is hers
    .sort((a, b) => Math.abs(a.altKm - fromKm) - Math.abs(b.altKm - fromKm) || a.altKm - b.altKm);
  /** @type {WhereNextRow[]} */
  const rows = [];
  if (!berth && typeof reg.satellites === 'function') {
    for (const s of reg.satellites()) rows.push(satelliteRow(reg, s));
  }
  for (const f of others) {
    const n = reg.remainingCount(f.id);
    const head = `Field at ${Math.round(f.altKm)} km`;
    if (n === 0) {
      rows.push({ id: f.id, kind: 'field', altKm: f.altKm, pieces: 0, state: 'cleared', selectable: false, text: `${head} ${DOT} cleared` });
      continue;
    }
    const plan = reg.planTo(f);
    if (!plan || !plan.profile || !plan.profile.ok) {
      rows.push({ id: f.id, kind: 'field', altKm: f.altKm, pieces: n, state: 'cannot', selectable: false, text: `${head} ${DOT} the thruster cannot take her there` });
      continue;
    }
    const gasKg = plan.profile.gasKg;
    if (!plan.enough) {
      const shortKg = gasKg - plan.gasAboardKg;
      rows.push({
        id: f.id, kind: 'field', altKm: f.altKm, pieces: n, state: 'short', selectable: false, gasKg, shortKg, days: plan.profile.days,
        text: `${head} ${DOT} needs ${kgText(gasKg)} kg gas, ${kgText(shortKg)} kg short`,
      });
      continue;
    }
    const gasPct = plan.gasAboardKg > 0 ? gasKg / plan.gasAboardKg * 100 : 0;
    rows.push({
      id: f.id, kind: 'field', altKm: f.altKm, pieces: n, state: 'ok', selectable: true, gasKg, gasPct, days: plan.profile.days,
      text: `${head} ${DOT} ${piecesText(n)} ${DOT} ${kgText(gasKg)} kg gas (${pctText(gasKg, plan.gasAboardKg)}) ${DOT} ${daysText(plan.profile.days)}`,
    });
  }
  const hereN = reg.remainingCount(here.id);
  if (!berth && hereN > 0) {
    rows.push({ id: STAY_ID, kind: 'stay', altKm: here.altKm, pieces: hereN, state: 'stay', selectable: true, text: `Stay here ${DOT} ${piecesText(hereN)}` });
  }
  const selectable = rows.filter((r) => r.selectable).map((r) => r.id);
  const next = reg.defaultNext();
  const satRow = rows.find((r) => r.kind === SATELLITE_ROW_KIND && r.selectable);
  const noNets = Number.isFinite(opts && opts.motherNets) && opts.motherNets <= 0;     // mission 1 used all four (row 10)
  let focusId = null;
  if (satRow && noNets) focusId = satRow.id;
  else if (next && selectable.includes(next.id)) focusId = next.id;
  else if (selectable.includes(STAY_ID)) focusId = STAY_ID;
  else if (selectable.length) focusId = selectable[0];
  return { rows, focusId, selectable, line: selectable.length ? null : (berth ? BERTH_NO_REACH_LINE : NO_REACH_LINE) };
}

/**
 * @private The row of a satellite she can fly to: where, what it is for, then the real trip's gas, share of the gas aboard and days
 * (as a field row says them), or what she is short.
 * @param {object} reg @param {{id: string, altKm: number, name?: string}} s
 * @returns {WhereNextRow}
 */
function satelliteRow(reg, s) {
  const head = `${s.name || 'Resupply satellite'} at ${Math.round(s.altKm)} km`;
  const base = { id: s.id, kind: SATELLITE_ROW_KIND, altKm: s.altKm, pieces: 0 };
  const plan = reg.planTo(s);
  if (!plan || !plan.profile || !plan.profile.ok) {
    return { ...base, state: 'cannot', selectable: false, text: `${head} ${DOT} the thruster cannot take her there` };
  }
  const gasKg = plan.profile.gasKg;
  if (!plan.enough) {
    const shortKg = gasKg - plan.gasAboardKg;
    return { ...base, state: 'short', selectable: false, gasKg, shortKg, days: plan.profile.days, text: `${head} ${DOT} needs ${kgText(gasKg)} kg gas, ${kgText(shortKg)} kg short` };
  }
  const gasPct = plan.gasAboardKg > 0 ? gasKg / plan.gasAboardKg * 100 : 0;
  return {
    ...base, state: 'ok', selectable: true, gasKg, gasPct, days: plan.profile.days,
    text: `${head} ${DOT} nets, gas, shop ${DOT} ${kgText(gasKg)} kg gas (${pctText(gasKg, plan.gasAboardKg)}) ${DOT} ${daysText(plan.profile.days)}`,
  };
}
