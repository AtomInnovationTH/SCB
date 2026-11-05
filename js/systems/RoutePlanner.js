/**
 * RoutePlanner - the Routes section of the "where next" list: the best three routes through the debris she knows about, priced at
 * her live mass and gas (plan route-1101 wave 2, lane R2; owner 2026-11-01: "very important for user chosing route thru debris
 * based on mass changes and remaining DeltaV. Not just for large debris. For any debris with credit value or scavenge value.").
 *
 * PURE: it reads a plain state (`GameFlowManager.routePanelState()` builds it from the live game) and answers plain data. The pricing
 * and the search are `RouteCost.js`; the rules of a route (a mission is 5 catches, a move only between missions, at most 2 moves, the
 * fee only at a hand-over, push or melt, the hold limits) are written at the top of that file. This file decides WHAT she may go for:
 *
 *   physically real: tracked objects are known before arrival, small debris only after a scan.
 *   (a) the field she is in: the pieces she has DISCOVERED (`discovered` true; a piece her scanner has not found is never a candidate),
 *       approach distance from where she is now.
 *   (b) the high fields (kind 'high', 750-900 km): the rows of `Constants.HIGH_FIELD` not yet taken (the registry's `remainingRows`).
 *       A row's mass is the middle of its range (`massMin`..`massMax`), her approach distance the middle of the row's own
 *       placement (`fwdMinM`..`fwdMaxM` ahead, `latM` aside, `radM` up: Constants.js HIGH_FIELD rows, DebrisField.js:3563 highFieldSpec,
 *       :3788 fieldRowSpec). Its metal is not priced (not known before arrival).
 *   (c) every other field is a transfer stop only: its pieces are unknown, so a visit there is 5 catches of unknown value ("+5 unscanned").
 *   (d) disposals: the satellite (hand-over), and for each big piece (aboard now or a candidate) a `push` (down to its 25-year height,
 *       `pushTargetKm`, as `GameFlowManager._pickPush` :3470) and a `melt` (the furnaces during the next transfers, BigMelt.js `planBurn`).
 * Every piece candidate carries `fieldId` and `fieldRow`, the keys `JobsBoard.isJobPiece` matches on (JobsBoard.js:68-75), and
 * `pieceValue` gets the open postings (`state.jobPostings`) so a posted job's pay is the fee of that piece.
 *
 * @module systems/RoutePlanner
 */
import { Constants } from '../core/Constants.js';
import { scoringSystem, CAPTURE_TIERS, taperMultiplier, computeSaleValue } from './ScoringSystem.js';
import { pieceValue, isCandidate, bestRoutes, SORTS, MAX_MOVES } from './RouteCost.js';
import { fatePay, pieceValues } from './BigPieceValues.js';
import { lifetimeYears, dragAreaM2 } from './OrbitLifetime.js';
import { PART_KG } from './BigMelt.js';
import { isJobPiece } from './JobsBoard.js';
import { STAY_ID, PUSH_PREFIX, creditsText, kgText, daysText } from './WhereNextRows.js';

export { SORTS };

/** The sorts' names for the chip. */
export const SORT_LABELS = { credits: 'most credits', crPerKg: 'credits per kg gas', days: 'fewest days' };

/** The most pieces of the field she is in that go into the search (the best paying; the rest only fill a mission's quota). */
export const MAX_LIVE_PIECES = 12;
/** Routes shown. */
export const TOP_ROUTES = 3;
/** The exact leg's step for the panel: 300 s, 5x cheaper than the game's 60 s and the same delta-v to 3 decimals (RouteCost.js FAST_STEP_S note). */
export const PANEL_STEP_S = 300;
/** The beam the panel searches with: 20 lost the best route in the seeded probe (84,615 cr against 124,550 at 50 and 100), 50 costs the same. */
export const PANEL_BEAM = 50;

/** The next sort in the chip's cycle. */
export function nextSort(sortBy) {
  const i = SORTS.indexOf(sortBy);
  return SORTS[(i + 1) % SORTS.length];
}

const catchLimitKg = () => Constants.CAPTURE_NET.LARGE.CATCH_LIMIT_KG;

/** "SL-14 stage" from "Dead upper stage (SL-14 class)"; a satellite keeps its class ("Vespa"); otherwise the piece's own name or type. */
export function pieceLabel(d) {
  const name = d && typeof d.name === 'string' ? d.name : '';
  const m = /\(([^()]+?) class\)/.exec(name);
  if (m) return d.type === 'rocketBody' ? `${m[1]} stage` : m[1];
  if (name) return name;
  return d && d.type === 'rocketBody' ? 'stage' : (d && d.type === 'defunctSat' ? 'satellite' : 'piece');
}

/** @returns {boolean} a big piece: a stage or dead satellite with an owner (BigPieceValues.js:30 `isBigLike`) */
const isBig = (d) => !!d && Constants.BIG_PIECES.TYPES.includes(d.type) && !!d.owner;

/**
 * What a big piece needs for its three exits: the height a push lets go at, what a hand-over adds to the fee (parts and collector pay,
 * `fatePay` 'satellite' less 'push'), and the furnace numbers (part size, metal per kg, the owner's share of the metal, which a melt
 * takes off the fee, BigMelt.js `meltedSoFar`).
 */
const _bigMemo = new Map();
const _pushMemo = new Map();

/**
 * The height a push lets a piece go at: `OrbitLifetime.pushTargetKm` (the 24-year height, floored to 5 km), found over the 5 km grid
 * by bisection (8 life integrations, not the 50 of `heightForYears`; the same answer: the floor of the height whose life is 24 years is
 * the highest grid height whose life is not over 24). One integration at 600+ km takes 20-100 ms, so a piece costs a fraction of a
 * second, once (memo). NaN when the piece has no usable mass or area.
 */
export function pushHeightKm(mass, areaM2) {
  const B = Constants.BIG_PIECES;
  if (!(mass > 0) || !(areaM2 > 0)) return NaN;
  const key = `${mass}|${areaM2}`;
  if (_pushMemo.has(key)) return _pushMemo.get(key);
  const step = B.PUSH_STEP_KM;
  const life = (km) => lifetimeYears(km, mass, areaM2);
  let out;
  if (life(1000) <= B.PUSH_TARGET_YEARS) out = 1000;
  else {
    let lo = Math.ceil(200 / step), hi = Math.floor(1000 / step);      // grid indexes: lo is taken as short-lived, hi as long-lived
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (life(mid * step) > B.PUSH_TARGET_YEARS) hi = mid; else lo = mid;
    }
    out = lo * step;
  }
  if (_pushMemo.size > 500) _pushMemo.clear();
  _pushMemo.set(key, out);
  return out;
}

/**
 * Push heights of the 8 `HIGH_FIELD` rows at the middle of their mass range and their own drag area, from `pushTargetKm` (measured
 * 2026-11-02: 635, 670, 590, 560, 655, 645, 700 km; row 7, the ORBCOMM OG2-class satellite at 175 kg and 2.0 m2, measured 2026-11-05
 * by `pushTargetKm` itself: 655 km). A table so the first list that opens does not integrate ten years of decay eight
 * times; js/test/test-RoutePlanner.js recomputes three of them (rows 1, 4 and 7) and fails on drift.
 */
export const HIGH_ROW_PUSH_KM = [635, 670, 590, 560, 655, 645, 700, 655];

function bigInfo(d, knownPushKm) {
  const key = `${d.type}|${d.mass}|${d.areaM2}|${d.owner ? `${d.owner.status}|${d.owner.launchYear}` : ''}`;
  let info = _bigMemo.get(key);
  if (info) return info;
  const B = Constants.BIG_PIECES;
  const v = pieceValues(d);
  let pushKm = Number.isFinite(knownPushKm) ? knownPushKm : undefined;
  info = {
    get pushKm() { if (pushKm === undefined) pushKm = pushHeightKm(d.mass, dragAreaM2(d)); return pushKm; },     // lazy: only a route that pushes it pays for the integration
    satExtraCr: fatePay(d, 'satellite').totalCr - fatePay(d, 'push').totalCr,
    melt: { partKg: PART_KG[d.type], metalPerKg: B.METAL_FRACTION[d.type] || 0, shareCr: Math.round(v.consentShare * v.scrapKg * B.IN_ORBIT_CR_PER_KG) },
  };
  if (_bigMemo.size > 500) _bigMemo.clear();
  _bigMemo.set(key, info);
  return info;
}

function payCtx(state) {
  return {
    scoringSystem, captureTier: CAPTURE_TIERS.CAPTURE, taperMultiplier, computeSaleValue,
    captureCreditsEarned: Number.isFinite(state.captureCreditsEarned) ? state.captureCreditsEarned : 0,
    jobPostings: Array.isArray(state.jobPostings) ? state.jobPostings : [],
  };
}

/** A piece the posting matcher can see (`fieldId`, `fieldRow`): the live body when it has them, else a thin view over it. */
function viewOf(d, fieldId, fieldRow) {
  if (d.fieldId != null && d.fieldRow != null) return d;
  const v = Object.create(d);
  v.fieldId = fieldId ?? d.fieldId ?? null;
  v.fieldRow = fieldRow ?? d.fieldRow ?? null;
  return v;
}

export function pieceStop(id, d, value, { altKm, fieldId, fieldRow, posM, known = false, debrisId = null, pushKm }) {
  return {
    kind: 'piece', id, altKm, fieldId, fieldRow: fieldRow ?? null, posM, value, type: d.type, name: pieceLabel(d), known,
    big: isBig(d) ? bigInfo(d, pushKm) : null, debrisId,
  };
}

/** The ways out of a big piece, as stops: push it down, melt it. (Hand-over is the satellite's stop.) The push height is read when a route first pushes. */
export function disposalStops(stop) {
  if (!stop.big) return [];
  const out = [];
  const big = stop.big;
  out.push({ kind: 'push', id: `push:${stop.id}`, pieceId: stop.id, get pushKm() { return big.pushKm; }, name: stop.name });
  if (big.melt && big.melt.partKg > 0) out.push({ kind: 'melt', id: `melt:${stop.id}`, pieceId: stop.id, melt: big.melt, name: stop.name });
  return out;
}

/**
 * The stops a route may use, from a panel state (see `plan` for its fields).
 * @param {object} state
 * @param {{maxPieces?: number}} [opts]
 * @returns {{stops: object[], held: Array<{id: string, massKg: number, stop: object}>}} `held`: the big pieces she already carries
 *   (the route state's `held`; their push and melt stops are in `stops`)
 */
export function candidates(state, opts = {}) {
  const ctx = payCtx(state);
  const limit = catchLimitKg();
  const maxPieces = opts.maxPieces > 0 ? opts.maxPieces : MAX_LIVE_PIECES;
  const stops = [];
  // (a) the field she is in: what her scanner has found. Never an undiscovered piece, never one over the catch limit.
  const live = [];
  for (const e of state.pieces || []) {
    const d = e && e.piece;
    if (!d || e.discovered !== true || e.hazard || e.captured) continue;
    if (!(d.mass > 0) || d.mass > limit) continue;
    const value = pieceValue(viewOf(d, e.fieldId ?? state.fieldId, e.fieldRow), ctx);
    if (!isCandidate(value)) continue;
    live.push(pieceStop(e.id, d, value, { altKm: state.altKm, fieldId: state.fieldId, fieldRow: e.fieldRow, posM: e.posM || { x: 0, y: 0, z: 0 }, debrisId: e.debrisId ?? d.id ?? null }));
  }
  live.sort((a, b) => b.value.valueCr - a.value.valueCr || String(a.id).localeCompare(String(b.id)));
  stops.push(...live.slice(0, maxPieces));
  // (b) the rows of the high fields not yet taken: tracked objects, known before arrival
  for (const f of state.fields || []) {
    if (f.kind !== 'high' || f.id === state.fieldId) continue;
    for (const row of f.remaining || []) {
      const def = Array.isArray(Constants.HIGH_FIELD) ? Constants.HIGH_FIELD[row] : null;
      if (!def) continue;
      const mass = (def.massMin + def.massMax) / 2;
      if (mass > limit) continue;                                    // the Meteor 2 row (1,800-2,700 kg) is over her catch limit
      const d = { type: def.types[0], mass, owner: def.owner ? { ...def.owner } : null, areaM2: def.areaM2, name: def.name, fieldId: f.id, fieldRow: row };
      const value = pieceValue(d, ctx);
      if (!isCandidate(value)) continue;
      const posM = { x: (def.fwdMinM + def.fwdMaxM) / 2, y: def.radM || 0, z: def.latM || 0 };
      stops.push(pieceStop(`${f.id}#${row}`, d, value, { altKm: f.altKm, fieldId: f.id, fieldRow: row, posM, known: true, pushKm: HIGH_ROW_PUSH_KM[row] }));
    }
  }
  // (c) every other field: a transfer and 5 catches nobody knows
  for (const f of state.fields || []) {
    if (f.kind === 'high' || f.id === state.fieldId || !((f.remaining || []).length > 0)) continue;
    stops.push({ kind: 'field', id: f.id, altKm: f.altKm, unscanned: true });
  }
  // (d) the satellite, and the exits of every big piece (aboard now, or a candidate)
  for (const s of state.satellites || []) stops.push({ kind: 'sat', id: s.id, altKm: s.altKm, name: s.name });
  const held = [];
  for (const h of state.held || []) {
    const d = h.piece;
    if (!d || !isBig(d)) continue;
    const value = pieceValue(viewOf(d, h.fieldId, h.fieldRow), { ...ctx, kept: true });
    const stop = pieceStop(h.id, d, value, { altKm: state.altKm, fieldId: state.fieldId, fieldRow: h.fieldRow, posM: null, debrisId: h.debrisId ?? null });
    const massKg = Number.isFinite(d.mass) ? d.mass : 0;
    const entry = { id: h.id, massKg, stop };
    if (h.melting === true) {
      // marked for the furnaces already (BigPieces fate 'melt'): the route starts with it melting, not as a piece she may still push or hand over
      // (`d.mass` is what is left of it; the fee and the owner's share are for the whole piece, so the fee is scaled back up to the mass it was caught at)
      const whole = Number.isFinite(h.massAtCatchKg) && h.massAtCatchKg > massKg ? h.massAtCatchKg : massKg;
      entry.melting = { leftKg: massKg, wholeKg: whole, feeCr: massKg > 0 ? (value.feeCr || 0) * whole / massKg : (value.feeCr || 0) };
      held.push(entry);
      continue;
    }
    held.push(entry);
    stops.push(...disposalStops(stop));
  }
  for (const s of stops.slice()) if (s.kind === 'piece') stops.push(...disposalStops(s));
  // (e) the station (route-1101 J5 Task 12): while the station's part job is open, a trip to the station field is a stop of its own; the walker pays it 10,000 cr when the
  // part is aboard (at planning, or kept by an earlier melt stop of the posted piece) and she arrives lined up by the route's own days. Not offered where she is already.
  const partJob = (state.jobPostings || []).find((j) => j && j.kind === 'part' && !j.done && !j.missed);
  if (partJob) {
    const sid = state.stationFieldId;
    const sf = sid ? (state.fields || []).find((f) => f.id === sid) : null;
    if (sf && sid !== state.fieldId) stops.push({ kind: 'station', id: `station:${sid}`, fieldId: sid, altKm: sf.altKm, payCr: Math.max(0, partJob.payCr || 0), name: 'station' });
    for (const s of stops) if (s.kind === 'piece' && s.big && isJobPiece(partJob, { fieldId: s.fieldId, fieldRow: s.fieldRow })) s.partJob = true;
    // a held piece is matched by the field it was caught in (the held entry's own keys), not the field she is in now (`h.stop.fieldId` is that one)
    for (const h of held) {
      const src = (state.held || []).find((x) => x && x.id === h.id);
      if (src && isJobPiece(partJob, { fieldId: src.fieldId, fieldRow: src.fieldRow })) h.stop.partJob = true;
    }
  }
  // no free furnace (every tip busy or absent, GameFlowManager._freeTips): a melt would do nothing, so it is not offered
  return { stops: state.furnaces === 0 ? stops.filter((s) => s.kind !== 'melt') : stops, held };
}

/** The `RouteCost` state of a panel state. */
export function routeState(state, held = []) {
  const partJob = (state.jobPostings || []).find((j) => j && j.kind === 'part' && !j.done && !j.missed);
  return {
    dryMassKg: state.dryMassKg, gasKg: state.gasKg, carriedKg: state.carriedKg || 0, altKm: state.altKm, fieldId: state.fieldId ?? null,
    posM: { x: 0, y: 0, z: 0 }, thrustN: state.thrustN, ispS: state.ispS, areaM2: state.areaM2, cos: 1, stepS: PANEL_STEP_S,
    catchesLeft: state.catchesLeft || 0, maxMoves: Number.isFinite(state.maxMoves) ? state.maxMoves : MAX_MOVES,
    holdSlots: state.holdSlots, holdRoomKg: state.holdRoomKg, held,
    ...(Number.isFinite(state.furnaces) ? { furnaces: state.furnaces } : {}),     // the free radiator tips (`_freeTips`); absent = 4
    // the node gap and the part aboard (J5 Task 12): `gapDeg`/`incDeg` let the walker move the gap by the route's days; `partCr` is the part job's pay
    ...(Number.isFinite(state.gapDeg) && Number.isFinite(state.incDeg) ? { gapDeg: state.gapDeg, incDeg: state.incDeg } : {}),
    ...(partJob ? { partAboard: state.partAboard > 0 || !!(partJob.aboard && partJob.aboard.kg > 0), partCr: Math.max(0, partJob.payCr || 0) } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * A route in a few short words, from its steps: where she is, then the moves. "here: 2 pieces → 750 km: SL-14 stage → push". A mission
 * that is filled with pieces nobody priced says "+5 unscanned" only where nothing priced was caught (an ordinary field).
 * @param {object[]} steps `walkRoute(...).steps`
 * @returns {string}
 */
export function stopsText(steps) {
  const segs = [];
  const open = (where, bare = false) => { const s = { where, big: [], other: 0, fill: 0, melt: [], bare, part: false }; segs.push(s); return s; };
  let cur = open('here');
  for (const st of steps || []) {
    if (st.kind === 'catch') { if (st.big) cur.big.push(st.label || 'piece'); else cur.other++; }
    else if (st.kind === 'fill') cur.fill += st.n;
    else if (st.kind === 'melt') { cur.melt.push(st.label || 'piece'); }
    else if (st.kind === 'dispose' && st.fate === 'station') cur.part = true;      // the station takes the kept part (J5 Task 12)
    else if (st.kind === 'move') {
      if (st.what === 'sat') cur = open('satellite', true);
      else if (st.what === 'push') cur = open('push', true);
      else cur = open(`${Math.round(st.altKm)} km`);
    }
  }
  const words = segs.filter((s, i) => !(i === 0 && !s.big.length && !s.other && !s.fill && segs.length > 1)).map((s) => {
    const parts = [];
    if (s.big.length) parts.push(s.big.slice(0, 2).join(' + ') + (s.big.length > 2 ? ` +${s.big.length - 2}` : ''));
    if (s.other) parts.push(`${s.other} ${s.other === 1 ? 'piece' : 'pieces'}`);
    if (!s.big.length && !s.other && s.fill && !s.bare) parts.push(`+${s.fill} unscanned`);
    if (s.melt.length) parts.push(`melt ${s.melt.join(' + ')}`);
    if (s.part) parts.push('part handed over');
    return parts.length ? `${s.where}: ${parts.join(', ')}` : s.where;
  });
  return words.length && !(words.length === 1 && words[0] === 'here') ? words.join(' \u2192 ') : 'stay here';
}

/** The numbers of a route, as the list draws them: "41,200 cr · 6.2 kg left · 31 days". */
export function numbersText(route) {
  const t = route.totals;
  return `${creditsText(t.valueCr)} cr \u00b7 ${kgText(Math.max(0, t.gasLeftKg))} kg left \u00b7 ${daysText(t.days)}`;
}

/**
 * The where-next row a route begins with: Stay while it catches here first, else its first move (a field, the satellite, a push of a
 * piece she holds). Null when it cannot begin with a row (a push of a piece she does not hold yet).
 */
export function firstRowId(steps, held = []) {
  for (const st of steps || []) {
    if (st.kind === 'melt') continue;                                // marking a fate is no pick
    if (st.kind === 'stay' || st.kind === 'catch' || st.kind === 'fill') return STAY_ID;
    if (st.kind === 'move') {
      if (st.what === 'push') { const h = held.find((x) => x.id === st.id); return h && h.debrisId != null ? `${PUSH_PREFIX}${h.debrisId}` : null; }
      return st.id ?? null;
    }
  }
  return STAY_ID;
}

// ---------------------------------------------------------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------------------------------------------------------

const _nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
let _memo = null;

function stateKey(state, sortBy, maxStops) {
  const r = (x, d = 1000) => (Number.isFinite(x) ? Math.round(x * d) : x);
  return JSON.stringify([
    sortBy, maxStops, r(state.dryMassKg), r(state.gasKg), r(state.carriedKg), r(state.altKm), state.fieldId, state.catchesLeft, state.holdSlots, r(state.holdRoomKg, 1), state.furnaces,
    (state.pieces || []).map((e) => [e.id, e.discovered === true, !!e.hazard, !!e.captured, e.piece && r(e.piece.mass, 10), e.posM ? [r(e.posM.x, 0.1), r(e.posM.y, 0.1), r(e.posM.z, 0.1)] : null]),
    (state.fields || []).map((f) => [f.id, (f.remaining || []).join(',')]),
    (state.held || []).map((h) => [h.id, h.piece && r(h.piece.mass, 10), h.melting === true]),
    (state.jobPostings || []).map((j) => [j.kind, j.fieldId, j.row, j.done, j.missed, j.payCr, j.aboard ? j.aboard.kg : 0]),
    r(state.captureCreditsEarned, 1),
    r(state.gapDeg, 100), r(state.incDeg, 100), state.stationFieldId ?? null, r(state.partAboard, 10),      // J5 Task 12: the station stop
  ]);
}

/**
 * The Routes section: the best `TOP_ROUTES` routes for a state, priced and searched by RouteCost. Cached on the state's own numbers
 * (her mass, gas, the pieces found, the fields' rows, the postings), so asking again with nothing changed costs nothing: the list calls
 * it when it opens and when its inputs change, never per frame.
 *
 * `state` (what `GameFlowManager.routePanelState()` returns): `dryMassKg`, `gasKg`, `carriedKg`, `altKm`, `fieldId`, `thrustN`, `ispS`,
 * `areaM2` (the RouteCost state); `catchesLeft` (catches that finish the mission she is in; 0 = she is between missions: the list is open
 * for a pick); `pieces` ([{id, fieldId, fieldRow, discovered, hazard, captured, posM, piece}], `posM` metres from her now); `fields`
 * ([{id, altKm, kind, remaining}]); `satellites` ([{id, altKm, name}]); `held` ([{id, debrisId, piece, fieldId, fieldRow}]); `holdSlots`,
 * `holdRoomKg`; `jobPostings` (JobsBoard shape plus `kind`, `payCr`); `captureCreditsEarned`.
 * @param {object} state @param {{sortBy?: string, maxStops?: number, k?: number, force?: boolean}} [opts]
 * @returns {{routes: Array<{ids: string[], text: string, numbers: string, line: string, firstRowId: (string|null), totals: object, steps: object[], stops: object[]}>,
 *   approximate: boolean, sortBy: string, owed: boolean, ms: number, nodes: number, cached: boolean}}
 */
export function plan(state, opts = {}) {
  const sortBy = SORTS.includes(opts.sortBy) ? opts.sortBy : 'credits';
  const maxStops = opts.maxStops > 0 ? opts.maxStops : 8;
  const key = stateKey(state, sortBy, maxStops);
  if (_memo && _memo.key === key && !opts.force) return { ..._memo.result, cached: true };
  const t0 = _nowMs();
  const { stops, held } = candidates(state);
  const rs = routeState(state, held);
  const res = bestRoutes(rs, stops, { k: opts.k > 0 ? opts.k : TOP_ROUTES, sortBy, maxStops, beamWidth: opts.beamWidth > 0 ? opts.beamWidth : PANEL_BEAM });
  const heldList = (state.held || []).map((h) => ({ id: h.id, debrisId: h.debrisId ?? null }));
  const names = new Map(stops.filter((s) => s.kind === 'piece').map((s) => [s.id, s.name]));
  for (const h of held) names.set(h.id, h.stop.name);
  const routes = res.routes.map((r) => {
    const steps = r.steps.map((s) => (s.kind === 'catch' || s.kind === 'melt' ? { ...s, label: names.get(s.id) } : s));
    const text = stopsText(steps);
    const numbers = numbersText(r);
    return { ids: r.ids, text, numbers, line: `${text} \u00b7 ${numbers}`, firstRowId: firstRowId(steps, heldList), totals: r.totals, steps, stops: r.stops };
  });
  const result = { routes, approximate: res.approximate, sortBy, owed: !(state.catchesLeft > 0), ms: _nowMs() - t0, nodes: res.nodes, searchMs: res.searchMs, repriceMs: res.repriceMs, cached: false };
  _memo = { key, result };
  return result;
}

/** Forget the cached plan (tests). */
export function clearPlanCache() { _memo = null; }

// ---------------------------------------------------------------------------------------------------------------------------
// The live frame
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * Where a piece is in her own frame, metres: x along her track, y up from Earth, z across (the frame `RouteCost` measures approach
 * distances in; scripts/route-report.mjs `shipFrame`). Pure vector arithmetic over plain `{x, y, z}` scene positions.
 * @param {{x: number, y: number, z: number}} shipPos @param {{x: number, y: number, z: number}} shipVel her velocity (any scale: only its direction counts)
 * @param {{x: number, y: number, z: number}} piecePos @param {number} metreScene scene units per metre
 */
export function shipFramePos(shipPos, shipVel, piecePos, metreScene) {
  const unit = (v) => { const n = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / n, y: v.y / n, z: v.z / n }; };
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const fwd = unit(shipVel);
  const up = unit(shipPos);
  const across = unit({ x: fwd.y * up.z - fwd.z * up.y, y: fwd.z * up.x - fwd.x * up.z, z: fwd.x * up.y - fwd.y * up.x });
  const rel = { x: (piecePos.x - shipPos.x) / metreScene, y: (piecePos.y - shipPos.y) / metreScene, z: (piecePos.z - shipPos.z) / metreScene };
  return { x: dot(rel, fwd), y: dot(rel, up), z: dot(rel, across) };
}
