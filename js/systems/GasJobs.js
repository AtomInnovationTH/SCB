/**
 * GasJobs — taking the leftover gas from a caught dead craft with a BOUGHT tool (DECISIONS §99 row 3, DECISIONS §106; Reality 13).
 * Pure math, no game state: which tool fits a piece, the price, the step-by-step plan of a job (time and watts) and a job that
 * advances by game seconds against an energy callback. `GameFlowManager` owns the queue, the battery and the lines.
 *
 * The fit never uses `Math.random` (it would shift every seeded field): `gasAccess(id)` hashes the piece id (FNV-1a, 32 bit).
 * Every number is read from `Constants.GAS_TOOLS` (research docs/research/2026-11-gas-tools.md §2-5).
 */
import { Constants } from '../core/Constants.js';

/** @typedef {'port'|'line'|'tank'} GasAccess  a fuel port, a reachable fuel line, or only a sealed tank */
/** @typedef {{name:string, s:number, watts:number}} JobPhase  game seconds and watts of one step */
/** @typedef {{phases: JobPhase[], totalS: number, wh: number, transferIdx: number}} JobPlan */

const G = () => Constants.GAS_TOOLS;

/**
 * FNV-1a 32-bit hash of `String(id)` as a fraction in [0, 1).
 * @param {string|number} id
 * @returns {number}
 */
export function idUnit(id) {
  const s = String(id);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0) / 4294967296;
}

/**
 * How a piece's gas can be reached, from its id alone (about 5 % port, 35 % line, 60 % sealed tank).
 * @param {string|number} id
 * @returns {GasAccess}
 */
export function gasAccess(id) {
  const u = idUnit(id);
  if (u < G().ACCESS.port) return 'port';
  if (u < G().ACCESS.line) return 'line';
  return 'tank';
}

/**
 * The plain words a target card and the dossier add to a piece's gas line (DECISIONS §106): how its gas can be reached.
 * @param {GasAccess} access
 * @returns {string} ` · fuel port` / ` · fuel line` / ` · sealed tank`; '' for anything else
 */
export function accessWords(access) {
  return access === 'port' ? ' \u00B7 fuel port' : access === 'line' ? ' \u00B7 fuel line' : access === 'tank' ? ' \u00B7 sealed tank' : '';
}

/** @param {string} toolId @returns {object|null} the `Constants.GAS_TOOLS.TOOLS` row */
export function toolDef(toolId) {
  return G().TOOLS[toolId] || null;
}

/** @param {string} toolId @param {GasAccess} access @returns {boolean} does this tool fit a piece with this access */
export function toolFits(toolId, access) {
  const t = toolDef(toolId);
  return !!t && t.fits.includes(access);
}

/**
 * The tool the game uses: the fastest owned one that fits (plug, then tap, then drill).
 * @param {GasAccess} access
 * @param {Iterable<string>} ownedIds
 * @returns {string|null} a tool id, or null when none owned fits
 */
export function bestTool(access, ownedIds) {
  const owned = new Set(ownedIds || []);
  for (const id of G().ORDER) {
    if (owned.has(id) && toolFits(id, access)) return id;
  }
  return null;
}

/** The shop price of a tool, credits: (mass x launch price per kg / USD per credit + premium), rounded to 10 cr. */
export function gasToolPriceCr(toolId) {
  const t = toolDef(toolId);
  if (!t) return 0;
  return Math.round((t.kg * Constants.LAUNCH_USD_PER_KG / Constants.USD_PER_CREDIT + t.premiumCr) / 10) * 10;
}

/**
 * The steps of a job moving `kg` with one tool.
 * @param {string} toolId
 * @param {number} kg  the kg the transfer phase moves (gas plus hydrazine)
 * @returns {JobPlan} `wh` = the whole job's energy; `transferIdx` = index of the transfer phase in `phases`
 */
export function jobPlan(toolId, kg) {
  const t = toolDef(toolId);
  const k = Math.max(0, Number.isFinite(kg) ? kg : 0);
  const phases = [];
  let transferIdx = -1;
  if (t) {
    for (const p of t.phases) {
      if (p.ratePerMin) transferIdx = phases.length;
      const s = p.ratePerMin ? (k / p.ratePerMin) * 60 : p.min * 60;
      phases.push({ name: p.name, s, watts: p.w });
    }
  }
  const totalS = phases.reduce((a, p) => a + p.s, 0);
  const wh = phases.reduce((a, p) => a + p.watts * p.s / 3600, 0);
  return { phases, totalS, wh, transferIdx };
}

/**
 * A running job.
 * @param {string} toolId
 * @param {number} kg  the kg it moves
 * @returns {{toolId:string, kg:number, plan:JobPlan, elapsedS:number, done:boolean}}
 */
export function createJob(toolId, kg) {
  return { toolId, kg, plan: jobPlan(toolId, kg), elapsedS: 0, done: false };
}

/**
 * The kg moved so far = kg x the finished share of the transfer phase (0 before it starts, all of it after).
 * @param {{kg:number, plan:JobPlan, elapsedS:number}} job
 * @returns {number}
 */
export function jobMovedKg(job) {
  const { phases, transferIdx } = job.plan;
  if (transferIdx < 0) return 0;
  let start = 0;
  for (let i = 0; i < transferIdx; i++) start += phases[i].s;
  const len = phases[transferIdx].s;
  if (!(len > 0)) return job.elapsedS >= start ? job.kg : 0;
  const share = Math.min(1, Math.max(0, (job.elapsedS - start) / len));
  return job.kg * share;
}

/**
 * Advance a job by `gameDt` game seconds. The step's energy (every phase it crosses at its own watts) is asked for in ONE call of
 * `drawWh(wh)`, which answers the Wh it gave. If it gave less than asked the job does NOT advance (`paused`; the Wh given are
 * spent: under a hundredth of a Wh at a frame). A job never runs past its end: time left over is dropped.
 * @param {{plan:JobPlan, elapsedS:number, done:boolean, kg:number}} job
 * @param {number} gameDt  game seconds
 * @param {function(number):number} drawWh  asks for Wh, answers the Wh given
 * @returns {{done:boolean, movedKg:number, paused:boolean, usedWh:number}}
 */
export function advanceJob(job, gameDt, drawWh) {
  if (job.done) return { done: true, movedKg: jobMovedKg(job), paused: false, usedWh: 0 };
  const dt = Math.min(Math.max(0, Number.isFinite(gameDt) ? gameDt : 0), Math.max(0, job.plan.totalS - job.elapsedS));
  if (!(dt > 0)) {
    if (job.plan.totalS <= job.elapsedS) job.done = true;
    return { done: job.done, movedKg: jobMovedKg(job), paused: false, usedWh: 0 };
  }
  const wh = energyBetween(job.plan, job.elapsedS, job.elapsedS + dt);
  const given = wh > 0 ? Math.max(0, drawWh(wh)) : 0;
  if (given < wh * (1 - 1e-9)) {
    return { done: false, movedKg: jobMovedKg(job), paused: true, usedWh: given };
  }
  job.elapsedS += dt;
  if (job.elapsedS >= job.plan.totalS - 1e-9) { job.elapsedS = job.plan.totalS; job.done = true; }
  return { done: job.done, movedKg: jobMovedKg(job), paused: false, usedWh: given };
}

/** Energy, Wh, a plan uses between two job times (game s). */
function energyBetween(plan, fromS, toS) {
  let t = 0;
  let wh = 0;
  for (const p of plan.phases) {
    const a = Math.max(fromS, t);
    const b = Math.min(toS, t + p.s);
    if (b > a) wh += p.watts * (b - a) / 3600;
    t += p.s;
  }
  return wh;
}
