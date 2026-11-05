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
 * Posting: `{ v: 1, kind: 'bounty', fieldId, row, client, launchYear, label, posted: true, done, missed, doneShown }`. `done`: the piece was disposed of and the
 * bonus paid; `missed`: she let it go but it stays up over 25 years (not removed: no bonus, the posting is closed); `doneShown`: the closing
 * line ("Done" or "Missed") has been put on a list once (it then goes away for good).
 *
 * REMOVAL JOBS (plan route-1101 lanes J2 and J4, DECISIONS §62 rows 4 and 12; research doc docs/research/2026-11-removal-pay.md §1, §4): beside the Vespa
 * bounty the board posts named pieces from the real payers. Each pays INSTEAD of the ordinary `FEE_CR_PER_KG` fee (the game adds only the difference,
 * `jobSupplementCr`). Three kinds, at most one open at a time per slot (the agency slot holds A or B; the press slot holds C):
 *   A  the one agency job: a rocket stage, from mission 5, only after she has removed a big piece herself, mass x Japan's rate (270 cr/kg), once a game;
 *   B  the later agency jobs: only after A was PAID (a missed A means none ever), a stage or satellite of the rows `bRows`, mass x NASA's ceiling
 *      (30 cr/kg), at most 2 a game;
 *   C  good press: a company's own dead satellite (the row marked `pressClient`), from mission 3, a flat 105,000 cr, at most 2 a game.
 * Spacing: a kind's next posting needs the mission number to be at least the mission its last posting closed (paid or missed) plus 3; B's first counts
 * from A's close. A job leaves by push, hand-over or melt (it pays), a sail that brings it down within 25 years (it pays); keep pays nothing and leaves
 * it open; a sail that leaves it up over 25 years misses it. The counts and mission numbers live in the board state (`newBoardState`), saved with the
 * postings under the save's `jobBoard` (`boardFromSave`). A posting: the bounty's shape plus `kind` ('removal' or 'press'), `tier` ('A' or 'B' on a
 * removal job), `what` ('stage' or 'satellite'), `payCr` (an ESTIMATE shown before she arrives: the row's middle mass x the rate, or the flat pay;
 * the real pay is the caught piece's own mass) and `paidCr` (what the job has paid so far).
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
    v: 1, kind: 'bounty', fieldId, row, client: def.owner.name, launchYear: Number.isFinite(def.owner.launchYear) ? def.owner.launchYear : null,
    label: pieceLabel(def), posted: true, done: false, missed: false, doneShown: false,
  };
}

/** Does `p` (a held body or a scoop bag, with `fieldId` / `fieldRow`, or the ledger's own `_disposal` note) carry this posting's field AND row? */
function matchesPosting(posting, p) {
  return !!p && (((p.fieldId ?? p._bagFieldId) === posting.fieldId && (p.fieldRow ?? p._bagFieldRow) === posting.row)
    || (!!p._disposal && p._disposal.fieldId === posting.fieldId && p._disposal.row === posting.row));
}

/**
 * The body of `piece` that is the posted one: a big member of a bag, or the piece itself; null when it is not (or the posting is closed).
 * Both the field and the row must match. The ledger's own `_disposal` note (`{fieldId, row}`, written at the catch) counts too: a push or a sail
 * lets the piece go with its field and row cleared, and the note is gone once the piece leaves the ledger, so ask BEFORE `bigPieces.remove`.
 * @param {object|null} posting @param {object|null} piece a held body or a scoop bag
 * @returns {object|null}
 */
export function jobMember(posting, piece) {
  if (!posting || !posting.posted || posting.done || posting.missed || !piece) return null;
  if (piece.isBag === true && Array.isArray(piece.bagMembers)) {
    for (const m of piece.bagMembers) {
      const body = m && m.piece ? m.piece : m;
      if (matchesPosting(posting, body)) return body;
    }
  }
  return matchesPosting(posting, piece) ? piece : null;
}

/** Is `piece` (a held body or a scoop bag, with `fieldId` / `fieldRow`) the posted one? See `jobMember`. */
export function isJobPiece(posting, piece) {
  return jobMember(posting, piece) != null;
}

// ── removal jobs ─────────────────────────────────────────────────────────────

/**
 * @param {'A'|'B'} [tier]
 * @returns {number} credits per kg a removal job pays, read at use time: A `BIG_PIECES.JOB_CR_PER_KG` (270 today, Japan's rate), B `JOB_B_CR_PER_KG`
 *   (30 today, NASA's ceiling). Both are USD per kg over `USD_PER_CREDIT`.
 */
export function removalCrPerKg(tier = 'A') { return tier === 'B' ? Constants.BIG_PIECES.JOB_B_CR_PER_KG : Constants.BIG_PIECES.JOB_CR_PER_KG; }

/** @returns {number} the pay for `massKg` of a removal job's piece at its tier's rate, whole credits. */
export function removalPayCr(massKg, tier = 'A') { return Math.round((Number.isFinite(massKg) && massKg > 0 ? massKg : 0) * removalCrPerKg(tier)); }

/** @returns {number} the good-press job's flat pay, whole credits (`BIG_PIECES.JOB_PRESS_USD` over `USD_PER_CREDIT`: 105,000 today). */
export function pressPayCr() { return Math.round(Constants.BIG_PIECES.JOB_PRESS_CR); }

/** @returns {number} what `posting` pays for a piece of `massKg` in all: the flat press pay, or mass x its tier's rate. */
export function jobPayCr(posting, massKg) {
  return posting && posting.kind === 'press' ? pressPayCr() : removalPayCr(massKg, posting && posting.tier === 'B' ? 'B' : 'A');
}

/**
 * The job pay for the part of a piece (`f0` to `f1`, shares of `massKg`) a melt finishes: the whole pay's share, cumulative and rounded once per point, so the
 * parts add up to exactly `jobPayCr` (the flat press pay included).
 */
export function jobPartPayCr(posting, massKg, f0 = 0, f1 = 1) {
  const whole = jobPayCr(posting, massKg);
  const at = (f) => Math.round(whole * Math.min(1, Math.max(0, f)));
  return Math.max(0, at(f1) - at(f0));
}

/**
 * What a job piece pays ABOVE the ordinary removal fee for the part of it (`f0` to `f1`, shares of `massKg`) paid now: the game pays the
 * ordinary fee as it always did, this is added so the whole is the job pay (never less than the fee). Cumulative and rounded once per
 * point, so the parts of a melt add up exactly (the flat press pay too: 105,000 x each part's share).
 * @param {object} posting a removal or press posting @param {number} massKg @param {number} [f0] @param {number} [f1]
 */
export function jobSupplementCr(posting, massKg, f0 = 0, f1 = 1) {
  const m = Number.isFinite(massKg) && massKg > 0 ? massKg : 0;
  const jobCr = jobPayCr(posting, m);                                     // the whole job pay
  const feeCr = Math.round(m * Constants.BIG_PIECES.FEE_CR_PER_KG);       // the whole ordinary fee, as BigPieceValues rounds it
  const at = (f) => { const k = Math.min(1, Math.max(0, f)); return Math.round(jobCr * k) - Math.round(feeCr * k); };
  return Math.max(0, at(f1) - at(f0));
}

/** A removal job of tier A's supplement (J2's name, kept): see `jobSupplementCr`. */
export function removalSupplementCr(massKg, f0 = 0, f1 = 1, tier = 'A') { return jobSupplementCr({ kind: 'removal', tier }, massKg, f0, f1); }

/** @returns {number} kg of a body (`mass`, else `massKg`, else 0). */
export function bodyMassKg(p) {
  if (!p) return 0;
  return Number.isFinite(p.mass) ? p.mass : (Number.isFinite(p.massKg) ? p.massKg : 0);
}

const catchLimitKg = () => (Constants.CAPTURE_NET && Constants.CAPTURE_NET.LARGE ? Constants.CAPTURE_NET.LARGE.CATCH_LIMIT_KG : Infinity);
const highTable = () => (Array.isArray(Constants.HIGH_FIELD) ? Constants.HIGH_FIELD : []);

/**
 * The `HIGH_FIELD` rows a job of this tier can name, 0-based indexes as `JOBS.ROW`; every row needs a client (`canPost`) and a mass within her catch limit
 * (`CAPTURE_NET.LARGE.CATCH_LIMIT_KG`) at its heaviest.
 *   A: a rocket stage (`types` has `rocketBody`): today 0 and 1 (SL-14, Meteor-1).
 *   B: any row but the Vespa bounty's (`JOBS.ROW`: its bounty already uses it), not an insurer's (wave 3's insurer job), not the press client's: today 0, 1, 2.
 * @param {'A'|'B'} [tier]
 * @returns {number[]}
 */
export function removalRows(tier = 'A') {
  const limit = catchLimitKg();
  const out = [];
  highTable().forEach((def, i) => {
    if (!def || !canPost(def) || !(def.massMax <= limit)) return;
    if (tier === 'B') {
      if (i !== JOBS.ROW && def.owner.status !== 'insurer' && def.pressClient !== true) out.push(i);
    } else if (Array.isArray(def.types) && def.types.includes('rocketBody')) out.push(i);
  });
  return out;
}

/** The good-press job's rows: a company's piece (`pressClient: true`) with a client and a mass within her catch limit. Today 7. @returns {number[]} */
export function pressRows() {
  const limit = catchLimitKg();
  const out = [];
  highTable().forEach((def, i) => { if (def && def.pressClient === true && canPost(def) && def.massMax <= limit) out.push(i); });
  return out;
}

const fieldDef = (id) => Constants.FIELDS.LIST.find((f) => f.id === id) || null;

/** @returns {'stage'|'satellite'} the word for a row's piece. */
const whatOf = (def) => (def && Array.isArray(def.types) && def.types.includes('rocketBody') ? 'stage' : 'satellite');

/**
 * A job's posting.
 * @param {'removal'|'press'} kind @param {'A'|'B'|null} tier @param {string} fieldId @param {number} row @param {object} def the `HIGH_FIELD` row
 */
function jobPosting(kind, tier, fieldId, row, def) {
  const mid = (def.massMin + def.massMax) / 2;
  const p = {
    v: 1, kind, fieldId, row, client: def.owner.name, launchYear: Number.isFinite(def.owner.launchYear) ? def.owner.launchYear : null,
    label: pieceLabel(def), what: whatOf(def), payCr: 0, paidCr: 0, posted: true, done: false, missed: false, doneShown: false,
  };
  if (kind === 'removal') p.tier = tier === 'B' ? 'B' : 'A';
  p.payCr = jobPayCr(p, mid);
  return p;
}

/**
 * Pick the piece a job names: of the rows `rows` still out in a high field (`reg.remainingRows(fieldId)` holds the row), the one with the cheapest trip
 * from where she is (`reg.planTo(fieldId)` gas; a trip that cannot be flown counts as dearest), ties to the heavier piece (the row's `massMax`), then the
 * lower field and row. The field she is in costs what `planTo` says (nothing for the same height). A field she has cleared (the row gone) is never offered.
 * @returns {{fieldId: string, row: number}|null}
 */
function pickPiece(reg, rows) {
  if (!reg || typeof reg.remainingRows !== 'function' || !rows.length) return null;
  const fields = (typeof reg.fields === 'function' ? reg.fields() : Constants.FIELDS.LIST).filter((f) => f && f.kind === 'high');
  let best = null;
  for (const f of fields) {
    const out = reg.remainingRows(f.id);
    const here = rows.filter((r) => out.includes(r));
    if (!here.length) continue;
    const plan = typeof reg.planTo === 'function' ? reg.planTo(f.id) : null;
    const gas = plan && plan.profile && plan.profile.ok && Number.isFinite(plan.profile.gasKg) ? plan.profile.gasKg : Infinity;
    for (const r of here) {
      const mass = Constants.HIGH_FIELD[r].massMax;
      const cheaper = !best || (gas < best.gas) || (gas === best.gas && mass > best.mass);
      if (cheaper) best = { fieldId: f.id, row: r, gas, mass };
    }
  }
  return best ? { fieldId: best.fieldId, row: best.row } : null;
}

/**
 * Post the next agency job of `tier`: the piece with the cheapest trip among `removalRows(tier)` (see `pickPiece`).
 * @param {{remainingRows: function, fields?: function, planTo?: function}|null} reg the field registry
 * @param {'A'|'B'} [tier]
 * @returns {object|null} the posting, or null (no registry, or no allowed piece is out in any high field)
 */
export function postRemovalJob(reg, tier = 'A') {
  const pick = pickPiece(reg, removalRows(tier));
  return pick ? jobPosting('removal', tier === 'B' ? 'B' : 'A', pick.fieldId, pick.row, Constants.HIGH_FIELD[pick.row]) : null;
}

/** Post the good-press job: the press client's piece with the cheapest trip. @param {object|null} reg @returns {object|null} */
export function postPressJob(reg) {
  const pick = pickPiece(reg, pressRows());
  return pick ? jobPosting('press', null, pick.fieldId, pick.row, Constants.HIGH_FIELD[pick.row]) : null;
}

// ── the board's counts and spacing ───────────────────────────────────────────

/**
 * A fresh board state: how many of each kind were posted, whether A was paid, the mission number each slot last closed in (`removal`: the agency slot,
 * A or B; `press`), and how many big pieces she has removed herself (push, hand-over, melt, a sail that brings it down within 25 years; never keep).
 * @returns {{aPosted: number, aPaid: boolean, bPosted: number, pressPosted: number, closeMission: {removal: number|null, press: number|null}, removed: number}}
 */
export function newBoardState() {
  return { aPosted: 0, aPaid: false, bPosted: 0, pressPosted: 0, closeMission: { removal: null, press: null }, removed: 0 };
}

const rules = () => Constants.BIG_PIECES.JOB_RULES;
/** The slot a posting sits in: the agency slot ('removal': A and B) or the press slot. */
const slotOf = (posting) => (posting && posting.kind === 'press' ? 'press' : 'removal');
const spaced = (state, slot, mission) => {
  const close = state.closeMission[slot];
  return close == null || mission >= close + rules().SPACING_MISSIONS;
};

/**
 * Which agency job is due now, if any (the caller asks only while the agency slot is empty). A: from `A_FIRST_MISSION`, after `A_MIN_REMOVED` big pieces
 * removed, once. B: only after A was paid, `SPACING_MISSIONS` after the agency slot last closed, at most `B_MAX`. A missed A means no agency job ever.
 * @param {object} state `newBoardState()` @param {number} mission the current mission number
 * @returns {'A'|'B'|null}
 */
export function nextRemovalTier(state, mission) {
  const R = rules();
  if (!state || !Number.isFinite(mission)) return null;
  if (state.aPosted < R.A_MAX) return mission >= R.A_FIRST_MISSION && state.removed >= R.A_MIN_REMOVED ? 'A' : null;
  if (!state.aPaid || state.bPosted >= R.B_MAX) return null;
  return spaced(state, 'removal', mission) ? 'B' : null;
}

/** Is a good-press job due now (the caller asks only while the press slot is empty)? From `PRESS_FIRST_MISSION`, `SPACING_MISSIONS` after the last one closed, at most `PRESS_MAX`. */
export function pressDue(state, mission) {
  const R = rules();
  return !!state && Number.isFinite(mission) && state.pressPosted < R.PRESS_MAX && mission >= R.PRESS_FIRST_MISSION && spaced(state, 'press', mission);
}

/** A posting was made: count it against its kind's limit. */
export function recordPosted(state, posting) {
  if (!state || !posting) return;
  if (posting.kind === 'press') state.pressPosted += 1;
  else if (posting.tier === 'B') state.bPosted += 1;
  else state.aPosted += 1;
}

/** A posting closed (paid or missed) in mission `mission`: its slot's spacing starts, and a paid A unlocks B. */
export function recordClosed(state, posting, mission) {
  if (!state || !posting) return;
  state.closeMission[slotOf(posting)] = Number.isFinite(mission) ? mission : null;
  if (posting.kind === 'removal' && posting.tier !== 'B' && posting.done === true) state.aPaid = true;
}

const stageName = (posting) => `${posting.label} ${posting.what === 'satellite' ? 'satellite' : 'stage'}`;

/** The text of the payer of a posting: "Space agency" for an agency job, the company for a press job ("Its operator"). */
function payerName(posting) {
  if (posting.kind !== 'press') return 'Space agency';
  const c = typeof posting.client === 'string' && posting.client.length ? posting.client : 'a company';
  return c.charAt(0).toUpperCase() + c.slice(1);
}

/**
 * The pay line added to a job's disposal line, "Space agency job: 388,800 cr for Russia's SL-14 stage at 270 cr/kg (349,920 cr over the ordinary
 * fee)." `paidCr` is the job's whole pay so far; for an agency job the ordinary fee it replaced is that pay at `FEE_CR_PER_KG` over the job rate; the
 * press job's flat pay replaces the fee outright.
 */
export function removalPayLine(posting) {
  const paid = Number.isFinite(posting.paidCr) ? posting.paidCr : 0;
  if (posting.kind === 'press') return `${payerName(posting)}'s good-press job: ${commas(paid)} cr flat for its ${posting.label}-class satellite, instead of the ordinary fee.`;
  const rate = removalCrPerKg(posting.tier);
  const over = rate > 0 ? Math.max(0, paid - Math.round(paid * Constants.BIG_PIECES.FEE_CR_PER_KG / rate)) : 0;
  return `${payerName(posting)} job: ${commas(paid)} cr for ${posting.client}'s ${stageName(posting)} at ${commas(rate)} cr/kg (${commas(over)} cr over the ordinary fee).`;
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
  const own = posting.kind === 'removal' || posting.kind === 'press' ? removalLine(posting, row, fmt) : bountyLine(posting, row, fmt);
  // Postings shown together: the list has one job slot, so the others ride on the first as `also` and come as further lines
  const more = Array.isArray(posting.also) ? posting.also.map((p) => jobLine({ ...p, also: undefined }, null, fmt)).filter((t) => !!t) : [];
  return [own, ...more].filter((t) => !!t).join('\n');
}

/** @returns {'done'|'missed'|'wanted'} the state a line of `jobLine` is in, from its lead word (`doneLine`, `missedLine`, `removalLine`): each posting shows its own. */
export function jobLineState(line) {
  const t = typeof line === 'string' ? line : '';
  return t.startsWith('Done:') ? 'done' : t.startsWith('Missed:') ? 'missed' : 'wanted';
}

/** The trip words of a row the posting's field has on the list ("12.4 kg gas, 25 days", with "short" when the tank is). */
function tripWords(row, fmt) {
  const trip = `${fmt.kgText(row.gasKg)} kg gas, ${fmt.daysText(row.days)}`;
  const short = Number.isFinite(row.shortKg) && row.shortKg > 0 ? ` \u00b7 short ${fmt.kgText(row.shortKg)} kg` : '';
  return `${trip}${short}`;
}

/** The row's own short reason after its first " . " (cleared, a mission going on, the thruster cannot), or ''. */
function rowReason(row) {
  const text = typeof row.text === 'string' ? row.text : '';
  const at = text.indexOf(' \u00b7 ');
  return at >= 0 ? text.slice(at + 3) : '';
}

/**
 * A job's lines (agency A and B, good press C), then the trip when she has a row for it:
 *   A "Space agency: remove Russia's SL-14 stage at 800 km, pays about 364,500 cr (once)"
 *   B "Space agency: remove Russia's Cosmos 1175 satellite at 800 km, pays about 40,500 cr (30 cr/kg)"
 *   C "Its operator wants good press: dead ORBCOMM OG2-class satellite at 850 km, pays 105,000 cr"
 */
function removalLine(posting, row, fmt) {
  const press = posting.kind === 'press';
  const piece = press ? `${posting.label}-class satellite` : `${posting.client}'s ${stageName(posting)}`;
  if (posting.done) return `Done: ${press ? `${payerName(posting)}'s ${piece}` : piece} removed, ${press ? 'good-press' : 'agency'} job paid ${commas(posting.paidCr)} cr \u2713`;
  if (posting.missed) return `Missed: ${press ? `${payerName(posting)}'s ${piece}` : piece} was left up for over ${Constants.BIG_PIECES.RULE_YEARS} years, no job pay`;
  const f = fieldDef(posting.fieldId);
  const km = row && Number.isFinite(row.altKm) ? row.altKm : (f ? f.altKm : NaN);
  const at = Number.isFinite(km) ? ` at ${Math.round(km)} km` : '';
  const what = press
    ? `${payerName(posting)} wants good press: dead ${piece}${at}, pays ${commas(posting.payCr)} cr`
    : `${payerName(posting)}: remove ${piece}${at}, pays about ${commas(posting.payCr)} cr (${posting.tier === 'B' ? `${commas(removalCrPerKg('B'))} cr/kg` : 'once'})`;
  if (!row) return what;
  if (Number.isFinite(row.gasKg) && Number.isFinite(row.days)) return `${what} \u00b7 ${tripWords(row, fmt)}`;
  const reason = rowReason(row);
  return `${what}${reason ? ` \u00b7 ${reason}` : ''}`;
}

/** The Vespa bounty's lines (unchanged words). */
function bountyLine(posting, row, fmt) {
  if (posting.done) return doneLine(posting);
  if (posting.missed) return missedLine(posting);
  const what = `${posting.client} pays a ${bonusText()} cr bonus, plus the removal fee, for its ${posting.label}${posting.launchYear ? ` (launched ${posting.launchYear})` : ''}`;
  if (!row) return `Wanted here: ${what} in this field`;
  const km = `${Math.round(row.altKm)} km`;
  if (Number.isFinite(row.gasKg) && Number.isFinite(row.days)) return `Wanted: ${what} at ${km} \u00b7 ${tripWords(row, fmt)}`;
  // cleared / a mission going on / the thruster cannot: the row's own short reason, when it has one
  const reason = rowReason(row);
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
      v: 1, kind: 'bounty', fieldId, row, client: def.owner.name, launchYear: Number.isFinite(def.owner.launchYear) ? def.owner.launchYear : null,
      label: pieceLabel(def), posted: true, done: saved.done === true, missed: saved.missed === true && saved.done !== true, doneShown: saved.doneShown === true,
    };
  } catch (_e) {
    return null;
  }
}

/** @returns {object|null} the save form of an agency or press job (a copy), or null with nothing posted. Saved inside the save's `jobBoard` (`boardToSave`). */
export function removalToSave(posting) {
  if (!posting || !posting.posted || (posting.kind !== 'removal' && posting.kind !== 'press')) return null;
  const out = {
    v: 1, kind: posting.kind, ...(posting.kind === 'removal' ? { tier: posting.tier === 'B' ? 'B' : 'A' } : {}), fieldId: posting.fieldId, row: posting.row, posted: true,
    done: !!posting.done, missed: !!posting.missed, doneShown: !!posting.doneShown, paidCr: Number.isFinite(posting.paidCr) && posting.paidCr > 0 ? Math.round(posting.paidCr) : 0,
  };
  return out;
}

/**
 * An agency or press job back from a save: it must name a high field and a row its kind allows (`removalRows(tier)` / `pressRows()`); the client's words and
 * the pay estimate are re-read from the table. Anything else is "not posted yet" (null), never an error.
 * @param {*} saved a posting's save form
 * @returns {object|null}
 */
export function removalFromSave(saved) {
  try {
    if (!saved || typeof saved !== 'object' || saved.v !== 1 || saved.posted !== true) return null;
    const press = saved.kind === 'press';
    if (!press && saved.kind !== 'removal') return null;
    const tier = saved.tier === 'B' ? 'B' : 'A';
    const { fieldId, row } = saved;
    if (typeof fieldId !== 'string' || !Number.isInteger(row) || !(press ? pressRows() : removalRows(tier)).includes(row)) return null;
    const f = fieldDef(fieldId);
    if (!f || f.kind !== 'high') return null;
    const posting = jobPosting(press ? 'press' : 'removal', press ? null : tier, fieldId, row, Constants.HIGH_FIELD[row]);
    posting.done = saved.done === true;
    posting.missed = saved.missed === true && saved.done !== true;
    posting.doneShown = saved.doneShown === true;
    posting.paidCr = Number.isFinite(saved.paidCr) && saved.paidCr > 0 ? Math.round(saved.paidCr) : 0;
    return posting;
  } catch (_e) {
    return null;
  }
}

const wholeNum = (n, max) => (Number.isFinite(n) && n > 0 ? Math.min(max, Math.floor(n)) : 0);
const missionOrNull = (n) => (Number.isFinite(n) && n >= 1 ? Math.floor(n) : null);

/**
 * The save form of the board's agency and press state: the two postings (or null) and the counts. Null when there is nothing to save (a fresh state and
 * no posting), so a save that never saw a job stays byte-identical.
 * @param {object} state `newBoardState()` @param {object|null} removal the agency posting @param {object|null} press the press posting
 * @returns {object|null}
 */
export function boardToSave(state, removal, press) {
  const s = state || newBoardState();
  const rem = removalToSave(removal);
  const prs = removalToSave(press);
  const fresh = !rem && !prs && !s.aPosted && !s.bPosted && !s.pressPosted && !s.removed && s.closeMission.removal == null && s.closeMission.press == null;
  if (fresh) return null;
  return {
    v: 1, ...(rem ? { removal: rem } : {}), ...(prs ? { press: prs } : {}),
    aPosted: wholeNum(s.aPosted, 1), aPaid: s.aPaid === true, bPosted: wholeNum(s.bPosted, 99), pressPosted: wholeNum(s.pressPosted, 99),
    closeMission: { removal: missionOrNull(s.closeMission.removal), press: missionOrNull(s.closeMission.press) },
    removed: wholeNum(s.removed, 9999),
  };
}

/**
 * The whole board back from a save: the Vespa bounty from `save.jobs` (the only key a save before the removal jobs holds, so an old save loads exactly as
 * it did, with nothing else posted and every count 0) and the agency and press state from `save.jobBoard`. Malformed pieces drop to "not posted yet".
 * @param {{jobs?: *, jobBoard?: *}|null} save
 * @returns {{bounty: object|null, removal: object|null, press: object|null, state: object}}
 */
export function boardFromSave(save) {
  const s = save && typeof save === 'object' ? save : {};
  const b = s.jobBoard && typeof s.jobBoard === 'object' && s.jobBoard.v === 1 ? s.jobBoard : null;
  const state = newBoardState();
  if (b) {
    state.aPosted = wholeNum(b.aPosted, 1);
    state.aPaid = b.aPaid === true && state.aPosted > 0;
    state.bPosted = wholeNum(b.bPosted, 99);
    state.pressPosted = wholeNum(b.pressPosted, 99);
    const cm = b.closeMission && typeof b.closeMission === 'object' ? b.closeMission : {};
    state.closeMission = { removal: missionOrNull(cm.removal), press: missionOrNull(cm.press) };
    state.removed = wholeNum(b.removed, 9999);
  }
  const removal = b ? removalFromSave(b.removal) : null;
  const press = b ? removalFromSave(b.press) : null;
  return { bounty: fromSave(s.jobs), removal: removal && removal.kind === 'removal' ? removal : null, press: press && press.kind === 'press' ? press : null, state };
}
