/**
 * JobsBoard - the jobs board's first slice (DECISIONS §42 row 5, owner 2026-10-28 "3 yes"): ONE posted bounty for a named big piece,
 * no deadline. After mission 1 the "where next" list shows one wanted piece at a high field: a client, a fixed bonus on top of the normal
 * removal fee, and the gas and days to reach it. It ticks off when the piece is disposed of.
 *
 * Pure: no DOM, no events, no game state. The flow manager (js/systems/GameFlowManager.js) holds the posting, posts it when the list opens,
 * pays the bonus in `disposeBigPiece` and saves it; `buildWhereNextRows` (js/systems/WhereNextRows.js) draws it through `jobLine`.
 *
 * The posting: ESA's Vespa-class dead satellite (`Constants.HIGH_FIELD` row 4) at f800, a row whose owner is a real client. A piece nobody
 * owns (`status: 'abandoned'`, no name) has no client, so it can never be posted (`canPost`).
 *
 * Posting: `{ v: 1, fieldId, row, client, launchYear, label, posted: true, done, missed, doneShown }`. `done`: the piece was disposed of and the
 * bonus paid; `missed`: she let it go but it stays up over 25 years (not removed: no bonus, the posting is closed); `doneShown`: the closing
 * line ("Done" or "Missed") has been put on a list once (it then goes away for good).
 * @module systems/JobsBoard
 */

import { Constants } from '../core/Constants.js';

/** The one posting. `BONUS_CR` is an ESTIMATE to tune (about one to three times this piece's 1,000-2,500 cr removal fee). */
export const JOBS = { FIELD_ID: 'f800', ROW: 4, BONUS_CR: 3000 };

const commas = (n) => String(Math.max(0, Math.round(Number.isFinite(n) ? n : 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** @returns {string} "3,000" */
export function bonusText(cr = JOBS.BONUS_CR) { return commas(cr); }

/**
 * Can this `HIGH_FIELD` row be posted? It needs a client: a named owner whose status is not "abandoned".
 * @param {object|null} rowDef a `Constants.HIGH_FIELD` row
 * @returns {boolean}
 */
export function canPost(rowDef) {
  const o = rowDef && rowDef.owner;
  return !!o && typeof o.name === 'string' && o.name.length > 0 && o.status !== 'abandoned';
}

/** "Vespa" from "Dead satellite (Vespa class)"; the row's own name when it has no "(... class)". */
function pieceLabel(rowDef) {
  const name = rowDef && typeof rowDef.name === 'string' ? rowDef.name : 'piece';
  const m = /\(([^()]+?) class\)/.exec(name);
  return m ? m[1] : name;
}

/**
 * Post the first job when it is due: the piece is still out at its field. Idempotent for the caller (it asks only while nothing is posted).
 * @param {{remainingRows: function}|null} reg the field registry
 * @param {{row?: number, fieldId?: string}} [o] tests: another row or field
 * @returns {object|null} the posting, or null (no registry, the row is not at the field any more, or the row has no client)
 */
export function postFirstJob(reg, o = {}) {
  const row = Number.isInteger(o.row) ? o.row : JOBS.ROW;
  const fieldId = typeof o.fieldId === 'string' ? o.fieldId : JOBS.FIELD_ID;
  const def = Array.isArray(Constants.HIGH_FIELD) ? Constants.HIGH_FIELD[row] : null;
  if (!reg || typeof reg.remainingRows !== 'function' || !canPost(def)) return null;
  if (!reg.remainingRows(fieldId).includes(row)) return null;
  return {
    v: 1, fieldId, row, client: def.owner.name, launchYear: Number.isFinite(def.owner.launchYear) ? def.owner.launchYear : null,
    label: pieceLabel(def), posted: true, done: false, missed: false, doneShown: false,
  };
}

/**
 * Is `piece` (a held body or a scoop bag, with `fieldId` / `fieldRow`) the posted one? Both the field and the row must match. The ledger's own
 * `_disposal` note (`{fieldId, row}`, written at the catch) counts too: a push or a sail lets the piece go with its field and row cleared, and the
 * note is gone once the piece leaves the ledger, so ask BEFORE `bigPieces.remove`.
 */
export function isJobPiece(posting, piece) {
  if (!posting || !posting.posted || posting.done || posting.missed || !piece) return false;
  const one = (p) => !!p && (((p.fieldId ?? p._bagFieldId) === posting.fieldId && (p.fieldRow ?? p._bagFieldRow) === posting.row)
    || (!!p._disposal && p._disposal.fieldId === posting.fieldId && p._disposal.row === posting.row));
  if (one(piece)) return true;
  if (piece.isBag === true && Array.isArray(piece.bagMembers)) return piece.bagMembers.some((m) => one(m && m.piece ? m.piece : m));
  return false;
}

/** The pay line added to a disposal's line, "ESA bounty +3,000 cr." */
export function bountyPayLine(posting) { return `${posting.client} bounty +${bonusText()} cr.`; }

/** The "Missed" line (shown once on the next list): the piece was let go and stays up over the 25-year rule, so no bonus. */
export function missedLine(posting) { return `Missed: ${posting.client}'s ${posting.label} was left up for over ${Constants.BIG_PIECES.RULE_YEARS} years, no bonus`; }

/** The "Done" line (shown once on the next list). */
export function doneLine(posting) { return `Done: ${posting.client}'s ${posting.label} removed, ${bonusText()} cr bonus paid \u2713`; }

/**
 * The line the "where next" list shows under its opening line.
 * @param {object|null} posting
 * @param {object|null} row the list's row for the posting's field (null = she is at that field now: no row is made for her own field)
 * @param {{kgText: function, daysText: function}} fmt the list's own words for gas and days
 * @returns {string|null}
 */
export function jobLine(posting, row, fmt) {
  if (!posting || !posting.posted) return null;
  if (posting.done) return doneLine(posting);
  if (posting.missed) return missedLine(posting);
  const what = `${posting.client} pays a ${bonusText()} cr bonus, plus the removal fee, for its ${posting.label}${posting.launchYear ? ` (launched ${posting.launchYear})` : ''}`;
  if (!row) return `Wanted here: ${what} in this field`;
  const km = `${Math.round(row.altKm)} km`;
  if (Number.isFinite(row.gasKg) && Number.isFinite(row.days)) {
    const trip = `${fmt.kgText(row.gasKg)} kg gas, ${fmt.daysText(row.days)}`;
    const short = Number.isFinite(row.shortKg) && row.shortKg > 0 ? ` \u00b7 short ${fmt.kgText(row.shortKg)} kg` : '';
    return `Wanted: ${what} at ${km} \u00b7 ${trip}${short}`;
  }
  // cleared / a mission going on / the thruster cannot: the row's own short reason, when it has one
  const text = typeof row.text === 'string' ? row.text : '';
  const at = text.indexOf(' \u00b7 ');
  const reason = at >= 0 ? text.slice(at + 3) : '';
  return `Wanted: ${what} at ${km}${reason ? ` \u00b7 ${reason}` : ''}`;
}

/** @returns {object|null} the save form (a copy), or null with nothing posted */
export function toSave(posting) {
  if (!posting || !posting.posted) return null;
  return {
    v: 1, fieldId: posting.fieldId, row: posting.row, posted: true, done: !!posting.done, missed: !!posting.missed, doneShown: !!posting.doneShown,
  };
}

/**
 * The posting back from a save. A missing or malformed key is "not posted yet" (null), never an error: the posting must name a real
 * high field and a real client row. The client's words are re-read from the table, not trusted from the save.
 * @param {*} saved the save's `jobs`
 * @returns {object|null}
 */
export function fromSave(saved) {
  try {
    if (!saved || typeof saved !== 'object' || saved.v !== 1 || saved.posted !== true) return null;
    const { fieldId, row } = saved;
    if (typeof fieldId !== 'string' || !Number.isInteger(row) || row < 0) return null;
    const f = Constants.FIELDS.LIST.find((x) => x.id === fieldId);
    const def = Array.isArray(Constants.HIGH_FIELD) ? Constants.HIGH_FIELD[row] : null;
    if (!f || f.kind !== 'high' || !canPost(def)) return null;
    return {
      v: 1, fieldId, row, client: def.owner.name, launchYear: Number.isFinite(def.owner.launchYear) ? def.owner.launchYear : null,
      label: pieceLabel(def), posted: true, done: saved.done === true, missed: saved.missed === true && saved.done !== true, doneShown: saved.doneShown === true,
    };
  } catch (_e) {
    return null;
  }
}
