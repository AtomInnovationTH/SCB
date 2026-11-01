/**
 * RouteCost - what a ROUTE costs her: any order of visits (fields, pieces, the resupply satellite), priced by her changing
 * mass and the gas still aboard, plus a search for the best orders (plan route-1101, lane R1; owner 2026-11-01: she chooses
 * a route through debris "by mass changes and remaining delta-v", for any piece with credit or salvage value).
 *
 * PURE except two counters and the trip cache: numbers in, numbers out. It imports no system that has state (FieldRegistry
 * imports THIS file, never the other way round; ScoringSystem is passed in by the caller, `pieceValue`).
 *
 * LIVE in the game today: `transferLeg` only (FieldRegistry.planTo prices every where-next field row through it). The other
 * legs, the walk and the search serve scripts/route-report.mjs, js/test/test-RouteCost.js and the wave-2 route panel.
 *
 * The legs:
 *   transferLeg   field to field, the real low-thrust profile (TripProfile.tripProfile) at her live mass; exact.
 *   planeLeg      a change of orbit plane (tilt and node, `planeAngle`), low thrust: Edelbaum, pi/2 x the impulsive price for a
 *                 small angle. Every field shares her plane today, so it answers 0 there.
 *   approachLeg   the autopilot's close-in flight to a piece, billed gas by distance and her mass (a MEASURED table below).
 *   daughterLeg   a daughter's fetch, billed from her own tank the way the game bills it (never from the mother's).
 *   pieceValue    what a piece is worth, from the game's own pay code (never copied prices).
 * `walkRoute` runs a list of stops through them; `bestRoutes` searches the orders.
 *
 * Mass: her mass on a leg is `dryMassKg + carriedKg + gasKg` (everything that is not engine gas, plus what she carries, plus the
 * engine gas aboard). A kept catch adds its mass to every later leg (the catch joins her mass, ArmManager.getCargoMassKg ->
 * getMassBudget); a hand-over at the satellite leaves it there (DECISIONS §49 row 2); a let-go bag adds nothing (§49 row 8).
 * Feasible means every leg's gas fits what is aboard, the rule `FieldRegistry.planTo` calls `enough`; no reserve rule exists.
 * @module systems/RouteCost
 */
import { Constants } from '../core/Constants.js';
import { tripProfile } from './TripProfile.js';
import { planeAngle, planeChangeDeltaV } from '../entities/OrbitalMechanics.js';
import { pieceValues } from './BigPieceValues.js';

const SECONDS_PER_DAY = 86400;

// ---------------------------------------------------------------------------------------------------------------------------
// The trip cache (moved here unchanged from FieldRegistry.js, route-1101 R1) and the transfer leg
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * `tripProfile` is pure but costs up to ~10 ms for a 40-day trip and builds ~1200 sample objects; the where-next list
 * plans every field (and `defaultNext` plans them all again), and the four high fields are 25-46 day trips. So the
 * profile is remembered per full input set (every number the function reads, the constants included); callers only
 * read it. Her mass and gas change as she burns, so a changed state is a different key, never a stale answer.
 */
const PROFILE_CACHE_MAX = 64;
const _profileCache = new Map();
export function cachedTripProfile(args) {
  const C = Constants;
  const key = [args.fromKm, args.toKm, args.massKg, args.thrustN, args.ispS, args.areaM2, args.cos, args.stepS,
    C.TRIP.PROFILE_STEP_S, C.TRIP.PROFILE_MAX_DAYS, C.EARTH_RADIUS_KM, C.MU_EARTH, C.G0].join('|');
  let hit = _profileCache.get(key);
  if (hit === undefined) {
    hit = tripProfile(args);
    if (_profileCache.size >= PROFILE_CACHE_MAX) _profileCache.delete(_profileCache.keys().next().value);
    _profileCache.set(key, hit);
  }
  return hit;
}

let _transferCalls = 0;
/** How many times `transferLeg` has been called (a test seam: proves a caller prices through it). */
export function transferLegCalls() { return _transferCalls; }
/** Zero the call counter (tests). */
export function resetTransferLegCalls() { _transferCalls = 0; }

/**
 * The transfer between two heights, flown with the real thruster at her live mass: `tripProfile` through the cache.
 * @param {{fromKm: number, toKm: number, massKg: number, thrustN: number, ispS: number, areaM2?: number, cos?: number}} a
 *   `ispS` is the Isp the tank is billed at (the gas's, divided by the gas multiplier c); `cos` the share of the push that goes
 *   the way she wants (1 = she can turn)
 * @returns {{ok: boolean, gasKg: number, dvMps: number, days: number, profile: object}}
 */
export function transferLeg(a) {
  _transferCalls++;
  const profile = cachedTripProfile(a);
  return { ok: profile.ok, gasKg: profile.gasKg, dvMps: profile.dvMps, days: profile.days, profile };
}

/**
 * A climb that cannot be flown inside `TRIP.PROFILE_MAX_DAYS` whatever the air does: the burn needs at least the circular-speed
 * difference (`v1 - v2`) in delta-v, so at her thrust it takes at least `gas x ve / thrust` seconds. The real profile would end
 * 'days' after stepping 400 days (seconds of CPU for a heavy hold); this answers at once. Descents are never cut (the air helps).
 * @param {{fromKm: number, toKm: number, massKg: number, thrustN: number, ispS: number}} a @returns {boolean}
 */
export function climbTooLong(a) {
  if (!(a.toKm > a.fromKm)) return false;
  const C = Constants;
  const v1 = Math.sqrt(C.MU_EARTH / (C.EARTH_RADIUS_KM + a.fromKm)) * 1000;
  const v2 = Math.sqrt(C.MU_EARTH / (C.EARTH_RADIUS_KM + a.toKm)) * 1000;
  const ve = a.ispS * C.G0;
  const gasKg = a.massKg * (1 - Math.exp(-(v1 - v2) / ve));
  return gasKg * ve / a.thrustN / SECONDS_PER_DAY > C.TRIP.PROFILE_MAX_DAYS;
}

// A search needs millions of legs and her mass differs on almost every one. But the trip's delta-v does not depend on her mass:
// the profile's climb rate is (push - air drag) / m, both terms over the same mass, and the engine burns the same thrust
// whatever her mass, so da/dt = k / m(t) and the climb needs the same ln(m0 / m1), i.e. the same delta-v, at any mass (measured
// 2026-11-01, 7 trips x 4 masses 250-800 kg: dv equal to 3 decimals). So the search prices a transfer from ONE profile per pair of
// heights (stepped at 600 s: same dv as the 60 s step, to 3 decimals, 10x cheaper), then gas = m (1 - exp(-dv / ve)) and days =
// gas x ve / thrust (the mass flow is constant). `bestRoutes` re-prices every route it returns with the real profile
// (`walkRoute`, exact); js/test/test-RouteCost.js holds the fast leg within 0.5 % of `transferLeg` at other masses.
const FAST_STEP_S = 600;
const FAST_REF_KG = 300;
const _fastCache = new Map();
function referenceDv(a) {
  const key = [a.fromKm, a.toKm, a.thrustN, a.ispS, a.areaM2, a.cos].join('|');
  let v = _fastCache.get(key);
  if (v === undefined) {
    const p = tripProfile({ fromKm: a.fromKm, toKm: a.toKm, massKg: FAST_REF_KG, thrustN: a.thrustN, ispS: a.ispS, areaM2: a.areaM2, cos: a.cos, stepS: FAST_STEP_S });
    v = p.ok ? p.dvMps : -1;
    if (_fastCache.size > 20000) _fastCache.clear();
    _fastCache.set(key, v);
  }
  return v;
}
/** `transferLeg`'s fast twin (see above): the same answer to within about 0.1 %, far cheaper in a search. */
export function transferLegFast(a) {
  if (a.fromKm === a.toKm) return { ok: true, gasKg: 0, dvMps: 0, days: 0 };
  const dv = referenceDv(a);
  if (dv < 0) return { ok: false, gasKg: 0, dvMps: 0, days: 0 };
  const ve = a.ispS * Constants.G0;
  const gasKg = a.massKg * (1 - Math.exp(-dv / ve));
  return { ok: true, gasKg, dvMps: dv, days: gasKg * ve / a.thrustN / SECONDS_PER_DAY };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Plane leg
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * Changing orbit plane (tilt and node together, `planeAngle`) at low thrust: Edelbaum's result for a plane change at constant
 * circular speed, `2 v sin(pi theta / 4)`, which is pi/2 x the impulsive price for a small angle (research note
 * 2026-11-routes-passes-laser.md 1a: 7.83 deg at 400 km is 1,048 m/s impulsive, 1,645 m/s low thrust). The speed is the circular
 * speed at `toOrbit`'s height. Today's fields all share her tilt and node: 0.
 * @param {{fromOrbit: {altKm: number, inclination: number, raan?: number}, toOrbit: {altKm: number, inclination: number, raan?: number},
 *   massKg: number, thrustN: number, ispS: number, gasAboardKg?: number}} a   angles in radians; `gasAboardKg` defaults to a full
 *   tank of the default gas (`feasible` = the gas fits)
 * @returns {{gasKg: number, dvMps: number, days: number, feasible: boolean, angleRad: number}}
 */
export function planeLeg(a) {
  const C = Constants;
  const angleRad = planeAngle(a.fromOrbit, a.toOrbit);
  const aboard = Number.isFinite(a.gasAboardKg) ? a.gasAboardKg : C.FUELS[C.DEFAULT_FUEL].kgFull;
  if (!(angleRad > 1e-12)) return { gasKg: 0, dvMps: 0, days: 0, feasible: true, angleRad: 0 };
  const vMps = Math.sqrt(C.MU_EARTH / (C.EARTH_RADIUS_KM + a.toOrbit.altKm)) * 1000;
  const dvMps = planeChangeDeltaV(vMps, (Math.PI / 2) * angleRad);
  const ve = a.ispS * C.G0;
  const gasKg = a.massKg * (1 - Math.exp(-dvMps / ve));
  return { gasKg, dvMps, days: gasKg * ve / a.thrustN / SECONDS_PER_DAY, feasible: gasKg <= aboard + 1e-9, angleRad };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Approach leg: a measured table, and the physical minimum beside it
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * The autopilot's approach to a piece: argon billed and game seconds taken, MEASURED 2026-11-01 by
 * `measureApproach` in js/test/_routeRig.js (run `node scripts/route-report.mjs --measure-approach` to redo it; the test
 * re-measures the 516 m row live). A piece placed `distanceM` from her at the arrival frame (ahead 87 %, to the side 49 %, the
 * geometry of training 3's movers: 450 m ahead and 250 m aside is 516 m), no tumble, argon at 12.48 kg, the autopilot engaged
 * through TargetSelector.setTarget + AutopilotSystem.engage (the way test-TrainingApproach.js flies it). Two masses: her start
 * mass (about 289 kg with the tank 60 % full) and the same plus 300 kg carried (a held catch on a daughter's rack, the way
 * ArmManager.getCargoMassKg counts one: `heldCatches[].mass`, ArmManager.js:4432-4440).
 * Independent check: training 3's 0.69 kg at 516 m (HANDOFF.md:40, test-TrainingApproach.js header; a drifting, tumbling
 * mover) against 0.673 kg here (a still piece): 2.5 % lower.
 * Linear in mass up to 2,488.58 kg, MEASURED 2026-11-01 at 516 m with 1,200 / 1,700 / 2,200 kg held (`massChecks`: 3.474, 4.641, 5.808 kg;
 * 0.673 kg x mass / 288.58 gives 3.47, 4.64, 5.80). With 3,000 kg held (3,288.58 kg) the autopilot did not arrive in 300 real seconds, so
 * `approachLeg` answers not-ok above `maxMassKg` (2,488.58 kg): a mass nobody measured is not priced.
 * Rows: `[distanceM, gasKg at the light mass, seconds at the light mass, gasKg at the heavy mass, seconds at the heavy mass]`.
 * Distance: measured out to 3,000 m (the fields spread pieces to 2,300 m, `FIELDS` `fwdMaxM`; 3,000 m is beyond them); `approachLeg`
 * answers not-ok farther than the last row (`maxDistanceM`) instead of extending the last slope: a distance nobody flew is not priced.
 */
export const APPROACH_TABLE = {
  measured: '2026-11-01, js/test/_routeRig.js measureApproach (run by scripts/route-report.mjs --measure-approach), seed 20261101',
  lightKg: 288.58,
  heavyKg: 588.58,
  maxMassKg: 2488.58,
  maxDistanceM: 3000,
  /** [her mass kg, gas kg at 516 m]: the linearity check above. */
  massChecks: [[1488.58, 3.474], [1988.58, 4.641], [2488.58, 5.808]],
  rows: [
    [50, 0.182, 14, 0.372, 14],
    [150, 0.304, 23, 0.620, 23],
    [300, 0.486, 38, 0.992, 38],
    [516, 0.673, 53, 1.374, 53],
    [1000, 0.967, 76, 1.973, 76],
    [2000, 1.393, 110, 2.840, 110],
    [3000, 1.718, 136, 3.504, 136],
  ],
};

const lerp = (x0, y0, x1, y1, x) => (x1 === x0 ? y0 : y0 + (y1 - y0) * ((x - x0) / (x1 - x0)));

/** Interpolate a table column over distance: proportional below the first row; none beyond the last row (the caller refuses first). */
function tableAtDistance(rows, col, d) {
  if (d <= 0) return 0;
  if (d <= rows[0][0]) return rows[0][col] * (d / rows[0][0]);
  for (let i = 1; i < rows.length; i++) {
    if (d <= rows[i][0]) return lerp(rows[i - 1][0], rows[i - 1][col], rows[i][0], rows[i][col], d);
  }
  return rows[rows.length - 1][col];
}

/**
 * What the autopilot bills for closing `distanceM` to a piece at her mass `massKg`, from `APPROACH_TABLE` (linear in distance between
 * the measured rows and in mass, never below 0); not ok above the highest mass measured to arrive, and not ok farther than the
 * last measured distance (the numbers it returns then are the last row's, a floor, not a price).
 * @param {{distanceM: number, massKg: number}} a
 * @returns {{ok: boolean, gasKg: number, seconds: number, days: number}}
 */
export function approachLeg(a) {
  const T = APPROACH_TABLE;
  const d = Math.max(0, Number(a.distanceM) || 0);
  const gLight = tableAtDistance(T.rows, 1, d);
  const gHeavy = tableAtDistance(T.rows, 3, d);
  const sLight = tableAtDistance(T.rows, 2, d);
  const sHeavy = tableAtDistance(T.rows, 4, d);
  const gasKg = Math.max(0, lerp(T.lightKg, gLight, T.heavyKg, gHeavy, a.massKg));
  const seconds = Math.max(0, lerp(T.lightKg, sLight, T.heavyKg, sHeavy, a.massKg));
  return { ok: a.massKg <= T.maxMassKg + 1e-9 && d <= T.maxDistanceM + 1e-9, gasKg, seconds, days: seconds / SECONDS_PER_DAY };
}

/**
 * The physical minimum for the same close-in flight: two burns (leave, then stop) that carry a chaser lagging `gapM` along the
 * SAME circular orbit onto the target after `orbits` orbits, the Clohessy-Wiltshire closed form in the target's frame (x radial,
 * y along the track):  r(t) = Phi_rr r0 + Phi_rv v0 = 0 gives the first burn v0; the second burn is the relative speed on
 * arrival. At a whole number of orbits the matrix is singular (a whole-orbit drift needs only the period change), so a
 * whole number is nudged by 1e-4 of an orbit, as the Lambert note does (docs/research/2026-10-adr-lambert.md section 4).
 * For one orbit it reduces to n x gap / (3 pi) in total (the period change that drifts `gap` in one orbit).
 * @param {{gapM: number, altKm: number, orbits?: number}} a
 * @returns {{dvMps: number, burn1Mps: number, burn2Mps: number, seconds: number}}
 */
export function physicalApproachDv(a) {
  const C = Constants;
  const n = Math.sqrt(C.MU_EARTH / Math.pow(C.EARTH_RADIUS_KM + a.altKm, 3));     // rad/s
  let orbits = a.orbits > 0 ? a.orbits : 1;
  if (Math.abs(orbits - Math.round(orbits)) < 1e-9) orbits += 1e-4;
  const t = orbits * 2 * Math.PI / n;
  const c = Math.cos(n * t);
  const s = Math.sin(n * t);
  // the chaser lags: its along-track position is -gap; it must close up, so it starts at y0 = -gap
  const x0 = 0;
  const y0 = -a.gapM / 1000;                                                        // km
  const rrx = 4 - 3 * c;
  const rry = 6 * (s - n * t);
  const rvxx = s / n, rvxy = 2 * (1 - c) / n, rvyx = 2 * (c - 1) / n, rvyy = (4 * s - 3 * n * t) / n;
  const bx = -(rrx * x0);                                                           // -(Phi_rr r0), x row
  const by = -(rry * x0 + y0);
  const det = rvxx * rvyy - rvxy * rvyx;
  const vx0 = (bx * rvyy - rvxy * by) / det;
  const vy0 = (rvxx * by - rvyx * bx) / det;
  const vxT = 3 * n * s * x0 + c * vx0 + 2 * s * vy0;
  const vyT = 6 * n * (c - 1) * x0 - 2 * s * vx0 + (4 * c - 3) * vy0;
  const burn1 = Math.hypot(vx0, vy0) * 1000;
  const burn2 = Math.hypot(vxT, vyT) * 1000;
  return { dvMps: burn1 + burn2, burn1Mps: burn1, burn2Mps: burn2, seconds: t };
}

/** Gas (kg) a burn of `dvMps` costs at mass `massKg` and Isp `ispS` (Tsiolkovsky). */
export function gasForDv(dvMps, massKg, ispS) {
  return massKg * (1 - Math.exp(-dvMps / (ispS * Constants.G0)));
}

// ---------------------------------------------------------------------------------------------------------------------------
// Daughter leg
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * A daughter's fetch of a piece `distanceM` away, priced from HER tank the way the game bills it (never the mother's gas): the
 * crossbow spring pays the launch (`CROSSBOW_LAUNCH_SPEED_DEFAULT`, 10 m/s: free), her FEEP pays the arrival kill, impulse-priced
 * against `ARM_TOTAL_DELTAV` (50 m/s = a whole tank; ArmUnit.js:9922-9930, Constants.js:4115); the reel home on the mother's winch is free of the
 * daughter's tank (the winch pays; only `ARM_RESERVE_FUEL` is held back, Constants.js:4100). Reach: the tether times
 * `ARM_DEPLOY_RANGE_FRACTION` (weaver 2,000 m x 0.8 = 1,600 m, spinner 500 m x 0.8 = 400 m). Time: out at the launch speed, home at
 * the cruise cap `REEL_PROFILE.V_CRUISE_MAX` (60 m/s, a light catch; a heavy one reels slower, so this is the lower bound). A model, not a measurement.
 * @param {{distanceM: number, armType?: 'weaver'|'spinner'}} a
 * @returns {{ok: boolean, reachM: number, fuelPct: number, dvMps: number, seconds: number, gasKgMother: number}}
 */
export function daughterLeg(a) {
  const C = Constants;
  const type = a.armType === 'spinner' ? 'spinner' : 'weaver';
  const tether = type === 'weaver' ? C.WEAVER_TETHER_LENGTH : C.SPINNER_TETHER_LENGTH;
  const reachM = tether * C.ARM_DEPLOY_RANGE_FRACTION;
  const d = Math.max(0, Number(a.distanceM) || 0);
  const v = C.CROSSBOW_LAUNCH_SPEED_DEFAULT;
  const dvMps = d > 0 ? v : 0;
  const reel = C.REEL_PROFILE.V_CRUISE_MAX;
  return {
    ok: d <= reachM, reachM,
    fuelPct: (dvMps / C.ARM_TOTAL_DELTAV) * 100,
    dvMps,
    seconds: d / v + (reel > 0 ? d / reel : 0),
    gasKgMother: 0,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Piece value
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * What the pay figures of `pieceValue` leave out, said in the result so no report calls them more than they are.
 * The game's `awardPoints` (ScoringSystem.js:121) also multiplies the credits by situational bonuses (manual capture, a
 * free-flying capture, salvage recovered, fuel-efficient: capped together at `SITUATIONAL_MULT_SOFT_CAP_CREDITS`); those depend on
 * how she flies the catch, so they are not priced. Metal sold in one lot of 50 kg or more gets the game's bulk bonus
 * (`computeSaleValue`); that depends on the whole hold, so it is not counted either.
 */
export const PAY_BASIS = 'base pay: bounty premium, capture taper and the market sale spread applied; no situational bonus, no bulk bonus';

/**
 * What a piece is worth, from the game's own pay code and constants (read at run time, none copied). It prices what `awardPoints`
 * pays for the credit (`PAY_BASIS` says what is left out), not the raw `calculateScore`.
 *   creditsCr  the catch credit, as the game pays it: `scoringSystem.calculateScore` (ScoringSystem.js:72) in a neutral context
 *              (its only state is the streak `currentStreak`, so it is called on an object that inherits from the instance with
 *              `currentStreak` 0; the instance itself is never touched; no nearby satellites, no fragments, the capture tier given by
 *              the caller), times `Constants.MARKET.BOUNTY_PREMIUMS[type]` (stage 0.8, fragment 1.2; ScoringSystem.js:146-149),
 *              then the late-run taper the way awardPoints applies it (ScoringSystem.js:244-250: `taperMultiplier`, then the
 *              ceiling clamp) at `ctx.captureCreditsEarned` (credits her catches have paid this run; default 0 = the start of a run)
 *   salvageCr  melted metal sold: each `piece.salvage.metals` entry's kg x the `Constants.METALS` market value of its metal, put
 *              through the game's `computeSaleValue` (the 0.85 sell spread; no bulk bonus, see `PAY_BASIS`). 0 for a let-go bag
 *              (`kept: false`): she is paid for removal and no salvage (DECISIONS §49 row 8)
 *   feeCr      the removal fee a big piece's owner pays: `BigPieceValues.pieceValues(piece).removalFeeCr`. The game pays it at a
 *              hand-over, a melt or a push (§49 row 2), not at the catch; `walkRoute` counts it where the piece is caught and reports it
 *              apart (`totals.feeCr`). It is not tapered (`awardDisposal`, ScoringSystem.js:336)
 *   kept       the catch stays aboard and joins her mass; false for a let-go bag (DECISIONS §49 row 8)
 * The callers pass the two pure pay helpers of ScoringSystem.js (importing that module here would build its singleton).
 * @param {{type: string, mass: number, tumbleRate?: number, owner?: object, salvage?: {metals?: Array<{subtype?: string, amount?: number}>}}} piece
 * @param {{scoringSystem: {calculateScore: Function}, captureTier: number, kept?: boolean, captureCreditsEarned?: number,
 *   taperMultiplier: Function, computeSaleValue: Function}} ctx `captureTier`: ScoringSystem's `CAPTURE_TIERS.CAPTURE`;
 *   `taperMultiplier` and `computeSaleValue` the exports of ScoringSystem.js
 * @returns {{creditsCr: number, salvageCr: number, feeCr: number, massKg: number, kept: boolean, valueCr: number, basis: string}}
 */
export function pieceValue(piece, ctx) {
  if (!ctx || !ctx.scoringSystem || typeof ctx.scoringSystem.calculateScore !== 'function') throw new Error('pieceValue: ctx.scoringSystem is required');
  if (typeof ctx.taperMultiplier !== 'function' || typeof ctx.computeSaleValue !== 'function') throw new Error('pieceValue: ctx.taperMultiplier and ctx.computeSaleValue (from ScoringSystem.js) are required');
  const C = Constants;
  const kept = ctx.kept !== false;
  const neutral = Object.create(ctx.scoringSystem);
  neutral.currentStreak = 0;
  const raw = ctx.scoringSystem.calculateScore.call(neutral, { debris: piece, method: 'arm', captureTier: ctx.captureTier, nearbyActiveSats: 0, fragmentsCreated: 0 });
  // awardPoints: premium by debris type, rounded; then the taper on the credits and the ceiling clamp
  const premiums = C.MARKET && C.MARKET.BOUNTY_PREMIUMS;
  const premium = premiums ? (premiums[piece.type || 'fragment'] || 1.0) : 1.0;
  const taperCfg = C.CAPTURE_CREDITS_TAPER;
  const catalogCr = C.SHOP.CATALOG_TOTAL_CR;
  const earned = Number.isFinite(ctx.captureCreditsEarned) && ctx.captureCreditsEarned > 0 ? ctx.captureCreditsEarned : 0;
  let creditsCr = Math.round(Math.round(raw * premium) * ctx.taperMultiplier(earned, catalogCr, taperCfg));
  creditsCr = Math.max(0, Math.min(creditsCr, Math.round(taperCfg.CEILING_X * catalogCr - earned)));
  const metals = piece.salvage && Array.isArray(piece.salvage.metals) ? piece.salvage.metals : [];
  let listedCr = 0;
  for (const m of metals) {
    const def = Object.values(C.METALS).find((x) => x.id === m.subtype);
    if (def && Number.isFinite(m.amount)) listedCr += m.amount * def.marketValue;
  }
  const salvageCr = kept ? ctx.computeSaleValue(listedCr, 0).saleValue : 0;
  const feeCr = pieceValues(piece).removalFeeCr;
  const massKg = Number.isFinite(piece.mass) ? piece.mass : 0;
  return { creditsCr, salvageCr, feeCr, massKg, kept, valueCr: creditsCr + salvageCr + feeCr, basis: PAY_BASIS };
}

/** A piece with no credit and no salvage (and no fee) is not a candidate. @param {{creditsCr: number, salvageCr: number, feeCr?: number}} v */
export function isCandidate(v) {
  return !!v && ((v.creditsCr || 0) + (v.salvageCr || 0) + (v.feeCr || 0)) > 0;
}

// ---------------------------------------------------------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * @typedef {object} RouteState
 * @property {number} dryMassKg   her mass without the engine gas and without the catches she carries
 * @property {number} gasKg       engine gas aboard
 * @property {number} carriedKg   catches aboard (their mass is on every later leg)
 * @property {number} altKm       her height now
 * @property {number} thrustN     `realThrustN(fuel)`
 * @property {number} ispS        the Isp the tank is billed at (the gas's, over c)
 * @property {number} [areaM2]    her drag area (`tripDragAreaM2`)
 * @property {number} [cos]       share of the push that goes the way she wants (default 1)
 * @property {string} [fieldId]   the field she is at, if any (pieces in it cost no transfer)
 * @property {{x: number, y: number, z: number}|null} [posM]  where she is inside that field, metres in the frame of her arrival (null = the arrival point)
 *
 * A stop is one of:
 *   {kind: 'field', id, altKm}                         a transfer to a field (arrive at the arrival point)
 *   {kind: 'sat', id?, altKm}                          the resupply satellite: a transfer, and the catches aboard are handed over
 *   {kind: 'piece', id, altKm, fieldId?, posM?, value} a transfer to the piece's height if she is not there, an approach, a catch
 *                                                      (`value` from `pieceValue`; its `kept` adds the mass to every later leg)
 */

const stopValueCr = (s) => (s && s.value ? (s.value.valueCr ?? ((s.value.creditsCr || 0) + (s.value.salvageCr || 0) + (s.value.feeCr || 0))) : 0);
const stopFeeCr = (s) => (s && s.value ? (s.value.feeCr || 0) : 0);
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * The search prices transfers with `transferLegFast`, which is within `FAST_GAS_TOLERANCE` of the real profile (test (c) holds it).
 * So in the search a leg fits when it does with that much of the gas used so far given back (or taken): a route at the tank's edge
 * is kept for the exact re-price to judge, never cut on a fast price. The exact walk (`walkRoute`) allows nothing.
 */
export const FAST_GAS_TOLERANCE = 0.005;
const fitsGas = (w, gasKg, fast) => gasKg <= w.gasKg + (fast ? FAST_GAS_TOLERANCE * (w.gasUsedKg + gasKg) : 0) + 1e-9;

function freshWalk(state) {
  return {
    dryMassKg: state.dryMassKg, gasKg: state.gasKg, carriedKg: state.carriedKg || 0, altKm: state.altKm,
    fieldId: state.fieldId ?? null, posM: state.posM || null,
    gasUsedKg: 0, days: 0, valueCr: 0, feeCr: 0, ok: true,
  };
}

/** Run one stop on a walk state `w` (mutated), pushing legs onto `legs` (or not, when null); false when a leg does not fit. */
function runStop(w, stop, state, legs, fast, stopIndex) {
  const transfer = fast ? transferLegFast : transferLeg;
  const cos = state.cos === undefined ? 1 : state.cos;
  const doTransfer = (toKm) => {
    const massKg = w.dryMassKg + w.carriedKg + w.gasKg;
    const args = { fromKm: w.altKm, toKm, massKg, thrustN: state.thrustN, ispS: state.ispS, areaM2: state.areaM2, cos };
    // a climb the engine cannot finish inside the game's own limit is not run (a heavy hold would spend seconds of CPU finding that out)
    const t = climbTooLong(args) ? { ok: false, gasKg: 0, days: 0 } : transfer(args);
    const fits = t.ok && fitsGas(w, t.gasKg, fast);
    w.gasKg -= t.gasKg; w.gasUsedKg += t.gasKg; w.days += t.days; w.altKm = toKm;
    if (legs) legs.push({ kind: 'transfer', stop: stopIndex, toKm, gasKg: t.gasKg, days: t.days, massKg, gasLeftKg: w.gasKg, ok: fits });
    return fits;
  };
  if (stop.kind === 'piece') {
    if (w.altKm !== stop.altKm || (stop.fieldId && stop.fieldId !== w.fieldId)) {
      if (!doTransfer(stop.altKm)) return false;
      w.posM = null; w.fieldId = stop.fieldId ?? null;
    }
    const massKg = w.dryMassKg + w.carriedKg + w.gasKg;
    const here = w.posM || { x: 0, y: 0, z: 0 };
    const target = stop.posM || here;
    const distanceM = dist3(here, target);
    const ap = approachLeg({ distanceM, massKg });
    const fits = ap.ok && fitsGas(w, ap.gasKg, fast);
    w.gasKg -= ap.gasKg; w.gasUsedKg += ap.gasKg; w.days += ap.days;
    if (legs) legs.push({ kind: 'approach', stop: stopIndex, distanceM, gasKg: ap.gasKg, days: ap.days, massKg, gasLeftKg: w.gasKg, ok: fits });
    if (!fits) return false;
    w.posM = { x: target.x, y: target.y, z: target.z };
    w.valueCr += stopValueCr(stop);
    w.feeCr += stopFeeCr(stop);
    if (stop.value && stop.value.kept !== false) w.carriedKg += stop.value.massKg || 0;
    return true;
  }
  // a field or the satellite: a transfer, then she is at its arrival point
  if (w.altKm !== stop.altKm || (stop.id && stop.id !== w.fieldId)) {
    if (!doTransfer(stop.altKm)) return false;
  } else if (legs) legs.push({ kind: 'transfer', stop: stopIndex, toKm: stop.altKm, gasKg: 0, days: 0, massKg: w.dryMassKg + w.carriedKg + w.gasKg, gasLeftKg: w.gasKg, ok: true });
  w.posM = null;
  w.fieldId = stop.kind === 'sat' ? null : (stop.id ?? null);
  if (stop.kind === 'sat') w.carriedKg = 0;            // handed over: that mass stays at the satellite (DECISIONS §49 row 2)
  return true;
}

/**
 * Price a route: the stops in this order, each leg at her mass at that moment. EXACT: transfers are real `tripProfile` runs
 * (through the cache). Stops after a leg that does not fit are not walked; the failing leg is the last one listed, with the gas
 * it needed and a negative `gasLeftKg`.
 * @param {RouteState} state @param {object[]} stops
 * @returns {{legs: Array<{kind: string, stop: number, gasKg: number, days: number, massKg: number, gasLeftKg: number, ok: boolean}>,
 *   totals: {gasKg: number, days: number, valueCr: number, feeCr: number, gasLeftKg: number, carriedKg: number, feasible: boolean}}}
 * `totals.valueCr` includes `feeCr` (the removal fees, counted where the piece is caught; see `pieceValue`).
 */
export function walkRoute(state, stops) {
  const w = freshWalk(state);
  const legs = [];
  let feasible = true;
  for (let i = 0; i < stops.length; i++) {
    if (!runStop(w, stops[i], state, legs, false, i)) { feasible = false; break; }
  }
  return { legs, totals: { gasKg: w.gasUsedKg, days: w.days, valueCr: w.valueCr, feeCr: w.feeCr, gasLeftKg: w.gasKg, carriedKg: w.carriedKg, feasible } };
}

// ---------------------------------------------------------------------------------------------------------------------------
// The search
// ---------------------------------------------------------------------------------------------------------------------------

/** Better route first: more value, then less gas, then fewer days. */
function better(a, b) {
  if (a.valueCr !== b.valueCr) return b.valueCr - a.valueCr;
  if (Math.abs(a.gasKg - b.gasKg) > 1e-9) return a.gasKg - b.gasKg;
  return a.days - b.days;
}

export const EXACT_MAX_CANDIDATES = 10;
export const BEAM_WIDTH = 50;

/**
 * The best routes through `candidates` (piece stops): the most value among routes that fit the gas aboard, ties to less gas, then
 * fewer days; the top `k`, each at most `maxStops` stops long. Up to `EXACT_MAX_CANDIDATES` candidates every order of every
 * subset is searched (depth-first with a value bound, so a route that cannot reach the k-th best is cut); above it a beam search
 * (width `BEAM_WIDTH`) keeps the best partial routes by the same order and the result is marked `approximate`. The search prices
 * legs with `transferLegFast`, allowing `FAST_GAS_TOLERANCE` (0.5 %) of the gas used so far; every route it keeps is re-priced
 * exactly with `walkRoute`, those that no longer fit are dropped, and the search is repeated keeping more routes until `k` exact
 * ones are in hand (a route at the tank's edge is neither lost nor allowed to take a place); the list is sorted on the exact numbers.
 * @param {RouteState} state @param {object[]} candidates piece stops (with `value`)
 * @param {{k?: number, maxStops?: number}} [opts]
 * @returns {{routes: Array<{stops: object[], ids: string[], totals: object, legs: object[]}>, approximate: boolean, nodes: number, ms: number,
 *   searchMs: number, repriceMs: number}} `searchMs` the search on the fast legs, `repriceMs` the exact re-pricing of the routes returned
 */
export function bestRoutes(state, candidates, opts = {}) {
  const t0 = Date.now();
  const k = opts.k > 0 ? opts.k : 3;
  const maxStops = Math.min(opts.maxStops > 0 ? opts.maxStops : 5, candidates.length);
  const n = candidates.length;
  const vals = candidates.map(stopValueCr);
  const exact = n <= EXACT_MAX_CANDIDATES;
  let nodes = 0;
  const found = [];                                      // {order: number[], valueCr, gasKg, days}
  let pool = k;                                          // how many routes the search keeps (grown by the refill below)

  const consider = (order, w) => {
    found.push({ order: order.slice(), valueCr: w.valueCr, gasKg: w.gasUsedKg, days: w.days });
    found.sort(better);
    if (found.length > pool) found.length = pool;
  };
  const clone = (w) => ({ ...w });

  const search = () => {
    found.length = 0;
    if (exact) {
      const used = new Array(n).fill(false);
      const order = [];
      const dfs = (w, depth) => {
        if (depth === maxStops) return;
        // the best a route can still add: the biggest remaining values, as many as it may still visit
        const remaining = [];
        for (let i = 0; i < n; i++) if (!used[i]) remaining.push(vals[i]);
        remaining.sort((a, b) => b - a);
        let bound = w.valueCr;
        for (let j = 0; j < Math.min(maxStops - depth, remaining.length); j++) bound += remaining[j];
        if (found.length >= pool && bound < found[found.length - 1].valueCr - 1e-9) return;
        for (let i = 0; i < n; i++) {
          if (used[i]) continue;
          nodes++;
          const w2 = clone(w);
          if (!runStop(w2, candidates[i], state, null, true, depth)) continue;
          used[i] = true; order.push(i);
          consider(order, w2);
          dfs(w2, depth + 1);
          used[i] = false; order.pop();
        }
      };
      dfs(freshWalk(state), 0);
    } else {
      let layer = [{ order: [], w: freshWalk(state) }];
      for (let depth = 0; depth < maxStops; depth++) {
        const next = [];
        for (const node of layer) {
          for (let i = 0; i < n; i++) {
            if (node.order.includes(i)) continue;
            nodes++;
            const w2 = clone(node.w);
            if (!runStop(w2, candidates[i], state, null, true, depth)) continue;
            const order = node.order.concat(i);
            consider(order, w2);
            next.push({ order, w: w2, valueCr: w2.valueCr, gasKg: w2.gasUsedKg, days: w2.days });
          }
        }
        next.sort(better);
        layer = next.slice(0, BEAM_WIDTH);
        if (!layer.length) break;
      }
    }
  };

  // Search, re-price exactly, and refill: the search judged transfers on the fast price (allowing FAST_GAS_TOLERANCE), so a route
  // at the tank's edge may fail the exact price. Those are dropped, and the search is repeated keeping more routes until `k`
  // exact-feasible ones are in hand or the search has nothing more to give.
  let routes = [];
  let searchMs = 0;
  let repriceMs = 0;
  for (;;) {
    const ta = Date.now();
    search();
    const tb = Date.now();
    routes = found.map((f) => {
      const stops = f.order.map((i) => candidates[i]);
      const walked = walkRoute(state, stops);
      return { stops, ids: stops.map((s) => s.id), totals: walked.totals, legs: walked.legs };
    }).filter((r) => r.totals.feasible);
    searchMs += tb - ta; repriceMs += Date.now() - tb;
    if (routes.length >= k || found.length < pool) break;
    pool *= 4;
  }
  routes.sort((a, b) => better(
    { valueCr: a.totals.valueCr, gasKg: a.totals.gasKg, days: a.totals.days },
    { valueCr: b.totals.valueCr, gasKg: b.totals.gasKg, days: b.totals.days },
  ));
  if (routes.length > k) routes.length = k;
  return { routes, approximate: !exact, nodes, ms: Date.now() - t0, searchMs, repriceMs };
}

/**
 * The greedy baseline the search is compared with: from where she is, always the candidate whose leg costs the least gas, until
 * `maxStops` or none fits. Exact walk.
 * @returns {{ids: string[], totals: object}}
 */
export function greedyNearest(state, candidates, opts = {}) {
  const maxStops = Math.min(opts.maxStops > 0 ? opts.maxStops : 5, candidates.length);
  const chosen = [];
  const left = candidates.slice();
  while (chosen.length < maxStops && left.length) {
    let best = null;
    for (const c of left) {
      const w = walkRoute(state, chosen.concat(c));
      if (!w.totals.feasible) continue;
      const prev = walkRoute(state, chosen).totals.gasKg;
      const cost = w.totals.gasKg - prev;
      if (!best || cost < best.cost) best = { c, cost };
    }
    if (!best) break;
    chosen.push(best.c);
    left.splice(left.indexOf(best.c), 1);
  }
  const walked = walkRoute(state, chosen);
  return { ids: chosen.map((s) => s.id), stops: chosen, totals: walked.totals };
}
